/* 事件记录页：qB 设备事件、Emby 播放 / 选片记录（markup 与改造计划原型一致） */

import * as api from './api.js';
import { q } from './api.js';
import { I } from './icons.js';
import {
    dayTitle, esc, fmtBytes, fmtDuration, hhmm, isLanIp, parseTime, ymd,
} from './format.js';
import { state, embyList, eventsRangeDays } from './store.js';

const DAY = 86400000;
const FOLD_CARET = '<svg class="feed-caret" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const foldOpen = key => !!(state.detailFold && state.detailFold[key]);

/** 设备详情里可折叠区块的标题，桌面只当标题用 */
export function foldHead(key, inner) {
    const open = foldOpen(key);
    return `<button type="button" class="panel-name ev-fold" data-fold="${key}" aria-expanded="${open ? 'true' : 'false'}">${FOLD_CARET}${inner}</button>`;
}

/* ---------- qB 事件 ---------- */
const QB_TYPES = {
    limit_applied: ['danger', 'bolt', '触发达量限速', 'limit'],
    limit_applied_manual: ['violet', 'lim', '手动限速', 'limit'],
    limit_removed_manual: ['ok', 'unlock', '手动解除限速', 'limit'],
    speed_mode_switch: ['info', 'loop', '切换限速模式', 'limit'],
    limit_restored: ['ok', 'unlock', '解除限速', 'plan'],
    traffic_reset: ['warn', 'rst', '清空统计', 'other'],
    instance_added: ['ok', 'plus', '添加设备', 'other'],
    instance_updated: ['info', 'gear', '更新配置', 'other'],
    instance_deleted: ['warn', 'del', '删除设备', 'other'],
    device_online: ['ok', 'wifi', '设备上线', 'alert'],
    device_offline: ['warn', 'wifi', '设备离线', 'alert'],
    torrent_added: ['ok', 'plus', '添加种子', 'torrent'],
    torrent_completed: ['info', 'check', '下载完成', 'torrent'],
    torrent_deleted: ['warn', 'del', '删除种子', 'torrent'],
};

function qbEvent(e) {
    const [cls, icon, title, cat] = QB_TYPES[e.event_type] || ['info', 'info', e.event_type, 'other'];
    const meta = [];
    if (e.speed_limit_kbps !== null && e.speed_limit_kbps !== undefined && cat === 'limit') {
        meta.push(['限速', e.speed_limit_kbps > 0 ? `${e.speed_limit_kbps} KB/s` : '不限速']);
    }
    return { t: parseTime(e.event_time), cls, icon, title, tag: e.instance_name, descParts: e.reason ? [esc(e.reason)] : [], meta, cat, device: e.instance_name };
}

async function loadQb() {
    const res = await api.get(`/api/events${q({ instance: state.eventsDevice, limit: 2000 })}`);
    return (res.data || []).map(qbEvent).filter(e => e.t);
}

/* ---------- Emby 事件 ---------- */
const place = remote => (remote ? '外网' : '局域网');
/** 剧名在书名号里，集数和集名跟在后面 */
function filmLine(r) {
    if (r.series_name) {
        const ep = [r.episode_label, r.episode_title].filter(Boolean).join(' - ');
        return `${filmName(r.series_name)}${ep ? ' ' + esc(ep) : ''}`;
    }
    return filmName(r.item_title || r.episode_title || '未知内容');
}
const client = r => [r.client, r.device_name].filter(Boolean).join(' · ');

const PLAY_KIND = {
    direct_play: '直接播放', direct_stream: '直接串流',
    video_transcode: '仅视频转码', audio_transcode: '仅音频转码', full_transcode: '音视频转码',
};

function fmtBit(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '';
    if (v >= 1e6) return `${+(v / 1e6).toFixed(1)} Mbps`;
    return v >= 1e3 ? `${Math.round(v / 1e3)} Kbps` : `${v} bps`;
}

