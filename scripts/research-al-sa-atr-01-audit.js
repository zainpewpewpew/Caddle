// Audit integritas data AL-SA-ATR-01 (docs/26 §10, adendum 1). Riset saja: tidak menyentuh database, worker, atau
// scanner live. File ini DI LUAR hash pohon beku (docs/26 §8), jadi tidak dapat memengaruhi P0–P4. Audit ini TIDAK
// menghitung atau menampilkan R, win rate, atau hasil trade apa pun.
//
// Pakai (setiap tanggal 1, cutoff sama dengan `--mode count`). Skrip ini tidak ada di commit beku, jadi dijalankan
// dari `main`; count/evaluate tetap dari checkout commit beku dengan folder cache yang sama (`--cache-dir`):
//   npm run research:al-sa-atr-01-audit -- --to 2026-12-01
//
// Per simbol beku:
//   1. kline 1h jendela (rentang sama dengan evaluate): status muat, candle pertama/terakhir, celah, data berhenti dini;
//   2. funding jendela: dimuat agar bulan lengkap ter-cache SEBELUM simbol mungkin delisting (mode count tidak memuat
//      funding, dan evaluate tidak menangkap kegagalan funding);
//   3. bulan kohort (Okt 2025): dimuat dengan cara yang sama seperti evaluate;
//   4. bulan lengkap tanpa candle yang seluruhnya SEBELUM listing (candle pertama dari Binance) ditulis sebagai file
//      cache bulan kosong, agar evaluate tidak perlu memanggil API untuk bulan itu. File yang ada tidak pernah ditimpa;
//   5. status exchangeInfo (TRADING, SETTLING, ..., atau tidak ada lagi);
//   6. replay seperti evaluate → jumlah trade kelompok filter/pelengkap (harus sama dengan `--mode count`) dan trade
//      yang tetap terbuka beserta penyebabnya.

import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CACHE_FORMAT_VERSION, DEFAULT_CACHE_DIR, cacheFilePath, findGaps, loadFromBinance, monthsInRange,
} from '../backend/backtest/dataSource.js';
import { loadFundingRates } from '../backend/backtest/funding.js';
import { replaySeries } from '../backend/backtest/runner.js';
import { createBinanceRestClient } from '../backend/ingestion/binance/restClient.js';
import { atr } from '../backend/indicators/index.js';
import { TIMEFRAME_MS } from '../backend/market/contracts.js';
import { AL_SA_ATR_01, preMoveAt } from '../backend/research/alSaAtr01.js';
import { onePositionPerSymbol } from '../backend/research/matchedBaseline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const H = TIMEFRAME_MS['1h'];
const DAY = 86_400_000;
// Sama dengan CACHE_FIELDS di backend/backtest/dataSource.js (tidak diekspor). readMonthCache hanya memeriksa versi,
// simbol, timeframe, dan rows; tes UNIT-ALSA-AUD-003 memastikan file kosong ini dibaca sebagai cache.
const CACHE_FIELDS = Object.freeze([
  'openTime', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'trades', 'takerBuyVolume', 'takerBuyQuoteVolume',
]);

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const errText = (err) => String(err?.message ?? err).slice(0, 160);
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Ringkasan deret kline: candle pertama/terakhir, celah, dan apakah data berhenti > 2 candle sebelum cutoff. */
export function klineStatus(candles, { cutoff, intervalMs = H }) {
  if (!candles.length) return { candles: 0, first: null, last: null, gaps: 0, missingCandles: 0, endsEarly: true };
  const gaps = findGaps(candles, intervalMs);
  return {
    candles: candles.length,
    first: candles[0].openTime,
    last: candles.at(-1).openTime,
    gaps: gaps.length,
    missingCandles: gaps.reduce((s, g) => s + g.missing, 0),
    // Lebih dari 2 candle hilang di ujung (toleransi untuk candle yang belum final tepat sesudah cutoff).
    endsEarly: cutoff - (candles.at(-1).closeTime + 1) > 2 * intervalMs,
  };
}

/** Penyebab trade yang tetap terbuka (datanya habis sebelum trade selesai). */
export function openCause({ exchangeStatus, endsEarly }) {
  if (exchangeStatus === null || exchangeStatus === undefined) return 'TIDAK_ADA_DI_EXCHANGEINFO';
  if (exchangeStatus !== 'TRADING') return `STATUS_${exchangeStatus}`;
  return endsEarly ? 'DATA_BERHENTI_SAAT_TRADING' : 'LAIN';
}

