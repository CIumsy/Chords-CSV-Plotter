// All the JavaScript for Chords CSV Plotter, in one file.
// It is split into 9 sections, in the order they run:
//   1. APP STATE & HELPERS - shared state, DOM lookups, zoom math, small utils
//   2. THEME TOGGLE - light/dark switch
//   3. CSV LOADING - parsing a file and the sampling-rate prompt
//   4. CHANNEL LISTS - sidebar checkboxes and FFT channel picker
//   5. CONTROLS - SPS field, axis drag-to-zoom, buttons, scrolling, keyboard, FFT resize
//   6. MAIN PLOT RENDERING - draws the waveform canvas
//   7. FFT - frequency-spectrum math and drawing
//   8. RENDER LOOP & STARTUP - runs the draw functions above and starts the app
//   9. ONBOARDING TOUR - the walkthrough popup
// Search for the section names above to jump to a part.

/* ---- APP STATE & HELPERS (S = current data/view, el = DOM cache, zoom math, small utils) ---- */
/* -- TRACK COLORS -- */
// Each channel is assigned one of these colors, in order, cycling if there
// are more channels than colors. Colors themselves are defined as CSS
// variables in style.css so light/dark themes can each have their own set.
const TRACKS = ['--c1','--c2','--c3','--c4','--c5','--c6','--c7','--c8'];
function trackColor(i) {
  return getComputedStyle(document.documentElement).getPropertyValue(TRACKS[i % TRACKS.length]).trim();
}

/* -- APP STATE -- */
// This object holds everything about the currently-loaded CSV and the
// current view. Nothing here is persisted - reloading the page resets it.
const S = {
  headers: [],          // column names, e.g. ['Time','CH1','CH2']
  numericIdx: [],        // indices of headers that contain numeric data
  rows: [],              // parsed CSV rows, each row is an array aligned to headers
  selected: new Set(),   // numericIdx values currently shown on the main plot
  fftChannels: new Set(),// numericIdx values currently shown in the FFT panel
  channelRanges: {},     // { [numericIdx]: {lo, hi} } min/max per channel, for autoscale
  sampleRate: null,      // samples per second, or null if unknown (no time axis)
  start: 0,              // index of the first visible row (horizontal scroll position)
  window: 1000,          // how many rows are visible at once (horizontal zoom)
  scale: 1,              // vertical zoom multiplier (1 = auto-fit each channel's range)
  fftOpen: false,        // whether the FFT side panel is open
  fileName: '',          // name of the currently loaded file, shown in the topbar badge
};

/* -- DOM ELEMENT CACHE -- */
// Every element the app touches is looked up once here by id, then reused
// everywhere else as el.someName instead of calling getElementById again.
const $ = id => document.getElementById(id);
const el = {
  csvInput: $('csvInput'), themeBtn: $('themeBtn'),
  srInput: $('srInput'),
  autoBtn: $('autoBtn'), fitBtn: $('fitBtn'), fftBtn: $('fftBtn'),
  fileNameDisplay: $('fileNameDisplay'), fileBadge: $('fileBadge'), fileCloseBtn: $('fileCloseBtn'),
  chList: $('chList'),
  canvasWrap: $('canvasWrap'), canvasScroll: $('canvasScroll'),
  mainCanvas: $('mainCanvas'), emptyState: $('emptyState'),
  minimapWrap: $('minimapWrap'), minimapTrack: $('minimapTrack'), minimapCanvas: $('minimapCanvas'),
  minimapViewport: $('minimapViewport'), minimapLeftHandle: $('minimapLeftHandle'), minimapRightHandle: $('minimapRightHandle'),
  tlStart: $('tlStart'), tlEnd: $('tlEnd'),
  fftCol: $('fftCol'), fftHeader: $('fftHeader'), fftCanvas: $('fftCanvas'),
  fftChBar: $('fftChBar'), fftHandle: $('fftHandle'), fftClose: $('fftClose'),
  sidebar: $('sidebar'),
  mainArea: $('mainArea'),
  modalBackdrop: $('modalBackdrop'), modalSrInput: $('modalSrInput'),
  modalSkip: $('modalSkip'), modalSelect: $('modalSelect'),
};

const mainCtx = el.mainCanvas.getContext('2d');
const fftCtx  = el.fftCanvas.getContext('2d');

/* -- ZOOM LIMITS -- */
// How far zoom is allowed to go. SCALE is the Y-zoom multiplier (1 = auto-fit
// each channel's range). WIN_MIN is the smallest number of samples the X-axis
// can be zoomed in to.
const SCALE_MIN = 0.05, SCALE_MAX = 200, WIN_MIN = 32;

/* -- GENERIC HELPERS -- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt   = (v, d=3) => Number.isFinite(v) ? v.toFixed(d) : '-';
const fmtN  = v => Number.isFinite(v) ? Math.round(v).toLocaleString() : '0';
const fmtLbl = v => { if (!Number.isFinite(v)) return '-'; if (v === 0) return '0'; return v.toPrecision(3); };
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }


// Horizontal view changes all pass through one function so pan/zoom controls,
// keyboard shortcuts, and the minimap cannot leave start/window out of range.
function minHorizontalWindow() {
  return Math.min(WIN_MIN, Math.max(1, S.rows.length));
}
function setHorizontalView(start, windowSize) {
  const total = S.rows.length;
  if (!total) {
    S.start = 0;
    S.window = 1000;
    return;
  }
  S.window = clamp(Math.round(windowSize), minHorizontalWindow(), total);
  S.start = clamp(Math.round(start), 0, Math.max(0, total - S.window));
}

let minimapDirty = true;
function invalidateMinimap() { minimapDirty = true; }


/* ---- THEME TOGGLE (light/dark) ---- */
function setThemeIcon() {
  const dark = document.documentElement.dataset.theme === 'dark';
  el.themeBtn.innerHTML = dark
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
}

el.themeBtn.addEventListener('click', () => {
  const d = document.documentElement;
  d.dataset.theme = d.dataset.theme === 'dark' ? 'light' : 'dark';
  setThemeIcon();
  buildChannelList(); // channel checkbox colors are read live via trackColor()
  invalidateMinimap();
  renderAll();
});

setThemeIcon();


/* ---- CSV LOADING (parsing + the "set sampling rate" prompt) ---- */
/* -- CSV PARSING -- */
function parseCSV(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Empty file.');
  function splitLine(l) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '"') { if (q && l[i+1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  }
  const headers = splitLine(lines[0]).map((h, i) => h.trim() || `Col${i+1}`);
  // Only sample the first 120 data rows to decide which columns are numeric -
  // scanning the whole file would be wasteful for large CSVs.
  const sample  = lines.slice(1, 121).map(splitLine);
  const numericIdx = headers.map((_, i) => i).filter(i => {
    let tot = 0, num = 0;
    for (const r of sample) { const v = (r[i]||'').trim(); if (!v) continue; tot++; if (isFinite(Number(v))) num++; }
    return tot === 0 ? true : num / tot >= 0.8;
  });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    rows.push(headers.map((_, j) => { const n = Number((cells[j]||'').trim()); return isFinite(n) ? n : NaN; }));
  }
  return { headers, numericIdx, rows };
}

/* -- LOAD FILE -- */
let pendingParsed = null; // parsed CSV waiting on the sampling-rate modal

async function handleFile(file) {
  let parsed;
  try { parsed = parseCSV(await file.text()); }
  catch(e) { alert(e.message || 'Could not parse CSV.'); return; }
  pendingParsed = parsed;
  S.fileName = file.name;
  el.modalSrInput.value = '';
  el.modalBackdrop.classList.add('visible');
  setTimeout(() => el.modalSrInput.focus(), 60);
}

