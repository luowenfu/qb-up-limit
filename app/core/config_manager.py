"""配置文件读写与校验"""

import json
import os
import copy
import re
import threading
import yaml
import logging

from core.cycle import migrate_legacy_cycle, CYCLE_TYPES
import core.secrets_store as secrets_store
from emby.lucky.api import (
    migrate_estimate_upload_flag,
    normalize_lucky_base_url,
    normalize_traffic_collect_mode,
)

logger = logging.getLogger(__name__)

# 运行时配置（可写，存放在 data 卷）
from core.paths import CONFIG_PATH  # noqa: E402
# 界面展示用的相对路径提示（对应容器内 /data 卷挂载目录）
CONFIG_RELATIVE_PATH = 'data/config.yaml'
# 可选种子配置（只读挂载，首次启动时导入）
SEED_CONFIG_PATH = '/config/config.yaml'
_lock = threading.RLock()

EMBY_DEFAULT_DEVICE_VIEWS = ('qb', 'emby', 'merge')
MOBILE_DEFAULT_VIEWS = ('qb', 'emby')
EMBY_BURST_PRIORITY_MODES = ('seek_first', 'new_first')

DEFAULT_GLOBAL = {
    'timezone': 'Asia/Shanghai',
    'collect_interval': 5,
    'refresh_interval': 1,
    'data_retention_years': 5,
    'web_port': 8765,
    'emby_enabled': False,
    'emby_default_device_view': 'qb',
    'default_pc_view': 'qb',
    'default_pc_device': '',
    'default_mobile_view': 'qb',
    'default_mobile_device': '',
    'emby_burst_new_session_window_seconds': 8,
    'emby_burst_seek_window_seconds': 6,
    'emby_burst_priority_mode': 'seek_first',
    'emby_mode_switch_grace_seconds': 2,
    'emby_preplay_burst_mbps': 1.5,
    'emby_preplay_burst_window_seconds': 3,
    'emby_m3_wan_pool_scale': 1.0,
    'emby_browse_upload_min_mb': 1.0,
}

EMBY_M3_WAN_POOL_SCALE_MIN = 0.5
EMBY_M3_WAN_POOL_SCALE_MAX = 1.5
EMBY_BROWSE_UPLOAD_MIN_MB_MIN = 0.0
EMBY_BROWSE_UPLOAD_MIN_MB_MAX = 100.0
EMBY_PREPLAY_BURST_MBPS_MIN = 0.5
EMBY_PREPLAY_BURST_MBPS_MAX = 10.0
EMBY_PREPLAY_BURST_WINDOW_SECONDS_MIN = 1
EMBY_PREPLAY_BURST_WINDOW_SECONDS_MAX = 10

REFRESH_INTERVAL_MIN = 1
REFRESH_INTERVAL_MAX = 10

# qBittorrent WebUI 全局上传限速上限（KB/s）
QB_MAX_UPLOAD_LIMIT_KBPS = 2097151

# 刷新间隔(1-10) → 数据采集间隔（固定搭配表）
REFRESH_COLLECT_MAP = {
    1: 5, 2: 10, 3: 15, 4: 20, 5: 25, 6: 30, 7: 35, 8: 40, 9: 45, 10: 50,
    11: 55, 12: 60, 13: 52, 14: 56, 15: 60, 16: 48, 17: 51, 18: 54, 19: 57,
    20: 60, 21: 42, 22: 44, 23: 46, 24: 48, 25: 50, 26: 52, 27: 54, 28: 56,
    29: 58, 30: 60,
}


def collect_interval_for_refresh(refresh_interval: int) -> int:
    refresh = max(REFRESH_INTERVAL_MIN, min(REFRESH_INTERVAL_MAX, int(refresh_interval)))
    return REFRESH_COLLECT_MAP[refresh]

DEFAULT_CYCLE = {
    'type': 'month',
    'reset_anchor': 1,
    'reset_limit_kbps': 0,
}

INSTANCE_NAME_MAX_LENGTH = 10
INSTANCE_HTTP_TIMEOUT = 3
DISPLAY_PRIORITY_MAX = 99999

DEFAULT_INSTANCE = {
    'name': 'qBittorrent',
    'host': '',
    'port': 8080,
    'use_https': False,
    'verify_ssl': False,
    'username': '',
    'connection_timeout': INSTANCE_HTTP_TIMEOUT,
    'read_timeout': INSTANCE_HTTP_TIMEOUT,
    'cycle': dict(DEFAULT_CYCLE),
    'speed_rules': [{'cycle_upload_limit_gb': 500, 'speed_limit_kbps': 128}],
    'allow_manual_unlimit': True,
    'display_priority': 1,
}

DEFAULT_EMBY_INSTANCE = {
    'name': 'Emby',
    'host': '',
    'port': 8096,
    'use_https': False,
    'verify_ssl': False,
    'api_key': '',
    'connection_timeout': INSTANCE_HTTP_TIMEOUT,
    'display_priority': 1,
    'wan_traffic_only': True,
    'traffic_collect_mode': '',
    'lucky_base_url': '',
    'lucky_verify_ssl': False,
    'lucky_rule_key': '',
    'lucky_sub_key': '',
    'lucky_rule_label': '',
    'lucky_frontend_host': '',
    'lucky_credit_browse_traffic': False,
}


def get_default_config() -> dict:
    return {
        'global': dict(DEFAULT_GLOBAL),
        'qbittorrent_instances': [],
        'emby_instances': [],
    }


def _migrate_auth_fields(inst: dict) -> dict:
    """清理旧版字段，保留配置文件中的用户名密码"""
    item = dict(inst)
    item.pop('bypass_auth', None)
    item.pop('require_auth', None)
    item['username'] = str(item.get('username', '')).strip()
    return item


def _normalize_host(host: str) -> str:
    host = (host or '').strip()
    if host.startswith('https://'):
        host = host[8:]
    elif host.startswith('http://'):
        host = host[7:]
    return host.rstrip('/').split('/')[0].lower()


def _parse_host_port(host: str, port: int = 8080) -> tuple:
    """从 host 字段解析「域名:端口 / IP:端口」合并格式，兼容旧版分开存储"""
    host = (host or '').strip()
    if host.startswith('https://'):
        host = host[8:]
    elif host.startswith('http://'):
        host = host[7:]
    host = host.rstrip('/').split('/')[0]

    ipv6_match = re.match(r'^\[([^\]]+)\]:(\d+)$', host)
    if ipv6_match:
        return ipv6_match.group(1), int(ipv6_match.group(2))

    if ':' in host:
        h, _, p = host.rpartition(':')
        if p.isdigit():
            return h, int(p)

    return host, _safe_int(port, 8080)


def _connection_key(inst: dict) -> tuple:
    return (
        _normalize_host(inst.get('host', '')),
        int(inst.get('port', 8080)),
        bool(inst.get('use_https', False)),
    )


def _check_duplicate_connection(instances: list, inst: dict,
                                original_name: str = None):
    key = _connection_key(inst)
    host = inst.get('host', '')
    port = inst.get('port', 8080)
    for other in instances:
        if original_name and other.get('name') == original_name:
            continue
        if _connection_key(other) == key:
            raise ValueError(
                f'地址 {host}:{port} 已被设备「{other.get("name")}」使用，'
                f'同一 qB 实例请勿重复添加'
            )


def _migrate_instance_fields(inst: dict) -> dict:
    """设备配置字段迁移与默认值"""
    item = _migrate_auth_fields(inst)
    item.pop('base_path', None)
    item.pop('force_https', None)
    item.pop('reset_day', None)
    item.pop('reset_day_limit_kbps', None)
    if 'allow_manual_unlimit' not in item and 'restore_on_reset' in item:
        item['allow_manual_unlimit'] = bool(item.get('restore_on_reset', True))
    item.pop('restore_on_reset', None)
    item['connection_timeout'] = INSTANCE_HTTP_TIMEOUT
    item['read_timeout'] = INSTANCE_HTTP_TIMEOUT
    return migrate_legacy_cycle(item)


