"""Emby Server REST API 客户端"""

import logging
import re
from datetime import datetime, timezone
from typing import Optional, Dict, List
from urllib.parse import quote

import requests

from emby.traffic.filter import is_wan_endpoint, parse_endpoint_ip

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 5
DEFAULT_SESSION_MESSAGE_TIMEOUT_MS = 8000

EMBY_LOG_LINE_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+'
    r'(Debug|Info|Warn|Warning|Error|Fatal)\s+(.*)$',
    re.IGNORECASE,
)

_LEVEL_MAP = {
    'debug': 'DEBUG',
    'info': 'INFO',
    'warn': 'WARNING',
    'warning': 'WARNING',
    'error': 'ERROR',
    'fatal': 'CRITICAL',
}

PLAYBACK_EVENT_TYPES = frozenset({
    'VideoPlayback', 'VideoPlaybackStopped', 'VideoPlaybackPaused', 'VideoPlaybackUnpaused',
    'playback.start', 'playback.stop', 'playback.pause', 'playback.unpause',
    'video.playback.start', 'video.playback.stop', 'video.pause', 'video.unpause',
})

_GENERIC_PLAYBACK_NAMES = frozenset({
    '开始播放', '停止播放', '暂停播放', '继续播放',
    'Start Playing', 'Stopped Playing', 'Paused Playing', 'Resumed Playing',
})

_PLAYBACK_NAME_PATTERNS = [
    re.compile(
        r'^(?P<user>.+?) has (?:started|finished|stopped|paused|resumed) playing '
        r'(?P<title>.+?) on (?P<client>.+?)\.?$',
        re.IGNORECASE,
    ),
    re.compile(
        r'^(?P<user>.+?) is playing (?P<title>.+?) on (?P<client>.+?)\.?$',
        re.IGNORECASE,
    ),
    re.compile(r'^(?P<user>.+?) 在 (?P<client>.+?) 上开始播放 (?P<title>.+?)\.?$'),
    re.compile(r'^(?P<user>.+?) 在 (?P<client>.+?) 上停止播放 (?P<title>.+?)\.?$'),
    re.compile(r'^(?P<user>.+?) 在 (?P<client>.+?) 上结束播放 (?P<title>.+?)\.?$'),
    re.compile(r'^(?P<user>.+?) 在 (?P<client>.+?) 上暂停播放 (?P<title>.+?)\.?$'),
    re.compile(r'^(?P<user>.+?) 在 (?P<client>.+?) 上继续播放 (?P<title>.+?)\.?$'),
    re.compile(r'^(?P<user>.+?) 正在 (?P<client>.+?) 上播放 (?P<title>.+?)\.?$'),
    re.compile(r'^(?P<user>.+?) 已在 (?P<client>.+?) 上开始播放 (?P<title>.+?)\.?$'),
    re.compile(r'^(?P<user>.+?) 已在 (?P<client>.+?) 上结束播放 (?P<title>.+?)\.?$'),
    re.compile(r'^(?P<user>.+?) 已在 (?P<client>.+?) 上停止播放 (?P<title>.+?)\.?$'),
]

_ITEM_DETAIL_FIELDS = (
    'IndexNumber,ParentIndexNumber,SeriesName,Name,Type,'
    'EpisodeTitle,ProductionYear,PremiereDate,Size,Bitrate,MediaSources'
)

_MOVIE_YEAR_LOOKUP_LIMIT = 5

_PLAYBACK_TITLE_EXTRACT = re.compile(
    r'上(?:开始|停止|结束|暂停|继续)?播放 (?P<title>.+?)\.?$'
)

_PLAYBACK_OVERVIEW_PATTERNS = [
    re.compile(
        r'^(?P<series>.+?) · (?P<label>S\d{1,2}E\d{1,2}) — (?P<title>.+?)\.?$'
    ),
    re.compile(
        r'^(?P<series>.+?) · (?P<label>S\d{1,2}E\d{1,2}) - (?P<title>.+?)\.?$'
    ),
    re.compile(r'(?P<label>S\d{1,2}E\d{1,2})'),
]


def parse_emby_log_line(line: str) -> dict:
    """解析 Emby 服务器日志行，返回与 qB 系统日志相近的结构。"""
    raw = (line or '').rstrip('\r\n')
    match = EMBY_LOG_LINE_RE.match(raw.strip())
    if not match:
        return {
            'time': '',
            'level': 'INFO',
            'logger': '',
            'message': raw,
            'raw': raw,
        }
    level = _LEVEL_MAP.get(match.group(2).lower(), match.group(2).upper())
    remainder = match.group(3)
    logger = ''
    message = remainder
    if ': ' in remainder:
        logger, message = remainder.split(': ', 1)
    return {
        'time': match.group(1),
        'level': level,
        'logger': logger,
        'message': message,
        'raw': raw,
    }


def _parse_host(host: str, use_https: bool) -> tuple:
    host = (host or '').strip()
    if host.startswith('https://'):
        host = host[8:]
        use_https = True
    elif host.startswith('http://'):
        host = host[7:]
    hostname = host.rstrip('/').split('/')[0]
    scheme = 'https' if use_https else 'http'
    return f'{scheme}://{hostname}', use_https, hostname


_SERVER_PLAYBACK_BROWSE_MARKERS = (
    'videoplayback',
    'started playing',
    'stopped playing',
    'paused playing',
    'resumed playing',
    'finished playing',
    'is playing',
    '开始播放',
    '停止播放',
    '暂停播放',
    '继续播放',
    '结束播放',
    '正在播放',
    '上开始播放',
    '上停止播放',
    '上结束播放',
    '上暂停播放',
    '上继续播放',
    '上选片',
    '上播放',
    'browsing',
    'is viewing',
)


def is_playback_browse_server_log_message(message: str) -> bool:
    """Emby 服务器日志中的播放/选片活动行（不进入系统日志）。"""
    msg = str(message or '').strip().casefold()
    if not msg:
        return False
    return any(marker in msg for marker in _SERVER_PLAYBACK_BROWSE_MARKERS)


