import { describe, expect, it } from 'vitest';
import * as contracts from '../../../backend/smartmoney/contracts.js';
import {
  ALERT_KINDS, CHAINS, DISCLAIMERS, EMPTY, EXPLORERS, RADAR_STATES, RADAR_WINDOWS, TRADING_STYLES, USD_UNKNOWN,
  alertKindLabel, buildAlertsQuery, buildRadarQuery, buildWalletsQuery, clampScore, clusterReasonLabel, clusterText,
  completenessLabel, componentPercent, disclaimersOf, entityPath, evidenceLines, excludedSummary, explorerAddressUrl,
  explorerTokenUrl, explorerTxUrl, flagInfo, formatRatioPct, formatSignedPct, formatUsdOrDash, isNoSourceState,
  labelText, mapServerPrefErrors, matchBadge, metaStatus, normalizeAddress, parseEntityQuery, parseRadarFilters,
  parseTokenKey, prefsToForm, relevanceLabel, safeExternalUrl, screenerChipInfo, shortAddress, signOf,
  signalPatternLabels, signalsByTimeframe, smartTokenHref, smartWalletHref, stateLabel, styleLabel, symbolChartHref,
  typeKind, typeLabel, validateAlertPrefsClient, watchSummaryText,
} from '../../../frontend/js/views/smartMoneyFormat.js';

const EVM = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const EVM_MIXED = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const q = (s) => new URLSearchParams(s);

describe('Smart Money UI — konstanta selaras kontrak', () => {
  it('UNIT-SM-UI-001 salinan konstanta frontend identik dengan backend/smartmoney/contracts.js', () => {
    expect(CHAINS).toEqual([...contracts.CHAINS]);
    expect(EXPLORERS).toEqual({ ...contracts.EXPLORERS });
    expect(DISCLAIMERS).toEqual({ ...contracts.DISCLAIMERS });
    expect(RADAR_WINDOWS).toEqual(Object.keys(contracts.RADAR_WINDOWS));
    expect(RADAR_STATES).toEqual([...contracts.RADAR_STATES]);
    expect(TRADING_STYLES).toEqual([...contracts.TRADING_STYLES]);
    expect(ALERT_KINDS).toEqual([...contracts.ALERT_KINDS]);
    for (const t of contracts.ACTIVITY_TYPES) expect(typeLabel(t)).not.toBe(t.replaceAll('_', ' '));
  });

  it('UNIT-SM-UI-002 explorer URL sama dengan helper kontrak', () => {
    expect(explorerTxUrl('base', '0xabc')).toBe(contracts.explorerTxUrl('base', '0xabc'));
    expect(explorerAddressUrl('solana', SOL)).toBe(contracts.explorerAddressUrl('solana', SOL));
    expect(explorerAddressUrl('ethereum', EVM)).toBe(contracts.explorerAddressUrl('ethereum', EVM));
    expect(explorerTokenUrl('ethereum', 'native')).toBeNull();
    expect(explorerTokenUrl('bsc', EVM)).toBe(contracts.explorerTokenUrl('bsc', EVM));
    expect(explorerTxUrl('tron', '0xabc')).toBeNull();
  });

  it('UNIT-SM-UI-003 normalizeAddress mencerminkan kontrak (EVM huruf kecil, Solana peka huruf)', () => {
    for (const [chain, addr] of [['ethereum', EVM_MIXED], ['solana', SOL], ['base', 'bukan-alamat'], ['solana', EVM], ['tron', EVM]]) {
      expect(normalizeAddress(chain, addr)).toBe(contracts.normalizeAddress(chain, addr));
    }
  });
});