// Applies the parsed CSV (+ optional sampling rate) to app state and
// refreshes every dependent UI piece. Called after the modal is dismissed.
function commitLoad(sr) {
  const { headers, numericIdx, rows } = pendingParsed;
  pendingParsed = null;
  S.headers = headers; S.numericIdx = numericIdx; S.rows = rows;
  S.sampleRate = (sr > 0) ? sr : null;
  setHorizontalView(0, Math.min(1000, Math.max(1, rows.length))); S.scale = 1;
  S.selected.clear();
  S.fftChannels.clear();
  // Preselect columns that look like signal channels; otherwise just take the first 8.
  const preferred = numericIdx.filter(i => /ch|lead|bio|adc|signal/i.test(headers[i]));
 (preferred.length ? preferred : numericIdx).slice(0, 8).forEach(i => {
    S.selected.add(i);
    S.fftChannels.add(i);
  });
  buildChannelList(); computeChannelRanges(); invalidateMinimap(); renderAll();
  el.srInput.value = S.sampleRate || '';
  el.fileNameDisplay.textContent = S.fileName || '';
  el.fileNameDisplay.title = S.fileName || '';
  el.fileBadge.style.display = S.fileName ? 'flex' : 'none';
  el.emptyState.style.display = 'none';
}

el.modalSkip.addEventListener('click', () => {
  el.modalBackdrop.classList.remove('visible');
  commitLoad(null);
});
el.modalSelect.addEventListener('click', () => {
  el.modalBackdrop.classList.remove('visible');
  const sr = parseFloat(el.modalSrInput.value);
  commitLoad(sr > 0 ? sr : null);
});
el.modalSrInput.addEventListener('keydown', e => { if (e.key === 'Enter') el.modalSelect.click(); });
el.modalBackdrop.addEventListener('click', e => {
  if (e.target === el.modalBackdrop) { el.modalBackdrop.classList.remove('visible'); commitLoad(null); }
});

el.csvInput.addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (f) handleFile(f);
  e.target.value = '';
});


/* ---- CHANNEL LISTS (sidebar checkboxes + FFT channel picker pills) ---- */
/* -- CHANNEL RANGES (for autoscale) -- */
function computeChannelRanges() {
  S.channelRanges = {};
  for (const ci of S.numericIdx) {
    let lo = Infinity, hi = -Infinity;
    for (let r = 0; r < S.rows.length; r++) {
      const v = S.rows[r][ci];
      if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!isFinite(lo) || !isFinite(hi) || lo === hi) { lo = -1; hi = 1; }
    S.channelRanges[ci] = { lo, hi };
  }
  invalidateMinimap();
}