/** Isi file cache bulan kosong (format dataSource, rows []). */
export function emptyMonthCacheBody({ symbol, timeframe, monthKey }) {
  return JSON.stringify({ version: CACHE_FORMAT_VERSION, symbol, timeframe, month: monthKey, fields: CACHE_FIELDS, rows: [] });
}

/** Bulan lengkap di [from, to) yang seluruhnya sebelum listing dan belum punya file cache (kandidat bulan kosong). */
export async function preListingMonthsWithoutCache({ cacheDir, symbol, timeframe, from, to, now, listingOpenTime = Infinity }) {
  const out = [];
  for (const m of monthsInRange(from, to)) {
    if (!(m.end - 1 < now) || !(m.end <= listingOpenTime)) continue;
    if (!(await exists(cacheFilePath(cacheDir, symbol, timeframe, m.key)))) out.push(m.key);
  }
  return out;
}

/**
 * Tulis file cache bulan kosong untuk bulan lengkap di [from, to) yang SELURUHNYA sebelum candle pertama simbol
 * (listingOpenTime) dan belum punya file cache. Tidak pernah menimpa file yang ada. Mengembalikan kunci bulan yang ditulis.
 */
export async function writePreListingEmptyMonths({ cacheDir, symbol, timeframe, from, to, listingOpenTime, now }) {
  if (!Number.isFinite(listingOpenTime)) return [];
  const written = [];
  for (const key of await preListingMonthsWithoutCache({ cacheDir, symbol, timeframe, from, to, now, listingOpenTime })) {
    const file = cacheFilePath(cacheDir, symbol, timeframe, key);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, emptyMonthCacheBody({ symbol, timeframe, monthKey: key }), 'utf8');
    await rename(tmp, file);
    written.push(key);
  }
  return written;
}

/** Trade replay → catatan audit tanpa hasil trade (hanya waktu & gerak awal untuk aturan satu posisi per simbol). */
export function tradeRecord(symbol, trade, pre) {
  return { symbol, t: trade.entryTime, exitTime: trade.exitTime, pre };
}

/**
 * Audit satu cutoff. `cfg` bawaan = konstanta beku; hanya diganti untuk uji asap pada jendela lampau.
 * @returns {Promise<object>} laporan tanpa R
 */
