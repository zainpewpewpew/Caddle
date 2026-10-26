// API Insider / Smart Money Radar — masukan tidak valid & sumber daya tidak ada (docs/15 §4–§5).
// Query tidak dikoersi (AJV coerceTypes: false): angka/boolean di luar pola → 400, tidak dipotong diam-diam.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_PREFS } from '../../backend/smartmoney/alerts.js';
import { ALERT_KINDS } from '../../backend/smartmoney/contracts.js';
import { SM, createSmartMoneyApp, session } from '../helpers/smartMoneyApi.js';

const EVM_OK = `0x${'ab'.repeat(20)}`;

describe('API Smart Money — validasi query & path', () => {
  let ctx;
  let s;
  let exp;
  beforeAll(async () => {
    ctx = await createSmartMoneyApp();
    s = await session(ctx.app);
    exp = ctx.scenario.expectations;
  });
  afterAll(async () => { await ctx.app.close(); });

  const expect400 = async (url) => {
    const res = await s.get(url);
    expect(res.statusCode, url).toBe(400);
    expect(res.json(), url).toMatchObject({ error: 'VALIDATION_ERROR', message: 'Input tidak valid', details: expect.any(Array) });
    return res.json();
  };

  it('NEG-SM-API-001 query radar di luar kontrak → 400 (jendela, chain, minBuyers, state, linked, limit, parameter asing)', async () => {
    for (const q of [
      'window=2h', 'window=24H', 'chain=bitcoin', 'chain=ETHEREUM', 'minBuyers=0', 'minBuyers=101', 'minBuyers=2.5', 'minBuyers=-1',
      'state=PUMPING', 'linked=yes', 'linked=1', 'limit=0', 'limit=501', 'limit=abc', 'limit=1e2', 'foo=bar', 'window=24h&window=7d',
    ]) {
      await expect400(`${SM}/radar?${q}`);
    }
  });

  it('NEG-SM-API-002 query wallets/alerts di luar kontrak → 400', async () => {
    for (const q of ['minScore=101', 'minScore=-5', 'minScore=50.5', 'eligible=1', 'eligible=TRUE', 'style=HODLER', 'includeFlagged=yes', 'limit=501', 'chain=sol']) {
      await expect400(`${SM}/wallets?${q}`);
    }
    for (const q of ['kind=BUY', 'unread=1', 'limit=0', 'limit=1001', 'userId=2']) {
      await expect400(`${SM}/alerts?${q}`);
    }
    for (const path of ['/status', '/screener-links', '/evaluation', '/watchlist', '/alert-prefs']) {
      await expect400(`${SM}${path}?x=1`);
    }
  });

  it('NEG-SM-API-003 alamat tidak valid untuk chain → 400 dengan path /address; chain tak dikenal → 400', async () => {
    const bad = [
      ['ethereum', '0x123'], ['ethereum', `0x${'zz'.repeat(20)}`], ['ethereum', `${EVM_OK}00`], ['base', 'vitalik.eth'],
      // Base58 tidak memakai 0, O, I, l.
      ['solana', `0OIl${'1'.repeat(36)}`], ['solana', EVM_OK],
    ];
    for (const [chain, address] of bad) {
      for (const kind of ['wallets', 'tokens']) {
        const body = await expect400(`${SM}/${kind}/${chain}/${encodeURIComponent(address)}`);
        expect(body.details).toEqual([{ path: '/address', message: `Alamat tidak valid untuk chain ${chain}` }]);
      }
    }
    // 'native' sah sebagai token, tidak sebagai wallet.
    await expect400(`${SM}/wallets/ethereum/native`);
    const unknownChain = await expect400(`${SM}/wallets/bitcoin/${EVM_OK}`);
    expect(unknownChain.details[0].path).toBe('/chain');
    await expect400(`${SM}/tokens/tron/${EVM_OK}`);
    await expect400(`${SM}/wallets/ethereum/${'a'.repeat(100)}`);
  });

  it('NEG-SM-API-004 wallet tidak dilacak / token tanpa aktivitas → 404 NOT_FOUND (tanpa data rekaan)', async () => {
    const wallet = await s.get(`${SM}/wallets/ethereum/${EVM_OK}`);
    expect(wallet.statusCode).toBe(404);
    expect(wallet.json()).toEqual({ error: 'NOT_FOUND', message: 'Wallet tidak dilacak' });
    const token = await s.get(`${SM}/tokens/ethereum/${EVM_OK}`);
    expect(token.statusCode).toBe(404);
    expect(token.json().error).toBe('NOT_FOUND');
    // Wallet dilacak di ethereum tidak otomatis ada di chain lain.
    expect((await s.get(`${SM}/wallets/base/${exp.tka.repeatBuyer}`)).statusCode).toBe(404);
    expect((await s.get(`${SM}/api-yang-tidak-ada`)).statusCode).toBe(404);
  });
});

