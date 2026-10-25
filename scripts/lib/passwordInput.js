// Input kata sandi untuk CLI server (user:create, user:password). Kata sandi dibaca dari prompt
// tersembunyi (TTY, dengan konfirmasi) atau dari stdin (non-TTY, mis. `printf '%s' "$PASS" | npm run ...`).
// Kata sandi tidak pernah diterima sebagai argumen baris perintah karena terlihat di daftar proses.

export class PasswordInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PasswordInputError';
  }
}

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

/**
 * TTY: dua prompt tersembunyi yang harus sama (PasswordInputError bila berbeda).
 * Non-TTY: seluruh stdin tanpa satu baris baru di akhir.
 */
export async function readNewPassword({ prompt = 'Kata sandi: ', confirm = 'Ulangi kata sandi: ' } = {}) {
  if (!process.stdin.isTTY) return readStdin();
  const password = await promptHidden(prompt);
  const repeated = await promptHidden(confirm);
  if (password !== repeated) throw new PasswordInputError('Kata sandi tidak sama');
  return password;
}
