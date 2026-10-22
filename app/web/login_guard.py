"""登录失败按 IP 和账号逐步加长等待。只使用标准库。"""

import ipaddress
import os
import threading
import time

FAILS_BEFORE_DELAY = 2
MAX_DELAY_SECONDS = 5 * 60
_MAX_ENTRIES = 4096

_RFC1918 = (
    ipaddress.ip_network('10.0.0.0/8'),
    ipaddress.ip_network('172.16.0.0/12'),
    ipaddress.ip_network('192.168.0.0/16'),
)
_ULA = ipaddress.ip_network('fc00::/7')

_lock = threading.Lock()
_entries = {}


def _parse_ip(text: str):
    token = (text or '').strip().strip('[]')
    if not token or token == 'unknown':
        return None
    try:
        parsed = ipaddress.ip_address(token)
    except ValueError:
        return None
    mapped = getattr(parsed, 'ipv4_mapped', None)
    return mapped or parsed


def is_trusted_proxy_peer(addr: str) -> bool:
    """直连对端是回环、RFC1918、ULA 或链路本地地址。"""
    ip = _parse_ip(addr)
    if ip is None:
        return False
    if ip.is_loopback or ip.is_link_local:
        return True
    if isinstance(ip, ipaddress.IPv4Address):
        return any(ip in net for net in _RFC1918)
    return ip in _ULA


def _proxy_count():
    """未设置或不是整数时返回 None，表示自动识别。"""
    raw = os.environ.get('TRUSTED_PROXY_COUNT', '').strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _forwarded_parts(forwarded_for: str):
    return [part.strip() for part in (forwarded_for or '').split(',') if part.strip()]


def resolve_client_ip(remote_addr: str, forwarded_for: str = '', real_ip: str = '') -> str:
    """显式 TRUSTED_PROXY_COUNT 优先。未设置时，仅在对端是局域网地址时信任转发头。"""
    remote = (remote_addr or '').strip() or 'unknown'
    parts = _forwarded_parts(forwarded_for)
    count = _proxy_count()
    if count is None:
        if not is_trusted_proxy_peer(remote):
            return remote
        if parts:
            return parts[-1]
        real = (real_ip or '').strip()
        return real or remote
    if count <= 0:
        return remote
    if len(parts) < count:
        return remote
    return parts[-count]


# 仅按账号累计的桶，IP 位置固定为 '*'，只对未带有效信任设备 Cookie 的请求生效
USER_ONLY_IP = '*'


def _bucket(ip: str, username: str):
    return ((ip or '').strip() or 'unknown', (username or '').strip())


def _remaining(key, now) -> int:
    entry = _entries.get(key)
    if not entry:
        return 0
    until = entry.get('wait_until') or 0
    if until > now:
        return max(1, int(until - now + 0.999))
    return 0


def wait_seconds_for_failures(count: int) -> int:
    """第 1 次失败可立刻再试。从第 2 次起依次等待 1、2、4、8 秒，上限 5 分钟。"""
    if count < FAILS_BEFORE_DELAY:
        return 0
    return min(MAX_DELAY_SECONDS, 2 ** (count - FAILS_BEFORE_DELAY))


def retry_after(ip: str, username: str, trusted: bool = False) -> int:
    """仍需等待时返回剩余秒数，否则返回 0。信任设备只看 IP+账号桶，陌生设备另取账号桶的较大值。"""
    now = time.monotonic()
    with _lock:
        wait = _remaining(_bucket(ip, username), now)
        if not trusted:
            wait = max(wait, _remaining(_bucket(USER_ONLY_IP, username), now))
        return wait


def record_failure(ip: str, username: str, trusted: bool = False) -> int:
    """记一次失败。若因此需要等待，返回等待秒数，否则返回 0。陌生设备同时计入账号桶。"""
    now = time.monotonic()
    with _lock:
        wait = _record_locked(_bucket(ip, username), now)
        if not trusted:
            wait = max(wait, _record_locked(_bucket(USER_ONLY_IP, username), now))
        return wait


def _record_locked(key, now) -> int:
    """调用方需持有 _lock。"""
    entry = _entries.get(key)
    if entry is None:
        if len(_entries) >= _MAX_ENTRIES:
            _evict()
        entry = {'fails': 0, 'wait_until': 0, 'touched': now}
        _entries[key] = entry
    elif (entry.get('wait_until') or 0) > now:
        return max(1, int(entry['wait_until'] - now + 0.999))
    entry['fails'] = int(entry.get('fails') or 0) + 1
    entry['touched'] = now
    wait = wait_seconds_for_failures(entry['fails'])
    if wait:
        entry['wait_until'] = now + wait
    else:
        entry['wait_until'] = 0
    return wait


def record_success(ip: str, username: str) -> None:
    with _lock:
        _entries.pop(_bucket(ip, username), None)
        _entries.pop(_bucket(USER_ONLY_IP, username), None)


def delay_message(seconds: int) -> str:
    return f'密码错误，锁定{max(1, int(seconds))}秒…'


def _evict() -> None:
    if len(_entries) < _MAX_ENTRIES:
        return
    ordered = sorted(_entries.items(), key=lambda item: item[1].get('touched') or 0)
    drop = max(1, len(_entries) - _MAX_ENTRIES + 1)
    for key, _entry in ordered[:drop]:
        _entries.pop(key, None)
