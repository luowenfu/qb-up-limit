"""Emby 容器流量 SQLite 存储（与 qB 数据隔离）"""

import logging
import os
import sqlite3
import threading
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import traffic_db

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_emby_schema_ensured = False

_EMBY_SCHEMA_COLUMNS = (
    ('emby_traffic_hourly', 'backfilled_uploaded_bytes', 'BIGINT NOT NULL DEFAULT 0'),
    ('emby_traffic_hourly', 'backfilled_downloaded_bytes', 'BIGINT NOT NULL DEFAULT 0'),
)


def _now():
    return traffic_db.now_local()


def _calc_delta(current: int, last: int) -> int:
    if last <= 0:
        return 0
    if current < last:
        return 0
    return current - last


def init_db():
    global _emby_schema_ensured
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_traffic_hourly (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instance_name TEXT NOT NULL,
                    hour_start DATETIME NOT NULL,
                    uploaded_bytes BIGINT NOT NULL DEFAULT 0,
                    downloaded_bytes BIGINT NOT NULL DEFAULT 0,
                    UNIQUE(instance_name, hour_start)
                )
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_traffic_monthly (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instance_name TEXT NOT NULL,
                    year INTEGER NOT NULL,
                    month INTEGER NOT NULL,
                    uploaded_bytes BIGINT NOT NULL DEFAULT 0,
                    downloaded_bytes BIGINT NOT NULL DEFAULT 0,
                    UNIQUE(instance_name, year, month)
                )
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_instance_status (
                    instance_name TEXT PRIMARY KEY,
                    is_online INTEGER DEFAULT 0,
                    api_online INTEGER DEFAULT 0,
                    docker_available INTEGER DEFAULT 0,
                    last_total_uploaded BIGINT DEFAULT 0,
                    last_total_downloaded BIGINT DEFAULT 0,
                    last_delta_bytes BIGINT DEFAULT 0,
                    last_delta_download_bytes BIGINT DEFAULT 0,
                    last_update DATETIME,
                    deleted_at DATETIME
                )
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_playback_upload_facts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instance_name TEXT NOT NULL,
                    segment_id INTEGER NOT NULL,
                    user_name TEXT NOT NULL,
                    user_id TEXT,
                    stopped_at DATETIME NOT NULL,
                    estimated_upload_bytes BIGINT NOT NULL DEFAULT 0,
                    series_name TEXT,
                    episode_label TEXT,
                    UNIQUE(instance_name, segment_id)
                )
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_playback_upload_hourly (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instance_name TEXT NOT NULL,
                    user_name TEXT NOT NULL,
                    hour_start DATETIME NOT NULL,
                    uploaded_bytes BIGINT NOT NULL DEFAULT 0,
                    segment_count INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(instance_name, user_name, hour_start)
                )
            ''')
            for table, column, col_type in _EMBY_SCHEMA_COLUMNS:
                try:
                    c.execute(
                        f'ALTER TABLE {table} ADD COLUMN {column} {col_type}',
                    )
                except sqlite3.OperationalError:
                    pass
            conn.commit()
            _emby_schema_ensured = True
        finally:
            conn.close()
    _run_pending_migrations()


def _ensure_traffic_timezone_from_config():
    """迁移/重建前确保与配置一致的时区（不依赖 qB scheduler 是否已启动）。"""
    try:
        import config_manager
        config = config_manager.ensure_config()
        tz_name = config_manager.get_global_config(config).get(
            'timezone', 'Asia/Shanghai',
        )
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = ZoneInfo('Asia/Shanghai')
        traffic_db.set_timezone(tz)
    except Exception as e:
        logger.warning(f'读取配置时区失败，使用系统本地时间: {e}')


def _get_last_total(c, instance_name: str, column: str) -> int:
    c.execute(
        f'SELECT {column} FROM emby_instance_status WHERE instance_name = ?',
        (instance_name,),
    )
    row = c.fetchone()
    return int(row[column]) if row else 0


def peek_snapshot_deltas(instance_name: str, tx_bytes: int, rx_bytes: int):
    """读取 Docker 累计值相对库内基线的增量（不写库）。"""
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            last_tx = _get_last_total(c, instance_name, 'last_total_uploaded')
            last_rx = _get_last_total(c, instance_name, 'last_total_downloaded')
            reset_tx = last_tx > 0 and tx_bytes < last_tx
            reset_rx = last_rx > 0 and rx_bytes < last_rx
            delta_up = 0 if last_tx == 0 or reset_tx else _calc_delta(tx_bytes, last_tx)
            delta_dl = 0 if last_rx == 0 or reset_rx else _calc_delta(rx_bytes, last_rx)
            return delta_up, delta_dl
        finally:
            conn.close()


def has_docker_baseline(instance_name: str) -> bool:
    """库内是否已有 Docker 计数基线（用于离线恢复补录）。"""
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            last_tx = _get_last_total(c, instance_name, 'last_total_uploaded')
            return last_tx > 0
        finally:
            conn.close()


def save_snapshot(instance_name: str, tx_bytes: int, rx_bytes: int,
                  record_up: int = None, record_down: int = None,
                  is_backfill: bool = False):
    """Docker 容器累计 tx/rx → 增量写入小时/月表；record_* 可覆盖实际落库增量（外网过滤）。"""
    with _lock:
        conn = traffic_db.get_conn()
        try:
            now = _now()
            c = conn.cursor()
            last_tx = _get_last_total(c, instance_name, 'last_total_uploaded')
            last_rx = _get_last_total(c, instance_name, 'last_total_downloaded')

            reset_tx = last_tx > 0 and tx_bytes < last_tx
            reset_rx = last_rx > 0 and rx_bytes < last_rx
            if reset_tx:
                logger.warning(
                    f'[Emby:{instance_name}] 容器发送计数已重置，同步新基线'
                )
            if reset_rx:
                logger.warning(
                    f'[Emby:{instance_name}] 容器接收计数已重置，同步新基线'
                )
            if is_backfill and (reset_tx or reset_rx):
                logger.warning(
                    f'[Emby:{instance_name}] 容器计数已重置，跳过离线补录'
                )
                is_backfill = False

            delta_up = 0 if last_tx == 0 or reset_tx else _calc_delta(tx_bytes, last_tx)
            delta_dl = 0 if last_rx == 0 or reset_rx else _calc_delta(rx_bytes, last_rx)

            write_up = delta_up if record_up is None else max(0, int(record_up))
            write_dl = delta_dl if record_down is None else max(0, int(record_down))

            backfill_up = write_up if is_backfill and write_up > 0 else 0
            backfill_dl = write_dl if is_backfill and write_dl > 0 else 0

            if write_up > 0 or write_dl > 0:
                hour_start = now.replace(minute=0, second=0, microsecond=0)
                c.execute('''
                    INSERT INTO emby_traffic_hourly
                    (instance_name, hour_start, uploaded_bytes, downloaded_bytes,
                     backfilled_uploaded_bytes, backfilled_downloaded_bytes)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(instance_name, hour_start)
                    DO UPDATE SET
                        uploaded_bytes = uploaded_bytes + ?,
                        downloaded_bytes = downloaded_bytes + ?,
                        backfilled_uploaded_bytes = backfilled_uploaded_bytes + ?,
                        backfilled_downloaded_bytes = backfilled_downloaded_bytes + ?
                ''', (
                    instance_name, hour_start, write_up, write_dl,
                    backfill_up, backfill_dl,
                    write_up, write_dl, backfill_up, backfill_dl,
                ))
                c.execute('''
                    INSERT INTO emby_traffic_monthly
                    (instance_name, year, month, uploaded_bytes, downloaded_bytes)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(instance_name, year, month)
                    DO UPDATE SET
                        uploaded_bytes = uploaded_bytes + ?,
                        downloaded_bytes = downloaded_bytes + ?
                ''', (
                    instance_name, now.year, now.month,
                    write_up, write_dl, write_up, write_dl,
                ))

            c.execute('''
                INSERT INTO emby_instance_status (
                    instance_name, last_total_uploaded, last_total_downloaded,
                    last_delta_bytes, last_delta_download_bytes, last_update
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(instance_name) DO UPDATE SET
                    last_total_uploaded = ?,
                    last_total_downloaded = ?,
                    last_delta_bytes = ?,
                    last_delta_download_bytes = ?,
                    last_update = ?,
                    deleted_at = NULL
            ''', (
                instance_name, tx_bytes, rx_bytes, write_up, write_dl, now,
                tx_bytes, rx_bytes, write_up, write_dl, now,
            ))
            conn.commit()
            return write_up, write_dl, backfill_up, backfill_dl
        finally:
            conn.close()


def update_instance_status(instance_name: str, is_online: bool = None,
                           api_online: bool = None,
                           docker_available: bool = None):
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'SELECT instance_name FROM emby_instance_status WHERE instance_name = ?',
                (instance_name,),
            )
            exists = c.fetchone() is not None
            fields = []
            values = []
            if is_online is not None:
                fields.append('is_online = ?')
                values.append(1 if is_online else 0)
            if api_online is not None:
                fields.append('api_online = ?')
                values.append(1 if api_online else 0)
            if docker_available is not None:
                fields.append('docker_available = ?')
                values.append(1 if docker_available else 0)
            if not fields:
                return
            fields.append('last_update = ?')
            values.append(_now())
            if exists:
                c.execute(
                    f'UPDATE emby_instance_status SET {", ".join(fields)} '
                    f'WHERE instance_name = ?',
                    values + [instance_name],
                )
            else:
                c.execute(
                    'INSERT INTO emby_instance_status (instance_name, last_update) '
                    'VALUES (?, ?)',
                    (instance_name, _now()),
                )
                c.execute(
                    f'UPDATE emby_instance_status SET {", ".join(fields)} '
                    f'WHERE instance_name = ?',
                    values + [instance_name],
                )
            conn.commit()
        finally:
            conn.close()


def get_data_start_time(instance_name: str):
    """获取该 Emby 设备流量数据的最早记录时间"""
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT MIN(hour_start) as start_time
                FROM emby_traffic_hourly
                WHERE instance_name = ?
            ''', (instance_name,))
            row = c.fetchone()
            return row['start_time'] if row and row['start_time'] else None
        finally:
            conn.close()


