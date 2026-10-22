import qbittorrentapi
import logging
import threading
from typing import Optional, Dict, Tuple
from contextlib import contextmanager
import time

from requests.adapters import HTTPAdapter
from urllib3.util import Retry

from core.config_manager import INSTANCE_HTTP_TIMEOUT, DISPLAY_PRIORITY_MAX
import core.secrets_store as secrets_store

_TORRENT_COMPLETE_STATES = {
    'uploading', 'stalledUP', 'pausedUP', 'queuedUP', 'forcedUP',
    'stoppedUP', 'checkingUP',
}
_TORRENT_INCOMPLETE_STATES = {
    'downloading', 'stalledDL', 'pausedDL', 'queuedDL', 'forcedDL',
    'stoppedDL', 'checkingDL', 'metaDL', 'allocating', 'checkingResumeData',
    'missingFiles', 'error',
}


def _torrent_complete(fields: dict, previous):
    progress = fields.get('progress')
    if progress is not None:
        try:
            return float(progress) >= 0.999
        except (TypeError, ValueError):
            pass
    state = str(fields.get('state') or '')
    if state in _TORRENT_COMPLETE_STATES:
        return True
    if state in _TORRENT_INCOMPLETE_STATES:
        return False
    return bool(previous)


def _torrent_fields(fields) -> dict:
    if not fields:
        return {}
    if isinstance(fields, dict):
        return fields
    out = {}
    getter = getattr(fields, 'get', None)
    for key in ('name', 'state', 'progress', 'added_on', 'completion_on'):
        value = getter(key) if callable(getter) else getattr(fields, key, None)
        if value is not None:
            out[key] = value
    return out


def _positive_unix(value):
    try:
        ts = int(value)
    except (TypeError, ValueError):
        return None
    return ts if ts > 0 else None


def _torrent_event(event_type, name, key, when=None, backfill=False):
    name = str(name or '').strip()
    if not name:
        return None
    return {
        'event_type': event_type,
        'reason': name,
        'event_key': str(key),
        'event_time': when,
        'backfill': bool(backfill),
    }


def _history_events(key, fields, view):
    """用种子自带的添加、完成时间补历史。没有时间或没有名字的不补。"""
    name = str(view.get('name') or '').strip()
    if not name:
        return []
    fields = _torrent_fields(fields)
    events = []
    added = _positive_unix(fields.get('added_on'))
    done = _positive_unix(fields.get('completion_on'))
    if added:
        item = _torrent_event('torrent_added', name, key, added, True)
        if item:
            events.append(item)
    if done:
        item = _torrent_event('torrent_completed', name, key, done, True)
        if item:
            events.append(item)
    return events


def _live_event(event_type, name, key, fields=None):
    when = None
    if fields is not None:
        fields = _torrent_fields(fields)
        if event_type == 'torrent_added':
            when = _positive_unix(fields.get('added_on'))
        elif event_type == 'torrent_completed':
            when = _positive_unix(fields.get('completion_on'))
    return _torrent_event(event_type, name, key, when, False)


def _torrent_view(fields: dict, prev: dict = None) -> dict:
    fields = _torrent_fields(fields)
    name = str((prev or {}).get('name') or '')
    incoming = str(fields.get('name') or '').strip()
    if incoming:
        name = incoming
    complete = _torrent_complete(
        fields, None if prev is None else prev.get('complete'),
    )
    return {'name': name, 'complete': bool(complete)}


def _nonneg_int(value):
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def torrent_counter_rows(changed: dict) -> list:
    """从同步结果里取出有变化的累计上传、下载和展示字段。缺的字段不补 0。"""
    rows = []
    for torrent_hash, fields in (changed or {}).items():
        if not isinstance(fields, dict):
            continue
        key = str(torrent_hash).strip().lower()
        if not key:
            continue
        row = {'hash': key}
        if 'uploaded' in fields:
            uploaded = _nonneg_int(fields.get('uploaded'))
            if uploaded is not None:
                row['uploaded'] = uploaded
        if 'downloaded' in fields:
            downloaded = _nonneg_int(fields.get('downloaded'))
            if downloaded is not None:
                row['downloaded'] = downloaded
        if 'name' in fields:
            name = str(fields.get('name') or '').strip()
            if name:
                row['name'] = name
        if 'size' in fields:
            size = _nonneg_int(fields.get('size'))
            if size is not None:
                row['size'] = size
        if 'tracker' in fields:
            row['tracker'] = str(fields.get('tracker') or '').strip()
        if len(row) > 1:
            rows.append(row)
    return rows


