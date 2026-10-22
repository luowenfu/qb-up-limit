/* 流量图表页：柱状图、KPI，以及趋势图下方的三列排行 */

import { I } from './icons.js';
import { foldHead, foldOpen } from './events.js';
import { esc, fmtBytes, splitBytes, trimNum } from './format.js';
import { state } from './store.js';
import { siteName } from './pt_sites.js';
import { ALL_USERS, currentDevice, defaultAnchor, loadEmbyStats, loadQbStats, quickPreset, visibleDayRange, visibleMonthRange } from './stats_data.js';

const SERIES = {
    qb: { nameA: '上传', nameB: '下载', colorA: '#2563eb', colorB: '#f59e0b' },
    emby: { nameA: '播放上传', nameB: '选片上传', colorA: '#059669', colorB: '#7c3aed' },
};
const UNIT_NAMES = ['KB', 'MB', 'GB', 'TB'];

const sum = arr => arr.reduce((a, b) => a + b, 0);
const baseOf = kind => (kind === 'emby' ? 1000 : 1024);

/** 按最大值挑一个合适的单位，返回换算函数 */
function pickUnit(maxBytes, base) {
    const [, unit] = splitBytes(maxBytes, base);
    const idx = Math.max(0, UNIT_NAMES.indexOf(unit));
    const div = base ** (idx + 1);
    return { unit, conv: v => v / div };
}

const kbig = (bytes, base) => {
    const [n, u] = splitBytes(bytes, base);
    return `${n}<small>${u}</small>`;
};

const changeHtml = (pct, rev) => {
    if (pct === null || pct === undefined) return '较上一周期 —';
    const up = pct >= 0;
    const cls = (rev ? !up : up) ? 'up' : 'dn';
    return `<span class="${cls}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}%</span> 较上一周期`;
};

const CHART_W = 900, CHART_H = 300, CHART_L = 58, CHART_R = 8, CHART_T = 16, CHART_B = 28;

function tickText(v) {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 100) return String(Math.round(n));
    return trimNum(+n.toFixed(n >= 10 ? 1 : 1));
}

