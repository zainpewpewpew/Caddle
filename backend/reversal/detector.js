// Detektor Reversal Radar — `evaluateReversal(input)` → ReversalEvaluation (docs/19 §3).
//
// Metode: pada candle TERAKHIR array (titik evaluasi) dihitung konteks penurunan awal (dasar = low terendah
// `bottomLookback` candle; penurunan dari close tertinggi `declineLookback` candle sebelum dasar), lalu 22
// pemeriksaan bukti dalam lima grup (EXHAUSTION, BASE, STRUCTURE, VOLUME, TRIGGER) dengan bobot tetap
// (constants.js). Skor = Σ poin grup (maks 25+25+30+10+10 = 100) — skor ATURAN yang dapat dijelaskan, BUKAN
// probabilitas dan bukan perintah transaksi. Tahap (EARLY/DEVELOPING/CONFIRMED) = tahap yang buktinya terpenuhi
// pada candle ini, SEBELUM histeresis state machine (stateMachine.js).
//
// Anti-lookahead: hanya candle ≤ indeks evaluasi yang dipakai; swing hanya bila confirmedIndex ≤ indeks
// evaluasi; level pemicu memakai high sampai candle SEBELUM evaluasi; candle HTF dipotong closeTime ≤ closeTime
// candle evaluasi (walau pemanggil seharusnya sudah memotong). Akibatnya hasil untuk prefiks candles.slice(0, k+1)
// tidak berubah saat candle masa depan ditambahkan (tes UNIT-RR-D prefiks).
//
// Candle berjalan: provisional=true mengizinkan candle terakhir isClosed=false (hasil berlabel provisional &
// risiko PROVISIONAL); selain itu candle terakhir belum tutup → RangeError. Fungsi murni: tanpa I/O, tanpa
// Date.now(). Semua teks dalam bahasa Indonesia dengan angka konkret; teks menyatakan bukti/kondisi, bukan
// klaim bahwa tren pasti berbalik.
//
// Keputusan di luar rincian kontrak (lihat juga features.js): pemeriksaan bukti hanya dijalankan bila
// classification = REVERSAL_CANDIDATE (bukan kandidat → semua `passed: false`, skor 0); BREAK_VOLUME_SUPPORT &
// BREAK_FOLLOW_THROUGH hanya lulus bila TRIGGER_BREAK lulus; konteks HTF menilai SEMUA HTF yang tersedia
// (BEARISH bila salah satu bearish, BULLISH bila semua bullish, selain itu NEUTRAL); measures.invalidationBase =
// invalidasi tanpa lantai breakout (dipakai state machine agar invalidasi tidak ikut naik mengejar high baru).
import { HIGHER_TIMEFRAMES } from '../market/contracts.js';
import { inspectCandles } from '../patterns/conditions.js';
import { ORDER_FLOW_THRESHOLDS } from '../features/orderFlow.js';
import {
  CLASSIFICATIONS, EVIDENCE_GROUPS, EVIDENCE_GROUP_MAX, EVIDENCE_GROUP_OF, EVIDENCE_IDS, EVIDENCE_WEIGHTS, REVERSAL_TIMEFRAMES,
  REVERSAL_VERSION, RISKS, SETUP_TYPES,
} from './constants.js';
import { requiredCandles, resolveReversalParams } from './params.js';
import * as F from './features.js';
import { fmtAtr, fmtNum, fmtPct, fmtPrice } from './format.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => (isNum(v) && v > 0 ? v : null);
const orNull = (v) => (isNum(v) ? v : null);

/** Label singkat tiap bukti (bahasa Indonesia). */
export const EVIDENCE_LABELS = Object.freeze({
  LL_SHALLOWER: 'Lower low makin dangkal',
  LL_STOPPED: 'Lower low berhenti',
  BOTTOM_HELD: 'Dasar bertahan saat retest',
  DOWN_MOMENTUM_FADING: 'Momentum turun melemah',
  RSI_DIVERGENCE: 'Divergensi bullish RSI',
  CVD_DIVERGENCE: 'Divergensi bullish CVD/OBV',
  ATR_CONTRACTION: 'Volatilitas (ATR) menyusut',
  EMA_CONVERGENCE: 'EMA7 & EMA25 merapat',
  RANGE_CONTRACTION: 'Range harga menyempit',
  ROUNDED_BOTTOM: 'Dasar membulat',
  RISING_FLOOR: 'Sideways dengan dasar makin tinggi',
  HIGHER_LOW: 'Higher low terkonfirmasi',
  SPRING_RECLAIM: 'Spring: sapuan low lalu reclaim',
  EMA25_RECLAIM: 'Close merebut EMA25',
  EMA7_TURN_UP: 'EMA7 berbalik naik',
  CHOCH_BULLISH: 'Change of character bullish',
  STAIRCASE: 'Tangga higher high & higher low',
  VOLUME_DRY_UP: 'Volume mengering',
  QUIET_RISE: 'Naik pelan tanpa lonjakan volume',
  TRIGGER_BREAK: 'Close di atas level pemicu',
  BREAK_VOLUME_SUPPORT: 'Volume mendukung breakout',
  BREAK_FOLLOW_THROUGH: 'Follow-through breakout',
});

/** Label grup bukti. */
export const EVIDENCE_GROUP_LABELS = Object.freeze({
  EXHAUSTION: 'Tekanan turun melemah',
  BASE: 'Dasar & kompresi',
  STRUCTURE: 'Perubahan struktur',
  VOLUME: 'Karakter volume',
  TRIGGER: 'Pemicu',
});

const TREND_LABEL = Object.freeze({ BULLISH: 'naik', BEARISH: 'turun', NEUTRAL: 'netral' });
const TREND_SIGN = Object.freeze({ BULLISH: 1, BEARISH: -1, NEUTRAL: 0 });

/** Prioritas jenis setup: yang pertama cocok = setupType utama. */
const SETUP_RULES = Object.freeze([
  ['SPRING', ['SPRING_RECLAIM']],
  ['DOUBLE_BOTTOM', ['BOTTOM_HELD']],
  ['ROUNDED_BOTTOM', ['ROUNDED_BOTTOM']],
  ['STAIRCASE', ['STAIRCASE']],
  ['HIGHER_LOW_BASE', ['RISING_FLOOR', 'HIGHER_LOW']],
  ['DIVERGENCE_BOTTOM', ['RSI_DIVERGENCE', 'CVD_DIVERGENCE']],
  ['COMPRESSION', ['ATR_CONTRACTION', 'RANGE_CONTRACTION', 'EMA_CONVERGENCE']],
]);

function check(id, fields) {
  return {
    id,
    group: EVIDENCE_GROUP_OF[id],
    label: EVIDENCE_LABELS[id],
    detail: fields.detail,
    passed: fields.passed === true,
    value: orNull(fields.value),
    threshold: orNull(fields.threshold),
    weight: EVIDENCE_WEIGHTS[id],
    index: Number.isInteger(fields.index) ? fields.index : null,
    time: Number.isInteger(fields.time) ? fields.time : null,
    price: orNull(fields.price),
  };
}

function notEvaluatedChecks(reason) {
  return EVIDENCE_IDS.map((id) => check(id, { passed: false, value: null, threshold: null, index: null, time: null, price: null, detail: `Tidak dievaluasi: ${reason}` }));
}

