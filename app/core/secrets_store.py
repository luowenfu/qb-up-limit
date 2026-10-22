"""凭据存储：Web 密码哈希、qB 连接密码与 Emby API Key 加密，独立于 config.yaml"""

import json
import os
import logging
import threading
import uuid

from itsdangerous import URLSafeSerializer
from werkzeug.security import check_password_hash, generate_password_hash

logger = logging.getLogger(__name__)

_lock = threading.RLock()
# 默认密码校验走 pbkdf2，按用户名缓存；密码哈希变了才重算。
_default_pw_cache = {}
_default_pw_cache_lock = threading.Lock()
_password_state_gen = 0

from core.paths import (  # noqa: E402
    DATA_KEY_PATH, WEB_AUTH_PATH, QB_SECRETS_PATH, EMBY_SECRETS_PATH, LUCKY_SECRETS_PATH,
)

DEFAULT_WEB_USER = 'admin'
DEFAULT_WEB_PASS = 'adminadmin'


def _ensure_parent(path: str) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def _read_json(path: str, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"读取 {path} 失败: {e}")
        return default


def _write_json(path: str, data) -> None:
    _ensure_parent(path)
    # 临时文件名带唯一后缀，避免并发写同一路径时互相覆盖/删除对方的 tmp
    tmp_path = f'{path}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp'
    try:
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def ensure_data_key() -> str:
    with _lock:
        if os.path.exists(DATA_KEY_PATH):
            with open(DATA_KEY_PATH, 'r', encoding='utf-8') as f:
                key = f.read().strip()
                if key:
                    return key
        key = os.urandom(32).hex()
        _ensure_parent(DATA_KEY_PATH)
        with open(DATA_KEY_PATH, 'w', encoding='utf-8') as f:
            f.write(key)
        logger.info(f"已生成数据加密密钥: {DATA_KEY_PATH}")
        return key


def _serializer() -> URLSafeSerializer:
    return URLSafeSerializer(ensure_data_key(), salt='qb-up-limit-secrets')


def encrypt_value(plain: str) -> str:
    return _serializer().dumps(plain)


def decrypt_value(token: str) -> str:
    if not token:
        return ''
    try:
        return _serializer().loads(token)
    except Exception:
        logger.warning("解密凭据失败，可能密钥已变更")
        return ''


def ensure_web_auth() -> dict:
    """读取已有 Web 凭据。没有文件时不创建默认账号。"""
    with _lock:
        auth = _read_json(WEB_AUTH_PATH, {})
        return auth if isinstance(auth, dict) else {}


def get_web_username() -> str:
    return str(ensure_web_auth().get('username') or '').strip()


def verify_web_password(password: str) -> bool:
    auth = ensure_web_auth()
    password_hash = auth.get('password_hash', '')
    if not password_hash:
        return False
    return check_password_hash(password_hash, password)


def get_pw_ver() -> int:
    """密码版本。修改密码后递增，用于让其他会话重新登录。"""
    auth = ensure_web_auth()
    try:
        return int(auth.get('pw_ver') or 0)
    except (TypeError, ValueError):
        return 0


def password_state_generation() -> int:
    """进程内密码状态代次。改密后递增，供登录会话缓存失效。"""
    return _password_state_gen


def is_default_password(username: str = None) -> bool:
    """当前密码是否仍是旧版默认密码。结果按用户名缓存，供升级迁移判断。"""
    auth = ensure_web_auth()
    stored_user = str(auth.get('username') or '').strip()
    if not stored_user:
        return False
    asked = str(username or stored_user).strip() or stored_user
    if asked != stored_user:
        return False
    password_hash = auth.get('password_hash') or ''
    if not password_hash:
        return False
    with _default_pw_cache_lock:
        cached = _default_pw_cache.get(stored_user)
        if cached and cached[0] == password_hash:
            return cached[1]
    result = check_password_hash(password_hash, DEFAULT_WEB_PASS)
    with _default_pw_cache_lock:
        _default_pw_cache[stored_user] = (password_hash, result)
    return result


def needs_setup() -> bool:
    """没有可用凭据，或仍是旧版默认密码时，需要先完成首次设置。"""
    auth = ensure_web_auth()
    if not str(auth.get('username') or '').strip() or not auth.get('password_hash'):
        return True
    return is_default_password()


def has_web_password() -> bool:
    auth = _read_json(WEB_AUTH_PATH, {})
    return bool(auth.get('password_hash'))


