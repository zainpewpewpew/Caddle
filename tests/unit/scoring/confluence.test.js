import { describe, expect, it } from 'vitest';
import {
  CONFLUENCE_VERSION, DEFAULT_CONFLUENCE_PARAMS, TIERS, computeConfluence, meetsTier, resolveConfluenceParams, tierRank,
} from '../../../backend/scoring/confluence.js';

// Objek fitur palsu sesuai kontrak docs/10 §1–§4 (modul fitur dikerjakan paralel, tidak diimpor).
function idealLong() {
  return {
    direction: 'LONG',
    view: { direction: 'LONG', classification: 'SA', alignment: 'ALIGNED', patternScore: 85, earlyScore: 70, riskFlags: [] },
    context: { alignment: 'ALIGNED', trends: { '5m': { trend: 'NEUTRAL' }, '15m': { trend: 'BULLISH' }, '1h': { trend: 'BULLISH' } } },
    structure: {
      bias: 'BULLISH', swings: [], counts: { HH: 2, LH: 0, HL: 2, LL: 0 },
      lastEvent: { type: 'BOS', direction: 'BULLISH', index: 195, level: 101.5, barsAgo: 4 },
      lastSwingHigh: 101.5, lastSwingLow: 98, structureScore: 0.7,
    },
    orderFlow: {
      takerBuyRatio: 0.58, cvdSlope: 0.12, obvSlope: 0.2, cmf: 0.15, adSlope: 0.1, priceChange: 0.01,
      divergence: 'BULLISH', flowBias: 0.45,
    },
    regime: {
      adx: 28, plusDi: 30, minusDi: 12, chop: 35, bandwidth: 0.03, bandwidthPercentile: 0.4, squeeze: false,
      efficiencyRatio: 0.55, regime: 'TRENDING_UP',
    },
    liquidity: {
      rangeHigh: 105, rangeLow: 97, rangeWidthAtr: 4, position: 0.2, inRange: true,
      sweepLow: { index: 196, level: 97, reclaimed: true, barsAgo: 3 }, sweepHigh: null,
      climax: { type: 'SELLING', index: 190, volumeRatio: 3.2, barsAgo: 9 }, absorption: 0.4,
    },
  };
}

const flipBias = (b) => ({ BULLISH: 'BEARISH', BEARISH: 'BULLISH' }[b] ?? b);
const flipRegime = (r) => ({ TRENDING_UP: 'TRENDING_DOWN', TRENDING_DOWN: 'TRENDING_UP' }[r] ?? r);
const neg = (v) => (typeof v === 'number' ? -v : v);

/** Cermin input LONG → SHORT (bias dibalik, flow dinegasikan, sweepLow↔sweepHigh, dst.). */
function mirror(input) {
  const { view, context, structure: s, orderFlow: f, regime: r, liquidity: l } = input;
  return {
    direction: 'SHORT',
    view: view && { ...view, direction: 'SHORT', classification: view.classification === 'SA' ? 'SD' : view.classification },
    context: context && {
      ...context,
      trends: Object.fromEntries(Object.entries(context.trends ?? {}).map(([tf, t]) => [tf, { trend: flipBias(t.trend) }])),
    },
    structure: s && {
      ...s, bias: flipBias(s.bias), structureScore: neg(s.structureScore),
      lastEvent: s.lastEvent && { ...s.lastEvent, direction: flipBias(s.lastEvent.direction) },
    },
    orderFlow: f && {
      ...f, takerBuyRatio: typeof f.takerBuyRatio === 'number' ? 1 - f.takerBuyRatio : f.takerBuyRatio,
      cvdSlope: neg(f.cvdSlope), obvSlope: neg(f.obvSlope), cmf: neg(f.cmf), adSlope: neg(f.adSlope),
      priceChange: neg(f.priceChange), divergence: flipBias(f.divergence), flowBias: neg(f.flowBias),
    },
    regime: r && { ...r, plusDi: r.minusDi, minusDi: r.plusDi, regime: flipRegime(r.regime) },
    liquidity: l && {
      ...l, position: typeof l.position === 'number' ? 1 - l.position : l.position,
      sweepLow: l.sweepHigh, sweepHigh: l.sweepLow,
      climax: l.climax && { ...l.climax, type: l.climax.type === 'SELLING' ? 'BUYING' : 'SELLING' },
      absorption: neg(l.absorption),
    },
  };
}

const sumContrib = (res) => res.components.reduce((a, c) => a + c.contribution, 0);

