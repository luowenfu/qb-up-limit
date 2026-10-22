import logging
from qb.traffic_db import (
    add_speed_event,
    set_limit_source,
    get_limit_source,
    get_skip_auto_unlimit_once,
    set_skip_auto_unlimit_once,
    get_manual_baseline_threshold_gb,
    set_manual_baseline_threshold_gb,
    get_normal_global_upload_limit_kbps,
    set_normal_global_upload_limit_kbps,
    clear_normal_global_upload_limit,
    record_rule_trigger,
    record_rule_trigger_force,
    get_manual_limit_trigger_kbps,
    record_manual_limit_trigger,
    clear_manual_limit_trigger,
    sync_triggered_rules,
    LIMIT_SOURCE_AUTO,
    LIMIT_SOURCE_MANUAL,
    LIMIT_SOURCE_CYCLE,
    LIMIT_SOURCE_NONE,
)
from core.cycle import get_reset_anchor_label

logger = logging.getLogger(__name__)


def bytes_to_gb(bytes_val: int) -> float:
    return bytes_val / (1024 ** 3)


def _record_limit_source(qb_client, source: str):
    set_limit_source(qb_client.name, source)


def _sorted_rules_desc(speed_rules):
    return sorted(
        speed_rules,
        key=lambda r: r.get('cycle_upload_limit_gb', r.get('monthly_upload_limit_gb', 0)),
        reverse=True,
    )


def _get_highest_triggered_rule(speed_rules, cycle_gb: float):
    """返回当前已触发的最高档规则 (threshold_gb, limit_kbps)，无则 (None, None)"""
    for rule in _sorted_rules_desc(speed_rules):
        threshold_gb = rule.get(
            'cycle_upload_limit_gb',
            rule.get('monthly_upload_limit_gb', 0),
        )
        if cycle_gb >= threshold_gb:
            return threshold_gb, rule['speed_limit_kbps']
    return None, None


def _get_highest_triggered_threshold(speed_rules, cycle_gb: float) -> float:
    threshold_gb, _ = _get_highest_triggered_rule(speed_rules, cycle_gb)
    return threshold_gb or 0.0


def _get_rule_index_for_threshold(speed_rules, threshold_gb: float) -> int:
    for idx, rule in enumerate(speed_rules, start=1):
        rule_threshold = rule.get(
            'cycle_upload_limit_gb',
            rule.get('monthly_upload_limit_gb', 0),
        )
        if rule_threshold == threshold_gb:
            return idx
    return 1


def _record_quota_rule_trigger(qb_client, threshold_gb: float):
    rule_index = _get_rule_index_for_threshold(qb_client.speed_rules, threshold_gb)
    record_rule_trigger(qb_client.name, rule_index)


def _save_normal_global_if_unset(qb_client, current_limit_bytes: int):
    """在达量规则首次改写全局上传前，保存用户原有的常规全局限速"""
    if get_normal_global_upload_limit_kbps(qb_client.name) is not None:
        return
    kbps = current_limit_bytes // 1024 if current_limit_bytes > 0 else 0
    set_normal_global_upload_limit_kbps(qb_client.name, kbps)


def _compute_manual_baseline(qb_client, cycle_uploaded_bytes: int = None) -> float:
    if cycle_uploaded_bytes is None:
        return 0.0
    return _get_highest_triggered_threshold(
        qb_client.speed_rules,
        bytes_to_gb(cycle_uploaded_bytes),
    )


def _enter_manual_override(qb_client, cycle_uploaded_bytes: int = None):
    baseline = _compute_manual_baseline(qb_client, cycle_uploaded_bytes)
    set_manual_baseline_threshold_gb(qb_client.name, baseline)
    _record_limit_source(qb_client, LIMIT_SOURCE_MANUAL)
    return baseline


def _compute_expected_limit_kbps(qb_client, source: str,
                                  cycle_uploaded_bytes: int) -> int | None:
    """根据 limit_source 计算程序预期的全局上传限速 (KB/s)。None 表示跳过检测。"""
    if source == LIMIT_SOURCE_MANUAL:
        return None

    if source == LIMIT_SOURCE_AUTO:
        cycle_gb = bytes_to_gb(cycle_uploaded_bytes)
        threshold_gb, limit_kbps = _get_highest_triggered_rule(
            qb_client.speed_rules, cycle_gb)
        return limit_kbps if threshold_gb is not None else 0

    if source == LIMIT_SOURCE_CYCLE:
        cycle = getattr(qb_client, 'cycle', {}) or {}
        return max(0, int(cycle.get('reset_limit_kbps', 0) or 0))

    return None


