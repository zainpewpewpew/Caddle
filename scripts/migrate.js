import { loadConfig } from '../backend/app/config.js';
import { openDatabase } from '../backend/database/connection.js';
import { migrate } from '../backend/database/migrate.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  const { applied, current } = migrate(db);
  console.log(applied.length ? `Migrasi diterapkan: ${applied.join(', ')}` : 'Tidak ada migrasi baru');
  console.log(`Versi skema saat ini: ${current}`);
} finally {
  db.close();
}