const REASON_CN = {
    ContainerNotSupported: '容器不支持',
    VideoCodecNotSupported: '视频编码不支持',
    AudioCodecNotSupported: '音频编码不支持',
    SubtitleCodecNotSupported: '字幕编码不支持',
    AudioBitrateNotSupported: '音频码率不支持',
    VideoBitrateNotSupported: '视频码率不支持',
    VideoResolutionNotSupported: '分辨率不支持',
    UnknownVideoStreamInfo: '视频流信息未知',
    UnknownAudioStreamInfo: '音频流信息未知',
    AudioProfileNotSupported: '音频配置不支持',
    AudioSampleRateNotSupported: '音频采样率不支持',
    AudioSampleRateExceedsLimit: '音频采样率超出限制',
    AnamorphicVideoNotSupported: '不支持变形宽银幕',
    InterlacedVideoNotSupported: '不支持隔行扫描',
    VideoInterlacedNotSupported: '不支持隔行扫描',
    AudioBitDepthNotSupported: '音频位深不支持',
    VideoBitDepthNotSupported: '视频位深不支持',
    VideoLevelNotSupported: '视频等级不支持',
    VideoProfileNotSupported: '视频配置不支持',
    AudioChannelsNotSupported: '声道数不支持',
    ContainerBitrateExceedsLimit: '容器码率超出限制',
    VideoFramerateNotSupported: '帧率不支持',
    VideoRangeNotSupported: '动态范围不支持',
    VideoRangeTypeNotSupported: '视频范围类型不支持',
    RefFramesNotSupported: '参考帧数不支持',
    AudioIsExternal: '外挂音轨',
    SecondaryAudioNotSupported: '不支持次要音轨',
    VideoCodecTagNotSupported: '视频编码标签不支持',
    DirectPlayError: '直接播放失败',
    SubtitleFontNotFound: '找不到字幕字体',
};

const reasonText = name => REASON_CN[name] || name;

/** 转码或直连标签上的浮窗，不含 IP */
function playTip(r) {
    const rows = [];
    const kind = PLAY_KIND[r.transcode_kind] || (r.play_method === 'Transcode' ? '转码' : '');
    if (kind) rows.push(['播放方式', kind]);
    const fps = Number(r.framerate);
    const video = [r.video_codec, r.width && r.height ? `${r.width}×${r.height}` : '', fps > 0 && fps <= 120 ? `${+fps.toFixed(2)} fps` : '', fmtBit(r.video_bitrate)].filter(Boolean).join(' · ');
    if (video) rows.push(['视频', video]);
    const audio = [r.audio_codec, r.audio_channels ? `${r.audio_channels} 声道` : '', fmtBit(r.audio_bitrate)].filter(Boolean).join(' · ');
    if (audio) rows.push(['音频', audio]);
    if (r.container) rows.push(['容器', r.container]);
    if (r.video_decoder) rows.push(['解码', r.video_decoder]);
    if (r.video_encoder) rows.push(['编码', r.video_encoder_is_hardware === false ? `CPU · ${r.video_encoder}` : r.video_encoder]);
    const reasons = (Array.isArray(r.transcode_reasons) ? r.transcode_reasons : []).filter(Boolean).map(reasonText);
    if (reasons.length) rows.push(['转码原因', reasons.join('、')]);
    return rows;
}

export function playMode(r) {
    if (!r.play_method && !r.transcode_kind) return null;
    const transcode = r.play_method === 'Transcode' || ['video_transcode', 'audio_transcode', 'full_transcode'].includes(r.transcode_kind);
    return { label: transcode ? '转码' : '直连', cls: transcode ? 'xc' : 'direct', tip: playTip(r) };
}

function playbackEvent(r) {
    const playing = r.status === 'playing';
    const interrupted = !!r.interrupt_reason;
    const t0 = parseTime(r.started_at);
    const stopped = parseTime(r.stopped_at);
    const t1 = playing ? null : (stopped || t0);
    const t = t1 || t0;
    const bytes = r.estimated_upload_bytes ?? r.live_upload_checkpoint_bytes;
    const missed = !!(r.is_remote && !bytes && r.upload_anomaly);
    const uploadLabel = bytes ? fmtBytes(bytes, 1000) : (missed ? '异常' : (playing ? '统计中' : '0'));
    const run = Number(r.runtime_seconds) || 0;
    const pos = Number(r.end_position_seconds ?? r.start_position_seconds) || 0;
    return {
        t, t0, t1: t0 && t1 && t1.getTime() !== t0.getTime() ? t1 : null,
        cls: interrupted ? 'warn' : playing ? 'ok' : 'gray', icon: interrupted ? 'warn' : playing ? (r.is_paused ? 'pause' : 'film') : 'stop',
        title: interrupted ? '播放中断' : playing ? (r.is_paused ? '暂停播放' : '正在播放') : '播放结束',
        sid: playing ? (r.emby_session_id || '') : '',
        place: place(r.is_remote),
        descParts: [filmLine(r), client(r) ? esc(client(r)) : '', interrupted ? esc(r.interrupt_reason) : ''].filter(Boolean),
        meta: [], prog: run > 0 ? Math.min(100, Math.max(0, pos) / run * 100) : null,
        pos, run, played: playedText(r.played_seconds),
        cat: interrupted ? 'alert' : 'play', device: r.instance_name, user: r.user_name, lan: !r.is_remote,
        pin: playing && !interrupted ? (r.is_paused ? 1 : 0) : null,
        ipTip: [['IP 地址', r.client_ip || '未记录']],
        mode: playMode(r),
        uploadAnomaly: missed,
        upload: r.is_remote ? `上传 ${uploadLabel}` : '',
    };
}