def _restore_auto_from_rule_match(qb_client, threshold_gb: float,
                                   current_kbps: int, reason: str) -> bool:
    _record_limit_source(qb_client, LIMIT_SOURCE_AUTO)
    set_manual_baseline_threshold_gb(qb_client.name, 0)
    clear_manual_limit_trigger(qb_client.name)
    _record_quota_rule_trigger(qb_client, threshold_gb)
    add_speed_event(
        qb_client.name,
        'limit_applied',
        current_kbps,
        reason,
    )
    logger.info(f"[{qb_client.name}] {reason}")
    return True


def detect_external_limit_change(qb_client, cycle_uploaded_bytes: int,
                                  current_kbps: int = None,
                                  alt_speed_limits_active: bool = False) -> bool:
    """
    检测 qBittorrent 全局上传限速是否被外部修改。
    若与程序预期不符则视为手动限速；若恰好等于当前达量规则限速则恢复自动。
    """
    if alt_speed_limits_active:
        return False
    if getattr(qb_client, 'is_speed_testing', False):
        return False

    if current_kbps is None:
        current_limit_bytes = qb_client.get_current_upload_limit()
        current_kbps = (
            current_limit_bytes // 1024 if current_limit_bytes > 0 else 0
        )

    cycle_gb = bytes_to_gb(cycle_uploaded_bytes)
    threshold_gb, rule_limit_kbps = _get_highest_triggered_rule(
        qb_client.speed_rules, cycle_gb)

    source = get_limit_source(qb_client.name)

    if source == LIMIT_SOURCE_MANUAL:
        if threshold_gb is not None and rule_limit_kbps == current_kbps:
            return _restore_auto_from_rule_match(
                qb_client,
                threshold_gb,
                current_kbps,
                f'外部修改限速与当前达量规则一致: {current_kbps} KB/s',
            )
        stored_kbps = get_manual_limit_trigger_kbps(qb_client.name)
        if stored_kbps != current_kbps:
            record_manual_limit_trigger(qb_client.name, current_kbps)
            add_speed_event(
                qb_client.name,
                'limit_applied_manual',
                current_kbps,
                f'检测到 qBittorrent 外部修改全局上传限速: {current_kbps} KB/s',
            )
            logger.info(
                f"[{qb_client.name}] 手动覆盖中检测到外部限速变化: "
                f"{stored_kbps} -> {current_kbps} KB/s"
            )
            return True
        return False

    expected_kbps = _compute_expected_limit_kbps(
        qb_client, source, cycle_uploaded_bytes)
    if expected_kbps is None:
        return False

    if current_kbps == expected_kbps:
        return False

    if threshold_gb is not None and rule_limit_kbps == current_kbps:
        return _restore_auto_from_rule_match(
            qb_client,
            threshold_gb,
            current_kbps,
            f'外部修改限速与当前达量规则一致: {current_kbps} KB/s',
        )

    _enter_manual_override(qb_client, cycle_uploaded_bytes)
    record_manual_limit_trigger(qb_client.name, current_kbps)
    add_speed_event(
        qb_client.name,
        'limit_applied_manual',
        current_kbps,
        f'检测到 qBittorrent 外部修改全局上传限速: {current_kbps} KB/s',
    )
    logger.info(
        f"[{qb_client.name}] 检测到外部修改全局限速为 "
        f"{current_kbps} KB/s（预期 {expected_kbps} KB/s），视为手动覆盖"
    )
    return True


