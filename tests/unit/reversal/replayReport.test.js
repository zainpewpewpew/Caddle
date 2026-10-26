// Agregasi & laporan replay Reversal Radar (backend/reversal/replayReport.js): sensitivitas, rasio dengan jumlah
// sampel & CI Wilson, kuantil, target §10, peringatan kejujuran, render Markdown & ringkasan stdout.
// Objek contoh berbentuk hasil replayReversalSeries — angka fiktif, hanya untuk menguji agregasi/render.
import { describe, expect, it } from 'vitest';
import { wilsonInterval } from '../../../backend/backtest/metrics.js';
import { SENSITIVITY_FILTERS } from '../../../backend/reversal/constants.js';
import { replayReversalUniverse } from '../../../backend/reversal/replay.js';
import {
  DEFAULT_FALSE_POSITIVE_SCENARIOS, SUCCESS_DEFINITION, TARGET_RULES, aggregateReplay, checkTargets, collectReplayWarnings, fmtRate,
  passesSensitivity, quantiles, rate, renderReplayReport, renderReplaySummary, summarizeCandidates,
} from '../../../backend/reversal/replayReport.js';
import { scenarioCatalog, scenarioUniverse } from '../../fixtures/candles/reversalScenarios.js';
import { fakeEngine } from '../../helpers/fakeReversalEngine.js';

const cand = (over = {}) => ({
  firstDetectedIndex: 200, firstStage: 'EARLY_FORMATION', firstScore: 50, firstEvidenceCount: 3, status: 'EXPIRED', closeIndex: 230,
  stages: [{ stage: 'EARLY_FORMATION', index: 200 }], outcome: 'SUCCESS', mfeAtr: 2, maeAtr: -0.5, mfePct: 0.02, maePct: -0.005,
  leadVsOld: 10, leadVsOldAlert: 12, leadVsBreakout: 5, barsToTrigger: 4, barsToConfirmed: null, lateEntry: false, extendedAtDetection: false, ...over,
});
const series = (over = {}) => ({
  symbol: 'S', timeframe: '15m', scenario: 'successfulReversal', seed: 21, evaluations: 220, horizonBars: 48, targetAtr: 2, candidates: [],
  old: { enabled: true, mode: 'fast', evaluations: 220, signals: 1, alerts: 1, firstSignalIndex: 210, firstAlertIndex: 212 },
  classifications: { REVERSAL_CANDIDATE: 100, NO_SETUP: 120 }, anomalies: { openWithoutEvent: 0 }, ...over,
});

function sample() {
  return [
    series({ symbol: 'A', candidates: [cand(), cand({ firstDetectedIndex: 260, firstScore: 70, firstEvidenceCount: 5, status: 'CANCELLED', outcome: 'FAIL', mfeAtr: 0.3, maeAtr: -1.2, mfePct: 0.003, maePct: -0.012, leadVsOld: -50, leadVsBreakout: null, stages: [{ stage: 'EARLY_FORMATION', index: 260 }, { stage: 'CONFIRMED_BREAKOUT', index: 270 }], barsToConfirmed: 10 })] }),
    series({ symbol: 'B', seed: 22, candidates: [cand({ firstScore: 30, firstEvidenceCount: 2, outcome: 'TIMEOUT', mfeAtr: 1, maeAtr: -0.8, leadVsOld: 4 })], old: { enabled: true, mode: 'fast', evaluations: 220, signals: 0, alerts: 0, firstSignalIndex: null, firstAlertIndex: null } }),
    series({ symbol: 'C', seed: 23, scenario: 'uptrendContinuation', candidates: [] }),
    ...[1, 2, 3, 4].map((k) => series({ symbol: `D${k}`, seed: 30 + k, scenario: 'continuedDowntrend', candidates: k === 1 ? [cand({ outcome: null, labelError: 'NO_INVALIDATION', lateEntry: true, extendedAtDetection: true })] : [] })),
    series({ symbol: 'E', seed: 24, timeframe: '1h', scenario: 'successfulReversal', candidates: [cand({ outcome: 'OPEN', closeIndex: null })], old: { enabled: false, mode: null, evaluations: 0, signals: 0, alerts: 0, firstSignalIndex: null, firstAlertIndex: null } }),
  ];
}

