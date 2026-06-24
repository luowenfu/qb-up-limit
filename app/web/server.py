from flask import Flask, render_template, jsonify, request, session
from flask_cors import CORS
import logging
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import traffic_db
import emby_traffic_db
import playback_record_store
import config_manager
from scheduler import clamp_interval
from log_reader import get_system_logs
from cycle import iter_cycle_periods
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

from qb_monitor import (
    run_connection_test,
    run_speed_limit_test,
    estimate_test_timeout,
)
from web.auth import init_auth, login_user, logout_user, verify_credentials, get_session_username

from emby_client import EmbyClient, parse_emby_log_line, DEFAULT_SESSION_MESSAGE_TIMEOUT_MS

logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, supports_credentials=True)

@app.after_request
def add_no_cache_headers(response):
    if request.path.startswith('/static/'):
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response

monitor = None
emby_monitor = None


def init_web_server(traffic_monitor, emby_traffic_monitor=None):
    global monitor, emby_monitor
    monitor = traffic_monitor
    emby_monitor = emby_traffic_monitor

    init_auth(app)


def _reload_all_config(skip_qb_ops: bool = False):
    try:
        monitor.reload_config(refresh_status=False, skip_qb_ops=skip_qb_ops)
    except Exception as e:
        logger.error(f"qB 配置重载失败: {e}", exc_info=True)
    if emby_monitor:
        try:
            emby_monitor.reload_config()
        except Exception as e:
            logger.error(f"Emby 配置重载失败: {e}", exc_info=True)


