// Vektor fitur meta-labeling untuk satu entri sinyal (lihat docs/16-riset-machine-learning.md).
// Fungsi murni: hanya memakai data yang sudah tersedia SAAT entri — view/konfluensi hasil analyzeDirectionsAt pada
// candle sinyal, fitur v3 (extractFeatures) dari candle ≤ candle sinyal, dan harga entri/stop. Tidak ada candle
// sesudah entri yang dibaca, sehingga fitur ini sama persis dengan yang akan dihitung live (diuji tanpa lookahead).
// Semua besaran bertanda dikali d (+1 LONG, −1 SHORT) agar "positif = searah", sama seperti skor konfluensi.
// Nilai yang tidak tersedia = NaN; model (logistic.js / gbdt.js) mengimputasinya dengan statistik data TRAIN.
import { atr } from '../indicators/atr.js';
import { TIERS } from '../scoring/confluence.js';

export const META_FEATURES_VERSION = 1;

const COMPONENTS = Object.freeze(['pattern', 'htf', 'structure', 'orderFlow', 'regime', 'liquidity']);
const STATE_STAGE = Object.freeze({ EARLY_BULLISH: 0, EARLY_BEARISH: 0, MOMENTUM_BUILDING: 1, BREAKOUT: 2, BREAKDOWN: 2 });

/** Nama fitur, urutan tetap (indeks vektor). Mengubah daftar ini wajib menaikkan META_FEATURES_VERSION. */
export const META_FEATURE_NAMES = Object.freeze([
  'confluenceScore', ...COMPONENTS.map((c) => `component_${c}`), 'vetoCount', 'tierRank', 'patternScore', 'earlyScore',
  'isShort', 'tf5m', 'tf15m', 'stateStage',
  'adx', 'efficiencyRatio', 'bandwidthPercentile', 'choppiness',
  'flowBias', 'cvdSlope', 'takerImbalance', 'structureScore', 'rangePosition',
  'riskAtr', 'return12Atr', 'return48Atr', 'relativeVolume', 'hourSin', 'hourCos', 'weekend',
]);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const or = (v) => (isNum(v) ? v : NaN);
const signed = (v, d) => (isNum(v) ? v * d : NaN);

/**
 * @param {{ direction: 'LONG'|'SHORT', timeframe: string, state?: string, view?: object|null, features?: object|null,
 *   candles: import('../market/contracts.js').Candle[], entryPrice: number, stopPrice: number, entryTime: number }} input
 *   candles: seri dasar dengan candle sinyal sebagai elemen TERAKHIR.
 * @returns {number[]} panjang META_FEATURE_NAMES.length
 */
export function metaFeatures({ direction, timeframe, state, view, features, candles, entryPrice, stopPrice, entryTime }) {
  if (direction !== 'LONG' && direction !== 'SHORT') throw new RangeError(`Arah tidak dikenal: ${String(direction)}`);
  if (!Array.isArray(candles) || candles.length === 0) throw new TypeError('candles wajib array tidak kosong');
  const d = direction === 'SHORT' ? -1 : 1;
  const c = view?.confluence ?? null;
  const byId = Object.fromEntries((c?.components ?? []).map((k) => [k.id, k.value]));
  const tierIndex = c?.tier ? TIERS.indexOf(c.tier) : -1;
  const s = features?.structure ?? null;
  const f = features?.orderFlow ?? null;
  const r = features?.regime ?? null;
  const l = features?.liquidity ?? null;

  const last = candles.length - 1;
  const atrNow = atr(candles, 14)[last];
  const close = candles[last].close;
  const backReturn = (bars) => (last >= bars && isNum(atrNow) && atrNow > 0 ? (d * (close - candles[last - bars].close)) / atrNow : NaN);
  const volWindow = candles.slice(Math.max(0, last - 20), last).map((k) => k.volume).filter(isNum);
  const volMean = volWindow.length ? volWindow.reduce((a, v) => a + v, 0) / volWindow.length : NaN;
  const hour = isNum(entryTime) ? new Date(entryTime).getUTCHours() + new Date(entryTime).getUTCMinutes() / 60 : NaN;
  const day = isNum(entryTime) ? new Date(entryTime).getUTCDay() : NaN;
  const takerDir = isNum(f?.takerBuyRatio) ? (d > 0 ? f.takerBuyRatio : 1 - f.takerBuyRatio) - 0.5 : NaN;
  const position = isNum(l?.position) && l?.inRange === true ? (d > 0 ? l.position : 1 - l.position) : NaN;

  const vector = [
    isNum(c?.score) ? c.score / 100 : NaN,
    ...COMPONENTS.map((id) => or(byId[id])),
    Array.isArray(c?.vetoes) ? c.vetoes.length : NaN,
    tierIndex >= 0 ? TIERS.length - tierIndex : NaN,
    isNum(view?.patternScore) ? view.patternScore / 100 : NaN,
    isNum(view?.earlyScore) ? view.earlyScore / 100 : NaN,
    d < 0 ? 1 : 0,
    timeframe === '5m' ? 1 : 0,
    timeframe === '15m' ? 1 : 0,
    Object.hasOwn(STATE_STAGE, state ?? '') ? STATE_STAGE[state] : NaN,
    isNum(r?.adx) ? r.adx / 100 : NaN,
    or(r?.efficiencyRatio),
    or(r?.bandwidthPercentile),
    isNum(r?.chop) ? r.chop / 100 : NaN,
    signed(f?.flowBias, d),
    signed(f?.cvdSlope, d),
    takerDir,
    signed(s?.structureScore, d),
    position,
    isNum(atrNow) && atrNow > 0 && isNum(entryPrice) && isNum(stopPrice) ? Math.abs(entryPrice - stopPrice) / atrNow : NaN,
    backReturn(12),
    backReturn(48),
    isNum(volMean) && volMean > 0 && isNum(candles[last].volume) ? candles[last].volume / volMean : NaN,
    isNum(hour) ? Math.sin((2 * Math.PI * hour) / 24) : NaN,
    isNum(hour) ? Math.cos((2 * Math.PI * hour) / 24) : NaN,
    isNum(day) ? (day === 0 || day === 6 ? 1 : 0) : NaN,
  ];
  return vector;
}
