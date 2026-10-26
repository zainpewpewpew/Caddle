import { describe, expect, it } from 'vitest';
import { matchToken } from '../../../backend/smartmoney/binanceMatch.js';
import { validateAdapter } from '../../../backend/smartmoney/providers/adapter.js';
import {
  BINANCE_NETWORK_CHAINS, BINANCE_PATHS, PERP_PREFIX_RE, buildBinanceMappingRows, createBinanceMappingProvider,
  createBinancePublicMappingProvider, findExcessPermissions, publicCoinsOf, signQuery,
} from '../../../backend/smartmoney/providers/binanceMapping.js';
import { createProviderRegistry } from '../../../backend/smartmoney/providers/registry.js';
import {
  binanceCoin, binanceNetwork, binanceRestrictions, fakeEvmAddress, futuresSymbol, jsonResponse, spotSymbol,
} from '../../fixtures/smartmoney/liveShapes.js';

// Tanpa jaringan: fetch palsu dengan respons BERBENTUK dokumentasi Binance (belum direkam live — lihat
// tests/fixtures/smartmoney/liveShapes.js). Kunci & secret di bawah FIKTIF.
const NOW = Date.UTC(2026, 9, 26, 12, 0);
const KEY = `KUNCIUJI${'A1b2C3d4'.repeat(7)}`;
const SECRET = `RAHASIAUJI${'Z9y8X7w6'.repeat(7)}`;
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const PEPE_CHECKSUM = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const BABYDOGE_BSC = '0xc748673057861a797275cd8a068abb95a902e8de'; // contoh resmi dok Binance (koin 1MBABYDOGE)
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const A = Object.fromEntries(['pepeBsc', 'pepeAvax', 'satsBsc', 'usdcEth', 'usdcBase', 'pol', 'polEth', 'mog', 'dualA', 'dualB', 'shared']
  .map((k) => [k, fakeEvmAddress(`bn-${k}`)]));

const COINS = [
  binanceCoin('PEPE', [binanceNetwork('ETH', PEPE_CHECKSUM), binanceNetwork('BSC', A.pepeBsc), binanceNetwork('AVAXC', A.pepeAvax)]),
  binanceCoin('1000SATS', [binanceNetwork('BTC', ''), binanceNetwork('BSC', A.satsBsc)]),
  binanceCoin('1MBABYDOGE', [binanceNetwork('BSC', BABYDOGE_BSC, { denomination: 1000000 })], { name: '1M x BABYDOGE' }),
  binanceCoin('USDC', [
    binanceNetwork('ETH', A.usdcEth), binanceNetwork('SOL', USDC_SOL), binanceNetwork('BASE', A.usdcBase),
    binanceNetwork('TRX', 'TFiktifAlamatTron1111111111111111'),
  ]),
  binanceCoin('POL', [binanceNetwork('MATIC', A.pol), binanceNetwork('POLYGON', `0x${A.pol.slice(2).toUpperCase()}`), binanceNetwork('ETH', A.polEth)]),
  binanceCoin('ETH', [binanceNetwork('ETH', ''), binanceNetwork('BASE', ''), binanceNetwork('ARBITRUM', '')]),
  binanceCoin('BONK', [binanceNetwork('SOL', BONK)]),
  binanceCoin('MOG', [binanceNetwork('ETH', A.mog)]),
  binanceCoin('RUSAK', [binanceNetwork('ETH', 'bukan-alamat'), binanceNetwork('SOL', '0x1234'), binanceNetwork('BSC', `0x${'0'.repeat(40)}`)]),
  binanceCoin('DUAL', [binanceNetwork('MATIC', A.dualA), binanceNetwork('POLYGON', A.dualB)]),
  binanceCoin('OLDTKN', [binanceNetwork('ETH', A.shared)]),
  binanceCoin('NEWTKN', [binanceNetwork('ETH', A.shared)]),
];
const FUTURES = [
  futuresSymbol('1000PEPEUSDT', '1000PEPE'),
  futuresSymbol('1000SATSUSDT', '1000SATS'),
  futuresSymbol('1MBABYDOGEUSDT', '1MBABYDOGE'),
  futuresSymbol('1000BONKUSDT', '1000BONK'),
  futuresSymbol('1000000MOGUSDT', '1000000MOG'),
  futuresSymbol('BTCDOMUSDT', 'BTCDOM', { underlyingType: 'INDEX' }),
  futuresSymbol('FOOUSDT', 'FOO'),
  futuresSymbol('1000XYZUSDT', '1000XYZ'),
  futuresSymbol('PEPEUSDC', 'PEPE', { quoteAsset: 'USDC', marginAsset: 'USDC' }),
  futuresSymbol('POLUSDT', 'POL', { status: 'SETTLING' }),
  futuresSymbol('ETHUSDT_261225', 'ETH', { contractType: 'CURRENT_QUARTER' }),
  futuresSymbol('ETHUSDT', 'ETH'),
];
const SPOT = [
  spotSymbol('PEPEUSDT', 'PEPE'), spotSymbol('1000SATSUSDT', '1000SATS'), spotSymbol('1MBABYDOGEUSDT', '1MBABYDOGE'),
  spotSymbol('BONKUSDT', 'BONK'), spotSymbol('USDCUSDT', 'USDC'), spotSymbol('POLUSDT', 'POL'),
  spotSymbol('PEPEBTC', 'PEPE', { quoteAsset: 'BTC' }), spotSymbol('DUALUSDT', 'DUAL', { status: 'BREAK' }),
];

