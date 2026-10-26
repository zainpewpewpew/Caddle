// Helper skenario SINTETIS untuk tes mesin Reversal Radar (bukan data pasar nyata) — memakai generator
// deterministik tests/fixtures/candles/synthetic.js. Fixture skenario lengkap untuk replay (agent D) berada di
// tests/fixtures/candles/reversalScenarios.js; helper ini hanya untuk tes unit mesin.
import { evaluateReversal } from '../../../backend/reversal/detector.js';
import { transitionReversal } from '../../../backend/reversal/stateMachine.js';
import { generateCandles } from '../../fixtures/candles/synthetic.js';

const repeat = (value, n) => Array.from({ length: n }, () => value);
/** Siklus zig-zag: `up` candle naik `upStep`, lalu `down` candle turun `downStep`. */
export const zigzag = (up, upStep, down, downStep) => [...repeat(upStep, up), ...repeat(-downStep, down)];

const sideways = (bars, volume) => ({ bars, cycle: zigzag(3, 0.002, 3, 0.002), volume, volumeNoise: 0.15 });

/**
 * Reversal "ideal": sideways → penurunan bertahap bervolume (lower low) → penurunan melambat & volume mengering →
 * dasar datar → naik pelan dengan higher low → breakout bervolume. Dasar berada di sekitar indeks 124–130.
 * Panjang 192 candle (≥ warm-up 120 + konteks).
 */
export const REVERSAL_SEGMENTS = Object.freeze([
  sideways(60, 1000),
  { bars: 40, drift: -0.0035, cycle: zigzag(2, 0.002, 4, 0.002), wick: 0.002, volume: 1400, volumeEnd: 1200 },
  { bars: 24, drift: -0.0015, cycle: zigzag(3, 0.0015, 3, 0.0015), wick: 0.002, volume: 1100, volumeEnd: 700 },
  { bars: 24, drift: 0, cycle: zigzag(3, 0.001, 3, 0.001), wick: 0.0015, volume: 600, volumeEnd: 450 },
  { bars: 24, drift: 0.0012, cycle: zigzag(4, 0.0015, 3, 0.0015), wick: 0.0015, volume: 450, volumeEnd: 600 },
  { bars: 20, drift: 0.004, cycle: zigzag(4, 0.002, 2, 0.001), wick: 0.002, volume: 900, volumeEnd: 1500 },
]);

export function reversalCandles(seed = 1, { timeframe = '5m', extraBars = 0 } = {}) {
  const segments = extraBars > 0
    ? [...REVERSAL_SEGMENTS, { bars: extraBars, drift: 0.0005, cycle: zigzag(4, 0.0015, 3, 0.0015), wick: 0.002, volume: 1200 }]
    : REVERSAL_SEGMENTS;
  return generateCandles({ seed, timeframe, segments });
}

/** Downtrend yang terus berlanjut dengan pantulan beberapa candle (dasar sempat berumur ≥ 3 candle). */
export function continuedDowntrendCandles(seed = 1, { timeframe = '5m' } = {}) {
  return generateCandles({ seed, timeframe, segments: [sideways(60, 1000), { bars: 140, drift: -0.002, cycle: zigzag(5, 0.0025, 7, 0.0035), wick: 0.002, volume: 1200, volumeEnd: 900 }] });
}

/** Uptrend yang berlanjut (higher low teratur) tanpa penurunan awal → CONTINUATION. */
export function uptrendCandles(seed = 1, { timeframe = '5m' } = {}) {
  return generateCandles({ seed, timeframe, segments: [sideways(60, 1000), { bars: 140, drift: 0.002, cycle: zigzag(4, 0.0015, 3, 0.0015), wick: 0.002, volume: 1000 }] });
}

/** Sideways datar bervolume stabil (tanpa penurunan awal, EMA25 datar). */
export function flatCandles(seed = 1, { timeframe = '5m', bars = 200 } = {}) {
  return generateCandles({ seed, timeframe, segments: [sideways(bars, 1000)] });
}

/**
 * Replay berurutan: evaluasi prefiks candles.slice(0, k+1) lalu transisi state machine untuk tiap k ≥ from.
 * @returns {Array<{ k: number, evaluation: object, snapshot: object, events: object[], alert: boolean }>}
 */
export function replay(candles, { timeframe = '5m', from = 0, higher = {}, liquidity, params } = {}) {
  let snapshot = null;
  const out = [];
  for (let k = from; k < candles.length; k += 1) {
    const evaluation = evaluateReversal({ candles: candles.slice(0, k + 1), timeframe, higher, liquidity, params });
    const t = transitionReversal(snapshot, { candle: candles[k], evaluation, timeframe }, params);
    snapshot = t.next;
    out.push({ k, evaluation, snapshot, events: t.events, alert: t.alert });
  }
  return out;
}

/** Indeks pertama (≥ from) yang evaluasinya memenuhi predikat; −1 bila tidak ada. */
export function firstIndex(steps, predicate) {
  const hit = steps.find((s) => predicate(s.evaluation, s));
  return hit ? hit.k : -1;
}
