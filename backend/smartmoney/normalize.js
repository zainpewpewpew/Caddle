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
// - Dedupe lintas provider (baris PERTAMA menurut urutan masukan dipertahankan):
//   a. Kunci sama (chain, txHash, logIndex) DAN isi sama → duplikat. "Isi" = alamat token, from, to, dan amount
//      (toleransi relatif 1e-9 untuk sisa pembulatan desimal). Kiriman ulang transfer yang sebelumnya diberi logIndex
//      tabrakan (lihat b) dicocokkan lewat kunci aslinya → juga duplikat.
//   b. Kunci sama tetapi isi BERBEDA → tabrakan kunci (mis. provider B memberi logIndex sintetis 0 pada kaki ETH
//      native yang bentrok dengan log ERC-20 #0 dari provider A, atau penomoran instruksi Solana yang berbeda). KEDUA
//      transfer dipertahankan: baris yang datang belakangan diberi logIndex baru
//      COLLISION_LOG_INDEX_BASE (5e15) + (logIndex asli mod 1e15), dinaikkan 1 selama kunci itu sudah terpakai —
//      deterministik untuk urutan masukan yang sama, < Number.MAX_SAFE_INTEGER, dan di atas rentang logIndex asli
//      maupun sintetis adapter (1e15–3e15). Jumlahnya dilaporkan di `collisions`.
//   c. Isi sama di tx yang sama dengan logIndex BERBEDA dari provider BERBEDA → duplikat (penomoran logIndex
//      antar-provider tidak selalu sama, mis. Solana). Pencocokan satu-lawan-satu: satu baris tersimpan hanya dapat
//      menyerap satu baris dari tiap provider lain, sehingga dua transfer identik yang sah dalam satu tx (dilaporkan
//      provider yang sama dengan logIndex berbeda) tetap dua. Isi sama dari provider yang SAMA tidak pernah dianggap
//      duplikat (transfer kembar yang sah).
//   Pada duplikat (a/c), field yang tidak diketahui pada baris tersimpan dilengkapi dari duplikat: `usdValue`
//   (beserta `priceSource`) bila null, decimals/nama token, blockNumber, dan field txMeta yang null — identitas
//   transfer sama, sehingga melengkapi data tidak mengubah fakta on-chain.
// - Urutan keluaran: blockTime, lalu txHash, lalu logIndex (sort stabil).

import { CHAINS, NATIVE_TOKEN, ZERO_ADDRESS, isChain, normalizeAddress, normalizeTxHash } from './contracts.js';

/** Basis logIndex untuk transfer yang kuncinya bertabrakan dengan transfer lain berisi berbeda (lihat catatan). */
export const COLLISION_LOG_INDEX_BASE = 5e15;
const COLLISION_LOG_INDEX_SPAN = 1e15;
const AMOUNT_REL_TOLERANCE = 1e-9;

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

/** Kunci isi tanpa amount (amount dibandingkan dengan toleransi). */
function contentKey(t) {
  return `${t.chain}:${t.txHash}:${t.token.address}:${t.from}:${t.to}`;
}

function sameAmount(a, b) {
  return Math.abs(a - b) <= AMOUNT_REL_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

function sameContent(a, b) {
  return a.token.address === b.token.address && a.from === b.from && a.to === b.to && sameAmount(a.amount, b.amount);
}

/** Lengkapi field yang tidak diketahui pada baris tersimpan dari duplikatnya (identitas transfer sama). */
function fillFromDuplicate(kept, t) {
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

/**
 * Validasi, normalisasi, dan dedupe RawTransfer dari satu atau beberapa provider.
 * @param {object[]} rawTransfers
 * @returns {{ transfers: object[], rejected: { input: any, reason: string }[], duplicates: number, collisions: number }}
 *   `collisions` (aditif) = jumlah transfer berisi berbeda yang kuncinya bertabrakan dan diberi logIndex baru.
 */
export function normalizeTransfers(rawTransfers) {
  const list = Array.isArray(rawTransfers) ? rawTransfers : [];
  const byKey = new Map(); // transferKey → baris tersimpan
  const byContent = new Map(); // contentKey → [{ row, providers: Set }]
  const entryOf = new Map(); // baris tersimpan → entri byContent
  const rekeyedByOrigKey = new Map(); // kunci asli → baris yang sudah diberi logIndex tabrakan
  const rejected = [];
  let duplicates = 0;
  let collisions = 0;

  const keep = (t) => {
    byKey.set(transferKey(t), t);
    const entry = { row: t, providers: new Set([t.provider]) };
    entryOf.set(t, entry);
    const ck = contentKey(t);
    const arr = byContent.get(ck);
    if (arr) arr.push(entry);
    else byContent.set(ck, [entry]);
  };
  // Baris tersimpan berisi sama dari provider lain yang belum "menyerap" baris dari provider t (aturan c).
  const contentTwin = (t) => (byContent.get(contentKey(t)) ?? [])
    .find((e) => !e.providers.has(t.provider) && sameAmount(e.row.amount, t.amount)) ?? null;
  const freeCollisionIndex = (t) => {
    let idx = COLLISION_LOG_INDEX_BASE + (t.logIndex % COLLISION_LOG_INDEX_SPAN);
    while (byKey.has(`${t.chain}:${t.txHash}:${idx}`)) idx += 1;
    return idx;
  };

  for (const raw of list) {
    const res = normalizeOne(raw);
    if (res.reason) {
      rejected.push({ input: raw, reason: res.reason });
      continue;
    }
    const t = res.transfer;
    const key = transferKey(t);
    const kept = byKey.get(key);
    // (a) kunci & isi sama — termasuk kiriman ulang transfer yang sebelumnya sudah diberi logIndex tabrakan.
    const same = kept && sameContent(kept, t) ? kept : (rekeyedByOrigKey.get(key) ?? []).find((r) => sameContent(r, t));
    if (same) {
      duplicates += 1;
      entryOf.get(same).providers.add(t.provider);
      fillFromDuplicate(same, t);
      continue;
    }
    const twin = contentTwin(t);
    if (twin) { // (c)
      duplicates += 1;
      twin.providers.add(t.provider);
      fillFromDuplicate(twin.row, t);
      continue;
    }
    if (kept) { // (b) — `t` adalah salinan hasil normalizeOne, aman diubah.
      collisions += 1;
      t.logIndex = freeCollisionIndex(t);
      const arr = rekeyedByOrigKey.get(key);
      if (arr) arr.push(t);
      else rekeyedByOrigKey.set(key, [t]);
    }
    keep(t);
  }
  const transfers = [...byKey.values()].sort((a, b) => a.blockTime - b.blockTime
    || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0)
    || a.logIndex - b.logIndex);
  return { transfers, rejected, duplicates, collisions };
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
