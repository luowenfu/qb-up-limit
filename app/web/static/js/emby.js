/** Emby 只读展示模块 */

const EMBY_TAB_STORAGE_KEY = 'qb_uplimit_emby_tab';
const VALID_EMBY_TABS = new Set(['devices', 'stats', 'events', 'syslogs']);
let embyNavExpanded = false;
let embyCurrentTab = 'devices';
let cachedEmbyInstances = [];

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
    return String(event?.device_name || '').trim();
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

function buildEmbySessionCompactFooterHtml(session) {
    const runtime = parseInt(session.runtime_seconds, 10) || 0;
    if (runtime <= 0) return '';
    const pos = parseInt(session.position_seconds, 10) || 0;
    const pct = getEmbySessionProgressPercent(pos, runtime, session.progress_percent);
    const timeText = getEmbySessionTimeText(pos, runtime, pct);
    return `<div class="emby-session-footer">
        <div class="emby-session-progress">
            <div class="emby-session-progress-bar">
                <div class="emby-session-progress-fill" style="width:${pct}%"></div>
            </div>
        </div>
        <div class="emby-session-footer-row">
            ${buildEmbySessionControlsHtml(session)}
            <div class="emby-session-time" data-position="${pos}" data-runtime="${runtime}" data-pct="${pct}" data-paused="${session.is_paused ? '1' : '0'}" data-synced="${Date.now()}">${escapeHtml(timeText)}</div>
        </div>
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

function applyEmbySessionFooterEl(el, session) {
    if (!el) return;
    applyEmbySessionTimeEl(el.querySelector('.emby-session-time'), session);
}

let embySessionTimeTicker = null;

function tickEmbySessionTimes() {
    const now = Date.now();
    document.querySelectorAll('.emby-session-time').forEach(el => {
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
    if (embySessionTimeTicker) return;
    embySessionTimeTicker = setInterval(tickEmbySessionTimes, 1000);
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
    const metaEl = el.querySelector('.emby-session-meta');
    if (metaEl) {
        const metaHtml = buildEmbySessionMetaLine(session);
        if (metaEl.innerHTML !== metaHtml) metaEl.innerHTML = metaHtml;
    }
    const oldStandaloneTime = el.querySelector(':scope > .emby-session-time');
    if (oldStandaloneTime) oldStandaloneTime.remove();
    const footerEl = el.querySelector('.emby-session-footer');
    const footerHtml = buildEmbySessionCompactFooterHtml(session);
    if (footerEl) {
        applyEmbySessionFooterEl(footerEl, session);
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
    const parts = [
        session.user_name,
        session.client || session.device_name,
        session.remote_endpoint,
        formatEmbyKbps(session.bitrate),
    ].filter(Boolean);
    const codecs = [session.video_codec, session.audio_codec].filter(Boolean).join(' / ');
    if (codecs) parts.push(codecs);
    const res = formatEmbyResolution(session.width, session.height);
    if (res) parts.push(res);
    return parts.map(p => escapeHtml(String(p))).join(' · ');
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
            <div class="emby-session-meta">${buildEmbySessionMetaLine(session)}</div>
            ${compact ? buildEmbySessionCompactFooterHtml(session) : buildEmbySessionProgressHtml(session)}
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
    const filtered = (inst?.sessions || []).filter(s => s.is_playing || s.item_id || s.title);
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

function initEmby() {
    if (typeof getChartPlatform === 'function' && getChartPlatform() === 'emby') {
        if (typeof syncChartInstanceSelectForPlatform === 'function') {
            syncChartInstanceSelectForPlatform();
        }
    }
    document.addEventListener('click', (e) => {
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
    if (embyCurrentTab === 'events') await loadEmbyEvents(silent);
    if (typeof currentTab !== 'undefined' && currentTab === 'syslogs'
        && typeof getSyslogTypeFilter === 'function' && getSyslogTypeFilter() === 'emby') {
        await loadEmbySystemLogs(silent);
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
        if (typeof embyCurrentTab !== 'undefined' && embyCurrentTab === 'events'
            && getEmbyEventLogType() === 'playback') {
            if (_lastPlaybackRecords.some(r => r.status === 'playing')) {
                renderPlaybackRecords(_lastPlaybackRecords);
            }
            if (typeof loadEmbyPlaybackRecords === 'function') {
                await loadEmbyPlaybackRecords(true);
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
        cachedEmbyInstances = response.data.data || [];
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
        syslogSel.add(new Option('全部设备', ''));
        names.forEach(name => {
            syslogSel.add(new Option(name, name));
        });
        let syslogChanged = false;
        if (prevSyslog === '' || names.includes(prevSyslog)) {
            syslogSel.value = prevSyslog;
        } else {
            if (prevSyslog !== '') syslogChanged = true;
            syslogSel.value = '';
        }
        if (syslogChanged && typeof currentTab !== 'undefined' && currentTab === 'syslogs'
            && typeof getSyslogTypeFilter === 'function' && getSyslogTypeFilter() === 'emby'
            && typeof loadSyslogsForCurrentType === 'function') {
            loadSyslogsForCurrentType(true);
        }
        sessionStorage.setItem('qb-up-limit-syslog-instance-emby', syslogSel.value || '');
    }
    if (eventInstanceChanged && embyCurrentTab === 'events') {
        loadEmbyEvents(true);
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

function getEmbyRecentDisplays(inst) {
    const refreshSec = inst.refresh_interval || 1;
    if (!inst.api_online && !inst.docker_available) {
        return { upload: '--', download: '--', refreshSec };
    }
    return {
        upload: formatCardTrafficText(inst.recent_delta_bytes || 0),
        download: formatCardTrafficText(inst.recent_delta_download_bytes || 0),
        refreshSec,
    };
}

function formatEmbyCollectStatusLabel(inst) {
    if (!inst.docker_available) return '未采集';
    return `正常 · ${inst.collect_interval || 15}秒刷新`;
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

function getEmbyDataPanelAccentClass(inst) {
    return inst.docker_available ? 'panel-accent--ok' : 'panel-accent--offline';
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

function buildEmbyDockerPopoverContent(inst) {
    const container = inst.container_name || inst.container_id || '未配置';
    if (inst.docker_available) {
        return `
            <div class="badge-popover-title">Docker 流量采集正常</div>
            <div class="badge-popover-meta badge-popover-meta--emph">${escapeHtml(container)}</div>
            <div class="badge-popover-meta">采集间隔 ${inst.collect_interval || 15} 秒</div>`;
    }
    return `
        <div class="badge-popover-title">Docker 未采集</div>
        <div class="badge-popover-meta">${escapeHtml(container)}</div>
        <div class="badge-popover-meta">请配置容器名/ID 并挂载 docker.sock</div>`;
}

function buildEmbyInstanceBadgesRightHTML(inst) {
    const apiOk = !!inst.api_online;
    const dockerOk = !!inst.docker_available;
    const count = inst.session_count || 0;
    let html = wrapStatusBadgePopover(
        `<span class="status-badge ${apiOk ? 'online' : 'offline'}">${buildInfoMetricIcon('plan')}<span data-field="badge-api">API ${apiOk ? '在线' : '离线'}</span></span>`,
        buildEmbyApiPopoverContent(inst),
        apiOk ? 'online' : 'offline',
    );
    html += wrapStatusBadgePopover(
        `<span class="status-badge ${dockerOk ? 'online' : 'offline'} emby-badge-docker">${buildInfoMetricIcon('upload')}<span data-field="badge-docker">Docker ${dockerOk ? '采集' : '未采集'}</span></span>`,
        buildEmbyDockerPopoverContent(inst),
        dockerOk ? 'online' : 'offline',
    );
    html += `<span class="status-badge emby-badge-sessions" data-field="session-count-badge"><span>${count} 路播放</span></span>`;
    return html;
}

function buildEmbyInstanceInfoHTML(inst) {
    const recent = getEmbyRecentDisplays(inst);
    const presenceAccent = getEmbyPresencePanelAccentClass(inst);
    const dataAccent = getEmbyDataPanelAccentClass(inst);
    const addressHtml = typeof buildDeviceAddressMaskHtml === 'function'
        ? buildDeviceAddressMaskHtml(formatEmbyAddress(inst))
        : escapeHtml(formatEmbyAddress(inst));
    const containerLabel = inst.container_name || inst.container_id || '--';
    const collectLabel = formatEmbyCollectStatusLabel(inst);
    const playbackCountsLabel = formatEmbyPlaybackCountsLabel(inst);

    return `
        <div class="info-panel">
            <div class="info-panel-basic">
                <div class="info-panel-section-head info-panel-basic-head ${presenceAccent}">
                    ${buildEmbyAddressEndpointHTML(inst)}
                    <span class="info-panel-basic-head-address">${addressHtml}</span>
                </div>
                <div class="info-panel-inline info-panel-table">
                    ${buildInfoMetricRow('Docker容器名', escapeHtml(containerLabel), {
                        metricClass: 'info-metric--row info-metric--cycle',
                        valueClass: 'info-value-cycle-range info-value-emby-container',
                        icon: 'plan',
                    })}
                    ${buildInfoMetricRow('流量采集', escapeHtml(collectLabel), {
                        metricClass: 'info-metric--row info-metric--cycle',
                        valueClass: 'info-value-cycle-range info-value-emby-collect',
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
                    ${buildInfoMetricCell('今日上传', formatCardTrafficText(inst.today_uploaded_bytes || 0), {
                        valueClass: 'info-value-emby-today-up info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('今日下载', formatCardTrafficText(inst.today_downloaded_bytes || 0), {
                        valueClass: 'info-value-emby-today-down info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('昨日上传', formatCardTrafficText(inst.yesterday_uploaded_bytes || 0), {
                        valueClass: 'info-value-emby-yesterday-up info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('昨日下载', formatCardTrafficText(inst.yesterday_downloaded_bytes || 0), {
                        valueClass: 'info-value-emby-yesterday-down info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('本月上传', formatCardTrafficText(inst.monthly_uploaded_bytes || 0), {
                        valueClass: 'info-value-emby-month-up info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('本月下载', formatCardTrafficText(inst.monthly_downloaded_bytes || 0), {
                        valueClass: 'info-value-emby-month-down info-metric-value--traffic',
                    })}
                    ${buildInfoMetricCell('设备总上传', formatCardTrafficText(inst.device_uploaded_bytes || 0), {
                        valueClass: 'info-value-emby-device-up info-metric-value--total',
                    })}
                    ${buildInfoMetricCell('设备总下载', formatCardTrafficText(inst.device_downloaded_bytes || 0), {
                        valueClass: 'info-value-emby-device-down info-metric-value--total',
                    })}
                </div>
                <p class="info-panel-data-hint info-metric-label">局域网流量不计入统计，不保证准确性</p>
            </div>
        </div>`;
}

function buildEmbySessionsBlockHTML(inst) {
    const sessions = getEmbyActivePlaybackSessions(inst);
    const count = sessions.length;
    const headerActions = typeof buildRulesHeaderActionsHtml === 'function'
        ? buildRulesHeaderActionsHtml('emby', inst.name)
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
    setText('.info-value-emby-today-up', formatCardTrafficText(inst.today_uploaded_bytes || 0));
    setText('.info-value-emby-today-down', formatCardTrafficText(inst.today_downloaded_bytes || 0));
    setText('.info-value-emby-yesterday-up', formatCardTrafficText(inst.yesterday_uploaded_bytes || 0));
    setText('.info-value-emby-yesterday-down', formatCardTrafficText(inst.yesterday_downloaded_bytes || 0));
    setText('.info-value-emby-month-up', formatCardTrafficText(inst.monthly_uploaded_bytes || 0));
    setText('.info-value-emby-month-down', formatCardTrafficText(inst.monthly_downloaded_bytes || 0));
    setText('.info-value-emby-device-up', formatCardTrafficText(inst.device_uploaded_bytes || 0));
    setText('.info-value-emby-device-down', formatCardTrafficText(inst.device_downloaded_bytes || 0));

    setText('.info-value-emby-collect', formatEmbyCollectStatusLabel(inst));
    setText('.info-value-emby-playback-count', formatEmbyPlaybackCountsLabel(inst));

    const apiBadge = card.querySelector('[data-field="badge-api"]');
    if (apiBadge) apiBadge.textContent = `API ${inst.api_online ? '在线' : '离线'}`;
    const dockerBadge = card.querySelector('[data-field="badge-docker"]');
    if (dockerBadge) dockerBadge.textContent = `Docker ${inst.docker_available ? '采集' : '未采集'}`;

    const count = getEmbyActivePlaybackSessions(inst).length;
    const countBadge = card.querySelector('[data-field="session-count-badge"] span');
    if (countBadge) countBadge.textContent = `${count} 路播放`;

    patchEmbyAddressPresence(inst, card);

    const sessionsTitle = card.querySelector('[data-field="sessions-title"]');
    if (sessionsTitle) {
        sessionsTitle.textContent = count
            ? `当前播放会话 (${count})`
            : '当前播放会话';
    }

    const activeSessions = getEmbyActivePlaybackSessions(inst);
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
    const nameMax = typeof INSTANCE_NAME_MAX_LENGTH !== 'undefined' ? INSTANCE_NAME_MAX_LENGTH : 16;
    const priorityMax = typeof DISPLAY_PRIORITY_MAX !== 'undefined' ? DISPLAY_PRIORITY_MAX : 99999;
    const displayPriority = inst?.display_priority ?? (mode === 'add' ? cachedEmbyInstances.length + 1 : 1);
    const wanOnly = inst?.wan_traffic_only !== false;

    return `
        <div class="modal-form modal-form--instance modal-form--emby">
            <div class="form-section form-section--notice">
                <h3>使用须知</h3>
                <p class="form-hint form-hint--field form-hint--notice">通过 Docker 容器网络统计 Emby 上下行流量；需挂载宿主机 <code>/var/run/docker.sock</code>。API Key 用于读取播放会话与活动日志，不参与限速控制。</p>
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
                        <input type="text" id="${prefix}EmbyHostPort" value="${escapeHtml(hostPort)}"
                               placeholder="192.168.1.10:8096" />
                    </label>
                    <p class="form-hint form-hint--field">如 192.168.1.1:8096，不要写协议；HTTPS 由下方勾选控制</p>
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
                        <button type="button" class="btn-secondary btn-sm" id="${prefix}EmbyConnectTestBtn">🔍 API 连通性测试</button>
                    </div>
                    <div id="${prefix}EmbyConnectTestResult" class="test-result"></div>
                </div>
            </div>
            <div class="form-section form-section--traffic form-section-last">
                <h3>流量采集</h3>
                <div class="form-row">
                    <div class="form-field">
                        <label>Docker 容器名
                            <input type="text" id="${prefix}EmbyContainerName" value="${escapeHtml(inst?.container_name || '')}"
                                   placeholder="emby" />
                        </label>
                        <p class="form-hint form-hint--field">与容器 ID 二选一，用于读取网络统计</p>
                    </div>
                    <div class="form-field">
                        <label>Docker 容器 ID
                            <input type="text" id="${prefix}EmbyContainerId" value="${escapeHtml(inst?.container_id || '')}"
                                   placeholder="可选" />
                        </label>
                    </div>
                </div>
                <div class="form-field">
                    <div class="form-row form-row--checkboxes">
                        <label class="checkbox-label">
                            <input type="checkbox" id="${prefix}EmbyWanTrafficOnly" ${wanOnly ? 'checked' : ''} />
                            仅统计外网流量
                        </label>
                    </div>
                    <p class="form-hint form-hint--field">开启后局域网播放会话不计入；按客户端 IP 与码率比例从 Docker 总量中估算外网部分</p>
                </div>
                <div class="connection-test-panel">
                    <div class="test-actions">
                        <button type="button" class="btn-secondary btn-sm" id="${prefix}EmbyDockerTestBtn">🐳 Docker 容器测试</button>
                    </div>
                    <div id="${prefix}EmbyDockerTestResult" class="test-result"></div>
                </div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-primary" id="saveEmbyInstanceBtn">✔ 保存</button>
                <button type="button" class="btn-secondary" onclick="closeModal()">✖ 取消</button>
            </div>
        </div>`;
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
    const connectBtn = document.getElementById(`${mode}EmbyConnectTestBtn`);
    const dockerBtn = document.getElementById(`${mode}EmbyDockerTestBtn`);
    if (connectBtn) {
        connectBtn.onclick = () => runEmbyInstanceTest(mode, originalName, 'connect');
    }
    if (dockerBtn) {
        dockerBtn.onclick = () => runEmbyInstanceTest(mode, originalName, 'docker');
    }
    bindEmbyHttpsSslToggle(mode);
}

function bindSaveEmbyInstanceBtn(mode, originalName) {
    const btn = document.getElementById('saveEmbyInstanceBtn');
    if (btn) {
        btn.onclick = () => saveEmbyInstanceSettings(mode, originalName);
    }
}

function setEmbyTestButtonsState(prefix, activeType, running) {
    const meta = {
        connect: { btn: `${prefix}EmbyConnectTestBtn`, running: '⏳ API 测试中…', label: '🔍 API 连通性测试' },
        docker: { btn: `${prefix}EmbyDockerTestBtn`, running: '⏳ Docker 测试中…', label: '🐳 Docker 容器测试' },
    };
    ['connect', 'docker'].forEach(type => {
        const info = meta[type];
        const btn = document.getElementById(info.btn);
        if (!btn) return;
        btn.disabled = running;
        btn.textContent = running && type === activeType ? info.running : info.label;
    });
}

function showEmbyTestResult(data, prefix, testType) {
    const resultId = testType === 'docker'
        ? `${prefix}EmbyDockerTestResult`
        : `${prefix}EmbyConnectTestResult`;
    const resultDiv = document.getElementById(resultId);
    const passText = testType === 'docker' ? 'Docker 测试通过' : 'API 测试通过';
    const failText = testType === 'docker' ? 'Docker 测试失败' : 'API 测试失败';

    let detailHtml = '';
    if (testType === 'connect' && data.data) {
        const d = data.data;
        const lines = [
            d.server_name ? `服务器：${escapeHtml(d.server_name)}` : '',
            d.version ? `版本：${escapeHtml(d.version)}` : '',
        ].filter(Boolean);
        if (lines.length) {
            detailHtml = `<div class="test-step ok"><span class="test-step-msg">${lines.join(' · ')}</span></div>`;
        }
    } else if (testType === 'docker' && data.data) {
        const d = data.data;
        const label = d.container_name || d.container_id || '容器';
        detailHtml = `<div class="test-step ok"><span class="test-step-msg">${escapeHtml(label)}（${escapeHtml(d.state || 'running')}）</span></div>`;
    }

    if (resultDiv) {
        const summary = data.success
            ? `<div class="test-summary ok">${passText}</div>`
            : `<div class="test-summary fail">${failText}</div>`;
        const errHtml = !data.success
            ? `<div class="test-step fail"><span class="test-step-msg">${escapeHtml(data.error || failText)}</span></div>`
            : '';
        resultDiv.innerHTML = summary + detailHtml + errHtml;
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

function validateEmbySaveForm(data, mode) {
    const nameMax = typeof INSTANCE_NAME_MAX_LENGTH !== 'undefined' ? INSTANCE_NAME_MAX_LENGTH : 16;
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
    if (!data.container_name && !data.container_id) {
        if (typeof showToast === 'function') showToast('请填写 Docker 容器名或容器 ID', 'error');
        return false;
    }
    return true;
}

async function runEmbyInstanceTest(mode, originalName, testType) {
    const prefix = mode;
    if (embyRunningTests.has(prefix)) return;

    const data = collectEmbyFormData(mode);
    if (testType === 'connect' && !validateEmbyTestForm(data)) return;
    if (testType === 'docker' && !data.container_name && !data.container_id) {
        if (typeof showToast === 'function') showToast('请填写 Docker 容器名或容器 ID', 'error');
        return;
    }

    embyRunningTests.add(prefix);
    const resultId = testType === 'docker'
        ? `${prefix}EmbyDockerTestResult`
        : `${prefix}EmbyConnectTestResult`;
    const resultDiv = document.getElementById(resultId);
    const runningHint = testType === 'docker' ? '正在测试 Docker 容器，请稍候…' : '正在测试 API 连通性，请稍候…';
    setEmbyTestButtonsState(prefix, testType, true);
    if (resultDiv) resultDiv.innerHTML = `<div class="test-running">${runningHint}</div>`;

    try {
        const res = await axios.post('/api/emby/config/instances/test', {
            ...data,
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
    return {
        name: String(document.getElementById(`${prefix}EmbyName`)?.value || '').trim(),
        display_priority: parseInt(document.getElementById(`${prefix}EmbyDisplayPriority`)?.value, 10) || 1,
        host: parsed.host,
        port: parsed.port,
        use_https: !!document.getElementById(`${prefix}EmbyHttps`)?.checked,
        verify_ssl: !!document.getElementById(`${prefix}EmbyVerifySsl`)?.checked,
        api_key: String(document.getElementById(`${prefix}EmbyApiKey`)?.value || '').trim(),
        container_name: String(document.getElementById(`${prefix}EmbyContainerName`)?.value || '').trim(),
        container_id: String(document.getElementById(`${prefix}EmbyContainerId`)?.value || '').trim(),
        wan_traffic_only: !!document.getElementById(`${prefix}EmbyWanTrafficOnly`)?.checked,
    };
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
    if (saveBtn) saveBtn.disabled = true;

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
            if (typeof showToast === 'function') showToast(res.data.message || '保存成功', 'success');
            if (typeof closeModal === 'function') closeModal();
            if (typeof refreshEmbyFeatureLockState === 'function') {
                await refreshEmbyFeatureLockState();
            }
            await refreshEmbyStatus(true);
            if (typeof switchTab === 'function') switchTab(currentTab || 'devices');
        } else if (typeof showToast === 'function') {
            showToast(res.data.error || '保存失败', 'error');
        }
    } catch (e) {
        const msg = e.response?.data?.error || '保存失败';
        if (typeof showToast === 'function') showToast(msg, 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
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
            if (typeof switchTab === 'function') switchTab(currentTab || 'devices');
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

function getEmbyEventPlaybackUser() {
    return document.getElementById('embyEventPlaybackUser')?.value || '';
}

function syncEmbyEventPlaybackUserFilterVisibility() {
    const label = document.querySelector('[data-emby-playback-user-filter]');
    if (!label) return;
    const show = getEmbyEventLogType() === 'playback';
    label.hidden = !show;
    label.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function refreshEmbyEventPlaybackUsers(records) {
    const select = document.getElementById('embyEventPlaybackUser');
    if (!select) return;
    const persisted = sessionStorage.getItem('qb-up-limit-emby-event-playback-user') || '';
    const prev = select.value || persisted;
    const seen = new Set();
    const names = [];
    (records || []).forEach((rec) => {
        const name = String(rec.user_name || '').trim();
        if (!name || seen.has(name)) return;
        seen.add(name);
        names.push(name);
    });
    names.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    select.innerHTML = '<option value="">全部用户</option>';
    names.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    });
    if (prev && [...select.options].some((o) => o.value === prev)) {
        select.value = prev;
    }
    sessionStorage.setItem('qb-up-limit-emby-event-playback-user', select.value || '');
}

function filterPlaybackRecordsByUser(records) {
    const user = getEmbyEventPlaybackUser();
    if (!user) return records || [];
    return (records || []).filter((rec) => String(rec.user_name || '').trim() === user);
}

function onEmbyEventLogTypeChange() {
    syncEmbyEventPlaybackUserFilterVisibility();
    if (typeof persistChartControls === 'function') persistChartControls();
    loadEmbyEvents();
}

function onEmbyEventPlaybackUserChange() {
    if (typeof persistChartControls === 'function') persistChartControls();
    renderPlaybackRecords();
}

async function loadEmbyEvents(silent = false) {
    if (typeof persistChartControls === 'function') persistChartControls();
    syncEmbyEventPlaybackUserFilterVisibility();
    if (getEmbyEventLogType() === 'activity') {
        return loadEmbyActivityLog(silent);
    }
    return loadEmbyPlaybackRecords(silent);
}

let _lastPlaybackRecords = [];
let _lastEmbyEventPlaybackInstance = '';

async function loadEmbyPlaybackRecords(silent = false) {
    const list = document.getElementById('embyEventsList');
    if (!list) return;
    const instance = document.getElementById('embyEventInstance')?.value || '';
    if (!instance) {
        list.innerHTML = '<div class="empty-tip">暂无设备</div>';
        return;
    }
    if (instance !== _lastEmbyEventPlaybackInstance) {
        _lastEmbyEventPlaybackInstance = instance;
        const userSelect = document.getElementById('embyEventPlaybackUser');
        if (userSelect) userSelect.value = '';
    }
    try {
        const res = await axios.get('/api/emby/playback-records', {
            params: { instance, limit: 200 },
        });
        if (!res.data.success) return;
        renderPlaybackRecords(res.data.data || []);
    } catch (e) {
        if (!silent) list.innerHTML = '<div class="empty-tip">加载失败</div>';
    }
}

async function loadEmbyActivityLog(silent = false) {
    const list = document.getElementById('embyEventsList');
    if (!list) return;
    const instance = document.getElementById('embyEventInstance')?.value || '';
    if (!instance) {
        list.innerHTML = '<div class="empty-tip">暂无设备</div>';
        return;
    }
    try {
        const res = await axios.get('/api/emby/activity-log', {
            params: { instance, limit: 200 },
        });
        if (!res.data.success) {
            if (!silent) {
                const msg = res.data.error || '加载失败';
                list.innerHTML = `<div class="empty-tip">${escapeHtml(msg)}</div>`;
            }
            return;
        }
        renderEmbyActivityEvents(res.data.data || []);
    } catch (e) {
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
    if (!events.length) {
        list.innerHTML = '<div class="empty-tip">暂无原始日志</div>';
        return;
    }
    list.innerHTML = events.map(renderEmbyActivityEventCard).join('');
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

function buildEmbyEventNetworkIpHtml(event) {
    const ip = event.client_ip || event.remote_endpoint || '';
    if (!ip) return '';
    const masked = maskEmbyEndpointDisplay(ip);
    return `&nbsp;·&nbsp; <span class="emby-event-ip-wrap">`
        + `<span class="emby-event-ip">${escapeHtml(masked)}</span>`
        + `<button type="button" class="emby-event-ip-toggle" aria-label="显示 IP" aria-pressed="false" data-ip="${escapeHtml(ip)}">${buildEmbyEventIpEyeIcon(false)}</button>`
        + `</span>`;
}

function buildEmbyEventNetworkBadgeHtml(event) {
    const ip = event.client_ip || event.remote_endpoint || '';
    if (!ip) return '';
    const badgeLabel = event.is_remote ? '外网' : '局域网';
    return `<span class="emby-session-badge emby-event-badge--network">${badgeLabel}</span>`;
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
    });
}

function buildEmbyEventTranscodeBadgeHtml(event) {
    const kind = deriveEmbyEventTranscodeKind(event);
    const label = embyTranscodeKindLabel(kind);
    if (!label) return '';
    return `<span class="emby-session-badge emby-event-badge--transcode">${escapeHtml(label)}</span>`;
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
const EMBY_EFFECTIVE_WATCH_SECONDS = 300;

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

function buildEmbySeekBadgeHtml(event) {
    const count = resolveEmbySeekCount(event);
    if (count <= 0) return '';
    const label = count === 1 ? '跳转1次' : `跳转${count}次`;
    return `<span class="emby-session-badge emby-event-badge--seek">${escapeHtml(label)}</span>`;
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
    if (ratio >= EMBY_WATCH_COMPLETE_RATIO) {
        return '<span class="emby-session-badge emby-event-badge--watch-status">观看完毕</span>';
    }
    return `<span class="emby-session-badge emby-event-badge--watch-status">已观看${Math.round(ratio * 100)}%</span>`;
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
    if (resolveEmbySeekCount(event) > 0) {
        const played = parseInt(event?.played_seconds, 10);
        if (!Number.isNaN(played) && played > 0) return played;
    }

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
    return `<div class="event-watch-meta">${html}</div>`;
}

function formatEmbyWallClockTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function resolveEmbyPlaybackStartedAt(event) {
    const raw = event.started_at || event.date;
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
}

function findLiveSessionForPlaybackRecord(rec) {
    if (rec?.status !== 'playing') return null;
    const instName = rec.instance_name || '';
    const inst = (cachedEmbyInstances || []).find(i => i.name === instName);
    if (!inst) return null;
    const sessions = inst.sessions || [];
    const sid = normalizeEmbySessionId(rec.emby_session_id);
    if (sid) {
        const matched = sessions.find(s => normalizeEmbySessionId(s.id) === sid);
        if (matched) return matched;
    }
    const itemId = String(rec.item_id || '').trim();
    const userName = String(rec.user_name || '').trim().toLowerCase();
    for (const session of sessions) {
        if (!session.is_playing && !session.item_id) continue;
        if (itemId && String(session.item_id || '') !== itemId) continue;
        const sName = String(session.user_name || '').trim().toLowerCase();
        if (userName && sName && userName !== sName) continue;
        return session;
    }
    return null;
}

function mergeLiveSessionIntoPlaybackRecord(rec) {
    if (rec?.status !== 'playing') return rec;
    const live = findLiveSessionForPlaybackRecord(rec);
    if (!live) return rec;
    const merged = { ...rec };
    const keys = [
        'user_id', 'user_name', 'client', 'device_name',
        'remote_endpoint', 'client_ip', 'is_remote', 'is_paused',
        'play_method', 'is_video_direct', 'is_audio_direct', 'transcode_kind',
        'runtime_seconds', 'position_seconds', 'bitrate',
    ];
    keys.forEach((key) => {
        if (!(key in live)) return;
        const val = live[key];
        if (val === undefined || val === null) return;
        if (val === '' && typeof val !== 'boolean') return;
        merged[key] = val;
    });
    if (live.position_seconds != null) {
        merged.end_position_seconds = Math.max(0, parseInt(live.position_seconds, 10) || 0);
    }
    return merged;
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

    const remaining = Math.max(0, runtime - currentPos);
    const estimatedEnd = new Date(Date.now() + remaining * 1000);
    const estimatedText = formatEmbyWallClockTime(estimatedEnd);
    if (!estimatedText) return '';

    const pipe = '<span class="event-watch-meta-sep event-watch-meta-sep--pipe">&nbsp;|&nbsp;</span>';
    const line = [
        escapeHtml(`影片时长${formatEmbyDuration(runtime)}`),
        escapeHtml(`${formatEmbyDuration(startPos)} - ${formatEmbyDuration(currentPos)}`),
        escapeHtml(`预计结束${estimatedText}`),
    ].join(pipe);
    return `<div class="event-watch-meta">${line}</div>`;
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
    if (typeof formatTraffic === 'function') {
        const formatted = formatTraffic(value);
        return `${formatted.value}${formatted.unit}`;
    }
    const mb = value / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
    return `${mb.toFixed(2)}MB`;
}

function embyEstimatedUploadSourceLabel(source) {
    if (source === 'accumulator') return '流量分摊';
    if (source === 'formula') return '按观看进度';
    return '';
}

function buildEmbyEventUploadBadgeHtml(event, options = {}) {
    if (!isEmbyPlaybackStopEvent(event.type)) return '';
    const uploadAnyRemote = options.uploadAnyRemote;
    const remoteOk = uploadAnyRemote != null ? uploadAnyRemote : event.is_remote;
    if (!remoteOk) return '';
    const text = formatEmbyEstimatedUpload(event.estimated_upload_bytes);
    if (!text) return '';
    const sourceLabel = embyEstimatedUploadSourceLabel(event.estimated_upload_source);
    const suffix = sourceLabel ? `（${sourceLabel}）` : '';
    return `<span class="emby-session-badge emby-event-badge--upload">估算上行${escapeHtml(text)}${escapeHtml(suffix)}</span>`;
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
        suffix = ' <span class="emby-playback-interrupt-badge">超时中断</span>';
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

function renderPlaybackRecordCard(rec) {
    const viewRec = mergeLiveSessionIntoPlaybackRecord(rec);
    const event = playbackRecordAsEvent(viewRec);
    const startEvent = { ...event, date: viewRec.started_at, type: 'VideoPlayback' };
    const mediaEvent = resolveEmbyPlaybackMediaEvent(event, startEvent);
    const mediaTitleHtml = buildEmbyEventMediaTitleHtml(mediaEvent);
    const timeLineHtml = buildPlaybackRecordTimeLine(viewRec);
    const isPlaying = viewRec.status === 'playing';
    const tailHtml = buildEmbyPlaybackCardTailHtml(event, {
        includePlayingWatch: isPlaying,
        includeWatch: !isPlaying,
        startEvent,
    });
    const statusBadgeHtml = buildEmbyPlaybackRecordStatusBadgeHtml(viewRec);
    const cardClass = isPlaying
        ? `emby-playback emby-playback-playing emby-event-videoplayback${viewRec.is_paused ? ' emby-playback-paused' : ''}`
        : 'emby-playback emby-playback-record emby-event-videoplaybackstopped';
    return `
        <div class="event-item ${cardClass}">
            <div class="event-time">${timeLineHtml}</div>
            <div class="event-playback-meta">${buildEmbyEventTypeLine(event, { includeInstance: false, statusBadgeHtml })}</div>
            ${mediaTitleHtml ? `<div class="event-media-title">${mediaTitleHtml}</div>` : ''}
            ${tailHtml}
        </div>`;
}

function renderPlaybackRecords(records) {
    const list = document.getElementById('embyEventsList');
    if (!list) return;
    if (records !== undefined) {
        _lastPlaybackRecords = records || [];
        refreshEmbyEventPlaybackUsers(_lastPlaybackRecords);
    }
    const filtered = filterPlaybackRecordsByUser(_lastPlaybackRecords);
    if (!filtered.length) {
        const tip = _lastPlaybackRecords.length && getEmbyEventPlaybackUser()
            ? '该用户暂无播放记录'
            : '暂无播放记录';
        list.innerHTML = `<div class="empty-tip">${tip}</div>`;
        return;
    }
    list.innerHTML = filtered.map(renderPlaybackRecordCard).join('');
    ensureEmbyEventIpToggle();
}
