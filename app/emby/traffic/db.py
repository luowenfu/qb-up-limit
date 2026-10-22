"""Emby 容器流量 SQLite 存储（独立 emby_traffic.db，与 qB traffic.db 分离）"""

import logging
import os
import sqlite3
import threading
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import qb.traffic_db as traffic_db

logger = logging.getLogger(__name__)

from core.paths import EMBY_DB_PATH as DB_PATH  # noqa: E402
_LEGACY_DB_PATH = traffic_db.DB_PATH
_SPLIT_DB_MIGRATION = 'split_emby_traffic_db_v1'

_EMBY_DB_TABLES = (
    'emby_schema_migrations',
    'emby_traffic_hourly',
    'emby_traffic_monthly',
    'emby_instance_status',
    'emby_playback_upload_facts',
    'emby_playback_upload_hourly',
    'emby_content_plays',
    'emby_browse_upload_facts',
    'emby_browse_upload_hourly',
    'emby_lucky_ip_baselines',
    'emby_lucky_conn_baselines',
    'emby_session_upload_accumulators',
    'emby_browse_upload_accumulators',
    'emby_lucky_conn_bindings',
)

_lock = threading.Lock()
_emby_schema_ensured = False
_migrations_started = False
_migrations_running = False
_retention_years = 5
_last_vacuum_day = None
_vacuum_running = False
_VACUUM_INTERVAL_DAYS = 30

_EMBY_SCHEMA_COLUMNS = (
    ('emby_traffic_hourly', 'backfilled_uploaded_bytes', 'BIGINT NOT NULL DEFAULT 0'),
    ('emby_traffic_hourly', 'backfilled_downloaded_bytes', 'BIGINT NOT NULL DEFAULT 0'),
    ('emby_browse_upload_facts', 'series_name', 'TEXT'),
    ('emby_browse_upload_facts', 'episode_label', 'TEXT'),
    ('emby_browse_upload_facts', 'episode_title', 'TEXT'),
    ('emby_browse_upload_facts', 'device_name', 'TEXT'),
    ('emby_browse_upload_facts', 'client', 'TEXT'),
    ('emby_browse_upload_facts', 'client_ip', 'TEXT'),
    ('emby_browse_upload_facts', 'production_year', 'INTEGER'),
)


def _now():
    return traffic_db.now_local()


def _calc_delta(current: int, last: int) -> int:
    if last <= 0:
        return 0
    if current < last:
        return 0
    return current - last


def get_conn():
    conn = sqlite3.connect(
        DB_PATH, check_same_thread=False, timeout=30.0,
    )
    conn.row_factory = sqlite3.Row
    return conn


def _table_exists(conn, table: str, schema: str = 'main') -> bool:
    c = conn.cursor()
    if schema == 'main':
        c.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        )
    else:
        c.execute(
            f"SELECT 1 FROM {schema}.sqlite_master WHERE type='table' AND name=?",
            (table,),
        )
    return c.fetchone() is not None


def _get_common_columns(cursor, table: str, dest_schema: str, legacy_schema: str) -> list:
    cursor.execute(f'PRAGMA {dest_schema}.table_info({table})')
    dest_cols = {row[1] for row in cursor.fetchall()}
    cursor.execute(f'PRAGMA {legacy_schema}.table_info({table})')
    return [row[1] for row in cursor.fetchall() if row[1] in dest_cols]


def _split_migration_applied_unlocked(conn) -> bool:
    if not _table_exists(conn, 'emby_schema_migrations'):
        return False
    c = conn.cursor()
    c.execute(
        'SELECT 1 FROM emby_schema_migrations WHERE name = ?',
        (_SPLIT_DB_MIGRATION,),
    )
    return c.fetchone() is not None


def _legacy_has_emby_data(legacy_conn) -> bool:
    for table in _EMBY_DB_TABLES:
        if table == 'emby_schema_migrations':
            continue
        if not _table_exists(legacy_conn, table):
            continue
        try:
            c = legacy_conn.cursor()
            c.execute(f'SELECT 1 FROM {table} LIMIT 1')
            if c.fetchone():
                return True
        except sqlite3.OperationalError:
            continue
    return False


def _migrate_from_legacy_traffic_db_unlocked() -> None:
    """启动时将旧版 traffic.db 内 Emby 表迁移至独立 emby_traffic.db。"""
    if not os.path.exists(_LEGACY_DB_PATH):
        return

    dest_conn = get_conn()
    try:
        dest_c = dest_conn.cursor()
        if _split_migration_applied_unlocked(dest_conn):
            return
    finally:
        dest_conn.close()

    legacy_conn = sqlite3.connect(_LEGACY_DB_PATH, timeout=30.0)
    try:
        if not _legacy_has_emby_data(legacy_conn):
            return
    finally:
        legacy_conn.close()

    logger.info(
        '检测到旧版 traffic.db 中的 Emby 数据，开始迁移至 emby_traffic.db ...',
    )
    dest_conn = get_conn()
    try:
        dest_conn.execute('BEGIN IMMEDIATE')
        dest_conn.execute('ATTACH DATABASE ? AS legacy', (_LEGACY_DB_PATH,))
        dest_c = dest_conn.cursor()
        migrated_tables = 0
        for table in _EMBY_DB_TABLES:
            if not _table_exists(dest_conn, table, 'legacy'):
                continue
            cols = _get_common_columns(dest_c, table, 'main', 'legacy')
            if not cols:
                continue
            col_list = ', '.join(cols)
            dest_c.execute(f'DELETE FROM main.{table}')
            dest_c.execute(
                f'INSERT OR REPLACE INTO main.{table} ({col_list}) '
                f'SELECT {col_list} FROM legacy.{table}',
            )
            migrated_tables += 1
        if not _table_exists(dest_conn, 'emby_schema_migrations'):
            dest_c.execute('''
                CREATE TABLE IF NOT EXISTS emby_schema_migrations (
                    name TEXT PRIMARY KEY,
                    applied_at DATETIME NOT NULL
                )
            ''')
        dest_c.execute('''
            INSERT OR REPLACE INTO emby_schema_migrations (name, applied_at)
            VALUES (?, ?)
        ''', (
            _SPLIT_DB_MIGRATION,
            _now().strftime('%Y-%m-%d %H:%M:%S'),
        ))
        dest_conn.commit()
        dest_conn.execute('DETACH DATABASE legacy')
        logger.info(
            'Emby 数据已迁移至 emby_traffic.db（%d 张表）',
            migrated_tables,
        )
    except Exception:
        try:
            dest_conn.rollback()
        except Exception:
            logger.debug('Emby 迁移回滚失败', exc_info=True)
        logger.error('Emby 数据库迁移失败', exc_info=True)
        raise
    finally:
        try:
            dest_conn.execute('DETACH DATABASE legacy')
        except Exception:
            logger.debug('分离 Emby 迁移数据库失败', exc_info=True)
        dest_conn.close()

    legacy_write = sqlite3.connect(_LEGACY_DB_PATH, timeout=30.0)
    try:
        legacy_write.execute('BEGIN IMMEDIATE')
        lc = legacy_write.cursor()
        for table in reversed(_EMBY_DB_TABLES):
            if _table_exists(legacy_write, table):
                lc.execute(f'DROP TABLE IF EXISTS {table}')
        legacy_write.commit()
        logger.info('已从 traffic.db 移除 Emby 表')
    except Exception as e:
        legacy_write.rollback()
        logger.warning('从 traffic.db 清理 Emby 表失败（数据已在 emby_traffic.db）: %s', e)
    finally:
        legacy_write.close()


