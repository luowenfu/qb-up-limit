/** Emby 只读展示模块 */

const EMBY_TAB_STORAGE_KEY = 'qb_uplimit_emby_tab';
const VALID_EMBY_TABS = new Set(['devices', 'stats', 'events', 'syslogs']);
let embyNavExpanded = false;
let embyCurrentTab = 'devices';
let cachedEmbyInstances = [];
let embyDebugTrafficConfig = null;
const EMBY_DEBUG_QUERY_KEY = 'emby_debug';

function isEmbyDebugModeEnabled() {
    try {
        const value = new URLSearchParams(window.location.search || '').get(EMBY_DEBUG_QUERY_KEY);
        if (value == null) return false;
        const normalized = String(value).trim().toLowerCase();
        return normalized === '1' || normalized === 'true';
    } catch (_) {
        return false;
    }
}

const EMBY_DEBUG_MODE_ENABLED = isEmbyDebugModeEnabled();
const EMBY_BROWSE_UPLOAD_MIN_MB_DEFAULT = 1.0;
const EMBY_BROWSE_UPLOAD_MIN_MB_MIN = 0;
const EMBY_BROWSE_UPLOAD_MIN_MB_MAX = 100;
const EMBY_PREPLAY_BURST_MBPS_DEFAULT = 1.5;
const EMBY_PREPLAY_BURST_MBPS_MIN = 0.5;
const EMBY_PREPLAY_BURST_MBPS_MAX = 10;
const EMBY_PREPLAY_BURST_WINDOW_DEFAULT = 3;
const EMBY_PREPLAY_BURST_WINDOW_MIN = 1;
const EMBY_PREPLAY_BURST_WINDOW_MAX = 10;
const EMBY_DEBUG_WINDOW_POS_KEY_PREFIX = 'qb-up-limit-emby-debug-window-pos-';
const EMBY_DEBUG_LUCKY_DEFAULT_VIEWPORT_RATIO = 0.62;
const EMBY_DEBUG_LUCKY_CONN_MIN = 160;
let embyDebugFloatZIndex = 12000;

function resolveEmbyInstanceCollectMode(inst) {
    const mode = String(inst?.traffic_collect_mode || '').trim().toLowerCase();
    return mode === 'lucky' ? 'lucky' : '';
}

function getEmbyDebugPanelTitle(inst) {
    const mode = resolveEmbyInstanceCollectMode(inst);
    if (mode === 'lucky') return 'Lucky模式 调试面板';
    return '未开启流量采集';
}

function syncEmbyDebugWindowTriggerButton(btn, inst) {
    if (!btn || !inst) return;
    const collectMode = resolveEmbyInstanceCollectMode(inst);
    if (!collectMode) {
        btn.textContent = '未开启流量采集';
        btn.disabled = true;
        btn.classList.add('emby-debug-window-open--disabled');
        btn.removeAttribute('onclick');
        return;
    }
    btn.textContent = `${getEmbyDebugPanelTitle(inst)}`;
    btn.disabled = false;
    btn.classList.remove('emby-debug-window-open--disabled');
    btn.setAttribute('onclick', 'openEmbyDebugFloatWindow(this.dataset.instance)');
}

function findEmbyDebugFloatWindow(instanceName) {
    const name = String(instanceName || '').trim();
    if (!name) return null;
    return Array.from(document.querySelectorAll('.emby-debug-float-window'))
        .find((win) => win.dataset.instance === name) || null;
}

function loadEmbyDebugWindowPosition(instanceName) {
    try {
        const raw = localStorage.getItem(`${EMBY_DEBUG_WINDOW_POS_KEY_PREFIX}${instanceName}`);
        if (!raw) return null;
        const pos = JSON.parse(raw);
        const result = {};
        if (Number.isFinite(pos.left)) result.left = pos.left;
        if (Number.isFinite(pos.top)) result.top = pos.top;
        if (Number.isFinite(result.left) && Number.isFinite(result.top)) {
            return result;
        }
    } catch (_) {
        /* ignore */
    }
    return null;
}

function saveEmbyDebugWindowPosition(instanceName, left, top) {
    try {
        localStorage.setItem(
            `${EMBY_DEBUG_WINDOW_POS_KEY_PREFIX}${instanceName}`,
            JSON.stringify({ left: Math.round(left), top: Math.round(top) }),
        );
    } catch (_) {
        /* ignore */
    }
}

function getDefaultEmbyDebugWindowPosition(index = 0) {
    const margin = 16;
    const offset = (index % 6) * 28;
    return { left: margin + offset, top: 80 + offset };
}

function clampEmbyDebugWindowPosition(left, top, width, height) {
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
        left: Math.min(Math.max(margin, left), maxLeft),
        top: Math.min(Math.max(margin, top), maxTop),
    };
}

function normalizeEmbyDebugTrafficConfig(raw = null) {
    const src = raw || {};
    const browseMinMbRaw = parseFloat(
        src.browse_upload_min_mb ?? src.emby_browse_upload_min_mb,
    );
    const preplayBurstMbpsRaw = parseFloat(
        src.preplay_burst_mbps ?? src.emby_preplay_burst_mbps,
    );
    const preplayBurstWindowRaw = parseInt(
        src.preplay_burst_window_seconds ?? src.emby_preplay_burst_window_seconds,
        10,
    );
    const browseMinMb = Number.isFinite(browseMinMbRaw)
        ? browseMinMbRaw
        : EMBY_BROWSE_UPLOAD_MIN_MB_DEFAULT;
    const preplayBurstMbps = Number.isFinite(preplayBurstMbpsRaw)
        ? preplayBurstMbpsRaw
        : EMBY_PREPLAY_BURST_MBPS_DEFAULT;
    const preplayBurstWindow = Number.isFinite(preplayBurstWindowRaw)
        ? preplayBurstWindowRaw
        : EMBY_PREPLAY_BURST_WINDOW_DEFAULT;
    return {
        preplay_burst_mbps: Math.max(
            EMBY_PREPLAY_BURST_MBPS_MIN,
            Math.min(EMBY_PREPLAY_BURST_MBPS_MAX, Math.round(preplayBurstMbps * 100) / 100),
        ),
        preplay_burst_window_seconds: Math.max(
            EMBY_PREPLAY_BURST_WINDOW_MIN,
            Math.min(EMBY_PREPLAY_BURST_WINDOW_MAX, Math.round(preplayBurstWindow)),
        ),
        browse_upload_min_mb: Math.max(
            EMBY_BROWSE_UPLOAD_MIN_MB_MIN,
            Math.min(EMBY_BROWSE_UPLOAD_MIN_MB_MAX, Math.round(browseMinMb * 100) / 100),
        ),
    };
}

function getEmbyBrowseUploadMinMb(raw = null) {
    return normalizeEmbyDebugTrafficConfig(raw || embyDebugTrafficConfig).browse_upload_min_mb;
}

function getEmbyBrowseUploadMinBytes(raw = null) {
    const mb = getEmbyBrowseUploadMinMb(raw);
    return Math.round(mb * 1024 * 1024);
}

function buildPreplayBurstSummaryHintText(windowSeconds, thresholdMbps) {
    const windowVal = Number.isFinite(windowSeconds) && windowSeconds > 0
        ? Math.round(windowSeconds)
        : EMBY_PREPLAY_BURST_WINDOW_DEFAULT;
    const thresholdVal = Number.isFinite(thresholdMbps) && thresholdMbps > 0
        ? thresholdMbps
        : EMBY_PREPLAY_BURST_MBPS_DEFAULT;
    const thresholdText = Number.isInteger(thresholdVal)
        ? String(thresholdVal)
        : String(Math.round(thresholdVal * 100) / 100);
    return `当前开播突发判定：点击开播后，前 ${windowVal} 秒内、速率 ≥ ${thresholdText} MB/s 的流量视为推流突发，计入播放。`;
}

function syncPreplayBurstSummaryHint(panel) {
    if (!panel) return;
    const hintEl = panel.querySelector('[data-field="preplay-burst-summary-hint"]');
    if (!hintEl) return;
    const windowSeconds = parseInt(
        panel.querySelector('[data-field="preplay-burst-window"]')?.value,
        10,
    );
    const thresholdMbps = parseFloat(
        panel.querySelector('[data-field="preplay-burst-mbps"]')?.value,
    );
    hintEl.textContent = buildPreplayBurstSummaryHintText(windowSeconds, thresholdMbps);
}

function bindPreplayBurstConfigInputs() {
    if (window.__embyPreplayBurstInputBound) return;
    window.__embyPreplayBurstInputBound = true;
    document.addEventListener('input', (e) => {
        const field = e.target?.dataset?.field;
        if (field !== 'preplay-burst-window' && field !== 'preplay-burst-mbps') return;
        syncPreplayBurstSummaryHint(e.target.closest('.emby-debug-float-window'));
    });
}

function buildLuckyConnDebugMetaHtml(row, options = {}) {
    const parts = [
        `建连 ${escapeHtml(row.acceptTime || '—')}`,
        `+${escapeHtml(formatEmbyTrafficText(row.deltaOut))}`,
        `总累计 ${escapeHtml(formatEmbyTrafficText(row.trafficOut))}`,
    ];
    if (Number.isFinite(row.timeMatchSeconds) && row.timeMatchSeconds >= 0) {
        parts.push(`时差 ${row.timeMatchSeconds}s`);
    }
    if (row.billingState === 'credited' && row.accumulatorBytes > 0) {
        parts.push(`播放累计 ${escapeHtml(formatEmbyTrafficText(row.accumulatorBytes))}`);
    } else if (row.billingState === 'browse_credited' && row.accumulatorBytes > 0) {
        parts.push(`选片累计 ${escapeHtml(formatEmbyTrafficText(row.accumulatorBytes))}`);
    }
    return parts.join(' · ');
}

function formatEmbyBrowseUploadMinMbLabel(mb = null) {
    const value = Number(mb ?? getEmbyBrowseUploadMinMb());
    if (!Number.isFinite(value)) return '1 MB';
    const text = Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
    return `${text} MB`;
}

function buildEmbyBrowseLogHintText(mb = null) {
    const value = Number(mb ?? getEmbyBrowseUploadMinMb());
    if (!Number.isFinite(value) || value <= 0) {
        return '已设置选片流量均会计入';
    }
    const label = formatEmbyBrowseUploadMinMbLabel(mb);
    return `已设置选片流量 > ${label} 计入`;
}

function syncEmbyBrowseLogHintText() {
    const hint = document.getElementById('embyBrowseLogHint');
    if (!hint) return;
    hint.textContent = buildEmbyBrowseLogHintText();
}

function resolveEmbyRefreshInterval(inst) {
    const n = parseInt(inst?.refresh_interval, 10);
    if (Number.isFinite(n) && n > 0) return n;
    if (typeof autoRefreshInterval === 'number' && autoRefreshInterval > 0) {
        return autoRefreshInterval;
    }
    return 1;
}

function resolveEmbyCollectInterval(inst) {
    const n = parseInt(inst?.collect_interval, 10);
    if (Number.isFinite(n) && n > 0) return n;
    if (typeof persistRefreshInterval === 'number' && persistRefreshInterval > 0) {
        return persistRefreshInterval;
    }
    return 5;
}

function formatEmbyCollectIntervalLabel(inst) {
    const refreshSec = resolveEmbyRefreshInterval(inst);
    const collectSec = resolveEmbyCollectInterval(inst);
    return `${refreshSec}秒刷新 · ${collectSec}秒采集`;
}

function inferEmbyDebugModeLabel(inst) {
    const counts = getEmbyInstancePlaybackCounts(inst || {});
    if ((counts.lan || 0) <= 0 && (counts.wan || 0) <= 0) return '无播放 M0';
    if ((counts.lan || 0) > 0 && (counts.wan || 0) <= 0) return '仅局域网 M1';
    if ((counts.wan || 0) > 0 && (counts.lan || 0) <= 0) return '仅外网 M2';
    return '局域网+外网 M3';
}

function normalizeEmbyDebugTrafficMetrics(inst = null) {
    const src = (inst && inst.debug_traffic_metrics) || {};
    const parseNonNegativeInt = (value, fallback = 0) => {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0) return Math.max(0, parseInt(fallback, 10) || 0);
        return n;
    };
    const collectMode = String(inst?.traffic_collect_mode || '').trim().toLowerCase();
    const modeLabel = collectMode === 'lucky'
        ? 'Lucky 准确采集'
        : (String(src.mode_label || '').trim() || inferEmbyDebugModeLabel(inst));
    return {
        collectMode,
        modeLabel,
        totalUploadBytes: parseNonNegativeInt(src.total_upload_bytes, inst?.recent_delta_bytes || 0),
        wanUploadBytes: parseNonNegativeInt(src.wan_upload_bytes, 0),
        lanUploadBytes: parseNonNegativeInt(src.lan_upload_bytes, 0),
        programRemainderBytes: parseNonNegativeInt(src.program_remainder_bytes, 0),
        modeSwitchPendingBytes: parseNonNegativeInt(src.mode_switch_pending_bytes, 0),
        modeSwitchReplayBytes: parseNonNegativeInt(src.mode_switch_replay_bytes, 0),
        modeSwitchReplayAllocBytes: parseNonNegativeInt(src.mode_switch_replay_alloc_bytes, 0),
        modeSwitchReplayTotalBytes: parseNonNegativeInt(src.mode_switch_replay_total_bytes, 0),
        modeSwitchReplayAllocTotalBytes: parseNonNegativeInt(
            src.mode_switch_replay_alloc_total_bytes, 0,
        ),
        wanAllocBacklogBytes: parseNonNegativeInt(src.wan_alloc_backlog_bytes, 0),
        wanAllocBacklogAppliedBytes: parseNonNegativeInt(
            src.wan_alloc_backlog_applied_bytes, 0,
        ),
        m1WanCaptureBytes: parseNonNegativeInt(src.m1_wan_capture_bytes, 0),
        luckyConnBindings: normalizeLuckyConnDebugList(inst),
    };
}

function normalizeLuckyConnDebugList(inst) {
    const raw = inst?.lucky_conn_debug;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.version === 2) {
        return normalizeLuckyConnVerdictSnapshot(raw);
    }
    const legacyRows = Array.isArray(raw) ? raw : [];
    return {
        version: 2,
        groups: legacyRows.length ? [{
            ip: legacyRows[0]?.ip || '—',
            sessionSummary: '',
            sessionCount: 0,
            rows: legacyRows.map(normalizeLuckyConnVerdictRow),
        }] : [],
        embyWithoutLucky: [],
        totalConnections: legacyRows.length,
        rows: legacyRows.map(normalizeLuckyConnVerdictRow),
    };
}

function normalizeLuckyConnVerdictRow(row) {
    const parseBytes = (value) => {
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const billingState = String(row?.billing_state || '').trim()
        || (row?.persist_key ? 'credited' : 'excluded');
    const accumulatorBytes = parseBytes(row?.accumulator_bytes);
    // 选片流量的入账/不入账实时按「选片入账阈值」点亮，仅作展示（真正入账以结算为准）。
    let billingLabel = String(row?.billing_label || '').trim();
    let billingDisplayState = billingState;
    if (billingState === 'browse_credited') {
        const thresholdBytes = getEmbyBrowseUploadMinMb() * 1024 * 1024;
        const lit = accumulatorBytes >= thresholdBytes;
        billingLabel = lit ? '选片入账' : '不入账';
        billingDisplayState = lit ? 'browse_credited' : 'browse_pending';
    } else if (!billingLabel) {
        billingLabel = billingState === 'credited' ? '已入账' : '不入账';
    }
    return {
        remoteAddr: String(row?.remote_addr || '').trim(),
        ip: String(row?.ip || '').trim(),
        port: parseInt(row?.port, 10) || 0,
        acceptTime: String(row?.accept_time || '').trim(),
        trafficOut: parseBytes(row?.traffic_out),
        deltaOut: parseBytes(row?.delta_out),
        connRole: String(row?.conn_role || '').trim(),
        connRoleLabel: String(row?.conn_role_label || '').trim() || '—',
        embyLabel: String(row?.emby_label || row?.emby_hint || '').trim() || '—',
        embyUser: String(row?.emby_user || row?.user_name || '').trim(),
        embyMode: String(row?.emby_mode || '').trim(),
        billingState,
        billingDisplayState,
        billingLabel,
        confidence: String(row?.confidence || '').trim(),
        confidenceLabel: String(row?.confidence_label || '').trim() || '—',
        reasons: Array.isArray(row?.reasons)
            ? row.reasons.map((r) => String(r || '').trim()).filter(Boolean)
            : [],
        persistKey: String(row?.billing_persist_key || row?.persist_key || '').trim(),
        accumulatorBytes,
        timeMatchSeconds: row?.time_match_seconds,
        waveId: parseInt(row?.wave_id, 10) || 0,
        matchScore: Number.isFinite(row?.match_score) ? parseInt(row.match_score, 10) : null,
        scoreDetails: Array.isArray(row?.score_details)
            ? row.score_details.map((r) => String(r || '').trim()).filter(Boolean)
            : [],
        ambiguous: !!row?.ambiguous,
        stickyHint: !!row?.sticky_hint,
        sessionMatchKey: String(row?.session_match_key || '').trim(),
    };
}

function buildLuckyIpCollapsedSummary(group) {
    const rows = group?.rows || [];
    if (!rows.length) {
        return '<span class="emby-debug-lucky-ip-summary emby-debug-lucky-ip-summary--empty">无 Lucky 连接</span>';
    }
    const users = [];
    rows.forEach((row) => {
        const user = String(row?.embyUser || '').trim();
        if (user && !users.includes(user)) users.push(user);
    });
    if (users.length) {
        return `<span class="emby-debug-lucky-ip-summary">${escapeHtml(users.join('、'))}</span>`;
    }
    const orphanCount = rows.filter((row) => row.embyMode === 'orphan').length;
    if (orphanCount === rows.length) {
        return `<span class="emby-debug-lucky-ip-summary emby-debug-lucky-ip-summary--empty">${rows.length} 条未匹配</span>`;
    }
    return `<span class="emby-debug-lucky-ip-summary">${rows.length} 条连接</span>`;
}

function normalizeLuckyConnVerdictSnapshot(snapshot) {
    const groups = (snapshot?.groups || []).map((group) => ({
        ip: String(group?.ip || '').trim() || '—',
        sessionSummary: String(group?.session_summary || '').trim(),
        sessionCount: parseInt(group?.session_count, 10) || 0,
        rows: (group?.rows || []).map(normalizeLuckyConnVerdictRow),
    }));
    const embyWithoutLucky = (snapshot?.emby_without_lucky || []).map((item) => ({
        ip: String(item?.ip || '').trim(),
        embyLabel: String(item?.emby_label || '').trim(),
        sessionMode: String(item?.session_mode || '').trim(),
    }));
    const rows = groups.flatMap((g) => g.rows);
    return {
        version: 2,
        groups,
        embyWithoutLucky,
        totalConnections: parseInt(snapshot?.total_connections, 10) || rows.length,
        rows,
    };
}

function luckyConnRoleClass(role) {
    const map = {
        stream_primary: 'emby-debug-lucky-role--primary',
        stream_secondary: 'emby-debug-lucky-role--secondary',
        stream_pending: 'emby-debug-lucky-role--pending',
        browse: 'emby-debug-lucky-role--browse',
        control: 'emby-debug-lucky-role--control',
    };
    return map[role] || '';
}

function luckyBillingClass(state) {
    const map = {
        credited: 'emby-debug-lucky-billing--credited',
        browse_credited: 'emby-debug-lucky-billing--browse',
        browse_pending: 'emby-debug-lucky-billing--excluded',
        pending: 'emby-debug-lucky-billing--pending',
        orphan: 'emby-debug-lucky-billing--orphan',
    };
    return map[state] || 'emby-debug-lucky-billing--excluded';
}

function luckyConfidenceClass(level) {
    const map = {
        high: 'emby-debug-lucky-confidence--high',
        medium: 'emby-debug-lucky-confidence--medium',
        low: 'emby-debug-lucky-confidence--low',
    };
    return map[level] || '';
}

function isLuckyDebugIpRevealed(panel) {
    return panel?.dataset?.luckyIpRevealed === '1';
}

function formatLuckyDebugIpText(ip, options = {}) {
    const raw = String(ip || '').trim();
    if (!raw || raw === '—') return '—';
    const port = parseInt(options.port, 10) || 0;
    const revealed = !!options.revealed;
    const displayIp = revealed ? raw : maskEmbyEndpointDisplay(raw);
    const portLabel = port > 0 ? `:${port}` : '';
    return `${displayIp}${portLabel}`;
}

function luckyDebugIpTitleAttr(ip, remoteAddr, revealed) {
    const raw = String(remoteAddr || ip || '').trim();
    if (!raw || raw === '—') return '';
    return revealed ? raw : maskEmbyEndpointDisplay(raw);
}

function buildLuckyDebugIpPanelToggleHtml(revealed) {
    return `<button type="button" class="emby-debug-lucky-ip-panel-toggle emby-event-ip-toggle" aria-label="${revealed ? '隐藏 IP' : '显示 IP'}" aria-pressed="${revealed ? 'true' : 'false'}">${buildEmbyEventIpEyeIcon(revealed)}</button>`;
}

function applyLuckyDebugIpRevealState(panel, revealed) {
    if (!panel) return;
    panel.dataset.luckyIpRevealed = revealed ? '1' : '0';
    panel.querySelectorAll('.emby-debug-lucky-ip-text').forEach((el) => {
        const ip = el.dataset.ip || '';
        const port = parseInt(el.dataset.port, 10) || 0;
        el.textContent = formatLuckyDebugIpText(ip, { port, revealed });
        const remoteAddr = el.dataset.remoteAddr || ip;
        const title = luckyDebugIpTitleAttr(ip, remoteAddr, revealed);
        if (title) el.setAttribute('title', title);
        else el.removeAttribute('title');
    });
    const btn = panel.querySelector('.emby-debug-lucky-ip-panel-toggle');
    if (btn) {
        btn.setAttribute('aria-pressed', revealed ? 'true' : 'false');
        btn.setAttribute('aria-label', revealed ? '隐藏 IP' : '显示 IP');
        btn.innerHTML = buildEmbyEventIpEyeIcon(revealed);
    }
}

function buildLuckyMatchScoreTipText(row) {
    const titleParts = [...(row.reasons || [])];
    if (row.scoreDetails?.length) {
        titleParts.push('', '【打分】', ...row.scoreDetails);
    }
    if (Number.isFinite(row.matchScore)) {
        titleParts.unshift(`匹配分 ${row.matchScore}`);
    }
    return titleParts.length ? titleParts.join('\n') : '';
}

function buildLuckyConnDebugRowHtml(row, options = {}) {
    const roleClass = luckyConnRoleClass(row.connRole);
    const billingClass = luckyBillingClass(row.billingDisplayState || row.billingState);
    const confClass = luckyConfidenceClass(row.confidence);
    const scoreTipText = buildLuckyMatchScoreTipText(row);
    const scoreTipAttr = scoreTipText ? ` data-tip="${escapeHtml(scoreTipText)}"` : '';
    const rowClass = row.connRole === 'stream_primary'
        ? ' emby-debug-lucky-verdict-row--primary'
        : (row.ambiguous ? ' emby-debug-lucky-verdict-row--ambiguous' : '');
    const embyLabelTitle = row.embyLabel && row.embyLabel !== '—'
        ? escapeHtml(row.embyLabel)
        : '';
    const userHtml = row.embyUser && row.embyMode !== 'orphan'
        ? `<span class="emby-debug-lucky-conn-user">${escapeHtml(row.embyUser)}</span>`
        : (row.embyMode === 'orphan'
            ? '<span class="emby-debug-lucky-conn-user emby-debug-lucky-conn-user--orphan">未匹配</span>'
            : '');
    const waveHtml = row.waveId > 0
        ? `<span class="emby-debug-lucky-wave-badge">波${row.waveId}</span>`
        : '';
    const scoreHtml = Number.isFinite(row.matchScore)
        ? `<button type="button" class="emby-debug-lucky-score-badge emby-debug-lucky-score-tip"${scoreTipAttr} aria-label="匹配评分详情">${row.matchScore}</button>`
        : '';
    const stickyHtml = row.stickyHint
        ? '<span class="emby-debug-lucky-sticky-badge" title="沿用上 tick 匹配记忆">粘</span>'
        : '';
    const confidenceTipAttr = !Number.isFinite(row.matchScore) && scoreTipText
        ? ` data-tip="${escapeHtml(scoreTipText)}"`
        : '';
    const metaHtml = buildLuckyConnDebugMetaHtml(row, options);
    const ipRevealed = !!options.ipRevealed;
    const addrText = formatLuckyDebugIpText(row.ip, { port: row.port, revealed: ipRevealed });
    const addrTitle = luckyDebugIpTitleAttr(row.ip, row.remoteAddr, ipRevealed);
    return `
        <div class="emby-debug-lucky-verdict-row${rowClass}" data-remote-addr="${escapeHtml(row.remoteAddr)}">
            <div class="emby-debug-lucky-verdict-line">
                <div class="emby-debug-lucky-verdict-line-leading">
                    ${waveHtml}
                    ${userHtml}
                    <code class="emby-debug-lucky-conn-addr emby-debug-lucky-ip-text" data-ip="${escapeHtml(row.ip)}" data-port="${row.port || 0}" data-remote-addr="${escapeHtml(row.remoteAddr)}"${addrTitle ? ` title="${escapeHtml(addrTitle)}"` : ''}>${escapeHtml(addrText)}</code>
                    <span class="emby-debug-lucky-role ${roleClass}">${escapeHtml(row.connRoleLabel)}</span>
                    <span class="emby-debug-lucky-billing ${billingClass}">${escapeHtml(row.billingLabel)}</span>
                    ${stickyHtml}
                    <span class="emby-debug-lucky-confidence ${confClass}${confidenceTipAttr ? ' emby-debug-lucky-score-tip' : ''}"${confidenceTipAttr}>${escapeHtml(row.confidenceLabel)}</span>
                </div>
                ${scoreHtml}
            </div>
            <div class="emby-debug-lucky-verdict-line emby-debug-lucky-verdict-line--sub">
                <span class="emby-debug-lucky-verdict-emby"${embyLabelTitle ? ` title="${embyLabelTitle}"` : ''}>${escapeHtml(row.embyLabel)}</span>
                <span class="emby-debug-lucky-conn-meta">${metaHtml}</span>
            </div>
        </div>`;
}

function buildLuckyConnDebugIpGroupHtml(group, options = {}) {
    const open = !!options.open;
    const ipRevealed = !!options.ipRevealed;
    const rows = group?.rows || [];
    const summary = buildLuckyIpCollapsedSummary(group);
    const ipText = formatLuckyDebugIpText(group.ip, { revealed: ipRevealed });
    const ipTitle = luckyDebugIpTitleAttr(group.ip, group.ip, ipRevealed);
    const body = rows.length
        ? `<div class="emby-debug-lucky-conn-list-inner">${rows.map((row) => buildLuckyConnDebugRowHtml(row, options)).join('')}</div>`
        : '<p class="emby-debug-lucky-conn-empty">该 IP 暂无 Lucky 连接</p>';
    return `
        <details class="emby-debug-lucky-ip-group" data-ip="${escapeHtml(group.ip)}" ${open ? 'open' : ''}>
            <summary class="emby-debug-lucky-ip-summary-row">
                <span class="emby-debug-lucky-ip-chevron" aria-hidden="true"></span>
                <span class="emby-debug-lucky-ip-label emby-debug-lucky-ip-text" data-ip="${escapeHtml(group.ip)}"${ipTitle ? ` title="${escapeHtml(ipTitle)}"` : ''}>${escapeHtml(ipText)}</span>
                ${summary}
                <span class="emby-debug-conn-group-count">${rows.length}</span>
            </summary>
            <div class="emby-debug-lucky-conn-list">${body}</div>
        </details>`;
}

function buildLuckyConnDebugGroupsHtml(snapshot, options = {}) {
    const data = snapshot && snapshot.version === 2
        ? snapshot
        : normalizeLuckyConnVerdictSnapshot({
            version: 2,
            groups: [],
            rows: Array.isArray(snapshot) ? snapshot : [],
        });
    const groups = data.groups || [];
    const firstOpen = !!options.firstOpen;
    if (!groups.length) {
        return '<p class="emby-debug-lucky-conn-empty">暂无 Lucky 外网连接</p>';
    }
    return groups.map((group, idx) => buildLuckyConnDebugIpGroupHtml(group, {
        open: idx === 0 ? firstOpen : !!options.allOpen,
        ipRevealed: !!options.ipRevealed,
    })).join('');
}

function buildLuckyConnDebugRowsHtml(snapshot) {
    return buildLuckyConnDebugGroupsHtml(snapshot, { firstOpen: false, allOpen: false });
}

function patchLuckyConnDebugRowElement(rowEl, row, options = {}) {
    if (!rowEl || !row) return;
    rowEl.classList.toggle(
        'emby-debug-lucky-verdict-row--primary',
        row.connRole === 'stream_primary',
    );
    rowEl.classList.toggle(
        'emby-debug-lucky-verdict-row--ambiguous',
        !!row.ambiguous && row.connRole !== 'stream_primary',
    );

    const userEl = rowEl.querySelector('.emby-debug-lucky-conn-user');
    if (row.embyUser && row.embyMode !== 'orphan') {
        if (userEl) {
            userEl.textContent = row.embyUser;
            userEl.classList.remove('emby-debug-lucky-conn-user--orphan');
        }
    } else if (row.embyMode === 'orphan') {
        if (userEl) {
            userEl.textContent = '未匹配';
            userEl.classList.add('emby-debug-lucky-conn-user--orphan');
        }
    } else if (userEl) {
        userEl.remove();
    }

    const waveEl = rowEl.querySelector('.emby-debug-lucky-wave-badge');
    if (row.waveId > 0) {
        if (waveEl) waveEl.textContent = `波${row.waveId}`;
    } else if (waveEl) {
        waveEl.remove();
    }

    const addrEl = rowEl.querySelector('.emby-debug-lucky-conn-addr');
    if (addrEl) {
        const ipRevealed = !!options.ipRevealed;
        addrEl.textContent = formatLuckyDebugIpText(row.ip, { port: row.port, revealed: ipRevealed });
        const addrTitle = luckyDebugIpTitleAttr(row.ip, row.remoteAddr, ipRevealed);
        if (addrTitle) addrEl.setAttribute('title', addrTitle);
        else addrEl.removeAttribute('title');
    }

    const roleEl = rowEl.querySelector('.emby-debug-lucky-role');
    if (roleEl) {
        roleEl.className = `emby-debug-lucky-role ${luckyConnRoleClass(row.connRole)}`;
        roleEl.textContent = row.connRoleLabel || '—';
    }

    const billingEl = rowEl.querySelector('.emby-debug-lucky-billing');
    if (billingEl) {
        billingEl.className = `emby-debug-lucky-billing ${luckyBillingClass(row.billingDisplayState || row.billingState)}`;
        billingEl.textContent = row.billingLabel || '—';
    }

    const stickyEl = rowEl.querySelector('.emby-debug-lucky-sticky-badge');
    if (row.stickyHint) {
        if (!stickyEl) {
            const billing = rowEl.querySelector('.emby-debug-lucky-billing');
            billing?.insertAdjacentHTML(
                'afterend',
                '<span class="emby-debug-lucky-sticky-badge" title="沿用上 tick 匹配记忆">粘</span>',
            );
        }
    } else if (stickyEl) {
        stickyEl.remove();
    }

    const confEl = rowEl.querySelector('.emby-debug-lucky-confidence');
    const scoreTipText = buildLuckyMatchScoreTipText(row);
    if (confEl) {
        confEl.className = `emby-debug-lucky-confidence ${luckyConfidenceClass(row.confidence)}${
            !Number.isFinite(row.matchScore) && scoreTipText ? ' emby-debug-lucky-score-tip' : ''
        }`;
        confEl.textContent = row.confidenceLabel || '—';
        if (!Number.isFinite(row.matchScore) && scoreTipText) {
            confEl.setAttribute('data-tip', scoreTipText);
        } else {
            confEl.removeAttribute('data-tip');
        }
    }

    const lineEl = rowEl.querySelector('.emby-debug-lucky-verdict-line');
    let scoreEl = rowEl.querySelector('.emby-debug-lucky-score-badge');
    if (Number.isFinite(row.matchScore)) {
        if (!scoreEl && lineEl) {
            lineEl.insertAdjacentHTML(
                'beforeend',
                `<button type="button" class="emby-debug-lucky-score-badge emby-debug-lucky-score-tip" aria-label="匹配评分详情">${row.matchScore}</button>`,
            );
            scoreEl = rowEl.querySelector('.emby-debug-lucky-score-badge');
        }
        if (scoreEl) {
            scoreEl.textContent = String(row.matchScore);
            if (scoreTipText) scoreEl.setAttribute('data-tip', scoreTipText);
            else scoreEl.removeAttribute('data-tip');
        }
    } else if (scoreEl) {
        scoreEl.remove();
    }

    const embyEl = rowEl.querySelector('.emby-debug-lucky-verdict-emby');
    if (embyEl) {
        embyEl.textContent = row.embyLabel || '—';
        if (row.embyLabel && row.embyLabel !== '—') {
            embyEl.setAttribute('title', row.embyLabel);
        } else {
            embyEl.removeAttribute('title');
        }
    }

    const metaHtml = buildLuckyConnDebugMetaHtml(row, options);
    const metaEl = rowEl.querySelector('.emby-debug-lucky-conn-meta');
    if (metaEl) metaEl.innerHTML = metaHtml;
}

function tryPatchLuckyConnDebugGroups(connGroupsEl, snapshot, options = {}) {
    if (!connGroupsEl) return false;
    const data = snapshot?.version === 2
        ? snapshot
        : normalizeLuckyConnVerdictSnapshot(snapshot || {});
    const groups = data.groups || [];

    const existingGroups = [...connGroupsEl.querySelectorAll('.emby-debug-lucky-ip-group')];
    if (!groups.length) {
        if (existingGroups.length > 0) return false;
        if (!connGroupsEl.querySelector('.emby-debug-lucky-conn-empty')) {
            connGroupsEl.insertAdjacentHTML(
                'beforeend',
                '<p class="emby-debug-lucky-conn-empty">暂无 Lucky 外网连接</p>',
            );
        }
        return true;
    }
    if (existingGroups.length !== groups.length) return false;

    for (let gi = 0; gi < groups.length; gi += 1) {
        const gEl = existingGroups[gi];
        const group = groups[gi];
        if (String(gEl.dataset.ip || '') !== String(group.ip || '')) return false;
        const rowEls = [...gEl.querySelectorAll('.emby-debug-lucky-verdict-row')];
        const rows = group.rows || [];
        if (rowEls.length !== rows.length) return false;
        for (let ri = 0; ri < rows.length; ri += 1) {
            const row = rows[ri];
            const rowEl = rowEls[ri];
            if (String(rowEl.dataset.remoteAddr || '') !== String(row.remoteAddr || '')) {
                return false;
            }
            patchLuckyConnDebugRowElement(rowEl, row, options);
        }
        const countEl = gEl.querySelector('.emby-debug-conn-group-count');
        if (countEl) countEl.textContent = String(rows.length);
        const summaryHost = gEl.querySelector('.emby-debug-lucky-ip-summary-row');
        const summaryEl = summaryHost?.querySelector('.emby-debug-lucky-ip-summary, .emby-debug-lucky-ip-summary--empty');
        if (summaryEl) {
            summaryEl.outerHTML = buildLuckyIpCollapsedSummary(group);
        }
    }
    refreshEmbyDebugTipIfAnchored();
    return true;
}

function updateLuckyConnDebugGroupsDom(connGroupsEl, snapshot, options = {}) {
    if (!connGroupsEl) return;
    if (tryPatchLuckyConnDebugGroups(connGroupsEl, snapshot, options)) {
        return;
    }
    const ipRevealed = !!options.ipRevealed;
    const openIps = new Set();
    const hadGroups = connGroupsEl.querySelectorAll('.emby-debug-lucky-ip-group').length > 0;
    connGroupsEl.querySelectorAll('.emby-debug-lucky-ip-group[open]').forEach((el) => {
        const ip = String(el.dataset.ip || '').trim();
        if (ip) openIps.add(ip);
    });
    connGroupsEl.innerHTML = buildLuckyConnDebugGroupsHtml(snapshot, {
        firstOpen: !hadGroups,
        allOpen: false,
        ipRevealed,
        instanceName: options.instanceName,
        tickSeconds: options.tickSeconds,
    });
    if (hadGroups) {
        connGroupsEl.querySelectorAll('.emby-debug-lucky-ip-group').forEach((el) => {
            const ip = String(el.dataset.ip || '').trim();
            el.open = openIps.has(ip);
        });
    }
}

function measureEmbyDebugLuckyFixedChrome(win) {
    const viewport = win?.querySelector?.('[data-field="lucky-conn-viewport"]');
    if (!viewport) return 280;
    const prevWinHeight = win.style.height;
    const prevWinMaxHeight = win.style.maxHeight;
    const prevViewportHeight = viewport.style.height;
    const prevViewportMinHeight = viewport.style.minHeight;
    const prevViewportFlex = viewport.style.flex;
    win.style.height = 'auto';
    win.style.maxHeight = 'none';
    viewport.style.height = '0px';
    viewport.style.minHeight = '0px';
    viewport.style.flex = '0 0 auto';
    const chrome = win.offsetHeight;
    win.style.height = prevWinHeight;
    win.style.maxHeight = prevWinMaxHeight;
    viewport.style.height = prevViewportHeight;
    viewport.style.minHeight = prevViewportMinHeight;
    viewport.style.flex = prevViewportFlex;
    return chrome;
}

function getEmbyDebugLuckyWindowHeightBounds(win) {
    const margin = 8;
    const chrome = measureEmbyDebugLuckyFixedChrome(win);
    const minHeight = Math.max(260, chrome + EMBY_DEBUG_LUCKY_CONN_MIN);
    const maxHeight = Math.max(minHeight, window.innerHeight - margin);
    return { chrome, minHeight, maxHeight };
}

function getEmbyDebugLuckyDefaultHeight(win) {
    const { minHeight, maxHeight } = getEmbyDebugLuckyWindowHeightBounds(win);
    const preferred = Math.round(window.innerHeight * EMBY_DEBUG_LUCKY_DEFAULT_VIEWPORT_RATIO);
    return Math.min(maxHeight, Math.max(minHeight, preferred));
}

function applyEmbyDebugLuckyWindowHeight(win, targetHeight, bounds = null) {
    if (!win || win.dataset.mode !== 'lucky') return null;
    const { minHeight, maxHeight } = bounds || getEmbyDebugLuckyWindowHeightBounds(win);
    const height = Math.min(maxHeight, Math.max(minHeight, targetHeight || minHeight));
    win.classList.add('emby-debug-float-window--lucky');
    win.style.height = `${height}px`;
    win.style.maxHeight = `${maxHeight}px`;
    const viewport = win.querySelector('[data-field="lucky-conn-viewport"]');
    if (viewport) {
        viewport.style.height = '';
        viewport.style.minHeight = '';
    }
    return height;
}

function resetEmbyDebugLuckyWindowHeight(win) {
    if (!win || win.dataset.mode !== 'lucky') return;
    applyEmbyDebugLuckyWindowHeight(win, getEmbyDebugLuckyDefaultHeight(win));
}

function bindEmbyDebugFloatWindowResize(win) {
    if (win.dataset.mode !== 'lucky') return;
    win.querySelectorAll('[data-resize-edge]').forEach((handle) => {
        if (handle.dataset.resizeBound === '1') return;
        handle.dataset.resizeBound = '1';
        const edge = String(handle.dataset.resizeEdge || 'bottom').trim().toLowerCase();
        let resizing = false;
        let startY = 0;
        let startHeight = 0;
        let startTop = 0;
        let startLeft = 0;
        let resizeBounds = null;

        const onPointerDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            resizing = true;
            startY = e.clientY;
            const rect = win.getBoundingClientRect();
            startHeight = rect.height;
            startTop = rect.top;
            startLeft = rect.left;
            resizeBounds = getEmbyDebugLuckyWindowHeightBounds(win);
            handle.setPointerCapture(e.pointerId);
            bringEmbyDebugFloatWindowToFront(win);
        };
        const onPointerMove = (e) => {
            if (!resizing) return;
            const deltaY = e.clientY - startY;
            if (edge === 'top') {
                const applied = applyEmbyDebugLuckyWindowHeight(
                    win,
                    startHeight - deltaY,
                    resizeBounds,
                );
                if (applied != null) {
                    const pos = clampEmbyDebugWindowPosition(
                        startLeft,
                        startTop + deltaY,
                        win.getBoundingClientRect().width,
                        applied,
                    );
                    win.style.left = `${pos.left}px`;
                    win.style.top = `${pos.top}px`;
                }
                return;
            }
            const applied = applyEmbyDebugLuckyWindowHeight(
                win,
                startHeight + deltaY,
                resizeBounds,
            );
            if (applied != null) {
                const rect = win.getBoundingClientRect();
                const pos = clampEmbyDebugWindowPosition(rect.left, rect.top, rect.width, applied);
                win.style.left = `${pos.left}px`;
                win.style.top = `${pos.top}px`;
            }
        };
        const onPointerUp = (e) => {
            if (!resizing) return;
            resizing = false;
            resizeBounds = null;
            try {
                handle.releasePointerCapture(e.pointerId);
            } catch (_) {
                /* ignore */
            }
            const rect = win.getBoundingClientRect();
            saveEmbyDebugWindowPosition(
                win.dataset.instance || '',
                rect.left,
                rect.top,
            );
        };
        handle.addEventListener('pointerdown', onPointerDown);
        handle.addEventListener('pointermove', onPointerMove);
        handle.addEventListener('pointerup', onPointerUp);
        handle.addEventListener('pointercancel', onPointerUp);
    });
}