export async function runAudit({ cfg = AL_SA_ATR_01, cutoff, client, cacheDir, now = Date.now(), onSymbol = () => {} }) {
  const end = Math.min(cutoff, cfg.maxWindowEnd) - cfg.settleBars * H;
  const loadFrom = cfg.windowStart - cfg.warmupDays * DAY;
  let statusBySymbol = new Map();
  let exchangeInfoError = null;
  try {
    statusBySymbol = new Map((await client.getExchangeInfo()).map((s) => [s.symbol, s.status]));
  } catch (err) {
    exchangeInfoError = errText(err);
  }
  const rows = [];
  const records = [];
  for (const symbol of cfg.universe) {
    const row = {
      symbol, exchangeStatus: exchangeInfoError ? 'TIDAK_DIKETAHUI' : (statusBySymbol.get(symbol) ?? null),
      klines: null, funding: null, cohort: null, listingOpenTime: null, emptyMonthsWritten: [], open: [],
    };
    let candles = null;
    try {
      ({ candles } = await loadFromBinance({ symbol, timeframe: '1h', from: loadFrom, to: cutoff, client, cacheDir, now }));
      row.klines = { ok: true, ...klineStatus(candles, { cutoff }) };
    } catch (err) {
      row.klines = { ok: false, error: errText(err) };
    }
    try {
      const { rates } = await loadFundingRates({ symbol, from: cfg.windowStart - DAY, to: cutoff, client, cacheDir, now });
      row.funding = { ok: true, n: rates.length };
    } catch (err) {
      row.funding = { ok: false, error: errText(err) };
    }
    try {
      const { candles: old } = await loadFromBinance({ symbol, timeframe: '1h', from: cfg.oldCohortFrom, to: cfg.oldCohortTo, client, cacheDir, now });
      row.cohort = { ok: true, candles: old.length, kohort: old.length ? 'lama' : 'baru' };
    } catch (err) {
      row.cohort = { ok: false, error: errText(err) };
    }
    // Bulan lengkap tanpa cache (API menjawab 0 candle) → tulis kosong HANYA bila seluruhnya sebelum listing.
    if (row.klines.ok && row.cohort.ok) {
      const ranges = [[cfg.oldCohortFrom, cfg.oldCohortTo], [loadFrom, cutoff]];
      const pending = [];
      for (const [from, to] of ranges) pending.push(...await preListingMonthsWithoutCache({ cacheDir, symbol, timeframe: '1h', from, to, now }));
      if (pending.length) {
        try {
          const first = await client.getKlines({ symbol, timeframe: '1h', startTime: 0, limit: 1 });
          row.listingOpenTime = first[0]?.openTime ?? null;
          for (const [from, to] of ranges) {
            row.emptyMonthsWritten.push(...await writePreListingEmptyMonths({
              cacheDir, symbol, timeframe: '1h', from, to, listingOpenTime: row.listingOpenTime ?? NaN, now,
            }));
          }
        } catch (err) {
          row.listingError = errText(err);
        }
      }
    }
    if (candles?.length) {
      const res = await replaySeries({
        symbol, timeframe: '1h', byTf: { '1h': candles },
        options: { targetR: cfg.targetR, maxBars: cfg.maxBars, feeBps: cfg.feeBps, slippageBps: cfg.slippageBps, entry: cfg.entry },
      });
      const A = atr(candles, cfg.atrPeriod);
      for (const t of res.trades.v3) {
        if (t.direction !== cfg.direction) continue;
        const signal = candles[t.entryIndex];
        if (signal.openTime < cfg.windowStart || signal.openTime >= end) continue;
        const pre = preMoveAt(candles, A, t.entryIndex, cfg.look);
        if (t.outcome === 'OPEN') {
          row.open.push({
            signalTime: iso(signal.closeTime),
            group: pre === null ? null : pre >= cfg.preThresholdAtr ? 'filter' : 'pelengkap',
            cause: openCause({ exchangeStatus: row.exchangeStatus, endsEarly: row.klines.endsEarly }),
          });
          continue;
        }
        if (pre === null) continue;
        records.push(tradeRecord(symbol, t, pre));
      }
    }
    rows.push(row);
    onSymbol(row);
  }
  const filtered = onePositionPerSymbol(records.filter((r) => r.pre >= cfg.preThresholdAtr));
  const complement = onePositionPerSymbol(records.filter((r) => r.pre < cfg.preThresholdAtr));
  const countBy = (list) => list.reduce((m, r) => m.set(r.symbol, (m.get(r.symbol) ?? 0) + 1), new Map());
  const fBy = countBy(filtered);
  const cBy = countBy(complement);
  for (const row of rows) row.trades = { filter: fBy.get(row.symbol) ?? 0, pelengkap: cBy.get(row.symbol) ?? 0, terbuka: row.open.length };

  const failed = rows.filter((r) => !r.klines.ok || !r.funding.ok || !r.cohort.ok).map((r) => r.symbol);
  const issues = [
    ...(exchangeInfoError ? [`exchangeInfo gagal dimuat: ${exchangeInfoError}`] : []),
    ...rows.filter((r) => !r.klines.ok).map((r) => `${r.symbol}: kline gagal dimuat (${r.klines.error})`),
    ...rows.filter((r) => !r.funding.ok).map((r) => `${r.symbol}: funding gagal dimuat (${r.funding.error})`),
    ...rows.filter((r) => !r.cohort.ok).map((r) => `${r.symbol}: bulan kohort gagal dimuat (${r.cohort.error})`),
    ...rows.filter((r) => r.listingError).map((r) => `${r.symbol}: candle pertama gagal dibaca (${r.listingError})`),
    ...rows.filter((r) => r.klines.ok && r.klines.endsEarly).map((r) => `${r.symbol}: data berhenti ${iso(r.klines.last)} (sebelum cutoff)`),
    ...rows.filter((r) => !exchangeInfoError && r.exchangeStatus !== 'TRADING').map((r) => `${r.symbol}: status exchangeInfo ${r.exchangeStatus ?? 'tidak ada'}`),
    ...rows.filter((r) => r.open.length).map((r) => `${r.symbol}: ${r.open.length} trade tetap terbuka (${[...new Set(r.open.map((o) => o.cause))].join(', ')})`),
  ];
  return {
    id: cfg.id, mode: 'audit-data', generatedAt: iso(now), cutoff: iso(cutoff), signalWindowEnd: iso(end),
    nFiltered: filtered.length, nComplement: complement.length, nRequired: cfg.nRequired,
    openTotal: rows.reduce((s, r) => s + r.open.length, 0),
    symbolsWithGaps: rows.filter((r) => r.klines.ok && r.klines.gaps > 0).length,
    emptyMonthsWritten: rows.reduce((s, r) => s + r.emptyMonthsWritten.length, 0),
    // Siap evaluasi = evaluate tidak akan melewatkan simbol atau gagal karena data (kline, funding, kohort termuat).
    ready: failed.length === 0, failed, issues, exchangeInfoError, symbols: rows,
  };
}

