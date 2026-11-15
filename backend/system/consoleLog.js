// Tampilan terminal `npm start` (LOG_FORMAT, backend/app/config.js): baris log JSON server (Fastify/pino) dan worker
// scanner (child yang diteruskan supervisor) diubah menjadi teks ringkas — jam WIB, sumber, pesan, beberapa field penting:
//   19:04:05  scanner  scan #57: 120/120 seri mutakhir · harga live 120 seri · sinyal terbuka LONG 4 · SHORT 2 · radar 38
// plus banner alamat website & status scanner saat server siap, dan pembuka browser (OPEN_BROWSER).
// Mode JSON (stdout bukan terminal, atau LOG_FORMAT=json) tidak memakai modul ini: log tetap JSON per baris untuk mesin.
// Keamanan: teks dari log (dapat memuat pesan Binance / input request) dibersihkan dari karakter kontrol & bidi sebelum
// dicetak, sehingga tidak dapat menyisipkan escape terminal; warna ANSI hanya disisipkan modul ini sendiri.

import { spawn as nodeSpawn } from 'node:child_process';

/** Zona tampilan sama dengan website (frontend/js/lib/format.js): WIB, UTC+7 tanpa DST. */
const DISPLAY_TZ_OFFSET_MS = 7 * 3_600_000;
const PINO_LEVELS = Object.freeze({ 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' });
const LEVEL_TAG = Object.freeze({ trace: 'TRACE', debug: 'DEBUG', warn: 'PERINGATAN', error: 'GALAT', fatal: 'FATAL' });
// Field yang tidak pernah dicetak: kerangka pino/worker, identitas proses, dan objek request/response mentah.
const SKIP = new Set(['time', 'level', 'msg', 'pid', 'hostname', 'v', 'module', 'reqId', 'req', 'res', 'responseTime', 'owner']);
// Baris info hanya mencetak field ini (pesan info sudah ditulis untuk manusia); warn/galat mencetak semua field.
const INFO_FIELDS = new Set(['state', 'via', 'attempt', 'workerPid', 'symbol', 'timeframe', 'reason', 'code', 'binanceDns', 'applied', 'schemaVersion']);
const MAX_FIELDS = 8;
const MAX_VALUE = 80;
const MAX_LINE = 1_000;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

const ANSI = Object.freeze({ dim: '\u001b[2m', reset: '\u001b[0m', yellow: '\u001b[33m', red: '\u001b[31m', cyan: '\u001b[36m', green: '\u001b[32m', bold: '\u001b[1m' });

const clean = (text) => String(text).replace(CONTROL_CHARS, ' ').replace(/\n/g, ' ');
const pad = (n) => String(n).padStart(2, '0');

/** Jam WIB HH:MM:SS dari ISO string / epoch ms; null bila tidak dapat dibaca. */
export function wibClock(time) {
  const ms = typeof time === 'number' ? time : typeof time === 'string' ? Date.parse(time) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + DISPLAY_TZ_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Mode tampilan log: teks ringkas bila LOG_FORMAT=pretty, atau `auto` dan stdout adalah terminal interaktif.
 * @param {'auto'|'pretty'|'json'} format
 * @param {{ isTTY?: boolean }} [stream]
 */
export function usePrettyLogs(format, stream = process.stdout) {
  return format === 'pretty' || (format === 'auto' && stream?.isTTY === true);
}

/** Warna ANSI hanya untuk terminal interaktif tanpa NO_COLOR (https://no-color.org). */
export function useColor(stream = process.stdout, env = process.env) {
  return stream?.isTTY === true && !env.NO_COLOR && env.TERM !== 'dumb';
}

function value(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x))).join(',');
  if (typeof v === 'object' && typeof v.message === 'string') return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return '[objek]';
  }
}