function ensureEmbyDebugLuckyResizeHandles(win) {
    if (!win || win.dataset.mode !== 'lucky') return;
    const body = win.querySelector('[data-field="debug-body"]');
    if (!body) return;
    win.querySelector('[data-resize-edge="top"]')?.remove();
    if (!win.querySelector('[data-resize-edge="bottom"]')) {
        const bottom = document.createElement('div');
        bottom.className = 'emby-debug-float-resize emby-debug-float-resize--bottom';
        bottom.dataset.resizeEdge = 'bottom';
        bottom.setAttribute('aria-hidden', 'true');
        body.after(bottom);
    }
    win.querySelectorAll('[data-field="debug-resize-handle"]').forEach((legacy) => legacy.remove());
    bindEmbyDebugFloatWindowResize(win);
}

function getEmbyTrafficCollectMode(instanceName) {
    const name = String(instanceName || '').trim();
    if (!name) return '';
    const inst = (cachedEmbyInstances || []).find(i => i?.name === name);
    return resolveEmbyInstanceCollectMode(inst);
}

function isEmbyTrafficCollectEnabled(instanceName) {
    return !!getEmbyTrafficCollectMode(instanceName);
}

function getEmbyUploadTrafficLabel(instanceName) {
    return getEmbyTrafficCollectMode(instanceName) === 'lucky' ? '已上传' : '';
}

function buildEmbyTrafficDataHint(inst) {
    const mode = getEmbyTrafficCollectMode(inst?.name);
    if (mode !== 'lucky') {
        return '未开启流量采集';
    }
    return '按用户统计，不统计局域网流量';
}

function parseEmbyEndpointIp(remoteEndpoint) {
    const ep = String(remoteEndpoint || '').trim();
    if (!ep) return '';
    if (ep.startsWith('[')) {
        const end = ep.indexOf(']');
        if (end > 0) return ep.slice(1, end);
    }
    if ((ep.match(/\./g) || []).length === 3 && ep.includes(':')) {
        return ep.slice(0, ep.lastIndexOf(':'));
    }
    if (ep.includes(':') && !ep.includes('.')) return ep;
    return ep;
}

function isEmbyLanIp(ipStr) {
    const ip = String(ipStr || '').trim().replace(/^\[|\]$/g, '');
    if (!ip) return true;
    if (/^10\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    if (/^127\./.test(ip) || ip === '127.0.0.1') return true;
    if (/^169\.254\./.test(ip)) return true;
    if (/^0\./.test(ip)) return true;
    if (ip === '::1') return true;
    if (/^fe80:/i.test(ip)) return true;
    if (/^f[cd]/i.test(ip)) return true;
    return false;
}

function resolveEmbyEventRecordIsRemote(rec) {
    if (!rec) return false;
    if (typeof rec.is_remote === 'boolean') return rec.is_remote;
    const endpoint = rec.remote_endpoint || rec.client_ip || '';
    const ip = parseEmbyEndpointIp(endpoint);
    if (!ip) return false;
    return !isEmbyLanIp(ip);
}

function isEmbyEventExcludeLanEnabled() {
    return !!document.getElementById('embyEventExcludeLan')?.checked;
}

function filterEmbyEventRecordsExcludeLan(records) {
    if (!isEmbyEventExcludeLanEnabled()) return records || [];
    return (records || []).filter((rec) => resolveEmbyEventRecordIsRemote(rec));
}

function getLuckyTrafficBytesForSession(inst, session) {
    const traffic = inst?.lucky_ip_traffic;
    if (!traffic || typeof traffic !== 'object') return null;
    const endpoints = [session?.client_ip, session?.remote_endpoint].filter(Boolean);
    for (const endpoint of endpoints) {
        const ip = parseEmbyEndpointIp(endpoint);
        if (!ip) continue;
        const entry = traffic[ip];
        if (entry == null) continue;
        const raw = typeof entry === 'object' ? entry.out : entry;
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
}

function enrichEmbySessionLuckyTraffic(inst, session) {
    if (!inst || !session || getEmbyTrafficCollectMode(inst.name) !== 'lucky') return session;
    return session;
}

function isEmbyEstimateUploadEnabled(instanceName) {
    return isEmbyTrafficCollectEnabled(instanceName);
}

const EMBY_PLAYBACK_EVENT_TYPES = new Set([
    'VideoPlayback', 'VideoPlaybackStopped', 'VideoPlaybackPaused', 'VideoPlaybackUnpaused',
    'playback.start', 'playback.stop', 'playback.pause', 'playback.unpause',
    'video.playback.start', 'video.playback.stop', 'video.pause', 'video.unpause',
]);

const EMBY_EVENT_TYPE_MAP = {
    'VideoPlayback': '▶️ 开始播放',
    'VideoPlaybackStopped': '⏹ 停止播放',
    'VideoPlaybackPaused': '⏸ 暂停播放',
    'VideoPlaybackUnpaused': '▶️ 继续播放',
    'playback.start': '▶️ 开始播放',
    'playback.stop': '⏹ 停止播放',
    'playback.pause': '⏸ 暂停播放',
    'playback.unpause': '▶️ 继续播放',
    'video.playback.start': '▶️ 开始播放',
    'video.playback.stop': '⏹ 停止播放',
    'video.pause': '⏸ 暂停播放',
    'video.unpause': '▶️ 继续播放',
    'item.markplayed': '✅ 标记已看',
    'item.markunplayed': '↩️ 标记未看',
    'user.authentication.success': '🔐 登录成功',
    'user.authentication.failed': '⛔ 登录失败',
    'system.notification': '📢 系统通知',
    'session.start': '🔗 会话开始',
    'session.end': '🔌 会话结束',
};

function isEmbyPlaybackEvent(type) {
    if (!type) return false;
    if (EMBY_PLAYBACK_EVENT_TYPES.has(type)) return true;
    const slug = String(type).toLowerCase();
    return slug.includes('playback');
}

function embyEventMediaParts(event) {
    return {
        series: event?.series_name || '',
        label: event?.episode_label || '',
        main: event?.episode_title || event?.item_title || '',
        year: event?.production_year,
    };
}

function buildEmbyEventMediaSubHtml(text) {
    return `<span class="event-media-sub">&nbsp;·&nbsp; ${escapeHtml(String(text))}</span>`;
}

function buildEmbyEventMediaTitle(event) {
    const { series, label, main } = embyEventMediaParts(event);

    if (series && main) {
        return `${series} — ${main}`;
    }
    if (series) return series;
    if (main) return main;
    if (label) return label;
    if (event.playback_detail) return event.playback_detail;
    if (event.overview) return event.overview;
    if (event.name && !isGenericEmbyPlaybackName(event.name)) return event.name;
    return '';
}

function buildEmbyEventMediaEpisodeYearBadgesHtml(event) {
    const { label, year } = embyEventMediaParts(event);
    const badges = [];
    if (label) {
        badges.push(`<span class="emby-session-badge emby-event-badge--episode">${escapeHtml(label)}</span>`);
    }
    if (year) {
        badges.push(`<span class="emby-session-badge emby-event-badge--year">${escapeHtml(String(year))}</span>`);
    }
    if (!badges.length) return '';
    return `<span class="event-media-title-badges emby-event-leading-badges">${badges.join('')}</span>`;
}

function buildEmbyEventMediaTitleHtml(event) {
    const { series, label, main } = embyEventMediaParts(event);
    let html = '';

    if (series && main) {
        html = `${escapeHtml(series)} — ${escapeHtml(main)}`;
    } else if (series) {
        html = escapeHtml(series);
    } else if (main) {
        html = escapeHtml(main);
    } else if (label) {
        html = escapeHtml(label);
    } else if (event?.playback_detail) {
        html = escapeHtml(event.playback_detail);
    } else if (event?.overview) {
        html = escapeHtml(event.overview);
    } else if (event?.name && !isGenericEmbyPlaybackName(event.name)) {
        html = escapeHtml(event.name);
    }

    if (!html) return '';
    const badges = buildEmbyEventMediaEpisodeYearBadgesHtml(event);
    return badges
        ? `<span class="event-media-title-text">${html}</span>${badges}`
        : html;
}

function resolveEmbyPlaybackMediaEvent(stop, start = null) {
    const titleSource = buildEmbyEventMediaTitle(stop) ? stop : (start || stop);
    const merged = { ...titleSource };
    if (start) {
        merged.episode_label = stop.episode_label || start.episode_label || titleSource.episode_label;
        merged.production_year = stop.production_year ?? start.production_year ?? titleSource.production_year;
    }
    merged.estimated_upload_bytes = stop.estimated_upload_bytes;
    merged.is_remote = stop.is_remote;
    merged.type = stop.type;
    return merged;
}

function isGenericEmbyPlaybackName(name) {
    const text = String(name || '').trim();
    if (!text) return true;
    const generics = [
        '开始播放', '停止播放', '暂停播放', '继续播放',
        'Start Playing', 'Stopped Playing', 'Paused Playing', 'Resumed Playing',
    ];
    return generics.some(label => text === label || text.startsWith(`${label} `));
}

function resolveEmbyEventDeviceName(event) {
    const client = String(event?.client || '').trim();
    const device = String(event?.device_name || '').trim();
    if (client && device && client.toLowerCase() !== device.toLowerCase()) {
        return `${client} ${device}`;
    }
    return device || client;
}

function buildEmbyEventPlaybackMeta(event) {
    const parts = [
        event.user_name,
        resolveEmbyEventDeviceName(event),
        event.instance_name,
    ].filter(Boolean);
    return parts.map(part => escapeHtml(String(part))).join(' · ');
}

function sortEmbyInstances(list) {
    return [...(list || [])].sort((a, b) => {
        const pa = a.display_priority ?? 500;
        const pb = b.display_priority ?? 500;
        if (pa !== pb) return pa - pb;
        return String(a.name).localeCompare(String(b.name), 'zh-CN');
    });
}

function orderEmbyInstancesForContainer(instances, container) {
    if (container?.id === 'embyInstanceCardsMerge'
        && typeof getDeviceViewMode === 'function'
        && getDeviceViewMode() === 'merge') {
        return instances;
    }
    return sortEmbyInstances(instances);
}

function formatEmbyDuration(seconds) {
    const s = Math.max(0, parseInt(seconds, 10) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function embyPlayMethodLabel(method) {
    const map = {
        DirectPlay: '直接播放',
        DirectStream: '直接串流',
        Transcode: '转码',
    };
    return map[method] || method || '未知';
}

function embyPlayMethodBadgeClass(method) {
    if (method === 'DirectPlay') return 'emby-session-badge--direct';
    if (method === 'DirectStream') return 'emby-session-badge--stream';
    if (method === 'Transcode') return 'emby-session-badge--transcode';
    return 'emby-session-badge--paused';
}

function deriveEmbyEventTranscodeKind(event) {
    if (event.transcode_kind) return event.transcode_kind;
    const method = event.play_method || '';
    if (method === 'DirectPlay') return 'direct_play';
    if (method === 'DirectStream') return 'direct_stream';
    if (method !== 'Transcode') return '';
    if (event.is_video_direct === false && event.is_audio_direct !== false) return 'video_transcode';
    if (event.is_video_direct !== false && event.is_audio_direct === false) return 'audio_transcode';
    if (event.is_video_direct === false && event.is_audio_direct === false) return 'full_transcode';
    return 'full_transcode';
}

function embyTranscodeKindLabel(kind) {
    const map = {
        video_transcode: '视频转码',
        audio_transcode: '音频转码',
        full_transcode: '音视频转码',
        direct_play: '直接播放',
        direct_stream: '直接串流',
    };
    return map[kind] || '';
}

function embyTranscodeKindBadgeClass(kind) {
    if (kind === 'video_transcode') return 'emby-session-badge--video-transcode';
    if (kind === 'audio_transcode') return 'emby-session-badge--audio-transcode';
    if (kind === 'full_transcode') return 'emby-session-badge--transcode';
    if (kind === 'direct_play') return 'emby-session-badge--direct';
    if (kind === 'direct_stream') return 'emby-session-badge--stream';
    return 'emby-session-badge--transcode';
}

function resolveEmbyPlayBadge(session) {
    const kind = deriveEmbyEventTranscodeKind(session);
    if (kind) {
        return {
            label: embyTranscodeKindLabel(kind),
            badgeClass: embyTranscodeKindBadgeClass(kind),
        };
    }
    return {
        label: embyPlayMethodLabel(session.play_method),
        badgeClass: embyPlayMethodBadgeClass(session.play_method),
    };
}

function buildEmbySessionPlayBadgeHtml(session) {
    const { label, badgeClass } = resolveEmbyPlayBadge(session);
    if (!label) return '';
    return `<span class="emby-session-badge ${badgeClass}">${escapeHtml(label)}</span>`;
}

function formatEmbyResolution(width, height) {
    const w = parseInt(width, 10);
    const h = parseInt(height, 10);
    if (w > 0 && h > 0) return `${w}×${h}`;
    return '';
}

function formatEmbyKbps(bitrate) {
    const bps = parseInt(bitrate, 10) || 0;
    if (bps <= 0) return '';
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
    return `${Math.round(bps / 1000)} kbps`;
}

function buildEmbyMediaTitle(session) {
    const series = session.series_name || '';
    const label = session.episode_label || '';
    const main = session.title || '未知';
    if (series) {
        let html = `${escapeHtml(series)} — ${escapeHtml(main)}`;
        if (label) html += buildEmbyEventMediaSubHtml(label);
        return html;
    }
    return escapeHtml(main);
}

function buildEmbySessionBadgesHtml(session) {
    const badges = [];
    const playBadge = buildEmbySessionPlayBadgeHtml(session);
    if (playBadge) badges.push(playBadge);
    if (session.is_paused) {
        badges.push('<span class="emby-session-badge emby-session-badge--paused">已暂停</span>');
    }
    if (session.is_remote) {
        badges.push('<span class="emby-session-badge emby-session-badge--wan">外网</span>');
    } else {
        badges.push('<span class="emby-session-badge emby-session-badge--lan">局域网</span>');
    }
    return badges.join('');
}

function formatEmbyLiveUploadDebugText(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    return formatEmbyTrafficText(Math.floor(value));
}

function resolveEmbySessionDebugWindowSeconds(session, instanceName = '') {
    const sessionSeconds = parseInt(session?.estimated_upload_window_seconds_live, 10);
    if (Number.isFinite(sessionSeconds) && sessionSeconds > 0) {
        return Math.max(1, Math.min(60, sessionSeconds));
    }
    const name = String(instanceName || '').trim();
    if (name) {
        const inst = (cachedEmbyInstances || []).find(i => i?.name === name);
        const refreshSeconds = parseInt(inst?.refresh_interval, 10);
        if (Number.isFinite(refreshSeconds) && refreshSeconds > 0) {
            return Math.max(1, Math.min(60, refreshSeconds));
        }
    }
    return 1;
}

function resolveEmbySessionTrafficBytes(session, instanceName = '') {
    const liveTotalBytes = Math.max(0, parseInt(session?.estimated_upload_bytes_live, 10) || 0);
    const floorBytes = Math.max(
        Math.max(0, parseInt(session?.estimated_upload_bytes_floor, 10) || 0),
        Math.max(0, parseInt(session?.estimated_upload_bytes, 10) || 0),
        Math.max(0, parseInt(session?.live_upload_checkpoint_bytes, 10) || 0),
    );
    const liveWindowBytes = Math.max(0, parseInt(session?.estimated_upload_bytes_1s_live, 10) || 0);
    const windowSeconds = resolveEmbySessionDebugWindowSeconds(session, instanceName);
    return {
        liveTotalBytes: Math.max(liveTotalBytes, floorBytes),
        liveWindowBytes,
        windowSeconds,
    };
}

function shouldShowEmbySessionTrafficStats(session, instanceName = '') {
    if (!session?.is_remote) return false;
    const name = String(instanceName || session.instance_name || '').trim();
    return isEmbyEstimateUploadEnabled(name);
}

function buildEmbySessionTrafficStatsHtml(session, instanceName = '', options = {}) {
    const { extraClass = '' } = options;
    const includeWindow = options.includeWindow != null
        ? options.includeWindow
        : isEmbyDebugModeEnabled();
    if (!shouldShowEmbySessionTrafficStats(session, instanceName)) return '';
    const { liveTotalBytes, liveWindowBytes, windowSeconds } = resolveEmbySessionTrafficBytes(
        session,
        instanceName,
    );
    const totalText = formatEmbyLiveUploadDebugText(liveTotalBytes);
    const parts = [];
    if (includeWindow) {
        const windowText = formatEmbyLiveUploadDebugText(liveWindowBytes);
        parts.push(
            `<span class="emby-session-traffic-item">近${windowSeconds}秒新增 ${escapeHtml(windowText)}</span>`,
        );
    }
    parts.push(`<span class="emby-session-traffic-item">${escapeHtml(getEmbyUploadTrafficLabel(instanceName))} ${escapeHtml(totalText)}</span>`);
    const sep = '<span class="emby-session-traffic-sep" aria-hidden="true">·</span>';
    const classNames = ['emby-session-traffic-stats', extraClass].filter(Boolean).join(' ');
    return `<span class="${classNames}">${parts.join(sep)}</span>`;
}

function resolveEmbyUploadRestartHint(rec) {
    if (!rec) return null;
    const reason = String(rec?.settle_reason || '').trim();
    if (reason === 'restart_recovery') {
        if (rec.status === 'playing') return null;
        return {
            suffix: '（服务中断前）',
            title: '服务中断前的上传量，离线期间已换集，部分流量未统计。',
        };
    }
    if (rec.resumed_after_recovery) {
        return {
            suffix: '（续传）',
            title: '服务恢复后续传，离线期间未换集，流量已补录。',
        };
    }
    if (rec.started_after_recovery) {
        return {
            suffix: '（服务恢复后）',
            title: '服务恢复后的上传量，离线期间已换集，部分流量未统计。',
        };
    }
    return null;
}

function buildEmbyUploadTrafficBadgeHtml(instanceName, bytes, rec = null) {
    const text = formatEmbyEstimatedUpload(bytes);
    if (!text) return '';
    const label = getEmbyUploadTrafficLabel(instanceName);
    if (!label) return '';
    const hint = resolveEmbyUploadRestartHint(rec);
    const body = hint
        ? `${label} ${text}${hint.suffix}`
        : `${label} ${text}`;
    const titleAttr = hint?.title
        ? ` title="${escapeHtml(hint.title)}"`
        : '';
    return `<span class="emby-session-badge emby-event-badge--upload"${titleAttr}>${escapeHtml(body)}</span>`;
}

function buildEmbyPlaybackRecordTrafficHtml(rec) {
    if (rec?.status !== 'playing') return '';
    if (!shouldShowEmbySessionTrafficStats(rec, rec.instance_name)) return '';
    const { liveTotalBytes } = resolveEmbySessionTrafficBytes(rec, rec.instance_name);
    return buildEmbyUploadTrafficBadgeHtml(rec.instance_name, liveTotalBytes, rec);
}

/** @deprecated 保留别名，内部已改为常规展示 */
function buildEmbySessionUploadDebugHtml(session, instanceName = '') {
    return buildEmbySessionTrafficStatsHtml(session, instanceName);
}

const EMBY_SESSION_MESSAGE_TIMEOUT_MS = 8000;

function formatEmbySessionPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return '0.0';
    return Math.min(100, num).toFixed(1);
}

function getEmbySessionTimeText(positionSeconds, runtimeSeconds, progressPercent = null) {
    const runtime = parseInt(runtimeSeconds, 10) || 0;
    if (runtime <= 0) return '';
    const pos = Math.max(0, Math.min(parseInt(positionSeconds, 10) || 0, runtime));
    let pct = progressPercent;
    if (pct == null || Number.isNaN(Number(pct)) || pct < 0) {
        pct = (pos / runtime) * 100;
    }
    const pctText = formatEmbySessionPercent(pct);
    return `${formatEmbyDuration(pos)} / ${formatEmbyDuration(runtime)} (${pctText}%)`;
}

function getEmbySessionProgressPercent(positionSeconds, runtimeSeconds, progressPercent = null) {
    const runtime = parseInt(runtimeSeconds, 10) || 0;
    if (runtime <= 0) return 0;
    const pos = Math.max(0, Math.min(parseInt(positionSeconds, 10) || 0, runtime));
    if (progressPercent != null && !Number.isNaN(Number(progressPercent)) && progressPercent >= 0) {
        return parseFloat(formatEmbySessionPercent(progressPercent));
    }
    return parseFloat(formatEmbySessionPercent((pos / runtime) * 100));
}

function buildEmbySessionCtrlIcon(name) {
    const icons = {
        pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3" width="3" height="10" rx="0.75" fill="currentColor"/><rect x="9.5" y="3" width="3" height="10" rx="0.75" fill="currentColor"/></svg>',
        play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3.2c0-.9 1-.4 1-.4l7.2 4.3c.7.4.7 1.3 0 1.7L5.5 12.8s-1 .5-1-.4V3.2z" fill="currentColor"/></svg>',
        stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/></svg>',
        message: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6l-3 2.2V4.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    };
    return icons[name] || '';
}

function buildEmbySessionControlsHtml(session) {
    const paused = !!session.is_paused;
    const toggleLabel = paused ? '继续播放' : '暂停播放';
    const toggleIcon = paused ? 'play' : 'pause';
    return `<div class="emby-session-controls">
        <button type="button" class="emby-session-ctrl" data-action="toggle-pause" aria-label="${toggleLabel}" title="${toggleLabel}">${buildEmbySessionCtrlIcon(toggleIcon)}</button>
        <button type="button" class="emby-session-ctrl" data-action="stop" aria-label="停止播放" title="停止播放">${buildEmbySessionCtrlIcon('stop')}</button>
        <button type="button" class="emby-session-ctrl" data-action="message" aria-label="发送消息" title="发送消息">${buildEmbySessionCtrlIcon('message')}</button>
    </div>`;
}

function buildEmbySessionCompactFooterHtml(session, instanceName = '') {
    const runtime = parseInt(session.runtime_seconds, 10) || 0;
    if (runtime <= 0) return '';
    let progressBlock = '';
    let footerRow = '';
    if (runtime > 0) {
        const pos = parseInt(session.position_seconds, 10) || 0;
        const pct = getEmbySessionProgressPercent(pos, runtime, session.progress_percent);
        const timeText = getEmbySessionTimeText(pos, runtime, pct);
        progressBlock = `<div class="emby-session-progress">
            <div class="emby-session-progress-bar">
                <div class="emby-session-progress-fill" style="width:${pct}%"></div>
            </div>
        </div>`;
        footerRow = `<div class="emby-session-footer-row">
            ${buildEmbySessionControlsHtml(session)}
            <div class="emby-session-time" data-position="${pos}" data-runtime="${runtime}" data-pct="${pct}" data-paused="${session.is_paused ? '1' : '0'}" data-synced="${Date.now()}">${escapeHtml(timeText)}</div>
        </div>`;
    }
    return `<div class="emby-session-footer">
        ${progressBlock}
        ${footerRow}
    </div>`;
}

function applyEmbySessionTimeEl(el, session) {
    if (!el) return;
    const runtime = parseInt(session.runtime_seconds, 10) || 0;
    if (runtime <= 0) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    const pos = parseInt(session.position_seconds, 10) || 0;
    const pct = getEmbySessionProgressPercent(pos, runtime, session.progress_percent);
    el.dataset.position = String(pos);
    el.dataset.runtime = String(runtime);
    el.dataset.pct = String(pct);
    el.dataset.paused = session.is_paused ? '1' : '0';
    el.dataset.synced = String(Date.now());
    el.textContent = getEmbySessionTimeText(pos, runtime, pct);

    const footer = el.closest('.emby-session-footer');
    const fill = footer?.querySelector('.emby-session-progress-fill');
    if (fill) fill.style.width = `${pct}%`;

    const pauseBtn = footer?.querySelector('.emby-session-ctrl[data-action="toggle-pause"]');
    if (pauseBtn) {
        const paused = !!session.is_paused;
        pauseBtn.setAttribute('aria-label', paused ? '继续播放' : '暂停播放');
        pauseBtn.setAttribute('title', paused ? '继续播放' : '暂停播放');
        const icon = paused ? 'play' : 'pause';
        const nextIcon = buildEmbySessionCtrlIcon(icon);
        if (pauseBtn.innerHTML !== nextIcon) pauseBtn.innerHTML = nextIcon;
    }
}

function applyEmbySessionFooterEl(el, session, instanceName = '') {
    if (!el) return;
    el.querySelector('.emby-session-traffic-stats')?.remove();
    applyEmbySessionTimeEl(el.querySelector('.emby-session-time'), session);
}

let embySessionTimeTicker = null;

function tickEmbySessionTimes() {
    const els = document.querySelectorAll('.emby-session-time');
    if (!els.length) {
        if (embySessionTimeTicker) {
            clearInterval(embySessionTimeTicker);
            embySessionTimeTicker = null;
        }
        return;
    }
    const now = Date.now();
    els.forEach(el => {
        const runtime = parseInt(el.dataset.runtime, 10) || 0;
        if (runtime <= 0) return;
        let position = parseInt(el.dataset.position, 10) || 0;
        if (el.dataset.paused !== '1') {
            const synced = parseInt(el.dataset.synced, 10) || now;
            const elapsed = Math.floor((now - synced) / 1000);
            position = Math.min(runtime, position + elapsed);
        }
        const pct = getEmbySessionProgressPercent(position, runtime);
        el.dataset.pct = String(pct);
        el.textContent = getEmbySessionTimeText(position, runtime, pct);
        const fill = el.closest('.emby-session-footer')?.querySelector('.emby-session-progress-fill')
            || el.closest('.emby-session-progress')?.querySelector('.emby-session-progress-fill');
        if (fill) fill.style.width = `${pct}%`;
    });
}

function ensureEmbySessionTimeTicker() {
    if (!document.querySelector('.emby-session-time')) return;
    if (embySessionTimeTicker) return;
    embySessionTimeTicker = setInterval(tickEmbySessionTimes, 1000);
}

let embyLogPlayingTicker = null;

function getEmbyPlayingWatchMetaText(runtime, startPos, position) {
    const runtimeSec = parseInt(runtime, 10) || 0;
    if (runtimeSec <= 0) return '';
    const start = Math.max(0, parseInt(startPos, 10) || 0);
    const pos = Math.max(0, Math.min(parseInt(position, 10) || 0, runtimeSec));
    const remaining = Math.max(0, runtimeSec - pos);
    return `影片时长${formatEmbyDuration(runtimeSec)} | ${formatEmbyDuration(start)} - ${formatEmbyDuration(pos)} | 剩余${formatEmbyDuration(remaining)}`;
}

function applyEmbyLogPlayingWatchEl(watchEl, event) {
    if (!watchEl) return;
    const runtime = parseInt(event.runtime_seconds, 10) || 0;
    if (runtime <= 0) {
        watchEl.hidden = true;
        return;
    }
    const startPosRaw = parseInt(event.start_position_seconds, 10);
    const startPos = Number.isNaN(startPosRaw) ? 0 : Math.max(0, startPosRaw);
    const currentPos = resolveEmbyContentPosition(event);
    if (currentPos == null || currentPos < 0) {
        watchEl.hidden = true;
        return;
    }
    watchEl.hidden = false;
    watchEl.dataset.runtime = String(runtime);
    watchEl.dataset.startPos = String(startPos);
    watchEl.dataset.position = String(currentPos);
    watchEl.dataset.paused = event.is_paused ? '1' : '0';
    watchEl.dataset.synced = String(Date.now());
    watchEl.textContent = getEmbyPlayingWatchMetaText(runtime, startPos, currentPos);

    const card = watchEl.closest('.emby-log-card');
    if (!card) return;
    const rangeStart = Math.min(startPos, currentPos);
    const rangeEnd = Math.max(startPos, currentPos);
    syncEmbyLogCardProgressStyle(card, {
        startPct: Math.min(100, parseFloat(formatEmbySessionPercent((rangeStart / runtime) * 100))),
        endPct: Math.min(100, parseFloat(formatEmbySessionPercent((rangeEnd / runtime) * 100))),
    });
}

function tickEmbyLogPlayingCards() {
    const cards = document.querySelectorAll('.emby-log-card--playing, .emby-log-card--paused');
    if (!cards.length) {
        if (embyLogPlayingTicker) {
            clearInterval(embyLogPlayingTicker);
            embyLogPlayingTicker = null;
        }
        return;
    }
    syncPlaybackRecordsSeekFromLive();
    const now = Date.now();
    cards.forEach((card) => {
        const watchEl = card.querySelector('.emby-log-play-watch');
        if (watchEl && !watchEl.hidden) {
            const runtime = parseInt(watchEl.dataset.runtime, 10) || 0;
            if (runtime > 0) {
                let position = parseInt(watchEl.dataset.position, 10) || 0;
                if (watchEl.dataset.paused !== '1') {
                    const synced = parseInt(watchEl.dataset.synced, 10) || now;
                    const elapsed = Math.floor((now - synced) / 1000);
                    position = Math.min(runtime, position + elapsed);
                }
                const startPos = parseInt(watchEl.dataset.startPos, 10) || 0;
                const rangeStart = Math.min(startPos, position);
                const rangeEnd = Math.max(startPos, position);
                syncEmbyLogCardProgressStyle(card, {
                    startPct: Math.min(100, parseFloat(formatEmbySessionPercent((rangeStart / runtime) * 100))),
                    endPct: Math.min(100, parseFloat(formatEmbySessionPercent((rangeEnd / runtime) * 100))),
                });
                watchEl.textContent = getEmbyPlayingWatchMetaText(runtime, startPos, position);
            }
        }

        const recordId = String(card.dataset.recordId || '').trim();
        if (!recordId) return;
        const rec = _lastPlaybackRecords.find((item) => String(item.id || '') === recordId);
        if (!rec || rec.status !== 'playing') return;
        const viewRec = mergeLiveSessionIntoPlaybackRecord(rec);
        patchEmbyLogCardSeekBadge(card, playbackRecordAsEvent(viewRec));
    });
}

function ensureEmbyLogPlayingTicker() {
    const hasPlaying = document.querySelector('.emby-log-card--playing, .emby-log-card--paused');
    if (!hasPlaying) {
        if (embyLogPlayingTicker) {
            clearInterval(embyLogPlayingTicker);
            embyLogPlayingTicker = null;
        }
        return;
    }
    if (embyLogPlayingTicker) return;
    embyLogPlayingTicker = setInterval(tickEmbyLogPlayingCards, 1000);
    tickEmbyLogPlayingCards();
}

function patchEmbySessionItemElement(el, session, instanceName) {
    const titleEl = el.querySelector('.emby-session-head strong');
    if (titleEl) {
        const newTitle = buildEmbyMediaTitle(session);
        if (titleEl.innerHTML !== newTitle) titleEl.innerHTML = newTitle;
    }
    const badgesEl = el.querySelector('.emby-session-badges');
    if (badgesEl) {
        const badgesHtml = buildEmbySessionBadgesHtml(session);
        if (badgesEl.innerHTML !== badgesHtml) badgesEl.innerHTML = badgesHtml;
    }
    const metaRowHtml = buildEmbySessionMetaRowHtml(session, instanceName);
    let metaRowEl = el.querySelector('.emby-session-meta-row');
    const revealedIp = captureEmbyIpRevealIp(metaRowEl);
    if (metaRowEl) {
        if (metaRowEl.outerHTML !== metaRowHtml) {
            metaRowEl.outerHTML = metaRowHtml;
            metaRowEl = el.querySelector('.emby-session-meta-row');
            restoreEmbyIpRevealState(metaRowEl, revealedIp);
        }
    } else {
        const legacyMetaEl = el.querySelector(':scope > .emby-session-meta');
        if (legacyMetaEl) {
            legacyMetaEl.outerHTML = metaRowHtml;
        }
    }
    el.querySelector('.emby-session-debug')?.remove();
    const oldStandaloneTime = el.querySelector(':scope > .emby-session-time');
    if (oldStandaloneTime) oldStandaloneTime.remove();
    const footerEl = el.querySelector('.emby-session-footer');
    const footerHtml = buildEmbySessionCompactFooterHtml(session, instanceName);
    if (footerEl) {
        applyEmbySessionFooterEl(footerEl, session, instanceName);
    } else if (footerHtml) {
        el.insertAdjacentHTML('beforeend', footerHtml);
    }
    el.dataset.instance = instanceName || '';
    el.dataset.sessionId = session.id || '';
}

function normalizeEmbySessionId(id) {
    return String(id || '').trim();
}

function sortEmbySessionsByPlaybackStart(sessions) {
    return (sessions || []).slice().sort((a, b) => {
        const ta = String(a?.playback_started_at || '').trim();
        const tb = String(b?.playback_started_at || '').trim();
        if (ta !== tb) {
            if (!ta) return 1;
            if (!tb) return -1;
            return ta.localeCompare(tb);
        }
        return normalizeEmbySessionId(a?.id).localeCompare(
            normalizeEmbySessionId(b?.id),
            undefined,
            { numeric: true },
        );
    });
}

function patchEmbySessionsList(sessionsEl, activeSessions, instanceName) {
    if (!sessionsEl) return;
    const existingById = new Map(
        [...sessionsEl.querySelectorAll('.emby-session-item')].map(el => [el.dataset.sessionId, el]),
    );
    const nextIds = activeSessions.map(s => normalizeEmbySessionId(s.id));

    existingById.forEach((el, id) => {
        if (!nextIds.includes(id)) el.remove();
    });

    activeSessions.forEach((session, index) => {
        const sid = normalizeEmbySessionId(session.id);
        let item = existingById.get(sid);
        if (!item) {
            const wrap = document.createElement('div');
            wrap.innerHTML = buildEmbySessionItemHtml(session, instanceName, true);
            item = wrap.firstElementChild;
            sessionsEl.appendChild(item);
        } else {
            patchEmbySessionItemElement(item, session, instanceName);
        }
        const anchor = sessionsEl.children[index];
        if (anchor !== item) {
            sessionsEl.insertBefore(item, anchor || null);
        }
    });

    ensureEmbySessionTimeTicker();
}

function buildEmbySessionProgressHtml(session) {
    const pct = session.progress_percent;
    if (pct == null || pct < 0) return '';
    const timeText = getEmbySessionTimeText(
        session.position_seconds,
        session.runtime_seconds,
        session.progress_percent,
    );
    return `
        <div class="emby-session-progress">
            <div class="emby-session-progress-bar">
                <div class="emby-session-progress-fill" style="width:${Math.min(100, pct)}%"></div>
            </div>
            <div class="emby-session-progress-meta">
                <span>${escapeHtml(timeText)}</span>
            </div>
        </div>`;
}

function buildEmbySessionMetaLine(session) {
    const segments = [];
    if (session.user_name) segments.push(escapeHtml(String(session.user_name)));
    const ipHtml = buildEmbySessionNetworkIpHtml(session);
    if (ipHtml) segments.push(ipHtml);
    if (session.device_name) segments.push(escapeHtml(String(session.device_name)));
    const bitrate = formatEmbyKbps(session.bitrate);
    if (bitrate) segments.push(escapeHtml(String(bitrate)));
    const codecs = [session.video_codec, session.audio_codec].filter(Boolean).join(' / ');
    if (codecs) segments.push(escapeHtml(codecs));
    const res = formatEmbyResolution(session.width, session.height);
    if (res) segments.push(escapeHtml(res));
    return segments.join(' · ');
}

function buildEmbySessionMetaRowHtml(session, instanceName = '') {
    const inst = (cachedEmbyInstances || []).find(i => i.name === instanceName);
    const viewSession = inst ? enrichEmbySessionLuckyTraffic(inst, session) : session;
    const trafficHtml = buildEmbySessionTrafficStatsHtml(viewSession, instanceName);
    const metaText = buildEmbySessionMetaLine(viewSession);
    return `<div class="emby-session-meta-row">${metaText}${trafficHtml}</div>`;
}

function buildEmbySessionItemHtml(session, instanceName, compact = false) {
    const sessionId = escapeHtml(session.id || '');
    const instName = escapeHtml(instanceName || '');
    return `
        <div class="emby-session-item emby-session-item--clickable"
             data-instance="${instName}" data-session-id="${sessionId}" role="button" tabindex="0">
            <div class="emby-session-head">
                <div><strong>${buildEmbyMediaTitle(session)}</strong></div>
                <div class="emby-session-badges">${buildEmbySessionBadgesHtml(session)}</div>
            </div>
            ${buildEmbySessionMetaRowHtml(session, instanceName)}
            ${compact ? buildEmbySessionCompactFooterHtml(session, instanceName) : buildEmbySessionProgressHtml(session)}
        </div>`;
}

function buildEmbySessionDetailHtml(session, instanceName) {
    const transcodeReasons = (session.transcode_reasons || []).join(', ');
    const items = [
        ['设备', instanceName],
        ['用户', session.user_name],
        ['客户端', [session.client, session.device_name].filter(Boolean).join(' / ')],
        ['设备类型', session.device_type],
        ['客户端版本', session.application_version],
        ['远程地址', session.remote_endpoint || '本地'],
        ['协议', session.protocol],
        ['播放方式', resolveEmbyPlayBadge(session).label],
        ['状态', session.is_paused ? '已暂停' : '播放中'],
        ['进度', session.progress_percent != null
            ? getEmbySessionTimeText(
                session.position_seconds,
                session.runtime_seconds,
                session.progress_percent,
            )
            : ''],
        ['码率', formatEmbyKbps(session.bitrate)],
        ['视频码率', formatEmbyKbps(session.video_bitrate)],
        ['音频码率', formatEmbyKbps(session.audio_bitrate)],
        ['视频编码', session.video_codec],
        ['音频编码', session.audio_codec],
        ['容器', session.container],
        ['分辨率', formatEmbyResolution(session.width, session.height)],
        ['帧率', session.framerate ? `${session.framerate} fps` : ''],
        ['音频声道', session.audio_channels],
        ['年份', session.production_year],
        ['分级', session.official_rating],
        ['视频解码', session.video_decoder],
        ['视频编码器', session.video_encoder],
        ['硬件编码', session.video_encoder_is_hardware ? '是' : (session.video_encoder ? '否' : '')],
        ['转码原因', transcodeReasons],
        ['CPU 使用', session.current_cpu != null ? `${Math.round(session.current_cpu)}%` : ''],
        ['平均 CPU', session.average_cpu != null ? `${Math.round(session.average_cpu)}%` : ''],
        ['最后活动', (session.last_activity_date || '').replace('T', ' ').slice(0, 19)],
    ].filter(([, v]) => v !== '' && v != null);

    return `
        <div class="emby-session-detail">
            <div class="emby-session-head" style="margin-bottom:8px">
                <h3 style="font-size:16px;margin:0">${buildEmbyMediaTitle(session)}</h3>
                <div class="emby-session-badges">${buildEmbySessionBadgesHtml(session)}</div>
            </div>
            ${buildEmbySessionProgressHtml(session)}
            <dl class="emby-session-detail-grid">
                ${items.map(([k, v]) => `
                    <div class="emby-session-detail-item">
                        <dt>${escapeHtml(k)}</dt>
                        <dd>${escapeHtml(String(v))}</dd>
                    </div>`).join('')}
            </dl>
        </div>`;
}

function findEmbySession(instanceName, sessionId) {
    const inst = cachedEmbyInstances.find(i => i.name === instanceName);
    if (!inst) return null;
    return (inst.sessions || []).find(s => s.id === sessionId) || null;
}

let _pendingEmbySessionControl = null;
let _pendingEmbySessionMessage = null;

function embySessionControlUrl(instanceName, sessionId, suffix) {
    const inst = encodeURIComponent(instanceName || '');
    const sid = encodeURIComponent(sessionId || '');
    return `/api/emby/sessions/${inst}/${sid}${suffix}`;
}

async function postEmbySessionControl(instanceName, sessionId, suffix, body = null) {
    const url = embySessionControlUrl(instanceName, sessionId, suffix);
    return axios.post(url, body);
}

async function refreshEmbySessionsAfterControl(silent = true) {
    if (typeof refreshEmbyLiveMetrics === 'function') {
        await refreshEmbyLiveMetrics(silent);
        return;
    }
    if (typeof refreshEmbyStatus === 'function') {
        await refreshEmbyStatus(false, silent);
    }
}

async function handleEmbySessionTogglePause(instanceName, sessionId, button) {
    const session = findEmbySession(instanceName, sessionId);
    if (!session) {
        if (typeof showToast === 'function') showToast('会话已结束或不存在', 'info');
        return;
    }
    const command = session.is_paused ? 'unpause' : 'pause';
    if (button) button.disabled = true;
    try {
        const res = await postEmbySessionControl(instanceName, sessionId, `/playing/${command}`);
        if (res.data.success) {
            if (typeof showToast === 'function') showToast(command === 'pause' ? '已暂停' : '已继续播放', 'success');
            await refreshEmbySessionsAfterControl();
        } else if (typeof showToast === 'function') {
            showToast(res.data.error || '操作失败', 'error');
        }
    } catch (e) {
        if (typeof showToast === 'function') {
            showToast(e.response?.data?.error || '操作失败', 'error');
        }
    } finally {
        if (button) button.disabled = false;
    }
}

function confirmEmbySessionStop(instanceName, sessionId) {
    const session = findEmbySession(instanceName, sessionId);
    if (!session) {
        if (typeof showToast === 'function') showToast('会话已结束或不存在', 'info');
        return;
    }
    _pendingEmbySessionControl = { instanceName, sessionId, action: 'stop' };
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        if (typeof showToast === 'function') showToast('确认弹窗加载失败，请刷新页面后重试', 'error');
        return;
    }
    const userLabel = session.user_name || '该用户';
    const titleLabel = session.series_name
        ? `${session.series_name} — ${session.episode_title || session.title || ''}`
        : (session.title || '当前内容');
    document.getElementById('confirmModalTitle').textContent = '停止播放';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm">
            <p class="confirm-message">确认停止 <span class="confirm-restore-name">${escapeHtml(userLabel)}</span> 的播放吗？</p>
            <p class="form-hint">${escapeHtml(titleLabel)}</p>
            <div class="modal-actions">
                <button type="button" class="btn-danger" id="confirmEmbySessionStopBtn">停止播放</button>
                <button type="button" class="btn-secondary" id="cancelEmbySessionStopBtn">取消</button>
            </div>
        </div>`;
    document.getElementById('confirmEmbySessionStopBtn').onclick = () => {
        doEmbySessionStop(instanceName, sessionId);
    };
    document.getElementById('cancelEmbySessionStopBtn').onclick = () => {
        _pendingEmbySessionControl = null;
        if (typeof closeConfirmModal === 'function') closeConfirmModal();
    };
    modal.style.display = 'block';
}

async function doEmbySessionStop(instanceName, sessionId) {
    const confirmBtn = document.getElementById('confirmEmbySessionStopBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '停止中…';
    }
    try {
        const res = await postEmbySessionControl(instanceName, sessionId, '/playing/stop');
        if (res.data.success) {
            if (typeof showToast === 'function') showToast('已停止播放', 'success');
            if (typeof closeConfirmModal === 'function') closeConfirmModal();
            await refreshEmbySessionsAfterControl();
        } else if (typeof showToast === 'function') {
            showToast(res.data.error || '停止失败', 'error');
        }
    } catch (e) {
        if (typeof showToast === 'function') {
            showToast(e.response?.data?.error || '停止失败', 'error');
        }
    } finally {
        _pendingEmbySessionControl = null;
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '停止播放';
        }
    }
}

function openEmbySessionMessageModal(instanceName, sessionId) {
    const session = findEmbySession(instanceName, sessionId);
    if (!session) {
        if (typeof showToast === 'function') showToast('会话已结束或不存在', 'info');
        return;
    }
    _pendingEmbySessionMessage = { instanceName, sessionId };
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        if (typeof showToast === 'function') showToast('弹窗加载失败，请刷新页面后重试', 'error');
        return;
    }
    const userLabel = session.user_name || '该用户';
    const titleLabel = session.series_name
        ? `${session.series_name} — ${session.episode_title || session.title || ''}`
        : (session.title || '当前内容');
    document.getElementById('confirmModalTitle').textContent = '发送消息';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm emby-session-message-modal">
            <p class="confirm-message">向 <span class="confirm-restore-name">${escapeHtml(userLabel)}</span> 的客户端发送消息</p>
            <p class="form-hint">${escapeHtml(titleLabel)}</p>
            <label class="emby-session-message-modal-field">
                <span class="emby-session-message-modal-label">消息内容</span>
                <textarea id="embySessionMessageInput" class="emby-session-message-modal-input" rows="3" maxlength="500" placeholder="输入要显示在客户端的消息" enterkeyhint="send" autocomplete="off"></textarea>
            </label>
            <div class="modal-actions">
                <button type="button" class="btn-primary" id="confirmEmbySessionMessageBtn">发送</button>
                <button type="button" class="btn-secondary" id="cancelEmbySessionMessageBtn">取消</button>
            </div>
        </div>`;
    const input = document.getElementById('embySessionMessageInput');
    const sendBtn = document.getElementById('confirmEmbySessionMessageBtn');
    const cancelBtn = document.getElementById('cancelEmbySessionMessageBtn');
    const submit = () => {
        if (!sendBtn || sendBtn.disabled) return;
        sendEmbySessionMessage(instanceName, sessionId, input?.value, sendBtn);
    };
    sendBtn.onclick = submit;
    cancelBtn.onclick = () => {
        _pendingEmbySessionMessage = null;
        if (typeof closeConfirmModal === 'function') closeConfirmModal();
    };
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    });
    modal.style.display = 'block';
    requestAnimationFrame(() => {
        setTimeout(() => input?.focus(), 80);
    });
}

