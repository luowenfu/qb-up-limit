/* 流量图表的数据层：按天 / 月取数并整理成图表模型 */

import * as api from './api.js';
import { enc, q } from './api.js';
import { state, embyList, qbList } from './store.js';
import { ymd } from './format.js';

const p2 = n => String(n).padStart(2, '0');
export const ALL_USERS = '__all_users__';

const ym = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
const addMonths = (anchor, n) => {
    const [y, m] = anchor.split('-').map(Number);
    return ym(new Date(y, m - 1 + n, 1));
};
const addDays = (anchor, n) => {
    const [y, m, d] = anchor.split('-').map(Number);
    return ymd(new Date(y, m - 1, d + n));
};

/** 当前统计范围的默认锚点。按天是今天，按月是本月 */
export function defaultAnchor(range) {
    const now = new Date();
    return range === 'month' ? ym(now) : ymd(now);
}

const monthKey = r => {
    if (r.period) return String(r.period);
    const m = r.month;
    if (m != null && String(m).includes('-')) return String(m);
    if (r.year != null && m != null) return `${r.year}-${p2(m)}`;
    return '';
};

/** 手输月份：2026-10、2026/10、2026.10、202610、2026年10月。空字符串表示未填，null 表示无效 */
export function parseMonth(text, max) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const hit = raw.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?$/) || raw.match(/^(\d{4})(\d{2})$/);
    if (!hit) return null;
    const y = +hit[1];
    const m = +hit[2];
    if (y < 2000 || y > 2100 || m < 1 || m > 12) return null;
    let key = `${y}-${p2(m)}`;
    if (key < '2000-01') key = '2000-01';
    if (max && key > max) key = max;
    return key;
}

/** 手输日期：2026-10-10、2026/10/10、20261010、2026年10月10日 */
export function parseDay(text, max) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const hit = raw.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/) || raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!hit) return null;
    const y = +hit[1];
    const m = +hit[2];
    const d = +hit[3];
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    let key = ymd(dt);
    if (key < '2000-01-01') key = '2000-01-01';
    if (max && key > max) key = max;
    return key;
}

function clampMonths(start, end) {
    let from = start > end ? end : start;
    if (addMonths(from, 239) < end) from = addMonths(end, -239);
    const months = [];
    let cur = from;
    while (cur <= end && months.length < 240) {
        months.push(cur);
        cur = addMonths(cur, 1);
    }
    if (!months.length) months.push(end);
    return months;
}

/** 按天的起止日期。没选时从本月 1 日到今天，最长 366 天 */
export function normalizeDayRange(start, end) {
    const today = ymd(new Date());
    let stop = parseDay(end, today) || today;
    let from = parseDay(start, today) || `${stop.slice(0, 7)}-01`;
    if (from > stop) [from, stop] = [stop, from];
    const cap = addDays(stop, -365);
    if (from < cap) from = cap;
    return { start: from, end: stop };
}

/** 按月的起止月份。没选开始月时，从结束月所在年的 1 月算起，默认就是今年 */
export function normalizeMonthRange(start, end) {
    const max = ym(new Date());
    let stop = parseMonth(end, max) || max;
    let from = parseMonth(start, max) || '';
    if (!from) from = `${stop.slice(0, 4)}-01`;
    if (from > stop) [from, stop] = [stop, from];
    const months = clampMonths(from, stop);
    return { start: months[0], end: months[months.length - 1] };
}

export const visibleDayRange = () => normalizeDayRange(state.statsFrom, state.statsDate);
export const visibleMonthRange = () => normalizeMonthRange(state.statsFrom, state.statsDate);

/** 快捷范围。按天是今天、昨天、上一个整月、本月 1 日到今天；按月是今年 1 月到本月、去年全年 */
export function quickPreset(mode, which) {
    const now = new Date();
    const today = ymd(now);
    const thisMonth = ym(now);
    if (mode !== 'month') {
        if (which === 'today') return { start: today, end: today };
        if (which === 'yday') { const y = addDays(today, -1); return { start: y, end: y }; }
        if (which === 'cur') return { start: `${thisMonth}-01`, end: today };
        const prevEnd = addDays(`${thisMonth}-01`, -1);
        return { start: `${prevEnd.slice(0, 7)}-01`, end: prevEnd };
    }
    const year = now.getFullYear();
    if (which === 'cur') return { start: `${year}-01`, end: thisMonth };
    return { start: `${year - 1}-01`, end: `${year - 1}-12` };
}

function daySpec(start, end) {
    const win = normalizeDayRange(start, end);
    const days = [];
    let cur = win.start;
    while (cur <= win.end && days.length < 366) {
        days.push(cur);
        cur = addDays(cur, 1);
    }
    const n = days.length;
    const cross = days[0].slice(0, 4) !== days[n - 1].slice(0, 4);
    return {
        period: 'daily',
        params: { start: days[0], end: days[n - 1] },
        labels: days.map(k => (cross ? k.slice(2) : k.slice(5))),
        keyOf: r => String(r.day || '').slice(0, 10),
        keys: days,
        prev: addDays(days[0], -1),
        prevFrom: addDays(days[0], -n),
        caption: `${days[0]} 至 ${days[n - 1]}`,
    };
}

