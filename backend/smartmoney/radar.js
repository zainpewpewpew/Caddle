// Radar akumulasi smart money (kontrak docs/15-kontrak-smart-money.md §2 `radar.js`). Fungsi murni: tanpa I/O,
// tanpa waktu sistem (waktu lewat `now`), tanpa acak. Modul classify/pnl/walletScore/walletFlags dikerjakan
// paralel dan TIDAK diimpor: skor wallet diterima sebagai `walletScores: Map<walletKey, { score, eligible, flags }>`.
//
// ─── STATUS: HIPOTESIS AWAL ────────────────────────────────────────────────────────────────────────
// Bobot & ambang di DEFAULT_RADAR_PARAMS belum dikalibrasi (lihat evaluate.js). Skor keyakinan 0..100 adalah
// ringkasan bukti yang dapat dijelaskan, BUKAN probabilitas profit.
//
// ─── Penyaringan ───────────────────────────────────────────────────────────────────────────────────
// 1. Duplikat `Activity.id` dihitung sekali (kemunculan pertama setelah diurutkan blockTime, id).
// 2. Hanya `blockTime ∈ [now − windowMs, now]` (kedua batas inklusif). Aktivitas lebih tua yang datang terlambat
//    dan aktivitas setelah `now` (look-ahead) diabaikan.
// 3. Token quote (QUOTE_ASSETS) diabaikan.
// 4. Wallet tanpa skor, `eligible === false`, atau berpenanda pengecuali (lihat isWalletExcluded) diabaikan.
// 5. Hanya SWAP_BUY = beli dan SWAP_SELL = jual. CEX_DEPOSIT = indikasi keluar (exitSignals, "dipindah ke
//    exchange, belum tentu dijual"). Jenis lain dihitung di `excluded` dan tidak pernah menjadi pembelian.
//
// ─── Identitas ─────────────────────────────────────────────────────────────────────────────────────
// Token = tokenKey(chain, address); simbol sama dengan kontrak berbeda = entri berbeda. Klaster wallet:
// `clusterOf.get(walletKey) ?? clusterOf.get(address) ?? walletKey` (linkWallets mengembalikan peta per alamat
// untuk satu chain; walletKey didukung untuk masukan multi-chain). Wallet tanpa tautan = klaster sendiri.
//
// ─── Skor keyakinan (komponen 0..1) ────────────────────────────────────────────────────────────────
// breadth   30  log2(1 + klaster independen) / log2(1 + breadthSaturation (5)), maks 1.
// quality   25  rata-rata per klaster dari rata-rata skor wallet pembeli / 100 (klaster tertaut dihitung sekali).
// flow      20  log10(1 + netFlowUsd) / log10(1 + flowSaturationUsd (1 jt)); 0 bila net ≤ 0 atau tidak diketahui.
// repeat    15  porsi klaster pembeli yang memiliki wallet dengan ≥ repeatMinBuys (2) SWAP_BUY.
// recency   10  1 − (now − lastBuyAt) / windowMs.
// exitPenalty          maks(sellRatio, exitShare); dikurangi exitPenaltyPoints (40) × nilai.
//                      sellRatio = USD jual / (USD beli + USD jual) bila keduanya diketahui, selain itu jumlah swap.
//                      exitShare = Σ bobot wallet keluar / jumlah wallet aktif (FULL_EXIT 1, hanya CEX_DEPOSIT 0,5).
// concentrationPenalty (porsi klaster terbesar − 0,5) / 0,5, porsi = maks(porsi wallet pembeli, porsi USD beli);
//                      dikurangi concentrationPenaltyPoints (25) × nilai.
// conviction = round(clamp(Σ bobot × komponen − penalti, 0, 100)).
//
// ─── State ─────────────────────────────────────────────────────────────────────────────────────────
// EXITING       ada FULL_EXIT, atau exitShare ≥ exitingMinExitShare (0,5).
// DISTRIBUTING  tidak ada pembeli, atau sellRatio ≥ distributingMinSellRatio (0,6).
// ACCUMULATING  ada pembeli, sellRatio ≤ accumulatingMaxSellRatio (0,2), dan exitShare < 0,25.
// MIXED         selain itu.
//
// ─── FULL_EXIT ─────────────────────────────────────────────────────────────────────────────────────
// Per wallet × token: saldo awal = holdingsBefore (bila diketahui, selain itu 0), lalu aktivitas di jendela
// diterapkan berurutan (direction IN menambah, OUT mengurangi). Bila wallet pernah memegang (saldo awal > 0
// atau ada SWAP_BUY di jendela), ada aktivitas keluar, dan saldo akhir ≤ (1 − fullExitDropPct) × saldo puncak →
// FULL_EXIT pada aktivitas keluar terakhir.
//
// `holdingsBefore` (opsional): Map<walletKey, Map<tokenKey, number | { qty }>> = saldo pada awal jendela.
// `holdingChangePct` = perubahan saldo total wallet yang lolos saring; null bila holdingsBefore tidak diberikan,
// ada wallet aktif yang tidak tercantum, atau saldo awal total 0.
// `prices` (opsional): Map<tokenKey, { priceUsd, at, source }> — hanya dipakai untuk risiko "harga tidak tersedia";
// nilai USD aliran TIDAK pernah ditaksir dari harga sekarang (nilai tak diketahui tetap tidak dijumlahkan).
//
// Ekstensi kontrak (aditif): `excluded.other` (TRANSFER_OUT/BURN/UNKNOWN), `exitSignals[].via` & `.note`.

