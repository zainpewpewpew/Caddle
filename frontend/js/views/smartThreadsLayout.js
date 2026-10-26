// Peta Benang (Smart Money Radar): tata letak graf bipartit wallet → token dari item GET /api/smart-money/radar.
// Fungsi MURNI & deterministik (tanpa DOM, jaringan, Date.now(), atau acak) — dirender oleh smartThreads.js, diuji
// di tests/unit/smartmoney/threadsLayout.test.js. Hanya field kontrak docs/15 §5 yang dibaca; tidak ada nilai yang
// ditaksir: USD null tetap null (benang tipis putus-putus), skor keyakinan bukan probabilitas.
//
// Identitas
// - Token = tokenKey (chain + kontrak), BUKAN simbol: simbol sama dengan kontrak berbeda = dua node.
// - Wallet = `chain:alamat` (alamat EVM huruf kecil): alamat sama di dua chain = dua node.
//
// Seleksi
// - Token diurutkan keyakinan turun lalu tokenKey; `maxTokens` teratas disimpan.
// - Wallet hanya yang terhubung ke token tersimpan (pembeli atau indikasi keluar); `maxWallets` teratas menurut skor
//   terbaik (wallet tanpa skor — hanya indikasi keluar — di akhir) lalu alamat. Sisanya dihitung di `hidden`.
//
// Urutan & posisi (satuan baris: 1 = tinggi slot satu wallet; y = titik tengah slot)
// - Token berjarak rata sepanjang tinggi peta, urutan = peringkat keyakinan.
// - Wallet diurutkan menurut barycenter (rata-rata indeks token yang terhubung) untuk mengurangi persilangan benang;
//   seri → skor turun → kunci. Wallet satu klaster (clusterId sama dan ≥ 2 wallet tampil) menjadi satu blok
//   berdampingan bertanda K1, K2, …: wallet tertaut dihitung SATU pembeli independen oleh radar.
// - y wallet sedekat mungkin ke rata-rata y token-nya dengan jarak minimum satu slot (regresi isotonik berbobot,
//   "pool adjacent violators"): urutan tetap, benang sependek mungkin.
//
// Benang: satu per (wallet, token).
// - BUY: wallet adalah pembeli (swap beli). `mixed` bila wallet itu juga menjual (sells > 0). `hasExit` bila ada
//   indikasi keluar untuk pasangan yang sama.
// - EXIT: wallet hanya muncul di exitSignals — indikasi keluar: jual via swap (SWAP) atau dipindah ke exchange
//   (CEX: belum tentu dijual, tidak pernah disebut penjualan).
// - Tebal = skala log |USD| (netBuyUsd untuk BUY; jumlah USD peristiwa keluar untuk EXIT) dijepit STRAND_WIDTH.
//   USD tidak diketahui → tipis & putus-putus dengan teks USD_UNKNOWN (bukan dianggap $0).
// - isSimulated per benang = token simulasi ATAU salah satu tx/peristiwanya simulasi (tidak pernah tampil live).

import { splitHash } from '../lib/router.js';
import { CHAIN_LABELS, USD_UNKNOWN, clampScore, normalizeAddress, shortAddress, stateLabel } from './smartMoneyFormat.js';

export const THREADS_DEFAULTS = Object.freeze({ maxTokens: 12, maxWallets: 40 });
/** Rentang tebal benang (px) untuk skala log nilai USD. */
export const STRAND_WIDTH = Object.freeze({ min: 1.25, max: 6 });
/** Nilai USD yang mencapai tebal maksimum (sama dengan flowSaturationUsd radar.js). */
export const STRAND_USD_SATURATION = 1_000_000;
/** Tinggi slot token dalam satuan baris wallet (node token memuat dua–tiga baris teks). */
export const TOKEN_SLOT = 2;
/** Jarak tambahan (satuan baris) di sekitar blok klaster agar kelompoknya terbaca. */
export const CLUSTER_GAP = 0.6;