/* -- SIDEBAR CHANNEL LIST -- */
function buildChannelList() {
  el.chList.innerHTML = '';
  if (!S.numericIdx.length) {
    buildFftChannelList();
    return;
  }
  S.numericIdx.forEach((ci, idx) => {
    const item = document.createElement('label');
    item.className = 'ch-item' + (S.selected.has(ci) ? ' checked' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'ch-cb'; cb.checked = S.selected.has(ci);
    cb.style.accentColor = trackColor(idx); // checkbox itself is tinted per-channel
    cb.addEventListener('change', () => {
      if (cb.checked) S.selected.add(ci); else S.selected.delete(ci);
      item.className = 'ch-item' + (S.selected.has(ci) ? ' checked' : '');
      buildFftChannelList();
      invalidateMinimap();
      renderAll();
    });
    const name = document.createElement('span');
    name.className = 'ch-name'; name.textContent = S.headers[ci];
    item.append(cb, name);
    el.chList.appendChild(item);
  });
  buildFftChannelList();
}

/* -- FFT CHANNEL SELECTOR (single-select pill bar) -- */
function buildFftChannelList() {
  el.fftChBar.innerHTML = '';
  const visibleChannels = S.numericIdx
    .map((ci, idx) => ({ ci, idx }))
    .filter(({ ci }) => S.selected.has(ci));

  if (!visibleChannels.length) {
    el.fftChBar.innerHTML = '<span style="font-size:.625rem;color:var(--faint);padding:.1rem 0">No channels selected</span>';
    return;
  }

  // Exactly one channel must be active for the FFT panel at all times.
  const hasValid = visibleChannels.some(({ ci }) => S.fftChannels.has(ci));
  if (!hasValid) {
    S.fftChannels.clear();
    S.fftChannels.add(visibleChannels[0].ci);
  } else {
    const first = visibleChannels.find(({ ci }) => S.fftChannels.has(ci));
    S.fftChannels.clear();
    if (first) S.fftChannels.add(first.ci);
  }

  visibleChannels.forEach(({ ci, idx }) => {
    const color = trackColor(idx);
    const pill = document.createElement('button');
    pill.className = 'fft-ch-pill' + (S.fftChannels.has(ci) ? ' active' : '');
    pill.style.setProperty('--pill-color', color);

    const dot = document.createElement('span');
    dot.className = 'fft-ch-dot';
    dot.style.background = color;

    const label = document.createElement('span');
    label.textContent = S.headers[ci];
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';

    pill.append(dot, label);
    pill.title = S.headers[ci];
    pill.addEventListener('click', () => {
      S.fftChannels.clear();
      S.fftChannels.add(ci);
      buildFftChannelList();
      renderAll();
    });
    el.fftChBar.appendChild(pill);
  });
}


/* ---- CONTROLS (SPS field, axis drag-to-zoom, buttons, scroll, keyboard, FFT panel resize) ---- */
/* -- SAMPLING RATE -- */
el.srInput.addEventListener('input', () => {
  const n = parseFloat(el.srInput.value);
  S.sampleRate = n > 0 ? n : null;
  renderAll();
});

/* -- AXIS DRAG-TO-ZOOM -- */
// Like most plotting/scope tools: drag on the left value-axis to zoom
// vertically, drag on the top or bottom index/time axis to zoom
// horizontally. The cursor changes to show which axis you're over, and
// drawMain() (in the plot section) draws small arrow hints + a highlight
// on the axis strips so this is discoverable without reading the tour.
// Dragging inside the plot itself is left alone (that's panning, done via
// the wheel/trackpad/keyboard handlers below).
let axisHover = null; // 'y', 'x', or null - read by drawMain() to draw the hover highlight

(function initAxisDragZoom() {
  const ZOOM_RATE = 1.006; // how fast the zoom reacts to drag distance in pixels
  let mode = null;         // 'y', 'x', or null while not dragging
  let startX = 0, startY = 0, startScale = 1, startWindow = 0, startStart = 0;

  function axisAt(clientX, clientY) {
    const rect = el.mainCanvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    if (x >= 0 && x < MARGIN.left) return 'y';
    if (y >= 0 && y < MARGIN.top) return 'x';
    if (S.sampleRate && y > rect.height - MARGIN.bottom && y <= rect.height) return 'x';
    return null;
  }

  function setHover(axis) {
    if (axis === axisHover) return;
    axisHover = axis;
    el.canvasWrap.style.cursor = axis === 'y' ? 'ns-resize' : axis === 'x' ? 'ew-resize' : '';
    renderAll();
  }

  el.canvasWrap.addEventListener('mousemove', e => {
    if (mode || !S.rows.length) return;
    setHover(axisAt(e.clientX, e.clientY));
  });
  el.canvasWrap.addEventListener('mouseleave', () => {
    if (!mode) setHover(null);
  });

  function startDrag(axis, clientX, clientY) {
    mode = axis;
    startX = clientX; startY = clientY;
    startScale = S.scale; startWindow = S.window; startStart = S.start;
    document.body.style.userSelect = 'none';
  }
  function moveDrag(clientX, clientY) {
    if (mode === 'y') {
      const dy = clientY - startY;
      // Drag up = zoom in (smaller range), drag down = zoom out.
      S.scale = clamp(startScale * Math.pow(ZOOM_RATE, dy), SCALE_MIN, SCALE_MAX);
    } else if (mode === 'x') {
      const dx = clientX - startX;
      // Drag right = zoom in (fewer samples visible), drag left = zoom out.
      const newWindow = Math.round(startWindow * Math.pow(ZOOM_RATE, -dx));
      const center = startStart + startWindow / 2;
      setHorizontalView(center - newWindow / 2, newWindow);
    }
    renderAll();
  }
  function endDrag() {
    if (!mode) return;
    mode = null;
    document.body.style.userSelect = '';
    axisHover = null; // next mousemove (if the pointer is still over an axis) will restore it
    renderAll();
  }

  el.canvasWrap.addEventListener('mousedown', e => {
    if (!S.rows.length) return;
    const axis = axisAt(e.clientX, e.clientY);
    if (!axis) return;
    startDrag(axis, e.clientX, e.clientY);
    e.preventDefault();
  });
  el.canvasWrap.addEventListener('touchstart', e => {
    if (!S.rows.length) return;
    const t = e.touches[0];
    const axis = axisAt(t.clientX, t.clientY);
    if (!axis) return;
    startDrag(axis, t.clientX, t.clientY);
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('mousemove', e => { if (mode) moveDrag(e.clientX, e.clientY); });
  document.addEventListener('touchmove', e => { if (mode) moveDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  document.addEventListener('mouseup', endDrag);
  document.addEventListener('touchend', endDrag);
})();

/* -- FILE CLOSE (unload CSV, reset to fresh state) -- */
el.fileCloseBtn.addEventListener('click', () => {
  S.headers = []; S.numericIdx = []; S.rows = [];
  S.selected = new Set(); S.fftChannels = new Set();
  S.channelRanges = {}; S.sampleRate = null;
  S.start = 0; S.window = 1000; S.scale = 1;
  S.fftOpen = false; S.fileName = '';
  el.srInput.value = '';
  el.csvInput.value = '';
  el.fileBadge.style.display = 'none';
  el.fftCol.classList.remove('open');
  invalidateMinimap();
  buildChannelList(); renderAll();
});

/* -- ACTION BUTTONS -- */
el.autoBtn.addEventListener('click', () => { S.scale = 1; computeChannelRanges(); renderAll(); });
el.fitBtn.addEventListener('click', () => { if (S.rows.length) setHorizontalView(0, S.rows.length); renderAll(); });
el.fftBtn.addEventListener('click',   () => {
  S.fftOpen = !S.fftOpen;
  el.fftCol.classList.toggle('open', S.fftOpen);
  el.fftHandle.style.display = S.fftOpen ? '' : 'none';
  el.fftBtn.classList.toggle('active', S.fftOpen);
  if (!S.fftOpen) el.fftCol.style.width = '';
  setTimeout(renderAll, 50);
});
el.fftClose.addEventListener('click', () => {
  S.fftOpen = false;
  el.fftCol.classList.remove('open');
  el.fftHandle.style.display = 'none';
  el.fftBtn.classList.remove('active');
  el.fftCol.style.width = '';
  setTimeout(renderAll, 50);
});


/* -- WHEEL / TRACKPAD SCROLL & PINCH-ZOOM -- */
el.canvasWrap.addEventListener('wheel', e => {
  if (!S.rows.length) return;

  // Pinch zoom on trackpad (Ctrl+wheel) → Zoom X, centered on current view
  if (e.ctrlKey) {
    e.preventDefault();
    const oldW = S.window;
    const factor = Math.pow(1.003, e.deltaY);
    const center = S.start + oldW / 2;
    setHorizontalView(center - oldW * factor / 2, oldW * factor);
    renderAll();
    return;
  }

  const canScrollV = el.canvasScroll.scrollHeight > el.canvasScroll.clientHeight + 2;
  const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  const wrapW = el.canvasWrap.getBoundingClientRect().width || 600;

  if (isHorizontal) {
    e.preventDefault();
    const step = Math.max(1, Math.round(Math.abs(e.deltaX) * S.window / wrapW));
    S.start = clamp(S.start + (e.deltaX > 0 ? step : -step), 0, Math.max(0, S.rows.length - S.window));
    renderAll();
    return;
  }

  // Vertical: if canvas is taller than wrapper, let native scroll handle it
  if (canScrollV) return;

  e.preventDefault();
  const step = Math.max(1, Math.round(Math.abs(e.deltaY) * S.window / wrapW));
  S.start = clamp(S.start + (e.deltaY > 0 ? step : -step), 0, Math.max(0, S.rows.length - S.window));
  renderAll();
}, { passive: false });

/* -- KEYBOARD SHORTCUTS -- */
window.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select') || e.target.isContentEditable) return;
  const W = Math.max(1, Math.floor(S.window * 0.1));
  if (e.key === 'ArrowLeft')  { setHorizontalView(S.start - W, S.window); renderAll(); e.preventDefault(); }
  if (e.key === 'ArrowRight') { setHorizontalView(S.start + W, S.window); renderAll(); e.preventDefault(); }
  if (e.key === 'ArrowUp')   { S.scale = clamp(S.scale / 1.1, 0.05, 200); renderAll(); e.preventDefault(); }
  if (e.key === 'ArrowDown') { S.scale = clamp(S.scale * 1.1, 0.05, 200); renderAll(); e.preventDefault(); }
  if (e.key === '-') {
    const center = S.start + S.window / 2;
    setHorizontalView(center - S.window * 1.1 / 2, S.window * 1.1);
    renderAll(); e.preventDefault();
  }
  if (e.key === '=' || e.key === '+') {
    const center = S.start + S.window / 2;
    setHorizontalView(center - S.window / 1.1 / 2, S.window / 1.1);
    renderAll(); e.preventDefault();
  }
});

/* -- FFT PANEL RESIZE -- */
// The handle sits on the LEFT edge of the FFT panel, so dragging left grows
// the panel (drag direction is inverted vs. a normal right-edge handle).
(function initFftResize() {
  let dragging = false, startX = 0, startW = 0;

  function fftMaxW() {
    const maW = el.mainArea.getBoundingClientRect().width;
    return Math.min(maW * 0.55, maW - 220);
  }
  function applyDx(clientX) {
    const dx = startX - clientX;
    const minFW = parseInt(getComputedStyle(el.fftCol).minWidth) || 180;
    el.fftCol.style.width = clamp(startW + dx, minFW, fftMaxW()) + 'px';
    renderAll();
  }

  el.fftHandle.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX;
    startW = el.fftCol.getBoundingClientRect().width;
    el.fftHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  el.fftHandle.addEventListener('touchstart', e => {
    dragging = true;
    startX = e.touches[0].clientX;
    startW = el.fftCol.getBoundingClientRect().width;
    el.fftHandle.classList.add('dragging');
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('mousemove', e => { if (dragging) applyDx(e.clientX); });
  document.addEventListener('touchmove', e => { if (dragging) applyDx(e.touches[0].clientX); }, { passive: true });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    el.fftHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
  document.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    el.fftHandle.classList.remove('dragging');
  });
})();


/* -- SCRUBBER MINIMAP (full-data overview + pan + edge-resize zoom) -- */
function sizeMinimapCanvas() {
  const rect = el.minimapTrack.getBoundingClientRect();
  const cssW = Math.max(1, Math.floor(rect.width));
  const cssH = Math.max(1, Math.floor(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelW = Math.max(1, Math.round(cssW * dpr));
  const pixelH = Math.max(1, Math.round(cssH * dpr));
  const changed = el.minimapCanvas.width !== pixelW || el.minimapCanvas.height !== pixelH;
  if (changed) {
    el.minimapCanvas.width = pixelW;
    el.minimapCanvas.height = pixelH;
  }
  const ctx = el.minimapCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: cssW, height: cssH, changed };
}

// Draw a min/max envelope for the full file, like the NPG-Lite Cardio
// recording scrubber. Up to four visible channels are overlaid by color.
// The canvas is cached: panning/resizing only moves the viewport DOM element.
function drawMinimap() {
  const sized = sizeMinimapCanvas();
  if (!minimapDirty && !sized.changed) return;

  const { ctx, width: W, height: H } = sized;
  ctx.clearRect(0, 0, W, H);
  minimapDirty = false;

  const total = S.rows.length;
  if (!total) return;

  const channels = S.numericIdx
    .map((ci, idx) => ({ ci, idx }))
    .filter(({ ci }) => S.selected.has(ci))
    .slice(0, 4);
  if (!channels.length) return;

  const padY = 3;
  const usableH = Math.max(1, H - padY * 2);
  ctx.save();
  ctx.globalAlpha = channels.length === 1 ? 0.9 : 0.72;

  for (const { ci, idx } of channels) {
    const range = S.channelRanges[ci] || { lo: -1, hi: 1 };
    const span = Math.max(1e-12, range.hi - range.lo);
    ctx.fillStyle = trackColor(idx);

    for (let x = 0; x < W; x++) {
      const s0 = Math.floor((x / W) * total);
      const s1 = Math.max(s0 + 1, Math.floor(((x + 1) / W) * total));
      let mn = Infinity, mx = -Infinity;
      for (let s = s0; s < Math.min(total, s1); s++) {
        const value = S.rows[s][ci];
        if (!Number.isFinite(value)) continue;
        if (value < mn) mn = value;
        if (value > mx) mx = value;
      }
      if (mn === Infinity) continue;
      const yTop = padY + (1 - (mx - range.lo) / span) * usableH;
      const yBottom = padY + (1 - (mn - range.lo) / span) * usableH;
      ctx.fillRect(x, Math.max(padY, yTop), 1, Math.max(1, Math.min(H - padY, yBottom) - Math.max(padY, yTop)));
    }
  }
  ctx.restore();
}

function formatTimelinePosition(sampleIndex) {
  if (!Number.isFinite(sampleIndex) || sampleIndex < 0) return '0';
  return S.sampleRate ? fmt(sampleIndex / S.sampleRate, 2) + 's' : fmtN(sampleIndex);
}

function updateMinimapViewport() {
  const total = S.rows.length;
  const hasData = total > 0;
  el.minimapWrap.classList.toggle('disabled', !hasData);
  el.minimapWrap.setAttribute('aria-disabled', String(!hasData));

  if (!hasData) {
    el.tlStart.textContent = '0';
    el.tlEnd.textContent = '0';
    el.minimapViewport.style.display = 'none';
    return;
  }

  setHorizontalView(S.start, S.window);
  el.minimapViewport.style.display = '';
  el.tlStart.textContent = formatTimelinePosition(0);
  el.tlEnd.textContent = formatTimelinePosition(Math.max(0, total - 1));

  const trackW = Math.max(1, el.minimapTrack.clientWidth);
  const exactLeft = (S.start / total) * trackW;
  const exactWidth = Math.min(trackW, (S.window / total) * trackW);
  // Keep the controls usable when zoomed into a tiny fraction of a long file.
  const minVisualWidth = Math.min(trackW, 26);
  const visualWidth = Math.max(exactWidth, minVisualWidth);
  const visualLeft = clamp(exactLeft - (visualWidth - exactWidth) / 2, 0, trackW - visualWidth);

  el.minimapViewport.style.left = visualLeft + 'px';
  el.minimapViewport.style.width = visualWidth + 'px';
  el.minimapViewport.classList.toggle('narrow', visualWidth < 54);

  const end = Math.min(total, S.start + S.window);
  const rangeText = `${formatTimelinePosition(S.start)} – ${formatTimelinePosition(Math.max(S.start, end - 1))}`;
  el.minimapViewport.title = `${rangeText} (${fmtN(S.window)} samples visible)`;
  el.minimapViewport.setAttribute('aria-valuemax', String(Math.max(0, total - S.window)));
  el.minimapViewport.setAttribute('aria-valuenow', String(S.start));
  el.minimapViewport.setAttribute('aria-valuetext', `${rangeText}; ${fmtN(S.window)} samples visible`);
}

(function initMinimapControls() {
  let drag = null;

  function beginDrag(mode, e, owner) {
    if (!S.rows.length || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.minimapTrack.getBoundingClientRect();
    if (rect.width <= 0) return;
    try { owner.setPointerCapture(e.pointerId); } catch (_) {}
    drag = {
      mode,
      pointerId: e.pointerId,
      startX: e.clientX,
      startStart: S.start,
      startWindow: S.window,
      rect,
      owner,
    };
    el.minimapWrap.classList.add('is-dragging');
    document.body.style.userSelect = 'none';
  }

  function moveDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId || !S.rows.length) return;
    e.preventDefault();
    const total = S.rows.length;
    const deltaSamples = Math.round(((e.clientX - drag.startX) / drag.rect.width) * total);

    if (drag.mode === 'pan') {
      setHorizontalView(drag.startStart + deltaSamples, drag.startWindow);
    } else if (drag.mode === 'left') {
      const fixedEnd = drag.startStart + drag.startWindow;
      const newStart = clamp(drag.startStart + deltaSamples, 0, fixedEnd - minHorizontalWindow());
      setHorizontalView(newStart, fixedEnd - newStart);
    } else if (drag.mode === 'right') {
      const maxWindowFromStart = total - drag.startStart;
      const newWindow = clamp(drag.startWindow + deltaSamples, minHorizontalWindow(), maxWindowFromStart);
      setHorizontalView(drag.startStart, newWindow);
    }
    renderAll();
  }

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
    try { drag.owner.releasePointerCapture(drag.pointerId); } catch (_) {}
    drag = null;
    el.minimapWrap.classList.remove('is-dragging');
    document.body.style.userSelect = '';
  }

  el.minimapViewport.addEventListener('pointerdown', e => {
    const mode = e.target === el.minimapLeftHandle ? 'left'
      : e.target === el.minimapRightHandle ? 'right'
      : 'pan';
    beginDrag(mode, e, el.minimapViewport);
  });

  // Clicking the overview jumps the current window to that location and then
  // immediately becomes a pan drag, matching the Cardio minimap interaction.
  el.minimapTrack.addEventListener('pointerdown', e => {
    if (!S.rows.length || el.minimapViewport.contains(e.target)) return;
    const rect = el.minimapTrack.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    setHorizontalView(ratio * S.rows.length - S.window / 2, S.window);
    renderAll();
    beginDrag('pan', e, el.minimapTrack);
    if (drag) {
      drag.startStart = S.start;
      drag.startWindow = S.window;
    }
  });

  document.addEventListener('pointermove', moveDrag, { passive: false });
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', () => endDrag());

  // Keyboard navigation when the minimap window is focused.
  el.minimapViewport.addEventListener('keydown', e => {
    if (!S.rows.length) return;
    const step = Math.max(1, Math.round(S.window * (e.shiftKey ? 0.25 : 0.05)));
    if (e.key === 'ArrowLeft') setHorizontalView(S.start - step, S.window);
    else if (e.key === 'ArrowRight') setHorizontalView(S.start + step, S.window);
    else if (e.key === 'Home') setHorizontalView(0, S.window);
    else if (e.key === 'End') setHorizontalView(S.rows.length - S.window, S.window);
    else if (e.key === '-' || e.key === '_') {
      const center = S.start + S.window / 2;
      setHorizontalView(center - S.window * 1.15 / 2, S.window * 1.15);
    } else if (e.key === '+' || e.key === '=') {
      const center = S.start + S.window / 2;
      setHorizontalView(center - S.window / 1.15 / 2, S.window / 1.15);
    } else return;
    e.preventDefault();
    e.stopPropagation();
    renderAll();
  });
})();


/* ---- MAIN PLOT RENDERING (draws the multi-channel waveform canvas) ---- */
/* -- CANVAS SIZING (device-pixel-ratio aware) -- */
const DPR = Math.min(window.devicePixelRatio || 1, 2);

function sizeCanvas(canvas, w, h) {
  const pw = Math.max(10, Math.round(w * DPR));
  const ph = Math.max(10, Math.round(h * DPR));
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  return { w, h };
}

/* -- CURRENT WINDOW DATA -- */
function windowRows() {
  return S.rows.slice(S.start, S.start + S.window);
}
function visibleSeries(rows) {
  return S.numericIdx
    .map((ci, idx) => ({ ci, idx, name: S.headers[ci], color: trackColor(idx) }))
    .filter(s => S.selected.has(s.ci))
    .map(s => {
      const vals = new Float64Array(rows.length);
      for (let r = 0; r < rows.length; r++) vals[r] = rows[r][s.ci];
      return { ...s, vals };
    });
}

/* -- MAIN PLOT RENDERING -- */
const MARGIN = { top: 20, right: 14, bottom: 32, left: 62 };
const MIN_BAND = 80;
const PREF_BAND = 130;

function drawMain() {
  const N = S.numericIdx.filter(i => S.selected.has(i)).length;
  const rows = windowRows();

  const wrapH = el.canvasWrap.getBoundingClientRect().height || 400;
  const wrapW = el.canvasWrap.getBoundingClientRect().width  || 600;
  const naturalH = N <= 1 ? wrapH : Math.max(wrapH, N * PREF_BAND + MARGIN.top + MARGIN.bottom);
  const useScroll = naturalH > wrapH + 10;

  el.canvasScroll.style.overflowY = useScroll ? 'auto' : 'hidden';
  el.canvasScroll.style.height    = '100%';
  el.mainCanvas.style.height      = useScroll ? naturalH + 'px' : '100%';

  const canvasW = wrapW;
  const canvasH = useScroll ? naturalH : wrapH;

  sizeCanvas(el.mainCanvas, canvasW, canvasH);
  mainCtx.clearRect(0, 0, canvasW, canvasH);

  mainCtx.fillStyle = cssVar('--surf');
  mainCtx.fillRect(0, 0, canvasW, canvasH);

  // Dynamic left margin: measure widest Y-axis label across visible channels
  mainCtx.font = `10px ${cssVar('--mono')}`;
  let dynLeft = 44;
  for (const ci of S.numericIdx) {
    if (!S.selected.has(ci)) continue;
    const range = S.channelRanges[ci];
    if (!range) continue;
    const { lo, hi } = range;
    const center = (lo + hi) / 2;
    for (const v of [lo, hi, center]) {
      const w = mainCtx.measureText(fmtLbl(v)).width;
      if (w + 10 > dynLeft) dynLeft = Math.ceil(w) + 10;
    }
  }
  MARGIN.left = Math.min(dynLeft, 90);
  MARGIN.bottom = S.sampleRate ? 32 : 8;

  const plotW = Math.max(10, canvasW - MARGIN.left - MARGIN.right);
  const plotH = Math.max(10, canvasH - MARGIN.top  - MARGIN.bottom);

  if (!rows.length || !N) {
    el.emptyState.style.display = S.rows.length ? 'none' : 'flex';
    drawPointAxis(mainCtx, plotW, rows.length);
    drawTimeAxis(mainCtx, canvasW, canvasH, plotW, rows.length);
    if (rows.length) drawAxisZoomHints(mainCtx, plotW, plotH, canvasH);
    return;
  }
  el.emptyState.style.display = 'none';

  const series = visibleSeries(rows);
  const bandH  = plotH / Math.max(1, series.length);

  const gridColor = cssVar('--grid');
  mainCtx.save();
  mainCtx.strokeStyle = gridColor;
  mainCtx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const x = MARGIN.left + (i / 8) * plotW;
    mainCtx.beginPath(); mainCtx.moveTo(x, MARGIN.top); mainCtx.lineTo(x, MARGIN.top + plotH); mainCtx.stroke();
  }
  mainCtx.restore();

  const step = Math.max(1, Math.ceil(rows.length / (plotW * 2)));

  series.forEach((s, si) => {
    const bandTop  = MARGIN.top + si * bandH;
    const innerTop = bandTop + 6;
    const innerH   = Math.max(12, bandH - 12);

    const range = S.channelRanges[s.ci] || { lo: -1, hi: 1 };
    const { lo, hi } = range;
    const center    = (lo + hi) / 2;
    const halfRange = Math.max((hi - lo) / 2, 1e-12) * S.scale * 1.1;
    const yMin = center - halfRange;
    const yMax = center + halfRange;

    if (si > 0) {
      mainCtx.save();
      mainCtx.strokeStyle = cssVar('--divider');
      mainCtx.lineWidth = 1;
      mainCtx.beginPath(); mainCtx.moveTo(MARGIN.left, bandTop); mainCtx.lineTo(MARGIN.left + plotW, bandTop); mainCtx.stroke();
      mainCtx.restore();
    }

    mainCtx.save();
    mainCtx.fillStyle = s.color;
    mainCtx.font = `600 11px ${cssVar('--font')}`;
    mainCtx.fillText(s.name, MARGIN.left + 6, bandTop + 16);
    mainCtx.restore();

    mainCtx.save();
    mainCtx.fillStyle = cssVar('--muted');
    mainCtx.font = `10px ${cssVar('--mono')}`;
    mainCtx.textAlign = 'right';
    mainCtx.fillText(fmtLbl(hi),     MARGIN.left - 4, innerTop + 8);
    mainCtx.fillText(fmtLbl(center), MARGIN.left - 4, innerTop + innerH / 2 + 4);
    mainCtx.fillText(fmtLbl(lo),     MARGIN.left - 4, innerTop + innerH);
    mainCtx.restore();

    mainCtx.save();
    mainCtx.beginPath();
    mainCtx.rect(MARGIN.left, innerTop - 4, plotW, innerH + 8);
    mainCtx.clip();

    mainCtx.strokeStyle = s.color;
    mainCtx.lineWidth   = 1.6;
    mainCtx.lineJoin    = 'round';
    mainCtx.lineCap     = 'round';
    mainCtx.beginPath();
    let started = false;
    for (let i = 0; i < s.vals.length; i += step) {
      const v = s.vals[i];
      if (!isFinite(v)) { started = false; continue; }
      const x = MARGIN.left + (i / Math.max(1, s.vals.length - 1)) * plotW;
      const y = innerTop + (1 - (v - yMin) / Math.max(1e-12, yMax - yMin)) * innerH;
      if (!started) { mainCtx.moveTo(x, y); started = true; } else mainCtx.lineTo(x, y);
    }
    mainCtx.stroke();
    mainCtx.restore();
  });

  mainCtx.save();
  mainCtx.strokeStyle = cssVar('--axis-line');
  mainCtx.lineWidth = 1;
  mainCtx.beginPath();
  mainCtx.moveTo(MARGIN.left, MARGIN.top);
  mainCtx.lineTo(MARGIN.left, MARGIN.top + plotH);
  mainCtx.lineTo(MARGIN.left + plotW, MARGIN.top + plotH);
  mainCtx.stroke();
  mainCtx.restore();

  drawPointAxis(mainCtx, plotW, rows.length);
  drawTimeAxis(mainCtx, canvasW, canvasH, plotW, rows.length);
  drawAxisZoomHints(mainCtx, plotW, plotH, canvasH);
}

// Small persistent arrow hints in the axis margins, so it's visible (not just
// a cursor change on hover) that dragging the axes zooms the plot. The axis
// currently under the mouse (tracked in the controls section) also gets a
// light highlight tint.
function drawAxisZoomHints(ctx, plotW, plotH, canvasH) {
  const primary = cssVar('--primary');
  const faint = cssVar('--faint');

  if (axisHover === 'y' || axisHover === 'x') {
    ctx.save();
    ctx.fillStyle = primary;
    ctx.globalAlpha = 0.1;
    if (axisHover === 'y') {
      ctx.fillRect(0, MARGIN.top, MARGIN.left, plotH);
    } else {
      ctx.fillRect(MARGIN.left, 0, plotW, MARGIN.top);
      if (S.sampleRate) ctx.fillRect(MARGIN.left, canvasH - MARGIN.bottom, plotW, MARGIN.bottom);
    }
    ctx.restore();
  }

  drawChevronPair(ctx, MARGIN.left / 2, MARGIN.top + 14, true, axisHover === 'y' ? primary : faint);
  // Offset from plotW/2 so it doesn't sit on top of the middle index tick label.
  drawChevronPair(ctx, MARGIN.left + plotW * 0.44, MARGIN.top / 2, false, axisHover === 'x' ? primary : faint);
}

// Draws a small pair of chevrons pointing away from each other: up+down
// (vertical=true, hints "drag up/down here") or left+right (horizontal).
function drawChevronPair(ctx, cx, cy, vertical, color) {
  const gap = 4, len = 4, spread = 3;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (vertical) {
    ctx.moveTo(cx - spread, cy - gap); ctx.lineTo(cx, cy - gap - len); ctx.lineTo(cx + spread, cy - gap);
    ctx.moveTo(cx - spread, cy + gap); ctx.lineTo(cx, cy + gap + len); ctx.lineTo(cx + spread, cy + gap);
  } else {
    ctx.moveTo(cx - gap, cy - spread); ctx.lineTo(cx - gap - len, cy); ctx.lineTo(cx - gap, cy + spread);
    ctx.moveTo(cx + gap, cy - spread); ctx.lineTo(cx + gap + len, cy); ctx.lineTo(cx + gap, cy + spread);
  }
  ctx.stroke();
  ctx.restore();
}

// Sample-index ticks along the top of the plot (always shown once data is loaded).
function drawPointAxis(ctx, plotW, rowCount) {
  if (!rowCount) return;
  ctx.save();
  ctx.fillStyle = cssVar('--muted');
  ctx.font = `10px ${cssVar('--mono')}`;
  ctx.textAlign = 'center';
  for (let i = 0; i <= 8; i++) {
    const x = MARGIN.left + (i / 8) * plotW;
    const sIdx = S.start + Math.round((i / 8) * Math.max(0, rowCount - 1));
    ctx.fillText(fmtN(sIdx), x, MARGIN.top - 5);
  }
  ctx.restore();
}

// Time ticks along the bottom - only drawn once a sampling rate is known.
function drawTimeAxis(ctx, cw, ch, plotW, rowCount) {
  if (!S.sampleRate) return;
  ctx.save();
  ctx.fillStyle = cssVar('--muted');
  ctx.font = `10px ${cssVar('--mono')}`;
  ctx.textAlign = 'center';
  for (let i = 0; i <= 8; i++) {
    const x = MARGIN.left + (i / 8) * plotW;
    const sIdx = S.start + Math.round((i / 8) * Math.max(0, rowCount - 1));
    ctx.fillText(fmt(sIdx / S.sampleRate, 2) + 's', x, ch - 8);
  }
  ctx.restore();
}


/* ---- FFT (frequency-spectrum math + draws the FFT panel canvas) ---- */
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

// In-place iterative FFT (Cooley-Tukey, radix-2). `re`/`im` must have a
// power-of-2 length; results are written back into them.
function fftIP(re, im) {
  const n = re.length; let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) { [re[i],re[j]] = [re[j],re[i]]; [im[i],im[j]] = [im[j],im[i]]; }
    let m = n >> 1;
    while (j >= m && m >= 2) { j -= m; m >>= 1; }
    j += m;
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wc = Math.cos(ang), ws = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let rc = 1, rs = 0;
      for (let k = 0; k < len >> 1; k++) {
        const ur = re[i+k], ui = im[i+k];
        const vr = re[i+k+(len>>1)]*rc - im[i+k+(len>>1)]*rs;
        const vi = re[i+k+(len>>1)]*rs + im[i+k+(len>>1)]*rc;
        re[i+k] = ur+vr; im[i+k] = ui+vi;
        re[i+k+(len>>1)] = ur-vr; im[i+k+(len>>1)] = ui-vi;
        const nc = rc*wc - rs*ws; rs = rc*ws + rs*wc; rc = nc;
      }
    }
  }
}