def diff_torrent_sync(seen: dict, ready: bool, changed: dict,
                      removed: list, full: bool):
    """对比 qB 同步结果。首次全量建立基线，并按添加、完成时间补历史。"""
    changed = changed or {}
    removed = list(removed or [])
    if not ready:
        if not full:
            return seen, False, []
        baseline = {}
        events = []
        for torrent_hash, fields in changed.items():
            key = str(torrent_hash)
            view = _torrent_view(fields)
            baseline[key] = view
            events.extend(_history_events(key, fields, view))
        return baseline, True, events

    events = []
    seen = dict(seen or {})
    if full:
        current = {}
        for torrent_hash, fields in changed.items():
            key = str(torrent_hash)
            prev = seen.get(key)
            view = _torrent_view(fields, prev)
            current[key] = view
            if prev is None:
                item = _live_event('torrent_added', view['name'] or key, key, fields)
                if item:
                    events.append(item)
            elif not prev.get('complete') and view['complete']:
                item = _live_event(
                    'torrent_completed', view['name'] or key, key, fields,
                )
                if item:
                    events.append(item)
        for key, prev in seen.items():
            if key not in current:
                item = _torrent_event(
                    'torrent_deleted', prev.get('name') or key, key,
                )
                if item:
                    events.append(item)
        return current, True, events

    for torrent_hash in removed:
        key = str(torrent_hash)
        prev = seen.pop(key, None)
        if prev is not None:
            item = _torrent_event('torrent_deleted', prev.get('name') or key, key)
            if item:
                events.append(item)
    for torrent_hash, fields in changed.items():
        key = str(torrent_hash)
        prev = seen.get(key)
        view = _torrent_view(fields, prev)
        seen[key] = view
        if prev is None:
            item = _live_event('torrent_added', view['name'] or key, key, fields)
            if item:
                events.append(item)
        elif not prev.get('complete') and view['complete']:
            item = _live_event(
                'torrent_completed', view['name'] or key, key, fields,
            )
            if item:
                events.append(item)
    return seen, True, events

logger = logging.getLogger(__name__)


def _parse_host_config(host: str, use_https: bool) -> Tuple[str, bool, str]:
    """解析主机，返回 (api_host, use_https, hostname)"""
    host = (host or '').strip()
    if host.startswith('https://'):
        host = host[8:]
        use_https = True
    elif host.startswith('http://'):
        host = host[7:]
        use_https = False
    hostname = host.rstrip('/').split('/')[0]

    scheme = 'https' if use_https else 'http'
    return f'{scheme}://{hostname}', use_https, hostname


def _build_reverse_proxy_headers(hostname: str, port: int) -> Dict[str, str]:
    """HTTPS 反代常用请求头（勾选使用 HTTPS 时自动附带）"""
    headers = {'X-Forwarded-Proto': 'https'}
    if port and port not in (80, 443):
        host_value = f'{hostname}:{port}'
    else:
        host_value = hostname
    headers['Host'] = host_value
    headers['X-Forwarded-Host'] = host_value
    return headers


def uses_qb_auth(username: str, password: str) -> bool:
    """用户名与密码均有效时使用账号密码登录"""
    return bool(str(username or '').strip() and password)


def normalize_pref_limit_kbps(value) -> int:
    """qB app preferences 的 up_limit/alt_up_limit 为 bytes/s，转为 KiB/s 显示"""
    try:
        v = int(value)
    except (TypeError, ValueError):
        return 0
    if v <= 0:
        return 0
    return v // 1024


