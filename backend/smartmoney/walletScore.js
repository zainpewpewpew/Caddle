// Skor kualitas wallet (kontrak docs/15-kontrak-smart-money.md §2 `walletScore.js`). Fungsi murni: tanpa I/O,
// tanpa waktu sistem (waktu dari `now`), tanpa acak. PnlResult (pnl.js) dan Activity[] (classify.js) diterima
// sebagai input biasa — modul tersebut TIDAK diimpor.
//
// ─── STATUS: HIPOTESIS AWAL ────────────────────────────────────────────────────────────────────────
// Bobot dan skala di bawah BELUM dikalibrasi. Skor 0..100 adalah ringkasan bukti yang dapat dijelaskan, BUKAN
// probabilitas profit. Skor tidak pernah membaca saldo wallet.
//
// ─── Komponen (masing-masing 0..1) ───────────────────────────────────────────────────────────────────
// profitability   r = min(mean, meanExTop) × n/(n+k), k = 10 (return per trade dalam %; meanExTop = rata-rata
//                 tanpa trade terbaik, 0 bila n = 1). Nilai = max(0, tanh(r / profitScalePct)), skala 30 %.
//                 Satu trade beruntung → meanExTop = 0 → profitabilitas 0.
// consistency     minggu aktif (UTC, floor(closeAt / 7 hari)) dengan PnL realisasi > 0: (P + 0,5·k)/(W + k), k = 4
//                 (shrinkage ke 0,5); bila W < 4 minggu: min(0,5, nilai) × W/4 (bukti belum cukup — tidak
//                 boleh dikreditkan penuh).
// sampleSize      n/(n + 20) (n = trade tertutup).
// risk            0,6 × (1 − tanh(DD / 50)) + 0,4 × (1 − min(1, |trade terburuk %| / 100)), DD = drawdown maksimum (%)
//                 kurva PnL realisasi kumulatif. Basis persen = biaya trade tertutup terbesar (modal yang terbukti
//                 pernah dipakai sekaligus; BUKAN saldo) — tafsiran karena kontrak tidak menyebut basis persen.
//                 Nilai mentah lalu di-shrink ke 0,5 dengan n/(n+k) (k = 10): "tidak ada kerugian" dari 1–2 trade
//                 bukan bukti manajemen risiko. Tanpa trade tertutup → 0.
// diversification (1 − e^(−d/5)) × (1 − penalti), d = token dengan trade tertutup; penalti = 0,7 × (s − 0,6)/0,4
//                 bila s = porsi PnL positif dari satu token > 0,6.
// history         min(1, hari riwayat / 180).
// score = 100 × Σ(bobot·komponen)/Σbobot × (0,5 + 0,5 × completenessRatio). completenessRatio null → 0
// (konservatif). Win rate hanya metrik informasi.
// ─── Gaya ──────────────────────────────────────────────────────────────────────────────────────────
// Median holdMs < 1 jam SCALPER, < 7 hari SWING, ≥ 7 hari POSITION; MIXED bila ember median memuat < 50 % trade.
// Tanpa trade tertutup → UNKNOWN.

import { isExcluded } from './walletFlags.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Parameter default (HIPOTESIS AWAL — wajib dikalibrasi). */
export const DEFAULT_WALLET_SCORE_PARAMS = Object.freeze({
  weights: Object.freeze({ profitability: 0.30, consistency: 0.25, sampleSize: 0.15, risk: 0.15, diversification: 0.10, history: 0.05 }),
  shrinkageK: 10,
  profitScalePct: 30,
  consistencyPriorWeeks: 4,
  minWeeks: 4,
  sampleK: 20,
  drawdownScalePct: 50,
  riskDrawdownWeight: 0.6,
  diversificationScale: 5,
  concentrationThreshold: 0.6,
  concentrationPenaltyMax: 0.7,
  historySaturationDays: 180,
  minClosedTrades: 10,
  minTokens: 3,
  minHistoryDays: 30,
  minCompletenessRatio: 0.5,
  scalperMaxHoldMs: HOUR_MS,
  swingMaxHoldMs: 7 * DAY_MS,
  mixedMinShare: 0.5,
});

const COMPONENT_IDS = Object.freeze(Object.keys(DEFAULT_WALLET_SCORE_PARAMS.weights));

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const round = (v, d = 2) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function assertFinite(name, v, lo, hi) {
  if (!isNum(v) || v < lo || v > hi) throw new RangeError(`${name} harus angka di ${lo}..${hi}`);
}

/**
 * Gabungkan override dengan parameter default dan validasi.
 * @param {object} [overrides]
 */