// Returns magnitude spectrum for a real-valued signal (mean-subtracted,
// zero-padded to the next power of 2).
function fftMags(signal) {
  const n0 = signal.length, n = nextPow2(Math.max(8, n0));
  const re = new Float64Array(n), im = new Float64Array(n);
  let mean = 0; for (let i = 0; i < n0; i++) mean += signal[i]; mean /= n0 || 1;
  for (let i = 0; i < n0; i++) re[i] = signal[i] - mean;
  fftIP(re, im);
  const half = n >> 1, mags = new Float64Array(half);
  for (let i = 0; i < half; i++) mags[i] = Math.hypot(re[i], im[i]) / n0;
  return { mags, n };
}

/* -- FFT PANEL RENDERING -- */
function drawFFT() {
  if (!S.fftOpen) return;
  const rect = el.fftCanvas.getBoundingClientRect();
  const W = rect.width || 260, H = rect.height || 360;
  sizeCanvas(el.fftCanvas, W, H);
  fftCtx.clearRect(0, 0, W, H);
  fftCtx.fillStyle = cssVar('--surf');
  fftCtx.fillRect(0, 0, W, H);

  const rows = windowRows();
  const sr = S.sampleRate || 1;
  const nyquist = sr / 2;
  const maxFreq = S.sampleRate ? Math.min(nyquist, 150) : nyquist;

  const fftSeries = S.numericIdx
    .map((ci, idx) => ({ ci, idx, name: S.headers[ci], color: trackColor(idx) }))
    .filter(s => S.fftChannels.has(s.ci))
    .map(s => {
      const vals = new Float64Array(rows.length);
      for (let r = 0; r < rows.length; r++) vals[r] = rows[r][s.ci];
      return { ...s, vals };
    });

  // Compute magnitudes first so we know globalMax for a dynamic Y margin
  let globalMax = 0;
  const computed = fftSeries.slice(0, 8).map(s => {
    const clean = Array.from(s.vals).map(v => isFinite(v) ? v : 0);
    const { mags, n } = fftMags(clean);
    const cutoff = S.sampleRate ? Math.min(mags.length, Math.ceil(maxFreq * n / sr) + 1) : mags.length;
    for (let i = 1; i < cutoff; i++) {
      if (mags[i] > globalMax) globalMax = mags[i];
    }
    return { ...s, mags, n, cutoff };
  });
  globalMax = globalMax || 1;

  // Dynamic left margin based on widest Y-label
  fftCtx.font = `10px ${cssVar('--mono')}`;
  let maxLabelW = 0;
  for (let i = 0; i <= 4; i++) {
    const w = fftCtx.measureText(fmtLbl(globalMax * (1 - i / 4))).width;
    if (w > maxLabelW) maxLabelW = w;
  }
  const M = { top: 14, right: 10, bottom: 30, left: Math.min(Math.ceil(maxLabelW) + 10, 80) };
  const pW = Math.max(10, W - M.left - M.right);
  const pH = Math.max(10, H - M.top - M.bottom);

  // Grid
  fftCtx.save();
  fftCtx.strokeStyle = cssVar('--grid');
  fftCtx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = M.top + (i / 5) * pH;
    fftCtx.beginPath(); fftCtx.moveTo(M.left, y); fftCtx.lineTo(M.left + pW, y); fftCtx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const x = M.left + (i / 5) * pW;
    fftCtx.beginPath(); fftCtx.moveTo(x, M.top); fftCtx.lineTo(x, M.top + pH); fftCtx.stroke();
  }
  fftCtx.restore();

  if (!fftSeries.length) {
    el.fftHeader.textContent = 'FFT: select a channel above';
    fftCtx.save();
    fftCtx.fillStyle = cssVar('--faint');
    fftCtx.font = `12px ${cssVar('--font')}`;
    fftCtx.textAlign = 'center';
    fftCtx.fillText('No channel', M.left + pW / 2, M.top + pH / 2 - 8);
    fftCtx.fillText('selected above', M.left + pW / 2, M.top + pH / 2 + 10);
    fftCtx.restore();
    drawFFTAxes(fftCtx, M, pW, pH, W, H, maxFreq, globalMax);
    return;
  }

  // Draw each channel's spectrum line
  fftCtx.save();
  fftCtx.beginPath();
  fftCtx.rect(M.left, M.top, pW, pH);
  fftCtx.clip();

  computed.forEach(s => {
    fftCtx.beginPath();
    fftCtx.strokeStyle = s.color;
    fftCtx.lineWidth = 1.6;
    let started = false;
    for (let i = 1; i < s.cutoff; i++) {
      const f = i * sr / s.n;
      if (f > maxFreq) break;
      const x = M.left + (f / maxFreq) * pW;
      const y = M.top + (1 - s.mags[i] / globalMax) * pH;
      if (!started) { fftCtx.moveTo(x, y); started = true; }
      else fftCtx.lineTo(x, y);
    }
    fftCtx.stroke();
  });
  fftCtx.restore();

  // Legend (top-right, with colored lines)
  const legendX = M.left + pW - 4;
  let legendY = M.top + 6;
  computed.forEach(s => {
    fftCtx.save();
    fftCtx.strokeStyle = s.color;
    fftCtx.lineWidth = 2;
    fftCtx.beginPath();
    fftCtx.moveTo(legendX - 26, legendY + 4);
    fftCtx.lineTo(legendX - 6, legendY + 4);
    fftCtx.stroke();
    fftCtx.fillStyle = s.color;
    fftCtx.font = `600 9px ${cssVar('--font')}`;
    fftCtx.textAlign = 'right';
    const label = s.name.length > 10 ? s.name.slice(0, 9) + '…' : s.name;
    fftCtx.fillText(label, legendX - 30, legendY + 8);
    fftCtx.restore();
    legendY += 14;
  });

  drawFFTAxes(fftCtx, M, pW, pH, W, H, maxFreq, globalMax);

  const capLabel = S.sampleRate ? `FFT 0-${Math.round(maxFreq)} Hz` : 'FFT: set sample rate for Hz';
  el.fftHeader.textContent = capLabel;
}

