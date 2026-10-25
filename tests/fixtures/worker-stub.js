// Worker TIRUAN untuk E2E dan tes integrasi supervisor. Tidak pernah menghubungi Binance dan tidak
// menganalisis apa pun: hanya tetap hidup sampai SIGTERM/SIGINT (atau kanal IPC ke server terputus).
// Opsi lewat environment (diset oleh tes, bukan oleh request):
//   WORKER_STUB_HEARTBEAT=1         tulis heartbeat 'running' ke DATABASE_PATH tiap detik, 'stopped' saat berhenti
//   WORKER_STUB_IGNORE_SIGTERM=1    abaikan SIGTERM (menguji eskalasi SIGKILL supervisor)
//   WORKER_STUB_EXIT_CODE=<n>       keluar sendiri dengan kode n setelah ±100 ms (menguji crash)
//   WORKER_STUB_LONG_LINE=<n>       tulis satu baris stdout sepanjang n karakter saat mulai (menguji batas baris)
import { hostname } from 'node:os';
import { openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrate.js';
import { createIngestionStateRepository } from '../../backend/database/repositories/ingestionStateRepository.js';

const env = process.env;
// Sama dengan worker/index.js: log ke pipe server yang sudah mati (EPIPE) tidak boleh menjadi uncaughtException.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
const log = (msg, fields = {}) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'info', msg, ...fields })}\n`);

let db = null;
let ingestion = null;
if (env.WORKER_STUB_HEARTBEAT === '1') {
  db = openDatabase(env.DATABASE_PATH);
  migrate(db);
  ingestion = createIngestionStateRepository(db);
}
// Sama dengan worker/index.js: heartbeat memuat identitas proses penulis (owner) agar server yang baru start dapat
// mengenali heartbeat segar dari worker yang sudah mati.
const owner = { pid: process.pid, host: hostname() };
const beat = (state) => ingestion?.heartbeat({ at: Date.now(), state: { state, symbols: 0, streams: 0, ws: null, owner } });

log('worker stub mulai', { pid: process.pid });
if (env.WORKER_STUB_LONG_LINE) process.stdout.write(`${'x'.repeat(Number(env.WORKER_STUB_LONG_LINE))}\n`);
await beat('running');
const timer = setInterval(() => { beat('running'); }, 1_000);

let stopping = false;
async function shutdown(reason) {
  if (stopping) return;
  if (reason === 'SIGTERM' && env.WORKER_STUB_IGNORE_SIGTERM === '1') {
    log('worker stub mengabaikan SIGTERM');
    return;
  }
  stopping = true;
  clearInterval(timer);
  await beat('stopped');
  db?.close();
  log('worker stub berhenti', { reason });
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('disconnect', () => shutdown('disconnect'));

if (env.WORKER_STUB_EXIT_CODE) {
  setTimeout(() => {
    clearInterval(timer);
    db?.close();
    process.exit(Number(env.WORKER_STUB_EXIT_CODE));
  }, 100);
}