async function sendEmbySessionMessage(instanceName, sessionId, text, button = null) {
    const message = String(text || '').trim();
    if (!message) {
        if (typeof showToast === 'function') showToast('请输入消息内容', 'error');
        return;
    }
    if (button) {
        button.disabled = true;
        button.textContent = '发送中…';
    }
    try {
        const res = await postEmbySessionControl(instanceName, sessionId, '/message', {
            text: message,
            timeout_ms: EMBY_SESSION_MESSAGE_TIMEOUT_MS,
        });
        if (res.data.success) {
            if (typeof showToast === 'function') showToast('消息已发送', 'success');
            _pendingEmbySessionMessage = null;
            if (typeof closeConfirmModal === 'function') closeConfirmModal();
        } else if (typeof showToast === 'function') {
            showToast(res.data.error || '发送失败', 'error');
        }
    } catch (e) {
        if (typeof showToast === 'function') {
            showToast(e.response?.data?.error || '发送失败', 'error');
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = '发送';
        }
    }
}

function handleEmbySessionControlClick(button) {
    const item = button.closest('.emby-session-item');
    if (!item) return;
    const instanceName = item.dataset.instance || '';
    const sessionId = item.dataset.sessionId || '';
    if (!instanceName || !sessionId) return;
    const action = button.dataset.action || '';
    if (action === 'toggle-pause') {
        handleEmbySessionTogglePause(instanceName, sessionId, button);
        return;
    }
    if (action === 'stop') {
        confirmEmbySessionStop(instanceName, sessionId);
        return;
    }
    if (action === 'message') {
        openEmbySessionMessageModal(instanceName, sessionId);
    }
}

function openEmbySessionDetail(instanceName, sessionId) {
    const session = findEmbySession(instanceName, sessionId);
    if (!session) {
        if (typeof showToast === 'function') showToast('会话已结束或不存在', 'info');
        return;
    }
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!body || !title) return;
    title.textContent = `▶ 播放会话 · ${instanceName}`;
    body.innerHTML = buildEmbySessionDetailHtml(session, instanceName);
    if (typeof showControlModal === 'function') showControlModal();
    else document.getElementById('controlModal').style.display = 'block';
}

function getEmbyActivePlaybackSessions(inst) {
    const filtered = (inst?.sessions || []).filter(s => s.is_playing);
    return sortEmbySessionsByPlaybackStart(filtered);
}

function normalizeEmbyTab(tab) {
    if (tab === 'sessions') return 'events';
    return VALID_EMBY_TABS.has(tab) ? tab : 'devices';
}

function updateEmbyHeaderStats(instances) {
    if (typeof isEmbyFeatureEnabled === 'function' && !isEmbyFeatureEnabled()) {
        return;
    }
    const list = instances || cachedEmbyInstances || [];
    const total = list.length;
    const online = list.filter(i => i.api_online).length;
    let lanPlay = 0;
    let wanPlay = 0;
    list.forEach(inst => {
        (inst.sessions || []).forEach(session => {
            if (!session.is_playing) return;
            if (session.is_remote) wanPlay += 1;
            else lanPlay += 1;
        });
    });
    const totalEl = document.getElementById('statEmbyTotal');
    const onlineEl = document.getElementById('statEmbyOnline');
    const lanEl = document.getElementById('statEmbyLanPlay');
    const wanEl = document.getElementById('statEmbyWanPlay');
    if (totalEl) totalEl.textContent = total;
    if (onlineEl) onlineEl.textContent = online;
    if (lanEl) lanEl.textContent = lanPlay;
    if (wanEl) wanEl.textContent = wanPlay;
}

let embySeekBadgeOpenWrap = null;
let embyLogPopoverHoverWrap = null;

const EMBY_LOG_TAP_POPOVER_SELECTOR = '.emby-seek-badge-wrap, .emby-transcode-badge-wrap';

// 卡片内弹层用 fixed 定位，按徽标位置计算坐标并夹取到视口内，
// 从而脱离 .events-list 等 overflow 滚动祖先，不再被卡片/列表裁切。
function positionEmbyLogPopover(wrap) {
    if (!wrap) return;
    const popover = wrap.querySelector('.status-badge-popover');
    if (!popover) return;
    const badgeRect = wrap.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = badgeRect.left + badgeRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, vw - popRect.width - margin));
    let top = badgeRect.bottom + gap;
    if (top + popRect.height > vh - margin && badgeRect.top - popRect.height - gap >= margin) {
        top = badgeRect.top - popRect.height - gap;
    }
    top = Math.max(margin, Math.min(top, vh - popRect.height - margin));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
}

function closeEmbySeekBadgePopover() {
    if (!embySeekBadgeOpenWrap) return;
    embySeekBadgeOpenWrap.classList.remove('is-open');
    embySeekBadgeOpenWrap = null;
}

function toggleEmbyLogPopover(wrap) {
    const wasOpen = wrap.classList.contains('is-open');
    closeEmbySeekBadgePopover();
    if (!wasOpen) {
        wrap.classList.add('is-open');
        embySeekBadgeOpenWrap = wrap;
        positionEmbyLogPopover(wrap);
    }
}

function setupEmbySeekBadgePopover() {
    if (setupEmbySeekBadgePopover._bound) return;
    setupEmbySeekBadgePopover._bound = true;

    // 悬停（细指针设备）时定位弹层并记录当前悬停项，供滚动/缩放时重新定位
    document.addEventListener('mouseover', (e) => {
        const wrap = e.target.closest(EMBY_LOG_TAP_POPOVER_SELECTOR);
        if (wrap === embyLogPopoverHoverWrap) return;
        embyLogPopoverHoverWrap = wrap || null;
        if (wrap) positionEmbyLogPopover(wrap);
    });

    // 点击开/关（桌面与移动端一致）：再次点击或点击别处关闭
    document.addEventListener('click', (e) => {
        const wrap = e.target.closest(EMBY_LOG_TAP_POPOVER_SELECTOR);
        if (wrap) {
            e.preventDefault();
            e.stopPropagation();
            toggleEmbyLogPopover(wrap);
            return;
        }
        if (embySeekBadgeOpenWrap && !embySeekBadgeOpenWrap.contains(e.target)) {
            closeEmbySeekBadgePopover();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeEmbySeekBadgePopover();
            return;
        }
        const wrap = e.target.closest(EMBY_LOG_TAP_POPOVER_SELECTOR);
        if (!wrap || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        toggleEmbyLogPopover(wrap);
    });

    const reposition = () => {
        const wrap = embySeekBadgeOpenWrap || embyLogPopoverHoverWrap;
        if (wrap && document.contains(wrap)) positionEmbyLogPopover(wrap);
    };
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
}

function initEmby() {
    if (typeof getChartPlatform === 'function' && getChartPlatform() === 'emby') {
        if (typeof syncChartInstanceSelectForPlatform === 'function') {
            syncChartInstanceSelectForPlatform();
        }
    }
    document.addEventListener('click', (e) => {
        const luckyIpBtn = e.target.closest('.emby-debug-lucky-ip-panel-toggle');
        if (luckyIpBtn) {
            e.preventDefault();
            e.stopPropagation();
            const panel = luckyIpBtn.closest('.emby-debug-float-window--lucky');
            if (panel) applyLuckyDebugIpRevealState(panel, !isLuckyDebugIpRevealed(panel));
            return;
        }
        const ipBtn = e.target.closest('.emby-event-ip-toggle');
        if (ipBtn?.closest('.emby-session-item')) {
            e.preventDefault();
            e.stopPropagation();
            handleEmbyIpToggleClick(ipBtn);
            return;
        }
        const ctrl = e.target.closest('.emby-session-ctrl');
        if (ctrl) {
            e.preventDefault();
            e.stopPropagation();
            handleEmbySessionControlClick(ctrl);
            return;
        }
        const item = e.target.closest('.emby-session-item--clickable');
        if (!item || e.target.closest('.emby-session-footer')) return;
        openEmbySessionDetail(item.dataset.instance, item.dataset.sessionId);
    });
    document.addEventListener('keydown', (e) => {
        if (e.target.closest('.emby-session-ctrl')) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('.emby-session-item--clickable');
        if (!item || e.target.closest('.emby-session-footer')) return;
        e.preventDefault();
        openEmbySessionDetail(item.dataset.instance, item.dataset.sessionId);
    });
    ensureEmbySessionTimeTicker();
    setupEmbySeekBadgePopover();
}

function toggleEmbyNav() {
    /* 已移除双行导航，保留空函数避免旧引用报错 */
}

async function ensureEmbyDataLoaded(forceRender = false) {
    if (typeof isEmbyFeatureEnabled === 'function' && !isEmbyFeatureEnabled()) {
        return;
    }
    await refreshEmbyStatus(forceRender);
}

function switchEmbyTab(tab) {
    tab = normalizeEmbyTab(tab);
    embyCurrentTab = tab;
    if (typeof setDeviceTypeFilter === 'function') {
        setDeviceTypeFilter('emby');
    }
    if (typeof switchTab === 'function') {
        switchTab(tab);
    }
}

async function refreshEmbyAll(forceRender = false, silent = false) {
    await refreshEmbyStatus(forceRender, silent);
    if (isEmbyEventsTabActive()) await loadEmbyEvents(silent);
    if (typeof currentTab !== 'undefined' && currentTab === 'syslogs'
        && typeof getSyslogTypeFilter === 'function' && getSyslogTypeFilter() === 'emby') {
        await loadSyslogsForCurrentType(silent, true);
    }
    if (embyCurrentTab === 'stats' && document.getElementById('chartInstance')?.value
        && typeof updateChart === 'function') {
        await updateChart(silent);
    }
}

async function refreshEmbyLiveMetrics(silent = false) {
    try {
        const response = await axios.get('/api/emby/status/live');
        if (!response.data.success) return;
        const liveItems = response.data.data || [];
        if (!cachedEmbyInstances.length && liveItems.length) {
            await refreshEmbyStatus(false, silent);
            return;
        }
        let hasUnknown = false;
        liveItems.forEach(live => {
            let inst = cachedEmbyInstances.find(i => i.name === live.name);
            if (!inst) {
                hasUnknown = true;
                return;
            }
            Object.assign(inst, live);
            const card = document.querySelector(`.instance-card--emby[data-name="${CSS.escape(live.name)}"]`);
            if (card) patchEmbyCardMetrics(inst, card);
        });
        if (hasUnknown) {
            await refreshEmbyStatus(false, silent);
            return;
        }
        updateEmbyHeaderStats(cachedEmbyInstances);
        if (isEmbyPlaybackLogViewActive() || isEmbyCombinedLogViewActive()) {
            if (shouldReloadPlaybackRecordsFromStore()) {
                if (typeof loadEmbyPlaybackRecords === 'function') {
                    await loadEmbyPlaybackRecords(true);
                }
            } else {
                syncEmbyPlaybackLogCardsFromLive();
            }
            if (isEmbyCombinedLogViewActive()) {
                if (typeof loadEmbyBrowseRecords === 'function') {
                    await loadEmbyBrowseRecords(true);
                }
            }
        } else if (isEmbyBrowseLogViewActive()) {
            if (typeof loadEmbyBrowseRecords === 'function') {
                await loadEmbyBrowseRecords(true);
            }
        }
    } catch (e) {
        if (!silent && typeof showToast === 'function') {
            showToast('Emby 实时刷新失败', 'error');
        }
    }
}

async function refreshEmbyStatus(forceRender = false, silent = false) {
    if (typeof isEmbyFeatureEnabled === 'function' && !isEmbyFeatureEnabled()) {
        cachedEmbyInstances = [];
        updateEmbyHeaderStats([]);
        if (typeof markDevicesPanelDataReady === 'function') {
            markDevicesPanelDataReady('emby');
        }
        return;
    }
    try {
        const response = await axios.get('/api/emby/status');
        if (!response.data.success) return;
        let fresh = response.data.data || [];
        if (typeof reconcileStatusInstancesWithPendingRenames === 'function') {
            fresh = reconcileStatusInstancesWithPendingRenames(fresh, 'emby');
        }
        cachedEmbyInstances = fresh;
        if (response.data.debug_traffic_config) {
            embyDebugTrafficConfig = normalizeEmbyDebugTrafficConfig(
                response.data.debug_traffic_config,
            );
        } else if (!embyDebugTrafficConfig) {
            embyDebugTrafficConfig = normalizeEmbyDebugTrafficConfig();
        }
        if (typeof syncEmbyBrowseLogHintText === 'function') {
            syncEmbyBrowseLogHintText();
        }
        updateEmbyInstanceSelects(cachedEmbyInstances);
        updateEmbyHeaderStats(cachedEmbyInstances);
        if (typeof embyInstanceCount !== 'undefined') {
            embyInstanceCount = cachedEmbyInstances.length;
        }
        if (typeof markDevicesPanelDataReady === 'function') {
            markDevicesPanelDataReady('emby');
        }
        if (currentTab === 'devices' && typeof renderDevicesPanel === 'function') {
            renderDevicesPanel(forceRender);
        } else if (currentTab === 'devices') {
            renderEmbyInstanceCards(cachedEmbyInstances, forceRender);
        }
    } catch (e) {
        if (!silent && typeof showToast === 'function') {
            showToast('Emby 状态加载失败', 'error');
        }
    } finally {
        if (typeof markDevicesPanelDataReady === 'function') {
            markDevicesPanelDataReady('emby');
        }
    }
}

function updateEmbyInstanceSelects(instances) {
    const names = sortEmbyInstances(instances).map(i => i.name);
    let eventInstanceChanged = false;
    const sel = document.getElementById('embyEventInstance');
    if (sel) {
        const prev = sel.value
            || sessionStorage.getItem('qb-up-limit-event-instance-emby')
            || '';
        sel.innerHTML = '';
        names.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });
        if (prev && names.includes(prev)) {
            sel.value = prev;
        } else if (names.length) {
            const next = names[0];
            if (prev !== next) eventInstanceChanged = true;
            sel.value = next;
        }
        if (sel.value) {
            sessionStorage.setItem('qb-up-limit-event-instance-emby', sel.value);
        }
    }
    const syslogSel = document.getElementById('embySyslogInstance');
    if (syslogSel) {
        const prevSyslog = syslogSel.value
            || sessionStorage.getItem('qb-up-limit-syslog-instance-emby')
            || '';
        syslogSel.innerHTML = '';
        names.forEach(name => {
            syslogSel.add(new Option(name, name));
        });
        let nextSyslog = '';
        if (prevSyslog && names.includes(prevSyslog)) {
            nextSyslog = prevSyslog;
        } else if (names.length) {
            nextSyslog = names[0];
        }
        const syslogChanged = prevSyslog !== nextSyslog;
        syslogSel.value = nextSyslog;
        if (syslogChanged && typeof currentTab !== 'undefined' && currentTab === 'syslogs'
            && typeof getSyslogTypeFilter === 'function' && getSyslogTypeFilter() === 'emby'
            && typeof loadSyslogsForCurrentType === 'function') {
            loadSyslogsForCurrentType(true, true);
        }
        if (syslogSel.value) {
            sessionStorage.setItem('qb-up-limit-syslog-instance-emby', syslogSel.value);
        }
    }
    if (eventInstanceChanged && isEmbyEventsTabActive()) {
        loadEmbyEvents(true);
    } else if (isEmbyEventsTabActive()) {
        reconcileEmbyEventLogType();
    }

    if (typeof getChartPlatform === 'function' && getChartPlatform() === 'emby') {
        if (typeof populateChartInstanceSelect === 'function') {
            populateChartInstanceSelect(instances, 'emby');
        }
        if (typeof currentTab !== 'undefined' && currentTab === 'stats') {
            (async () => {
                if (typeof refreshChartPlaybackUsers === 'function') {
                    await refreshChartPlaybackUsers();
                }
                if (typeof updateChart === 'function') {
                    await updateChart(true);
                }
            })();
        }
    }
}

