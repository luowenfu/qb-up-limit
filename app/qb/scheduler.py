import logging
import threading
import time
from datetime import datetime
from typing import Dict
from zoneinfo import ZoneInfo

import qb.traffic_db as traffic_db
import emby.traffic.db as emby_traffic_db
import qb.speed_limiter as speed_limiter
import core.config_manager as config_manager
from core.cycle import get_cycle_start, cycle_info, cycle_start_key, format_next_cycle_switch_label
from qb.collect_log import format_collect_summary
from qb.monitor import QBittorrentClient

logger = logging.getLogger(__name__)

_COORDINATOR_INTERVAL = 60
_COLLECT_LOG_INTERVAL = 600  # 采集摘要日志间隔（秒，10 分钟）


def clamp_interval(seconds: int) -> int:
    return max(1, min(60, int(seconds)))


def ticks_per_full_collect(collect_interval: int, refresh_interval: int) -> int:
    refresh = clamp_interval(refresh_interval)
    collect = clamp_interval(collect_interval)
    return max(1, collect // refresh)


def _online_since_from_prev(prev: dict) -> str:
    if prev.get('is_online'):
        cached = prev.get('online_since')
        if cached:
            return cached
    return traffic_db._format_datetime_seconds(traffic_db.now_local())


def _normal_global_limit_from_status(status: dict):
    raw = (status or {}).get('normal_global_upload_limit_kbps')
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return None if value < 0 else value


class InstanceWorker:
    """单设备独立采集线程：在线按间隔采集，离线按间隔探测连接"""

    def __init__(self, monitor: 'TrafficMonitor', name: str):
        self.monitor = monitor
        self.name = name
        self._thread: threading.Thread = None
        self._running = False
        self._was_online = False
        self._wake = threading.Event()
        self._baseline_session_up = None
        self._baseline_session_dl = None
        self._light_ticks = 0

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._loop, name=f'collector-{self.name}', daemon=True,
        )
        self._thread.start()

    def stop(self, wait: bool = True):
        self._running = False
        self._wake.set()
        if self._thread:
            if wait:
                self._thread.join(timeout=15)
            self._thread = None

    def wake(self):
        self._wake.set()

    def _sleep_interval(self, tick_elapsed_seconds: float = 0.0):
        interval = clamp_interval(self.monitor.refresh_interval)
        wait_seconds = max(
            0.0, float(interval) - max(0.0, float(tick_elapsed_seconds or 0.0)),
        )
        self._wake.wait(timeout=wait_seconds)
        self._wake.clear()

    def _ticks_per_full(self) -> int:
        return ticks_per_full_collect(
            self.monitor.collect_interval, self.monitor.refresh_interval)

    def _should_run_full_tick(self) -> bool:
        return self._light_ticks <= 0 or self._light_ticks >= self._ticks_per_full()

    def _load_baseline_from_db(self, session_up: int, session_dl: int):
        for row in traffic_db.get_all_instance_status():
            if row['instance_name'] == self.name:
                self._baseline_session_up = row.get('last_total_uploaded') or session_up
                self._baseline_session_dl = row.get('last_total_downloaded') or session_dl
                return
        self._baseline_session_up = session_up
        self._baseline_session_dl = session_dl

    def _sync_baseline_from_info(self, info: dict):
        self._baseline_session_up = info['session_uploaded']
        self._baseline_session_dl = info.get('session_downloaded', 0)

    def _calc_light_delta(self, info: dict) -> tuple:
        session_up = info['session_uploaded']
        session_dl = info.get('session_downloaded', 0)
        if self._baseline_session_up is None:
            self._load_baseline_from_db(session_up, session_dl)
            return 0, 0

        if session_up < self._baseline_session_up:
            delta_up = 0
        else:
            delta_up = session_up - self._baseline_session_up
        if session_dl < self._baseline_session_dl:
            delta_dl = 0
        else:
            delta_dl = session_dl - self._baseline_session_dl

        self._baseline_session_up = session_up
        self._baseline_session_dl = session_dl
        return delta_up, delta_dl

    def _recent_delta_from_speed(self, info: dict) -> tuple:
        """轻量展示：用 qB 瞬时速度 × 刷新间隔"""
        interval = clamp_interval(self.monitor.refresh_interval)
        delta_up = int((info.get('up_speed') or 0) * interval)
        delta_dl = int((info.get('dl_speed') or 0) * interval)
        return delta_up, delta_dl

    def reset_after_unreachable_save(self):
        self._was_online = False
        self._baseline_session_up = None
        self._baseline_session_dl = None
        self._light_ticks = 0

    def _get_client(self) -> QBittorrentClient:
        with self.monitor._config_lock:
            return self.monitor.clients.get(self.name)

    def _loop(self):
        while self._running and self.monitor._running:
            tick_started = time.monotonic()
            try:
                if self._should_run_full_tick():
                    self._tick()
                    self._light_ticks = 0
                else:
                    self._light_tick()
                self._light_ticks += 1
            except Exception as e:
                logger.error(f"[{self.name}] 采集循环异常: {e}", exc_info=True)
            tick_elapsed = time.monotonic() - tick_started
            self._sleep_interval(tick_elapsed)

    def _light_tick(self):
        """轻量探测：仅更新瞬时增量与限速展示，不落库、不跑达量逻辑"""
        if not self._was_online:
            self._tick()
            self._light_ticks = 0
            return

        client = self._get_client()
        if not client:
            return

        info = client.get_transfer_info(probe=False)
        if info is None:
            self._mark_offline(client)
            return

        delta_up, delta_dl = self._recent_delta_from_speed(info)
        limit_info = client.get_upload_limit_info()
        if limit_info:
            self.monitor._probe_limit_state_change(
                self.name, client, limit_info)
        self.monitor.update_live_cache_light(
            self.name,
            delta_up=delta_up,
            delta_dl=delta_dl,
            limit_info=limit_info,
        )
        self._was_online = True

    def _tick(self):
        client = self._get_client()
        if not client:
            return

        recovering = not self._was_online
        info = client.fetch_for_collection(prefer_probe=recovering)
        if info is None:
            self._mark_offline(client)
            return

        is_backfill = recovering and traffic_db.has_session_baseline(self.name)

        delta_up, delta_dl, backfill_up, backfill_dl = traffic_db.save_snapshot(
            self.name,
            info['session_uploaded'],
            info.get('session_downloaded', 0),
            is_backfill=is_backfill,
        )
        self.monitor._finalize_collection(
            self.name, client, info,
            delta_up, delta_dl, backfill_up, backfill_dl, is_backfill,
        )
        self._sync_baseline_from_info(info)
        self._record_torrent_events(client)
        self._was_online = True

    def _record_torrent_events(self, client: QBittorrentClient):
        try:
            events = client.poll_torrent_events()
        except Exception as e:
            logger.debug(f"[{self.name}] 种子事件采集失败: {e}")
            return
        try:
            traffic_db.save_torrent_counters(
                self.name, client.consume_torrent_counters(),
            )
        except Exception as e:
            logger.debug(f"[{self.name}] 种子流量落库失败: {e}")
        traffic_db.add_device_events(self.name, events)

    def _mark_offline(self, client: QBittorrentClient):
        was = self._was_online
        self._was_online = False
        self._baseline_session_up = None
        self._baseline_session_dl = None
        client.disconnect()
        if was:
            logger.warning(f"[{self.name}] 连接中断，进入离线探测模式")
        traffic_db.update_instance_status(self.name, False)
        self.monitor.update_live_cache_offline(self.name)


