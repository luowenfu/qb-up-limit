/* 设备卡片与设备管理页（markup 与改造计划原型一致） */

import { I, ico } from './icons.js';
import { esc, fmtBytes, fmtDuration, maskIp, splitSpeed } from './format.js';
import { anomalyTip, foldHead, foldOpen, playMode, tipTag } from './events.js';
import { state, qbList, embyList } from './store.js';

/* ---------- 迷你曲线 ---------- */
export function spark(points, color, id) {
    let pts = points.slice(-12);
    while (pts.length < 12) pts.unshift(0);
    const w = 120, h = 38, max = Math.max(...pts, 1);
    const step = w / (pts.length - 1);
    const xy = pts.map((v, i) => [i * step, h - 4 - (v / max) * (h - 10)]);
    const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
        <path d="${line} L${w} ${h} L0 ${h} Z" fill="url(#${id})"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

const actBtn = (cls, icon, label) => `<button type="button" class="act ${cls}" data-act="${cls}"><span class="ai">${I[icon]}</span>${label}</button>`;

const legend = key => {
    const h = state.hide[key] || '';
    return `<span class="more lg" data-lg="${key}">
        <button type="button" class="lg-btn u ${h === 'u' ? 'off' : ''}" data-lgk="u" title="${h === 'u' ? '显示' : '隐藏'}上传">上传</button>
        <button type="button" class="lg-btn d ${h === 'd' ? 'off' : ''}" data-lgk="d" title="${h === 'd' ? '显示' : '隐藏'}下载">下载</button>
    </span>`;
};

const tiles = (list, key) => `<div class="tiles ${state.hide[key] ? 'hide-' + state.hide[key] : ''}" data-tiles="${key}">${list.map(t => `
    <div class="tile ${t[3] ? 'alert' : ''}">
        <div class="tile-k"><span>${t[0]}</span>${t[3] ? '<span style="color:var(--danger);font-weight:700">超额</span>' : ''}</div>
        <div class="tile-v num"><span class="u">${esc(t[1])}</span><span class="d">${esc(t[2])}</span></div>
    </div>`).join('')}</div>`;

const liveBoxes = (d, key) => `<div class="live">
    <div class="live-box up"><div class="live-label">${I.up}实时上传</div><div class="live-val num">${d.live.up[0]}<small>${d.live.up[1]}</small></div>${spark(d.spark, '#3b82f6', 'su' + key)}</div>
    <div class="live-box down"><div class="live-label">${I.down}实时下载</div><div class="live-val num">${d.live.down[0]}<small>${d.live.down[1]}</small></div>${spark(d.sparkDown, '#10b981', 'sd' + key)}</div>
</div>`;

/** 打码文字右侧的小眼睛：点开看原文，再点恢复打码 */
export function maskedText(kind, name, full, masked) {
    if (full === masked) return esc(full);
    const key = `${kind}:${name}`;
    const on = !!state.revealHost[key];
    const shown = on ? full : masked;
    return `<span class="mask-line"><span class="mask-val" data-mask="${esc(key)}" data-full="${esc(full)}" data-masked="${esc(masked)}">${esc(shown)}</span><button type="button" class="eye-btn${on ? ' on' : ''}" data-reveal="${esc(key)}" title="${on ? '隐藏地址' : '显示地址'}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${on ? '隐藏地址' : '显示地址'}">${on ? I.eyeOff : I.eye}</button></span>`;
}

export function toggleReveal(key) {
    const on = !(state.revealHost[key]);
    state.revealHost[key] = on;
    const sel = CSS.escape(key);
    document.querySelectorAll(`[data-mask="${sel}"]`).forEach(el => {
        el.textContent = on ? el.dataset.full : el.dataset.masked;
    });
    document.querySelectorAll(`[data-reveal="${sel}"]`).forEach(btn => {
        btn.classList.toggle('on', on);
        btn.title = on ? '隐藏地址' : '显示地址';
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-label', btn.title);
        btn.innerHTML = on ? I.eyeOff : I.eye;
    });
}

const urlLine = (d, kind) => {
    const raw = d.raw;
    const scheme = raw.use_https ? 'https' : 'http';
    return maskedText(kind, d.name, `${scheme}://${raw.host}:${raw.port}`, `${scheme}://${maskIp(raw.host)}:${raw.port}`);
};
const dot = d => `<span class="online ${d.online ? '' : 'off'}"></span>`;

/* ---------- qB 卡片 ---------- */
export function qbCard(d, i, ord) {
    const at = ord == null ? '' : ` style="--i:${ord}"`;
    return `<article${at} class="dev ${d.online ? '' : 'is-off'}${foldOpen('card') ? ' open' : ''}">
        ${foldHead('card', `${I.server}设备详情`)}
        <header class="dev-head">
            <div class="dev-icon" title="qBittorrent"><img src="/static/img/qbittorrent-logo.svg" alt=""></div>
            <div class="dev-title">
                <div class="dev-name" data-open-dev data-kind="qb" data-dev="${esc(d.name)}" title="${esc(d.name)}">${esc(d.name)}</div>
                <div class="dev-url">${dot(d)}${urlLine(d, 'qb')}</div>
            </div>
            <div class="dev-chips">
                ${d.online ? '' : '<span class="chip">离线</span>'}
                ${d.triggered ? `<span class="chip hot">${I.bolt.replace('16', '13').replace('16', '13')}已触发限速</span>` : ''}
                <span class="chip">${I.cal.replace('16', '13').replace('16', '13')}${esc(d.cycle)}</span>
            </div>
        </header>
        <div class="dev-body">
            <div class="dev-col">
                ${liveBoxes(d, 'q' + i)}
                <div class="kv">
                    <div class="kv-row">${I.bolt}<span class="k">当前上传限速</span>
                        <span class="toggle"><span class="${d.limit.on === 'global' ? 'on' : ''}" data-lim-mode="global" data-dev="${esc(d.name)}" title="切换为全局限速">全局<b>${d.limit.global}</b></span><span class="${d.limit.on === 'backup' ? 'on' : ''}" data-lim-mode="backup" data-dev="${esc(d.name)}" title="切换为备用限速">备用<b>${d.limit.backup}</b></span></span>
                    </div>
                    <div class="kv-row">${I.cal}<span class="k">当前周期</span><span class="v num">${esc(d.range)}</span></div>
                    <div class="kv-row">${I.loop}<span class="k">周期计划</span><span class="v">${esc(d.plan)}</span></div>
                </div>
                <h4 class="sec-title">${I.wave}流量统计${legend('q' + i)}</h4>
                ${tiles(d.traffic, 'q' + i)}
            </div>
            <div class="dev-col">
                <h4 class="sec-title">${I.rules}达量限速规则<span style="color:var(--text-3);font-weight:600">${d.rules.length}</span>
                    <span class="more"><button class="mini-btn" data-goto="chart" data-kind="qb" data-dev="${esc(d.name)}">${I.chart}图表</button><button class="mini-btn" data-goto="events" data-kind="qb" data-dev="${esc(d.name)}">${I.list}记录</button></span>
                </h4>
                <div class="rules">${d.rules.map(r => `
                    <div class="rule ${r.st || ''}">
                        <div class="rule-top"><b>阈值 ${r.th}</b><span class="pct num">${r.pct}%</span></div>
                        <div class="prog"><i style="width:${r.pctNum}%"></i></div>
                        <div class="rule-bot"><span>限速至 <b style="color:var(--text-1)">${r.speed}</b></span><span class="r ${r.st ? 'st' : ''}">${r.note}</span></div>
                    </div>`).join('')}
                </div>
            </div>
        </div>
        <footer class="dev-foot" data-kind="qb" data-name="${esc(d.name)}">
            ${actBtn('web', 'web', '打开 Web')}${actBtn('set', 'gear', '设置')}${actBtn('lim', 'lim', '手动限速')}${actBtn('rst', 'rst', '清空统计')}${actBtn('del', 'del', '删除')}
        </footer>
    </article>`;
}

/* ---------- Emby 会话 ---------- */
function sessionTitle(s) {
    if (s.session_mode === 'browsing') return s.viewing_title || s.viewing_series_name || '正在选片';
    if (s.series_name) {
        const ep = [s.episode_label, s.episode_title].filter(Boolean).join(' · ');
        return `${s.series_name}${ep ? ' ' + ep : ''}`;
    }
    return s.title || s.episode_title || '未知内容';
}

function sessionIp(s) {
    if (s.client_ip) return s.client_ip;
    const ep = String(s.remote_endpoint || '').trim();
    if (!ep) return '未记录';
    if (ep.startsWith('[')) {
        const end = ep.indexOf(']');
        if (end > 1) return ep.slice(1, end);
    }
    return (ep.split('.').length === 4 && ep.includes(':')) ? ep.slice(0, ep.lastIndexOf(':')) : ep;
}

function sessionUserTip(s) {
    const rows = [['IP 地址', sessionIp(s)]];
    const dev = [s.client, s.device_name].filter(Boolean).join(' · ');
    if (dev) rows.push(['设备', dev]);
    return rows;
}

function sessionHtml(s, d) {
    const base = 1000;
    const wan = !!s.is_remote;
    const browse = s.session_mode === 'browsing';
    const pos = Number(s.position_seconds) || 0;
    const run = Number(s.runtime_seconds) || 0;
    const pct = s.progress_percent != null ? Math.min(100, Number(s.progress_percent) || 0) : (run ? Math.min(100, pos / run * 100) : 0);
    const who = `${s.user_name || '未知用户'} · ${wan ? '外网' : '局域网'}`;
    const [sn, su] = splitSpeed(Math.max(0, Number(s.estimated_upload_bytes_1s_live) || 0), base);
    const speed = `${sn} ${su}`;
    const anomaly = wan && !browse && !(Number(s.estimated_upload_bytes_live) > 0) && !!s.upload_anomaly;
    const mode = browse ? null : playMode(s);
    const cmd = (act, label, icon) => `<button type="button" class="mini-btn icon" title="${label}" data-sess="${act}" data-sid="${esc(s.id)}" data-dev="${esc(d.name)}">${icon}</button>`;
    const ctl = browse ? '' : `<span class="session-ctl">${cmd(s.is_paused ? 'unpause' : 'pause', s.is_paused ? '继续' : '暂停', s.is_paused ? I.play : I.pause)}${cmd('stop', '停止', I.stop)}${cmd('message', '发送消息', I.msg)}</span>`;
    const posterId = s.poster_item_id || '';
    const posterSrc = posterId
        ? `/api/emby/poster?instance=${encodeURIComponent(d.name)}&item=${encodeURIComponent(posterId)}${s.poster_tag ? `&tag=${encodeURIComponent(s.poster_tag)}` : ''}`
        : ((s.item_type === 'Movie' || s.item_type === 'Series' || s.item_type === 'Video' || s.item_type === 'BoxSet') && s.item_id && d.url
            ? `${d.url}/Items/${encodeURIComponent(s.item_id)}/Images/Primary?maxHeight=320`
            : '');
    const poster = posterSrc ? `<img src="${esc(posterSrc)}" alt="" onerror="this.remove()">` : '';
    return `<div class="session"><div class="poster">▶${poster}</div><div class="session-main">
        <div class="session-title" title="${esc(sessionTitle(s))}">${esc(sessionTitle(s))}</div>
        <div class="session-tags">${tipTag(who, wan ? 'who' : 'who lan', sessionUserTip(s))}${mode ? tipTag(mode.label, mode.cls, mode.tip) : ''}${browse ? '<span class="tag emby">选片</span>' : ''}</div>
        ${browse ? '' : `<div class="session-meter">
            ${wan ? `<div class="session-speed">${speed}</div><div class="session-up${anomaly ? ' warn has-tip' : ''}">${anomaly ? `上传 异常${anomalyTip()}` : `上传 ${fmtBytes(s.estimated_upload_bytes_live || 0, base)}`}</div>` : ''}
            <div class="ev-prog"><i style="width:${pct.toFixed(1)}%"></i></div>
            <div class="session-bot"><span class="num">${fmtDuration(pos)}${run ? ' / ' + fmtDuration(run) : ''}</span>${ctl}</div>
        </div>`}
    </div></div>`;
}

const emptySession = `<div class="session-empty"><div><div class="ico">${I.tv}</div></div><div><b>暂无活跃播放</b></div></div>`;

/* ---------- Emby 卡片 ---------- */
export function embyCard(d, i, ord) {
    const has = d.sessions.length > 0;
    const key = 'e' + i;
    const at = ord == null ? '' : ` style="--i:${ord}"`;
    return `<article${at} class="dev ${d.online ? '' : 'is-off'}${foldOpen('card') ? ' open' : ''}">
        ${foldHead('card', `${I.server}设备详情`)}
        <header class="dev-head emby">
            <div class="dev-icon" title="Emby"><img src="/static/img/emby-icon.svg" alt=""></div>
            <div class="dev-title">
                <div class="dev-name" data-open-dev data-kind="emby" data-dev="${esc(d.name)}" title="${esc(d.name)}">${esc(d.name)}</div>
                <div class="dev-url">${dot(d)}${urlLine(d, 'emby')}</div>
            </div>
            <div class="dev-chips">
                <span class="chip">${d.online ? 'API 在线' : 'API 离线'}</span>
                <span class="chip">${d.lucky ? 'Lucky 采集' : '未采集'}</span>
                <span class="chip">${d.sessions.length} 路播放</span>
            </div>
        </header>
        <div class="dev-body">
            <div class="dev-col">
                ${liveBoxes(d, key)}
                <div class="kv">
                    <div class="kv-row">${I.link}<span class="k">采集模式</span><span class="v">${esc(d.mode)}</span></div>
                    <div class="kv-row">${I.loop}<span class="k">采集频率</span><span class="v">${esc(d.collect)}</span></div>
                    <div class="kv-row">${I.play}<span class="k">当前播放</span><span class="v">${esc(d.playing)}</span></div>
                </div>
                <h4 class="sec-title">${I.wave}流量统计${legend(key)}</h4>
                ${tiles(d.traffic, key)}
                <div class="tiles-note">按用户统计外网流量</div>
            </div>
            <div class="dev-col" style="display:flex;flex-direction:column">
                <h4 class="sec-title">${I.play}当前播放会话
                    <span class="more"><button class="mini-btn" data-goto="chart" data-kind="emby" data-dev="${esc(d.name)}">${I.chart}图表</button><button class="mini-btn" data-goto="events" data-kind="emby" data-dev="${esc(d.name)}">${I.list}记录</button></span>
                </h4>
                <div class="sessions">${has ? d.sessions.map(s => sessionHtml(s, d)).join('') : emptySession}</div>
            </div>
        </div>
        <footer class="dev-foot" data-kind="emby" data-name="${esc(d.name)}">
            ${actBtn('web', 'web', '打开 Web')}${actBtn('set', 'gear', '设置')}${actBtn('rst', 'rst', '清空统计')}${actBtn('del', 'del', '删除')}
        </footer>
    </article>`;
}

const EMPTY = (title, sub) => `<div class="panel panel-pad" style="text-align:center;color:var(--text-3);padding:48px 16px"><b style="display:block;color:var(--text-1);font-size:15px;margin-bottom:6px">${title}</b>${sub}</div>`;

/** 设备详情页顶部的单张卡片；设备不存在时返回空串 */
export function deviceCard(kind, name) {
    const list = kind === 'emby' ? embyList() : qbList();
    const i = list.findIndex(d => d.name === name);
    if (i < 0) return '';
    return kind === 'emby' ? embyCard(list[i], i) : qbCard(list[i], i);
}

/* ---------- 设备管理页 ---------- */
export function renderDevices(p) {
    const qb = qbList(), em = embyList();
    if (p === 'qb') return qb.length ? `<div class="grid">${qb.map(qbCard).join('')}</div>` : EMPTY('还没有 qB 设备', '点击左侧「添加设备」接入第一台');
    if (p === 'emby') return em.length ? `<div class="grid">${em.map(embyCard).join('')}</div>` : EMPTY('还没有 Emby 设备', '点击左侧「添加设备」接入第一台');
    const qbOn = state.merge.qb.filter(o => o.on), embyOnList = state.merge.emby.filter(o => o.on);
    const qi = n => qb.findIndex(d => d.name === n), ei = n => em.findIndex(d => d.name === n);
    return `<div class="merge-bar">
        <span class="mb-ico">${ico('merge', 16)}</span>
        <div class="mb-t"><b>合并显示</b></div>
        <button type="button" class="btn sm" data-merge-edit>${ico('rules', 15)}选择与排序</button>
    </div>
    <div class="merge">
        <div class="merge-col"><div class="col-head"><span class="dot" style="background:var(--qb)"></span>qBittorrent<small>${qbOn.length} 台</small></div>${qbOn.map((o, n) => qbCard(qb[qi(o.name)], qi(o.name), n)).join('')}</div>
        <div class="merge-col"><div class="col-head"><span class="dot" style="background:var(--emby)"></span>Emby<small>${embyOnList.length} 台</small></div>${embyOnList.map((o, n) => embyCard(em[ei(o.name)], ei(o.name), n)).join('')}</div>
    </div>`;
}