def init_db():
    global _emby_schema_ensured
    _ensure_traffic_timezone_from_config()
    with _lock:
        conn = get_conn()
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
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_browse_upload_facts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instance_name TEXT NOT NULL,
                    segment_id INTEGER NOT NULL,
                    user_name TEXT NOT NULL,
                    user_id TEXT,
                    stopped_at DATETIME NOT NULL,
                    estimated_upload_bytes BIGINT NOT NULL DEFAULT 0,
                    viewing_title TEXT,
                    settle_reason TEXT,
                    UNIQUE(instance_name, segment_id)
                )
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_browse_upload_hourly (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instance_name TEXT NOT NULL,
                    user_name TEXT NOT NULL,
                    hour_start DATETIME NOT NULL,
                    uploaded_bytes BIGINT NOT NULL DEFAULT 0,
                    segment_count INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(instance_name, user_name, hour_start)
                )
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_lucky_ip_baselines (
                    instance_name TEXT NOT NULL,
                    ip TEXT NOT NULL,
                    traffic_out BIGINT NOT NULL DEFAULT 0,
                    traffic_in BIGINT NOT NULL DEFAULT 0,
                    updated_at DATETIME,
                    PRIMARY KEY (instance_name, ip)
                )
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_lucky_conn_baselines (
                    instance_name TEXT NOT NULL,
                    remote_addr TEXT NOT NULL,
                    traffic_out BIGINT NOT NULL DEFAULT 0,
                    traffic_in BIGINT NOT NULL DEFAULT 0,
                    updated_at DATETIME,
                    PRIMARY KEY (instance_name, remote_addr)
                )
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_session_upload_accumulators (
                    instance_name TEXT NOT NULL,
                    persist_key TEXT NOT NULL,
                    bytes BIGINT NOT NULL DEFAULT 0,
                    updated_at DATETIME,
                    PRIMARY KEY (instance_name, persist_key)
                )
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_browse_upload_accumulators (
                    instance_name TEXT NOT NULL,
                    persist_key TEXT NOT NULL,
                    bytes BIGINT NOT NULL DEFAULT 0,
                    updated_at DATETIME,
                    PRIMARY KEY (instance_name, persist_key)
                )
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_lucky_conn_bindings (
                    instance_name TEXT NOT NULL,
                    remote_addr TEXT NOT NULL,
                    persist_key TEXT NOT NULL,
                    updated_at DATETIME,
                    PRIMARY KEY (instance_name, remote_addr)
                )
            ''')
            for table, column, col_type in _EMBY_SCHEMA_COLUMNS:
                try:
                    c.execute(
                        f'ALTER TABLE {table} ADD COLUMN {column} {col_type}',
                    )
                except sqlite3.OperationalError as exc:
                    if 'duplicate column' not in str(exc).lower():
                        raise
            c.execute('''
                CREATE INDEX IF NOT EXISTS idx_emby_hourly_instance_time
                ON emby_traffic_hourly(instance_name, hour_start)
            ''')
            c.execute('''
                CREATE INDEX IF NOT EXISTS idx_emby_monthly_instance_period
                ON emby_traffic_monthly(instance_name, year, month)
            ''')
            c.execute('''
                CREATE INDEX IF NOT EXISTS idx_emby_playback_hourly_lookup
                ON emby_playback_upload_hourly(instance_name, user_name, hour_start)
            ''')
            c.execute('''
                CREATE INDEX IF NOT EXISTS idx_emby_browse_hourly_lookup
                ON emby_browse_upload_hourly(instance_name, user_name, hour_start)
            ''')
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_content_plays (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instance_name TEXT NOT NULL,
                    segment_id INTEGER NOT NULL,
                    user_name TEXT NOT NULL DEFAULT '',
                    started_at DATETIME NOT NULL,
                    item_id TEXT NOT NULL DEFAULT '',
                    item_title TEXT NOT NULL DEFAULT '',
                    item_type TEXT NOT NULL DEFAULT '',
                    series_name TEXT NOT NULL DEFAULT '',
                    UNIQUE(instance_name, segment_id)
                )
            ''')
            c.execute('''
                CREATE INDEX IF NOT EXISTS idx_emby_content_plays_started
                ON emby_content_plays(instance_name, started_at)
            ''')
            c.execute('''
                CREATE INDEX IF NOT EXISTS idx_emby_playback_facts_stopped
                ON emby_playback_upload_facts(instance_name, stopped_at DESC)
            ''')
            try:
                _backfill_content_plays(c)
            except Exception:
                logger.exception('点播明细对齐失败')
            c.execute('''
                CREATE INDEX IF NOT EXISTS idx_emby_browse_facts_stopped
                ON emby_browse_upload_facts(instance_name, stopped_at DESC)
            ''')
            conn.commit()
            c.execute('PRAGMA journal_mode=WAL').fetchall()  # 读完结果，否则新版 Python 下连接关闭后仍占着锁
            conn.commit()
            _migrate_from_legacy_traffic_db_unlocked()
            _emby_schema_ensured = True
        finally:
            conn.close()
    _start_background_migrations()
    cleanup_old_data()


def _start_background_migrations():
    """重迁移放后台执行，避免阻塞启动并与采集线程争用 SQLite。"""
    global _migrations_started
    with _lock:
        if _migrations_started:
            return
        _migrations_started = True

    def _worker():
        global _migrations_running
        with _lock:
            if _migrations_running:
                return
            _migrations_running = True
        try:
            _run_pending_migrations()
        except Exception as e:
            logger.error('后台数据库迁移失败: %s', e, exc_info=True)
        finally:
            with _lock:
                _migrations_running = False

    threading.Thread(
        target=_worker, name='emby-db-migrate', daemon=True,
    ).start()


def _ensure_traffic_timezone_from_config():
    """迁移/重建前确保与配置一致的时区（不依赖 qB scheduler 是否已启动）。"""
    try:
        import core.config_manager as config_manager
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
        conn = get_conn()
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


def has_snapshot_baseline(instance_name: str) -> bool:
    """库内是否已有流量快照基线（Lucky 离线恢复补录用）。"""
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            last_tx = _get_last_total(c, instance_name, 'last_total_uploaded')
            return last_tx > 0
        finally:
            conn.close()


def get_instance_last_totals(instance_name: str) -> tuple:
    """读取实例上次落库的累计上传/下载基线（用于 Lucky 单调递增写入）。"""
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            return (
                _get_last_total(c, instance_name, 'last_total_uploaded'),
                _get_last_total(c, instance_name, 'last_total_downloaded'),
            )
        finally:
            conn.close()


