import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  browserCommand, createPrettyStream, formatBanner, formatLogLine, isWatchMode, openBrowser, useColor, usePrettyLogs, wibClock,
} from '../../../backend/system/consoleLog.js';

// 2026-11-15 12:04:05 UTC = 19:04:05 WIB.
const ISO = '2026-11-15T12:04:05.000Z';
const MS = Date.parse(ISO);

describe('tampilan log terminal npm start (backend/system/consoleLog.js)', () => {
  it('UNIT-CON-001 baris worker (level teks) & server pino (level angka) → "jam WIB  sumber  pesan"; info hanya field penting', () => {
    const worker = JSON.stringify({ time: ISO, level: 'info', msg: 'scan #57: 120/120 seri mutakhir · harga live 120 seri', seq: 57, series: 120 });
    expect(formatLogLine(worker, { scope: 'scanner' })).toBe('19:04:05  scanner  scan #57: 120/120 seri mutakhir · harga live 120 seri');
    const pino = JSON.stringify({ level: 30, time: MS, pid: 1, hostname: 'h', module: 'worker-supervisor', workerPid: 4242, via: 'autostart', msg: 'worker scanner dijalankan' });
    expect(formatLogLine(pino)).toBe('19:04:05  server   worker scanner dijalankan  · workerPid=4242 via=autostart');
    const ws = JSON.stringify({ time: ISO, level: 'info', msg: 'state WebSocket', state: 'open', reconnects: 0 });
    expect(formatLogLine(ws, { scope: 'scanner' })).toBe('19:04:05  scanner  state WebSocket  · state=open');
  });

  it('UNIT-CON-002 peringatan/galat diberi label dan seluruh field; objek err → pesannya; nilai panjang dipotong', () => {
    const warn = JSON.stringify({ time: ISO, level: 'warn', msg: 'galat scanner', source: 'backfill', symbol: 'BTCUSDT', timeframe: '1h', err: 'HTTP 500 dari Binance' });
    expect(formatLogLine(warn, { scope: 'scanner' })).toBe('19:04:05  scanner  PERINGATAN galat scanner  · source=backfill symbol=BTCUSDT timeframe=1h err=HTTP 500 dari Binance');
    const err = JSON.stringify({ level: 50, time: MS, msg: 'unhandled error', err: { type: 'Error', message: 'boom', stack: 'at x' }, detail: 'y'.repeat(200) });
    const line = formatLogLine(err);
    expect(line.startsWith('19:04:05  server   GALAT unhandled error  · err=boom detail=')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
  });

  it('UNIT-CON-003 karakter kontrol & bidi dari isi log dibuang (tidak dapat menyisipkan escape terminal); baris non-JSON dicetak apa adanya; kosong → null', () => {
    const evil = JSON.stringify({ time: ISO, level: 'warn', msg: 'x\u001b[2J\u009b31m‮Y', err: 'a\u0007b' });
    const out = formatLogLine(evil, { scope: 'scanner' });
    expect(out).toBe('19:04:05  scanner  PERINGATAN x [2J 31m Y  · err=a b');
    expect(formatLogLine('teks biasa dari child', { scope: 'scanner' })).toBe('          scanner  teks biasa dari child');
    expect(formatLogLine('   ')).toBeNull();
    expect(formatLogLine('{bukan json', { scope: 'scanner' })).toBe('          scanner  {bukan json');
  });

  it('UNIT-CON-004 warna ANSI hanya bila diminta; stream pretty memecah beberapa baris', () => {
    const line = JSON.stringify({ time: ISO, level: 'error', msg: 'gagal' });
    const colored = formatLogLine(line, { color: true });
    expect(colored).toContain('\u001b[31mGALAT gagal\u001b[0m');
    const written = [];
    const stream = createPrettyStream({ write: (t) => written.push(t) });
    stream.write(`${JSON.stringify({ time: ISO, level: 30, msg: 'a' })}\n${JSON.stringify({ time: ISO, level: 30, msg: 'b' })}\n`);
    expect(written).toEqual(['19:04:05  server   a\n', '19:04:05  server   b\n']);
  });

  it('UNIT-CON-005 mode tampilan: auto → teks bila TTY, JSON bila dialihkan; pretty/json memaksa; NO_COLOR & TERM=dumb mematikan warna', () => {
    expect(usePrettyLogs('auto', { isTTY: true })).toBe(true);
    expect(usePrettyLogs('auto', { isTTY: false })).toBe(false);
    expect(usePrettyLogs('auto', {})).toBe(false);
    expect(usePrettyLogs('pretty', {})).toBe(true);
    expect(usePrettyLogs('json', { isTTY: true })).toBe(false);
    expect(useColor({ isTTY: true }, {})).toBe(true);
    expect(useColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(useColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(useColor({ isTTY: false }, {})).toBe(false);
    expect(wibClock(MS)).toBe('19:04:05');
    expect(wibClock('bukan waktu')).toBeNull();
  });

  it('UNIT-CON-006 banner memuat alamat & status scanner nyata (otomatis / di luar website / gagal / belum / kontrol mati)', () => {
    const base = { origin: 'http://127.0.0.1:8080', workerControl: true, workerAutostart: true, openBrowser: true };
    const running = formatBanner({ ...base, scannerState: 'running' });
    expect(running).toContain('AlphaLens berjalan  →  http://127.0.0.1:8080');
    expect(running).toContain('Scanner : dijalankan otomatis — LONG 1h · SHORT 15m · Reversal Radar 1h');
    expect(running).toContain('dipindai tiap 1 menit');
    expect(running).toContain('Browser dibuka otomatis.');
    expect(running).not.toContain('\u001b[');
    expect(formatBanner({ ...base, scannerState: 'external' })).toContain('sudah berjalan di luar website');
    expect(formatBanner({ ...base, scannerState: 'crashed' })).toContain('gagal dijalankan — dicoba ulang otomatis');
    const idle = formatBanner({ ...base, workerAutostart: false, openBrowser: false, scannerState: 'stopped' });
    expect(idle).toContain('belum berjalan — tekan "Jalankan scanner"');
    expect(idle).not.toContain('Browser dibuka');
    expect(formatBanner({ ...base, workerControl: false })).toContain('WORKER_CONTROL=false');
  });

  it('UNIT-CON-007 browser dibuka hanya bila diaktifkan, stdout TTY, bukan watch mode (npm run dev), dan URL http(s); perintah tanpa shell per platform', () => {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    };
    const url = 'http://127.0.0.1:8080/';
    expect(openBrowser(url, { enabled: true, isTTY: true, env: {}, platform: 'darwin', spawn })).toBe(true);
    expect(calls).toEqual([{ command: 'open', args: [url], options: { stdio: 'ignore', detached: true, windowsHide: true } }]);
    expect(openBrowser(url, { enabled: false, isTTY: true, env: {}, spawn })).toBe(false);
    expect(openBrowser(url, { enabled: true, isTTY: false, env: {}, spawn })).toBe(false);
    expect(openBrowser(url, { enabled: true, isTTY: true, env: { WATCH_REPORT_DEPENDENCIES: '1' }, spawn })).toBe(false);
    expect(openBrowser('file:///etc/passwd', { enabled: true, isTTY: true, env: {}, spawn })).toBe(false);
    expect(openBrowser('bukan url', { enabled: true, isTTY: true, env: {}, spawn })).toBe(false);
    expect(calls).toHaveLength(1);
    expect(isWatchMode({ WATCH_REPORT_DEPENDENCIES: '1' })).toBe(true);
    expect(isWatchMode({})).toBe(false);
    expect(browserCommand(url, 'win32')).toEqual({ command: 'cmd', args: ['/c', 'start', '', url] });
    expect(browserCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
  });

  it('UNIT-CON-008 perintah pembuka yang gagal (mis. xdg-open tidak ada) hanya memberi peringatan, tidak menjatuhkan server', () => {
    const warnings = [];
    const logger = { warn: (fields, msg) => warnings.push(msg) };
    const child = new EventEmitter();
    child.unref = () => {};
    expect(openBrowser('http://127.0.0.1:8080/', { enabled: true, isTTY: true, env: {}, platform: 'linux', spawn: () => child, logger })).toBe(true);
    child.emit('error', new Error('spawn xdg-open ENOENT'));
    const throwing = () => { throw new Error('EACCES'); };
    expect(openBrowser('http://127.0.0.1:8080/', { enabled: true, isTTY: true, env: {}, spawn: throwing, logger })).toBe(false);
    expect(warnings).toEqual([
      'browser tidak dapat dibuka otomatis — buka alamat di atas secara manual',
      'browser tidak dapat dibuka otomatis — buka alamat di atas secara manual',
    ]);
  });
});