let lastEmbyCardsStructureKey = '';
const _embySessionDisplayHold = new Map();
const EMBY_SESSION_DISPLAY_HOLD_MS = 3000;

function resolveEmbyActiveSessionsForDisplay(inst) {
    const live = getEmbyActivePlaybackSessions(inst);
    const name = inst?.name || '';
    if (!name) return live;
    if (live.length) {
        _embySessionDisplayHold.set(name, {
            sessions: live,
            until: Date.now() + EMBY_SESSION_DISPLAY_HOLD_MS,
        });
        return live;
    }
    const hold = _embySessionDisplayHold.get(name);
    if (hold && Date.now() < hold.until && hold.sessions?.length) {
        return hold.sessions;
    }
    _embySessionDisplayHold.delete(name);
    return live;
}

function getEmbyCardsStructureKey(instances) {
    const isMergeEmby = typeof getDeviceViewMode === 'function' && getDeviceViewMode() === 'merge';
    const sorted = isMergeEmby ? instances : sortEmbyInstances(instances);
    return sorted
        .map(i => `${i.name}:${i.display_priority ?? ''}`)
        .join('|');
}

function formatEmbyAddress(inst) {
    const scheme = inst.use_https ? 'https' : 'http';
    return `${scheme}://${inst.host}:${inst.port}`;
}

function parseLuckyBaseUrl(inst) {
    const raw = String(inst?.lucky_base_url || '').trim();
    if (!raw) {
        return { host: '', port: 16601, use_https: true };
    }
    let use_https = true;
    let rest = raw;
    if (rest.startsWith('https://')) {
        use_https = true;
        rest = rest.slice(8);
    } else if (rest.startsWith('http://')) {
        use_https = false;
        rest = rest.slice(7);
    }
    rest = rest.replace(/\/+$/, '').split('/')[0];
    const parsed = typeof parseHostPortInput === 'function'
        ? parseHostPortInput(rest)
        : { host: rest, port: 16601 };
    return {
        host: parsed.host || '',
        port: parsed.port || 16601,
        use_https,
    };
}

function formatLuckyHostPort(inst) {
    const { host, port } = parseLuckyBaseUrl(inst);
    if (!host) return '';
    return `${host}:${port}`;
}

function getEmbyRecentDisplays(inst) {
    const refreshSec = resolveEmbyRefreshInterval(inst);
    const mode = String(inst?.traffic_collect_mode || '').trim().toLowerCase();
    const collecting = mode === 'lucky' ? !!inst.lucky_available : false;
    if (!inst.api_online && !collecting) {
        return { upload: '--', download: '--', refreshSec };
    }
    return {
        upload: formatEmbyTrafficText(inst.recent_delta_bytes || 0),
        download: formatEmbyTrafficText(inst.recent_delta_download_bytes || 0),
        refreshSec,
    };
}

function formatEmbyCollectModeLabel(inst) {
    const mode = String(inst?.traffic_collect_mode || '').trim().toLowerCase();
    if (mode === 'lucky') return 'Lucky 准确模式';
    return '未开启';
}

function getEmbyDataPanelAccentClass(inst) {
    const mode = String(inst?.traffic_collect_mode || '').trim().toLowerCase();
    if (mode === 'lucky') {
        return inst.lucky_available ? 'panel-accent--ok' : 'panel-accent--offline';
    }
    return 'panel-accent--offline';
}

function getEmbyInstancePlaybackCounts(inst) {
    let lan = 0;
    let wan = 0;
    (inst.sessions || []).forEach(session => {
        if (!session.is_playing) return;
        if (session.is_remote) wan += 1;
        else lan += 1;
    });
    return { lan, wan };
}

function formatEmbyPlaybackCountsLabel(inst) {
    const { lan, wan } = getEmbyInstancePlaybackCounts(inst);
    return `局域网${lan} · 外网${wan}`;
}

function getEmbyPresencePanelAccentClass(inst) {
    return inst.api_online ? 'panel-accent--online' : 'panel-accent--offline';
}

function buildEmbyApiPopoverContent(inst) {
    const dataStart = inst.data_start_time && typeof formatTriggerDateTime === 'function'
        ? formatTriggerDateTime(inst.data_start_time)
        : '--';
    if (inst.api_online) {
        const raw = inst.online_since || '';
        const time = raw && typeof formatTriggerDateTime === 'function'
            ? formatTriggerDateTime(raw)
            : '--';
        return `
            <div class="badge-popover-title">Emby API 在线</div>
            <div class="badge-popover-meta">最近上线时间</div>
            <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(time)}</div>
            <div class="badge-popover-divider badge-popover-divider--partial"></div>
            <div class="badge-popover-meta">数据起始时间</div>
            <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(dataStart)}</div>`;
    }
    const raw = inst.offline_since || inst.last_update || '';
    const time = raw && typeof formatTriggerDateTime === 'function'
        ? formatTriggerDateTime(raw)
        : '--';
    return `
        <div class="badge-popover-title">Emby API 离线</div>
        <div class="badge-popover-meta">最近离线时间</div>
        <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(time)}</div>
        <div class="badge-popover-divider badge-popover-divider--partial"></div>
        <div class="badge-popover-meta">数据起始时间</div>
        <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(dataStart)}</div>`;
}

function buildEmbyAddressEndpointHTML(inst) {
    const statusClass = inst.api_online ? 'online' : 'offline';
    const popoverHtml = buildEmbyApiPopoverContent(inst);
    const iconHtml = `
        <span class="info-section-icon info-section-icon--endpoint info-endpoint-icon info-endpoint-icon--${statusClass}" aria-label="${inst.api_online ? 'API 在线' : 'API 离线'}" tabindex="0">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
                <path d="M5.5 14h5M8 12v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            </svg>
        </span>`;
    return `
        <span class="status-badge-wrap info-endpoint-presence-wrap status-badge-wrap--${statusClass}">
            ${iconHtml}
            <span class="status-badge-popover" role="tooltip">${popoverHtml}</span>
        </span>`;
}

function buildEmbyLuckyPopoverContent(inst) {
    const rule = inst.lucky_rule_label || '未选择规则';
    if (inst.lucky_available) {
        return `
            <div class="badge-popover-title">Lucky 流量采集正常</div>
            <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(rule)}</div>
            <div class="badge-popover-meta">页面刷新 ${resolveEmbyRefreshInterval(inst)} 秒</div>
            <div class="badge-popover-meta">数据采集 ${resolveEmbyCollectInterval(inst)} 秒</div>`;
    }
    return `
        <div class="badge-popover-title">Lucky 未采集</div>
        <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(rule)}</div>
        <div class="badge-popover-meta">请检查 Lucky 地址 / OpenToken 与反代规则</div>`;
}

function embyCollectBadgeSignature(inst) {
    const mode = String(inst?.traffic_collect_mode || '').trim().toLowerCase();
    if (mode === 'lucky') return `lucky:${inst.lucky_available ? 1 : 0}`;
    return 'none:0';
}

function buildEmbyCollectBadgeHTML(inst) {
    const mode = String(inst?.traffic_collect_mode || '').trim().toLowerCase();
    if (mode === 'lucky') {
        const ok = !!inst.lucky_available;
        return wrapStatusBadgePopover(
            `<span class="status-badge ${ok ? 'online' : 'offline'} emby-badge-lucky">${buildInfoMetricIcon('upload')}<span data-field="badge-collect">Lucky ${ok ? '采集' : '未采集'}</span></span>`,
            buildEmbyLuckyPopoverContent(inst),
            ok ? 'online' : 'offline',
        );
    }
    return '';
}

function buildEmbyInstanceBadgesRightHTML(inst) {
    const apiOk = !!inst.api_online;
    const count = inst.session_count || 0;
    let html = wrapStatusBadgePopover(
        `<span class="status-badge ${apiOk ? 'online' : 'offline'}">${buildInfoMetricIcon('plan')}<span data-field="badge-api">API ${apiOk ? '在线' : '离线'}</span></span>`,
        buildEmbyApiPopoverContent(inst),
        apiOk ? 'online' : 'offline',
    );
    html += `<span class="emby-collect-badge-slot" data-field="collect-badge" data-collect-sig="${embyCollectBadgeSignature(inst)}">${buildEmbyCollectBadgeHTML(inst)}</span>`;
    html += `<span class="status-badge emby-badge-sessions" data-field="session-count-badge"><span>${count} 路播放</span></span>`;
    return html;
}

function buildEmbyDebugWindowTriggerHtml(inst) {
    if (!EMBY_DEBUG_MODE_ENABLED) return '';
    const safeName = escapeHtml(inst.name);
    const collectMode = resolveEmbyInstanceCollectMode(inst);
    if (!collectMode) {
        return `
        <button type="button" class="emby-debug-window-open emby-debug-window-open--disabled" data-instance="${safeName}" disabled>
            未开启流量采集
        </button>`;
    }
    const title = getEmbyDebugPanelTitle(inst);
    return `
        <button type="button" class="emby-debug-window-open" data-instance="${safeName}" onclick="openEmbyDebugFloatWindow(this.dataset.instance)">
            ${escapeHtml(title)}
        </button>`;
}

function buildEmbyDebugWindowBodyHtml(inst, options = {}) {
    const cfg = normalizeEmbyDebugTrafficConfig(embyDebugTrafficConfig);
    const metrics = normalizeEmbyDebugTrafficMetrics(inst);
    const isLucky = metrics.collectMode === 'lucky';
    const luckyIpRevealed = !!options.ipRevealed;
    const browseUploadMinMbTip = '选片时产生的上传流量累计超过此值，才会记入选片记录和统计。设为 0 表示只要有上传就记录；用户已缓存、几乎不产生上传的浏览本身就不算。默认值1，范围 0～100 MB。';
    const preplayBurstMbpsTip = '与「开播突发窗口」配合使用：每次点击开播后，前 N 秒内上传速率 ≥ 本阈值的流量，视为推流突发，计入播放，不计为选片流量。填写参考：在调试面板观察该连接，点击播放瞬间留意前几秒的实时上传速率（+xxx/s），取略低于最低的突发速率。服务器上行带宽大、缓冲推得猛，可适当调高；带宽一般或选片阶段常有较大上传，可适当调低以免误判。默认 1.5 MB/s，范围 0.5～10。';
    const preplayBurstWindowTip = '与「开播突发阈值」配合使用：每次点击开播后，往前回溯本窗口秒数；该时段内上传速率达到阈值的流量，视为推流突发，计入播放，不计为选片流量。填写参考：点击播放后，观察推流突发通常持续几秒（多数 1～3 秒，慢网或高码率可能 4～5 秒），窗口略大于实际突发时长即可，不必过长以免把真选片流量算进去。默认 3 秒，范围 1～10。';
    const preplayBurstSummaryHint = buildPreplayBurstSummaryHintText(
        cfg.preplay_burst_window_seconds,
        cfg.preplay_burst_mbps,
    );
    const luckyDebugFooterTip = 'Lucky 按 ConnsStatistics 采集各连接上传增量；按 AcceptTime 聚波并与 Emby 外网会话统一裁决，同 IP 多会话按码率权重分摊；选片与播放分账，选片段由开播/断线边沿触发结算落库。';
    const luckyDebugFooterNote = '连接级采集 · 波次会话裁决 · 码率权重分摊 · 选片边沿结算';
    const luckyLayoutHtml = isLucky
        ? `
            <div class="emby-debug-lucky-layout">
                <div class="emby-debug-lucky-top">
                    <div class="emby-debug-lucky-stats-bar">
                        <span class="emby-debug-lucky-stat" data-accent="upload">
                            <span class="emby-debug-lucky-stat-label">总上传</span>
                            <strong class="emby-debug-lucky-stat-value" data-field="total-upload">${escapeHtml(formatEmbyTrafficText(metrics.totalUploadBytes))}</strong>
                        </span>
                        <span class="emby-debug-lucky-stat" data-accent="wan">
                            <span class="emby-debug-lucky-stat-label">已匹配</span>
                            <strong class="emby-debug-lucky-stat-value" data-field="lucky-wan-assigned">${escapeHtml(formatEmbyTrafficText(metrics.wanUploadBytes))}</strong>
                        </span>
                        <span class="emby-debug-lucky-stat" data-accent="remainder">
                            <span class="emby-debug-lucky-stat-label">余量</span>
                            <strong class="emby-debug-lucky-stat-value" data-field="program-remainder">${escapeHtml(formatEmbyTrafficText(metrics.programRemainderBytes))}</strong>
                        </span>
                    </div>
                </div>
                <div class="emby-debug-section emby-debug-lucky-conn-section">
                    <div class="emby-debug-section-title emby-debug-lucky-conn-title">
                        <span>Lucky 连接裁决</span>
                        ${buildLuckyDebugIpPanelToggleHtml(luckyIpRevealed)}
                    </div>
                    <div class="emby-debug-lucky-conn-viewport" data-field="lucky-conn-viewport">
                        <div class="emby-debug-lucky-conn-groups" data-field="lucky-conn-groups">
                            ${buildLuckyConnDebugGroupsHtml(metrics.luckyConnBindings, {
                                firstOpen: false,
                                ipRevealed: luckyIpRevealed,
                                instanceName: inst?.name,
                                tickSeconds: resolveEmbyRefreshInterval(inst),
                            })}
                        </div>
                    </div>
                </div>
                <div class="emby-debug-section emby-debug-lucky-params">
                    <div class="emby-debug-section-title">
                        参数设置
                        <span class="emby-debug-section-hint" data-field="config-save-hint">保存后立即生效</span>
                    </div>
                    <div class="emby-debug-config-grid emby-debug-config-grid--lucky">
                        <label class="emby-debug-config-field">
                            <span class="emby-debug-config-field-label">选片入账阈值 (MB)<span class="emby-debug-help" tabindex="0" data-tip="${escapeHtml(browseUploadMinMbTip)}">?</span></span>
                            <input type="number" min="${EMBY_BROWSE_UPLOAD_MIN_MB_MIN}" max="${EMBY_BROWSE_UPLOAD_MIN_MB_MAX}" step="0.1" value="${cfg.browse_upload_min_mb}" data-field="browse-upload-min-mb" />
                        </label>
                        <p class="emby-debug-preplay-burst-hint" data-field="preplay-burst-summary-hint">${escapeHtml(preplayBurstSummaryHint)}</p>
                        <label class="emby-debug-config-field">
                            <span class="emby-debug-config-field-label">开播突发阈值 (MB/s)<span class="emby-debug-help" tabindex="0" data-tip="${escapeHtml(preplayBurstMbpsTip)}">?</span></span>
                            <input type="number" min="${EMBY_PREPLAY_BURST_MBPS_MIN}" max="${EMBY_PREPLAY_BURST_MBPS_MAX}" step="0.1" value="${cfg.preplay_burst_mbps}" data-field="preplay-burst-mbps" />
                        </label>
                        <label class="emby-debug-config-field">
                            <span class="emby-debug-config-field-label">开播突发窗口 (秒)<span class="emby-debug-help" tabindex="0" data-tip="${escapeHtml(preplayBurstWindowTip)}">?</span></span>
                            <input type="number" min="${EMBY_PREPLAY_BURST_WINDOW_MIN}" max="${EMBY_PREPLAY_BURST_WINDOW_MAX}" step="1" value="${cfg.preplay_burst_window_seconds}" data-field="preplay-burst-window" />
                        </label>
                    </div>
                </div>
                <div class="emby-debug-lucky-footer">
                    <p class="emby-debug-lucky-note" title="${escapeHtml(luckyDebugFooterTip)}">${escapeHtml(luckyDebugFooterNote)}</p>
                    <div class="emby-debug-config-actions">
                        <button type="button" class="emby-debug-config-save" onclick="saveEmbyDebugTrafficConfig(this)">保存并应用</button>
                        <button type="button" class="emby-debug-config-exit emby-debug-config-exit--compact" onclick="exitEmbyDebugMode()">退出调试</button>
                    </div>
                </div>
            </div>`
        : `
            <div class="emby-debug-section emby-debug-section--empty">
                <p class="form-hint form-hint--field">请在该设备的流量采集中开启 Lucky 反代模式后，再使用调试面板。</p>
                <div class="emby-debug-config-actions">
                    <button type="button" class="emby-debug-config-exit" onclick="exitEmbyDebugMode()">退出调试</button>
                </div>
            </div>`;
    return luckyLayoutHtml;
}

function bindEmbyDebugFloatWindowDrag(win) {
    const header = win.querySelector('[data-field="debug-drag-handle"]');
    if (!header || win.dataset.dragBound === '1') return;
    win.dataset.dragBound = '1';
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const onPointerDown = (e) => {
        if (e.target.closest('button')) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = win.offsetLeft;
        startTop = win.offsetTop;
        header.setPointerCapture(e.pointerId);
        bringEmbyDebugFloatWindowToFront(win);
        e.preventDefault();
    };
    const onPointerMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const rect = win.getBoundingClientRect();
        const pos = clampEmbyDebugWindowPosition(
            startLeft + dx,
            startTop + dy,
            rect.width,
            rect.height,
        );
        win.style.left = `${pos.left}px`;
        win.style.top = `${pos.top}px`;
    };
    const onPointerUp = (e) => {
        if (!dragging) return;
        dragging = false;
        try {
            header.releasePointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
        saveEmbyDebugWindowPosition(win.dataset.instance || '', win.offsetLeft, win.offsetTop);
    };
    header.addEventListener('pointerdown', onPointerDown);
    header.addEventListener('pointermove', onPointerMove);
    header.addEventListener('pointerup', onPointerUp);
    header.addEventListener('pointercancel', onPointerUp);
}

function bringEmbyDebugFloatWindowToFront(win) {
    embyDebugFloatZIndex += 1;
    win.style.zIndex = String(embyDebugFloatZIndex);
}

function ensureEmbyDebugFloatWindow(inst) {
    const name = String(inst?.name || '').trim();
    if (!name) return null;
    let win = findEmbyDebugFloatWindow(name);
    if (!win) {
        const title = getEmbyDebugPanelTitle(inst);
        const idx = (cachedEmbyInstances || []).findIndex((item) => item?.name === name);
        const pos = loadEmbyDebugWindowPosition(name) || getDefaultEmbyDebugWindowPosition(Math.max(0, idx));
        win = document.createElement('div');
        win.className = 'emby-debug-float-window';
        win.dataset.instance = name;
        win.dataset.mode = resolveEmbyInstanceCollectMode(inst);
        win.hidden = true;
        const isLuckyWin = win.dataset.mode === 'lucky';
        if (isLuckyWin) win.classList.add('emby-debug-float-window--lucky');
        win.innerHTML = `
            <div class="emby-debug-float-header" data-field="debug-drag-handle">
                <div class="emby-debug-float-title-wrap">
                    <span class="emby-debug-config-dot"></span>
                    <span class="emby-debug-float-title" data-field="window-title">${escapeHtml(title)}</span>
                    <span class="emby-debug-float-instance">${escapeHtml(name)}</span>
                </div>
                <button type="button" class="emby-debug-float-close" data-instance="${escapeHtml(name)}" onclick="closeEmbyDebugFloatWindow(this.dataset.instance)" aria-label="关闭">×</button>
            </div>
            <div class="emby-debug-config-body" data-field="debug-body">
                ${buildEmbyDebugWindowBodyHtml(inst)}
            </div>
        `;
        document.body.appendChild(win);
        win.style.left = `${pos.left}px`;
        win.style.top = `${pos.top}px`;
        bindEmbyDebugFloatWindowDrag(win);
        if (isLuckyWin) {
            ensureEmbyDebugLuckyResizeHandles(win);
        }
        win.addEventListener('pointerdown', () => bringEmbyDebugFloatWindowToFront(win));
    }
    return win;
}

function openEmbyDebugFloatWindow(instanceName) {
    const name = String(instanceName || '').trim();
    if (!name) return;
    const inst = (cachedEmbyInstances || []).find((item) => item?.name === name);
    if (!inst) return;
    const win = ensureEmbyDebugFloatWindow(inst);
    if (!win) return;
    const currentMode = resolveEmbyInstanceCollectMode(inst);
    if (!currentMode) {
        closeEmbyDebugFloatWindow(name);
        return;
    }
    if (win.dataset.mode !== currentMode) {
        win.dataset.mode = currentMode;
        const isLuckyWin = currentMode === 'lucky';
        win.classList.toggle('emby-debug-float-window--lucky', isLuckyWin);
        if (!isLuckyWin) {
            win.querySelectorAll('[data-resize-edge]').forEach((handle) => handle.remove());
            win.style.height = '';
            win.style.maxHeight = '';
        }
        const body = win.querySelector('[data-field="debug-body"]');
        if (body) body.innerHTML = buildEmbyDebugWindowBodyHtml(inst, { ipRevealed: isLuckyDebugIpRevealed(win) });
        const titleEl = win.querySelector('[data-field="window-title"]');
        if (titleEl) titleEl.textContent = getEmbyDebugPanelTitle(inst);
    }
    win.hidden = false;
    bringEmbyDebugFloatWindowToFront(win);
    if (win.dataset.mode === 'lucky') {
        win.classList.add('emby-debug-float-window--lucky');
        ensureEmbyDebugLuckyResizeHandles(win);
    }
    patchEmbyDebugFloatWindow(inst, win);
    requestAnimationFrame(() => {
        if (win.dataset.mode === 'lucky') {
            resetEmbyDebugLuckyWindowHeight(win);
        }
        const rect = win.getBoundingClientRect();
        const nextPos = clampEmbyDebugWindowPosition(rect.left, rect.top, rect.width, rect.height);
        win.style.left = `${nextPos.left}px`;
        win.style.top = `${nextPos.top}px`;
    });
}

function closeEmbyDebugFloatWindow(instanceName) {
    const win = findEmbyDebugFloatWindow(instanceName);
    if (win) win.hidden = true;
}

function patchEmbyDebugFloatWindow(inst, win = null) {
    if (!EMBY_DEBUG_MODE_ENABLED || !inst) return;
    const panel = win || findEmbyDebugFloatWindow(inst.name);
    if (!panel || panel.hidden) return;
    const metrics = normalizeEmbyDebugTrafficMetrics(inst);
    const modeEl = panel.querySelector('[data-field="mode-label"]');
    if (modeEl) modeEl.textContent = metrics.modeLabel;
    const setText = (field, bytes) => {
        const el = panel.querySelector(`[data-field="${field}"]`);
        if (!el) return;
        el.textContent = formatEmbyTrafficText(bytes);
    };
    setText('total-upload', metrics.totalUploadBytes);
    setText('lucky-wan-assigned', metrics.wanUploadBytes);
    setText('total-wan', metrics.wanUploadBytes);
    setText('total-lan', metrics.lanUploadBytes);
    setText('program-remainder', metrics.programRemainderBytes);
    setText('mode-switch-pending', metrics.modeSwitchPendingBytes);
    setText('mode-switch-replay-total', metrics.modeSwitchReplayTotalBytes);
    setText('mode-switch-replay-alloc-total', metrics.modeSwitchReplayAllocTotalBytes);
    setText('wan-alloc-backlog', metrics.wanAllocBacklogBytes);
    setText('wan-alloc-backlog-applied', metrics.wanAllocBacklogAppliedBytes);
    setText('m1-wan-capture', metrics.m1WanCaptureBytes);
    const connGroupsEl = panel.querySelector('[data-field="lucky-conn-groups"]');
    if (connGroupsEl) {
        const ipRevealed = isLuckyDebugIpRevealed(panel);
        updateLuckyConnDebugGroupsDom(connGroupsEl, metrics.luckyConnBindings, {
            ipRevealed,
            instanceName: inst.name,
            tickSeconds: resolveEmbyRefreshInterval(inst),
        });
        applyLuckyDebugIpRevealState(panel, ipRevealed);
    }
}

function buildEmbyDebugTrafficConfigPanelHtml(inst) {
    return buildEmbyDebugWindowTriggerHtml(inst);
}

let embyDebugTipEl = null;
let embyDebugTipAnchor = null;
let embyDebugTipPinned = false;

function ensureEmbyDebugTipEl() {
    if (embyDebugTipEl && document.body.contains(embyDebugTipEl)) return embyDebugTipEl;
    const el = document.createElement('div');
    el.className = 'emby-debug-tip';
    el.setAttribute('role', 'tooltip');
    document.body.appendChild(el);
    embyDebugTipEl = el;
    return el;
}

function showEmbyDebugTip(target) {
    const text = target?.getAttribute('data-tip');
    if (!text) return;
    const el = ensureEmbyDebugTipEl();
    const highlighted = String(text).replace(
        /\[\[([^\]]+)\]\]/g,
        '<span class="emby-debug-tip-highlight">$1</span>',
    );
    if (highlighted !== text) {
        el.innerHTML = highlighted;
    } else {
        el.textContent = text;
    }
    el.classList.toggle(
        'emby-debug-tip--lucky-score',
        !!target?.classList?.contains('emby-debug-lucky-score-tip'),
    );
    el.classList.add('visible');
    embyDebugTipAnchor = target;
    const rect = target.getBoundingClientRect();
    const tipRect = el.getBoundingClientRect();
    const margin = 8;
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    let top = rect.top - tipRect.height - 9;
    if (top < margin) top = rect.bottom + 9;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
}

function refreshEmbyDebugTipIfAnchored() {
    if (!embyDebugTipAnchor || !document.body.contains(embyDebugTipAnchor)) {
        hideEmbyDebugTip();
        return;
    }
    if (embyDebugTipEl?.classList.contains('visible')) {
        showEmbyDebugTip(embyDebugTipAnchor);
    }
}

function hideEmbyDebugTip() {
    embyDebugTipAnchor = null;
    embyDebugTipPinned = false;
    if (embyDebugTipEl) embyDebugTipEl.classList.remove('visible');
}

function resolveEmbyDebugTipTarget(node) {
    if (!node?.closest) return null;
    return node.closest('.emby-debug-help')
        || node.closest('.emby-debug-lucky-score-tip');
}

function bindEmbyDebugTipEvents() {
    if (window.__embyDebugTipBound) return;
    window.__embyDebugTipBound = true;
    bindPreplayBurstConfigInputs();
    document.addEventListener('mouseover', (e) => {
        if (embyDebugTipPinned) return;
        const t = resolveEmbyDebugTipTarget(e.target);
        if (t) showEmbyDebugTip(t);
    });
    document.addEventListener('mouseout', (e) => {
        if (embyDebugTipPinned) return;
        const t = resolveEmbyDebugTipTarget(e.target);
        if (!t) return;
        const related = e.relatedTarget;
        if (related && t.contains(related)) return;
        if (related && embyDebugTipEl?.contains(related)) return;
        hideEmbyDebugTip();
    });
    // 点击开/关（桌面与移动端一致）：再次点击同一标签或点击别处关闭
    document.addEventListener('click', (e) => {
        const t = resolveEmbyDebugTipTarget(e.target);
        if (t) {
            e.preventDefault();
            e.stopPropagation();
            if (embyDebugTipPinned && embyDebugTipAnchor === t) {
                hideEmbyDebugTip();
            } else {
                showEmbyDebugTip(t);
                embyDebugTipPinned = true;
            }
            return;
        }
        if (embyDebugTipPinned
            && !embyDebugTipEl?.contains(e.target)) {
            hideEmbyDebugTip();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && embyDebugTipPinned) hideEmbyDebugTip();
    });
    document.addEventListener('focusin', (e) => {
        const t = resolveEmbyDebugTipTarget(e.target);
        if (t) showEmbyDebugTip(t);
    });
    document.addEventListener('focusout', (e) => {
        if (resolveEmbyDebugTipTarget(e.target)) hideEmbyDebugTip();
    });
    document.addEventListener('scroll', (e) => {
        if (embyDebugTipAnchor?.classList?.contains('emby-debug-lucky-score-tip')) {
            const viewport = embyDebugTipAnchor.closest('.emby-debug-lucky-conn-viewport');
            if (viewport && (e.target === viewport || viewport.contains(e.target))) {
                refreshEmbyDebugTipIfAnchored();
                return;
            }
        }
        hideEmbyDebugTip();
    }, true);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindEmbyDebugTipEvents);
    } else {
        bindEmbyDebugTipEvents();
    }
}

function patchEmbyDebugTrafficPanel(card, inst) {
    if (!card || !inst) return;
    const collectMode = resolveEmbyInstanceCollectMode(inst);
    let existingBtn = card.querySelector('.emby-debug-window-open');
    if (!EMBY_DEBUG_MODE_ENABLED) {
        if (existingBtn) existingBtn.remove();
        return;
    }
    if (!existingBtn) {
        const anchor = card.querySelector('.info-panel-data-hint');
        if (anchor) {
            anchor.insertAdjacentHTML('afterend', buildEmbyDebugWindowTriggerHtml(inst));
            existingBtn = card.querySelector('.emby-debug-window-open');
        }
    } else {
        syncEmbyDebugWindowTriggerButton(existingBtn, inst);
    }
    if (!collectMode) {
        const win = findEmbyDebugFloatWindow(inst.name);
        if (win) win.hidden = true;
        return;
    }
    patchEmbyDebugFloatWindow(inst);
}

