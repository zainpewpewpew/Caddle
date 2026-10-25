// Tes input kata sandi CLI (scripts/lib/passwordInput.js) dengan stream palsu: prompt tersembunyi (TTY)
// dan stdin (non-TTY). Terminal palsu mencatat raw mode, pause/resume, listener, dan semua yang ditulis.
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasswordInputError, readNewPassword } from '../../scripts/lib/passwordInput.js';

const PASSWORD = 'kata-sandi-yang-kuat';
const MULTILINE = 'beberapa baris';
const CONTROL = 'Karakter kontrol tidak diizinkan dalam kata sandi';

function fakeTerminal() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    paused: true,
    setRawMode(mode) { this.isRaw = mode; return this; },
    resume() { this.paused = false; return this; },
    pause() { this.paused = true; return this; },
    setEncoding() { return this; },
  });
  const stdout = { written: '', write(text) { this.written += text; return true; } };
  /** Satu event 'data' per potongan, seperti terminal mengirim ketikan atau tempelan. */
  const type = (...chunks) => { for (const chunk of chunks) stdin.emit('data', chunk); };
  return { stdin, stdout, type };
}

/** Hasil promise sebagai { value } | { error }, tanpa unhandled rejection. */
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
/**
 * Hasil setelah semua microtask selesai, atau { pending: true } bila belum selesai (tes gagal cepat,
 * tidak menunggu timeout). setImmediate tetap asli karena hanya setTimeout yang dipalsukan.
 */
const now = async (settled) => {
  await new Promise((resolve) => setImmediate(resolve));
  return Promise.race([settled, Promise.resolve({ pending: true })]);
};

