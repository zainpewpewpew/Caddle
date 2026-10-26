import { describe, expect, it } from 'vitest';
import { DISCLAIMERS, tokenKey, walletKey } from '../../../backend/smartmoney/contracts.js';
import { DEFAULT_EVALUATION_PARAMS, evaluateHistorically, formatEvaluationMarkdown } from '../../../backend/smartmoney/evaluate.js';
import { buildImpliedPriceIndex } from '../../../backend/smartmoney/prices.js';
import {
  CHAIN, DAY, HOUR, T0, WETH_ADDR, addr, shuffled, swap, tablePriceAt, tokenAddr, tradeHistory,
} from './evaluationFixtures.js';

// ─── Skenario sintetis ──────────────────────────────────────────────────────────────────────────────
// SMART[0..3]: 12 trade tertutup (T0 … T0+34 hari) → layak sejak ±hari ke-34. LATE: 12 posisi terbuka sebelum C,
// baru dijual untung besar SETELAH C. NOOB: tanpa riwayat (tidak layak). Evaluasi mulai S = T0 + 40 hari, langkah
// 6 jam, jendela 24 jam, horizon 6 jam & 1 hari. SMART[0..2] membeli X pada S+1j, S+2j, S+3j → kandidat di
// S+6j … S+24j. NOOB membeli Y (non-quote) dan WETH (quote).
const S = T0 + 40 * DAY;
const C = S + 12 * HOUR; // titik potong uji kebocoran (= titik evaluasi ke-3)
const STEP = 6 * HOUR;
const SMART = [addr(1), addr(2), addr(3), addr(4)];
const LATE = addr(5);
const NOOB = addr(9);
const X = tokenAddr(1);
const Y = tokenAddr(2);
const Z = tokenAddr(3);
const KX = tokenKey(CHAIN, X);
const KY = tokenKey(CHAIN, Y);
const KZ = tokenKey(CHAIN, Z);
const PEPE = (address) => ({ address, symbol: 'PEPE', name: null, decimals: 18 }); // simbol sama, kontrak beda

const smartHistory = () => SMART.flatMap((w, k) => tradeHistory({ wallet: w, salt: 0x100 + k, from: T0 + k * 10 * 60_000 }));
const lateBuys = () => tradeHistory({ wallet: LATE, salt: 0x200, tokenBase: 200 }).filter((a) => a.type === 'SWAP_BUY');
/** LATE menjual 12 posisinya dengan +300 % pada C+1j … C+12j. */
const lateSells = () => Array.from({ length: 12 }, (_, i) => swap({
  wallet: LATE, token: tokenAddr(200 + (i % 4)), at: C + (i + 1) * HOUR, n: 100 + i, salt: 0x201, type: 'SWAP_SELL', usd: 4000,
}));

function baseActivities() {
  return [
    ...smartHistory(),
    ...lateBuys(),
    swap({ wallet: SMART[0], token: PEPE(X), at: S + 1 * HOUR, n: 1, usd: 5000 }),
    swap({ wallet: SMART[1], token: PEPE(X), at: S + 2 * HOUR, n: 2, usd: 5000 }),
    swap({ wallet: SMART[2], token: PEPE(X), at: S + 3 * HOUR, n: 3, usd: 5000 }),
    swap({ wallet: LATE, token: PEPE(X), at: S + 4 * HOUR, n: 4, usd: 5000 }),
    swap({ wallet: NOOB, token: PEPE(Y), at: S + 1 * HOUR, n: 5, usd: 500 }),
    swap({ wallet: NOOB, token: WETH_ADDR, symbol: 'WETH', at: S + 2 * HOUR, n: 6, usd: 500 }),
  ];
}

const PRICES = {
  [KX]: [[S, 1], [S + 12 * HOUR, 1.2], [S + 30 * HOUR, 1.5], [S + 36 * HOUR, 1.4]],
  [KY]: [[S, 2], [S + 12 * HOUR, 1.8], [S + 30 * HOUR, 2]],
};

