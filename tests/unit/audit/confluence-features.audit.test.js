// Audit fitur v3 + skor konfluensi + signal view (laporan pengguna: deteksi LONG/SHORT "ngaco" saat dicek di Binance).
// Tujuan: (1) matematika fitur dicocokkan dengan referensi independen yang dihitung ulang di sini (bukan memakai
// fungsi produksi), (2) tanda bullish = positif & tanpa lookahead, (3) arah SHORT benar-benar cermin LONG di setiap
// komponen, (4) dampak timeframe tanpa HTF (1h) terhadap skor/tier — relevan karena SHORT akan dipindai hanya di 1h.
// Tes yang berlabel "DESAIN SAAT INI" mengunci perilaku yang disengaja namun dilaporkan sebagai kelemahan desain.
import { describe, expect, it } from 'vitest';
import { analyzeDirectionsAt } from '../../../backend/analysis/pipeline.js';
import {
  adx, analyzeMarketStructure, analyzeOrderFlow, choppiness, cvd, efficiencyRatio, extractFeatures,
} from '../../../backend/features/index.js';
import { computeConfluence } from '../../../backend/scoring/confluence.js';
import { generateCandles, mulberry32 } from '../../fixtures/candles/synthetic.js';

// ─── Data uji ─────────────────────────────────────────────────────────────────────────────────────

/** Deret acak berbenih dengan taker buy acak (35–65% volume) dan lonjakan volume sesekali. */
function randomCandles(seed, n = 300) {
  const rnd = mulberry32(seed);
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = open * (1 + (rnd() - 0.5) * 0.02 + Math.sin(i / 25) * 0.003);
    const high = Math.max(open, close) * (1 + rnd() * 0.006);
    const low = Math.min(open, close) * (1 - rnd() * 0.006);
    const volume = 100 + rnd() * 200 * (rnd() < 0.03 ? 6 : 1);
    out.push({ open, high, low, close, volume, takerBuyVolume: volume * (0.35 + rnd() * 0.3) });
    price = close;
  }
  return out;
}

/**
 * Cermin harga ADITIF (p → K − p, high ↔ low, taker buy ↔ taker sell). Berbeda dengan cermin 1/p pada pola, cermin
 * aditif mempertahankan lebar range, ATR, DM, dan posisi secara eksak, sehingga fitur LONG pada deret asli harus
 * identik dengan fitur SHORT pada deret cermin (selain besaran relatif terhadap harga absolut).
 */
const K = 400;
const mirrorCandles = (cs) => cs.map((c) => ({
  ...c, open: K - c.open, close: K - c.close, high: K - c.low, low: K - c.high, takerBuyVolume: c.volume - c.takerBuyVolume,
}));

const valueOf = (c, id) => c.components.find((k) => k.id === id).value;

/** Input konfluensi LONG ideal (bentuk kontrak docs/10 §1–§4). */
function idealLong(overrides = {}) {
  return {
    direction: 'LONG',
    view: { direction: 'LONG', classification: 'SA', alignment: 'ALIGNED', patternScore: 85, earlyScore: 70, riskFlags: [] },
    context: { alignment: 'ALIGNED', trends: { '15m': { trend: 'BULLISH' }, '1h': { trend: 'BULLISH' } } },
    structure: {
      bias: 'BULLISH', counts: { HH: 2, LH: 0, HL: 2, LL: 0 },
      lastEvent: { type: 'BOS', direction: 'BULLISH', index: 195, level: 101.5, barsAgo: 4 }, structureScore: 0.7,
    },
    orderFlow: { takerBuyRatio: 0.58, cvdSlope: 0.16, cmf: 0.15, priceChange: -0.01, divergence: 'BULLISH', flowBias: 0.45 },
    regime: { adx: 28, plusDi: 30, minusDi: 12, chop: 35, efficiencyRatio: 0.55, efficiencyDirection: 1, regime: 'TRENDING_UP' },
    liquidity: {
      position: 0.2, inRange: true, sweepLow: { index: 196, level: 97, reclaimed: true, barsAgo: 3 }, sweepHigh: null,
      climax: { type: 'SELLING', index: 190, volumeRatio: 3.2, barsAgo: 9 }, absorption: 0.4,
    },
    ...overrides,
  };
}