@app.route('/login')
def login_page():
    from flask import redirect
    if session.get('authenticated'):
        return redirect('/')
    return render_template('login.html')


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/auth/login', methods=['POST'])
def api_auth_login():
    try:
        data = request.get_json() or {}
        username = str(data.get('username', '')).strip()
        password = data.get('password', '')
        if not verify_credentials(username, password):
            return jsonify({'success': False, 'error': '账号或密码错误'}), 401
        remember = bool(data.get('remember'))
        login_user(username, remember=remember)
        return jsonify({'success': True, 'username': username})
    except Exception as e:
        logger.error(f"API /auth/login 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/auth/logout', methods=['POST'])
def api_auth_logout():
    logout_user()
    return jsonify({'success': True})


@app.route('/api/auth/check')
def api_auth_check():
    return jsonify({
        'success': True,
        'authenticated': bool(session.get('authenticated')),
        'username': session.get('username', '')
    })


@app.route('/api/status')
def api_status():
    try:
        status = monitor.get_status_summary()
        return jsonify({
            'success': True,
            'data': status,
            'timestamp': traffic_db.now_local().isoformat()
        })
    except Exception as e:
        logger.error(f"API /status 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/status/live')
def api_status_live():
    try:
        status = monitor.get_live_status_summary()
        return jsonify({
            'success': True,
            'data': status,
            'timestamp': traffic_db.now_local().isoformat()
        })
    except Exception as e:
        logger.error(f"API /status/live 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/stats/<instance_name>/<period>')
def api_stats(instance_name, period):
    try:
        direction = request.args.get('direction', 'upload')
        if direction not in ('upload', 'download'):
            return jsonify({'success': False, 'error': '无效的方向参数'}), 400

        if period == 'hourly':
            hours = min(int(request.args.get('hours', 24)), 366)
            start = request.args.get('start')
            end = request.args.get('end')
            data = traffic_db.get_hourly_stats(
                instance_name, hours, direction, start=start, end=end,
            )
        elif period == 'daily':
            days = min(int(request.args.get('days', 31)), 366)
            start = request.args.get('start')
            end = request.args.get('end')
            data = traffic_db.get_daily_stats(
                instance_name, days, direction, start=start, end=end,
            )
        elif period == 'weekly':
            weeks = min(int(request.args.get('weeks', 16)), 53)
            start = request.args.get('start')
            end = request.args.get('end')
            data = traffic_db.get_weekly_stats(
                instance_name, weeks, direction, start=start, end=end,
            )
        elif period == 'monthly':
            months = min(int(request.args.get('months', 12)), 60)
            start = request.args.get('start')
            end = request.args.get('end')
            data = traffic_db.get_monthly_stats(instance_name, months, direction, start=start, end=end)
        elif period == 'yearly':
            years = min(int(request.args.get('years', 10)), 24)
            start_year_raw = request.args.get('start_year')
            end_year_raw = request.args.get('end_year')
            try:
                start_year = int(start_year_raw) if start_year_raw else None
                end_year = int(end_year_raw) if end_year_raw else None
            except (ValueError, TypeError):
                start_year = end_year = None
            data = traffic_db.get_yearly_stats(
                instance_name, years, direction,
                start_year=start_year, end_year=end_year,
            )
        elif period == 'cycle':
            inst = config_manager.get_instance(instance_name, monitor.config)
            if not inst:
                return jsonify({'success': False, 'error': '设备不存在'}), 404
            cycle_cfg = inst.get('cycle', {})
            tz_name = config_manager.get_global_config(monitor.config).get(
                'timezone', 'Asia/Shanghai'
            )
            from zoneinfo import ZoneInfo
            try:
                tz = ZoneInfo(tz_name)
            except Exception:
                tz = ZoneInfo('Asia/Shanghai')
            count = min(int(request.args.get('cycles', 12)), 50)
            periods = iter_cycle_periods(cycle_cfg, tz, count=count)
            data = traffic_db.get_cycle_stats(instance_name, periods, direction)
        else:
            return jsonify({'success': False, 'error': '无效的period参数'}), 400
        
        return jsonify({
            'success': True,
            'period': period,
            'direction': direction,
            'data': data
        })
    except Exception as e:
        logger.error(f"API /stats 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/events')
def api_events():
    try:
        instance_name = request.args.get('instance')
        limit = min(int(request.args.get('limit', 500)), 500)
        events = traffic_db.get_device_events(instance_name, limit)
        return jsonify({'success': True, 'data': events})
    except Exception as e:
        logger.error(f"API /events 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/system-logs')
def api_system_logs():
    try:
        level = request.args.get('level')
        instance = (request.args.get('instance') or '').strip() or None
        service = (request.args.get('service') or '').strip().lower() or None
        limit = min(int(request.args.get('limit', 1000)), 1000)
        logs = get_system_logs(limit=limit, level=level, instance=instance, service=service)
        return jsonify({'success': True, 'data': logs})
    except Exception as e:
        logger.error(f"API /system-logs 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/control/limit', methods=['POST'])
def api_control_limit():
    try:
        data = request.get_json()
        instance_name = data.get('instance_name')

        if not instance_name:
            return jsonify({'success': False, 'error': '参数缺失'}), 400

        limit_kbps = config_manager._validate_upload_limit_kbps(
            data.get('limit_kbps', 0), '限速')

        success = monitor.manual_set_limit(instance_name, limit_kbps)
        
        if success:
            return jsonify({
                'success': True,
                'message': '设置成功' if limit_kbps > 0 else '解除成功'
            })
        return jsonify({'success': False, 'error': '设置失败'}), 500
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"API /control/limit 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/control/speed-limits-mode', methods=['POST'])
def api_control_speed_limits_mode():
    """切换 qB 全局/备用限速模式"""
    try:
        data = request.get_json() or {}
        instance_name = data.get('instance_name')
        if not instance_name:
            return jsonify({'success': False, 'error': '参数缺失'}), 400
        if 'use_alt' not in data:
            return jsonify({'success': False, 'error': '缺少 use_alt 参数'}), 400
        use_alt = bool(data.get('use_alt'))
        with monitor._config_lock:
            if instance_name not in monitor.clients:
                return jsonify({'success': False, 'error': '设备不存在'}), 404
        success = monitor.manual_set_speed_limits_mode(instance_name, use_alt)
        if success:
            mode_label = '备用' if use_alt else '全局'
            return jsonify({
                'success': True,
                'message': f'已切换为{mode_label}限速模式',
            })
        return jsonify({'success': False, 'error': '切换失败'}), 500
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"API /control/speed-limits-mode 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/control/reset', methods=['POST'])
def api_control_reset():
    """解除限速，不清空流量统计"""
    try:
        data = request.get_json() or {}
        instance_name = data.get('instance_name')
        if not instance_name:
            return jsonify({'success': False, 'error': '参数缺失'}), 400
        with monitor._config_lock:
            if instance_name not in monitor.clients:
                return jsonify({'success': False, 'error': '设备不存在'}), 404
            client = monitor.clients[instance_name]
            if not client.allow_manual_unlimit:
                return jsonify({
                    'success': False,
                    'error': '该设备已禁用程序手动解除限速'
                }), 400
        monitor.manual_reset(instance_name)
        return jsonify({
            'success': True,
            'message': '解除成功'
        })
    except Exception as e:
        logger.error(f"API /control/reset 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/control/reset-stats', methods=['POST'])
def api_control_reset_stats():
    """清空流量统计，重新统计"""
    try:
        data = request.get_json()
        instance_name = data.get('instance_name')
        if not instance_name:
            return jsonify({'success': False, 'error': '参数缺失'}), 400
        monitor.reset_traffic_stats(instance_name)
        return jsonify({
            'success': True,
            'message': '清空成功'
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"API /control/reset-stats 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/instances')
def api_instances():
    try:
        names = monitor.get_client_names()
        return jsonify({'success': True, 'data': names})
    except Exception as e:
        logger.error(f"API /instances 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config')
def api_config():
    try:
        global_cfg = config_manager.mask_global_for_api(
            config_manager.get_global_config(monitor.config),
            monitor.config,
        )
        collect = global_cfg['collect_interval']
        refresh = global_cfg.get('refresh_interval', 1)
        return jsonify({
            'success': True,
            'global': global_cfg,
            'collect_interval': collect,
            'refresh_interval': refresh,
            'dual_tier': True,
        })
    except Exception as e:
        logger.error(f"API /config 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config/instances', methods=['GET'])
def api_config_instances_list():
    try:
        instances = config_manager.get_instances(monitor.config)
        masked = [config_manager.mask_instance_for_api(i) for i in instances]
        return jsonify({'success': True, 'data': masked})
    except Exception as e:
        logger.error(f"API GET /config/instances 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config/instances/<name>', methods=['GET'])
def api_config_instance_get(name):
    try:
        inst = config_manager.get_instance(name, monitor.config)
        if not inst:
            return jsonify({'success': False, 'error': '设备不存在'}), 404
        return jsonify({
            'success': True,
            'data': config_manager.mask_instance_for_api(inst)
        })
    except Exception as e:
        logger.error(f"API GET /config/instances/{name} 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


def _defer_instance_sync(instance_name: str) -> None:
    """后台同步，避免保存 API 被长连接重试阻塞"""
    def _run():
        try:
            monitor.sync_instance_after_save(
                instance_name,
                connection_changed=True,
                force_attempt=True,
            )
        except Exception as e:
            logger.error(
                f"后台同步设备 {instance_name} 失败: {e}", exc_info=True)

    threading.Thread(
        target=_run, name=f'sync-after-save-{instance_name}', daemon=True,
    ).start()


def _apply_config_after_save(skip_qb_ops: bool = False,
                             sync_instance: str = None,
                             defer_reload: bool = False) -> None:
    """保存后重载内存配置；纯本地项可延后 reload，避免 HTTP 被采集线程阻塞"""
    def _reload():
        _reload_all_config(skip_qb_ops=skip_qb_ops)

    if defer_reload:
        threading.Thread(
            target=_reload, name='reload-after-save', daemon=True,
        ).start()
    else:
        _reload()

    if not sync_instance:
        return

    def _run():
        try:
            monitor.sync_instance_after_save(
                sync_instance,
                connection_changed=True,
                force_attempt=True,
            )
        except Exception as e:
            logger.error(
                f"后台同步设备 {sync_instance} 失败: {e}", exc_info=True)

    threading.Thread(
        target=_run, name=f'sync-after-save-{sync_instance}', daemon=True,
    ).start()


def _run_instance_test(validated: dict, test_type: str) -> dict:
    """在独立线程中执行测试，避免连接挂起导致请求永不返回"""
    if test_type == 'connect':
        runner = run_connection_test
    elif test_type == 'limit':
        runner = run_speed_limit_test
    else:
        raise ValueError('无效的 test_type，应为 connect 或 limit')

    timeout_sec = estimate_test_timeout(validated, test_type)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(runner, validated)
        try:
            return future.result(timeout=timeout_sec)
        except FuturesTimeoutError:
            return {
                'success': False,
                'error': '测试超时',
                'steps': [],
            }


def _fresh_active_instance_names() -> list:
    """从配置文件实时读取当前设备名称，避免内存配置滞后"""
    return config_manager.get_active_instance_names(config_manager.load_config())


def _fresh_active_emby_instance_names() -> list:
    return config_manager.get_active_emby_instance_names(config_manager.load_config())


def _no_cache_json(payload, status=200):
    response = jsonify(payload)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    return response


def _require_orphan_data_policy(has_orphan: bool, data_policy: str, add_mode: bool = True):
    if not has_orphan:
        return
    valid = ('restore', 'fresh') if add_mode else ('restore_orphan', 'keep_current')
    if data_policy not in valid:
        if add_mode:
            raise ValueError('检测到该名称存在历史数据，请选择恢复设备或新建设备')
        raise ValueError('检测到该名称存在历史数据，请选择恢复为旧数据或保持现有数据')


def _apply_add_data_policy(target_name: str, data_policy: str, active_names: list):
    if not traffic_db.is_orphaned_instance(target_name, active_names):
        return
    _require_orphan_data_policy(True, data_policy, add_mode=True)
    if data_policy == 'fresh':
        traffic_db.delete_instance_data(target_name)


def _apply_rename_data_policy(old_name: str, new_name: str,
                              data_policy: str, active_names: list):
    if old_name == new_name:
        return
    if not traffic_db.is_orphaned_instance(new_name, active_names):
        traffic_db.rename_instance_data(old_name, new_name)
        return
    _require_orphan_data_policy(True, data_policy, add_mode=False)
    if data_policy == 'restore_orphan':
        traffic_db.delete_instance_data(old_name)
    elif data_policy == 'keep_current':
        traffic_db.delete_instance_data(new_name)
        traffic_db.rename_instance_data(old_name, new_name)


def _apply_emby_add_data_policy(target_name: str, data_policy: str, active_names: list):
    if not emby_traffic_db.is_orphaned_instance(target_name, active_names):
        return
    _require_orphan_data_policy(True, data_policy, add_mode=True)
    if data_policy == 'fresh':
        emby_traffic_db.delete_instance_data(target_name)
        playback_record_store.delete_instance_records(target_name)

def _apply_emby_rename_data_policy(old_name: str, new_name: str,
                                   data_policy: str, active_names: list):
    if old_name == new_name:
        return
    if not emby_traffic_db.is_orphaned_instance(new_name, active_names):
        emby_traffic_db.rename_instance_data(old_name, new_name)
        playback_record_store.rename_instance_records(old_name, new_name)
        return
    _require_orphan_data_policy(True, data_policy, add_mode=False)
    if data_policy == 'restore_orphan':
        emby_traffic_db.delete_instance_data(old_name)
        playback_record_store.delete_instance_records(old_name)
    elif data_policy == 'keep_current':
        emby_traffic_db.delete_instance_data(new_name)
        playback_record_store.delete_instance_records(new_name)
        emby_traffic_db.rename_instance_data(old_name, new_name)
        playback_record_store.rename_instance_records(old_name, new_name)


@app.route('/api/config/instances/orphan-check', methods=['GET'])
def api_config_instance_orphan_check():
    try:
        name = str(request.args.get('name', '')).strip()
        if not name:
            return jsonify({'success': False, 'error': '参数缺失'}), 400
        active_names = _fresh_active_instance_names()
        has_orphan = traffic_db.is_orphaned_instance(name, active_names)
        return _no_cache_json({
            'success': True,
            'has_orphaned_data': has_orphan,
            'name': name,
        })
    except Exception as e:
        logger.error(f"API GET /config/instances/orphan-check 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config/instances/orphan-data', methods=['GET'])
def api_config_instance_orphan_data():
    try:
        active_names = _fresh_active_instance_names()
        orphans = traffic_db.get_orphaned_instances(active_names)
        return _no_cache_json({'success': True, 'data': orphans})
    except Exception as e:
        logger.error(f"API GET /config/instances/orphan-data 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config/instances/orphan-data/<name>', methods=['DELETE'])
def api_config_instance_orphan_data_delete(name):
    try:
        active_names = _fresh_active_instance_names()
        if name in active_names:
            return jsonify({'success': False, 'error': '该名称仍被设备使用'}), 400
        if not traffic_db.is_orphaned_instance(name, active_names):
            return jsonify({'success': False, 'error': '孤儿数据不存在'}), 404
        traffic_db.delete_instance_data(name)
        logger.info(f"已删除孤儿数据: {name}")
        return jsonify({'success': True, 'message': '删除成功'})
    except Exception as e:
        logger.error(
            f"API DELETE /config/instances/orphan-data/{name} 错误: {e}",
            exc_info=True,
        )
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config/instances/test', methods=['POST'])
def api_config_instance_test():
    """测试实例连通性或限速读写能力（test_type: connect | limit）"""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': '请求无效'}), 400

        test_type = str(data.pop('test_type', 'connect')).strip().lower()
        original_name = str(data.pop('_original_name', '') or '').strip()
        existing = (
            config_manager.get_instance(original_name, monitor.config)
            if original_name else None
        )
        data = config_manager.resolve_instance_credentials_for_test_with_existing(
            data, existing
        )
        if not data.get('name') and original_name:
            data['name'] = original_name

        user = str(data.get('username', '')).strip()
        pwd = data.get('password', '') or ''
        if user and not pwd:
            return jsonify({
                'success': False,
                'error': '请填写密码',
            }), 400

        validated = config_manager.validate_instance_for_test(data)
        result = _run_instance_test(validated, test_type)
        payload = {'success': result['success'], 'steps': result.get('steps', [])}
        if result.get('error'):
            payload['error'] = result['error']
        return jsonify(payload)
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"API POST /config/instances/test 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config/instances', methods=['POST'])
def api_config_instance_add():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': '请求无效'}), 400
        
        attempt_sync, reachable, data_policy = config_manager.pop_instance_save_flags(data)
        target_name = str(data.get('name', '')).strip()
        active_names = _fresh_active_instance_names()
        _apply_add_data_policy(target_name, data_policy, active_names)

        validated = config_manager.add_instance(data)
        skip_qb_ops = reachable is False or not attempt_sync
        sync_name = (
            validated['name']
            if attempt_sync and reachable is not False else None
        )
        _apply_config_after_save(skip_qb_ops=skip_qb_ops, sync_instance=sync_name)
        synced = sync_name is not None

        policy_note = ''
        if data_policy == 'restore':
            policy_note = '（恢复历史数据）'
        elif data_policy == 'fresh':
            policy_note = '（清空后新建）'
        traffic_db.add_device_event(
            validated['name'],
            'instance_added',
            None,
            f'通过 Web 界面添加设备{policy_note}',
        )
        logger.info(f"设备已添加: {validated['name']}{policy_note}")

        return jsonify({
            'success': True,
            'message': '添加成功',
            'synced': synced,
            'data': config_manager.mask_instance_for_api(validated)
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"API POST /config/instances 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config/instances/<name>', methods=['PUT'])
def api_config_instance_update(name):
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': '请求无效'}), 400
        
        attempt_sync, reachable, data_policy = config_manager.pop_instance_save_flags(data)
        
        existing = config_manager.get_instance(name, monitor.config)
        data = config_manager.resolve_instance_credentials(data, existing)

        if config_manager.instance_cycle_settings_changed(existing, data):
            if reachable is False or not attempt_sync:
                raise ValueError('设备不在线，待设备上线后才能修改规则')
            if not traffic_db.is_instance_online(name):
                raise ValueError('设备不在线，待设备上线后才能修改规则')

        new_name = str(data.get('name', '')).strip() or name
        active_names = _fresh_active_instance_names()
        _apply_rename_data_policy(name, new_name, data_policy, active_names)

        validated = config_manager.update_instance(name, data)
        skip_qb_ops = (
            reachable is False
            or not attempt_sync
            or config_manager.instance_only_basics_changed(existing, validated)
        )
        sync_name = None
        if (attempt_sync and reachable is not False
                and not config_manager.instance_only_basics_changed(existing, validated)):
            sync_name = validated['name']
        if skip_qb_ops and not sync_name:
            monitor.apply_saved_instance_config(name, validated)
        if (reachable is False
                and config_manager.instance_connection_changed(existing, validated, name)):
            monitor.mark_instance_unreachable_save(validated['name'])
        _apply_config_after_save(
            skip_qb_ops=skip_qb_ops,
            sync_instance=sync_name,
            defer_reload=skip_qb_ops and not sync_name,
        )
        synced = sync_name is not None

        policy_note = ''
        if name != validated['name'] and data_policy == 'restore_orphan':
            policy_note = '（改名并恢复历史数据）'
        elif name != validated['name'] and data_policy == 'keep_current':
            policy_note = '（改名并保持现有数据）'
        traffic_db.add_device_event(
            validated['name'],
            'instance_updated',
            None,
            f'通过 Web 界面更新设备配置{policy_note}',
        )
        logger.info(f"设备配置已更新: {validated['name']}{policy_note}")

        return jsonify({
            'success': True,
            'message': '更新成功',
            'synced': synced,
            'data': config_manager.mask_instance_for_api(validated)
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"API PUT /config/instances/{name} 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config/instances/<name>', methods=['DELETE'])
def api_config_instance_delete(name):
    try:
        keep_data = request.args.get('keep_data', '0') in ('1', 'true', 'True')
        config_manager.delete_instance(name)
        keep_note = '（保留历史数据）' if keep_data else ''
        if keep_data:
            traffic_db.mark_instance_orphan_deleted(name)
            traffic_db.add_device_event(
                name,
                'instance_deleted',
                None,
                f'通过 Web 界面删除设备{keep_note}',
            )
        else:
            try:
                traffic_db.delete_instance_data(name)
            except Exception as data_err:
                logger.error(
                    f"设备 {name} 已从配置移除，但历史数据清理失败: {data_err}",
                    exc_info=True,
                )
        monitor.reload_config(refresh_status=False)

        logger.info(f"设备已删除: {name}{keep_note}")

        return jsonify({
            'success': True,
            'message': '删除成功'
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"API DELETE /config/instances/{name} 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config/global', methods=['GET'])
def api_config_global_get():
    try:
        global_cfg = config_manager.mask_global_for_api(
            config_manager.get_global_config(monitor.config),
            monitor.config,
        )
        return jsonify({'success': True, 'data': global_cfg})
    except Exception as e:
        logger.error(f"API GET /config/global 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/config/global', methods=['PUT'])
def api_config_global_update():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': '请求无效'}), 400
        
        old_port = monitor.config.get('global', {}).get('web_port', 8765)
        validated, full_config = config_manager.update_global(
            data, base_config=monitor.config
        )
        if not monitor.apply_config(full_config, refresh_status=False):
            return jsonify({'success': False, 'error': '保存失败'}), 500
        if emby_monitor and not emby_monitor.apply_config(full_config):
            return jsonify({'success': False, 'error': 'Emby 配置应用失败'}), 500

        port_changed = validated.get('web_port') != old_port
        msg = '保存成功，需重启生效' if port_changed else '保存成功'

        return jsonify({
            'success': True,
            'message': msg,
            'data': config_manager.mask_global_for_api(validated, full_config),
            'port_changed': port_changed
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"API PUT /config/global 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


# ── 用户界面偏好 ────────────────────────────────────────────

@app.route('/api/user/prefs/devices', methods=['GET'])
def api_user_device_prefs_get():
    try:
        username = get_session_username()
        if not username:
            return jsonify({'success': False, 'error': '未登录', 'auth_required': True}), 401
        import user_prefs_store
        return jsonify({
            'success': True,
            'data': user_prefs_store.get_device_prefs(username),
        })
    except Exception as e:
        logger.error(f"API GET /user/prefs/devices 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/user/prefs/devices', methods=['PUT'])
def api_user_device_prefs_update():
    try:
        username = get_session_username()
        if not username:
            return jsonify({'success': False, 'error': '未登录', 'auth_required': True}), 401
        data = request.get_json()
        if not isinstance(data, dict):
            return jsonify({'success': False, 'error': '请求无效'}), 400
        import user_prefs_store
        saved = user_prefs_store.update_device_prefs(username, data)
        return jsonify({'success': True, 'data': saved})
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"API PUT /user/prefs/devices 错误: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


# ── Emby（只读展示）────────────────────────────────────────

def _emby_feature_enabled() -> bool:
    if emby_monitor is None:
        return False
    return bool(
        config_manager.get_global_config(emby_monitor.config).get('emby_enabled', False)
    )


def _emby_required():
    if emby_monitor is None:
        return jsonify({'success': False, 'error': 'Emby 模块未初始化'}), 503
    if not _emby_feature_enabled():
        return jsonify({'success': False, 'error': 'Emby 功能未开启'}), 403
    return None


@app.route('/api/emby/status')
def api_emby_status():
    err = _emby_required()
    if err:
        return err
    try:
        return jsonify({
            'success': True,
            'data': emby_monitor.get_status_summary(),
            'docker_socket_available': emby_monitor.docker.is_available(),
            'timestamp': traffic_db.now_local().isoformat(),
        })
    except Exception as e:
        logger.error(f'API /emby/status 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/status/live')
def api_emby_status_live():
    err = _emby_required()
    if err:
        return err
    try:
        return jsonify({
            'success': True,
            'data': emby_monitor.get_live_status_summary(),
            'timestamp': traffic_db.now_local().isoformat(),
        })
    except Exception as e:
        logger.error(f'API /emby/status/live 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/sessions')
def api_emby_sessions():
    err = _emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        rows = []
        with emby_monitor._config_lock:
            clients = dict(emby_monitor.clients)
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
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/stats/<instance_name>/<period>')
def api_emby_stats(instance_name, period):
    err = _emby_required()
    if err:
        return err
    try:
        direction = request.args.get('direction', 'upload')
        if direction not in ('upload', 'download'):
            return jsonify({'success': False, 'error': '无效的方向参数'}), 400
        if not config_manager.get_emby_instance(instance_name, emby_monitor.config):
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
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/playback-records')
def api_emby_playback_records():
    err = _emby_required()
    if err:
        return err
    try:
        import playback_record_store
        instance_name = request.args.get('instance')
        limit = min(int(request.args.get('limit', 200)), playback_record_store.MAX_STORED_RECORDS)
        if instance_name:
            inst = config_manager.get_emby_instance(instance_name, emby_monitor.config)
            if not inst:
                return jsonify({'success': False, 'error': '设备不存在'}), 404
            records = playback_record_store.list_records(instance_name, limit=limit)
        else:
            records = playback_record_store.list_records(limit=limit)
        return jsonify({'success': True, 'data': records})
    except Exception as e:
        logger.error(f'API /emby/playback-records 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/activity-log')
def api_emby_activity_log():
    err = _emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        if not instance_name:
            return jsonify({'success': False, 'error': '请选择设备'}), 400
        inst = config_manager.get_emby_instance(instance_name, emby_monitor.config)
        if not inst:
            return jsonify({'success': False, 'error': '设备不存在'}), 404

        limit = min(int(request.args.get('limit', 200)), 500)
        client = EmbyClient(inst)
        sessions = client.get_sessions() or []
        item_cache = {}
        events = []
        for entry in client.get_activity_log(limit=limit):
            enrichment = EmbyClient.enrich_activity_entry(
                client, entry, item_cache, sessions,
            )
            events.append(EmbyClient.normalize_activity_entry(
                entry, instance_name, enrichment,
            ))
        return jsonify({'success': True, 'data': events})
    except Exception as e:
        logger.error(f'API /emby/activity-log 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/playback-users')
def api_emby_playback_users():
    err = _emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        if not instance_name:
            return jsonify({'success': False, 'error': '缺少 instance 参数'}), 400
        if not config_manager.get_emby_instance(instance_name, emby_monitor.config):
            return jsonify({'success': False, 'error': '设备不存在'}), 404
        users = emby_traffic_db.list_playback_upload_users(instance_name)
        return jsonify({'success': True, 'data': users})
    except Exception as e:
        logger.error(f'API /emby/playback-users 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/playback-stats/<instance_name>/<period>')
def api_emby_playback_stats(instance_name, period):
    err = _emby_required()
    if err:
        return err
    try:
        user_name = (request.args.get('user') or '').strip()
        if not user_name:
            return jsonify({'success': False, 'error': '缺少 user 参数'}), 400
        if not config_manager.get_emby_instance(instance_name, emby_monitor.config):
            return jsonify({'success': False, 'error': '设备不存在'}), 404
        all_users = user_name == emby_traffic_db.PLAYBACK_ALL_USERS_TOKEN
        if period == 'hourly':
            hours = min(int(request.args.get('hours', 24)), 366)
            if all_users:
                data = emby_traffic_db.get_playback_upload_hourly_stats_all_users(
                    instance_name, hours,
                    start=request.args.get('start'), end=request.args.get('end'),
                )
            else:
                data = emby_traffic_db.get_playback_upload_hourly_stats(
                    instance_name, user_name, hours,
                    start=request.args.get('start'), end=request.args.get('end'),
                )
        elif period == 'daily':
            days = min(int(request.args.get('days', 31)), 366)
            if all_users:
                data = emby_traffic_db.get_playback_upload_daily_stats_all_users(
                    instance_name, days,
                    start=request.args.get('start'), end=request.args.get('end'),
                )
            else:
                data = emby_traffic_db.get_playback_upload_daily_stats(
                    instance_name, user_name, days,
                    start=request.args.get('start'), end=request.args.get('end'),
                )
        elif period == 'monthly':
            months = min(int(request.args.get('months', 12)), 60)
            if all_users:
                data = emby_traffic_db.get_playback_upload_monthly_stats_all_users(
                    instance_name, months,
                    start=request.args.get('start'), end=request.args.get('end'),
                )
            else:
                data = emby_traffic_db.get_playback_upload_monthly_stats(
                    instance_name, user_name, months,
                    start=request.args.get('start'), end=request.args.get('end'),
                )
        elif period == 'weekly':
            weeks = min(int(request.args.get('weeks', 12)), 104)
            if all_users:
                data = emby_traffic_db.get_playback_upload_weekly_stats_all_users(
                    instance_name, weeks,
                    start=request.args.get('start'), end=request.args.get('end'),
                )
            else:
                data = emby_traffic_db.get_playback_upload_weekly_stats(
                    instance_name, user_name, weeks,
                    start=request.args.get('start'), end=request.args.get('end'),
                )
        elif period == 'yearly':
            years = min(int(request.args.get('years', 5)), 20)
            start_year = request.args.get('start_year')
            end_year = request.args.get('end_year')
            if all_users:
                data = emby_traffic_db.get_playback_upload_yearly_stats_all_users(
                    instance_name, years,
                    start=request.args.get('start'), end=request.args.get('end'),
                    start_year=int(start_year) if start_year else None,
                    end_year=int(end_year) if end_year else None,
                )
            else:
                data = emby_traffic_db.get_playback_upload_yearly_stats(
                    instance_name, user_name, years,
                    start=request.args.get('start'), end=request.args.get('end'),
                    start_year=int(start_year) if start_year else None,
                    end_year=int(end_year) if end_year else None,
                )
        elif period == 'cycle':
            from config_manager import DEFAULT_CYCLE, get_global_config
            from cycle import iter_cycle_periods
            from zoneinfo import ZoneInfo
            tz_name = get_global_config(emby_monitor.config).get(
                'timezone', 'Asia/Shanghai',
            )
            try:
                tz = ZoneInfo(tz_name)
            except Exception:
                tz = ZoneInfo('Asia/Shanghai')
            count = min(int(request.args.get('cycles', 12)), 50)
            periods = iter_cycle_periods(DEFAULT_CYCLE, tz, count=count)
            if all_users:
                data = emby_traffic_db.get_playback_upload_cycle_stats_all_users(
                    instance_name, periods,
                )
            else:
                data = emby_traffic_db.get_playback_upload_cycle_stats(
                    instance_name, user_name, periods,
                )
        else:
            return jsonify({'success': False, 'error': '播放用户统计暂不支持该周期'}), 400
        return jsonify({'success': True, 'data': data})
    except Exception as e:
        logger.error(f'API /emby/playback-stats 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/system-logs/files')
def api_emby_system_log_files():
    err = _emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        if not instance_name:
            return jsonify({'success': False, 'error': '请选择设备'}), 400
        inst = config_manager.get_emby_instance(instance_name, emby_monitor.config)
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
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/system-logs')
def api_emby_system_logs():
    err = _emby_required()
    if err:
        return err
    try:
        instance_name = request.args.get('instance')
        log_name = (request.args.get('log_name') or '').strip()
        level_filter = (request.args.get('level') or '').strip().upper()
        limit = min(int(request.args.get('limit', 500)), 1000)
        if not instance_name:
            return jsonify({'success': False, 'error': '请选择设备'}), 400
        inst = config_manager.get_emby_instance(instance_name, emby_monitor.config)
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
                if level_filter and parsed.get('level') != level_filter:
                    continue
                lines.append({
                    'log_name': name,
                    'time': parsed.get('time') or '',
                    'level': parsed.get('level') or 'INFO',
                    'logger': parsed.get('logger') or '',
                    'message': parsed.get('message') or parsed.get('raw') or '',
                    'line': parsed.get('raw') or line,
                })
        return jsonify({'success': True, 'data': lines[:limit]})
    except Exception as e:
        logger.error(f'API /emby/system-logs 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/config/instances', methods=['GET'])
def api_emby_config_instances_list():
    try:
        instances = [
            config_manager.mask_emby_instance_for_api(i)
            for i in config_manager.get_emby_instances(
                emby_monitor.config if emby_monitor else None)
        ]
        return jsonify({'success': True, 'data': instances})
    except Exception as e:
        logger.error(f'API GET /emby/config/instances 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/config/instances/<name>', methods=['GET'])
def api_emby_config_instance_get(name):
    try:
        inst = config_manager.get_emby_instance(
            name, emby_monitor.config if emby_monitor else None)
        if not inst:
            return jsonify({'success': False, 'error': '设备不存在'}), 404
        return jsonify({
            'success': True,
            'data': config_manager.mask_emby_instance_for_api(inst),
        })
    except Exception as e:
        logger.error(f'API GET /emby/config/instances/{name} 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/config/instances/orphan-check', methods=['GET'])
def api_emby_config_instance_orphan_check():
    err = _emby_required()
    if err:
        return err
    try:
        name = str(request.args.get('name', '')).strip()
        if not name:
            return jsonify({'success': False, 'error': '参数缺失'}), 400
        active_names = _fresh_active_emby_instance_names()
        has_orphan = emby_traffic_db.is_orphaned_instance(name, active_names)
        return _no_cache_json({
            'success': True,
            'has_orphaned_data': has_orphan,
            'name': name,
        })
    except Exception as e:
        logger.error(f'API GET /emby/config/instances/orphan-check 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/config/instances/orphan-data', methods=['GET'])
def api_emby_config_instance_orphan_data():
    err = _emby_required()
    if err:
        return err
    try:
        active_names = _fresh_active_emby_instance_names()
        orphans = emby_traffic_db.get_orphaned_instances(active_names)
        return _no_cache_json({'success': True, 'data': orphans})
    except Exception as e:
        logger.error(f'API GET /emby/config/instances/orphan-data 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/config/instances/orphan-data/<name>', methods=['DELETE'])
def api_emby_config_instance_orphan_data_delete(name):
    err = _emby_required()
    if err:
        return err
    try:
        active_names = _fresh_active_emby_instance_names()
        if name in active_names:
            return jsonify({'success': False, 'error': '该名称仍被设备使用'}), 400
        if not emby_traffic_db.is_orphaned_instance(name, active_names):
            return jsonify({'success': False, 'error': '孤儿数据不存在'}), 404
        emby_traffic_db.delete_instance_data(name)
        playback_record_store.delete_instance_records(name)
        logger.info(f'已删除 Emby 孤儿数据: {name}')
        return jsonify({'success': True, 'message': '删除成功'})
    except Exception as e:
        logger.error(
            f'API DELETE /emby/config/instances/orphan-data/{name} 错误: {e}',
            exc_info=True,
        )
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/config/instances/test', methods=['POST'])
def api_emby_config_instances_test():
    try:
        data = request.get_json() or {}
        test_type = data.get('test_type', 'connect')
        validated = config_manager.validate_emby_instance_for_test(
            data, test_type=test_type)

        if test_type == 'docker':
            result = emby_monitor.test_docker_container(
                validated.get('container_name', ''),
                validated.get('container_id', ''),
            ) if emby_monitor else {'ok': False, 'error': 'Emby 模块未初始化'}
            return jsonify({'success': result.get('ok', False), 'data': result,
                            'error': result.get('error')})

        client = EmbyClient(validated)
        result = client.test_connection()
        return jsonify({
            'success': result.get('ok', False),
            'data': result,
            'error': result.get('error'),
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f'API POST /emby/config/instances/test 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/config/instances', methods=['POST'])
def api_emby_config_instances_add():
    err = _emby_required()
    if err:
        return err
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': '请求无效'}), 400
        attempt_sync, reachable, data_policy = config_manager.pop_instance_save_flags(data)
        target_name = str(data.get('name', '')).strip()
        active_names = _fresh_active_emby_instance_names()
        _apply_emby_add_data_policy(target_name, data_policy, active_names)
        validated = config_manager.add_emby_instance(data)
        _reload_all_config()
        if emby_monitor:
            emby_monitor.reload_config()
            emby_monitor.wake_all()
        policy_note = ''
        if data_policy == 'restore':
            policy_note = '（恢复历史数据）'
        elif data_policy == 'fresh':
            policy_note = '（清空后新建）'
        logger.info(f'Emby 设备已添加: {validated["name"]}{policy_note}')
        return jsonify({
            'success': True,
            'message': '添加成功',
            'data': config_manager.mask_emby_instance_for_api(validated),
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f'API POST /emby/config/instances 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/config/instances/<name>', methods=['PUT'])
def api_emby_config_instances_update(name):
    err = _emby_required()
    if err:
        return err
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': '请求无效'}), 400
        attempt_sync, reachable, data_policy = config_manager.pop_instance_save_flags(data)
        new_name = str(data.get('name', '')).strip() or name
        active_names = _fresh_active_emby_instance_names()
        _apply_emby_rename_data_policy(name, new_name, data_policy, active_names)
        validated = config_manager.update_emby_instance(name, data)
        _reload_all_config()
        if emby_monitor:
            emby_monitor.wake_all()
        policy_note = ''
        if name != validated['name'] and data_policy == 'restore_orphan':
            policy_note = '（改名并恢复历史数据）'
        elif name != validated['name'] and data_policy == 'keep_current':
            policy_note = '（改名并保持现有数据）'
        logger.info(f'Emby 设备配置已更新: {validated["name"]}{policy_note}')
        return jsonify({
            'success': True,
            'message': '保存成功',
            'data': config_manager.mask_emby_instance_for_api(validated),
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f'API PUT /emby/config/instances/{name} 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/control/reset-stats', methods=['POST'])
def api_emby_control_reset_stats():
    """清空 Emby 设备流量统计，重新累计"""
    err = _emby_required()
    if err:
        return err
    try:
        data = request.get_json() or {}
        instance_name = data.get('instance_name')
        if not instance_name:
            return jsonify({'success': False, 'error': '参数缺失'}), 400
        if not emby_monitor:
            return jsonify({'success': False, 'error': 'Emby 模块未初始化'}), 500
        emby_monitor.reset_traffic_stats(instance_name)
        return jsonify({
            'success': True,
            'message': '清空成功',
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f'API /emby/control/reset-stats 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


def _get_emby_client(instance_name: str):
    if not emby_monitor:
        return None, (jsonify({'success': False, 'error': 'Emby 模块未初始化'}), 500)
    with emby_monitor._config_lock:
        client = emby_monitor.clients.get(instance_name)
    if not client:
        return None, (jsonify({'success': False, 'error': '设备不存在'}), 404)
    return client, None


@app.route('/api/emby/sessions/<path:instance_name>/<session_id>/playing/<command>', methods=['POST'])
def api_emby_session_playing_command(instance_name, session_id, command):
    err = _emby_required()
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
    client, err_resp = _get_emby_client(instance_name)
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
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/sessions/<path:instance_name>/<session_id>/message', methods=['POST'])
def api_emby_session_message(instance_name, session_id):
    err = _emby_required()
    if err:
        return err
    client, err_resp = _get_emby_client(instance_name)
    if err_resp:
        return err_resp
    try:
        data = request.get_json() or {}
        text = str(data.get('text') or '').strip()
        header = str(data.get('header') or '').strip() or None
        timeout_ms = data.get('timeout_ms')
        if timeout_ms is not None and str(timeout_ms).strip() != '':
            timeout_ms = int(timeout_ms)
        else:
            timeout_ms = DEFAULT_SESSION_MESSAGE_TIMEOUT_MS
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
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/emby/config/instances/<name>', methods=['DELETE'])
def api_emby_config_instances_delete(name):
    err = _emby_required()
    if err:
        return err
    try:
        keep_data = request.args.get('keep_data', '0') in ('1', 'true', 'True')
        config_manager.delete_emby_instance(name)
        keep_note = '（保留历史数据）' if keep_data else ''
        if keep_data:
            emby_traffic_db.mark_instance_orphan_deleted(name)
        else:
            try:
                emby_traffic_db.delete_instance_data(name)
                playback_record_store.delete_instance_records(name)
            except Exception as data_err:
                logger.error(
                    f'Emby 设备 {name} 已从配置移除，但历史数据清理失败: {data_err}',
                    exc_info=True,
                )
        _reload_all_config()
        if emby_monitor:
            emby_monitor.reload_config()
        logger.info(f'Emby 设备已删除: {name}{keep_note}')
        return jsonify({'success': True, 'message': '删除成功'})
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f'API DELETE /emby/config/instances/{name} 错误: {e}', exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


def run_web_server(host='0.0.0.0', port=8765):
    werkzeug_log = logging.getLogger('werkzeug')
    werkzeug_log.setLevel(logging.WARNING)
    try:
        from waitress import serve
        logger.info('Web 服务: Waitress (生产模式)')
        serve(app, host=host, port=port, threads=8, channel_timeout=120)
    except ImportError:
        logger.warning('未安装 waitress，使用 Flask 内置服务器（不建议生产环境）')
        app.run(host=host, port=port, debug=False, threaded=True)