/* ---------- 柱状图 ---------- */
export function barChart(m) {
    const S = SERIES[m.kind], emby = m.kind === 'emby';
    const base = baseOf(m.kind);
    const stackedMax = Math.max(...m.a.map((v, i) => v + (emby ? m.b[i] : 0)), 0);
    const { unit, conv } = pickUnit(stackedMax, base);
    const a = m.a.map(conv), b = m.b.map(conv), labels = m.sp.labels;
    const W = CHART_W, H = CHART_H, L = CHART_L, R = CHART_R, T = CHART_T, B = CHART_B;
    const values = emby ? a.map((v, i) => v + b[i]) : a;
    const max = Math.max(...values) * 1.12 || 1;
    const nice = (() => { const k = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / k) * k; })();
    const n = labels.length, slot = (W - L - R) / n, bw = Math.min(26, slot * .62);
    const y = v => T + (H - T - B) * (1 - v / nice);
    let grid = '';
    const yTicks = [];
    for (let k = 0; k <= 4; k++) {
        const v = nice * k / 4, yy = y(v);
        const axis = k === 0;
        grid += `<line class="${axis ? 'axis' : 'grid'}" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" ${axis ? '' : 'stroke-dasharray="3 4"'}/>`;
        const label = k === 4 ? `${tickText(v)} ${unit}` : tickText(v);
        yTicks.push(`<span class="chart-ytick" style="left:${(L - 8) / W * 100}%;top:${yy / H * 100}%">${label}</span>`);
    }
    const every = Math.ceil(n / 8);
    const xTicks = [];
    const cols = labels.map((lab, i) => {
        const cx = L + slot * i + slot / 2;
        const av = a[i], bv = emby ? b[i] : 0;
        const ya = y(av), yb = y(av + bv);
        const tip = `${lab}|${S.nameA} ${trimNum(+av.toFixed(2))} ${unit}|${S.nameB} ${trimNum(+b[i].toFixed(2))} ${unit}`;
        if (i % every === 0) xTicks.push(`<span class="chart-xtick" style="left:${cx / W * 100}%">${esc(lab)}</span>`);
        return `<g class="col" data-tip="${esc(tip)}" data-x="${cx}" data-y="${Math.min(ya, yb)}">
            <rect x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent"/>
            ${emby && bv ? `<rect class="bar" x="${cx - bw / 2}" y="${yb}" width="${bw}" height="${Math.max(0, ya - yb)}" rx="3" fill="${S.colorB}"/>` : ''}
            <rect class="bar" x="${cx - bw / 2}" y="${ya}" width="${bw}" height="${Math.max(0, H - B - ya)}" rx="${emby && bv ? 0 : 3}" fill="${S.colorA}"/>
        </g>`;
    }).join('');
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${grid}${cols}
    </svg>
    <div class="chart-ticks">${yTicks.join('')}${xTicks.join('')}</div>`;
}

/* ---------- KPI 与排行 ---------- */
const RANK_LIMIT = 10;
const PLAY_LIMIT_NOTE = '仅统计最近 500 条播放记录';
const RANK_CARET = '<svg class="rank-caret" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const RANK_FOLD = '<svg class="rank-caret" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.2 3.4 6.4 7 3.2 10.6M7.6 3.4 10.8 7 7.6 10.6" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const rankOpen = new Set();
const rankKey = (kind, name) => `${kind}\u001f${name}`;

const filmKindLabel = kind => (kind === 'series' ? '剧集' : kind === 'movie' ? '电影' : '');

function rankName(name, kind, extras) {
    const label = filmKindLabel(kind);
    const notes = (extras || []).filter(Boolean);
    const bits = [];
    if (label) bits.push(`<span class="rank-kind ${kind}">${label}</span>`);
    notes.forEach(text => bits.push(`<span class="rank-kind">${esc(text)}</span>`));
    if (!bits.length) return `<div class="rank-name" title="${esc(name)}">${esc(name)}</div>`;
    const title = notes.length ? `${name} ${notes.join(' ')}` : name;
    return `<div class="rank-name has-kind" title="${esc(title)}"><span>${esc(name)}</span>${bits.join('')}</div>`;
}

function byteNote(label, bytes) {
    const [n, u] = splitBytes(bytes);
    return `${label}${n}${u}`;
}

function torrentNotes(row) {
    if (!row || row.length < 4) return [];
    const raw = row[3];
    const ratio = Number(raw);
    const share = raw == null || !Number.isFinite(ratio) || ratio < 0 || ratio >= 9999
        ? '∞' : ratio.toFixed(2);
    return [byteNote('体积', row[2]), `分享率${share}`];
}

function groupSites(rows) {
    const groups = new Map();
    for (const row of rows || []) {
        const host = row && row[0];
        const uploaded = Number(row && row[1]) || 0;
        if (!host || uploaded <= 0) continue;
        const nick = siteName(host);
        const key = nick || host;
        let group = groups.get(key);
        if (!group) {
            group = { nick, hosts: [], uploaded: 0 };
            groups.set(key, group);
        }
        group.hosts.push({ host, uploaded });
        group.uploaded += uploaded;
    }
    return [...groups.values()]
        .sort((a, b) => b.uploaded - a.uploaded)
        .map(group => {
            const hosts = group.hosts.sort((a, b) => b.uploaded - a.uploaded).map(item => item.host);
            if (!group.nick) return [hosts[0], group.uploaded];
            return [group.nick, group.uploaded, hosts.join('、')];
        });
}

function siteNotes(row) {
    return row && row[2] ? [row[2]] : [];
}

function ratioNotes(row) {
    if (!row || row.length < 4) return [];
    return [byteNote('体积', row[2]), byteNote('已上传', row[3])];
}

function ratioText(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n >= 9999) return '∞';
    if (n > 0 && n < 0.01) return '<0.01';
    return n.toFixed(2);
}

/** 无下载量时 qB 把分享率封顶，条形按有限值拉开，避免其它种子被压成一条线 */
function ratioWidth(row, list) {
    const finite = (list || [])
        .map(item => Number(item[1]))
        .filter(v => Number.isFinite(v) && v > 0 && v < 9999);
    const maxFinite = finite.length ? Math.max(...finite) : 1;
    const n = Number(row[1]);
    if (!Number.isFinite(n) || n >= 9999) return maxFinite * 1.15;
    return n;
}

function rankToggle(key, label) {
    const open = rankOpen.has(key);
    const action = open ? '收起' : '展开';
    return `<button type="button" class="rank-toggle" data-rank-key="${esc(key)}" data-rank-label="${esc(label)}" aria-expanded="${open ? 'true' : 'false'}" aria-label="${action}${esc(label)}">${RANK_CARET}</button>`;
}

function rankBars(rows, formatValue, emptyText, expand, notesOf, barOf) {
    const list = (rows || []).filter(row => row && row[1] > 0).slice(0, RANK_LIMIT);
    if (!list.length) return `<div class="hint-t">${emptyText}</div>`;
    const widthOf = row => (barOf ? barOf(row, list) : row[1]);
    const top = Math.max(...list.map(widthOf), 0) || 1;
    return `<div class="rank">${list.map((row, i) => {
        const extra = expand ? expand(row) : null;
        const open = !!(extra && rankOpen.has(extra.key));
        const notes = notesOf ? notesOf(row) : null;
        return `<div class="rank-row${extra ? ' can-open' : ''}${open ? ' open' : ''}"><span class="rank-no">${i + 1}</span><div>${rankName(row[0], row[2], notes)}<div class="rank-bar"><i style="width:${widthOf(row) / top * 100}%"></i></div></div><span class="rank-v num">${formatValue(row[1])}</span>${extra ? rankToggle(extra.key, row[0]) : ''}${extra ? `<div class="rank-detail">${extra.html}</div>` : ''}</div>`;
    }).join('')}</div>`;
}

function asFilm(row) {
    if (Array.isArray(row)) return { name: row[0], count: row[1], kind: row[2] || '', users: [] };
    return {
        name: row && row.name || '',
        count: Number(row && row.count) || 0,
        kind: row && row.kind || '',
        users: row && row.users || [],
    };
}

function asGenre(row) {
    if (Array.isArray(row)) return { name: row[0], count: row[1], films: [] };
    return {
        name: row && row.name || '',
        count: Number(row && row.count) || 0,
        films: row && row.films || [],
    };
}

function userTagDetail(users) {
    const list = (users || []).filter(Boolean);
    if (!list.length) return '<div class="hint-t">该时段没有点播用户</div>';
    return `<div class="rank-tags">${list.map(name => `<span class="tag">${esc(name)}</span>`).join('')}</div>`;
}

function userFilmDetail(rows) {
    const note = '<div class="rank-subnote">仅播放流量，不含选片</div>';
    const list = (rows || []).map(row => [row.name, row.bytes, row.kind]);
    return note + rankBars(list, v => fmtBytes(v, 1000), '该时段没有可归到影片的播放流量');
}

function filmPlayBars(films, emptyText, scope) {
    const rows = (films || []).map(asFilm).map(film => [film.name, film.count, film.kind, film.users]);
    return rankBars(rows, playCount, emptyText, row => ({
        key: rankKey(scope || 'film', row[0]),
        html: userTagDetail(row[3]),
    }));
}

function genreBars(genres, emptyText) {
    const rows = (genres || []).map(asGenre).map(genre => [genre.name, genre.count, '', genre.films]);
    return rankBars(rows, playCount, emptyText, row => ({
        key: rankKey('genre', row[0]),
        html: filmPlayBars(row[3], '该类型暂无影片', rankKey('genre-film', row[0])),
    }));
}

function rankCard(title, caption, body, note, collapsible) {
    const limit = note ? `<small class="rank-limit-note">${esc(note)}</small>` : '';
    const hasRows = collapsible && body.includes('rank-toggle');
    const anyOpen = hasRows && body.includes('aria-expanded="true"');
    const foldLabel = anyOpen ? '全部收起' : '全部展开';
    const fold = hasRows ? `<button type="button" class="rank-fold${anyOpen ? ' open' : ''}" aria-expanded="${anyOpen ? 'true' : 'false'}" aria-label="${foldLabel}" title="${foldLabel}">${RANK_FOLD}</button>` : '';
    if (hasRows) {
        return `<div class="chart-side"><h3 class="panel-title rank-head"><span class="rank-head-main">${title}<small>${esc(caption)}</small>${limit}</span>${fold}</h3>${body}</div>`;
    }
    const tools = limit ? `<span class="r rank-tools">${limit}</span>` : '';
    return `<div class="chart-side"><h3 class="panel-title">${title}<small>${esc(caption)}</small>${tools}</h3>${body}</div>`;
}

function syncRankFold(board) {
    const fold = board?.querySelector(':scope > .panel-title .rank-fold');
    if (!fold) return;
    const anyOpen = [...board.querySelectorAll('.rank-toggle')].some(btn => btn.getAttribute('aria-expanded') === 'true');
    fold.classList.toggle('open', anyOpen);
    const label = anyOpen ? '全部收起' : '全部展开';
    fold.setAttribute('aria-expanded', anyOpen ? 'true' : 'false');
    fold.setAttribute('aria-label', label);
    fold.title = label;
}

function setRankRow(row, open) {
    const toggle = row.querySelector(':scope > .rank-toggle');
    const key = toggle?.dataset.rankKey;
    if (!toggle || !key) return;
    if (open) rankOpen.add(key);
    else rankOpen.delete(key);
    row.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', `${open ? '收起' : '展开'}${toggle.dataset.rankLabel || ''}`);
}

const playCount = value => `${value}<small>人次</small>`;
function kpisOf(m) {
    if (m.cumulative) return cumulativeKpis(m);
    const base = baseOf(m.kind);
    const sa = sum(m.a), sb = sum(m.b);
    const peak = Math.max(...m.a, 0), idx = m.a.indexOf(peak);
    const peakLab = peak > 0 ? m.sp.labels[idx] : '—';
    if (m.kind === 'emby') {
        return [
            ['sum', 'tone-mint', '', '播放上传合计', kbig(sa, base), changeHtml(m.change)],
            ['film', 'tone-violet', '', '选片流量', kbig(sb, base), `占比 ${(sa + sb ? sb / (sa + sb) * 100 : 0).toFixed(1)}%`],
            ['peak', 'tone-orange', '', '峰值时段', kbig(peak, base), peakLab],
            ['user', 'tone-info', '', '活跃用户', `${m.active}<small>人</small>`, `共 ${m.plays} 次播放`],
        ];
    }
    return [
        ['up', 'tone-info', '', '上传合计', kbig(sa, base), changeHtml(m.change)],
        ['down', 'tone-mint', '', '下载合计', kbig(sb, base), changeHtml(m.changeDown, true)],
        ['peak', 'tone-orange', '', '上传峰值', kbig(peak, base), peakLab],
        ['shield', 'tone-red', '', '限速触发', `${m.hits}<small>次</small>`, esc(m.sp.caption)],
    ];
}

function deviceRatioText(totals) {
    const uploaded = Number(totals && totals.uploaded) || 0;
    const downloaded = Number(totals && totals.downloaded) || 0;
    if (downloaded <= 0) return uploaded > 0 ? '∞' : '0.00';
    return ratioText(totals.ratio);
}

function cumulativeKpis(m) {
    const dash = '—';
    if (!m.available) {
        return [
            ['up', 'tone-info', '', '上传合计', dash, '当前累计'],
            ['down', 'tone-mint', '', '下载合计', dash, '当前累计'],
            ['list', 'tone-violet', '', '种子数', dash, '当前种子'],
            ['sum', 'tone-orange', '', '整体分享率', dash, '总上传 / 总下载'],
        ];
    }
    const totals = m.totals || {};
    return [
        ['up', 'tone-info', '', '上传合计', kbig(totals.uploaded, 1024), '当前累计'],
        ['down', 'tone-mint', '', '下载合计', kbig(totals.downloaded, 1024), '当前累计'],
        ['list', 'tone-violet', '', '种子数', `${Number(totals.count) || 0}<small>个</small>`, '当前种子'],
        ['sum', 'tone-orange', '', '整体分享率', deviceRatioText(totals), '总上传 / 总下载'],
    ];
}

function donut(parts, totalText) {
    const total = parts.reduce((s, p) => s + p[1], 0) || 1;
    const r = 54, c = 2 * Math.PI * r;
    let off = 0;
    const arcs = parts.map(p => {
        const len = p[1] / total * c;
        const s = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${p[2]}" stroke-width="18" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`;
        off += len;
        return s;
    }).join('');
    return `<div style="display:flex;justify-content:center"><svg width="150" height="150" viewBox="0 0 140 140">
        <circle class="donut-track" cx="70" cy="70" r="${r}" fill="none" stroke-width="18"/>${arcs}
        <text class="donut-k" x="70" y="66" text-anchor="middle" font-size="12" fill="currentColor">合计</text>
        <text class="donut-v" x="70" y="86" text-anchor="middle" font-size="17" font-weight="800" fill="currentColor">${esc(totalText)}</text>
    </svg></div>`;
}