function browseEvent(r) {
    const lan = isLanIp(r.client_ip);
    const title = r.series_name || r.viewing_title || r.episode_title;
    return {
        t: parseTime(r.stopped_at), cls: 'violet', icon: 'eye', title: '选片记录',
        place: place(!lan),
        descParts: [`浏览${title ? filmName(title) : '影片'}`, client(r) ? esc(client(r)) : ''].filter(Boolean),
        meta: [['选片流量', fmtBytes(r.estimated_upload_bytes, 1000)]],
        cat: 'browse', device: r.instance_name, user: r.user_name, lan,
        ipTip: [['IP 地址', r.client_ip || '未记录']],
    };
}

/** 正在播放的会话才带编码器名称，补到对应的播放记录上 */
async function fillEncoder(rows) {
    if (!rows.length) return rows;
    let live = [];
    try { live = (await api.get('/api/emby/sessions')).data || []; } catch (e) { return rows; }
    const byId = new Map(live.filter(s => s.id).map(s => [s.id, s]));
    return rows.map(r => {
        const s = byId.get(r.emby_session_id);
        if (r.status !== 'playing' || !s) return r;
        const transcode = r.play_method === 'Transcode' || ['video_transcode', 'audio_transcode', 'full_transcode'].includes(r.transcode_kind);
        const next = { ...r, is_paused: !!s.is_paused };
        if (Number(s.runtime_seconds) > 0) next.runtime_seconds = Number(s.runtime_seconds);
        if (s.position_seconds != null) next.end_position_seconds = Number(s.position_seconds) || 0;
        // 会话编号会被同一客户端复用，编码器只补到当前这条转码上
        if (!transcode || !(s.video_encoder || s.video_decoder)) return next;
        const own = !!(r.video_encoder || r.video_decoder);
        return {
            ...next,
            video_decoder: r.video_decoder || s.video_decoder || '',
            video_encoder: r.video_encoder || s.video_encoder || '',
            video_encoder_is_hardware: own && r.video_encoder_is_hardware != null ? r.video_encoder_is_hardware : s.video_encoder_is_hardware,
        };
    });
}

async function loadEmby() {
    const names = state.eventsDevice ? [state.eventsDevice] : embyList().map(d => d.name);
    const [playback, ...browses] = await Promise.all([
        api.get(`/api/emby/playback-records${q({ instance: state.eventsDevice, days: 90, limit: 5000 })}`).then(r => r.data || []).catch(() => []),
        ...names.map(n => api.get(`/api/emby/browse-records${q({ instance: n, days: 90, limit: 5000 })}`).then(r => r.data || []).catch(() => [])),
    ]);
    const plays = (await fillEncoder(playback)).map(playbackEvent);
    return [...plays, ...browses.flat().map(browseEvent)].filter(e => e.t);
}

/** 单点为 2026-10-19 23:12，时间段为 2026-10-19 23:12~13:52（同一分钟也保留） */
function timeLabel(e) {
    const start = e.t0 || e.t;
    if (!start) return '';
    const head = `${ymd(start)} ${hhmm(start)}`;
    if (!e.t1) return head;
    return `${head}~${hhmm(e.t1)}`;
}

/** 实际播放时长，用于右上角时间的悬浮文案 */
function playedText(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (!s) return '';
    return `${Math.floor(s / 60)}分${s % 60}秒`;
}

/** 事件卡片里的影片名带书名号 */
function filmName(name) {
    return `《${esc(name)}》`;
}

function tipHtml(rows) {
    return (rows || []).map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
}

export const UPLOAD_ANOMALY_TIP = '反代规则没有这条连接，请检查设置。';

export function anomalyTip() {
    return `<span class="ev-tip-src" hidden><div class="ev-note">${esc(UPLOAD_ANOMALY_TIP)}</div></span>`;
}

export function tipTag(text, cls, rows) {
    const tip = rows && rows.length ? `<span class="ev-tip-src" hidden>${tipHtml(rows)}</span>` : '';
    return `<span class="tag ${cls}${tip ? ' has-tip' : ''}">${esc(text)}${tip}</span>`;
}

