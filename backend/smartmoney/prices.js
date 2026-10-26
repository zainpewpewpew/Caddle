// Indeks harga tersirat dari swap — sumber `priceAt(tokenKey, t)` untuk evaluasi historis (docs/15 §2 `evaluate.js`)
// dan peta harga "terakhir diketahui" untuk PnL bila provider harga tidak tersedia. Fungsi murni: tanpa I/O, tanpa
// waktu sistem.
//
// ─── Aturan ─────────────────────────────────────────────────────────────────────────────────────────
// - Observasi HANYA dari Activity SWAP_BUY / SWAP_SELL dengan usdValue > 0 dan amount > 0 (angka hingga):
//   harga = usdValue / amount. Transfer, penarikan exchange, bridge, airdrop, mint, dan LP tidak pernah menjadi
//   harga. Duplikat Activity.id dihitung sekali (radar.dedupeActivities: urut blockTime, id).
// - Pencarian memakai observasi TERBARU dengan blockTime ≤ t — observasi setelah t tidak pernah dipakai.
//   Harganya = median semua observasi token pada detik UTC yang sama (floor(blockTime / 1000)) yang juga ≤ t,
//   untuk meredam pencilan (swap kecil dengan slippage ekstrem, nilai USD provider yang salah). Blok EVM/Solana
//   beresolusi detik, sehingga "detik yang sama" ≈ "blok yang sama". `at` = blockTime observasi terbaru itu.
// - Kedaluwarsa: bila t − at > maxStalenessMs → null (harga hilang), bukan harga lama yang dipakai diam-diam.
// - Identitas = tokenKey(chain, alamat kontrak); simbol tidak pernah dipakai.
// - Harga tersirat mengandung slippage & fee dan hanya ada saat token diperdagangkan wallet yang dilacak — cukup
//   untuk evaluasi kasar, bukan harga eksekusi. Untuk return ke depan, pilih maxStalenessMs < horizon terpendek
//   agar harga keluar benar-benar berasal dari setelah titik masuk.

import { tokenKey as makeTokenKey } from './contracts.js';
import { dedupeActivities } from './radar.js';

/** Batas kedaluwarsa default harga tersirat (HIPOTESIS AWAL — sesuaikan dengan horizon evaluasi). */
export const DEFAULT_MAX_STALENESS_MS = 3_600_000;
/** Nilai `source` pada harga tersirat. */
export const IMPLIED_PRICE_SOURCE = 'implied-swap';

const PRICE_TYPES = new Set(['SWAP_BUY', 'SWAP_SELL']);
const SECOND_MS = 1000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Indeks terakhir dengan times[i] ≤ t (−1 bila tidak ada). */
function lastAtOrBefore(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function isPriceObservation(a) {
  return Boolean(a) && typeof a === 'object' && PRICE_TYPES.has(a.type)
    && isNum(a.blockTime) && isNum(a.amount) && a.amount > 0 && isNum(a.usdValue) && a.usdValue > 0
    && typeof a.chain === 'string' && typeof a.token?.address === 'string';
}

/**
 * Bangun indeks harga tersirat dari swap.
 * @param {object[]} activities Activity[] (urutan bebas, boleh duplikat)
 * @param {{ maxStalenessMs?: number }} [opts] umur maksimum observasi terhadap t (ms; Infinity = tanpa batas)
 * @returns {{
 *   priceAt: (tokenKey: string, t: number) => number|null,
 *   pricesAt: (t: number) => Map<string, { priceUsd: number, at: number, source: string }>,
 *   observationAt: (tokenKey: string, t: number) => { priceUsd: number, at: number, source: string }|null,
 * }}
 */
export function buildImpliedPriceIndex(activities, { maxStalenessMs = DEFAULT_MAX_STALENESS_MS } = {}) {
  if (!Array.isArray(activities)) throw new TypeError('buildImpliedPriceIndex: activities harus array');
  if (typeof maxStalenessMs !== 'number' || Number.isNaN(maxStalenessMs) || maxStalenessMs < 0) {
    throw new RangeError('maxStalenessMs harus angka ≥ 0 (Infinity = tanpa batas)');
  }

  // tokenKey → observasi terurut (blockTime, id) dari dedupeActivities.
  const byToken = new Map();
  for (const a of dedupeActivities(activities.filter(isPriceObservation))) {
    const key = makeTokenKey(a.chain, a.token.address);
    let list = byToken.get(key);
    if (!list) {
      list = [];
      byToken.set(key, list);
    }
    list.push({ at: a.blockTime, price: a.usdValue / a.amount });
  }

  // Deret per token: satu titik per blockTime berbeda; harga = median observasi pada detik yang sama sampai titik
  // itu (inklusif). Pencarian selalu mendarat di titik terakhir ≤ t, sehingga observasi setelah t tidak terbaca.
  const series = new Map();
  for (const key of [...byToken.keys()].sort(cmp)) {
    const obs = byToken.get(key);
    const times = [];
    const prices = [];
    let second = null;
    let secondPrices = [];
    for (let i = 0; i < obs.length; i += 1) {
      const s = Math.floor(obs[i].at / SECOND_MS);
      if (s !== second) {
        second = s;
        secondPrices = [];
      }
      secondPrices.push(obs[i].price);
      if (i === obs.length - 1 || obs[i + 1].at !== obs[i].at) {
        times.push(obs[i].at);
        prices.push(median(secondPrices));
      }
    }
    series.set(key, { times, prices });
  }

  const observationAt = (tokenKey, t) => {
    if (!isNum(t)) throw new TypeError('t harus epoch ms (angka hingga)');
    const s = series.get(tokenKey);
    if (!s) return null;
    const i = lastAtOrBefore(s.times, t);
    if (i < 0 || t - s.times[i] > maxStalenessMs) return null;
    return { priceUsd: s.prices[i], at: s.times[i], source: IMPLIED_PRICE_SOURCE };
  };

  const priceAt = (tokenKey, t) => observationAt(tokenKey, t)?.priceUsd ?? null;

  const pricesAt = (t) => {
    const out = new Map();
    for (const key of series.keys()) {
      const o = observationAt(key, t);
      if (o) out.set(key, o);
    }
    return out;
  };

  return Object.freeze({ priceAt, pricesAt, observationAt });
}
