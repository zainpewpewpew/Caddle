// Audit pola SHORT (cermin SA/PVA → SD/PVD) dan state machine sinyal kedua arah.
// Data uji deterministik — sintetis, bukan data pasar nyata. Tes yang lulus pada perilaku benar berfungsi
// sebagai PIN (mencegah regresi); tes "AUD-SSM-STALE-*" mereproduksi bug level breakout/breakdown basi yang
// diperbaiki di deriveDirectionalMarketInputs (runningLevel).
import { describe, expect, it } from 'vitest';
import { ema } from '../../../backend/indicators/index.js';
import { computeFeatures } from '../../../backend/patterns/conditions.js';
import {
  PVD_CONDITIONS, SD_CONDITIONS, evaluatePatterns, evaluateShortPatterns, mirrorCandles, realChangeOf,
} from '../../../backend/patterns/index.js';
import { deriveDirectionalMarketInputs, transition } from '../../../backend/signals/index.js';
import {
  bothPatternsCandles, downtrendCandles, extremeVolatilityCandles, progressiveVolumeCandles, silentAccumulationCandles,
} from '../../fixtures/candles/scenarios.js';

const SHORT_OF = { SA: 'SD', PVA: 'PVD', BOTH: 'BOTH', NONE: 'NONE' };
const FIXTURES = [
  ['SA', silentAccumulationCandles],
  ['PVA', progressiveVolumeCandles],
  ['BOTH', bothPatternsCandles],
];