import {
  DISCLAIMERS, EXCLUDING_FLAGS, explorerTxUrl, isQuoteAsset, tokenKey as makeTokenKey, walletKey as makeWalletKey,
} from './contracts.js';

/** Parameter default radar (HIPOTESIS AWAL — wajib dikalibrasi evaluasi historis). */
export const DEFAULT_RADAR_PARAMS = Object.freeze({
  weights: Object.freeze({ breadth: 30, quality: 25, flow: 20, repeat: 15, recency: 10 }),
  breadthSaturation: 5,
  flowSaturationUsd: 1_000_000,
  repeatMinBuys: 2,
  exitPenaltyPoints: 40,
  concentrationPenaltyPoints: 25,
  concentrationThreshold: 0.5,
  cexDepositExitWeight: 0.5,
  fullExitDropPct: 0.9,
  accumulatingMaxSellRatio: 0.2,
  accumulatingMaxExitShare: 0.25,
  distributingMinSellRatio: 0.6,
  exitingMinExitShare: 0.5,
});

const EXCLUDED_BUCKET = Object.freeze({
  TRANSFER_IN: 'transferIn',
  CEX_WITHDRAWAL: 'cexWithdrawal',
  BRIDGE_IN: 'bridge',
  BRIDGE_OUT: 'bridge',
  AIRDROP: 'airdrop',
  LP_ADD: 'lp',
  LP_REMOVE: 'lp',
  MINT: 'mint',
  TRANSFER_OUT: 'other',
  BURN: 'other',
  UNKNOWN: 'other',
});

