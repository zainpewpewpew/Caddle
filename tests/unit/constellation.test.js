import { describe, expect, it } from 'vitest';
import {
  describeConstellation, diffNewSignals, hash32, hitTest, layoutConstellation, normalizeSignals, PULSE_STATES, signalHref,
} from '../../frontend/js/views/constellation.js';
import { stageDistribution } from '../../frontend/js/views/overview.js';

const LONG_ITEMS = [
  { id: 1, symbol: 'BTCUSDT', timeframe: '15m', direction: 'LONG', state: 'BREAKOUT', earlyScore: 92, classification: 'SA' },
  { id: 2, symbol: 'BTCUSDT', timeframe: '1h', direction: 'LONG', state: 'MOMENTUM_BUILDING', earlyScore: 71, classification: 'PVA' },
  { id: 3, symbol: 'ETHUSDT', timeframe: '5m', direction: 'LONG', state: 'QUIET', earlyScore: 12, classification: 'SA' },
  { id: 4, symbol: 'SOLUSDT', timeframe: '5m', direction: 'LONG', state: 'QUIET', earlyScore: 40, classification: 'BOTH' },
];
const SHORT_ITEMS = [
  { id: 10, symbol: 'DOGEUSDT', timeframe: '15m', state: 'BREAKDOWN', earlyScore: 88, classification: 'SD' },
  { id: 11, symbol: 'BTCUSDT', timeframe: '5m', state: 'EARLY_BEARISH', earlyScore: 55, classification: 'PVD' },
];
const all = () => [...normalizeSignals(LONG_ITEMS, 'LONG'), ...normalizeSignals(SHORT_ITEMS, 'SHORT')];

describe('normalizeSignals', () => {
  it('UNIT-CONST-001 membuang item tanpa simbol/TF/tahap terbuka, menjepit skor, arah dari fallback', () => {
    const out = normalizeSignals([
      { id: 1, symbol: 'AAAUSDT', timeframe: '5m', state: 'QUIET', earlyScore: 140 },
      { id: 2, symbol: 'BBBUSDT', timeframe: '5m', state: 'INVALIDATED', earlyScore: 50 },
      { id: 3, timeframe: '5m', state: 'QUIET' },
      { id: 4, symbol: 'CCCUSDT', timeframe: '1h', state: 'BREAKDOWN', earlyScore: null },
      null,
      'x',
    ], 'SHORT');
    expect(out.map((s) => s.symbol)).toEqual(['AAAUSDT', 'CCCUSDT']);
    expect(out[0].earlyScore).toBe(100);
    expect(out[1].earlyScore).toBeNull();
    expect(out.every((s) => s.direction === 'SHORT')).toBe(true);
  });

  it('UNIT-CONST-002 input bukan array → kosong (tanpa node palsu)', () => {
    expect(normalizeSignals(null)).toEqual([]);
    expect(normalizeSignals(undefined)).toEqual([]);
    expect(layoutConstellation([], 800, 400).nodes).toEqual([]);
    expect(layoutConstellation([], 800, 400).edges).toEqual([]);
  });
});