function monthSpec(start, end) {
    const win = normalizeMonthRange(start, end);
    const months = clampMonths(win.start, win.end);
    const n = months.length;
    const label = k => (n > 6 ? `${k.slice(2, 4)}/${k.slice(5)}` : `${k.slice(5)}月`);
    return {
        period: 'monthly',
        params: { start: months[0], end: months[n - 1] },
        labels: months.map(label),
        keyOf: monthKey,
        keys: months,
        prev: addMonths(months[0], -1),
        prevFrom: addMonths(months[0], -n),
        caption: `${months[0]} 至 ${months[n - 1]}`,
    };
}

/** 全部：从最早有数据的月份画到当前月，中间没有流量的月份补 0 */
function fitMonths(sp, groups) {
    const found = [];
    groups.flat().forEach(r => {
        const k = sp.keyOf(r);
        if (/^\d{4}-\d{2}$/.test(k)) found.push(k);
    });
    found.sort();
    const end = sp.end;
    const start = found.length ? found[0] : end;
    const months = [];
    let cur = start;
    while (cur <= end && months.length < 240) {
        months.push(cur);
        cur = addMonths(cur, 1);
    }
    if (!months.length) months.push(end);
    return {
        ...sp,
        keys: months,
        labels: months.map(k => `${k.slice(2, 4)}/${k.slice(5)}`),
        params: { start: months[0], end: months[months.length - 1] },
    };
}
export function spec(range, anchor, opt) {
    if (range === 'hour') {
        return {
            period: 'hourly',
            params: { start: `${anchor} 00:00`, end: `${anchor} 23:00` },
            labels: Array.from({ length: 24 }, (_, i) => `${p2(i)}:00`),
            keyOf: r => String(r.hour || '').slice(11, 13),
            keys: Array.from({ length: 24 }, (_, i) => p2(i)),
            prev: addDays(anchor, -1),
            caption: anchor,
        };
    }
    const from = opt && Object.prototype.hasOwnProperty.call(opt, 'from') ? opt.from : state.statsFrom;
    if (range === 'day') return daySpec(from, anchor);
    return monthSpec(from, anchor);
}

function fill(sp, rows, field) {
    const map = {};
    (rows || []).forEach(r => { map[sp.keyOf(r)] = (map[sp.keyOf(r)] || 0) + (Number(r[field]) || 0); });
    return sp.keys.map(k => map[k] || 0);
}

const sum = arr => arr.reduce((a, b) => a + b, 0);
const delta = (cur, prev) => (prev > 0 ? (cur - prev) / prev * 100 : null);

/** 事件时间是否落在当前图表所选时段内 */
function inSpan(time, sp) {
    const t = String(time || '');
    if (!t || !sp || !sp.params) return false;
    if (sp.period === 'hourly') return t.slice(0, 10) === String(sp.params.start).slice(0, 10);
    const start = String(sp.params.start);
    const end = String(sp.params.end);
    return t.slice(0, start.length) >= start && t.slice(0, end.length) <= end;
}

async function fetchRows(url, sp, extra) {
    const res = await api.get(`${url}/${sp.period}${q({ ...sp.params, ...extra })}`);
    return res.data || [];
}

/** qB：按累计只读当前种子快照；按天、按月查本项目库 */
export async function loadQbStats(name, range, anchor) {
    if (range === 'total') return loadQbCumulative(name);
    let sp = spec(range, anchor);
    const pv = sp.prev ? spec(range, sp.prev, sp.prevFrom ? { from: sp.prevFrom } : undefined) : null;
    const base = `/api/stats/${enc(name)}`;
    const rankQuery = {
        instance: name, period: sp.period, start: sp.params.start, end: sp.params.end,
    };
    const [up, down, prev, prevDown, events, ranks] = await Promise.all([
        fetchRows(base, sp, { direction: 'upload' }),
        fetchRows(base, sp, { direction: 'download' }),
        pv ? fetchRows(base, pv, { direction: 'upload' }).catch(() => []) : [],
        pv ? fetchRows(base, pv, { direction: 'download' }).catch(() => []) : [],
        api.get(`/api/events${q({ instance: name, limit: 500 })}`).then(r => r.data || []).catch(() => []),
        api.get(`/api/qb/torrent-ranks${q(rankQuery)}`).then(r => r.data || {}).catch(() => ({})),
    ]);
    if (sp.all) sp = fitMonths(sp, [up, down]);
    const a = fill(sp, up, 'total_bytes'), b = fill(sp, down, 'total_bytes');
    const hits = events.filter(e => e.event_type === 'limit_applied' && inSpan(e.event_time, sp)).length;
    return {
        kind: 'qb', sp, a, b, name, hits, cumulative: false,
        torrents: ranks.torrents || [],
        ratios: (ranks.ratios || []).map(asRatioRow),
        sites: ranks.sites || [],
        change: pv ? delta(sum(a), sum(fill(pv, prev, 'total_bytes'))) : null,
        changeDown: pv ? delta(sum(b), sum(fill(pv, prevDown, 'total_bytes'))) : null,
    };
}