describe('cermin SA/PVA → SD/PVD', () => {
  for (const [name, make] of FIXTURES) {
    for (const seed of [1, 2, 3]) {
      it(`AUD-MIR-001 ${name} seed ${seed}: invers harga eksak terdeteksi SD/PVD dengan skor identik`, () => {
        const long = make(seed);
        const L = evaluatePatterns(long);
        expect(L.classification).toBe(name); // fixture LONG memang terdeteksi
        // Seri SHORT nyata = invers harga eksak (p → 1/p, high ↔ low; volume & waktu sama).
        const real = mirrorCandles(long);
        const S = evaluateShortPatterns(real);
        expect(S.classification).toBe(SHORT_OF[L.classification]);
        for (const [lk, sk] of [['sa', 'sd'], ['pva', 'pvd']]) {
          const a = L[lk];
          const b = S[sk];
          expect(b.detected).toBe(a.detected);
          expect(b.patternScore).toBe(a.patternScore);
          expect(b.earlyScore).toBe(a.earlyScore);
          expect(b.riskFlags).toEqual(a.riskFlags);
          expect(b.conditions.map((c) => c.passed)).toEqual(a.conditions.map((c) => c.passed));
          // Invalidasi SHORT = 1 / level cermin, DI ATAS close nyata.
          expect(b.invalidationPrice).toBeCloseTo(1 / a.invalidationPrice, 12);
          expect(b.invalidationPrice).toBeGreaterThan(real.at(-1).close);
        }
      });
    }
  }

  it('AUD-MIR-002 konversi nilai & ambang kondisi ke harga nyata (realChangeOf, negasi slope, pembanding)', () => {
    const long = silentAccumulationCandles(1);
    const real = mirrorCandles(long);
    const { sd } = evaluateShortPatterns(real);
    const byId = Object.fromEntries(sd.conditions.map((c) => [c.id, c]));
    // Perubahan harga nyata 20 candle (priceLookback) — dihitung langsung dari harga nyata.
    const closes = real.map((c) => c.close);
    const realChange = closes.at(-1) / closes.at(-21) - 1;
    expect(byId.priceFalling.value).toBeCloseTo(realChange, 12);
    expect(byId.priceFalling.value).toBeLessThan(0);
    expect(byId.priceFalling.threshold).toBe(0);
    expect(byId.priceGradual.threshold).toBeCloseTo(1 / 1.05 - 1, 12); // maxPriceChange 5% cermin ≈ −4,76% nyata
    expect(byId.priceGradual.value).toBeGreaterThanOrEqual(byId.priceGradual.threshold);
    expect(byId.ema7Falling.value).toBeLessThan(0);
    expect(byId.ema25NotRising.threshold).toBeCloseTo(0.0002, 12);
    expect(realChangeOf(0.05)).toBeCloseTo(-0.047619, 6);
    expect(realChangeOf(-1)).toBeNull();
    const cmp = Object.fromEntries(SD_CONDITIONS.map((c) => [c.id, c.comparator]));
    expect(cmp).toMatchObject({ priceFalling: 'lt', priceGradual: 'gte', ema7Falling: 'lt', ema25NotRising: 'lte', lowerHighs: 'gte' });
    const pvdCmp = Object.fromEntries(PVD_CONDITIONS.map((c) => [c.id, c.comparator]));
    expect(pvdCmp).toMatchObject({ priceFalling: 'lt', dropNotSingleCandle: 'lte', ema7Falling: 'lt', lowerHighs: 'gte' });
    // Konsistensi status lulus dengan pembanding nyata untuk setiap kondisi yang dikonversi.
    const ops = { lt: (v, t) => v < t, lte: (v, t) => v <= t, gte: (v, t) => v >= t, gt: (v, t) => v > t };
    for (const meta of SD_CONDITIONS) {
      const c = byId[meta.id];
      if (c.value !== null && c.threshold !== null) expect(ops[meta.comparator](c.value, c.threshold)).toBe(c.passed);
    }
  });

  it('AUD-MIR-003 seri naik tidak pernah SD/PVD; seri turun tidak pernah SA/PVA', () => {
    for (const [, make] of FIXTURES) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const rising = make(seed);
        expect(evaluateShortPatterns(rising).classification).toBe('NONE');
        expect(evaluatePatterns(mirrorCandles(rising)).classification).toBe('NONE');
      }
    }
    for (const seed of [1, 2, 3]) expect(evaluatePatterns(downtrendCandles(seed)).classification).toBe('NONE');
  });

  it('AUD-MIR-004 ATR% cermin ≈ ATR% nyata (maxAtrPercent bermakna sama), juga pada volatilitas ekstrem', () => {
    for (const candles of [silentAccumulationCandles(1), extremeVolatilityCandles(1), downtrendCandles(1)]) {
      const realAtr = computeFeatures(candles).atrPercent;
      const mirAtr = computeFeatures(mirrorCandles(candles)).atrPercent;
      expect(Math.abs(mirAtr / realAtr - 1)).toBeLessThan(0.06);
    }
    // Ambang maxAtrPercent di bawah ATR% nyata → kondisi wajib gagal & flag volatilitas (tidak "lolos" karena skala 1/p).
    const real = mirrorCandles(silentAccumulationCandles(1));
    const atrPct = computeFeatures(real).atrPercent;
    const { sd } = evaluateShortPatterns(real, { sd: { maxAtrPercent: atrPct * 0.9 } });
    expect(sd.conditions.find((c) => c.id === 'atrPercentLow').passed).toBe(false);
    expect(sd.detected).toBe(false);
    expect(sd.riskFlags).toContain('EXCESSIVE_VOLATILITY');
  });

  it('AUD-MIR-005 EXTENDED_PRICE pada SHORT = harga nyata jauh DI BAWAH EMA25', () => {
    const real = mirrorCandles(progressiveVolumeCandles(1));
    const { sd } = evaluateShortPatterns(real);
    expect(sd.riskFlags).toContain('EXTENDED_PRICE');
    const closes = real.map((c) => c.close);
    expect(closes.at(-1)).toBeLessThan(ema(closes, 25).at(-1));
  });
});

// ── State machine ──────────────────────────────────────────────────────────────────────────────
const T0 = Date.UTC(2026, 0, 5, 10, 0);
const MS = 5 * 60_000;

function bar(i, close, o = {}) {
  return {
    symbol: 'BTCUSDT', timeframe: '5m', openTime: T0 + i * MS, closeTime: T0 + (i + 1) * MS - 1,
    open: close, high: close + 0.2, low: close - 0.2, close, volume: 100, quoteVolume: 100 * close,
    isClosed: true, source: 'ws', ...o,
  };
}

const res = (pattern, o = {}) => ({
  pattern, version: 1, detected: true, patternScore: 90, earlyScore: 80, conditions: [],
  invalidationPrice: null, evaluatedAt: 0, riskFlags: [], insufficientData: false, ...o,
});
const off = (pattern) => res(pattern, { detected: false, patternScore: 10, earlyScore: 0 });

