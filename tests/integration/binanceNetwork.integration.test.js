// Tes integrasi transport Binance (backend/ingestion/binance/network.js) dengan undici ASLI.
//
// Server HTTP/WebSocket lokal di 127.0.0.1 berperan sebagai "Binance": resolver DoH palsu memetakan host Binance ke
// 127.0.0.1, sehingga tes membuktikan `lookup` DoH benar-benar dipakai fetch & WebSocket undici (nama host asli tetap
// dikirim di header Host) — tanpa jaringan sungguhan. Mode 'system' dan default klien REST/WS juga diperiksa.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureBinanceNetwork, createBinanceNetwork } from '../../backend/ingestion/binance/network.js';
import { createBinanceRestClient } from '../../backend/ingestion/binance/restClient.js';
import { createKlineStream } from '../../backend/ingestion/binance/wsClient.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Server lokal: HTTP menjawab JSON; upgrade WebSocket menjawab handshake lalu mengirim satu frame teks "halo". */
async function startFakeBinance() {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    requests.push({ host: req.headers.host, url: req.url });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ serverTime: 1_700_000_000_000 }));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket) => {
    requests.push({ host: req.headers.host, url: req.url, upgrade: true });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${WS_GUID}`).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    const payload = Buffer.from('halo');
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => { server.close(resolve); });
    },
  };
}

const cleanups = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  while (cleanups.length) await cleanups.pop()();
});

describe('transport Binance mode doh (undici + lookup DoH)', () => {
  it('INT-DOH-001 fetch ke host Binance memakai alamat dari resolver DoH; header Host tetap nama asli', async () => {
    const fake = await startFakeBinance();
    const resolver = { endpoints: ['resolver-uji'], resolve4: vi.fn(async () => ['127.0.0.1']) };
    const network = createBinanceNetwork({ mode: 'doh', resolver });
    cleanups.push(() => fake.close(), () => network.close());

    expect(network.mode).toBe('doh');
    expect(network.resolvers).toEqual(['resolver-uji']);
    const res = await network.fetch(`http://fapi.binance.com:${fake.port}/fapi/v1/time`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ serverTime: 1_700_000_000_000 });
    expect(resolver.resolve4).toHaveBeenCalledWith('fapi.binance.com');
    expect(fake.requests[0]).toEqual({ host: `fapi.binance.com:${fake.port}`, url: '/fapi/v1/time' });

    // IP literal tidak lewat DoH.
    const direct = await network.fetch(`http://127.0.0.1:${fake.port}/ping`);
    expect(direct.status).toBe(200);
    expect(resolver.resolve4).toHaveBeenCalledTimes(1);
  });

  it('INT-DOH-002 WebSocket ke host Binance tersambung lewat resolver DoH dan menerima pesan', async () => {
    const fake = await startFakeBinance();
    const resolver = { resolve4: vi.fn(async () => ['127.0.0.1']) };
    const network = createBinanceNetwork({ mode: 'doh', resolver });
    cleanups.push(() => fake.close(), () => network.close());

    const socket = network.createWebSocket(`ws://fstream.binance.com:${fake.port}/market/stream?streams=btcusdt@kline_15m`);
    const data = await new Promise((resolve, reject) => {
      socket.addEventListener('message', (ev) => resolve(ev.data));
      socket.addEventListener('error', () => reject(new Error('WebSocket error')));
    });
    expect(data).toBe('halo');
    expect(resolver.resolve4).toHaveBeenCalledWith('fstream.binance.com');
    expect(fake.requests.find((r) => r.upgrade)).toMatchObject({ host: `fstream.binance.com:${fake.port}` });
    socket.close();
  });
});

describe('transport Binance mode system & default klien', () => {
  it('INT-DOH-003 mode system meneruskan ke fetch & WebSocket global apa adanya', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    class FakeWebSocket {
      constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols;
      }
    }
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const network = createBinanceNetwork({ mode: 'system' });
    await network.fetch('https://fapi.binance.com/fapi/v1/time', { method: 'GET' });
    expect(fetchSpy).toHaveBeenCalledWith('https://fapi.binance.com/fapi/v1/time', { method: 'GET' });
    expect(network.createWebSocket('wss://fstream.binance.com/market')).toBeInstanceOf(FakeWebSocket);
    expect(network.resolvers).toEqual([]);
    expect(() => createBinanceNetwork({ mode: 'warp' })).toThrow(/BINANCE_DNS/);
  });

  it('INT-DOH-004 klien REST & stream kline tanpa injeksi memakai transport Binance bersama', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ serverTime: 1_700_000_000_000 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const opened = [];
    class FakeWebSocket {
      constructor(url) { opened.push(url); }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    configureBinanceNetwork({ mode: 'system' });

    const rest = createBinanceRestClient({ maxRetries: 0 });
    expect(await rest.getServerTime()).toBe(1_700_000_000_000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/fapi\.binance\.com\/fapi\/v1\/time/),
      expect.objectContaining({ redirect: 'error' }),
    );

    const stream = createKlineStream({ streams: [{ symbol: 'BTCUSDT', timeframe: '15m' }], onCandle: () => {} });
    stream.start();
    stream.stop();
    expect(opened[0]).toMatch(/^wss:\/\/fstream\.binance\.com\/market/);
  });
});
