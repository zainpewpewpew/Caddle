// PnL wallet FIFO per token (kontrak docs/15-kontrak-smart-money.md §2 `pnl.js`).
// Fungsi murni: tanpa I/O, tanpa Date.now() — waktu "sekarang" selalu dari argumen `now`.
//
// ─── Aturan ─────────────────────────────────────────────────────────────────────────────────────────
// - Masukan di-dedupe per `activity.id` (baris pertama dipertahankan) lalu diurutkan deterministik sehingga data yang
//   datang terlambat / tidak berurutan memberi hasil identik dengan data berurutan. Urutan: `blockTime`, lalu (per
//   kelompok aktivitas ber-blockTime sama) `blockNumber` bila SEMUA anggota kelompok memilikinya dan satu chain, lalu
//   `logIndex` on-chain bila semua anggota juga memilikinya (chain EVM — logIndex EVM berurutan dalam satu blok;
//   indeks sintetis ≥ SYNTHETIC_LOG_INDEX_MIN tidak dihitung), selain itu aktivitas MASUK sebelum KELUAR (tanpa
//   urutan on-chain, jual tidak mungkin mendahului beli yang membiayainya — FIFO tidak pernah lebih buruk dengan
//   urutan ini), lalu `id`. Keputusan diambil per kelompok agar pembanding tetap transitif.
// - Identitas posisi = tokenKey(chain, alamat token) — simbol sama di kontrak berbeda = posisi berbeda.
// - Aset quote (native, wrapped native, stablecoin — QUOTE_ASSETS) TIDAK dihitung sebagai posisi: aset ini alat
//   bayar, umumnya masuk lewat exchange (biaya tidak diketahui) sehingga akan merusak completenessRatio wallet
//   tanpa memberi informasi tentang keahlian trading. Aktivitas UNKNOWN tidak mengubah lot, tetapi menandai posisi
//   PARTIAL karena saldo sebenarnya tidak pasti.
// - SWAP_BUY → lot berbiaya `usdValue` (null → lot berbiaya tidak diketahui). UNKNOWN_COST_IN_TYPES → lot berbiaya
//   tidak diketahui; AIRDROP/MINT ber-origin 'AIRDROP'.
// - SWAP_SELL mengonsumsi lot FIFO:
//     lot berbiaya diketahui & hasil jual diketahui → realized PnL + closedTrade;
//     lot berbiaya diketahui, hasil jual null       → unknownProceedsSoldQty (tidak direalisasikan);
//     lot berbiaya tidak diketahui                   → unknownCostSoldQty (bukan profit); bila lot ber-origin AIRDROP
//                                                      dan hasil jual diketahui → airdropRealizedUsd (= hasil jual,
//                                                      biaya dianggap tidak ada, dilaporkan TERPISAH);
//     melebihi saldo terlihat (histori terpotong)    → unknownCostSoldQty + catatan.
// - MOVE_OUT_TYPES mengonsumsi lot FIFO tanpa realisasi (movedOutQty). Kelebihan di atas saldo terlihat diabaikan
//   dengan catatan.
// - Unrealized = harga × knownCostQty − costBasisUsd; null bila ada lot berbiaya diketahui tetapi tidak ada harga.
//   Posisi tanpa lot berbiaya diketahui → unrealized 0 (tidak ada yang dinilai). Harga dengan `at > now` diabaikan
//   (tanpa look-ahead). Harga lebih tua dari 24 jam terhadap `now` → `stalePrice: true` (tetap dipakai, ditandai).
// - returnPct dalam PERSEN (pnl / biaya × 100); null bila biaya 0.
//
// ─── closedTrades vs roundTrips ─────────────────────────────────────────────────────────────────────
// `closedTrades` = POTONGAN lot FIFO (satu baris per lot yang dikonsumsi satu penjualan) — rincian audit. 10 beli kecil
// lalu 1 jual = 10 potongan, sehingga potongan TIDAK boleh dihitung sebagai jumlah trade.
// `roundTrips` (aditif) = trade di tingkat POSISI, dasar penilaian walletScore/walletFlags:
//   - Episode posisi per token dibuka saat saldo naik dari ~0 dan ditutup saat saldo kembali ≤ ROUND_TRIP_DUST_RATIO
//     (1 %) dari saldo puncak episode (atau lot habis). Semua potongan realisasi di episode itu = SATU round trip.
//   - Penjualan sisa debu setelah episode ditutup (sebelum beli baru membuka episode baru) digabung ke round trip
//     terakhir token itu (n tidak bertambah; closeAt tetap waktu keluar utama).
//   - Episode yang tidak pernah kembali datar (posisi masih terbuka di akhir data) → satu round trip per TRANSAKSI
//     JUAL (gabungan potongan lot yang dikonsumsi penjualan itu).
//   - Agregasi berbobot biaya: costUsd/proceedsUsd/pnlUsd/qty = jumlah potongan, returnPct = pnlUsd / costUsd × 100,
//     holdMs = rata-rata lama pegang potongan berbobot biaya, openAt = potongan terawal, closeAt = penjualan terakhir.
//   Bentuk: { tokenKey, openAt, closeAt, qty, costUsd, proceedsUsd, pnlUsd, returnPct, holdMs, fragments, sellCount,
//   closedFlat } — field closedTrades + jumlah potongan, jumlah transaksi jual, dan apakah posisi kembali datar.
//
// ─── completenessRatio ──────────────────────────────────────────────────────────────────────────────
// Bagian penjualan yang biaya & hasilnya diketahui, ditimbang NILAI USD hasil jual (kuantitas token berbeda tidak pernah
// dijumlahkan lintas token — 1e9 unit token receh ≠ 100 unit token mahal): Σ hasil jual potongan berbiaya diketahui /
// Σ hasil jual. Bila ada penjualan tanpa nilai USD, bobot USD tidak lengkap → rata-rata rasio kuantitas PER TOKEN
// (rasio dalam satu token bermakna). `summary.completenessBasis` (aditif): 'USD' | 'TOKEN_AVERAGE' | 'NONE'
// (tanpa penjualan → rasio 1: tidak ada realisasi yang tidak lengkap; kelengkapan saldo terbuka dilaporkan lewat
// `completeness`).
// - Kuantitas dibandingkan dengan toleransi relatif 1e-9 agar sisa pembulatan floating-point tidak menjadi lot hantu.

