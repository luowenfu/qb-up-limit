"""Emby 状态、统计、会话控制与调试接口"""

from flask import Blueprint
from flask import jsonify
from flask import request
from flask import Response
from flask import session
import re
import core.config_manager as config_manager
import emby.traffic.db as emby_traffic_db
import logging
import qb.traffic_db as traffic_db

from emby.client import DEFAULT_SESSION_MESSAGE_TIMEOUT_MS
from web import state
from web.common import emby_required, get_emby_client
from web.common import GENERIC_API_ERROR

logger = logging.getLogger(__name__)
bp = Blueprint('routes_emby', __name__)

def _emby_debug_traffic_config_payload(global_cfg: dict = None) -> dict:
    cfg = dict(global_cfg or {})
    browse_min_mb = config_manager.clamp_emby_browse_upload_min_mb(
        cfg.get('emby_browse_upload_min_mb', 1.0),
    )
    preplay_burst_mbps = config_manager.clamp_emby_preplay_burst_mbps(
        cfg.get('emby_preplay_burst_mbps', 1.5),
    )
    preplay_burst_window_seconds = (
        config_manager.clamp_emby_preplay_burst_window_seconds(
            cfg.get('emby_preplay_burst_window_seconds', 3),
        )
    )
    return {
        'preplay_burst_mbps': preplay_burst_mbps,
        'preplay_burst_window_seconds': preplay_burst_window_seconds,
        'browse_upload_min_mb': browse_min_mb,
        'browse_upload_min_bytes': config_manager.emby_browse_upload_min_bytes(
            {'emby_browse_upload_min_mb': browse_min_mb},
        ),
    }


@bp.route('/api/emby/status')
def api_emby_status():
    err = emby_required()
    if err:
        return err
    try:
        global_cfg = config_manager.get_global_config(state.emby_monitor.config)
        return jsonify({
            'success': True,
            'data': state.emby_monitor.get_status_summary(),
            'debug_traffic_config': _emby_debug_traffic_config_payload(global_cfg),
            'timestamp': traffic_db.now_local().isoformat(),
        })
    except Exception as e:
        logger.error(f'API /emby/status 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/status/live')
def api_emby_status_live():
    err = emby_required()
    if err:
        return err
    try:
        return jsonify({
            'success': True,
            'data': state.emby_monitor.get_live_status_summary(),
            'timestamp': traffic_db.now_local().isoformat(),
        })
    except Exception as e:
        logger.error(f'API /emby/status/live 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/traffic-verify')
def api_emby_traffic_verify():
    err = emby_required()
    if err:
        return err
    try:
        instance_name = (request.args.get('instance') or '').strip() or None
        return jsonify({
            'success': True,
            'data': state.emby_monitor.get_traffic_verify_summary(instance_name),
            'timestamp': traffic_db.now_local().isoformat(),
        })
    except Exception as e:
        logger.error(f'API /emby/traffic-verify 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/traffic-verify/reset', methods=['POST'])
def api_emby_traffic_verify_reset():
    err = emby_required()
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        instance_name = str(data.get('instance') or request.args.get('instance') or '').strip()
        if not instance_name:
            return jsonify({'success': False, 'error': '缺少 instance'}), 400
        state.emby_monitor.reset_traffic_verify(instance_name)
        return jsonify({'success': True, 'message': f'已重置 {instance_name} 在线验算累计'})
    except Exception as e:
        logger.error(f'API POST /emby/traffic-verify/reset 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/debug-traffic-config')
def api_emby_debug_traffic_config_get():
    err = emby_required()
    if err:
        return err
    try:
        global_cfg = config_manager.get_global_config(state.emby_monitor.config)
        return jsonify({
            'success': True,
            'data': _emby_debug_traffic_config_payload(global_cfg),
        })
    except Exception as e:
        logger.error(f'API GET /emby/debug-traffic-config 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/debug-traffic-config', methods=['PUT'])
