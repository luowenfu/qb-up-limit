"""Emby 流量与状态采集调度"""

import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Dict, Optional
from zoneinfo import ZoneInfo

import config_manager
import emby_traffic_db
import playback_record_store
import traffic_db
import emby_playback_traffic
from emby_client import EmbyClient
from emby_docker import DockerStatsClient
from emby_traffic_filter import apply_wan_traffic_filter
from scheduler import clamp_interval, ticks_per_full_collect

logger = logging.getLogger(__name__)


def _online_since_from_prev(prev: dict, was_online: bool = None) -> str:
    if was_online is None:
        was_online = prev.get('is_online')
    if was_online:
        cached = prev.get('online_since')
        if cached:
            return cached
    return emby_traffic_db._now().strftime('%Y-%m-%d %H:%M:%S')


class EmbyInstanceWorker:
    def __init__(self, monitor: 'EmbyMonitor', name: str):
        self.monitor = monitor
        self.name = name
        self._thread: threading.Thread = None
        self._running = False
        self._wake = threading.Event()
        self._was_online = False
        self._baseline_tx = None
        self._baseline_rx = None
        self._light_ticks = 0
        self._last_sessions = []

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._loop, name=f'emby-collector-{self.name}', daemon=True,
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

    def _sleep_interval(self):
        interval = clamp_interval(self.monitor.refresh_interval)
        self._wake.wait(timeout=interval)
        self._wake.clear()

    def _ticks_per_full(self) -> int:
        return ticks_per_full_collect(
            self.monitor.collect_interval, self.monitor.refresh_interval)

    def _should_run_full_tick(self) -> bool:
        return self._light_ticks <= 0 or self._light_ticks >= self._ticks_per_full()

    def _get_client(self) -> Optional[EmbyClient]:
        with self.monitor._config_lock:
            return self.monitor.clients.get(self.name)

    def _container_ref(self, client: EmbyClient) -> str:
        return DockerStatsClient.resolve_container_ref(
            client.container_name, client.container_id)

    def _fetch_docker_stats(self, client: EmbyClient) -> Optional[dict]:
        ref = self._container_ref(client)
        if not ref:
            return None
        return self.monitor.docker.get_container_stats(ref)

    def _fetch_sessions(self, client: EmbyClient) -> list:
        try:
            return client.get_normalized_sessions()
        except Exception as e:
            logger.debug(f'[Emby:{self.name}] 获取会话失败: {e}')
            return []

    def _probe_api_online(self, client: EmbyClient) -> bool:
        return client.is_reachable()

    def _loop(self):
        while self._running and self.monitor._running:
            try:
                if self._should_run_full_tick():
                    self._tick(full=True)
                    self._light_ticks = 0
                else:
                    self._tick(full=False)
                self._light_ticks += 1
            except Exception as e:
                logger.error(f'[Emby:{self.name}] 采集循环异常: {e}', exc_info=True)
            self._sleep_interval()

    def _apply_traffic_filter(self, client: EmbyClient, delta_up: int, delta_dl: int,
                              sessions: list) -> tuple:
        sess = sessions if sessions else self._last_sessions
        return apply_wan_traffic_filter(
            delta_up, delta_dl, sess,
            enabled=getattr(client, 'wan_traffic_only', True),
        )

    def _tick(self, full: bool):
        client = self._get_client()
        if not client:
            return

        was_online = self._was_online
        api_online = self._probe_api_online(client)
        docker_stats = self._fetch_docker_stats(client) if full else None
        sessions = self._fetch_sessions(client) if api_online else []
        if api_online:
            self._last_sessions = sessions
            with self.monitor._config_lock:
                inst_cfg = config_manager.get_emby_instance(
                    self.name, self.monitor.config,
                )
            if inst_cfg:
                try:
                    playback_record_store.tick_from_sessions(
                        self.name, sessions, api_online=api_online,
                    )
                except Exception as e:
                    logger.debug(
                        f'[Emby:{self.name}] 播放段记录更新失败: {e}',
                    )
            sessions = playback_record_store.enrich_sessions_playback_started_at(
                self.name, sessions,
            )

        docker_available = self.monitor.docker.is_available()
        has_container = bool(self._container_ref(client))
        is_online = api_online or (docker_stats is not None)
        recovering = not was_online and is_online
        is_backfill = False
        backfill_up = backfill_dl = 0

        if full and docker_stats and has_container:
            raw_up, raw_dl = emby_traffic_db.peek_snapshot_deltas(
                self.name,
                docker_stats['tx_bytes'],
                docker_stats['rx_bytes'],
            )
            filt_up, filt_dl = self._apply_traffic_filter(
                client, raw_up, raw_dl, sessions)
            is_backfill = (
                recovering and emby_traffic_db.has_docker_baseline(self.name)
            )
            delta_up, delta_dl, backfill_up, backfill_dl = emby_traffic_db.save_snapshot(
                self.name,
                docker_stats['tx_bytes'],
                docker_stats['rx_bytes'],
                record_up=filt_up,
                record_down=filt_dl,
                is_backfill=is_backfill,
            )
            if is_backfill and (backfill_up > 0 or backfill_dl > 0):
                logger.info(
                    f'[Emby:{self.name}] 离线恢复补录上行='
                    f'{backfill_up / 1024 / 1024:.2f}MB'
                    f'/下行={backfill_dl / 1024 / 1024:.2f}MB'
                )
            self._baseline_tx = docker_stats['tx_bytes']
            self._baseline_rx = docker_stats['rx_bytes']
        elif not full and self._was_online and self._baseline_tx is not None:
            stats = self._fetch_docker_stats(client)
            if stats:
                tx = stats['tx_bytes']
                rx = stats['rx_bytes']
                raw_up = max(0, tx - self._baseline_tx) if tx >= self._baseline_tx else 0
                raw_dl = max(0, rx - self._baseline_rx) if rx >= self._baseline_rx else 0
                delta_up, delta_dl = self._apply_traffic_filter(
                    client, raw_up, raw_dl, sessions)
                self._baseline_tx = tx
                self._baseline_rx = rx
            else:
                delta_up = delta_dl = 0
        else:
            delta_up = delta_dl = 0

        if not is_online and self._was_online:
            logger.warning(f'[Emby:{self.name}] 连接中断，进入离线探测模式')

        emby_traffic_db.update_instance_status(
            self.name,
            is_online=is_online,
            api_online=api_online,
            docker_available=docker_available and has_container,
        )

        self.monitor.update_live_cache(
            self.name,
            is_online=is_online,
            api_online=api_online,
            docker_available=docker_available and has_container,
            delta_up=delta_up,
            delta_dl=delta_dl,
            sessions=sessions,
            full=full,
        )
        # 与 save_snapshot 同源：仅完整采集周期累计，避免轻量探测重复计入约 2 倍
        # 离线补录 tick 不把间隙流量分摊到当前会话（无法准确归属）
        if full and delta_up > 0 and sessions and not is_backfill:
            try:
                emby_playback_traffic.accumulate_wan_upload(
                    self.name,
                    sessions,
                    delta_up,
                    wan_pool_only=getattr(client, 'wan_traffic_only', True),
                )
            except Exception as e:
                logger.debug(
                    f'[Emby:{self.name}] 外网播放上行累计失败: {e}',
                )
        self._was_online = is_online


