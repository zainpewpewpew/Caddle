// Harness replay Reversal Radar (backend/reversal/replay.js) dengan mesin PALSU deterministik
// (tests/helpers/fakeReversalEngine.js): outcome triple barrier pada kasus buatan tangan, lead vs mesin lama,
// histeresis, HTF tanpa look-ahead, uji stabilitas prefiks (jujur lolos, curang terdeteksi), data rusak tanpa crash.
// Semua candle SINTETIS — bukan data pasar nyata. Mesin asli (agent A) disuntikkan oleh integrator lewat CLI.
import { describe, expect, it } from 'vitest';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { EVIDENCE_WEIGHTS } from '../../../backend/reversal/constants.js';
import {
  LookaheadError, OLD_SCANNER_MODES, REPLAY_DEFAULTS, REPLAY_OUTCOMES, assertNoLookahead, breakoutLead, contextSeries, firstDifference,
  htfCursor, labelCandidate, replayReversalSeries, replayReversalUniverse,
} from '../../../backend/reversal/replay.js';
import { scenarioUniverse, successfulReversal, uptrendContinuation, continuedDowntrend, brokenData } from '../../fixtures/candles/reversalScenarios.js';
import { SYNTHETIC_START } from '../../fixtures/candles/synthetic.js';
import { candlesFromRows, createScriptedEngine, fakeEngine, fakeEvaluate } from '../../helpers/fakeReversalEngine.js';

const SYMBOL = 'successfulReversal-21';
const MS = TIMEFRAME_MS['15m'];
const flat = { o: 100, h: 100.5, l: 99.5, c: 100 };
const LEVELS = { atr: 1, invalidation: 97, trigger: 101, bottom: 97.25 };

/** Seri buatan tangan: 3 candle datar, candle ke-3 (indeks 3) = deteksi, lalu `after`. */
const handRows = (after) => [flat, flat, flat, flat, ...after];
const scripted = (extra = {}) => createScriptedEngine({ stages: { 3: 'EARLY_FORMATION' }, levelsAt: () => LEVELS, ...extra });
const runHand = (after, options = {}) => replayReversalSeries({
  symbol: 'HANDUSDT', timeframe: '15m', candles: candlesFromRows(handRows(after)), ...scripted(options.engine), oldScanner: false, warmupBars: 1, ...options,
});

const universeOf = (seeds, timeframe, scenarios) => scenarioUniverse({ seeds, timeframe, scenarios });
const seriesOf = (universe, symbol, timeframe) => {
  const byTf = universe[symbol];
  const higher = Object.fromEntries(Object.entries(byTf).filter(([tf]) => tf !== timeframe));
  return { symbol, timeframe, candles: byTf[timeframe], higher };
};
const withFake = (input, extra = {}) => replayReversalSeries({ ...input, ...fakeEngine, oldMode: 'fast', ...extra });