function exitEmbyDebugMode() {
    if (!EMBY_DEBUG_MODE_ENABLED) return;
    document.querySelectorAll('.emby-debug-float-window').forEach((win) => win.remove());
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete(EMBY_DEBUG_QUERY_KEY);
        const search = url.searchParams.toString();
        const nextUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash || ''}`;
        window.location.replace(nextUrl);
    } catch (_) {
        window.location.replace(window.location.pathname);
    }
}

let embyDebugConfigSaveStatusTimer = null;

function showEmbyDebugToast(message, type = 'info', duration = 3000) {
    if (typeof showToast !== 'function') return;
    showToast(message, type, duration);
    requestAnimationFrame(() => {
        const toast = document.querySelector('.toast');
        if (toast) toast.style.zIndex = '20000';
    });
}

function setEmbyDebugConfigSaveStatus(panel, state) {
    if (!panel) return;
    const hintEl = panel.querySelector('[data-field="config-save-hint"]');
    if (embyDebugConfigSaveStatusTimer) {
        clearTimeout(embyDebugConfigSaveStatusTimer);
        embyDebugConfigSaveStatusTimer = null;
    }
    if (hintEl) {
        hintEl.classList.toggle('emby-debug-section-hint--saved', state === 'success');
        hintEl.textContent = state === 'success' ? '已保存并生效' : '保存后立即生效';
    }
    if (state === 'success') {
        embyDebugConfigSaveStatusTimer = setTimeout(() => {
            setEmbyDebugConfigSaveStatus(panel, 'idle');
        }, 4000);
    }
}

function applyEmbyDebugTrafficConfigToPanel(panel, cfg) {
    if (!panel || !cfg) return;
    const normalized = normalizeEmbyDebugTrafficConfig(cfg);
    const setValue = (field, value) => {
        const el = panel.querySelector(`[data-field="${field}"]`);
        if (el && value != null) el.value = value;
    };
    setValue('browse-upload-min-mb', normalized.browse_upload_min_mb);
    setValue('preplay-burst-mbps', normalized.preplay_burst_mbps);
    setValue('preplay-burst-window', normalized.preplay_burst_window_seconds);
    syncPreplayBurstSummaryHint(panel);
}

async function saveEmbyDebugTrafficConfig(button) {
    if (!EMBY_DEBUG_MODE_ENABLED) {
        showEmbyDebugToast('请先通过调试模式入口打开面板', 'error');
        return;
    }
    const panel = button?.closest('.emby-debug-float-window');
    if (!panel) {
        showEmbyDebugToast('未找到调试面板', 'error');
        return;
    }
    const payload = {};
    const browseMinMbEl = panel.querySelector('[data-field="browse-upload-min-mb"]');
    const preplayBurstMbpsEl = panel.querySelector('[data-field="preplay-burst-mbps"]');
    const preplayBurstWindowEl = panel.querySelector('[data-field="preplay-burst-window"]');

    if (browseMinMbEl) {
        const browseMinMb = parseFloat(browseMinMbEl.value);
        if (
            !Number.isFinite(browseMinMb)
            || browseMinMb < EMBY_BROWSE_UPLOAD_MIN_MB_MIN
            || browseMinMb > EMBY_BROWSE_UPLOAD_MIN_MB_MAX
        ) {
            showEmbyDebugToast(
                `选片入账阈值请输入 ${EMBY_BROWSE_UPLOAD_MIN_MB_MIN}～${EMBY_BROWSE_UPLOAD_MIN_MB_MAX} MB`,
                'error',
            );
            return;
        }
        payload.browse_upload_min_mb = Math.round(browseMinMb * 100) / 100;
    }
    if (preplayBurstMbpsEl) {
        const preplayBurstMbps = parseFloat(preplayBurstMbpsEl.value);
        if (
            !Number.isFinite(preplayBurstMbps)
            || preplayBurstMbps < EMBY_PREPLAY_BURST_MBPS_MIN
            || preplayBurstMbps > EMBY_PREPLAY_BURST_MBPS_MAX
        ) {
            showEmbyDebugToast(
                `开播突发阈值请输入 ${EMBY_PREPLAY_BURST_MBPS_MIN}～${EMBY_PREPLAY_BURST_MBPS_MAX} MB/s`,
                'error',
            );
            return;
        }
        payload.preplay_burst_mbps = Math.round(preplayBurstMbps * 100) / 100;
    }
    if (preplayBurstWindowEl) {
        const preplayBurstWindow = parseInt(preplayBurstWindowEl.value, 10);
        if (
            !Number.isFinite(preplayBurstWindow)
            || preplayBurstWindow < EMBY_PREPLAY_BURST_WINDOW_MIN
            || preplayBurstWindow > EMBY_PREPLAY_BURST_WINDOW_MAX
        ) {
            showEmbyDebugToast(
                `开播突发窗口请输入 ${EMBY_PREPLAY_BURST_WINDOW_MIN}～${EMBY_PREPLAY_BURST_WINDOW_MAX} 秒`,
                'error',
            );
            return;
        }
        payload.preplay_burst_window_seconds = preplayBurstWindow;
    }
    if (!Object.keys(payload).length) {
        showEmbyDebugToast('没有可保存的参数', 'error');
        return;
    }
    if (button) {
        button.disabled = true;
        button.textContent = '保存中...';
    }
    try {
        const res = await axios.put('/api/emby/debug-traffic-config', payload);
        if (!res.data?.success) {
            const errMsg = res.data?.error || '保存失败';
            showEmbyDebugToast(errMsg, 'error');
            return;
        }
        const savedCfg = normalizeEmbyDebugTrafficConfig(res.data?.data || payload);
        embyDebugTrafficConfig = savedCfg;
        applyEmbyDebugTrafficConfigToPanel(panel, savedCfg);
        if (typeof syncEmbyBrowseLogHintText === 'function') {
            syncEmbyBrowseLogHintText();
        }
        const okMsg = res.data?.message || '调试参数已保存并应用';
        showEmbyDebugToast(okMsg, 'success', 4000);
        setEmbyDebugConfigSaveStatus(panel, 'success');
        await refreshEmbyStatus(true, true);
        if (['browse', 'playback_browse'].includes(getEmbyEventLogType()) && typeof loadEmbyEvents === 'function') {
            await loadEmbyEvents(true);
        }
    } catch (e) {
        const errMsg = e.response?.data?.error || '保存失败';
        showEmbyDebugToast(errMsg, 'error');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = '保存并应用';
        }
    }
}

function buildEmbyInstanceInfoHTML(inst) {
    const recent = getEmbyRecentDisplays(inst);
    const presenceAccent = getEmbyPresencePanelAccentClass(inst);
    const dataAccent = getEmbyDataPanelAccentClass(inst);
    const addressHtml = typeof buildDeviceAddressMaskHtml === 'function'
        ? buildDeviceAddressMaskHtml(formatEmbyAddress(inst))
        : escapeHtml(formatEmbyAddress(inst));
    const collectModeLabel = formatEmbyCollectModeLabel(inst);
    const collectTimingLabel = formatEmbyCollectIntervalLabel(inst);
    const playbackCountsLabel = formatEmbyPlaybackCountsLabel(inst);

    return `
        <div class="info-panel">
            <div class="info-panel-basic">
                <div class="info-panel-section-head info-panel-basic-head ${presenceAccent}">
                    ${buildEmbyAddressEndpointHTML(inst)}
                    <span class="info-panel-basic-head-address">${addressHtml}</span>
                </div>
                <div class="info-panel-inline info-panel-table">
                    ${buildInfoMetricRow('采集模式', escapeHtml(collectModeLabel), {
                        metricClass: 'info-metric--row info-metric--cycle',
                        valueClass: 'info-value-cycle-range info-value-emby-collect-mode',
                        icon: 'plan',
                    })}
                    ${buildInfoMetricRow('流量采集', escapeHtml(collectTimingLabel), {
                        metricClass: 'info-metric--row info-metric--cycle',
                        valueClass: 'info-value-cycle-range info-value-emby-collect-timing',
                        icon: 'upload',
                    })}
                    ${buildInfoMetricRow('当前播放', escapeHtml(playbackCountsLabel), {
                        metricClass: 'info-metric--row info-metric--cycle',
                        valueClass: 'info-value-cycle-range info-value-emby-playback-count',
                        icon: 'clock',
                    })}
                </div>
            </div>
            <div class="info-panel-data">
                <div class="info-panel-section-head info-panel-data-head ${dataAccent}">
                    <span class="info-section-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" fill="none">
                            <path d="M2 12V6.5l6-3.5 6 3.5V12" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                            <path d="M5.5 12V9.2L8 7.8l2.5 1.4V12" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                        </svg>
                    </span>
                    <span class="info-section-title">流量数据</span>
                </div>
                <div class="info-panel-grid">
                    ${buildInfoMetricCell(`近 ${recent.refreshSec} 秒上传`, recent.upload, {
                        labelClass: 'info-metric-label-emby-recent-up',
                        valueClass: 'info-value-emby-recent-up info-metric-value--speed',
                        icon: 'upload',
                    })}
                    ${buildInfoMetricCell(`近 ${recent.refreshSec} 秒下载`, recent.download, {
                        labelClass: 'info-metric-label-emby-recent-down',
                        valueClass: 'info-value-emby-recent-down info-metric-value--speed',
                        icon: 'download',
                    })}
                    ${buildInfoMetricCell('今日上传', formatEmbyTrafficText(inst.today_uploaded_bytes || 0), {
                        valueClass: 'info-value-emby-today-up info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('今日下载', formatEmbyTrafficText(inst.today_downloaded_bytes || 0), {
                        valueClass: 'info-value-emby-today-down info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('昨日上传', formatEmbyTrafficText(inst.yesterday_uploaded_bytes || 0), {
                        valueClass: 'info-value-emby-yesterday-up info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('昨日下载', formatEmbyTrafficText(inst.yesterday_downloaded_bytes || 0), {
                        valueClass: 'info-value-emby-yesterday-down info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('本月上传', formatEmbyTrafficText(inst.monthly_uploaded_bytes || 0), {
                        valueClass: 'info-value-emby-month-up info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('本月下载', formatEmbyTrafficText(inst.monthly_downloaded_bytes || 0), {
                        valueClass: 'info-value-emby-month-down info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('总上传', formatEmbyTrafficText(inst.device_uploaded_bytes || 0), {
                        valueClass: 'info-value-emby-device-up info-metric-value--total',
                    })}
                    ${buildInfoMetricCell('总下载', formatEmbyTrafficText(inst.device_downloaded_bytes || 0), {
                        valueClass: 'info-value-emby-device-down info-metric-value--total',
                    })}
                </div>
                <p class="info-panel-data-hint info-metric-label">${escapeHtml(
                    buildEmbyTrafficDataHint(inst),
                )}</p>
                ${buildEmbyDebugTrafficConfigPanelHtml(inst)}
            </div>
        </div>`;
}

function buildEmbySessionsBlockHTML(inst) {
    const sessions = getEmbyActivePlaybackSessions(inst);
    const count = sessions.length;
    const headerActions = typeof buildRulesHeaderActionsHtml === 'function'
        ? buildRulesHeaderActionsHtml('emby', inst.name, { showLabel: true })
        : '';
    if (!sessions.length) {
        return `
            <div class="rules-header">
                <span class="rules-title">当前播放会话</span>
                ${headerActions}
            </div>
            <div class="rules-empty">暂无活跃播放</div>`;
    }
    const sessionsHTML = sessions.map(s => buildEmbySessionItemHtml(s, inst.name, true)).join('');
    return `
        <div class="rules-header">
            <span class="rules-title" data-field="sessions-title">当前播放会话 (${count})</span>
            ${headerActions}
        </div>
        <div class="rules-list-panel">
            <div class="rules-list-scroll">
                <div class="rules-list emby-sessions-list" data-field="sessions">${sessionsHTML}</div>
            </div>
            <div class="rules-list-rail" hidden aria-hidden="true">
                <div class="rules-list-rail-thumb"></div>
            </div>
        </div>`;
}

function buildEmbyInstanceActionsHTML(safeName) {
    const actions = [
        {
            action: 'open-web',
            variant: 'web',
            label: '打开 Web',
            icon: `<svg class="inst-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M11 3h6v6M9 11 17 3M6 5H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>`,
        },
        {
            action: 'settings',
            variant: 'settings',
            label: '设置',
            icon: `<svg class="inst-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="10" cy="10" r="2.2" stroke="currentColor" stroke-width="1.5"/>
                <path d="M10 2.8v2.2M10 15v2.2M2.8 10h2.2M15 10h2.2M4.9 4.9l1.6 1.6M13.5 13.5l1.6 1.6M4.9 15.1l1.6-1.6M13.5 6.5l1.6-1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>`,
        },
        {
            action: 'reset-stats',
            variant: 'reset',
            label: '清空统计',
            icon: `<svg class="inst-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M4.5 4.5v3M4.5 7.5H7M4.5 7.5A6.5 6.5 0 1 0 10 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>`,
        },
        {
            action: 'delete',
            variant: 'delete',
            label: '删除',
            icon: `<svg class="inst-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 6h10M8 6V4.8A.8.8 0 0 1 8.8 4h2.4a.8.8 0 0 1 .8.8V6M7.5 6l.4 9.2a1 1 0 0 0 1 .8h2.2a1 1 0 0 0 1-.8L12.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M8.5 9v4.5M11.5 9v4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>`,
        },
    ];
    const renderBtn = ({ action, variant, label, icon }) => `
        <button type="button" class="inst-action inst-action--${variant}" data-action="${action}" data-name="${safeName}" title="${label}">
            <span class="inst-action-icon-wrap" aria-hidden="true">${icon}</span>
            <span class="inst-action-label">${label}</span>
        </button>`;
    return `<div class="instance-actions">${actions.map(renderBtn).join('')}</div>`;
}

function renderEmbyInstanceCards(instances, forceFull = false) {
    const container = typeof resolveEmbyCardsContainer === 'function'
        ? resolveEmbyCardsContainer()
        : document.getElementById('instanceCardsSingle');
    if (!container) return;
    if (!instances.length) {
        lastEmbyCardsStructureKey = '';
        const emptyHtml = typeof buildEmbyDevicesEmptyHtml === 'function'
            ? buildEmbyDevicesEmptyHtml()
            : '<div class="empty-tip">暂无 Emby 设备，点击导航栏「添加设备」进行配置</div>';
        container.innerHTML = emptyHtml;
        return;
    }
    const structureKey = getEmbyCardsStructureKey(instances);
    if (!forceFull
        && structureKey === lastEmbyCardsStructureKey
        && container.querySelector('.instance-card--emby')) {
        patchEmbyCardsLive(instances);
        return;
    }
    lastEmbyCardsStructureKey = structureKey;
    container.innerHTML = '';
    orderEmbyInstancesForContainer(instances, container).forEach(inst => {
        container.appendChild(createEmbyInstanceCard(inst));
    });
}

function createEmbyInstanceCard(inst) {
    const card = document.createElement('div');
    card.className = 'instance-card instance-card--emby';
    card.dataset.name = inst.name;

    const safeName = escapeHtml(inst.name);
    const badgesRightHTML = buildEmbyInstanceBadgesRightHTML(inst);
    const instanceInfoHTML = buildEmbyInstanceInfoHTML(inst);
    const sessionsBlockHTML = buildEmbySessionsBlockHTML(inst);

    card.innerHTML = `
        <div class="instance-header">
            ${buildInstancePriorityBadgeHTML(inst)}
            <div class="instance-title-left">
                ${buildInstanceServiceIconHTML('emby')}
                <span class="instance-name">${safeName}</span>
            </div>
            <div class="instance-badges-right">
                ${badgesRightHTML}
            </div>
        </div>
        <div class="instance-body">
            <div class="instance-columns">
                <div class="instance-col instance-col-info">
                    <div class="instance-info">
                        ${instanceInfoHTML}
                    </div>
                </div>
                <div class="instance-col instance-col-rules instance-col-sessions">
                    <div class="rules-block emby-sessions-block">${sessionsBlockHTML}</div>
                </div>
            </div>
        </div>
        <div class="instance-footer">
            ${buildEmbyInstanceActionsHTML(safeName)}
        </div>`;

    card.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = inst.name;
            const action = btn.dataset.action;
            if (action === 'open-web') openEmbyWeb(name);
            else if (action === 'settings') openEditEmbyInstance(name);
            else if (action === 'reset-stats') confirmResetEmbyStats(name);
            else if (action === 'delete') confirmDeleteEmbyInstance(name);
        });
    });
    if (typeof setupRulesScroll === 'function') {
        setupRulesScroll(card);
    }
    return card;
}

function patchEmbyAddressPresence(inst, card) {
    const head = card.querySelector('.info-panel-basic-head');
    if (!head || (typeof hasHoveredStatusBadge === 'function' && hasHoveredStatusBadge(head))) return;

    const statusClass = inst.api_online ? 'online' : 'offline';
    const popoverHtml = buildEmbyApiPopoverContent(inst);
    const wrap = head.querySelector('.info-endpoint-presence-wrap');

    if (wrap) {
        const variantClass = `status-badge-wrap--${statusClass}`;
        if (!wrap.classList.contains(variantClass)) {
            wrap.outerHTML = buildEmbyAddressEndpointHTML(inst);
            return;
        }
        const icon = wrap.querySelector('.info-endpoint-icon');
        if (icon) {
            icon.classList.remove('info-endpoint-icon--online', 'info-endpoint-icon--offline');
            icon.classList.add(`info-endpoint-icon--${statusClass}`);
            icon.setAttribute('aria-label', inst.api_online ? 'API 在线' : 'API 离线');
        }
        const popover = wrap.querySelector('.status-badge-popover');
        if (popover && typeof setInnerHtmlIfChanged === 'function') {
            setInnerHtmlIfChanged(popover, popoverHtml);
        }
        return;
    }

    const legacyIcon = head.querySelector('.info-section-icon--endpoint:not(.info-endpoint-icon)');
    if (legacyIcon) {
        legacyIcon.outerHTML = buildEmbyAddressEndpointHTML(inst);
    }
}

function patchEmbyCardMetrics(inst, card) {
    const recent = getEmbyRecentDisplays(inst);
    const refreshSec = recent.refreshSec;

    const labelUp = card.querySelector('.info-metric-label-emby-recent-up');
    const labelDown = card.querySelector('.info-metric-label-emby-recent-down');
    if (labelUp) labelUp.textContent = `近 ${refreshSec} 秒上传`;
    if (labelDown) labelDown.textContent = `近 ${refreshSec} 秒下载`;

    const setText = (selector, text) => {
        const el = card.querySelector(selector);
        if (el) el.textContent = text;
    };
    setText('.info-value-emby-recent-up', recent.upload);
    setText('.info-value-emby-recent-down', recent.download);
    setText('.info-value-emby-today-up', formatEmbyTrafficText(inst.today_uploaded_bytes || 0));
    setText('.info-value-emby-today-down', formatEmbyTrafficText(inst.today_downloaded_bytes || 0));
    setText('.info-value-emby-yesterday-up', formatEmbyTrafficText(inst.yesterday_uploaded_bytes || 0));
    setText('.info-value-emby-yesterday-down', formatEmbyTrafficText(inst.yesterday_downloaded_bytes || 0));
    setText('.info-value-emby-month-up', formatEmbyTrafficText(inst.monthly_uploaded_bytes || 0));
    setText('.info-value-emby-month-down', formatEmbyTrafficText(inst.monthly_downloaded_bytes || 0));
    setText('.info-value-emby-device-up', formatEmbyTrafficText(inst.device_uploaded_bytes || 0));
    setText('.info-value-emby-device-down', formatEmbyTrafficText(inst.device_downloaded_bytes || 0));

    const dataHint = card.querySelector('.info-panel-data-hint');
    if (dataHint) dataHint.textContent = buildEmbyTrafficDataHint(inst);

    setText('.info-value-emby-collect-mode', formatEmbyCollectModeLabel(inst));
    setText('.info-value-emby-collect-timing', formatEmbyCollectIntervalLabel(inst));
    setText('.info-value-emby-playback-count', formatEmbyPlaybackCountsLabel(inst));
    patchEmbyDebugTrafficPanel(card, inst);

    const apiBadge = card.querySelector('[data-field="badge-api"]');
    if (apiBadge) apiBadge.textContent = `API ${inst.api_online ? '在线' : '离线'}`;
    const collectBadgeSlot = card.querySelector('[data-field="collect-badge"]');
    if (collectBadgeSlot) {
        const sig = embyCollectBadgeSignature(inst);
        if (collectBadgeSlot.dataset.collectSig !== sig) {
            collectBadgeSlot.dataset.collectSig = sig;
            collectBadgeSlot.innerHTML = buildEmbyCollectBadgeHTML(inst);
        }
    }

    const count = resolveEmbyActiveSessionsForDisplay(inst).length;
    const countBadge = card.querySelector('[data-field="session-count-badge"] span');
    if (countBadge) countBadge.textContent = `${count} 路播放`;

    patchEmbyAddressPresence(inst, card);

    const sessionsTitle = card.querySelector('[data-field="sessions-title"]');
    if (sessionsTitle) {
        sessionsTitle.textContent = count
            ? `当前播放会话 (${count})`
            : '当前播放会话';
    }

    const activeSessions = resolveEmbyActiveSessionsForDisplay(inst);
    const sessionsEl = card.querySelector('[data-field="sessions"]');
    if (sessionsEl) {
        if (activeSessions.length) {
            patchEmbySessionsList(sessionsEl, activeSessions, inst.name);
        } else if (sessionsEl.children.length) {
            sessionsEl.innerHTML = '';
        }
    }

    const rulesBlock = card.querySelector('.emby-sessions-block');
    if (rulesBlock && !activeSessions.length) {
        const emptyEl = rulesBlock.querySelector('.rules-empty');
        if (!emptyEl) {
            rulesBlock.innerHTML = buildEmbySessionsBlockHTML(inst);
            if (typeof setupRulesScroll === 'function') setupRulesScroll(card);
        }
    } else if (rulesBlock && activeSessions.length) {
        const emptyEl = rulesBlock.querySelector('.rules-empty');
        if (emptyEl) {
            rulesBlock.innerHTML = buildEmbySessionsBlockHTML(inst);
            if (typeof setupRulesScroll === 'function') setupRulesScroll(card);
        }
    }
}

function patchEmbyCardsLive(instances) {
    sortEmbyInstances(instances).forEach(inst => {
        const card = document.querySelector(`.instance-card--emby[data-name="${CSS.escape(inst.name)}"]`);
        if (card) patchEmbyCardMetrics(inst, card);
    });
    if (typeof scheduleSyncMergeViewCardHeightsDebounced === 'function') {
        scheduleSyncMergeViewCardHeightsDebounced(80);
    }
}

function openEmbyWeb(name) {
    const inst = cachedEmbyInstances.find(i => i.name === name);
    if (!inst) return;
    const scheme = inst.use_https ? 'https' : 'http';
    window.open(`${scheme}://${inst.host}:${inst.port}`, '_blank');
}

function openAddEmbyInstance() {
    openEmbyInstanceModal('add');
}

async function openEditEmbyInstance(name) {
    try {
        const res = await axios.get(`/api/emby/config/instances/${encodeURIComponent(name)}`);
        if (!res.data.success) {
            if (typeof showToast === 'function') showToast('设备配置加载失败', 'error');
            return;
        }
        openEmbyInstanceModal('edit', name, res.data.data);
    } catch (e) {
        if (typeof showToast === 'function') showToast('设备配置加载失败', 'error');
    }
}

const embyRunningTests = new Set();

function buildEmbyInstanceForm(inst, mode) {
    const prefix = mode;
    const name = inst?.name || '';
    const hostPort = typeof formatInstanceHostPort === 'function'
        ? formatInstanceHostPort(inst)
        : (inst?.host ? `${inst.host}:${inst.port ?? 8096}` : '');
    const useHttps = !!inst?.use_https;
    const verifySsl = !!inst?.verify_ssl;
    const apiKeyPlaceholder = mode === 'edit' ? '留空表示不修改已保存的 API Key' : '必填';
    const nameMax = typeof INSTANCE_NAME_MAX_LENGTH !== 'undefined' ? INSTANCE_NAME_MAX_LENGTH : 10;
    const priorityMax = typeof DISPLAY_PRIORITY_MAX !== 'undefined' ? DISPLAY_PRIORITY_MAX : 99999;
    const displayPriority = inst?.display_priority ?? (mode === 'add' ? cachedEmbyInstances.length + 1 : 1);
    const collectMode = String(inst?.traffic_collect_mode || '').trim().toLowerCase();
    const luckyCollectEnabled = collectMode === 'lucky';
    const luckyConn = parseLuckyBaseUrl(inst);
    const luckyHostPort = formatLuckyHostPort(inst);
    const luckyTokenPlaceholder = mode === 'edit' ? '留空表示不修改已保存的 OpenToken' : '必填';
    const luckyRuleOptions = (inst?.has_lucky_rule_keys || (inst?.lucky_rule_key && inst?.lucky_sub_key))
        ? `<option value="__saved__" selected>${escapeHtml(inst.lucky_rule_label || '已选规则')}</option>`
        : '<option value="">请先加载规则</option>';

    return `
        <div class="modal-form modal-form--instance modal-form--emby">
            <div class="form-section form-section--notice">
                <h3>使用须知</h3>
                <p class="form-hint form-hint--field form-hint--notice">本程序采集数据后统一按 二进制（1 KB = 1024 B）显示；<br>建议开启「Lucky反代模式」进行流量采集，并确保 Emby、Lucky、本程序三者统一时区。</p>
            </div>
            <div class="form-section form-section--basic">
                <h3>基础设置</h3>
                <div class="form-row form-row--name-priority">
                    <div class="form-field form-field--grow">
                        <label>显示名称 *
                            <input type="text" id="${prefix}EmbyName" value="${escapeHtml(name)}"
                                   maxlength="${nameMax}" />
                        </label>
                        <p class="form-hint form-hint--field">名称将绑定保存的数据，最多 ${nameMax} 个字符</p>
                    </div>
                    <div class="form-field form-field--hint-width">
                        <label>设备序号
                            <input type="number" id="${prefix}EmbyDisplayPriority" min="1" max="${priorityMax}" step="1"
                                   data-number-stepper value="${displayPriority}" />
                        </label>
                        <p class="form-hint form-hint--field">默认自动填写，有效值 1-${priorityMax}，数值越小卡越靠前</p>
                    </div>
                </div>
            </div>
            <div class="form-section form-section--connect">
                <h3>连接设置</h3>
                <div class="form-field">
                    <label>地址与端口 *
                        <input type="text" id="${prefix}EmbyHostPort" value="${escapeHtml(hostPort)}" />
                    </label>
                    <p class="form-hint form-hint--field">如 192.168.1.10:8096，不要写协议；HTTPS 由下方勾选控制</p>
                </div>
                <div class="form-field">
                    <label>API Key
                        <input type="password" id="${prefix}EmbyApiKey" value=""
                               placeholder="${apiKeyPlaceholder}" autocomplete="new-password" />
                    </label>
                    <p class="form-hint form-hint--field">用于读取播放会话、活动日志；编辑时留空表示不修改</p>
                </div>
                <div class="form-field">
                    <div class="form-row form-row--checkboxes">
                        <label class="checkbox-label">
                            <input type="checkbox" id="${prefix}EmbyHttps" ${useHttps ? 'checked' : ''} /> 使用 HTTPS
                        </label>
                        <label class="checkbox-label" id="${prefix}EmbyVerifySslWrap">
                            <input type="checkbox" id="${prefix}EmbyVerifySsl" ${verifySsl ? 'checked' : ''} /> 验证 SSL 证书
                        </label>
                    </div>
                    <p class="form-hint form-hint--field">通过 HTTPS 连接 Emby API 或打开 Web；自签证书可取消勾选验证</p>
                </div>
                <div class="connection-test-panel">
                    <div class="test-actions">
                        <button type="button" class="btn-secondary btn-sm" id="${prefix}EmbyConnectivityTestBtn">🔍 连通性测试</button>
                        <button type="button" class="btn-secondary btn-sm" id="${prefix}EmbyApiTestBtn">🔑 API 测试</button>
                    </div>
                    <div id="${prefix}EmbyConnectTestResult" class="test-result"></div>
                </div>
            </div>
            <div class="form-section form-section--traffic form-section-last">
                <h3>流量采集</h3>
                <div class="form-field emby-traffic-mode-field">
                    <div class="emby-traffic-mode-options">
                        <label class="emby-traffic-mode-option">
                            <span class="emby-traffic-mode-option__head">
                                <input type="checkbox" id="${prefix}EmbyLuckyCollectEnabled" ${luckyCollectEnabled ? 'checked' : ''} />
                                <span class="emby-traffic-mode-option__title">开启 Lucky 反代模式</span>
                            </span>
                            <span class="emby-traffic-mode-option__desc">准确采集外网播放/选片流量</span>
                        </label>
                    </div>
                </div>
                <p id="${prefix}EmbyTrafficModeEmptyHint" class="form-hint form-hint--field emby-traffic-mode-empty-hint" ${luckyCollectEnabled ? 'hidden' : ''}>未开启流量采集，播放事件与设备卡片均不展示上传相关数据</p>
                <div id="${prefix}EmbyLuckyPanel" class="emby-traffic-panel emby-traffic-panel--lucky" ${luckyCollectEnabled ? '' : 'hidden'}>
                    <h4 class="emby-traffic-subtitle emby-traffic-subtitle--lucky">Lucky 连接设置</h4>
                    <div class="emby-traffic-panel__body">
                        <div class="form-field">
                            <label>地址与端口 *
                                <input type="text" id="${prefix}EmbyLuckyHostPort" value="${escapeHtml(luckyHostPort)}" />
                            </label>
                            <p class="form-hint form-hint--field">如 192.168.1.10:16601，不要写协议；HTTPS 由下方勾选控制</p>
                        </div>
                        <div class="form-field">
                            <label>OpenToken
                                <input type="password" id="${prefix}EmbyLuckyOpenToken" value=""
                                       placeholder="${luckyTokenPlaceholder}" autocomplete="new-password" />
                            </label>
                            <p class="form-hint form-hint--field">Lucky 管理后台生成的 OpenToken；编辑时留空表示不修改</p>
                        </div>
                        <div class="form-field">
                            <div class="form-row form-row--checkboxes">
                                <label class="checkbox-label">
                                    <input type="checkbox" id="${prefix}EmbyLuckyHttps" ${luckyConn.use_https ? 'checked' : ''} /> 使用 HTTPS
                                </label>
                                <label class="checkbox-label" id="${prefix}EmbyLuckyVerifySslWrap">
                                    <input type="checkbox" id="${prefix}EmbyLuckyVerifySsl" ${inst?.lucky_verify_ssl ? 'checked' : ''} /> 验证 SSL 证书
                                </label>
                            </div>
                            <p class="form-hint form-hint--field">通过 HTTPS 连接 Lucky 管理接口；自签证书可取消勾选验证</p>
                        </div>
                        <div class="form-field">
                            <label>反代规则
                                <select id="${prefix}EmbyLuckyRuleSelect">${luckyRuleOptions}</select>
                            </label>
                            <p class="form-hint form-hint--field">连通性测试成功后将自动加载规则，并按 Emby 后端地址尝试匹配</p>
                        </div>
                        <div class="connection-test-panel">
                            <div class="test-actions">
                                <button type="button" class="btn-secondary btn-sm" id="${prefix}EmbyLuckyConnectTestBtn">🔍 连通性测试</button>
                                <button type="button" class="btn-secondary btn-sm" id="${prefix}EmbyLuckyTestBtn">📊 流量接口测试</button>
                            </div>
                            <div id="${prefix}EmbyLuckyConnectTestResult" class="test-result"></div>
                        </div>
                        <div class="form-field">
                            <div class="form-row form-row--checkboxes">
                                <label class="checkbox-label">
                                    <input type="checkbox" id="${prefix}EmbyLuckyCreditBrowse" ${inst?.lucky_credit_browse_traffic ? 'checked' : ''} /> 「选片」流量计入
                                </label>
                            </div>
                            <p class="form-hint form-hint--field">用户选片时（浏览海报/元数据）产生的流量计入对应用户
                            </p>
                        </div>
                    </div>
                </div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-primary" id="saveEmbyInstanceBtn">✔ 保存</button>
                <button type="button" class="btn-secondary" onclick="closeModal()">✖ 取消</button>
            </div>
        </div>`;
}

function bindEmbyTrafficCollectToggles(prefix) {
    const luckyEl = document.getElementById(`${prefix}EmbyLuckyCollectEnabled`);
    const luckyPanel = document.getElementById(`${prefix}EmbyLuckyPanel`);
    const emptyHint = document.getElementById(`${prefix}EmbyTrafficModeEmptyHint`);
    if (!luckyEl) return;

    const syncPanels = () => {
        const luckyOn = luckyEl.checked;
        if (luckyPanel) luckyPanel.hidden = !luckyOn;
        if (emptyHint) emptyHint.hidden = luckyOn;
    };

    luckyEl.addEventListener('change', syncPanels);
    syncPanels();
}

function readEmbyLuckyRuleSelection(prefix) {
    const raw = String(document.getElementById(`${prefix}EmbyLuckyRuleSelect`)?.value || '').trim();
    const label = document.getElementById(`${prefix}EmbyLuckyRuleSelect`)
        ?.selectedOptions?.[0]?.textContent?.trim() || '';
    if (raw === '__saved__') {
        return {
            lucky_rule_key: '',
            lucky_sub_key: '',
            lucky_rule_label: label,
            lucky_rule_preserved: true,
        };
    }
    if (!raw || !raw.includes('|')) {
        return { lucky_rule_key: '', lucky_sub_key: '', lucky_rule_label: '' };
    }
    const [ruleKey, subKey] = raw.split('|');
    return {
        lucky_rule_key: ruleKey || '',
        lucky_sub_key: subKey || '',
        lucky_rule_label: label,
    };
}

function collectEmbyLuckyFormFields(prefix) {
    const rule = readEmbyLuckyRuleSelection(prefix);
    const hostPortEl = document.getElementById(`${prefix}EmbyLuckyHostPort`);
    const parsed = typeof parseHostPortInput === 'function'
        ? parseHostPortInput(hostPortEl?.value || '')
        : { host: hostPortEl?.value || '', port: 16601 };
    const useHttps = !!document.getElementById(`${prefix}EmbyLuckyHttps`)?.checked;
    const host = String(parsed.host || '').trim();
    const port = parsed.port || 16601;
    const luckyBaseUrl = host ? `${useHttps ? 'https' : 'http'}://${host}:${port}` : '';
    return {
        lucky_base_url: luckyBaseUrl,
        lucky_verify_ssl: !!document.getElementById(`${prefix}EmbyLuckyVerifySsl`)?.checked,
        lucky_frontend_host: String(document.getElementById(`${prefix}EmbyLuckyFrontendHost`)?.value || '').trim(),
        lucky_open_token: String(document.getElementById(`${prefix}EmbyLuckyOpenToken`)?.value || '').trim(),
        lucky_credit_browse_traffic: !!document.getElementById(`${prefix}EmbyLuckyCreditBrowse`)?.checked,
        ...rule,
    };
}

function readEmbyTrafficCollectMode(prefix) {
    if (document.getElementById(`${prefix}EmbyLuckyCollectEnabled`)?.checked) return 'lucky';
    return '';
}

async function loadEmbyLuckyRules(prefix, originalName) {
    const selectEl = document.getElementById(`${prefix}EmbyLuckyRuleSelect`);
    if (!selectEl) return { ok: false, error: '规则下拉框不存在' };
    const luckyFields = collectEmbyLuckyFormFields(prefix);
    if (!luckyFields.lucky_base_url) {
        return { ok: false, error: '请填写 Lucky 地址与端口' };
    }
    if (!luckyFields.lucky_open_token && !originalName) {
        return { ok: false, error: '请填写 OpenToken' };
    }
    const formData = collectEmbyFormData(prefix);
    const payload = {
        ...formData,
        ...luckyFields,
        name: originalName || formData.name,
        test_type: 'lucky_rules',
    };
    try {
        const res = await axios.post('/api/emby/config/instances/test', payload);
        if (!res.data.success) {
            return { ok: false, error: res.data.error || '加载规则失败' };
        }
        const data = res.data.data || {};
        const candidates = Array.isArray(data.candidates) ? data.candidates : [];
        const matched = data.matched || null;
        const options = candidates.map(item => {
            const value = `${item.rule_key}|${item.sub_key}`;
            const selected = matched
                && matched.rule_key === item.rule_key
                && matched.sub_key === item.sub_key;
            return `<option value="${escapeHtml(value)}" ${selected ? 'selected' : ''}>${escapeHtml(item.label || value)}</option>`;
        });
        selectEl.innerHTML = options.length
            ? options.join('')
            : '<option value="">未找到可用规则</option>';
        const ruleMessage = matched
            ? `已自动匹配：${data.matched_label || ''}`
            : (candidates.length
                ? `共 ${candidates.length} 条规则，请手动选择`
                : '未找到可用反代规则');
        return {
            ok: true,
            matched: !!matched,
            matchedLabel: data.matched_label || '',
            candidateCount: candidates.length,
            message: ruleMessage,
        };
    } catch (e) {
        return { ok: false, error: e.response?.data?.error || e.message || '加载规则失败' };
    }
}

function payloadNameFromForm(prefix) {
    return String(document.getElementById(`${prefix}EmbyName`)?.value || '').trim();
}

function bindEmbyLuckyHttpsSslToggle(prefix) {
    const httpsEl = document.getElementById(`${prefix}EmbyLuckyHttps`);
    const sslEl = document.getElementById(`${prefix}EmbyLuckyVerifySsl`);
    const sslWrap = document.getElementById(`${prefix}EmbyLuckyVerifySslWrap`);
    if (!httpsEl || !sslEl) return;

    const sync = () => {
        const on = httpsEl.checked;
        sslEl.disabled = !on;
        if (sslWrap) sslWrap.classList.toggle('disabled', !on);
    };

    httpsEl.addEventListener('change', sync);
    sync();
}

function bindEmbyHttpsSslToggle(prefix) {
    const httpsEl = document.getElementById(`${prefix}EmbyHttps`);
    const sslEl = document.getElementById(`${prefix}EmbyVerifySsl`);
    const sslWrap = document.getElementById(`${prefix}EmbyVerifySslWrap`);
    if (!httpsEl || !sslEl) return;

    const sync = () => {
        const on = httpsEl.checked;
        sslEl.disabled = !on;
        if (sslWrap) sslWrap.classList.toggle('disabled', !on);
    };

    httpsEl.addEventListener('change', sync);
    sync();
}

function bindEmbyTestBtns(mode, originalName) {
    const connectBtn = document.getElementById(`${mode}EmbyConnectivityTestBtn`);
    const apiBtn = document.getElementById(`${mode}EmbyApiTestBtn`);
    const luckyTestBtn = document.getElementById(`${mode}EmbyLuckyTestBtn`);
    const luckyConnectBtn = document.getElementById(`${mode}EmbyLuckyConnectTestBtn`);
    if (connectBtn) {
        connectBtn.onclick = () => runEmbyInstanceTest(mode, originalName, 'connectivity');
    }
    if (apiBtn) {
        apiBtn.onclick = () => runEmbyInstanceTest(mode, originalName, 'api');
    }
    if (luckyTestBtn) {
        luckyTestBtn.onclick = () => runEmbyInstanceTest(mode, originalName, 'lucky');
    }
    if (luckyConnectBtn) {
        luckyConnectBtn.onclick = () => runEmbyLuckyConnectTest(mode, originalName);
    }
    bindEmbyHttpsSslToggle(mode);
    bindEmbyLuckyHttpsSslToggle(mode);
}