describe('readNewPassword — prompt tersembunyi (TTY)', () => {
  let term;
  let result;
  /** Melewati jeda pengurasan type-ahead sehingga prompt berikutnya tampil. */
  const showPrompt = () => vi.advanceTimersByTimeAsync(200);
  const start = () => {
    result = settle(readNewPassword({ prompt: 'Kata sandi baru: ', confirm: 'Ulangi: ', stdin: term.stdin, stdout: term.stdout }));
  };
  const expectRestored = () => {
    expect(term.stdin.listenerCount('data')).toBe(0);
    expect(term.stdin.isRaw).toBe(false);
    expect(term.stdin.paused).toBe(true);
    expect(term.stdout.written.endsWith('\n')).toBe(true);
  };
  const expectRejected = async (message) => {
    const outcome = await now(result);
    expect(outcome).toEqual({ error: expect.any(PasswordInputError) });
    expect(outcome.error.message).toContain(message);
    expectRestored();
    expect(term.stdout.written).not.toContain('Ulangi: ');
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    term = fakeTerminal();
  });
  afterEach(() => vi.useRealTimers());

  it('UNIT-PWI-001 ketikan lintas potongan: dua prompt, kata sandi dikembalikan, tidak ada gema, terminal dipulihkan', async () => {
    start();
    await showPrompt();
    expect(term.stdout.written).toBe('Kata sandi baru: ');
    expect(term.stdin.isRaw).toBe(true);
    term.type('ka', 'ta-sandi', '-yang-kuat', '\r');
    await showPrompt();
    expect(term.stdout.written).toBe('Kata sandi baru: \nUlangi: ');
    term.type(`${PASSWORD}\r`);

    expect(await now(result)).toEqual({ value: PASSWORD });
    expectRestored();
    expect(term.stdout.written).toBe('Kata sandi baru: \nUlangi: \n');
  });

  it('UNIT-PWI-002 backspace \\x7f dan \\b menghapus satu karakter (emoji utuh); backspace pada input kosong diabaikan', async () => {
    start();
    await showPrompt();
    term.type('\x7fkata-x\x7f', 'sandi-yang-kuax\bt', '-🔑\b', '\x7f\r');
    await showPrompt();
    term.type(`${PASSWORD}?\b\r`);

    expect(await now(result)).toEqual({ value: PASSWORD });
    expectRestored();
  });

  it.each([['\\n', `${PASSWORD}\n`], ['\\r\\n', `${PASSWORD}\r\n`]])(
    'EDGE-PWI-001 Enter sebagai %s dalam satu potongan diterima',
    async (_label, line) => {
      start();
      await showPrompt();
      term.type(line);
      await showPrompt();
      term.type(line);
      expect(await now(result)).toEqual({ value: PASSWORD });
      expectRestored();
    },
  );

  it('NEG-PWI-001 kata sandi dan konfirmasi berbeda → PasswordInputError', async () => {
    start();
    await showPrompt();
    term.type(`${PASSWORD}\r`);
    await showPrompt();
    term.type(`${PASSWORD}!\r`);

    const outcome = await now(result);
    expect(outcome.error).toBeInstanceOf(PasswordInputError);
    expect(outcome.error.message).toBe('Kata sandi tidak sama');
    expectRestored();
  });

  it.each([
    ['dua perintah shell (\\r)', 'npm run migrate\rnpm start\r'],
    ['dua perintah shell (\\n)', 'npm run migrate\nnpm start\n'],
    ['baris kosong menyusul (\\r\\r)', `${PASSWORD}\r\r`],
    ['baris kosong menyusul (\\n\\n)', `${PASSWORD}\n\n`],
    ['sisa tanpa Enter', `${PASSWORD}\r\nnpm start`],
  ])('NEG-PWI-002 tempelan multi-baris dalam satu potongan ditolak: %s', async (_label, paste) => {
    start();
    await showPrompt();
    term.type(paste);
    await showPrompt();
    term.type(paste); // pemilik menempel ke kedua prompt, seperti reproduksi di pty

    await expectRejected(MULTILINE);
  });

  it('NEG-PWI-003 type-ahead (baris lengkap) sebelum prompt tampil langsung ditolak; prompt tidak ditulis', async () => {
    start();
    term.type(`${PASSWORD}\r`);
    await showPrompt();
    term.type(`${PASSWORD}\r`);

    await expectRejected('sebelum prompt');
    expect(term.stdout.written).toBe('\n');
  });

  it('EDGE-PWI-003 type-ahead sebagian: prompt tetap tampil, penolakan menunggu Enter (sisa ketikan tidak tumpah ke shell)', async () => {
    start();
    term.type('kata-');
    await showPrompt();
    expect(term.stdout.written).toBe('Kata sandi baru: ');
    term.type('sandi-yang-kuat');
    expect(await now(result)).toEqual({ pending: true });
    expect(term.stdin.isRaw).toBe(true);
    term.type('\r');

    await expectRejected('sebelum prompt');
  });

  it('NEG-PWI-004 type-ahead sebelum prompt konfirmasi tampil ditolak', async () => {
    start();
    await showPrompt();
    term.type(`${PASSWORD}\r`);
    await vi.advanceTimersByTimeAsync(0);
    term.type(`${PASSWORD}\r`);
    await showPrompt();

    const outcome = await now(result);
    expect(outcome).toEqual({ error: expect.any(PasswordInputError) });
    expect(outcome.error.message).toContain('sebelum prompt');
    expectRestored();
  });

  it.each([
    ['panah kiri (ESC [ D)', 'kata\x1b[Dsandi-yang-kuat\r'],
    ['ESC saja', `${PASSWORD}\x1b\r`],
    ['penanda bracketed paste', `\x1b[200~${PASSWORD}\x1b[201~\r`],
    ['Ctrl+D (langsung, tanpa Enter)', 'kata\x04'],
    ['tab', 'kata\tsandi-yang-kuat\r'],
    ['NUL', 'kata\x00sandi-yang-kuat\r'],
    ['C1 CSI (U+009B)', 'kata\u009bsandi-yang-kuat\r'],
  ])('NEG-PWI-005 karakter kontrol ditolak: %s', async (_label, input) => {
    start();
    await showPrompt();
    term.type(input);
    await showPrompt();
    term.type(input);

    await expectRejected(CONTROL);
  });

  it('EDGE-PWI-004 karakter kontrol di tengah ketikan: ditolak saat Enter, sisa ketikan tetap tersembunyi', async () => {
    start();
    await showPrompt();
    term.type('kata', '\x1b[D', '-sandi');
    expect(await now(result)).toEqual({ pending: true });
    expect(term.stdin.isRaw).toBe(true);
    term.type('-yang-kuat', '\r');

    await expectRejected(CONTROL);
    expect(term.stdout.written).toBe('Kata sandi baru: \n');
  });

  it.each([['prompt pertama', 0], ['prompt konfirmasi', 1]])(
    'NEG-PWI-006 Ctrl+C di %s → PasswordInputError "Dibatalkan", listener dilepas, raw mode mati',
    async (_label, promptIndex) => {
      start();
      await showPrompt();
      if (promptIndex === 1) {
        term.type(`${PASSWORD}\r`);
        await showPrompt();
      }
      term.type('kata', '\x03');

      const outcome = await now(result);
      expect.soft(outcome.error).toBeInstanceOf(PasswordInputError);
      expect.soft(outcome.error?.message).toBe('Dibatalkan');
      expect.soft(term.stdin.listenerCount('data')).toBe(0);
      expect.soft(term.stdin.isRaw).toBe(false);
      expect.soft(term.stdin.paused).toBe(true);
      expect.soft(term.stdout.written.endsWith('\n')).toBe(true);

      const written = term.stdout.written;
      term.type(`${PASSWORD}\r`); // ketikan setelah Ctrl+C tidak lagi dibaca
      await showPrompt();
      expect(term.stdout.written).toBe(written);
    },
  );
});