def is_password_mask(value: str) -> bool:
    """判断是否为纯 * 掩码（长度应与真实密码一致）"""
    return bool(value) and all(c == '*' for c in value)


def parse_request_bool(value, default: bool = True) -> bool:
    """解析 API 请求中的布尔标志（兼容 false / \"false\" / 0）"""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ('0', 'false', 'no', 'off', ''):
            return False
        if normalized in ('1', 'true', 'yes', 'on'):
            return True
    return default


def pop_instance_save_flags(data: dict) -> tuple:
    """取出保存请求中的同步控制字段，避免写入配置文件"""
    reachable = data.pop('reachable', None)
    if reachable is not None and not isinstance(reachable, bool):
        reachable = parse_request_bool(reachable, default=True)
    attempt_sync = parse_request_bool(data.pop('attempt_sync', None), default=True)
    data_policy = data.pop('data_policy', None)
    if data_policy is not None:
        data_policy = str(data_policy).strip() or None
    return attempt_sync, reachable, data_policy


def get_active_instance_names(config: dict = None) -> list:
    cfg = config if config is not None else load_config()
    return [i['name'] for i in cfg.get('qbittorrent_instances', [])]


def get_active_emby_instance_names(config: dict = None) -> list:
    cfg = config if config is not None else load_config()
    return [i['name'] for i in cfg.get('emby_instances', [])]


def _clean_legacy_auth_fields(data: dict) -> dict:
    result = dict(data)
    result.pop('require_auth', None)
    result.pop('bypass_auth', None)
    return result


def resolve_instance_credentials_for_test(data: dict) -> dict:
    """测试仅用表单内容，不从配置文件合并密码"""
    result = _clean_legacy_auth_fields(data)
    username = str(result.get('username', '')).strip()
    password = result.get('password') or ''
    if is_password_mask(password):
        password = ''
    if not username:
        result['username'] = ''
        result['password'] = ''
    else:
        result['username'] = username
        result['password'] = password
    return result


def resolve_instance_credentials_for_test_with_existing(
        data: dict, existing: dict = None) -> dict:
    """连通性测试：表单为空时可使用 secrets 中已保存的 qB 密码"""
    result = resolve_instance_credentials_for_test(data)
    if existing and result.get('username') and not result.get('password'):
        result['password'] = secrets_store.get_qb_password(
            existing.get('name', '')
        )
    return result


def resolve_instance_credentials(data: dict, existing: dict = None) -> dict:
    """保存时解析凭据：密码写入 secrets 文件，不留在 config.yaml"""
    result = _clean_legacy_auth_fields(data)
    username = str(result.get('username', '')).strip()
    target_name = str(
        result.get('name') or (existing or {}).get('name', '')
    ).strip()
    password = result.get('password') or ''
    if is_password_mask(password):
        password = ''

    if not username:
        result['username'] = ''
        result.pop('password', None)
        if target_name:
            secrets_store.delete_qb_password(target_name)
        return result

    result['username'] = username
    if password:
        if target_name:
            secrets_store.set_qb_password(target_name, password)
    result.pop('password', None)
    return result


def _stored_lucky_rules(name: str) -> list:
    if not name:
        return []
    return secrets_store.get_lucky_rules(name)


def _bind_lucky_rules(raw, stored: list) -> list:
    """把表单里的规则收成带密钥的列表。只带名称的项按已保存规则补回密钥。"""
    if not isinstance(raw, list):
        return []
    bound = []
    seen = set()
    unlabeled = [item for item in stored if not item.get('label')]
    for item in raw:
        if not isinstance(item, dict):
            continue
        rule_key = str(item.get('rule_key') or '').strip()
        sub_key = str(item.get('sub_key') or '').strip()
        label = str(item.get('label') or '').strip()
        if is_password_mask(rule_key):
            rule_key = ''
        if is_password_mask(sub_key):
            sub_key = ''
        if not (rule_key and sub_key):
            match = next(
                (row for row in stored if label and row.get('label') == label),
                None,
            )
            if not match and label and len(stored) == 1 and unlabeled:
                match = stored[0]
            if not match:
                raise ValueError('请重新进行连通性测试并选择反代规则')
            rule_key = match['rule_key']
            sub_key = match['sub_key']
            label = label or match.get('label') or ''
        pair = (rule_key, sub_key)
        if pair in seen:
            continue
        seen.add(pair)
        bound.append({
            'rule_key': rule_key,
            'sub_key': sub_key,
            'label': label,
        })
    return bound


def request_lucky_rules(data: dict, stored: list = None) -> list:
    """从保存或测试请求里取出要使用的反代规则。未提供时返回 None。"""
    stored = list(stored or [])
    if isinstance(data, dict) and 'lucky_rules' in data:
        return _bind_lucky_rules(data.get('lucky_rules'), stored)
    rule_key = str((data or {}).get('lucky_rule_key') or '').strip()
    sub_key = str((data or {}).get('lucky_sub_key') or '').strip()
    if is_password_mask(rule_key):
        rule_key = ''
    if is_password_mask(sub_key):
        sub_key = ''
    label = str((data or {}).get('lucky_rule_label') or '').strip()
    if rule_key and sub_key:
        return [{'rule_key': rule_key, 'sub_key': sub_key, 'label': label}]
    if label and not rule_key and not sub_key:
        return _bind_lucky_rules([{'label': label, 'keep': True}], stored)
    return None


def lucky_rules_label(rules: list) -> str:
    return '；'.join(
        str(item.get('label') or '').strip()
        for item in (rules or [])
        if str(item.get('label') or '').strip()
    )


def resolve_emby_credentials(data: dict, existing: dict = None) -> dict:
    """保存时解析凭据：API Key 写入 secrets 文件，不留在 config.yaml"""
    result = copy.deepcopy(data)
    target_name = str(
        result.get('name') or (existing or {}).get('name', '')
    ).strip()
    api_key = str(result.get('api_key', '') or '').strip()
    if is_password_mask(api_key):
        api_key = ''
    if api_key and target_name:
        secrets_store.set_emby_api_key(target_name, api_key)
    lucky_token = str(result.get('lucky_open_token', '') or '').strip()
    if is_password_mask(lucky_token):
        lucky_token = ''
    if lucky_token and target_name:
        secrets_store.set_lucky_open_token(target_name, lucky_token)
    if target_name and (
        'lucky_rules' in result or result.get('lucky_rule_key') or result.get('lucky_sub_key')
    ):
        rules = request_lucky_rules(result, _stored_lucky_rules(target_name))
        if rules:
            secrets_store.set_lucky_rules(target_name, rules)
            result['lucky_rule_label'] = lucky_rules_label(rules)
    result.pop('api_key', None)
    result.pop('lucky_open_token', None)
    result.pop('lucky_rule_key', None)
    result.pop('lucky_sub_key', None)
    result.pop('lucky_rules', None)
    return result


def _migrate_instances(instances: list, global_reset_day: int = 1) -> list:
    """将旧版全局 reset_day 迁移到各设备 cycle.reset_anchor"""
    migrated = []
    for inst in instances:
        item = dict(inst)
        if 'cycle' not in item or not item.get('cycle'):
            if 'reset_day' not in item:
                item.setdefault('cycle', {})['reset_anchor'] = global_reset_day
        migrated.append(_migrate_instance_fields(item))
    for i, item in enumerate(migrated):
        try:
            priority = int(item.get('display_priority', 0))
        except (TypeError, ValueError):
            priority = 0
        if priority < 1 or priority > DISPLAY_PRIORITY_MAX:
            item['display_priority'] = i + 1
        else:
            item['display_priority'] = priority
    return migrated