const flip = (b) => ({ BULLISH: 'BEARISH', BEARISH: 'BULLISH' }[b] ?? b);

/** Cermin input konfluensi LONG → SHORT, termasuk efficiencyDirection & inRange (tidak dicerminkan tes lama). */
function mirrorInput(x) {
  const { view: v, context: c, structure: s, orderFlow: f, regime: r, liquidity: l } = x;
  return {
    direction: 'SHORT',
    view: v && { ...v, direction: 'SHORT', classification: { SA: 'SD', PVA: 'PVD' }[v.classification] ?? v.classification },
    context: c && { ...c, trends: Object.fromEntries(Object.entries(c.trends).map(([tf, t]) => [tf, { trend: flip(t.trend) }])) },
    structure: s && { ...s, bias: flip(s.bias), structureScore: -s.structureScore, lastEvent: s.lastEvent && { ...s.lastEvent, direction: flip(s.lastEvent.direction) } },
    orderFlow: f && {
      ...f, takerBuyRatio: 1 - f.takerBuyRatio, cvdSlope: -f.cvdSlope, cmf: -f.cmf, priceChange: -f.priceChange,
      divergence: flip(f.divergence), flowBias: -f.flowBias,
    },
    regime: r && {
      ...r, plusDi: r.minusDi, minusDi: r.plusDi, efficiencyDirection: -r.efficiencyDirection,
      regime: { TRENDING_UP: 'TRENDING_DOWN', TRENDING_DOWN: 'TRENDING_UP' }[r.regime] ?? r.regime,
    },
    liquidity: l && {
      ...l, position: 1 - l.position, sweepLow: l.sweepHigh, sweepHigh: l.sweepLow, absorption: -l.absorption,
      climax: l.climax && { ...l.climax, type: l.climax.type === 'SELLING' ? 'BUYING' : 'SELLING' },
    },
  };
}

// ─── 1. Matematika fitur terhadap referensi independen ────────────────────────────────────────────

/** ADX Wilder klasik (smoothing JUMLAH: S = S − S/n + x), ditulis ulang tanpa memakai kode produksi. */
function referenceAdx(c, n) {
  const N = c.length;
  const tr = [];
  const pdm = [];
  const mdm = [];
  for (let i = 1; i < N; i += 1) {
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    const up = c[i].high - c[i - 1].high;
    const dn = c[i - 1].low - c[i].low;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
  }
  let T = 0;
  let P = 0;
  let M = 0;
  for (let i = 1; i <= n; i += 1) { T += tr[i]; P += pdm[i]; M += mdm[i]; }
  const pdi = [];
  const mdi = [];
  const dx = [];
  for (let i = n; i < N; i += 1) {
    if (i > n) { T = T - T / n + tr[i]; P = P - P / n + pdm[i]; M = M - M / n + mdm[i]; }
    pdi[i] = (100 * P) / T;
    mdi[i] = (100 * M) / T;
    dx[i] = (100 * Math.abs(pdi[i] - mdi[i])) / (pdi[i] + mdi[i]);
  }
  const out = new Array(N).fill(null);
  let a = 0;
  for (let i = n; i < 2 * n; i += 1) a += dx[i];
  a /= n;
  out[2 * n - 1] = a;
  for (let i = 2 * n; i < N; i += 1) { a = (a * (n - 1) + dx[i]) / n; out[i] = a; }
  return { adx: out, pdi, mdi };
}

const trueRangeAt = (cs, k) => (k === 0 ? cs[k].high - cs[k].low
  : Math.max(cs[k].high - cs[k].low, Math.abs(cs[k].high - cs[k - 1].close), Math.abs(cs[k].low - cs[k - 1].close)));

