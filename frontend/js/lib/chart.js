// Grafik candle simbol di atas TradingView Lightweight Charts™ (Apache-2.0, © TradingView, Inc. — lihat
// THIRD_PARTY_NOTICES.md). Modul ini satu-satunya tempat yang menyentuh API library.
//
// - Library dimuat malas dari file vendor same-origin /vendor/lightweight-charts.js (lolos CSP script-src 'self')
//   saat grafik pertama dibuat. Halaman login dan halaman tanpa grafik tidak pernah memuatnya.
// - Logo atribusi TradingView bawaan tetap aktif (syarat atribusi lisensi). Library memasang gaya logo lewat elemen
//   <style> inline yang DIBLOKIR CSP style-src 'self' (browser mencatat pelanggaran CSP di konsol); aturan gaya yang
//   sama disediakan components.css sehingga logo tetap tampil benar tanpa melonggarkan CSP.
// - Warna dibaca dari token CSS (getComputedStyle) sehingga grafik mengikuti tema & mode kontras tinggi.
// - Waktu: candle API epoch ms UTC → detik UTC (UTCTimestamp) untuk library; sumbu waktu tampil dalam UTC.
// - EMA7/EMA25 dihitung di klien dengan rumus yang sama dengan backend/indicators/ema.js.
// - Tidak ada data contoh: tanpa candle, grafik kosong dan pemanggil menampilkan empty state.
import { h } from './dom.js';
import { DISPLAY_TZ_OFFSET_MS, formatCompact, formatPrice, formatTime } from './format.js';

export const CHART_VENDOR_SRC = '/vendor/lightweight-charts.js';
export const EMA_PERIODS = Object.freeze([7, 25]);

