/** qB / Emby 整合：功能开关、设备视图、统一 Tab 路由 */

const DEVICE_TYPE_FILTER_KEY = 'qb-up-limit-device-type-filter';
const SYSLOG_TYPE_FILTER_KEY = 'qb-up-limit-syslog-type-filter';
const DEVICE_VIEW_MODE_KEY = 'qb-up-limit-device-view-mode';
const MOBILE_DEVICE_VIEW_KEY = 'qb-up-limit-mobile-device-view';
const MERGE_QB_SELECTION_KEY = 'qb-up-limit-merge-qb-selection';
const MERGE_EMBY_SELECTION_KEY = 'qb-up-limit-merge-emby-selection';
const MERGE_QB_ORDER_KEY = 'qb-up-limit-merge-qb-order';
const MERGE_EMBY_ORDER_KEY = 'qb-up-limit-merge-emby-order';
const LEGACY_PLATFORM_KEY = 'qb-up-limit-current-platform';

const DEVICE_VIEW_MODES = new Set(['qb', 'emby', 'merge']);
const DEVICE_TYPE_FILTERS = new Set(['qb', 'emby']);
const SYSLOG_TYPE_FILTERS = new Set(['system', 'qb', 'emby']);

let embyFeatureEnabled = false;
let embyDefaultDeviceView = 'qb';
let embyInstanceCount = 0;
let embyFeatureLocked = false;
let deviceViewMode = 'qb';
let mergeQbSelection = null;
let mergeEmbySelection = null;
let mergeQbOrder = null;
let mergeEmbyOrder = null;
let mergePopoverOpen = false;
let devicesPanelDataReady = { qb: false, emby: false };

function resetDevicesPanelDataReady() {
    devicesPanelDataReady = { qb: false, emby: false };
}

function markDevicesPanelDataReady(side) {
    if (side === 'qb' || side === 'emby') {
        devicesPanelDataReady[side] = true;
    }
}

function isDevicesPanelDataReady() {
    return devicesPanelDataReady.qb && devicesPanelDataReady.emby;
}

const MERGE_DEVICES_DRAG_HANDLE_ICON = `<svg class="merge-devices-drag-icon" viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="7.5" cy="5" r="1.35" fill="currentColor"/>
    <circle cx="12.5" cy="5" r="1.35" fill="currentColor"/>
    <circle cx="7.5" cy="10" r="1.35" fill="currentColor"/>
    <circle cx="12.5" cy="10" r="1.35" fill="currentColor"/>
    <circle cx="7.5" cy="15" r="1.35" fill="currentColor"/>
    <circle cx="12.5" cy="15" r="1.35" fill="currentColor"/>
</svg>`;

function getQbInstanceNames() {
    return (typeof cachedInstances !== 'undefined' ? cachedInstances : []).map(i => i.name);
}

function getEmbyInstanceNames() {
    return (typeof cachedEmbyInstances !== 'undefined' ? cachedEmbyInstances : []).map(i => i.name);
}

function getInstancesSortedByPriority(side) {
    const instances = side === 'qb'
        ? (typeof cachedInstances !== 'undefined' ? cachedInstances : [])
        : (typeof cachedEmbyInstances !== 'undefined' ? cachedEmbyInstances : []);
    return [...instances].sort((a, b) => {
        const pa = a.display_priority ?? 500;
        const pb = b.display_priority ?? 500;
        if (pa !== pb) return pa - pb;
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    }).map(i => i.name);
}

function loadMergeSelectionFromStorage() {
    try {
        const loadKey = (key) => {
            let val = localStorage.getItem(key);
            if (!val) {
                val = sessionStorage.getItem(key);
                if (val) {
                    localStorage.setItem(key, val);
                    sessionStorage.removeItem(key);
                }
            }
            return val;
        };
        const qb = loadKey(MERGE_QB_SELECTION_KEY);
        const emby = loadKey(MERGE_EMBY_SELECTION_KEY);
        const qbOrder = loadKey(MERGE_QB_ORDER_KEY);
        const embyOrder = loadKey(MERGE_EMBY_ORDER_KEY);
        if (qb) {
            const parsed = JSON.parse(qb);
            if (Array.isArray(parsed) && parsed.length) mergeQbSelection = new Set(parsed);
        }
        if (emby) {
            const parsed = JSON.parse(emby);
            if (Array.isArray(parsed) && parsed.length) mergeEmbySelection = new Set(parsed);
        }
        if (qbOrder) mergeQbOrder = JSON.parse(qbOrder);
        if (embyOrder) mergeEmbyOrder = JSON.parse(embyOrder);
    } catch (e) { /* ignore */ }
}

function saveMergeSelectionToStorage() {
    try {
        if (mergeQbSelection) {
            localStorage.setItem(MERGE_QB_SELECTION_KEY, JSON.stringify([...mergeQbSelection]));
        }
        if (mergeEmbySelection) {
            localStorage.setItem(MERGE_EMBY_SELECTION_KEY, JSON.stringify([...mergeEmbySelection]));
        }
        if (mergeQbOrder) {
            localStorage.setItem(MERGE_QB_ORDER_KEY, JSON.stringify(mergeQbOrder));
        }
        if (mergeEmbyOrder) {
            localStorage.setItem(MERGE_EMBY_ORDER_KEY, JSON.stringify(mergeEmbyOrder));
        }
    } catch (e) { /* ignore */ }
}

function buildDevicePrefsPayload() {
    const payload = {};
    if (deviceViewMode) payload.device_view_mode = deviceViewMode;
    if (mergeQbSelection) payload.merge_qb_selection = [...mergeQbSelection];
    if (mergeEmbySelection) payload.merge_emby_selection = [...mergeEmbySelection];
    if (Array.isArray(mergeQbOrder)) payload.merge_qb_order = mergeQbOrder;
    if (Array.isArray(mergeEmbyOrder)) payload.merge_emby_order = mergeEmbyOrder;
    return payload;
}

function hasLocalDevicePrefs() {
    try {
        const keys = [
            MERGE_QB_SELECTION_KEY,
            MERGE_EMBY_SELECTION_KEY,
            MERGE_QB_ORDER_KEY,
            MERGE_EMBY_ORDER_KEY,
            DEVICE_VIEW_MODE_KEY,
        ];
        return keys.some(key => localStorage.getItem(key));
    } catch (e) {
        return false;
    }
}

function isEmptyServerDevicePrefs(data) {
    return !data || !Object.keys(data).length;
}