def set_web_credentials(username: str, password: str = None) -> None:
    global _password_state_gen
    with _lock:
        auth = ensure_web_auth()
        cleaned = str(username or '').strip()
        if not cleaned:
            raise ValueError('请填写账号')
        auth['username'] = cleaned
        if password:
            if len(password) < 6:
                raise ValueError('密码至少 6 位')
            if password == DEFAULT_WEB_PASS:
                raise ValueError('不能使用默认密码')
            auth['password_hash'] = generate_password_hash(password)
            try:
                current_ver = int(auth.get('pw_ver') or 0)
            except (TypeError, ValueError):
                current_ver = 0
            auth['pw_ver'] = current_ver + 1
            _password_state_gen += 1
            with _default_pw_cache_lock:
                _default_pw_cache.clear()
        _write_json(WEB_AUTH_PATH, auth)


def _load_qb_secrets() -> dict:
    return _read_json(QB_SECRETS_PATH, {})


def _save_qb_secrets(secrets: dict) -> None:
    _write_json(QB_SECRETS_PATH, secrets)


def get_qb_password(instance_name: str) -> str:
    if not instance_name:
        return ''
    token = _load_qb_secrets().get(instance_name)
    if not token:
        return ''
    return decrypt_value(token)


def set_qb_password(instance_name: str, password: str) -> None:
    if not instance_name:
        return
    with _lock:
        secrets = _load_qb_secrets()
        if password:
            secrets[instance_name] = encrypt_value(password)
        else:
            secrets.pop(instance_name, None)
        _save_qb_secrets(secrets)


def delete_qb_password(instance_name: str) -> None:
    set_qb_password(instance_name, '')


def has_qb_password(instance_name: str) -> bool:
    return bool(get_qb_password(instance_name))


def rename_qb_password(old_name: str, new_name: str) -> None:
    if not old_name or not new_name or old_name == new_name:
        return
    with _lock:
        secrets = _load_qb_secrets()
        if old_name not in secrets:
            return
        secrets[new_name] = secrets.pop(old_name)
        _save_qb_secrets(secrets)


def _load_emby_secrets() -> dict:
    return _read_json(EMBY_SECRETS_PATH, {})


def _save_emby_secrets(secrets: dict) -> None:
    _write_json(EMBY_SECRETS_PATH, secrets)


def get_emby_api_key(instance_name: str) -> str:
    if not instance_name:
        return ''
    token = _load_emby_secrets().get(instance_name)
    if not token:
        return ''
    return decrypt_value(token)


def set_emby_api_key(instance_name: str, api_key: str) -> None:
    if not instance_name:
        return
    with _lock:
        secrets = _load_emby_secrets()
        if api_key:
            secrets[instance_name] = encrypt_value(api_key)
        else:
            secrets.pop(instance_name, None)
        _save_emby_secrets(secrets)


def delete_emby_api_key(instance_name: str) -> None:
    set_emby_api_key(instance_name, '')


def has_emby_api_key(instance_name: str) -> bool:
    return bool(get_emby_api_key(instance_name))


def rename_emby_api_key(old_name: str, new_name: str) -> None:
    if not old_name or not new_name or old_name == new_name:
        return
    with _lock:
        secrets = _load_emby_secrets()
        if old_name in secrets:
            secrets[new_name] = secrets.pop(old_name)
            _save_emby_secrets(secrets)
    rename_lucky_open_token(old_name, new_name)


def _load_lucky_secrets() -> dict:
    return _read_json(LUCKY_SECRETS_PATH, {})


def _save_lucky_secrets(secrets: dict) -> None:
    _write_json(LUCKY_SECRETS_PATH, secrets)


def get_lucky_open_token(instance_name: str) -> str:
    if not instance_name:
        return ''
    token = _load_lucky_secrets().get(instance_name)
    if not token:
        return ''
    return decrypt_value(token)


def set_lucky_open_token(instance_name: str, open_token: str) -> None:
    if not instance_name:
        return
    with _lock:
        secrets = _load_lucky_secrets()
        if open_token:
            secrets[instance_name] = encrypt_value(open_token)
        else:
            secrets.pop(instance_name, None)
        _save_lucky_secrets(secrets)


def delete_lucky_open_token(instance_name: str) -> None:
    set_lucky_open_token(instance_name, '')
    delete_lucky_rule_keys(instance_name)


def has_lucky_open_token(instance_name: str) -> bool:
    return bool(get_lucky_open_token(instance_name))


def rename_lucky_open_token(old_name: str, new_name: str) -> None:
    if not old_name or not new_name or old_name == new_name:
        return
    with _lock:
        secrets = _load_lucky_secrets()
        changed = False
        if old_name in secrets:
            secrets[new_name] = secrets.pop(old_name)
            changed = True
        for field in ('rule_key', 'sub_key', 'rules'):
            old_key = _lucky_field_key(old_name, field)
            new_key = _lucky_field_key(new_name, field)
            if old_key in secrets:
                secrets[new_key] = secrets.pop(old_key)
                changed = True
        if changed:
            _save_lucky_secrets(secrets)


