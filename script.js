/* ==========================================================================
   本科回忆录 · 照片墙
   --------------------------------------------------------------------------
   照片与文字来自 photos.json（见 README）。这里负责：
     1. 读取数据、按日期排序、预加载图片（拿到真实比例，避免裁剪）
     2. 把照片分到若干行，每行像砖块一样与相邻行错开
     3. requestAnimationFrame 让整面墙缓慢向左→右流动
     4. 鼠标悬停时只让这一张「定格 + 放大」，其余继续流动
     5. 点击打开详情覆盖层
   ========================================================================== */

// 在网址后面加 ?debug 可以看到排布日志（开发时用，平时不用管）
const DEBUG_ON = new URLSearchParams(location.search).has('debug');

const CONFIG = {
  speed:       26,     // 流动速度：像素 / 秒（调大走得更快）
  gap:         30,     // 照片横向间距（与 CSS --gap 保持一致）
  rowGap:      26,     // 行间距
  topPad:      170,    // 顶部留给页头 / 胶片边
  bottomPad:   88,
  rowsWide:    3,      // 宽屏行数
  rowsNarrow:  2,      // 窄屏行数
  cardFill:    0.78,   // 照片高度占行高的比例（剩下的留给悬停放大）
  hJitter:     0.16,   // 同排照片高度的随机浮动幅度
  rotJitter:   2.2,    // 每张照片的静态随机倾角（度）
  maxAspect:   1.75,   // 极宽 / 极高的照片会被夹到这个范围内
  minAspect:   0.62,
  debug:       DEBUG_ON,
};

const wall      = document.getElementById('wall');
const loadingEl = document.getElementById('loading');
const errorEl   = document.getElementById('error');
const hintEl    = document.getElementById('hint');

const overlayEl = document.getElementById('overlay');
const ovPanel   = document.getElementById('ov-panel');
const ovImg     = document.getElementById('ov-img');
const ovDate    = document.getElementById('ov-date');
const ovTitle   = document.getElementById('ov-title');
const ovText    = document.getElementById('ov-text');
const ovCount   = document.getElementById('ov-count');
const ovClose   = document.getElementById('ov-close');
const ovPrev    = document.getElementById('ov-prev');
const ovNext    = document.getElementById('ov-next');

/* —— 运行时状态 —— */
let photos  = [];        // 唯一照片列表（按日期升序），详情翻页用这个
let layout  = null;      // 当前排布
let scrollX = 0;         // 全局流动位移
let lastT   = 0;
let current = 0;         // 详情当前索引
let isOpen  = false;
let hovered = null;      // 当前定格的照片
let returnFocusEl = null; // 关掉详情后焦点还给谁
let resizeTimer = 0;
let imgToken = 0;        // 防止快速翻页时旧图覆盖新图

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ==========================================================================
   1. 数据
   ========================================================================== */

async function boot() {
  initHint();

  let data;
  try {
    const res = await fetch('photos.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    return showError(err);
  }

  if (!Array.isArray(data) || data.length === 0) {
    return showError(new Error('photos.json 里还没有照片记录。'));
  }

  // 按日期升序 —— 让从左到右的流动暗合时间顺序
  const sorted = data
    .filter(p => p && typeof p.src === 'string' && p.src.trim())
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  // 预加载：拿到真实宽高比，同时把加载失败的条目挡在外面
  const loaded = await Promise.all(sorted.map(loadImage));
  photos = loaded.filter(Boolean);

  if (photos.length === 0) {
    return showError(new Error('照片都加载失败了，检查一下 photos/ 里的文件名和 photos.json 里的 src 是否一致。'));
  }

  if (loadingEl) loadingEl.remove();

  build();
  syncFromHash();          // 链接里带 #p=xxx 时直接打开那一张
  requestAnimationFrame(frame);
}

/** 触屏上没有鼠标，「把鼠标停上去」这句话就不成立了 */
function initHint() {
  if (!hintEl) return;
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  hintEl.textContent = canHover
    ? '把鼠标停在照片上，它会停下来 · 点击读一段回忆'
    : '轻点照片，读一段回忆';
}

/** 预加载一张图，成功返回 {…记录, img, aspect}，失败返回 null
 *
 *  照片墙用缩略图（rec.thumb），点开详情才加载大图（rec.src）。
 *  没写 thumb 时退回用 src，所以 photos.json 里只填 src 也能正常工作。
 *  缩略图和大图的宽高比一致，所以拿缩略量出来的比例来排版是准的。 */
function loadImage(rec) {
  const url = rec.thumb || rec.src;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const aspect = img.naturalWidth / img.naturalHeight;
      resolve(Number.isFinite(aspect) && aspect > 0 ? { ...rec, img, aspect } : null);
    };
    img.onerror = () => {
      console.warn('[回忆录] 图片加载失败：' + url);
      resolve(null);
    };
    img.src = url;
  });
}