describe('statistik dasar', () => {
  it('UNIT-RRV-040 quantiles, rate (Wilson), passesSensitivity', () => {
    expect(quantiles([])).toEqual({ n: 0, min: null, q1: null, median: null, q3: null, max: null });
    expect(quantiles([5, 1, 3, null, NaN, 4, 2])).toEqual({ n: 5, min: 1, q1: 2, median: 3, q3: 4, max: 5 });
    expect(quantiles([1, 2, 3, 4]).median).toBe(2.5);
    expect(rate(3, 10)).toEqual({ k: 3, n: 10, p: 0.3, ci: wilsonInterval(3, 10) });
    expect(rate(0, 0)).toEqual({ k: 0, n: 0, p: null, ci: null });
    expect(fmtRate(rate(1, 2))).toBe('1/2 = 50,0% (CI 9,5–90,5 %)');
    expect(fmtRate(rate(0, 0))).toBe('— (n = 0)');
    for (const s of ['LOW', 'MEDIUM', 'HIGH']) {
      const f = SENSITIVITY_FILTERS[s];
      expect(passesSensitivity({ firstScore: f.minScore, firstEvidenceCount: f.minEvidence }, s)).toBe(true);
      expect(passesSensitivity({ firstScore: f.minScore - 1, firstEvidenceCount: f.minEvidence }, s)).toBe(false);
      expect(passesSensitivity({ firstScore: f.minScore, firstEvidenceCount: f.minEvidence - 1 }, s)).toBe(false);
    }
    expect(passesSensitivity({}, 'HIGH')).toBe(true);
    expect(() => passesSensitivity({}, 'ULTRA')).toThrow(RangeError);
  });

  it('UNIT-RRV-041 summarizeCandidates: filter sensitivitas, rasio berlabel, kuantil, mesin lama', () => {
    const list = sample().filter((s) => s.scenario === 'successfulReversal' && s.timeframe === '15m');
    const medium = summarizeCandidates(list, 'MEDIUM');
    expect(medium).toMatchObject({ series: 2, candidates: 2, stillOpen: 0 });
    expect(medium.perSeries).toEqual({ mean: 1, max: 2 });
    expect(medium.seriesWithCandidate).toMatchObject({ k: 1, n: 2 });
    expect(medium.outcomes).toMatchObject({ labeled: 2, open: 0, unlabeled: 0, success: { k: 1, n: 2, p: 0.5 }, fail: { k: 1, n: 2 }, timeout: { k: 0, n: 2 } });
    expect(medium.cancelled).toMatchObject({ k: 1, n: 2 });
    expect(medium.expired).toMatchObject({ k: 1, n: 2 });
    expect(medium.reachedConfirmed).toMatchObject({ k: 1, n: 2 });
    expect(medium.leadVsOld).toMatchObject({ n: 2, median: -20 });
    expect(medium.leadVsOldFirst).toMatchObject({ n: 1, median: 10 });
    expect(medium.leadVsOldAlertFirst).toMatchObject({ n: 1, median: 12 });
    expect(medium.leadVsBreakout).toMatchObject({ n: 1, median: 5 });
    expect(medium.mfeAtr).toMatchObject({ n: 2, median: 1.15 });
    expect(medium.firstStage).toEqual({ EARLY_FORMATION: 2, DEVELOPING_REVERSAL: 0, CONFIRMED_BREAKOUT: 0 });
    expect(medium.old).toMatchObject({ enabled: true, seriesWithSignal: { k: 1, n: 2 }, signals: 1, alerts: 1, firstIndexMedian: 210 });
    expect(medium.firstIndexMedian).toBe(200);
    expect(medium.classifications).toEqual({ REVERSAL_CANDIDATE: 200, NO_SETUP: 240 });
    const low = summarizeCandidates(list, 'LOW');
    expect(low.candidates).toBe(1);
    expect(low.outcomes.fail).toMatchObject({ k: 1, n: 1, p: 1 });
    const high = summarizeCandidates(list, 'HIGH');
    expect(high.candidates).toBe(3);
    expect(high.outcomes.success).toMatchObject({ k: 1, n: 3 });
    expect(high.outcomes.timeout).toMatchObject({ k: 1, n: 3 });
    expect(summarizeCandidates([], 'HIGH')).toMatchObject({ series: 0, candidates: 0, perSeries: { mean: null, max: 0 }, outcomes: { success: { n: 0, p: null } } });
  });
});

