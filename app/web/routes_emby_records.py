"""Emby 播放与选片记录、播放用户接口"""

from flask import Blueprint
from flask import jsonify
from flask import request
import core.config_manager as config_manager
import emby.records.store as playback_record_store
import emby.traffic.db as emby_traffic_db
import emby.user_sync as emby_user_sync
import logging
import threading
import time

from datetime import timedelta
from core.cycle import iter_cycle_periods
from core.syslog_localize import localize_system_log_entry
from emby.client import EmbyClient
from emby.client import is_playback_browse_server_log_message
from emby.client import parse_emby_log_line
from web import state
from web.common import emby_required, get_emby_client
from web.common import GENERIC_API_ERROR

logger = logging.getLogger(__name__)
bp = Blueprint('routes_emby_records', __name__)

_item_meta_cache = {}
_item_meta_lock = threading.Lock()


def _record_in_span(started_at: str, period: str, start: str, end: str) -> bool:
    text = str(started_at or '')
    if not text:
        return False
    if period == 'hourly':
        return text[:10] == str(start or '')[:10]
    start_s = str(start or '')
    end_s = str(end or '')
    if not start_s or not end_s:
        return False
    return text[:len(start_s)] >= start_s and text[:len(end_s)] <= end_s


def _sorted_users(users: dict) -> list:
    """同一用户只留最近一次播放，新的排在前面，时间相同再按用户名。"""
    names = sorted(users, key=lambda name: name.casefold())
    names.sort(key=lambda name: users.get(name) or '', reverse=True)
    return names


def _top_films(films: dict, limit: int = 10) -> list:
    rows = sorted(
        films.items(),
        key=lambda item: (-item[1]['count'], item[0].casefold()),
    )
    out = []
    for name, info in rows[:limit]:
        if info['count'] <= 0:
            continue
        out.append({
            'name': name,
            'count': info['count'],
            'kind': info['kind'],
            'users': _sorted_users(info.get('users') or {}),
        })
    return out


def _genre_films(bucket: dict, films: dict, limit: int = 10) -> list:
    rows = sorted(
        bucket.items(),
        key=lambda item: (-item[1]['count'], item[0].casefold()),
    )
    out = []
    for name, info in rows[:limit]:
        if info['count'] <= 0:
            continue
        times = (films.get(name) or {}).get('users') or {}
        watched = info.get('users') or set()
        out.append({
            'name': name,
            'count': len(watched),
            'kind': info['kind'],
            'users': _sorted_users({user: times.get(user, '') for user in watched}),
        })
    return out


def _top_genres(genres: dict, genre_films: dict, films: dict, limit: int = 10) -> list:
    rows = sorted(genres.items(), key=lambda item: (-item[1], item[0].casefold()))
    out = []
    for name, count in rows[:limit]:
        if count <= 0:
            continue
        out.append({
            'name': name,
            'count': count,
            'films': _genre_films(genre_films.get(name) or {}, films),
        })
    return out


def _film_bucket(films: dict, name: str, kind: str) -> dict:
    info = films.get(name)
    if info is None:
        info = {'count': 0, 'kind': kind, 'users': {}}
        films[name] = info
    if kind == 'series':
        info['kind'] = 'series'
    return info


def _touch_user(info: dict, user_name: str, started_at: str) -> None:
    user = str(user_name or '').strip()
    if not user:
        return
    started = str(started_at or '')
    prev = info['users'].get(user)
    if prev is None or started > prev:
        info['users'][user] = started


_SERIES_ITEM_TYPES = {'Episode', 'Series', 'Season'}


def _play_kind(record: dict, series: str) -> str:
    if series or str(record.get('item_type') or '').strip() in _SERIES_ITEM_TYPES:
        return 'series'
    return 'movie'


def _meta_from_item(item: dict) -> dict:
    raw = item.get('Genres') or []
    if isinstance(raw, str):
        raw = [raw]
    genres = []
    for genre in raw:
        if isinstance(genre, dict):
            name = str(genre.get('Name') or '').strip()
        else:
            name = str(genre or '').strip()
        if name and name not in genres:
            genres.append(name)
    return {
        'genres': genres,
        'series_id': str(item.get('SeriesId') or '').strip(),
        'type': str(item.get('Type') or '').strip(),
    }


def _cached_meta(instance_name: str, item_id: str):
    with _item_meta_lock:
        return _item_meta_cache.get((instance_name, item_id))


def _store_meta(instance_name: str, item_id: str, meta: dict) -> None:
    with _item_meta_lock:
        _item_meta_cache[(instance_name, item_id)] = meta


