// Transport jaringan Binance: fetch (REST) dan WebSocket (stream kline) dengan pilihan DNS lewat BINANCE_DNS.
//   - 'doh' (default): undici Agent dengan `lookup` DoH khusus host Binance (doh.js). Di jaringan yang hanya
//     membajak DNS *.binance.com (diukur di Mac pemilik), scanner jalan tanpa WARP/VPN.
//   - 'system': fetch & WebSocket global Node apa adanya (perilaku sebelum DoH).
// Ini default createBinanceRestClient (fetch) dan createKlineStream (WebSocketImpl), jadi worker, server (sinkron
// Smart Money), backtest, dan replay ikut tanpa perubahan pemanggil. Tes selalu menginjeksi fetch/WebSocket palsu.
// undici dipin ke versi yang sama dengan undici bawaan Node; fetch & WebSocket undici selalu diberi dispatcher
// undici sendiri (tidak mencampur dengan dispatcher global Node).

import { Agent, WebSocket as UndiciWebSocket, fetch as undiciFetch } from 'undici';
import { createBinanceLookup, createDohResolver, parseBinanceDnsMode } from './doh.js';

/**
 * @param {{ mode?: string, logger?: { warn?: Function }, resolver?: { resolve4(hostname: string): Promise<string[]> } }} [options]
 *   - `mode`: 'doh' | 'system' (kosong → 'doh').
 *   - `resolver`: KHUSUS tes (resolver palsu); produksi memakai createDohResolver ke DEFAULT_DOH_ENDPOINTS.
 * @returns {{ mode: 'doh'|'system', resolvers: readonly string[], fetch: typeof globalThis.fetch,
 *   createWebSocket(url: string, protocols?: string | string[]): WebSocket, close(): Promise<void> }}
 */
export function createBinanceNetwork({ mode, logger, resolver } = {}) {
  const dnsMode = parseBinanceDnsMode(mode);
  if (dnsMode === 'system') {
    return Object.freeze({
      mode: dnsMode,
      resolvers: Object.freeze([]),
      fetch: (input, init) => globalThis.fetch(input, init),
      createWebSocket: (url, protocols) => new globalThis.WebSocket(url, protocols),
      close: async () => {},
    });
  }
  // Resolver DoH dipanggil lewat IP literal → tidak butuh DNS; dispatcher-nya terpisah dari lalu lintas Binance.
  const dohAgent = new Agent({ connections: 2 });
  const doh = resolver ?? createDohResolver({ fetch: (input, init) => undiciFetch(input, { ...init, dispatcher: dohAgent }) });
  const agent = new Agent({ connect: { lookup: createBinanceLookup({ resolver: doh, logger }) } });
  return Object.freeze({
    mode: dnsMode,
    resolvers: Object.freeze([...(doh.endpoints ?? [])]),
    fetch: (input, init = {}) => undiciFetch(input, { ...init, dispatcher: agent }),
    createWebSocket: (url, protocols) => new UndiciWebSocket(
      url,
      protocols === undefined ? { dispatcher: agent } : { protocols, dispatcher: agent },
    ),
    async close() {
      await Promise.allSettled([agent.close(), dohAgent.close()]);
    },
  });
}

let shared = null;

/** Transport bersama proses ini; dibuat saat pertama dipakai dari env BINANCE_DNS (default 'doh'). */
export function getBinanceNetwork() {
  if (shared === null) shared = createBinanceNetwork({ mode: process.env.BINANCE_DNS });
  return shared;
}

/**
 * Dipanggil entry point (worker, server) dengan mode yang sudah divalidasi loadConfig dan logger proses, agar
 * peringatan fallback DoH masuk log. Transport sebelumnya (bila ada) ditutup.
 * @param {Parameters<typeof createBinanceNetwork>[0]} options
 */
export function configureBinanceNetwork(options) {
  const previous = shared;
  shared = createBinanceNetwork(options);
  if (previous !== null) previous.close().catch(() => {});
  return shared;
}

/** fetch default klien REST Binance (restClient.js). */
export function binanceFetch(input, init) {
  return getBinanceNetwork().fetch(input, init);
}

/** Konstruktor WebSocket default stream kline (wsClient.js): `new BinanceWebSocket(url)`. */
export function BinanceWebSocket(url, protocols) {
  return getBinanceNetwork().createWebSocket(url, protocols);
}
