// Normalisasi & dedupe RawTransfer (kontrak docs/15-kontrak-smart-money.md §1–§2 `normalize.js`).
// Fungsi murni: tanpa I/O, tanpa waktu sistem. Masukan berasal dari adapter provider (bisa lebih dari satu provider
// untuk wallet yang sama), keluaran menjadi masukan classify.js.
//
// Aturan:
// - Chain harus salah satu CHAINS; hash & alamat dinormalisasi lewat helper contracts.js (EVM huruf kecil, Solana
//   apa adanya — peka huruf besar/kecil). Masukan tidak valid DITOLAK dengan alasan Bahasa Indonesia, tidak diperbaiki
//   diam-diam.
// - ZERO_ADDRESS diterima sebagai `from`/`to` di semua chain (penanda mint/burn kanonik, termasuk Solana yang tidak
//   memiliki alamat nol — adapter memetakan mint/burn ke ZERO_ADDRESS).
// - `usdValue` yang bukan angka hingga ≥ 0 dianggap tidak diketahui (null), bukan alasan penolakan: jumlah token tetap
//   valid walau harga dari provider rusak. Nilai USD tidak pernah diganti 0.
// - Field txMeta yang tidak valid menjadi null (txMeta opsional).
// - Dedupe berdasarkan (chain, txHash, logIndex) lintas provider: baris PERTAMA (urutan masukan) dipertahankan. Bila
//   baris pertama tidak punya `usdValue` (null) dan duplikat berikutnya punya, nilai USD (beserta `priceSource`)
//   diisi dari duplikat tersebut — identitas transfer sama, sehingga melengkapi harga tidak mengubah fakta on-chain.
//   Field txMeta yang null pada baris pertama juga dilengkapi dari duplikat dengan alasan yang sama.
// - Urutan keluaran: blockTime, lalu txHash, lalu logIndex (sort stabil).

import { CHAINS, NATIVE_TOKEN, ZERO_ADDRESS, isChain, normalizeAddress, normalizeTxHash } from './contracts.js';

/** Kategori provider yang dikenali di txMeta.providerCategory (selain itu → null). */
export const PROVIDER_CATEGORIES = Object.freeze(['swap', 'transfer', 'airdrop', 'bridge', 'deposit', 'withdraw', 'lp', 'mint']);

const TX_META_FIELDS = Object.freeze(['initiator', 'toContract', 'method', 'providerCategory', 'dex']);

const isNil = (v) => v === null || v === undefined;

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Alamat wallet/lawan: ZERO_ADDRESS selalu diterima; NATIVE_TOKEN bukan alamat akun. */
function normalizeParty(chain, address) {
  if (typeof address === 'string' && address.trim().toLowerCase() === ZERO_ADDRESS) return ZERO_ADDRESS;
  const a = normalizeAddress(chain, address);
  return a === NATIVE_TOKEN ? null : a;
}

function normalizeTxMeta(chain, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const category = nonEmptyString(m.providerCategory)?.toLowerCase() ?? null;
  return {
    initiator: isNil(m.initiator) ? null : normalizeParty(chain, m.initiator),
    toContract: isNil(m.toContract) ? null : normalizeParty(chain, m.toContract),
    method: nonEmptyString(m.method),
    providerCategory: PROVIDER_CATEGORIES.includes(category) ? category : null,
    dex: nonEmptyString(m.dex),
  };
}

/**
 * Validasi & normalisasi satu RawTransfer.
 * @returns {{ transfer: object } | { reason: string }}
 */