function showError(err) {
  if (loadingEl) loadingEl.remove();
  if (!errorEl) return;
  errorEl.hidden = false;

  const isFile = location.protocol === 'file:';
  errorEl.innerHTML = isFile
    ? '直接用双击打开 html 文件时，浏览器不允许读取 <code>photos.json</code>。<br>' +
      '请在项目目录里起一个本地服务器，例如在终端运行：<br>' +
      '<code>python -m http.server 8000</code><br>' +
      '然后访问 <code>http://localhost:8000</code>。<br>' +
      '<small>（放到 GitHub Pages 上不会有这个问题）</small>'
    : '读取 photos.json 出错了：' + (err && err.message ? err.message : err);

  console.error('[回忆录]', err);
}

/* ==========================================================================
   2. 排布
   ========================================================================== */

/** 从 CSS 变量 --pad-card 读出相纸内边距，保持 JS 与 CSS 一致 */
function readCardPad() {
  const px = v => parseFloat(v) || 0;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--pad-card').trim();
  const p = raw.split(/\s+/).filter(Boolean);
  if (p.length === 0) return { t: 10, r: 10, b: 40, l: 10 };
  if (p.length === 1) return { t: px(p[0]), r: px(p[0]), b: px(p[0]), l: px(p[0]) };
  if (p.length === 2) return { t: px(p[0]), r: px(p[1]), b: px(p[0]), l: px(p[1]) };
  if (p.length === 3) return { t: px(p[0]), r: px(p[1]), b: px(p[2]), l: px(p[1]) };
  return { t: px(p[0]), r: px(p[1]), b: px(p[2]), l: px(p[3]) };
}