function cumulativePie(uploaded, downloaded) {
    const up = Math.max(0, Number(uploaded) || 0);
    const down = Math.max(0, Number(downloaded) || 0);
    const parts = [['上传合计', up, '#3b82f6'], ['下载合计', down, '#10b981']];
    const total = up + down;
    const rows = parts.map((row, i) => `
        <div class="rank-row"><span class="rank-no">${i + 1}</span><div><div class="rank-name" title="${esc(row[0])}">${esc(row[0])}</div><div class="rank-bar"><i style="width:${total ? row[1] / total * 100 : 0}%;background:${row[2]}"></i></div></div><span class="rank-v num">${fmtBytes(row[1])}</span></div>`).join('');
    return `<div class="share-pie">${donut(parts, fmtBytes(total))}<div class="rank">${rows}</div></div>`;
}

function cumulativeTrend(m) {
    const totals = m.totals || {};
    const body = m.available
        ? cumulativePie(totals.uploaded, totals.downloaded)
        : '<div class="hint-t">当前读不到这台设备的种子</div>';
    return `<div class="chart-grid has-kpis">
        <div class="chart-main">
            <h3 class="panel-title">设备总计<small>当前累计</small></h3>
            ${body}
        </div>
        <div class="chart-kpis">${kpiHtml(cumulativeKpis(m))}</div>
    </div>`;
}