def _normalize_config(cfg: dict) -> dict:
    result = get_default_config()
    if cfg:
        global_cfg = cfg.get('global') or {}
        legacy_reset_day = _safe_int(global_cfg.get('reset_day'), 1)
        result['global'].update(global_cfg)
        emby_instances = cfg.get('emby_instances') or []
        for i, item in enumerate(emby_instances):
            emby_instances[i] = _migrate_emby_instance_fields(dict(item))
        result['emby_instances'] = emby_instances
        if 'emby_enabled' not in global_cfg and emby_instances:
            result['global']['emby_enabled'] = True
        result['global'] = _validate_global(
            result['global'],
            emby_instances=result['emby_instances'],
        )
        instances = _migrate_instances(
            cfg.get('qbittorrent_instances') or [],
            legacy_reset_day,
        )
        result['qbittorrent_instances'] = instances
    return result


def _read_config_file(path: str) -> dict:
    with open(path, 'r', encoding='utf-8') as f:
        cfg = yaml.safe_load(f) or {}
    return _normalize_config(cfg)


def _strip_secrets_from_config(config: dict) -> dict:
    """写入 yaml 前移除凭据字段"""
    result = copy.deepcopy(config)
    global_cfg = result.get('global', {})
    global_cfg.pop('web_username', None)
    global_cfg.pop('web_password', None)
    for inst in result.get('qbittorrent_instances', []):
        inst.pop('password', None)
    for inst in result.get('emby_instances', []):
        inst.pop('api_key', None)
        inst.pop('lucky_rule_key', None)
        inst.pop('lucky_sub_key', None)
    return result


def enrich_instance(inst: dict) -> dict:
    """为运行时连接注入 secrets 中的 qB 密码"""
    result = copy.deepcopy(inst)
    result['password'] = secrets_store.get_qb_password(inst.get('name', ''))
    return result


def enrich_emby_instance(inst: dict) -> dict:
    """为运行时连接注入 secrets 中的 Emby API Key 与 Lucky 规则 key"""
    result = copy.deepcopy(inst)
    name = inst.get('name', '')
    result['api_key'] = secrets_store.get_emby_api_key(name)
    rules = _stored_lucky_rules(name)
    if len(rules) == 1 and not rules[0].get('label'):
        rules[0]['label'] = str(result.get('lucky_rule_label') or '').strip()
    result['lucky_rules'] = rules
    if rules:
        result['lucky_rule_key'] = rules[0]['rule_key']
        result['lucky_sub_key'] = rules[0]['sub_key']
        label = lucky_rules_label(rules)
        if label:
            result['lucky_rule_label'] = label
    else:
        result['lucky_rule_key'] = ''
        result['lucky_sub_key'] = ''
    return result


def enrich_config(config: dict) -> dict:
    """为运行时注入全部 qB 密码与 Emby API Key"""
    result = copy.deepcopy(config)
    result['qbittorrent_instances'] = [
        enrich_instance(i) for i in result.get('qbittorrent_instances', [])
    ]
    result['emby_instances'] = [
        enrich_emby_instance(i) for i in result.get('emby_instances', [])
    ]
    return result


def load_runtime_config(path: str = CONFIG_PATH) -> dict:
    return enrich_config(load_config(path))


def migrate_plaintext_secrets(config: dict) -> tuple:
    """从 config.yaml 明文迁移凭据到 secrets 文件，返回 (config, migrated)"""
    migrated = False
    result = copy.deepcopy(config)
    global_cfg = dict(result.get('global') or {})

    web_user = str(global_cfg.pop('web_username', '') or '').strip()
    web_pass = global_cfg.pop('web_password', '') or ''
    if web_pass and web_pass != '******':
        secrets_store.set_web_credentials(
            web_user or secrets_store.DEFAULT_WEB_USER,
            web_pass,
        )
        migrated = True
        logger.info('已从 config.yaml 迁移 Web 凭据到 secrets 文件')
    elif web_user:
        secrets_store.set_web_credentials(web_user)
        migrated = True
        logger.info('已从 config.yaml 迁移 Web 用户名到 secrets 文件')

    for inst in result.get('qbittorrent_instances', []):
        pwd = inst.pop('password', '') or ''
        if pwd and pwd != '******':
            name = inst.get('name', '')
            if name:
                secrets_store.set_qb_password(name, pwd)
                migrated = True
                logger.info(f'已从 config.yaml 迁移 qB 凭据: {name}')

    for inst in result.get('emby_instances', []):
        api_key = inst.pop('api_key', '') or ''
        if api_key and api_key != '******':
            name = inst.get('name', '')
            if name:
                secrets_store.set_emby_api_key(name, api_key)
                migrated = True
                logger.info(f'已从 config.yaml 迁移 Emby API Key: {name}')
        rule_key = inst.pop('lucky_rule_key', '') or ''
        sub_key = inst.pop('lucky_sub_key', '') or ''
        if rule_key and rule_key != '******':
            name = inst.get('name', '')
            if name:
                secrets_store.set_lucky_rule_key(name, rule_key)
                migrated = True
                logger.info(f'已从 config.yaml 迁移 Lucky rule_key: {name}')
        if sub_key and sub_key != '******':
            name = inst.get('name', '')
            if name:
                secrets_store.set_lucky_sub_key(name, sub_key)
                migrated = True
                logger.info(f'已从 config.yaml 迁移 Lucky sub_key: {name}')

    result['global'] = global_cfg
    return result, migrated


def _write_config_file(config: dict, path: str = CONFIG_PATH) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    safe_config = _strip_secrets_from_config(config)
    tmp_path = f'{path}.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        yaml.dump(safe_config, f, allow_unicode=True, default_flow_style=False,
                  sort_keys=False)
    os.replace(tmp_path, path)
    logger.info(f"配置文件已保存: {path}")


def _create_default_config(path: str = CONFIG_PATH) -> dict:
    config = get_default_config()
    if os.path.exists(SEED_CONFIG_PATH):
        try:
            with open(SEED_CONFIG_PATH, 'r', encoding='utf-8') as f:
                seed = yaml.safe_load(f) or {}
            config = _normalize_config(seed)
            logger.info(f"已从种子配置导入: {SEED_CONFIG_PATH}")
        except Exception as e:
            logger.warning(f"读取种子配置失败 ({SEED_CONFIG_PATH}): {e}")
    _write_config_file(config, path)
    logger.info(f"已自动生成配置文件: {path}")
    return config


def load_config(path: str = CONFIG_PATH) -> dict:
    with _lock:
        secrets_store.ensure_data_key()
        secrets_store.ensure_web_auth()
        if not os.path.exists(path):
            config = _create_default_config(path)
        else:
            config = _read_config_file(path)
            logger.info(f"配置文件加载成功: {path}")
        config, migrated = migrate_plaintext_secrets(config)
        if migrated:
            _write_config_file(config, path)
        return config


def ensure_config(path: str = CONFIG_PATH) -> dict:
    """确保配置文件存在；不存在则自动生成（可导入只读种子配置）"""
    return load_config(path)


def save_config(config: dict, path: str = CONFIG_PATH) -> None:
    with _lock:
        config.setdefault('qbittorrent_instances', [])
        config.setdefault('emby_instances', [])
        _write_config_file(config, path)


def _clean_device_name(value) -> str:
    name = str(value or '').strip()
    if not name or len(name) > INSTANCE_NAME_MAX_LENGTH:
        return ''
    return name


def _migrate_default_display(stored: dict) -> None:
    """旧配置只有平台。没有新字段时，用它填电脑和手机的默认显示。"""
    if not isinstance(stored, dict):
        return
    legacy = str(stored.get('emby_default_device_view') or 'qb').strip().lower()
    if legacy not in EMBY_DEFAULT_DEVICE_VIEWS:
        legacy = 'qb'
    if 'default_pc_view' not in stored:
        stored['default_pc_view'] = legacy
    if 'default_pc_device' not in stored:
        stored['default_pc_device'] = ''
    if 'default_mobile_view' not in stored:
        stored['default_mobile_view'] = legacy if legacy in MOBILE_DEFAULT_VIEWS else 'qb'
    if 'default_mobile_device' not in stored:
        stored['default_mobile_device'] = ''


