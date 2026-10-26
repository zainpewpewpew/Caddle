// Generator pasar SINTETIS berbenih (deterministik) untuk menguji MEKANISME backtest: anti
// lookahead, labeler, metrik, kalibrasi, dan runner. Data ini BUKAN data pasar nyata; hasil
// backtest di atasnya hanya membuktikan mekanisme bekerja, bukan akurasi di pasar sungguhan.
//
// Model harga: log-return per candle = drift + sigma·N(0,1) (+ siklus zig-zag untuk rezim akumulasi/
// distribusi, + gaya tarik ke pusat untuk RANGE). Rezim turun/distribusi adalah CERMIN log-harga dari
// rezim naik/akumulasi (log p → −log p, wick atas ↔ bawah, taker buy ↔ taker sell), sehingga LONG dan
// SHORT diuji dengan generator yang simetris. Tanpa Math.random: semua derau dari PRNG berbenih.
//
// Kandle mengikuti kontrak backend/market/contracts.js (isClosed true, source 'rest', openTime sejajar
// interval, closeTime = openTime + interval − 1, takerBuyVolume ≤ volume).
import { TIMEFRAME_MS, isAlignedOpenTime } from '../market/contracts.js';
import { mirrorCandles } from '../patterns/mirror.js';

/** Tipe rezim yang dikenal generator. */
export const REGIME_TYPES = Object.freeze(['RANDOM_WALK', 'TREND_UP', 'TREND_DOWN', 'RANGE', 'ACCUMULATION', 'DISTRIBUTION']);

/** Bobot default pemilihan rezim acak (regimes = 'random'). */
export const DEFAULT_MIX = Object.freeze({
  RANDOM_WALK: 3, TREND_UP: 1, TREND_DOWN: 1, RANGE: 2, ACCUMULATION: 1, DISTRIBUTION: 1,
});

/**
 * Parameter rezim per candle pada skala 15m (sigma diskalakan √(interval/15m), drift & langkah
 * siklus diskalakan interval/15m). Titik awal yang masuk akal untuk uji mekanisme, bukan kalibrasi
 * pasar nyata.
 */
export const REGIME_PARAMS = Object.freeze({
  RANDOM_WALK: Object.freeze({ drift: 0, sigma: 0.004, volume: 1, volumeSigma: 0.3, taker: 0.5 }),
  TREND_UP: Object.freeze({ drift: 0.001, sigma: 0.0035, volume: 1.15, volumeSigma: 0.28, taker: 0.54 }),
  RANGE: Object.freeze({ kappa: 0.08, sigma: 0.003, volume: 0.85, volumeSigma: 0.25, taker: 0.5 }),
  // Akumulasi: siklus 5 naik / 3 turun (higher low tiap 8 candle) dengan derau kecil; 55% awal
  // senyap (volume 0,45× baseline), sisanya volume naik progresif 0,5× → 1,6×; taker buy ≈ 0,57.
  ACCUMULATION: Object.freeze({
    step: 0.0012, up: 5, down: 3, sigma: 0.0004, quietShare: 0.55, quietVolume: 0.45,
    rampFrom: 0.5, rampTo: 1.6, volumeSigma: 0.1, taker: 0.57,
  }),
  // Markup otomatis setelah akumulasi (dan markdown cermin setelah distribusi).
  MARKUP: Object.freeze({ drift: 0.0025, sigma: 0.0035, volume: 1.5, volumeSigma: 0.25, taker: 0.58 }),
});

/** Panjang default markup/markdown otomatis setelah ACCUMULATION/DISTRIBUTION. */
export const DEFAULT_MARKUP_BARS = 24;

const MIRROR_OF = Object.freeze({ TREND_DOWN: 'TREND_UP', DISTRIBUTION: 'ACCUMULATION' });
const UINT32 = 4294967296;

/**
 * PRNG mulberry32 berbenih — BUKAN untuk kriptografi; hanya agar data sintetis deterministik.
 * Benih string di-hash (FNV-1a) sehingga 'BTC' dan 1 sama-sama valid.
 * @param {number|string} seed
 * @returns {() => number} angka semu di [0, 1)
 */
