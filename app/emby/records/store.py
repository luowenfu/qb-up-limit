"""自写播放段记录：以 /Sessions 为真相源，热更新 JSON。"""

import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Set

import emby.traffic.upload_sync as emby_playback_upload_sync
import emby.records.watch_progress as emby_watch_progress
from emby.records.watch_progress import _normalize_seek_log, _normalize_seek_timeline
from emby.client import EmbyClient
from emby.storage_paths import (
    EMBY_EVENTS_DIR,
    legacy_playback_record_store_path,
    playback_record_store_path,
)
from core.secrets_store import _read_json, _write_json

logger = logging.getLogger(__name__)

RECORD_RETENTION_DAYS = 90
MAX_STORED_RECORDS = 5000
OFFLINE_TIMEOUT_SECONDS = 5 * 60
STOP_GRACE_SECONDS = 5
# 暂停抖动去重：卡片消失即时结案后，若会话卡片抖动回来（Emby web 暂停会
# paused⇄connected），且位置仍停在刚结案的那个点（未推进），视为同一暂停段，
# 不再新建重复播放段，从根源避免大量极小流量的重复停止卡片。
FLAP_POSITION_TOLERANCE_SECONDS = 3
_SAVE_DEBOUNCE_SECONDS = 2.0

_lock = threading.RLock()
_runtime: Dict[str, dict] = {}
_pending_stores: Dict[str, dict] = {}
_flush_timers: Dict[str, threading.Timer] = {}

_PLAYBACK_STATUSES = frozenset({'playing', 'ended', 'incomplete'})


def _store_path(instance_name: str) -> str:
    return playback_record_store_path(instance_name)


def _is_activity_log_store(data: dict) -> bool:
    return isinstance(data, dict) and isinstance(data.get('events'), list) and not isinstance(
        data.get('records'), list,
    )


def _is_playback_record_store(data: dict) -> bool:
    return isinstance(data, dict) and isinstance(data.get('records'), list)


def _migrate_instance_store(instance_name: str) -> None:
    path = _store_path(instance_name)
    legacy = legacy_playback_record_store_path(instance_name)
    if os.path.isfile(path):
        data = _read_json(path, {})
        if _is_activity_log_store(data):
            try:
                os.remove(path)
                logger.info(f'[Playback:{instance_name}] 已删除旧活动日志 JSON: {path}')
            except OSError as e:
                logger.warning(f'[Playback:{instance_name}] 删除旧活动日志失败: {e}')
    if os.path.isfile(legacy):
        if not os.path.isfile(path):
            try:
                os.rename(legacy, path)
                logger.info(f'[Playback:{instance_name}] 已迁移播放记录: {legacy} -> {path}')
            except OSError as e:
                logger.warning(f'[Playback:{instance_name}] 迁移 *_2.json 失败: {e}')
        else:
            legacy_data = _read_json(legacy, {})
            if _is_playback_record_store(legacy_data):
                try:
                    os.remove(legacy)
                    logger.info(f'[Playback:{instance_name}] 已删除重复 *_2.json: {legacy}')
                except OSError as e:
                    logger.warning(f'[Playback:{instance_name}] 删除 *_2.json 失败: {e}')


_migrated_instances: Set[str] = set()


def _ensure_migrated(instance_name: str) -> None:
    if not instance_name:
        return
    with _lock:
        if instance_name in _migrated_instances:
            return
        _migrate_instance_store(instance_name)
        _migrated_instances.add(instance_name)


def _migrate_all_stores_once() -> None:
    if not os.path.isdir(EMBY_EVENTS_DIR):
        return
    names = set()
    for fname in os.listdir(EMBY_EVENTS_DIR):
        if fname.endswith('_2.json'):
            data = _read_json(os.path.join(EMBY_EVENTS_DIR, fname), {})
            inst = (data.get('instance_name') or '').strip()
            if inst:
                names.add(inst)
        elif fname.endswith('.json'):
            data = _read_json(os.path.join(EMBY_EVENTS_DIR, fname), {})
            inst = (data.get('instance_name') or '').strip()
            if inst and _is_playback_record_store(data):
                names.add(inst)
            elif inst and _is_activity_log_store(data):
                names.add(inst)
    for inst in names:
        _ensure_migrated(inst)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + '0000Z'


