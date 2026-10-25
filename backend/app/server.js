import { buildApp } from './buildApp.js';
import { ConfigError, loadConfig } from './config.js';
import { openDatabase } from '../database/connection.js';
import { STOP_TIMEOUT_MS } from '../system/workerSupervisor.js';
import { DefaultUserError, ensureDefaultUser } from '../users/defaultUser.js';

// Batas keluar paksa server > batas stop worker (SIGTERM → SIGKILL), agar worker selalu dihentikan lebih dulu.
const SHUTDOWN_TIMEOUT_MS = STOP_TIMEOUT_MS + 5_000;

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Konfigurasi tidak valid: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const db = openDatabase(config.databasePath);
  const app = await buildApp({ config, db });
  app.addHook('onClose', async () => db.close());

  // Akun default prototipe lokal — setelah buildApp, karena migrasi berjalan di sana.
  // Hanya di development + server lokal (HOST/APP_ORIGIN loopback, tanpa proxy) + tabel users kosong;
  // menolak start bila kata sandi default masih aktif di server non-lokal (lihat backend/users/defaultUser.js).
  const { repos, hasher } = app.services;
  try {
    await ensureDefaultUser({
      users: repos.users, audit: repos.audit, hasher, maxUsers: config.maxUsers, clock: Date.now, config, log: app.log,
    });
  } catch (err) {
    if (err instanceof DefaultUserError) {
      console.error(`Server tidak dijalankan: ${err.message}`);
      db.close();
      process.exit(1);
    }
    throw err;
  }

  // Worker yang dijalankan dari website tidak boleh menjadi yatim. Jalur normal: shutdown() di bawah.
  // Jalur lain (crash, process.exit): handler 'exit' sinkron mengirim SIGTERM agar worker berhenti
  // dengan graceful (worker juga berhenti sendiri saat kanal IPC ke server terputus).
  const supervisor = app.services.workerSupervisor;
  process.on('exit', () => supervisor.killChild('SIGTERM'));

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'menghentikan server');
    const forceExit = setTimeout(() => {
      supervisor.killChild('SIGKILL');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    // Hentikan worker (SIGTERM → tunggu ≤ 15 detik → SIGKILL) SEBELUM server & database ditutup;
    // start baru ditolak sejak titik ini.
    try {
      await supervisor.shutdown();
    } catch (err) {
      app.log.error({ err }, 'gagal menghentikan worker scanner');
      supervisor.killChild('SIGKILL');
    }
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Menutup jendela terminal `npm start` mengirim SIGHUP: hentikan worker dengan graceful seperti Ctrl+C.
  process.on('SIGHUP', shutdown);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