def _ensure_item_meta(client, instance_name: str, item_ids) -> bool:
    missing = []
    seen = set()
    for raw in item_ids:
        item_id = str(raw or '').strip()
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        if _cached_meta(instance_name, item_id) is None:
            missing.append(item_id)
    if not missing:
        return True
    items = client.get_items_by_ids(missing)
    if items is None:
        return False
    found = set()
    for item in items:
        item_id = str(item.get('Id') or '').strip()
        if not item_id:
            continue
        found.add(item_id)
        _store_meta(instance_name, item_id, _meta_from_item(item))
    for item_id in missing:
        if item_id not in found:
            _store_meta(instance_name, item_id, {'genres': [], 'series_id': '', 'type': ''})
    return True


def _genres_for_series_name(client, instance_name: str, series_name: str) -> list:
    """没有条目编号的历史剧集，按剧名向 Emby 查一次类型。"""
    series = str(series_name or '').strip()
    if not series:
        return []
    cache_key = 'series-name:' + series.casefold()
    cached = _cached_meta(instance_name, cache_key)
    if cached is not None:
        return list(cached.get('genres') or [])
    if client is None:
        return []
    item = client.lookup_series_by_name(series)
    if item is None:
        return None
    meta = _meta_from_item(item) if item else {'genres': [], 'series_id': '', 'type': 'Series'}
    meta['type'] = meta.get('type') or 'Series'
    _store_meta(instance_name, cache_key, meta)
    return list(meta.get('genres') or [])


def _genres_for_play(instance_name: str, item_id: str) -> list:
    meta = _cached_meta(instance_name, item_id)
    if not meta:
        return []
    if meta.get('type') == 'Episode' and meta.get('series_id'):
        series = _cached_meta(instance_name, meta['series_id'])
        if series and series.get('genres'):
            return list(series['genres'])
    return list(meta.get('genres') or [])


def build_content_rank(instance_name: str, records: list, period: str,
                        start: str, end: str, user_name: str, client) -> dict:
    all_users = (
        not user_name
        or user_name == emby_traffic_db.PLAYBACK_ALL_USERS_TOKEN
    )
    plays = []
    seen_titles = set()
    films = {}
    play_count = 0
    for rec in records:
        if not all_users and str(rec.get('user_name') or '') != user_name:
            continue
        if not _record_in_span(rec.get('started_at'), period, start, end):
            continue
        play_count += 1
        user = str(rec.get('user_name') or '').strip()
        started = str(rec.get('started_at') or '')
        series = str(rec.get('series_name') or '').strip()
        item_id = str(rec.get('item_id') or '').strip()
        if not user:
            continue
        if series:
            name, kind, series_key = series, 'series', series
        else:
            name = str(rec.get('item_title') or '').strip()
            if not name:
                continue
            kind, series_key = _play_kind(rec, ''), ''
        info = _film_bucket(films, name, kind)
        _touch_user(info, user, started)
        # 同一用户看同一部电影或同一部剧的不同集，只算一次人次
        key = (user, name)
        if key in seen_titles:
            continue
        seen_titles.add(key)
        info['count'] += 1
        plays.append((name, item_id, series_key, kind, user))
    genre_error = False
    genres = {}
    genre_films = {}
    item_ids = [item_id for _name, item_id, _series, _kind, _user in plays if item_id]
    if item_ids:
        if client is None or not _ensure_item_meta(client, instance_name, item_ids):
            genre_error = True
        else:
            series_ids = []
            for item_id in item_ids:
                meta = _cached_meta(instance_name, item_id) or {}
                if meta.get('type') == 'Episode' and meta.get('series_id'):
                    series_ids.append(meta['series_id'])
            series_ok = (
                _ensure_item_meta(client, instance_name, series_ids)
                if series_ids else True
            )
            if not series_ok:
                genre_error = True
    if not genre_error:
        for _name, item_id, series, _kind, _user in plays:
            found = None
            if item_id:
                found = _genres_for_play(instance_name, item_id)
            elif series:
                if client is None:
                    genre_error = True
                    break
                found = _genres_for_series_name(client, instance_name, series)
                if found is None:
                    genre_error = True
                    break
            for genre in found or []:
                genres[genre] = genres.get(genre, 0) + 1
                bucket = genre_films.setdefault(genre, {})
                info = bucket.get(_name)
                if info is None:
                    info = {'count': 0, 'kind': _kind, 'users': set()}
                    bucket[_name] = info
                if _user not in info['users']:
                    info['users'].add(_user)
                    info['count'] += 1
                if _kind == 'series':
                    info['kind'] = 'series'
    return {
        'films': _top_films(films),
        'genres': [] if genre_error else _top_genres(genres, genre_films, films),
        'genre_error': genre_error,
        'truncated': False,
        'play_count': play_count,
    }