function applyDeviceViewPreferencesFromData(data) {
    const prefs = data || {};
    if (Array.isArray(prefs.merge_qb_selection) && prefs.merge_qb_selection.length) {
        mergeQbSelection = new Set(prefs.merge_qb_selection);
    }
    if (Array.isArray(prefs.merge_emby_selection) && prefs.merge_emby_selection.length) {
        mergeEmbySelection = new Set(prefs.merge_emby_selection);
    }
    if (Array.isArray(prefs.merge_qb_order)) {
        mergeQbOrder = prefs.merge_qb_order;
    }
    if (Array.isArray(prefs.merge_emby_order)) {
        mergeEmbyOrder = prefs.merge_emby_order;
    }
    if (prefs.device_view_mode && DEVICE_VIEW_MODES.has(prefs.device_view_mode)) {
        deviceViewMode = normalizeDeviceViewMode(prefs.device_view_mode);
        return;
    }
    if (embyFeatureEnabled) {
        deviceViewMode = normalizeEmbyDefaultDeviceView(embyDefaultDeviceView);
    }
}

function persistDeviceViewPreferencesToServer(partial) {
    const payload = partial && Object.keys(partial).length ? partial : buildDevicePrefsPayload();
    if (!Object.keys(payload).length) return;
    axios.put('/api/user/prefs/devices', payload).catch(() => {});
}

function syncDeviceViewPreferencesToLocalCache() {
    saveMergeSelectionToStorage();
    if (!isMobileViewport() && deviceViewMode) {
        try {
            localStorage.setItem(DEVICE_VIEW_MODE_KEY, deviceViewMode);
        } catch (e) { /* ignore */ }
    }
}

function getMergeOrderedNames(side) {
    const allNames = side === 'qb' ? getQbInstanceNames() : getEmbyInstanceNames();
    const priorityOrdered = getInstancesSortedByPriority(side);
    const stored = side === 'qb' ? mergeQbOrder : mergeEmbyOrder;
    if (!Array.isArray(stored) || !stored.length) {
        return priorityOrdered.length ? priorityOrdered : allNames;
    }
    const ordered = stored.filter(name => allNames.includes(name));
    priorityOrdered.forEach(name => {
        if (!ordered.includes(name)) ordered.push(name);
    });
    return ordered;
}

function sortInstancesByMergeOrder(instances, side) {
    const order = getMergeOrderedNames(side);
    const selection = getMergeSelection(side);
    const filtered = (instances || []).filter(item => selection.has(item.name));
    const indexMap = new Map(order.map((name, index) => [name, index]));
    return [...filtered].sort((a, b) => {
        const indexA = indexMap.get(a.name) ?? 9999;
        const indexB = indexMap.get(b.name) ?? 9999;
        if (indexA !== indexB) return indexA - indexB;
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
}

function getMergeSelection(side) {
    const names = side === 'qb' ? getQbInstanceNames() : getEmbyInstanceNames();
    const stored = side === 'qb' ? mergeQbSelection : mergeEmbySelection;
    if (stored === null || stored === undefined) return new Set(names);
    return new Set([...stored].filter(n => names.includes(n)));
}

function getFilteredQbInstancesForMerge() {
    return sortInstancesByMergeOrder(
        typeof cachedInstances !== 'undefined' ? cachedInstances : [],
        'qb',
    );
}

function getFilteredEmbyInstancesForMerge() {
    return sortInstancesByMergeOrder(
        typeof cachedEmbyInstances !== 'undefined' ? cachedEmbyInstances : [],
        'emby',
    );
}

function canApplyMergeSelection(qbSelected, embySelected) {
    return qbSelected.size > 0 && embySelected.size > 0;
}

function getPopoverCheckedNames(side) {
    const listId = side === 'qb' ? 'mergeDevicesListQb' : 'mergeDevicesListEmby';
    const list = document.getElementById(listId);
    if (!list) return new Set();
    const names = new Set();
    list.querySelectorAll('input[type="checkbox"]:checked').forEach(input => {
        if (input.value) names.add(input.value);
    });
    return names;
}

function updateMergeApplyButtonState() {
    const qbChecked = getPopoverCheckedNames('qb');
    const embyChecked = getPopoverCheckedNames('emby');
    const applyBtn = document.getElementById('mergeDevicesApplyBtn');
    const errorEl = document.getElementById('mergeDevicesPopoverError');
    const valid = canApplyMergeSelection(qbChecked, embyChecked);
    if (applyBtn) applyBtn.disabled = !valid;
    if (!errorEl) return;
    if (!valid) {
        errorEl.hidden = false;
        if (qbChecked.size === 0 && embyChecked.size === 0) {
            errorEl.textContent = '请分别在两侧至少选择一个设备';
        } else if (qbChecked.size === 0) {
            errorEl.textContent = '请至少选择一个 qB 设备';
        } else {
            errorEl.textContent = '请至少选择一个 Emby 设备';
        }
    } else {
        errorEl.hidden = true;
        errorEl.textContent = '';
    }
}

function getPopoverOrderedNames(side) {
    const listId = side === 'qb' ? 'mergeDevicesListQb' : 'mergeDevicesListEmby';
    const list = document.getElementById(listId);
    if (!list) return [];
    return [...list.querySelectorAll('.merge-devices-item')].map(item => item.dataset.name).filter(Boolean);
}

function buildMergeDevicesListHtml(side, names, selected) {
    if (!names.length) {
        return '<div class="merge-devices-empty">暂无设备</div>';
    }
    return names.map(name => {
        const safeName = typeof escapeHtml === 'function' ? escapeHtml(name) : name;
        const checked = selected.has(name) ? 'checked' : '';
        return `<div class="merge-devices-item" data-name="${safeName}">
            <label class="merge-devices-item-main checkbox-label">
                <input type="checkbox" value="${safeName}" ${checked} data-side="${side}" />
                <span class="merge-devices-item-label">${safeName}</span>
            </label>
            <button type="button" class="merge-devices-drag-handle" aria-label="拖动调整顺序" title="拖动调整顺序">
                ${MERGE_DEVICES_DRAG_HANDLE_ICON}
            </button>
        </div>`;
    }).join('');
}

function setupMergeDevicesListDrag(listEl) {
    if (!listEl || listEl.dataset.dragReady) return;
    listEl.dataset.dragReady = '1';

    let dragging = null;
    let pointerId = null;

    const getItems = () => [...listEl.querySelectorAll('.merge-devices-item')];

    const onPointerMove = (e) => {
        if (!dragging || e.pointerId !== pointerId) return;
        e.preventDefault();
        const items = getItems().filter(item => item !== dragging);
        const y = e.clientY;
        let inserted = false;
        for (const item of items) {
            const rect = item.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (y < mid) {
                listEl.insertBefore(dragging, item);
                inserted = true;
                break;
            }
        }
        if (!inserted) {
            listEl.appendChild(dragging);
        }
    };

    const endDrag = (e) => {
        if (!dragging) return;
        if (e && e.pointerId !== undefined && pointerId !== null && e.pointerId !== pointerId) return;
        dragging.classList.remove('is-dragging');
        const handle = dragging.querySelector('.merge-devices-drag-handle');
        if (handle?.hasPointerCapture?.(pointerId)) {
            handle.releasePointerCapture(pointerId);
        }
        dragging = null;
        pointerId = null;
        listEl.classList.remove('is-drag-active');
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', endDrag);
        document.removeEventListener('pointercancel', endDrag);
    };

    listEl.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest('.merge-devices-drag-handle');
        if (!handle || !listEl.contains(handle)) return;
        const item = handle.closest('.merge-devices-item');
        if (!item) return;
        e.preventDefault();
        dragging = item;
        pointerId = e.pointerId;
        handle.setPointerCapture(e.pointerId);
        item.classList.add('is-dragging');
        listEl.classList.add('is-drag-active');
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', endDrag);
        document.addEventListener('pointercancel', endDrag);
    });
}