/** Tampilan hasil radar: kartu (bawaan) atau peta benang. */
export const RADAR_VIEWS = Object.freeze(['daftar', 'benang']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round = (v, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const count = (v) => (isNum(v) && v > 0 ? Math.floor(v) : 0);
const time = (v) => (isNum(v) ? v : null);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const limitOf = (v, fallback) => (Number.isInteger(v) && v > 0 ? v : fallback);

/** Skor turun; null (tidak diketahui) selalu di akhir. */
const scoreDesc = (x, y) => (x === null ? (y === null ? 0 : 1) : y === null ? -1 : y - x);

// ---------------------------------------------------------------- tampilan radar (hash)

/**
 * Tampilan hasil radar dari query hash (#/smart-money?view=benang). Nilai lain → 'daftar'.
 * @param {URLSearchParams|null|undefined} query
 * @returns {'daftar'|'benang'}
 */
export function parseRadarView(query) {
  return query?.get?.('view') === 'benang' ? 'benang' : 'daftar';
}

/**
 * Hash halaman radar dengan parameter `view` diganti ('daftar' = parameter dihapus). Parameter lain (filter dari
 * tautan) dipertahankan. Dipakai bersama history.replaceState: URL dapat dibagikan tanpa memicu hashchange.
 * @param {string} hash mis. '#/smart-money?window=4h'
 * @param {'daftar'|'benang'} view
 */
export function radarViewHash(hash, view) {
  const { path, query } = splitHash(hash);
  if (view === 'benang') query.set('view', 'benang');
  else query.delete('view');
  const qs = query.toString();
  return `#${path || '/smart-money'}${qs ? `?${qs}` : ''}`;
}

// ---------------------------------------------------------------- tebal benang

/**
 * Bobot 0..1 skala log |USD| (jenuh pada STRAND_USD_SATURATION); null bila USD tidak diketahui.
 * @param {number|null|undefined} usd
 */
export function strandWeight(usd) {
  if (!isNum(usd)) return null;
  return round(Math.min(1, Math.log10(1 + Math.abs(usd)) / Math.log10(1 + STRAND_USD_SATURATION)));
}

/** Tebal benang (px): log |USD| dijepit STRAND_WIDTH; USD tidak diketahui → tebal minimum. */
export function strandWidth(usd) {
  const w = strandWeight(usd);
  return round(STRAND_WIDTH.min + (STRAND_WIDTH.max - STRAND_WIDTH.min) * (w ?? 0), 3);
}

// ---------------------------------------------------------------- normalisasi masukan

/** Alamat kanonik untuk identitas (EVM → huruf kecil); format tak dikenal dipakai apa adanya. */
function canonAddress(chain, address) {
  const raw = text(address);
  if (!raw) return null;
  return normalizeAddress(chain, raw) ?? raw;
}

function labelOf(label) {
  const list = Array.isArray(label) ? label : [label];
  const found = list.find((l) => l && typeof l === 'object' && text(l.label));
  return found ? { label: text(found.label), category: text(found.category), source: text(found.source) } : null;
}

const isSimTx = (t) => t?.isSimulated === true;

function normalizeTx(t) {
  return {
    txHash: text(t.txHash),
    explorerUrl: text(t.explorerUrl),
    type: text(t.type),
    at: time(t.at),
    usd: isNum(t.usd) ? t.usd : null,
    isSimulated: t.isSimulated === true,
  };
}

function normalizeExit(e) {
  return {
    type: text(e.type),
    at: time(e.at),
    usd: isNum(e.usd) ? e.usd : null,
    txHash: text(e.txHash),
    explorerUrl: text(e.explorerUrl),
    via: text(e.via),
    note: text(e.note),
    isSimulated: e.isSimulated === true,
  };
}

/** Item radar → token ternormalisasi, atau null bila identitasnya tidak dapat ditentukan. */
function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const rawKey = text(item.tokenKey);
  const sep = rawKey ? rawKey.indexOf(':') : -1;
  const chain = text(item.chain) ?? (sep > 0 ? rawKey.slice(0, sep) : null);
  if (!chain) return null;
  const address = canonAddress(chain, item.token?.address) ?? (sep > 0 ? rawKey.slice(sep + 1) : null);
  const id = rawKey ?? (address ? `${chain}:${address}` : null);
  if (!id || !address) return null;

  const buyers = new Map();
  for (const b of Array.isArray(item.buyers) ? item.buyers : []) {
    if (!b || typeof b !== 'object') continue;
    const addr = canonAddress(chain, b.wallet);
    if (!addr || buyers.has(addr)) continue;
    buyers.set(addr, {
      address: addr,
      score: isNum(b.score) ? b.score : null,
      clusterId: text(b.clusterId),
      netBuyUsd: isNum(b.netBuyUsd) ? b.netBuyUsd : null,
      buys: count(b.buys),
      sells: count(b.sells),
      firstBuyAt: time(b.firstBuyAt),
      lastBuyAt: time(b.lastBuyAt),
      txs: (Array.isArray(b.txs) ? b.txs : []).filter((t) => t && typeof t === 'object').map(normalizeTx),
      label: labelOf(b.label),
    });
  }
  const exits = new Map();
  for (const e of Array.isArray(item.exitSignals) ? item.exitSignals : []) {
    if (!e || typeof e !== 'object') continue;
    const addr = canonAddress(chain, e.wallet);
    if (!addr) continue;
    if (!exits.has(addr)) exits.set(addr, []);
    exits.get(addr).push(normalizeExit(e));
  }
  return {
    id,
    chain,
    address,
    symbol: text(item.token?.symbol),
    name: text(item.token?.name),
    conviction: clampScore(item.conviction),
    state: text(item.state),
    binance: item.binance && typeof item.binance === 'object' ? item.binance : null,
    independentBuyers: isNum(item.independentBuyers) ? item.independentBuyers : null,
    buyerCount: isNum(item.buyerCount) ? item.buyerCount : null,
    isSimulated: item.isSimulated === true,
    buyers,
    exits,
  };
}

// ---------------------------------------------------------------- benang

/** Jalur keluar dari peristiwa: SWAP (jual via swap), CEX (dipindah ke exchange), MIXED, atau null. */
function exitViaOf(events) {
  const vias = new Set();
  for (const e of events) {
    if (e.type === 'SWAP_SELL') vias.add('SWAP');
    else if (e.type === 'CEX_DEPOSIT') vias.add('CEX');
    else if (e.via === 'SWAP' || e.via === 'CEX') vias.add(e.via);
    else if (e.via === 'MIXED') {
      vias.add('SWAP');
      vias.add('CEX');
    }
  }
  if (vias.size === 0) return null;
  return vias.size === 1 ? [...vias][0] : 'MIXED';
}

/**
 * Nilai USD indikasi keluar: jumlah peristiwa SWAP_SELL/CEX_DEPOSIT (FULL_EXIT hanya ringkasan peristiwa yang sama,
 * tidak dijumlah ganda — dipakai hanya bila tidak ada peristiwa lain). null bila ada nilai yang tidak diketahui.
 */
function exitUsdOf(events) {
  const parts = events.filter((e) => e.type !== 'FULL_EXIT');
  const list = parts.length ? parts : events;
  if (!list.length || list.some((e) => !isNum(e.usd))) return null;
  return list.reduce((s, e) => s + e.usd, 0);
}

function makeStrand(wallet, link) {
  const { token, buyer, exits } = link;
  const kind = buyer ? 'BUY' : 'EXIT';
  const usd = buyer ? buyer.netBuyUsd : exitUsdOf(exits);
  const usdKnown = isNum(usd);
  const sellEvents = exits.filter((e) => e.type === 'SWAP_SELL').length;
  const deposits = exits.filter((e) => e.type === 'CEX_DEPOSIT').length;
  return {
    id: `${wallet.id}>${token.id}`,
    walletId: wallet.id,
    tokenId: token.id,
    chain: token.chain,
    wallet: wallet.address,
    tokenAddress: token.address,
    kind,
    mixed: kind === 'BUY' && buyer.sells > 0,
    hasExit: exits.length > 0,
    exitVia: exitViaOf(exits),
    fullExit: exits.some((e) => e.type === 'FULL_EXIT'),
    usd: usdKnown ? usd : null,
    usdKnown,
    usdText: usdKnown ? null : USD_UNKNOWN,
    weight: strandWeight(usd),
    width: strandWidth(usd),
    dashed: !usdKnown,
    buys: buyer ? buyer.buys : 0,
    sells: buyer ? buyer.sells : sellEvents,
    deposits,
    firstBuyAt: buyer ? buyer.firstBuyAt : null,
    lastBuyAt: buyer ? buyer.lastBuyAt : null,
    txs: buyer ? buyer.txs : [],
    exits,
    isSimulated: token.isSimulated || (buyer ? buyer.txs.some(isSimTx) : false) || exits.some(isSimTx),
  };
}

// ---------------------------------------------------------------- posisi

/**
 * Regresi isotonik berbobot (pool adjacent violators): deret tidak turun yang meminimalkan Σ w·(x − target)².
 * @param {number[]} targets
 * @param {number[]} weights
 */
function isotonic(targets, weights) {
  const blocks = [];
  for (let i = 0; i < targets.length; i += 1) {
    blocks.push({ sum: targets[i] * weights[i], w: weights[i], n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.w <= b.sum / b.w) break;
      a.sum += b.sum;
      a.w += b.w;
      a.n += b.n;
      blocks.pop();
    }
  }
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.n; k += 1) out.push(b.sum / b.w);
  return out;
}

