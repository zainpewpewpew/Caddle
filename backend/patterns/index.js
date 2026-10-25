// Mesin pola Milestone 3: SA (#001) & PVA (#002). Fungsi murni — dipakai bersama worker live
// dan backtest. Skor adalah skor aturan yang dapat dijelaskan, bukan probabilitas.
export {
  DEFAULT_PVA_PARAMS,
  DEFAULT_SA_PARAMS,
  MAX_WARMUP_CANDLES,
  PARAM_SPECS,
  PatternParamsError,
  requiredCandles,
  resolveParams,
  validateParams,
} from './params.js';
export { EARLY_SCORE, GATE_CONDITIONS, PATTERN_VERSION } from './conditions.js';
export { SA_CONDITIONS, detectSilentAccumulation } from './silentAccumulation.js';
export { PVA_CONDITIONS, detectProgressiveVolume } from './progressiveVolume.js';
export { classify, evaluatePatterns } from './evaluate.js';