/**
 * Konfigurasi per arah: s = tanda pergerakan searah sinyal (LONG +1, SHORT −1), harga dasar 100, invalidasi 5 poin
 * berlawanan arah, level tembus 4 poin searah.
 */
const DIRS = {
  LONG: {
    s: 1, early: 'EARLY_BULLISH', brk: 'BREAKOUT', levelKey: 'resistance', invReason: 'CLOSE_BELOW_INVALIDATION',
    patterns: (det, o = {}) => ({ classification: det ? 'SA' : 'NONE', sa: det ? res('SA', o) : off('SA'), pva: off('PVA') }),
  },
  SHORT: {
    s: -1, early: 'EARLY_BEARISH', brk: 'BREAKDOWN', levelKey: 'support', invReason: 'CLOSE_ABOVE_INVALIDATION',
    patterns: (det, o = {}) => ({ direction: 'SHORT', classification: det ? 'SD' : 'NONE', sd: det ? res('SD', o) : off('SD'), pvd: off('PVD') }),
  },
};

function step(d, i, close, { det = true, pat = {}, market = {}, view, candle } = {}) {
  return {
    candle: bar(i, close, candle),
    patterns: d.patterns(det, { invalidationPrice: 100 - d.s * 5, ...pat }),
    context: { alignment: 'PARTIALLY_CONFIRMED' },
    market: { atr: 1, rvol: 1, [d.levelKey]: 100 + d.s * 4, ...market },
    ...(view ? { view } : {}),
  };
}

function run(steps, params) {
  let snap = null;
  const out = [];
  for (const st of steps) {
    const r = transition(snap, st, params);
    out.push(r);
    snap = r.next;
  }
  return { snap, out, events: out.map((r) => r.event).filter(Boolean), alerts: out.filter((r) => r.alert).map((r) => r.next.state) };
}

