// Penautan wallet yang kemungkinan dikendalikan pihak yang sama (kontrak docs/15-kontrak-smart-money.md §2
// `clusters.js`). Fungsi murni: tanpa I/O, tanpa waktu sistem. Hasilnya dipakai radar agar banyak wallet milik
// satu pihak tidak dihitung sebagai banyak pembeli independen.
//
// ─── Wallet yang tidak ikut penautan ─────────────────────────────────────────────────────────────────
// Kandidat dengan `flags` (WalletFlag[], aditif) yang mengecualikan (walletFlags.isExcluded: CEX, MARKET_MAKER, BOT,
// MEV, CONTRACT, DEX_INFRA ber-severity HIGH), ATAU penanda BOT/MEV dengan severity apa pun, ATAU `excluded: true`,
// tidak ikut penautan sama sekali — bukan anggota tautan dan bukan "jembatan": tidak menjadi pihak transfer langsung
// atau kontrak perantaranya, tidak dihitung sebagai pendana bersama atau alamat deposit bersama, dan pembeliannya
// tidak dihitung ko-trading. Wallet tersebut tetap muncul sebagai klaster beranggota satu.
//
// ─── Tepi (union-find) ───────────────────────────────────────────────────────────────────────────────
// DIRECT_TRANSFER  transfer langsung antar-kandidat (RawTransfer from/to keduanya kandidat, atau aktivitas
//                  TRANSFER_IN/TRANSFER_OUT dengan counterparty kandidat). Diabaikan bila salah satu pihak,
//                  `txMeta.toContract`, atau label lawan aktivitas berkategori cex/cex_deposit/bridge.
// COMMON_FUNDER    pendana pertama yang sama: transfer token native PERTAMA yang masuk ke wallet (dari
//                  `transfers`, jika tidak dari aktivitas IN bertoken native; hasil swap bukan pendanaan). Wallet TIDAK
//                  mendapat tautan ini bila pendana pertamanya:
//                  - ZERO_ADDRESS, atau wallet itu sendiri;
//                  - berlabel infrastruktur/layanan (dari `labels` atau `counterpartyLabel`): cex, cex_deposit, bridge,
//                    dex_router, dex_pool, contract, lp_token, airdrop_distributor, mev_bot, market_maker;
//                  - kontrak aset quote (WETH/stablecoin — mis. unwrap WETH mengirim ETH dari kontrak WETH);
//                  - kandidat yang tidak ikut penautan (lihat di atas);
//                  - aktivitas CEX_WITHDRAWAL/BRIDGE_IN, atau transfer ber-`txMeta.providerCategory` bridge/deposit/withdraw;
//                  - "fan-out" > maxFunderFanOut (default 10): alamat yang pernah mengirim token native (bukan swap) ke
//                    lebih dari N wallet kandidat berbeda adalah layanan (faucet, refuel, distributor), bukan pemilik.
// SHARED_DEPOSIT   mengirim ke alamat deposit exchange yang sama (label `cex_deposit`; alamat deposit bersifat per
//                  pengguna, hot wallet `cex` TIDAK dipakai).
// CO_TRADING       kedua wallet SWAP_BUY token yang sama dalam ≤ 60 dtk, pada ≥ 3 token berbeda (aset quote diabaikan).
//                  Aturan hub (coTradeHubFilter, default aktif): wallet yang ko-trading dengan ≥ 2 mitra yang TIDAK saling
//                  terkait (tanpa ko-trading di antara keduanya dan tidak satu klaster menurut tiga tepi di atas) adalah
//                  hub — front-runner, copy-trader, atau bot yang belum ditandai. Semua tautan ko-trading hub dibuang agar
//                  wallet yang tidak berhubungan tidak tergabung transitif lewat satu wallet. Konsekuensi yang disengaja:
//                  rantai ko-trading tak lengkap (A–B dan B–C tanpa A–C, tanpa bukti lain) tidak digabung — ko-trading
//                  adalah bukti terlemah, sehingga ragu-ragu → tidak digabung.
//
// Alamat EVM dibandingkan huruf kecil; alamat Solana peka huruf besar/kecil (apa adanya).
// `id` klaster = `chain:alamat-terkecil` (perbandingan kode karakter, bukan locale) → deterministik.

import { ZERO_ADDRESS, isEvmChain, isQuoteAsset, NATIVE_TOKEN } from './contracts.js';
import { isExcluded } from './walletFlags.js';

export const LINK_TYPES = Object.freeze(['DIRECT_TRANSFER', 'COMMON_FUNDER', 'SHARED_DEPOSIT', 'CO_TRADING']);

