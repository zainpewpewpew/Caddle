// Adapter Etherscan API V2 — riwayat transfer wallet EVM (satu kunci untuk banyak chain lewat parameter `chainid`).
// Logika permintaan, pemetaan galat, kursor, dan konversi ada di etherscanCompatible.js (baca catatan di sana).
//
// Paket gratis yang dipilih pengguna (ditempel 2026-10-26): "Personal & Research use, 3 calls/second limit, up to
// 100,000 API calls/day, Selected chains (90% coverage), Community endpoints only". Batas internal sengaja di bawah
// batas resmi: 2 panggilan/detik & 90.000/hari. Chain di luar paket gratis dijawab provider dengan pesan
// "not supported … upgrade … plan" → ProviderError NOT_SUPPORTED (registri/sinkronisasi dapat beralih ke Routescan).
// Menurut docs/14, BNB Chain (56) berbayar dan Base/Optimism kemungkinan berbayar [sumber sekunder] — karena itu
// default chain = ethereum, arbitrum, polygon. Daftar persisnya BELUM terverifikasi live: cek dengan skrip cek.
// Tanpa kunci API adapter tetap valid (status "belum dikonfigurasi"), tetapi fetchWalletTransfers melempar
// NOT_CONFIGURED tanpa menyentuh jaringan. Kunci dikirim sebagai query `apikey` (dokumentasi Etherscan) dan selalu
// disamarkan dari pesan error/diagnostik.

import { EVM_CHAIN_IDS, createEtherscanCompatibleProvider } from './etherscanCompatible.js';

export const ETHERSCAN_PROVIDER_ID = 'etherscan';
export const ETHERSCAN_API_URL = 'https://api.etherscan.io/v2/api';
export const ETHERSCAN_DEFAULT_CHAINS = Object.freeze(['ethereum', 'arbitrum', 'polygon']);

export const ETHERSCAN_TERMS = Object.freeze({
  docsUrl: 'https://docs.etherscan.io',
  attribution: 'Data riwayat transaksi: Etherscan API (Powered by Etherscan)',
  displayAllowed: true,
  notes: 'Paket gratis: penggunaan pribadi & riset, 3 panggilan/detik, 100.000/hari, chain terpilih, endpoint komunitas saja. '
    + 'Batas internal adapter: 2 panggilan/detik & 90.000/hari.',
});

/**
 * @param {{ apiKey?: string|null, chains?: string[], fetchImpl?: typeof fetch, clock?: () => number,
 *   sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {object} adapter docs/15 §3 (kapabilitas 'walletTransfers') + `configured` + `quota()`
 */
export function createEtherscanProvider({ apiKey = null, chains = ETHERSCAN_DEFAULT_CHAINS, fetchImpl, clock, sleep } = {}) {
  return createEtherscanCompatibleProvider({
    id: ETHERSCAN_PROVIDER_ID,
    displayName: 'Etherscan API V2',
    requiresKey: true,
    apiKey,
    keyMode: 'query',
    chains,
    urlForChain: (chain) => `${ETHERSCAN_API_URL}?chainid=${EVM_CHAIN_IDS[chain]}`,
    fetchImpl,
    clock,
    sleep,
    ratePerSec: 2,
    dailyBudget: 90_000,
    terms: ETHERSCAN_TERMS,
  });
}
