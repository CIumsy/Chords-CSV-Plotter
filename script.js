/*
Code sections:
1. App state and helpers
2. Theme
3. CSV loading
4. Channel lists
5. Controls
6. Main plot
7. FFT
8. Rendering and startup
9. Tour
*/

// App state and helpers: track colors
/*
Channels use these colors in order.
The CSS variables provide colors for each theme.
*/
const TRACKS = ['--c1','--c2','--c3','--c4','--c5','--c6','--c7','--c8'];
function trackColor(i) {
  return cssVar(TRACKS[i % TRACKS.length]);
}

// App state
/*
This stores the loaded CSV and current view.
Reloading the page resets it.
*/
const S = {
  headers: [],          // CSV column names
  numericIdx: [],        // Numeric column indexes
  columns: {},           // Numeric columns stored by index
  rowCount: 0,           // Samples per numeric column
  overview: {},          // Minimap min and max buckets
  lod: {},               // Plot detail levels
  selected: new Set(),   // Channels shown on the plot
  fftChannels: new Set(),// Channels shown in FFT
  channelRanges: {},     // Minimum and maximum per channel
  sampleRate: null,      // Samples per second
  start: 0,              // First visible sample
  window: 1000,          // Visible sample count
  scale: 1,              // Vertical scale
  fftOpen: false,        // FFT panel state
  fileName: '',          // Loaded file name
};

// DOM elements
/*
Elements are found once by ID.
Use el.name to access them later.
*/
const $ = id => document.getElementById(id);
const el = {
  csvInput: $('csvInput'), uploadBtn: $('uploadBtn'), uploadText: $('uploadText'), helpBtn: $('helpBtn'), themeBtn: $('themeBtn'),
  chordsLogo: $('chordsLogo'),
  srInput: $('srInput'),
  scaleMinusBtn: $('scaleMinusBtn'), scalePlusBtn: $('scalePlusBtn'), scaleValue: $('scaleValue'), fftBtn: $('fftBtn'),
  fileNameDisplay: $('fileNameDisplay'), fileBadge: $('fileBadge'), fileBadgeRow: $('fileBadgeRow'), fileCloseBtn: $('fileCloseBtn'),
  chList: $('chList'),
  canvasWrap: $('canvasWrap'), canvasScroll: $('canvasScroll'),
  mainCanvas: $('mainCanvas'), emptyState: $('emptyState'), emptyTitle: $('emptyTitle'),
  emptyMessage: $('emptyMessage'), emptyUploadBtn: $('emptyUploadBtn'),
  minimapWrap: $('minimapWrap'), minimapTrack: $('minimapTrack'), minimapCanvas: $('minimapCanvas'),
  minimapViewport: $('minimapViewport'), minimapWindowVisual: $('minimapWindowVisual'),
  minimapLeftHandle: $('minimapLeftHandle'), minimapRightHandle: $('minimapRightHandle'),
  tlStart: $('tlStart'), tlEnd: $('tlEnd'),
  fftCol: $('fftCol'), fftHeader: $('fftHeader'), fftCanvas: $('fftCanvas'),
  fftChBar: $('fftChBar'), fftHandle: $('fftHandle'), fftClose: $('fftClose'),
  sidebar: $('sidebar'), sidebarToggle: $('sidebarToggle'),
  mainArea: $('mainArea'),
  modalBackdrop: $('modalBackdrop'), modalSrInput: $('modalSrInput'),
  modalSkip: $('modalSkip'), modalSelect: $('modalSelect'),
};

const mainCtx = el.mainCanvas.getContext('2d');
const fftCtx  = el.fftCanvas.getContext('2d');

// Scale and window limits
/*
Vertical scale uses tenths through 1 and whole numbers through 10.
DEFAULT_WIN_MIN is used when no sample rate is entered.
*/
const VERTICAL_SCALE_VALUES = Object.freeze([
  0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00,
  2.00, 3.00, 4.00, 5.00, 6.00, 7.00, 8.00, 9.00, 10.00,
]);
/*
Static views draw up to 20,000 samples.
Navigation uses a limited preview for speed.
*/
const DEFAULT_WIN_MIN = 125, WIN_MAX = 20000, RAW_DRAW_MAX = WIN_MAX;
const INTERACTIVE_RAW_MAX = 4096, FFT_MAX_SAMPLES = 32768;
const coarsePointerQuery = window.matchMedia('(any-pointer: coarse)');

// Helpers
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt   = (v, d=3) => Number.isFinite(v) ? v.toFixed(d) : '-';
const fmtN  = v => Number.isFinite(v) ? Math.round(v).toLocaleString() : '0';
const fmtLbl = v => { if (!Number.isFinite(v)) return '-'; if (v === 0) return '0'; return v.toPrecision(3); };
const visualStyleCache = new Map();
let cachedRootRemPixels = 0;
function cssVar(name) {
  if (!visualStyleCache.has(name)) {
    visualStyleCache.set(
      name,
      getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    );
  }
  return visualStyleCache.get(name);
}
function rootRemPixels() {
  if (!cachedRootRemPixels) {
    cachedRootRemPixels = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  }
  return cachedRootRemPixels;
}
function invalidateVisualStyleCache() {
  visualStyleCache.clear();
  cachedRootRemPixels = 0;
}
function cssRem(valueInPixels) { return `${valueInPixels / rootRemPixels()}rem`; }

/*
Canvas storage uses screen pixels.
Drawing uses CSS coordinates to keep text and lines sharp.
*/
const canvasMetrics = new WeakMap();
function canvasScale(ctx) {
  return canvasMetrics.get(ctx.canvas) || { x: 1, y: 1 };
}
function snapDeviceX(ctx, value) {
  const scale = canvasScale(ctx).x;
  return Math.round(value * scale) / scale;
}
function snapDeviceY(ctx, value) {
  const scale = canvasScale(ctx).y;
  return Math.round(value * scale) / scale;
}
function snapStrokeX(ctx, value, width = ctx.lineWidth) {
  const scale = canvasScale(ctx).x;
  const physicalWidth = width * scale;
  return (Math.round(value * scale - physicalWidth / 2) + physicalWidth / 2) / scale;
}
function snapStrokeY(ctx, value, width = ctx.lineWidth) {
  const scale = canvasScale(ctx).y;
  const physicalWidth = width * scale;
  return (Math.round(value * scale - physicalWidth / 2) + physicalWidth / 2) / scale;
}
function useCrispHairline(ctx) {
  const scale = canvasScale(ctx).x;
  ctx.lineWidth = Math.max(1, Math.round(scale)) / scale;
}


// Keep every horizontal view change within the data range
function minHorizontalWindow() {
  const oneSecondWindow = Number.isFinite(S.sampleRate) && S.sampleRate > 0
    ? Math.round(S.sampleRate)
    : DEFAULT_WIN_MIN;
  return Math.min(maxHorizontalWindow(), Math.max(1, oneSecondWindow));
}
function maxHorizontalWindow() {
  return Math.min(WIN_MAX, Math.max(1, S.rowCount));
}
function setHorizontalView(start, windowSize) {
  const previousStart = S.start;
  const previousWindow = S.window;
  const total = S.rowCount;
  if (!total) {
    S.start = 0;
    S.window = 1000;
    return S.start !== previousStart || S.window !== previousWindow;
  }
  S.window = clamp(Math.round(windowSize), minHorizontalWindow(), maxHorizontalWindow());
  S.start = clamp(Math.round(start), 0, Math.max(0, total - S.window));
  return S.start !== previousStart || S.window !== previousWindow;
}

let minimapDirty = true;
function invalidateMinimap() { minimapDirty = true; }


// Theme
function setThemeIcon() {
  const dark = document.documentElement.dataset.theme === 'dark';
  el.chordsLogo.src = dark ? 'ChordsWhite.svg' : 'ChordsBlack.svg';
  el.themeBtn.innerHTML = dark
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
}

el.themeBtn.addEventListener('click', () => {
  const d = document.documentElement;
  d.dataset.theme = d.dataset.theme === 'dark' ? 'light' : 'dark';
  invalidateVisualStyleCache();
  setThemeIcon();
  buildChannelList(); // Refresh channel colors
  invalidateMinimap();
  renderAll();
});

setThemeIcon();


