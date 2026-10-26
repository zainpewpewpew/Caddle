// Pelabelan trade metode triple barrier (López de Prado, "Advances in Financial ML", bab 3).
// Tiga penghalang: stop (bawah untuk LONG), target = entry ± targetR·risk, dan batas waktu maxBars.
// Fungsi murni; hanya membaca candle SETELAH entryIndex (entry = close candle sinyal).

export const LABEL_OUTCOMES = Object.freeze(['WIN', 'LOSS', 'TIMEOUT', 'OPEN']);

export const LABEL_DEFAULTS = Object.freeze({ targetR: 2, maxBars: 48, feeBps: 4, slippageBps: 2 });

const isPositive = (v) => Number.isFinite(v) && v > 0;

/**
 * Melabeli satu trade hipotetis.
 *
 * Aturan (konservatif, didokumentasikan):
 * - risk = |entry − stop|; stop harus di sisi yang benar (LONG: stop < entry, SHORT: stop > entry), selain itu null.
 * - Dievaluasi mulai candle entryIndex+1. Urutan intrabar tidak diketahui, sehingga:
 *   - bila open sudah melewati stop (gap) → keluar di open (lebih buruk dari stop), LOSS;
 *   - bila stop DAN target sama-sama tersentuh di candle yang sama → dianggap stop lebih dulu → LOSS;
 *   - target tersentuh (termasuk gap melewati target) → keluar tepat di harga target (gap positif tidak dihitung).
 * - Tanpa penghalang tersentuh sampai candle entryIndex+maxBars → TIMEOUT di close candle itu.
 *   Bila data habis sebelum itu → 'OPEN' (nilai mark-to-market di close terakhir; dikecualikan dari metrik).
 * - rMultiple neto: R kotor dikurangi biaya dua sisi (fee + slippage dalam bps dari notional entry & exit),
 *   dinyatakan dalam R: costR = (feeBps+slippageBps)/1e4 · (entry + exit) / risk.
 * - mfeR (≥ 0) / maeR (≤ 0) = ekskursi harga terbaik/terburuk selama trade dalam R kotor. Pada candle keluar
 *   LOSS ekskursi menguntungkan diabaikan (urutan intrabar ambigu) dan MAE minimal sebesar harga keluar;
 *   pada candle WIN MFE = targetR.
 *
 * @param {object} args
 * @param {object[]} args.candles
 * @param {number} args.entryIndex         indeks candle sinyal
 * @param {'LONG'|'SHORT'} args.direction
 * @param {number} args.entryPrice
 * @param {number} args.stopPrice
 * @param {number} [args.targetR=2]
 * @param {number} [args.maxBars=48]
 * @param {number} [args.feeBps=4]         per sisi
 * @param {number} [args.slippageBps=2]    per sisi
 * @returns {null | {
 *   outcome: 'WIN'|'LOSS'|'TIMEOUT'|'OPEN', direction: string, entryIndex: number, entryPrice: number,
 *   stopPrice: number, targetPrice: number, risk: number, exitIndex: number, exitPrice: number,
 *   exitTime: number|null, grossR: number, costR: number, rMultiple: number, mfeR: number, maeR: number,
 *   barsHeld: number, gap: boolean }}
 */
export function labelTrade({
  candles,
  entryIndex,
  direction,
  entryPrice,
  stopPrice,
  targetR = LABEL_DEFAULTS.targetR,
  maxBars = LABEL_DEFAULTS.maxBars,
  feeBps = LABEL_DEFAULTS.feeBps,
  slippageBps = LABEL_DEFAULTS.slippageBps,
} = {}) {
  if (!Array.isArray(candles)) return null;
  if (!Number.isInteger(entryIndex) || entryIndex < 0 || entryIndex >= candles.length) return null;
  if (direction !== 'LONG' && direction !== 'SHORT') return null;
  if (!isPositive(entryPrice) || !isPositive(stopPrice) || !isPositive(targetR)) return null;
  if (!Number.isInteger(maxBars) || maxBars < 1) return null;
  if (!(Number.isFinite(feeBps) && feeBps >= 0 && Number.isFinite(slippageBps) && slippageBps >= 0)) return null;

  const sign = direction === 'LONG' ? 1 : -1;
  const risk = Math.abs(entryPrice - stopPrice);
  // Stop harus di bawah entry untuk LONG dan di atas entry untuk SHORT.
  if (!(risk > 0) || sign * (entryPrice - stopPrice) <= 0) return null;
  const targetPrice = entryPrice + sign * targetR * risk;

  /** R kotor bila keluar di harga p. */
  const rAt = (p) => (sign * (p - entryPrice)) / risk;
  const costRate = (feeBps + slippageBps) / 10_000;

  let mfeR = 0;
  let maeR = 0;
  let outcome = null;
  let exitIndex = entryIndex;
  let exitPrice = candles[entryIndex].close;
  let gap = false;

  const lastIndex = Math.min(candles.length - 1, entryIndex + maxBars);
  for (let i = entryIndex + 1; i <= lastIndex; i += 1) {
    const c = candles[i];
    // Ekstrem menguntungkan/merugikan sesuai arah.
    const favorable = sign === 1 ? c.high : c.low;
    const adverse = sign === 1 ? c.low : c.high;
    const stopHit = sign * (adverse - stopPrice) <= 0;
    const targetHit = sign * (favorable - targetPrice) >= 0;
    exitIndex = i;

    if (stopHit) {
      // Gap: open sudah di luar stop → isi di open (lebih buruk). Juga mencakup TP & SL di candle yang sama.
      gap = sign * (c.open - stopPrice) <= 0;
      exitPrice = gap ? c.open : stopPrice;
      maeR = Math.min(maeR, rAt(exitPrice));
      outcome = 'LOSS';
      break;
    }
    maeR = Math.min(maeR, rAt(adverse));
    if (targetHit) {
      exitPrice = targetPrice;
      mfeR = Math.max(mfeR, targetR);
      outcome = 'WIN';
      break;
    }
    mfeR = Math.max(mfeR, rAt(favorable));
    exitPrice = c.close;
  }

  if (outcome === null) {
    outcome = exitIndex - entryIndex >= maxBars ? 'TIMEOUT' : 'OPEN';
  }

  const grossR = rAt(exitPrice);
  const costR = (costRate * (entryPrice + exitPrice)) / risk;
  const exitCandle = candles[exitIndex];
  return {
    outcome,
    direction,
    entryIndex,
    entryPrice,
    stopPrice,
    targetPrice,
    risk,
    exitIndex,
    exitPrice,
    exitTime: Number.isFinite(exitCandle?.closeTime) ? exitCandle.closeTime : null,
    grossR,
    costR,
    rMultiple: grossR - costR,
    mfeR,
    maeR,
    barsHeld: exitIndex - entryIndex,
    gap,
  };
}