function bindSaveEmbyInstanceBtn(mode, originalName) {
    const btn = document.getElementById('saveEmbyInstanceBtn');
    if (btn) {
        btn.onclick = () => saveEmbyInstanceSettings(mode, originalName);
    }
}

function setEmbyTestButtonsState(prefix, activeType, running) {
    const meta = {
        connectivity: { btn: `${prefix}EmbyConnectivityTestBtn`, running: '⏳ 连通性测试中…', label: '🔍 连通性测试' },
        api: { btn: `${prefix}EmbyApiTestBtn`, running: '⏳ API 测试中…', label: '🔑 API 测试' },
        lucky: { btn: `${prefix}EmbyLuckyTestBtn`, running: '⏳ 流量接口测试中…', label: '📊 流量接口测试' },
        lucky_connect: { btn: `${prefix}EmbyLuckyConnectTestBtn`, running: '⏳ 连通性测试中…', label: '🔍 连通性测试' },
    };
    const connectionBusy = running && (activeType === 'connectivity' || activeType === 'api');
    ['connectivity', 'api'].forEach((type) => {
        const info = meta[type];
        const btn = document.getElementById(info.btn);
        if (!btn) return;
        btn.disabled = connectionBusy;
        btn.textContent = connectionBusy && activeType === type ? info.running : info.label;
    });
    const luckyBusy = running && (activeType === 'lucky_connect' || activeType === 'lucky');
    ['lucky', 'lucky_connect'].forEach((type) => {
        const info = meta[type];
        const btn = document.getElementById(info.btn);
        if (!btn) return;
        btn.disabled = luckyBusy;
        btn.textContent = luckyBusy && activeType === type ? info.running : info.label;
    });
}

function buildEmbyTestStepHtml(ok, label, message) {
    return `<div class="test-step ${ok ? 'ok' : 'fail'}">
        <span class="test-step-icon">${ok ? '✔' : '✗'}</span>
        <span class="test-step-label">${escapeHtml(label)}</span>
        <span class="test-step-msg">${message}</span>
    </div>`;
}

function showEmbyTestResult(data, prefix, testType) {
    const resultId = testType === 'lucky'
        ? `${prefix}EmbyLuckyConnectTestResult`
        : `${prefix}EmbyConnectTestResult`;
    const resultDiv = document.getElementById(resultId);
    const passText = '测试通过';
    const failText = '测试失败';

    let detailHtml = '';
    if (data.success && testType === 'connectivity' && data.data) {
        const d = data.data;
        let msg = escapeHtml(d.message || '连接成功');
        const ping = String(d.ping || '').trim();
        if (ping && ping.toLowerCase() !== 'ok') {
            msg += `（${escapeHtml(ping)}）`;
        }
        detailHtml = buildEmbyTestStepHtml(true, '连通性', msg);
    } else if (data.success && testType === 'api' && data.data) {
        const d = data.data;
        const parts = [
            d.server_name ? `服务器：${escapeHtml(d.server_name)}` : '',
            d.version ? `版本：${escapeHtml(d.version)}` : '',
        ].filter(Boolean);
        const msg = parts.length ? parts.join(' · ') : escapeHtml(d.message || 'API 验证成功');
        detailHtml = buildEmbyTestStepHtml(true, 'API', msg);
    } else if (data.success && testType === 'lucky' && data.data) {
        const d = data.data;
        const msg = d.message || `IP ${d.ip_total || 0} · 连接 ${d.connection_total || 0}`;
        detailHtml = buildEmbyTestStepHtml(true, 'Lucky', escapeHtml(msg));
    } else if (!data.success) {
        const failLabels = {
            connectivity: '连通性',
            api: 'API',
            lucky: 'Lucky',
        };
        const label = failLabels[testType] || '测试';
        detailHtml = buildEmbyTestStepHtml(
            false,
            label,
            escapeHtml(data.error || failText),
        );
    }

    if (resultDiv) {
        const summary = data.success
            ? `<div class="test-summary ok">${passText}</div>`
            : `<div class="test-summary fail">${failText}</div>`;
        resultDiv.innerHTML = summary + detailHtml;
    }

    if (typeof showToast === 'function') {
        showToast(data.success ? passText : failText, data.success ? 'success' : 'error', data.success ? 4000 : 6000);
    }
}

function validateEmbyTestForm(data) {
    if (!data.host) {
        if (typeof showToast === 'function') showToast('请填写地址', 'error');
        return false;
    }
    if (isNaN(data.port) || data.port < 1 || data.port > 65535) {
        if (typeof showToast === 'function') showToast('请填写有效的地址与端口，格式如 192.168.1.10:8096', 'error');
        return false;
    }
    return true;
}

function validateEmbyApiTestForm(data, mode) {
    if (!data.api_key && mode === 'add') {
        if (typeof showToast === 'function') showToast('请填写 API Key', 'error');
        return false;
    }
    return true;
}

function validateEmbySaveForm(data, mode) {
    const nameMax = typeof INSTANCE_NAME_MAX_LENGTH !== 'undefined' ? INSTANCE_NAME_MAX_LENGTH : 10;
    const priorityMax = typeof DISPLAY_PRIORITY_MAX !== 'undefined' ? DISPLAY_PRIORITY_MAX : 99999;
    if (!data.name) {
        if (typeof showToast === 'function') showToast('请填写显示名称', 'error');
        return false;
    }
    if (data.name.length > nameMax) {
        if (typeof showToast === 'function') showToast(`名称不能超过 ${nameMax} 个字符`, 'error');
        return false;
    }
    if (data.display_priority < 1 || data.display_priority > priorityMax) {
        if (typeof showToast === 'function') showToast(`设备序号须为 1-${priorityMax}`, 'error');
        return false;
    }
    if (!data.host) {
        if (typeof showToast === 'function') showToast('请填写地址', 'error');
        return false;
    }
    if (isNaN(data.port) || data.port < 1 || data.port > 65535) {
        if (typeof showToast === 'function') showToast('请填写有效的地址与端口', 'error');
        return false;
    }
    if (mode === 'add' && !data.api_key) {
        if (typeof showToast === 'function') showToast('请填写 API Key', 'error');
        return false;
    }
    if (data.traffic_collect_mode === 'lucky') {
        if (!data.lucky_base_url) {
            if (typeof showToast === 'function') showToast('请填写 Lucky 地址与端口', 'error');
            return false;
        }
        if (mode === 'add' && !data.lucky_open_token) {
            if (typeof showToast === 'function') showToast('请填写 Lucky OpenToken', 'error');
            return false;
        }
        if (!data.lucky_rule_key || !data.lucky_sub_key) {
            if (!(mode === 'edit' && data.lucky_rule_preserved)) {
                if (typeof showToast === 'function') showToast('请选择 Lucky 反代规则', 'error');
                return false;
            }
        }
    }
    return true;
}

async function runEmbyLuckyConnectTest(mode, originalName) {
    const prefix = mode;
    if (embyRunningTests.has(prefix)) return;
    const luckyFields = collectEmbyLuckyFormFields(prefix);
    if (!luckyFields.lucky_base_url) {
        if (typeof showToast === 'function') showToast('请填写 Lucky 地址与端口', 'error');
        return;
    }
    if (!luckyFields.lucky_open_token && !originalName) {
        if (typeof showToast === 'function') showToast('请填写 OpenToken', 'error');
        return;
    }
    embyRunningTests.add(prefix);
    const resultDiv = document.getElementById(`${prefix}EmbyLuckyConnectTestResult`);
    setEmbyTestButtonsState(prefix, 'lucky_connect', true);
    if (resultDiv) resultDiv.innerHTML = '<div class="test-running">正在测试 Lucky 连通性并加载规则，请稍候…</div>';
    try {
        const formData = collectEmbyFormData(mode);
        const res = await axios.post('/api/emby/config/instances/test', {
            ...formData,
            ...luckyFields,
            name: originalName || formData.name,
            test_type: 'lucky_connect',
        });
        if (!res.data.success) {
            showEmbyLuckyConnectTestResult(res.data, prefix);
            return;
        }
        const loadResult = await loadEmbyLuckyRules(prefix, originalName);
        showEmbyLuckyConnectTestResult(res.data, prefix, loadResult);
    } catch (e) {
        const err = e.response?.data?.error || '测试失败';
        showEmbyLuckyConnectTestResult({ success: false, error: err }, prefix);
    } finally {
        embyRunningTests.delete(prefix);
        setEmbyTestButtonsState(prefix, 'lucky_connect', false);
    }
}

function showEmbyLuckyConnectTestResult(data, prefix, loadResult = null) {
    const resultDiv = document.getElementById(`${prefix}EmbyLuckyConnectTestResult`);
    if (!resultDiv) return;
    const passText = '测试通过';
    const failText = '测试失败';
    const parts = [];
    if (data.success && data.data) {
        parts.push(buildEmbyTestStepHtml(
            true,
            '连通性',
            escapeHtml(data.data.message || '连接成功'),
        ));
        if (loadResult) {
            if (loadResult.ok) {
                parts.push(buildEmbyTestStepHtml(
                    true,
                    '规则',
                    escapeHtml(loadResult.message || '加载成功'),
                ));
            } else {
                parts.push(buildEmbyTestStepHtml(
                    false,
                    '规则',
                    escapeHtml(loadResult.error || '加载失败'),
                ));
            }
        }
    } else if (!data.success) {
        parts.push(buildEmbyTestStepHtml(
            false,
            '连通性',
            escapeHtml(data.error || failText),
        ));
    }
    const allOk = data.success && (!loadResult || loadResult.ok);
    resultDiv.innerHTML = `<div class="test-summary ${allOk ? 'ok' : 'fail'}">${allOk ? passText : failText}</div>${parts.join('')}`;
}

async function runEmbyInstanceTest(mode, originalName, testType) {
    const prefix = mode;
    if (embyRunningTests.has(prefix)) return;

    const data = collectEmbyFormData(mode);
    if ((testType === 'connectivity' || testType === 'api') && !validateEmbyTestForm(data)) return;
    if (testType === 'api' && !validateEmbyApiTestForm(data, mode)) return;
    if (testType === 'lucky') {
        if (!data.lucky_base_url) {
            if (typeof showToast === 'function') showToast('请填写 Lucky 地址与端口', 'error');
            return;
        }
        if (!data.lucky_open_token && !originalName && mode === 'add') {
            if (typeof showToast === 'function') showToast('请填写 OpenToken', 'error');
            return;
        }
        if (!data.lucky_rule_key || !data.lucky_sub_key) {
            if (typeof showToast === 'function') showToast('请先选择 Lucky 反代规则', 'error');
            return;
        }
    }

    embyRunningTests.add(prefix);
    const resultId = testType === 'lucky'
        ? `${prefix}EmbyLuckyConnectTestResult`
        : `${prefix}EmbyConnectTestResult`;
    const resultDiv = document.getElementById(resultId);
    const runningHints = {
        connectivity: '正在测试连通性，请稍候…',
        api: '正在测试 API Key，请稍候…',
        lucky: '正在测试 Lucky 流量接口，请稍候…',
    };
    const runningHint = runningHints[testType] || '正在测试，请稍候…';
    setEmbyTestButtonsState(prefix, testType, true);
    if (resultDiv) resultDiv.innerHTML = `<div class="test-running">${runningHint}</div>`;

    try {
        const luckyFields = testType === 'lucky' ? collectEmbyLuckyFormFields(prefix) : {};
        const res = await axios.post('/api/emby/config/instances/test', {
            ...data,
            ...luckyFields,
            name: originalName || data.name,
            test_type: testType,
        });
        showEmbyTestResult(res.data, prefix, testType);
    } catch (e) {
        const err = e.response?.data?.error || '测试失败';
        showEmbyTestResult({ success: false, error: err }, prefix, testType);
    } finally {
        embyRunningTests.delete(prefix);
        setEmbyTestButtonsState(prefix, testType, false);
    }
}

function openEmbyInstanceModal(mode, name = '', instData = null) {
    const inst = mode === 'edit'
        ? instData
        : { display_priority: cachedEmbyInstances.length + 1 };
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!body || !title) return;

    _embyInstanceEditBaseline = mode === 'edit'
        ? collectEmbyBaselineFromInst(inst)
        : null;

    title.textContent = mode === 'add' ? '➕ 添加设备' : '⚙ 设备设置';
    if (mode === 'edit') {
        title.dataset.instanceName = name;
        title.dataset.formMode = 'edit';
    } else {
        delete title.dataset.instanceName;
        title.dataset.formMode = 'add';
    }

    body.innerHTML = buildEmbyInstanceForm(inst, mode);
    bindSaveEmbyInstanceBtn(mode, name);
    bindEmbyTestBtns(mode, name);
    bindEmbyTrafficCollectToggles(mode);
    if (typeof bindNumberSteppers === 'function') {
        bindNumberSteppers(body);
    }
    if (typeof showControlModal === 'function') {
        showControlModal();
    } else {
        document.getElementById('controlModal').style.display = 'block';
    }
}

function collectEmbyFormData(mode) {
    const prefix = mode || 'add';
    const hostPortEl = document.getElementById(`${prefix}EmbyHostPort`);
    const parsed = typeof parseHostPortInput === 'function'
        ? parseHostPortInput(hostPortEl?.value || '')
        : { host: hostPortEl?.value || '', port: 8096 };
    const trafficCollectMode = readEmbyTrafficCollectMode(prefix);
    return {
        name: String(document.getElementById(`${prefix}EmbyName`)?.value || '').trim(),
        display_priority: parseInt(document.getElementById(`${prefix}EmbyDisplayPriority`)?.value, 10) || 1,
        host: parsed.host,
        port: parsed.port,
        use_https: !!document.getElementById(`${prefix}EmbyHttps`)?.checked,
        verify_ssl: !!document.getElementById(`${prefix}EmbyVerifySsl`)?.checked,
        api_key: String(document.getElementById(`${prefix}EmbyApiKey`)?.value || '').trim(),
        traffic_collect_mode: trafficCollectMode,
        ...collectEmbyLuckyFormFields(prefix),
    };
}

let _embyInstanceEditBaseline = null;

function collectEmbyBaselineFromInst(inst) {
    return {
        name: inst?.name || '',
        display_priority: inst?.display_priority ?? 1,
        host: inst?.host || '',
        port: inst?.port ?? 8096,
        use_https: !!inst?.use_https,
        verify_ssl: !!inst?.verify_ssl,
        traffic_collect_mode: inst?.traffic_collect_mode || '',
        lucky_base_url: inst?.lucky_base_url || '',
        lucky_verify_ssl: !!inst?.lucky_verify_ssl,
        lucky_rule_key: inst?.lucky_rule_key || '',
        lucky_sub_key: inst?.lucky_sub_key || '',
        lucky_rule_label: inst?.lucky_rule_label || '',
        lucky_frontend_host: inst?.lucky_frontend_host || '',
        lucky_credit_browse_traffic: !!inst?.lucky_credit_browse_traffic,
    };
}

function embyInstanceOnlyBasicsChanged(baseline, updated) {
    if (!baseline || !updated) return false;
    if (String(updated.api_key || '').trim()) return false;
    if (String(updated.lucky_open_token || '').trim()) return false;
    const keys = [
        'host', 'port', 'use_https', 'verify_ssl',
        'traffic_collect_mode',
        'lucky_base_url', 'lucky_verify_ssl', 'lucky_rule_key', 'lucky_sub_key',
        'lucky_rule_label', 'lucky_frontend_host', 'lucky_credit_browse_traffic',
    ];
    for (const key of keys) {
        const a = baseline[key];
        const b = updated[key];
        if (key === 'port') {
            if (Number(a) !== Number(b)) return false;
            continue;
        }
        if (key === 'use_https' || key === 'verify_ssl' || key === 'lucky_verify_ssl') {
            if (!!a !== !!b) return false;
            continue;
        }
        if (String(a ?? '') !== String(b ?? '')) return false;
    }
    return true;
}

async function saveEmbyInstanceSettings(mode, originalName) {
    const payload = collectEmbyFormData(mode);
    if (!validateEmbySaveForm(payload, mode)) return;

    let dataPolicy = null;
    if (typeof promptOrphanDataPolicyIfNeeded === 'function') {
        const resolved = await promptOrphanDataPolicyIfNeeded(mode, originalName, payload, 'emby');
        if (resolved === false) return;
        dataPolicy = resolved;
    }

    const saveBtn = document.getElementById('saveEmbyInstanceBtn');
    const saveBtnText = saveBtn?.textContent;
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
    }

    try {
        const body = { ...payload };
        if (dataPolicy) body.data_policy = dataPolicy;
        let res;
        if (mode === 'add') {
            res = await axios.post('/api/emby/config/instances', body);
        } else {
            res = await axios.put(`/api/emby/config/instances/${encodeURIComponent(originalName)}`, body);
        }
        if (res.data.success) {
            const basicsOnly = mode === 'edit'
                && embyInstanceOnlyBasicsChanged(_embyInstanceEditBaseline, payload);
            if (mode === 'edit' && originalName !== payload.name
                && typeof updateMergeDeviceNameOnRename === 'function') {
                updateMergeDeviceNameOnRename('emby', originalName, payload.name);
            }
            if (typeof closeModal === 'function') closeModal();
            if (typeof showToast === 'function') showToast(res.data.message || '保存成功', 'success');
            const refreshAfterSave = async () => {
                if (!basicsOnly && typeof refreshEmbyFeatureLockState === 'function') {
                    await refreshEmbyFeatureLockState();
                }
                if (typeof refreshEmbyStatus === 'function') {
                    await refreshEmbyStatus(true);
                }
            };
            refreshAfterSave();
        } else if (typeof showToast === 'function') {
            showToast(res.data.error || '保存失败', 'error');
        }
    } catch (e) {
        const msg = e.response?.data?.error || '保存失败';
        if (typeof showToast === 'function') showToast(msg, 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = saveBtnText || '✔ 保存';
        }
    }
}

let _pendingEmbyInstanceName = '';

function confirmResetEmbyStats(name) {
    _pendingEmbyInstanceName = name;
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        if (typeof showToast === 'function') showToast('确认弹窗加载失败，请刷新页面后重试', 'error');
        return;
    }
    document.getElementById('confirmModalTitle').textContent = '🗑 清空统计';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm">
            <p class="confirm-message">确认要清空设备 <span class="confirm-restore-name">${escapeHtml(name)}</span> 的流量统计吗？</p>
            <div class="confirm-option">
                <label class="checkbox-label">
                    <input type="checkbox" id="confirmResetEmbyStatsCheckbox">
                    确认清空
                </label>
                <p class="form-hint form-hint-error">将清空该设备全部流量数据并重新累计，此操作不可恢复。</p>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-warning" id="confirmResetEmbyStatsBtn" disabled>✔ 确认清空</button>
                <button type="button" class="btn-secondary" id="cancelResetEmbyStatsBtn">✖ 取消</button>
            </div>
        </div>`;
    const confirmCheckbox = document.getElementById('confirmResetEmbyStatsCheckbox');
    const confirmBtn = document.getElementById('confirmResetEmbyStatsBtn');
    confirmCheckbox.onchange = () => {
        confirmBtn.disabled = !confirmCheckbox.checked;
    };
    confirmBtn.onclick = () => {
        if (confirmBtn.disabled) return;
        doResetEmbyStats(_pendingEmbyInstanceName);
    };
    document.getElementById('cancelResetEmbyStatsBtn').onclick = () => {
        if (typeof closeConfirmModal === 'function') closeConfirmModal();
    };
    modal.style.display = 'block';
}

async function doResetEmbyStats(name) {
    const confirmBtn = document.getElementById('confirmResetEmbyStatsBtn');
    if (confirmBtn?.disabled) return;
    const originalText = confirmBtn?.textContent;
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '清空中…';
    }
    try {
        const res = await axios.post('/api/emby/control/reset-stats', { instance_name: name });
        if (res.data.success) {
            if (typeof showToast === 'function') showToast(res.data.message, 'success');
            if (typeof closeConfirmModal === 'function') closeConfirmModal();
            if (typeof refreshEmbyAll === 'function') {
                await refreshEmbyAll(true);
            } else {
                await refreshEmbyStatus(true);
            }
        } else if (typeof showToast === 'function') {
            showToast(res.data.error || '清空失败', 'error');
        }
    } catch (e) {
        if (typeof showToast === 'function') {
            showToast(e.response?.data?.error || '请求失败', 'error');
        }
    } finally {
        if (confirmBtn) {
            confirmBtn.textContent = originalText || '✔ 确认清空';
            const checkbox = document.getElementById('confirmResetEmbyStatsCheckbox');
            confirmBtn.disabled = !checkbox?.checked;
        }
    }
}

function confirmDeleteEmbyInstance(name) {
    _pendingEmbyInstanceName = name;
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        if (typeof showToast === 'function') showToast('确认弹窗加载失败，请刷新页面后重试', 'error');
        return;
    }
    document.getElementById('confirmModalTitle').textContent = '🗑 删除 Emby 设备';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm">
            <p class="confirm-message">确认要删除 Emby 设备 <span class="confirm-restore-name">${escapeHtml(name)}</span> 吗？</p>
            <div class="confirm-option">
                <p class="form-hint confirm-option-required">请选择数据处理方式（必选其一）</p>
                <label class="checkbox-label">
                    <input type="checkbox" id="keepEmbyDataOnDelete">
                    保留数据
                </label>
                <p class="form-hint">恢复方式：添加设备并使用「<span class="confirm-restore-name">${escapeHtml(name)}</span>」作为显示名称。</p>
                <label class="checkbox-label">
                    <input type="checkbox" id="discardEmbyDataOnDelete">
                    不保留数据
                </label>
                <p class="form-hint form-hint-error">勾选后同时清空该设备的流量统计数据，此操作不可撤销。</p>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-danger" id="confirmDeleteEmbyBtn" disabled>✔ 确认删除</button>
                <button type="button" class="btn-secondary" id="cancelDeleteEmbyBtn">✖ 取消</button>
            </div>
        </div>`;
    const keepDataCheckbox = document.getElementById('keepEmbyDataOnDelete');
    const discardDataCheckbox = document.getElementById('discardEmbyDataOnDelete');
    const confirmDeleteBtn = document.getElementById('confirmDeleteEmbyBtn');

    function syncEmbyDeleteDataChoice(changed) {
        if (changed === 'keep' && keepDataCheckbox.checked) {
            discardDataCheckbox.checked = false;
        } else if (changed === 'discard' && discardDataCheckbox.checked) {
            keepDataCheckbox.checked = false;
        }
        confirmDeleteBtn.disabled = !keepDataCheckbox.checked && !discardDataCheckbox.checked;
    }

    keepDataCheckbox.onchange = () => syncEmbyDeleteDataChoice('keep');
    discardDataCheckbox.onchange = () => syncEmbyDeleteDataChoice('discard');

    confirmDeleteBtn.onclick = () => {
        if (confirmDeleteBtn.disabled) return;
        deleteEmbyInstance(_pendingEmbyInstanceName, keepDataCheckbox.checked);
    };
    document.getElementById('cancelDeleteEmbyBtn').onclick = () => {
        if (typeof closeConfirmModal === 'function') closeConfirmModal();
    };
    modal.style.display = 'block';
}

async function deleteEmbyInstance(name, keepData = false) {
    const btn = document.getElementById('confirmDeleteEmbyBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '删除中…';
    }
    try {
        const res = await axios.delete(`/api/emby/config/instances/${encodeURIComponent(name)}`, {
            params: { keep_data: keepData ? '1' : '0' },
        });
        if (res.data.success) {
            if (typeof closeConfirmModal === 'function') closeConfirmModal();
            if (typeof showToast === 'function') showToast('删除成功', 'success');
            if (typeof refreshEmbyFeatureLockState === 'function') {
                await refreshEmbyFeatureLockState();
            }
            await refreshEmbyStatus(true);
        } else if (typeof showToast === 'function') {
            showToast(res.data.error || '删除失败', 'error');
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('删除失败', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '✔ 确认删除';
        }
    }
}

function getEmbyEventLogType() {
    return document.getElementById('embyEventLogType')?.value || 'playback';
}

function getEmbyEventSelectedInstance() {
    const name = document.getElementById('embyEventInstance')?.value || '';
    if (!name) return null;
    return (cachedEmbyInstances || []).find((item) => item?.name === name) || null;
}

function isEmbyBrowseEventLogAvailable(inst = null) {
    const target = inst || getEmbyEventSelectedInstance();
    if (!target) return false;
    if (resolveEmbyInstanceCollectMode(target) !== 'lucky') return false;
    return !!target.lucky_credit_browse_traffic;
}

function isEmbyBrowseConfigReady() {
    if (!(cachedEmbyInstances || []).length) return false;
    const inst = getEmbyEventSelectedInstance();
    if (!inst) return true;
    return resolveEmbyInstanceCollectMode(inst) !== '';
}

function getPersistedEmbyEventLogType() {
    const direct = sessionStorage.getItem('qb-up-limit-emby-event-log-type');
    if (direct) return direct;
    try {
        const raw = sessionStorage.getItem('qb-up-limit-chart-controls');
        if (!raw) return '';
        const state = JSON.parse(raw);
        return String(state.embyEventLogType || '').trim();
    } catch {
        return '';
    }
}

function reconcileEmbyEventLogType() {
    const select = document.getElementById('embyEventLogType');
    if (!select) return false;
    const persisted = getPersistedEmbyEventLogType();
    if (
        persisted
        && [...select.options].some((opt) => opt.value === persisted && !opt.disabled)
    ) {
        select.value = persisted;
    } else if (
        (persisted === 'browse' || persisted === 'playback_browse')
        && select.value !== persisted
        && !isEmbyBrowseConfigReady()
    ) {
        select.value = persisted === 'playback_browse' ? 'playback_browse' : 'browse';
    }
    const reset = syncEmbyEventLogTypeOptions();
    syncEmbyEventPlaybackUserFilterVisibility();
    return reset;
}

function syncEmbyEventLogTypeOptions() {
    const select = document.getElementById('embyEventLogType');
    if (!select) return false;
    const browseOpt = select.querySelector('option[value="browse"]');
    const combinedOpt = select.querySelector('option[value="playback_browse"]');
    if (!browseOpt) return false;
    const configReady = isEmbyBrowseConfigReady();
    const available = isEmbyBrowseEventLogAvailable();
    [browseOpt, combinedOpt].filter(Boolean).forEach((opt) => {
        opt.hidden = configReady ? !available : false;
        opt.disabled = configReady ? !available : true;
    });
    if (!available && (select.value === 'browse' || select.value === 'playback_browse')) {
        if (!configReady) {
            return false;
        }
        select.value = 'playback';
        if (typeof persistChartControls === 'function') persistChartControls();
        return true;
    }
    return false;
}

function resolveEmbyUiPlatform() {
    if (typeof resolveContentPlatform === 'function') {
        const tab = typeof currentTab !== 'undefined' ? currentTab : 'devices';
        return resolveContentPlatform(tab);
    }
    if (typeof getDeviceTypeFilter === 'function') return getDeviceTypeFilter();
    return 'qb';
}

function isEmbyEventsTabActive() {
    return typeof currentTab !== 'undefined' && currentTab === 'events'
        && resolveEmbyUiPlatform() === 'emby';
}

function isEmbyCombinedLogViewActive() {
    return isEmbyEventsTabActive() && getEmbyEventLogType() === 'playback_browse';
}

function isEmbyPlaybackLogViewActive() {
    return isEmbyEventsTabActive() && getEmbyEventLogType() === 'playback';
}

function isEmbyBrowseLogViewActive() {
    return isEmbyEventsTabActive() && getEmbyEventLogType() === 'browse';
}

function syncEmbyEventLogListShell(logType) {
    const root = document.getElementById('embyEventsList');
    if (!root) return;
    const wantSplit = logType === 'playback_browse';
    const hasSplit = root.classList.contains('emby-event-log-split');
    if (wantSplit === hasSplit) return;
    root.removeAttribute('data-ip-toggle-bound');
    if (wantSplit) {
        root.classList.add('emby-event-log-split');
        root.innerHTML = `
            <div class="emby-event-log-split-col emby-event-log-split-col--playback">
                <div class="emby-event-log-split-head">播放记录</div>
                <div class="emby-event-log-split-list" data-field="playback-list"></div>
            </div>
            <div class="emby-event-log-split-col emby-event-log-split-col--browse">
                <div class="emby-event-log-split-head">选片记录</div>
                <div class="emby-event-log-split-list" data-field="browse-list"></div>
            </div>`;
        return;
    }
    root.classList.remove('emby-event-log-split');
    root.innerHTML = '';
}

function getEmbyPlaybackLogListEl() {
    const root = document.getElementById('embyEventsList');
    if (!root) return null;
    if (root.classList.contains('emby-event-log-split')) {
        return root.querySelector('[data-field="playback-list"]');
    }
    if (getEmbyEventLogType() === 'browse') return null;
    return root;
}

function getEmbyBrowseLogListEl() {
    const root = document.getElementById('embyEventsList');
    if (!root) return null;
    if (root.classList.contains('emby-event-log-split')) {
        return root.querySelector('[data-field="browse-list"]');
    }
    const logType = getEmbyEventLogType();
    if (logType === 'playback' || logType === 'activity') return null;
    return root;
}

function refreshEmbyEventPlaybackUsersFromCaches() {
    if (!isEmbyCombinedLogViewActive()) return;
    void refreshEmbyEventPlaybackUsers([..._lastPlaybackRecords, ..._lastBrowseRecords]);
}

function collectEmbyUserNamesFromRecords(records) {
    const seen = new Set();
    const names = [];
    (records || []).forEach((rec) => {
        const name = String(rec.user_name || '').trim();
        if (!name || seen.has(name)) return;
        seen.add(name);
        names.push(name);
    });
    names.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    return names;
}

function applyEmbyEventPlaybackUserOptions(names, prev) {
    const select = document.getElementById('embyEventPlaybackUser');
    if (!select) return;
    select.innerHTML = '<option value="">全部用户</option>';
    (names || []).forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    });
    const persisted = sessionStorage.getItem('qb-up-limit-emby-event-playback-user') || '';
    const target = prev || persisted;
    if (target && [...select.options].some((o) => o.value === target)) {
        select.value = target;
    }
    sessionStorage.setItem('qb-up-limit-emby-event-playback-user', select.value || '');
    syncEmbyEventPlaybackUserSearchable();
}

async function refreshEmbyEventPlaybackUsers(records) {
    const select = document.getElementById('embyEventPlaybackUser');
    if (!select) return;
    const persisted = sessionStorage.getItem('qb-up-limit-emby-event-playback-user') || '';
    const prev = select.value || persisted;
    const instance = document.getElementById('embyEventInstance')?.value || '';
    let names = [];
    if (instance) {
        try {
            const res = await axios.get('/api/emby/playback-users', { params: { instance } });
            if (res.data?.success) {
                names = (res.data.data || [])
                    .map((name) => String(name || '').trim())
                    .filter(Boolean);
            }
        } catch (e) {
            /* API 失败时回退到记录内用户名 */
        }
    }
    if (!names.length) {
        names = collectEmbyUserNamesFromRecords(records);
    }
    applyEmbyEventPlaybackUserOptions(names, prev);
}