class QBittorrentClient:
    """qBittorrent客户端封装 - 支持HTTP/HTTPS、重连机制"""

    def __init__(self, config: dict):
        self.name = config['name']
        self.host = config['host']
        self.port = config['port']
        self.use_https = config.get('use_https', False)
        self.verify_ssl = config.get('verify_ssl', False)
        self.username = str(config.get('username', '')).strip()
        self.password = self._resolve_password(config)
        self.connection_timeout = INSTANCE_HTTP_TIMEOUT
        self.read_timeout = INSTANCE_HTTP_TIMEOUT
        self.speed_rules = config.get('speed_rules', [])
        self.next_cycle_plan = config.get('next_cycle_plan')
        self.allow_manual_unlimit = config.get(
            'allow_manual_unlimit',
            config.get('restore_on_reset', True),
        )
        self.cycle = config.get('cycle', {
            'type': 'month', 'reset_anchor': 1, 'reset_limit_kbps': 0,
        })
        try:
            self.display_priority = max(
                1, min(DISPLAY_PRIORITY_MAX, int(config.get('display_priority', 500)))
            )
        except (TypeError, ValueError):
            self.display_priority = 500

        self._client: Optional[qbittorrentapi.Client] = None
        self._connected = False
        self._is_limited = False
        self._current_limit_kbps = 0
        self._last_connect_attempt = 0
        self._reconnect_delay = 60
        self._last_connect_error = ''
        self._api_lock = threading.RLock()
        self._needs_reconnect = False
        self._session_announced = False
        self._torrent_sync_rid = 0
        self._torrent_seen = {}
        self._torrent_seen_ready = False
        self._last_counter_rows = []

    def _announce_session(self, message: str) -> None:
        if self._session_announced:
            return
        self._session_announced = True
        logger.info(message)

    @staticmethod
    def _resolve_password(config: dict) -> str:
        plain = str(config.get('password', '') or '').strip()
        if plain:
            return plain
        return secrets_store.get_qb_password(config.get('name', ''))

    def _make_client(self, probe: bool = False) -> qbittorrentapi.Client:
        """创建客户端实例；probe=True 时缩短等待、减少重试以便快速探测"""
        api_host, use_https, hostname = _parse_host_config(self.host, self.use_https)
        proxy_headers = _build_reverse_proxy_headers(hostname, self.port) if use_https else {}
        timeout = (self.connection_timeout, self.read_timeout)
        if not probe and not self._session_announced:
            logger.debug(
                f"[{self.name}] 初始化连接: {api_host}:{self.port} "
                f"(SSL验证: {'是' if self.verify_ssl else '否'}, "
                f"反代头: {'是' if proxy_headers else '否'})"
            )

        client_kwargs = dict(
            host=api_host,
            port=self.port,
            REQUESTS_ARGS={
                'timeout': timeout,
                'verify': self.verify_ssl,
                'headers': dict(proxy_headers),
            },
            VERIFY_WEBUI_CERTIFICATE=self.verify_ssl,
        )
        if use_https:
            client_kwargs['FORCE_SCHEME_FROM_HOST'] = True
        if proxy_headers:
            client_kwargs['EXTRA_HEADERS'] = proxy_headers

        client = qbittorrentapi.Client(**client_kwargs)
        if probe:
            session = getattr(client, '_session', None) or getattr(client, 'session', None)
            if session is not None:
                adapter = HTTPAdapter(max_retries=Retry(total=0, connect=0, read=0))
                session.mount('http://', adapter)
                session.mount('https://', adapter)
        return client

    def _auth_log_in(self) -> None:
        """显式账密登录；兼容反代返回 204+Cookie 而非 200 Ok. 的场景"""
        try:
            self._client.auth_log_in(
                username=self.username,
                password=self.password,
            )
        except qbittorrentapi.exceptions.LoginFailed:
            if self._client.is_logged_in:
                logger.info(
                    f"[{self.name}] 登录响应非 Ok.，但会话 Cookie 已生效（反代 204 兼容）"
                )
                return
            raise

    def _connect_without_auth(self) -> bool:
        """无需用户名密码，直接访问 Web API"""
        version = self._client.app.version
        self._connected = True
        self._last_connect_attempt = 0
        api_host, _, _ = _parse_host_config(self.host, self.use_https)
        self._announce_session(
            f"[{self.name}] 已连接 {api_host}:{self.port} "
            f"无需认证 qB={version}"
        )
        return True

    @contextmanager
    def _api_session(self):
        """持有 API 锁；若连接参数在锁忙时被修改，先断开旧连接再按新配置重连"""
        with self._api_lock:
            if self._needs_reconnect:
                self._needs_reconnect = False
                self._disconnect_unlocked()
                self._last_connect_attempt = 0
            yield

    @property
    def is_speed_testing(self) -> bool:
        return is_speed_limit_testing(self.host, self.port, self.username, self.use_https)

    def connect(self, probe: bool = False) -> bool:
        """连接到 qBittorrent；probe=True 时按采集间隔快速探测，不启用 60s 冷却"""
        with self._api_session():
            return self._connect_unlocked(probe=probe)

    def _connect_unlocked(self, probe: bool = False) -> bool:
        now = time.time()
        if not probe and self._last_connect_attempt > 0:
            elapsed = now - self._last_connect_attempt
            if elapsed < self._reconnect_delay:
                logger.debug(f"[{self.name}] 距上次连接尝试仅 {elapsed:.0f}s，跳过")
                return False

        if not probe:
            self._last_connect_attempt = now
        self._last_connect_error = ''

        try:
            self._client = self._make_client(probe=probe)

            if not uses_qb_auth(self.username, self.password):
                return self._connect_without_auth()

            if getattr(self, '_skip_auth_probe', False):
                self._auth_log_in()
                self._connected = True
                self._last_connect_attempt = 0
                self._announce_session(f"[{self.name}] 账号密码登录成功")
                return True

            try:
                return self._connect_without_auth()
            except Exception as no_auth_err:
                logger.debug(
                    f"[{self.name}] 免登未成功 ({str(no_auth_err)[:80]})，尝试账号密码登录"
                )
                self._client = self._make_client(probe=probe)
                self._auth_log_in()
                self._connected = True
                self._last_connect_attempt = 0
                self._announce_session(f"[{self.name}] 账号密码登录成功")
                return True

        except qbittorrentapi.exceptions.LoginFailed as e:
            self._disconnect_unlocked()
            self._last_connect_attempt = 0
            self._last_connect_error = '用户名或密码错误'
            if not probe:
                logger.error(f"[{self.name}] ✗ 登录失败: 用户名或密码错误 ({e})")
            return False
        except qbittorrentapi.exceptions.APIConnectionError as e:
            self._disconnect_unlocked()
            self._last_connect_error = f'无法连接到服务器，请检查地址、端口与反代配置: {e}'
            if not probe:
                logger.error(f"[{self.name}] ✗ 连接失败: {e}")
            return False
        except Exception as e:
            self._disconnect_unlocked()
            self._last_connect_attempt = 0
            self._last_connect_error = f'连接异常: {e}'
            if not probe:
                logger.error(f"[{self.name}] ✗ 未知错误: {e}")
            return False

    def probe_connect(self) -> bool:
        """离线探测：快速尝试连接后立即断开，不保留探测用会话"""
        with self._api_session():
            if self._connect_unlocked(probe=True):
                self._disconnect_unlocked()
                return True
            return False

    def disconnect(self):
        """标记连接断开（不销毁配置）"""
        with self._api_session():
            self._disconnect_unlocked()

    def _disconnect_unlocked(self):
        self._connected = False
        self._client = None
        self._session_announced = False
        self._torrent_sync_rid = 0

    def fetch_for_collection(self, prefer_probe: bool = False) -> Optional[Dict]:
        """采集专用：在线优先正式连接；离线探测时优先快速探测再正式连接"""
        with self._api_session():
            if prefer_probe:
                return self._fetch_via_probe_then_full()

            if self._connected:
                info = self._read_transfer_info_unlocked()
                if info is not None:
                    return info
                self._disconnect_unlocked()

            return self._fetch_via_probe_then_full()

    def _fetch_via_probe_then_full(self) -> Optional[Dict]:
        """先快速探测；探测失败则视为离线，不再长时间重试"""
        if not self._connect_unlocked(probe=True):
            return None
        self._disconnect_unlocked()
        if self._connect_unlocked(probe=False):
            return self._read_transfer_info_unlocked()
        return None

    def _read_transfer_info_unlocked(self) -> Optional[Dict]:
        try:
            info = self._client.transfer.info
            session_uploaded = (
                info.get('up_info_data')
                or info.get('uploaded')
                or 0
            ) or 0
            session_downloaded = (
                info.get('dl_info_data')
                or info.get('downloaded')
                or 0
            ) or 0
            return {
                'session_uploaded': session_uploaded,
                'session_downloaded': session_downloaded,
                'up_speed': (
                    info.get('up_info_speed')
                    or info.get('up_speed')
                    or 0
                ) or 0,
                'dl_speed': (
                    info.get('dl_info_speed')
                    or info.get('dl_speed')
                    or info.get('down_speed')
                    or 0
                ) or 0,
                'up_rate_limit': (
                    info.get('up_rate_limit')
                    or info.get('upload_limit')
                    or 0
                ) or 0,
            }
        except qbittorrentapi.exceptions.APIConnectionError:
            self._disconnect_unlocked()
            logger.warning(f"[{self.name}] 连接断开")
            return None
        except Exception as e:
            self._disconnect_unlocked()
            logger.error(f"[{self.name}] 获取传输信息失败: {e}")
            return None

    def poll_torrent_events(self) -> list:
        """对比种子同步结果，返回添加、下载完成、删除。首次全量按种子时间补历史。"""
        with self._api_session():
            self._last_counter_rows = []
            if not self._connected or self._client is None:
                return []
            try:
                data = self._client.sync_maindata(rid=self._torrent_sync_rid)
            except qbittorrentapi.exceptions.APIConnectionError:
                self._disconnect_unlocked()
                logger.warning(f"[{self.name}] 连接断开")
                return []
            except Exception as e:
                logger.debug(f"[{self.name}] 同步种子列表失败: {e}")
                return []
            try:
                rid = int(data.get('rid') or 0)
                changed = data.get('torrents') or {}
                removed = data.get('torrents_removed') or []
                full = bool(data.get('full_update'))
                seen, ready, events = diff_torrent_sync(
                    self._torrent_seen, self._torrent_seen_ready,
                    changed, removed, full,
                )
                counters = torrent_counter_rows(changed)
            except Exception as e:
                logger.debug(f"[{self.name}] 解析种子同步结果失败: {e}")
                return []
            self._torrent_sync_rid = rid
            self._torrent_seen = seen
            self._torrent_seen_ready = ready
            self._last_counter_rows = counters
            return [event for event in events if event.get('reason')]

    def consume_torrent_counters(self) -> list:
        """取出最近一次同步里变化的种子计数，供按时段累计。"""
        rows = self._last_counter_rows or []
        self._last_counter_rows = []
        return rows

    def list_torrent_uploads(self) -> Optional[list]:
        """当前种子的名称、累计上传下载、体积、分享率和 tracker。离线或失败时返回 None。"""
        with self._api_session():
            try:
                if not self._connected:
                    if not self._connect_unlocked(probe=True):
                        return None
                torrents = self._client.torrents_info()
            except qbittorrentapi.exceptions.APIConnectionError:
                self._disconnect_unlocked()
                logger.warning(f"[{self.name}] 连接断开")
                return None
            except Exception as e:
                logger.error(f"[{self.name}] 获取种子列表失败: {e}")
                return None
            rows = []
            for torrent in torrents or []:
                name = str(torrent.get('name') or '').strip()
                if not name:
                    continue
                try:
                    uploaded = int(torrent.get('uploaded') or 0)
                except (TypeError, ValueError):
                    uploaded = 0
                try:
                    downloaded = int(torrent.get('downloaded') or 0)
                except (TypeError, ValueError):
                    downloaded = 0
                try:
                    size = int(torrent.get('size') or 0)
                except (TypeError, ValueError):
                    size = 0
                try:
                    ratio = float(torrent.get('ratio'))
                except (TypeError, ValueError):
                    ratio = 0.0
                rows.append({
                    'name': name,
                    'uploaded': max(0, uploaded),
                    'downloaded': max(0, downloaded),
                    'size': max(0, size),
                    'ratio': ratio,
                    'tracker': str(torrent.get('tracker') or '').strip(),
                })
            return rows

    def get_transfer_info(self, probe: bool = False) -> Optional[Dict]:
        """获取传输统计信息（供状态刷新等非采集路径使用）"""
        with self._api_session():
            if not self._connected:
                if probe:
                    if not self._connect_unlocked(probe=True):
                        return None
                elif not self._connect_unlocked(probe=False):
                    return None
            return self._read_transfer_info_unlocked()

    def get_upload_limit_info(self) -> Optional[Dict]:
        """读取常规/备用上传限速及备用模式状态（只读，不修改 qB 设置）"""
        with self._api_session():
            try:
                if not self._connected:
                    if not self._connect_unlocked(probe=True):
                        return None
                prefs = self._client.app.preferences
                global_kbps = normalize_pref_limit_kbps(prefs.get('up_limit'))
                alt_kbps = normalize_pref_limit_kbps(prefs.get('alt_up_limit'))
                try:
                    alt_active = str(self._client.transfer.speed_limits_mode) == '1'
                except Exception:
                    alt_active = bool(
                        self._client.transfer.info.get('use_alt_speed_limits')
                    )
                return {
                    'global_upload_limit_kbps': global_kbps,
                    'alt_upload_limit_kbps': alt_kbps,
                    'alt_speed_limits_active': alt_active,
                }
            except qbittorrentapi.exceptions.APIConnectionError:
                self._disconnect_unlocked()
                logger.warning(f"[{self.name}] 连接断开")
                return None
            except Exception as e:
                logger.error(f"[{self.name}] 读取上传限速信息失败: {e}")
                return None

    def set_upload_limit(self, limit_bytes_per_sec: int) -> bool:
        """仅设置常规全局上传限速（app preferences up_limit），不触碰备用限速"""
        with self._api_session():
            try:
                if not self._connected:
                    if not self._connect_unlocked(probe=True):
                        return False
                limit_bytes = max(0, int(limit_bytes_per_sec))
                self._client.app_set_preferences({'up_limit': limit_bytes})
                limit_kbps = limit_bytes // 1024 if limit_bytes > 0 else 0
                self._current_limit_kbps = limit_kbps
                self._is_limited = limit_bytes > 0
                if limit_bytes > 0:
                    logger.info(
                        f"[{self.name}] ⚡ 设置全局上传限速: {limit_kbps} KB/s"
                    )
                else:
                    logger.info(f"[{self.name}] ∞ 取消全局上传限速")
                return True
            except Exception as e:
                logger.error(f"[{self.name}] 设置全局上传限速失败: {e}")
                return False

    def remove_upload_limit(self) -> bool:
        """取消常规全局上传限速"""
        return self.set_upload_limit(0)

    def set_alt_speed_limits_mode(self, enable: bool) -> bool:
        """切换 qB 全局/备用限速模式（不修改限速数值）"""
        with self._api_session():
            try:
                if not self._connected:
                    if not self._connect_unlocked(probe=True):
                        return False
                self._client.transfer.set_speed_limits_mode(intended_state=bool(enable))
                mode_label = '备用' if enable else '全局'
                logger.info(f"[{self.name}] 切换上传限速模式: {mode_label}")
                return True
            except Exception as e:
                logger.error(f"[{self.name}] 切换限速模式失败: {e}")
                return False

    def get_current_upload_limit(self) -> int:
        """获取常规全局上传限速（字节/秒），供达量/手动限速逻辑使用"""
        try:
            info = self.get_upload_limit_info()
            if not info:
                return -1
            kbps = info['global_upload_limit_kbps']
            return kbps * 1024 if kbps > 0 else 0
        except Exception as e:
            logger.error(f"[{self.name}] 获取全局上传限速失败: {e}")
            return -1

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def is_limited(self) -> bool:
        return self._is_limited

    @property
    def current_limit_kbps(self) -> int:
        return self._current_limit_kbps

    def update_config(self, config: dict):
        """热更新配置（连接参数变更时断开重连）"""
        old_key = (self.host, self.port, self.use_https, self.username, self.password)
        self.name = config['name']
        self.host = config['host']
        self.port = config['port']
        self.use_https = config.get('use_https', False)
        self.verify_ssl = config.get('verify_ssl', False)
        self.username = str(config.get('username', '')).strip()
        self.password = self._resolve_password(config)
        self.connection_timeout = INSTANCE_HTTP_TIMEOUT
        self.read_timeout = INSTANCE_HTTP_TIMEOUT
        self.speed_rules = config.get('speed_rules', [])
        self.next_cycle_plan = config.get('next_cycle_plan')
        self.allow_manual_unlimit = config.get(
            'allow_manual_unlimit',
            config.get('restore_on_reset', True),
        )
        self.cycle = config.get('cycle', {
            'type': 'month', 'reset_anchor': 1, 'reset_limit_kbps': 0,
        })
        try:
            self.display_priority = max(
                1, min(DISPLAY_PRIORITY_MAX, int(config.get('display_priority', 500)))
            )
        except (TypeError, ValueError):
            self.display_priority = 500

        new_key = (self.host, self.port, self.use_https, self.username, self.password)
        if old_key != new_key:
            if self._api_lock.acquire(blocking=False):
                try:
                    self._disconnect_unlocked()
                    self._last_connect_attempt = 0
                finally:
                    self._api_lock.release()
            else:
                self._needs_reconnect = True
                self._last_connect_attempt = 0

    def get_version(self) -> Optional[str]:
        try:
            if not self._connected and not self.connect(probe=True):
                return None
            return str(self._client.app.version)
        except Exception:
            logger.debug('读取 qB 版本失败: %s', self.name, exc_info=True)
            return None


