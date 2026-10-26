import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_PARAMS, deriveMarketInputs, resolveSignalParams, transition } from '../../../backend/signals/index.js';

// Data uji deterministik — sintetis, bukan data pasar nyata.
const T0 = Date.UTC(2026, 0, 5, 10, 0);
const MS = 5 * 60_000;

function candle(i, close, overrides = {}) {
  return {
    symbol: 'BTCUSDT', timeframe: '5m', openTime: T0 + i * MS, closeTime: T0 + (i + 1) * MS - 1,
    open: close, high: close + 0.2, low: close - 0.2, close, volume: 100, quoteVolume: 100 * close,
    trades: 10, takerBuyVolume: 50, takerBuyQuoteVolume: 50 * close, isClosed: true, source: 'ws', ...overrides,
  };
}

// PatternResult palsu sesuai kontrak docs/07 §6.
function result(pattern, overrides = {}) {
  return {
    pattern, version: 1, detected: true, patternScore: 70, earlyScore: 40, conditions: [],
    invalidationPrice: 95, evaluatedAt: 0, riskFlags: [], insufficientData: false, ...overrides,
  };
}
const notDetected = (pattern, o = {}) => result(pattern, { detected: false, patternScore: 20, earlyScore: 10, invalidationPrice: null, ...o });

function patterns(classification, { sa = {}, pva = {} } = {}) {
  const hasSa = classification === 'SA' || classification === 'BOTH';
  const hasPva = classification === 'PVA' || classification === 'BOTH';
  return {
    classification,
    sa: hasSa ? result('SA', sa) : notDetected('SA', sa),
    pva: hasPva ? result('PVA', pva) : notDetected('PVA', pva),
  };
}

function input(i, close, { cls = 'SA', sa, pva, alignment = 'PARTIALLY_CONFIRMED', market = {}, candle: co, view } = {}) {
  return {
    candle: candle(i, close, co),
    patterns: patterns(cls, { sa, pva }),
    context: { alignment },
    market: { atr: 1, rvol: 1, resistance: 104, ...market },
    ...(view ? { view } : {}),
  };
}

/** Menjalankan rangkaian input; mengembalikan snapshot akhir, event, dan alert per langkah. */
function run(steps, params, start = null) {
  let snap = start;
  const out = [];
  for (const step of steps) {
    const r = transition(snap, step, params);
    out.push(r);
    snap = r.next;
  }
  return { snap, out, events: out.map((r) => r.event).filter(Boolean), alerts: out.filter((r) => r.alert).map((r) => r.next.state) };
}

function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