def api_emby_debug_traffic_config_update():
    err = emby_required()
    if err:
        return err
    try:
        data = request.get_json() or {}
        if not isinstance(data, dict):
            return jsonify({'success': False, 'error': '请求无效'}), 400

        current_global = config_manager.get_global_config(state.monitor.config)
        merged_global = dict(current_global)
        if 'browse_upload_min_mb' in data:
            merged_global['emby_browse_upload_min_mb'] = data.get('browse_upload_min_mb')
        if 'preplay_burst_mbps' in data:
            merged_global['emby_preplay_burst_mbps'] = data.get(
                'preplay_burst_mbps',
            )
        if 'preplay_burst_window_seconds' in data:
            merged_global['emby_preplay_burst_window_seconds'] = data.get(
                'preplay_burst_window_seconds',
            )

        validated, full_config = config_manager.update_global(
            merged_global, base_config=state.monitor.config,
        )
        if not state.monitor.apply_config(full_config, refresh_status=False):
            return jsonify({'success': False, 'error': '配置应用失败'}), 500
        if state.emby_monitor and not state.emby_monitor.apply_config(full_config):
            return jsonify({'success': False, 'error': 'Emby 配置应用失败'}), 500

        return jsonify({
            'success': True,
            'message': '调试参数已保存并应用',
            'data': _emby_debug_traffic_config_payload(validated),
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f'API PUT /emby/debug-traffic-config 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


_POSTER_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
_POSTER_ALLOWED_MIMES = frozenset(('image/jpeg', 'image/png', 'image/webp', 'image/gif'))


@bp.route('/api/emby/poster')
def api_emby_poster():
    err = emby_required()
    if err:
        return err
    instance_name = request.args.get('instance') or ''
    item_id = request.args.get('item') or ''
    tag = request.args.get('tag') or ''
    if not _POSTER_ID_RE.fullmatch(item_id) or (tag and not _POSTER_ID_RE.fullmatch(tag)):
        return jsonify({'success': False, 'error': '无效的海报参数'}), 400
    client, client_err = get_emby_client(instance_name)
    if client_err:
        return client_err
    try:
        content, mime = client.fetch_primary_image(item_id, tag)
    except Exception as e:
        logger.error(f'API /emby/poster 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500
    if not content or mime not in _POSTER_ALLOWED_MIMES:
        return '', 404
    return Response(content, mimetype=mime, headers={
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
    })


@bp.route('/api/emby/sessions')
def api_emby_sessions():
    err = emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        rows = []
        with state.emby_monitor._config_lock:
            clients = dict(state.emby_monitor.clients)
        for name, client in clients.items():
            if instance_name and name != instance_name:
                continue
            for session in client.get_normalized_sessions():
                rows.append({
                    'instance_name': name,
                    **session,
                })
        rows.sort(key=lambda r: (r.get('instance_name', ''), r.get('user_name', '')))
        return jsonify({'success': True, 'data': rows})
    except Exception as e:
        logger.error(f'API /emby/sessions 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/stats/<instance_name>/<period>')
def api_emby_stats(instance_name, period):
    err = emby_required()
    if err:
        return err
    try:
        direction = request.args.get('direction', 'upload')
        if direction not in ('upload', 'download'):
            return jsonify({'success': False, 'error': '无效的方向参数'}), 400
        if not config_manager.get_emby_instance(instance_name, state.emby_monitor.config):
            return jsonify({'success': False, 'error': '设备不存在'}), 404

        if period == 'hourly':
            hours = min(int(request.args.get('hours', 24)), 366)
            data = emby_traffic_db.get_hourly_stats(
                instance_name, hours, direction,
                start=request.args.get('start'), end=request.args.get('end'),
            )
        elif period == 'daily':
            days = min(int(request.args.get('days', 31)), 366)
            data = emby_traffic_db.get_daily_stats(
                instance_name, days, direction,
                start=request.args.get('start'), end=request.args.get('end'),
            )
        elif period == 'weekly':
            weeks = min(int(request.args.get('weeks', 12)), 104)
            data = emby_traffic_db.get_weekly_stats(
                instance_name, weeks, direction,
                start=request.args.get('start'), end=request.args.get('end'),
            )
        elif period == 'monthly':
            months = min(int(request.args.get('months', 12)), 60)
            data = emby_traffic_db.get_monthly_stats(
                instance_name, months, direction,
                start=request.args.get('start'), end=request.args.get('end'),
            )
        elif period == 'yearly':
            years = min(int(request.args.get('years', 5)), 20)
            start_year = request.args.get('start_year')
            end_year = request.args.get('end_year')
            data = emby_traffic_db.get_yearly_stats(
                instance_name, years, direction,
                start=request.args.get('start'), end=request.args.get('end'),
                start_year=int(start_year) if start_year else None,
                end_year=int(end_year) if end_year else None,
            )
        else:
            return jsonify({'success': False, 'error': '无效的统计周期'}), 400

        return jsonify({'success': True, 'data': data})
    except Exception as e:
        logger.error(f'API /emby/stats 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/control/reset-stats', methods=['POST'])
def api_emby_control_reset_stats():
    """清空 Emby 设备流量统计，重新累计"""
    err = emby_required()
    if err:
        return err
    try:
        data = request.get_json() or {}
        instance_name = data.get('instance_name')
        if not instance_name:
            return jsonify({'success': False, 'error': '参数缺失'}), 400
        if not state.emby_monitor:
            return jsonify({'success': False, 'error': 'Emby 模块未初始化'}), 500
        state.emby_monitor.reset_traffic_stats(instance_name)
        return jsonify({
            'success': True,
            'message': '清空成功',
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f'API /emby/control/reset-stats 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/sessions/<path:instance_name>/<session_id>/playing/<command>', methods=['POST'])
def api_emby_session_playing_command(instance_name, session_id, command):
    err = emby_required()
    if err:
        return err
    command_map = {
        'pause': 'Pause',
        'unpause': 'Unpause',
        'stop': 'Stop',
    }
    emby_command = command_map.get((command or '').lower())
    if not emby_command:
        return jsonify({'success': False, 'error': '无效的控制命令'}), 400
    client, err_resp = get_emby_client(instance_name)
    if err_resp:
        return err_resp
    try:
        result = client.send_session_playing_command(session_id, emby_command)
        if not result.get('ok'):
            return jsonify({'success': False, 'error': result.get('error') or '操作失败'}), 502
        return jsonify({'success': True, 'message': '操作成功'})
    except Exception as e:
        logger.error(
            f'API /emby/sessions/{instance_name}/{session_id}/playing/{command} 错误: {e}',
            exc_info=True,
        )
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500


@bp.route('/api/emby/sessions/<path:instance_name>/<session_id>/message', methods=['POST'])
def api_emby_session_message(instance_name, session_id):
    err = emby_required()
    if err:
        return err
    client, err_resp = get_emby_client(instance_name)
    if err_resp:
        return err_resp
    try:
        data = request.get_json() or {}
        text = str(data.get('text') or '').strip()
        header = str(data.get('header') or '').strip() or None
        if 'timeout_ms' not in data:
            timeout_ms = DEFAULT_SESSION_MESSAGE_TIMEOUT_MS
        else:
            raw = data.get('timeout_ms')
            if raw is None or not str(raw).strip():
                timeout_ms = None
            else:
                timeout_ms = int(raw)
        result = client.send_session_message(
            session_id, text, header=header, timeout_ms=timeout_ms,
        )
        if not result.get('ok'):
            return jsonify({'success': False, 'error': result.get('error') or '发送失败'}), 502
        return jsonify({'success': True, 'message': '消息已发送'})
    except (TypeError, ValueError):
        return jsonify({'success': False, 'error': '参数无效'}), 400
    except Exception as e:
        logger.error(
            f'API /emby/sessions/{instance_name}/{session_id}/message 错误: {e}',
            exc_info=True,
        )
        return jsonify({'success': False, 'error': GENERIC_API_ERROR}), 500