describe('Audit fitur v3: matematika vs referensi independen', () => {
  const cs = randomCandles(11, 220);

  it('ADX/+DI/−DI = Wilder klasik (smoothing jumlah), ADX pertama di indeks 2·period − 1', () => {
    const ref = referenceAdx(cs, 14);
    const got = adx(cs, 14);
    expect(got.adx.findIndex((v) => v !== null)).toBe(27);
    for (let i = 27; i < cs.length; i += 1) {
      expect(got.adx[i]).toBeCloseTo(ref.adx[i], 9);
      expect(got.plusDi[i]).toBeCloseTo(ref.pdi[i], 9);
      expect(got.minusDi[i]).toBeCloseTo(ref.mdi[i], 9);
    }
  });

  it('CVD = Σ(2·takerBuy − volume); cvdSlope = 2·takerBuyRatio − 1 pada jendela 20 candle', () => {
    let sum = 0;
    const series = cvd(cs);
    cs.forEach((c, i) => {
      sum += 2 * c.takerBuyVolume - c.volume;
      expect(series[i]).toBeCloseTo(sum, 9);
    });
    const f = analyzeOrderFlow(cs);
    const win = cs.slice(-20);
    const ratio = win.reduce((a, c) => a + c.takerBuyVolume, 0) / win.reduce((a, c) => a + c.volume, 0);
    expect(f.takerBuyRatio).toBeCloseTo(ratio, 12);
    expect(f.cvdSlope).toBeCloseTo(2 * ratio - 1, 12);
  });

  it('Choppiness (Σ TR / (max high − min low), log10 n) dan Efficiency Ratio Kaufman cocok dengan rumus', () => {
    const chop = choppiness(cs, 14);
    const closes = cs.map((c) => c.close);
    const er = efficiencyRatio(closes, 10);
    for (let i = 13; i < cs.length; i += 1) {
      let st = 0;
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = i - 13; k <= i; k += 1) { st += trueRangeAt(cs, k); hi = Math.max(hi, cs[k].high); lo = Math.min(lo, cs[k].low); }
      expect(chop[i]).toBeCloseTo((100 * Math.log10(st / (hi - lo))) / Math.log10(14), 9);
    }
    for (let i = 10; i < cs.length; i += 1) {
      let path = 0;
      for (let k = i - 9; k <= i; k += 1) path += Math.abs(closes[k] - closes[k - 1]);
      expect(er[i]).toBeCloseTo(Math.abs(closes[i] - closes[i - 10]) / path, 12);
    }
  });

  it('tanda: tren naik + taker beli dominan → semua besaran bertanda positif (bullish = +)', () => {
    const up = generateCandles({ seed: 5, timeframe: '1h', segments: [{ bars: 260, drift: 0.002, cycle: [0.004, 0.003, -0.002, -0.003], noise: 0.001, wick: 0.002 }] })
      .map((c) => ({ ...c, takerBuyVolume: c.volume * 0.62 }));
    const f = extractFeatures(up);
    expect(f.structure.bias).toBe('BULLISH');
    expect(f.structure.structureScore).toBeGreaterThan(0);
    expect(f.orderFlow.takerBuyRatio).toBeCloseTo(0.62, 9);
    expect(f.orderFlow.cvdSlope).toBeCloseTo(0.24, 9);
    expect(f.orderFlow.flowBias).toBeGreaterThan(0);
    expect(f.regime.regime).toBe('TRENDING_UP');
    expect(f.regime.plusDi).toBeGreaterThan(f.regime.minusDi);
    expect(f.regime.efficiencyDirection).toBe(1);
  });
});

// ─── 2. Anti-lookahead ────────────────────────────────────────────────────────────────────────────

describe('Audit fitur v3: tanpa lookahead', () => {
  it('struktur: swing yang belum terkonfirmasi (puncak di candle last − 1) tidak dipakai', () => {
    const cs = randomCandles(21, 120);
    const peak = cs.length - 2;
    const top = Math.max(...cs.map((c) => c.high)) * 1.05;
    cs[peak] = { ...cs[peak], high: top, close: top * 0.999 };
    const s = analyzeMarketStructure(cs);
    expect(s.swings.every((w) => w.confirmedIndex <= cs.length - 1)).toBe(true);
    expect(s.swings.some((w) => w.index === peak)).toBe(false);
    expect(s.lastSwingHigh).not.toBe(top);
  });

  it('fitur pada prefix tidak berubah oleh candle masa depan (evaluasi bertahap = evaluasi sekali)', () => {
    const cs = randomCandles(22, 300);
    const k = 250;
    const prefix = extractFeatures(cs.slice(0, k));
    // Candle masa depan dirusak total: hasil prefix harus identik (fungsi hanya membaca candle ≤ indeks terakhir).
    const tampered = [...cs.slice(0, k), ...cs.slice(k).map((c) => ({ ...c, high: c.high * 3, volume: c.volume * 50 }))];
    expect(extractFeatures(tampered.slice(0, k))).toEqual(prefix);
  });
});