def _lucky_field_key(instance_name: str, field: str) -> str:
    return f'{instance_name}::{field}'


def get_lucky_rule_key(instance_name: str) -> str:
    if not instance_name:
        return ''
    token = _load_lucky_secrets().get(_lucky_field_key(instance_name, 'rule_key'))
    if not token:
        return ''
    return decrypt_value(token)


def get_lucky_sub_key(instance_name: str) -> str:
    if not instance_name:
        return ''
    token = _load_lucky_secrets().get(_lucky_field_key(instance_name, 'sub_key'))
    if not token:
        return ''
    return decrypt_value(token)


def set_lucky_rule_key(instance_name: str, rule_key: str) -> None:
    if not instance_name:
        return
    with _lock:
        secrets = _load_lucky_secrets()
        field_key = _lucky_field_key(instance_name, 'rule_key')
        if rule_key:
            secrets[field_key] = encrypt_value(rule_key)
        else:
            secrets.pop(field_key, None)
        _save_lucky_secrets(secrets)


def set_lucky_sub_key(instance_name: str, sub_key: str) -> None:
    if not instance_name:
        return
    with _lock:
        secrets = _load_lucky_secrets()
        field_key = _lucky_field_key(instance_name, 'sub_key')
        if sub_key:
            secrets[field_key] = encrypt_value(sub_key)
        else:
            secrets.pop(field_key, None)
        _save_lucky_secrets(secrets)


def delete_lucky_rule_keys(instance_name: str) -> None:
    if not instance_name:
        return
    with _lock:
        secrets = _load_lucky_secrets()
        changed = False
        for field in ('rule_key', 'sub_key', 'rules'):
            field_key = _lucky_field_key(instance_name, field)
            if field_key in secrets:
                secrets.pop(field_key, None)
                changed = True
        if changed:
            _save_lucky_secrets(secrets)


def _parse_lucky_rules(raw) -> list:
    if not isinstance(raw, list):
        return []
    rules = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        rule_key = str(item.get('rule_key') or '').strip()
        sub_key = str(item.get('sub_key') or '').strip()
        if not rule_key or not sub_key:
            continue
        pair = (rule_key, sub_key)
        if pair in seen:
            continue
        seen.add(pair)
        rules.append({
            'rule_key': rule_key,
            'sub_key': sub_key,
            'label': str(item.get('label') or '').strip(),
        })
    return rules


def get_lucky_rules(instance_name: str) -> list:
    """已保存的反代规则。没有多选记录时，回退到原来的单条规则。"""
    if not instance_name:
        return []
    secrets = _load_lucky_secrets()
    blob = secrets.get(_lucky_field_key(instance_name, 'rules'))
    if blob:
        try:
            parsed = _parse_lucky_rules(json.loads(decrypt_value(blob)))
        except Exception:
            parsed = []
        if parsed:
            return parsed
    rule_key = ''
    sub_key = ''
    rule_token = secrets.get(_lucky_field_key(instance_name, 'rule_key'))
    sub_token = secrets.get(_lucky_field_key(instance_name, 'sub_key'))
    if rule_token:
        rule_key = decrypt_value(rule_token)
    if sub_token:
        sub_key = decrypt_value(sub_token)
    if rule_key and sub_key:
        return [{'rule_key': rule_key, 'sub_key': sub_key, 'label': ''}]
    return []


def set_lucky_rules(instance_name: str, rules: list) -> None:
    """保存多条反代规则，并同步第一条到旧的单条字段。"""
    if not instance_name:
        return
    parsed = _parse_lucky_rules(rules)
    with _lock:
        secrets = _load_lucky_secrets()
        rules_key = _lucky_field_key(instance_name, 'rules')
        rule_key = _lucky_field_key(instance_name, 'rule_key')
        sub_key = _lucky_field_key(instance_name, 'sub_key')
        if parsed:
            secrets[rules_key] = encrypt_value(
                json.dumps(parsed, ensure_ascii=False),
            )
            secrets[rule_key] = encrypt_value(parsed[0]['rule_key'])
            secrets[sub_key] = encrypt_value(parsed[0]['sub_key'])
        else:
            secrets.pop(rules_key, None)
            secrets.pop(rule_key, None)
            secrets.pop(sub_key, None)
        _save_lucky_secrets(secrets)


def has_lucky_rule_keys(instance_name: str) -> bool:
    return bool(get_lucky_rules(instance_name))
