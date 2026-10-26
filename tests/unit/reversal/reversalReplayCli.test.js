// CLI replay Reversal Radar (scripts/reversal-replay.js & scripts/lib/reversalReplayArgs.js): parsing argumen, peringatan
// benih penyetelan, dan jalur ujung ke ujung offline dengan mesin PALSU (tests/helpers/fakeReversalEngine.js).
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifySeeds, parseReversalReplayArgs, parseSeeds } from '../../../scripts/lib/reversalReplayArgs.js';
import { main, realJobs, requiredTimeframes, syntheticJobs } from '../../../scripts/reversal-replay.js';
import { SCENARIO_IDS } from '../../fixtures/candles/reversalScenarios.js';
import * as scenarios from '../../fixtures/candles/reversalScenarios.js';
import { fakeEngine } from '../../helpers/fakeReversalEngine.js';

const NOW = Date.UTC(2026, 9, 26);
const engineModule = { evaluateReversal: fakeEngine.evaluate, transitionReversal: fakeEngine.transition, resolveReversalParams: fakeEngine.resolveParams, requiredCandles: fakeEngine.requiredCandles };

describe('parseReversalReplayArgs', () => {
  it('UNIT-RRV-050 nilai bawaan sintetis & semua opsi', () => {
    const a = parseReversalReplayArgs(['--synthetic'], { now: NOW });
    expect(a).toMatchObject({
      help: false, source: 'synthetic', seedSet: 'evaluation', scenarios: [...SCENARIO_IDS], tuning: false, symbols: null, top: null,
      timeframes: ['5m', '15m', '1h'], horizonBars: 48, targetAtr: 2, old: 'fast', checkLookahead: false, lookaheadSamples: 4, lookaheadSeries: 1,
      out: 'reports', cacheDir: 'data/backtest-cache', warnings: [],
    });
    expect(a.seeds).toEqual(Array.from({ length: 40 }, (_, i) => 21 + i));
    const b = parseReversalReplayArgs(['--synthetic', '--seeds', '1-3,7', '--scenarios', 'successfulReversal,suddenPump', '--timeframes', '15m', '--horizon', '24',
      '--target-atr', '1.5', '--old', 'full', '--check-lookahead', '--lookahead-samples', '2', '--lookahead-series', '3', '--out', 'out/', '--tuning'], { now: NOW });
    expect(b).toMatchObject({ seeds: [1, 2, 3, 7], seedSet: 'tuning', scenarios: ['successfulReversal', 'suddenPump'], timeframes: ['15m'], horizonBars: 24, targetAtr: 1.5, old: 'full',
      checkLookahead: true, lookaheadSamples: 2, lookaheadSeries: 3, out: 'out/', tuning: true, warnings: [] });
    const c = parseReversalReplayArgs(['--top', '20', '--timeframes', '15m,1h', '--from', '2025-06-01', '--to', '2025-10-01', '--no-cache', '--min-quote-volume', '5000000'], { now: NOW });
    expect(c).toMatchObject({ source: 'binance', top: 20, symbols: null, from: Date.UTC(2025, 5, 1), to: Date.UTC(2025, 9, 1), cacheDir: null, minQuoteVolume24h: 5_000_000, timeframes: ['15m', '1h'] });
    expect(parseReversalReplayArgs(['--symbols', 'btcusdt,ETHUSDT,BTCUSDT'], { now: NOW })).toMatchObject({ source: 'binance', symbols: ['BTCUSDT', 'ETHUSDT'], to: NOW });
    expect(parseReversalReplayArgs(['-h'])).toMatchObject({ help: true });
  });

  it('UNIT-RRV-051 peringatan benih penyetelan & klasifikasi set benih', () => {
    expect(parseSeeds('21-60')).toHaveLength(40);
    expect(parseSeeds('3,1,2,2')).toEqual([1, 2, 3]);
    expect(parseSeeds('1-2,9')).toEqual([1, 2, 9]);
    expect(() => parseSeeds('a-b')).toThrow(RangeError);
    expect(() => parseSeeds('9-1')).toThrow(RangeError);
    expect(() => parseSeeds('1-1000')).toThrow(RangeError);
    expect(() => parseSeeds('')).toThrow(RangeError);
    expect(classifySeeds([1, 20])).toBe('tuning');
    expect(classifySeeds([21, 60])).toBe('evaluation');
    expect(classifySeeds([5, 30])).toBe('mixed');
    expect(classifySeeds([70, 80])).toBe('custom');
    expect(classifySeeds([5, 70])).toBe('mixed');
    const tuning = parseReversalReplayArgs(['--synthetic', '--seeds', '1-20'], { now: NOW });
    expect(tuning.seedSet).toBe('tuning');
    expect(tuning.warnings).toHaveLength(1);
    expect(tuning.warnings[0]).toMatch(/SET PENYETELAN/);
    const mixed = parseReversalReplayArgs(['--synthetic', '--seeds', '10-30'], { now: NOW });
    expect(mixed.seedSet).toBe('mixed');
    expect(mixed.warnings).toHaveLength(1);
    expect(parseReversalReplayArgs(['--synthetic', '--seeds', '1-20', '--tuning'], { now: NOW }).warnings).toEqual([]);
  });

  it('UNIT-RRV-052 argumen tidak valid ditolak dengan pesan jelas', () => {
    const bad = [
      [[], /Pilih sumber data/],
      [['--synthetic', '--top', '5'], /Pilih satu sumber/],
      [['--symbols', 'BTCUSDT', '--top', '5'], /tidak boleh dipakai bersamaan/],
      [['--symbols', '../x'], /Simbol tidak valid/],
      [['--synthetic', '--timeframes', '4h'], /Timeframe tidak didukung/],
      [['--synthetic', '--scenarios', 'tidakAda'], /Skenario tidak dikenal/],
      [['--synthetic', '--seeds', 'x'], /--seeds/],
      [['--synthetic', '--horizon', '0'], /--horizon/],
      [['--synthetic', '--target-atr', 'dua'], /--target-atr/],
      [['--synthetic', '--old', 'turbo'], /--old/],
      [['--top', '20', '--from', '2025-10-01', '--to', '2025-06-01'], /--from harus sebelum --to/],
      [['--top', '0'], /--top/],
      [['--synthetic', '--out', ' '], /--out kosong/],
      [['--synthetic', '--bogus'], /Argumen tidak valid/],
      [['posisional'], /Argumen tidak valid/],
    ];
    for (const [argv, re] of bad) expect(() => parseReversalReplayArgs(argv, { now: NOW }), argv.join(' ')).toThrow(re);
  });
});