describe('Smart Money UI — format', () => {
  it('UNIT-SM-UI-010 shortAddress memendekkan alamat panjang, aman untuk nilai kosong', () => {
    expect(shortAddress(EVM)).toBe('0x6982…1933');
    expect(shortAddress(SOL, 4, 4)).toBe('EPjF…Dt1v');
    expect(shortAddress('0xabc')).toBe('0xabc');
    expect(shortAddress(null)).toBe(EMPTY);
    expect(shortAddress('')).toBe(EMPTY);
  });

  it('UNIT-SM-UI-011 formatUsdOrDash: null = tidak diketahui (—), BUKAN 0', () => {
    expect(formatUsdOrDash(null)).toBe(EMPTY);
    expect(formatUsdOrDash(undefined)).toBe(EMPTY);
    expect(formatUsdOrDash(Number.NaN)).toBe(EMPTY);
    expect(formatUsdOrDash(0)).toBe('$0');
    expect(formatUsdOrDash(512.3)).toBe('$512,3');
    expect(formatUsdOrDash(12_345)).toMatch(/^\$12,3\s?rb$/);
    expect(formatUsdOrDash(-2500, { signed: true })).toBe('-$2.500');
    expect(formatUsdOrDash(2500, { signed: true })).toBe('+$2.500');
    expect(formatUsdOrDash(0, { signed: true })).toBe('$0');
    expect(USD_UNKNOWN).toBe('nilai USD tidak diketahui');
    expect(signOf(null)).toBeNull();
    expect(signOf(-1)).toBe('down');
  });

  it('UNIT-SM-UI-012 persen, skor, dan komponen', () => {
    expect(formatSignedPct(12.5)).toBe('+12,5%');
    expect(formatSignedPct(-3)).toBe('-3%');
    expect(formatSignedPct(null)).toBe(EMPTY);
    expect(formatRatioPct(0.756)).toBe('76%');
    expect(formatRatioPct(1.4)).toBe('100%');
    expect(formatRatioPct(null)).toBe(EMPTY);
    expect(clampScore(104.2)).toBe(100);
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(null)).toBeNull();
    expect(componentPercent(0.42)).toBe(42);
    expect(componentPercent(-0.2)).toBe(20);
    expect(componentPercent(73)).toBe(73);
    expect(componentPercent(undefined)).toBeNull();
  });

  it('UNIT-SM-UI-013 typeLabel/typeKind: hanya swap bernada beli/jual; transfer/exchange/bridge/airdrop/LP terpisah', () => {
    expect(typeLabel('SWAP_BUY')).toBe('Swap beli');
    expect(typeLabel('CEX_WITHDRAWAL')).toBe('Penarikan exchange');
    expect(typeLabel('CEX_DEPOSIT')).toBe('Deposit ke exchange');
    expect(typeLabel('LP_ADD')).toBe('Tambah likuiditas');
    expect(typeLabel('FULL_EXIT')).toBe('Keluar penuh');
    expect(typeLabel('SOMETHING_NEW')).toBe('SOMETHING NEW');
    expect(typeLabel(null)).toBe(EMPTY);
    const buyish = contracts.ACTIVITY_TYPES.filter((t) => typeKind(t) === 'buy');
    const sellish = contracts.ACTIVITY_TYPES.filter((t) => typeKind(t) === 'sell');
    expect(buyish).toEqual(['SWAP_BUY']);
    expect(sellish).toEqual(['SWAP_SELL']);
    expect(new Set(['TRANSFER_IN', 'CEX_WITHDRAWAL', 'BRIDGE_IN', 'AIRDROP', 'LP_REMOVE'].map(typeKind)))
      .toEqual(new Set(['move', 'cex', 'bridge', 'airdrop', 'lp']));
  });

  it('UNIT-SM-UI-014 stateLabel, styleLabel, completeness, alert kind', () => {
    expect(stateLabel('ACCUMULATING')).toMatchObject({ label: 'Akumulasi', tone: 'bull' });
    expect(stateLabel('EXITING')).toMatchObject({ label: 'Keluar', tone: 'bear' });
    expect(stateLabel('X').label).toBe('X');
    expect(styleLabel('SCALPER')).toBe('Scalper');
    expect(styleLabel('???')).toBe('Tidak diketahui');
    expect(completenessLabel('PARTIAL')).toEqual({ label: 'Sebagian', tone: 'warn' });
    expect(completenessLabel(undefined).label).toBe('Tidak diketahui');
    expect(alertKindLabel('WALLET_EXIT')).toBe('Wallet keluar');
  });

  it('UNIT-SM-UI-015 matchBadge: hanya MATCHED dapat ditautkan; simbol sama tanpa kontrak = peringatan', () => {
    const matched = matchBadge({ status: 'MATCHED', futuresSymbol: '1000PEPEUSDT', multiplier: 1000, note: 'n' });
    expect(matched).toMatchObject({ status: 'MATCHED', label: '1000PEPEUSDT', tone: 'bull', linkable: true });
    expect(matched.text).toContain('1000');
    const symbolOnly = matchBadge({ status: 'SYMBOL_ONLY', futuresSymbol: null });
    expect(symbolOnly).toMatchObject({ tone: 'warn', linkable: false });
    expect(symbolOnly.text).toContain('Simbol sama, kontrak belum terverifikasi');
    expect(matchBadge({ status: 'AMBIGUOUS' }).linkable).toBe(false);
    expect(matchBadge({ status: 'NOT_LISTED' }).label).toBe('Tidak di Binance');
    expect(matchBadge(null).status).toBe('UNKNOWN');
  });

  it('UNIT-SM-UI-016 symbolChartHref hanya untuk MATCHED dengan simbol futures valid', () => {
    expect(symbolChartHref({ status: 'MATCHED', futuresSymbol: 'PEPEUSDT' })).toBe('#/symbol?s=PEPEUSDT&tf=15m&dir=LONG');
    expect(symbolChartHref({ status: 'SYMBOL_ONLY', futuresSymbol: 'PEPEUSDT' })).toBeNull();
    expect(symbolChartHref({ status: 'MATCHED', futuresSymbol: '<script>' })).toBeNull();
    expect(symbolChartHref({ status: 'MATCHED', futuresSymbol: null })).toBeNull();
  });

  it('UNIT-SM-UI-017 relevansi & label pola sinyal', () => {
    expect(relevanceLabel('TINGGI')).toMatchObject({ label: 'Relevansi tinggi', tone: 'bull' });
    expect(relevanceLabel('unknown').label).toBe('Tidak terhubung');
    expect(signalPatternLabels({ patterns: ['akumulasi volume progresif', ''] })).toEqual(['akumulasi volume progresif']);
    expect(signalPatternLabels({ classification: 'SA', state: 'BREAKOUT' })).toEqual(['SA · kenaikan perlahan volume rendah', 'breakout akumulasi']);
    const ordered = signalsByTimeframe({ signals: [{ timeframe: '1h' }, { timeframe: '5m' }, { timeframe: '4h' }, { timeframe: '15m' }] });
    expect(ordered.map((s) => s.timeframe)).toEqual(['5m', '15m', '1h']);
    expect(signalsByTimeframe(null)).toEqual([]);
  });

  it('UNIT-SM-UI-018 excludedSummary menyebut semua aktivitas yang tidak dihitung sebagai pembelian', () => {
    expect(excludedSummary({ transferIn: 2, cexWithdrawal: 1, bridge: 0, airdrop: 3, lp: 1, mint: 0 }))
      .toBe('tidak dihitung sebagai pembelian: transfer masuk 2, penarikan exchange 1, bridge 0, airdrop 3, LP 1');
    expect(excludedSummary({ mint: 4 })).toContain('mint 4');
    expect(excludedSummary(null)).toContain('transfer masuk 0');
  });

  it('UNIT-SM-UI-019 flag, label bersumber, klaster, bukti', () => {
    const f = flagInfo({ code: 'MARKET_MAKER', severity: 'HIGH', reason: 'Label Arkham', source: 'label:arkham' });
    expect(f).toEqual({ label: 'MM', tone: 'bear', title: 'Label Arkham · HIGH · sumber: label:arkham' });
    expect(flagInfo({ code: 'LOW_HISTORY', severity: 'MEDIUM' })).toMatchObject({ label: 'Riwayat pendek', tone: 'warn' });
    expect(flagInfo({ code: 'NEW_FLAG' }).label).toBe('NEW FLAG');
    expect(labelText({ label: 'Binance 14', source: 'etherscan-nametag' })).toBe('Binance 14 (sumber: etherscan-nametag)');
    expect(labelText({ label: 'Fund X' })).toBe('Fund X (tanpa sumber)');
    expect(labelText(null)).toBeNull();
    expect(clusterText(1)).toBe('mandiri');
    expect(clusterText(4)).toBe('terkait 3 wallet');
    expect(clusterText(null)).toBe('mandiri');
    expect(clusterReasonLabel('same-funder')).toBe('Pendana pertama sama');
    expect(clusterReasonLabel('co_trading')).toContain('Ko-trading');
    expect(clusterReasonLabel('weird_type')).toBe('weird type');
    expect(evidenceLines({ txs: 250, sample: ['0x1'], note: 'x'.repeat(200) })).toEqual(['txs: 250', 'sample: ["0x1"]', `note: ${'x'.repeat(157)}…`]);
    expect(evidenceLines(null)).toEqual([]);
    expect(watchSummaryText({ symbol: 'PEPE', conviction: 71.6, state: 'ACCUMULATING' })).toBe('PEPE · keyakinan 72 · Akumulasi');
    expect(watchSummaryText('teks')).toBe('teks');
    expect(watchSummaryText(null)).toBe('');
  });

  it('UNIT-SM-UI-020 tautan eksternal hanya https', () => {
    expect(safeExternalUrl('https://etherscan.io/tx/0x1')).toBe('https://etherscan.io/tx/0x1');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('http://etherscan.io')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});

describe('Smart Money UI — meta, route, query', () => {
  it('UNIT-SM-UI-030 metaStatus: simulasi, basi, tanpa provider; meta hilang dianggap basi', () => {
    const s = metaStatus({ simulated: true, dataAsOf: 1, lastSyncAt: 2, isStale: false, coverage: { chains: ['base'], wallets: 4, activities: 10 }, providersConfigured: 2 });
    expect(s).toMatchObject({ simulated: true, stale: false, noProvider: false, chains: ['base'], wallets: 4, providersConfigured: 2 });
    expect(metaStatus(undefined)).toMatchObject({ simulated: false, stale: true, noProvider: false, dataAsOf: null, chains: [] });
    expect(metaStatus({ providersConfigured: 0, isStale: true }).noProvider).toBe(true);
  });

  it('UNIT-SM-UI-031 keadaan "belum ada sumber data" hanya bila 0 provider DAN tanpa data', () => {
    expect(isNoSourceState({ providersConfigured: 0 }, 0)).toBe(true);
    expect(isNoSourceState({ providersConfigured: 0 }, 3)).toBe(false); // data lama tetap ditampilkan
    expect(isNoSourceState({ providersConfigured: 1 }, 0)).toBe(false);
    expect(isNoSourceState(undefined, 0)).toBe(false);
  });

  it('UNIT-SM-UI-032 disclaimersOf: teks server menang, cadangan lokal untuk yang hilang', () => {
    const d = disclaimersOf({ disclaimers: { conviction: 'X', simulated: '' } });
    expect(d.conviction).toBe('X');
    expect(d.simulated).toBe(DISCLAIMERS.simulated);
    expect(disclaimersOf(null)).toEqual({ ...DISCLAIMERS });
  });

  it('UNIT-SM-UI-033 parseEntityQuery: chain dikenal + alamat valid; token simbol sama dibedakan oleh kontrak', () => {
    expect(parseEntityQuery(q(`c=ethereum&a=${EVM_MIXED}`))).toEqual({ chain: 'ethereum', address: EVM, invalid: false });
    expect(parseEntityQuery(q(`c=solana&a=${SOL}`))).toEqual({ chain: 'solana', address: SOL, invalid: false });
    expect(parseEntityQuery(q(`c=tron&a=${EVM}`)).invalid).toBe(true);
    expect(parseEntityQuery(q('c=base&a=PEPE')).invalid).toBe(true);
    expect(parseEntityQuery(q('')).invalid).toBe(true);
    expect(smartTokenHref('base', EVM)).toBe(`#/smart-token?c=base&a=${EVM}`);
    expect(smartWalletHref('solana', SOL)).toBe(`#/smart-wallet?c=solana&a=${SOL}`);
    expect(smartTokenHref('base', EVM)).not.toBe(smartTokenHref('ethereum', EVM));
    expect(entityPath('wallets', 'ethereum', EVM)).toBe(`/api/smart-money/wallets/ethereum/${EVM}`);
    expect(parseTokenKey(`base:${EVM}`)).toEqual({ chain: 'base', address: EVM });
    expect(parseTokenKey('PEPE')).toBeNull();
    expect(parseTokenKey('tron:abc')).toBeNull();
  });

  it('UNIT-SM-UI-034 buildRadarQuery: nilai tidak valid diabaikan, jendela default 24h', () => {
    expect(buildRadarQuery({})).toBe('/api/smart-money/radar?window=24h&limit=100');
    expect(buildRadarQuery({ window: '4h', chain: 'base', minBuyers: '3', state: 'ACCUMULATING', linked: true }))
      .toBe('/api/smart-money/radar?window=4h&chain=base&minBuyers=3&state=ACCUMULATING&linked=true&limit=100');
    expect(buildRadarQuery({ window: '2d', chain: 'tron', minBuyers: '0', state: 'HOT', linked: false, limit: 9999 }))
      .toBe('/api/smart-money/radar?window=24h&limit=100');
    expect(buildRadarQuery({ minBuyers: '1;drop' })).toBe('/api/smart-money/radar?window=24h&limit=100');
    expect(parseRadarFilters(q('window=7d&chain=solana&minBuyers=5&state=EXITING&linked=true')))
      .toEqual({ window: '7d', chain: 'solana', minBuyers: '5', state: 'EXITING', linked: true });
    expect(parseRadarFilters(q('window=1y&chain=x&minBuyers=-1'))).toEqual({ window: '24h', chain: '', minBuyers: '', state: '', linked: false });
  });

  it('UNIT-SM-UI-035 buildWalletsQuery & buildAlertsQuery', () => {
    expect(buildWalletsQuery({ eligible: true, includeFlagged: false, style: 'SWING', minScore: '60', chain: 'arbitrum' }))
      .toBe('/api/smart-money/wallets?chain=arbitrum&eligible=true&style=SWING&minScore=60&limit=200');
    expect(buildWalletsQuery({ minScore: '', style: 'X', includeFlagged: true })).toBe('/api/smart-money/wallets?includeFlagged=true&limit=200');
    expect(buildWalletsQuery({ minScore: '101' })).toBe('/api/smart-money/wallets?limit=200');
    expect(buildAlertsQuery({ unread: true, kind: 'LARGE_SELL' })).toBe('/api/smart-money/alerts?unread=true&kind=LARGE_SELL&limit=100');
    expect(buildAlertsQuery({ kind: 'NOPE' })).toBe('/api/smart-money/alerts?limit=100');
  });
});

describe('Smart Money UI — preferensi notifikasi', () => {
  const valid = { kinds: ['NEW_BUY', 'LARGE_SELL'], minUsd: '1000', largeSellUsd: '10000', minWalletScore: '60', minIndependentBuyers: '3', cooldownHours: '6', watchlistOnly: false };

  it('UNIT-SM-UI-040 form valid → prefs server (cooldown jam → ms, urutan kinds kanonik)', () => {
    const { prefs, errors } = validateAlertPrefsClient({ ...valid, kinds: ['LARGE_SELL', 'NEW_BUY', 'NEW_BUY'] });
    expect(errors).toEqual({});
    expect(prefs).toEqual({ kinds: ['NEW_BUY', 'LARGE_SELL'], minUsd: 1000, largeSellUsd: 10000, minWalletScore: 60, minIndependentBuyers: 3, cooldownMs: 6 * 3_600_000, watchlistOnly: false });
    expect(validateAlertPrefsClient({ ...valid, cooldownHours: '0,5', watchlistOnly: 'on' }).prefs).toMatchObject({ cooldownMs: 1_800_000, watchlistOnly: true });
    expect(validateAlertPrefsClient({ ...valid, kinds: [] }).prefs.kinds).toEqual([]);
  });

  it('UNIT-SM-UI-041 nilai kosong/di luar batas/bukan bulat ditolak per field', () => {
    const { prefs, errors } = validateAlertPrefsClient({ ...valid, minUsd: '', largeSellUsd: '-5', minWalletScore: '101', minIndependentBuyers: '2.5', cooldownHours: 'abc', kinds: ['NEW_BUY', 'HACK'] });
    expect(prefs).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['cooldownHours', 'kinds', 'largeSellUsd', 'minIndependentBuyers', 'minUsd', 'minWalletScore']);
    expect(errors.minUsd).toMatch(/^Wajib diisi/);
    expect(errors.minIndependentBuyers).toMatch(/Bilangan bulat 1–50/);
    expect(errors.kinds).toContain('HACK');
    expect(validateAlertPrefsClient({ ...valid, minUsd: 'Infinity' }).errors.minUsd).toBeDefined();
    expect(validateAlertPrefsClient(null).prefs).toBeNull();
  });

  it('UNIT-SM-UI-042 prefsToForm membalik bentuk server; nilai hilang memakai default kontrak', () => {
    expect(prefsToForm({ kinds: ['WALLET_EXIT', 'BOGUS'], minUsd: 50, largeSellUsd: 5, minWalletScore: 70, minIndependentBuyers: 4, cooldownMs: 3_600_000, watchlistOnly: true }))
      .toEqual({ kinds: ['WALLET_EXIT'], minUsd: 50, largeSellUsd: 5, minWalletScore: 70, minIndependentBuyers: 4, cooldownHours: 1, watchlistOnly: true });
    expect(prefsToForm(undefined)).toEqual({ kinds: [...ALERT_KINDS], minUsd: 1000, largeSellUsd: 10000, minWalletScore: 60, minIndependentBuyers: 3, cooldownHours: 6, watchlistOnly: false });
  });

  it('UNIT-SM-UI-043 detail error 400 server dipetakan ke field form', () => {
    const mapped = mapServerPrefErrors(['minUsd harus ≥ 0', { field: 'prefs.cooldownMs', message: 'cooldown terlalu kecil' }, 'format tidak dikenal']);
    expect(mapped.fields).toEqual({ minUsd: 'minUsd harus ≥ 0', cooldownHours: 'cooldown terlalu kecil' });
    expect(mapped.general).toEqual(['format tidak dikenal']);
    expect(mapServerPrefErrors(undefined)).toEqual({ fields: {}, general: [] });
  });
});

