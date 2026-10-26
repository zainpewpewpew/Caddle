import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBacktestArgs } from '../../../scripts/lib/backtestArgs.js';
import { main, normalizeUniverse, requiredTimeframes } from '../../../scripts/backtest.js';

const NOW = Date.UTC(2026, 9, 26);

describe('parseBacktestArgs', () => {
  it('UNIT-BTCLI-001 nilai bawaan', () => {
    const a = parseBacktestArgs(['--symbols', 'btcusdt,ETHUSDT,BTCUSDT'], { now: NOW });
    expect(a).toMatchObject({
      help: false, source: 'binance', symbols: ['BTCUSDT', 'ETHUSDT'], top: null, csv: null, timeframes: ['15m', '1h'],
      from: Date.UTC(2024, 0, 1), to: NOW, rangeExplicit: false, targetR: 2, maxBars: 48, folds: 5, embargoBars: 48,
      cacheDir: 'data/backtest-cache', out: 'reports', writeCalibration: null, ml: false, entry: 'nextOpen', maxCostR: 0.15, calibrationMethod: 'platt',
    });
  });

  it('UNIT-BTCLI-002 semua opsi', () => {
    const a = parseBacktestArgs(['--top', '30', '--timeframes', '5m,1h', '--from', '2024-01-01', '--to', '2025-10-01', '--target-r', '1.5',
      '--max-bars', '24', '--folds', '4', '--embargo', '10', '--out', 'out/', '--write-calibration', 'config/calibration.json', '--no-cache',
      '--min-quote-volume', '50000000'], { now: NOW });
    expect(a).toMatchObject({
      source: 'binance', top: 30, symbols: null, timeframes: ['5m', '1h'], from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 9, 1), rangeExplicit: true,
      targetR: 1.5, maxBars: 24, folds: 4, embargoBars: 10, out: 'out/', writeCalibration: 'config/calibration.json', cacheDir: null,
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
      [['--top', '0'], /--top/],
      [['--synthetic', '--bogus'], /Argumen tidak valid/],
      [['posisional'], /Argumen tidak valid/],
    ];
    for (const [argv, re] of bad) expect(() => parseBacktestArgs(argv, { now: NOW }), argv.join(' ')).toThrow(re);
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
    expect(arg).toMatchObject({ timeframes: ['1h'], targetR: 2, maxBars: 48, source: 'csv' });
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

  it('UNIT-BTCLI-021 runner belum ada → kode 3 tanpa menulis apa pun; argumen salah → kode 2', async () => {
    expect(await main(['--synthetic', '--out', join(dir, 'r')], { loadRunner: async () => null })).toBe(3);
    await expect(readdir(join(dir, 'r'))).rejects.toThrow();
    expect(await main(['--bogus'])).toBe(2);
  });
});