def get_instance_status(instance_name: str) -> dict:
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'SELECT * FROM emby_instance_status WHERE instance_name = ?',
                (instance_name,),
            )
            row = c.fetchone()
            return dict(row) if row else {}
        finally:
            conn.close()


def get_all_instance_status() -> list:
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'SELECT * FROM emby_instance_status WHERE deleted_at IS NULL'
            )
            return [dict(r) for r in c.fetchall()]
        finally:
            conn.close()


def _bytes_column(direction: str) -> str:
    return 'downloaded_bytes' if direction == 'download' else 'uploaded_bytes'


def _backfill_column(direction: str) -> str:
    return (
        'backfilled_downloaded_bytes' if direction == 'download'
        else 'backfilled_uploaded_bytes'
    )


def _cutoff_str(hours: int = None, days: int = None) -> str:
    now = _now()
    if hours is not None:
        dt = now - timedelta(hours=hours)
    else:
        dt = now - timedelta(days=days or 30)
    return dt.strftime('%Y-%m-%d %H:%M:%S')


def get_period_bytes(instance_name: str, start_dt: datetime,
                     direction: str = 'upload') -> int:
    column = _bytes_column(direction)
    start_s = start_dt.strftime('%Y-%m-%d %H:%M:%S')
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute(f'''
                SELECT COALESCE(SUM({column}), 0) AS total
                FROM emby_traffic_hourly
                WHERE instance_name = ? AND hour_start >= ?
            ''', (instance_name, start_s))
            row = c.fetchone()
            return int(row['total']) if row else 0
        finally:
            conn.close()


