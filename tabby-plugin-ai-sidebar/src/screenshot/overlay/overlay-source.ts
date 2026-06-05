/**
 * Self-contained overlay assets (HTML + CSS + JS) served via a data: URL.
 *
 * Why one bundled string instead of separate files: the overlay window runs in
 * an isolated BrowserWindow that has no access to the plugin's dist directory
 * (asar packaging makes file:// paths fragile). Inlining everything into a
 * single `data:text/html` URL avoids the whole filesystem layout question and
 * means the overlay survives moves between dev / packaged / portable builds.
 *
 * The overlay receives its screenshot payload via `postMessage` from the
 * preload script the main process injects (see capture-window.ts), and posts
 * its result back the same way. No nodeIntegration, no `require` inside the
 * page — keeps the surface a normal sandboxed browser context.
 */

const OVERLAY_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100vw; height: 100vh;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
    background: transparent;
    cursor: crosshair;
    font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #fff;
  }
  canvas { position: absolute; top: 0; left: 0; }
  #bg, #dim, #ann { pointer-events: none; }
  #ann-preview { pointer-events: none; }

  /* Selection handles ------------------------------------------------------ */
  .handle {
    position: absolute;
    width: 9px; height: 9px;
    background: #5B9EF5;
    border: 1.5px solid #fff;
    border-radius: 2px;
    transform: translate(-50%, -50%);
    pointer-events: auto;
    z-index: 20;
  }
  .handle.nw, .handle.se { cursor: nwse-resize; }
  .handle.ne, .handle.sw { cursor: nesw-resize; }
  .handle.n,  .handle.s  { cursor: ns-resize; }
  .handle.e,  .handle.w  { cursor: ew-resize; }

  /* Size badge near the selection ------------------------------------------ */
  #size-badge {
    position: absolute;
    background: rgba(0,0,0,0.78);
    color: #fff;
    padding: 4px 8px;
    border-radius: 4px;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    z-index: 30;
    white-space: nowrap;
  }

  /* Magnifier (pre-selection pixel picker) --------------------------------- */
  #magnifier {
    position: absolute;
    width: 130px;
    background: rgba(0,0,0,0.86);
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 8px;
    padding: 6px;
    pointer-events: none;
    z-index: 40;
    display: none;
  }
  #magnifier canvas {
    position: relative;
    display: block;
    width: 118px; height: 118px;
    image-rendering: pixelated;
    border-radius: 4px;
  }
  #magnifier .crosshair {
    position: absolute;
    left: 6px; top: 6px;
    width: 118px; height: 118px;
    pointer-events: none;
  }
  #magnifier .crosshair::before, #magnifier .crosshair::after {
    content: "";
    position: absolute;
    background: rgba(91, 158, 245, 0.85);
  }
  #magnifier .crosshair::before {
    left: 0; right: 0; top: 50%;
    height: 1px; transform: translateY(-50%);
  }
  #magnifier .crosshair::after {
    top: 0; bottom: 0; left: 50%;
    width: 1px; transform: translateX(-50%);
  }
  #magnifier .info {
    margin-top: 5px;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 10.5px;
    color: #e7e9ec;
    line-height: 1.5;
  }
  #magnifier .swatch {
    display: inline-block;
    width: 9px; height: 9px;
    border-radius: 2px;
    border: 1px solid rgba(255,255,255,0.25);
    vertical-align: -1px;
    margin-right: 4px;
  }

  /* Annotation toolbar ----------------------------------------------------- */
  #toolbar {
    position: absolute;
    display: none;
    align-items: center;
    gap: 1px;
    background: #1F2226;
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 8px;
    padding: 4px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.45);
    z-index: 50;
    pointer-events: auto;
    user-select: none;
  }
  #toolbar.visible { display: inline-flex; }
  #toolbar .tool {
    width: 30px; height: 30px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 5px;
    cursor: pointer;
    color: #C9CCD1;
    background: transparent;
    border: none;
    padding: 0;
    transition: background 0.1s ease, color 0.1s ease;
  }
  #toolbar .tool:hover { background: rgba(255,255,255,0.06); color: #fff; }
  #toolbar .tool.active {
    background: rgba(91,158,245,0.22);
    color: #5B9EF5;
  }
  #toolbar .tool svg { width: 16px; height: 16px; }
  #toolbar .sep {
    width: 1px; height: 18px;
    background: rgba(255,255,255,0.10);
    margin: 0 4px;
  }
  #toolbar .swatch {
    width: 18px; height: 18px;
    border-radius: 50%;
    cursor: pointer;
    margin: 0 2px;
    border: 2px solid transparent;
    transition: transform 0.08s ease;
  }
  #toolbar .swatch.active { border-color: #fff; transform: scale(1.12); }
  #toolbar .stroke {
    width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 4px;
    cursor: pointer;
    color: #C9CCD1;
  }
  #toolbar .stroke:hover { color: #fff; }
  #toolbar .stroke.active { background: rgba(91,158,245,0.22); color: #5B9EF5; }
  #toolbar .stroke i {
    display: block;
    background: currentColor;
    border-radius: 99px;
  }
  #toolbar .stroke[data-size="s"] i { width: 8px;  height: 2px; }
  #toolbar .stroke[data-size="m"] i { width: 12px; height: 4px; }
  #toolbar .stroke[data-size="l"] i { width: 16px; height: 6px; }

  #toolbar .action {
    padding: 0 10px;
    height: 26px;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    background: transparent;
    color: #C9CCD1;
    border: none;
  }
  #toolbar .action:hover { background: rgba(255,255,255,0.06); color: #fff; }
  #toolbar .action.primary {
    background: #5B9EF5;
    color: #fff;
  }
  #toolbar .action.primary:hover { background: #4A8EE5; }
  #toolbar .action.danger:hover { color: #ff7a7a; }

  /* Inline text-input overlay --------------------------------------------- */
  #text-input {
    position: absolute;
    z-index: 60;
    background: transparent;
    border: 1px dashed rgba(91,158,245,0.8);
    color: #FF5252;
    font-size: 20px;
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    padding: 2px 4px;
    outline: none;
    resize: none;
    min-width: 60px;
    min-height: 28px;
    overflow: hidden;
    display: none;
    line-height: 1.2;
  }

  /* Hint shown before any selection --------------------------------------- */
  #hint {
    position: absolute;
    top: 16px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.7);
    border: 1px solid rgba(255,255,255,0.10);
    padding: 8px 14px;
    border-radius: 99px;
    font-size: 12px;
    pointer-events: none;
    z-index: 35;
    color: #E7E9EC;
  }
  #hint kbd {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(255,255,255,0.10);
    border: 1px solid rgba(255,255,255,0.18);
    font-family: ui-monospace, Menlo, monospace;
    font-size: 10.5px;
    margin: 0 2px;
  }
