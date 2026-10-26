// PnL wallet FIFO per token (kontrak docs/15-kontrak-smart-money.md §2 `pnl.js`).
// Fungsi murni: tanpa I/O, tanpa Date.now() — waktu "sekarang" selalu dari argumen `now`.
//
// ─── Aturan ─────────────────────────────────────────────────────────────────────────────────────────
// - Masukan di-dedupe per `activity.id` (baris pertama dipertahankan) lalu diurutkan `blockTime`, lalu `id`, sehingga
//   data yang datang terlambat / tidak berurutan memberi hasil identik dengan data berurutan.
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
// - completenessRatio = qty jual yang direalisasikan dengan biaya & hasil diketahui / total qty jual (semua token).
//   Tanpa penjualan → 1 (tidak ada realisasi yang tidak lengkap; kelengkapan saldo terbuka dilaporkan lewat
//   `completeness`).
// - Kuantitas dibandingkan dengan toleransi relatif 1e-9 agar sisa pembulatan floating-point tidak menjadi lot hantu.

import { MOVE_OUT_TYPES, UNKNOWN_COST_IN_TYPES, isQuoteAsset, tokenKey as makeTokenKey } from './contracts.js';

export const STALE_PRICE_MS = 24 * 3_600_000;
const EPS_REL = 1e-9;
const AIRDROP_ORIGIN_TYPES = new Set(['AIRDROP', 'MINT']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function tolerance(scale) {
  return EPS_REL * Math.max(Math.abs(scale), Number.MIN_VALUE);
}

function cmpActivity(a, b) {
  return a.blockTime - b.blockTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function newState(key, act) {
  return {
    tokenKey: key,
    token: { ...act.token },
    lots: [],
    realizedPnlUsd: 0,
    airdropRealizedUsd: 0,
    buys: 0,
    sells: 0,
    firstBuyAt: null,
    lastActivityAt: act.blockTime,
    soldQty: 0,
    knownSoldQty: 0,
    unknownCostSoldQty: 0,
    unknownProceedsSoldQty: 0,
    oversoldQty: 0,
    movedOutQty: 0,
    unknownActivities: 0,
    knownCostBuys: 0,
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
  return remaining > tol ? remaining : 0;
}

/**
 * Hitung PnL wallet (FIFO per token).
 * @param {object[]} activities Activity[] satu wallet (urutan bebas, boleh duplikat)
 * @param {{ prices?: Map<string, { priceUsd: number, at: number, source?: string }>, now: number }} opts
 * @returns {{ positions: object[], closedTrades: object[], summary: object }}
 */
export function computeWalletPnl(activities, { prices, now } = {}) {
  if (!isNum(now)) throw new TypeError('computeWalletPnl: argumen `now` (epoch ms) wajib diisi');
  const priceMap = prices && typeof prices.get === 'function' ? prices : new Map();

  // Dedupe per id (baris pertama dipertahankan) + urutan deterministik blockTime, id.
  const seen = new Set();
  let duplicateCount = 0;
  const acts = [];
  for (const a of activities ?? []) {
    if (!a || typeof a !== 'object') continue;
    if (seen.has(a.id)) { duplicateCount += 1; continue; }
    seen.add(a.id);
    acts.push(a);
  }
  acts.sort(cmpActivity);

  const states = new Map();
  const closedTrades = [];
  let skippedInvalid = 0;
  let totalCostUsd = 0;
  let quoteSkipped = 0;

  for (const a of acts) {
    if (!a.token || !a.chain || !isNum(a.amount) || a.amount <= 0 || !isNum(a.blockTime)) { skippedInvalid += 1; continue; }
    if (isQuoteAsset(a.chain, a.token.address)) { quoteSkipped += 1; continue; }
    const key = makeTokenKey(a.chain, a.token.address);
    let s = states.get(key);
    if (!s) { s = newState(key, a); states.set(key, s); }
    s.lastActivityAt = Math.max(s.lastActivityAt, a.blockTime);
    const usd = isNum(a.usdValue) ? a.usdValue : null;

    if (a.type === 'SWAP_BUY') {
      s.buys += 1;
      if (s.firstBuyAt === null) s.firstBuyAt = a.blockTime;
      if (usd !== null) { s.knownCostBuys += 1; totalCostUsd += usd; } else {
        s.notes.add('Ada pembelian tanpa nilai USD — lot berbiaya tidak diketahui');
      }
      s.lots.push({ qty: a.amount, initialQty: a.amount, unitCost: usd === null ? null : usd / a.amount, origin: 'BUY', openAt: a.blockTime });
    } else if (UNKNOWN_COST_IN_TYPES.includes(a.type)) {
      const origin = AIRDROP_ORIGIN_TYPES.has(a.type) ? 'AIRDROP' : 'UNKNOWN';
      s.lots.push({ qty: a.amount, initialQty: a.amount, unitCost: null, origin, openAt: a.blockTime });
    } else if (a.type === 'SWAP_SELL') {
      s.sells += 1;
      s.soldQty += a.amount;
      const unitProceeds = usd === null ? null : usd / a.amount;
      if (unitProceeds === null) s.notes.add('Ada penjualan tanpa nilai USD — hasil jual tidak diketahui, PnL tidak direalisasikan');
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
        closedTrades.push({
          tokenKey: key, openAt: lot.openAt, closeAt: a.blockTime, qty: q, costUsd, proceedsUsd, pnlUsd,
          returnPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : null, holdMs: a.blockTime - lot.openAt,
        });
      });
      if (rest > 0) {
        s.unknownCostSoldQty += rest;
        s.oversoldQty += rest;
        s.notes.add('Penjualan melebihi saldo yang terlihat — histori kemungkinan terpotong; sisanya dianggap berbiaya tidak diketahui');
      }
    } else if (MOVE_OUT_TYPES.includes(a.type)) {
      s.movedOutQty += a.amount;
      const rest = consumeLots(s, a.amount, () => {});
      if (rest > 0) s.notes.add('Token dipindahkan keluar melebihi saldo yang terlihat — histori kemungkinan terpotong');
    } else {
      // UNKNOWN atau jenis tak dikenal: saldo tidak diubah, posisi ditandai tidak lengkap.
      s.unknownActivities += 1;
      s.notes.add('Ada aktivitas yang tidak dapat diklasifikasikan — saldo & PnL mungkin tidak akurat');
    }
  }

  const positions = [];
  for (const s of [...states.values()].sort((x, y) => (x.tokenKey < y.tokenKey ? -1 : x.tokenKey > y.tokenKey ? 1 : 0))) {
    positions.push(buildPosition(s, priceMap, now));
  }

  return { positions, closedTrades, summary: buildSummary(positions, states, closedTrades, { totalCostUsd, duplicateCount, skippedInvalid, quoteSkipped }) };
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

function buildSummary(positions, states, closedTrades, { totalCostUsd, duplicateCount, skippedInvalid, quoteSkipped }) {
  const notes = [];
  let realizedPnlUsd = 0;
  let unrealizedPnlUsd = 0;
  let missingPrice = 0;
  let airdropRealizedUsd = 0;
  let tradesCount = 0;
  let tokensTraded = 0;
  let soldQty = 0;
  let knownSoldQty = 0;
  for (const p of positions) {
    const s = states.get(p.tokenKey);
    realizedPnlUsd += p.realizedPnlUsd;
    airdropRealizedUsd += p.airdropRealizedUsd;
    if (p.unrealizedPnlUsd === null) missingPrice += 1;
    else unrealizedPnlUsd += p.unrealizedPnlUsd;
    tradesCount += p.buys + p.sells;
    if (p.buys + p.sells > 0) tokensTraded += 1;
    soldQty += s.soldQty;
    knownSoldQty += s.knownSoldQty;
  }
  if (missingPrice > 0) notes.push(`Harga tidak tersedia untuk ${missingPrice} token — total unrealized PnL tidak diketahui`);
  if (positions.some((p) => p.stalePrice)) notes.push('Sebagian harga lebih tua dari 24 jam');
  if (airdropRealizedUsd > 0) notes.push('Hasil jual airdrop dilaporkan terpisah dan tidak dihitung sebagai keahlian trading');
  if (duplicateCount > 0) notes.push(`${duplicateCount} aktivitas duplikat diabaikan`);
  if (skippedInvalid > 0) notes.push(`${skippedInvalid} aktivitas tidak valid diabaikan`);
  if (quoteSkipped > 0) notes.push('Aset quote (native/wrapped/stablecoin) tidak dihitung sebagai posisi');

  const completenessRatio = soldQty > 0 ? Math.min(1, knownSoldQty / soldQty) : 1;
  if (completenessRatio < 1) {
    notes.push(`Hanya ${Math.round(completenessRatio * 100)}% kuantitas jual yang biaya & hasilnya diketahui — PnL realisasi tidak lengkap`);
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
    tokensTraded,
    completenessRatio,
    completeness,
    notes,
  };
}