function emptyPriorDecline() {
  return { ok: false, declinePct: null, declineAtr: null, highIndex: null, bottomIndex: null, bottomPrice: null, barsSinceBottom: null, ema25Falling: null };
}

function emptyLevels() {
  return { bottom: null, lastSwingLow: null, higherLow: null, trigger: null, ema25: null, ema7: null, atr: null, invalidation: null };
}

function scoreOf(checks) {
  const components = EVIDENCE_GROUPS.map((group) => {
    const raw = checks.reduce((sum, c) => sum + (c.passed && c.group === group ? c.weight : 0), 0);
    return { id: group, label: EVIDENCE_GROUP_LABELS[group], points: Math.min(EVIDENCE_GROUP_MAX[group], raw), max: EVIDENCE_GROUP_MAX[group] };
  });
  return { total: Math.round(components.reduce((sum, c) => sum + c.points, 0)), components };
}

function setupTypesOf(evidence) {
  const ids = new Set(evidence.map((c) => c.id));
  const types = SETUP_RULES.filter(([, needs]) => needs.some((id) => ids.has(id))).map(([type]) => type);
  return SETUP_TYPES.filter((t) => types.includes(t)).sort((a, b) => types.indexOf(a) - types.indexOf(b));
}

function stageOf(evidence, p) {
  const ids = new Set(evidence.map((c) => c.id));
  const count = (groups) => evidence.filter((c) => groups.includes(c.group)).length;
  const nonTrigger = evidence.filter((c) => c.group !== 'TRIGGER').length;
  const early = count(['EXHAUSTION', 'BASE', 'VOLUME']) >= p.minEarlyEvidence && count(['EXHAUSTION', 'BASE']) >= 1;
  const developing = early && count(['STRUCTURE']) >= 1 && evidence.length >= p.minDevelopingEvidence;
  const confirmed = ids.has('TRIGGER_BREAK') && (ids.has('BREAK_VOLUME_SUPPORT') || ids.has('BREAK_FOLLOW_THROUGH')) && nonTrigger >= p.minConfirmedEvidence;
  if (confirmed) return 'CONFIRMED_BREAKOUT';
  if (developing) return 'DEVELOPING_REVERSAL';
  if (early) return 'EARLY_FORMATION';
  return null;
}

function orderRisks(set) {
  return RISKS.filter((r) => set.has(r));
}

/**
 * Konteks HTF: tiap HTF (HIGHER_TIMEFRAMES[timeframe]) dinilai dari candle yang sudah tutup pada evaluatedAt.
 * trend gabungan: BEARISH bila ada HTF bearish; BULLISH bila semua HTF yang tersedia bullish; selain itu NEUTRAL;
 * null bila tidak ada HTF (1h) atau data HTF belum cukup.
 */
function htfContext(timeframe, higher, evaluatedAt, p) {
  const tfs = HIGHER_TIMEFRAMES[timeframe];
  const perTf = {};
  if (tfs.length === 0) {
    return { htf: { timeframe: null, trend: null, detail: 'Timeframe 1h tidak memiliki timeframe lebih tinggi di sistem' }, perTf };
  }
  if (higher === null || typeof higher !== 'object' || Array.isArray(higher)) throw new TypeError('higher harus objek { timeframe: Candle[] }');
  const parts = [];
  for (const tf of tfs) {
    const list = higher[tf];
    perTf[tf] = null;
    if (list === undefined || list === null) {
      parts.push(`${tf}: tidak ada data`);
      continue;
    }
    if (!Array.isArray(list)) throw new TypeError(`higher.${tf} harus array`);
    const closed = [];
    for (const c of list) {
      if (c === null || typeof c !== 'object' || !isNum(c.close) || !isNum(c.closeTime)) throw new TypeError(`Candle HTF ${tf} tidak valid`);
      if (c.timeframe !== undefined && c.timeframe !== tf) throw new RangeError(`Candle dengan timeframe ${c.timeframe} ditempatkan di higher.${tf}`);
      if (c.isClosed !== false && evaluatedAt !== null && c.closeTime <= evaluatedAt) closed.push(c);
    }
    const t = F.htfTrend(closed, p);
    perTf[tf] = t;
    parts.push(t
      ? `${tf}: ${TREND_LABEL[t.trend]} (close ${fmtPrice(t.close)} vs EMA25 ${fmtPrice(t.ema25)}, slope EMA25 ${fmtNum(t.slope * 100, 3)} %/candle)`
      : `${tf}: data belum cukup (${closed.length} candle tertutup)`);
  }
  const available = tfs.map((tf) => perTf[tf]).filter(Boolean);
  let trend = null;
  if (available.length > 0) {
    if (available.some((t) => t.trend === 'BEARISH')) trend = 'BEARISH';
    else if (available.every((t) => t.trend === 'BULLISH')) trend = 'BULLISH';
    else trend = 'NEUTRAL';
  }
  return { htf: { timeframe: tfs.join(','), trend, detail: parts.join('; ') }, perTf };
}

function avgQuoteVolumeOf(candles, bars) {
  const slice = candles.slice(-bars);
  return F.meanOf(slice.map((c) => c.quoteVolume));
}