def _test_http_timeouts(inst_config: dict) -> tuple:
    """测试使用固定 HTTP 超时（连接与读取均为 3 秒）"""
    return INSTANCE_HTTP_TIMEOUT, INSTANCE_HTTP_TIMEOUT


def _make_test_client(inst_config: dict) -> QBittorrentClient:
    conn, read = _test_http_timeouts(inst_config)
    test_cfg = {
        **inst_config,
        'connection_timeout': conn,
        'read_timeout': read,
    }
    if not test_cfg.get('name'):
        test_cfg['name'] = '_connectivity_test_'
    client = QBittorrentClient(test_cfg)
    client._reconnect_delay = 0
    client._last_connect_attempt = 0
    client._skip_auth_probe = True
    return client


def _disconnect_test_client(client: QBittorrentClient) -> None:
    client._connected = False
    client._client = None


def estimate_test_timeout(inst_config: dict, test_type: str = 'connect') -> int:
    """测试整体超时（秒），基于 HTTP 超时并留 1 秒缓冲"""
    if test_type == 'limit':
        return INSTANCE_HTTP_TIMEOUT * 5 + 1
    return INSTANCE_HTTP_TIMEOUT + 1


_speed_limit_test_locks: Dict[str, threading.Lock] = {}
_speed_limit_test_locks_guard = threading.Lock()


