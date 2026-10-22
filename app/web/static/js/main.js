/* 入口：启动、导航、事件绑定、定时刷新 */

import './fulltip.js';
import './totop.js';
import * as api from './api.js';
import { exportLogs, loadMoreLogs, logListHtml } from './syslogs.js';
import {
    state, loadGlobal, loadPrefs, loadStatus, navCollapsed, pageSnapshot, pickLanding, refreshLive,
    rememberPage, restorePage, savePrefs, syncMerge,
} from './store.js';
import {
    fixRoute, isListView, rememberPart, render, refreshLogsInPlace, revealSection, syncDetailFold, toggleMetricsDock, toggleNavGroup, togglePadSide,
} from './shell.js';
import { uiClick, uiInput, relockTiles } from './interact.js';
import { toggleReveal } from './cards.js';
import { openSettings } from './settings.js';
import { toggleScheme } from './theme.js';
import { openChooser } from './dialogs.js';
import { normalizeDayRange, normalizeMonthRange, parseDay, parseMonth, quickPreset, visibleDayRange, visibleMonthRange } from './stats_data.js';
import { bindRangePicker, closeRangePicker } from './range_picker.js';
import { chartOrderPref, moveChartBlock } from './stats.js';
import {
    $, closeDrawer, closeModal, closeSheet, isPad, isPhone, toast,
} from './ui.js';

const pad = n => String(n).padStart(2, '0');

/* ---------- 导航：视图（合并 / qB / Emby / 日志）+ 设备 ---------- */
const route = () => pageSnapshot();

function resetFilters() {
    Object.assign(state, {
        statsDevice: '', statsUser: '', statsDate: '', statsFrom: '', eventsDevice: '', eventsUser: '', eventsType: 'all',
    });
}

function setGroupOpen(kind, open) {
    const list = navCollapsed();
    if (open === !list.includes(kind)) return;
    savePrefs({ nav_collapsed: open ? list.filter(k => k !== kind) : [...list, kind] });
    toggleNavGroup(kind, open);
}

/** 切换页面 */
function go(patch, { replace = false } = {}) {
    const before = `${state.view}|${state.dev}`;
    Object.assign(state, patch);
    if (`${state.view}|${state.dev}` === before && !replace) { closeDrawer(); return; }
    if (`${state.view}|${state.dev}` !== before) resetFilters();
    if (state.view === 'qb' || state.view === 'emby') setGroupOpen(state.view, true);
    history[replace ? 'replaceState' : 'pushState'](route(), '');
    closeDrawer();
    render();
    if (!replace) window.scrollTo({ top: 0 });
}

function openDevice(kind, dev, focus) {
    if (focus === 'chart' || focus === 'events') state.detailTab = focus;
    const same = state.view === kind && state.dev === dev;
    if (same) {
        closeDrawer();
        document.body.dataset.detailTab = state.detailTab || 'card';
        document.querySelectorAll('#detailTabs [data-detail-tab]').forEach(el => el.classList.toggle('active', el.dataset.detailTab === state.detailTab));
        rememberPage();
        revealSection(focus);
        return;
    }
    state.focus = focus || '';
    go({ view: kind, dev });
}

