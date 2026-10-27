// Server khusus E2E: database sementara + dua pengguna uji. Tidak pernah dipakai di produksi.
// E2E_SEED_SIGNALS=1 mengisi sinyal dari pipeline asli atas candle SINTETIS (tests/fixtures/candles), dan smart
// money lewat sinkronisasi ASLI (runSmartMoneySync) dengan provider FIXTURE — DATA SIMULASI dari
// tests/fixtures/smartmoney/scenario.js (alamat & hash fiktif). SMART_MONEY_PROVIDERS selalu eksplisit agar E2E
// hermetis walau kunci API diekspor di shell (tidak pernah jatuh ke mode `auto`): `fixture` hanya di server seeded
// (NODE_ENV=test), `off` di server kosong — tanpa provider maupun data smart money.
// Tombol scanner aktif (WORKER_CONTROL) tetapi menjalankan worker TIRUAN (tests/fixtures/worker-stub.js):
// E2E tidak pernah menghubungi Binance. Env WORKER_STUB_* (mis. WORKER_STUB_EXIT_CODE) diwariskan ke worker tiruan.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../backend/app/buildApp.js';
import { loadConfig } from '../../backend/app/config.js';
import { openDatabase } from '../../backend/database/connection.js';
import { createFixtureProvider } from '../../backend/smartmoney/providers/fixtureProvider.js';
import { createLiveProviderRegistry } from '../../backend/smartmoney/providers/live.js';
import { runSmartMoneySync } from '../../backend/smartmoney/sync.js';
import { createUser } from '../../backend/users/userAdmin.js';
import { buildScenario } from '../fixtures/smartmoney/scenario.js';
import { seedReversalCandidates } from '../helpers/reversalSeed.js';
import { seedSignals, seedWorkerHistory } from '../helpers/signalSeed.js';
import { SEED_SYNC_TUNING } from '../helpers/smartMoneyApi.js';
import { E2E_PORT, E2E_USERS } from './fixtures.js';

const port = Number(process.env.E2E_SERVER_PORT ?? E2E_PORT);
const seeded = process.env.E2E_SEED_SIGNALS === '1';
const dbPath = join(mkdtempSync(join(tmpdir(), 'lr-e2e-')), 'e2e.db');
// Batas login dinaikkan khusus E2E: tiap spec masuk ulang per tes, dan server kosong (8181) dipakai
// app/neural/reversal/scanner/smartmoney ≈ 36 login per proyek; desktop + mobile berjalan dalam satu
// jendela 15 menit (≈ 72 login > 60 → "Terlalu banyak percobaan"). Tidak ada skenario E2E yang
// menguji rate limit (itu diuji di tests/security & tests/negative), jadi batasnya 200. Batas global API
// (default 300/menit/IP) juga dinaikkan: proyek mobile pada mesin cepat mengirim > 300 permintaan API per
// menit dari satu IP (Reversal Radar 3 TF + tabel SA/PVA + status worker + smart money), yang pada putaran
// cepat memunculkan 429 "Terlalu banyak permintaan" di Signal History / SHORT Scanner (E2E-NEU-009, E2E-SM-007).
const config = loadConfig({
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: `http://127.0.0.1:${port}`,
  DATABASE_PATH: dbPath, LOG_LEVEL: 'warn', LOGIN_RATE_LIMIT_MAX: '200', API_RATE_LIMIT_MAX: '3000', WORKER_CONTROL: 'true',
  SMART_MONEY_PROVIDERS: seeded ? 'fixture' : 'off',
});
const db = openDatabase(dbPath);
const workerScriptPath = fileURLToPath(new URL('../fixtures/worker-stub.js', import.meta.url));
// Registri smart money khusus server seeded: provider fixture (DATA SIMULASI) lewat extraAdapters — hanya diterima
// karena NODE_ENV=test. Skenario berporos pada waktu start server agar jendela radar 1h/4h/24h/7d berisi data.
const smartMoneyRegistry = seeded
  ? createLiveProviderRegistry(config, { extraAdapters: [createFixtureProvider(buildScenario({ now: Date.now() }))] })
  : undefined;
// Jeda start ulang 0 khusus E2E: tes desktop & mobile berbagi satu server dan menjalankan/menghentikan scanner
// berturut-turut. Jeda 10 detik produksi diuji di tests/unit (UNIT-SUP-027) dan tests/negative (NEG-SUP-010).
// Begitu pula jeda antar-"Sync sekarang" (30 detik di produksi; diuji di tests/unit & tests/negative): penyemaian di
// bawah baru saja menulis putaran terakhir, dan tes desktop & mobile menekan tombol yang sama berturut-turut.
const app = await buildApp({
  config, db, workerScriptPath, workerRestartCooldownMs: 0, smartMoneyRegistry, smartMoneySync: { cooldownMs: 0 },
});
const { repos, hasher } = app.services;
for (const user of Object.values(E2E_USERS)) {
  await createUser({ users: repos.users, audit: repos.audit, hasher, maxUsers: config.maxUsers, clock: Date.now }, user);
}
if (seeded) {
  // LONG Scanner produksi hanya 15m (DIRECTION_TIMEFRAMES) → sinyal seed di 15m.
  await seedSignals(repos, { timeframe: '15m' });
  await seedWorkerHistory(repos);
  // Reversal Radar (LONG Scanner): matriks kandidat SINTETIS per tahap/status/likuiditas/provisional ditulis lewat
  // repositori asli (tests/helpers/reversalSeed.js) beserta 60 candle tertutup per seri untuk harga & mini-chart.
  await seedReversalCandidates(repos, { withCandles: true });
  // Peristiwa skenario berumur 2–20 jam: batas basi alert dinaikkan KHUSUS penyemaian ini (SEED_SYNC_TUNING);
  // default produksi (30 menit) tidak berubah.
  const summary = await runSmartMoneySync({
    repo: repos.smartMoney, registry: smartMoneyRegistry, config: config.smartMoney, tuning: SEED_SYNC_TUNING,
  });
  if (summary.status !== 'OK' || summary.alerts === 0) {
    throw new Error(`Seeding smart money E2E gagal: ${JSON.stringify({ status: summary.status, alerts: summary.alerts, errors: summary.errors })}`);
  }
}
await app.listen({ host: config.host, port: config.port });

// Playwright menghentikan server di akhir suite: worker tiruan ikut dihentikan (tidak menjadi yatim).
const close = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
