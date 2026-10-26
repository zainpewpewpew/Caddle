import { describe, expect, it } from 'vitest';
import { analyzeLiquidity, LIQUIDITY_THRESHOLDS } from '../../../backend/features/liquidity.js';
import { findSwings } from '../../../backend/indicators/swings.js';
import { mirrorCandles } from '../../../backend/patterns/mirror.js';

// Candle SINTETIS deterministik (bukan data pasar nyata).
const bar = (open, high, low, close, volume = 1000) => ({ open, high, low, close, volume });

/** Range berosilasi di sekitar `mid` (amplitudo `amp`, periode 12 candle) — swing low/high jelas. */
function rangeCandles(n, { mid = 100, amp = 1.5, wick = 0.4, volume = 1000 } = {}) {
  const out = [];
  let prev = mid;
  for (let i = 0; i < n; i += 1) {
    const close = mid + amp * Math.sin((2 * Math.PI * i) / 12);
    const open = prev;
    out.push(bar(open, Math.max(open, close) + wick, Math.min(open, close) - wick, close, volume + (i % 3) * 10));
    prev = close;
  }
  return out;
}

const lastConfirmedLow = (candles, before) => {
  const lows = findSwings(candles).lows.filter((s) => s.confirmedIndex < before);
  return lows[lows.length - 1];
};