/** Pemeriksaan bukti pada kandidat reversal. Mengembalikan daftar check urut EVIDENCE_IDS. */
function buildChecks(ctx) {
  const { candles, s, p, last, close, atrNow, bottomIndex, bottomPrice, barsSinceBottom, aux, liquidityClass, levels } = ctx;
  const timeAt = (i) => (Number.isInteger(i) && i >= 0 && i <= last ? candles[i].openTime : null);
  const out = [];
  const add = (id, fields) => out.push(check(id, { ...fields, time: timeAt(fields.index) }));
  const atrOr = (v) => (atrNow !== null ? v / atrNow : null);

  // ---- EXHAUSTION ----
  const ll = F.lowerLowChain(s.lows, bottomIndex, atrNow);
  if (ll.depthLast === null) {
    add('LL_SHALLOWER', {
      passed: false, value: null, threshold: p.llShallowerMaxAtr, index: ll.chain.length > 0 ? bottomIndex : null, price: ll.chain.length > 0 ? bottomPrice : null,
      detail: ll.chain.length === 0
        ? `Dasar ${fmtPrice(bottomPrice)} belum menjadi swing low terkonfirmasi (butuh 2 candle sesudahnya)`
        : `Baru ${ll.chain.length} swing low dalam rantai lower low yang berakhir di dasar (butuh ≥ 3)`,
    });
  } else {
    const threshold = Math.max(p.llShallowerRatio * ll.depthPrev, p.llShallowerMaxAtr);
    const passed = ll.depthLast <= threshold;
    add('LL_SHALLOWER', {
      passed, value: ll.depthLast, threshold, index: bottomIndex, price: bottomPrice,
      detail: passed
        ? `Lower low terakhir hanya ${fmtAtr(ll.depthLast)} di bawah sebelumnya (sebelumnya ${fmtAtr(ll.depthPrev)})`
        : `Lower low terakhir ${fmtAtr(ll.depthLast)} di bawah sebelumnya (sebelumnya ${fmtAtr(ll.depthPrev)}) — belum lebih dangkal (batas ${fmtAtr(threshold)})`,
    });
  }

  {
    const aged = barsSinceBottom >= p.llStoppedBars;
    const above = close > bottomPrice;
    add('LL_STOPPED', {
      passed: aged && above, value: barsSinceBottom, threshold: p.llStoppedBars, index: bottomIndex, price: bottomPrice,
      detail: aged && above
        ? `Tidak ada low baru di bawah dasar ${fmtPrice(bottomPrice)} selama ${barsSinceBottom} candle; close ${fmtPrice(close)} di atasnya`
        : !aged
          ? `Dasar ${fmtPrice(bottomPrice)} baru berumur ${barsSinceBottom} candle (butuh ≥ ${p.llStoppedBars})`
          : `Close ${fmtPrice(close)} belum di atas dasar ${fmtPrice(bottomPrice)}`,
    });
  }

  {
    const rt = F.findBottomRetest(candles, bottomIndex, last, atrNow, p);
    const holdLevel = atrNow !== null ? bottomPrice + p.bottomHeldCloseAtr * atrNow : null;
    const retestLevel = atrNow !== null ? bottomPrice + p.bottomHeldRetestAtr * atrNow : null;
    const passed = rt.retestIndex !== null && holdLevel !== null && close >= holdLevel;
    const value = rt.retestLow !== null ? atrOr(rt.retestLow - bottomPrice) : null;
    let detail;
    if (passed) {
      detail = `Retest dasar ${last - rt.retestIndex} candle lalu (low ${fmtPrice(rt.retestLow)}, ${fmtAtr(value)} di atas dasar ${fmtPrice(bottomPrice)}) dan close ${fmtPrice(close)} bertahan ≥ ${fmtPrice(holdLevel)}`;
    } else if (atrNow === null) {
      detail = 'ATR tidak tersedia';
    } else if (rt.departIndex === null) {
      detail = `Close belum pernah menjauh ≥ ${fmtAtr(p.bottomHeldDepartAtr)} dari dasar ${fmtPrice(bottomPrice)} sebelum retest`;
    } else if (rt.retestIndex === null) {
      detail = `Belum ada retest ke ≤ ${fmtPrice(retestLevel)} setelah menjauh dari dasar ${fmtPrice(bottomPrice)}`;
    } else {
      detail = `Retest ada (low ${fmtPrice(rt.retestLow)}), tetapi close ${fmtPrice(close)} belum ≥ ${fmtPrice(holdLevel)}`;
    }
    add('BOTTOM_HELD', { passed, value, threshold: p.bottomHeldRetestAtr, index: rt.retestIndex, price: rt.retestLow, detail });
  }

  {
    const m = F.downMomentum(candles, last, p.momentumFadeBars);
    const bodyOk = m.bodyRatio !== null && m.bodyRatio <= p.momentumFadeRatio;
    const shareOk = m.redVolumeShare !== null && m.redVolumeShare <= p.momentumFadeRedVolumeShare;
    const passed = bodyOk && shareOk;
    let detail;
    if (passed) {
      detail = `Rata-rata body candle merah ${p.momentumFadeBars} candle terakhir ${fmtNum(m.bodyRatio * 100, 0)} % dari ${p.momentumFadeBars} candle sebelumnya; porsi volume candle merah ${fmtPct(m.redVolumeShare)}`;
    } else if (m.bodyRatio === null) {
      detail = m.prevBody === null ? `Tidak ada candle merah pada ${p.momentumFadeBars} candle pembanding — belum bisa dinilai` : 'Data tidak cukup';
    } else if (!bodyOk) {
      detail = `Rata-rata body candle merah masih ${fmtNum(m.bodyRatio * 100, 0)} % dari ${p.momentumFadeBars} candle sebelumnya (butuh ≤ ${fmtNum(p.momentumFadeRatio * 100, 0)} %)`;
    } else {
      detail = `Body merah menyusut, tetapi porsi volume candle merah ${fmtPct(m.redVolumeShare)} > ${fmtPct(p.momentumFadeRedVolumeShare)}`;
    }
    add('DOWN_MOMENTUM_FADING', { passed, value: m.bodyRatio, threshold: p.momentumFadeRatio, index: last, price: null, detail });
  }

  {
    const d = F.rsiDivergenceAtBottom(s.lows, s.rsi, bottomIndex);
    const passed = d.priceLowerLow === true && d.rsiDiff !== null && d.rsiDiff >= p.rsiDivergenceMinDiff;
    let detail;
    if (d.bottom === null) {
      detail = `Dasar ${fmtPrice(bottomPrice)} belum menjadi swing low terkonfirmasi dengan swing low pembanding`;
    } else {
      const r0 = s.rsi[d.prev.index];
      const r1 = s.rsi[d.bottom.index];
      if (passed) {
        detail = `Harga lower low ${fmtPrice(d.bottom.price)} < ${fmtPrice(d.prev.price)} tetapi RSI14 ${fmtNum(r1, 1)} > ${fmtNum(r0, 1)} (+${fmtNum(d.rsiDiff, 1)} poin)`;
      } else if (!d.priceLowerLow) {
        detail = `Swing low di dasar ${fmtPrice(d.bottom.price)} bukan lower low terhadap ${fmtPrice(d.prev.price)}`;
      } else if (d.rsiDiff === null) {
        detail = 'RSI14 belum terhitung pada salah satu swing low';
      } else {
        detail = `RSI14 di dasar ${fmtNum(r1, 1)} vs ${fmtNum(r0, 1)} pada swing low sebelumnya (selisih ${fmtNum(d.rsiDiff, 1)} poin, butuh ≥ ${fmtNum(p.rsiDivergenceMinDiff, 0)})`;
      }
    }
    add('RSI_DIVERGENCE', { passed, value: d.rsiDiff, threshold: p.rsiDivergenceMinDiff, index: d.bottom ? bottomIndex : null, price: d.bottom ? bottomPrice : null, detail });
  }

  {
    const flow = aux.flow;
    const slope = flow.cvdSlope ?? flow.obvSlope;
    const passed = flow.divergence === 'BULLISH';
    add('CVD_DIVERGENCE', {
      passed, value: slope, threshold: ORDER_FLOW_THRESHOLDS.DIVERGENCE_MIN_FLOW_SLOPE, index: last, price: null,
      detail: passed
        ? `Harga di area low tetapi aliran ${flow.cvdSlope !== null ? 'taker (CVD)' : 'OBV'} naik (slope ${fmtNum(slope, 2)}) dalam ${p.cvdDivergenceLookback} candle`
        : `Tidak ada divergensi bullish CVD/OBV dalam ${p.cvdDivergenceLookback} candle (slope aliran ${fmtNum(slope, 2)})`,
    });
  }

  // ---- BASE ----
  {
    const ratio = F.atrContractionRatio(s.atr, last, p.atrContractionLookback);
    const before = last - p.atrContractionLookback >= 0 ? s.atr[last - p.atrContractionLookback] : null;
    const passed = ratio !== null && ratio <= p.atrContractionRatio;
    add('ATR_CONTRACTION', {
      passed, value: ratio, threshold: p.atrContractionRatio, index: last, price: null,
      detail: ratio === null
        ? 'ATR pembanding belum tersedia'
        : `ATR14 ${fmtPrice(atrNow)} = ${fmtNum(ratio * 100, 0)} % dari ATR ${p.atrContractionLookback} candle lalu (${fmtPrice(before)})${passed ? '' : ` — butuh ≤ ${fmtNum(p.atrContractionRatio * 100, 0)} %`}`,
    });
  }

  {
    const dNow = F.emaDistanceAtr(s, last);
    const dPrev = F.emaDistanceAtr(s, last - p.emaConvergenceLookback);
    const passed = dNow !== null && dPrev !== null && dNow <= p.emaConvergenceMaxAtr && dNow < dPrev;
    let detail;
    if (dNow === null || dPrev === null) detail = 'EMA/ATR belum tersedia untuk pembanding';
    else if (passed) detail = `|EMA7 − EMA25| = ${fmtAtr(dNow)}, lebih rapat dari ${p.emaConvergenceLookback} candle lalu (${fmtAtr(dPrev)})`;
    else if (dNow > p.emaConvergenceMaxAtr) detail = `|EMA7 − EMA25| = ${fmtAtr(dNow)} masih > ${fmtAtr(p.emaConvergenceMaxAtr)}`;
    else detail = `|EMA7 − EMA25| = ${fmtAtr(dNow)} tidak lebih rapat dari ${p.emaConvergenceLookback} candle lalu (${fmtAtr(dPrev)})`;
    add('EMA_CONVERGENCE', { passed, value: dNow, threshold: p.emaConvergenceMaxAtr, index: last, price: null, detail });
  }

  {
    const rc = F.rangeContraction(candles, last, p.rangeContractionLookback);
    const squeeze = aux.regime.squeeze === true;
    const narrowed = rc.ratio !== null && rc.ratio <= p.rangeContractionRatio;
    const passed = narrowed || squeeze;
    const base = rc.ratio === null
      ? 'Range pembanding belum tersedia'
      : `Range ${p.rangeContractionLookback} candle terakhir ${fmtNum(rc.ratio * 100, 0)} % dari ${p.rangeContractionLookback} candle sebelumnya`;
    add('RANGE_CONTRACTION', {
      passed, value: rc.ratio, threshold: p.rangeContractionRatio, index: last, price: null,
      detail: passed
        ? `${base}${squeeze ? '; bandwidth Bollinger di 20 % terbawah riwayatnya (squeeze)' : ''}`
        : `${base} (butuh ≤ ${fmtNum(p.rangeContractionRatio * 100, 0)} %), tanpa squeeze Bollinger`,
    });
  }

  {
    const fit = F.roundedBottomFit(s.closes, last, p.bowlWindow);
    let passed = false;
    let detail;
    let index = null;
    let price = null;
    if (fit === null) {
      detail = `Fit kuadrat ${p.bowlWindow} candle tidak tersedia`;
    } else {
      index = fit.vertexIndex;
      price = fit.vertexValue;
      const concave = fit.a > 0;
      const fitOk = fit.r2 >= p.bowlMinR2;
      const vertexOk = fit.vertexPos !== null && fit.vertexPos >= p.bowlVertexMin && fit.vertexPos <= p.bowlVertexMax;
      const riseAtr = fit.vertexValue !== null ? atrOr(close - fit.vertexValue) : null;
      const riseOk = riseAtr !== null && riseAtr >= p.bowlRiseAtr;
      passed = concave && fitOk && vertexOk && riseOk;
      if (passed) {
        detail = `Kurva kuadrat ${p.bowlWindow} candle cekung ke atas (R² ${fmtNum(fit.r2, 2)}), titik terendah kurva pada ${fmtNum(fit.vertexPos * 100, 0)} % jendela; close ${fmtPrice(close)} sudah ${fmtAtr(riseAtr)} di atas dasar kurva ${fmtPrice(fit.vertexValue)}`;
      } else if (!concave) {
        detail = `Kurva kuadrat ${p.bowlWindow} candle tidak cekung ke atas (a ${fit.a < 0 ? '< 0' : '= 0'})`;
      } else if (!fitOk) {
        detail = `Kurva cekung ke atas tetapi R² ${fmtNum(fit.r2, 2)} < ${fmtNum(p.bowlMinR2, 2)}`;
      } else if (!vertexOk) {
        detail = `Titik terendah kurva pada ${fmtNum(fit.vertexPos * 100, 0)} % jendela (butuh ${fmtNum(p.bowlVertexMin * 100, 0)}–${fmtNum(p.bowlVertexMax * 100, 0)} %)`;
      } else {
        detail = `Close ${fmtPrice(close)} baru ${fmtAtr(riseAtr)} di atas dasar kurva ${fmtPrice(fit.vertexValue)} (butuh ≥ ${fmtAtr(p.bowlRiseAtr)})`;
      }
    }
    add('ROUNDED_BOTTOM', { passed, value: fit ? fit.r2 : null, threshold: p.bowlMinR2, index, price, detail });
  }

  {
    const rf = F.risingFloor(candles, s.lows, last, p.risingFloorLookback, atrNow);
    const rangeOk = rf.rangeAtr !== null && rf.rangeAtr <= p.risingFloorMaxRangeAtr;
    const enough = rf.swingCount >= p.risingFloorMinSwings;
    const slopeOk = rf.slopeAtr !== null && rf.slopeAtr > p.risingFloorMinSlopeAtr;
    const passed = rangeOk && enough && slopeOk;
    let detail;
    if (passed) detail = `Range ${p.risingFloorLookback} candle ${fmtAtr(rf.rangeAtr)} (≤ ${fmtAtr(p.risingFloorMaxRangeAtr)}) dan ${rf.swingCount} swing low naik ${fmtNum(rf.slopeAtr, 2)} ATR/candle`;
    else if (rf.rangeAtr === null) detail = 'ATR tidak tersedia';
    else if (!rangeOk) detail = `Range ${p.risingFloorLookback} candle ${fmtAtr(rf.rangeAtr)} > ${fmtAtr(p.risingFloorMaxRangeAtr)} — bukan sideways`;
    else if (!enough) detail = `Baru ${rf.swingCount} swing low terkonfirmasi dalam ${p.risingFloorLookback} candle (butuh ≥ ${p.risingFloorMinSwings})`;
    else detail = `Regresi ${rf.swingCount} swing low ${fmtNum(rf.slopeAtr, 2)} ATR/candle (butuh > ${fmtNum(p.risingFloorMinSlopeAtr, 2)})`;
    add('RISING_FLOOR', { passed, value: rf.slopeAtr, threshold: p.risingFloorMinSlopeAtr, index: rf.lastSwing ? rf.lastSwing.index : null, price: rf.lastSwing ? rf.lastSwing.price : null, detail });
  }

  // ---- STRUCTURE ----
  {
    const hl = ctx.higherLow;
    const after = s.lows.filter((x) => x.index > bottomIndex);
    const value = hl ? atrOr(hl.swing.price - bottomPrice) : null;
    let detail;
    if (hl) {
      detail = `Higher low ${fmtPrice(hl.swing.price)} terkonfirmasi ${last - hl.swing.index} candle lalu, ${fmtAtr(value)} di atas dasar ${fmtPrice(bottomPrice)}, belum ditembus; close ${fmtPrice(close)} di atasnya${hl.chain > 1 ? ` (${hl.chain} higher low berurutan)` : ''}`;
    } else if (after.length === 0) {
      detail = `Belum ada swing low terkonfirmasi sesudah dasar ${fmtPrice(bottomPrice)}`;
    } else {
      detail = `Swing low sesudah dasar belum membentuk higher low yang utuh (terakhir ${fmtPrice(after[after.length - 1].price)})`;
    }
    add('HIGHER_LOW', { passed: hl !== null, value, threshold: 0, index: hl ? hl.swing.index : (after.at(-1)?.index ?? null), price: hl ? hl.swing.price : (after.at(-1)?.price ?? null), detail });
  }

  {
    const sp = F.findSpring(candles, s.lows, s.rvol, last, p.springBars);
    const volumeOk = sp !== null && sp.rvol !== null && sp.rvol <= p.springMaxRvol;
    const passed = sp !== null && sp.reclaimed && volumeOk;
    let detail;
    if (sp === null) detail = `Tidak ada sapuan swing low dalam ${p.springBars} candle terakhir`;
    else if (passed) detail = `Wick ${last - sp.index} candle lalu menembus swing low ${fmtPrice(sp.level)} (low ${fmtPrice(candles[sp.index].low)}) dengan RVOL ${fmtNum(sp.rvol, 2)}; close ${fmtPrice(close)} kembali di atasnya`;
    else if (!sp.reclaimed) detail = `Sapuan swing low ${fmtPrice(sp.level)} belum di-reclaim (close ${fmtPrice(close)})`;
    else detail = `Sapuan ${fmtPrice(sp.level)} di-reclaim, tetapi RVOL candle sapuan ${sp.rvol === null ? 'tidak tersedia' : `${fmtNum(sp.rvol, 2)} > ${fmtNum(p.springMaxRvol, 1)}`}`;
    add('SPRING_RECLAIM', { passed, value: sp ? sp.rvol : null, threshold: p.springMaxRvol, index: sp ? sp.index : null, price: sp ? sp.level : null, detail });
  }

  {
    const e = s.emaSlow[last];
    const below = F.lastCloseAtOrBelowEma(s, last, p.ema25ReclaimLookback);
    const above = isNum(e) && close > e;
    const passed = above && below !== null;
    const value = isNum(e) ? atrOr(close - e) : null;
    let detail;
    if (!isNum(e)) detail = 'EMA25 belum tersedia';
    else if (passed) detail = `Close ${fmtPrice(close)} di atas EMA25 ${fmtPrice(e)} setelah close ≤ EMA25 ${last - below} candle lalu`;
    else if (!above) detail = `Close ${fmtPrice(close)} masih ≤ EMA25 ${fmtPrice(e)}`;
    else detail = `Close sudah di atas EMA25 ${fmtPrice(e)} lebih dari ${p.ema25ReclaimLookback} candle — bukan reclaim baru`;
    add('EMA25_RECLAIM', { passed, value, threshold: 0, index: last, price: isNum(e) ? e : null, detail });
  }

  {
    const slope = s.emaFastSlope[last];
    const e7 = s.emaFast[last];
    const e25 = s.emaSlow[last];
    const gap = isNum(e7) && isNum(e25) ? atrOr(e7 - e25) : null;
    const slopeOk = isNum(slope) && slope > 0;
    const gapOk = gap !== null && gap >= -p.ema7TurnMaxBelowAtr;
    const passed = slopeOk && gapOk;
    let detail;
    if (!isNum(slope) || gap === null) detail = 'Slope EMA7 / jarak EMA belum tersedia';
    else if (passed) detail = `Slope EMA7 ${fmtNum(slope * 100, 3)} %/candle > 0 dan EMA7 ${fmtPrice(e7)} berada ${fmtAtr(gap)} dari EMA25 ${fmtPrice(e25)}`;
    else if (!slopeOk) detail = `Slope EMA7 ${fmtNum(slope * 100, 3)} %/candle belum positif`;
    else detail = `EMA7 masih ${fmtAtr(-gap)} di bawah EMA25 (batas ${fmtAtr(p.ema7TurnMaxBelowAtr)})`;
    add('EMA7_TURN_UP', { passed, value: isNum(slope) ? slope : null, threshold: 0, index: last, price: isNum(e7) ? e7 : null, detail });
  }

  {
    const ev = aux.structure.lastEvent;
    const choch = ev !== null && ev.type === 'CHOCH' && ev.direction === 'BULLISH' && ev.barsAgo <= p.chochMaxBarsAgo;
    const lh = F.lowerHighSinceBottom(s.highs, bottomIndex, close);
    const lhBroken = lh !== null && lh.broken;
    const passed = choch || lhBroken;
    let detail;
    let index = last;
    let price = lh ? lh.swing.price : null;
    let value = null;
    if (choch) {
      index = ev.index;
      price = ev.level;
      value = ev.barsAgo;
      detail = `CHoCH bullish: close menembus swing high ${fmtPrice(ev.level)} ${ev.barsAgo === 0 ? 'pada candle ini' : `${ev.barsAgo} candle lalu`}`;
    } else if (lhBroken) {
      value = 0;
      detail = `Close ${fmtPrice(close)} menembus lower high terkonfirmasi terakhir ${fmtPrice(lh.swing.price)} sejak dasar`;
    } else {
      detail = `Belum ada CHoCH bullish dalam ${p.chochMaxBarsAgo} candle${lh ? ` dan lower high ${fmtPrice(lh.swing.price)} belum ditembus (close ${fmtPrice(close)})` : ' dan belum ada lower high terkonfirmasi sejak dasar'}`;
    }
    ctx.chochIndex = passed ? index : null;
    add('CHOCH_BULLISH', { passed, value, threshold: p.chochMaxBarsAgo, index, price, detail });
  }

  {
    const st = F.staircaseSinceBottom(s.highs, s.lows, bottomIndex, atrNow);
    const steps = Math.min(st.higherLows, st.higherHighs);
    const stepOk = st.maxStepAtr !== null && st.maxStepAtr <= p.staircaseMaxStepAtr;
    const passed = st.higherLows >= p.staircaseMinSteps && st.higherHighs >= p.staircaseMinSteps && stepOk;
    let detail;
    if (passed) detail = `${st.higherLows} higher low & ${st.higherHighs} higher high berurutan sejak dasar, langkah terbesar ${fmtAtr(st.maxStepAtr)}`;
    else if (steps < p.staircaseMinSteps) detail = `Baru ${st.higherLows} higher low & ${st.higherHighs} higher high berurutan sejak dasar (butuh ≥ ${p.staircaseMinSteps} masing-masing)`;
    else detail = `Tangga terbentuk tetapi langkah terbesar ${fmtAtr(st.maxStepAtr)} > ${fmtAtr(p.staircaseMaxStepAtr)}`;
    add('STAIRCASE', { passed, value: steps, threshold: p.staircaseMinSteps, index: st.lastLow ? st.lastLow.index : null, price: st.lastLow ? st.lastLow.price : null, detail });
  }

  // ---- VOLUME ----
  {
    const v = F.volumeDryUp(s.volumes, last, p.volumeDryUpRecent, p.volumeDryUpBaseline);
    const illiquid = liquidityClass === 'ILLIQUID';
    const passed = !illiquid && v.ratio !== null && v.ratio <= p.volumeDryUpRatio;
    let detail;
    if (v.ratio === null) detail = 'Volume pembanding belum tersedia';
    else if (illiquid) detail = `Rata-rata volume ${p.volumeDryUpRecent} candle terakhir ${fmtNum(v.ratio * 100, 0)} % dari sebelumnya, tetapi volume rendah tidak dihitung sebagai bukti pada pasangan ILLIQUID`;
    else if (passed) detail = `Rata-rata volume ${p.volumeDryUpRecent} candle terakhir ${fmtNum(v.ratio * 100, 0)} % dari ${p.volumeDryUpBaseline} candle sebelumnya (supply mengering)`;
    else detail = `Rata-rata volume ${p.volumeDryUpRecent} candle terakhir ${fmtNum(v.ratio * 100, 0)} % dari ${p.volumeDryUpBaseline} candle sebelumnya (butuh ≤ ${fmtNum(p.volumeDryUpRatio * 100, 0)} %)`;
    add('VOLUME_DRY_UP', { passed, value: v.ratio, threshold: p.volumeDryUpRatio, index: last, price: null, detail });
  }

  {
    const q = F.quietRise(s, last, p.quietRiseLookback, atrNow);
    const riseOk = q.riseAtr !== null && q.riseAtr > 0 && q.riseAtr <= p.quietRiseMaxAtr;
    const rvolOk = q.avgRvol !== null && q.avgRvol <= p.quietRiseMaxRvol;
    const passed = riseOk && rvolOk;
    const base = last - p.quietRiseLookback >= 0 ? s.closes[last - p.quietRiseLookback] : null;
    let detail;
    if (q.riseAtr === null) detail = 'Kenaikan belum terhitung (ATR/data)';
    else if (passed) detail = `Close naik ${fmtAtr(q.riseAtr)} (${fmtPct(base > 0 ? q.rise / base : null)}) dalam ${p.quietRiseLookback} candle dengan rata-rata RVOL ${fmtNum(q.avgRvol, 2)}`;
    else if (q.riseAtr <= 0) detail = `Close belum naik dalam ${p.quietRiseLookback} candle (${fmtAtr(q.riseAtr)})`;
    else if (!riseOk) detail = `Kenaikan ${fmtAtr(q.riseAtr)} dalam ${p.quietRiseLookback} candle terlalu besar (> ${fmtAtr(p.quietRiseMaxAtr)})`;
    else detail = `Naik ${fmtAtr(q.riseAtr)}, tetapi rata-rata RVOL ${q.avgRvol === null ? 'tidak tersedia' : `${fmtNum(q.avgRvol, 2)} > ${fmtNum(p.quietRiseMaxRvol, 1)}`}`;
    add('QUIET_RISE', { passed, value: q.riseAtr, threshold: p.quietRiseMaxAtr, index: last, price: null, detail });
  }

  // ---- TRIGGER ----
  const trigger = levels.trigger;
  const breakAtr = trigger !== null ? atrOr(close - trigger) : null;
  const triggerBreak = trigger !== null && close > trigger;
  add('TRIGGER_BREAK', {
    passed: triggerBreak, value: breakAtr, threshold: 0, index: last, price: trigger,
    detail: trigger === null
      ? 'Level pemicu belum tersedia (belum ada candle sesudah dasar)'
      : triggerBreak
        ? `Close ${fmtPrice(close)} di atas level pemicu ${fmtPrice(trigger)} (+${fmtAtr(breakAtr)})`
        : `Close ${fmtPrice(close)} masih ${fmtAtr(breakAtr === null ? null : -breakAtr)} di bawah level pemicu ${fmtPrice(trigger)}`,
  });

  {
    const rv = s.rvol[last];
    const passed = triggerBreak && isNum(rv) && rv >= p.breakRvol;
    add('BREAK_VOLUME_SUPPORT', {
      passed, value: isNum(rv) ? rv : null, threshold: p.breakRvol, index: last, price: trigger,
      detail: !triggerBreak
        ? `Belum ada penembusan level pemicu (RVOL candle ${fmtNum(rv, 2)})`
        : passed
          ? `RVOL candle breakout ${fmtNum(rv, 2)} ≥ ${fmtNum(p.breakRvol, 1)}`
          : `RVOL candle breakout ${isNum(rv) ? fmtNum(rv, 2) : 'tidak tersedia'} < ${fmtNum(p.breakRvol, 1)}`,
    });
  }

  {
    const prevTrig = last >= 1 ? F.triggerLevelAt(candles, s.highs, bottomIndex, last - 1) : null;
    const prevClose = last >= 1 ? s.closes[last - 1] : null;
    const twoCloses = triggerBreak && prevTrig !== null && prevClose !== null && prevClose > prevTrig.level;
    const strong = triggerBreak && breakAtr !== null && breakAtr >= p.followThroughAtr;
    const passed = twoCloses || strong;
    let detail;
    if (!triggerBreak) detail = 'Belum ada penembusan level pemicu';
    else if (twoCloses) detail = `Dua close tutup berurutan di atas level pemicu (${fmtPrice(prevClose)} > ${fmtPrice(prevTrig.level)}, lalu ${fmtPrice(close)} > ${fmtPrice(trigger)})`;
    else if (strong) detail = `Close ${fmtPrice(close)} sudah ${fmtAtr(breakAtr)} di atas level pemicu ${fmtPrice(trigger)} (≥ ${fmtAtr(p.followThroughAtr)})`;
    else detail = `Penembusan baru ${fmtAtr(breakAtr)} di atas pemicu dan candle sebelumnya belum di atas pemicu — butuh dua close berurutan atau ≥ ${fmtAtr(p.followThroughAtr)}`;
    add('BREAK_FOLLOW_THROUGH', { passed, value: breakAtr, threshold: p.followThroughAtr, index: last, price: trigger, detail });
  }

  return EVIDENCE_IDS.map((id) => out.find((c) => c.id === id));
}