export function resolveWalletScoreParams(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Parameter skor wallet harus objek');
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_WALLET_SCORE_PARAMS, key)) throw new TypeError(`Parameter skor wallet tidak dikenal: ${key}`);
  }
  const w = overrides.weights ?? {};
  if (w === null || typeof w !== 'object' || Array.isArray(w)) throw new TypeError('weights harus objek');
  for (const key of Object.keys(w)) {
    if (!COMPONENT_IDS.includes(key)) throw new TypeError(`Bobot komponen tidak dikenal: ${key}`);
  }
  const weights = { ...DEFAULT_WALLET_SCORE_PARAMS.weights, ...w };
  for (const [key, v] of Object.entries(weights)) assertFinite(`weights.${key}`, v, 0, 1000);
  if (Object.values(weights).reduce((a, v) => a + v, 0) <= 0) throw new RangeError('Total bobot harus > 0');
  const p = { ...DEFAULT_WALLET_SCORE_PARAMS, ...overrides, weights: Object.freeze(weights) };
  for (const key of Object.keys(DEFAULT_WALLET_SCORE_PARAMS)) {
    if (key === 'weights') continue;
    assertFinite(key, p[key], 0, Number.MAX_SAFE_INTEGER);
  }
  for (const key of ['concentrationThreshold', 'concentrationPenaltyMax', 'minCompletenessRatio', 'mixedMinShare', 'riskDrawdownWeight']) {
    assertFinite(key, p[key], 0, 1);
  }
  for (const key of ['profitScalePct', 'drawdownScalePct', 'diversificationScale', 'historySaturationDays']) {
    if (p[key] <= 0) throw new RangeError(`${key} harus > 0`);
  }
  return Object.freeze(p);
}

function tradeReturnPct(t) {
  if (isNum(t.returnPct)) return t.returnPct;
  if (isNum(t.pnlUsd) && isNum(t.costUsd) && t.costUsd > 0) return (t.pnlUsd / t.costUsd) * 100;
  return null;
}

function styleOf(holds, p) {
  if (holds.length === 0) return 'UNKNOWN';
  const bucket = (h) => (h < p.scalperMaxHoldMs ? 'SCALPER' : h < p.swingMaxHoldMs ? 'SWING' : 'POSITION');
  const med = bucket(median(holds));
  const share = holds.filter((h) => bucket(h) === med).length / holds.length;
  return share >= p.mixedMinShare ? med : 'MIXED';
}

function maxDrawdown(trades) {
  // Basis: biaya trade terbesar (proksi modal yang pernah dipakai sekaligus; bukan saldo).
  const base = Math.max(0, ...trades.map((t) => (isNum(t.costUsd) ? t.costUsd : 0)));
  if (!(base > 0)) return { pct: 0, usd: 0 };
  let equity = base;
  let peak = base;
  let ddPct = 0;
  let ddUsd = 0;
  for (const t of trades) {
    if (!isNum(t.pnlUsd)) continue;
    equity += t.pnlUsd;
    if (equity > peak) peak = equity;
    ddUsd = Math.max(ddUsd, peak - equity);
    ddPct = Math.max(ddPct, peak > 0 ? Math.min(1, (peak - equity) / peak) * 100 : 100);
  }
  return { pct: ddPct, usd: ddUsd };
}

const pct = (v) => `${Math.round(v * 100)}%`;
const fmtPct = (v) => `${v >= 0 ? '+' : ''}${round(v, 1)}%`;

/**
 * Hitung skor kualitas wallet yang dapat dijelaskan.
 * @param {{ chain: string, address: string, pnl: object, activities?: object[], flags?: object[], now: number }} input
 * @param {object} [params] override DEFAULT_WALLET_SCORE_PARAMS
 * @returns {object} WalletScore sesuai kontrak
 */