def check_and_apply_limit(qb_client, cycle_uploaded_bytes: int,
                          alt_speed_limits_active: bool = False) -> tuple:
    """
    检查是否需要限速并应用
    返回: (is_quota_limited, limit_kbps)
    """
    speed_rules = qb_client.speed_rules
    if not speed_rules:
        return False, 0

    if alt_speed_limits_active:
        logger.debug(
            f"[{qb_client.name}] 备用限速模式生效中，跳过达量全局限速写入"
        )
        return False, 0

    cycle_gb = bytes_to_gb(cycle_uploaded_bytes)
    source = get_limit_source(qb_client.name)
    threshold_gb, limit_kbps = _get_highest_triggered_rule(speed_rules, cycle_gb)

    if source == LIMIT_SOURCE_MANUAL:
        baseline = get_manual_baseline_threshold_gb(qb_client.name)
        if threshold_gb is None or threshold_gb <= baseline:
            logger.debug(
                f"[{qb_client.name}] 手动限速生效中，跳过达量写入"
            )
            return False, 0

    if threshold_gb is not None:
        current_limit = qb_client.get_current_upload_limit()
        expected_limit_bytes = limit_kbps * 1024

        if current_limit != expected_limit_bytes:
            _save_normal_global_if_unset(qb_client, current_limit)
            success = qb_client.set_upload_limit(expected_limit_bytes)
            if success:
                _record_limit_source(qb_client, LIMIT_SOURCE_AUTO)
                set_manual_baseline_threshold_gb(qb_client.name, 0)
                clear_manual_limit_trigger(qb_client.name)
                _record_quota_rule_trigger(qb_client, threshold_gb)
                reason = (f"周期上行流量 {cycle_gb:.2f}GB 达到 "
                          f"{threshold_gb}GB 阈值")
                add_speed_event(
                    qb_client.name,
                    'limit_applied',
                    limit_kbps,
                    reason
                )
                logger.info(f"[{qb_client.name}] 限速生效: {limit_kbps} KB/s，"
                              f"原因: {reason}")
                return True, limit_kbps
            logger.error(
                f"[{qb_client.name}] 达量限速设置失败 "
                f"({limit_kbps} KB/s)，将在下轮重试"
            )
            return False, 0

        _record_quota_rule_trigger(qb_client, threshold_gb)
        logger.debug(f"[{qb_client.name}] 达量限速已在生效中: {limit_kbps} KB/s")
        return True, limit_kbps

    if get_skip_auto_unlimit_once(qb_client.name):
        set_skip_auto_unlimit_once(qb_client.name, False)
        return False, 0

    if source != LIMIT_SOURCE_AUTO:
        return False, 0

    current_limit = qb_client.get_current_upload_limit()
    if current_limit > 0:
        success = qb_client.remove_upload_limit()
        if success:
            _record_limit_source(qb_client, LIMIT_SOURCE_NONE)
            reason = (f'周期上行流量 {cycle_gb:.2f}GB 低于阈值，'
                      f'自动解除达量限速')
            add_speed_event(
                qb_client.name,
                'limit_restored',
                0,
                reason
            )
            logger.info(f"[{qb_client.name}] {reason}")

    return False, 0


def apply_cycle_reset_limit(qb_client) -> bool:
    """到达新周期时应用配置的上传限速"""
    cycle = getattr(qb_client, 'cycle', {}) or {}
    limit_kbps = max(0, int(cycle.get('reset_limit_kbps', 0) or 0))
    anchor_label = get_reset_anchor_label(cycle)

    set_manual_baseline_threshold_gb(qb_client.name, 0)
    clear_normal_global_upload_limit(qb_client.name)

    if limit_kbps <= 0:
        success = qb_client.remove_upload_limit()
        if success:
            _record_limit_source(qb_client, LIMIT_SOURCE_NONE)
            add_speed_event(
                qb_client.name,
                'limit_restored',
                0,
                f'{anchor_label} 新周期自动恢复限速为无限速'
            )
            logger.info(
                f"[{qb_client.name}] {anchor_label} 新周期自动恢复限速为无限速"
            )
        return success

    success = qb_client.set_upload_limit(limit_kbps * 1024)
    if success:
        _record_limit_source(qb_client, LIMIT_SOURCE_CYCLE)
        add_speed_event(
            qb_client.name,
            'limit_applied',
            limit_kbps,
            f'{anchor_label} 新周期自动恢复限速为 {limit_kbps} KB/s'
        )
        logger.info(
            f"[{qb_client.name}] {anchor_label} 新周期自动恢复限速为 "
            f"{limit_kbps} KB/s"
        )
    return success


