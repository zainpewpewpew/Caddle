import { describe, expect, it } from 'vitest';
import { EVIDENCE_GROUPS, EVIDENCE_GROUP_MAX, REVERSAL_VERSION, RISKS } from '../../../backend/reversal/constants.js';
import { transitionReversal } from '../../../backend/reversal/stateMachine.js';

// Data uji deterministik — sintetis, bukan data pasar nyata. Evaluasi dibuat tangan (bentuk §3 minimal yang dipakai
// state machine) agar perilaku transisi diuji terpisah dari detektor.
const T0 = Date.UTC(2026, 0, 5, 10, 0);
const MS = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000 };

function candle(i, close, { tf = '15m', high = close + 0.2, low = close - 0.2, isClosed = true } = {}) {
  return {
    symbol: 'SYNUSDT', timeframe: tf, openTime: T0 + i * MS[tf], closeTime: T0 + (i + 1) * MS[tf] - 1,
    open: close, high, low, close, volume: 100, quoteVolume: 100 * close, trades: 10, takerBuyVolume: 50, takerBuyQuoteVolume: 50 * close,
    isClosed, source: 'rest',
  };
}

const DEFAULT_LEVELS = Object.freeze({ bottom: 95, lastSwingLow: 96, higherLow: null, trigger: 104, ema25: 100, ema7: 100, atr: 1, invalidation: 94.75 });

function evaluation(i, { tf = '15m', stage = null, classification = 'REVERSAL_CANDIDATE', levels = {}, risks = [], score = 30, evidence = ['LL_STOPPED', 'ATR_CONTRACTION'], setupType = 'COMPRESSION', setupTypes = ['COMPRESSION'], invalidationBase, provisional = false, version = REVERSAL_VERSION } = {}) {
  const lv = { ...DEFAULT_LEVELS, ...levels };
  return {
    version, timeframe: tf, provisional, candleOpenTime: T0 + i * MS[tf], evaluatedAt: T0 + (i + 1) * MS[tf] - 1,
    classification, stage, setupType, setupTypes,
    context: { priorDecline: { ok: true }, htf: { timeframe: '1h', trend: 'NEUTRAL', detail: '' }, liquidityClass: 'LIQUID' },
    checks: [], evidence: evidence.map((id) => ({ id, group: 'EXHAUSTION', label: id, detail: '', passed: true, value: 1, threshold: 0, weight: 5, index: i, time: null, price: null })),
    evidenceCount: evidence.length,
    score: { total: score, components: EVIDENCE_GROUPS.map((g) => ({ id: g, label: g, points: g === 'EXHAUSTION' ? score : 0, max: EVIDENCE_GROUP_MAX[g] })) },
    levels: lv,
    nextConfirmation: { kind: 'NONE', text: '', level: null },
    cancelCondition: { text: `Close di bawah ${lv.invalidation}`, level: lv.invalidation },
    risks, markers: [],
    measures: { invalidationBase: invalidationBase === undefined ? lv.invalidation : invalidationBase },
  };
}

/** Input transisi: candle i dengan close & evaluasi pada candle yang sama. */
function step(i, close, evalOpts = {}, candleOpts = {}) {
  const tf = evalOpts.tf ?? '15m';
  return { candle: candle(i, close, { tf, ...candleOpts }), evaluation: evaluation(i, { tf, ...evalOpts }), timeframe: tf };
}

function run(steps, params, start = null) {
  let snap = start;
  const out = [];
  for (const s of steps) {
    const r = transitionReversal(snap, s, params);
    out.push(r);
    snap = r.next;
  }
  const events = out.flatMap((r) => r.events);
  return { snap, out, events, alerts: out.filter((r) => r.alert).map((r) => `${r.events[0]?.type}:${r.next.stage}`) };
}

const SNAPSHOT_KEYS = [
  'version', 'timeframe', 'stage', 'status', 'classification', 'setupType', 'setupTypes', 'score', 'scoreComponents', 'evidence', 'evidenceCount',
  'levels', 'nextConfirmation', 'cancelCondition', 'risks', 'liquidityClass', 'markers', 'firstDetectedAt', 'firstDetectedPrice', 'firstDetectedAtr',
  'firstStage', 'stageEnteredAt', 'barsInStage', 'barsSinceDetection', 'lastCandleTime', 'lastEvaluatedAt', 'peakPrice', 'peakStage',
  'moveSinceDetectionPct', 'moveSinceDetectionAtr', 'extended', 'pendingStage', 'pendingBars', 'weakBars', 'closeReason',
];