`

const OVERLAY_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>${OVERLAY_CSS}</style></head>
<body>
  <canvas id="bg"></canvas>
  <canvas id="dim"></canvas>
  <canvas id="ann"></canvas>
  <canvas id="ann-preview"></canvas>

  <div id="hint">Drag to capture · <kbd>Esc</kbd> cancel · <kbd>⏎</kbd> full screen</div>

  <div id="magnifier">
    <canvas width="13" height="13"></canvas>
    <div class="crosshair"></div>
    <div class="info">
      <div><span class="swatch"></span><span class="rgb">—</span></div>
      <div class="xy">—</div>
    </div>
  </div>

  <div id="size-badge" style="display:none">0 × 0</div>
  <div id="toolbar"></div>
  <textarea id="text-input" spellcheck="false"></textarea>

  <script>__OVERLAY_JS__</script>
</body></html>`

// ── overlay JS (runs in the BrowserWindow) ──────────────────────────────────
// Communication contract (postMessage on window):
//   ← main: { kind: 'init', dataURL, width, height, dpr }
//   → main: { kind: 'confirm', dataURL, rect: {x,y,w,h} }   ← rect in CSS px
//   → main: { kind: 'cancel' }
//
// All coordinates inside the overlay are in CSS pixels. The screenshot bitmap
// is at native device pixels — the on-screen canvases display it scaled to
// CSS pixels, and when we crop on confirm we scale back up via `dpr` so the
// exported PNG keeps full resolution.