def _normalize_default_display(result: dict) -> None:
    pc = str(result.get('default_pc_view') or 'qb').strip().lower()
    if pc not in EMBY_DEFAULT_DEVICE_VIEWS:
        pc = 'qb'
    result['default_pc_view'] = pc
    result['default_pc_device'] = '' if pc == 'merge' else _clean_device_name(result.get('default_pc_device'))
    mobile = str(result.get('default_mobile_view') or 'qb').strip().lower()
    if mobile not in MOBILE_DEFAULT_VIEWS:
        mobile = 'qb'
    result['default_mobile_view'] = mobile
    result['default_mobile_device'] = _clean_device_name(result.get('default_mobile_device'))
    result['emby_default_device_view'] = pc


def get_global_config(config: dict = None) -> dict:
    cfg = config or load_config()
    stored = dict(cfg.get('global') or {})
    _migrate_default_display(stored)
    result = {**DEFAULT_GLOBAL, **stored}
    _normalize_default_display(result)
    return result


def get_instances(config: dict = None) -> list:
    cfg = config or load_config()
    return copy.deepcopy(cfg.get('qbittorrent_instances', []))


def get_instance(name: str, config: dict = None) -> dict:
    for inst in get_instances(config):
        if inst['name'] == name:
            return inst
    return None


def clamp_emby_m3_wan_pool_scale(value, *, strict: bool = False) -> float:
    """M3 WAN 池补偿系数：1.0=不调整；>1 放大；<1 缩小。仅 M3 生效。"""
    try:
        scale = float(value)
    except (TypeError, ValueError):
        scale = float(DEFAULT_GLOBAL['emby_m3_wan_pool_scale'])
    if strict:
        if scale < EMBY_M3_WAN_POOL_SCALE_MIN or scale > EMBY_M3_WAN_POOL_SCALE_MAX:
            raise ValueError(
                f'M3 WAN 池系数须在 {EMBY_M3_WAN_POOL_SCALE_MIN}～{EMBY_M3_WAN_POOL_SCALE_MAX} 之间',
            )
        return round(scale, 2)
    scale = max(EMBY_M3_WAN_POOL_SCALE_MIN, min(EMBY_M3_WAN_POOL_SCALE_MAX, scale))
    return round(scale, 2)


def clamp_emby_browse_upload_min_mb(value, *, strict: bool = False) -> float:
    """选片流量入账阈值（MB）：单次选片段累计上传不低于该值才写入统计与日志。"""
    try:
        mb = float(value)
    except (TypeError, ValueError):
        mb = float(DEFAULT_GLOBAL['emby_browse_upload_min_mb'])
    if strict:
        if mb < EMBY_BROWSE_UPLOAD_MIN_MB_MIN or mb > EMBY_BROWSE_UPLOAD_MIN_MB_MAX:
            lo = int(EMBY_BROWSE_UPLOAD_MIN_MB_MIN) if EMBY_BROWSE_UPLOAD_MIN_MB_MIN == int(EMBY_BROWSE_UPLOAD_MIN_MB_MIN) else EMBY_BROWSE_UPLOAD_MIN_MB_MIN
            hi = int(EMBY_BROWSE_UPLOAD_MIN_MB_MAX) if EMBY_BROWSE_UPLOAD_MIN_MB_MAX == int(EMBY_BROWSE_UPLOAD_MIN_MB_MAX) else EMBY_BROWSE_UPLOAD_MIN_MB_MAX
            raise ValueError(
                f'选片入账阈值须在 {lo}～{hi} MB 之间',
            )
        return round(mb, 2)
    mb = max(
        EMBY_BROWSE_UPLOAD_MIN_MB_MIN,
        min(EMBY_BROWSE_UPLOAD_MIN_MB_MAX, mb),
    )
    return round(mb, 2)


def emby_browse_upload_min_bytes(global_cfg: dict = None) -> int:
    cfg = global_cfg if isinstance(global_cfg, dict) else DEFAULT_GLOBAL
    mb = clamp_emby_browse_upload_min_mb(
        cfg.get('emby_browse_upload_min_mb', DEFAULT_GLOBAL['emby_browse_upload_min_mb']),
    )
    return int(mb * 1024 * 1024)


def clamp_emby_preplay_burst_mbps(value, *, strict: bool = False) -> float:
    """推流突发识别阈值（MB/s）：会话尚未 playing 时上传速率超过该值即判为开播缓冲。"""
    try:
        mbps = float(value)
    except (TypeError, ValueError):
        mbps = float(DEFAULT_GLOBAL['emby_preplay_burst_mbps'])
    if strict:
        if mbps < EMBY_PREPLAY_BURST_MBPS_MIN or mbps > EMBY_PREPLAY_BURST_MBPS_MAX:
            raise ValueError(
                f'推流突发识别阈值须在 {EMBY_PREPLAY_BURST_MBPS_MIN}～'
                f'{EMBY_PREPLAY_BURST_MBPS_MAX} MB/s 之间',
            )
        return round(mbps, 2)
    mbps = max(
        EMBY_PREPLAY_BURST_MBPS_MIN,
        min(EMBY_PREPLAY_BURST_MBPS_MAX, mbps),
    )
    return round(mbps, 2)


def emby_preplay_burst_bps(global_cfg: dict = None) -> int:
    """推流突发识别阈值换算为字节/秒（MB 按十进制 1,000,000，与历史默认 1.5MB/s 一致）。"""
    cfg = global_cfg if isinstance(global_cfg, dict) else DEFAULT_GLOBAL
    mbps = clamp_emby_preplay_burst_mbps(
        cfg.get('emby_preplay_burst_mbps', DEFAULT_GLOBAL['emby_preplay_burst_mbps']),
    )
    return int(mbps * 1_000_000)


def clamp_emby_preplay_burst_window_seconds(value, *, strict: bool = False) -> int:
    """开播前突发窗口（秒）：开播瞬间往前回溯该秒数，窗口内的推流突发归为播放。"""
    try:
        seconds = int(round(float(value)))
    except (TypeError, ValueError):
        seconds = int(DEFAULT_GLOBAL['emby_preplay_burst_window_seconds'])
    if strict:
        if (seconds < EMBY_PREPLAY_BURST_WINDOW_SECONDS_MIN
                or seconds > EMBY_PREPLAY_BURST_WINDOW_SECONDS_MAX):
            raise ValueError(
                f'开播前突发窗口须在 {EMBY_PREPLAY_BURST_WINDOW_SECONDS_MIN}～'
                f'{EMBY_PREPLAY_BURST_WINDOW_SECONDS_MAX} 秒之间',
            )
        return seconds
    return max(
        EMBY_PREPLAY_BURST_WINDOW_SECONDS_MIN,
        min(EMBY_PREPLAY_BURST_WINDOW_SECONDS_MAX, seconds),
    )