describe('Smart Money UI — chip LONG Scanner', () => {
  const links = {
    PEPEUSDT: { tokenKey: `ethereum:${EVM}`, symbol: 'PEPE', chain: 'ethereum', independentBuyers: 4, conviction: 72.4, state: 'ACCUMULATING', lastActivityAt: 1 },
  };

  it('UNIT-SM-UI-050 screenerChipInfo: SM ×N, tooltip keyakinan & state, tautan detail token', () => {
    const chip = screenerChipInfo(links, 'PEPEUSDT');
    expect(chip.text).toBe('SM ×4');
    expect(chip.title).toContain('4 pembeli independen');
    expect(chip.title).toContain('keyakinan 72/100 (bukan probabilitas)');
    expect(chip.title).toContain('Akumulasi');
    expect(chip.href).toBe(`#/smart-token?c=ethereum&a=${EVM}`);
  });

  it('UNIT-SM-UI-051 tanpa data/simbol lain/peta rusak → tidak ada chip', () => {
    expect(screenerChipInfo(links, 'BTCUSDT')).toBeNull();
    expect(screenerChipInfo(null, 'PEPEUSDT')).toBeNull();
    expect(screenerChipInfo({ PEPEUSDT: null }, 'PEPEUSDT')).toBeNull();
    expect(screenerChipInfo(links, 'toString')).toBeNull();
    expect(screenerChipInfo({ X: { tokenKey: 'bad' } }, 'X')).toMatchObject({ text: 'SM ×0', href: null });
  });
});
