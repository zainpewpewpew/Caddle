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
