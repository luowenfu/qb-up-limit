// 事件记录卡片：同一列表里只要有一张卡片的标签（或名称）被挤到第二行，整列表的卡片都把标签放第二行，保持统一
const seen = new WeakSet();
const ro = new ResizeObserver(es => es.forEach(e => sync(e.target)));

function wrapped(it) {
  const t = it.querySelector('.ev-tags');
  const n = it.querySelector('.ev-name');
  const tm = it.querySelector('time');
  if (!t || !n || !t.childElementCount) return false;
  const top = (tm || n).getBoundingClientRect().top;
  return t.getBoundingClientRect().top > top + 6 || n.getBoundingClientRect().top > top + 6;
}

function sync(tl) {
  tl.classList.remove('tags-wrap');
  const any = [...tl.querySelectorAll('.ev-item')].some(wrapped);
  tl.classList.toggle('tags-wrap', any);
}

function scan() {
  document.querySelectorAll('.timeline').forEach(tl => {
    if (!seen.has(tl)) { seen.add(tl); ro.observe(tl); }
    sync(tl);
  });
}

let raf = 0;
new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(scan); })
  .observe(document.body, { childList: true, subtree: true });
scan();