export const DEFAULT_CLUSTER_PARAMS = Object.freeze({
  coTradeWindowMs: 60_000,
  coTradeMinTokens: 3,
  /** Pendana yang mengirim token native ke > N wallet kandidat berbeda = layanan, bukan pemilik. */
  maxFunderFanOut: 10,
  /** Buang tautan ko-trading milik wallet hub (mitra-mitranya tidak saling terkait). */
  coTradeHubFilter: true,
});

const EXCHANGE_OR_BRIDGE = new Set(['cex', 'cex_deposit', 'bridge']);
/** Kategori label infrastruktur/layanan: dana dari alamat ini bukan sinyal pemilik yang sama. */
const INFRA_FUNDER_CATEGORIES = new Set([
  'cex', 'cex_deposit', 'bridge', 'dex_router', 'dex_pool', 'contract', 'lp_token', 'airdrop_distributor', 'mev_bot',
  'market_maker',
]);
const SERVICE_PROVIDER_CATEGORIES = new Set(['bridge', 'deposit', 'withdraw']);
/** Penanda yang membuat wallet tidak ikut penautan pada severity apa pun (selain isExcluded). */
const UNLINKABLE_FLAG_CODES = new Set(['BOT', 'MEV']);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function canon(chain, address) {
  if (typeof address !== 'string') return null;
  const a = address.trim();
  return isEvmChain(chain) ? a.toLowerCase() : a;
}

function labelOf(labels, chain, address) {
  if (!labels || !address) return null;
  let raw;
  if (labels instanceof Map) raw = labels.get(`${chain}:${address}`);
  else if (Array.isArray(labels)) raw = labels.filter((l) => l && l.chain === chain && canon(chain, l.address) === address);
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((l) => l && typeof l.source === 'string' && l.source !== '');
  return list.length ? list : null;
}

function hasCategory(labels, chain, address, categories) {
  const list = labelOf(labels, chain, address);
  return Boolean(list && list.some((l) => categories.has(l.category)));
}

/** True bila kandidat tidak boleh ikut penautan (dikecualikan, BOT/MEV, atau `excluded: true`). */
function isUnlinkable(w) {
  if (w?.excluded === true) return true;
  const flags = Array.isArray(w?.flags) ? w.flags : [];
  return isExcluded(flags) || flags.some((f) => f && UNLINKABLE_FLAG_CODES.has(f.code));
}

class UnionFind {
  constructor(items) {
    this.parent = new Map(items.map((i) => [i, i]));
  }

