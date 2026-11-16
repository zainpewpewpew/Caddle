import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBacktestArgs } from '../../../scripts/lib/backtestArgs.js';
import { PROTECTED_FROM, UNLOCK_PHRASE, assertNoProtectedCandles, confirmUnlock } from '../../../scripts/lib/protectedPeriod.js';
import { main, normalizeUniverse, requiredTimeframes } from '../../../scripts/backtest.js';

const NOW = Date.UTC(2026, 9, 26);

describe('parseBacktestArgs', () => {
  it('UNIT-BTCLI-001 nilai bawaan', () => {
    const a = parseBacktestArgs(['--symbols', 'btcusdt,ETHUSDT,BTCUSDT'], { now: NOW });
    expect(a).toMatchObject({
      help: false, source: 'binance', symbols: ['BTCUSDT', 'ETHUSDT'], top: null, csv: null, timeframes: ['15m', '1h'],
      from: Date.UTC(2024, 0, 1), to: NOW, rangeExplicit: false, targetR: 2, maxBars: 48, feeBps: 5, slippageBps: 2, folds: 5, embargoBars: 48,
      cacheDir: 'data/backtest-cache', out: 'reports', writeCalibration: null, ml: false, entry: 'nextOpen', maxCostR: 0.15, calibrationMethod: 'platt',
    });
  });

  it('UNIT-BTCLI-002 semua opsi', () => {
    const a = parseBacktestArgs(['--top', '30', '--timeframes', '5m,1h', '--from', '2024-01-01', '--to', '2025-10-01', '--target-r', '1.5',
      '--max-bars', '24', '--folds', '4', '--embargo', '10', '--out', 'out/', '--write-calibration', 'config/calibration.json', '--no-cache',
      '--min-quote-volume', '50000000', '--fee-bps', '4', '--slippage-bps', '3.5'], { now: NOW });
    expect(a).toMatchObject({
      source: 'binance', top: 30, symbols: null, timeframes: ['5m', '1h'], from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 9, 1), rangeExplicit: true,
      targetR: 1.5, maxBars: 24, feeBps: 4, slippageBps: 3.5, folds: 4, embargoBars: 10, out: 'out/', writeCalibration: 'config/calibration.json', cacheDir: null,
      minQuoteVolume24h: 50_000_000,
    });
    expect(parseBacktestArgs(['--synthetic', '--seed', '7'], { now: NOW })).toMatchObject({ source: 'synthetic', seed: 7 });
    expect(parseBacktestArgs(['--csv', 'a.csv,dir/'], { now: NOW })).toMatchObject({ source: 'csv', csv: ['a.csv', 'dir/'] });
    expect(parseBacktestArgs(['-h'])).toMatchObject({ help: true });
    expect(parseBacktestArgs(['--synthetic', '--entry', 'close', '--max-cost-r', '0.3', '--calibration-method', 'isotonic'], { now: NOW }))
      .toMatchObject({ entry: 'close', maxCostR: 0.3, calibrationMethod: 'isotonic' });
    expect(() => parseBacktestArgs(['--synthetic', '--entry', 'besok'], { now: NOW })).toThrow(TypeError);
    expect(() => parseBacktestArgs(['--synthetic', '--calibration-method', 'magic'], { now: NOW })).toThrow(TypeError);
    expect(() => parseBacktestArgs(['--synthetic', '--max-cost-r', '0'], { now: NOW })).toThrow(RangeError);
  });

  it('UNIT-BTCLI-003 argumen tidak valid ditolak dengan pesan jelas', () => {
    const bad = [
      [[], /butuh --symbols atau --top/],
      [['--symbols', 'BTCUSDT', '--top', '5'], /tidak boleh dipakai bersamaan/],
      [['--symbols', 'BTCUSDT', '--synthetic'], /Pilih satu sumber/],
      [['--symbols', '../x'], /Simbol tidak valid/],
      [['--synthetic', '--timeframes', '4h'], /Timeframe tidak didukung/],
      [['--synthetic', '--from', '2025-01-01', '--to', '2024-01-01'], /--from harus sebelum --to/],
      [['--synthetic', '--from', 'kemarin'], /bukan tanggal valid/],
      [['--synthetic', '--target-r', 'dua'], /--target-r/],
      [['--synthetic', '--max-bars', '1.5'], /--max-bars/],
      [['--synthetic', '--fee-bps', '-1'], /--fee-bps/],
      [['--synthetic', '--slippage-bps', 'banyak'], /--slippage-bps/],
      [['--top', '0'], /--top/],
      [['--synthetic', '--bogus'], /Argumen tidak valid/],
      [['posisional'], /Argumen tidak valid/],
    ];
    for (const [argv, re] of bad) expect(() => parseBacktestArgs(argv, { now: NOW }), argv.join(' ')).toThrow(re);
  });

  it('UNIT-BTCLI-004 periode terlindungi 1h (docs/29 §19): --to bawaan dipotong, --to/--from sesudahnya ditolak tanpa flag', () => {
    const later = Date.UTC(2026, 11, 1);
    expect(PROTECTED_FROM).toBe(Date.UTC(2026, 10, 16));
    // Bawaan --to = sekarang → dipotong ke awal periode bila 1h ikut dijalankan.
    expect(parseBacktestArgs(['--symbols', 'BTCUSDT'], { now: later })).toMatchObject({
      to: PROTECTED_FROM, protectedPeriod: { applies: true, clipped: true, cutoff: PROTECTED_FROM, unlocked: false },
    });
    // Tanpa 1h, atau data sintetis: tidak berlaku.
    expect(parseBacktestArgs(['--symbols', 'BTCUSDT', '--timeframes', '15m'], { now: later })).toMatchObject({ to: later, protectedPeriod: { applies: false, cutoff: null } });
    expect(parseBacktestArgs(['--synthetic'], { now: later })).toMatchObject({ to: later, protectedPeriod: { applies: false } });
    // --to tepat di batas boleh; sesudahnya ditolak; --from di dalam periode ditolak.
    expect(parseBacktestArgs(['--symbols', 'BTCUSDT', '--to', '2026-11-16'], { now: later })).toMatchObject({ to: PROTECTED_FROM, protectedPeriod: { clipped: false } });
    expect(() => parseBacktestArgs(['--symbols', 'BTCUSDT', '--to', '2026-12-01'], { now: later })).toThrow(/melewati 2026-11-16/);
    expect(() => parseBacktestArgs(['--top', '5', '--timeframes', '1h', '--from', '2026-11-20', '--to', '2026-11-30'], { now: later })).toThrow(/periode terlindungi/);
    expect(() => parseBacktestArgs(['--csv', 'x.csv', '--to', '2026-11-17'], { now: later })).toThrow(/melewati 2026-11-16/);
    // CSV tanpa --to: rentang tidak menyaring, tetapi cutoff periode terlindungi tetap dipaksakan saat memuat.
    expect(parseBacktestArgs(['--csv', 'x.csv'], { now: later })).toMatchObject({ rangeExplicit: false, protectedPeriod: { applies: true, cutoff: PROTECTED_FROM } });
    // Flag buka: rentang apa adanya, cutoff tidak ada, konfirmasi diminta di main.
    expect(parseBacktestArgs(['--symbols', 'BTCUSDT', '--to', '2026-12-01', '--buka-periode-terlindungi'], { now: later })).toMatchObject({
      to: Date.UTC(2026, 11, 1), protectedPeriod: { applies: true, unlocked: true, cutoff: null, clipped: false },
    });
    // Sebelum periode dimulai, bawaan tidak berubah.
    expect(parseBacktestArgs(['--symbols', 'BTCUSDT'], { now: NOW })).toMatchObject({ to: NOW, protectedPeriod: { clipped: false } });
  });
});

