// Komposisi analisis universe wallet (docs/15 §2): Activity[] → PnL FIFO (pnl.js) → penanda risiko (walletFlags.js)
// → klaster per chain (clusters.js) + penanda LINKED → skor wallet (walletScore.js). Ini SATU-SATUNYA komposisi yang
// dipakai layanan sinkronisasi live dan evaluasi historis (evaluate.js), sehingga keduanya menilai wallet dengan cara
// yang sama. Fungsi murni: tanpa I/O, tanpa Date.now() — waktu dari `now`.
//
// ─── Aturan ─────────────────────────────────────────────────────────────────────────────────────────
// - Tanpa look-ahead: aktivitas dengan blockTime > now diabaikan (stats.ignoredFuture) dan harga dengan at > now
//   dibuang sebelum PnL (pnl.js juga mengabaikannya — penyaringan ganda disengaja).
// - Aktivitas tidak valid (bukan objek, chain tak dikenal, tanpa wallet/token/blockTime) diabaikan
//   (stats.ignoredInvalid). Duplikat Activity.id dihitung sekali (radar.dedupeActivities: urut blockTime, id) →
//   hasil identik untuk urutan masukan yang berbeda.
// - Identitas wallet = walletKey(chain, wallet) apa adanya: alamat diharapkan sudah kanonik (keluaran classify.js) dan
//   TIDAK dinormalisasi ulang, agar kuncinya sama dengan yang dipakai radar.js & alerts.js.
// - Klaster dihitung PER CHAIN (linkWallets menerima satu chain) hanya atas wallet di universe; wallet di chain berbeda
//   tidak pernah ditautkan. Penanda wallet (langkah 1) ikut dikirim ke linkWallets: wallet yang dikecualikan
//   (isExcluded) atau ditandai BOT/MEV tidak ikut penautan — bukan anggota maupun jembatan (lihat clusters.js).
//   Penanda LINKED (LOW, clusters.linkedFlag) disisipkan sebelum skor dihitung: tidak mengecualikan, hanya tampil
//   sebagai keterbatasan; radar menghitung satu klaster sebagai satu pembeli independen.
// - Penanda dihitung dengan `pnl` & `now` (ekstensi walletFlags.js) tanpa `txTimes` (Activity tidak membawa
//   blockNumber). Skor & kelayakan hanya membaca PnL realisasi — `prices` hanya memengaruhi unrealized PnL.
//
// Keluaran (Map terurut walletKey; klaster terurut id; tautan terurut chain lalu urutan linkWallets):
//   wallets:      Map<walletKey, { chain, address, pnl, flags, score: WalletScore, clusterId,
//                                  activityCount, firstActivityAt, lastActivityAt }>   (tiga field terakhir aditif)
//   walletScores: Map<walletKey, { score, eligible, flags }>   — bentuk masukan radar.js / alerts.js
//   clusterOf:    Map<walletKey, clusterId>
//   clusters:     [{ id, chain, members: [alamat], reasons }]
//   links:        [{ chain, type, a, b, evidence }]
//   stats:        { activities, wallets, eligibleWallets, chains, ignoredFuture, ignoredInvalid, duplicates }

import { WALLET_FLAGS, isChain, isEvmChain, walletKey as makeWalletKey } from './contracts.js';
import { DEFAULT_CLUSTER_PARAMS, linkWallets, linkedFlag } from './clusters.js';
import { computeWalletPnl } from './pnl.js';
import { dedupeActivities } from './radar.js';
import { DEFAULT_FLAG_PARAMS, detectWalletFlags } from './walletFlags.js';
import { DEFAULT_WALLET_SCORE_PARAMS, scoreWallet } from './walletScore.js';

/** Parameter default: override diteruskan ke modul masing-masing (yang memvalidasi kuncinya sendiri). */
export const DEFAULT_ANALYZE_PARAMS = Object.freeze({
  flags: DEFAULT_FLAG_PARAMS,
  clusters: DEFAULT_CLUSTER_PARAMS,
  score: DEFAULT_WALLET_SCORE_PARAMS,
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * True bila aktivitas cukup lengkap untuk dianalisis (objek, chain dikenal, wallet, token, blockTime).
 * @param {object} a
 * @returns {boolean}
 */
export function isAnalyzableActivity(a) {
  return Boolean(a) && typeof a === 'object' && isChain(a.chain) && typeof a.wallet === 'string' && a.wallet !== ''
    && Boolean(a.token) && typeof a.token.address === 'string' && isNum(a.blockTime);
}

function resolveParams(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('Parameter analisis harus objek');
  }
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(DEFAULT_ANALYZE_PARAMS, key)) throw new TypeError(`Parameter analisis tidak dikenal: ${key}`);
  }
  return { flags: params.flags ?? {}, clusters: params.clusters ?? {}, score: params.score ?? {} };
}

/** Peta harga tanpa entri dari masa depan (at > now). Entri tanpa `at` dipertahankan (pnl.js menandainya basi). */
function pricesUpTo(prices, now) {
  const out = new Map();
  if (prices === undefined || prices === null) return out;
  if (!(prices instanceof Map)) throw new TypeError('prices harus Map<tokenKey, { priceUsd, at, source }>');
  for (const [key, p] of prices) {
    if (!p || typeof p !== 'object' || (isNum(p.at) && p.at > now)) continue;
    out.set(key, p);
  }
  return out;
}

/** Alamat kanonik versi clusters.js (EVM huruf kecil, Solana apa adanya) untuk membaca hasil linkWallets. */
function linkAddress(chain, address) {
  return isEvmChain(chain) ? address.trim().toLowerCase() : address.trim();
}

