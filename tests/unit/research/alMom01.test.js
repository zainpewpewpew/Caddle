// Runner praregistrasi AL-MOM-01 (docs/28): konfigurasi beku, paritas kelayakan & strata dengan research-mom-power.js,
// jendela & delisting, mode count tanpa hasil, SMD, bootstrap prosedur penuh, aturan replikasi tidak valid, keputusan,
// pengaman mode, dan analisis ujung ke ujung pada data sintetis.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ bySymbol: new Map() }));
vi.mock('../../../backend/backtest/runner.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    // Alert ditentukan tes (replay SA/PVA asli tidak menghasilkan alert pada data sintetis).
    replaySeries: async ({ symbol }) => {
      const s = mocked.bySymbol.get(symbol) ?? { v3: [], v2: [] };
      const trade = (i) => ({ entryIndex: i, direction: 'LONG' });
      return { trades: { v3: s.v3.map(trade), v2: s.v2.map(trade) }, evaluations: 0, skippedGap: 0 };
    },
  };
});

const { loadFromBinance } = await import('../../../backend/backtest/dataSource.js');
const { BACKTEST_WARMUP } = await import('../../../backend/backtest/runner.js');
const { atr } = await import('../../../backend/indicators/index.js');
const { forwardMove, stratumKey } = await import('../../../backend/research/matchedBaseline.js');
const { breakoutFlags, timingAt } = await import('../../../backend/research/signalTiming.js');
const { AL_SA_ATR_01 } = await import('../../../backend/research/alSaAtr01.js');
const { atrTrade: momAtrTrade, collectMomData } = await import('../../../scripts/research-mom-power.js');
const { delistingInfo } = await import('../../../scripts/research-al-sa-atr-01-audit.js');
const { DOCS27_IN_UNIVERSE } = await import('../../../scripts/research-mom-sim.js');
const { codeTreeHash: alSaTreeHash } = await import('../../../scripts/research-al-sa-atr-01.js');
const { SCENARIOS, simulateMarket, simWindow, analyzeSimulation, aggregateScenario, proportion } = await import('../../../scripts/research-al-mom-01-coverage.js');
const R = await import('../../../scripts/research-al-mom-01.js');

const H = 3_600_000;
const DAY = 86_400_000;

function walkCandles(n, { seed = 1, start = Date.UTC(2024, 0, 1), flatFrom = Infinity } = {}) {
  let x = seed;
  const rnd = () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
  let p = 100;
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const open = p;
    const flat = k >= flatFrom;
    const close = flat ? open : open * (1 + (rnd() - 0.5) * 0.02);
    out.push({
      openTime: start + k * H, closeTime: start + (k + 1) * H - 1, open, high: flat ? open : Math.max(open, close) * (1 + rnd() * 0.004),
      low: flat ? open : Math.min(open, close) * (1 - rnd() * 0.004), close, volume: flat ? 0 : 100 + rnd(), quoteVolume: 1, trades: 1,
      takerBuyVolume: 1, takerBuyQuoteVolume: 1, isClosed: true,
    });
    p = close;
  }
  return out;
}