def _speed_limit_test_key(inst_config: dict) -> str:
    return _make_speed_test_key(
        inst_config.get('host', ''), inst_config.get('port'),
        inst_config.get('username', ''), inst_config.get('use_https'))


def _make_speed_test_key(host, port, username, use_https) -> str:
    host = str(host or '').strip().lower()
    try:
        port = int(port or 0)
    except (TypeError, ValueError):
        port = 0
    user = str(username or '').strip()
    https = '1' if use_https else '0'
    return f'{host}:{port}:{user}:{https}'


# 限速测试进行中（及恢复后宽限期）的实例：key -> 截止时间戳；期间跳过外部修改检测
_SPEED_TEST_GRACE_SECONDS = 2.0
_speed_testing_until: Dict[str, float] = {}
_speed_testing_guard = threading.Lock()


def is_speed_limit_testing(host, port, username, use_https) -> bool:
    key = _make_speed_test_key(host, port, username, use_https)
    with _speed_testing_guard:
        until = _speed_testing_until.get(key)
        if until is None:
            return False
        if time.time() < until:
            return True
        _speed_testing_until.pop(key, None)
        return False


def _acquire_speed_limit_test_lock(inst_config: dict) -> Tuple[threading.Lock, bool]:
    """同一 qB 实例同时只允许一个限速测试，避免连点导致互相恢复限速"""
    key = _speed_limit_test_key(inst_config)
    with _speed_limit_test_locks_guard:
        if key not in _speed_limit_test_locks:
            _speed_limit_test_locks[key] = threading.Lock()
        lock = _speed_limit_test_locks[key]
    return lock, lock.acquire(blocking=False)