def force_apply_quota_rules(qb_client, cycle_uploaded_bytes: int,
                            reason: str = '保存设置后立即按达量规则生效') -> tuple:
    """立即按当前周期流量与达量规则应用限速，覆盖手动覆盖"""
    speed_rules = qb_client.speed_rules
    set_manual_baseline_threshold_gb(qb_client.name, 0)
    clear_manual_limit_trigger(qb_client.name)

    if not speed_rules:
        _record_limit_source(qb_client, LIMIT_SOURCE_NONE)
        return False, 0

    cycle_gb = bytes_to_gb(cycle_uploaded_bytes)
    threshold_gb, limit_kbps = _get_highest_triggered_rule(speed_rules, cycle_gb)

    if threshold_gb is not None:
        expected_limit_bytes = limit_kbps * 1024
        current_limit = qb_client.get_current_upload_limit()
        changed = current_limit != expected_limit_bytes
        if changed:
            _save_normal_global_if_unset(qb_client, current_limit)
            if not qb_client.set_upload_limit(expected_limit_bytes):
                logger.error(
                    f"[{qb_client.name}] 立即生效达量限速失败 "
                    f"({limit_kbps} KB/s)"
                )
                return False, 0
        _record_limit_source(qb_client, LIMIT_SOURCE_AUTO)
        sync_triggered_rules(qb_client.name, speed_rules, cycle_uploaded_bytes)
        record_rule_trigger_force(
            qb_client.name,
            _get_rule_index_for_threshold(speed_rules, threshold_gb),
        )
        if changed:
            add_speed_event(
                qb_client.name,
                'limit_applied',
                limit_kbps,
                reason,
            )
            logger.info(
                f"[{qb_client.name}] {reason}: {limit_kbps} KB/s "
                f"(阈值 {threshold_gb}GB)"
            )
        else:
            logger.info(
                f"[{qb_client.name}] {reason}: 已达量限速 {limit_kbps} KB/s"
            )
        return True, limit_kbps

    _record_limit_source(qb_client, LIMIT_SOURCE_NONE)
    sync_triggered_rules(qb_client.name, speed_rules, cycle_uploaded_bytes)
    current_limit = qb_client.get_current_upload_limit()
    if current_limit > 0:
        if qb_client.remove_upload_limit():
            add_speed_event(
                qb_client.name,
                'limit_restored',
                0,
                f'{reason}：当前流量未达任何达量阈值，已解除限速',
            )
            logger.info(
                f"[{qb_client.name}] {reason}：当前流量未达阈值，已解除限速"
            )
    return False, 0


def restore_speed_limit(qb_client, reason: str = '手动解除限速',
                        cycle_uploaded_bytes: int = None) -> bool:
    """解除上传限速（手动操作时调用）；在达量规则下保持手动覆盖直至下一条规则触发"""
    if not qb_client.allow_manual_unlimit:
        logger.info(f"[{qb_client.name}] 已禁用程序手动解除限速")
        return False

    _enter_manual_override(qb_client, cycle_uploaded_bytes)
    success = qb_client.remove_upload_limit()
    if success:
        record_manual_limit_trigger(qb_client.name, 0)
        add_speed_event(
            qb_client.name,
            'limit_restored',
            0,
            reason
        )
        logger.info(f"[{qb_client.name}] 限速已解除: {reason}")
    else:
        logger.warning(
            f"[{qb_client.name}] 解除限速 API 调用失败，保持手动覆盖状态",
        )
    return success


def force_apply_limit(qb_client, limit_kbps: int,
                      cycle_uploaded_bytes: int = None) -> bool:
    """强制应用限速（Web界面手动操作）"""
    if limit_kbps > 0 and cycle_uploaded_bytes is not None:
        cycle_gb = bytes_to_gb(cycle_uploaded_bytes)
        threshold_gb, rule_limit_kbps = _get_highest_triggered_rule(
            qb_client.speed_rules, cycle_gb)
        if threshold_gb is not None and rule_limit_kbps == limit_kbps:
            expected_limit_bytes = limit_kbps * 1024
            current_limit = qb_client.get_current_upload_limit()
            if current_limit != expected_limit_bytes:
                success = qb_client.set_upload_limit(expected_limit_bytes)
                if not success:
                    return False
            return _restore_auto_from_rule_match(
                qb_client,
                threshold_gb,
                limit_kbps,
                f'手动设置限速与当前达量规则一致: {limit_kbps} KB/s',
            )

    _enter_manual_override(qb_client, cycle_uploaded_bytes)

    if limit_kbps <= 0:
        success = qb_client.remove_upload_limit()
        if success:
            record_manual_limit_trigger(qb_client.name, 0)
            add_speed_event(
                qb_client.name,
                'limit_removed_manual',
                0,
                '手动解除限速，直至下一条达量规则触发后自动接管'
            )
        else:
            _record_limit_source(qb_client, LIMIT_SOURCE_NONE)
            set_manual_baseline_threshold_gb(qb_client.name, 0)
        return success

    success = qb_client.set_upload_limit(limit_kbps * 1024)
    if success:
        record_manual_limit_trigger(qb_client.name, limit_kbps)
        add_speed_event(
            qb_client.name,
            'limit_applied_manual',
            limit_kbps,
            f'手动设置限速: {limit_kbps} KB/s，直至下一条达量规则触发后自动接管'
        )
    else:
        _record_limit_source(qb_client, LIMIT_SOURCE_NONE)
        set_manual_baseline_threshold_gb(qb_client.name, 0)
    return success
