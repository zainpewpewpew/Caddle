import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedReversalCandidates } from '../helpers/reversalSeed.js';
import { createTestApp, login } from '../helpers/testApp.js';

describe('API Reversal Radar — alur negatif', () => {
  let ctx;
  let auth;
  beforeEach(async () => {
    ctx = await createTestApp();
    auth = await login(ctx.app);
  });
  afterEach(async () => { await ctx.app.close(); });

  const get = (url) => ctx.app.inject({ url, headers: { cookie: auth.cookie } });

  it.each(['/api/reversal/candidates', '/api/reversal/history', '/api/reversal/candidates/1'])('NEG-RR-001 %s tanpa sesi → 401', async (url) => {
    const res = await ctx.app.inject({ url });
    expect(res.statusCode).toBe(401);
  });

  // Setiap filter: nilai di luar enum/pola ditolak di tepi API (bukan diabaikan diam-diam lalu mengembalikan semua baris).
  it.each([
    ['timeframe tidak didukung', '/api/reversal/candidates?timeframe=4h'],
    ['timeframe huruf besar', '/api/reversal/candidates?timeframe=5M'],
    ['timeframe kosong', '/api/reversal/candidates?timeframe='],
    ['stage tak dikenal', '/api/reversal/candidates?stage=BREAKOUT'],
    ['stage huruf kecil', '/api/reversal/candidates?stage=early_formation'],
    ['status terminal bukan filter aktif', '/api/reversal/candidates?status=CANCELLED'],
    ['status EXPIRED', '/api/reversal/candidates?status=EXPIRED'],
    ['status NONE', '/api/reversal/candidates?status=NONE'],
    ['liquidity ILLIQUID bukan kelas minimum', '/api/reversal/candidates?liquidity=ILLIQUID'],
    ['liquidity UNKNOWN', '/api/reversal/candidates?liquidity=UNKNOWN'],
    ['minScore di atas 100', '/api/reversal/candidates?minScore=101'],
    ['minScore negatif', '/api/reversal/candidates?minScore=-1'],
    ['minScore pecahan', '/api/reversal/candidates?minScore=45.5'],
    ['minScore nol di depan', '/api/reversal/candidates?minScore=07'],
    ['minScore kosong', '/api/reversal/candidates?minScore='],
    ['sensitivity huruf kecil', '/api/reversal/candidates?sensitivity=low'],
    ['sensitivity tak dikenal', '/api/reversal/candidates?sensitivity=ALL'],
    ['includeExtended bukan 0/1', '/api/reversal/candidates?includeExtended=2'],
    ['includeExtended boolean kata', '/api/reversal/candidates?includeExtended=true'],
    ['includeProvisional kosong', '/api/reversal/candidates?includeProvisional='],
    ['limit nol', '/api/reversal/candidates?limit=0'],
    ['limit > 500', '/api/reversal/candidates?limit=501'],
    ['limit bukan angka', '/api/reversal/candidates?limit=abc'],
    ['limit negatif', '/api/reversal/candidates?limit=-5'],
    ['parameter tak dikenal', '/api/reversal/candidates?sort=desc'],
    ['parameter ganda (array)', '/api/reversal/candidates?timeframe=5m&timeframe=1h'],
    ['riwayat: simbol huruf kecil', '/api/reversal/history?symbol=aaausdt'],
    ['riwayat: simbol injeksi SQL', "/api/reversal/history?symbol=AAA'%20OR%201=1--"],
    ['riwayat: simbol terlalu panjang', `/api/reversal/history?symbol=${'A'.repeat(31)}`],
    ['riwayat: simbol terlalu pendek', '/api/reversal/history?symbol=A'],
    ['riwayat: timeframe 1d', '/api/reversal/history?timeframe=1d'],
    ['riwayat: limit > 500', '/api/reversal/history?limit=501'],
    ['riwayat: parameter tak dikenal', '/api/reversal/history?stage=EARLY_FORMATION'],
    ['detail: id nol', '/api/reversal/candidates/0'],
    ['detail: id negatif', '/api/reversal/candidates/-1'],
    ['detail: id bukan angka', '/api/reversal/candidates/abc'],
    ['detail: id pecahan', '/api/reversal/candidates/1.5'],
    ['detail: id terlalu panjang', `/api/reversal/candidates/${'9'.repeat(17)}`],
  ])('NEG-RR-002 %s → 400 VALIDATION_ERROR', async (_label, url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });

  it('NEG-RR-003 id tidak ada → 404 NOT_FOUND (tanpa kebocoran detail); rute tak dikenal di bawah /api/reversal → 404 dengan sesi, 401 tanpa sesi', async () => {
    await seedReversalCandidates(ctx.app.services.repos, { withCandles: false });
    const res = await get('/api/reversal/candidates/999');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NOT_FOUND', message: 'Kandidat reversal tidak ditemukan' });
    expect((await get('/api/reversal/xyz')).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: '/api/reversal/xyz' })).statusCode).toBe(401);
  });

  it('NEG-RR-004 batas limit: 500 diterima API, repositori menolak > 500 (RangeError) dan filter tak dikenal (TypeError)', async () => {
    const { reversal } = ctx.app.services.repos;
    expect((await get('/api/reversal/candidates?limit=500')).statusCode).toBe(200);
    expect((await get('/api/reversal/history?limit=500')).statusCode).toBe(200);
    await expect(reversal.listActive({ limit: 501 })).rejects.toThrow(RangeError);
    await expect(reversal.history({ limit: 501 })).rejects.toThrow(RangeError);
    await expect(reversal.listActive({ sort: 'desc' })).rejects.toThrow(TypeError);
    await expect(reversal.getById(0)).rejects.toThrow(RangeError);
  });

  it('NEG-RR-005 metode selain GET ditolak (baca saja): penjaga CSRF (403) atau tanpa rute (404/405), tidak pernah 200', async () => {
    for (const url of ['/api/reversal/candidates', '/api/reversal/history', '/api/reversal/candidates/1']) {
      const res = await ctx.app.inject({ method: 'POST', url, headers: { cookie: auth.cookie }, payload: {} });
      expect([403, 404, 405]).toContain(res.statusCode);
    }
  });
});
