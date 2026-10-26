// Audit matematika indikator & detektor pola LONG (SA/PVA) terhadap referensi independen.
// Referensi ditulis ulang di sini (bukan memanggil kode produksi) mengikuti definisi standar
// TradingView/Binance: EMA diseed SMA, ATR = RMA Wilder (TR candle pertama = high − low), RVOL
// dengan baseline candle SEBELUMNYA, swing fraktal dengan konfirmasi tertunda.
// Fixture sintetis — bukan data pasar nyata.
import { describe, expect, it } from 'vitest';
import { atr, ema, findSwings, normalizedSlope, percentChange, rvol, sma, spikeDominance, trailingHigherLows, trueRange } from '../../../backend/indicators/index.js';
import { analyzeStructure, computeFeatures, computeInvalidation } from '../../../backend/patterns/conditions.js';
import { detectProgressiveVolume } from '../../../backend/patterns/progressiveVolume.js';
import { detectSilentAccumulation } from '../../../backend/patterns/silentAccumulation.js';
import { downtrendCandles, progressiveVolumeCandles, silentAccumulationCandles, zigzag } from '../../fixtures/candles/scenarios.js';
import { generateCandles, mulberry32 } from '../../fixtures/candles/synthetic.js';

// ---------- referensi independen ----------
const refSma = (v, n) => v.map((_, i) => (i < n - 1 ? null : v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n));
function refEma(v, n) {
  const k = 2 / (n + 1);
  const out = v.map(() => null);
  for (let i = n - 1; i < v.length; i += 1) out[i] = i === n - 1 ? refSma(v, n)[i] : v[i] * k + out[i - 1] * (1 - k);
  return out;
}
const refTr = (c) => c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
function refAtr(c, n) {
  const tr = refTr(c);
  const out = c.map(() => null);
  for (let i = n - 1; i < c.length; i += 1) out[i] = i === n - 1 ? tr.slice(0, n).reduce((a, b) => a + b, 0) / n : (out[i - 1] * (n - 1) + tr[i]) / n;
  return out;
}
const refRvol = (v, n) => v.map((x, i) => {
  if (i < n) return null;
  const base = v.slice(i - n, i).reduce((a, b) => a + b, 0) / n;
  return base > 0 ? x / base : null;
});

const randomCandles = (seed, n) => {
  const r = mulberry32(seed);
  let p = 100;
  return Array.from({ length: n }, () => {
    const open = p;
    const close = open * (1 + (r() - 0.5) * 0.04);
    const high = Math.max(open, close) * (1 + r() * 0.01);
    const low = Math.min(open, close) * (1 - r() * 0.01);
    p = close;
    return { open, high, low, close, volume: 100 + r() * 900 };
  });
};

const closeTo = (a, b) => a.forEach((v, i) => (b[i] === null ? expect(v).toBeNull() : expect(v).toBeCloseTo(b[i], 10)));

// Candle minimal dengan OHLC eksplisit (fixture sintetis — bukan data pasar nyata).
const bar = (i, { open, high, low, close }) => ({
  symbol: 'SYNUSDT', timeframe: '5m', openTime: i * 300_000, closeTime: i * 300_000 + 299_999,
  open, high, low, close, volume: 100, quoteVolume: 1000, isClosed: true,
});
const fromLows = (lows) => lows.map((low, i) => bar(i, { open: low + 0.5, high: low + 1, low, close: low + 0.5 }));