describe.each(Object.keys(DIRS))('state machine %s', (dir) => {
  const d = DIRS[dir];
  const px = (k) => 100 + d.s * k; // k poin searah sinyal

  it('AUD-SSM-001 buka EARLY → MOMENTUM (≥ 1 ATR searah) → tembus level dengan RVOL', () => {
    const r = run([
      step(d, 0, px(0)),
      step(d, 1, px(1.2)),
      step(d, 2, px(3.5), { market: { rvol: 3 } }), // RVOL tinggi tetapi belum tembus level 4
      step(d, 3, px(4.5), { market: { rvol: 2.5 } }),
    ]);
    expect(r.events.map((e) => e.toState)).toEqual([d.early, 'MOMENTUM_BUILDING', d.brk]);
    expect(r.alerts).toEqual([d.early, 'MOMENTUM_BUILDING', d.brk]);
    expect(r.snap.direction).toBe(dir);
  });

  it('AUD-SSM-002 tembus level berlawanan arah sinyal tidak pernah BREAKOUT/BREAKDOWN', () => {
    // Harga bergerak BERLAWANAN arah dengan RVOL besar; level di sisi berlawanan juga (level basi).
    const r = run([step(d, 0, px(0)), step(d, 1, px(-2), { market: { rvol: 6, [d.levelKey]: px(-4) } })]);
    expect(r.snap.state).toBe(d.early);
  });

  it('AUD-SSM-003 INVALIDATED hanya di sisi yang benar (LONG close < inv, SHORT close > inv)', () => {
    expect(run([step(d, 0, px(0)), step(d, 1, px(-5))]).snap.state).toBe(d.early); // tepat di level: belum
    const r = run([step(d, 0, px(0)), step(d, 1, px(-5.1))]);
    expect(r.snap.state).toBe('INVALIDATED');
    expect(r.events.at(-1).reason).toBe(d.invReason);
    expect(r.alerts).toEqual([d.early, 'INVALIDATED']);
    // Bergerak jauh searah sinyal tidak meng-invalidasi.
    expect(run([step(d, 0, px(0)), step(d, 1, px(20))]).snap.state).not.toBe('INVALIDATED');
    // Pola yang sudah melewati invalidasinya sendiri tidak membuka sinyal.
    expect(run([step(d, 0, px(-6))]).snap.state).toBe('NO_PATTERN');
  });

  it('AUD-SSM-004 EXPIRED setelah expiryBars tanpa kemajuan; candle duplikat idempoten', () => {
    const steps = [step(d, 0, px(0), { pat: { earlyScore: 10 } })];
    for (let i = 1; i <= 48; i += 1) steps.push(step(d, i, px(0.1), { pat: { earlyScore: 10 } }));
    const r = run(steps);
    expect(r.events.map((e) => e.toState)).toEqual(['QUIET', 'EXPIRED']);
    expect(r.out[47].next.state).toBe('QUIET');
    const opened = transition(null, step(d, 0, px(0)));
    const dup = transition(opened.next, step(d, 0, px(4.5), { market: { rvol: 9 } }));
    expect(dup).toEqual({ next: opened.next, event: null, alert: false });
  });

  it('AUD-SSM-005 gap melewati expiry → EXPIRED tanpa promosi/alert dari harga basi', () => {
    const r = run([step(d, 0, px(0)), step(d, 60, px(9), { market: { rvol: 9 } })]);
    expect(r.snap.state).toBe('EXPIRED');
    expect(r.out[1].alert).toBe(false);
    expect(r.events.at(-1).detail.gapBars).toBe(59);
  });

  it('AUD-SSM-006 gerbang tier < B menahan QUIET (tanpa momentum/tembus), invalidasi tetap berlaku', () => {
    const v = (tier) => ({ patternScore: 90, earlyScore: 80, riskFlags: [], confluence: { score: 40, tier, calibration: null } });
    const held = run([step(d, 0, px(0), { view: v('C') }), step(d, 1, px(6), { view: v('C'), market: { rvol: 9 } })]);
    expect(held.snap.state).toBe('QUIET');
    expect(held.alerts).toEqual([]);
    const inv = run([step(d, 0, px(0), { view: v('C') }), step(d, 1, px(-6), { view: v('C') })]);
    expect(inv.snap.state).toBe('INVALIDATED');
    expect(inv.out[1].alert).toBe(false); // QUIET bukan state alert
    expect(run([step(d, 0, px(0), { view: v('B') })]).snap.state).toBe(d.early);
  });

  it('AUD-SSM-007 invalidasi hanya diperketat searah sinyal; peakPrice = ekskursi searah', () => {
    const r = run([
      step(d, 0, px(0)),
      step(d, 1, px(0.5), { pat: { invalidationPrice: px(-3) } }), // lebih ketat → dipakai
      step(d, 2, px(0.5), { pat: { invalidationPrice: px(-4) } }), // lebih longgar → diabaikan
      step(d, 3, px(0.5), { pat: { invalidationPrice: px(1) } }), // di sisi salah close → diabaikan
      step(d, 4, px(0.5), { pat: { invalidationPrice: px(-2), detected: false } }), // pola tidak terdeteksi → diabaikan
    ]);
    expect(r.snap.invalidationPrice).toBe(px(-3));
    // LONG: high tertinggi (100.5 + 0.2); SHORT: low terendah (99.5 − 0.2).
    expect(r.snap.peakPrice).toBeCloseTo(px(0.7), 9);
  });
});

// ── Level breakout/breakdown basi (bug, diperbaiki) ────────────────────────────────────────────
/**
 * Seri LONG nyata: 20 candle sideways bervolume 100, swing high 100.7 (indeks 20, terkonfirmasi di 22), sinyal dibuka
 * di indeks 22 (close 100), reli tanpa volume ke 104 (indeks 23–26, tanpa pullback → tidak ada swing high baru),
 * lalu candle MERAH ber-RVOL ≈ 4 (indeks 27: 104 → 101.5), lalu candle hijau ber-RVOL ≈ 4 yang membuat close
 * tertinggi baru (indeks 28: 104.5).
 */
