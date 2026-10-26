// Adapter Routescan — API kompatibel Etherscan per chain:
//   https://api.routescan.io/v2/network/mainnet/evm/{chainId}/etherscan/api
// Logika permintaan, pemetaan galat, kursor, dan konversi ada di etherscanCompatible.js (baca catatan di sana).
//
// Menurut docs/14 [sumber resmi via indeks pencarian]: tanpa kunci 2 panggilan/detik & 10.000/hari; kunci gratis
// 5/detik & 100.000/hari; kunci dikirim lewat HEADER `apikey`; 429 bila batas terlewati. Batas internal: 1,5/detik
// (tanpa maupun dengan kunci — cara pengiriman kunci belum terverifikasi live, jadi laju dibuat aman untuk mode
// tanpa kunci) dan 9.000/hari tanpa kunci atau 90.000/hari dengan kunci.
// Cakupan chain per chainId BELUM TERVERIFIKASI (daftar chain-ID mainnet tidak ditemukan di riset): chain yang tidak
// dilayani diperkirakan menjawab HTTP 404 atau pesan "not supported" → ProviderError NOT_SUPPORTED. Jalankan skrip
// cek di Mac pengguna untuk setiap chain sebelum diandalkan. Ketentuan atribusi juga belum terverifikasi.

import { EVM_CHAIN_IDS, createEtherscanCompatibleProvider } from './etherscanCompatible.js';

export const ROUTESCAN_PROVIDER_ID = 'routescan';
export const ROUTESCAN_DEFAULT_CHAINS = Object.freeze(['base', 'optimism', 'bsc', 'ethereum', 'arbitrum', 'polygon']);

export const ROUTESCAN_TERMS = Object.freeze({
  docsUrl: 'https://routescan.io/docs',
  attribution: 'Data riwayat transaksi: Routescan',
  displayAllowed: true,
  notes: 'API kompatibel Etherscan. Tanpa kunci: 2 panggilan/detik & 10.000/hari; kunci gratis: 5/detik & 100.000/hari. '
    + 'Batas internal adapter: 1,5 panggilan/detik; 9.000/hari tanpa kunci, 90.000/hari dengan kunci. '
    + 'Cakupan chain per chainId belum terverifikasi — wajib dicek dengan skrip cek sebelum diandalkan. '
    + 'Ketentuan atribusi belum terverifikasi.',
});

/** URL API kompatibel Etherscan Routescan untuk satu chain. */
export function routescanApiUrl(chain) {
  return `https://api.routescan.io/v2/network/mainnet/evm/${EVM_CHAIN_IDS[chain]}/etherscan/api`;
}

/**
 * @param {{ apiKey?: string|null, chains?: string[], fetchImpl?: typeof fetch, clock?: () => number,
 *   sleep?: (ms: number) => Promise<void> }} [options] tanpa apiKey = mode tanpa kunci (tetap terkonfigurasi)
 * @returns {object} adapter docs/15 §3 (kapabilitas 'walletTransfers') + `configured` + `quota()`
 */
export function createRoutescanProvider({ apiKey = null, chains = ROUTESCAN_DEFAULT_CHAINS, fetchImpl, clock, sleep } = {}) {
  const key = typeof apiKey === 'string' && apiKey.trim() !== '' ? apiKey.trim() : null;
  return createEtherscanCompatibleProvider({
    id: ROUTESCAN_PROVIDER_ID,
    displayName: 'Routescan',
    requiresKey: false,
    apiKey: key,
    keyMode: key === null ? null : 'header',
    chains,
    urlForChain: routescanApiUrl,
    fetchImpl,
    clock,
    sleep,
    ratePerSec: 1.5,
    dailyBudget: key === null ? 9_000 : 90_000,
    terms: ROUTESCAN_TERMS,
  });
}