function eventCard(e, kind) {
    const who = e.user && e.place ? `${e.user} · ${e.place}` : (e.user || '');
    const whoTag = who ? tipTag(who, e.lan ? 'who lan' : 'who', e.ipTip) : '';
    const modeTag = e.mode ? tipTag(e.mode.label, e.mode.cls, e.mode.tip) : '';
    const upTag = e.upload
        ? (e.uploadAnomaly
            ? `<span class="tag up warn has-tip">${esc(e.upload)}${anomalyTip()}</span>`
            : `<span class="tag up">${esc(e.upload)}</span>`)
        : '';
    const devName = state.eventsDevice ? '' : (e.showDevice ? e.device : (!who && e.tag ? e.tag : ''));
    const devTag = devName ? `<span class="tag ${kind}">${esc(devName)}</span>` : '';
    const prog = e.prog == null ? '' : `<div class="ev-prog${e.cls === 'gray' ? ' gray' : ''}"><i style="width:${e.prog.toFixed(1)}%"></i></div><div class="ev-prog-time num">${fmtDuration(e.pos)} / ${fmtDuration(e.run)}</div>`;
    const dur = e.played ? `<span class="ev-tip-src" hidden>${tipHtml([['时长', e.played]])}</span>` : '';
    return `<article class="ev-item"${e.sid ? ` data-play="${esc(e.sid)}"` : ''}>
        <div class="ev-item-top">
            <time class="num${dur ? ' has-tip' : ''}">${timeLabel(e)}${dur}</time>
            <span class="ev-head"><span class="ev-name"><span class="ev-ico ${e.cls}">${I[e.icon]}</span><b title="${esc(e.title)}">${esc(e.title)}</b></span>
            ${(whoTag + modeTag + upTag + devTag) ? `<span class="ev-tags">${whoTag}${modeTag}${upTag}${devTag}</span>` : ''}</span>
        </div>
        ${(e.descParts || []).length ? `<div class="ev-desc">${e.descParts.map(part => `<span>${part}</span>`).join('')}</div>` : ''}
        ${e.meta.length ? `<div class="ev-meta">${e.meta.map(m => `<span>${esc(m[0])} <b>${esc(m[1])}</b></span>`).join('')}</div>` : ''}
        ${prog}
    </article>`;
}

/** 正在播放的卡片用当前会话的片内位置，进度跟着影片走 */
export function syncPlayProgress() {
    const live = new Map();
    embyList().forEach(d => (d.sessions || []).forEach(s => {
        if (s.id && s.session_mode !== 'browsing') live.set(s.id, s);
    }));
    document.querySelectorAll('.ev-item[data-play]').forEach(el => {
        const s = live.get(el.dataset.play);
        const run = Number(s && s.runtime_seconds) || 0;
        if (!s || run <= 0) return;
        const pos = Number(s.position_seconds) || 0;
        const bar = el.querySelector('.ev-prog i');
        if (bar) bar.style.width = `${Math.min(100, Math.max(0, pos) / run * 100).toFixed(1)}%`;
        const clock = el.querySelector('.ev-prog-time');
        if (clock) clock.textContent = `${fmtDuration(pos)} / ${fmtDuration(run)}`;
    });
}

let popBound = false;
/** 用户名标签的浮窗挂到页面上，避免被事件卡片的滚动区域裁切 */
export function bindEventPop() {
    if (popBound) return;
    popBound = true;
    const pop = document.createElement('div');
    pop.id = 'evPop';
    pop.className = 'ev-pop';
    document.body.appendChild(pop);
    let current = null;
    const hoverOk = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
    const hide = () => { current = null; pop.classList.remove('show'); };
    const place = tag => {
        const html = tag.querySelector('.ev-tip-src')?.innerHTML;
        if (!html) { hide(); return; }
        current = tag;
        pop.innerHTML = html;
        pop.classList.add('show');
        const r = tag.getBoundingClientRect();
        const w = pop.offsetWidth, h = pop.offsetHeight;
        const bar = document.querySelector('.detail-tabs');
        const barH = bar && getComputedStyle(bar).display !== 'none' ? bar.offsetHeight : 0;
        let left = Math.min(Math.max(8, r.right - w), innerWidth - w - 8);
        left = Math.max(8, left);
        let top = r.bottom + 6;
        if (top + h > innerHeight - 8 - barH) top = Math.max(8, r.top - h - 6);
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
    };
    document.addEventListener('mouseover', e => {
        if (!hoverOk()) return;
        const tag = e.target.closest?.('.has-tip');
        if (tag) place(tag);
        else if (!pop.contains(e.target)) hide();
    });
    document.addEventListener('mouseout', e => {
        if (!hoverOk()) return;
        const tag = e.target.closest?.('.has-tip');
        if (!tag) return;
        const to = e.relatedTarget;
        if (to && (tag.contains(to) || pop.contains(to))) return;
        hide();
    });
    let touched = false;
    const toggle = tag => { if (current === tag) hide(); else place(tag); };
    document.addEventListener('pointerup', e => {
        if (e.pointerType === 'mouse') return;
        touched = true;
        const tag = e.target.closest?.('.has-tip');
        if (tag) toggle(tag);
        else if (!pop.contains(e.target)) hide();
    });
    document.addEventListener('click', e => {
        if (touched) { touched = false; return; }
        if (hoverOk()) return;
        const tag = e.target.closest?.('.has-tip');
        if (tag) toggle(tag);
        else if (!pop.contains(e.target)) hide();
    });
    pop.addEventListener('mouseleave', hide);
    document.addEventListener('scroll', hide, true);
}

