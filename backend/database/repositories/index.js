import { createAuditRepository } from './auditRepository.js';
import { createOverviewRepository } from './overviewRepository.js';
import { createSessionRepository } from './sessionRepository.js';
import { createSettingsRepository } from './settingsRepository.js';
import { createUserRepository } from './userRepository.js';

/** @param {import('better-sqlite3').Database} db */
export function createRepositories(db) {
  return {
    users: createUserRepository(db),
    sessions: createSessionRepository(db),
    settings: createSettingsRepository(db),
    audit: createAuditRepository(db),
    overview: createOverviewRepository(db),
  };
}
