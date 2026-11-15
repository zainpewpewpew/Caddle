// Bahan desain AL-MOM-01 (docs/27): efek terkecil terdeteksi, n wajib, alert sebelumnya, trade dengan stop ATR.
import { describe, expect, it } from 'vitest';
import { MOM_DESIGN, atrTrade, minDetectableEffect, previousAlertIndex, requiredAlerts } from '../../../scripts/research-mom-power.js';

describe('daya AL-MOM-01', () => {
  it('UNIT-MOM-001 efek terkecil terdeteksi & n wajib: (1,96 + 0,84) × SE, berskala √n', () => {
    const mde = minDetectableEffect({ seHist: 0.1, nHist: 1000, n: 1000 });
    expect(mde).toBeCloseTo((1.959964 + 0.841621) * 0.1, 10);
    expect(minDetectableEffect({ seHist: 0.1, nHist: 1000, n: 4000 })).toBeCloseTo(mde / 2, 10);
    // n = 100 × (0,2801585 / 0,14)² = 400,45 → 401
    expect(requiredAlerts({ seHist: 0.1, nHist: 100, effect: 0.14 })).toBe(401);
    expect(minDetectableEffect({ seHist: 0, nHist: 1, n: 1 })).toBeNull();
    expect(requiredAlerts({ seHist: 0.1, nHist: 1, effect: 0 })).toBeNull();
  });

  it('UNIT-MOM-002 previousAlertIndex: alert sebelumnya yang indeksnya lebih kecil dari i, −1 bila belum ada', () => {
    expect([...previousAlertIndex(8, [2, 5])]).toEqual([-1, -1, -1, 2, 2, 2, 5, 5]);
    expect([...previousAlertIndex(3, [])]).toEqual([-1, -1, -1]);
  });

  it('UNIT-MOM-003 atrTrade: entri open i+1, stop 1,5 ATR, target 2R, biaya dipotong; null bila tidak valid', () => {
    // Harga naik 1 per candle dari 100; ATR 2 → entri 111, stop 108, target 117 (kena di candle 17).
    const candles = Array.from({ length: 60 }, (_, k) => ({
      openTime: k * 3_600_000, closeTime: (k + 1) * 3_600_000 - 1, open: 100 + k, high: 100.5 + k, low: 99.5 + k, close: 100 + k,
    }));
    const atrValues = candles.map(() => 2);
    const t = atrTrade(candles, atrValues, 10);
    expect(t.entryTime).toBe(candles[11].openTime);
    expect(t.r).toBeCloseTo(2 - (7 / 10_000) * (111 + 117) / 3, 10);
    expect(atrTrade(candles, atrValues.map(() => 0), 10)).toBeNull();
    expect(atrTrade(candles, atrValues, 59)).toBeNull(); // tidak ada candle i+1
    expect(MOM_DESIGN).toMatchObject({ stopAtr: 1.5, targetR: 2, maxBars: 48, feeBps: 5, slippageBps: 2 });
  });
});
