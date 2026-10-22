/* 手机上看被截成省略号的全名：点一下（按钮、可点的名称用长按）弹出全名气泡，点别处或 3 秒后消失 */

const touch = matchMedia('(hover: none)').matches;
let tip = null, timer = 0, pressTimer = 0, pressed = false;

function cut(el) {
    const t = el.querySelector(':scope > span:first-child') || el;
    return t.scrollWidth > t.clientWidth + 1 || el.scrollWidth > el.clientWidth + 1;
}

function target(node) {
    const el = node.closest && node.closest('[title]');
    if (!el || !el.title || el.closest('svg') || el.matches('a, .brand-gh')) return null;
    return cut(el) ? el : null;
}

function hide() { if (tip) { tip.remove(); tip = null; } clearTimeout(timer); }

function show(el) {
    hide();
    tip = document.createElement('div');
    tip.className = 'full-tip';
    tip.textContent = el.title;
    document.body.appendChild(tip);
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const top = r.bottom + h + 12 > innerHeight ? r.top - h - 6 : r.bottom + 6;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, top) + 'px';
    timer = setTimeout(hide, 3000);
}

const clickable = el => el.closest('button, a, [data-open-dev], [data-nav]');

if (touch) {
    document.addEventListener('touchstart', e => {
        pressed = false;
        const el = target(e.target);
        if (!el || !clickable(el)) return;
        pressTimer = setTimeout(() => { pressed = true; show(el); }, 500);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(n =>
        document.addEventListener(n, () => clearTimeout(pressTimer), { passive: true }));
    document.addEventListener('click', e => {
        if (pressed) { pressed = false; e.preventDefault(); e.stopPropagation(); return; }
        const el = target(e.target);
        if (el && !clickable(el)) { if (tip && tip.textContent === el.title) hide(); else show(el); return; }
        hide();
    }, true);
    addEventListener('scroll', hide, true);
}
