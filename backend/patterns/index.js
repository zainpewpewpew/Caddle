// Mesin pola Milestone 3: SA (#001) & PVA (#002) untuk LONG, SD (#003) & PVD (#004) untuk SHORT
// (cermin SA/PVA). Fungsi murni — dipakai bersama worker live dan backtest. Skor adalah skor aturan
// yang dapat dijelaskan, bukan probabilitas.
export {
  DEFAULT_PVA_PARAMS,
  DEFAULT_PVD_PARAMS,
  DEFAULT_SA_PARAMS,
  DEFAULT_SD_PARAMS,
  MAX_WARMUP_CANDLES,
  MIRROR_BASE,
  PARAM_SPECS,
  PatternParamsError,
  requiredCandles,
  resolveParams,
  toMirrorBaseParams,
  validateParams,
} from './params.js';
export { EARLY_SCORE, GATE_CONDITIONS, PATTERN_VERSION } from './conditions.js';
export { SA_CONDITIONS, detectSilentAccumulation } from './silentAccumulation.js';
export { PVA_CONDITIONS, detectProgressiveVolume } from './progressiveVolume.js';
export { SD_CONDITIONS, detectSilentDistribution } from './silentDistribution.js';
export { PVD_CONDITIONS, detectProgressiveDistribution } from './progressiveDistribution.js';
export { MIRRORED_LONG_VERSION, SHORT_PATTERN_VERSION, mirrorCandles, realChangeOf, unmirrorPrice } from './mirror.js';
export { classify, classifyShort, evaluatePatterns, evaluatePatternsFor, evaluateShortPatterns } from './evaluate.js';