function embyUserNameMatches(recordName, selectedUser) {
    const left = String(recordName || '').trim();
    const right = String(selectedUser || '').trim();
    if (!left || !right) return false;
    return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

function getEmbyEventPlaybackUser() {
    return document.getElementById('embyEventPlaybackUser')?.value || '';
}

function syncEmbyEventPlaybackUserFilterVisibility() {
    const label = document.querySelector('[data-emby-playback-user-filter]');
    if (!label) return;
    const logType = getEmbyEventLogType();
    const browseAvailable = isEmbyBrowseEventLogAvailable();
    const show = logType === 'playback'
        || logType === 'playback_browse'
        || (logType === 'browse' && browseAvailable);
    label.hidden = !show;
    label.setAttribute('aria-hidden', show ? 'false' : 'true');
    const caption = label.querySelector('.chart-control-label');
    if (caption) {
        caption.textContent = '用户选择';
    }
    syncEmbyBrowseLogHintVisibility();
}

function syncEmbyBrowseLogHintVisibility() {
    const hint = document.getElementById('embyBrowseLogHint');
    if (!hint) return;
    const onEmby = typeof getDeviceTypeFilter === 'function'
        && getDeviceTypeFilter() === 'emby';
    const showBrowse = onEmby
        && isEmbyEventsTabActive()
        && (getEmbyEventLogType() === 'browse' || getEmbyEventLogType() === 'playback_browse')
        && isEmbyBrowseEventLogAvailable();
    hint.hidden = !showBrowse;
    hint.setAttribute('aria-hidden', showBrowse ? 'false' : 'true');
    if (showBrowse) syncEmbyBrowseLogHintText();
}

function filterPlaybackRecordsByUser(records) {
    let filtered = filterEmbyEventRecordsExcludeLan(records);
    const user = getEmbyEventPlaybackUser();
    if (!user) return filtered;
    return filtered.filter((rec) => embyUserNameMatches(rec.user_name, user));
}

function filterBrowseRecordsByUser(records) {
    const user = getEmbyEventPlaybackUser();
    const minBytes = getEmbyBrowseUploadMinBytes();
    let eligible = (records || []).filter(
        (rec) => (parseInt(rec.estimated_upload_bytes, 10) || 0) >= minBytes,
    );
    eligible = filterEmbyEventRecordsExcludeLan(eligible);
    if (!user) return eligible;
    return eligible.filter((rec) => embyUserNameMatches(rec.user_name, user));
}

function onEmbyEventLogTypeChange() {
    const logType = getEmbyEventLogType();
    if ((logType === 'browse' || logType === 'playback_browse') && !isEmbyBrowseEventLogAvailable()) {
        const select = document.getElementById('embyEventLogType');
        if (select) select.value = 'playback';
    }
    syncEmbyEventPlaybackUserFilterVisibility();
    if (typeof persistChartControls === 'function') persistChartControls();
    loadEmbyEvents();
}

function onEmbyEventPlaybackUserChange() {
    if (typeof persistChartControls === 'function') persistChartControls();
    rerenderEmbyEventLogsFromCache();
}

function onEmbyEventExcludeLanChange() {
    if (typeof persistChartControls === 'function') persistChartControls();
    rerenderEmbyEventLogsFromCache();
}

function rerenderEmbyEventLogsFromCache() {
    const logType = getEmbyEventLogType();
    if (logType === 'activity') {
        renderEmbyActivityEvents();
        return;
    }
    if (logType === 'browse') {
        renderBrowseRecords();
        return;
    }
    if (logType === 'playback_browse') {
        renderPlaybackRecords();
        renderBrowseRecords();
        return;
    }
    renderPlaybackRecords();
}

async function loadEmbyEvents(silent = false) {
    if (typeof persistChartControls === 'function') persistChartControls();
    reconcileEmbyEventLogType();
    const logType = getEmbyEventLogType();
    syncEmbyEventLogListShell(logType);
    if (logType === 'activity') {
        return loadEmbyActivityLog(silent);
    }
    if (logType === 'playback_browse') {
        if (!isEmbyBrowseEventLogAvailable()) {
            syncEmbyEventLogListShell('playback');
            return loadEmbyPlaybackRecords(silent);
        }
        return loadEmbyCombinedPlaybackBrowseRecords(silent);
    }
    if (logType === 'browse') {
        if (!isEmbyBrowseEventLogAvailable()) {
            return loadEmbyPlaybackRecords(silent);
        }
        return loadEmbyBrowseRecords(silent);
    }
    return loadEmbyPlaybackRecords(silent);
}

let _lastBrowseRecords = [];
let _lastEmbyEventBrowseInstance = '';
let _lastBrowseRecordsFingerprint = '';

function browseRecordsFingerprint(records) {
    return (records || []).map((rec) => (
        `${rec.id || ''}:${rec.stopped_at || ''}:${rec.estimated_upload_bytes || 0}`
    )).join('|');
}

async function loadEmbyCombinedPlaybackBrowseRecords(silent = false) {
    const playbackList = getEmbyPlaybackLogListEl();
    const browseList = getEmbyBrowseLogListEl();
    if (!playbackList || !browseList) return;
    const instance = document.getElementById('embyEventInstance')?.value || '';
    if (!instance) {
        const empty = '<div class="empty-tip">暂无设备</div>';
        playbackList.innerHTML = empty;
        browseList.innerHTML = empty;
        return;
    }
    await Promise.all([
        loadEmbyPlaybackRecords(silent),
        loadEmbyBrowseRecords(silent),
    ]);
    await refreshEmbyEventPlaybackUsers([..._lastPlaybackRecords, ..._lastBrowseRecords]);
}

async function loadEmbyBrowseRecords(silent = false) {
    const list = getEmbyBrowseLogListEl();
    if (!list) return;
    const instance = document.getElementById('embyEventInstance')?.value || '';
    if (!instance) {
        list.innerHTML = '<div class="empty-tip">暂无设备</div>';
        return;
    }
    if (instance !== _lastEmbyEventBrowseInstance) {
        _lastEmbyEventBrowseInstance = instance;
        _lastBrowseRecordsFingerprint = '';
        const userSelect = document.getElementById('embyEventPlaybackUser');
        if (userSelect) {
            userSelect.value = '';
            if (typeof syncEmbyEventPlaybackUserSearchable === 'function') {
                syncEmbyEventPlaybackUserSearchable();
            }
        }
    }
    try {
        const res = await axios.get('/api/emby/browse-records', {
            params: { instance, limit: 200 },
        });
        if (!res.data.success) return;
        if (res.data.browse_upload_min_mb != null) {
            embyDebugTrafficConfig = normalizeEmbyDebugTrafficConfig({
                ...(embyDebugTrafficConfig || {}),
                browse_upload_min_mb: res.data.browse_upload_min_mb,
            });
        }
        syncEmbyBrowseLogHintText();
        const records = res.data.data || [];
        const fingerprint = browseRecordsFingerprint(records);
        if (silent && fingerprint === _lastBrowseRecordsFingerprint) {
            return;
        }
        _lastBrowseRecordsFingerprint = fingerprint;
        renderBrowseRecords(records);
    } catch (e) {
        if (!silent) list.innerHTML = '<div class="empty-tip">加载失败</div>';
    }
}

let _lastPlaybackRecords = [];
let _lastEmbyEventPlaybackInstance = '';
let _lastPlaybackRecordsFingerprint = '';
let _embyPlaybackRecordsSeq = 0;
let _embyActivityLogSeq = 0;
const _embyPlaybackLogTrafficPeak = new Map();

function playbackRecordsFingerprint(records) {
    return (records || []).map((rec) => {
        const timeline = resolveEmbySeekTimeline(rec);
        const tail = timeline.length
            ? `${timeline[timeline.length - 1].direction}:`
            + `${timeline[timeline.length - 1].from_seconds}-`
            + `${timeline[timeline.length - 1].to_seconds}`
            : '';
        return (
            `${rec.id || ''}:${rec.status || ''}:${rec.stopped_at || ''}:${rec.started_at || ''}`
            + `:${rec.estimated_upload_bytes || 0}:${rec.upload_bytes || 0}:${rec.seek_count || 0}`
            + `:${rec.seek_forward_count || 0}:${rec.seek_backward_count || 0}`
            + `:${timeline.length}:${tail}`
        );
    }).join('|');
}

async function loadEmbyPlaybackRecords(silent = false) {
    const list = getEmbyPlaybackLogListEl();
    if (!list) return;
    const instance = document.getElementById('embyEventInstance')?.value || '';
    if (!instance) {
        list.innerHTML = '<div class="empty-tip">暂无设备</div>';
        return;
    }
    if (instance !== _lastEmbyEventPlaybackInstance) {
        _lastEmbyEventPlaybackInstance = instance;
        _lastPlaybackRecordsFingerprint = '';
        const userSelect = document.getElementById('embyEventPlaybackUser');
        if (userSelect) {
            userSelect.value = '';
            if (typeof syncEmbyEventPlaybackUserSearchable === 'function') {
                syncEmbyEventPlaybackUserSearchable();
            }
        }
    }
    const requestId = ++_embyPlaybackRecordsSeq;
    try {
        const res = await axios.get('/api/emby/playback-records', {
            params: { instance, limit: 200 },
        });
        if (requestId !== _embyPlaybackRecordsSeq) return;
        if (!res.data.success) return;
        const records = res.data.data || [];
        const fingerprint = playbackRecordsFingerprint(records);
        if (silent && fingerprint === _lastPlaybackRecordsFingerprint) {
            _lastPlaybackRecords = records;
            syncEmbyPlaybackLogCardsFromLive();
            return;
        }
        _lastPlaybackRecordsFingerprint = fingerprint;
        renderPlaybackRecords(records);
    } catch (e) {
        if (requestId !== _embyPlaybackRecordsSeq) return;
        if (!silent) list.innerHTML = '<div class="empty-tip">加载失败</div>';
    }
}

let _lastEmbyActivityEvents = [];

async function loadEmbyActivityLog(silent = false) {
    const list = document.getElementById('embyEventsList');
    if (!list) return;
    const instance = document.getElementById('embyEventInstance')?.value || '';
    if (!instance) {
        list.innerHTML = '<div class="empty-tip">暂无设备</div>';
        return;
    }
    const requestId = ++_embyActivityLogSeq;
    try {
        const res = await axios.get('/api/emby/activity-log', {
            params: { instance, limit: 200 },
        });
        if (requestId !== _embyActivityLogSeq) return;
        if (!res.data.success) {
            if (!silent) {
                const msg = res.data.error || '加载失败';
                list.innerHTML = `<div class="empty-tip">${escapeHtml(msg)}</div>`;
            }
            return;
        }
        renderEmbyActivityEvents(res.data.data || []);
    } catch (e) {
        if (requestId !== _embyActivityLogSeq) return;
        if (!silent) list.innerHTML = '<div class="empty-tip">加载失败</div>';
    }
}

function embyActivityEventSlug(type) {
    return String(type || 'activity').toLowerCase().replace(/\./g, '-');
}

function renderEmbyActivityEventCard(event) {
    const isPlayback = isEmbyPlaybackEvent(event.type);
    const mediaTitleHtml = isPlayback ? buildEmbyEventMediaTitleHtml(event) : '';
    const timeHtml = escapeHtml(formatEmbyEventDateTime(event.date));
    const instSuffix = event.instance_name
        ? ` <span class="event-time-instance">${escapeHtml(event.instance_name)}</span>`
        : '';
    const overview = String(event.overview || '').trim();
    const name = String(event.name || '').trim();
    const detailText = overview && overview !== name ? overview : (isPlayback ? '' : name);
    const detailHtml = detailText && !mediaTitleHtml
        ? `<div class="event-detail">${escapeHtml(detailText)}</div>`
        : '';
    const tailHtml = isPlayback
        ? buildEmbyPlaybackCardTailHtml(event, {
            includeWatch: isEmbyPlaybackStopEvent(event.type),
        })
        : '';
    const slug = embyActivityEventSlug(event.type);
    return `
        <div class="event-item emby-activity emby-event-${slug}">
            <div class="event-time">${timeHtml}${instSuffix}</div>
            <div class="event-playback-meta">${buildEmbyEventTypeLine(event, { includeInstance: false })}</div>
            ${mediaTitleHtml ? `<div class="event-media-title">${mediaTitleHtml}</div>` : ''}
            ${detailHtml}
            ${tailHtml}
        </div>`;
}

function renderEmbyActivityEvents(events) {
    const list = document.getElementById('embyEventsList');
    if (!list) return;
    if (events !== undefined) {
        _lastEmbyActivityEvents = events || [];
    }
    const filtered = filterEmbyEventRecordsExcludeLan(_lastEmbyActivityEvents);
    if (!filtered.length) {
        const tip = _lastEmbyActivityEvents.length && isEmbyEventExcludeLanEnabled()
            ? '暂无匹配的外网原始日志'
            : '暂无原始日志';
        list.innerHTML = `<div class="empty-tip">${tip}</div>`;
        return;
    }
    list.innerHTML = filtered.map(renderEmbyActivityEventCard).join('');
    ensureEmbyEventIpToggle();
}

function formatEmbyEventTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (!Number.isNaN(d.getTime())) {
        return d.toLocaleString('zh-CN');
    }
    return String(dateStr).replace('T', ' ').slice(0, 19);
}

function maskEmbyEndpointDisplay(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return '';

    let host = raw;
    if (raw.startsWith('[')) {
        const end = raw.indexOf(']');
        host = end > 0 ? raw.slice(1, end) : raw;
    } else if (raw.includes('.') && raw.includes(':')) {
        host = raw.slice(0, raw.lastIndexOf(':'));
    }

    const parts = host.split('.');
    if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) {
        const stars = (segment) => '*'.repeat(segment.length);
        return `${parts[0]}.${stars(parts[1])}.${stars(parts[2])}.${parts[3]}`;
    }

    if (host.includes(':')) {
        const groups = host.split(':').filter(Boolean);
        if (groups.length >= 4) {
            const stars = (segment) => '*'.repeat(Math.max(segment.length, 1));
            const head = groups[0];
            const tail = groups[groups.length - 1];
            const middle = groups.slice(1, -1).map(stars).join(':');
            return `${head}:${middle}:${tail}`;
        }
    }

    return '****';
}

function buildEmbyEventIpEyeIcon(revealed) {
    if (typeof buildEndpointEyeIcon === 'function') {
        return buildEndpointEyeIcon(revealed);
    }
    if (revealed) {
        return '<svg class="emby-event-ip-eye" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M1 1l22 22"/></svg>';
    }
    return '<svg class="emby-event-ip-eye" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
}

function buildEmbyIpRevealHtml(ip, options = {}) {
    const raw = String(ip || '').trim();
    if (!raw) return '';
    const masked = maskEmbyEndpointDisplay(raw);
    const prefix = options.leadingSep ? '&nbsp;·&nbsp; ' : '';
    const wrapClass = ['emby-event-ip-wrap', options.wrapClass].filter(Boolean).join(' ');
    return `${prefix}<span class="${wrapClass}">`
        + `<span class="emby-event-ip">${escapeHtml(masked)}</span>`
        + `<button type="button" class="emby-event-ip-toggle" aria-label="显示 IP" aria-pressed="false" data-ip="${escapeHtml(raw)}">${buildEmbyEventIpEyeIcon(false)}</button>`
        + `</span>`;
}

function buildEmbySessionNetworkIpHtml(session) {
    const ip = session.client_ip || session.remote_endpoint || '';
    return buildEmbyIpRevealHtml(ip);
}

function captureEmbyIpRevealIp(container) {
    return container?.querySelector('.emby-event-ip-toggle[aria-pressed="true"]')?.dataset.ip || '';
}

function restoreEmbyIpRevealState(container, revealedIp) {
    if (!container || !revealedIp) return;
    const btn = container.querySelector('.emby-event-ip-toggle');
    const ipEl = container.querySelector('.emby-event-ip');
    if (!btn || !ipEl || btn.dataset.ip !== revealedIp) return;
    ipEl.textContent = revealedIp;
    btn.setAttribute('aria-pressed', 'true');
    btn.setAttribute('aria-label', '隐藏 IP');
    btn.innerHTML = buildEmbyEventIpEyeIcon(true);
}

function handleEmbyIpToggleClick(btn) {
    const wrap = btn.closest('.emby-event-ip-wrap');
    const ipEl = wrap?.querySelector('.emby-event-ip');
    const realIp = btn.dataset.ip || '';
    if (!ipEl || !realIp) return;
    const revealed = btn.getAttribute('aria-pressed') === 'true';
    if (revealed) {
        ipEl.textContent = maskEmbyEndpointDisplay(realIp);
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', '显示 IP');
        btn.innerHTML = buildEmbyEventIpEyeIcon(false);
    } else {
        ipEl.textContent = realIp;
        btn.setAttribute('aria-pressed', 'true');
        btn.setAttribute('aria-label', '隐藏 IP');
        btn.innerHTML = buildEmbyEventIpEyeIcon(true);
    }
}

function buildEmbyEventNetworkIpHtml(event) {
    const ip = event.client_ip || event.remote_endpoint || '';
    return buildEmbyIpRevealHtml(ip, { leadingSep: true });
}

function buildEmbyEventNetworkBadgeHtml(event) {
    const ip = event.client_ip || event.remote_endpoint || '';
    if (!ip) return '';
    const badgeLabel = event.is_remote ? '外网' : '局域网';
    const networkKind = event.is_remote ? 'wan' : 'lan';
    return `<span class="emby-session-badge emby-event-badge--network emby-event-badge--network-${networkKind}">${badgeLabel}</span>`;
}

function buildEmbyEventNetworkHtml(event) {
    const ipPart = buildEmbyEventNetworkIpHtml(event);
    const badge = buildEmbyEventNetworkBadgeHtml(event);
    if (!ipPart && !badge) return '';
    return ipPart + (badge ? ` ${badge}` : '');
}

function ensureEmbyEventIpToggle() {
    const list = document.getElementById('embyEventsList');
    if (!list || list.dataset.ipToggleBound === '1') return;
    list.dataset.ipToggleBound = '1';
    list.addEventListener('click', (e) => {
        const btn = e.target.closest('.emby-event-ip-toggle');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        handleEmbyIpToggleClick(btn);
    });
}

const EMBY_TRANSCODE_REASON_LABELS = {
    ContainerNotSupported: '容器不支持',
    ContainerBitrateExceedsLimit: '容器码率超限',
    VideoCodecNotSupported: '视频编码不支持',
    VideoProfileNotSupported: '视频 Profile 不支持',
    VideoLevelNotSupported: '视频 Level 不支持',
    VideoResolutionNotSupported: '视频分辨率不支持',
    VideoBitDepthNotSupported: '视频位深不支持',
    VideoFramerateNotSupported: '视频帧率不支持',
    VideoBitrateNotSupported: '视频码率不支持',
    VideoRangeTypeNotSupported: '视频动态范围不支持',
    AnamorphicVideoNotSupported: '变形视频不支持',
    InterlacedVideoNotSupported: '隔行视频不支持',
    RefFramesNotSupported: '参考帧不支持',
    AudioCodecNotSupported: '音频编码不支持',
    AudioProfileNotSupported: '音频 Profile 不支持',
    AudioBitrateNotSupported: '音频码率不支持',
    AudioChannelsNotSupported: '音频声道不支持',
    AudioSampleRateNotSupported: '音频采样率不支持',
    AudioBitDepthNotSupported: '音频位深不支持',
    SecondaryAudioNotSupported: '次要音轨不支持',
    SubtitleCodecNotSupported: '字幕格式不支持',
    DirectPlayError: '直连失败',
    UnknownVideoStreamInfo: '视频流信息未知',
    UnknownAudioStreamInfo: '音频流信息未知',
};

function embyTranscodeReasonLabel(reason) {
    const key = String(reason || '').trim();
    if (!key) return '';
    return EMBY_TRANSCODE_REASON_LABELS[key] || key;
}

function buildEmbyTranscodePopoverRows(event) {
    const rows = [];
    const methodLabel = embyPlayMethodLabel(event.play_method);
    if (methodLabel) rows.push(['播放方式', methodLabel]);

    const isVideoDirect = event.is_video_direct;
    const isAudioDirect = event.is_audio_direct;
    if (isVideoDirect != null) rows.push(['视频', isVideoDirect ? '直连' : '转码']);
    if (isAudioDirect != null) rows.push(['音频', isAudioDirect ? '直连' : '转码']);

    const codec = [event.video_codec, event.audio_codec].filter(Boolean).join(' / ');
    if (codec) rows.push(['编码', codec.toUpperCase()]);
    if (event.container) rows.push(['容器', String(event.container).toUpperCase()]);

    const resolution = formatEmbyResolution(event.width, event.height);
    if (resolution) rows.push(['分辨率', resolution]);

    const bitrateText = formatEmbyKbps(event.bitrate);
    if (bitrateText) rows.push(['码率', bitrateText]);

    const reasons = Array.isArray(event.transcode_reasons) ? event.transcode_reasons : [];
    const reasonText = reasons.map(embyTranscodeReasonLabel).filter(Boolean).join('、');
    if (reasonText) rows.push(['转码原因', reasonText]);

    return rows;
}

function buildEmbyTranscodePopoverHtml(event) {
    const rows = buildEmbyTranscodePopoverRows(event);
    if (!rows.length) return '';
    return rows.map(([k, v]) => (
        `<div class="badge-popover-meta"><span class="emby-transcode-popover-key">${escapeHtml(k)}</span>`
        + `<span class="emby-transcode-popover-val">${escapeHtml(String(v))}</span></div>`
    )).join('');
}

function buildEmbyEventTranscodeBadgeHtml(event) {
    const kind = deriveEmbyEventTranscodeKind(event);
    const label = embyTranscodeKindLabel(kind);
    if (!label) return '';
    const popoverHtml = buildEmbyTranscodePopoverHtml(event);
    if (!popoverHtml) {
        return `<span class="emby-session-badge emby-event-badge--transcode">${escapeHtml(label)}</span>`;
    }
    return `
        <span class="emby-transcode-badge-wrap status-badge-wrap" tabindex="0" role="button">
            <span class="emby-session-badge emby-event-badge--transcode">${escapeHtml(label)}</span>
            <span class="status-badge-popover emby-transcode-badge-popover" role="tooltip">${popoverHtml}</span>
        </span>`;
}

function buildEmbyEventTranscodeHtml(event) {
    const badge = buildEmbyEventTranscodeBadgeHtml(event);
    return badge ? ` ${badge}` : '';
}

function isEmbyPlaybackStopEvent(type) {
    const slug = String(type || '').toLowerCase();
    return slug.includes('stop') || slug.includes('stopped');
}

const EMBY_WATCH_COMPLETE_RATIO = 0.85;
const EMBY_SEEK_FORWARD_MIN_DELTA = 25;
const EMBY_SEEK_BACKWARD_TOLERANCE = 8;
const EMBY_SEEK_TIP_SEPARATOR = '------------------------------';

function buildEmbySeekTipThresholdLine() {
    return `前跳>${EMBY_SEEK_FORWARD_MIN_DELTA}s/次；后跳>${EMBY_SEEK_BACKWARD_TOLERANCE}s/次`;
}

function buildEmbySeekTipCountLine(forward, backward) {
    return `前跳${forward}次；后跳${backward}次`;
}

function buildEmbySeekTipDetailLines(event) {
    const timeline = resolveEmbySeekTimeline(event);
    return timeline.map((entry, idx) => {
        const kind = entry.direction === 'backward' ? '后跳' : '前跳';
        return (
            `${idx + 1} - ${kind}：`
            + `${formatEmbyDuration(entry.from_seconds)}→${formatEmbyDuration(entry.to_seconds)}`
        );
    });
}

function buildEmbySeekCombinedTooltip(event) {
    const forward = resolveEmbySeekForwardCount(event);
    const backward = resolveEmbySeekBackwardCount(event);
    const total = forward + backward;
    if (total <= 0) return '';
    const lines = [
        buildEmbySeekTipThresholdLine(),
        EMBY_SEEK_TIP_SEPARATOR,
        buildEmbySeekTipCountLine(forward, backward),
        ...buildEmbySeekTipDetailLines(event),
    ];
    return lines.join('\n');
}

function buildEmbySeekPopoverHtml(event) {
    const forward = resolveEmbySeekForwardCount(event);
    const backward = resolveEmbySeekBackwardCount(event);
    const total = forward + backward;
    if (total <= 0) return '';
    const detailLines = buildEmbySeekTipDetailLines(event);
    const detailHtml = detailLines.map(
        (line) => `<div class="badge-popover-meta emby-seek-popover-entry">${escapeHtml(line)}</div>`,
    ).join('');
    return `
        <div class="badge-popover-meta">${escapeHtml(buildEmbySeekTipThresholdLine())}</div>
        <div class="badge-popover-divider badge-popover-divider--partial"></div>
        <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(buildEmbySeekTipCountLine(forward, backward))}</div>
        ${detailHtml}`;
}

function buildEmbySeekBadgeHtml(event) {
    const total = resolveEmbySeekCount(event);
    if (total <= 0) return '';
    const label = total === 1 ? '跳转1次' : `跳转${total}次`;
    const popoverHtml = buildEmbySeekPopoverHtml(event);
    const tip = buildEmbySeekCombinedTooltip(event);
    return `
        <span class="emby-seek-badge-wrap status-badge-wrap" tabindex="0" role="button" aria-label="${escapeHtml(tip)}">
            <span class="emby-session-badge emby-event-badge--seek">${escapeHtml(label)}</span>
            <span class="status-badge-popover emby-seek-badge-popover" role="tooltip">${popoverHtml}</span>
        </span>`;
}

function normalizeEmbySeekLog(raw) {
    if (!Array.isArray(raw)) return [];
    const result = [];
    raw.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const from = parseInt(item.from_seconds ?? item.from, 10);
        const to = parseInt(item.to_seconds ?? item.to, 10);
        if (Number.isNaN(from) || Number.isNaN(to)) return;
        result.push({
            from_seconds: Math.max(0, from),
            to_seconds: Math.max(0, to),
        });
    });
    return result;
}

function normalizeEmbySeekTimeline(raw) {
    if (!Array.isArray(raw)) return [];
    const result = [];
    raw.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const from = parseInt(item.from_seconds ?? item.from, 10);
        const to = parseInt(item.to_seconds ?? item.to, 10);
        if (Number.isNaN(from) || Number.isNaN(to)) return;
        const direction = String(item.direction || '').toLowerCase() === 'backward'
            ? 'backward'
            : 'forward';
        result.push({
            direction,
            from_seconds: Math.max(0, from),
            to_seconds: Math.max(0, to),
        });
    });
    return result;
}

function resolveEmbySeekTimeline(event) {
    const timeline = normalizeEmbySeekTimeline(event?.seek_log);
    if (timeline.length) return timeline;
    const rebuilt = [];
    normalizeEmbySeekLog(event?.seek_forward_log).forEach((entry) => {
        rebuilt.push({ ...entry, direction: 'forward' });
    });
    normalizeEmbySeekLog(event?.seek_backward_log).forEach((entry) => {
        rebuilt.push({ ...entry, direction: 'backward' });
    });
    return rebuilt;
}

function buildEmbyEventUserBadgeHtml(event) {
    const name = event.user_name || '';
    if (!name) return '';
    return `<span class="emby-session-badge emby-event-badge--user">${escapeHtml(name)}</span>`;
}

function resolveEmbySeekCount(event) {
    const raw = parseInt(event?.seek_count, 10);
    if (Number.isNaN(raw) || raw < 0) return 0;
    return raw;
}

function resolveEmbySeekForwardCount(event) {
    const raw = parseInt(event?.seek_forward_count, 10);
    if (!Number.isNaN(raw) && raw >= 0) return raw;
    const total = resolveEmbySeekCount(event);
    const backward = resolveEmbySeekBackwardCount(event);
    return Math.max(0, total - backward);
}

function resolveEmbySeekBackwardCount(event) {
    const raw = parseInt(event?.seek_backward_count, 10);
    if (!Number.isNaN(raw) && raw >= 0) return raw;
    return 0;
}

function ensureEmbyLogCardTagsEl(cardEl) {
    let tagsEl = cardEl?.querySelector('.emby-log-card-tags');
    if (tagsEl) return tagsEl;
    const head = cardEl?.querySelector('.emby-log-card-head');
    if (!head) return null;
    tagsEl = document.createElement('div');
    tagsEl.className = 'emby-log-card-tags';
    head.appendChild(tagsEl);
    return tagsEl;
}

function pickRicherEmbySeekLog(liveLog, recordLog) {
    const live = normalizeEmbySeekLog(liveLog);
    const record = normalizeEmbySeekLog(recordLog);
    if (live.length !== record.length) {
        return live.length > record.length ? live : record;
    }
    if (!live.length) return record;
    for (let i = 0; i < live.length; i += 1) {
        const left = live[i];
        const right = record[i];
        if (!right) return live;
        if (left.from_seconds !== right.from_seconds || left.to_seconds !== right.to_seconds) {
            return live;
        }
    }
    return live;
}

function pickRicherEmbySeekTimeline(liveLog, recordLog) {
    const live = normalizeEmbySeekTimeline(liveLog);
    const record = normalizeEmbySeekTimeline(recordLog);
    if (live.length !== record.length) {
        return live.length > record.length ? live : record;
    }
    if (!live.length) return record;
    for (let i = 0; i < live.length; i += 1) {
        const left = live[i];
        const right = record[i];
        if (!right) return live;
        if (
            left.direction !== right.direction
            || left.from_seconds !== right.from_seconds
            || left.to_seconds !== right.to_seconds
        ) {
            return live;
        }
    }
    return live;
}

function patchEmbyLogCardSeekBadge(cardEl, event) {
    const tagsEl = ensureEmbyLogCardTagsEl(cardEl);
    if (!tagsEl) return;

    tagsEl.querySelector('.emby-event-badge--seek-forward')?.remove();
    tagsEl.querySelector('.emby-event-badge--seek-backward')?.remove();
    tagsEl.querySelectorAll('.emby-event-badge--seek').forEach((el) => {
        if (!el.closest('.emby-seek-badge-wrap')) el.remove();
    });

    const html = buildEmbySeekBadgeHtml(event);
    const existing = tagsEl.querySelector('.emby-seek-badge-wrap');
    if (!html) {
        existing?.remove();
        return;
    }

    const insertAfter = tagsEl.querySelector('.emby-transcode-badge-wrap')
        || tagsEl.querySelector('.emby-event-badge--transcode');
    if (existing) {
        const wrap = document.createElement('span');
        wrap.innerHTML = html;
        const next = wrap.firstElementChild;
        const nextPopover = next.querySelector('.status-badge-popover');
        const existingPopover = existing.querySelector('.status-badge-popover');
        const nextLabel = next.querySelector('.emby-event-badge--seek');
        const existingLabel = existing.querySelector('.emby-event-badge--seek');
        if (
            existingLabel?.textContent !== nextLabel?.textContent
            || existingPopover?.innerHTML !== nextPopover?.innerHTML
        ) {
            const wasOpen = existing.classList.contains('is-open');
            existing.replaceWith(next);
            if (wasOpen) next.classList.add('is-open');
        }
        return;
    }

    const wrap = document.createElement('span');
    wrap.innerHTML = html;
    const badgeEl = wrap.firstElementChild;
    if (insertAfter) {
        insertAfter.insertAdjacentElement('afterend', badgeEl);
    } else {
        tagsEl.appendChild(badgeEl);
    }
}

function buildEmbyWatchStatusBadgeHtml(event) {
    if (!isEmbyPlaybackStopEvent(event.type)) return '';

    const runtime = parseInt(event.runtime_seconds, 10) || 0;
    const start = parseInt(event.start_position_seconds, 10);
    const end = parseInt(event.end_position_seconds, 10);
    if (runtime <= 0 || Number.isNaN(end) || end <= 0) return '';
    if (Number.isNaN(start)) return '';

    if (end < start && resolveEmbySeekCount(event) <= 0) {
        return '<span class="emby-session-badge emby-event-badge--watch-status">可能回退</span>';
    }
    const ratio = end / runtime;
    if (isEmbyPlaybackWatchComplete(event)) {
        return '<span class="emby-session-badge emby-event-badge--watch-status">观看完毕</span>';
    }
    return `<span class="emby-session-badge emby-event-badge--watch-status">已观看${Math.round(ratio * 100)}%</span>`;
}

function isEmbyPlaybackWatchComplete(event) {
    if (!event) return false;
    const runtime = parseInt(event.runtime_seconds, 10) || 0;
    const start = parseInt(event.start_position_seconds, 10);
    const end = parseInt(event.end_position_seconds, 10);
    if (runtime <= 0 || Number.isNaN(end) || end <= 0) return false;
    if (Number.isNaN(start)) return false;
    if (end < start && resolveEmbySeekCount(event) <= 0) return false;
    return (end / runtime) >= EMBY_WATCH_COMPLETE_RATIO;
}

function resolveEmbyContentPosition(event) {
    const endRaw = parseInt(event?.end_position_seconds, 10);
    if (!Number.isNaN(endRaw) && endRaw >= 0) return endRaw;
    const posRaw = parseInt(event?.position_seconds, 10);
    if (!Number.isNaN(posRaw) && posRaw >= 0) return posRaw;
    const startRaw = parseInt(event?.start_position_seconds, 10);
    if (!Number.isNaN(startRaw) && startRaw >= 0) return startRaw;
    return null;
}

function resolveEmbyWallClockPlayedSeconds(event, startEvent = null) {
    const startWall = startEvent?.date || startEvent?.started_at || event?.started_at;
    const stopWall = event?.date || event?.stopped_at;
    if (!startWall || !stopWall) return 0;
    const startMs = new Date(startWall).getTime();
    const stopMs = new Date(stopWall).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(stopMs) || stopMs <= startMs) return 0;
    return Math.floor((stopMs - startMs) / 1000);
}

function resolveEmbyPlayedSeconds(event, startEvent = null) {
    // 时长口径 = 墙钟：本段从开始播放到播放完毕的真实时间（started_at → stopped_at）。
    const wall = resolveEmbyWallClockPlayedSeconds(event, startEvent);
    if (wall > 0) return wall;

    const played = parseInt(event?.played_seconds, 10);
    if (!Number.isNaN(played) && played > 0) return played;

    const end = parseInt(event?.end_position_seconds, 10);
    const startPos = parseInt(event?.start_position_seconds, 10);
    if (!Number.isNaN(end) && end > 0 && !Number.isNaN(startPos) && end >= startPos) {
        return end - startPos;
    }

    if (!Number.isNaN(end) && end > 0) return end;
    return 0;
}

function buildEmbyWatchDurationBadgeHtml(event, options = {}) {
    const { startEvent = null } = options;
    if (!isEmbyPlaybackStopEvent(event.type)) return '';

    const played = resolveEmbyPlayedSeconds(event, startEvent);
    if (played <= 0) return '';

    return `<span class="emby-session-badge emby-event-badge--watch-duration">时长${formatEmbyDuration(played)}</span>`;
}

function buildEmbyEventWatchTextLine(event) {
    if (!isEmbyPlaybackStopEvent(event.type)) return '';

    const runtime = parseInt(event.runtime_seconds, 10) || 0;
    const start = parseInt(event.start_position_seconds, 10);
    const end = parseInt(event.end_position_seconds, 10);
    if (runtime <= 0 || Number.isNaN(start) || Number.isNaN(end)) return '';
    if (end <= 0) return '';

    const displayStart = Math.min(start, end);
    const pipe = '<span class="event-watch-meta-sep event-watch-meta-sep--pipe">&nbsp;|&nbsp;</span>';
    let html = `${escapeHtml(`影片时长${formatEmbyDuration(runtime)}`)}${pipe}${escapeHtml(`起止位置${formatEmbyDuration(displayStart)} - ${formatEmbyDuration(end)}`)}`;
    if (resolveEmbySeekCount(event) > 0) {
        html += escapeHtml(' 含跳转');
    }
    return `<div class="event-watch-meta emby-log-watch-progress">${html}</div>`;
}

function formatEmbyWallClockTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
}

function resolveEmbyPlaybackStartedAt(event) {
    const raw = event.started_at || event.date;
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
}

function liveSessionMatchesPlaybackRecord(rec, session) {
    if (!rec || !session) return false;
    const recItem = String(rec.item_id || '').trim();
    const liveItem = String(session.item_id || '').trim();
    if (recItem && liveItem && recItem !== liveItem) return false;
    const sid = normalizeEmbySessionId(rec.emby_session_id);
    if (sid && normalizeEmbySessionId(session.id) === sid) return true;
    const userName = String(rec.user_name || '').trim().toLowerCase();
    const sName = String(session.user_name || '').trim().toLowerCase();
    if (userName && sName && userName !== sName) return false;
    if (recItem && liveItem) return recItem === liveItem;
    return !!(recItem || sid);
}

function buildEmbyPlaybackSettleReasonBadgeHtml(rec) {
    const reason = String(rec?.settle_reason || '').trim();
    if (reason === 'emby_abnormal_disconnect') {
        return '<span class="emby-session-badge emby-event-badge--settle emby-event-badge--emby-abnormal-disconnect">Emby侧异常断开</span>';
    }
    return '';
}

function findLiveSessionForPlaybackRecord(rec) {
    if (rec?.status !== 'playing') return null;
    const instName = rec.instance_name || '';
    const inst = (cachedEmbyInstances || []).find(i => i.name === instName);
    if (!inst) return null;
    const sessions = inst.sessions || [];
    const sid = normalizeEmbySessionId(rec.emby_session_id);
    if (sid) {
        const matched = sessions.find((s) => normalizeEmbySessionId(s.id) === sid);
        if (matched && !matched.is_abnormal_disconnect && liveSessionMatchesPlaybackRecord(rec, matched)) {
            return matched;
        }
    }
    const itemId = String(rec.item_id || '').trim();
    const userName = String(rec.user_name || '').trim().toLowerCase();
    for (const session of sessions) {
        if (session.is_abnormal_disconnect) continue;
        if (!session.is_playing && !session.item_id) continue;
        if (itemId && String(session.item_id || '') !== itemId) continue;
        const sName = String(session.user_name || '').trim().toLowerCase();
        if (userName && sName && userName !== sName) continue;
        return session;
    }
    return null;
}