function drawFFTAxes(ctx, M, pW, pH, W, H, maxFreq, globalMax) {
  ctx.save();
  ctx.strokeStyle = cssVar('--axis-line');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(M.left, M.top); ctx.lineTo(M.left, M.top + pH); ctx.lineTo(M.left + pW, M.top + pH);
  ctx.stroke();

  ctx.fillStyle = cssVar('--muted');
  ctx.font = `10px ${cssVar('--mono')}`;

  // Y labels (magnitude)
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = M.top + (i / 4) * pH;
    ctx.fillText(fmtLbl(globalMax * (1 - i / 4)), M.left - 3, y + 4);
  }

  // X labels (frequency)
  ctx.textAlign = 'center';
  const tickCount = Math.min(6, Math.floor(pW / 40));
  for (let i = 0; i <= tickCount; i++) {
    const x = M.left + (i / tickCount) * pW;
    const freqVal = maxFreq * i / tickCount;
    const label = S.sampleRate ? Math.round(freqVal) + 'Hz' : fmt(freqVal, 1);
    ctx.fillText(label, x, H - 8);
  }
  ctx.restore();
}


/* ---- RENDER LOOP & STARTUP (ties plot+FFT together; last section runs on page load) ---- */
/* -- MINIMAP SYNC -- */
function updateTimeline() {
  updateMinimapViewport();
  drawMinimap();
}