def _safe_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _validate_global(global_cfg: dict, strict: bool = False,
                     emby_instances: list = None) -> dict:
    result = {**DEFAULT_GLOBAL, **(global_cfg or {})}
    refresh_interval = _safe_int(result.get('refresh_interval'), 1)

    if strict:
        if refresh_interval < REFRESH_INTERVAL_MIN:
            raise ValueError(f'刷新间隔不能小于 {REFRESH_INTERVAL_MIN} 秒')
        if refresh_interval > REFRESH_INTERVAL_MAX:
            raise ValueError(f'刷新间隔不能超过 {REFRESH_INTERVAL_MAX} 秒')
        username = str(result.pop('web_username', '') or '').strip()
        if not username:
            username = secrets_store.get_web_username()
        if not username:
            raise ValueError('请填写账号')
        new_password = result.pop('web_password', None)
        password_to_set = None
        if new_password and new_password != '******':
            if len(str(new_password)) < 6:
                raise ValueError('密码至少 6 位')
            password_to_set = str(new_password)
        secrets_store.set_web_credentials(username, password_to_set)
    else:
        refresh_interval = max(
            REFRESH_INTERVAL_MIN, min(REFRESH_INTERVAL_MAX, refresh_interval))
        result.pop('web_username', None)
        result.pop('web_password', None)

    collect_interval = collect_interval_for_refresh(refresh_interval)

    retention_years = _safe_int(
        result.get('data_retention_years'), DEFAULT_GLOBAL['data_retention_years'])
    if strict:
        if retention_years < 1 or retention_years > 20:
            raise ValueError('数据保存年限须在 1～20 年之间')
    else:
        retention_years = max(1, min(20, retention_years))

    result.pop('reset_day', None)
    result['collect_interval'] = collect_interval
    result['refresh_interval'] = refresh_interval
    result['data_retention_years'] = retention_years
    result['web_port'] = max(1024, min(65535, _safe_int(result.get('web_port'), 8765)))
    result['timezone'] = str(result.get('timezone') or 'Asia/Shanghai')
    result['emby_enabled'] = bool(result.get('emby_enabled', False))
    _normalize_default_display(result)
    burst_new_window = _safe_int(
        result.get('emby_burst_new_session_window_seconds'),
        DEFAULT_GLOBAL['emby_burst_new_session_window_seconds'],
    )
    burst_seek_window = _safe_int(
        result.get('emby_burst_seek_window_seconds'),
        DEFAULT_GLOBAL['emby_burst_seek_window_seconds'],
    )
    if strict:
        if burst_new_window < 1 or burst_new_window > 30:
            raise ValueError('新会话突发窗口须在 1～30 秒之间')
        if burst_seek_window < 1 or burst_seek_window > 30:
            raise ValueError('跳转突发窗口须在 1～30 秒之间')
    else:
        burst_new_window = max(1, min(30, burst_new_window))
        burst_seek_window = max(1, min(30, burst_seek_window))
    result['emby_burst_new_session_window_seconds'] = burst_new_window
    result['emby_burst_seek_window_seconds'] = burst_seek_window
    burst_priority_mode = str(
        result.get(
            'emby_burst_priority_mode',
            DEFAULT_GLOBAL['emby_burst_priority_mode'],
        ) or ''
    ).strip().lower()
    if burst_priority_mode not in EMBY_BURST_PRIORITY_MODES:
        burst_priority_mode = DEFAULT_GLOBAL['emby_burst_priority_mode']
    result['emby_burst_priority_mode'] = burst_priority_mode
    mode_switch_grace = _safe_int(
        result.get('emby_mode_switch_grace_seconds'),
        DEFAULT_GLOBAL['emby_mode_switch_grace_seconds'],
    )
    if strict:
        if mode_switch_grace < 0 or mode_switch_grace > 10:
            raise ValueError('模式切换缓冲须在 0～10 秒之间')
    else:
        mode_switch_grace = max(0, min(10, mode_switch_grace))
    result['emby_mode_switch_grace_seconds'] = mode_switch_grace
    result['emby_preplay_burst_mbps'] = clamp_emby_preplay_burst_mbps(
        result.get('emby_preplay_burst_mbps', DEFAULT_GLOBAL['emby_preplay_burst_mbps']),
        strict=strict,
    )
    result['emby_preplay_burst_window_seconds'] = clamp_emby_preplay_burst_window_seconds(
        result.get(
            'emby_preplay_burst_window_seconds',
            DEFAULT_GLOBAL['emby_preplay_burst_window_seconds'],
        ),
        strict=strict,
    )
    result['emby_m3_wan_pool_scale'] = clamp_emby_m3_wan_pool_scale(
        result.get('emby_m3_wan_pool_scale', DEFAULT_GLOBAL['emby_m3_wan_pool_scale']),
        strict=strict,
    )
    result['emby_browse_upload_min_mb'] = clamp_emby_browse_upload_min_mb(
        result.get('emby_browse_upload_min_mb', DEFAULT_GLOBAL['emby_browse_upload_min_mb']),
        strict=strict,
    )
    if strict and emby_instances is not None:
        if not result['emby_enabled'] and len(emby_instances) > 0:
            raise ValueError('请先删除所有 Emby 设备后再关闭 Emby 功能')
    return result


def _validate_cycle(cycle: dict) -> dict:
    result = {**DEFAULT_CYCLE, **(cycle or {})}
    ctype = str(result.get('type', 'month')).strip().lower()
    if ctype not in CYCLE_TYPES:
        ctype = 'month'
    result['type'] = ctype
    anchor = _safe_int(result.get('reset_anchor'), 1)
    if ctype == 'month':
        result['reset_anchor'] = max(1, min(28, anchor))
    elif ctype == 'week':
        result['reset_anchor'] = max(1, min(7, anchor))
    else:
        raw = result.get('reset_anchor')
        if raw is None:
            anchor = 0
        else:
            try:
                anchor = int(raw)
            except (TypeError, ValueError):
                anchor = 0
        result['reset_anchor'] = max(0, min(23, anchor))
    result['reset_limit_kbps'] = _validate_upload_limit_kbps(
        result.get('reset_limit_kbps', 0),
        '恢复限速',
    )
    return result


def _validate_cycle_plan(plan: dict) -> dict:
    plan = plan or {}
    return {
        'cycle': _validate_cycle(plan.get('cycle')),
        'speed_rules': _validate_speed_rules(plan.get('speed_rules')),
    }


def cycle_plans_equal(plan_a: dict, plan_b: dict) -> bool:
    if not plan_a or not plan_b:
        return False
    if plan_a.get('cycle') != plan_b.get('cycle'):
        return False
    rules_a = plan_a.get('speed_rules') or []
    rules_b = plan_b.get('speed_rules') or []
    if len(rules_a) != len(rules_b):
        return False
    for left, right in zip(rules_a, rules_b):
        if float(left.get('cycle_upload_limit_gb', 0)) != float(
                right.get('cycle_upload_limit_gb', 0)):
            return False
        if int(left.get('speed_limit_kbps', 0)) != int(
                right.get('speed_limit_kbps', 0)):
            return False
    return True


def _validate_upload_limit_kbps(value, field_label: str = '限速') -> int:
    try:
        limit = int(value or 0)
    except (TypeError, ValueError):
        raise ValueError(f'{field_label}须为 0–{QB_MAX_UPLOAD_LIMIT_KBPS} 的整数')
    if limit < 0 or limit > QB_MAX_UPLOAD_LIMIT_KBPS:
        raise ValueError(
            f'{field_label}须在 0–{QB_MAX_UPLOAD_LIMIT_KBPS} 之间（0 表示不限速）'
        )
    return limit


def _validate_speed_rules(rules: list) -> list:
    if not rules:
        return [{'cycle_upload_limit_gb': 500, 'speed_limit_kbps': 128}]
    validated = []
    for i, rule in enumerate(rules):
        threshold = rule.get('cycle_upload_limit_gb')
        if threshold is None:
            threshold = rule.get('monthly_upload_limit_gb', 0)
        validated.append({
            'cycle_upload_limit_gb': max(0.01, float(threshold)),
            'speed_limit_kbps': _validate_upload_limit_kbps(
                rule.get('speed_limit_kbps', 0),
                f'规则 {i + 1} 的限速',
            ),
        })
    for i in range(1, len(validated)):
        if validated[i]['cycle_upload_limit_gb'] <= validated[i - 1]['cycle_upload_limit_gb']:
            raise ValueError(f'规则 {i + 1} 的上行阈值须大于规则 {i}')
    return validated