describe('aggregateReplay', () => {
  it('UNIT-RRV-042 grup per timeframe × skenario × sensitivitas, false positive, perbandingan, target §10, peringatan', () => {
    const r = aggregateReplay({ series: sample(), meta: { source: 'synthetic', seedSet: 'mixed', generatedAt: Date.UTC(2026, 9, 26) }, scenarios: scenarioCatalog() });
    expect(r.meta).toMatchObject({ source: 'synthetic', timeframes: ['15m', '1h'], horizonBars: 48, targetAtr: 2, oldMode: 'fast', successDefinition: SUCCESS_DEFINITION });
    expect(r.meta.seeds).toEqual([21, 22, 23, 24, 31, 32, 33, 34]);
    expect(r.meta.falsePositiveScenarios).toEqual([...DEFAULT_FALSE_POSITIVE_SCENARIOS]);
    expect(r.totals).toEqual({ series: 8, evaluations: 8 * 220, oldEvaluations: 7 * 220, candidates: 5 });
    // Urutan: timeframe (5m, 15m, 1h) lalu urutan katalog skenario; tiap grup 3 sensitivitas.
    const keys = r.groups.map((g) => `${g.timeframe}|${g.scenario}|${g.sensitivity}`);
    expect(keys.slice(0, 3)).toEqual(['15m|successfulReversal|LOW', '15m|successfulReversal|MEDIUM', '15m|successfulReversal|HIGH']);
    expect(keys).toContain('1h|successfulReversal|MEDIUM');
    expect(keys.indexOf('15m|continuedDowntrend|LOW')).toBeLessThan(keys.indexOf('15m|uptrendContinuation|LOW'));
    expect(r.groups.find((g) => g.scenario === 'successfulReversal' && g.sensitivity === 'MEDIUM' && g.timeframe === '15m')).toMatchObject({ label: 'Reversal sukses', falsePositive: false, candidates: 2 });
    expect(r.byTimeframe.map((g) => `${g.timeframe}|${g.sensitivity}`)).toEqual(['15m|LOW', '15m|MEDIUM', '15m|HIGH', '1h|LOW', '1h|MEDIUM', '1h|HIGH']);
    expect(r.falsePositives.map((g) => g.scenario)).toEqual(['continuedDowntrend', 'continuedDowntrend', 'continuedDowntrend', 'uptrendContinuation', 'uptrendContinuation', 'uptrendContinuation']);
    expect(r.falsePositives.find((g) => g.scenario === 'continuedDowntrend' && g.sensitivity === 'HIGH')).toMatchObject({ series: 4, candidates: 1, seriesWithCandidate: { k: 1, n: 4 }, extendedAtDetection: { k: 1, n: 1 } });
    expect(r.comparison.find((c) => c.scenario === 'successfulReversal' && c.timeframe === '15m')).toMatchObject({ series: 2, old: { signals: 1, seriesWithSignal: { k: 1, n: 2 } }, radar: { candidates: 3 } });
    const t = Object.fromEntries(r.targets.filter((x) => x.timeframe === '15m').map((x) => [x.id, x]));
    expect(t.SUCCESS_RATE).toMatchObject({ status: 'TIDAK_TERPENUHI', value: 0.5, n: 2, smallSample: true });
    expect(t.DOWNTREND_FP).toMatchObject({ status: 'TIDAK_TERPENUHI', value: 0.25, n: 4 });
    expect(t.UPTREND_ZERO).toMatchObject({ status: 'TERPENUHI', value: 0, n: 1 });
    expect(t.LEAD_POSITIVE).toMatchObject({ status: 'TERPENUHI', value: 10, n: 1, smallSample: true });
    const t1h = Object.fromEntries(r.targets.filter((x) => x.timeframe === '1h').map((x) => [x.id, x]));
    expect(t1h.SUCCESS_RATE.status).toBe('TANPA_DATA'); // hanya kandidat OPEN → tanpa label
    expect(t1h.UPTREND_ZERO.status).toBe('TANPA_DATA');
    expect(r.targets).toHaveLength(TARGET_RULES.length * 2);
    expect(r.warnings.some((w) => /sintetis/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /penyetelan/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /sampel terlalu kecil/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /tanpa label/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /mode cepat/.test(w))).toBe(true);
    expect(collectReplayWarnings({ meta: { source: 'binance', seedSet: 'evaluation', oldMode: 'full' }, groups: [] })).toEqual([]);
    expect(checkTargets([], ['5m']).every((x) => x.status === 'TANPA_DATA')).toBe(true);
    expect(() => aggregateReplay({ series: null })).toThrow(TypeError);
    // Seri tanpa skenario (data nyata) → kelompok 'dataNyata'.
    const real = aggregateReplay({ series: [series({ scenario: undefined, seed: undefined })], meta: { source: 'binance' } });
    expect(real.groups[0].scenario).toBe('dataNyata');
    expect(real.meta.seeds).toEqual([]);
  });

  it('UNIT-RRV-043 renderReplayReport: semua bagian, disclaimer sintetis & tanpa probabilitas, rasio selalu dengan n, tanpa NaN/undefined', () => {
    const r = aggregateReplay({ series: sample(), meta: { source: 'synthetic', seedSet: 'evaluation', generatedAt: Date.UTC(2026, 9, 26, 8) }, scenarios: scenarioCatalog() });
    const md = renderReplayReport(r);
    for (const heading of ['# Laporan Replay Reversal Radar', '## Parameter', '## Peringatan kejujuran', '## Pemeriksaan target §10', '## Ringkasan per timeframe',
      '## Per timeframe × skenario × sensitivitas', '## Ekskursi MFE/MAE', '## Lead deteksi', '## False positive', '## Perbandingan mesin lama', '## Glosarium']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('Data sintetis ≠ pasar nyata');
    expect(md).toContain('**bukan probabilitas**');
    expect(md).toContain('Dibuat: 2026-10-26 08:00:00 UTC');
    expect(md).toContain(SUCCESS_DEFINITION);
    expect(md).toContain('1/2 = 50,0% (CI 9,5–90,5 %)');
    expect(md).toContain('— (n = 0)');
    expect(md).toContain('TIDAK terpenuhi');
    expect(md).toContain('TERPENUHI');
    expect(md).toContain('tanpa data');
    expect(md).toContain('Reversal sukses');
    expect(md).not.toMatch(/NaN|undefined/);
    // Setiap persentase di tabel hasil disertai "k/n =" (tidak ada rasio tanpa jumlah sampel).
    const tableLines = md.split('\n').filter((l) => l.startsWith('| ') && /\d,\d%/.test(l));
    for (const line of tableLines) {
      for (const cellText of line.split('|').map((s) => s.trim()).filter((s) => /\d,\d%/.test(s))) {
        expect(cellText, cellText).toMatch(/\d+\/\d+ = |n = \d+/);
      }
    }
    expect(md).not.toContain('## Uji anti-look-ahead');
    const withCheck = renderReplayReport({ ...r, lookahead: { checked: 3, failures: [{ symbol: 'A', timeframe: '15m', message: 'bocor di $.score' }] } });
    expect(withCheck).toContain('## Uji anti-look-ahead');
    expect(withCheck).toContain('❌ A 15m: bocor di $.score');
    expect(() => renderReplayReport({})).toThrow(TypeError);
    const summary = renderReplaySummary(r);
    expect(summary).toContain('Replay Reversal Radar — 8 seri');
    expect(summary).toContain('[§10] 15m successfulReversal: SUCCESS ≥ 60 % pada MEDIUM: TIDAK terpenuhi (50,0%, n = 2) — sampel terlalu kecil');
    expect(summary).toContain('15m successfulReversal');
    expect(summary).not.toMatch(/NaN|undefined/);
  });

  it('UNIT-RRV-045 alasan penutupan, CONFIRMED sesaat, frekuensi bukti, deteksi per fase rencana', () => {
    const phases = [{ name: 'decline', startIndex: 150, endIndex: 219 }, { name: 'base', startIndex: 220, endIndex: 259 }, { name: 'breakout', startIndex: 260, endIndex: 263 }];
    const landmarks = { bottomIndex: 230, bottomLow: 1, breakoutIndex: 260, pumpIndex: null };
    const list = [
      series({
        symbol: 'A', phases, landmarks, evidenceCounts: { LL_STOPPED: 110, QUIET_RISE: 55, ROUNDED_BOTTOM: 11 },
        candidates: [
          cand({ firstDetectedIndex: 200, firstStage: 'CONFIRMED_BREAKOUT', stages: [{ stage: 'CONFIRMED_BREAKOUT', index: 200 }], status: 'CANCELLED', closeReason: 'BREAKOUT_FAILED', closeIndex: 204, barsOpen: 4, firstEvidence: ['LL_STOPPED', 'TRIGGER_BREAK', 'BREAK_FOLLOW_THROUGH'] }),
          cand({ firstDetectedIndex: 240, stages: [{ stage: 'EARLY_FORMATION', index: 240 }, { stage: 'CONFIRMED_BREAKOUT', index: 250 }], status: 'CANCELLED', closeReason: 'BREAKOUT_FAILED', closeIndex: 253, barsOpen: 13, firstEvidence: ['LL_STOPPED', 'QUIET_RISE'] }),
          cand({ firstDetectedIndex: 255, stages: [{ stage: 'EARLY_FORMATION', index: 255 }, { stage: 'CONFIRMED_BREAKOUT', index: 262 }], status: 'EXPIRED', closeReason: 'NO_PROGRESS', closeIndex: 290, barsOpen: 35, firstEvidence: ['LL_STOPPED', 'ROUNDED_BOTTOM'] }),
        ],
      }),
      series({
        symbol: 'B', seed: 22, phases, landmarks, evidenceCounts: { LL_STOPPED: 90, QUIET_RISE: 45 },
        candidates: [cand({ firstDetectedIndex: 225, status: 'CANCELLED', closeReason: 'CLOSE_BELOW_INVALIDATION', closeIndex: 228, barsOpen: 3, firstEvidence: ['LL_STOPPED', 'QUIET_RISE'] }), cand({ firstDetectedIndex: 240, status: 'NEW', closeReason: null, closeIndex: null, barsOpen: 10, firstEvidence: [] })],
      }),
    ];
    const g = summarizeCandidates(list, 'HIGH');
    expect(g.closeReasons).toEqual({ CLOSE_BELOW_INVALIDATION: 1, BREAKOUT_FAILED: 2, NO_PROGRESS: 1, EVIDENCE_FADED: 0, other: 0 });
    expect(g.reachedConfirmed).toMatchObject({ k: 3, n: 5 });
    expect(g.falseBreakouts).toMatchObject({ k: 2, n: 3 });
    expect(g.confirmedFirstFailed).toMatchObject({ k: 1, n: 1 });
    expect(g.barsOpen).toMatchObject({ n: 5, median: 10 });
    expect(g.evidence.LL_STOPPED).toMatchObject({ evaluations: { k: 200, n: 440 }, candidates: { k: 4, n: 5 } });
    expect(g.evidence.ROUNDED_BOTTOM).toMatchObject({ evaluations: { k: 11, n: 440 }, candidates: { k: 1, n: 5 } });
    expect(g.evidence.CHOCH_BULLISH).toMatchObject({ evaluations: { k: 0, n: 440, p: 0 }, candidates: { k: 0, n: 5, p: 0 } });
    expect(g.phases).toMatchObject({
      order: ['decline', 'base', 'breakout'], candidates: { decline: 1, base: 4 }, first: { decline: 1, base: 1 },
      preBottom: { k: 2, n: 5 }, leadVsPlan: { n: 2, median: 47.5 }, leadVsPlanAfterBottom: { n: 2, median: 20 },
    });
    // Tanpa fase (data nyata) → null; filter sensitivitas ikut dipakai pada fase.
    expect(summarizeCandidates(list.map((s) => ({ ...s, phases: undefined })), 'HIGH').phases).toBeNull();
    expect(summarizeCandidates(list, 'LOW').phases.candidates).toEqual({});
    const r = aggregateReplay({ series: list, meta: { source: 'synthetic', generatedAt: 0, timeframes: ['15m'] }, scenarios: scenarioCatalog() });
    const md = renderReplayReport(r);
    expect(md).toContain('## Alasan penutupan & breakout gagal');
    expect(md).toContain('| 15m | Reversal sukses | 5 | 1 | 2 | 1 | 0 | 0 | 1 | 3/5 = 60,0% (CI 23,1–88,2 %) | 2/3 = 66,7% (CI 20,8–93,9 %) | 1/1 = 100,0% (CI 20,7–100,0 %) | 10 (4–13), n = 5 |');
    expect(md).toContain('## Deteksi per fase rencana skenario');
    expect(md).toContain('| decline 1 · base 4 | decline 1 · base 1 | 2/5 = 40,0% (CI 11,8–76,9 %) | 20 (20–20), n = 2 |');
    expect(md).toContain('## Frekuensi bukti per skenario');
    expect(md).toContain('| LL_STOPPED | 45% / 80% |');
    expect(md).toContain('| CHOCH_BULLISH | 0% / 0% |');
    expect(md).not.toMatch(/NaN|undefined/);
  });

  it('UNIT-RRV-044 ujung ke ujung: replay mesin palsu → agregasi → Markdown & JSON', async () => {
    const universe = scenarioUniverse({ seeds: [21, 22], timeframe: '15m', scenarios: ['successfulReversal', 'uptrendContinuation', 'brokenData'] });
    const { series: list } = await replayReversalUniverse({
      candles: universe, timeframes: ['15m'], ...fakeEngine, oldMode: 'fast',
      describe: (symbol) => ({ scenario: symbol.split('-')[0], seed: Number(symbol.split('-')[1]) }),
    });
    const r = aggregateReplay({ series: list, meta: { source: 'synthetic', seedSet: 'evaluation', generatedAt: 0 }, scenarios: scenarioCatalog() });
    expect(r.totals.series).toBe(6);
    const up = r.groups.find((g) => g.scenario === 'uptrendContinuation' && g.sensitivity === 'HIGH');
    expect(up.candidates).toBe(0);
    expect(r.targets.find((t) => t.id === 'UPTREND_ZERO').status).toBe('TERPENUHI');
    const sr = r.groups.find((g) => g.scenario === 'successfulReversal' && g.sensitivity === 'HIGH');
    expect(sr.candidates).toBeGreaterThan(0);
    expect(sr.leadVsOld.n).toBeGreaterThan(0);
    const broken = r.groups.find((g) => g.scenario === 'brokenData' && g.sensitivity === 'HIGH');
    expect(broken.classifications.DATA_QUALITY).toBeGreaterThan(0);
    const md = renderReplayReport(r);
    expect(md).not.toMatch(/NaN|undefined/);
    expect(JSON.parse(JSON.stringify(r)).groups).toHaveLength(r.groups.length);
  });
});