describe('state machine sinyal', () => {
  it('UNIT-SSM-001 tanpa pola → NO_PATTERN tanpa event', () => {
    const r = transition(null, input(0, 100, { cls: 'NONE' }));
    expect(r.event).toBeNull();
    expect(r.alert).toBe(false);
    expect(r.next).toMatchObject({ state: 'NO_PATTERN', classification: 'NONE', firstDetectedAt: null, firstDetectedPrice: null, lastCandleTime: T0 });
  });

  it('POS-SSM-001 transisi lengkap QUIET → EARLY_BULLISH → MOMENTUM_BUILDING → BREAKOUT', () => {
    const { snap, out, events, alerts } = run([
      input(0, 100, { sa: { earlyScore: 40 } }), // terdeteksi, earlyScore rendah → QUIET
      input(1, 100.2, { sa: { earlyScore: 72 } }), // earlyScore ≥ 60 → EARLY_BULLISH
      input(2, 100.6, { sa: { earlyScore: 75 } }), // naik < 1 ATR → tetap
      input(3, 101.1, { sa: { earlyScore: 75 } }), // ≥ firstDetectedPrice + 1 × ATR → MOMENTUM_BUILDING
      input(4, 103.5, { market: { rvol: 3 } }), // RVOL tinggi tetapi belum tembus resistance 104 → tetap
      input(5, 104.6, { market: { rvol: 2.4 } }), // tembus resistance 104 + RVOL ≥ 2 → BREAKOUT
    ]);
    expect(events.map((e) => [e.fromState, e.toState, e.reason])).toEqual([
      ['NO_PATTERN', 'QUIET', 'PATTERN_DETECTED'],
      ['QUIET', 'EARLY_BULLISH', 'EARLY_SCORE_THRESHOLD'],
      ['EARLY_BULLISH', 'MOMENTUM_BUILDING', 'PRICE_ATR_ADVANCE'],
      ['MOMENTUM_BUILDING', 'BREAKOUT', 'BREAKOUT_CONFIRMED'],
    ]);
    expect(out.map((r) => r.event === null)).toEqual([false, false, true, false, true, false]);
    expect(alerts).toEqual(['EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT']);
    expect(snap).toMatchObject({
      state: 'BREAKOUT', classification: 'SA', patternKey: 'SA', patternVersion: 1,
      firstDetectedAt: T0 + MS - 1, firstDetectedPrice: 100, peakState: 'BREAKOUT', barsInState: 0,
      lastCandleTime: T0 + 5 * MS, lastEvaluatedAt: T0 + 6 * MS - 1,
    });
    expect(snap.peakPrice).toBeCloseTo(104.8, 9);
    expect(events[3]).toMatchObject({ candleTime: T0 + 5 * MS, occurredAt: T0 + 6 * MS - 1, price: 104.6 });
    expect(events[3].detail).toMatchObject({ rvol: 2.4, resistance: 104 });
  });

  it('POS-SSM-002 deteksi dengan earlyScore tinggi langsung EARLY_BULLISH (alert)', () => {
    const r = transition(null, input(0, 100, { sa: { earlyScore: 80 } }));
    expect(r.next.state).toBe('EARLY_BULLISH');
    expect(r.event).toMatchObject({ fromState: 'NO_PATTERN', toState: 'EARLY_BULLISH', reason: 'PATTERN_DETECTED_EARLY' });
    expect(r.alert).toBe(true);
  });

  it('UNIT-SSM-002 MOMENTUM_BUILDING juga dipicu ekspansi RVOL di atas harga deteksi', () => {
    const { snap, events } = run([input(0, 100, { sa: { earlyScore: 80 } }), input(1, 100.3, { market: { rvol: 1.6 } })]);
    expect(snap.state).toBe('MOMENTUM_BUILDING');
    expect(events[1].reason).toBe('RVOL_EXPANSION');
    // RVOL tinggi tetapi harga di bawah harga deteksi → bukan momentum.
    expect(run([input(0, 100, { sa: { earlyScore: 80 } }), input(1, 99.8, { market: { rvol: 3 } })]).snap.state).toBe('EARLY_BULLISH');
  });

  it('NEG-SSM-001 tembus resistance tanpa RVOL cukup bukan BREAKOUT', () => {
    const { snap, events } = run([input(0, 100, { sa: { earlyScore: 80 } }), input(1, 104.5, { market: { rvol: 1.2 } })]);
    expect(snap.state).toBe('MOMENTUM_BUILDING'); // naik 4,5 ATR → momentum, tetapi bukan breakout
    expect(events.map((e) => e.toState)).not.toContain('BREAKOUT');
  });

  it('EDGE-SSM-001 resistance basi di bawah harga deteksi tidak menghasilkan breakout palsu', () => {
    const r = run([input(0, 100, { sa: { earlyScore: 80 } }), input(1, 99.9, { market: { resistance: 98, rvol: 5 } })]);
    expect(r.snap.state).toBe('EARLY_BULLISH');
    // Tepat di level (close = resistance) belum tembus.
    expect(run([input(0, 100), input(1, 104, { market: { rvol: 5 } })]).snap.state).not.toBe('BREAKOUT');
  });

  it('UNIT-SSM-003 QUIET dapat langsung BREAKOUT bila syarat breakout terpenuhi', () => {
    const r = run([input(0, 100), input(1, 105, { market: { rvol: 2.5 } })]);
    expect(r.snap.state).toBe('BREAKOUT');
    expect(r.alerts).toEqual(['BREAKOUT']);
  });

  it('POS-SSM-003 pola gagal tanpa breakout → INVALIDATED; sinyal berikutnya dibuka baru', () => {
    const { snap, events, alerts, out } = run([
      input(0, 100, { sa: { earlyScore: 80 } }),
      input(1, 98),
      input(2, 94.9), // close < invalidationPrice 95
      input(3, 96, { sa: { invalidationPrice: 93, earlyScore: 30 } }), // deteksi berikutnya → sinyal baru
    ]);
    expect(events.map((e) => `${e.fromState}>${e.toState}`)).toEqual(['NO_PATTERN>EARLY_BULLISH', 'EARLY_BULLISH>INVALIDATED', 'NO_PATTERN>QUIET']);
    expect(events[1].reason).toBe('CLOSE_BELOW_INVALIDATION');
    expect(out[2].next).toMatchObject({ state: 'INVALIDATED', peakState: 'EARLY_BULLISH', invalidationPrice: 95 });
    // Invalidasi sinyal yang sudah pernah di-alert ikut di-alert (pengguna perlu tahu sinyal gagal).
    expect(alerts).toEqual(['EARLY_BULLISH', 'INVALIDATED']);
    expect(snap).toMatchObject({ state: 'QUIET', firstDetectedAt: T0 + 4 * MS - 1, firstDetectedPrice: 96, invalidationPrice: 93, peakState: 'QUIET' });
  });

  it('EDGE-SSM-002 close tepat di invalidationPrice belum invalidasi; QUIET invalidasi tanpa alert', () => {
    expect(run([input(0, 100), input(1, 95)]).snap.state).toBe('QUIET');
    const r = run([input(0, 100), input(1, 94.99)]);
    expect(r.snap.state).toBe('INVALIDATED');
    expect(r.alerts).toEqual([]);
  });

  it('EDGE-SSM-003 deteksi saat close sudah ≤ invalidationPrice tidak membuka sinyal', () => {
    const r = transition(null, input(0, 95, { sa: { invalidationPrice: 95 } }));
    expect(r.next.state).toBe('NO_PATTERN');
    expect(r.event).toBeNull();
  });

  it('UNIT-SSM-004 EXPIRED bila tidak ada kemajuan dalam N bar (per state)', () => {
    const params = { expiryBars: { QUIET: 3 } };
    const steps = [input(0, 100), input(1, 100.1), input(2, 100.2), input(3, 100.1)];
    const { out, events, alerts } = run(steps, params);
    expect(out.map((r) => r.next.state)).toEqual(['QUIET', 'QUIET', 'QUIET', 'EXPIRED']);
    expect(out.map((r) => r.next.barsInState)).toEqual([0, 1, 2, 0]);
    expect(events.at(-1)).toMatchObject({ fromState: 'QUIET', toState: 'EXPIRED', reason: 'NO_PROGRESS' });
    expect(alerts).toEqual([]);
    // Kemajuan (perpindahan state) mengatur ulang hitungan.
    const progressed = run([input(0, 100), input(1, 100, { sa: { earlyScore: 70 } }), input(2, 100), input(3, 100)], params);
    expect(progressed.snap).toMatchObject({ state: 'EARLY_BULLISH', barsInState: 2 });
  });

  it('UNIT-SSM-005 BREAKOUT berakhir EXPIRED setelah jendela pemantauan; peakState tetap BREAKOUT', () => {
    const steps = [input(0, 100), input(1, 105, { market: { rvol: 3 } }), input(2, 105.5), input(3, 105.2)];
    const { snap, events } = run(steps, { expiryBars: { BREAKOUT: 2 } });
    expect(snap).toMatchObject({ state: 'EXPIRED', peakState: 'BREAKOUT' });
    expect(events.at(-1).fromState).toBe('BREAKOUT');
  });

  it('UNIT-SSM-006 tidak ada alert berulang untuk state yang sama', () => {
    const steps = [input(0, 100, { sa: { earlyScore: 80 } })];
    for (let i = 1; i <= 20; i += 1) steps.push(input(i, 100 + (i % 3) * 0.1, { sa: { earlyScore: 80 } }));
    const { out, alerts, events } = run(steps);
    expect(alerts).toEqual(['EARLY_BULLISH']);
    expect(events).toHaveLength(1);
    expect(out.slice(1).every((r) => r.event === null && r.alert === false)).toBe(true);
    expect(out.at(-1).next.barsInState).toBe(20);
  });

  it('EDGE-SSM-004 candle duplikat / out-of-order diabaikan (idempoten)', () => {
    const a = transition(null, input(0, 100, { sa: { earlyScore: 80 } }));
    const b = transition(a.next, input(3, 100.4));
    for (const stale of [input(3, 90), input(2, 50), input(0, 100, { sa: { earlyScore: 80 } })]) {
      const r = transition(b.next, stale);
      expect(r).toEqual({ next: b.next, event: null, alert: false });
      expect(r.next).toBe(b.next);
    }
    // Juga setelah terminal: candle lama tidak membuka sinyal baru.
    const dead = transition(b.next, input(4, 90)).next;
    expect(dead.state).toBe('INVALIDATED');
    expect(transition(dead, input(4, 100, { sa: { earlyScore: 80 } })).event).toBeNull();
  });

  it('EDGE-SSM-005 gap candle dihitung berdasarkan waktu untuk expiry', () => {
    const { snap } = run([input(0, 100), input(6, 100.1)], { expiryBars: { QUIET: 6 } });
    expect(snap.state).toBe('EXPIRED');
    const kept = run([input(0, 100), input(5, 100.1)], { expiryBars: { QUIET: 6 } });
    expect(kept.snap).toMatchObject({ state: 'QUIET', barsInState: 5 });
  });

  it('EDGE-SSM-006 gap 200 bar setelah EARLY_BULLISH (expiry 36) lalu close +1,5 ATR → EXPIRED NO_PROGRESS tanpa alert, bukan MOMENTUM_BUILDING; jatuh tempo tepat di candle pasca-gap tetap boleh maju', () => {
    const opened = transition(null, input(0, 100, { sa: { earlyScore: 80 } }));
    expect(opened.next.state).toBe('EARLY_BULLISH');
    expect(DEFAULT_SIGNAL_PARAMS.expiryBars.EARLY_BULLISH).toBe(36);
    const after = transition(opened.next, input(200, 101.5, { market: { atr: 1, rvol: 3, resistance: 101 } }));
    expect(after.event).toMatchObject({ fromState: 'EARLY_BULLISH', toState: 'EXPIRED', reason: 'NO_PROGRESS',
      detail: { barsInPrevState: 200, gapBars: 199 } });
    expect(after.alert).toBe(false);
    expect(after.next).toMatchObject({ state: 'EXPIRED', peakState: 'EARLY_BULLISH' });
    // Kedaluwarsa lebih dulu daripada invalidasi pada candle pasca-gap.
    expect(transition(opened.next, input(200, 90)).event).toMatchObject({ toState: 'EXPIRED', reason: 'NO_PROGRESS' });
    // Batas expiry jatuh tepat di candle pasca-gap (36 bar) → candle ini masih dinilai; maju bila syarat terpenuhi.
    const onTime = transition(opened.next, input(36, 101.5));
    expect(onTime.event).toMatchObject({ toState: 'MOMENTUM_BUILDING', reason: 'PRICE_ATR_ADVANCE', detail: { gapBars: 35 } });
    expect(transition(opened.next, input(37, 101.5)).event).toMatchObject({ toState: 'EXPIRED', reason: 'NO_PROGRESS' });
    // Tanpa gap: tidak ada gapBars di detail.
    expect(transition(opened.next, input(1, 101.5)).event.detail).not.toHaveProperty('gapBars');
  });

  it('UNIT-SSM-007 invalidationPrice dibekukan saat deteksi: boleh naik, tidak boleh turun, tidak di atas close', () => {
    const steps = [
      input(0, 100),
      input(1, 100.5, { sa: { invalidationPrice: 97 } }), // naik → 97
      input(2, 100.5, { sa: { invalidationPrice: 96 } }), // turun → diabaikan
      input(3, 100.5, { sa: { invalidationPrice: 101 } }), // di atas close → diabaikan
      input(4, 100.5, { sa: { invalidationPrice: 98, detected: false } }), // pola tidak terdeteksi → diabaikan
      input(5, 100.5, { sa: { invalidationPrice: 98.5, version: 2 } }), // versi lain → diabaikan
    ];
    const { out } = run(steps);
    expect(out.map((r) => r.next.invalidationPrice)).toEqual([95, 97, 97, 97, 97, 97]);
  });

  it('UNIT-SSM-008 perubahan versi pola: sinyal lama tetap versi lama, sinyal baru memakai versi baru', () => {
    const { out } = run([
      input(0, 100, { sa: { earlyScore: 80 } }),
      input(1, 100.2, { sa: { earlyScore: 80, version: 2 } }),
      input(2, 94, { sa: { version: 2 } }),
      input(3, 96, { sa: { version: 2, invalidationPrice: 93 } }),
    ]);
    expect(out[1].next.patternVersion).toBe(1);
    expect(out[2].next).toMatchObject({ state: 'INVALIDATED', patternVersion: 1 });
    expect(out[3].next).toMatchObject({ state: 'QUIET', patternVersion: 2 });
  });

  it('POS-SSM-004 HTF hanya konteks: 5m tetap EARLY_BULLISH walau HTF netral/tidak tersedia/countertrend', () => {
    for (const alignment of ['UNCONFIRMED', 'PARTIALLY_CONFIRMED', 'COUNTERTREND', 'ALIGNED']) {
      const r = transition(null, input(0, 100, { alignment, sa: { earlyScore: 80 } }));
      expect(r.next).toMatchObject({ state: 'EARLY_BULLISH', alignment });
      expect(r.alert).toBe(true);
      expect(r.next.riskFlags.includes('COUNTERTREND_HTF')).toBe(alignment === 'COUNTERTREND');
    }
    // Alignment diperbarui tiap candle tanpa event.
    const r = run([input(0, 100, { alignment: 'ALIGNED' }), input(1, 100.1, { alignment: 'COUNTERTREND' })]);
    expect(r.snap).toMatchObject({ state: 'QUIET', alignment: 'COUNTERTREND' });
    expect(r.events).toHaveLength(1);
  });

  it('UNIT-SSM-009 BOTH: pola utama = skor tertinggi; klasifikasi digabung tanpa event', () => {
    const both = transition(null, input(0, 100, { cls: 'BOTH', sa: { patternScore: 60 }, pva: { patternScore: 85, invalidationPrice: 96 } }));
    expect(both.next).toMatchObject({ classification: 'BOTH', patternKey: 'PVA', invalidationPrice: 96, patternScore: 85 });
    const merged = run([input(0, 100, { cls: 'SA' }), input(1, 100.1, { cls: 'PVA' }), input(2, 100.1, { cls: 'NONE' })]);
    expect(merged.out.map((r) => r.next.classification)).toEqual(['SA', 'BOTH', 'BOTH']);
    expect(merged.snap.patternKey).toBe('SA');
    expect(merged.events).toHaveLength(1);
  });

  it('UNIT-SSM-010 skor & risk flag dari signal view bila diberikan', () => {
    const view = { patternScore: 55, earlyScore: 30, riskFlags: ['POOR_LIQUIDITY', 'WIDE_SPREAD'] };
    const r = transition(null, input(0, 100, { view }));
    expect(r.next).toMatchObject({ state: 'QUIET', patternScore: 55, earlyScore: 30, riskFlags: ['POOR_LIQUIDITY', 'WIDE_SPREAD'] });
  });

  it('UNIT-SSM-011 input & snapshot sebelumnya tidak dimutasi', () => {
    const first = transition(null, input(0, 100, { sa: { earlyScore: 80 } }));
    const prev = deepFreeze(structuredClone(first.next));
    const inp = deepFreeze(input(1, 101.5));
    expect(() => transition(prev, inp)).not.toThrow();
    expect(prev.state).toBe('EARLY_BULLISH');
  });

  it('NEG-SSM-002 input, snapshot, dan parameter tidak valid ditolak', () => {
    expect(() => transition(null, input(0, 100, { candle: { isClosed: false } }))).toThrow(/tertutup/);
    expect(() => transition(null, { ...input(0, 100), patterns: { classification: 'XYZ' } })).toThrow(RangeError);
    expect(() => transition(null, { ...input(0, 100), context: { alignment: 'SIDEWAYS' } })).toThrow(RangeError);
    expect(() => transition(null, input(0, Number.NaN))).toThrow(TypeError);
    expect(() => transition(null, input(0, 100, { sa: { version: 0 } }))).toThrow(/versi/);
    expect(() => transition({ state: 'LAUNCHED', lastCandleTime: 0 }, input(0, 100))).toThrow(RangeError);
    expect(() => transition(null, input(0, 100), { earlyMinScore: 150 })).toThrow(RangeError);
    expect(() => transition(null, input(0, 100), { expiryBars: { QUIET: 0 } })).toThrow(RangeError);
    expect(() => transition(null, input(0, 100), { expiryBars: { NO_PATTERN: 3 } })).toThrow(TypeError);
    expect(() => transition(null, input(0, 100), { breakoutRvl: 2 })).toThrow(TypeError);
    expect(() => transition(null, null)).toThrow(TypeError);
  });

  it('UNIT-SSM-012 parameter default tervalidasi dan beku', () => {
    const p = resolveSignalParams();
    expect(p).toEqual(DEFAULT_SIGNAL_PARAMS);
    expect(Object.isFrozen(p.expiryBars)).toBe(true);
    expect(resolveSignalParams({ expiryBars: { QUIET: 5 } }).expiryBars).toEqual({ ...DEFAULT_SIGNAL_PARAMS.expiryBars, QUIET: 5 });
  });
});