function ranksOf(m) {
    if (m.kind === 'emby') {
        const note = m.rankTruncated ? PLAY_LIMIT_NOTE : '';
        const films = m.films || [];
        const genreEmpty = films.length ? '该时段暂无类型' : '该时段暂无播放';
        const genreBody = m.genreError
            ? '<div class="hint-t">暂时取不到影片类型</div>'
            : genreBars(m.genres, genreEmpty);
        const traffic = m.filmTraffic || {};
        return [
            rankCard('用户上传 Top 10', m.sp.caption, rankBars(m.rank, v => fmtBytes(v, 1000), '该时段暂无用户流量', row => ({
                key: rankKey('user', row[0]),
                html: userFilmDetail(traffic[row[0]]),
            })), '', true),
            rankCard('影片点播 Top 10', m.sp.caption, filmPlayBars(films, '该时段暂无播放'), note, true),
            rankCard('类型点播 Top 10', m.sp.caption, genreBody, note, true),
        ].join('');
    }
    const caption = m.cumulative ? '当前累计' : m.sp.caption;
    const emptyTorrent = m.cumulative ? '当前没有可排行的种子' : '该时段还没有可排行的种子';
    const emptySite = m.cumulative ? '当前没有可排行的站点' : '该时段还没有可排行的站点';
    return [
        rankCard('分享率 Top 10', caption, rankBars(m.ratios, ratioText, emptyTorrent, null, ratioNotes, ratioWidth)),
        rankCard('种子上传 Top 10', caption, rankBars(m.torrents, v => fmtBytes(v), emptyTorrent, null, torrentNotes)),
        rankCard('站点上传 Top 10', caption, rankBars(groupSites(m.sites), v => fmtBytes(v), emptySite, null, siteNotes)),
    ].join('');
}

