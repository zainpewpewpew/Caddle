// Sinyal: state machine murni + repositori persistensi (signals, signal_events).
export {
  ALERT_STATES, DEFAULT_MARKET_PARAMS, DEFAULT_SIGNAL_PARAMS, MONITORING_STOP_REASONS, PATTERN_STATES, STATE_RANK,
  resolveMarketParams, resolveSignalParams,
} from './params.js';
export { deriveMarketInputs, isTerminal, transition } from './stateMachine.js';
export { SignalRepositoryError, createSignalRepository } from './signalRepository.js';
