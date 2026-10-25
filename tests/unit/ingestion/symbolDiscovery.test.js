import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBookTickers, parseExchangeInfo, parseTickers24h } from '../../../backend/ingestion/binance/parse.js';
import { REJECT_REASONS, discoverSymbols } from '../../../backend/ingestion/symbolDiscovery.js';
import { DEFAULT_SCANNER_SETTINGS } from '../../../backend/settings/scannerSettings.js';

// Fixture sintetis — bukan data pasar nyata.
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/binance/${name}`, import.meta.url), 'utf8'));
const load = () => ({
  symbols: parseExchangeInfo(fixture('exchangeInfo.json').body),
  tickers: parseTickers24h(fixture('ticker24hr.json').body),
  bookTickers: parseBookTickers(fixture('bookTicker.json').body),
});

const settings = ({ symbols = {}, liquidity = {} } = {}) => ({
  ...DEFAULT_SCANNER_SETTINGS,
  symbols: { ...DEFAULT_SCANNER_SETTINGS.symbols, ...symbols },
  liquidity: { ...DEFAULT_SCANNER_SETTINGS.liquidity, ...liquidity },
});

const info = (symbol, over = {}) => ({
  symbol, baseAsset: symbol.replace(/USDT$/, ''), quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
  tickSize: '0.01', stepSize: '0.1', onboardDate: 1, ...over,
});
const ticker = (symbol, quoteVolume) => ({ symbol, lastPrice: 1, priceChangePercent: 0, volume: 1, quoteVolume, closeTime: 1 });
const book = (symbol, spreadBps = 1) => ({ symbol, bidPrice: 1, askPrice: 1, spreadBps });
const reasonOf = (result, symbol) => result.rejected.find((r) => r.symbol === symbol)?.reason;

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('discovery simbol', () => {
  it('UNIT-DSC-001 mode auto: filter PERPETUAL+USDT+TRADING, likuiditas, urut quote volume menurun', () => {
    const result = discoverSymbols({ ...load(), settings: settings() });
    expect(result.selected.map((s) => s.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'TINYUSDT']);
    expect(result.selected[0]).toEqual({ symbol: 'BTCUSDT', quoteVolume24h: 15_000_000_000, spreadBps: expect.closeTo((0.1 / 94000.05) * 10_000, 9) });
    expect(result.rejected).toEqual([
      { symbol: 'BTCUSDC', reason: 'NOT_USDT' },
      { symbol: 'BTCUSDT_261225', reason: 'NOT_PERPETUAL' },
      { symbol: 'HALTUSDT', reason: 'NOT_TRADING' },
      { symbol: 'LOWVOLUSDT', reason: 'LOW_VOLUME' },
      { symbol: 'NOTICKUSDT', reason: 'NO_TICKER' },
      { symbol: 'OLDUSDT', reason: 'NOT_TRADING' },
      { symbol: 'WIDEUSDT', reason: 'WIDE_SPREAD' },
    ]);
  });

  it('UNIT-DSC-002 setiap simbol masuk tepat satu kali ke selected atau rejected', () => {
    const input = load();
    const result = discoverSymbols({ ...input, settings: settings({ symbols: { maxAuto: 2 } }) });
    const all = [...result.selected.map((s) => s.symbol), ...result.rejected.map((r) => r.symbol)];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(input.symbols.map((s) => s.symbol).sort());
    for (const r of result.rejected) expect(Object.values(REJECT_REASONS)).toContain(r.reason);
  });

  it('UNIT-DSC-003 maxAuto memotong peringkat; sisanya ditolak MAX_AUTO_LIMIT', () => {
    const result = discoverSymbols({ ...load(), settings: settings({ symbols: { maxAuto: 2 } }) });
    expect(result.selected.map((s) => s.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(reasonOf(result, '1000PEPEUSDT')).toBe(REJECT_REASONS.MAX_AUTO_LIMIT);
    expect(reasonOf(result, 'TINYUSDT')).toBe(REJECT_REASONS.MAX_AUTO_LIMIT);
  });

  it('EDGE-DSC-001 ambang inklusif: quote volume = minimum lolos, spread = maksimum lolos', () => {
    const symbols = [info('AAUSDT'), info('BBUSDT'), info('CCUSDT'), info('DDUSDT')];
    const tickers = [ticker('AAUSDT', 50_000_000), ticker('BBUSDT', 49_999_999.99), ticker('CCUSDT', 60_000_000), ticker('DDUSDT', 70_000_000)];
    const bookTickers = [book('AAUSDT', 10), book('BBUSDT', 1), book('CCUSDT', 10.000001), book('DDUSDT', 0)];
    const result = discoverSymbols({ symbols, tickers, bookTickers, settings: settings() });
    expect(result.selected.map((s) => s.symbol)).toEqual(['DDUSDT', 'AAUSDT']);
    expect(reasonOf(result, 'BBUSDT')).toBe('LOW_VOLUME');
    expect(reasonOf(result, 'CCUSDT')).toBe('WIDE_SPREAD');
  });

  it('EDGE-DSC-002 quote volume sama → urut simbol (deterministik); hasil identik bila diulang', () => {
    const symbols = [info('ZZUSDT'), info('AAUSDT'), info('MMUSDT')];
    const tickers = symbols.map((s) => ticker(s.symbol, 100_000_000));
    const bookTickers = symbols.map((s) => book(s.symbol));
    const input = deepFreeze({ symbols, tickers, bookTickers, settings: settings() });
    const a = discoverSymbols(input);
    expect(a.selected.map((s) => s.symbol)).toEqual(['AAUSDT', 'MMUSDT', 'ZZUSDT']);
    expect(discoverSymbols(input)).toEqual(a);
  });

  it('UNIT-DSC-004 mode manual: filter TRADING/PERPETUAL/USDT tetap berlaku, tanpa filter likuiditas & tanpa potong maxAuto', () => {
    const manual = ['ETHUSDT', '1000PEPEUSDT', 'LOWVOLUSDT', 'WIDEUSDT', 'OLDUSDT', 'BTCUSDC', 'GHOSTUSDT', 'NOTICKUSDT'];
    const result = discoverSymbols({ ...load(), settings: settings({ symbols: { mode: 'manual', maxAuto: 2, manual } }) });
    expect(result.selected.map((s) => s.symbol)).toEqual(['ETHUSDT', '1000PEPEUSDT', 'WIDEUSDT', 'LOWVOLUSDT', 'NOTICKUSDT']);
    expect(result.selected.find((s) => s.symbol === 'NOTICKUSDT')).toEqual({ symbol: 'NOTICKUSDT', quoteVolume24h: null, spreadBps: null });
    expect(reasonOf(result, 'OLDUSDT')).toBe('NOT_TRADING');
    expect(reasonOf(result, 'BTCUSDC')).toBe('NOT_USDT');
    expect(reasonOf(result, 'GHOSTUSDT')).toBe('INVALID_SYMBOL');
    for (const s of ['BTCUSDT', 'TINYUSDT', 'HALTUSDT', 'BTCUSDT_261225']) expect(reasonOf(result, s)).toBe('NOT_IN_MANUAL_LIST');
  });

  it('NEG-DSC-001 delisting/penghentian (SETTLING, BREAK, CLOSE, PENDING_TRADING) → NOT_TRADING meski volume tinggi', () => {
    const statuses = ['SETTLING', 'BREAK', 'CLOSE', 'PENDING_TRADING', 'PRE_SETTLE', 'DELIVERING'];
    const symbols = statuses.map((status, i) => info(`S${i}XUSDT`, { status }));
    const tickers = symbols.map((s) => ticker(s.symbol, 9e9));
    const bookTickers = symbols.map((s) => book(s.symbol));
    for (const mode of ['auto', 'manual']) {
      const result = discoverSymbols({ symbols, tickers, bookTickers, settings: settings({ symbols: { mode, manual: symbols.map((s) => s.symbol) } }) });
      expect(result.selected).toEqual([]);
      expect(result.rejected.every((r) => r.reason === 'NOT_TRADING')).toBe(true);
    }
  });

  it('EDGE-DSC-003 1000PEPEUSDT & basis 1 huruf valid; nama tak wajar atau tickSize/stepSize hilang → INVALID_SYMBOL', () => {
    const symbols = [
      info('1000PEPEUSDT'), info('WUSDT'), info('abcUSDT'), info('币安人生USDT'), info('BTC-USDT'), info(`${'A'.repeat(21)}USDT`),
      info('NOTICKSZUSDT', { tickSize: null }), info('NOSTEPUSDT', { stepSize: null }), info('USDT'),
    ];
    const tickers = symbols.map((s) => ticker(s.symbol, 1e9));
    const bookTickers = symbols.map((s) => book(s.symbol));
    const result = discoverSymbols({ symbols, tickers, bookTickers, settings: settings() });
    expect(result.selected.map((s) => s.symbol)).toEqual(['1000PEPEUSDT', 'WUSDT']);
    for (const s of symbols.slice(2)) expect(reasonOf(result, s.symbol)).toBe('INVALID_SYMBOL');
  });

  it('NEG-DSC-002 ticker/book ticker hilang, kuotasi kosong, atau quote volume tidak finite → NO_TICKER (mode auto)', () => {
    const symbols = [info('AAUSDT'), info('BBUSDT'), info('CCUSDT'), info('DDUSDT')];
    const tickers = [ticker('AAUSDT', 1e9), ticker('CCUSDT', 1e9), ticker('DDUSDT', Number.NaN)];
    const bookTickers = [book('AAUSDT', null), book('BBUSDT'), book('CCUSDT', 1), book('DDUSDT', 1)];
    const result = discoverSymbols({ symbols, tickers, bookTickers, settings: settings() });
    expect(result.selected.map((s) => s.symbol)).toEqual(['CCUSDT']);
    for (const s of ['AAUSDT', 'BBUSDT', 'DDUSDT']) expect(reasonOf(result, s)).toBe('NO_TICKER');
  });

  it('EDGE-DSC-004 prioritas alasan: kontrak → quote → status → format → ticker → volume → spread', () => {
    const symbols = [
      info('AAUSDT', { contractType: 'NEXT_QUARTER', quoteAsset: 'USDC', status: 'SETTLING' }),
      info('BBUSDT', { quoteAsset: 'USDC', status: 'SETTLING' }),
      info('CCUSDT', { status: 'SETTLING', tickSize: null }),
      info('DDUSDT', { tickSize: null }),
      info('EEUSDT'),
    ];
    const tickers = [ticker('EEUSDT', 1)];
    const result = discoverSymbols({ symbols, tickers, bookTickers: [book('EEUSDT', 999)], settings: settings() });
    expect(result.rejected).toEqual([
      { symbol: 'AAUSDT', reason: 'NOT_PERPETUAL' },
      { symbol: 'BBUSDT', reason: 'NOT_USDT' },
      { symbol: 'CCUSDT', reason: 'NOT_TRADING' },
      { symbol: 'DDUSDT', reason: 'INVALID_SYMBOL' },
      { symbol: 'EEUSDT', reason: 'LOW_VOLUME' },
    ]);
  });

  it('EDGE-DSC-005 entri duplikat: yang pertama dipakai, tidak dihitung dua kali', () => {
    const symbols = [info('AAUSDT'), info('AAUSDT', { status: 'SETTLING' })];
    const tickers = [ticker('AAUSDT', 1e9), ticker('AAUSDT', 1)];
    const bookTickers = [book('AAUSDT', 1), book('AAUSDT', 500)];
    const result = discoverSymbols({ symbols, tickers, bookTickers, settings: settings() });
    expect(result).toEqual({ selected: [{ symbol: 'AAUSDT', quoteVolume24h: 1e9, spreadBps: 1 }], rejected: [] });
  });

  it('NEG-DSC-003 input atau pengaturan tidak valid → TypeError', () => {
    const base = { symbols: [], tickers: [], bookTickers: [], settings: settings() };
    expect(() => discoverSymbols({ ...base, symbols: null })).toThrow(TypeError);
    expect(() => discoverSymbols({ ...base, tickers: {} })).toThrow(TypeError);
    expect(() => discoverSymbols({ ...base, bookTickers: 'x' })).toThrow(TypeError);
    expect(() => discoverSymbols({ ...base, settings: undefined })).toThrow(TypeError);
    expect(() => discoverSymbols({ ...base, settings: settings({ symbols: { mode: 'semua' } }) })).toThrow(TypeError);
    expect(() => discoverSymbols({ ...base, settings: settings({ symbols: { maxAuto: 0 } }) })).toThrow(TypeError);
    expect(() => discoverSymbols({ ...base, settings: settings({ liquidity: { minQuoteVolume24h: -1 } }) })).toThrow(TypeError);
    expect(() => discoverSymbols({ ...base, settings: settings({ liquidity: { maxSpreadBps: Number.NaN } }) })).toThrow(TypeError);
    expect(() => discoverSymbols({ ...base, settings: settings({ symbols: { mode: 'manual', manual: 'BTCUSDT' } }) })).toThrow(TypeError);
    expect(() => discoverSymbols()).toThrow(TypeError);
  });

  it('EDGE-DSC-006 daftar kosong → hasil kosong; entri bukan objek → INVALID_SYMBOL', () => {
    expect(discoverSymbols({ symbols: [], tickers: [], bookTickers: [], settings: settings() })).toEqual({ selected: [], rejected: [] });
    const result = discoverSymbols({ symbols: [null, { symbol: 7 }], tickers: [], bookTickers: [], settings: settings() });
    expect(result.rejected.map((r) => r.reason)).toEqual(['INVALID_SYMBOL', 'INVALID_SYMBOL']);
  });
});