def run_connection_test(inst_config: dict) -> dict:
    """验证域名/IP、端口、用户名与密码（与后台采集使用相同连接方式）"""
    steps = []
    client = _make_test_client(inst_config)

    def add_step(step_id: str, ok: bool, message: str):
        steps.append({'step': step_id, 'ok': ok, 'message': message})

    try:
        if not inst_config.get('host', '').strip():
            add_step('connect', False, '请填写域名或 IP 地址')
            return {'success': False, 'steps': steps}
        user = str(inst_config.get('username', '')).strip()
        pwd = inst_config.get('password', '') or ''
        if pwd and not user:
            add_step('connect', False, '填写了密码时请填写用户名')
            return {'success': False, 'steps': steps}
        if user and not pwd:
            add_step('connect', False, '请填写密码后再测试')
            return {'success': False, 'steps': steps}

        if not client.connect(probe=True):
            msg = client._last_connect_error or '连接失败，请检查地址、端口与登录凭据'
            add_step('connect', False, msg)
            return {'success': False, 'steps': steps}

        add_step('connect', True, '连接成功！')
        return {'success': True, 'steps': steps}
    except Exception as e:
        add_step('connect', False, f'连接异常: {e}')
        return {'success': False, 'steps': steps}
    finally:
        _disconnect_test_client(client)