def _parse_iso(s: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        text = str(s).strip()
        if text.endswith('Z'):
            text = text[:-1] + '+00:00'
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (TypeError, ValueError):
        return None


def _load_store(instance_name: str) -> dict:
    flush_pending_store(instance_name)
    _ensure_migrated(instance_name)
    path = _store_path(instance_name)
    default = {
        'instance_name': instance_name,
        'next_id': 1,
        'records': [],
    }
    if not os.path.isfile(path):
        return default
    data = _read_json(path, default)
    if not isinstance(data, dict):
        return default
    data.setdefault('instance_name', instance_name)
    data.setdefault('next_id', 1)
    if not isinstance(data.get('records'), list):
        data['records'] = []
    return data


def _write_store_now(store: dict) -> None:
    path = _store_path(store.get('instance_name') or '')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    store['records'] = _trim_records(store.get('records') or [])
    _write_json(path, store)


def _cancel_flush_timer(instance_name: str) -> None:
    timer = _flush_timers.pop(instance_name, None)
    if timer is not None:
        timer.cancel()


def _schedule_flush(instance_name: str) -> None:
    _cancel_flush_timer(instance_name)

    def _run():
        with _lock:
            store = _pending_stores.pop(instance_name, None)
            _flush_timers.pop(instance_name, None)
        if store:
            _write_store_now(store)

    timer = threading.Timer(_SAVE_DEBOUNCE_SECONDS, _run)
    timer.daemon = True
    _flush_timers[instance_name] = timer
    timer.start()


def flush_pending_store(instance_name: str) -> None:
    name = (instance_name or '').strip()
    if not name:
        return
    with _lock:
        _cancel_flush_timer(name)
        store = _pending_stores.pop(name, None)
    if store:
        _write_store_now(store)


def flush_all_pending() -> None:
    with _lock:
        names = list(_pending_stores.keys())
    for name in names:
        flush_pending_store(name)


def _save_store(store: dict, *, immediate: bool = False) -> None:
    name = (store.get('instance_name') or '').strip()
    if not name:
        return
    if immediate:
        with _lock:
            _cancel_flush_timer(name)
            _pending_stores.pop(name, None)
        _write_store_now(store)
        return
    with _lock:
        _pending_stores[name] = store
    _schedule_flush(name)


def _runtime_bucket(instance_name: str) -> dict:
    with _lock:
        bucket = _runtime.setdefault(instance_name, {})
        bucket.setdefault('offline_since', None)
        bucket.setdefault('was_api_online', True)
        bucket.setdefault('pending_stop_since', {})
        bucket.setdefault('post_recovery_playback_window', False)
        return bucket


def begin_post_recovery_playback_window(instance_name: str) -> None:
    """Recovery tick：标记后续新建段为「服务恢复后」会话。"""
    name = (instance_name or '').strip()
    if not name:
        return
    bucket = _runtime_bucket(name)
    bucket['post_recovery_playback_window'] = True


def end_post_recovery_playback_window(instance_name: str) -> None:
    name = (instance_name or '').strip()
    if not name:
        return
    with _lock:
        bucket = _runtime.get(name)
        if isinstance(bucket, dict):
            bucket['post_recovery_playback_window'] = False


def _pending_stop_map(bucket: dict) -> Dict[int, float]:
    pending = bucket.get('pending_stop_since')
    if not isinstance(pending, dict):
        pending = {}
        bucket['pending_stop_since'] = pending
    return pending


def _clear_pending_stop(bucket: dict, record: dict) -> None:
    rid = int((record or {}).get('id') or 0)
    if rid > 0:
        _pending_stop_map(bucket).pop(rid, None)


def _alloc_id(store: dict) -> int:
    rid = int(store.get('next_id') or 1)
    store['next_id'] = rid + 1
    return rid


def _segment_key(rec: dict) -> tuple:
    return (
        str(rec.get('user_id') or '').strip(),
        EmbyClient._normalize_client_key(rec.get('client') or ''),
        str(rec.get('item_id') or '').strip(),
    )


def _ended_record_sort_key(rec: dict) -> str:
    """已结束段列表排序：墙钟结束时间优先。"""
    return (
        rec.get('stopped_at') or rec.get('last_tick_at')
        or rec.get('started_at') or ''
    )


def _record_on_or_after(rec: dict, cutoff: datetime) -> bool:
    dt = _parse_iso(_ended_record_sort_key(rec))
    return dt is not None and dt >= cutoff


def _trim_records(records: list) -> list:
    """正在播放永远保留；其余只留最近 RECORD_RETENTION_DAYS 天，总数不超过上限。"""
    cutoff = datetime.now(timezone.utc) - timedelta(days=RECORD_RETENTION_DAYS)
    playing = []
    others = []
    for rec in records or []:
        if rec.get('status') == 'playing':
            playing.append(rec)
        elif _record_on_or_after(rec, cutoff):
            others.append(rec)
    others.sort(key=_ended_record_sort_key, reverse=True)
    return (playing + others)[:MAX_STORED_RECORDS]


def _session_track_key(session: dict) -> tuple:
    return (
        str(session.get('user_id') or '').strip(),
        EmbyClient._normalize_client_key(session.get('client') or ''),
        str(session.get('item_id') or '').strip(),
    )


def _prepare_session(session: dict) -> dict:
    if session.get('NowPlayingItem') or session.get('PlayState'):
        return EmbyClient.normalize_session(session)
    return session


def _apply_session_meta(record: dict, session: dict) -> None:
    prepared = _prepare_session(session)
    EmbyClient.apply_playback_meta(record, prepared)
    endpoint = record.get('remote_endpoint') or prepared.get('remote_endpoint') or ''
    if endpoint and not record.get('client_ip'):
        from emby.traffic.filter import parse_endpoint_ip
        record['client_ip'] = parse_endpoint_ip(endpoint)
    for key in ('user_id', 'user_name', 'client', 'device_name'):
        val = prepared.get(key)
        if val not in (None, ''):
            record[key] = val
    runtime = int(prepared.get('runtime_seconds') or 0)
    if runtime > 0:
        record['runtime_seconds'] = runtime
    if not record.get('item_title'):
        record['item_title'] = (
            prepared.get('episode_title') or prepared.get('title') or ''
        )
    if not record.get('episode_title'):
        record['episode_title'] = prepared.get('episode_title') or record.get('item_title') or ''
    if not record.get('series_name'):
        record['series_name'] = prepared.get('series_name') or ''
    if not record.get('episode_label') and prepared.get('episode_label'):
        record['episode_label'] = prepared.get('episode_label')
    meta = EmbyClient.extract_playback_meta(prepared)
    for key in ('play_method', 'is_video_direct', 'is_audio_direct', 'transcode_kind'):
        if key in meta:
            record[key] = meta[key]
    # 转码明细：留存到记录，播放完毕后卡片仍可悬停查看具体转码信息
    for key in (
        'video_codec', 'audio_codec', 'container', 'width', 'height',
        'video_bitrate', 'audio_bitrate', 'framerate', 'audio_channels',
        'transcode_reasons', 'video_decoder', 'video_encoder',
    ):
        val = prepared.get(key)
        if val in (None, '', 0, []):
            continue
        record[key] = val
    if prepared.get('video_encoder') or prepared.get('video_decoder'):
        record['video_encoder_is_hardware'] = bool(prepared.get('video_encoder_is_hardware'))
    if 'is_paused' in prepared:
        record['is_paused'] = bool(prepared.get('is_paused'))
    mode = str(
        prepared.get('traffic_collect_mode')
        or record.get('traffic_collect_mode')
        or '',
    ).strip().lower()
    record['traffic_collect_mode'] = mode if mode == 'lucky' else ''
    record['estimate_upload_enabled'] = mode == 'lucky'
    pos = prepared.get('position_seconds')
    if pos is not None and record.get('status') == 'playing':
        record['end_position_seconds'] = max(0, int(pos))
    if record.get('status') == 'playing' and not record.get('upload_accumulator_key'):
        from emby.traffic.filter import playback_accumulator_key
        acc_key = playback_accumulator_key(record)
        if acc_key:
            record['upload_accumulator_key'] = acc_key


def _apply_watch_snapshot(record: dict, snapshot: dict) -> None:
    if not snapshot:
        return
    overwrite = (
        bool(record.get('watch_fields_frozen'))
        or record.get('status') != 'playing'
    )
    emby_watch_progress.merge_watch_snapshot(record, snapshot, overwrite=overwrite)


def _resolve_upload_bytes(instance_name: str, record: dict) -> None:
    if not record.get('is_remote'):
        return
    mode = str(record.get('traffic_collect_mode') or '').strip().lower()
    if mode != 'lucky':
        return
    emby_playback_upload_sync.resolve_upload_bytes(
        instance_name,
        playback_record=record,
    )


def _take_upload(instance_name: str, record: dict) -> None:
    _resolve_upload_bytes(instance_name, record)


def _persist_content_play(instance_name: str, record: dict) -> None:
    try:
        import emby.traffic.db as emby_traffic_db
        emby_traffic_db.save_content_play(
            instance_name,
            int(record.get('id') or 0),
            record.get('user_name') or '',
            record.get('started_at') or '',
            record.get('item_id') or '',
            record.get('item_title') or '',
            record.get('item_type') or '',
            record.get('series_name') or '',
        )
    except Exception as e:
        logger.debug(f'[Playback:{instance_name}] 点播明细入库失败: {e}')


def accrue_playing_upload(instance_name: str) -> int:
    """按采集把仍在播放的外网上行增量写入账本。已入账部分不重复记。"""
    name = (instance_name or '').strip()
    if not name:
        return 0
    with _lock:
        store = _load_store(name)
        records = [
            dict(rec)
            for rec in (store.get('records') or [])
            if rec.get('status') == 'playing' and rec.get('is_remote')
            and str(rec.get('traffic_collect_mode') or '').strip().lower() == 'lucky'
        ]
    if not records:
        return 0
    import emby.traffic.playback as emby_playback_traffic
    import emby.traffic.db as emby_traffic_db
    now = _utc_now_iso()
    booked = 0
    for rec in records:
        user = str(rec.get('user_name') or '').strip()
        if not user:
            continue
        peek = emby_playback_traffic.peek_accumulated_upload(name, rec)
        already = max(0, int(rec.get('estimated_upload_bytes') or 0))
        accum = max(0, int(peek or 0))
        checkpoint = max(0, int(rec.get('live_upload_checkpoint_bytes') or 0))
        total = max(already + accum, checkpoint)
        if total <= 0:
            continue
        if emby_traffic_db.save_playback_upload_fact(
            name,
            int(rec.get('id') or 0),
            user,
            rec.get('user_id') or '',
            now,
            total,
            rec.get('series_name') or '',
            rec.get('episode_label') or '',
        ):
            booked += 1
    return booked


def _persist_upload_fact(instance_name: str, record: dict) -> None:
    if not record.get('is_remote'):
        return
    upload = record.get('estimated_upload_bytes')
    if upload is None or int(upload) <= 0:
        return
    try:
        import emby.traffic.db as emby_traffic_db
        emby_traffic_db.save_playback_upload_fact(
            instance_name,
            int(record.get('id') or 0),
            record.get('user_name') or '',
            record.get('user_id') or '',
            record.get('stopped_at') or record.get('last_tick_at') or '',
            int(upload),
            record.get('series_name') or '',
            record.get('episode_label') or '',
        )
    except Exception as e:
        logger.debug(f'[Playback:{instance_name}] 用户上行入库失败: {e}')


def _estimate_played_wall_seconds(record: dict) -> Optional[int]:
    start_dt = _parse_iso(record.get('started_at') or '')
    stop_dt = _parse_iso(record.get('stopped_at') or '')
    if not start_dt or not stop_dt or stop_dt <= start_dt:
        return None
    return max(1, int((stop_dt - start_dt).total_seconds()))


def _finalize_record(instance_name: str, record: dict, *,
                     status: str, stopped_at: str = None,
                     interrupt_reason: str = None,
                     settle_reason: str = None) -> None:
    if status not in _PLAYBACK_STATUSES or status == 'playing':
        return
    if record.get('status') != 'playing':
        return
    record['status'] = status
    if status == 'ended' and not interrupt_reason:
        record['stopped_at'] = stopped_at or _utc_now_iso()
    else:
        record['stopped_at'] = stopped_at or record.get('last_tick_at') or _utc_now_iso()
    if interrupt_reason:
        record['interrupt_reason'] = interrupt_reason
    reason = str(
        settle_reason or interrupt_reason or '',
    ).strip()
    if reason:
        record['settle_reason'] = reason
    snap = emby_watch_progress.snapshot_for_record(instance_name, record)
    if snap:
        _apply_watch_snapshot(record, snap)
    emby_watch_progress.finalize_watch_to_event(instance_name, record)
    if not record.get('played_seconds'):
        wall = _estimate_played_wall_seconds(record)
        if wall:
            record['played_seconds'] = wall
    start_pos = record.get('start_position_seconds')
    end_pos = record.get('end_position_seconds')
    if start_pos is not None and (end_pos is None or int(end_pos or 0) <= 0):
        played = int(record.get('played_seconds') or 0)
        if played > 0:
            record['end_position_seconds'] = max(0, int(start_pos)) + played
    _take_upload(instance_name, record)
    _persist_content_play(instance_name, record)
    if status == 'ended' or (status == 'incomplete' and record.get('estimated_upload_bytes')):
        _persist_upload_fact(instance_name, record)
    try:
        import emby.traffic.playback as emby_playback_traffic
        emby_playback_traffic.on_playback_segment_finalized(instance_name, record)
    except Exception as e:
        logger.debug(f'[Playback:{instance_name}] 播放段流量结案回调失败: {e}')
    emby_watch_progress.reset_tracker_for_record(instance_name, record)
    bucket = _runtime_bucket(instance_name)
    _clear_pending_stop(bucket, record)
    if record.get('emby_session_id'):
        bucket.pop(f'sid:{record["emby_session_id"]}', None)
    if reason in ('emby_confirmed_stop', 'emby_abnormal_disconnect', 'grace_expired', 'item_change'):
        logger.info(
            f'[Playback:{instance_name}] 播放段结案 rid={record.get("id")} '
            f'sid={record.get("emby_session_id") or "?"} reason={reason}',
        )
    record.pop('live_upload_checkpoint_bytes', None)


def _should_suppress_flap_record(store: dict, session: dict) -> bool:
    """暂停抖动去重：暂停会话卡片抖动回来、位置仍停在刚结案位置时，不重复建段。

    仅当会话处于暂停态、且存在同一 emby_session_id + 同一 item、结案位置与当前
    暂停位置基本一致（未推进）的已结束记录时才抑制。用户真正恢复播放时会话为
    playing（不抑制），故不影响续播/重播建段。
    """
    if not bool(session.get('is_paused')):
        return False
    sid = str(session.get('id') or '').strip()
    item_id = str(session.get('item_id') or '').strip()
    if not sid or not item_id:
        return False
    pos = session.get('position_seconds')
    if pos is None:
        return False
    pos = int(pos)
    for rec in store.get('records') or []:
        if rec.get('status') == 'playing':
            continue
        if str(rec.get('emby_session_id') or '').strip() != sid:
            continue
        if str(rec.get('item_id') or '').strip() != item_id:
            continue
        end_pos = rec.get('end_position_seconds')
        if end_pos is None:
            continue
        if abs(pos - int(end_pos)) <= FLAP_POSITION_TOLERANCE_SECONDS:
            return True
    return False


def _new_record(instance_name: str, store: dict, session: dict) -> dict:
    prepared = _prepare_session(session)
    rid = _alloc_id(store)
    now = _utc_now_iso()
    record = {
        'id': rid,
        'instance_name': instance_name,
        'status': 'playing',
        'source': 'native',
        'emby_session_id': str(prepared.get('id') or ''),
        'started_at': now,
        'stopped_at': None,
        'last_tick_at': now,
        'interrupt_reason': None,
    }
    _apply_session_meta(record, prepared)
    emby_watch_progress.begin_pair_watch(instance_name, record)
    snap = emby_watch_progress.update_for_record(instance_name, record, prepared)
    _apply_watch_snapshot(record, snap)
    bucket = _runtime_bucket(instance_name)
    sid = record.get('emby_session_id')
    if bucket.get('post_recovery_playback_window'):
        record['started_after_recovery'] = True
    if sid:
        bucket[f'sid:{sid}'] = rid
    bucket[f'track:{_segment_key(record)}'] = rid
    try:
        import emby.traffic.playback as emby_playback_traffic
        emby_playback_traffic.on_playback_segment_started(instance_name, record)
    except Exception as e:
        logger.debug(f'[Playback:{instance_name}] 播放段流量开始回调失败: {e}')
    _persist_content_play(instance_name, record)
    return record


def _find_open_record(store: dict, session: dict,
                      instance_name: str) -> Optional[dict]:
    records = store.get('records') or []
    sid = str(session.get('id') or '')
    bucket = _runtime_bucket(instance_name)
    if sid:
        rid = bucket.get(f'sid:{sid}')
        if rid:
            for rec in records:
                if rec.get('id') == rid and rec.get('status') == 'playing':
                    return rec
    track = _session_track_key(session)
    rid = bucket.get(f'track:{track}')
    if rid:
        for rec in records:
            if rec.get('id') == rid and rec.get('status') == 'playing':
                return rec
    for rec in records:
        if rec.get('status') != 'playing':
            continue
        if _segment_key(rec) == track:
            return rec
    return None


def enrich_sessions_playback_started_at(instance_name: str,
                                        sessions: list,
                                        store: dict = None) -> list:
    """为 Sessions 附加播放段 started_at 与观看快照字段。"""
    name = (instance_name or '').strip()
    if not name or not sessions:
        return list(sessions or [])
    if store is None:
        store = _load_store(name)
    playing = [
        rec for rec in (store.get('records') or [])
        if rec.get('status') == 'playing'
    ]
    by_sid: Dict[str, dict] = {}
    by_track: Dict[tuple, dict] = {}
    for rec in playing:
        started = str(rec.get('started_at') or '').strip()
        booked = max(0, int(rec.get('estimated_upload_bytes') or 0))
        checkpoint = max(0, int(rec.get('live_upload_checkpoint_bytes') or 0))
        meta = {
            'playback_started_at': started,
            'seek_count': max(0, int(rec.get('seek_count') or 0)),
            'seek_forward_count': max(0, int(rec.get('seek_forward_count') or 0)),
            'seek_backward_count': max(0, int(rec.get('seek_backward_count') or 0)),
            'last_seek_at': str(rec.get('last_seek_at') or '').strip(),
            'played_seconds': max(0, int(rec.get('played_seconds') or 0)),
            'estimated_upload_bytes_floor': max(booked, checkpoint),
            'seek_forward_log': _normalize_seek_log(rec.get('seek_forward_log')),
            'seek_backward_log': _normalize_seek_log(rec.get('seek_backward_log')),
            'seek_log': _normalize_seek_timeline(rec.get('seek_log')),
        }
        sid = str(rec.get('emby_session_id') or '').strip()
        if sid:
            by_sid[sid] = meta
        by_track[_segment_key(rec)] = meta

    enriched = []
    for raw in sessions:
        session = dict(raw)
        prepared = _prepare_session(session)
        sid = str(prepared.get('id') or '').strip()
        meta = by_sid.get(sid) or by_track.get(_session_track_key(prepared), {})
        started = str(meta.get('playback_started_at') or '').strip()
        if started:
            session['playback_started_at'] = started
        seek_count = int(meta.get('seek_count') or 0)
        if seek_count > 0:
            session['seek_count'] = seek_count
        seek_forward_count = int(meta.get('seek_forward_count') or 0)
        if seek_forward_count > 0:
            session['seek_forward_count'] = seek_forward_count
        seek_backward_count = int(meta.get('seek_backward_count') or 0)
        if seek_backward_count > 0:
            session['seek_backward_count'] = seek_backward_count
        last_seek_at = str(meta.get('last_seek_at') or '').strip()
        if last_seek_at:
            session['last_seek_at'] = last_seek_at
        played_seconds = int(meta.get('played_seconds') or 0)
        if played_seconds > 0:
            session['played_seconds'] = played_seconds
        upload_floor = int(meta.get('estimated_upload_bytes_floor') or 0)
        if upload_floor > 0:
            session['estimated_upload_bytes_floor'] = upload_floor
        forward_log = meta.get('seek_forward_log') or []
        if forward_log:
            session['seek_forward_log'] = forward_log
        backward_log = meta.get('seek_backward_log') or []
        if backward_log:
            session['seek_backward_log'] = backward_log
        timeline = meta.get('seek_log') or []
        if timeline:
            session['seek_log'] = timeline
        enriched.append(session)
    return enriched


def _active_playing_sessions(sessions: list) -> List[dict]:
    result = []
    for raw in sessions or []:
        session = _prepare_session(raw)
        if not EmbyClient.is_current_playback_session(session):
            continue
        result.append(session)
    return result


def _sessions_with_now_playing(sessions: list) -> List[dict]:
    """API 中仍挂着 NowPlayingItem 的会话（含暂停/短暂 IsPlaying=false）。"""
    result = []
    for raw in sessions or []:
        session = _prepare_session(raw)
        if not EmbyClient.session_has_now_playing_media(session):
            continue
        result.append(session)
    return result


def _session_keeps_open_playback_record(session: dict) -> bool:
    """仍在播或暂停中则保持 open（与设备卡片「当前播放会话」口径一致）。"""
    return EmbyClient.is_current_playback_session(session)


def _emby_confirms_stop(session: dict) -> bool:
    """Emby /Sessions 明确报告已停止（非暂停、非播放中）。"""
    if not session:
        return False
    raw = session if (session.get('NowPlayingItem') or session.get('PlayState')) else session
    if EmbyClient.is_emby_abnormal_disconnect_session(raw):
        return True
    prepared = _prepare_session(session)
    if bool(prepared.get('is_paused')):
        return False
    if str(prepared.get('session_mode') or '').strip() == 'paused':
        return False
    if (
        EmbyClient.session_has_now_playing_media(prepared)
        and not bool(prepared.get('is_playing'))
    ):
        return False
    return not bool(prepared.get('is_playing'))


def _finalize_emby_confirmed_stop(
    instance_name: str,
    record: dict,
    session: dict,
) -> None:
    raw = session if (session.get('NowPlayingItem') or session.get('PlayState')) else session
    reason = (
        'emby_abnormal_disconnect'
        if EmbyClient.is_emby_abnormal_disconnect_session(raw)
        else 'emby_confirmed_stop'
    )
    _finalize_record(instance_name, record, status='ended', settle_reason=reason)


def _find_api_session_by_sid(sessions: list, record: dict) -> Optional[dict]:
    sid = str((record or {}).get('emby_session_id') or '').strip()
    if not sid:
        return None
    for raw in sessions or []:
        prepared = _prepare_session(raw)
        if str(prepared.get('id') or '').strip() == sid:
            return prepared
    return None


def _refresh_open_record_from_session(
    instance_name: str,
    record: dict,
    session: dict,
) -> None:
    _apply_session_meta(record, session)
    snap = emby_watch_progress.update_for_record(instance_name, record, session)
    _apply_watch_snapshot(record, snap)
    record['last_tick_at'] = _utc_now_iso()


def _handle_stale_open_record(
    instance_name: str,
    bucket: dict,
    record: dict,
    sessions: list,
    now_mono: float,
) -> str:
    """open 段本轮不在「当前播放会话」列表：卡片仍在则保持，卡片消失即时结案，会话消失 5s 宽限。"""
    matched = _find_api_session_for_record(sessions, record)
    # 卡片仍在（会话仍是「当前播放会话」，含暂停态）：保持 open，跟随 Emby。
    if matched is not None:
        if _session_keeps_open_playback_record(matched):
            _clear_pending_stop(bucket, record)
            _refresh_open_record_from_session(instance_name, record, matched)
            return 'updated'
        if _emby_confirms_stop(matched):
            _clear_pending_stop(bucket, record)
            _finalize_emby_confirmed_stop(instance_name, record, matched)
            return 'finalized'

    api_session = _find_api_session_by_sid(sessions, record)
    if api_session is not None:
        if _session_keeps_open_playback_record(api_session):
            _clear_pending_stop(bucket, record)
            if matched is None:
                _refresh_open_record_from_session(instance_name, record, api_session)
                return 'updated'
            return 'unchanged'
        if _emby_confirms_stop(api_session):
            # 卡片消失（会话跌为 connected）：即时结案，跟随卡片状态。
            _clear_pending_stop(bucket, record)
            _finalize_emby_confirmed_stop(instance_name, record, api_session)
            return 'finalized'

    # 会话已从 /Sessions 消失：5 秒宽限确认（容忍单次轮询丢失），随后结案。
    pending = _pending_stop_map(bucket)
    rid = int(record.get('id') or 0)
    if rid <= 0:
        return 'unchanged'
    since = pending.get(rid)
    if since is None:
        pending[rid] = now_mono
        sid = str(record.get('emby_session_id') or '').strip()
        logger.info(
            f'[Playback:{instance_name}] 播放段停止待确认 rid={rid} '
            f'sid={sid or "?"} grace={STOP_GRACE_SECONDS}s',
        )
        return 'pending'
    if now_mono - float(since) < STOP_GRACE_SECONDS:
        return 'pending'
    pending.pop(rid, None)
    _finalize_record(
        instance_name, record, status='ended',
        settle_reason='grace_expired',
    )
    return 'finalized'


def _session_matches_open_record(session: dict, record: dict) -> bool:
    if not session or not record:
        return False
    rec_sid = str(record.get('emby_session_id') or '').strip()
    sess_sid = str(session.get('id') or '').strip()
    if rec_sid and sess_sid and rec_sid != sess_sid:
        return False
    rec_item = str(record.get('item_id') or '').strip()
    sess_item = str(session.get('item_id') or '').strip()
    if rec_item and sess_item and rec_item != sess_item:
        return False
    rec_user = str(record.get('user_id') or '').strip()
    sess_user = str(session.get('user_id') or '').strip()
    if rec_user and sess_user and rec_user != sess_user:
        return False
    rec_client = EmbyClient._normalize_client_key(record.get('client') or '')
    sess_client = EmbyClient._normalize_client_key(session.get('client') or '')
    if rec_client and sess_client and rec_client != sess_client:
        return False
    return bool(rec_sid or rec_item or (rec_user and rec_client))


def _find_api_session_for_record(sessions: list, record: dict) -> Optional[dict]:
    for session in _sessions_with_now_playing(sessions):
        if _session_matches_open_record(session, record):
            return session
    return None


def _open_playback_sids(store: dict) -> Set[str]:
    sids: Set[str] = set()
    for rec in store.get('records') or []:
        if rec.get('status') != 'playing':
            continue
        sid = str(rec.get('emby_session_id') or '').strip()
        if sid:
            sids.add(sid)
    return sids


def open_playback_session_ids(instance_name: str) -> Set[str]:
    """实例级仍在播放中的 emby_session_id（供流量 purge 等逻辑查询）。"""
    if not instance_name:
        return set()
    with _lock:
        store = _load_store(instance_name)
        return _open_playback_sids(store)


def open_playing_upload_checkpoints(instance_name: str) -> Dict[str, int]:
    """仍在播放中的外网段可续传累加器增量（checkpoint 总额减已入账）。"""
    name = (instance_name or '').strip()
    if not name:
        return {}
    with _lock:
        store = _load_store(name)
        result: Dict[str, int] = {}
        for rec in store.get('records') or []:
            if rec.get('status') != 'playing' or not rec.get('is_remote'):
                continue
            booked = max(0, int(rec.get('estimated_upload_bytes') or 0))
            chk = max(0, int(rec.get('live_upload_checkpoint_bytes') or 0))
            restorable = max(0, chk - booked)
            from emby.traffic.filter import playback_accumulator_key
            acc_key = str(rec.get('upload_accumulator_key') or '').strip()
            if not acc_key:
                acc_key = playback_accumulator_key(rec) or ''
            if acc_key:
                result[acc_key] = max(result.get(acc_key, 0), restorable)
        return result


def protected_playback_session_ids(instance_name: str) -> Set[str]:
    """open 或停止待确认中的 sid：播放累加器不得提前清理。"""
    name = (instance_name or '').strip()
    if not name:
        return set()
    with _lock:
        store = _load_store(name)
        sids = set(_open_playback_sids(store))
        runtime = _runtime.get(name) or {}
        pending = runtime.get('pending_stop_since') or {}
        if not pending:
            return sids
        rid_to_sid: Dict[int, str] = {}
        for rec in store.get('records') or []:
            if rec.get('status') != 'playing':
                continue
            rid = int(rec.get('id') or 0)
            sid = str(rec.get('emby_session_id') or '').strip()
            if rid > 0 and sid:
                rid_to_sid[rid] = sid
        for rid in pending:
            sid = rid_to_sid.get(int(rid))
            if sid:
                sids.add(sid)
        return sids


def checkpoint_stopped_session_upload(instance_name: str, session: dict) -> bool:
    """停止播放时将累加器刷入 open 记录并清零（tick 未结案时的兜底）。"""
    name = (instance_name or '').strip()
    if not name or not isinstance(session, dict):
        return False
    with _lock:
        store = _load_store(name)
        prepared = _prepare_session(session)
        record = _find_open_record(store, prepared, name)
        if not record or record.get('status') != 'playing':
            return False
        if not record.get('is_remote'):
            return False
        import emby.traffic.upload_sync as emby_playback_upload_sync
        taken = emby_playback_upload_sync.try_take_upload(name, record)
        if not taken:
            return False
        prev = max(0, int(record.get('estimated_upload_bytes') or 0))
        record['estimated_upload_bytes'] = prev + taken
        record['live_upload_checkpoint_bytes'] = int(record['estimated_upload_bytes'])
        _save_store(store, immediate=True)
        logger.info(
            f'[Playback:{name}] 停止播放刷入上行 checkpoint='
            f'{taken} total={record["estimated_upload_bytes"]}',
        )
        return True


def _handle_offline(instance_name: str, store: dict, now_mono: float) -> bool:
    bucket = _runtime_bucket(instance_name)
    if bucket.get('offline_since') is None:
        bucket['offline_since'] = now_mono
    elapsed = now_mono - float(bucket['offline_since'])
    changed = False
    if elapsed < OFFLINE_TIMEOUT_SECONDS:
        return False
    for record in store.get('records') or []:
        if record.get('status') != 'playing':
            continue
        _finalize_record(
            instance_name, record,
            status='incomplete',
            interrupt_reason='timeout_offline',
        )
        changed = True
    bucket['offline_since'] = now_mono
    return changed


def _transfer_browse_on_item_change(instance_name: str, session: dict) -> None:
    try:
        import emby.traffic.playback as emby_playback_traffic
        emby_playback_traffic.transfer_browse_bytes_to_play_for_session(
            instance_name, session,
        )
    except Exception as e:
        logger.debug(
            f'[Playback:{instance_name}] 换集选片桶转播放失败: {e}',
        )


def _record_persist_key(record: dict) -> str:
    from emby.traffic.filter import playback_accumulator_key
    key = str(record.get('upload_accumulator_key') or '').strip()
    if not key:
        key = playback_accumulator_key(record) or ''
    return key


def _pre_restart_upload_total(instance_name: str, record: dict) -> int:
    """程序重启结案：仅取重启前已统计的上行（不含停机窗口 Lucky 补录）。"""
    booked = max(0, int(record.get('estimated_upload_bytes') or 0))
    chk = max(0, int(record.get('live_upload_checkpoint_bytes') or 0))
    restorable = max(0, chk - booked)
    key = _record_persist_key(record)
    db_extra = 0
    if key:
        try:
            import emby.traffic.db as emby_traffic_db
            db_upload = emby_traffic_db.load_session_upload_accumulators(
                instance_name,
            )
            db_val = max(0, int(db_upload.get(key) or 0))
            db_extra = max(0, db_val - restorable)
        except Exception:
            logger.warning(
                '读取重启前上行累计失败: %s',
                instance_name,
                exc_info=True,
            )
    return max(booked + restorable + db_extra, chk, booked)


def _session_matches_recovery_continuing(record: dict, session: dict) -> bool:
    """重启后续传：同用户、同 sid、同 item，且 Emby 仍为当前播放会话。"""
    if not record or not session:
        return False
    rec_item = str(record.get('item_id') or '').strip()
    live_item = str(session.get('item_id') or '').strip()
    if rec_item and live_item and rec_item != live_item:
        return False
    rec_sid = str(record.get('emby_session_id') or '').strip()
    live_sid = str(session.get('id') or '').strip()
    if rec_sid and live_sid and rec_sid != live_sid:
        return False
    rec_uid = str(record.get('user_id') or '').strip()
    live_uid = str(session.get('user_id') or '').strip()
    if rec_uid and live_uid and rec_uid != live_uid:
        return False
    rec_user = str(record.get('user_name') or '').strip().casefold()
    live_user = str(session.get('user_name') or '').strip().casefold()
    if rec_user and live_user and rec_user != live_user:
        return False
    if not EmbyClient.is_current_playback_session(session):
        return False
    return bool(rec_sid or rec_item or (rec_user and rec_uid))


def _find_continuing_session_for_record(
    sessions: list,
    record: dict,
) -> Optional[dict]:
    for raw in sessions or []:
        prepared = _prepare_session(raw)
        if _session_matches_recovery_continuing(record, prepared):
            return prepared
    return None


def _restart_recovery_finalize_unlocked(
    instance_name: str,
    store: dict,
    record: dict,
) -> None:
    """程序重启：非续传 open 段按重启前流量结案，不吸收停机 Lucky 增量。"""
    if record.get('status') != 'playing':
        return
    pre_total = _pre_restart_upload_total(instance_name, record)
    if pre_total > 0:
        record['estimated_upload_bytes'] = pre_total
    record['status'] = 'ended'
    record['stopped_at'] = _utc_now_iso()
    record['settle_reason'] = 'restart_recovery'
    snap = emby_watch_progress.snapshot_for_record(instance_name, record)
    if snap:
        _apply_watch_snapshot(record, snap)
    emby_watch_progress.finalize_watch_to_event(instance_name, record)
    if not record.get('played_seconds'):
        wall = _estimate_played_wall_seconds(record)
        if wall:
            record['played_seconds'] = wall
    start_pos = record.get('start_position_seconds')
    end_pos = record.get('end_position_seconds')
    if start_pos is not None and (end_pos is None or int(end_pos or 0) <= 0):
        played = int(record.get('played_seconds') or 0)
        if played > 0:
            record['end_position_seconds'] = max(0, int(start_pos)) + played
    _persist_content_play(instance_name, record)
    if pre_total > 0:
        _persist_upload_fact(instance_name, record)
    try:
        import emby.traffic.playback as emby_playback_traffic
        emby_playback_traffic.on_playback_segment_finalized(
            instance_name, record,
        )
        emby_playback_traffic.release_segment_upload_state(
            instance_name, record,
        )
    except Exception as e:
        logger.debug(
            f'[Playback:{instance_name}] 程序重启结案清理失败: {e}',
        )
    emby_watch_progress.reset_tracker_for_record(instance_name, record)
    bucket = _runtime_bucket(instance_name)
    _clear_pending_stop(bucket, record)
    if record.get('emby_session_id'):
        bucket.pop(f'sid:{record["emby_session_id"]}', None)
    record.pop('live_upload_checkpoint_bytes', None)
    logger.info(
        f'[Playback:{instance_name}] 播放段程序重启结案 rid={record.get("id")} '
        f'sid={record.get("emby_session_id") or "?"} upload={pre_total}',
    )


def run_recovery_scan(instance_name: str, sessions: list) -> Set[str]:
    """进程重启后：匹配则续传；否则按重启前流量立即结案。返回续传 persist_key 集合。"""
    name = (instance_name or '').strip()
    if not name:
        return set()
    continuing_keys: Set[str] = set()
    changed = False
    with _lock:
        store = _load_store(name)
        for record in list(store.get('records') or []):
            if record.get('status') != 'playing':
                continue
            if not record.get('is_remote'):
                continue
            mode = str(record.get('traffic_collect_mode') or '').strip().lower()
            if mode != 'lucky':
                continue
            if _find_continuing_session_for_record(sessions, record) is not None:
                key = _record_persist_key(record)
                if key:
                    continuing_keys.add(key)
                if not record.get('resumed_after_recovery'):
                    record['resumed_after_recovery'] = True
                    changed = True
                continue
            _restart_recovery_finalize_unlocked(name, store, record)
            changed = True
        if changed:
            store['records'] = _trim_records(store.get('records') or [])
            _save_store(store, immediate=True)
    return continuing_keys


def tick_from_sessions(instance_name: str, sessions: list, *,
                       api_online: bool = True,
                       return_store: bool = False):
    """Sessions 轮询入口：热更新 open 段，检测开始/结束/超时。"""
    def _wrap_return(changed_flag: bool, store_obj: dict = None):
        if return_store:
            return bool(changed_flag), store_obj
        return bool(changed_flag)

    if not instance_name:
        return _wrap_return(False, None)
    now_mono = time.monotonic()
    with _lock:
        store = _load_store(instance_name)
        changed = False
        needs_immediate_save = False
        bucket = _runtime_bucket(instance_name)

        if not api_online:
            bucket['was_api_online'] = False
            if _handle_offline(instance_name, store, now_mono):
                changed = True
                _save_store(store, immediate=True)
            return _wrap_return(changed, store)

        if not bucket.get('was_api_online', True):
            bucket['offline_since'] = None
        bucket['was_api_online'] = True
        bucket['offline_since'] = None

        playing_sessions = _active_playing_sessions(sessions)
        seen_rids: Set[int] = set()
        seen_sids: Set[str] = set()

        for session in playing_sessions:
            sid = str(session.get('id') or '')
            if sid:
                seen_sids.add(sid)
            prepared = _prepare_session(session)
            record = _find_open_record(store, prepared, instance_name)
            if record and sid and record.get('emby_session_id') and record.get('emby_session_id') != sid:
                old_item = str(record.get('item_id') or '')
                new_item = str(session.get('item_id') or '')
                if old_item and new_item and old_item != new_item:
                    _finalize_record(
                        instance_name, record, status='ended',
                        settle_reason='item_change',
                    )
                    changed = True
                    needs_immediate_save = True
                    _transfer_browse_on_item_change(instance_name, prepared)
                    record = None
            if record is None:
                if _should_suppress_flap_record(store, prepared):
                    # 暂停抖动：卡片消失已结案、位置未推进，跳过重复建段。
                    continue
                record = _new_record(instance_name, store, prepared)
                store.setdefault('records', []).insert(0, record)
                changed = True
            else:
                if sid and not record.get('emby_session_id'):
                    record['emby_session_id'] = sid
                old_item = str(record.get('item_id') or '')
                new_item = str(prepared.get('item_id') or '')
                if old_item and new_item and old_item != new_item:
                    _finalize_record(
                        instance_name, record, status='ended',
                        settle_reason='item_change',
                    )
                    _transfer_browse_on_item_change(instance_name, prepared)
                    record = _new_record(instance_name, store, prepared)
                    store.setdefault('records', []).insert(0, record)
                    changed = True
                    needs_immediate_save = True
                else:
                    _apply_session_meta(record, prepared)
                    snap = emby_watch_progress.update_for_record(
                        instance_name, record, prepared,
                    )
                    _apply_watch_snapshot(record, snap)
                    changed = True
            record['last_tick_at'] = _utc_now_iso()
            if (
                record.get('status') == 'playing'
                and record.get('is_remote')
                and str(record.get('traffic_collect_mode') or '').strip().lower() == 'lucky'
            ):
                try:
                    import emby.traffic.playback as emby_playback_traffic
                    accum = emby_playback_traffic.peek_accumulated_upload(
                        instance_name, record,
                    )
                    booked = max(0, int(record.get('estimated_upload_bytes') or 0))
                    accum_val = max(0, int(accum or 0))
                    total_snapshot = booked + accum_val
                    if total_snapshot > int(
                        record.get('live_upload_checkpoint_bytes') or 0,
                    ):
                        record['live_upload_checkpoint_bytes'] = total_snapshot
                        changed = True
                    emby_playback_traffic.touch_playback_upload_keys(
                        instance_name, record,
                    )
                except Exception as e:
                    logger.debug(
                        f'[Playback:{instance_name}] 会话流量 checkpoint 同步失败: {e}',
                    )
            rid = int(record.get('id') or 0)
            seen_rids.add(rid)
            _clear_pending_stop(bucket, record)
            if sid:
                bucket[f'sid:{sid}'] = record.get('id')
            bucket[f'track:{_segment_key(record)}'] = record.get('id')

        for record in list(store.get('records') or []):
            if record.get('status') != 'playing':
                continue
            rid = int(record.get('id') or 0)
            if rid in seen_rids:
                continue
            sid = str(record.get('emby_session_id') or '')
            if sid and sid in seen_sids:
                continue

            outcome = _handle_stale_open_record(
                instance_name, bucket, record, sessions, now_mono,
            )
            if outcome in ('updated', 'finalized'):
                changed = True
                if outcome == 'finalized':
                    needs_immediate_save = True

        if changed:
            store['records'] = _trim_records(store.get('records') or [])
            _save_store(store, immediate=needs_immediate_save)
        return _wrap_return(changed, store)


def sync_upload_anomaly(instance_name: str, on_ids: list, off_ids: list) -> None:
    """把「反代未覆盖到该客户端」写进仍在播放的记录，结束后保留。"""
    name = (instance_name or '').strip()
    on = {str(item) for item in (on_ids or []) if str(item or '').strip()}
    off = {str(item) for item in (off_ids or []) if str(item or '').strip()}
    if not name or not (on or off):
        return
    with _lock:
        store = _load_store(name)
        changed = False
        for record in store.get('records') or []:
            if record.get('status') != 'playing':
                continue
            sid = str(record.get('emby_session_id') or '').strip()
            if sid in on and not record.get('upload_anomaly'):
                record['upload_anomaly'] = True
                changed = True
            elif sid in off and record.get('upload_anomaly'):
                record['upload_anomaly'] = False
                changed = True
        if changed:
            _save_store(store, immediate=True)


def list_records(instance_name: str = None, limit: int = 200,
                 days: int = None) -> List[dict]:
    limit = max(1, min(int(limit or 200), MAX_STORED_RECORDS))
    cutoff = None
    if days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=int(days))

    def _prepare(records: list) -> List[dict]:
        rows = records
        if cutoff is not None:
            rows = [r for r in rows if _record_on_or_after(r, cutoff)]
        playing = [r for r in rows if r.get('status') == 'playing']
        others = [r for r in rows if r.get('status') != 'playing']
        others.sort(key=_ended_record_sort_key, reverse=True)
        return (playing + others)[:limit]

    if instance_name:
        store = _load_store(instance_name)
        records = list(store.get('records') or [])
        for rec in records:
            rec.setdefault('instance_name', instance_name)
        return _prepare(records)

    result = []
    if not os.path.isdir(EMBY_EVENTS_DIR):
        return result
    _migrate_all_stores_once()
    for fname in os.listdir(EMBY_EVENTS_DIR):
        if not fname.endswith('.json'):
            continue
        data = _read_json(os.path.join(EMBY_EVENTS_DIR, fname), {})
        if not isinstance(data.get('records'), list):
            continue
        inst = data.get('instance_name') or ''
        for rec in data.get('records') or []:
            item = dict(rec)
            item.setdefault('instance_name', inst)
            result.append(item)
    return _prepare(result)