def get_total_bytes(instance_name: str, direction: str = 'upload') -> int:
    """自纳入监控以来累计流量（与 qB 设备总上传语义一致）"""
    column = _bytes_column(direction)
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute(f'''
                SELECT COALESCE(SUM({column}), 0) AS total
                FROM emby_traffic_hourly
                WHERE instance_name = ?
            ''', (instance_name,))
            row = c.fetchone()
            return int(row['total']) if row else 0
        finally:
            conn.close()


def get_hourly_stats(instance_name: str, hours: int = 24,
                     direction: str = 'upload',
                     start: str = None, end: str = None) -> list:
    column = _bytes_column(direction)
    backfill_col = _backfill_column(direction)
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=True)
                c.execute(f'''
                    SELECT hour_start AS hour, {column} AS total_bytes,
                           {backfill_col} AS backfilled_bytes
                    FROM emby_traffic_hourly
                    WHERE instance_name = ? AND hour_start >= ? AND hour_start < ?
                    ORDER BY hour_start ASC
                ''', (instance_name, start_s, end_s))
            else:
                cutoff = _cutoff_str(hours=hours)
                c.execute(f'''
                    SELECT hour_start AS hour, {column} AS total_bytes,
                           {backfill_col} AS backfilled_bytes
                    FROM emby_traffic_hourly
                    WHERE instance_name = ? AND hour_start >= ?
                    ORDER BY hour_start ASC
                ''', (instance_name, cutoff))
            rows = [dict(r) for r in c.fetchall()]
            for r in rows:
                if r.get('hour'):
                    r['hour'] = str(r['hour'])[:16]
                r['backfilled_bytes'] = int(r.get('backfilled_bytes') or 0)
            return rows
        finally:
            conn.close()


def get_daily_stats(instance_name: str, days: int = 30,
                    direction: str = 'upload',
                    start: str = None, end: str = None) -> list:
    column = _bytes_column(direction)
    backfill_col = _backfill_column(direction)
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                params = (instance_name, start_s, end_s)
                where_time = 'hour_start >= ? AND hour_start < ?'
            else:
                cutoff = _cutoff_str(days=days)
                params = (instance_name, cutoff)
                where_time = 'hour_start >= ?'
            c.execute(f'''
                SELECT DATE(hour_start) AS day, SUM({column}) AS total_bytes,
                       SUM({backfill_col}) AS backfilled_bytes
                FROM emby_traffic_hourly
                WHERE instance_name = ? AND {where_time}
                GROUP BY DATE(hour_start)
                ORDER BY day ASC
            ''', params)
            rows = [dict(r) for r in c.fetchall()]
            for r in rows:
                r['backfilled_bytes'] = int(r.get('backfilled_bytes') or 0)
            return rows
        finally:
            conn.close()


def get_weekly_stats(instance_name: str, weeks: int = 12,
                     direction: str = 'upload',
                     start: str = None, end: str = None) -> list:
    column = _bytes_column(direction)
    backfill_col = _backfill_column(direction)
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                params = (instance_name, start_s, end_s)
                where_time = 'hour_start >= ? AND hour_start < ?'
            else:
                cutoff = _cutoff_str(days=weeks * 7)
                params = (instance_name, cutoff)
                where_time = 'hour_start >= ?'
            c.execute(f'''
                SELECT strftime('%G-W%V', hour_start) AS week,
                       SUM({column}) AS total_bytes,
                       SUM({backfill_col}) AS backfilled_bytes
                FROM emby_traffic_hourly
                WHERE instance_name = ?
                AND {where_time}
                GROUP BY strftime('%G-W%V', hour_start)
                ORDER BY week ASC
            ''', params)
            rows = [dict(r) for r in c.fetchall()]
            for r in rows:
                r['backfilled_bytes'] = int(r.get('backfilled_bytes') or 0)
            return rows
        finally:
            conn.close()


