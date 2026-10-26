import { describe, expect, it } from 'vitest';
import { labelTrade } from '../../../backend/backtest/labeler.js';

const c = (open, high, low, close, closeTime) => ({ open, high, low, close, closeTime });
const NO_COST = { feeBps: 0, slippageBps: 0 };
// Candle sinyal: close 100 = entry.
const ENTRY = c(99, 101, 98, 100);

describe('labelTrade (triple barrier)', () => {
  it('UNIT-BT-LBL-001 LONG WIN: target 110 tersentuh di candle ke-2', () => {
    // entry 100, stop 95 → risk 5, target = 100 + 2·5 = 110.
    // candle 1: low 97 → MAE (97−100)/5 = −0,6; high 104 → MFE 0,8. candle 2: high 111 ≥ 110 → WIN di 110.
    const candles = [ENTRY, c(100, 104, 97, 103), c(103, 111, 102, 108, 777)];
    const t = labelTrade({ candles, entryIndex: 0, direction: 'LONG', entryPrice: 100, stopPrice: 95, ...NO_COST });
    expect(t.outcome).toBe('WIN');
    expect(t.targetPrice).toBe(110);
    expect(t.exitIndex).toBe(2);
    expect(t.exitPrice).toBe(110);
    expect(t.exitTime).toBe(777);
    expect(t.rMultiple).toBeCloseTo(2, 12);
    expect(t.mfeR).toBeCloseTo(2, 12);
    expect(t.maeR).toBeCloseTo(-0.6, 12);
    expect(t.barsHeld).toBe(2);
  });

  it('UNIT-BT-LBL-002 biaya mengurangi R: fee 4 + slip 2 bps per sisi', () => {
    // costR = 0,0006 · (100 + 110) / 5 = 0,0252 → rMultiple = 2 − 0,0252 = 1,9748.
    const candles = [ENTRY, c(100, 104, 97, 103), c(103, 111, 102, 108)];
    const t = labelTrade({ candles, entryIndex: 0, direction: 'LONG', entryPrice: 100, stopPrice: 95 });
    expect(t.grossR).toBeCloseTo(2, 12);
    expect(t.costR).toBeCloseTo(0.0252, 12);
    expect(t.rMultiple).toBeCloseTo(1.9748, 12);
    // LOSS juga lebih buruk dari −1: costR = 0,0006·(100+95)/5 = 0,0234 → −1,0234.
    const loss = labelTrade({ candles: [ENTRY, c(99, 100, 94, 96)], entryIndex: 0, direction: 'LONG', entryPrice: 100, stopPrice: 95 });
    expect(loss.rMultiple).toBeCloseTo(-1.0234, 12);
  });

  it('UNIT-BT-LBL-003 stop & target tersentuh di candle yang sama → LOSS (konservatif)', () => {
    // high 111 ≥ 110 dan low 94 ≤ 95 → urutan intrabar tak diketahui → anggap stop dulu, keluar di 95 (R −1).
    const t = labelTrade({ candles: [ENTRY, c(100, 111, 94, 105)], entryIndex: 0, direction: 'LONG', entryPrice: 100, stopPrice: 95, ...NO_COST });
    expect(t.outcome).toBe('LOSS');
    expect(t.exitPrice).toBe(95);
    expect(t.rMultiple).toBeCloseTo(-1, 12);
    expect(t.mfeR).toBe(0); // ekskursi menguntungkan di candle LOSS diabaikan
    expect(t.maeR).toBeCloseTo(-1, 12);
    expect(t.gap).toBe(false);
  });

  it('UNIT-BT-LBL-004 gap melewati stop → keluar di open (lebih buruk)', () => {
    // open 90 < stop 95 → exit 90 → R = (90−100)/5 = −2.
    const t = labelTrade({ candles: [ENTRY, c(90, 92, 88, 91)], entryIndex: 0, direction: 'LONG', entryPrice: 100, stopPrice: 95, ...NO_COST });
    expect(t.outcome).toBe('LOSS');
    expect(t.gap).toBe(true);
    expect(t.exitPrice).toBe(90);
    expect(t.rMultiple).toBeCloseTo(-2, 12);
    expect(t.maeR).toBeCloseTo(-2, 12);
  });

  it('UNIT-BT-LBL-005 gap melewati target → diisi di target, bukan open', () => {
    const t = labelTrade({ candles: [ENTRY, c(115, 118, 113, 116)], entryIndex: 0, direction: 'LONG', entryPrice: 100, stopPrice: 95, ...NO_COST });
    expect(t.outcome).toBe('WIN');
    expect(t.exitPrice).toBe(110);
    expect(t.rMultiple).toBeCloseTo(2, 12);
  });

  it('UNIT-BT-LBL-006 SHORT cermin: WIN, LOSS, gap, candle ganda', () => {
    // entry 100, stop 105 → risk 5, target 90.
    const base = { entryIndex: 0, direction: 'SHORT', entryPrice: 100, stopPrice: 105, ...NO_COST };
    // high 103 → MAE −(103−100)/5 = −0,6; low 89 ≤ 90 → WIN.
    const win = labelTrade({ ...base, candles: [ENTRY, c(100, 103, 89, 92)] });
    expect(win.outcome).toBe('WIN');
    expect(win.targetPrice).toBe(90);
    expect(win.rMultiple).toBeCloseTo(2, 12);
    expect(win.maeR).toBeCloseTo(-0.6, 12);
    const loss = labelTrade({ ...base, candles: [ENTRY, c(101, 106, 99, 104)] });
    expect(loss.outcome).toBe('LOSS');
    expect(loss.exitPrice).toBe(105);
    expect(loss.rMultiple).toBeCloseTo(-1, 12);
    const gap = labelTrade({ ...base, candles: [ENTRY, c(110, 112, 108, 111)] });
    expect(gap.gap).toBe(true);
    expect(gap.rMultiple).toBeCloseTo(-2, 12); // −(110−100)/5
    const both = labelTrade({ ...base, candles: [ENTRY, c(100, 106, 89, 95)] });
    expect(both.outcome).toBe('LOSS');
    // Biaya SHORT: costR = 0,0006·(100+90)/5 = 0,0228.
    const costly = labelTrade({ ...base, feeBps: 4, slippageBps: 2, candles: [ENTRY, c(100, 103, 89, 92)] });
    expect(costly.rMultiple).toBeCloseTo(2 - 0.0228, 12);
  });

  it('UNIT-BT-LBL-007 TIMEOUT di close candle entryIndex+maxBars', () => {
    // maxBars 3: tiga candle tanpa penghalang; close terakhir 101 → R 0,2; MFE (102−100)/5 = 0,4; MAE −0,4.
    const flat = c(100, 102, 98, 101);
    const t = labelTrade({ candles: [ENTRY, flat, flat, flat, c(101, 120, 101, 119)], entryIndex: 0, direction: 'LONG', entryPrice: 100, stopPrice: 95, maxBars: 3, ...NO_COST });
    expect(t.outcome).toBe('TIMEOUT');
    expect(t.exitIndex).toBe(3);
    expect(t.barsHeld).toBe(3);
    expect(t.rMultiple).toBeCloseTo(0.2, 12);
    expect(t.mfeR).toBeCloseTo(0.4, 12);
    expect(t.maeR).toBeCloseTo(-0.4, 12);
  });

  it('UNIT-BT-LBL-008 data habis sebelum maxBars → OPEN (mark-to-market)', () => {
    const flat = c(100, 102, 98, 101);
    const t = labelTrade({ candles: [ENTRY, flat, flat], entryIndex: 0, direction: 'LONG', entryPrice: 100, stopPrice: 95, maxBars: 3, ...NO_COST });
    expect(t.outcome).toBe('OPEN');
    expect(t.exitIndex).toBe(2);
    expect(t.barsHeld).toBe(2);
    const none = labelTrade({ candles: [ENTRY], entryIndex: 0, direction: 'LONG', entryPrice: 100, stopPrice: 95, ...NO_COST });
    expect(none.outcome).toBe('OPEN');
    expect(none.barsHeld).toBe(0);
  });

  it('UNIT-BT-LBL-009 tidak membaca candle sebelum/sesudah jendela (anti lookahead pada entry)', () => {
    // Candle 0 (sebelum entry) menembus stop — harus diabaikan; entryIndex 1.
    const candles = [c(100, 130, 50, 100), ENTRY, c(100, 111, 99, 108)];
    const t = labelTrade({ candles, entryIndex: 1, direction: 'LONG', entryPrice: 100, stopPrice: 95, ...NO_COST });
    expect(t.outcome).toBe('WIN');
    expect(t.barsHeld).toBe(1);
  });

  it('NEG-BT-LBL-001 input tidak valid → null', () => {
    const candles = [ENTRY, c(100, 104, 97, 103)];
    const base = { candles, entryIndex: 0, direction: 'LONG', entryPrice: 100, stopPrice: 95 };
    expect(labelTrade({ ...base, stopPrice: 105 })).toBeNull(); // stop di atas entry untuk LONG
    expect(labelTrade({ ...base, direction: 'SHORT' })).toBeNull(); // stop di bawah entry untuk SHORT
    expect(labelTrade({ ...base, stopPrice: 100 })).toBeNull(); // risk 0
    expect(labelTrade({ ...base, direction: 'UP' })).toBeNull();
    expect(labelTrade({ ...base, entryIndex: 5 })).toBeNull();
    expect(labelTrade({ ...base, maxBars: 0 })).toBeNull();
    expect(labelTrade({ ...base, candles: null })).toBeNull();
    expect(labelTrade()).toBeNull();
  });
});