function renderMergeDevicesPopoverContent() {
    const popover = document.getElementById('mergeDevicesPopover');
    if (!popover) return;

    const qbNames = getMergeOrderedNames('qb');
    const embyNames = getMergeOrderedNames('emby');
    const qbSelected = getMergeSelection('qb');
    const embySelected = getMergeSelection('emby');

    popover.innerHTML = `
        <div class="merge-devices-popover-header">
            <span class="merge-devices-popover-title">合并显示</span>
            <span class="merge-devices-popover-hint">拖动右侧把手调整顺序</span>
        </div>
        <div class="merge-devices-popover-body">
            <div class="merge-devices-popover-column">
                <div class="merge-devices-popover-column-head">
                    <span class="merge-devices-popover-column-title">qB 设备</span>
                    <button type="button" class="merge-devices-toggle-all" data-side="qb" ${qbNames.length ? '' : 'disabled'}>全选</button>
                </div>
                <div class="merge-devices-list" id="mergeDevicesListQb">${buildMergeDevicesListHtml('qb', qbNames, qbSelected)}</div>
            </div>
            <div class="merge-devices-popover-column">
                <div class="merge-devices-popover-column-head">
                    <span class="merge-devices-popover-column-title">Emby 设备</span>
                    <button type="button" class="merge-devices-toggle-all" data-side="emby" ${embyNames.length ? '' : 'disabled'}>全选</button>
                </div>
                <div class="merge-devices-list" id="mergeDevicesListEmby">${buildMergeDevicesListHtml('emby', embyNames, embySelected)}</div>
            </div>
        </div>
        <div class="merge-devices-popover-footer">
            <p class="merge-devices-popover-error" id="mergeDevicesPopoverError" hidden></p>
            <button type="button" class="btn-primary merge-devices-apply-btn" id="mergeDevicesApplyBtn" disabled>保存并应用</button>
        </div>`;

    popover.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('change', updateMergeApplyButtonState);
    });
    popover.querySelectorAll('.merge-devices-toggle-all').forEach(btn => {
        const side = btn.dataset.side;
        const listId = side === 'qb' ? 'mergeDevicesListQb' : 'mergeDevicesListEmby';
        const syncToggleLabel = () => {
            const list = document.getElementById(listId);
            const checkboxes = list ? [...list.querySelectorAll('input[type="checkbox"]')] : [];
            btn.textContent = checkboxes.length && checkboxes.every(cb => cb.checked) ? '取消全选' : '全选';
        };
        btn.addEventListener('click', () => {
            const list = document.getElementById(listId);
            if (!list) return;
            const checkboxes = [...list.querySelectorAll('input[type="checkbox"]')];
            if (!checkboxes.length) return;
            const allChecked = checkboxes.every(cb => cb.checked);
            checkboxes.forEach(cb => { cb.checked = !allChecked; });
            syncToggleLabel();
            updateMergeApplyButtonState();
        });
        syncToggleLabel();
    });
    document.getElementById('mergeDevicesApplyBtn')?.addEventListener('click', applyMergeDeviceSelection);
    setupMergeDevicesListDrag(document.getElementById('mergeDevicesListQb'));
    setupMergeDevicesListDrag(document.getElementById('mergeDevicesListEmby'));
    updateMergeApplyButtonState();
}

function positionMergeDevicesPopover() {
    const popover = document.getElementById('mergeDevicesPopover');
    const btn = document.getElementById('deviceMergeEditBtn');
    if (!popover || !btn || popover.hidden) return;

    const rect = btn.getBoundingClientRect();
    const viewportPadding = 12;
    const width = Math.min(440, window.innerWidth - viewportPadding * 2);
    popover.style.width = `${width}px`;

    let right = Math.max(viewportPadding, window.innerWidth - rect.right);
    if (right + width > window.innerWidth - viewportPadding) {
        right = window.innerWidth - width - viewportPadding;
    }

    popover.style.top = `${rect.bottom + 8}px`;
    popover.style.right = `${right}px`;
    popover.style.left = 'auto';
    popover.style.bottom = 'auto';

    const popoverLeft = window.innerWidth - right - width;
    const btnCenter = rect.left + rect.width / 2;
    const arrowRight = Math.max(12, Math.min(width - 24, width - (btnCenter - popoverLeft) - 6));
    popover.style.setProperty('--merge-popover-arrow-right', `${arrowRight}px`);
}

function mountMergeDevicesPopover() {
    const popover = document.getElementById('mergeDevicesPopover');
    if (!popover || popover.parentElement === document.body) return;
    document.body.appendChild(popover);
    popover.classList.add('merge-devices-popover--floating');
}

function onMergePopoverReposition() {
    if (mergePopoverOpen) positionMergeDevicesPopover();
}

function closeMergeDevicesPopover() {
    const popover = document.getElementById('mergeDevicesPopover');
    const btn = document.getElementById('deviceMergeEditBtn');
    if (!popover) return;
    popover.hidden = true;
    if (btn) {
        btn.setAttribute('aria-expanded', 'false');
        btn.classList.remove('is-open');
    }
    mergePopoverOpen = false;
    document.removeEventListener('click', onMergePopoverOutsideClick);
    document.removeEventListener('keydown', onMergePopoverKeydown);
    window.removeEventListener('resize', onMergePopoverReposition);
    window.removeEventListener('scroll', onMergePopoverReposition, true);
}

function onMergePopoverOutsideClick(e) {
    const wrap = document.getElementById('deviceMergeEditWrap');
    const popover = document.getElementById('mergeDevicesPopover');
    if ((wrap && wrap.contains(e.target)) || (popover && popover.contains(e.target))) {
        return;
    }
    closeMergeDevicesPopover();
}

function onMergePopoverKeydown(e) {
    if (e.key === 'Escape') closeMergeDevicesPopover();
}