def get_monthly_stats(instance_name: str, months: int = 12,
                      direction: str = 'upload',
                      start: str = None, end: str = None) -> list:
    column = _bytes_column(direction)
    backfill_col = _backfill_column(direction)
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute(f'''
                    SELECT strftime('%Y-%m', hour_start) AS month,
                           SUM({column}) AS total_bytes,
                           SUM({backfill_col}) AS backfilled_bytes
                    FROM emby_traffic_hourly
                    WHERE instance_name = ?
                    AND hour_start >= ? AND hour_start < ?
                    GROUP BY strftime('%Y-%m', hour_start)
                    ORDER BY month ASC
                ''', (instance_name, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=months * 31)
                c.execute(f'''
                    SELECT strftime('%Y-%m', hour_start) AS month,
                           SUM({column}) AS total_bytes,
                           SUM({backfill_col}) AS backfilled_bytes
                    FROM emby_traffic_hourly
                    WHERE instance_name = ? AND hour_start >= ?
                    GROUP BY strftime('%Y-%m', hour_start)
                    ORDER BY month ASC
                ''', (instance_name, cutoff))
            rows = [dict(r) for r in c.fetchall()]
            for r in rows:
                r['backfilled_bytes'] = int(r.get('backfilled_bytes') or 0)
            return rows
        finally:
            conn.close()


def get_yearly_stats(instance_name: str, years: int = 5,
                     direction: str = 'upload',
                     start: str = None, end: str = None,
                     start_year: int = None, end_year: int = None) -> list:
    column = _bytes_column(direction)
    backfill_col = _backfill_column(direction)
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start_year is not None and end_year is not None:
                c.execute(f'''
                    SELECT strftime('%Y', hour_start) AS year,
                           SUM({column}) AS total_bytes,
                           SUM({backfill_col}) AS backfilled_bytes
                    FROM emby_traffic_hourly
                    WHERE instance_name = ?
                      AND CAST(strftime('%Y', hour_start) AS INTEGER) BETWEEN ? AND ?
                    GROUP BY strftime('%Y', hour_start)
                    ORDER BY year ASC
                ''', (instance_name, start_year, end_year))
            elif start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute(f'''
                    SELECT strftime('%Y', hour_start) AS year,
                           SUM({column}) AS total_bytes,
                           SUM({backfill_col}) AS backfilled_bytes
                    FROM emby_traffic_hourly
                    WHERE instance_name = ?
                    AND hour_start >= ? AND hour_start < ?
                    GROUP BY strftime('%Y', hour_start)
                    ORDER BY year ASC
                ''', (instance_name, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=years * 366)
                c.execute(f'''
                    SELECT strftime('%Y', hour_start) AS year,
                           SUM({column}) AS total_bytes,
                           SUM({backfill_col}) AS backfilled_bytes
                    FROM emby_traffic_hourly
                    WHERE instance_name = ? AND hour_start >= ?
                    GROUP BY strftime('%Y', hour_start)
                    ORDER BY year ASC
                ''', (instance_name, cutoff))
            rows = [dict(r) for r in c.fetchall()]
            for r in rows:
                r['backfilled_bytes'] = int(r.get('backfilled_bytes') or 0)
            return rows
        finally:
            conn.close()


def delete_instance_data(instance_name: str):
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            for table in (
                'emby_traffic_hourly', 'emby_traffic_monthly', 'emby_instance_status',
                'emby_playback_upload_facts', 'emby_playback_upload_hourly',
            ):
                c.execute(
                    f'DELETE FROM {table} WHERE instance_name = ?',
                    (instance_name,),
                )
            conn.commit()
        finally:
            conn.close()


def reset_instance_traffic(instance_name: str):
    """清空流量统计；保留容器计数基线"""
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            now = _now()
            c = conn.cursor()
            c.execute(
                'DELETE FROM emby_traffic_hourly WHERE instance_name = ?',
                (instance_name,),
            )
            c.execute(
                'DELETE FROM emby_traffic_monthly WHERE instance_name = ?',
                (instance_name,),
            )
            c.execute('''
                UPDATE emby_instance_status SET
                    last_delta_bytes = 0,
                    last_delta_download_bytes = 0,
                    last_update = ?
                WHERE instance_name = ?
            ''', (now, instance_name))
            conn.commit()
            logger.info(f'Emby 流量统计已重置: {instance_name}')
        finally:
            conn.close()


_EMBY_DATA_INSTANCE_TABLES = (
    'emby_instance_status', 'emby_traffic_hourly', 'emby_traffic_monthly',
)


def _ensure_emby_schema():
    if not _emby_schema_ensured:
        init_db()


def _collect_emby_db_instance_names_unlocked(cursor) -> set:
    names = set()
    for table in _EMBY_DATA_INSTANCE_TABLES:
        cursor.execute(f'SELECT DISTINCT instance_name FROM {table}')
        names.update(row['instance_name'] for row in cursor.fetchall())
    return names


def has_instance_data(instance_name: str) -> bool:
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            for table in _EMBY_DATA_INSTANCE_TABLES:
                c.execute(
                    f'SELECT 1 FROM {table} WHERE instance_name = ? LIMIT 1',
                    (instance_name,),
                )
                if c.fetchone():
                    return True
            return False
        finally:
            conn.close()


def is_orphaned_instance(instance_name: str, active_names: list) -> bool:
    _ensure_emby_schema()
    if instance_name in set(active_names or []):
        return False
    return has_instance_data(instance_name)


def mark_instance_orphan_deleted(instance_name: str):
    """保留数据删除时写入删除时间"""
    _ensure_emby_schema()
    now_str = traffic_db._format_datetime_seconds(traffic_db.now_local())
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'SELECT 1 FROM emby_instance_status WHERE instance_name = ?',
                (instance_name,),
            )
            if c.fetchone():
                c.execute(
                    'UPDATE emby_instance_status SET deleted_at = ? WHERE instance_name = ?',
                    (now_str, instance_name),
                )
            else:
                c.execute(
                    'INSERT INTO emby_instance_status (instance_name, deleted_at) '
                    'VALUES (?, ?)',
                    (instance_name, now_str),
                )
            conn.commit()
            logger.info(f'已记录 Emby 孤儿删除时间: {instance_name} @ {now_str}')
        finally:
            conn.close()


def _resolve_emby_orphan_time_unlocked(cursor, name: str) -> str:
    cursor.execute(
        'SELECT deleted_at, last_update FROM emby_instance_status WHERE instance_name = ?',
        (name,),
    )
    status_row = cursor.fetchone()
    if status_row and status_row['deleted_at']:
        formatted = traffic_db._format_datetime_seconds(status_row['deleted_at'])
        if formatted:
            return formatted
    if status_row and status_row['last_update']:
        formatted = traffic_db._format_datetime_seconds(status_row['last_update'])
        if formatted:
            return formatted
    return None


def get_orphaned_instances(active_names: list) -> list:
    _ensure_emby_schema()
    active = set(active_names or [])
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            orphan_names = _collect_emby_db_instance_names_unlocked(c) - active
            result = []
            for name in orphan_names:
                display_time = _resolve_emby_orphan_time_unlocked(c, name)
                result.append({
                    'name': name,
                    'deleted_at': display_time,
                })
            result.sort(key=lambda x: x['deleted_at'] or '', reverse=True)
            return result
        finally:
            conn.close()


def rename_instance_data(old_name: str, new_name: str):
    if old_name == new_name:
        return
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'SELECT 1 FROM emby_instance_status WHERE instance_name = ?',
                (new_name,),
            )
            if c.fetchone():
                c.execute(
                    'DELETE FROM emby_instance_status WHERE instance_name = ?',
                    (old_name,),
                )
            else:
                c.execute(
                    'UPDATE emby_instance_status SET instance_name = ? WHERE instance_name = ?',
                    (new_name, old_name),
                )
            for table in ('emby_traffic_hourly', 'emby_traffic_monthly',
                          'emby_playback_upload_facts', 'emby_playback_upload_hourly'):
                c.execute(
                    f'UPDATE {table} SET instance_name = ? WHERE instance_name = ?',
                    (new_name, old_name),
                )
            conn.commit()
            logger.info(f'Emby 实例数据已重命名: {old_name} -> {new_name}')
        finally:
            conn.close()


