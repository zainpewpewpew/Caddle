import { buildApp } from './buildApp.js';
import { ConfigError, loadConfig } from './config.js';
import { openDatabase } from '../database/connection.js';
import { DefaultUserError, ensureDefaultUser } from '../users/defaultUser.js';

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

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'menghentikan server');
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