/* ---------- 页面 ---------- */
const TYPE_TABS = [['all', '全部'], ['torrent', '种子'], ['limit', '限速'], ['plan', '周期计划'], ['alert', '异常']];
const RANGES = [[7, '最近 7 天'], [30, '最近 30 天'], [90, '最近 90 天']];

/** 取数据并生成 html */
export async function renderEvents(kind) {
    state.eventsDays = eventsRangeDays(state.eventsDays);
    const all = (kind === 'emby' ? await loadEmby() : await loadQb()).sort((a, b) => b.t - a.t);
    const since = Date.now() - state.eventsDays * DAY;
    let list = all.filter(e => e.t.getTime() >= since);
    if (kind === 'emby') {
        if (state.eventsHideLan) list = list.filter(e => !e.lan);
        if (state.eventsUser) list = list.filter(e => e.user === state.eventsUser);
    }
    const users = kind === 'emby' ? [...new Set(all.map(e => e.user).filter(Boolean))] : [];
    const tabs = kind === 'qb' ? TYPE_TABS.map(([k, label]) => [k, label, k === 'all' ? list.length : list.filter(e => e.cat === k).length]) : [];
    const shown = tabs.length && state.eventsType !== 'all' ? list.filter(e => e.cat === state.eventsType) : list;
    if (kind === 'emby' && !state.eventsDevice) shown.forEach(e => { e.showDevice = true; });

    const pinOf = e => e.pin == null ? 9 : e.pin;
    const pinned = shown.filter(e => pinOf(e) < 9).sort((a, b) => pinOf(a) - pinOf(b) || b.t - a.t);
    const rest = shown.filter(e => pinOf(e) >= 9);
    const groups = [];
    rest.forEach(e => {
        const [day, date] = dayTitle(e.t);
        const last = groups[groups.length - 1];
        if (last && last.day === day && last.date === date) last.list.push(e);
        else groups.push({ day, date, list: [e] });
    });
    if (pinned.length) {
        const [day, date] = dayTitle(new Date());
        const first = groups[0];
        if (first && first.day === day && first.date === date) first.list = pinned.concat(first.list);
        else groups.unshift({ day, date, list: pinned });
    }

    const fold = !!state.eventsDevice;
    const open = foldOpen('events');
    const head = fold ? foldHead('events', `${I.list}事件记录`) : '';
    return `
    <div class="panel${fold && open ? ' open' : ''}">
        ${head}
        <div class="toolbar">
            ${kind === 'emby' ? `<span class="field"><span class="k">用户</span><select id="evUser"><option value="">全部用户</option>${users.map(u => `<option value="${esc(u)}" ${u === state.eventsUser ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>${I.chev}</span>` : ''}
            ${tabs.length ? `<div class="tabs" data-evtype>${tabs.map(t => `<button data-v="${t[0]}" class="${state.eventsType === t[0] ? 'on' : ''}">${t[1]}<span class="c">${t[2]}</span></button>`).join('')}</div>` : ''}
            <div class="tool-r">
                ${kind === 'emby' ? `<span class="field" data-hidelan style="cursor:pointer">排除局域网 <span class="switch ${state.eventsHideLan ? 'on' : ''}" style="transform:scale(.8);margin-right:-6px"></span></span>` : ''}
                <span class="field">${I.cal.replace(/16/g, '14')}<select id="evDays">${RANGES.map(([v, l]) => `<option value="${v}" ${v === state.eventsDays ? 'selected' : ''}>${l}</option>`).join('')}</select></span>
            </div>
        </div>
        <div class="timeline">${groups.map(g => `
        <div class="day">${g.day}<small>${g.date}</small></div>
        ${g.list.map(e => eventCard(e, kind)).join('')}`).join('') || '<div style="padding:40px;text-align:center;color:var(--text-3)">没有匹配的事件</div>'}
    </div></div>`;
}