def _normalize_stopped_at(stopped_at: str) -> str:
    text = str(stopped_at or '').strip()
    if not text:
        return _now().strftime('%Y-%m-%d %H:%M:%S')
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        dt = datetime.fromisoformat(text)
        dt = traffic_db._to_local_naive(dt)
        return dt.strftime('%Y-%m-%d %H:%M:%S')
    except (TypeError, ValueError):
        return text.replace('T', ' ')[:19]


def _hour_start_from_stopped(stopped_at: str) -> str:
    text = _normalize_stopped_at(stopped_at)
    return text[:13] + ':00:00'


def _iter_playback_records_for_rebuild(instance_name: str = None):
    """遍历播放记录 JSON，供重建外网用户上行聚合使用。"""
    import playback_record_store
    from emby_storage_paths import EMBY_EVENTS_DIR
    from secrets_store import _read_json

    playback_record_store._migrate_all_stores_once()

    def yield_from_store(inst: str, data: dict):
        for rec in data.get('records') or []:
            item = dict(rec)
            item.setdefault('instance_name', inst)
            yield item

    if instance_name:
        store = playback_record_store._load_store(instance_name)
        inst = store.get('instance_name') or instance_name
        yield from yield_from_store(inst, store)
        return

    if not os.path.isdir(EMBY_EVENTS_DIR):
        return
    for fname in os.listdir(EMBY_EVENTS_DIR):
        if not fname.endswith('.json'):
            continue
        data = _read_json(os.path.join(EMBY_EVENTS_DIR, fname), {})
        if not isinstance(data.get('records'), list):
            continue
        inst = data.get('instance_name') or ''
        yield from yield_from_store(inst, data)


def rebuild_playback_upload_stats(instance_name: str = None) -> dict:
    """从播放记录 JSON 重建外网用户上行事实表与小时聚合。"""
    _ensure_emby_schema()
    _ensure_traffic_timezone_from_config()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if instance_name:
                c.execute(
                    'DELETE FROM emby_playback_upload_facts WHERE instance_name = ?',
                    (instance_name,),
                )
                c.execute(
                    'DELETE FROM emby_playback_upload_hourly WHERE instance_name = ?',
                    (instance_name,),
                )
            else:
                c.execute('DELETE FROM emby_playback_upload_facts')
                c.execute('DELETE FROM emby_playback_upload_hourly')
            conn.commit()
        finally:
            conn.close()

    stats = {'facts': 0, 'skipped': 0, 'instances': set()}
    for rec in _iter_playback_records_for_rebuild(instance_name):
        if rec.get('status') == 'playing':
            continue
        if not rec.get('is_remote'):
            continue
        upload = rec.get('estimated_upload_bytes')
        if upload is None or int(upload) <= 0:
            continue
        inst = (rec.get('instance_name') or '').strip()
        user_name = (rec.get('user_name') or '').strip()
        if not inst or not user_name:
            stats['skipped'] += 1
            continue
        ok = save_playback_upload_fact(
            inst,
            int(rec.get('id') or 0),
            user_name,
            rec.get('user_id') or '',
            rec.get('stopped_at') or rec.get('last_tick_at') or '',
            int(upload),
            rec.get('series_name') or '',
            rec.get('episode_label') or '',
        )
        if ok:
            stats['facts'] += 1
            stats['instances'].add(inst)
        else:
            stats['skipped'] += 1
    stats['instances'] = sorted(stats['instances'])
    return stats


