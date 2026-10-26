// Kandidat Reversal Radar SINTETIS (bukan data pasar nyata) untuk uji API/repositori dan server E2E seeded.
// Ditulis LANGSUNG lewat repos.reversal.save / setProvisional dengan snapshot §4 & evaluasi §3 LENGKAP (docs/19) —
// tanpa mesin deteksi — sehingga setiap kombinasi tahap/status/skor/likuiditas/extended/provisional dapat dikendalikan.
// Setiap kandidat menempuh rantai event berurutan (OPENED → STAGE_UP … → CANCELLED) persis seperti yang dipersistensi
// state machine. Skor = jumlah poin bukti per grup (EVIDENCE_WEIGHTS, dibatasi EVIDENCE_GROUP_MAX), bukan probabilitas.
import { TIMEFRAME_MS } from '../../backend/market/contracts.js';
import {
  EVIDENCE_GROUPS, EVIDENCE_GROUP_MAX, EVIDENCE_GROUP_OF, EVIDENCE_WEIGHTS, REVERSAL_VERSION, STAGE_RANK, STATUS_OF_STAGE,
} from '../../backend/reversal/constants.js';
import { generateCandles } from '../fixtures/candles/synthetic.js';

/** Waktu acuan seed (epoch ms UTC): candle terakhir kandidat pertama. */
export const REVERSAL_SEED_T0 = Date.UTC(2027, 0, 3, 0, 0, 0);
/** "Sekarang" untuk validasi candle tertutup (jauh setelah semua candle seed). */
export const REVERSAL_SEED_NOW = Date.UTC(2027, 0, 10);

/** Label/detail bukti berbahasa Indonesia (sintetis; label asli berasal dari detektor agent A). */
const EVIDENCE_TEXT = Object.freeze({
  LL_SHALLOWER: ['Lower low makin dangkal', 'Kedalaman lower low terakhir 0,4 ATR (sebelumnya 1,1 ATR)'],
  LL_STOPPED: ['Lower low berhenti', 'Tidak ada swing low baru di bawah dasar selama 12 candle'],
  BOTTOM_HELD: ['Dasar bertahan saat retest', 'Low kembali ke dasar + 0,3 ATR lalu close 0,4 ATR di atasnya'],
  DOWN_MOMENTUM_FADING: ['Momentum turun melemah', 'Body candle merah 10 terakhir 0,6× sebelumnya; porsi volume merah 48%'],
  RSI_DIVERGENCE: ['Divergensi RSI bullish', 'Harga lower low, RSI14 higher low (+4,2 poin)'],
  CVD_DIVERGENCE: ['Divergensi CVD bullish', 'CVD naik saat harga membuat low baru'],
  ATR_CONTRACTION: ['Volatilitas mengerut', 'ATR14 0,72× nilai 20 candle lalu'],
  EMA_CONVERGENCE: ['EMA7 & EMA25 merapat', 'Jarak EMA 0,6 ATR dan menyempit'],
  RANGE_CONTRACTION: ['Rentang menyempit', 'Rentang 20 candle 0,68× 20 candle sebelumnya'],
  ROUNDED_BOTTOM: ['Dasar membulat', 'Fit kuadrat 40 candle: a > 0, R² 0,71, vertex di 52% jendela'],
  RISING_FLOOR: ['Dasar makin tinggi', 'Regresi swing low naik 0,08 ATR/candle dalam rentang 3,1 ATR'],
  HIGHER_LOW: ['Higher low terkonfirmasi', 'Swing low 96,80 di atas dasar 95,00 dan masih utuh'],
  SPRING_RECLAIM: ['Spring & reclaim', 'Wick menembus swing low lalu close kembali di atasnya'],
  EMA25_RECLAIM: ['Merebut EMA25', 'Close di atas EMA25 setelah 6 candle di bawahnya'],
  EMA7_TURN_UP: ['EMA7 berbalik naik', 'Slope EMA7 (5 titik) positif, EMA7 ≥ EMA25 − 0,5 ATR'],
  CHOCH_BULLISH: ['CHoCH bullish', 'Close di atas lower high terakhir sejak dasar'],
  STAIRCASE: ['Tangga naik', '2 higher low & 2 higher high berurutan, kaki ≤ 2 ATR'],
  VOLUME_DRY_UP: ['Volume mengering', 'Rata-rata volume 10 candle 0,62× 30 candle sebelumnya'],
  QUIET_RISE: ['Naik pelan tanpa volume', 'Close +1,1 ATR dalam 10 candle dengan RVOL 0,8'],
  TRIGGER_BREAK: ['Tembus level pemicu', 'Close 104,30 di atas pemicu 104,00'],
  BREAK_VOLUME_SUPPORT: ['Volume mendukung breakout', 'RVOL 1,9 pada candle breakout'],
  BREAK_FOLLOW_THROUGH: ['Follow-through breakout', 'Dua close berurutan di atas pemicu'],
});