export function nextConfirmationOf(stage, levels, ids, close, p) {
  if (stage === 'EARLY_FORMATION') {
    if (!ids.has('HIGHER_LOW')) {
      const ref = levels.lastSwingLow ?? levels.bottom;
      return { kind: 'HIGHER_LOW', text: `Higher low terkonfirmasi di atas ${fmtPrice(ref)}`, level: ref };
    }
    return { kind: 'EMA25_RECLAIM', text: `Close di atas EMA25 ${fmtPrice(levels.ema25)}`, level: levels.ema25 };
  }
  if (stage === 'DEVELOPING_REVERSAL') {
    if (levels.trigger === null) return { kind: 'TRIGGER_BREAK', text: 'Close di atas level pemicu (belum terbentuk) dengan RVOL ≥ 1,5 atau dua close berurutan', level: null };
    return { kind: 'TRIGGER_BREAK', text: `Close di atas level pemicu ${fmtPrice(levels.trigger)} dengan RVOL ≥ ${fmtNum(p.breakRvol, 1)} atau dua close berurutan`, level: levels.trigger };
  }
  if (stage === 'CONFIRMED_BREAKOUT') {
    return { kind: 'HOLD_ABOVE_TRIGGER', text: `Bertahan di atas ${fmtPrice(levels.trigger)} saat retest`, level: levels.trigger };
  }
  return { kind: 'NONE', text: isNum(close) ? 'Belum ada tahap: bukti belum cukup' : 'Tidak ada tahap', level: null };
}