def _validate_instance(inst: dict, existing_names: list = None,
                       original_name: str = None, require_name: bool = True) -> dict:
    result = {**DEFAULT_INSTANCE, **inst}
    result['name'] = str(result.get('name', '')).strip()
    host, port = _parse_host_port(
        str(result.get('host', '')).strip(),
        _safe_int(result.get('port'), 8080),
    )
    result['host'] = host
    result['port'] = max(1, min(65535, port))

    if require_name and not result['name']:
        raise ValueError('请填写名称')
    if result['name'] and len(result['name']) > INSTANCE_NAME_MAX_LENGTH:
        raise ValueError(f'名称不能超过 {INSTANCE_NAME_MAX_LENGTH} 个字符')
    if not result['host']:
        raise ValueError('请填写地址')
    if result['port'] < 1 or result['port'] > 65535:
        raise ValueError('请填写有效的地址与端口，格式如 example.com:8080')

    if existing_names:
        for n in existing_names:
            if n == result['name'] and n != original_name:
                raise ValueError('名称已存在')

    result['use_https'] = bool(result.get('use_https', False))
    result['verify_ssl'] = bool(result.get('verify_ssl', False))
    result.pop('base_path', None)
    result.pop('force_https', None)
    result['allow_manual_unlimit'] = bool(
        result.get('allow_manual_unlimit', result.get('restore_on_reset', True))
    )
    result.pop('restore_on_reset', None)
    result.pop('bypass_auth', None)
    result.pop('require_auth', None)
    result['username'] = str(result.get('username', '')).strip()
    password = result.pop('password', '') or ''
    if is_password_mask(password):
        password = ''
    if not password and result['username']:
        password = secrets_store.get_qb_password(result['name'])
        if not password and original_name:
            password = secrets_store.get_qb_password(original_name)
    if not result['username']:
        result['username'] = ''
        secrets_store.delete_qb_password(result['name'])
    elif not password and not require_name:
        raise ValueError('请填写密码')
    elif not password:
        raise ValueError('请填写密码')
    result['connection_timeout'] = INSTANCE_HTTP_TIMEOUT
    result['read_timeout'] = INSTANCE_HTTP_TIMEOUT
    try:
        priority = int(result.get('display_priority', 1))
    except (TypeError, ValueError):
        priority = 1
    result['display_priority'] = max(1, min(DISPLAY_PRIORITY_MAX, priority))
    result['cycle'] = _validate_cycle(result.get('cycle'))
    result.pop('reset_day', None)
    result.pop('reset_day_limit_kbps', None)
    result['speed_rules'] = _validate_speed_rules(result.get('speed_rules', []))
    result.pop('apply_rules_now', None)
    result.pop('attempt_sync', None)
    result.pop('reachable', None)

    current_plan = {
        'cycle': result['cycle'],
        'speed_rules': result['speed_rules'],
    }
    raw_plan = inst.get('next_cycle_plan')
    if raw_plan is None:
        result.pop('next_cycle_plan', None)
    else:
        validated_plan = _validate_cycle_plan(raw_plan)
        if cycle_plans_equal(validated_plan, current_plan):
            raise ValueError(
                '下周期计划与当前周期与达量规则设置完全相同，请修改或移除下周期计划'
            )
        result['next_cycle_plan'] = validated_plan

    return result


def validate_instance_for_test(inst: dict) -> dict:
    """连通性测试用的宽松校验（名称可选）"""
    result = _validate_instance(inst, require_name=False)
    username = result.get('username', '')
    if username:
        password = inst.get('password') or ''
        if is_password_mask(password):
            password = ''
        if not password:
            password = secrets_store.get_qb_password(result.get('name', ''))
        result['password'] = password
    return result


def _merge_config_preserve_lists(base: dict) -> dict:
    """写入磁盘前合并配置，避免内存中的 monitor.config 缺少 emby/qB 列表时覆盖文件"""
    merged = copy.deepcopy(base or get_default_config())
    merged.setdefault('qbittorrent_instances', [])
    merged.setdefault('emby_instances', [])
    if os.path.exists(CONFIG_PATH):
        try:
            disk = _read_config_file(CONFIG_PATH)
            if not merged.get('qbittorrent_instances') and disk.get('qbittorrent_instances'):
                merged['qbittorrent_instances'] = disk['qbittorrent_instances']
            if not merged.get('emby_instances') and disk.get('emby_instances'):
                merged['emby_instances'] = disk['emby_instances']
        except Exception:
            pass
    return merged


def update_global(global_cfg: dict, base_config: dict = None) -> tuple:
    """更新全局设置，返回 (global配置, 完整配置)。基于 base_config 合并，避免丢失设备列表。"""
    with _lock:
        if base_config is not None:
            config = _merge_config_preserve_lists(base_config)
        elif os.path.exists(CONFIG_PATH):
            config = _read_config_file(CONFIG_PATH)
        else:
            config = get_default_config()

        config.setdefault('qbittorrent_instances', [])
        config.setdefault('emby_instances', [])
        stored_global = dict(config.get('global') or {})
        _migrate_default_display(stored_global)
        current_global = {**DEFAULT_GLOBAL, **stored_global}
        merged_global = {**current_global, **(global_cfg or {})}
        config['global'] = _validate_global(
            merged_global,
            strict=True,
            emby_instances=config.get('emby_instances') or [],
        )
        _write_config_file(config)
        return config['global'], copy.deepcopy(config)


def add_instance(inst: dict) -> dict:
    config = load_config()
    instances = config.get('qbittorrent_instances', [])
    names = [i['name'] for i in instances]
    inst = resolve_instance_credentials(inst)
    validated = _validate_instance(inst, existing_names=names)
    _check_duplicate_connection(instances, validated)
    config.setdefault('qbittorrent_instances', []).append(validated)
    save_config(config)
    return validated


_CONNECTION_KEYS = (
    'host', 'port', 'use_https', 'verify_ssl', 'username',
)

_CYCLE_SETTINGS_KEYS = (
    'cycle', 'speed_rules', 'next_cycle_plan',
)


