// Audit integritas data AL-SA-ATR-01 (docs/26 §10–§11): status kline, penyebab trade terbuka, file cache bulan kosong
// sebelum listing (dibaca dataSource sebagai cache), catatan trade tanpa hasil, status simbol-bulan, verifikasi
// delisting dari candle datar, paritas count, log append-only, dan path lokal yang disamarkan.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheFilePath, loadFromBinance, monthsInRange } from '../../../backend/backtest/dataSource.js';
import { AL_SA_ATR_01 } from '../../../backend/research/alSaAtr01.js';
import {
  FAR_DELIVERY, checkCountParity, compareManifests, delistingInfo, emptyMonthCacheBody, flatTail, klineStatus,
  latestManifest, monthStatuses, openCause, preListingMonthsWithoutCache, readManualDelistings, redactPaths, runAudit,
  tradeRecord, writeLogFiles, writePreListingEmptyMonths,
} from '../../../scripts/research-al-sa-atr-01-audit.js';

const H = 3_600_000;
const candle = (openTime) => ({ openTime, closeTime: openTime + H - 1 });
// Candle lengkap: biasa (bervolume) atau datar bervolume 0 seperti candle Binance sesudah delisting.
const bar = (openTime, { price = 1, flat = false } = {}) => (flat
  ? { openTime, closeTime: openTime + H - 1, open: price, high: price, low: price, close: price, volume: 0 }
  : { openTime, closeTime: openTime + H - 1, open: price, high: price * 1.01, low: price * 0.99, close: price, volume: 10 });
const hours = (from, to, opts) => Array.from({ length: Math.max(0, (to - from) / H) }, (_, k) => bar(from + k * H, opts));
const statusOf = (rows) => Object.fromEntries(rows.map((r) => [r.month, r.status]));