class EmbyClient:
    """Emby API 封装 — 仅 GET 请求"""

    def __init__(self, config: dict):
        self.name = config['name']
        self.host = config.get('host', '')
        self.port = int(config.get('port') or 8096)
        self.use_https = bool(config.get('use_https', False))
        self.verify_ssl = bool(config.get('verify_ssl', False))
        self.api_key = str(config.get('api_key') or '').strip()
        self.connection_timeout = float(config.get('connection_timeout') or DEFAULT_TIMEOUT)
        try:
            self.display_priority = max(1, min(99999, int(config.get('display_priority', 500))))
        except (TypeError, ValueError):
            self.display_priority = 500
        self.wan_traffic_only = bool(config.get('wan_traffic_only', True))
        self.traffic_collect_mode = str(config.get('traffic_collect_mode') or '').strip().lower()
        if self.traffic_collect_mode != 'lucky':
            self.traffic_collect_mode = ''
        self.lucky_base_url = str(config.get('lucky_base_url') or '').strip()
        self.lucky_verify_ssl = bool(config.get('lucky_verify_ssl', False))
        self.lucky_rules = EmbyClient._lucky_rules_from_config(config)
        first = self.lucky_rules[0] if self.lucky_rules else {}
        self.lucky_rule_key = str(first.get('rule_key') or config.get('lucky_rule_key') or '').strip()
        self.lucky_sub_key = str(first.get('sub_key') or config.get('lucky_sub_key') or '').strip()
        labels = [str(item.get('label') or '').strip() for item in self.lucky_rules]
        labels = [item for item in labels if item]
        self.lucky_rule_label = '；'.join(labels) or str(config.get('lucky_rule_label') or '').strip()
        self.lucky_frontend_host = str(config.get('lucky_frontend_host') or '').strip()
        self.lucky_credit_browse_traffic = bool(
            config.get('lucky_credit_browse_traffic', False),
        )

    @staticmethod
    def _lucky_rules_from_config(config: dict) -> list:
        rules = []
        seen = set()
        for item in config.get('lucky_rules') or []:
            if not isinstance(item, dict):
                continue
            rule_key = str(item.get('rule_key') or '').strip()
            sub_key = str(item.get('sub_key') or '').strip()
            if not rule_key or not sub_key or (rule_key, sub_key) in seen:
                continue
            seen.add((rule_key, sub_key))
            rules.append({
                'rule_key': rule_key,
                'sub_key': sub_key,
                'label': str(item.get('label') or '').strip(),
            })
        if rules:
            return rules
        rule_key = str(config.get('lucky_rule_key') or '').strip()
        sub_key = str(config.get('lucky_sub_key') or '').strip()
        if rule_key and sub_key:
            return [{
                'rule_key': rule_key,
                'sub_key': sub_key,
                'label': str(config.get('lucky_rule_label') or '').strip(),
            }]
        return []

    @property
    def upload_tracking_enabled(self) -> bool:
        return self.traffic_collect_mode == 'lucky'

    def update_config(self, config: dict):
        self.__init__(config)

    def _base_url(self) -> str:
        api_host, _, _ = _parse_host(self.host, self.use_https)
        return f'{api_host}:{self.port}'

    def _headers(self) -> dict:
        headers = {'Accept': 'application/json'}
        if self.api_key:
            headers['X-Emby-Token'] = self.api_key
        return headers

    def _request(self, method: str, path: str, params: dict = None,
                 timeout: float = None) -> Optional[requests.Response]:
        url = f'{self._base_url()}{path}'
        try:
            return requests.request(
                method,
                url,
                headers=self._headers(),
                params=params,
                timeout=timeout or self.connection_timeout,
                verify=self.verify_ssl,
            )
        except requests.RequestException as e:
            logger.debug(f'[{self.name}] Emby 请求失败 {path}: {e}')
            return None

    def is_reachable(self) -> bool:
        resp = self._request('GET', '/System/Ping', timeout=2)
        return resp is not None and resp.status_code < 400

    def test_connectivity(self) -> dict:
        """检测地址/端口/HTTPS 是否可达，不校验 API Key"""
        if not self.host:
            return {'ok': False, 'error': '请填写主机地址'}
        url = f'{self._base_url()}/System/Ping'
        try:
            resp = requests.get(
                url,
                timeout=self.connection_timeout,
                verify=self.verify_ssl,
            )
        except requests.RequestException:
            return {'ok': False, 'error': '无法连接 Emby 服务器'}
        if resp.status_code >= 400:
            return {'ok': False, 'error': f'HTTP {resp.status_code}'}
        ping = (resp.text or '').strip()
        return {
            'ok': True,
            'ping': ping or 'OK',
            'message': '连接成功',
        }

    def test_api(self) -> dict:
        """校验 API Key 是否有效"""
        if not self.api_key:
            return {'ok': False, 'error': '请填写 API Key'}
        resp = self._request('GET', '/System/Info')
        if resp is None:
            return {'ok': False, 'error': '无法连接 Emby 服务器'}
        if resp.status_code == 401:
            return {'ok': False, 'error': 'API Key 无效或未授权'}
        if resp.status_code >= 400:
            return {'ok': False, 'error': f'HTTP {resp.status_code}'}
        try:
            info = resp.json()
        except ValueError:
            info = {}
        return {
            'ok': True,
            'server_name': info.get('ServerName') or '',
            'version': info.get('Version') or '',
            'message': 'API 验证成功',
        }

    def test_connection(self) -> dict:
        """兼容旧调用：等同 API 测试"""
        return self.test_api()

    def get_users(self) -> List[dict]:
        """获取服务端用户列表（需有效 API Key，建议管理员密钥）。"""
        resp = self._request('GET', '/Users')
        if resp is None or resp.status_code >= 400:
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        if not isinstance(data, list):
            return []
        users = []
        for item in data:
            if not isinstance(item, dict):
                continue
            name = str(item.get('Name') or '').strip()
            user_id = str(item.get('Id') or '').strip()
            if not name:
                continue
            users.append({
                'id': user_id,
                'name': name,
                'is_hidden': bool((item.get('Policy') or {}).get('IsHidden')),
                'is_disabled': bool((item.get('Policy') or {}).get('IsDisabled')),
            })
        users.sort(key=lambda row: row['name'].casefold())
        return users

    def get_sessions(self) -> List[dict]:
        resp = self._request('GET', '/Sessions')
        if resp is None or resp.status_code >= 400:
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        return data if isinstance(data, list) else []

    def get_activity_log(self, limit: int = 100, min_date: str = None) -> List[dict]:
        params = {'Limit': min(limit, 500)}
        if min_date:
            params['MinDate'] = min_date
        resp = self._request('GET', '/System/ActivityLog/Entries', params=params)
        if resp is None or resp.status_code >= 400:
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        if isinstance(data, dict):
            return data.get('Items') or []
        return data if isinstance(data, list) else []

    def get_item(self, item_id: str, user_id: str = None) -> Optional[dict]:
        if not item_id:
            return None
        encoded = quote(str(item_id), safe='')
        params = {'Fields': _ITEM_DETAIL_FIELDS}
        paths = []
        if user_id:
            uid = quote(str(user_id), safe='')
            paths.append(f'/Users/{uid}/Items/{encoded}')
        paths.append(f'/Items/{encoded}')
        for path in paths:
            resp = self._request('GET', path, params=params)
            if resp is None or resp.status_code >= 400:
                continue
            try:
                data = resp.json()
            except ValueError:
                continue
            if isinstance(data, dict):
                return data
        return None

    def get_items_by_ids(self, item_ids) -> Optional[list]:
        """按编号批量取条目。请求失败返回 None，查无条目返回空列表。"""
        ids = []
        seen = set()
        for raw in item_ids or []:
            item_id = str(raw or '').strip()
            if not item_id or item_id in seen:
                continue
            seen.add(item_id)
            ids.append(item_id)
        if not ids:
            return []
        found = []
        for offset in range(0, len(ids), 40):
            chunk = ids[offset:offset + 40]
            resp = self._request('GET', '/Items', params={
                'Ids': ','.join(chunk),
                'Fields': 'Genres,SeriesId,Type',
                'EnableTotalRecordCount': 'false',
            })
            if resp is None or resp.status_code >= 400:
                return None
            try:
                data = resp.json()
            except ValueError:
                return None
            if isinstance(data, dict):
                items = data.get('Items') or []
            elif isinstance(data, list):
                items = data
            else:
                items = []
            found.extend(item for item in items if isinstance(item, dict))
        return found

    def lookup_series_by_name(self, name: str):
        """按剧名精确查找剧集。找到返回条目，没有返回空字典，请求失败返回 None。"""
        raw = (name or '').strip()
        if not raw:
            return {}
        resp = self._request('GET', '/Items', params={
            'Recursive': 'true',
            'SearchTerm': raw,
            'IncludeItemTypes': 'Series',
            'Limit': '8',
            'Fields': 'Genres',
            'EnableTotalRecordCount': 'false',
        })
        if resp is None or resp.status_code >= 400:
            return None
        try:
            data = resp.json()
        except ValueError:
            return None
        items = data.get('Items') if isinstance(data, dict) else data
        if not isinstance(items, list):
            return {}
        key = raw.casefold()
        for item in items:
            if not isinstance(item, dict):
                continue
            if (item.get('Name') or '').strip().casefold() == key:
                return item
        return {}

    def _query_items(self, params: dict, user_id: str = None) -> List[dict]:
        paths = []
        if user_id:
            uid = quote(str(user_id), safe='')
            paths.append(f'/Users/{uid}/Items')
        paths.append('/Items')
        for path in paths:
            resp = self._request('GET', path, params=params)
            if resp is None or resp.status_code >= 400:
                continue
            try:
                data = resp.json()
            except ValueError:
                continue
            if isinstance(data, dict):
                items = data.get('Items') or []
            elif isinstance(data, list):
                items = data
            else:
                items = []
            if items:
                return items
        return []

    def lookup_movie_year(self, title: str, user_id: str = None,
                          item_cache: dict = None) -> Optional[int]:
        raw_title = (title or '').strip()
        if not raw_title:
            return None
        cache = item_cache if item_cache is not None else {}
        cache_key = ('movie_year', str(user_id or ''), raw_title.casefold())
        if cache_key in cache:
            return cache[cache_key]

        params = {
            'Recursive': 'true',
            'SearchTerm': raw_title,
            'IncludeItemTypes': 'Movie',
            'Limit': _MOVIE_YEAR_LOOKUP_LIMIT,
            'Fields': _ITEM_DETAIL_FIELDS,
        }
        year = None
        title_key = raw_title.casefold()
        for item in self._query_items(params, user_id):
            name = (item.get('Name') or '').strip()
            if not name:
                continue
            if name.casefold() != title_key and name != raw_title:
                continue
            year = EmbyClient.extract_production_year(item)
            if year is not None:
                break
        cache[cache_key] = year
        return year

    def resolve_production_year(self, meta: dict,
                                item_cache: dict = None) -> Optional[int]:
        if not meta:
            return None
        cache = item_cache if item_cache is not None else {}
        item_id = str(meta.get('item_id') or '').strip()
        user_id = meta.get('user_id') or ''
        if item_id:
            cache_key = ('item', item_id)
            if cache_key not in cache:
                cache[cache_key] = self.get_item(item_id, user_id or None)
            item = cache.get(cache_key)
            year = EmbyClient.extract_production_year(item) if item else None
            if year is not None:
                return year
        if meta.get('series_name'):
            return None
        title = (meta.get('item_title') or '').strip()
        if not title:
            return None
        return self.lookup_movie_year(title, user_id or None, cache)

    def list_server_logs(self) -> List[dict]:
        resp = self._request('GET', '/System/Logs/Query')
        if resp is None or resp.status_code >= 400:
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        if isinstance(data, dict):
            return data.get('Items') or []
        return data if isinstance(data, list) else []

    def get_server_log_lines(self, log_name: str, limit: int = 500) -> List[str]:
        if not log_name:
            return []
        encoded = quote(log_name, safe='')
        resp = self._request(
            'GET',
            f'/System/Logs/{encoded}/Lines',
            params={'Limit': min(limit, 1000)},
        )
        if resp is None or resp.status_code >= 400:
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        if isinstance(data, list):
            return [str(x) for x in data]
        return []

    @staticmethod
    def is_emby_abnormal_disconnect_session(session: dict) -> bool:
        """Emby 仍挂 NowPlayingItem/TranscodingInfo，但客户端已异常断开。"""
        if not isinstance(session, dict):
            return False
        play_state = session.get('PlayState') or {}
        now_playing = session.get('NowPlayingItem') or {}
        if not isinstance(now_playing, dict):
            now_playing = {}
        if bool(play_state.get('IsPaused')):
            return False
        if not (now_playing.get('Id') or now_playing.get('Name')):
            return False
        if 'IsPlaying' in play_state and bool(play_state.get('IsPlaying')):
            return False
        supports_remote = bool(session.get('SupportsRemoteControl'))
        if 'IsPlaying' in play_state and not play_state.get('IsPlaying'):
            # 长暂停空窗常 IsPlaying=false 但客户端仍在线；不可遥控则视为异常断开
            return not supports_remote
        if (
            'IsPlaying' not in play_state
            and session.get('TranscodingInfo')
            and not supports_remote
        ):
            return True
        return False

    @staticmethod
    def _session_is_actively_playing(now_playing: dict, play_state: dict,
                                     transcoding: dict) -> bool:
        """Emby Web 外网停止后常保留 NowPlayingItem；需结合 PlayState/转码信息判定。"""
        if not now_playing:
            return False
        play_state = play_state or {}
        # 暂停时 Emby 常设 IsPlaying=false；须先于 IsPlaying 判定，避免误判为停止。
        if bool(play_state.get('IsPaused')):
            return True
        if 'IsPlaying' in play_state:
            return bool(play_state.get('IsPlaying'))
        # IsPlaying 缺失时不凭 TranscodingInfo 推断在播；DirectStream 等仍可用 PlayMethod
        play_method = str(play_state.get('PlayMethod') or '').strip()
        return bool(play_method)

    @staticmethod
    def session_has_now_playing_media(session: dict) -> bool:
        """会话是否挂着正在观看的媒资（含暂停）。"""
        if not isinstance(session, dict):
            return False
        if str(session.get('item_id') or '').strip():
            return True
        if str(session.get('title') or '').strip():
            return True
        if str(session.get('series_name') or '').strip():
            return True
        now_playing = session.get('NowPlayingItem') or {}
        if isinstance(now_playing, dict):
            if str(now_playing.get('Id') or '').strip():
                return True
            if str(now_playing.get('Name') or '').strip():
                return True
        return False

    @staticmethod
    def is_current_playback_session(session: dict) -> bool:
        """与设备卡片「当前播放会话」口径一致：有媒资且仍在播或暂停。"""
        if not isinstance(session, dict):
            return False
        if session.get('NowPlayingItem') or session.get('PlayState'):
            prepared = EmbyClient.normalize_session(session)
        else:
            prepared = session
        if EmbyClient.is_emby_abnormal_disconnect_session(session):
            return False
        if not EmbyClient.session_has_now_playing_media(prepared):
            return False
        if bool(prepared.get('is_paused')):
            return True
        if bool(prepared.get('is_playing')):
            return True
        # Emby Web 长暂停空窗：NowPlayingItem 仍在而 IsPlaying/IsPaused 均为 false。
        if str(prepared.get('session_mode') or '').strip() == 'paused':
            return True
        return False

    @staticmethod
    def is_active_playback_stream(session: dict) -> bool:
        """正在推流播放（非选片/暂停）——选片累加器不得再写入。"""
        if not isinstance(session, dict):
            return False
        if session.get('NowPlayingItem') or session.get('PlayState'):
            prepared = EmbyClient.normalize_session(session)
        else:
            prepared = session
        if str(prepared.get('session_mode') or '').strip() != 'playing':
            return False
        return EmbyClient.session_has_now_playing_media(prepared)

    @staticmethod
    def is_live_playback_session(session: dict) -> bool:
        if not isinstance(session, dict):
            return False
        if not bool(session.get('is_playing')):
            return False
        return not bool(session.get('is_paused'))

    @staticmethod
    def _is_remote_session(remote_endpoint: str) -> bool:
        return is_wan_endpoint(remote_endpoint)

    @staticmethod
    def _normalize_client_key(name: str) -> str:
        return re.sub(r'\s+', ' ', (name or '').strip().casefold())

    @staticmethod
    def _user_name_key(record: dict) -> str:
        return (
            record.get('user_name') or record.get('UserName') or ''
        ).strip().casefold()

    @staticmethod
    def users_match(left: dict, right: dict) -> bool:
        left_name = EmbyClient._user_name_key(left or {})
        right_name = EmbyClient._user_name_key(right or {})
        if left_name and right_name:
            return left_name == right_name
        left_uid = str(
            (left or {}).get('user_id') or (left or {}).get('UserId') or '',
        ).strip()
        right_uid = str(
            (right or {}).get('user_id') or (right or {}).get('UserId') or '',
        ).strip()
        if left_uid and right_uid:
            return left_uid == right_uid
        return False

    @staticmethod
    def clients_loosely_match(left_client: str, right_client: str) -> bool:
        left_key = EmbyClient._normalize_client_key(left_client)
        right_key = EmbyClient._normalize_client_key(right_client)
        if not left_key or not right_key:
            return True
        return (
            left_key == right_key
            or left_key in right_key
            or right_key in left_key
        )

    @staticmethod
    def playback_media_match(event: dict, other: dict) -> bool:
        item_id = str((event or {}).get('item_id') or '').strip()
        other_item = str(
            (other or {}).get('item_id') or (other or {}).get('ItemId') or '',
        ).strip()
        if item_id and other_item:
            return item_id == other_item

        series = (event.get('series_name') or '').casefold()
        title = (event.get('item_title') or '').casefold()
        now_playing = other.get('NowPlayingItem') or {}
        if not isinstance(now_playing, dict):
            now_playing = {}
        other_series = (
            other.get('series_name') or now_playing.get('SeriesName') or ''
        ).casefold()
        other_title = (
            other.get('title') or other.get('item_title')
            or other.get('episode_title') or now_playing.get('Name') or ''
        ).casefold()

        series_ok = bool(
            series and other_series and (
                series == other_series
                or series in other_series
                or other_series in series
            )
        )
        title_ok = bool(
            title and other_title and (
                title == other_title
                or title in other_title
                or other_title in title
            )
        )
        if series and other_series and title and other_title:
            return series_ok and title_ok
        if title and other_title:
            return title_ok
        if series and other_series:
            return series_ok
        return False

    @staticmethod
    def playback_events_match(event: dict, other: dict,
                              max_age_seconds: int = 7200) -> bool:
        if (event.get('type') or '') not in PLAYBACK_EVENT_TYPES:
            return False
        if not EmbyClient.users_match(event, other):
            return False
        if not EmbyClient.playback_media_match(event, other):
            return False
        event_dt = EmbyClient._parse_emby_datetime(event.get('date') or '')
        if not event_dt:
            return True
        if event_dt.tzinfo is None:
            event_dt = event_dt.replace(tzinfo=timezone.utc)
        age = (
            datetime.now(timezone.utc) - event_dt.astimezone(timezone.utc)
        ).total_seconds()
        return age <= max_age_seconds

    @staticmethod
    def _parse_emby_datetime(value: str) -> Optional[datetime]:
        raw = (value or '').strip()
        if not raw:
            return None
        try:
            if raw.endswith('Z'):
                raw = raw[:-1] + '+00:00'
            return datetime.fromisoformat(raw)
        except ValueError:
            return None

    @staticmethod
    def derive_transcode_kind(play_method: str,
                              is_video_direct: bool = None,
                              is_audio_direct: bool = None) -> str:
        method = (play_method or '').strip()
        if method == 'DirectPlay':
            return 'direct_play'
        if method == 'DirectStream':
            return 'direct_stream'
        if method != 'Transcode':
            return ''

        video_direct = True if is_video_direct is None else bool(is_video_direct)
        audio_direct = True if is_audio_direct is None else bool(is_audio_direct)
        if not video_direct and audio_direct:
            return 'video_transcode'
        if video_direct and not audio_direct:
            return 'audio_transcode'
        if not video_direct and not audio_direct:
            return 'full_transcode'
        return ''

    @staticmethod
    def extract_playback_meta(session: dict) -> dict:
        if not session:
            return {}

        if session.get('NowPlayingItem') and session.get('play_method') is None:
            session = EmbyClient.normalize_session(session)

        play_state = session.get('PlayState') or {}
        transcoding = session.get('TranscodingInfo') or {}
        play_method = session.get('play_method') or play_state.get('PlayMethod') or ''
        if not play_method and transcoding:
            play_method = 'Transcode'

        is_video_direct = session.get('is_video_direct')
        if is_video_direct is None and transcoding:
            is_video_direct = bool(transcoding.get('IsVideoDirect'))
        elif is_video_direct is None:
            is_video_direct = play_method != 'Transcode'

        is_audio_direct = session.get('is_audio_direct')
        if is_audio_direct is None and transcoding:
            is_audio_direct = bool(transcoding.get('IsAudioDirect'))
        elif is_audio_direct is None:
            is_audio_direct = play_method != 'Transcode'

        transcode_kind = session.get('transcode_kind') or EmbyClient.derive_transcode_kind(
            play_method, is_video_direct, is_audio_direct,
        )
        return {
            'play_method': play_method,
            'is_video_direct': bool(is_video_direct),
            'is_audio_direct': bool(is_audio_direct),
            'transcode_kind': transcode_kind,
        }

    _ITEM_META_KEYS = (
        'item_id', 'item_title', 'item_type', 'series_name',
        'episode_title', 'episode_label', 'production_year',
        'file_size_bytes', 'bitrate',
    )

    @staticmethod
    def extract_item_meta(session: dict) -> dict:
        if not session:
            return {}
        now_playing = session.get('NowPlayingItem')
        if isinstance(now_playing, dict) and now_playing:
            meta = EmbyClient.normalize_item(now_playing)
            item_id = str(now_playing.get('Id') or '').strip()
            if item_id:
                meta['item_id'] = item_id
            return meta

        result = {}
        for key in EmbyClient._ITEM_META_KEYS:
            value = session.get(key)
            if key == 'item_id':
                value = str(value or session.get('ItemId') or '').strip()
            if key == 'production_year':
                if value is not None:
                    result[key] = value
            elif key in ('file_size_bytes', 'bitrate'):
                if value is not None and int(value) > 0:
                    result[key] = int(value)
            elif value not in (None, ''):
                result[key] = value
        if not result.get('item_title'):
            title = session.get('title') or ''
            if title:
                result['item_title'] = title
        return result

    @staticmethod
    def apply_item_meta(target: dict, session: dict) -> None:
        if not isinstance(target, dict) or not session:
            return
        for key, value in EmbyClient.extract_item_meta(session).items():
            if key == 'production_year':
                if value is not None:
                    target[key] = value
            elif key in ('file_size_bytes', 'bitrate'):
                if value is not None and int(value) > 0:
                    target[key] = int(value)
            elif value not in (None, ''):
                target[key] = value

    @staticmethod
    def apply_playback_meta(target: dict, session: dict) -> None:
        if not isinstance(target, dict) or not session:
            return

        endpoint = (
            session.get('remote_endpoint') or session.get('RemoteEndPoint') or ''
        )
        if endpoint:
            EmbyClient.apply_endpoint_meta(target, endpoint)
        elif 'is_remote' in session:
            target['is_remote'] = bool(session.get('is_remote'))

        for key, value in EmbyClient.extract_playback_meta(session).items():
            if key in ('is_video_direct', 'is_audio_direct'):
                target[key] = value
            elif value not in (None, ''):
                target[key] = value
        EmbyClient.apply_item_meta(target, session)
        bitrate = int(session.get('bitrate') or 0)
        if bitrate > 0 and not target.get('bitrate'):
            target['bitrate'] = bitrate
        file_size = session.get('file_size_bytes')
        if file_size and int(file_size) > 0 and not target.get('file_size_bytes'):
            target['file_size_bytes'] = int(file_size)

    @staticmethod
    def find_matching_session(entry: dict, event: dict,
                              sessions: List[dict]) -> Optional[dict]:
        event_dt = EmbyClient._parse_emby_datetime(
            (entry or {}).get('Date') or (event or {}).get('date') or '',
        )
        client = (event or {}).get('client') or ''

        best_session = None
        best_score = 0
        for session in sessions or []:
            if not EmbyClient.playback_events_match(event, session):
                continue

            score = 10
            sess_client = (
                session.get('Client') or session.get('client')
                or session.get('DeviceName') or session.get('device_name') or ''
            )
            if EmbyClient.clients_loosely_match(client, sess_client):
                score += 8

            sess_dt = EmbyClient._parse_emby_datetime(
                session.get('LastActivityDate')
                or session.get('last_activity_date') or '',
            )
            if event_dt and sess_dt:
                if event_dt.tzinfo is None:
                    event_dt_cmp = event_dt.replace(tzinfo=timezone.utc)
                else:
                    event_dt_cmp = event_dt
                if sess_dt.tzinfo is None:
                    sess_dt_cmp = sess_dt.replace(tzinfo=timezone.utc)
                else:
                    sess_dt_cmp = sess_dt
                delta = abs((event_dt_cmp - sess_dt_cmp).total_seconds())
                if delta <= 120:
                    score += 15
                elif delta <= 600:
                    score += 8
                elif delta <= 3600:
                    score += 3

            if score > best_score:
                best_score = score
                best_session = session

        if best_score >= 10:
            return best_session
        return None

    @staticmethod
    def apply_endpoint_meta(target: dict, remote_endpoint: str) -> None:
        endpoint = (remote_endpoint or '').strip()
        if not endpoint or not isinstance(target, dict):
            return
        target['remote_endpoint'] = endpoint
        target['client_ip'] = parse_endpoint_ip(endpoint)
        target['is_remote'] = EmbyClient._is_remote_session(endpoint)

    @staticmethod
    def resolve_playback_endpoint(entry: dict, event: dict,
                                  sessions: List[dict]) -> str:
        session = EmbyClient.find_matching_session(entry, event, sessions)
        if not session:
            return ''
        return (
            session.get('RemoteEndPoint') or session.get('remote_endpoint') or ''
        )

    @staticmethod
    def _ticks_to_seconds(ticks) -> int:
        try:
            return int(ticks) // 10_000_000
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _normalize_playback_rate(value) -> float:
        try:
            rate = float(value)
        except (TypeError, ValueError):
            return 1.0
        if rate <= 0 or rate > 16:
            return 1.0
        return rate

    @staticmethod
    def extract_production_year(item: dict) -> Optional[int]:
        if not item:
            return None
        year = item.get('ProductionYear')
        if year is not None:
            try:
                parsed = int(year)
            except (TypeError, ValueError):
                parsed = None
            if parsed is not None and 1800 <= parsed <= 2100:
                return parsed
        for key in ('PremiereDate', 'DateCreated'):
            raw = str(item.get(key) or '').strip()
            if len(raw) >= 4 and raw[:4].isdigit():
                parsed = int(raw[:4])
                if 1800 <= parsed <= 2100:
                    return parsed
        return None

    @staticmethod
    def extract_file_size_bytes(item: dict) -> Optional[int]:
        if not item:
            return None
        try:
            size = int(item.get('Size') or 0)
        except (TypeError, ValueError):
            size = 0
        if size > 0:
            return size
        best = 0
        for src in item.get('MediaSources') or []:
            if not isinstance(src, dict):
                continue
            try:
                part = int(src.get('Size') or 0)
            except (TypeError, ValueError):
                part = 0
            if part > best:
                best = part
        return best if best > 0 else None

    @staticmethod
    def format_episode_label(item_type: str, parent_idx, idx) -> str:
        if item_type != 'Episode':
            return ''
        try:
            season = int(parent_idx) if parent_idx is not None else 0
            episode = int(idx) if idx is not None else 0
        except (TypeError, ValueError):
            return ''
        if season > 0 and episode > 0:
            return f'S{season:02d}E{episode:02d}'
        if episode > 0:
            return f'E{episode:02d}'
        return ''

    @staticmethod
    def normalize_item(item: dict) -> dict:
        if not item:
            return {}
        idx = item.get('IndexNumber')
        parent_idx = item.get('ParentIndexNumber')
        item_type = item.get('Type') or ''
        episode_label = EmbyClient.format_episode_label(item_type, parent_idx, idx)
        episode_title = item.get('EpisodeTitle') or ''
        item_name = item.get('Name') or ''
        if item_type == 'Episode':
            display_title = episode_title or item_name
        else:
            display_title = item_name
        return {
            'item_title': display_title,
            'item_type': item_type,
            'series_name': item.get('SeriesName') or '',
            'episode_title': episode_title or (display_title if item_type == 'Episode' else ''),
            'episode_label': episode_label,
            'production_year': EmbyClient.extract_production_year(item),
            'file_size_bytes': EmbyClient.extract_file_size_bytes(item),
            'bitrate': int(item.get('Bitrate') or 0) or None,
        }

    @staticmethod
    def split_series_episode_title(title: str) -> tuple:
        raw = (title or '').strip()
        for sep in (' - ', ' – ', ' — '):
            if sep in raw:
                series, episode = raw.split(sep, 1)
                return series.strip(), episode.strip()
        return '', raw

    @staticmethod
    def _merge_playback_meta(result: dict, parsed: dict) -> dict:
        merged = dict(result)
        if parsed.get('user_name') and not merged.get('user_name'):
            merged['user_name'] = parsed['user_name']
        if parsed.get('client') and not merged.get('client'):
            merged['client'] = parsed['client']
        return merged

    @staticmethod
    def parse_playback_activity_name(name: str) -> dict:
        raw = (name or '').strip()
        if not raw:
            return {}
        for pattern in _PLAYBACK_NAME_PATTERNS:
            match = pattern.match(raw)
            if not match:
                continue
            groups = match.groupdict()
            return {
                'item_title': (groups.get('title') or '').strip(),
                'user_name': (groups.get('user') or '').strip(),
                'client': (groups.get('client') or '').strip(),
            }
        if raw not in _GENERIC_PLAYBACK_NAMES and len(raw) > 4:
            return {'playback_detail': raw}
        return {}

    @staticmethod
    def entry_item_id(entry: dict) -> str:
        item_id = str(entry.get('ItemId') or '').strip()
        if item_id:
            return item_id
        item = entry.get('Item')
        if isinstance(item, dict):
            return str(item.get('Id') or '').strip()
        return ''

    @staticmethod
    def entry_embedded_item(entry: dict) -> Optional[dict]:
        item = entry.get('Item')
        if isinstance(item, dict) and (item.get('Id') or item.get('Name')):
            return item
        return None

    @staticmethod
    def parse_playback_overview(text: str) -> dict:
        raw = (text or '').strip()
        if not raw:
            return {}
        for pattern in _PLAYBACK_OVERVIEW_PATTERNS:
            match = pattern.search(raw)
            if not match:
                continue
            groups = match.groupdict()
            result = {}
            label = (groups.get('label') or '').strip()
            if label:
                m = re.match(r'(?i)S(\d+)E(\d+)', label)
                if m:
                    result['episode_label'] = (
                        f'S{int(m.group(1)):02d}E{int(m.group(2)):02d}'
                    )
                else:
                    result['episode_label'] = label
            series = (groups.get('series') or '').strip()
            title = (groups.get('title') or '').strip()
            if series:
                result['series_name'] = series
            if title:
                result['item_title'] = title
                if series:
                    result['episode_title'] = title
            if result:
                return result
        return {}

    @staticmethod
    def _parse_name_for_legacy(entry: dict) -> dict:
        parsed = EmbyClient.parse_playback_activity_name(entry.get('Name') or '')
        if not parsed.get('item_title') and parsed.get('playback_detail'):
            match = _PLAYBACK_TITLE_EXTRACT.search(parsed['playback_detail'])
            if match:
                parsed['item_title'] = match.group('title').strip()
                parsed.pop('playback_detail', None)
        overview = (entry.get('Overview') or entry.get('ShortOverview') or '').strip()
        if not parsed.get('item_title') and overview:
            parsed['item_title'] = overview
        return parsed

    @staticmethod
    def _enrich_from_api_item(client: 'EmbyClient', entry: dict,
                              item_cache: dict, parsed: dict, *,
                              max_item_fetches: int = None,
                              item_fetch_state: dict = None) -> Optional[dict]:
        """高版本 Emby：活动日志带 ItemId/Item，直接查媒体详情，不走库内搜索。"""
        embedded = EmbyClient.entry_embedded_item(entry)
        if embedded:
            return EmbyClient._merge_playback_meta(
                EmbyClient.normalize_item(embedded), parsed,
            )

        item_id = EmbyClient.entry_item_id(entry)
        if not item_id:
            return None

        cache_key = ('item', item_id)
        if cache_key not in item_cache:
            fetch_limited = (
                max_item_fetches is not None
                and item_fetch_state is not None
                and int(item_fetch_state.get('count') or 0) >= max_item_fetches
            )
            if fetch_limited:
                item_cache[cache_key] = None
            else:
                user_id = entry.get('UserId') or ''
                item_cache[cache_key] = client.get_item(item_id, user_id)
                if item_fetch_state is not None:
                    item_fetch_state['count'] = int(
                        item_fetch_state.get('count') or 0,
                    ) + 1
        item = item_cache.get(cache_key)
        if item:
            return EmbyClient._merge_playback_meta(
                EmbyClient.normalize_item(item), parsed,
            )

        overview_meta = EmbyClient.parse_playback_overview(
            entry.get('Overview') or entry.get('ShortOverview') or '',
        )
        if overview_meta:
            return EmbyClient._merge_playback_meta(overview_meta, parsed)
        return EmbyClient._merge_playback_meta(parsed, {})

    @staticmethod
    def _enrich_from_activity_text(entry: dict, parsed: dict) -> dict:
        overview_meta = EmbyClient.parse_playback_overview(
            entry.get('Overview') or entry.get('ShortOverview') or '',
        )
        if overview_meta:
            return EmbyClient._merge_playback_meta(overview_meta, parsed)

        parsed = EmbyClient._parse_name_for_legacy(entry)
        overview = (entry.get('Overview') or entry.get('ShortOverview') or '').strip()
        title_text = parsed.get('item_title') or overview
        series_name, episode_title = EmbyClient.split_series_episode_title(title_text)
        if series_name:
            parsed['series_name'] = series_name
        if episode_title:
            parsed['item_title'] = episode_title
            if series_name:
                parsed['episode_title'] = episode_title
        parsed.pop('playback_detail', None)
        if overview and not parsed.get('item_title') and not parsed.get('playback_detail'):
            parsed['playback_detail'] = overview
        return parsed

    @staticmethod
    def normalize_activity_entry(entry: dict, instance_name: str = '',
                                   enrichment: dict = None) -> dict:
        event = {
            'id': entry.get('Id') or entry.get('id') or '',
            'instance_name': instance_name,
            'type': entry.get('Type') or '',
            'name': entry.get('Name') or '',
            'overview': entry.get('Overview') or entry.get('ShortOverview') or '',
            'date': entry.get('Date') or '',
            'user_id': entry.get('UserId') or '',
            'user_name': entry.get('UserName') or '',
            'severity': entry.get('Severity') or '',
            'item_id': EmbyClient.entry_item_id(entry),
        }
        if enrichment:
            for key, value in enrichment.items():
                if value not in (None, ''):
                    event[key] = value
        return event

    @staticmethod
    def enrich_activity_entry(client: 'EmbyClient', entry: dict,
                              item_cache: dict,
                              sessions: List[dict] = None, *,
                              max_item_fetches: int = None,
                              item_fetch_state: dict = None,
                              deadline_mono: float = None) -> dict:
        if deadline_mono is not None:
            import time
            if time.monotonic() > deadline_mono:
                return {}
        event_type = entry.get('Type') or ''
        if event_type not in PLAYBACK_EVENT_TYPES:
            return {}
        parsed = EmbyClient.parse_playback_activity_name(entry.get('Name') or '')

        enrich_kwargs = {
            'max_item_fetches': max_item_fetches,
            'item_fetch_state': item_fetch_state,
        }
        if EmbyClient.entry_item_id(entry) or EmbyClient.entry_embedded_item(entry):
            result = EmbyClient._enrich_from_api_item(
                client, entry, item_cache, parsed, **enrich_kwargs,
            )
        else:
            result = EmbyClient._enrich_from_activity_text(entry, parsed)

        result = dict(result or parsed or {})
        matched = EmbyClient.find_matching_session(entry, result, sessions or [])
        if matched:
            if matched.get('NowPlayingItem'):
                matched = EmbyClient.normalize_session(matched)
            EmbyClient.apply_playback_meta(result, matched)
        else:
            endpoint = EmbyClient.resolve_playback_endpoint(entry, result, sessions or [])
            if endpoint:
                EmbyClient.apply_endpoint_meta(result, endpoint)
        return result

    @staticmethod
    def _session_mode(now_playing: dict, viewing: dict, play_state: dict,
                      transcoding: dict) -> str:
        is_actively_playing = EmbyClient._session_is_actively_playing(
            now_playing, play_state, transcoding,
        )
        if is_actively_playing and not bool(play_state.get('IsPaused')):
            return 'playing'
        # IsPaused 优先于 NowViewingItem：外网暂停后 Lucky 连接仍归属该播放会话。
        if now_playing and bool(play_state.get('IsPaused')):
            return 'paused'
        if viewing:
            return 'viewing'
        if now_playing:
            return 'paused'
        return 'connected'

    @staticmethod
    def normalize_session(session: dict) -> dict:
        play_state = session.get('PlayState') or {}
        now_playing = session.get('NowPlayingItem') or {}
        viewing = session.get('NowViewingItem') or {}
        if not isinstance(now_playing, dict):
            now_playing = {}
        if not isinstance(viewing, dict):
            viewing = {}
        transcoding = session.get('TranscodingInfo') or {}
        play_method = play_state.get('PlayMethod') or ''
        if not play_method and transcoding:
            play_method = 'Transcode'
        bitrate = transcoding.get('Bitrate') or now_playing.get('Bitrate') or 0
        position_ticks = int(play_state.get('PositionTicks') or 0)
        runtime_ticks = int(now_playing.get('RunTimeTicks') or 0)
        progress_pct = None
        if runtime_ticks > 0 and position_ticks >= 0:
            progress_pct = round(min(100.0, position_ticks / runtime_ticks * 100), 1)

        transcode_reasons = transcoding.get('TranscodeReasons') or []
        if isinstance(transcode_reasons, list):
            reasons = [str(r) for r in transcode_reasons if r]
        else:
            reasons = []

        idx = now_playing.get('IndexNumber')
        parent_idx = now_playing.get('ParentIndexNumber')
        item_type = now_playing.get('Type') or ''
        episode_label = EmbyClient.format_episode_label(item_type, parent_idx, idx)
        viewing_idx = viewing.get('IndexNumber')
        viewing_parent_idx = viewing.get('ParentIndexNumber')
        viewing_type = viewing.get('Type') or ''
        viewing_episode_label = EmbyClient.format_episode_label(
            viewing_type, viewing_parent_idx, viewing_idx,
        )
        poster_item, poster_tag = EmbyClient.poster_ref(now_playing or viewing)
        session_mode = EmbyClient._session_mode(
            now_playing, viewing, play_state, transcoding,
        )
        is_abnormal_disconnect = EmbyClient.is_emby_abnormal_disconnect_session(session)
        if is_abnormal_disconnect:
            session_mode = 'stopped'
        is_playing = False if is_abnormal_disconnect else EmbyClient._session_is_actively_playing(
            now_playing, play_state, transcoding,
        )

        return {
            'id': session.get('Id') or '',
            'session_mode': session_mode,
            'is_abnormal_disconnect': is_abnormal_disconnect,
            'is_playing': is_playing,
            'user_name': session.get('UserName') or '',
            'user_id': session.get('UserId') or '',
            'client': session.get('Client') or '',
            'device_name': session.get('DeviceName') or '',
            'device_type': session.get('DeviceType') or '',
            'application_version': session.get('ApplicationVersion') or '',
            'remote_endpoint': session.get('RemoteEndPoint') or '',
            'client_ip': parse_endpoint_ip(session.get('RemoteEndPoint') or ''),
            'is_remote': EmbyClient._is_remote_session(session.get('RemoteEndPoint') or ''),
            'protocol': session.get('Protocol') or transcoding.get('SubProtocol') or '',
            'play_method': play_method,
            'is_paused': bool(play_state.get('IsPaused')),
            'playback_rate': EmbyClient._normalize_playback_rate(
                play_state.get('PlaybackRate'),
            ),
            'position_ticks': position_ticks,
            'position_seconds': EmbyClient._ticks_to_seconds(position_ticks),
            'runtime_ticks': runtime_ticks,
            'runtime_seconds': EmbyClient._ticks_to_seconds(runtime_ticks),
            'progress_percent': progress_pct,
            'title': now_playing.get('Name') or '',
            'item_id': now_playing.get('Id') or '',
            'item_type': now_playing.get('Type') or '',
            'series_name': now_playing.get('SeriesName') or '',
            'episode_title': now_playing.get('EpisodeTitle') or '',
            'episode_label': episode_label,
            'production_year': EmbyClient.extract_production_year(now_playing),
            'file_size_bytes': EmbyClient.extract_file_size_bytes(now_playing),
            'official_rating': now_playing.get('OfficialRating') or '',
            'bitrate': int(bitrate or 0),
            'video_bitrate': int(transcoding.get('VideoBitrate') or 0),
            'audio_bitrate': int(transcoding.get('AudioBitrate') or 0),
            'video_codec': transcoding.get('VideoCodec') or now_playing.get('VideoCodec') or '',
            'audio_codec': transcoding.get('AudioCodec') or now_playing.get('AudioCodec') or '',
            'container': transcoding.get('Container') or now_playing.get('Container') or '',
            'width': transcoding.get('Width') or now_playing.get('Width'),
            'height': transcoding.get('Height') or now_playing.get('Height'),
            'framerate': transcoding.get('Framerate') or now_playing.get('RealFrameRate'),
            'audio_channels': transcoding.get('AudioChannels'),
            'transcoding': bool(transcoding),
            'is_video_direct': bool(transcoding.get('IsVideoDirect')),
            'is_audio_direct': bool(transcoding.get('IsAudioDirect')),
            'video_decoder': transcoding.get('VideoDecoder') or '',
            'video_encoder': transcoding.get('VideoEncoder') or '',
            'video_encoder_is_hardware': bool(transcoding.get('VideoEncoderIsHardware')),
            'transcode_reasons': reasons,
            'transcode_kind': EmbyClient.derive_transcode_kind(
                play_method,
                bool(transcoding.get('IsVideoDirect')) if transcoding else play_method != 'Transcode',
                bool(transcoding.get('IsAudioDirect')) if transcoding else play_method != 'Transcode',
            ),
            'completion_percentage': transcoding.get('CompletionPercentage'),
            'current_cpu': transcoding.get('CurrentCpuUsage'),
            'average_cpu': transcoding.get('AverageCpuUsage'),
            'last_activity_date': session.get('LastActivityDate') or '',
            'viewing_item_id': viewing.get('Id') or '',
            'viewing_item_type': viewing_type,
            'viewing_title': viewing.get('Name') or '',
            'viewing_series_name': viewing.get('SeriesName') or '',
            'viewing_episode_label': viewing_episode_label,
            'poster_item_id': poster_item,
            'poster_tag': poster_tag,
        }

    @staticmethod
    def poster_ref(item: dict) -> tuple:
        """剧集用整部剧的海报，电影用影片海报。返回 (条目编号, 图片标记)。"""
        if not isinstance(item, dict) or not item:
            return '', ''
        item_type = str(item.get('Type') or '')
        series_id = str(item.get('SeriesId') or '').strip()
        if item_type == 'Episode' or series_id:
            if series_id:
                return series_id, str(item.get('SeriesPrimaryImageTag') or '').strip()
        item_id = str(item.get('Id') or '').strip()
        tags = item.get('ImageTags') if isinstance(item.get('ImageTags'), dict) else {}
        tag = str((tags or {}).get('Primary') or '').strip()
        if item_id and (tag or item_type in ('Movie', 'Series', 'Video', 'BoxSet')):
            return item_id, tag
        return '', ''

    def fetch_primary_image(self, item_id: str, tag: str = '') -> tuple:
        item_id = str(item_id or '').strip()
        if not item_id:
            return None, ''
        params = {'maxHeight': 320, 'quality': 80}
        if tag:
            params['tag'] = tag
        resp = self._request(
            'GET', f'/Items/{quote(item_id, safe="")}/Images/Primary', params=params,
        )
        if resp is None or resp.status_code >= 400 or not resp.content:
            return None, ''
        mime = (resp.headers.get('Content-Type') or 'image/jpeg').split(';', 1)[0].strip().lower()
        if mime in ('image/jpg', 'image/pjpeg'):
            mime = 'image/jpeg'
        if mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif'):
            return None, ''
        return resp.content, mime

    def get_all_client_sessions(self) -> List[dict]:
        """全部在线客户端（含局域网/外网、选片/暂停/播放）。"""
        result: List[dict] = []
        for raw in self.get_sessions():
            if not isinstance(raw, dict):
                continue
            result.append(self.normalize_session(raw))
        return result

    def get_wan_client_sessions(self) -> List[dict]:
        """外网在线客户端（含选片/暂停/播放），供 Lucky 连接匹配。"""
        return [
            session for session in self.get_all_client_sessions()
            if session.get('is_remote')
        ]

    def send_session_playing_command(self, session_id: str, command: str) -> dict:
        command = (command or '').strip()
        allowed = {'Pause', 'Unpause', 'Stop'}
        if command not in allowed:
            return {'ok': False, 'error': f'不支持的命令: {command}'}
        sid = quote(str(session_id), safe='')
        resp = self._request('POST', f'/Sessions/{sid}/Playing/{command}')
        if resp is None:
            return {'ok': False, 'error': '无法连接 Emby 服务器'}
        if resp.status_code >= 400:
            return {'ok': False, 'error': f'HTTP {resp.status_code}'}
        return {'ok': True}

    def send_session_message(self, session_id: str, text: str,
                             header: str = None,
                             timeout_ms: Optional[int] = DEFAULT_SESSION_MESSAGE_TIMEOUT_MS) -> dict:
        message = str(text or '').strip()
        if not message:
            return {'ok': False, 'error': '消息内容不能为空'}
        sid = quote(str(session_id), safe='')
        params = {'Text': message}
        if timeout_ms is not None:
            params['TimeoutMs'] = int(timeout_ms)
        if header and str(header).strip():
            params['Header'] = str(header).strip()
        resp = self._request('POST', f'/Sessions/{sid}/Message', params=params)
        if resp is None:
            return {'ok': False, 'error': '无法连接 Emby 服务器'}
        if resp.status_code >= 400:
            return {'ok': False, 'error': f'HTTP {resp.status_code}'}
        return {'ok': True}

    def get_normalized_sessions(self) -> List[dict]:
        return [
            self.normalize_session(s)
            for s in self.get_sessions()
            if s.get('NowPlayingItem')
        ]