def _config_value_key(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def instance_connection_changed(existing: dict, updated: dict,
                                existing_name: str = None) -> bool:
    """连接参数是否变更（变更后需重新探测在线状态）"""
    if not existing:
        return True
    for key in _CONNECTION_KEYS:
        if _config_value_key(existing.get(key)) != _config_value_key(updated.get(key)):
            return True
    old_name = existing_name or existing.get('name', '')
    new_name = updated.get('name', '')
    old_pwd = secrets_store.get_qb_password(old_name)
    new_pwd = secrets_store.get_qb_password(new_name)
    if old_pwd != new_pwd:
        return True
    return False


def _cycle_semantically_equal(cycle_a: dict, cycle_b: dict) -> bool:
    return _config_value_key(_validate_cycle(cycle_a or {})) == _config_value_key(
        _validate_cycle(cycle_b or {})
    )


def _speed_rules_semantically_equal(rules_a: list, rules_b: list) -> bool:
    left = _validate_speed_rules(rules_a or [])
    right = _validate_speed_rules(rules_b or [])
    if len(left) != len(right):
        return False
    for la, rb in zip(left, right):
        if float(la['cycle_upload_limit_gb']) != float(rb['cycle_upload_limit_gb']):
            return False
        if int(la['speed_limit_kbps']) != int(rb['speed_limit_kbps']):
            return False
    return True


def _next_cycle_plan_semantically_equal(plan_a: dict, plan_b: dict) -> bool:
    empty_a = not plan_a
    empty_b = not plan_b
    if empty_a and empty_b:
        return True
    if empty_a != empty_b:
        return False
    return cycle_plans_equal(_validate_cycle_plan(plan_a), _validate_cycle_plan(plan_b))


def instance_cycle_settings_changed(existing: dict, updated: dict) -> bool:
    """周期与达量规则是否有变更（规范化后比较，避免表单与配置结构差异误判）"""
    if not existing:
        return False
    if not _cycle_semantically_equal(existing.get('cycle'), updated.get('cycle')):
        return True
    if not _speed_rules_semantically_equal(
            existing.get('speed_rules'), updated.get('speed_rules')):
        return True
    if not _next_cycle_plan_semantically_equal(
            existing.get('next_cycle_plan'), updated.get('next_cycle_plan')):
        return True
    return False


def instance_only_basics_changed(existing: dict, updated: dict) -> bool:
    """仅显示名称或设备序号有变更（其余配置未动）"""
    if not existing:
        return False
    if instance_connection_changed(existing, updated):
        return False
    if instance_cycle_settings_changed(existing, updated):
        return False
    return True


_EMBY_CONNECTION_KEYS = (
    'host', 'port', 'use_https', 'verify_ssl',
    'traffic_collect_mode',
    'lucky_base_url', 'lucky_verify_ssl', 'lucky_rule_key', 'lucky_sub_key',
    'lucky_rule_label', 'lucky_frontend_host', 'lucky_credit_browse_traffic',
)


def emby_instance_connection_changed(existing: dict, updated: dict,
                                     api_key_in_request: str = '') -> bool:
    """Emby 连接/采集参数是否变更"""
    if not existing:
        return True
    for key in _EMBY_CONNECTION_KEYS:
        if _config_value_key(existing.get(key)) != _config_value_key(updated.get(key)):
            return True
    key_text = str(api_key_in_request or '').strip()
    if key_text and not is_password_mask(key_text):
        return True
    return False


def emby_instance_only_basics_changed(existing: dict, updated: dict,
                                    api_key_in_request: str = '') -> bool:
    """仅显示名称或设备序号有变更（其余 Emby 配置未动）"""
    if not existing:
        return False
    if emby_instance_connection_changed(existing, updated, api_key_in_request):
        return False
    return True


def instance_affects_qb_sync(existing: dict, updated: dict) -> bool:
    """保存项是否涉及需延后同步到 qB 的配置（周期与达量规则）"""
    return instance_cycle_settings_changed(existing, updated)


def update_instance(name: str, inst: dict) -> dict:
    config = load_config()
    instances = config.get('qbittorrent_instances', [])
    names = [i['name'] for i in instances]
    idx = next((i for i, x in enumerate(instances) if x['name'] == name), None)
    if idx is None:
        raise ValueError('设备不存在')

    existing = instances[idx]
    inst = resolve_instance_credentials(inst, existing)

    validated = _validate_instance(inst, existing_names=names, original_name=name)
    _check_duplicate_connection(instances, validated, original_name=name)
    if name != validated['name']:
        secrets_store.rename_qb_password(name, validated['name'])
    instances[idx] = validated
    config['qbittorrent_instances'] = instances
    save_config(config)
    return validated


def promote_next_cycle_plan(config: dict, instance_name: str) -> dict:
    """将下周期计划提升为当前配置并写入配置文件"""
    config = copy.deepcopy(config or get_default_config())
    config.setdefault('qbittorrent_instances', [])
    config.setdefault('emby_instances', [])
    promoted = False
    for inst in config['qbittorrent_instances']:
        if inst.get('name') != instance_name:
            continue
        plan = inst.pop('next_cycle_plan', None)
        if not plan:
            break
        validated_plan = _validate_cycle_plan(plan)
        inst['cycle'] = validated_plan['cycle']
        inst['speed_rules'] = validated_plan['speed_rules']
        promoted = True
        break
    if promoted:
        on_disk = load_config()
        for inst in on_disk.get('qbittorrent_instances', []):
            if inst.get('name') != instance_name:
                continue
            for src in config.get('qbittorrent_instances', []):
                if src.get('name') == instance_name:
                    inst['cycle'] = src.get('cycle')
                    inst['speed_rules'] = src.get('speed_rules')
                    break
            inst.pop('next_cycle_plan', None)
            break
        save_config(on_disk)
    return config


def delete_instance(name: str) -> bool:
    config = load_config()
    instances = config.get('qbittorrent_instances', [])
    new_instances = [i for i in instances if i['name'] != name]
    if len(new_instances) == len(instances):
        raise ValueError('设备不存在')
    config['qbittorrent_instances'] = new_instances
    secrets_store.delete_qb_password(name)
    save_config(config)
    return True


def mask_instance_for_api(inst: dict) -> dict:
    result = copy.deepcopy(_migrate_instance_fields(inst))
    result.pop('password', None)
    result['has_password'] = secrets_store.has_qb_password(result.get('name', ''))
    return result


def mask_global_for_api(global_cfg: dict, config: dict = None) -> dict:
    stored = dict(global_cfg or {})
    _migrate_default_display(stored)
    result = {**DEFAULT_GLOBAL, **stored}
    result.pop('reset_day', None)
    result.pop('web_password', None)
    result['web_username'] = secrets_store.get_web_username()
    result['has_web_password'] = secrets_store.has_web_password()
    result['config_path'] = CONFIG_RELATIVE_PATH
    result['emby_enabled'] = bool(result.get('emby_enabled', False))
    _normalize_default_display(result)
    emby_instances = (config or {}).get('emby_instances') or []
    result['emby_instance_count'] = len(emby_instances)
    result['emby_feature_locked'] = (
        result['emby_enabled'] and result['emby_instance_count'] > 0
    )
    return result


def get_web_username() -> str:
    return secrets_store.get_web_username()


def _migrate_emby_instance_fields(inst: dict) -> dict:
    item = dict(inst)
    item['host'] = str(item.get('host', '')).strip()
    item['port'] = max(1, min(65535, _safe_int(item.get('port'), 8096)))
    item['use_https'] = bool(item.get('use_https', False))
    item['verify_ssl'] = bool(item.get('verify_ssl', False))
    item['api_key'] = str(item.get('api_key', '') or '').strip()
    try:
        priority = int(item.get('display_priority', 1))
    except (TypeError, ValueError):
        priority = 1
    item['display_priority'] = max(1, min(DISPLAY_PRIORITY_MAX, priority))
    item['connection_timeout'] = INSTANCE_HTTP_TIMEOUT
    item['wan_traffic_only'] = bool(item.get('wan_traffic_only', True))
    mode = migrate_estimate_upload_flag(item)
    item['traffic_collect_mode'] = normalize_traffic_collect_mode(mode)
    item.pop('estimate_upload_enabled', None)
    item['lucky_base_url'] = normalize_lucky_base_url(item.get('lucky_base_url', ''))
    item['lucky_verify_ssl'] = bool(item.get('lucky_verify_ssl', False))
    item['lucky_rule_key'] = str(item.get('lucky_rule_key', '') or '').strip()
    item['lucky_sub_key'] = str(item.get('lucky_sub_key', '') or '').strip()
    item['lucky_rule_label'] = str(item.get('lucky_rule_label', '') or '').strip()
    item['lucky_frontend_host'] = str(item.get('lucky_frontend_host', '') or '').strip()
    item['lucky_credit_browse_traffic'] = bool(item.get('lucky_credit_browse_traffic', False))
    return item


def get_emby_instances(config: dict = None) -> list:
    cfg = config or load_config()
    return copy.deepcopy(cfg.get('emby_instances', []))


def get_emby_instance(name: str, config: dict = None) -> dict:
    for inst in get_emby_instances(config):
        if inst['name'] == name:
            return inst
    return None


def _validate_emby_instance(inst: dict, existing_names: list = None,
                              original_name: str = None,
                              require_name: bool = True,
                              require_api_key: bool = True,
                              require_lucky: bool = False,
                              require_host: bool = True) -> dict:
    result = {**DEFAULT_EMBY_INSTANCE, **inst}
    result['name'] = str(result.get('name', '')).strip()
    host, port = _parse_host_port(
        str(result.get('host', '')).strip(),
        _safe_int(result.get('port'), 8096),
    )
    result['host'] = host
    result['port'] = max(1, min(65535, port))

    if require_name and not result['name']:
        raise ValueError('请填写名称')
    if result['name'] and len(result['name']) > INSTANCE_NAME_MAX_LENGTH:
        raise ValueError(f'名称不能超过 {INSTANCE_NAME_MAX_LENGTH} 个字符')
    if require_host and not result['host']:
        raise ValueError('请填写 Emby 地址')
    if existing_names:
        for n in existing_names:
            if n == result['name'] and n != original_name:
                raise ValueError('名称已存在')

    result['use_https'] = bool(result.get('use_https', False))
    result['verify_ssl'] = bool(result.get('verify_ssl', False))
    api_key = str(result.get('api_key', '') or '').strip()
    if is_password_mask(api_key):
        api_key = ''
    if not api_key:
        api_key = secrets_store.get_emby_api_key(result['name'])
        if not api_key and original_name:
            api_key = secrets_store.get_emby_api_key(original_name)
    if not api_key and require_api_key and require_name:
        raise ValueError('请填写 Emby API Key')
    result.pop('api_key', None)
    mode = normalize_traffic_collect_mode(migrate_estimate_upload_flag(result))
    result['traffic_collect_mode'] = mode
    result.pop('estimate_upload_enabled', None)
    result.pop('container_name', None)
    result.pop('container_id', None)
    result['lucky_base_url'] = normalize_lucky_base_url(result.get('lucky_base_url', ''))
    result['lucky_verify_ssl'] = bool(result.get('lucky_verify_ssl', False))
    rule_key = str(result.get('lucky_rule_key', '') or '').strip()
    if is_password_mask(rule_key):
        rule_key = ''
    if not rule_key:
        rule_key = secrets_store.get_lucky_rule_key(result['name'])
        if not rule_key and original_name:
            rule_key = secrets_store.get_lucky_rule_key(original_name)
    sub_key = str(result.get('lucky_sub_key', '') or '').strip()
    if is_password_mask(sub_key):
        sub_key = ''
    if not sub_key:
        sub_key = secrets_store.get_lucky_sub_key(result['name'])
        if not sub_key and original_name:
            sub_key = secrets_store.get_lucky_sub_key(original_name)
    result['lucky_rule_label'] = str(result.get('lucky_rule_label', '') or '').strip()
    result['lucky_frontend_host'] = str(
        result.get('lucky_frontend_host', '') or '',
    ).strip()
    result['lucky_credit_browse_traffic'] = bool(
        result.get('lucky_credit_browse_traffic', False),
    )
    stored_rules = _stored_lucky_rules(original_name or result['name'])
    if not stored_rules and (rule_key and sub_key):
        stored_rules = [{
            'rule_key': rule_key,
            'sub_key': sub_key,
            'label': result['lucky_rule_label'],
        }]
    if mode == 'lucky' and require_lucky:
        if not result['lucky_base_url']:
            raise ValueError('请填写 Lucky 管理地址')
        if not stored_rules:
            raise ValueError('请选择 Lucky 反代规则')
        token_name = original_name or result['name']
        req_token = str(inst.get('lucky_open_token', '') or '').strip()
        if is_password_mask(req_token):
            req_token = ''
        if not req_token and not secrets_store.get_lucky_open_token(token_name):
            raise ValueError('请填写 Lucky OpenToken')
    try:
        priority = int(result.get('display_priority', 1))
    except (TypeError, ValueError):
        priority = 1
    result['display_priority'] = max(1, min(DISPLAY_PRIORITY_MAX, priority))
    result['connection_timeout'] = INSTANCE_HTTP_TIMEOUT
    result['wan_traffic_only'] = bool(result.get('wan_traffic_only', True))
    for key in ('reachable', 'attempt_sync', 'apply_rules_now',
                'lucky_open_token', 'lucky_rule_key', 'lucky_sub_key',
                'lucky_rules', 'clear_traffic_data'):
        result.pop(key, None)
    return result


def validate_emby_instance_for_test(inst: dict, test_type: str = 'connectivity') -> dict:
    require_api = test_type == 'api'
    require_host = test_type not in ('lucky', 'lucky_rules', 'lucky_connect')
    result = _validate_emby_instance(
        inst,
        require_name=False,
        require_api_key=require_api,
        # 测试时由下方按 test_type 单独校验；连通性/拉取规则阶段还没有已选规则
        require_lucky=False,
        require_host=require_host,
    )
    api_key = inst.get('api_key') or ''
    if is_password_mask(api_key):
        api_key = ''
    if not api_key:
        name = result.get('name', '')
        if name:
            api_key = secrets_store.get_emby_api_key(name)
    if api_key:
        result['api_key'] = api_key
    else:
        result['api_key'] = ''
    lucky_token = str(inst.get('lucky_open_token', '') or '').strip()
    if is_password_mask(lucky_token):
        lucky_token = ''
    if not lucky_token:
        name = result.get('name', '')
        if name:
            lucky_token = secrets_store.get_lucky_open_token(name)
    result['lucky_open_token'] = lucky_token
    name = result.get('name', '')
    stored_rules = _stored_lucky_rules(name)
    requested = request_lucky_rules(inst, stored_rules)
    rules = stored_rules if requested is None else requested
    result['lucky_rules'] = rules
    result['lucky_rule_key'] = rules[0]['rule_key'] if rules else ''
    result['lucky_sub_key'] = rules[0]['sub_key'] if rules else ''
    if rules:
        label = lucky_rules_label(rules)
        if label:
            result['lucky_rule_label'] = label
    if test_type in ('lucky', 'lucky_rules'):
        if not result.get('lucky_base_url'):
            raise ValueError('请填写 Lucky 管理地址')
        if not lucky_token:
            raise ValueError('请填写 Lucky OpenToken')
        if test_type == 'lucky' and not rules:
            raise ValueError('请选择 Lucky 反代规则')
    if test_type == 'lucky_connect':
        if not result.get('lucky_base_url'):
            raise ValueError('请填写 Lucky 管理地址')
        if not lucky_token:
            raise ValueError('请填写 Lucky OpenToken')
    return result


def mask_emby_instance_for_api(inst: dict) -> dict:
    result = copy.deepcopy(_migrate_emby_instance_fields(inst))
    result.pop('api_key', None)
    if secrets_store.has_emby_api_key(result.get('name', '')):
        result['api_key'] = '******'
        result['has_api_key'] = True
    else:
        result['has_api_key'] = False
    if secrets_store.has_lucky_open_token(result.get('name', '')):
        result['lucky_open_token'] = '******'
        result['has_lucky_open_token'] = True
    else:
        result['has_lucky_open_token'] = False
    stored_rules = _stored_lucky_rules(result.get('name', ''))
    result['has_lucky_rule_keys'] = bool(stored_rules)
    public_rules = []
    yaml_label = str(result.get('lucky_rule_label') or '').strip()
    if len(stored_rules) == 1 and not stored_rules[0].get('label') and yaml_label:
        public_rules = [{'label': yaml_label}]
    else:
        for row in stored_rules:
            label = str(row.get('label') or '').strip() or yaml_label
            if label:
                public_rules.append({'label': label})
    if not public_rules and yaml_label:
        public_rules = [{'label': part.strip()} for part in yaml_label.split('；') if part.strip()]
    result['lucky_rules'] = public_rules
    result.pop('lucky_rule_key', None)
    result.pop('lucky_sub_key', None)
    return result


def add_emby_instance(inst: dict) -> dict:
    config = load_config()
    instances = config.get('emby_instances', [])
    names = [i['name'] for i in instances]
    inst = resolve_emby_credentials(inst)
    validated = _validate_emby_instance(inst, existing_names=names, require_lucky=True)
    config.setdefault('emby_instances', []).append(validated)
    save_config(config)
    return validated


def update_emby_instance(name: str, inst: dict) -> dict:
    config = load_config()
    instances = config.get('emby_instances', [])
    names = [i['name'] for i in instances]
    idx = next((i for i, x in enumerate(instances) if x['name'] == name), None)
    if idx is None:
        raise ValueError('设备不存在')
    existing = instances[idx]
    inst = resolve_emby_credentials(inst, existing)
    validated = _validate_emby_instance(
        inst, existing_names=names, original_name=name, require_lucky=True)
    if name != validated['name']:
        secrets_store.rename_emby_api_key(name, validated['name'])
    instances[idx] = validated
    config['emby_instances'] = instances
    save_config(config)
    return validated


def delete_emby_instance(name: str) -> bool:
    config = load_config()
    instances = config.get('emby_instances', [])
    new_instances = [i for i in instances if i['name'] != name]
    if len(new_instances) == len(instances):
        raise ValueError('设备不存在')
    config['emby_instances'] = new_instances
    secrets_store.delete_emby_api_key(name)
    secrets_store.delete_lucky_open_token(name)
    save_config(config)
    return True