class TrafficMonitor:
    """流量监控调度器"""

    def __init__(self, config: dict, config_path: str = None):
        self.config_path = config_path or config_manager.CONFIG_PATH
        self.config = config
        self._apply_global_config()

        self.clients: Dict[str, QBittorrentClient] = {}
        self._init_clients()

        self._running = False
        self._coordinator_thread = None
        self._workers: Dict[str, InstanceWorker] = {}
        self._last_cleanup_day = None
        self._config_lock = threading.Lock()
        self._live_cache: Dict[str, dict] = {}
        self._live_cache_lock = threading.Lock()
        self._collect_generation: Dict[str, int] = {}
        self._state_generation: Dict[str, int] = {}
        self._collect_log_state: Dict[str, dict] = {}
        self._status_traffic_cache: Dict[str, dict] = {}
        self._status_traffic_cache_at = 0.0
        self._status_traffic_cache_lock = threading.Lock()
        self._status_traffic_cache_ttl = 1.0

    def _apply_global_config(self):
        self.global_cfg = config_manager.get_global_config(self.config)
        try:
            refresh = int(self.global_cfg.get('refresh_interval', 1))
        except (TypeError, ValueError):
            refresh = 1
        refresh = max(
            config_manager.REFRESH_INTERVAL_MIN,
            min(config_manager.REFRESH_INTERVAL_MAX, refresh),
        )
        self.refresh_interval = refresh
        self.collect_interval = config_manager.collect_interval_for_refresh(refresh)
        tz_name = self.global_cfg.get('timezone', 'Asia/Shanghai')
        try:
            self.timezone = ZoneInfo(tz_name)
        except Exception:
            logger.warning(f"无效时区 {tz_name}，使用 Asia/Shanghai")
            self.timezone = ZoneInfo('Asia/Shanghai')
        traffic_db.set_timezone(self.timezone)
        retention = self.global_cfg.get('data_retention_years', 5)
        if traffic_db.set_retention_years(retention):
            traffic_db.cleanup_old_data()
        if emby_traffic_db.set_retention_years(retention):
            emby_traffic_db.cleanup_old_data()

    def _now(self) -> datetime:
        return datetime.now(self.timezone)

    def _init_clients(self):
        instances = self.config.get('qbittorrent_instances', [])
        for inst_cfg in instances:
            name = inst_cfg['name']
            self.clients[name] = QBittorrentClient(inst_cfg)
            logger.info(f"初始化qB实例: {name} ({inst_cfg['host']}:{inst_cfg['port']})")

    def _can_sync_qb_ops(self, instance_name: str, skip_qb_ops: bool = False) -> bool:
        if skip_qb_ops:
            return False
        return traffic_db.is_instance_online(instance_name)

    def _apply_cycle_transition_if_needed(self, client: QBittorrentClient,
                                        skip_qb_ops: bool = False,
                                        log_prefix: str = '新周期限速恢复') -> bool:
        """周期切换时执行 reset_limit；首次记录当前周期不触发重置。成功后才写入周期标记。"""
        now = self._now()
        current = get_cycle_start(now, client.cycle)
        key = cycle_start_key(current)
        prev_key = traffic_db.get_last_applied_cycle_start(client.name)

        if prev_key == key:
            return False

        if not self._can_sync_qb_ops(client.name, skip_qb_ops):
            logger.info(
                f"[{client.name}] 周期配置待同步，"
                "设备当前不可连接，延后至上线后执行"
            )
            return False

        if not traffic_db.try_begin_cycle_transition(
                client.name, prev_key, key):
            return False

        if prev_key is not None:
            try:
                traffic_db.clear_limit_trigger_records(client.name)
                promoted = self._promote_next_cycle_plan_if_any(client.name)
                if not speed_limiter.apply_cycle_reset_limit(client):
                    traffic_db.set_last_applied_cycle_start(client.name, prev_key)
                    logger.error(f"[{client.name}] 周期限速恢复失败，将在下轮重试")
                    return False
                if promoted:
                    cycle_upload, _, _, _ = self._get_cycle_traffic(
                        client.name, client)
                    speed_limiter.force_apply_quota_rules(
                        client,
                        cycle_upload,
                        reason='下周期计划已生效',
                    )
                limit_kbps = client.cycle.get('reset_limit_kbps', 0)
                limit_desc = f'{limit_kbps} KB/s' if limit_kbps > 0 else '无限速'
                logger.info(
                    f"[{client.name}] {log_prefix} "
                    f"({cycle_info(now, client.cycle)['reset_anchor_label']} "
                    f"→ {limit_desc})"
                )
            except Exception as e:
                traffic_db.set_last_applied_cycle_start(client.name, prev_key)
                logger.error(f"[{client.name}] 周期限速恢复失败: {e}")
                return False

        return True

    def _sync_cycle_tracking(self, skip_qb_ops: bool = False):
        """同步周期追踪并在停机跨周期时补执行 reset_limit"""
        with self._config_lock:
            clients = list(self.clients.values())

        for client in clients:
            self._apply_cycle_transition_if_needed(
                client, skip_qb_ops=skip_qb_ops,
            )

    def apply_config(self, new_config: dict, refresh_status: bool = True,
                     skip_qb_ops: bool = False) -> bool:
        try:
            with self._config_lock:
                new_config = config_manager.enrich_config(new_config or {})
                new_config.setdefault('qbittorrent_instances', [])
                new_config.setdefault('emby_instances', [])
                instances = new_config.get('qbittorrent_instances') or []

                self.config = new_config
                self._apply_global_config()

                new_instances = {i['name']: i for i in instances}

                for name in list(self.clients.keys()):
                    if name not in new_instances:
                        del self.clients[name]
                        logger.info(f"移除qB实例: {name}")

                for name, inst_cfg in new_instances.items():
                    if name in self.clients:
                        self.clients[name].update_config(inst_cfg)
                        logger.info(f"更新qB实例配置: {name}")
                    else:
                        self.clients[name] = QBittorrentClient(inst_cfg)
                        logger.info(f"新增qB实例: {name}")

                logger.info("配置应用完成")

            self._sync_cycle_tracking(skip_qb_ops=skip_qb_ops)
            self._sync_workers()
            if refresh_status:
                self.refresh_instance_status()
            return True
        except Exception as e:
            logger.error(f"配置应用失败: {e}", exc_info=True)
            return False

    def apply_saved_instance_config(self, old_name: str, validated: dict) -> None:
        """保存写入文件后立刻更新内存中的设备项，避免等待全量 reload"""
        new_name = validated['name']
        with self._config_lock:
            instances = self.config.setdefault('qbittorrent_instances', [])
            idx = next(
                (i for i, x in enumerate(instances) if x['name'] == old_name),
                None,
            )
            if idx is not None:
                instances[idx] = dict(validated)
            elif new_name:
                idx = next(
                    (i for i, x in enumerate(instances) if x['name'] == new_name),
                    None,
                )
                if idx is not None:
                    instances[idx] = dict(validated)

            if old_name != new_name and old_name in self.clients:
                self.clients[new_name] = self.clients.pop(old_name)
            client = self.clients.get(new_name)
            if client:
                client.update_config(validated)

    def reload_config(self, refresh_status: bool = True,
                      skip_qb_ops: bool = False):
        try:
            new_config = config_manager.load_runtime_config(self.config_path)
            return self.apply_config(
                new_config,
                refresh_status=refresh_status,
                skip_qb_ops=skip_qb_ops,
            )
        except Exception as e:
            logger.error(f"配置热重载失败: {e}", exc_info=True)
            return False

    def _get_cycle_traffic(self, name: str, client: QBittorrentClient):
        now = self._now()
        cycle_start = get_cycle_start(now, client.cycle)
        upload_bytes = traffic_db.get_cycle_bytes(name, cycle_start, 'upload')
        download_bytes = traffic_db.get_cycle_bytes(name, cycle_start, 'download')
        info = cycle_info(now, client.cycle)
        return upload_bytes, download_bytes, cycle_start, info

    def _read_limit_status(self, client: QBittorrentClient) -> dict:
        """读取上传限速状态；优先一次 API 调用获取全局/备用信息"""
        limit_info = client.get_upload_limit_info()
        if limit_info:
            global_kbps = limit_info['global_upload_limit_kbps']
            return {
                'current_limit_kbps': global_kbps,
                'has_upload_limit': global_kbps > 0,
                'alt_upload_limit_kbps': limit_info['alt_upload_limit_kbps'],
                'alt_speed_limits_active': limit_info['alt_speed_limits_active'],
            }
        limit_bytes = client.get_current_upload_limit()
        if limit_bytes < 0:
            return {
                'current_limit_kbps': -1,
                'has_upload_limit': False,
                'alt_upload_limit_kbps': 0,
                'alt_speed_limits_active': False,
            }
        global_kbps = limit_bytes // 1024 if limit_bytes > 0 else 0
        return {
            'current_limit_kbps': global_kbps,
            'has_upload_limit': limit_bytes > 0,
            'alt_upload_limit_kbps': 0,
            'alt_speed_limits_active': False,
        }

    def refresh_instance_status(self, instance_name: str = None):
        with self._config_lock:
            if instance_name and instance_name in self.clients:
                targets = {instance_name: self.clients[instance_name]}
            else:
                targets = dict(self.clients)

        for name, client in targets.items():
            try:
                info = client.get_transfer_info(probe=True)
                if info is None:
                    traffic_db.update_instance_status(name, False)
                    continue

                cycle_upload, cycle_download, _, _ = self._get_cycle_traffic(name, client)
                limit_status = self._read_limit_status(client)
                current_limit_kbps = limit_status['current_limit_kbps']
                has_upload_limit = limit_status['has_upload_limit']

                is_quota = traffic_db.get_limit_source(name) == traffic_db.LIMIT_SOURCE_AUTO
                traffic_db.update_instance_status(
                    name,
                    is_online=True,
                    current_speed_limit_kbps=current_limit_kbps,
                    is_quota_limited=is_quota and has_upload_limit,
                    has_upload_limit=has_upload_limit,
                    limit_source=traffic_db.get_limit_source(name),
                    monthly_uploaded_bytes=cycle_upload,
                    monthly_downloaded_bytes=cycle_download,
                    alt_upload_limit_kbps=limit_status['alt_upload_limit_kbps'],
                    alt_speed_limits_active=limit_status['alt_speed_limits_active'],
                )
            except Exception as e:
                logger.error(f"[{name}] 即时刷新状态失败: {e}", exc_info=True)
            else:
                self._bump_state_generation(name)

    def start(self):
        self._running = True
        try:
            self._sync_cycle_tracking()
        except Exception as e:
            logger.error(f"启动周期同步失败: {e}", exc_info=True)
        self._sync_workers()
        self._coordinator_thread = threading.Thread(
            target=self._coordinator_loop, name='monitor-coordinator', daemon=True,
        )
        self._coordinator_thread.start()
        logger.info(
            f"流量监控已启动（数据采集 {clamp_interval(self.collect_interval)}s"
            f"，轻量探测 {clamp_interval(self.refresh_interval)}s）"
        )

    def _bump_collect_generation(self, name: str) -> int:
        with self._live_cache_lock:
            val = self._collect_generation.get(name, 0) + 1
            self._collect_generation[name] = val
            if name in self._live_cache:
                self._live_cache[name]['collect_generation'] = val
            return val

    def _bump_state_generation(self, name: str) -> int:
        with self._live_cache_lock:
            val = self._state_generation.get(name, 0) + 1
            self._state_generation[name] = val
            if name in self._live_cache:
                self._live_cache[name]['state_generation'] = val
            return val

    def _generation_fields_unlocked(self, name: str) -> dict:
        return {
            'collect_generation': self._collect_generation.get(name, 0),
            'state_generation': self._state_generation.get(name, 0),
        }

    def _generation_fields(self, name: str) -> dict:
        with self._live_cache_lock:
            return self._generation_fields_unlocked(name)

    def _attach_generations_unlocked(self, entry: dict, name: str) -> dict:
        entry.update(self._generation_fields_unlocked(name))
        return entry

    def _attach_generations(self, entry: dict, name: str) -> dict:
        with self._live_cache_lock:
            return self._attach_generations_unlocked(dict(entry), name)

    def _probe_limit_state_change(
        self, name: str, client: QBittorrentClient, limit_info: dict,
    ) -> bool:
        """轻量探测发现限速/模式变化时同步 DB 并 bump state_generation"""
        if not limit_info:
            return False
        with self._live_cache_lock:
            prev = self._live_cache.get(name, {})
        if not prev.get('is_online'):
            return False
        if getattr(client, 'is_speed_testing', False):
            return False

        new_global = int(limit_info.get('global_upload_limit_kbps') or 0)
        new_alt = int(limit_info.get('alt_upload_limit_kbps') or 0)
        new_alt_active = bool(limit_info.get('alt_speed_limits_active'))
        prev_global = int(prev.get('global_upload_limit_kbps') or 0)
        prev_alt = int(prev.get('alt_upload_limit_kbps') or 0)
        prev_alt_active = bool(prev.get('alt_speed_limits_active'))
        if (new_global, new_alt, new_alt_active) == (
            prev_global, prev_alt, prev_alt_active
        ):
            return False

        try:
            cycle_upload, cycle_download, _, _ = self._get_cycle_traffic(
                name, client)
            speed_limiter.detect_external_limit_change(
                client,
                cycle_upload,
                current_kbps=max(0, new_global),
                alt_speed_limits_active=new_alt_active,
            )
            limit_source = traffic_db.get_limit_source(name)
            is_quota = limit_source == traffic_db.LIMIT_SOURCE_AUTO
            has_upload_limit = new_global > 0
            is_quota_limited = (
                is_quota and has_upload_limit and not new_alt_active
            )
            traffic_db.update_instance_status(
                name,
                is_online=True,
                current_speed_limit_kbps=new_global,
                is_quota_limited=is_quota_limited,
                has_upload_limit=has_upload_limit,
                limit_source=limit_source,
                monthly_uploaded_bytes=cycle_upload,
                monthly_downloaded_bytes=cycle_download,
                alt_upload_limit_kbps=new_alt,
                alt_speed_limits_active=new_alt_active,
            )
        except Exception as e:
            logger.error(f"[{name}] 轻量限速探测同步失败: {e}", exc_info=True)
            return False

        self._bump_state_generation(name)
        logger.info(f"[{name}] 轻量探测检测到限速变化，已同步状态")
        return True

    def update_live_cache_light(
        self, name: str, delta_up: int, delta_dl: int,
        limit_info: dict = None,
    ):
        with self._live_cache_lock:
            prev = self._live_cache.get(name, {})
            if limit_info:
                global_kbps = limit_info['global_upload_limit_kbps']
                alt_kbps = limit_info['alt_upload_limit_kbps']
                alt_active = limit_info['alt_speed_limits_active']
            else:
                global_kbps = prev.get('global_upload_limit_kbps', 0)
                alt_kbps = prev.get('alt_upload_limit_kbps', 0)
                alt_active = prev.get('alt_speed_limits_active', False)
            entry = {
                'name': name,
                'is_online': True,
                'online_since': _online_since_from_prev(prev),
                'recent_delta_bytes': delta_up,
                'recent_delta_download_bytes': delta_dl,
                'global_upload_limit_kbps': global_kbps,
                'current_speed_limit_kbps': global_kbps,
                'alt_upload_limit_kbps': alt_kbps,
                'alt_speed_limits_active': alt_active,
                'collect_interval': self.collect_interval,
                'refresh_interval': self.refresh_interval,
            }
            self._live_cache[name] = self._attach_generations_unlocked(entry, name)

    def update_live_cache_full(self, name: str, delta_up: int, delta_dl: int,
                               limit_status: dict, info: dict = None):
        global_kbps = limit_status['current_limit_kbps']
        if global_kbps is None or global_kbps < 0:
            global_kbps = 0
        if info:
            interval = clamp_interval(self.refresh_interval)
            recent_up = int((info.get('up_speed') or 0) * interval)
            recent_dl = int((info.get('dl_speed') or 0) * interval)
        else:
            recent_up = delta_up
            recent_dl = delta_dl
        with self._live_cache_lock:
            prev = self._live_cache.get(name, {})
            entry = {
                'name': name,
                'is_online': True,
                'online_since': _online_since_from_prev(prev),
                'recent_delta_bytes': recent_up,
                'recent_delta_download_bytes': recent_dl,
                'global_upload_limit_kbps': global_kbps,
                'current_speed_limit_kbps': global_kbps,
                'alt_upload_limit_kbps': limit_status['alt_upload_limit_kbps'],
                'alt_speed_limits_active': limit_status['alt_speed_limits_active'],
                'collect_interval': self.collect_interval,
                'refresh_interval': self.refresh_interval,
            }
            self._live_cache[name] = self._attach_generations_unlocked(entry, name)

    def update_live_cache_offline(self, name: str):
        went_offline = False
        with self._live_cache_lock:
            prev = self._live_cache.get(name, {})
            if prev.get('is_online'):
                went_offline = True
                offline_since = traffic_db._format_datetime_seconds(traffic_db.now_local())
            else:
                offline_since = prev.get('offline_since')
                if not offline_since:
                    offline_since = traffic_db._format_datetime_seconds(traffic_db.now_local())
            entry = {
                'name': name,
                'is_online': False,
                'offline_since': offline_since,
                'recent_delta_bytes': 0,
                'recent_delta_download_bytes': 0,
                'global_upload_limit_kbps': 0,
                'current_speed_limit_kbps': 0,
                'alt_upload_limit_kbps': 0,
                'alt_speed_limits_active': False,
                'collect_interval': self.collect_interval,
                'refresh_interval': self.refresh_interval,
            }
            self._live_cache[name] = self._attach_generations_unlocked(entry, name)
        if went_offline:
            self._bump_state_generation(name)

    def get_live_status_summary(self) -> list:
        with self._config_lock:
            names = list(self.clients.keys())
        with self._live_cache_lock:
            cache = dict(self._live_cache)
        result = []
        for name in names:
            if name in cache:
                result.append(dict(cache[name]))
            else:
                result.append(self._attach_generations({
                    'name': name,
                    'is_online': False,
                    'recent_delta_bytes': 0,
                    'recent_delta_download_bytes': 0,
                    'global_upload_limit_kbps': 0,
                    'current_speed_limit_kbps': 0,
                    'alt_upload_limit_kbps': 0,
                    'alt_speed_limits_active': False,
                    'collect_interval': self.collect_interval,
                    'refresh_interval': self.refresh_interval,
                }, name))
        return result

    def stop(self):
        self._running = False
        for worker in list(self._workers.values()):
            worker.stop()
        self._workers.clear()
        if self._coordinator_thread:
            self._coordinator_thread.join(timeout=10)
            self._coordinator_thread = None
        logger.info("流量监控已停止")

    def _sync_workers(self):
        """为每台设备启动/停止独立采集线程"""
        if not self._running:
            return
        with self._config_lock:
            names = set(self.clients.keys())
        for name in list(self._workers.keys()):
            if name not in names:
                self._workers[name].stop(wait=False)
                del self._workers[name]
                logger.info(f"停止采集线程: {name}")
        for name in names:
            if name not in self._workers:
                self._workers[name] = InstanceWorker(self, name)
                self._workers[name].start()
                logger.info(f"启动采集线程: {name}")
            else:
                self._workers[name].wake()

    def _coordinator_loop(self):
        while self._running:
            try:
                self._check_cycle_reset()
                self._check_daily_cleanup()
            except Exception as e:
                logger.error(f"协调循环异常: {e}", exc_info=True)
            time.sleep(_COORDINATOR_INTERVAL)

    def _finalize_collection(
        self, name: str, client: QBittorrentClient, info: dict,
        delta_up: int, delta_dl: int,
        backfill_up: int, backfill_dl: int, is_backfill: bool,
    ):
        cycle_upload, cycle_download, _, _ = self._get_cycle_traffic(name, client)

        limit_status = self._read_limit_status(client)
        if limit_status['current_limit_kbps'] >= 0:
            speed_limiter.detect_external_limit_change(
                client,
                cycle_upload,
                current_kbps=max(0, limit_status['current_limit_kbps']),
                alt_speed_limits_active=limit_status['alt_speed_limits_active'],
            )

        is_quota_limited, limit_kbps = speed_limiter.check_and_apply_limit(
            client,
            cycle_upload,
            alt_speed_limits_active=limit_status['alt_speed_limits_active'],
        )
        traffic_db.sync_triggered_rules(name, client.speed_rules, cycle_upload)

        current_limit_kbps = limit_status['current_limit_kbps']
        has_upload_limit = limit_status['has_upload_limit']

        traffic_db.update_instance_status(
            name,
            is_online=True,
            current_speed_limit_kbps=current_limit_kbps,
            is_quota_limited=is_quota_limited,
            has_upload_limit=has_upload_limit,
            limit_source=traffic_db.get_limit_source(name),
            monthly_uploaded_bytes=cycle_upload,
            monthly_downloaded_bytes=cycle_download,
            alt_upload_limit_kbps=limit_status['alt_upload_limit_kbps'],
            alt_speed_limits_active=limit_status['alt_speed_limits_active'],
        )

        self.update_live_cache_full(
            name,
            delta_up=delta_up,
            delta_dl=delta_dl,
            limit_status=limit_status,
            info=info,
        )
        self._bump_collect_generation(name)
        self._bump_state_generation(name)

        self._maybe_log_collect_summary(
            name, cycle_upload,
            is_quota_limited, limit_kbps,
            delta_up, delta_dl, backfill_up, backfill_dl, is_backfill,
        )

    def _collect_log_bucket(self, name: str) -> dict:
        state = self._collect_log_state.get(name)
        if state is None:
            state = {
                'window_start': time.monotonic(),
                'ticks': 0,
                'delta_up': 0,
                'delta_dl': 0,
                'backfill_up': 0,
                'backfill_dl': 0,
            }
            self._collect_log_state[name] = state
        return state

    def _maybe_log_collect_summary(
        self, name: str, cycle_upload: int,
        is_quota_limited: bool, limit_kbps: int,
        delta_up: int, delta_dl: int,
        backfill_up: int, backfill_dl: int, is_backfill: bool,
    ):
        state = self._collect_log_bucket(name)
        state['ticks'] += 1
        state['delta_up'] += max(0, int(delta_up or 0))
        state['delta_dl'] += max(0, int(delta_dl or 0))
        if is_backfill:
            state['backfill_up'] += max(0, int(backfill_up or 0))
            state['backfill_dl'] += max(0, int(backfill_dl or 0))

        now_mono = time.monotonic()
        elapsed = now_mono - float(state['window_start'])
        if elapsed < _COLLECT_LOG_INTERVAL:
            return

        collect = max(1, int(self.collect_interval or 1))
        expected = max(1, _COLLECT_LOG_INTERVAL // collect)
        logger.info(format_collect_summary(
            name, elapsed, state['ticks'], expected,
            state['delta_up'], state['delta_dl'], cycle_upload,
            is_quota_limited, limit_kbps,
            state['backfill_up'], state['backfill_dl'],
        ))
        state['window_start'] = now_mono
        state['ticks'] = 0
        state['delta_up'] = 0
        state['delta_dl'] = 0
        state['backfill_up'] = 0
        state['backfill_dl'] = 0

    def _check_daily_cleanup(self):
        now = self._now()
        today = now.date()
        if self._last_cleanup_day != today:
            traffic_db.cleanup_old_data()
            emby_traffic_db.cleanup_old_data()
            self._last_cleanup_day = today

    def _check_cycle_reset(self):
        with self._config_lock:
            clients = list(self.clients.values())

        for client in clients:
            self._apply_cycle_transition_if_needed(
                client,
                log_prefix='新周期限速恢复完成',
            )

    def _get_status_traffic_batch(self, clients: dict) -> dict:
        now_mono = time.monotonic()
        names = list(clients.keys())
        with self._status_traffic_cache_lock:
            if (
                names
                and self._status_traffic_cache
                and (now_mono - self._status_traffic_cache_at)
                < self._status_traffic_cache_ttl
                and set(self._status_traffic_cache.keys()) >= set(names)
            ):
                return {
                    name: dict(self._status_traffic_cache.get(name) or {})
                    for name in names
                }

        cycle_starts = {}
        for name, client in clients.items():
            cycle_starts[name] = get_cycle_start(self._now(), client.cycle)
        batch = traffic_db.get_status_traffic_batch(names, cycle_starts)
        with self._status_traffic_cache_lock:
            self._status_traffic_cache = batch
            self._status_traffic_cache_at = now_mono
        return batch

    def get_status_summary(self) -> list:
        with self._config_lock:
            clients = dict(self.clients)

        result = []
        all_status = traffic_db.get_all_instance_status()
        status_map = {s['instance_name']: s for s in all_status}
        offline_times = traffic_db.get_last_offline_times()
        online_times = traffic_db.get_last_online_times()
        traffic_batch = self._get_status_traffic_batch(clients)
        live_map = {}
        with self._live_cache_lock:
            live_map = dict(self._live_cache)

        for name, client in clients.items():
            status = status_map.get(name, {})
            traffic = traffic_batch.get(name, {})
            cycle_upload = int(traffic.get('cycle_upload') or 0)
            cycle_download = int(traffic.get('cycle_download') or 0)
            cyc = cycle_info(self._now(), client.cycle)
            device_upload = int(traffic.get('device_upload') or 0)
            device_download = int(traffic.get('device_download') or 0)
            yesterday_upload = int(traffic.get('yesterday_upload') or 0)
            yesterday_download = int(traffic.get('yesterday_download') or 0)
            today_upload = int(traffic.get('today_upload') or 0)
            today_download = int(traffic.get('today_download') or 0)
            raw_data_start = traffic.get('data_start_time')
            data_start_time = (
                traffic_db._format_datetime_seconds(raw_data_start)
                if raw_data_start else None
            )
            cycle_gb = cycle_upload / (1024 ** 3)
            trigger_summary = traffic_db.build_limit_trigger_summary(
                name,
                client.speed_rules,
                cycle_upload,
                status.get('limit_source') or '',
                rule_trigger_times=status.get('rule_trigger_times'),
                manual_limit_trigger_at=status.get('manual_limit_trigger_at'),
                manual_limit_trigger_kbps=status.get('manual_limit_trigger_kbps'),
            )
            rule_trigger_times = trigger_summary['rule_trigger_times']

            rules = []
            for idx, rule in enumerate(client.speed_rules, start=1):
                threshold = rule.get(
                    'cycle_upload_limit_gb',
                    rule.get('monthly_upload_limit_gb', 0),
                )
                limit = rule['speed_limit_kbps']
                progress = min(100, (cycle_gb / threshold * 100)) if threshold > 0 else 0
                triggered = cycle_gb >= threshold
                rule_data = {
                    'rule_index': idx,
                    'threshold_gb': threshold,
                    'limit_kbps': limit,
                    'progress': round(progress, 1),
                    'triggered': triggered,
                }
                if triggered:
                    triggered_at = rule_trigger_times.get(str(idx))
                    if triggered_at:
                        rule_data['triggered_at'] = triggered_at
                rules.append(rule_data)

            reset_limit = client.cycle.get('reset_limit_kbps', 0)
            inst_cfg = config_manager.get_instance(name, self.config) or {}
            next_plan = inst_cfg.get('next_cycle_plan') or getattr(
                client, 'next_cycle_plan', None
            )
            has_next_cycle_plan = bool(next_plan)
            next_cycle_switch_at = (
                format_next_cycle_switch_label(self._now(), client.cycle)
                if has_next_cycle_plan else None
            )
            next_cycle_plan_payload = None
            if has_next_cycle_plan and next_plan:
                plan_cycle = next_plan.get('cycle') or {}
                plan_rules = next_plan.get('speed_rules') or []
                next_cycle_plan_payload = {
                    'cycle': {
                        'type': plan_cycle.get('type', 'month'),
                        'reset_anchor': plan_cycle.get('reset_anchor', 1),
                        'reset_limit_kbps': plan_cycle.get('reset_limit_kbps', 0),
                    },
                    'speed_rules': [
                        {
                            'cycle_upload_limit_gb': rule.get(
                                'cycle_upload_limit_gb',
                                rule.get('monthly_upload_limit_gb', 0),
                            ),
                            'speed_limit_kbps': rule.get('speed_limit_kbps', 0),
                        }
                        for rule in plan_rules
                    ],
                }

            global_upload_limit_kbps = status.get('current_speed_limit_kbps', 0)
            if global_upload_limit_kbps is None or global_upload_limit_kbps < 0:
                global_upload_limit_kbps = 0

            alt_upload_limit_kbps = int(status.get('alt_upload_limit_kbps') or 0)
            alt_speed_limits_active = bool(status.get('alt_speed_limits_active'))

            live = live_map.get(name, {})
            if name in live_map:
                is_online = bool(live.get('is_online'))
            else:
                is_online = status.get('is_online', 0) == 1

            recent_delta_bytes = status.get('last_delta_bytes', 0) or 0
            recent_delta_download_bytes = status.get('last_delta_download_bytes', 0) or 0
            if name in live_map:
                if live.get('is_online'):
                    recent_delta_bytes = live.get('recent_delta_bytes', recent_delta_bytes)
                    recent_delta_download_bytes = live.get(
                        'recent_delta_download_bytes', recent_delta_download_bytes)
                else:
                    recent_delta_bytes = 0
                    recent_delta_download_bytes = 0

            offline_since = None
            if not is_online:
                raw_offline = (
                    (live.get('offline_since') if name in live_map else None)
                    or offline_times.get(name)
                    or status.get('last_seen')
                )
                if raw_offline:
                    offline_since = traffic_db._format_datetime_seconds(raw_offline)

            online_since = None
            if is_online:
                raw_online = (
                    (live.get('online_since') if name in live_map else None)
                    or online_times.get(name)
                )
                if raw_online:
                    online_since = traffic_db._format_datetime_seconds(raw_online)

            result.append({
                'name': name,
                'display_priority': getattr(client, 'display_priority', 500),
                'host': client.host,
                'port': client.port,
                'use_https': client.use_https,
                'is_online': is_online,
                'offline_since': offline_since,
                'online_since': online_since,
                'is_quota_limited': status.get('is_quota_limited', status.get('is_limited', 0)) == 1,
                'is_limited': status.get('is_quota_limited', status.get('is_limited', 0)) == 1,
                'has_upload_limit': status.get('has_upload_limit', 0) == 1,
                'limit_source': status.get('limit_source') or '',
                'current_speed_limit_kbps': global_upload_limit_kbps,
                'global_upload_limit_kbps': global_upload_limit_kbps,
                'alt_upload_limit_kbps': alt_upload_limit_kbps,
                'alt_speed_limits_active': alt_speed_limits_active,
                'cycle_uploaded_gb': round(cycle_gb, 2),
                'cycle_uploaded_bytes': cycle_upload,
                'cycle_downloaded_bytes': cycle_download,
                'device_uploaded_bytes': device_upload,
                'device_downloaded_bytes': device_download,
                'yesterday_uploaded_bytes': yesterday_upload,
                'yesterday_downloaded_bytes': yesterday_download,
                'today_uploaded_bytes': today_upload,
                'today_downloaded_bytes': today_download,
                'recent_delta_bytes': recent_delta_bytes,
                'recent_delta_download_bytes': recent_delta_download_bytes,
                'collect_interval': self.collect_interval,
                'refresh_interval': self.refresh_interval,
                'last_update': status.get('last_update'),
                'last_limit_trigger_at': trigger_summary['last_limit_trigger_at'],
                'last_limit_trigger_label': trigger_summary['last_limit_trigger_label'],
                'manual_limit_trigger_at': trigger_summary['manual_limit_trigger_at'],
                'manual_limit_trigger_kbps': trigger_summary['manual_limit_trigger_kbps'],
                'normal_global_upload_limit_kbps': _normal_global_limit_from_status(status),
                'has_next_cycle_plan': has_next_cycle_plan,
                'next_cycle_switch_at': next_cycle_switch_at,
                'next_cycle_plan': next_cycle_plan_payload,
                'speed_rules': rules,
                'cycle': cyc,
                'reset_limit_kbps': reset_limit,
                'data_start_time': data_start_time,
                **self._generation_fields(name),
            })

        return result

    def manual_reset(self, instance_name: str = None) -> bool:
        with self._config_lock:
            if instance_name and instance_name in self.clients:
                targets = [self.clients[instance_name]]
            else:
                targets = list(self.clients.values())

        all_ok = True
        for client in targets:
            cycle_upload, _, _, _ = self._get_cycle_traffic(client.name, client)
            ok = speed_limiter.restore_speed_limit(
                client,
                reason='手动解除限速',
                cycle_uploaded_bytes=cycle_upload,
            )
            if not ok:
                all_ok = False

        self.refresh_instance_status(instance_name)
        if all_ok:
            logger.info(f"限速解除完成: {instance_name or '所有实例'}")
        else:
            logger.warning(
                f"限速解除部分失败: {instance_name or '所有实例'}",
            )
        return all_ok

    def reset_traffic_stats(self, instance_name: str):
        if not instance_name:
            raise ValueError('参数缺失')
        with self._config_lock:
            if not config_manager.get_instance(instance_name, self.config):
                raise ValueError('设备不存在')

        traffic_db.reset_instance_traffic(instance_name)
        traffic_db.add_speed_event(
            instance_name,
            'traffic_reset',
            None,
            '手动清空流量统计'
        )
        logger.info(f"流量统计重置完成: {instance_name}")

    def _promote_next_cycle_plan_if_any(self, instance_name: str) -> bool:
        inst_cfg = config_manager.get_instance(instance_name, self.config)
        if not inst_cfg or not inst_cfg.get('next_cycle_plan'):
            return False
        with self._config_lock:
            self.config = config_manager.promote_next_cycle_plan(
                self.config, instance_name)
            promoted_cfg = config_manager.get_instance(
                instance_name, self.config)
            if promoted_cfg and instance_name in self.clients:
                self.clients[instance_name].update_config(promoted_cfg)
        logger.info(f"[{instance_name}] 下周期计划已提升为当前配置")
        return True

    def mark_instance_unreachable_save(self, instance_name: str) -> None:
        """保存不可达连接信息后，立即断开并标记离线"""
        with self._config_lock:
            client = self.clients.get(instance_name)

        if client:
            client.disconnect()

        worker = self._workers.get(instance_name)
        if worker:
            worker.reset_after_unreachable_save()
            worker.wake()

        traffic_db.update_instance_status(instance_name, False)
        self.update_live_cache_offline(instance_name)
        logger.info(f"[{instance_name}] 连接信息不可达，已标记离线")

    def sync_instance_after_save(self, instance_name: str,
                               connection_changed: bool = False,
                               force_attempt: bool = False) -> bool:
        """保存后立即同步该设备全部状态；连不上则标记离线"""
        with self._config_lock:
            if instance_name not in self.clients:
                return False
            client = self.clients[instance_name]

        if force_attempt:
            client._last_connect_attempt = 0

        if not client.is_connected:
            if not force_attempt and not connection_changed:
                if not traffic_db.is_instance_online(instance_name):
                    logger.info(f"[{instance_name}] 设备离线，保存后延后同步")
                    return False
            if not client.connect(probe=True):
                logger.info(f"[{instance_name}] 无法连接，保存后延后同步")
                traffic_db.update_instance_status(instance_name, False)
                return False

        cycle_upload, _, _, _ = self._get_cycle_traffic(instance_name, client)
        speed_limiter.force_apply_quota_rules(
            client,
            cycle_upload,
            reason='保存设置后按当前周期与达量规则生效',
        )
        self.refresh_instance_status(instance_name)
        return True

    def apply_current_cycle_settings(self, instance_name: str) -> bool:
        """保存后按当前周期与达量规则立即同步卡片、统计与 qB"""
        return self.sync_instance_after_save(
            instance_name, connection_changed=True, force_attempt=True)

    def manual_set_limit(self, instance_name: str, limit_kbps: int) -> bool:
        with self._config_lock:
            if instance_name not in self.clients:
                raise ValueError('设备不存在')
            client = self.clients[instance_name]
        if not traffic_db.is_instance_online(instance_name):
            raise ValueError('设备不在线')
        cycle_upload, _, _, _ = self._get_cycle_traffic(instance_name, client)
        success = speed_limiter.force_apply_limit(
            client, limit_kbps, cycle_upload
        )
        if success:
            self.refresh_instance_status(instance_name)
        return success

    def manual_set_speed_limits_mode(self, instance_name: str, use_alt: bool) -> bool:
        with self._config_lock:
            if instance_name not in self.clients:
                raise ValueError('设备不存在')
            client = self.clients[instance_name]
        if not traffic_db.is_instance_online(instance_name):
            raise ValueError('设备不在线')
        if not client.is_connected and not client.connect(probe=True):
            raise ValueError('设备不在线')
        success = client.set_alt_speed_limits_mode(use_alt)
        if success:
            traffic_db.add_speed_event(
                instance_name,
                'speed_mode_switch',
                None,
                f"手动切换为{'备用' if use_alt else '全局'}限速模式",
            )
            self.refresh_instance_status(instance_name)
        return success

    def get_client_names(self) -> list:
        with self._config_lock:
            return list(self.clients.keys())