const mean = (list) => list.reduce((s, v) => s + v, 0) / list.length;

// ---------------------------------------------------------------- tata letak

/**
 * Tata letak Peta Benang dari item radar.
 * @param {object[]} items RadarToken & { binance, isSimulated, buyers[].label } (respons GET /radar)
 * @param {{ maxTokens?: number, maxWallets?: number }} [options]
 * @returns {{
 *   tokens: object[], wallets: object[], strands: object[], clusters: object[], height: number,
 *   shown: { tokens: number, wallets: number, strands: number }, totals: { tokens: number, wallets: number },
 *   hidden: { tokens: number, wallets: number }, isSimulated: boolean }}
 *   tokens/wallets terurut posisi (y dalam satuan baris, titik tengah slot); height = tinggi total satuan baris.
 */
export function buildThreadsLayout(items, { maxTokens = THREADS_DEFAULTS.maxTokens, maxWallets = THREADS_DEFAULTS.maxWallets } = {}) {
  const maxT = limitOf(maxTokens, THREADS_DEFAULTS.maxTokens);
  const maxW = limitOf(maxWallets, THREADS_DEFAULTS.maxWallets);

  // Token: urut keyakinan turun lalu tokenKey; duplikat tokenKey → entri berkeyakinan tertinggi.
  const all = [];
  const seen = new Set();
  const sorted = (Array.isArray(items) ? items : []).map(normalizeItem).filter(Boolean)
    .sort((a, b) => ((b.conviction ?? -1) - (a.conviction ?? -1)) || cmp(a.id, b.id));
  for (const t of sorted) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    all.push(t);
  }

  // Total wallet & anggota klaster di seluruh respons (untuk hitungan tersembunyi yang jujur).
  const allWallets = new Set();
  const clusterMembers = new Map();
  for (const t of all) {
    for (const b of t.buyers.values()) {
      const wid = `${t.chain}:${b.address}`;
      allWallets.add(wid);
      if (b.clusterId) {
        const ck = `${t.chain}|${b.clusterId}`;
        if (!clusterMembers.has(ck)) clusterMembers.set(ck, new Set());
        clusterMembers.get(ck).add(wid);
      }
    }
    for (const address of t.exits.keys()) allWallets.add(`${t.chain}:${address}`);
  }

  const kept = all.slice(0, maxT);
  const walletMap = new Map();
  const walletOf = (chain, address) => {
    const id = `${chain}:${address}`;
    if (!walletMap.has(id)) {
      walletMap.set(id, { id, chain, address, score: null, label: null, clusterId: null, links: new Map() });
    }
    return walletMap.get(id);
  };
  kept.forEach((token, tokenIndex) => {
    for (const b of token.buyers.values()) {
      const w = walletOf(token.chain, b.address);
      if (b.score !== null && (w.score === null || b.score > w.score)) w.score = b.score;
      w.label ??= b.label;
      w.clusterId ??= b.clusterId;
      w.links.set(token.id, { token, tokenIndex, buyer: b, exits: token.exits.get(b.address) ?? [] });
    }
    for (const [address, events] of token.exits) {
      const w = walletOf(token.chain, address);
      if (!w.links.has(token.id)) w.links.set(token.id, { token, tokenIndex, buyer: null, exits: events });
    }
  });

  const shown = [...walletMap.values()]
    .sort((a, b) => scoreDesc(a.score, b.score) || cmp(a.address, b.address) || cmp(a.chain, b.chain))
    .slice(0, maxW);
  for (const w of shown) w.bary = mean([...w.links.values()].map((l) => l.tokenIndex));

  // Blok klaster: wallet satu klaster yang tampil ≥ 2 → berdampingan.
  const shownPerCluster = new Map();
  for (const w of shown) {
    if (!w.clusterId) continue;
    const ck = `${w.chain}|${w.clusterId}`;
    shownPerCluster.set(ck, (shownPerCluster.get(ck) ?? 0) + 1);
  }
  const unitMap = new Map();
  for (const w of shown) {
    const ck = w.clusterId ? `${w.chain}|${w.clusterId}` : null;
    const group = ck !== null && shownPerCluster.get(ck) >= 2;
    const key = group ? `c|${ck}` : `w|${w.id}`;
    if (!unitMap.has(key)) unitMap.set(key, { key, clusterKey: group ? ck : null, members: [] });
    unitMap.get(key).members.push(w);
  }
  const memberOrder = (a, b) => (a.bary - b.bary) || scoreDesc(a.score, b.score) || cmp(a.address, b.address) || cmp(a.chain, b.chain);
  const units = [...unitMap.values()];
  for (const u of units) {
    u.members.sort(memberOrder);
    u.bary = mean(u.members.map((m) => m.bary));
    u.best = u.members.reduce((best, m) => (m.score !== null && (best === null || m.score > best) ? m.score : best), null);
    u.minId = u.members.map((m) => m.id).sort(cmp)[0];
  }
  units.sort((a, b) => (a.bary - b.bary) || scoreDesc(a.best, b.best) || cmp(a.minId, b.minId));

  // Posisi y (satuan baris).
  const T = kept.length;
  const starts = [];
  let cursor = 0;
  units.forEach((u, k) => {
    if (k > 0 && (u.clusterKey || units[k - 1].clusterKey)) cursor += CLUSTER_GAP;
    starts.push(cursor);
    cursor += u.members.length;
  });
  const walletSpan = cursor;
  const height = round(Math.max(walletSpan, T * TOKEN_SLOT, 1));
  const tokenY = (j) => ((j + 0.5) * height) / Math.max(1, T);
  const desired = (w) => mean([...w.links.values()].map((l) => tokenY(l.tokenIndex)));
  const targets = units.map((u, k) => mean(u.members.map((m, i) => desired(m) - i)) - starts[k]);
  const fit = isotonic(targets, units.map((u) => u.members.length));
  const firstY = units.map((u, k) => fit[k] + starts[k]);
  if (units.length) {
    let shift = 0;
    if (firstY[0] < 0.5) shift = 0.5 - firstY[0];
    const last = units.length - 1;
    const lastCenter = firstY[last] + shift + units[last].members.length - 1;
    if (lastCenter > height - 0.5) shift += (height - 0.5) - lastCenter;
    for (let k = 0; k < firstY.length; k += 1) firstY[k] += shift;
  }

  // Klaster tampil: K1, K2, … menurut urutan dari atas.
  const clusters = [];
  const wallets = [];
  units.forEach((u, k) => {
    let group = null;
    if (u.clusterKey) {
      group = {
        id: `K${clusters.length + 1}`,
        key: u.clusterKey,
        chain: u.members[0].chain,
        clusterId: u.members[0].clusterId,
        walletIds: u.members.map((m) => m.id),
        size: u.members.length,
        totalSize: clusterMembers.get(u.clusterKey)?.size ?? u.members.length,
        y0: round(firstY[k]),
        y1: round(firstY[k] + u.members.length - 1),
      };
      clusters.push(group);
    }
    u.members.forEach((m, i) => {
      const total = m.clusterId ? clusterMembers.get(`${m.chain}|${m.clusterId}`)?.size ?? 1 : 1;
      wallets.push({
        id: m.id,
        chain: m.chain,
        address: m.address,
        score: m.score,
        label: m.label,
        clusterId: m.clusterId,
        group: group ? group.id : null,
        groupSize: group ? group.size : 1,
        // Wallet tertaut yang pasangannya tidak tampil (batas maxWallets / token tersembunyi).
        linkedHidden: group ? Math.max(0, total - group.size) : Math.max(0, total - 1),
        index: wallets.length,
        y: round(firstY[k] + i),
        barycenter: round(m.bary),
        tokenIds: [...m.links.values()].sort((a, b) => a.tokenIndex - b.tokenIndex).map((l) => l.token.id),
      });
    });
  });

  const shownIds = new Set(wallets.map((w) => w.id));
  const strands = [];
  for (const w of wallets) {
    const source = walletMap.get(w.id);
    for (const link of [...source.links.values()].sort((a, b) => a.tokenIndex - b.tokenIndex)) strands.push(makeStrand(source, link));
  }

  const symbolCounts = new Map();
  for (const t of kept) {
    const s = (t.symbol ?? '?').toUpperCase();
    symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
  }
  const tokens = kept.map((t, j) => {
    const ids = new Set([...t.buyers.keys(), ...t.exits.keys()].map((a) => `${t.chain}:${a}`));
    const linked = strands.filter((s) => s.tokenId === t.id);
    return {
      id: t.id,
      chain: t.chain,
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      symbolShared: (symbolCounts.get((t.symbol ?? '?').toUpperCase()) ?? 0) > 1,
      conviction: t.conviction,
      state: t.state,
      binance: t.binance,
      independentBuyers: t.independentBuyers,
      buyerCount: t.buyerCount,
      isSimulated: t.isSimulated,
      index: j,
      y: round(tokenY(j)),
      walletCount: linked.length,
      buyStrands: linked.filter((s) => s.kind === 'BUY').length,
      exitStrands: linked.filter((s) => s.kind === 'EXIT').length,
      hiddenWallets: [...ids].filter((id) => !shownIds.has(id)).length,
    };
  });

  return {
    tokens,
    wallets,
    strands,
    clusters,
    height,
    shown: { tokens: tokens.length, wallets: wallets.length, strands: strands.length },
    totals: { tokens: all.length, wallets: allWallets.size },
    hidden: { tokens: all.length - tokens.length, wallets: allWallets.size - wallets.length },
    isSimulated: tokens.some((t) => t.isSimulated) || strands.some((s) => s.isSimulated),
  };
}