/* ---------- 点击 ---------- */
document.addEventListener('click', e => {
    if (e.target.closest('.rp-pop, [data-range-open]')) return;
    const t = e.target.closest('button, .switch, .chk, .me-item, [data-lucky], [data-close], [data-lim-mode], [data-hidelan], [data-open-dev]');
    if (!t) return;
    if (t.dataset.reveal) { toggleReveal(t.dataset.reveal); render(); return; }
    const ctx = { render: () => render() };
    if (t.closest('[data-hidelan]')) { state.eventsHideLan = !state.eventsHideLan; render(); return; }
    if (uiClick(t, e, ctx)) return;
    if (t.dataset.navToggle) { const k = t.dataset.navToggle; setGroupOpen(k, navCollapsed().includes(k)); return; }
    if (t.dataset.nav && ['qb', 'emby', 'merge', 'syslogs'].includes(t.dataset.nav)) {
        if (isPhone() && t.dataset.nav === 'merge') return;
        if (isPhone() && !t.dataset.dev && (t.dataset.nav === 'qb' || t.dataset.nav === 'emby')) {
            setGroupOpen(t.dataset.nav, navCollapsed().includes(t.dataset.nav));
            return;
        }
        if (t.dataset.dev) openDevice(t.dataset.nav, t.dataset.dev);
        else go({ view: t.dataset.nav, dev: '' });
        return;
    }
    if (t.dataset.bar) { go({ view: t.dataset.bar === 'syslogs' ? 'syslogs' : state.lastList, dev: '' }); return; }
    if (t.dataset.open === 'add') { closeDrawer(); openChooser(); return; }
    if (t.id === 'themeBtn') { toggleScheme(); return; }
    if (t.dataset.open === 'settings') { closeDrawer(); openSettings(); return; }
    if (t.dataset.goto) { openDevice(t.dataset.kind, t.dataset.dev, t.dataset.goto); return; }
    if (t.hasAttribute('data-open-dev')) { openDevice(t.dataset.kind, t.dataset.dev); return; }
    if (t.dataset.feed) { state.feedOpen[t.dataset.feed] = !state.feedOpen[t.dataset.feed]; render(); return; }
    if (t.dataset.fold) { state.detailFold[t.dataset.fold] = !state.detailFold[t.dataset.fold]; syncDetailFold(); return; }
    if (t.hasAttribute('data-block-swap')) {
        const order = moveChartBlock(t);
        if (!order) return;
        const sec = document.getElementById('sec-chart');
        if (sec) rememberPart('chart', sec.innerHTML.replace(/\sdata-bound="1"/g, ''));
        const patch = chartOrderPref(order);
        if (patch) savePrefs(patch);
        return;
    }
    if (t.dataset.detailTab) {
        state.detailTab = t.dataset.detailTab;
        rememberPage();
        document.body.dataset.detailTab = state.detailTab;
        document.querySelectorAll('#detailTabs [data-detail-tab]').forEach(el => el.classList.toggle('active', el.dataset.detailTab === state.detailTab));
        window.scrollTo({ top: 0 });
        return;
    }
    if (t.id === 'backBtn') { go({ dev: '' }); return; }
    if (t.id === 'metricsSplit') { toggleMetricsDock(); return; }
    if (t.dataset.quick) {
        const [mode, which] = t.dataset.quick.split(':');
        if ((mode !== 'day' && mode !== 'month') || (which !== 'prev' && which !== 'cur')) return;
        const saved = quickPreset(mode, which);
        const before = mode === 'month' ? visibleMonthRange() : visibleDayRange();
        if (state.statsRange === mode && saved.start === before.start && saved.end === before.end) return;
        state.statsRange = mode;
        state.statsChartRange = mode;
        state.statsFrom = saved.start;
        state.statsDate = saved.end;
        if (mode === 'month' && state.statsSpan === 'all') state.statsSpan = '6';
        render();
        return;
    }
    if (t.closest('[data-range]') && t.dataset.r) {
        const next = t.dataset.r;
        if (next === 'day' || next === 'month') {
            state.statsChartRange = next;
            state.statsDate = '';
            state.statsFrom = '';
        }
        state.statsRange = next;
        render();
        return;
    }
    if (t.closest('[data-evtype]')) { state.eventsType = t.dataset.v; render(); return; }
    if (t.closest('[data-logsrc]')) { state.logSrc = t.dataset.v; render(); return; }
    if (t.closest('[data-loglv]')) { state.logLv = t.dataset.v; render(); return; }
    if (t.hasAttribute('data-hidelan')) { state.eventsHideLan = !state.eventsHideLan; render(); return; }
    if (t.hasAttribute('data-log-export')) { exportLogs(state.logLv, state.logQuery); return; }
    if (t.hasAttribute('data-log-more')) { loadMoreLogs(); return; }
    if (t.hasAttribute('data-close') || t.id === 'modal') closeModal();
    if (t.classList.contains('logout')) logout();
});

async function logout() {
    try { await api.post('/api/auth/logout'); } catch (e) { /* 退出失败也回登录页 */ }
    window.location.replace('/login');
}

/* ---------- 下拉与输入 ---------- */
document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'stUser') { state.statsUser = t.value === '__all_users__' ? '' : t.value; render(); }
    else if (t.id === 'evUser') { state.eventsUser = t.value; render(); }
    else if (t.id === 'evDays') { state.eventsDays = +t.value; render(); }
});

let queryTimer = 0;
document.addEventListener('input', e => {
    uiInput(e);
    if (e.target.id === 'logQuery') {
        state.logQuery = e.target.value;
        clearTimeout(queryTimer);
        queryTimer = setTimeout(() => { $('#logList').innerHTML = logListHtml(state.logLv, state.logQuery); }, 120);
    }
});

document.addEventListener('mousedown', e => {
    if (e.target.closest('[data-range-open], .rp-pop')) e.preventDefault();
});
document.addEventListener('focusout', e => {
    const id = e.target.id;
    if (id !== 'stFrom' && id !== 'stTo') return;
    setTimeout(() => {
        if (document.activeElement?.closest?.('.range-field')) return;
        commitRange();
    }, 0);
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (document.querySelector('.rp-pop')) { closeRangePicker(true); return; }
        closeModal(); closeSheet(); return;
    }
    if (e.key === 'Enter' && (e.target.id === 'stFrom' || e.target.id === 'stTo')) {
        e.preventDefault();
        e.target.blur();
    }
});

