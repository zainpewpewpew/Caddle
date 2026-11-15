import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchFundingRange, fundingCachePath, loadFundingRates } from '../../../backend/backtest/funding.js';

// Funding SINTETIS dari klien palsu — tidak ada request jaringan sungguhan.
const H8 = 8 * 3_600_000;
const JAN = Date.UTC(2025, 0, 1);
const MAR = Date.UTC(2025, 2, 1);
const NOW = Date.UTC(2025, 5, 1);

/** Klien palsu: funding tiap 8 jam mulai `listedAt`, menjawab seperti Binance (≥ startTime, ≤ endTime, maks limit). */
function fakeClient({ listedAt = JAN } = {}) {
  const calls = [];
  return {
    calls,
    async getFundingRates({ symbol, startTime, endTime, limit }) {
      calls.push({ symbol, startTime, endTime, limit });
      const out = [];
      for (let t = Math.max(listedAt, Math.ceil((startTime - listedAt) / H8) * H8 + listedAt); t <= endTime && out.length < limit; t += H8) {
        out.push({ symbol, fundingTime: t, fundingRate: 0.0001 });
      }
      return out;
    },
  };
}

const dirs = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop(), { recursive: true, force: true });
});
const tempDir = async () => {
  const d = await mkdtemp(join(tmpdir(), 'lr-funding-'));
  dirs.push(d);
  return d;
};

describe('fetchFundingRange', () => {
  it('UNIT-FND-001 memaginasi maju dengan startTime sampai halaman terakhir < limit, tanpa duplikat', async () => {
    const client = fakeClient();
    const end = JAN + 400 * 24 * 3_600_000; // ±1200 entri → 2 halaman
    const { rates, requests } = await fetchFundingRange(client, { symbol: 'BTCUSDT', start: JAN, end });
    expect(requests).toBe(2);
    expect(client.calls[0]).toMatchObject({ startTime: JAN, limit: 1000 });
    expect(client.calls[1].startTime).toBe(rates[999].fundingTime + 1);
    expect(rates.length).toBe(1200);
    expect(new Set(rates.map((r) => r.fundingTime)).size).toBe(1200);
  });
});

describe('loadFundingRates', () => {
  it('UNIT-FND-002 bulan hilang diambil sebagai satu rentang, dipecah & di-cache; panggilan kedua hanya membaca cache', async () => {
    const cacheDir = await tempDir();
    const client = fakeClient();
    const first = await loadFundingRates({ symbol: 'ETHUSDT', from: JAN, to: MAR, client, cacheDir, now: NOW });
    expect(first.stats).toMatchObject({ months: 2, cachedMonths: 0, fetchedMonths: 2, requests: 1 });
    expect(first.rates.length).toBe(31 * 3 + 28 * 3);
    const file = JSON.parse(await readFile(fundingCachePath(cacheDir, 'ETHUSDT', '2025-01'), 'utf8'));
    expect(file).toMatchObject({ version: 1, symbol: 'ETHUSDT', month: '2025-01' });
    expect(file.rows.length).toBe(93);

    const again = await loadFundingRates({ symbol: 'ETHUSDT', from: JAN, to: MAR, cacheDir, now: NOW });
    expect(again.stats).toMatchObject({ cachedMonths: 2, fetchedMonths: 0, requests: 0 });
    expect(again.rates).toEqual(first.rates);
  });

  it('UNIT-FND-003 bulan sebelum listing tersimpan kosong; bulan berjalan tidak di-cache; tanpa klien → error jelas', async () => {
    const cacheDir = await tempDir();
    const client = fakeClient({ listedAt: Date.UTC(2025, 1, 10) });
    const r = await loadFundingRates({ symbol: 'NEWUSDT', from: JAN, to: MAR, client, cacheDir, now: NOW });
    expect(r.rates[0].fundingTime).toBe(Date.UTC(2025, 1, 10));
    const jan = JSON.parse(await readFile(fundingCachePath(cacheDir, 'NEWUSDT', '2025-01'), 'utf8'));
    expect(jan.rows).toEqual([]);

    const partial = await loadFundingRates({ symbol: 'BTCUSDT', from: JAN, to: Date.UTC(2025, 1, 1), client: fakeClient(), cacheDir, now: Date.UTC(2025, 0, 20) });
    expect(partial.stats.fetchedMonths).toBe(1);
    await expect(readFile(fundingCachePath(cacheDir, 'BTCUSDT', '2025-01'), 'utf8')).rejects.toThrow();

    await expect(loadFundingRates({ symbol: 'XRPUSDT', from: JAN, to: MAR, cacheDir, now: NOW })).rejects.toThrow(/belum ada di cache/);
    await expect(loadFundingRates({ symbol: '../etc', from: JAN, to: MAR, cacheDir })).rejects.toThrow(TypeError);
  });
});