// ---------------------------------------------------------------- teks ringkasan

/** "Menampilkan X dari Y token · A dari B wallet". */
export function threadsCountText(layout) {
  return `Menampilkan ${layout.shown.tokens} dari ${layout.totals.tokens} token · ${layout.shown.wallets} dari ${layout.totals.wallets} wallet`;
}

/** Nama tampilan token: simbol, ditambah kontrak pendek bila simbolnya dipakai lebih dari satu token tampil. */
export function tokenDisplayName(token, { compact = false } = {}) {
  const sym = token.symbol ?? '?';
  if (!token.symbolShared) return sym;
  return compact ? `${sym}·${token.address.slice(-4)}` : `${sym} (${shortAddress(token.address)})`;
}

/**
 * Ringkasan teks peta untuk pembaca layar (alternatif teks graf), satu kalimat per token lalu per klaster.
 * @returns {string[]}
 */
export function threadsSummaryLines(layout) {
  const lines = [`Peta Benang: ${layout.shown.tokens} token, ${layout.shown.wallets} wallet, ${layout.shown.strands} benang. ${threadsCountText(layout)}.`];
  for (const t of layout.tokens) {
    const chain = CHAIN_LABELS[t.chain] ?? t.chain;
    const conv = t.conviction === null ? 'skor keyakinan tidak diketahui' : `skor keyakinan ${t.conviction} dari 100 (bukan probabilitas)`;
    const exits = t.exitStrands ? `, ${t.exitStrands} wallet dengan indikasi keluar saja` : '';
    const hidden = t.hiddenWallets ? `, ${t.hiddenWallets} wallet tidak ditampilkan` : '';
    lines.push(`${t.symbol ?? '?'} (${chain}, kontrak ${shortAddress(t.address)}): ${conv}, status ${stateLabel(t.state).label}; ${t.buyStrands} wallet membeli lewat swap${exits}${hidden}.`);
  }
  for (const c of layout.clusters) {
    lines.push(`Klaster ${c.id}: ${c.size} wallet terkait di ${CHAIN_LABELS[c.chain] ?? c.chain} — dihitung sebagai 1 pembeli independen.`);
  }
  return lines;
}