// CSV loading with a Blob worker for local files
function csvParserWorkerMain() {
  'use strict';

  const TEXT_CHUNK_BYTES = 4 * 1024 * 1024;
  const PROGRESS_INTERVAL_MS = 120;

  function splitCSVRecord(record) {
    const out = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < record.length; i++) {
      const char = record[i];
      if (char === '"') {
        if (quoted && record[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (char === ',' && !quoted) {
        out.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    out.push(current);
    return out;
  }

  async function forEachRecord(file, onRecord, onProgress) {
    const decoder = new TextDecoder();
    let offset = 0;
    let remainder = '';
    let lastProgressAt = 0;

    while (offset < file.size) {
      const end = Math.min(file.size, offset + TEXT_CHUNK_BYTES);
      const bytes = await file.slice(offset, end).arrayBuffer();
      const text = decoder.decode(bytes, { stream: end < file.size });
      const block = remainder + text;
      let lineStart = 0;
      let newline;

      while ((newline = block.indexOf('\n', lineStart)) !== -1) {
        let record = block.slice(lineStart, newline);
        if (record.endsWith('\r')) record = record.slice(0, -1);
        if (record.trim()) onRecord(record);
        lineStart = newline + 1;
      }
      remainder = block.slice(lineStart);
      offset = end;

      const now = performance.now();
      if (now - lastProgressAt >= PROGRESS_INTERVAL_MS || offset === file.size) {
        onProgress(offset / Math.max(1, file.size));
        lastProgressAt = now;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    remainder += decoder.decode();
    if (remainder.trim()) onRecord(remainder.replace(/\r$/, ''));
  }

  async function inspectFile(file) {
    let headers = null;
    let rowCount = 0;
    const sample = [];

    await forEachRecord(file, record => {
      if (!headers) {
        headers = splitCSVRecord(record.replace(/^\uFEFF/, ''))
          .map((header, index) => header.trim() || `Col${index + 1}`);
        return;
      }
      rowCount++;
      if (sample.length < 120) sample.push(splitCSVRecord(record));
    }, ratio => postMessage({ type: 'progress', progress: ratio * 0.15 }));

    if (!headers) throw new Error('Empty file.');
    if (!rowCount) throw new Error('The CSV does not contain any data rows.');

    const numericIdx = headers.map((_, index) => index).filter(index => {
      let present = 0;
      let numeric = 0;
      for (const row of sample) {
        const raw = (row[index] || '').trim();
        if (!raw) continue;
        present++;
        if (Number.isFinite(Number(raw))) numeric++;
      }
      return present === 0 ? true : numeric / present >= 0.8;
    });

    if (!numericIdx.length) throw new Error('No numeric columns were found.');
    return { headers, numericIdx, rowCount };
  }

  async function parseColumns(file, metadata, overviewBinLimit) {
    const { headers, numericIdx, rowCount } = metadata;
    const columns = new Map();
    const ranges = {};
    const overview = new Map();
    const binCount = Math.min(overviewBinLimit, rowCount);

    for (const columnIndex of numericIdx) {
      columns.set(columnIndex, new Float32Array(rowCount));
      ranges[columnIndex] = { lo: Infinity, hi: -Infinity };
      const min = new Float32Array(binCount);
      const max = new Float32Array(binCount);
      min.fill(Infinity);
      max.fill(-Infinity);
      overview.set(columnIndex, { min, max });
    }

    let skippedHeader = false;
    let rowIndex = 0;
    await forEachRecord(file, record => {
      if (!skippedHeader) {
        skippedHeader = true;
        return;
      }
      if (rowIndex >= rowCount) return;
      const cells = splitCSVRecord(record);
      const bin = Math.min(binCount - 1, Math.floor((rowIndex / rowCount) * binCount));

      for (const columnIndex of numericIdx) {
        const parsed = Number((cells[columnIndex] || '').trim());
        const value = Number.isFinite(parsed) ? parsed : NaN;
        columns.get(columnIndex)[rowIndex] = value;
        if (!Number.isFinite(value)) continue;

        const range = ranges[columnIndex];
        if (value < range.lo) range.lo = value;
        if (value > range.hi) range.hi = value;
        const bins = overview.get(columnIndex);
        if (value < bins.min[bin]) bins.min[bin] = value;
        if (value > bins.max[bin]) bins.max[bin] = value;
      }
      rowIndex++;
    }, ratio => postMessage({ type: 'progress', progress: 0.15 + ratio * 0.65 }));

    for (const columnIndex of numericIdx) {
      const range = ranges[columnIndex];
      if (!Number.isFinite(range.lo) || !Number.isFinite(range.hi) || range.lo === range.hi) {
        range.lo = -1;
        range.hi = 1;
      }
    }

    return { headers, numericIdx, rowCount, columns, ranges, overview, binCount };
  }

  function buildLodLevels(parsed, factor) {
    const lod = new Map();
    const channelCount = parsed.numericIdx.length;

    parsed.numericIdx.forEach((columnIndex, channelPosition) => {
      const levels = [];
      let previousMin = parsed.columns.get(columnIndex);
      let previousMax = previousMin;
      let bucketSize = 1;

      while (previousMin.length > 2048) {
        const nextLength = Math.ceil(previousMin.length / factor);
        const nextMin = new Float32Array(nextLength);
        const nextMax = new Float32Array(nextLength);

        for (let bucket = 0; bucket < nextLength; bucket++) {
          const start = bucket * factor;
          const end = Math.min(previousMin.length, start + factor);
          let min = Infinity;
          let max = -Infinity;
          for (let index = start; index < end; index++) {
            const low = previousMin[index];
            const high = previousMax[index];
            if (Number.isFinite(low) && low < min) min = low;
            if (Number.isFinite(high) && high > max) max = high;
          }
          nextMin[bucket] = min === Infinity ? NaN : min;
          nextMax[bucket] = max === -Infinity ? NaN : max;
        }

        bucketSize *= factor;
        levels.push({ bucketSize, min: nextMin, max: nextMax });
        previousMin = nextMin;
        previousMax = nextMax;
      }
      lod.set(columnIndex, levels);
      postMessage({
        type: 'progress',
        progress: 0.8 + ((channelPosition + 1) / channelCount) * 0.2,
      });
    });

    return lod;
  }

  self.onmessage = async event => {
    const { file, overviewBins = 2048, lodFactor = 8 } = event.data || {};
    try {
      if (!(file instanceof Blob)) throw new Error('No CSV file was provided.');
      const metadata = await inspectFile(file);
      const parsed = await parseColumns(file, metadata, overviewBins);
      const lod = buildLodLevels(parsed, lodFactor);

      const columns = [];
      const overview = [];
      const lodPayload = [];
      const transfer = [];

      for (const columnIndex of parsed.numericIdx) {
        const column = parsed.columns.get(columnIndex);
        const overviewBinsForColumn = parsed.overview.get(columnIndex);
        const levels = lod.get(columnIndex) || [];
        columns.push({ columnIndex, buffer: column.buffer });
        overview.push({
          columnIndex,
          minBuffer: overviewBinsForColumn.min.buffer,
          maxBuffer: overviewBinsForColumn.max.buffer,
        });
        lodPayload.push({
          columnIndex,
          levels: levels.map(level => ({
            bucketSize: level.bucketSize,
            minBuffer: level.min.buffer,
            maxBuffer: level.max.buffer,
          })),
        });
        transfer.push(column.buffer, overviewBinsForColumn.min.buffer, overviewBinsForColumn.max.buffer);
        for (const level of levels) transfer.push(level.min.buffer, level.max.buffer);
      }

      postMessage({
        type: 'complete',
        headers: parsed.headers,
        numericIdx: parsed.numericIdx,
        rowCount: parsed.rowCount,
        ranges: parsed.ranges,
        overviewBinCount: parsed.binCount,
        columns,
        overview,
        lod: lodPayload,
      }, transfer);
    } catch (error) {
      postMessage({ type: 'error', message: error?.message || 'Could not parse the CSV.' });
    }
  };

}

// File loading
let pendingParsed = null; // Parsed CSV waiting for sample rate
let parseWorker = null;

function setParsingState(active, progress = 0, fileName = '') {
  const percent = Math.round(clamp(progress, 0, 1) * 100);
  el.uploadBtn.disabled = active;
  el.emptyUploadBtn.disabled = active;
  el.canvasWrap.setAttribute('aria-busy', String(active));
  el.uploadText.textContent = active ? `${percent}%` : 'Upload CSV';
  if (!S.rowCount) {
    el.emptyTitle.textContent = active ? 'Loading recording' : 'No data loaded';
    el.emptyMessage.textContent = active
      ? `${fileName || 'CSV'} · ${percent}%`
      : 'Drop a CSV here or choose a file';
  }
}

function parseCSVInWorker(file) {
  return new Promise((resolve, reject) => {
    const workerSource = `(${csvParserWorkerMain.toString()})();`;
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    let worker;
    try {
      worker = new Worker(workerUrl);
    } catch (error) {
      URL.revokeObjectURL(workerUrl);
      reject(error);
      return;
    }
    parseWorker = worker;

    function finish() {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      if (parseWorker === worker) parseWorker = null;
    }

    worker.onmessage = event => {
      const message = event.data || {};
      if (message.type === 'progress') {
        setParsingState(true, message.progress, file.name);
        return;
      }
      if (message.type === 'error') {
        finish();
        reject(new Error(message.message || 'Could not parse CSV.'));
        return;
      }
      if (message.type !== 'complete') return;

      const columns = {};
      const overview = {};
      const lod = {};
      for (const item of message.columns) {
        columns[item.columnIndex] = new Float32Array(item.buffer);
      }
      for (const item of message.overview) {
        overview[item.columnIndex] = {
          min: new Float32Array(item.minBuffer),
          max: new Float32Array(item.maxBuffer),
        };
      }
      for (const item of message.lod) {
        lod[item.columnIndex] = item.levels.map(level => ({
          bucketSize: level.bucketSize,
          min: new Float32Array(level.minBuffer),
          max: new Float32Array(level.maxBuffer),
        }));
      }
      finish();
      resolve({
        headers: message.headers,
        numericIdx: message.numericIdx,
        rowCount: message.rowCount,
        ranges: message.ranges,
        columns,
        overview,
        lod,
      });
    };
    worker.onerror = event => {
      finish();
      reject(new Error(event.message || 'The CSV parser stopped unexpectedly.'));
    };
    worker.postMessage({ file, overviewBins: 2048, lodFactor: 8 });
  });
}

async function handleFile(file) {
  if (parseWorker) return;
  setParsingState(true, 0, file.name);
  try {
    pendingParsed = await parseCSVInWorker(file);
  } catch (error) {
    alert(error.message || 'Could not parse CSV.');
    return;
  } finally {
    setParsingState(false);
  }
  S.fileName = file.name;
  el.modalSrInput.value = '';
  el.modalBackdrop.classList.add('visible');
  setTimeout(() => el.modalSrInput.focus(), 60);
}

/*
Save the parsed CSV and optional sample rate.
Then refresh the related controls.
*/
function commitLoad(sr) {
  if (!pendingParsed) return;
  const { headers, numericIdx, rowCount, columns, overview, lod, ranges } = pendingParsed;
  pendingParsed = null;
  S.headers = headers; S.numericIdx = numericIdx; S.rowCount = rowCount;
  S.columns = columns; S.overview = overview; S.lod = lod; S.channelRanges = ranges;
  S.sampleRate = (sr > 0) ? sr : null;
  setHorizontalView(0, Math.min(1000, Math.max(1, rowCount))); S.scale = 1;
  S.selected.clear();
  S.fftChannels.clear();
  // Select up to eight likely signal columns
  const preferred = numericIdx.filter(i => /ch|lead|bio|adc|signal/i.test(headers[i]));
 (preferred.length ? preferred : numericIdx).slice(0, 8).forEach(i => {
    S.selected.add(i);
    S.fftChannels.add(i);
  });
  syncVerticalScaleControl();
  buildChannelList(); invalidateMinimap(); renderAll();
  el.srInput.value = S.sampleRate || '';
  el.fileNameDisplay.textContent = S.fileName || '';
  el.fileNameDisplay.title = S.fileName || '';
  el.fileBadge.style.display = S.fileName ? 'flex' : 'none';
  el.fileBadgeRow.classList.toggle('has-file', Boolean(S.fileName));
  el.emptyState.style.display = 'none';
  el.helpBtn.disabled = false;
  el.helpBtn.setAttribute('aria-label', 'Show tour');
  el.helpBtn.title = 'Show guide';
  document.dispatchEvent(new CustomEvent('csvplotter:data-loaded'));
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
el.emptyUploadBtn.addEventListener('click', () => el.csvInput.click());

// Empty-state file drop
let emptyDragDepth = 0;
function dragContainsFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files') || Boolean(event.dataTransfer?.files?.length);
}
function clearEmptyDragState() {
  emptyDragDepth = 0;
  el.canvasWrap.classList.remove('drag-active');
}

el.canvasWrap.addEventListener('dragenter', event => {
  if (!dragContainsFiles(event)) return;
  event.preventDefault();
  if (S.rowCount) return;
  emptyDragDepth++;
  el.canvasWrap.classList.add('drag-active');
});
el.canvasWrap.addEventListener('dragover', event => {
  if (!dragContainsFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = S.rowCount ? 'none' : 'copy';
});
el.canvasWrap.addEventListener('dragleave', () => {
  if (!emptyDragDepth) return;
  emptyDragDepth--;
  if (!emptyDragDepth) el.canvasWrap.classList.remove('drag-active');
});
el.canvasWrap.addEventListener('drop', event => {
  if (!dragContainsFiles(event)) return;
  event.preventDefault();
  clearEmptyDragState();
  if (S.rowCount) return;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.csv')) {
    alert('Please drop a CSV file.');
    return;
  }
  handleFile(file);
});
document.addEventListener('dragend', clearEmptyDragState);


// The worker calculates channel ranges and overview buckets once

// Sidebar channel list
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
    cb.style.accentColor = trackColor(idx); // Match the checkbox to its channel
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

// FFT channel selector
function buildFftChannelList() {
  el.fftChBar.innerHTML = '';
  const visibleChannels = S.numericIdx
    .map((ci, idx) => ({ ci, idx }))
    .filter(({ ci }) => S.selected.has(ci));

  if (!visibleChannels.length) {
    el.fftChBar.innerHTML = '<span style="font-size:.625rem;color:var(--faint);padding:.1rem 0">No channels selected</span>';
    return;
  }

  // Keep one FFT channel selected
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


// Controls: vertical scale
function closestVerticalScaleIndex(value) {
  let closestIndex = 0;
  let closestDistance = Infinity;
  VERTICAL_SCALE_VALUES.forEach((candidate, index) => {
    const distance = Math.abs(candidate - value);
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  });
  return closestIndex;
}

function syncVerticalScaleControl() {
  const scaleIndex = closestVerticalScaleIndex(S.scale);
  S.scale = VERTICAL_SCALE_VALUES[scaleIndex];
  el.scaleValue.textContent = `${S.scale.toFixed(2)}×`;
  el.scaleMinusBtn.disabled = scaleIndex === 0;
  el.scalePlusBtn.disabled = scaleIndex === VERTICAL_SCALE_VALUES.length - 1;
}

function setVerticalScale(nextScale) {
  S.scale = VERTICAL_SCALE_VALUES[closestVerticalScaleIndex(nextScale)];
  syncVerticalScaleControl();
  renderAll();
}

function stepVerticalScale(direction) {
  const currentIndex = closestVerticalScaleIndex(S.scale);
  const nextIndex = clamp(currentIndex + direction, 0, VERTICAL_SCALE_VALUES.length - 1);
  if (nextIndex !== currentIndex) setVerticalScale(VERTICAL_SCALE_VALUES[nextIndex]);
}

// Sample rate
el.srInput.addEventListener('input', () => {
  const n = parseFloat(el.srInput.value);
  S.sampleRate = n > 0 ? n : null;
  if (S.rowCount) setHorizontalView(S.start, S.window);
  renderAll();
});

// Channel sidebar toggle
el.sidebarToggle.addEventListener('click', () => {
  const expanded = el.sidebar.classList.toggle('expanded');
  el.sidebarToggle.setAttribute('aria-expanded', String(expanded));
  const label = expanded ? 'Collapse channels' : 'Expand channels';
  el.sidebarToggle.setAttribute('aria-label', label);
  el.sidebarToggle.title = label;
  renderAll();
});

// File close and reset
el.fileCloseBtn.addEventListener('click', () => {
  S.headers = []; S.numericIdx = []; S.columns = {}; S.rowCount = 0;
  S.overview = {}; S.lod = {};
  S.selected = new Set(); S.fftChannels = new Set();
  S.channelRanges = {}; S.sampleRate = null;
  S.start = 0; S.window = 1000; S.scale = 1;
  S.fftOpen = false; S.fileName = '';
  el.srInput.value = '';
  el.csvInput.value = '';
  el.fileBadge.style.display = 'none';
  el.fileBadgeRow.classList.remove('has-file');
  el.helpBtn.disabled = true;
  el.helpBtn.setAttribute('aria-label', 'Upload a CSV to view the guide');
  el.helpBtn.title = 'Upload a CSV to view the guide';
  el.fftCol.classList.remove('open');
  el.fftHandle.style.display = 'none';
  el.fftBtn.classList.remove('active');
  el.fftBtn.setAttribute('aria-pressed', 'false');
  el.fftCol.style.width = '';
  invalidateMinimap();
  syncVerticalScaleControl();
  buildChannelList(); renderAll();
  document.dispatchEvent(new CustomEvent('csvplotter:data-cleared'));
});

// Action buttons
el.scaleMinusBtn.addEventListener('click', () => stepVerticalScale(-1));
el.scalePlusBtn.addEventListener('click', () => stepVerticalScale(1));
el.fftBtn.addEventListener('click',   () => {
  S.fftOpen = !S.fftOpen;
  el.fftCol.classList.toggle('open', S.fftOpen);
  el.fftHandle.style.display = S.fftOpen ? '' : 'none';
  el.fftBtn.classList.toggle('active', S.fftOpen);
  el.fftBtn.setAttribute('aria-pressed', String(S.fftOpen));
  if (!S.fftOpen) el.fftCol.style.width = '';
  setTimeout(renderAll, 50);
});
el.fftClose.addEventListener('click', () => {
  S.fftOpen = false;
  el.fftCol.classList.remove('open');
  el.fftHandle.style.display = 'none';
  el.fftBtn.classList.remove('active');
  el.fftBtn.setAttribute('aria-pressed', 'false');
  el.fftCol.style.width = '';
  setTimeout(renderAll, 50);
});


// Wheel and trackpad controls
el.canvasWrap.addEventListener('wheel', e => {
  if (!S.rowCount) return;

  // Pinch to zoom around the view center
  if (e.ctrlKey) {
    e.preventDefault();
    const oldW = S.window;
    const factor = Math.pow(1.003, e.deltaY);
    const center = S.start + oldW / 2;
    if (setHorizontalView(center - oldW * factor / 2, oldW * factor)) {
      renderWheelInteraction();
    }
    return;
  }

  const canScrollV = el.canvasScroll.scrollHeight > el.canvasScroll.clientHeight + 2;
  const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  const wrapW = el.canvasWrap.getBoundingClientRect().width || 600;

  if (isHorizontal) {
    e.preventDefault();
    const step = Math.max(1, Math.round(Math.abs(e.deltaX) * S.window / wrapW));
    if (setHorizontalView(S.start + (e.deltaX > 0 ? step : -step), S.window)) {
      renderWheelInteraction();
    }
    return;
  }

  // Use normal vertical scroll when the canvas is taller
  if (canScrollV) return;

  e.preventDefault();
  const step = Math.max(1, Math.round(Math.abs(e.deltaY) * S.window / wrapW));
  if (setHorizontalView(S.start + (e.deltaY > 0 ? step : -step), S.window)) {
    renderWheelInteraction();
  }
}, { passive: false });

// Keyboard navigation
window.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select') || e.target.isContentEditable) return;
  const W = Math.max(1, Math.floor(S.window * 0.1));
  if (e.key === 'ArrowLeft') {
    if (setHorizontalView(S.start - W, S.window)) renderWheelInteraction();
    e.preventDefault();
  }
  if (e.key === 'ArrowRight') {
    if (setHorizontalView(S.start + W, S.window)) renderWheelInteraction();
    e.preventDefault();
  }
});

// FFT panel resize
/*
The handle is on the left edge.
Dragging left makes the panel wider.
*/
(function initFftResize() {
  let dragging = false, startX = 0, startW = 0;

  function fftMaxW() {
    const maW = el.mainArea.getBoundingClientRect().width;
    return Math.min(maW * 0.55, maW - 220);
  }
  function applyDx(clientX) {
    const dx = startX - clientX;
    const minFW = parseInt(getComputedStyle(el.fftCol).minWidth) || 180;
    el.fftCol.style.width = cssRem(clamp(startW + dx, minFW, fftMaxW()));
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


// Minimap
function sizeMinimapCanvas() {
  const rect = el.minimapTrack.getBoundingClientRect();
  const cssW = Math.max(1, rect.width);
  const cssH = Math.max(1, rect.height);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const pixelW = Math.max(1, Math.round(cssW * dpr));
  const pixelH = Math.max(1, Math.round(cssH * dpr));
  const changed = el.minimapCanvas.width !== pixelW || el.minimapCanvas.height !== pixelH;
  if (changed) {
    el.minimapCanvas.width = pixelW;
    el.minimapCanvas.height = pixelH;
  }
  const ctx = el.minimapCanvas.getContext('2d');
  const scaleX = pixelW / cssW, scaleY = pixelH / cssH;
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  canvasMetrics.set(el.minimapCanvas, { x: scaleX, y: scaleY });
  return { ctx, width: cssW, height: cssH, changed };
}

/*
Draw the full-file min and max envelope for up to four channels.
Panning and resizing reuse the cached canvas.
*/
function drawMinimap() {
  const sized = sizeMinimapCanvas();
  if (!minimapDirty && !sized.changed) return;

  const { ctx, width: W, height: H } = sized;
  ctx.clearRect(0, 0, W, H);
  minimapDirty = false;

  const total = S.rowCount;
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
    const bins = S.overview[ci];
    if (!bins?.min?.length) continue;
    const span = Math.max(1e-12, range.hi - range.lo);
    ctx.fillStyle = trackColor(idx);

    const displayColumns = Math.max(1, Math.ceil(W));
    for (let x = 0; x < displayColumns; x++) {
      const s0 = Math.floor((x / displayColumns) * bins.min.length);
      const s1 = Math.max(s0 + 1, Math.ceil(((x + 1) / displayColumns) * bins.min.length));
      let mn = Infinity, mx = -Infinity;
      for (let bin = s0; bin < Math.min(bins.min.length, s1); bin++) {
        const low = bins.min[bin];
        const high = bins.max[bin];
        if (Number.isFinite(low) && low < mn) mn = low;
        if (Number.isFinite(high) && high > mx) mx = high;
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

function minimapCompressedScale(trackWidth) {
  const minimumWidth = Math.min(trackWidth, rootRemPixels() * 4.5);
  const largestCompressedWidth = Math.max(
    minimumWidth,
    Math.min(trackWidth * 0.28, rootRemPixels() * 12),
  );
  return { minimumWidth, largestCompressedWidth };
}

function usesCompressedMinimap(total, trackWidth) {
  const { minimumWidth } = minimapCompressedScale(trackWidth);
  const largestExactWidth = Math.min(
    trackWidth,
    (maxHorizontalWindow() / total) * trackWidth,
  );
  return largestExactWidth < minimumWidth;
}

function minimapDisplayWidth(total, trackWidth, windowSize) {
  const exactWidth = Math.min(trackWidth, (windowSize / total) * trackWidth);
  const { minimumWidth, largestCompressedWidth } = minimapCompressedScale(trackWidth);
  if (!usesCompressedMinimap(total, trackWidth) || windowSize >= total) return exactWidth;

  /*
  Long files can make the proportional window too small.
  A logarithmic size keeps every zoom level usable.
  */
  const smallestWindow = minHorizontalWindow();
  const largestWindow = maxHorizontalWindow();
  const logSpan = Math.log(Math.max(1, largestWindow / smallestWindow));
  const progress = logSpan > 0
    ? Math.log(Math.max(1, windowSize / smallestWindow)) / logSpan
    : 1;
  const compressedWidth = minimumWidth
    + clamp(progress, 0, 1) * (largestCompressedWidth - minimumWidth);
  return Math.max(exactWidth, compressedWidth);
}

function minimapGeometry(total, trackWidth, start, windowSize) {
  const displayWidth = minimapDisplayWidth(total, trackWidth, windowSize);
  const scrollRange = Math.max(0, total - windowSize);
  const scrollProgress = scrollRange > 0 ? clamp(start / scrollRange, 0, 1) : 0;
  const displayLeft = scrollProgress * Math.max(0, trackWidth - displayWidth);
  const minimumPinGap = Math.min(
    trackWidth,
    rootRemPixels() * 1.375,
  );
  let pinLeft = displayLeft;
  let pinRight = displayLeft + displayWidth;
  if (displayWidth < minimumPinGap) {
    const center = displayLeft + displayWidth / 2;
    pinLeft = center - minimumPinGap / 2;
    pinRight = center + minimumPinGap / 2;
    if (pinLeft < 0) {
      pinRight -= pinLeft;
      pinLeft = 0;
    }
    if (pinRight > trackWidth) {
      pinLeft -= pinRight - trackWidth;
      pinRight = trackWidth;
    }
  }
  const minimumPanWidth = Math.min(
    trackWidth,
    rootRemPixels() * (coarsePointerQuery.matches ? 4.5 : 3),
  );
  const panWidth = Math.max(displayWidth, minimumPanWidth);
  const panLeft = clamp(
    displayLeft - (panWidth - displayWidth) / 2,
    0,
    Math.max(0, trackWidth - panWidth),
  );
  return {
    compressed: usesCompressedMinimap(total, trackWidth),
    displayWidth,
    displayLeft,
    handleLeft: displayLeft,
    handleRight: displayLeft + displayWidth,
    pinLeft,
    pinRight,
    panLeft,
    panWidth,
  };
}

function updateMinimapViewport() {
  const total = S.rowCount;
  const hasData = total > 0;
  el.minimapWrap.classList.toggle('disabled', !hasData);
  el.minimapWrap.setAttribute('aria-disabled', String(!hasData));

  if (!hasData) {
    el.tlStart.textContent = '0';
    el.tlEnd.textContent = '0';
    el.minimapViewport.style.display = 'none';
    el.minimapTrack.removeAttribute('title');
    return;
  }

  setHorizontalView(S.start, S.window);
  el.minimapViewport.style.display = '';
  el.tlStart.textContent = formatTimelinePosition(0);
  el.tlEnd.textContent = formatTimelinePosition(Math.max(0, total - 1));

  const trackW = Math.max(1, el.minimapTrack.clientWidth);
  const geometry = minimapGeometry(total, trackW, S.start, S.window);

  el.minimapViewport.style.left = `${(geometry.displayLeft / trackW) * 100}%`;
  el.minimapViewport.style.width = `${(geometry.displayWidth / trackW) * 100}%`;
  el.minimapWindowVisual.style.setProperty(
    '--minimap-left-pin-offset',
    cssRem(geometry.pinLeft - geometry.displayLeft),
  );
  el.minimapWindowVisual.style.setProperty(
    '--minimap-right-pin-offset',
    cssRem(geometry.pinRight - geometry.handleRight),
  );
  el.minimapViewport.classList.toggle('narrow', geometry.displayWidth < rootRemPixels() * 2.75);

  const end = Math.min(total, S.start + S.window);
  const rangeText = `${formatTimelinePosition(S.start)} – ${formatTimelinePosition(Math.max(S.start, end - 1))}`;
  const interactionTitle = `${rangeText} · ${fmtN(S.window)} samples · Drag to move; corner circles resize`;
  el.minimapViewport.title = interactionTitle;
  el.minimapTrack.title = interactionTitle;
  el.minimapViewport.setAttribute('aria-valuemax', String(Math.max(0, total - S.window)));
  el.minimapViewport.setAttribute('aria-valuenow', String(S.start));
  el.minimapViewport.setAttribute('aria-valuetext', `${rangeText}; ${fmtN(S.window)} samples visible`);
}

(function initMinimapControls() {
  let drag = null;

  function buildCompressedEdgeLookup(mode, dragState, total) {
    const fixedEnd = dragState.startStart + dragState.startWindow;
    const minimumWindow = minHorizontalWindow();
    const maximumWindow = mode === 'left'
      ? Math.min(maxHorizontalWindow(), fixedEnd)
      : Math.min(maxHorizontalWindow(), total - dragState.startStart);
    const steps = 256;
    const ratio = Math.max(1, maximumWindow / minimumWindow);
    const points = [];

    for (let step = 0; step <= steps; step++) {
      const progress = step / steps;
      const windowSize = step === steps
        ? maximumWindow
        : minimumWindow * Math.pow(ratio, progress);
      const start = mode === 'left' ? fixedEnd - windowSize : dragState.startStart;
      const geometry = minimapGeometry(total, dragState.rect.width, start, windowSize);
      points.push({
        edge: mode === 'left' ? geometry.pinLeft : geometry.pinRight,
        window: windowSize,
      });
    }

    return {
      points,
      increasing: points[points.length - 1].edge >= points[0].edge,
    };
  }

  function compressedWindowForEdge(targetEdge, lookup) {
    const { points, increasing } = lookup;
    const edgeKey = point => increasing ? point.edge : -point.edge;
    const targetKey = increasing ? targetEdge : -targetEdge;
    const lastIndex = points.length - 1;

    if (targetKey <= edgeKey(points[0])) return Math.round(points[0].window);
    if (targetKey >= edgeKey(points[lastIndex])) return Math.round(points[lastIndex].window);

    let low = 0;
    let high = lastIndex;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (edgeKey(points[middle]) < targetKey) low = middle;
      else high = middle;
    }

    const lowKey = edgeKey(points[low]);
    const highKey = edgeKey(points[high]);
    const progress = highKey > lowKey
      ? clamp((targetKey - lowKey) / (highKey - lowKey), 0, 1)
      : 0;
    return Math.round(points[low].window + progress * (points[high].window - points[low].window));
  }

  function interactionMode(event, rect) {
    const geometry = minimapGeometry(S.rowCount, rect.width, S.start, S.window);
    const pointerX = event.clientX - rect.left;
    if (pointerX >= geometry.panLeft && pointerX <= geometry.panLeft + geometry.panWidth) {
      return 'pan';
    }
    return 'jump';
  }

  function pinMode(event, rect) {
    const geometry = minimapGeometry(S.rowCount, rect.width, S.start, S.window);
    const pointerX = event.clientX - rect.left;
    return Math.abs(pointerX - geometry.pinLeft) <= Math.abs(pointerX - geometry.pinRight)
      ? 'left'
      : 'right';
  }

  function beginDrag(mode, e, owner) {
    if (!S.rowCount || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    el.minimapViewport.focus({ preventScroll: true });
    const rect = el.minimapTrack.getBoundingClientRect();
    if (rect.width <= 0) return;
    const geometry = minimapGeometry(S.rowCount, rect.width, S.start, S.window);
    try { owner.setPointerCapture(e.pointerId); } catch (_) {}
    drag = {
      mode,
      pointerId: e.pointerId,
      startX: e.clientX,
      startStart: S.start,
      startWindow: S.window,
      rect,
      owner,
      startDisplayLeft: geometry.pinLeft,
      startDisplayRight: geometry.pinRight,
      startDisplayWidth: geometry.displayWidth,
      compressedSizing: geometry.compressed,
    };
    if (drag.compressedSizing && mode !== 'pan') {
      drag.edgeLookup = buildCompressedEdgeLookup(mode, drag, S.rowCount);
    }
    clearTimeout(wheelSettleTimer);
    el.minimapTrack.style.cursor = mode === 'pan' ? 'grabbing' : 'ew-resize';
    el.minimapWrap.classList.add('is-dragging');
    el.minimapWrap.classList.toggle('is-resizing-left', mode === 'left');
    el.minimapWrap.classList.toggle('is-resizing-right', mode === 'right');
    document.body.style.userSelect = 'none';
  }

  function moveDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId || !S.rowCount) return;
    e.preventDefault();
    const total = S.rowCount;
    const pointerDelta = e.clientX - drag.startX;
    const deltaSamples = Math.round((pointerDelta / drag.rect.width) * total);
    let changed = false;

    if (drag.mode === 'pan') {
      const pixelTravel = Math.max(1, drag.rect.width - drag.startDisplayWidth);
      const sampleTravel = Math.max(0, total - drag.startWindow);
      const panDelta = Math.round((pointerDelta / pixelTravel) * sampleTravel);
      changed = setHorizontalView(drag.startStart + panDelta, drag.startWindow);
    } else if (drag.mode === 'left') {
      const fixedEnd = drag.startStart + drag.startWindow;
      if (drag.compressedSizing) {
        const newWindow = compressedWindowForEdge(
          drag.startDisplayLeft + pointerDelta,
          drag.edgeLookup,
        );
        changed = setHorizontalView(fixedEnd - newWindow, newWindow);
        if (changed) renderInteractive();
        return;
      }
      const newStart = clamp(
        drag.startStart + deltaSamples,
        Math.max(0, fixedEnd - maxHorizontalWindow()),
        fixedEnd - minHorizontalWindow(),
      );
      changed = setHorizontalView(newStart, fixedEnd - newStart);
    } else if (drag.mode === 'right') {
      const maxWindowFromStart = Math.min(maxHorizontalWindow(), total - drag.startStart);
      if (drag.compressedSizing) {
        const newWindow = compressedWindowForEdge(
          drag.startDisplayRight + pointerDelta,
          drag.edgeLookup,
        );
        changed = setHorizontalView(drag.startStart, newWindow);
        if (changed) renderInteractive();
        return;
      }
      const newWindow = clamp(drag.startWindow + deltaSamples, minHorizontalWindow(), maxWindowFromStart);
      changed = setHorizontalView(drag.startStart, newWindow);
    }
    if (changed) renderInteractive();
  }

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
    try { drag.owner.releasePointerCapture(drag.pointerId); } catch (_) {}
    drag = null;
    el.minimapWrap.classList.remove('is-dragging');
    el.minimapWrap.classList.remove('is-resizing-left', 'is-resizing-right');
    el.minimapTrack.style.cursor = '';
    document.body.style.userSelect = '';
    finishInteractiveRendering();
  }

  el.minimapTrack.addEventListener('pointerdown', e => {
    if (!S.rowCount) return;
    const rect = el.minimapTrack.getBoundingClientRect();
    if (rect.width <= 0) return;
    const mode = interactionMode(e, rect);
    if (mode !== 'jump') {
      beginDrag(mode, e, el.minimapTrack);
      return;
    }

    // Click outside the window to move and start dragging
    const displayWidth = minimapDisplayWidth(S.rowCount, rect.width, S.window);
    const viewportTravel = Math.max(1, rect.width - displayWidth);
    const targetLeft = e.clientX - rect.left - displayWidth / 2;
    const progress = clamp(targetLeft / viewportTravel, 0, 1);
    const changed = setHorizontalView(progress * (S.rowCount - S.window), S.window);
    beginDrag('pan', e, el.minimapTrack);
    if (drag) {
      drag.startStart = S.start;
      drag.startWindow = S.window;
    }
    if (changed) renderInteractive();
  });

  function beginPinDrag(e) {
    const rect = el.minimapTrack.getBoundingClientRect();
    beginDrag(pinMode(e, rect), e, e.currentTarget);
  }
  el.minimapLeftHandle.addEventListener('pointerdown', beginPinDrag);
  el.minimapRightHandle.addEventListener('pointerdown', beginPinDrag);

  el.minimapTrack.addEventListener('pointermove', e => {
    if (drag || !S.rowCount) return;
    const rect = el.minimapTrack.getBoundingClientRect();
    const mode = interactionMode(e, rect);
    el.minimapTrack.style.cursor = mode === 'pan' ? 'grab' : 'pointer';
  });
  el.minimapTrack.addEventListener('pointerleave', () => {
    if (drag) return;
    el.minimapTrack.style.cursor = '';
  });

  document.addEventListener('pointermove', moveDrag, { passive: false });
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', () => endDrag());

  // Minimap keyboard navigation
  el.minimapViewport.addEventListener('keydown', e => {
    if (!S.rowCount) return;
    const step = Math.max(1, Math.round(S.window * (e.shiftKey ? 0.25 : 0.05)));
    if (e.key === 'ArrowLeft') setHorizontalView(S.start - step, S.window);
    else if (e.key === 'ArrowRight') setHorizontalView(S.start + step, S.window);
    else if (e.key === 'Home') setHorizontalView(0, S.window);
    else if (e.key === 'End') setHorizontalView(S.rowCount - S.window, S.window);
    else return;
    e.preventDefault();
    e.stopPropagation();
    renderWheelInteraction();
  });
})();


// Main plot: canvas sizing
function sizeCanvas(canvas, w, h) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const pw = Math.max(10, Math.round(w * dpr));
  const ph = Math.max(10, Math.round(h * dpr));
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const ctx = canvas.getContext('2d');
  const scaleX = pw / w, scaleY = ph / h;
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  canvasMetrics.set(canvas, { x: scaleX, y: scaleY });
  return { w, h };
}

// Visible data
function visibleSeries() {
  return S.numericIdx
    .map((ci, idx) => ({
      ci,
      idx,
      name: S.headers[ci],
      color: trackColor(idx),
      data: S.columns[ci],
      levels: S.lod[ci] || [],
    }))
    .filter(series => S.selected.has(series.ci) && series.data);
}

function chooseEnvelopeLodIndex(levels, samplesPerPixel) {
  let chosenIndex = -1;
  /*
  Keep each cached bucket within one screen column.
  Build partial ranges from smaller buckets or raw samples.
  */
  for (let index = 0; index < levels.length; index++) {
    const level = levels[index];
    if (level.bucketSize > samplesPerPixel) break;
    chosenIndex = index;
  }
  return chosenIndex;
}

// Main plot rendering
const MARGIN = { top: 20, right: 14, bottom: 32, left: 62 };
const MIN_BAND = 80;
const PREF_BAND = 130;

function alignMinimapToPlot() {
  const left = cssRem(MARGIN.left);
  const right = cssRem(MARGIN.right);
  const style = el.minimapWrap.style;
  if (
    style.getPropertyValue('--minimap-plot-left') === left
    && style.getPropertyValue('--minimap-plot-right') === right
  ) return;
  style.setProperty('--minimap-plot-left', left);
  style.setProperty('--minimap-plot-right', right);
  invalidateMinimap();
}

function drawMain() {
  const N = S.numericIdx.filter(i => S.selected.has(i)).length;
  const visibleCount = Math.max(0, Math.min(S.window, S.rowCount - S.start));

  // Match the plot and minimap spacing
  MARGIN.bottom = .75 * rootRemPixels();

  const wrapH = el.canvasWrap.getBoundingClientRect().height || 400;
  const wrapW = el.canvasWrap.getBoundingClientRect().width  || 600;
  const naturalH = N <= 1 ? wrapH : Math.max(wrapH, N * PREF_BAND + MARGIN.top + MARGIN.bottom);
  const useScroll = naturalH > wrapH + 10;

  el.canvasScroll.style.overflowY = useScroll ? 'auto' : 'hidden';
  el.canvasScroll.style.height    = '100%';
  el.mainCanvas.style.height      = useScroll ? cssRem(naturalH) : '100%';

  const canvasW = wrapW;
  const canvasH = useScroll ? naturalH : wrapH;

  sizeCanvas(el.mainCanvas, canvasW, canvasH);
  mainCtx.clearRect(0, 0, canvasW, canvasH);

  mainCtx.fillStyle = cssVar('--surf');
  mainCtx.fillRect(0, 0, canvasW, canvasH);

  // Fit the left margin to the widest Y label
  mainCtx.font = `.625rem ${cssVar('--mono')}`;
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
  alignMinimapToPlot();

  const plotW = Math.max(10, canvasW - MARGIN.left - MARGIN.right);
  const plotH = Math.max(10, canvasH - MARGIN.top  - MARGIN.bottom);

  if (!visibleCount || !N) {
    el.emptyState.style.display = S.rowCount ? 'none' : 'flex';
    drawPointAxis(mainCtx, plotW, visibleCount);
    drawTimeAxis(mainCtx, canvasW, canvasH, plotW, visibleCount);
    return;
  }
  el.emptyState.style.display = 'none';

  const series = visibleSeries();
  const bandH  = plotH / Math.max(1, series.length);

  const gridColor = cssVar('--grid');
  mainCtx.save();
  mainCtx.strokeStyle = gridColor;
  useCrispHairline(mainCtx);
  for (let i = 0; i <= 8; i++) {
    const x = snapStrokeX(mainCtx, MARGIN.left + (i / 8) * plotW);
    mainCtx.beginPath(); mainCtx.moveTo(x, MARGIN.top); mainCtx.lineTo(x, MARGIN.top + plotH); mainCtx.stroke();
  }
  mainCtx.restore();

  series.forEach((s, si) => {
    const bandTop  = MARGIN.top + si * bandH;
    const innerTop = bandTop + 6;
    const innerH   = Math.max(12, bandH - 12);

    const range = S.channelRanges[s.ci] || { lo: -1, hi: 1 };
    const { lo, hi } = range;
    const center    = (lo + hi) / 2;
    const halfRange = Math.max((hi - lo) / 2, 1e-12) / S.scale * 1.1;
    const yMin = center - halfRange;
    const yMax = center + halfRange;

    if (si > 0) {
      mainCtx.save();
      mainCtx.strokeStyle = cssVar('--divider');
      useCrispHairline(mainCtx);
      const dividerY = snapStrokeY(mainCtx, bandTop);
      mainCtx.beginPath(); mainCtx.moveTo(MARGIN.left, dividerY); mainCtx.lineTo(MARGIN.left + plotW, dividerY); mainCtx.stroke();
      mainCtx.restore();
    }

    mainCtx.save();
    mainCtx.fillStyle = s.color;
    mainCtx.font = `600 .6875rem ${cssVar('--font')}`;
    mainCtx.fillText(s.name, snapDeviceX(mainCtx, MARGIN.left + 6), snapDeviceY(mainCtx, bandTop + 16));
    mainCtx.restore();

    mainCtx.save();
    mainCtx.fillStyle = cssVar('--muted');
    mainCtx.font = `.625rem ${cssVar('--mono')}`;
    mainCtx.textAlign = 'right';
    const labelX = snapDeviceX(mainCtx, MARGIN.left - 4);
    mainCtx.fillText(fmtLbl(hi),     labelX, snapDeviceY(mainCtx, innerTop + 8));
    mainCtx.fillText(fmtLbl(center), labelX, snapDeviceY(mainCtx, innerTop + innerH / 2 + 4));
    mainCtx.fillText(fmtLbl(lo),     labelX, snapDeviceY(mainCtx, innerTop + innerH));
    mainCtx.restore();

    mainCtx.save();
    mainCtx.beginPath();
    mainCtx.rect(MARGIN.left, innerTop - 4, plotW, innerH + 8);
    mainCtx.clip();

    mainCtx.strokeStyle = s.color;
    mainCtx.lineWidth   = 1.6;
    const samplesPerPixel = visibleCount / Math.max(1, plotW);
    const useRawLine = visibleCount <= RAW_DRAW_MAX
      && (!interactiveRendering || visibleCount <= INTERACTIVE_RAW_MAX);
    // Bevel joins and flat ends reduce drawing work
    mainCtx.lineJoin = 'bevel';
    mainCtx.lineCap = 'butt';
    mainCtx.beginPath();

    if (useRawLine) {
      let started = false;
      const end = Math.min(s.data.length, S.start + visibleCount);
      const xStep = plotW / Math.max(1, visibleCount - 1);
      const yScale = innerH / Math.max(1e-12, yMax - yMin);
      for (let sample = S.start; sample < end; sample++) {
        const value = s.data[sample];
        if (!Number.isFinite(value)) { started = false; continue; }
        const localIndex = sample - S.start;
        const x = MARGIN.left + localIndex * xStep;
        const y = innerTop + (yMax - value) * yScale;
        if (!started) { mainCtx.moveTo(x, y); started = true; }
        else mainCtx.lineTo(x, y);
      }
    } else {
      /*
      Draw one min and max range per screen column.
      This keeps drawing work stable at every zoom level.
      */
      const displayColumns = Math.max(1, Math.min(Math.ceil(plotW), visibleCount));
      const maxLodIndex = chooseEnvelopeLodIndex(s.levels, samplesPerPixel);
      const ySpan = Math.max(1e-12, yMax - yMin);
      const yScale = innerH / ySpan;
      const minimumStrokeHeight = 1 / canvasScale(mainCtx).y;

      /*
      Draw a continuous preview from real samples.
      The ranges below keep each column's extremes.
      */
      let representativeStarted = false;
      for (let column = 0; column < displayColumns; column++) {
        const sampleStart = S.start + Math.floor((column / displayColumns) * visibleCount);
        const sampleEnd = S.start + Math.floor(((column + 1) / displayColumns) * visibleCount);
        if (sampleStart >= sampleEnd) continue;
        const sample = sampleStart + Math.floor((sampleEnd - sampleStart - 1) / 2);
        const value = s.data[sample];
        if (!Number.isFinite(value)) {
          representativeStarted = false;
          continue;
        }
        const x = MARGIN.left + ((column + 0.5) / displayColumns) * plotW;
        const y = innerTop + (yMax - value) * yScale;
        if (!representativeStarted) {
          mainCtx.moveTo(x, y);
          representativeStarted = true;
        } else {
          mainCtx.lineTo(x, y);
        }
      }

      for (let column = 0; column < displayColumns; column++) {
        const sampleStart = S.start + Math.floor((column / displayColumns) * visibleCount);
        const sampleEnd = S.start + Math.floor(((column + 1) / displayColumns) * visibleCount);
        if (sampleStart >= sampleEnd) continue;

        let low = Infinity;
        let high = -Infinity;
        let cursor = sampleStart;

        while (cursor < sampleEnd) {
          let usedCachedBucket = false;
          for (let levelIndex = maxLodIndex; levelIndex >= 0; levelIndex--) {
            const level = s.levels[levelIndex];
            const bucketSize = level.bucketSize;
            if (cursor % bucketSize !== 0 || cursor + bucketSize > sampleEnd) continue;
            const bucket = cursor / bucketSize;
            const bucketLow = level.min[bucket];
            const bucketHigh = level.max[bucket];
            if (Number.isFinite(bucketLow) && bucketLow < low) low = bucketLow;
            if (Number.isFinite(bucketHigh) && bucketHigh > high) high = bucketHigh;
            cursor += bucketSize;
            usedCachedBucket = true;
            break;
          }
          if (usedCachedBucket) continue;
          const value = s.data[cursor];
          if (Number.isFinite(value)) {
            if (value < low) low = value;
            if (value > high) high = value;
          }
          cursor++;
        }
        if (low === Infinity) continue;

        const x = MARGIN.left + ((column + 0.5) / displayColumns) * plotW;
        const yTop = innerTop + (yMax - high) * yScale;
        let yBottom = innerTop + (yMax - low) * yScale;
        if (Math.abs(yBottom - yTop) < minimumStrokeHeight) yBottom = yTop + minimumStrokeHeight;
        mainCtx.moveTo(x, yTop);
        mainCtx.lineTo(x, yBottom);
      }
    }
    mainCtx.stroke();
    mainCtx.restore();
  });

  mainCtx.save();
  mainCtx.strokeStyle = cssVar('--axis-line');
  useCrispHairline(mainCtx);
  const axisX = snapStrokeX(mainCtx, MARGIN.left);
  const axisY = snapStrokeY(mainCtx, MARGIN.top + plotH);
  mainCtx.beginPath();
  mainCtx.moveTo(axisX, MARGIN.top);
  mainCtx.lineTo(axisX, axisY);
  mainCtx.lineTo(MARGIN.left + plotW, axisY);
  mainCtx.stroke();
  mainCtx.restore();

  drawPointAxis(mainCtx, plotW, visibleCount);
  drawTimeAxis(mainCtx, canvasW, canvasH, plotW, visibleCount);
}

// Draw sample indexes above the plot
function drawPointAxis(ctx, plotW, rowCount) {
  if (!rowCount) return;
  ctx.save();
  ctx.fillStyle = cssVar('--muted');
  ctx.font = `.625rem ${cssVar('--mono')}`;
  ctx.textAlign = 'center';
  for (let i = 0; i <= 8; i++) {
    const x = snapDeviceX(ctx, MARGIN.left + (i / 8) * plotW);
    const sIdx = S.start + Math.round((i / 8) * Math.max(0, rowCount - 1));
    ctx.fillText(fmtN(sIdx), x, snapDeviceY(ctx, MARGIN.top - 5));
  }
  ctx.restore();
}

// Draw time below the plot when sample rate is known
function drawTimeAxis(ctx, cw, ch, plotW, rowCount) {
  if (!S.sampleRate) return;
  ctx.save();
  ctx.fillStyle = cssVar('--muted');
  ctx.font = `.625rem ${cssVar('--mono')}`;
  ctx.textAlign = 'center';
  for (let i = 0; i <= 8; i++) {
    const x = snapDeviceX(ctx, MARGIN.left + (i / 8) * plotW);
    const sIdx = S.start + Math.round((i / 8) * Math.max(0, rowCount - 1));
    ctx.fillText(fmt(sIdx / S.sampleRate, 2) + 's', x, snapDeviceY(ctx, ch - 2));
  }
  ctx.restore();
}


// FFT
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/*
Run a radix-2 FFT in place.
The real and imaginary arrays need a power-of-two length.
*/
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

/*
Return the magnitude spectrum of a real signal.
Remove its mean and pad it to a power-of-two length.
*/
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

// FFT rendering
function drawFFT() {
  if (!S.fftOpen) return;
  const rect = el.fftCanvas.getBoundingClientRect();
  const W = rect.width || 260, H = rect.height || 360;
  sizeCanvas(el.fftCanvas, W, H);
  fftCtx.clearRect(0, 0, W, H);
  fftCtx.fillStyle = cssVar('--surf');
  fftCtx.fillRect(0, 0, W, H);

  const visibleCount = Math.max(0, Math.min(S.window, S.rowCount - S.start));
  const fftCount = Math.min(visibleCount, FFT_MAX_SAMPLES);
  const fftStart = S.start + Math.max(0, Math.floor((visibleCount - fftCount) / 2));
  const sr = S.sampleRate || 1;
  const nyquist = sr / 2;
  const maxFreq = S.sampleRate ? Math.min(nyquist, 150) : nyquist;

  const fftSeries = S.numericIdx
    .map((ci, idx) => ({ ci, idx, name: S.headers[ci], color: trackColor(idx) }))
    .filter(s => S.fftChannels.has(s.ci) && S.columns[s.ci])
    .map(s => {
      const vals = new Float64Array(fftCount);
      const source = S.columns[s.ci];
      for (let r = 0; r < fftCount; r++) {
        const value = source[fftStart + r];
        vals[r] = Number.isFinite(value) ? value : 0;
      }
      return { ...s, vals };
    });

  // Find the largest magnitude before drawing
  let globalMax = 0;
  const computed = fftSeries.slice(0, 8).map(s => {
    const { mags, n } = fftMags(s.vals);
    const cutoff = S.sampleRate ? Math.min(mags.length, Math.ceil(maxFreq * n / sr) + 1) : mags.length;
    for (let i = 1; i < cutoff; i++) {
      if (mags[i] > globalMax) globalMax = mags[i];
    }
    return { ...s, mags, n, cutoff };
  });
  globalMax = globalMax || 1;

  // Fit the left margin to the widest Y label
  fftCtx.font = `.625rem ${cssVar('--mono')}`;
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
  useCrispHairline(fftCtx);
  for (let i = 0; i <= 5; i++) {
    const y = snapStrokeY(fftCtx, M.top + (i / 5) * pH);
    fftCtx.beginPath(); fftCtx.moveTo(M.left, y); fftCtx.lineTo(M.left + pW, y); fftCtx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const x = snapStrokeX(fftCtx, M.left + (i / 5) * pW);
    fftCtx.beginPath(); fftCtx.moveTo(x, M.top); fftCtx.lineTo(x, M.top + pH); fftCtx.stroke();
  }
  fftCtx.restore();

  if (!fftSeries.length) {
    el.fftHeader.textContent = 'FFT: select a channel above';
    fftCtx.save();
    fftCtx.fillStyle = cssVar('--faint');
    fftCtx.font = `.75rem ${cssVar('--font')}`;
    fftCtx.textAlign = 'center';
    const emptyX = snapDeviceX(fftCtx, M.left + pW / 2);
    fftCtx.fillText('No channel', emptyX, snapDeviceY(fftCtx, M.top + pH / 2 - 8));
    fftCtx.fillText('selected above', emptyX, snapDeviceY(fftCtx, M.top + pH / 2 + 10));
    fftCtx.restore();
    drawFFTAxes(fftCtx, M, pW, pH, W, H, maxFreq, globalMax);
    return;
  }

  // Spectrum lines
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

  // Legend
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
    fftCtx.font = `600 .5625rem ${cssVar('--font')}`;
    fftCtx.textAlign = 'right';
    const label = s.name.length > 10 ? s.name.slice(0, 9) + '…' : s.name;
    fftCtx.fillText(label, legendX - 30, legendY + 8);
    fftCtx.restore();
    legendY += 14;
  });

  drawFFTAxes(fftCtx, M, pW, pH, W, H, maxFreq, globalMax);

  const sampleNote = visibleCount > FFT_MAX_SAMPLES ? ` · center ${fmtN(fftCount)} samples` : '';
  const capLabel = S.sampleRate
    ? `FFT 0-${Math.round(maxFreq)} Hz${sampleNote}`
    : `FFT: set sample rate for Hz${sampleNote}`;
  el.fftHeader.textContent = capLabel;
}

function drawFFTAxes(ctx, M, pW, pH, W, H, maxFreq, globalMax) {
  ctx.save();
  ctx.strokeStyle = cssVar('--axis-line');
  useCrispHairline(ctx);
  const axisX = snapStrokeX(ctx, M.left);
  const axisY = snapStrokeY(ctx, M.top + pH);
  ctx.beginPath();
  ctx.moveTo(axisX, M.top); ctx.lineTo(axisX, axisY); ctx.lineTo(M.left + pW, axisY);
  ctx.stroke();

  ctx.fillStyle = cssVar('--muted');
  ctx.font = `.625rem ${cssVar('--mono')}`;

  // Magnitude labels
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = snapDeviceY(ctx, M.top + (i / 4) * pH + 4);
    ctx.fillText(fmtLbl(globalMax * (1 - i / 4)), snapDeviceX(ctx, M.left - 3), y);
  }

  // Frequency labels
  ctx.textAlign = 'center';
  const tickCount = Math.min(6, Math.floor(pW / 40));
  for (let i = 0; i <= tickCount; i++) {
    const x = snapDeviceX(ctx, M.left + (i / tickCount) * pW);
    const freqVal = maxFreq * i / tickCount;
    const label = S.sampleRate ? Math.round(freqVal) + 'Hz' : fmt(freqVal, 1);
    ctx.fillText(label, x, snapDeviceY(ctx, H - 8));
  }
  ctx.restore();
}


// Rendering and startup: minimap update
function updateTimeline() {
  updateMinimapViewport();
  drawMinimap();
}

// Main render loop
/*
State changes call renderAll.
It combines many changes into one frame.
*/
let raf = 0;
let fftTimer = 0;
let wheelSettleTimer = 0;
let interactiveRendering = false;
let lastInteractiveMainDraw = 0;

function scheduleFFT() {
  clearTimeout(fftTimer);
  if (!S.fftOpen) return;
  fftTimer = setTimeout(() => {
    fftTimer = 0;
    requestAnimationFrame(drawFFT);
  }, 120);
}

function renderInteractive() {
  interactiveRendering = true;
  clearTimeout(fftTimer);
  if (raf) return;
  raf = requestAnimationFrame(timestamp => {
    raf = 0;
    // Move only the minimap window during navigation
    updateMinimapViewport();
    // Limit waveform updates to about 30 frames per second
    if (timestamp - lastInteractiveMainDraw >= 32) {
      lastInteractiveMainDraw = timestamp;
      drawMain();
    }
  });
}

function finishInteractiveRendering() {
  if (!interactiveRendering) return;
  interactiveRendering = false;
  lastInteractiveMainDraw = 0;
  renderAll();
}

function renderWheelInteraction() {
  renderInteractive();
  clearTimeout(wheelSettleTimer);
  wheelSettleTimer = setTimeout(finishInteractiveRendering, 110);
}

function renderAll() {
  clearTimeout(wheelSettleTimer);
  interactiveRendering = false;
  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    raf = 0;
    drawMain();
    updateTimeline();
    if (!interactiveRendering) scheduleFFT();
  });
}

// Resize handling
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
      if (currFW > maxFW) el.fftCol.style.width = cssRem(maxFW);
    }
  }
  renderAll();
}, { passive: true });