/** Bukti lengkap (bentuk `checks` §3 yang lolos) dari daftar id. */
export function buildReversalEvidence(ids, { time = REVERSAL_SEED_T0, price = 100 } = {}) {
  return ids.map((id, i) => ({
    id, group: EVIDENCE_GROUP_OF[id], label: EVIDENCE_TEXT[id]?.[0] ?? id, detail: EVIDENCE_TEXT[id]?.[1] ?? null,
    passed: true, value: 1, threshold: 1, weight: EVIDENCE_WEIGHTS[id], index: 200 + i, time: time - i * 60_000, price: price * (1 - 0.002 * i),
  }));
}

/** Komponen skor per grup (5 entri, poin dibatasi maksimum grup) dari daftar id bukti. */
export function buildScoreComponents(ids) {
  const labels = { EXHAUSTION: 'Tekanan turun melemah', BASE: 'Dasar & kompresi', STRUCTURE: 'Perubahan struktur', VOLUME: 'Karakter volume', TRIGGER: 'Pemicu' };
  return EVIDENCE_GROUPS.map((group) => ({
    id: group,
    label: labels[group],
    points: Math.min(EVIDENCE_GROUP_MAX[group], ids.filter((id) => EVIDENCE_GROUP_OF[id] === group).reduce((s, id) => s + EVIDENCE_WEIGHTS[id], 0)),
    max: EVIDENCE_GROUP_MAX[group],
  }));
}
export const scoreOf = (ids) => buildScoreComponents(ids).reduce((s, c) => s + c.points, 0);

function levelsOf(price, atr, { higherLow = null, stage = 'EARLY_FORMATION' } = {}) {
  const bottom = Math.round(price * 0.95 * 100) / 100;
  const lastSwingLow = Math.round(price * 0.962 * 100) / 100;
  const trigger = Math.round(price * 1.04 * 100) / 100;
  let invalidation = Math.round((Math.min(bottom, lastSwingLow) - 0.25 * atr) * 100) / 100;
  if (stage === 'CONFIRMED_BREAKOUT') invalidation = Math.max(invalidation, Math.round((trigger - 0.75 * atr) * 100) / 100);
  return { bottom, lastSwingLow, higherLow, trigger, ema25: Math.round(price * 1.01 * 100) / 100, ema7: Math.round(price * 1.005 * 100) / 100, atr, invalidation };
}

function nextConfirmationOf(stage, levels) {
  if (stage === 'EARLY_FORMATION') return { kind: 'HIGHER_LOW', text: `Higher low terkonfirmasi di atas ${levels.lastSwingLow}`, level: levels.lastSwingLow };
  if (stage === 'DEVELOPING_REVERSAL') return { kind: 'TRIGGER_BREAK', text: `Close di atas level pemicu ${levels.trigger} dengan RVOL ≥ 1,5 atau dua close berurutan`, level: levels.trigger };
  if (stage === 'CONFIRMED_BREAKOUT') return { kind: 'HOLD_ABOVE_TRIGGER', text: `Bertahan di atas ${levels.trigger} saat retest`, level: levels.trigger };
  return { kind: 'NONE', text: 'Belum ada tahap yang terpenuhi', level: null };
}

/**
 * ReversalSnapshot §4 lengkap. Kunci bantu (bukan field snapshot): `price` (close saat deteksi), `atr`.
 * Semua field dapat ditimpa lewat `overrides`.
 */