// Klien Binance palsu yang deterministik: deret per simbol sejak listing; sesudah delisting candle datar bervolume 0.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fakeMarket({ symbols, now }) {
  const series = new Map();
  for (const [symbol, { listing, delist = null, seed }] of Object.entries(symbols)) {
    const rnd = mulberry32(seed);
    let price = 10;
    const out = [];
    for (let t = listing; t + H <= now; t += H) {
      if (delist !== null && t >= delist) {
        out.push({ symbol, timeframe: '1h', openTime: t, closeTime: t + H - 1, open: price, high: price, low: price, close: price, volume: 0, quoteVolume: 0, trades: 0, takerBuyVolume: 0, takerBuyQuoteVolume: 0 });
        continue;
      }
      const open = price;
      price *= Math.exp((rnd() - 0.5) * 0.03);
      const high = Math.max(open, price) * (1 + rnd() * 0.01);
      const low = Math.min(open, price) * (1 - rnd() * 0.01);
      const volume = 1000 + rnd() * 9000;
      out.push({ symbol, timeframe: '1h', openTime: t, closeTime: t + H - 1, open, high, low, close: price, volume, quoteVolume: volume * price, trades: 100, takerBuyVolume: volume / 2, takerBuyQuoteVolume: (volume * price) / 2 });
    }
    series.set(symbol, out);
  }
  return {
    async getKlines({ symbol, startTime = 0, endTime = Infinity, limit = 1500 }) {
      return (series.get(symbol) ?? []).filter((c) => c.openTime >= startTime && c.openTime <= endTime).slice(0, limit);
    },
    async getFundingRates({ symbol, startTime = 0, endTime = Infinity, limit = 1000 }) {
      const first = series.get(symbol)?.[0]?.openTime ?? Infinity;
      const out = [];
      for (let t = Math.ceil(Math.max(startTime, first) / (8 * H)) * 8 * H; t <= endTime && t < now && out.length < limit; t += 8 * H) {
        out.push({ symbol, fundingTime: t, fundingRate: 0.0001 });
      }
      return out;
    },
  };
}

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

  it('UNIT-ALSA-AUD-005 ekor candle datar dan verifikasi delisting (exchangeInfo, manual, toleransi 2 candle)', () => {
    const t0 = Date.UTC(2026, 10, 20, 9);
    const s = [...hours(t0 - 10 * H, t0), ...hours(t0, t0 + 5 * H, { flat: true })];
    expect(flatTail(s)).toEqual({ start: t0, length: 5 });
    expect(flatTail(hours(t0, t0 + 3 * H))).toEqual({ start: null, length: 0 });
    const settling = (deliveryDate) => ({ status: 'SETTLING', deliveryDate });
    expect(delistingInfo({ meta: settling(t0), candles: s })).toEqual({ time: t0, source: 'exchangeInfo', verified: true });
    // Candle penyelesaian bervolume masih ditoleransi sampai 2 candle sesudah waktu delisting...
    expect(delistingInfo({ meta: settling(t0 - 2 * H), candles: s }).verified).toBe(true);
    // ...tetapi candle bervolume sesudahnya membuat delisting belum terverifikasi.
    expect(delistingInfo({ meta: settling(t0 - 3 * H), candles: s }).verified).toBe(false);
    // Tanpa candle sesudah delisting (data berhenti tepat di sana) juga terverifikasi.
    expect(delistingInfo({ meta: settling(t0 - 10 * H), candles: [] }).verified).toBe(true);
    expect(delistingInfo({ meta: { status: 'TRADING', deliveryDate: FAR_DELIVERY }, candles: s }).time).toBeNull();
    expect(delistingInfo({ meta: { status: 'SETTLING', deliveryDate: FAR_DELIVERY }, candles: s }).time).toBeNull();
    // Catatan manual hanya untuk simbol yang hilang dari exchangeInfo (meta null), bukan saat exchangeInfo gagal (undefined).
    const manual = { time: t0, source: 'https://www.binance.com/en/support/announcement/x' };
    expect(delistingInfo({ meta: null, manual, candles: s })).toEqual({ time: t0, source: 'manual', verified: true });
    expect(delistingInfo({ meta: undefined, manual, candles: s }).time).toBeNull();
    expect(delistingInfo({ meta: { status: 'TRADING', deliveryDate: FAR_DELIVERY }, manual, candles: s }).time).toBeNull();
  });

  it('UNIT-ALSA-AUD-006 status simbol-bulan: lengkap, celah, listing, delisting, belum terselesaikan, gagal', () => {
    const oct17 = Date.UTC(2026, 9, 17);
    const dec1 = Date.UTC(2026, 11, 1);
    const months = monthsInRange(oct17, dec1); // Okt (parsial sejak pemanasan) & Nov 2026
    const run = (candles, extra = {}) => monthStatuses({ months, candles, seriesFrom: oct17, cutoff: dec1, listingOpenTime: Date.UTC(2024, 0, 1), ...extra });
    const full = hours(oct17, dec1);
    const ok = run(full);
    expect(statusOf(ok)).toEqual({ '2026-10': 'LENGKAP', '2026-11': 'LENGKAP' });
    expect(ok[0]).toMatchObject({ expected: 15 * 24, missing: 0 }); // bulan pemanasan dihitung sejak seriesFrom
    const holed = full.filter((c) => !(c.openTime >= Date.UTC(2026, 10, 5) && c.openTime < Date.UTC(2026, 10, 5, 3)));
    expect(run(holed)[1]).toMatchObject({ status: 'CELAH', missing: 3 });
    // Listing 10 Nov: Okt seluruhnya sebelum listing, Nov dihitung sejak listing.
    const nov10 = Date.UTC(2026, 10, 10);
    const listed = run(hours(nov10, dec1), { listingOpenTime: nov10 });
    expect(statusOf(listed)).toEqual({ '2026-10': 'SEBELUM_LISTING', '2026-11': 'LENGKAP' });
    expect(listed[1].expected).toBe(21 * 24);
    // Delisting terverifikasi 20 Nov 09:00 → Nov = bulan delisting; Des seluruhnya sesudah delisting.
    const D = Date.UTC(2026, 10, 20, 9);
    const jan1 = Date.UTC(2027, 0, 1);
    const delisted = [...hours(oct17, D), ...hours(D, jan1, { flat: true })];
    const three = monthStatuses({
      months: monthsInRange(oct17, jan1), candles: delisted, seriesFrom: oct17, cutoff: jan1, listingOpenTime: Date.UTC(2024, 0, 1),
      delisting: { time: D, source: 'exchangeInfo', verified: true },
    });
    expect(statusOf(three)).toEqual({ '2026-10': 'LENGKAP', '2026-11': 'BULAN_DELISTING', '2026-12': 'SESUDAH_DELISTING' });
    expect(three[1]).toMatchObject({ expected: (D - Date.UTC(2026, 10, 1)) / H, missing: 0 });
    expect(three[2].zeroVolume).toBe(31 * 24);
    // Ekor datar ≥ 24 candle tanpa delisting terverifikasi → menghalangi; ekor pendek tidak.
    const tail30 = [...hours(oct17, dec1 - 30 * H), ...hours(dec1 - 30 * H, dec1, { flat: true })];
    expect(run(tail30)[1]).toMatchObject({ status: 'BELUM_TERSELESAIKAN' });
    expect(run(tail30)[1].note).toMatch(/ekor 30 candle datar/);
    const tail10 = [...hours(oct17, dec1 - 10 * H), ...hours(dec1 - 10 * H, dec1, { flat: true })];
    expect(run(tail10)[1].status).toBe('LENGKAP');
    // Data berhenti 25 Nov saat simbol masih TRADING → belum terselesaikan, bukan bulan kosong.
    expect(run(hours(oct17, Date.UTC(2026, 10, 25)))[1]).toMatchObject({ status: 'BELUM_TERSELESAIKAN' });
    // Delisting yang belum terverifikasi menghalangi bulan yang melewatinya saja.
    const unverified = run(full, { delisting: { time: D, source: 'exchangeInfo', verified: false } });
    expect(statusOf(unverified)).toEqual({ '2026-10': 'LENGKAP', '2026-11': 'BELUM_TERSELESAIKAN' });
    expect(statusOf(run(full, { loadOk: false }))).toEqual({ '2026-10': 'GAGAL_DIAMBIL', '2026-11': 'GAGAL_DIAMBIL' });
    expect(run([], { listingOpenTime: null })[0]).toMatchObject({ status: 'BELUM_TERSELESAIKAN', note: 'waktu listing tidak diketahui' });
    // Bulan kohort hanya menentukan ada/tidaknya candle: ekor datar tidak diperiksa.
    expect(run(tail30, { tailChecks: false })[1].status).toBe('LENGKAP');
  });

  it('UNIT-ALSA-AUD-007 paritas count: cocok, tidak diberikan, angka/cutoff/hash berbeda', () => {
    const audit = { id: 'AL-SA-ATR-01', cutoff: '2026-12-01T00:00:00.000Z', signalWindowEnd: '2026-11-28T22:00:00.000Z', nFiltered: 5, nComplement: 7, openTotal: 0 };
    const count = { id: 'AL-SA-ATR-01', mode: 'count', cutoff: audit.cutoff, signalWindowEnd: audit.signalWindowEnd, hashesMatch: true, nFiltered: 5, nComplement: 7, openAtCutoff: 0, skipped: [] };
    expect(checkCountParity(count, audit)).toMatchObject({ checked: true, ok: true, reasons: [] });
    expect(checkCountParity(null, audit)).toMatchObject({ checked: false, ok: false });
    expect(checkCountParity({ ...count, nFiltered: 6 }, audit).reasons).toEqual(['filter: count 6 ≠ audit 5']);
    const bad = checkCountParity({ ...count, cutoff: '2026-11-01T00:00:00.000Z', hashesMatch: false, mode: 'evaluate' }, audit);
    expect(bad.ok).toBe(false);
    expect(bad.reasons.join(' | ')).toMatch(/mode laporan evaluate.*cutoff count.*hashesMatch/);
  });

  it('UNIT-ALSA-AUD-008 log append-only, manifest terakhir, dan perubahan hash file cache', async () => {
    dir = await mkdtemp(join(tmpdir(), 'alsa-log-'));
    const first = await writeLogFiles({ logDir: dir, key: '2026-12-01', bodies: ['{"a":1}\n', '# a\n', '{"m":1}\n'] });
    expect(first).toEqual({ rev: 1, files: ['audit-2026-12-01.json', 'audit-2026-12-01.md', 'manifest-2026-12-01.json'] });
    const again = await writeLogFiles({ logDir: dir, key: '2026-12-01', bodies: ['{"a":2}\n', '# b\n', '{"m":2}\n'] });
    expect(again.files).toEqual(['audit-2026-12-01-r2.json', 'audit-2026-12-01-r2.md', 'manifest-2026-12-01-r2.json']);
    expect(await readFile(join(dir, 'audit-2026-12-01.json'), 'utf8')).toBe('{"a":1}\n'); // tidak ditimpa
    expect((await latestManifest(dir)).name).toBe('manifest-2026-12-01-r2.json');
    await writeFile(join(dir, 'manifest-2027-01-01.json'), '{"m":3}');
    await writeFile(join(dir, 'manifest-catatan.json'), '{}');
    expect(await latestManifest(dir)).toEqual({ name: 'manifest-2027-01-01.json', manifest: { m: 3 } });
    expect(await latestManifest(join(dir, 'tidak-ada'))).toBeNull();
    const prev = { months: [{ file: 'A/1h/2026-11.json', sha256: 'a1' }, { file: 'B/1h/2026-11.json', sha256: 'b1' }, { file: 'C/1h/2026-11.json', sha256: 'c1' }], funding: [{ file: 'A/funding/2026-11.json', sha256: 'f1' }] };
    const curr = { months: [{ file: 'A/1h/2026-11.json', sha256: 'a1' }, { file: 'B/1h/2026-11.json', sha256: 'b2' }, { file: 'C/1h/2026-11.json', sha256: null }], funding: [] };
    expect(compareManifests(prev, curr)).toEqual({ changed: [{ file: 'B/1h/2026-11.json', before: 'b1', after: 'b2' }], missing: ['C/1h/2026-11.json'] });
  });

  it('UNIT-ALSA-AUD-009 path lokal disamarkan; catatan delisting manual divalidasi', async () => {
    const pairs = [['/home/u/repo/data/backtest-cache', '<cache>'], ['/home/u/repo/', '<repo>/'], ['/home/u', '~']];
    expect(redactPaths("ENOENT '/home/u/repo/data/backtest-cache/X/1h/2026-11.json'; /home/u/repo/scripts; /home/u/.npm", pairs))
      .toBe("ENOENT '<cache>/X/1h/2026-11.json'; <repo>/scripts; ~/.npm");
    dir = await mkdtemp(join(tmpdir(), 'alsa-man-'));
    expect((await readManualDelistings(dir)).size).toBe(0);
    await writeFile(join(dir, 'delisting-manual.json'), JSON.stringify([{ symbol: 'OLDUSDT', deliveryTime: '2027-02-03T09:00:00Z', source: 'https://www.binance.com/en/support/announcement/x', recordedAt: '2027-02-04' }]));
    expect((await readManualDelistings(dir)).get('OLDUSDT')).toMatchObject({ time: Date.UTC(2027, 1, 3, 9) });
    await writeFile(join(dir, 'delisting-manual.json'), JSON.stringify([{ symbol: 'OLDUSDT', deliveryTime: '2027-02-03T09:00:00Z', source: 'http://contoh' }]));
    await expect(readManualDelistings(dir)).rejects.toThrow(/tidak valid/);
  });

  it('UNIT-ALSA-AUD-010 runAudit: status, delisting terverifikasi, paritas sebagai penghalang, hash stabil, tanpa R', async () => {
    dir = await mkdtemp(join(tmpdir(), 'alsa-run-'));
    const now = Date.UTC(2026, 10, 2);
    const D = Date.UTC(2026, 9, 10, 9);
    const cfg = Object.freeze({
      ...AL_SA_ATR_01, windowStart: Date.UTC(2026, 8, 1), maxWindowEnd: Date.UTC(2026, 10, 1),
      universe: ['AAAUSDT', 'DDDUSDT', 'NEWUSDT'],
    });
    const client = fakeMarket({
      now,
      symbols: {
        AAAUSDT: { listing: Date.UTC(2025, 0, 1), seed: 1 },
        DDDUSDT: { listing: Date.UTC(2025, 0, 1), delist: D, seed: 2 },
        NEWUSDT: { listing: Date.UTC(2026, 7, 20), seed: 3 },
      },
    });
    const exchangeMeta = async () => new Map([
      ['AAAUSDT', { status: 'TRADING', deliveryDate: FAR_DELIVERY }],
      ['DDDUSDT', { status: 'SETTLING', deliveryDate: D }],
      ['NEWUSDT', { status: 'TRADING', deliveryDate: FAR_DELIVERY }],
    ]);
    const version = { scriptSha256: 's', gitCommit: 'c', gitClean: true, mainTree: 'h', frozenTree: 'h', treeMatchesFrozen: true, node: 'v' };
    const base = { cfg, cutoff: Date.UTC(2026, 10, 1), client, cacheDir: dir, now, exchangeMeta, version };

    const first = await runAudit(base);
    const r1 = first.report;
    const months = (sym) => Object.fromEntries(first.manifest.months.filter((m) => m.symbol === sym).map((m) => [`${m.series} ${m.month}`, m.status]));
    expect(months('AAAUSDT')).toEqual({ 'jendela 2026-08': 'LENGKAP', 'jendela 2026-09': 'LENGKAP', 'jendela 2026-10': 'LENGKAP', 'kohort 2025-10': 'LENGKAP' });
    expect(months('DDDUSDT')).toMatchObject({ 'jendela 2026-09': 'LENGKAP', 'jendela 2026-10': 'BULAN_DELISTING' });
    expect(months('NEWUSDT')).toMatchObject({ 'jendela 2026-08': 'LENGKAP', 'kohort 2025-10': 'SEBELUM_LISTING' });
    expect(r1.symbols.find((s) => s.symbol === 'DDDUSDT').delisting).toEqual({ time: new Date(D).toISOString(), source: 'exchangeInfo', verified: true });
    expect(r1.symbols.find((s) => s.symbol === 'NEWUSDT').emptyMonthsWritten).toEqual(['2025-10']);
    // Semua file cache bulan lengkap ber-SHA-256; path di manifest relatif terhadap folder cache.
    expect(first.manifest.months.every((m) => /^[0-9a-f]{64}$/.test(m.sha256) && !m.file.startsWith('/'))).toBe(true);
    // Tanpa laporan count, audit tidak boleh siap.
    expect(r1.ready).toBe(false);
    expect(r1.blocking).toEqual(['paritas count: laporan count tidak diberikan (--count-report)']);
    // Tidak ada R, outcome, atau path lokal di laporan maupun manifest.
    const json = JSON.stringify(first);
    expect(json).not.toMatch(/rMultiple|netR|grossR|costR|"outcome"|"WIN"|"LOSS"|"TIMEOUT"/);
    expect(json).not.toContain(dir);

    const count = {
      id: cfg.id, mode: 'count', cutoff: r1.cutoff, signalWindowEnd: r1.signalWindowEnd, hashesMatch: true,
      nFiltered: r1.nFiltered, nComplement: r1.nComplement, openAtCutoff: r1.openTotal, skipped: [],
    };
    const prev = { name: 'manifest-2026-11-01.json', manifest: first.manifest };
    const second = await runAudit({ ...base, countReport: { name: 'count.json', sha256: 'x', report: count }, previousManifest: prev });
    expect(second.report.blocking).toEqual([]);
    expect(second.report.ready).toBe(true);
    expect(second.report.parity).toMatchObject({ ok: true, file: 'count.json' });
    expect(second.report.hashCheck).toEqual({ against: 'manifest-2026-11-01.json', changed: [], missing: [] });
    expect(second.report.statusCounts.BULAN_DELISTING).toBe(1);

    // File cache yang ditulis ulang (isi sama, byte berbeda) terdeteksi dan menghalangi; begitu juga pohon kerja kotor.
    const file = cacheFilePath(dir, 'AAAUSDT', '1h', '2026-09');
    await writeFile(file, JSON.stringify(JSON.parse(await readFile(file, 'utf8')), null, 1));
    const third = await runAudit({
      ...base, countReport: { name: 'count.json', sha256: 'x', report: count }, previousManifest: prev, version: { ...version, gitClean: false },
    });
    expect(third.report.hashCheck.changed.map((c) => c.file)).toEqual(['AAAUSDT/1h/2026-09.json']);
    expect(third.report.ready).toBe(false);
    expect(third.report.blocking.join(' | ')).toMatch(/file cache berubah.*1 berubah.*pohon kerja main tidak bersih/);
  }, 120_000);
});
