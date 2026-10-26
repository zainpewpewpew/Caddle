// Penanda risiko wallet (kontrak docs/15-kontrak-smart-money.md §2 `walletFlags.js`). Fungsi murni: tanpa I/O,
// tanpa waktu sistem. Aktivitas (keluaran classify.js) dan PnL (keluaran pnl.js) diterima sebagai input biasa —
// modul tersebut TIDAK diimpor.
//
// ─── Sumber penanda ──────────────────────────────────────────────────────────────────────────────────
// Label bersumber (source = `label:<sumber>`):
//   cex / cex_deposit → CEX · market_maker → MARKET_MAKER · mev_bot → MEV · dex_router / dex_pool → DEX_INFRA ·
//   contract / bridge → CONTRACT (bridge adalah kontrak infrastruktur; kontrak tidak menyebut bridge secara
//   eksplisit — dipilih CONTRACT agar wallet bridge tidak pernah masuk peringkat).
//   Severity HIGH; label dengan confidence < minLabelConfidence (0,5) diturunkan ke MEDIUM. Label tanpa `source`
//   diabaikan (kontrak: label tanpa sumber ditolak).
// Heuristik (source = 'heuristik'):
//   BOT            ≥ 200 tx dengan median jeda < 60 dtk; ATAU aktif ≥ 22 dari 24 jam UTC secara merata (≥ 96 tx,
//                  koefisien variasi jumlah tx per jam ≤ 0,5); ATAU ≥ 5 blok berisi ≥ 3 tx berbeda milik wallet
//                  (blok = blockNumber dari txTimes bila ada, jika tidak blockTime yang sama).
//   MEV            beli & jual token yang sama pada blok/detik yang sama, berulang ≥ 3 kali.
//   MARKET_MAKER   dua arah pada ≥ 5 token, masing-masing ≥ 10 swap (beli & jual), |net|/gross < 0,1 (jumlah token),
//                  dan frekuensi ≥ 4 swap per hari aktif pada token tsb.
//   AIRDROP_FARMER > 50 % aktivitas masuk (jumlah, atau nilai USD bila diketahui) berasal dari AIRDROP/MINT.
//                  HIGH bila realized PnL airdrop (pnl.summary.airdropRealizedUsd) juga mendominasi PnL trading;
//                  MEDIUM bila PnL trading swap tetap dominan atau PnL tidak tersedia.
//   LOW_HISTORY    riwayat < 30 hari atau < 10 trade tertutup (MEDIUM — tidak mengecualikan, mengurangi skor).
//                  Trade tertutup = round trip posisi (`pnl.roundTrips`, lihat pnl.js), BUKAN potongan lot FIFO
//                  `pnl.closedTrades` (10 beli kecil + 1 jual = 1 trade). PnlResult tanpa `roundTrips` → closedTrades.
//   INCOMPLETE_PNL pnl.summary.completenessRatio < 0,5 (MEDIUM). Rasio berbobot nilai USD hasil jual (pnl.js).
//
// Catatan kontrak: signature menambah argumen opsional `pnl` (PnlResult) dan `now`, karena AIRDROP_FARMER,
// LOW_HISTORY, dan INCOMPLETE_PNL membutuhkan data PnL. Tanpa `pnl`, jumlah trade tertutup didekati dengan jumlah
// SWAP_SELL dan INCOMPLETE_PNL tidak dievaluasi. Tanpa `now`, lama riwayat diukur sampai aktivitas terakhir.
// Penanda LINKED berasal dari clusters.js (lihat `linkedFlag`).

import { EXCLUDING_FLAGS, WALLET_FLAGS, isEvmChain } from './contracts.js';

/** Ambang heuristik default (HIPOTESIS AWAL — wajib dikalibrasi dengan data nyata). */
export const DEFAULT_FLAG_PARAMS = Object.freeze({
  minLabelConfidence: 0.5,
  botMinTx: 200,
  botMaxMedianGapMs: 60_000,
  botMinActiveHours: 22,
  botHoursMinTx: 96,
  botHoursMaxCv: 0.5,
  botSameBlockMinTx: 3,
  botSameBlockMinBlocks: 5,
  mevMinOccurrences: 3,
  mmMinTokens: 5,
  mmMinSwapsPerToken: 10,
  mmMaxNetRatio: 0.1,
  mmMinSwapsPerDay: 4,
  airdropMinInShare: 0.5,
  lowHistoryDays: 30,
  lowHistoryClosedTrades: 10,
  incompletePnlRatio: 0.5,
  maxEvidenceTx: 5,
});

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const LABEL_FLAG = Object.freeze({
  cex: 'CEX',
  cex_deposit: 'CEX',
  market_maker: 'MARKET_MAKER',
  mev_bot: 'MEV',
  dex_router: 'DEX_INFRA',
  dex_pool: 'DEX_INFRA',
  contract: 'CONTRACT',
  bridge: 'CONTRACT',
});

