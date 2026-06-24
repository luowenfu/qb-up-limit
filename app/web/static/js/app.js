let trafficChart = null;
let chartScrollResizeObserver = null;
let chartScrollMinCategoryWidth = 24;
let chartUserCategoryWidth = null;
let chartWheelZoomCleanup = null;

let chartDatasetVisibility = [true, true];
let lastChartLegendTotals = null;
let chartViewType = 'bar';
let lastChartPayload = null;
let chartActivePresetLabel = null;
let chartRestoredPlaybackUser = null;
const VALID_CHART_VIEW_TYPES = new Set(['bar', 'line', 'pie']);
let trafficPieUpChart = null;
let trafficPieDlChart = null;
const CHART_CATEGORY_WIDTH_ABS_MIN = 2;
const CHART_MAX_VISIBLE_BARS = 800;
const CHART_WHEEL_ZOOM_FACTOR = 1.12;
const CHART_NICE_TICK_STEPS = [1, 2, 3, 5, 10, 15, 20, 25, 30, 50, 100, 150, 200];
const LINE_CHART_Y_GRACE = '12%';
const LINE_CHART_DATASET_STYLE = {
    borderWidth: 2.5,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHitRadius: 10,
    tension: 0.4,
    borderCapStyle: 'round',
    borderJoinStyle: 'round',
    fill: 'origin',
};

let autoRefreshInterval = 1;
let persistRefreshInterval = 5;
let countdownTimer = null;
let secondsUntilRefresh = 5;
let liveRefreshFallbackTicks = 0;
const LIVE_REFRESH_FALLBACK_FACTOR = 2;
let lastCollectGenerations = {};
let lastStateGenerations = {};
let currentTab = 'devices';
let currentPlatform = 'qb';
const TAB_STORAGE_KEY = 'qb-up-limit-current-tab';
const PLATFORM_STORAGE_KEY = 'qb-up-limit-current-platform';
const CHART_INSTANCE_STORAGE_KEY = 'qb-up-limit-chart-instance';
const CHART_EMBY_INSTANCE_STORAGE_KEY = 'qb-up-limit-emby-chart-instance';

function getChartPlatform() {
    if (typeof getDeviceTypeFilter === 'function' && getDeviceTypeFilter() === 'emby') {
        return 'emby';
    }
    return 'qb';
}

function isEmbyChartUploadOnly() {
    return getChartPlatform() === 'emby';
}

function syncChartLegendPlatformUi() {
    const uploadOnly = isEmbyChartUploadOnly();
    const legendPanel = document.getElementById('chartLegendPanel');
    const downloadTotal = document.getElementById('chartLegendTotalDownload');
    const downloadItem = document.querySelector('#chartLegendPanel .chart-legend-item[data-chart-dataset="1"]');
    const divider = document.querySelector('#chartLegendPanel .chart-legend-divider');
    const downloadPieGroup = document.querySelector('#chartPieLayout .chart-pie-group--download');
    const pieLayout = document.getElementById('chartPieLayout');
    if (legendPanel) legendPanel.classList.toggle('chart-legend-panel--upload-only', uploadOnly);
    if (downloadTotal) downloadTotal.hidden = uploadOnly;
    if (downloadItem) downloadItem.hidden = uploadOnly;
    if (divider) divider.hidden = uploadOnly;
    if (downloadPieGroup) downloadPieGroup.hidden = uploadOnly;
    if (pieLayout) pieLayout.classList.toggle('chart-pie-layout--upload-only', uploadOnly);
    if (uploadOnly) {
        chartDatasetVisibility = [chartDatasetVisibility[0] !== false];
    }
}

function getChartInstanceStorageKey(platform = getChartPlatform()) {
    return platform === 'emby' ? CHART_EMBY_INSTANCE_STORAGE_KEY : CHART_INSTANCE_STORAGE_KEY;
}
const CHART_ALL_DEVICES_VALUE = '__all__';
const CHART_ALL_DEVICES_LABEL = '全部设备';
const CHART_PLAYBACK_DEVICE_VALUE = '__device__';
const CHART_PLAYBACK_ALL_USERS_VALUE = '__all_users__';
const CHART_PLAYBACK_DEVICE_LABEL = '整个设备';
const CHART_PLAYBACK_ALL_USERS_LABEL = '全部用户';
const CHART_CONTROLS_STORAGE_KEY = 'qb-up-limit-chart-controls';
const EVENT_QB_INSTANCE_KEY = 'qb-up-limit-event-instance-qb';
const EVENT_EMBY_INSTANCE_KEY = 'qb-up-limit-event-instance-emby';
const SYSLOG_QB_INSTANCE_KEY = 'qb-up-limit-syslog-instance-qb';
const SYSLOG_EMBY_INSTANCE_KEY = 'qb-up-limit-syslog-instance-emby';
const EMBY_EVENT_PLAYBACK_USER_KEY = 'qb-up-limit-emby-event-playback-user';
const VALID_TABS = new Set(['devices', 'stats', 'events', 'syslogs']);
let cachedInstances = [];
let lastCardsStructureKey = '';

axios.defaults.withCredentials = true;
axios.interceptors.response.use(
    res => res,
    err => {
        if (err.response?.status === 401 && err.response?.data?.auth_required) {
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = `/login?next=${next}`;
        }
        return Promise.reject(err);
    }
);

const CHART_X_LABELS = {
    hourly: '小时',
    daily: '日期',
    weekly: '周',
    monthly: '按月',
    yearly: '年份',
    cycle: '设备周期'
};

const CHART_EMPTY_TEXT_NO_DEVICE = '暂无设备';
const CHART_EMPTY_TEXT_NO_DATA = '该时间范围内暂无流量数据';

const CHART_PERIOD_LIMITS = {
    hourly: { maxBars: 24, maxHours: 24, maxCustomHours: 366 },
    daily: { maxBars: 31, maxDays: 31, maxCustomDays: 366 },
    weekly: { maxBars: 16, maxDays: 16 * 7, maxCustomDays: 733 },
    monthly: { maxBars: 12, maxMonths: 12, maxCustomMonths: 60 },
    yearly: { maxBars: 10, maxYears: 10, maxCustomYears: 24 },
    cycle: { maxBars: 12, maxCycles: 12, maxCustomCycles: 50 },
};

const _CHART_QUICK_RANGES_BAR_LINE = {
    hourly: [
        { label: '近24小时', hours: 24 },
        { label: '今天', today: true },
        { label: '昨天', yesterday: true },
        { label: '近3天', hours: 72 },
        { label: '近6天', hours: 144 },
        { label: '本周', thisWeek: true },
        { label: '上周', lastWeek: true },
    ],
    daily: [
        { label: '近7天', days: 7 },
        { label: '本周', thisWeek: true },
        { label: '上周', lastWeek: true },
        { label: '近30天', days: 30 },
        { label: '本月', thisMonth: true },
        { label: '上月', lastMonth: true },
        { label: '近3月', approxMonths: 3 },
        { label: '近6月', approxMonths: 6 },
        { label: '今年', thisYear: true },
        { label: '去年', lastYear: true },
    ],
    monthly: [
        { label: '近6月', months: 6 },
        { label: '近12月', months: 12 },
        { label: '今年', thisYear: true },
        { label: '去年', lastYear: true },
        { label: '近3年', months: 36 },
        { label: '近5年', months: 60 },
        { label: '有史以来', allTime: true },
    ],
};

const CHART_QUICK_RANGES_BY_VIEW = {
    bar: _CHART_QUICK_RANGES_BAR_LINE,
    line: _CHART_QUICK_RANGES_BAR_LINE,
    pie: {
        hourly: [
            { label: '近24小时', hours: 24 },
            { label: '今天', today: true },
            { label: '昨天', yesterday: true },
            { label: '近3天', hours: 72 },
        ],
        daily: [
            { label: '近7天', days: 7 },
            { label: '本周', thisWeek: true },
            { label: '本月', thisMonth: true },
            { label: '上月', lastMonth: true },
            { label: '近3月', approxMonths: 3 },
        ],
        monthly: [
            { label: '近12月', months: 12 },
            { label: '今年', thisYear: true },
            { label: '去年', lastYear: true },
            { label: '近3年', months: 36 },
        ],
    },
};

function getActiveQuickRanges(viewType, period) {
    const byView = CHART_QUICK_RANGES_BY_VIEW[viewType] || CHART_QUICK_RANGES_BY_VIEW.bar;
    return byView[period] || null;
}

function pickDefaultQuickPreset(period, presets) {
    if (!presets?.length) return null;
    let defaultPreset = presets[0];
    if (period === 'hourly') {
        const yesterdayPreset = presets.find(p => p.yesterday);
        if (yesterdayPreset) defaultPreset = yesterdayPreset;
    } else if (period === 'daily') {
        const thisMonthPreset = presets.find(p => p.thisMonth);
        if (thisMonthPreset) defaultPreset = thisMonthPreset;
    } else if (period === 'monthly') {
        const thisYearPreset = presets.find(p => p.thisYear);
        if (thisYearPreset) defaultPreset = thisYearPreset;
    }
    return defaultPreset;
}

function applyChartQuickRangeDates(preset, period = document.getElementById('chartPeriod')?.value || 'hourly') {
    const range = getQuickRangeDates(period, preset);
    if (!range) return false;
    chartActivePresetLabel = preset.label;
    writeChartRangeDateInput('start', period, range.start);
    writeChartRangeDateInput('end', period, range.end);
    applyChartRangeConstraints(period);
    return true;
}

function applyDefaultChartQuickRangeForPeriod(period, viewType = chartViewType) {
    if (!CHART_QUICK_RANGE_PERIODS.has(period)) return false;
    const presets = getActiveQuickRanges(viewType, period);
    const defaultPreset = pickDefaultQuickPreset(period, presets);
    if (!defaultPreset) return false;
    return applyChartQuickRangeDates(defaultPreset, period);
}

function findChartQuickPresetByLabel(label, period = document.getElementById('chartPeriod')?.value || 'hourly') {
    const presets = getActiveQuickRanges(chartViewType, period);
    if (!presets?.length || !label) return null;
    return presets.find((preset) => preset.label === label) || null;
}

/** 非自定义时间范围时，按当前时刻重新计算已选快捷按钮对应的起止时间。 */
function reapplyActiveChartQuickPreset(options = {}) {
    if (document.getElementById('chartUseCustomRange')?.checked) return false;
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    if (!CHART_QUICK_RANGE_PERIODS.has(period)) return false;

    const presets = getActiveQuickRanges(chartViewType, period);
    if (!presets?.length) return false;

    let preset = chartActivePresetLabel
        ? findChartQuickPresetByLabel(chartActivePresetLabel, period)
        : null;
    if (!preset) {
        if (isChartQuickRangeActive()) return false;
        preset = pickDefaultQuickPreset(period, presets);
        if (!preset) return false;
        chartActivePresetLabel = preset.label;
    }

    if (!applyChartQuickRangeDates(preset, period)) return false;
    if (!options.skipButtons) syncChartRangeQuickButtons();
    if (!options.skipPersist) persistChartControls();
    return true;
}

function ensureChartQueryRangeReady() {
    if (document.getElementById('chartUseCustomRange')?.checked) return;
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    if (!CHART_QUICK_RANGE_PERIODS.has(period)) return;
    if (chartActivePresetLabel || !isChartQuickRangeActive()) {
        reapplyActiveChartQuickPreset({
            skipPersist: true,
            skipButtons: true,
        });
    }
}

const CHART_QUICK_RANGE_PERIODS = new Set(['hourly', 'daily', 'monthly']);

const VALID_CHART_PERIODS = new Set(Object.keys(CHART_PERIOD_LIMITS));

const CHART_AXIS_TICK_COLOR = '#666666';
const CHART_AXIS_TICK_FONT_SIZE = 12;
const CHART_AXIS_TITLE_FONT_SIZE = 15;
const CHART_AXIS_FONT_FAMILY = '"Noto Sans SC", "Microsoft YaHei", sans-serif';
const CHART_X_TICK_LABEL_PADDING = 10;
let chartXTickStep = 1;
let chartXTickMeasureCtx = null;

const REFRESH_INTERVAL_MIN = 1;
const REFRESH_INTERVAL_MAX = 30;

const REFRESH_COLLECT_MAP = {
    1: 5, 2: 10, 3: 15, 4: 20, 5: 25, 6: 30, 7: 35, 8: 40, 9: 45, 10: 50,
    11: 55, 12: 60, 13: 52, 14: 56, 15: 60, 16: 48, 17: 51, 18: 54, 19: 57,
    20: 60, 21: 42, 22: 44, 23: 46, 24: 48, 25: 50, 26: 52, 27: 54, 28: 56,
    29: 58, 30: 60,
};

function parseRefreshInterval(value) {
    const raw = String(value ?? '').trim();
    if (!/^\d+$/.test(raw)) return null;
    const n = parseInt(raw, 10);
    if (n < REFRESH_INTERVAL_MIN || n > REFRESH_INTERVAL_MAX) return null;
    return n;
}

function clampRefreshInterval(value) {
    return parseRefreshInterval(value) ?? REFRESH_INTERVAL_MIN;
}

const QB_MAX_UPLOAD_LIMIT_KBPS = 2097151;
const UPLOAD_LIMIT_KBPS_INPUT_SELECTOR = 'input[type="number"][name*="_limit_"]';
const UPLOAD_LIMIT_INVALID_CLASS = 'upload-limit-invalid';
const UPLOAD_LIMIT_TOAST_MS = 4000;

function uploadLimitKbpsRangeMessage(fieldLabel) {
    if (fieldLabel) {
        return `${fieldLabel} 超过最大值 ${QB_MAX_UPLOAD_LIMIT_KBPS}`;
    }
    return `超过最大值 ${QB_MAX_UPLOAD_LIMIT_KBPS}`;
}

function parseUploadLimitKbps(value) {
    const raw = String(value ?? '').trim();
    if (!/^\d+$/.test(raw)) return null;
    const n = parseInt(raw, 10);
    if (n < 0 || n > QB_MAX_UPLOAD_LIMIT_KBPS) return null;
    return n;
}

function flashUploadLimitInputInvalid(input) {
    if (!input) return;
    input.classList.remove(UPLOAD_LIMIT_INVALID_CLASS);
    void input.offsetWidth;
    input.classList.add(UPLOAD_LIMIT_INVALID_CLASS);
}

function clearUploadLimitInputInvalid(input) {
    if (!input) return;
    input.classList.remove(UPLOAD_LIMIT_INVALID_CLASS);
}

function isUploadLimitKbpsValueValid(value) {
    const raw = String(value ?? '').trim();
    if (raw === '') return true;
    return parseUploadLimitKbps(raw) !== null;
}

function notifyUploadLimitKbpsInvalid(fieldLabel = '限速') {
    showToast(uploadLimitKbpsRangeMessage(fieldLabel), 'info', UPLOAD_LIMIT_TOAST_MS);
}

function validateUploadLimitKbpsInput(input, fieldLabel = '限速', showMessage = true) {
    if (!input) return false;
    const raw = String(input.value ?? '').trim();
    if (raw === '') {
        clearUploadLimitInputInvalid(input);
        return true;
    }
    if (parseUploadLimitKbps(raw) !== null) {
        clearUploadLimitInputInvalid(input);
        return true;
    }
    if (showMessage) {
        notifyUploadLimitKbpsInvalid(fieldLabel);
    }
    flashUploadLimitInputInvalid(input);
    return false;
}

function bindUploadLimitKbpsInput(input, fieldLabel = '限速') {
    if (!input || input.dataset.uploadLimitBound) return;
    input.dataset.uploadLimitBound = '1';
    input.addEventListener('keydown', (e) => {
        if (['e', 'E', '+', '-', '.'].includes(e.key)) {
            e.preventDefault();
        }
    });
    input.addEventListener('input', () => {
        if (isUploadLimitKbpsValueValid(input.value)) {
            clearUploadLimitInputInvalid(input);
        }
    });
    input.addEventListener('blur', () => {
        validateUploadLimitKbpsInput(input, fieldLabel, true);
    });
}

function bindSpeedRulesLimitInputs(container) {
    if (!container) return;
    container.querySelectorAll(UPLOAD_LIMIT_KBPS_INPUT_SELECTOR).forEach((input, idx) => {
        bindUploadLimitKbpsInput(input, `规则 ${idx + 1}`);
    });
}

function validateSpeedRulesLimitInputs(prefix) {
    const container = document.getElementById(`${prefix}RulesContainer`);
    if (!container) return true;
    const inputs = container.querySelectorAll(UPLOAD_LIMIT_KBPS_INPUT_SELECTOR);
    for (let i = 0; i < inputs.length; i += 1) {
        if (!validateUploadLimitKbpsInput(inputs[i], `规则 ${i + 1}`, true)) {
            inputs[i].focus();
            return false;
        }
    }
    return true;
}

function validateResetLimitInput(prefix) {
    const input = document.getElementById(`${prefix}ResetLimit`);
    if (!input) return true;
    if (!validateUploadLimitKbpsInput(input, '恢复限速', true)) {
        input.focus();
        return false;
    }
    return true;
}

function validateAllUploadLimitInputs(mode) {
    if (!validateResetLimitInput('cur')) return false;
    if (!validateSpeedRulesLimitInputs('cur')) return false;
    const nextSection = document.getElementById(`${mode}NextPlanSection`);
    if (nextSection && !nextSection.hidden) {
        if (!validateResetLimitInput('next')) return false;
        if (!validateSpeedRulesLimitInputs('next')) return false;
    }
    return true;
}

function collectIntervalForRefresh(refreshInterval) {
    const refresh = parseRefreshInterval(refreshInterval);
    if (refresh === null) return REFRESH_COLLECT_MAP[REFRESH_INTERVAL_MIN];
    return REFRESH_COLLECT_MAP[refresh];
}

function bindGlobalRefreshIntervalInput(refreshInput, collectInput, initialRefresh) {
    let lastValid = parseRefreshInterval(initialRefresh) ?? REFRESH_INTERVAL_MIN;
    refreshInput.value = String(lastValid);
    collectInput.value = collectIntervalForRefresh(lastValid);

    const applyValidRefresh = (refresh) => {
        lastValid = refresh;
        refreshInput.value = String(refresh);
        collectInput.value = collectIntervalForRefresh(refresh);
    };

    const validateRefreshInput = (showMessage) => {
        const parsed = parseRefreshInterval(refreshInput.value);
        if (parsed !== null) {
            applyValidRefresh(parsed);
            return true;
        }
        if (showMessage) {
            showToast('页面刷新间隔须为 1-30 的整数');
        }
        applyValidRefresh(lastValid);
        return false;
    };

    refreshInput.addEventListener('keydown', (e) => {
        if (['e', 'E', '+', '-', '.'].includes(e.key)) {
            e.preventDefault();
        }
    });
    refreshInput.addEventListener('input', () => {
        const parsed = parseRefreshInterval(refreshInput.value);
        if (parsed !== null) {
            applyValidRefresh(parsed);
        }
    });
    refreshInput.addEventListener('change', () => validateRefreshInput(true));
    refreshInput.addEventListener('blur', () => validateRefreshInput(true));
}

const NUMBER_STEPPER_SELECTOR = 'input[type="number"][data-number-stepper]';

function getNumberInputStep(input) {
    const step = parseFloat(input.step);
    return Number.isFinite(step) && step > 0 ? step : 1;
}

function getNumberInputBounds(input) {
    const min = input.min !== '' ? parseFloat(input.min) : null;
    const max = input.max !== '' ? parseFloat(input.max) : null;
    return {
        min: Number.isFinite(min) ? min : null,
        max: Number.isFinite(max) ? max : null,
    };
}

function parseNumberInputValue(input) {
    const raw = String(input.value ?? '').trim();
    if (raw === '') return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
}

function updateNumberStepperButtons(input) {
    const wrapper = input?.closest('.number-stepper');
    if (!wrapper) return;
    const upBtn = wrapper.querySelector('.number-stepper__btn--up');
    const downBtn = wrapper.querySelector('.number-stepper__btn--down');
    const { min, max } = getNumberInputBounds(input);
    const current = parseNumberInputValue(input);
    if (upBtn) {
        upBtn.disabled = max !== null && current !== null && current >= max;
    }
    if (downBtn) {
        downBtn.disabled = min !== null && current !== null && current <= min;
    }
}

function stepNumberInputValue(input, direction) {
    if (!input || input.readOnly || input.disabled) return;
    const step = getNumberInputStep(input);
    const { min, max } = getNumberInputBounds(input);
    let current = parseNumberInputValue(input);

    if (current === null) {
        if (direction > 0) {
            current = min !== null ? min : 0;
        } else if (min !== null) {
            current = min;
        } else {
            current = 0;
        }
    } else {
        current += direction * step;
        if (Number.isInteger(step) || step >= 1) {
            current = Math.round(current);
        }
    }

    if (min !== null) current = Math.max(min, current);
    if (max !== null) current = Math.min(max, current);

    input.value = String(current);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    updateNumberStepperButtons(input);
}

function attachNumberStepper(input) {
    if (!input || input.readOnly || input.disabled || input.dataset.stepperBound) return;
    input.dataset.stepperBound = '1';

    if (!input.parentElement?.classList.contains('number-stepper')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'number-stepper';
        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(input);

        const btns = document.createElement('div');
        btns.className = 'number-stepper__btns';

        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.className = 'number-stepper__btn number-stepper__btn--up';
        upBtn.tabIndex = -1;
        upBtn.setAttribute('aria-label', '增加');

        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.className = 'number-stepper__btn number-stepper__btn--down';
        downBtn.tabIndex = -1;
        downBtn.setAttribute('aria-label', '减少');

        btns.append(upBtn, downBtn);
        wrapper.appendChild(btns);

        upBtn.addEventListener('click', (e) => {
            e.preventDefault();
            stepNumberInputValue(input, 1);
        });
        downBtn.addEventListener('click', (e) => {
            e.preventDefault();
            stepNumberInputValue(input, -1);
        });
    }

    input.addEventListener('wheel', (e) => {
        if (document.activeElement !== input) return;
        e.preventDefault();
        const direction = e.deltaY < 0 ? 1 : (e.deltaY > 0 ? -1 : 0);
        if (direction) stepNumberInputValue(input, direction);
    }, { passive: false });

    input.addEventListener('input', () => updateNumberStepperButtons(input));
    input.addEventListener('change', () => updateNumberStepperButtons(input));
    updateNumberStepperButtons(input);
}

function bindNumberSteppers(root) {
    const scope = root || document;
    scope.querySelectorAll(NUMBER_STEPPER_SELECTOR).forEach(attachNumberStepper);
}

const INSTANCE_NAME_MAX_LENGTH = 16;
const INSTANCE_HTTP_TIMEOUT = 3;
const DISPLAY_PRIORITY_MAX = 99999;

const CYCLE_TYPE_LABELS = { month: '按月', week: '按周', day: '按天' };
const CYCLE_TYPE_ICON_KEYS = { month: 'calendar', week: 'calendarWeek', day: 'clock' };
const WEEKDAY_OPTIONS = [
    { v: 1, l: '周一' }, { v: 2, l: '周二' }, { v: 3, l: '周三' },
    { v: 4, l: '周四' }, { v: 5, l: '周五' }, { v: 6, l: '周六' },
    { v: 7, l: '周日' },
];

const STEP_LABELS = {
    connect: '连接验证',
    read_limit: '① 读取限速',
    set_limit: '② 设置限速',
    verify: '③ 验证限速',
    restore: '④ 恢复限速',
    error: '异常'
};

const TEST_BTN_META = {
    connect: { id: 'ConnectTestBtn', label: '🔍 连通性测试', running: '连通性测试中...' },
    limit: { id: 'LimitTestBtn', label: '⚡ 限速测试', running: '限速测试中...' }
};

const runningInstanceTests = new Set();

document.addEventListener('DOMContentLoaded', async function() {
    const boot = window.__bootUiState;
    if (boot) {
        currentTab = boot.tab || 'devices';
    }
    try {
        const authRes = await axios.get('/api/auth/check');
        if (!authRes.data.authenticated) {
            window.location.href = '/login';
            return;
        }
    } catch (e) {
        window.location.href = '/login';
        return;
    }
    const topbarVersionEl = document.getElementById('topbarVersion');
    if (topbarVersionEl) topbarVersionEl.textContent = APP_VERSION;
    updateCurrentTime();
    setInterval(updateCurrentTime, 1000);
    updateHeaderStats([]);
    if (typeof updateEmbyHeaderStats === 'function') updateEmbyHeaderStats([]);
    ensureHourSelectOptions(document.getElementById('chartRangeStartHour'));
    ensureHourSelectOptions(document.getElementById('chartRangeEndHour'));
    setupChartRangeStartFocus();
    setupChartLegendPanel();
    setupChartFullscreen();
    window.addEventListener('pagehide', () => persistChartControls());
    window.addEventListener('beforeunload', () => persistChartControls());
    setupSpeedLimitToggleDelegation();
    setupStatusBadgePopoverClamp();
    ensureDeviceAddressToggle();
    ensureRulesHeaderActionsClick();
    if (typeof fetchEmbyFeatureConfig === 'function') {
        await fetchEmbyFeatureConfig();
    }
    await bootstrapPersistedTabControls();
    if (typeof initEmby === 'function') initEmby();
    await initAutoRefresh();
    const savedTab = boot?.tab || sessionStorage.getItem(TAB_STORAGE_KEY);
    switchTab(VALID_TABS.has(savedTab) ? savedTab : 'devices');
});

async function logout() {
    try {
        await axios.post('/api/auth/logout');
    } catch (e) { /* ignore */ }
    window.location.href = '/login';
}

function switchTab(tab) {
    if (!VALID_TABS.has(tab)) tab = 'devices';
    currentTab = tab;
    sessionStorage.setItem(TAB_STORAGE_KEY, tab);
    if (tab === 'devices' && typeof handleDevicesTabViewOnSwitch === 'function') {
        handleDevicesTabViewOnSwitch();
    }
    if (typeof isBootTabSwitch !== 'undefined' && isBootTabSwitch) {
        isBootTabSwitch = false;
    }
    const platform = typeof applyUnifiedTabPanels === 'function'
        ? applyUnifiedTabPanels(tab)
        : 'qb';
    if (typeof syncDeviceViewSwitchUi === 'function') syncDeviceViewSwitchUi();
    if (typeof syncDeviceTypeFilterControls === 'function') syncDeviceTypeFilterControls();
    if (typeof syncPlatformPanelUi === 'function' && tab !== 'devices') {
        syncPlatformPanelUi(tab);
    }
    if (tab !== 'stats' && chartFullscreenActive) {
        exitChartFullscreen();
    }
    if (typeof loadUnifiedTabContent === 'function') {
        loadUnifiedTabContent(tab, platform);
    } else if (tab === 'devices') {
        renderInstanceCards(cachedInstances, true);
    } else if (tab === 'stats') {
        chartDatasetVisibility = [true, true];
        const hasInstance = !!document.getElementById('chartInstance').value;
        if (hasInstance) {
            updateChart();
        } else {
            showChartArea(false);
            destroyTrafficCharts();
        }
    } else if (tab === 'events') {
        loadEvents();
    } else if (tab === 'syslogs') {
        if (typeof loadSyslogsForCurrentType === 'function') {
            loadSyslogsForCurrentType();
        } else {
            loadSystemLogs();
        }
    }
}

const REFRESH_RING_CIRCUMFERENCE = 97.4;

function updateRefreshHint() {
    const hintEl = document.getElementById('refreshHint');
    const secondsEl = document.getElementById('refreshSeconds');
    const ringEl = document.getElementById('refreshRingProgress');
    const badgeEl = document.getElementById('refreshBadge');
    const isRealtime = autoRefreshInterval === 1;
    const pct = autoRefreshInterval > 0
        ? (secondsUntilRefresh / autoRefreshInterval) * 100
        : 0;

    if (hintEl) {
        hintEl.textContent = isRealtime ? '实时刷新' : `剩余 ${secondsUntilRefresh} 秒`;
    }
    if (secondsEl) {
        secondsEl.textContent = isRealtime ? '' : secondsUntilRefresh;
        secondsEl.classList.toggle('refresh-seconds--live', isRealtime);
    }
    if (ringEl) {
        ringEl.style.strokeDashoffset = isRealtime
            ? '0'
            : `${-REFRESH_RING_CIRCUMFERENCE * (1 - pct / 100)}`;
    }
    if (badgeEl) {
        badgeEl.classList.toggle('topbar-refresh--realtime', isRealtime);
        badgeEl.classList.toggle('urgent', !isRealtime && secondsUntilRefresh <= 3 && secondsUntilRefresh > 0);
        badgeEl.classList.remove('refreshing');
    }
}

function updateHeaderStats(instances) {
    const list = instances || [];
    const total = list.length;
    const online = list.filter(i => i.is_online).length;
    const limited = list.filter(i =>
        i.limit_source === 'auto' || i.limit_source === 'manual'
    ).length;
    const nextPlan = list.filter(i =>
        i.has_next_cycle_plan || i.next_cycle_plan
    ).length;

    const totalEl = document.getElementById('statTotal');
    const onlineEl = document.getElementById('statOnline');
    const limitedEl = document.getElementById('statLimited');
    const nextPlanEl = document.getElementById('statNextPlan');
    if (totalEl) totalEl.textContent = total;
    if (onlineEl) onlineEl.textContent = online;
    if (limitedEl) limitedEl.textContent = limited;
    if (nextPlanEl) nextPlanEl.textContent = nextPlan;
}

function startRefreshCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    secondsUntilRefresh = autoRefreshInterval;
    liveRefreshFallbackTicks = 0;
    updateRefreshHint();
    countdownTimer = setInterval(async () => {
        secondsUntilRefresh--;
        liveRefreshFallbackTicks++;

        const badgeEl = document.getElementById('refreshBadge');
        let didRefresh = false;

        if (secondsUntilRefresh <= 0) {
            if (badgeEl) {
                badgeEl.classList.add('refreshing');
                badgeEl.classList.remove('urgent');
            }
            await refreshLiveMetrics(true);
            secondsUntilRefresh = autoRefreshInterval;
            didRefresh = true;
        }

        if (liveRefreshFallbackTicks >= persistRefreshInterval * LIVE_REFRESH_FALLBACK_FACTOR) {
            if (badgeEl) {
                badgeEl.classList.add('refreshing');
                badgeEl.classList.remove('urgent');
            }
            await refreshStatus(false, true);
            liveRefreshFallbackTicks = 0;
            didRefresh = true;
        }

        if (!didRefresh) {
            updateRefreshHint();
        }
    }, 1000);
}

async function initAutoRefresh() {
    await fetchAutoRefreshInterval();
    await refreshAll();
    startRefreshCountdown();
}

async function fetchAutoRefreshInterval() {
    try {
        const res = await axios.get('/api/config');
        if (res.data.success) {
            autoRefreshInterval = res.data.refresh_interval || 1;
            persistRefreshInterval = res.data.collect_interval || 5;
        }
    } catch (e) {
        autoRefreshInterval = 1;
        persistRefreshInterval = 5;
    }
}

function updateCurrentTime() {
    document.getElementById('currentTime').textContent =
        new Date().toLocaleString('zh-CN');
}

async function refreshAll(forceRender = false, silent = false) {
    await refreshStatus(forceRender, silent);
    if (typeof isEmbyFeatureEnabled === 'function' && isEmbyFeatureEnabled()) {
        if (typeof refreshEmbyStatus === 'function') {
            await refreshEmbyStatus(forceRender, silent);
        }
        if (typeof updateEmbyHeaderStats === 'function') {
            updateEmbyHeaderStats(cachedEmbyInstances);
        }
    }
    const contentPlatform = typeof resolveContentPlatform === 'function'
        ? resolveContentPlatform(currentTab)
        : 'qb';
    if (contentPlatform === 'emby') {
        if (currentTab === 'events' && typeof loadEmbyEvents === 'function') {
            await loadEmbyEvents(silent);
        }
        if (currentTab === 'syslogs' && typeof loadSyslogsForCurrentType === 'function') {
            await loadSyslogsForCurrentType(silent);
        }
    } else {
        if (currentTab === 'events') await loadEvents(silent);
        if (currentTab === 'syslogs' && typeof loadSyslogsForCurrentType === 'function') {
            await loadSyslogsForCurrentType(silent);
        }
    }
    if (currentTab === 'stats' && document.getElementById('chartInstance')?.value
        && typeof updateChart === 'function') {
        if (getChartPlatform() === 'emby' && typeof ensureChartPlaybackUserReady === 'function') {
            await ensureChartPlaybackUserReady();
        }
        await updateChart(silent);
    }
    if (currentTab === 'devices' && typeof renderDevicesPanel === 'function') {
        renderDevicesPanel(forceRender);
    }
    secondsUntilRefresh = autoRefreshInterval;
    liveRefreshFallbackTicks = 0;
    updateRefreshHint();
}

function syncGenerationTrackersFromInstances(instances) {
    (instances || []).forEach(inst => {
        lastCollectGenerations[inst.name] = inst.collect_generation ?? 0;
        lastStateGenerations[inst.name] = inst.state_generation ?? 0;
    });
}

function checkGenerationChanges(liveItems) {
    let needCumulative = false;
    let needState = false;
    for (const live of liveItems) {
        const collectGen = live.collect_generation ?? 0;
        const stateGen = live.state_generation ?? 0;
        if (lastCollectGenerations[live.name] === undefined) {
            lastCollectGenerations[live.name] = collectGen;
            lastStateGenerations[live.name] = stateGen;
            continue;
        }
        if (collectGen !== lastCollectGenerations[live.name]) {
            needCumulative = true;
            lastCollectGenerations[live.name] = collectGen;
        }
        if (stateGen !== lastStateGenerations[live.name]) {
            needState = true;
            lastStateGenerations[live.name] = stateGen;
        }
    }
    return { needCumulative, needState };
}

const INSTANCE_CUMULATIVE_FIELDS = [
    'cycle_uploaded_bytes', 'cycle_downloaded_bytes', 'cycle_uploaded_gb',
    'monthly_uploaded_bytes', 'monthly_downloaded_bytes',
    'today_uploaded_bytes', 'today_downloaded_bytes',
    'yesterday_uploaded_bytes', 'yesterday_downloaded_bytes',
    'device_uploaded_bytes', 'device_downloaded_bytes',
];

const INSTANCE_STATE_FIELDS = [
    'speed_rules', 'limit_source', 'is_quota_limited', 'is_limited',
    'has_upload_limit', 'manual_limit_trigger_at', 'manual_limit_trigger_kbps',
    'global_upload_limit_kbps', 'current_speed_limit_kbps',
    'alt_upload_limit_kbps', 'alt_speed_limits_active',
    'is_online', 'offline_since', 'online_since',
    'last_limit_trigger_at', 'last_limit_trigger_label',
    'has_next_cycle_plan', 'next_cycle_switch_at', 'next_cycle_plan',
    'cycle', 'reset_limit_kbps',
    'collect_generation', 'state_generation',
];

function mergeStatusIntoCache(freshInstances, flags = {}) {
    const { cumulative = false, state = false } = flags;
    freshInstances.forEach(inst => {
        const cached = cachedInstances.find(i => i.name === inst.name);
        if (!cached) return;
        if (cumulative) {
            INSTANCE_CUMULATIVE_FIELDS.forEach(key => {
                if (inst[key] !== undefined) cached[key] = inst[key];
            });
        }
        if (state) {
            INSTANCE_STATE_FIELDS.forEach(key => {
                if (inst[key] !== undefined) cached[key] = inst[key];
            });
        }
        lastCollectGenerations[inst.name] = inst.collect_generation ?? 0;
        lastStateGenerations[inst.name] = inst.state_generation ?? 0;
    });
}

function getCardByName(name) {
    const selectors = ['#instanceCards', '#instanceCardsSingle'];
    for (const selector of selectors) {
        const container = document.querySelector(selector);
        if (!container) continue;
        const card = container.querySelector(`.instance-card[data-name="${CSS.escape(name)}"]`);
        if (card) return card;
    }
    const cards = document.querySelectorAll('.instance-card:not(.instance-card--emby)');
    for (const card of cards) {
        if (card.dataset.name === name) return card;
    }
    return null;
}

async function syncStatusPatches(flags = {}) {
    const { cumulative = false, state = false } = flags;
    if (!cumulative && !state) return;
    try {
        const response = await axios.get('/api/status');
        if (!response.data.success) return;
        mergeStatusIntoCache(response.data.data, flags);
        applyStatusPatchesToCards(flags);
        if (state) updateHeaderStats(cachedInstances);
    } catch (error) {
        console.error('syncStatusPatches failed', error);
    }
}

function applyStatusPatchesToCards(flags = {}) {
    const { cumulative = false, state = false } = flags;
    sortInstancesByPriority(cachedInstances).forEach(inst => {
        const card = getCardByName(inst.name);
        if (!card) return;
        if (state) patchInstanceCardState(inst, card);
        if (cumulative) patchInstanceCardCumulative(inst, card);
    });
}

async function refreshLiveMetrics(silent = false) {
    try {
        const response = await axios.get('/api/status/live');
        if (!response.data.success) return;

        const liveItems = response.data.data || [];
        liveItems.forEach(live => {
            const inst = cachedInstances.find(i => i.name === live.name);
            if (!inst) return;
            applyLiveMetricsToInstance(inst, live);
            const card = getCardByName(live.name);
            if (card) patchInstanceCardNearMetrics(inst, card);
        });

        const { needCumulative, needState } = checkGenerationChanges(liveItems);
        if (needCumulative || needState) {
            await syncStatusPatches({
                cumulative: needCumulative,
                state: needState,
            });
        }
    } catch (error) {
        if (!silent) {
            showToast('实时指标刷新失败', 'error');
        }
    }
    if (typeof isEmbyFeatureEnabled === 'function'
        && isEmbyFeatureEnabled()
        && typeof refreshEmbyLiveMetrics === 'function') {
        await refreshEmbyLiveMetrics(silent);
    }
    secondsUntilRefresh = autoRefreshInterval;
    updateRefreshHint();
}

async function refreshStatus(forceRender = false, silent = false) {
    try {
        const response = await axios.get('/api/status');
        if (response.data.success) {
            cachedInstances = response.data.data;
            syncGenerationTrackersFromInstances(cachedInstances);
            updateHeaderStats(cachedInstances);
            updateInstanceSelects(cachedInstances);
            if (typeof markDevicesPanelDataReady === 'function') {
                markDevicesPanelDataReady('qb');
            }
            if (currentTab === 'devices' && typeof renderDevicesPanel === 'function') {
                renderDevicesPanel(forceRender);
            } else {
                renderInstanceCards(cachedInstances, forceRender);
            }
        }
    } catch (error) {
        if (!silent) {
            showToast('设备状态加载失败', 'error');
        }
    } finally {
        if (typeof markDevicesPanelDataReady === 'function') {
            markDevicesPanelDataReady('qb');
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 在线保存规则后等待后台 qB 同步完成，再多次刷新卡片 */
async function refreshStatusAfterSync() {
    const delays = [0, 350, 700, 1200, 2000];
    for (const delay of delays) {
        if (delay > 0) await sleep(delay);
        await refreshStatus(true, true);
    }
}

function formatTraffic(bytes) {
    const tb = bytes / (1024 ** 4);
    if (tb >= 1) {
        return { value: tb.toFixed(2), unit: 'TB' };
    }
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) {
        return { value: gb.toFixed(2), unit: 'GB' };
    }
    const mb = bytes / (1024 ** 2);
    return { value: mb.toFixed(2), unit: 'MB' };
}

function formatChartLegendTotalFromBytes(bytes) {
    const { value, unit } = formatTraffic(Number(bytes) || 0);
    return `${value} ${unit}`;
}

function formatChartLegendTotalFromGb(gb) {
    return formatChartLegendTotalFromBytes((Number(gb) || 0) * (1024 ** 3));
}

/** 卡片流量展示：<1MB→KB，≥1MB→MB，≥1GB→GB，≥1TB→TB */
function formatCardTraffic(bytes) {
    const n = Number(bytes) || 0;
    const tb = n / (1024 ** 4);
    if (tb >= 1) {
        return { value: tb.toFixed(2), unit: 'TB' };
    }
    const gb = n / (1024 ** 3);
    if (gb >= 1) {
        return { value: gb.toFixed(2), unit: 'GB' };
    }
    const mb = n / (1024 ** 2);
    if (mb >= 1) {
        return { value: mb.toFixed(2), unit: 'MB' };
    }
    const kb = n / 1024;
    return { value: kb.toFixed(2), unit: 'KB' };
}

function formatCardTrafficText(bytes) {
    const t = formatCardTraffic(bytes);
    return `${t.value} ${t.unit}`;
}

function getRecentDeltaWindowSeconds(inst) {
    return inst.refresh_interval ?? autoRefreshInterval ?? 1;
}

function formatRecentDeltaDisplays(inst) {
    if (!inst.is_online) {
        return { upload: '--', download: '--' };
    }
    return {
        upload: formatCardTrafficText(inst.recent_delta_bytes || 0),
        download: formatCardTrafficText(inst.recent_delta_download_bytes || 0),
    };
}

function getActiveRuleIndex(rules) {
    if (!rules?.length) return null;
    let active = null;
    for (const rule of rules) {
        if (rule.triggered && (!active || rule.threshold_gb > active.threshold_gb)) {
            active = rule;
        }
    }
    return active ? active.rule_index : null;
}

function isQuotaTriggered(rules) {
    return !!rules?.some(r => r.triggered);
}

/**
 * 判断是否处于手动限速状态：
 * 1. limit_source === 'manual'（本程序设置）
 * 2. qB 实际全局限速 ≠ 当前触发规则限速（qB 外部修改视为手动）
 */
function resolveActiveRuleAndManual(inst) {
    const activeRuleIndex = getActiveRuleIndex(inst.speed_rules);
    const activeRule = inst.speed_rules?.find(r => r.rule_index === activeRuleIndex) ?? null;
    if (inst.alt_speed_limits_active) {
        return {
            activeRuleIndex,
            activeRule,
            isManualOverride: false,
            effectiveManualKbps: null,
            isAltOverride: true,
            effectiveAltKbps: inst.alt_upload_limit_kbps ?? 0,
        };
    }
    const currentKbps = getGlobalUploadLimitKbps(inst);
    const matchesActiveRule = activeRule != null && currentKbps === activeRule.limit_kbps;
    const isExternalOverride = activeRule != null && !matchesActiveRule;
    const hasManualFlag = inst.limit_source === 'manual' || isExternalOverride;
    const isManualOverride = hasManualFlag && !matchesActiveRule;
    const effectiveManualKbps = matchesActiveRule
        ? null
        : (inst.manual_limit_trigger_kbps ?? (isExternalOverride ? currentKbps : null));
    return {
        activeRuleIndex,
        activeRule,
        isManualOverride,
        effectiveManualKbps,
        isAltOverride: false,
        effectiveAltKbps: null,
    };
}

function getCycleUploadHighlightClass(rules) {
    if (!rules?.length || !isQuotaTriggered(rules)) {
        return '';
    }
    const lastRule = rules.reduce(
        (max, rule) => (rule.threshold_gb > max.threshold_gb ? rule : max),
        rules[0]
    );
    return lastRule.triggered ? 'danger' : 'warning';
}

const PANEL_ACCENT_CLASSES = [
    'panel-accent--online',
    'panel-accent--offline',
    'panel-accent--ok',
    'panel-accent--warning',
    'panel-accent--danger',
];

function getPresencePanelAccentClass(inst) {
    return inst.is_online ? 'panel-accent--online' : 'panel-accent--offline';
}

function getQuotaPanelAccentClass(rules) {
    const highlight = getCycleUploadHighlightClass(rules);
    if (highlight === 'danger') return 'panel-accent--danger';
    if (highlight === 'warning') return 'panel-accent--warning';
    return 'panel-accent--ok';
}

function setPanelAccentClass(el, accentClass) {
    if (!el) return;
    PANEL_ACCENT_CLASSES.forEach(cls => el.classList.remove(cls));
    if (accentClass) el.classList.add(accentClass);
}

function patchInstancePanelAccents(inst, card) {
    setPanelAccentClass(
        card.querySelector('.info-panel-basic-head'),
        getPresencePanelAccentClass(inst),
    );
    setPanelAccentClass(
        card.querySelector('.info-panel-data-head'),
        getQuotaPanelAccentClass(inst.speed_rules),
    );
}

function formatTriggerDateTime(isoStr) {
    if (!isoStr) return '';
    return new Date(isoStr.replace(' ', 'T')).toLocaleString('zh-CN');
}

function formatLastLimitTrigger(inst) {
    if (!inst.last_limit_trigger_at) return '--';
    const time = formatTriggerDateTime(inst.last_limit_trigger_at);
    let label = inst.last_limit_trigger_label || '';
    if (/^手动/i.test(label)) {
        label = '手动覆盖';
    }
    return label ? `${time} ${label}` : time;
}

const POPOVER_VIEWPORT_MARGIN = 8;
let statusBadgePopoverHoverWrap = null;

function resetStatusBadgePopoverShift(popover) {
    if (!popover) return;
    popover.style.removeProperty('--popover-shift-x');
}

function clampStatusBadgePopover(wrap) {
    const popover = wrap.querySelector('.status-badge-popover');
    if (!popover) return;

    resetStatusBadgePopoverShift(popover);

    const rect = popover.getBoundingClientRect();
    if (!rect.width) return;

    const vw = document.documentElement.clientWidth;
    let shiftX = 0;

    if (rect.left < POPOVER_VIEWPORT_MARGIN) {
        shiftX = POPOVER_VIEWPORT_MARGIN - rect.left;
    } else if (rect.right > vw - POPOVER_VIEWPORT_MARGIN) {
        shiftX = (vw - POPOVER_VIEWPORT_MARGIN) - rect.right;
    }

    if (shiftX !== 0) {
        popover.style.setProperty('--popover-shift-x', `${shiftX}px`);
    }
}

function setupStatusBadgePopoverClamp() {
    document.addEventListener('mouseover', (e) => {
        const wrap = e.target.closest('.status-badge-wrap');
        if (!wrap) {
            if (statusBadgePopoverHoverWrap && !statusBadgePopoverHoverWrap.contains(e.target)) {
                resetStatusBadgePopoverShift(
                    statusBadgePopoverHoverWrap.querySelector('.status-badge-popover'),
                );
                statusBadgePopoverHoverWrap = null;
            }
            return;
        }
        if (wrap === statusBadgePopoverHoverWrap) return;
        statusBadgePopoverHoverWrap = wrap;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (statusBadgePopoverHoverWrap === wrap) {
                    clampStatusBadgePopover(wrap);
                }
            });
        });
    });

    document.addEventListener('mouseout', (e) => {
        const wrap = e.target.closest('.status-badge-wrap');
        if (!wrap) return;
        const related = e.relatedTarget;
        if (related && wrap.contains(related)) return;
        resetStatusBadgePopoverShift(wrap.querySelector('.status-badge-popover'));
        if (statusBadgePopoverHoverWrap === wrap) {
            statusBadgePopoverHoverWrap = null;
        }
    });

    window.addEventListener('resize', () => {
        if (statusBadgePopoverHoverWrap) {
            clampStatusBadgePopover(statusBadgePopoverHoverWrap);
        }
    });
}

function wrapStatusBadgePopover(badgeHtml, popoverHtml, variant = '') {
    if (!popoverHtml) {
        return badgeHtml;
    }
    const variantClass = variant ? ` status-badge-wrap--${variant}` : '';
    return `
        <span class="status-badge-wrap${variantClass}">
            ${badgeHtml}
            <span class="status-badge-popover" role="tooltip">${popoverHtml}</span>
        </span>`;
}

function buildTriggeredPopoverContent(inst) {
    const { activeRuleIndex, activeRule, isManualOverride, effectiveManualKbps } =
        resolveActiveRuleAndManual(inst);
    const showManualSection = isManualOverride;

    let ruleTime = '--';
    let ruleLabel = '--';
    let ruleDetailHtml = '';

    if (activeRule) {
        ruleTime = activeRule.triggered_at
            ? formatTriggerDateTime(activeRule.triggered_at)
            : '--';
        ruleLabel = `规则${activeRule.rule_index}`;
        ruleDetailHtml = `
            <div class="badge-popover-rule">≥ ${activeRule.threshold_gb} GB → ${activeRule.limit_kbps} KB/s</div>`;
    } else {
        const raw = inst.last_limit_trigger_at;
        ruleTime = raw ? formatTriggerDateTime(raw) : '--';
        let label = inst.last_limit_trigger_label || '--';
        if (/^手动/i.test(label)) {
            label = '--';
        }
        ruleLabel = label;
    }

    const ruleSectionHtml = `
        <div class="badge-popover-title">最近触发</div>
        <div class="badge-popover-meta">${escapeHtml(ruleTime)}</div>
        <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(ruleLabel)}</div>
        ${ruleDetailHtml}`;

    if (!showManualSection) {
        return ruleSectionHtml;
    }

    const manualTime = inst.manual_limit_trigger_at
        ? formatTriggerDateTime(inst.manual_limit_trigger_at)
        : '--';
    const limitText = (effectiveManualKbps ?? 0) > 0 ? `${effectiveManualKbps} KB/s` : '无限速';

    return `${ruleSectionHtml}
        <div class="badge-popover-divider badge-popover-divider--partial"></div>
        <div class="badge-popover-title">手动覆盖</div>
        <div class="badge-popover-meta">${escapeHtml(manualTime)}</div>
        <div class="badge-popover-rule">手动限速 ${limitText}</div>`;
}

function buildOfflinePopoverContent(inst) {
    const raw = inst.offline_since || inst.last_seen || '';
    const time = raw ? formatTriggerDateTime(raw) : '--';
    const dataStart = inst.data_start_time ? formatTriggerDateTime(inst.data_start_time) : '--';
    return `
        <div class="badge-popover-title">设备离线</div>
        <div class="badge-popover-meta">最近离线时间</div>
        <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(time)}</div>
        <div class="badge-popover-divider badge-popover-divider--partial"></div>
        <div class="badge-popover-meta">数据起始时间</div>
        <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(dataStart)}</div>`;
}

function buildOnlinePopoverContent(inst) {
    const raw = inst.online_since || '';
    const time = raw ? formatTriggerDateTime(raw) : '--';
    const dataStart = inst.data_start_time ? formatTriggerDateTime(inst.data_start_time) : '--';
    return `
        <div class="badge-popover-title">设备在线</div>
        <div class="badge-popover-meta">最近上线时间</div>
        <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(time)}</div>
        <div class="badge-popover-divider badge-popover-divider--partial"></div>
        <div class="badge-popover-meta">数据起始时间</div>
        <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(dataStart)}</div>`;
}

function buildAddressEndpointHTML(inst) {
    const statusClass = inst.is_online ? 'online' : 'offline';
    const popoverHtml = inst.is_online
        ? buildOnlinePopoverContent(inst)
        : buildOfflinePopoverContent(inst);
    const iconHtml = `
        <span class="info-section-icon info-section-icon--endpoint info-endpoint-icon info-endpoint-icon--${statusClass}" aria-label="${inst.is_online ? '设备在线' : '设备离线'}" tabindex="0">
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

function buildInstancePriorityBadgeHTML(inst) {
    const priorityNo = inst.display_priority ?? '?';
    return `<span class="instance-priority-badge" title="显示优先级 ${priorityNo}" aria-label="显示优先级 ${priorityNo}">${priorityNo}</span>`;
}

function buildInstanceServiceIconHTML(service) {
    if (service === 'emby') {
        return `<span class="instance-service-icon instance-service-icon--emby" aria-hidden="true" title="Emby">
            <img src="/static/img/emby-icon.svg" alt="" class="instance-service-icon-img">
        </span>`;
    }
    return `<span class="instance-service-icon instance-service-icon--qb" aria-hidden="true" title="qBittorrent">
        <img src="/static/img/qbittorrent-logo.svg" alt="" class="instance-service-icon-img">
    </span>`;
}

function isChartAllDevicesValue(value) {
    return value === CHART_ALL_DEVICES_VALUE;
}

function getChartInstancesForPlatform(platform = getChartPlatform()) {
    const instances = platform === 'emby'
        ? (typeof cachedEmbyInstances !== 'undefined' ? cachedEmbyInstances : [])
        : cachedInstances;
    return instances || [];
}

function getChartInstanceNamesForPlatform(platform = getChartPlatform()) {
    const instances = getChartInstancesForPlatform(platform);
    const sorted = platform === 'emby' && typeof sortEmbyInstances === 'function'
        ? sortEmbyInstances(instances)
        : sortInstancesByPriority(instances);
    return sorted.map(inst => inst.name);
}

function aggregateChartStatsRows(rowsList, period) {
    const map = new Map();
    rowsList.forEach(rows => {
        (rows || []).forEach(row => {
            const key = String(getChartRowLabel(row, period));
            const existing = map.get(key);
            if (existing) {
                existing.total_bytes = (existing.total_bytes || 0) + (row.total_bytes || 0);
                existing.backfilled_bytes = (existing.backfilled_bytes || 0) + (row.backfilled_bytes || 0);
            } else {
                map.set(key, {
                    ...row,
                    total_bytes: row.total_bytes || 0,
                    backfilled_bytes: row.backfilled_bytes || 0,
                });
            }
        });
    });
    return [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, row]) => row);
}

async function fetchChartDirectionData(instanceName, platform, period, params, direction, playbackUser) {
    if (platform === 'emby') {
        if (isChartPlaybackAllUsersValue(playbackUser)) {
            const res = await axios.get(
                `/api/emby/playback-stats/${encodeURIComponent(instanceName)}/${period}`,
                { params: { ...params, user: CHART_PLAYBACK_ALL_USERS_VALUE } },
            );
            if (!res.data.success) return null;
            return normalizePlaybackStatsPayload(res.data.data, period, playbackUser);
        }
        if (isChartPlaybackUserQuery(playbackUser)) {
            const res = await axios.get(
                `/api/emby/playback-stats/${encodeURIComponent(instanceName)}/${period}`,
                { params: { ...params, user: playbackUser } },
            );
            if (!res.data.success) return null;
            return normalizePlaybackStatsPayload(res.data.data, period, playbackUser);
        }
        const base = `/api/emby/stats/${encodeURIComponent(instanceName)}/${period}`;
        const res = await axios.get(base, { params: { ...params, direction } });
        if (!res.data.success) return null;
        return res.data.data;
    }
    const base = `/api/stats/${encodeURIComponent(instanceName)}/${period}`;
    const res = await axios.get(base, { params: { ...params, direction } });
    if (!res.data.success) return null;
    return res.data.data;
}

async function fetchChartUploadDownload(instanceName, platform, period, params, playbackUser) {
    const uploadData = await fetchChartDirectionData(
        instanceName, platform, period, params, 'upload', playbackUser,
    );
    if (!uploadData) return null;
    let downloadData = [];
    if (platform !== 'emby') {
        downloadData = await fetchChartDirectionData(
            instanceName, platform, period, params, 'download', playbackUser,
        ) || [];
    }
    return { uploadData, downloadData };
}

function buildChartInstanceTitleHTML(instanceName, service = 'qb', playbackLabel = null) {
    const name = String(instanceName ?? '').trim();
    if (!name) return '';
    if (isChartAllDevicesValue(name)) {
        return `${buildInstanceServiceIconHTML(service)}<span class="chart-instance-title-text">${escapeHtml(CHART_ALL_DEVICES_LABEL)}</span>`;
    }
    let titleText = escapeHtml(name);
    if (service === 'emby') {
        const suffix = String(playbackLabel ?? '').trim() || CHART_PLAYBACK_DEVICE_LABEL;
        titleText += ` - ${escapeHtml(suffix)}`;
    }
    return `${buildInstanceServiceIconHTML(service)}<span class="chart-instance-title-text">${titleText}</span>`;
}

function isChartPlaybackDeviceValue(value) {
    const v = String(value ?? '').trim();
    return !v || v === CHART_PLAYBACK_DEVICE_VALUE;
}

function isChartPlaybackAllUsersValue(value) {
    return String(value ?? '').trim() === CHART_PLAYBACK_ALL_USERS_VALUE;
}

function isChartPlaybackUserQuery(value) {
    const v = String(value ?? '').trim();
    return !!v && !isChartPlaybackDeviceValue(v) && !isChartPlaybackAllUsersValue(v);
}

function migrateChartPlaybackUserValue(value) {
    const v = String(value ?? '').trim();
    if (!v) return CHART_PLAYBACK_DEVICE_VALUE;
    return v;
}

function getPersistedChartPlaybackUser() {
    try {
        const raw = sessionStorage.getItem(CHART_CONTROLS_STORAGE_KEY);
        if (!raw) return null;
        const state = JSON.parse(raw);
        if ('playbackUser' in state) {
            return migrateChartPlaybackUserValue(state.playbackUser);
        }
    } catch (e) { /* ignore */ }
    return null;
}

function resolveChartPlaybackUserPrev(select) {
    if (chartRestoredPlaybackUser != null) {
        return migrateChartPlaybackUserValue(chartRestoredPlaybackUser);
    }
    const persisted = getPersistedChartPlaybackUser();
    if (persisted != null) return persisted;
    return migrateChartPlaybackUserValue(select?.value);
}

function getChartPlaybackUserDisplayLabel(value) {
    if (isChartPlaybackDeviceValue(value)) return CHART_PLAYBACK_DEVICE_LABEL;
    if (isChartPlaybackAllUsersValue(value)) return CHART_PLAYBACK_ALL_USERS_LABEL;
    return String(value ?? '').trim() || CHART_PLAYBACK_DEVICE_LABEL;
}

function buildChartPlaybackUserSelectOptions() {
    const select = document.getElementById('chartPlaybackUser');
    if (!select) return;
    select.innerHTML = '';
    const deviceOpt = document.createElement('option');
    deviceOpt.value = CHART_PLAYBACK_DEVICE_VALUE;
    deviceOpt.textContent = CHART_PLAYBACK_DEVICE_LABEL;
    select.appendChild(deviceOpt);
    const allUsersOpt = document.createElement('option');
    allUsersOpt.value = CHART_PLAYBACK_ALL_USERS_VALUE;
    allUsersOpt.textContent = CHART_PLAYBACK_ALL_USERS_LABEL;
    select.appendChild(allUsersOpt);
}

function getChartPlaybackUserTitleSuffix() {
    if (getChartPlatform() !== 'emby') return null;
    if (_chartPlaybackUsersReady) {
        return getChartPlaybackUserDisplayLabel(getChartPlaybackUserSelection());
    }
    if (chartRestoredPlaybackUser != null) {
        return getChartPlaybackUserDisplayLabel(chartRestoredPlaybackUser);
    }
    const persisted = getPersistedChartPlaybackUser();
    if (persisted != null) {
        return getChartPlaybackUserDisplayLabel(persisted);
    }
    return getChartPlaybackUserDisplayLabel(getChartPlaybackUserSelection());
}

function onChartPlaybackUserChange() {
    chartRestoredPlaybackUser = getChartPlaybackUserSelection();
    syncChartPlaybackUserPeriodOptions();
    syncChartInstanceTitle(document.getElementById('chartInstance')?.value || '');
    persistChartControls();
    updateChart();
}

function buildNextPlanPopoverContent(inst) {
    const plan = inst.next_cycle_plan;
    if (!plan) {
        return '';
    }
    const cycle = plan.cycle || {};
    const rules = plan.speed_rules || [];
    const resetText = formatCycleUploadResetLabel(
        cycle,
        cycle.reset_limit_kbps ?? 0,
    );
    const switchAt = inst.next_cycle_switch_at || '';
    const rulesHtml = rules.map((rule, idx) => {
        const threshold = rule.cycle_upload_limit_gb ?? rule.threshold_gb ?? 0;
        const limit = rule.speed_limit_kbps ?? rule.limit_kbps ?? 0;
        return `<div class="badge-popover-rule">规则 ${idx + 1}：≥ ${threshold} GB → ${limit} KB/s</div>`;
    }).join('');
    return `
        <div class="badge-popover-title">下周期计划预览</div>
        ${switchAt ? `<div class="badge-popover-meta">将于 ${escapeHtml(switchAt)} 生效</div>` : ''}
        <div class="badge-popover-meta">${escapeHtml(resetText)}</div>
        ${rulesHtml ? `<div class="badge-popover-divider"></div>${rulesHtml}` : ''}`;
}

function formatRuleRemainingText(rule, cycleUploadedGb) {
    const remaining = Math.max(0, rule.threshold_gb - (cycleUploadedGb ?? 0));
    const remainingStr = Number.isInteger(remaining)
        ? String(remaining)
        : remaining.toFixed(2).replace(/\.?0+$/, '');
    return `剩余 ${remainingStr} GB`;
}

function formatRuleLimitText(rule) {
    return `限速 ${rule.limit_kbps} KB/s`;
}

function buildRuleActiveArrowHtml() {
    return '<span class="rule-active-arrow" aria-hidden="true">'
        + '<svg class="rule-active-arrow__icon" viewBox="0 0 16 12" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<path d="M1 6h9" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/>'
        + '<path d="M8 2.5L13 6 8 9.5" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg></span>';
}

function buildTriggeredRuleMetaHtml(statusClass, label, timeStr, limitHtml, labelIsHtml = false) {
    const labelContent = labelIsHtml ? label : escapeHtml(label);
    return `<div class="rule-meta-triggered ${statusClass}">
        <div class="rule-note rule-note--left">${limitHtml}</div>
        <div class="rule-meta-status">
            <span class="rule-status-time">${escapeHtml(timeStr)}</span>
            <span class="rule-status-label">${labelContent}</span>
        </div>
    </div>`;
}

function getRuleProgressFillClass(rule, rules) {
    if (!rule.triggered) return '';
    return getCycleUploadHighlightClass(rules) || 'warning';
}

function buildRuleItemHTML(
    rule,
    activeRuleIndex,
    isManualOverride,
    cycleUploadedGb,
    manualTriggerAt,
    manualLimitKbps,
    rules,
    isAltOverride = false,
    altLimitKbps = null,
) {
    const pct = rule.progress;
    const ruleNo = rule.rule_index || 1;
    const isActive = activeRuleIndex != null && rule.rule_index === activeRuleIndex;
    const fillClass = getRuleProgressFillClass(rule, rules);
    const itemClass = ['rule-item', isActive ? 'rule-item-active' : ''].filter(Boolean).join(' ');
    let metaHtml = '';
    let noteArrowHtml = '';
    const limitText = formatRuleLimitText(rule);
    if (isActive) {
        const manualMatchesRule = isManualOverride
            && manualLimitKbps != null
            && rule.limit_kbps != null
            && manualLimitKbps === rule.limit_kbps;
        const isManualActive = isManualOverride && !manualMatchesRule;
        const isAltActive = isAltOverride;
        const manualSpeedText = (manualLimitKbps ?? 0) > 0
            ? `${manualLimitKbps}KB/s`
            : '无限速';
        const altSpeedText = (altLimitKbps ?? 0) > 0
            ? `${altLimitKbps}KB/s`
            : '无限速';
        const activeLabel = isManualActive
            ? `最近触发${buildRuleActiveArrowHtml()}手动覆盖${manualSpeedText}`
            : isAltActive
            ? `最近触发${buildRuleActiveArrowHtml()}备用覆盖${altSpeedText}`
            : '最近触发';
        const timeStr = isManualActive
            ? formatTriggerDateTime(manualTriggerAt)
            : formatTriggerDateTime(rule.triggered_at);
        if (!isManualActive && !isAltActive) {
            noteArrowHtml = buildRuleActiveArrowHtml();
        }
        metaHtml = buildTriggeredRuleMetaHtml(
            'rule-status-active',
            activeLabel,
            timeStr,
            `${noteArrowHtml}${limitText}`,
            isManualActive || isAltActive,
        );
    } else if (rule.triggered) {
        const triggeredTime = formatTriggerDateTime(rule.triggered_at);
        metaHtml = buildTriggeredRuleMetaHtml(
            'rule-status-triggered',
            '已触发',
            triggeredTime,
            limitText,
        );
    } else {
        metaHtml = `
            <div class="rule-note rule-note--left">${limitText}</div>
            <div class="rule-note rule-note--right">${formatRuleRemainingText(rule, cycleUploadedGb)}</div>`;
    }
    return `
        <div class="${itemClass}">
            <div class="rule-header">
                <span>规则${ruleNo} · 阈值 ${rule.threshold_gb} GB</span>
                <span>${pct}%</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill ${fillClass}" style="width:${pct}%"></div>
            </div>
            <div class="rule-meta">
                ${metaHtml}
            </div>
        </div>`;
}

function buildTrafficStatsBlockHTML(deviceUpload, deviceDownload) {
    return `
        <div class="traffic-stats-block">
            <div class="traffic-stat-row">
                <span class="traffic-stat-label">设备总上传</span>
                <span class="traffic-stat-value">${deviceUpload}</span>
            </div>
            <div class="traffic-stat-row">
                <span class="traffic-stat-label">设备总下载</span>
                <span class="traffic-stat-value">${deviceDownload}</span>
            </div>
        </div>`;
}

const INFO_METRIC_ICONS = {
    limit: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9 2.2L4.2 9h3.2l-1 4.8L12.8 7H9.6L11 2.2H9z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
    calendar: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3.2" width="12" height="10.8" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M5 2.2v2M11 2.2v2M2 6.8h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    calendarWeek: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3.2" width="12" height="10.8" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M5 2.2v2M11 2.2v2M2 6.8h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M3.2 10.4v1.6M4.6 10.4v1.6M6 10.4v1.6M7.4 10.4v1.6M8.8 10.4v1.6M10.2 10.4v1.6M11.6 10.4v1.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`,
    clock: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8.5" r="5.2" stroke="currentColor" stroke-width="1.3"/><path d="M8 5.8v3.2l2.2 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    plan: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.5 5.2A4.2 4.2 0 0 0 4.8 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M3.8 3.5v2.2h2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 10.8A4.2 4.2 0 0 0 11.2 11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12.2 12.5v-2.2h-2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    upload: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 11.2V3.2M5.2 6.4L8 3.6l2.8 2.8" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.2 12.8h9.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>`,
    download: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 4.8v7.2M5.2 9.6L8 12.4l2.8-2.8" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.2 12.8h9.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>`,
};

function buildInfoMetricIcon(type) {
    const svg = INFO_METRIC_ICONS[type];
    if (!svg) return '';
    return `<span class="info-metric-icon info-metric-icon--${type}">${svg}</span>`;
}

function buildInfoMetricCell(label, value, options = {}) {
    const {
        labelClass = '',
        valueClass = '',
        metricClass = '',
        icon = '',
        group = '',
    } = options;
    const groupClass = group ? ` info-metric--group-${group}` : '';
    return `
        <div class="info-metric${metricClass ? ` ${metricClass}` : ''}${groupClass}">
            <div class="info-metric-top">
                ${icon ? buildInfoMetricIcon(icon) : ''}
                <span class="info-metric-label${labelClass ? ` ${labelClass}` : ''}">${label}</span>
            </div>
            <span class="info-metric-value${valueClass ? ` ${valueClass}` : ''}">${value}</span>
        </div>`;
}

function buildInfoMetricRow(label, value, options = {}) {
    const {
        labelClass = '',
        valueClass = '',
        metricClass = '',
        icon = '',
    } = options;
    return `
        <div class="info-metric${metricClass ? ` ${metricClass}` : ''}">
            <div class="info-metric-row-label">
                ${icon ? buildInfoMetricIcon(icon) : ''}
                <span class="info-metric-label${labelClass ? ` ${labelClass}` : ''}">${label}</span>
            </div>
            <span class="info-metric-value${valueClass ? ` ${valueClass}` : ''}">${value}</span>
        </div>`;
}

function buildInstanceInfoHTML(inst, metrics) {
    const {
        address,
        recentWindowSec,
        recentUpload,
        recentDownload,
        yesterdayUpload,
        yesterdayDownload,
        todayUpload,
        todayDownload,
        cycleUpload,
        cycleDownload,
        uploadTriggeredClass,
        cycleRangeText,
        cyclePlanText,
        speedToggleHTML,
    } = metrics;

    const presenceAccent = getPresencePanelAccentClass(inst);
    const quotaAccent = getQuotaPanelAccentClass(inst.speed_rules);

    return `
        <div class="info-panel">
            <div class="info-panel-basic">
                <div class="info-panel-section-head info-panel-basic-head ${presenceAccent}">
                    ${buildAddressEndpointHTML(inst)}
                    <span class="info-panel-basic-head-address">${buildDeviceAddressMaskHtml(address)}</span>
                </div>
                <div class="info-panel-inline info-panel-table">
                    ${buildInfoMetricRow('当前上传限速', speedToggleHTML, {
                        metricClass: 'info-metric--row info-metric--limit',
                        valueClass: 'info-value-speed-toggle',
                        icon: 'limit',
                    })}
                    ${buildInfoMetricRow('当前周期范围', cycleRangeText, {
                        metricClass: 'info-metric--row info-metric--cycle',
                        valueClass: 'info-value-cycle-range',
                        icon: 'calendar',
                    })}
                    ${buildInfoMetricRow('当前周期计划', cyclePlanText, {
                        metricClass: 'info-metric--row info-metric--cycle info-metric--cycle-plan',
                        valueClass: 'info-value-cycle-plan',
                        icon: 'plan',
                    })}
                </div>
            </div>
            <div class="info-panel-data">
                <div class="info-panel-section-head info-panel-data-head ${quotaAccent}">
                    <span class="info-section-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" fill="none">
                            <path d="M2 12V6.5l6-3.5 6 3.5V12" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                            <path d="M5.5 12V9.2L8 7.8l2.5 1.4V12" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                        </svg>
                    </span>
                    <span class="info-section-title">流量数据</span>
                </div>
                <div class="info-panel-grid">
                    ${buildInfoMetricCell(`近 ${recentWindowSec} 秒上传`, recentUpload, {
                        labelClass: 'info-metric-label-recent-up',
                        valueClass: 'info-value-recent-delta-up info-metric-value--speed',
                    })}
                    ${buildInfoMetricCell(`近 ${recentWindowSec} 秒下载`, recentDownload, {
                        labelClass: 'info-metric-label-recent-down',
                        valueClass: 'info-value-recent-delta-down info-metric-value--speed',
                    })}
                    ${buildInfoMetricCell('今日上传', todayUpload, {
                        valueClass: 'info-value-today-upload info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('今日下载', todayDownload, {
                        valueClass: 'info-value-today-download info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('昨日上传', yesterdayUpload, {
                        valueClass: 'info-value-yesterday-upload info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('昨日下载', yesterdayDownload, {
                        valueClass: 'info-value-yesterday-download info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('周期内上传', cycleUpload, {
                        valueClass: `info-value-cycle-upload info-metric-value--live ${uploadTriggeredClass}`.trim(),
                    })}
                    ${buildInfoMetricCell('周期内下载', cycleDownload, {
                        valueClass: 'info-value-cycle-download info-metric-value--live',
                    })}
                    ${buildInfoMetricCell('设备总上传', metrics.deviceUpload, {
                        valueClass: 'info-value-device-upload info-metric-value--total',
                    })}
                    ${buildInfoMetricCell('设备总下载', metrics.deviceDownload, {
                        valueClass: 'info-value-device-download info-metric-value--total',
                    })}
                </div>
            </div>
        </div>`;
}

function buildEventLogNavIconSvg() {
    return `<svg class="rules-header-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M4 4h12v10H4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M7 8h6M7 11h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
}

function buildStatsNavIconSvg() {
    return `<svg class="rules-header-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M3 16V10M7 16V6M11 16V9M15 16V4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
}

function buildInstanceChartButtonHtml(service, instanceName) {
    const safeName = escapeHtml(instanceName || '');
    const title = safeName ? `查看 ${safeName} 流量图表` : '查看流量图表';
    return `<button type="button" class="rules-header-action-btn" data-action="open-chart" data-chart-service="${service}" data-chart-instance="${safeName}" title="${title}" aria-label="${title}">${buildStatsNavIconSvg()}</button>`;
}

function buildInstanceEventLogButtonHtml(service, instanceName) {
    const safeName = escapeHtml(instanceName || '');
    const title = safeName ? `查看 ${safeName} 事件日志` : '查看事件日志';
    return `<button type="button" class="rules-header-action-btn" data-action="open-events" data-event-service="${service}" data-event-instance="${safeName}" title="${title}" aria-label="${title}">${buildEventLogNavIconSvg()}</button>`;
}

function buildRulesHeaderActionsHtml(service, instanceName) {
    return `<div class="rules-header-actions">`
        + buildInstanceChartButtonHtml(service, instanceName)
        + buildInstanceEventLogButtonHtml(service, instanceName)
        + `</div>`;
}

function buildRulesBlockHTML(
    rules,
    activeRuleIndex,
    isManualOverride,
    cycleUploadedGb,
    manualTriggerAt,
    manualLimitKbps,
    isAltOverride = false,
    altLimitKbps = null,
    instanceName = '',
) {
    const headerActions = buildRulesHeaderActionsHtml('qb', instanceName);
    if (!rules.length) {
        return `<div class="rules-header">
            <span class="rules-title">达量限速规则</span>
            ${headerActions}
        </div><div class="rules-empty">暂无规则</div>`;
    }

    const rulesHTML = rules.map(rule =>
        buildRuleItemHTML(
            rule,
            activeRuleIndex,
            isManualOverride,
            cycleUploadedGb,
            manualTriggerAt,
            manualLimitKbps,
            rules,
            isAltOverride,
            altLimitKbps,
        )
    ).join('');

    return `
        <div class="rules-header">
            <span class="rules-title">达量限速规则 (${rules.length})</span>
            ${headerActions}
        </div>
        <div class="rules-list-panel">
            <div class="rules-list-scroll">
                <div class="rules-list">${rulesHTML}</div>
            </div>
            <div class="rules-list-rail" hidden aria-hidden="true">
                <div class="rules-list-rail-thumb"></div>
            </div>
        </div>`;
}

function getRulesListPanelRail(panel) {
    if (!panel) return { rail: null, thumb: null };
    const rail = panel.querySelector(':scope > .rules-list-rail');
    const thumb = rail?.querySelector('.rules-list-rail-thumb') || null;
    return { rail, thumb };
}

function engageRulesListRail(scrollEl) {
    const panel = scrollEl.closest('.rules-list-panel');
    if (!panel) return;
    panel.classList.add('rules-list-panel--engaged');
    if (panel._rulesRailHideTimer) {
        clearTimeout(panel._rulesRailHideTimer);
    }
    panel._rulesRailHideTimer = setTimeout(() => {
        panel.classList.remove('rules-list-panel--engaged');
        panel._rulesRailHideTimer = null;
    }, 900);
}

function syncRulesListRail(scrollEl) {
    const panel = scrollEl.closest('.rules-list-panel');
    const { rail, thumb } = getRulesListPanelRail(panel);
    if (!rail || !thumb) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    if (scrollHeight <= clientHeight + 1) {
        rail.hidden = true;
        return;
    }

    rail.hidden = false;
    const thumbHeight = Math.max(20, (clientHeight / scrollHeight) * clientHeight);
    const maxTop = clientHeight - thumbHeight;
    const top = maxTop <= 0 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${top}px)`;
}

function getMobileRulesListMaxHeight(scrollEl) {
    const items = scrollEl.querySelectorAll('.rule-item');
    if (!items.length) return 0;

    const visibleCount = Math.min(4, items.length);
    let total = 0;
    for (let i = 0; i < visibleCount; i += 1) {
        total += items[i].offsetHeight;
        if (i < visibleCount - 1) {
            const marginBottom = parseFloat(window.getComputedStyle(items[i]).marginBottom) || 0;
            total += marginBottom;
        }
    }
    return total;
}

function setupRulesRailInteraction(scrollEl) {
    const panel = scrollEl.closest('.rules-list-panel');
    const { rail, thumb } = getRulesListPanelRail(panel);
    if (!rail || !thumb || rail.dataset.interactionReady) return;
    rail.dataset.interactionReady = '1';

    const scrollToRatio = (ratio) => {
        const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
        scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, ratio * maxScroll));
        syncRulesListRail(scrollEl);
        engageRulesListRail(scrollEl);
    };

    rail.addEventListener('mousedown', (e) => {
        if (e.target === thumb) return;
        const rect = rail.getBoundingClientRect();
        scrollToRatio((e.clientY - rect.top) / rect.height);
    });

    const startDrag = (clientY) => {
        const startY = clientY;
        const startScroll = scrollEl.scrollTop;
        const thumbHeight = thumb.offsetHeight;
        const trackRange = Math.max(1, rail.clientHeight - thumbHeight);
        const scrollRange = scrollEl.scrollHeight - scrollEl.clientHeight;

        const onMove = (y) => {
            const delta = y - startY;
            scrollEl.scrollTop = startScroll + (delta / trackRange) * scrollRange;
            syncRulesListRail(scrollEl);
            engageRulesListRail(scrollEl);
        };

        const onMouseMove = (e) => onMove(e.clientY);
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };

    thumb.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startDrag(e.clientY);
    });

    thumb.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        if (!e.touches[0]) return;
        const startY = e.touches[0].clientY;
        const startScroll = scrollEl.scrollTop;
        const thumbHeight = thumb.offsetHeight;
        const trackRange = Math.max(1, rail.clientHeight - thumbHeight);
        const scrollRange = scrollEl.scrollHeight - scrollEl.clientHeight;

        const onTouchMove = (ev) => {
            if (!ev.touches[0]) return;
            const delta = ev.touches[0].clientY - startY;
            scrollEl.scrollTop = startScroll + (delta / trackRange) * scrollRange;
            syncRulesListRail(scrollEl);
            engageRulesListRail(scrollEl);
        };
        const onTouchEnd = () => {
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onTouchEnd);
        };

        engageRulesListRail(scrollEl);
        document.addEventListener('touchmove', onTouchMove, { passive: true });
        document.addEventListener('touchend', onTouchEnd);
    }, { passive: true });
}

function isStackedRulesLayout() {
    return window.matchMedia('(max-width: 992px)').matches;
}

function isDevicesMergeViewActive() {
    const layout = document.getElementById('devicesMergeLayout');
    return layout && !layout.hidden;
}

function setupRulesScroll(card) {
    const infoCol = card.querySelector('.instance-col-info');
    const rulesCol = card.querySelector('.instance-col-rules');
    const rulesBlock = card.querySelector('.rules-block');
    const rulesHeader = card.querySelector('.rules-header');
    const scrollEl = card.querySelector('.rules-list-scroll');
    if (!infoCol || !rulesCol || !rulesBlock || !scrollEl) return;

    const sync = () => {
        if (isStackedRulesLayout()) {
            rulesCol.style.minHeight = '';
            infoCol.style.minHeight = '';
            scrollEl.style.maxHeight = '';
            const items = scrollEl.querySelectorAll('.rule-item');
            if (items.length > 4) {
                const maxCap = getMobileRulesListMaxHeight(scrollEl);
                if (maxCap > 0) {
                    scrollEl.style.maxHeight = `${maxCap}px`;
                }
            }
        } else {
            infoCol.style.minHeight = '';
            const infoHeight = infoCol.offsetHeight;
            rulesCol.style.minHeight = `${infoHeight}px`;

            const blockStyle = window.getComputedStyle(rulesBlock);
            const blockPadding = parseFloat(blockStyle.paddingTop) + parseFloat(blockStyle.paddingBottom);
            const headerHeight = rulesHeader ? rulesHeader.offsetHeight + 10 : 0;
            const listMax = Math.max(48, infoHeight - headerHeight - blockPadding);

            scrollEl.style.maxHeight = `${listMax}px`;
        }
        syncRulesListRail(scrollEl);
    };

    if (!scrollEl.dataset.scrollReady) {
        scrollEl.dataset.scrollReady = '1';
        const panel = scrollEl.closest('.rules-list-panel');
        scrollEl.addEventListener('scroll', () => {
            syncRulesListRail(scrollEl);
            engageRulesListRail(scrollEl);
        }, { passive: true });
        panel?.addEventListener('touchstart', () => engageRulesListRail(scrollEl), { passive: true });
        setupRulesRailInteraction(scrollEl);
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(() => sync());
            observer.observe(infoCol);
            observer.observe(scrollEl);
            const rulesList = scrollEl.querySelector('.rules-list');
            if (rulesList) observer.observe(rulesList);
        }
        window.addEventListener('resize', sync);
    }

    requestAnimationFrame(sync);
}

let _mergeCardHeightSyncPending = false;
let _mergeCardHeightResizeTimer = null;
let _mergeCardHeightSyncLock = false;

function resetMergeViewCardHeights() {
    document.querySelectorAll('#devicesMergeLayout .instance-card').forEach(card => {
        card.style.minHeight = '';
    });
    const dividers = document.getElementById('devicesMergeDividers');
    if (dividers) dividers.innerHTML = '';
}

function syncMergeViewDividers() {
    const dividers = document.getElementById('devicesMergeDividers');
    if (!dividers) return;
    dividers.innerHTML = '';

    if (!isDevicesMergeViewActive()) return;
    if (typeof isMobileViewport === 'function' && isMobileViewport()) return;

    const mergeGrid = dividers.closest('.devices-merge-grid');
    if (!mergeGrid) return;

    const qbCards = [...document.querySelectorAll('#instanceCards > .instance-card')];
    const embyCards = [...document.querySelectorAll('#embyInstanceCardsMerge > .instance-card')];
    const gridTop = mergeGrid.getBoundingClientRect().top;
    const rowCount = Math.max(qbCards.length, embyCards.length);

    for (let i = 0; i < rowCount; i += 1) {
        const qbCard = qbCards[i];
        const embyCard = embyCards[i];
        if (!qbCard || !embyCard) continue;

        const qbRect = qbCard.getBoundingClientRect();
        const embyRect = embyCard.getBoundingClientRect();
        const top = Math.min(qbRect.top, embyRect.top) - gridTop;
        const bottom = Math.max(qbRect.bottom, embyRect.bottom) - gridTop;
        const height = bottom - top;
        if (height <= 0) continue;

        const divider = document.createElement('div');
        divider.className = 'devices-merge-row-divider';
        divider.style.top = `${top}px`;
        divider.style.height = `${height}px`;
        dividers.appendChild(divider);
    }
}

function syncMergeViewCardHeights() {
    if (_mergeCardHeightSyncLock) return;
    if (!isDevicesMergeViewActive()) {
        resetMergeViewCardHeights();
        return;
    }
    if (typeof isMobileViewport === 'function' && isMobileViewport()) {
        resetMergeViewCardHeights();
        return;
    }

    const qbCards = [...document.querySelectorAll('#instanceCards > .instance-card')];
    const embyCards = [...document.querySelectorAll('#embyInstanceCardsMerge > .instance-card')];
    if (!qbCards.length && !embyCards.length) return;

    _mergeCardHeightSyncLock = true;
    resetMergeViewCardHeights();

    const rowCount = Math.max(qbCards.length, embyCards.length);
    for (let i = 0; i < rowCount; i += 1) {
        const qbCard = qbCards[i];
        const embyCard = embyCards[i];
        if (qbCard) qbCard.style.minHeight = '';
        if (embyCard) embyCard.style.minHeight = '';

        if (qbCard && embyCard) {
            const heightPx = `${Math.ceil(Math.max(qbCard.offsetHeight, embyCard.offsetHeight))}px`;
            if (heightPx !== '0px') {
                if (qbCard.style.minHeight !== heightPx) {
                    qbCard.style.minHeight = heightPx;
                    setupRulesScroll(qbCard);
                }
                if (embyCard.style.minHeight !== heightPx) {
                    embyCard.style.minHeight = heightPx;
                    setupRulesScroll(embyCard);
                }
            }
        }
    }

    qbCards.forEach(card => setupRulesScroll(card));
    embyCards.forEach(card => setupRulesScroll(card));
    syncMergeViewDividers();
    _mergeCardHeightSyncLock = false;
}

function scheduleSyncMergeViewCardHeights() {
    if (_mergeCardHeightSyncPending) return;
    _mergeCardHeightSyncPending = true;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            _mergeCardHeightSyncPending = false;
            syncMergeViewCardHeights();
        });
    });
}

function scheduleSyncMergeViewCardHeightsDebounced(delay = 150) {
    if (_mergeCardHeightResizeTimer) {
        clearTimeout(_mergeCardHeightResizeTimer);
    }
    _mergeCardHeightResizeTimer = setTimeout(() => {
        _mergeCardHeightResizeTimer = null;
        scheduleSyncMergeViewCardHeights();
    }, delay);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function getCycleTypeLabel(cycle) {
    if (!cycle) return '按月';
    return cycle.type_label || CYCLE_TYPE_LABELS[cycle.type] || '按月';
}

function getCycleRangeText(cycle) {
    if (!cycle) return '--';
    return cycle.range_label || '--';
}

function buildCycleTypePopoverContent(cycle) {
    if (!cycle) return '';
    const typeLabel = getCycleTypeLabel(cycle);
    const rangeText = getCycleRangeText(cycle);
    return `
        <div class="badge-popover-title">当前周期</div>
        <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(typeLabel)}</div>
        <div class="badge-popover-meta">${escapeHtml(rangeText)}</div>`;
}

function buildCycleTypeBadgeHTML(cycle) {
    const ctype = String(cycle?.type || 'month').toLowerCase();
    const iconKey = CYCLE_TYPE_ICON_KEYS[ctype] || CYCLE_TYPE_ICON_KEYS.month;
    const label = escapeHtml(getCycleTypeLabel(cycle));
    const badgeHtml = `<span class="status-badge cycle-type">${buildInfoMetricIcon(iconKey)}<span>${label}</span></span>`;
    return wrapStatusBadgePopover(badgeHtml, buildCycleTypePopoverContent(cycle), 'cycle');
}

function buildInstanceBadgesRightHTML(inst) {
    const cycle = inst.cycle || {};
    let html = '';
    if (inst.has_next_cycle_plan || inst.next_cycle_plan) {
        html += wrapStatusBadgePopover(
            `<span class="status-badge pending-cycle">${buildInfoMetricIcon('plan')}<span>下周期计划</span></span>`,
            buildNextPlanPopoverContent(inst),
            'pending',
        );
    }
    const quotaTriggered = isQuotaTriggered(inst.speed_rules);
    if (quotaTriggered || inst.is_quota_limited) {
        html += wrapStatusBadgePopover(
            `<span class="status-badge limited">${buildInfoMetricIcon('limit')}<span>已触发</span></span>`,
            buildTriggeredPopoverContent(inst),
            'limited',
        );
    }
    html += buildCycleTypeBadgeHTML(cycle);
    return html;
}

function hasHoveredStatusBadge(root) {
    return !!(root && root.querySelector('.status-badge-wrap:hover'));
}

function setInnerHtmlIfChanged(el, html) {
    if (!el || el.innerHTML === html) return false;
    el.innerHTML = html;
    return true;
}

function patchInstancePriorityBadge(inst, card) {
    const priorityNo = String(inst.display_priority ?? '?');
    const badge = card.querySelector('.instance-priority-badge');
    if (badge) {
        if (badge.textContent !== priorityNo) {
            badge.textContent = priorityNo;
        }
        badge.title = `显示优先级 ${priorityNo}`;
        badge.setAttribute('aria-label', `显示优先级 ${priorityNo}`);
        return;
    }

    const header = card.querySelector('.instance-header');
    if (header) {
        header.insertAdjacentHTML('afterbegin', buildInstancePriorityBadgeHTML(inst));
        return;
    }

    const badgesRight = card.querySelector('.instance-badges-right');
    if (badgesRight) {
        badgesRight.insertAdjacentHTML('beforeend', buildInstancePriorityBadgeHTML(inst));
        return;
    }

    const titleLeft = card.querySelector('.instance-title-left')
        || card.querySelector('.instance-title-right');
    if (!titleLeft) return;

    const legacyWrap = titleLeft.querySelector('.status-badge-wrap');
    if (legacyWrap) {
        legacyWrap.outerHTML = buildInstancePriorityBadgeHTML(inst);
        return;
    }

    const legacyBadge = titleLeft.querySelector('.status-badge.online, .status-badge.offline');
    if (legacyBadge) {
        legacyBadge.outerHTML = buildInstancePriorityBadgeHTML(inst);
    }
}

function patchAddressPresence(inst, card) {
    const head = card.querySelector('.info-panel-basic-head');
    if (!head || hasHoveredStatusBadge(head)) return;

    const statusClass = inst.is_online ? 'online' : 'offline';
    const popoverHtml = inst.is_online
        ? buildOnlinePopoverContent(inst)
        : buildOfflinePopoverContent(inst);
    const wrap = head.querySelector('.info-endpoint-presence-wrap');

    if (wrap) {
        const variantClass = `status-badge-wrap--${statusClass}`;
        if (!wrap.classList.contains(variantClass)) {
            wrap.outerHTML = buildAddressEndpointHTML(inst);
            return;
        }
        const icon = wrap.querySelector('.info-endpoint-icon');
        if (icon) {
            icon.classList.remove('info-endpoint-icon--online', 'info-endpoint-icon--offline');
            icon.classList.add(`info-endpoint-icon--${statusClass}`);
            icon.setAttribute('aria-label', inst.is_online ? '设备在线' : '设备离线');
        }
        const popover = wrap.querySelector('.status-badge-popover');
        if (popover) {
            setInnerHtmlIfChanged(popover, popoverHtml);
        }
        return;
    }

    const legacyIcon = head.querySelector('.info-section-icon--endpoint:not(.info-endpoint-icon)');
    if (legacyIcon) {
        legacyIcon.outerHTML = buildAddressEndpointHTML(inst);
    }
}

function patchPresenceBadge(inst, card) {
    patchInstancePriorityBadge(inst, card);
    patchAddressPresence(inst, card);
}

function patchInstanceBadgesRight(inst, card) {
    const badgesRight = card.querySelector('.instance-badges-right')
        || card.querySelector('.instance-badges-left');
    if (!badgesRight || hasHoveredStatusBadge(badgesRight)) return;
    setInnerHtmlIfChanged(badgesRight, buildInstanceBadgesRightHTML(inst));
}

function formatCyclePeriodLabel(cycle) {
    if (!cycle) return '--';
    if (cycle.period_label) return cycle.period_label;
    const typeLabel = cycle.type_label || CYCLE_TYPE_LABELS[cycle.type] || '按月';
    const range = cycle.range_label || '--';
    return `${typeLabel} · ${range}`;
}

function stripInstanceHost(raw) {
    let host = (raw || '').trim();
    if (host.startsWith('https://')) host = host.slice(8);
    else if (host.startsWith('http://')) host = host.slice(7);
    return host.replace(/\/+$/, '').split('/')[0];
}

function formatInstanceHostPort(inst) {
    if (!inst) return '';
    const host = stripInstanceHost(inst.host);
    if (!host) return '';
    const port = inst.port;
    if (host.includes(':') && !host.startsWith('[')) {
        return `[${host}]:${port}`;
    }
    return `${host}:${port}`;
}

function parseHostPortInput(raw) {
    const stripped = stripInstanceHost(raw);
    if (!stripped) return { host: '', port: NaN };

    const ipv6Match = stripped.match(/^\[([^\]]+)\]:(\d+)$/);
    if (ipv6Match) {
        return { host: ipv6Match[1], port: parseInt(ipv6Match[2], 10) };
    }

    const lastColon = stripped.lastIndexOf(':');
    if (lastColon === -1) {
        return { host: stripped, port: NaN };
    }
    return {
        host: stripped.slice(0, lastColon),
        port: parseInt(stripped.slice(lastColon + 1), 10),
    };
}

function formatDeviceDisplay(inst) {
    return buildInstanceWebUrl(inst);
}

function maskDeviceHostDisplay(host) {
    const h = String(host || '').trim();
    if (!h) return '';

    const parts = h.split('.');
    if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) {
        const stars = (segment) => '*'.repeat(segment.length);
        return `${parts[0]}.${stars(parts[1])}.${stars(parts[2])}.${parts[3]}`;
    }

    if (parts.length >= 2 && h.includes('.')) {
        const sldIndex = parts.length - 2;
        const masked = [...parts];
        masked[sldIndex] = '*'.repeat(parts[sldIndex].length);
        return masked.join('.');
    }

    if (h.length > 0) {
        return '*'.repeat(h.length);
    }
    return h;
}

function maskDeviceAddressDisplay(address) {
    const raw = String(address || '').trim();
    if (!raw) return '';

    let prefix = '';
    let rest = raw;
    const schemeMatch = rest.match(/^(https?:\/\/)/i);
    if (schemeMatch) {
        prefix = schemeMatch[1];
        rest = rest.slice(prefix.length);
    }

    if (/^\[[^\]]+\](:\d+)?$/.test(rest)) {
        return raw;
    }

    let host = rest;
    let portSuffix = '';
    const lastColon = rest.lastIndexOf(':');
    if (lastColon > 0 && /:\d+$/.test(rest)) {
        host = rest.slice(0, lastColon);
        portSuffix = rest.slice(lastColon);
    }

    return prefix + maskDeviceHostDisplay(host) + portSuffix;
}

function buildEndpointEyeIcon(revealed) {
    if (revealed) {
        return '<svg class="emby-event-ip-eye device-address-eye" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M1 1l22 22"/></svg>';
    }
    return '<svg class="emby-event-ip-eye device-address-eye" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
}

function buildDeviceAddressMaskHtml(fullAddress) {
    const raw = String(fullAddress || '').trim();
    if (!raw) return '';
    const masked = maskDeviceAddressDisplay(raw);
    return `<span class="emby-event-ip-wrap device-address-wrap">`
        + `<span class="emby-event-ip device-address-text">${escapeHtml(masked)}</span>`
        + `<button type="button" class="emby-event-ip-toggle device-address-toggle" aria-label="显示地址" aria-pressed="false" data-address="${escapeHtml(raw)}">${buildEndpointEyeIcon(false)}</button>`
        + `</span>`;
}

function ensureDeviceAddressToggle() {
    if (document.documentElement.dataset.deviceAddressToggleBound === '1') return;
    document.documentElement.dataset.deviceAddressToggleBound = '1';
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.device-address-toggle');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const wrap = btn.closest('.device-address-wrap');
        const addrEl = wrap?.querySelector('.device-address-text');
        const realAddress = btn.dataset.address || '';
        if (!addrEl || !realAddress) return;
        const revealed = btn.getAttribute('aria-pressed') === 'true';
        if (revealed) {
            addrEl.textContent = maskDeviceAddressDisplay(realAddress);
            btn.setAttribute('aria-pressed', 'false');
            btn.setAttribute('aria-label', '显示地址');
            btn.innerHTML = buildEndpointEyeIcon(false);
        } else {
            addrEl.textContent = realAddress;
            btn.setAttribute('aria-pressed', 'true');
            btn.setAttribute('aria-label', '隐藏地址');
            btn.innerHTML = buildEndpointEyeIcon(true);
        }
    });
}

function ensureRulesHeaderActionsClick() {
    if (document.documentElement.dataset.rulesHeaderActionsBound === '1') return;
    document.documentElement.dataset.rulesHeaderActionsBound = '1';
    document.addEventListener('click', (e) => {
        const chartBtn = e.target.closest('[data-action="open-chart"]');
        if (chartBtn) {
            e.preventDefault();
            e.stopPropagation();
            const service = chartBtn.dataset.chartService || 'qb';
            const instance = chartBtn.dataset.chartInstance || '';
            if (typeof openDeviceChart === 'function') {
                openDeviceChart(service, instance);
            }
            return;
        }
        const eventBtn = e.target.closest('[data-action="open-events"]');
        if (!eventBtn) return;
        e.preventDefault();
        e.stopPropagation();
        const service = eventBtn.dataset.eventService || 'qb';
        const instance = eventBtn.dataset.eventInstance || '';
        if (typeof openDeviceEvents === 'function') {
            openDeviceEvents(service, instance);
        }
    });
}

function buildInstanceWebUrl(inst) {
    if (!inst) return '';
    const host = stripInstanceHost(inst.host);
    if (!host) return '';
    const scheme = inst.use_https ? 'https' : 'http';
    const port = inst.port;
    let hostPart = host;
    if (host.includes(':') && !host.startsWith('[')) {
        hostPart = `[${host}]`;
    }
    return `${scheme}://${hostPart}:${port}`;
}

function openInstanceWeb(name) {
    const inst = cachedInstances.find(i => i.name === name);
    const url = buildInstanceWebUrl(inst);
    if (!url) {
        showToast('无法构建 Web 地址，请检查连接设置', 'error');
        return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
}

function formatLimitKbpsText(kbps) {
    return kbps > 0 ? `${kbps} KB/s` : '无限速';
}

function getGlobalUploadLimitKbps(inst) {
    return inst.global_upload_limit_kbps ?? inst.current_speed_limit_kbps ?? 0;
}

function formatLimitKbpsCompact(kbps) {
    return kbps > 0 ? `${kbps}KB/s` : '无限速';
}

function hasHoveredSpeedLimitToggle(root) {
    return !!(root && root.querySelector('.speed-mode-switch:hover, .speed-mode-chip:hover'));
}

function patchSpeedLimitToggle(inst, speedToggleEl) {
    if (!speedToggleEl) return;
    if (!inst.is_online) {
        if (speedToggleEl.textContent !== '--') {
            speedToggleEl.textContent = '--';
        }
        return;
    }

    const globalK = getGlobalUploadLimitKbps(inst);
    const altK = inst.alt_upload_limit_kbps ?? 0;
    const altActive = !!inst.alt_speed_limits_active;
    const globalActive = !altActive;
    const hovered = hasHoveredSpeedLimitToggle(speedToggleEl);
    const inFlight = speedLimitSwitchInFlight.has(inst.name);

    const toggle = speedToggleEl.querySelector('.speed-mode-switch');
    if (!toggle) {
        speedToggleEl.innerHTML = buildUploadLimitToggleHTML(inst);
        return;
    }

    const updateBtn = (mode, label, kbps, active) => {
        const btn = toggle.querySelector(`[data-speed-mode="${mode}"]`);
        if (!btn) return false;
        const labelEl = btn.querySelector('.speed-mode-chip__label');
        const valueEl = btn.querySelector('.speed-mode-chip__value');
        const compact = formatLimitKbpsCompact(kbps);
        if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
        if (valueEl && valueEl.textContent !== compact) valueEl.textContent = compact;
        if (!hovered && !inFlight) {
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            btn.disabled = false;
        }
        return true;
    };

    const globalOk = updateBtn('global', '全局', globalK, globalActive);
    const altOk = updateBtn('alt', '备用', altK, altActive);
    if (!globalOk || !altOk) {
        speedToggleEl.innerHTML = buildUploadLimitToggleHTML(inst);
    }
}

function buildUploadLimitToggleHTML(inst) {
    if (!inst.is_online) return '--';
    const globalK = getGlobalUploadLimitKbps(inst);
    const altK = inst.alt_upload_limit_kbps ?? 0;
    const altActive = !!inst.alt_speed_limits_active;
    const globalActive = !altActive;
    const safeName = escapeHtml(inst.name);
    const buildChip = (label, kbps, mode, active) => `
            <button type="button"
                class="speed-mode-chip${active ? ' active' : ''}"
                data-speed-mode="${mode}"
                data-instance-name="${safeName}"
                aria-pressed="${active ? 'true' : 'false'}"
                title="切换为${label}限速">
                <span class="speed-mode-chip__label">${label}</span>
                <span class="speed-mode-chip__value">${formatLimitKbpsCompact(kbps)}</span>
            </button>`;
    return `
        <div class="speed-mode-switch" role="group" aria-label="上传限速模式">
            ${buildChip('全局', globalK, 'global', globalActive)}
            ${buildChip('备用', altK, 'alt', altActive)}
        </div>`;
}

const speedLimitSwitchInFlight = new Set();

async function switchSpeedLimitsMode(instanceName, useAlt, btnEl) {
    const inst = cachedInstances.find(i => i.name === instanceName);
    if (!inst?.is_online) {
        showToast('设备不在线', 'info');
        return;
    }
    if (!!inst.alt_speed_limits_active === useAlt) return;
    if (speedLimitSwitchInFlight.has(instanceName)) return;

    speedLimitSwitchInFlight.add(instanceName);
    const toggle = btnEl?.closest('.speed-mode-switch');
    toggle?.querySelectorAll('.speed-mode-chip').forEach(btn => { btn.disabled = true; });

    try {
        const res = await axios.post('/api/control/speed-limits-mode', {
            instance_name: instanceName,
            use_alt: useAlt,
        });
        if (res.data.success) {
            showToast(res.data.message, 'success');
            inst.alt_speed_limits_active = useAlt;
            const card = btnEl?.closest('.instance-card');
            const speedToggle = card?.querySelector('.info-value-speed-toggle');
            if (speedToggle) {
                patchSpeedLimitToggle(inst, speedToggle);
            }
            await refreshAll(false, true);
        } else {
            showToast(res.data.error || '切换失败', 'error');
        }
    } catch (e) {
        const errMsg = e.response?.data?.error;
        showToast(errMsg === '设备不在线' ? '设备不在线' : (errMsg || '请求失败'), errMsg === '设备不在线' ? 'info' : 'error');
    } finally {
        speedLimitSwitchInFlight.delete(instanceName);
        const instAfter = cachedInstances.find(i => i.name === instanceName);
        const card = btnEl?.closest('.instance-card');
        const speedToggle = card?.querySelector('.info-value-speed-toggle');
        if (instAfter && speedToggle) {
            patchSpeedLimitToggle(instAfter, speedToggle);
        }
    }
}

function setupSpeedLimitToggleDelegation() {
    if (document.body.dataset.speedLimitBound) return;
    document.body.dataset.speedLimitBound = '1';
    document.body.addEventListener('click', (e) => {
        const btn = e.target.closest('.speed-mode-chip');
        if (!btn || btn.disabled || btn.classList.contains('active')) return;
        const card = btn.closest('.instance-card:not(.instance-card--emby)');
        if (!card) return;
        const name = btn.dataset.instanceName;
        if (!name) return;
        switchSpeedLimitsMode(name, btn.dataset.speedMode === 'alt', btn);
    });
}

function sortInstancesByPriority(instances) {
    return [...instances].sort((a, b) => {
        const pa = a.display_priority ?? 500;
        const pb = b.display_priority ?? 500;
        if (pa !== pb) return pa - pb;
        return (a.name || '').localeCompare(b.name || '', 'zh-CN');
    });
}

function orderInstancesForContainer(instances, container) {
    if (container?.id === 'instanceCards'
        && typeof getDeviceViewMode === 'function'
        && getDeviceViewMode() === 'merge') {
        return instances;
    }
    return sortInstancesByPriority(instances);
}

function getInstanceCardsStructureKey(instances) {
    const isMergeQb = typeof getDeviceViewMode === 'function' && getDeviceViewMode() === 'merge';
    const sorted = isMergeQb ? instances : sortInstancesByPriority(instances);
    return JSON.stringify(sorted.map(inst => ({
        name: inst.name,
        online: !!inst.is_online,
        priority: inst.display_priority,
        rules: (inst.speed_rules || []).map(rule => ({
            i: rule.rule_index,
            t: rule.threshold_gb,
            l: rule.limit_kbps,
            tr: !!rule.triggered,
        })),
        limitSource: inst.limit_source || '',
        globalLimit: getGlobalUploadLimitKbps(inst),
        altLimit: inst.alt_upload_limit_kbps ?? 0,
        altActive: !!inst.alt_speed_limits_active,
        plan: !!(inst.has_next_cycle_plan || inst.next_cycle_plan),
        host: formatDeviceDisplay(inst),
        cycle: inst.cycle?.range_label || '',
        cycleType: inst.cycle?.type || 'month',
        reset: inst.reset_limit_kbps ?? inst.cycle?.reset_limit_kbps ?? 0,
    })));
}

function applyLiveMetricsToInstance(inst, live) {
    inst.recent_delta_bytes = live.recent_delta_bytes ?? 0;
    inst.recent_delta_download_bytes = live.recent_delta_download_bytes ?? 0;
    if (live.refresh_interval != null) {
        inst.refresh_interval = live.refresh_interval;
    }
    if (typeof live.is_online === 'boolean') {
        inst.is_online = live.is_online;
    }
    if (live.offline_since) {
        inst.offline_since = live.offline_since;
    } else if (live.is_online) {
        inst.offline_since = null;
    }
    if (live.online_since) {
        inst.online_since = live.online_since;
    } else if (!live.is_online) {
        inst.online_since = null;
    }
}

function patchInstanceCardNearMetrics(inst, card) {
    patchPresenceBadge(inst, card);

    const windowSec = getRecentDeltaWindowSeconds(inst);
    const labelUp = card.querySelector('.info-metric-label-recent-up');
    const labelDown = card.querySelector('.info-metric-label-recent-down');
    if (labelUp) labelUp.textContent = `近 ${windowSec} 秒上传`;
    if (labelDown) labelDown.textContent = `近 ${windowSec} 秒下载`;

    const recentDisplays = formatRecentDeltaDisplays(inst);
    const recentUpEl = card.querySelector('.info-value-recent-delta-up');
    const recentDownEl = card.querySelector('.info-value-recent-delta-down');
    if (recentUpEl) recentUpEl.textContent = recentDisplays.upload;
    if (recentDownEl) recentDownEl.textContent = recentDisplays.download;
}

function patchInstanceCardCumulative(inst, card) {
    const uploadTriggeredClass = getCycleUploadHighlightClass(inst.speed_rules);
    const uploadBytes = inst.cycle_uploaded_bytes ?? inst.monthly_uploaded_bytes ?? 0;
    const downloadBytes = inst.cycle_downloaded_bytes ?? inst.monthly_downloaded_bytes ?? 0;
    const deviceUploadBytes = inst.device_uploaded_bytes ?? 0;
    const deviceDownloadBytes = inst.device_downloaded_bytes ?? 0;
    const yesterdayUploadBytes = inst.yesterday_uploaded_bytes ?? 0;
    const yesterdayDownloadBytes = inst.yesterday_downloaded_bytes ?? 0;
    const todayUploadBytes = inst.today_uploaded_bytes ?? 0;
    const todayDownloadBytes = inst.today_downloaded_bytes ?? 0;

    const liveUpEl = card.querySelector('.info-value-cycle-upload');
    if (liveUpEl) {
        liveUpEl.textContent = formatCardTrafficText(uploadBytes);
        liveUpEl.classList.remove('danger', 'warning');
        if (uploadTriggeredClass) liveUpEl.classList.add(uploadTriggeredClass);
    }

    const cycleDownEl = card.querySelector('.info-value-cycle-download');
    if (cycleDownEl) {
        cycleDownEl.textContent = formatCardTrafficText(downloadBytes);
    }

    const yesterdayUpEl = card.querySelector('.info-value-yesterday-upload');
    if (yesterdayUpEl) {
        yesterdayUpEl.textContent = formatCardTrafficText(yesterdayUploadBytes);
    }

    const todayUpEl = card.querySelector('.info-value-today-upload');
    if (todayUpEl) {
        todayUpEl.textContent = formatCardTrafficText(todayUploadBytes);
    }

    const todayDownEl = card.querySelector('.info-value-today-download');
    if (todayDownEl) {
        todayDownEl.textContent = formatCardTrafficText(todayDownloadBytes);
    }

    const yesterdayDownEl = card.querySelector('.info-value-yesterday-download');
    if (yesterdayDownEl) {
        yesterdayDownEl.textContent = formatCardTrafficText(yesterdayDownloadBytes);
    }

    const deviceUpEl = card.querySelector('.info-value-device-upload');
    if (deviceUpEl) {
        const deviceTraffic = formatTraffic(deviceUploadBytes);
        deviceUpEl.textContent = `${deviceTraffic.value} ${deviceTraffic.unit}`;
    }

    const deviceDownEl = card.querySelector('.info-value-device-download');
    if (deviceDownEl) {
        const deviceDownloadTraffic = formatTraffic(deviceDownloadBytes);
        deviceDownEl.textContent = `${deviceDownloadTraffic.value} ${deviceDownloadTraffic.unit}`;
    }
}

function patchInstanceCardState(inst, card) {
    const {
        activeRuleIndex,
        isManualOverride,
        effectiveManualKbps,
        isAltOverride,
        effectiveAltKbps,
    } = resolveActiveRuleAndManual(inst);

    const speedToggle = card.querySelector('.info-value-speed-toggle');
    if (speedToggle) {
        patchSpeedLimitToggle(inst, speedToggle);
    }

    const cycleRangeEl = card.querySelector('.info-value-cycle-range');
    if (cycleRangeEl) {
        cycleRangeEl.textContent = getCycleRangeText(inst.cycle);
    }

    const cyclePlanEl = card.querySelector('.info-value-cycle-plan');
    if (cyclePlanEl) {
        const resetLimit = inst.reset_limit_kbps ?? inst.cycle?.reset_limit_kbps ?? 0;
        cyclePlanEl.textContent = formatCycleUploadResetLabel(inst.cycle, resetLimit);
    }

    const rulesList = card.querySelector('.rules-list');
    if (rulesList && inst.speed_rules?.length) {
        rulesList.innerHTML = inst.speed_rules.map(rule =>
            buildRuleItemHTML(
                rule,
                activeRuleIndex,
                isManualOverride,
                inst.cycle_uploaded_gb ?? 0,
                inst.manual_limit_trigger_at,
                effectiveManualKbps,
                inst.speed_rules,
                isAltOverride,
                effectiveAltKbps,
            )
        ).join('');
        setupRulesScroll(card);
    }

    patchInstancePanelAccents(inst, card);
    patchInstanceBadgesRight(inst, card);
}

function patchInstanceCardsLive(instances) {
    const sorted = sortInstancesByPriority(instances);
    const containers = [
        document.getElementById('instanceCards'),
        document.getElementById('instanceCardsSingle'),
    ].filter(Boolean);
    containers.forEach(container => {
        const cards = container.querySelectorAll('.instance-card:not(.instance-card--emby)');
        const cardByName = new Map();
        cards.forEach(card => {
            if (card.dataset.name) cardByName.set(card.dataset.name, card);
        });
        sorted.forEach(inst => {
            const card = cardByName.get(inst.name);
            if (!card) return;
            patchInstanceCardNearMetrics(inst, card);
            patchInstanceCardCumulative(inst, card);
            patchInstanceCardState(inst, card);
        });
    });
    if (typeof scheduleSyncMergeViewCardHeightsDebounced === 'function') {
        scheduleSyncMergeViewCardHeightsDebounced(80);
    }
}

function renderInstanceCards(instances, forceFull = false) {
    const container = typeof resolveQbCardsContainer === 'function'
        ? resolveQbCardsContainer()
        : document.getElementById('instanceCards');
    if (!container) return;
    if (!instances.length) {
        lastCardsStructureKey = '';
        const emptyHtml = typeof buildQbDevicesEmptyHtml === 'function'
            ? buildQbDevicesEmptyHtml()
            : '<div class="empty-tip">暂无 qB 设备，点击导航栏「添加设备」进行配置</div>';
        container.innerHTML = emptyHtml;
        return;
    }
    const structureKey = getInstanceCardsStructureKey(instances);
    if (!forceFull
        && structureKey === lastCardsStructureKey
        && container.querySelector('.instance-card')) {
        patchInstanceCardsLive(instances);
        return;
    }
    lastCardsStructureKey = structureKey;
    container.innerHTML = '';
    orderInstancesForContainer(instances, container).forEach(inst => {
        container.appendChild(createInstanceCard(inst));
    });
}

function buildInstanceActionsHTML(safeName) {
    const actions = [
        {
            action: 'open-web',
            variant: 'web',
            label: '打开 Web',
            icon: `<svg class="inst-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M11 3h6v6M9 11 17 3M6 5H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>`
        },
        {
            action: 'settings',
            variant: 'settings',
            label: '设置',
            icon: `<svg class="inst-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="10" cy="10" r="2.2" stroke="currentColor" stroke-width="1.5"/>
                <path d="M10 2.8v2.2M10 15v2.2M2.8 10h2.2M15 10h2.2M4.9 4.9l1.6 1.6M13.5 13.5l1.6 1.6M4.9 15.1l1.6-1.6M13.5 6.5l1.6-1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>`
        },
        {
            action: 'manual-limit',
            variant: 'limit',
            label: '手动限速',
            icon: `<svg class="inst-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M11.2 2.8L5.4 11.2H9.8l-1 6.2 6.4-9.2H10.4l.8-5.4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>`
        },
        {
            action: 'reset-stats',
            variant: 'reset',
            label: '清空统计',
            icon: `<svg class="inst-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M4.5 4.5v3M4.5 7.5H7M4.5 7.5A6.5 6.5 0 1 0 10 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>`
        },
        {
            action: 'delete',
            variant: 'delete',
            label: '删除',
            icon: `<svg class="inst-action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 6h10M8 6V4.8A.8.8 0 0 1 8.8 4h2.4a.8.8 0 0 1 .8.8V6M7.5 6l.4 9.2a1 1 0 0 0 1 .8h2.2a1 1 0 0 0 1-.8L12.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M8.5 9v4.5M11.5 9v4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>`
        }
    ];

    const renderBtn = ({ action, variant, label, icon }) => `
        <button type="button" class="inst-action inst-action--${variant}" data-action="${action}" data-name="${safeName}" title="${label}">
            <span class="inst-action-icon-wrap" aria-hidden="true">${icon}</span>
            <span class="inst-action-label">${label}</span>
        </button>`;

    return `<div class="instance-actions">${actions.map(renderBtn).join('')}</div>`;
}

function createInstanceCard(inst) {
    const card = document.createElement('div');
    card.className = 'instance-card';
    card.dataset.name = inst.name;

    const {
        activeRuleIndex,
        isManualOverride,
        effectiveManualKbps,
        isAltOverride,
        effectiveAltKbps,
    } = resolveActiveRuleAndManual(inst);
    const badgesRightHTML = buildInstanceBadgesRightHTML(inst);

    const uploadBytes = inst.cycle_uploaded_bytes ?? inst.monthly_uploaded_bytes ?? 0;
    const downloadBytes = inst.cycle_downloaded_bytes ?? inst.monthly_downloaded_bytes ?? 0;
    const deviceUploadBytes = inst.device_uploaded_bytes ?? 0;
    const deviceDownloadBytes = inst.device_downloaded_bytes ?? 0;
    const yesterdayUploadBytes = inst.yesterday_uploaded_bytes ?? 0;
    const yesterdayDownloadBytes = inst.yesterday_downloaded_bytes ?? 0;
    const todayUploadBytes = inst.today_uploaded_bytes ?? 0;
    const todayDownloadBytes = inst.today_downloaded_bytes ?? 0;
    const trafficDisplay = formatCardTrafficText(uploadBytes);
    const deviceTraffic = formatTraffic(deviceUploadBytes);
    const deviceTrafficDisplay = `${deviceTraffic.value} ${deviceTraffic.unit}`;
    const downloadTrafficDisplay = formatCardTrafficText(downloadBytes);
    const deviceDownloadTraffic = formatTraffic(deviceDownloadBytes);
    const deviceDownloadTrafficDisplay = `${deviceDownloadTraffic.value} ${deviceDownloadTraffic.unit}`;
    const yesterdayUploadDisplay = formatCardTrafficText(yesterdayUploadBytes);
    const yesterdayDownloadDisplay = formatCardTrafficText(yesterdayDownloadBytes);
    const todayUploadDisplay = formatCardTrafficText(todayUploadBytes);
    const todayDownloadDisplay = formatCardTrafficText(todayDownloadBytes);
    const recentDisplays = formatRecentDeltaDisplays(inst);
    const recentWindowSec = getRecentDeltaWindowSeconds(inst);

    const rulesBlockHTML = buildRulesBlockHTML(
        inst.speed_rules,
        activeRuleIndex,
        isManualOverride,
        inst.cycle_uploaded_gb ?? 0,
        inst.manual_limit_trigger_at,
        effectiveManualKbps,
        isAltOverride,
        effectiveAltKbps,
        inst.name,
    );
    const safeName = escapeHtml(inst.name);
    const cycle = inst.cycle || {};
    const cycleRangeText = escapeHtml(getCycleRangeText(cycle));
    const resetLimit = inst.reset_limit_kbps ?? cycle.reset_limit_kbps ?? 0;
    const cycleUploadResetText = escapeHtml(formatCycleUploadResetLabel(cycle, resetLimit));
    const uploadTriggeredClass = getCycleUploadHighlightClass(inst.speed_rules);
    const instanceInfoHTML = buildInstanceInfoHTML(inst, {
        address: formatDeviceDisplay(inst),
        recentWindowSec,
        recentUpload: recentDisplays.upload,
        recentDownload: recentDisplays.download,
        yesterdayUpload: yesterdayUploadDisplay,
        yesterdayDownload: yesterdayDownloadDisplay,
        todayUpload: todayUploadDisplay,
        todayDownload: todayDownloadDisplay,
        cycleUpload: trafficDisplay,
        cycleDownload: downloadTrafficDisplay,
        uploadTriggeredClass,
        cycleRangeText,
        cyclePlanText: cycleUploadResetText,
        speedToggleHTML: buildUploadLimitToggleHTML(inst),
        deviceUpload: deviceTrafficDisplay,
        deviceDownload: deviceDownloadTrafficDisplay,
    });

    card.innerHTML = `
        <div class="instance-header">
            ${buildInstancePriorityBadgeHTML(inst)}
            <div class="instance-title-left">
                ${buildInstanceServiceIconHTML('qb')}
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
                <div class="instance-col instance-col-rules">
                    <div class="rules-block">${rulesBlockHTML}</div>
                </div>
            </div>
        </div>
        <div class="instance-footer">
            ${buildInstanceActionsHTML(safeName)}
        </div>`;

    card.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = inst.name;
            const action = btn.dataset.action;
            if (action === 'open-web') openInstanceWeb(name);
            else if (action === 'settings') openInstanceSettings(name);
            else if (action === 'manual-limit') openManualLimitModal(name);
            else if (action === 'reset-stats') confirmResetStats(name);
            else if (action === 'delete') confirmDelete(name);
        });
    });

    setupRulesScroll(card);

    return card;
}

function populateChartInstanceSelect(instances, platform = getChartPlatform()) {
    const chartSel = document.getElementById('chartInstance');
    if (!chartSel) return;
    const instanceNames = new Set(instances.map(inst => inst.name));
    const storageKey = getChartInstanceStorageKey(platform);
    const persisted = sessionStorage.getItem(storageKey) || '';
    const prev = chartSel.value;
    const sorted = platform === 'emby' && typeof sortEmbyInstances === 'function'
        ? sortEmbyInstances(instances)
        : sortInstancesByPriority(instances);
    const hasInstances = sorted.length > 0;

    const resolveSelection = (value) => {
        if (!value) return '';
        if (value === CHART_ALL_DEVICES_VALUE) return hasInstances ? value : '';
        return instanceNames.has(value) ? value : '';
    };

    let saved = resolveSelection(prev) || resolveSelection(persisted);
    if (!saved && !hasInstances && persisted) {
        saved = persisted;
    }
    if (!saved && hasInstances) {
        saved = CHART_ALL_DEVICES_VALUE;
    }

    chartSel.innerHTML = '';
    if (hasInstances) {
        chartSel.add(new Option(CHART_ALL_DEVICES_LABEL, CHART_ALL_DEVICES_VALUE));
    }
    sorted.forEach(inst => chartSel.add(new Option(inst.name, inst.name)));
    if (saved && saved !== CHART_ALL_DEVICES_VALUE && !instanceNames.has(saved)) {
        chartSel.add(new Option(saved, saved));
    }
    chartSel.value = saved;
    if (saved) {
        sessionStorage.setItem(storageKey, saved);
    } else if (hasInstances) {
        sessionStorage.removeItem(storageKey);
    }
}

let _chartPlaybackUsersSeq = 0;
let _chartPlaybackUsersReady = false;

function getChartPlaybackUserSelection() {
    const select = document.getElementById('chartPlaybackUser');
    return (select?.value || '').trim();
}

/** 查询用外网用户：列表就绪后仅以选框为准；__device__=Docker 总上行，__all_users__=各用户合计 */
function getChartPlaybackUserForQuery() {
    if (_chartPlaybackUsersReady) {
        return getChartPlaybackUserSelection();
    }
    if (chartRestoredPlaybackUser != null) {
        return migrateChartPlaybackUserValue(chartRestoredPlaybackUser);
    }
    const persisted = getPersistedChartPlaybackUser();
    if (persisted != null) return persisted;
    return migrateChartPlaybackUserValue(getChartPlaybackUserSelection());
}

async function ensureChartPlaybackUserReady() {
    if (getChartPlatform() !== 'emby') return;
    const instance = document.getElementById('chartInstance')?.value || '';
    if (!instance || isChartAllDevicesValue(instance)) return;
    if (typeof refreshChartPlaybackUsers === 'function') {
        await refreshChartPlaybackUsers();
    }
}

function syncChartInstanceSelectForPlatform() {
    const platform = getChartPlatform();
    const instances = platform === 'emby'
        ? (typeof cachedEmbyInstances !== 'undefined' ? cachedEmbyInstances : [])
        : cachedInstances;
    populateChartInstanceSelect(instances || [], platform);
    if (platform === 'emby' && typeof refreshChartPlaybackUsers === 'function') {
        return refreshChartPlaybackUsers();
    }
}

async function refreshChartPlaybackUsers() {
    const select = document.getElementById('chartPlaybackUser');
    if (!select) return;
    _chartPlaybackUsersReady = false;
    const platform = getChartPlatform();
    const prev = resolveChartPlaybackUserPrev(select);
    const requestId = ++_chartPlaybackUsersSeq;
    buildChartPlaybackUserSelectOptions();

    const applyPrevSelection = () => {
        if ([...select.options].some((o) => o.value === prev)) {
            select.value = prev;
            chartRestoredPlaybackUser = prev;
        }
    };

    const finishPlaybackUsersRefresh = () => {
        if (requestId !== _chartPlaybackUsersSeq) return;
        const instance = document.getElementById('chartInstance')?.value || '';
        if (platform === 'emby' && instance && !isChartAllDevicesValue(instance)) {
            applyPrevSelection();
        }
        _chartPlaybackUsersReady = true;
        syncChartPlaybackUserPeriodOptions();
    };

    if (platform !== 'emby') {
        finishPlaybackUsersRefresh();
        return;
    }
    const instance = document.getElementById('chartInstance')?.value || '';
    if (!instance || isChartAllDevicesValue(instance)) {
        finishPlaybackUsersRefresh();
        return;
    }
    try {
        const res = await axios.get('/api/emby/playback-users', { params: { instance } });
        if (requestId !== _chartPlaybackUsersSeq) return;
        if (res.data.success) {
            const seen = new Set();
            (res.data.data || []).forEach((userName) => {
                const name = String(userName || '').trim();
                if (!name || seen.has(name)) return;
                seen.add(name);
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                select.appendChild(opt);
            });
            if (prev && isChartPlaybackUserQuery(prev) && !seen.has(prev)) {
                const opt = document.createElement('option');
                opt.value = prev;
                opt.textContent = prev;
                select.appendChild(opt);
            }
        }
    } catch (e) {
        /* 用户列表加载失败时仍可用设备总上行 */
    } finally {
        finishPlaybackUsersRefresh();
    }
}

function syncChartPlaybackUserPeriodOptions() {
    if (getChartPlatform() !== 'emby') return;
    const cycleOpt = document.querySelector('#chartPeriod option[value="cycle"]');
    if (!cycleOpt) return;
    cycleOpt.hidden = true;
    cycleOpt.disabled = true;
    const periodSel = document.getElementById('chartPeriod');
    if (periodSel?.value === 'cycle') {
        periodSel.value = 'hourly';
        if (typeof syncChartRangeInputs === 'function') syncChartRangeInputs();
    }
}

async function onChartInstanceChange() {
    const instance = document.getElementById('chartInstance')?.value || '';
    if (instance && typeof setDeviceTypeFilter === 'function') {
        const platform = getChartPlatform();
        setDeviceTypeFilter(platform);
        document.querySelectorAll('[data-device-type-filter]').forEach(sel => {
            if (typeof syncDeviceTypeSelectValue === 'function') {
                syncDeviceTypeSelectValue(sel, platform);
            }
        });
    }
    await refreshChartPlaybackUsers();
    await updateChart();
}

async function syncChartPlatformUi() {
    const platform = getChartPlatform();
    if (typeof syncPlatformPanelUi === 'function') {
        syncPlatformPanelUi('stats');
    }
    await syncChartInstanceSelectForPlatform();

    const cycleOpt = document.querySelector('#chartPeriod option[value="cycle"]');
    if (platform === 'emby') {
        syncChartPlaybackUserPeriodOptions();
    } else if (cycleOpt) {
        cycleOpt.hidden = false;
        cycleOpt.disabled = false;
    }
    syncChartLegendPlatformUi();
    syncChartLegendBackfillHint();
}

function updateInstanceSelects(instances) {
    const chartSel = document.getElementById('chartInstance');
    const eventSel = document.getElementById('eventInstance');
    const syslogSel = document.getElementById('syslogInstance');
    const savedEvent = eventSel?.value
        || sessionStorage.getItem(EVENT_QB_INSTANCE_KEY)
        || '';
    const savedSyslog = syslogSel?.value
        || sessionStorage.getItem(SYSLOG_QB_INSTANCE_KEY)
        || '';

    if (getChartPlatform() === 'qb') {
        populateChartInstanceSelect(instances, 'qb');
    }

    const names = sortInstancesByPriority(instances).map(inst => inst.name);

    if (eventSel) {
        eventSel.innerHTML = '';
        names.forEach(name => {
            eventSel.add(new Option(name, name));
        });
        let eventChanged = false;
        if (savedEvent && names.includes(savedEvent)) {
            eventSel.value = savedEvent;
        } else if (names.length) {
            const next = names[0];
            if (savedEvent !== next) eventChanged = true;
            eventSel.value = next;
        }
        if (eventSel.value) {
            sessionStorage.setItem(EVENT_QB_INSTANCE_KEY, eventSel.value);
        }
        if (eventChanged && currentTab === 'events') {
            loadEvents(true);
        }
    }

    if (syslogSel) {
        syslogSel.innerHTML = '';
        syslogSel.add(new Option('全部设备', ''));
        names.forEach(name => {
            syslogSel.add(new Option(name, name));
        });
        let syslogChanged = false;
        if (savedSyslog === '' || names.includes(savedSyslog)) {
            syslogSel.value = savedSyslog;
        } else {
            if (savedSyslog !== '') syslogChanged = true;
            syslogSel.value = '';
        }
        if (syslogChanged && currentTab === 'syslogs' && typeof loadSyslogsForCurrentType === 'function') {
            loadSyslogsForCurrentType(true);
        }
        if (syslogSel.value != null) {
            sessionStorage.setItem(SYSLOG_QB_INSTANCE_KEY, syslogSel.value);
        }
    }

    if (currentTab === 'stats' && getChartPlatform() === 'qb' && typeof updateChart === 'function') {
        updateChart(true);
    }
}

function getCategoryWidthLimits(viewportWidth, barCount) {
    const vw = Math.max(1, viewportWidth || 800);
    const count = Math.max(1, barCount || 1);
    const perfMin = vw / Math.min(count, CHART_MAX_VISIBLE_BARS);
    const min = Math.max(CHART_CATEGORY_WIDTH_ABS_MIN, perfMin);
    const max = Math.max(min, vw * 0.92);
    const fitted = vw / count;
    const defaultWidth = Math.max(min, Math.min(max, fitted));
    return { min, max, default: defaultWidth };
}

function resolveChartCategoryWidth(viewportWidth, barCount) {
    const { min, max, default: def } = getCategoryWidthLimits(viewportWidth, barCount);
    if (chartUserCategoryWidth == null) return def;
    return Math.max(min, Math.min(max, chartUserCategoryWidth));
}

function getChartXTickMeasureCtx() {
    if (!chartXTickMeasureCtx) {
        const canvas = document.createElement('canvas');
        chartXTickMeasureCtx = canvas.getContext('2d');
    }
    return chartXTickMeasureCtx;
}

function measureChartXTickWidth(label) {
    const ctx = getChartXTickMeasureCtx();
    ctx.font = `normal ${CHART_AXIS_TICK_FONT_SIZE}px ${CHART_AXIS_FONT_FAMILY}`;
    return ctx.measureText(String(label)).width;
}

function getMaxChartXTickWidth(labels) {
    if (!labels?.length) return 32;
    return Math.max(...labels.map(measureChartXTickWidth), 32);
}

function pickNiceChartTickStep(rawStep) {
    if (rawStep <= 1) return 1;
    for (const step of CHART_NICE_TICK_STEPS) {
        if (step >= rawStep) return step;
    }
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const normalized = rawStep / magnitude;
    const niceUnit = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return niceUnit * magnitude;
}

function computeChartXTickStep(barCount, chartWidth, maxLabelWidth) {
    if (barCount <= 1 || chartWidth <= 0) return 1;
    const categoryWidth = chartWidth / barCount;
    const minSlot = maxLabelWidth + CHART_X_TICK_LABEL_PADDING;
    if (categoryWidth >= minSlot) return 1;
    const maxVisible = Math.max(2, Math.floor(chartWidth / minSlot));
    const rawStep = Math.max(1, Math.ceil(barCount / maxVisible));
    return pickNiceChartTickStep(rawStep);
}

function refreshChartXTickStep(barCount, chartWidth, labels) {
    const maxLabelWidth = getMaxChartXTickWidth(labels);
    chartXTickStep = computeChartXTickStep(barCount, chartWidth, maxLabelWidth);
    if (trafficChart) {
        trafficChart.$maxXTickWidth = maxLabelWidth;
        trafficChart.$xTickStep = chartXTickStep;
    }
}

function bytesToChartGb(bytes) {
    return +((bytes || 0) / 1073741824).toFixed(1);
}

function getChartRowLabel(row, period) {
    if (period === 'hourly') return row.hour;
    if (period === 'daily') return row.day;
    if (period === 'weekly') return row.week;
    if (period === 'monthly') return row.month ?? row.period;
    if (period === 'yearly') {
        if (row.year != null && row.year !== '') return String(row.year);
        return row.period;
    }
    return row.period;
}

function parseHourlyLabel(label) {
    const s = String(label).trim();
    const match = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/);
    if (match) {
        return {
            date: match[1],
            time: `${match[2].padStart(2, '0')}:${match[3]}`,
        };
    }
    const timeMatch = s.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
        return {
            date: '',
            time: `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`,
        };
    }
    return { date: '', time: s };
}

function formatDateBracketLabel(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

function formatChartTooltipLabel(rawLabel, period, extra = {}) {
    const s = String(rawLabel ?? '').trim();
    if (!s) return '';

    if (period === 'hourly') {
        const parsed = parseHourlyLabel(s);
        if (parsed.date) {
            return `${formatDateBracketLabel(parsed.date)} ${parsed.time}`;
        }
        return parsed.time || s;
    }

    if (period === 'daily') {
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return `${m[1]}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
        return s;
    }

    if (period === 'weekly') {
        const m = s.match(/^(\d{4})-W(\d{1,2})$/i);
        if (m) return `${m[1]}年第${parseInt(m[2], 10)}周`;
        return s;
    }

    if (period === 'monthly') {
        const m = s.match(/^(\d{4})-(\d{2})$/);
        if (m) return `${m[1]}年${parseInt(m[2], 10)}月`;
        return s;
    }

    if (period === 'yearly') {
        const m = s.match(/^(\d{4})$/);
        if (m) return `${m[1]}年`;
        return /年$/.test(s) ? s : `${s}年`;
    }

    if (period === 'cycle') {
        const cycleStart = String(extra.cycleStart ?? '').trim();
        const year = cycleStart.match(/^(\d{4})/)?.[1];
        if (year) return `${year}年 ${s}`;
        return s;
    }

    return s;
}

function buildHourlyDateGroups(labels) {
    const parsed = labels.map(parseHourlyLabel);
    const groups = [];
    let i = 0;
    while (i < parsed.length) {
        const date = parsed[i].date;
        if (!date) { i += 1; continue; }
        let j = i + 1;
        while (j < parsed.length && parsed[j].date === date) j += 1;
        if (j - i >= 2) {
            groups.push({
                startIndex: i,
                endIndex: j - 1,
                dateLabel: formatDateBracketLabel(date),
            });
        }
        i = j;
    }
    return groups;
}

// ── daily: rawLabel = "2026-06-15" ──────────────────────────────────────────
function parseDailyLabel(label) {
    const s = String(label).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return { groupKey: '', tickLabel: s };
    return {
        groupKey: `${m[1]}-${m[2]}`,
        tickLabel: `${parseInt(m[3], 10)}日`,
    };
}

function buildDailyDateGroups(labels) {
    const parsed = labels.map(parseDailyLabel);
    const groups = [];
    let i = 0;
    while (i < parsed.length) {
        const key = parsed[i].groupKey;
        if (!key) { i += 1; continue; }
        let j = i + 1;
        while (j < parsed.length && parsed[j].groupKey === key) j += 1;
        const [y, mo] = key.split('-');
        groups.push({
            startIndex: i,
            endIndex: j - 1,
            dateLabel: `${y}年${parseInt(mo, 10)}月`,
        });
        i = j;
    }
    return groups;
}

// ── weekly: rawLabel = "2026-W24" ────────────────────────────────────────────
function parseWeeklyLabel(label) {
    const s = String(label).trim();
    const m = s.match(/^(\d{4})-W(\d{1,2})$/i);
    if (!m) return { groupKey: '', tickLabel: s };
    const weekNum = parseInt(m[2], 10);
    return {
        groupKey: m[1],
        tickLabel: weekNum > 0 ? `第${weekNum}周` : s,
    };
}

function buildWeeklyDateGroups(labels) {
    const parsed = labels.map(parseWeeklyLabel);
    const groups = [];
    let i = 0;
    while (i < parsed.length) {
        const key = parsed[i].groupKey;
        if (!key) { i += 1; continue; }
        let j = i + 1;
        while (j < parsed.length && parsed[j].groupKey === key) j += 1;
        groups.push({
            startIndex: i,
            endIndex: j - 1,
            dateLabel: `${key}年`,
        });
        i = j;
    }
    return groups;
}

// ── monthly: rawLabel = "2026-06" ─────────────────────────────────────────────
function parseMonthlyLabel(label) {
    const s = String(label).trim();
    const m = s.match(/^(\d{4})-(\d{2})$/);
    if (!m) return { groupKey: '', tickLabel: s };
    return {
        groupKey: m[1],
        tickLabel: `${parseInt(m[2], 10)}月`,
    };
}

function buildMonthlyDateGroups(labels) {
    const parsed = labels.map(parseMonthlyLabel);
    const groups = [];
    let i = 0;
    while (i < parsed.length) {
        const key = parsed[i].groupKey;
        if (!key) { i += 1; continue; }
        let j = i + 1;
        while (j < parsed.length && parsed[j].groupKey === key) j += 1;
        groups.push({
            startIndex: i,
            endIndex: j - 1,
            dateLabel: `${key}年`,
        });
        i = j;
    }
    return groups;
}

function mergeUploadDownloadStats(uploadData, downloadData, period) {
    const upMap = new Map();
    const dlMap = new Map();
    const upBackfillMap = new Map();
    const dlBackfillMap = new Map();
    const cycleStartMap = new Map();

    const ingestRow = (row) => {
        const key = String(getChartRowLabel(row, period));
        if (period === 'cycle' && row.cycle_start) {
            cycleStartMap.set(key, String(row.cycle_start));
        }
        return key;
    };

    uploadData.forEach(row => {
        const key = ingestRow(row);
        upMap.set(key, row.total_bytes || 0);
        upBackfillMap.set(key, row.backfilled_bytes || 0);
    });
    downloadData.forEach(row => {
        const key = ingestRow(row);
        dlMap.set(key, row.total_bytes || 0);
        dlBackfillMap.set(key, row.backfilled_bytes || 0);
    });
    const rawLabels = [...new Set([...upMap.keys(), ...dlMap.keys()])].sort();
    let labels = rawLabels;
    let dateGroups = null;

    if (period === 'hourly') {
        labels = rawLabels.map(label => parseHourlyLabel(label).time);
        dateGroups = buildHourlyDateGroups(rawLabels);
    } else if (period === 'daily') {
        labels = rawLabels.map(label => parseDailyLabel(label).tickLabel);
        dateGroups = buildDailyDateGroups(rawLabels);
    } else if (period === 'weekly') {
        labels = rawLabels.map(label => parseWeeklyLabel(label).tickLabel);
        dateGroups = buildWeeklyDateGroups(rawLabels);
    } else if (period === 'monthly') {
        labels = rawLabels.map(label => parseMonthlyLabel(label).tickLabel);
        dateGroups = buildMonthlyDateGroups(rawLabels);
    }

    const tooltipLabels = rawLabels.map(label => formatChartTooltipLabel(label, period, {
        cycleStart: cycleStartMap.get(label),
    }));

    return {
        labels,
        rawLabels,
        tooltipLabels,
        dateGroups,
        uploadValues: rawLabels.map(label => bytesToChartGb(upMap.get(label))),
        downloadValues: rawLabels.map(label => bytesToChartGb(dlMap.get(label))),
        backfillUploadValues: rawLabels.map(label => bytesToChartGb(upBackfillMap.get(label) || 0)),
        backfillDownloadValues: rawLabels.map(label => bytesToChartGb(dlBackfillMap.get(label) || 0)),
    };
}

function toDatetimeLocalHourValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`;
}

function toDatetimeLocalValue(date) {
    return toDatetimeLocalHourValue(date);
}

function toDateInputValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toMonthInputValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function getChartRangeNow(period) {
    const now = new Date();
    if (period === 'hourly') {
        now.setMinutes(0, 0, 0);
    } else if (period === 'monthly') {
        now.setDate(1);
        now.setHours(0, 0, 0, 0);
    } else if (period === 'yearly') {
        now.setMonth(0, 1);
        now.setHours(0, 0, 0, 0);
    } else {
        now.setHours(0, 0, 0, 0);
    }
    return now;
}

const CHART_RANGE_FAR_PAST = new Date(2000, 0, 1);

function getCustomRangeLimits(period) {
    return CHART_PERIOD_LIMITS[period] || CHART_PERIOD_LIMITS.daily;
}

function earliestStartBySpan(end, period) {
    const limits = getCustomRangeLimits(period);
    const d = new Date(end);
    if (period === 'hourly') {
        d.setHours(d.getHours() - limits.maxCustomHours);
    } else if (period === 'daily' || period === 'weekly') {
        d.setDate(d.getDate() - (limits.maxCustomDays - 1));
    } else if (period === 'monthly') {
        d.setMonth(d.getMonth() - (limits.maxCustomMonths - 1));
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
    } else if (period === 'yearly') {
        d.setFullYear(d.getFullYear() - (limits.maxCustomYears - 1));
        d.setMonth(0, 1);
        d.setHours(0, 0, 0, 0);
    }
    return d;
}

function latestEndBySpan(start, period) {
    const limits = getCustomRangeLimits(period);
    const d = new Date(start);
    if (period === 'hourly') {
        d.setHours(d.getHours() + limits.maxCustomHours);
    } else if (period === 'daily' || period === 'weekly') {
        d.setDate(d.getDate() + (limits.maxCustomDays - 1));
    } else if (period === 'monthly') {
        d.setMonth(d.getMonth() + (limits.maxCustomMonths - 1));
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
    } else if (period === 'yearly') {
        d.setFullYear(d.getFullYear() + (limits.maxCustomYears - 1));
        d.setMonth(0, 1);
        d.setHours(0, 0, 0, 0);
    }
    return d;
}

function minEndAfterStart(start, period) {
    const d = new Date(start);
    if (period === 'hourly') {
        d.setHours(d.getHours() + 1);
    }
    return d;
}

function maxStartBeforeEnd(end, period) {
    const d = new Date(end);
    if (period === 'hourly') {
        d.setHours(d.getHours() - 1);
    }
    return d;
}

function isChartRangeOrderInvalid(start, end, period) {
    if (period === 'hourly') {
        return end.getTime() <= start.getTime();
    }
    return end.getTime() < start.getTime();
}

function clampChartRangeDate(date, min, max) {
    return new Date(Math.min(max.getTime(), Math.max(min.getTime(), date.getTime())));
}

function ensureHourSelectOptions(selectEl) {
    if (!selectEl || selectEl.options.length === 24) return;
    selectEl.innerHTML = '';
    for (let h = 0; h < 24; h += 1) {
        const opt = document.createElement('option');
        opt.value = String(h);
        opt.textContent = `${String(h).padStart(2, '0')}:00`;
        selectEl.appendChild(opt);
    }
}

function updateHourSelect(selectEl, minHour, maxHour, selectedHour) {
    if (!selectEl) return;
    ensureHourSelectOptions(selectEl);
    let selected = Number.isFinite(selectedHour) ? selectedHour : minHour;
    if (selected < minHour) selected = minHour;
    if (selected > maxHour) selected = maxHour;
    for (const opt of selectEl.options) {
        const hour = parseInt(opt.value, 10);
        opt.disabled = hour < minHour || hour > maxHour;
    }
    selectEl.value = String(selected);
}

function getHourRangeForDate(dateStr, period, role, ctx) {
    let minHour = 0;
    let maxHour = 23;
    if (dateStr === toDateInputValue(ctx.now)) {
        maxHour = ctx.now.getHours();
    }
    if (period === 'hourly' && role === 'start' && ctx.end && dateStr === toDateInputValue(ctx.end)) {
        maxHour = Math.min(maxHour, ctx.end.getHours() - 1);
    }
    if (period === 'hourly' && role === 'end' && ctx.start && dateStr === toDateInputValue(ctx.start)) {
        minHour = Math.max(minHour, ctx.start.getHours() + 1);
    }
    if (maxHour < minHour) maxHour = minHour;
    return { minHour, maxHour };
}

function readChartRangeDateInput(role, period) {
    if (period === 'monthly') {
        const monthEl = document.getElementById(role === 'start' ? 'chartRangeStartMonth' : 'chartRangeEndMonth');
        if (!monthEl?.value) return null;
        const [y, m] = monthEl.value.split('-').map(Number);
        return new Date(y, m - 1, 1);
    }
    if (period === 'yearly') {
        const yearEl = document.getElementById(role === 'start' ? 'chartRangeStartYear' : 'chartRangeEndYear');
        const year = parseInt(yearEl?.value ?? '', 10);
        if (!Number.isFinite(year)) return null;
        return new Date(year, 0, 1);
    }
    const dateEl = document.getElementById(role === 'start' ? 'chartRangeStart' : 'chartRangeEnd');
    if (!dateEl?.value) return null;
    if (period === 'hourly') {
        const hourEl = document.getElementById(role === 'start' ? 'chartRangeStartHour' : 'chartRangeEndHour');
        const hour = parseInt(hourEl?.value ?? '0', 10);
        return new Date(`${dateEl.value}T${String(hour).padStart(2, '0')}:00:00`);
    }
    return new Date(`${dateEl.value}T00:00:00`);
}

function writeChartRangeDateInput(role, period, date) {
    if (period === 'monthly') {
        const monthEl = document.getElementById(role === 'start' ? 'chartRangeStartMonth' : 'chartRangeEndMonth');
        if (monthEl) monthEl.value = toMonthInputValue(date);
        return;
    }
    if (period === 'yearly') {
        const yearEl = document.getElementById(role === 'start' ? 'chartRangeStartYear' : 'chartRangeEndYear');
        if (yearEl) yearEl.value = String(date.getFullYear());
        return;
    }
    const dateEl = document.getElementById(role === 'start' ? 'chartRangeStart' : 'chartRangeEnd');
    if (!dateEl) return;
    dateEl.value = toDateInputValue(date);
    if (period === 'hourly') {
        const hourEl = document.getElementById(role === 'start' ? 'chartRangeStartHour' : 'chartRangeEndHour');
        const now = getChartRangeNow(period);
        const ctx = { now, start: null, end: null };
        const hours = getHourRangeForDate(dateEl.value, period, role, ctx);
        updateHourSelect(hourEl, hours.minHour, hours.maxHour, date.getHours());
    }
}

function setRangeInputBounds(period, startMin, startMax, endMin, endMax) {
    const startDateEl = document.getElementById('chartRangeStart');
    const endDateEl = document.getElementById('chartRangeEnd');
    const startMonthEl = document.getElementById('chartRangeStartMonth');
    const endMonthEl = document.getElementById('chartRangeEndMonth');
    const startYearEl = document.getElementById('chartRangeStartYear');
    const endYearEl = document.getElementById('chartRangeEndYear');

    if (period === 'monthly') {
        if (startMonthEl) {
            startMonthEl.min = toMonthInputValue(startMin);
            startMonthEl.max = toMonthInputValue(startMax);
        }
        if (endMonthEl) {
            endMonthEl.min = toMonthInputValue(endMin);
            endMonthEl.max = toMonthInputValue(endMax);
        }
        return;
    }
    if (period === 'yearly') {
        if (startYearEl) {
            startYearEl.min = String(startMin.getFullYear());
            startYearEl.max = String(startMax.getFullYear());
        }
        if (endYearEl) {
            endYearEl.min = String(endMin.getFullYear());
            endYearEl.max = String(endMax.getFullYear());
        }
        return;
    }
    if (startDateEl) {
        startDateEl.min = toDateInputValue(startMin);
        startDateEl.max = toDateInputValue(startMax);
    }
    if (endDateEl) {
        endDateEl.min = toDateInputValue(endMin);
        endDateEl.max = toDateInputValue(endMax);
    }
}

function applyChartRangeConstraints(period) {
    if (period === 'cycle') {
        const cyclesEl = document.getElementById('chartRangeCycles');
        if (!cyclesEl) return;
        const maxCycles = getCustomRangeLimits('cycle').maxCustomCycles;
        let cycles = parseInt(cyclesEl.value, 10);
        if (!Number.isFinite(cycles)) cycles = getCustomRangeLimits('cycle').maxCycles;
        cyclesEl.value = String(Math.min(maxCycles, Math.max(1, cycles)));
        cyclesEl.min = '1';
        cyclesEl.max = String(maxCycles);
        return;
    }

    const startHourEl = document.getElementById('chartRangeStartHour');
    const endHourEl = document.getElementById('chartRangeEndHour');

    const now = getChartRangeNow(period);
    let start = readChartRangeDateInput('start', period);
    let end = readChartRangeDateInput('end', period);

    let startMin = new Date(CHART_RANGE_FAR_PAST);
    let startMax = new Date(now);
    let endMin = new Date(CHART_RANGE_FAR_PAST);
    let endMax = new Date(now);
    const skipSpanLimit = isChartQuickRangeActive();

    if (start && !skipSpanLimit) {
        endMin = minEndAfterStart(start, period);
        const spanEndMax = latestEndBySpan(start, period);
        endMax = clampChartRangeDate(
            new Date(Math.min(now.getTime(), spanEndMax.getTime())),
            endMin,
            now,
        );
    } else if (start) {
        endMin = minEndAfterStart(start, period);
    }
    if (end) {
        startMax = clampChartRangeDate(maxStartBeforeEnd(end, period), startMin, now);
        if (!skipSpanLimit) {
            const spanStartMin = earliestStartBySpan(end, period);
            startMin = new Date(Math.max(CHART_RANGE_FAR_PAST.getTime(), spanStartMin.getTime()));
        }
    }

    setRangeInputBounds(period, startMin, startMax, endMin, endMax);

    if (start) {
        let fixed = clampChartRangeDate(start, startMin, startMax);
        if (fixed.getTime() !== start.getTime()) {
            writeChartRangeDateInput('start', period, fixed);
            start = fixed;
        }
    }
    if (end) {
        let fixed = clampChartRangeDate(end, endMin, endMax);
        if (fixed.getTime() !== end.getTime()) {
            writeChartRangeDateInput('end', period, fixed);
            end = fixed;
        }
    }
    if (start && end && isChartRangeOrderInvalid(start, end, period)) {
        const fixedEnd = clampChartRangeDate(minEndAfterStart(start, period), endMin, endMax);
        writeChartRangeDateInput('end', period, fixedEnd);
        end = fixedEnd;
    }

    if (period === 'hourly') {
        start = readChartRangeDateInput('start', period);
        end = readChartRangeDateInput('end', period);
        const startEl = document.getElementById('chartRangeStart');
        const endEl = document.getElementById('chartRangeEnd');
        const ctx = { now, start, end };
        if (startEl?.value) {
            const startHours = getHourRangeForDate(startEl.value, period, 'start', ctx);
            updateHourSelect(
                startHourEl,
                startHours.minHour,
                startHours.maxHour,
                start ? start.getHours() : startHours.maxHour,
            );
        } else {
            const todayHours = getHourRangeForDate(toDateInputValue(now), period, 'start', ctx);
            updateHourSelect(startHourEl, todayHours.minHour, todayHours.maxHour, todayHours.maxHour);
        }
        if (endEl?.value) {
            const endHours = getHourRangeForDate(endEl.value, period, 'end', ctx);
            updateHourSelect(
                endHourEl,
                endHours.minHour,
                endHours.maxHour,
                end ? end.getHours() : endHours.maxHour,
            );
        } else {
            const todayHours = getHourRangeForDate(toDateInputValue(now), period, 'end', ctx);
            updateHourSelect(endHourEl, todayHours.minHour, todayHours.maxHour, todayHours.maxHour);
        }
    }
}

function syncChartRangeInputVisibility(period, enabled) {
    const isHourly = period === 'hourly';
    const isDateRange = period === 'hourly' || period === 'daily' || period === 'weekly';
    const isMonthly = period === 'monthly';
    const isYearly = period === 'yearly';
    const isCycle = period === 'cycle';
    const showRange = enabled && !isCycle;

    const setField = (id, show, active) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.hidden = !show;
        el.disabled = !active;
    };

    setField('chartRangeStart', showRange && isDateRange, enabled && isDateRange);
    setField('chartRangeEnd', showRange && isDateRange, enabled && isDateRange);
    setField('chartRangeStartMonth', showRange && isMonthly, enabled && isMonthly);
    setField('chartRangeEndMonth', showRange && isMonthly, enabled && isMonthly);
    setField('chartRangeStartYear', showRange && isYearly, enabled && isYearly);
    setField('chartRangeEndYear', showRange && isYearly, enabled && isYearly);
    setField('chartRangeStartHour', showRange && isHourly, enabled && isHourly);
    setField('chartRangeEndHour', showRange && isHourly, enabled && isHourly);

    const sepEl = document.getElementById('chartRangeSep');
    if (sepEl) sepEl.hidden = !showRange;

    const cycleWrap = document.getElementById('chartRangeCycleWrap');
    const cyclesEl = document.getElementById('chartRangeCycles');
    if (cycleWrap) cycleWrap.hidden = !enabled || !isCycle;
    if (cyclesEl) cyclesEl.disabled = !enabled || !isCycle;
}

function setChartRangeInputsEnabled(enabled, period) {
    syncChartRangeInputVisibility(period, enabled);
}

function setDefaultChartRangeInputs(period) {
    const now = getChartRangeNow(period);
    const limits = getCustomRangeLimits(period);

    if (period === 'cycle') {
        const cyclesEl = document.getElementById('chartRangeCycles');
        if (cyclesEl) cyclesEl.value = String(limits.maxCycles);
        applyChartRangeConstraints(period);
        return;
    }

    if (period === 'hourly') {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const yStart = new Date(yesterday);
        yStart.setHours(0, 0, 0, 0);
        const yEnd = new Date(yesterday);
        yEnd.setHours(23, 0, 0, 0);
        writeChartRangeDateInput('start', period, yStart);
        writeChartRangeDateInput('end', period, yEnd);
        applyChartRangeConstraints(period);
        return;
    }

    const start = new Date(now);
    if (period === 'daily') {
        start.setDate(1);
    } else if (period === 'weekly') {
        start.setDate(start.getDate() - limits.maxDays + 1);
    } else if (period === 'monthly') {
        start.setMonth(0, 1);
    } else if (period === 'yearly') {
        start.setFullYear(start.getFullYear() - (limits.maxYears - 1));
        start.setMonth(0, 1);
    } else {
        start.setDate(start.getDate() - 29);
    }

    writeChartRangeDateInput('start', period, start);
    writeChartRangeDateInput('end', period, now);
    applyChartRangeConstraints(period);
}

function collectChartRangeState(period) {
    const range = {};
    if (period === 'cycle') {
        const cyclesEl = document.getElementById('chartRangeCycles');
        if (cyclesEl?.value) range.rangeCycles = cyclesEl.value;
        return range;
    }
    const startEl = document.getElementById('chartRangeStart');
    const endEl = document.getElementById('chartRangeEnd');
    const startMonthEl = document.getElementById('chartRangeStartMonth');
    const endMonthEl = document.getElementById('chartRangeEndMonth');
    const startYearEl = document.getElementById('chartRangeStartYear');
    const endYearEl = document.getElementById('chartRangeEndYear');
    if (period === 'monthly') {
        if (startMonthEl?.value) range.rangeStart = startMonthEl.value;
        if (endMonthEl?.value) range.rangeEnd = endMonthEl.value;
    } else if (period === 'yearly') {
        if (startYearEl?.value) range.rangeStart = startYearEl.value;
        if (endYearEl?.value) range.rangeEnd = endYearEl.value;
    } else {
        if (startEl?.value) range.rangeStart = startEl.value;
        if (endEl?.value) range.rangeEnd = endEl.value;
    }
    if (period === 'hourly') {
        const startHourEl = document.getElementById('chartRangeStartHour');
        const endHourEl = document.getElementById('chartRangeEndHour');
        if (startHourEl?.value != null) range.rangeStartHour = startHourEl.value;
        if (endHourEl?.value != null) range.rangeEndHour = endHourEl.value;
    }
    return range;
}

function applyChartRangeState(period, state) {
    if (!state) return;
    if (period === 'cycle') {
        const cyclesEl = document.getElementById('chartRangeCycles');
        if (cyclesEl && state.rangeCycles) cyclesEl.value = state.rangeCycles;
        return;
    }
    const startEl = document.getElementById('chartRangeStart');
    const endEl = document.getElementById('chartRangeEnd');
    const startMonthEl = document.getElementById('chartRangeStartMonth');
    const endMonthEl = document.getElementById('chartRangeEndMonth');
    const startYearEl = document.getElementById('chartRangeStartYear');
    const endYearEl = document.getElementById('chartRangeEndYear');
    if (period === 'monthly') {
        if (startMonthEl && state.rangeStart) startMonthEl.value = state.rangeStart;
        if (endMonthEl && state.rangeEnd) endMonthEl.value = state.rangeEnd;
    } else if (period === 'yearly') {
        if (startYearEl && state.rangeStart) startYearEl.value = state.rangeStart;
        if (endYearEl && state.rangeEnd) endYearEl.value = state.rangeEnd;
    } else {
        if (startEl && state.rangeStart) startEl.value = state.rangeStart;
        if (endEl && state.rangeEnd) endEl.value = state.rangeEnd;
    }
    if (period === 'hourly') {
        const startHourEl = document.getElementById('chartRangeStartHour');
        const endHourEl = document.getElementById('chartRangeEndHour');
        if (startHourEl && state.rangeStartHour != null) {
            startHourEl.value = String(state.rangeStartHour);
        }
        if (endHourEl && state.rangeEndHour != null) {
            endHourEl.value = String(state.rangeEndHour);
        }
    }
}

async function bootstrapPersistedTabControls() {
    restoreChartControls();
    if (typeof syncDeviceTypeFilterControls === 'function') {
        syncDeviceTypeFilterControls();
    }
    if (getChartPlatform() === 'emby' && typeof ensureEmbyDataLoaded === 'function') {
        await ensureEmbyDataLoaded();
    }
    await syncChartPlatformUi();
    syncChartTypeToggle();
    syncChartLegendBackfillHint();
    syncChartRangeInputs();
}

function persistChartControls() {
    const periodEl = document.getElementById('chartPeriod');
    const customEl = document.getElementById('chartUseCustomRange');
    if (!periodEl || !customEl) return;

    const period = periodEl.value;
    const state = {
        period,
        useCustomRange: customEl.checked,
        chartType: chartViewType,
        ...collectChartRangeState(period),
    };
    if (chartActivePresetLabel) state.activePresetLabel = chartActivePresetLabel;
    const playbackEl = document.getElementById('chartPlaybackUser');
    if (playbackEl) {
        if (_chartPlaybackUsersReady) {
            state.playbackUser = getChartPlaybackUserSelection();
        } else {
            const fromRestore = chartRestoredPlaybackUser != null
                ? migrateChartPlaybackUserValue(chartRestoredPlaybackUser)
                : null;
            const fromPersisted = getPersistedChartPlaybackUser();
            state.playbackUser = fromRestore ?? fromPersisted
                ?? migrateChartPlaybackUserValue(getChartPlaybackUserSelection());
        }
    }
    const instanceEl = document.getElementById('chartInstance');
    const chartPlatform = getChartPlatform();
    state.chartPlatform = chartPlatform;
    if (instanceEl?.value) {
        state.chartInstance = instanceEl.value;
        sessionStorage.setItem(getChartInstanceStorageKey(chartPlatform), instanceEl.value);
    } else {
        state.chartInstance = '';
    }

    const eventQbEl = document.getElementById('eventInstance');
    const eventEmbyEl = document.getElementById('embyEventInstance');
    const embyEventLogTypeEl = document.getElementById('embyEventLogType');
    const embyEventPlaybackUserEl = document.getElementById('embyEventPlaybackUser');
    const syslogQbEl = document.getElementById('syslogInstance');
    const syslogEmbyEl = document.getElementById('embySyslogInstance');
    if (eventQbEl) {
        state.eventInstanceQb = eventQbEl.value || '';
        sessionStorage.setItem(EVENT_QB_INSTANCE_KEY, state.eventInstanceQb);
    }
    if (eventEmbyEl) {
        state.eventInstanceEmby = eventEmbyEl.value || '';
        sessionStorage.setItem(EVENT_EMBY_INSTANCE_KEY, state.eventInstanceEmby);
    }
    if (embyEventLogTypeEl) {
        state.embyEventLogType = embyEventLogTypeEl.value || 'playback';
    }
    if (embyEventPlaybackUserEl) {
        state.embyEventPlaybackUser = embyEventPlaybackUserEl.value || '';
        sessionStorage.setItem(EMBY_EVENT_PLAYBACK_USER_KEY, state.embyEventPlaybackUser);
    }
    if (syslogQbEl) {
        state.syslogInstanceQb = syslogQbEl.value || '';
        sessionStorage.setItem(SYSLOG_QB_INSTANCE_KEY, state.syslogInstanceQb);
    }
    if (syslogEmbyEl) {
        state.syslogInstanceEmby = syslogEmbyEl.value || '';
        sessionStorage.setItem(SYSLOG_EMBY_INSTANCE_KEY, state.syslogInstanceEmby);
    }

    sessionStorage.setItem(CHART_CONTROLS_STORAGE_KEY, JSON.stringify(state));
}

function restoreChartControls() {
    const raw = sessionStorage.getItem(CHART_CONTROLS_STORAGE_KEY);
    if (!raw) return;

    let state;
    try {
        state = JSON.parse(raw);
    } catch {
        return;
    }

    const periodEl = document.getElementById('chartPeriod');
    const customEl = document.getElementById('chartUseCustomRange');
    if (!periodEl || !customEl) return;

    if (state.period && VALID_CHART_PERIODS.has(state.period)) {
        periodEl.value = state.period;
    }

    customEl.checked = !!state.useCustomRange;

    if (state.chartType && VALID_CHART_VIEW_TYPES.has(state.chartType)) {
        chartViewType = state.chartType;
    }

    const period = periodEl.value;
    applyChartRangeState(period, state);
    if (state.activePresetLabel) chartActivePresetLabel = state.activePresetLabel;
    if ('playbackUser' in state) {
        chartRestoredPlaybackUser = migrateChartPlaybackUserValue(state.playbackUser);
    }
    if (state.chartPlatform && typeof setDeviceTypeFilter === 'function') {
        setDeviceTypeFilter(state.chartPlatform);
    }
    if (state.chartInstance && state.chartPlatform) {
        sessionStorage.setItem(
            getChartInstanceStorageKey(state.chartPlatform),
            state.chartInstance,
        );
    } else if (state.chartPlatform) {
        sessionStorage.setItem(
            getChartInstanceStorageKey(state.chartPlatform),
            CHART_ALL_DEVICES_VALUE,
        );
    }
    if (state.eventInstanceQb != null) {
        sessionStorage.setItem(EVENT_QB_INSTANCE_KEY, state.eventInstanceQb);
    }
    if (state.eventInstanceEmby != null) {
        sessionStorage.setItem(EVENT_EMBY_INSTANCE_KEY, state.eventInstanceEmby);
    }
    if (state.embyEventLogType) {
        const logTypeEl = document.getElementById('embyEventLogType');
        if (logTypeEl) logTypeEl.value = state.embyEventLogType;
    }
    if (state.embyEventPlaybackUser != null) {
        sessionStorage.setItem(EMBY_EVENT_PLAYBACK_USER_KEY, state.embyEventPlaybackUser);
    }
    if (state.syslogInstanceQb != null) {
        sessionStorage.setItem(SYSLOG_QB_INSTANCE_KEY, state.syslogInstanceQb);
    }
    if (state.syslogInstanceEmby != null) {
        sessionStorage.setItem(SYSLOG_EMBY_INSTANCE_KEY, state.syslogInstanceEmby);
    }
}

function hasChartRangeInputValues(period) {
    if (period === 'cycle') {
        const cyclesEl = document.getElementById('chartRangeCycles');
        return !!cyclesEl?.value;
    }
    return !!(readChartRangeDateInput('start', period) && readChartRangeDateInput('end', period));
}

function syncChartRangeInputs() {
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    const customEnabled = document.getElementById('chartUseCustomRange')?.checked;
    setChartRangeInputsEnabled(!!customEnabled, period);

    if (!customEnabled) {
        if (!reapplyActiveChartQuickPreset({ skipPersist: true })
            && !hasChartRangeInputValues(period)) {
            if (!applyDefaultChartQuickRangeForPeriod(period)) {
                setDefaultChartRangeInputs(period);
            }
        }
        syncChartRangeQuickButtons();
        return;
    }

    if (!hasChartRangeInputValues(period)) {
        setDefaultChartRangeInputs(period);
    }

    applyChartRangeConstraints(period);
    syncChartRangeQuickButtons();
}

function getSelectedChartInstance() {
    const name = document.getElementById('chartInstance')?.value;
    if (!name || isChartAllDevicesValue(name)) return null;
    const platform = getChartPlatform();
    const instances = platform === 'emby' ? cachedEmbyInstances : cachedInstances;
    return instances.find(i => i.name === name) || null;
}

function getChartDataStartDate(period) {
    const inst = getSelectedChartInstance();
    if (!inst?.data_start_time) return null;
    const parsed = new Date(inst.data_start_time);
    if (Number.isNaN(parsed.getTime())) return null;
    if (period === 'hourly') {
        parsed.setMinutes(0, 0, 0);
    } else if (period === 'monthly') {
        parsed.setDate(1);
        parsed.setHours(0, 0, 0, 0);
    } else {
        parsed.setHours(0, 0, 0, 0);
    }
    return parsed;
}

function getQuickRangeDates(period, preset) {
    const now = getChartRangeNow(period);
    const end = new Date(now);
    let start = new Date(now);

    if (period === 'hourly') {
        if (preset.hours) {
            start = new Date(now.getTime() - preset.hours * 3600 * 1000);
        } else if (preset.today) {
            start = new Date(now);
            start.setHours(0, 0, 0, 0);
        } else if (preset.yesterday) {
            const yest = new Date(now);
            yest.setDate(yest.getDate() - 1);
            start = new Date(yest);
            start.setHours(0, 0, 0, 0);
            end.setTime(yest.getTime());
            end.setHours(23, 0, 0, 0);
        } else if (preset.thisWeek) {
            const day = start.getDay();
            const diff = (day === 0) ? -6 : 1 - day;
            start.setDate(start.getDate() + diff);
            start.setHours(0, 0, 0, 0);
        } else if (preset.lastWeek) {
            const day = start.getDay();
            const diff = (day === 0) ? -6 : 1 - day;
            start.setDate(start.getDate() + diff - 7);
            start.setHours(0, 0, 0, 0);
            end.setDate(end.getDate() + diff - 1);
            end.setHours(23, 0, 0, 0);
        } else if (preset.thisMonth) {
            start.setDate(1);
            start.setHours(0, 0, 0, 0);
        } else if (preset.lastMonth) {
            start.setDate(1);
            start.setMonth(start.getMonth() - 1);
            start.setHours(0, 0, 0, 0);
            end.setDate(0);
            end.setHours(23, 0, 0, 0);
        } else {
            return null;
        }
    } else if (period === 'daily') {
        if (preset.days) {
            start.setDate(start.getDate() - (preset.days - 1));
        } else if (preset.thisMonth) {
            start.setDate(1);
        } else if (preset.lastMonth) {
            start.setDate(1);
            start.setMonth(start.getMonth() - 1);
            end.setDate(0);
            end.setHours(0, 0, 0, 0);
        } else if (preset.thisWeek) {
            const day = start.getDay();
            const diff = (day === 0) ? -6 : 1 - day;
            start.setDate(start.getDate() + diff);
        } else if (preset.lastWeek) {
            const day = start.getDay();
            const diff = (day === 0) ? -6 : 1 - day;
            start.setDate(start.getDate() + diff - 7);
            end.setDate(end.getDate() + diff - 1);
        } else if (preset.thisYear) {
            start.setMonth(0, 1);
        } else if (preset.lastYear) {
            const year = end.getFullYear() - 1;
            start.setFullYear(year, 0, 1);
            end.setFullYear(year, 11, 31);
        } else if (preset.approxMonths) {
            start.setMonth(start.getMonth() - preset.approxMonths);
        } else {
            return null;
        }
    } else if (period === 'weekly' && preset.weeks) {
        start.setDate(start.getDate() - (preset.weeks * 7 - 1));
    } else if (period === 'monthly') {
        if (preset.allTime) {
            const dataStart = getChartDataStartDate('monthly');
            start = dataStart || earliestStartBySpan(end, period);
        } else if (preset.months) {
            start.setMonth(start.getMonth() - (preset.months - 1));
            start.setDate(1);
        } else if (preset.thisYear) {
            start.setMonth(0);
            start.setDate(1);
        } else if (preset.lastYear) {
            start.setFullYear(start.getFullYear() - 1);
            start.setMonth(0);
            start.setDate(1);
            end.setFullYear(end.getFullYear() - 1);
            end.setMonth(11);
            end.setDate(1);
        } else {
            return null;
        }
    } else {
        return null;
    }

    return { start, end };
}

function chartRangeDatesEqual(a, b, period) {
    if (!a || !b) return false;
    if (period === 'hourly') {
        return a.getTime() === b.getTime();
    }
    if (period === 'monthly') {
        return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
    }
    if (period === 'yearly') {
        return a.getFullYear() === b.getFullYear();
    }
    return toDateInputValue(a) === toDateInputValue(b);
}

function isChartQuickRangeActive() {
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    const presets = getActiveQuickRanges(chartViewType, period);
    if (!presets?.length) return false;

    const start = readChartRangeDateInput('start', period);
    const end = readChartRangeDateInput('end', period);
    if (!start || !end) return false;

    return presets.some((preset) => {
        const expected = getQuickRangeDates(period, preset);
        return expected
            && chartRangeDatesEqual(start, expected.start, period)
            && chartRangeDatesEqual(end, expected.end, period);
    });
}

function shouldUseChartRangeParams() {
    if (document.getElementById('chartUseCustomRange')?.checked) return true;
    return isChartQuickRangeActive();
}

function syncChartRangeQuickActive() {
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    const presets = getActiveQuickRanges(chartViewType, period);
    if (!presets?.length) return;

    const start = readChartRangeDateInput('start', period);
    const end = readChartRangeDateInput('end', period);

    const matchingLabels = new Set();
    if (start && end) {
        presets.forEach((preset) => {
            const expected = getQuickRangeDates(period, preset);
            if (expected
                && chartRangeDatesEqual(start, expected.start, period)
                && chartRangeDatesEqual(end, expected.end, period)) {
                matchingLabels.add(preset.label);
            }
        });
    }

    document.querySelectorAll('.chart-range-quick-btn[data-quick-index]').forEach(btn => {
        const idx = parseInt(btn.dataset.quickIndex, 10);
        const preset = presets[idx];
        if (!preset || !start || !end) {
            btn.classList.remove('active');
            btn.setAttribute('aria-pressed', 'false');
            return;
        }
        const dateMatches = matchingLabels.has(preset.label);
        let active;
        if (dateMatches && matchingLabels.size > 1) {
            active = chartActivePresetLabel !== null
                ? preset.label === chartActivePresetLabel
                : preset.label === [...matchingLabels][0];
        } else {
            active = dateMatches;
        }
        btn.classList.toggle('active', !!active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function syncChartRangeSide() {
    const side = document.getElementById('chartRangeSide');
    const fields = side?.querySelector('.chart-range-fields');
    const rangeControl = side?.closest('.chart-control--range-wrap');
    const customEnabled = document.getElementById('chartUseCustomRange')?.checked;
    const showSide = !!customEnabled;

    if (side) {
        side.hidden = !showSide;
        side.setAttribute('aria-hidden', showSide ? 'false' : 'true');
        side.classList.toggle('fields-collapsed', !customEnabled);
    }
    if (fields) {
        fields.classList.toggle('is-collapsed', !customEnabled);
        fields.setAttribute('aria-hidden', customEnabled ? 'false' : 'true');
    }
    if (rangeControl) {
        rangeControl.classList.toggle('is-expanded', !!showSide);
    }
}

function syncChartRangeQuickButtons() {
    const wrap = document.getElementById('chartRangeQuickWrap');
    const container = document.getElementById('chartRangeQuickButtons');
    if (!wrap || !container) return;

    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    const presets = getActiveQuickRanges(chartViewType, period);
    const hasQuickPresets = CHART_QUICK_RANGE_PERIODS.has(period) && !!presets?.length;

    syncChartRangeSide();
    wrap.hidden = !hasQuickPresets;
    wrap.setAttribute('aria-hidden', wrap.hidden ? 'true' : 'false');

    if (!hasQuickPresets) {
        container.innerHTML = '';
        container.dataset.period = '';
        container.dataset.viewType = '';
        return;
    }

    if (container.dataset.period !== period || container.dataset.viewType !== chartViewType) {
        container.innerHTML = presets.map((preset, index) => (
            `<button type="button" class="chart-range-quick-btn" data-quick-index="${index}" aria-pressed="false" onclick="onChartQuickRangeClick(${index})">${preset.label}</button>`
        )).join('');
        container.dataset.period = period;
        container.dataset.viewType = chartViewType;
    }

    syncChartRangeQuickActive();
}

function resetChartDatasetVisibility() {
    chartDatasetVisibility = isEmbyChartUploadOnly() ? [true] : [true, true];
    document.querySelectorAll('#chartLegendPanel .chart-legend-item[data-chart-dataset]').forEach(btn => {
        const idx = parseInt(btn.dataset.chartDataset, 10);
        if (btn.hidden) return;
        btn.classList.remove('inactive');
        btn.setAttribute('aria-pressed', 'true');
        if (trafficChart) trafficChart.setDatasetVisibility(idx, true);
    });
    if (trafficChart) {
        trafficChart.update('none');
        renderYAxisLabels();
    }
    syncChartLegendTotals();
}

function applyChartQuickRange(preset, options = {}) {
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    if (!applyChartQuickRangeDates(preset, period)) return;

    resetChartDatasetVisibility();
    syncChartRangeQuickButtons();
    persistChartControls();
    if (!options.skipUpdate) updateChart();
}

function onChartQuickRangeClick(index) {
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    const preset = getActiveQuickRanges(chartViewType, period)?.[index];
    if (!preset) return;
    applyChartQuickRange(preset);
}

function resetChartToFirstQuickRange(options = {}) {
    const customEl = document.getElementById('chartUseCustomRange');
    if (customEl?.checked) customEl.checked = false;
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    const presets = getActiveQuickRanges(chartViewType, period);
    if (presets?.length && CHART_QUICK_RANGE_PERIODS.has(period)) {
        const defaultPreset = pickDefaultQuickPreset(period, presets);
        if (defaultPreset) {
            applyChartQuickRange(defaultPreset, options);
            return;
        }
    }
    setDefaultChartRangeInputs(period);
    setChartRangeInputsEnabled(false, period);
    syncChartRangeQuickButtons();
}

function resetQbChartToFirstQuickRange() {
    resetChartToFirstQuickRange();
}

function monthsBetweenDates(start, end) {
    return (end.getFullYear() - start.getFullYear()) * 12
        + (end.getMonth() - start.getMonth()) + 1;
}

function yearsBetweenDates(start, end) {
    return end.getFullYear() - start.getFullYear() + 1;
}

function parseChartRangeDates(period, startVal, endVal) {
    if (period === 'hourly') {
        return { start: new Date(startVal), end: new Date(endVal) };
    }
    return {
        start: new Date(`${startVal}T00:00:00`),
        end: new Date(`${endVal}T00:00:00`),
    };
}

function onChartRangeStartChange() {
    chartActivePresetLabel = null;
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    applyChartRangeConstraints(period);
    syncChartRangeQuickActive();
    updateChart();
}

function clearChartRangeEndInput(period) {
    if (period === 'monthly') {
        const el = document.getElementById('chartRangeEndMonth');
        if (el) el.value = '';
        return;
    }
    if (period === 'yearly') {
        const el = document.getElementById('chartRangeEndYear');
        if (el) el.value = '';
        return;
    }
    const endEl = document.getElementById('chartRangeEnd');
    if (endEl) endEl.value = '';
    if (period === 'hourly') {
        const hourEl = document.getElementById('chartRangeEndHour');
        if (hourEl) hourEl.value = '0';
    }
}

function isCustomChartRangeReady(period) {
    if (period === 'cycle') return true;
    return !!(readChartRangeDateInput('start', period) && readChartRangeDateInput('end', period));
}

function onChartRangeStartFocus() {
    if (!document.getElementById('chartUseCustomRange')?.checked) return;
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    if (period === 'cycle') return;
    clearChartRangeEndInput(period);
    applyChartRangeConstraints(period);
}

function setupChartRangeStartFocus() {
    ['chartRangeStart', 'chartRangeStartMonth', 'chartRangeStartYear', 'chartRangeStartHour'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el.dataset.startFocusBound === '1') return;
        el.dataset.startFocusBound = '1';
        const handler = () => onChartRangeStartFocus();
        el.addEventListener('focus', handler);
        if (id === 'chartRangeStartHour') {
            el.addEventListener('mousedown', handler);
        }
    });
}

function onChartRangeEndChange() {
    chartActivePresetLabel = null;
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    applyChartRangeConstraints(period);
    syncChartRangeQuickActive();
    updateChart();
}

function onChartRangeChange() {
    chartActivePresetLabel = null;
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    applyChartRangeConstraints(period);
    syncChartRangeQuickActive();
    updateChart();
}

function onChartPeriodChange() {
    chartActivePresetLabel = null;
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    const customEnabled = document.getElementById('chartUseCustomRange')?.checked;
    if (!customEnabled && CHART_QUICK_RANGE_PERIODS.has(period)) {
        if (applyDefaultChartQuickRangeForPeriod(period)) {
            syncChartRangeQuickButtons();
            persistChartControls();
            updateChart();
            return;
        }
    }
    setDefaultChartRangeInputs(period);
    setChartRangeInputsEnabled(!!customEnabled, period);
    syncChartRangeQuickButtons();
    updateChart();
}

function onChartRangeToggle() {
    const period = document.getElementById('chartPeriod')?.value || 'hourly';
    const enabled = document.getElementById('chartUseCustomRange')?.checked;
    setChartRangeInputsEnabled(!!enabled, period);
    syncChartRangeSide();
    if (enabled) {
        syncChartRangeInputs();
    } else if (chartActivePresetLabel) {
        reapplyActiveChartQuickPreset({ skipPersist: true });
    } else if (!isChartQuickRangeActive()) {
        setDefaultChartRangeInputs(period);
    }
    syncChartRangeQuickButtons();
    updateChart();
}

function onChartTypeChange(type) {
    if (!VALID_CHART_VIEW_TYPES.has(type) || chartViewType === type) return;
    chartViewType = type;
    persistChartControls();
    syncChartTypeToggle();
    syncChartLegendBackfillHint();
    syncChartRangeQuickButtons();
    if (!document.getElementById('chartUseCustomRange')?.checked) {
        reapplyActiveChartQuickPreset({ skipPersist: true });
    }
    if (lastChartPayload) {
        renderChart(
            lastChartPayload.uploadData,
            lastChartPayload.downloadData,
            lastChartPayload.period,
            lastChartPayload.instance,
            true,
        );
    }
}

function syncChartTypeToggle() {
    document.querySelectorAll('.chart-type-btn[data-chart-type]').forEach(btn => {
        const active = btn.dataset.chartType === chartViewType;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function syncChartLegendBackfillHint() {
    const barHint = document.getElementById('chartBackfillHint');
    const pieHint = document.getElementById('chartPieHint');
    const lineHint = document.getElementById('chartZoomHint');
    const containerEl = document.getElementById('chartContainer');
    const chartVisible = containerEl && !containerEl.hidden;
    const type = chartViewType;
    if (barHint) barHint.hidden = !chartVisible || type !== 'bar';
    if (lineHint) lineHint.hidden = !chartVisible || type !== 'line';
    if (pieHint) pieHint.hidden = !chartVisible || type !== 'pie';
}

function getChartQueryParams() {
    const period = document.getElementById('chartPeriod').value;
    const useRangeParams = shouldUseChartRangeParams();
    const params = {};
    const limits = getCustomRangeLimits(period);

    if (useRangeParams) {
        if (period === 'cycle') {
            const cyclesEl = document.getElementById('chartRangeCycles');
            let cycles = parseInt(cyclesEl?.value ?? '', 10);
            if (!Number.isFinite(cycles)) cycles = limits.maxCycles;
            params.cycles = Math.min(limits.maxCustomCycles, Math.max(1, cycles));
            return params;
        }

        const startDate = readChartRangeDateInput('start', period);
        const endDate = readChartRangeDateInput('end', period);
        if (period === 'hourly' && startDate && endDate) {
            params.start = toDatetimeLocalHourValue(startDate);
            params.end = toDatetimeLocalHourValue(endDate);
        } else if ((period === 'daily' || period === 'weekly') && startDate && endDate) {
            params.start = toDateInputValue(startDate);
            params.end = toDateInputValue(endDate);
        } else if (period === 'monthly' && startDate && endDate) {
            params.start = toMonthInputValue(startDate);
            params.end = toMonthInputValue(endDate);
            params.months = Math.min(
                limits.maxCustomMonths,
                Math.max(1, monthsBetweenDates(startDate, endDate)),
            );
        } else if (period === 'yearly' && startDate && endDate) {
            params.start_year = startDate.getFullYear();
            params.end_year = endDate.getFullYear();
            params.years = Math.min(
                limits.maxCustomYears,
                Math.max(1, yearsBetweenDates(startDate, endDate)),
            );
        }
        return params;
    }

    if (period === 'hourly') params.hours = limits.maxHours;
    else if (period === 'daily') params.days = limits.maxDays;
    else if (period === 'weekly') params.weeks = limits.maxBars;
    else if (period === 'monthly') params.months = limits.maxMonths;
    else if (period === 'yearly') params.years = limits.maxYears;
    else if (period === 'cycle') params.cycles = limits.maxCycles;
    return params;
}

const CHART_BRACKET_ARM_HEIGHT = 7;
const CHART_BRACKET_TEXT_GAP = 2;
const HOURLY_BRACKET_BOTTOM_PAD = 36;
const CHART_TOP_PAD = 10;
const CHART_FULLSCREEN_TOP_PAD = 4;
const CHART_FULLSCREEN_BOTTOM_PAD = 2;
const CHART_FULLSCREEN_BOTTOM_PAD_BRACKET = 32;
const CHART_FULLSCREEN_X_TICK_FONT_SIZE = 9;
const CHART_FULLSCREEN_Y_TICK_FONT_SIZE = 9;

function getHourlyBracketLayout(chart) {
    const x = chart.scales.x;
    const tickFontSize = x.options.ticks?.font?.size || CHART_AXIS_TICK_FONT_SIZE;
    const tickBottom = x.bottom;
    return {
        armTop: tickBottom,
        lineY: tickBottom + CHART_BRACKET_ARM_HEIGHT,
        textY: tickBottom + CHART_BRACKET_ARM_HEIGHT + CHART_BRACKET_TEXT_GAP,
        titlePadTop: tickBottom + CHART_BRACKET_ARM_HEIGHT + CHART_BRACKET_TEXT_GAP + tickFontSize - x.top,
    };
}

function createBarHatchPattern(baseColor) {
    const size = 8;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.28)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
    ctx.moveTo(-size * 0.5, size * 0.5);
    ctx.lineTo(size * 0.5, -size * 0.5);
    ctx.moveTo(size * 0.5, size * 1.5);
    ctx.lineTo(size * 1.5, size * 0.5);
    ctx.stroke();
    return ctx.createPattern(canvas, 'repeat');
}

const backfillBarHatchPlugin = {
    id: 'backfillBarHatch',
    afterDatasetsDraw(chart) {
        const meta = chart.$backfillMeta;
        if (!meta) return;
        const { ctx } = chart;
        const uploadBackfill = meta.backfillUploadValues || [];
        const downloadBackfill = meta.backfillDownloadValues || [];
        const hatchColors = [
            'rgba(37, 99, 235, 0.88)',
            'rgba(16, 185, 129, 0.88)',
        ];
        const backfillSets = [uploadBackfill, downloadBackfill];

        ctx.save();
        [0, 1].forEach((datasetIndex) => {
            const dsMeta = chart.getDatasetMeta(datasetIndex);
            if (dsMeta.hidden) return;
            const pattern = createBarHatchPattern(hatchColors[datasetIndex]);
            const backfillData = backfillSets[datasetIndex];
            dsMeta.data.forEach((bar, index) => {
                const total = Number(chart.data.datasets[datasetIndex].data[index]) || 0;
                const backfill = Number(backfillData[index]) || 0;
                if (backfill <= 0 || total <= 0 || bar?.y == null) return;
                const barHeight = bar.base - bar.y;
                const hatchHeight = barHeight * (backfill / total);
                if (hatchHeight <= 0) return;
                ctx.fillStyle = pattern;
                ctx.fillRect(bar.x - bar.width / 2, bar.y, bar.width, hatchHeight);
            });
        });
        ctx.restore();
    },
};

function drawDateBracket(ctx, xStart, xEnd, armTop, lineY, radius = 4) {
    ctx.beginPath();
    ctx.moveTo(xStart, armTop);
    ctx.lineTo(xStart, lineY - radius);
    ctx.quadraticCurveTo(xStart, lineY, xStart + radius, lineY);
    ctx.lineTo(xEnd - radius, lineY);
    ctx.quadraticCurveTo(xEnd, lineY, xEnd, lineY - radius);
    ctx.lineTo(xEnd, armTop);
    ctx.stroke();
}

function createHourlyDateBracketPlugin(dateGroups) {
    return {
        id: 'hourlyDateBracket',
        afterDraw(chart) {
            if (!dateGroups?.length) return;

            const { ctx, scales: { x } } = chart;
            const layout = getHourlyBracketLayout(chart);
            const isLine = chart.config?.type === 'line';

            ctx.save();
            const tickStyle = chart.scales.x.options.ticks || {};
            const tickColor = isLine ? 'rgba(100, 116, 139, 0.72)' : (tickStyle.color || CHART_AXIS_TICK_COLOR);
            const tickSize = tickStyle.font?.size || CHART_AXIS_TICK_FONT_SIZE;
            ctx.strokeStyle = tickColor;
            ctx.fillStyle = tickColor;
            ctx.lineWidth = isLine ? 0.8 : 1;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.font = `normal ${tickSize}px ${CHART_AXIS_FONT_FAMILY}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            dateGroups.forEach((group) => {
                const xStart = x.getPixelForValue(group.startIndex);
                const xEnd = x.getPixelForValue(group.endIndex);
                const midX = (xStart + xEnd) / 2;

                drawDateBracket(ctx, xStart, xEnd, layout.armTop, layout.lineY, 4);
                ctx.fillText(group.dateLabel, midX, layout.textY);
            });

            ctx.restore();
        },
    };
}

function createLineChartMonthGridPlugin(dateGroups) {
    return {
        id: 'lineChartMonthGrid',
        beforeDatasetsDraw(chart) {
            if (!dateGroups?.length || chart.config?.type !== 'line') return;
            const { ctx, scales: { x, y } } = chart;
            ctx.save();
            ctx.strokeStyle = 'rgba(15, 23, 42, 0.06)';
            ctx.lineWidth = 1;
            dateGroups.forEach((group, index) => {
                if (index === 0) return;
                const xPos = x.getPixelForValue(group.startIndex);
                ctx.beginPath();
                ctx.moveTo(xPos, y.top);
                ctx.lineTo(xPos, y.bottom);
                ctx.stroke();
            });
            ctx.restore();
        },
    };
}

const CHART_BAR_GROUP_OPTIONS = {
    barPercentage: 1,
    categoryPercentage: 0.9,
};

const CHART_LEGEND_OPTIONS = {
    display: false,
};

function sumChartGbValues(values) {
    return (values || []).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function sumChartBytesFromRows(rows) {
    return (rows || []).reduce((sum, row) => sum + (Number(row?.total_bytes) || 0), 0);
}

function syncChartLegendTotals() {
    const uploadOnly = isEmbyChartUploadOnly();
    if (lastChartLegendTotals) {
        const uploadValueEl = document.querySelector('#chartLegendTotalUpload .chart-legend-total-value');
        const downloadValueEl = document.querySelector('#chartLegendTotalDownload .chart-legend-total-value');
        if (uploadValueEl) {
            uploadValueEl.textContent = formatChartLegendTotalFromBytes(
                lastChartLegendTotals.uploadBytes ?? 0,
            );
        }
        if (downloadValueEl && !uploadOnly) {
            downloadValueEl.textContent = formatChartLegendTotalFromBytes(
                lastChartLegendTotals.downloadBytes ?? 0,
            );
        }
    }
    document.querySelectorAll('#chartLegendPanel .chart-legend-total[data-chart-dataset]').forEach(el => {
        const idx = parseInt(el.dataset.chartDataset, 10);
        if (uploadOnly && idx === 1) {
            el.hidden = true;
            return;
        }
        const visible = chartDatasetVisibility[idx] !== false;
        el.hidden = !visible;
    });
    syncChartLegendPlatformUi();
}

function setupChartLegendPanel() {
    document.querySelectorAll('#chartLegendPanel .chart-legend-item[data-chart-dataset]').forEach(btn => {
        if (btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.chartDataset, 10);
            const visible = chartDatasetVisibility[idx] !== false;
            const nextVisible = !visible;
            chartDatasetVisibility[idx] = nextVisible;
            if (!trafficChart) return;
            trafficChart.setDatasetVisibility(idx, nextVisible);
            btn.classList.toggle('inactive', !nextVisible);
            btn.setAttribute('aria-pressed', nextVisible ? 'true' : 'false');
            trafficChart.update('none');
            renderYAxisLabels();
            syncChartLegendTotals();
        });
    });
}

function syncChartLegendPanel() {
    document.querySelectorAll('#chartLegendPanel .chart-legend-item[data-chart-dataset]').forEach(btn => {
        const idx = parseInt(btn.dataset.chartDataset, 10);
        const visible = chartDatasetVisibility[idx] !== false;
        if (trafficChart) {
            trafficChart.setDatasetVisibility(idx, visible);
        }
        btn.classList.toggle('inactive', !visible);
        btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
    });
    if (trafficChart) {
        trafficChart.update('none');
        renderYAxisLabels();
    }
    syncChartLegendTotals();
}

function buildChartScales(period, chartType = 'bar', labelCount = 0) {
    const isHourly = period === 'hourly';
    const isLine = chartType === 'line';
    return {
        x: {
            stacked: false,
            title: { display: false },
            ticks: {
                maxRotation: isLine ? 0 : (isHourly ? 0 : 45),
                minRotation: 0,
                autoSkip: false,
                padding: isLine ? 4 : 6,
                color: isLine ? 'rgba(100, 116, 139, 0.88)' : CHART_AXIS_TICK_COLOR,
                font: {
                    size: CHART_AXIS_TICK_FONT_SIZE,
                    weight: 'normal',
                    family: CHART_AXIS_FONT_FAMILY,
                },
                callback(value, index) {
                    const step = chartXTickStep;
                    const labelCount = this.chart?.data?.labels?.length ?? 0;
                    const isEdge = index === 0 || index === labelCount - 1;
                    if (!isEdge && index % step !== 0) return '';
                    return this.getLabelForValue(value);
                },
            },
            grid: {
                display: true,
                color: isLine ? 'rgba(15, 23, 42, 0.04)' : 'rgba(15, 23, 42, 0.06)',
                drawOnChartArea: true,
                drawTicks: false,
            },
            border: {
                display: isLine,
                color: 'rgba(15, 23, 42, 0.08)',
            },
        },
        y: {
            stacked: false,
            beginAtZero: true,
            grace: isLine ? LINE_CHART_Y_GRACE : '10%',
            ticks: { display: false },
            border: { display: false },
            title: { display: false },
            grid: {
                display: true,
                color: isLine ? 'rgba(15, 23, 42, 0.06)' : 'rgba(15, 23, 42, 0.08)',
            },
        },
    };
}

function clearYAxisLabels() {
    const panel = document.getElementById('chartYAxisLabels');
    if (panel) {
        panel.innerHTML = '';
        panel.style.height = '';
    }
    syncChartYAxisUnit();
}

function isMobileChartCompactYAxis() {
    return chartFullscreenActive || isMobileChartView() || isMobileTouchDevice();
}

function formatChartYAxisLabel(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    if (isMobileChartCompactYAxis()) {
        return `${Math.round(n)}`;
    }
    return `${n.toFixed(1)} GB`;
}

function positionChartYAxisUnit(chart, canvasOffsetTop) {
    const unitEl = document.getElementById('chartYAxisUnit');
    if (!unitEl || unitEl.hidden || !chart?.scales?.y?.ticks?.length) return;

    const y = chart.scales.y;
    const yPx = y.getPixelForValue(0);
    const fontSize = isMobileChartCompactYAxis()
        ? CHART_FULLSCREEN_Y_TICK_FONT_SIZE
        : CHART_AXIS_TICK_FONT_SIZE;
    const gap = 5;
    unitEl.style.top = `${canvasOffsetTop + yPx + fontSize * 0.55 + gap}px`;
}

function syncChartYAxisUnit() {
    const unitEl = document.getElementById('chartYAxisUnit');
    const layout = document.getElementById('chartBarLineLayout');
    const compact = isMobileChartCompactYAxis()
        && trafficChart
        && chartViewType !== 'pie';
    if (unitEl) unitEl.hidden = !compact;
    if (layout) layout.classList.toggle('chart-layout--compact-y', compact);
}

function renderYAxisLabels() {
    const chart = trafficChart;
    const panel = document.getElementById('chartYAxisLabels');
    const slot = document.querySelector('.chart-y-axis-slot');
    if (!chart || !panel || !slot) return;

    const y = chart.scales.y;
    if (!y?.ticks?.length) {
        clearYAxisLabels();
        return;
    }

    const slotRect = slot.getBoundingClientRect();
    const canvasRect = chart.canvas.getBoundingClientRect();
    if (!slotRect.height || !canvasRect.height) return;

    panel.style.height = `${slotRect.height}px`;
    const canvasOffsetTop = canvasRect.top - slotRect.top;

    panel.innerHTML = y.ticks.map((tick) => {
        const yPx = y.getPixelForValue(tick.value);
        const top = canvasOffsetTop + yPx;
        const label = formatChartYAxisLabel(tick.value);
        return `<span class="chart-y-axis-label" style="top:${top}px">${label}</span>`;
    }).join('');
    syncChartYAxisUnit();
    if (isMobileChartCompactYAxis()) {
        positionChartYAxisUnit(chart, canvasOffsetTop);
    }
}

const yAxisLabelsPlugin = {
    id: 'yAxisLabels',
    afterLayout(chart) {
        if (chart === trafficChart) {
            renderYAxisLabels();
        }
    },
};

function resolveChartCategoryCenterX(chart, index) {
    const xScale = chart.scales.x;
    if (!xScale || index == null) return null;
    return xScale.getPixelForValue(index);
}

function resolveChartCrosshairX(chart, event) {
    const pos = Chart.helpers.getRelativePosition(event, chart);
    const { chartArea } = chart;
    if (!chartArea) return null;

    if (
        pos.x < chartArea.left || pos.x > chartArea.right
        || pos.y < chartArea.top || pos.y > chartArea.bottom
    ) {
        return null;
    }

    const elements = chart.getElementsAtEventForMode(
        event,
        'index',
        { intersect: false },
        false,
    );
    if (elements.length > 0) {
        const index = elements[0].index;
        if (chart.config.type === 'bar') {
            return resolveChartCategoryCenterX(chart, index);
        }
        const element = elements[0].element;
        if (element && Number.isFinite(element.x)) {
            return element.x;
        }
        return resolveChartCategoryCenterX(chart, index);
    }

    const xScale = chart.scales.x;
    const labelCount = chart.data?.labels?.length || 0;
    if (!xScale || labelCount <= 0) return pos.x;

    let nearestIndex = 0;
    let minDist = Infinity;
    for (let i = 0; i < labelCount; i += 1) {
        const px = xScale.getPixelForValue(i);
        const dist = Math.abs(px - pos.x);
        if (dist < minDist) {
            minDist = dist;
            nearestIndex = i;
        }
    }
    return resolveChartCategoryCenterX(chart, nearestIndex);
}

function setChartCrosshairX(chart, x) {
    if (!chart) return;
    const next = Number.isFinite(x) ? x : null;
    if (chart.$crosshairX === next) return;
    chart.$crosshairX = next;
    if (chart.$crosshairDrawRaf) return;
    chart.$crosshairDrawRaf = requestAnimationFrame(() => {
        chart.$crosshairDrawRaf = null;
        chart.draw();
    });
}

function clearChartCrosshair(chart) {
    setChartCrosshairX(chart, null);
}

function bindChartCrosshairEvents(chart) {
    if (!chart?.canvas || chart.canvas.dataset.crosshairBound) return;
    chart.canvas.dataset.crosshairBound = '1';

    const isDragScrolling = () => {
        const scrollWrap = chart.canvas.closest('.chart-scroll-wrap');
        return scrollWrap?.classList.contains('chart-scroll-wrap--dragging');
    };

    const onPointerMove = (event) => {
        if (isDragScrolling()) {
            clearChartCrosshair(chart);
            return;
        }
        const x = resolveChartCrosshairX(chart, event);
        setChartCrosshairX(chart, x);
    };

    const onPointerLeave = () => {
        clearChartCrosshair(chart);
    };

    chart.canvas.addEventListener('mousemove', onPointerMove);
    chart.canvas.addEventListener('mouseleave', onPointerLeave);
    chart.canvas.addEventListener('touchstart', onPointerMove, { passive: true });
    chart.canvas.addEventListener('touchmove', onPointerMove, { passive: true });
    chart.canvas.addEventListener('touchend', onPointerLeave, { passive: true });
    chart.canvas.addEventListener('touchcancel', onPointerLeave, { passive: true });

    chart.$crosshairCleanup = () => {
        chart.canvas.removeEventListener('mousemove', onPointerMove);
        chart.canvas.removeEventListener('mouseleave', onPointerLeave);
        chart.canvas.removeEventListener('touchstart', onPointerMove);
        chart.canvas.removeEventListener('touchmove', onPointerMove);
        chart.canvas.removeEventListener('touchend', onPointerLeave);
        chart.canvas.removeEventListener('touchcancel', onPointerLeave);
        delete chart.canvas.dataset.crosshairBound;
        if (chart.$crosshairDrawRaf) {
            cancelAnimationFrame(chart.$crosshairDrawRaf);
            chart.$crosshairDrawRaf = null;
        }
        chart.$crosshairX = null;
    };
}

const chartCrosshairPlugin = {
    id: 'chartCrosshair',
    afterInit(chart) {
        bindChartCrosshairEvents(chart);
    },
    beforeDestroy(chart) {
        chart.$crosshairCleanup?.();
    },
    afterDatasetsDraw(chart) {
        if (chart.$crosshairX == null) return;

        const { ctx, chartArea } = chart;
        if (!chartArea) return;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(chart.$crosshairX, chartArea.top);
        ctx.lineTo(chart.$crosshairX, chartArea.bottom);
        ctx.strokeStyle = 'rgba(71, 85, 105, 0.58)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.restore();
    },
};

function destroyTrafficCharts() {
    if (trafficChart) {
        trafficChart.destroy();
        trafficChart = null;
    }
    if (trafficPieUpChart) {
        trafficPieUpChart.destroy();
        trafficPieUpChart = null;
    }
    if (trafficPieDlChart) {
        trafficPieDlChart.destroy();
        trafficPieDlChart = null;
    }
    clearYAxisLabels();
    teardownChartScrollLayout();
}

function getChartScrollElements() {
    const containerEl = document.getElementById('chartContainer');
    return {
        scrollWrap: containerEl?.querySelector('.chart-scroll-wrap'),
        canvasWrap: containerEl?.querySelector('.chart-canvas-wrap'),
    };
}

function engageChartHScrollRail(mainCol) {
    if (!mainCol) return;
    mainCol.classList.add('chart-main-col--hscroll-engaged');
    if (mainCol._hScrollHideTimer) {
        clearTimeout(mainCol._hScrollHideTimer);
    }
    mainCol._hScrollHideTimer = setTimeout(() => {
        mainCol.classList.remove('chart-main-col--hscroll-engaged');
        mainCol._hScrollHideTimer = null;
    }, 900);
}

function scheduleChartHScrollRailSync(scrollWrap) {
    if (!scrollWrap) return;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => syncChartHScrollRail(scrollWrap));
    });
}

function syncChartHScrollRail(scrollWrap) {
    const mainCol = scrollWrap?.closest('.chart-main-col');
    const rail = mainCol?.querySelector('.chart-hscroll-rail');
    const thumb = mainCol?.querySelector('.chart-hscroll-rail-thumb');
    if (!rail || !thumb) return;

    const { scrollLeft, scrollWidth, clientWidth } = scrollWrap;
    if (scrollWidth <= clientWidth + 1) {
        rail.hidden = true;
        scrollWrap.classList.remove('chart-scroll-wrap--scrollable');
        return;
    }

    rail.hidden = false;
    scrollWrap.classList.add('chart-scroll-wrap--scrollable');
    const trackWidth = rail.clientWidth;
    const thumbWidth = Math.max(36, (clientWidth / scrollWidth) * trackWidth);
    const maxLeft = trackWidth - thumbWidth;
    const left = maxLeft <= 0 ? 0 : (scrollLeft / (scrollWidth - clientWidth)) * maxLeft;
    thumb.style.width = `${thumbWidth}px`;
    thumb.style.transform = `translateX(${left}px)`;
}

function setupChartHScrollRailInteraction(scrollWrap) {
    const mainCol = scrollWrap.closest('.chart-main-col');
    const rail = mainCol?.querySelector('.chart-hscroll-rail');
    const thumb = mainCol?.querySelector('.chart-hscroll-rail-thumb');
    if (!rail || !thumb || rail.dataset.interactionReady) return;
    rail.dataset.interactionReady = '1';

    const scrollToRatio = (ratio) => {
        const maxScroll = scrollWrap.scrollWidth - scrollWrap.clientWidth;
        scrollWrap.scrollLeft = Math.max(0, Math.min(maxScroll, ratio * maxScroll));
        syncChartHScrollRail(scrollWrap);
        engageChartHScrollRail(mainCol);
    };

    rail.addEventListener('mousedown', (e) => {
        if (e.target === thumb) return;
        const rect = rail.getBoundingClientRect();
        scrollToRatio((e.clientX - rect.left) / rect.width);
    });

    const startDrag = (clientX) => {
        const startX = clientX;
        const startScroll = scrollWrap.scrollLeft;
        const thumbWidth = thumb.offsetWidth;
        const trackRange = Math.max(1, rail.clientWidth - thumbWidth);
        const scrollRange = scrollWrap.scrollWidth - scrollWrap.clientWidth;

        const onMove = (x) => {
            const delta = x - startX;
            scrollWrap.scrollLeft = startScroll + (delta / trackRange) * scrollRange;
            syncChartHScrollRail(scrollWrap);
            engageChartHScrollRail(mainCol);
        };

        const onMouseMove = (e) => onMove(e.clientX);
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };

    thumb.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startDrag(e.clientX);
    });

    scrollWrap.addEventListener('scroll', () => {
        syncChartHScrollRail(scrollWrap);
        engageChartHScrollRail(mainCol);
    });

    setupChartDragScroll(scrollWrap, mainCol);
}

function setupChartDragScroll(scrollWrap, mainCol) {
    if (scrollWrap.dataset.dragScrollReady) return;
    scrollWrap.dataset.dragScrollReady = '1';

    let dragging = false;
    let pending = false;
    let startX = 0;
    let startScrollLeft = 0;

    const canScroll = () => scrollWrap.scrollWidth > scrollWrap.clientWidth + 1;

    scrollWrap.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (!canScroll()) return;
        if (e.target.closest('.chart-hscroll-rail')) return;

        pending = true;
        dragging = false;
        startX = e.clientX;
        startScrollLeft = scrollWrap.scrollLeft;
    }, true);

    document.addEventListener('mousemove', (e) => {
        if (!pending && !dragging) return;

        if (pending && !dragging) {
            if (Math.abs(e.clientX - startX) < 4) return;
            pending = false;
            dragging = true;
            scrollWrap.classList.add('chart-scroll-wrap--dragging');
        }

        if (!dragging) return;

        e.preventDefault();
        e.stopPropagation();
        scrollWrap.scrollLeft = startScrollLeft - (e.clientX - startX);
        syncChartHScrollRail(scrollWrap);
        engageChartHScrollRail(mainCol);
    }, true);

    const stopDrag = () => {
        pending = false;
        if (dragging) {
            dragging = false;
            scrollWrap.classList.remove('chart-scroll-wrap--dragging');
        }
    };

    document.addEventListener('mouseup', stopDrag);
}

function teardownChartScrollLayout() {
    if (chartWheelZoomCleanup) {
        chartWheelZoomCleanup();
        chartWheelZoomCleanup = null;
    }
    if (chartScrollResizeObserver) {
        chartScrollResizeObserver.disconnect();
        chartScrollResizeObserver = null;
    }
    const { scrollWrap, canvasWrap } = getChartScrollElements();
    if (canvasWrap) canvasWrap.style.width = '';
    if (scrollWrap) {
        const mainCol = scrollWrap.closest('.chart-main-col');
        const rail = mainCol?.querySelector('.chart-hscroll-rail');
        if (rail) rail.hidden = true;
        mainCol?.classList.remove('chart-main-col--hscroll-engaged');
        scrollWrap.classList.remove('chart-scroll-wrap--scrollable', 'chart-scroll-wrap--dragging');
    }
}

function applyChartScrollLayout(barCount) {
    const { scrollWrap, canvasWrap } = getChartScrollElements();
    if (!scrollWrap || !canvasWrap || barCount <= 0) return;

    const viewportWidth = scrollWrap.clientWidth || scrollWrap.getBoundingClientRect().width;
    const labels = trafficChart?.data?.labels || [];
    chartScrollMinCategoryWidth = resolveChartCategoryWidth(viewportWidth, barCount);

    const minContentWidth = Math.max(
        viewportWidth,
        barCount * chartScrollMinCategoryWidth,
    );
    canvasWrap.style.width = `${Math.ceil(minContentWidth)}px`;
    if (trafficChart) {
        const prevStep = chartXTickStep;
        refreshChartXTickStep(barCount, minContentWidth, labels);
        trafficChart.resize();
        if (prevStep !== chartXTickStep) {
            trafficChart.update('none');
        }
        renderYAxisLabels();
    }
    scheduleChartHScrollRailSync(scrollWrap);
}

function applyChartCategoryZoom(scrollWrap, nextWidth, anchorClientX) {
    if (!trafficChart || chartViewType === 'pie') return;
    const barCount = trafficChart.data?.labels?.length || 0;
    if (barCount <= 1) return;

    const viewportWidth = scrollWrap.clientWidth || scrollWrap.getBoundingClientRect().width;
    const { min, max } = getCategoryWidthLimits(viewportWidth, barCount);
    const current = resolveChartCategoryWidth(viewportWidth, barCount);
    const next = Math.max(min, Math.min(max, nextWidth));
    if (Math.abs(next - current) < 0.25) return;

    const wrapRect = scrollWrap.getBoundingClientRect();
    const pointerOffset = anchorClientX - wrapRect.left;
    const oldScrollWidth = scrollWrap.scrollWidth;
    const anchorRatio = (scrollWrap.scrollLeft + pointerOffset) / Math.max(1, oldScrollWidth);

    chartUserCategoryWidth = next;
    applyChartScrollLayout(barCount);

    const newScrollWidth = scrollWrap.scrollWidth;
    scrollWrap.scrollLeft = anchorRatio * newScrollWidth - pointerOffset;
    scheduleChartHScrollRailSync(scrollWrap);
}

function setupChartWheelZoom(scrollWrap) {
    if (chartWheelZoomCleanup) {
        chartWheelZoomCleanup();
        chartWheelZoomCleanup = null;
    }
    if (!scrollWrap || chartViewType === 'pie') return;

    const onWheel = (e) => {
        if (!trafficChart || chartViewType === 'pie') return;
        const barCount = trafficChart.data?.labels?.length || 0;
        if (barCount <= 1) return;

        e.preventDefault();

        const viewportWidth = scrollWrap.clientWidth || scrollWrap.getBoundingClientRect().width;
        const current = resolveChartCategoryWidth(viewportWidth, barCount);
        const factor = e.deltaY < 0 ? CHART_WHEEL_ZOOM_FACTOR : 1 / CHART_WHEEL_ZOOM_FACTOR;
        applyChartCategoryZoom(scrollWrap, current * factor, e.clientX);
    };

    let pinching = false;
    let pinchStartDistance = 0;
    let pinchStartWidth = 0;

    const getTouchDistance = (touches) => {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.hypot(dx, dy);
    };

    const getTouchCenterX = (touches) => (
        (touches[0].clientX + touches[1].clientX) / 2
    );

    const onTouchStart = (e) => {
        if (!trafficChart || chartViewType === 'pie' || e.touches.length !== 2) return;
        pinching = true;
        pinchStartDistance = getTouchDistance(e.touches);
        const viewportWidth = scrollWrap.clientWidth || scrollWrap.getBoundingClientRect().width;
        const barCount = trafficChart.data?.labels?.length || 0;
        pinchStartWidth = resolveChartCategoryWidth(viewportWidth, barCount);
    };

    const onTouchMove = (e) => {
        if (!pinching || e.touches.length !== 2) return;
        e.preventDefault();
        if (pinchStartDistance <= 0) return;
        const scale = getTouchDistance(e.touches) / pinchStartDistance;
        applyChartCategoryZoom(scrollWrap, pinchStartWidth * scale, getTouchCenterX(e.touches));
    };

    const endPinch = (e) => {
        if (e.touches.length < 2) pinching = false;
    };

    scrollWrap.addEventListener('wheel', onWheel, { passive: false });
    scrollWrap.addEventListener('touchstart', onTouchStart, { passive: true });
    scrollWrap.addEventListener('touchmove', onTouchMove, { passive: false });
    scrollWrap.addEventListener('touchend', endPinch, { passive: true });
    scrollWrap.addEventListener('touchcancel', endPinch, { passive: true });
    chartWheelZoomCleanup = () => {
        scrollWrap.removeEventListener('wheel', onWheel);
        scrollWrap.removeEventListener('touchstart', onTouchStart);
        scrollWrap.removeEventListener('touchmove', onTouchMove);
        scrollWrap.removeEventListener('touchend', endPinch);
        scrollWrap.removeEventListener('touchcancel', endPinch);
    };
}

function setupChartScrollResize(barCount) {
    const { scrollWrap } = getChartScrollElements();
    if (!scrollWrap) return;

    setupChartHScrollRailInteraction(scrollWrap);
    setupChartWheelZoom(scrollWrap);

    if (chartScrollResizeObserver) {
        chartScrollResizeObserver.disconnect();
    }
    chartScrollResizeObserver = new ResizeObserver(() => {
        applyChartScrollLayout(barCount);
        scheduleChartHScrollRailSync(scrollWrap);
    });
    chartScrollResizeObserver.observe(scrollWrap);
}

let chartFullscreenActive = false;
let chartFullscreenNative = false;
let chartFullscreenRestore = null;
let chartFullscreenExitTimer = null;

function isMobileChartView() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function isMobileTouchDevice() {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function syncChartFullscreenEnterVisibility() {
    const btn = document.getElementById('chartFullscreenEnter');
    const container = document.getElementById('chartContainer');
    if (!btn) return;
    const show = (isMobileChartView() || isMobileTouchDevice())
        && container && !container.hidden
        && !chartFullscreenActive;
    btn.hidden = !show;
}

function resizeActiveCharts() {
    if (trafficChart) {
        if (chartFullscreenActive) applyChartFullscreenChartStyle(true);
        const barCount = trafficChart.data?.labels?.length || 0;
        applyChartScrollLayout(barCount);
    }
    if (chartViewType === 'pie') {
        if (chartFullscreenActive) applyChartFullscreenPieStyle(true);
    }
    if (trafficPieUpChart) trafficPieUpChart.resize();
    if (trafficPieDlChart) trafficPieDlChart.resize();
}

function resolveFullscreenPiePadding(chart) {
    const wrap = chart?.canvas?.closest('.chart-pie-canvas-wrap');
    const width = wrap?.clientWidth || chart?.canvas?.clientWidth || 0;
    const height = wrap?.clientHeight || chart?.canvas?.clientHeight || 0;
    const minDim = Math.min(width, height);
    if (minDim <= 0) return isMobileChartView() ? 20 : 48;
    const ratio = isMobileChartView() ? 0.1 : 0.14;
    const cap = isMobileChartView() ? 36 : 72;
    return Math.max(12, Math.min(cap, Math.round(minDim * ratio)));
}

function applyChartFullscreenPieStyle(active) {
    const metrics = getPieLayoutMetrics();
    const hoverOffset = isMobileTouchDevice() ? 0 : 7;
    [trafficPieUpChart, trafficPieDlChart].forEach(chart => {
        if (!chart) return;
        const padding = active ? resolveFullscreenPiePadding(chart) : metrics.piePad;
        chart.options.layout.padding = padding;
        chart.options.cutout = active && isMobileChartView() ? '44%' : metrics.cutout;
        if (chart.data?.datasets?.[0]) {
            chart.data.datasets[0].hoverOffset = hoverOffset;
        }
        chart.update('none');
    });
}

function syncChartFullscreenPieLayout() {
    if (!chartFullscreenActive || chartViewType !== 'pie') return;
    applyChartFullscreenPieStyle(true);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            applyChartFullscreenPieStyle(true);
            trafficPieUpChart?.resize();
            trafficPieDlChart?.resize();
        });
    });
    setTimeout(() => {
        applyChartFullscreenPieStyle(true);
        trafficPieUpChart?.resize();
        trafficPieDlChart?.resize();
    }, 120);
}

function applyChartFullscreenChartStyle(active) {
    if (!trafficChart) return;
    const period = lastChartPayload?.period
        || document.getElementById('chartPeriod')?.value
        || 'hourly';
    const hasBracket = BRACKET_PERIODS.has(period);
    const isLine = chartViewType === 'line';
    const isHourly = period === 'hourly';
    const xTicks = trafficChart.options.scales.x.ticks;

    if (active) {
        trafficChart.options.layout.padding.top = CHART_FULLSCREEN_TOP_PAD;
        trafficChart.options.layout.padding.bottom = hasBracket
            ? CHART_FULLSCREEN_BOTTOM_PAD_BRACKET
            : CHART_FULLSCREEN_BOTTOM_PAD;
        xTicks.font.size = CHART_FULLSCREEN_X_TICK_FONT_SIZE;
        xTicks.padding = 2;
        xTicks.maxRotation = isLine ? 0 : (isHourly ? 0 : 35);
    } else {
        trafficChart.options.layout.padding.top = CHART_TOP_PAD;
        trafficChart.options.layout.padding.bottom = hasBracket ? HOURLY_BRACKET_BOTTOM_PAD : 8;
        xTicks.font.size = CHART_AXIS_TICK_FONT_SIZE;
        xTicks.padding = isLine ? 4 : 6;
        xTicks.maxRotation = isLine ? 0 : (isHourly ? 0 : 45);
    }
    trafficChart.update('none');
    renderYAxisLabels();
}

function restoreChartFullscreenDom() {
    const restore = chartFullscreenRestore;
    const legend = document.getElementById('chartLegendPanel');
    const container = document.getElementById('chartContainer');
    if (!restore || !legend || !container) return;

    if (restore.legendNext) {
        restore.legendParent.insertBefore(legend, restore.legendNext);
    } else {
        restore.legendParent.appendChild(legend);
    }
    if (restore.containerNext) {
        restore.containerParent.insertBefore(container, restore.containerNext);
    } else {
        restore.containerParent.appendChild(container);
    }
}

function restorePieChartsAfterFullscreenExit() {
    if (chartViewType !== 'pie') return;
    if (lastChartPayload) {
        renderChart(
            lastChartPayload.uploadData,
            lastChartPayload.downloadData,
            lastChartPayload.period,
            lastChartPayload.instance,
            false,
        );
        syncChartFullscreenEnterVisibility();
        return;
    }
    applyChartFullscreenPieStyle(false);
    scheduleTrafficPieChartResize(trafficPieUpChart, trafficPieDlChart);
}

async function exitChartFullscreen() {
    if (!chartFullscreenActive) return;

    if (chartFullscreenExitTimer) {
        clearTimeout(chartFullscreenExitTimer);
        chartFullscreenExitTimer = null;
    }

    const portal = document.getElementById('chartFullscreenPortal');
    const wasPie = chartViewType === 'pie';
    restoreChartFullscreenDom();

    if (portal) portal.hidden = true;
    document.body.classList.remove('chart-fullscreen-active');
    document.body.classList.remove('chart-fullscreen-active--pie');
    chartFullscreenActive = false;
    chartFullscreenNative = false;
    chartFullscreenRestore = null;

    try {
        if (document.fullscreenElement) await document.exitFullscreen();
    } catch (e) { /* ignore */ }

    try {
        screen.orientation?.unlock?.();
    } catch (e) { /* ignore */ }

    applyChartFullscreenChartStyle(false);
    syncChartFullscreenEnterVisibility();
    if (wasPie) {
        setTimeout(() => restorePieChartsAfterFullscreenExit(), 150);
    } else {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => resizeActiveCharts());
        });
    }
}

async function enterChartFullscreen() {
    if (chartFullscreenActive) return;
    if (!isMobileChartView() && !isMobileTouchDevice()) return;

    const portal = document.getElementById('chartFullscreenPortal');
    const content = document.getElementById('chartFullscreenContent');
    const legend = document.getElementById('chartLegendPanel');
    const container = document.getElementById('chartContainer');
    if (!portal || !content || !container || container.hidden) return;

    chartFullscreenRestore = {
        legendParent: legend.parentElement,
        legendNext: legend.nextElementSibling,
        containerParent: container.parentElement,
        containerNext: container.nextElementSibling,
    };

    content.appendChild(legend);
    content.appendChild(container);
    portal.hidden = false;
    document.body.classList.add('chart-fullscreen-active');
    document.body.classList.toggle('chart-fullscreen-active--pie', chartViewType === 'pie');
    chartFullscreenActive = true;
    chartFullscreenNative = false;
    syncChartFullscreenEnterVisibility();

    try {
        if (portal.requestFullscreen) {
            await portal.requestFullscreen();
            chartFullscreenNative = document.fullscreenElement === portal;
        }
    } catch (e) { /* fixed overlay fallback */ }

    if (chartFullscreenNative) {
        try {
            await screen.orientation?.lock?.('landscape');
        } catch (e) { /* ignore */ }
    }

    applyChartFullscreenChartStyle(true);
    if (chartViewType === 'pie') {
        syncChartFullscreenPieLayout();
    } else {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => resizeActiveCharts());
        });
    }
}

function setupChartFullscreen() {
    const enterBtn = document.getElementById('chartFullscreenEnter');
    const exitBtn = document.getElementById('chartFullscreenExit');

    enterBtn?.addEventListener('click', () => {
        enterChartFullscreen();
    });
    exitBtn?.addEventListener('click', () => {
        exitChartFullscreen();
    });

    document.addEventListener('fullscreenchange', () => {
        const portal = document.getElementById('chartFullscreenPortal');
        if (!chartFullscreenActive || !chartFullscreenNative) return;
        if (document.fullscreenElement === portal) return;

        if (chartFullscreenExitTimer) {
            clearTimeout(chartFullscreenExitTimer);
        }
        chartFullscreenExitTimer = setTimeout(() => {
            chartFullscreenExitTimer = null;
            if (chartFullscreenActive && chartFullscreenNative && !document.fullscreenElement) {
                exitChartFullscreen();
            }
        }, 350);
    });

    window.addEventListener('orientationchange', () => {
        if (chartFullscreenActive) {
            setTimeout(() => resizeActiveCharts(), 120);
        }
    });

    const mobileMq = window.matchMedia('(max-width: 768px)');
    const onMobileChange = () => {
        syncChartFullscreenEnterVisibility();
        if (trafficChart) renderYAxisLabels();
    };
    if (mobileMq.addEventListener) {
        mobileMq.addEventListener('change', onMobileChange);
    } else if (mobileMq.addListener) {
        mobileMq.addListener(onMobileChange);
    }
}

function syncChartLegendPanelLayout(show = true) {
    const legendEl = document.getElementById('chartLegendPanel');
    if (!legendEl) return;
    if (!show) {
        legendEl.hidden = true;
        legendEl.classList.remove('chart-legend-panel--pie');
        return;
    }
    legendEl.hidden = false;
    legendEl.classList.toggle('chart-legend-panel--pie', chartViewType === 'pie');
}

function syncChartInstanceTitle(instanceName, platform = getChartPlatform()) {
    const titleEl = document.getElementById('chartInstanceTitle');
    if (!titleEl) return;
    const playbackLabel = platform === 'emby' ? getChartPlaybackUserTitleSuffix() : null;
    setInnerHtmlIfChanged(titleEl, buildChartInstanceTitleHTML(instanceName, platform, playbackLabel));
}

function showChartArea(show) {
    const emptyEl = document.getElementById('chartEmpty');
    const containerEl = document.getElementById('chartContainer');
    const xTitleEl = document.getElementById('chartXAxisTitle');
    const barlineEl = document.getElementById('chartBarLineLayout');
    const pieEl = document.getElementById('chartPieLayout');
    if (emptyEl) {
        emptyEl.hidden = show;
        if (!show) {
            const textEl = emptyEl.querySelector('.chart-empty-text');
            if (textEl) textEl.textContent = CHART_EMPTY_TEXT_NO_DEVICE;
        }
    }
    if (containerEl) containerEl.hidden = !show;
    syncChartLegendPanelLayout(show);
    if (!show) {
        if (chartFullscreenActive) exitChartFullscreen();
        if (xTitleEl) xTitleEl.textContent = '';
        syncChartInstanceTitle('');
        clearYAxisLabels();
        teardownChartScrollLayout();
    } else {
        const isPie = chartViewType === 'pie';
        if (barlineEl) barlineEl.hidden = isPie;
        if (pieEl) pieEl.hidden = !isPie;
        if (isPie && xTitleEl) xTitleEl.textContent = '';
    }
    syncChartLegendBackfillHint();
    syncChartFullscreenEnterVisibility();
}

function showChartNoDataInRange(instanceName) {
    const emptyEl = document.getElementById('chartEmpty');
    const containerEl = document.getElementById('chartContainer');
    const xTitleEl = document.getElementById('chartXAxisTitle');

    if (chartFullscreenActive) exitChartFullscreen();
    destroyTrafficCharts();

    if (emptyEl) {
        emptyEl.hidden = false;
        const textEl = emptyEl.querySelector('.chart-empty-text');
        if (textEl) textEl.textContent = CHART_EMPTY_TEXT_NO_DATA;
    }
    if (containerEl) containerEl.hidden = true;
    syncChartLegendPanelLayout(true);
    if (xTitleEl) xTitleEl.textContent = '';
    syncChartInstanceTitle(instanceName);
    lastChartLegendTotals = { uploadBytes: 0, downloadBytes: 0 };
    syncChartLegendTotals();
    clearYAxisLabels();
    teardownChartScrollLayout();
    syncChartLegendBackfillHint();
    syncChartFullscreenEnterVisibility();
}

function normalizePlaybackStatsPayload(rows, period, playbackUser) {
    if (!playbackUser || !Array.isArray(rows)) return rows || [];
    return rows;
}

async function updateChart(silent = false) {
    if (chartFullscreenActive) return;
    ensureChartQueryRangeReady();
    const platform = getChartPlatform();
    const instance = document.getElementById('chartInstance')?.value || '';
    const isAllDevices = isChartAllDevicesValue(instance);
    if (platform === 'emby' && instance && !isAllDevices) {
        await ensureChartPlaybackUserReady();
    }
    persistChartControls();
    const storageKey = getChartInstanceStorageKey(platform);
    if (instance) {
        sessionStorage.setItem(storageKey, instance);
    } else {
        sessionStorage.removeItem(storageKey);
    }
    const period = document.getElementById('chartPeriod').value;
    if (!instance) {
        showChartArea(false);
        destroyTrafficCharts();
        lastChartPayload = null;
        return;
    }

    if (shouldUseChartRangeParams()) {
        applyChartRangeConstraints(period);
        if (!isCustomChartRangeReady(period)) {
            return;
        }
    }

    try {
        const params = getChartQueryParams();
        const playbackUser = platform === 'emby' && !isAllDevices
            ? getChartPlaybackUserForQuery()
            : CHART_PLAYBACK_DEVICE_VALUE;
        const targetNames = isAllDevices
            ? getChartInstanceNamesForPlatform(platform)
            : [instance];

        if (!targetNames.length) {
            showChartArea(false);
            destroyTrafficCharts();
            lastChartPayload = null;
            return;
        }

        const results = await Promise.all(
            targetNames.map(name => fetchChartUploadDownload(
                name, platform, period, params, playbackUser,
            )),
        );
        const ok = results.filter(Boolean);
        if (!ok.length) return;

        const uploadData = isAllDevices
            ? aggregateChartStatsRows(ok.map(r => r.uploadData), period)
            : ok[0].uploadData;
        const downloadData = isAllDevices
            ? aggregateChartStatsRows(ok.map(r => r.downloadData), period)
            : ok[0].downloadData;

        lastChartPayload = {
            uploadData,
            downloadData,
            period,
            instance,
            platform,
            playbackUser: playbackUser || null,
        };
        renderChart(uploadData, downloadData, period, instance, !silent);
    } catch (e) {
        if (!silent) {
            showToast('流量图表加载失败', 'error');
        }
    }
}

function buildChartDatasets(uploadValues, downloadValues, chartType = 'bar') {
    const uploadDataset = chartType === 'line'
        ? {
            label: '上行',
            data: uploadValues,
            borderColor: 'rgba(37, 99, 235, 0.92)',
            backgroundColor: 'rgba(37, 99, 235, 0.10)',
            pointBackgroundColor: '#ffffff',
            pointBorderColor: 'rgba(37, 99, 235, 1)',
            pointBorderWidth: 2,
            pointHoverBackgroundColor: '#ffffff',
            pointHoverBorderColor: 'rgba(37, 99, 235, 1)',
            pointHoverBorderWidth: 2,
            ...LINE_CHART_DATASET_STYLE,
        }
        : {
            label: '上行',
            data: uploadValues,
            backgroundColor: 'rgba(37, 99, 235, 0.88)',
            borderColor: 'rgba(37, 99, 235, 1)',
            borderWidth: 0,
            borderRadius: 0,
            borderSkipped: false,
        };
    if (isEmbyChartUploadOnly()) {
        return [uploadDataset];
    }
    const downloadDataset = chartType === 'line'
        ? {
            label: '下行',
            data: downloadValues,
            borderColor: 'rgba(16, 185, 129, 0.92)',
            backgroundColor: 'rgba(16, 185, 129, 0.08)',
            pointBackgroundColor: '#ffffff',
            pointBorderColor: 'rgba(16, 185, 129, 1)',
            pointBorderWidth: 2,
            pointHoverBackgroundColor: '#ffffff',
            pointHoverBorderColor: 'rgba(16, 185, 129, 1)',
            pointHoverBorderWidth: 2,
            ...LINE_CHART_DATASET_STYLE,
        }
        : {
            label: '下行',
            data: downloadValues,
            backgroundColor: 'rgba(16, 185, 129, 0.88)',
            borderColor: 'rgba(16, 185, 129, 1)',
            borderWidth: 0,
            borderRadius: 0,
            borderSkipped: false,
        };
    return [uploadDataset, downloadDataset];
}

function buildChartTooltipCallbacks(backfillMeta, tooltipLabels) {
    return {
        title(items) {
            if (!items?.length) return '';
            const i = items[0].dataIndex;
            return tooltipLabels?.[i] ?? items[0].label ?? '';
        },
        label(ctxTip) {
            const i = ctxTip.dataIndex;
            const isUpload = ctxTip.datasetIndex === 0;
            const name = isUpload ? '上行' : '下行';
            const total = Number(ctxTip.parsed.y) || 0;
            const backfill = isUpload
                ? (backfillMeta.backfillUploadValues[i] || 0)
                : (backfillMeta.backfillDownloadValues[i] || 0);
            if (backfill > 0.00005) {
                return [
                    `总${name}：${total.toFixed(1)} GB`,
                    `补 · ${backfill.toFixed(1)} GB`,
                ];
            }
            return [`${name}：${total.toFixed(1)} GB`];
        },
    };
}

const BRACKET_PERIODS = new Set(['hourly', 'daily', 'weekly', 'monthly']);

function getChartPlugins(period, dateGroups, chartType = 'bar', labelCount = 0) {
    const plugins = [yAxisLabelsPlugin, chartCrosshairPlugin];
    if (chartType === 'bar' && getChartPlatform() !== 'emby') {
        plugins.unshift(backfillBarHatchPlugin);
    }
    if (BRACKET_PERIODS.has(period) && dateGroups?.length) {
        if (chartType === 'line') {
            plugins.push(createLineChartMonthGridPlugin(dateGroups));
        }
        plugins.push(createHourlyDateBracketPlugin(dateGroups));
    }
    return plugins;
}


// ─── Pie Chart ─────────────────────────────────────────────────────────────

function getPieLayoutMetrics() {
    if (chartFullscreenActive) {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (isMobile) {
            return {
                piePad: 24,
                rExtra: 8,
                gap: 3,
                margin: 3,
                lineH: 10,
                vGap: 3,
                fontValue: '700 10px "Noto Sans SC","Microsoft YaHei",sans-serif',
                fontSm: 'normal 8px "Noto Sans SC","Microsoft YaHei",sans-serif',
                cutout: '44%',
            };
        }
        return {
            piePad: 72,
            rExtra: 16,
            gap: 4,
            margin: 5,
            lineH: 13,
            vGap: 4,
            fontValue: '700 11px "Noto Sans SC","Microsoft YaHei",sans-serif',
            fontSm: 'normal 9px "Noto Sans SC","Microsoft YaHei",sans-serif',
            cutout: '50%',
        };
    }
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
        return {
            piePad: 48,
            rExtra: 10,
            gap: 3,
            margin: 3,
            lineH: 11,
            vGap: 3,
            fontValue: '700 10px "Noto Sans SC","Microsoft YaHei",sans-serif',
            fontSm: 'normal 8px "Noto Sans SC","Microsoft YaHei",sans-serif',
            cutout: '50%',
        };
    }
    return {
        piePad: 116,
        rExtra: 22,
        gap: 5,
        margin: 6,
        lineH: 14,
        vGap: 5,
        fontValue: '700 12px "Noto Sans SC","Microsoft YaHei",sans-serif',
        fontSm: 'normal 10px "Noto Sans SC","Microsoft YaHei",sans-serif',
        cutout: '52%',
    };
}

function buildPieSliceColors(values, isUpload) {
    const n = values.length;
    if (n === 0) return { colors: [], hoverColors: [] };
    const indexed = values.map((v, i) => ({ v: v || 0, i })).sort((a, b) => a.v - b.v);
    const colors = new Array(n);
    const hoverColors = new Array(n);
    indexed.forEach(({ i }, rank) => {
        const t = n <= 1 ? 0.7 : rank / (n - 1);
        let h, s, l;
        if (isUpload) {
            h = 210 + t * 14;
            s = 48 + t * 42;
            l = 88 - t * 56;
        } else {
            h = 158 + t * 9;
            s = 44 + t * 38;
            l = 86 - t * 60;
        }
        colors[i] = `hsl(${h.toFixed(0)},${s.toFixed(0)}%,${l.toFixed(0)}%)`;
        hoverColors[i] = `hsl(${h.toFixed(0)},${Math.min(100, s + 7).toFixed(0)}%,${Math.max(12, l - 9).toFixed(0)}%)`;
    });
    return { colors, hoverColors };
}

function createPieAnnotationPlugin(labels, tooltipLabels, isUpload, period, rawLabels, values, metrics, valueUnit = 'GB') {
    const PIE_PAD = metrics.piePad;
    const R_EXTRA = metrics.rExtra;
    const GAP     = metrics.gap;
    const MARGIN  = metrics.margin;
    const AVAIL   = PIE_PAD - R_EXTRA - GAP - MARGIN;
    const LINE_H  = metrics.lineH;
    const VGAP    = metrics.vGap;

    // ── Precompute static data (runs ONCE at chart creation, not every frame) ─
    if (!values || !values.length) return { id: `pieAnnotation_${isUpload ? 'up' : 'dl'}`, afterDatasetsDraw() {} };

    let maxIdx = -1, maxVal = 0;
    for (let i = 0; i < values.length; i++) {
        if ((values[i] || 0) > maxVal) { maxVal = values[i] || 0; maxIdx = i; }
    }
    if (maxIdx < 0 || maxVal <= 0) return { id: `pieAnnotation_${isUpload ? 'up' : 'dl'}`, afterDatasetsDraw() {} };

    const mainColor  = isUpload ? '#1d4ed8' : '#047857';
    const lineColor  = isUpload ? 'rgba(37,99,235,0.75)' : 'rgba(5,150,105,0.75)';
    const FONT_V     = metrics.fontValue;
    const FONT_SM    = metrics.fontSm;
    const valueText  = `${maxVal.toFixed(1)} ${valueUnit}`;

    const textLines = [{ text: valueText, font: FONT_V, color: mainColor }];
    if (period === 'hourly') {
        const raw = rawLabels?.[maxIdx] ?? '';
        const parsed = parseHourlyLabel(raw);
        if (parsed.date) {
            const [y, m, d] = parsed.date.split('-');
            textLines.push({ text: `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`, font: FONT_SM, color: '#64748b' });
        }
        textLines.push({ text: parsed.time || labels[maxIdx] || '', font: FONT_SM, color: '#475569' });
    } else {
        const label = tooltipLabels?.[maxIdx] ?? labels[maxIdx] ?? '';
        textLines.push({ text: label, font: FONT_SM, color: '#64748b' });
    }

    const totalH = textLines.length * LINE_H;

    // maxTextW: measured lazily on first afterDraw call, then cached
    let maxTextW = -1;

    // ── Plugin object ────────────────────────────────────────────────────────
    return {
        id: `pieAnnotation_${isUpload ? 'up' : 'dl'}`,
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            // Declare canvasW HERE so it's always in scope (prevents ReferenceError
            // that would leave ctx.save() calls unmatched → memory/perf degradation)
            const canvasW = ctx.canvas.width;

            // Measure text width once, then cache
            if (maxTextW < 0) {
                ctx.save();
                maxTextW = 0;
                for (const line of textLines) {
                    ctx.font = line.font;
                    maxTextW = Math.max(maxTextW, ctx.measureText(line.text).width);
                }
                ctx.restore();
            }

            // Read per-frame arc geometry (changes on hover / resize)
            const meta = chart.getDatasetMeta(0);
            const arc  = meta.data[maxIdx];
            if (!arc) return;

            const midAngle   = (arc.startAngle + arc.endAngle) / 2;
            const outerRadius = arc.outerRadius;
            const cx = arc.x, cy = arc.y;
            const cosA = Math.cos(midAngle), sinA = Math.sin(midAngle);

            const r0 = outerRadius + 6;
            const r1 = outerRadius + R_EXTRA;
            const x0 = cx + r0 * cosA, y0 = cy + r0 * sinA;
            const x1 = cx + r1 * cosA, y1 = cy + r1 * sinA;

            // Dominant direction
            const horizDom = Math.abs(cosA) > Math.abs(sinA);
            const isRight  = horizDom && cosA > 0;
            const isLeft   = horizDom && cosA < 0;
            const isUp     = !horizDom && sinA <= 0;

            const hLen = (isRight || isLeft)
                ? Math.max(0, Math.min(20, AVAIL - Math.ceil(maxTextW)))
                : 0;

            let hx2, textX, textAlign;
            if (isRight) {
                hx2 = x1 + hLen; textX = hx2 + GAP; textAlign = 'left';
            } else if (isLeft) {
                hx2 = x1 - hLen; textX = hx2 - GAP; textAlign = 'right';
            } else {
                hx2   = x1;
                textX = Math.max(maxTextW / 2 + MARGIN,
                            Math.min(canvasW - maxTextW / 2 - MARGIN, x1));
                textAlign = 'center';
            }

            let startY;
            if (isRight || isLeft) {
                startY = y1 - totalH / 2 + LINE_H / 2;
            } else if (isUp) {
                startY = y1 - VGAP - totalH + LINE_H / 2;
            } else {
                startY = y1 + VGAP + LINE_H / 2;
            }

            // ── Draw ─────────────────────────────────────────────────────────
            ctx.save();
            ctx.strokeStyle = lineColor;
            ctx.lineWidth   = 1.5;
            ctx.lineJoin    = 'round';
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            if (hLen > 0) ctx.lineTo(hx2, y1);
            ctx.stroke();

            ctx.fillStyle = lineColor;
            ctx.beginPath();
            ctx.arc(x0, y0, 2.5, 0, Math.PI * 2);
            ctx.fill();

            ctx.textAlign = textAlign;
            textLines.forEach((line, i) => {
                ctx.font        = line.font;
                ctx.fillStyle   = line.color;
                ctx.textBaseline = 'middle';
                ctx.fillText(line.text, textX, startY + i * LINE_H);
            });
            ctx.restore();
        },
    };
}

function createPieCenterPlugin(isUpload, values, valueUnit = 'GB') {
    // Precompute static text (runs once at chart creation)
    const vals         = values || [];
    const total        = vals.reduce((s, v) => s + (v || 0), 0);
    const nonZeroCount = vals.filter(v => (v || 0) > 0).length;
    const totalText    = `${total.toFixed(1)} ${valueUnit}`;
    const countText    = `${nonZeroCount} 时段`;
    const mainColor    = isUpload ? '#1e3a8a' : '#064e3b';

    return {
        id: `pieCenterText_${isUpload ? 'up' : 'dl'}`,
        afterDatasetsDraw(chart) {
            if (total <= 0) return;
            const { ctx } = chart;
            const meta = chart.getDatasetMeta(0);
            const arc  = meta.data[0];
            if (!arc) return;
            const innerRadius = arc.innerRadius || 0;
            if (innerRadius < 24) return;

            const cx = arc.x, cy = arc.y;
            const fontSize    = Math.min(15, Math.max(10, Math.floor(innerRadius * 0.30)));
            const subFontSize = Math.max(9, fontSize - 3);

            ctx.save();
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.font         = `700 ${fontSize}px "Noto Sans SC","Microsoft YaHei",sans-serif`;
            ctx.fillStyle    = mainColor;
            ctx.fillText(totalText, cx, cy - subFontSize * 0.85);
            ctx.font         = `normal ${subFontSize}px "Noto Sans SC","Microsoft YaHei",sans-serif`;
            ctx.fillStyle    = '#94a3b8';
            ctx.fillText(countText, cx, cy + fontSize * 0.8);
            ctx.restore();
        },
    };
}

function mountTrafficPieCharts({
    labels,
    rawLabels,
    tooltipLabels,
    uploadValues,
    downloadValues,
    backfillUploadValues = [],
    backfillDownloadValues = [],
    period,
    animate = false,
    upCanvasId,
    dlCanvasId,
}) {
    const upCtx = document.getElementById(upCanvasId)?.getContext('2d');
    if (!upCtx) return null;

    const { colors: upColors, hoverColors: upHoverColors } = buildPieSliceColors(uploadValues, true);
    const pieMetrics = getPieLayoutMetrics();
    const pieHoverOffset = isMobileTouchDevice() ? 0 : 7;
    const makePieOptions = (isUpload) => ({
        responsive: true,
        maintainAspectRatio: false,
        animation: animate ? { duration: 650, easing: 'easeInOutQuart' } : false,
        cutout: pieMetrics.cutout,
        layout: { padding: pieMetrics.piePad },
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    title(items) {
                        if (!items?.length) return '';
                        return tooltipLabels?.[items[0].dataIndex] ?? labels[items[0].dataIndex] ?? '';
                    },
                    label(ctx) {
                        const i = ctx.dataIndex;
                        const name = isUpload ? '上行' : '下行';
                        const total = ctx.parsed;
                        const backfill = isUpload
                            ? (backfillUploadValues[i] || 0)
                            : (backfillDownloadValues[i] || 0);
                        if (backfill > 0.00005) {
                            return [
                                ` 总${name}：${total.toFixed(2)} GB`,
                                ` 补 · ${backfill.toFixed(2)} GB`,
                            ];
                        }
                        return ` ${name}：${total.toFixed(2)} GB`;
                    },
                },
            },
        },
    });

    const upChart = new Chart(upCtx, {
        type: 'doughnut',
        plugins: [
            createPieAnnotationPlugin(labels, tooltipLabels, true, period, rawLabels, uploadValues, pieMetrics),
            createPieCenterPlugin(true, uploadValues),
        ],
        data: {
            labels,
            datasets: [{
                data: uploadValues,
                backgroundColor: upColors,
                hoverBackgroundColor: upHoverColors,
                borderColor: '#ffffff',
                borderWidth: 2,
                hoverBorderWidth: 2,
                hoverOffset: pieHoverOffset,
            }],
        },
        options: makePieOptions(true),
    });

    if (isEmbyChartUploadOnly()) {
        return { upChart, dlChart: null };
    }

    const dlCtx = document.getElementById(dlCanvasId)?.getContext('2d');
    if (!dlCtx) {
        return { upChart, dlChart: null };
    }
    const { colors: dlColors, hoverColors: dlHoverColors } = buildPieSliceColors(downloadValues, false);

    const dlChart = new Chart(dlCtx, {
        type: 'doughnut',
        plugins: [
            createPieAnnotationPlugin(labels, tooltipLabels, false, period, rawLabels, downloadValues, pieMetrics),
            createPieCenterPlugin(false, downloadValues),
        ],
        data: {
            labels,
            datasets: [{
                data: downloadValues,
                backgroundColor: dlColors,
                hoverBackgroundColor: dlHoverColors,
                borderColor: '#ffffff',
                borderWidth: 2,
                hoverBorderWidth: 2,
                hoverOffset: pieHoverOffset,
            }],
        },
        options: makePieOptions(false),
    });

    return { upChart, dlChart };
}

function scheduleTrafficPieChartResize(upChart, dlChart) {
    if (!upChart && !dlChart) return;
    const run = () => {
        upChart?.resize();
        dlChart?.resize();
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
    setTimeout(run, 120);
}

function renderPieChart(uploadData, downloadData, period, instanceName, animate = false) {
    const merged = mergeUploadDownloadStats(uploadData, downloadData, period);
    const { labels, rawLabels, tooltipLabels, uploadValues, downloadValues,
            backfillUploadValues, backfillDownloadValues } = merged;

    if (!labels.length) {
        showChartNoDataInRange(instanceName);
        return;
    }

    destroyTrafficCharts();
    showChartArea(true);
    syncChartLegendPlatformUi();
    syncChartInstanceTitle(instanceName);

    lastChartLegendTotals = {
        uploadBytes: sumChartBytesFromRows(uploadData),
        downloadBytes: sumChartBytesFromRows(downloadData),
    };
    syncChartLegendTotals();

    const charts = mountTrafficPieCharts({
        labels,
        rawLabels,
        tooltipLabels,
        uploadValues,
        downloadValues,
        backfillUploadValues,
        backfillDownloadValues,
        period,
        animate,
        upCanvasId: 'trafficPieUpChart',
        dlCanvasId: 'trafficPieDlChart',
    });
    if (!charts) return;
    trafficPieUpChart = charts.upChart;
    trafficPieDlChart = charts.dlChart;
    if (chartFullscreenActive) {
        syncChartFullscreenPieLayout();
    } else {
        scheduleTrafficPieChartResize(trafficPieUpChart, trafficPieDlChart);
    }
}

// ────────────────────────────────────────────────────────────────────────────

function renderChart(uploadData, downloadData, period, instanceName, animate = false) {
    if (chartViewType === 'pie') {
        renderPieChart(uploadData, downloadData, period, instanceName, animate);
        return;
    }
    const ctx = document.getElementById('trafficChart')?.getContext('2d');
    if (!ctx) return;
    const merged = mergeUploadDownloadStats(uploadData, downloadData, period);
    const {
        labels, uploadValues, downloadValues, dateGroups,
        backfillUploadValues, backfillDownloadValues, tooltipLabels,
    } = merged;

    if (!labels.length) {
        showChartNoDataInRange(instanceName);
        return;
    }

    lastChartLegendTotals = {
        uploadBytes: sumChartBytesFromRows(uploadData),
        downloadBytes: sumChartBytesFromRows(downloadData),
    };
    const backfillMeta = { backfillUploadValues, backfillDownloadValues };
    const chartType = chartViewType;
    const datasets = buildChartDatasets(uploadValues, downloadValues, chartType);
    const xTitle = CHART_X_LABELS[period] || '时间';
    const tooltipCallbacks = buildChartTooltipCallbacks(backfillMeta, tooltipLabels);
    const hasBracket = BRACKET_PERIODS.has(period);
    const layoutPadding = {
        top: CHART_TOP_PAD,
        bottom: hasBracket ? HOURLY_BRACKET_BOTTOM_PAD : 8,
        left: 4,
        right: chartType === 'line' ? 8 : 4,
    };

    chartUserCategoryWidth = null;
    destroyTrafficCharts();

    showChartArea(true);
    syncChartLegendBackfillHint();
    syncChartLegendPlatformUi();
    syncChartInstanceTitle(instanceName);

    const xTitleEl = document.getElementById('chartXAxisTitle');
    if (xTitleEl) xTitleEl.textContent = xTitle;

    const { scrollWrap } = getChartScrollElements();
    const viewportWidth = scrollWrap?.clientWidth || 800;
    const estimatedCategoryWidth = resolveChartCategoryWidth(viewportWidth, labels.length);
    const estimatedChartWidth = Math.max(viewportWidth, labels.length * estimatedCategoryWidth);
    refreshChartXTickStep(labels.length, estimatedChartWidth, labels);

    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: animate,
        layout: { padding: layoutPadding },
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: CHART_LEGEND_OPTIONS,
            tooltip: {
                mode: 'index',
                intersect: false,
                callbacks: tooltipCallbacks,
            },
        },
        scales: buildChartScales(period, chartType, labels.length),
    };
    if (chartType === 'bar') {
        chartOptions.datasets = { bar: CHART_BAR_GROUP_OPTIONS };
    }

    trafficChart = new Chart(ctx, {
        type: chartType,
        plugins: getChartPlugins(period, dateGroups, chartType, labels.length),
        data: { labels, datasets },
        options: chartOptions,
    });
    trafficChart.$backfillMeta = backfillMeta;
    syncChartLegendPanel();
    applyChartScrollLayout(labels.length);
    setupChartScrollResize(labels.length);
}

async function loadEvents(silent = false) {
    if (typeof persistChartControls === 'function') persistChartControls();
    const container = document.getElementById('eventsList');
    const instance = document.getElementById('eventInstance')?.value || '';
    if (!instance) {
        if (container) container.innerHTML = '<div class="empty-tip">暂无设备</div>';
        return;
    }
    try {
        const params = new URLSearchParams({ limit: '500', instance });
        const res = await axios.get(`/api/events?${params}`);
        if (res.data.success) renderEvents(res.data.data);
    } catch (e) {
        if (!silent) {
            showToast('事件日志加载失败', 'error');
        }
    }
}

function renderEvents(events) {
    const container = document.getElementById('eventsList');
    if (!events.length) {
        container.innerHTML = '<div class="empty-tip">暂无设备事件</div>';
        return;
    }
    const typeMap = {
        limit_applied: '✅ 自动限速生效',
        limit_restored: '🟢 限速已解除',
        limit_applied_manual: '🟡 手动设置限速',
        speed_mode_switch: '🔀 切换限速模式',
        traffic_reset: '🗑 清空统计',
        limit_removed_manual: '🟢 手动解除限速',
        instance_added: '➕ 添加设备',
        instance_updated: '✏️ 更新配置',
        instance_deleted: '🗑 删除设备',
        device_online: '🟢 设备上线',
        device_offline: '🔴 设备离线',
    };
    container.innerHTML = events.map(e => `
        <div class="event-item ${e.event_type}">
            <div class="event-time">${new Date(e.event_time).toLocaleString('zh-CN')}</div>
            <div class="event-type">
                ${typeMap[e.event_type] || e.event_type}
                &nbsp;·&nbsp; <b>${escapeHtml(e.instance_name)}</b>
                ${e.speed_limit_kbps != null
                    ? `&nbsp;·&nbsp; ${e.speed_limit_kbps > 0 ? e.speed_limit_kbps + ' KB/s' : '不限速'}`
                    : ''}
            </div>
            ${e.reason ? `<div class="event-reason">${escapeHtml(e.reason)}</div>` : ''}
        </div>`).join('');
}

async function loadSystemLogs(silent = false) {
    await fetchServiceSystemLogs('qb', 'syslogInstance', 'syslogsList', silent);
}

async function loadAppSystemLogs(silent = false) {
    await fetchServiceSystemLogs('system', null, 'appSyslogsList', silent);
}

async function loadEmbySystemLogs(silent = false) {
    await fetchServiceSystemLogs('emby', 'embySyslogInstance', 'embySyslogsList', silent);
}

async function fetchServiceSystemLogs(service, instanceSelectId, containerId, silent = false) {
    const instance = instanceSelectId
        ? (document.getElementById(instanceSelectId)?.value || '')
        : '';
    const level = document.getElementById('syslogLevel')?.value || '';
    try {
        const params = new URLSearchParams({ limit: '1000', service });
        if (instance) params.set('instance', instance);
        if (level) params.set('level', level);
        const res = await axios.get(`/api/system-logs?${params}`);
        if (res.data.success) renderSystemLogs(res.data.data, containerId);
    } catch (e) {
        if (!silent) {
            showToast('系统日志加载失败', 'error');
        }
    }
}

async function loadSyslogsForCurrentType(silent = false) {
    if (typeof persistChartControls === 'function') persistChartControls();
    const syslogType = typeof getSyslogTypeFilter === 'function'
        ? getSyslogTypeFilter()
        : (document.getElementById('syslogDeviceType')?.value || 'system');
    if (syslogType === 'emby') {
        return loadEmbySystemLogs(silent);
    }
    if (syslogType === 'qb') {
        return loadSystemLogs(silent);
    }
    return loadAppSystemLogs(silent);
}

function onSyslogTypeChange() {
    const select = document.getElementById('syslogDeviceType');
    const next = typeof setSyslogTypeFilter === 'function'
        ? setSyslogTypeFilter(select?.value || 'system')
        : (select?.value || 'system');
    if (select && select.value !== next) {
        select.value = next;
    }
    if (typeof syncSyslogFilterUi === 'function') {
        syncSyslogFilterUi();
    }
    loadSyslogsForCurrentType();
}

function onSyslogLevelChange() {
    loadSyslogsForCurrentType();
}

function renderSystemLogs(logs, containerId = 'syslogsList') {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!logs.length) {
        container.innerHTML = '<div class="empty-tip">暂无系统日志</div>';
        return;
    }
    const levelClass = {
        DEBUG: 'syslog-debug',
        INFO: 'syslog-info',
        WARNING: 'syslog-warning',
        ERROR: 'syslog-error',
        CRITICAL: 'syslog-error',
    };
    container.innerHTML = logs.map(log => `
        <div class="syslog-item ${levelClass[log.level] || ''}">
            <div class="syslog-meta">
                <span class="syslog-time">${escapeHtml(log.time)}</span>
                <span class="syslog-level">${escapeHtml(log.level)}</span>
                <span class="syslog-logger">${escapeHtml(log.logger)}</span>
            </div>
            <div class="syslog-message">${escapeHtml(log.message)}</div>
        </div>`).join('');
}

function cycleResetAnchor(cycle, fallback = 1) {
    if (!cycle || cycle.reset_anchor === undefined || cycle.reset_anchor === null) {
        return fallback;
    }
    return Number(cycle.reset_anchor);
}

function formatCycleUploadResetLabel(cycle, limitKbps) {
    const limitText = limitKbps > 0 ? `${limitKbps}KB/s` : '无限速';
    const c = cycle || {};
    const type = c.type || 'month';
    const anchor = cycleResetAnchor(c, 1);
    if (type === 'month') {
        const day = Math.max(1, Math.min(28, parseInt(anchor, 10) || 1));
        return `每月 ${day} 日恢复至 ${limitText}`;
    }
    if (type === 'week') {
        const v = parseInt(anchor, 10) || 1;
        const w = WEEKDAY_OPTIONS.find(o => o.v === v) || WEEKDAY_OPTIONS[0];
        return `每 ${w.l} 恢复至 ${limitText}`;
    }
    const h = Math.max(0, Math.min(23, parseInt(anchor, 10) || 0));
    return `每天 ${String(h).padStart(2, '0')}:00 恢复至 ${limitText}`;
}

function getCycleResetHint(type, anchor) {
    if (type === 'month') {
        const day = parseInt(anchor, 10);
        if (!Number.isFinite(day) || day < 1 || day > 28) {
            return '有效值 1-28 日';
        }
        return `有效值 1-28 日，每月 ${day} 日的 00:00 开启新周期`;
    }
    if (type === 'week') {
        const v = parseInt(anchor, 10) || 1;
        const w = WEEKDAY_OPTIONS.find(o => o.v === v) || WEEKDAY_OPTIONS[0];
        return `每周 ${w.l} 的 00:00 开启新周期`;
    }
    const h = Math.max(0, Math.min(23, parseInt(anchor, 10) || 0));
    return `有效值 0-23 时，每天 ${String(h).padStart(2, '0')}:00 开启新周期`;
}

function isValidMonthAnchorInput(value) {
    if (value === '' || value == null) return false;
    const trimmed = String(value).trim();
    if (!/^\d+$/.test(trimmed)) return false;
    const n = parseInt(trimmed, 10);
    return n >= 1 && n <= 28;
}

function readCycleAnchorFromForm(prefix, type) {
    if (type === 'month') {
        return document.getElementById(`${prefix}CycleAnchorMonthVal`)?.value ?? '';
    }
    if (type === 'week') {
        return parseInt(document.getElementById(`${prefix}CycleAnchorWeekVal`)?.value, 10) || 1;
    }
    return parseInt(document.getElementById(`${prefix}CycleAnchorDayVal`)?.value, 10) || 0;
}

function updateCycleResetHint(prefix) {
    const typeEl = document.getElementById(`${prefix}CycleType`);
    const hintEl = document.getElementById(`${prefix}CycleResetHint`);
    if (!typeEl || !hintEl) return;
    const type = typeEl.value;
    if (type === 'month') {
        const raw = readCycleAnchorFromForm(prefix, 'month');
        const valid = isValidMonthAnchorInput(raw);
        hintEl.textContent = valid
            ? getCycleResetHint('month', parseInt(String(raw).trim(), 10))
            : '有效值 1-28 日';
        hintEl.classList.toggle('form-hint-error', !valid);
        return;
    }
    hintEl.classList.remove('form-hint-error');
    const anchor = readCycleAnchorFromForm(prefix, type);
    hintEl.textContent = getCycleResetHint(type, anchor);
}

function clampMonthAnchor(value) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(28, n));
}

function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
}

function getCycleStartFromDate(date, cycle) {
    const ctype = cycle?.type || 'month';
    const anchor = cycleResetAnchor(cycle, ctype === 'day' ? 0 : 1);
    const d = new Date(date.getTime());
    if (ctype === 'month') {
        let y = d.getFullYear();
        let m = d.getMonth();
        if (d.getDate() < anchor) {
            m -= 1;
            if (m < 0) {
                m = 11;
                y -= 1;
            }
        }
        const day = Math.min(anchor, daysInMonth(y, m));
        return new Date(y, m, day, 0, 0, 0, 0);
    }
    if (ctype === 'week') {
        const target = anchor - 1;
        const diff = (d.getDay() + 6) % 7;
        const daysSince = (diff - target + 7) % 7;
        const start = new Date(d);
        start.setDate(d.getDate() - daysSince);
        start.setHours(0, 0, 0, 0);
        return start;
    }
    const candidate = new Date(
        d.getFullYear(), d.getMonth(), d.getDate(), anchor, 0, 0, 0
    );
    if (d >= candidate) {
        return candidate;
    }
    const prev = new Date(candidate);
    prev.setDate(prev.getDate() - 1);
    return prev;
}

function getCycleEndFromStart(start, cycle) {
    const ctype = cycle?.type || 'month';
    const anchor = cycleResetAnchor(cycle, ctype === 'day' ? 0 : 1);
    if (ctype === 'month') {
        let y = start.getFullYear();
        let m = start.getMonth() + 1;
        if (m > 11) {
            m = 0;
            y += 1;
        }
        const day = Math.min(anchor, daysInMonth(y, m));
        return new Date(y, m, day, 0, 0, 0, 0);
    }
    if (ctype === 'week') {
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        return end;
    }
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return end;
}

function formatNextCycleSwitchLabel(cycle) {
    const start = getCycleStartFromDate(new Date(), cycle);
    const end = getCycleEndFromStart(start, cycle);
    return end.toLocaleString('zh-CN');
}

function bindCycleFormEvents(prefix) {
    const typeEl = document.getElementById(`${prefix}CycleType`);
    if (typeEl) {
        typeEl.addEventListener('change', () => syncCycleAnchorFields(prefix));
    }
    const monthVal = document.getElementById(`${prefix}CycleAnchorMonthVal`);
    if (monthVal) {
        const syncMonth = () => {
            monthVal.value = clampMonthAnchor(monthVal.value);
            updateCycleResetHint(prefix);
        };
        monthVal.addEventListener('input', updateCycleResetHint.bind(null, prefix));
        monthVal.addEventListener('change', syncMonth);
        monthVal.addEventListener('blur', syncMonth);
    }
    ['Week', 'Day'].forEach(suffix => {
        const el = document.getElementById(`${prefix}CycleAnchor${suffix}Val`);
        if (el) {
            el.addEventListener('input', () => updateCycleResetHint(prefix));
            el.addEventListener('change', () => updateCycleResetHint(prefix));
        }
    });
    updateCycleResetHint(prefix);
    const resetLimitEl = document.getElementById(`${prefix}ResetLimit`);
    if (resetLimitEl) {
        bindUploadLimitKbpsInput(resetLimitEl, '恢复限速');
    }
    bindSpeedRulesLimitInputs(document.getElementById(`${prefix}RulesContainer`));
    if (prefix === 'cur') {
        const mode = document.getElementById('modalTitle')?.dataset?.formMode;
        if (mode) {
            updateNextPlanSwitchHint(mode);
        }
    }
}

function validateSpeedRules(rules) {
    if (!rules || !rules.length) return true;
    for (let i = 0; i < rules.length; i++) {
        const t = parseFloat(rules[i].cycle_upload_limit_gb);
        if (!t || t <= 0) {
            showToast(`规则 ${i + 1} 的上行阈值须大于 0 GB`, 'error');
            return false;
        }
        const limitRaw = rules[i].speed_limit_kbps;
        if (!isUploadLimitKbpsValueValid(limitRaw)) {
            notifyUploadLimitKbpsInvalid(`规则 ${i + 1}`);
            return false;
        }
    }
    for (let i = 1; i < rules.length; i++) {
        const prev = rules[i - 1].cycle_upload_limit_gb;
        const curr = rules[i].cycle_upload_limit_gb;
        if (curr <= prev) {
            showToast(`规则 ${i + 1} 的上行阈值须大于规则 ${i}`, 'error');
            return false;
        }
    }
    return true;
}

/* ---- 实例设置表单 ---- */
const RULE_THRESHOLD_SECTION_HINT =
    '周期内上行达阈值后自动限速，阈值后一条须大于前一条';
const RULE_THRESHOLD_PLACEHOLDER_AFTER_FIRST = '须大于前一条的阈值';

function getSpeedRuleThresholdPlaceholder(idx, blank = false) {
    if (idx > 0) {
        return RULE_THRESHOLD_PLACEHOLDER_AFTER_FIRST;
    }
    return blank ? '请填写' : '例如 500';
}

function buildSpeedRulesHTML(rules, prefix = 'rule', options = {}) {
    const blank = !!options.blank;
    const items = (rules && rules.length) ? rules : [{}];
    return items.map((rule, idx) => {
        const thresholdRaw = rule?.cycle_upload_limit_gb
            ?? rule?.monthly_upload_limit_gb
            ?? rule?.threshold_gb;
        const limitRaw = rule?.speed_limit_kbps ?? rule?.limit_kbps;
        const thresholdVal = blank
            ? ''
            : (thresholdRaw != null && thresholdRaw !== '' ? thresholdRaw : '');
        const limitVal = (limitRaw != null && limitRaw !== '') ? limitRaw : '';
        const thresholdPlaceholder = getSpeedRuleThresholdPlaceholder(idx, blank);
        return `
        <div class="rule-edit-item" data-idx="${idx}">
            <div class="rule-edit-header">
                <span class="rule-edit-badge">规则 ${idx + 1}</span>
                <button type="button" class="btn-link-danger" onclick="removeSpeedRule('${prefix}', this)">删除</button>
            </div>
            <div class="form-row">
                <div class="form-field">
                    <label>上行阈值（GB）
                        <input type="number" name="${prefix}_threshold_${idx}" min="0" step="1"
                               value="${thresholdVal}" placeholder="${thresholdPlaceholder}" />
                    </label>
                </div>
                <div class="form-field">
                    <label>限速至（KB/s）
                        <input type="number" name="${prefix}_limit_${idx}" min="0"
                               max="${QB_MAX_UPLOAD_LIMIT_KBPS}" step="1"
                               value="${limitVal}" placeholder="0表示不限速" />
                    </label>
                </div>
            </div>
        </div>`;
    }).join('');
}

function collectSpeedRules(prefix) {
    const container = document.getElementById(`${prefix}RulesContainer`);
    const items = container.querySelectorAll('.rule-edit-item');
    const rules = [];
    items.forEach(item => {
        const inputs = item.querySelectorAll('input[type="number"]');
        const threshold = parseFloat(inputs[0].value);
        const limit = parseInt(inputs[1].value);
        rules.push({
            cycle_upload_limit_gb: isNaN(threshold) ? 0 : threshold,
            speed_limit_kbps: isNaN(limit) ? 0 : limit
        });
    });
    return rules;
}

function addSpeedRule(prefix) {
    const container = document.getElementById(`${prefix}RulesContainer`);
    const items = container.querySelectorAll('.rule-edit-item');
    const idx = items.length;
    const thresholdPlaceholder = getSpeedRuleThresholdPlaceholder(idx);
    const div = document.createElement('div');
    div.className = 'rule-edit-item';
    div.dataset.idx = idx;
    div.innerHTML = `
        <div class="rule-edit-header">
            <span class="rule-edit-badge">规则 ${idx + 1}</span>
            <button type="button" class="btn-link-danger" onclick="removeSpeedRule('${prefix}', this)">删除</button>
        </div>
        <div class="form-row">
            <div class="form-field">
                <label>上行阈值（GB）
                    <input type="number" name="${prefix}_threshold_${idx}" min="0" step="1"
                           value="" placeholder="${thresholdPlaceholder}" />
                </label>
            </div>
            <div class="form-field">
                <label>限速至（KB/s）
                    <input type="number" name="${prefix}_limit_${idx}" min="0"
                           max="${QB_MAX_UPLOAD_LIMIT_KBPS}" step="1"
                           value="" placeholder="0表示不限速" />
                </label>
            </div>
        </div>`;
    container.appendChild(div);
    bindUploadLimitKbpsInput(
        div.querySelector(UPLOAD_LIMIT_KBPS_INPUT_SELECTOR),
        `规则 ${idx + 1}`,
    );
}

function removeSpeedRule(prefix, btn) {
    const container = document.getElementById(`${prefix}RulesContainer`);
    if (container.querySelectorAll('.rule-edit-item').length <= 1) {
        showToast('至少保留一条规则', 'error');
        return;
    }
    btn.closest('.rule-edit-item').remove();
    container.querySelectorAll('.rule-edit-item').forEach((item, i) => {
        const badge = item.querySelector('.rule-edit-badge');
        if (badge) badge.textContent = `规则 ${i + 1}`;
    });
}

function buildCycleAnchorHTML(cycle, prefix) {
    const c = cycle || { type: 'month', reset_anchor: 1, reset_limit_kbps: 0 };
    const ctype = c.type || 'month';
    const anchor = cycleResetAnchor(c, 1);
    const hintText = getCycleResetHint(ctype, anchor);
    const weekOpts = WEEKDAY_OPTIONS.map(
        o => `<option value="${o.v}" ${anchor === o.v && ctype === 'week' ? 'selected' : ''}>${o.l}</option>`
    ).join('');
    const hourOpts = Array.from({ length: 24 }, (_, h) =>
        `<option value="${h}" ${anchor === h && ctype === 'day' ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`
    ).join('');
    return `
            <div class="form-field">
                <label>周期类型
                    <select id="${prefix}CycleType">
                        <option value="month" ${ctype === 'month' ? 'selected' : ''}>按月</option>
                        <option value="week" ${ctype === 'week' ? 'selected' : ''}>按周</option>
                        <option value="day" ${ctype === 'day' ? 'selected' : ''}>按天</option>
                    </select>
                </label>
            </div>
            <div class="cycle-anchor-group">
                <div class="cycle-anchor-active">
                <div id="${prefix}CycleAnchorMonth" class="cycle-anchor-field form-field" style="display:${ctype === 'month' ? 'block' : 'none'}">
                    <label>周期恢复时间
                        <input type="number" id="${prefix}CycleAnchorMonthVal" min="1" max="28" step="1"
                               data-number-stepper value="${ctype === 'month' ? clampMonthAnchor(anchor) : 1}" />
                    </label>
                </div>
                <div id="${prefix}CycleAnchorWeek" class="cycle-anchor-field form-field" style="display:${ctype === 'week' ? 'block' : 'none'}">
                    <label>周期恢复时间
                        <select id="${prefix}CycleAnchorWeekVal">${weekOpts}</select>
                    </label>
                </div>
                <div id="${prefix}CycleAnchorDay" class="cycle-anchor-field form-field" style="display:${ctype === 'day' ? 'block' : 'none'}">
                    <label>周期恢复时间
                        <select id="${prefix}CycleAnchorDayVal">${hourOpts}</select>
                    </label>
                </div>
                </div>
                <p id="${prefix}CycleResetHint" class="form-hint form-hint--field form-hint--after-input">${hintText}</p>
            </div>
            <div class="form-field form-field--reset-limit">
                <label>恢复限速至（KB/s）
                    <input type="number" id="${prefix}ResetLimit" min="0"
                           max="${QB_MAX_UPLOAD_LIMIT_KBPS}" step="1"
                           value="${c.reset_limit_kbps ?? 0}" placeholder="0 表示无限速" />
                </label>
                <p class="form-hint form-hint--field form-hint--after-input">0 表示无限速，周期开始时恢复的上传限速。</p>
            </div>`;
}

function buildCycleQuotaPlanBlock(cycle, rules, prefix, options = {}) {
    const title = options.title || '周期与达量规则';
    const hint = options.hint || '';
    const removeBtn = options.showRemove
        ? `<button type="button" class="btn-link-danger next-plan-remove" onclick="removeNextCyclePlan('${options.mode}')">移除下周期计划</button>`
        : '';
    const rulesHtml = buildSpeedRulesHTML(
        rules,
        prefix,
        options.blankRules ? { blank: true } : {},
    );
    const hintClass = options.hintClass || '';
    return `
        <div class="cycle-quota-plan-block" data-prefix="${prefix}">
            <div class="cycle-quota-plan-header">
                <h4 class="cycle-quota-plan-title">${title}</h4>
                ${hint ? `<p class="form-hint form-hint--field form-hint--plan ${hintClass}">${hint}</p>` : ''}
                ${removeBtn}
            </div>
            ${buildCycleAnchorHTML(cycle, prefix)}
            <div class="cycle-quota-rules-heading">
                <h5 class="cycle-quota-rules-title">达量限速规则</h5>
                <p class="form-hint form-hint--field form-hint--rules-desc">${RULE_THRESHOLD_SECTION_HINT}</p>
            </div>
            <div id="${prefix}RulesContainer">${rulesHtml}</div>
            <button type="button" class="btn-secondary btn-sm" onclick="addSpeedRule('${prefix}')">+ 添加规则</button>
        </div>`;
}

function buildCycleSettingsSectionHTML(inst, mode) {
    const cycle = inst ? (inst.cycle || {
        type: 'month',
        reset_anchor: inst.reset_day ?? 1,
        reset_limit_kbps: inst.reset_day_limit_kbps ?? 0,
    }) : { type: 'month', reset_anchor: 1, reset_limit_kbps: 0 };
    const rules = inst ? inst.speed_rules : null;
    const nextPlan = inst?.next_cycle_plan;
    const hasNext = !!nextPlan;
    const nextCycle = hasNext ? nextPlan.cycle : cycle;
    const nextRules = hasNext ? nextPlan.speed_rules : null;
    const switchHint = `将于 ${formatNextCycleSwitchLabel(cycle)} 切换为下方的周期与规则`;
    const showNextActions = mode === 'edit';

    return `
            <div class="form-section form-section-last form-section--cycle">
                <h3>周期与达量规则</h3>
                <div class="cycle-section-body">
                ${buildCycleQuotaPlanBlock(cycle, rules, 'cur', {
                    title: '当前周期计划',
                    hint: mode === 'edit' ? '修改并保存后立即同步限速' : '保存后立即同步限速',
                    hintClass: 'cycle-plan-subtitle-hint',
                })}
                ${showNextActions ? `
                <div class="next-plan-actions">
                    <button type="button" class="btn-secondary btn-sm" id="${mode}AddNextPlanBtn"
                            onclick="showNextCyclePlan('${mode}')"
                            ${hasNext ? 'style="display:none"' : ''}>+ 添加下个周期计划</button>
                </div>
                <div id="${mode}NextPlanSection" class="next-cycle-plan-section" ${hasNext ? '' : 'hidden'}>
                    ${buildCycleQuotaPlanBlock(nextCycle, nextRules, 'next', {
                        title: '下个周期计划',
                        hint: `<span id="${mode}NextPlanSwitchHint">${switchHint}</span>`,
                        hintClass: 'cycle-plan-subtitle-hint',
                        showRemove: true,
                        mode,
                        blankRules: !hasNext,
                    })}
                </div>` : ''}
                </div>
            </div>`;
}

function cyclePlansEqual(planA, planB) {
    if (!planA || !planB) {
        return false;
    }
    const cycleA = planA.cycle || planA;
    const cycleB = planB.cycle || planB;
    const rulesA = planA.speed_rules || [];
    const rulesB = planB.speed_rules || [];
    if (!cyclesConfigEqual(cycleA, cycleB)) {
        return false;
    }
    if (rulesA.length !== rulesB.length) {
        return false;
    }
    for (let i = 0; i < rulesA.length; i += 1) {
        const left = rulesA[i];
        const right = rulesB[i];
        if (parseFloat(left.cycle_upload_limit_gb) !== parseFloat(right.cycle_upload_limit_gb)) {
            return false;
        }
        if (parseInt(left.speed_limit_kbps, 10) !== parseInt(right.speed_limit_kbps, 10)) {
            return false;
        }
    }
    return true;
}

function collectCycleConfigFromObject(cycle) {
    const ctype = cycle?.type || 'month';
    const anchor = cycleResetAnchor(cycle, ctype === 'day' ? 0 : 1);
    return {
        type: ctype,
        reset_anchor: anchor,
        reset_limit_kbps: parseInt(cycle?.reset_limit_kbps, 10) || 0,
    };
}

function cyclesConfigEqual(cycleA, cycleB) {
    const left = collectCycleConfigFromObject(cycleA);
    const right = collectCycleConfigFromObject(cycleB);
    return left.type === right.type
        && left.reset_anchor === right.reset_anchor
        && left.reset_limit_kbps === right.reset_limit_kbps;
}

function populateCycleFormFromConfig(prefix, cycle) {
    const typeEl = document.getElementById(`${prefix}CycleType`);
    if (!typeEl) {
        return;
    }
    typeEl.value = cycle.type || 'month';
    syncCycleAnchorFields(prefix);
    const ctype = cycle.type || 'month';
    const anchor = cycle.reset_anchor ?? (ctype === 'day' ? 0 : 1);
    if (ctype === 'month') {
        const el = document.getElementById(`${prefix}CycleAnchorMonthVal`);
        if (el) el.value = clampMonthAnchor(anchor);
    } else if (ctype === 'week') {
        const el = document.getElementById(`${prefix}CycleAnchorWeekVal`);
        if (el) el.value = anchor;
    } else {
        const el = document.getElementById(`${prefix}CycleAnchorDayVal`);
        if (el) el.value = anchor;
    }
    const limitEl = document.getElementById(`${prefix}ResetLimit`);
    if (limitEl) {
        limitEl.value = cycle.reset_limit_kbps ?? 0;
    }
    updateCycleResetHint(prefix);
}

function updateNextPlanSwitchHint(mode) {
    const hintEl = document.getElementById(`${mode}NextPlanSwitchHint`);
    const section = document.getElementById(`${mode}NextPlanSection`);
    if (!hintEl || !section || section.hidden) {
        return;
    }
    try {
        const curCycle = collectCycleConfig('cur');
        const label = formatNextCycleSwitchLabel(curCycle);
        hintEl.textContent = `将于 ${label} 切换为下方的周期与规则`;
    } catch (e) {
        hintEl.textContent = '将于下一周期起点切换为下方的周期与规则';
    }
}

function showNextCyclePlan(mode) {
    const section = document.getElementById(`${mode}NextPlanSection`);
    const addBtn = document.getElementById(`${mode}AddNextPlanBtn`);
    if (!section) {
        return;
    }
    const curCycle = collectCycleConfig('cur');
    populateCycleFormFromConfig('next', curCycle);
    const rulesContainer = document.getElementById('nextRulesContainer');
    if (rulesContainer) {
        rulesContainer.innerHTML = buildSpeedRulesHTML([{}], 'next', { blank: true });
        bindSpeedRulesLimitInputs(rulesContainer);
    }
    section.hidden = false;
    if (addBtn) {
        addBtn.style.display = 'none';
    }
    updateNextPlanSwitchHint(mode);
}

function removeNextCyclePlan(mode) {
    const section = document.getElementById(`${mode}NextPlanSection`);
    const addBtn = document.getElementById(`${mode}AddNextPlanBtn`);
    if (section) {
        section.hidden = true;
    }
    if (addBtn) {
        addBtn.style.display = '';
    }
}

function syncCycleAnchorFields(prefix) {
    const type = document.getElementById(`${prefix}CycleType`).value;
    ['Month', 'Week', 'Day'].forEach(suffix => {
        const el = document.getElementById(`${prefix}CycleAnchor${suffix}`);
        if (el) el.style.display = 'none';
    });
    const map = { month: 'Month', week: 'Week', day: 'Day' };
    const target = document.getElementById(`${prefix}CycleAnchor${map[type]}`);
    if (target) target.style.display = 'block';
    updateCycleResetHint(prefix);
    if (prefix === 'cur') {
        const mode = document.getElementById('modalTitle')?.dataset?.formMode;
        if (mode) {
            updateNextPlanSwitchHint(mode);
        }
    }
}

function collectCycleConfig(prefix) {
    const type = document.getElementById(`${prefix}CycleType`).value;
    let anchor = 1;
    if (type === 'month') {
        anchor = clampMonthAnchor(document.getElementById(`${prefix}CycleAnchorMonthVal`).value);
    } else if (type === 'week') {
        anchor = parseInt(document.getElementById(`${prefix}CycleAnchorWeekVal`).value) || 1;
    } else {
        const v = parseInt(document.getElementById(`${prefix}CycleAnchorDayVal`).value, 10);
        anchor = Number.isFinite(v) ? v : 0;
    }
    return {
        type,
        reset_anchor: anchor,
        reset_limit_kbps: parseInt(document.getElementById(`${prefix}ResetLimit`).value) || 0,
    };
}

function validateCycleConfig(cycle) {
    if (!cycle || !['month', 'week', 'day'].includes(cycle.type)) {
        showToast('请选择有效的周期类型', 'error');
        return false;
    }
    if (cycle.type === 'month' && (cycle.reset_anchor < 1 || cycle.reset_anchor > 28)) {
        showToast('周期恢复时间须为 1-28 日', 'error');
        return false;
    }
    if (cycle.type === 'week' && (cycle.reset_anchor < 1 || cycle.reset_anchor > 7)) {
        showToast('按周周期恢复时间须为周一至周日', 'error');
        return false;
    }
    if (cycle.type === 'day' && (cycle.reset_anchor < 0 || cycle.reset_anchor > 23)) {
        showToast('按天周期恢复时间须为 0-23 时', 'error');
        return false;
    }
    if (!isUploadLimitKbpsValueValid(cycle.reset_limit_kbps)) {
        notifyUploadLimitKbpsInvalid('恢复限速');
        return false;
    }
    return true;
}

function buildInstanceForm(inst, mode) {
    const prefix = mode;
    const name = inst ? inst.name : '';
    const hostPort = formatInstanceHostPort(inst);
    const useHttps = inst ? inst.use_https : false;
    const username = inst ? (inst.username || '') : '';
    const passwordPlaceholder = mode === 'edit' ? '留空表示不修改已保存密码' : '留空表示无需登录';
    const verifySsl = inst ? inst.verify_ssl : false;
    const displayPriority = inst?.display_priority ?? (mode === 'add' ? cachedInstances.length + 1 : 1);

    return `
        <div class="modal-form modal-form--instance">
            <div class="form-section form-section--notice">
                <h3>使用须知</h3>
                <p class="form-hint form-hint--field form-hint--notice">通过 qB 接口采集上下行流量用于统计；根据周期规则触发「达量限速」，只接管 qB 全局上传限速，不影响全局下载限速，也不影响「备用限速」的执行。</p>
            </div>
            <div class="form-section form-section--basic">
                <h3>基础设置</h3>
                <div class="form-row form-row--name-priority">
                    <div class="form-field form-field--grow">
                        <label>显示名称 *
                            <input type="text" id="${prefix}Name" value="${escapeHtml(name)}"
                                   maxlength="${INSTANCE_NAME_MAX_LENGTH}" />
                        </label>
                        <p class="form-hint form-hint--field">名称将绑定保存的数据，最多 ${INSTANCE_NAME_MAX_LENGTH} 个字符</p>
                    </div>
                    <div class="form-field form-field--hint-width">
                        <label>设备序号
                            <input type="number" id="${prefix}DisplayPriority" min="1" max="${DISPLAY_PRIORITY_MAX}" step="1"
                                   data-number-stepper value="${displayPriority}" />
                        </label>
                        <p class="form-hint form-hint--field">默认自动填写，有效值 1-${DISPLAY_PRIORITY_MAX}，数值越小卡越靠前</p>
                    </div>
                </div>
            </div>
            <div class="form-section form-section--connect">
                <h3>连接设置</h3>
                <div class="form-field">
                    <label>地址与端口 *
                        <input type="text" id="${prefix}HostPort" value="${escapeHtml(hostPort)}"
                               placeholder="example.com:8080" />
                    </label>
                    <p class="form-hint form-hint--field">如 192.168.1.1:8080，不要写协议；HTTPS 由下方勾选控制，qB-API与浏览器访问方式无关</p>
                </div>
                <div class="form-row">
                    <div class="form-field">
                        <label>用户名
                            <input type="text" id="${prefix}Username" value="${escapeHtml(username)}" placeholder="留空表示无需登录" />
                        </label>
                        <p class="form-hint form-hint--field form-hint--oneline">优先使用免密模式：若 qB WebUI 开启本地白名单免密，用户名和密码留空即可</p>
                    </div>
                    <div class="form-field">
                        <label>密码
                            <input type="password" id="${prefix}Password" value=""
                                placeholder="${passwordPlaceholder}" />
                        </label>
                    </div>
                </div>
                <div class="form-field">
                    <div class="form-row form-row--checkboxes">
                        <label class="checkbox-label">
                            <input type="checkbox" id="${prefix}Https" ${useHttps ? 'checked' : ''} /> 使用 HTTPS
                        </label>
                        <label class="checkbox-label" id="${prefix}VerifySslWrap">
                            <input type="checkbox" id="${prefix}VerifySsl" ${verifySsl ? 'checked' : ''} /> 验证 SSL 证书
                        </label>
                    </div>
                    <p class="form-hint form-hint--field">通过 HTTPS 连接qB-API 或 打开qB-Web；自签证书可取消勾选验证</p>
                </div>
                <div class="connection-test-panel">
                    <div class="test-actions">
                        <button type="button" class="btn-secondary btn-sm" id="${prefix}ConnectTestBtn">🔍 连通性测试</button>
                        <button type="button" class="btn-secondary btn-sm" id="${prefix}LimitTestBtn">⚡ 限速测试</button>
                    </div>
                    <div id="${prefix}TestResult" class="test-result"></div>
                </div>
            </div>

            ${buildCycleSettingsSectionHTML(inst, mode)}

            <div class="modal-actions">
                <button class="btn-primary" id="saveInstanceBtn">✔ 保存</button>
                <button class="btn-secondary" onclick="closeModal()">✖ 取消</button>
            </div>
        </div>`;
}

function bindSaveInstanceBtn(mode, originalName) {
    const btn = document.getElementById('saveInstanceBtn');
    if (btn) {
        btn.onclick = () => {
            const name = document.getElementById('modalTitle').dataset.instanceName
                || originalName || '';
            saveInstanceSettings(mode, name);
        };
    }
}

function bindAuthFieldSync(prefix) {
    const userEl = document.getElementById(`${prefix}Username`);
    const pwdEl = document.getElementById(`${prefix}Password`);
    if (userEl && pwdEl) {
        userEl.addEventListener('input', () => {
            if (!userEl.value.trim()) {
                pwdEl.value = '';
            }
        });
    }
}

function bindHttpsSslToggle(prefix) {
    const httpsEl = document.getElementById(`${prefix}Https`);
    const sslEl = document.getElementById(`${prefix}VerifySsl`);
    const sslWrap = document.getElementById(`${prefix}VerifySslWrap`);
    if (!httpsEl || !sslEl) return;

    const sync = () => {
        const on = httpsEl.checked;
        sslEl.disabled = !on;
        if (sslWrap) sslWrap.classList.toggle('disabled', !on);
    };

    httpsEl.addEventListener('change', sync);
    sync();
}

function bindTestBtn(mode, originalName) {
    const connectBtn = document.getElementById(`${mode}ConnectTestBtn`);
    const limitBtn = document.getElementById(`${mode}LimitTestBtn`);
    if (connectBtn) {
        connectBtn.onclick = () => runInstanceTest(mode, originalName, 'connect');
    }
    if (limitBtn) {
        limitBtn.onclick = () => runInstanceTest(mode, originalName, 'limit');
    }
    bindAuthFieldSync(mode);
    bindHttpsSslToggle(mode);
}

function estimateClientTestTimeout(testType) {
    const backendSec = testType === 'limit'
        ? INSTANCE_HTTP_TIMEOUT * 5 + 1
        : INSTANCE_HTTP_TIMEOUT + 1;
    return (backendSec + 1) * 1000;
}

function setTestButtonsState(prefix, activeType, running) {
    ['connect', 'limit'].forEach(type => {
        const meta = TEST_BTN_META[type];
        const btn = document.getElementById(`${prefix}${meta.id}`);
        if (!btn) return;
        btn.disabled = running;
        if (running && type === activeType) {
            btn.textContent = meta.running;
        } else {
            btn.textContent = meta.label;
        }
    });
}

function validateSaveAuthForm(data, mode) {
    const user = (data.username || '').trim();
    const pwd = data.password || '';
    if (!user && !pwd) {
        return true;
    }
    if (!user) {
        showToast('请填写用户名', 'error');
        return false;
    }
    if (mode === 'add' && !pwd) {
        showToast('请填写密码', 'error');
        return false;
    }
    return true;
}

function validateTestAuthForm(data) {
    const user = (data.username || '').trim();
    const pwd = data.password || '';
    if (!user && !pwd) {
        return true;
    }
    if (!user) {
        showToast('请填写用户名', 'error');
        return false;
    }
    if (!pwd) {
        showToast('请填写密码', 'error');
        return false;
    }
    return true;
}

function validateTestForm(data) {
    if (!data.host) {
        showToast('请填写地址', 'error');
        return false;
    }
    if (isNaN(data.port) || data.port < 1 || data.port > 65535) {
        showToast('请填写有效的地址与端口，格式如 example.com:8080', 'error');
        return false;
    }
    return validateTestAuthForm(data);
}

async function runInstanceTest(mode, originalName, testType) {
    const prefix = mode;
    if (runningInstanceTests.has(prefix)) {
        return;
    }

    const data = collectInstanceForm(prefix);
    if (!validateTestForm(data)) {
        return;
    }

    runningInstanceTests.add(prefix);
    const resultDiv = document.getElementById(`${prefix}TestResult`);
    const runningHint = testType === 'connect'
        ? '正在测试连通性，请稍候...'
        : '正在测试限速，请稍候...';
    setTestButtonsState(prefix, testType, true);
    if (resultDiv) resultDiv.innerHTML = `<div class="test-running">${runningHint}</div>`;

    try {
        const payload = { ...data, _original_name: originalName || '', test_type: testType };
        const res = await axios.post('/api/config/instances/test', payload, {
            timeout: estimateClientTestTimeout(testType)
        });
        showTestResult(res.data, prefix, testType);
    } catch (e) {
        let err = '测试失败';
        if (e.code === 'ECONNABORTED') {
            err = testType === 'limit'
                ? '限速测试超时，请检查网络或稍后重试'
                : '连通性测试超时，请检查地址、端口与登录凭据';
        } else if (e.response?.data?.error) {
            err = e.response.data.error;
        }
        showTestResult({ success: false, error: err, steps: e.response?.data?.steps }, prefix, testType);
    } finally {
        runningInstanceTests.delete(prefix);
        setTestButtonsState(prefix, testType, false);
    }
}

function showTestResult(data, prefix, testType) {
    const resultDiv = document.getElementById(`${prefix}TestResult`);
    const stepHtml = (data.steps || []).map(s => `
        <div class="test-step ${s.ok ? 'ok' : 'fail'}">
            <span class="test-step-icon">${s.ok ? '✔' : '✗'}</span>
            <span class="test-step-label">${STEP_LABELS[s.step] || s.step}</span>
            <span class="test-step-msg">${escapeHtml(s.message)}</span>
        </div>`).join('');

    const passText = '测试通过';
    const failText = '测试失败';

    if (resultDiv) {
        const summary = data.success
            ? `<div class="test-summary ok">${passText}</div>`
            : `<div class="test-summary fail">${failText}</div>`;
        resultDiv.innerHTML = summary + (stepHtml || `<div class="test-step fail">${escapeHtml(data.error || '测试失败')}</div>`);
    }

    const toastMsg = data.success ? passText : failText;
    showToast(toastMsg, data.success ? 'success' : 'error', data.success ? 4000 : 6000);
}

function collectInstanceForm(mode) {
    const { host, port } = parseHostPortInput(
        document.getElementById(`${mode}HostPort`).value
    );
    const priorityVal = parseInt(document.getElementById(`${mode}DisplayPriority`).value, 10);
    const data = {
        name: document.getElementById(`${mode}Name`).value.trim(),
        display_priority: Number.isFinite(priorityVal) ? priorityVal : 1,
        host,
        port,
        use_https: document.getElementById(`${mode}Https`).checked,
        username: document.getElementById(`${mode}Username`).value.trim(),
        password: document.getElementById(`${mode}Password`).value,
        verify_ssl: document.getElementById(`${mode}VerifySsl`).checked,
        cycle: collectCycleConfig('cur'),
        connection_timeout: INSTANCE_HTTP_TIMEOUT,
        read_timeout: INSTANCE_HTTP_TIMEOUT,
        speed_rules: collectSpeedRules('cur'),
    };
    const nextSection = document.getElementById(`${mode}NextPlanSection`);
    if (nextSection && !nextSection.hidden) {
        data.next_cycle_plan = {
            cycle: collectCycleConfig('next'),
            speed_rules: collectSpeedRules('next'),
        };
    } else {
        data.next_cycle_plan = null;
    }
    return data;
}

function engageModalShellRail(shell) {
    const panel = shell?.closest('.modal-shell-panel');
    if (!panel) return;
    panel.classList.add('modal-shell-panel--engaged');
    if (panel._modalRailHideTimer) {
        clearTimeout(panel._modalRailHideTimer);
    }
    panel._modalRailHideTimer = setTimeout(() => {
        panel.classList.remove('modal-shell-panel--engaged');
        panel._modalRailHideTimer = null;
    }, 900);
}

function syncModalShellRail(shell) {
    const panel = shell?.closest('.modal-shell-panel');
    const rail = panel?.querySelector('.modal-shell-rail');
    const thumb = panel?.querySelector('.modal-shell-rail-thumb');
    if (!rail || !thumb) return;

    const { scrollTop, scrollHeight, clientHeight } = shell;
    if (scrollHeight <= clientHeight + 1) {
        rail.hidden = true;
        return;
    }

    rail.hidden = false;
    const thumbHeight = Math.max(24, (clientHeight / scrollHeight) * clientHeight);
    const maxTop = clientHeight - thumbHeight;
    const top = maxTop <= 0 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${top}px)`;
}

function setupModalShellRailInteraction(shell) {
    const panel = shell?.closest('.modal-shell-panel');
    const rail = panel?.querySelector('.modal-shell-rail');
    const thumb = panel?.querySelector('.modal-shell-rail-thumb');
    if (!rail || !thumb || rail.dataset.interactionReady) return;
    rail.dataset.interactionReady = '1';

    const scrollToRatio = (ratio) => {
        const maxScroll = shell.scrollHeight - shell.clientHeight;
        shell.scrollTop = Math.max(0, Math.min(maxScroll, ratio * maxScroll));
        syncModalShellRail(shell);
        engageModalShellRail(shell);
    };

    rail.addEventListener('mousedown', (e) => {
        if (e.target === thumb) return;
        const rect = rail.getBoundingClientRect();
        scrollToRatio((e.clientY - rect.top) / rect.height);
    });

    const startDrag = (clientY) => {
        const startY = clientY;
        const startScroll = shell.scrollTop;
        const thumbHeight = thumb.offsetHeight;
        const trackRange = Math.max(1, rail.clientHeight - thumbHeight);
        const scrollRange = shell.scrollHeight - shell.clientHeight;

        const onMove = (y) => {
            const delta = y - startY;
            shell.scrollTop = startScroll + (delta / trackRange) * scrollRange;
            syncModalShellRail(shell);
            engageModalShellRail(shell);
        };

        const onMouseMove = (e) => onMove(e.clientY);
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };

    thumb.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startDrag(e.clientY);
    });
}

function setupModalShellKeyboard(shell) {
    if (shell.dataset.keyboardScrollReady) return;
    shell.dataset.keyboardScrollReady = '1';

    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('controlModal');
        if (!modal || modal.style.display !== 'block') return;
        if (!shell.classList.contains('modal-shell--scrollable-content')) return;
        if (e.target.closest('input, textarea, select, button, a')) return;

        const line = 48;
        const page = Math.max(120, shell.clientHeight * 0.85);
        let handled = false;

        switch (e.key) {
            case 'ArrowDown':
                shell.scrollTop += line;
                handled = true;
                break;
            case 'ArrowUp':
                shell.scrollTop -= line;
                handled = true;
                break;
            case 'PageDown':
                shell.scrollTop += page;
                handled = true;
                break;
            case 'PageUp':
                shell.scrollTop -= page;
                handled = true;
                break;
            case 'Home':
                shell.scrollTop = 0;
                handled = true;
                break;
            case 'End':
                shell.scrollTop = shell.scrollHeight;
                handled = true;
                break;
            default:
                break;
        }

        if (handled) {
            e.preventDefault();
            syncModalShellRail(shell);
            engageModalShellRail(shell);
        }
    });
}

function setupModalShellScroll() {
    const shell = document.querySelector('#controlModal .modal-shell');
    if (!shell) return;

    const hasSettingsForm = !!shell.querySelector('.modal-form--global, .modal-form--instance');
    shell.classList.toggle('modal-shell--scrollable-content', hasSettingsForm);
    const panel = shell.closest('.modal-shell-panel');
    panel?.classList.toggle('modal-shell-panel--settings', hasSettingsForm);

    if (!shell.dataset.scrollReady) {
        shell.dataset.scrollReady = '1';
        shell.addEventListener('scroll', () => {
            syncModalShellRail(shell);
            engageModalShellRail(shell);
        }, { passive: true });
        setupModalShellRailInteraction(shell);
        setupModalShellKeyboard(shell);

        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(() => syncModalShellRail(shell));
            observer.observe(shell);
            const body = document.getElementById('modalBody');
            if (body) observer.observe(body);
        }
        window.addEventListener('resize', () => syncModalShellRail(shell));
    }

    syncModalShellRail(shell);
}

function resetModalScroll() {
    const shell = document.querySelector('#controlModal .modal-shell');
    if (shell) shell.scrollTop = 0;
}

function showControlModal() {
    document.getElementById('controlModal').style.display = 'block';
    resetModalScroll();
    requestAnimationFrame(() => {
        setupModalShellScroll();
        const shell = document.querySelector('#controlModal .modal-shell');
        if (shell?.classList.contains('modal-shell--scrollable-content')) {
            shell.focus({ preventScroll: true });
        }
    });
}

async function openInstanceSettings(name) {
    try {
        const res = await axios.get(`/api/config/instances/${encodeURIComponent(name)}`);
        if (!res.data.success) {
            showToast('设备配置加载失败', 'error');
            return;
        }
        document.getElementById('modalTitle').textContent = '⚙ 设备设置';
        document.getElementById('modalTitle').dataset.instanceName = name;
        document.getElementById('modalTitle').dataset.formMode = 'edit';
        const cached = cachedInstances.find(i => i.name === name);
        document.getElementById('modalTitle').dataset.instanceOnline =
            cached?.is_online ? '1' : '0';
        _instanceSettingsBaseline = JSON.parse(JSON.stringify(res.data.data));
        document.getElementById('modalBody').innerHTML = buildInstanceForm(res.data.data, 'edit');
        bindSaveInstanceBtn('edit', name);
        bindTestBtn('edit', name);
        bindCycleFormEvents('cur');
        bindCycleFormEvents('next');
        bindNumberSteppers(document.getElementById('modalBody'));
        showControlModal();
    } catch (e) {
        showToast('设备配置加载失败', 'error');
    }
}

function openAddInstance() {
    document.getElementById('modalTitle').textContent = '➕ 添加设备';
    delete document.getElementById('modalTitle').dataset.instanceName;
    document.getElementById('modalTitle').dataset.formMode = 'add';
    _instanceSettingsBaseline = null;
    const suggested = { display_priority: cachedInstances.length + 1 };
    document.getElementById('modalBody').innerHTML = buildInstanceForm(suggested, 'add');
    bindSaveInstanceBtn('add', '');
    bindTestBtn('add', '');
    bindCycleFormEvents('cur');
    bindNumberSteppers(document.getElementById('modalBody'));
    showControlModal();
}

let _savingInstanceSettings = false;
let _instanceSettingsBaseline = null;

function speedRulesEqual(rulesA, rulesB) {
    const a = rulesA || [];
    const b = rulesB || [];
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i += 1) {
        if (parseFloat(a[i].cycle_upload_limit_gb) !== parseFloat(b[i].cycle_upload_limit_gb)) {
            return false;
        }
        if (parseInt(a[i].speed_limit_kbps, 10) !== parseInt(b[i].speed_limit_kbps, 10)) {
            return false;
        }
    }
    return true;
}

function nextCyclePlanEqual(planA, planB) {
    const emptyA = !planA;
    const emptyB = !planB;
    if (emptyA && emptyB) {
        return true;
    }
    if (emptyA !== emptyB) {
        return false;
    }
    return cyclePlansEqual(planA, planB);
}

function instanceCycleSettingsChanged(existing, updated) {
    if (!existing) {
        return false;
    }
    if (!cyclesConfigEqual(existing.cycle, updated.cycle)) {
        return true;
    }
    if (!speedRulesEqual(existing.speed_rules, updated.speed_rules)) {
        return true;
    }
    if (!nextCyclePlanEqual(existing.next_cycle_plan, updated.next_cycle_plan)) {
        return true;
    }
    return false;
}

function instanceConnectionChanged(existing, updated) {
    if (!existing) {
        return true;
    }
    if (String(existing.host ?? '') !== String(updated.host ?? '')) {
        return true;
    }
    if (Number(existing.port) !== Number(updated.port)) {
        return true;
    }
    if (Boolean(existing.use_https) !== Boolean(updated.use_https)) {
        return true;
    }
    if (Boolean(existing.verify_ssl) !== Boolean(updated.verify_ssl)) {
        return true;
    }
    if (String(existing.username ?? '') !== String(updated.username ?? '')) {
        return true;
    }
    if ((updated.password || '').length > 0) {
        return true;
    }
    return false;
}

const OFFLINE_RULE_MSG = '设备不在线，待设备上线后才能修改规则';
const UNREACHABLE_RULE_MSG = '无法连接设备，待设备上线后才能修改规则';

function showSaveResultToast(message, isError = false) {
    const infoMsgs = [OFFLINE_RULE_MSG, UNREACHABLE_RULE_MSG];
    const type = !isError && infoMsgs.includes(message) ? 'info' : (isError ? 'error' : 'success');
    showToast(message, type);
}

function instanceOnlyBasicsChanged(existing, updated) {
    if (!existing) {
        return false;
    }
    if (String(existing.host ?? '') !== String(updated.host ?? '')) {
        return false;
    }
    if (Number(existing.port) !== Number(updated.port)) {
        return false;
    }
    if (Boolean(existing.use_https) !== Boolean(updated.use_https)) {
        return false;
    }
    if (Boolean(existing.verify_ssl) !== Boolean(updated.verify_ssl)) {
        return false;
    }
    if (String(existing.username ?? '') !== String(updated.username ?? '')) {
        return false;
    }
    if ((updated.password || '').length > 0) {
        return false;
    }
    if (!cyclesConfigEqual(existing.cycle, updated.cycle)) {
        return false;
    }
    if (!speedRulesEqual(existing.speed_rules, updated.speed_rules)) {
        return false;
    }
    if (!nextCyclePlanEqual(existing.next_cycle_plan, updated.next_cycle_plan)) {
        return false;
    }
    return true;
}

async function testInstanceConnectivityForSave(data, originalName) {
    const payload = {
        ...data,
        _original_name: originalName || '',
        test_type: 'connect',
    };
    try {
        const res = await axios.post('/api/config/instances/test', payload, {
            timeout: estimateClientTestTimeout('connect'),
        });
        return res.data?.success === true;
    } catch (e) {
        return false;
    }
}

function confirmUnreachableInstanceSave(onConfirm) {
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        showToast('确认弹窗加载失败，请刷新页面后重试', 'error');
        return;
    }
    document.getElementById('confirmModalTitle').textContent = '无法连接设备';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm">
            <p class="confirm-message">目前无法连接该设备，连接信息将先保存到本程序；等设备上线后自动连接。</p>
            <div class="modal-actions">
                <button class="btn-primary" id="confirmOfflineSaveBtn">知道了，继续保存</button>
                <button class="btn-secondary" id="cancelOfflineSaveBtn">✖ 取消保存</button>
            </div>
        </div>`;
    document.getElementById('confirmOfflineSaveBtn').onclick = () => {
        closeConfirmModal();
        onConfirm();
    };
    document.getElementById('cancelOfflineSaveBtn').onclick = () => {
        closeConfirmModal();
    };
    modal.style.display = 'block';
}

function validateInstanceFormData(data, mode) {
    if (!data.name || !data.host) {
        showToast('请填写名称和地址', 'error');
        return false;
    }
    if (data.name.length > INSTANCE_NAME_MAX_LENGTH) {
        showToast(`名称不能超过 ${INSTANCE_NAME_MAX_LENGTH} 个字符`, 'error');
        return false;
    }
    if (!Number.isFinite(data.display_priority) || data.display_priority < 1
        || data.display_priority > DISPLAY_PRIORITY_MAX) {
        showToast(`设备序号须为 1-${DISPLAY_PRIORITY_MAX}`, 'error');
        return false;
    }
    if (isNaN(data.port) || data.port < 1 || data.port > 65535) {
        showToast('请填写有效的地址与端口，格式如 example.com:8080', 'error');
        return false;
    }
    if (!validateAllUploadLimitInputs(mode)) {
        return false;
    }
    if (!validateCycleConfig(data.cycle)) {
        return false;
    }
    if (!validateSpeedRules(data.speed_rules)) {
        return false;
    }
    const nextSection = document.getElementById(`${mode}NextPlanSection`);
    if (nextSection && !nextSection.hidden) {
        if (!validateCycleConfig(data.next_cycle_plan.cycle)) {
            return false;
        }
        if (!validateSpeedRules(data.next_cycle_plan.speed_rules)) {
            return false;
        }
        const currentPlan = {
            cycle: data.cycle,
            speed_rules: data.speed_rules,
        };
        if (cyclePlansEqual(data.next_cycle_plan, currentPlan)) {
            showToast('下周期计划与当前周期与达量规则设置完全相同，请修改或移除下周期计划', 'error');
            return false;
        }
    }
    if (!validateSaveAuthForm(data, mode)) {
        return false;
    }
    return true;
}

async function saveInstanceSettings(mode, originalName) {
    if (_savingInstanceSettings) {
        return;
    }
    if (!validateAllUploadLimitInputs(mode)) {
        return;
    }
    const data = collectInstanceForm(mode);
    if (!validateInstanceFormData(data, mode)) {
        return;
    }

    const baseline = mode === 'edit' ? _instanceSettingsBaseline : null;
    const cycleChanged = mode === 'edit' && instanceCycleSettingsChanged(baseline, data);
    const connectionChanged = mode === 'edit' && instanceConnectionChanged(baseline, data);
    const inst = mode === 'edit' ? cachedInstances.find(i => i.name === originalName) : null;
    const isOffline = !!(inst && !inst.is_online);

    if (mode === 'edit' && instanceOnlyBasicsChanged(baseline, data)) {
        await doSaveInstanceSettings(mode, originalName, data, {
            attemptSync: false,
            reachable: null,
        });
        return;
    }

    if (cycleChanged && isOffline) {
        showSaveResultToast(OFFLINE_RULE_MSG);
        return;
    }

    const needsConnectTest = mode === 'add' || connectionChanged;

    if (!needsConnectTest && cycleChanged && inst?.is_online) {
        await doSaveInstanceSettings(mode, originalName, data, {
            attemptSync: true,
            reachable: true,
        });
        return;
    }

    if (!needsConnectTest) {
        await doSaveInstanceSettings(mode, originalName, data, {
            attemptSync: false,
            reachable: null,
        });
        return;
    }

    const saveBtn = document.getElementById('saveInstanceBtn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '检测连通性…';
    }

    let canConnect = false;
    try {
        canConnect = await testInstanceConnectivityForSave(data, originalName);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '✔ 保存';
        }
    }

    if (!canConnect) {
        if (cycleChanged) {
            showSaveResultToast(UNREACHABLE_RULE_MSG);
            return;
        }
        confirmUnreachableInstanceSave(() => {
            doSaveInstanceSettings(mode, originalName, data, {
                attemptSync: false,
                reachable: false,
            });
        });
        return;
    }

    await doSaveInstanceSettings(mode, originalName, data, {
        attemptSync: true,
        reachable: true,
    });
}

async function promptOrphanDataPolicyIfNeeded(mode, originalName, data, platform = 'qb') {
    const targetName = (data.name || '').trim();
    const needCheck = mode === 'add' || (mode === 'edit' && targetName !== originalName);
    if (!needCheck || !targetName) {
        return null;
    }
    const checkUrl = platform === 'emby'
        ? '/api/emby/config/instances/orphan-check'
        : '/api/config/instances/orphan-check';
    try {
        const res = await axios.get(checkUrl, {
            params: { name: targetName, _: Date.now() },
        });
        if (!res.data.success || !res.data.has_orphaned_data) {
            return null;
        }
        return await showOrphanDataPolicyModal(mode, targetName, originalName, platform);
    } catch (e) {
        showSaveResultToast(e.response?.data?.error || '历史数据检测失败', true);
        return false;
    }
}

function showOrphanDataPolicyModal(mode, targetName, originalName, platform = 'qb') {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        if (!modal) {
            showToast('确认弹窗加载失败，请刷新页面后重试', 'error');
            resolve(false);
            return;
        }
        const isAdd = mode === 'add';
        const typeLabel = platform === 'emby' ? 'Emby' : 'qB';
        document.getElementById('confirmModalTitle').textContent = '检测到历史数据';
        let bodyHtml;
        if (isAdd) {
            bodyHtml = `
                <div class="modal-form modal-form--confirm">
                    <p class="confirm-message">已检测到 ${typeLabel} 名称 <span class="confirm-restore-name">${escapeHtml(targetName)}</span> 存在历史数据（当前无设备使用）。</p>
                    <div class="confirm-option">
                        <p class="form-hint confirm-option-required">请选择数据处理方式（必选其一）</p>
                        <label class="checkbox-label">
                            <input type="checkbox" id="orphanPolicyRestore">
                            恢复旧设备
                        </label>
                        <p class="form-hint">沿用该名称下的历史统计数据。</p>
                        <label class="checkbox-label">
                            <input type="checkbox" id="orphanPolicyFresh">
                            新建设备
                        </label>
                        <p class="form-hint">清空该名称下的历史数据后重新开始，此操作不可撤销。</p>
                    </div>
                    <div class="modal-actions">
                        <button type="button" class="btn-primary" id="confirmOrphanPolicyBtn" disabled>✔ 确认</button>
                        <button type="button" class="btn-secondary" id="cancelOrphanPolicyBtn">✖ 取消</button>
                    </div>
                </div>`;
        } else {
            bodyHtml = `
                <div class="modal-form modal-form--confirm">
                    <p class="confirm-message">${typeLabel} 名称 <span class="confirm-restore-name">${escapeHtml(targetName)}</span> 存在历史数据。</p>
                    <div class="confirm-option">
                        <p class="form-hint confirm-option-required">请选择如何处理（必选其一）</p>
                        <label class="checkbox-label">
                            <input type="checkbox" id="orphanPolicyRestore">
                            恢复为旧数据
                        </label>
                        <p class="form-hint">丢弃现有数据，改用之前的历史数据，此操作不可撤销。</p>
                        <label class="checkbox-label">
                            <input type="checkbox" id="orphanPolicyFresh">
                            保持现有数据
                        </label>
                        <p class="form-hint">丢弃历史数据，继续使用现有数据，此操作不可撤销。</p>
                    </div>
                    <div class="modal-actions">
                        <button type="button" class="btn-primary" id="confirmOrphanPolicyBtn" disabled>✔ 确认</button>
                        <button type="button" class="btn-secondary" id="cancelOrphanPolicyBtn">✖ 取消</button>
                    </div>
                </div>`;
        }
        document.getElementById('confirmModalBody').innerHTML = bodyHtml;
        const restoreCheckbox = document.getElementById('orphanPolicyRestore');
        const freshCheckbox = document.getElementById('orphanPolicyFresh');
        const confirmBtn = document.getElementById('confirmOrphanPolicyBtn');
        const cancelBtn = document.getElementById('cancelOrphanPolicyBtn');

        function syncOrphanPolicyChoice(changed) {
            if (changed === 'restore' && restoreCheckbox.checked) {
                freshCheckbox.checked = false;
            } else if (changed === 'fresh' && freshCheckbox.checked) {
                restoreCheckbox.checked = false;
            }
            confirmBtn.disabled = !restoreCheckbox.checked && !freshCheckbox.checked;
        }

        restoreCheckbox.onchange = () => syncOrphanPolicyChoice('restore');
        freshCheckbox.onchange = () => syncOrphanPolicyChoice('fresh');

        function finish(policy) {
            closeConfirmModal();
            resolve(policy);
        }

        confirmBtn.onclick = () => {
            if (restoreCheckbox.checked) {
                finish(isAdd ? 'restore' : 'restore_orphan');
            } else if (freshCheckbox.checked) {
                finish(isAdd ? 'fresh' : 'keep_current');
            }
        };
        cancelBtn.onclick = () => finish(false);
        modal.style.display = 'block';
    });
}

async function doSaveInstanceSettings(mode, originalName, data, saveOptions = {}) {
    const attemptSync = saveOptions.attemptSync !== false;
    const reachable = saveOptions.reachable ?? null;
    if (_savingInstanceSettings) {
        return;
    }

    let dataPolicy = saveOptions.dataPolicy ?? null;
    if (dataPolicy === null) {
        const resolved = await promptOrphanDataPolicyIfNeeded(mode, originalName, data);
        if (resolved === false) {
            return;
        }
        dataPolicy = resolved;
    }

    const saveBtn = document.getElementById('saveInstanceBtn');
    _savingInstanceSettings = true;
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
    }

    try {
        const payload = { ...data, attempt_sync: attemptSync, reachable };
        if (dataPolicy) {
            payload.data_policy = dataPolicy;
        }
        let res;
        if (mode === 'add') {
            res = await axios.post('/api/config/instances', payload);
        } else {
            res = await axios.put(`/api/config/instances/${encodeURIComponent(originalName)}`, payload);
        }

        if (!res.data.success) {
            showSaveResultToast(res.data.error || '保存失败', true);
            return;
        }

        if (mode === 'edit' && originalName !== data.name) {
            document.getElementById('modalTitle').dataset.instanceName = data.name;
        }

        closeModal();
        closeConfirmModal();
        showSaveResultToast(res.data.message);

        const synced = res.data.synced === true;
        const lightRefresh = reachable === false || !attemptSync;
        if (mode === 'add') {
            if (lightRefresh) {
                refreshStatus(true, true);
            } else {
                initAutoRefresh();
            }
        } else if (originalName !== data.name) {
            initAutoRefresh();
        } else if (reachable === false) {
            await refreshStatusAfterSync();
        } else if (lightRefresh) {
            refreshStatus(true, true);
        } else if (synced) {
            await refreshStatusAfterSync();
        } else {
            refreshAll(true);
        }
    } catch (e) {
        showSaveResultToast(e.response?.data?.error || '保存失败', true);
    } finally {
        _savingInstanceSettings = false;
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '✔ 保存';
        }
    }
}

let _loadedDataRetentionYears = 5;
let _pendingGlobalSettingsPayload = null;

function renderGlobalSettingsForm(g) {
    document.getElementById('modalTitle').textContent = '⚙ 全局设置';
    document.getElementById('modalBody').innerHTML = `
        <div class="modal-form modal-form--global">
            <div class="form-section form-section--collect">
                <h3>采集刷新与数据保存</h3>
                <div class="form-field">
                    <label>页面刷新间隔
                        <input type="number" id="globalRefreshInterval" min="1" max="30" step="1"
                               data-number-stepper value="${g.refresh_interval ?? 1}" />
                    </label>
                    <p class="form-hint form-hint--field">默认1，1-30 秒整数，控制 Web 自动刷新与前N秒流量展示</p>
                </div>
                <div class="form-field">
                    <label>数据采集间隔
                        <input type="number" id="globalCollectInterval" class="input-readonly" readonly tabindex="-1" value="${g.collect_interval}" />
                    </label>
                    <p class="form-hint form-hint--field">根据刷新间隔自动匹配，避免数据漂移，控制数据采集落库与达量限速判断</p>
                </div>
                <div class="form-field">
                    <label>数据保存年限
                        <input type="number" id="globalDataRetentionYears" min="1" max="20" step="1"
                               data-number-stepper value="${g.data_retention_years ?? 5}" />
                    </label>
                    <p class="form-hint form-hint--field">默认 5，有效值 1-20 年，以 5 秒采集为例每设备保存 1 年约占 4 MB 数据库空间，超出保留年限的数据每天自动清理</p>
                </div>
            </div>
            <div class="form-section form-section--login">
                <h3>Web 登录</h3>
                <div class="form-field">
                    <label>管理账号
                        <input type="text" id="globalWebUsername" value="${escapeHtml(g.web_username || 'admin')}" autocomplete="username" />
                    </label>
                </div>
                <div class="form-field">
                    <label>新密码
                        <input type="password" id="globalWebPassword" placeholder="留空则保持不变" autocomplete="new-password" />
                    </label>
                    <p class="form-hint form-hint--field">留空则保持不变，至少 6 位</p>
                </div>
                <div class="form-field">
                    <label>确认密码
                        <input type="password" id="globalWebPasswordConfirm" placeholder="修改密码时请再次输入" autocomplete="new-password" />
                    </label>
                </div>
            </div>
            <div class="form-section form-section--misc">
                <h3>其他</h3>
                <div class="form-field">
                    <label>时区
                        <input type="text" id="globalTimezone" value="${escapeHtml(g.timezone)}" placeholder="Asia/Shanghai" />
                    </label>
                    <p class="form-hint form-hint--field">默认 Asia/Shanghai，用于设备周期、流量查询等时间计算</p>
                </div>
                <div class="form-field">
                    <label>Web 端口
                        <input type="number" id="globalWebPort" min="1024" max="65535" value="${g.web_port}" />
                    </label>
                    <p class="form-hint form-hint--field">默认 8765，有效值 1024-65535，Web 管理界面端口，变更后需重启容器生效</p>
                </div>
                <div class="global-emby-feature-block">
                    <div class="form-field form-field--checkbox">
                        <label class="checkbox-label">
                            <input type="checkbox" id="globalEmbyEnabled" ${g.emby_enabled ? 'checked' : ''} ${g.emby_feature_locked ? 'disabled' : ''} />
                            <span>开启 Emby 监控功能</span>
                        </label>
                        <p class="form-hint form-hint--field">默认关闭，通过读取 docker.sock 与 Emby-API 配合，可实现同步监控 Emby 的播放会话与外网流量数据。只做排除局域网流量后的大致估算，不保证准确性。</p>
                        <p class="form-hint form-hint--field">开启前提：Docker部署Emby，并映射docker.sock至本容器/var/run/docker.sock:ro</p>
                        ${g.emby_feature_locked ? '<p class="form-hint form-hint--field form-hint--warning">当前仍有 Emby 设备，无法关闭此功能。</p>' : ''}
                    </div>
                    <div id="globalEmbyDefaultViewWrap" class="form-field" ${g.emby_enabled ? '' : 'hidden'} aria-hidden="${g.emby_enabled ? 'false' : 'true'}">
                        <label>默认显示
                            <select id="globalEmbyDefaultView" ${g.emby_enabled ? '' : 'disabled'}>
                                <option value="qb" ${g.emby_default_device_view === 'qb' ? 'selected' : ''}>qB 设备</option>
                                <option value="emby" ${g.emby_default_device_view === 'emby' ? 'selected' : ''}>Emby 设备</option>
                                <option value="merge" ${g.emby_default_device_view === 'merge' ? 'selected' : ''}>合并显示</option>
                            </select>
                        </label>
                        <p class="form-hint form-hint--field">进入「设备管理」时的默认视图。合并显示可通过设备管理页面下的「编辑」按钮配置。</p>
                    </div>
                </div>
            </div>
            <div class="form-section form-section-last form-section--files">
                <h3>文件作用</h3>
                <table class="file-purpose-table">
                    <thead>
                        <tr><th>文件</th><th>作用</th></tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><code>data/traffic.db</code></td>
                            <td>存采集流量的数据库，备份前先停止服务</td>
                        </tr>
                        <tr>
                            <td><code>data/config.yaml</code></td>
                            <td>配置文件（实例、限速规则等）</td>
                        </tr>
                        <tr>
                            <td><code>data/app.log</code></td>
                            <td>日志文件</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div class="form-section form-section--history">
                <h3>历史数据</h3>
                <div class="orphan-data-action">
                    <button type="button" class="btn-secondary btn-orphan-data" onclick="viewOrphanData()">管理历史数据</button>
                </div>
                <p class="form-hint form-hint--field form-hint--history"> 恢复和管理已删除的设备</p>
            </div>
            <div class="modal-actions">
                <button class="btn-primary" onclick="saveGlobalSettings()">✔ 保存</button>
                <button class="btn-secondary" onclick="closeModal()">✖ 取消</button>
            </div>
        </div>`;
    const refreshInput = document.getElementById('globalRefreshInterval');
    const collectInput = document.getElementById('globalCollectInterval');
    if (refreshInput && collectInput) {
        bindGlobalRefreshIntervalInput(
            refreshInput, collectInput, g.refresh_interval ?? REFRESH_INTERVAL_MIN);
    }
    bindNumberSteppers(document.getElementById('modalBody'));
    if (typeof bindGlobalEmbySettingsSection === 'function') {
        bindGlobalEmbySettingsSection();
    }
}

async function fetchOrphanDataLists() {
    const qbRes = await axios.get('/api/config/instances/orphan-data', {
        params: { _: Date.now() },
    });
    if (!qbRes.data.success) {
        throw new Error(qbRes.data.error || '加载失败');
    }
    const qb = (qbRes.data.data || []).map(item => ({ ...item, platform: 'qb' }));
    let emby = [];
    if (typeof isEmbyFeatureEnabled === 'function' && isEmbyFeatureEnabled()) {
        try {
            const embyRes = await axios.get('/api/emby/config/instances/orphan-data', {
                params: { _: Date.now() },
            });
            if (embyRes.data.success) {
                emby = (embyRes.data.data || []).map(item => ({ ...item, platform: 'emby' }));
            }
        } catch (e) { /* Emby 未开启或请求失败时仅展示 qB */ }
    }
    return [...qb, ...emby];
}

let _orphanActiveType = 'qb';
let _orphanDataCache = [];

function buildOrphanTypeSwitchHtml(activeType) {
    const showEmby = typeof isEmbyFeatureEnabled === 'function' && isEmbyFeatureEnabled();
    if (!showEmby) return '';
    return `
        <div class="orphan-data-type-switch">
            <div class="device-view-switch" role="group" aria-label="历史数据类型">
                <div class="device-view-segments">
                    <button type="button" class="device-view-btn${activeType === 'qb' ? ' active' : ''}" data-orphan-type="qb" aria-pressed="${activeType === 'qb' ? 'true' : 'false'}" title="qB 设备">
                        <svg class="device-view-btn-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                            <path d="M10 3v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                            <path d="M7 6l3-3 3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                            <path d="M4 14h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                            <path d="M6 17h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                        </svg>
                        <span class="device-view-btn-label">qB</span>
                    </button>
                    <button type="button" class="device-view-btn device-view-btn--emby${activeType === 'emby' ? ' active' : ''}" data-orphan-type="emby" aria-pressed="${activeType === 'emby' ? 'true' : 'false'}" title="Emby 设备">
                        <svg class="device-view-btn-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                            <rect x="3" y="4.5" width="14" height="9.5" rx="1.5" stroke="currentColor" stroke-width="1.6"/>
                            <path d="M8.5 8.2v3.6l3.8-1.8-3.8-1.8z" fill="currentColor"/>
                        </svg>
                        <span class="device-view-btn-label">Emby</span>
                    </button>
                    <span class="device-view-segment-indicator" aria-hidden="true"></span>
                </div>
            </div>
        </div>`;
}

function bindOrphanTypeSwitch(activeType) {
    document.querySelectorAll('[data-orphan-type]').forEach(btn => {
        btn.onclick = () => {
            const next = btn.dataset.orphanType === 'emby' ? 'emby' : 'qb';
            if (next === _orphanActiveType) return;
            _orphanActiveType = next;
            renderOrphanDataModal(_orphanDataCache, next);
        };
    });
}

function renderOrphanDataModal(orphans, activeType = 'qb') {
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        showToast('确认弹窗加载失败，请刷新页面后重试', 'error');
        return;
    }
    _orphanDataCache = orphans || [];
    const showEmby = typeof isEmbyFeatureEnabled === 'function' && isEmbyFeatureEnabled();
    let type = activeType === 'emby' && showEmby ? 'emby' : 'qb';
    _orphanActiveType = type;

    const filtered = _orphanDataCache.filter(item => item.platform === type);
    const typeSwitchHtml = buildOrphanTypeSwitchHtml(type);
    const emptyHtml = `<li class="orphan-data-empty">没有该类型的历史数据</li>`;
    const listHtml = filtered.length
        ? filtered.map((item) => {
            const timeLine = item.deleted_at
                ? `<span class="orphan-data-time">删除时间：${escapeHtml(item.deleted_at)}</span>`
                : '<span class="orphan-data-time orphan-data-time--unknown">时间未知</span>';
            return `
            <li class="orphan-data-item">
                <div class="orphan-data-main">
                    <span class="orphan-data-name">${escapeHtml(item.name)}</span>
                    ${timeLine}
                </div>
                <button type="button" class="btn-orphan-delete">彻底删除</button>
            </li>`;
        }).join('')
        : emptyHtml;

    const introHtml = filtered.length
        ? '<p class="confirm-message orphan-data-intro">以下名称在数据库中有历史数据，但当前无设备使用：</p>'
        : '';

    document.getElementById('confirmModalTitle').textContent = '孤儿数据';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm modal-form--orphan-data">
            ${typeSwitchHtml}
            ${introHtml}
            <div class="orphan-data-scroll">
                <ul class="orphan-data-list">${listHtml}</ul>
            </div>
            <p class="form-hint orphan-data-footer">恢复方式：添加设备或改名时使用以上名称作为显示名称。qB 与 Emby 允许同名。</p>
            <div class="modal-actions">
                <button type="button" class="btn-secondary" id="closeOrphanDataBtn">✖ 关闭</button>
            </div>
        </div>`;
    document.getElementById('closeOrphanDataBtn').onclick = () => closeConfirmModal();
    bindOrphanTypeSwitch(type);
    const deleteBtns = document.querySelectorAll('.orphan-data-list .btn-orphan-delete');
    filtered.forEach((item, index) => {
        const btn = deleteBtns[index];
        if (!btn) return;
        btn.onclick = () => confirmDeleteOrphanData(item.name, item.platform);
    });
    modal.style.display = 'block';
}

function confirmDeleteOrphanData(name, platform = 'qb') {
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        showToast('确认弹窗加载失败，请刷新页面后重试', 'error');
        return;
    }
    const typeLabel = platform === 'emby' ? 'Emby' : 'qB';
    const detailHint = platform === 'emby'
        ? '将清空该名称下的全部流量统计数据，此操作不可撤销。'
        : '将清空该名称下的全部流量统计与事件记录，此操作不可撤销。';
    document.getElementById('confirmModalTitle').textContent = '🗑 删除孤儿数据';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm">
            <p class="confirm-message">确认要删除 ${typeLabel} 设备 <span class="confirm-restore-name">${escapeHtml(name)}</span> 的历史数据吗？</p>
            <p class="form-hint">${detailHint}</p>
            <div class="modal-actions">
                <button type="button" class="btn-danger" id="confirmDeleteOrphanBtn">✔ 确认删除</button>
                <button type="button" class="btn-secondary" id="cancelDeleteOrphanBtn">✖ 取消</button>
            </div>
        </div>`;
    document.getElementById('confirmDeleteOrphanBtn').onclick = () => doDeleteOrphanData(name, platform);
    document.getElementById('cancelDeleteOrphanBtn').onclick = async () => {
        try {
            const orphans = await fetchOrphanDataLists();
            renderOrphanDataModal(orphans, _orphanActiveType);
        } catch (e) {
            closeConfirmModal();
            showToast(e.message || '加载失败', 'error');
        }
    };
    modal.style.display = 'block';
}

async function doDeleteOrphanData(name, platform = 'qb') {
    const confirmBtn = document.getElementById('confirmDeleteOrphanBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '删除中…';
    }
    const deleteUrl = platform === 'emby'
        ? `/api/emby/config/instances/orphan-data/${encodeURIComponent(name)}`
        : `/api/config/instances/orphan-data/${encodeURIComponent(name)}`;
    try {
        const res = await axios.delete(deleteUrl);
        if (!res.data.success) {
            showToast(res.data.error || '删除失败', 'error');
            return;
        }
        showToast(res.data.message || '删除成功', 'success');
        const orphans = await fetchOrphanDataLists();
        renderOrphanDataModal(orphans, _orphanActiveType);
    } catch (e) {
        showToast(e.response?.data?.error || '删除失败', 'error');
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '✔ 确认删除';
        }
    }
}

async function viewOrphanData() {
    try {
        const orphans = await fetchOrphanDataLists();
        renderOrphanDataModal(orphans, _orphanActiveType || 'qb');
    } catch (e) {
        showToast(e.response?.data?.error || e.message || '加载失败', 'error');
    }
}

async function openGlobalSettings() {
    try {
        const res = await axios.get('/api/config/global');
        if (!res.data.success) {
            showToast('全局设置加载失败', 'error');
            return;
        }
        const g = res.data.data;
        _loadedDataRetentionYears = Number(g.data_retention_years ?? 5);
        renderGlobalSettingsForm(g);
        showControlModal();
    } catch (e) {
        showToast('全局设置加载失败', 'error');
    }
}

function closeConfirmModal() {
    const modal = document.getElementById('confirmModal');
    if (modal) modal.style.display = 'none';
}

function isConfirmModalOpen() {
    const modal = document.getElementById('confirmModal');
    return modal && modal.style.display === 'block';
}

function confirmRetentionDecrease(fromYears, toYears) {
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        showToast('确认弹窗加载失败，请刷新页面后重试', 'error');
        return;
    }
    document.getElementById('confirmModalTitle').textContent = '⚠ 缩短保存年限';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm">
            <p class="confirm-message">确认将数据保存年限从 <b>${fromYears}</b> 年改为 <b>${toYears}</b> 年吗？</p>
            <p class="form-hint">超出新年限的旧历史数据将被立即删除。此操作不可撤销。</p>
            <div class="modal-actions">
                <button class="btn-danger" id="confirmRetentionDecreaseBtn">✔ 确认修改</button>
                <button class="btn-secondary" id="cancelRetentionDecreaseBtn">✖ 取消</button>
            </div>
        </div>`;
    document.getElementById('confirmRetentionDecreaseBtn').onclick = () => {
        doSaveGlobalSettings(_pendingGlobalSettingsPayload, true);
    };
    document.getElementById('cancelRetentionDecreaseBtn').onclick = () => {
        closeConfirmModal();
    };
    modal.style.display = 'block';
}

async function doSaveGlobalSettings(payload, fromConfirm = false) {
    const saveBtn = fromConfirm
        ? document.getElementById('confirmRetentionDecreaseBtn')
        : document.querySelector('#controlModal #modalBody .btn-primary');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
    }

    try {
        const res = await axios.put('/api/config/global', payload);
        if (res.data.success) {
            _loadedDataRetentionYears = payload.data_retention_years;
            if (typeof applyEmbyFeatureConfig === 'function') {
                applyEmbyFeatureConfig(res.data.data);
            }
            if (typeof switchTab === 'function') {
                switchTab(currentTab || 'devices');
            }
            showToast(res.data.message, res.data.port_changed ? 'info' : 'success');
            if (fromConfirm || isConfirmModalOpen()) closeConfirmModal();
            closeModal();
            await fetchAutoRefreshInterval();
            startRefreshCountdown();
            await refreshAll(true);
        } else {
            showToast(res.data.error || '保存失败', 'error');
        }
    } catch (e) {
        showToast(e.response?.data?.error || '保存失败', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = fromConfirm ? '✔ 确认修改' : '✔ 保存';
        }
    }
}

async function saveGlobalSettings() {
    const refreshInput = document.getElementById('globalRefreshInterval');
    const refresh_interval = parseRefreshInterval(refreshInput?.value);
    const collect_interval = refresh_interval != null
        ? collectIntervalForRefresh(refresh_interval)
        : null;
    const data_retention_years = parseInt(document.getElementById('globalDataRetentionYears').value);
    const timezone = document.getElementById('globalTimezone').value.trim();
    const web_port = parseInt(document.getElementById('globalWebPort').value);
    const web_username = document.getElementById('globalWebUsername').value.trim();
    const web_password = document.getElementById('globalWebPassword').value;
    const web_password_confirm = document.getElementById('globalWebPasswordConfirm').value;

    if (refresh_interval === null) {
        showToast('页面刷新间隔须为 1-30 的整数');
        refreshInput?.focus();
        return;
    }
    if ([data_retention_years, web_port].some(v => isNaN(v))) {
        showToast('请填写有效数值', 'error');
        return;
    }
    if (data_retention_years < 1 || data_retention_years > 20) {
        showToast('数据保存年限须在 1～20 年之间', 'error');
        return;
    }
    if (!web_username) {
        showToast('请填写账号', 'error');
        return;
    }
    if (web_password || web_password_confirm) {
        if (web_password !== web_password_confirm) {
            showToast('密码不一致', 'error');
            return;
        }
        if (web_password.length < 6) {
            showToast('密码至少 6 位', 'error');
            return;
        }
    }
    if (!timezone) {
        showToast('请填写时区', 'error');
        return;
    }

    const payload = {
        collect_interval,
        refresh_interval,
        data_retention_years,
        timezone,
        web_port,
        web_username,
        emby_enabled: !!document.getElementById('globalEmbyEnabled')?.checked,
        emby_default_device_view: document.getElementById('globalEmbyDefaultView')?.value || 'qb',
    };
    if (web_password) payload.web_password = web_password;

    if (data_retention_years < _loadedDataRetentionYears) {
        _pendingGlobalSettingsPayload = payload;
        confirmRetentionDecrease(_loadedDataRetentionYears, data_retention_years);
        return;
    }

    await doSaveGlobalSettings(payload, false);
}

let _pendingInstanceName = '';

function openManualLimitModal(name) {
    _pendingInstanceName = name;
    const inst = cachedInstances.find(i => i.name === name) || {};
    const globalK = getGlobalUploadLimitKbps(inst);
    const currentText = formatLimitKbpsText(globalK);
    const altActive = !!inst.alt_speed_limits_active;
    const altActiveAck = altActive
        ? `<div class="manual-limit-alt-option">
                <p class="form-hint form-hint-error manual-limit-alt-notice">当前处于「备用限速」状态，修改此值只在「全局限速」状态下执行。</p>
                <label class="checkbox-label manual-limit-alt-ack">
                    <input type="checkbox" id="manualLimitAltAckCheckbox">
                    我知道了
                </label>
            </div>`
        : '';

    document.getElementById('modalTitle').textContent = '⚡ 手动限速';
    document.getElementById('modalBody').innerHTML = `
        <div class="modal-form modal-form--confirm modal-form--manual-limit">
            <p class="confirm-message">当前全局上传限速：${escapeHtml(currentText)}</p>
            <div class="confirm-option">
                <label>全局限速至 (KB/s)
                    <input type="number" id="manualLimitInput" min="0"
                           max="${QB_MAX_UPLOAD_LIMIT_KBPS}" step="1"
                           placeholder="0 表示不限速"
                           value="" />
                </label>
                <p class="form-hint manual-limit-desc">临时限速，直至下一条达量规则触发后自动接管；不影响 qB 备用限速的执行。</p>
            </div>
            ${altActiveAck}
            <div class="modal-actions">
                <button type="button" class="btn-primary" id="applyManualLimitBtn"${altActive ? ' disabled' : ''}>✔ 应用限速</button>
                <button type="button" class="btn-secondary" onclick="closeModal()">✖ 取消</button>
            </div>
        </div>`;
    const applyBtn = document.getElementById('applyManualLimitBtn');
    applyBtn.onclick = () => doApplyManualLimit(_pendingInstanceName);
    if (altActive) {
        const ackCheckbox = document.getElementById('manualLimitAltAckCheckbox');
        ackCheckbox.onchange = () => {
            applyBtn.disabled = !ackCheckbox.checked;
        };
    }
    bindUploadLimitKbpsInput(
        document.getElementById('manualLimitInput'),
        '',
    );
    document.getElementById('controlModal').style.display = 'block';
}

async function doApplyManualLimit(name) {
    const input = document.getElementById('manualLimitInput');
    const ackCheckbox = document.getElementById('manualLimitAltAckCheckbox');
    if (ackCheckbox && !ackCheckbox.checked) {
        return;
    }
    const raw = String(input?.value ?? '').trim();
    if (!input || raw === '') {
        showToast('请填写限速值，0 表示不限速', 'error');
        return;
    }
    if (!validateUploadLimitKbpsInput(input, '', true)) {
        input.focus();
        return;
    }
    const limitVal = parseUploadLimitKbps(input.value);
    if (limitVal === null) {
        return;
    }
    const inst = cachedInstances.find(i => i.name === name);
    if (inst && !inst.is_online) {
        showToast('设备不在线', 'info');
        return;
    }
    const applyBtn = document.getElementById('applyManualLimitBtn');
    const originalText = applyBtn?.textContent;
    if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.textContent = '应用中…';
    }
    try {
        const res = await axios.post('/api/control/limit', {
            instance_name: name,
            limit_kbps: limitVal
        });
        if (res.data.success) {
            showToast(res.data.message, 'success');
            closeModal();
            await refreshAll(true);
        } else {
            showToast(res.data.error || '设置失败', 'error');
        }
    } catch (e) {
        const errMsg = e.response?.data?.error;
        if (errMsg === '设备不在线') {
            showToast('设备不在线', 'info');
        } else {
            showToast(errMsg || '请求失败', 'error');
        }
    } finally {
        if (applyBtn) {
            applyBtn.textContent = originalText || '✔ 应用限速';
            const ack = document.getElementById('manualLimitAltAckCheckbox');
            applyBtn.disabled = ack ? !ack.checked : false;
        }
    }
}

function confirmResetStats(name) {
    _pendingInstanceName = name;
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        showToast('确认弹窗加载失败，请刷新页面后重试', 'error');
        return;
    }
    document.getElementById('confirmModalTitle').textContent = '🗑 清空统计';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm">
            <p class="confirm-message">确认要清空设备 <span class="confirm-restore-name">${escapeHtml(name)}</span> 的流量统计吗？</p>
            <div class="confirm-option">
                <label class="checkbox-label">
                    <input type="checkbox" id="confirmResetStatsCheckbox">
                    确认清空
                </label>
                <p class="form-hint form-hint-error">将清空该设备全部流量数据并重新累计，此操作不可恢复。</p>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-warning" id="confirmResetStatsBtn" disabled>✔ 确认清空</button>
                <button type="button" class="btn-secondary" id="cancelResetStatsBtn">✖ 取消</button>
            </div>
        </div>`;
    const confirmCheckbox = document.getElementById('confirmResetStatsCheckbox');
    const confirmBtn = document.getElementById('confirmResetStatsBtn');
    confirmCheckbox.onchange = () => {
        confirmBtn.disabled = !confirmCheckbox.checked;
    };
    confirmBtn.onclick = () => {
        if (confirmBtn.disabled) return;
        doResetStats(_pendingInstanceName);
    };
    document.getElementById('cancelResetStatsBtn').onclick = () => closeConfirmModal();
    modal.style.display = 'block';
}

async function doResetStats(name) {
    const confirmBtn = document.getElementById('confirmResetStatsBtn');
    if (confirmBtn?.disabled) return;
    const originalText = confirmBtn?.textContent;
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '清空中…';
    }
    try {
        const res = await axios.post('/api/control/reset-stats', { instance_name: name });
        if (res.data.success) {
            showToast(res.data.message, 'success');
            closeConfirmModal();
            await refreshAll(true);
        } else {
            showToast(res.data.error || '清空失败', 'error');
        }
    } catch (e) {
        showToast(e.response?.data?.error || '请求失败', 'error');
    } finally {
        if (confirmBtn) {
            confirmBtn.textContent = originalText || '✔ 确认清空';
            const checkbox = document.getElementById('confirmResetStatsCheckbox');
            confirmBtn.disabled = !checkbox?.checked;
        }
    }
}

function confirmDelete(name) {
    _pendingInstanceName = name;
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        showToast('确认弹窗加载失败，请刷新页面后重试', 'error');
        return;
    }
    document.getElementById('confirmModalTitle').textContent = '🗑 删除设备';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm">
            <p class="confirm-message">确认要删除设备 <span class="confirm-restore-name">${escapeHtml(name)}</span> 吗？</p>
            <div class="confirm-option">
                <p class="form-hint confirm-option-required">请选择数据处理方式（必选其一）</p>
                <label class="checkbox-label">
                    <input type="checkbox" id="keepDataOnDelete">
                    保留数据
                </label>
                <p class="form-hint">恢复方式：添加设备并使用「<span class="confirm-restore-name">${escapeHtml(name)}</span>」作为显示名称。</p>
                <label class="checkbox-label">
                    <input type="checkbox" id="discardDataOnDelete">
                    不保留数据
                </label>
                <p class="form-hint form-hint-error">勾选后同时清空该设备的历史统计数据，此操作不可撤销。</p>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-danger" id="confirmDeleteBtn" disabled>✔ 确认删除</button>
                <button type="button" class="btn-secondary" id="cancelDeleteBtn">✖ 取消</button>
            </div>
        </div>`;
    const keepDataCheckbox = document.getElementById('keepDataOnDelete');
    const discardDataCheckbox = document.getElementById('discardDataOnDelete');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

    function syncDeleteDataChoice(changed) {
        if (changed === 'keep' && keepDataCheckbox.checked) {
            discardDataCheckbox.checked = false;
        } else if (changed === 'discard' && discardDataCheckbox.checked) {
            keepDataCheckbox.checked = false;
        }
        confirmDeleteBtn.disabled = !keepDataCheckbox.checked && !discardDataCheckbox.checked;
    }

    keepDataCheckbox.onchange = () => syncDeleteDataChoice('keep');
    discardDataCheckbox.onchange = () => syncDeleteDataChoice('discard');

    confirmDeleteBtn.onclick = () => {
        if (confirmDeleteBtn.disabled) {
            return;
        }
        const keepData = keepDataCheckbox.checked;
        doDelete(_pendingInstanceName, keepData);
    };
    document.getElementById('cancelDeleteBtn').onclick = () => {
        closeConfirmModal();
    };
    modal.style.display = 'block';
}

async function doDelete(name, keepData = false) {
    const btn = document.getElementById('confirmDeleteBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '删除中…';
    }
    try {
        const res = await axios.delete(`/api/config/instances/${encodeURIComponent(name)}`, {
            params: { keep_data: keepData ? '1' : '0' }
        });
        if (res.data?.success) {
            closeConfirmModal();
            showToast(res.data.message || '删除成功', 'success');
            refreshAll(true);
            return;
        }
        showToast(res.data?.error || '删除失败', 'error');
    } catch (e) {
        const errMsg = e.response?.data?.error || '删除失败';
        if (e.response?.status === 400 && errMsg === '设备不存在') {
            closeConfirmModal();
            refreshAll(true);
        }
        showToast(errMsg, 'error');
    } finally {
        if (btn) {
            btn.textContent = '✔ 确认删除';
            const keep = document.getElementById('keepDataOnDelete');
            const discard = document.getElementById('discardDataOnDelete');
            btn.disabled = !(keep?.checked || discard?.checked);
        }
    }
}

function closeModal() {
    closeConfirmModal();
    document.getElementById('controlModal').style.display = 'none';
}

window.onclick = function(e) {
    const confirmModal = document.getElementById('confirmModal');
    if (confirmModal && e.target === confirmModal) closeConfirmModal();
    else if (e.target === document.getElementById('controlModal')) closeModal();
};

function showToast(message, type = 'info', duration = 3000) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