// ─── 3. Arah: SHORT = cermin LONG ─────────────────────────────────────────────────────────────────

describe('Audit konfluensi: SHORT cermin LONG', () => {
  it('fitur dari deret asli (LONG) vs deret cermin aditif (SHORT): nilai komponen, skor, tier, veto identik (40 benih)', () => {
    const view = { patternScore: 70, earlyScore: 60, classification: 'BOTH', riskFlags: [], alignment: null };
    for (let seed = 1; seed <= 40; seed += 1) {
      const cs = randomCandles(seed);
      const long = computeConfluence({ direction: 'LONG', view: { ...view, direction: 'LONG' }, ...extractFeatures(cs) });
      const short = computeConfluence({ direction: 'SHORT', view: { ...view, direction: 'SHORT' }, ...extractFeatures(mirrorCandles(cs)) });
      for (const id of ['structure', 'orderFlow', 'regime', 'liquidity']) {
        expect(valueOf(short, id), `benih ${seed} komponen ${id}`).toBeCloseTo(valueOf(long, id), 9);
      }
      expect(short.score).toBeCloseTo(long.score, 9);
      expect(short.tier).toBe(long.tier);
      expect([...short.vetoes].sort()).toEqual([...long.vetoes].sort());
    }
  });

  it('input cermin eksak (termasuk efficiencyDirection, absorption, inRange) → skor & tier identik', () => {
    for (const x of [
      idealLong(),
      idealLong({ regime: { adx: 30, plusDi: 10, minusDi: 30, chop: 40, efficiencyRatio: 0.5, efficiencyDirection: -1, regime: 'TRENDING_DOWN' } }),
      idealLong({ liquidity: { position: 0.9, inRange: true, sweepLow: null, sweepHigh: { level: 1, reclaimed: true, barsAgo: 1 }, climax: { type: 'BUYING', barsAgo: 2 }, absorption: -0.3 } }),
      idealLong({ orderFlow: { takerBuyRatio: 0.44, cvdSlope: -0.12, cmf: -0.2, priceChange: 0.02, divergence: 'BEARISH', flowBias: -0.35 } }),
    ]) {
      const a = computeConfluence(x);
      const b = computeConfluence(mirrorInput(x));
      expect(b.score).toBeCloseTo(a.score, 12);
      expect(b.tier).toBe(a.tier);
      expect(b.vetoes).toEqual(a.vetoes);
      expect(b.components.map((k) => k.value)).toEqual(a.components.map((k) => k.value));
    }
  });

  it('pemetaan per komponen: taker 0.42 untuk SHORT ≡ 0.58 untuk LONG; posisi 0.8 untuk SHORT ≡ 0.2 untuk LONG', () => {
    const base = { view: null, context: null };
    const flowL = computeConfluence({ ...base, direction: 'LONG', orderFlow: { takerBuyRatio: 0.58 } });
    const flowS = computeConfluence({ ...base, direction: 'SHORT', orderFlow: { takerBuyRatio: 0.42 } });
    expect(valueOf(flowL, 'orderFlow')).toBeCloseTo(0.8, 12);
    expect(valueOf(flowS, 'orderFlow')).toBeCloseTo(0.8, 12);
    const posL = computeConfluence({ ...base, direction: 'LONG', liquidity: { position: 0.2, inRange: true } });
    const posS = computeConfluence({ ...base, direction: 'SHORT', liquidity: { position: 0.8, inRange: true } });
    expect(valueOf(posL, 'liquidity')).toBeCloseTo(valueOf(posS, 'liquidity'), 12);
    // Breakout (inRange false): posisi ter-clamp tidak boleh dibaca "dekat dasar/puncak".
    const out = computeConfluence({ ...base, direction: 'SHORT', liquidity: { position: 1, inRange: false } });
    expect(out.confirmations.some((t) => t.includes('range'))).toBe(false);
  });

  it('Wyckoff: selling climax & spring mendukung LONG; buying climax & upthrust mendukung SHORT (bukan sebaliknya)', () => {
    const sc = { climax: { type: 'SELLING', barsAgo: 2 }, sweepLow: null, sweepHigh: null };
    const bc = { climax: { type: 'BUYING', barsAgo: 2 }, sweepLow: null, sweepHigh: null };
    const run = (direction, liquidity) => valueOf(computeConfluence({ direction, liquidity }), 'liquidity');
    expect(run('LONG', sc)).toBe(1);
    expect(run('LONG', bc)).toBe(0);
    expect(run('SHORT', bc)).toBe(1);
    expect(run('SHORT', sc)).toBe(0);
    const spring = { sweepLow: { reclaimed: true, barsAgo: 1 }, sweepHigh: null, climax: null };
    const upthrust = { sweepLow: null, sweepHigh: { reclaimed: true, barsAgo: 1 }, climax: null };
    expect(run('LONG', spring)).toBe(1);
    expect(run('SHORT', spring)).toBe(0);
    expect(run('SHORT', upthrust)).toBe(1);
  });

  it('veto berarah: flow/regime/struktur berlawanan memveto SHORT dengan cermin yang sama seperti LONG', () => {
    const shortAgainst = computeConfluence({
      direction: 'SHORT',
      orderFlow: { flowBias: 0.3 },
      regime: { regime: 'TRENDING_UP', adx: 25 },
      structure: { bias: 'BULLISH', lastEvent: { type: 'CHOCH', direction: 'BULLISH', barsAgo: 2 }, structureScore: 0.5 },
    });
    expect(shortAgainst.vetoes.sort()).toEqual(['FLOW_AGAINST', 'REGIME_AGAINST', 'STRUCTURE_AGAINST']);
    const shortWith = computeConfluence({ direction: 'SHORT', orderFlow: { flowBias: -0.3 }, regime: { regime: 'TRENDING_DOWN', adx: 40 } });
    expect(shortWith.vetoes).toEqual([]);
  });
});