describe('periode terlindungi: konfirmasi & pertahanan lapis kedua', () => {
  it('UNIT-BTCLI-005 confirmUnlock hanya di TTY interaktif di luar CI, dengan frasa persis', async () => {
    const quiet = () => ({ isTTY: true, write: vi.fn() });
    expect(await confirmUnlock({ input: { isTTY: false }, output: quiet(), env: {} })).toBe(false);
    expect(await confirmUnlock({ input: { isTTY: true }, output: { isTTY: false, write: vi.fn() }, env: {} })).toBe(false);
    expect(await confirmUnlock({ input: { isTTY: true }, output: quiet(), env: { CI: 'true' } })).toBe(false);
    const ask = async (text) => {
      const input = new PassThrough();
      input.isTTY = true;
      const output = new PassThrough();
      output.isTTY = true;
      const pending = confirmUnlock({ input, output, env: {} });
      input.write(`${text}\n`);
      return pending;
    };
    expect(await ask(UNLOCK_PHRASE)).toBe(true);
    expect(await ask('ya')).toBe(false);
  });

  it('UNIT-BTCLI-006 assertNoProtectedCandles menolak candle 1h di periode terlindungi', () => {
    const c = (t) => ({ openTime: t });
    expect(() => assertNoProtectedCandles({ A: { '1h': [c(PROTECTED_FROM - 1)] } }, ['1h'])).not.toThrow();
    expect(() => assertNoProtectedCandles({ A: { '1h': [c(PROTECTED_FROM)] } }, ['1h'])).toThrow(/periode terlindungi/);
    expect(() => assertNoProtectedCandles({ A: { '15m': [c(PROTECTED_FROM)] } }, ['15m'])).not.toThrow();
  });
});

