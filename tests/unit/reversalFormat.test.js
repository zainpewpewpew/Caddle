import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS, EVIDENCE_IDS, EVIDENCE_LABELS, LIQUIDITY_CLASSES, LIQUIDITY_LABELS, RISKS, RISK_LABELS, SETUP_TYPES,
  SETUP_TYPE_LABELS, STAGES, STAGE_LABELS, STATUSES, STATUS_LABELS, applyFilters, buildReversalQuery, candleStatusBadge,
  candleStatusOf, countsByTimeframe, diffRows, effectiveStage, evidenceCell, evidenceLabel, evidencePreview,
  formatTimeframeCounts, groupByStage, historyEntries, importantLevels, lastEvaluatedAtOf, levelsOf, markersOf, moveCell,
  moveInfo, normalizeFilters, normalizeScoreComponents, readFilters, riskLabel, rowKey, scoreComponentBars, scoreValue,
  snapshotOf, stageLabel, statusPill,
} from '../../frontend/js/views/reversalFormat.js';
import { installFakeDom } from './smartmoney/helpers/fakeDom.js';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

/** Baris `toView` minimal (docs/19 §5); field lain diisi sesuai kebutuhan tes. */
const row = (over = {}) => ({
  id: 1, symbol: 'ABCUSDT', timeframe: '15m', stage: 'EARLY_FORMATION', status: 'NEW', setupType: 'COMPRESSION', score: 52,
  scoreComponents: [], evidence: [{ id: 'LL_SHALLOWER', label: 'Lower low makin dangkal', group: 'EXHAUSTION' }, { id: 'ATR_CONTRACTION' }, { id: 'VOLUME_DRY_UP' }],
  evidenceCount: 3, firstDetectedAt: NOW - 3_600_000, firstDetectedPrice: 1.2, levels: {}, risks: [], liquidityClass: 'LIQUID',
  extended: false, moveSinceDetectionPct: 0.012, moveSinceDetectionAtr: 0.6, markers: [], provisional: null, provisionalOnly: false,
  candleStatus: 'CLOSED', lastEvaluatedAt: NOW - 60_000, updatedAt: NOW - 60_000, ...over,
});
const provisionalOnly = (over = {}) => row({
  id: null, symbol: 'PRVUSDT', provisionalOnly: true, stage: 'DEVELOPING_REVERSAL', status: null, score: null, firstDetectedAt: null,
  lastEvaluatedAt: null, candleStatus: 'RUNNING', moveSinceDetectionPct: null, moveSinceDetectionAtr: null,
  provisional: { stage: 'DEVELOPING_REVERSAL', score: 58.4, evaluatedAt: NOW - 10_000, candleOpenTime: NOW - 300_000, evidenceCount: 4, evidence: [], risks: ['PROVISIONAL'] },
  ...over,
});

describe('reversalFormat — label Indonesia', () => {
  it('UNIT-RRF-001 setiap konstanta kontrak punya label; kode tak dikenal tetap terbaca, kosong → tanda kosong', () => {
    for (const id of EVIDENCE_IDS) expect(EVIDENCE_LABELS[id], id).toBeTruthy();
    for (const id of RISKS) expect(RISK_LABELS[id], id).toBeTruthy();
    for (const id of SETUP_TYPES) expect(SETUP_TYPE_LABELS[id], id).toBeTruthy();
    for (const id of STATUSES) expect(STATUS_LABELS[id], id).toBeTruthy();
    for (const id of LIQUIDITY_CLASSES) expect(LIQUIDITY_LABELS[id], id).toBeTruthy();
    for (const stage of STAGES) {
      expect(STAGE_LABELS[stage].title).toMatch(/^(Early Formation|Developing Reversal|Confirmed Breakout)$/);
      expect(STAGE_LABELS[stage].text.length).toBeGreaterThan(20);
    }
    expect(STATUS_LABELS).toEqual({ NEW: 'Baru', DEVELOPING: 'Berkembang', CONFIRMED: 'Terkonfirmasi', CANCELLED: 'Batal', EXPIRED: 'Kedaluwarsa' });
    expect(stageLabel('EARLY_FORMATION')).toBe('Early Formation');
    expect(evidenceLabel('KODE_BARU')).toBe('KODE BARU');
    expect(riskLabel(null)).toBe('—');
  });
});