export function buildReversalSnapshot(overrides = {}) {
  const { price = 100, atr = 1.2, ...rest } = overrides;
  const timeframe = rest.timeframe ?? '15m';
  const stage = rest.stage ?? 'EARLY_FORMATION';
  const ms = TIMEFRAME_MS[timeframe];
  const lastCandleTime = rest.lastCandleTime ?? REVERSAL_SEED_T0;
  const firstDetectedAt = rest.firstDetectedAt ?? lastCandleTime + ms - 1;
  const evidence = rest.evidence ?? ['LL_SHALLOWER', 'ATR_CONTRACTION', 'VOLUME_DRY_UP'];
  const levels = levelsOf(price, atr, { stage, higherLow: STAGE_RANK[stage] >= 2 ? Math.round(price * 0.968 * 100) / 100 : null });
  const base = {
    version: REVERSAL_VERSION,
    timeframe,
    stage,
    status: STATUS_OF_STAGE[stage],
    setupType: 'ROUNDED_BOTTOM',
    setupTypes: ['ROUNDED_BOTTOM', 'COMPRESSION'],
    classification: 'REVERSAL_CANDIDATE',
    firstDetectedAt,
    firstDetectedPrice: price,
    firstDetectedAtr: atr,
    firstStage: stage,
    stageEnteredAt: firstDetectedAt,
    barsInStage: 0,
    barsSinceDetection: 0,
    lastCandleTime,
    lastEvaluatedAt: lastCandleTime + ms - 1,
    score: scoreOf(evidence),
    scoreComponents: buildScoreComponents(evidence),
    evidence,
    evidenceCount: evidence.length,
    levels,
    nextConfirmation: nextConfirmationOf(stage, levels),
    cancelCondition: { text: `Close di bawah ${levels.invalidation} (bukan wick)`, level: levels.invalidation },
    risks: [],
    liquidityClass: 'LIQUID',
    markers: [
      { time: lastCandleTime - 12 * ms, kind: 'BOTTOM', price: levels.bottom, label: 'Dasar' },
      { time: lastCandleTime - 4 * ms, kind: 'HIGHER_LOW', price: levels.lastSwingLow, label: 'Higher low' },
      { time: lastCandleTime, kind: 'DETECTED', price, label: 'Deteksi pertama' },
    ],
    peakPrice: price,
    peakStage: stage,
    moveSinceDetectionPct: 0,
    moveSinceDetectionAtr: 0,
    extended: false,
    pendingStage: null,
    pendingBars: 0,
    weakBars: 0,
    closeReason: null,
  };
  return { ...base, ...rest };
}

/** ReversalEvaluation §3 lengkap (default provisional: true, untuk setProvisional). Kunci bantu: `price`, `atr`. */
export function buildReversalEvaluation(overrides = {}) {
  const { price = 100, atr = 1.2, ...rest } = overrides;
  const timeframe = rest.timeframe ?? '15m';
  const stage = rest.stage === undefined ? 'EARLY_FORMATION' : rest.stage;
  const ms = TIMEFRAME_MS[timeframe];
  const candleOpenTime = rest.candleOpenTime ?? REVERSAL_SEED_T0 + ms;
  const evidenceIds = rest.evidenceIds ?? ['LL_SHALLOWER', 'ATR_CONTRACTION', 'VOLUME_DRY_UP'];
  const evidence = rest.evidence ?? buildReversalEvidence(evidenceIds, { time: candleOpenTime, price });
  const provisional = rest.provisional ?? true;
  const levels = levelsOf(price, atr, { stage: stage ?? 'EARLY_FORMATION' });
  const plain = { ...rest };
  delete plain.evidenceIds;
  const base = {
    version: REVERSAL_VERSION,
    timeframe,
    provisional,
    candleOpenTime,
    evaluatedAt: candleOpenTime + ms - 1,
    classification: stage === null ? 'NO_SETUP' : 'REVERSAL_CANDIDATE',
    stage,
    setupType: stage === null ? null : 'ROUNDED_BOTTOM',
    setupTypes: stage === null ? [] : ['ROUNDED_BOTTOM'],
    context: {
      priorDecline: { ok: true, declinePct: 0.09, declineAtr: 3.4, highIndex: 150, bottomIndex: 230, bottomPrice: levels.bottom, barsSinceBottom: 18, ema25Falling: false },
      htf: { timeframe: timeframe === '1h' ? null : '1h', trend: timeframe === '1h' ? null : 'NEUTRAL', detail: timeframe === '1h' ? 'Tidak ada timeframe lebih tinggi' : 'EMA25 1h mendatar' },
      liquidityClass: 'LIQUID',
    },
    checks: evidence,
    evidence,
    evidenceCount: evidence.length,
    score: { total: scoreOf(evidence.map((e) => e.id)), components: buildScoreComponents(evidence.map((e) => e.id)) },
    levels,
    nextConfirmation: nextConfirmationOf(stage, levels),
    cancelCondition: { text: `Close di bawah ${levels.invalidation} (bukan wick)`, level: levels.invalidation },
    risks: provisional ? ['PROVISIONAL'] : [],
    markers: [{ time: candleOpenTime - 12 * ms, kind: 'BOTTOM', price: levels.bottom, label: 'Dasar' }],
    measures: { rsi: 41.2, atrRatio: 0.72, rvol: 0.8 },
  };
  return { ...base, ...plain };
}