function staleLevelSeries() {
  const cs = [];
  for (let i = 0; i < 20; i += 1) cs.push(bar(i, i % 2 ? 100.1 : 99.9));
  cs.push(bar(20, 100.5));
  cs.push(bar(21, 100));
  cs.push(bar(22, 100));
  [101, 102, 103, 104].forEach((c, k) => cs.push(bar(23 + k, c, { open: c - 1, low: c - 1.1 })));
  cs.push(bar(27, 101.5, { open: 104, high: 104.1, low: 101.3, volume: 400 }));
  cs.push(bar(28, 104.5, { open: 101.5, high: 104.6, low: 101.4, volume: 400 }));
  return cs;
}

function replay(candles, dir, from) {
  const d = DIRS[dir];
  let snap = null;
  const out = [];
  for (let i = from; i < candles.length; i += 1) {
    const c = candles[i];
    const inv = dir === 'LONG' ? 98 : 1 / 98;
    const r = transition(snap, {
      candle: c,
      patterns: d.patterns(true, { invalidationPrice: inv }),
      context: { alignment: null },
      market: deriveDirectionalMarketInputs(candles.slice(0, i + 1))[dir],
    });
    out.push({ i, ...r });
    snap = r.next;
  }
  return out;
}

describe('level tembus basi', () => {
  it('AUD-SSM-STALE-001 LONG: candle merah ber-RVOL tinggi setelah reli tanpa volume BUKAN BREAKOUT', () => {
    const cs = staleLevelSeries();
    // Swing high terkonfirmasi terakhir (100.7) sudah jauh di bawah harga: level basi.
    const m = deriveDirectionalMarketInputs(cs.slice(0, 28)).LONG;
    expect(m.rvol).toBeGreaterThanOrEqual(2);
    const out = replay(cs, 'LONG', 22);
    const red = out.find((o) => o.i === 27);
    expect(cs[27].close).toBeLessThan(cs[27].open);
    expect(red.next.state).not.toBe('BREAKOUT'); // sebelum perbaikan: BREAKOUT_CONFIRMED di candle merah ini
    expect(m.resistance).toBeCloseTo(104.2, 9); // level berjalan = high tertinggi sejak swing high 100.7 (dulu 100.7)
    const green = out.find((o) => o.i === 28);
    expect(green.event).toMatchObject({ toState: 'BREAKOUT', reason: 'BREAKOUT_CONFIRMED' });
    expect(green.event.detail.resistance).toBeCloseTo(104.2, 9);
  });

  it('AUD-SSM-STALE-002 SHORT (invers eksak): candle hijau memantul ber-RVOL tinggi BUKAN BREAKDOWN', () => {
    const cs = mirrorCandles(staleLevelSeries());
    const out = replay(cs, 'SHORT', 22);
    const bounce = out.find((o) => o.i === 27);
    expect(cs[27].close).toBeGreaterThan(cs[27].open); // harga NAIK di candle ini
    expect(bounce.next.state).not.toBe('BREAKDOWN'); // sebelum perbaikan: BREAKDOWN_CONFIRMED saat harga naik
    const drop = out.find((o) => o.i === 28);
    expect(drop.event).toMatchObject({ toState: 'BREAKDOWN', reason: 'BREAKDOWN_CONFIRMED' });
    expect(drop.event.detail.support).toBeCloseTo(1 / 104.2, 12);
    // Simetri penuh: urutan state SHORT pada seri invers = urutan state LONG pada seri asli.
    const long = replay(staleLevelSeries(), 'LONG', 22).map((o) => o.next.state.replace('BULLISH', 'X').replace('BREAKOUT', 'BRK'));
    expect(out.map((o) => o.next.state.replace('BEARISH', 'X').replace('BREAKDOWN', 'BRK'))).toEqual(long);
  });

  it('AUD-SSM-STALE-003 level swing yang belum ditembus tidak berubah', () => {
    const cs = staleLevelSeries().slice(0, 23); // hanya sampai candle pembukaan: belum ada yang melewati 100.7
    const m = deriveDirectionalMarketInputs(cs);
    expect(m.LONG.resistance).toBeCloseTo(100.7, 9);
    expect(m.SHORT.support).toBeNull(); // sideways bergantian tanpa swing low ketat
    // Invers eksak: support SHORT = 1 / resistance LONG.
    expect(deriveDirectionalMarketInputs(mirrorCandles(cs)).SHORT.support).toBeCloseTo(1 / 100.7, 12);
  });
});