import {
  MOVE_OUT_TYPES, SYNTHETIC_LOG_INDEX_MIN, UNKNOWN_COST_IN_TYPES, isEvmChain, isQuoteAsset, tokenKey as makeTokenKey,
} from './contracts.js';

export const STALE_PRICE_MS = 24 * 3_600_000;
/** Saldo ≤ porsi ini dari saldo puncak episode dianggap datar (debu/sisa pembulatan) — episode round trip ditutup. */
export const ROUND_TRIP_DUST_RATIO = 0.01;
const EPS_REL = 1e-9;
const AIRDROP_ORIGIN_TYPES = new Set(['AIRDROP', 'MINT']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function tolerance(scale) {
  return EPS_REL * Math.max(Math.abs(scale), Number.MIN_VALUE);
}

const hasBlockNumber = (a) => Number.isInteger(a.blockNumber) && a.blockNumber >= 0;
const hasOnchainLogIndex = (a) => Number.isInteger(a.logIndex) && a.logIndex >= 0 && a.logIndex < SYNTHETIC_LOG_INDEX_MIN;

/**
 * Urutan deterministik (lihat catatan "Aturan"): kunci urut dihitung per kelompok blockTime agar pembanding transitif
 * walau sebagian aktivitas tidak membawa blockNumber/logIndex.
 */
function orderActivities(acts) {
  const groups = new Map();
  for (const a of acts) {
    const g = groups.get(a.blockTime);
    if (g) g.push(a);
    else groups.set(a.blockTime, [a]);
  }
  const keyed = [];
  for (const g of groups.values()) {
    const oneChain = g.every((a) => a.chain === g[0].chain);
    const useBlock = oneChain && g.every(hasBlockNumber);
    const useLog = useBlock && isEvmChain(g[0].chain) && g.every(hasOnchainLogIndex);
    for (const a of g) {
      keyed.push({
        a,
        bn: useBlock ? a.blockNumber : 0,
        li: useLog ? a.logIndex : 0,
        dir: useLog || a.direction === 'IN' ? 0 : 1,
      });
    }
  }
  keyed.sort((x, y) => x.a.blockTime - y.a.blockTime || x.bn - y.bn || x.li - y.li || x.dir - y.dir || cmpStr(x.a.id, y.a.id));
  return keyed.map((k) => k.a);
}

function newState(key, act) {
  return {
    tokenKey: key,
    token: { ...act.token },
    lots: [],
    heldQty: 0,
    realizedPnlUsd: 0,
    airdropRealizedUsd: 0,
    buys: 0,
    sells: 0,
    firstBuyAt: null,
    lastActivityAt: act.blockTime,
    soldQty: 0,
    knownSoldQty: 0,
    soldProceedsUsd: 0,
    completeProceedsUsd: 0,
    unknownUsdSells: 0,
    unknownCostSoldQty: 0,
    unknownProceedsSoldQty: 0,
    oversoldQty: 0,
    movedOutQty: 0,
    unknownActivities: 0,
    knownCostBuys: 0,
    episode: null,
    lastRoundTrip: null,
    notes: new Set(),
  };
}

/** Konsumsi lot FIFO sebanyak qty; callback per potongan. Mengembalikan sisa yang tidak tertutup lot. */
function consumeLots(state, qty, onPortion) {
  let remaining = qty;
  const tol = tolerance(qty);
  while (remaining > tol && state.lots.length > 0) {
    const lot = state.lots[0];
    const take = Math.min(lot.qty, remaining);
    onPortion(lot, take);
    lot.qty -= take;
    remaining -= take;
    if (lot.qty <= tolerance(lot.initialQty)) state.lots.shift();
  }
  const rest = remaining > tol ? remaining : 0;
  state.heldQty = state.lots.length === 0 ? 0 : Math.max(0, state.heldQty - (qty - rest));
  return rest;
}

/** Agregasi potongan lot (berbobot biaya) — dasar satu round trip. */
function aggregateFragments(fragments) {
  let qty = 0; let costUsd = 0; let proceedsUsd = 0; let pnlUsd = 0;
  let openAt = Infinity; let closeAt = -Infinity; let holdWeighted = 0; let holdSum = 0;
  for (const f of fragments) {
    qty += f.qty;
    costUsd += f.costUsd;
    proceedsUsd += f.proceedsUsd;
    pnlUsd += f.pnlUsd;
    if (f.openAt < openAt) openAt = f.openAt;
    if (f.closeAt > closeAt) closeAt = f.closeAt;
    holdWeighted += f.holdMs * f.costUsd;
    holdSum += f.holdMs;
  }
  return {
    qty, costUsd, proceedsUsd, pnlUsd, openAt, closeAt,
    returnPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : null,
    holdMs: costUsd > 0 ? holdWeighted / costUsd : holdSum / fragments.length,
  };
}

function makeRoundTrip(tokenKey, fragments, { sellCount, closedFlat }) {
  const g = aggregateFragments(fragments);
  return {
    tokenKey, openAt: g.openAt, closeAt: g.closeAt, qty: g.qty, costUsd: g.costUsd, proceedsUsd: g.proceedsUsd,
    pnlUsd: g.pnlUsd, returnPct: g.returnPct, holdMs: g.holdMs, fragments: fragments.length, sellCount, closedFlat,
  };
}

/**
 * Hitung PnL wallet (FIFO per token).
 * @param {object[]} activities Activity[] satu wallet (urutan bebas, boleh duplikat)
 * @param {{ prices?: Map<string, { priceUsd: number, at: number, source?: string }>, now: number }} opts
 * @returns {{ positions: object[], closedTrades: object[], roundTrips: object[], summary: object }}
 *   `roundTrips` (aditif) = trade tingkat posisi (lihat catatan modul); `closedTrades` = potongan lot FIFO.
 */
export function computeWalletPnl(activities, { prices, now } = {}) {
  if (!isNum(now)) throw new TypeError('computeWalletPnl: argumen `now` (epoch ms) wajib diisi');
  const priceMap = prices && typeof prices.get === 'function' ? prices : new Map();

  // Dedupe per id (baris pertama dipertahankan) + urutan deterministik (lihat orderActivities).
  const seen = new Set();
  let duplicateCount = 0;
  const unique = [];
  for (const a of activities ?? []) {
    if (!a || typeof a !== 'object') continue;
    if (seen.has(a.id)) { duplicateCount += 1; continue; }
    seen.add(a.id);
    unique.push(a);
  }
  const acts = orderActivities(unique);

  const states = new Map();
  const closedTrades = [];
  const roundTrips = [];
  const roundTripFragments = new Map(); // round trip → potongan (untuk penggabungan sisa debu)
  let skippedInvalid = 0;
  let totalCostUsd = 0;
  let quoteSkipped = 0;

  const closeEpisode = (s) => {
    const ep = s.episode;
    s.episode = null;
    s.lastRoundTrip = null; // episode tanpa realisasi (mis. dipindah keluar) tidak menerima penjualan sisa debu
    if (ep.fragments.length === 0) return;
    const rt = makeRoundTrip(s.tokenKey, ep.fragments, { sellCount: ep.sells.length, closedFlat: true });
    roundTrips.push(rt);
    roundTripFragments.set(rt, ep.fragments);
    s.lastRoundTrip = rt;
  };

  for (const a of acts) {
    if (!a.token || !a.chain || !isNum(a.amount) || a.amount <= 0 || !isNum(a.blockTime)) { skippedInvalid += 1; continue; }
    if (isQuoteAsset(a.chain, a.token.address)) { quoteSkipped += 1; continue; }
    const key = makeTokenKey(a.chain, a.token.address);
    let s = states.get(key);
    if (!s) { s = newState(key, a); states.set(key, s); }
    s.lastActivityAt = Math.max(s.lastActivityAt, a.blockTime);
    const usd = isNum(a.usdValue) ? a.usdValue : null;
    const openLot = (lot) => {
      if (s.episode === null) s.episode = { fragments: [], sells: [], peakQty: 0 };
      s.lots.push(lot);
      s.heldQty += lot.qty;
      if (s.heldQty > s.episode.peakQty) s.episode.peakQty = s.heldQty;
    };

    if (a.type === 'SWAP_BUY') {
      s.buys += 1;
      if (s.firstBuyAt === null) s.firstBuyAt = a.blockTime;
      if (usd !== null) { s.knownCostBuys += 1; totalCostUsd += usd; } else {
        s.notes.add('Ada pembelian tanpa nilai USD — lot berbiaya tidak diketahui');
      }
      openLot({ qty: a.amount, initialQty: a.amount, unitCost: usd === null ? null : usd / a.amount, origin: 'BUY', openAt: a.blockTime });
    } else if (UNKNOWN_COST_IN_TYPES.includes(a.type)) {
      const origin = AIRDROP_ORIGIN_TYPES.has(a.type) ? 'AIRDROP' : 'UNKNOWN';
      openLot({ qty: a.amount, initialQty: a.amount, unitCost: null, origin, openAt: a.blockTime });
    } else if (a.type === 'SWAP_SELL') {
      s.sells += 1;
      s.soldQty += a.amount;
      if (usd === null) s.unknownUsdSells += 1;
      else s.soldProceedsUsd += usd;
      const unitProceeds = usd === null ? null : usd / a.amount;
      if (unitProceeds === null) s.notes.add('Ada penjualan tanpa nilai USD — hasil jual tidak diketahui, PnL tidak direalisasikan');
      const fragments = [];
      const rest = consumeLots(s, a.amount, (lot, q) => {
        if (lot.unitCost === null) {
          s.unknownCostSoldQty += q;
          if (lot.origin === 'AIRDROP' && unitProceeds !== null) s.airdropRealizedUsd += q * unitProceeds;
          return;
        }
        if (unitProceeds === null) { s.unknownProceedsSoldQty += q; return; }
        const costUsd = q * lot.unitCost;
        const proceedsUsd = q * unitProceeds;
        const pnlUsd = proceedsUsd - costUsd;
        s.realizedPnlUsd += pnlUsd;
        s.knownSoldQty += q;
        s.completeProceedsUsd += proceedsUsd;
        const trade = {
          tokenKey: key, openAt: lot.openAt, closeAt: a.blockTime, qty: q, costUsd, proceedsUsd, pnlUsd,
          returnPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : null, holdMs: a.blockTime - lot.openAt,
        };
        closedTrades.push(trade);
        fragments.push(trade);
      });
      if (rest > 0) {
        s.unknownCostSoldQty += rest;
        s.oversoldQty += rest;
        s.notes.add('Penjualan melebihi saldo yang terlihat — histori kemungkinan terpotong; sisanya dianggap berbiaya tidak diketahui');
      }
      if (fragments.length > 0) {
        if (s.episode === null && s.lastRoundTrip !== null) {
          // Penjualan sisa debu episode yang sudah ditutup → gabung ke round trip terakhir (closeAt tetap).
          const rt = s.lastRoundTrip;
          const all = roundTripFragments.get(rt);
          for (const f of fragments) all.push(f);
          const g = aggregateFragments(all);
          Object.assign(rt, {
            qty: g.qty, costUsd: g.costUsd, proceedsUsd: g.proceedsUsd, pnlUsd: g.pnlUsd, returnPct: g.returnPct,
            holdMs: g.holdMs, openAt: g.openAt, fragments: all.length, sellCount: rt.sellCount + 1,
          });
        } else {
          if (s.episode === null) s.episode = { fragments: [], sells: [], peakQty: s.heldQty };
          for (const f of fragments) s.episode.fragments.push(f);
          s.episode.sells.push({ fragments });
        }
      }
      if (s.episode !== null && (s.lots.length === 0 || s.heldQty <= ROUND_TRIP_DUST_RATIO * s.episode.peakQty)) closeEpisode(s);
    } else if (MOVE_OUT_TYPES.includes(a.type)) {
      s.movedOutQty += a.amount;
      const rest = consumeLots(s, a.amount, () => {});
      if (rest > 0) s.notes.add('Token dipindahkan keluar melebihi saldo yang terlihat — histori kemungkinan terpotong');
      if (s.episode !== null && (s.lots.length === 0 || s.heldQty <= ROUND_TRIP_DUST_RATIO * s.episode.peakQty)) closeEpisode(s);
    } else {
      // UNKNOWN atau jenis tak dikenal: saldo tidak diubah, posisi ditandai tidak lengkap.
      s.unknownActivities += 1;
      s.notes.add('Ada aktivitas yang tidak dapat diklasifikasikan — saldo & PnL mungkin tidak akurat');
    }
  }

  // Episode yang masih terbuka: satu round trip per transaksi jual (posisi belum pernah kembali datar).
  for (const s of states.values()) {
    if (s.episode === null) continue;
    for (const sell of s.episode.sells) {
      roundTrips.push(makeRoundTrip(s.tokenKey, sell.fragments, { sellCount: 1, closedFlat: false }));
    }
  }
  roundTrips.sort((x, y) => x.closeAt - y.closeAt || cmpStr(x.tokenKey, y.tokenKey) || x.openAt - y.openAt);

  const positions = [];
  for (const s of [...states.values()].sort((x, y) => cmpStr(x.tokenKey, y.tokenKey))) {
    positions.push(buildPosition(s, priceMap, now));
  }

  return {
    positions,
    closedTrades,
    roundTrips,
    summary: buildSummary(positions, states, closedTrades, roundTrips, { totalCostUsd, duplicateCount, skippedInvalid, quoteSkipped }),
  };
}

function buildPosition(s, priceMap, now) {
  let qtyHeld = 0;
  let knownCostQty = 0;
  let costBasisUsd = 0;
  let airdropHeldQty = 0;
  for (const lot of s.lots) {
    qtyHeld += lot.qty;
    if (lot.unitCost === null) {
      if (lot.origin === 'AIRDROP') airdropHeldQty += lot.qty;
    } else {
      knownCostQty += lot.qty;
      costBasisUsd += lot.qty * lot.unitCost;
    }
  }
  const unknownCostQty = Math.max(0, qtyHeld - knownCostQty);
  const notes = s.notes;

  const p = priceMap.get(s.tokenKey);
  let priceUsd = null;
  let priceAt = null;
  let stalePrice = false;
  if (p && isNum(p.priceUsd) && p.priceUsd >= 0) {
    if (isNum(p.at) && p.at > now) {
      notes.add('Harga diabaikan karena tercatat setelah waktu evaluasi (tanpa look-ahead)');
    } else {
      priceUsd = p.priceUsd;
      priceAt = isNum(p.at) ? p.at : null;
      stalePrice = priceAt === null || now - priceAt > STALE_PRICE_MS;
      if (stalePrice) notes.add('Harga lebih tua dari 24 jam (atau tanpa waktu) — unrealized PnL mungkin tidak akurat');
    }
  }
  let unrealizedPnlUsd;
  if (knownCostQty <= tolerance(qtyHeld)) unrealizedPnlUsd = 0;
  else if (priceUsd === null) {
    unrealizedPnlUsd = null;
    notes.add('Harga saat ini tidak tersedia — unrealized PnL tidak diketahui');
  } else unrealizedPnlUsd = priceUsd * knownCostQty - costBasisUsd;

  if (unknownCostQty > tolerance(qtyHeld)) {
    notes.add(airdropHeldQty > 0
      ? 'Sebagian saldo berasal dari airdrop/mint atau transfer masuk — biaya tidak diketahui, tidak dihitung di unrealized'
      : 'Sebagian saldo berasal dari transfer masuk/exchange/bridge — biaya tidak diketahui, tidak dihitung di unrealized');
  }
  if (s.unknownCostSoldQty > 0 && s.oversoldQty < s.unknownCostSoldQty) {
    notes.add('Sebagian penjualan berasal dari lot berbiaya tidak diketahui — tidak dihitung sebagai profit trading');
  }
  if (s.airdropRealizedUsd > 0) notes.add('Hasil jual token airdrop dilaporkan terpisah (bukan keahlian trading)');

  const incompleteQty = s.unknownCostSoldQty + s.unknownProceedsSoldQty;
  const anyKnown = s.knownSoldQty > 0 || knownCostQty > tolerance(qtyHeld);
  const anyGap = incompleteQty > 0 || unknownCostQty > tolerance(qtyHeld) || s.unknownActivities > 0;
  let completeness = 'COMPLETE';
  if (anyGap) completeness = anyKnown ? 'PARTIAL' : 'UNKNOWN';

  return {
    tokenKey: s.tokenKey,
    token: s.token,
    qtyHeld,
    knownCostQty,
    costBasisUsd,
    unknownCostQty,
    realizedPnlUsd: s.realizedPnlUsd,
    unrealizedPnlUsd,
    priceUsd,
    priceAt,
    stalePrice,
    buys: s.buys,
    sells: s.sells,
    firstBuyAt: s.firstBuyAt,
    lastActivityAt: s.lastActivityAt,
    completeness,
    notes: [...notes],
    // Tambahan (di luar kontrak minimum) untuk transparansi:
    soldQty: s.soldQty,
    unknownCostSoldQty: s.unknownCostSoldQty,
    unknownProceedsSoldQty: s.unknownProceedsSoldQty,
    movedOutQty: s.movedOutQty,
    airdropRealizedUsd: s.airdropRealizedUsd,
  };
}

function buildSummary(positions, states, closedTrades, roundTrips, { totalCostUsd, duplicateCount, skippedInvalid, quoteSkipped }) {
  const notes = [];
  let realizedPnlUsd = 0;
  let unrealizedPnlUsd = 0;
  let missingPrice = 0;
  let airdropRealizedUsd = 0;
  let tradesCount = 0;
  let tokensTraded = 0;
  let proceedsUsd = 0;
  let completeProceedsUsd = 0;
  let anyUnknownProceeds = false;
  const tokenRatios = [];
  for (const p of positions) {
    const s = states.get(p.tokenKey);
    realizedPnlUsd += p.realizedPnlUsd;
    airdropRealizedUsd += p.airdropRealizedUsd;
    if (p.unrealizedPnlUsd === null) missingPrice += 1;
    else unrealizedPnlUsd += p.unrealizedPnlUsd;
    tradesCount += p.buys + p.sells;
    if (p.buys + p.sells > 0) tokensTraded += 1;
    if (s.soldQty > 0) {
      tokenRatios.push(Math.min(1, s.knownSoldQty / s.soldQty));
      proceedsUsd += s.soldProceedsUsd;
      completeProceedsUsd += s.completeProceedsUsd;
      if (s.unknownUsdSells > 0) anyUnknownProceeds = true;
    }
  }
  if (missingPrice > 0) notes.push(`Harga tidak tersedia untuk ${missingPrice} token — total unrealized PnL tidak diketahui`);
  if (positions.some((p) => p.stalePrice)) notes.push('Sebagian harga lebih tua dari 24 jam');
  if (airdropRealizedUsd > 0) notes.push('Hasil jual airdrop dilaporkan terpisah dan tidak dihitung sebagai keahlian trading');
  if (duplicateCount > 0) notes.push(`${duplicateCount} aktivitas duplikat diabaikan`);
  if (skippedInvalid > 0) notes.push(`${skippedInvalid} aktivitas tidak valid diabaikan`);
  if (quoteSkipped > 0) notes.push('Aset quote (native/wrapped/stablecoin) tidak dihitung sebagai posisi');

  // Kelengkapan realisasi berbobot USD (lihat catatan modul); kuantitas TIDAK dijumlahkan lintas token.
  let completenessRatio = 1;
  let completenessBasis = 'NONE';
  if (tokenRatios.length > 0) {
    if (!anyUnknownProceeds && proceedsUsd > 0) {
      completenessRatio = Math.min(1, completeProceedsUsd / proceedsUsd);
      completenessBasis = 'USD';
    } else {
      completenessRatio = tokenRatios.reduce((sum, r) => sum + r, 0) / tokenRatios.length;
      completenessBasis = 'TOKEN_AVERAGE';
    }
  }
  if (completenessRatio < 1) {
    notes.push(completenessBasis === 'USD'
      ? `Hanya ${Math.round(completenessRatio * 100)}% nilai jual (USD) yang biaya & hasilnya diketahui — PnL realisasi tidak lengkap`
      : `Hanya ${Math.round(completenessRatio * 100)}% kuantitas jual (rata-rata per token; sebagian nilai jual USD tidak diketahui) yang biaya & hasilnya diketahui — PnL realisasi tidak lengkap`);
  }

  let completeness;
  if (positions.length === 0) {
    completeness = 'UNKNOWN';
    notes.push('Tidak ada aktivitas token yang dapat dihitung');
  } else if (positions.every((p) => p.completeness === 'COMPLETE')) completeness = 'COMPLETE';
  else if (positions.every((p) => p.completeness === 'UNKNOWN')) completeness = 'UNKNOWN';
  else completeness = 'PARTIAL';

  return {
    realizedPnlUsd,
    unrealizedPnlUsd: missingPrice > 0 ? null : unrealizedPnlUsd,
    totalCostUsd,
    airdropRealizedUsd,
    tradesCount,
    closedTradesCount: closedTrades.length,
    roundTripsCount: roundTrips.length,
    tokensTraded,
    completenessRatio,
    completenessBasis,
    completeness,
    notes,
  };
}