function run(activities, { prices = PRICES, priceAt, input = {}, params = {} } = {}) {
  return evaluateHistorically({
    activities, priceAt: priceAt ?? tablePriceAt(prices), start: S, end: S + 4 * DAY, stepMs: STEP, windowMs: 24 * HOUR,
    horizonsMs: [6 * HOUR, 24 * HOUR], minIndependentBuyers: 3, ...input,
  }, { includeStepDetails: true, ...params });
}

const stepAt = (report, t) => report.timeline.find((s) => s.t === t);
const eligibleAt = (report, t) => stepAt(report, t).eligible.map((e) => e.walletKey);
/** Identitas sinyal (tanpa hasil ke depan, yang memang bergantung pada harga setelah t). */
const identity = ({ forward: _f, ...rest }) => rest;

describe('evaluateHistorically — alur normal', () => {
  it('UNIT-SM-EVL-001 sinyal dari ≥ 3 pembeli independen, harga masuk = priceAt(t), return = priceAt(t + h)/masuk − 1', () => {
    const r = run(baseActivities());
    expect(r).toMatchObject({ kind: 'smart-money-evaluation', version: 1 });
    expect(r.params).toMatchObject({ start: S, end: S + 4 * DAY, stepMs: STEP, horizonsMs: [6 * HOUR, 24 * HOUR], cooldownMs: 24 * HOUR });
    expect(r.summary).toMatchObject({ steps: 16, signals: 1, candidates: 4, suppressedByCooldown: 3, stepsWithSignals: 1, priceErrors: 0 });
    expect(r.signals).toHaveLength(1);
    const [s] = r.signals;
    expect(s).toMatchObject({
      t: S + 6 * HOUR, tokenKey: KX, chain: CHAIN, state: 'ACCUMULATING', independentBuyers: 3, buyerCount: 3,
      buyers: [SMART[0], SMART[1], SMART[2]], entryAt: S + 6 * HOUR, entryPrice: 1, token: { address: X, symbol: 'PEPE' },
    });
    expect(s.forward.map((f) => f.horizonMs)).toEqual([6 * HOUR, 24 * HOUR]);
    expect(s.forward[0]).toMatchObject({ exitAt: S + 12 * HOUR, exitPrice: 1.2, missing: null });
    expect(s.forward[0].return).toBeCloseTo(0.2, 12);
    expect(s.forward[1].return).toBeCloseTo(0.5, 12);
    expect(r.byBucket.map((b) => b.bucket)).toEqual(['<40', '40–60', '60–80', '≥80']);
    const bucket = r.byBucket.find((b) => b.bucket === s.bucket);
    expect(s.conviction).toBeGreaterThanOrEqual(bucket.minConviction ?? 0);
    expect(s.conviction).toBeLessThan(bucket.maxConviction ?? 101);
    expect(bucket.horizons[1]).toMatchObject({ signals: 1, withPrice: 1, coverage: 1, hitRate: 1 });
    expect(r.overall[0].mean).toBeCloseTo(0.2, 12);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r); // dapat disimpan sebagai JSON (GET /evaluation)
  });

  it('UNIT-SM-EVL-002 KEBOCORAN: mengubah/menambah aktivitas & harga pada/setelah t tidak mengubah sinyal & kelayakan di t', () => {
    const smart3Later = [
      swap({ wallet: SMART[3], token: tokenAddr(100), at: C, n: 30, usd: 1000 }),
      swap({ wallet: SMART[3], token: tokenAddr(100), at: C + 3 * HOUR, n: 31, type: 'SWAP_SELL', usd: 1100 }),
    ];
    const base = [...baseActivities(), ...smart3Later];
    const mutated = [
      ...baseActivities(),
      // aktivitas lama pada/setelah C dimutasi: biaya 1 USD, hasil jual 100 rb USD, waktu digeser
      { ...smart3Later[0], usdValue: 1 },
      { ...smart3Later[1], usdValue: 100_000, blockTime: C + 5 * HOUR },
      ...lateSells(), // LATE menjadi pemenang besar setelah C
      swap({ wallet: SMART[3], token: PEPE(X), at: C, n: 40, usd: 50_000 }), // tepat di t = C → tidak boleh terlihat di C
      ...[0, 1, 2].map((k) => swap({ wallet: SMART[k], token: Z, at: C + (k + 1) * HOUR, n: 41 + k, usd: 9000 })),
    ];
    const pricesMutated = {
      [KX]: [[S, 1], [C, 9], [S + 30 * HOUR, 0.1]],
      [KY]: [[S, 2], [C, 0.5]],
      [KZ]: [[C, 3], [C + DAY, 6]],
    };
    const a = run(base);
    const b = run(mutated, { prices: pricesMutated });

    const upTo = (report) => ({
      signals: report.signals.filter((s) => s.t <= C).map(identity),
      steps: report.timeline.filter((s) => s.t <= C),
    });
    expect(upTo(b)).toEqual(upTo(a));
    expect(upTo(a).steps).toHaveLength(3);
    expect(upTo(a).signals).toHaveLength(1);
    expect(stepAt(b, C).candidateTokens).toEqual(stepAt(a, C).candidateTokens); // pembelian tepat di C tidak terlihat
    // Data setelah C memang berpengaruh setelah C (uji tidak hampa).
    expect(eligibleAt(b, S + 36 * HOUR)).toContain(walletKey(CHAIN, LATE));
    expect(eligibleAt(a, S + 36 * HOUR)).not.toContain(walletKey(CHAIN, LATE));
    expect(b.signals.some((s) => s.tokenKey === KZ)).toBe(true);
    expect(a.signals.some((s) => s.tokenKey === KZ)).toBe(false);
    expect(stepAt(b, C + STEP).candidateTokens.find((c) => c.tokenKey === KX).independentBuyers).toBe(4);
  });

  it('UNIT-SM-EVL-003 wallet yang baru untung setelah t tidak layak di t (dan pembeliannya tidak dihitung)', () => {
    const r = run([...baseActivities(), ...lateSells()]);
    const late = walletKey(CHAIN, LATE);
    for (const step of r.timeline.filter((s) => s.t <= S + 18 * HOUR)) expect(step.eligible.map((e) => e.walletKey)).not.toContain(late);
    expect(r.signals[0].buyers).not.toContain(LATE); // LATE membeli X pada S+4j, tetapi belum layak di S+6j
    expect(r.signals[0].independentBuyers).toBe(3);
    const later = stepAt(r, S + 36 * HOUR).eligible;
    const lateScore = later.find((e) => e.walletKey === late).score;
    expect(lateScore).toBeGreaterThan(later.find((e) => e.walletKey === walletKey(CHAIN, SMART[0])).score);
  });

  it('UNIT-SM-EVL-004 survivorship: wallet yang kemudian berhenti atau rugi tetap dihitung di t', () => {
    const stopped = run(baseActivities()); // SMART[0] tidak bertransaksi lagi setelah S+1j
    const s0 = walletKey(CHAIN, SMART[0]);
    expect(stopped.signals[0].buyers).toContain(SMART[0]);
    for (const step of stopped.timeline) expect(step.eligible.map((e) => e.walletKey)).toContain(s0);

    const losses = tradeHistory({ wallet: SMART[0], salt: 0x300, tokenBase: 400, from: C + HOUR, trades: 10, spacingMs: 2 * HOUR, holdMs: HOUR, returnPct: -90 });
    const laterLoser = run([...baseActivities(), ...losses]);
    expect(laterLoser.signals.filter((s) => s.t <= C).map(identity)).toEqual(stopped.signals.filter((s) => s.t <= C).map(identity));
    const scoreAt = (report, t) => stepAt(report, t).eligible.find((e) => e.walletKey === s0)?.score ?? null;
    expect(scoreAt(laterLoser, S + 6 * HOUR)).toBe(scoreAt(stopped, S + 6 * HOUR));
    const last = S + 4 * DAY - STEP;
    expect(scoreAt(stopped, last)).not.toBeNull();
    expect(scoreAt(laterLoser, last) ?? 0).toBeLessThan(scoreAt(stopped, last)); // kerugian hanya terlihat setelah terjadi
  });

  it('UNIT-SM-EVL-005 harga ke depan hilang dihitung sebagai "harga hilang" (masuk/keluar), tidak dibuang diam-diam', () => {
    const exitMissing = run(baseActivities(), { prices: { ...PRICES, [KX]: [[S, 1], [S + 8 * HOUR, null]] } });
    expect(exitMissing.signals).toHaveLength(1);
    expect(exitMissing.signals[0].forward.map((f) => [f.return, f.missing])).toEqual([[null, 'EXIT_PRICE'], [null, 'EXIT_PRICE']]);
    expect(exitMissing.overall[0]).toMatchObject({
      signals: 1, withPrice: 0, missingPrice: 1, missingExit: 1, missingEntry: 0, coverage: 0, mean: null, hitRate: null,
    });
    expect(exitMissing.overall[0].warnings.some((w) => w.includes('cakupan harga rendah'))).toBe(true);
    expect(exitMissing.warnings.some((w) => w.includes('Cakupan harga rendah') && w.includes('harga hilang'))).toBe(true);

    const entryMissing = run(baseActivities(), { prices: { [KY]: PRICES[KY] } });
    expect(entryMissing.signals[0]).toMatchObject({ entryPrice: null });
    expect(entryMissing.signals[0].forward.every((f) => f.missing === 'ENTRY_PRICE')).toBe(true);
    expect(entryMissing.overall[1]).toMatchObject({ missingEntry: 1, missingPrice: 1, coverage: 0 });
    expect(entryMissing.baseline[0]).toMatchObject({ samples: 8, withPrice: 4, missingEntry: 4, coverage: 0.5 });
  });

  it('UNIT-SM-EVL-006 baseline: semua token non-quote yang dibeli siapa pun di jendela yang sama (simbol sama ≠ token sama); selisih per titik', () => {
    const r = run(baseActivities());
    const [s] = r.signals;
    // Pada S+6j: X (+20 % / +50 %) dan Y (−10 % / 0 %) — keduanya bersimbol "PEPE" tetapi kontrak berbeda → dua token.
    // WETH (quote) tidak ikut; Y dibeli wallet tidak layak tetapi tetap masuk baseline.
    expect(s.forward[0].baselineMean).toBeCloseTo(0.05, 12);
    expect(s.forward[1].baselineMean).toBeCloseTo(0.25, 12);
    expect(s.forward[0].excess).toBeCloseTo(0.15, 12);
    expect(s.forward[1].excess).toBeCloseTo(0.25, 12);
    expect(stepAt(r, S + 6 * HOUR).baselineTokens).toBe(2);
    expect(stepAt(r, S).baselineTokens).toBe(0);
    const bucket = r.byBucket.find((b) => b.bucket === s.bucket).horizons[0];
    expect(bucket.baselineMean).toBeCloseTo(0.05, 12);
    expect(bucket.excessMean).toBeCloseTo(0.15, 12);
    expect(bucket.pairedWithBaseline).toBe(1);
    // Baseline gabungan: 4 titik × 2 token per horizon.
    expect(r.baseline.map((m) => [m.samples, m.withPrice, m.coverage])).toEqual([[8, 8, 1], [8, 8, 1]]);
    const sixHour = [0.2, 0, 0, 0.25, -0.1, 0, 0, 0.2 / 1.8];
    expect(r.baseline[0].mean).toBeCloseTo(sixHour.reduce((a, v) => a + v, 0) / 8, 12);
  });

  it('UNIT-SM-EVL-007 cooldown: token yang sama tidak disinyalkan ulang selama cooldown (default = horizon terpanjang)', () => {
    const again = [0, 1, 2].map((k) => swap({ wallet: SMART[k], token: PEPE(X), at: S + (31 + k) * HOUR, n: 60 + k, usd: 5000 }));
    const acts = [...baseActivities(), ...again];
    const byDefault = run(acts);
    expect(byDefault.signals.map((s) => (s.t - S) / HOUR)).toEqual([6, 36]); // 36 − 6 = 30 jam ≥ 24 jam
    expect(byDefault.timeline.filter((s) => s.suppressedByCooldown > 0).map((s) => (s.t - S) / HOUR)).toEqual([12, 18, 24, 42, 48, 54]);
    expect(byDefault.summary.suppressedByCooldown).toBe(6);
    expect(byDefault.statements.some((t) => t.includes('cooldown 1 hari'))).toBe(true);

    const none = run(acts, { params: { cooldownMs: 0 } });
    expect(none.signals.map((s) => (s.t - S) / HOUR)).toEqual([6, 12, 18, 24, 36, 42, 48, 54]);
    expect(none.summary.suppressedByCooldown).toBe(0);
    const twelve = run(acts, { params: { cooldownMs: 12 * HOUR } });
    expect(twelve.signals.map((s) => (s.t - S) / HOUR)).toEqual([6, 18, 36, 48]);
  });

  it('UNIT-SM-EVL-008 deterministik: urutan masukan, data terlambat & duplikat tidak mengubah laporan', () => {
    const acts = [...baseActivities(), ...lateSells()];
    const a = run(acts);
    const b = run(shuffled(acts, 5));
    expect(b).toEqual(a);
    expect(JSON.stringify(run(acts))).toBe(JSON.stringify(a));
    expect(formatEvaluationMarkdown(b)).toBe(formatEvaluationMarkdown(a));
    const dup = run(shuffled([...acts, ...acts.slice(0, 10)], 9));
    expect(dup.data.duplicates).toBe(10);
    expect({ ...dup, data: { ...dup.data, duplicates: 0 } }).toEqual(a);
  });

  it('UNIT-SM-EVL-009 peringatan sampel kecil (n < 30) & pernyataan wajib dalam Bahasa Indonesia', () => {
    const r = run(baseActivities());
    expect(r.warnings.some((w) => w.startsWith('Sampel kecil secara keseluruhan') && w.includes('n = 1') && w.includes('< 30'))).toBe(true);
    const bucket = r.byBucket.find((b) => b.bucket === r.signals[0].bucket);
    expect(r.warnings.some((w) => w.startsWith(`Ember keyakinan ${bucket.bucket}: sampel kecil`))).toBe(true);
    expect(bucket.horizons[0].warnings).toContain('sampel kecil: n = 1 < 30');
    expect(r.byBucket.find((b) => b.bucket !== bucket.bucket).horizons[0].warnings).toEqual(['tidak ada sinyal']);
    expect(r.warnings.some((w) => w.includes('DATA SIMULASI'))).toBe(true);
    const text = r.statements.join('\n');
    expect(text).toContain(DISCLAIMERS.conviction);
    expect(text).toContain('in-sample');
    expect(text).toContain('blockTime < t');
    expect(text).toContain('harga hilang');

    const relaxed = run(baseActivities(), { params: { minSample: 1 } });
    expect(relaxed.warnings.some((w) => w.includes('ampel kecil'))).toBe(false);
    const noSignals = run(baseActivities(), { input: { minIndependentBuyers: 5 } });
    expect(noSignals.warnings.some((w) => w.startsWith('Tidak ada sinyal'))).toBe(true);
    const tooEarly = evaluateHistorically({
      activities: baseActivities(), priceAt: tablePriceAt(PRICES), start: T0 + 5 * DAY, end: T0 + 6 * DAY,
      stepMs: STEP, windowMs: DAY, horizonsMs: [STEP],
    });
    expect(tooEarly.summary.eligibleWallets.max).toBe(0);
    expect(tooEarly.warnings.some((w) => w.startsWith('Tidak ada wallet yang layak'))).toBe(true);
  });
});

