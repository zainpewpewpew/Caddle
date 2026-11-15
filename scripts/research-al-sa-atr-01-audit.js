// Audit integritas data AL-SA-ATR-01 (docs/26 §10–§11, adendum 1–2). Riset saja: tidak menyentuh database, worker, atau
// scanner live. File ini DI LUAR hash pohon beku (docs/26 §8), jadi tidak dapat memengaruhi P0–P4. Audit ini TIDAK
// menghitung atau menampilkan R, win rate, atau hasil trade apa pun.
//
// Rutinitas bulanan (docs/26 §11.7), cutoff tanggal 1. Skrip ini tidak ada di commit beku, jadi dijalankan dari `main`
// yang bersih; count/evaluate tetap dari checkout commit beku dengan folder cache yang sama (`--cache-dir`):
//   1. checkout beku: npm run research:al-sa-atr-01 -- --mode count --to 2026-12-01 --cache-dir <main>/data/backtest-cache
//   2. main:          npm run research:al-sa-atr-01-audit -- --to 2026-12-01 --count-report <JSON count langkah 1>
//   3. commit & push research-log/al-sa-atr-01/ hari itu juga.
//
// Per simbol beku:
//   1. kline 1h jendela (rentang sama dengan evaluate), bulan kohort (Okt 2025), dan funding jendela dimuat ke cache;
//   2. candle pertama dari Binance (startTime=0) → bulan SEBELUM_LISTING. Bulan lengkap tanpa candle yang seluruhnya
//      sebelum listing ditulis sebagai file cache kosong; file yang ada tidak pernah ditimpa. Bulan sesudah candle
//      terakhir TIDAK PERNAH ditulis kosong (§11.3);
//   3. exchangeInfo mentah (status + deliveryDate), atau catatan manual untuk simbol yang hilang dari exchangeInfo →
//      delisting terverifikasi bila mulai deliveryDate + 2 candle hanya ada candle datar bervolume 0 (§11.2);
//   4. status setiap simbol-bulan (§11.2) dan SHA-256 file cache, dibandingkan dengan manifest audit sebelumnya;
//   5. replay seperti evaluate → jumlah trade filter/pelengkap/terbuka (dicocokkan dengan laporan count), serta trade
//      yang tersentuh delisting (§11.6): (a) sinyal di candle datar, (b) melintasi waktu delisting. Tanpa R.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CACHE_FORMAT_VERSION, DEFAULT_CACHE_DIR, cacheFilePath, findGaps, loadFromBinance, monthsInRange,
} from '../backend/backtest/dataSource.js';
import { fundingCachePath, loadFundingRates } from '../backend/backtest/funding.js';
import { replaySeries } from '../backend/backtest/runner.js';
import { binanceFetch } from '../backend/ingestion/binance/network.js';
import { createBinanceRestClient } from '../backend/ingestion/binance/restClient.js';
import { atr } from '../backend/indicators/index.js';
import { TIMEFRAME_MS } from '../backend/market/contracts.js';
import { AL_SA_ATR_01, preMoveAt } from '../backend/research/alSaAtr01.js';
import { onePositionPerSymbol } from '../backend/research/matchedBaseline.js';
import { codeTreeHash, frozenTreeHash } from './research-al-sa-atr-01.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const H = TIMEFRAME_MS['1h'];
const DAY = 86_400_000;
export const DEFAULT_LOG_DIR = join(ROOT, 'research-log', 'al-sa-atr-01');
// deliveryDate perpetual yang tidak dijadwalkan delisting (2100-12-25 08:00 UTC).
export const FAR_DELIVERY = 4_133_404_800_000;
// Ekor candle datar sepanjang ini tanpa delisting terverifikasi = BELUM_TERSELESAIKAN (§11.2).
export const FLAT_TAIL_MIN = 24;
// Toleransi candle sesudah waktu delisting (candle penyelesaian bisa masih bervolume) dan di ujung data.
export const GRACE_CANDLES = 2;
export const MONTH_STATUSES = Object.freeze([
  'LENGKAP', 'CELAH', 'SEBELUM_LISTING', 'BULAN_DELISTING', 'SESUDAH_DELISTING', 'BELUM_TERSELESAIKAN', 'GAGAL_DIAMBIL',
]);
export const BLOCKING_STATUSES = Object.freeze(['BELUM_TERSELESAIKAN', 'GAGAL_DIAMBIL']);
// Sama dengan CACHE_FIELDS di backend/backtest/dataSource.js (tidak diekspor). readMonthCache hanya memeriksa versi,
// simbol, timeframe, dan rows; tes UNIT-ALSA-AUD-003 memastikan file kosong ini dibaca sebagai cache.
const CACHE_FIELDS = Object.freeze([
  'openTime', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'trades', 'takerBuyVolume', 'takerBuyQuoteVolume',
]);
const LOG_FILES = Object.freeze(['audit-{key}.json', 'audit-{key}.md', 'manifest-{key}.json']);

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const iso = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(file) {
  try {
    return sha256(await readFile(file));
  } catch {
    return null;
  }
}