describe('helper pekerjaan replay', () => {
  it('UNIT-RRV-053 requiredTimeframes, syntheticJobs per timeframe dasar, realJobs dengan HTF nyata', () => {
    expect(requiredTimeframes(['5m'])).toEqual(['5m', '15m', '1h']);
    expect(requiredTimeframes(['1h'])).toEqual(['1h']);
    const jobs = syntheticJobs(scenarios, { seeds: [21], timeframes: ['15m', '1h'], scenarios: ['successfulReversal', 'uptrendContinuation'] });
    expect(jobs.map((j) => `${j.scenario}-${j.seed}@${j.timeframe}`)).toEqual([
      'successfulReversal-21@15m', 'uptrendContinuation-21@15m', 'successfulReversal-21@1h', 'uptrendContinuation-21@1h',
    ]);
    expect(Object.keys(jobs[0].higher)).toEqual(['1h']);
    expect(jobs[2].higher).toEqual({});
    expect(jobs[0].candles[0].timeframe).toBe('15m');
    expect(jobs[0].phases.map((p) => p.name)).toEqual(expect.arrayContaining(['decline', 'base', 'breakout']));
    expect(jobs[0].landmarks).toMatchObject({ bottomIndex: expect.any(Number), breakoutIndex: expect.any(Number) });
    expect(jobs[0].candles).toEqual(scenarios.scenarioUniverse({ seeds: [21], timeframe: '15m', scenarios: ['successfulReversal'] })['successfulReversal-21']['15m']);
    const c = (tf) => [{ openTime: 0, timeframe: tf }];
    const real = realJobs({ BTCUSDT: { '5m': c('5m'), '15m': c('15m'), '1h': c('1h') }, ETHUSDT: { '15m': c('15m') } }, ['5m', '15m']);
    expect(real.map((j) => `${j.symbol}@${j.timeframe}`)).toEqual(['BTCUSDT@5m', 'BTCUSDT@15m', 'ETHUSDT@15m']);
    expect(Object.keys(real[0].higher)).toEqual(['15m', '1h']);
    expect(real[2].higher).toEqual({});
    expect(real[0]).toMatchObject({ scenario: null, seed: null });
  });
});

