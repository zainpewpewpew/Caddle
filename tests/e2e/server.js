// Server khusus E2E: database sementara + dua pengguna uji. Tidak pernah dipakai di produksi.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../backend/app/buildApp.js';
import { loadConfig } from '../../backend/app/config.js';
import { openDatabase } from '../../backend/database/connection.js';
import { createUser } from '../../backend/users/userAdmin.js';
import { E2E_PORT, E2E_USERS } from './fixtures.js';


const dbPath = join(mkdtempSync(join(tmpdir(), 'lr-e2e-')), 'e2e.db');
const config = loadConfig({
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(E2E_PORT), APP_ORIGIN: `http://127.0.0.1:${E2E_PORT}`,
  DATABASE_PATH: dbPath, LOG_LEVEL: 'warn', LOGIN_RATE_LIMIT_MAX: '20',
});
const db = openDatabase(dbPath);
const app = await buildApp({ config, db });
const { repos, hasher } = app.services;
for (const user of Object.values(E2E_USERS)) {
  await createUser({ users: repos.users, audit: repos.audit, hasher, maxUsers: config.maxUsers, clock: Date.now }, user);
}
await app.listen({ host: config.host, port: config.port });