def delete_instance_records(instance_name: str) -> bool:
    path = _store_path(instance_name)
    with _lock:
        if not os.path.isfile(path):
            return False
        try:
            os.remove(path)
            return True
        except OSError as e:
            logger.warning(f'删除播放记录缓存失败 {path}: {e}')
            return False


def delete_user_records(instance_name: str, user_name: str) -> int:
    """从播放记录 JSON 中移除指定用户，返回删除条数。"""
    inst = (instance_name or '').strip()
    user = (user_name or '').strip()
    if not inst or not user:
        return 0
    user_fold = user.casefold()
    with _lock:
        store = _load_store(inst)
        records = list(store.get('records') or [])
        kept = []
        removed = 0
        for rec in records:
            name = str(rec.get('user_name') or '').strip()
            if name and name.casefold() == user_fold:
                removed += 1
                continue
            kept.append(rec)
        if removed <= 0:
            return 0
        store['records'] = kept
        _save_store(store, immediate=True)
        return removed


def rename_instance_records(old_name: str, new_name: str) -> None:
    if not old_name or not new_name or old_name == new_name:
        return
    with _lock:
        old_path = _store_path(old_name)
        if not os.path.isfile(old_path):
            return
        store = _load_store(old_name)
        store['instance_name'] = new_name
        for record in store.get('records') or []:
            record['instance_name'] = new_name
        _save_store(store, immediate=True)
        if old_path != _store_path(new_name):
            try:
                os.remove(old_path)
            except OSError as e:
                logger.warning(f'删除旧播放记录文件失败 {old_path}: {e}')