describe('evaluateHistorically — kasus tepi', () => {
  it('UNIT-SM-EVL-010 wallet tertaut & PnL tidak lengkap mengurangi pembeli independen → tidak ada sinyal', () => {
    // SMART[0] & SMART[1] ko-trading (≤ 60 dtk pada 3 token) → satu klaster.
    const coTrade = [300, 301, 302].flatMap((tok, i) => [
      swap({ wallet: SMART[0], token: tokenAddr(tok), at: S - 5 * DAY + i * DAY, n: 70 + i }),
      swap({ wallet: SMART[1], token: tokenAddr(tok), at: S - 5 * DAY + i * DAY + 20_000, n: 80 + i }),
    ]);
    const linked = run([...baseActivities(), ...coTrade]);
    expect(linked.signals).toEqual([]);
    const cand = stepAt(linked, S + 6 * HOUR);
    expect(cand.candidates).toBe(0);
    expect(linked.summary.signals).toBe(0);
    const twoBuyers = run([...baseActivities(), ...coTrade], { input: { minIndependentBuyers: 2 } });
    expect(twoBuyers.signals[0]).toMatchObject({ buyerCount: 3, independentBuyers: 2 });

    // SMART[2] dengan histori terpotong (lot dari transfer masuk) → tidak layak → hanya 2 pembeli.
    const incomplete = baseActivities().map((a) => (a.wallet === SMART[2] && a.type === 'SWAP_BUY' && a.blockTime < S
      ? { ...a, type: 'TRANSFER_IN', usdValue: null } : a));
    const r = run(incomplete);
    expect(eligibleAt(r, S + 6 * HOUR)).not.toContain(walletKey(CHAIN, SMART[2]));
    expect(r.signals).toEqual([]);
  });

  it('UNIT-SM-EVL-011 sumber harga gagal (priceAt melempar) → harga hilang + peringatan, evaluasi tetap selesai', () => {
    const table = tablePriceAt(PRICES);
    const flaky = (key, t) => {
      if (key === KX && t > S + 6 * HOUR) throw new Error('provider harga 503');
      return table(key, t);
    };
    const r = run(baseActivities(), { priceAt: flaky });
    expect(r.signals[0].entryPrice).toBe(1);
    expect(r.signals[0].forward.every((f) => f.missing === 'EXIT_PRICE')).toBe(true);
    expect(r.summary.priceErrors).toBeGreaterThan(0);
    expect(r.summary.firstPriceError).toBe('provider harga 503');
    expect(r.warnings.some((w) => w.startsWith('Sumber harga gagal') && w.includes('bukan nol'))).toBe(true);
  });

  it('UNIT-SM-EVL-012 terintegrasi dengan indeks harga tersirat swap; jeda eksekusi menggeser harga masuk', () => {
    const market = addr(0x77);
    const quotes = [[S + 5 * HOUR, 1], [S + 6 * HOUR + 30 * 60_000, 1.1], [S + 12 * HOUR, 1.3], [S + 30 * HOUR, 1.6], [S + 31 * HOUR, 1.7]];
    const acts = [
      ...baseActivities().map((a) => (a.token.address === X ? { ...a, usdValue: 1000 } : a)), // beli X @ 1 USD/unit
      ...quotes.map(([at, price], i) => swap({ wallet: market, token: PEPE(X), at, n: 500 + i, usd: price * 1000, type: 'SWAP_SELL' })),
    ];
    const index = buildImpliedPriceIndex(acts, { maxStalenessMs: 2 * HOUR });
    const r = run(acts, { priceAt: index.priceAt });
    const [s] = r.signals;
    expect(s.entryPrice).toBe(1); // swap terakhir ≤ t = S+6j (S+5j); swap S+6j30m belum terjadi
    expect(s.forward[0].return).toBeCloseTo(0.3, 12);
    expect(s.forward[1].return).toBeCloseTo(0.6, 12);
    const delayed = run(acts, { priceAt: index.priceAt, params: { entryDelayMs: HOUR } });
    expect(delayed.signals[0]).toMatchObject({ t: S + 6 * HOUR, entryAt: S + 7 * HOUR });
    expect(delayed.signals[0].entryPrice).toBeCloseTo(1.1, 12);
    expect(delayed.signals[0].forward[1].return).toBeCloseTo(1.7 / 1.1 - 1, 12);
    expect(delayed.statements.some((t) => t.includes('t + 1 jam'))).toBe(true);
  });

  it('UNIT-SM-EVL-013 masukan & parameter tidak valid ditolak; nilai input kontrak mengalahkan params', () => {
    const ok = { activities: [], priceAt: () => null, start: S, end: S + DAY };
    expect(Object.isFrozen(DEFAULT_EVALUATION_PARAMS)).toBe(true);
    expect(DEFAULT_EVALUATION_PARAMS).toMatchObject({ minIndependentBuyers: 3, signalStates: ['ACCUMULATING'], convictionBuckets: [40, 60, 80], cooldownMs: null });
    expect(() => evaluateHistorically({ ...ok, activities: 'x' })).toThrow(TypeError);
    expect(() => evaluateHistorically({ ...ok, priceAt: null })).toThrow(/priceAt/);
    expect(() => evaluateHistorically({ ...ok, end: S })).toThrow(RangeError);
    expect(() => evaluateHistorically({ ...ok, start: S + 0.5 })).toThrow(RangeError);
    expect(() => evaluateHistorically({ ...ok, stepMs: 0 })).toThrow(/stepMs/);
    expect(() => evaluateHistorically({ ...ok, horizonsMs: [] })).toThrow(/horizonsMs/);
    expect(() => evaluateHistorically({ ...ok, minIndependentBuyers: 0 })).toThrow(/minIndependentBuyers/);
    expect(() => evaluateHistorically(ok, { signalStates: ['NAIK'] })).toThrow(/signalStates/);
    expect(() => evaluateHistorically(ok, { convictionBuckets: [60, 40] })).toThrow(/convictionBuckets/);
    expect(() => evaluateHistorically(ok, { cooldownMs: -1 })).toThrow(/cooldownMs/);
    expect(() => evaluateHistorically(ok, { foo: 1 })).toThrow(/tidak dikenal/);
    expect(() => evaluateHistorically({ ...ok, end: S + 365 * DAY }, { stepMs: 60_000 })).toThrow(/maxSteps/);

    const r = evaluateHistorically({ ...ok, stepMs: 12 * HOUR, horizonsMs: [DAY, HOUR, DAY] }, { stepMs: HOUR, convictionBuckets: [50] });
    expect(r.params).toMatchObject({ stepMs: 12 * HOUR, horizonsMs: [HOUR, DAY], cooldownMs: DAY });
    expect(r.summary.steps).toBe(2);
    expect(r.byBucket.map((b) => b.bucket)).toEqual(['<50', '≥50']);
    expect(r.timeline[0]).not.toHaveProperty('eligible'); // detail per titik hanya bila diminta
  });
});