const yes = (b) => (b ? 'ya' : 'GAGAL');

export function renderAuditMarkdown(r) {
  const md = [
    `# Audit data ${r.id} — ${r.ready ? 'siap evaluasi' : 'BELUM SIAP'}`,
    '',
    `Dibuat ${r.generatedAt} · cutoff data ${r.cutoff} · sinyal s/d ${r.signalWindowEnd}. Tanpa R atau hasil trade (docs/26 §10).`,
    '',
    `Trade kelompok filter ${r.nFiltered} / ${r.nRequired} wajib · pelengkap ${r.nComplement} · tetap terbuka ${r.openTotal} · `
      + `simbol dengan celah ${r.symbolsWithGaps} · file bulan kosong baru ${r.emptyMonthsWritten}. Angka filter/pelengkap harus `
      + 'sama dengan `--mode count` pada cutoff yang sama.',
    '',
    '## Masalah',
    '',
    ...(r.issues.length ? r.issues.map((i) => `- ${i}`) : ['Tidak ada.']),
    '',
    '## Per simbol',
    '',
    '| Simbol | Status | Kline | Candle terakhir | Celah (candle hilang) | Funding | Kohort | Bulan kosong ditulis | Filter | Pelengkap | Terbuka |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.symbols.map((s) => `| ${s.symbol} | ${s.exchangeStatus ?? 'tidak ada'} | ${yes(s.klines.ok)} | ${iso(s.klines.last) ?? '—'} | `
      + `${s.klines.ok ? `${s.klines.gaps} (${s.klines.missingCandles})` : '—'} | ${s.funding.ok ? `ya (${s.funding.n})` : 'GAGAL'} | `
      + `${s.cohort.ok ? s.cohort.kohort : 'GAGAL'} | ${s.emptyMonthsWritten.join(', ') || '—'} | ${s.trades.filter} | ${s.trades.pelengkap} | ${s.trades.terbuka} |`),
    '',
  ];
  return md.join('\n');
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      to: { type: 'string' },
      'cache-dir': { type: 'string', default: DEFAULT_CACHE_DIR }, out: { type: 'string', default: join(ROOT, 'reports', 'research') },
    },
    strict: true,
  });
  const now = Date.now();
  const cutoff = v.to ? Date.parse(`${v.to}T00:00:00Z`) : now;
  if (!Number.isFinite(cutoff) || cutoff > now) throw new RangeError('--to harus tanggal YYYY-MM-DD yang sudah lewat');
  if (cutoff <= AL_SA_ATR_01.windowStart) throw new RangeError('Jendela data AL-SA-ATR-01 belum dimulai');
  if (cutoff > AL_SA_ATR_01.maxWindowEnd) throw new RangeError('--to melewati batas jendela praregistrasi');
  const client = createBinanceRestClient({ logger: { warn: (o, m) => log(`[binance] ${m ?? ''} ${JSON.stringify(o)}`) } });
  const report = await runAudit({
    cutoff, client, cacheDir: resolve(ROOT, v['cache-dir']), now,
    onSymbol: (s) => log(`${s.symbol}: kline ${yes(s.klines.ok)}, funding ${yes(s.funding.ok)}, kohort ${yes(s.cohort.ok)}, terbuka ${s.open.length}`),
  });
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const base = join(out, `al-sa-atr-01-audit-${slug}`);
  await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
  await writeFile(`${base}.md`, renderAuditMarkdown(report));
  log(`${report.ready ? 'Siap evaluasi' : 'BELUM SIAP'} · filter ${report.nFiltered}/${report.nRequired} · terbuka ${report.openTotal} → ${base}.md`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Audit gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
