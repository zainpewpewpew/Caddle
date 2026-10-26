// Sinyal: state machine murni + repositori persistensi (signals, signal_events).
export {
  ALERT_STATES, ALERT_STATES_BY_DIRECTION, DEFAULT_MARKET_PARAMS, DEFAULT_SIGNAL_PARAMS, LONG_PATTERN_STATES, MONITORING_STOP_REASONS,
  PATTERN_STATES, PATTERN_STATES_BY_DIRECTION, SHORT_ALERT_STATES, SHORT_PATTERN_STATES, STATE_RANK,
  resolveMarketParams, resolveSignalParams,
} from './params.js';
export { deriveDirectionalMarketInputs, deriveMarketInputs, isTerminal, transition } from './stateMachine.js';
export { SignalRepositoryError, createSignalRepository } from './signalRepository.js';
