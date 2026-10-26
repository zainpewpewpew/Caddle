// Sinkronisasi Insider / Smart Money Radar dari terminal (panduan: docs/17-panduan-smart-money.md).
//   npm run smart-money:sync              → satu putaran sinkronisasi, cetak ringkasan, keluar
//   npm run smart-money:sync -- --loop    → berulang setiap SMART_MONEY_SYNC_MINUTES sampai Ctrl+C
//   npm run smart-money:sync -- --verbose → tampilkan juga log info/debug
// Provider = SMART_MONEY_PROVIDERS (urutan = prioritas). Tanpa adapter aktif (variabel kosong, adapter belum dirakit,
// atau kunci API belum diisi) skrip menjelaskan sebabnya dan keluar dengan kode 0 TANPA menyentuh database — tidak
// pernah ada data contoh/simulasi sebagai pengganti. Kunci API tidak pernah dicetak (pesan provider disaring).
// Kode keluar: 0 = selesai (termasuk "selesai dengan catatan" / tanpa provider), 1 = konfigurasi/argumen tidak valid
// atau kesalahan internal, 130 = dibatalkan Ctrl+C sebelum putaran selesai.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../backend/app/config.js';
import { openDatabase } from '../backend/database/connection.js';
import { migrate } from '../backend/database/migrate.js';
import { createLiveProviderRegistry } from '../backend/smartmoney/providers/live.js';
import { createSmartMoneyRepository } from '../backend/smartmoney/repository.js';
import { runSmartMoneySync, sanitizeProviderMessage } from '../backend/smartmoney/sync.js';
import { createSyncDeps } from '../backend/smartmoney/syncDeps.js';
import { startSmartMoneyLoop } from '../worker/smartMoney.js';

// Dipindah ke backend (dipakai juga tombol "Sync sekarang" di server); diekspor ulang untuk pemanggil lama.
export { createSyncDeps };

/** Teks bantuan `--help`. */
export const SYNC_USAGE = `Pemakaian: npm run smart-money:sync -- [opsi]

Menyinkronkan aktivitas wallet smart money dari provider di SMART_MONEY_PROVIDERS ke database AlphaLens.

Opsi:
  --loop        jalankan berulang setiap SMART_MONEY_SYNC_MINUTES menit (bawaan 15) sampai Ctrl+C
  --verbose     tampilkan juga log info/debug (bawaan: hanya peringatan & error)
  -h, --help    tampilkan bantuan ini

Belum ada provider? Lihat docs/17-panduan-smart-money.md bagian "Mengaktifkan data live (jalur gratis)".
`;

const OPTIONS = Object.freeze({
  loop: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
});

const STATUS_TEXT = Object.freeze({
  OK: 'berhasil',
  DEGRADED: 'selesai dengan gangguan sebagian',
  NO_PROVIDERS: 'tidak ada provider aktif',
  ABORTED: 'dibatalkan sebelum selesai',
});

const EXIT_ABORTED = 130;

/**
 * Parse argumen CLI sinkronisasi.
 * @param {string[]} argv argumen setelah nama skrip (process.argv.slice(2))
 * @returns {{ loop: boolean, verbose: boolean, help: boolean }}
 * @throws {TypeError} opsi tidak dikenal / argumen posisi (pesan bahasa Indonesia)
 */
export function parseSyncArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true });
  } catch (err) {
    throw new TypeError(`Opsi tidak dikenal atau tidak valid: ${err.message}`, { cause: err });
  }
  const { loop, verbose, help } = parsed.values;
  return { loop, verbose, help };
}

/**
 * Penjelasan bila tidak ada adapter provider yang aktif (pesan untuk terminal, multi-baris).
 * @param {{ smartMoney?: { providers?: string[] } }} config konfigurasi aplikasi (loadConfig())
 * @param {{ unavailable?: () => Array<{ id: string, reason: string }> }} registry registri dari createLiveProviderRegistry
 * @returns {string}
 */
export function noProviderMessage(config, registry) {
  const ids = config?.smartMoney?.providers ?? [];
  const unavailable = typeof registry?.unavailable === 'function' ? registry.unavailable() : [];
  const lines = ['Belum ada sumber data smart money yang aktif — sinkronisasi tidak dijalankan.'];
  if (ids.length === 0) {
    lines.push('- Belum ada provider aktif: ETHERSCAN_API_KEY belum diisi di .env (mode otomatis), atau SMART_MONEY_PROVIDERS=off.');
  } else {
    lines.push(`- SMART_MONEY_PROVIDERS: ${ids.join(', ')}`);
    for (const u of unavailable) lines.push(`  · ${u.id}: ${sanitizeProviderMessage(u.reason)}`);
  }
  lines.push(
    '- Tidak ada data contoh/simulasi yang dipakai sebagai pengganti; halaman Smart Money tetap menampilkan "Belum ada sumber data".',
    '- Cara mengaktifkan data live (gratis): docs/17-panduan-smart-money.md bagian "Mengaktifkan data live (jalur gratis)".',
  );
  return lines.join('\n');
}