// Selaras dengan TIMEFRAME_MS di backend/market/contracts.js (frontend tidak dapat mengimpor modul backend).
const TIMEFRAME_MS = Object.freeze({ '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000 });

/** Jenis level harga horizontal → label Indonesia + token warna. */
export const LEVEL_KINDS = Object.freeze({
  invalidation: { label: 'Invalidasi', token: '--lr-bear', fallback: '#f16b75' },
  detected: { label: 'Deteksi pertama', token: '--lr-text-2', fallback: '#8b98a8' },
  support: { label: 'Support', token: '--lr-bull', fallback: '#21c58e' },
  resistance: { label: 'Resistance', token: '--lr-warn', fallback: '#f4b860' },
});

// Penanda transisi tahap di atas/bawah candle. Kode tak dikenal → lingkaran netral berlabel kode itu sendiri.
const MARKER_STYLES = Object.freeze({
  DETECTED: { shape: 'arrowUp', position: 'belowBar', token: '--lr-accent', text: 'Deteksi' },
  QUIET: { shape: 'circle', position: 'belowBar', token: '--lr-text-2', text: 'Quiet' },
  EARLY_BULLISH: { shape: 'circle', position: 'belowBar', token: '--lr-accent', text: 'Early' },
  MOMENTUM_BUILDING: { shape: 'circle', position: 'belowBar', token: '--lr-bull', text: 'Momentum' },
  BREAKOUT: { shape: 'arrowUp', position: 'belowBar', token: '--lr-bull', text: 'Breakout' },
  EARLY_BEARISH: { shape: 'circle', position: 'aboveBar', token: '--lr-accent', text: 'Early' },
  BREAKDOWN: { shape: 'arrowDown', position: 'aboveBar', token: '--lr-bear', text: 'Breakdown' },
  INVALIDATED: { shape: 'square', position: 'aboveBar', token: '--lr-bear', text: 'Invalid' },
  EXPIRED: { shape: 'square', position: 'aboveBar', token: '--lr-text-3', text: 'Expired' },
  // Reversal Radar (docs/19 §2 MARKER_KINDS + event riwayat): bukti di bawah candle, pemicu/pembatalan di atasnya.
  BOTTOM: { shape: 'circle', position: 'belowBar', token: '--lr-bear', text: 'Bottom' },
  LOWER_LOW: { shape: 'circle', position: 'belowBar', token: '--lr-text-3', text: 'LL' },
  HIGHER_LOW: { shape: 'circle', position: 'belowBar', token: '--lr-bull', text: 'HL' },
  SPRING: { shape: 'arrowUp', position: 'belowBar', token: '--lr-accent', text: 'Spring' },
  CHOCH: { shape: 'circle', position: 'aboveBar', token: '--lr-accent', text: 'CHoCH' },
  DIVERGENCE: { shape: 'circle', position: 'belowBar', token: '--lr-neural-violet', text: 'Divergensi' },
  TRIGGER: { shape: 'square', position: 'aboveBar', token: '--lr-warn', text: 'Trigger' },
  STAGE_UP: { shape: 'arrowUp', position: 'belowBar', token: '--lr-bull', text: 'Naik tahap' },
  CANCELLED: { shape: 'square', position: 'aboveBar', token: '--lr-bear', text: 'Batal' },
  PROVISIONAL: { shape: 'circle', position: 'aboveBar', token: '--lr-text-3', text: 'Provisional' },
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// Lightweight Charts menampilkan `time` apa adanya sebagai UTC. Waktu digeser ke WIB (DISPLAY_TZ_OFFSET_MS) agar sumbu
// waktu & crosshair sama dengan tabel dan dengan grafik Binance pengguna; pemetaan balik memakai peta byTime yang sama.
const toTime = (ms) => Math.floor((ms + DISPLAY_TZ_OFFSET_MS) / 1000);

let libraryPromise = null;

/**
 * Memuat library sekali (satu <script src> same-origin) lalu mengembalikan namespace global-nya.
 * Gagal (mis. file tidak dapat diunduh) → promise ditolak dan percobaan berikutnya memuat ulang.
 * @returns {Promise<any>} window.LightweightCharts
 */
export function loadChartLibrary() {
  if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  libraryPromise ??= new Promise((resolve, reject) => {
    const fail = (script) => {
      script.remove();
      libraryPromise = null;
      // Termasuk 503 dari server saat paket lightweight-charts belum terpasang (git pull tanpa npm ci).
      reject(new Error('Library grafik gagal dimuat dari /vendor/lightweight-charts.js. Bila baru git pull, jalankan npm ci lalu start ulang server'));
    };
    const script = h('script', {
      src: CHART_VENDOR_SRC,
      dataset: { vendor: 'lightweight-charts' },
      on: {
        load: () => (window.LightweightCharts ? resolve(window.LightweightCharts) : fail(script)),
        error: () => fail(script),
      },
    });
    document.head.append(script);
  });
  return libraryPromise;
}

/**
 * EMA — port setia backend/indicators/ema.js: alpha = 2 / (period + 1), diseed SMA `period` nilai pertama,
 * indeks 0..period-2 bernilai null (warm-up). Nilai tidak valid → TypeError, sama dengan backend.
 * @param {number[]} values
 * @param {number} period
 * @returns {Array<number|null>}
 */
export function ema(values, period) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('Periode harus bilangan bulat ≥ 1');
  const out = new Array(values.length).fill(null);
  if (values.length < period) {
    values.forEach((v, i) => { if (!isNum(v)) throw new TypeError(`Nilai tidak valid pada indeks ${i}`); });
    return out;
  }
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) {
    if (!isNum(values[i])) throw new TypeError(`Nilai tidak valid pada indeks ${i}`);
    seed += values[i];
  }
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    if (!isNum(values[i])) throw new TypeError(`Nilai tidak valid pada indeks ${i}`);
    prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/**
 * Candle API → candle grafik: hanya baris dengan openTime bulat & OHLC finite, urut naik, duplikat openTime
 * diambil yang terakhir. Volume tidak valid → 0 (batang volume kosong, bukan angka karangan).
 */
export function normalizeCandles(candles) {
  const byTime = new Map();
  for (const c of Array.isArray(candles) ? candles : []) {
    if (!c || !Number.isInteger(c.openTime) || ![c.open, c.high, c.low, c.close].every(isNum)) continue;
    byTime.set(c.openTime, {
      openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: isNum(c.volume) && c.volume >= 0 ? c.volume : 0,
    });
  }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

/** Level harga valid (> 0) dengan label Indonesia; jenis tak dikenal tetap tampil dengan warna netral. */
export function normalizeLevels(levels) {
  return (Array.isArray(levels) ? levels : [])
    .filter((l) => l && isNum(l.price) && l.price > 0)
    .map((l) => ({ price: l.price, kind: String(l.kind ?? ''), label: l.label ?? LEVEL_KINDS[l.kind]?.label ?? 'Level' }));
}

/** Langkah harga minimum sesuai presisi formatPrice (aset murah butuh lebih banyak desimal). */
function minMoveFor(price) {
  const abs = Math.abs(price);
  if (abs >= 1000) return 0.01;
  if (abs >= 1) return 0.0001;
  if (abs >= 0.01) return 0.00001;
  return 0.00000001;
}

/** Token warna dari CSS; kosong / tidak dikenali browser → nilai cadangan (nilai token saat ini). */
function readTheme(el) {
  const css = getComputedStyle(el);
  const color = (name, fallback) => {
    const value = css.getPropertyValue(name).trim();
    return value && CSS.supports('color', value) ? value : fallback;
  };
  return {
    // Tema "Neural Aurora": latar kanvas transparan agar panel kaca (dan gradien halus .chart__canvas) terlihat.
    background: color('--lr-chart-bg', 'transparent'),
    surface3: color('--lr-surface-3', '#1d2531'),
    // Teks sumbu memakai --lr-text: library memilih varian logo atribusi gelap/terang dari kecerahan textColor
    // (> 160 = tema gelap); --lr-text-2 (151) membuat logo varian terang yang nyaris tak terlihat di latar gelap.
    text: color('--lr-text', '#eaf0f6'),
    grid: color('--lr-chart-grid', 'rgb(148 178 220 / 0.05)'),
    border: color('--lr-glass-border', 'rgb(148 178 220 / 0.12)'),
    crosshair: color('--lr-neural-cyan', '#38e1ff'),
    crosshairLabel: color('--lr-chart-crosshair-label', 'rgb(16 64 84 / 0.96)'),
    watermark: color('--lr-chart-watermark', 'rgb(56 225 255 / 0.06)'),
    bull: color('--lr-bull', '#21c58e'),
    bear: color('--lr-bear', '#f16b75'),
    bullLine: color('--lr-bull-line', 'rgb(33 197 142 / 0.35)'),
    bearLine: color('--lr-bear-line', 'rgb(241 107 117 / 0.35)'),
    ema7: color('--lr-neural-cyan', '#38e1ff'),
    ema25: color('--lr-neural-violet', '#7c6cff'),
    font: css.getPropertyValue('--lr-font-sans').trim() || 'system-ui, sans-serif',
    token: (name, fallback) => color(name, fallback),
  };
}

// ---- Pembersihan otomatis saat elemen dilepas dari DOM (navigasi hash mengganti isi <main>) ----
const watchers = new Set();
let domObserver = null;

function checkWatchers() {
  for (const w of watchers) {
    if (w.el.isConnected) w.seen = true;
    else if (w.seen) {
      watchers.delete(w);
      w.callback();
    }
  }
  if (watchers.size === 0) {
    domObserver?.disconnect();
    domObserver = null;
  }
}

/**
 * Memanggil `callback` sekali ketika `el` — yang sudah pernah terpasang di dokumen — dilepas dari DOM.
 * Elemen yang dibuat terlepas (view yang belum dipasang) baru dipantau setelah terpasang.
 * @returns {() => void} berhenti memantau
 */
export function onDisconnect(el, callback) {
  const w = { el, callback, seen: el.isConnected };
  watchers.add(w);
  if (!domObserver) {
    domObserver = new MutationObserver(checkWatchers);
    domObserver.observe(document.body, { childList: true, subtree: true });
  }
  return () => {
    watchers.delete(w);
    if (watchers.size === 0) {
      domObserver?.disconnect();
      domObserver = null;
    }
  };
}

/**
 * Membuat grafik candlestick + volume + EMA7/EMA25 + level harga + penanda di dalam `container`.
 * @param {HTMLElement} container elemen kosong (isinya diganti)
 * @param {{ candles?: Array<{ openTime: number, open: number, high: number, low: number, close: number, volume: number }>,
 *   timeframe: '5m'|'15m'|'1h', symbol?: string,
 *   levels?: Array<{ price: number, kind: 'invalidation'|'detected'|'support'|'resistance'|string, label?: string }>,
 *   markers?: Array<{ time: number, kind: string, text?: string }> }} options
 *   `markers[].time` epoch ms UTC (dibulatkan ke candle yang memuatnya; di luar rentang candle diabaikan).
 * @returns {Promise<{ setCandles: (candles: object[]) => void, setLevels: (levels: object[]) => void,
 *   setMarkers: (markers: object[]) => void, destroy: () => void, readonly destroyed: boolean }>}
 */
export async function createCandleChart(container, { candles = [], timeframe, symbol = '', levels = [], markers = [] } = {}) {
  const LWC = await loadChartLibrary();
  const tfMs = TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS['15m'];
  let theme = readTheme(container);
  let data = [];
  let levelList = normalizeLevels(levels);
  let markerList = Array.isArray(markers) ? markers : [];
  let priceLines = [];
  let destroyed = false;

  // role="figure", bukan "img": library memasang tautan logo atribusi (dapat difokus) di dalam elemen ini, dan anak
  // role="img" bersifat presentasional — tautan yang dapat difokus di dalamnya menjadi kontrol interaktif bersarang.
  const canvasHost = h('div', { class: 'chart__canvas', role: 'figure', 'data-testid': 'candle-chart' });
  const swatch = (label, key) => h('span', { class: 'chart__legend-item' },
    h('span', { class: 'chart__swatch', 'data-series': key }), label);
  // OHLC candle di bawah crosshair (default: candle tertutup terakhir) — nilai nyata dari data yang sedang tampil.
  const ohlc = h('span', { class: 'chart__ohlc num', 'data-testid': 'candle-chart-ohlc' });
  const legend = h('div', { class: 'chart__legend', 'aria-hidden': 'true' },
    ohlc, swatch('EMA7', 'ema7'), swatch('EMA25', 'ema25'), swatch('Volume', 'volume'), h('span', { class: 'chart__legend-note' }, 'Waktu UTC'));
  const summary = h('p', { class: 'sr-only', 'data-testid': 'candle-chart-summary' });
  container.classList.add('chart');
  container.replaceChildren(canvasHost, legend, summary);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const chart = LWC.createChart(canvasHost, {
    width: canvasHost.clientWidth || 600,
    height: canvasHost.clientHeight || 360,
    layout: { background: { type: LWC.ColorType.Solid, color: theme.background }, textColor: theme.text, fontFamily: theme.font, fontSize: 11, attributionLogo: true },
    rightPriceScale: { borderColor: theme.border, scaleMargins: { top: 0.08, bottom: 0.26 } },
    timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 7 },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    // Geser vertikal di layar sentuh tetap menggulir halaman, bukan skala harga.
    handleScroll: { vertTouchDrag: false },
    kineticScroll: { mouse: false, touch: !reducedMotion },
    localization: { locale: 'id-ID' },
  });
  const candleSeries = chart.addSeries(LWC.CandlestickSeries, { borderVisible: false });
  const volumeSeries = chart.addSeries(LWC.HistogramSeries, {
    priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false,
  });
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
  const lineOptions = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  const ema7Series = chart.addSeries(LWC.LineSeries, lineOptions);
  const ema25Series = chart.addSeries(LWC.LineSeries, lineOptions);
  const markerPlugin = LWC.createSeriesMarkers(candleSeries, []);
  // Tanda air dekoratif: hanya nama simbol & timeframe yang sedang ditampilkan (bukan data).
  const watermarkText = [symbol, timeframe].filter(Boolean).join(' · ');
  const watermark = watermarkText && typeof LWC.createTextWatermark === 'function'
    ? LWC.createTextWatermark(chart.panes()[0], { horzAlign: 'center', vertAlign: 'center', lines: [] })
    : null;

  function applyTheme() {
    chart.applyOptions({
      layout: { background: { type: LWC.ColorType.Solid, color: theme.background }, textColor: theme.text, fontFamily: theme.font },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border },
      crosshair: {
        vertLine: { color: theme.crosshair, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: theme.crosshairLabel },
        horzLine: { color: theme.crosshair, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: theme.crosshairLabel },
      },
    });
    candleSeries.applyOptions({ upColor: theme.bull, downColor: theme.bear, wickUpColor: theme.bull, wickDownColor: theme.bear });
    ema7Series.applyOptions({ color: theme.ema7 });
    ema25Series.applyOptions({ color: theme.ema25 });
    watermark?.applyOptions({
      lines: [{ text: watermarkText, color: theme.watermark, fontSize: 44, fontStyle: '600', fontFamily: theme.font }],
    });
    for (const [key, value] of Object.entries({ ema7: theme.ema7, ema25: theme.ema25, volume: theme.bullLine })) {
      legend.querySelector(`[data-series="${key}"]`)?.style.setProperty('--lr-chart-swatch', value);
    }
  }

  const emaLast = (values) => {
    for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] !== null) return values[i];
    return null;
  };

  function describe(emaValues) {
    const name = [symbol, timeframe].filter(Boolean).join(' ');
    const last = data.at(-1);
    if (!last) {
      canvasHost.setAttribute('aria-label', `Grafik candlestick ${name}: belum ada candle tertutup`);
      summary.textContent = 'Belum ada candle tertutup.';
      return;
    }
    canvasHost.setAttribute('aria-label',
      `Grafik candlestick ${name}, ${data.length} candle tertutup, close terakhir ${formatPrice(last.close)} (${formatTime(last.openTime)})`);
    const levelText = levelList.length
      ? `Level: ${levelList.map((l) => `${l.label} ${formatPrice(l.price)}`).join('; ')}.`
      : 'Tidak ada level sinyal.';
    summary.textContent = `Candle tertutup terakhir dibuka ${formatTime(last.openTime)}: open ${formatPrice(last.open)}, `
      + `high ${formatPrice(last.high)}, low ${formatPrice(last.low)}, close ${formatPrice(last.close)}, volume ${formatCompact(last.volume)}. `
      + `EMA7 ${formatPrice(emaLast(emaValues[0]))}, EMA25 ${formatPrice(emaLast(emaValues[1]))}. ${levelText}`;
  }

  function paintLevels() {
    for (const line of priceLines) candleSeries.removePriceLine(line);
    priceLines = levelList.map((l) => candleSeries.createPriceLine({
      price: l.price,
      color: theme.token(LEVEL_KINDS[l.kind]?.token ?? '--lr-text-3', LEVEL_KINDS[l.kind]?.fallback ?? '#7a8696'),
      lineWidth: 1,
      lineStyle: LWC.LineStyle.Dashed,
      axisLabelVisible: true,
      title: l.label,
    }));
  }

  function paintMarkers() {
    const times = new Set(data.map((c) => c.openTime));
    const mapped = [];
    for (const m of markerList) {
      if (!m || !isNum(m.time)) continue;
      const openTime = Math.floor(m.time / tfMs) * tfMs;
      if (!times.has(openTime)) continue;
      const style = MARKER_STYLES[m.kind] ?? { shape: 'circle', position: 'aboveBar', token: '--lr-text-3', text: String(m.kind ?? '') };
      mapped.push({
        time: toTime(openTime),
        position: style.position,
        shape: style.shape,
        color: theme.token(style.token, '#8b98a8'),
        text: m.text ?? style.text,
      });
    }
    markerPlugin.setMarkers(mapped.sort((a, b) => a.time - b.time));
  }

  let byTime = new Map();
  function showOhlc(candle) {
    if (!candle) {
      ohlc.replaceChildren();
      return;
    }
    const part = (k, text) => h('span', { class: 'chart__ohlc-part' }, h('span', { class: 'chart__ohlc-key' }, k), text);
    ohlc.dataset.dir = candle.close >= candle.open ? 'up' : 'down';
    ohlc.replaceChildren(part('O', formatPrice(candle.open)), part('H', formatPrice(candle.high)),
      part('L', formatPrice(candle.low)), part('C', formatPrice(candle.close)), part('V', formatCompact(candle.volume)));
  }
  chart.subscribeCrosshairMove((param) => {
    if (destroyed) return;
    const hovered = param?.time !== undefined ? byTime.get(param.time) : null;
    showOhlc(hovered ?? data.at(-1));
  });

  function paintData() {
    byTime = new Map(data.map((c) => [toTime(c.openTime), c]));
    showOhlc(data.at(-1));
    const first = data[0];
    if (first) candleSeries.applyOptions({ priceFormat: { type: 'custom', formatter: formatPrice, minMove: minMoveFor(first.close) } });
    candleSeries.setData(data.map((c) => ({ time: toTime(c.openTime), open: c.open, high: c.high, low: c.low, close: c.close })));
    volumeSeries.setData(data.map((c) => ({ time: toTime(c.openTime), value: c.volume, color: c.close >= c.open ? theme.bullLine : theme.bearLine })));
    const closes = data.map((c) => c.close);
    const emaValues = EMA_PERIODS.map((p) => ema(closes, p));
    const toLine = (values) => values.flatMap((v, i) => (v === null ? [] : [{ time: toTime(data[i].openTime), value: v }]));
    ema7Series.setData(toLine(emaValues[0]));
    ema25Series.setData(toLine(emaValues[1]));
    paintMarkers();
    describe(emaValues);
  }

  // Ukuran mengikuti CSS kontainer (tinggi tetap per varian, lebar responsif).
  const resizeObserver = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (destroyed || !box || box.width < 1 || box.height < 1) return;
    chart.resize(Math.floor(box.width), Math.floor(box.height));
  });
  resizeObserver.observe(canvasHost);

  const contrast = window.matchMedia('(prefers-contrast: more)');
  const onContrast = () => {
    theme = readTheme(container);
    applyTheme();
    paintLevels();
    paintData();
  };
  contrast.addEventListener('change', onContrast);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopWatching();
    resizeObserver.disconnect();
    contrast.removeEventListener('change', onContrast);
    chart.remove();
  }
  const stopWatching = onDisconnect(container, destroy);

  applyTheme();
  data = normalizeCandles(candles);
  paintLevels();
  paintData();

  return {
    setCandles(next) {
      if (destroyed) return;
      data = normalizeCandles(next);
      paintData();
    },
    setLevels(next) {
      if (destroyed) return;
      levelList = normalizeLevels(next);
      paintLevels();
      describe(EMA_PERIODS.map((p) => ema(data.map((c) => c.close), p)));
    },
    setMarkers(next) {
      if (destroyed) return;
      markerList = Array.isArray(next) ? next : [];
      paintMarkers();
    },
    destroy,
    get destroyed() { return destroyed; },
  };
}