/** 稳定的伪随机（同一张照片每次刷新位置一致，不会跳来跳去） */
function rand(seed) {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** 某一行数下，一行所有照片首尾相接的总长度（估算） */
function estimateCycleW(rowCount, avail, pad, avgAspect) {
  const rowH   = (avail - CONFIG.rowGap * (rowCount - 1)) / rowCount;
  const imgH   = Math.max(80, rowH * CONFIG.cardFill);
  const perRow = Math.ceil(photos.length / rowCount);
  const avgW   = imgH * avgAspect + pad.l + pad.r;
  return perRow * (avgW + CONFIG.gap);
}

/** 从多到少挑行数，取第一个「一行就能铺满视口」的 */
function pickRowCount(avail, pad, vw, minRows, maxRows) {
  const avgAspect = photos.reduce(
    (s, p) => s + clamp(p.aspect, CONFIG.minAspect, CONFIG.maxAspect), 0
  ) / photos.length;

  for (let r = maxRows; r > minRows; r--) {
    if (estimateCycleW(r, avail, pad, avgAspect) >= vw) return r;
  }
  return minRows;   // 照片实在少，就用最少的行数把照片撑到最大
}

function build() {
  // 清掉上一轮（resize 重建时）
  wall.querySelectorAll('.card').forEach(el => el.remove());
  if (errorEl) errorEl.hidden = true;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const narrow = vw < 860;
  const pad = readCardPad();
  const vertPad = pad.t + pad.b;

  const topPad    = narrow ? 132 : CONFIG.topPad;
  const bottomPad = narrow ? 100 : CONFIG.bottomPad;
  const avail     = Math.max(200, vh - topPad - bottomPad);

  // 行数：优先用满设定的行数；但如果照片太少、一行排不满视口，
  // 屏幕上就会看见同一张照片重复出现。这时候减一行（照片因此变大、
  // 一行也更长），让「一遍照片」就足够铺满屏幕。
  const maxRows = narrow ? CONFIG.rowsNarrow : CONFIG.rowsWide;
  const minRows = narrow ? 1 : 2;
  const rowCount = pickRowCount(avail, pad, vw, minRows, maxRows);

  const rowH = (avail - CONFIG.rowGap * (rowCount - 1)) / rowCount;

  // 轮流分配：各行内部依然按时间顺序，长度也更均匀
  const buckets = Array.from({ length: rowCount }, () => []);
  photos.forEach((p, i) => buckets[i % rowCount].push(p));

  layout = { viewW: vw, rows: [], items: [] };

  buckets.forEach((list, ri) => {
    const baseImgH  = Math.max(80, rowH * CONFIG.cardFill);
    const baseCardH = baseImgH + vertPad;
    const rowY = topPad + ri * (rowH + CONFIG.rowGap) + Math.max(0, (rowH - baseCardH) / 2);

    // —— 先排一遍，量出每张的宽 ——
    const proto = [];
    let cycleW = 0;
    list.forEach((p, k) => {
      const seed = (p.id ? hash(p.id) : ri * 97 + k);
      const imgH = baseImgH * (1 + (rand(seed) - 0.5) * CONFIG.hJitter);
      const aspect = clamp(p.aspect, CONFIG.minAspect, CONFIG.maxAspect);
      const imgW = imgH * aspect;
      const w = imgW + pad.l + pad.r;
      proto.push({
        photo: p,
        w,
        h: imgH + vertPad,
        rot: (rand(seed + 3.7) - 0.5) * 2 * CONFIG.rotJitter,
      });
      cycleW += w + CONFIG.gap;
    });

    // —— 行宽不足以铺满视口时，把这一行循环几遍，保证首尾无缝 ——
    // 只要 W > 视口宽 + 一张照片宽，就能同时保证：
    //   · 屏幕上每个位置都恰好被一张照片盖住（无空洞）
    //   · 同一张照片至多只有一个副本落在屏幕附近（不会画重）
    // 所以这里取最小值，照片少的时候才不会到处重复。
    const maxW  = Math.max(...proto.map(o => o.w));
    const need  = vw + maxW + 80;
    const times = Math.max(1, Math.ceil(need / cycleW));

    const row = { y: rowY, width: 0, phase: 0, items: [] };
    for (let c = 0; c < times; c++) {
      let x = c * cycleW;
      proto.forEach(o => {
        const item = { ...o, row, baseX: x, frozen: false, frozenX: 0, liveX: 0, release: 0 };
        item.el = makeCard(item, rowY);
        row.items.push(item);
        layout.items.push(item);
        x += o.w + CONFIG.gap;
      });
      row.width = x;
    }

    // 砖块错开：相邻行横向偏移半张照片，再加一点零头打破周期感
    const avgW = cycleW / proto.length;
    row.phase = ri * avgW * 0.5 + ri * 23;
    layout.rows.push(row);
  });

  if (CONFIG.debug) {
    console.log(layout);
    // 把排布结果写进 DOM，方便用「查看元素」或 --dump-dom 直接读到数字
    document.body.dataset.debug = JSON.stringify({
      vw, vh, rowCount, avail: Math.round(avail), rowH: Math.round(rowH),
      cards: layout.items.length,
      rows: layout.rows.map((r, i) => ({
        i, y: Math.round(r.y), width: Math.round(r.width),
        items: r.items.length, bottom: Math.round(r.y + (r.items[0] || {}).h),
      })),
    });
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function makeCard(item, rowY) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  btn.style.width  = item.w + 'px';
  btn.style.height = item.h + 'px';
  btn.setAttribute('aria-label', photoTitle(item.photo) || '回忆');
  btn.style.transform = `translate3d(0px, ${rowY}px, 0)`;

  const inner = document.createElement('div');
  inner.className = 'card__inner';
  inner.style.setProperty('--rot', item.rot.toFixed(2) + 'deg');

  // 克隆预加载好的节点：同一个 src 已在缓存里，克隆不会产生新的请求。
  // 不能直接 append 原节点——那样只是把同一个元素搬来搬去，
  // 同一张照片的其它副本就会变成空白。
  const img = item.photo.img.cloneNode(false);
  img.className = 'card__img';
  img.alt = photoTitle(item.photo);
  img.draggable = false;

  const label = document.createElement('span');
  label.className = 'card__label';
  label.textContent = photoTitle(item.photo);

  inner.append(img, label);
  btn.append(inner);

  btn.addEventListener('pointerenter', e => {
    if (e.pointerType !== 'mouse') return;   // 触屏不做定格，直接点开
    freeze(item);
  });
  btn.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'mouse') return;
    thaw(item);
  });
  btn.addEventListener('focus', () => freeze(item));
  btn.addEventListener('blur',  () => thaw(item));
  btn.addEventListener('click', e => {
    const idx = photos.indexOf(item.photo);
    returnFocusEl = btn;
    // e.detail === 0 说明这次点击是回车/空格触发的，
    // 只有键盘用户才需要把焦点移进详情里
    openOverlay(idx < 0 ? 0 : idx, e.detail === 0);
  });

  wall.appendChild(btn);
  return btn;
}

