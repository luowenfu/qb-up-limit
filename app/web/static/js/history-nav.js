/** 手机 WebView / APK 返回：先关浮层，再退 Tab；栈底拦截返回，不退出应用 */
(function initHistoryNav(global) {
    const KIND = 'qb-up-limit';
    const VALID_TABS = { devices: 1, stats: 1, events: 1, syslogs: 1 };

    let started = false;
    let lastTab = 'devices';
    let applyingHistory = false;

    function normalizeTab(tab) {
        return VALID_TABS[tab] ? tab : 'devices';
    }

    function readHashTab() {
        const raw = String(location.hash || '').replace(/^#\/?/, '').trim();
        return VALID_TABS[raw] ? raw : '';
    }

    function pageHref(tab) {
        return `${location.pathname}${location.search}#/${normalizeTab(tab)}`;
    }

    function tabState(tab, extra) {
        return Object.assign({ k: KIND, t: normalizeTab(tab) }, extra || {});
    }

    function isOurState(state) {
        return !!(state && state.k === KIND);
    }

    function safePush(state, tab) {
        try {
            history.pushState(state, '', pageHref(tab));
        } catch (e) { /* ignore */ }
    }

    function safeReplace(state, tab) {
        try {
            history.replaceState(state, '', pageHref(tab));
        } catch (e) { /* ignore */ }
    }

    function stayOnCurrent() {
        safeReplace(tabState(lastTab, { g: 1 }), lastTab);
        safePush(tabState(lastTab), lastTab);
    }

    function isConfirmOpen() {
        const modal = document.getElementById('confirmModal');
        return !!(modal && modal.style.display === 'block');
    }

    function isControlOpen() {
        const modal = document.getElementById('controlModal');
        return !!(modal && modal.style.display === 'block');
    }

    function closeTopDebugWindow() {
        const wins = Array.from(document.querySelectorAll('.emby-debug-float-window:not([hidden])'));
        if (!wins.length) return false;
        wins.sort((a, b) => (Number(b.style.zIndex) || 0) - (Number(a.style.zIndex) || 0));
        const top = wins[0];
        const name = top.dataset.instance;
        if (typeof closeEmbyDebugFloatWindow === 'function' && name) {
            closeEmbyDebugFloatWindow(name);
        } else {
            top.hidden = true;
        }
        return true;
    }

    function closeTopOverlay() {
        if (document.querySelector('.searchable-select.is-open')) {
            if (global.SearchableSelect) global.SearchableSelect.closeAll();
            return true;
        }
        const merge = document.getElementById('mergeDevicesPopover');
        if (merge && !merge.hidden) {
            if (typeof closeMergeDevicesPopover === 'function') closeMergeDevicesPopover();
            return true;
        }
        if (document.querySelector('.emby-seek-badge-wrap.is-open, .emby-transcode-badge-wrap.is-open')) {
            if (typeof closeEmbySeekBadgePopover === 'function') closeEmbySeekBadgePopover();
            return true;
        }
        if (typeof embyDebugTipPinned !== 'undefined' && embyDebugTipPinned
            && typeof hideEmbyDebugTip === 'function') {
            hideEmbyDebugTip();
            return true;
        }
        if (isConfirmOpen()) {
            if (typeof closeConfirmModal === 'function') closeConfirmModal();
            return true;
        }
        if (isControlOpen()) {
            if (typeof closeModal === 'function') closeModal();
            return true;
        }
        if (document.body.classList.contains('chart-fullscreen-active')
            && typeof exitChartFullscreen === 'function') {
            exitChartFullscreen();
            return true;
        }
        if (closeTopDebugWindow()) return true;
        return false;
    }

    function applyTabFromHistory(tab) {
        lastTab = normalizeTab(tab);
        applyingHistory = true;
        try {
            if (typeof switchTab === 'function') {
                switchTab(lastTab, { fromHistory: true });
            }
        } finally {
            applyingHistory = false;
        }
    }

    function onPopState(event) {
        if (!started) return;
        const state = event.state;

        if (closeTopOverlay()) {
            safePush(tabState(lastTab), lastTab);
            return;
        }

        if (isOurState(state) && !state.g) {
            if (state.t !== lastTab) applyTabFromHistory(state.t);
            else lastTab = normalizeTab(state.t);
            return;
        }

        stayOnCurrent();
    }

    function onTabChange(tab, options) {
        const opts = options || {};
        if (!started || applyingHistory || opts.fromHistory) return;
        const next = normalizeTab(tab);
        const atGuard = isOurState(history.state) && history.state.g;
        if (next === lastTab && !atGuard) return;
        lastTab = next;
        safePush(tabState(next), next);
    }

    function start(tab) {
        if (started) return;
        lastTab = normalizeTab(tab || readHashTab() || lastTab);
        started = true;
        stayOnCurrent();
        window.addEventListener('popstate', onPopState);
    }

    global.HistoryNav = {
        start,
        onTabChange,
        readHashTab,
        closeTopOverlay,
    };
}(window));