/** Ganti path lokal (cache, repo, home) dengan label, supaya log yang di-commit tidak memuat path mesin (§11.5). */
export function redactPaths(text, pairs) {
  let out = String(text);
  const usable = pairs.filter(([p]) => typeof p === 'string' && p.length > 1).sort((a, b) => b[0].length - a[0].length);
  for (const [path, label] of usable) out = out.split(path).join(label);
  return out;
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
    endsEarly: cutoff - (candles.at(-1).closeTime + 1) > GRACE_CANDLES * intervalMs,
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

/** Candle datar bervolume 0 (bentuk candle Binance sesudah delisting, §11.1). */
export const isFlatZero = (c) => c.volume === 0 && c.open === c.high && c.high === c.low && c.low === c.close;

/** Ekor (sufiks) candle datar bervolume 0: openTime candle pertamanya dan panjangnya. */
export function flatTail(candles) {
  let i = candles.length;
  while (i > 0 && isFlatZero(candles[i - 1])) i -= 1;
  return i === candles.length ? { start: null, length: 0 } : { start: candles[i].openTime, length: candles.length - i };
}

/**
 * Waktu delisting dan verifikasinya (§11.2). `meta` = { status, deliveryDate } dari exchangeInfo, null bila simbol tidak
 * ada di sana; `manual` = { time, source } dari delisting-manual.json, hanya dipakai bila meta null.
 * Terverifikasi bila sejak waktu delisting + 2 candle tidak ada candle bervolume (datar bervolume 0 atau tidak ada candle).
 */
export function delistingInfo({ meta, manual = null, candles, intervalMs = H }) {
  let time = null;
  let source = null;
  if (meta && meta.status !== 'TRADING' && Number.isFinite(meta.deliveryDate) && meta.deliveryDate !== FAR_DELIVERY) {
    time = meta.deliveryDate;
    source = 'exchangeInfo';
  } else if (meta === null && manual && Number.isFinite(manual.time)) {
    time = manual.time;
    source = 'manual';
  }
  if (time === null) return { time: null, source: null, verified: false };
  const after = time + GRACE_CANDLES * intervalMs;
  return { time, source, verified: candles.every((c) => c.openTime < after || isFlatZero(c)) };
}

/**
 * Status setiap bulan satu deret candle (§11.2). `seriesFrom` = awal rentang yang dimuat (bulan pertama bisa parsial),
 * `cutoff` = akhir rentang. `tailChecks` false untuk bulan kohort, yang hanya menentukan ada/tidaknya candle.
 * @returns {Array<{ month: string, status: string, expected: number|null, candles: number, missing: number|null, zeroVolume: number, note?: string }>}
 */
export function monthStatuses({
  months, candles, seriesFrom, cutoff, listingOpenTime, delisting = null, loadOk = true, tailChecks = true, intervalMs = H,
}) {
  const tail = flatTail(candles);
  const lastEnd = candles.length ? candles.at(-1).openTime + intervalMs : -Infinity;
  const listed = Number.isFinite(listingOpenTime);
  const D = delisting?.time ?? null;
  const verified = D !== null && delisting.verified === true;
  return months.map((m) => {
    const inMonth = candles.filter((c) => c.openTime >= m.start && c.openTime < m.end);
    const base = { month: m.key, candles: inMonth.length, zeroVolume: inMonth.filter((c) => c.volume === 0).length };
    const out = (status, extra = {}) => ({ ...base, status, expected: null, missing: null, ...extra });
    if (!loadOk) return out('GAGAL_DIAMBIL');
    if (listed && m.end <= listingOpenTime) {
      return inMonth.length
        ? out('BELUM_TERSELESAIKAN', { note: 'ada candle sebelum candle pertama Binance' })
        : out('SEBELUM_LISTING', { expected: 0, missing: 0 });
    }
    if (!listed && !inMonth.length) return out('BELUM_TERSELESAIKAN', { note: 'waktu listing tidak diketahui' });
    const end = Math.min(m.end, cutoff);
    if (verified && m.start >= D) return out('SESUDAH_DELISTING');
    if (D !== null && !verified && end > D) return out('BELUM_TERSELESAIKAN', { note: `delisting ${iso(D)} belum terverifikasi` });
    const from = Math.max(m.start, seriesFrom ?? m.start, listed ? listingOpenTime : m.start);
    const to = verified ? Math.min(end, D) : end;
    const expected = Math.max(0, Math.ceil((to - from) / intervalMs));
    const present = inMonth.filter((c) => c.openTime >= from && c.openTime < to).length;
    const counts = { expected, missing: Math.max(0, expected - present) };
    if (verified && m.start < D && D < m.end) return out('BULAN_DELISTING', counts);
    if (tailChecks && !verified) {
      if (tail.length >= FLAT_TAIL_MIN && to > tail.start) {
        return out('BELUM_TERSELESAIKAN', { ...counts, note: `ekor ${tail.length} candle datar bervolume 0 sejak ${iso(tail.start)}` });
      }
      if (to - lastEnd > GRACE_CANDLES * intervalMs) {
        return out('BELUM_TERSELESAIKAN', { ...counts, note: `data berhenti ${iso(Number.isFinite(lastEnd) ? lastEnd : null) ?? 'sebelum bulan ini'}` });
      }
    }
    return out(counts.missing > 0 ? 'CELAH' : 'LENGKAP', counts);
  });
}

/** Cocokkan jumlah trade audit dengan laporan `--mode count` checkout beku (§11.2 butir 3). */
export function checkCountParity(count, audit) {
  if (!count) return { checked: false, ok: false, reasons: ['laporan count tidak diberikan (--count-report)'], count: null };
  const reasons = [];
  if (count.id !== audit.id) reasons.push(`id laporan ${count.id} ≠ ${audit.id}`);
  if (count.mode !== 'count') reasons.push(`mode laporan ${count.mode}, bukan count`);
  if (count.cutoff !== audit.cutoff) reasons.push(`cutoff count ${count.cutoff} ≠ audit ${audit.cutoff}`);
  if (count.signalWindowEnd !== audit.signalWindowEnd) reasons.push(`akhir sinyal count ${count.signalWindowEnd} ≠ audit ${audit.signalWindowEnd}`);
  if (count.hashesMatch !== true) reasons.push('count tidak dijalankan pada pohon kode beku (hashesMatch bukan true)');
  for (const [key, label, value] of [['nFiltered', 'filter', audit.nFiltered], ['nComplement', 'pelengkap', audit.nComplement], ['openAtCutoff', 'terbuka', audit.openTotal]]) {
    if (count[key] !== value) reasons.push(`${label}: count ${count[key]} ≠ audit ${value}`);
  }
  return {
    checked: true, ok: reasons.length === 0, reasons,
    count: {
      generatedAt: count.generatedAt ?? null, nFiltered: count.nFiltered ?? null, nComplement: count.nComplement ?? null,
      openAtCutoff: count.openAtCutoff ?? null, hashesMatch: count.hashesMatch ?? null, tree: count.tree?.hash ?? null,
      skipped: Array.isArray(count.skipped) ? count.skipped.length : null,
    },
  };
}

/** File cache yang hash-nya berubah atau hilang dibanding manifest sebelumnya (§11.2 butir 4). */
export function compareManifests(prev, curr) {
  const entries = (m) => [...(m?.months ?? []), ...(m?.funding ?? [])].filter((e) => typeof e.file === 'string');
  const now = new Map(entries(curr).map((e) => [e.file, e.sha256 ?? null]));
  const changed = [];
  const missing = [];
  for (const e of entries(prev)) {
    if (!e.sha256 || !now.has(e.file)) continue;
    const after = now.get(e.file);
    if (after === null) missing.push(e.file);
    else if (after !== e.sha256) changed.push({ file: e.file, before: e.sha256, after });
  }
  return { changed, missing };
}

/** Manifest terakhir di folder log (urut tanggal cutoff lalu nomor audit ulang), atau null. */
export async function latestManifest(logDir) {
  let names;
  try {
    names = await readdir(logDir);
  } catch {
    return null;
  }
  const last = names
    .map((n) => n.match(/^manifest-(\d{4}-\d{2}-\d{2})(?:-r(\d+))?\.json$/))
    .filter(Boolean)
    .map((m) => ({ name: m[0], date: m[1], rev: Number(m[2] ?? 1) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rev - b.rev))
    .at(-1);
  return last ? { name: last.name, manifest: JSON.parse(await readFile(join(logDir, last.name), 'utf8')) } : null;
}

/** Verifikasi delisting manual (§11.2): research-log/al-sa-atr-01/delisting-manual.json, array { symbol, deliveryTime, source }. */
export async function readManualDelistings(logDir) {
  let raw;
  try {
    raw = await readFile(join(logDir, 'delisting-manual.json'), 'utf8');
  } catch {
    return new Map();
  }
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new TypeError('delisting-manual.json harus berupa array');
  const out = new Map();
  for (const e of list) {
    const time = Date.parse(e?.deliveryTime);
    if (typeof e?.symbol !== 'string' || !Number.isFinite(time) || typeof e?.source !== 'string' || !e.source.startsWith('https://')) {
      throw new TypeError(`Entri delisting manual tidak valid: ${JSON.stringify(e).slice(0, 160)}`);
    }
    out.set(e.symbol, { time, source: e.source, recordedAt: e.recordedAt ?? null });
  }
  return out;
}

/** Tulis laporan & manifest tanpa pernah menimpa: cutoff yang sudah ada mendapat akhiran -r2, -r3, ... (§11.5). */
export async function writeLogFiles({ logDir, key, bodies }) {
  if (bodies.length !== LOG_FILES.length) throw new TypeError('bodies harus sesuai LOG_FILES');
  await mkdir(logDir, { recursive: true });
  for (let rev = 1; rev < 100; rev += 1) {
    const names = LOG_FILES.map((tpl) => tpl.replace('{key}', `${key}${rev === 1 ? '' : `-r${rev}`}`));
    if ((await Promise.all(names.map((n) => exists(join(logDir, n))))).some(Boolean)) continue;
    for (const [i, name] of names.entries()) await writeFile(join(logDir, name), bodies[i], { encoding: 'utf8', flag: 'wx' });
    return { rev, files: names };
  }
  throw new Error(`Terlalu banyak audit ulang untuk cutoff ${key}`);
}

/** exchangeInfo mentah: status dan deliveryDate per simbol (parser klien membuang deliveryDate). */
export async function fetchExchangeMeta({ fetchImpl = binanceFetch } = {}) {
  const res = await fetchImpl('https://fapi.binance.com/fapi/v1/exchangeInfo', { signal: AbortSignal.timeout(30_000) });
  if (res.status !== 200) throw new Error(`exchangeInfo HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.symbols)) throw new Error('respons exchangeInfo tanpa array symbols');
  return new Map(body.symbols.filter((s) => typeof s?.symbol === 'string').map((s) => [s.symbol, {
    status: String(s.status), deliveryDate: Number(s.deliveryDate), onboardDate: Number(s.onboardDate),
  }]));
}

/** Versi audit (§11.5): SHA-256 skrip, commit & kebersihan pohon kerja main, hash pohon main vs beku, versi Node. */
export async function auditVersion({ run = execFileSync } = {}) {
  const git = (args) => {
    try {
      return String(run('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    } catch {
      return null;
    }
  };
  const status = git(['status', '--porcelain']);
  const tree = await codeTreeHash();
  const frozen = await frozenTreeHash();
  return {
    scriptSha256: await sha256File(fileURLToPath(import.meta.url)),
    gitCommit: git(['rev-parse', 'HEAD']),
    gitClean: status === null ? null : status === '',
    mainTree: tree.hash, frozenTree: frozen, treeMatchesFrozen: tree.hash === frozen, node: process.version,
  };
}

const countBy = (list, key) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map());

/**
 * Audit satu cutoff. `cfg` bawaan = konstanta beku; hanya diganti untuk tes/uji asap pada jendela lampau.
 * @returns {Promise<{ report: object, manifest: object }>} laporan tanpa R + manifest simbol-bulan
 */
export async function runAudit({
  cfg = AL_SA_ATR_01, cutoff, client, cacheDir, now = Date.now(), onSymbol = () => {},
  exchangeMeta = () => fetchExchangeMeta(), manualDelistings = new Map(), countReport = null, previousManifest = null,
  version = null,
}) {
  const clean = (s) => redactPaths(s, [[cacheDir, '<cache>'], [ROOT, '<repo>/'], [ROOT.replace(/\/$/, ''), '<repo>'], [homedir(), '~']]);
  const errText = (err) => clean(String(err?.message ?? err)).slice(0, 160);
  const rel = (file) => relative(cacheDir, file).split(sep).join('/');
  const end = Math.min(cutoff, cfg.maxWindowEnd) - cfg.settleBars * H;
  const loadFrom = cfg.windowStart - cfg.warmupDays * DAY;
  const fundingFrom = cfg.windowStart - DAY;
  const windowMonths = monthsInRange(loadFrom, cutoff);
  const cohortMonths = monthsInRange(cfg.oldCohortFrom, cfg.oldCohortTo);
  const fundingMonths = monthsInRange(fundingFrom, cutoff);

  let metaBySymbol = new Map();
  let exchangeInfoError = null;
  try {
    metaBySymbol = await exchangeMeta();
  } catch (err) {
    exchangeInfoError = errText(err);
  }
  const rows = [];
  const records = [];
  for (const symbol of cfg.universe) {
    const meta = exchangeInfoError ? undefined : (metaBySymbol.get(symbol) ?? null);
    const row = {
      symbol, exchangeStatus: exchangeInfoError ? 'TIDAK_DIKETAHUI' : (meta?.status ?? null),
      deliveryDate: meta && Number.isFinite(meta.deliveryDate) && meta.deliveryDate !== FAR_DELIVERY ? iso(meta.deliveryDate) : null,
      klines: null, funding: null, cohort: null, listingOpenTime: null, delisting: null, emptyMonthsWritten: [], open: [],
      months: [], fundingFiles: [],
    };
    const klinePaths = [...windowMonths, ...cohortMonths].map((m) => cacheFilePath(cacheDir, symbol, '1h', m.key));
    const fundingPaths = fundingMonths.map((m) => fundingCachePath(cacheDir, symbol, m.key));
    const before = new Map(await Promise.all([...klinePaths, ...fundingPaths].map(async (p) => [p, await exists(p)])));

    let candles = null;
    try {
      ({ candles } = await loadFromBinance({ symbol, timeframe: '1h', from: loadFrom, to: cutoff, client, cacheDir, now }));
      row.klines = { ok: true, ...klineStatus(candles, { cutoff }) };
    } catch (err) {
      row.klines = { ok: false, error: errText(err) };
    }
    try {
      const { rates } = await loadFundingRates({ symbol, from: fundingFrom, to: cutoff, client, cacheDir, now });
      row.funding = { ok: true, n: rates.length };
    } catch (err) {
      row.funding = { ok: false, error: errText(err) };
    }
    let cohortCandles = null;
    try {
      ({ candles: cohortCandles } = await loadFromBinance({ symbol, timeframe: '1h', from: cfg.oldCohortFrom, to: cfg.oldCohortTo, client, cacheDir, now }));
      row.cohort = { ok: true, candles: cohortCandles.length, kohort: cohortCandles.length ? 'lama' : 'baru' };
    } catch (err) {
      row.cohort = { ok: false, error: errText(err) };
    }
    try {
      const first = await client.getKlines({ symbol, timeframe: '1h', startTime: 0, limit: 1 });
      row.listingOpenTime = first[0]?.openTime ?? null;
    } catch (err) {
      row.listingError = errText(err);
    }
    // Bulan lengkap tanpa cache yang SELURUHNYA sebelum listing → file kosong (§10.2 butir 1, §11.3).
    if (row.klines.ok && row.cohort.ok && Number.isFinite(row.listingOpenTime)) {
      for (const [from, to] of [[cfg.oldCohortFrom, cfg.oldCohortTo], [loadFrom, cutoff]]) {
        row.emptyMonthsWritten.push(...await writePreListingEmptyMonths({
          cacheDir, symbol, timeframe: '1h', from, to, listingOpenTime: row.listingOpenTime, now,
        }));
      }
    }

    const series = candles ?? [];
    // meta: undefined = exchangeInfo gagal, null = simbol tidak ada di exchangeInfo (baru boleh memakai catatan manual).
    row.delisting = delistingInfo({ meta, manual: meta === null ? manualDelistings.get(symbol) ?? null : null, candles: series });
    const statusRows = [
      ...monthStatuses({
        months: windowMonths, candles: series, seriesFrom: loadFrom, cutoff, listingOpenTime: row.listingOpenTime,
        delisting: row.delisting, loadOk: row.klines.ok,
      }).map((r) => ({ series: 'jendela', ...r })),
      ...monthStatuses({
        months: cohortMonths, candles: cohortCandles ?? [], seriesFrom: cfg.oldCohortFrom, cutoff: cfg.oldCohortTo,
        listingOpenTime: row.listingOpenTime, loadOk: row.cohort.ok, tailChecks: false,
      }).map((r) => ({ series: 'kohort', ...r })),
    ];
    for (const r of statusRows) {
      const file = cacheFilePath(cacheDir, symbol, '1h', r.month);
      row.months.push({ ...r, file: rel(file), sha256: await sha256File(file), existedBefore: before.get(file) ?? false });
    }
    for (const [i, m] of fundingMonths.entries()) {
      const file = fundingPaths[i];
      row.fundingFiles.push({ month: m.key, file: rel(file), sha256: await sha256File(file), existedBefore: before.get(file) ?? false });
    }

    // Batas candle datar untuk menandai trade (§11.6 butir 2): waktu delisting terverifikasi, atau awal ekor datar panjang.
    const tail = flatTail(series);
    const flatFrom = row.delisting.verified ? row.delisting.time : (tail.length >= FLAT_TAIL_MIN ? tail.start : null);
    const flagOf = (signalTime, entryTime, exitTime) => {
      if (flatFrom === null) return null;
      if (signalTime >= flatFrom) return 'a';
      return entryTime < flatFrom && (exitTime ?? Infinity) >= flatFrom ? 'b' : null;
    };
    if (series.length) {
      const res = await replaySeries({
        symbol, timeframe: '1h', byTf: { '1h': series },
        options: { targetR: cfg.targetR, maxBars: cfg.maxBars, feeBps: cfg.feeBps, slippageBps: cfg.slippageBps, entry: cfg.entry },
      });
      const A = atr(series, cfg.atrPeriod);
      for (const t of res.trades.v3) {
        if (t.direction !== cfg.direction) continue;
        const signal = series[t.entryIndex];
        if (signal.openTime < cfg.windowStart || signal.openTime >= end) continue;
        const pre = preMoveAt(series, A, t.entryIndex, cfg.look);
        const flag = flagOf(signal.openTime, t.entryTime, t.exitTime);
        if (t.outcome === 'OPEN') {
          row.open.push({
            signalTime: iso(signal.closeTime),
            group: pre === null ? null : pre >= cfg.preThresholdAtr ? 'filter' : 'pelengkap',
            cause: openCause({ exchangeStatus: row.exchangeStatus, endsEarly: row.klines.endsEarly }),
            ...(flag ? { delist: flag } : {}),
          });
          continue;
        }
        if (pre === null) continue;
        records.push({ ...tradeRecord(symbol, t, pre), ...(flag ? { delist: flag } : {}) });
      }
    }
    rows.push(row);
    onSymbol(row);
  }

  const filtered = onePositionPerSymbol(records.filter((r) => r.pre >= cfg.preThresholdAtr));
  const complement = onePositionPerSymbol(records.filter((r) => r.pre < cfg.preThresholdAtr));
  const fBy = countBy(filtered, (r) => r.symbol);
  const cBy = countBy(complement, (r) => r.symbol);
  const flagged = new Map();
  for (const [group, list] of [['filter', filtered], ['pelengkap', complement]]) {
    for (const r of list) {
      if (!r.delist) continue;
      if (!flagged.has(r.symbol)) flagged.set(r.symbol, []);
      flagged.get(r.symbol).push({ group, delist: r.delist, entryTime: iso(r.t), exitTime: iso(r.exitTime) });
    }
  }
  for (const row of rows) {
    row.trades = { filter: fBy.get(row.symbol) ?? 0, pelengkap: cBy.get(row.symbol) ?? 0, terbuka: row.open.length };
    row.delistingTrades = flagged.get(row.symbol) ?? [];
  }
  const flagCount = (list) => ({ a: list.filter((r) => r.delist === 'a').length, b: list.filter((r) => r.delist === 'b').length });
  const allOpen = rows.flatMap((r) => r.open);
  const openTotal = allOpen.length;
  const allMonths = rows.flatMap((r) => r.months.map((m) => ({ symbol: r.symbol, ...m })));
  const allFunding = rows.flatMap((r) => r.fundingFiles.map((f) => ({ symbol: r.symbol, ...f })));
  const manifest = {
    id: cfg.id, kind: 'manifest', schema: 2, cutoff: iso(cutoff), generatedAt: iso(now),
    version: version ? { scriptSha256: version.scriptSha256, gitCommit: version.gitCommit } : null,
    months: allMonths, funding: allFunding,
  };

  const statusCounts = Object.fromEntries(MONTH_STATUSES.map((s) => [s, allMonths.filter((m) => m.status === s).length]));
  const hashCheck = previousManifest
    ? { against: previousManifest.name, ...compareManifests(previousManifest.manifest, manifest) }
    : { against: null, changed: [], missing: [] };
  const parity = checkCountParity(countReport?.report ?? null, {
    id: cfg.id, cutoff: iso(cutoff), signalWindowEnd: iso(end), nFiltered: filtered.length, nComplement: complement.length, openTotal,
  });
  const failed = rows.filter((r) => !r.klines.ok || !r.funding.ok || !r.cohort.ok).map((r) => r.symbol);
  const blockingMonths = allMonths.filter((m) => BLOCKING_STATUSES.includes(m.status));
  const fundingFailed = rows.filter((r) => !r.funding.ok).map((r) => r.symbol);
  const blocking = [
    ...(exchangeInfoError ? [`exchangeInfo gagal dimuat, jadi delisting tidak bisa diverifikasi: ${exchangeInfoError}`] : []),
    ...(blockingMonths.length ? [`${blockingMonths.length} simbol-bulan berstatus ${[...new Set(blockingMonths.map((m) => m.status))].join('/')}`] : []),
    ...(fundingFailed.length ? [`funding gagal dimuat: ${fundingFailed.join(', ')}`] : []),
    ...(parity.ok ? [] : [`paritas count: ${parity.reasons.join('; ')}`]),
    ...(hashCheck.changed.length || hashCheck.missing.length
      ? [`file cache berubah/hilang dibanding ${hashCheck.against}: ${hashCheck.changed.length} berubah, ${hashCheck.missing.length} hilang`] : []),
    ...(!version ? ['versi audit tidak tercatat'] : version.gitClean === true ? [] : [version.gitClean === false ? 'pohon kerja main tidak bersih' : 'status git main tidak diketahui']),
  ];
  const issues = [
    ...rows.filter((r) => !r.klines.ok).map((r) => `${r.symbol}: kline gagal dimuat (${r.klines.error})`),
    ...rows.filter((r) => !r.funding.ok).map((r) => `${r.symbol}: funding gagal dimuat (${r.funding.error})`),
    ...rows.filter((r) => !r.cohort.ok).map((r) => `${r.symbol}: bulan kohort gagal dimuat (${r.cohort.error})`),
    ...rows.filter((r) => r.listingError).map((r) => `${r.symbol}: candle pertama gagal dibaca (${r.listingError})`),
    ...rows.filter((r) => !exchangeInfoError && r.exchangeStatus !== 'TRADING').map((r) => `${r.symbol}: status exchangeInfo ${r.exchangeStatus ?? 'tidak ada'}`),
    ...rows.filter((r) => r.exchangeStatus === 'TRADING' && r.deliveryDate).map((r) => `${r.symbol}: masih TRADING, delisting dijadwalkan ${r.deliveryDate}`),
    ...rows.filter((r) => r.delisting.time !== null).map((r) => `${r.symbol}: delisting ${iso(r.delisting.time)} (${r.delisting.source}) ${r.delisting.verified ? 'terverifikasi' : 'BELUM terverifikasi'}`),
    ...allMonths.filter((m) => m.status !== 'LENGKAP').map((m) => `${m.symbol} ${m.month} (${m.series}): ${m.status}${m.missing ? `, ${m.missing} candle hilang` : ''}${m.note ? `, ${m.note}` : ''}`),
    ...rows.filter((r) => r.open.length).map((r) => `${r.symbol}: ${r.open.length} trade tetap terbuka (${[...new Set(r.open.map((o) => o.cause))].join(', ')})`),
    ...rows.filter((r) => r.delistingTrades.length).map((r) => `${r.symbol}: ${r.delistingTrades.length} trade tersentuh delisting (${r.delistingTrades.map((x) => `${x.group} ${x.delist}`).join(', ')})`),
  ];
  const report = {
    id: cfg.id, mode: 'audit-data', schema: 2, generatedAt: iso(now), cutoff: iso(cutoff), signalWindowEnd: iso(end),
    ready: blocking.length === 0, blocking, version,
    parity: { ...parity, file: countReport?.name ?? null, sha256: countReport?.sha256 ?? null },
    nFiltered: filtered.length, nComplement: complement.length, nRequired: cfg.nRequired, openTotal,
    delistingTrades: { filter: flagCount(filtered), pelengkap: flagCount(complement), terbuka: flagCount(allOpen) },
    statusCounts,
    symbolsWithGaps: rows.filter((r) => r.klines.ok && r.klines.gaps > 0).length,
    emptyMonthsWritten: rows.reduce((s, r) => s + r.emptyMonthsWritten.length, 0),
    hashCheck, failed, issues, exchangeInfoError,
    symbols: rows.map(({ months, fundingFiles: _funding, ...r }) => ({
      ...r,
      delisting: { time: iso(r.delisting.time), source: r.delisting.source, verified: r.delisting.verified },
      listingOpenTime: iso(r.listingOpenTime),
      monthStatus: Object.fromEntries(countBy(months, (m) => m.status)),
    })),
  };
  return { report, manifest };
}

const yes = (b) => (b ? 'ya' : 'GAGAL');
const short = (h) => (h ? `${h.slice(0, 12)}…` : '—');

export function renderAuditMarkdown(r) {
  const v = r.version;
  const p = r.parity;
  const d = r.delistingTrades;
  const md = [
    `# Audit data ${r.id} — ${r.ready ? 'siap evaluasi' : 'BELUM SIAP'}`,
    '',
    `Dibuat ${r.generatedAt} · cutoff data ${r.cutoff} · sinyal s/d ${r.signalWindowEnd}. Tanpa R atau hasil trade (docs/26 §10–§11).`,
    '',
    `Trade kelompok filter ${r.nFiltered} / ${r.nRequired} wajib · pelengkap ${r.nComplement} · tetap terbuka ${r.openTotal} · `
      + `simbol dengan celah ${r.symbolsWithGaps} · file bulan kosong baru ${r.emptyMonthsWritten}.`,
    '',
    '## Kesiapan evaluasi (§11.2)',
    '',
    ...(r.blocking.length ? r.blocking.map((b) => `- ${b}`) : ['Tidak ada penghalang.']),
    '',
    '## Versi audit (§11.5)',
    '',
    '| Unsur | Nilai |',
    '| --- | --- |',
    `| SHA-256 skrip audit | \`${v?.scriptSha256 ?? '—'}\` |`,
    `| Commit main | \`${v?.gitCommit ?? '—'}\` (${v?.gitClean === true ? 'bersih' : v?.gitClean === false ? 'TIDAK BERSIH' : 'tidak diketahui'}) |`,
    `| Hash pohon kode main | \`${v?.mainTree ?? '—'}\` (${v?.treeMatchesFrozen ? 'sama dengan hash beku' : 'berbeda dari hash beku'}) |`,
    `| Node | ${v?.node ?? '—'} |`,
    '',
    '## Paritas dengan count (§11.2 butir 3)',
    '',
    p.checked
      ? `Laporan ${p.file ?? '—'} (SHA-256 \`${short(p.sha256)}\`, dibuat ${p.count?.generatedAt ?? '—'}): filter ${p.count?.nFiltered} vs ${r.nFiltered}, `
        + `pelengkap ${p.count?.nComplement} vs ${r.nComplement}, terbuka ${p.count?.openAtCutoff} vs ${r.openTotal} → ${p.ok ? '**cocok**' : `**TIDAK COCOK**: ${p.reasons.join('; ')}`}.`
      : `Belum diperiksa: ${p.reasons.join('; ')}.`,
    '',
    '## Status simbol-bulan',
    '',
    '| Status | Jumlah |',
    '| --- | --- |',
    ...Object.entries(r.statusCounts).map(([s, n]) => `| \`${s}\` | ${n} |`),
    '',
    `Trade tersentuh delisting (sesudah aturan satu posisi; a = sinyal di candle datar, b = melintasi waktu delisting): `
      + `filter a ${d.filter.a}, b ${d.filter.b} · pelengkap a ${d.pelengkap.a}, b ${d.pelengkap.b} · terbuka a ${d.terbuka.a}, b ${d.terbuka.b}.`,
    '',
    `File cache vs manifest sebelumnya (${r.hashCheck.against ?? 'belum ada'}): ${r.hashCheck.changed.length} berubah, ${r.hashCheck.missing.length} hilang.`,
    ...r.hashCheck.changed.map((c) => `- berubah: \`${c.file}\` ${short(c.before)} → ${short(c.after)}`),
    ...r.hashCheck.missing.map((f) => `- hilang: \`${f}\``),
    '',
    '## Catatan',
    '',
    ...(r.issues.length ? r.issues.map((i) => `- ${i}`) : ['Tidak ada.']),
    '',
    '## Per simbol',
    '',
    '| Simbol | Status | Kline | Candle terakhir | Celah (candle hilang) | Funding | Kohort | Status bulan | Filter | Pelengkap | Terbuka |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.symbols.map((s) => `| ${s.symbol} | ${s.exchangeStatus ?? 'tidak ada'} | ${yes(s.klines.ok)} | ${iso(s.klines.last) ?? '—'} | `
      + `${s.klines.ok ? `${s.klines.gaps} (${s.klines.missingCandles})` : '—'} | ${s.funding.ok ? `ya (${s.funding.n})` : 'GAGAL'} | `
      + `${s.cohort.ok ? s.cohort.kohort : 'GAGAL'} | ${Object.entries(s.monthStatus).map(([k, n]) => `${k} ${n}`).join(', ')} | `
      + `${s.trades.filter} | ${s.trades.pelengkap} | ${s.trades.terbuka} |`),
    '',
  ];
  return md.join('\n');
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      to: { type: 'string' }, 'count-report': { type: 'string' },
      'cache-dir': { type: 'string', default: DEFAULT_CACHE_DIR }, 'log-dir': { type: 'string', default: DEFAULT_LOG_DIR },
    },
    strict: true,
  });
  const now = Date.now();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.to ?? '')) throw new RangeError('--to wajib, format YYYY-MM-DD');
  const cutoff = Date.parse(`${v.to}T00:00:00Z`);
  if (!Number.isFinite(cutoff) || cutoff > now) throw new RangeError('--to harus tanggal YYYY-MM-DD yang sudah lewat');
  if (cutoff <= AL_SA_ATR_01.windowStart) throw new RangeError('Jendela data AL-SA-ATR-01 belum dimulai');
  if (cutoff > AL_SA_ATR_01.maxWindowEnd) throw new RangeError('--to melewati batas jendela praregistrasi');
  // Versi & kebersihan pohon kerja dicatat SEBELUM file log ditulis (§11.5).
  const version = await auditVersion();
  if (version.gitClean !== true) log('PERINGATAN: pohon kerja main tidak bersih/tidak diketahui — audit tidak bisa berstatus siap evaluasi');
  let countReport = null;
  if (v['count-report']) {
    const buf = await readFile(resolve(v['count-report']));
    countReport = { name: basename(v['count-report']), sha256: sha256(buf), report: JSON.parse(buf.toString('utf8')) };
  }
  const logDir = resolve(ROOT, v['log-dir']);
  const client = createBinanceRestClient({ logger: { warn: (o, m) => log(`[binance] ${m ?? ''} ${JSON.stringify(o)}`) } });
  const { report, manifest } = await runAudit({
    cutoff, client, cacheDir: resolve(ROOT, v['cache-dir']), now, version, countReport,
    previousManifest: await latestManifest(logDir), manualDelistings: await readManualDelistings(logDir),
    onSymbol: (s) => log(`${s.symbol}: kline ${yes(s.klines.ok)}, funding ${yes(s.funding.ok)}, kohort ${yes(s.cohort.ok)}, terbuka ${s.open.length}`),
  });
  const written = await writeLogFiles({
    logDir, key: v.to,
    bodies: [`${JSON.stringify(report, null, 2)}\n`, renderAuditMarkdown(report), `${JSON.stringify(manifest, null, 2)}\n`],
  });
  log(`${report.ready ? 'Siap evaluasi' : `BELUM SIAP (${report.blocking.length} penghalang)`} · filter ${report.nFiltered}/${report.nRequired} · `
    + `terbuka ${report.openTotal} → ${written.files.map((f) => join(relative(ROOT, logDir), f)).join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Audit gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