/* ---------- 页面 ---------- */
const RANGE_ARROW = '<svg class="range-arrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.2 8h10.2M9.2 4.6 12.8 8 9.2 11.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function rangeInput(id, value, day) {
    const label = id === 'stFrom' ? (day ? '开始日期' : '开始月份') : (day ? '结束日期' : '结束月份');
    return `<input type="text" id="${id}" class="month-text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="${label}" value="${esc(value)}" maxlength="${day ? 12 : 10}" aria-label="${label}">`;
}

function toolbar(m, kind) {
    const picked = state.statsRange;
    const range = kind === 'qb' || picked !== 'total' ? picked : (state.statsChartRange || 'day');
    const chartRange = range === 'total' ? (state.statsChartRange || 'day') : range;
    const day = chartRange !== 'month';
    const win = day ? visibleDayRange() : visibleMonthRange();
    const max = defaultAnchor(day ? 'day' : 'month');
    const periodField = range === 'total' ? '' : `<div class="chart-ctrl range-field${day ? ' is-day' : ''}" data-range-field data-mode="${day ? 'day' : 'month'}" data-max="${max}"><span class="cap">时段</span>${rangeInput('stFrom', win.start, day)}<span class="sep">${RANGE_ARROW}</span>${rangeInput('stTo', win.end, day)}<button type="button" class="month-pick" data-range-open aria-label="${day ? '选择日期范围' : '选择月份范围'}">${I.cal.replace(/16/g, '14')}</button></div>`;
    const shortcuts = [
        ['day', 'prev', '上月'],
        ['day', 'cur', '本月'],
        ['month', 'cur', '今年'],
        ['month', 'prev', '去年'],
    ];
    const activeQuick = range === 'day' || range === 'month'
        ? shortcuts.find(([mode, which]) => {
            if (mode !== range) return false;
            const preset = quickPreset(mode, which);
            return preset.start === win.start && preset.end === win.end;
        })
        : null;
    const quick = range === 'total' ? '' : `<div class="chart-ctrl range-quick"><span class="cap">快捷</span>${shortcuts.map(([mode, which, label]) => `<button type="button" data-quick="${mode}:${which}" class="${activeQuick && activeQuick[0] === mode && activeQuick[1] === which ? 'on' : ''}">${label}</button>`).join('')}</div>`;
    const totalTab = kind === 'qb'
        ? `<button data-r="total" class="${range === 'total' ? 'on' : ''}">当前累计</button>`
        : '';
    const viewNote = kind === 'qb' && range === 'total' ? '<span class="view-note">当前累计直读 qB，按天和按月读本程序的记录</span>' : '';
    const userField = kind === 'emby' ? `<label class="chart-ctrl user-ctrl"><span class="cap">用户</span><select id="stUser"><option value="${ALL_USERS}">全部用户</option>${(m.users || []).map(u => `<option ${u === state.statsUser ? 'selected' : ''} value="${esc(u)}">${esc(u)}</option>`).join('')}</select>${I.chev}</label>` : '';
    return `<div class="toolbar chart-bar">
            <div class="chart-pair">
                ${userField}
                <div class="chart-ctrl" data-range>
                    <span class="cap">视图</span>
                    ${totalTab}
                    <button data-r="day" class="${range === 'day' ? 'on' : ''}">按天</button>
                    <button data-r="month" class="${range === 'month' ? 'on' : ''}">按月</button>
                </div>
                ${viewNote}
            </div>
            ${periodField}
            ${quick ? `<div class="tool-r">${quick}</div>` : ''}
        </div>`;
}

