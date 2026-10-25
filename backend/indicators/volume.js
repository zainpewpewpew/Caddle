import { assertPeriod } from './ema.js';

/**
 * Relative volume: volume[i] / rata-rata volume `period` candle SEBELUMNYA (tidak termasuk i).
 * null bila data kurang atau baseline nol (hindari pembagian nol pada candle volume nol).
 * @param {number[]} volumes
 */
export function rvol(volumes, period = 20) {
  assertPeriod(period);
  const out = new Array(volumes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < volumes.length; i += 1) {
    if (i >= period) {
      const baseline = sum / period;
      out[i] = baseline > 0 ? volumes[i] / baseline : null;
      sum -= volumes[i - period];
    }
    sum += volumes[i];
  }
  return out;
}

/**
 * Rasio dominasi lonjakan: volume maksimum di jendela dibagi total jendela.
 * Mendekati 1 berarti satu candle mendominasi (anomali), 1/n berarti merata.
 */
export function spikeDominance(volumes, window) {
  assertPeriod(window);
  if (volumes.length < window) return null;
  const slice = volumes.slice(-window);
  const total = slice.reduce((a, b) => a + b, 0);
  return total > 0 ? Math.max(...slice) / total : null;
}
