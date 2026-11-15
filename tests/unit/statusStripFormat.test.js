import { describe, expect, it } from 'vitest';
import { LIVE_PRICE_MAX_AGE_MS, livePriceOf, priceSortValue } from '../../frontend/js/views/liveData.js';
import {
  activityEntries, activityText, activityTone, clockHm, clockHms, formatCountdown, nextCandleClose, serverSkewMs, stripModel,
} from '../../frontend/js/views/statusStripFormat.js';

// 2026-11-15 12:04:20 UTC = 19:04:20 WIB.
const NOW = Date.UTC(2026, 10, 15, 12, 4, 20);
const RUNNING = { enabled: true, state: 'running', startedAt: NOW - 600_000, stoppedAt: null, exitCode: null, signal: null, via: 'autostart', autoRestart: true, restartAt: null };
const SCAN = {
  seq: 57, at: NOW - 15_000, symbols: 40, series: 120, fresh: 120, stale: 0, repaired: 0, priced: 118, lastPriceAt: NOW - 2_000,
  open: { long: 4, short: 2 }, intervalMs: 60_000, nextAt: NOW + 45_000,
};
const live = (over = {}) => ({
  serverTime: NOW, requestedAt: NOW, worker: RUNNING, binance: { status: 'ok', ws: 'open' }, recentErrors: [],
  scanner: {
    status: 'ok', heartbeatAt: NOW - 5_000, symbols: 40, streams: 120, staleStreams: 0, nextScanAt: NOW + 45_000, scan: SCAN, activity: [],
    sync: { step: 'live', cycle: 'initial', streamsTotal: 120, streamsDone: 120, progress: null, lastCandleAt: NOW - 260_000 },
  },
  ...over,
});

