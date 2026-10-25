// Skenario pasar SINTETIS untuk tes SA/PVA — fixture sintetis, bukan data pasar nyata.
// Setiap skenario deterministik untuk seed yang sama. Panjang segmen terakhir dipilih agar
// candle terakhir jatuh pada fase yang jelas (mis. 4 candle setelah swing low), sehingga hasil
// tidak bergantung pada kebetulan derau.
import { generateCandles } from './synthetic.js';

const repeat = (value, n) => Array.from({ length: n }, () => value);
/** Siklus zig-zag: `up` candle naik sebesar `upStep`, lalu `down` candle turun sebesar `downStep`. */
export const zigzag = (up, upStep, down, downStep) => [...repeat(upStep, up), ...repeat(-downStep, down)];

// Fase sideways bervolume normal sebagai baseline RVOL (net nol per siklus).
const sideways = (bars, volume) => ({ bars, cycle: zigzag(3, 0.002, 3, 0.002), volume, volumeNoise: 0.15 });
// Fase naik bertahap: 5 candle naik 0,15%, 3 candle turun 0,15% → higher low tiap 8 candle.
const gradualUp = (bars, volume, volumeEnd = volume) => ({ bars, cycle: zigzag(5, 0.0015, 3, 0.0015), wick: 0.002, volume, volumeEnd, volumeNoise: 0.1 });

/** Akumulasi senyap: baseline normal → harga naik pelan dengan higher low, volume ~45% baseline. */
export function silentAccumulationCandles(seed = 1) {
  return generateCandles({ seed, segments: [sideways(48, 1000), gradualUp(28, 450)] });
}

/** Volume progresif: baseline normal → jeda sepi singkat → harga naik bertahap, volume naik 600 → 1700. */
export function progressiveVolumeCandles(seed = 1) {
  return generateCandles({ seed, segments: [sideways(48, 1000), gradualUp(12, 600), gradualUp(20, 600, 1700)] });
}

/**
 * Keduanya: volume baseline tinggi → sepi panjang → volume naik progresif tetapi masih di bawah
 * baseline lama, harga naik pelan dengan higher low.
 */
export function bothPatternsCandles(seed = 1) {
  return generateCandles({ seed, segments: [sideways(48, 3000), gradualUp(12, 450), gradualUp(20, 450, 1000)] });
}

/** Harga datar sempurna (close konstan, hanya wick) dengan volume `volume` → `volumeEnd`. */
export function flatCandles(seed = 1, { volume = 1000, volumeEnd = volume, bars = 100 } = {}) {
  return generateCandles({ seed, segments: [{ bars: bars - 20, volume: 1000 }, { bars: 20, volume, volumeEnd }].map((s) => ({ ...s, noise: 0, wick: 0.001, volumeNoise: 0.1 })) });
}

/** Downtrend: harga turun bertahap (lower low) dengan volume sepi. */
export function downtrendCandles(seed = 1) {
  return generateCandles({ seed, segments: [sideways(48, 1000), { bars: 32, cycle: zigzag(3, 0.0015, 5, 0.0015), volume: 450 }] });
}

/** Volatilitas ekstrem: pola akumulasi senyap, lalu candle-candle dengan range ±8%. */
export function extremeVolatilityCandles(seed = 1) {
  return generateCandles({ seed, segments: [sideways(48, 1000), gradualUp(12, 450), { bars: 16, cycle: zigzag(1, 0.08, 1, 0.07), wick: 0.03, volume: 450 }] });
}