function chartMode() {
    const picked = state.statsRange === 'total' ? (state.statsChartRange || 'day') : state.statsRange;
    return picked === 'month' ? 'month' : 'day';
}

function commitRange() {
    closeRangePicker(false);
    const fromEl = document.getElementById('stFrom');
    const endEl = document.getElementById('stTo');
    if (!fromEl || !endEl) return;
    const month = chartMode() === 'month';
    const before = month ? visibleMonthRange() : visibleDayRange();
    const start = (month ? parseMonth : parseDay)(fromEl.value);
    const end = (month ? parseMonth : parseDay)(endEl.value);
    if (!start || !end) {
        fromEl.value = before.start;
        endEl.value = before.end;
        return;
    }
    const saved = month ? normalizeMonthRange(start, end) : normalizeDayRange(start, end);
    if (saved.start === before.start && saved.end === before.end) {
        fromEl.value = before.start;
        endEl.value = before.end;
        return;
    }
    state.statsFrom = saved.start;
    state.statsDate = saved.end;
    if (month && state.statsSpan === 'all') state.statsSpan = '6';
    render();
}
bindRangePicker(commitRange);
$('#sheetMask').addEventListener('click', closeSheet);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
$('#menuBtn').addEventListener('click', () => document.body.classList.add('drawer'));
$('#sideBtn').addEventListener('click', () => { if (isPad()) togglePadSide(); });
$('#scrim').addEventListener('click', closeDrawer);
let wasMobile = isPhone();
let wasPad = isPad();
window.addEventListener('resize', () => {
    relockTiles();
    const mobile = isPhone();
    const pad = isPad();
    const needDevice = mobile && (state.view === 'merge' || ((state.view === 'qb' || state.view === 'emby') && !state.dev));
    if (needDevice || mobile !== wasMobile || pad !== wasPad) render();
    wasMobile = mobile;
    wasPad = pad;
});
window.addEventListener('popstate', e => {
    if (!e.state) return;
    const before = `${state.view}|${state.dev}`;
    Object.assign(state, e.state);
    if (`${state.view}|${state.dev}` !== before) resetFilters();
    closeDrawer();
    render();
});

/* ---------- 刷新 ---------- */
let busyReload = false;
async function reloadAll(full) {
    if (busyReload) return;
    busyReload = true;
    try {
        if (full) await loadGlobal();
        await loadStatus();
        syncMerge();
        await render({ soft: !full });
    } catch (err) {
        toast(err.message || '刷新失败', 'err');
    } finally { busyReload = false; }
}
document.addEventListener('app:reload', e => reloadAll(e.detail.full));

const editing = () => {
    const a = document.activeElement;
    return a && a.closest('#content') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
};

async function refreshTick() {
    if (busyReload) return;
    try {
        await refreshLive();
        syncMerge();
        if (editing()) return;
        if (state.view === 'syslogs') await refreshLogsInPlace();
        else await render({ soft: true });
    } catch (e) { /* 单次刷新失败不打扰，下个周期再试 */ }
}

/* ---------- 时钟与倒计时 ---------- */
let left = 1;
const period = () => Math.max(1, state.global.refresh_interval || 1);
document.addEventListener('app:interval', () => { left = period(); });

function syncRing() {
    const ring = document.querySelector('.ring');
    const label = document.querySelector('.status-meta b');
    if (!ring || !label) return;
    const live = period() <= 1;
    ring.classList.toggle('breath', live);
    const text = live ? '实时刷新' : '自动刷新';
    let node = [...label.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
    if (!node) label.appendChild(node = document.createTextNode(text));
    else node.textContent = text;
    let dot = ring.querySelector('i') || label.querySelector('i');
    if (!dot) {
        dot = document.createElement('i');
        dot.id = 'liveDot';
    }
    if (live) {
        if (dot.parentElement !== ring) ring.appendChild(dot);
    } else if (dot.parentElement !== label) label.prepend(dot);
}

function tick() {
    const now = new Date();
    $('#clock').textContent = `${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    syncRing();
    if (period() > 1) {
        $('#ringSec').textContent = left;
        $('#ringBar').style.strokeDashoffset = 97.4 * (1 - left / period());
    } else $('#ringBar').style.strokeDashoffset = '';
    if (left <= 1) {
        left = period();
        refreshTick();
    } else left -= 1;
}

/* ---------- 启动 ---------- */
async function boot() {
    try {
        await loadGlobal();
        await loadPrefs();
        await loadStatus();
    } catch (e) {
        toast(e.message || '加载失败', 'err');
    }
    syncMerge();
    if (!restorePage()) {
        const land = pickLanding();
        state.view = land.view;
        state.dev = land.dev || '';
    }
    fixRoute();
    history.replaceState(route(), '');
    state.ready = true;
    left = period();
    await render();
    tick();
    setInterval(tick, 1000);
}
boot();