describe('reversalFormat — pengelompokan & jumlah', () => {
  it('UNIT-RRF-002 groupByStage: urutan tahap tetap, provisional-only ikut tahap evaluasinya, tahap tak dikenal → other', () => {
    const rows = [row({ stage: 'CONFIRMED_BREAKOUT' }), row({ symbol: 'B' }), provisionalOnly(), row({ symbol: 'X', stage: 'TAHAP_LAIN' })];
    const groups = groupByStage(rows);
    expect(Object.keys(groups)).toEqual(['EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT', 'other']);
    expect(groups.EARLY_FORMATION.map((r) => r.symbol)).toEqual(['B']);
    expect(groups.DEVELOPING_REVERSAL.map((r) => r.symbol)).toEqual(['PRVUSDT']);
    expect(groups.CONFIRMED_BREAKOUT).toHaveLength(1);
    expect(groups.other.map((r) => r.symbol)).toEqual(['X']);
    expect(effectiveStage(provisionalOnly({ stage: null }))).toBe('DEVELOPING_REVERSAL');
    expect(groupByStage(null)).toEqual({ EARLY_FORMATION: [], DEVELOPING_REVERSAL: [], CONFIRMED_BREAKOUT: [], other: [] });
  });

  it('UNIT-RRF-003 countsByTimeframe selalu memuat ketiga timeframe; formatTimeframeCounts "5m 3 · 15m 2 · 1H 1"', () => {
    const rows = [row({ timeframe: '5m' }), row({ timeframe: '5m' }), row({ timeframe: '5m' }), row(), row(), row({ timeframe: '1h' }), row({ timeframe: '4h' })];
    const counts = countsByTimeframe(rows);
    expect(counts).toEqual({ '5m': 3, '15m': 2, '1h': 1, total: 7 });
    expect(formatTimeframeCounts(counts)).toBe('5m 3 · 15m 2 · 1H 1');
    expect(formatTimeframeCounts(countsByTimeframe([]))).toBe('5m 0 · 15m 0 · 1H 0');
  });
});