  find(x) {
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    let c = x;
    while (this.parent.get(c) !== r) {
      const n = this.parent.get(c);
      this.parent.set(c, r);
      c = n;
    }
    return r;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Akar = alamat terkecil agar hasil tidak bergantung urutan.
    if (cmp(ra, rb) <= 0) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

/**
 * Tautkan wallet kandidat menjadi klaster.
 * @param {{ chain: string, wallets: Array<{ address: string, activities?: object[], transfers?: object[],
 *   flags?: object[], excluded?: boolean }>, labels?: Map<string, object>|object[] }} input `flags`/`excluded`
 *   (aditif): kandidat yang dikecualikan atau ditandai BOT/MEV tidak ikut penautan (lihat header).
 * @param {Partial<typeof DEFAULT_CLUSTER_PARAMS>} [params]
 * @returns {{ clusters: Array<{ id: string, members: string[], reasons: object[] }>, clusterOf: Map<string, string>,
 *   links: Array<{ type: string, a: string, b: string, evidence: object }> }}
 */
export function linkWallets({ chain, wallets = [], labels } = {}, params = {}) {
  const p = { ...DEFAULT_CLUSTER_PARAMS, ...params };
  const byAddr = new Map();
  for (const w of wallets) {
    const addr = canon(chain, w?.address);
    if (!addr) continue;
    const entry = byAddr.get(addr) ?? { address: addr, activities: [], transfers: [], unlinkable: false };
    // Loop, bukan push(...arr): spread argumen gagal (RangeError) di atas ~125 ribu elemen.
    if (Array.isArray(w.activities)) for (const a of w.activities) entry.activities.push(a);
    if (Array.isArray(w.transfers)) for (const t of w.transfers) entry.transfers.push(t);
    if (isUnlinkable(w)) entry.unlinkable = true;
    byAddr.set(addr, entry);
  }
  const addresses = [...byAddr.keys()].sort(cmp);
  const candidates = new Set(addresses);
  const linkable = new Set(addresses.filter((a) => !byAddr.get(a).unlinkable));
  /** Kandidat yang tidak ikut penautan (juga tidak boleh menjadi jembatan antar-wallet lain). */
  const isBlockedCandidate = (a) => candidates.has(a) && !linkable.has(a);
  const isExBridge = (a) => hasCategory(labels, chain, a, EXCHANGE_OR_BRIDGE);
  const isInfra = (a) => hasCategory(labels, chain, a, INFRA_FUNDER_CATEGORIES);
  const linkMap = new Map();

  const addLink = (type, x, y, evidence) => {
    if (x === y) return;
    const [a, b] = cmp(x, y) <= 0 ? [x, y] : [y, x];
    const key = `${type}|${a}|${b}`;
    if (!linkMap.has(key)) linkMap.set(key, { type, a, b, evidence });
  };

  // 1. Transfer langsung antar-kandidat.
  const direct = [];
  for (const w of byAddr.values()) {
    for (const t of w.transfers) {
      const from = canon(chain, t?.from);
      const to = canon(chain, t?.to);
      if (!linkable.has(from) || !linkable.has(to) || from === to) continue;
      const via = canon(chain, t.txMeta?.toContract ?? null);
      if (isExBridge(from) || isExBridge(to) || (via && via !== to && (isExBridge(via) || isBlockedCandidate(via)))) continue;
      if (t.txMeta?.providerCategory === 'bridge' || t.txMeta?.providerCategory === 'deposit' || t.txMeta?.providerCategory === 'withdraw') continue;
      direct.push({ from, to, txHash: t.txHash ?? null, token: t.token?.address ?? null, at: t.blockTime ?? null });
    }
    for (const a of w.activities) {
      if (a?.type !== 'TRANSFER_IN' && a?.type !== 'TRANSFER_OUT') continue;
      const other = canon(chain, a.counterparty);
      if (!linkable.has(w.address) || !linkable.has(other) || other === w.address) continue;
      if (a.counterpartyLabel && EXCHANGE_OR_BRIDGE.has(a.counterpartyLabel.category)) continue;
      if (isExBridge(other) || isExBridge(w.address)) continue;
      const [from, to] = a.type === 'TRANSFER_OUT' ? [w.address, other] : [other, w.address];
      direct.push({ from, to, txHash: a.txHash ?? null, token: a.token?.address ?? null, at: a.blockTime ?? null });
    }
  }
  direct.sort((x, y) => (x.at ?? 0) - (y.at ?? 0) || cmp(String(x.txHash), String(y.txHash)));
  for (const d of direct) addLink('DIRECT_TRANSFER', d.from, d.to, { txHash: d.txHash, token: d.token, at: d.at, from: d.from, to: d.to });

  // 2. Pendana pertama yang sama.
  const funderOf = new Map();
  const fundedBy = new Map(); // pendana → Set<kandidat yang pernah menerima token native (bukan swap) darinya>
  const noteFunding = (funder, wallet) => {
    if (!funder) return;
    const set = fundedBy.get(funder) ?? new Set();
    set.add(wallet);
    fundedBy.set(funder, set);
  };
  for (const w of byAddr.values()) {
    const ins = [];
    for (const t of w.transfers) {
      if (canon(chain, t?.to) !== w.address || t.token?.address !== NATIVE_TOKEN || !isNum(t.blockTime)) continue;
      const funder = canon(chain, t.from);
      noteFunding(funder, w.address);
      ins.push({
        funder, txHash: t.txHash ?? null, at: t.blockTime, idx: Number.isInteger(t.logIndex) ? t.logIndex : 0,
        service: SERVICE_PROVIDER_CATEGORIES.has(t.txMeta?.providerCategory),
      });
    }
    for (const a of w.activities) {
      if (a?.direction !== 'IN' || a.token?.address !== NATIVE_TOKEN || !isNum(a.blockTime) || !a.counterparty) continue;
      if (a.type === 'SWAP_BUY' || a.type === 'SWAP_SELL') continue;
      const funder = canon(chain, a.counterparty);
      noteFunding(funder, w.address);
      ins.push({ funder, txHash: a.txHash ?? null, at: a.blockTime, idx: 0, act: a });
    }
    if (ins.length === 0 || !linkable.has(w.address)) continue;
    ins.sort((x, y) => x.at - y.at || cmp(String(x.txHash), String(y.txHash)) || x.idx - y.idx);
    const first = ins[0];
    if (!first.funder || first.funder === ZERO_ADDRESS || first.funder === w.address) continue;
    if (first.service || isInfra(first.funder) || isQuoteAsset(chain, first.funder) || isBlockedCandidate(first.funder)) continue;
    if (first.act && (first.act.type === 'CEX_WITHDRAWAL' || first.act.type === 'BRIDGE_IN'
      || (first.act.counterpartyLabel && INFRA_FUNDER_CATEGORIES.has(first.act.counterpartyLabel.category)))) continue;
    funderOf.set(w.address, first);
  }
  const byFunder = new Map();
  for (const addr of addresses) {
    const f = funderOf.get(addr);
    if (!f) continue;
    // Fan-out besar → layanan (faucet/refuel/distributor), bukan pemilik bersama.
    if ((fundedBy.get(f.funder)?.size ?? 0) > p.maxFunderFanOut) continue;
    const list = byFunder.get(f.funder) ?? [];
    list.push({ addr, ...f });
    byFunder.set(f.funder, list);
  }
  for (const [funder, list] of byFunder) {
    for (let i = 1; i < list.length; i += 1) {
      addLink('COMMON_FUNDER', list[0].addr, list[i].addr, {
        funder, txHash: list[i].txHash, at: list[i].at, txHashes: [list[0].txHash, list[i].txHash],
      });
    }
  }

  // 3. Alamat deposit exchange yang sama (cex_deposit).
  const depositUsers = new Map();
  const noteDeposit = (wallet, dep, txHash, at) => {
    const m = depositUsers.get(dep) ?? new Map();
    const prev = m.get(wallet);
    if (!prev || (at ?? 0) < (prev.at ?? 0)) m.set(wallet, { txHash, at });
    depositUsers.set(dep, m);
  };
  const isDepositAddr = (a) => hasCategory(labels, chain, a, new Set(['cex_deposit']));
  for (const w of byAddr.values()) {
    if (!linkable.has(w.address)) continue;
    for (const t of w.transfers) {
      if (canon(chain, t?.from) !== w.address) continue;
      const to = canon(chain, t.to);
      if (to && !isBlockedCandidate(to) && isDepositAddr(to)) noteDeposit(w.address, to, t.txHash ?? null, t.blockTime ?? null);
    }
    for (const a of w.activities) {
      if (a?.direction !== 'OUT' || !a.counterparty) continue;
      const to = canon(chain, a.counterparty);
      if (isBlockedCandidate(to)) continue;
      if (a.counterpartyLabel?.category === 'cex_deposit' || isDepositAddr(to)) noteDeposit(w.address, to, a.txHash ?? null, a.blockTime ?? null);
    }
  }
  for (const dep of [...depositUsers.keys()].sort(cmp)) {
    const users = [...depositUsers.get(dep).entries()].sort((x, y) => cmp(x[0], y[0]));
    for (let i = 1; i < users.length; i += 1) {
      addLink('SHARED_DEPOSIT', users[0][0], users[i][0], {
        depositAddress: dep, txHash: users[i][1].txHash, at: users[i][1].at, txHashes: [users[0][1].txHash, users[i][1].txHash],
      });
    }
  }

  // 4. Ko-trading (hanya kandidat yang ikut penautan — tidak pernah lewat wallet yang dikecualikan).
  const buysByToken = new Map();
  for (const w of byAddr.values()) {
    if (!linkable.has(w.address)) continue;
    for (const a of w.activities) {
      if (a?.type !== 'SWAP_BUY' || !isNum(a.blockTime) || !a.token?.address) continue;
      const tok = canon(chain, a.token.address);
      if (isQuoteAsset(chain, tok)) continue;
      const list = buysByToken.get(tok) ?? [];
      list.push({ wallet: w.address, at: a.blockTime, txHash: a.txHash ?? null });
      buysByToken.set(tok, list);
    }
  }
  const pairTokens = new Map();
  for (const tok of [...buysByToken.keys()].sort(cmp)) {
    const list = buysByToken.get(tok).sort((x, y) => x.at - y.at || cmp(x.wallet, y.wallet) || cmp(String(x.txHash), String(y.txHash)));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length && list[j].at - list[i].at <= p.coTradeWindowMs; j += 1) {
        if (list[i].wallet === list[j].wallet) continue;
        const [x, y] = cmp(list[i].wallet, list[j].wallet) <= 0 ? [list[i], list[j]] : [list[j], list[i]];
        const key = `${x.wallet}|${y.wallet}`;
        const m = pairTokens.get(key) ?? new Map();
        if (!m.has(tok)) m.set(tok, { token: tok, at: Math.min(x.at, y.at), txHashes: [x.txHash, y.txHash] });
        pairTokens.set(key, m);
      }
    }
  }
  const coPairs = [...pairTokens.keys()].sort(cmp).filter((key) => pairTokens.get(key).size >= p.coTradeMinTokens);
  const hubs = p.coTradeHubFilter === false ? new Set() : coTradeHubs(coPairs, linkMap, addresses);
  for (const key of coPairs) {
    const m = pairTokens.get(key);
    const [a, b] = key.split('|');
    if (hubs.has(a) || hubs.has(b)) continue;
    const items = [...m.values()].sort((x, y) => cmp(x.token, y.token));
    addLink('CO_TRADING', a, b, {
      token: items[0].token, at: items[0].at, txHash: items[0].txHashes[0],
      tokens: items.map((i) => i.token), examples: items,
    });
  }