const EARLY_IDS = ['LL_SHALLOWER', 'LL_STOPPED', 'DOWN_MOMENTUM_FADING', 'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'RANGE_CONTRACTION', 'ROUNDED_BOTTOM', 'VOLUME_DRY_UP', 'QUIET_RISE'];
const DEVELOPING_IDS = [...EARLY_IDS, 'HIGHER_LOW', 'EMA25_RECLAIM'];
const CONFIRMED_IDS = [...DEVELOPING_IDS, 'CHOCH_BULLISH', 'TRIGGER_BREAK', 'BREAK_VOLUME_SUPPORT', 'BREAK_FOLLOW_THROUGH'];

/**
 * Matriks kandidat SINTETIS. `stages` = rantai tahap (OPENED pada tahap pertama, STAGE_UP berikutnya); `closeReason` =
 * ditutup CANCELLED di akhir; `provisional` = evaluasi candle berjalan sesudahnya (tanpa `stages` = provisional-only).
 * Skor: AAA 54, BBB 70, CCC 88 (extended), DDD 19 (batal), EEE 48 (provisional-only), FFF 23 (ILLIQUID, provisional DEVELOPING).
 */
export const REVERSAL_SEED_ROWS = Object.freeze([
  { symbol: 'AAAUSDT', timeframe: '5m', stages: ['EARLY_FORMATION'], evidence: EARLY_IDS, liquidityClass: 'LIQUID', tick: 1, price: 100 },
  { symbol: 'BBBUSDT', timeframe: '15m', stages: ['EARLY_FORMATION', 'DEVELOPING_REVERSAL'], evidence: DEVELOPING_IDS, liquidityClass: 'LIQUID', tick: 2, price: 2.5 },
  {
    symbol: 'CCCUSDT', timeframe: '1h', stages: ['DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT'], evidence: CONFIRMED_IDS, liquidityClass: 'THIN', tick: 3, price: 0.42,
    extra: { extended: true, moveSinceDetectionPct: 0.09, moveSinceDetectionAtr: 2.7, risks: ['LOW_LIQUIDITY', 'EXTENDED'], setupType: 'STAIRCASE', setupTypes: ['STAIRCASE', 'HIGHER_LOW_BASE'] },
  },
  { symbol: 'DDDUSDT', timeframe: '15m', stages: ['EARLY_FORMATION'], evidence: ['LL_SHALLOWER', 'ATR_CONTRACTION', 'VOLUME_DRY_UP'], liquidityClass: 'LIQUID', tick: 4, price: 15, closeReason: 'CLOSE_BELOW_INVALIDATION' },
  { symbol: 'EEEUSDT', timeframe: '5m', stages: [], liquidityClass: 'LIQUID', tick: 5, price: 7.3,
    provisional: { stage: 'EARLY_FORMATION', evidence: ['LL_SHALLOWER', 'BOTTOM_HELD', 'RSI_DIVERGENCE', 'ROUNDED_BOTTOM', 'RISING_FLOOR', 'VOLUME_DRY_UP', 'QUIET_RISE'] } },
  {
    symbol: 'FFFUSDT', timeframe: '15m', stages: ['EARLY_FORMATION'], evidence: ['LL_STOPPED', 'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'DOWN_MOMENTUM_FADING'], liquidityClass: 'ILLIQUID', tick: 6, price: 0.088,
    extra: { risks: ['ILLIQUID'] },
    provisional: { stage: 'DEVELOPING_REVERSAL', evidence: ['LL_STOPPED', 'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'DOWN_MOMENTUM_FADING', 'HIGHER_LOW'] },
  },
]);

/** Candle tertutup sintetis (60 candle: turun lalu mendatar) yang berakhir di `lastCandleTime`. */
export function seedCandlesFor({ symbol, timeframe, lastCandleTime, price, seed }) {
  const ms = TIMEFRAME_MS[timeframe];
  return generateCandles({
    seed, symbol, timeframe, startTime: lastCandleTime - 59 * ms, startPrice: price * 1.08,
    segments: [
      { bars: 30, drift: -0.0028, cycle: [0.002, -0.003, 0.001, -0.002], volume: 1200, volumeEnd: 900, volumeNoise: 0.15 },
      { bars: 30, drift: 0.0004, cycle: [0.0015, -0.0015], volume: 700, volumeEnd: 600, volumeNoise: 0.1 },
    ],
  });
}

/**
 * Menulis matriks kandidat ke database lewat repositori asli. `withCandles` juga menyimpan 60 candle tertutup sintetis
 * per seri (harga terakhir & grafik di UI/E2E); false → lastPrice null.
 * @returns {Promise<{ rows: object[], ids: Record<string, number|null> }>} id kandidat per simbol (null = provisional-only)
 */
export async function seedReversalCandidates(repos, { rows = REVERSAL_SEED_ROWS, withCandles = true, now = REVERSAL_SEED_NOW } = {}) {
  await repos.symbols.upsertFromExchange(rows.map(({ symbol }) => ({
    symbol, baseAsset: symbol.replace(/USDT$/, ''), quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
    tickSize: '0.0001', stepSize: '1', onboardDate: 0,
  })), now);
  const ids = {};
  for (const [i, row] of rows.entries()) {
    const ms = TIMEFRAME_MS[row.timeframe];
    const firstCandle = Math.floor((REVERSAL_SEED_T0 + row.tick * TIMEFRAME_MS['1h']) / ms) * ms;
    const steps = row.closeReason ? [...row.stages, 'CLOSE'] : row.stages;
    let lastCandleTime = firstCandle - ms;
    let fromStage = null;
    let fromStatus = 'NONE';
    ids[row.symbol] = null;
    for (const [k, step] of steps.entries()) {
      const candleTime = firstCandle + k * ms;
      lastCandleTime = candleTime;
      const closing = step === 'CLOSE';
      const stage = closing ? fromStage : step;
      const status = closing ? 'CANCELLED' : STATUS_OF_STAGE[stage];
      const price = row.price * (1 + 0.004 * k);
      const snapshot = buildReversalSnapshot({
        timeframe: row.timeframe, stage, status, price, atr: row.price * 0.012, evidence: row.evidence,
        firstDetectedAt: firstCandle + ms - 1, firstDetectedPrice: row.price, firstStage: row.stages[0],
        stageEnteredAt: candleTime + ms - 1, lastCandleTime: candleTime, lastEvaluatedAt: candleTime + ms - 1,
        barsInStage: closing ? k : 0, barsSinceDetection: k, peakPrice: price, peakStage: stage,
        liquidityClass: row.liquidityClass, closeReason: closing ? row.closeReason : null, ...(row.extra ?? {}),
      });
      const type = k === 0 ? 'OPENED' : closing ? 'CANCELLED' : 'STAGE_UP';
      const event = {
        type, fromStage, toStage: stage, fromStatus, toStatus: status, candleTime, occurredAt: candleTime + ms - 1, price,
        reason: type === 'OPENED' ? 'STAGE_EVIDENCE' : closing ? row.closeReason : 'STAGE_EVIDENCE', provisional: false,
        detail: { score: snapshot.score, evidence: snapshot.evidence, levels: snapshot.levels, seed: 'SINTETIS' },
      };
      const saved = await repos.reversal.save({
        symbol: row.symbol, timeframe: row.timeframe, snapshot, events: [event],
        evidence: buildReversalEvidence(row.evidence, { time: candleTime, price }),
      });
      ids[row.symbol] = saved.id;
      fromStage = stage;
      fromStatus = status;
    }
    if (row.provisional) {
      const candleOpenTime = lastCandleTime + ms;
      const evaluation = buildReversalEvaluation({
        timeframe: row.timeframe, stage: row.provisional.stage, candleOpenTime, price: row.price * 1.01, atr: row.price * 0.012,
        evidenceIds: row.provisional.evidence, context: undefined,
      });
      evaluation.context = { ...evaluation.context, liquidityClass: row.liquidityClass };
      await repos.reversal.setProvisional({ symbol: row.symbol, timeframe: row.timeframe, evaluation, price: row.price * 1.01, now: candleOpenTime + 60_000 });
    }
    if (withCandles) {
      const candles = seedCandlesFor({ symbol: row.symbol, timeframe: row.timeframe, lastCandleTime, price: row.price, seed: 100 + i });
      const result = await repos.candles.upsertClosed(candles, { now });
      if (result.rejected.length > 0) throw new Error(`candle seed ditolak: ${result.rejected[0].errors.join(', ')}`);
    }
  }
  return { rows, ids };
}