describe('AL-MOM-01: konfigurasi & hash', () => {
  it('UNIT-MOM01-001 konfigurasi beku, cakupan hash pohon, impor hanya backend/ dan node:', async () => {
    expect(R.AL_MOM_01).toMatchObject({
      id: 'AL-MOM-01', direction: 'LONG', timeframe: '1h', windowStart: Date.UTC(2026, 10, 16), cutoff: Date.UTC(2028, 10, 16),
      settleBars: 50, warmupDays: 30, margin: 0.25, alpha: 0.05, blockDays: 7, reps: 10_000, seed: 20_261_116, invalidRepMaxShare: 0.01,
    });
    expect(R.AL_MOM_01.reps).toBeGreaterThanOrEqual(10_000);
    expect([...R.AL_MOM_01.sensitivityBlockDays]).toEqual([14, 1]);
    expect(R.AL_MOM_01.universe).toBe(AL_SA_ATR_01.universe);
    expect(R.AL_MOM_01.design).toMatchObject({ stopAtr: 1.5, targetR: 2, maxBars: 48, feeBps: 5, slippageBps: 2 });
    expect(Object.isFrozen(R.AL_MOM_01)).toBe(true);
    expect([...R.DEVELOPMENT_COINS]).toEqual([...DOCS27_IN_UNIVERSE]);
    for (const c of R.DEVELOPMENT_COINS) expect(AL_SA_ATR_01.universe).toContain(c);
    const tree = await R.codeTreeHash();
    const sa = await alSaTreeHash();
    expect(tree.files).toBe(sa.files); // backend/ sama; skrip AL-MOM-01 menggantikan skrip AL-SA-ATR-01
    expect(tree.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tree.hash).not.toBe(sa.hash);
    // Runner mandiri: semua impor dari backend/ atau modul bawaan Node, jadi hash di atas mencakup seluruh kode penentu hasil.
    const src = await readFile(new URL('../../../scripts/research-al-mom-01.js', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(5);
    for (const m of imports) expect(m.startsWith('node:') || m.startsWith('../backend/')).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), 'mom01-doc-'));
    const doc = join(dir, 'doc.md');
    await writeFile(doc, `x\nHash pohon kode AL-MOM-01: \`${'ab'.repeat(32)}\`\nHash pohon kode: \`${'cd'.repeat(32)}\`\n`);
    expect(await R.frozenTreeHash(doc)).toBe('ab'.repeat(32));
    await writeFile(doc, 'belum ada\n');
    expect(await R.frozenTreeHash(doc)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('AL-MOM-01: kelayakan, fitur, dan paritas dengan research-mom-power.js', () => {
  it('UNIT-MOM01-002 kelayakan tanpa hasil ≡ rantai timingAt/forwardMove/atrTrade; prePos ≡ timingAt', () => {
    const candles = walkCandles(700, { seed: 3 });
    // Bagian datar (ATR → turun) dan harga sangat kecil di ujung untuk menguji batas.
    for (let k = 400; k < 430; k += 1) Object.assign(candles[k], { open: 50, high: 50, low: 50, close: 50 });
    const A = atr(candles, 14);
    const flags = breakoutFlags(candles, 'LONG', 48);
    let eligible = 0;
    for (let i = 0; i < candles.length; i += 1) {
      const inRange = i >= BACKTEST_WARMUP && i <= candles.length - 1 - 48;
      const tm = inRange ? timingAt(candles, A, flags, 'LONG', i, { donchian: 48, look: 12 }) : null;
      const old = inRange && tm !== null && forwardMove(candles, A, 'LONG', i, 12) !== null && forwardMove(candles, A, 'LONG', i, 48) !== null
        && momAtrTrade(candles, A, i) !== null;
      expect(R.eligibleAt(candles, A, i)).toBe(old);
      if (old) {
        eligible += 1;
        const pp = R.prePos(candles, A, i);
        expect(pp.pre).toBeCloseTo(tm.pre, 12);
        expect(pp.pos).toBeCloseTo(tm.pos, 12);
        const y = R.outcomesAt(candles, A, i);
        expect(y.A).toBeCloseTo(forwardMove(candles, A, 'LONG', i, 12), 12);
        expect(y.B).toBeCloseTo(momAtrTrade(candles, A, i).r, 12);
      }
    }
    expect(eligible).toBeGreaterThan(400);
    expect([...R.previousAlertIndex(8, [2, 5])]).toEqual([-1, -1, -1, 2, 2, 2, 5, 5]);
    expect([...R.exclusionAfter(8, [2], 3)]).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
    expect([null, 1, 12, 13, 48, 49, 400].map((x) => R.distanceIndex(x))).toEqual([2, 0, 0, 1, 1, 2, 2]);
    expect([null, 3, 48, 49, 90].map((x) => R.cappedDistance(x))).toEqual([49, 3, 48, 49, 49]);
    expect([-9, -4, -3.99, 0, 5.99, 6, 40].map((x) => R.preIndex(x, 0.5))).toEqual([0, 0, 0, 8, 19, 20, 20]);
    expect([-9, 0, 6, 40].map((x) => R.preIndex(x, 0.25))).toEqual([0, 16, 40, 40]);
  });

  describe('UNIT-MOM01-003 paritas pengumpulan dengan collectMomData (replay di-mock)', () => {
    let cacheDir;
    const symbols = ['AAAUSDT', 'BBBUSDT'];
    const series = new Map();
    beforeAll(async () => {
      cacheDir = await mkdtemp(join(tmpdir(), 'mom01-cache-'));
      const from = Date.UTC(2024, 0, 1);
      const to = Date.UTC(2024, 5, 1);
      for (const [k, symbol] of symbols.entries()) {
        const candles = walkCandles((to - from) / H, { seed: 11 + k, start: from });
        const client = {
          getKlines: async ({ startTime, endTime }) => candles.filter((c) => c.openTime >= startTime && c.openTime <= endTime).map(({ isClosed: _closed, ...c }) => c),
        };
        await loadFromBinance({ symbol, timeframe: '1h', from, to, client, cacheDir, now: Date.UTC(2025, 0, 1) });
        // Alert v3 (subset dari v2 ∪ v3) dan event v2 berkelompok seperti data nyata.
        const v3 = [];
        const v2 = [];
        for (let i = 160; i < candles.length - 60; i += 37 + (i % 11)) {
          v3.push(i);
          v2.push(i, i + 4 + (i % 9));
          if (i % 3 === 0) v3.push(i + 20);
        }
        mocked.bySymbol.set(symbol, { v3: [...new Set(v3)].sort((a, b) => a - b), v2: [...new Set(v2)].sort((a, b) => a - b) });
        series.set(symbol, (await loadFromBinance({ symbol, timeframe: '1h', from, to, cacheDir })).candles);
      }
    });
    afterAll(async () => {
      await rm(cacheDir, { recursive: true, force: true });
    });

    it('alert, kunci strata, hasil A/B, dan agregat pembanding per strata sama persis', async () => {
      const old = await collectMomData({ from: Date.UTC(2024, 0, 1), to: Date.UTC(2024, 5, 1), cacheDir });
      const store = R.createStore({ withOutcomes: true });
      for (const [sym, symbol] of symbols.entries()) {
        const m = mocked.bySymbol.get(symbol);
        const any = [...new Set([...m.v2, ...m.v3])].sort((a, b) => a - b);
        R.collectSeries({ store, sym, symbol, candles: series.get(symbol), v3Idx: m.v3, anyIdx: any, window: { from: -Infinity, to: Infinity }, outcomeFn: R.outcomesAt });
      }
      expect(store.outcomeMismatch).toBe(0);
      expect(store.alerts.length).toBe(old.acc.alerts.length);
      expect(store.alerts.length).toBeGreaterThan(100);
      const label = (a) => R.stratumLabel({ symbol: a.symbol, quarter: a.quarter, preB: a.preB, posB: a.posB, volB: a.volB, distIdx: a.distIdx });
      const byT = new Map(old.acc.alerts.map((a) => [`${a.symbol}|${a.t}`, a]));
      for (const a of store.alerts) {
        const o = byT.get(`${a.symbol}|${a.t}`);
        expect(label(a)).toBe(o.keyJarak);
        expect(stratumKey({ symbol: a.symbol, period: a.quarter, pre: a.pre, pos: a.pos, volBin: a.volB })).toBe(o.key);
        expect(a.y.A).toBeCloseTo(o.y.fwd12, 12);
        expect(a.y.B).toBeCloseTo(o.y.rAtr, 12);
        expect(a.sincePrev).toBe(o.sincePrev);
        const checks = [['jarak', old.acc.controls.tanpaJarak, o.keyJarak], ['dasar', old.acc.controls.tanpa, o.key], ['lampau', old.acc.controls.lampau, o.key]];
        for (const [level, map, key] of checks) {
          const t = store.strata[level].get(a.code[level]);
          const c = map.get(key);
          expect(t?.[0] ?? 0).toBe(c?.n ?? 0);
          if (c) {
            expect(t[1]).toBeCloseTo(c.sums.fwd12, 9);
            expect(t[2]).toBeCloseTo(c.sums.rAtr, 9);
          }
        }
      }
      expect(store.controls.tanpa).toBe([...old.acc.controls.tanpa.values()].reduce((s, c) => s + c.n, 0));
      expect(store.controls.lampau).toBe([...old.acc.controls.lampau.values()].reduce((s, c) => s + c.n, 0));
    });
  });

  it('UNIT-MOM01-004 jendela, tersil dari populasi jendela, delisting, dan sel hanya untuk strata ber-alert', () => {
    const candles = walkCandles(3000, { seed: 5, flatFrom: 2600 });
    const v3 = [400, 900, 1500, 2100, 2650];
    const window = { from: candles[300].openTime, to: candles[2400].openTime };
    const store = R.createStore({ withOutcomes: true });
    const res = R.collectSeries({ store, sym: 0, symbol: 'XUSDT', candles, v3Idx: v3, anyIdx: v3, window, outcomeFn: R.outcomesAt });
    expect(store.alerts.map((a) => a.openTime)).toEqual([400, 900, 1500, 2100].map((i) => candles[i].openTime));
    for (const a of store.alerts) expect(a.openTime >= window.from && a.openTime < window.to).toBe(true);
    // Tersil hanya dari candle jendela: mengubah volatilitas di luar jendela tidak mengubah bin alert.
    const wild = candles.map((c, k) => (k < 300 || k >= 2400 ? { ...c, high: c.high * 1.3, low: c.low * 0.7 } : c));
    const store2 = R.createStore({ withOutcomes: true });
    R.collectSeries({ store: store2, sym: 0, symbol: 'XUSDT', candles: wild, v3Idx: v3, anyIdx: v3, window, outcomeFn: R.outcomesAt });
    // ATR candle awal jendela ikut berubah lewat smoothing Wilder; bandingkan alert yang jauh dari tepi saja.
    expect(store2.alerts.slice(1, 3).map((a) => a.volB)).toEqual(store.alerts.slice(1, 3).map((a) => a.volB));
    // Delisting terverifikasi di candle 2000: candle pada/sesudahnya dikeluarkan.
    const store3 = R.createStore({ withOutcomes: true });
    const res3 = R.collectSeries({ store: store3, sym: 0, symbol: 'XUSDT', candles, v3Idx: v3, anyIdx: v3, window, delistingTime: candles[2000].openTime, outcomeFn: R.outcomesAt });
    expect(store3.alerts.map((a) => a.openTime)).toEqual([400, 900, 1500].map((i) => candles[i].openTime));
    expect(res3.excludedDelisting).toBe(400);
    expect(res3.spanningDelisting).toBe(48);
    expect(res.eligible).toBeGreaterThan(res3.eligible);
    // Sel & agregat hanya untuk strata yang punya alert.
    const codes = new Set(store.alerts.map((a) => a.code.jarak));
    expect([...store.strata.jarak.keys()].every((c) => codes.has(c))).toBe(true);
    expect(store.cells.jarak.code.every((c) => codes.has(c))).toBe(true);
  });

  it('UNIT-MOM01-005 mode count: fungsi hasil tidak pernah dipanggil dan tidak ada hasil di keluaran', () => {
    const candles = walkCandles(1500, { seed: 9 });
    const v3 = [300, 700, 1100];
    const window = { from: -Infinity, to: Infinity };
    const boom = () => {
      throw new Error('hasil dihitung di mode count');
    };
    const store = R.createStore({ withOutcomes: false });
    expect(() => R.collectSeries({ store, sym: 0, symbol: 'XUSDT', candles, v3Idx: v3, anyIdx: v3, window, outcomeFn: boom })).toThrow(/mode count/);
    const res = R.collectSeries({ store, sym: 0, symbol: 'XUSDT', candles, v3Idx: v3, anyIdx: v3, window });
    expect(res.alerts).toBe(3);
    expect(store.cells).toBeNull();
    expect(store.alerts.every((a) => !('y' in a))).toBe(true);
    for (const t of store.strata.jarak.values()) expect([t[1], t[2]]).toEqual([0, 0]);
    const summary = R.countSummary(store);
    const keys = new Set();
    const walk = (o) => {
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { keys.add(k); walk(v); }
    };
    walk(summary);
    for (const k of ['y', 'A', 'B', 'primary', 'att', 'lo', 'hi', 'fwd12', 'rAtr']) expect(keys.has(k)).toBe(false);
    expect(summary).toMatchObject({ alerts: 3 });
    // Store tanpa hasil tidak bisa dianalisis, dan store dengan hasil wajib diberi fungsi hasil.
    expect(() => R.analyzeStore({ store, dayFrom: 0, dayTo: 10 })).toThrow(/butuh store dengan hasil/);
    expect(() => R.collectSeries({ store: R.createStore({ withOutcomes: true }), sym: 0, symbol: 'XUSDT', candles, v3Idx: v3, anyIdx: v3, window })).toThrow(/outcomeFn wajib/);
  });

  it('UNIT-MOM01-006 aturan delisting sama dengan audit AL-SA-ATR-01; ekor datar tanpa verifikasi = belum beres', () => {
    const candles = walkCandles(400, { seed: 2, flatFrom: 300 });
    const t300 = candles[300].openTime;
    const cases = [
      { meta: { status: 'TRADING', deliveryDate: R.FAR_DELIVERY }, manual: null },
      { meta: { status: 'SETTLING', deliveryDate: t300 }, manual: null },
      { meta: { status: 'SETTLING', deliveryDate: candles[200].openTime }, manual: null },
      { meta: { status: 'SETTLING', deliveryDate: R.FAR_DELIVERY }, manual: null },
      { meta: null, manual: { time: t300, source: 'https://x' } },
    ];
    for (const c of cases) {
      const a = delistingInfo({ meta: c.meta, manual: c.manual, candles });
      const b = R.delistingStatus({ meta: c.meta, manual: c.manual, candles });
      expect({ time: b.time, source: b.source, verified: b.verified }).toEqual(a);
    }
    expect(R.delistingStatus({ meta: cases[1].meta, candles })).toMatchObject({ verified: true, unresolved: false, flatTail: 100 });
    expect(R.delistingStatus({ meta: cases[2].meta, candles })).toMatchObject({ verified: false, unresolved: true });
    expect(R.delistingStatus({ meta: cases[0].meta, candles })).toMatchObject({ time: null, unresolved: true }); // ekor datar 100 candle
    expect(R.delistingStatus({ meta: cases[0].meta, candles: walkCandles(400, { seed: 2 }) })).toMatchObject({ unresolved: false });
    expect(R.seriesIntegrity([...candles.slice(0, 10), ...candles.slice(12, 20)])).toMatchObject({ gaps: 1, missingCandles: 2 });
    // Data berhenti > 2 candle sebelum batas akhir tanpa delisting terverifikasi = belum beres (docs/26 §11.2).
    const end = candles.at(-1).closeTime + 1;
    expect(R.endsEarly(candles, end)).toBe(false);
    expect(R.endsEarly(candles, end + 2 * H)).toBe(false);
    expect(R.endsEarly(candles, end + 3 * H)).toBe(true);
    expect(R.endsEarly(candles, end + 30 * H, { verified: true })).toBe(false);
    expect(R.endsEarly([], end)).toBe(true);
  });
});

describe('AL-MOM-01: statistik', () => {
  it('UNIT-MOM01-007 SMD: definisi, penyebut tetap, varians nol, ambang 0,10/0,20', () => {
    expect(R.smdValue(0.5, 2, 1)).toMatchObject({ smd: 0.25, status: 'tidak seimbang besar', basis: 'sd alert' });
    expect(R.smdValue(0.2, 2, 1)).toMatchObject({ smd: 0.1, status: 'seimbang' });
    expect(R.smdValue(0.21, 2, 1).status).toBe('tidak seimbang');
    expect(R.smdValue(0.3, 0, 0.6)).toMatchObject({ basis: 'sd gabungan' });
    expect(R.smdValue(0.3, 0, 0.6).smd).toBeCloseTo(0.3 / Math.sqrt(0.18), 12);
    expect(R.smdValue(0, 0, 0)).toMatchObject({ smd: 0, status: 'seimbang' });
    expect(R.smdValue(0.1, 0, 0)).toMatchObject({ smd: null, status: 'tak terdefinisi' });
    // Tabel: dua alert (pre 3 & 5) di strata yang pembandingnya rata-rata pre 3.
    const store = R.createStore({ withOutcomes: true });
    const mk = (pre, code) => ({ pre, pos: 0.5, atr: 0.01, dist: 49, distIdx: 2, code: { jarak: code, dasar: code, halus: code, lampau: code } });
    store.alerts.push(mk(3, 1), mk(5, 1));
    const t = new Float64Array(10);
    Object.assign(t, [2, 0, 0, 6, 1, 0.02, 98, 0, 0, 2]);
    for (const l of R.LEVELS) store.strata[l].set(1, t);
    Object.assign(store.before, { n: 4, sum: Float64Array.from([4, 2, 0.04, 196]), sumsq: Float64Array.from([8, 1, 0.0004, 9604]), dist: Float64Array.from([0, 0, 4]) });
    const bal = R.balanceTable({ store, matchedBy: { jarak: store.alerts } });
    expect(bal.continuous.pre.after.jarak.smd).toBeCloseTo((4 - 3) / Math.SQRT2, 12);
    expect(bal.continuous.pre.before.smd).toBeCloseTo((4 - 1) / Math.SQRT2, 12);
    expect(bal.continuous.pos.after.jarak).toMatchObject({ smd: 0, status: 'seimbang', basis: 'varians nol' });
    expect(bal.triggered).toBe(true);
    expect(bal.worstPrimary).toBeCloseTo(1 / Math.SQRT2, 12);
    // Tanpa pembanding "tanpa" sama sekali: SMD sebelum pencocokan tak terdefinisi, bukan angka semu.
    const empty = R.createStore({ withOutcomes: true });
    empty.alerts.push(mk(3, 1), mk(5, 1));
    for (const l of R.LEVELS) empty.strata[l].set(1, t);
    const bal2 = R.balanceTable({ store: empty, matchedBy: { jarak: empty.alerts } });
    expect(bal2.continuous.pre.before).toMatchObject({ smd: null, status: 'tak terdefinisi' });
    expect(bal2.distance.jauh.before).toMatchObject({ smd: null, status: 'tak terdefinisi' });
  });

  function tinyIndex({ alerts, cells, D }) {
    const store = R.createStore({ withOutcomes: true });
    for (const c of cells) {
      const t = store.strata.jarak.get(c.code) ?? new Float64Array(10);
      t[0] += c.n;
      t[1] += c.a;
      t[2] += c.b;
      store.strata.jarak.set(c.code, t);
      Object.entries({ code: c.code, day: c.day, n: c.n, a: c.a, b: c.b }).forEach(([k, v]) => store.cells.jarak[k].push(v));
    }
    store.alerts.push(...alerts);
    const index = R.buildLevelIndex({ store, level: 'jarak', alerts, dayFrom: 0, D });
    return { store, index };
  }
  const alertAt = (day, A, code = 1) => ({ day, y: { A, B: A / 2 }, code: { jarak: code }, extreme: false });

  it('UNIT-MOM01-008 bootstrap: deterministik; pembanding konstan → semua varian sama; populasi tetap ≠ penuh bila pembanding hilang', () => {
    const D = 60;
    const alerts = Array.from({ length: 60 }, (_, d) => alertAt(d, (d % 7) / 10));
    const cells = Array.from({ length: 60 }, (_, d) => ({ code: 1, day: d, n: 3, a: 3 * 0.2, b: 3 * 0.1 }));
    const { index } = tinyIndex({ alerts, cells, D });
    const run = (seed) => R.runBootstrap({ D, blockDays: 7, reps: 400, seed, indexes: { jarak: index }, groups: [R.buildGroup({ name: 'main', index, alerts, dayFrom: 0, variants: true, diagnostics: true })] });
    const b1 = run(5);
    const b2 = run(5);
    expect([...b1.groups[0].full.a]).toEqual([...b2.groups[0].full.a]);
    // Blok terakhir dipotong: deret hasil resampling tepat D hari (satu alert per hari → bobot alert = D).
    expect([b1.nBlocks, b1.lastLen]).toEqual([9, 4]);
    expect([...b1.groups[0].alertsOnly.w].every((x) => x === 60)).toBe(true);
    const g = b1.groups[0];
    const full = R.ratioSeries(g.full.a, g.full.w);
    for (const v of ['fixedPop', 'sameSet', 'alertsOnly']) {
      const x = R.ratioSeries(g[v].a, g[v].w);
      for (let k = 0; k < full.length; k += 1) expect(x[k]).toBeCloseTo(full[k], 12);
    }
    // Pembanding strata 2 hanya di hari 59: replikasi tanpa hari 59 → penuh membuang alertnya, populasi tetap memakai rata-rata penuh.
    const alerts2 = [...alerts, alertAt(10, 5, 2)];
    const { index: index2 } = tinyIndex({ alerts: alerts2, cells: [...cells, { code: 2, day: 59, n: 1, a: 0, b: 0 }], D });
    const bb = R.runBootstrap({ D, blockDays: 7, reps: 400, seed: 5, indexes: { jarak: index2 }, groups: [R.buildGroup({ name: 'main', index: index2, alerts: alerts2, dayFrom: 0, variants: true, diagnostics: true })] });
    const gg = bb.groups[0];
    const fp = R.ratioSeries(gg.fixedPop.a, gg.fixedPop.w);
    const fu = R.ratioSeries(gg.full.a, gg.full.w);
    let differ = 0;
    for (let k = 0; k < fp.length; k += 1) if (Math.abs(fp[k] - fu[k]) > 1e-9) differ += 1;
    expect(differ).toBeGreaterThan(50);
    const diag = R.replicateDiagnostics(bb, 'main');
    expect(diag.lostShare['1']).toBeGreaterThan(0);
    expect(diag.activeStrata['0']).toBeGreaterThanOrEqual(1);
    const dec = R.varianceDecomposition(bb, 'main', 'a');
    expect(dec.reps).toBe(400);
    expect(dec.varFixedPop).toBeGreaterThan(0);
  });

  it('UNIT-MOM01-009 replikasi tidak valid: dikeluarkan, dihitung, dan > 1% → tidak stabil → kelompok 4', () => {
    // Satu alert & pembanding hanya di hari 0 dari 50 hari, blok harian: peluang hari 0 tidak terambil (49/50)^50 ≈ 36%.
    const D = 50;
    const alerts = [alertAt(0, 1)];
    const { index } = tinyIndex({ alerts, cells: [{ code: 1, day: 0, n: 2, a: 0.4, b: 0.2 }], D });
    const b = R.runBootstrap({ D, blockDays: 1, reps: 1000, seed: 9, indexes: { jarak: index }, groups: [R.buildGroup({ name: 'main', index, alerts, dayFrom: 0 })] });
    const s = R.summarizeReplicates(R.ratioSeries(b.groups[0].full.a, b.groups[0].full.w), 0.8);
    expect(s.invalid).toBeGreaterThan(300);
    expect(s.invalid).toBeLessThan(430);
    expect(s.valid + s.invalid).toBe(1000);
    expect(s.stable).toBe(false);
    expect(R.verdictGroup({ lo: 0.1, hi: 0.2, stable: s.stable }).group).toBe(4);
    // Persentil = nilai terurut ke-floor(p · m), sama dengan matchedBaseline.
    const t = R.summarizeReplicates(Float64Array.from({ length: 10_000 }, (_, k) => 9999 - k), 1);
    expect([t.lo, t.hi, t.valid, t.invalid, t.stable]).toEqual([250, 9750, 10_000, 0, true]);
    const u = R.summarizeReplicates(Float64Array.from([...Array(990).fill(1), ...Array(10).fill(NaN)]), 1);
    expect([u.invalid, u.stable]).toEqual([10, true]);
    const w = R.summarizeReplicates(Float64Array.from([...Array(989).fill(1), ...Array(11).fill(NaN)]), 1);
    expect(w.stable).toBe(false);
  });

  it('UNIT-MOM01-016 fallback diulang per replikasi: strata utama bila ada pembanding, selain itu strata dasar', () => {
    const D = 40;
    const store = R.createStore({ withOutcomes: true });
    const put = (level, code, day, n, a) => {
      const t = store.strata[level].get(code) ?? new Float64Array(10);
      t[0] += n;
      t[1] += a;
      store.strata[level].set(code, t);
      Object.entries({ code, day, n, a, b: 0 }).forEach(([k, v]) => store.cells[level][k].push(v));
    };
    // Alert hari 5: strata utama 1 (pembanding hanya hari 30, A = 1), strata dasar 9 (pembanding hari 5, A = 0).
    const alert = { symbol: 'X', day: 5, y: { A: 2, B: 0 }, code: { jarak: 1, dasar: 9 }, extreme: false };
    put('jarak', 1, 30, 1, 1);
    put('dasar', 9, 5, 1, 0);
    put('dasar', 9, 30, 1, 1);
    store.alerts.push(alert);
    const ij = R.buildLevelIndex({ store, level: 'jarak', alerts: [alert], dayFrom: 0, D });
    const id = R.buildLevelIndex({ store, level: 'dasar', alerts: [alert], dayFrom: 0, D });
    const b = R.runBootstrap({
      D, blockDays: 1, reps: 600, seed: 3, indexes: { jarak: ij, dasar: id },
      groups: [R.buildGroup({ name: 'fb', index: ij, alerts: [alert], dayFrom: 0, fallbackIndex: id }), R.buildGroup({ name: 'j', index: ij, alerts: [alert], dayFrom: 0 })],
    });
    const fb = R.ratioSeries(b.groups[0].full.a, b.groups[0].full.w);
    const j = R.ratioSeries(b.groups[1].full.a, b.groups[1].full.w);
    let viaBase = 0;
    for (let k = 0; k < 600; k += 1) {
      if (Number.isFinite(j[k])) expect(fb[k]).toBeCloseTo(j[k], 12); // utama tersedia → sama dengan utama (2 − 1)
      else if (Number.isFinite(fb[k])) {
        expect(fb[k]).toBeCloseTo(2, 12); // utama hilang → dasar (hanya hari 5 terambil, A pembanding 0)
        viaBase += 1;
      }
    }
    expect(viaBase).toBeGreaterThan(50);
    expect(() => R.buildGroup({ name: 'x', index: ij, alerts: [alert], dayFrom: 0, fallbackIndex: id, variants: true })).toThrow(/satu level/);
  });

  it('UNIT-MOM01-017 pembanding metode CI (laporan saja): basic, BC, pergeseran median, penanda rapuh', () => {
    expect(R.normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(R.normalQuantile(0.5)).toBeCloseTo(0, 12);
    expect(R.normalCdf(R.normalQuantile(0.01))).toBeCloseTo(0.01, 6);
    // Simetris di sekitar titik → basic = persentil, BC ≈ persentil, tidak rapuh.
    const sym = Float64Array.from({ length: 2001 }, (_, k) => (k - 1000) / 1000);
    const c = R.ciMethodComparison(sym, 0);
    expect(c.shiftSe).toBeCloseTo(0, 12);
    expect(c.basic.lo).toBeCloseTo(-c.percentile.hi, 12);
    expect(c.bc.lo).toBeCloseTo(c.percentile.lo, 2);
    expect(c.fragile).toBe(false);
    // Replikasi berpusat 0,15 (titik 0,2): persentil [≈0,074 … ≈0,226] = kelompok 1; basic naik ke ≥ 0,25 → kelompok 2 → rapuh.
    const shifted = Float64Array.from({ length: 2001 }, (_, k) => 0.15 + 0.08 * ((k - 1000) / 1000));
    const d = R.ciMethodComparison(shifted, 0.2, { margin: 0.25 });
    expect(d.shiftSe).toBeLessThan(0);
    expect(d.basic.hi).toBeGreaterThan(d.percentile.hi);
    expect(d.bc.hi).toBeGreaterThan(d.percentile.hi);
    expect(d.groups.percentile).toBe(1);
    expect(d.groups.basic).toBe(2);
    expect(d.fragile).toBe(true);
    expect(R.ciMethodComparison(new Float64Array(0), 0)).toBeNull();
  });

  it('UNIT-MOM01-010 kelompok keputusan docs/28 §6 termasuk batas', () => {
    const M = 0.25;
    expect(R.verdictGroup({ lo: 0.01, hi: 0.2 }, M).group).toBe(1);
    expect(R.verdictGroup({ lo: 0.01, hi: 0.25 }, M).group).toBe(2);
    expect(R.verdictGroup({ lo: 0, hi: 0.2 }, M).group).toBe(3);
    expect(R.verdictGroup({ lo: -0.1, hi: 0.25 }, M).group).toBe(4);
    expect(R.verdictGroup({ lo: null, hi: 0.1 }, M).group).toBe(4);
    expect(R.GROUP_TEXT[3].product).toMatch(/tanpa klaim nilai tambah/);
  });
});

describe('AL-MOM-01: pengaman mode', () => {
  const cfg = R.AL_MOM_01;
  const ok = { tree: 'a'.repeat(64), frozen: 'a'.repeat(64), gitClean: true, previousEvaluations: [], integrityProblems: [] };
  it('UNIT-MOM01-011 validate hanya sebelum jendela; count hanya tanggal lewat; evaluate ditolak keras', () => {
    const d = (s) => Date.parse(`${s}T00:00:00Z`);
    expect(R.assertModeAllowed({ mode: 'validate', from: d('2024-10-01'), to: d('2026-10-01'), now: d('2026-11-15') })).toBe(true);
    expect(R.assertModeAllowed({ mode: 'validate', from: d('2024-10-01'), to: d('2026-11-16'), now: d('2027-01-01') })).toBe(true);
    expect(() => R.assertModeAllowed({ mode: 'validate', from: d('2024-10-01'), to: d('2026-11-17'), now: d('2027-01-01') })).toThrow(/sebelum jendela uji/);
    expect(() => R.assertModeAllowed({ mode: 'validate', from: d('2026-10-01'), to: d('2026-11-01'), now: d('2027-01-01') })).toThrow(/minimal 90 hari/);
    expect(() => R.assertModeAllowed({ mode: 'validate', to: d('2026-10-01'), now: d('2027-01-01') })).toThrow(/--from wajib/);
    expect(R.assertModeAllowed({ mode: 'count', to: d('2027-01-01'), now: d('2027-01-02') })).toBe(true);
    expect(() => R.assertModeAllowed({ mode: 'count', to: d('2027-01-01'), now: d('2026-12-31') })).toThrow(/sudah lewat/);
    expect(() => R.assertModeAllowed({ mode: 'count', to: d('2026-11-16'), now: d('2026-12-31') })).toThrow(/sesudah awal jendela/);
    expect(() => R.assertModeAllowed({ mode: 'lain', to: d('2027-01-01'), now: d('2027-01-02') })).toThrow(/--mode/);
    const after = cfg.cutoff + DAY;
    expect(R.assertModeAllowed({ mode: 'evaluate', to: cfg.cutoff, now: after, ...ok })).toBe(true);
    const reject = (over, re) => expect(() => R.assertModeAllowed({ mode: 'evaluate', to: cfg.cutoff, now: after, ...ok, ...over })).toThrow(re);
    reject({ now: cfg.cutoff - 1 }, /cutoff .* belum lewat/);
    reject({ to: cfg.cutoff - DAY }, /--to harus 2028-11-16/);
    reject({ frozen: null }, /belum tercatat/);
    reject({ tree: 'b'.repeat(64) }, /hash pohon/);
    reject({ gitClean: false }, /tidak bersih/);
    reject({ gitClean: null }, /tidak bersih/);
    reject({ previousEvaluations: ['evaluate-2028-11-16.json'] }, /log evaluasi sebelumnya/);
    reject({ previousEvaluations: ['evaluate-2028-11-16.json'], rerunReason: 'pendek' }, /log evaluasi sebelumnya/);
    expect(R.assertModeAllowed({ mode: 'evaluate', to: cfg.cutoff, now: after, ...ok, previousEvaluations: ['x'], rerunReason: 'koreksi bug terdokumentasi di docs/28 §10' })).toBe(true);
    reject({ integrityProblems: null }, /belum diperiksa/);
    reject({ integrityProblems: ['ZZZUSDT GAGAL_DIAMBIL'] }, /data belum beres/);
    reject({ defaultDirs: false }, /--log-dir dan --cache-dir harus bawaan/);
    try {
      R.assertModeAllowed({ mode: 'evaluate', to: cfg.cutoff - DAY, now: cfg.cutoff - 1, ...ok, gitClean: false });
    } catch (err) {
      expect(err.reasons.length).toBe(3); // semua alasan dilaporkan sekaligus
    }
  });
});

describe('AL-MOM-01: analisis ujung ke ujung (sintetis)', () => {
  it('UNIT-MOM01-012 collectUniverse + analyzeStore + renderMarkdown: semua bagian, konsisten, tanpa NaN tersembunyi', async () => {
    const sc = { ...SCENARIOS.dasar0, symbols: 6, days: 200 };
    const sims = [];
    simulateMarket(sc, 77, (s) => sims.push(s));
    const bySymbol = new Map(sims.map((s) => [s.symbol, s]));
    const window = simWindow(sc);
    const deps = {
      loadCandles: async (symbol) => bySymbol.get(symbol).candles,
      replayIdx: async (symbol) => ({ v3Idx: bySymbol.get(symbol).v3Idx, anyIdx: bySymbol.get(symbol).anyIdx }),
      delisting: (symbol, candles) => R.delistingStatus({ meta: undefined, candles }),
    };
    const col = await R.collectUniverse({ symbols: [...bySymbol.keys()], window, loadFrom: 0, dataTo: 0, withOutcomes: true, deps });
    expect(col.integrity.problems).toEqual([]);
    const dayFrom = Math.floor(window.from / DAY);
    const dayTo = Math.floor((window.to - 1) / DAY) + 1;
    const a = R.analyzeStore({ store: col.store, dayFrom, dayTo, reps: 300, precisionSeeds: [3, 4], withVerdict: true });
    // Deterministik: analisis ulang pada store yang sama menghasilkan laporan identik.
    expect(JSON.stringify(R.analyzeStore({ store: col.store, dayFrom, dayTo, reps: 300, precisionSeeds: [3, 4], withVerdict: true }))).toBe(JSON.stringify(a));
    expect(a.counts.alerts).toBe(col.store.alerts.length);
    expect(a.counts.matched.jarak).toBe(a.overlap.matched);
    expect(a.overlap.matched + a.overlap.unmatched).toBe(a.overlap.alerts);
    expect(a.sensitivity.fallback.n).toBe(a.counts.matched.jarak + a.sensitivity.fallback.fromBase);
    expect(a.primary.A.reps).toBe(300);
    expect(Object.keys(a.methods).sort()).toEqual(['1', '14', '7']);
    expect(a.methods[7].full.A.lo).toBe(a.primary.A.lo);
    expect([1, 2, 3, 4]).toContain(a.verdict.group);
    expect(a.precision.seeds).toBe(2);
    expect(a.diagnostics.lostVsAtt.nTop + a.diagnostics.lostVsAtt.nRest).toBe(300);
    expect(a.decomposition.A.reps).toBe(300);
    expect(a.months.reduce((s, m) => s + m.alerts, 0)).toBe(a.counts.alerts);
    expect(a.ciMethods.percentile).toEqual({ lo: a.primary.A.lo, hi: a.primary.A.hi });
    expect(Object.keys(a.overlap.profiles.matched.group).every((k) => ['koin docs/24–27', 'koin lain'].includes(k))).toBe(true);
    const report = {
      id: 'AL-MOM-01', mode: 'validate', generatedAt: 'uji', window: { from: 'a', to: 'b' }, dataTo: 'c', tree: { hash: 'h' }, hashesMatch: false,
      git: { commit: 'x', clean: true }, node: 'v', symbols: [...bySymbol.keys()], skipped: [], integrity: col.integrity, analysis: a,
    };
    const md = R.renderMarkdown(report);
    for (const h of ['## Estimand utama', '## Perbandingan metode bootstrap', '## Diagnostik per replikasi', '## Sensitivitas pencocokan', '## Keseimbangan kovariat',
      '## Overlap dan gerak awal ≥ 4 ATR', '## Subkelompok', '## Laju alert per bulan', '## Integritas data']) expect(md).toContain(h);
    expect(md).not.toMatch(/NaN|undefined/);
    // Mode evaluate memuat vonis; validasi tidak.
    expect(R.renderMarkdown({ ...report, mode: 'evaluate' })).toMatch(/## Hasil: kelompok [1-4]/);
  });

  it('UNIT-MOM01-013 subkelompok kosong & tidak ada alert tak cocok → "tidak terestimasi", bukan nol', () => {
    const D = 30;
    const store = R.createStore({ withOutcomes: true });
    const alerts = Array.from({ length: 20 }, (_, d) => ({
      symbol: 'X', sym: 0, day: d, openTime: d * DAY, t: d * DAY, pre: 1, pos: 0.5, atr: 0.01, dist: 49, distIdx: 2, extreme: false,
      code: { jarak: 1, dasar: 2, halus: 3, lampau: 2 }, y: { A: 0.1, B: 0.05 },
    }));
    store.alerts.push(...alerts);
    for (const [level, code] of [['jarak', 1], ['dasar', 2], ['halus', 3], ['lampau', 2]]) {
      const t = new Float64Array(10);
      for (let d = 0; d < D; d += 1) {
        t[0] += 2; t[1] += 0.1; t[2] += 0.05; t[3] += 2; t[4] += 1; t[5] += 0.02; t[6] += 98; t[9] += 2;
        Object.entries({ code, day: d, n: 2, a: 0.1, b: 0.05 }).forEach(([k, v]) => store.cells[level][k].push(v));
      }
      store.strata[level].set(code, t);
    }
    Object.assign(store.before, { n: 60, sum: Float64Array.from([60, 30, 0.6, 2940]), sumsq: Float64Array.from([70, 16, 0.0061, 144060]), dist: Float64Array.from([0, 0, 60]) });
    const a = R.analyzeStore({ store, dayFrom: 0, dayTo: D, reps: 200, precisionSeeds: [] });
    expect(a.subgroups.extreme).toMatchObject({ n: 0, estimable: false });
    expect(a.subgroups.repeat).toMatchObject({ n: 0, estimable: false });
    expect(a.subgroups.interactionFreshRepeat.estimable).toBe(false);
    expect(a.overlap.viaBase).toMatchObject({ n: 0, estimable: false });
    expect(a.overlap.extreme).toMatchObject({ n: 0, coveredShare: null, unmatchedShareOfExtreme: null });
    expect(a.primary.A.point).toBeCloseTo(0.1 - 0.05, 12);
    expect(a.precision).toBeNull();
  });
});

describe('AL-MOM-01: simulasi coverage', () => {
  it('UNIT-MOM01-014 DGP deterministik, drift nol bila δ = 0, target θ_d positif & teratenuasi bila δ > 0, agregasi & Wilson', () => {
    const sc = { ...SCENARIOS.dasar0, symbols: 4, days: 120 };
    const a = [];
    const b = [];
    simulateMarket(sc, 5, (s) => a.push(s));
    simulateMarket(sc, 5, (s) => b.push(s));
    expect(a[2].candles[500].close).toBe(b[2].candles[500].close);
    expect(a.every((s) => s.cumDrift.every((x) => x === 0))).toBe(true);
    expect(a.every((s) => s.v3Idx.every((i) => s.anyIdx.includes(i)))).toBe(true);
    const r0 = analyzeSimulation(sc, 5, 200);
    expect(r0.thetaD).toBe(0);
    expect(Object.keys(r0.methods).sort()).toEqual(['alertsOnly7', 'fixedPop7', 'full1', 'full14', 'full7', 'sameSet7']);
    expect(r0.ci.percentile).toEqual({ lo: r0.methods.full7.A.lo, hi: r0.methods.full7.A.hi });
    const r1 = analyzeSimulation({ ...sc, delta: 0.3 }, 5, 200);
    expect(r1.thetaD).toBeGreaterThan(0.15);
    expect(r1.thetaD).toBeLessThan(0.3);
    const agg = aggregateScenario('x', sc, [r0, { ...r0, pointA: r0.pointA + 0.1 }]);
    expect(agg.sims).toBe(2);
    expect(agg.methods.full7.n).toBe(2);
    expect(agg.ciErrors.percentile.hiBelowInfo.n).toBe(2);
    const p = proportion(95, 100);
    expect(p.p).toBe(0.95);
    expect(p.lo).toBeCloseTo(0.8882, 3);
    expect(p.hi).toBeCloseTo(0.9785, 3);
  });
});

describe('AL-MOM-01: pengaman skrip riset lama', () => {
  it('UNIT-MOM01-015 --to > 2026-11-16 ditolak di skrip mom-* & matched-exclusion; skrip terkunci docs/25 tidak diubah', async () => {
    const { AL_MOM_01_WINDOW_START, assertBeforeMomWindow } = await import('../../../scripts/research-window-guard.js');
    expect(AL_MOM_01_WINDOW_START).toBe(R.AL_MOM_01.windowStart);
    expect(() => assertBeforeMomWindow(Date.UTC(2026, 10, 16))).not.toThrow();
    expect(() => assertBeforeMomWindow(Date.UTC(2026, 10, 16) + 1)).toThrow(/docs\/28 §8/);
    for (const f of ['research-mom-power.js', 'research-mom-overlap.js', 'research-mom-sim.js', 'research-matched-exclusion.js']) {
      const src = await readFile(new URL(`../../../scripts/${f}`, import.meta.url), 'utf8');
      expect(src).toMatch(/const to = day\(v\.to, 'to'\);\n\s+assertBeforeMomWindow\(to\);/);
    }
    const { createHash } = await import('node:crypto');
    const sha = async (f) => createHash('sha256').update(await readFile(new URL(`../../../scripts/${f}`, import.meta.url))).digest('hex');
    expect(await sha('research-matched.js')).toBe('ba625aab1c927a0ca594c12f259bf9b6019e6173f452585b41559a1e79ccd768');
    expect(await sha('research-timing.js')).toBe('7a16f7f27cda6ce46326f7b4c8b6874b8dfcf83a4446e5d975f7a75a99008a58');
  });
});