def _run_pending_migrations():
    _ensure_traffic_timezone_from_config()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_schema_migrations (
                    name TEXT PRIMARY KEY,
                    applied_at DATETIME NOT NULL
                )
            ''')
            c.execute(
                'SELECT 1 FROM emby_schema_migrations WHERE name = ?',
                ('playback_upload_local_timezone_v1',),
            )
            if c.fetchone():
                return
            conn.commit()
        finally:
            conn.close()

    try:
        stats = rebuild_playback_upload_stats()
        with _lock:
            conn = traffic_db.get_conn()
            try:
                c = conn.cursor()
                c.execute('''
                    INSERT INTO emby_schema_migrations (name, applied_at)
                    VALUES (?, ?)
                ''', (
                    'playback_upload_local_timezone_v1',
                    _now().strftime('%Y-%m-%d %H:%M:%S'),
                ))
                conn.commit()
                logger.info(
                    '迁移 playback_upload_local_timezone_v1 完成: '
                    f'重建 {stats["facts"]} 条外网播放上行记录'
                )
            finally:
                conn.close()
    except Exception as e:
        logger.error(
            f'迁移 playback_upload_local_timezone_v1 失败: {e}',
            exc_info=True,
        )


def save_playback_upload_fact(instance_name: str, segment_id: int,
                              user_name: str, user_id: str,
                              stopped_at: str, upload_bytes: int,
                              series_name: str = '', episode_label: str = '') -> bool:
    """ended 外网段结束时写入事实表并累加小时聚合。"""
    name = (instance_name or '').strip()
    if not name or not user_name or int(upload_bytes or 0) <= 0:
        return False
    stopped_s = _normalize_stopped_at(stopped_at)
    hour_start = _hour_start_from_stopped(stopped_s)
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                INSERT OR IGNORE INTO emby_playback_upload_facts (
                    instance_name, segment_id, user_name, user_id, stopped_at,
                    estimated_upload_bytes, series_name, episode_label
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                name, int(segment_id), user_name, user_id or '',
                stopped_s, int(upload_bytes), series_name or '', episode_label or '',
            ))
            if c.rowcount <= 0:
                return False
            c.execute('''
                INSERT INTO emby_playback_upload_hourly (
                    instance_name, user_name, hour_start, uploaded_bytes, segment_count
                ) VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(instance_name, user_name, hour_start) DO UPDATE SET
                    uploaded_bytes = uploaded_bytes + excluded.uploaded_bytes,
                    segment_count = segment_count + 1
            ''', (name, user_name, hour_start, int(upload_bytes)))
            conn.commit()
            return True
        finally:
            conn.close()


def list_playback_upload_users(instance_name: str) -> list:
    """仅有 ended 外网段入库的用户名列表。"""
    name = (instance_name or '').strip()
    if not name:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT DISTINCT user_name FROM emby_playback_upload_facts
                WHERE instance_name = ? AND user_name != ''
                ORDER BY user_name COLLATE NOCASE
            ''', (name,))
            return [row['user_name'] for row in c.fetchall() if row['user_name']]
        finally:
            conn.close()


def get_playback_upload_hourly_stats(instance_name: str, user_name: str,
                                     hours: int = 24,
                                     start: str = None, end: str = None) -> list:
    name = (instance_name or '').strip()
    user = (user_name or '').strip()
    if not name or not user:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=True)
                c.execute('''
                    SELECT hour_start AS hour, uploaded_bytes AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND user_name = ?
                      AND hour_start >= ? AND hour_start < ?
                    ORDER BY hour_start
                ''', (name, user, start_s, end_s))
            else:
                cutoff = _cutoff_str(hours=hours)
                c.execute('''
                    SELECT hour_start AS hour, uploaded_bytes AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND user_name = ? AND hour_start >= ?
                    ORDER BY hour_start
                ''', (name, user, cutoff))
            return [dict(r) for r in c.fetchall()]
        finally:
            conn.close()


def get_playback_upload_daily_stats(instance_name: str, user_name: str,
                                    days: int = 31,
                                    start: str = None, end: str = None) -> list:
    name = (instance_name or '').strip()
    user = (user_name or '').strip()
    if not name or not user:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT date(stopped_at) AS day,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND user_name = ?
                      AND stopped_at >= ? AND stopped_at < ?
                    GROUP BY date(stopped_at)
                    ORDER BY day
                ''', (name, user, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=days)
                c.execute('''
                    SELECT date(stopped_at) AS day,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND user_name = ? AND stopped_at >= ?
                    GROUP BY date(stopped_at)
                    ORDER BY day
                ''', (name, user, cutoff))
            rows = []
            for r in c.fetchall():
                rows.append({'day': r['day'], 'total_bytes': int(r['total_bytes'] or 0)})
            return rows
        finally:
            conn.close()


def get_playback_upload_monthly_stats(instance_name: str, user_name: str,
                                      months: int = 12,
                                      start: str = None, end: str = None) -> list:
    name = (instance_name or '').strip()
    user = (user_name or '').strip()
    if not name or not user:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT strftime('%Y-%m', stopped_at) AS month,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND user_name = ?
                      AND stopped_at >= ? AND stopped_at < ?
                    GROUP BY strftime('%Y-%m', stopped_at)
                    ORDER BY month
                ''', (name, user, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=months * 31)
                c.execute('''
                    SELECT strftime('%Y-%m', stopped_at) AS month,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND user_name = ? AND stopped_at >= ?
                    GROUP BY strftime('%Y-%m', stopped_at)
                    ORDER BY month
                ''', (name, user, cutoff))
            return [{'month': r['month'], 'total_bytes': int(r['total_bytes'] or 0)}
                    for r in c.fetchall()]
        finally:
            conn.close()


