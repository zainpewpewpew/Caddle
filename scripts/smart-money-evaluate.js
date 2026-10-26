// Evaluasi historis Insider / Smart Money Radar dari data TERSIMPAN (tanpa look-ahead — backend/smartmoney/evaluate.js).
//   npm run smart-money:evaluate                         → 60 hari terakhir, titik setiap 6 jam, ≥ 3 pembeli independen
//   npm run smart-money:evaluate -- --days 90 --step-hours 12 --min-buyers 4
//   npm run smart-money:evaluate -- --no-save            → cetak saja, jangan simpan
// Harga masuk/keluar = harga tersirat dari swap wallet yang dilacak (prices.js): kasar (mengandung slippage & fee),
// bukan harga eksekusi. Rentang titik: mulai paling cepat 30 hari setelah aktivitas pertama (pemanasan skor wallet:
// skor di titik t hanya dari data sebelum t), berakhir di aktivitas terakhir dikurangi horizon terpanjang (agar return
// setiap horizon dapat diukur). Data terlalu tipis → penjelasan sopan, kode keluar 0, TIDAK ada laporan yang disimpan.
// Laporan dicetak sebagai Markdown dan disimpan ke database (tampil di menu Smart Money → Evaluasi historis,
// GET /api/smart-money/evaluation) kecuali --no-save. Data simulasi tetap ditandai DATA SIMULASI di laporan.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../backend/app/config.js';
import { openDatabase } from '../backend/database/connection.js';
import { migrate } from '../backend/database/migrate.js';
import { DEFAULT_EVALUATION_PARAMS, evaluateHistorically, formatEvaluationMarkdown } from '../backend/smartmoney/evaluate.js';
import { buildImpliedPriceIndex } from '../backend/smartmoney/prices.js';
import { createSmartMoneyRepository } from '../backend/smartmoney/repository.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Teks bantuan `--help`. */
export const EVALUATE_USAGE = `Pemakaian: npm run smart-money:evaluate -- [opsi]

Menguji secara historis apakah token yang diakumulasi beberapa wallet independen (radar smart money) bergerak lebih baik
daripada baseline — memakai data yang sudah disinkronkan (npm run smart-money:sync), tanpa look-ahead.

Opsi:
  --days 60          panjang rentang titik evaluasi terakhir dalam hari (7..180; bawaan 60)
  --step-hours 6     jarak antar titik evaluasi dalam jam (1..24; bawaan 6)
  --min-buyers 3     syarat sinyal: minimal pembeli independen (1..100; bawaan 3)
  --no-save          cetak laporan saja, jangan simpan ke database
  -h, --help         tampilkan bantuan ini
`;

/**
 * Ambang minimal data agar evaluasi bermakna (HIPOTESIS AWAL). Di bawah ini skrip menolak dengan sopan.
 * minSpanDays = pemanasan 30 hari + horizon terpanjang 3 hari + ±12 hari titik evaluasi.
 */
export const THIN_DATA = Object.freeze({ minActivities: 200, minWallets: 5, minSpanDays: 45 });

/** Pemanasan sebelum titik pertama: skor & kelayakan wallet butuh riwayat trade tertutup. */
export const EVALUATION_WARMUP_MS = 30 * DAY_MS;

const OPTIONS = Object.freeze({
  days: { type: 'string', default: '60' },
  'step-hours': { type: 'string', default: '6' },
  'min-buyers': { type: 'string', default: String(DEFAULT_EVALUATION_PARAMS.minIndependentBuyers) },
  'no-save': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
});

function integer(name, text, { min, max }) {
  const s = String(text ?? '').trim();
  if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) {
    throw new RangeError(`--${name} harus bilangan bulat ${min}..${max} (diberikan: ${s.slice(0, 20)})`);
  }
  return Number(s);
}

/**
 * Parse argumen CLI evaluasi.
 * @param {string[]} argv argumen setelah nama skrip (process.argv.slice(2))
 * @returns {{ help: boolean, days: number, stepHours: number, minBuyers: number, save: boolean }}
 * @throws {TypeError|RangeError} pesan bahasa Indonesia untuk argumen tidak valid
 */
export function parseEvaluateArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true });
  } catch (err) {
    throw new TypeError(`Opsi tidak dikenal atau tidak valid: ${err.message}`, { cause: err });
  }
  const v = parsed.values;
  if (v.help) return { help: true, days: 60, stepHours: 6, minBuyers: DEFAULT_EVALUATION_PARAMS.minIndependentBuyers, save: false };
  return {
    help: false,
    days: integer('days', v.days, { min: 7, max: 180 }),
    stepHours: integer('step-hours', v['step-hours'], { min: 1, max: 24 }),
    minBuyers: integer('min-buyers', v['min-buyers'], { min: 1, max: 100 }),
    save: !v['no-save'],
  };
}

/**
 * Nilai kecukupan data tersimpan untuk evaluasi.
 * @param {Array<{ chain: string, wallet: string, blockTime: number }>} activities
 * @param {typeof THIN_DATA} [thresholds]
 * @returns {{ ok: boolean, activities: number, wallets: number, firstAt: number|null, lastAt: number|null,
 *   spanDays: number, reasons: string[] }} reasons = alasan (Bahasa Indonesia) bila data terlalu tipis
 */