/** Teks kondisi batal dari level invalidasi (dipakai juga state machine). */
export function cancelConditionOf(invalidation, { breakoutFloor = false, p } = {}) {
  if (!isNum(invalidation)) return { text: 'Level invalidasi tidak tersedia', level: null };
  const buffer = p ? fmtNum(p.invalidationBufferAtr, 2) : '0,25';
  const failed = p ? fmtNum(p.failedBreakAtr, 2) : '0,75';
  return {
    text: breakoutFloor
      ? `Close candle tutup di bawah ${fmtPrice(invalidation)} (${failed} ATR di bawah level pemicu — breakout gagal)`
      : `Close candle tutup di bawah ${fmtPrice(invalidation)} (${buffer} ATR di bawah min(dasar, swing low terakhir))`,
    level: invalidation,
  };
}

function buildMarkers(ctx, checks) {
  const { candles, s, bottomIndex, bottomPrice, last, levels } = ctx;
  const byId = new Map(checks.map((c) => [c.id, c]));
  const markers = [];
  const push = (index, kind, price, label) => markers.push({ time: candles[index].openTime, kind, price: orNull(price), label });
  const ll = F.lowerLowChain(s.lows, bottomIndex, ctx.atrNow);
  for (const sw of ll.chain) if (sw.index !== bottomIndex) push(sw.index, 'LOWER_LOW', sw.price, `Lower low ${fmtPrice(sw.price)}`);
  push(bottomIndex, 'BOTTOM', bottomPrice, `Dasar ${fmtPrice(bottomPrice)}`);
  const after = s.lows.filter((x) => x.index > bottomIndex);
  after.forEach((sw, k) => {
    const prev = k > 0 ? after[k - 1].price : bottomPrice;
    if (sw.price > prev) push(sw.index, 'HIGHER_LOW', sw.price, `Higher low ${fmtPrice(sw.price)}`);
    else push(sw.index, 'LOWER_LOW', sw.price, `Lower low ${fmtPrice(sw.price)}`);
  });
  const spring = byId.get('SPRING_RECLAIM');
  if (spring.passed && spring.index !== null) push(spring.index, 'SPRING', spring.price, `Spring: sapuan ${fmtPrice(spring.price)}`);
  const choch = byId.get('CHOCH_BULLISH');
  if (choch.passed && choch.index !== null) push(choch.index, 'CHOCH', choch.price, `CHoCH bullish ${fmtPrice(choch.price)}`);
  const div = byId.get('RSI_DIVERGENCE');
  if (div.passed) push(bottomIndex, 'DIVERGENCE', bottomPrice, `Divergensi RSI (+${fmtNum(div.value, 1)} poin)`);
  if (levels.trigger !== null) push(last, 'TRIGGER', levels.trigger, `Pemicu ${fmtPrice(levels.trigger)}`);
  return markers.sort((a, b) => a.time - b.time);
}