function kpiHtml(kpis) {
    return kpis.map(k => `
        <div class="kpi"><div class="kpi-top"><span class="kpi-name">${k[3]}</span><span class="kpi-ico ${k[1]}">${I[k[0]]}</span></div><div class="kpi-v num">${k[4]}</div><div class="kpi-d">${k[5]}</div></div>`).join('');
}

const CHART_BLOCKS = ['trend', 'rank'];

function chartBlockOrder(kind, name) {
    const all = state.prefs.chart_block_orders;
    const bucket = all && typeof all === 'object' ? all[kind] : null;
    const raw = bucket && Array.isArray(bucket[name]) ? bucket[name] : [];
    const order = [];
    raw.forEach(id => {
        if (CHART_BLOCKS.includes(id) && !order.includes(id)) order.push(id);
    });
    CHART_BLOCKS.forEach(id => { if (!order.includes(id)) order.push(id); });
    return order;
}

const swapSplit = () => `<div class="block-split"><button type="button" class="block-swap" data-block-swap title="上下互换" aria-label="上下互换">${I.swap}</button></div>`;

/** 当前设备的顺序偏好。只改这一台，其它设备保持原样 */
export function chartOrderPref(order) {
    const kind = state.view === 'emby' ? 'emby' : 'qb';
    const name = state.dev || '';
    if (!name) return null;
    const prev = state.prefs.chart_block_orders;
    const all = prev && typeof prev === 'object' ? prev : {};
    const bucket = all[kind] && typeof all[kind] === 'object' ? all[kind] : {};
    return { chart_block_orders: { ...all, [kind]: { ...bucket, [name]: order } } };
}