function fakeTime(start = NOW) {
  let now = start;
  return { clock: () => now, sleep: async (ms) => { now += ms; } };
}

/**
 * fetch palsu meniru Binance: endpoint /sapi/ memvalidasi header X-MBX-APIKEY dan tanda tangan HMAC atas query
 * persis `timestamp=…&recvWindow=…` (salah → -2015 / -1022). `overrides`: { 'host/path': Response | fungsi(url) }.
 */
function setup({ restrictions = binanceRestrictions(), coins = COINS, futures = FUTURES, spot = SPOT, overrides = {} } = {}, options = {}) {
  const t = fakeTime();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const route = `${u.host}${u.pathname}`;
    calls.push({ url: u, route, at: t.clock(), init });
    if (Object.hasOwn(overrides, route)) {
      const o = overrides[route];
      return typeof o === 'function' ? o(u, init) : o;
    }
    if (u.pathname.startsWith('/sapi/')) {
      const query = u.search.slice(1).replace(/&signature=[^&]*$/, '');
      if (init.headers['X-MBX-APIKEY'] !== KEY) return jsonResponse(401, { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' });
      if (u.searchParams.get('signature') !== signQuery(query, SECRET)) {
        return jsonResponse(400, { code: -1022, msg: 'Signature for this request is not valid.' });
      }
    }
    switch (route) {
      case `api.binance.com${BINANCE_PATHS.apiRestrictions}`: return jsonResponse(200, restrictions);
      case `api.binance.com${BINANCE_PATHS.allCoins}`: return jsonResponse(200, coins);
      case `fapi.binance.com${BINANCE_PATHS.futuresExchangeInfo}`: return jsonResponse(200, { timezone: 'UTC', serverTime: NOW, symbols: futures });
      case `api.binance.com${BINANCE_PATHS.spotExchangeInfo}`: return jsonResponse(200, { timezone: 'UTC', serverTime: NOW, symbols: spot });
      default: return jsonResponse(404, { code: -1, msg: 'tidak ada' });
    }
  };
  const provider = createBinanceMappingProvider({ apiKey: KEY, apiSecret: SECRET, fetchImpl, clock: t.clock, sleep: t.sleep, ...options });
  return { provider, calls, t };
}

const rowsFor = (rows, chain, contractAddress) => rows.filter((r) => r.chain === chain && r.contractAddress === contractAddress);

/** Potongan ≥ 12 karakter dari `secret` yang muncul di `text` (bocor sebagian juga dihitung), atau null. */
function leakedFragment(text, secret, size = 12) {
  for (let i = 0; i + size <= secret.length; i += 1) {
    const part = secret.slice(i, i + size);
    if (text.includes(part)) return part;
  }
  return null;
}

describe('Binance mapping — tanda tangan & izin kunci', () => {
  it('UNIT-SM-BNM-001 HMAC-SHA256 cocok dengan contoh resmi dok Binance; permintaan bertanda tangan tepat, publik tanpa kunci', async () => {
    expect(signQuery(
      'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559',
      'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j',
    )).toBe('c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');

    const { provider, calls } = setup();
    await provider.fetchBinanceMapping();
    expect(calls.map((c) => c.route)).toEqual([
      'api.binance.com/sapi/v1/account/apiRestrictions', 'api.binance.com/sapi/v1/capital/config/getall',
      'fapi.binance.com/fapi/v1/exchangeInfo', 'api.binance.com/api/v3/exchangeInfo',
    ]);
    for (const c of calls.slice(0, 2)) {
      expect(c.url.search).toMatch(/^\?timestamp=\d{13}&recvWindow=10000&signature=[0-9a-f]{64}$/);
      expect(c.url.searchParams.get('timestamp')).toBe(String(c.at)); // timestamp dibuat saat kirim (setelah antrean)
      expect(c.init.headers['X-MBX-APIKEY']).toBe(KEY);
    }
    for (const c of calls.slice(2)) {
      expect(c.url.search).toBe('');
      expect(c.init.headers['X-MBX-APIKEY']).toBeUndefined();
    }
    expect(calls.every((c) => c.init.method === 'GET' && c.init.redirect === 'error')).toBe(true);
    expect(calls.map((c) => c.at - NOW)).toEqual([0, 500, 1000, 1500]); // throttle 2/detik
  });

  it('UNIT-SM-BNM-002 kunci baca-saja lolos (enableFixReadOnly = izin baca); vonis di-cache seumur provider', async () => {
    const { provider, calls } = setup({ restrictions: binanceRestrictions({ ipRestrict: true }) });
    await expect(provider.checkKeyRestrictions()).resolves.toEqual({ enableReading: true, ipRestrict: true, checkedAt: NOW });
    await provider.fetchBinanceMapping();
    await provider.fetchBinanceMapping();
    const count = (path) => calls.filter((c) => c.url.pathname === path).length;
    expect(count(BINANCE_PATHS.apiRestrictions)).toBe(1);
    expect(count(BINANCE_PATHS.allCoins)).toBe(2);
    expect(findExcessPermissions(binanceRestrictions())).toEqual([]);
    expect(findExcessPermissions({ ...binanceRestrictions(), enableWithdrawals: 'true', permitsUniversalTransfer: true, enableNewThing: true }))
      .toEqual(['enableNewThing', 'enableWithdrawals', 'permitsUniversalTransfer']);
    expect(findExcessPermissions(null)).toEqual([]);
  });

  it('NEG-SM-BNM-001 kunci berizin trading/penarikan/transfer atau tanpa Enable Reading DITOLAK dan tidak pernah dipakai lagi', async () => {
    const refusals = [
      [{ enableSpotAndMarginTrading: true }, /enableSpotAndMarginTrading/],
      [{ enableWithdrawals: true }, /enableWithdrawals/],
      [{ permitsUniversalTransfer: true }, /permitsUniversalTransfer/],
      [{ enableFutures: true, enableMargin: true, enableVanillaOptions: true, enablePortfolioMarginTrading: true }, /\+1 lainnya/],
      [{ enableReading: false }, /tidak memiliki izin Enable Reading/],
    ];
    for (const [overrides, detail] of refusals) {
      const { provider, calls } = setup({ restrictions: binanceRestrictions(overrides) });
      const err = await provider.fetchBinanceMapping().catch((e) => e);
      expect(err).toMatchObject({ name: 'ProviderError', code: 'UNAUTHORIZED', provider: 'binance-mapping' });
      expect(err.message).toMatch(detail);
      expect(err.message).toContain('buat kunci baru dengan izin Enable Reading saja');
      // Tidak ada panggilan lain setelah penolakan — termasuk pada panggilan berikutnya.
      await expect(provider.fetchBinanceMapping()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(provider.checkKeyRestrictions()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(calls.map((c) => c.url.pathname)).toEqual([BINANCE_PATHS.apiRestrictions]);
      expect(provider.lastDiagnostics()).toMatchObject({ method: 'checkKeyRestrictions', refused: true });
    }
  });

  it('EDGE-SM-BNM-001 respons izin tanpa enableReading → BAD_RESPONSE; kegagalan sementara tidak di-cache', async () => {
    let attempt = 0;
    const route = `api.binance.com${BINANCE_PATHS.apiRestrictions}`;
    const { provider, calls } = setup({
      overrides: {
        [route]: () => {
          attempt += 1;
          if (attempt === 1) return jsonResponse(503, '');
          if (attempt === 2) return jsonResponse(200, { ipRestrict: false });
          return jsonResponse(200, binanceRestrictions());
        },
      },
    });
    await expect(provider.checkKeyRestrictions()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(provider.checkKeyRestrictions()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    await expect(provider.checkKeyRestrictions()).resolves.toMatchObject({ enableReading: true });
    await expect(provider.checkKeyRestrictions()).resolves.toMatchObject({ enableReading: true });
    expect(calls).toHaveLength(3);
  });
});

describe('Binance mapping — baris mapping', () => {
  it('UNIT-SM-BNM-003 getall → baris per (chain, kontrak); multi-jaringan; kode jaringan asing dilaporkan, tidak ditebak', async () => {
    const { provider } = setup();
    const rows = await provider.fetchBinanceMapping();
    expect(rows).toHaveLength(15);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['binanceAsset', 'chain', 'contractAddress', 'futuresSymbol', 'multiplier', 'source', 'spotSymbol', 'verifiedAt']);
      expect(r.verifiedAt).toBe(NOW + 1500);
    }
    // PEPE: alamat checksum → huruf kecil; ETH & BSC; AVAXC tidak dipetakan.
    expect(rowsFor(rows, 'ethereum', PEPE)).toEqual([{
      chain: 'ethereum', contractAddress: PEPE, binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT',
      multiplier: 1000, source: 'binance-getall+prefix-rule', verifiedAt: NOW + 1500,
    }]);
    expect(rowsFor(rows, 'bsc', A.pepeBsc)).toMatchObject([{ binanceAsset: 'PEPE', futuresSymbol: '1000PEPEUSDT', multiplier: 1000 }]);
    // USDC di tiga chain (Solana apa adanya); TRX tidak dipetakan.
    expect(rows.filter((r) => r.binanceAsset === 'USDC').map((r) => `${r.chain}:${r.contractAddress}`).sort())
      .toEqual([`base:${A.usdcBase}`, `ethereum:${A.usdcEth}`, `solana:${USDC_SOL}`]);
    expect(rowsFor(rows, 'solana', USDC_SOL)[0]).toMatchObject({ spotSymbol: 'USDCUSDT', futuresSymbol: null, multiplier: 1 });
    // MATIC & POLYGON dengan kontrak sama → satu baris; perp POL SETTLING diabaikan.
    expect(rowsFor(rows, 'polygon', A.pol)).toMatchObject([{ binanceAsset: 'POL', spotSymbol: 'POLUSDT', futuresSymbol: null }]);
    // Kontrak berbeda untuk koin sama di satu chain → dua baris; spot BREAK diabaikan.
    expect(rows.filter((r) => r.binanceAsset === 'DUAL').map((r) => r.contractAddress).sort()).toEqual([A.dualA, A.dualB].sort());
    expect(rows.filter((r) => r.binanceAsset === 'DUAL').every((r) => r.spotSymbol === null)).toBe(true);
    // Koin native tanpa kontrak (ETH) & kontrak rusak tidak menghasilkan baris.
    expect(rows.some((r) => r.binanceAsset === 'ETH' || r.binanceAsset === 'RUSAK')).toBe(false);

    const d = rows.diagnostics;
    expect(Object.keys(rows)).not.toContain('diagnostics');
    expect(d.unknownNetworks).toEqual([{ network: 'AVAXC', count: 1, coins: ['PEPE'] }, { network: 'TRX', count: 1, coins: ['USDC'] }]);
    expect(d.invalidContracts).toEqual([
      { coin: 'RUSAK', network: 'ETH', contractAddress: 'bukan-alamat' }, { coin: 'RUSAK', network: 'SOL', contractAddress: '0x1234' },
      { coin: 'RUSAK', network: 'BSC', contractAddress: `0x${'0'.repeat(40)}` },
    ]);
    expect(d).toMatchObject({ coins: 12, networksWithContract: 21, rows: 15, duplicateRows: 1, nonCoinPerps: 1, unmappedPerpsCount: 2, spotAvailable: true, spotError: null });
    expect(d.unmappedPerps).toEqual(['FOOUSDT', '1000XYZUSDT']);
    expect(d.sharedContracts).toEqual([{
      chain: 'ethereum', contractAddress: A.shared,
      entries: [{ binanceAsset: 'NEWTKN', futuresSymbol: null, multiplier: 1 }, { binanceAsset: 'OLDTKN', futuresSymbol: null, multiplier: 1 }],
    }]);
    expect(provider.lastDiagnostics()).toEqual(d);
    // Saldo akun di respons getall tidak pernah ikut keluar.
    expect(JSON.stringify([...rows, d])).not.toMatch(/34941/);
  });

  it('UNIT-SM-BNM-004 nama persis dulu (1000SATS ×1), lalu aturan prefix (1000PEPE→PEPE ×1000, 1000000MOG ×1.000.000); denomination ikut dikalikan', async () => {
    const { provider } = setup();
    const rows = await provider.fetchBinanceMapping();
    expect(rowsFor(rows, 'bsc', A.satsBsc)).toMatchObject([
      { binanceAsset: '1000SATS', futuresSymbol: '1000SATSUSDT', spotSymbol: '1000SATSUSDT', multiplier: 1, source: 'binance-getall' },
    ]);
    expect(rowsFor(rows, 'ethereum', A.mog)).toMatchObject([
      { binanceAsset: 'MOG', futuresSymbol: '1000000MOGUSDT', spotSymbol: null, multiplier: 1_000_000, source: 'binance-getall+prefix-rule' },
    ]);
    expect(rowsFor(rows, 'solana', BONK)).toMatchObject([{ binanceAsset: 'BONK', futuresSymbol: '1000BONKUSDT', multiplier: 1000 }]);
    // Contoh resmi: 1 unit 1MBABYDOGE = 1.000.000 BabyDoge on-chain → nama persis TIDAK berarti pengali 1.
    expect(rowsFor(rows, 'bsc', BABYDOGE_BSC)).toMatchObject([
      { binanceAsset: '1MBABYDOGE', futuresSymbol: '1MBABYDOGEUSDT', multiplier: 1_000_000, source: 'binance-getall+denomination' },
    ]);
    const d = rows.diagnostics;
    expect(d.prefixRule.map((p) => [p.futuresSymbol, p.binanceAsset, p.factor])).toEqual([
      ['1000PEPEUSDT', 'PEPE', 1000], ['1000BONKUSDT', 'BONK', 1000], ['1000000MOGUSDT', 'MOG', 1_000_000],
    ]);
    expect(d.prefixRule[0].note).toContain('verifikasi');
    expect(d.denominated).toEqual([{ binanceAsset: '1MBABYDOGE', chain: 'bsc', contractAddress: BABYDOGE_BSC, denomination: 1_000_000 }]);
    expect('1000SATS'.match(PERP_PREFIX_RE)?.[2]).toBe('SATS'); // regex cocok — justru karena itu nama persis harus didahulukan
    expect(BINANCE_NETWORK_CHAINS).toMatchObject({ ETH: 'ethereum', BSC: 'bsc', MATIC: 'polygon', POLYGON: 'polygon', SOL: 'solana' });
    expect(BINANCE_NETWORK_CHAINS.BNB).toBeUndefined(); // BEP2 ≠ BSC — tidak ditebak
  });

  it('UNIT-SM-BNM-005 end-to-end: baris → binanceMatch.matchToken (MATCHED 1000PEPEUSDT ×1000; PEPE palsu SYMBOL_ONLY; kontrak bersama AMBIGUOUS)', async () => {
    const { provider } = setup();
    const rows = await provider.fetchBinanceMapping();
    const pepe = matchToken({ chain: 'ethereum', address: PEPE_CHECKSUM, symbol: 'PEPE' }, rows);
    expect(pepe).toMatchObject({
      status: 'MATCHED', binanceAsset: 'PEPE', futuresSymbol: '1000PEPEUSDT', spotSymbol: 'PEPEUSDT', multiplier: 1000,
      source: 'binance-getall+prefix-rule',
    });
    expect(pepe.note).toContain('1 kontrak = 1000 token');
    const fake = matchToken({ chain: 'ethereum', address: fakeEvmAddress('bn-fake-pepe'), symbol: 'PEPE' }, rows);
    expect(fake).toMatchObject({ status: 'SYMBOL_ONLY', futuresSymbol: null, multiplier: 1 });
    expect(matchToken({ chain: 'base', address: PEPE, symbol: 'PEPE' }, rows).status).toBe('SYMBOL_ONLY');
    expect(matchToken({ chain: 'bsc', address: BABYDOGE_BSC, symbol: 'BABYDOGE' }, rows))
      .toMatchObject({ status: 'MATCHED', futuresSymbol: '1MBABYDOGEUSDT', multiplier: 1_000_000 });
    expect(matchToken({ chain: 'ethereum', address: A.shared, symbol: 'NEWTKN' }, rows).status).toBe('AMBIGUOUS');
    expect(matchToken({ chain: 'solana', address: BONK, symbol: 'BONK' }, rows)).toMatchObject({ status: 'MATCHED', multiplier: 1000 });
    expect(matchToken({ chain: 'solana', address: BONK.toLowerCase(), symbol: 'BONK' }, rows).status).toBe('SYMBOL_ONLY');
  });

  it('EDGE-SM-BNM-002 exchangeInfo spot gagal → spotSymbol null, mapping tetap; futures gagal → seluruh mapping gagal', async () => {
    const { provider } = setup({ overrides: { [`api.binance.com${BINANCE_PATHS.spotExchangeInfo}`]: jsonResponse(500, '') } });
    const rows = await provider.fetchBinanceMapping();
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.spotSymbol === null)).toBe(true);
    expect(rowsFor(rows, 'ethereum', PEPE)[0]).toMatchObject({ futuresSymbol: '1000PEPEUSDT', multiplier: 1000 });
    expect(rows.diagnostics).toMatchObject({ spotAvailable: false, spotError: { code: 'UNAVAILABLE' } });
    expect(rows.diagnostics.notes[0]).toContain('spotSymbol null');

    const geo = setup({ overrides: { [`fapi.binance.com${BINANCE_PATHS.futuresExchangeInfo}`]: jsonResponse(451, { code: 0, msg: 'Service unavailable from a restricted location' }) } });
    await expect(geo.provider.fetchBinanceMapping()).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 451 });
    // Dibatalkan saat exchangeInfo spot: TIDAK boleh diam-diam selesai dengan spotSymbol null.
    const ac = new AbortController();
    const aborting = setup({
      overrides: {
        [`api.binance.com${BINANCE_PATHS.spotExchangeInfo}`]: () => { ac.abort(); throw new DOMException('This operation was aborted', 'AbortError'); },
      },
    });
    await expect(aborting.provider.fetchBinanceMapping({ signal: ac.signal })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(aborting.provider.lastDiagnostics()).toBeNull();
    const broken = setup({ coins: { bukan: 'array' } });
    await expect(broken.provider.fetchBinanceMapping()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('UNIT-SM-BNM-006 fungsi murni: >1 perp per koin (nama persis menang / tanpa nama persis → AMBIGUOUS); denomination rusak; validasi', () => {
    const coins = [
      binanceCoin('XQ', [binanceNetwork('ETH', fakeEvmAddress('bn-xq'))]),
      binanceCoin('YQ', [binanceNetwork('ETH', fakeEvmAddress('bn-yq'))]),
      binanceCoin('ZQ', [binanceNetwork('ETH', fakeEvmAddress('bn-zq'), { denomination: 'nol' })]),
      binanceCoin('', [binanceNetwork('ETH', fakeEvmAddress('bn-empty'))]),
    ];
    const futures = [
      futuresSymbol('XQUSDT', 'XQ'), futuresSymbol('1000XQUSDT', '1000XQ'),
      futuresSymbol('1000YQUSDT', '1000YQ'), futuresSymbol('1MYQUSDT', '1MYQ', { underlyingType: undefined }),
    ];
    const { rows, diagnostics } = buildBinanceMappingRows({ coins, futuresSymbols: futures, verifiedAt: NOW });
    expect(rows.filter((r) => r.binanceAsset === 'XQ').map((r) => [r.futuresSymbol, r.multiplier])).toEqual([['XQUSDT', 1]]);
    const yq = rows.filter((r) => r.binanceAsset === 'YQ');
    expect(yq.map((r) => [r.futuresSymbol, r.multiplier])).toEqual([['1000YQUSDT', 1000], ['1MYQUSDT', 1_000_000]]);
    expect(matchToken({ chain: 'ethereum', address: fakeEvmAddress('bn-yq'), symbol: 'YQ' }, rows).status).toBe('AMBIGUOUS');
    expect(diagnostics.multiplePerps).toEqual([
      { binanceAsset: 'XQ', futuresSymbols: ['1000XQUSDT', 'XQUSDT'], chosen: ['XQUSDT'] },
      { binanceAsset: 'YQ', futuresSymbols: ['1000YQUSDT', '1MYQUSDT'], chosen: ['1000YQUSDT', '1MYQUSDT'] },
    ]);
    expect(diagnostics.invalidDenominations).toEqual([{ coin: 'ZQ', network: 'ETH', value: 'nol' }]);
    expect(diagnostics.invalidAssets).toEqual(['']);
    expect(diagnostics.spotAvailable).toBe(false);
    expect(rows.every((r) => r.spotSymbol === null)).toBe(true);
    expect(() => buildBinanceMappingRows({ coins, futuresSymbols: futures, verifiedAt: 1.5 })).toThrow(TypeError);
    expect(buildBinanceMappingRows({ coins: null, futuresSymbols: null, verifiedAt: NOW }).rows).toEqual([]);
  });
});

describe('Binance mapping — error & kerahasiaan', () => {
  it('NEG-SM-BNM-002 kode error Binance & HTTP dipetakan ke ProviderError', async () => {
    const restrictionsRoute = `api.binance.com${BINANCE_PATHS.apiRestrictions}`;
    const cases = [
      [jsonResponse(401, { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }), { code: 'UNAUTHORIZED', status: 401 }, /-2015/],
      [jsonResponse(400, { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' }), { code: 'BAD_RESPONSE', retryAfterMs: null }, /jam komputer.*Mac/],
      [jsonResponse(400, { code: -1022, msg: 'Signature for this request is not valid.' }), { code: 'UNAUTHORIZED' }, /API secret/],
      [jsonResponse(451, { code: 0, msg: "Service unavailable from a restricted location according to 'b. Eligibility'" }), { code: 'UNAVAILABLE', status: 451 }, /pembatasan geografis/],
      [jsonResponse(418, { code: -1003, msg: 'Way too many requests; IP banned.' }, { 'retry-after': '300' }), { code: 'RATE_LIMITED', retryAfterMs: 300_000 }, /HTTP 418/],
      [jsonResponse(418, ''), { code: 'RATE_LIMITED', retryAfterMs: 120_000 }, /diblokir sementara/],
      [jsonResponse(429, { code: -1003, msg: 'Too many requests.' }, { 'retry-after': '7' }), { code: 'RATE_LIMITED', retryAfterMs: 7000 }, /HTTP 429/],
      [jsonResponse(403, '<html>WAF</html>'), { code: 'UNAVAILABLE', status: 403 }, /WAF/],
      [jsonResponse(503, ''), { code: 'UNAVAILABLE', status: 503 }, /HTTP 503/],
      [jsonResponse(400, { code: -1104, msg: 'Not all sent parameters were read.' }), { code: 'BAD_RESPONSE' }, /\(kode -1104\) — Binance: Not all sent/],
      [jsonResponse(200, '<html>'), { code: 'BAD_RESPONSE' }, /bukan JSON/],
      [jsonResponse(200, { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }), { code: 'UNAUTHORIZED' }, /-2015/],
    ];
    for (const [response, expected, message] of cases) {
      const { provider } = setup({ overrides: { [restrictionsRoute]: response } });
      const err = await provider.checkKeyRestrictions().catch((e) => e);
      expect(err).toMatchObject({ name: 'ProviderError', provider: 'binance-mapping', ...expected });
      expect(err.message).toMatch(message);
    }
    const offline = setup({ overrides: { [restrictionsRoute]: (u) => { throw new TypeError(`fetch failed ${u.href}`); } } });
    await expect(offline.provider.checkKeyRestrictions()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const ac = new AbortController();
    ac.abort();
    const cancelled = setup();
    await expect(cancelled.provider.fetchBinanceMapping({ signal: ac.signal })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancelled.calls).toHaveLength(0);
  });

  it('NEG-SM-BNM-003 kunci, secret, dan signature TIDAK PERNAH muncul di pesan error, JSON error, stack, atau diagnostik', async () => {
    const restrictionsRoute = `api.binance.com${BINANCE_PATHS.apiRestrictions}`;
    const seenSignatures = [];
    const echo = (u, init) => {
      const sig = u.searchParams.get('signature');
      seenSignatures.push(sig);
      return jsonResponse(400, { code: -9999, msg: `echo key=${init.headers['X-MBX-APIKEY']} secret=${SECRET} sig=${sig} ${u.href}` });
    };
    const leakyErrors = [
      echo,
      (u) => { seenSignatures.push(u.searchParams.get('signature')); throw new TypeError(`fetch failed ${u.href} ${KEY}`); },
      (u) => { seenSignatures.push(u.searchParams.get('signature')); return jsonResponse(401, { code: -2015, msg: `bad key ${KEY}` }); },
      (u) => { seenSignatures.push(u.searchParams.get('signature')); return jsonResponse(500, { code: -1000, msg: `internal ${SECRET.slice(0, 20)}${SECRET.slice(20)}` }); },
    ];
    for (const route of leakyErrors) {
      const { provider } = setup({ overrides: { [restrictionsRoute]: route } });
      const err = await provider.fetchBinanceMapping().catch((e) => e);
      expect(err.name).toBe('ProviderError');
      const surfaces = [err.message, JSON.stringify(err), String(err.stack), JSON.stringify(err.toJSON()), JSON.stringify(provider.lastDiagnostics())];
      for (const text of surfaces) {
        for (const secret of [KEY, SECRET, ...seenSignatures]) expect(leakedFragment(text, secret)).toBeNull();
      }
    }
    expect(seenSignatures.every((s) => /^[0-9a-f]{64}$/.test(s))).toBe(true);
    // Objek adapter (mis. untuk GET /status) tidak membawa kunci.
    const { provider } = setup();
    expect(JSON.stringify(provider)).not.toMatch(new RegExp(`${KEY}|${SECRET}`));
  });
});

describe('Binance mapping — kontrak adapter', () => {
  it('UNIT-SM-BNM-007 validateAdapter lolos; butuh kunci; tanpa kunci valid → NOT_CONFIGURED tanpa panggilan jaringan', async () => {
    const { provider } = setup();
    expect(validateAdapter(provider)).toEqual([]);
    expect(provider).toMatchObject({ id: 'binance-mapping', requiresKey: true, isSimulated: false });
    expect([...provider.capabilities]).toEqual(['binanceMapping']);
    expect(provider.terms).toMatchObject({ attribution: null, displayAllowed: true });
    expect(provider.terms.notes).toBe('Kunci Binance hanya untuk membaca daftar kontrak aset; tidak pernah dipakai untuk order/penarikan. '
      + 'Posisi futures pribadi siapa pun tidak dapat diketahui dari data ini.');
    expect([...provider.chains].sort()).toEqual(['arbitrum', 'base', 'bsc', 'ethereum', 'optimism', 'polygon', 'solana']);
    expect(provider.isConfigured()).toBe(true);
    for (const m of ['fetchWalletTransfers', 'fetchLabels', 'fetchPrices', 'discoverWallets']) {
      await expect(provider[m]({})).rejects.toMatchObject({ code: 'NOT_SUPPORTED', provider: 'binance-mapping' });
    }
    expect(createProviderRegistry({ adapters: [provider], enabledIds: ['binance-mapping'] }).withCapability('binanceMapping')).toEqual([provider]);

    let called = 0;
    const fetchImpl = async () => { called += 1; return jsonResponse(200, {}); };
    for (const creds of [{}, { apiKey: KEY }, { apiKey: `abc\n${KEY}`, apiSecret: SECRET }, { apiKey: ' ', apiSecret: ' ' }]) {
      const p = createBinanceMappingProvider({ ...creds, fetchImpl });
      expect(p.isConfigured()).toBe(false);
      const err = await p.fetchBinanceMapping().catch((e) => e);
      expect(err).toMatchObject({ code: 'NOT_CONFIGURED' });
      expect(err.message).not.toContain(KEY);
      await expect(p.checkKeyRestrictions()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    }
    expect(called).toBe(0);
    expect(() => createBinanceMappingProvider({ spotBaseUrl: 'http://api.binance.com' })).toThrow(TypeError);
    expect(() => createBinanceMappingProvider({ futuresBaseUrl: 'https://fapi.contoh.invalid' })).toThrow(TypeError);
    expect(() => createBinanceMappingProvider({ spotBaseUrl: 'https://api.binance.com/sapi' })).toThrow(TypeError);
    expect(() => createBinanceMappingProvider({ recvWindow: 70_000 })).toThrow(RangeError);
    expect(createBinanceMappingProvider({ spotBaseUrl: 'https://api1.binance.com' }).isConfigured()).toBe(false);
  });
});

/**
 * fetch palsu untuk mode publik tanpa kunci: www.binance.com/bapi/... mengembalikan `publicBody` (default bentuk
 * `{ code: '000000', data, success: true }`); endpoint /sapi/ sengaja selalu 401 agar pemakaian kunci ketahuan.
 */
function setupPublic({ publicBody = { code: '000000', message: null, data: COINS, success: true }, futures = FUTURES, spot = SPOT } = {}, options = {}) {
  const t = fakeTime();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const route = `${u.host}${u.pathname}`;
    calls.push({ url: u, route, at: t.clock(), init });
    switch (route) {
      case `www.binance.com${BINANCE_PATHS.publicCoins}`: return jsonResponse(200, publicBody);
      case `fapi.binance.com${BINANCE_PATHS.futuresExchangeInfo}`: return jsonResponse(200, { timezone: 'UTC', serverTime: NOW, symbols: futures });
      case `api.binance.com${BINANCE_PATHS.spotExchangeInfo}`: return jsonResponse(200, { timezone: 'UTC', serverTime: NOW, symbols: spot });
      default: return jsonResponse(401, { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' });
    }
  };
  const provider = createBinancePublicMappingProvider({ fetchImpl, clock: t.clock, sleep: t.sleep, ...options });
  return { provider, calls, t };
}

describe('Binance mapping — mode publik tanpa kunci (binance-public)', () => {
  it('UNIT-SM-BNM-008 publicCoinsOf: { code: "000000", data, success: true } atau array langsung → array; selain itu null', () => {
    const data = [binanceCoin('PEPE', [binanceNetwork('ETH', PEPE)])];
    expect(publicCoinsOf({ code: '000000', message: null, data, success: true })).toBe(data);
    expect(publicCoinsOf({ data })).toBe(data); // tanpa code/success → tetap dibaca
    expect(publicCoinsOf(data)).toBe(data);
    expect(publicCoinsOf([])).toEqual([]);
    for (const bad of [
      { code: '000000', data, success: false }, { code: '100001', data, success: true }, { code: 100001, data },
      { code: '000000', data: null, success: true }, { code: '000000', data: { coins: data }, success: true },
      null, undefined, 'teks', 42,
    ]) {
      expect(publicCoinsOf(bad)).toBeNull();
    }
  });

  it('UNIT-SM-BNM-009 endpoint publik → baris sama dengan getall bersumber binance-public; tanpa kunci, tanda tangan, atau /sapi/', async () => {
    const { provider, calls } = setupPublic();
    const rows = await provider.fetchBinanceMapping();
    expect(calls.map((c) => c.route)).toEqual([
      'www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll',
      'fapi.binance.com/fapi/v1/exchangeInfo', 'api.binance.com/api/v3/exchangeInfo',
    ]);
    for (const c of calls) {
      expect(c.url.search).toBe('');
      expect(c.url.searchParams.has('signature')).toBe(false);
      expect(Object.keys(c.init.headers).map((h) => h.toLowerCase())).not.toContain('x-mbx-apikey');
      expect(c.init).toMatchObject({ method: 'GET', redirect: 'error' });
    }
    expect(calls.map((c) => c.at - NOW)).toEqual([0, 500, 1000]); // throttle 2/detik tetap berlaku
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.source.startsWith('binance-public'))).toBe(true);
    expect(rowsFor(rows, 'ethereum', PEPE)).toEqual([{
      chain: 'ethereum', contractAddress: PEPE, binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT',
      multiplier: 1000, source: 'binance-public+prefix-rule', verifiedAt: NOW + 1000,
    }]);
    expect(rowsFor(rows, 'bsc', BABYDOGE_BSC)).toMatchObject([{ source: 'binance-public+denomination', multiplier: 1_000_000 }]);
    expect(rowsFor(rows, 'solana', USDC_SOL)).toMatchObject([{ source: 'binance-public', futuresSymbol: null }]);
    // Hasil sama dengan mode berkunci, kecuali sumbernya.
    const keyed = await setup().provider.fetchBinanceMapping();
    const strip = (list) => list.map(({ source: _s, verifiedAt: _v, ...r }) => r);
    expect(strip(rows)).toEqual(strip(keyed));
    expect(provider.lastDiagnostics()).toMatchObject({ coins: 12, rows: 15, spotAvailable: true });

    // Array langsung (tanpa amplop) juga diterima.
    const bare = await setupPublic({ publicBody: COINS }).provider.fetchBinanceMapping();
    expect(bare).toEqual(rows);
  });

  it('NEG-SM-BNM-004 mode publik: success:false / kode bukan "000000" / tanpa array → BAD_RESPONSE; kunci yang diberikan diabaikan', async () => {
    for (const publicBody of [
      { code: '000000', data: COINS, success: false }, { code: '345001', message: 'system busy', data: null, success: false },
      { code: '000000', data: null, success: true }, { coins: COINS }, 'bukan objek',
    ]) {
      const { provider, calls } = setupPublic({ publicBody });
      await expect(provider.fetchBinanceMapping()).rejects.toMatchObject({ code: 'BAD_RESPONSE', provider: 'binance-public' });
      expect(calls.map((c) => c.route)).toEqual(['www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll']);
    }
    // HTTP 451 tetap dipetakan seperti mode berkunci.
    const fetch451 = async () => jsonResponse(451, { code: 0, msg: 'Service unavailable from a restricted location' });
    await expect(createBinancePublicMappingProvider({ fetchImpl: fetch451, ...fakeTime() }).fetchBinanceMapping())
      .rejects.toMatchObject({ code: 'UNAVAILABLE', status: 451, provider: 'binance-public' });

    // apiKey/apiSecret yang (keliru) diteruskan tidak pernah dikirim maupun bocor.
    const { provider, calls } = setupPublic({}, { apiKey: KEY, apiSecret: SECRET });
    await provider.fetchBinanceMapping();
    for (const c of calls) {
      expect(Object.values(c.init.headers)).not.toContain(KEY);
      expect(c.url.href).not.toContain(KEY);
      expect(c.url.searchParams.has('signature')).toBe(false);
    }
    expect(JSON.stringify(provider)).not.toMatch(new RegExp(`${KEY}|${SECRET}`));
  });

  it('UNIT-SM-BNM-010 kontrak adapter publik: validateAdapter lolos, tanpa kunci, terkonfigurasi; checkKeyRestrictions → NOT_SUPPORTED tanpa jaringan', async () => {
    const { provider, calls } = setupPublic();
    expect(validateAdapter(provider)).toEqual([]);
    expect(provider).toMatchObject({ id: 'binance-public', requiresKey: false, isSimulated: false });
    expect(provider.displayName).toBe('Binance publik (pemetaan kontrak aset, tanpa kunci)');
    expect([...provider.capabilities]).toEqual(['binanceMapping']);
    expect(provider.terms.notes).toBe('Tanpa kunci: daftar kontrak dari endpoint publik situs Binance (tidak resmi, dapat berubah sewaktu-waktu). '
      + 'Posisi futures pribadi siapa pun tidak dapat diketahui dari data ini.');
    expect([...provider.chains].sort()).toEqual(['arbitrum', 'base', 'bsc', 'ethereum', 'optimism', 'polygon', 'solana']);
    expect(provider.isConfigured()).toBe(true);
    await expect(provider.checkKeyRestrictions()).rejects.toMatchObject({ code: 'NOT_SUPPORTED', provider: 'binance-public' });
    for (const m of ['fetchWalletTransfers', 'fetchLabels', 'fetchPrices', 'discoverWallets']) {
      await expect(provider[m]({})).rejects.toMatchObject({ code: 'NOT_SUPPORTED', provider: 'binance-public' });
    }
    expect(calls).toHaveLength(0);
    expect(createProviderRegistry({ adapters: [provider], enabledIds: ['binance-public'] }).withCapability('binanceMapping')).toEqual([provider]);
    expect(() => createBinancePublicMappingProvider({ webBaseUrl: 'http://www.binance.com' })).toThrow(TypeError);
    expect(() => createBinancePublicMappingProvider({ webBaseUrl: 'https://www.contoh.invalid' })).toThrow(TypeError);
    expect(() => createBinancePublicMappingProvider({ webBaseUrl: 'https://www.binance.com/bapi' })).toThrow(TypeError);
  });
});