def load_lucky_ip_baselines(instance_name: str) -> dict:
    """读取 Lucky 各 IP 上次见到的累计 TrafficOut/In。"""
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name:
        return {}
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT ip, traffic_out, traffic_in
                FROM emby_lucky_ip_baselines
                WHERE instance_name = ?
            ''', (name,))
            result = {}
            for row in c.fetchall():
                ip = str(row['ip'] or '').strip()
                if not ip:
                    continue
                result[ip] = {
                    'out': max(0, int(row['traffic_out'] or 0)),
                    'in': max(0, int(row['traffic_in'] or 0)),
                }
            return result
        finally:
            conn.close()


def save_lucky_ip_baselines(instance_name: str, baselines: dict) -> None:
    """持久化 Lucky IP 累计基线（IP 暂离 accessdetail 时保留，避免重连漏计）。"""
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name or not baselines:
        return
    now = _now()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            for ip, values in baselines.items():
                ip = str(ip or '').strip()
                if not ip or not isinstance(values, dict):
                    continue
                c.execute('''
                    INSERT INTO emby_lucky_ip_baselines (
                        instance_name, ip, traffic_out, traffic_in, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(instance_name, ip) DO UPDATE SET
                        traffic_out = excluded.traffic_out,
                        traffic_in = excluded.traffic_in,
                        updated_at = excluded.updated_at
                ''', (
                    name,
                    ip,
                    max(0, int(values.get('out') or 0)),
                    max(0, int(values.get('in') or 0)),
                    now,
                ))
            conn.commit()
        finally:
            conn.close()


def clear_lucky_ip_baselines(instance_name: str) -> None:
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name:
        return
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'DELETE FROM emby_lucky_ip_baselines WHERE instance_name = ?',
                (name,),
            )
            c.execute(
                'DELETE FROM emby_lucky_conn_baselines WHERE instance_name = ?',
                (name,),
            )
            _clear_live_upload_persistence_unlocked(c, name)
            conn.commit()
        finally:
            conn.close()


def load_lucky_conn_baselines(instance_name: str) -> dict:
    """读取 Lucky 各 RemoteAddr 上次见到的累计 TrafficOut/In。"""
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name:
        return {}
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT remote_addr, traffic_out, traffic_in
                FROM emby_lucky_conn_baselines
                WHERE instance_name = ?
            ''', (name,))
            result = {}
            for row in c.fetchall():
                addr = str(row['remote_addr'] or '').strip()
                if not addr:
                    continue
                result[addr] = {
                    'out': max(0, int(row['traffic_out'] or 0)),
                    'in': max(0, int(row['traffic_in'] or 0)),
                }
            return result
        finally:
            conn.close()


def save_lucky_conn_baselines(instance_name: str, baselines: dict) -> None:
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name or not baselines:
        return
    now = _now()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            for addr, values in baselines.items():
                addr = str(addr or '').strip()
                if not addr or not isinstance(values, dict):
                    continue
                c.execute('''
                    INSERT INTO emby_lucky_conn_baselines (
                        instance_name, remote_addr, traffic_out, traffic_in, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(instance_name, remote_addr) DO UPDATE SET
                        traffic_out = excluded.traffic_out,
                        traffic_in = excluded.traffic_in,
                        updated_at = excluded.updated_at
                ''', (
                    name,
                    addr,
                    max(0, int(values.get('out') or 0)),
                    max(0, int(values.get('in') or 0)),
                    now,
                ))
            conn.commit()
        finally:
            conn.close()


def load_session_upload_accumulators(instance_name: str) -> dict:
    """读取实例级播放会话上行累加器快照。"""
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name:
        return {}
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT persist_key, bytes
                FROM emby_session_upload_accumulators
                WHERE instance_name = ?
            ''', (name,))
            result = {}
            for row in c.fetchall():
                key = str(row['persist_key'] or '').strip()
                if not key:
                    continue
                val = max(0, int(row['bytes'] or 0))
                if val > 0:
                    result[key] = val
            return result
        finally:
            conn.close()


def replace_session_upload_accumulators(instance_name: str, bucket: dict) -> None:
    """全量替换实例播放累加器（仅保留当前在线会话键）。"""
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name:
        return
    cleaned = {
        str(k).strip(): max(0, int(v or 0))
        for k, v in (bucket or {}).items()
        if str(k).strip() and int(v or 0) > 0
    }
    now = _now()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'DELETE FROM emby_session_upload_accumulators WHERE instance_name = ?',
                (name,),
            )
            for key, val in cleaned.items():
                c.execute('''
                    INSERT INTO emby_session_upload_accumulators (
                        instance_name, persist_key, bytes, updated_at
                    )
                    VALUES (?, ?, ?, ?)
                ''', (name, key, val, now))
            conn.commit()
        finally:
            conn.close()


def delete_session_upload_accumulator_keys(
    instance_name: str, keys: list,
) -> None:
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name or not keys:
        return
    uniq = [str(k).strip() for k in keys if str(k).strip()]
    if not uniq:
        return
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            for key in uniq:
                c.execute('''
                    DELETE FROM emby_session_upload_accumulators
                    WHERE instance_name = ? AND persist_key = ?
                ''', (name, key))
            conn.commit()
        finally:
            conn.close()


def load_browse_upload_accumulators(instance_name: str) -> dict:
    """读取实例级选片上行累加器快照。"""
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name:
        return {}
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT persist_key, bytes
                FROM emby_browse_upload_accumulators
                WHERE instance_name = ?
            ''', (name,))
            result = {}
            for row in c.fetchall():
                key = str(row['persist_key'] or '').strip()
                if not key:
                    continue
                val = max(0, int(row['bytes'] or 0))
                if val > 0:
                    result[key] = val
            return result
        finally:
            conn.close()


def replace_browse_upload_accumulators(instance_name: str, bucket: dict) -> None:
    """全量替换实例选片累加器（仅保留当前在线会话键）。"""
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name:
        return
    cleaned = {
        str(k).strip(): max(0, int(v or 0))
        for k, v in (bucket or {}).items()
        if str(k).strip() and int(v or 0) > 0
    }
    now = _now()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'DELETE FROM emby_browse_upload_accumulators WHERE instance_name = ?',
                (name,),
            )
            for key, val in cleaned.items():
                c.execute('''
                    INSERT INTO emby_browse_upload_accumulators (
                        instance_name, persist_key, bytes, updated_at
                    )
                    VALUES (?, ?, ?, ?)
                ''', (name, key, val, now))
            conn.commit()
        finally:
            conn.close()


def delete_browse_upload_accumulator_keys(
    instance_name: str, keys: list,
) -> None:
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name or not keys:
        return
    uniq = [str(k).strip() for k in keys if str(k).strip()]
    if not uniq:
        return
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            for key in uniq:
                c.execute('''
                    DELETE FROM emby_browse_upload_accumulators
                    WHERE instance_name = ? AND persist_key = ?
                ''', (name, key))
            conn.commit()
        finally:
            conn.close()


