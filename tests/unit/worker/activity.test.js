import { describe, expect, it } from 'vitest';
import { ACTIVITY_LIMIT, NOOP_ACTIVITY, createActivityFeed } from '../../../worker/activity.js';

const clockFrom = (start = Date.UTC(2026, 10, 15, 12, 0, 0)) => {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => { now += ms; };
  return clock;
};

describe('log aktivitas worker (worker/activity.js)', () => {
  it('UNIT-ACT-001 entri berurutan dengan id naik & stempel jam; list() salinan terlama → terbaru; cincin dibatasi limit', () => {
    const clock = clockFrom();
    const feed = createActivityFeed({ clock, limit: 3 });
    feed.start();
    clock.advance(1_000);
    feed.discovery({ cycle: 'initial', symbols: 40 });
    feed.ws({ state: 'open', reconnects: 0 });
    feed.scan({ seq: 1, series: 120, fresh: 120, stale: 0, repaired: 0, priced: 118, durationMs: 4, open: { long: 4, short: 2, radar: 38 } });
    const list = feed.list();
    expect(list.map((e) => [e.id, e.kind])).toEqual([[2, 'discovery'], [3, 'ws'], [4, 'scan']]);
    expect(list[0]).toEqual({ id: 2, at: clock(), kind: 'discovery', cycle: 'initial', symbols: 40, failed: false });
    expect(list[2].open).toEqual({ long: 4, short: 2, radar: 38 });
    list[2].open.long = 99;
    expect(feed.list()[2].open.long).toBe(4);
    expect(ACTIVITY_LIMIT).toBe(30);
  });

  it('UNIT-ACT-002 candle dianalisis digabung per timeframe × waktu tutup (satu entri "n koin"); entri yang terdorong keluar tidak digabung lagi', () => {
    const added = [];
    const feed = createActivityFeed({ clock: clockFrom(), limit: 2, onAdd: (e) => added.push(e.kind) });
    const close = Date.UTC(2026, 10, 15, 12, 14, 59, 999);
    for (let i = 0; i < 40; i += 1) feed.candles({ timeframe: '15m', closeTime: close });
    feed.candles({ timeframe: '1h', closeTime: close + 45 * 60_000 });
    expect(feed.list()).toEqual([
      expect.objectContaining({ kind: 'candles', timeframe: '15m', closeTime: close, count: 40 }),
      expect.objectContaining({ kind: 'candles', timeframe: '1h', count: 1 }),
    ]);
    expect(added).toHaveLength(41);
    feed.start();
    feed.start();
    feed.candles({ timeframe: '15m', closeTime: close });
    expect(feed.list().at(-1)).toMatchObject({ kind: 'candles', timeframe: '15m', count: 1 });
    expect(feed.candles({ timeframe: '4h', closeTime: close })).toBeNull();
    expect(feed.candles({ timeframe: '15m', closeTime: Number.NaN })).toBeNull();
  });

  it('UNIT-ACT-003 sinyal / kandidat / galat disaring: simbol, timeframe, kode, tier, sumber tidak valid → null/default; pesan dipotong 160 karakter', () => {
    const feed = createActivityFeed({ clock: clockFrom() });
    feed.signal({ symbol: 'ETHUSDT', timeframe: '15m', direction: 'SHORT', state: 'EARLY_BEARISH', view: { confluence: { tier: 'B' } } });
    feed.signal({ symbol: 'eth<script>', timeframe: '2h', direction: 'X', state: 'drop table', view: { confluence: { tier: 'Z' } } });
    feed.reversal({ symbol: 'BTCUSDT', timeframe: '1h', stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING' });
    feed.error({ source: 'Backfill!', symbol: 'BTCUSDT', timeframe: '1h', message: 'x'.repeat(500) });
    const [ok, bad, rev, err] = feed.list();
    expect(ok).toMatchObject({ kind: 'signal', symbol: 'ETHUSDT', timeframe: '15m', direction: 'SHORT', state: 'EARLY_BEARISH', tier: 'B' });
    expect(bad).toMatchObject({ kind: 'signal', symbol: null, timeframe: null, direction: 'LONG', state: null, tier: null });
    expect(rev).toMatchObject({ kind: 'reversal', symbol: 'BTCUSDT', timeframe: '1h', stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING' });
    expect(err).toMatchObject({ kind: 'error', source: 'scanner', symbol: 'BTCUSDT', timeframe: '1h' });
    expect(err.message).toHaveLength(160);
  });

  it('UNIT-ACT-004 NOOP_ACTIVITY tidak menyimpan apa pun; limit tidak valid ditolak', () => {
    NOOP_ACTIVITY.start();
    NOOP_ACTIVITY.candles({ timeframe: '1h', closeTime: 1 });
    expect(NOOP_ACTIVITY.list()).toEqual([]);
    expect(() => createActivityFeed({ limit: 0 })).toThrow(RangeError);
    expect(() => createActivityFeed({ limit: 501 })).toThrow(RangeError);
  });
});