describe('strip status scanner — model tampilan (statusStripFormat.js)', () => {
  it('UNIT-STRIP-001 jam WIB, hitung mundur, dan batas candle berikutnya', () => {
    expect(clockHms(NOW)).toBe('19:04:20');
    expect(clockHm(NOW)).toBe('19:04');
    expect(formatCountdown(48_200)).toBe('0:49');
    expect(formatCountdown(632_000)).toBe('10:32');
    expect(formatCountdown(3_725_000)).toBe('1:02:05');
    expect(formatCountdown(-5)).toBe('0:00');
    expect(clockHm(nextCandleClose(NOW, '15m'))).toBe('19:15');
    expect(clockHm(nextCandleClose(NOW, '1h'))).toBe('20:00');
  });

  it('UNIT-STRIP-002 live: label Live + segmen scan (#, jam, hitung mundur), cakupan, harga masuk, candle berikutnya, tabel halaman', () => {
    const page = { source: 'SHORT Scanner', at: NOW - 10_000, nextAt: NOW + 50_000 };
    const m = stripModel(live(), { now: NOW, page });
    expect(m).toMatchObject({ mode: 'sync', tone: 'ok', live: true, label: 'Live', detail: null, progress: null, busy: false });
    expect(m.segments.map((s) => [s.key, s.text])).toEqual([
      ['scan', 'Scan #57 19:04:05 · berikutnya 0:45'],
      ['coverage', '40 koin · 120/120 seri mutakhir'],
      ['price', 'Harga live 118/120 seri'],
      ['candle', 'Candle 15m tutup 19:15 · 1h tutup 20:00 (10:40)'],
      ['page', 'Tabel diperbarui 19:04:10 · berikutnya 0:50'],
    ]);
    // Harga live tidak untuk semua seri → peringatan; semua seri → netral.
    expect(m.segments.find((s) => s.key === 'price').tone).toBe('warn');
    const allPriced = stripModel(live({ scanner: { ...live().scanner, scan: { ...SCAN, priced: 120 } } }), { now: NOW });
    expect(allPriced.segments.find((s) => s.key === 'price')).toMatchObject({ text: 'Harga live 120/120 seri', tone: undefined });
    // Seri tertinggal → segmen cakupan bernada peringatan; tanpa scan → jadwal scan pertama.
    const lagging = stripModel(live({ scanner: { ...live().scanner, scan: { ...SCAN, fresh: 117, stale: 3 } } }), { now: NOW });
    expect(lagging.segments.find((s) => s.key === 'coverage')).toMatchObject({ text: '40 koin · 117/120 seri mutakhir', tone: 'warn' });
    const first = stripModel(live({ scanner: { ...live().scanner, scan: null } }), { now: NOW });
    expect(first.segments[0].text).toBe('Scan pertama 19:05:05 (0:45)');
    expect(first.segments[1].text).toBe('40 koin · 120/120 seri mutakhir');
  });

  it('UNIT-STRIP-003 sinkron awal: langkah + progres backfill; rediscovery di samping stream live tetap Live dengan keterangan', () => {
    const boot = live({ scanner: { ...live().scanner, scan: null, sync: { step: 'bootstrap', cycle: 'initial', streamsTotal: 120, streamsDone: 45, progress: 0.375 } } });
    expect(stripModel(boot, { now: NOW })).toMatchObject({
      tone: 'warn', label: 'Sinkron data', detail: 'Mengunduh histori candle 45/120 seri (37%)', progress: { ratio: 0.375 }, segments: [],
    });
    const clock = live({ scanner: { ...live().scanner, sync: { step: 'clock', cycle: 'initial' } } });
    expect(stripModel(clock, { now: NOW })).toMatchObject({ label: 'Sinkron data', detail: 'Menyamakan jam dengan server Binance…', busy: true });
    const redis = live({ scanner: { ...live().scanner, sync: { step: 'discovery', cycle: 'rediscovery' } } });
    expect(stripModel(redis, { now: NOW })).toMatchObject({ label: 'Live', detail: 'Rediscovery berkala berjalan — stream live tetap aktif.' });
    const ws = live({ binance: { status: 'reconnecting', ws: 'reconnecting' } });
    expect(stripModel(ws, { now: NOW })).toMatchObject({ tone: 'warn', live: false, label: 'Menyambung ulang' });
  });

  it('UNIT-STRIP-004 berhenti / crash (dengan jadwal start ulang otomatis) / memulai / heartbeat basi / kontrol mati / memuat', () => {
    const stopped = live({ worker: { ...RUNNING, state: 'stopped', startedAt: null }, scanner: { status: 'stopped', heartbeatAt: NOW - 1_000, sync: null } });
    expect(stripModel(stopped, { now: NOW })).toMatchObject({ mode: 'off', tone: 'idle', label: 'Scanner berhenti' });
    const crashed = live({ worker: { ...RUNNING, state: 'crashed', exitCode: 1, stoppedAt: NOW - 3_000, restartAt: NOW + 17_000 } });
    expect(stripModel(crashed, { now: NOW })).toMatchObject({
      tone: 'error', label: 'Scanner berhenti tak terduga', detail: 'Gagal (kode keluar 1) — dijalankan ulang otomatis 19:04:37 (dalam 0:17)',
    });
    const crashedNoRetry = live({ worker: { ...RUNNING, state: 'crashed', exitCode: 1, restartAt: null } });
    expect(stripModel(crashedNoRetry, { now: NOW }).detail).toContain('Jalankan lagi');
    expect(stripModel(live({ worker: { ...RUNNING, state: 'starting' } }), { now: NOW })).toMatchObject({ mode: 'waiting', label: 'Memulai scanner…', busy: true });
    const stale = live({ scanner: { ...live().scanner, status: 'stale', heartbeatAt: NOW - 180_000 } });
    expect(stripModel(stale, { now: NOW })).toMatchObject({ tone: 'error', label: 'Scanner tidak melapor', detail: 'Heartbeat worker terakhir 3 menit lalu — periksa terminal npm start.' });
    const manual = live({ worker: { enabled: false, state: 'stopped' }, scanner: { status: 'not_running', heartbeatAt: null, sync: null } });
    expect(stripModel(manual, { now: NOW }).detail).toContain('npm run worker');
    expect(stripModel(null, { now: NOW })).toMatchObject({ mode: 'loading', label: 'Memuat status scanner…' });
  });

  it('UNIT-STRIP-005 teks & nada log aktivitas per jenis', () => {
    const close = Date.UTC(2026, 10, 15, 12, 14, 59, 999);
    expect(activityText({ kind: 'scan', seq: 57, series: 120, fresh: 119, stale: 1, repaired: 2, priced: 118, open: { long: 4, short: 2 } }))
      .toBe('Scan #57: 119/120 seri mutakhir · harga live 118 seri · 2 seri ditambal · 1 seri tertinggal · sinyal terbuka LONG 4 · SHORT 2');
    expect(activityText({ kind: 'candles', timeframe: '15m', closeTime: close, count: 40 })).toBe('Candle 15m 19:15 tutup · 40 koin dianalisis');
    expect(activityText({ kind: 'signal', symbol: 'ETHUSDT', timeframe: '15m', direction: 'SHORT', state: 'EARLY_BEARISH', tier: 'B' }))
      .toBe('Sinyal SHORT ETHUSDT 15m → Early bearish (tier B)');
    expect(activityText({ kind: 'error', source: 'backfill', symbol: 'BTCUSDT', timeframe: '1h', message: 'HTTP 500' })).toBe('Galat backfill REST BTCUSDT 1h: HTTP 500');
    expect(activityText({ kind: 'discovery', cycle: 'initial', symbols: 40 })).toBe('Discovery: 40 koin dipilih untuk dipindai');
    expect(activityText({ kind: 'ws', state: 'open', reconnects: 3 })).toBe('Stream live Binance tersambung ulang (ke-3)');
    expect(activityText({ kind: 'bootstrap', series: 120, candles: 60_000, failed: 0 })).toBe('Histori candle disinkron: 120 seri · 60.000 candle');
    expect(activityText({ kind: 'worker', via: 'autostart' })).toBe('Scanner dijalankan otomatis saat server start (npm start)');
    expect(activityTone({ kind: 'signal', direction: 'SHORT' })).toBe('bear');
    expect(activityTone({ kind: 'signal', direction: 'LONG' })).toBe('bull');
    expect(activityTone({ kind: 'scan', stale: 0 })).toBe('ok');
    expect(activityTone({ kind: 'scan', stale: 2 })).toBe('warn');
    expect(activityTone({ kind: 'error' })).toBe('error');
    expect(activityTone({ kind: 'ws', state: 'down' })).toBe('warn');
  });

  it('UNIT-STRIP-006 daftar aktivitas: entri worker + supervisor (dijalankan / crash) terbaru di atas, dengan jam WIB', () => {
    const d = live({
      worker: { ...RUNNING, state: 'crashed', exitCode: 1, startedAt: NOW - 60_000, stoppedAt: NOW - 1_000, restartAt: NOW + 9_000 },
      scanner: {
        ...live().scanner,
        activity: [
          { id: 1, at: NOW - 59_000, kind: 'start' },
          { id: 2, at: NOW - 30_000, kind: 'scan', seq: 1, series: 6, fresh: 6, stale: 0, repaired: 0, priced: 6, open: null },
        ],
      },
    });
    const list = activityEntries(d);
    expect(list.map((e) => [e.kind, e.time])).toEqual([
      ['worker-crash', '19:04:19'], ['scan', '19:03:50'], ['start', '19:03:21'], ['worker', '19:03:20'],
    ]);
    expect(list[0].text).toBe('Scanner berhenti tak terduga — Gagal (kode keluar 1); dijalankan ulang otomatis 19:04:29');
    expect(list[0].tone).toBe('error');
    expect(activityEntries(null)).toEqual([]);
    expect(serverSkewMs({ serverTime: NOW + 1_500, requestedAt: NOW })).toBe(1_500);
    expect(serverSkewMs({ serverTime: NOW, requestedAt: null })).toBe(0);
  });
});

describe('harga live kolom Harga (liveData.js)', () => {
  it('UNIT-LIVE-001 livePrice dipakai selama segar (≤ 2 menit); lebih tua / tidak ada → close candle tertutup terakhir', () => {
    const row = { livePrice: 101.5, livePriceAt: NOW - 30_000, lastPrice: 100, lastCandleAt: NOW - 300_000 };
    expect(livePriceOf(row, NOW)).toEqual({ price: 101.5, live: true, at: NOW - 30_000 });
    expect(livePriceOf({ ...row, livePriceAt: NOW - LIVE_PRICE_MAX_AGE_MS - 1 }, NOW)).toEqual({ price: 100, live: false, at: NOW - 300_000 });
    expect(livePriceOf({ ...row, livePrice: null }, NOW)).toEqual({ price: 100, live: false, at: NOW - 300_000 });
    expect(livePriceOf({ lastPrice: null, lastCandleAt: null }, NOW)).toEqual({ price: null, live: false, at: null });
    expect(priceSortValue({ lastPrice: 7 })).toBe(7);
  });
});