describe('analyzeLiquidity', () => {
  it('UNIT-LIQ-001 spring tertanam: low menembus swing low terkonfirmasi lalu close kembali di atasnya', () => {
    const base = rangeCandles(70);
    const level = lastConfirmedLow(base, 70).price;
    const c = [...base];
    const p = c[c.length - 1].close;
    c.push(bar(p, p + 0.2, level - 1.2, level - 0.6, 2500)); // sapuan di bawah level
    c.push(bar(level + 0.2, level + 0.8, level + 0.1, level + 0.6)); // low di atas level: bukan sapuan baru
    c.push(bar(level + 0.6, level + 1.2, level + 0.3, level + 1.0));
    const r = analyzeLiquidity(c);
    expect(r.sweepLow).not.toBeNull();
    expect(r.sweepLow.index).toBe(70);
    expect(r.sweepLow.level).toBe(level);
    expect(r.sweepLow.barsAgo).toBe(2);
    expect(r.sweepLow.reclaimed).toBe(true);
    // Belum reclaimed bila candle terakhir masih close di bawah level.
    const notYet = analyzeLiquidity(c.slice(0, 71));
    expect(notYet.sweepLow).toMatchObject({ index: 70, level, reclaimed: false, barsAgo: 0 });
  });

  it('UNIT-LIQ-002 upthrust (cermin): high menembus swing high lalu close kembali di bawahnya', () => {
    const base = rangeCandles(70);
    const highs = findSwings(base).highs.filter((s) => s.confirmedIndex < 70);
    const level = highs[highs.length - 1].price;
    const c = [...base];
    const p = c[c.length - 1].close;
    c.push(bar(p, level + 1.2, p - 0.2, level + 0.6, 2500));
    c.push(bar(level - 0.2, level - 0.1, level - 0.8, level - 0.6)); // high di bawah level
    const r = analyzeLiquidity(c);
    expect(r.sweepHigh).toMatchObject({ index: 70, level, reclaimed: true, barsAgo: 1 });
  });

  it('UNIT-LIQ-003 sapuan di luar sweepBars diabaikan; tanpa sapuan → null', () => {
    const base = rangeCandles(70);
    const r = analyzeLiquidity(base);
    expect(r.sweepLow).toBeNull();
    expect(r.sweepHigh).toBeNull();
    const level = lastConfirmedLow(base, 70).price;
    const c = [...base, bar(100, 100.2, level - 1, level + 0.5)];
    for (let i = 0; i < 6; i += 1) c.push(bar(level + 0.5, level + 0.9, level + 0.2, level + 0.6));
    expect(analyzeLiquidity(c, { sweepBars: 5 }).sweepLow).toBeNull();
    expect(analyzeLiquidity(c, { sweepBars: 7 }).sweepLow).toMatchObject({ index: 70, barsAgo: 6 });
  });

  it('UNIT-LIQ-004 selling climax: candle merah, volume ≥ 3× median, range ≥ 2× ATR di area bawah', () => {
    const base = rangeCandles(70);
    const p = base[base.length - 1].close;
    const c = [...base, bar(p, p + 0.1, p - 6, p - 5.5, 6000), bar(p - 5.5, p - 5, p - 6.2, p - 5.2)];
    const r = analyzeLiquidity(c);
    expect(r.climax).not.toBeNull();
    expect(r.climax.type).toBe('SELLING');
    expect(r.climax.index).toBe(70);
    expect(r.climax.barsAgo).toBe(1);
    expect(r.climax.volumeRatio).toBeGreaterThanOrEqual(LIQUIDITY_THRESHOLDS.climaxVolumeMult);
    // Volume besar tapi range kecil → bukan climax.
    const small = [...base, bar(p, p + 0.1, p - 0.3, p - 0.2, 6000)];
    expect(analyzeLiquidity(small).climax).toBeNull();
  });

  it('UNIT-LIQ-005 buying climax: candle hijau besar bervolume tinggi di area atas', () => {
    const base = rangeCandles(70);
    const p = base[base.length - 1].close;
    const r = analyzeLiquidity([...base, bar(p, p + 6, p - 0.1, p + 5.5, 6000)]);
    expect(r.climax).toMatchObject({ type: 'BUYING', index: 70, barsAgo: 0 });
  });

  it('UNIT-LIQ-006 range sempit → inRange; tren lebar atau breakout candle terakhir → tidak', () => {
    const narrow = rangeCandles(80);
    const r = analyzeLiquidity(narrow);
    expect(r.rangeHigh).toBeGreaterThan(r.rangeLow);
    expect(r.rangeWidthAtr).toBeGreaterThan(0);
    expect(r.rangeWidthAtr).toBeLessThanOrEqual(LIQUIDITY_THRESHOLDS.maxRangeWidthAtr);
    expect(r.position).toBeGreaterThanOrEqual(0);
    expect(r.position).toBeLessThanOrEqual(1);
    expect(r.inRange).toBe(true);

    const trend = [];
    for (let i = 0; i < 80; i += 1) trend.push(bar(100 + i, 100.6 + i + 0.4, 99.8 + i, 100.5 + i));
    const t = analyzeLiquidity(trend);
    expect(t.rangeWidthAtr).toBeGreaterThan(LIQUIDITY_THRESHOLDS.maxRangeWidthAtr);
    expect(t.inRange).toBe(false);

    const p = narrow[narrow.length - 1].close;
    const breakout = analyzeLiquidity([...narrow, bar(p, r.rangeHigh + 1, p, r.rangeHigh + 0.8)]);
    expect(breakout.position).toBe(1);
    expect(breakout.inRange).toBe(false);
  });

  it('UNIT-LIQ-007 absorpsi: volume tinggi range kecil dekat low → positif; dekat high → negatif', () => {
    const base = rangeCandles(70, { amp: 3 });
    const { rangeLow, rangeHigh } = analyzeLiquidity(base);
    const nearLow = [...base];
    const nearHigh = [...base];
    for (let i = 0; i < 10; i += 1) {
      nearLow.push(bar(rangeLow + 0.3, rangeLow + 0.4, rangeLow + 0.2, rangeLow + 0.3, 3500));
      nearHigh.push(bar(rangeHigh - 0.3, rangeHigh - 0.2, rangeHigh - 0.4, rangeHigh - 0.3, 3500));
    }
    const a = analyzeLiquidity(nearLow).absorption;
    const b = analyzeLiquidity(nearHigh).absorption;
    expect(a).toBeGreaterThan(0.2);
    expect(a).toBeLessThanOrEqual(1);
    expect(b).toBeLessThan(-0.2);
    expect(b).toBeGreaterThanOrEqual(-1);
  });

  it('UNIT-LIQ-008 anti-lookahead: hasil pada prefix tidak berubah oleh candle masa depan & level swing terkonfirmasi', () => {
    const base = rangeCandles(70);
    const level = lastConfirmedLow(base, 70).price;
    const c = [...base, bar(100, 100.2, level - 1.2, level - 0.6, 2500), bar(level - 0.6, level + 0.8, level - 0.7, level + 0.6)];
    for (let k = 1; k <= c.length; k += 1) {
      const prefix = c.slice(0, k);
      const future = [...prefix, bar(50, 200, 1, 150, 1e6), bar(150, 151, 2, 3, 1e6)];
      const r = analyzeLiquidity(prefix);
      expect(analyzeLiquidity(future.slice(0, k))).toEqual(r);
      for (const s of [r.sweepLow, r.sweepHigh, r.climax]) if (s) expect(s.index).toBeLessThanOrEqual(k - 1);
      if (r.sweepLow) {
        const swing = findSwings(prefix).lows.find((x) => x.price === r.sweepLow.level);
        expect(swing.confirmedIndex).toBeLessThan(r.sweepLow.index);
      }
    }
  });

  it('UNIT-LIQ-009 simetri cermin: sweepLow ↔ sweepHigh pada mirrorCandles', () => {
    const base = rangeCandles(70);
    const level = lastConfirmedLow(base, 70).price;
    const c = [...base, bar(100, 100.2, level - 1.2, level - 0.6, 2500), bar(level - 0.6, level + 0.8, level - 0.7, level + 0.6)];
    const real = analyzeLiquidity(c);
    const mirror = analyzeLiquidity(mirrorCandles(c));
    expect(real.sweepLow).not.toBeNull();
    expect(mirror.sweepHigh).not.toBeNull();
    expect(mirror.sweepHigh.index).toBe(real.sweepLow.index);
    expect(mirror.sweepHigh.barsAgo).toBe(real.sweepLow.barsAgo);
    expect(mirror.sweepHigh.reclaimed).toBe(real.sweepLow.reclaimed);
    expect(mirror.sweepHigh.level).toBeCloseTo(1 / real.sweepLow.level, 12);
    expect(mirror.sweepLow === null).toBe(real.sweepHigh === null);
  });

  it('EDGE-LIQ-001 data kurang → null/false', () => {
    expect(analyzeLiquidity([])).toEqual({
      rangeHigh: null, rangeLow: null, rangeWidthAtr: null, position: null, inRange: false,
      sweepLow: null, sweepHigh: null, climax: null, absorption: null,
    });
    const r = analyzeLiquidity(rangeCandles(20));
    expect(r.rangeHigh).toBeNull();
    expect(r.inRange).toBe(false);
    expect(r.climax).toBeNull();
    expect(r.absorption).toBeNull();
  });

  it('NEG-LIQ-001 argumen tidak valid ditolak', () => {
    expect(() => analyzeLiquidity(null)).toThrow(TypeError);
    expect(() => analyzeLiquidity([], { lookback: 1 })).toThrow(RangeError);
    expect(() => analyzeLiquidity([], { sweepBars: 0 })).toThrow(RangeError);
  });
});
