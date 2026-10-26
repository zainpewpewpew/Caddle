// Fixture SINTETIS (bukan data pasar) untuk tes E2E UI Reversal Radar: respons GET /api/reversal/candidates dan
// GET /api/reversal/candidates/:id sesuai kontrak docs/19 §5 & §7, dimock di browser lewat page.route sehingga tes
// hermetis dan tidak bergantung pada backend reversal. Satu kandidat per tahap × timeframe, satu provisional-only,
// satu extended, satu terlambat, risiko & bukti lengkap, satu kandidat terbuka dengan tahap provisional lebih tinggi.

export const REVERSAL_NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const MIN = 60_000;
const TF_MS = { '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN };
export const REVERSAL_TIMEFRAMES = ['5m', '15m', '1h'];
export const SENSITIVITY_FILTERS = {
  LOW: { minScore: 60, minEvidence: 4 }, MEDIUM: { minScore: 45, minEvidence: 3 }, HIGH: { minScore: 0, minEvidence: 0 },
};
export const WORKER_RUNNING = { enabled: true, state: 'running', startedAt: REVERSAL_NOW - 3_600_000, stoppedAt: null, exitCode: null, signal: null };

// Selaras dengan backend/reversal/constants.js (bobot & grup bukti); teks label/detail = teks fixture (sintetis).
const GROUP_OF = {
  LL_SHALLOWER: 'EXHAUSTION', LL_STOPPED: 'EXHAUSTION', BOTTOM_HELD: 'EXHAUSTION', DOWN_MOMENTUM_FADING: 'EXHAUSTION',
  RSI_DIVERGENCE: 'EXHAUSTION', CVD_DIVERGENCE: 'EXHAUSTION',
  ATR_CONTRACTION: 'BASE', EMA_CONVERGENCE: 'BASE', RANGE_CONTRACTION: 'BASE', ROUNDED_BOTTOM: 'BASE', RISING_FLOOR: 'BASE',
  HIGHER_LOW: 'STRUCTURE', SPRING_RECLAIM: 'STRUCTURE', EMA25_RECLAIM: 'STRUCTURE', EMA7_TURN_UP: 'STRUCTURE',
  CHOCH_BULLISH: 'STRUCTURE', STAIRCASE: 'STRUCTURE',
  VOLUME_DRY_UP: 'VOLUME', QUIET_RISE: 'VOLUME',
  TRIGGER_BREAK: 'TRIGGER', BREAK_VOLUME_SUPPORT: 'TRIGGER', BREAK_FOLLOW_THROUGH: 'TRIGGER',
};
const WEIGHTS = {
  LL_SHALLOWER: 8, LL_STOPPED: 6, BOTTOM_HELD: 7, DOWN_MOMENTUM_FADING: 5, RSI_DIVERGENCE: 8, CVD_DIVERGENCE: 5,
  ATR_CONTRACTION: 6, EMA_CONVERGENCE: 6, RANGE_CONTRACTION: 5, ROUNDED_BOTTOM: 8, RISING_FLOOR: 7,
  HIGHER_LOW: 10, SPRING_RECLAIM: 6, EMA25_RECLAIM: 6, EMA7_TURN_UP: 4, CHOCH_BULLISH: 8, STAIRCASE: 6,
  VOLUME_DRY_UP: 5, QUIET_RISE: 5,
  TRIGGER_BREAK: 4, BREAK_VOLUME_SUPPORT: 3, BREAK_FOLLOW_THROUGH: 3,
};
const GROUP_MAX = { EXHAUSTION: 25, BASE: 25, STRUCTURE: 30, VOLUME: 10, TRIGGER: 10 };
const GROUP_LABEL = { EXHAUSTION: 'Tekanan turun melemah', BASE: 'Dasar & kompresi', STRUCTURE: 'Perubahan struktur', VOLUME: 'Karakter volume', TRIGGER: 'Pemicu' };
const LABELS = {
  LL_SHALLOWER: 'Lower low makin dangkal', LL_STOPPED: 'Lower low berhenti', BOTTOM_HELD: 'Dasar bertahan saat retest',
  DOWN_MOMENTUM_FADING: 'Momentum turun memudar', RSI_DIVERGENCE: 'Divergensi RSI bullish', CVD_DIVERGENCE: 'Divergensi CVD bullish',
  ATR_CONTRACTION: 'Kontraksi ATR', EMA_CONVERGENCE: 'EMA7 & EMA25 merapat', RANGE_CONTRACTION: 'Range menyempit',
  ROUNDED_BOTTOM: 'Dasar membulat', RISING_FLOOR: 'Dasar makin tinggi', HIGHER_LOW: 'Higher low terkonfirmasi',
  SPRING_RECLAIM: 'Spring: sapuan lalu reclaim', EMA25_RECLAIM: 'Reclaim EMA25', EMA7_TURN_UP: 'EMA7 berbalik naik',
  CHOCH_BULLISH: 'CHoCH bullish', STAIRCASE: 'Struktur tangga naik', VOLUME_DRY_UP: 'Volume mengering',
  QUIET_RISE: 'Naik tenang (RVOL rendah)', TRIGGER_BREAK: 'Close di atas level pemicu',
  BREAK_VOLUME_SUPPORT: 'Breakout didukung volume', BREAK_FOLLOW_THROUGH: 'Follow-through breakout',
};
const STATUS_OF_STAGE = { EARLY_FORMATION: 'NEW', DEVELOPING_REVERSAL: 'DEVELOPING', CONFIRMED_BREAKOUT: 'CONFIRMED' };
const STAGE_RANK = { EARLY_FORMATION: 1, DEVELOPING_REVERSAL: 2, CONFIRMED_BREAKOUT: 3 };

/** Harga dibulatkan 6 desimal agar deterministik di JSON. */
const px = (v) => Number(v.toFixed(6));

function evidenceList(ids, { time, price }) {
  return ids.map((id, i) => ({
    id, label: LABELS[id], detail: `${LABELS[id]} — detail sintetis #${i + 1}`, group: GROUP_OF[id],
    time: time - i * 3, price: px(price * (1 - i * 0.001)),
  }));
}

function scoreComponents(ids) {
  const sum = Object.fromEntries(Object.keys(GROUP_MAX).map((g) => [g, 0]));
  for (const id of ids) sum[GROUP_OF[id]] += WEIGHTS[id];
  return Object.keys(GROUP_MAX).map((g) => ({ id: g, label: GROUP_LABEL[g], points: Math.min(GROUP_MAX[g], sum[g]), max: GROUP_MAX[g] }));
}

const scoreOf = (ids) => scoreComponents(ids).reduce((acc, c) => acc + c.points, 0);

/**
 * Satu baris API `toView` (docs/19 §5) + lastPrice/lastCandleAt dari route. Angka diturunkan dari `price` secara
 * deterministik; waktu relatif terhadap REVERSAL_NOW pada kisi timeframe.
 */
export function candidate({
  id, symbol, timeframe, stage, evidence, risks = [], liquidityClass = 'LIQUID', setupType = 'HIGHER_LOW_BASE', setupTypes,
  price, extended = false, movePct = 0.012, moveAtr = 0.6, candleStatus = 'CLOSED', provisional = null, provisionalOnly = false,
}) {
  const tfMs = TF_MS[timeframe];
  const lastCandleTime = Math.floor((REVERSAL_NOW - 2 * tfMs) / tfMs) * tfMs;
  const lastEvaluatedAt = lastCandleTime + tfMs - 1;
  const openedCandle = lastCandleTime - 20 * tfMs;
  const stageEnteredCandle = lastCandleTime - 6 * tfMs;
  const atr = px(price * 0.01);
  const bottom = px(price * 0.92);
  const lastSwingLow = px(price * 0.94);
  const higherLow = STAGE_RANK[stage] >= 2 ? px(price * 0.96) : null;
  const trigger = px(price * 1.03);
  const invalidation = px(Math.min(bottom, lastSwingLow) - 0.25 * atr);
  const nextByStage = {
    EARLY_FORMATION: { kind: 'HIGHER_LOW', text: `Higher low terkonfirmasi di atas ${lastSwingLow}`, level: lastSwingLow },
    DEVELOPING_REVERSAL: { kind: 'TRIGGER_BREAK', text: `Close di atas level pemicu ${trigger} dengan RVOL ≥ 1,5 atau dua close berurutan`, level: trigger },
    CONFIRMED_BREAKOUT: { kind: 'HOLD_ABOVE_TRIGGER', text: `Bertahan di atas ${trigger} saat retest`, level: trigger },
  };
  const ev = evidenceList(evidence, { time: lastCandleTime, price });
  const components = scoreComponents(evidence);
  const score = scoreOf(evidence);
  const base = {
    id: provisionalOnly ? null : id,
    symbol, timeframe, version: 1, stage,
    status: STATUS_OF_STAGE[stage],
    setupType, setupTypes: setupTypes ?? [setupType],
    score, scoreComponents: components,
    evidence: ev, evidenceCount: ev.length,
    firstDetectedAt: provisionalOnly ? null : openedCandle + tfMs - 1,
    firstDetectedPrice: provisionalOnly ? null : px(price * (1 - movePct)),
    firstDetectedAtr: provisionalOnly ? null : atr,
    stageEnteredAt: provisionalOnly ? null : stageEnteredCandle + tfMs - 1,
    lastCandleTime, lastEvaluatedAt,
    levels: { bottom, lastSwingLow, higherLow, trigger, ema25: px(price * 0.99), ema7: px(price * 1.002), atr, invalidation },
    nextConfirmation: nextByStage[stage],
    cancelCondition: { text: `Close candle ${timeframe} di bawah level invalidasi ${invalidation}`, level: invalidation },
    risks: provisionalOnly ? [...new Set([...risks, 'PROVISIONAL'])] : risks,
    liquidityClass, extended,
    moveSinceDetectionPct: provisionalOnly ? null : movePct,
    moveSinceDetectionAtr: provisionalOnly ? null : moveAtr,
    peakPrice: provisionalOnly ? null : px(price * (1 + 0.004)),
    markers: [
      { time: lastCandleTime - 15 * tfMs, kind: 'BOTTOM', price: bottom, label: 'Bottom' },
      { time: lastCandleTime - 11 * tfMs, kind: 'LOWER_LOW', price: lastSwingLow, label: 'Lower low' },
      ...(higherLow !== null ? [{ time: lastCandleTime - 5 * tfMs, kind: 'HIGHER_LOW', price: higherLow, label: 'Higher low' }] : []),
      ...(STAGE_RANK[stage] === 3 ? [{ time: lastCandleTime, kind: 'TRIGGER', price: trigger, label: 'Trigger' }] : []),
    ],
    closeReason: null, closedAt: null, updatedAt: lastEvaluatedAt,
    provisional: null,
    provisionalOnly,
    candleStatus,
    lastPrice: px(price), lastCandleAt: lastEvaluatedAt,
  };
  if (provisionalOnly) {
    const provEvidence = ev.map((e) => ({ ...e, time: lastCandleTime + tfMs }));
    base.provisional = {
      stage, score, evaluatedAt: REVERSAL_NOW - 30_000, candleOpenTime: lastCandleTime + tfMs,
      evidenceCount: provEvidence.length, evidence: provEvidence, risks: base.risks,
    };
    base.candleStatus = 'RUNNING';
    base.lastCandleTime = lastCandleTime + tfMs;
    base.lastEvaluatedAt = REVERSAL_NOW - 30_000;
    base.updatedAt = REVERSAL_NOW - 30_000;
  } else if (provisional) {
    const ids = provisional.evidence;
    base.provisional = {
      stage: provisional.stage, score: scoreOf(ids), evaluatedAt: REVERSAL_NOW - 20_000, candleOpenTime: lastCandleTime + tfMs,
      evidenceCount: ids.length, evidence: evidenceList(ids, { time: lastCandleTime + tfMs, price }),
      risks: [...new Set([...risks, 'PROVISIONAL'])],
    };
    base.candleStatus = 'RUNNING';
  }
  return base;
}

/** Sepuluh baris: 1 per tahap × timeframe (9) + 1 provisional-only (EARLY 15m). Urutan server: score DESC. */
export function reversalCandidates() {
  const rows = [
    candidate({ id: 1, symbol: 'ALPUSDT', timeframe: '5m', stage: 'EARLY_FORMATION', setupType: 'DOUBLE_BOTTOM', setupTypes: ['DOUBLE_BOTTOM', 'DIVERGENCE_BOTTOM'], price: 0.0825,
      evidence: ['LL_SHALLOWER', 'LL_STOPPED', 'BOTTOM_HELD', 'RSI_DIVERGENCE', 'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'ROUNDED_BOTTOM', 'VOLUME_DRY_UP'],
      risks: ['LOW_LIQUIDITY', 'HTF_DOWNTREND'], liquidityClass: 'THIN', movePct: 0.008, moveAtr: 0.4 }), // skor 50
    candidate({ id: 2, symbol: 'BETUSDT', timeframe: '15m', stage: 'EARLY_FORMATION', setupType: 'COMPRESSION', price: 1.234,
      evidence: ['LL_SHALLOWER', 'DOWN_MOMENTUM_FADING', 'CVD_DIVERGENCE', 'RANGE_CONTRACTION', 'RISING_FLOOR', 'ATR_CONTRACTION', 'QUIET_RISE', 'VOLUME_DRY_UP'],
      risks: ['NEAR_INVALIDATION'], movePct: 0.004, moveAtr: 0.2 }), // skor 46
    candidate({ id: 3, symbol: 'GAMUSDT', timeframe: '1h', stage: 'EARLY_FORMATION', setupType: 'ROUNDED_BOTTOM', price: 15.72,
      evidence: ['LL_STOPPED', 'BOTTOM_HELD', 'RSI_DIVERGENCE', 'ROUNDED_BOTTOM', 'EMA_CONVERGENCE', 'RANGE_CONTRACTION', 'VOLUME_DRY_UP'],
      risks: ['HTF_UNKNOWN'], movePct: 0.011, moveAtr: 0.5 }), // skor 45
    candidate({ id: 4, symbol: 'DELUSDT', timeframe: '5m', stage: 'DEVELOPING_REVERSAL', setupType: 'HIGHER_LOW_BASE', price: 0.4471,
      evidence: ['LL_SHALLOWER', 'LL_STOPPED', 'BOTTOM_HELD', 'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'HIGHER_LOW', 'EMA25_RECLAIM', 'EMA7_TURN_UP', 'VOLUME_DRY_UP', 'QUIET_RISE'],
      risks: [], movePct: 0.019, moveAtr: 0.9 }), // skor 63
    candidate({ id: 5, symbol: 'EPSUSDT', timeframe: '15m', stage: 'DEVELOPING_REVERSAL', setupType: 'SPRING', setupTypes: ['SPRING', 'HIGHER_LOW_BASE'], price: 3.058,
      evidence: ['RSI_DIVERGENCE', 'BOTTOM_HELD', 'LL_STOPPED', 'ROUNDED_BOTTOM', 'ATR_CONTRACTION', 'HIGHER_LOW', 'CHOCH_BULLISH', 'EMA25_RECLAIM', 'QUIET_RISE'],
      risks: ['VOLATILITY_EXPANDING'], movePct: 0.024, moveAtr: 1.1,
      // Candle 15m yang sedang berjalan sudah memenuhi syarat CONFIRMED (belum dikonfirmasi candle tutup).
      provisional: { stage: 'CONFIRMED_BREAKOUT', evidence: ['RSI_DIVERGENCE', 'BOTTOM_HELD', 'ROUNDED_BOTTOM', 'HIGHER_LOW', 'CHOCH_BULLISH', 'EMA25_RECLAIM', 'TRIGGER_BREAK', 'BREAK_VOLUME_SUPPORT'] } }), // skor 64
    candidate({ id: 6, symbol: 'ZETUSDT', timeframe: '1h', stage: 'DEVELOPING_REVERSAL', setupType: 'STAIRCASE', price: 0.000512,
      evidence: ['LL_SHALLOWER', 'CVD_DIVERGENCE', 'RISING_FLOOR', 'RANGE_CONTRACTION', 'HIGHER_LOW', 'STAIRCASE', 'EMA7_TURN_UP', 'VOLUME_DRY_UP'],
      risks: ['LOW_LIQUIDITY', 'HTF_UNKNOWN'], liquidityClass: 'THIN', movePct: 0.016, moveAtr: 0.8 }), // skor 50
    candidate({ id: 7, symbol: 'ETAUSDT', timeframe: '5m', stage: 'CONFIRMED_BREAKOUT', setupType: 'HIGHER_LOW_BASE', price: 2.917,
      evidence: ['LL_STOPPED', 'BOTTOM_HELD', 'ATR_CONTRACTION', 'HIGHER_LOW', 'CHOCH_BULLISH', 'EMA25_RECLAIM', 'EMA7_TURN_UP', 'QUIET_RISE', 'TRIGGER_BREAK', 'BREAK_FOLLOW_THROUGH'],
      risks: ['EXTENDED', 'NO_VOLUME_SUPPORT'], extended: true, movePct: 0.094, moveAtr: 2.9 }), // skor 59, extended
    candidate({ id: 8, symbol: 'THEUSDT', timeframe: '15m', stage: 'CONFIRMED_BREAKOUT', setupType: 'SPRING', price: 0.6612,
      evidence: ['RSI_DIVERGENCE', 'LL_SHALLOWER', 'BOTTOM_HELD', 'ROUNDED_BOTTOM', 'EMA_CONVERGENCE', 'HIGHER_LOW', 'SPRING_RECLAIM', 'EMA25_RECLAIM', 'CHOCH_BULLISH', 'VOLUME_DRY_UP', 'QUIET_RISE', 'TRIGGER_BREAK', 'BREAK_VOLUME_SUPPORT', 'BREAK_FOLLOW_THROUGH'],
      risks: ['LATE_ENTRY'], movePct: 0.031, moveAtr: 1.2 }), // skor 87, terlambat
    candidate({ id: 9, symbol: 'IOTUSDT', timeframe: '1h', stage: 'CONFIRMED_BREAKOUT', setupType: 'HIGHER_LOW_BASE', price: 0.2108,
      evidence: ['LL_STOPPED', 'DOWN_MOMENTUM_FADING', 'RISING_FLOOR', 'RANGE_CONTRACTION', 'HIGHER_LOW', 'EMA25_RECLAIM', 'TRIGGER_BREAK', 'BREAK_VOLUME_SUPPORT'],
      risks: ['HTF_UNKNOWN'], movePct: 0.027, moveAtr: 1.0 }), // skor 46
    candidate({ id: 10, symbol: 'KAPUSDT', timeframe: '15m', stage: 'EARLY_FORMATION', setupType: 'COMPRESSION', price: 7.41, provisionalOnly: true,
      evidence: ['LL_SHALLOWER', 'RSI_DIVERGENCE', 'LL_STOPPED', 'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'ROUNDED_BOTTOM', 'VOLUME_DRY_UP'],
      risks: [] }), // skor 47, provisional-only (id null)
  ];
  return rows.sort((a, b) => b.score - a.score || (b.firstDetectedAt ?? 0) - (a.firstDetectedAt ?? 0));
}

const LIQUIDITY_RANK = { LIQUID: 3, THIN: 2, ILLIQUID: 1, UNKNOWN: 0 };

/**
 * Semantik filter server (docs/19 §7) atas fixture: timeframe, stage, status, liquidity (kelas minimum), sensitivitas
 * (minScore/minEvidence; minScore eksplisit menang), includeExtended, includeProvisional, limit.
 * @param {object[]} items
 * @param {URLSearchParams} params
 */
export function filterCandidates(items, params) {
  const sensitivity = ['LOW', 'MEDIUM', 'HIGH'].includes(params.get('sensitivity')) ? params.get('sensitivity') : 'MEDIUM';
  const thresholds = SENSITIVITY_FILTERS[sensitivity];
  const minScore = params.get('minScore') !== null ? Number(params.get('minScore')) : thresholds.minScore;
  const minEvidence = thresholds.minEvidence;
  const includeExtended = params.get('includeExtended') !== '0';
  const includeProvisional = params.get('includeProvisional') !== '0';
  const limit = params.get('limit') !== null ? Number(params.get('limit')) : 200;
  const out = items.filter((r) => {
    if (params.get('timeframe') && r.timeframe !== params.get('timeframe')) return false;
    if (params.get('stage') && r.stage !== params.get('stage')) return false;
    if (params.get('status') && r.status !== params.get('status')) return false;
    if (params.get('liquidity') && (LIQUIDITY_RANK[r.liquidityClass] ?? 0) < LIQUIDITY_RANK[params.get('liquidity')]) return false;
    if (r.score < minScore || r.evidenceCount < minEvidence) return false;
    if (!includeExtended && r.extended) return false;
    if (!includeProvisional && r.provisionalOnly) return false;
    return true;
  }).slice(0, limit);
  return { items: out, count: out.length, meta: { timeframes: REVERSAL_TIMEFRAMES, sensitivity, filters: SENSITIVITY_FILTERS } };
}

/** Event riwayat sintetis: OPENED (tahap awal), STAGE_UP per kenaikan tahap, + PROVISIONAL_STAGE bila ada provisional. */
export function eventsFor(row) {
  if (row.provisionalOnly || !Number.isInteger(row.id)) return [];
  const tfMs = TF_MS[row.timeframe];
  const openedCandle = row.firstDetectedAt - tfMs + 1;
  const stages = ['EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT'].slice(0, STAGE_RANK[row.stage]);
  const events = [];
  stages.forEach((stage, i) => {
    const candleTime = openedCandle + i * 7 * tfMs;
    events.push({
      type: i === 0 ? 'OPENED' : 'STAGE_UP', fromStage: i === 0 ? null : stages[i - 1], toStage: stage,
      fromStatus: i === 0 ? null : STATUS_OF_STAGE[stages[i - 1]], toStatus: STATUS_OF_STAGE[stage],
      candleTime, occurredAt: candleTime + tfMs - 1, price: row.firstDetectedPrice * (1 + i * 0.01),
      reason: i === 0 ? 'STAGE_EVIDENCE' : null, provisional: false, detail: { score: row.score - (stages.length - 1 - i) * 5 },
    });
  });
  if (row.provisional) {
    events.push({
      type: 'PROVISIONAL_STAGE', fromStage: row.stage, toStage: row.provisional.stage, fromStatus: row.status, toStatus: STATUS_OF_STAGE[row.provisional.stage],
      candleTime: row.provisional.candleOpenTime, occurredAt: row.provisional.evaluatedAt, price: row.lastPrice,
      reason: null, provisional: true, detail: { score: row.provisional.score },
    });
  }
  return events;
}

/** Respons GET /api/reversal/candidates/:id (item + events) atau null (404). */
export function reversalDetail(id, items = reversalCandidates()) {
  const row = items.find((r) => r.id === Number(id));
  return row ? { ...row, events: eventsFor(row) } : null;
}

/**
 * Candle SINTETIS deterministik (jalan harga sinus + noise LCG) agar mini-chart kandidat benar-benar dirender, termasuk
 * candle pada waktu penanda bukti. Bentuk = GET /api/market/candles (openTime epoch ms, urut naik).
 */
export function syntheticCandles(symbol, timeframe, { count = 160, base = 1 } = {}) {
  const tfMs = TF_MS[timeframe] ?? TF_MS['15m'];
  const last = Math.floor((REVERSAL_NOW - 2 * tfMs) / tfMs) * tfMs;
  let seed = [...symbol].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 2_147_483_647, 7);
  const rand = () => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  const items = [];
  let close = base;
  for (let i = count - 1; i >= 0; i -= 1) {
    const openTime = last - i * tfMs;
    const drift = Math.sin((count - i) / 17) * 0.004 + (rand() - 0.5) * 0.006;
    const open = close;
    close = px(open * (1 + drift));
    const high = px(Math.max(open, close) * (1 + rand() * 0.003));
    const low = px(Math.min(open, close) * (1 - rand() * 0.003));
    items.push({ openTime, open: px(open), high, low, close, volume: Math.round(1_000 + rand() * 4_000) });
  }
  return items;
}