/* -- MAIN RENDER LOOP -- */
// All state-changing code calls renderAll() rather than drawing directly;
// this coalesces bursts of changes (e.g. drag events) into one frame.
let raf = 0;
function renderAll() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    updateTimeline();
    drawMain();
    drawFFT();
  });
}

/* -- RESIZE HANDLING -- */
const ro = new ResizeObserver(entries => {
  if (entries.some(entry => entry.target === el.minimapTrack)) invalidateMinimap();
  renderAll();
});
ro.observe(el.canvasWrap);
ro.observe(el.fftCanvas.parentElement);
ro.observe(el.minimapTrack);

window.addEventListener('resize', () => {
  if (S.fftOpen) {
    const maW = el.mainArea.getBoundingClientRect().width;
    const minFW = parseInt(getComputedStyle(el.fftCol).minWidth) || 180;
    const maxFW = Math.min(maW * 0.55, maW - minFW - 40);
    if (maxFW > 0) {
      const currFW = el.fftCol.getBoundingClientRect().width;
      if (currFW > maxFW) el.fftCol.style.width = maxFW + 'px';
    }
  }
  renderAll();
}, { passive: true });

/* -- INIT -- */
renderAll();


/* ---- ONBOARDING TOUR (spotlight walkthrough, independent of everything above) ---- */
(function() {
'use strict';

const TOUR_SEEN_KEY = 'csvplotter_tour_seen';

const steps = [
  {
    target: () => document.querySelector('.upload-btn'),
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    title: 'Welcome to Chords CSV Plotter',
    body: 'Start by uploading a CSV file. Enter a sampling rate when prompted, or skip it.',
    arrow: 'top',
    pad: 6,
  },
  {
    target: () => document.querySelector('.topbar-controls'),
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>`,
    title: 'Controls',
    body: '<strong>SPS</strong> shows real timestamps on the x-axis. <strong>Auto</strong> resets vertical zoom, <strong>Fit</strong> resets horizontal zoom.',
    arrow: 'top',
    pad: 4,
  },
  {
    target: () => document.getElementById('canvasWrap'),
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 12l3-3 4 4 5-6"/></svg>`,
    title: 'Zooming',
    body: 'Drag the <strong>left value-axis</strong> up/down to zoom vertically, or the <strong>top/bottom axis</strong> left/right to zoom horizontally. You can also pinch or Ctrl+scroll on the plot.',
    arrow: 'top',
    pad: 4,
  },
  {
    target: () => document.getElementById('sidebar'),
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    title: 'Channels',
    body: 'Hover the left strip to reveal all channels. Toggle each one on or off — each gets its own color and autoscaled lane.',
    arrow: 'right',
    pad: 4,
  },
  {
    target: () => document.querySelector('.timeline'),
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
    title: 'Navigating the data',
    body: 'The bottom minimap shows the full file. Drag the highlighted window to scroll, click anywhere to jump, or drag either edge to zoom horizontally.',
    arrow: 'top',
    pad: 4,
  },
  {
    target: () => document.getElementById('fftBtn'),
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    title: 'FFT viewer',
    body: 'Click <strong>FFT</strong> for a live frequency spectrum of the visible window. Pick channels using the pills at the top of the panel.',
    arrow: 'top',
    pad: 6,
  },
  {
    target: null,
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`,
    title: 'Shortcuts',
    body: `<kbd>←</kbd> <kbd>→</kbd> scroll &nbsp;·&nbsp; <kbd>↑</kbd> <kbd>↓</kbd> Zoom Y<br><kbd>-</kbd> zoom out X &nbsp;·&nbsp; <kbd>+</kbd> zoom in X &nbsp;·&nbsp; pinch to zoom X<br><br>You can also focus the minimap window and use the arrow keys. Press <strong>?</strong> anytime to replay this tour.`,
    arrow: 'none',
    pad: 0,
  },
];

let cur = 0;
let active = false;

const tDim   = document.getElementById('tourDim');
const tHL    = document.getElementById('tourHL');
const tCard  = document.getElementById('tourCard');
const tBadge = document.getElementById('tourBadge');
const tDots  = document.getElementById('tourDots');
const tIcon  = document.getElementById('tourIcon');
const tTitle = document.getElementById('tourTitle');
const tBody  = document.getElementById('tourBody');
const tClose = document.getElementById('tourClose');
const tSkip  = document.getElementById('tourSkip');
const tPrev  = document.getElementById('tourPrev');
const tNext  = document.getElementById('tourNext');
const helpBtn = document.getElementById('helpBtn');

function buildDots() {
  tDots.innerHTML = '';
  steps.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'tour-dot' + (i === cur ? ' active' : '');
    tDots.appendChild(d);
  });
}

function getTargetRect(step) {
  if (!step.target) return null;
  const el = step.target();
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const pad = step.pad || 0;
  return {
    top: r.top - pad,
    left: r.left - pad,
    width: r.width + pad * 2,
    height: r.height + pad * 2,
    bottom: r.bottom + pad,
    right: r.right + pad,
    cx: r.left + r.width / 2,
    cy: r.top + r.height / 2,
  };
}

const CARD_W = 300, CARD_H = 230, MARGIN = 16;

function positionCard(rect, arrow) {
  const vw = window.innerWidth, vh = window.innerHeight;
  let top, left, arrowDir = arrow;

  if (!rect || arrow === 'none') {
    top  = (vh - CARD_H) / 2;
    left = (vw - CARD_W) / 2;
    arrowDir = 'none';
  } else {
    const spaceRight  = vw - rect.right;
    const spaceLeft   = rect.left;
    const spaceBottom = vh - rect.bottom;
    const spaceTop    = rect.top;

    if (arrow === 'right' || (spaceRight >= CARD_W + MARGIN + 12)) {
      left = rect.right + 12;
      top  = Math.max(MARGIN, Math.min(vh - CARD_H - MARGIN, rect.cy - CARD_H / 2));
      arrowDir = 'left';
    } else if (spaceLeft >= CARD_W + MARGIN + 12) {
      left = rect.left - CARD_W - 12;
      top  = Math.max(MARGIN, Math.min(vh - CARD_H - MARGIN, rect.cy - CARD_H / 2));
      arrowDir = 'right';
    } else if (spaceBottom >= CARD_H + MARGIN + 12) {
      top  = rect.bottom + 12;
      left = Math.max(MARGIN, Math.min(vw - CARD_W - MARGIN, rect.cx - CARD_W / 2));
      arrowDir = 'top';
    } else {
      top  = rect.top - CARD_H - 12;
      left = Math.max(MARGIN, Math.min(vw - CARD_W - MARGIN, rect.cx - CARD_W / 2));
      arrowDir = 'bottom';
    }

    top  = Math.max(MARGIN, Math.min(vh - CARD_H - MARGIN, top));
    left = Math.max(MARGIN, Math.min(vw - CARD_W - MARGIN, left));
  }

  tCard.style.top  = top + 'px';
  tCard.style.left = left + 'px';
  tCard.setAttribute('data-arrow', arrowDir);
}

function showStep(idx) {
  cur = Math.max(0, Math.min(steps.length - 1, idx));
  const step = steps[cur];
  const rect  = getTargetRect(step);
  const isLast = cur === steps.length - 1;
  const isFirst = cur === 0;

  tBadge.textContent = `Step ${cur + 1} of ${steps.length}`;
  tIcon.innerHTML    = step.icon;
  tTitle.textContent = step.title;
  tBody.innerHTML    = step.body;
  tNext.textContent  = isLast ? '✓ Done' : 'Next →';
  tPrev.style.display = isFirst ? 'none' : '';
  buildDots();

  if (rect) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const hl = Math.max(0, rect.left);
    const ht = Math.max(0, rect.top);
    tHL.style.left   = hl + 'px';
    tHL.style.top    = ht + 'px';
    tHL.style.width  = Math.max(0, Math.min(rect.right,  vw) - hl) + 'px';
    tHL.style.height = Math.max(0, Math.min(rect.bottom, vh) - ht) + 'px';
    tHL.classList.add('visible');
    tDim.classList.remove('visible');
  } else {
    tHL.classList.remove('visible');
    tDim.classList.add('visible');
  }

  positionCard(rect, step.arrow);

  if (!tCard.classList.contains('visible')) {
    tCard.classList.add('visible');
  }
}

function startTour() {
  active = true;
  cur = 0;
  showStep(0);
}

function endTour() {
  active = false;
  tHL.classList.remove('visible');
  tDim.classList.remove('visible');
  tCard.classList.remove('visible');
  localStorage.setItem(TOUR_SEEN_KEY, '1');
}

tNext.addEventListener('click', () => {
  if (cur >= steps.length - 1) { endTour(); return; }
  showStep(cur + 1);
});
tPrev.addEventListener('click', () => showStep(cur - 1));
tClose.addEventListener('click', endTour);
tSkip.addEventListener('click',  endTour);
helpBtn.addEventListener('click', startTour);

document.addEventListener('keydown', e => {
  if (!active) return;
  if (e.key === 'Escape')     { endTour(); e.stopPropagation(); }
  if (e.key === 'ArrowRight') { if (cur < steps.length - 1) showStep(cur + 1); e.stopPropagation(); }
  if (e.key === 'ArrowLeft')  { if (cur > 0) showStep(cur - 1); e.stopPropagation(); }
}, true);

window.addEventListener('resize', () => {
  if (!active) return;
  const rect = getTargetRect(steps[cur]);
  if (rect) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const hl = Math.max(0, rect.left);
    const ht = Math.max(0, rect.top);
    tHL.style.left   = hl + 'px';
    tHL.style.top    = ht + 'px';
    tHL.style.width  = Math.max(0, Math.min(rect.right,  vw) - hl) + 'px';
    tHL.style.height = Math.max(0, Math.min(rect.bottom, vh) - ht) + 'px';
  }
  positionCard(rect, steps[cur].arrow);
}, { passive: true });

if (!localStorage.getItem(TOUR_SEEN_KEY)) {
  setTimeout(startTour, 600);
}

})();
