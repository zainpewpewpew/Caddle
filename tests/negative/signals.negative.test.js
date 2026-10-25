import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, login, TEST_ORIGIN } from '../helpers/testApp.js';

describe('API sinyal — alur negatif', () => {
  let ctx;
  let auth;
  beforeEach(async () => {
    ctx = await createTestApp();
    auth = await login(ctx.app);
  });
  afterEach(async () => { await ctx.app.close(); });

  it.each(['/api/signals/active', '/api/signals/history'])('NEG-SIG-001 %s tanpa sesi → 401', async (url) => {
    const res = await ctx.app.inject({ url });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['timeframe tidak didukung', '/api/signals/active?timeframe=4h'],
    ['state terminal bukan filter aktif', '/api/signals/active?state=INVALIDATED'],
    ['klasifikasi NONE', '/api/signals/active?classification=NONE'],
    ['minScore di atas 100', '/api/signals/active?minScore=101'],
    ['minScore negatif', '/api/signals/active?minScore=-1'],
    ['minScore pecahan', '/api/signals/active?minScore=85.5'],
    ['limit nol', '/api/signals/active?limit=0'],
    ['limit bukan angka', '/api/signals/active?limit=abc'],
    ['limit > 999', '/api/signals/active?limit=1000'],
    ['parameter tak dikenal', '/api/signals/active?sort=desc'],
    ['parameter ganda (array)', '/api/signals/active?timeframe=5m&timeframe=1h'],
    ['simbol huruf kecil', '/api/signals/history?symbol=btcusdt'],
    ['simbol injeksi SQL', "/api/signals/history?symbol=BTC'%20OR%201=1--"],
    ['simbol terlalu panjang', `/api/signals/history?symbol=${'A'.repeat(31)}`],
  ])('NEG-SIG-002 %s → 400 VALIDATION_ERROR', async (_label, url) => {
    const res = await ctx.app.inject({ url, headers: { cookie: auth.cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });

  // Setiap filter: nilai di luar enum/pola ditolak di tepi API (bukan diabaikan diam-diam lalu mengembalikan semua baris).
  it.each([
    ['timeframe kosong', '/api/signals/active?timeframe='],
    ['timeframe huruf besar', '/api/signals/active?timeframe=5M'],
    ['timeframe 1d', '/api/signals/active?timeframe=1d'],
    ['klasifikasi huruf kecil', '/api/signals/active?classification=sa'],
    ['klasifikasi kosong', '/api/signals/active?classification='],
    ['state NO_PATTERN', '/api/signals/active?state=NO_PATTERN'],
    ['state EXPIRED', '/api/signals/active?state=EXPIRED'],
    ['state huruf kecil', '/api/signals/active?state=quiet'],
    ['minScore kosong', '/api/signals/active?minScore='],
    ['minScore nol di depan', '/api/signals/active?minScore=07'],
    ['minScore bukan angka', '/api/signals/active?minScore=abc'],
    ['minScore eksponen', '/api/signals/active?minScore=1e2'],
    ['limit kosong', '/api/signals/active?limit='],
    ['limit negatif', '/api/signals/active?limit=-5'],
    ['limit pecahan', '/api/signals/active?limit=2.5'],
    ['limit nol di depan', '/api/signals/active?limit=010'],
    ['history limit nol', '/api/signals/history?limit=0'],
    ['history limit bukan angka', '/api/signals/history?limit=abc'],
    ['history parameter filter aktif', '/api/signals/history?timeframe=5m'],
  ])('NEG-SIG-004 %s → 400 VALIDATION_ERROR', async (_label, url) => {
    const res = await ctx.app.inject({ url, headers: { cookie: auth.cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });

  it.each(['POST', 'PUT', 'DELETE'])('NEG-SIG-003 %s ke endpoint sinyal (baca saja) → 404', async (method) => {
    const res = await ctx.app.inject({
      method, url: '/api/signals/active',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken, origin: TEST_ORIGIN }, payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