/* ==========================================================================
   3. 流动
   ========================================================================== */

function mod(n, m) { return ((n % m) + m) % m; }

/** 这张照片此刻「应该」在的横坐标（不考虑定格） */
function liveX(item) {
  const row = item.row;
  const x = mod(item.baseX + scrollX + row.phase, row.width);
  // 行宽已保证 ≥ 视口 + 2 张照片，所以至多只有一个副本落在屏幕附近
  for (const c of [x, x - row.width, x + row.width]) {
    if (c + item.w > -60 && c < layout.viewW + 60) return c;
  }
  return x - row.width;
}

function frame(t) {
  if (!lastT) lastT = t;
  const dt = Math.min(64, t - lastT);   // 切回标签页时别让墙瞬移
  lastT = t;

  if (!reduceMotion && !isOpen) {
    scrollX += (CONFIG.speed * dt) / 1000;
  }

  if (layout) {
    for (const item of layout.items) {
      let sx;
      if (item.frozen) {
        sx = item.frozenX;                       // 定格：不跟随 scrollX
      } else {
        sx = liveX(item);
        if (item.release) {
          // 松手后平滑追上仍在流动的队伍，而不是「啪」地跳回去
          sx += item.release;
          item.release *= 0.85;
          if (Math.abs(item.release) < 0.4) item.release = 0;
        }
      }
      item.liveX = sx;
      item.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${item.row.y}px, 0)`;
    }
  }

  requestAnimationFrame(frame);
}

function freeze(item) {
  if (item.frozen) return;
  if (hovered && hovered !== item) thaw(hovered);
  item.frozen = true;
  item.frozenX = item.liveX;
  item.el.classList.add('is-hovered');
  hovered = item;
  if (hintEl) hintEl.classList.add('is-faded');
}

function thaw(item) {
  if (!item.frozen) return;
  item.release = item.frozenX - liveX(item);
  item.frozen = false;
  item.el.classList.remove('is-hovered');
  if (hovered === item) hovered = null;
}

/* ==========================================================================
   4. 详情
   ========================================================================== */

function photoTitle(p) {
  return p.title || formatDate(p.date) || '';
}

/** "2020-09" → "2020年9月"，让中文读起来自然些；认不出来就原样显示 */
function formatDate(d) {
  if (!d) return '';
  const s = String(d).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}年${+m[2]}月${+m[3]}日`;
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return `${m[1]}年${+m[2]}月`;
  m = s.match(/^(\d{4})$/);
  if (m) return `${m[1]}年`;
  return s;
}

/** 每张照片在地址栏里的名字：优先用 id，没写就用它的序号 */
function photoKey(p, i) {
  return p && p.id != null && p.id !== '' ? String(p.id) : String(i);
}

/* 详情与地址栏的 #p=xxx 保持同步。
   好处：浏览器「后退」是关掉详情而不是退出站点，而且每段回忆都能单独分享链接。 */

/** 由 #p=xxx 决定该显示哪一张（前进/后退、以及首次打开时走这里） */
function syncFromHash() {
  const m = location.hash.match(/^#p=(.*)$/);
  const key = m ? decodeURIComponent(m[1]) : null;
  const i = key === null ? -1 : photos.findIndex((p, k) => photoKey(p, k) === key);

  if (i < 0) { closeOverlayUI(); return; }
  current = i;
  openOverlayUI();
}

/** 点击照片：写入地址栏，并让历史记录多一条（这样「后退」能关掉它） */
function openOverlay(index, fromKeyboard) {
  if (!photos.length) return;
  current = clamp(index, 0, photos.length - 1);
  const key = photoKey(photos[current], current);
  if (location.hash !== '#p=' + key) {
    history.pushState({ p: key }, '', '#p=' + key);
  }
  openOverlayUI(fromKeyboard);
}

/** 关闭按钮 / Esc / 点空白：优先用「后退」，让历史记录保持干净 */
function requestClose() {
  if (history.state && history.state.p) history.back();
  else {
    history.replaceState(null, '', location.pathname + location.search);
    closeOverlayUI();
  }
}

function openOverlayUI(fromKeyboard) {
  if (!photos.length) return;
  const wasOpen = isOpen;
  isOpen = true;
  overlayEl.hidden = false;
  document.body.classList.add('is-locked');
  renderOverlay();
  if (!wasOpen) {
    requestAnimationFrame(() => overlayEl.classList.add('is-open'));
    // 鼠标点开的就别抢焦点了，否则关闭按钮上会挂一圈很难看的焦点框
    if (fromKeyboard) ovClose.focus({ preventScroll: true });
    else overlayEl.focus({ preventScroll: true });
  }
}

function closeOverlayUI() {
  if (!isOpen) return;
  isOpen = false;
  overlayEl.classList.remove('is-open');
  document.body.classList.remove('is-locked');
  const done = () => { overlayEl.hidden = true; };
  reduceMotion ? done() : setTimeout(done, 380);

  // 焦点还给刚才点的那张照片，键盘用户可以接着往下走
  const back = returnFocusEl && document.contains(returnFocusEl) ? returnFocusEl : null;
  if (back) { back.focus({ preventScroll: true }); returnFocusEl = null; }
}

function renderOverlay() {
  const p = photos[current];
  if (!p) return;

  const token = ++imgToken;
  ovImg.style.opacity = '0';
  ovImg.onload = () => { if (token === imgToken) ovImg.style.opacity = '1'; };
  ovImg.src = p.src;
  ovImg.alt = photoTitle(p);
  if (ovImg.complete && token === imgToken) ovImg.style.opacity = '1';

  ovDate.textContent  = formatDate(p.date);
  ovTitle.textContent = photoTitle(p) || '未命名的一页';
  ovText.textContent  = p.text || '（这一页还没有写下文字）';
  ovCount.textContent = `${current + 1} / ${photos.length}`;

  const single = photos.length < 2;
  ovPrev.hidden = single;
  ovNext.hidden = single;
}

function step(delta) {
  if (!photos.length) return;
  current = mod(current + delta, photos.length);
  // 翻页只替换当前这条历史，不然「后退」会一张一张地倒着翻
  const key = photoKey(photos[current], current);
  history.replaceState({ p: key }, '', '#p=' + key);
  renderOverlay();
}

ovClose.addEventListener('click', requestClose);
ovPrev.addEventListener('click', () => step(-1));
ovNext.addEventListener('click', () => step(1));

overlayEl.addEventListener('click', e => {
  if (e.target === overlayEl) requestClose();   // 点空白处关闭
});

document.addEventListener('keydown', e => {
  if (!isOpen) return;
  if (e.key === 'Escape')     { e.preventDefault(); requestClose(); }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); step(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});

// 浏览器前进 / 后退
window.addEventListener('popstate', syncFromHash);
window.addEventListener('hashchange', () => { if (!history.state) syncFromHash(); });

// 左右滑动翻页（触屏）
let touchX = null;
ovPanel.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
ovPanel.addEventListener('touchend', e => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
  touchX = null;
}, { passive: true });

/* ==========================================================================
   5. 尺寸变化 → 重新排布
   ========================================================================== */

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!photos.length) return;
    hovered = null;
    build();
  }, 180);
});

/* ==========================================================================
   启动
   ========================================================================== */

boot();