/** Sisipkan penanda pada posisi urutan WALLET_FLAGS tanpa mengubah urutan penanda lain. */
function insertFlag(flags, flag) {
  const order = WALLET_FLAGS.indexOf(flag.code);
  const i = flags.findIndex((f) => WALLET_FLAGS.indexOf(f.code) > order);
  return i === -1 ? [...flags, flag] : [...flags.slice(0, i), flag, ...flags.slice(i)];
}

/**
 * Analisis seluruh universe wallet pada waktu `now`: PnL, penanda, klaster, dan skor per wallet.
 * @param {{ activities: object[], labels?: Map<string, object>|object[], prices?: Map<string, { priceUsd: number,
 *   at: number, source?: string }>, now: number }} input
 * @param {{ flags?: object, clusters?: object, score?: object }} [params] override per modul
 * @returns {{ wallets: Map<string, object>, walletScores: Map<string, { score: number, eligible: boolean,
 *   flags: object[] }>, clusterOf: Map<string, string>, clusters: object[], links: object[], stats: object }}
 */
export function analyzeUniverse({ activities, labels, prices, now } = {}, params = {}) {
  if (!isNum(now)) throw new TypeError('analyzeUniverse: argumen `now` (epoch ms) wajib diisi');
  if (!Array.isArray(activities)) throw new TypeError('analyzeUniverse: activities harus array');
  const p = resolveParams(params);

  let ignoredFuture = 0;
  let ignoredInvalid = 0;
  const usable = [];
  for (const a of activities) {
    if (!isAnalyzableActivity(a)) ignoredInvalid += 1;
    else if (a.blockTime > now) ignoredFuture += 1;
    else usable.push(a);
  }
  const unique = dedupeActivities(usable);

  // Kelompokkan per wallet; urutan (blockTime, id) dari dedupeActivities terjaga di dalam kelompok. Peta dua tingkat
  // (chain → alamat) menghindari pembuatan & hashing string walletKey baru untuk setiap aktivitas.
  const byChain = new Map();
  for (const a of unique) {
    let inChain = byChain.get(a.chain);
    if (!inChain) {
      inChain = new Map();
      byChain.set(a.chain, inChain);
    }
    let g = inChain.get(a.wallet);
    if (!g) {
      g = { chain: a.chain, address: a.wallet, acts: [] };
      inChain.set(a.wallet, g);
    }
    g.acts.push(a);
  }
  const groups = new Map();
  for (const inChain of byChain.values()) {
    for (const g of inChain.values()) groups.set(makeWalletKey(g.chain, g.address), g);
  }
  const keys = [...groups.keys()].sort(cmp);
  const priceMap = pricesUpTo(prices, now);

  // 1. PnL & penanda per wallet.
  for (const key of keys) {
    const g = groups.get(key);
    g.pnl = computeWalletPnl(g.acts, { prices: priceMap, now });
    g.flags = detectWalletFlags({ chain: g.chain, address: g.address, activities: g.acts, labels, pnl: g.pnl, now }, p.flags);
  }

  // 2. Klaster per chain, hanya atas wallet di universe; penanda ikut agar wallet BOT/MEV/dikecualikan tidak menautkan.
  const chains = [...new Set(keys.map((k) => groups.get(k).chain))].sort(cmp);
  const linkResults = new Map();
  const clusters = [];
  const links = [];
  for (const chain of chains) {
    const members = keys.filter((k) => groups.get(k).chain === chain)
      .map((k) => ({ address: groups.get(k).address, activities: groups.get(k).acts, flags: groups.get(k).flags }));
    const r = linkWallets({ chain, wallets: members, labels }, p.clusters);
    const sizeOf = new Map(r.clusters.map((c) => [c.id, c.members.length]));
    linkResults.set(chain, { result: r, sizeOf });
    for (const c of r.clusters) clusters.push({ id: c.id, chain, members: c.members, reasons: c.reasons });
    for (const l of r.links) links.push({ chain, ...l });
  }

  // 3. Penanda LINKED + skor wallet.
  const wallets = new Map();
  const walletScores = new Map();
  const clusterOf = new Map();
  let eligibleWallets = 0;
  for (const key of keys) {
    const g = groups.get(key);
    const { result, sizeOf } = linkResults.get(g.chain);
    const address = linkAddress(g.chain, g.address);
    const clusterId = result.clusterOf.get(address) ?? key;
    const linked = (sizeOf.get(clusterId) ?? 1) > 1 ? linkedFlag(result, address) : null;
    const flags = linked ? insertFlag(g.flags, linked) : g.flags;
    const score = scoreWallet({ chain: g.chain, address: g.address, pnl: g.pnl, activities: g.acts, flags, now }, p.score);
    if (score.eligible) eligibleWallets += 1;
    wallets.set(key, {
      chain: g.chain,
      address: g.address,
      pnl: g.pnl,
      flags,
      score,
      clusterId,
      activityCount: g.acts.length,
      firstActivityAt: g.acts[0].blockTime,
      lastActivityAt: g.acts[g.acts.length - 1].blockTime,
    });
    walletScores.set(key, { score: score.score, eligible: score.eligible, flags });
    clusterOf.set(key, clusterId);
  }

  return {
    wallets,
    walletScores,
    clusterOf,
    clusters,
    links,
    stats: {
      activities: unique.length,
      wallets: keys.length,
      eligibleWallets,
      chains,
      ignoredFuture,
      ignoredInvalid,
      duplicates: usable.length - unique.length,
    },
  };
}
