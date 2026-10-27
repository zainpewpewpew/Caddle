// Agregasi & laporan replay Reversal Radar (backend/reversal/replayReport.js): sensitivitas, rasio dengan jumlah
// sampel & CI Wilson, kuantil, target §10, peringatan kejujuran, render Markdown & ringkasan stdout.
// Objek contoh berbentuk hasil replayReversalSeries — angka fiktif, hanya untuk menguji agregasi/render.
import { describe, expect, it } from 'vitest';
import { wilsonInterval } from '../../../backend/backtest/metrics.js';
import { SENSITIVITY_FILTERS } from '../../../backend/reversal/constants.js';
import { replayReversalUniverse } from '../../../backend/reversal/replay.js';
import {
  DEFAULT_FALSE_POSITIVE_SCENARIOS, REAL_DATA_TARGET_RULES, SCORE_BINS, SUBSET_BASELINE_NOTE, SUCCESS_DEFINITION, TARGET_RULES, aggregateReplay, checkTargets,
  collectReplayWarnings, fmtRate, passesSensitivity, quantiles, rate, renderReplayReport, renderReplaySummary, scoreBinIndex, scoreHistogram, summarizeCandidates,
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
      '## Per timeframe × skenario × sensitivitas', '## Basis pembanding tanpa keterampilan', '## Hasil per tahap awal', '## Hasil menurut status terlambat saat deteksi',
      '## Alasan penutupan & breakout gagal', '## Distribusi skor saat deteksi per tahap awal (sensitivitas HIGH)', '## Ekskursi MFE/MAE', '## Lead deteksi',
      '## Lead per peristiwa (padanan sinyal lama terdekat ±horizon)', '## False positive', '## Perbandingan mesin lama', '## Glosarium']) {
      expect(md).toContain(heading);
    }
    // Fixture tanpa field basis/lead per peristiwa (seri satu-peristiwa lama) → bagian baru tetap benar: "— (n = 0)", tanpa NaN.
    expect(md).toContain('| Basis acak RW | Basis acak empiris |');
    expect(md).toContain('| Breakout gagal sebelum target |');
    expect(md).toMatch(/\| 15m \| Reversal sukses \| MEDIUM \| 2 \| — \(n = 0\) \| — \(n = 0\) \| — \(n = 0\) \| 1\/2 = 50,0% \(CI 9,5–90,5 %\) \| — \|/);
    expect(md).not.toContain('Simbol dilewati'); // hanya data nyata
    expect(md).not.toMatch(/\| T-NYATA-/); // baris target data nyata hanya bila ada grup dataNyata
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
    // Kolom baru "Breakout gagal sebelum target": kedua kandidat BREAKOUT_FAILED berlabel punya mfeAtr 2 = target → 0/2.
    expect(g.failedBeforeTarget).toMatchObject({ k: 0, n: 2 });
    expect(md).toContain(`| 15m | Reversal sukses | 5 | 1 | 2 | 1 | 0 | 0 | 1 | 3/5 = 60,0% (CI 23,1–88,2 %) | 2/3 = 66,7% (CI 20,8–93,9 %) | 1/1 = 100,0% (CI 20,7–100,0 %) | 10 (4–13), n = 5 | ${fmtRate(rate(0, 2))} |`);
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
    // Mesin palsu pada seri skenario: basis empiris & lead per peristiwa terisi dan ter-render (bukan "tanpa data").
    expect(sr.baselineShuffled.n).toBeGreaterThan(0);
    expect(sr.stopDistanceAtr.n).toBe(sr.outcomes.labeled);
    expect(sr.baselineRandomWalk.n).toBe(sr.outcomes.labeled);
    expect(sr.leadVsOldNearestMatched.n).toBe(sr.candidates);
    expect(md).toMatch(/\| 15m \| Reversal sukses \| HIGH \| \d+ \| \d+,\d{2} \(\d+,\d{2}–\d+,\d{2}\), n = \d+ \| \d+,\d%, n = \d+ \| \d+\/\d+ = \d+,\d% \(CI [\d,]+–[\d,]+ %\) \| \d+\/\d+ = \d+,\d% \(CI [\d,]+–[\d,]+ %\) \| [+−]?\d+,\d poin \|/);
  });
});

