/* 手机上事件记录卡片最高铺到底部导航栏上方：实时量卡片顶边位置（顶部统计展开、收起都算进去），
   底部留白和卡片上方的留白一样，结果写进 --ev-max-h */

const root = document.documentElement;
let raf = 0;

function fit() {
    raf = 0;
    const panel = document.querySelector('#sec-events > .panel');
    const tabs = document.querySelector('.detail-tabs');
    if (!panel || !tabs || !document.body.dataset.detail || tabs.offsetHeight === 0 || panel.offsetParent === null) {
        root.style.removeProperty('--ev-max-h');
        return;
    }
    const r = panel.getBoundingClientRect();
    const above = [document.querySelector('.tb-bar'), document.getElementById('metricsSlot')]
        .filter(Boolean).map(el => el.getBoundingClientRect()).filter(b => b.height > 0 && b.bottom <= r.top + 1);
    const aboveBottom = above.length ? Math.max(...above.map(b => b.bottom)) : 0;
    const gap = Math.max(8, Math.round(r.top - aboveBottom));
    const top = r.top + scrollY;
    const h = Math.floor(innerHeight - tabs.offsetHeight - gap - top);
    root.style.setProperty('--ev-max-h', Math.max(160, h) + 'px');
}

export function scheduleEvFit() { if (!raf) raf = requestAnimationFrame(fit); }

addEventListener('resize', scheduleEvFit);
addEventListener('orientationchange', scheduleEvFit);
document.addEventListener('click', () => setTimeout(scheduleEvFit, 0), true);
document.addEventListener('transitionend', scheduleEvFit, true);
if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(scheduleEvFit);
    const watch = () => ['.tb-bar', '#metricsSlot', '.detail-tabs', '#sec-events'].forEach(s => { const el = document.querySelector(s); if (el) ro.observe(el); });
    watch();
    new MutationObserver(() => { watch(); scheduleEvFit(); }).observe(document.body, { attributes: true, attributeFilter: ['data-detail', 'data-detail-tab', 'class'] });
}
scheduleEvFit();