function openMergeDevicesPopover() {
    const popover = document.getElementById('mergeDevicesPopover');
    const btn = document.getElementById('deviceMergeEditBtn');
    if (!popover || !btn || !embyFeatureEnabled || isMobileViewport()) return;

    mountMergeDevicesPopover();
    renderMergeDevicesPopoverContent();
    popover.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('is-open');
    mergePopoverOpen = true;
    positionMergeDevicesPopover();

    setTimeout(() => {
        positionMergeDevicesPopover();
        document.addEventListener('click', onMergePopoverOutsideClick);
        document.addEventListener('keydown', onMergePopoverKeydown);
        window.addEventListener('resize', onMergePopoverReposition);
        window.addEventListener('scroll', onMergePopoverReposition, true);
    }, 0);
}

function toggleMergeDevicesPopover(event) {
    if (event) event.stopPropagation();
    if (!embyFeatureEnabled || isMobileViewport()) return;
    if (mergePopoverOpen) {
        closeMergeDevicesPopover();
    } else {
        openMergeDevicesPopover();
    }
}

function enterMergeView(qbSelected, embySelected) {
    mergeQbSelection = qbSelected;
    mergeEmbySelection = embySelected;
    mergeQbOrder = getPopoverOrderedNames('qb');
    mergeEmbyOrder = getPopoverOrderedNames('emby');
    saveMergeSelectionToStorage();
    persistDeviceViewPreferencesToServer({
        device_view_mode: 'merge',
        merge_qb_selection: [...mergeQbSelection],
        merge_emby_selection: [...mergeEmbySelection],
        merge_qb_order: mergeQbOrder,
        merge_emby_order: mergeEmbyOrder,
    });
    setDeviceViewMode('merge');
    syncDevicesPanelModeClass();
    closeMergeDevicesPopover();
    if (typeof ensureEmbyDataLoaded === 'function') {
        ensureEmbyDataLoaded(true).then(() => {
            if (typeof renderDevicesPanel === 'function') renderDevicesPanel(true);
        });
        return;
    }
    if (typeof renderDevicesPanel === 'function') {
        renderDevicesPanel(true);
    }
}

function applyMergeDeviceSelection() {
    const qbChecked = getPopoverCheckedNames('qb');
    const embyChecked = getPopoverCheckedNames('emby');
    if (!canApplyMergeSelection(qbChecked, embyChecked)) return;
    enterMergeView(qbChecked, embyChecked);
}

function isEmbyFeatureEnabled() {
    return embyFeatureEnabled;
}

function isMobileViewport() {
    return window.matchMedia('(max-width: 992px)').matches;
}

function normalizeDeviceViewMode(mode) {
    const value = String(mode || '').trim().toLowerCase();
    return DEVICE_VIEW_MODES.has(value) ? value : 'qb';
}

function getMobileDeviceViewFallback() {
    try {
        const saved = sessionStorage.getItem(MOBILE_DEVICE_VIEW_KEY);
        if (saved === 'emby' || saved === 'qb') return saved;
    } catch (e) { /* ignore */ }
    return 'qb';
}

let lastKnownMobileViewport = null;

function syncViewportDeviceViewMode(isMobile = isMobileViewport()) {
    if (!embyFeatureEnabled) return;

    const enteringMobile = lastKnownMobileViewport === false && isMobile;
    const leavingMobile = lastKnownMobileViewport === true && !isMobile;

    if (enteringMobile && deviceViewMode === 'merge') {
        try {
            sessionStorage.removeItem(MOBILE_DEVICE_VIEW_KEY);
        } catch (e) { /* ignore */ }
    }

    if (leavingMobile) {
        restoreDeviceViewModeFromStorage();
    }

    lastKnownMobileViewport = isMobile;
    syncDeviceViewSwitchUi();
    syncDevicesPanelModeClass();
}

function getSyslogTypeFilter() {
    try {
        const saved = sessionStorage.getItem(SYSLOG_TYPE_FILTER_KEY);
        if (SYSLOG_TYPE_FILTERS.has(saved)) {
            if (saved === 'emby' && !embyFeatureEnabled) return 'system';
            return saved;
        }
    } catch (e) { /* ignore */ }
    return 'system';
}

function setSyslogTypeFilter(type) {
    let next = SYSLOG_TYPE_FILTERS.has(type) ? type : 'system';
    if (next === 'emby' && !embyFeatureEnabled) {
        next = 'system';
    }
    try {
        sessionStorage.setItem(SYSLOG_TYPE_FILTER_KEY, next);
    } catch (e) { /* ignore */ }
    return next;
}

function syncSyslogFilterUi() {
    const syslogType = getSyslogTypeFilter();
    const select = document.getElementById('syslogDeviceType');
    if (select) {
        const embyOption = select.querySelector('option[value="emby"]');
        if (embyOption) {
            embyOption.hidden = !embyFeatureEnabled;
            embyOption.disabled = !embyFeatureEnabled;
        }
        if (syslogType === 'emby' && !embyFeatureEnabled) {
            setSyslogTypeFilter('system');
        }
        select.value = getSyslogTypeFilter();
        select.disabled = false;
    }
    if (typeof syncPlatformPanelUi === 'function') {
        syncPlatformPanelUi('syslogs');
    }
}

function getDeviceTypeFilter() {
    if (!embyFeatureEnabled) return 'qb';
    try {
        const saved = sessionStorage.getItem(DEVICE_TYPE_FILTER_KEY);
        if (saved === 'emby') return 'emby';
        if (saved === 'qb') return 'qb';
    } catch (e) { /* ignore */ }
    return '';
}

function setDeviceTypeFilter(type) {
    const next = type === 'emby' ? 'emby' : (type === 'qb' ? 'qb' : '');
    try {
        if (next) {
            sessionStorage.setItem(DEVICE_TYPE_FILTER_KEY, next);
        } else {
            sessionStorage.removeItem(DEVICE_TYPE_FILTER_KEY);
        }
    } catch (e) { /* ignore */ }
    return next;
}

function deviceTypeSelectHasPlaceholder(select) {
    return !!select?.querySelector('option[value=""]');
}

function syncDeviceTypeSelectValue(select, filter) {
    if (!select) return;
    select.value = deviceTypeSelectHasPlaceholder(select) ? filter : (filter || 'qb');
}

function getDeviceViewMode() {
    if (!embyFeatureEnabled) return 'qb';
    const canonical = normalizeDeviceViewMode(deviceViewMode);
    if (!isMobileViewport()) return canonical;
    if (canonical === 'merge') {
        return getMobileDeviceViewFallback();
    }
    return canonical === 'emby' ? 'emby' : 'qb';
}

function persistDeviceViewMode(mode) {
    const next = String(mode || '').trim().toLowerCase();
    if (!DEVICE_VIEW_MODES.has(next)) return;
    try {
        localStorage.setItem(DEVICE_VIEW_MODE_KEY, next);
    } catch (e) { /* ignore */ }
    persistDeviceViewPreferencesToServer({ device_view_mode: next });
}