describe('deriveMarketInputs', () => {
  it('UNIT-SSM-013 ATR, RVOL, dan swing high terkonfirmasi terakhir (tanpa lookahead)', () => {
    const closes = [100, 101, 103, 101, 100, 101, 102, 104, 102, 101, 100, 101, 102, 101, 100, 100.5, 101, 101.5, 101, 100.5, 101, 102];
    const cs = closes.map((c, i) => candle(i, c, { volume: i === closes.length - 1 ? 300 : 100 }));
    const m = deriveMarketInputs(cs);
    expect(m.atr).toBeGreaterThan(0);
    expect(m.rvol).toBeCloseTo(3, 9);
    expect(m.resistance).toBeCloseTo(101.7, 9); // swing high 101.5 (+0.2) di indeks 17, terkonfirmasi di indeks 19
    // Swing high yang belum terkonfirmasi tidak dipakai.
    // Candle evaluasi (indeks 7, high 104.2) sendiri tidak ikut menggeser level.
    const early = deriveMarketInputs(cs.slice(0, 8));
    expect(early.resistance).toBeCloseTo(103.2, 9);
    // Indeks 8: swing high 104.2 (indeks 7) belum terkonfirmasi, tetapi harga sudah diperdagangkan di 104.2 sejak swing
    // 103.2 → level berjalan 104.2 (103.2 sudah ditembus, bukan resistance lagi).
    expect(deriveMarketInputs(cs.slice(0, 9)).resistance).toBeCloseTo(104.2, 9);
    expect(deriveMarketInputs(cs.slice(0, 3))).toEqual({ atr: null, rvol: null, resistance: null });
  });
});