const EXIT_NOTES = Object.freeze({
  SWAP: 'dijual via swap',
  CEX: 'dipindah ke exchange, belum tentu dijual',
  TRANSFER: 'dipindah ke alamat lain, belum tentu dijual',
  MIXED: 'sebagian dijual via swap, sebagian dipindah (belum tentu dijual)',
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Helper lokal (modul walletFlags dikerjakan paralel): wallet dikecualikan dari radar bila tidak ada skor,
 * `eligible === false`, atau memiliki penanda EXCLUDING_FLAGS ber-severity HIGH — semantik sama dengan
 * `isExcluded(flags)` di walletFlags.js.
 * @param {{ eligible?: boolean, flags?: Array<{ code: string, severity: string }> }|undefined|null} ws
 * @returns {boolean}
 */
export function isWalletExcluded(ws) {
  if (!ws || ws.eligible !== true) return true;
  const flags = Array.isArray(ws.flags) ? ws.flags : [];
  return flags.some((f) => f && EXCLUDING_FLAGS.includes(f.code) && f.severity === 'HIGH');
}

/** Kunci dedupe aktivitas: `id` kontrak, atau gabungan field bila id tidak ada. */
export function activityKey(a) {
  if (typeof a.id === 'string' && a.id) return a.id;
  return `${a.chain}:${a.txHash}:${a.wallet}:${a.token?.address}:${a.type}`;
}

/** Urutkan (blockTime, id) lalu buang duplikat id — deterministik terhadap urutan masukan. */
export function dedupeActivities(activities) {
  const sorted = [...activities].filter((a) => a && typeof a === 'object' && a.token)
    .sort((x, y) => (x.blockTime - y.blockTime) || cmp(activityKey(x), activityKey(y)));
  const seen = new Set();
  const out = [];
  for (const a of sorted) {
    const k = activityKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Alamat disingkat untuk teks: 0x1234…abcd. */
export function shortAddress(address) {
  if (typeof address !== 'string') return '?';
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Format USD deterministik (tanpa locale sistem): $12.345 / $512,30; null → "nilai USD tidak diketahui". */
export function formatUsd(v) {
  if (!isNum(v)) return 'nilai USD tidak diketahui';
  const sign = v < 0 ? '−' : '';
  const abs = Math.abs(v);
  if (abs >= 1000) return `${sign}$${Math.round(abs).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
  return `${sign}$${abs.toFixed(2).replace('.', ',')}`;
}

function resolveParams(params) {
  if (params === null || typeof params !== 'object') throw new TypeError('params radar harus objek');
  return { ...DEFAULT_RADAR_PARAMS, ...params, weights: { ...DEFAULT_RADAR_PARAMS.weights, ...(params.weights ?? {}) } };
}

function holdingQty(holdingsBefore, wKey, tKey) {
  if (!(holdingsBefore instanceof Map)) return undefined;
  if (!holdingsBefore.has(wKey)) return undefined;
  const inner = holdingsBefore.get(wKey);
  const v = inner instanceof Map ? inner.get(tKey) : undefined;
  if (v === undefined || v === null) return 0; // wallet diketahui, token tidak dipegang
  const q = typeof v === 'object' ? v.qty : v;
  return isNum(q) && q > 0 ? q : 0;
}

function txOf(a) {
  return {
    txHash: a.txHash,
    explorerUrl: a.explorerUrl ?? explorerTxUrl(a.chain, a.txHash),
    type: a.type,
    at: a.blockTime,
    usd: isNum(a.usdValue) ? a.usdValue : null,
  };
}

/**
 * Radar akumulasi per token dari aktivitas wallet berkualitas dalam satu jendela waktu.
 * @param {{ activities: object[], walletScores: Map<string, { score: number, eligible: boolean, flags: object[] }>,
 *   clusterOf?: Map<string, string>, now: number, windowMs: number, prices?: Map<string, object>,
 *   holdingsBefore?: Map<string, Map<string, number|{ qty: number }>> }} input
 * @param {Partial<typeof DEFAULT_RADAR_PARAMS>} [params]
 * @returns {object[]} RadarToken[] terurut conviction turun lalu tokenKey.
 */
export function buildAccumulationRadar(input, params = {}) {
  if (input === null || typeof input !== 'object') throw new TypeError('Input radar harus objek');
  const { activities, walletScores, clusterOf = new Map(), now, windowMs, prices = null, holdingsBefore = null } = input;
  if (!Array.isArray(activities)) throw new TypeError('activities harus array');
  if (!(walletScores instanceof Map)) throw new TypeError('walletScores harus Map');
  if (!Number.isInteger(now)) throw new TypeError('now harus epoch ms bilangan bulat');
  if (!(isNum(windowMs) && windowMs > 0)) throw new RangeError('windowMs harus > 0');
  const p = resolveParams(params);
  const start = now - windowMs;

  // token → { chain, token, acts: Activity[] }
  const byToken = new Map();
  for (const a of dedupeActivities(activities)) {
    if (!isNum(a.blockTime) || a.blockTime < start || a.blockTime > now) continue;
    if (isQuoteAsset(a.chain, a.token.address)) continue;
    const ws = walletScores.get(makeWalletKey(a.chain, a.wallet));
    if (isWalletExcluded(ws)) continue;
    const tKey = makeTokenKey(a.chain, a.token.address);
    if (!byToken.has(tKey)) byToken.set(tKey, { chain: a.chain, token: a.token, acts: [] });
    byToken.get(tKey).acts.push(a);
  }

  const out = [];
  for (const [tKey, entry] of byToken) {
    const radarToken = buildToken(tKey, entry, { walletScores, clusterOf, now, windowMs, prices, holdingsBefore, p });
    if (radarToken) out.push(radarToken);
  }
  out.sort((x, y) => (y.conviction - x.conviction) || cmp(x.tokenKey, y.tokenKey));
  return out;
}

function buildToken(tKey, { chain, token, acts }, ctx) {
  const { walletScores, clusterOf, now, windowMs, prices, holdingsBefore, p } = ctx;
  const excluded = { transferIn: 0, cexWithdrawal: 0, bridge: 0, airdrop: 0, lp: 0, mint: 0, other: 0 };
  const perWallet = new Map(); // address → { acts, buys, sells, buyUsd, sellUsd, ... }
  let grossBuyKnown = 0; let buyKnownCount = 0; let buyCount = 0;
  let grossSellKnown = 0; let sellKnownCount = 0; let sellCount = 0;
  let unknownUsdCount = 0;
  const exitSignals = [];

  for (const a of acts) {
    if (!perWallet.has(a.wallet)) {
      perWallet.set(a.wallet, { acts: [], txs: [], buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, buyUsdKnown: 0, firstBuyAt: null, lastBuyAt: null, cexDeposits: 0 });
    }
    const w = perWallet.get(a.wallet);
    w.acts.push(a);
    const usd = isNum(a.usdValue) ? a.usdValue : null;
    if (a.type === 'SWAP_BUY') {
      buyCount += 1; w.buys += 1; w.txs.push(txOf(a));
      if (usd === null) unknownUsdCount += 1; else { grossBuyKnown += usd; buyKnownCount += 1; w.buyUsd += usd; w.buyUsdKnown += 1; }
      w.firstBuyAt = w.firstBuyAt === null ? a.blockTime : Math.min(w.firstBuyAt, a.blockTime);
      w.lastBuyAt = w.lastBuyAt === null ? a.blockTime : Math.max(w.lastBuyAt, a.blockTime);
    } else if (a.type === 'SWAP_SELL') {
      sellCount += 1; w.sells += 1; w.txs.push(txOf(a));
      if (usd === null) unknownUsdCount += 1; else { grossSellKnown += usd; sellKnownCount += 1; w.sellUsd += usd; }
      exitSignals.push({ ...exitOf(a, 'SWAP_SELL'), via: 'SWAP', note: EXIT_NOTES.SWAP });
    } else if (a.type === 'CEX_DEPOSIT') {
      w.cexDeposits += 1; w.txs.push(txOf(a));
      exitSignals.push({ ...exitOf(a, 'CEX_DEPOSIT'), via: 'CEX', note: EXIT_NOTES.CEX });
    } else {
      const bucket = EXCLUDED_BUCKET[a.type] ?? 'other';
      excluded[bucket] += 1;
    }
  }

  // FULL_EXIT & perubahan kepemilikan per wallet.
  let holdingKnown = holdingsBefore instanceof Map;
  let sumBefore = 0; let sumAfter = 0;
  const fullExitWallets = new Set();
  for (const [address, w] of perWallet) {
    const wKey = makeWalletKey(chain, address);
    const before = holdingQty(holdingsBefore, wKey, tKey);
    if (before === undefined) holdingKnown = false;
    let qty = before ?? 0;
    let peak = qty;
    let lastOut = null;
    const outs = [];
    for (const a of w.acts) {
      if (!isNum(a.amount) || a.amount <= 0) continue;
      if (a.direction === 'IN') qty += a.amount;
      else if (a.direction === 'OUT') { qty -= a.amount; lastOut = a; outs.push(a); }
      peak = Math.max(peak, qty);
    }
    if (before !== undefined) { sumBefore += before; sumAfter += Math.max(0, qty); }
    const held = (before ?? 0) > 0 || w.buys > 0;
    if (held && lastOut && peak > 0 && qty <= (1 - p.fullExitDropPct) * peak) {
      const vias = new Set(outs.map((o) => (o.type === 'SWAP_SELL' ? 'SWAP' : o.type === 'CEX_DEPOSIT' ? 'CEX' : 'TRANSFER')));
      const via = vias.size === 1 ? [...vias][0] : 'MIXED';
      const outUsd = outs.every((o) => isNum(o.usdValue)) ? outs.reduce((s, o) => s + o.usdValue, 0) : null;
      fullExitWallets.add(address);
      exitSignals.push({
        ...exitOf(lastOut, 'FULL_EXIT'), usd: outUsd, via,
        note: `kepemilikan turun ≥ ${Math.round(p.fullExitDropPct * 100)}% — ${EXIT_NOTES[via]}`,
      });
    }
  }
  for (const holdings of holdingsBefore instanceof Map ? holdingsBefore : []) {
    // Wallet yang memegang token tetapi tidak aktif di jendela: saldo tidak berubah (ikut penyebut).
    const [wKey, inner] = holdings;
    if (!(inner instanceof Map) || !inner.has(tKey) || !wKey.startsWith(`${chain}:`)) continue;
    const address = wKey.slice(chain.length + 1);
    if (perWallet.has(address) || isWalletExcluded(walletScores.get(wKey))) continue;
    const q = holdingQty(holdingsBefore, wKey, tKey);
    sumBefore += q; sumAfter += q;
  }
  const holdingChangePct = holdingKnown && sumBefore > 0 ? ((sumAfter - sumBefore) / sumBefore) * 100 : null;

  const hasSignal = buyCount > 0 || sellCount > 0 || exitSignals.length > 0;
  if (!hasSignal) return null; // hanya aktivitas non-swap (mis. penarikan exchange) → bukan entri radar

  const clusterIdOf = (address) => {
    const wKey = makeWalletKey(chain, address);
    return clusterOf.get(wKey) ?? clusterOf.get(address) ?? wKey;
  };

  const buyers = [];
  for (const [address, w] of perWallet) {
    if (w.buys === 0) continue;
    const ws = walletScores.get(makeWalletKey(chain, address));
    buyers.push({
      wallet: address,
      score: isNum(ws?.score) ? ws.score : 0,
      clusterId: clusterIdOf(address),
      netBuyUsd: w.buyUsdKnown > 0 || w.sellUsd > 0 ? w.buyUsd - w.sellUsd : null,
      buys: w.buys,
      sells: w.sells,
      firstBuyAt: w.firstBuyAt,
      lastBuyAt: w.lastBuyAt,
      txs: w.txs,
    });
  }
  buyers.sort((x, y) => ((y.netBuyUsd ?? -Infinity) - (x.netBuyUsd ?? -Infinity)) || (y.score - x.score) || cmp(x.wallet, y.wallet));
  exitSignals.sort((x, y) => (x.at - y.at) || cmp(x.type, y.type) || cmp(x.wallet, y.wallet) || cmp(x.txHash, y.txHash));

  const sellerCount = [...perWallet.values()].filter((w) => w.sells > 0).length;
  const clusters = new Map(); // clusterId → { scores, wallets, buyUsd, repeat }
  for (const b of buyers) {
    if (!clusters.has(b.clusterId)) clusters.set(b.clusterId, { scores: [], wallets: 0, buyUsd: 0, repeat: false });
    const c = clusters.get(b.clusterId);
    c.scores.push(b.score);
    c.wallets += 1;
    c.buyUsd += perWallet.get(b.wallet).buyUsd;
    if (b.buys >= p.repeatMinBuys) c.repeat = true;
  }
  const independentBuyers = clusters.size;

  const grossBuyUsd = buyCount === 0 ? 0 : buyKnownCount > 0 ? grossBuyKnown : null;
  const grossSellUsd = sellCount === 0 ? 0 : sellKnownCount > 0 ? grossSellKnown : null;
  const netFlowUsd = grossBuyUsd === null || grossSellUsd === null ? null : grossBuyUsd - grossSellUsd;

  // ─── Komponen ───
  const breadth = independentBuyers > 0 ? clamp01(Math.log2(1 + independentBuyers) / Math.log2(1 + p.breadthSaturation)) : 0;
  const quality = independentBuyers > 0
    ? clamp01([...clusters.values()].reduce((s, c) => s + c.scores.reduce((a, v) => a + v, 0) / c.scores.length, 0) / independentBuyers / 100)
    : 0;
  const flow = isNum(netFlowUsd) && netFlowUsd > 0 ? clamp01(Math.log10(1 + netFlowUsd) / Math.log10(1 + p.flowSaturationUsd)) : 0;
  const repeat = independentBuyers > 0 ? [...clusters.values()].filter((c) => c.repeat).length / independentBuyers : 0;
  const lastBuyAt = buyers.length ? Math.max(...buyers.map((b) => b.lastBuyAt)) : null;
  const recency = lastBuyAt === null ? 0 : clamp01(1 - (now - lastBuyAt) / windowMs);

  const sellRatio = grossBuyUsd !== null && grossSellUsd !== null && grossBuyUsd + grossSellUsd > 0
    ? grossSellUsd / (grossBuyUsd + grossSellUsd)
    : buyCount + sellCount > 0 ? sellCount / (buyCount + sellCount) : 0;
  let exitWeight = 0;
  for (const [address, w] of perWallet) {
    if (fullExitWallets.has(address)) exitWeight += 1;
    else if (w.cexDeposits > 0) exitWeight += p.cexDepositExitWeight;
  }
  const activeWallets = [...perWallet.values()].filter((w) => w.buys > 0 || w.sells > 0 || w.cexDeposits > 0).length;
  const exitShare = activeWallets > 0 ? clamp01(exitWeight / activeWallets) : 0;
  const exitPenalty = clamp01(Math.max(sellRatio, exitShare));

  let topShare = 0;
  if (independentBuyers > 0) {
    const maxWallets = Math.max(...[...clusters.values()].map((c) => c.wallets));
    topShare = maxWallets / buyers.length;
    if (isNum(grossBuyUsd) && grossBuyUsd > 0) topShare = Math.max(topShare, Math.max(...[...clusters.values()].map((c) => c.buyUsd)) / grossBuyUsd);
  }
  const concentrationPenalty = independentBuyers > 0
    ? clamp01((topShare - p.concentrationThreshold) / (1 - p.concentrationThreshold))
    : 0;

  const w = p.weights;
  const raw = w.breadth * breadth + w.quality * quality + w.flow * flow + w.repeat * repeat + w.recency * recency
    - p.exitPenaltyPoints * exitPenalty - p.concentrationPenaltyPoints * concentrationPenalty;
  const conviction = Math.round(Math.min(100, Math.max(0, raw)));

  let state;
  if (fullExitWallets.size > 0 || exitShare >= p.exitingMinExitShare) state = 'EXITING';
  else if (buyers.length === 0 || sellRatio >= p.distributingMinSellRatio) state = 'DISTRIBUTING';
  else if (sellRatio <= p.accumulatingMaxSellRatio && exitShare < p.accumulatingMaxExitShare) state = 'ACCUMULATING';
  else state = 'MIXED';

  // ─── Teks ───
  const reasons = [];
  const risks = [];
  const label = `${token.symbol ?? '?'} (${shortAddress(token.address)})`;
  if (buyers.length) {
    reasons.push(`${buyers.length} wallet berkualitas membeli ${label} via swap dalam jendela; ${independentBuyers} pembeli independen (klaster berbeda)`);
    reasons.push(`Rata-rata skor wallet pembeli ${Math.round(quality * 100)} (klaster tertaut dihitung sekali)`);
  }
  if (isNum(netFlowUsd)) reasons.push(`Aliran bersih swap ${formatUsd(netFlowUsd)} (beli ${formatUsd(grossBuyUsd)}, jual ${formatUsd(grossSellUsd)})`);
  else if (buyCount + sellCount > 0) reasons.push('Aliran bersih USD tidak dapat dihitung: nilai USD beli atau jual tidak diketahui');
  if (unknownUsdCount > 0) {
    reasons.push(`${unknownUsdCount} swap tanpa nilai USD tidak dijumlahkan — aliran USD hanya dari nilai yang diketahui (bukan dianggap 0)`);
  }
  const repeatClusters = [...clusters.values()].filter((c) => c.repeat).length;
  if (repeatClusters > 0) reasons.push(`${repeatClusters} klaster membeli berulang (≥ ${p.repeatMinBuys} kali)`);
  reasons.push(DISCLAIMERS.conviction);

  if (sellCount > 0) risks.push(`${sellCount} penjualan swap oleh ${sellerCount} wallet (${formatUsd(grossSellUsd)})`);
  const cexCount = exitSignals.filter((e) => e.type === 'CEX_DEPOSIT').length;
  if (cexCount > 0) risks.push(`${cexCount} deposit ke exchange — dipindah ke exchange, belum tentu dijual`);
  for (const address of [...fullExitWallets].sort()) {
    risks.push(`Wallet ${shortAddress(address)} mengurangi kepemilikan ≥ ${Math.round(p.fullExitDropPct * 100)}% (keluar penuh)`);
  }
  if (independentBuyers === 1) risks.push('Hanya satu pembeli independen — bukti akumulasi sempit');
  if (concentrationPenalty > 0 && independentBuyers > 0) {
    risks.push(`Satu klaster mendominasi pembelian (${Math.round(topShare * 100)}% dari wallet/USD beli)`);
  }
  if (buyers.length > independentBuyers) {
    risks.push(`${buyers.length - independentBuyers} wallet pembeli tertaut dengan wallet lain — dihitung sebagai satu pembeli independen`);
  }
  const excludedTotal = Object.values(excluded).reduce((s, v) => s + v, 0);
  if (excludedTotal > 0) {
    risks.push(`${excludedTotal} aktivitas non-swap (transfer, penarikan exchange, bridge, airdrop, LP, mint) tidak dihitung sebagai beli/jual`);
  }
  if (prices instanceof Map && !isNum(prices.get(tKey)?.priceUsd)) risks.push('Harga token saat ini tidak tersedia');

  const times = acts.map((a) => a.blockTime);
  return {
    tokenKey: tKey,
    chain,
    token,
    buyers,
    buyerCount: buyers.length,
    independentBuyers,
    sellerCount,
    grossBuyUsd,
    grossSellUsd,
    netFlowUsd,
    unknownUsdCount,
    holdingChangePct,
    exitSignals,
    excluded,
    firstActivityAt: Math.min(...times),
    lastActivityAt: Math.max(...times),
    state,
    conviction,
    convictionComponents: { breadth, quality, flow, repeat, recency, exitPenalty, concentrationPenalty },
    reasons,
    risks,
  };
}

function exitOf(a, type) {
  return {
    wallet: a.wallet,
    type,
    at: a.blockTime,
    usd: isNum(a.usdValue) ? a.usdValue : null,
    txHash: a.txHash,
    explorerUrl: a.explorerUrl ?? explorerTxUrl(a.chain, a.txHash),
  };
}
