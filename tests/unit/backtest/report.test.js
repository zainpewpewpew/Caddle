import { describe, expect, it } from 'vitest';
import { collectWarnings, fmtNumber, fmtPct, renderMarkdownReport } from '../../../backend/backtest/report.js';

// Objek contoh berbentuk hasil runner — angka fiktif, hanya untuk menguji render.
const s = (n, winRate, ci, expectancyR, profitFactor, extra = {}) => ({
  n, wins: Math.round(n * winRate), losses: n - Math.round(n * winRate), timeouts: 0,
  winRate, winRateCi: ci, expectancyR, profitFactor, avgMfeR: 1.4, avgMaeR: -0.6, ...extra,
});

function sample() {
  return {
    meta: {
      generatedAt: Date.UTC(2026, 9, 26, 8, 0, 0), source: 'binance', symbols: ['BTCUSDT', 'ETHUSDT'], timeframes: ['15m', '1h'],
      from: '2024-01-01', to: '2025-10-01', targetR: 2, maxBars: 48, folds: 5, embargoBars: 48,
    },
    variants: {
      v3: {
        label: 'Sesudah — v3 confluence tier A/B',
        trainSummary: s(400, 0.46, [0.41, 0.51], 0.38, 1.7),
        testSummary: s(180, 0.44, [0.37, 0.51], 0.32, 1.57),
        byTier: { B: { train: s(250, 0.43, [0.37, 0.49], 0.29, 1.5), test: s(120, 0.41, [0.33, 0.5], 0.23, 1.39) }, A: { train: s(150, 0.51, [0.43, 0.59], 0.53, 2.08), test: s(20, 0.55, [0.34, 0.74], 0.65, Infinity) } },
        byDirection: { SHORT: { test: s(80, 0.42, [0.32, 0.53], 0.26, 1.45) }, LONG: { test: s(100, 0.46, [0.36, 0.56], 0.38, 1.7) } },
        byGroup: [
          { direction: 'SHORT', timeframe: '1h', tier: 'A', test: s(12, 0.5, [0.25, 0.75], 0.5, 2) },
          { direction: 'LONG', timeframe: '15m', tier: 'B', train: s(90, 0.42, [0.32, 0.52], 0.26, 1.45), test: s(40, 0.4, [0.26, 0.55], 0.2, 1.33) },
        ],
        calibration: {
          ece: 0.04, brier: 0.2391, brierBaseline: 0.2464, sample: 'test',
          bins: [{ lower: 60, upper: 75, n: 110, predicted: 0.4, observed: 0.42, ci: [0.33, 0.51] }, { lower: 75, upper: 100, n: 20, predicted: 0.52, observed: 0.55, ci: [0.34, 0.74] }],
        },
      },
      v2: {
        label: 'Sebelum — pola v2 saja',
        trainSummary: s(900, 0.37, [0.34, 0.4], 0.11, 1.17),
        testSummary: s(420, 0.35, [0.3, 0.4], 0.05, 1.08),
      },
    },
  };
}

describe('renderMarkdownReport', () => {
  it('UNIT-BTRP-001 memuat bagian utama dan memisahkan in-sample/out-of-sample', () => {
    const md = renderMarkdownReport(sample());
    for (const heading of ['# Laporan Backtest AlphaLens', '## Parameter', '## Peringatan kejujuran', '## Perbandingan sebelum vs sesudah',
      '## Varian: Sebelum — pola v2 saja', '## Varian: Sesudah — v3 confluence tier A/B', '### Per arah × timeframe × tier', '### Per tier', '## Kalibrasi']) {
      expect(md).toContain(heading);
    }
    expect(md.indexOf('## Varian: Sebelum')).toBeLessThan(md.indexOf('## Varian: Sesudah'));
    expect(md).toContain('| Out-of-sample (test) | 180 | 44,0% | 37,0–51,0% | +0,32R | 1,57 | +1,40R | −0,60R | 79/101/0 |');
    expect(md).toContain('In-sample (train)');
    expect(md).toContain('WR +9,0 pp; E +0,27R');
    expect(md).toContain('ECE: **4,0%** · Brier: **0,2391**');
    expect(md).toContain('∞'); // profit factor tanpa kerugian
    // Urutan tabel grup: LONG sebelum SHORT, tier A sebelum B.
    expect(md.indexOf('| LONG | 15m | B |')).toBeLessThan(md.indexOf('| SHORT | 1h | A |'));
  });

  it('UNIT-BTRP-002 peringatan otomatis: sampel kecil, CI lebar, sintetis, overfitting, tanpa OOS', () => {
    const r = sample();
    r.meta.source = 'synthetic';
    r.variants.v2.trainSummary.winRate = 0.6;
    r.variants.extra = { trainSummary: s(50, 0.5, [0.37, 0.63], 0.5, 2), testSummary: null };
    const w = collectWarnings(r);
    expect(w.some((x) => x.includes('sintetis'))).toBe(true);
    expect(w.some((x) => x.includes('tier A') && x.includes('sampel terlalu kecil'))).toBe(true);
    expect(w.some((x) => x.includes('pola v2') && x.includes('overfitting'))).toBe(true);
    expect(w.some((x) => x.startsWith('extra: tidak ada hasil out-of-sample'))).toBe(true);
    const md = renderMarkdownReport(r);
    expect(md).toContain('sampel terlalu kecil');
    expect(md).toContain('CI lebar');
  });

  it('UNIT-BTRP-003 tanpa varian pembanding → pesan jelas; input tidak valid ditolak', () => {
    const md = renderMarkdownReport({ meta: {}, variants: { v3: { trainSummary: null, testSummary: null } } });
    expect(md).toContain('Perbandingan tidak tersedia');
    expect(md).toContain('_Tidak ada data kalibrasi._');
    expect(() => renderMarkdownReport(null)).toThrow(TypeError);
  });

  it('UNIT-BTRP-004 format angka Indonesia & sel aman dari karakter pipa', () => {
    expect(fmtNumber(-1.5)).toBe('−1,50');
    expect(fmtNumber(null)).toBe('—');
    expect(fmtPct(0.4567)).toBe('45,7%');
    const md = renderMarkdownReport({ meta: {}, variants: { v: { testSummary: null, byTier: { 'X|Y': { test: s(40, 0.5, [0.35, 0.65], 0, 1) } } } } });
    expect(md).toContain('| X/Y | Out-of-sample (test) |');
  });

  it('UNIT-BTRP-005 snapshot laporan contoh (deterministik)', () => {
    expect(renderMarkdownReport(sample())).toMatchSnapshot();
  });
});