const LABEL_REASON = Object.freeze({
  CEX: 'Alamat berlabel exchange terpusat',
  MARKET_MAKER: 'Alamat berlabel market maker',
  MEV: 'Alamat berlabel bot MEV',
  DEX_INFRA: 'Alamat berlabel infrastruktur DEX (router/pool)',
  CONTRACT: 'Alamat berlabel kontrak/infrastruktur',
});

const IN_TYPES = new Set(['SWAP_BUY', 'TRANSFER_IN', 'CEX_WITHDRAWAL', 'BRIDGE_IN', 'AIRDROP', 'MINT', 'LP_REMOVE']);
const AIRDROP_TYPES = new Set(['AIRDROP', 'MINT']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 2) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function canon(chain, address) {
  if (typeof address !== 'string') return address;
  return isEvmChain(chain) ? address.toLowerCase() : address;
}

/** Ambil semua label bersumber untuk alamat (labels: Map<chain:address, AddressLabel|AddressLabel[]> atau array). */
function labelsFor(labels, chain, address) {
  if (!labels) return [];
  let raw;
  if (labels instanceof Map) raw = labels.get(`${chain}:${address}`);
  else if (Array.isArray(labels)) raw = labels.filter((l) => l && l.chain === chain && canon(chain, l.address) === address);
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter((l) => l && typeof l.source === 'string' && l.source.trim() !== '');
}

function resolveParams(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Parameter penanda harus objek');
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_FLAG_PARAMS, key)) throw new TypeError(`Parameter penanda tidak dikenal: ${key}`);
  }
  return { ...DEFAULT_FLAG_PARAMS, ...overrides };
}

function uniqueTxs(activities) {
  const byTx = new Map();
  for (const a of activities) {
    if (!a || typeof a.txHash !== 'string' || !isNum(a.blockTime)) continue;
    if (!byTx.has(a.txHash)) byTx.set(a.txHash, { at: a.blockTime, txHash: a.txHash, blockNumber: null });
  }
  return [...byTx.values()];
}

function normalizeTxTimes(txTimes) {
  const out = [];
  for (const t of txTimes) {
    if (isNum(t)) out.push({ at: t, txHash: null, blockNumber: null });
    else if (t && isNum(t.at)) {
      out.push({ at: t.at, txHash: t.txHash ?? null, blockNumber: Number.isInteger(t.blockNumber) ? t.blockNumber : null });
    }
  }
  return out;
}