/** 交换分割线两侧的板块，返回新的顺序 */
export function moveChartBlock(btn) {
    const split = btn?.closest('.block-split');
    const host = split?.parentElement;
    const prev = split?.previousElementSibling;
    const next = split?.nextElementSibling;
    if (!host?.classList.contains('chart-blocks') || !prev?.dataset.chartBlock || !next?.dataset.chartBlock) return null;
    host.insertBefore(next, prev);
    host.insertBefore(split, prev);
    return [...host.querySelectorAll(':scope > [data-chart-block]')].map(el => el.dataset.chartBlock);
}

export function statsHtml(m, kind, dev) {
    const S = SERIES[kind];
    const kpis = kpisOf(m);
    const bodies = {
        trend: m.cumulative ? cumulativeTrend(m) : `<div class="chart-grid has-kpis">
        <div class="chart-main">
            <h3 class="panel-title">${kind === 'emby' ? '播放流量趋势' : '上传流量趋势'}<small>${kind === 'emby' ? esc(dev.name) : esc(m.sp.caption)}</small>
                <span class="r chart-legend"><span><i style="background:${S.colorA}"></i>${S.nameA}</span>${kind === 'emby' ? `<span><i style="background:${S.colorB}"></i>${S.nameB}</span>` : ''}</span>
            </h3>
            <div class="chart-wrap" id="chartWrap">${barChart(m)}<div class="chart-tip" id="chartTip"></div></div>
        </div>
        <div class="chart-kpis">${kpiHtml(kpis)}</div>
    </div>`,
        rank: `<div class="rank-grid">${ranksOf(m)}</div>`,
    };
    const order = chartBlockOrder(kind, dev.name);
    const blocks = order.map((id, index) => `<section class="chart-block" data-chart-block="${id}">${bodies[id]}</section>${index < order.length - 1 ? swapSplit() : ''}`).join('');
    return `<div class="panel${foldOpen('chart') ? ' open' : ''}">
    ${foldHead('chart', `${I.chart}流量图表`)}
    ${toolbar(m, kind)}
    <div class="chart-blocks">${blocks}</div>
    </div>`;
}

