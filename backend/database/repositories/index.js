import { createReversalRepository } from '../../reversal/repository.js';
import { createSignalRepository } from '../../signals/signalRepository.js';
import { createSmartMoneyRepository } from '../../smartmoney/repository.js';
import { createAuditRepository } from './auditRepository.js';
import { createCandleRepository } from './candleRepository.js';
import { createIngestionStateRepository } from './ingestionStateRepository.js';
import { createOverviewRepository } from './overviewRepository.js';
import { createSessionRepository } from './sessionRepository.js';
import { createSettingsRepository } from './settingsRepository.js';
import { createSymbolRepository } from './symbolRepository.js';
import { createUserRepository } from './userRepository.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ clock?: () => number }} [options] jam untuk repositori candle, sinyal, reversal & smart money (default Date.now)
 */
export function createRepositories(db, { clock } = {}) {
  return {
    users: createUserRepository(db),
    sessions: createSessionRepository(db),
    settings: createSettingsRepository(db),
    audit: createAuditRepository(db),
    overview: createOverviewRepository(db),
    candles: createCandleRepository(db, clock ? { clock } : {}),
    symbols: createSymbolRepository(db),
    ingestion: createIngestionStateRepository(db),
    signals: createSignalRepository(db, clock ? { clock } : {}),
    // Reversal Radar (migrasi 008): kandidat reversal LONG Scanner, terpisah dari tabel sinyal SA/PVA.
    reversal: createReversalRepository(db, clock ? { clock } : {}),
    smartMoney: createSmartMoneyRepository(db, clock ? { clock } : {}),
  };
}