def get_playback_upload_weekly_stats(instance_name: str, user_name: str,
                                     weeks: int = 12,
                                     start: str = None, end: str = None) -> list:
    name = (instance_name or '').strip()
    user = (user_name or '').strip()
    if not name or not user:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                params = (name, user, start_s, end_s)
                where_time = 'stopped_at >= ? AND stopped_at < ?'
            else:
                cutoff = _cutoff_str(days=weeks * 7)
                params = (name, user, cutoff)
                where_time = 'stopped_at >= ?'
            c.execute(f'''
                SELECT strftime('%G-W%V', stopped_at) AS week,
                       SUM(estimated_upload_bytes) AS total_bytes
                FROM emby_playback_upload_facts
                WHERE instance_name = ? AND user_name = ?
                AND {where_time}
                GROUP BY strftime('%G-W%V', stopped_at)
                ORDER BY week ASC
            ''', params)
            return [{'week': r['week'], 'total_bytes': int(r['total_bytes'] or 0),
                     'backfilled_bytes': 0} for r in c.fetchall()]
        finally:
            conn.close()


def get_playback_upload_yearly_stats(instance_name: str, user_name: str,
                                     years: int = 5,
                                     start: str = None, end: str = None,
                                     start_year: int = None,
                                     end_year: int = None) -> list:
    name = (instance_name or '').strip()
    user = (user_name or '').strip()
    if not name or not user:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start_year is not None and end_year is not None:
                c.execute('''
                    SELECT strftime('%Y', stopped_at) AS year,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND user_name = ?
                      AND CAST(strftime('%Y', stopped_at) AS INTEGER) >= ?
                      AND CAST(strftime('%Y', stopped_at) AS INTEGER) <= ?
                    GROUP BY strftime('%Y', stopped_at)
                    ORDER BY year ASC
                ''', (name, user, int(start_year), int(end_year)))
            elif start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT strftime('%Y', stopped_at) AS year,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND user_name = ?
                      AND stopped_at >= ? AND stopped_at < ?
                    GROUP BY strftime('%Y', stopped_at)
                    ORDER BY year ASC
                ''', (name, user, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=years * 366)
                c.execute('''
                    SELECT strftime('%Y', stopped_at) AS year,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND user_name = ? AND stopped_at >= ?
                    GROUP BY strftime('%Y', stopped_at)
                    ORDER BY year ASC
                ''', (name, user, cutoff))
            return [{'year': r['year'], 'total_bytes': int(r['total_bytes'] or 0),
                     'backfilled_bytes': 0} for r in c.fetchall()]
        finally:
            conn.close()


def get_playback_upload_cycle_stats(instance_name: str, user_name: str,
                                    periods: list) -> list:
    name = (instance_name or '').strip()
    user = (user_name or '').strip()
    if not name or not user or not periods:
        return []
    _ensure_emby_schema()
    result = []
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            for p in periods:
                start_dt = p.get('cycle_start')
                end_dt = p.get('cycle_end')
                if hasattr(start_dt, 'strftime'):
                    start_s = start_dt.strftime('%Y-%m-%d %H:%M:%S')
                else:
                    start_s = str(start_dt)[:19]
                if hasattr(end_dt, 'strftime'):
                    end_s = end_dt.strftime('%Y-%m-%d %H:%M:%S')
                else:
                    end_s = str(end_dt)[:19]
                c.execute('''
                    SELECT COALESCE(SUM(estimated_upload_bytes), 0) AS total
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND user_name = ?
                      AND stopped_at >= ? AND stopped_at < ?
                ''', (name, user, start_s, end_s))
                row = c.fetchone()
                cycle_start = p.get('cycle_start')
                if hasattr(cycle_start, 'strftime'):
                    cycle_start_label = cycle_start.strftime('%Y-%m-%d')
                else:
                    cycle_start_label = str(cycle_start)[:10]
                result.append({
                    'period': p.get('period') or cycle_start_label,
                    'cycle_start': cycle_start_label,
                    'total_bytes': int(row['total']) if row else 0,
                    'backfilled_bytes': 0,
                })
        finally:
            conn.close()
    return result


PLAYBACK_ALL_USERS_TOKEN = '__all_users__'


def get_playback_upload_hourly_stats_all_users(instance_name: str,
                                             hours: int = 24,
                                             start: str = None, end: str = None) -> list:
    name = (instance_name or '').strip()
    if not name:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=True)
                c.execute('''
                    SELECT hour_start AS hour, SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ?
                      AND hour_start >= ? AND hour_start < ?
                    GROUP BY hour_start
                    ORDER BY hour_start
                ''', (name, start_s, end_s))
            else:
                cutoff = _cutoff_str(hours=hours)
                c.execute('''
                    SELECT hour_start AS hour, SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND hour_start >= ?
                    GROUP BY hour_start
                    ORDER BY hour_start
                ''', (name, cutoff))
            return [dict(r) for r in c.fetchall()]
        finally:
            conn.close()


def get_playback_upload_daily_stats_all_users(instance_name: str,
                                            days: int = 31,
                                            start: str = None, end: str = None) -> list:
    name = (instance_name or '').strip()
    if not name:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT date(stopped_at) AS day,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ?
                      AND stopped_at >= ? AND stopped_at < ?
                    GROUP BY date(stopped_at)
                    ORDER BY day
                ''', (name, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=days)
                c.execute('''
                    SELECT date(stopped_at) AS day,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND stopped_at >= ?
                    GROUP BY date(stopped_at)
                    ORDER BY day
                ''', (name, cutoff))
            return [{'day': r['day'], 'total_bytes': int(r['total_bytes'] or 0)}
                    for r in c.fetchall()]
        finally:
            conn.close()