function restoreDeviceViewModeFromStorage() {
    if (!embyFeatureEnabled) {
        deviceViewMode = 'qb';
        return;
    }
    try {
        let saved = localStorage.getItem(DEVICE_VIEW_MODE_KEY);
        if (!saved) {
            saved = sessionStorage.getItem(DEVICE_VIEW_MODE_KEY);
            if (saved) {
                localStorage.setItem(DEVICE_VIEW_MODE_KEY, saved);
                sessionStorage.removeItem(DEVICE_VIEW_MODE_KEY);
            }
        }
        if (saved && DEVICE_VIEW_MODES.has(saved)) {
            deviceViewMode = saved;
            return;
        }
    } catch (e) { /* ignore */ }
    deviceViewMode = normalizeEmbyDefaultDeviceView(embyDefaultDeviceView);
}

function setDeviceViewMode(mode, persistMobile = true) {
    const raw = String(mode || '').trim().toLowerCase();
    const next = DEVICE_VIEW_MODES.has(raw) ? raw : 'qb';

    if (isMobileViewport()) {
        if (next === 'merge') {
            syncDeviceViewSwitchUi();
            return getDeviceViewMode();
        }
        if (next === 'qb' || next === 'emby') {
            if (persistMobile) {
                try {
                    sessionStorage.setItem(MOBILE_DEVICE_VIEW_KEY, next);
                } catch (e) { /* ignore */ }
            }
            if (deviceViewMode !== 'merge') {
                deviceViewMode = next;
            }
            syncDeviceViewSwitchUi();
            return getDeviceViewMode();
        }
    }

    deviceViewMode = next;
    persistDeviceViewMode(next);
    syncDeviceViewSwitchUi();
    return deviceViewMode;
}

function migrateLegacyPlatformState() {
    try {
        const legacyPlatform = sessionStorage.getItem(LEGACY_PLATFORM_KEY);
        if (legacyPlatform === 'emby') {
            setDeviceTypeFilter('emby');
        }
        sessionStorage.removeItem(LEGACY_PLATFORM_KEY);
    } catch (e) { /* ignore */ }
}

function loadDeviceViewModeFromStorage() {
    migrateLegacyPlatformState();
    loadMergeSelectionFromStorage();
}

async function loadDeviceViewPreferences() {
    migrateLegacyPlatformState();
    if (!embyFeatureEnabled) {
        deviceViewMode = 'qb';
        return;
    }

    let serverPrefs = null;
    try {
        const res = await axios.get('/api/user/prefs/devices');
        if (res.data?.success) {
            serverPrefs = res.data.data || {};
        }
    } catch (e) { /* ignore */ }

    if (!isEmptyServerDevicePrefs(serverPrefs)) {
        applyDeviceViewPreferencesFromData(serverPrefs);
        syncDeviceViewPreferencesToLocalCache();
        return;
    }

    loadMergeSelectionFromStorage();
    restoreDeviceViewModeFromStorage();
    if (hasLocalDevicePrefs()) {
        persistDeviceViewPreferencesToServer(buildDevicePrefsPayload());
    }
}

function applyDevicesTabEntryView() {
    if (!embyFeatureEnabled) {
        deviceViewMode = 'qb';
        persistDeviceViewMode('qb');
        return;
    }
    deviceViewMode = normalizeEmbyDefaultDeviceView(embyDefaultDeviceView);
    persistDeviceViewMode(deviceViewMode);
}

let isBootTabSwitch = true;

function handleDevicesTabViewOnSwitch() {
    if (!embyFeatureEnabled) {
        deviceViewMode = 'qb';
        return;
    }
    if (isBootTabSwitch) {
        restoreDeviceViewModeFromStorage();
    } else {
        applyDevicesTabEntryView();
    }
}

function normalizeEmbyDefaultDeviceView(mode) {
    const value = String(mode || '').trim().toLowerCase();
    if (value === 'merge') return 'merge';
    return value === 'emby' ? 'emby' : 'qb';
}

function applyEmbyFeatureConfig(globalData) {
    const g = globalData || {};
    embyFeatureEnabled = !!g.emby_enabled;
    embyDefaultDeviceView = normalizeEmbyDefaultDeviceView(g.emby_default_device_view);
    embyInstanceCount = Number(g.emby_instance_count) || 0;
    embyFeatureLocked = !!g.emby_feature_locked;
    resetDevicesPanelDataReady();
    if (!embyFeatureEnabled) {
        deviceViewMode = 'qb';
        setDeviceTypeFilter('qb');
        markDevicesPanelDataReady('emby');
    }
    document.documentElement.classList.toggle('emby-feature-enabled', embyFeatureEnabled);
    applyEmbyFeatureUi();
}

async function fetchEmbyFeatureConfig() {
    try {
        const res = await axios.get('/api/config/global');
        if (res.data?.success) {
            applyEmbyFeatureConfig(res.data.data);
            await loadDeviceViewPreferences();
            syncViewportDeviceViewMode();
            applyEmbyFeatureUi();
            return res.data.data;
        }
    } catch (e) { /* ignore */ }
    applyEmbyFeatureConfig({});
    await loadDeviceViewPreferences();
    syncViewportDeviceViewMode();
    applyEmbyFeatureUi();
    return null;
}

function applyEmbyFeatureUi() {
    const embyStatsRow = document.getElementById('topbarStatsEmby');
    if (embyStatsRow) {
        embyStatsRow.hidden = !embyFeatureEnabled;
        embyStatsRow.setAttribute('aria-hidden', embyFeatureEnabled ? 'false' : 'true');
    }
    document.documentElement.classList.toggle('emby-feature-enabled', embyFeatureEnabled);
    syncDeviceViewSwitchUi();
    syncDeviceTypeFilterControls();
    if (typeof syncSyslogFilterUi === 'function') {
        syncSyslogFilterUi();
    }
    syncDevicesPanelModeClass();
    if (typeof currentTab !== 'undefined' && currentTab === 'stats'
        && typeof syncChartPlatformUi === 'function') {
        syncChartPlatformUi();
    }
    if (typeof currentTab !== 'undefined' && currentTab !== 'devices') {
        syncPlatformPanelUi(currentTab);
    }
}

function syncDevicesPanelModeClass() {
    const panel = document.getElementById('tab-devices');
    if (!panel) return;
    panel.classList.remove(
        'devices-view-mode-qb',
        'devices-view-mode-emby',
        'devices-view-mode-merge',
    );
    if (!embyFeatureEnabled) {
        panel.classList.add('devices-view-mode-qb');
        return;
    }
    const mode = getDeviceViewMode();
    panel.classList.add(`devices-view-mode-${mode}`);
}

