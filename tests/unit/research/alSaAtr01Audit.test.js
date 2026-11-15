// Audit integritas data AL-SA-ATR-01 (docs/26 §10): status kline, penyebab trade terbuka, file cache bulan kosong
// sebelum listing (dibaca dataSource sebagai cache), dan catatan trade tanpa hasil.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheFilePath, loadFromBinance } from '../../../backend/backtest/dataSource.js';
import {
  emptyMonthCacheBody, klineStatus, openCause, preListingMonthsWithoutCache, tradeRecord, writePreListingEmptyMonths,
} from '../../../scripts/research-al-sa-atr-01-audit.js';

const H = 3_600_000;
const candle = (openTime) => ({ openTime, closeTime: openTime + H - 1 });

describe('audit AL-SA-ATR-01', () => {
  let dir;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('UNIT-ALSA-AUD-001 klineStatus: celah, candle hilang, dan data berhenti > 2 candle sebelum cutoff', () => {
    const t0 = Date.UTC(2026, 10, 16);
    const full = [0, 1, 2, 3].map((k) => candle(t0 + k * H));
    expect(klineStatus(full, { cutoff: t0 + 4 * H })).toMatchObject({ candles: 4, gaps: 0, missingCandles: 0, endsEarly: false });
    const holed = [0, 1, 4, 5].map((k) => candle(t0 + k * H));
    expect(klineStatus(holed, { cutoff: t0 + 6 * H })).toMatchObject({ gaps: 1, missingCandles: 2, endsEarly: false });
    expect(klineStatus(full, { cutoff: t0 + 6 * H }).endsEarly).toBe(false); // 2 candle terakhir hilang: masih toleransi
    expect(klineStatus(full, { cutoff: t0 + 7 * H }).endsEarly).toBe(true); // 3 candle terakhir hilang
    expect(klineStatus([], { cutoff: t0 }).endsEarly).toBe(true);
  });

  it('UNIT-ALSA-AUD-002 openCause: status exchangeInfo dulu, lalu data berhenti saat masih TRADING', () => {
    expect(openCause({ exchangeStatus: 'SETTLING', endsEarly: true })).toBe('STATUS_SETTLING');
    expect(openCause({ exchangeStatus: null, endsEarly: true })).toBe('TIDAK_ADA_DI_EXCHANGEINFO');
    expect(openCause({ exchangeStatus: 'TRADING', endsEarly: true })).toBe('DATA_BERHENTI_SAAT_TRADING');
    expect(openCause({ exchangeStatus: 'TRADING', endsEarly: false })).toBe('LAIN');
  });

  it('UNIT-ALSA-AUD-003 bulan kosong: hanya bulan lengkap sebelum listing, tidak menimpa, dibaca dataSource sebagai cache', async () => {
    dir = await mkdtemp(join(tmpdir(), 'alsa-aud-'));
    const now = Date.UTC(2026, 11, 1);
    const listing = Date.UTC(2025, 11, 15); // listing pertengahan Des 2025
    const from = Date.UTC(2025, 9, 1);
    const to = Date.UTC(2026, 0, 1);
    const args = { cacheDir: dir, symbol: 'NEWUSDT', timeframe: '1h', from, to, now };
    // Okt & Nov 2025 seluruhnya sebelum listing; Des 2025 memuat listing.
    expect(await preListingMonthsWithoutCache({ ...args, listingOpenTime: listing })).toEqual(['2025-10', '2025-11']);
    const novFile = cacheFilePath(dir, 'NEWUSDT', '1h', '2025-11');
    await mkdir(dirname(novFile), { recursive: true });
    await writeFile(novFile, 'isi lama');
    expect(await writePreListingEmptyMonths({ ...args, listingOpenTime: listing })).toEqual(['2025-10']);
    expect(await readFile(novFile, 'utf8')).toBe('isi lama'); // file yang ada tidak ditimpa
    // dataSource membaca bulan kosong sebagai cache: tanpa klien pun tidak gagal, hasilnya 0 candle.
    const { candles, stats } = await loadFromBinance({ symbol: 'NEWUSDT', timeframe: '1h', from, to: Date.UTC(2025, 10, 1), cacheDir: dir, now });
    expect(candles).toEqual([]);
    expect(stats.cachedMonths).toBe(1);
    expect(JSON.parse(emptyMonthCacheBody({ symbol: 'X', timeframe: '1h', monthKey: '2025-10' })).rows).toEqual([]);
    // Bulan tanpa file tetap butuh klien (bukti file di atas benar-benar dipakai sebagai cache).
    await expect(loadFromBinance({ symbol: 'NEWUSDT', timeframe: '1h', from: Date.UTC(2025, 11, 1), to, cacheDir: dir, now }))
      .rejects.toThrow(/belum ada di cache/);
    // Waktu listing tidak diketahui → tidak menulis apa pun.
    expect(await writePreListingEmptyMonths({ ...args, symbol: 'OTHUSDT', listingOpenTime: Number.NaN })).toEqual([]);
  });

  it('UNIT-ALSA-AUD-004 catatan trade audit tanpa hasil: R, biaya, outcome, dan harga keluar tidak ikut', () => {
    const trade = { entryTime: 1, exitTime: 2, rMultiple: 1.9, grossR: 2, costR: 0.1, outcome: 'WIN', exitPrice: 10, mfeR: 3, maeR: -0.5 };
    expect(tradeRecord('AAAUSDT', trade, 3.1)).toEqual({ symbol: 'AAAUSDT', t: 1, exitTime: 2, pre: 3.1 });
  });
});
