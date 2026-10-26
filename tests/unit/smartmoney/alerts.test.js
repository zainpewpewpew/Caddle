import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_PREFS, deriveAlerts, filterAlerts, validateAlertPrefs } from '../../../backend/smartmoney/alerts.js';
import { ALERT_KINDS, tokenKey, walletKey } from '../../../backend/smartmoney/contracts.js';
import { buildAccumulationRadar } from '../../../backend/smartmoney/radar.js';
import { HOUR, PEPE, PEPE_FAKE, T0, act, addr, scores } from './radarAlertFixtures.js';

const NOW = T0 + 24 * HOUR;
const W = [addr(11), addr(12), addr(13), addr(14)];
const PEPE_KEY = tokenKey('ethereum', PEPE.address);
const WS = scores([[W[0], 80], [W[1], 75], [W[2], 70], [W[3], 40]]);
const wk = (a) => walletKey('ethereum', a);
const radarOf = (activities, now = NOW) => buildAccumulationRadar({ activities, walletScores: WS, now, windowMs: 24 * HOUR });

function derive({ activities = [], radar = [], watchWallets = [], watchTokens = [], positions = new Map(), now = NOW } = {}, prefs) {
  return deriveAlerts({
    activities, radar, watchlist: { wallets: new Set(watchWallets.map(wk)), tokens: new Set(watchTokens) },
    walletScores: WS, positions, now,
  }, prefs);
}
const kinds = (alerts) => alerts.map((a) => a.kind);
const pos = (wallet, qtyBefore, qtyAfter, tKey = PEPE_KEY) => new Map([[wk(wallet), new Map([[tKey, { qtyBefore, qtyAfter }]])]]);