// Rebuild canvases when display density changes
function watchDevicePixelRatio() {
  const densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  const handleDensityChange = () => {
    invalidateMinimap();
    renderAll();
    watchDevicePixelRatio();
  };
  if (densityQuery.addEventListener) {
    densityQuery.addEventListener('change', handleDensityChange, { once: true });
  } else {
    const legacyDensityChange = () => {
      densityQuery.removeListener(legacyDensityChange);
      handleDensityChange();
    };
    densityQuery.addListener(legacyDensityChange);
  }
}
watchDevicePixelRatio();

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', renderAll, { passive: true });
}

// Redraw canvas text after fonts load
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(renderAll);
}

// Startup
syncVerticalScaleControl();
renderAll();


// Tour
(function() {
'use strict';

const TOUR_SEEN_KEY = 'csvplotter_data_tour_seen_v1';

const steps = [
  {
    target: () => document.querySelector('.upload-btn'),
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    title: 'CSV files',
    body: 'Use this button to load or replace a CSV file.',
    arrow: 'top',
    padRem: .375,
  },
  {
    target: () => document.querySelector('.topbar-controls'),
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>`,
    title: 'Plot controls',
    body: '<strong>Sample Rate</strong> adds time labels. Use <strong>Scale</strong> to change waveform height, or open <strong>FFT</strong>.',
    arrow: 'top',
    padRem: .25,
  },
  {
    target: () => document.getElementById('sidebar'),
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    title: 'Channels',
    body: 'Open <strong>Channels</strong>, then choose which signals to plot.',
    arrow: 'right',
    padRem: .25,
  },
  {
    target: () => document.querySelector('.timeline'),
    includeTargets: () => [
      document.getElementById('minimapLeftHandle'),
      document.getElementById('minimapRightHandle'),
    ],
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
    title: 'Minimap',
    body: 'Drag the window to move. Drag its edges to zoom. Click anywhere to jump.',
    arrow: 'top',
    padRem: .25,
  },
  {
    target: () => document.getElementById('fftBtn'),
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    title: 'Frequency view',
    body: 'Click <strong>FFT</strong> to view frequencies in the visible data.',
    arrow: 'top',
    padRem: .375,
  },
];

let cur = 0;
let active = false;
let autoTourScheduled = false;

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
  const target = step.target();
  if (!target) return null;
  const includedTargets = step.includeTargets ? step.includeTargets() : [];
  const rects = [target, ...includedTargets]
    .filter(Boolean)
    .map(element => element.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  const rem = rootRemPixels();
  const pad = (step.padRem || 0) * rem;
  const top = Math.min(...rects.map(rect => rect.top));
  const left = Math.min(...rects.map(rect => rect.left));
  const right = Math.max(...rects.map(rect => rect.right));
  const bottom = Math.max(...rects.map(rect => rect.bottom));
  const width = right - left;
  const height = bottom - top;

  return {
    top: top - pad,
    left: left - pad,
    width: width + pad * 2,
    height: height + pad * 2,
    bottom: top + height + pad,
    right: left + width + pad,
    cx: left + width / 2,
    cy: top + height / 2,
  };
}

const TOUR_EDGE_REM = 1, TOUR_GAP_REM = 1;

function positionCard(rect, arrow) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const rem = rootRemPixels();
  const edge = TOUR_EDGE_REM * rem, gap = TOUR_GAP_REM * rem;
  const measured = tCard.getBoundingClientRect();
  const cardW = measured.width, cardH = measured.height;
  const clampX = value => Math.max(edge, Math.min(vw - cardW - edge, value));
  const clampY = value => Math.max(edge, Math.min(vh - cardH - edge, value));
  let top, left, arrowDir = 'none', fits = true;

  if (!rect || arrow === 'none') {
    top = clampY((vh - cardH) / 2);
    left = clampX((vw - cardW) / 2);
  } else {
    const candidates = {
      right: {
        left: rect.right + gap, top: clampY(rect.cy - cardH / 2), arrow: 'left',
        fits: rect.right + gap + cardW <= vw - edge,
      },
      left: {
        left: rect.left - gap - cardW, top: clampY(rect.cy - cardH / 2), arrow: 'right',
        fits: rect.left - gap - cardW >= edge,
      },
      bottom: {
        left: clampX(rect.cx - cardW / 2), top: rect.bottom + gap, arrow: 'top',
        fits: rect.bottom + gap + cardH <= vh - edge,
      },
      top: {
        left: clampX(rect.cx - cardW / 2), top: rect.top - gap - cardH, arrow: 'bottom',
        fits: rect.top - gap - cardH >= edge,
      },
    };
    const preferred = arrow === 'top' ? 'bottom' : arrow === 'bottom' ? 'top' : arrow;
    const order = [preferred, 'right', 'left', 'bottom', 'top']
      .filter((side, i, all) => all.indexOf(side) === i);
    const chosen = order.map(side => candidates[side]).find(candidate => candidate && candidate.fits);

    if (chosen) {
      top = chosen.top;
      left = chosen.left;
      arrowDir = chosen.arrow;
    } else {
      // Center the card when it cannot fit beside the target
      top = clampY((vh - cardH) / 2);
      left = clampX((vw - cardW) / 2);
      fits = false;
    }
  }

  tCard.style.top  = cssRem(top);
  tCard.style.left = cssRem(left);
  tCard.setAttribute('data-arrow', arrowDir);
  return fits;
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
    tHL.style.left   = cssRem(hl);
    tHL.style.top    = cssRem(ht);
    tHL.style.width  = cssRem(Math.max(0, Math.min(rect.right,  vw) - hl));
    tHL.style.height = cssRem(Math.max(0, Math.min(rect.bottom, vh) - ht));
    tHL.classList.add('visible');
    tDim.classList.remove('visible');
  } else {
    tHL.classList.remove('visible');
    tDim.classList.add('visible');
  }

  const cardFits = positionCard(rect, step.arrow);
  if (rect && !cardFits) {
    tHL.classList.remove('visible');
    tDim.classList.add('visible');
  }

  if (!tCard.classList.contains('visible')) {
    tCard.classList.add('visible');
  }
}

function startTour() {
  if (!S.rowCount) return;
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

document.addEventListener('csvplotter:data-loaded', () => {
  if (active || autoTourScheduled || localStorage.getItem(TOUR_SEEN_KEY)) return;
  autoTourScheduled = true;
  // Wait for the first plot and minimap render
  setTimeout(() => {
    autoTourScheduled = false;
    if (S.rowCount && !active && !localStorage.getItem(TOUR_SEEN_KEY)) startTour();
  }, 300);
});

document.addEventListener('csvplotter:data-cleared', () => {
  if (active) endTour();
});

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
    tHL.style.left   = cssRem(hl);
    tHL.style.top    = cssRem(ht);
    tHL.style.width  = cssRem(Math.max(0, Math.min(rect.right,  vw) - hl));
    tHL.style.height = cssRem(Math.max(0, Math.min(rect.bottom, vh) - ht));
  }
  const cardFits = positionCard(rect, steps[cur].arrow);
  if (rect && !cardFits) {
    tHL.classList.remove('visible');
    tDim.classList.add('visible');
  } else if (rect) {
    tHL.classList.add('visible');
    tDim.classList.remove('visible');
  }
}, { passive: true });

})();
