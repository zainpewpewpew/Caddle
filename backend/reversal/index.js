// Titik masuk mesin Reversal Radar (docs/19). Semua modul di bawah ini fungsi murni tanpa I/O:
// konstanta kontrak, parameter, fitur per seri, detektor, dan state machine. Persistensi/pipeline/API
// (repository.js, pipeline.js, api/reversalRoutes.js) berada di luar modul ini.
export * from './constants.js';
export { DEFAULT_REVERSAL_PARAMS, MAX_REQUIRED_CANDLES, REVERSAL_MAP_SPECS, REVERSAL_PARAM_SPECS, requiredCandles, resolveReversalParams } from './params.js';
export { EVIDENCE_GROUP_LABELS, EVIDENCE_LABELS, cancelConditionOf, evaluateReversal, nextConfirmationOf } from './detector.js';
export { isTerminalStatus, transitionReversal } from './stateMachine.js';
export {
  analyzePriorDecline, atrContractionRatio, computeReversalSeries, downMomentum, emaDistanceAtr, findBottomIndex, findBottomRetest,
  findSpring, htfTrend, intactHigherLow, linearSlope, liquidityClassOf, lowerHighSinceBottom, lowerLowChain, quadraticFit, quietRise,
  rangeContraction, risingFloor, roundedBottomFit, rsiDivergenceAtBottom, staircaseSinceBottom, triggerLevelAt, volumeDryUp,
} from './features.js';
export { fmtAtr, fmtNum, fmtPct, fmtPrice } from './format.js';
