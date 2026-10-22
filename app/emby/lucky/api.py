"""Lucky Web 服务 API：规则发现与 accessdetail 流量读取。"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

import requests

from emby.traffic.filter import is_lan_ip, parse_endpoint_ip
import qb.traffic_db as traffic_db

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 8
_PAGE_SIZE = 100
_MIN_STREAM_CONN_BYTES = 64 * 1024


def normalize_traffic_collect_mode(value) -> str:
    mode = str(value or '').strip().lower()
    if mode == 'lucky':
        return 'lucky'
    return ''


def migrate_estimate_upload_flag(inst: dict) -> str:
    """旧版 estimate_upload_enabled / docker 模式 → 清空（仅保留 lucky）。"""
    if not isinstance(inst, dict):
        return ''
    mode = normalize_traffic_collect_mode(inst.get('traffic_collect_mode'))
    if mode:
        return mode
    if bool(inst.get('estimate_upload_enabled', False)):
        return ''
    return ''


def normalize_lucky_base_url(value: str) -> str:
    raw = str(value or '').strip()
    if not raw:
        return ''
    if not raw.startswith(('http://', 'https://')):
        raw = f'http://{raw}'  # Lucky 管理端默认 http
    return raw.rstrip('/')


def _backend_host_port(location: str) -> Tuple[str, int]:
    loc = str(location or '').strip()
    if not loc:
        return '', 0
    parsed = urlparse(loc if '://' in loc else f'http://{loc}')
    host = (parsed.hostname or '').strip().lower()
    try:
        port = int(parsed.port or 0)
    except (TypeError, ValueError):
        port = 0
    if not port:
        port = 443 if parsed.scheme == 'https' else 80
    return host, port


def _match_backend(location: str, emby_host: str, emby_port: int) -> bool:
    host, port = _backend_host_port(location)
    if not host or not port:
        return False
    target_host = str(emby_host or '').strip().lower()
    try:
        target_port = int(emby_port or 0)
    except (TypeError, ValueError):
        target_port = 0
    if not target_host or not target_port:
        return False
    if host != target_host:
        return False
    return port == target_port


def _truthy(value) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ('1', 'true', 'yes', 'on')
    return bool(value)


def _front_label(domain: str, listen_port: int, scheme: str, fallback: str) -> str:
    """监听地址带上 http/https。域名里若已写协议，沿用该协议。"""
    host = str(domain or '').strip()
    use = scheme if scheme in ('http', 'https') else 'http'
    if '://' in host:
        parsed = urlparse(host)
        if parsed.scheme in ('http', 'https'):
            use = parsed.scheme
        host = parsed.hostname or ''
    if host and listen_port:
        return f'{use}://{host}:{listen_port}'
    if host:
        return f'{use}://{host}'
    name = str(fallback or '').strip()
    return f'{use}://{name}' if name else ''


def parse_proxy_candidates(rule_list: list) -> List[dict]:
    candidates: List[dict] = []
    for rule in rule_list or []:
        if not isinstance(rule, dict) or not rule.get('Enable'):
            continue
        rule_key = str(rule.get('RuleKey') or '').strip()
        if not rule_key:
            continue
        listen_port = int(rule.get('ListenPort') or 0)
        rule_name = str(rule.get('RuleName') or '').strip()
        for proxy in rule.get('ProxyList') or []:
            if not isinstance(proxy, dict) or not proxy.get('Enable'):
                continue
            if str(proxy.get('WebServiceType') or '').strip().lower() != 'reverseproxy':
                continue
            sub_key = str(proxy.get('Key') or '').strip()
            if not sub_key:
                continue
            locations = [
                str(x).strip() for x in (proxy.get('Locations') or []) if str(x).strip()
            ]
            domains = [
                str(x).strip() for x in (proxy.get('Domains') or []) if str(x).strip()
            ]
            backend = locations[0] if locations else ''
            domain = domains[0] if domains else ''
            scheme = 'https' if _truthy(rule.get('EnableTLS')) else 'http'
            front = _front_label(domain, listen_port, scheme, rule_name or rule_key)
            if backend and '://' not in backend:
                backend = f'http://{backend}'
            label = f'{front} → {backend}' if backend else front
            candidates.append({
                'rule_key': rule_key,
                'sub_key': sub_key,
                'label': label,
                'rule_name': rule_name,
                'listen_port': listen_port,
                'frontend': domain,
                'backend': backend,
            })
    return candidates


def auto_match_candidate(
    candidates: List[dict],
    *,
    emby_host: str = '',
    emby_port: int = 8096,
    frontend_host: str = '',
) -> Tuple[Optional[dict], List[dict]]:
    if not candidates:
        return None, []
    matches: List[dict] = []
    front = str(frontend_host or '').strip().lower()
    for item in candidates:
        backend = str(item.get('backend') or '')
        if emby_host and emby_port and _match_backend(backend, emby_host, emby_port):
            matches.append(item)
            continue
        if front:
            item_front = str(item.get('frontend') or '').strip().lower()
            if item_front and item_front == front:
                matches.append(item)
    if len(matches) == 1:
        return matches[0], candidates
    if len(matches) > 1:
        return None, candidates
    if len(candidates) == 1:
        return candidates[0], candidates
    return None, candidates


def choose_selected_candidates(
    candidates: List[dict],
    saved: List[dict],
    *,
    emby_host: str = '',
    emby_port: int = 8096,
) -> List[dict]:
    """勾选已保存的规则，以及后端就是这台 Emby 的规则。"""
    saved_pairs = {
        (str(item.get('rule_key') or ''), str(item.get('sub_key') or ''))
        for item in (saved or [])
        if item.get('rule_key') and item.get('sub_key')
    }
    selected: List[dict] = []
    for item in candidates or []:
        pair = (item.get('rule_key'), item.get('sub_key'))
        backend_hit = bool(
            emby_host and emby_port and _match_backend(
                str(item.get('backend') or ''), emby_host, emby_port,
            )
        )
        if pair in saved_pairs or backend_hit:
            selected.append(item)
    if not selected and len(candidates or []) == 1:
        return list(candidates)
    return selected


def mask_token(token: str) -> str:
    """令牌打码：保留前 4 后 4 位，中间为 ***；长度 <= 8 时整体替换为 ***"""
    token = str(token or '')
    if len(token) <= 8:
        return '***'
    return f'{token[:4]}***{token[-4:]}'


def mask_token_in_text(text, token: str) -> str:
    """把文本中出现的令牌替换为打码形式（用于日志与返回给前端的错误）"""
    text = str(text if text is not None else '')
    token = str(token or '')
    if not token:
        return text
    return text.replace(token, mask_token(token))


def build_rule_label(candidate: dict) -> str:
    if not candidate:
        return ''
    return str(candidate.get('label') or '').strip()


class LuckyClient:
    def __init__(
        self,
        base_url: str,
        open_token: str = '',
        verify_ssl: bool = False,
        timeout: float = _DEFAULT_TIMEOUT,
    ):
        self.base_url = normalize_lucky_base_url(base_url)
        self.open_token = str(open_token or '').strip()
        self.verify_ssl = bool(verify_ssl)
        self.timeout = float(timeout or _DEFAULT_TIMEOUT)

    def _headers(self) -> dict:
        headers = {'Accept': 'application/json'}
        if self.open_token:
            headers['openToken'] = self.open_token
        return headers

    def _request(self, path: str, params: dict = None) -> Tuple[Optional[dict], str]:
        if not self.base_url:
            return None, '请填写 Lucky 管理地址'
        if not self.open_token:
            return None, '请填写 OpenToken'
        url = urljoin(f'{self.base_url}/', path.lstrip('/'))
        query = dict(params or {})
        mask = lambda v: mask_token_in_text(v, self.open_token)  # noqa: E731
        try:
            resp = requests.get(
                url,
                headers=self._headers(),
                params=query,
                timeout=self.timeout,
                verify=self.verify_ssl,
            )
        except requests.exceptions.SSLError as exc:
            logger.warning('Lucky SSL 错误 %s: %s', mask(url), mask(exc))
            return None, mask(f'Lucky SSL 握手失败（若管理端是 http 请关闭 HTTPS；自签证书请取消「验证 SSL 证书」）：{exc}')
        except requests.RequestException as exc:
            logger.warning('Lucky 请求失败 %s: %s', mask(url), mask(exc))
            return None, mask(f'无法连接 Lucky 管理接口 {self.base_url}（{exc.__class__.__name__}: {exc}）')
        if resp.status_code >= 400:
            body = mask((resp.text or '').strip())[:120]
            detail = f'：{body}' if body else ''
            return None, f'Lucky HTTP {resp.status_code}{detail}'
        try:
            data = resp.json()
        except ValueError:
            return None, f'Lucky 返回非 JSON（HTTP {resp.status_code}，地址或端口是否为 Lucky 管理端？）'
        if not isinstance(data, dict):
            return None, 'Lucky 返回格式异常'
        if int(data.get('ret', 0) or 0) != 0:
            msg = mask(str(data.get('msg') or data.get('message') or '').strip())
            return None, f'Lucky 接口返回失败（ret={data.get("ret")}{"：" + msg if msg else ""}）'
        return data, ''

    def test_connection(self) -> dict:
        data, err = self._request('/api/webservice/rules')
        if err:
            return {'ok': False, 'error': err}
        rule_list = data.get('ruleList') or []
        return {
            'ok': True,
            'rule_count': len(rule_list),
            'message': f'连接成功，共 {len(rule_list)} 条 Web 服务规则',
        }

    def fetch_rules(self) -> Tuple[Optional[dict], str]:
        return self._request('/api/webservice/rules')

    def list_proxy_candidates(self) -> Tuple[List[dict], str]:
        data, err = self.fetch_rules()
        if err:
            return [], err
        return parse_proxy_candidates(data.get('ruleList') or []), ''

    def fetch_access_detail(
        self,
        rule_key: str,
        sub_key: str,
        *,
        page_size: int = _PAGE_SIZE,
    ) -> Tuple[Optional[dict], str]:
        rule_key = str(rule_key or '').strip()
        sub_key = str(sub_key or '').strip()
        if not rule_key or not sub_key:
            return None, '未配置 Lucky 反代规则'
        merged = {
            'ret': 0,
            'resList': [],
            'ipTotal': 0,
            'connectiontotal': 0,
            'page': 1,
            'pageSize': page_size,
        }
        page = 1
        total_pages = 1
        while page <= total_pages:
            path = f'/api/webservice/{rule_key}/{sub_key}/accessdetail'
            data, err = self._request(path, {'pageSize': page_size, 'page': page})
            if err:
                return None, err
            res_list = data.get('resList') or []
            if not isinstance(res_list, list):
                return None, 'accessdetail 格式异常'
            merged['resList'].extend(res_list)
            merged['ipTotal'] = max(int(merged['ipTotal'] or 0), int(data.get('ipTotal') or 0))
            merged['connectiontotal'] = max(
                int(merged['connectiontotal'] or 0),
                int(data.get('connectiontotal') or 0),
            )
            ip_total = max(0, int(data.get('ipTotal') or 0))
            if ip_total <= 0:
                break
            total_pages = max(1, (ip_total + page_size - 1) // page_size)
            page += 1
            if page > 50:
                break
        return merged, ''

    def test_access_detail(self, rule_key: str, sub_key: str) -> dict:
        data, err = self.fetch_access_detail(rule_key, sub_key, page_size=10)
        if err:
            return {'ok': False, 'error': err}
        res_list = data.get('resList') or []
        sample_ip = ''
        if res_list:
            sample_ip = str(res_list[0].get('IP') or '')
        return {
            'ok': True,
            'ip_total': int(data.get('ipTotal') or len(res_list)),
            'connection_total': int(data.get('connectiontotal') or 0),
            'sample_ip': sample_ip,
            'message': 'accessdetail 读取成功',
        }


def _lucky_traffic_delta(current: int, last: int, *, first_seen: bool) -> int:
    """Lucky 返回 IP 级累计值：与已持久化基线求差即为本周期增量。

    首见（无持久化基线）时只登记基线、本周期增量取零，避免把连接建立前
    早已存在的历史累计值一次性计入当前 tick，造成 GB 级流量尖峰漂移。
    """
    current = max(0, int(current or 0))
    last = max(0, int(last or 0))
    if first_seen:
        return 0
    if last > 0 and current < last:
        # 计数器回退：Lucky 的 IP/连接累计 TrafficOut 会因连接进出聚合统计、
        # 抖动等出现小幅下降。累计量下降并不代表有新上行；此前误判为“计数器
        # 重置”并把整段累计(current)当作本 tick 增量重复计入，会造成 GB 级虚增
        # （单 tick 把数百 MB 累计重复计给正在播放的会话）。故本 tick 记 0，
        # 并以 current 作为新基线，后续真实增量照常累计。真实重置（归零后重新
        # 计数）会走下方 last<=0 分支正确处理。
        return 0
    if last <= 0:
        return current
    return max(0, current - last)


def calc_ip_traffic_deltas(
    res_list: list,
    baselines: Dict[str, Dict[str, int]],
    *,
    wan_only: bool = True,
    key_prefix: str = '',
) -> Tuple[Dict[str, int], Dict[str, int], Dict[str, Dict[str, int]]]:
    """按 IP 读取 Lucky 累计 TrafficOut/In，与持久化基线求差得增量。

    key_prefix 只用于基线键。多条反代分开记账，增量仍按真实 IP 相加。
    """
    out_deltas: Dict[str, int] = {}
    in_deltas: Dict[str, int] = {}
    new_baselines = dict(baselines or {})
    prefix = str(key_prefix or '')
    for item in res_list or []:
        if not isinstance(item, dict):
            continue
        ip = str(item.get('IP') or '').strip()
        if not ip:
            continue
        if wan_only and is_lan_ip(ip):
            continue
        base_key = f'{prefix}{ip}' if prefix else ip
        current_out = max(0, int(item.get('TrafficOut') or 0))
        current_in = max(0, int(item.get('TrafficIn') or 0))
        prev = new_baselines.get(base_key)
        first_seen = prev is None
        last_out = max(0, int((prev or {}).get('out') or 0))
        last_in = max(0, int((prev or {}).get('in') or 0))
        delta_out = _lucky_traffic_delta(current_out, last_out, first_seen=first_seen)
        delta_in = _lucky_traffic_delta(current_in, last_in, first_seen=first_seen)
        new_baselines[base_key] = {'out': current_out, 'in': current_in}
        if delta_out > 0:
            out_deltas[ip] = out_deltas.get(ip, 0) + delta_out
        if delta_in > 0:
            in_deltas[ip] = in_deltas.get(ip, 0) + delta_in
    return out_deltas, in_deltas, new_baselines


def sum_positive(values: Dict[str, int]) -> int:
    return sum(max(0, int(v or 0)) for v in (values or {}).values())


def extract_wan_ip_cumulative_traffic(res_list: list) -> Dict[str, Dict[str, int]]:
    """从 accessdetail 提取各外网 IP 当前累计 TrafficOut/In。"""
    result: Dict[str, Dict[str, int]] = {}
    for item in res_list or []:
        if not isinstance(item, dict):
            continue
        ip = str(item.get('IP') or '').strip()
        if not ip or is_lan_ip(ip):
            continue
        result[ip] = {
            'out': max(0, int(item.get('TrafficOut') or 0)),
            'in': max(0, int(item.get('TrafficIn') or 0)),
        }
    return result


def parse_remote_addr(remote_addr: str) -> Tuple[str, int]:
    """解析 ConnsStatistics.RemoteAddr → (ip, port)。"""
    raw = str(remote_addr or '').strip()
    if not raw:
        return '', 0
    if raw.startswith('['):
        end = raw.find(']')
        if end > 0:
            ip = raw[1:end]
            port_part = raw[end + 1:].lstrip(':')
            try:
                port = int(port_part) if port_part else 0
            except (TypeError, ValueError):
                port = 0
            return ip, port
    if raw.count('.') == 3 and ':' in raw:
        host, _, port_part = raw.rpartition(':')
        try:
            return host, int(port_part)
        except (TypeError, ValueError):
            return host, 0
    return raw, 0


def parse_accept_time_epoch(value: str) -> Optional[float]:
    """解析 AcceptTime 为 epoch 秒（Lucky 返回配置时区下的本地时间）。"""
    raw = str(value or '').strip()
    if not raw:
        return None
    local_tz = traffic_db.get_config_timezone()
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y/%m/%d %H:%M:%S'):
        try:
            dt = datetime.strptime(raw, fmt).replace(tzinfo=local_tz)
            return dt.timestamp()
        except ValueError:
            continue
    return None


def iter_wan_conn_statistics(
    res_list: list,
    *,
    wan_only: bool = True,
) -> List[dict]:
    """展开 resList.ConnsStatistics 为连接级条目。"""
    rows: List[dict] = []
    for item in res_list or []:
        if not isinstance(item, dict):
            continue
        ip = str(item.get('IP') or '').strip()
        if not ip or (wan_only and is_lan_ip(ip)):
            continue
        stats = item.get('ConnsStatistics') or []
        if not isinstance(stats, list):
            continue
        for conn in stats:
            if not isinstance(conn, dict):
                continue
            remote_addr = str(conn.get('RemoteAddr') or '').strip()
            if not remote_addr:
                continue
            conn_ip, port = parse_remote_addr(remote_addr)
            if not conn_ip:
                conn_ip = ip
            if wan_only and is_lan_ip(conn_ip):
                continue
            rows.append({
                'remote_addr': remote_addr,
                'ip': conn_ip,
                'port': port,
                'accept_time': str(conn.get('AcceptTime') or '').strip(),
                'accept_epoch': parse_accept_time_epoch(conn.get('AcceptTime') or ''),
                'traffic_out': max(0, int(conn.get('TrafficOut') or 0)),
                'traffic_in': max(0, int(conn.get('TrafficIn') or 0)),
            })
    return rows


def calc_conn_traffic_deltas(
    res_list: list,
    baselines: Dict[str, Dict[str, int]],
    *,
    wan_only: bool = True,
    key_prefix: str = '',
) -> Tuple[Dict[str, int], Dict[str, int], Dict[str, Dict[str, int]]]:
    """按 RemoteAddr 读取连接级累计并与基线求差。

    key_prefix 只用于基线键，返回的增量键仍是真实 RemoteAddr。
    """
    out_deltas: Dict[str, int] = {}
    in_deltas: Dict[str, int] = {}
    new_baselines = dict(baselines or {})
    prefix = str(key_prefix or '')
    for conn in iter_wan_conn_statistics(res_list, wan_only=wan_only):
        key = conn['remote_addr']
        base_key = f'{prefix}{key}' if prefix else key
        current_out = max(0, int(conn.get('traffic_out') or 0))
        current_in = max(0, int(conn.get('traffic_in') or 0))
        prev = new_baselines.get(base_key)
        first_seen = prev is None
        last_out = max(0, int((prev or {}).get('out') or 0))
        last_in = max(0, int((prev or {}).get('in') or 0))
        delta_out = _lucky_traffic_delta(current_out, last_out, first_seen=first_seen)
        delta_in = _lucky_traffic_delta(current_in, last_in, first_seen=first_seen)
        new_baselines[base_key] = {'out': current_out, 'in': current_in}
        if delta_out > 0:
            out_deltas[key] = out_deltas.get(key, 0) + delta_out
        if delta_in > 0:
            in_deltas[key] = in_deltas.get(key, 0) + delta_in
    return out_deltas, in_deltas, new_baselines


def extract_wan_conn_cumulative_traffic(res_list: list) -> Dict[str, Dict[str, int]]:
    """RemoteAddr → 当前累计 TrafficOut/In。"""
    result: Dict[str, Dict[str, int]] = {}
    for conn in iter_wan_conn_statistics(res_list):
        key = conn['remote_addr']
        result[key] = {
            'out': max(0, int(conn.get('traffic_out') or 0)),
            'in': max(0, int(conn.get('traffic_in') or 0)),
        }
    return result


def is_probable_stream_conn(conn: dict, delta_out: int = 0) -> bool:
    """过滤 API/心跳类小连接。"""
    total_out = max(0, int(conn.get('traffic_out') or 0))
    delta = max(0, int(delta_out or 0))
    if delta > 0:
        return True
    return total_out >= _MIN_STREAM_CONN_BYTES