describe('gerbang tier konfluensi v3', () => {
  const v = (tier, score, extra = {}) => ({ patternScore: 90, earlyScore: 80, riskFlags: [], confluence: { score, tier, calibration: null }, ...extra });

  it('UNIT-SSM-V3-001 tier < B: pola dengan earlyScore tinggi tetap QUIET tanpa alert, juga saat breakout; tier B naik normal', () => {
    const low = run([
      input(0, 100, { view: v('C', 50) }),
      input(1, 106, { market: { rvol: 5, resistance: 104 }, view: v('C', 50) }), // breakout RVOL tinggi tetapi tier C
    ]);
    expect(low.snap.state).toBe('QUIET');
    expect(low.alerts).toEqual([]);
    expect(low.snap).toMatchObject({ confluenceScore: 50, confidenceTier: 'C', winProbability: null });

    const ok = run([input(0, 100, { view: v('B', 65) }), input(1, 106, { market: { rvol: 5, resistance: 104 }, view: v('B', 65) })]);
    expect(ok.alerts).toEqual(['EARLY_BULLISH', 'BREAKOUT']);
  });

  it('UNIT-SSM-V3-002 QUIET tergerbang tetap kedaluwarsa (tidak macet); minEarlyTier null mematikan gerbang', () => {
    const steps = Array.from({ length: DEFAULT_SIGNAL_PARAMS.expiryBars.QUIET + 2 }, (_, i) => input(i, 100, { view: v('D', 20) }));
    expect(run(steps).events.find((e) => e.toState === 'EXPIRED')).toMatchObject({ reason: 'NO_PROGRESS', fromState: 'QUIET' });
    expect(run([input(0, 100, { view: v('D', 20) })], { minEarlyTier: null }).snap.state).toBe('EARLY_BULLISH');
    expect(() => resolveSignalParams({ minEarlyTier: 'E' })).toThrow(RangeError);
  });

  it('NEG-SSM-V3-001 konfluensi tidak valid ditolak; peluang di luar 0..1 → null; view tanpa konfluensi menghapus nilai basi', () => {
    expect(() => transition(null, input(0, 100, { view: v('Z', 50) }))).toThrow(RangeError);
    expect(() => transition(null, input(0, 100, { view: v('B', 101) }))).toThrow(RangeError);
    const r = transition(null, input(0, 100, { view: { ...v('B', 70), confluence: { score: 70, tier: 'B', calibration: { probability: 1.5 } } } }));
    expect(r.next.winProbability).toBeNull();
    const next = transition(r.next, input(1, 100, { view: { patternScore: 90, earlyScore: 80, riskFlags: [] } }));
    expect(next.next).toMatchObject({ confluenceScore: null, confidenceTier: null, winProbability: null });
  });
});
