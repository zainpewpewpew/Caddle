// Server khusus E2E: database sementara + dua pengguna uji. Tidak pernah dipakai di produksi.
// E2E_SEED_SIGNALS=1 mengisi sinyal dari pipeline asli atas candle SINTETIS (tests/fixtures/candles).
// Tombol scanner aktif (WORKER_CONTROL) tetapi menjalankan worker TIRUAN (tests/fixtures/worker-stub.js):
// E2E tidak pernah menghubungi Binance.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../backend/app/buildApp.js';
import { loadConfig } from '../../backend/app/config.js';
import { openDatabase } from '../../backend/database/connection.js';
import { createUser } from '../../backend/users/userAdmin.js';
import { seedSignals, seedWorkerHistory } from '../helpers/signalSeed.js';
import { E2E_PORT, E2E_USERS } from './fixtures.js';

const port = Number(process.env.E2E_SERVER_PORT ?? E2E_PORT);
const dbPath = join(mkdtempSync(join(tmpdir(), 'lr-e2e-')), 'e2e.db');
// Batas login dinaikkan khusus E2E: seluruh suite (desktop + mobile) memakai ~20 login per server
// dan tidak ada skenario E2E yang menguji rate limit (itu diuji di tests/security & tests/negative).
const config = loadConfig({
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: `http://127.0.0.1:${port}`,
  DATABASE_PATH: dbPath, LOG_LEVEL: 'warn', LOGIN_RATE_LIMIT_MAX: '60', WORKER_CONTROL: 'true',
});
const db = openDatabase(dbPath);
const workerScriptPath = fileURLToPath(new URL('../fixtures/worker-stub.js', import.meta.url));
const app = await buildApp({ config, db, workerScriptPath });
const { repos, hasher } = app.services;
for (const user of Object.values(E2E_USERS)) {
  await createUser({ users: repos.users, audit: repos.audit, hasher, maxUsers: config.maxUsers, clock: Date.now }, user);
}
if (process.env.E2E_SEED_SIGNALS === '1') {
  await seedSignals(repos);
  await seedWorkerHistory(repos);
}
await app.listen({ host: config.host, port: config.port });

// Playwright menghentikan server di akhir suite: worker tiruan ikut dihentikan (tidak menjadi yatim).
const close = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