describe('reversalFormat — filter & query (docs/19 §7–§8.3)', () => {
  it('UNIT-RRF-004 buildReversalQuery: default eksplisit; semua filter dikirim; nilai tak dikenal → default', () => {
    expect(buildReversalQuery(DEFAULT_FILTERS)).toBe('/api/reversal/candidates?sensitivity=MEDIUM&includeExtended=1&includeProvisional=1&limit=500');
    expect(buildReversalQuery({ timeframe: '5m', stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING', liquidity: 'THIN', sensitivity: 'LOW', hideExtended: true, showProvisional: false }))
      .toBe('/api/reversal/candidates?timeframe=5m&stage=DEVELOPING_REVERSAL&status=DEVELOPING&liquidity=THIN&sensitivity=LOW&includeExtended=0&includeProvisional=0&limit=500');
    expect(normalizeFilters({ timeframe: '4h', stage: 'X', status: 'CANCELLED', liquidity: 'ILLIQUID', sensitivity: 'ULTRA', hideExtended: 'true', showProvisional: 'false' }))
      .toEqual({ timeframe: '', stage: '', status: '', liquidity: '', sensitivity: 'MEDIUM', hideExtended: true, showProvisional: false });
    expect(normalizeFilters('rusak')).toEqual(DEFAULT_FILTERS);
    expect(buildReversalQuery(null, { limit: 50 })).toContain('limit=50');
  });

  it('UNIT-RRF-004b readFilters membaca form (elements by name) termasuk toggle checkbox', () => {
    const elements = {
      timeframe: { value: '1h' }, stage: { value: '' }, status: { value: 'CONFIRMED' }, liquidity: { value: 'LIQUID' },
      sensitivity: { value: 'HIGH' }, hideExtended: { checked: true }, showProvisional: { checked: false },
    };
    expect(readFilters({ elements })).toEqual({ timeframe: '1h', stage: '', status: 'CONFIRMED', liquidity: 'LIQUID', sensitivity: 'HIGH', hideExtended: true, showProvisional: false });
    expect(buildReversalQuery({ elements })).toBe('/api/reversal/candidates?timeframe=1h&status=CONFIRMED&liquidity=LIQUID&sensitivity=HIGH&includeExtended=0&includeProvisional=0&limit=500');
    expect(readFilters(null)).toEqual(DEFAULT_FILTERS);
  });

  it('UNIT-RRF-005 applyFilters = penjaga kontrak: timeframe, tahap, status, likuiditas minimum, extended, provisional', () => {
    const rows = [
      row({ symbol: 'A', timeframe: '5m' }),
      row({ symbol: 'B', stage: 'CONFIRMED_BREAKOUT', status: 'CONFIRMED', extended: true }),
      row({ symbol: 'C', liquidityClass: 'THIN', risks: ['EXTENDED'] }),
      row({ symbol: 'D', liquidityClass: 'ILLIQUID' }),
      provisionalOnly({ symbol: 'P' }),
    ];
    const names = (list) => list.map((r) => r.symbol);
    expect(names(applyFilters(rows, DEFAULT_FILTERS))).toEqual(['A', 'B', 'C', 'D', 'P']);
    expect(names(applyFilters(rows, { timeframe: '5m' }))).toEqual(['A']);
    expect(names(applyFilters(rows, { stage: 'CONFIRMED_BREAKOUT' }))).toEqual(['B']);
    expect(names(applyFilters(rows, { status: 'DEVELOPING' }))).toEqual(['P']);
    expect(names(applyFilters(rows, { liquidity: 'THIN' }))).toEqual(['A', 'B', 'C', 'P']);
    expect(names(applyFilters(rows, { liquidity: 'LIQUID' }))).toEqual(['A', 'B', 'P']);
    expect(names(applyFilters(rows, { hideExtended: true }))).toEqual(['A', 'D', 'P']);
    expect(names(applyFilters(rows, { showProvisional: false }))).toEqual(['A', 'B', 'C', 'D']);
    expect(applyFilters(undefined, {})).toEqual([]);
  });
});

describe('reversalFormat — diff antarpolling', () => {
  it('UNIT-RRF-006 diffRows: baru, naik tahap, provisional → kandidat, skor naik/turun; muatan pertama tanpa sorotan', () => {
    const before = [row({ symbol: 'A' }), row({ symbol: 'B', score: 50 }), row({ symbol: 'C', score: 70 }), provisionalOnly({ symbol: 'P' }), row({ symbol: 'S', score: 40 })];
    const after = [
      row({ symbol: 'A', stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING' }), // naik tahap
      row({ symbol: 'B', score: 55 }), // skor naik
      row({ symbol: 'C', score: 64 }), // skor turun
      row({ symbol: 'P', score: 58 }), // provisional menjadi kandidat (id nyata)
      row({ symbol: 'S', score: 40.3 }), // tidak berubah setelah pembulatan
      row({ symbol: 'N' }), // baru
    ];
    const diff = diffRows(snapshotOf(before), after);
    expect([...diff.entries()]).toEqual([['A|15m', 'up'], ['B|15m', 'up'], ['C|15m', 'down'], ['P|15m', 'up'], ['N|15m', 'new']]);
    expect(diffRows(null, after).size).toBe(0);
    expect(rowKey(row({ symbol: 'Z', timeframe: '1h' }))).toBe('Z|1h');
  });
});

describe('reversalFormat — nilai baris', () => {
  it('UNIT-RRF-007 moveInfo, scoreValue, candleStatusOf, lastEvaluatedAtOf: nilai hilang → null, bukan 0 palsu', () => {
    expect(moveInfo(row({ extended: true, risks: ['LATE_ENTRY'] }))).toEqual({ pct: 0.012, atr: 0.6, extended: true, late: true });
    expect(moveInfo(row({ moveSinceDetectionPct: null, moveSinceDetectionAtr: Number.NaN, risks: ['EXTENDED'] }))).toEqual({ pct: null, atr: null, extended: true, late: false });
    expect(scoreValue(row({ score: 63.6 }))).toBe(64);
    expect(scoreValue(row({ score: 140 }))).toBe(100);
    expect(scoreValue(provisionalOnly())).toBe(58);
    expect(scoreValue(row({ score: null }))).toBeNull();
    expect(candleStatusOf(row())).toBe('CLOSED');
    expect(candleStatusOf(provisionalOnly({ candleStatus: undefined }))).toBe('RUNNING');
    expect(lastEvaluatedAtOf(row())).toBe(NOW - 60_000);
    expect(lastEvaluatedAtOf(provisionalOnly())).toBe(NOW - 10_000);
    expect(lastEvaluatedAtOf({})).toBeNull();
    expect(evidencePreview(row())).toEqual({ count: 3, labels: ['Lower low makin dangkal', 'Kontraksi ATR'], more: 1 });
  });

  it('UNIT-RRF-008 level & penanda grafik: nilai kosong dilewati; event riwayat → penanda; tanpa marker DETECTED → titik deteksi pertama', () => {
    const r = row({ levels: { bottom: 1.0, lastSwingLow: 1.05, higherLow: null, trigger: 1.3, ema25: 1.1, ema7: 1.12, atr: 0.02, invalidation: 0.98 }, peakPrice: 1.25 });
    expect(levelsOf(r)).toEqual([
      { price: 0.98, kind: 'invalidation' }, { price: 1.0, kind: 'support', label: 'Bottom' }, { price: 1.3, kind: 'resistance', label: 'Trigger' }, { price: 1.2, kind: 'detected' },
    ]);
    expect(levelsOf(row({ levels: { invalidation: -1 }, firstDetectedPrice: null }))).toEqual([]);
    expect(importantLevels(r).map((l) => l.label)).toEqual(['Invalidasi', 'Bottom', 'Swing low terakhir', 'Level pemicu (trigger)', 'EMA25', 'EMA7', 'ATR', 'Harga deteksi pertama', 'Harga tertinggi sejak deteksi']);

    const markers = markersOf(row({ markers: [{ time: 100, kind: 'BOTTOM', price: 1, label: 'Bottom' }, { time: 'x', kind: 'SPRING' }] }), [
      { type: 'OPENED', candleTime: 200, occurredAt: 299 }, { type: 'STAGE_UP', candleTime: 300 }, { type: 'PROVISIONAL_STAGE', occurredAt: 400, provisional: true }, { type: 'LAIN', candleTime: 500 },
    ]);
    expect(markers).toEqual([{ time: 100, kind: 'BOTTOM' }, { time: 200, kind: 'DETECTED' }, { time: 300, kind: 'STAGE_UP' }, { time: 400, kind: 'PROVISIONAL' }]);
    expect(markersOf(row({ markers: [] }), [])).toEqual([{ time: NOW - 3_600_000, kind: 'DETECTED' }]);
    expect(markersOf(provisionalOnly(), [])).toEqual([]);
  });

  it('UNIT-RRF-008b historyEntries urut waktu, provisional & alasan batal berlabel Indonesia', () => {
    const entries = historyEntries([
      { type: 'CANCELLED', fromStage: 'DEVELOPING_REVERSAL', toStage: null, toStatus: 'CANCELLED', occurredAt: 300, price: 0.9, reason: 'CLOSE_BELOW_INVALIDATION' },
      { type: 'OPENED', toStage: 'EARLY_FORMATION', toStatus: 'NEW', candleTime: 100, occurredAt: 199, price: 1 },
      { type: 'PROVISIONAL_STAGE', fromStage: 'EARLY_FORMATION', toStage: 'DEVELOPING_REVERSAL', occurredAt: 250, provisional: true },
      null, { type: 42 },
    ]);
    expect(entries.map((e) => [e.at, e.title, e.stage, e.provisional, e.terminal])).toEqual([
      [199, 'Kandidat dibuka', 'Early Formation', false, false],
      [250, 'Tahap provisional (candle berjalan)', 'Early Formation → Developing Reversal', true, false],
      [300, 'Batal', null, false, true],
    ]);
    expect(entries[2].reason).toBe('Close di bawah level invalidasi');
    expect(entries[0].status).toBe('Baru');
  });

  it('UNIT-RRF-008c historyEntries melipat perubahan provisional berurutan menjadi entri terakhir dengan jumlah perubahan', () => {
    const prov = (at, from, to) => ({ type: 'PROVISIONAL_STAGE', fromStage: from, toStage: to, occurredAt: at, provisional: true });
    const entries = historyEntries([
      { type: 'OPENED', toStage: 'EARLY_FORMATION', toStatus: 'NEW', occurredAt: 100, price: 1 },
      prov(110, 'EARLY_FORMATION', 'DEVELOPING_REVERSAL'),
      prov(120, 'DEVELOPING_REVERSAL', 'EARLY_FORMATION'),
      prov(130, 'EARLY_FORMATION', 'DEVELOPING_REVERSAL'),
      { type: 'STAGE_UP', fromStage: 'EARLY_FORMATION', toStage: 'DEVELOPING_REVERSAL', toStatus: 'DEVELOPING', occurredAt: 200, price: 1.1 },
      prov(210, 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT'),
    ]);
    expect(entries.map((e) => [e.at, e.provisional, e.changes])).toEqual([[100, false, 1], [130, true, 3], [200, false, 1], [210, true, 1]]);
    expect(entries[1].title).toBe('Tahap provisional (candle berjalan) · 3 perubahan berurutan');
    expect(entries[1].stage).toBe('Early Formation → Developing Reversal');
    expect(entries[3].title).toBe('Tahap provisional (candle berjalan)');
  });

  it('UNIT-RRF-009 normalizeScoreComponents selalu 5 grup berurutan, poin dibatasi 0..max, label grup Indonesia', () => {
    const out = normalizeScoreComponents([{ id: 'STRUCTURE', label: 'Struktur', points: 42, max: 30 }, { id: 'VOLUME', points: -3 }, { id: 'ASING', points: 9 }]);
    expect(out.map((c) => c.id)).toEqual(['EXHAUSTION', 'BASE', 'STRUCTURE', 'VOLUME', 'TRIGGER']);
    expect(out.map((c) => c.points)).toEqual([0, 0, 30, 0, 0]);
    expect(out.map((c) => c.max)).toEqual([25, 25, 30, 10, 10]);
    expect(out[0].label).toBe('Tekanan turun melemah');
    expect(out[2].label).toBe('Struktur');
  });
});

describe('reversalFormat — helper DOM (DOM tiruan)', () => {
  let dom;
  afterEach(() => dom?.uninstall());

  it('UNIT-RRF-010 statusPill: label status; provisional-only berlabel "provisional"; tahap candle berjalan lebih tinggi → petunjuk', () => {
    dom = installFakeDom();
    const plain = statusPill(row());
    expect(plain.getAttribute('data-status')).toBe('NEW');
    expect(plain.textContent).toBe('Baru');
    const prov = statusPill(provisionalOnly());
    expect(prov.textContent).toContain('provisional');
    expect(prov.querySelector('[data-testid="rr-provisional-label"]')).not.toBeNull();
    const hinted = statusPill(row({ provisional: { stage: 'CONFIRMED_BREAKOUT', score: 70 } }));
    expect(hinted.querySelector('.rr-pill__hint').textContent).toBe('→ Confirmed (berjalan)');
    expect(statusPill(row({ provisional: { stage: 'EARLY_FORMATION' } })).querySelector('.rr-pill__hint')).toBeNull();
  });

  it('UNIT-RRF-011 moveCell, candleStatusBadge, evidenceCell, scoreComponentBars', () => {
    dom = installFakeDom();
    const move = moveCell(row({ extended: true, risks: ['LATE_ENTRY'] }));
    expect(move.querySelector('.rr-move__text').textContent).toBe('+1,20% · 0,6×ATR');
    expect([...move.querySelectorAll('.rr-move__badge')].map((b) => b.textContent)).toEqual(['Extended', 'Terlambat']);
    expect(moveCell(provisionalOnly()).textContent).toBe('—');
    expect(candleStatusBadge(row()).textContent).toBe('Tutup');
    expect(candleStatusBadge(provisionalOnly()).textContent).toBe('Berjalan');
    const cell = evidenceCell(row());
    expect(cell.textContent).toBe('3Lower low makin dangkal, Kontraksi ATR +1');
    const bars = scoreComponentBars([{ id: 'EXHAUSTION', points: 13, max: 25 }]);
    expect(bars.querySelectorAll('.rr-bar')).toHaveLength(5);
    expect(bars.querySelector('.rr-bar[data-group="EXHAUSTION"] .rr-bar__value').textContent).toBe('13/25');
  });
});