function finish(base, fields) {
  const checks = fields.checks;
  const evidence = checks.filter((c) => c.passed);
  const score = scoreOf(checks);
  return {
    ...base,
    classification: fields.classification,
    stage: fields.stage ?? null,
    setupType: fields.setupTypes?.[0] ?? null,
    setupTypes: fields.setupTypes ?? [],
    context: fields.context,
    checks,
    evidence,
    evidenceCount: evidence.length,
    score,
    levels: fields.levels,
    nextConfirmation: fields.nextConfirmation,
    cancelCondition: fields.cancelCondition,
    risks: orderRisks(fields.risks),
    markers: fields.markers ?? [],
    measures: fields.measures,
  };
}

/**
 * Evaluasi Reversal Radar pada candle terakhir `candles`.
 * @param {{ candles: object[], timeframe: '5m'|'15m'|'1h', higher?: Record<string, object[]>,
 *   liquidity?: { quoteVolume24h?: number|null, spreadBps?: number|null, thresholds?: object }|null,
 *   provisional?: boolean, params?: object }} input
 * @returns {object} ReversalEvaluation (docs/19 §3)
 * @throws {TypeError} input/candles/higher/liquidity bertipe salah, parameter tak dikenal
 * @throws {RangeError} timeframe tak dikenal, candles kosong, timeframe candle ≠ timeframe, candle terakhir belum
 *   tutup tanpa provisional, parameter di luar rentang
 */