def load_lucky_conn_bindings(instance_name: str) -> dict:
    """读取 Lucky 连接归属记忆（remote_addr → persist_key）。"""
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name:
        return {}
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT remote_addr, persist_key
                FROM emby_lucky_conn_bindings
                WHERE instance_name = ?
            ''', (name,))
            result = {}
            for row in c.fetchall():
                addr = str(row['remote_addr'] or '').strip()
                pkey = str(row['persist_key'] or '').strip()
                if addr and pkey:
                    result[addr] = pkey
            return result
        finally:
            conn.close()


def replace_lucky_conn_bindings(instance_name: str, bindings: dict) -> None:
    """全量替换实例 Lucky 连接归属（仅保留当前在线会话键）。"""
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name:
        return
    cleaned = {
        str(addr).strip(): str(pkey).strip()
        for addr, pkey in (bindings or {}).items()
        if str(addr).strip() and str(pkey).strip()
    }
    now = _now()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'DELETE FROM emby_lucky_conn_bindings WHERE instance_name = ?',
                (name,),
            )
            for addr, pkey in cleaned.items():
                c.execute('''
                    INSERT INTO emby_lucky_conn_bindings (
                        instance_name, remote_addr, persist_key, updated_at
                    )
                    VALUES (?, ?, ?, ?)
                ''', (name, addr, pkey, now))
            conn.commit()
        finally:
            conn.close()


def _clear_live_upload_persistence_unlocked(c, instance_name: str) -> None:
    name = (instance_name or '').strip()
    if not name:
        return
    c.execute(
        'DELETE FROM emby_session_upload_accumulators WHERE instance_name = ?',
        (name,),
    )
    c.execute(
        'DELETE FROM emby_browse_upload_accumulators WHERE instance_name = ?',
        (name,),
    )
    c.execute(
        'DELETE FROM emby_lucky_conn_bindings WHERE instance_name = ?',
        (name,),
    )


def clear_live_upload_persistence(instance_name: str) -> None:
    """清空播放/选片累加器与 Lucky 连接归属持久化。"""
    _ensure_emby_schema()
    name = (instance_name or '').strip()
    if not name:
        return
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            _clear_live_upload_persistence_unlocked(c, name)
            conn.commit()
        finally:
            conn.close()


def save_snapshot(instance_name: str, tx_bytes: int, rx_bytes: int,
                  record_up: int = None, record_down: int = None,
                  is_backfill: bool = False):
    """Docker 容器累计 tx/rx → 增量写入小时/月表；record_* 可覆盖实际落库增量（外网过滤）。"""
    with _lock:
        conn = get_conn()
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
        conn = get_conn()
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
        conn = get_conn()
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
        conn = get_conn()
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
        conn = get_conn()
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
        conn = get_conn()
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
        conn = get_conn()
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


def get_period_bytes_batch(instance_names: list, start_dt: datetime,
                           direction: str = 'upload') -> dict:
    """批量读取自 start_dt 起的周期流量。"""
    names = [n for n in (instance_names or []) if n]
    if not names:
        return {}
    column = _bytes_column(direction)
    start_s = start_dt.strftime('%Y-%m-%d %H:%M:%S')
    placeholders = ','.join('?' * len(names))
    result = {n: 0 for n in names}
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(f'''
                SELECT instance_name, COALESCE(SUM({column}), 0) AS total
                FROM emby_traffic_hourly
                WHERE instance_name IN ({placeholders})
                  AND hour_start >= ?
                GROUP BY instance_name
            ''', (*names, start_s))
            for row in c.fetchall():
                result[row['instance_name']] = int(row['total'])
        finally:
            conn.close()
    return result


def get_total_bytes_batch(instance_names: list,
                          direction: str = 'upload') -> dict:
    names = [n for n in (instance_names or []) if n]
    if not names:
        return {}
    column = _bytes_column(direction)
    placeholders = ','.join('?' * len(names))
    result = {n: 0 for n in names}
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(f'''
                SELECT instance_name, COALESCE(SUM({column}), 0) AS total
                FROM emby_traffic_hourly
                WHERE instance_name IN ({placeholders})
                GROUP BY instance_name
            ''', names)
            for row in c.fetchall():
                result[row['instance_name']] = int(row['total'])
        finally:
            conn.close()
    return result


def get_data_start_times_batch(instance_names: list) -> dict:
    names = [n for n in (instance_names or []) if n]
    if not names:
        return {}
    placeholders = ','.join('?' * len(names))
    result = {n: None for n in names}
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(f'''
                SELECT instance_name, MIN(hour_start) AS start_time
                FROM emby_traffic_hourly
                WHERE instance_name IN ({placeholders})
                GROUP BY instance_name
            ''', names)
            for row in c.fetchall():
                result[row['instance_name']] = row['start_time']
        finally:
            conn.close()
    return result


def get_playback_upload_period_bytes_batch(instance_names: list,
                                           start_dt: datetime) -> dict:
    names = [n for n in (instance_names or []) if n]
    if not names:
        return {}
    start_s = start_dt.strftime('%Y-%m-%d %H:%M:%S')
    placeholders = ','.join('?' * len(names))
    result = {n: 0 for n in names}
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(f'''
                SELECT instance_name,
                       COALESCE(SUM(uploaded_bytes), 0) AS total
                FROM emby_playback_upload_hourly
                WHERE instance_name IN ({placeholders})
                  AND hour_start >= ?
                GROUP BY instance_name
            ''', (*names, start_s))
            for row in c.fetchall():
                result[row['instance_name']] = int(row['total'])
        finally:
            conn.close()
    return result


def get_playback_upload_total_bytes_batch(instance_names: list) -> dict:
    names = [n for n in (instance_names or []) if n]
    if not names:
        return {}
    placeholders = ','.join('?' * len(names))
    result = {n: 0 for n in names}
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(f'''
                SELECT instance_name,
                       COALESCE(SUM(estimated_upload_bytes), 0) AS total
                FROM emby_playback_upload_facts
                WHERE instance_name IN ({placeholders})
                GROUP BY instance_name
            ''', names)
            for row in c.fetchall():
                result[row['instance_name']] = int(row['total'])
        finally:
            conn.close()
    return result


def get_playback_upload_period_bytes(instance_name: str,
                                     start_dt: datetime) -> int:
    """外网播放上传：自 start_dt 起按采集入账的小时增量之和。"""
    name = (instance_name or '').strip()
    if not name:
        return 0
    start_s = start_dt.strftime('%Y-%m-%d %H:%M:%S')
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT COALESCE(SUM(uploaded_bytes), 0) AS total
                FROM emby_playback_upload_hourly
                WHERE instance_name = ? AND hour_start >= ?
            ''', (name, start_s))
            row = c.fetchone()
            return int(row['total']) if row else 0
        finally:
            conn.close()