describe('AUDIT indikator vs referensi standar', () => {
  it('AUDIT-IND-001 EMA diseed SMA, alpha 2/(n+1); contoh tangan [1..10] periode 3 → ema[i] = i', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(ema(v, 3)).toEqual([null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
    const closes = randomCandles(7, 120).map((c) => c.close);
    closeTo(ema(closes, 7), refEma(closes, 7));
    closeTo(ema(closes, 25), refEma(closes, 25));
  });

  it('AUDIT-IND-002 SMA = rata-rata n nilai terakhir termasuk nilai saat ini', () => {
    expect(sma([2, 4, 6, 8], 2)).toEqual([null, 3, 5, 7]);
    const closes = randomCandles(3, 80).map((c) => c.close);
    closeTo(sma(closes, 20), refSma(closes, 20));
  });

  it('AUDIT-IND-003 TR memakai close SEBELUMNYA (gap); ATR = RMA Wilder diseed rata-rata TR', () => {
    const c = [
      { high: 10, low: 8, close: 9 }, // TR 2 (candle pertama: high − low)
      { high: 12, low: 11, close: 11.5 }, // gap naik: |12 − 9| = 3
      { high: 11, low: 10, close: 10 }, // |10 − 11,5| = 1,5
      { high: 10.5, low: 9.5, close: 10 }, // 1
    ];
    expect(trueRange(c)).toEqual([2, 3, 1.5, 1]);
    // seed (2 + 3 + 1,5) / 3 = 2,1667; lalu (2,1667 × 2 + 1) / 3 = 1,7778
    const a = atr(c, 3);
    expect(a[1]).toBeNull();
    expect(a[2]).toBeCloseTo(6.5 / 3, 12);
    expect(a[3]).toBeCloseTo((6.5 / 3 * 2 + 1) / 3, 12);
    const rc = randomCandles(11, 200);
    closeTo(atr(rc, 14), refAtr(rc, 14));
  });

  it('AUDIT-IND-004 RVOL TIDAK memasukkan candle saat ini ke baseline', () => {
    // baseline candle ke-4 = rata-rata [1,1,1,1] = 1 → RVOL 10 (bila ikut dihitung: 10 / 3,25)
    expect(rvol([1, 1, 1, 1, 10], 4)).toEqual([null, null, null, null, 10]);
    expect(rvol([0, 0, 0, 5], 3)[3]).toBeNull();
    const vols = randomCandles(5, 150).map((c) => c.volume);
    closeTo(rvol(vols, 50), refRvol(vols, 50));
  });

  it('AUDIT-IND-005 spikeDominance = maks / total jendela terakhir', () => {
    expect(spikeDominance([100, 1, 1, 1, 1], 4)).toBe(0.25);
    expect(spikeDominance([1, 1, 1, 7], 4)).toBe(0.7);
    expect(spikeDominance([1, 2], 3)).toBeNull();
  });

  it('AUDIT-IND-006 swing fraktal 2-2: confirmedIndex = index + 2, tidak repaint, swing tidak muncul sebelum 2 candle kanan ada', () => {
    const c = fromLows([10, 9, 8, 9, 10, 9.5, 8.5, 9.5, 10.5]);
    expect(findSwings(c).lows).toEqual([{ index: 2, price: 8, confirmedIndex: 4 }, { index: 6, price: 8.5, confirmedIndex: 8 }]);
    // baru 1 candle kanan setelah indeks 6 → swing indeks 6 belum ada sama sekali
    expect(findSwings(c.slice(0, 8)).lows.map((s) => s.index)).toEqual([2]);
    // swing terkonfirmasi tidak berubah saat data bertambah (tanpa repaint)
    const rc = randomCandles(21, 120);
    const full = findSwings(rc);
    for (const cut of [40, 77, 100]) {
      const part = findSwings(rc.slice(0, cut));
      expect(full.lows.filter((s) => s.confirmedIndex < cut)).toEqual(part.lows);
      expect(full.highs.filter((s) => s.confirmedIndex < cut)).toEqual(part.highs);
    }
  });

  it('AUDIT-IND-007 low datar (double bottom) dihitung sekali pada kemunculan pertama', () => {
    const c = fromLows([10, 9, 8, 8, 9, 10, 11]);
    expect(findSwings(c).lows.map((s) => s.index)).toEqual([2]);
  });

  it('AUDIT-IND-008 trailingHigherLows menghitung higher low ketat berurutan dari akhir', () => {
    const L = (...p) => p.map((price) => ({ price }));
    expect(trailingHigherLows(L(5, 6, 7))).toBe(2);
    expect(trailingHigherLows(L(7, 5, 6))).toBe(1);
    expect(trailingHigherLows(L(5, 6, 6))).toBe(0);
    expect(trailingHigherLows(L(5))).toBe(0);
  });

  it('AUDIT-IND-009 normalizedSlope = slope OLS / |rata-rata|; tanda benar untuk deret turun', () => {
    expect(normalizedSlope([100, 101, 102, 103, 104], 5)[4]).toBeCloseTo(1 / 102, 12);
    expect(normalizedSlope([104, 103, 102, 101, 100], 5)[4]).toBeCloseTo(-1 / 102, 12);
    expect(normalizedSlope([null, 1, 2], 2)).toEqual([null, null, 1 / 1.5]);
  });

  it('AUDIT-IND-010 percentChange(k) dibanding close k candle lalu', () => {
    expect(percentChange([100, 110, 121], 2)).toEqual([null, null, 0.21]);
    expect(percentChange([0, 1], 1)).toEqual([null, null]);
  });
});

describe('AUDIT detektor LONG (SA/PVA)', () => {
  it('AUDIT-PAT-001 deret turun monoton (lower low, close turun) tidak pernah terdeteksi SA/PVA', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const falling = generateCandles({ seed, segments: [{ bars: 60, cycle: zigzag(3, 0.002, 3, 0.002) }, { bars: 40, drift: -0.002, volume: 700, volumeEnd: 1500 }] });
      expect(detectSilentAccumulation(falling).detected).toBe(false);
      expect(detectProgressiveVolume(falling).detected).toBe(false);
      expect(detectSilentAccumulation(downtrendCandles(seed)).detected).toBe(false);
      expect(detectProgressiveVolume(downtrendCandles(seed)).detected).toBe(false);
    }
  });

  it('AUDIT-PAT-002 deret naik pelan dengan higher low & volume senyap terdeteksi SA; invalidasi di bawah close', () => {
    const c = silentAccumulationCandles(1);
    const r = detectSilentAccumulation(c);
    expect(r.detected).toBe(true);
    expect(r.invalidationPrice).toBeLessThan(c.at(-1).close);
    expect(r.earlyScore).toBeGreaterThan(0);
  });

  it('AUDIT-PAT-003 nilai kondisi SA cocok dengan perhitungan tangan (jendela priceLookback = 20)', () => {
    const c = silentAccumulationCandles(2);
    const r = detectSilentAccumulation(c);
    const val = (id) => r.conditions.find((x) => x.id === id).value;
    const last = c.length - 1;
    // perubahan harga: close terakhir vs close 20 candle sebelumnya (close sebelum jendela 20 candle)
    expect(val('priceRising')).toBeCloseTo(c[last].close / c[last - 20].close - 1, 12);
    // RVOL rata-rata 5 candle terakhir, baseline 50 candle sebelum masing-masing
    const rv = refRvol(c.map((x) => x.volume), 50).slice(-5);
    expect(val('rvolLow')).toBeCloseTo(rv.reduce((a, b) => a + b, 0) / 5, 12);
    expect(val('liquidity')).toBeCloseTo(c.slice(-20).reduce((a, x) => a + x.quoteVolume, 0) / 20, 6);
  });

  it('AUDIT-PAT-004 PVA: sub-jendela selaras (start = last − 20 + 1), baseline harga closes[start − 1], median sub-jendela terakhir', () => {
    const c = progressiveVolumeCandles(1);
    const r = detectProgressiveVolume(c);
    const val = (id) => r.conditions.find((x) => x.id === id).value;
    const last = c.length - 1;
    const start = last - 20 + 1;
    const vols = c.map((x) => x.volume);
    const sub = (j) => vols.slice(start + j * 5, start + (j + 1) * 5);
    const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(val('volumeGrowth')).toBeCloseTo(avg(sub(3)) / avg(sub(0)), 12);
    const sorted = [...sub(3)].sort((a, b) => a - b);
    expect(val('volumeGrowthBroad')).toBeCloseTo(sorted[2] / avg(sub(0)), 12);
    expect(val('priceRising')).toBeCloseTo(c[last].close / c[start - 1].close - 1, 12);
    let maxMove = 0;
    for (let i = start; i <= last; i += 1) maxMove = Math.max(maxMove, c[i].close - c[i - 1].close);
    expect(val('riseNotSingleCandle')).toBeCloseTo(maxMove / (c[last].close - c[start - 1].close), 12);
    const priorRv = refRvol(vols, 50).slice(start, start + 5);
    expect(val('priorQuiet')).toBeCloseTo(avg(priorRv), 12);
    expect(val('noSpikeDominance')).toBeCloseTo(Math.max(...vols.slice(start)) / vols.slice(start).reduce((a, b) => a + b, 0), 12);
  });

  it('AUDIT-PAT-005 struktur memakai swing low terkonfirmasi saja; awal rantai boleh di luar jendela', () => {
    const c = fromLows([10, 9, 8, 9, 10, 9.5, 8.5, 9.5, 10.5, 10, 9, 10, 11, 11.5]);
    // jendela 5 candle: anchor (indeks 10) di jendela, awal rantai (indeks 2) di luar jendela
    expect(analyzeStructure(c, computeFeatures(c), 5)).toMatchObject({ fromSwing: true, higherLows: 2, anchorIndex: 10, startIndex: 2 });
  });

  it('AUDIT-PAT-006 BUG (diperbaiki): wick candle terakhir menembus swing low terbaru → struktur dianggap patah', () => {
    // swing low 8 (idx 2) → 8,5 (idx 6, terkonfirmasi idx 8). Candle terakhir (idx 9) wick ke 8,3
    // (lower low belum terkonfirmasi) tetapi close 9 > 8,5. Sebelum perbaikan: higherLows 1 &
    // invalidasi 8,5 − buffer padahal low 8,3 sudah menembusnya.
    const c = fromLows([10, 9, 8, 9, 10, 9.5, 8.5, 9.5, 10.5]);
    c.push(bar(9, { open: 9.5, high: 9.8, low: 8.3, close: 9 }));
    const f = computeFeatures(c);
    const s = analyzeStructure(c, f, 20);
    expect(s).toMatchObject({ fromSwing: false, higherLows: 0, anchorPrice: 8 });
    // low tepat sama dengan swing low (double bottom) TIDAK mematahkan struktur
    const eq = fromLows([10, 9, 8, 9, 10, 9.5, 8.5, 9.5, 10.5]);
    eq.push(bar(9, { open: 9.5, high: 9.8, low: 8.5, close: 9 }));
    expect(analyzeStructure(eq, computeFeatures(eq), 20)).toMatchObject({ fromSwing: true, higherLows: 1, anchorPrice: 8.5 });
  });

  it('AUDIT-PAT-007 sinyal terdeteksi tidak pernah punya level invalidasi yang sudah ditembus low sesudah anchor', () => {
    const sideways = { bars: 48, cycle: zigzag(3, 0.002, 3, 0.002), volume: 1000, volumeNoise: 0.15 };
    // seed 86/231/322/350 + 32 candle naik = kasus nyata yang dulu lolos dengan invalidasi tertembus
    let detected = 0;
    for (const seed of [86, 231, 322, 350, 1, 2, 3, 4, 5]) {
      for (const up of [28, 30, 32]) {
        const c = generateCandles({ seed, segments: [sideways, { bars: up, cycle: zigzag(5, 0.0015, 3, 0.0015), wick: 0.004, volume: 450, volumeNoise: 0.1 }] });
        for (const r of [detectSilentAccumulation(c), detectProgressiveVolume(c)]) {
          if (!r.detected) continue;
          detected += 1;
          const s = analyzeStructure(c, computeFeatures(c), 20);
          const minLowAfter = Math.min(...c.slice(s.anchorIndex + 1).map((x) => x.low));
          expect(r.invalidationPrice).toBeLessThan(minLowAfter);
          expect(r.invalidationPrice).toBeLessThan(c.at(-1).close);
        }
      }
    }
    expect(detected).toBeGreaterThan(0);
  });

  it('AUDIT-PAT-008 invalidasi selalu < close (anchor fallback = low terendah jendela)', () => {
    const c = fromLows([10, 9, 8, 9, 10, 9.5, 8.5, 9.5, 10.5, 7]);
    const f = computeFeatures(c);
    const s = analyzeStructure(c, f, 20);
    expect(computeInvalidation(s, { ...f, atr: 0.5 }, 0.25)).toBeLessThan(f.close);
  });

  it('AUDIT-PAT-009 (diperbaiki v3) SA TIDAK terdeteksi saat EMA25 masih turun (pantulan setelah penurunan)', () => {
    // v2: ema25NotFalling opsional (bobot 10) → wajib 75 + atrNotExpanding 5 + notExtended 5 = 85 = minScore, sehingga
    // pantulan 20 candle setelah turun 20 candle terdeteksi LONG padahal EMA25 turun. v3: kondisi ini wajib.
    const c = generateCandles({ seed: 1, segments: [
      { bars: 48, cycle: zigzag(3, 0.002, 3, 0.002), volume: 1000, volumeNoise: 0.15 },
      { bars: 20, drift: -0.003, cycle: zigzag(3, 0.001, 3, 0.001), volume: 1000 },
      { bars: 20, cycle: zigzag(5, 0.0015, 3, 0.0015), wick: 0.002, volume: 450, volumeNoise: 0.1 },
    ] });
    const r = detectSilentAccumulation(c);
    const ema25 = r.conditions.find((x) => x.id === 'ema25NotFalling');
    expect(ema25.passed).toBe(false);
    expect(ema25.value).toBeLessThan(0);
    expect(r.patternScore).toBeGreaterThanOrEqual(85); // skor tetap tinggi — yang menolak adalah kondisi wajib
    expect(r.detected).toBe(false);
  });
});