describe('formatEvaluationMarkdown', () => {
  it('UNIT-SM-EVL-014 laporan Markdown Bahasa Indonesia: parameter, peringatan, tabel per ember, baseline, sinyal, metodologi', () => {
    const r = run(baseActivities(), { prices: { ...PRICES, [KX]: [[S, 1], [S + 8 * HOUR, null]] } });
    const md = formatEvaluationMarkdown(r);
    for (const heading of ['# Laporan Evaluasi Historis — Smart Money Radar', '## Parameter', '## Ringkasan', '## Peringatan',
      '### Horizon 6 jam', '### Horizon 1 hari', '## Baseline gabungan', '## Sinyal', '## Metodologi & batasan']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain(DISCLAIMERS.conviction);
    expect(md).toContain('Hasil in-sample terhadap data yang tersedia');
    expect(md).toContain('hanya dari data sebelum t');
    expect(md).toContain('harga hilang (keluar)');
    expect(md).toContain('| Ember | Sinyal | Harga hilang | Cakupan |');
    expect(md).toContain('**DATA SIMULASI**');
    expect(md).toContain('PEPE (ethereum:0x0000…0071)');
    expect(md.endsWith('\n')).toBe(true);
    expect(() => formatEvaluationMarkdown({})).toThrow(TypeError);
  });

  it('UNIT-SM-EVL-015 simbol token on-chain dibersihkan (tanpa pipa/HTML) agar tabel & tampilan aman', () => {
    const evil = { address: X, symbol: 'PE|PE<script>alert(1)</script>', name: null, decimals: 18 };
    const acts = baseActivities().map((a) => (a.token.address === X ? { ...a, token: evil } : a));
    const md = formatEvaluationMarkdown(run(acts));
    expect(md).not.toContain('<script>');
    const row = md.split('\n').find((l) => l.includes('PEPEscriptalert1script'));
    expect(row).toBeDefined();
    const header = md.split('\n').find((l) => l.startsWith('| Waktu (t)'));
    expect(row.split('|').length).toBe(header.split('|').length);
  });
});