describe('deriveAlerts', () => {
  it('UNIT-SM-ALR-001 NEW_BUY: wallet berkualitas beli swap ≥ minUsd; teks memuat wallet, simbol, kontrak, USD, explorer', () => {
    const buy = act({ wallet: W[0], at: NOW - HOUR, usd: 5000 });
    const alerts = derive({ activities: [buy], radar: radarOf([buy]) });
    expect(kinds(alerts)).toEqual(['NEW_BUY']);
    const [a] = alerts;
    expect(a.title).toContain('0x0000…000b');
    expect(a.title).toContain('PEPE');
    expect(a.title).toContain('0x0000…aaa1');
    expect(a.message).toContain('$5.000');
    expect(a.message).toContain('kontrak 0x0000…aaa1');
    expect(a.evidence.explorerUrls).toEqual([buy.explorerUrl]);
    expect(a.evidence.txHashes).toEqual([buy.txHash]);
    expect(a.evidence.tokenUrl).toBe(`https://etherscan.io/token/${PEPE.address}`);
    expect(a).toMatchObject({ chain: 'ethereum', tokenKey: PEPE_KEY, wallet: W[0], createdAt: NOW, usd: 5000, walletScore: 80 });
    expect(a.dedupeKey).toBe(`NEW_BUY:${PEPE_KEY}:${W[0]}:${Math.floor((NOW - HOUR) / DEFAULT_ALERT_PREFS.cooldownMs)}`);
  });

  it('UNIT-SM-ALR-002 NEW_BUY tidak memicu: di bawah minUsd, sudah memegang, sudah beli sebelumnya, wallet dikecualikan, bukan swap', () => {
    const small = act({ wallet: W[0], at: NOW - HOUR, usd: 500 });
    expect(derive({ activities: [small] })).toEqual([]);
    const buy = act({ wallet: W[0], at: NOW - HOUR, usd: 5000 });
    expect(derive({ activities: [buy], positions: pos(W[0], 100, 200) })).toEqual([]);
    const earlier = act({ wallet: W[0], at: NOW - 5 * HOUR, usd: 5000 });
    expect(kinds(derive({ activities: [buy], radar: radarOf([earlier, buy]) }))).not.toContain('NEW_BUY');
    const unscored = act({ wallet: addr(99), at: NOW - HOUR, usd: 50_000 });
    expect(derive({ activities: [unscored] })).toEqual([]);
    const withdrawal = act({ wallet: W[0], type: 'CEX_WITHDRAWAL', at: NOW - HOUR, usd: 50_000 });
    expect(derive({ activities: [withdrawal] })).toEqual([]);
    // dua beli dalam satu batch → hanya satu NEW_BUY
    const b2 = act({ wallet: W[0], at: NOW - 30 * 60_000, usd: 5000 });
    expect(kinds(derive({ activities: [buy, b2] }))).toEqual(['NEW_BUY']);
  });

  it('UNIT-SM-ALR-003 REPEAT_ACCUMULATION: ≥ 3 beli token sama di jendela; 2 beli tidak', () => {
    const buys = [1, 2, 3].map((h) => act({ wallet: W[1], at: NOW - h * HOUR, usd: 3000 }));
    const radar = radarOf(buys);
    const alerts = derive({ activities: [buys[0]], radar });
    expect(kinds(alerts)).toEqual(['REPEAT_ACCUMULATION']);
    expect(alerts[0].title).toContain('3×');
    expect(alerts[0].message).toContain('$9.000');
    expect(kinds(derive({ activities: [buys[0]], radar: radarOf(buys.slice(0, 2)) }))).toEqual([]);
  });

  it('UNIT-SM-ALR-004 MULTI_WALLET_BUY: klaster independen ≥ minIndependentBuyers', () => {
    const buys = [W[0], W[1], W[2]].map((w, i) => act({ wallet: w, at: NOW - (i + 1) * HOUR, usd: 2000 }));
    const alerts = derive({ radar: radarOf(buys) });
    expect(kinds(alerts)).toEqual(['MULTI_WALLET_BUY']);
    expect(alerts[0].wallet).toBeNull();
    expect(alerts[0].dedupeKey).toMatch(new RegExp(`^MULTI_WALLET_BUY:${PEPE_KEY}:\\*:\\d+$`));
    expect(alerts[0].title).toContain('3 wallet independen');
    expect(alerts[0].evidence.explorerUrls).toHaveLength(3);
    expect(derive({ radar: radarOf(buys.slice(0, 2)) })).toEqual([]);
  });

  it('UNIT-SM-ALR-005 LARGE_SELL: swap jual ≥ largeSellUsd; jual kecil / deposit exchange tidak', () => {
    const big = act({ wallet: W[0], type: 'SWAP_SELL', at: NOW - HOUR, usd: 15_000 });
    const small = act({ wallet: W[1], type: 'SWAP_SELL', at: NOW - HOUR, usd: 5000 });
    const dep = act({ wallet: W[2], type: 'CEX_DEPOSIT', at: NOW - HOUR, usd: 50_000 });
    const alerts = derive({ activities: [big, small, dep] });
    expect(kinds(alerts)).toEqual(['LARGE_SELL']);
    expect(alerts[0].message).toContain('$15.000');
    expect(alerts[0].severity).toBe('HIGH');
  });

  it('UNIT-SM-ALR-006 WALLET_EXIT: teks swap ("dijual") berbeda dengan deposit exchange ("belum tentu dijual")', () => {
    const sell = act({ wallet: W[0], type: 'SWAP_SELL', at: NOW - HOUR, usd: 8000, amount: 950 });
    const swapExit = derive({ activities: [sell], watchWallets: [W[0]], positions: pos(W[0], 1000, 50) }).find((a) => a.kind === 'WALLET_EXIT');
    expect(swapExit.message).toContain('dijual via swap');
    expect(swapExit.message).not.toContain('belum tentu');
    expect(swapExit.message).toContain('95%');

    const dep = act({ wallet: W[0], type: 'CEX_DEPOSIT', at: NOW - HOUR, usd: 8000, amount: 1000 });
    const cexExit = derive({ activities: [dep], watchWallets: [W[0]], positions: pos(W[0], 1000, 0) }).find((a) => a.kind === 'WALLET_EXIT');
    expect(cexExit.message).toContain('dipindah ke exchange, belum tentu dijual');
    expect(cexExit.title).toContain('memindahkan ke exchange');
    expect(cexExit.severity).toBe('MEDIUM');

    // tidak dipantau / turun < 90 % / hanya transfer biasa → tidak ada WALLET_EXIT
    expect(kinds(derive({ activities: [dep], positions: pos(W[0], 1000, 0) }))).not.toContain('WALLET_EXIT');
    expect(kinds(derive({ activities: [dep], watchWallets: [W[0]], positions: pos(W[0], 1000, 200) }))).not.toContain('WALLET_EXIT');
    const out = act({ wallet: W[0], type: 'TRANSFER_OUT', at: NOW - HOUR, amount: 1000 });
    expect(kinds(derive({ activities: [out], watchWallets: [W[0]], positions: pos(W[0], 1000, 0) }))).not.toContain('WALLET_EXIT');
  });

  it('UNIT-SM-ALR-007 simbol sama kontrak berbeda → alert terpisah dengan kontrak berbeda di judul', () => {
    const a1 = act({ wallet: W[0], token: PEPE, at: NOW - HOUR, usd: 5000 });
    const a2 = act({ wallet: W[0], token: PEPE_FAKE, at: NOW - HOUR, usd: 5000 });
    const alerts = derive({ activities: [a1, a2] });
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((a) => a.title)).size).toBe(2);
    expect(alerts.some((a) => a.title.includes('0x0000…bbb2'))).toBe(true);
  });
});