class EmbyMonitor:
    def __init__(self, config: dict, config_path: str = None):
        self.config_path = config_path or config_manager.CONFIG_PATH
        self.config = config
        self.docker = DockerStatsClient()
        self.clients: Dict[str, EmbyClient] = {}
        self._workers: Dict[str, EmbyInstanceWorker] = {}
        self._running = False
        self._config_lock = threading.Lock()
        self._live_cache: Dict[str, dict] = {}
        self._live_cache_lock = threading.Lock()
        self._collect_generation: Dict[str, int] = {}
        self._state_generation: Dict[str, int] = {}
        self._apply_global_config()
        self._init_clients()

    def _apply_global_config(self):
        self.global_cfg = config_manager.get_global_config(self.config)
        self.collect_interval = self.global_cfg.get('collect_interval', 5)
        self.refresh_interval = self.global_cfg.get('refresh_interval', 1)
        tz_name = self.global_cfg.get('timezone', 'Asia/Shanghai')
        try:
            self.timezone = ZoneInfo(tz_name)
        except Exception:
            self.timezone = ZoneInfo('Asia/Shanghai')
        traffic_db.set_timezone(self.timezone)

    def _now(self) -> datetime:
        return datetime.now(self.timezone)

    def _init_clients(self):
        if not self.global_cfg.get('emby_enabled', False):
            return
        for inst_cfg in self.config.get('emby_instances', []):
            name = inst_cfg['name']
            self.clients[name] = EmbyClient(inst_cfg)
            logger.info(
                f'初始化 Emby 实例: {name} ({inst_cfg.get("host")}:'
                f'{inst_cfg.get("port", 8096)})'
            )

    def apply_config(self, new_config: dict) -> bool:
        try:
            with self._config_lock:
                new_config = config_manager.enrich_config(new_config or {})
                self.config = new_config
                self._apply_global_config()
                enabled = bool(self.global_cfg.get('emby_enabled', False))
                new_instances = {
                    i['name']: i for i in (new_config.get('emby_instances') or [])
                } if enabled else {}
                for name in list(self.clients.keys()):
                    if name not in new_instances:
                        del self.clients[name]
                for name, inst_cfg in new_instances.items():
                    if name in self.clients:
                        self.clients[name].update_config(inst_cfg)
                    else:
                        self.clients[name] = EmbyClient(inst_cfg)
            self._sync_workers()
            return True
        except Exception as e:
            logger.error(f'Emby 配置应用失败: {e}', exc_info=True)
            return False

    def reload_config(self):
        try:
            new_config = config_manager.load_runtime_config(self.config_path)
            return self.apply_config(new_config)
        except Exception as e:
            logger.error(f'Emby 配置热重载失败: {e}', exc_info=True)
            return False

    def _sync_workers(self):
        enabled = bool(self.global_cfg.get('emby_enabled', False))
        with self._config_lock:
            names = set(self.clients.keys()) if enabled else set()
        for name in list(self._workers.keys()):
            if name not in names:
                self._workers[name].stop()
                del self._workers[name]
        if not enabled:
            return
        for name in names:
            if name not in self._workers:
                worker = EmbyInstanceWorker(self, name)
                self._workers[name] = worker
                if self._running:
                    worker.start()
            elif self._running:
                self._workers[name].wake()

    def start(self):
        self._running = True
        self._sync_workers()
        logger.info(
            f'Emby 监控已启动（数据采集 {clamp_interval(self.collect_interval)}s，'
            f'轻量探测 {clamp_interval(self.refresh_interval)}s）'
        )

    def stop(self):
        self._running = False
        for worker in self._workers.values():
            worker.stop()
        self._workers.clear()

    def _bump_collect_generation(self, name: str) -> int:
        with self._live_cache_lock:
            val = self._collect_generation.get(name, 0) + 1
            self._collect_generation[name] = val
            return val

    def _bump_state_generation(self, name: str) -> int:
        with self._live_cache_lock:
            val = self._state_generation.get(name, 0) + 1
            self._state_generation[name] = val
            return val

    def update_live_cache(self, name: str, is_online: bool, api_online: bool,
                          docker_available: bool, delta_up: int, delta_dl: int,
                          sessions: list, full: bool):
        with self._live_cache_lock:
            prev = self._live_cache.get(name, {})
            prev_api_online = prev.get('api_online', False)
            offline_since = None
            online_since = None
            if api_online:
                online_since = _online_since_from_prev(prev, prev_api_online)
            else:
                if prev_api_online:
                    offline_since = emby_traffic_db._now().strftime('%Y-%m-%d %H:%M:%S')
                else:
                    offline_since = prev.get('offline_since')
                    if not offline_since:
                        offline_since = emby_traffic_db._now().strftime('%Y-%m-%d %H:%M:%S')
            entry = {
                'name': name,
                'is_online': is_online,
                'api_online': api_online,
                'docker_available': docker_available,
                'online_since': online_since,
                'offline_since': offline_since,
                'recent_delta_bytes': delta_up,
                'recent_delta_download_bytes': delta_dl,
                'session_count': len(sessions),
                'sessions': sessions,
                'collect_generation': self._collect_generation.get(name, 0),
                'state_generation': self._state_generation.get(name, 0),
            }
            self._live_cache[name] = entry
        if full:
            self._bump_collect_generation(name)
        self._bump_state_generation(name)

    def get_live_status_summary(self) -> list:
        with self._live_cache_lock:
            cache = {k: dict(v) for k, v in self._live_cache.items()}
        result = []
        with self._config_lock:
            clients = dict(self.clients)
        for name, client in clients.items():
            live = cache.get(name, {})
            status = emby_traffic_db.get_instance_status(name)
            now = self._now()
            today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            yesterday_start = today_start - timedelta(days=1)
            month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

            today_up = emby_traffic_db.get_period_bytes(name, today_start, 'upload')
            today_dl = emby_traffic_db.get_period_bytes(name, today_start, 'download')
            yesterday_up = emby_traffic_db.get_period_bytes(name, yesterday_start, 'upload')
            yesterday_dl = emby_traffic_db.get_period_bytes(
                name, yesterday_start, 'download')
            yesterday_up -= today_up
            yesterday_dl -= today_dl
            yesterday_up = max(0, yesterday_up)
            yesterday_dl = max(0, yesterday_dl)
            month_up = emby_traffic_db.get_period_bytes(name, month_start, 'upload')
            month_dl = emby_traffic_db.get_period_bytes(name, month_start, 'download')

            device_up = emby_traffic_db.get_total_bytes(name, 'upload')
            device_dl = emby_traffic_db.get_total_bytes(name, 'download')

            api_online = live.get('api_online', status.get('api_online', 0) == 1)
            raw_data_start = emby_traffic_db.get_data_start_time(name)
            data_start_time = (
                traffic_db._format_datetime_seconds(raw_data_start)
                if raw_data_start else None
            )
            offline_since = None
            online_since = None
            if api_online:
                raw_online = live.get('online_since')
                if raw_online:
                    online_since = traffic_db._format_datetime_seconds(raw_online)
            else:
                raw_offline = live.get('offline_since') or status.get('last_update')
                if raw_offline:
                    offline_since = traffic_db._format_datetime_seconds(raw_offline)

            result.append({
                **live,
                'name': name,
                'host': client.host,
                'port': client.port,
                'use_https': client.use_https,
                'container_name': client.container_name,
                'container_id': client.container_id,
                'display_priority': client.display_priority,
                'wan_traffic_only': client.wan_traffic_only,
                'is_online': live.get('is_online', status.get('is_online', 0) == 1),
                'api_online': api_online,
                'offline_since': offline_since,
                'online_since': online_since,
                'data_start_time': data_start_time,
                'docker_available': live.get(
                    'docker_available', status.get('docker_available', 0) == 1),
                'docker_socket_available': self.docker.is_available(),
                'monthly_uploaded_bytes': month_up,
                'monthly_downloaded_bytes': month_dl,
                'today_uploaded_bytes': today_up,
                'today_downloaded_bytes': today_dl,
                'yesterday_uploaded_bytes': yesterday_up,
                'yesterday_downloaded_bytes': yesterday_dl,
                'device_uploaded_bytes': device_up,
                'device_downloaded_bytes': device_dl,
                'recent_delta_bytes': live.get('recent_delta_bytes', 0),
                'recent_delta_download_bytes': live.get(
                    'recent_delta_download_bytes', 0),
                'session_count': live.get('session_count', 0),
                'sessions': live.get('sessions') or [],
                'collect_interval': self.collect_interval,
                'refresh_interval': self.refresh_interval,
                'last_update': status.get('last_update'),
                'collect_generation': live.get(
                    'collect_generation', self._collect_generation.get(name, 0)),
                'state_generation': live.get(
                    'state_generation', self._state_generation.get(name, 0)),
            })
        result.sort(key=lambda x: (x.get('display_priority', 500), x.get('name', '')))
        return result

    def get_status_summary(self) -> list:
        return self.get_live_status_summary()

    def test_docker_container(self, container_name: str = '',
                              container_id: str = '') -> dict:
        return self.docker.test_container(container_name, container_id)

    def reset_traffic_stats(self, instance_name: str):
        if not instance_name:
            raise ValueError('参数缺失')
        with self._config_lock:
            if not config_manager.get_emby_instance(instance_name, self.config):
                raise ValueError('设备不存在')
        emby_traffic_db.reset_instance_traffic(instance_name)
        worker = self._workers.get(instance_name)
        if worker:
            client = None
            with self._config_lock:
                client = self.clients.get(instance_name)
            if client:
                stats = worker._fetch_docker_stats(client)
                if stats:
                    worker._baseline_tx = stats['tx_bytes']
                    worker._baseline_rx = stats['rx_bytes']
            worker.wake()
        self._bump_collect_generation(instance_name)
        self._bump_state_generation(instance_name)
        logger.info(f'Emby 流量统计重置完成: {instance_name}')

    def wake_all(self):
        for worker in self._workers.values():
            worker.wake()