  // Union-find & keluaran deterministik.
  const links = [...linkMap.values()].sort((x, y) => LINK_TYPES.indexOf(x.type) - LINK_TYPES.indexOf(y.type) || cmp(x.a, y.a) || cmp(x.b, y.b));
  const uf = new UnionFind(addresses);
  for (const l of links) uf.union(l.a, l.b);
  const groups = new Map();
  for (const addr of addresses) {
    const root = uf.find(addr);
    const g = groups.get(root) ?? [];
    g.push(addr);
    groups.set(root, g);
  }
  const clusterOf = new Map();
  const clusters = [];
  for (const members of groups.values()) {
    members.sort(cmp);
    const id = `${chain}:${members[0]}`;
    const set = new Set(members);
    for (const m of members) clusterOf.set(m, id);
    clusters.push({ id, members, reasons: links.filter((l) => set.has(l.a)) });
  }
  clusters.sort((x, y) => cmp(x.id, y.id));
  return { clusters, clusterOf, links };
}

/**
 * Wallet hub ko-trading: punya ≥ 2 mitra ko-trading yang tidak saling terkait — tanpa ko-trading di antara keduanya
 * dan tidak satu klaster menurut tepi kuat (DIRECT_TRANSFER/COMMON_FUNDER/SHARED_DEPOSIT) yang sudah ditemukan.
 * Dihitung sekali atas graf awal (tidak iteratif) → deterministik.
 * @param {string[]} coPairs kunci `a|b` pasangan yang memenuhi syarat ko-trading
 * @param {Map<string, { a: string, b: string }>} strongLinks tautan non-ko-trading
 * @param {string[]} addresses semua kandidat
 * @returns {Set<string>}
 */
