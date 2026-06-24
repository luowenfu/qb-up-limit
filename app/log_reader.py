import os
import re
from pathlib import Path

LOG_PATH = os.environ.get('APP_LOG_PATH', '/data/app.log')
_LOG_LINE_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) '
    r'\[(DEBUG|INFO|WARNING|ERROR|CRITICAL)\] '
    r'(\S+): (.*)$'
)


def _log_files() -> list:
    base = Path(LOG_PATH)
    if not base.parent.exists():
        fallback = Path(__file__).resolve().parent.parent / 'data' / 'app.log'
        if fallback.exists():
            base = fallback
        else:
            return []

    files = []
    if base.exists():
        files.append(base)
    for idx in range(1, 4):
        rotated = Path(f'{base}.{idx}')
        if rotated.exists():
            files.append(rotated)
    return files


def _entry_matches_instance(entry: dict, instance: str) -> bool:
    if not instance:
        return True
    msg = entry.get('message') or ''
    if f'[{instance}]' in msg:
        return True
    if f'[Emby:{instance}]' in msg:
        return True
    if f'[Playback:{instance}]' in msg:
        return True
    for pattern in (
        f': {instance}',
        f'：{instance}',
        f'实例: {instance}',
        f'实例 {instance}',
    ):
        if pattern in msg:
            return True
    return False


def _is_emby_device_log(entry: dict) -> bool:
    msg = entry.get('message') or ''
    logger_name = (entry.get('logger') or '').lower()
    if '[Emby:' in msg or '[Playback:' in msg:
        return True
    if 'emby' in logger_name:
        return True
    if msg.startswith('Emby '):
        return True
    for marker in ('Emby 设备', 'Emby 实例', '初始化 Emby', 'Emby 流量', 'Emby 容器'):
        if marker in msg:
            return True
    return False


_QB_DEVICE_TAG_RE = re.compile(r'^\[[^:\]]+\]')


def _is_qb_device_log(entry: dict) -> bool:
    if _is_emby_device_log(entry):
        return False
    msg = entry.get('message') or ''
    logger_name = (entry.get('logger') or '').lower()
    if _QB_DEVICE_TAG_RE.match(msg):
        return True
    if '初始化qB实例' in msg or '初始化 qB' in msg:
        return True
    if logger_name in ('scheduler', 'qb_monitor', 'speed_limiter') and '[' in msg:
        return True
    for marker in ('设备已添加', '设备配置已更新', '设备已删除'):
        if marker in msg and 'Emby' not in msg:
            return True
    return False


def _entry_matches_service(entry: dict, service: str) -> bool:
    if not service:
        return True
    is_emby = _is_emby_device_log(entry)
    is_qb = _is_qb_device_log(entry)
    if service == 'emby':
        return is_emby
    if service == 'qb':
        return is_qb
    if service == 'system':
        return not is_emby and not is_qb
    return True


def get_system_logs(limit: int = 1000, level: str = None, instance: str = None,
                    service: str = None) -> list:
    limit = max(1, min(int(limit), 1000))
    level = (level or '').strip().upper() or None
    instance = (instance or '').strip() or None
    service = (service or '').strip().lower() or None
    entries = []

    for path in _log_files():
        try:
            lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            match = _LOG_LINE_RE.match(line)
            if not match:
                continue
            entry = {
                'time': match.group(1),
                'level': match.group(2),
                'logger': match.group(3),
                'message': match.group(4),
            }
            if level and entry['level'] != level:
                continue
            if service and not _entry_matches_service(entry, service):
                continue
            if instance and not _entry_matches_instance(entry, instance):
                continue
            entries.append(entry)
            if len(entries) >= limit:
                return entries

    return entries
