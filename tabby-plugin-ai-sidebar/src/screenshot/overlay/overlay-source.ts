/**
 * Self-contained overlay assets (HTML + CSS + JS) served via a data: URL.
 *
 * Why one bundled string instead of separate files: the overlay window runs in
 * an isolated BrowserWindow that has no access to the plugin's dist directory
 * (asar packaging makes file:// paths fragile). Inlining everything into a
 * single `data:text/html` URL avoids the whole filesystem layout question and
 * means the overlay survives moves between dev / packaged / portable builds.
 *
 * The overlay receives its screenshot payload via `postMessage` from main
 * (see capture-window.ts) and posts its result back the same way. No
 * nodeIntegration, no `require` inside the page — keeps the surface a normal
 * sandboxed browser context.
 *
 * Annotation surface is INTENTIONALLY minimal: red rectangle only. No color
 * picker, no stroke-width picker, no other shapes / text / mosaic. The goal
 * is "circle the thing you want Claude to look at and hit Enter" — anything
 * more is friction. If a future ask wants richer annotation, branch this
 * file rather than re-bolting toggles onto the toolbar.
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

  /* Minimal annotation toolbar — undo + cancel + confirm only.
     No tool picker, no color picker, no stroke picker. The single annotation
     tool is "red rectangle"; clicking inside the selection draws one. */
  #toolbar {
    position: absolute;
    display: none;
    align-items: center;
    gap: 4px;
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
  #toolbar .icon-btn {
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
  #toolbar .icon-btn:hover { background: rgba(255,255,255,0.06); color: #fff; }
  #toolbar .icon-btn[disabled] { opacity: 0.35; cursor: default; }
  #toolbar .icon-btn[disabled]:hover { background: transparent; color: #C9CCD1; }
  #toolbar .icon-btn svg { width: 16px; height: 16px; }
  #toolbar .sep {
    width: 1px; height: 18px;
    background: rgba(255,255,255,0.10);
    margin: 0 2px;
  }
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

  <div id="hint">Drag to capture · click inside to draw a red box · <kbd>Esc</kbd> cancel · <kbd>⏎</kbd> / double-click confirm</div>

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
//
// Annotation model: ONE tool, hard-coded as a red rectangle stroke. We keep
// an `annotations[]` stack so undo/redo still work; each entry is just a
// `{x,y,w,h}` in CSS px. No color/size/tool fields — they would be dead
// weight and add surface area for accidental UI re-introduction.