describe('layoutConstellation', () => {
  it('UNIT-CONST-003 deterministik dan tidak bergantung urutan input', () => {
    const a = layoutConstellation(all(), 900, 420);
    const b = layoutConstellation([...all()].reverse(), 900, 420);
    expect(b).toEqual(a);
    expect(layoutConstellation(all(), 900, 420)).toEqual(a);
  });

  it('UNIT-CONST-004 satu node per sinyal nyata; LONG di kiri, SHORT di kanan (horizontal)', () => {
    const l = layoutConstellation(all(), 900, 420);
    expect(l.orientation).toBe('horizontal');
    expect(l.nodes).toHaveLength(6);
    for (const n of l.nodes) {
      if (n.direction === 'LONG') expect(n.x).toBeLessThan(450);
      else expect(n.x).toBeGreaterThan(450);
      expect(n.x).toBeGreaterThanOrEqual(n.r);
      expect(n.x).toBeLessThanOrEqual(900 - n.r);
      expect(n.y).toBeGreaterThanOrEqual(n.r);
      expect(n.y).toBeLessThanOrEqual(420 - n.r);
    }
  });

  it('UNIT-CONST-005 layar sempit → vertikal: LONG atas, SHORT bawah', () => {
    const l = layoutConstellation(all(), 360, 520);
    expect(l.orientation).toBe('vertical');
    for (const n of l.nodes) {
      if (n.direction === 'LONG') expect(n.y).toBeLessThan(260);
      else expect(n.y).toBeGreaterThan(260);
    }
  });

  it('UNIT-CONST-006 ukuran ∝ early score; BREAKOUT/BREAKDOWN berdenyut', () => {
    const l = layoutConstellation(all(), 900, 420);
    const by = (sym, tf) => l.nodes.find((n) => n.symbol === sym && n.timeframe === tf);
    expect(by('BTCUSDT', '15m').r).toBeGreaterThan(by('BTCUSDT', '1h').r);
    expect(by('BTCUSDT', '1h').r).toBeGreaterThan(by('ETHUSDT', '5m').r);
    expect(l.nodes.filter((n) => n.pulse).map((n) => n.state).sort()).toEqual(['BREAKDOWN', 'BREAKOUT']);
    expect([...PULSE_STATES].sort()).toEqual(['BREAKDOWN', 'BREAKOUT']);
  });

  it('UNIT-CONST-007 tahap lanjut lebih dekat ke inti klaster', () => {
    const l = layoutConstellation(all(), 900, 420);
    const c = l.clusters.LONG;
    const dist = (n) => Math.hypot(n.x - c.cx, n.y - c.cy);
    const breakout = l.nodes.find((n) => n.state === 'BREAKOUT');
    const quiet = l.nodes.filter((n) => n.direction === 'LONG' && n.state === 'QUIET');
    for (const q of quiet) expect(dist(breakout)).toBeLessThan(dist(q));
  });

  it('UNIT-CONST-008 edge: simbol sama selalu tersambung (termasuk lintas arah); tahap sama tersambung', () => {
    const l = layoutConstellation(all(), 900, 420);
    const pairs = l.edges.map((e) => [l.nodes[e.a], l.nodes[e.b], e.kind]);
    const btc = pairs.filter(([a, b, k]) => k === 'symbol' && a.symbol === 'BTCUSDT' && b.symbol === 'BTCUSDT');
    expect(btc.length).toBe(2); // 3 node BTC → rantai 2 edge
    expect(pairs.some(([a, b, k]) => k === 'stage' && a.state === 'QUIET' && b.state === 'QUIET')).toBe(true);
    for (const e of l.edges) {
      expect(e.a).not.toBe(e.b);
      expect(e.a).toBeLessThan(e.b);
    }
    expect(new Set(l.edges.map((e) => `${e.a}-${e.b}`)).size).toBe(l.edges.length);
  });

  it('UNIT-CONST-009 banyak sinyal: tidak ada NaN, tetap di dalam kanvas, minim tumpang tindih', () => {
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: i, symbol: `S${i % 120}USDT`, timeframe: ['5m', '15m', '1h'][i % 3], state: ['QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT'][i % 4], earlyScore: (i * 37) % 101,
    }));
    const l = layoutConstellation(normalizeSignals(items, 'LONG'), 1000, 440);
    expect(l.nodes).toHaveLength(300);
    for (const n of l.nodes) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.r)).toBe(true);
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(1000);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(440);
    }
    // Derajat edge non-simbol dibatasi agar tetap terbaca.
    expect(l.edges.length).toBeLessThanOrEqual(300 * 3);
  });

  it('UNIT-CONST-010 ukuran tidak valid tidak melempar', () => {
    expect(() => layoutConstellation(all(), 0, Number.NaN)).not.toThrow();
  });
});

describe('interaksi & aktivitas', () => {
  it('UNIT-CONST-011 hitTest menemukan node terdekat dalam radius, null di luar', () => {
    const nodes = [{ key: 'a', x: 10, y: 10, r: 5 }, { key: 'b', x: 18, y: 10, r: 5 }];
    expect(hitTest(nodes, 11, 10).key).toBe('a');
    expect(hitTest(nodes, 17, 10).key).toBe('b');
    expect(hitTest(nodes, 100, 100)).toBeNull();
  });

  it('UNIT-CONST-012 signalHref menuju Symbol Intelligence dengan s/tf/dir', () => {
    expect(signalHref({ symbol: 'BTCUSDT', timeframe: '15m', direction: 'SHORT' })).toBe('#/symbol?s=BTCUSDT&tf=15m&dir=SHORT');
  });

  it('UNIT-CONST-013 diffNewSignals: muatan pertama tidak memicu; hanya sinyal baru yang dihitung per arah', () => {
    const first = diffNewSignals(null, all());
    expect(first.added).toEqual([]);
    const next = [...all(), ...normalizeSignals([{ id: 99, symbol: 'XRPUSDT', timeframe: '1h', state: 'QUIET', earlyScore: 30 }], 'SHORT')];
    const d = diffNewSignals(first.keys, next);
    expect(d.bull).toBe(0);
    expect(d.bear).toBe(1);
    expect(d.added[0].symbol).toBe('XRPUSDT');
    expect(diffNewSignals(d.keys, next).added).toEqual([]);
  });

  it('UNIT-CONST-014 ringkasan aksesibel jujur, termasuk saat kosong', () => {
    expect(describeConstellation([])).toMatch(/belum ada sinyal aktif/);
    const text = describeConstellation(all());
    expect(text).toContain('6 sinyal aktif');
    expect(text).toContain('4 LONG (1 BREAKOUT)');
    expect(text).toContain('2 SHORT (1 BREAKDOWN)');
  });

  it('UNIT-CONST-015 hash32 stabil', () => {
    expect(hash32('BTCUSDT')).toBe(hash32('BTCUSDT'));
    expect(hash32('BTCUSDT')).not.toBe(hash32('ETHUSDT'));
  });

  it('UNIT-CONST-016 distribusi tahap Overview dari sinyal nyata', () => {
    const d = stageDistribution(all());
    expect(d.LONG.total).toBe(4);
    expect(d.SHORT.total).toBe(2);
    expect(d.LONG.stages.find((s) => s.state === 'QUIET').count).toBe(2);
    expect(d.SHORT.stages.find((s) => s.state === 'BREAKDOWN').count).toBe(1);
    expect(stageDistribution([]).LONG.total).toBe(0);
  });
});