describe('state machine Reversal Radar', () => {
  it('UNIT-RR-SM-001 tanpa tahap → snapshot NONE tanpa event; bentuk snapshot lengkap & dapat di-JSON', () => {
    const r = transitionReversal(null, step(0, 100));
    expect(r.events).toEqual([]);
    expect(r.alert).toBe(false);
    expect(r.next).toMatchObject({ version: 1, timeframe: '15m', stage: null, status: 'NONE', firstDetectedAt: null, pendingStage: null, pendingBars: 0, weakBars: 0, lastCandleTime: T0 });
    expect(Object.keys(r.next).sort()).toEqual([...SNAPSHOT_KEYS].sort());
    expect(JSON.parse(JSON.stringify(r.next))).toEqual(r.next);
    // Klasifikasi bukan kandidat juga NONE.
    expect(transitionReversal(null, step(0, 100, { classification: 'CONTINUATION' })).next.status).toBe('NONE');
  });

  it('UNIT-RR-SM-002 15m: tahap pada satu candle tutup membuka kandidat (OPENED, status NEW, alert)', () => {
    const r = transitionReversal(null, step(3, 100, { stage: 'EARLY_FORMATION', risks: ['HTF_UNKNOWN', 'LATE_ENTRY'] }));
    expect(r.alert).toBe(true);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      type: 'OPENED', fromStage: null, toStage: 'EARLY_FORMATION', fromStatus: 'NONE', toStatus: 'NEW', reason: 'STAGE_EVIDENCE', provisional: false,
      candleTime: T0 + 3 * MS['15m'], occurredAt: T0 + 4 * MS['15m'] - 1, price: 100,
    });
    expect(r.events[0].detail).toMatchObject({ score: 30, evidence: ['LL_STOPPED', 'ATR_CONTRACTION'], levels: DEFAULT_LEVELS, pendingBars: 1 });
    expect(typeof r.events[0].detail.reason).toBe('string');
    expect(r.next).toMatchObject({
      stage: 'EARLY_FORMATION', status: 'NEW', firstStage: 'EARLY_FORMATION', firstDetectedAt: T0 + 4 * MS['15m'] - 1, firstDetectedPrice: 100, firstDetectedAtr: 1,
      stageEnteredAt: T0 + 4 * MS['15m'] - 1, barsInStage: 0, barsSinceDetection: 0, peakPrice: 100, peakStage: 'EARLY_FORMATION',
      moveSinceDetectionPct: 0, moveSinceDetectionAtr: 0, extended: false, risks: ['HTF_UNKNOWN', 'LATE_ENTRY'], setupType: 'COMPRESSION', score: 30, evidence: ['LL_STOPPED', 'ATR_CONTRACTION'],
    });
    expect(Object.keys(r.next).sort()).toEqual([...SNAPSHOT_KEYS].sort());
  });

  it('UNIT-RR-SM-003 5m: histeresis enterConfirmBars 2 — candle pertama pending, kedua membuka; gap mengulang hitungan', () => {
    const first = transitionReversal(null, step(0, 100, { tf: '5m', stage: 'EARLY_FORMATION' }));
    expect(first.events).toEqual([]);
    expect(first.next).toMatchObject({ status: 'NONE', pendingStage: 'EARLY_FORMATION', pendingBars: 1 });
    const second = transitionReversal(first.next, step(1, 100.1, { tf: '5m', stage: 'DEVELOPING_REVERSAL' }));
    expect(second.events[0]).toMatchObject({ type: 'OPENED', toStage: 'DEVELOPING_REVERSAL', toStatus: 'DEVELOPING', detail: { pendingBars: 2 } });
    expect(second.alert).toBe(true);
    // Tahap hilang di tengah → hitungan ulang.
    const broken = run([step(0, 100, { tf: '5m', stage: 'EARLY_FORMATION' }), step(1, 100, { tf: '5m' }), step(2, 100, { tf: '5m', stage: 'EARLY_FORMATION' })]);
    expect(broken.events).toEqual([]);
    expect(broken.snap).toMatchObject({ status: 'NONE', pendingBars: 1 });
    // Gap data (candle 0 lalu candle 3) → bukan berurutan.
    const gapped = run([step(0, 100, { tf: '5m', stage: 'EARLY_FORMATION' }), step(3, 100, { tf: '5m', stage: 'EARLY_FORMATION' })]);
    expect(gapped.events).toEqual([]);
    expect(gapped.snap.pendingBars).toBe(1);
  });

  it('EDGE-RR-SM-001 close ≤ invalidasi tidak membuka kandidat; invalidasi null tetap boleh membuka', () => {
    expect(transitionReversal(null, step(0, 94.75, { stage: 'EARLY_FORMATION' })).next.status).toBe('NONE');
    expect(transitionReversal(null, step(0, 94.76, { stage: 'EARLY_FORMATION' })).next.status).toBe('NEW');
    expect(transitionReversal(null, step(0, 50, { stage: 'EARLY_FORMATION', levels: { invalidation: null }, invalidationBase: null })).next.status).toBe('NEW');
  });

  it('POS-RR-SM-001 naik tahap EARLY → DEVELOPING → CONFIRMED tanpa downgrade; alert sekali per tahap', () => {
    const { out, events, alerts, snap } = run([
      step(0, 100, { stage: 'EARLY_FORMATION' }),
      step(1, 100.5, { stage: 'EARLY_FORMATION' }),
      step(2, 101, { stage: 'DEVELOPING_REVERSAL' }),
      step(3, 100.8, { stage: null }), // bukti melemah sesaat → tetap DEVELOPING
      step(4, 104.5, { stage: 'CONFIRMED_BREAKOUT', levels: { invalidation: 103.25 }, invalidationBase: 94.75, evidence: ['LL_STOPPED', 'HIGHER_LOW', 'TRIGGER_BREAK', 'BREAK_VOLUME_SUPPORT'] }),
      step(5, 104.2, { stage: 'DEVELOPING_REVERSAL' }), // evaluasi turun → snapshot tidak turun
      step(6, 104.9, { stage: 'CONFIRMED_BREAKOUT' }), // tahap sama → tanpa event/alert
    ]);
    expect(events.map((e) => [e.type, e.fromStage, e.toStage, e.fromStatus, e.toStatus])).toEqual([
      ['OPENED', null, 'EARLY_FORMATION', 'NONE', 'NEW'],
      ['STAGE_UP', 'EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'NEW', 'DEVELOPING'],
      ['STAGE_UP', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT', 'DEVELOPING', 'CONFIRMED'],
    ]);
    expect(alerts).toEqual(['OPENED:EARLY_FORMATION', 'STAGE_UP:DEVELOPING_REVERSAL', 'STAGE_UP:CONFIRMED_BREAKOUT']);
    expect(out.map((r) => r.next.barsInStage)).toEqual([0, 1, 0, 1, 0, 1, 2]);
    expect(out[3].next).toMatchObject({ stage: 'DEVELOPING_REVERSAL', weakBars: 1 });
    expect(out[4].next.weakBars).toBe(0);
    expect(events[2].detail).toMatchObject({ barsInPrevStage: 2, pendingBars: 1, evidence: ['LL_STOPPED', 'HIGHER_LOW', 'TRIGGER_BREAK', 'BREAK_VOLUME_SUPPORT'] });
    expect(snap).toMatchObject({ stage: 'CONFIRMED_BREAKOUT', status: 'CONFIRMED', peakStage: 'CONFIRMED_BREAKOUT', firstStage: 'EARLY_FORMATION', barsSinceDetection: 6, stageEnteredAt: T0 + 5 * MS['15m'] - 1 });
    expect(snap.nextConfirmation.kind).toBe('HOLD_ABOVE_TRIGGER');
  });

  it('UNIT-RR-SM-004 5m: naik tahap butuh 2 candle berurutan dengan tahap lebih tinggi (pendingStage/pendingBars)', () => {
    const { out, events } = run([
      step(0, 100, { tf: '5m', stage: 'EARLY_FORMATION' }), step(1, 100, { tf: '5m', stage: 'EARLY_FORMATION' }), // OPENED
      step(2, 100.5, { tf: '5m', stage: 'DEVELOPING_REVERSAL' }), // pending 1
      step(3, 100.4, { tf: '5m', stage: 'EARLY_FORMATION' }), // putus
      step(4, 100.6, { tf: '5m', stage: 'DEVELOPING_REVERSAL' }), // pending 1
      step(5, 100.7, { tf: '5m', stage: 'CONFIRMED_BREAKOUT' }), // pending 2 → naik ke tahap evaluasi terakhir
    ]);
    expect(out[2].next).toMatchObject({ stage: 'EARLY_FORMATION', pendingStage: 'DEVELOPING_REVERSAL', pendingBars: 1 });
    expect(out[3].next).toMatchObject({ stage: 'EARLY_FORMATION', pendingStage: null, pendingBars: 0 });
    expect(out[4].next.pendingBars).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['OPENED', 'STAGE_UP']);
    expect(events[1]).toMatchObject({ toStage: 'CONFIRMED_BREAKOUT', detail: { pendingBars: 2 } });
    expect(out[5].next).toMatchObject({ stage: 'CONFIRMED_BREAKOUT', pendingStage: null, pendingBars: 0 });
  });

  it('UNIT-RR-SM-005 masuk CONFIRMED membekukan trigger dan menaikkan invalidasi ke trigger − 0,75 ATR; invalidasi tidak mengejar high baru', () => {
    const { out } = run([
      step(0, 100, { stage: 'DEVELOPING_REVERSAL' }),
      step(1, 105, { stage: 'CONFIRMED_BREAKOUT', levels: { trigger: 104, invalidation: 103.25 }, invalidationBase: 94.75 }),
      step(2, 107, { stage: 'CONFIRMED_BREAKOUT', levels: { trigger: 106.5, invalidation: 105.75 }, invalidationBase: 94.75 }),
      step(3, 106, { stage: 'DEVELOPING_REVERSAL', levels: { trigger: 107.2, invalidation: 94.75 }, invalidationBase: 94.75 }),
    ]);
    expect(out[1].next.levels).toMatchObject({ trigger: 104, invalidation: 103.25 });
    expect(out[1].next.cancelCondition.text).toContain('breakout gagal');
    expect(out[2].next.levels).toMatchObject({ trigger: 104, invalidation: 103.25 });
    expect(out[3].next).toMatchObject({ stage: 'CONFIRMED_BREAKOUT', status: 'CONFIRMED' });
    expect(out[3].next.levels).toMatchObject({ trigger: 104, invalidation: 103.25 });
  });

  it('POS-RR-SM-002 CANCELLED hanya bila close < invalidasi (wick tidak membatalkan); alert hanya dari tahap ≥ DEVELOPING; kandidat berikutnya baris baru', () => {
    const wick = run([step(0, 100, { stage: 'DEVELOPING_REVERSAL' }), step(1, 95, { stage: null }, { low: 90 })]);
    expect(wick.snap).toMatchObject({ status: 'DEVELOPING', stage: 'DEVELOPING_REVERSAL' });
    const cancelled = run([step(0, 100, { stage: 'DEVELOPING_REVERSAL' }), step(1, 94.7, { stage: null })]);
    expect(cancelled.events[1]).toMatchObject({ type: 'CANCELLED', fromStage: 'DEVELOPING_REVERSAL', toStage: 'DEVELOPING_REVERSAL', fromStatus: 'DEVELOPING', toStatus: 'CANCELLED', reason: 'CLOSE_BELOW_INVALIDATION', price: 94.7 });
    expect(cancelled.events[1].detail).toMatchObject({ invalidation: 94.75, barsInPrevStage: 1 });
    expect(cancelled.out[1].alert).toBe(true);
    expect(cancelled.snap).toMatchObject({ status: 'CANCELLED', closeReason: 'CLOSE_BELOW_INVALIDATION', stage: 'DEVELOPING_REVERSAL', pendingBars: 0 });
    // Dari EARLY tanpa alert.
    const early = run([step(0, 100, { stage: 'EARLY_FORMATION' }), step(1, 94.7)]);
    expect(early.snap.status).toBe('CANCELLED');
    expect(early.out[1].alert).toBe(false);
    // Tepat di level belum batal.
    expect(run([step(0, 100, { stage: 'EARLY_FORMATION' }), step(1, 94.75)]).snap.status).toBe('NEW');
    // Setelah terminal: candle berikutnya membuka kandidat BARU (firstDetected baru, pending tidak terbawa).
    const reopened = transitionReversal(cancelled.snap, step(2, 96, { stage: 'EARLY_FORMATION', levels: { invalidation: 93 } }));
    expect(reopened.events[0]).toMatchObject({ type: 'OPENED', fromStatus: 'NONE', toStatus: 'NEW' });
    expect(reopened.next).toMatchObject({ firstDetectedPrice: 96, barsSinceDetection: 0, levels: { invalidation: 93 } });
  });

  it('UNIT-RR-SM-006 BREAKOUT_FAILED: CONFIRMED batal dengan alasan breakout gagal bila close < trigger − 0,75 ATR', () => {
    const r = run([
      step(0, 105, { stage: 'CONFIRMED_BREAKOUT', levels: { trigger: 104, invalidation: 103.25 }, invalidationBase: 94.75 }),
      step(1, 103.2, { stage: null, levels: { trigger: 105, invalidation: 94.75 }, invalidationBase: 94.75 }),
    ]);
    expect(r.events[1]).toMatchObject({ type: 'CANCELLED', reason: 'BREAKOUT_FAILED', toStatus: 'CANCELLED' });
    expect(r.out[1].alert).toBe(true);
    expect(r.snap.closeReason).toBe('BREAKOUT_FAILED');
  });

  it('UNIT-RR-SM-007 EXPIRED NO_PROGRESS setelah expiryBars (tanpa alert) dan EVIDENCE_FADED setelah weakBarsLimit candle tanpa tahap berurutan', () => {
    const params = { expiryBars: { EARLY_FORMATION: 3 }, weakBarsLimit: 2 };
    const noProgress = run([step(0, 100, { stage: 'EARLY_FORMATION' }), step(1, 100.1, { stage: 'EARLY_FORMATION' }), step(2, 100.2, { stage: 'EARLY_FORMATION' }), step(3, 100.1, { stage: 'EARLY_FORMATION' })], params);
    expect(noProgress.out.map((r) => r.next.status)).toEqual(['NEW', 'NEW', 'NEW', 'EXPIRED']);
    expect(noProgress.events.at(-1)).toMatchObject({ type: 'EXPIRED', reason: 'NO_PROGRESS', fromStatus: 'NEW', toStatus: 'EXPIRED' });
    expect(noProgress.alerts).toEqual(['OPENED:EARLY_FORMATION']);
    expect(noProgress.snap.closeReason).toBe('NO_PROGRESS');
    // Kemajuan (naik tahap) mengatur ulang hitungan.
    const progressed = run([step(0, 100, { stage: 'EARLY_FORMATION' }), step(1, 100, { stage: 'EARLY_FORMATION' }), step(2, 100, { stage: 'DEVELOPING_REVERSAL' }), step(3, 100, { stage: 'DEVELOPING_REVERSAL' })], params);
    expect(progressed.snap).toMatchObject({ status: 'DEVELOPING', barsInStage: 1 });
    // Bukti melemah: stage null berturut-turut (termasuk evaluasi bukan kandidat).
    const faded = run([step(0, 100, { stage: 'EARLY_FORMATION' }), step(1, 100, { stage: null }), step(2, 100, { stage: null, classification: 'DATA_QUALITY', levels: { bottom: null, atr: null, invalidation: null }, invalidationBase: null })], params);
    expect(faded.out.map((r) => r.next.weakBars)).toEqual([0, 1, 2]);
    expect(faded.snap).toMatchObject({ status: 'EXPIRED', closeReason: 'EVIDENCE_FADED' });
    expect(faded.out[2].alert).toBe(false);
    // Tahap kembali → weakBars kembali 0.
    const recovered = run([step(0, 100, { stage: 'EARLY_FORMATION' }), step(1, 100, { stage: null }), step(2, 100, { stage: 'EARLY_FORMATION' })], params);
    expect(recovered.snap.weakBars).toBe(0);
  });

  it('UNIT-RR-SM-008 extended & peak: moveSinceDetection ≥ 2,5 ATR atau ≥ 8 % → extended + risiko EXTENDED; peakPrice = high tertinggi', () => {
    const { out } = run([
      step(0, 100, { stage: 'EARLY_FORMATION' }),
      step(1, 101, { stage: 'EARLY_FORMATION' }, { high: 103 }),
      step(2, 102.6, { stage: 'EARLY_FORMATION' }),
      step(3, 101, { stage: 'EARLY_FORMATION' }),
    ]);
    expect(out[1].next).toMatchObject({ extended: false, peakPrice: 103, moveSinceDetectionAtr: 1 });
    expect(out[1].next.moveSinceDetectionPct).toBeCloseTo(0.01, 12);
    expect(out[1].next.risks).not.toContain('EXTENDED');
    expect(out[2].next).toMatchObject({ extended: true, peakPrice: 103 });
    expect(out[2].next.moveSinceDetectionAtr).toBeCloseTo(2.6, 9);
    expect(out[2].next.risks).toContain('EXTENDED');
    expect(out[3].next.extended).toBe(false);
    // Persen: ATR besar tetapi kenaikan 8 %.
    const pct = run([step(0, 100, { stage: 'EARLY_FORMATION', levels: { atr: 10 } }), step(1, 108, { stage: 'EARLY_FORMATION', levels: { atr: 10 } })]);
    expect(pct.snap).toMatchObject({ extended: true, moveSinceDetectionAtr: 0.8 });
  });

  it('UNIT-RR-SM-009 invalidasi hanya naik (dari invalidationBase evaluasi, tetap < close); LATE_ENTRY dibawa dari pembukaan; NEAR_INVALIDATION dihitung ulang', () => {
    const { out } = run([
      step(0, 100, { stage: 'EARLY_FORMATION', risks: ['LATE_ENTRY'] }),
      step(1, 100.2, { stage: 'EARLY_FORMATION', levels: { invalidation: 96 }, invalidationBase: 96 }),
      step(2, 100.4, { stage: 'EARLY_FORMATION', levels: { invalidation: 95 }, invalidationBase: 95 }),
      step(3, 96.3, { stage: 'EARLY_FORMATION', levels: { invalidation: 99 }, invalidationBase: 99 }), // ≥ close → diabaikan
      step(4, 96.3, { stage: null, risks: ['LATE_ENTRY', 'NEAR_INVALIDATION'] }),
    ]);
    expect(out.map((r) => r.next.levels.invalidation)).toEqual([94.75, 96, 96, 96, 96]);
    expect(out.map((r) => r.next.risks.includes('LATE_ENTRY'))).toEqual([true, true, true, true, true]);
    expect(out[2].next.risks).not.toContain('NEAR_INVALIDATION');
    expect(out[3].next.risks).toContain('NEAR_INVALIDATION'); // 96,3 − 96 ≤ 0,5 ATR
    expect(out[3].next.cancelCondition.level).toBe(96);
    expect(out[4].next.levels.invalidation).toBe(96);
    // Evaluasi yang tidak membawa LATE_ENTRY saat buka → tidak pernah ditambahkan belakangan.
    const noLate = run([step(0, 100, { stage: 'EARLY_FORMATION' }), step(1, 100, { stage: 'EARLY_FORMATION', risks: ['LATE_ENTRY'] })]);
    expect(noLate.snap.risks).not.toContain('LATE_ENTRY');
    expect(noLate.snap.risks).toEqual(RISKS.filter((r) => noLate.snap.risks.includes(r)));
  });

  it('EDGE-RR-SM-002 candle lama/duplikat diabaikan (idempoten, objek snapshot yang sama), juga setelah terminal', () => {
    const a = transitionReversal(null, step(0, 100, { stage: 'EARLY_FORMATION' }));
    const b = transitionReversal(a.next, step(3, 100.4, { stage: 'EARLY_FORMATION' }));
    for (const stale of [step(3, 90), step(2, 50), step(0, 100, { stage: 'CONFIRMED_BREAKOUT' })]) {
      const r = transitionReversal(b.next, stale);
      expect(r).toEqual({ next: b.next, events: [], alert: false });
      expect(r.next).toBe(b.next);
    }
    const dead = transitionReversal(b.next, step(4, 90)).next;
    expect(dead.status).toBe('CANCELLED');
    expect(transitionReversal(dead, step(4, 100, { stage: 'EARLY_FORMATION' })).events).toEqual([]);
    expect(transitionReversal(dead, step(5, 100, { stage: 'EARLY_FORMATION' })).events[0].type).toBe('OPENED');
  });

  it('EDGE-RR-SM-003 gap data: barsElapsed dari selisih waktu, detail.gapBars; jatuh tempo di dalam gap → EXPIRED lebih dulu', () => {
    const opened = transitionReversal(null, step(0, 100, { stage: 'EARLY_FORMATION' }));
    const after = transitionReversal(opened.next, step(5, 100.5, { stage: 'DEVELOPING_REVERSAL' }));
    expect(after.next.barsInStage).toBe(0);
    expect(after.next.barsSinceDetection).toBe(5);
    expect(after.events[0]).toMatchObject({ type: 'STAGE_UP', detail: { gapBars: 4, barsInPrevStage: 5 } });
    expect(transitionReversal(opened.next, step(1, 100.5, { stage: 'DEVELOPING_REVERSAL' })).events[0].detail).not.toHaveProperty('gapBars');
    // Gap 100 candle setelah EARLY (expiry 48) → kedaluwarsa, bukan promosi/alert dari konteks basi.
    const expired = transitionReversal(opened.next, step(100, 110, { stage: 'CONFIRMED_BREAKOUT' }));
    expect(expired.events[0]).toMatchObject({ type: 'EXPIRED', reason: 'NO_PROGRESS', detail: { gapBars: 99 } });
    expect(expired.alert).toBe(false);
    // Jatuh tempo tepat di candle pasca-gap (48 bar) masih dinilai.
    const onTime = transitionReversal(opened.next, step(48, 110, { stage: 'DEVELOPING_REVERSAL' }));
    expect(onTime.events[0]).toMatchObject({ type: 'STAGE_UP', detail: { gapBars: 47 } });
  });

  it('UNIT-RR-SM-010 tidak ada alert berulang untuk tahap yang sama; snapshot diperbarui tanpa event', () => {
    const steps = [step(0, 100, { stage: 'DEVELOPING_REVERSAL' })];
    for (let i = 1; i <= 30; i += 1) steps.push(step(i, 100 + (i % 3) * 0.1, { stage: 'DEVELOPING_REVERSAL', score: 40 + (i % 5) }));
    const { out, alerts, events, snap } = run(steps);
    expect(alerts).toEqual(['OPENED:DEVELOPING_REVERSAL']);
    expect(events).toHaveLength(1);
    expect(out.slice(1).every((r) => r.events.length === 0 && r.alert === false)).toBe(true);
    expect(snap).toMatchObject({ barsInStage: 30, score: 40, status: 'DEVELOPING' });
  });

  it('NEG-RR-SM-001 validasi input ketat', () => {
    const ok = step(0, 100, { stage: 'EARLY_FORMATION' });
    expect(() => transitionReversal(null, { ...ok, timeframe: '4h' })).toThrow(RangeError);
    expect(() => transitionReversal(null, { ...ok, candle: candle(0, 100, { isClosed: false }) })).toThrow(RangeError);
    expect(() => transitionReversal(null, { ...ok, candle: { ...ok.candle, close: 0 } })).toThrow(RangeError);
    expect(() => transitionReversal(null, { ...ok, candle: { ...ok.candle, high: 'x' } })).toThrow(TypeError);
    expect(() => transitionReversal(null, { ...ok, evaluation: evaluation(0, { provisional: true }) })).toThrow(RangeError);
    expect(() => transitionReversal(null, { ...ok, evaluation: evaluation(1) })).toThrow(RangeError); // candleOpenTime ≠ candle
    expect(() => transitionReversal(null, { ...ok, evaluation: evaluation(0, { version: 2 }) })).toThrow(RangeError);
    expect(() => transitionReversal(null, { ...ok, evaluation: evaluation(0, { stage: 'FOO' }) })).toThrow(RangeError);
    expect(() => transitionReversal(null, { ...ok, evaluation: evaluation(0, { risks: ['BOGUS'] }) })).toThrow(RangeError);
    expect(() => transitionReversal(null, { ...ok, evaluation: null })).toThrow(TypeError);
    expect(() => transitionReversal(null, ok, { bogus: 1 })).toThrow(TypeError);
    expect(() => transitionReversal(null, ok, { weakBarsLimit: 0 })).toThrow(RangeError);
    expect(() => transitionReversal({ status: 'WEIRD', lastCandleTime: 0 }, ok)).toThrow(RangeError);
    expect(() => transitionReversal({ status: 'NEW', stage: 'EARLY_FORMATION', lastCandleTime: 0, firstDetectedPrice: 0 }, ok)).toThrow(TypeError);
    expect(() => transitionReversal({ ...transitionReversal(null, ok).next, timeframe: '5m' }, step(1, 100))).toThrow(RangeError);
  });
});