describe('konfluensi v3', () => {
  it('POS-CNF-001 LONG ideal → tier A, tanpa veto, kontribusi berjumlah skor', () => {
    const res = computeConfluence(idealLong());
    expect(res.version).toBe(CONFLUENCE_VERSION);
    expect(res.tier).toBe('A');
    expect(res.score).toBeGreaterThanOrEqual(75);
    expect(res.vetoes).toEqual([]);
    expect(sumContrib(res)).toBeCloseTo(res.score, 9);
    expect(res.components.map((c) => c.id)).toEqual(['pattern', 'htf', 'structure', 'orderFlow', 'regime', 'liquidity']);
    expect(res.components.every((c) => c.passed)).toBe(true);
    expect(res.confirmations.some((t) => /CVD naik 12%/.test(t))).toBe(true);
    expect(res.conflicts).toEqual([]);
  });

  it('POS-CNF-002 SHORT ideal (cermin) → tier A', () => {
    const res = computeConfluence(mirror(idealLong()));
    expect(res.tier).toBe('A');
    expect(res.vetoes).toEqual([]);
    expect(res.confirmations.some((t) => /CVD turun 12%.*jual/.test(t))).toBe(true);
  });

  it('POS-CNF-003 simetri: input LONG & cermin SHORT memberi skor & tier identik', () => {
    const variants = [
      idealLong(),
      (() => { const x = idealLong(); x.view.alignment = 'COUNTERTREND'; x.context.alignment = 'COUNTERTREND'; return x; })(),
      (() => { const x = idealLong(); x.regime.regime = 'TRENDING_DOWN'; x.orderFlow.flowBias = -0.4; return x; })(),
      (() => { const x = idealLong(); x.orderFlow = null; x.regime = null; x.liquidity.position = 0.9; return x; })(),
      (() => {
        const x = idealLong();
        x.structure.bias = 'BEARISH'; x.structure.structureScore = -0.3;
        x.structure.lastEvent = { type: 'CHOCH', direction: 'BEARISH', index: 198, level: 99, barsAgo: 2 };
        x.liquidity.climax = { type: 'BUYING', index: 199, volumeRatio: 2.5, barsAgo: 1 };
        x.liquidity.absorption = -0.2; x.orderFlow.divergence = 'BEARISH';
        return x;
      })(),
      (() => { const x = idealLong(); x.regime.regime = 'CHOPPY'; x.view.alignment = 'UNCONFIRMED'; x.orderFlow.takerBuyRatio = 0.45; return x; })(),
    ];
    for (const long of variants) {
      const a = computeConfluence(long);
      const b = computeConfluence(mirror(long));
      expect(b.score).toBeCloseTo(a.score, 9);
      expect(b.tier).toBe(a.tier);
      expect(b.vetoes).toEqual(a.vetoes);
      expect(b.components.map((c) => c.value)).toEqual(a.components.map((c) => (c.value === null ? null : expect.closeTo(c.value, 9))));
      expect(b.confirmations.length).toBe(a.confirmations.length);
      expect(b.conflicts.length).toBe(a.conflicts.length);
    }
  });

  it('NEG-CNF-001 COUNTERTREND → veto, bukan A/B', () => {
    const x = idealLong();
    x.view.alignment = 'COUNTERTREND';
    x.context.alignment = 'COUNTERTREND';
    const res = computeConfluence(x);
    expect(res.vetoes).toContain('COUNTERTREND_HTF');
    expect(['C', 'D']).toContain(res.tier);
    expect(res.conflicts.some((t) => /berlawanan dengan arah LONG/.test(t))).toBe(true);
  });

  it('NEG-CNF-002 veto rezim, flow, struktur & risk flag', () => {
    const x = idealLong();
    x.regime.regime = 'TRENDING_DOWN';
    x.orderFlow.flowBias = -0.35;
    x.structure.bias = 'BEARISH';
    x.structure.lastEvent = { type: 'CHOCH', direction: 'BEARISH', index: 198, level: 99, barsAgo: 2 };
    x.view.riskFlags = ['EXCESSIVE_VOLATILITY', 'EXTENDED_PRICE'];
    const res = computeConfluence(x);
    expect(res.vetoes).toEqual(expect.arrayContaining(['REGIME_AGAINST', 'FLOW_AGAINST', 'STRUCTURE_AGAINST', 'RISK_EXCESSIVE_VOLATILITY']));
    expect(res.vetoes).not.toContain('RISK_EXTENDED_PRICE');
    expect(meetsTier(res.tier, 'B')).toBe(false);

    const weak = idealLong();
    weak.regime.adx = 18; weak.regime.regime = 'TRENDING_DOWN';
    expect(computeConfluence(weak).vetoes).not.toContain('REGIME_AGAINST');

    const div = idealLong();
    div.orderFlow.divergence = 'BEARISH';
    expect(computeConfluence(div).vetoes).toContain('FLOW_AGAINST');
  });

  it('NEG-CNF-003 satu veto pada skor tinggi → maksimal C', () => {
    const x = idealLong();
    x.view.riskFlags = ['WIDE_SPREAD'];
    const res = computeConfluence(x);
    expect(res.score).toBeGreaterThanOrEqual(75);
    expect(res.vetoes).toEqual(['RISK_WIDE_SPREAD']);
    expect(res.tier).toBe('C');
  });

  it('EDGE-CNF-001 fitur null → dinormalisasi ulang; >40% bobot hilang → tier ≤ C', () => {
    const x = idealLong();
    x.orderFlow = null;
    const partial = computeConfluence(x);
    expect(partial.components.find((c) => c.id === 'orderFlow')).toMatchObject({ value: null, contribution: 0, passed: false });
    expect(sumContrib(partial)).toBeCloseTo(partial.score, 9);
    expect(partial.score).toBeGreaterThanOrEqual(75);
    expect(partial.tier).toBe('B'); // flow wajib searah untuk tier A
    expect(partial.conflicts.some((t) => /tidak lengkap/.test(t))).toBe(false);

    const y = idealLong();
    y.orderFlow = null; y.regime = null; y.liquidity = null; // 50% bobot hilang
    const res = computeConfluence(y);
    expect(res.score).toBeGreaterThan(75); // komponen yang tersisa kuat
    expect(sumContrib(res)).toBeCloseTo(res.score, 9);
    expect(meetsTier(res.tier, 'B')).toBe(false);
    expect(res.conflicts.some((t) => /Data fitur tidak lengkap — 50% bobot/.test(t))).toBe(true);

    const empty = computeConfluence({ direction: 'SHORT' });
    expect(empty.score).toBe(0);
    expect(empty.tier).toBe('D');
    expect(empty.components.every((c) => c.value === null)).toBe(true);
  });

  it('EDGE-CNF-002 sub-bagian null dalam fitur dilewati (data taker lama)', () => {
    const x = idealLong();
    x.orderFlow = { ...x.orderFlow, takerBuyRatio: null, cvdSlope: null, divergence: null };
    const res = computeConfluence(x);
    expect(res.components.find((c) => c.id === 'orderFlow').value).toBeCloseTo(0.9, 9); // ramp(0.45, 0..0.5)
    expect(res.tier).toBe('A');
  });

  it('EDGE-CNF-003 arah dari view; arah bertentangan ditolak', () => {
    const x = idealLong();
    delete x.direction;
    expect(computeConfluence(x).tier).toBe('A');
    expect(() => computeConfluence({ ...idealLong(), direction: 'SHORT' })).toThrow(RangeError);
    expect(() => computeConfluence({ direction: 'UP' })).toThrow(RangeError);
    expect(() => computeConfluence({ view: { alignment: 'X', patternScore: 1, earlyScore: 1 } })).toThrow(RangeError);
  });

  it('POS-CNF-004 tier B/C/D menurut ambang', () => {
    const x = idealLong();
    x.view.patternScore = 40; x.view.earlyScore = 30;
    x.view.alignment = 'UNCONFIRMED'; x.context.alignment = 'UNCONFIRMED';
    const b = computeConfluence(x);
    expect(b.score).toBeGreaterThanOrEqual(60);
    expect(b.score).toBeLessThan(75);
    expect(b.tier).toBe('B');
    const low = computeConfluence({ direction: 'LONG', view: { patternScore: 20, earlyScore: 10, alignment: 'UNCONFIRMED', riskFlags: [] } });
    expect(low.tier).toBe('D');
  });

  it('NEG-CNF-004 validasi params', () => {
    expect(() => resolveConfluenceParams({ foo: 1 })).toThrow(TypeError);
    expect(() => resolveConfluenceParams({ weights: { volume: 5 } })).toThrow(TypeError);
    expect(() => resolveConfluenceParams(null)).toThrow(TypeError);
    expect(() => resolveConfluenceParams({ tierA: 50, tierB: 60 })).toThrow(RangeError);
    expect(() => resolveConfluenceParams({ freshBars: 1.5 })).toThrow(RangeError);
    expect(() => resolveConfluenceParams({ weights: { pattern: -1 } })).toThrow(RangeError);
    expect(() => resolveConfluenceParams({
      weights: { pattern: 0, htf: 0, structure: 0, orderFlow: 0, regime: 0, liquidity: 0 },
    })).toThrow(RangeError);
    expect(() => computeConfluence(idealLong(), { bogus: true })).toThrow(TypeError);
    const p = resolveConfluenceParams({ weights: { pattern: 40 }, tierA: 80 });
    expect(p.weights).toMatchObject({ pattern: 40, htf: 15 });
    expect(p.tierA).toBe(80);
    expect(Object.isFrozen(DEFAULT_CONFLUENCE_PARAMS)).toBe(true);
    expect(Object.values(DEFAULT_CONFLUENCE_PARAMS.weights).reduce((a, v) => a + v, 0)).toBe(100);
    const strict = computeConfluence(idealLong(), { tierA: 99, tierB: 99, tierC: 99 });
    expect(strict.tier).toBe('D');
  });

  it('POS-CNF-005 tierRank & meetsTier', () => {
    expect(TIERS).toEqual(['A', 'B', 'C', 'D']);
    expect(TIERS.map(tierRank)).toEqual([4, 3, 2, 1]);
    expect(meetsTier('A', 'B')).toBe(true);
    expect(meetsTier('B', 'B')).toBe(true);
    expect(meetsTier('C', 'B')).toBe(false);
    expect(() => tierRank('E')).toThrow(RangeError);
  });
});