const fmtTime = (ms) => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');
const fmtSeconds = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1).replace('.', ',')} dtk`;

/**
 * Ringkasan satu putaran sinkronisasi untuk terminal (Bahasa Indonesia, deterministik).
 * @param {object} summary hasil runSmartMoneySync
 * @param {{ simulated?: boolean }} [options] simulated = adapter aktif memakai data simulasi (hanya tes/E2E)
 * @returns {string}
 */
export function formatSyncSummary(summary, { simulated = false } = {}) {
  if (!summary || typeof summary !== 'object') return 'Sinkronisasi smart money: tidak ada ringkasan (putaran gagal — lihat error di atas).';
  const s = summary;
  const status = STATUS_TEXT[s.status] ?? String(s.status);
  const took = Number.isFinite(s.finishedAt) && Number.isFinite(s.startedAt) ? `, ${fmtSeconds(s.finishedAt - s.startedAt)}` : '';
  const lines = [`Sinkronisasi smart money: ${status} (${fmtTime(s.finishedAt ?? s.startedAt)}${took})${simulated ? ' — DATA SIMULASI' : ''}`];
  if (s.status !== 'NO_PROVIDERS') {
    const w = s.wallets ?? {};
    lines.push(
      `- Wallet: ${w.tracked ?? 0} dilacak · ${w.selected ?? 0} dipilih · ${w.synced ?? 0} tersinkron · ${w.failed ?? 0} gagal · ${w.deferred ?? 0} ditunda`
        + `${w.skippedNoProvider ? ` · ${w.skippedNoProvider} tanpa provider` : ''}`,
      `- Transfer: ${s.fetched ?? 0} diambil · ${s.inserted ?? 0} aktivitas baru · ${s.reclassified ?? 0} diklasifikasi ulang`
        + ` · ${s.duplicates ?? 0} duplikat · ${s.rejected ?? 0} ditolak`,
      `- Alert baru: ${s.alerts ?? 0} · skor wallet diperbarui: ${s.scored ?? 0} · tautan wallet terkait: ${s.links ?? 0}`,
    );
    if (s.discovery && (s.discovery.candidates || s.discovery.added || s.discovery.skippedChains?.length)) {
      lines.push(`- Penemuan wallet: ${s.discovery.candidates} kandidat · ${s.discovery.added} wallet baru`
        + `${s.discovery.skippedChains?.length ? ` · chain dilewati: ${s.discovery.skippedChains.join(', ')}` : ''}`);
    }
    if (s.mapping?.refreshed?.length) {
      lines.push(`- Pemetaan Binance diperbarui (${s.mapping.refreshed.join(', ')}): ${s.mapping.upserted} baris · ${s.mapping.rejected} ditolak`);
    }
    for (const p of s.providers ?? []) {
      lines.push(`- Provider ${p.id}: ${p.state} · ${p.calls} panggilan · ${p.ok} berhasil · ${p.failed} gagal`
        + `${p.notSupported ? ` · ${p.notSupported} tidak didukung` : ''}${p.lastErrorCode ? ` · error terakhir ${p.lastErrorCode}` : ''}`);
    }
  }
  for (const e of s.errors ?? []) {
    const where = [e.provider, e.method, e.chain].filter(Boolean).join('/');
    lines.push(`- Error${where ? ` [${where}]` : ''}: ${e.code ?? 'ERROR'} — ${sanitizeProviderMessage(e.message ?? '')}`);
  }
  for (const n of s.notes ?? []) lines.push(`- Catatan: ${n}`);
  return lines.join('\n');
}

const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 });
const LEVEL_TEXT = Object.freeze({ trace: 'jejak', debug: 'debug', info: 'info', warn: 'peringatan', error: 'error', fatal: 'fatal' });

function fieldText(value) {
  if (value instanceof Error) return sanitizeProviderMessage(value.message);
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[objek]';
    }
  }
  return String(value);
}

/**
 * Logger ringkas untuk terminal (gaya pino `log(fields, msg)` / `log(msg, fields)`), satu baris per entri ke `write`.
 * @param {{ verbose?: boolean, write?: (line: string) => void }} [options] verbose=false → hanya warn/error/fatal
 * @returns {{ trace: Function, debug: Function, info: Function, warn: Function, error: Function, fatal: Function }}
 */
export function createCliLogger({ verbose = false, write = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const threshold = verbose ? LEVELS.debug : LEVELS.warn;
  const at = (name) => (a, b) => {
    if (LEVELS[name] < threshold) return;
    const [fields, msg] = typeof a === 'string' ? [b, a] : [a, b];
    const extra = fields && typeof fields === 'object'
      ? Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${fieldText(v)}`).join(' ')
      : '';
    write(`[${LEVEL_TEXT[name]}] ${typeof msg === 'string' ? msg : ''}${extra ? ` · ${extra}` : ''}`);
  };
  return { trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal') };
}

