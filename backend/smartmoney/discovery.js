// Penyaringan & peringkat kandidat wallet hasil penemuan provider (kontrak docs/15-kontrak-smart-money.md §2
// `discovery.js`). Fungsi murni: tanpa I/O, tanpa waktu sistem.
//
// Aturan:
// - Alamat & chain dinormalisasi (contracts.normalizeAddress); chain tak dikenal / alamat tidak valid / ZERO_ADDRESS
//   / 'native' dibuang.
// - Alamat berlabel bersumber dengan kategori cex, cex_deposit, dex_router, dex_pool, bridge, atau contract dibuang
//   (cex_deposit ditambahkan di luar daftar kontrak karena alamat deposit exchange juga bukan wallet trader).
// - Alamat yang sudah dilacak (`existing`: Set/array walletKey `chain:alamat` atau objek { chain, address }) dibuang.
// - Duplikat (chain + alamat) digabung: `source`/`reason` dari kemunculan pertama dipertahankan, semua sumber dicatat
//   di `sources` (tambahan di luar kontrak).
// - Peringkat: jumlah sumber penemuan berbeda (turun), lalu urutan kemunculan pertama (stabil).

import { NATIVE_TOKEN, ZERO_ADDRESS, isChain, normalizeAddress, walletKey } from './contracts.js';

export const EXCLUDED_DISCOVERY_CATEGORIES = Object.freeze(['cex', 'cex_deposit', 'dex_router', 'dex_pool', 'bridge', 'contract']);

function labelsFor(labels, chain, address) {
  if (!labels) return [];
  let raw;
  if (labels instanceof Map) raw = labels.get(walletKey(chain, address));
  else if (Array.isArray(labels)) raw = labels.filter((l) => l && l.chain === chain && normalizeAddress(chain, l.address) === address);
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter((l) => l && typeof l.source === 'string' && l.source.trim() !== '');
}

function existingKeys(existing) {
  const keys = new Set();
  if (!existing) return keys;
  for (const e of existing) {
    if (typeof e === 'string') {
      const i = e.indexOf(':');
      const chain = e.slice(0, i);
      const addr = i > 0 ? normalizeAddress(chain, e.slice(i + 1)) : null;
      keys.add(addr ? walletKey(chain, addr) : e);
    } else if (e && typeof e === 'object') {
      const addr = normalizeAddress(e.chain, e.address);
      if (addr) keys.add(walletKey(e.chain, addr));
    }
  }
  return keys;
}

/**
 * Saring & urutkan kandidat wallet.
 * @param {Array<{ chain: string, address: string, source?: string, reason?: string }>} candidates
 * @param {{ labels?: Map<string, object>|object[], existing?: Set<string>|Array<string|{ chain: string, address: string }> }} [opts]
 * @returns {Array<{ chain: string, address: string, source: string|null, reason: string|null, sources: string[] }>}
 */
export function rankCandidates(candidates, { labels, existing } = {}) {
  const skip = existingKeys(existing);
  const merged = new Map();
  let order = 0;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || !isChain(c.chain)) continue;
    const address = normalizeAddress(c.chain, c.address);
    if (!address || address === NATIVE_TOKEN || address === ZERO_ADDRESS) continue;
    const key = walletKey(c.chain, address);
    if (skip.has(key)) continue;
    if (labelsFor(labels, c.chain, address).some((l) => EXCLUDED_DISCOVERY_CATEGORIES.includes(l.category))) continue;
    const source = typeof c.source === 'string' && c.source !== '' ? c.source : null;
    const prev = merged.get(key);
    if (prev) {
      if (source && !prev.sources.includes(source)) prev.sources.push(source);
      continue;
    }
    merged.set(key, {
      chain: c.chain, address, source, reason: typeof c.reason === 'string' ? c.reason : null,
      sources: source ? [source] : [], order: order++,
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.sources.length - a.sources.length || a.order - b.order)
    .map(({ order: _o, ...rest }) => rest);
}