def run_speed_limit_test(inst_config: dict, test_limit_kbps: int = 12345) -> dict:
    """限速测试：读取当前限速 → 设为测试值 → 验证 → 恢复原限速"""
    lock, acquired = _acquire_speed_limit_test_lock(inst_config)
    if not acquired:
        return {
            'success': False,
            'error': '限速测试正在进行中，请稍候再试',
            'steps': [],
        }

    steps = []
    client = _make_test_client(inst_config)
    testing_key = _speed_limit_test_key(inst_config)
    with _speed_testing_guard:
        _speed_testing_until[testing_key] = float('inf')

    def add_step(step_id: str, ok: bool, message: str):
        steps.append({'step': step_id, 'ok': ok, 'message': message})

    try:
        if not client.connect(probe=True):
            msg = client._last_connect_error or '连接失败，请先确认连通性测试通过或检查连接设置'
            return {
                'success': False,
                'error': msg,
                'steps': [],
            }

        original_bytes = client.get_current_upload_limit()
        if original_bytes < 0:
            add_step('read_limit', False, '读取当前上传限速失败')
            return {'success': False, 'steps': steps}
        original_kbps = original_bytes // 1024
        if original_kbps > 0:
            add_step('read_limit', True, f'当前全局上传限速: {original_kbps} KB/s')
        else:
            add_step('read_limit', True, '当前全局上传限速: 无限速')

        test_bytes = test_limit_kbps * 1024
        if not client.set_upload_limit(test_bytes):
            add_step('set_limit', False, f'设置限速测试值 {test_limit_kbps} KB/s 失败')
            return {'success': False, 'steps': steps}
        add_step('set_limit', True, f'已设置限速为测试值 {test_limit_kbps} KB/s')

        actual_kbps = -1
        for _ in range(8):
            time.sleep(0.15)
            actual_bytes = client.get_current_upload_limit()
            actual_kbps = actual_bytes // 1024 if actual_bytes >= 0 else -1
            if actual_kbps == test_limit_kbps:
                break
        if actual_kbps != test_limit_kbps:
            add_step('verify', False,
                     f'验证失败: 期望 {test_limit_kbps} KB/s，实际 {actual_kbps} KB/s')
            client.set_upload_limit(original_bytes)
            return {'success': False, 'steps': steps}
        add_step('verify', True, f'验证成功，限速已生效: {actual_kbps} KB/s')

        if client.set_upload_limit(original_bytes):
            if original_kbps > 0:
                add_step('restore', True, f'已恢复原限速: {original_kbps} KB/s')
            else:
                add_step('restore', True, '已恢复为无限速')
        else:
            add_step('restore', False, '恢复原限速失败，请手动检查 qBittorrent 设置')
            return {'success': False, 'steps': steps}

        return {'success': True, 'steps': steps}
    except Exception as e:
        add_step('error', False, f'测试异常: {e}')
        return {'success': False, 'steps': steps}
    finally:
        _disconnect_test_client(client)
        with _speed_testing_guard:
            _speed_testing_until[testing_key] = time.time() + _SPEED_TEST_GRACE_SECONDS
        lock.release()


def run_connectivity_test(inst_config: dict, test_limit_kbps: int = 128) -> dict:
    """完整测试（兼容旧接口）：连通性 + 限速设置"""
    conn = run_connection_test(inst_config)
    if not conn['success']:
        return conn
    limit = run_speed_limit_test(inst_config, test_limit_kbps)
    limit_steps = [s for s in limit.get('steps', []) if s['step'] != 'connect']
    return {
        'success': limit['success'],
        'steps': conn['steps'] + limit_steps,
    }