/** Promise yang selesai saat SIGINT/SIGTERM pertama diterima (handler dilepas lewat `dispose`). */
function signalWaiter() {
  let dispose = () => {};
  const promise = new Promise((resolveSignal) => {
    const handler = (signal) => {
      dispose();
      resolveSignal(signal);
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    dispose = () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    };
  });
  return { promise, dispose: () => dispose() };
}

/**
 * Jalankan CLI sinkronisasi.
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string|undefined>, out?: (text: string) => void, err?: (text: string) => void,
 *   clock?: () => number,
 *   createRegistry?: (config: object) => ReturnType<typeof createLiveProviderRegistry>,
 *   createRest?: () => { getKlines: Function },
 *   waitForStop?: (loop: object) => Promise<unknown>,
 * }} [deps] createRegistry/createRest/waitForStop untuk tes; bawaan = registri live dari env, REST Binance, sinyal OS.
 * @returns {Promise<number>} kode keluar
 */
export async function main(argv = process.argv.slice(2), {
  env = process.env,
  out = (text) => process.stdout.write(`${text}\n`),
  err = (text) => process.stderr.write(`${text}\n`),
  clock = Date.now,
  createRegistry,
  createRest,
  waitForStop,
} = {}) {
  let args;
  try {
    args = parseSyncArgs(argv);
  } catch (e) {
    err(`${e.message}\n\n${SYNC_USAGE}`);
    return 1;
  }
  if (args.help) {
    out(SYNC_USAGE);
    return 0;
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`Konfigurasi tidak valid: ${e.message}`);
      return 1;
    }
    throw e;
  }

  const makeRegistry = createRegistry ?? ((cfg) => createLiveProviderRegistry(cfg, { env, clock }));
  const registry = makeRegistry(config);
  if (registry.list().length === 0) {
    out(noProviderMessage(config, registry));
    return 0;
  }
  const simulated = registry.list().some((a) => a.isSimulated === true);
  const logger = createCliLogger({ verbose: args.verbose, write: err });
  const syncDeps = createSyncDeps(registry, createRest ? { createRest } : {});

  const db = openDatabase(config.databasePath);
  try {
    migrate(db);
    if (args.loop) {
      const every = config.smartMoney.syncIntervalMinutes;
      const loop = startSmartMoneyLoop({
        db, config, logger, clock, createRegistry: () => registry, initialDelayMs: 0, syncDeps,
        onRun: (summary) => out(`${formatSyncSummary(summary, { simulated })}\nPutaran berikutnya ± ${every} menit lagi — tekan Ctrl+C untuk berhenti.\n`),
      });
      out(`Loop sinkronisasi smart money aktif (setiap ${every} menit; provider: ${registry.list().map((a) => a.id).join(', ')}).`);
      const waiter = waitForStop ? null : signalWaiter();
      try {
        await (waitForStop ? waitForStop(loop) : waiter.promise);
      } finally {
        waiter?.dispose();
      }
      out('Menghentikan loop sinkronisasi (menunggu putaran yang sedang berjalan)…');
      await loop.stop();
      out('Loop sinkronisasi smart money berhenti.');
      return 0;
    }

    const repo = createSmartMoneyRepository(db, { clock });
    const controller = new AbortController();
    const waiter = waitForStop ? null : signalWaiter();
    waiter?.promise.then(() => {
      err('Membatalkan sinkronisasi… (data yang sudah tersimpan tetap utuh)');
      controller.abort();
    });
    let summary;
    try {
      summary = await runSmartMoneySync({
        repo, registry, clock, logger, config: config.smartMoney, signal: controller.signal, ...syncDeps,
      });
    } finally {
      waiter?.dispose();
    }
    out(formatSyncSummary(summary, { simulated }));
    return summary.status === 'ABORTED' ? EXIT_ABORTED : 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => {
    // exit eksplisit: koneksi keep-alive HTTP provider tidak boleh menahan proses setelah selesai.
    process.exit(code);
  }, (e) => {
    process.stderr.write(`Sinkronisasi smart money gagal: ${sanitizeProviderMessage(e?.message ?? String(e))}\n`);
    process.exit(1);
  });
}
