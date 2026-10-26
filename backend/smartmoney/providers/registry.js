// Registri provider smart money: memilih adapter yang AKTIF dari daftar adapter yang tersedia berdasarkan
// konfigurasi (SMART_MONEY_PROVIDERS). Registri tidak pernah menambahkan adapter sendiri — termasuk fixture
// provider (data simulasi): fixture hanya aktif bila pemanggil memberikannya secara eksplisit di `adapters`
// DAN id-nya ada di `enabledIds`.

import { validateAdapter } from './adapter.js';

/**
 * @param {{ adapters?: object[], enabledIds?: string[] }} options
 * @returns {{ list: () => object[], get: (id: string) => object|null, withCapability: (cap: string, chain?: string) => object[],
 *   missing: () => string[] }}
 */
export function createProviderRegistry({ adapters = [], enabledIds = [] } = {}) {
  const available = new Map();
  for (const adapter of adapters) {
    const problems = validateAdapter(adapter);
    if (problems.length > 0) throw new TypeError(`Adapter provider tidak valid (${adapter?.id ?? '?'}): ${problems.join('; ')}`);
    if (available.has(adapter.id)) throw new RangeError(`Id provider ganda: ${adapter.id}`);
    available.set(adapter.id, adapter);
  }
  const ids = [...new Set(enabledIds)];
  // Urutan aktif mengikuti urutan konfigurasi (prioritas).
  const enabled = Object.freeze(ids.filter((id) => available.has(id)).map((id) => available.get(id)));
  const missing = Object.freeze(ids.filter((id) => !available.has(id)));

  return {
    /** Adapter aktif sesuai urutan konfigurasi. */
    list: () => [...enabled],
    /** Adapter aktif berdasarkan id, atau null bila tidak aktif / tidak ada. */
    get: (id) => enabled.find((a) => a.id === id) ?? null,
    /** Adapter aktif yang memiliki kapabilitas tertentu (dan mendukung chain bila diberikan). */
    withCapability: (cap, chain) => enabled.filter((a) => a.capabilities.has(cap) && (chain === undefined || a.chains.includes(chain))),
    /** Id yang dikonfigurasi tetapi tidak memiliki adapter (dilaporkan NOT_CONFIGURED di status). */
    missing: () => [...missing],
  };
}
