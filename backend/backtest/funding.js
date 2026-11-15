// Riwayat funding rate Binance USDT-M untuk riset/backtest, dengan cache disk per simbol × bulan UTC
// (<cacheDir>/<SIMBOL>/funding/<YYYY-MM>.json). Bulan lengkap tidak pernah diambil ulang; bulan berjalan selalu segar
// dan tidak di-cache. Bulan yang belum ter-cache diambil SEKALIGUS sebagai satu rentang (1000 entri per request,
// ±3–4 request per simbol untuk 2,5 tahun) lalu dipecah per bulan: kuota endpoint ini hanya 500 request / 5 menit / IP.
// Semua request lewat klien REST proyek (allowlist host, pembatas bobot, retry, DNS sesuai BINANCE_DNS).
// Dipakai untuk biaya funding posisi di studi kejadian (eventStudy.js), bukan scanner live.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_FUNDING_LIMIT } from '../ingestion/binance/restClient.js';
import { DEFAULT_CACHE_DIR, monthsInRange, toEpochMs } from './dataSource.js';

export const FUNDING_CACHE_VERSION = 1;
const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;
const HOUR_MS = 3_600_000;

/** Path file cache funding satu (simbol, bulan). */
export function fundingCachePath(cacheDir, symbol, monthKey) {
  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) throw new TypeError(`Simbol tidak valid: ${String(symbol).slice(0, 40)}`);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new TypeError('Kunci bulan tidak valid');
  return join(cacheDir, symbol, 'funding', `${monthKey}.json`);
}

/** Baca satu bulan cache; null bila tidak ada, rusak, atau versi/simbol berbeda. Baris: [fundingTime, fundingRate]. */
async function readFundingMonth(file, symbol) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== FUNDING_CACHE_VERSION || parsed.symbol !== symbol || !Array.isArray(parsed.rows)) return null;
  const out = [];
  for (const row of parsed.rows) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || !Number.isFinite(row[1])) return null;
    if (out.length && row[0] <= out[out.length - 1].fundingTime) return null;
    out.push({ symbol, fundingTime: row[0], fundingRate: row[1] });
  }
  return out;
}

async function writeFundingMonth(file, { symbol, monthKey, rates }) {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({
    version: FUNDING_CACHE_VERSION, symbol, month: monthKey, fields: ['fundingTime', 'fundingRate'],
    rows: rates.map((r) => [r.fundingTime, r.fundingRate]),
  });
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, file);
}

/** Semua funding pada [start, end) lewat klien REST, paginasi maju dengan startTime (≤ 1000 per request). */
export async function fetchFundingRange(client, { symbol, start, end }) {
  // Pengaman paginasi: interval funding terpendek 1 jam → ≤ 1000 jam per halaman.
  const maxPages = Math.ceil((end - start) / (MAX_FUNDING_LIMIT * HOUR_MS)) + 2;
  const rates = [];
  let cursor = start;
  let requests = 0;
  while (cursor < end) {
    if (requests >= maxPages) throw new Error(`Paginasi funding ${symbol} melebihi ${maxPages} halaman`);
    const batch = await client.getFundingRates({ symbol, startTime: cursor, endTime: end - 1, limit: MAX_FUNDING_LIMIT });
    requests += 1;
    if (!Array.isArray(batch) || batch.length === 0) break;
    let last = cursor - 1;
    for (const r of batch) {
      if (r.fundingTime >= cursor && r.fundingTime < end && (rates.length === 0 || r.fundingTime > rates[rates.length - 1].fundingTime)) {
        rates.push({ symbol, fundingTime: r.fundingTime, fundingRate: r.fundingRate });
      }
      last = Math.max(last, r.fundingTime);
    }
    if (batch.length < MAX_FUNDING_LIMIT || last + 1 <= cursor) break;
    cursor = last + 1;
  }
  return { rates, requests };
}

/**
 * Muat riwayat funding satu simbol untuk rentang [from, to) (fundingTime), dengan cache per bulan.
 * @param {{ symbol: string, from: number|string|Date, to: number|string|Date,
 *   client?: { getFundingRates(q: object): Promise<Array<{ fundingTime: number, fundingRate: number }>> },
 *   cacheDir?: string|null, now?: number }} options
 *   - `client`: wajib bila ada bulan yang belum ter-cache (createBinanceRestClient).
 * @returns {Promise<{ rates: Array<{ symbol: string, fundingTime: number, fundingRate: number }>,
 *   stats: { months: number, cachedMonths: number, fetchedMonths: number, requests: number } }>}
 */
export async function loadFundingRates({ symbol, from, to, client, cacheDir = DEFAULT_CACHE_DIR, now = Date.now() } = {}) {
  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) throw new TypeError(`Simbol tidak valid: ${String(symbol).slice(0, 40)}`);
  const fromMs = toEpochMs(from, 'from');
  const toMs = toEpochMs(to, 'to');
  if (fromMs >= toMs) throw new RangeError('from harus sebelum to');
  const months = monthsInRange(fromMs, toMs);
  const stats = { months: months.length, cachedMonths: 0, fetchedMonths: 0, requests: 0 };
  const byMonth = new Map();
  for (const month of months) {
    const file = cacheDir ? fundingCachePath(cacheDir, symbol, month.key) : null;
    const complete = month.end <= now;
    byMonth.set(month.key, file && complete ? await readFundingMonth(file, symbol) : null);
  }
  const missing = months.filter((m) => byMonth.get(m.key) === null);
  stats.cachedMonths = months.length - missing.length;
  if (missing.length > 0) {
    if (!client || typeof client.getFundingRates !== 'function') {
      throw new Error(`Funding ${symbol} ${missing[0].key} belum ada di cache dan klien Binance tidak diberikan`);
    }
    const fetched = await fetchFundingRange(client, { symbol, start: missing[0].start, end: missing[missing.length - 1].end });
    stats.requests = fetched.requests;
    for (const month of missing) {
      const rates = fetched.rates.filter((r) => r.fundingTime >= month.start && r.fundingTime < month.end);
      byMonth.set(month.key, rates);
      stats.fetchedMonths += 1;
      // Bulan kosong (mis. sebelum listing) juga di-cache: jawaban sah Binance yang tidak berubah lagi.
      if (cacheDir && month.end <= now) {
        await writeFundingMonth(fundingCachePath(cacheDir, symbol, month.key), { symbol, monthKey: month.key, rates });
      }
    }
  }
  const all = [];
  for (const month of months) {
    for (const r of byMonth.get(month.key)) if (r.fundingTime >= fromMs && r.fundingTime < toMs) all.push(r);
  }
  return { rates: all, stats };
}
