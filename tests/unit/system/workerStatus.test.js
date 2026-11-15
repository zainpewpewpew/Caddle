import { describe, expect, it } from 'vitest';
import { HEARTBEAT_STALE_MS, isHeartbeatLive, summarizeWorker } from '../../../backend/system/workerStatus.js';

const NOW = Date.UTC(2026, 5, 1);
const beat = (state, ageMs = 0) => ({ heartbeat: { at: NOW - ageMs, state }, lastRun: null, recentErrors: [] });

describe('ringkasan status worker', () => {
  it('UNIT-WST-001 tanpa heartbeat → not_running; tanpa getStatus → tetap aman', () => {
    expect(summarizeWorker(null, NOW).scanner.status).toBe('not_running');
    expect(summarizeWorker({ heartbeat: null, lastRun: null, recentErrors: [] }, NOW).binance.status).toBe('unknown');
  });

  it.each([
    ['running + ws open', { state: 'running', ws: 'open' }, 0, 'ok', 'ok'],
    ['degraded + reconnecting', { state: 'degraded', ws: 'reconnecting' }, 0, 'degraded', 'reconnecting'],
    ['starting', { state: 'starting', ws: 'connecting' }, 0, 'starting', 'connecting'],
    ['stopped (heartbeat akhir)', { state: 'stopped', ws: 'stopped' }, 0, 'stopped', 'unknown'],
    ['running tetapi heartbeat basi', { state: 'running', ws: 'open' }, HEARTBEAT_STALE_MS + 1, 'stale', 'unknown'],
    ['tepat di batas basi masih segar', { state: 'running', ws: 'open' }, HEARTBEAT_STALE_MS, 'ok', 'ok'],
    ['state bukan objek', 'running', 0, 'unknown', 'unknown'],
  ])('UNIT-WST-002 %s', (_label, state, age, scanner, binance) => {
    const r = summarizeWorker(beat(state, age), NOW);
    expect(r.scanner.status).toBe(scanner);
    expect(r.binance.status).toBe(binance);
  });

  it('UNIT-WST-004 offset jam & clockFault diteruskan; nilai clockFault tak dikenal dibuang', () => {
    const r = summarizeWorker(beat({ state: 'degraded', ws: 'open', clockOffsetMs: -1234, clockFault: 'OFFSET_OUT_OF_RANGE' }), NOW);
    expect(r.scanner.status).toBe('degraded');
    expect(r.scanner.clockOffsetMs).toBe(-1234);
    expect(r.scanner.clockFault).toBe('OFFSET_OUT_OF_RANGE');
    const other = summarizeWorker(beat({ state: 'running', clockOffsetMs: 'x', clockFault: '<script>' }), NOW);
    expect(other.scanner.clockOffsetMs).toBeNull();
    expect(other.scanner.clockFault).toBeNull();
  });

  it('UNIT-WST-003 metrik non-angka tidak diteruskan; error dibatasi 5 terbaru', () => {
    const errors = Array.from({ length: 9 }, (_, i) => ({ id: i, at: NOW - i, source: 'ws', message: `e${i}` }));
    const r = summarizeWorker({ heartbeat: { at: NOW, state: { state: 'running', symbols: '40', queue: Number.NaN, errors: 3 } }, lastRun: null, recentErrors: errors }, NOW);
    expect(r.scanner.symbols).toBeNull();
    expect(r.scanner.queue).toBeNull();
    expect(r.scanner.errors).toBe(3);
    expect(r.ingestion.recentErrors.map((e) => e.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('UNIT-WST-005 isHeartbeatLive: segar & bukan stopped; batas basi inklusif; input rusak → false', () => {
    expect(isHeartbeatLive({ at: NOW, state: { state: 'running' } }, NOW)).toBe(true);
    expect(isHeartbeatLive({ at: NOW - HEARTBEAT_STALE_MS, state: { state: 'starting' } }, NOW)).toBe(true);
    expect(isHeartbeatLive({ at: NOW - HEARTBEAT_STALE_MS - 1, state: { state: 'running' } }, NOW)).toBe(false);
    expect(isHeartbeatLive({ at: NOW, state: { state: 'stopped' } }, NOW)).toBe(false);
    expect(isHeartbeatLive({ at: NOW, state: 'running' }, NOW)).toBe(true);
    expect(isHeartbeatLive(null, NOW)).toBe(false);
    expect(isHeartbeatLive({ at: 'x', state: {} }, NOW)).toBe(false);
  });
});

describe('ringkasan scan berkala & log aktivitas (strip status)', () => {
  const SCAN = {
    seq: 57, at: NOW - 2_000, finishedAt: NOW - 1_990, durationMs: 10, symbols: 40, series: 120, fresh: 119, stale: 1, repaired: 0,
    priced: 118, lastPriceAt: NOW - 1_000, open: { long: 4, short: 2, radar: 38 }, intervalMs: 60_000, nextAt: NOW + 58_000,
  };

  it('UNIT-WST-010 scan & jadwal diteruskan apa adanya selama heartbeat segar; jadwal null saat basi; field asing dibuang', () => {
    const r = summarizeWorker(beat({ state: 'running', ws: 'open', scan: { ...SCAN, owner: { pid: 1 } }, scanIntervalMs: 60_000, nextScanAt: NOW + 58_000 }), NOW);
    expect(r.scanner.scan).toEqual(SCAN);
    expect(r.scanner.scanIntervalMs).toBe(60_000);
    expect(r.scanner.nextScanAt).toBe(NOW + 58_000);
    const stale = summarizeWorker(beat({ state: 'running', scan: SCAN, nextScanAt: NOW + 1 }, HEARTBEAT_STALE_MS + 1), NOW);
    expect(stale.scanner.scan.seq).toBe(57);
    expect(stale.scanner.nextScanAt).toBeNull();
    expect(summarizeWorker(beat({ state: 'running', scan: { seq: -1, at: NOW } }), NOW).scanner.scan).toBeNull();
    expect(summarizeWorker(beat({ state: 'running', scan: [] }), NOW).scanner.scan).toBeNull();
    const odd = summarizeWorker(beat({ state: 'running', scan: { ...SCAN, fresh: '119', open: { long: -1, short: 2.5, radar: 3 } } }), NOW).scanner.scan;
    expect(odd.fresh).toBeNull();
    expect(odd.open).toEqual({ long: null, short: null, radar: 3 });
  });

  it('UNIT-WST-011 aktivitas: hanya kind dikenal dengan id/at sah; field per kind disaring; pesan galat tanpa karakter kontrol, maks 160; maks 30 entri terbaru', () => {
    const activity = [
      { id: 1, at: NOW - 9, kind: 'start' },
      { id: 2, at: NOW - 8, kind: 'evil', html: '<img>' },
      { id: 'x', at: NOW - 7, kind: 'start' },
      { id: 4, at: NOW - 6, kind: 'signal', symbol: 'ETHUSDT', timeframe: '15m', direction: 'SHORT', state: 'EARLY_BEARISH', tier: 'B', extra: 1 },
      { id: 5, at: NOW - 5, kind: 'error', source: 'backfill', symbol: 'BTCUSDT', timeframe: '1h', message: `a\u001b[31mb‮c${'z'.repeat(300)}` },
      { id: 6, at: NOW - 4, kind: 'candles', timeframe: '15m', closeTime: NOW - 60_001, count: 40 },
      { id: 7, at: NOW - 3, kind: 'reversal', symbol: 'bad sym', timeframe: '1h', stage: 'CONFIRMED_BREAKOUT', status: 'CONFIRMED' },
    ];
    const r = summarizeWorker(beat({ state: 'running', activity }), NOW).scanner.activity;
    expect(r.map((e) => e.id)).toEqual([1, 4, 5, 6, 7]);
    expect(r[1]).toEqual({ id: 4, at: NOW - 6, kind: 'signal', symbol: 'ETHUSDT', timeframe: '15m', direction: 'SHORT', state: 'EARLY_BEARISH', tier: 'B' });
    expect(r[2].message.startsWith('a [31mb c')).toBe(true);
    expect(r[2].message).toHaveLength(160);
    expect(r[4].symbol).toBeNull();
    const many = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, at: NOW, kind: 'start' }));
    expect(summarizeWorker(beat({ state: 'running', activity: many }), NOW).scanner.activity.map((e) => e.id)[0]).toBe(16);
    expect(summarizeWorker(beat({ state: 'running', activity: 'x' }), NOW).scanner.activity).toEqual([]);
  });
});
