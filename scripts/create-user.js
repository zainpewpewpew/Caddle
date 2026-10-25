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

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          return reject(new Error('Dibatalkan'));
        }
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

const { values } = parseArgs({
  options: { username: { type: 'string' }, role: { type: 'string', default: 'admin' } },
});

let password;
if (process.stdin.isTTY) {
  password = await promptHidden('Kata sandi: ');
  const confirm = await promptHidden('Ulangi kata sandi: ');
  if (password !== confirm) {
    console.error('Kata sandi tidak sama');
    process.exit(1);
  }
} else {
  password = await readStdin();
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
