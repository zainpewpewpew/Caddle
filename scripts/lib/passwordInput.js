// Input kata sandi untuk CLI server (user:create, user:password). Kata sandi dibaca dari prompt
// tersembunyi (TTY, dengan konfirmasi) atau dari stdin (non-TTY, mis. `printf '%s' "$PASS" | npm run ...`).
// Kata sandi tidak pernah diterima sebagai argumen baris perintah karena terlihat di daftar proses.
//
// Kata sandi harus bisa diketik ulang di form login browser. Karena itu tempelan multi-baris, input yang
// sudah menunggu sebelum prompt tampil (type-ahead), dan karakter kontrol (ESC/tombol panah, penanda
// bracketed paste, Ctrl+D, tab, ...) ditolak dengan PasswordInputError, tidak pernah disimpan diam-diam.

export class PasswordInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PasswordInputError';
  }
}

/** Jeda setelah raw mode aktif sebelum prompt ditulis; input yang tiba dalam jeda ini adalah type-ahead. */
export const TYPE_AHEAD_DRAIN_MS = 100;

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = new Set(['\u007f', '\b']);

const MESSAGES = Object.freeze({
  multiline: 'Input berisi beberapa baris (tempelan?) — dibatalkan; ketik kata sandi secara manual',
  typeAhead: 'Ada input sebelum prompt tampil (ketikan/tempelan tertunda) — dibatalkan; ketik kata sandi setelah prompt muncul',
  control: 'Karakter kontrol tidak diizinkan dalam kata sandi',
  cancelled: 'Dibatalkan',
  stdinMultiline: 'Input stdin berisi beberapa baris — dibatalkan; kirim kata sandi sebagai satu baris',
  mismatch: 'Kata sandi tidak sama',
});

/** C0 (U+0000–U+001F, termasuk ESC), DEL (U+007F), dan C1 (U+0080–U+009F). */
function isControlChar(ch) {
  const code = ch.codePointAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Satu prompt tersembunyi dalam raw mode. Resolve dengan teks sebelum Enter (`\r`, `\n`, atau `\r\n`).
 * Reject PasswordInputError bila ada input lain setelah Enter dalam potongan yang sama (tempelan
 * multi-baris), input tiba sebelum prompt tampil (type-ahead), ada karakter kontrol, atau Ctrl+C/Ctrl+D.
 * Type-ahead dan karakter kontrol baru dilaporkan saat Enter: sisa ketikan tetap tersembunyi dan tidak
 * tumpah ke shell setelah proses keluar. Backspace (`\x7f` atau `\b`) menghapus satu karakter.
 * Terminal selalu dipulihkan (listener dilepas, raw mode mati, stream dijeda, baris baru ditulis).
 */
export function promptHidden(question, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    const value = []; // per code point, agar backspace menghapus emoji utuh
    let failure = null; // penolakan pertama (type-ahead/karakter kontrol), dilaporkan saat Enter
    let ready = false;
    let done = false;

    const finish = (error, password) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(new PasswordInputError(error));
      else resolve(password);
    };

    function onData(chunk) {
      if (!ready) failure ??= MESSAGES.typeAhead;
      const chars = Array.from(String(chunk));
      for (let i = 0; i < chars.length; i += 1) {
        const ch = chars[i];
        if (ch === '\r' || ch === '\n') {
          if (failure) return finish(failure);
          const rest = chars.slice(i + 1).join('');
          if (rest === '' || (ch === '\r' && rest === '\n')) return finish(null, value.join(''));
          return finish(MESSAGES.multiline);
        }
        if (ch === CTRL_C) return finish(MESSAGES.cancelled);
        if (ch === CTRL_D) return finish(MESSAGES.control);
        if (BACKSPACE.has(ch)) value.pop();
        else if (isControlChar(ch)) failure ??= MESSAGES.control;
        else value.push(ch);
      }
    }

    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    const timer = setTimeout(() => {
      ready = true;
      stdout.write(question);
    }, TYPE_AHEAD_DRAIN_MS);
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (password.includes('\n') || password.includes('\r')) throw new PasswordInputError(MESSAGES.stdinMultiline);
  if (Array.from(password).some(isControlChar)) throw new PasswordInputError(MESSAGES.control);
  return password;
}

/**
 * TTY: dua prompt tersembunyi yang harus sama (PasswordInputError bila berbeda, dibatalkan, atau ditolak).
 * Non-TTY: seluruh stdin tanpa satu baris baru di akhir; baris baru lain atau karakter kontrol ditolak.
 * `stdin`/`stdout` dapat diganti (tes); default stream proses.
 */
export async function readNewPassword({
  prompt = 'Kata sandi: ',
  confirm = 'Ulangi kata sandi: ',
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (!stdin.isTTY) return readStdin(stdin);
  const password = await promptHidden(prompt, { stdin, stdout });
  const repeated = await promptHidden(confirm, { stdin, stdout });
  if (password !== repeated) throw new PasswordInputError(MESSAGES.mismatch);
  return password;
}