// ─── 4. Timeframe tanpa HTF (1h) — dampak untuk SHORT yang hanya dipindai di 1h ───────────────────

describe('Audit konfluensi: timeframe tanpa HTF (1h)', () => {
  const noHtf = (x) => ({ ...x, view: { ...x.view, alignment: null }, context: null });

  it('komponen HTF null → dikeluarkan dari penyebut: skor 1h = Σ komponen lain / 80; 15m UNCONFIRMED = 0.8 × skor itu', () => {
    const x = idealLong({ structure: { bias: 'NEUTRAL', lastEvent: null, structureScore: 0.2 } });
    const h1 = computeConfluence(noHtf(x));
    expect(valueOf(h1, 'htf')).toBeNull();
    const others = h1.components.filter((k) => k.id !== 'htf').reduce((a, k) => a + k.value * k.weight, 0);
    expect(h1.score).toBeCloseTo((100 * others) / 80, 9);
    const unconfirmed = computeConfluence({ ...x, view: { ...x.view, alignment: 'UNCONFIRMED' }, context: { alignment: 'UNCONFIRMED', trends: {} } });
    expect(unconfirmed.score).toBeCloseTo(0.8 * h1.score, 9);
    // Dan arah tidak berpengaruh: SHORT cermin di 1h = LONG di 1h.
    expect(computeConfluence(noHtf(mirrorInput(x))).score).toBeCloseTo(h1.score, 12);
  });

  it('DIPERBAIKI: tanpa HTF (1h) tier A tetap mungkin — skor ≥ tierA (75) tanpa veto, struktur & flow searah → A', () => {
    const c = computeConfluence(noHtf(idealLong()));
    expect(c.score).toBeGreaterThan(90);
    expect(c.vetoes).toEqual([]);
    expect(c.tier).toBe('A'); // sebelumnya B: syarat alignment ALIGNED/PARTIALLY_CONFIRMED mustahil tanpa HTF
    expect(computeConfluence(noHtf(mirrorInput(idealLong()))).tier).toBe('A');
    // 15m dengan HTF UNCONFIRMED tetap tidak boleh A.
    expect(computeConfluence({ ...idealLong(), view: { ...idealLong().view, alignment: 'UNCONFIRMED' }, context: { alignment: 'UNCONFIRMED', trends: {} } }).tier).not.toBe('A');
  });

  it('DESAIN SAAT INI: tanpa HTF veto COUNTERTREND_HTF tidak pernah muncul (tidak ada pemeriksaan tren lebih tinggi)', () => {
    const c = computeConfluence(noHtf(mirrorInput(idealLong())));
    expect(c.vetoes).not.toContain('COUNTERTREND_HTF');
    expect(c.conflicts.some((t) => t.includes('Timeframe lebih tinggi'))).toBe(false);
  });

  it('data tidak lengkap: 1h lebih cepat kena batas C (HTF sudah 20% hilang)', () => {
    const x = idealLong({ regime: null, orderFlow: null }); // 25% bobot hilang di 15m
    expect(computeConfluence(x).conflicts.some((t) => t.startsWith('Data fitur tidak lengkap'))).toBe(false);
    const h1 = computeConfluence(noHtf(x)); // 45% hilang di 1h
    expect(h1.conflicts.some((t) => t.startsWith('Data fitur tidak lengkap'))).toBe(true);
    expect(h1.tier).toBe('C');
  });

  it('pipeline 1h: HTF null untuk LONG & SHORT, view.alignment tetap UNCONFIRMED; tier dihitung tanpa likuiditas 24 jam', () => {
    const h1 = generateCandles({ seed: 3, timeframe: '1h', segments: [{ bars: 300, drift: -0.001, cycle: [0.004, 0.003, -0.002, -0.006, -0.003, 0.002], noise: 0.002, wick: 0.003 }] });
    const args = { symbol: 'SYNUSDT', timeframe: '1h', candlesByTimeframe: { '1h': h1 } };
    const poor = analyzeDirectionsAt({ ...args, liquidity: { quoteVolume24h: 1, spreadBps: 1 } });
    const none = analyzeDirectionsAt(args);
    for (const d of ['LONG', 'SHORT']) {
      expect(valueOf(poor[d].view.confluence, 'htf')).toBeNull();
      expect(poor[d].view.alignment).toBe('UNCONFIRMED');
      expect(poor[d].view.riskFlags).toContain('POOR_LIQUIDITY');
      expect(poor[d].view.confluence.vetoes).not.toContain('RISK_POOR_LIQUIDITY');
      expect(poor[d].view.confluence.score).toBe(none[d].view.confluence.score);
      expect(poor[d].view.confluence.tier).toBe(none[d].view.confluence.tier);
    }
    // Fitur tidak berarah dipakai bersama; arah hanya mengubah tanda → komponen non-pola LONG ≠ SHORT pada tren turun.
    expect(valueOf(none.SHORT.view.confluence, 'structure')).toBeGreaterThan(valueOf(none.LONG.view.confluence, 'structure'));
  });

  it('DESAIN SAAT INI: 15m tanpa candle 1h tersimpan → HTF dinilai 0 (UNCONFIRMED), bukan dikeluarkan seperti 1h', () => {
    const m15 = generateCandles({ seed: 4, timeframe: '15m', segments: [{ bars: 300, drift: 0.0005, cycle: [0.004, -0.003], noise: 0.002, wick: 0.003 }] });
    const r = analyzeDirectionsAt({ symbol: 'SYNUSDT', timeframe: '15m', candlesByTimeframe: { '15m': m15 } });
    expect(r.LONG.view.alignment).toBe('UNCONFIRMED');
    expect(valueOf(r.LONG.view.confluence, 'htf')).toBe(0);
  });
});