function coTradeHubs(coPairs, strongLinks, addresses) {
  const strong = new UnionFind(addresses);
  for (const l of strongLinks.values()) strong.union(l.a, l.b);
  const partners = new Map();
  const edges = new Set(coPairs);
  for (const key of coPairs) {
    const [a, b] = key.split('|');
    if (!partners.has(a)) partners.set(a, []);
    if (!partners.has(b)) partners.set(b, []);
    partners.get(a).push(b);
    partners.get(b).push(a);
  }
  const related = (x, y) => edges.has(cmp(x, y) <= 0 ? `${x}|${y}` : `${y}|${x}`) || strong.find(x) === strong.find(y);
  const hasUnrelatedPair = (list) => {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) if (!related(list[i], list[j])) return true;
    }
    return false;
  };
  const hubs = new Set();
  for (const [w, list] of partners) if (list.length >= 2 && hasUnrelatedPair(list)) hubs.add(w);
  return hubs;
}

/**
 * Penanda LINKED (severity LOW, informatif) untuk wallet yang berada dalam klaster beranggota > 1.
 * @param {{ clusters: object[], clusterOf: Map<string, string> }} result keluaran linkWallets
 * @param {string} address alamat kanonik
 * @returns {object|null}
 */
export function linkedFlag(result, address) {
  const id = result?.clusterOf?.get(address);
  const cluster = id ? result.clusters.find((c) => c.id === id) : null;
  if (!cluster || cluster.members.length < 2) return null;
  const types = [...new Set(cluster.reasons.map((r) => r.type))];
  return {
    code: 'LINKED', severity: 'LOW', source: 'heuristik',
    reason: `Tertaut dengan ${cluster.members.length - 1} wallet lain (${types.join(', ')}); dihitung sebagai satu pihak di radar`,
    evidence: { clusterId: id, members: cluster.members, txHashes: cluster.reasons.map((r) => r.evidence?.txHash).filter(Boolean) },
  };
}
