import { describe, expect, it } from 'vitest';
import { BinanceDataError } from '../../../backend/ingestion/binance/errors.js';
import { parseFundingRates } from '../../../backend/ingestion/binance/parse.js';
import { createBinanceRestClient } from '../../../backend/ingestion/binance/restClient.js';

// Respons SINTETIS dari fetch palsu — tidak ada request jaringan sungguhan.
const T0 = Date.UTC(2025, 0, 1);

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

function clientWith(body) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return response(200, body);
  };
  const client = createBinanceRestClient({ fetch, clock: () => T0, sleep: async () => {}, random: () => 0.5, maxRetries: 0 });
  return { client, calls };
}

describe('parseFundingRates', () => {
  it('UNIT-FUN-001 desimal bertanda → number, diurutkan naik menurut fundingTime', () => {
    const rows = parseFundingRates([
      { symbol: 'BTCUSDT', fundingTime: T0 + 8 * 3_600_000, fundingRate: '-0.00012345', markPrice: '' },
      { symbol: 'BTCUSDT', fundingTime: T0, fundingRate: '0.00010000', markPrice: '94000.1' },
    ], { symbol: 'BTCUSDT' });
    expect(rows).toEqual([
      { symbol: 'BTCUSDT', fundingTime: T0, fundingRate: 0.0001 },
      { symbol: 'BTCUSDT', fundingTime: T0 + 8 * 3_600_000, fundingRate: -0.00012345 },
    ]);
  });

  it('UNIT-FUN-002 respons rusak atau untuk simbol lain ditolak utuh (BinanceDataError), tidak dibuang diam-diam', () => {
    expect(() => parseFundingRates({ code: -1 })).toThrow(BinanceDataError);
    expect(() => parseFundingRates([{ symbol: 'BTCUSDT', fundingTime: 'x', fundingRate: '0.0001' }])).toThrow(BinanceDataError);
    expect(() => parseFundingRates([{ symbol: 'BTCUSDT', fundingTime: T0, fundingRate: '1e-4' }])).toThrow(BinanceDataError);
    expect(() => parseFundingRates([{ symbol: 'ETHUSDT', fundingTime: T0, fundingRate: '0.0001' }], { symbol: 'BTCUSDT' }))
      .toThrow(BinanceDataError);
  });
});

describe('createBinanceRestClient.getFundingRates', () => {
  it('UNIT-FUN-003 GET /fapi/v1/fundingRate dengan parameter tervalidasi; hasil terparse', async () => {
    const { client, calls } = clientWith([{ symbol: 'ETHUSDT', fundingTime: T0, fundingRate: '0.00005000' }]);
    const rows = await client.getFundingRates({ symbol: 'ETHUSDT', startTime: T0, endTime: T0 + 1000, limit: 500 });
    expect(rows).toEqual([{ symbol: 'ETHUSDT', fundingTime: T0, fundingRate: 0.00005 }]);
    const { url, init } = calls[0];
    expect(url.origin + url.pathname).toBe('https://fapi.binance.com/fapi/v1/fundingRate');
    expect(Object.fromEntries(url.searchParams)).toEqual({ symbol: 'ETHUSDT', startTime: String(T0), endTime: String(T0 + 1000), limit: '500' });
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('UNIT-FUN-004 input tidak valid ditolak sebelum request', async () => {
    const { client, calls } = clientWith([]);
    await expect(client.getFundingRates({ symbol: 'eth/usdt' })).rejects.toThrow(TypeError);
    await expect(client.getFundingRates({ symbol: 'ETHUSDT', limit: 0 })).rejects.toThrow(RangeError);
    await expect(client.getFundingRates({ symbol: 'ETHUSDT', limit: 1001 })).rejects.toThrow(RangeError);
    await expect(client.getFundingRates({ symbol: 'ETHUSDT', startTime: 10, endTime: 5 })).rejects.toThrow(RangeError);
    await expect(client.getFundingRates({ symbol: 'ETHUSDT', startTime: -1 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});