function detectBot(txs, p) {
  const sorted = [...txs].sort((a, b) => a.at - b.at || String(a.txHash).localeCompare(String(b.txHash)));
  const examples = sorted.filter((t) => t.txHash).slice(0, p.maxEvidenceTx).map((t) => t.txHash);
  const hits = [];
  const evidence = { txCount: sorted.length };

  if (sorted.length >= 2) {
    const gaps = [];
    for (let i = 1; i < sorted.length; i += 1) gaps.push(sorted[i].at - sorted[i - 1].at);
    const med = median(gaps);
    evidence.medianGapSec = round(med / 1000, 1);
    if (sorted.length >= p.botMinTx && med < p.botMaxMedianGapMs) {
      hits.push(`${sorted.length} tx dengan median jeda ${round(med / 1000, 1)} dtk`);
    }
  }

  const hourly = new Array(24).fill(0);
  for (const t of sorted) hourly[Math.floor((((t.at % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS)] += 1;
  const activeHours = hourly.filter((c) => c > 0).length;
  evidence.activeHoursUtc = activeHours;
  if (sorted.length >= p.botHoursMinTx && activeHours >= p.botMinActiveHours) {
    const mean = sorted.length / 24;
    const sd = Math.sqrt(hourly.reduce((s, c) => s + (c - mean) ** 2, 0) / 24);
    const cv = sd / mean;
    evidence.hourlyCv = round(cv, 3);
    if (cv <= p.botHoursMaxCv) hits.push(`aktif merata di ${activeHours} dari 24 jam UTC`);
  }

  const perBlock = new Map();
  for (const t of sorted) {
    const key = t.blockNumber !== null ? `b${t.blockNumber}` : `t${t.at}`;
    const set = perBlock.get(key) ?? new Set();
    set.add(t.txHash ?? `${t.at}#${set.size}`);
    perBlock.set(key, set);
  }
  const crowdedBlocks = [...perBlock.values()].filter((s) => s.size >= p.botSameBlockMinTx).length;
  evidence.crowdedBlocks = crowdedBlocks;
  if (crowdedBlocks >= p.botSameBlockMinBlocks) {
    hits.push(`${crowdedBlocks} blok berisi ≥ ${p.botSameBlockMinTx} tx wallet ini`);
  }

  if (hits.length === 0) return null;
  return {
    code: 'BOT', severity: 'HIGH', source: 'heuristik',
    reason: `Pola aktivitas otomatis: ${hits.join('; ')}`,
    evidence: { ...evidence, exampleTxHashes: examples },
  };
}

function detectMev(activities, p) {
  const groups = new Map();
  for (const a of activities) {
    if (a.type !== 'SWAP_BUY' && a.type !== 'SWAP_SELL') continue;
    const key = `${a.token?.address}|${a.blockTime}`;
    const g = groups.get(key) ?? { buy: false, sell: false, txHashes: new Set(), token: a.token?.address, at: a.blockTime };
    if (a.type === 'SWAP_BUY') g.buy = true;
    else g.sell = true;
    g.txHashes.add(a.txHash);
    groups.set(key, g);
  }
  const hits = [...groups.values()].filter((g) => g.buy && g.sell).sort((a, b) => a.at - b.at || String(a.token).localeCompare(String(b.token)));
  if (hits.length < p.mevMinOccurrences) return null;
  return {
    code: 'MEV', severity: 'HIGH', source: 'heuristik',
    reason: `Beli dan jual token yang sama pada blok/detik yang sama sebanyak ${hits.length} kali (pola sandwich/arbitrase)`,
    evidence: {
      occurrences: hits.length,
      examples: hits.slice(0, p.maxEvidenceTx).map((g) => ({ token: g.token, at: g.at, txHashes: [...g.txHashes].sort() })),
      exampleTxHashes: [...new Set(hits.flatMap((g) => [...g.txHashes]))].sort().slice(0, p.maxEvidenceTx),
    },
  };
}

function detectMarketMaker(activities, p) {
  const perToken = new Map();
  for (const a of activities) {
    if ((a.type !== 'SWAP_BUY' && a.type !== 'SWAP_SELL') || !isNum(a.amount)) continue;
    const key = a.token?.address;
    const t = perToken.get(key) ?? { token: key, buys: 0, sells: 0, buyQty: 0, sellQty: 0, first: Infinity, last: -Infinity, txHashes: [] };
    if (a.type === 'SWAP_BUY') { t.buys += 1; t.buyQty += a.amount; } else { t.sells += 1; t.sellQty += a.amount; }
    t.first = Math.min(t.first, a.blockTime);
    t.last = Math.max(t.last, a.blockTime);
    t.txHashes.push(a.txHash);
    perToken.set(key, t);
  }
  const qualifying = [];
  for (const t of perToken.values()) {
    const swaps = t.buys + t.sells;
    const gross = t.buyQty + t.sellQty;
    if (swaps < p.mmMinSwapsPerToken || t.buys === 0 || t.sells === 0 || gross <= 0) continue;
    const netRatio = Math.abs(t.buyQty - t.sellQty) / gross;
    const days = Math.max(1, Math.ceil((t.last - t.first) / DAY_MS));
    const perDay = swaps / days;
    if (netRatio < p.mmMaxNetRatio && perDay >= p.mmMinSwapsPerDay) {
      qualifying.push({ token: t.token, swaps, netRatio: round(netRatio, 3), swapsPerDay: round(perDay, 1), txHashes: t.txHashes });
    }
  }
  if (qualifying.length < p.mmMinTokens) return null;
  qualifying.sort((a, b) => String(a.token).localeCompare(String(b.token)));
  return {
    code: 'MARKET_MAKER', severity: 'HIGH', source: 'heuristik',
    reason: `Beli-jual dua arah berfrekuensi tinggi dengan posisi bersih hampir nol pada ${qualifying.length} token (pola market making)`,
    evidence: {
      tokens: qualifying.map(({ txHashes: _t, ...rest }) => rest),
      exampleTxHashes: [...new Set(qualifying.flatMap((q) => q.txHashes))].sort().slice(0, p.maxEvidenceTx),
    },
  };
}

function detectAirdropFarmer(activities, pnl, p) {
  const ins = activities.filter((a) => a.direction === 'IN' || IN_TYPES.has(a.type));
  if (ins.length === 0) return null;
  const drops = ins.filter((a) => AIRDROP_TYPES.has(a.type));
  if (drops.length === 0) return null;
  const countShare = drops.length / ins.length;
  const knownUsd = ins.filter((a) => isNum(a.usdValue));
  const totalUsd = knownUsd.reduce((s, a) => s + a.usdValue, 0);
  const dropUsd = knownUsd.filter((a) => AIRDROP_TYPES.has(a.type)).reduce((s, a) => s + a.usdValue, 0);
  const usdShare = totalUsd > 0 ? dropUsd / totalUsd : null;
  if (!(countShare > p.airdropMinInShare || (usdShare !== null && usdShare > p.airdropMinInShare))) return null;

  const summary = pnl?.summary ?? null;
  const airdropPnl = isNum(summary?.airdropRealizedUsd) ? summary.airdropRealizedUsd : null;
  const tradingPnl = isNum(summary?.realizedPnlUsd) ? summary.realizedPnlUsd : null;
  const dominated = airdropPnl !== null && airdropPnl > 0 && airdropPnl > Math.max(0, tradingPnl ?? 0);
  const sharePct = Math.round(Math.max(countShare, usdShare ?? 0) * 100);
  const reason = dominated
    ? `${sharePct}% aktivitas masuk berasal dari airdrop/mint dan realized PnL didominasi lot airdrop`
    : `${sharePct}% aktivitas masuk berasal dari airdrop/mint, namun PnL trading swap ${summary ? 'tetap dominan' : 'tidak tersedia untuk dibandingkan'}`;
  return {
    code: 'AIRDROP_FARMER', severity: dominated ? 'HIGH' : 'MEDIUM', source: 'heuristik', reason,
    evidence: {
      inCount: ins.length, airdropCount: drops.length, countShare: round(countShare, 3), usdShare: round(usdShare, 3),
      airdropRealizedUsd: airdropPnl, tradingRealizedUsd: tradingPnl,
      exampleTxHashes: [...new Set(drops.map((a) => a.txHash))].sort().slice(0, p.maxEvidenceTx),
    },
  };
}

/** Jumlah trade tertutup tingkat posisi: roundTrips → closedTrades (PnlResult lama) → ringkasan → jumlah SWAP_SELL. */
function closedTradeCount(pnl, acts) {
  if (Array.isArray(pnl?.roundTrips)) return pnl.roundTrips.length;
  if (Array.isArray(pnl?.closedTrades)) return pnl.closedTrades.length;
  if (isNum(pnl?.summary?.roundTripsCount)) return pnl.summary.roundTripsCount;
  if (isNum(pnl?.summary?.closedTradesCount)) return pnl.summary.closedTradesCount;
  return acts.filter((a) => a.type === 'SWAP_SELL').length;
}

/**
 * Deteksi penanda risiko wallet dari label bersumber dan heuristik aktivitas.
 * @param {{ chain: string, address: string, activities?: object[], labels?: Map<string, object>|object[],
 *   txTimes?: Array<number|{ at: number, txHash?: string, blockNumber?: number }>, pnl?: object, now?: number }} input
 * @param {Partial<typeof DEFAULT_FLAG_PARAMS>} [params]
 * @returns {Array<{ code: string, severity: 'HIGH'|'MEDIUM'|'LOW', reason: string, evidence: object, source: string }>}
 *   terurut sesuai WALLET_FLAGS lalu source.
 */
export function detectWalletFlags({ chain, address, activities = [], labels, txTimes, pnl, now } = {}, params = {}) {
  const p = resolveParams(params);
  const wallet = canon(chain, address);
  const acts = (Array.isArray(activities) ? activities : [])
    .filter((a) => a && isNum(a.blockTime) && (!isNum(now) || a.blockTime <= now));
  const flags = [];

  // 1. Label bersumber pada wallet ini.
  const seenLabelFlags = new Set();
  for (const l of labelsFor(labels, chain, wallet)) {
    const code = LABEL_FLAG[l.category];
    if (!code) continue;
    const key = `${code}|${l.source}`;
    if (seenLabelFlags.has(key)) continue;
    seenLabelFlags.add(key);
    const lowConf = isNum(l.confidence) && l.confidence < p.minLabelConfidence;
    flags.push({
      code, severity: lowConf ? 'MEDIUM' : 'HIGH', source: `label:${l.source}`,
      reason: `${LABEL_REASON[code]} “${l.label ?? l.category}” (sumber: ${l.source}${lowConf ? ', keyakinan label rendah' : ''})`,
      evidence: { label: l.label ?? null, category: l.category, confidence: isNum(l.confidence) ? l.confidence : null, fetchedAt: l.fetchedAt ?? null },
    });
  }

  // 2. Heuristik.
  const txs = Array.isArray(txTimes) && txTimes.length > 0 ? normalizeTxTimes(txTimes).filter((t) => !isNum(now) || t.at <= now) : uniqueTxs(acts);
  const bot = detectBot(txs, p);
  if (bot) flags.push(bot);
  const mev = detectMev(acts, p);
  if (mev) flags.push(mev);
  const mm = detectMarketMaker(acts, p);
  if (mm) flags.push(mm);
  const farmer = detectAirdropFarmer(acts, pnl, p);
  if (farmer) flags.push(farmer);

  // LOW_HISTORY — loop, bukan Math.min/max(...arr): spread argumen gagal (RangeError) di atas ~125 ribu elemen.
  let first = null;
  let last = null;
  for (const a of acts) {
    if (first === null || a.blockTime < first) first = a.blockTime;
    if (last === null || a.blockTime > last) last = a.blockTime;
  }
  const end = isNum(now) ? now : last;
  const historyDays = first !== null && end !== null ? (end - first) / DAY_MS : 0;
  const closedTrades = closedTradeCount(pnl, acts);
  if (historyDays < p.lowHistoryDays || closedTrades < p.lowHistoryClosedTrades) {
    const parts = [];
    if (historyDays < p.lowHistoryDays) parts.push(`riwayat ${round(historyDays, 1)} hari (< ${p.lowHistoryDays})`);
    if (closedTrades < p.lowHistoryClosedTrades) parts.push(`${closedTrades} trade tertutup (< ${p.lowHistoryClosedTrades})`);
    flags.push({
      code: 'LOW_HISTORY', severity: 'MEDIUM', source: 'heuristik',
      reason: `Riwayat belum cukup untuk dinilai: ${parts.join(', ')}`,
      evidence: { historyDays: round(historyDays, 1), closedTrades, firstActivityAt: first },
    });
  }

  // INCOMPLETE_PNL
  const ratio = pnl?.summary?.completenessRatio;
  if (isNum(ratio) && ratio < p.incompletePnlRatio) {
    flags.push({
      code: 'INCOMPLETE_PNL', severity: 'MEDIUM', source: 'heuristik',
      reason: pnl.summary.completenessBasis === 'TOKEN_AVERAGE'
        ? `PnL tidak lengkap: rata-rata per token hanya ${Math.round(ratio * 100)}% kuantitas jual yang harga belinya diketahui`
        : `PnL tidak lengkap: hanya ${Math.round(ratio * 100)}% nilai jual (USD) yang harga belinya diketahui`,
      evidence: { completenessRatio: ratio, completeness: pnl.summary.completeness ?? null },
    });
  }

  const order = (c) => WALLET_FLAGS.indexOf(c);
  return flags.sort((a, b) => order(a.code) - order(b.code) || a.source.localeCompare(b.source));
}

/**
 * True bila ada penanda pengecualian (EXCLUDING_FLAGS) dengan severity HIGH.
 * @param {Array<{ code: string, severity: string }>} flags
 */
export function isExcluded(flags) {
  return Array.isArray(flags) && flags.some((f) => f && f.severity === 'HIGH' && EXCLUDING_FLAGS.includes(f.code));
}