describe('filterAlerts & dedupe', () => {
  it('UNIT-SM-ALR-008 run berulang dalam satu ember cooldown → dedupe; ember baru → muncul lagi', () => {
    const buys = [3, 2, 1].map((h) => act({ wallet: W[1], at: NOW - h * HOUR, usd: 3000 }));
    const run1 = filterAlerts(derive({ activities: buys, radar: radarOf(buys) }), {});
    expect(kinds(run1)).toEqual(['NEW_BUY', 'REPEAT_ACCUMULATION']);
    const existing = new Set(run1.map((a) => a.dedupeKey));
    // run ulang dengan input sama → semua sudah ada
    expect(filterAlerts(derive({ activities: buys, radar: radarOf(buys) }), { existingKeys: existing })).toEqual([]);
    // pembelian ke-4 masih dalam ember cooldown yang sama → REPEAT tidak dikirim lagi
    const cd = DEFAULT_ALERT_PREFS.cooldownMs;
    const bucketEnd = (Math.floor((NOW - HOUR) / cd) + 1) * cd;
    const sameBucket = act({ wallet: W[1], at: Math.min(NOW, bucketEnd - 1), usd: 3000 });
    const all4 = [...buys, sameBucket];
    const run2 = filterAlerts(derive({ activities: [sameBucket], radar: radarOf(all4, Math.max(NOW, sameBucket.blockTime)), now: Math.max(NOW, sameBucket.blockTime) }), { existingKeys: existing });
    expect(run2).toEqual([]);
    // pembelian setelah cooldown (ember baru) → REPEAT muncul lagi
    const later = act({ wallet: W[1], at: bucketEnd + 60_000, usd: 3000 });
    const now3 = later.blockTime + 60_000;
    const run3 = filterAlerts(derive({ activities: [later], radar: radarOf([...all4, later], now3), now: now3 }), { existingKeys: existing });
    expect(kinds(run3)).toEqual(['REPEAT_ACCUMULATION']);
    expect(existing.has(run3[0].dedupeKey)).toBe(false);
  });

  it('UNIT-SM-ALR-009 watchlistOnly hanya meloloskan wallet/token yang dipantau', () => {
    const a1 = act({ wallet: W[0], at: NOW - HOUR, usd: 5000 });
    const a2 = act({ wallet: W[1], at: NOW - HOUR, usd: 5000, token: PEPE_FAKE });
    const alerts = derive({ activities: [a1, a2], watchWallets: [W[1]] });
    expect(alerts).toHaveLength(2);
    const prefs = { watchlistOnly: true };
    expect(filterAlerts(alerts, { prefs }).map((a) => a.wallet)).toEqual([W[1]]);
    const byToken = derive({ activities: [a1, a2], watchTokens: [PEPE_KEY] });
    expect(filterAlerts(byToken, { prefs }).map((a) => a.tokenKey)).toEqual([PEPE_KEY]);
  });

  it('UNIT-SM-ALR-010 filter minUsd & minWalletScore; wallet dipantau lolos minWalletScore', () => {
    const big = act({ wallet: W[0], at: NOW - HOUR, usd: 5000 });
    const mid = act({ wallet: W[1], at: NOW - HOUR, usd: 1500, token: PEPE_FAKE });
    const alerts = derive({ activities: [big, mid] });
    expect(filterAlerts(alerts, { prefs: { minUsd: 2000 } }).map((a) => a.wallet)).toEqual([W[0]]);
    expect(filterAlerts(alerts, { prefs: { minWalletScore: 78 } }).map((a) => a.wallet)).toEqual([W[0]]);
    // wallet skor rendah (40, tetap eligible) hanya lolos bila dipantau
    const low = act({ wallet: W[3], at: NOW - HOUR, usd: 5000 });
    expect(filterAlerts(derive({ activities: [low] }), {})).toEqual([]);
    expect(filterAlerts(derive({ activities: [low], watchWallets: [W[3]] }), {})).toHaveLength(1);
  });

  it('UNIT-SM-ALR-011 jenis yang dimatikan dibuang; duplikat dalam satu daftar dibuang', () => {
    const buy = act({ wallet: W[0], at: NOW - HOUR, usd: 5000 });
    const sell = act({ wallet: W[1], type: 'SWAP_SELL', at: NOW - HOUR, usd: 20_000, token: PEPE_FAKE });
    const alerts = derive({ activities: [buy, sell] });
    expect(kinds(alerts)).toEqual(['NEW_BUY', 'LARGE_SELL']);
    expect(kinds(filterAlerts(alerts, { prefs: { kinds: ['LARGE_SELL'] } }))).toEqual(['LARGE_SELL']);
    expect(filterAlerts([...alerts, ...alerts], {})).toHaveLength(2);
  });

  it('UNIT-SM-ALR-012 validateAlertPrefs menolak nilai buruk', () => {
    expect(validateAlertPrefs(DEFAULT_ALERT_PREFS)).toEqual([]);
    expect(validateAlertPrefs({})).toEqual([]);
    expect(DEFAULT_ALERT_PREFS.kinds).toEqual([...ALERT_KINDS]);
    expect(validateAlertPrefs(null)).toHaveLength(1);
    expect(validateAlertPrefs({ kinds: ['NEW_BUY', 'XXX'] })[0]).toContain('XXX');
    expect(validateAlertPrefs({ kinds: ['NEW_BUY', 'NEW_BUY'] })).toHaveLength(1);
    expect(validateAlertPrefs({ minUsd: -1 })).toHaveLength(1);
    expect(validateAlertPrefs({ minUsd: Number.NaN })).toHaveLength(1);
    expect(validateAlertPrefs({ minWalletScore: 101 })).toHaveLength(1);
    expect(validateAlertPrefs({ minIndependentBuyers: 1.5 })).toHaveLength(1);
    expect(validateAlertPrefs({ cooldownMs: 10 })).toHaveLength(1);
    expect(validateAlertPrefs({ watchlistOnly: 'ya' })).toHaveLength(1);
    expect(validateAlertPrefs({ foo: 1 })[0]).toContain('foo');
    expect(() => deriveAlerts({ activities: [], now: NOW }, { cooldownMs: 0 })).toThrow(RangeError);
    expect(() => filterAlerts([], { prefs: { minUsd: -5 } })).toThrow(RangeError);
  });
});