function clearDevicesContainer(container) {
    if (container) container.innerHTML = '';
}

function buildQbDevicesEmptyHtml() {
    return '<div class="empty-tip empty-tip--qb">暂无 qB 设备，点击导航栏「添加设备」进行配置</div>';
}

function buildEmbyDevicesEmptyHtml() {
    return '<div class="empty-tip empty-tip--emby">暂无 Emby 设备，点击导航栏「添加设备」进行配置</div>';
}

function syncDeviceViewSwitchUi() {
    const wrap = document.getElementById('deviceViewSwitch');
    if (!wrap) return;
    const show = embyFeatureEnabled && typeof currentTab !== 'undefined' && currentTab === 'devices';
    wrap.hidden = !show;
    wrap.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (!show) {
        closeMergeDevicesPopover();
        return;
    }

    const mode = getDeviceViewMode();
    wrap.dataset.viewMode = mode;
    const mobile = isMobileViewport();
    wrap.querySelectorAll('[data-device-view]').forEach(btn => {
        const value = btn.dataset.deviceView;
        const active = value === mode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const editWrap = document.getElementById('deviceMergeEditWrap');
    const editBtn = document.getElementById('deviceMergeEditBtn');
    if (editWrap) {
        const showEdit = !mobile;
        editWrap.hidden = !showEdit;
        editWrap.setAttribute('aria-hidden', showEdit ? 'false' : 'true');
        if (!showEdit) closeMergeDevicesPopover();
    }
    if (editBtn) {
        const mergeActive = mode === 'merge';
        editBtn.classList.toggle('active', mergeActive);
        editBtn.setAttribute('aria-pressed', mergeActive ? 'true' : 'false');
    }
}

function syncDeviceTypeFilterControls() {
    const filter = getDeviceTypeFilter();
    document.querySelectorAll('[data-device-type-filter]').forEach(select => {
        const wrap = select.closest('.chart-control--device-type, .events-control--device-type, .syslogs-control--device-type');
        if (!embyFeatureEnabled) {
            syncDeviceTypeSelectValue(select, 'qb');
            select.disabled = true;
            if (wrap) wrap.hidden = true;
            return;
        }
        if (wrap) wrap.hidden = false;
        select.disabled = false;
        syncDeviceTypeSelectValue(select, filter);
    });
}

function setEventInstanceFilter(service, instanceName) {
    const deviceType = service === 'emby' ? 'emby' : 'qb';
    const selectId = deviceType === 'emby' ? 'embyEventInstance' : 'eventInstance';
    const select = document.getElementById(selectId);
    if (!select) return deviceType;
    if (instanceName) {
        const exists = Array.from(select.options).some(opt => opt.value === instanceName);
        if (!exists) {
            select.add(new Option(instanceName, instanceName));
        }
        select.value = instanceName;
    } else {
        select.value = '';
    }
    return deviceType;
}

function openDeviceEvents(service, instanceName) {
    const deviceType = service === 'emby' ? 'emby' : 'qb';
    if (embyFeatureEnabled && typeof setDeviceTypeFilter === 'function') {
        setDeviceTypeFilter(deviceType);
        document.querySelectorAll('[data-device-type-filter]').forEach(sel => {
            syncDeviceTypeSelectValue(sel, deviceType);
        });
    }
    setEventInstanceFilter(deviceType, instanceName);
    if (typeof switchTab === 'function') {
        switchTab('events');
    }
}

function setChartInstanceFilter(service, instanceName) {
    const deviceType = service === 'emby' ? 'emby' : 'qb';
    if (embyFeatureEnabled && typeof setDeviceTypeFilter === 'function') {
        setDeviceTypeFilter(deviceType);
        document.querySelectorAll('[data-device-type-filter]').forEach(sel => {
            syncDeviceTypeSelectValue(sel, deviceType);
        });
    }
    if (instanceName && typeof getChartInstanceStorageKey === 'function') {
        try {
            sessionStorage.setItem(getChartInstanceStorageKey(deviceType), instanceName);
        } catch (e) { /* ignore */ }
    }
    if (typeof syncChartInstanceSelectForPlatform === 'function') {
        syncChartInstanceSelectForPlatform();
    }
    const chartSel = document.getElementById('chartInstance');
    if (!chartSel) return deviceType;
    if (instanceName) {
        const exists = Array.from(chartSel.options).some(opt => opt.value === instanceName);
        if (!exists) {
            chartSel.add(new Option(instanceName, instanceName));
        }
        chartSel.value = instanceName;
        if (typeof getChartInstanceStorageKey === 'function') {
            try {
                sessionStorage.setItem(getChartInstanceStorageKey(deviceType), instanceName);
            } catch (e) { /* ignore */ }
        }
    }
    return deviceType;
}

function openDeviceChart(service, instanceName) {
    setChartInstanceFilter(service, instanceName);
    if (typeof switchTab === 'function') {
        switchTab('stats');
    }
}

function onDeviceViewSwitch(mode) {
    if (!embyFeatureEnabled) return;
    closeMergeDevicesPopover();
    setDeviceViewMode(mode);
    syncDevicesPanelModeClass();
    const nextMode = getDeviceViewMode();
    if ((nextMode === 'emby' || nextMode === 'merge')
        && typeof ensureEmbyDataLoaded === 'function') {
        ensureEmbyDataLoaded(true).then(() => {
            if (typeof renderDevicesPanel === 'function') renderDevicesPanel(true);
        });
        return;
    }
    if (typeof renderDevicesPanel === 'function') {
        renderDevicesPanel(true);
    }
}

async function refreshEmbyFeatureLockState() {
    if (typeof fetchEmbyFeatureConfig !== 'function') return;
    await fetchEmbyFeatureConfig();
}

function syncPlatformPanelUi(tab) {
    if (!tab || tab === 'devices') return;
    const root = document.getElementById(`tab-${tab}`);
    if (!root) return;
    const platform = tab === 'syslogs'
        ? getSyslogTypeFilter()
        : getDeviceTypeFilter();
    root.querySelectorAll('[data-platform-panel]').forEach(el => {
        const panelType = el.dataset.platformPanel;
        let show;
        if (tab === 'stats' && !platform) {
            show = panelType === 'qb';
        } else {
            show = platform ? panelType === platform : false;
        }
        el.hidden = !show;
        el.setAttribute('aria-hidden', show ? 'false' : 'true');
    });
}

function onDeviceTypeFilterChange(selectEl) {
    if (!selectEl || !embyFeatureEnabled) return;
    const next = setDeviceTypeFilter(selectEl.value);
    document.querySelectorAll('[data-device-type-filter]').forEach(sel => {
        syncDeviceTypeSelectValue(sel, next);
    });
    if (typeof persistChartControls === 'function') {
        persistChartControls();
    }
    if (typeof chartFullscreenActive !== 'undefined' && chartFullscreenActive
        && typeof exitChartFullscreen === 'function') {
        exitChartFullscreen();
    }
    if (next === '') {
        if (typeof showChartArea === 'function') showChartArea(false);
        if (typeof destroyTrafficCharts === 'function') destroyTrafficCharts();
    } else {
        if (typeof destroyTrafficCharts === 'function') destroyTrafficCharts();
        if (typeof syncChartPlatformUi === 'function') syncChartPlatformUi();
        if (typeof resetChartToFirstQuickRange === 'function') {
            resetChartToFirstQuickRange({ skipUpdate: true });
        } else if (typeof resetQbChartToFirstQuickRange === 'function') {
            resetQbChartToFirstQuickRange();
        }
    }
    if (typeof currentTab !== 'undefined') {
        syncPlatformPanelUi(currentTab);
        switchTab(currentTab);
    }
}

function resolveContentPlatform(tab) {
    if (!embyFeatureEnabled) return 'qb';
    if (tab === 'devices') {
        const mode = getDeviceViewMode();
        if (mode === 'merge') return 'merge';
        return mode === 'emby' ? 'emby' : 'qb';
    }
    const filter = getDeviceTypeFilter();
    return filter === 'emby' ? 'emby' : 'qb';
}

function resolveQbCardsContainer() {
    const mode = typeof getDeviceViewMode === 'function' ? getDeviceViewMode() : 'qb';
    if (mode === 'merge') {
        return document.getElementById('instanceCards');
    }
    return document.getElementById('instanceCardsSingle');
}

function resolveEmbyCardsContainer() {
    const mode = typeof getDeviceViewMode === 'function' ? getDeviceViewMode() : 'emby';
    if (mode === 'merge') {
        return document.getElementById('embyInstanceCardsMerge');
    }
    return document.getElementById('instanceCardsSingle');
}

function renderDevicesPanel(forceFull = false) {
    const mode = typeof getDeviceViewMode === 'function' ? getDeviceViewMode() : 'qb';
    const mergeLayout = document.getElementById('devicesMergeLayout');
    const singleLayout = document.getElementById('devicesSingleLayout');
    const mergeQb = document.getElementById('instanceCards');
    const mergeEmby = document.getElementById('embyInstanceCardsMerge');
    const single = document.getElementById('instanceCardsSingle');
    syncDevicesPanelModeClass();

    if (mergeLayout && singleLayout) {
        const isMerge = mode === 'merge';
        mergeLayout.hidden = !isMerge;
        singleLayout.hidden = isMerge;
        mergeLayout.setAttribute('aria-hidden', isMerge ? 'false' : 'true');
        singleLayout.setAttribute('aria-hidden', isMerge ? 'true' : 'false');
    }

    if (mode === 'merge') {
        clearDevicesContainer(single);
        const qbNames = getQbInstanceNames();
        const embyNames = getEmbyInstanceNames();
        const bothReady = isDevicesPanelDataReady();

        if (!bothReady) {
            const qbInstances = devicesPanelDataReady.qb ? getFilteredQbInstancesForMerge() : [];
            const embyInstances = devicesPanelDataReady.emby ? getFilteredEmbyInstancesForMerge() : [];
            if (typeof renderInstanceCards === 'function') {
                renderInstanceCards(qbInstances, forceFull);
            }
            if (typeof renderEmbyInstanceCards === 'function') {
                renderEmbyInstanceCards(embyInstances, forceFull);
            }
            return;
        }

        if (!qbNames.length && !embyNames.length) {
            if (typeof renderInstanceCards === 'function') {
                renderInstanceCards([], forceFull);
            }
            if (typeof renderEmbyInstanceCards === 'function') {
                renderEmbyInstanceCards([], forceFull);
            }
            return;
        }

        if (!qbNames.length || !embyNames.length) {
            setDeviceViewMode(qbNames.length ? 'qb' : 'emby');
            syncDevicesPanelModeClass();
            renderDevicesPanel(forceFull);
            return;
        }

        const qbInstances = getFilteredQbInstancesForMerge();
        const embyInstances = getFilteredEmbyInstancesForMerge();
        if (!qbInstances.length || !embyInstances.length) {
            setDeviceViewMode(qbNames.length ? 'qb' : 'emby');
            syncDevicesPanelModeClass();
            renderDevicesPanel(forceFull);
            return;
        }
        if (typeof renderInstanceCards === 'function') {
            renderInstanceCards(qbInstances, forceFull);
        }
        if (typeof renderEmbyInstanceCards === 'function') {
            renderEmbyInstanceCards(embyInstances, forceFull);
        }
        if (typeof scheduleSyncMergeViewCardHeights === 'function') {
            scheduleSyncMergeViewCardHeights();
        }
        return;
    }

    clearDevicesContainer(mergeQb);
    clearDevicesContainer(mergeEmby);

    if (mode === 'emby') {
        if (typeof renderEmbyInstanceCards === 'function') {
            renderEmbyInstanceCards(cachedEmbyInstances, forceFull);
        }
        return;
    }

    if (typeof renderInstanceCards === 'function') {
        renderInstanceCards(cachedInstances, forceFull);
    }
}

function applyUnifiedTabPanels(tab) {
    const platform = resolveContentPlatform(tab);
    currentPlatform = platform === 'emby' ? 'emby' : (platform === '' ? '' : 'qb');
    document.querySelectorAll('.nav-tab[data-tab]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.remove('active');
    });

    if (tab === 'devices') {
        document.getElementById('tab-devices')?.classList.add('active');
        return platform;
    }

    document.getElementById(`tab-${tab}`)?.classList.add('active');
    syncPlatformPanelUi(tab);
    return platform;
}

async function refreshEventsLog() {
    const platform = document.getElementById('eventDeviceType')?.value
        || (typeof getDeviceTypeFilter === 'function' ? getDeviceTypeFilter() : 'qb')
        || 'qb';
    if (platform === 'emby' && typeof loadEmbyEvents === 'function') {
        await loadEmbyEvents();
        return;
    }
    if (typeof loadEvents === 'function') {
        await loadEvents();
    }
}

async function refreshSystemLogs() {
    if (typeof loadSyslogsForCurrentType === 'function') {
        await loadSyslogsForCurrentType();
    }
}

async function refreshTrafficChart() {
    if (typeof updateChart === 'function') {
        await updateChart();
    }
}

function loadUnifiedTabContent(tab, platform) {
    if (tab === 'devices') {
        renderDevicesPanel(true);
        if (platform === 'merge' || platform === 'emby') {
            if (typeof ensureEmbyDataLoaded === 'function') {
                ensureEmbyDataLoaded(true);
            }
        }
        return;
    }
    if (tab === 'stats' && !platform) {
        if (typeof showChartArea === 'function') showChartArea(false);
        if (typeof destroyTrafficCharts === 'function') destroyTrafficCharts();
        return;
    }
    if (tab === 'stats') {
        const loadStats = async () => {
            if (typeof syncChartPlatformUi === 'function') await syncChartPlatformUi();
            if (typeof ensureChartPlaybackUserReady === 'function') {
                await ensureChartPlaybackUserReady();
            }
            const hasInstance = !!document.getElementById('chartInstance')?.value;
            if (hasInstance && typeof updateChart === 'function') {
                await updateChart();
            } else if (typeof showChartArea === 'function') {
                showChartArea(false);
                if (typeof destroyTrafficCharts === 'function') destroyTrafficCharts();
            }
        };
        if (platform === 'emby' && typeof ensureEmbyDataLoaded === 'function') {
            ensureEmbyDataLoaded(true).then(() => loadStats());
        } else {
            loadStats();
        }
        return;
    }
    if (tab === 'syslogs') {
        if (typeof syncSyslogFilterUi === 'function') {
            syncSyslogFilterUi();
        }
        const load = () => {
            if (typeof loadSyslogsForCurrentType === 'function') {
                loadSyslogsForCurrentType();
            }
        };
        const syslogType = getSyslogTypeFilter();
        if (syslogType === 'emby' && typeof ensureEmbyDataLoaded === 'function') {
            ensureEmbyDataLoaded(true).then(load);
        } else {
            load();
        }
        return;
    }
    if (platform === 'emby') {
        const loadEventsTab = () => {
            if (tab === 'events' && typeof loadEmbyEvents === 'function') {
                loadEmbyEvents();
            }
        };
        if (typeof ensureEmbyDataLoaded === 'function') {
            ensureEmbyDataLoaded(true).then(loadEventsTab);
        } else {
            loadEventsTab();
        }
        return;
    }
    if (tab === 'events' && typeof loadEvents === 'function') {
        loadEvents();
    }
}

function openAddDeviceChooser() {
    if (!embyFeatureEnabled) {
        if (typeof openAddInstance === 'function') openAddInstance();
        return;
    }
    const modal = document.getElementById('confirmModal');
    if (!modal) {
        if (typeof openAddInstance === 'function') openAddInstance();
        return;
    }
    document.getElementById('confirmModalTitle').textContent = '添加设备';
    document.getElementById('confirmModalBody').innerHTML = `
        <div class="modal-form modal-form--confirm modal-form--device-chooser">
            <p class="confirm-message">请选择要添加的设备类型</p>
            <div class="device-chooser-actions">
                <button type="button" class="device-chooser-card device-chooser-card--qb" id="chooseAddQbBtn">
                    <span class="device-chooser-card-icon" aria-hidden="true">
                        <svg viewBox="0 0 20 20" fill="none"><path d="M10 3v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 6l3-3 3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 14h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M6 17h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
                    </span>
                    <span class="device-chooser-card-body">
                        <span class="device-chooser-card-title">qB 设备</span>
                        <span class="device-chooser-card-desc">qBittorrent 下载器</span>
                    </span>
                </button>
                <button type="button" class="device-chooser-card device-chooser-card--emby" id="chooseAddEmbyBtn">
                    <span class="device-chooser-card-icon" aria-hidden="true">
                        <svg viewBox="0 0 20 20" fill="none"><rect x="3" y="4.5" width="14" height="9.5" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 8.2v3.6l3.8-1.8-3.8-1.8z" fill="currentColor"/></svg>
                    </span>
                    <span class="device-chooser-card-body">
                        <span class="device-chooser-card-title">Emby 设备</span>
                        <span class="device-chooser-card-desc">Emby 媒体服务器</span>
                    </span>
                </button>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-secondary" id="cancelDeviceChooserBtn">✖ 取消</button>
            </div>
        </div>`;
    document.getElementById('chooseAddQbBtn').onclick = () => {
        if (typeof closeConfirmModal === 'function') closeConfirmModal();
        if (typeof openAddInstance === 'function') openAddInstance();
    };
    document.getElementById('chooseAddEmbyBtn').onclick = () => {
        if (typeof closeConfirmModal === 'function') closeConfirmModal();
        if (typeof openAddEmbyInstance === 'function') openAddEmbyInstance();
    };
    document.getElementById('cancelDeviceChooserBtn').onclick = () => {
        if (typeof closeConfirmModal === 'function') closeConfirmModal();
    };
    modal.style.display = 'block';
}

function bindGlobalEmbySettingsSection() {
    const enabledInput = document.getElementById('globalEmbyEnabled');
    const defaultWrap = document.getElementById('globalEmbyDefaultViewWrap');
    const defaultSelect = document.getElementById('globalEmbyDefaultView');
    if (!enabledInput) return;

    let embyWasEnabled = enabledInput.checked;

    function syncEmbySettingsFields() {
        const enabled = enabledInput.checked;
        if (defaultWrap) {
            defaultWrap.hidden = !enabled;
            defaultWrap.setAttribute('aria-hidden', enabled ? 'false' : 'true');
        }
        if (defaultSelect) defaultSelect.disabled = !enabled;
        if (embyFeatureLocked) {
            enabledInput.disabled = true;
        }
    }

    enabledInput.onchange = () => {
        if (enabledInput.checked && !embyWasEnabled && defaultSelect) {
            defaultSelect.value = 'merge';
        }
        if (enabledInput.checked) {
            embyWasEnabled = true;
        }
        syncEmbySettingsFields();
    };
    syncEmbySettingsFields();
}

window.addEventListener('resize', () => {
    if (!embyFeatureEnabled) return;
    syncViewportDeviceViewMode();
    if (typeof currentTab !== 'undefined' && currentTab === 'devices') {
        const mode = typeof getDeviceViewMode === 'function' ? getDeviceViewMode() : 'qb';
        if (mode === 'merge') {
            if (typeof scheduleSyncMergeViewCardHeightsDebounced === 'function') {
                scheduleSyncMergeViewCardHeightsDebounced(150);
            }
        } else if (typeof renderDevicesPanel === 'function') {
            renderDevicesPanel(true);
        }
    }
});

(function setupMobileViewportDeviceViewSync() {
    const mq = window.matchMedia('(max-width: 992px)');
    const onChange = (event) => {
        if (!embyFeatureEnabled) return;
        syncViewportDeviceViewMode(event.matches);
        if (typeof currentTab !== 'undefined' && currentTab === 'devices'
            && typeof renderDevicesPanel === 'function') {
            renderDevicesPanel(true);
        }
    };
    if (mq.addEventListener) {
        mq.addEventListener('change', onChange);
    } else if (mq.addListener) {
        mq.addListener(onChange);
    }
})();