def get_playback_upload_monthly_stats_all_users(instance_name: str,
                                                months: int = 12,
                                                start: str = None, end: str = None) -> list:
    name = (instance_name or '').strip()
    if not name:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT strftime('%Y-%m', stopped_at) AS month,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ?
                      AND stopped_at >= ? AND stopped_at < ?
                    GROUP BY strftime('%Y-%m', stopped_at)
                    ORDER BY month
                ''', (name, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=months * 31)
                c.execute('''
                    SELECT strftime('%Y-%m', stopped_at) AS month,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND stopped_at >= ?
                    GROUP BY strftime('%Y-%m', stopped_at)
                    ORDER BY month
                ''', (name, cutoff))
            return [{'month': r['month'], 'total_bytes': int(r['total_bytes'] or 0)}
                    for r in c.fetchall()]
        finally:
            conn.close()


def get_playback_upload_weekly_stats_all_users(instance_name: str,
                                               weeks: int = 12,
                                               start: str = None, end: str = None) -> list:
    name = (instance_name or '').strip()
    if not name:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                params = (name, start_s, end_s)
                where_time = 'stopped_at >= ? AND stopped_at < ?'
            else:
                cutoff = _cutoff_str(days=weeks * 7)
                params = (name, cutoff)
                where_time = 'stopped_at >= ?'
            c.execute(f'''
                SELECT strftime('%G-W%V', stopped_at) AS week,
                       SUM(estimated_upload_bytes) AS total_bytes
                FROM emby_playback_upload_facts
                WHERE instance_name = ?
                AND {where_time}
                GROUP BY strftime('%G-W%V', stopped_at)
                ORDER BY week ASC
            ''', params)
            return [{'week': r['week'], 'total_bytes': int(r['total_bytes'] or 0),
                     'backfilled_bytes': 0} for r in c.fetchall()]
        finally:
            conn.close()


def get_playback_upload_yearly_stats_all_users(instance_name: str,
                                               years: int = 5,
                                               start: str = None, end: str = None,
                                               start_year: int = None,
                                               end_year: int = None) -> list:
    name = (instance_name or '').strip()
    if not name:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            if start_year is not None and end_year is not None:
                c.execute('''
                    SELECT strftime('%Y', stopped_at) AS year,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ?
                      AND CAST(strftime('%Y', stopped_at) AS INTEGER) >= ?
                      AND CAST(strftime('%Y', stopped_at) AS INTEGER) <= ?
                    GROUP BY strftime('%Y', stopped_at)
                    ORDER BY year ASC
                ''', (name, int(start_year), int(end_year)))
            elif start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT strftime('%Y', stopped_at) AS year,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ?
                      AND stopped_at >= ? AND stopped_at < ?
                    GROUP BY strftime('%Y', stopped_at)
                    ORDER BY year ASC
                ''', (name, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=years * 366)
                c.execute('''
                    SELECT strftime('%Y', stopped_at) AS year,
                           SUM(estimated_upload_bytes) AS total_bytes
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ? AND stopped_at >= ?
                    GROUP BY strftime('%Y', stopped_at)
                    ORDER BY year ASC
                ''', (name, cutoff))
            return [{'year': r['year'], 'total_bytes': int(r['total_bytes'] or 0),
                     'backfilled_bytes': 0} for r in c.fetchall()]
        finally:
            conn.close()


def get_playback_upload_cycle_stats_all_users(instance_name: str,
                                              periods: list) -> list:
    name = (instance_name or '').strip()
    if not name or not periods:
        return []
    _ensure_emby_schema()
    result = []
    with _lock:
        conn = traffic_db.get_conn()
        try:
            c = conn.cursor()
            for p in periods:
                start_dt = p.get('cycle_start')
                end_dt = p.get('cycle_end')
                if hasattr(start_dt, 'strftime'):
                    start_s = start_dt.strftime('%Y-%m-%d %H:%M:%S')
                else:
                    start_s = str(start_dt)[:19]
                if hasattr(end_dt, 'strftime'):
                    end_s = end_dt.strftime('%Y-%m-%d %H:%M:%S')
                else:
                    end_s = str(end_dt)[:19]
                c.execute('''
                    SELECT COALESCE(SUM(estimated_upload_bytes), 0) AS total
                    FROM emby_playback_upload_facts
                    WHERE instance_name = ?
                      AND stopped_at >= ? AND stopped_at < ?
                ''', (name, start_s, end_s))
                row = c.fetchone()
                cycle_start = p.get('cycle_start')
                if hasattr(cycle_start, 'strftime'):
                    cycle_start_label = cycle_start.strftime('%Y-%m-%d')
                else:
                    cycle_start_label = str(cycle_start)[:10]
                result.append({
                    'period': p.get('period') or cycle_start_label,
                    'cycle_start': cycle_start_label,
                    'total_bytes': int(row['total']) if row else 0,
                    'backfilled_bytes': 0,
                })
        finally:
            conn.close()
    return result
