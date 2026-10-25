import { buildApp } from './buildApp.js';
import { ConfigError, loadConfig } from './config.js';
import { openDatabase } from '../database/connection.js';

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