def get_playback_upload_total_bytes(instance_name: str) -> int:
    """外网播放会话上传：已入账累计，含仍在播放的分段。"""
    name = (instance_name or '').strip()
    if not name:
        return 0
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT COALESCE(SUM(estimated_upload_bytes), 0) AS total
                FROM emby_playback_upload_facts
                WHERE instance_name = ?
            ''', (name,))
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
        conn = get_conn()
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
        conn = get_conn()
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
        conn = get_conn()
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
        conn = get_conn()
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
        conn = get_conn()
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
        conn = get_conn()
        try:
            c = conn.cursor()
            for table in (
                'emby_traffic_hourly', 'emby_traffic_monthly', 'emby_instance_status',
                'emby_playback_upload_facts', 'emby_playback_upload_hourly',
                'emby_browse_upload_facts', 'emby_browse_upload_hourly',
                'emby_content_plays',
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
        conn = get_conn()
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
            c.execute(
                'DELETE FROM emby_playback_upload_facts WHERE instance_name = ?',
                (instance_name,),
            )
            c.execute(
                'DELETE FROM emby_playback_upload_hourly WHERE instance_name = ?',
                (instance_name,),
            )
            c.execute(
                'DELETE FROM emby_browse_upload_facts WHERE instance_name = ?',
                (instance_name,),
            )
            c.execute(
                'DELETE FROM emby_browse_upload_hourly WHERE instance_name = ?',
                (instance_name,),
            )
            c.execute(
                'DELETE FROM emby_lucky_ip_baselines WHERE instance_name = ?',
                (instance_name,),
            )
            c.execute(
                'DELETE FROM emby_lucky_conn_baselines WHERE instance_name = ?',
                (instance_name,),
            )
            _clear_live_upload_persistence_unlocked(c, instance_name)
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

_EMBY_MEANINGFUL_DATA_TABLES = (
    'emby_traffic_hourly', 'emby_traffic_monthly',
    'emby_playback_upload_facts', 'emby_playback_upload_hourly',
    'emby_browse_upload_facts', 'emby_browse_upload_hourly',
    'emby_content_plays',
)

_EMBY_RENAME_DATA_TABLES = _EMBY_DATA_INSTANCE_TABLES + (
    'emby_playback_upload_facts', 'emby_playback_upload_hourly',
    'emby_browse_upload_facts', 'emby_browse_upload_hourly',
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


def _has_meaningful_emby_instance_data_unlocked(cursor, instance_name: str) -> bool:
    for table in _EMBY_MEANINGFUL_DATA_TABLES:
        cursor.execute(
            f'SELECT 1 FROM {table} WHERE instance_name = ? LIMIT 1',
            (instance_name,),
        )
        if cursor.fetchone():
            return True
    return False


def has_instance_data(instance_name: str) -> bool:
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
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


def has_meaningful_instance_data(instance_name: str) -> bool:
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            return _has_meaningful_emby_instance_data_unlocked(c, instance_name)
        finally:
            conn.close()


def is_orphaned_instance(instance_name: str, active_names: list,
                         renaming_from: str = None) -> bool:
    _ensure_emby_schema()
    if instance_name in set(active_names or []):
        return False
    if not has_instance_data(instance_name):
        return False
    if renaming_from:
        renaming_from = str(renaming_from).strip()
        active = set(active_names or [])
        if renaming_from and renaming_from in active:
            if (has_instance_data(renaming_from)
                    and not has_meaningful_instance_data(instance_name)):
                return False
    return True


def mark_instance_orphan_deleted(instance_name: str):
    """保留数据删除时写入删除时间"""
    _ensure_emby_schema()
    now_str = traffic_db._format_datetime_seconds(traffic_db.now_local())
    with _lock:
        conn = get_conn()
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
        conn = get_conn()
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
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'SELECT 1 FROM emby_instance_status WHERE instance_name = ?',
                (new_name,),
            )
            new_status_exists = c.fetchone() is not None
            if new_status_exists:
                if not _has_meaningful_emby_instance_data_unlocked(c, new_name):
                    c.execute(
                        'DELETE FROM emby_instance_status WHERE instance_name = ?',
                        (new_name,),
                    )
                    c.execute(
                        'UPDATE emby_instance_status SET instance_name = ? '
                        'WHERE instance_name = ?',
                        (new_name, old_name),
                    )
                else:
                    c.execute(
                        'DELETE FROM emby_instance_status WHERE instance_name = ?',
                        (old_name,),
                    )
            else:
                c.execute(
                    'UPDATE emby_instance_status SET instance_name = ? '
                    'WHERE instance_name = ?',
                    (new_name, old_name),
                )
            for table in _EMBY_MEANINGFUL_DATA_TABLES:
                c.execute(
                    f'UPDATE {table} SET instance_name = ? '
                    f'WHERE instance_name = ?',
                    (new_name, old_name),
                )
            for table in _EMBY_RENAME_DATA_TABLES:
                c.execute(
                    f'DELETE FROM {table} WHERE instance_name = ?',
                    (old_name,),
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


def _upsert_content_play(cursor, instance_name: str, segment_id, user_name: str,
                         started_at: str, item_id: str = '', item_title: str = '',
                         item_type: str = '', series_name: str = '') -> bool:
    """记下一次点播。已有字段留空时才用新值补上，不覆盖已有片名和开始时间。"""
    name = (instance_name or '').strip()
    try:
        seg = int(segment_id or 0)
    except (TypeError, ValueError):
        return False
    if not name or seg <= 0:
        return False
    started = _normalize_stopped_at(started_at)
    if not started:
        return False
    cursor.execute('''
        INSERT INTO emby_content_plays (
            instance_name, segment_id, user_name, started_at,
            item_id, item_title, item_type, series_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_name, segment_id) DO UPDATE SET
            user_name = CASE
                WHEN emby_content_plays.user_name != '' THEN emby_content_plays.user_name
                ELSE excluded.user_name END,
            item_id = CASE
                WHEN emby_content_plays.item_id != '' THEN emby_content_plays.item_id
                ELSE excluded.item_id END,
            item_title = CASE
                WHEN emby_content_plays.item_title != '' THEN emby_content_plays.item_title
                ELSE excluded.item_title END,
            item_type = CASE
                WHEN emby_content_plays.item_type != '' THEN emby_content_plays.item_type
                ELSE excluded.item_type END,
            series_name = CASE
                WHEN emby_content_plays.series_name != '' THEN emby_content_plays.series_name
                ELSE excluded.series_name END
    ''', (
        name, seg, str(user_name or '').strip(), started,
        str(item_id or '').strip(), str(item_title or '').strip(),
        str(item_type or '').strip(), str(series_name or '').strip(),
    ))
    return True


def save_content_play(instance_name: str, segment_id, user_name: str,
                      started_at: str, item_id: str = '', item_title: str = '',
                      item_type: str = '', series_name: str = '') -> bool:
    """播放段开始或结束时写入点播明细，供所选时段排行使用。"""
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            ok = _upsert_content_play(
                conn.cursor(), instance_name, segment_id, user_name, started_at,
                item_id, item_title, item_type, series_name,
            )
            conn.commit()
            return ok
        finally:
            conn.close()


def list_content_plays(instance_name: str, period: str, start: str, end: str,
                       user_name: str = '') -> list:
    """所选时段内的全部点播，不受播放记录 500 条上限限制。"""
    name = (instance_name or '').strip()
    if not name:
        return []
    _ensure_emby_schema()
    all_users = (
        not user_name or user_name == PLAYBACK_ALL_USERS_TOKEN
    )
    sql = '''
        SELECT user_name, started_at, item_id, item_title, item_type, series_name
        FROM emby_content_plays
        WHERE instance_name = ?
    '''
    args = [name]
    if period == 'hourly':
        sql += ' AND substr(started_at, 1, 10) = ?'
        args.append(str(start or '')[:10])
    else:
        start_s = str(start or '')
        end_s = str(end or '')
        if start_s:
            sql += ' AND substr(started_at, 1, ?) >= ?'
            args.extend([len(start_s), start_s])
        if end_s:
            sql += ' AND substr(started_at, 1, ?) <= ?'
            args.extend([len(end_s), end_s])
    if not all_users:
        sql += ' AND user_name = ?'
        args.append(user_name)
    sql += ' ORDER BY started_at'
    with _lock:
        conn = get_conn()
        try:
            rows = conn.execute(sql, args).fetchall()
        finally:
            conn.close()
    return [dict(row) for row in rows]


_PLAY_SERIES_TYPES = {'Episode', 'Series', 'Season'}


def _playback_film_identity(row) -> tuple:
    series = str(row['play_series'] or '').strip() or str(row['fact_series'] or '').strip()
    if series:
        return series, 'series'
    title = str(row['item_title'] or '').strip() or str(row['episode_label'] or '').strip()
    if not title:
        return '', ''
    if str(row['item_type'] or '').strip() in _PLAY_SERIES_TYPES:
        return title, 'series'
    return title, 'movie'


def playback_film_ranks(instance_name: str, period: str, start: str, end: str,
                        limit: int = 10) -> dict:
    """所选时段内每个用户的播放上行，按影片汇总前若干名。不含选片。"""
    name = (instance_name or '').strip()
    if not name:
        return {'users': {}}
    _ensure_emby_schema()
    sql = '''
        SELECT f.user_name AS user_name,
               f.estimated_upload_bytes AS bytes,
               f.series_name AS fact_series,
               f.episode_label AS episode_label,
               p.item_title AS item_title,
               p.item_type AS item_type,
               p.series_name AS play_series
        FROM emby_playback_upload_facts f
        LEFT JOIN emby_content_plays p
          ON p.instance_name = f.instance_name
         AND p.segment_id = f.segment_id
        WHERE f.instance_name = ?
          AND f.estimated_upload_bytes > 0
    '''
    args = [name]
    if period == 'hourly':
        sql += ' AND substr(f.stopped_at, 1, 10) = ?'
        args.append(str(start or '')[:10])
    else:
        start_s = str(start or '')
        end_s = str(end or '')
        if start_s:
            sql += ' AND substr(f.stopped_at, 1, ?) >= ?'
            args.extend([len(start_s), start_s])
        if end_s:
            sql += ' AND substr(f.stopped_at, 1, ?) <= ?'
            args.extend([len(end_s), end_s])
    with _lock:
        conn = get_conn()
        try:
            rows = conn.execute(sql, args).fetchall()
        finally:
            conn.close()
    buckets = {}
    for row in rows:
        user = str(row['user_name'] or '').strip()
        if not user:
            continue
        film, kind = _playback_film_identity(row)
        if not film:
            continue
        films = buckets.setdefault(user, {})
        info = films.get(film)
        if info is None:
            films[film] = {'bytes': int(row['bytes'] or 0), 'kind': kind}
            continue
        info['bytes'] += int(row['bytes'] or 0)
        if kind == 'series':
            info['kind'] = 'series'
    users = {}
    for user, films in buckets.items():
        ranked = sorted(
            films.items(),
            key=lambda item: (-item[1]['bytes'], item[0].casefold()),
        )
        users[user] = [
            {'name': film, 'bytes': info['bytes'], 'kind': info['kind']}
            for film, info in ranked[:limit]
            if info['bytes'] > 0
        ]
    return {'users': users}


def _backfill_content_plays(cursor) -> None:
    """用仍在的播放记录和历史上行事实补齐点播明细。每次启动跑一次，已有记录不会被空值覆盖。"""
    count = 0
    for rec in _iter_playback_records_for_rebuild():
        if _upsert_content_play(
            cursor,
            rec.get('instance_name') or '',
            rec.get('id') or 0,
            rec.get('user_name') or '',
            rec.get('started_at') or rec.get('stopped_at') or '',
            rec.get('item_id') or '',
            rec.get('item_title') or '',
            rec.get('item_type') or '',
            rec.get('series_name') or '',
        ):
            count += 1
    cursor.execute('''
        SELECT instance_name, segment_id, user_name, stopped_at,
               series_name, episode_label
        FROM emby_playback_upload_facts
    ''')
    for row in cursor.fetchall():
        series = str(row['series_name'] or '').strip()
        label = str(row['episode_label'] or '').strip()
        title = series or label
        if not title:
            continue
        if _upsert_content_play(
            cursor,
            row['instance_name'],
            row['segment_id'],
            row['user_name'] or '',
            row['stopped_at'] or '',
            '',
            title,
            'Episode' if series else 'Movie',
            series,
        ):
            count += 1
    if count:
        logger.info(f'点播明细已对齐 {count} 条')


def _iter_playback_records_for_rebuild(instance_name: str = None):
    """遍历播放记录 JSON，供重建外网用户上行聚合使用。"""
    import emby.records.store as playback_record_store
    from emby.storage_paths import EMBY_EVENTS_DIR
    from core.secrets_store import _read_json

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
    _ensure_traffic_timezone_from_config()
    with _lock:
        conn = get_conn()
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
        if not rec.get('is_remote'):
            continue
        playing = rec.get('status') == 'playing'
        if playing:
            upload = max(
                int(rec.get('estimated_upload_bytes') or 0),
                int(rec.get('live_upload_checkpoint_bytes') or 0),
            )
            stopped_at = rec.get('last_tick_at') or rec.get('started_at') or ''
        else:
            upload = rec.get('estimated_upload_bytes')
            stopped_at = rec.get('stopped_at') or rec.get('last_tick_at') or ''
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
            stopped_at,
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


def _migration_applied(name: str) -> bool:
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute(
                'SELECT 1 FROM emby_schema_migrations WHERE name = ?',
                (name,),
            )
            return c.fetchone() is not None
        except sqlite3.OperationalError:
            return False
        finally:
            conn.close()


def _mark_migration_applied(name: str) -> None:
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                INSERT INTO emby_schema_migrations (name, applied_at)
                VALUES (?, ?)
            ''', (
                name,
                _now().strftime('%Y-%m-%d %H:%M:%S'),
            ))
            conn.commit()
        finally:
            conn.close()


