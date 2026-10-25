// Mengganti kata sandi pengguna dari CLI server, mis. akun default prototipe:
//   npm run user:password -- --username admin
// Kata sandi baru dibaca dari prompt tersembunyi (TTY, dengan konfirmasi) atau dari stdin
// (non-TTY, misalnya `printf '%s' "$PASS" | npm run user:password -- --username admin`), tidak pernah
// dari argumen baris perintah. Semua sesi aktif pengguna tersebut dicabut setelah kata sandi diganti.
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../backend/app/config.js';
import { createPasswordHasher } from '../backend/auth/password.js';
import { openDatabase } from '../backend/database/connection.js';
import { migrate } from '../backend/database/migrate.js';
import { createRepositories } from '../backend/database/repositories/index.js';
import { UserAdminError, changePassword } from '../backend/users/userAdmin.js';
import { PasswordInputError, readNewPassword } from './lib/passwordInput.js';

const USAGE = 'Pemakaian: npm run user:password -- --username <username> (kata sandi baru diminta tersembunyi atau dibaca dari stdin)';

function exitWith(message) {
  console.error(message);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({ options: { username: { type: 'string' } } }));
} catch {
  exitWith(USAGE);
}
if (!values.username) exitWith(USAGE);

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  exitWith(`Konfigurasi tidak valid: ${err.message}`);
}

let password;
try {
  password = await readNewPassword({ prompt: 'Kata sandi baru: ', confirm: 'Ulangi kata sandi baru: ' });
} catch (err) {
  if (!(err instanceof PasswordInputError)) throw err;
  exitWith(err.message);
}

const db = openDatabase(config.databasePath);
try {
  migrate(db);
  const repos = createRepositories(db);
  const { revokedSessions } = await changePassword(
    { users: repos.users, sessions: repos.sessions, audit: repos.audit, hasher: createPasswordHasher(), clock: Date.now },
    { username: values.username, password },
  );
  console.log(`Kata sandi pengguna ${values.username} diganti; ${revokedSessions} sesi aktif dicabut`);
} catch (err) {
  if (err instanceof UserAdminError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  db.close();
}