export function assessData(activities, thresholds = THIN_DATA) {
  const list = Array.isArray(activities) ? activities : [];
  const wallets = new Set();
  let firstAt = null;
  let lastAt = null;
  for (const a of list) {
    wallets.add(`${a.chain}:${a.wallet}`);
    if (Number.isFinite(a.blockTime)) {
      if (firstAt === null || a.blockTime < firstAt) firstAt = a.blockTime;
      if (lastAt === null || a.blockTime > lastAt) lastAt = a.blockTime;
    }
  }
  const spanDays = firstAt === null ? 0 : (lastAt - firstAt) / DAY_MS;
  const reasons = [];
  if (list.length < thresholds.minActivities) reasons.push(`baru ${list.length} aktivitas tersimpan (minimal ${thresholds.minActivities})`);
  if (wallets.size < thresholds.minWallets) reasons.push(`baru ${wallets.size} wallet dengan aktivitas (minimal ${thresholds.minWallets})`);
  if (spanDays < thresholds.minSpanDays) {
    reasons.push(`rentang data baru ${spanDays.toFixed(1).replace('.', ',')} hari (minimal ${thresholds.minSpanDays} hari: pemanasan skor 30 hari + horizon + titik evaluasi)`);
  }
  return { ok: reasons.length === 0, activities: list.length, wallets: wallets.size, firstAt, lastAt, spanDays, reasons };
}

/**
 * Rentang titik evaluasi [start, end): start ≥ aktivitas pertama + pemanasan, end = aktivitas terakhir + 1 ms −
 * horizon terpanjang (dibatasi `now`), dan paling lama `days` hari. Kedua ujung dibulatkan ke jam penuh (UTC).
 * @param {{ firstAt: number, lastAt: number, days: number, now: number, maxHorizonMs?: number, warmupMs?: number }} input
 * @returns {{ start: number, end: number }|null} null bila rentang kosong
 */
export function evaluationRange({ firstAt, lastAt, days, now, maxHorizonMs = Math.max(...DEFAULT_EVALUATION_PARAMS.horizonsMs), warmupMs = EVALUATION_WARMUP_MS }) {
  if (![firstAt, lastAt, days, now].every(Number.isFinite)) return null;
  const end = Math.floor((Math.min(lastAt, now) + 1 - maxHorizonMs) / HOUR_MS) * HOUR_MS;
  const start = Math.ceil(Math.max(firstAt + warmupMs, end - days * DAY_MS) / HOUR_MS) * HOUR_MS;
  return start < end ? { start, end } : null;
}

function thinDataMessage(assessment) {
  return [
    'Data smart money belum cukup untuk evaluasi historis yang bermakna — tidak ada laporan yang disimpan.',
    ...assessment.reasons.map((r) => `- ${r}`),
    '- Jalankan sinkronisasi lebih lama dulu (npm run smart-money:sync, atau scanner dengan SMART_MONEY_PROVIDERS terisi), lalu coba lagi.',
    '- Evaluasi dengan sampel kecil hanya akan menghasilkan angka acak yang tampak meyakinkan; karena itu skrip menolak.',
  ].join('\n');
}

const fmtTime = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Jalankan CLI evaluasi.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string|undefined>, out?: (text: string) => void, err?: (text: string) => void,
 *   clock?: () => number, thresholds?: typeof THIN_DATA }} [deps]
 * @returns {Promise<number>} kode keluar (0 = laporan dibuat ATAU data terlalu tipis; 1 = argumen/konfigurasi tidak valid)
 */
export async function main(argv = process.argv.slice(2), {
  env = process.env,
  out = (text) => process.stdout.write(`${text}\n`),
  err = (text) => process.stderr.write(`${text}\n`),
  clock = Date.now,
  thresholds = THIN_DATA,
} = {}) {
  let args;
  try {
    args = parseEvaluateArgs(argv);
  } catch (e) {
    err(`${e.message}\n\n${EVALUATE_USAGE}`);
    return 1;
  }
  if (args.help) {
    out(EVALUATE_USAGE);
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

  const db = openDatabase(config.databasePath);
  try {
    migrate(db);
    const repo = createSmartMoneyRepository(db, { clock });
    const activities = await repo.listAllActivities();
    const assessment = assessData(activities, thresholds);
    if (!assessment.ok) {
      out(thinDataMessage(assessment));
      return 0;
    }
    const now = Math.floor(clock());
    const range = evaluationRange({ firstAt: assessment.firstAt, lastAt: assessment.lastAt, days: args.days, now });
    if (range === null) {
      out(thinDataMessage({ reasons: ['rentang data setelah pemanasan 30 hari dan horizon terpanjang kosong'] }));
      return 0;
    }
    const isSimulated = activities.some((a) => a.isSimulated === true);
    err(`Mengevaluasi ${assessment.activities} aktivitas dari ${assessment.wallets} wallet · titik ${fmtTime(range.start)} → ${fmtTime(range.end)}`
      + ` setiap ${args.stepHours} jam${isSimulated ? ' · DATA SIMULASI' : ''}…`);
    const report = evaluateHistorically({
      activities,
      priceAt: buildImpliedPriceIndex(activities).priceAt,
      start: range.start,
      end: range.end,
      stepMs: args.stepHours * HOUR_MS,
      minIndependentBuyers: args.minBuyers,
      labels: await repo.getLabels(),
    });
    out(formatEvaluationMarkdown(report));
    if (args.save) {
      const id = await repo.saveEvaluation({ computedAt: now, params: report.params, report, isSimulated });
      err(`Laporan disimpan (id ${id}) — tampil di menu Smart Money → Evaluasi historis.`);
    } else {
      err('Laporan tidak disimpan (--no-save).');
    }
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`Evaluasi smart money gagal: ${e?.message ?? String(e)}\n`);
    process.exitCode = 1;
  });
}