def _run_pending_migrations():
    _ensure_traffic_timezone_from_config()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                CREATE TABLE IF NOT EXISTS emby_schema_migrations (
                    name TEXT PRIMARY KEY,
                    applied_at DATETIME NOT NULL
                )
            ''')
            conn.commit()
        finally:
            conn.close()

    if not _migration_applied('playback_upload_local_timezone_v1'):
        try:
            stats = rebuild_playback_upload_stats()
            _mark_migration_applied('playback_upload_local_timezone_v1')
            logger.info(
                '迁移 playback_upload_local_timezone_v1 完成: '
                f'重建 {stats["facts"]} 条外网播放上行记录'
            )
        except Exception as e:
            logger.error(
                f'迁移 playback_upload_local_timezone_v1 失败: {e}',
                exc_info=True,
            )

    if not _migration_applied('playback_upload_restart_repair_v1'):
        try:
            from emby.repair.playback_upload import (
                repair_inflated_playback_upload_estimates,
            )
            stats = repair_inflated_playback_upload_estimates(
                rebuild_stats=True,
            )
            _mark_migration_applied('playback_upload_restart_repair_v1')
            logger.info(
                '迁移 playback_upload_restart_repair_v1 完成: '
                f'扫描={stats.get("scanned", 0)} '
                f'纠偏={stats.get("repaired", 0)} '
                f'同步checkpoint={stats.get("synced_checkpoint", 0)}'
            )
        except Exception as e:
            logger.error(
                f'迁移 playback_upload_restart_repair_v1 失败: {e}',
                exc_info=True,
            )


def save_playback_upload_fact(instance_name: str, segment_id: int,
                              user_name: str, user_id: str,
                              stopped_at: str, upload_bytes: int,
                              series_name: str = '', episode_label: str = '') -> bool:
    """把外网播放段累计上行写入事实表。小时账只加尚未入账的增量，已入账的不回退。"""
    name = (instance_name or '').strip()
    new_total = int(upload_bytes or 0)
    if not name or not user_name or new_total <= 0:
        return False
    stopped_s = _normalize_stopped_at(stopped_at)
    hour_start = _hour_start_from_stopped(stopped_s)
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT estimated_upload_bytes
                FROM emby_playback_upload_facts
                WHERE instance_name = ? AND segment_id = ?
            ''', (name, int(segment_id)))
            row = c.fetchone()
            if row is None:
                delta = new_total
                segment_inc = 1
                c.execute('''
                    INSERT INTO emby_playback_upload_facts (
                        instance_name, segment_id, user_name, user_id, stopped_at,
                        estimated_upload_bytes, series_name, episode_label
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    name, int(segment_id), user_name, user_id or '',
                    stopped_s, new_total, series_name or '', episode_label or '',
                ))
            else:
                old_total = int(row['estimated_upload_bytes'] or 0)
                delta = new_total - old_total
                if delta <= 0:
                    return False
                segment_inc = 0
                c.execute('''
                    UPDATE emby_playback_upload_facts
                    SET estimated_upload_bytes = ?, stopped_at = ?,
                        user_name = ?, user_id = ?,
                        series_name = ?, episode_label = ?
                    WHERE instance_name = ? AND segment_id = ?
                ''', (
                    new_total, stopped_s, user_name, user_id or '',
                    series_name or '', episode_label or '',
                    name, int(segment_id),
                ))
            c.execute('''
                INSERT INTO emby_playback_upload_hourly (
                    instance_name, user_name, hour_start, uploaded_bytes, segment_count
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(instance_name, user_name, hour_start) DO UPDATE SET
                    uploaded_bytes = uploaded_bytes + excluded.uploaded_bytes,
                    segment_count = segment_count + excluded.segment_count
            ''', (name, user_name, hour_start, delta, segment_inc))
            conn.commit()
            return True
        finally:
            conn.close()


def list_distinct_user_names(instance_name: str) -> list:
    """实例下所有出现过流量/选片记录的用户名（去重排序）。"""
    name = (instance_name or '').strip()
    if not name:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                SELECT DISTINCT user_name FROM emby_playback_upload_facts
                WHERE instance_name = ? AND user_name != ''
                UNION
                SELECT DISTINCT user_name FROM emby_browse_upload_facts
                WHERE instance_name = ? AND user_name != ''
                ORDER BY user_name COLLATE NOCASE
            ''', (name, name))
            return [row['user_name'] for row in c.fetchall() if row['user_name']]
        finally:
            conn.close()


def collect_user_ids_for_name(instance_name: str, user_name: str) -> list:
    """收集某用户名在本地库中出现过的 Emby user_id。"""
    name = (instance_name or '').strip()
    user = (user_name or '').strip()
    if not name or not user:
        return []
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            ids = set()
            for table in ('emby_playback_upload_facts', 'emby_browse_upload_facts'):
                c.execute(f'''
                    SELECT DISTINCT user_id FROM {table}
                    WHERE instance_name = ? AND user_name COLLATE NOCASE = ?
                      AND user_id != ''
                ''', (name, user))
                for row in c.fetchall():
                    uid = str(row['user_id'] or '').strip()
                    if uid:
                        ids.add(uid)
            return sorted(ids)
        finally:
            conn.close()


def _delete_user_persist_keys_unlocked(
    c,
    instance_name: str,
    user_name: str,
    user_ids: list,
) -> None:
    from emby.lucky.verdict import persist_key_belongs_to_user

    name = (instance_name or '').strip()
    user_fold = str(user_name or '').strip().casefold()
    uid_set = {str(uid or '').strip() for uid in (user_ids or []) if str(uid or '').strip()}
    if not name or not user_fold:
        return
    for table in (
        'emby_session_upload_accumulators',
        'emby_browse_upload_accumulators',
        'emby_lucky_conn_bindings',
    ):
        c.execute(f'''
            SELECT persist_key FROM {table}
            WHERE instance_name = ?
        ''', (name,))
        keys = [
            str(row['persist_key'] or '').strip()
            for row in c.fetchall()
            if persist_key_belongs_to_user(
                str(row['persist_key'] or '').strip(), user_fold, uid_set,
            )
        ]
        for key in keys:
            c.execute(f'''
                DELETE FROM {table}
                WHERE instance_name = ? AND persist_key = ?
            ''', (name, key))


def delete_user_data(
    instance_name: str,
    user_name: str,
    *,
    user_ids: list = None,
) -> None:
    """删除某用户在本地库中的全部流量与持久化状态。"""
    name = (instance_name or '').strip()
    user = (user_name or '').strip()
    if not name or not user:
        return
    ids = list(user_ids or collect_user_ids_for_name(name, user))
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            for table in (
                'emby_playback_upload_facts',
                'emby_playback_upload_hourly',
                'emby_browse_upload_facts',
                'emby_browse_upload_hourly',
            ):
                c.execute(f'''
                    DELETE FROM {table}
                    WHERE instance_name = ? AND user_name COLLATE NOCASE = ?
                ''', (name, user))
            _delete_user_persist_keys_unlocked(c, name, user, ids)
            conn.commit()
        finally:
            conn.close()


def list_playback_upload_users(instance_name: str) -> list:
    """有外网播放或选片入库记录的用户名列表。"""
    return list_distinct_user_names(instance_name)


def list_browse_upload_records(
    instance_name: str,
    limit: int = 200,
    *,
    min_upload_bytes: int = None,
    since: str = None,
) -> list:
    """选片流量入库记录（用户视角日志数据源）。"""
    import core.config_manager as config_manager
    name = (instance_name or '').strip()
    if not name:
        return []
    if min_upload_bytes is None:
        min_upload_bytes = config_manager.emby_browse_upload_min_bytes()
    min_upload_bytes = max(0, int(min_upload_bytes or 0))
    limit = max(1, min(int(limit or 200), 5000))
    since_s = str(since or '').strip()
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            sql = '''
                SELECT id, instance_name, segment_id, user_name, user_id,
                       stopped_at, estimated_upload_bytes, viewing_title,
                       settle_reason, series_name, episode_label, episode_title,
                       device_name, client, client_ip, production_year
                FROM emby_browse_upload_facts
                WHERE instance_name = ?
                  AND estimated_upload_bytes >= ?
            '''
            params = [name, min_upload_bytes]
            if since_s:
                sql += ' AND stopped_at >= ?'
                params.append(since_s)
            sql += ' ORDER BY stopped_at DESC, id DESC LIMIT ?'
            params.append(limit)
            c.execute(sql, params)
            rows = []
            for row in c.fetchall():
                item = dict(row)
                item['instance_name'] = name
                rows.append(item)
            return rows
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
        conn = get_conn()
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
        conn = get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT date(hour_start) AS day,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND user_name = ?
                      AND hour_start >= ? AND hour_start < ?
                    GROUP BY date(hour_start)
                    ORDER BY day
                ''', (name, user, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=days)
                c.execute('''
                    SELECT date(hour_start) AS day,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND user_name = ? AND hour_start >= ?
                    GROUP BY date(hour_start)
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
        conn = get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT strftime('%Y-%m', hour_start) AS month,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND user_name = ?
                      AND hour_start >= ? AND hour_start < ?
                    GROUP BY strftime('%Y-%m', hour_start)
                    ORDER BY month
                ''', (name, user, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=months * 31)
                c.execute('''
                    SELECT strftime('%Y-%m', hour_start) AS month,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND user_name = ? AND hour_start >= ?
                    GROUP BY strftime('%Y-%m', hour_start)
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
        conn = get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                params = (name, user, start_s, end_s)
                where_time = 'hour_start >= ? AND hour_start < ?'
            else:
                cutoff = _cutoff_str(days=weeks * 7)
                params = (name, user, cutoff)
                where_time = 'hour_start >= ?'
            c.execute(f'''
                SELECT strftime('%G-W%V', hour_start) AS week,
                       SUM(uploaded_bytes) AS total_bytes
                FROM emby_playback_upload_hourly
                WHERE instance_name = ? AND user_name = ?
                AND {where_time}
                GROUP BY strftime('%G-W%V', hour_start)
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
        conn = get_conn()
        try:
            c = conn.cursor()
            if start_year is not None and end_year is not None:
                c.execute('''
                    SELECT strftime('%Y', hour_start) AS year,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND user_name = ?
                      AND CAST(strftime('%Y', hour_start) AS INTEGER) >= ?
                      AND CAST(strftime('%Y', hour_start) AS INTEGER) <= ?
                    GROUP BY strftime('%Y', hour_start)
                    ORDER BY year ASC
                ''', (name, user, int(start_year), int(end_year)))
            elif start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT strftime('%Y', hour_start) AS year,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND user_name = ?
                      AND hour_start >= ? AND hour_start < ?
                    GROUP BY strftime('%Y', hour_start)
                    ORDER BY year ASC
                ''', (name, user, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=years * 366)
                c.execute('''
                    SELECT strftime('%Y', hour_start) AS year,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND user_name = ? AND hour_start >= ?
                    GROUP BY strftime('%Y', hour_start)
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
        conn = get_conn()
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
                    SELECT COALESCE(SUM(uploaded_bytes), 0) AS total
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND user_name = ?
                      AND hour_start >= ? AND hour_start < ?
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
        conn = get_conn()
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
        conn = get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT date(hour_start) AS day,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ?
                      AND hour_start >= ? AND hour_start < ?
                    GROUP BY date(hour_start)
                    ORDER BY day
                ''', (name, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=days)
                c.execute('''
                    SELECT date(hour_start) AS day,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND hour_start >= ?
                    GROUP BY date(hour_start)
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
        conn = get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT strftime('%Y-%m', hour_start) AS month,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ?
                      AND hour_start >= ? AND hour_start < ?
                    GROUP BY strftime('%Y-%m', hour_start)
                    ORDER BY month
                ''', (name, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=months * 31)
                c.execute('''
                    SELECT strftime('%Y-%m', hour_start) AS month,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND hour_start >= ?
                    GROUP BY strftime('%Y-%m', hour_start)
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
        conn = get_conn()
        try:
            c = conn.cursor()
            if start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                params = (name, start_s, end_s)
                where_time = 'hour_start >= ? AND hour_start < ?'
            else:
                cutoff = _cutoff_str(days=weeks * 7)
                params = (name, cutoff)
                where_time = 'hour_start >= ?'
            c.execute(f'''
                SELECT strftime('%G-W%V', hour_start) AS week,
                       SUM(uploaded_bytes) AS total_bytes
                FROM emby_playback_upload_hourly
                WHERE instance_name = ?
                AND {where_time}
                GROUP BY strftime('%G-W%V', hour_start)
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
        conn = get_conn()
        try:
            c = conn.cursor()
            if start_year is not None and end_year is not None:
                c.execute('''
                    SELECT strftime('%Y', hour_start) AS year,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ?
                      AND CAST(strftime('%Y', hour_start) AS INTEGER) >= ?
                      AND CAST(strftime('%Y', hour_start) AS INTEGER) <= ?
                    GROUP BY strftime('%Y', hour_start)
                    ORDER BY year ASC
                ''', (name, int(start_year), int(end_year)))
            elif start and end:
                start_s = traffic_db._normalize_range_start(start)
                end_s = traffic_db._normalize_range_end_exclusive(end, hourly=False)
                c.execute('''
                    SELECT strftime('%Y', hour_start) AS year,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ?
                      AND hour_start >= ? AND hour_start < ?
                    GROUP BY strftime('%Y', hour_start)
                    ORDER BY year ASC
                ''', (name, start_s, end_s))
            else:
                cutoff = _cutoff_str(days=years * 366)
                c.execute('''
                    SELECT strftime('%Y', hour_start) AS year,
                           SUM(uploaded_bytes) AS total_bytes
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ? AND hour_start >= ?
                    GROUP BY strftime('%Y', hour_start)
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
        conn = get_conn()
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
                    SELECT COALESCE(SUM(uploaded_bytes), 0) AS total
                    FROM emby_playback_upload_hourly
                    WHERE instance_name = ?
                      AND hour_start >= ? AND hour_start < ?
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


# ── 选片流量（与播放独立） ──────────────────────────────────────────────


def save_browse_upload_fact(instance_name: str, segment_id: int,
                            user_name: str, user_id: str,
                            stopped_at: str, upload_bytes: int,
                            viewing_title: str = '',
                            settle_reason: str = '',
                            series_name: str = '',
                            episode_label: str = '',
                            episode_title: str = '',
                            device_name: str = '',
                            client: str = '',
                            client_ip: str = '',
                            production_year: int = None,
                            min_upload_bytes: int = None) -> bool:
    """选片段结束时写入事实表并累加小时聚合。"""
    import core.config_manager as config_manager
    name = (instance_name or '').strip()
    if min_upload_bytes is None:
        min_upload_bytes = config_manager.emby_browse_upload_min_bytes()
    min_upload_bytes = max(0, int(min_upload_bytes or 0))
    if not name or not user_name or int(upload_bytes or 0) < min_upload_bytes:
        return False
    stopped_s = _normalize_stopped_at(stopped_at)
    hour_start = _hour_start_from_stopped(stopped_s)
    year_val = None
    if production_year is not None:
        try:
            year_val = int(production_year)
        except (TypeError, ValueError):
            year_val = None
    _ensure_emby_schema()
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            c.execute('''
                INSERT OR IGNORE INTO emby_browse_upload_facts (
                    instance_name, segment_id, user_name, user_id, stopped_at,
                    estimated_upload_bytes, viewing_title, settle_reason,
                    series_name, episode_label, episode_title,
                    device_name, client, client_ip, production_year
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                name, int(segment_id), user_name, user_id or '',
                stopped_s, int(upload_bytes), viewing_title or '',
                settle_reason or '',
                series_name or '', episode_label or '', episode_title or '',
                device_name or '', client or '', client_ip or '',
                year_val,
            ))
            if c.rowcount <= 0:
                return False
            c.execute('''
                INSERT INTO emby_browse_upload_hourly (
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


def set_retention_years(years: int) -> bool:
    """设置数据保留年数（1-20），返回是否缩小了保留年限"""
    global _retention_years
    years = max(
        traffic_db.RETENTION_YEARS_MIN,
        min(traffic_db.RETENTION_YEARS_MAX, int(years)),
    )
    decreased = years < _retention_years
    _retention_years = years
    return decreased


def get_retention_years() -> int:
    return _retention_years


def _month_cutoff_ym() -> int:
    now = _now()
    return (now.year - _retention_years) * 100 + now.month


def _run_vacuum_background():
    """后台执行 incremental_vacuum，避免阻塞采集与 API。"""
    global _vacuum_running
    with _lock:
        if _vacuum_running:
            return
        _vacuum_running = True

    def _worker():
        global _vacuum_running
        try:
            conn = get_conn()
            try:
                conn.execute('PRAGMA incremental_vacuum')
                conn.commit()
                logger.info('Emby 数据库 incremental_vacuum 完成')
            finally:
                conn.close()
        except Exception as e:
            logger.warning('Emby 数据库 incremental_vacuum 失败: %s', e)
        finally:
            with _lock:
                _vacuum_running = False

    threading.Thread(
        target=_worker, name='emby-db-vacuum', daemon=True,
    ).start()


def cleanup_old_data():
    """清理过期 Emby 流量数据并定期 VACUUM"""
    global _last_vacuum_day
    schedule_vacuum = False
    hourly_deleted = 0
    facts_deleted = 0
    with _lock:
        conn = get_conn()
        try:
            c = conn.cursor()
            hourly_cutoff = _cutoff_str(days=_retention_years * 365)
            for table in (
                'emby_traffic_hourly',
                'emby_playback_upload_hourly',
                'emby_browse_upload_hourly',
            ):
                c.execute(
                    f'DELETE FROM {table} WHERE hour_start < ?',
                    (hourly_cutoff,),
                )
                hourly_deleted += c.rowcount

            month_cutoff_ym = _month_cutoff_ym()
            c.execute('''
                DELETE FROM emby_traffic_monthly
                WHERE (year * 100 + month) < ?
            ''', (month_cutoff_ym,))

            for table in (
                'emby_playback_upload_facts',
                'emby_browse_upload_facts',
            ):
                c.execute(
                    f'DELETE FROM {table} WHERE stopped_at < ?',
                    (hourly_cutoff,),
                )
                facts_deleted += c.rowcount
            c.execute(
                'DELETE FROM emby_content_plays WHERE started_at < ?',
                (hourly_cutoff,),
            )
            facts_deleted += c.rowcount

            conn.commit()

            today = _now().date()
            if (
                _last_vacuum_day != today
                and today.day % _VACUUM_INTERVAL_DAYS == 1
            ):
                _last_vacuum_day = today
                schedule_vacuum = True

            if hourly_deleted > 0 or facts_deleted > 0:
                logger.info(
                    'Emby 数据清理完成: 删除 %d 条过期小时统计, %d 条过期记录',
                    hourly_deleted,
                    facts_deleted,
                )
        except Exception as e:
            logger.warning('Emby 数据清理失败: %s', e)
        finally:
            conn.close()

    if schedule_vacuum:
        _run_vacuum_background()