function fieldsOf(entry, level) {
  const out = [];
  for (const [key, raw] of Object.entries(entry)) {
    if (SKIP.has(key) || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue;
    if (level === 'info' && !INFO_FIELDS.has(key)) continue;
    let text = clean(value(raw));
    if (text.length > MAX_VALUE) text = `${text.slice(0, MAX_VALUE - 1)}…`;
    out.push(`${key}=${text}`);
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

const SCOPES = Object.freeze({ 'smart-money': 'smart money', 'worker-supervisor': 'server' });

/**
 * Satu baris log JSON → teks ringkas (tanpa newline). Baris yang bukan JSON dicetak apa adanya (dibersihkan).
 * Mengembalikan null untuk baris kosong.
 * @param {string} line
 * @param {{ scope?: string, color?: boolean }} [options] scope: sumber default ('server' / 'scanner')
 */
export function formatLogLine(line, { scope = 'server', color = false } = {}) {
  const raw = String(line ?? '').trim();
  if (raw === '') return null;
  let entry = null;
  if (raw.startsWith('{')) {
    try {
      entry = JSON.parse(raw);
    } catch {
      entry = null;
    }
  }
  const paint = (code, text) => (color ? `${code}${text}${ANSI.reset}` : text);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${paint(ANSI.dim, '        ')}  ${paint(ANSI.dim, scope.padEnd(7))}  ${clean(raw).slice(0, MAX_LINE)}`;
  }
  const level = typeof entry.level === 'number' ? (PINO_LEVELS[entry.level] ?? 'info') : (typeof entry.level === 'string' ? entry.level : 'info');
  const clock = wibClock(entry.time) ?? '--:--:--';
  const who = SCOPES[entry.module] ?? scope;
  const tag = LEVEL_TAG[level];
  const msg = clean(typeof entry.msg === 'string' && entry.msg !== '' ? entry.msg : '(tanpa pesan)');
  const extras = fieldsOf(entry, level);
  const tone = level === 'warn' ? ANSI.yellow : level === 'error' || level === 'fatal' ? ANSI.red : null;
  const head = tag ? `${tag} ` : '';
  const body = `${head}${msg}${extras.length ? `  · ${extras.join(' ')}` : ''}`.slice(0, MAX_LINE);
  const whoColor = who === 'scanner' ? ANSI.green : ANSI.cyan;
  return `${paint(ANSI.dim, clock)}  ${paint(whoColor, who.padEnd(7))}  ${tone ? paint(tone, body) : body}`;
}

/**
 * Stream tujuan logger Fastify/pino (opsi `stream`): setiap baris JSON dicetak sebagai teks ringkas.
 * @param {{ write?: (text: string) => void, scope?: string, color?: boolean }} [options]
 */
export function createPrettyStream({ write = (text) => process.stdout.write(text), scope = 'server', color = false } = {}) {
  return {
    write(chunk) {
      for (const line of String(chunk).split('\n')) {
        const text = formatLogLine(line, { scope, color });
        if (text !== null) write(`${text}\n`);
      }
      return true;
    },
  };
}

/**
 * Banner saat server siap: alamat website, status scanner NYATA (state supervisor), cara berhenti.
 * @param {{ origin: string, workerControl: boolean, workerAutostart: boolean, scannerState?: string|null,
 *   openBrowser: boolean, color?: boolean, timeframes?: { long: string, short: string } }} options
 *   scannerState: state supervisor saat banner dicetak (running | starting | external | crashed | stopped …).
 * @returns {string} beberapa baris diakhiri newline
 */
export function formatBanner({
  origin, workerControl, workerAutostart, scannerState = null, openBrowser, color = false, timeframes = { long: '1h', short: '15m' },
}) {
  const paint = (code, text) => (color ? `${code}${text}${ANSI.reset}` : text);
  const rule = paint(ANSI.dim, '─'.repeat(64));
  const scope = `LONG ${timeframes.long} (SA/PVA) · SHORT ${timeframes.short} (SD/PVD)`;
  const running = scannerState === 'running' || scannerState === 'starting';
  let scanner;
  if (!workerControl) scanner = 'tidak dijalankan dari website (WORKER_CONTROL=false) — jalankan `npm run worker` di terminal lain';
  else if (running) scanner = `${workerAutostart ? 'dijalankan otomatis' : 'berjalan'} — ${scope}`;
  else if (scannerState === 'external') scanner = `sudah berjalan di luar website (mis. npm run worker) — ${scope}`;
  else if (scannerState === 'crashed') scanner = 'gagal dijalankan — dicoba ulang otomatis, lihat log di bawah';
  else scanner = 'belum berjalan — tekan "Jalankan scanner" di website (atau set WORKER_AUTOSTART=true di .env)';
  const lines = [
    rule,
    `  ${paint(ANSI.bold, 'AlphaLens berjalan')}  →  ${paint(ANSI.cyan, origin)}`,
    `  Scanner : ${scanner}`,
  ];
  if (workerControl && (running || scannerState === 'external')) {
    lines.push('            semua koin dipindai tiap 1 menit; ringkasan "scan #n" tampil di bawah tiap menit');
  }
  lines.push(`  ${openBrowser ? 'Browser dibuka otomatis. ' : ''}Status scanner juga tampil di strip atas website. Hentikan: Ctrl+C.`);
  lines.push(rule);
  return `${lines.join('\n')}\n`;
}

/** true bila proses dijalankan `node --watch` (npm run dev): child watch mode mendapat WATCH_REPORT_DEPENDENCIES. */
export function isWatchMode(env = process.env) {
  return env.WATCH_REPORT_DEPENDENCIES !== undefined;
}

/** Perintah pembuka URL di browser default per platform (tanpa shell; argumen terpisah). */
export function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Membuka `url` di browser default bila OPEN_BROWSER aktif, stdout terminal interaktif, dan bukan watch mode
 * (`npm run dev` memuat ulang server setiap file berubah — tidak membuka tab baru tiap kali).
 * URL hanya dari APP_ORIGIN yang sudah divalidasi (skema http/https, tanpa path/query).
 * @returns {boolean} true bila perintah pembuka dijalankan
 */
export function openBrowser(url, {
  enabled, isTTY = process.stdout.isTTY === true, env = process.env, platform = process.platform, spawn = nodeSpawn, logger,
} = {}) {
  if (!enabled || !isTTY || isWatchMode(env)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const { command, args } = browserCommand(parsed.href, platform);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on?.('error', (err) => logger?.warn?.({ err: err?.message }, 'browser tidak dapat dibuka otomatis — buka alamat di atas secara manual'));
    child.unref?.();
    return true;
  } catch (err) {
    logger?.warn?.({ err: err?.message }, 'browser tidak dapat dibuka otomatis — buka alamat di atas secara manual');
    return false;
  }
}