export function scoreWallet({ pnl, activities = [], flags = [], now } = {}, params = {}) {
  // chain & address tidak memengaruhi skor (identitas saja); skor tidak membaca saldo.
  if (!isNum(now)) throw new TypeError('now (epoch ms) wajib diisi');
  const p = resolveWalletScoreParams(params);
  const limitations = [];
  const reasons = [];

  // Trade tertutup hanya yang sudah ditutup ≤ now (tanpa look-ahead), urut deterministik.
  const trades = (Array.isArray(pnl?.closedTrades) ? pnl.closedTrades : [])
    .filter((t) => t && isNum(t.closeAt) && t.closeAt <= now)
    .map((t) => ({ ...t, ret: tradeReturnPct(t) }))
    .sort((a, b) => a.closeAt - b.closeAt || String(a.tokenKey).localeCompare(String(b.tokenKey)) || (a.openAt ?? 0) - (b.openAt ?? 0));
  const rets = trades.map((t) => t.ret).filter(isNum);
  const n = rets.length;
  const tokenSet = new Set(trades.map((t) => t.tokenKey));
  const distinctTokens = tokenSet.size;

  // Profitabilitas (shrinkage + tanpa trade terbaik).
  const meanRet = mean(rets);
  const sortedRets = [...rets].sort((a, b) => b - a);
  const meanExTop = n > 1 ? mean(sortedRets.slice(1)) : 0;
  const shrink = n / (n + p.shrinkageK);
  const shrunkMean = meanRet * shrink;
  const effective = Math.min(meanRet, meanExTop) * shrink;
  const profitability = clamp01(Math.max(0, Math.tanh(effective / p.profitScalePct)));

  // Konsistensi mingguan.
  const weeks = new Map();
  for (const t of trades) {
    if (!isNum(t.pnlUsd)) continue;
    const wk = Math.floor(t.closeAt / WEEK_MS);
    weeks.set(wk, (weeks.get(wk) ?? 0) + t.pnlUsd);
  }
  const activeWeeks = weeks.size;
  const positiveWeeks = [...weeks.values()].filter((v) => v > 0).length;
  const weeklyPositiveShare = activeWeeks ? positiveWeeks / activeWeeks : null;
  let consistency = (positiveWeeks + 0.5 * p.consistencyPriorWeeks) / (activeWeeks + p.consistencyPriorWeeks);
  if (activeWeeks < p.minWeeks) consistency = Math.min(consistency, 0.5) * (activeWeeks / p.minWeeks);

  // Ukuran sampel.
  const sampleSize = n / (n + p.sampleK);

  // Risiko.
  const dd = maxDrawdown(trades);
  const worst = n ? Math.min(...rets) : null;
  const rawRisk = n
    ? p.riskDrawdownWeight * (1 - Math.tanh(dd.pct / p.drawdownScalePct))
      + (1 - p.riskDrawdownWeight) * (1 - Math.min(1, Math.abs(Math.min(0, worst)) / 100))
    : 0;
  const risk = n ? clamp01(0.5 + (rawRisk - 0.5) * shrink) : 0;

  // Diversifikasi + penalti konsentrasi.
  const pnlByToken = new Map();
  for (const t of trades) if (isNum(t.pnlUsd)) pnlByToken.set(t.tokenKey, (pnlByToken.get(t.tokenKey) ?? 0) + t.pnlUsd);
  const positives = [...pnlByToken.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const posSum = positives.reduce((s, [, v]) => s + v, 0);
  const topTokenPnlShare = posSum > 0 ? positives[0][1] / posSum : null;
  const concentrationPenalty = topTokenPnlShare !== null && topTokenPnlShare > p.concentrationThreshold
    ? p.concentrationPenaltyMax * clamp01((topTokenPnlShare - p.concentrationThreshold) / (1 - p.concentrationThreshold || 1))
    : 0;
  const diversification = clamp01((1 - Math.exp(-distinctTokens / p.diversificationScale)) * (1 - concentrationPenalty));

  // Lama riwayat (aktivitas setelah `now` diabaikan).
  const firstTimes = [
    ...(Array.isArray(activities) ? activities : []).map((a) => a?.blockTime).filter((t) => isNum(t) && t <= now),
    ...trades.map((t) => t.openAt).filter((t) => isNum(t) && t <= now),
  ];
  const firstAt = firstTimes.length ? Math.min(...firstTimes) : null;
  const historyDays = firstAt !== null ? (now - firstAt) / DAY_MS : 0;
  const history = clamp01(historyDays / p.historySaturationDays);

  const components = {
    profitability: round(profitability, 4),
    consistency: round(clamp01(consistency), 4),
    sampleSize: round(clamp01(sampleSize), 4),
    risk: round(risk, 4),
    diversification: round(diversification, 4),
    history: round(history, 4),
  };

  const ratioRaw = pnl?.summary?.completenessRatio;
  const completenessRatio = isNum(ratioRaw) ? clamp01(ratioRaw) : null;
  const completenessFactor = 0.5 + 0.5 * (completenessRatio ?? 0);
  const wSum = COMPONENT_IDS.reduce((s, k) => s + p.weights[k], 0);
  const weighted = COMPONENT_IDS.reduce((s, k) => s + p.weights[k] * components[k], 0) / wSum;
  const score = round(Math.min(100, Math.max(0, 100 * weighted * completenessFactor)), 2);

  const winRate = n ? rets.filter((r) => r > 0).length / n : null;
  const holds = trades.map((t) => t.holdMs).filter((h) => isNum(h) && h >= 0);
  const style = styleOf(holds, p);

  // Kelayakan.
  const flagList = Array.isArray(flags) ? flags : [];
  if (n < p.minClosedTrades) limitations.push(`Baru ${n} trade tertutup (minimal ${p.minClosedTrades}) — sampel terlalu kecil untuk dinilai`);
  if (distinctTokens < p.minTokens) limitations.push(`Hanya ${distinctTokens} token dengan trade tertutup (minimal ${p.minTokens})`);
  if (historyDays < p.minHistoryDays) limitations.push(`Riwayat ${round(historyDays, 1)} hari (minimal ${p.minHistoryDays} hari)`);
  if (isExcluded(flagList)) {
    const codes = [...new Set(flagList.filter((f) => f.severity === 'HIGH').map((f) => f.code))];
    limitations.push(`Dikecualikan karena penanda berat: ${codes.join(', ')} — bukan wallet trader individu`);
  }
  const farmer = flagList.some((f) => f.code === 'AIRDROP_FARMER' && f.severity === 'HIGH');
  if (farmer) limitations.push('Dikecualikan: profit didominasi airdrop (AIRDROP_FARMER), bukan keahlian trading');
  if (completenessRatio === null) {
    limitations.push('Kelengkapan PnL tidak diketahui — dianggap 0 (skor dipotong setengah)');
  } else if (completenessRatio < p.minCompletenessRatio) {
    limitations.push(`PnL tidak lengkap: hanya ${pct(completenessRatio)} jumlah jual berbiaya diketahui (minimal ${pct(p.minCompletenessRatio)})`);
  } else if (completenessRatio < 1) {
    limitations.push(`PnL sebagian: ${pct(completenessRatio)} jumlah jual berbiaya diketahui; skor dikalikan ${round(completenessFactor, 2)}`);
  }
  const eligible = n >= p.minClosedTrades && distinctTokens >= p.minTokens && historyDays >= p.minHistoryDays
    && !isExcluded(flagList) && !farmer && completenessRatio !== null && completenessRatio >= p.minCompletenessRatio;

  if (n > 0 && meanExTop < meanRet && sortedRets[0] > 0 && n > 1 && (meanRet - meanExTop) > Math.abs(meanExTop)) {
    limitations.push(`Return rata-rata sangat bergantung pada trade terbaik (${fmtPct(sortedRets[0])}); dinilai tanpa trade tersebut`);
  }
  if (n === 1) limitations.push('Hanya satu trade tertutup — satu hasil beruntung tidak dianggap keahlian');
  if (concentrationPenalty > 0) {
    limitations.push(`${pct(topTokenPnlShare)} PnL positif berasal dari satu token — diversifikasi dipenalti`);
  }
  if (activeWeeks > 0 && activeWeeks < p.minWeeks) limitations.push(`Baru ${activeWeeks} minggu aktif (minimal ${p.minWeeks}) — konsistensi belum dapat dinilai`);
  for (const f of flagList) {
    if (f && f.severity !== 'HIGH' && f.code !== 'LOW_HISTORY' && f.code !== 'INCOMPLETE_PNL') limitations.push(`Penanda ${f.code}: ${f.reason}`);
  }

  // Alasan (bukti yang dapat diverifikasi).
  if (n > 0) {
    const parts = [`${n} trade tertutup di ${distinctTokens} token`];
    if (weeklyPositiveShare !== null) parts.push(`${pct(weeklyPositiveShare)} minggu profit`);
    parts.push(`drawdown maks ${Math.round(dd.pct)}%`);
    reasons.push(parts.join(', '));
    reasons.push(`Return median per trade ${fmtPct(median(rets))}; rata-rata terkoreksi (shrinkage, tanpa trade terbaik) ${fmtPct(effective)}`);
    if (worst !== null && worst < 0) reasons.push(`Trade terburuk ${fmtPct(worst)}`);
    if (winRate !== null) reasons.push(`Win rate ${pct(winRate)} (informasi saja, tidak menambah skor)`);
  }
  if (historyDays > 0) reasons.push(`Riwayat on-chain ${Math.floor(historyDays)} hari`);
  if (style !== 'UNKNOWN') {
    const label = { SCALPER: 'scalper (pegang < 1 jam)', SWING: 'swing (pegang < 7 hari)', POSITION: 'posisi (pegang ≥ 7 hari)', MIXED: 'campuran' }[style];
    reasons.push(`Gaya trading: ${label}`);
  }

  return {
    score,
    eligible,
    style,
    components,
    metrics: {
      closedTrades: n,
      distinctTokens,
      historyDays: round(historyDays, 2),
      winRate: round(winRate, 4),
      medianReturnPct: round(median(rets), 4),
      shrunkMeanReturnPct: round(shrunkMean, 4),
      meanReturnExTopPct: round(n ? meanExTop : null, 4),
      maxDrawdownPct: round(dd.pct, 4),
      worstTradeReturnPct: round(worst, 4),
      topTokenPnlShare: round(topTokenPnlShare, 4),
      completenessRatio,
      weeklyPositiveShare: round(weeklyPositiveShare, 4),
    },
    reasons,
    limitations,
    computedAt: now,
  };
}