describe('main (ujung ke ujung offline dengan mesin palsu)', () => {
  let dir;
  let stdout;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rr-cli-'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  it('UNIT-RRV-054 replay sintetis → laporan .md/.json, ringkasan stdout, uji anti-look-ahead lolos', async () => {
    const out = join(dir, 'reports');
    const code = await main(['--synthetic', '--seeds', '21-22', '--scenarios', 'successfulReversal,uptrendContinuation', '--timeframes', '15m',
      '--check-lookahead', '--lookahead-samples', '2', '--out', out], { loadEngine: async () => engineModule, now: () => NOW });
    expect(code).toBe(0);
    const files = (await readdir(out)).sort();
    expect(files).toEqual(['reversal-replay-20261026T000000Z.json', 'reversal-replay-20261026T000000Z.md']);
    const md = await readFile(join(out, files[1]), 'utf8');
    expect(md).toContain('# Laporan Replay Reversal Radar');
    expect(md).toContain('Data sintetis ≠ pasar nyata');
    expect(md).toContain('## Uji anti-look-ahead');
    expect(md).toContain('gagal: 0');
    expect(md).toContain('| 15m | Kelanjutan uptrend | HIGH | 2 | 0 |');
    const json = JSON.parse(await readFile(join(out, files[0]), 'utf8'));
    expect(json.meta).toMatchObject({ source: 'synthetic', seedSet: 'evaluation', seeds: [21, 22], timeframes: ['15m'], horizonBars: 48, oldMode: 'fast' });
    expect(json.totals.series).toBe(4);
    expect(json.lookahead).toMatchObject({ checked: 2, failures: [] });
    expect(json.targets.find((t) => t.id === 'UPTREND_ZERO')).toMatchObject({ status: 'TERPENUHI' });
    const printed = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('Replay Reversal Radar — 4 seri');
    expect(printed).toContain('[§10]');
  });

  it('UNIT-RRV-055 mesin belum tersedia → kode 3 tanpa laporan; stub yang melempar → kode 3; argumen salah → 2; bantuan → 0', async () => {
    const out = join(dir, 'r');
    expect(await main(['--synthetic', '--out', out], { loadEngine: async () => null })).toBe(3);
    await expect(readdir(out)).rejects.toThrow();
    const stub = { evaluateReversal: () => { throw new Error('evaluateReversal belum tersedia (stub)'); }, transitionReversal: () => { throw new Error('stub'); }, resolveReversalParams: (p) => p };
    expect(await main(['--synthetic', '--seeds', '21', '--timeframes', '15m', '--scenarios', 'successfulReversal', '--out', out], { loadEngine: async () => stub })).toBe(3);
    await expect(readdir(out)).rejects.toThrow();
    expect(await main(['--bogus'])).toBe(2);
    expect(await main(['--help'])).toBe(0);
    expect(stdout.mock.calls.map((c) => String(c[0])).join('')).toContain('Pemakaian: npm run reversal:replay');
  });

  it('UNIT-RRV-056 uji anti-look-ahead gagal → kode 4 dan laporan menandai kegagalan; --old off mematikan pembanding', async () => {
    const memory = new Map();
    const cheat = (args) => {
      for (const c of args.candles) memory.set(c.openTime, c.close);
      const ev = fakeEngine.evaluate(args);
      const future = memory.get(args.candles.at(-1).openTime + 900_000);
      if (future !== undefined) ev.score = { ...ev.score, total: future > args.candles.at(-1).close ? 99 : 1 };
      return ev;
    };
    const out = join(dir, 'reports');
    const code = await main(['--synthetic', '--seeds', '21', '--scenarios', 'successfulReversal', '--timeframes', '15m', '--check-lookahead', '--old', 'off', '--out', out],
      { loadEngine: async () => ({ ...engineModule, evaluateReversal: cheat }), now: () => NOW });
    expect(code).toBe(4);
    const md = await readFile(join(out, 'reversal-replay-20261026T000000Z.md'), 'utf8');
    expect(md).toContain('Uji anti-look-ahead GAGAL');
    expect(md).toContain('❌ successfulReversal-21 15m');
    expect(md).toContain('Pembanding mesin lama dimatikan');
    const json = JSON.parse(await readFile(join(out, 'reversal-replay-20261026T000000Z.json'), 'utf8'));
    expect(json.meta.oldMode).toBe('off');
    expect(json.lookahead.failures).toHaveLength(1);
  });
});