const OVERLAY_JS = `
(() => {
  'use strict';

  // ── runtime state ─────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const bg       = $('#bg');
  const dim      = $('#dim');
  const ann      = $('#ann');
  const annPrev  = $('#ann-preview');
  const magEl    = $('#magnifier');
  const magCv    = magEl.querySelector('canvas');
  const magRgb   = magEl.querySelector('.rgb');
  const magXY    = magEl.querySelector('.xy');
  const magSw    = magEl.querySelector('.swatch');
  const sizeBadge = $('#size-badge');
  const toolbar  = $('#toolbar');
  const hint     = $('#hint');
  const textInput = $('#text-input');

  const ctxBg   = bg.getContext('2d');
  const ctxDim  = dim.getContext('2d');
  const ctxAnn  = ann.getContext('2d');
  const ctxPrev = annPrev.getContext('2d');
  const ctxMag  = magCv.getContext('2d');

  let bgImage = null;     // HTMLImageElement, the full screen snapshot
  let dpr     = 1;        // bitmap pixels per CSS pixel
  let cssW    = 0;
  let cssH    = 0;

  // Phases: 'select' (no selection yet), 'edit' (selection + annotating)
  let phase = 'select';

  // Selection rect in CSS pixels (relative to viewport / overlay).
  let sel = null;        // { x, y, w, h }
  let dragKind = null;   // 'new' | 'move' | 'resize-nw' | … | 'draw' | 'text'
  let dragStart = null;  // { x, y, sel0? }
  let mouse = { x: 0, y: 0 };

  // Annotation model. Each item is one finalised draw operation.
  const annotations = [];          // [{ tool, color, size, ... }]
  const undoStack = [];            // pre-mutation snapshots
  let activeTool = 'rect';
  let activeColor = '#FF5252';
  let activeSize = 'm';            // s | m | l
  const SIZE_PX = { s: 2, m: 4, l: 7 };
  const COLORS = ['#FF5252', '#FFAA55', '#4CAF50', '#5B9EF5', '#FFFFFF', '#1B1B1B'];

  let drawing = null;  // in-progress annotation while mouse held down

  // ── init from main process ────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.kind === 'init') {
      dpr = m.dpr || 1;
      cssW = m.width;
      cssH = m.height;
      resizeAll(cssW, cssH);
      const img = new Image();
      img.onload = () => {
        bgImage = img;
        drawBackground();
        renderDim();
      };
      img.src = m.dataURL;
    }
  });

  function resizeAll(w, h) {
    for (const c of [bg, dim, ann, annPrev]) {
      c.width = w; c.height = h;
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
  }

  function drawBackground() {
    if (!bgImage) return;
    ctxBg.clearRect(0, 0, cssW, cssH);
    ctxBg.drawImage(bgImage, 0, 0, cssW, cssH);
  }

  // ── dim overlay with selection cutout ────────────────────────────────────
  function renderDim() {
    ctxDim.clearRect(0, 0, cssW, cssH);
    ctxDim.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctxDim.fillRect(0, 0, cssW, cssH);
    if (sel && sel.w > 0 && sel.h > 0) {
      ctxDim.clearRect(sel.x, sel.y, sel.w, sel.h);
      // selection border
      ctxDim.strokeStyle = '#5B9EF5';
      ctxDim.lineWidth = 1;
      ctxDim.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w - 1, sel.h - 1);
    }
  }

  // ── annotation rendering ─────────────────────────────────────────────────
  function renderAnnotations() {
    ctxAnn.clearRect(0, 0, cssW, cssH);
    for (const a of annotations) drawOne(ctxAnn, a);
  }

  function drawOne(ctx, a) {
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.fillStyle   = a.color;
    ctx.lineWidth   = SIZE_PX[a.size] || 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (a.tool === 'rect') {
      ctx.strokeRect(a.x, a.y, a.w, a.h);
    } else if (a.tool === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(a.x + a.w/2, a.y + a.h/2, Math.abs(a.w/2), Math.abs(a.h/2), 0, 0, Math.PI*2);
      ctx.stroke();
    } else if (a.tool === 'arrow') {
      drawArrow(ctx, a.x, a.y, a.x + a.w, a.y + a.h, ctx.lineWidth);
    } else if (a.tool === 'pen') {
      const pts = a.points;
      if (pts.length < 2) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth/2, 0, Math.PI*2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
    } else if (a.tool === 'mosaic') {
      // pixelate the screenshot under the rect by drawing it scaled-down then back up
      const block = 10;
      const x = Math.min(a.x, a.x + a.w);
      const y = Math.min(a.y, a.y + a.h);
      const w = Math.abs(a.w);
      const h = Math.abs(a.h);
      if (w < 2 || h < 2 || !bgImage) { ctx.restore(); return; }
      const sx = x * dpr, sy = y * dpr, sw = w * dpr, sh = h * dpr;
      const dw = Math.max(1, Math.floor(w / block));
      const dh = Math.max(1, Math.floor(h / block));
      const tmp = document.createElement('canvas');
      tmp.width = dw; tmp.height = dh;
      const tctx = tmp.getContext('2d');
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(bgImage, sx, sy, sw, sh, 0, 0, dw, dh);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, dw, dh, x, y, w, h);
      ctx.imageSmoothingEnabled = true;
    } else if (a.tool === 'text') {
      ctx.fillStyle = a.color;
      ctx.font = (a.fontSize || 20) + 'px -apple-system, "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'top';
      const lines = (a.text || '').split('\\n');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], a.x, a.y + i * (a.fontSize || 20) * 1.2);
      }
    }
    ctx.restore();
  }

  function drawArrow(ctx, x1, y1, x2, y2, lw) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const head = Math.max(10, lw * 4);
    const ang = Math.atan2(dy, dx);
    const bx = x2 - Math.cos(ang) * head * 0.6;
    const by = y2 - Math.sin(ang) * head * 0.6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(ang - Math.PI/7) * head, y2 - Math.sin(ang - Math.PI/7) * head);
    ctx.lineTo(x2 - Math.cos(ang + Math.PI/7) * head, y2 - Math.sin(ang + Math.PI/7) * head);
    ctx.closePath();
    ctx.fill();
  }

  // ── selection handles + size badge ───────────────────────────────────────
  function renderHandles() {
    document.querySelectorAll('.handle').forEach(h => h.remove());
    if (!sel || phase !== 'edit') return;
    const positions = [
      ['nw', sel.x,           sel.y],
      ['n',  sel.x + sel.w/2, sel.y],
      ['ne', sel.x + sel.w,   sel.y],
      ['e',  sel.x + sel.w,   sel.y + sel.h/2],
      ['se', sel.x + sel.w,   sel.y + sel.h],
      ['s',  sel.x + sel.w/2, sel.y + sel.h],
      ['sw', sel.x,           sel.y + sel.h],
      ['w',  sel.x,           sel.y + sel.h/2],
    ];
    for (const [name, x, y] of positions) {
      const el = document.createElement('div');
      el.className = 'handle ' + name;
      el.style.left = x + 'px';
      el.style.top  = y + 'px';
      el.dataset.kind = 'resize-' + name;
      document.body.appendChild(el);
    }
  }

  function renderSizeBadge() {
    if (!sel || sel.w === 0 || sel.h === 0) {
      sizeBadge.style.display = 'none';
      return;
    }
    sizeBadge.style.display = 'block';
    const wpx = Math.round(sel.w * dpr);
    const hpx = Math.round(sel.h * dpr);
    sizeBadge.textContent = wpx + ' × ' + hpx;
    // Above the selection if there's room, otherwise inside.
    const top = sel.y - 26;
    sizeBadge.style.left = sel.x + 'px';
    sizeBadge.style.top  = (top < 4 ? sel.y + 6 : top) + 'px';
  }

  // ── toolbar ──────────────────────────────────────────────────────────────
  function renderToolbar() {
    if (phase !== 'edit' || !sel) { toolbar.classList.remove('visible'); return; }
    toolbar.innerHTML = '';
    const tools = [
      { id: 'rect',    title: 'Rectangle (R)', svg: ICONS.rect },
      { id: 'ellipse', title: 'Ellipse (O)',   svg: ICONS.ellipse },
      { id: 'arrow',   title: 'Arrow (A)',     svg: ICONS.arrow },
      { id: 'pen',     title: 'Pen (P)',       svg: ICONS.pen },
      { id: 'mosaic',  title: 'Mosaic (M)',    svg: ICONS.mosaic },
      { id: 'text',    title: 'Text (T)',      svg: ICONS.text },
    ];
    for (const t of tools) {
      const b = document.createElement('button');
      b.className = 'tool' + (activeTool === t.id ? ' active' : '');
      b.title = t.title;
      b.innerHTML = t.svg;
      b.addEventListener('mousedown', (e) => { e.preventDefault(); setTool(t.id); });
      toolbar.appendChild(b);
    }
    toolbar.appendChild(makeSep());
    for (const sz of ['s', 'm', 'l']) {
      const b = document.createElement('button');
      b.className = 'stroke' + (activeSize === sz ? ' active' : '');
      b.dataset.size = sz;
      b.innerHTML = '<i></i>';
      b.title = 'Stroke size ' + sz.toUpperCase();
      b.addEventListener('mousedown', (e) => { e.preventDefault(); activeSize = sz; renderToolbar(); });
      toolbar.appendChild(b);
    }
    toolbar.appendChild(makeSep());
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch' + (activeColor === c ? ' active' : '');
      b.style.background = c;
      b.title = c;
      b.addEventListener('mousedown', (e) => { e.preventDefault(); activeColor = c; renderToolbar(); });
      toolbar.appendChild(b);
    }
    toolbar.appendChild(makeSep());
    const undoBtn = document.createElement('button');
    undoBtn.className = 'tool';
    undoBtn.title = 'Undo (⌘Z)';
    undoBtn.innerHTML = ICONS.undo;
    undoBtn.addEventListener('mousedown', (e) => { e.preventDefault(); undo(); });
    toolbar.appendChild(undoBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'action danger';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('mousedown', (e) => { e.preventDefault(); cancel(); });
    toolbar.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'action primary';
    confirmBtn.textContent = 'Confirm  ⏎';
    confirmBtn.addEventListener('mousedown', (e) => { e.preventDefault(); confirm(); });
    toolbar.appendChild(confirmBtn);

    positionToolbar();
    toolbar.classList.add('visible');
  }

  function makeSep() {
    const s = document.createElement('div');
    s.className = 'sep';
    return s;
  }

  function positionToolbar() {
    if (!sel) return;
    const tw = toolbar.offsetWidth || 380;
    const th = toolbar.offsetHeight || 40;
    let x = sel.x + sel.w - tw;
    if (x < 6) x = 6;
    if (x + tw > cssW - 6) x = cssW - tw - 6;
    let y = sel.y + sel.h + 8;
    if (y + th > cssH - 6) {
      // No room below — try above; otherwise put inside.
      const above = sel.y - th - 8;
      y = above > 6 ? above : Math.max(6, sel.y + 8);
    }
    toolbar.style.left = x + 'px';
    toolbar.style.top  = y + 'px';
  }

  function setTool(id) {
    activeTool = id;
    renderToolbar();
    document.body.style.cursor = id === 'text' ? 'text' : 'crosshair';
  }

  // ── magnifier (pre-selection) ────────────────────────────────────────────
  function updateMagnifier() {
    if (phase !== 'select' || !bgImage) {
      magEl.style.display = 'none';
      return;
    }
    magEl.style.display = 'block';
    // 13×13 native-pixel sample, scaled up 9× (118/13 ≈ 9.1) with image-rendering: pixelated.
    const samplePx = 13;
    const sx = mouse.x * dpr - Math.floor(samplePx / 2);
    const sy = mouse.y * dpr - Math.floor(samplePx / 2);
    ctxMag.imageSmoothingEnabled = false;
    ctxMag.clearRect(0, 0, samplePx, samplePx);
    ctxMag.drawImage(bgImage, sx, sy, samplePx, samplePx, 0, 0, samplePx, samplePx);

    // Read the center pixel to show RGB + swatch.
    try {
      const data = ctxMag.getImageData(Math.floor(samplePx/2), Math.floor(samplePx/2), 1, 1).data;
      const hex = '#' + [data[0], data[1], data[2]].map(v => v.toString(16).padStart(2,'0')).join('').toUpperCase();
      magRgb.textContent = hex;
      magSw.style.background = hex;
    } catch (e) {
      magRgb.textContent = '—';
      magSw.style.background = '#000';
    }
    magXY.textContent = Math.round(mouse.x * dpr) + ', ' + Math.round(mouse.y * dpr);

    // Position the magnifier so it doesn't sit under the cursor.
    const off = 18;
    let mx = mouse.x + off;
    let my = mouse.y + off;
    const w = magEl.offsetWidth, h = magEl.offsetHeight;
    if (mx + w > cssW - 4) mx = mouse.x - off - w;
    if (my + h > cssH - 4) my = mouse.y - off - h;
    magEl.style.left = mx + 'px';
    magEl.style.top  = my + 'px';
  }

  // ── mouse interaction ────────────────────────────────────────────────────
  function pos(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function hitHandle(e) {
    const t = e.target;
    if (t && t.classList && t.classList.contains('handle')) return t.dataset.kind;
    return null;
  }

  function insideSel(x, y) {
    return sel && x >= sel.x && y >= sel.y && x <= sel.x + sel.w && y <= sel.y + sel.h;
  }

  document.addEventListener('mousemove', (e) => {
    mouse = pos(e);
    if (phase === 'select') {
      updateMagnifier();
      if (dragKind === 'new' && dragStart) {
        const x = Math.min(dragStart.x, mouse.x);
        const y = Math.min(dragStart.y, mouse.y);
        const w = Math.abs(mouse.x - dragStart.x);
        const h = Math.abs(mouse.y - dragStart.y);
        sel = { x, y, w, h };
        renderDim();
        renderSizeBadge();
      }
      return;
    }
    // edit phase
    if (dragKind === 'move' && dragStart) {
      const dx = mouse.x - dragStart.x;
      const dy = mouse.y - dragStart.y;
      sel = {
        x: clamp(dragStart.sel0.x + dx, 0, cssW - dragStart.sel0.w),
        y: clamp(dragStart.sel0.y + dy, 0, cssH - dragStart.sel0.h),
        w: dragStart.sel0.w,
        h: dragStart.sel0.h,
      };
      renderDim(); renderSizeBadge(); renderHandles(); positionToolbar();
    } else if (dragKind && dragKind.startsWith('resize-')) {
      resizeSelection(dragKind.slice('resize-'.length), mouse.x, mouse.y);
      renderDim(); renderSizeBadge(); renderHandles(); positionToolbar();
    } else if (dragKind === 'draw' && drawing) {
      updateDrawing(mouse.x, mouse.y);
      renderPreview();
    }
  });

  function resizeSelection(dir, mx, my) {
    if (!sel) return;
    let { x, y, w, h } = sel;
    let x2 = x + w, y2 = y + h;
    if (dir.includes('w')) x  = clamp(mx, 0, x2 - 4);
    if (dir.includes('e')) x2 = clamp(mx, x + 4, cssW);
    if (dir.includes('n')) y  = clamp(my, 0, y2 - 4);
    if (dir.includes('s')) y2 = clamp(my, y + 4, cssH);
    sel = { x, y, w: x2 - x, h: y2 - y };
  }

  document.addEventListener('mousedown', (e) => {
    // Don't intercept clicks on the toolbar or text input — they have their own handlers.
    if (e.target.closest('#toolbar') || e.target === textInput) return;

    if (phase === 'select') {
      hint.style.display = 'none';
      dragKind = 'new';
      dragStart = pos(e);
      sel = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
    } else {
      // edit phase
      const hk = hitHandle(e);
      if (hk) {
        dragKind = hk;
        dragStart = pos(e);
        return;
      }
      const p = pos(e);
      if (insideSel(p.x, p.y)) {
        // Inside selection: either move, or begin drawing if a tool is "active".
        // We can't read mind — distinguish by: if user clicked near the centre,
        // assume move; if near the edge interior, also move. Actually simpler:
        // any click inside selection draws using the active tool. To "move"
        // the selection, drag from a handle. This matches WeChat behaviour
        // once you've started annotating — selection becomes a canvas.
        if (activeTool === 'text') {
          beginText(p.x, p.y);
          return;
        }
        dragKind = 'draw';
        dragStart = p;
        beginDrawing(p.x, p.y);
      } else {
        // Clicked outside selection: start a new selection over.
        commitTextIfAny();
        annotations.length = 0;
        undoStack.length = 0;
        renderAnnotations();
        phase = 'select';
        dragKind = 'new';
        dragStart = p;
        sel = { x: p.x, y: p.y, w: 0, h: 0 };
        renderToolbar();
        renderHandles();
        renderDim();
        renderSizeBadge();
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (phase === 'select' && dragKind === 'new') {
      // If the user just clicked without dragging, ignore — no selection yet.
      if (!sel || sel.w < 4 || sel.h < 4) {
        sel = null;
        renderDim(); renderSizeBadge();
      } else {
        phase = 'edit';
        magEl.style.display = 'none';
        renderHandles();
        renderToolbar();
      }
    } else if (dragKind === 'draw' && drawing) {
      finalizeDrawing();
      renderPreview();
      renderAnnotations();
    }
    dragKind = null;
    dragStart = null;
  });

  // ── drawing in-progress preview ──────────────────────────────────────────
  function beginDrawing(x, y) {
    if (activeTool === 'pen') {
      drawing = { tool: 'pen', color: activeColor, size: activeSize, points: [{x, y}] };
    } else {
      drawing = { tool: activeTool, color: activeColor, size: activeSize, x, y, w: 0, h: 0 };
    }
  }
  function updateDrawing(x, y) {
    if (!drawing) return;
    // Clamp to selection rect so annotations stay within the crop area.
    const cx = clamp(x, sel.x, sel.x + sel.w);
    const cy = clamp(y, sel.y, sel.y + sel.h);
    if (drawing.tool === 'pen') {
      drawing.points.push({ x: cx, y: cy });
    } else {
      drawing.w = cx - drawing.x;
      drawing.h = cy - drawing.y;
    }
  }
  function finalizeDrawing() {
    if (!drawing) return;
    if (drawing.tool === 'pen') {
      if (drawing.points.length > 0) {
        pushUndo();
        annotations.push(drawing);
      }
    } else if (Math.abs(drawing.w) >= 3 && Math.abs(drawing.h) >= 3) {
      pushUndo();
      annotations.push(drawing);
    }
    drawing = null;
  }
  function renderPreview() {
    ctxPrev.clearRect(0, 0, cssW, cssH);
    if (drawing) drawOne(ctxPrev, drawing);
  }

  function pushUndo() {
    undoStack.push(JSON.parse(JSON.stringify(annotations)));
    if (undoStack.length > 50) undoStack.shift();
  }
  function undo() {
    commitTextIfAny();
    if (undoStack.length === 0) return;
    const prev = undoStack.pop();
    annotations.length = 0;
    annotations.push(...prev);
    renderAnnotations();
  }

  // ── text tool ────────────────────────────────────────────────────────────
  let textTarget = null; // { x, y } in CSS px
  function beginText(x, y) {
    commitTextIfAny();
    textTarget = { x, y };
    textInput.value = '';
    textInput.style.display = 'block';
    textInput.style.left = x + 'px';
    textInput.style.top  = y + 'px';
    textInput.style.color = activeColor;
    textInput.style.fontSize = '20px';
    textInput.focus();
  }
  function commitTextIfAny() {
    if (!textTarget) return;
    const v = textInput.value;
    textInput.style.display = 'none';
    textInput.value = '';
    if (v.trim().length > 0) {
      pushUndo();
      annotations.push({
        tool: 'text',
        color: activeColor,
        size: activeSize,
        x: textTarget.x,
        y: textTarget.y,
        text: v,
        fontSize: 20,
      });
      renderAnnotations();
    }
    textTarget = null;
  }

  textInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      textTarget = null;
      textInput.style.display = 'none';
      textInput.value = '';
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitTextIfAny();
    }
    // Auto-grow textarea so users see what they typed.
    requestAnimationFrame(() => {
      textInput.style.height = 'auto';
      textInput.style.height = textInput.scrollHeight + 'px';
      textInput.style.width  = Math.max(60, textInput.scrollWidth + 8) + 'px';
    });
  });

  // ── keyboard ──────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (document.activeElement === textInput) return;
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if (e.key === 'Enter')  { e.preventDefault(); confirm(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    // tool hotkeys (only active in edit phase)
    if (phase !== 'edit') return;
    const map = { r:'rect', o:'ellipse', a:'arrow', p:'pen', m:'mosaic', t:'text' };
    const t = map[e.key.toLowerCase()];
    if (t) { e.preventDefault(); setTool(t); }
  });

  // ── result + dispatch ─────────────────────────────────────────────────────
  function cancel() {
    window.postMessage({ kind: 'cancel' }, '*');
  }
  function confirm() {
    commitTextIfAny();
    if (!sel || sel.w < 4 || sel.h < 4) { cancel(); return; }
    // Build the cropped PNG at native resolution.
    const W = Math.round(sel.w * dpr);
    const H = Math.round(sel.h * dpr);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const oc = out.getContext('2d');
    if (bgImage) {
      oc.drawImage(bgImage,
        sel.x * dpr, sel.y * dpr, sel.w * dpr, sel.h * dpr,
        0, 0, W, H);
    }
    // Annotations are in CSS px on the overlay — scale them up to native px.
    oc.save();
    oc.translate(-sel.x * dpr, -sel.y * dpr);
    oc.scale(dpr, dpr);
    for (const a of annotations) drawOne(oc, a);
    oc.restore();
    const dataURL = out.toDataURL('image/png');
    window.postMessage({
      kind: 'confirm',
      dataURL,
      rect: { x: Math.round(sel.x * dpr), y: Math.round(sel.y * dpr), w: W, h: H },
    }, '*');
  }

  // ── icons (inline SVG, currentColor-driven) ──────────────────────────────
  const ICONS = {
    rect:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="3.5" width="11" height="9" rx="1"/></svg>',
    ellipse: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="8" cy="8" rx="5.5" ry="4.5"/></svg>',
    arrow:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13 L13 3 M13 3 L8 3 M13 3 L13 8"/></svg>',
    pen:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14 L8 13 L13 4 L11 2 L2 11 Z M9 4 L11 6"/></svg>',
    mosaic:  '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="4" height="4"/><rect x="10" y="2" width="4" height="4"/><rect x="6" y="6" width="4" height="4"/><rect x="2" y="10" width="4" height="4"/><rect x="10" y="10" width="4" height="4"/></svg>',
    text:    '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 3 L13 3 L13 5 L9 5 L9 13 L7 13 L7 5 L3 5 Z"/></svg>',
    undo:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7 L7 3 L7 5 L10 5 A4 4 0 1 1 6 13"/></svg>',
  };
})();
`

export function overlayHtml (): string {
    return OVERLAY_HTML.replace('__OVERLAY_JS__', OVERLAY_JS)
}