const OVERLAY_JS = `
(() => {
  'use strict';

  const RECT_COLOR = '#FF3B30';
  const RECT_LINE_WIDTH = 4;

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
  let dragKind = null;   // 'new' | 'move' | 'resize-nw' | … | 'draw'
  let dragStart = null;  // { x, y, sel0? }
  let mouse = { x: 0, y: 0 };

  // Each annotation = { x, y, w, h } in CSS px. Tool/color/stroke are fixed.
  const annotations = [];
  const undoStack = [];
  let drawing = null;    // in-progress rect while mouse held down

  // ── init from main process ────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.kind === 'init') {
      dpr = m.dpr || 1;
      cssW = m.width;
      cssH = m.height;
      resizeAll(cssW, cssH);
      const img = new Image();
      // Tell main the first frame (frozen shot + dim) is painted. Main holds
      // win.show() until this arrives — showing earlier reveals the live
      // desktop through the transparent window for a frame, then snaps to the
      // dimmed snapshot: the visible whole-screen "jitter". onerror still
      // signals so a failed decode can't leave the window stuck invisible.
      const signalReady = () => { try { window.postMessage({ kind: 'ready' }, '*'); } catch (_) {} };
      // Defer the ready signal until the painted frame is actually COMMITTED to
      // the compositor, not just enqueued as canvas draw calls. drawBackground()
      // /renderDim() only issue draw commands synchronously — the pixels aren't
      // on screen until the next compositor frame. If we signal ready right
      // after the draw calls, main's win.show() can land BEFORE that frame is
      // composited, so the transparent window reveals one frame of the live
      // desktop (the whole-screen "jump") before the frozen snapshot appears.
      // A double rAF waits for one full frame to be produced (rAF #1 fires
      // before paint, rAF #2 after it has been committed), so by the time main
      // shows the window the snapshot is guaranteed to be the first visible frame.
      const signalReadyAfterPaint = () => {
        requestAnimationFrame(() => requestAnimationFrame(() => signalReady()));
      };
      img.onload = () => {
        bgImage = img;
        drawBackground();
        renderDim();
        signalReadyAfterPaint();
      };
      img.onerror = () => { signalReady(); };
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
      ctxDim.strokeStyle = '#5B9EF5';
      ctxDim.lineWidth = 1;
      ctxDim.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w - 1, sel.h - 1);
    }
  }

  // ── annotation rendering ─────────────────────────────────────────────────
  function renderAnnotations() {
    ctxAnn.clearRect(0, 0, cssW, cssH);
    for (const a of annotations) drawRect(ctxAnn, a);
  }

  function drawRect(ctx, a) {
    ctx.save();
    ctx.strokeStyle = RECT_COLOR;
    ctx.lineWidth   = RECT_LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeRect(a.x, a.y, a.w, a.h);
    ctx.restore();
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
    const top = sel.y - 26;
    sizeBadge.style.left = sel.x + 'px';
    sizeBadge.style.top  = (top < 4 ? sel.y + 6 : top) + 'px';
  }

  // ── toolbar (undo / cancel / confirm) ────────────────────────────────────
  function renderToolbar() {
    if (phase !== 'edit' || !sel) { toolbar.classList.remove('visible'); return; }
    toolbar.innerHTML = '';

    const undoBtn = document.createElement('button');
    undoBtn.className = 'icon-btn';
    undoBtn.title = 'Undo last box (⌘Z)';
    undoBtn.innerHTML = ICONS.undo;
    undoBtn.disabled = undoStack.length === 0;
    undoBtn.addEventListener('mousedown', (e) => { e.preventDefault(); undo(); });
    toolbar.appendChild(undoBtn);

    toolbar.appendChild(makeSep());

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'action danger';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.title = 'Cancel (Esc)';
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
    const tw = toolbar.offsetWidth || 200;
    const th = toolbar.offsetHeight || 40;
    let x = sel.x + sel.w - tw;
    if (x < 6) x = 6;
    if (x + tw > cssW - 6) x = cssW - tw - 6;
    let y = sel.y + sel.h + 8;
    if (y + th > cssH - 6) {
      const above = sel.y - th - 8;
      y = above > 6 ? above : Math.max(6, sel.y + 8);
    }
    toolbar.style.left = x + 'px';
    toolbar.style.top  = y + 'px';
  }

  // ── magnifier (pre-selection) ────────────────────────────────────────────
  function updateMagnifier() {
    if (phase !== 'select' || !bgImage) {
      magEl.style.display = 'none';
      return;
    }
    magEl.style.display = 'block';
    const samplePx = 13;
    const sx = mouse.x * dpr - Math.floor(samplePx / 2);
    const sy = mouse.y * dpr - Math.floor(samplePx / 2);
    ctxMag.imageSmoothingEnabled = false;
    ctxMag.clearRect(0, 0, samplePx, samplePx);
    ctxMag.drawImage(bgImage, sx, sy, samplePx, samplePx, 0, 0, samplePx, samplePx);

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
  function pos(e) { return { x: e.clientX, y: e.clientY }; }
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
    if (e.target.closest('#toolbar')) return;

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
        // Single tool: any click inside the selection starts drawing a red
        // rectangle. To MOVE/RESIZE the selection itself, use the handles.
        dragKind = 'draw';
        dragStart = p;
        beginDrawing(p.x, p.y);
      } else {
        // Clicked outside selection: start a new selection over. Wipes all
        // current annotations — the user is restarting the framing step, so
        // any boxes drawn into the old selection don't make sense anymore.
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
      renderToolbar();   // refresh undo-button disabled state
    }
    dragKind = null;
    dragStart = null;
  });

  // Double-click anywhere over a finished selection = confirm, same as the
  // Confirm button / Enter. The two underlying clicks only ever start a
  // zero-size draw, which finalizeDrawing() discards (< 3px), so the crop is
  // never polluted by the gesture. Guarded to the 'edit' phase so a stray
  // double-click during initial framing (no selection yet) can't fall
  // through to confirm()'s empty-selection branch and cancel.
  document.addEventListener('dblclick', (e) => {
    if (e.target.closest('#toolbar')) return;
    if (phase === 'edit' && sel) { e.preventDefault(); confirm(); }
  });

  // ── drawing in-progress preview ──────────────────────────────────────────
  function beginDrawing(x, y) {
    drawing = { x, y, w: 0, h: 0 };
  }
  function updateDrawing(x, y) {
    if (!drawing) return;
    // Clamp to selection rect so annotations stay within the crop area.
    const cx = clamp(x, sel.x, sel.x + sel.w);
    const cy = clamp(y, sel.y, sel.y + sel.h);
    drawing.w = cx - drawing.x;
    drawing.h = cy - drawing.y;
  }
  function finalizeDrawing() {
    if (!drawing) return;
    if (Math.abs(drawing.w) >= 3 && Math.abs(drawing.h) >= 3) {
      pushUndo();
      annotations.push(drawing);
    }
    drawing = null;
  }
  function renderPreview() {
    ctxPrev.clearRect(0, 0, cssW, cssH);
    if (drawing) drawRect(ctxPrev, drawing);
  }

  function pushUndo() {
    undoStack.push(JSON.parse(JSON.stringify(annotations)));
    if (undoStack.length > 50) undoStack.shift();
  }
  function undo() {
    if (undoStack.length === 0) return;
    const prev = undoStack.pop();
    annotations.length = 0;
    annotations.push(...prev);
    renderAnnotations();
    renderToolbar();
  }

  // ── keyboard ──────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if (e.key === 'Enter')  { e.preventDefault(); confirm(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  });

  // ── result + dispatch ─────────────────────────────────────────────────────
  function cancel() {
    window.postMessage({ kind: 'cancel' }, '*');
  }
  function confirm() {
    if (!sel || sel.w < 4 || sel.h < 4) { cancel(); return; }
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
    for (const a of annotations) drawRect(oc, a);
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
    undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7 L7 3 L7 5 L10 5 A4 4 0 1 1 6 13"/></svg>',
  };
})();
`

export function overlayHtml (): string {
    return OVERLAY_HTML.replace('__OVERLAY_JS__', OVERLAY_JS)
}
