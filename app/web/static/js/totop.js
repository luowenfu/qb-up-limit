/* 事件记录、日志条目多时，往下滑超过约一屏就在右下角显示「回到顶部」，点一下平滑滚回顶部，回到顶部附近自动隐藏。
   页面整体滚动和面板内部滚动都支持，跟随最近滚动的那个区域。 */

const LIST = '.timeline, .logs';
let btn = null, active = null;

function top(el) { return el === window ? scrollY : el.scrollTop; }
function view(el) { return el === window ? innerHeight : el.clientHeight; }

function hasList(el) {
    if (el === window) return !!document.querySelector(LIST);
    return el.matches(LIST) || !!el.querySelector(LIST);
}

function ensure() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'to-top';
    btn.title = '回到顶部';
    btn.setAttribute('aria-label', '回到顶部');
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 15.5V5M5 9.5L10 4.5l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener('click', () => {
        const el = active || window;
        el.scrollTo({ top: 0, behavior: 'smooth' });
        btn.classList.remove('show');
    });
    document.body.appendChild(btn);
    return btn;
}

function onScroll(e) {
    const el = e.target === document || e.target === document.documentElement ? window : e.target;
    if (!(el === window || el instanceof Element) || !hasList(el)) return;
    const show = top(el) > view(el);
    if (show) active = el;
    else if (active && active !== el) return;
    ensure().classList.toggle('show', show);
}

document.addEventListener('scroll', onScroll, { capture: true, passive: true });
addEventListener('scroll', onScroll, { passive: true });
