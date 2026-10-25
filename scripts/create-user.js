// Membuat pengguna dari CLI server. Kata sandi dibaca dari prompt tersembunyi (TTY)
// atau dari stdin (non-TTY, misalnya `printf '%s' "$PASS" | npm run user:create -- --username a`).
// Kata sandi tidak pernah diterima sebagai argumen baris perintah karena terlihat di daftar proses.
import { parseArgs } from 'node:util';
import { loadConfig } from '../backend/app/config.js';
import { createPasswordHasher } from '../backend/auth/password.js';
import { openDatabase } from '../backend/database/connection.js';
import { migrate } from '../backend/database/migrate.js';
import { createRepositories } from '../backend/database/repositories/index.js';
import { UserAdminError, createUser } from '../backend/users/userAdmin.js';
import { PasswordInputError, readNewPassword } from './lib/passwordInput.js';

const { values } = parseArgs({
  options: { username: { type: 'string' }, role: { type: 'string', default: 'admin' } },
});

let password;
try {
  password = await readNewPassword();
} catch (err) {
  if (!(err instanceof PasswordInputError)) throw err;
  console.error(err.message);
  process.exit(1);
}

const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  migrate(db);
  const repos = createRepositories(db);
  const id = await createUser(
    { users: repos.users, audit: repos.audit, hasher: createPasswordHasher(), maxUsers: config.maxUsers, clock: Date.now },
    { username: values.username, password, role: values.role },
  );
  console.log(`Pengguna dibuat (id ${id}, peran ${values.role})`);
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