function normalizeOne(raw) {
  if (!raw || typeof raw !== 'object') return { reason: 'Masukan bukan objek transfer' };
  const { chain } = raw;
  if (!isChain(chain)) return { reason: `Chain tidak dikenal: ${String(chain)} (harus salah satu dari ${CHAINS.join(', ')})` };
  const txHash = normalizeTxHash(chain, raw.txHash);
  if (!txHash) return { reason: `Hash transaksi tidak valid untuk chain ${chain}` };
  if (!Number.isInteger(raw.logIndex) || raw.logIndex < 0) return { reason: 'logIndex harus bilangan bulat ≥ 0' };
  if (!isNil(raw.blockNumber) && (!Number.isInteger(raw.blockNumber) || raw.blockNumber < 0)) {
    return { reason: 'blockNumber harus bilangan bulat ≥ 0 atau null' };
  }
  if (!Number.isFinite(raw.blockTime) || raw.blockTime < 0) return { reason: 'blockTime harus epoch milidetik yang valid' };
  const from = normalizeParty(chain, raw.from);
  if (!from) return { reason: `Alamat pengirim (from) tidak valid untuk chain ${chain}` };
  const to = normalizeParty(chain, raw.to);
  if (!to) return { reason: `Alamat penerima (to) tidak valid untuk chain ${chain}` };
  const token = raw.token;
  if (!token || typeof token !== 'object') return { reason: 'Data token tidak ada' };
  const tokenAddress = normalizeAddress(chain, token.address);
  if (!tokenAddress) return { reason: `Alamat kontrak token tidak valid untuk chain ${chain}` };
  if (!isNil(token.decimals) && (!Number.isInteger(token.decimals) || token.decimals < 0)) {
    return { reason: 'decimals token harus bilangan bulat ≥ 0 atau null' };
  }
  if (!Number.isFinite(raw.amount) || raw.amount <= 0) return { reason: 'Jumlah token (amount) harus angka > 0' };
  const provider = nonEmptyString(raw.provider);
  if (!provider) return { reason: 'Provider sumber data tidak disebutkan' };

  const usdValue = Number.isFinite(raw.usdValue) && raw.usdValue >= 0 ? raw.usdValue : null;
  return {
    transfer: {
      chain,
      txHash,
      logIndex: raw.logIndex,
      blockNumber: raw.blockNumber ?? null,
      blockTime: raw.blockTime,
      from,
      to,
      token: {
        address: tokenAddress,
        symbol: nonEmptyString(token.symbol) ?? '?',
        name: nonEmptyString(token.name),
        decimals: token.decimals ?? null,
      },
      amount: raw.amount,
      usdValue,
      priceSource: usdValue === null ? null : nonEmptyString(raw.priceSource),
      provider,
      isSimulated: raw.isSimulated === true,
      txMeta: normalizeTxMeta(chain, raw.txMeta),
    },
  };
}

function transferKey(t) {
  return `${t.chain}:${t.txHash}:${t.logIndex}`;
}

/**
 * Validasi, normalisasi, dan dedupe RawTransfer dari satu atau beberapa provider.
 * @param {object[]} rawTransfers
 * @returns {{ transfers: object[], rejected: { input: any, reason: string }[], duplicates: number }}
 */
export function normalizeTransfers(rawTransfers) {
  const list = Array.isArray(rawTransfers) ? rawTransfers : [];
  const byKey = new Map();
  const rejected = [];
  let duplicates = 0;
  for (const raw of list) {
    const res = normalizeOne(raw);
    if (res.reason) {
      rejected.push({ input: raw, reason: res.reason });
      continue;
    }
    const t = res.transfer;
    const key = transferKey(t);
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, t);
      continue;
    }
    duplicates += 1;
    // Lengkapi data yang tidak diketahui pada baris pertama dari duplikat (lihat catatan di atas).
    if (kept.usdValue === null && t.usdValue !== null) {
      kept.usdValue = t.usdValue;
      kept.priceSource = t.priceSource;
    }
    if (kept.token.decimals === null && t.token.decimals !== null) kept.token.decimals = t.token.decimals;
    if (kept.token.name === null && t.token.name !== null) kept.token.name = t.token.name;
    if (kept.blockNumber === null && t.blockNumber !== null) kept.blockNumber = t.blockNumber;
    for (const f of TX_META_FIELDS) {
      if (kept.txMeta[f] === null && t.txMeta[f] !== null) kept.txMeta[f] = t.txMeta[f];
    }
  }
  const transfers = [...byKey.values()].sort((a, b) => a.blockTime - b.blockTime
    || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0)
    || a.logIndex - b.logIndex);
  return { transfers, rejected, duplicates };
}

/**
 * Kelompokkan transfer per transaksi. Urutan kunci mengikuti kemunculan pertama.
 * @param {object[]} transfers RawTransfer yang sudah dinormalisasi
 * @returns {Map<string, object[]>} kunci `chain:txHash`
 */
export function groupByTransaction(transfers) {
  const groups = new Map();
  for (const t of transfers ?? []) {
    const key = `${t.chain}:${t.txHash}`;
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  return groups;
}