describe('agregat data nyata multi-peristiwa', () => {
  const b = (k, n) => ({ k, n, indexes: [], outcomes: [] });
  const list = () => [
    series({
      symbol: 'A', candidates: [
        cand({ firstStage: 'EARLY_FORMATION', firstScore: 12, firstEvidenceCount: 2, outcome: 'SUCCESS', stopDistanceAtr: 2, baselineRandomWalk: 0.5, baselineShuffled: b(1, 3), leadVsOldNearest: 4, extendedAtDetection: false }),
        cand({ firstStage: 'EARLY_FORMATION', firstScore: 48, firstEvidenceCount: 3, outcome: 'FAIL', stopDistanceAtr: 1, baselineRandomWalk: 1 / 3, baselineShuffled: b(0, 3), leadVsOldNearest: -2, extendedAtDetection: true, status: 'CANCELLED', closeReason: 'BREAKOUT_FAILED', closeIndex: 210, mfeAtr: 1.2 }),
        cand({ firstStage: 'CONFIRMED_BREAKOUT', firstScore: 100, firstEvidenceCount: 6, outcome: 'TIMEOUT', stopDistanceAtr: 4, baselineRandomWalk: 2 / 3, baselineShuffled: b(2, 2), leadVsOldNearest: null, extendedAtDetection: true, status: 'CANCELLED', closeReason: 'BREAKOUT_FAILED', closeIndex: 240, mfeAtr: 2.5 }),
        // OPEN: jarak stop ada tetapi tanpa basis; BREAKOUT_FAILED tanpa label tidak masuk "gagal sebelum target".
        cand({ firstStage: 'DEVELOPING_REVERSAL', firstScore: 70, firstEvidenceCount: 5, outcome: 'OPEN', stopDistanceAtr: 3, baselineRandomWalk: null, baselineShuffled: null, leadVsOldNearest: 0, status: 'CANCELLED', closeReason: 'BREAKOUT_FAILED', closeIndex: 260, mfeAtr: 0.5 }),
      ],
    }),
  ];

  it('UNIT-RR-RR-001 summarizeCandidates: hasil per tahap awal & status terlambat, distribusi skor/bukti + histogram, jarak stop, basis RW/empiris, breakout gagal sebelum target, lead per peristiwa', () => {
    expect(SCORE_BINS.map((x) => x.label)).toEqual(['0–9', '10–19', '20–29', '30–39', '40–49', '50–59', '60–69', '70–79', '80–89', '90–100']);
    expect(scoreHistogram([-5, 0, 9, 10, 99, 100, 150, null, NaN, undefined])).toEqual([3, 1, 0, 0, 0, 0, 0, 0, 0, 3]);
    expect(scoreHistogram([])).toEqual(Array(10).fill(0));
    const high = summarizeCandidates(list(), 'HIGH');
    expect(high.outcomes).toMatchObject({ labeled: 3, open: 1, unlabeled: 0, success: { k: 1, n: 3 } });
    expect(high.outcomesByFirstStage.EARLY_FORMATION).toMatchObject({ candidates: 2, labeled: 2, success: { k: 1, n: 2, p: 0.5 }, fail: { k: 1, n: 2 }, timeout: { k: 0, n: 2 } });
    expect(high.outcomesByFirstStage.DEVELOPING_REVERSAL).toMatchObject({ candidates: 1, labeled: 0, open: 1, success: { k: 0, n: 0, p: null, ci: null } });
    expect(high.outcomesByFirstStage.CONFIRMED_BREAKOUT).toMatchObject({ candidates: 1, labeled: 1, timeout: { k: 1, n: 1, p: 1 } });
    expect(high.outcomesByExtended.extended).toMatchObject({ candidates: 2, labeled: 2, success: { k: 0, n: 2 }, fail: { k: 1, n: 2 }, timeout: { k: 1, n: 2 } });
    expect(high.outcomesByExtended.notExtended).toMatchObject({ candidates: 2, labeled: 1, open: 1, success: { k: 1, n: 1, p: 1 } });
    expect(high.firstScoreByStage.EARLY_FORMATION).toMatchObject({ n: 2, min: 12, median: 30, max: 48 });
    expect(high.firstScoreByStage.CONFIRMED_BREAKOUT).toMatchObject({ n: 1, median: 100 });
    expect(high.firstEvidenceByStage.EARLY_FORMATION).toMatchObject({ n: 2, median: 2.5 });
    expect(high.firstScoreHistogramByStage).toEqual({
      EARLY_FORMATION: [0, 1, 0, 0, 1, 0, 0, 0, 0, 0], DEVELOPING_REVERSAL: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0], CONFIRMED_BREAKOUT: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    });
    expect(high.stopDistanceAtr).toMatchObject({ n: 3, min: 1, median: 2, max: 4 }); // hanya berlabel (OPEN dikecualikan)
    expect(high.baselineRandomWalk.n).toBe(3);
    expect(high.baselineRandomWalk.p).toBeCloseTo(0.5, 9);
    expect(high.baselineShuffled).toEqual({ k: 3, n: 8, p: 0.375, ci: wilsonInterval(3, 8) });
    expect(high.successMinusBaseline).toBeCloseTo(1 / 3 - 0.375, 9);
    expect(high.failedBeforeTarget).toMatchObject({ k: 1, n: 2 }); // FAIL mfe 1,2 < 2 ya; TIMEOUT mfe 2,5 tidak; OPEN tidak berlabel
    expect(high.leadVsOldNearest).toMatchObject({ n: 3, min: -2, median: 0, max: 4 });
    expect(high.leadVsOldNearestMatched).toMatchObject({ k: 3, n: 4 });
    expect(high.leadVsOldNearestPositive).toMatchObject({ k: 1, n: 3 });
    // Filter sensitivitas ikut berlaku: MEDIUM (skor ≥ 45, bukti ≥ 3) → FAIL, TIMEOUT, OPEN.
    const medium = summarizeCandidates(list(), 'MEDIUM');
    expect(medium.candidates).toBe(3);
    expect(medium.baselineShuffled).toMatchObject({ k: 2, n: 5 });
    expect(medium.outcomesByFirstStage.EARLY_FORMATION).toMatchObject({ candidates: 1, success: { k: 0, n: 1 } });
    expect(medium.firstScoreHistogramByStage.EARLY_FORMATION).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
    // Tanpa targetAtr seri → "gagal sebelum target" tanpa data; grup kosong → semua n = 0 / null tanpa error.
    expect(summarizeCandidates(list().map((s) => ({ ...s, targetAtr: undefined })), 'HIGH').failedBeforeTarget).toEqual(rate(0, 0));
    const empty = summarizeCandidates([], 'HIGH');
    expect(empty.outcomesByFirstStage.EARLY_FORMATION).toMatchObject({ candidates: 0, labeled: 0, success: { n: 0, p: null } });
    expect(empty.outcomesByExtended.extended.candidates).toBe(0);
    expect(empty.firstScoreHistogramByStage.EARLY_FORMATION).toEqual(Array(10).fill(0));
    expect(empty).toMatchObject({ baselineRandomWalk: { n: 0, p: null }, baselineShuffled: { n: 0, p: null }, successMinusBaseline: null, failedBeforeTarget: { n: 0 }, leadVsOldNearest: { n: 0 } });
  });

  it('UNIT-RR-RR-003 basis per subset (tahap awal, status terlambat, bin skor) memakai jarak stop subset; ekspektasi ATR; scoreBinIndex', () => {
    for (const [score, idx] of [[-5, 0], [0, 0], [9, 0], [10, 1], [99, 9], [100, 9], [150, 9], [null, null], [NaN, null], [undefined, null]]) expect(scoreBinIndex(score), String(score)).toBe(idx);
    const high = summarizeCandidates(list(), 'HIGH');
    // Grup: SUCCESS (+2) + FAIL (−1) + TIMEOUT (0) → ekspektasi 1/3 ATR; basis grup tetap sama dengan sebelumnya.
    expect(high.expectancyAtr.n).toBe(3);
    expect(high.expectancyAtr.mean).toBeCloseTo(1 / 3, 9);
    expect(high.baselineShuffled).toMatchObject({ k: 3, n: 8 });
    // Subset tahap awal: EARLY = SUCCESS (s 2, 1/3) + FAIL (s 1, 0/3) → basis subset 1/6 (bukan basis grup 3/8), selisih 1/2 − 1/6.
    const early = high.outcomesByFirstStage.EARLY_FORMATION;
    expect(early.stopDistanceAtr).toMatchObject({ n: 2, min: 1, median: 1.5, max: 2 });
    expect(early.baselineRandomWalk.n).toBe(2);
    expect(early.baselineRandomWalk.p).toBeCloseTo((0.5 + 1 / 3) / 2, 9);
    expect(early.baselineShuffled).toEqual({ k: 1, n: 6, p: 1 / 6, ci: wilsonInterval(1, 6) });
    expect(early.successMinusBaseline).toBeCloseTo(0.5 - 1 / 6, 9);
    expect(early.expectancyAtr).toEqual({ n: 2, mean: 0.5 });
    const confirmed = high.outcomesByFirstStage.CONFIRMED_BREAKOUT;
    expect(confirmed).toMatchObject({ stopDistanceAtr: { n: 1, median: 4 }, baselineShuffled: { k: 2, n: 2, p: 1 }, successMinusBaseline: -1, expectancyAtr: { n: 1, mean: 0 } });
    expect(high.outcomesByFirstStage.DEVELOPING_REVERSAL).toMatchObject({ candidates: 1, labeled: 0, stopDistanceAtr: { n: 0 }, baselineShuffled: { n: 0, p: null }, successMinusBaseline: null, expectancyAtr: { n: 0, mean: null } });
    // Subset status terlambat: terlambat = FAIL + TIMEOUT; tepat waktu = SUCCESS (+ OPEN tanpa label).
    expect(high.outcomesByExtended.extended).toMatchObject({ stopDistanceAtr: { n: 2, median: 2.5 }, baselineShuffled: { k: 2, n: 5, p: 0.4 }, expectancyAtr: { n: 2, mean: -0.5 } });
    expect(high.outcomesByExtended.extended.successMinusBaseline).toBeCloseTo(-0.4, 9);
    expect(high.outcomesByExtended.notExtended).toMatchObject({ stopDistanceAtr: { n: 1, median: 2 }, baselineShuffled: { k: 1, n: 3 }, expectancyAtr: { n: 1, mean: 2 } });
    expect(high.outcomesByExtended.notExtended.successMinusBaseline).toBeCloseTo(2 / 3, 9);
    // Per bin skor × tahap: array seurut SCORE_BINS; hanya bin dengan kandidat yang terisi.
    const bins = high.outcomesByScoreBin;
    expect(Object.keys(bins)).toEqual(['EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT']);
    expect(bins.EARLY_FORMATION).toHaveLength(10);
    expect(bins.EARLY_FORMATION.map((x) => x.bin)).toEqual(SCORE_BINS.map((x) => x.label));
    expect(bins.EARLY_FORMATION[1]).toMatchObject({ bin: '10–19', candidates: 1, labeled: 1, success: { k: 1, n: 1 }, baselineShuffled: { k: 1, n: 3 }, expectancyAtr: { n: 1, mean: 2 } });
    expect(bins.EARLY_FORMATION[1].successMinusBaseline).toBeCloseTo(2 / 3, 9);
    expect(bins.EARLY_FORMATION[4]).toMatchObject({ bin: '40–49', candidates: 1, labeled: 1, success: { k: 0, n: 1 }, baselineShuffled: { k: 0, n: 3, p: 0 }, successMinusBaseline: 0, expectancyAtr: { n: 1, mean: -1 } });
    expect(bins.EARLY_FORMATION.filter((x) => x.candidates > 0)).toHaveLength(2);
    expect(bins.CONFIRMED_BREAKOUT[9]).toMatchObject({ bin: '90–100', candidates: 1, success: { k: 0, n: 1 }, baselineShuffled: { k: 2, n: 2 }, successMinusBaseline: -1, expectancyAtr: { n: 1, mean: 0 } });
    expect(bins.DEVELOPING_REVERSAL[7]).toMatchObject({ bin: '70–79', candidates: 1, labeled: 0, success: { n: 0 }, baselineShuffled: { n: 0 }, successMinusBaseline: null, expectancyAtr: { n: 0 } });
    // Filter sensitivitas ikut berlaku pada bin (MEDIUM: skor 12 tersaring); tanpa targetAtr seri SUCCESS tidak masuk ekspektasi.
    expect(summarizeCandidates(list(), 'MEDIUM').outcomesByScoreBin.EARLY_FORMATION[1].candidates).toBe(0);
    expect(summarizeCandidates(list().map((s) => ({ ...s, targetAtr: undefined })), 'HIGH').expectancyAtr).toEqual({ n: 2, mean: -0.5 });
    const empty = summarizeCandidates([], 'HIGH');
    expect(empty.expectancyAtr).toEqual({ n: 0, mean: null });
    expect(empty.outcomesByScoreBin.EARLY_FORMATION.every((x) => x.candidates === 0 && x.success.n === 0)).toBe(true);
  });

  const real = (symbol, timeframe, n, { success, early, lead, baseline = b(1, 3) }) => series({
    symbol, timeframe, scenario: undefined, seed: undefined,
    candidates: Array.from({ length: n }, (_, i) => cand({
      firstDetectedIndex: 200 + 10 * i, firstStage: i < early ? 'EARLY_FORMATION' : 'DEVELOPING_REVERSAL', firstScore: 50 + (i % 5), firstEvidenceCount: 3 + (i % 3),
      outcome: i < success ? 'SUCCESS' : 'FAIL', stopDistanceAtr: 1.5, baselineRandomWalk: 1.5 / 3.5, baselineShuffled: baseline, leadVsOldNearest: lead(i),
      extendedAtDetection: i % 4 === 0, closeReason: i % 3 === 0 ? 'BREAKOUT_FAILED' : 'NO_PROGRESS', mfeAtr: i < success ? 2 : 0.8,
    })),
  });

  it('UNIT-RR-RR-002 target T-NYATA-1..3 hanya pada grup dataNyata; render bagian baru, simbol dilewati & ringkasan stdout tanpa NaN', () => {
    const list = [
      real('AAAUSDT', '15m', 40, { success: 32, early: 10, lead: (i) => (i < 30 ? 5 : -3) }), // TERPENUHI semua
      real('AAAUSDT', '1h', 40, { success: 10, early: 2, lead: () => -3 }), // TIDAK terpenuhi semua
      real('AAAUSDT', '5m', 0, { success: 0, early: 0, lead: () => null }), // tanpa kandidat → tanpa data
    ];
    const meta = {
      source: 'binance', generatedAt: Date.UTC(2026, 9, 26), from: Date.UTC(2025, 5, 1), to: Date.UTC(2025, 9, 1),
      symbols: ['AAAUSDT'], symbolsRequested: ['AAAUSDT', 'BBBUSDT'], topRequested: 3, symbolsSkipped: [{ symbol: 'BBBUSDT', reason: 'unduh gagal: HTTP 451' }],
    };
    const r = aggregateReplay({ series: list, meta });
    expect(r.meta.timeframes).toEqual(['5m', '15m', '1h']);
    expect(r.targets).toHaveLength((TARGET_RULES.length + REAL_DATA_TARGET_RULES.length) * 3);
    const t = (tf) => Object.fromEntries(r.targets.filter((x) => x.timeframe === tf && x.id.startsWith('T_NYATA')).map((x) => [x.stage ? `${x.id}:${x.stage}` : x.id, x]));
    expect(t('15m').T_NYATA_1).toMatchObject({ status: 'TERPENUHI', value: 0.8, n: 40, stage: null, smallSample: false, detail: { baseline: 1 / 3, baselineN: 120, ci: wilsonInterval(32, 40) } });
    // T-NYATA-1 per tahap: basis subset (EARLY 10 kandidat × b(1,3) → 10/30), bukan basis grup; subset kosong → tanpa data.
    expect(t('15m')['T_NYATA_1_STAGE:EARLY_FORMATION']).toMatchObject({ status: 'TERPENUHI', value: 1, n: 10, stage: 'EARLY_FORMATION', smallSample: true, detail: { stage: 'EARLY_FORMATION', baseline: 1 / 3, baselineN: 30, ci: wilsonInterval(10, 10) } });
    expect(t('15m')['T_NYATA_1_STAGE:DEVELOPING_REVERSAL']).toMatchObject({ status: 'TERPENUHI', n: 30, detail: { baselineN: 90 } });
    expect(t('15m')['T_NYATA_1_STAGE:DEVELOPING_REVERSAL'].value).toBeCloseTo(22 / 30, 9);
    expect(t('15m')['T_NYATA_1_STAGE:CONFIRMED_BREAKOUT']).toMatchObject({ status: 'TANPA_DATA', n: 0, value: null });
    expect(t('1h')['T_NYATA_1_STAGE:DEVELOPING_REVERSAL']).toMatchObject({ status: 'TIDAK_TERPENUHI', n: 38 });
    expect(t('1h')['T_NYATA_1_STAGE:EARLY_FORMATION']).toMatchObject({ status: 'TERPENUHI', n: 2, smallSample: true }); // CI bawah 2/2 = 34,2 % > 33,3 %
    expect(r.targets.filter((x) => x.id === 'T_NYATA_1_STAGE').map((x) => x.text)).toContain('T-NYATA-1 per tahap: SUCCESS EARLY_FORMATION pada MEDIUM melampaui basis empiris subset (CI bawah > basis)');
    expect(t('15m').T_NYATA_2).toMatchObject({ status: 'TERPENUHI', value: 5, n: 40 });
    expect(t('15m').T_NYATA_3).toMatchObject({ status: 'TERPENUHI', value: 0.25, n: 40 });
    expect(t('1h').T_NYATA_1).toMatchObject({ status: 'TIDAK_TERPENUHI', value: 0.25, n: 40 });
    expect(t('1h').T_NYATA_2).toMatchObject({ status: 'TIDAK_TERPENUHI', value: -3, n: 40 });
    expect(t('1h').T_NYATA_3).toMatchObject({ status: 'TIDAK_TERPENUHI', value: 0.05, n: 40 });
    expect(Object.values(t('5m')).map((x) => x.status)).toEqual(Array(8).fill('TANPA_DATA')); // T-NYATA-1, 3 tahap, 2, 3, 4, 5
    // Basis empiris kosong → T-NYATA-1 tanpa data meski SUCCESS ada.
    const noBase = aggregateReplay({ series: [real('AAAUSDT', '15m', 40, { success: 32, early: 10, lead: () => 5, baseline: null })], meta: { source: 'binance' } });
    expect(noBase.targets.find((x) => x.id === 'T_NYATA_1')).toMatchObject({ status: 'TANPA_DATA', n: 40 });
    // Run sintetis (tanpa grup dataNyata) tidak mendapat target T-NYATA.
    expect(checkTargets(aggregateReplay({ series: sample() }).groups, ['15m']).map((x) => x.id)).toEqual(TARGET_RULES.map((x) => x.id));

    const md = renderReplayReport(r);
    expect(md).not.toMatch(/NaN|undefined/);
    expect(md).toContain('- Rentang data: 2025-06-01 00:00:00 UTC – 2025-10-01 00:00:00 UTC');
    expect(md).toContain('- Simbol diminta: --top 3 → discovery mengembalikan 2 (filter kontrak/likuiditas discovery)');
    expect(md).toContain('- Simbol di-replay (1): AAAUSDT');
    expect(md).toContain('- Simbol dilewati: BBBUSDT (unduh gagal: HTTP 451)');
    expect(renderReplayReport(aggregateReplay({ series: list, meta: { ...meta, topRequested: null, symbolsSkipped: [] } }))).toContain('- Simbol diminta: 2 (--symbols)\n- Simbol di-replay (1): AAAUSDT\n- Simbol dilewati: tidak ada');
    expect(md).toMatch(/\| 15m \| T-NYATA-1 dataNyata: SUCCESS pada MEDIUM melampaui basis acak empiris \(CI bawah SUCCESS > basis\) \| TERPENUHI \| SUCCESS 80,0% \(CI [\d,]+–[\d,]+ %\) vs basis empiris 33,3%, n = 40 \| — \|/);
    expect(md).toContain('| 15m | T-NYATA-2 dataNyata: median lead per peristiwa (padanan ±horizon) > 0 pada MEDIUM | TERPENUHI | median +5 candle, n = 40 | — |');
    expect(md).toContain('| 1h | T-NYATA-3 dataNyata: kandidat pertama EARLY_FORMATION ≥ 10 % pada MEDIUM | TIDAK terpenuhi | 5,0%, n = 40 | — |');
    expect(md).toContain('| 5m | T-NYATA-1 dataNyata: SUCCESS pada MEDIUM melampaui basis acak empiris (CI bawah SUCCESS > basis) | tanpa data | — | — |');
    expect(md).toContain(`| 15m | dataNyata | MEDIUM | 40 | 1,50 (1,50–1,50), n = 40 | 42,9%, n = 40 | ${fmtRate(rate(40, 120))} | ${fmtRate(rate(32, 40))} | +46,7 poin |`);
    expect(md).toContain(`| 15m | dataNyata | MEDIUM | EARLY_FORMATION | 10 | 10 | ${fmtRate(rate(10, 10))} | ${fmtRate(rate(0, 10))} | ${fmtRate(rate(0, 10))} |`);
    expect(md).toContain(`| 15m | dataNyata | MEDIUM | terlambat (LATE_ENTRY/EXTENDED) | 10 | 10 | ${fmtRate(rate(8, 10))} |`);
    expect(md).toContain('| 15m | dataNyata | EARLY_FORMATION | 10 | 52 (51–53), n = 10 | 50–54 | 4,0 (3,0–4,8), n = 10 | 0/0/0/0/0/10/0/0/0/0 |');
    expect(md).toContain(`| 15m | dataNyata | 40 | ${fmtRate(rate(40, 40))} | 0 | 5 (3–5), n = 40 | ${fmtRate(rate(30, 40))} |`);
    // Breakout gagal sebelum target (HIGH): BREAKOUT_FAILED pada i % 3 === 0 → 14 kandidat; yang FAIL (i ≥ 32: 33, 36, 39) mfe 0,8 < 2 → 3/14.
    expect(md).toContain(`| 15m | dataNyata | 40 | 0 | 14 | 26 | 0 | 0 | 0 | ${fmtRate(rate(0, 40))} | — (n = 0) | — (n = 0) | — (n = 0) | ${fmtRate(rate(3, 14))} |`);
    expect(md).toContain('- **Lead vs lama — semua kandidat**: setiap kandidat vs sinyal lama PERTAMA seri — hanya bermakna pada seri satu-peristiwa (sintetis)');
    expect(md).toContain('- **Basis acak empiris**');
    const summary = renderReplaySummary(r);
    expect(summary).not.toMatch(/NaN|undefined/);
    expect(summary).toContain(`basis empiris ${fmtRate(rate(40, 120))}`);
    expect(summary).toContain('lead per peristiwa med. +5 (n = 40)');
    expect(summary).toContain('[§10] 15m T-NYATA-2 dataNyata: median lead per peristiwa (padanan ±horizon) > 0 pada MEDIUM: TERPENUHI (median +5 candle, n = 40)');
    expect(summary).toContain('[§10] 5m T-NYATA-3 dataNyata: kandidat pertama EARLY_FORMATION ≥ 10 % pada MEDIUM: tanpa data');
  });

  it('UNIT-RR-RR-004 render basis per subset: kolom tahap awal/status terlambat, bagian per bin skor, target per tahap, catatan meta', () => {
    const list = [real('AAAUSDT', '15m', 40, { success: 32, early: 10, lead: () => 5 }), real('AAAUSDT', '5m', 0, { success: 0, early: 0, lead: () => null })];
    const r = aggregateReplay({ series: list, meta: { source: 'binance', generatedAt: 0, notes: ['catatan CLI'] } });
    expect(r.meta.notes).toEqual(['catatan CLI', SUBSET_BASELINE_NOTE]);
    expect(aggregateReplay({ series: sample() }).meta.notes).toEqual([SUBSET_BASELINE_NOTE]);
    const md = renderReplayReport(r);
    expect(md).not.toMatch(/NaN|undefined/);
    expect(md).toContain(`- Catatan: ${SUBSET_BASELINE_NOTE}`);
    // Tabel basis grup: kolom ekspektasi; 15m MEDIUM = (32 × 2 − 8 × 1,5) / 40 = +1,30 ATR.
    expect(md).toContain(`| 15m | dataNyata | MEDIUM | 40 | 1,50 (1,50–1,50), n = 40 | 42,9%, n = 40 | ${fmtRate(rate(40, 120))} | ${fmtRate(rate(32, 40))} | +46,7 poin | +1,30 ATR, n = 40 |`);
    // Hasil per tahap awal: EARLY 10 kandidat SUCCESS semua → basis subset 10/30, selisih +66,7 poin, ekspektasi +2 ATR.
    expect(md).toContain('| TF | Skenario | Sens. | Tahap awal | Kandidat | Berlabel | SUCCESS | FAIL | TIMEOUT | Jarak stop s (ATR) median (Q1–Q3) | Basis acak empiris (subset) | Selisih SUCCESS − basis | Ekspektasi (ATR) |');
    expect(md).toContain(`| 15m | dataNyata | MEDIUM | EARLY_FORMATION | 10 | 10 | ${fmtRate(rate(10, 10))} | ${fmtRate(rate(0, 10))} | ${fmtRate(rate(0, 10))} | 1,50 (1,50–1,50), n = 10 | ${fmtRate(rate(10, 30))} | +66,7 poin | +2,00 ATR, n = 10 |`);
    expect(md).toContain(`| 15m | dataNyata | MEDIUM | DEVELOPING_REVERSAL | 30 | 30 | ${fmtRate(rate(22, 30))} | ${fmtRate(rate(8, 30))} | ${fmtRate(rate(0, 30))} | 1,50 (1,50–1,50), n = 30 | ${fmtRate(rate(30, 90))} | +40,0 poin | +1,07 ATR, n = 30 |`);
    // Status terlambat: i % 4 === 0 → 10 kandidat, 8 SUCCESS + 2 FAIL → ekspektasi (16 − 3) / 10 = +1,30 ATR.
    expect(md).toContain(`| 15m | dataNyata | MEDIUM | terlambat (LATE_ENTRY/EXTENDED) | 10 | 10 | ${fmtRate(rate(8, 10))} | ${fmtRate(rate(2, 10))} | ${fmtRate(rate(0, 10))} | 1,50 (1,50–1,50), n = 10 | ${fmtRate(rate(10, 30))} | +46,7 poin | +1,30 ATR, n = 10 |`);
    // Bagian baru per bin skor (HIGH): semua skor 50–54 → bin 50–59 per tahap; bin kosong tidak dirender.
    expect(md).toContain('## Hasil per bin skor saat deteksi (sensitivitas HIGH)');
    expect(md).toContain(`| 15m | dataNyata | EARLY_FORMATION | 50–59 | 10 | 10 | ${fmtRate(rate(10, 10))} | ${fmtRate(rate(10, 30))} | +66,7 poin | +2,00 ATR, n = 10 |`);
    expect(md).toContain(`| 15m | dataNyata | DEVELOPING_REVERSAL | 50–59 | 30 | 30 | ${fmtRate(rate(22, 30))} | ${fmtRate(rate(30, 90))} | +40,0 poin | +1,07 ATR, n = 30 |`);
    const binSection = md.slice(md.indexOf('## Hasil per bin skor saat deteksi'), md.indexOf('## Deteksi per fase') === -1 ? md.indexOf('## Frekuensi bukti') : md.indexOf('## Deteksi per fase'));
    expect(binSection.split('\n').filter((l) => l.startsWith('| 15m | dataNyata | EARLY_FORMATION | '))).toHaveLength(1); // bin kosong tidak dirender
    // Target per tahap di tabel §10 & ringkasan stdout; tanpa data untuk tahap/TF kosong.
    expect(md).toMatch(/\| 15m \| T-NYATA-1 per tahap: SUCCESS EARLY_FORMATION pada MEDIUM melampaui basis empiris subset \(CI bawah > basis\) \| TERPENUHI \| SUCCESS 100,0% \(CI [\d,]+–100,0 %\) vs basis empiris subset 33,3%, n = 10 \| sampel terlalu kecil \|/);
    expect(md).toContain('| 15m | T-NYATA-1 per tahap: SUCCESS CONFIRMED_BREAKOUT pada MEDIUM melampaui basis empiris subset (CI bawah > basis) | tanpa data | — | — |');
    expect(md).toContain('| 5m | T-NYATA-1 per tahap: SUCCESS EARLY_FORMATION pada MEDIUM melampaui basis empiris subset (CI bawah > basis) | tanpa data | — | — |');
    expect(md).toContain('- **Basis per subset**');
    expect(md).toContain('- **Ekspektasi (ATR)**');
    const summary = renderReplaySummary(r);
    expect(summary).toMatch(/\[§10\] 15m T-NYATA-1 per tahap: SUCCESS DEVELOPING_REVERSAL pada MEDIUM melampaui basis empiris subset \(CI bawah > basis\): TERPENUHI \(SUCCESS 73,3% \(CI [\d,]+–[\d,]+ %\) vs basis empiris subset 33,3%, n = 30\)/);
    expect(summary).not.toMatch(/NaN|undefined/);
    // Fixture sintetis lama (tanpa field basis) → kolom & bagian baru tetap "— (n = 0)" tanpa NaN.
    const synth = renderReplayReport(aggregateReplay({ series: sample(), meta: { source: 'synthetic', generatedAt: 0 }, scenarios: scenarioCatalog() }));
    expect(synth).toContain('## Hasil per bin skor saat deteksi (sensitivitas HIGH)');
    // HIGH EARLY: skor 50 (SUCCESS) di bin 50–59, 70 (FAIL) di 70–79, 30 (TIMEOUT) di 30–39; tanpa basis → "— (n = 0)" & selisih "—";
    // ekspektasi tetap terhitung dari SUCCESS (+target) walau jarak stop tidak ada.
    expect(synth).toContain(`| 15m | Reversal sukses | EARLY_FORMATION | 50–59 | 1 | 1 | ${fmtRate(rate(1, 1))} | — (n = 0) | — | +2,00 ATR, n = 1 |`);
    expect(synth).toContain(`| 15m | Reversal sukses | EARLY_FORMATION | 70–79 | 1 | 1 | ${fmtRate(rate(0, 1))} | — (n = 0) | — | — (n = 0) |`); // FAIL tanpa s → tidak masuk ekspektasi
    expect(synth).not.toMatch(/NaN|undefined/);
  });

  // Seperti `real`, tetapi skor/bukti lolos LOW (skor 70, bukti 5); tahap awal DEVELOPING_REVERSAL untuk i < developing (sisanya EARLY_FORMATION),
  // SUCCESS untuk i < success (sisanya FAIL); jarak stop s, basis per kandidat & targetAtr seri dapat diatur (menentukan basis & ekspektasi ATR).
  const realLow = (symbol, timeframe, n, { success, developing = n, stop = 1.5, baseline = b(1, 3), targetAtr = 2 }) => series({
    symbol, timeframe, scenario: undefined, seed: undefined, targetAtr,
    candidates: Array.from({ length: n }, (_, i) => cand({
      firstDetectedIndex: 200 + 10 * i, firstStage: i < developing ? 'DEVELOPING_REVERSAL' : 'EARLY_FORMATION', firstScore: 70, firstEvidenceCount: 5,
      outcome: i < success ? 'SUCCESS' : 'FAIL', stopDistanceAtr: stop, baselineRandomWalk: stop / (2 + stop), baselineShuffled: baseline, leadVsOldNearest: 5,
    })),
  });

  it('UNIT-RR-RR-005 target praregistrasi T-NYATA-4 (subset DEVELOPING pada LOW) & T-NYATA-5 (grup LOW): tiga syarat, toleransi float, tanpa data, render', () => {
    // Aturan: ditambahkan setelah T-NYATA-3, keduanya pada LOW; T-NYATA-4 bertahap DEVELOPING_REVERSAL, T-NYATA-5 level grup (tanpa tahap).
    expect(REAL_DATA_TARGET_RULES.map((x) => x.id)).toEqual(['T_NYATA_1', 'T_NYATA_1_STAGE', 'T_NYATA_1_STAGE', 'T_NYATA_1_STAGE', 'T_NYATA_2', 'T_NYATA_3', 'T_NYATA_4', 'T_NYATA_5']);
    expect(REAL_DATA_TARGET_RULES.find((x) => x.id === 'T_NYATA_4')).toMatchObject({ stage: 'DEVELOPING_REVERSAL', scenario: 'dataNyata', sensitivity: 'LOW' });
    expect(REAL_DATA_TARGET_RULES.find((x) => x.id === 'T_NYATA_5')).toMatchObject({ scenario: 'dataNyata', sensitivity: 'LOW' });
    expect(REAL_DATA_TARGET_RULES.find((x) => x.id === 'T_NYATA_5').stage).toBeUndefined();
    const t45 = (s, tf = '15m') => Object.fromEntries(aggregateReplay({ series: [s], meta: { source: 'binance' } }).targets
      .filter((x) => x.timeframe === tf && (x.id === 'T_NYATA_4' || x.id === 'T_NYATA_5')).map((x) => [x.id, x]));
    // TERPENUHI: 32/40 SUCCESS (CI bawah 65,2 % > basis 33,3 %), selisih +46,7 poin, ekspektasi (32 × 2 − 8 × 1,5) / 40 = +1,30 ATR; subset = grup (semua DEVELOPING).
    const okRun = t45(realLow('AAAUSDT', '15m', 40, { success: 32 }));
    expect(okRun.T_NYATA_4).toMatchObject({ status: 'TERPENUHI', value: 0.8, n: 40, stage: 'DEVELOPING_REVERSAL', smallSample: false, detail: { stage: 'DEVELOPING_REVERSAL', ci: wilsonInterval(32, 40), baseline: 1 / 3, baselineN: 120 } });
    expect(okRun.T_NYATA_4.detail.diff).toBeCloseTo(0.8 - 1 / 3, 9);
    expect(okRun.T_NYATA_4.detail.expectancyAtr).toBeCloseTo(1.3, 9);
    expect(okRun.T_NYATA_4.text).toBe('T-NYATA-4 luar sampel (sel keputusan 5m, TF lain kontrol): SUCCESS DEVELOPING_REVERSAL pada LOW melampaui basis empiris subset (CI bawah > basis, selisih ≥ 3 poin, ekspektasi ATR > 0)');
    expect(okRun.T_NYATA_5).toMatchObject({ status: 'TERPENUHI', value: 0.8, n: 40, stage: null, smallSample: false, detail: { ci: wilsonInterval(32, 40), baseline: 1 / 3, baselineN: 120 } });
    expect(okRun.T_NYATA_5.detail).not.toHaveProperty('stage');
    expect(okRun.T_NYATA_5.detail.diff).toBeCloseTo(0.8 - 1 / 3, 9);
    expect(okRun.T_NYATA_5.detail.expectancyAtr).toBeCloseTo(1.3, 9);
    expect(okRun.T_NYATA_5.text).toBe('T-NYATA-5 luar sampel (sel keputusan 1h, TF lain kontrol): SUCCESS pada LOW melampaui basis empiris grup (CI bawah > basis, selisih ≥ 3 poin, ekspektasi ATR > 0)');
    // TIDAK terpenuhi hanya karena selisih: 200/200 SUCCESS → CI bawah 98,1 % > basis 97,5 %, tetapi selisih +2,5 poin < 3; ekspektasi +2 ATR.
    const smallDiff = t45(realLow('AAAUSDT', '15m', 200, { success: 200, baseline: b(39, 40) }));
    for (const id of ['T_NYATA_4', 'T_NYATA_5']) {
      expect(smallDiff[id], id).toMatchObject({ status: 'TIDAK_TERPENUHI', value: 1, n: 200, detail: { baseline: 0.975, baselineN: 8000, expectancyAtr: 2 } });
      expect(smallDiff[id].detail.ci[0], id).toBeGreaterThan(0.975);
      expect(smallDiff[id].detail.diff, id).toBeCloseTo(0.025, 9);
    }
    // TIDAK terpenuhi hanya karena ekspektasi: jarak stop 10 ATR → (32 × 2 − 8 × 10) / 40 = −0,40 ATR walau CI & selisih lolos; ekspektasi tepat 0 juga gagal (> 0 ketat).
    const negExp = t45(realLow('AAAUSDT', '15m', 40, { success: 32, stop: 10 }));
    for (const id of ['T_NYATA_4', 'T_NYATA_5']) {
      expect(negExp[id], id).toMatchObject({ status: 'TIDAK_TERPENUHI', value: 0.8, n: 40, detail: { baseline: 1 / 3 } });
      expect(negExp[id].detail.ci[0], id).toBeGreaterThan(1 / 3);
      expect(negExp[id].detail.expectancyAtr, id).toBeCloseTo(-0.4, 9);
    }
    const zeroExp = t45(realLow('AAAUSDT', '15m', 40, { success: 40, targetAtr: 0 }));
    expect(zeroExp.T_NYATA_4).toMatchObject({ status: 'TIDAK_TERPENUHI', value: 1, n: 40, detail: { expectancyAtr: 0 } });
    expect(zeroExp.T_NYATA_5).toMatchObject({ status: 'TIDAK_TERPENUHI', value: 1, n: 40, detail: { expectancyAtr: 0 } });
    // Toleransi float pada "≥ 3 poin": 1400/2000 − 0,67 = 0,029999999999999916 (< 0,03 dalam float) tetap TERPENUHI; CI bawah ≈ 68,0 % > 67 %.
    const edge = checkTargets([{ timeframe: '15m', scenario: 'dataNyata', ...summarizeCandidates([realLow('AAAUSDT', '15m', 2000, { success: 1400, baseline: b(67, 100) })], 'LOW') }], ['15m']);
    for (const id of ['T_NYATA_4', 'T_NYATA_5']) {
      const x = edge.find((y) => y.id === id);
      expect(x, id).toMatchObject({ status: 'TERPENUHI', value: 0.7, n: 2000, detail: { baseline: 0.67, baselineN: 200000 } });
      expect(x.detail.diff, id).toBeLessThan(0.03);
      expect(x.detail.diff, id).toBeCloseTo(0.03, 12);
    }
    // Tanpa data, tidak pernah melempar: (a) grup LOW tanpa kandidat DEVELOPING → T-NYATA-4 tanpa data, T-NYATA-5 tetap dinilai;
    const noDev = t45(realLow('AAAUSDT', '15m', 40, { success: 32, developing: 0 }));
    expect(noDev.T_NYATA_4).toMatchObject({ status: 'TANPA_DATA', value: null, n: 0, smallSample: false, detail: { stage: 'DEVELOPING_REVERSAL', ci: null, baseline: null, baselineN: 0, diff: null, expectancyAtr: null } });
    expect(noDev.T_NYATA_5).toMatchObject({ status: 'TERPENUHI', value: 0.8, n: 40 });
    // (b) tanpa basis empiris → keduanya tanpa data meski SUCCESS ada (n tetap 40);
    const noBase = t45(realLow('AAAUSDT', '15m', 40, { success: 32, baseline: null }));
    expect(noBase.T_NYATA_4).toMatchObject({ status: 'TANPA_DATA', value: 0.8, n: 40, detail: { baseline: null, baselineN: 0, diff: null } });
    expect(noBase.T_NYATA_5).toMatchObject({ status: 'TANPA_DATA', value: 0.8, n: 40, detail: { baseline: null, baselineN: 0, diff: null } });
    // (c) tanpa ekspektasi (semua SUCCESS tanpa targetAtr seri → tidak masuk rata-rata) → tanpa data walau CI & selisih ada;
    const noExp = t45(realLow('AAAUSDT', '15m', 40, { success: 40, targetAtr: null }));
    expect(noExp.T_NYATA_4).toMatchObject({ status: 'TANPA_DATA', value: 1, n: 40, detail: { baselineN: 120, expectancyAtr: null } });
    expect(noExp.T_NYATA_5).toMatchObject({ status: 'TANPA_DATA', value: 1, n: 40, detail: { baselineN: 120, expectancyAtr: null } });
    // (d) kandidat hanya lolos MEDIUM (skor 50–54) → grup LOW kosong: T-NYATA-4/5 tanpa data sementara T-NYATA-1 (MEDIUM) terpenuhi.
    const mediumOnly = aggregateReplay({ series: [real('AAAUSDT', '15m', 40, { success: 32, early: 10, lead: () => 5 })], meta: { source: 'binance' } });
    expect(mediumOnly.targets.find((x) => x.id === 'T_NYATA_1')).toMatchObject({ status: 'TERPENUHI', n: 40 });
    expect(mediumOnly.targets.filter((x) => x.id === 'T_NYATA_4' || x.id === 'T_NYATA_5').map((x) => [x.status, x.n])).toEqual([['TANPA_DATA', 0], ['TANPA_DATA', 0]]);
    // Render tabel §10 & ringkasan stdout: nilai memuat CI, basis (subset/grup), selisih poin & ekspektasi ATR; TF tanpa kandidat → tanpa data.
    const r = aggregateReplay({
      series: [realLow('AAAUSDT', '15m', 40, { success: 32 }), realLow('AAAUSDT', '1h', 40, { success: 32, stop: 10 }), real('AAAUSDT', '5m', 0, { success: 0, early: 0, lead: () => null })],
      meta: { source: 'binance', generatedAt: 0 },
    });
    const md = renderReplayReport(r);
    expect(md).not.toMatch(/NaN|undefined/);
    expect(md).toMatch(/\| 15m \| T-NYATA-4 luar sampel \(sel keputusan 5m, TF lain kontrol\): SUCCESS DEVELOPING_REVERSAL pada LOW melampaui basis empiris subset \(CI bawah > basis, selisih ≥ 3 poin, ekspektasi ATR > 0\) \| TERPENUHI \| SUCCESS 80,0% \(CI [\d,]+–[\d,]+ %\) vs basis empiris subset 33,3% \(selisih \+46,7 poin, ekspektasi \+1,30 ATR\), n = 40 \| — \|/);
    expect(md).toMatch(/\| 15m \| T-NYATA-5 luar sampel \(sel keputusan 1h, TF lain kontrol\): SUCCESS pada LOW melampaui basis empiris grup \(CI bawah > basis, selisih ≥ 3 poin, ekspektasi ATR > 0\) \| TERPENUHI \| SUCCESS 80,0% \(CI [\d,]+–[\d,]+ %\) vs basis empiris grup 33,3% \(selisih \+46,7 poin, ekspektasi \+1,30 ATR\), n = 40 \| — \|/);
    expect(md).toMatch(/\| 1h \| T-NYATA-4 luar sampel [^|]+ \| TIDAK terpenuhi \| SUCCESS 80,0% \(CI [\d,]+–[\d,]+ %\) vs basis empiris subset 33,3% \(selisih \+46,7 poin, ekspektasi −0,40 ATR\), n = 40 \| — \|/);
    expect(md).toContain('| 5m | T-NYATA-4 luar sampel (sel keputusan 5m, TF lain kontrol): SUCCESS DEVELOPING_REVERSAL pada LOW melampaui basis empiris subset (CI bawah > basis, selisih ≥ 3 poin, ekspektasi ATR > 0) | tanpa data | — | — |');
    expect(md).toContain('| 5m | T-NYATA-5 luar sampel (sel keputusan 1h, TF lain kontrol): SUCCESS pada LOW melampaui basis empiris grup (CI bawah > basis, selisih ≥ 3 poin, ekspektasi ATR > 0) | tanpa data | — | — |');
    const summary = renderReplaySummary(r);
    expect(summary).not.toMatch(/NaN|undefined/);
    expect(summary).toMatch(/\[§10\] 1h T-NYATA-5 luar sampel \(sel keputusan 1h, TF lain kontrol\): SUCCESS pada LOW melampaui basis empiris grup \(CI bawah > basis, selisih ≥ 3 poin, ekspektasi ATR > 0\): TIDAK terpenuhi \(SUCCESS 80,0% \(CI [\d,]+–[\d,]+ %\) vs basis empiris grup 33,3% \(selisih \+46,7 poin, ekspektasi −0,40 ATR\), n = 40\)/);
  });
});
