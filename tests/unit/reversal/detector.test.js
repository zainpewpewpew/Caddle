import { describe, expect, it } from 'vitest';
import { HIGHER_TIMEFRAMES, TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import {
  CLASSIFICATIONS, EVIDENCE_GROUPS, EVIDENCE_GROUP_MAX, EVIDENCE_GROUP_OF, EVIDENCE_IDS, EVIDENCE_WEIGHTS, MARKER_KINDS, NEXT_CONFIRMATION_KINDS,
  RISKS, SETUP_TYPES, STAGES, STAGE_RANK,
} from '../../../backend/reversal/constants.js';
import { EVIDENCE_LABELS, evaluateReversal } from '../../../backend/reversal/detector.js';
import { requiredCandles, resolveReversalParams } from '../../../backend/reversal/params.js';
import { generateCandles, withProvisionalLast, withVolumeSpike, withZeroVolume, withoutCandle } from '../../fixtures/candles/synthetic.js';
import { continuedDowntrendCandles, firstIndex, flatCandles, replay, reversalCandles, uptrendCandles, zigzag } from './helpers.js';

// Semua candle berasal dari generator sintetis — bukan data pasar nyata.
const SEEDS = [1, 2, 3, 4, 5];
const WARMUP = requiredCandles(resolveReversalParams());
const RESULT_KEYS = ['version', 'timeframe', 'provisional', 'candleOpenTime', 'evaluatedAt', 'classification', 'stage', 'setupType', 'setupTypes', 'context', 'checks', 'evidence', 'evidenceCount', 'score', 'levels', 'nextConfirmation', 'cancelCondition', 'risks', 'markers', 'measures'];
const CHECK_KEYS = ['id', 'group', 'label', 'detail', 'passed', 'value', 'threshold', 'weight', 'index', 'time', 'price'];
const LEVEL_KEYS = ['bottom', 'lastSwingLow', 'higherLow', 'trigger', 'ema25', 'ema7', 'atr', 'invalidation'];
const SETUP_RULES = { SPRING: ['SPRING_RECLAIM'], DOUBLE_BOTTOM: ['BOTTOM_HELD'], ROUNDED_BOTTOM: ['ROUNDED_BOTTOM'], STAIRCASE: ['STAIRCASE'], HIGHER_LOW_BASE: ['RISING_FLOOR', 'HIGHER_LOW'], DIVERGENCE_BOTTOM: ['RSI_DIVERGENCE', 'CVD_DIVERGENCE'], COMPRESSION: ['ATR_CONTRACTION', 'RANGE_CONTRACTION', 'EMA_CONVERGENCE'] };
const ev = (candles, extra = {}) => evaluateReversal({ candles, timeframe: '5m', ...extra });
const ids = (r) => r.evidence.map((c) => c.id);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

/** Memastikan invarian bentuk kontrak §3 untuk satu hasil evaluasi. */
function assertShape(r, candles) {
  expect(Object.keys(r)).toEqual(RESULT_KEYS);
  expect(r).toMatchObject({ version: 1, timeframe: '5m', candleOpenTime: candles.at(-1).openTime, evaluatedAt: candles.at(-1).closeTime });
  expect(CLASSIFICATIONS).toContain(r.classification);
  expect(r.stage === null || STAGES.includes(r.stage)).toBe(true);
  expect(r.setupType).toBe(r.setupTypes[0] ?? null);
  expect(r.setupTypes.every((t) => SETUP_TYPES.includes(t))).toBe(true);
  expect(r.checks.map((c) => c.id)).toEqual([...EVIDENCE_IDS]);
  for (const c of r.checks) {
    expect(Object.keys(c)).toEqual(CHECK_KEYS);
    expect(c.group).toBe(EVIDENCE_GROUP_OF[c.id]);
    expect(c.weight).toBe(EVIDENCE_WEIGHTS[c.id]);
    expect(c.label).toBe(EVIDENCE_LABELS[c.id]);
    expect(typeof c.detail).toBe('string');
    expect(c.detail.length).toBeGreaterThan(0);
    if (c.index !== null) expect(c.time).toBe(candles[c.index].openTime);
  }
  expect(r.evidence).toEqual(r.checks.filter((c) => c.passed));
  expect(r.evidenceCount).toBe(r.evidence.length);
  expect(r.score.components.map((c) => c.id)).toEqual([...EVIDENCE_GROUPS]);
  for (const comp of r.score.components) {
    expect(comp.max).toBe(EVIDENCE_GROUP_MAX[comp.id]);
    expect(comp.points).toBeLessThanOrEqual(comp.max);
    expect(comp.points).toBe(Math.min(comp.max, r.evidence.filter((c) => c.group === comp.id).reduce((a, c) => a + c.weight, 0)));
  }
  expect(r.score.total).toBe(r.score.components.reduce((a, c) => a + c.points, 0));
  expect(Number.isInteger(r.score.total)).toBe(true);
  expect(Object.keys(r.levels)).toEqual(LEVEL_KEYS);
  expect(NEXT_CONFIRMATION_KINDS).toContain(r.nextConfirmation.kind);
  expect(r.cancelCondition.level).toBe(r.levels.invalidation);
  expect(r.risks).toEqual(RISKS.filter((x) => r.risks.includes(x)));
  for (const m of r.markers) {
    expect(MARKER_KINDS).toContain(m.kind);
    expect(m.time).toBeLessThanOrEqual(candles.at(-1).openTime);
    expect(typeof m.label).toBe('string');
  }
  for (const v of Object.values(r.measures)) expect(v === null || Number.isFinite(v)).toBe(true);
  expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  for (const t of r.setupTypes) expect(SETUP_RULES[t].some((id) => ids(r).includes(id))).toBe(true);
  expect(r.setupTypes).toEqual(SETUP_TYPES.filter((t) => r.setupTypes.includes(t)).sort((a, b) => Object.keys(SETUP_RULES).indexOf(a) - Object.keys(SETUP_RULES).indexOf(b)));
}

describe('evaluateReversal', () => {
  it('UNIT-RR-D-001 bentuk output persis kontrak §3 pada semua klasifikasi', () => {
    const rev = reversalCandles(1);
    assertShape(ev(rev), rev);
    assertShape(ev(uptrendCandles(1)), uptrendCandles(1));
    assertShape(ev(flatCandles(1)), flatCandles(1));
    assertShape(ev(rev.slice(0, 50)), rev.slice(0, 50));
    assertShape(ev(withoutCandle(rev, -5)), withoutCandle(rev, -5));
  });

  it('POS-RR-D-001 downtrend → dasar membulat/higher low → EARLY lalu DEVELOPING; breakout → CONFIRMED (semua seed, urutan tahap maju, dekat dasar)', () => {
    for (const seed of SEEDS) {
      const candles = reversalCandles(seed);
      const steps = replay(candles, { from: WARMUP - 1 });
      const early = firstIndex(steps, (e) => e.stage === 'EARLY_FORMATION');
      const developing = firstIndex(steps, (e) => e.stage === 'DEVELOPING_REVERSAL');
      const confirmed = firstIndex(steps, (e) => e.stage === 'CONFIRMED_BREAKOUT');
      // Tahap evaluasi (sebelum histeresis) boleh melompat; yang dijamin: EARLY muncul lebih dulu dari keduanya.
      expect(early, `seed ${seed} EARLY`).toBeGreaterThan(0);
      expect(developing, `seed ${seed} DEVELOPING`).toBeGreaterThan(early);
      expect(confirmed, `seed ${seed} CONFIRMED`).toBeGreaterThan(early);
      const atEarly = steps.find((s) => s.k === early).evaluation;
      // Deteksi dini: EARLY paling lambat 12 candle setelah dasar dan sebelum fase naik (segmen 5 mulai indeks 148).
      expect(atEarly.context.priorDecline.barsSinceBottom).toBeLessThanOrEqual(12);
      expect(early).toBeLessThan(148);
      expect(atEarly.classification).toBe('REVERSAL_CANDIDATE');
      expect(atEarly.context.priorDecline.ok).toBe(true);
      expect(atEarly.evidence.filter((c) => ['EXHAUSTION', 'BASE', 'VOLUME'].includes(c.group)).length).toBeGreaterThanOrEqual(2);
      // Breakout: close di atas pemicu + follow-through/volume, bukti non-trigger ≥ 2, nextConfirmation HOLD_ABOVE_TRIGGER.
      const atConfirmed = steps.find((s) => s.k === confirmed).evaluation;
      expect(ids(atConfirmed)).toContain('TRIGGER_BREAK');
      expect(ids(atConfirmed).some((id) => id === 'BREAK_VOLUME_SUPPORT' || id === 'BREAK_FOLLOW_THROUGH')).toBe(true);
      expect(atConfirmed.levels.invalidation).toBeGreaterThanOrEqual(atConfirmed.levels.trigger - 0.75 * atConfirmed.levels.atr - 1e-9);
      expect(atConfirmed.nextConfirmation.kind).toBe('HOLD_ABOVE_TRIGGER');
      // State machine: kandidat dibuka EARLY lalu naik tahap (tanpa downgrade), alert pada OPENED & STAGE_UP.
      const events = steps.flatMap((s) => s.events);
      expect(events.slice(0, 3).map((e) => [e.type, e.toStage])).toEqual([
        ['OPENED', 'EARLY_FORMATION'], ['STAGE_UP', 'DEVELOPING_REVERSAL'], ['STAGE_UP', 'CONFIRMED_BREAKOUT'],
      ]);
      const ranks = steps.map((s) => (s.snapshot.status === 'NONE' ? 0 : STAGE_RANK[s.snapshot.stage]));
      for (let i = 1; i < ranks.length; i += 1) {
        if (steps[i].snapshot.status !== 'NONE' && steps[i - 1].snapshot.status !== 'NONE' && steps[i].snapshot.firstDetectedAt === steps[i - 1].snapshot.firstDetectedAt) {
          expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
        }
      }
    }
  });

  it('POS-RR-D-002 breakout dengan RVOL ≥ 1,5 → BREAK_VOLUME_SUPPORT lulus dan tanpa risiko NO_VOLUME_SUPPORT', () => {
    const candles = reversalCandles(1);
    const steps = replay(candles, { from: WARMUP - 1 });
    const k = firstIndex(steps, (e) => ids(e).includes('TRIGGER_BREAK') && e.evidence.filter((c) => c.group !== 'TRIGGER').length >= 2);
    expect(k).toBeGreaterThan(0);
    const spiked = withVolumeSpike(candles, k, 3).slice(0, k + 1);
    const r = ev(spiked);
    expect(r.stage).toBe('CONFIRMED_BREAKOUT');
    expect(ids(r)).toContain('BREAK_VOLUME_SUPPORT');
    expect(r.checks.find((c) => c.id === 'BREAK_VOLUME_SUPPORT').value).toBeGreaterThanOrEqual(1.5);
    expect(r.risks).not.toContain('NO_VOLUME_SUPPORT');
    expect(r.score.components.find((c) => c.id === 'TRIGGER').points).toBeGreaterThanOrEqual(7);
    // Tanpa dukungan volume tetapi follow-through: tetap CONFIRMED dengan risiko NO_VOLUME_SUPPORT bila RVOL < 1,5.
    const plain = ev(candles.slice(0, k + 1));
    if (!ids(plain).includes('BREAK_VOLUME_SUPPORT') && plain.stage === 'CONFIRMED_BREAKOUT') expect(plain.risks).toContain('NO_VOLUME_SUPPORT');
  });

  it('NEG-RR-D-001 uptrend berlanjut → CONTINUATION tanpa tahap, skor 0, tanpa marker (bukan kandidat reversal)', () => {
    for (const seed of SEEDS) {
      const candles = uptrendCandles(seed);
      for (const k of [WARMUP + 5, 160, candles.length - 1]) {
        const r = ev(candles.slice(0, k + 1));
        expect(r.classification, `seed ${seed} k ${k}`).toBe('CONTINUATION');
        expect(r.stage).toBeNull();
        expect(r.score.total).toBe(0);
        expect(r.checks.every((c) => c.passed === false && c.value === null)).toBe(true);
        expect(r.markers).toEqual([]);
        expect(r.context.priorDecline.ok).toBe(false);
        expect(r.nextConfirmation.kind).toBe('NONE');
      }
      expect(replay(candles, { from: WARMUP - 1 }).flatMap((s) => s.events)).toEqual([]);
    }
  });

  it('NEG-RR-D-002 downtrend berlanjut → tidak ada kandidat dibuka; tahap hanya sesekali (≤ 3 % candle), tidak pernah ≥ DEVELOPING', () => {
    for (const seed of SEEDS) {
      const candles = continuedDowntrendCandles(seed);
      const steps = replay(candles, { from: WARMUP - 1 });
      expect(steps.flatMap((s) => s.events), `seed ${seed}`).toEqual([]);
      const staged = steps.filter((s) => s.evaluation.stage !== null);
      expect(staged.length / steps.length).toBeLessThanOrEqual(0.03);
      expect(staged.every((s) => s.evaluation.stage === 'EARLY_FORMATION')).toBe(true);
      expect(steps.every((s) => s.evaluation.classification !== 'CONTINUATION')).toBe(true);
    }
  });

  it('EDGE-RR-D-001 gap waktu / volume nol beruntun / candle rusak / campuran seri → DATA_QUALITY + risiko DATA_QUALITY; < warm-up → INSUFFICIENT_DATA', () => {
    const candles = reversalCandles(1);
    for (const broken of [withoutCandle(candles, -10), withZeroVolume(candles, -6, 3)]) {
      const r = ev(broken);
      expect(r.classification).toBe('DATA_QUALITY');
      expect(r.stage).toBeNull();
      expect(r.risks).toContain('DATA_QUALITY');
      expect(r.checks.every((c) => !c.passed)).toBe(true);
      expect(r.levels).toEqual({ bottom: null, lastSwingLow: null, higherLow: null, trigger: null, ema25: null, ema7: null, atr: null, invalidation: null });
    }
    const invalid = candles.map((c, i) => (i === candles.length - 3 ? { ...c, high: c.low - 1 } : c));
    expect(ev(invalid).classification).toBe('DATA_QUALITY');
    const mixedRecent = candles.map((c, i) => (i === candles.length - 40 ? { ...c, symbol: 'OTHERUSDT' } : c));
    expect(ev(mixedRecent).classification).toBe('DATA_QUALITY');
    // Kerusakan yang lebih TUA dari sufiks bersih ≥ warm-up tidak membutakan seri: evaluasi memakai sufiks bersih,
    // risiko DATA_QUALITY tetap dilaporkan dan jumlah candle yang dibuang tercatat (measures.candlesDropped).
    const mixedOld = candles.map((c, i) => (i === 10 ? { ...c, symbol: 'OTHERUSDT' } : c));
    const rOld = ev(mixedOld);
    expect(rOld.classification).not.toBe('DATA_QUALITY');
    expect(rOld.risks).toContain('DATA_QUALITY');
    expect(rOld.measures.candlesDropped).toBe(11);
    const corruptOld = candles.map((c, i) => (i === 10 ? { ...c, high: c.low - 1 } : c));
    expect(ev(corruptOld).classification).toBe(ev(candles.slice(11)).classification);
    expect(ev(corruptOld).measures.candlesDropped).toBe(11);
    // Gap yang sudah keluar dari jendela warm-up tidak lagi menghukum.
    expect(ev(withoutCandle(candles, 3)).classification).not.toBe('DATA_QUALITY');
    expect(ev(candles).measures.candlesDropped).toBe(0);
    const short = ev(candles.slice(0, WARMUP - 1));
    expect(short.classification).toBe('INSUFFICIENT_DATA');
    expect(short.risks).not.toContain('DATA_QUALITY');
    expect(short.measures).toMatchObject({ candles: WARMUP - 1, requiredCandles: WARMUP });
    expect(ev(candles.slice(0, WARMUP)).classification).not.toBe('INSUFFICIENT_DATA');
  });

  it('NEG-RR-D-003 candle terakhir belum tutup: tanpa provisional → RangeError; provisional → hasil berlabel + risiko PROVISIONAL; candle lama belum tutup → DATA_QUALITY', () => {
    const candles = reversalCandles(1);
    const running = withProvisionalLast(candles);
    expect(() => ev(running)).toThrow(RangeError);
    const r = ev(running, { provisional: true });
    expect(r.provisional).toBe(true);
    expect(r.risks).toContain('PROVISIONAL');
    const closed = ev(candles);
    expect(r.classification).toBe(closed.classification);
    expect(r.stage).toBe(closed.stage);
    expect(closed.provisional).toBe(false);
    expect(closed.risks).not.toContain('PROVISIONAL');
    // provisional=true dengan candle terakhir tertutup tetap sah (berlabel provisional).
    expect(ev(candles, { provisional: true }).provisional).toBe(true);
    const staleOpen = candles.map((c, i) => (i === candles.length - 4 ? { ...c, isClosed: false } : c));
    expect(ev(staleOpen, { provisional: true }).classification).toBe('DATA_QUALITY');
  });

  it('NEG-RR-D-004 validasi input', () => {
    const candles = reversalCandles(1);
    expect(() => evaluateReversal(null)).toThrow(TypeError);
    expect(() => evaluateReversal({ candles, timeframe: '4h' })).toThrow(RangeError);
    expect(() => evaluateReversal({ candles, timeframe: '15m' })).toThrow(RangeError); // candle 5m ≠ 15m
    expect(() => evaluateReversal({ candles: 'x', timeframe: '5m' })).toThrow(TypeError);
    expect(() => evaluateReversal({ candles: [], timeframe: '5m' })).toThrow(RangeError);
    expect(() => evaluateReversal({ candles, timeframe: '5m', params: { bogus: 1 } })).toThrow(TypeError);
    expect(() => evaluateReversal({ candles, timeframe: '5m', params: { breakRvol: -1 } })).toThrow(RangeError);
    expect(() => evaluateReversal({ candles, timeframe: '5m', higher: [] })).toThrow(TypeError);
    expect(() => evaluateReversal({ candles, timeframe: '5m', higher: { '15m': 'x' } })).toThrow(TypeError);
    expect(() => evaluateReversal({ candles, timeframe: '5m', liquidity: 5 })).toThrow(TypeError);
    expect(() => evaluateReversal({ candles, timeframe: '5m', provisional: 'ya' })).toThrow(TypeError);
  });

  it('UNIT-RR-D-002 konteks HTF: EMA25 HTF & slope → BULLISH/BEARISH/NEUTRAL; candle HTF masa depan diabaikan; 1h tanpa HTF → HTF_UNKNOWN', () => {
    const base = reversalCandles(1);
    const evaluatedAt = base.at(-1).closeTime;
    // Seri HTF dimulai 60 jam sebelum seri dasar agar EMA25 HTF (warm-up 29 candle) terhitung; sebagian candle tutup setelah evaluasi.
    const startTime = base[0].openTime - 60 * TIMEFRAME_MS['1h'];
    const bars = (tf) => (tf === '1h' ? 100 : 400);
    const up = (tf) => generateCandles({ seed: 3, timeframe: tf, startTime, segments: [{ bars: bars(tf), drift: 0.003, cycle: zigzag(4, 0.001, 2, 0.001), volume: 1000 }] });
    const down = (tf) => generateCandles({ seed: 3, timeframe: tf, startTime, segments: [{ bars: bars(tf), drift: -0.003, cycle: zigzag(2, 0.001, 4, 0.001), volume: 1000 }] });
    expect(up('1h').some((c) => c.closeTime > evaluatedAt)).toBe(true);
    const closedBy = (list) => list.filter((c) => c.closeTime <= evaluatedAt);
    const bullish = ev(base, { higher: { '15m': closedBy(up('15m')), '1h': closedBy(up('1h')) } });
    expect(bullish.context.htf).toMatchObject({ timeframe: '15m,1h', trend: 'BULLISH' });
    expect(bullish.context.htf.detail).toContain('15m: naik');
    expect(bullish.risks).not.toContain('HTF_DOWNTREND');
    expect(bullish.risks).not.toContain('HTF_UNKNOWN');
    expect(bullish.measures).toMatchObject({ htfTrend15m: 1, htfTrend1h: 1 });
    const bearish = ev(base, { higher: { '15m': closedBy(up('15m')), '1h': closedBy(down('1h')) } });
    expect(bearish.context.htf.trend).toBe('BEARISH');
    expect(bearish.risks).toContain('HTF_DOWNTREND');
    expect(bearish.measures.htfTrend1h).toBe(-1);
    // Satu HTF saja tersedia → dinilai dari yang ada; tanpa data → null + HTF_UNKNOWN.
    expect(ev(base, { higher: { '1h': closedBy(up('1h')) } }).context.htf.trend).toBe('BULLISH');
    const none = ev(base);
    expect(none.context.htf).toMatchObject({ timeframe: '15m,1h', trend: null });
    expect(none.risks).toContain('HTF_UNKNOWN');
    expect(ev(base, { higher: { '15m': up('15m').slice(0, 5) } }).context.htf.trend).toBeNull();
    // Anti-lookahead: candle HTF yang tutup setelah evaluasi dipotong oleh detektor → hasil identik dengan yang sudah dipotong.
    const unfiltered = ev(base, { higher: { '15m': up('15m'), '1h': down('1h') } });
    expect(unfiltered).toEqual(bearish);
    expect(() => ev(base, { higher: { '15m': up('1h') } })).toThrow(RangeError);
    // 1h: tidak ada HTF di sistem.
    const h1 = generateCandles({ seed: 1, timeframe: '1h', segments: [{ bars: 130, drift: -0.002, cycle: zigzag(2, 0.002, 4, 0.002), volume: 1000 }] });
    const r1h = evaluateReversal({ candles: h1, timeframe: '1h', higher: { '15m': up('15m') } });
    expect(r1h.context.htf).toEqual({ timeframe: null, trend: null, detail: expect.any(String) });
    expect(r1h.risks).toContain('HTF_UNKNOWN');
    expect(HIGHER_TIMEFRAMES['1h']).toEqual([]);
  });

  it('UNIT-RR-D-003 kelas likuiditas & risiko: THIN → LOW_LIQUIDITY, ILLIQUID → ILLIQUID (VOLUME_DRY_UP bukan bukti), fallback rata-rata quote volume', () => {
    const candles = reversalCandles(1);
    const steps = replay(candles, { from: WARMUP - 1 });
    const k = firstIndex(steps, (e) => ids(e).includes('VOLUME_DRY_UP'));
    expect(k).toBeGreaterThan(0);
    const prefix = candles.slice(0, k + 1);
    const liquid = ev(prefix, { liquidity: { quoteVolume24h: 80_000_000, spreadBps: 3 } });
    expect(liquid.context.liquidityClass).toBe('LIQUID');
    expect(liquid.risks).not.toContain('LOW_LIQUIDITY');
    expect(ids(liquid)).toContain('VOLUME_DRY_UP');
    const thin = ev(prefix, { liquidity: { quoteVolume24h: 20_000_000 } });
    expect(thin.context.liquidityClass).toBe('THIN');
    expect(thin.risks).toContain('LOW_LIQUIDITY');
    const illiquid = ev(prefix, { liquidity: { quoteVolume24h: 1_000_000 } });
    expect(illiquid.context.liquidityClass).toBe('ILLIQUID');
    expect(illiquid.risks).toContain('ILLIQUID');
    expect(ids(illiquid)).not.toContain('VOLUME_DRY_UP');
    expect(illiquid.checks.find((c) => c.id === 'VOLUME_DRY_UP').detail).toContain('ILLIQUID');
    expect(illiquid.score.total).toBeLessThan(liquid.score.total);
    // Tanpa data 24 jam: rata-rata quote volume per candle (≈ 50 000 USDT di sini) ≥ 20 000 → UNKNOWN; ambang 1h 240 000 → ILLIQUID.
    expect(ev(prefix).context.liquidityClass).toBe('UNKNOWN');
    expect(ev(prefix, { params: { minAvgQuoteVolume: { '5m': 1e9 } } }).context.liquidityClass).toBe('ILLIQUID');
    expect(ev(prefix, { liquidity: { quoteVolume24h: 2_000_000, thresholds: { minQuoteVolume24h: 1_000_000 } } }).context.liquidityClass).toBe('LIQUID');
  });

  it('UNIT-RR-D-004 stabilitas prefiks (anti-lookahead): hasil pada prefiks k identik dengan replay pada k dan tidak berubah oleh candle masa depan yang berbeda; input tidak dimutasi', () => {
    const full = reversalCandles(2, { extraBars: 130 });
    expect(full.length).toBeGreaterThanOrEqual(300);
    deepFreeze(full);
    // Seri alternatif: prefiks 200 candle yang sama, masa depan berbeda (crash).
    const alt = [...full.slice(0, 200), ...generateCandles({
      seed: 99, startPrice: full[199].close, startTime: full[199].openTime + TIMEFRAME_MS['5m'],
      segments: [{ bars: 122, drift: -0.01, cycle: zigzag(1, 0.004, 3, 0.006), wick: 0.004, volume: 3000 }],
    })];
    const steps = replay(full, { from: WARMUP - 1 });
    const ks = [WARMUP - 1, 125, 131, 140, 150, 163, 180, 199, 230, 260, 299, full.length - 1];
    for (const k of ks) {
      const direct = ev(full.slice(0, k + 1));
      expect(direct, `k ${k}`).toEqual(steps.find((s) => s.k === k).evaluation);
      if (k < 200) expect(ev(alt.slice(0, k + 1)), `k ${k} alt`).toEqual(direct);
      expect(direct.evaluatedAt).toBe(full[k].closeTime);
      for (const c of direct.checks) if (c.index !== null) expect(c.index).toBeLessThanOrEqual(k);
      for (const m of direct.markers) expect(m.time).toBeLessThanOrEqual(full[k].openTime);
      // Level pemicu hanya dari high sebelum candle evaluasi: close candle evaluasi boleh berada di atasnya.
      if (direct.levels.trigger !== null) expect(direct.levels.trigger).toBeLessThanOrEqual(Math.max(...full.slice(0, k).map((c) => c.high)));
    }
    // Determinisme: dua panggilan identik → hasil identik; replay state machine deterministik.
    expect(ev(full)).toEqual(ev(full));
    expect(replay(full, { from: WARMUP - 1 }).map((s) => s.snapshot)).toEqual(steps.map((s) => s.snapshot));
  });

  it('UNIT-RR-D-005 level & risiko: invalidasi = min(dasar, swing low) − 0,25 ATR (0 < inv < close), CONFIRMED pakai lantai pemicu − 0,75 ATR, LATE_ENTRY & NEAR_INVALIDATION', () => {
    const candles = reversalCandles(3);
    const steps = replay(candles, { from: WARMUP - 1 });
    for (const s of steps) {
      const r = s.evaluation;
      if (r.classification !== 'REVERSAL_CANDIDATE') continue;
      const close = candles[s.k].close;
      const base = Math.min(r.levels.bottom, r.levels.lastSwingLow ?? Infinity) - 0.25 * r.levels.atr;
      expect(r.measures.invalidationBase).toBeCloseTo(base, 9);
      if (r.levels.invalidation !== null) {
        expect(r.levels.invalidation).toBeGreaterThan(0);
        expect(r.levels.invalidation).toBeLessThan(close);
      }
      if (r.stage === 'CONFIRMED_BREAKOUT') {
        expect(r.levels.invalidation).toBeGreaterThanOrEqual(Math.min(base, r.levels.trigger - 0.75 * r.levels.atr) - 1e-9);
      } else {
        expect(r.levels.invalidation).toBeCloseTo(base, 9);
      }
      expect(r.levels.bottom).toBe(candles[r.context.priorDecline.bottomIndex].low);
      const late = (close - r.levels.bottom) / r.levels.atr >= 4;
      expect(r.risks.includes('LATE_ENTRY')).toBe(late);
      if (r.levels.invalidation !== null) expect(r.risks.includes('NEAR_INVALIDATION')).toBe(close - r.levels.invalidation <= 0.5 * r.levels.atr);
      expect(r.markers.find((m) => m.kind === 'BOTTOM')).toMatchObject({ time: candles[r.context.priorDecline.bottomIndex].openTime, price: r.levels.bottom });
      if (r.levels.higherLow !== null) expect(r.markers.some((m) => m.kind === 'HIGHER_LOW' && m.price === r.levels.higherLow)).toBe(true);
    }
  });

  it('UNIT-RR-D-006 teks Indonesia dengan angka konkret; nextConfirmation mengikuti tahap; cancelCondition memuat level', () => {
    const candles = reversalCandles(1);
    const steps = replay(candles, { from: WARMUP - 1 });
    const byStage = (stage) => steps.find((s) => s.evaluation.stage === stage).evaluation;
    const early = byStage('EARLY_FORMATION');
    expect(['HIGHER_LOW', 'EMA25_RECLAIM']).toContain(early.nextConfirmation.kind);
    expect(early.nextConfirmation.text).toMatch(/\d/);
    expect(byStage('DEVELOPING_REVERSAL').nextConfirmation).toMatchObject({ kind: 'TRIGGER_BREAK', text: expect.stringContaining('level pemicu') });
    const confirmed = byStage('CONFIRMED_BREAKOUT');
    expect(confirmed.cancelCondition.text).toContain('breakout gagal');
    expect(confirmed.cancelCondition.text).toMatch(/\d+,\d+/);
    for (const c of confirmed.evidence) expect(c.detail).toMatch(/\d/);
    expect(confirmed.checks.find((c) => c.id === 'LL_STOPPED').detail).toMatch(/Tidak ada low baru di bawah dasar \S+ selama \d+ candle/);
    expect(confirmed.checks.find((c) => c.id === 'TRIGGER_BREAK').detail).toMatch(/di atas level pemicu/);
    // Tidak ada klaim tren pasti berbalik.
    for (const c of confirmed.checks) expect(c.detail.toLowerCase()).not.toMatch(/pasti/);
  });

  it('UNIT-RR-D-007 efisien: evaluasi 300 candle rata-rata beberapa milidetik', () => {
    const candles = reversalCandles(4, { extraBars: 108 });
    expect(candles.length).toBe(300);
    ev(candles); // pemanasan JIT
    const t0 = performance.now();
    const n = 40;
    for (let i = 0; i < n; i += 1) ev(candles);
    const perEval = (performance.now() - t0) / n;
    expect(perEval).toBeLessThan(15);
  });

  it('UNIT-RR-D-008 override parameter mengubah ambang (mis. minEarlyEvidence 5 → tidak ada EARLY pada data yang sama)', () => {
    const candles = reversalCandles(1);
    const strict = replay(candles, { from: WARMUP - 1, params: { minEarlyEvidence: 5, minDevelopingEvidence: 6, minConfirmedEvidence: 6 } });
    const loose = replay(candles, { from: WARMUP - 1 });
    expect(loose.some((s) => s.evaluation.stage === 'EARLY_FORMATION')).toBe(true);
    const strictStages = strict.filter((s) => s.evaluation.stage !== null).length;
    expect(strictStages).toBeLessThan(loose.filter((s) => s.evaluation.stage !== null).length);
    expect(ev(candles, { params: { bottomLookback: 30 } }).context.priorDecline.bottomIndex).toBeGreaterThanOrEqual(candles.length - 30);
  });
});