export function evaluateReversal(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('input evaluateReversal harus objek');
  const { candles, timeframe, higher = {}, liquidity, provisional = false, params } = input;
  if (!REVERSAL_TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe reversal tidak dikenal: ${String(timeframe)}`);
  if (typeof provisional !== 'boolean') throw new TypeError('provisional harus boolean');
  const p = resolveReversalParams(params ?? {}, timeframe);
  if (!Array.isArray(candles)) throw new TypeError('candles harus berupa array');
  if (candles.length === 0) throw new RangeError('candles kosong');
  if (liquidity !== undefined && liquidity !== null && (typeof liquidity !== 'object' || Array.isArray(liquidity))) throw new TypeError('liquidity harus objek');

  const last = candles.length - 1;
  const lastCandle = candles[last];
  const lastIsObject = lastCandle !== null && typeof lastCandle === 'object';
  if (!provisional && !(lastIsObject && lastCandle.isClosed === true)) {
    throw new RangeError('Candle terakhir belum tutup; evaluasi non-provisional hanya menerima candle tertutup');
  }
  const running = provisional && lastIsObject && lastCandle.isClosed !== true;
  const inspected = running ? [...candles.slice(0, last), { ...lastCandle, isClosed: true }] : candles;
  const minCandles = requiredCandles(p);
  const { fatal, issues } = inspectCandles(inspected, minCandles);
  if (fatal.length === 0 && candles[0].timeframe !== timeframe) {
    throw new RangeError(`Timeframe candle ${candles[0].timeframe} tidak sama dengan timeframe evaluasi ${timeframe}`);
  }

  const candleOpenTime = lastIsObject && Number.isInteger(lastCandle.openTime) ? lastCandle.openTime : null;
  const evaluatedAt = lastIsObject && Number.isInteger(lastCandle.closeTime) ? lastCandle.closeTime : null;
  const base = { version: REVERSAL_VERSION, timeframe, provisional, candleOpenTime, evaluatedAt };
  const { htf, perTf } = htfContext(timeframe, higher, evaluatedAt, p);
  const htfMeasures = {};
  for (const tf of HIGHER_TIMEFRAMES[timeframe]) htfMeasures[`htfTrend${tf}`] = perTf[tf] ? TREND_SIGN[perTf[tf].trend] : null;
  const risks = new Set();
  if (provisional) risks.add('PROVISIONAL');
  if (htf.trend === 'BEARISH') risks.add('HTF_DOWNTREND');
  if (htf.trend === null) risks.add('HTF_UNKNOWN');

  const degenerate = (classification, reason, liquidityClass) => {
    if (classification === 'DATA_QUALITY') risks.add('DATA_QUALITY');
    if (liquidityClass === 'THIN') risks.add('LOW_LIQUIDITY');
    if (liquidityClass === 'ILLIQUID') risks.add('ILLIQUID');
    return finish(base, {
      classification,
      stage: null,
      setupTypes: [],
      context: { priorDecline: emptyPriorDecline(), htf, liquidityClass },
      checks: notEvaluatedChecks(reason),
      levels: emptyLevels(),
      nextConfirmation: { kind: 'NONE', text: reason, level: null },
      cancelCondition: cancelConditionOf(null),
      risks,
      markers: [],
      measures: { close: lastIsObject ? orNull(lastCandle.close) : null, candles: candles.length, requiredCandles: minCandles, ...htfMeasures },
    });
  };

  if (fatal.length > 0) {
    return degenerate('DATA_QUALITY', `data tidak valid (${fatal.join(', ')})`, liquidity ? F.liquidityClassOf(liquidity, null, timeframe, p) : 'UNKNOWN');
  }
  const avgQuoteVolume = avgQuoteVolumeOf(candles, p.avgQuoteVolumeBars);
  const liquidityClass = F.liquidityClassOf(liquidity, avgQuoteVolume, timeframe, p);
  if (candles.length < minCandles) {
    return degenerate('INSUFFICIENT_DATA', `candle ${candles.length} < warm-up ${minCandles}`, liquidityClass);
  }
  if (issues.length > 0) {
    return degenerate('DATA_QUALITY', `kualitas data (${issues.join(', ')})`, liquidityClass);
  }

  // ---- Fitur ----
  const s = F.computeReversalSeries(candles, p);
  const close = s.closes[last];
  const atrNow = positive(s.atr[last]);
  const bottomIndex = F.findBottomIndex(candles, last, p.bottomLookback);
  const priorDecline = F.analyzePriorDecline(candles, s, bottomIndex, p);
  const { bottomPrice, barsSinceBottom } = priorDecline;
  const ema25 = orNull(s.emaSlow[last]);
  const ema7 = orNull(s.emaFast[last]);
  const ema25Slope = orNull(s.emaSlowSlope[last]);
  const atrMedian = F.medianOf(s.atr.slice(Math.max(0, last - p.volatilityBaseline + 1), last + 1).filter(isNum));
  const atrExpansion = atrNow !== null && atrMedian !== null && atrMedian > 0 ? atrNow / atrMedian : null;
  if (atrExpansion !== null && atrExpansion >= p.volatilityExpandingRatio) risks.add('VOLATILITY_EXPANDING');
  if (liquidityClass === 'THIN') risks.add('LOW_LIQUIDITY');
  if (liquidityClass === 'ILLIQUID') risks.add('ILLIQUID');

  const lastSwingLow = s.lows.length > 0 ? s.lows[s.lows.length - 1].price : null;
  const trig = F.triggerLevelAt(candles, s.highs, bottomIndex, last);
  const levels = { bottom: bottomPrice, lastSwingLow, higherLow: null, trigger: trig ? trig.level : null, ema25, ema7, atr: atrNow, invalidation: null };
  const anchor = lastSwingLow === null ? bottomPrice : Math.min(bottomPrice, lastSwingLow);
  const invalidationBase = atrNow !== null ? anchor - p.invalidationBufferAtr * atrNow : anchor;
  const baseValid = invalidationBase > 0 && invalidationBase < close ? invalidationBase : null;

  const measures = {
    close,
    atr: atrNow,
    atrPct: atrNow !== null && close > 0 ? atrNow / close : null,
    atrExpansion,
    rsi: orNull(s.rsi[last]),
    rvol: orNull(s.rvol[last]),
    ema7,
    ema25,
    ema7Slope: orNull(s.emaFastSlope[last]),
    ema25Slope,
    emaDistanceAtr: F.emaDistanceAtr(s, last),
    declinePct: priorDecline.declinePct,
    declineAtr: priorDecline.declineAtr,
    barsSinceBottom,
    closeAboveBottomAtr: atrNow !== null ? (close - bottomPrice) / atrNow : null,
    triggerDistanceAtr: atrNow !== null && trig ? (close - trig.level) / atrNow : null,
    avgQuoteVolume,
    quoteVolume24h: orNull(liquidity?.quoteVolume24h),
    spreadBps: orNull(liquidity?.spreadBps),
    invalidationBase: baseValid,
    ...htfMeasures,
  };

  let classification = 'NO_SETUP';
  if (priorDecline.ok) classification = 'REVERSAL_CANDIDATE';
  else if (ema25Slope !== null && ema25Slope >= 0 && ema25 !== null && close > ema25) classification = 'CONTINUATION';
  if (!CLASSIFICATIONS.includes(classification)) throw new Error('Klasifikasi tidak dikenal');

  if (classification !== 'REVERSAL_CANDIDATE') {
    const reason = classification === 'CONTINUATION'
      ? `kelanjutan uptrend (EMA25 naik, close ${fmtPrice(close)} di atas EMA25 ${fmtPrice(ema25)}) tanpa penurunan awal`
      : `tidak ada penurunan awal yang cukup (${fmtPct(priorDecline.declinePct)} / ${fmtAtr(priorDecline.declineAtr)} dari puncak; dasar berumur ${barsSinceBottom} candle)`;
    levels.invalidation = baseValid;
    return finish(base, {
      classification,
      stage: null,
      setupTypes: [],
      context: { priorDecline, htf, liquidityClass },
      checks: notEvaluatedChecks(reason),
      levels,
      nextConfirmation: { kind: 'NONE', text: `Bukan kandidat reversal: ${reason}`, level: null },
      cancelCondition: cancelConditionOf(baseValid, { p }),
      risks,
      markers: [],
      measures,
    });
  }

  const aux = F.auxiliaryFeatures(candles, p);
  const higherLow = F.intactHigherLow(candles, s.lows, bottomIndex, last);
  levels.higherLow = higherLow ? higherLow.swing.price : null;
  const ctx = { candles, s, p, last, close, atrNow, bottomIndex, bottomPrice, barsSinceBottom, aux, liquidityClass, levels, higherLow };
  const checks = buildChecks(ctx);
  const evidence = checks.filter((c) => c.passed);
  const ids = new Set(evidence.map((c) => c.id));
  const stage = stageOf(evidence, p);
  const setupTypes = setupTypesOf(evidence);

  let invalidation = baseValid;
  let breakoutFloor = false;
  if (stage === 'CONFIRMED_BREAKOUT' && levels.trigger !== null && atrNow !== null) {
    const floor = levels.trigger - p.failedBreakAtr * atrNow;
    if (floor > 0 && floor < close && (invalidation === null || floor > invalidation)) {
      invalidation = floor;
      breakoutFloor = true;
    }
  }
  levels.invalidation = invalidation;

  if (atrNow !== null && (close - bottomPrice) / atrNow >= p.lateAtr) risks.add('LATE_ENTRY');
  if (stage === 'CONFIRMED_BREAKOUT' && !ids.has('BREAK_VOLUME_SUPPORT')) risks.add('NO_VOLUME_SUPPORT');
  if (invalidation !== null && atrNow !== null && close - invalidation <= p.nearInvalidationAtr * atrNow) risks.add('NEAR_INVALIDATION');

  Object.assign(measures, {
    bandwidth: orNull(aux.regime.bandwidth),
    bandwidthPercentile: orNull(aux.regime.bandwidthPercentile),
    flowBias: orNull(aux.flow.flowBias),
    cvdSlope: orNull(aux.flow.cvdSlope),
    structureScore: orNull(aux.structure.structureScore),
    higherLowAtr: higherLow && atrNow !== null ? (higherLow.swing.price - bottomPrice) / atrNow : null,
    higherLowChain: higherLow ? higherLow.chain : 0,
    evidenceNonTrigger: evidence.filter((c) => c.group !== 'TRIGGER').length,
  });
  for (const c of checks) measures[`v_${c.id}`] = c.value;

  return finish(base, {
    classification,
    stage,
    setupTypes,
    context: { priorDecline, htf, liquidityClass },
    checks,
    levels,
    nextConfirmation: nextConfirmationOf(stage, levels, ids, close, p),
    cancelCondition: cancelConditionOf(invalidation, { breakoutFloor, p }),
    risks,
    markers: buildMarkers(ctx, checks),
    measures,
  });
}