function resolvePlaybackRecordUploadFloor(rec) {
    const booked = Math.max(0, parseInt(rec?.estimated_upload_bytes, 10) || 0);
    const checkpoint = Math.max(0, parseInt(rec?.live_upload_checkpoint_bytes, 10) || 0);
    const floorField = Math.max(0, parseInt(rec?.estimated_upload_bytes_floor, 10) || 0);
    return Math.max(booked, checkpoint, floorField);
}

function applyEmbyPlaybackLogTrafficPeak(merged) {
    const id = String(merged?.id || '').trim();
    if (!id || merged?.status !== 'playing') {
        if (id) _embyPlaybackLogTrafficPeak.delete(id);
        return merged;
    }
    const floor = resolvePlaybackRecordUploadFloor(merged);
    const liveTotal = Math.max(
        floor,
        Math.max(0, parseInt(merged?.estimated_upload_bytes_live, 10) || 0),
    );
    const peak = _embyPlaybackLogTrafficPeak.get(id) || 0;
    if (liveTotal > 0) {
        const nextPeak = Math.max(peak, liveTotal);
        _embyPlaybackLogTrafficPeak.set(id, nextPeak);
        merged.estimated_upload_bytes_live = nextPeak;
    } else if (peak > 0) {
        merged.estimated_upload_bytes_live = peak;
        if (merged.is_paused) {
            merged.estimated_upload_bytes_1s_live = 0;
        }
    }
    return merged;
}

function syncPlaybackRecordsSeekFromLive() {
    if (!_lastPlaybackRecords.length) return;
    _lastPlaybackRecords = _lastPlaybackRecords.map((rec) => {
        if (rec?.status !== 'playing') return rec;
        return mergeLiveSessionIntoPlaybackRecord(rec);
    });
}

function mergeLiveSessionIntoPlaybackRecord(rec) {
    if (rec?.status !== 'playing') return rec;
    const inst = (cachedEmbyInstances || []).find(i => i.name === rec.instance_name);
    const live = findLiveSessionForPlaybackRecord(rec);
    if (!live && !inst) return rec;
    const merged = { ...rec };
    const liveSession = live ? enrichEmbySessionLuckyTraffic(inst, live) : null;
    if (liveSession) {
        const keys = [
            'user_id', 'user_name', 'client', 'device_name',
            'remote_endpoint', 'client_ip', 'is_remote', 'is_paused',
            'play_method', 'is_video_direct', 'is_audio_direct', 'transcode_kind',
            'runtime_seconds', 'position_seconds', 'bitrate',
            'video_codec', 'audio_codec', 'container', 'width', 'height',
            'video_bitrate', 'audio_bitrate', 'framerate', 'audio_channels',
            'transcode_reasons', 'protocol',
        ];
        keys.forEach((key) => {
            if (!(key in liveSession)) return;
            const val = liveSession[key];
            if (val === undefined || val === null) return;
            if (val === '' && typeof val !== 'boolean') return;
            merged[key] = val;
        });
        if (liveSession.progress_percent != null) {
            merged.progress_percent = liveSession.progress_percent;
        }
        if (liveSession.estimated_upload_bytes_live != null) {
            merged.estimated_upload_bytes_live = liveSession.estimated_upload_bytes_live;
        }
        if (liveSession.estimated_upload_bytes_1s_live != null) {
            merged.estimated_upload_bytes_1s_live = liveSession.estimated_upload_bytes_1s_live;
        }
        if (liveSession.estimated_upload_window_seconds_live != null) {
            merged.estimated_upload_window_seconds_live = liveSession.estimated_upload_window_seconds_live;
        }
        if (liveSession.position_seconds != null) {
            merged.end_position_seconds = Math.max(0, parseInt(liveSession.position_seconds, 10) || 0);
        }
        ['seek_count', 'seek_forward_count', 'seek_backward_count', 'played_seconds'].forEach((key) => {
            if (liveSession[key] == null) return;
            const val = parseInt(liveSession[key], 10);
            if (Number.isNaN(val) || val < 0) return;
            const prev = parseInt(merged[key], 10);
            merged[key] = Math.max(Number.isNaN(prev) ? 0 : prev, val);
        });
        ['seek_forward_log', 'seek_backward_log'].forEach((key) => {
            const picked = pickRicherEmbySeekLog(liveSession[key], merged[key]);
            if (picked.length) merged[key] = picked;
        });
        const seekTimeline = pickRicherEmbySeekTimeline(liveSession.seek_log, merged.seek_log);
        if (seekTimeline.length) merged.seek_log = seekTimeline;
        if (liveSession.playback_started_at) {
            merged.playback_started_at = liveSession.playback_started_at;
        }
    } else if (inst) {
        /* Lucky 上传展示由后端会话累加器提供，不再用 IP 全量累计覆盖 */
    }
    return applyEmbyPlaybackLogTrafficPeak(merged);
}

function buildEmbyEventWatchMetaBadge(label) {
    return `<span class="emby-session-badge emby-event-badge--watch-meta">${escapeHtml(label)}</span>`;
}

function buildEmbyEventPlayingWatchTextLine(event) {
    if (!isEmbyPlaybackStartEvent(event.type)) return '';

    const runtime = parseInt(event.runtime_seconds, 10) || 0;
    if (runtime <= 0) return '';

    const startPosRaw = parseInt(event.start_position_seconds, 10);
    const startPos = Number.isNaN(startPosRaw) ? 0 : Math.max(0, startPosRaw);
    const currentPos = resolveEmbyContentPosition(event);
    if (currentPos == null || currentPos < 0) return '';

    const text = getEmbyPlayingWatchMetaText(runtime, startPos, currentPos);
    if (!text) return '';

    return `<div class="event-watch-meta emby-log-play-watch emby-log-watch-progress" data-runtime="${runtime}"`
        + ` data-position="${currentPos}" data-start-pos="${startPos}"`
        + ` data-paused="${event.is_paused ? '1' : '0'}" data-synced="${Date.now()}">`
        + `${escapeHtml(text)}</div>`;
}

function buildEmbyEventTagsLine(event, options = {}) {
    const { includeWatch = false, startEvent = null, uploadAnyRemote = null } = options;
    if (!isEmbyPlaybackEvent(event.type)) return '';

    const badges = [];
    if (includeWatch) {
        badges.push(buildEmbyWatchStatusBadgeHtml(event));
        badges.push(buildEmbyWatchDurationBadgeHtml(event, { startEvent }));
    }
    badges.push(buildEmbySeekBadgeHtml(event));
    badges.push(buildEmbyEventNetworkBadgeHtml(event));
    badges.push(buildEmbyEventTranscodeBadgeHtml(event));
    badges.push(buildEmbyEventUploadBadgeHtml(event, { uploadAnyRemote }));

    const filtered = badges.filter(Boolean);
    if (!filtered.length) return '';
    return `<div class="event-playback-tags"><span class="emby-event-leading-badges">${filtered.join('')}</span></div>`;
}

function buildEmbyPlaybackCardTailHtml(event, options = {}) {
    const {
        includeWatch = false,
        includePlayingWatch = false,
        startEvent = null,
        uploadAnyRemote = null,
    } = options;
    let watchTextLine = '';
    if (includePlayingWatch) {
        watchTextLine = buildEmbyEventPlayingWatchTextLine(event);
    } else if (includeWatch) {
        watchTextLine = buildEmbyEventWatchTextLine(event);
    }
    const tagsLine = buildEmbyEventTagsLine(event, { includeWatch, startEvent, uploadAnyRemote });
    return watchTextLine + tagsLine;
}

function formatEmbyEstimatedUpload(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    return formatEmbyTrafficText(value);
}

function buildEmbyEventUploadBadgeHtml(event, options = {}) {
    if (!isEmbyPlaybackStopEvent(event.type)) return '';
    const uploadAnyRemote = options.uploadAnyRemote;
    const remoteOk = uploadAnyRemote != null ? uploadAnyRemote : event.is_remote;
    if (!remoteOk) return '';
    if (!isEmbyEstimateUploadEnabled(event.instance_name)) return '';
    return buildEmbyUploadTrafficBadgeHtml(
        event.instance_name,
        event.estimated_upload_bytes,
        event,
    );
}

function buildEmbyPlaybackRecordStatusBadgeHtml(rec) {
    if (!rec) return '';
    if (rec.status === 'playing') {
        const label = rec.is_paused ? '已暂停' : '播放中';
        return `<span class="emby-session-badge emby-event-badge--playback-status">${escapeHtml(label)}</span>`;
    }
    return '<span class="emby-session-badge emby-event-badge--playback-status">播放完毕</span>';
}

function buildEmbyEventTypeLine(event, options = {}) {
    const {
        includeInstance = true,
        typeLabel: customLabel = null,
        statusBadgeHtml = null,
    } = options;
    const typeLabel = customLabel
        || EMBY_EVENT_TYPE_MAP[event.type]
        || event.name
        || event.type
        || '活动';
    const leadingBadges = [];
    const userBadge = buildEmbyEventUserBadgeHtml(event);
    if (userBadge) leadingBadges.push(userBadge);
    if (statusBadgeHtml) leadingBadges.push(statusBadgeHtml);
    let line = leadingBadges.length
        ? `<span class="emby-event-leading-badges">${leadingBadges.join('')}</span> `
        : '';
    if (!statusBadgeHtml) {
        line += escapeHtml(typeLabel);
    }
    if (includeInstance && event.instance_name) {
        line += `&nbsp;·&nbsp; <b>${escapeHtml(event.instance_name)}</b>`;
    }
    if (isEmbyPlaybackEvent(event.type)) {
        const deviceName = resolveEmbyEventDeviceName(event);
        if (deviceName) line += `&nbsp;·&nbsp; ${escapeHtml(deviceName)}`;
        line += buildEmbyEventNetworkIpHtml(event);
    }
    return line;
}

function isEmbyPlaybackStartEvent(type) {
    const slug = String(type || '').toLowerCase();
    if (isEmbyPlaybackStopEvent(type)) return false;
    if (slug.includes('unpaused') || slug.includes('unpause')) return false;
    if (slug.includes('paused') || (slug.includes('pause') && !slug.includes('unpause'))) return false;
    if (slug === 'videoplayback') return true;
    if (slug.includes('.start') || slug.endsWith('start')) return true;
    return false;
}

function formatEmbyEventDateTime(dateStr) {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) {
        return String(dateStr || '').replace('T', ' ').slice(0, 19);
    }
    return d.toLocaleString('zh-CN', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function formatEmbyEventTimeOnly(dateStr) {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function buildPlaybackRecordTimeLine(rec) {
    const instName = rec.instance_name || '';
    const instSuffix = instName
        ? ` <span class="event-time-instance">${escapeHtml(instName)}</span>`
        : '';
    if (rec.status === 'playing') {
        return `${escapeHtml(formatEmbyEventDateTime(rec.started_at))}${instSuffix}`;
    }
    const startMs = new Date(rec.started_at).getTime();
    const stopMs = new Date(rec.stopped_at).getTime();
    let range;
    if (!Number.isNaN(startMs) && !Number.isNaN(stopMs)) {
        const sameDay = new Date(rec.started_at).toDateString()
            === new Date(rec.stopped_at).toDateString();
        range = sameDay
            ? `${formatEmbyEventDateTime(rec.started_at)} - ${formatEmbyEventTimeOnly(rec.stopped_at)}`
            : `${formatEmbyEventDateTime(rec.started_at)} - ${formatEmbyEventDateTime(rec.stopped_at)}`;
    } else {
        range = `${formatEmbyEventTime(rec.started_at)} - ${formatEmbyEventTime(rec.stopped_at)}`;
    }
    let suffix = '';
    if (rec.status === 'incomplete' && rec.interrupt_reason === 'timeout_offline') {
        suffix = ' <span class="emby-playback-interrupt-badge">离线中断</span>';
    }
    return `${escapeHtml(range)}${instSuffix}${suffix}`;
}

function playbackRecordAsEvent(rec) {
    const isPlaying = rec.status === 'playing';
    return {
        ...rec,
        type: isPlaying ? 'VideoPlayback' : 'VideoPlaybackStopped',
        date: isPlaying ? rec.started_at : (rec.stopped_at || rec.started_at),
    };
}

const EMBY_LOG_STATE_LABEL = {
    playing: '播放中',
    paused: '已暂停',
    interrupt: '离线中断',
    stopped: '播放完毕',
};

function syncEmbyLogCardProgressStyle(card, range) {
    if (!card || !range) return;
    const startPct = Math.max(0, Math.min(100, Number(range.startPct) || 0));
    const endPct = Math.max(startPct, Math.min(100, Number(range.endPct) || 0));
    card.style.setProperty('--emby-log-play-progress-start', `${startPct.toFixed(2)}%`);
    card.style.setProperty('--emby-log-play-progress-end', `${endPct.toFixed(2)}%`);
}

function resolvePlaybackRecordPositionRange(rec, options = {}) {
    const { allowPaused = false, ended = false } = options;
    if (!rec) return null;
    const runtime = parseInt(rec.runtime_seconds, 10) || 0;
    if (runtime <= 0) return null;

    const startRaw = parseInt(rec.start_position_seconds, 10);
    const start = Number.isNaN(startRaw) ? 0 : Math.max(0, startRaw);

    let end = null;
    if (rec.status === 'playing') {
        if (rec.is_paused && !allowPaused) return null;
        end = resolveEmbyContentPosition(rec);
    } else if (ended) {
        const endRaw = parseInt(rec.end_position_seconds, 10);
        if (!Number.isNaN(endRaw) && endRaw >= 0) {
            end = endRaw;
        } else {
            end = resolveEmbyContentPosition(rec);
        }
    } else {
        return null;
    }

    if (end == null || end < 0) return null;

    const rangeStart = Math.min(start, end);
    const rangeEnd = Math.max(start, end);
    const startPct = Math.min(
        100,
        parseFloat(formatEmbySessionPercent((rangeStart / runtime) * 100)),
    );
    const endPct = Math.min(
        100,
        Math.max(startPct, parseFloat(formatEmbySessionPercent((rangeEnd / runtime) * 100))),
    );
    return { startPct, endPct };
}

function buildPlaybackRecordProgressStyleAttr(range) {
    if (!range) return '';
    const startPct = Math.max(0, Math.min(100, Number(range.startPct) || 0));
    const endPct = Math.max(startPct, Math.min(100, Number(range.endPct) || 0));
    return ` style="--emby-log-play-progress-start: ${startPct.toFixed(2)}%; --emby-log-play-progress-end: ${endPct.toFixed(2)}%"`;
}

function resolvePlaybackRecordState(rec) {
    if (rec.status === 'playing') return rec.is_paused ? 'paused' : 'playing';
    if (rec.status === 'incomplete' && rec.interrupt_reason === 'timeout_offline') return 'interrupt';
    return 'stopped';
}

function getPlaybackRecordProgressPercent(rec, options = {}) {
    const range = resolvePlaybackRecordPositionRange(rec, options);
    if (!range) return null;
    return range.endPct;
}

function buildPlaybackRecordTimeRangeText(rec) {
    if (rec.status === 'playing') return formatEmbyEventDateTime(rec.started_at);
    const startMs = new Date(rec.started_at).getTime();
    const stopMs = new Date(rec.stopped_at).getTime();
    if (!Number.isNaN(startMs) && !Number.isNaN(stopMs)) {
        const sameDay = new Date(rec.started_at).toDateString()
            === new Date(rec.stopped_at).toDateString();
        return sameDay
            ? `${formatEmbyEventDateTime(rec.started_at)} - ${formatEmbyEventTimeOnly(rec.stopped_at)}`
            : `${formatEmbyEventDateTime(rec.started_at)} - ${formatEmbyEventDateTime(rec.stopped_at)}`;
    }
    return `${formatEmbyEventTime(rec.started_at)} - ${formatEmbyEventTime(rec.stopped_at)}`;
}

function embyLogMetaIcon(key) {
    switch (key) {
        case 'user':
            return '<svg class="emby-log-meta-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="5" r="2.6" stroke="currentColor" stroke-width="1.3"/><path d="M3.2 13c0-2.5 2.1-4 4.8-4s4.8 1.5 4.8 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
        case 'device':
            return '<svg class="emby-log-meta-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="11" height="7.5" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M6 13h4M8 10.5V13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
        case 'instance':
            return '<svg class="emby-log-meta-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="2.6" width="11" height="4" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="2.5" y="9.4" width="11" height="4" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M5 4.6h.01M5 11.4h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
        case 'ip':
            return '<svg class="emby-log-meta-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 8h11M8 2.5c1.7 1.7 1.7 9.3 0 11M8 2.5c-1.7 1.7-1.7 9.3 0 11" stroke="currentColor" stroke-width="1.3"/></svg>';
        default:
            return '';
    }
}

function buildEmbyLogMetaItem(iconKey, text, modifier) {
    const value = String(text || '').trim();
    if (!value) return '';
    return `<span class="emby-log-meta-item emby-log-meta-item--${modifier}">`
        + `${embyLogMetaIcon(iconKey)}<span class="emby-log-meta-text">${escapeHtml(value)}</span></span>`;
}

function buildEmbyLogIpMetaItem(event) {
    const ip = event.client_ip || event.remote_endpoint || '';
    if (!ip) return '';
    const masked = maskEmbyEndpointDisplay(ip);
    return `<span class="emby-log-meta-item emby-log-meta-item--ip">${embyLogMetaIcon('ip')}`
        + `<span class="emby-event-ip-wrap"><span class="emby-event-ip">${escapeHtml(masked)}</span>`
        + `<button type="button" class="emby-event-ip-toggle" aria-label="显示 IP" aria-pressed="false" data-ip="${escapeHtml(ip)}">${buildEmbyEventIpEyeIcon(false)}</button>`
        + `</span></span>`;
}

function renderPlaybackRecordCard(rec) {
    const viewRec = mergeLiveSessionIntoPlaybackRecord(rec);
    const event = playbackRecordAsEvent(viewRec);
    const startEvent = { ...event, date: viewRec.started_at, type: 'VideoPlayback' };
    const mediaEvent = resolveEmbyPlaybackMediaEvent(event, startEvent);
    const isPlaying = viewRec.status === 'playing';

    const state = resolvePlaybackRecordState(viewRec);
    const stateLabel = EMBY_LOG_STATE_LABEL[state] || '播放完毕';
    const timeText = buildPlaybackRecordTimeRangeText(viewRec);

    const titleHtml = buildEmbyEventMediaTitleHtml(mediaEvent)
        || '<span class="emby-log-card-title-text emby-log-card-title-text--empty">未知内容</span>';

    const metaItems = [
        buildEmbyLogMetaItem('user', viewRec.user_name, 'user'),
        buildEmbyLogMetaItem('device', resolveEmbyEventDeviceName(viewRec), 'device'),
        buildEmbyLogMetaItem('instance', viewRec.instance_name, 'instance'),
        buildEmbyLogIpMetaItem(viewRec),
    ].filter(Boolean).join('');
    const metaHtml = metaItems ? `<div class="emby-log-card-meta">${metaItems}</div>` : '';

    const statsText = isPlaying
        ? buildEmbyEventPlayingWatchTextLine(event)
        : buildEmbyEventWatchTextLine(event);
    const trafficHtml = isPlaying ? buildEmbyPlaybackRecordTrafficHtml(viewRec) : '';
    const statsHtml = statsText ? `<div class="emby-log-card-stats">${statsText}</div>` : '';

    const badges = [];
    if (!isPlaying) {
        badges.push(buildEmbyPlaybackSettleReasonBadgeHtml(viewRec));
        badges.push(buildEmbyWatchStatusBadgeHtml(event));
        badges.push(buildEmbyWatchDurationBadgeHtml(event, { startEvent }));
    }
    badges.push(buildEmbyEventNetworkBadgeHtml(event));
    badges.push(buildEmbyEventTranscodeBadgeHtml(event));
    badges.push(buildEmbySeekBadgeHtml(event));
    badges.push(buildEmbyEventUploadBadgeHtml(event));
    const tagHtml = badges.filter(Boolean).join('');
    const tagsHtml = tagHtml ? `<div class="emby-log-card-tags">${tagHtml}</div>` : '';

    const progressRange = (state === 'playing' || state === 'paused')
        ? resolvePlaybackRecordPositionRange(viewRec, { allowPaused: true })
        : (state === 'stopped'
            ? resolvePlaybackRecordPositionRange(viewRec, { ended: true })
            : null);
    const progressAttr = buildPlaybackRecordProgressStyleAttr(progressRange);

    const recordId = escapeHtml(String(viewRec.id || ''));

    return `
        <div class="emby-log-card emby-log-card--${state}" data-record-id="${recordId}"${progressAttr}>
            <span class="emby-log-card-rail" aria-hidden="true"></span>
            <div class="emby-log-card-body">
                <div class="emby-log-card-head">
                    <span class="emby-log-card-status">
                        <span class="emby-log-status-dot" aria-hidden="true"></span>
                        <span class="emby-log-status-text">${escapeHtml(stateLabel)}</span>
                    </span>
                    ${tagsHtml}
                </div>
                <div class="emby-log-card-divider" aria-hidden="true"></div>
                <div class="emby-log-card-time">
                    <span class="emby-log-card-time-text">${escapeHtml(timeText)}</span>
                    ${trafficHtml}
                </div>
                <div class="emby-log-card-title">${titleHtml}</div>
                ${metaHtml}
                ${statsHtml}
            </div>
        </div>`;
}

function captureEmbyLogCardIpRevealState(el) {
    const btn = el?.querySelector('.emby-event-ip-toggle[aria-pressed="true"]');
    if (!btn) return '';
    return btn.dataset.ip || '';
}

function restoreEmbyLogCardIpRevealState(el, revealedIp) {
    if (!el || !revealedIp) return;
    const btn = el.querySelector('.emby-event-ip-toggle');
    const ipEl = el.querySelector('.emby-event-ip');
    if (!btn || !ipEl || btn.dataset.ip !== revealedIp) return;
    ipEl.textContent = revealedIp;
    btn.setAttribute('aria-pressed', 'true');
    btn.setAttribute('aria-label', '隐藏 IP');
    btn.innerHTML = buildEmbyEventIpEyeIcon(true);
}

function replacePlaybackRecordCardElement(el, rec) {
    const revealedIp = captureEmbyLogCardIpRevealState(el);
    const wrap = document.createElement('div');
    wrap.innerHTML = renderPlaybackRecordCard(rec);
    const nextEl = wrap.firstElementChild;
    el.replaceWith(nextEl);
    restoreEmbyLogCardIpRevealState(nextEl, revealedIp);
    return nextEl;
}

function applyEmbyLogPlayingCardPatch(el, rec) {
    const viewRec = mergeLiveSessionIntoPlaybackRecord(rec);
    const event = playbackRecordAsEvent(viewRec);
    const state = resolvePlaybackRecordState(viewRec);

    el.classList.remove('emby-log-card--playing', 'emby-log-card--paused', 'emby-log-card--stopped', 'emby-log-card--interrupt');
    el.classList.add(`emby-log-card--${state}`);

    const progressRange = resolvePlaybackRecordPositionRange(
        viewRec,
        { allowPaused: state === 'playing' || state === 'paused' },
    );
    if (progressRange) {
        syncEmbyLogCardProgressStyle(el, progressRange);
    }

    const statusText = el.querySelector('.emby-log-status-text');
    if (statusText) {
        statusText.textContent = EMBY_LOG_STATE_LABEL[state] || '播放完毕';
    }

    const timeRow = el.querySelector('.emby-log-card-time');
    if (timeRow) {
        const trafficHtml = buildEmbyPlaybackRecordTrafficHtml(viewRec);
        const trafficEl = timeRow.querySelector('.emby-event-badge--upload');
        if (trafficHtml) {
            const wrap = document.createElement('span');
            wrap.innerHTML = trafficHtml;
            const nextTraffic = wrap.firstElementChild;
            if (trafficEl && nextTraffic) {
                trafficEl.replaceWith(nextTraffic);
            } else if (!trafficEl && nextTraffic) {
                timeRow.appendChild(nextTraffic);
            }
        } else if (trafficEl) {
            trafficEl.remove();
        }
    }

    patchEmbyLogCardSeekBadge(el, event);

    const watchEl = el.querySelector('.emby-log-play-watch');
    if (watchEl) {
        applyEmbyLogPlayingWatchEl(watchEl, event);
    } else {
        const statsEl = el.querySelector('.emby-log-card-stats');
        const statsHtml = buildEmbyEventPlayingWatchTextLine(event);
        if (statsEl && statsHtml) {
            statsEl.innerHTML = statsHtml;
        }
    }
}

function patchPlaybackRecordCard(el, rec) {
    const viewRec = mergeLiveSessionIntoPlaybackRecord(rec);
    const state = resolvePlaybackRecordState(viewRec);
    const prevState = ['playing', 'paused', 'stopped', 'interrupt'].find(
        (s) => el.classList.contains(`emby-log-card--${s}`),
    ) || 'stopped';
    if (String(el.dataset.recordId || '') !== String(rec.id || '')) {
        replacePlaybackRecordCardElement(el, rec);
        return;
    }
    if (state === 'playing' || state === 'paused') {
        applyEmbyLogPlayingCardPatch(el, rec);
        return;
    }
    if (prevState !== state) {
        replacePlaybackRecordCardElement(el, rec);
    }
}

function countLivePlayingSessionsForInstance(instanceName) {
    const inst = (cachedEmbyInstances || []).find(i => i.name === instanceName);
    if (!inst) return 0;
    return (inst.sessions || []).filter(s => s.is_playing).length;
}

function countStorePlayingRecordsForInstance(instanceName) {
    return _lastPlaybackRecords.filter(
        (rec) => rec.status === 'playing' && (rec.instance_name || '') === instanceName,
    ).length;
}

function shouldReloadPlaybackRecordsFromStore() {
    const instance = document.getElementById('embyEventInstance')?.value || '';
    if (!instance) return false;
    if (!_lastPlaybackRecords.length) {
        return countLivePlayingSessionsForInstance(instance) > 0;
    }
    const inst = (cachedEmbyInstances || []).find((item) => item.name === instance);
    const liveSessions = (inst?.sessions || []).filter((s) => s.is_playing);
    if (_lastPlaybackRecords.some((rec) => {
        if (rec.status !== 'playing') return false;
        if ((rec.instance_name || '') !== instance) return false;
        return !findLiveSessionForPlaybackRecord(rec);
    })) {
        return true;
    }
    for (const live of liveSessions) {
        const covered = _lastPlaybackRecords.some((rec) => (
            rec.status === 'playing'
            && (rec.instance_name || '') === instance
            && liveSessionMatchesPlaybackRecord(rec, live)
        ));
        if (!covered) return true;
    }
    return countLivePlayingSessionsForInstance(instance) > countStorePlayingRecordsForInstance(instance);
}

function syncEmbyPlaybackLogCardsFromLive() {
    if (!isEmbyPlaybackLogViewActive() && !isEmbyCombinedLogViewActive()) return;
    const list = getEmbyPlaybackLogListEl();
    if (!list || !_lastPlaybackRecords.length) return;
    if (!list.querySelector('.emby-log-card')) return;
    syncPlaybackRecordsSeekFromLive();
    const filtered = filterPlaybackRecordsByUser(_lastPlaybackRecords);
    const existingCards = [...list.querySelectorAll('.emby-log-card')];
    const canPatch = existingCards.length === filtered.length
        && existingCards.every((el, index) => (
            String(el.dataset.recordId || '') === String(filtered[index].id || '')
        ));
    if (canPatch) {
        filtered.forEach((rec, index) => patchPlaybackRecordCard(existingCards[index], rec));
        ensureEmbyLogPlayingTicker();
        return;
    }
    renderPlaybackRecords();
}

function renderPlaybackRecords(records) {
    const list = getEmbyPlaybackLogListEl();
    if (!list) return;
    if (records !== undefined) {
        _lastPlaybackRecords = records || [];
        if (!isEmbyCombinedLogViewActive()) {
            void refreshEmbyEventPlaybackUsers(_lastPlaybackRecords);
        }
    }
    const filtered = filterPlaybackRecordsByUser(_lastPlaybackRecords);
    if (!filtered.length) {
        const tip = _lastPlaybackRecords.length && (getEmbyEventPlaybackUser() || isEmbyEventExcludeLanEnabled())
            ? (getEmbyEventPlaybackUser() ? '该用户暂无播放记录' : '暂无匹配的外网播放记录')
            : '暂无播放记录';
        list.innerHTML = `<div class="empty-tip">${tip}</div>`;
        ensureEmbyLogPlayingTicker();
        return;
    }

    const existingCards = [...list.querySelectorAll('.emby-log-card')];
    const canPatch = existingCards.length === filtered.length
        && existingCards.every((el, index) => (
            String(el.dataset.recordId || '') === String(filtered[index].id || '')
        ));

    if (canPatch) {
        syncPlaybackRecordsSeekFromLive();
        filtered.forEach((rec, index) => patchPlaybackRecordCard(existingCards[index], rec));
    } else {
        list.innerHTML = filtered.map(renderPlaybackRecordCard).join('');
        ensureEmbyEventIpToggle();
    }
    ensureEmbyLogPlayingTicker();
}

const BROWSE_SETTLE_LABELS = {
    playback_started: '已开始播放',
    disconnect: '会话断开',
    browse_conn_end: '结束选片',
    user_switch: '用户切换结算',
    account_superseded: '账户切换结算',
    orphan_bucket: '异常兜底',
    timeout_offline: '离线中断',
    instance_reset: '实例重置',
};

function resolveBrowseSettleLabel(reason) {
    const key = String(reason || '').trim();
    return BROWSE_SETTLE_LABELS[key] || (key ? key : '选片结束');
}

function browseRecordAsEvent(rec) {
    return {
        ...rec,
        series_name: rec.series_name || '',
        episode_label: rec.episode_label || '',
        episode_title: rec.episode_title || rec.viewing_title || '',
        item_title: rec.episode_title || rec.viewing_title || '',
        production_year: rec.production_year,
        device_name: rec.device_name || '',
        client: rec.client || '',
        client_ip: rec.client_ip || '',
        instance_name: rec.instance_name || '',
        user_name: rec.user_name || '',
    };
}

function buildBrowseRecordTitleHtml(rec) {
    const event = browseRecordAsEvent(rec);
    return buildEmbyEventMediaTitleHtml(event)
        || '<span class="emby-log-card-title-text emby-log-card-title-text--empty">浏览选片</span>';
}

function buildBrowseRecordTrafficHtml(rec) {
    const bytes = Math.max(0, parseInt(rec.estimated_upload_bytes, 10) || 0);
    const minBytes = getEmbyBrowseUploadMinBytes();
    if (bytes < minBytes) return '';
    if (bytes <= 0) return '';
    const text = typeof formatEmbyTrafficText === 'function'
        ? formatEmbyTrafficText(bytes)
        : `${bytes} B`;
    const minLabel = formatEmbyBrowseUploadMinMbLabel();
    return `<span class="emby-log-card-traffic" title="选片上传（>&nbsp;${escapeHtml(minLabel)}）">已上传 ${escapeHtml(text)}</span>`;
}

function renderBrowseRecordCard(rec) {
    const stateLabel = resolveBrowseSettleLabel(rec.settle_reason);
    const timeText = formatEmbyEventDateTime(rec.stopped_at);
    const titleHtml = buildBrowseRecordTitleHtml(rec);
    const metaItems = [
        buildEmbyLogMetaItem('user', rec.user_name, 'user'),
        buildEmbyLogMetaItem('device', resolveEmbyEventDeviceName(rec), 'device'),
        buildEmbyLogMetaItem('instance', rec.instance_name, 'instance'),
        buildEmbyLogIpMetaItem(rec),
    ].filter(Boolean).join('');
    const metaHtml = metaItems ? `<div class="emby-log-card-meta">${metaItems}</div>` : '';
    const trafficHtml = buildBrowseRecordTrafficHtml(rec);
    const recordId = escapeHtml(String(rec.id || rec.segment_id || ''));

    const settleKey = String(rec.settle_reason || '').trim();
    const browseBadgeClass = settleKey === 'playback_started'
        ? 'emby-session-badge emby-session-badge--browse emby-session-badge--browse-playback-started'
        : 'emby-session-badge emby-session-badge--browse';

    return `
        <div class="emby-log-card emby-log-card--browse" data-record-id="${recordId}" data-log-kind="browse">
            <span class="emby-log-card-rail" aria-hidden="true"></span>
            <div class="emby-log-card-body">
                <div class="emby-log-card-head">
                    <span class="emby-log-card-status">
                        <span class="emby-log-status-dot" aria-hidden="true"></span>
                        <span class="emby-log-status-text">选片结束</span>
                    </span>
                    <span class="${browseBadgeClass}">${escapeHtml(stateLabel)}</span>
                </div>
                <div class="emby-log-card-divider" aria-hidden="true"></div>
                <div class="emby-log-card-time">
                    <span class="emby-log-card-time-text">${escapeHtml(timeText)}</span>
                    ${trafficHtml}
                </div>
                <div class="emby-log-card-title">${titleHtml}</div>
                ${metaHtml}
            </div>
        </div>`;
}

function renderBrowseRecords(records) {
    const list = getEmbyBrowseLogListEl();
    if (!list) return;
    if (records !== undefined) {
        _lastBrowseRecords = records || [];
        if (!isEmbyCombinedLogViewActive()) {
            void refreshEmbyEventPlaybackUsers(_lastBrowseRecords);
        }
    }
    const filtered = filterBrowseRecordsByUser(_lastBrowseRecords);
    if (!filtered.length) {
        const tip = _lastBrowseRecords.length && (getEmbyEventPlaybackUser() || isEmbyEventExcludeLanEnabled())
            ? (getEmbyEventPlaybackUser() ? '该用户暂无选片记录' : '暂无匹配的外网选片记录')
            : '暂无选片记录';
        list.innerHTML = `<div class="empty-tip">${tip}</div>`;
        return;
    }
    list.innerHTML = filtered.map(renderBrowseRecordCard).join('');
    ensureEmbyEventIpToggle();
}
