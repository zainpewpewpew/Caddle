// Dependensi tambahan sinkronisasi smart money di luar adapter provider: penilaian USD kaki koin native per jam dari
// klines Binance publik (tanpa kunci). Dipakai `npm run smart-money:sync` dan tombol "Sync sekarang" di server; worker
// scanner memakai klien REST miliknya sendiri (bobot API bersama dengan scanner).

import { createBinanceRestClient } from '../ingestion/binance/restClient.js';
import { createNativePriceResolver, enrichNativeUsd } from './nativePrices.js';

/**
 * Harga native per jam HANYA bila ada adapter live (data simulasi tidak pernah dinilai dengan harga live).
 * @param {{ list: () => Array<{ isSimulated?: boolean }> }} registry
 * @param {{ createRest?: () => { getKlines: Function } }} [options]
 * @returns {{ nativePrices: object|null, enrichNativeUsd: Function|null }}
 */
export function createSyncDeps(registry, { createRest = () => createBinanceRestClient() } = {}) {
  const live = registry.list().some((a) => a.isSimulated !== true);
  if (!live) return { nativePrices: null, enrichNativeUsd: null };
  const rest = createRest();
  return { nativePrices: createNativePriceResolver({ getKlines: (query) => rest.getKlines(query) }), enrichNativeUsd };
}