def _optional_query_days():
    """可选 days：1~365。未传时返回 None，调用方保持原查询。"""
    raw = request.args.get('days', None)
    if raw is None or str(raw).strip() == '':
        return None
    days = int(str(raw).strip())
    return min(365, max(1, days))


@bp.route('/api/emby/playback-records')
def api_emby_playback_records():
    err = emby_required()
    if err:
        return err
    try:
        import emby.records.store as playback_record_store
        instance_name = request.args.get('instance')
        days = _optional_query_days()
        limit = min(int(request.args.get('limit', 200)), playback_record_store.MAX_STORED_RECORDS)
        if instance_name:
            inst = config_manager.get_emby_instance(instance_name, state.emby_monitor.config)
            if not inst:
                return jsonify({'success': False, 'error': '设备不存在'}), 404
            records = playback_record_store.list_records(
                instance_name, limit=limit, days=days,
            )
        else:
            records = playback_record_store.list_records(limit=limit, days=days)
        return jsonify({'success': True, 'data': records})
    except Exception as e:
        logger.error(f'API /emby/playback-records 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/browse-records')
def api_emby_browse_records():
    err = emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        if not instance_name:
            return jsonify({'success': False, 'error': '请选择设备'}), 400
        if not config_manager.get_emby_instance(instance_name, state.emby_monitor.config):
            return jsonify({'success': False, 'error': '设备不存在'}), 404
        days = _optional_query_days()
        limit = min(int(request.args.get('limit', 200)), 5000)
        since = None
        if days is not None:
            since = (emby_traffic_db._now() - timedelta(days=days)).strftime(
                '%Y-%m-%d %H:%M:%S',
            )
        global_cfg = config_manager.get_global_config(state.emby_monitor.config)
        min_bytes = config_manager.emby_browse_upload_min_bytes(global_cfg)
        min_mb = config_manager.clamp_emby_browse_upload_min_mb(
            global_cfg.get('emby_browse_upload_min_mb', 1.0),
        )
        records = emby_traffic_db.list_browse_upload_records(
            instance_name, limit=limit, min_upload_bytes=min_bytes, since=since,
        )
        return jsonify({
            'success': True,
            'data': records,
            'browse_upload_min_mb': min_mb,
            'browse_upload_min_bytes': min_bytes,
        })
    except Exception as e:
        logger.error(f'API /emby/browse-records 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/activity-log')
def api_emby_activity_log():
    err = emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        if not instance_name:
            return jsonify({'success': False, 'error': '请选择设备'}), 400
        inst = config_manager.get_emby_instance(instance_name, state.emby_monitor.config)
        if not inst:
            return jsonify({'success': False, 'error': '设备不存在'}), 404

        limit = min(int(request.args.get('limit', 200)), 500)
        client = EmbyClient(inst)
        sessions = client.get_sessions() or []
        item_cache = {}
        item_fetch_state = {'count': 0}
        deadline = time.monotonic() + 20.0
        events = []
        for entry in client.get_activity_log(limit=limit):
            enrichment = EmbyClient.enrich_activity_entry(
                client, entry, item_cache, sessions,
                max_item_fetches=48,
                item_fetch_state=item_fetch_state,
                deadline_mono=deadline,
            )
            events.append(EmbyClient.normalize_activity_entry(
                entry, instance_name, enrichment,
            ))
        return jsonify({'success': True, 'data': events})
    except Exception as e:
        logger.error(f'API /emby/activity-log 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/playback-users')
def api_emby_playback_users():
    err = emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        if not instance_name:
            return jsonify({'success': False, 'error': '缺少 instance 参数'}), 400
        if not config_manager.get_emby_instance(instance_name, state.emby_monitor.config):
            return jsonify({'success': False, 'error': '设备不存在'}), 404
        client, err_resp = get_emby_client(instance_name)
        if err_resp:
            return err_resp
        emby_user_sync.sync_deleted_users(instance_name, client, force=True)
        users, source = emby_user_sync.list_instance_user_names(client, instance_name)
        return jsonify({'success': True, 'data': users, 'source': source})
    except Exception as e:
        logger.error(f'API /emby/playback-users 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/playback-stats/<instance_name>/<period>')