export function createRng(seed) {
  let a = seedToUint32(seed);
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

/** Benih → uint32. Angka dibulatkan ke bawah; string di-hash FNV-1a. */
function seedToUint32(seed) {
  if (typeof seed === 'string') {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }
  if (typeof seed !== 'number' || !Number.isFinite(seed)) throw new TypeError('seed harus angka hingga atau string');
  return Math.floor(seed) >>> 0;
}

/**
 * Benih turunan deterministik (mis. per simbol) dari benih induk dan indeks.
 * @param {number|string} seed
 * @param {number} index
 * @returns {number} uint32
 */
export function deriveSeed(seed, index) {
  let h = (seedToUint32(seed) ^ Math.imul((index + 1) >>> 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Sampel normal baku N(0,1) dengan Box-Muller (memakai dua angka dari rng).
 * @param {() => number} rng
 */
export function normal(rng) {
  const u1 = 1 - rng(); // (0, 1] agar log tidak −Infinity
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

function assertTimeframe(timeframe) {
  if (!Object.hasOwn(TIMEFRAME_MS, timeframe)) throw new RangeError(`Timeframe tidak dikenal: ${String(timeframe)}`);
}

function assertSegment(seg) {
  if (typeof seg !== 'object' || seg === null || !REGIME_TYPES.includes(seg.type)) {
    throw new RangeError(`Rezim tidak dikenal: ${String(seg?.type)}`);
  }
  if (!Number.isInteger(seg.bars) || seg.bars < 1) throw new RangeError(`bars rezim ${seg.type} harus bilangan bulat ≥ 1`);
}

/** Normalisasi bobot mix → [[type, kumulatif]]. Menerima objek bobot atau array tipe (bobot sama). */
function mixTable(mix) {
  const weights = Array.isArray(mix) ? Object.fromEntries(mix.map((t) => [t, 1])) : mix;
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  for (const [t] of entries) if (!REGIME_TYPES.includes(t)) throw new RangeError(`Rezim tidak dikenal di mix: ${t}`);
  if (entries.length === 0) throw new RangeError('mix harus memuat minimal satu rezim berbobot > 0');
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let acc = 0;
  return entries.map(([t, w]) => [t, (acc += w / total)]);
}

function pickType(rng, table) {
  const u = rng();
  for (const [t, c] of table) if (u < c) return t;
  return table.at(-1)[0];
}

/**
 * Rencana rezim acak sepanjang ≥ total candle. Selalu diawali RANDOM_WALK 100–160 candle agar
 * baseline volume/ATR detektor tersedia sebelum pola pertama.
 */
function randomPlan(rng, total, mix) {
  const table = mixTable(mix);
  const plan = [{ type: 'RANDOM_WALK', bars: randInt(rng, 100, 160) }];
  let length = plan[0].bars;
  while (length < total) {
    const type = pickType(rng, table);
    const seg = type === 'ACCUMULATION' || type === 'DISTRIBUTION'
      ? { type, bars: randInt(rng, 60, 100), markupBars: randInt(rng, 20, 40) }
      : { type, bars: randInt(rng, 60, 240) };
    plan.push(seg);
    length += seg.bars + (seg.markupBars ?? 0);
  }
  return plan;
}

/**
 * Bentangkan rencana: ACCUMULATION/DISTRIBUTION diikuti markup/markdown otomatis (TREND_UP/TREND_DOWN
 * kuat, `auto: true`) kecuali markupBars = 0.
 */
function expandPlan(plan) {
  const out = [];
  for (const seg of plan) {
    assertSegment(seg);
    const { markupBars = DEFAULT_MARKUP_BARS, ...rest } = seg;
    out.push({ ...rest });
    if ((seg.type === 'ACCUMULATION' || seg.type === 'DISTRIBUTION') && markupBars > 0) {
      if (!Number.isInteger(markupBars)) throw new RangeError('markupBars harus bilangan bulat ≥ 0');
      out.push({ type: seg.type === 'ACCUMULATION' ? 'TREND_UP' : 'TREND_DOWN', bars: markupBars, markup: true, auto: true });
    }
  }
  return out;
}

/** Sisipkan segmen tanam pada indeks candle `at` (memecah segmen yang dilaluinya). */
function insertPlanted(segments, plantSeg) {
  const { at } = plantSeg;
  if (!Number.isInteger(at) || at < 0) throw new RangeError('plant.at harus bilangan bulat ≥ 0');
  const out = [];
  let pos = 0;
  let inserted = false;
  for (const seg of segments) {
    if (!inserted && at >= pos && at < pos + seg.bars) {
      const head = at - pos;
      if (head > 0) out.push({ ...seg, bars: head });
      out.push(...plantSeg.expanded);
      if (seg.bars - head > 0) out.push({ ...seg, bars: seg.bars - head });
      inserted = true;
    } else {
      out.push(seg);
    }
    pos += seg.bars;
  }
  if (!inserted) out.push(...plantSeg.expanded);
  return out;
}

/**
 * Langkah satu candle untuk rezim "naik" (versi tidak dicerminkan). Mengembalikan log-return,
 * wick atas/bawah (log), pengali volume, dan dasar rasio taker buy.
 */
function stepBar(seg, j, ctx) {
  const { rng, sigmaScale, driftScale } = ctx;
  const z = normal(rng);
  const type = MIRROR_OF[seg.type] ?? seg.type;
  if (type === 'ACCUMULATION') {
    const p = REGIME_PARAMS.ACCUMULATION;
    const cycleLen = p.up + p.down;
    const dir = j % cycleLen < p.up ? 1 : -1;
    const sigma = p.sigma * sigmaScale;
    const quietBars = Math.round(seg.bars * p.quietShare);
    let volume;
    if (j < quietBars) volume = p.quietVolume;
    else {
      const rampBars = seg.bars - quietBars;
      volume = p.rampFrom + (rampBars > 1 ? ((p.rampTo - p.rampFrom) * (j - quietBars)) / (rampBars - 1) : 0);
    }
    return {
      ret: dir * p.step * driftScale + sigma * z,
      z,
      upWick: Math.abs(normal(rng)) * sigma,
      downWick: Math.abs(normal(rng)) * sigma,
      volume,
      volumeSigma: p.volumeSigma,
      taker: p.taker,
      volumeShock: false,
    };
  }
  const p = type === 'TREND_UP' && seg.markup ? REGIME_PARAMS.MARKUP : REGIME_PARAMS[type];
  const sigma = p.sigma * sigmaScale;
  let drift = (p.drift ?? 0) * driftScale;
  if (type === 'RANGE') drift = -p.kappa * (ctx.logPrice - ctx.segmentAnchor);
  return {
    ret: drift + sigma * z,
    z,
    upWick: Math.abs(normal(rng)) * sigma * 0.6,
    downWick: Math.abs(normal(rng)) * sigma * 0.6,
    volume: p.volume,
    volumeSigma: p.volumeSigma,
    taker: p.taker,
    volumeShock: true,
  };
}

/**
 * Bangkitkan deret candle sintetis berbenih.
 *
 * - `regimes = 'random'`: rezim dipilih acak (bobot `mix`) lalu dipotong tepat `bars` candle.
 * - `regimes = [{ type, bars, markupBars? }, ...]`: rezim berurutan; panjang = Σ bars (+ markup
 *   otomatis); `bars` diabaikan. ACCUMULATION/DISTRIBUTION diikuti markup/markdown otomatis
 *   `markupBars` candle (default 24; 0 = tanpa).
 * - `plant = [{ type, at, bars?, markupBars? }]`: sisipkan rezim pada indeks candle `at` (default
 *   bars 80 untuk ACCUMULATION/DISTRIBUTION, 120 untuk lainnya). Pada mode acak, segmen tanam ikut
 *   terpotong bila melewati `bars`.
 *
 * @param {{ symbol?: string, timeframe?: '5m'|'15m'|'1h', bars?: number, seed?: number|string,
 *   startTime?: number, startPrice?: number, baseVolume?: number,
 *   regimes?: 'random'|Array<{ type: string, bars: number, markupBars?: number }>,
 *   mix?: Record<string, number>|string[], plant?: object[], withMeta?: boolean }} [options]
 * @returns {object[]|{ candles: object[], segments: Array<{ type: string, startIndex: number,
 *   endIndex: number, auto: boolean, planted: boolean }> }} candle (atau { candles, segments } bila withMeta)
 */
export function generateSeries({
  symbol = 'SYNUSDT', timeframe = '15m', bars = 2000, seed = 1, startTime = Date.UTC(2025, 0, 1),
  startPrice = 100, baseVolume, regimes = 'random', mix = DEFAULT_MIX, plant = [], withMeta = false,
} = {}) {
  assertTimeframe(timeframe);
  if (!isAlignedOpenTime(startTime, timeframe)) throw new RangeError('startTime harus sejajar batas interval timeframe');
  if (!(startPrice > 0)) throw new RangeError('startPrice harus > 0');
  const randomMode = regimes === 'random';
  if (randomMode && (!Number.isInteger(bars) || bars < 1)) throw new RangeError('bars harus bilangan bulat ≥ 1');
  if (!randomMode && !Array.isArray(regimes)) throw new TypeError("regimes harus 'random' atau array rezim");

  const rng = createRng(seed);
  // Rencana dibuat dengan PRNG terpisah agar derau harga tidak bergeser bila rencana berubah.
  const planRng = createRng(deriveSeed(seed, 0x5eed));
  let segments = expandPlan(randomMode ? randomPlan(planRng, bars, mix) : regimes);
  // Urut naik: `at` = indeks candle FINAL (tanaman lebih awal menggeser yang lebih akhir).
  const plants = [...plant].sort((a, b) => a.at - b.at);
  for (const pl of plants) {
    const isPattern = pl.type === 'ACCUMULATION' || pl.type === 'DISTRIBUTION';
    const seg = { type: pl.type, bars: pl.bars ?? (isPattern ? 80 : 120), markupBars: pl.markupBars };
    if (seg.markupBars === undefined) delete seg.markupBars;
    const expanded = expandPlan([seg]).map((s) => ({ ...s, planted: true }));
    segments = insertPlanted(segments, { at: pl.at, expanded });
  }
  const total = randomMode ? bars : segments.reduce((a, s) => a + s.bars, 0);

  const interval = TIMEFRAME_MS[timeframe];
  const ratio = interval / TIMEFRAME_MS['15m'];
  const vol0 = baseVolume ?? 200_000 / startPrice; // ≈ 200 rb USDT per candle pada harga awal
  const ctx = { rng, sigmaScale: Math.sqrt(ratio), driftScale: ratio, logPrice: 0, segmentAnchor: 0 };
  const candles = new Array(total);
  const meta = [];
  let i = 0;
  for (const seg of segments) {
    if (i >= total) break;
    const n = Math.min(seg.bars, total - i);
    meta.push({ type: seg.type, startIndex: i, endIndex: i + n - 1, auto: seg.auto === true, planted: seg.planted === true });
    const mirrored = Object.hasOwn(MIRROR_OF, seg.type);
    // Pusat RANGE = log-harga awal segmen (dalam ruang cermin bila perlu, di sini RANGE tak dicerminkan).
    ctx.segmentAnchor = ctx.logPrice;
    for (let j = 0; j < n; j += 1, i += 1) {
      const s = stepBar(seg, j, ctx);
      const ret = mirrored ? -s.ret : s.ret;
      const upWick = mirrored ? s.downWick : s.upWick;
      const downWick = mirrored ? s.upWick : s.downWick;
      const takerBase = mirrored ? 1 - s.taker : s.taker;
      const shock = mirrored ? -s.z : s.z;

      const logOpen = ctx.logPrice;
      const logClose = logOpen + ret;
      ctx.logPrice = logClose;
      const open = startPrice * Math.exp(logOpen);
      const close = startPrice * Math.exp(logClose);
      const high = startPrice * Math.exp(Math.max(logOpen, logClose) + upWick);
      const low = startPrice * Math.exp(Math.min(logOpen, logClose) - downWick);

      const vs = s.volumeSigma;
      const activity = s.volumeShock ? 1 + 0.25 * Math.min(3, Math.abs(s.z)) : 1;
      const volume = vol0 * s.volume * activity * Math.exp(vs * normal(rng) - (vs * vs) / 2);
      const takerShare = clamp(takerBase + 0.03 * shock + 0.03 * normal(rng), 0.02, 0.98);
      const vwap = (open + high + low + close) / 4;
      const quoteVolume = volume * vwap;
      const takerBuyVolume = volume * takerShare;
      const openTime = startTime + i * interval;
      candles[i] = {
        symbol,
        timeframe,
        openTime,
        closeTime: openTime + interval - 1,
        open,
        high,
        low,
        close,
        volume,
        quoteVolume,
        trades: Math.max(1, Math.round((quoteVolume / 400) * Math.exp(0.1 * normal(rng)))),
        takerBuyVolume,
        takerBuyQuoteVolume: takerBuyVolume * vwap,
        isClosed: true,
        source: 'rest',
      };
    }
  }
  return withMeta ? { candles, segments: meta } : candles;
}

/**
 * Semesta sintetis: banyak simbol dengan benih turunan (seri berbeda per simbol), harga awal
 * tersebar log-uniform 0,01..1000 agar robust terhadap skala harga.
 * @param {{ symbols?: number|string[], bars?: number, seed?: number|string, mix?: object,
 *   timeframe?: '5m'|'15m'|'1h', startTime?: number }} [options]
 * @returns {Map<string, object[]>} simbol → candle
 */
export function generateUniverse({ symbols = 20, bars = 2000, seed = 1, mix = DEFAULT_MIX, timeframe = '15m', startTime } = {}) {
  const names = Array.isArray(symbols)
    ? symbols
    : Array.from({ length: symbols }, (_, i) => `SYN${String(i).padStart(2, '0')}USDT`);
  const universe = new Map();
  names.forEach((symbol, i) => {
    const s = deriveSeed(seed, i);
    const startPrice = Number((10 ** (-2 + 5 * createRng(deriveSeed(s, 1))())).toPrecision(6));
    universe.set(symbol, generateSeries({ symbol, timeframe, bars, seed: s, mix, startPrice, ...(startTime === undefined ? {} : { startTime }) }));
  });
  return universe;
}

/**
 * Agregasi candle timeframe kecil → timeframe lebih besar (mis. 15m → 1h). Hanya grup LENGKAP
 * (semua candle penyusun ada, berurutan tanpa gap) dan tertutup yang dihasilkan, sehingga tidak
 * ada lookahead: candle 1h baru ada setelah candle 15m terakhirnya tertutup.
 * OHLC: open pertama, high maks, low min, close terakhir; Σ volume/quoteVolume/trades/taker.
 * @param {object[]} candles candle satu simbol & timeframe, urut naik
 * @param {'5m'|'15m'|'1h'} targetTimeframe
 * @returns {object[]}
 */
export function aggregateCandles(candles, targetTimeframe) {
  if (!Array.isArray(candles)) throw new TypeError('candles harus berupa array');
  assertTimeframe(targetTimeframe);
  if (candles.length === 0) return [];
  const source = candles[0].timeframe;
  assertTimeframe(source);
  const srcMs = TIMEFRAME_MS[source];
  const dstMs = TIMEFRAME_MS[targetTimeframe];
  if (dstMs < srcMs || dstMs % srcMs !== 0) throw new RangeError(`Tidak dapat mengagregasi ${source} → ${targetTimeframe}`);
  const per = dstMs / srcMs;
  const out = [];
  let i = 0;
  while (i < candles.length) {
    const groupStart = Math.floor(candles[i].openTime / dstMs) * dstMs;
    let j = i;
    while (j < candles.length && Math.floor(candles[j].openTime / dstMs) * dstMs === groupStart) j += 1;
    const group = candles.slice(i, j);
    const complete = group.length === per
      && group.every((c, k) => c.isClosed === true && c.openTime === groupStart + k * srcMs);
    if (complete) {
      const first = group[0];
      const last = group.at(-1);
      const sum = (key) => group.reduce((a, c) => a + (c[key] ?? 0), 0);
      out.push({
        symbol: first.symbol,
        timeframe: targetTimeframe,
        openTime: groupStart,
        closeTime: groupStart + dstMs - 1,
        open: first.open,
        high: Math.max(...group.map((c) => c.high)),
        low: Math.min(...group.map((c) => c.low)),
        close: last.close,
        volume: sum('volume'),
        quoteVolume: sum('quoteVolume'),
        trades: sum('trades'),
        takerBuyVolume: sum('takerBuyVolume'),
        takerBuyQuoteVolume: sum('takerBuyQuoteVolume'),
        isClosed: true,
        source: group.every((c) => c.source === 'rest') ? 'rest' : last.source,
      });
    }
    i = j;
  }
  return out;
}

/**
 * Cermin deret (harga p → 1/p, high ↔ low; lihat backend/patterns/mirror.js) dengan sisi taker
 * ikut ditukar (taker buy ↔ taker sell). Berguna untuk uji simetri LONG/SHORT: akumulasi pada seri
 * asli menjadi distribusi pada seri cermin. quoteVolume dibiarkan apa adanya (sama seperti mirror.js).
 * @param {object[]} candles
 * @returns {object[]}
 */
export function mirrorSeries(candles) {
  return mirrorCandles(candles).map((c, k) => {
    const orig = candles[k];
    return {
      ...c,
      takerBuyVolume: Math.max(0, orig.volume - orig.takerBuyVolume),
      takerBuyQuoteVolume: Math.max(0, orig.quoteVolume - orig.takerBuyQuoteVolume),
    };
  });
}