describe('helper CLI', () => {
  it('UNIT-BTCLI-010 requiredTimeframes menambah timeframe konteks', () => {
    expect(requiredTimeframes(['5m'])).toEqual(['5m', '15m', '1h']);
    expect(requiredTimeframes(['15m', '1h'])).toEqual(['15m', '1h']);
  });

  it('UNIT-BTCLI-011 normalizeUniverse menerima peta bersarang atau array', () => {
    const c = [{ openTime: 1 }];
    expect(normalizeUniverse({ AUSDT: { '1h': c } })).toEqual({ AUSDT: { '1h': c } });
    expect(normalizeUniverse([{ symbol: 'AUSDT', timeframe: '1h', candles: c }])).toEqual({ AUSDT: { '1h': c } });
    expect(normalizeUniverse({ candles: [{ symbol: 'AUSDT', timeframe: '1h', candles: c }] })).toEqual({ AUSDT: { '1h': c } });
    expect(() => normalizeUniverse([{ symbol: 'A' }])).toThrow(TypeError);
  });
});

describe('main (end-to-end offline dengan CSV & runner palsu)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bt-cli-')); vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  it('UNIT-BTCLI-020 memuat CSV, memanggil runBacktest, menulis .md/.json dan kalibrasi', async () => {
    const H = 3_600_000;
    const t0 = Date.UTC(2024, 0, 1);
    const rows = Array.from({ length: 5 }, (_, i) => `${t0 + i * H},100,102,99,101,10,${t0 + (i + 1) * H - 1},1000,5,6,600,0`);
    await writeFile(join(dir, 'BTCUSDT-1h-2024-01.csv'), rows.join('\n'), 'utf8');
    const runBacktest = vi.fn(async () => ({
      meta: { candidate: 'v3' },
      calibrationTable: { version: 1, tables: { 'LONG:*': { bins: [] } } },
      variants: { v3: { trainSummary: null, testSummary: { n: 3, winRate: 1, winRateCi: [0.44, 1], expectancyR: 2, profitFactor: Infinity }, calibration: { ece: 0, brier: 0, table: { bins: [] } } } },
    }));
    const out = join(dir, 'reports');
    const cal = join(dir, 'config', 'calibration.json');
    const code = await main(['--csv', dir, '--timeframes', '1h', '--out', out, '--write-calibration', cal], { loadRunner: async () => ({ runBacktest }) });
    expect(code).toBe(0);
    const arg = runBacktest.mock.calls[0][0];
    expect(arg.symbols).toEqual(['BTCUSDT']);
    expect(arg.candles.BTCUSDT['1h']).toHaveLength(5);
    expect(arg).toMatchObject({ timeframes: ['1h'], targetR: 2, maxBars: 48, feeBps: 5, slippageBps: 2, source: 'csv' });
    const files = (await readdir(out)).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^backtest-\d{8}T\d{6}Z\.json$/);
    const md = await readFile(join(out, files[1]), 'utf8');
    expect(md).toContain('# Laporan Backtest AlphaLens');
    expect(md).toContain('sampel terlalu kecil');
    const json = JSON.parse(await readFile(join(out, files[0]), 'utf8'));
    expect(json.variants.v3.testSummary.profitFactor).toBe('Infinity');
    expect(json.meta.source).toBe('csv');
    // Bentuk yang dibaca worker/index.js (loadCalibration): { version: 1, tables: { 'ARAH:TF': tabel } } + metadata.
    expect(JSON.parse(await readFile(cal, 'utf8'))).toMatchObject({ version: 1, tables: { 'LONG:*': { bins: [] } } });
  });

  it('UNIT-BTCLI-022 CSV 1h yang melewati 2026-11-16: candle periode terlindungi dibuang tanpa flag; flag + konfirmasi membukanya', async () => {
    const H = 3_600_000;
    const t0 = PROTECTED_FROM - 3 * H;
    const rows = Array.from({ length: 6 }, (_, i) => `${t0 + i * H},100,102,99,101,10,${t0 + (i + 1) * H - 1},1000,5,6,600,0`);
    await writeFile(join(dir, 'BTCUSDT-1h-2026-11.csv'), rows.join('\n'), 'utf8');
    const result = { meta: {}, variants: { v3: { trainSummary: null, testSummary: null, calibration: null } } };
    const runBacktest = vi.fn(async () => result);
    const confirm = vi.fn(async () => true);
    expect(await main(['--csv', dir, '--timeframes', '1h', '--out', join(dir, 'a')], { loadRunner: async () => ({ runBacktest }), confirm })).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(runBacktest.mock.calls[0][0].candles.BTCUSDT['1h'].map((x) => x.openTime)).toEqual([t0, t0 + H, t0 + 2 * H]);
    const files = (await readdir(join(dir, 'a'))).filter((f) => f.endsWith('.json'));
    expect(JSON.parse(await readFile(join(dir, 'a', files[0]), 'utf8')).meta.protectedPeriod).toMatchObject({ applies: true, unlocked: false });
    // Flag tanpa konfirmasi → kode 2, runner tidak dipanggil.
    const refused = vi.fn(async () => true);
    expect(await main(['--csv', dir, '--timeframes', '1h', '--out', join(dir, 'b'), '--buka-periode-terlindungi'], { loadRunner: async () => ({ runBacktest: refused }), confirm: async () => false })).toBe(2);
    expect(refused).not.toHaveBeenCalled();
    // Flag + konfirmasi → semua candle.
    expect(await main(['--csv', dir, '--timeframes', '1h', '--out', join(dir, 'c'), '--buka-periode-terlindungi'], { loadRunner: async () => ({ runBacktest }), confirm })).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runBacktest.mock.calls[1][0].candles.BTCUSDT['1h']).toHaveLength(6);
  });

  it('UNIT-BTCLI-021 runner belum ada → kode 3 tanpa menulis apa pun; argumen salah → kode 2', async () => {
    expect(await main(['--synthetic', '--out', join(dir, 'r')], { loadRunner: async () => null })).toBe(3);
    await expect(readdir(join(dir, 'r'))).rejects.toThrow();
    expect(await main(['--bogus'])).toBe(2);
  });
});