/** 按累计：一次 qB 种子列表，给出设备合计和三列排行 */
async function loadQbCumulative(name) {
    let ranks = {};
    try {
        ranks = (await api.get(`/api/qb/torrent-ranks${q({ instance: name, period: 'total' })}`)).data || {};
    } catch (e) { ranks = {}; }
    const available = ranks.available === true;
    const totals = ranks.totals || { uploaded: 0, downloaded: 0, count: 0, ratio: 0 };
    return {
        kind: 'qb', cumulative: true, available, totals, name,
        sp: { caption: '当前累计', labels: [] },
        a: [], b: [], hits: 0,
        torrents: available ? (ranks.torrents || []) : [],
        ratios: available ? (ranks.ratios || []).map(asRatioRow) : [],
        sites: available ? (ranks.sites || []) : [],
        change: null, changeDown: null,
    };
}

/** qB 把无下载量的分享率封顶为 9999，或在旧版本里记成负数 */
function asRatioRow(row) {
    const raw = row && row[1];
    const n = Number(raw);
    const infinite = raw == null || !Number.isFinite(n) || n < 0 || n >= 9999;
    return [row[0], infinite ? Number.POSITIVE_INFINITY : n, Number(row[2]) || 0, Number(row[3]) || 0];
}

/** Emby：播放 + 选片（按用户或全部用户） */
export async function loadEmbyStats(name, range, anchor, user) {
    let sp = spec(range, anchor);
    const pv = sp.prev ? spec(range, sp.prev, sp.prevFrom ? { from: sp.prevFrom } : undefined) : null;
    const u = user || ALL_USERS;
    const base = `/api/emby/playback-stats/${enc(name)}`;
    const [cur, prev, monthRank, records, content, filmRanks] = await Promise.all([
        fetchRows(base, sp, { user: u }),
        pv ? fetchRows(base, pv, { user: u }).catch(() => []) : [],
        loadUserRank(name, sp),
        api.get(`/api/emby/playback-records${q({ instance: name, limit: 500 })}`).then(r => r.data || []).catch(() => []),
        api.get(`/api/emby/content-rank${q({
            instance: name, user: u, period: sp.period,
            start: sp.params.start, end: sp.params.end,
        })}`).then(r => r.data || {}).catch(() => ({ genre_error: true })),
        api.get(`/api/emby/playback-film-ranks${q({
            instance: name, period: sp.period,
            start: sp.params.start, end: sp.params.end,
        })}`).then(r => r.data || {}).catch(() => ({})),
    ]);
    if (sp.all) sp = fitMonths(sp, [cur]);
    const a = fill(sp, cur, 'playback_bytes'), b = fill(sp, cur, 'browse_bytes');
    const len = sp.period === 'monthly' ? 7 : 10;
    const from = sp.params.start.slice(0, len), to = sp.params.end.slice(0, len);
    const plays = records.filter(r => {
        const day = String(r.started_at || '').slice(0, len);
        return day >= from && day <= to && (u === ALL_USERS || r.user_name === u);
    }).length;
    return {
        kind: 'emby', sp, a, b, name, user: u,
        change: pv ? delta(sum(a), sum(fill(pv, prev, 'playback_bytes'))) : null,
        users: monthRank.users, rank: monthRank.rank,
        filmTraffic: filmRanks.users || {},
        films: content.films || [], genres: content.genres || [],
        genreError: !!content.genre_error, rankTruncated: !!content.truncated,
        active: u === ALL_USERS ? monthRank.rank.length : monthRank.rank.some(r => r[0] === u) ? 1 : 0,
        plays: content.play_count != null ? content.play_count : plays,
    };
}

/** 用户流量排行：所选时段内每个用户的播放 + 选片上传 */
async function loadUserRank(name, sp) {
    let users = [];
    try {
        users = (await api.get(`/api/emby/playback-users${q({ instance: name })}`)).data || [];
    } catch (e) { return { users: [], rank: [] }; }
    const rows = await Promise.all(users.map(async user => {
        try {
            const data = await fetchRows(`/api/emby/playback-stats/${enc(name)}`, sp, { user });
            return [user, sum(data.map(r => Number(r.total_bytes) || 0))];
        } catch (e) { return [user, 0]; }
    }));
    return { users, rank: rows.filter(r => r[1] > 0).sort((x, y) => y[1] - x[1]) };
}

/** 设备下拉里的当前设备：没选或已删除时取第一台 */
export function currentDevice(kind) {
    const list = kind === 'emby' ? embyList() : qbList();
    const cur = state.statsDevice;
    return list.find(d => d.name === cur) || list[0] || null;
}