def api_emby_playback_stats(instance_name, period):
    err = emby_required()
    if err:
        return err
    try:
        user_name = (request.args.get('user') or '').strip()
        if not user_name:
            return jsonify({'success': False, 'error': '缺少 user 参数'}), 400
        inst = config_manager.get_emby_instance(instance_name, state.emby_monitor.config)
        if not inst:
            return jsonify({'success': False, 'error': '设备不存在'}), 404
        all_users = user_name == emby_traffic_db.PLAYBACK_ALL_USERS_TOKEN
        import emby.browse.stats as browse_stats
        credit_browse = browse_stats.resolve_instance_credit_browse(inst)
        browse_kw = {'credit_browse': credit_browse}
        if period == 'hourly':
            hours = min(int(request.args.get('hours', 24)), 366)
            if all_users:
                data = browse_stats.get_combined_playback_upload_hourly_stats_all_users(
                    instance_name, hours=hours,
                    start=request.args.get('start'), end=request.args.get('end'),
                    **browse_kw,
                )
            else:
                data = browse_stats.get_combined_playback_upload_hourly_stats(
                    instance_name, user_name, hours=hours,
                    start=request.args.get('start'), end=request.args.get('end'),
                    **browse_kw,
                )
        elif period == 'daily':
            days = min(int(request.args.get('days', 31)), 366)
            if all_users:
                data = browse_stats.get_combined_playback_upload_daily_stats_all_users(
                    instance_name, days=days,
                    start=request.args.get('start'), end=request.args.get('end'),
                    **browse_kw,
                )
            else:
                data = browse_stats.get_combined_playback_upload_daily_stats(
                    instance_name, user_name, days=days,
                    start=request.args.get('start'), end=request.args.get('end'),
                    **browse_kw,
                )
        elif period == 'monthly':
            months = min(int(request.args.get('months', 12)), 60)
            if all_users:
                data = browse_stats.get_combined_playback_upload_monthly_stats_all_users(
                    instance_name, months=months,
                    start=request.args.get('start'), end=request.args.get('end'),
                    **browse_kw,
                )
            else:
                data = browse_stats.get_combined_playback_upload_monthly_stats(
                    instance_name, user_name, months=months,
                    start=request.args.get('start'), end=request.args.get('end'),
                    **browse_kw,
                )
        elif period == 'weekly':
            weeks = min(int(request.args.get('weeks', 12)), 104)
            if all_users:
                data = browse_stats.get_combined_playback_upload_weekly_stats_all_users(
                    instance_name, weeks=weeks,
                    start=request.args.get('start'), end=request.args.get('end'),
                    **browse_kw,
                )
            else:
                data = browse_stats.get_combined_playback_upload_weekly_stats(
                    instance_name, user_name, weeks=weeks,
                    start=request.args.get('start'), end=request.args.get('end'),
                    **browse_kw,
                )
        elif period == 'yearly':
            years = min(int(request.args.get('years', 5)), 20)
            start_year = request.args.get('start_year')
            end_year = request.args.get('end_year')
            if all_users:
                data = browse_stats.get_combined_playback_upload_yearly_stats_all_users(
                    instance_name, years=years,
                    start=request.args.get('start'), end=request.args.get('end'),
                    start_year=int(start_year) if start_year else None,
                    end_year=int(end_year) if end_year else None,
                    **browse_kw,
                )
            else:
                data = browse_stats.get_combined_playback_upload_yearly_stats(
                    instance_name, user_name, years=years,
                    start=request.args.get('start'), end=request.args.get('end'),
                    start_year=int(start_year) if start_year else None,
                    end_year=int(end_year) if end_year else None,
                    **browse_kw,
                )
        elif period == 'cycle':
            from core.config_manager import DEFAULT_CYCLE, get_global_config
            from core.cycle import iter_cycle_periods
            from zoneinfo import ZoneInfo
            tz_name = get_global_config(state.emby_monitor.config).get(
                'timezone', 'Asia/Shanghai',
            )
            try:
                tz = ZoneInfo(tz_name)
            except Exception:
                tz = ZoneInfo('Asia/Shanghai')
            count = min(int(request.args.get('cycles', 12)), 50)
            periods = iter_cycle_periods(DEFAULT_CYCLE, tz, count=count)
            if all_users:
                data = browse_stats.get_combined_playback_upload_cycle_stats_all_users(
                    instance_name, periods, **browse_kw,
                )
            else:
                data = browse_stats.get_combined_playback_upload_cycle_stats(
                    instance_name, user_name, periods, **browse_kw,
                )
        else:
            return jsonify({'success': False, 'error': '播放用户统计暂不支持该周期'}), 400
        return jsonify({'success': True, 'data': data})
    except Exception as e:
        logger.error(f'API /emby/playback-stats 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/system-logs/files')