describe('readNewPassword — stdin (non-TTY)', () => {
  const pipe = (...chunks) => Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  const stdout = () => ({ written: '', write(text) { this.written += text; return true; } });

  it.each([
    ['diakhiri \\n', [`${PASSWORD}\n`]],
    ['diakhiri \\r\\n', [`${PASSWORD}\r\n`]],
    ['tanpa baris baru (printf)', [PASSWORD]],
    ['lintas potongan', ['kata-sandi', '-yang-', 'kuat\n']],
  ])('UNIT-PWI-003 satu baris baru di akhir dibuang: %s', async (_label, chunks) => {
    const out = stdout();
    expect(await readNewPassword({ stdin: pipe(...chunks), stdout: out })).toBe(PASSWORD);
    expect(out.written).toBe('');
  });

  it('EDGE-PWI-002 karakter UTF-8 multi-byte yang terpotong antar-chunk tetap utuh', async () => {
    const bytes = Buffer.from('kata-sandi-🔑-kuat\n');
    const cut = bytes.indexOf(Buffer.from('🔑')) + 2;
    const stdin = Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]);
    expect(await readNewPassword({ stdin, stdout: stdout() })).toBe('kata-sandi-🔑-kuat');
  });

  it.each([
    ['dua baris', `${PASSWORD}\nnpm start\n`, MULTILINE],
    ['baris kosong menyusul', `${PASSWORD}\n\n`, MULTILINE],
    ['\\r di tengah', 'kata-sandi\ryang-kuat', MULTILINE],
    ['ESC', `${PASSWORD}\x1b[D\n`, CONTROL],
    ['NUL', `kata\x00sandi-yang-kuat\n`, CONTROL],
    ['tab', `kata\tsandi-yang-kuat\n`, CONTROL],
    ['DEL', `${PASSWORD}\x7f\n`, CONTROL],
  ])('NEG-PWI-007 baris baru tertanam atau karakter kontrol ditolak: %s', async (_label, input, message) => {
    const error = await readNewPassword({ stdin: pipe(input), stdout: stdout() }).catch((err) => err);
    expect(error).toBeInstanceOf(PasswordInputError);
    expect(error.message).toContain(message);
  });
});
