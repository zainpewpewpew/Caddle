// Provider FIXTURE (data simulasi). Hanya untuk tes, E2E, dan mode demo eksplisit — tidak pernah aktif default
// (registri tidak menambahkannya sendiri). Semua data yang dilayani bertanda isSimulated & provider 'fixture'.
//
// Injeksi kegagalan/kondisi untuk menguji ketahanan sinkronisasi:
// - `failWith`: 'UNAVAILABLE' | 'RATE_LIMITED' | 'TIMEOUT' | ... → setiap metode melempar ProviderError tersebut
//   (dapat diubah saat berjalan lewat `setFailure`).
// - `delayMs`: jeda sebelum menjawab; menghormati `signal` (dibatalkan → ProviderError TIMEOUT).
// - `lateTransfers`: daftar kunci `chain:txHash:logIndex` (atau `true` = scenario.expectations.lateTransferKeys)
//   yang DITAHAN pada panggilan pertama fetchWalletTransfers per wallet dan baru dikirim pada panggilan
//   berikutnya — meniru data terlambat (blockTime lama yang muncul di batch berikutnya, tanpa memandang `since`).

import { DISCLAIMERS, PROVIDER_ERROR_CODES } from '../contracts.js';
import { ProviderError } from './errors.js';

export const FIXTURE_PROVIDER_ID = 'fixture';
const DEFAULT_PAGE_SIZE = 500;
const RATE_LIMIT_RETRY_MS = 60_000;

const transferKey = (t) => `${t.chain}:${t.txHash}:${t.logIndex}`;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('TIMEOUT', 'fixture: permintaan dibatalkan', { provider: FIXTURE_PROVIDER_ID }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new ProviderError('TIMEOUT', 'fixture: permintaan dibatalkan', { provider: FIXTURE_PROVIDER_ID }));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {{ rawTransfers: object[], labels?: object[], prices?: object[], binanceMap?: object[], candidates?: object[],
 *   now?: number, expectations?: { lateTransferKeys?: string[] } }} scenario hasil buildScenario()
 * @param {{ failWith?: string|null, delayMs?: number, lateTransfers?: string[]|boolean, pageSize?: number }} [options]
 */
export function createFixtureProvider(scenario, { failWith = null, delayMs = 0, lateTransfers = [], pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const transfers = scenario.rawTransfers ?? [];
  const lateKeys = new Set(lateTransfers === true ? scenario.expectations?.lateTransferKeys ?? [] : lateTransfers || []);
  const chains = [...new Set([
    ...transfers.map((t) => t.chain), ...(scenario.labels ?? []).map((l) => l.chain), ...(scenario.candidates ?? []).map((c) => c.chain),
  ])].sort();
  const asOf = scenario.now ?? transfers.reduce((m, t) => Math.max(m, t.blockTime), 0);
  const calls = new Map();
  let failure = null;

  function setFailure(code) {
    if (code !== null && !PROVIDER_ERROR_CODES.includes(code)) throw new RangeError(`Kode kegagalan fixture tidak dikenal: ${code}`);
    failure = code;
  }
  setFailure(failWith);

  async function guard(signal) {
    if (delayMs > 0) await sleep(delayMs, signal);
    if (failure !== null) {
      throw new ProviderError(failure, `fixture: kegagalan simulasi (${failure})`, {
        provider: FIXTURE_PROVIDER_ID, retryAfterMs: failure === 'RATE_LIMITED' ? RATE_LIMIT_RETRY_MS : null,
      });
    }
  }

  const byChainAddress = (rows, chain, addresses, field = 'address') => {
    const set = addresses ? new Set(addresses) : null;
    return rows.filter((r) => r.chain === chain && (set === null || set.has(r[field])));
  };

  return {
    id: FIXTURE_PROVIDER_ID,
    displayName: 'Fixture (data simulasi)',
    requiresKey: false,
    isSimulated: true,
    chains: chains.length ? chains : ['ethereum'],
    capabilities: new Set(['walletTransfers', 'labels', 'prices', 'walletDiscovery', 'binanceMapping']),
    terms: { docsUrl: null, attribution: null, displayAllowed: true, notes: DISCLAIMERS.simulated },

    /** Kegagalan simulasi saat berjalan (null = normal). */
    setFailure,

    /**
     * Transfer yang melibatkan `address` (from/to), blockTime ≥ `since`, terurut kanonik, dipaginasi kursor
     * `b<batch>:o<offset>`. Batch = urutan panggilan tanpa kursor per wallet. Kunci `lateTransfers` ditahan pada
     * batch 0 dan dikirim pada setiap batch berikutnya walau blockTime-nya < `since` (data terlambat → dedupe).
     */
    async fetchWalletTransfers({ chain, address, since = null, cursor = null, signal } = {}) {
      await guard(signal);
      const walletId = `${chain}:${address}`;
      let batch;
      let offset = 0;
      if (cursor === null) {
        batch = calls.get(walletId) ?? 0;
        calls.set(walletId, batch + 1);
      } else {
        const m = /^b(\d+):o(\d+)$/.exec(cursor);
        if (!m) throw new ProviderError('BAD_RESPONSE', 'fixture: kursor tidak dikenal', { provider: FIXTURE_PROVIDER_ID });
        batch = Number(m[1]);
        offset = Number(m[2]);
      }
      const isLate = (t) => lateKeys.has(transferKey(t));
      const rows = transfers
        .filter((t) => t.chain === chain && (t.from === address || t.to === address))
        .filter((t) => (batch === 0 ? !isLate(t) && (since === null || t.blockTime >= since) : isLate(t) || since === null || t.blockTime >= since))
        .sort((a, b) => a.blockTime - b.blockTime || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0) || a.logIndex - b.logIndex);
      const page = rows.slice(offset, offset + pageSize);
      const nextCursor = offset + pageSize < rows.length ? `b${batch}:o${offset + pageSize}` : null;
      return { transfers: page.map((t) => structuredClone(t)), nextCursor, asOf };
    },

    async fetchLabels({ chain, addresses, signal } = {}) {
      await guard(signal);
      return byChainAddress(scenario.labels ?? [], chain, addresses).map((l) => ({ ...l }));
    },

    async fetchPrices({ chain, addresses, signal } = {}) {
      await guard(signal);
      return byChainAddress(scenario.prices ?? [], chain, addresses).map((p) => ({ ...p }));
    },

    async discoverWallets({ chain, limit = 100, signal } = {}) {
      await guard(signal);
      return (scenario.candidates ?? []).filter((c) => c.chain === chain).slice(0, limit).map((c) => ({ ...c }));
    },

    async fetchBinanceMapping({ signal } = {}) {
      await guard(signal);
      return (scenario.binanceMap ?? []).map((r) => ({ ...r }));
    },
  };
}