describe('replayReversalSeries — mekanika', () => {
  it('UNIT-RRV-020 bentuk hasil, warm-up, urutan tahap, tanpa provisional, kandidat pada reversal sukses', async () => {
    const u = universeOf([21], '15m', ['successfulReversal']);
    const r = await withFake(seriesOf(u, SYMBOL, '15m'));
    expect(r).toMatchObject({ symbol: SYMBOL, timeframe: '15m', bars: u[SYMBOL]['15m'].length, warmup: 150, horizonBars: 48, targetAtr: 2, provisionalFree: true });
    expect(r.evaluations).toBe(r.bars - 150);
    // Frekuensi bukti per evaluasi: hanya id bukti kontrak, total > 0, tidak melebihi jumlah evaluasi.
    expect(Object.keys(r.evidenceCounts).every((id) => id in EVIDENCE_WEIGHTS)).toBe(true);
    expect(Object.values(r.evidenceCounts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(Math.max(...Object.values(r.evidenceCounts))).toBeLessThanOrEqual(r.evaluations);
    expect(r.old).toMatchObject({ enabled: true, mode: 'fast', evaluations: r.evaluations });
    expect(Object.values(r.anomalies).every((v) => v === 0)).toBe(true);
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
    for (const c of r.candidates) {
      expect(c.firstDetectedIndex).toBeGreaterThanOrEqual(150);
      expect(c.firstDetectedTime).toBe(u[SYMBOL]['15m'][c.firstDetectedIndex].closeTime);
      expect(c.firstDetectedPrice).toBe(u[SYMBOL]['15m'][c.firstDetectedIndex].close);
      expect(c.firstDetectedAtr).toBeGreaterThan(0);
      expect(['EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT']).toContain(c.firstStage);
      expect(c.stages[0]).toMatchObject({ stage: c.firstStage, index: c.firstDetectedIndex });
      for (let k = 1; k < c.stages.length; k += 1) expect(c.stages[k].index).toBeGreaterThan(c.stages[k - 1].index);
      expect([...REPLAY_OUTCOMES, null]).toContain(c.outcome);
      if (c.closeIndex !== null) expect(c.closeIndex).toBeGreaterThan(c.firstDetectedIndex);
      expect(typeof c.firstScore).toBe('number');
      expect(Number.isInteger(c.firstEvidenceCount)).toBe(true);
    }
    // Reversal sukses dengan mesin palsu: kandidat pertama dibuka di fase dasar (sebelum breakout) dan SUCCESS.
    const first = r.candidates.find((c) => c.outcome === 'SUCCESS');
    expect(first).toBeDefined();
    expect(first.leadVsBreakout).toBeGreaterThan(0);
    expect(r.counts.opened).toBe(r.candidates.length);
    expect(r.classifications.REVERSAL_CANDIDATE).toBeGreaterThan(0);
  });

  it('UNIT-RRV-021 triple barrier §10: SUCCESS, FAIL (stop), FAIL (gap di open), TP & SL satu candle = FAIL, TIMEOUT, OPEN, tanpa invalidasi', async () => {
    const success = await runHand([{ o: 100, h: 101, l: 99.6, c: 100.4 }, { o: 100.4, h: 100.6, l: 98.5, c: 99 }, { o: 99, h: 102.2, l: 98.9, c: 102 }, flat, flat, flat, flat, flat]);
    expect(success.candidates).toHaveLength(1);
    const s = success.candidates[0];
    expect(s).toMatchObject({ firstDetectedIndex: 3, firstDetectedPrice: 100, firstDetectedAtr: 1, invalidation: 97, trigger: 101, stopPrice: 97, outcome: 'SUCCESS', exitIndex: 6, exitPrice: 102, barsHeld: 3, gap: false });
    expect(s.targetPrice).toBeCloseTo(102, 9);
    expect(s.mfeAtr).toBeCloseTo(2, 9);
    expect(s.maeAtr).toBeCloseTo(-1.5, 9);
    expect(s.mfePct).toBeCloseTo(0.02, 9);
    expect(s.maePct).toBeCloseTo(-0.015, 9);

    const stop = await runHand([{ o: 99, h: 99.5, l: 96.8, c: 97.5 }, flat, flat]);
    expect(stop.candidates[0]).toMatchObject({ outcome: 'FAIL', exitIndex: 4, exitPrice: 97, gap: false, barsHeld: 1 });
    expect(stop.candidates[0].maeAtr).toBeCloseTo(-3, 9);

    const gap = await runHand([{ o: 96, h: 96.5, l: 95, c: 96.2 }, flat]);
    expect(gap.candidates[0]).toMatchObject({ outcome: 'FAIL', exitIndex: 4, exitPrice: 96, gap: true });
    expect(gap.candidates[0].maeAtr).toBeCloseTo(-4, 9);

    const both = await runHand([{ o: 100, h: 103, l: 96.9, c: 101 }, flat]);
    expect(both.candidates[0]).toMatchObject({ outcome: 'FAIL', exitPrice: 97, mfeAtr: 0 });

    const timeout = await runHand(Array(8).fill(flat), { horizonBars: 4 });
    expect(timeout.candidates[0]).toMatchObject({ outcome: 'TIMEOUT', exitIndex: 7, exitPrice: 100, barsHeld: 4 });
    expect(timeout.candidates[0].mfeAtr).toBeCloseTo(0.5, 9);
    expect(timeout.candidates[0].maeAtr).toBeCloseTo(-0.5, 9);

    const open = await runHand([flat, flat, flat]);
    expect(open.candidates[0]).toMatchObject({ outcome: 'OPEN', exitIndex: 6, barsHeld: 3 });

    const noStop = await runHand([flat, flat, flat], { engine: { levelsAt: () => ({ ...LEVELS, invalidation: null }) } });
    expect(noStop.candidates[0]).toMatchObject({ outcome: null, labelError: 'NO_INVALIDATION', invalidation: null });
    // Pelabelan langsung: ATR tidak ada → tidak dapat dilabeli.
    expect(labelCandidate(candlesFromRows(handRows([flat])), { firstDetectedIndex: 3, firstDetectedPrice: 100, firstDetectedAtr: null, invalidation: 97 }))
      .toMatchObject({ outcome: null, labelError: 'NO_ATR' });
  });

  it('UNIT-RRV-022 leadVsOld/leadVsOldAlert dari mesin lama tersuntik, leadVsBreakout dan barsToTrigger', async () => {
    const indexOf = (c) => Math.round((c.openTime - SYNTHETIC_START) / MS);
    const oldAnalyze = ({ candlesByTimeframe, timeframe, prev }) => {
      const i = indexOf(candlesByTimeframe[timeframe].at(-1));
      if (i === 9) return { next: { state: 'QUIET' }, event: { fromState: 'NO_PATTERN', toState: 'QUIET' }, alert: false };
      if (i === 12) return { next: { state: 'EARLY_BULLISH' }, event: { fromState: 'QUIET', toState: 'EARLY_BULLISH' }, alert: true };
      return { next: prev ?? { state: 'NO_PATTERN' }, event: null, alert: false };
    };
    const after = [flat, { o: 100, h: 101.8, l: 99.8, c: 101.5 }, flat, flat, flat, flat, flat, flat, flat, flat, flat, flat];
    const r = await replayReversalSeries({
      symbol: 'HANDUSDT', timeframe: '15m', candles: candlesFromRows(handRows(after)), warmupBars: 1, oldAnalyze, oldMode: 'fast',
      ...scripted({ evidenceAt: (i) => (i === 3 ? ['LL_STOPPED', 'ATR_CONTRACTION'] : i === 6 ? ['TRIGGER_BREAK'] : []) }),
    });
    expect(r.old).toMatchObject({ enabled: true, firstSignalIndex: 9, firstSignalState: 'QUIET', firstAlertIndex: 12, firstAlertState: 'EARLY_BULLISH', signals: 1, alerts: 1 });
    const c = r.candidates[0];
    expect(c).toMatchObject({ firstDetectedIndex: 3, leadVsOld: 6, leadVsOldAlert: 9, leadVsBreakout: 2, barsToTrigger: 3, firstEvidence: ['LL_STOPPED', 'ATR_CONTRACTION'], firstEvidenceCount: 2 });
    // Tanpa pembanding lama → lead null; mode tidak dikenal ditolak.
    const off = await runHand([flat, flat], { oldScanner: false });
    expect(off.old).toMatchObject({ enabled: false, mode: null, firstSignalIndex: null });
    expect(off.candidates[0].leadVsOld).toBeNull();
    await expect(runHand([flat], { oldScanner: true, oldMode: 'turbo', oldAnalyze: oldAnalyze })).rejects.toThrow(RangeError);
    expect(OLD_SCANNER_MODES).toEqual(['full', 'fast']);
    // breakoutLead: close deteksi sudah di atas pemicu → 0; tanpa pemicu → null.
    const candles = candlesFromRows(handRows([flat]));
    expect(breakoutLead(candles, { firstDetectedIndex: 3, trigger: 99 })).toBe(0);
    expect(breakoutLead(candles, { firstDetectedIndex: 3, trigger: null })).toBeNull();
    expect(breakoutLead(candles, { firstDetectedIndex: 3, trigger: 150 })).toBeNull();
  });

  it('UNIT-RRV-023 histeresis per timeframe (5m butuh 2 candle) & bentuk chart identik → deteksi 5m satu candle lebih lambat', async () => {
    const u15 = universeOf([21], '15m', ['successfulReversal']);
    const u5 = universeOf([21], '5m', ['successfulReversal']);
    const r15 = await withFake(seriesOf(u15, SYMBOL, '15m'), { oldScanner: false });
    const r5 = await withFake(seriesOf(u5, SYMBOL, '5m'), { oldScanner: false });
    expect(r5.candidates.length).toBeGreaterThanOrEqual(1);
    expect(r5.candidates.length).toBe(r15.candidates.length);
    expect(r5.candidates.map((c) => c.firstDetectedIndex)).toEqual(r15.candidates.map((c) => c.firstDetectedIndex + 1));
    // Bentuk chart identik → klasifikasi per candle identik. Tahap evaluasi boleh berbeda karena konteks HTF 5m (15m/1h
    // diagregasi dari 370 candle 5m) lebih pendek daripada HTF 15m → HTF_UNKNOWN pada sebagian candle 5m.
    expect(r5.classifications).toEqual(r15.classifications);
  });

  it('UNIT-RRV-024 HTF tanpa look-ahead: setiap candle HTF yang diberikan ke evaluate memiliki closeTime ≤ candle evaluasi; 1h tanpa HTF', async () => {
    const u = universeOf([22], '5m', ['successfulReversal']);
    const input = seriesOf(u, 'successfulReversal-22', '5m');
    let calls = 0;
    let violations = 0;
    let shrink = 0;
    const seen = { '15m': 0, '1h': 0 };
    const evaluate = (args) => {
      calls += 1;
      const t = args.candles.at(-1).closeTime;
      expect(args.candles.length).toBeLessThanOrEqual(REPLAY_DEFAULTS.lookback);
      expect(args.provisional).toBe(false);
      expect(Object.keys(args.higher).sort()).toEqual(['15m', '1h']);
      for (const [tf, list] of Object.entries(args.higher)) {
        if (list.some((c) => c.closeTime > t)) violations += 1;
        if (list.length < seen[tf]) shrink += 1;
        seen[tf] = list.length;
      }
      return fakeEvaluate(args);
    };
    const r = await replayReversalSeries({ ...input, ...fakeEngine, evaluate, oldScanner: false });
    expect(calls).toBe(r.evaluations);
    expect(violations).toBe(0);
    expect(shrink).toBe(0);
    expect(seen['1h']).toBeGreaterThan(0);
    // HTF yang diberikan harus benar-benar dipakai (bukan agregasi ulang) dan dipotong pada waktu yang tepat.
    const last = input.candles.at(-1);
    const cursor = htfCursor(input.higher['1h']);
    expect(cursor(last.closeTime).every((c) => c.closeTime <= last.closeTime)).toBe(true);
    expect(cursor(last.closeTime).at(-1)).toEqual(input.higher['1h'].filter((c) => c.closeTime <= last.closeTime).at(-1));
    expect(contextSeries('1h', input.candles)).toEqual({});
    expect(Object.keys(contextSeries('15m', u['successfulReversal-22']['15m']))).toEqual(['1h']);
    const u1h = universeOf([22], '1h', ['successfulReversal']);
    let noHtf = true;
    await replayReversalSeries({
      ...seriesOf(u1h, 'successfulReversal-22', '1h'), ...fakeEngine, oldScanner: false,
      evaluate: (args) => { if (Object.keys(args.higher).length) noHtf = false; return fakeEvaluate(args); },
    });
    expect(noHtf).toBe(true);
  });

  it('UNIT-RRV-025 assertNoLookahead: evaluate jujur lolos; evaluate curang (memakai candle masa depan yang pernah dilihat) terdeteksi', async () => {
    const u = universeOf([23], '15m', ['successfulReversal']);
    const input = seriesOf(u, 'successfulReversal-23', '15m');
    const ok = await assertNoLookahead({ ...input, ...fakeEngine, samples: 4, seed: 7 });
    expect(ok).toMatchObject({ ok: true, prefixReplayIndexes: [ok.samples.at(-1)] });
    expect(ok.samples).toHaveLength(4);
    expect(ok.samples.every((k) => k >= 150 && k < input.candles.length)).toBe(true);

    // Curang: mengingat semua candle yang pernah dilihat dan memakai close candle BERIKUTNYA bila sudah diketahui.
    const memory = new Map();
    const cheat = (args) => {
      for (const c of args.candles) memory.set(c.openTime, c.close);
      const ev = fakeEvaluate(args);
      const last = args.candles.at(-1);
      const future = memory.get(last.openTime + MS);
      if (future !== undefined) ev.score = { ...ev.score, total: future > last.close ? 99 : 1 };
      return ev;
    };
    const err = await assertNoLookahead({ ...input, ...fakeEngine, evaluate: cheat, samples: 4, seed: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(LookaheadError);
    expect(err.message).toMatch(/Look-ahead/);
    expect(err.details).toMatchObject({ index: expect.any(Number), path: '$.score.total' });
    expect(() => firstDifference({ a: [1, 2] }, { a: [1, 3] })).not.toThrow();
    expect(firstDifference({ a: [1, 2] }, { a: [1, 3] })).toEqual({ path: '$.a[1]', replay: 2, prefix: 3 });
    expect(firstDifference({ a: 1 }, { a: 1 })).toBeNull();
    await expect(assertNoLookahead({ ...input, ...fakeEngine, samples: 0 })).rejects.toThrow(RangeError);
  });

  it('UNIT-RRV-026 data rusak → DATA_QUALITY tanpa crash; uptrend lanjut & downtrend lanjut → 0 kandidat (mesin palsu)', async () => {
    const broken = await withFake({ symbol: 'brokenData-21', timeframe: '15m', candles: brokenData(21), higher: {} });
    expect(broken.classifications.DATA_QUALITY).toBeGreaterThan(0);
    expect(broken.evaluations).toBe(broken.bars - 150);
    const up = await withFake({ symbol: 'uptrendContinuation-21', timeframe: '15m', candles: uptrendContinuation(21), higher: {} });
    expect(up.candidates).toHaveLength(0);
    expect(up.classifications.CONTINUATION).toBe(up.evaluations);
    const down = await withFake({ symbol: 'continuedDowntrend-21', timeframe: '15m', candles: continuedDowntrend(21), higher: {} });
    expect(down.candidates).toHaveLength(0);
    expect(down.old.firstSignalIndex).toBeNull();
  });

  it('UNIT-RRV-027 mesin lama: mode fast & full memberi indeks sinyal pertama yang sama pada reversal sukses', async () => {
    const u = universeOf([21], '15m', ['successfulReversal']);
    const fast = await withFake(seriesOf(u, SYMBOL, '15m'), { oldMode: 'fast' });
    const full = await withFake(seriesOf(u, SYMBOL, '15m'), { oldMode: 'full' });
    expect(fast.old.firstSignalIndex).not.toBeNull();
    expect(full.old.firstSignalIndex).toBe(fast.old.firstSignalIndex);
    expect(full.old.mode).toBe('full');
    expect(fast.candidates.map((c) => c.firstDetectedIndex)).toEqual(full.candidates.map((c) => c.firstDetectedIndex));
    // Lead positif = Reversal Radar (palsu) membuka kandidat sebelum sinyal SA/PVA pertama.
    expect(fast.candidates.some((c) => c.leadVsOld > 0)).toBe(true);
  });

  it('UNIT-RRV-028 anomali kontrak state machine dicatat tanpa kehilangan kandidat', async () => {
    const candles = candlesFromRows(handRows(Array(8).fill(flat)));
    const indexOf = (c) => Math.round((c.openTime - SYNTHETIC_START) / MS);
    const evaluate = () => ({ classification: 'NO_SETUP', stage: null, levels: { atr: 1, invalidation: 97 }, score: { total: 0 }, evidence: [], evidenceCount: 0, risks: [] });
    const transition = (prev, { candle }) => {
      const i = indexOf(candle);
      if (i >= 3 && i < 6) return { next: { status: 'NEW', stage: 'EARLY_FORMATION', levels: { atr: 1, invalidation: 97, trigger: 101 }, firstDetectedPrice: 100, firstDetectedAtr: 1, risks: [] }, events: [] };
      if (i === 6) return { next: { status: 'CANCELLED', stage: 'EARLY_FORMATION', closeReason: 'CLOSE_BELOW_INVALIDATION', levels: {} }, events: [] };
      return { next: { status: 'NONE', stage: null }, events: [] };
    };
    const r = await replayReversalSeries({ symbol: 'HANDUSDT', timeframe: '15m', candles, evaluate, transition, resolveParams: (p) => p, warmupBars: 1, oldScanner: false, horizonBars: 4 });
    expect(r.anomalies).toMatchObject({ openWithoutEvent: 1, terminalWithoutEvent: 1 });
    expect(r.candidates).toHaveLength(1);
    // Label harga (TIMEOUT di candle 7) terpisah dari penutupan kandidat oleh state machine (CANCELLED di candle 6).
    expect(r.candidates[0]).toMatchObject({ firstDetectedIndex: 3, closeIndex: 6, status: 'CANCELLED', closeReason: 'CLOSE_BELOW_INVALIDATION', outcome: 'TIMEOUT', exitIndex: 7 });
    await expect(replayReversalSeries({ symbol: 'X', timeframe: '15m', candles, evaluate, transition: () => null, warmupBars: 1, oldScanner: false })).rejects.toThrow(TypeError);
  });

  it('UNIT-RRV-029 validasi argumen & giliran event loop', async () => {
    const candles = candlesFromRows(handRows(Array(4).fill(flat)));
    const base = { symbol: 'HANDUSDT', timeframe: '15m', candles, ...scripted(), oldScanner: false, warmupBars: 1 };
    await expect(replayReversalSeries({ ...base, timeframe: '4h' })).rejects.toThrow(RangeError);
    await expect(replayReversalSeries({ ...base, candles: [candles[1], candles[0]] })).rejects.toThrow(RangeError);
    await expect(replayReversalSeries({ ...base, candles: [] })).rejects.toThrow(TypeError);
    await expect(replayReversalSeries({ ...base, evaluate: null })).rejects.toThrow(TypeError);
    await expect(replayReversalSeries({ ...base, horizonBars: 0 })).rejects.toThrow(RangeError);
    await expect(replayReversalSeries({ ...base, targetAtr: 0 })).rejects.toThrow(RangeError);
    await expect(replayReversalSeries({ ...base, symbol: '' })).rejects.toThrow(TypeError);
    let yields = 0;
    const r = await replayReversalSeries({ ...base, yieldEvery: 2, yieldToEventLoop: async () => { yields += 1; } });
    expect(r.evaluations).toBe(7);
    expect(yields).toBe(3);
    // Warm-up = max(warmupBars, requiredCandles).
    const w = await replayReversalSeries({ ...base, warmupBars: 1, requiredCandles: 4 });
    expect(w.warmup).toBe(4);
    expect(w.evaluations).toBe(4);
  });

  it('UNIT-RRV-030 replayReversalUniverse: semua seri × timeframe, metadata describe, progres', async () => {
    const u = { ...universeOf([21], '15m', ['successfulReversal', 'uptrendContinuation']) };
    const progress = [];
    const res = await replayReversalUniverse({
      candles: u, timeframes: ['15m', '1h'], ...fakeEngine, oldScanner: false,
      describe: (symbol) => ({ scenario: symbol.split('-')[0], seed: Number(symbol.split('-')[1]) }),
      onProgress: (p) => progress.push(p),
    });
    // '1h' hanya ada sebagai HTF agregasi (87 candle < warm-up) → tetap di-replay tanpa kandidat; '5m' tidak ada.
    expect(res.series.map((s) => `${s.scenario}-${s.seed}@${s.timeframe}`).sort()).toEqual([
      'successfulReversal-21@15m', 'successfulReversal-21@1h', 'uptrendContinuation-21@15m', 'uptrendContinuation-21@1h',
    ]);
    expect(res.evaluations).toBe(res.series.reduce((a, s) => a + s.evaluations, 0));
    expect(progress).toHaveLength(4);
    expect(progress[0]).toMatchObject({ symbol: expect.any(String), timeframe: expect.any(String), evaluations: expect.any(Number) });
    expect(res.series.find((s) => s.timeframe === '1h').evaluations).toBe(0);
    await expect(replayReversalUniverse({ candles: null })).rejects.toThrow(TypeError);
    expect(successfulReversal(21)).toHaveLength(u[SYMBOL]['15m'].length);
  });
});