const NO_DEVICE = kind => `<div class="panel panel-pad" style="text-align:center;color:var(--text-3);padding:48px 16px"><b style="display:block;color:var(--text-1);font-size:15px;margin-bottom:6px">还没有${kind === 'emby' ? ' Emby ' : ' qB '}设备</b>添加设备后这里会显示流量图表</div>`;

/** 拉取数据并生成页面 html */
export async function renderStats(kind) {
    const dev = currentDevice(kind);
    if (!dev) return NO_DEVICE(kind);
    state.statsDevice = dev.name;
    if (state.statsRange === 'hour') state.statsRange = 'day';
    if (state.statsChartRange === 'hour') state.statsChartRange = 'day';
    const range = kind === 'qb' ? state.statsRange : (state.statsRange === 'total' ? (state.statsChartRange || 'day') : state.statsRange);
    const chartRange = range === 'total' ? (state.statsChartRange || 'day') : range;
    const anchor = range === 'day' ? visibleDayRange().end : range === 'month' ? visibleMonthRange().end : (state.statsDate || defaultAnchor(chartRange));
    const m = kind === 'emby'
        ? await loadEmbyStats(dev.name, range, anchor, state.statsUser)
        : await loadQbStats(dev.name, range, anchor);
    return statsHtml(m, kind, dev);
}

function bindRankToggles() {
    const root = document.getElementById('sec-chart');
    if (!root || root.dataset.rankBound) return;
    root.dataset.rankBound = '1';
    root.addEventListener('click', event => {
        const fold = event.target.closest('.rank-fold');
        if (fold && root.contains(fold)) {
            const board = fold.closest('.chart-side');
            const scroller = board?.querySelector(':scope > .rank');
            const scrollTop = scroller ? scroller.scrollTop : 0;
            const open = fold.getAttribute('aria-expanded') !== 'true';
            board?.querySelectorAll('.rank-row.can-open').forEach(row => setRankRow(row, open));
            syncRankFold(board);
            if (scroller) scroller.scrollTop = scrollTop;
            return;
        }
        const btn = event.target.closest('.rank-toggle');
        if (!btn || !root.contains(btn)) return;
        const row = btn.closest('.rank-row');
        if (!row || !btn.dataset.rankKey) return;
        const scroller = row.closest('.chart-side')?.querySelector(':scope > .rank');
        const scrollTop = scroller ? scroller.scrollTop : 0;
        setRankRow(row, !rankOpen.has(btn.dataset.rankKey));
        syncRankFold(row.closest('.chart-side'));
        if (scroller) scroller.scrollTop = scrollTop;
    });
}

/** 鼠标悬停提示 */
export function bindChart(kind) {
    bindRankToggles();
    const wrap = document.getElementById('chartWrap');
    if (!wrap || wrap.dataset.bound) return;
    wrap.dataset.bound = '1';
    const tip = document.getElementById('chartTip');
    const svg = wrap.querySelector('svg');
    const color = SERIES[kind];
    wrap.querySelectorAll('.col').forEach(g => {
        g.addEventListener('mouseenter', () => {
            const [lab, a, bb] = g.dataset.tip.split('|');
            tip.innerHTML = `<b>${esc(lab)}</b><span><i style="background:${color.colorA}"></i>${esc(a)}</span><span><i style="background:${color.colorB}"></i>${esc(bb)}</span>`;
            const sx = svg.clientWidth / CHART_W, sy = svg.clientHeight / CHART_H;
            tip.style.left = (+g.dataset.x * sx) + 'px';
            tip.style.top = (+g.dataset.y * sy - 6) + 'px';
            tip.style.opacity = 1;
        });
        g.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
    });
}