def api_emby_system_log_files():
    err = emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        if not instance_name:
            return jsonify({'success': False, 'error': '请选择设备'}), 400
        inst = config_manager.get_emby_instance(instance_name, state.emby_monitor.config)
        if not inst:
            return jsonify({'success': False, 'error': '设备不存在'}), 404

        client = EmbyClient(inst)
        files = []
        for item in client.list_server_logs():
            name = item.get('Name') or item.get('Id') or ''
            if not name:
                continue
            files.append({
                'name': name,
                'modified': item.get('DateModified') or item.get('DateCreated') or '',
                'size': item.get('Size') or 0,
            })
        return jsonify({'success': True, 'data': files})
    except Exception as e:
        logger.error(f'API /emby/system-logs/files 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/system-logs')
def api_emby_system_logs():
    err = emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        log_name = (request.args.get('log_name') or '').strip()
        level_filter = (request.args.get('level') or '').strip().upper()
        limit = min(int(request.args.get('limit', 500)), 1000)
        if not instance_name:
            return jsonify({'success': False, 'error': '请选择设备'}), 400
        inst = config_manager.get_emby_instance(instance_name, state.emby_monitor.config)
        if not inst:
            return jsonify({'success': False, 'error': '设备不存在'}), 404

        client = EmbyClient(inst)
        log_items = client.list_server_logs()
        target_names = []
        if log_name:
            target_names = [log_name]
        else:
            for item in log_items[:5]:
                name = item.get('Name') or item.get('Id') or ''
                if name:
                    target_names.append(name)

        lines = []
        for name in target_names:
            for line in client.get_server_log_lines(name, limit=limit):
                parsed = parse_emby_log_line(line)
                message = parsed.get('message') or parsed.get('raw') or line
                if is_playback_browse_server_log_message(message):
                    continue
                if level_filter and parsed.get('level') != level_filter:
                    continue
                lines.append(localize_system_log_entry({
                    'log_name': name,
                    'time': parsed.get('time') or '',
                    'level': parsed.get('level') or 'INFO',
                    'logger': parsed.get('logger') or '',
                    'message': parsed.get('message') or parsed.get('raw') or '',
                    'line': parsed.get('raw') or line,
                }))
        return jsonify({'success': True, 'data': lines[:limit]})
    except Exception as e:
        logger.error(f'API /emby/system-logs 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/content-rank')
def api_emby_content_rank():
    """所选时段内的影片与类型播放次数。类型向 Emby 查询。"""
    err = emby_required()
    if err:
        return err
    try:
        instance_name = (request.args.get('instance') or '').strip()
        if not instance_name:
            return jsonify({'success': False, 'error': '缺少 instance 参数'}), 400
        if not config_manager.get_emby_instance(instance_name, state.emby_monitor.config):
            return jsonify({'success': False, 'error': '设备不存在'}), 404
        client, err_resp = get_emby_client(instance_name)
        if err_resp:
            client = None
        records = emby_traffic_db.list_content_plays(
            instance_name,
            (request.args.get('period') or '').strip(),
            request.args.get('start') or '',
            request.args.get('end') or '',
            (request.args.get('user') or '').strip(),
        )
        data = build_content_rank(
            instance_name,
            records,
            (request.args.get('period') or '').strip(),
            request.args.get('start') or '',
            request.args.get('end') or '',
            (request.args.get('user') or '').strip(),
            client,
        )
        return jsonify({'success': True, 'data': data})
    except Exception as e:
        logger.error(f'API /emby/content-rank 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/playback-film-ranks')
def api_emby_playback_film_ranks():
    """所选时段内每个用户的播放上行，按影片汇总。不含选片。"""
    err = emby_required()
    if err:
        return err
    try:
        instance_name = (request.args.get('instance') or '').strip()
        if not instance_name:
            return jsonify({'success': False, 'error': '缺少 instance 参数'}), 400
        if not config_manager.get_emby_instance(instance_name, state.emby_monitor.config):
            return jsonify({'success': False, 'error': '设备不存在'}), 404
        data = emby_traffic_db.playback_film_ranks(
            instance_name,
            (request.args.get('period') or '').strip(),
            request.args.get('start') or '',
            request.args.get('end') or '',
        )
        return jsonify({'success': True, 'data': data})
    except Exception as e:
        logger.error(f'API /emby/playback-film-ranks 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500