describe('API Smart Money — validasi mutasi', () => {
  let ctx;
  let s;
  let exp;
  beforeEach(async () => {
    ctx = await createSmartMoneyApp();
    s = await session(ctx.app);
    exp = ctx.scenario.expectations;
  });
  afterEach(async () => { await ctx.app.close(); });

  it('NEG-SM-API-005 body watchlist tidak valid → 400 dan tidak ada yang tersimpan', async () => {
    const valid = { kind: 'WALLET', chain: 'ethereum', address: exp.tka.repeatBuyer };
    const cases = [
      [{}, null],
      [{ kind: 'WALLET', chain: 'ethereum' }, null],
      [{ ...valid, kind: 'NFT' }, null],
      [{ ...valid, chain: 'bitcoin' }, null],
      [{ ...valid, extra: 1 }, null],
      [{ ...valid, note: 'x'.repeat(201) }, null],
      [{ ...valid, note: 5 }, null],
      [{ ...valid, address: 123 }, null],
      [{ ...valid, address: '0x123' }, '/address'],
      [{ ...valid, address: 'native' }, '/address'],
      [{ kind: 'TOKEN', chain: 'solana', address: EVM_OK }, '/address'],
    ];
    for (const [payload, path] of cases) {
      const res = await s.send('POST', `${SM}/watchlist`, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toBe('VALIDATION_ERROR');
      if (path) expect(res.json().details[0].path).toBe(path);
    }
    expect((await s.send('POST', `${SM}/watchlist`, [])).statusCode).toBe(400);
    expect((await s.send('POST', `${SM}/watchlist`)).statusCode).toBe(400);
    // Hanya JSON yang diterima (text/plain tidak punya parser).
    expect((await s.send('POST', `${SM}/watchlist`, 'teks')).statusCode).toBe(415);
    expect((await s.get(`${SM}/watchlist`)).json().items).toEqual([]);
    expect((await ctx.app.services.repos.audit.recent(50)).some((a) => a.action.startsWith('smartmoney.'))).toBe(false);
  });

  it('NEG-SM-API-006 hapus item watchlist yang tidak ada → 404; body tidak valid → 400', async () => {
    const res = await s.send('DELETE', `${SM}/watchlist`, { kind: 'TOKEN', chain: 'ethereum', address: exp.tka.address });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NOT_FOUND', message: 'Item watchlist tidak ditemukan' });
    expect((await s.send('DELETE', `${SM}/watchlist`, { kind: 'TOKEN', chain: 'ethereum', address: exp.tka.address, note: 'x' })).statusCode).toBe(400);
    expect((await s.send('DELETE', `${SM}/watchlist`, { kind: 'WALLET', chain: 'ethereum', address: 'native' })).statusCode).toBe(400);
    expect((await s.send('DELETE', `${SM}/watchlist`)).statusCode).toBe(400);
  });

  it('NEG-SM-API-007 POST /alerts/read: tepat satu dari { ids } atau { all: true }', async () => {
    for (const payload of [
      {}, { ids: [] }, { ids: [0] }, { ids: [-1] }, { ids: ['1'] }, { ids: [1.5] }, { ids: 1 }, { all: false }, { all: 'true' },
      { all: true, ids: [1] }, { ids: Array.from({ length: 1001 }, (_, i) => i + 1) }, { userId: 2, ids: [1] },
    ]) {
      const res = await s.send('POST', `${SM}/alerts/read`, payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
    expect((await s.get(`${SM}/alerts`)).json().unread).toBe(1);
  });

  it('NEG-SM-API-008 preferensi tidak valid → 400 dengan detail per field (Bahasa Indonesia) dan tidak disimpan', async () => {
    const res = await s.send('PUT', `${SM}/alert-prefs`, {
      prefs: {
        minUsd: -1, largeSellUsd: 1e13, minWalletScore: 101, minIndependentBuyers: 1.5, cooldownMs: 1000,
        kinds: ['NEW_BUY', 'NEW_BUY', 'PUMP'], watchlistOnly: 'ya', rahasia: true,
      },
    });
    expect(res.statusCode).toBe(400);
    const { error, details } = res.json();
    expect(error).toBe('VALIDATION_ERROR');
    const byField = Object.fromEntries(details.filter((d) => d.field).map((d) => [d.field, d]));
    for (const field of ['minUsd', 'largeSellUsd', 'minWalletScore', 'minIndependentBuyers', 'cooldownMs', 'kinds', 'watchlistOnly']) {
      expect(byField[field], field).toMatchObject({ path: `/prefs/${field}`, message: expect.stringContaining(field === 'kinds' ? '' : field) });
    }
    expect(details).toContainEqual({ path: '/prefs/rahasia', message: 'Preferensi tidak dikenal: rahasia' });
    expect((await s.get(`${SM}/alert-prefs`)).json()).toEqual({ prefs: { ...DEFAULT_ALERT_PREFS, kinds: [...ALERT_KINDS] }, isDefault: true });
    expect((await ctx.app.services.repos.audit.recent(50)).some((a) => a.action === 'smartmoney.alertPrefs.update')).toBe(false);
  });

  it('NEG-SM-API-009 amplop preferensi tidak valid → 400 (tanpa prefs, bukan objek, properti asing)', async () => {
    for (const payload of [{}, { prefs: [] }, { prefs: 'x' }, { prefs: null }, { prefs: {}, extra: 1 },
      { prefs: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])) }]) {
      expect((await s.send('PUT', `${SM}/alert-prefs`, payload)).statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
    }
    // Objek kosong valid: semua field memakai default.
    expect((await s.send('PUT', `${SM}/alert-prefs`, { prefs: {} })).json()).toEqual({
      prefs: { ...DEFAULT_ALERT_PREFS, kinds: [...ALERT_KINDS] }, isDefault: false,
    });
  });

  it('NEG-SM-API-010 watchlist penuh (500 item) → 409 WATCHLIST_LIMIT; item yang sudah ada tetap dapat diperbarui', async () => {
    const tokens = Array.from({ length: 500 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    for (const address of tokens) await ctx.repo.addToWatchlist(s.userId, { kind: 'TOKEN', chain: 'ethereum', address });
    const res = await s.send('POST', `${SM}/watchlist`, { kind: 'WALLET', chain: 'ethereum', address: exp.tka.repeatBuyer });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('WATCHLIST_LIMIT');
    const again = await s.send('POST', `${SM}/watchlist`, { kind: 'TOKEN', chain: 'ethereum', address: tokens[0], note: 'diperbarui' });
    expect(again.statusCode).toBe(201);
    expect(again.json().note).toBe('diperbarui');
  });
});
