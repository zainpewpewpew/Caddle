// Simulasi coverage AL-MOM-01 (docs/28 §9; tugas validasi sebelum pembekuan). Riset saja; data SINTETIS seluruhnya.
//
// Tiap dataset: pasar per jam untuk S simbol (faktor pasar bersama, rezim volatilitas, ekor tebal, opsional momentum),
// alert v3 dan event v2 dibangkitkan dari fitur yang sama dengan strata (gerak awal, posisi rentang, jarak dari alert
// sebelumnya) ditambah rezim alert bersama. Efek informasi = drift harga δ × ATR selama 12 candle sesudah alert v3,
// ditambahkan ke jalur harga (jadi candle pembanding di dekat alert ikut membawa sebagian drift itu).
//
// Analisis memakai fungsi runner beku (scripts/research-al-mom-01.js) apa adanya: kelayakan, strata, pencocokan,
// bootstrap prosedur penuh. Target per dataset dihitung tepat lewat dekomposisi linear y = y0 + Δ:
//   θ_d  = estimator yang diterapkan pada Δ (komponen drift saja) = target riset "informasi" untuk dataset itu;
//   b    = estimator pada y0 = bias desain (seleksi overlap, rasio, sisa momentum di dalam bin).
// θ_info = rata-rata θ_d antar-simulasi. Efek "0 / +0,10 / +0,25 ATR" pada skenario berarti θ_info ≈ nilai itu.
//
// Pakai: npm run research:al-mom-01-coverage -- [--sims 1000] [--reps 999] [--scenarios dasar0,dasar010] [--workers 7]

import { availableParallelism } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mulberry32 } from '../backend/backtest/eventStudy.js';
import { DAY_MS } from '../backend/research/matchedBaseline.js';
import {
  AL_MOM_01, buildGroup, buildLevelIndex, ciMethodComparison, collectSeries, createStore, outcomesAt, ratioSeries, runBootstrap,
  summarizeReplicates,
} from './research-al-mom-01.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const H = 3_600_000;
const T0 = Date.UTC(2024, 0, 1); // awal jendela semu
const WARMUP_DAYS = 30;

// ── Skenario ──
const BASE = Object.freeze({
  symbols: 40, days: 730, beta2: 0.5, nu: 5, jumpProb: 0, jumpScale: 0,
  mktVolPhi: 0.97, mktVolSd: 0.08, idioVolPhi: 0.98, idioVolSd: 0.05, sigmaLog: Math.log(0.007), sigmaLogSd: 0.3,
  h0: 0.0016, kappa: 0.17, lambda: 2, cluster12: 6, cluster48: 6, alertRegimeSd: 0.3, alertRegimePhi: 0.9,
  symbolRateSd: 0.3, v2Ratio: 5, delta: 0, deltaAmp: 0, effectRegimeDays: 60, momentumSd: 0, momentumPhi: 0.985, symMomSd: 0, symMomPhi: 0.98,
  // Hazard alert × exp(marketKappa · gerak pasar 12 jam terstandar − marketKappa²/2): alert serentak lintas simbol saat
  // pasar bergerak (konsentrasi alert harian data historis). 0 = DGP lama, urutan bilangan acak tidak berubah.
  marketKappa: 0,
  // Rezim padat (docs/29 §21): rantai Markov harian bersama (lapisan rezim). Di hari padat, korelasi antarsimbol naik
  // (β² → stressBeta2), volatilitas pasar × stressVol, dan hazard alert × stressHazard untuk semua simbol sekaligus.
  // stressEnter 0 = DGP lama, urutan bilangan acak tidak berubah.
  stressEnter: 0, stressExit: 0, stressBeta2: 0, stressVol: 1, stressHazard: 1,
});
// Lapisan rezim episode bersama untuk skenario rezim (docs/29 §21.2): ±12% hari dalam episode (masuk 0,02/hari, keluar
// 0,15/hari ≈ 6,7 hari), β² 0,30 → 0,75 dan volatilitas pasar × 1,6 di hari episode; dispersi rezim alert 0,45.
const STRESS_REGIME = Object.freeze({
  symbols: 100, beta2: 0.3, stressEnter: 0.02, stressExit: 0.15, stressBeta2: 0.75, stressVol: 1.6, alertRegimeSd: 0.45,
});
export const SCENARIOS = Object.freeze({
  dasar0: { label: 'Dasar, efek 0', ...BASE },
  dasar010: { label: 'Dasar, efek +0,10 ATR', ...BASE, delta: 0.1, calibrate: 0.1 },
  dasar025: { label: 'Dasar, efek +0,25 ATR', ...BASE, delta: 0.25, calibrate: 0.25 },
  korelasi: { label: 'Korelasi antarsimbol tinggi (β² 0,85), efek 0', ...BASE, beta2: 0.85 },
  serial: {
    label: 'Korelasi serial antarhari: rezim volatilitas persisten + efek berubah per rezim (rata-rata +0,10)', ...BASE,
    mktVolPhi: 0.995, mktVolSd: 0.035, delta: 0.1, deltaAmp: 0.3, calibrate: 0.1,
  },
  takMerata: { label: 'Alert sangat tidak merata (rezim alert & simbol), efek 0', ...BASE, alertRegimeSd: 1.0, symbolRateSd: 0.8 },
  sedikit: { label: 'Alert terpusat di gerak awal tinggi (strata pembanding sedikit), efek 0', ...BASE, kappa: 0.35, lambda: 3, h0: 0.0014 },
  ekor: { label: 'Ekor tebal (t ν 2,5 + lompatan), efek 0', ...BASE, nu: 2.5, jumpProb: 0.002, jumpScale: 5 },
  momentum: { label: 'Harga punya momentum pasar lemah, alert tanpa informasi (efek 0)', ...BASE, momentumSd: 0.02 },
  episode: { label: 'Episode tren per simbol (korelasi serial dalam simbol), alert tanpa informasi (efek 0)', ...BASE, symMomSd: 0.05 },
  episode025: { label: 'Episode tren per simbol, efek +0,25 ATR', ...BASE, symMomSd: 0.05, delta: 0.25, calibrate: 0.25 },
  stres025: {
    label: 'Gabungan stres (korelasi 0,85, ekor tebal, alert tak merata, strata sedikit), efek +0,25 ATR', ...BASE,
    beta2: 0.85, nu: 2.5, jumpProb: 0.002, jumpScale: 5, alertRegimeSd: 1.0, symbolRateSd: 0.8, kappa: 0.35, lambda: 3, h0: 0.0008,
    delta: 0.25, calibrate: 0.25,
  },
  // Kekuatan pasangan (docs/29 §16): 100 simbol seperti data historis; β² dinaikkan sampai rasio SE penuh ÷ alert saja
  // ≈ 0,84 (sedang) dan ≈ 0,71 (kuat, setara historis). Hanya blok 7 hari (biaya).
  pasangan084: { label: 'Pasangan sedang (100 simbol, β² 0,5), efek 0', ...BASE, symbols: 100, beta2: 0.5, blocks: [7] },
  pasangan084e: { label: 'Pasangan sedang (100 simbol, β² 0,5), efek +0,25 ATR', ...BASE, symbols: 100, beta2: 0.5, delta: 0.25, calibrate: 0.25, blocks: [7] },
  pasangan071: { label: 'Pasangan kuat (100 simbol, β² 0,75), efek 0', ...BASE, symbols: 100, beta2: 0.75, blocks: [7] },
  pasangan071e: { label: 'Pasangan kuat (100 simbol, β² 0,75), efek +0,25 ATR', ...BASE, symbols: 100, beta2: 0.75, delta: 0.25, calibrate: 0.25, blocks: [7] },
  // ── Simulasi konfirmasi (docs/29 §21, praregistrasi v1; belum dijalankan) ──
  // Varian "M" = efek dikalibrasi ke θ_info ≈ 0,25 (margin); varian tanpa akhiran = efek 0. Skenario stres 40 simbol yang
  // belum punya pasangan nol/M dilengkapi di sini; parameter lain identik dengan skenario asalnya.
  korelasiM: { label: 'Korelasi antarsimbol tinggi (β² 0,85), efek +0,25 ATR', ...BASE, beta2: 0.85, delta: 0.25, calibrate: 0.25 },
  serial0: {
    label: 'Korelasi serial antarhari + efek berubah per rezim (rata-rata 0, amplitudo ±0,30 θ)', ...BASE,
    mktVolPhi: 0.995, mktVolSd: 0.035, delta: 0, deltaAmp: 0.37,
  },
  serialM: {
    label: 'Korelasi serial antarhari + efek berubah per rezim (rata-rata +0,25, amplitudo ±0,30 θ)', ...BASE,
    mktVolPhi: 0.995, mktVolSd: 0.035, delta: 0.25, deltaAmp: 0.3, calibrate: 0.25,
  },
  takMerataM: { label: 'Alert sangat tidak merata, efek +0,25 ATR', ...BASE, alertRegimeSd: 1.0, symbolRateSd: 0.8, delta: 0.25, calibrate: 0.25 },
  sedikitM: { label: 'Strata pembanding sedikit, efek +0,25 ATR', ...BASE, kappa: 0.35, lambda: 3, h0: 0.0014, delta: 0.25, calibrate: 0.25 },
  ekorM: { label: 'Ekor tebal, efek +0,25 ATR', ...BASE, nu: 2.5, jumpProb: 0.002, jumpScale: 5, delta: 0.25, calibrate: 0.25 },
  momentumM: { label: 'Momentum pasar lemah, efek +0,25 ATR', ...BASE, momentumSd: 0.02, delta: 0.25, calibrate: 0.25 },
  stres0: {
    label: 'Gabungan stres (korelasi 0,85, ekor tebal, alert tak merata, strata sedikit), efek 0', ...BASE,
    beta2: 0.85, nu: 2.5, jumpProb: 0.002, jumpScale: 5, alertRegimeSd: 1.0, symbolRateSd: 0.8, kappa: 0.35, lambda: 3, h0: 0.0008,
  },
  // 100 simbol (skala data nyata).
  takMerata100: { label: 'Alert sangat tidak merata, 100 simbol (β² 0,5), efek 0', ...BASE, symbols: 100, beta2: 0.5, alertRegimeSd: 1.0, symbolRateSd: 0.8, blocks: [7] },
  takMerata100M: {
    label: 'Alert sangat tidak merata, 100 simbol (β² 0,5), efek +0,25 ATR', ...BASE, symbols: 100, beta2: 0.5, alertRegimeSd: 1.0, symbolRateSd: 0.8,
    delta: 0.25, calibrate: 0.25, blocks: [7],
  },
  // Rezim episode bersama, dikalibrasi ke ciri historis 2024-10 … 2026-09 (docs/29 §21.2; ciri saja, bukan hasil CI):
  // di hari episode korelasi & volatilitas naik dan alert LONG BERKURANG (hazard × 0,2).
  rezimHistoris100: {
    label: 'Rezim episode (kalibrasi historis: korelasi & volatilitas naik, alert berkurang), 100 simbol, efek 0', ...BASE, ...STRESS_REGIME,
    stressHazard: 0.2, h0: 0.0016, blocks: [7],
  },
  rezimHistoris100M: {
    label: 'Rezim episode (kalibrasi historis), 100 simbol, efek +0,25 ATR', ...BASE, ...STRESS_REGIME, stressHazard: 0.2, h0: 0.0016,
    delta: 0.25, calibrate: 0.25, blocks: [7],
  },
  // Hipotesis tinjauan ChatGPT (korelasi, volatilitas, DAN kepadatan alert naik bersama; hazard × 3). Bertentangan dengan
  // ciri historis (docs/29 §21.2), jadi digolongkan skenario ekstrem.
  rezimPadat100: {
    label: 'Rezim padat (hipotesis: korelasi, volatilitas, dan alert naik bersama), 100 simbol, efek 0', ...BASE, ...STRESS_REGIME,
    stressHazard: 3, h0: 0.00117, blocks: [7],
  },
  rezimPadat100M: {
    label: 'Rezim padat (hipotesis), 100 simbol, efek +0,25 ATR', ...BASE, ...STRESS_REGIME, stressHazard: 3, h0: 0.00117,
    delta: 0.25, calibrate: 0.25, blocks: [7],
  },
});

// ── Bilangan acak ──
function rng(seed) {
  const u = mulberry32(seed);
  let spare = null;
  const normal = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let a;
    let b;
    let r;
    do {
      a = 2 * u() - 1;
      b = 2 * u() - 1;
      r = a * a + b * b;
    } while (r === 0 || r >= 1);
    const f = Math.sqrt((-2 * Math.log(r)) / r);
    spare = b * f;
    return a * f;
  };
  // Gamma(k, 1) Marsaglia–Tsang (k ≥ 1; k < 1 lewat boost).
  const gamma = (k) => {
    if (k < 1) return gamma(k + 1) * u() ** (1 / k);
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x;
      let v;
      do {
        x = normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const uu = u();
      if (uu < 1 - 0.0331 * x ** 4 || Math.log(uu) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  // t_ν berskala varians 1 (ν > 2).
  const student = (nu) => (normal() / Math.sqrt(gamma(nu / 2) / (nu / 2))) * Math.sqrt((nu - 2) / nu);
  return { u, normal, student };
}

/** simulateMarket menerima `innovationSeed` (dipakai mode oracle scripts/research-al-mom-01-diagnose.js). */
export const SUPPORTS_INNOVATION_SEED = true;

/**
 * Satu dataset sintetis. Per simbol: candles, v3Idx, anyIdx, cumDrift (drift kumulatif dalam satuan harga). Dengan
 * `onSeries`, tiap simbol diserahkan lalu dibuang (hemat memori; urutan bilangan acak sama). ATR online memakai rumus
 * backend/indicators/atr.js (SMA 14 TR lalu Wilder).
 *
 * Lapisan rezim (rf): rezim volatilitas pasar & idiosinkratik, rezim alert, tanda efek, σ dan laju alert per simbol.
 * Inovasi (R): return pasar & idiosinkratik, lompatan, momentum, high/low, volume, undian alert. Tanpa `innovationSeed`
 * keduanya satu aliran dengan urutan undian identik dengan versi sebelumnya; dengan `innovationSeed`, lapisan rezim
 * tetap (benih `seed`) dan inovasi berganti (strata simbol × kuartal berarti sama antar-draw).
 */
export function simulateMarket(sc, seed, onSeries = null, { innovationSeed = null } = {}) {
  const rf = rng(seed);
  const R = innovationSeed === null ? rf : rng(innovationSeed);
  const days = sc.days + WARMUP_DAYS;
  const n = days * 24;
  const start = T0 - WARMUP_DAYS * DAY_MS;
  // Faktor bersama: inovasi pasar, rezim volatilitas pasar (harian), rezim alert (harian), rezim efek, momentum.
  const f = new Float64Array(n);
  const mktVol = new Float64Array(n);
  const alertReg = new Float64Array(days);
  const effectSign = new Int8Array(days);
  const stressDay = new Uint8Array(days);
  const mom = new Float64Array(n);
  let lv = 0;
  let ar = 0;
  let sign = rf.u() < 0.5 ? 1 : -1;
  let stress = 0;
  for (let d = 0; d < days; d += 1) {
    lv = sc.mktVolPhi * lv + sc.mktVolSd * rf.normal();
    ar = sc.alertRegimePhi * ar + Math.sqrt(1 - sc.alertRegimePhi ** 2) * rf.normal();
    alertReg[d] = Math.exp(sc.alertRegimeSd * ar - (sc.alertRegimeSd ** 2) / 2);
    if (rf.u() < 1 / sc.effectRegimeDays) sign = -sign;
    effectSign[d] = sign;
    if (sc.stressEnter > 0) {
      const u = rf.u();
      stress = stress ? (u < sc.stressExit ? 0 : 1) : (u < sc.stressEnter ? 1 : 0);
      stressDay[d] = stress;
    }
    const volMult = stressDay[d] ? sc.stressVol : 1;
    for (let h = 0; h < 24; h += 1) mktVol[d * 24 + h] = Math.exp(lv) * volMult;
  }
  let m = 0;
  for (let t = 0; t < n; t += 1) {
    f[t] = R.student(sc.nu);
    if (sc.momentumSd > 0) {
      m = sc.momentumPhi * m + sc.momentumSd * Math.sqrt(1 - sc.momentumPhi ** 2) * R.normal();
      mom[t] = m;
    }
  }
  const betaCalm = Math.sqrt(sc.beta2);
  const idioCalm = Math.sqrt(1 - sc.beta2);
  const betaStress = sc.stressEnter > 0 ? Math.sqrt(sc.stressBeta2) : betaCalm;
  const idioStress = sc.stressEnter > 0 ? Math.sqrt(1 - sc.stressBeta2) : idioCalm;
  // Gerak pasar 12 jam terstandar (Σ f[t−11..t] / √12), hanya dari candle ≤ t.
  const mHaz = sc.marketKappa ? new Float64Array(n).fill(1) : null;
  if (mHaz) {
    let run = 0;
    for (let t = 0; t < n; t += 1) {
      run += f[t] - (t >= 12 ? f[t - 12] : 0);
      if (t >= 11) mHaz[t] = Math.exp(sc.marketKappa * Math.max(-4, Math.min(8, run / Math.sqrt(12))) - (sc.marketKappa ** 2) / 2);
    }
  }
  const series = onSeries ? null : [];
  for (let j = 0; j < sc.symbols; j += 1) {
    const sigma = Math.exp(sc.sigmaLog + sc.sigmaLogSd * rf.normal());
    const symRate = Math.exp(sc.symbolRateSd * rf.normal() - (sc.symbolRateSd ** 2) / 2);
    const candles = new Array(n);
    const cumDrift = new Float64Array(n);
    const drift = new Float64Array(n + 13);
    const v3Idx = [];
    const anyIdx = [];
    let price = 100 * Math.exp(rf.normal());
    let iv = 0;
    let atrPrev = null;
    let trSum = 0;
    let lastAny = -1;
    let cum = 0;
    let sm = 0;
    const closes = new Float64Array(n);
    const highs = new Float64Array(n);
    const lows = new Float64Array(n);
    for (let t = 0; t < n; t += 1) {
      if (t % 24 === 0) iv = sc.idioVolPhi * iv + sc.idioVolSd * rf.normal();
      const s = sigma * mktVol[t] * Math.exp(iv);
      const st = stressDay[Math.floor(t / 24)];
      let z = (st ? betaStress : betaCalm) * f[t] + (st ? idioStress : idioCalm) * R.student(sc.nu);
      if (sc.jumpProb > 0 && R.u() < sc.jumpProb) z += sc.jumpScale * R.normal();
      if (sc.symMomSd > 0) sm = sc.symMomPhi * sm + sc.symMomSd * Math.sqrt(1 - sc.symMomPhi ** 2) * R.normal();
      const ret = Math.max(-0.5, s * z + (sc.momentumSd > 0 ? s * mom[t] : 0) + s * sm);
      const open = price;
      const close = Math.max(open * 0.05, open * (1 + ret) + drift[t]);
      cum += drift[t];
      cumDrift[t] = cum;
      const hi = Math.max(open, close) * (1 + Math.abs(R.normal()) * 0.4 * s);
      const lo = Math.min(open, close) * Math.max(0.05, 1 - Math.abs(R.normal()) * 0.4 * s);
      candles[t] = {
        openTime: start + t * H, closeTime: start + (t + 1) * H - 1, open, high: hi, low: lo, close, volume: 1000 + 100 * R.u(), isClosed: true,
      };
      closes[t] = close;
      highs[t] = hi;
      lows[t] = lo;
      price = close;
      // ATR online (sama dengan backend): TR, SMA 14 pertama, lalu Wilder.
      const tr = t === 0 ? hi - lo : Math.max(hi - lo, Math.abs(hi - closes[t - 1]), Math.abs(lo - closes[t - 1]));
      let atrNow = null;
      if (t < 14) {
        trSum += tr;
        if (t === 13) atrNow = trSum / 14;
      } else {
        atrNow = (atrPrev * 13 + tr) / 14;
      }
      if (atrNow !== null) atrPrev = atrNow;
      // Pembangkit alert (fitur hanya dari candle ≤ t).
      if (t >= 150 && t < n - 2 && atrPrev > 0) {
        const pre = (close - closes[t - 12]) / atrPrev;
        let h48 = -Infinity;
        let l48 = Infinity;
        for (let k = t - 47; k <= t; k += 1) {
          if (highs[k] > h48) h48 = highs[k];
          if (lows[k] < l48) l48 = lows[k];
        }
        const pos = h48 > l48 ? (close - l48) / (h48 - l48) : 0.5;
        const since = lastAny >= 0 ? t - lastAny : Infinity;
        const cl = since <= 12 ? sc.cluster12 : since <= 48 ? sc.cluster48 : 1;
        const hz = sc.h0 * Math.exp(sc.kappa * Math.max(-4, Math.min(8, pre))) * Math.exp(sc.lambda * (pos - 1)) * cl * alertReg[Math.floor(t / 24)] * symRate * (mHaz ? mHaz[t] : 1)
          * (st ? sc.stressHazard : 1);
        const isV3 = R.u() < hz;
        const isV2 = R.u() < hz * sc.v2Ratio;
        if (isV3 || isV2) {
          anyIdx.push(t);
          lastAny = t;
        }
        if (isV3) {
          v3Idx.push(t);
          const dEff = sc.delta + sc.deltaAmp * effectSign[Math.floor(t / 24)];
          const per = (dEff * atrPrev) / 12;
          for (let k = t + 1; k <= t + 12; k += 1) drift[k] += per;
        }
      }
    }
    const one = { symbol: `S${String(j).padStart(3, '0')}USDT`, candles, v3Idx, anyIdx, cumDrift };
    if (onSeries) onSeries(one, j);
    else series.push(one);
  }
  return { series, window: simWindow(sc), dayFrom: Math.floor(T0 / DAY_MS) };
}

/** Jendela semu dataset sintetis: [T0, T0 + hari − 50 candle). */
export const simWindow = (sc) => ({ from: T0, to: T0 + sc.days * DAY_MS - AL_MOM_01.settleBars * H });

/** Analisis satu dataset dengan fungsi runner beku; plus target θ_d dari komponen drift. */
export function analyzeSimulation(sc, seed, reps, { blocks = [7, 14, 1] } = {}) {
  const store = createStore({ withOutcomes: true });
  const dCtrl = new Map(); // kode strata utama (hanya strata ber-alert) → [n, ΣΔ]
  const dAlert = new Map(); // `${sym}:${openTime}` → Δ
  const sim = simulateMarket(sc, seed, (s, sym) => {
    const local = new Map();
    const codes = new Set();
    collectSeries({
      store, sym, symbol: s.symbol, candles: s.candles, v3Idx: s.v3Idx, anyIdx: s.anyIdx, window: simWindow(sc), outcomeFn: outcomesAt,
      onRecord: (rec) => {
        const delta = (s.cumDrift[rec.i + AL_MOM_01.look] - s.cumDrift[rec.i]) / rec.atr;
        if (rec.isAlert) {
          dAlert.set(`${sym}:${rec.openTime}`, delta);
          codes.add(rec.code.jarak);
        }
        if (rec.isTanpa) {
          let c = local.get(rec.code.jarak);
          if (!c) {
            c = [0, 0];
            local.set(rec.code.jarak, c);
          }
          c[0] += 1;
          c[1] += delta;
        }
      },
    });
    for (const code of codes) if (local.has(code)) dCtrl.set(code, local.get(code));
  });
  const dayFrom = sim.dayFrom;
  const dayTo = Math.floor((sim.window.to - 1) / DAY_MS) + 1;
  const D = dayTo - dayFrom;
  const main = store.alerts.filter((a) => (store.strata.jarak.get(a.code.jarak)?.[0] ?? 0) > 0);
  const out = {
    seed, alerts: store.alerts.length, matched: main.length, share: store.alerts.length ? main.length / store.alerts.length : null,
    extreme: store.alerts.filter((a) => a.extreme).length, extremeMatched: main.filter((a) => a.extreme).length,
    d12Share: store.alerts.length ? store.alerts.filter((a) => a.distIdx === 0).length / store.alerts.length : null,
  };
  if (!main.length) return { ...out, failed: 'tidak ada alert berpembanding' };
  const t = (a) => store.strata.jarak.get(a.code.jarak);
  out.pointA = main.reduce((s, a) => s + a.y.A - t(a)[1] / t(a)[0], 0) / main.length;
  out.pointB = main.reduce((s, a) => s + a.y.B - t(a)[2] / t(a)[0], 0) / main.length;
  out.thetaD = main.reduce((s, a) => {
    const c = dCtrl.get(a.code.jarak);
    return s + dAlert.get(`${a.sym}:${a.openTime}`) - c[1] / c[0];
  }, 0) / main.length;
  const index = buildLevelIndex({ store, level: 'jarak', alerts: main, dayFrom, D });
  out.methods = {};
  for (const L of blocks) {
    const b = runBootstrap({
      D, blockDays: L, reps, seed: AL_MOM_01.seed, indexes: { jarak: index },
      groups: [buildGroup({ name: 'main', index, alerts: main, dayFrom, variants: L === 7, diagnostics: L === 7 })],
    });
    const g = b.groups[0];
    const variants = L === 7 ? ['full', 'fixedPop', 'sameSet', 'alertsOnly'] : ['full'];
    for (const v of variants) {
      const sA = summarizeReplicates(ratioSeries(g[v].a, g[v].w), out.pointA);
      const sB = summarizeReplicates(ratioSeries(g[v].b, g[v].w), out.pointB);
      out.methods[`${v}${L}`] = { A: { lo: sA.lo, hi: sA.hi, se: sA.se, invalid: sA.invalid }, B: { lo: sB.lo, hi: sB.hi, se: sB.se, invalid: sB.invalid } };
    }
    if (L === 7) {
      const cm = ciMethodComparison(ratioSeries(g.full.a, g.full.w), out.pointA);
      out.ci = { shiftSe: cm.shiftSe, upperSe: cm.upperSe, lowerSe: cm.lowerSe, basic: cm.basic, bc: cm.bc, percentile: cm.percentile };
      let lostSum = 0;
      let lostMax = 0;
      let k = 0;
      for (let r = 0; r < reps; r += 1) {
        const dw = g.diag.drawnWeight[r];
        if (!(dw > 0)) continue;
        const lost = 1 - g.diag.keptWeight[r] / dw;
        lostSum += lost;
        if (lost > lostMax) lostMax = lost;
        k += 1;
      }
      out.lostMean = k ? lostSum / k : null;
      out.lostMax = lostMax;
    }
  }
  return out;
}

// ── Agregasi ──
const meanOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sdOf = (a) => {
  if (a.length < 2) return null;
  const m = meanOf(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
/** Proporsi dengan SE binomial dan interval Wilson 95% (ketidakpastian Monte Carlo). */
export function proportion(k, n) {
  if (!n) return { p: null, se: null, lo: null, hi: null, k, n };
  const p = k / n;
  const z = 1.959964;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { p, se: Math.sqrt((p * (1 - p)) / n), lo: c - h, hi: c + h, k, n };
}

export function aggregateScenario(name, sc, runs, margin = AL_MOM_01.margin) {
  const ok = runs.filter((r) => !r.failed && Number.isFinite(r.pointA));
  const pts = ok.map((r) => r.pointA);
  const thetas = ok.map((r) => r.thetaD);
  const thetaInfo = meanOf(thetas);
  const meanEst = meanOf(pts);
  const sdEmp = sdOf(pts);
  const ptsB = ok.map((r) => r.pointB);
  const meanB = meanOf(ptsB);
  const sdB = sdOf(ptsB);
  const methods = {};
  for (const key of Object.keys(ok[0]?.methods ?? {})) {
    const list = ok.filter((r) => r.methods[key] && r.methods[key].A.lo !== null);
    const cover = (target) => proportion(list.filter((r) => r.methods[key].A.lo <= target(r) && target(r) <= r.methods[key].A.hi).length, list.length);
    const ses = list.map((r) => r.methods[key].A.se);
    methods[key] = {
      n: list.length, meanSe: meanOf(ses), seRatio: sdEmp ? meanOf(ses) / sdEmp : null,
      coverInfo: cover(() => thetaInfo), coverSample: cover((r) => r.thetaD), coverMean: cover(() => meanEst),
      superiority: proportion(list.filter((r) => r.methods[key].A.lo > 0).length, list.length),
      upperBelowMargin: proportion(list.filter((r) => r.methods[key].A.hi < margin).length, list.length),
      upperBelowTheta: proportion(list.filter((r) => r.methods[key].A.hi < thetaInfo).length, list.length),
      invalidReps: list.reduce((s, r) => s + r.methods[key].A.invalid, 0),
      B: {
        coverMean: proportion(list.filter((r) => r.methods[key].B.lo <= meanB && meanB <= r.methods[key].B.hi).length, list.length),
        seRatio: sdB ? meanOf(list.map((r) => r.methods[key].B.se)) / sdB : null,
      },
    };
  }
  return {
    name, label: sc.label, symbols: sc.symbols, beta2: sc.beta2, delta: sc.delta, deltaAmp: sc.deltaAmp, sims: runs.length, failed: runs.length - ok.length,
    alerts: meanOf(ok.map((r) => r.alerts)), matchedShare: meanOf(ok.map((r) => r.share)), d12Share: meanOf(ok.map((r) => r.d12Share)),
    extremeShare: meanOf(ok.map((r) => (r.alerts ? r.extreme / r.alerts : 0))), extremeCovered: meanOf(ok.filter((r) => r.extreme).map((r) => r.extremeMatched / r.extreme)),
    thetaInfo, thetaSd: sdOf(thetas), meanEst, sdEmp, mcSeMean: sdEmp ? sdEmp / Math.sqrt(ok.length) : null,
    bias: meanEst - thetaInfo, biasMcSe: sdEmp ? sdEmp / Math.sqrt(ok.length) : null,
    designBias: meanOf(ok.map((r) => r.pointA - r.thetaD)), designBiasSd: sdOf(ok.map((r) => r.pointA - r.thetaD)),
    designBiasMcSe: ok.length > 1 ? sdOf(ok.map((r) => r.pointA - r.thetaD)) / Math.sqrt(ok.length) : null,
    meanB, sdB, lostMean: meanOf(ok.map((r) => r.lostMean)), lostMax: Math.max(...ok.map((r) => r.lostMax)),
    attenuation: sc.delta ? thetaInfo / sc.delta : null, methods,
    // Galat satu sisi CI A (blok 7 hari): persentil = metode beku; basic & BC = pembanding metode saja.
    ciShape: {
      shiftSe: meanOf(ok.map((r) => r.ci.shiftSe)), upperSe: meanOf(ok.map((r) => r.ci.upperSe)), lowerSe: meanOf(ok.map((r) => r.ci.lowerSe)),
    },
    // Peluang keputusan per metode CI: klaim superioritas (lo > 0) dan klaim "keunggulan < M" (hi < M).
    decision: Object.fromEntries(['percentile', 'basic', 'bc'].map((m) => [m, {
      loAboveZero: proportion(ok.filter((r) => r.ci[m].lo > 0).length, ok.length),
      hiBelowMargin: proportion(ok.filter((r) => r.ci[m].hi < margin).length, ok.length),
    }])),
    // Ringkasan per simulasi: [titik A, θ_d, persentil lo, hi, basic lo, hi, BC lo, hi].
    runs: ok.map((r) => [r.pointA, r.thetaD, r.ci.percentile.lo, r.ci.percentile.hi, r.ci.basic.lo, r.ci.basic.hi, r.ci.bc.lo, r.ci.bc.hi]),
    ciErrors: Object.fromEntries(['percentile', 'basic', 'bc'].map((m) => [m, {
      hiBelowInfo: proportion(ok.filter((r) => r.ci[m].hi < thetaInfo).length, ok.length),
      loAboveInfo: proportion(ok.filter((r) => r.ci[m].lo > thetaInfo).length, ok.length),
      hiBelowMean: proportion(ok.filter((r) => r.ci[m].hi < meanEst).length, ok.length),
      loAboveMean: proportion(ok.filter((r) => r.ci[m].lo > meanEst).length, ok.length),
    }])),
  };
}

// ── Markdown ──
const num = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d).replace('.', ',')}`);
const plain = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d).replace('.', ','));
const pp = (p) => (p?.p === null || p?.p === undefined ? '—' : `${(p.p * 100).toFixed(1).replace('.', ',')}% [${(p.lo * 100).toFixed(1).replace('.', ',')}–${(p.hi * 100).toFixed(1).replace('.', ',')}]`);
const METHOD = { full7: 'penuh 7 hari (utama)', fixedPop7: 'populasi tetap 7 hari', sameSet7: 'himpunan sama 7 hari', alertsOnly7: 'alert saja 7 hari', full14: 'penuh 14 hari', full1: 'penuh harian' };

export function renderCoverageMarkdown(r) {
  const md = [
    '# Simulasi coverage AL-MOM-01 (data sintetis) — AlphaLens', '',
    `Dibuat ${r.generatedAt} · ${r.sims} simulasi per skenario · ${r.reps} replikasi bootstrap per simulasi · ${r.symbols} simbol × ${r.days} hari per dataset · `
      + `kode analisis = fungsi runner AL-MOM-01 (hash ${r.tree}). Kurung siku = interval Wilson 95% (ketidakpastian Monte Carlo).`, '',
    'θ_info = rata-rata target per dataset (estimator pada komponen drift saja). "Komponen waktu/seleksi" = rata-rata (estimasi − θ_d) = estimator pada komponen tanpa drift: '
      + 'bagian estimand yang tidak berasal dari informasi (mis. pembanding sebelum alert yang jendelanya memuat gerak pemicu alert).', '',
    '## Ringkasan per skenario (A, metode utama penuh 7 hari)', '',
    '| Skenario | δ disisipkan | θ_info (SD θ_d) | Rata-rata estimasi | Komponen waktu/seleksi ± SE MC | SE empiris | Rata-rata SE bootstrap (rasio) | Coverage θ_info | Coverage θ_d | lo > 0 | hi < 0,25 | Alert · cocok |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.scenarios.map((s) => {
      const m = s.methods.full7;
      return `| ${s.label} | ${plain(s.delta, 3)}${s.deltaAmp ? ` ± ${plain(s.deltaAmp, 2)}` : ''} | ${num(s.thetaInfo)} (${plain(s.thetaSd)}) | ${num(s.meanEst)} | ${num(s.designBias)} ± ${plain(s.designBiasMcSe)} | `
        + `${plain(s.sdEmp)} | ${plain(m?.meanSe)} (${plain(m?.seRatio, 2)}) | ${pp(m?.coverInfo)} | ${pp(m?.coverSample)} | ${pp(m?.superiority)} | ${pp(m?.upperBelowMargin)} | `
        + `${Math.round(s.alerts)} · ${(s.matchedShare * 100).toFixed(0)}% |`;
    }),
    '', '## Perbandingan metode bootstrap', '',
    '| Skenario | Metode | Rata-rata SE (rasio thd SE empiris) | Coverage θ_info | Coverage rata-rata estimasi | lo > 0 | hi < θ_info | Replikasi tidak valid | B: coverage rata-rata, rasio SE |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.scenarios.flatMap((s) => Object.entries(s.methods).map(([k, m]) => `| ${s.name} | ${METHOD[k] ?? k} | ${plain(m.meanSe)} (${plain(m.seRatio, 2)}) | ${pp(m.coverInfo)} | ${pp(m.coverMean)} | `
      + `${pp(m.superiority)} | ${pp(m.upperBelowTheta)} | ${m.invalidReps} | ${pp(m.B.coverMean)}, ${plain(m.B.seRatio, 2)} |`)),
    '', '## Galat satu sisi CI A (blok 7 hari): persentil (beku) vs basic & BC (pembanding saja)', '',
    'Nominal tiap sisi 2,5%. "θ_info" = target informasi; "rata-rata" = rata-rata estimasi (estimand teknis termasuk komponen waktu).', '',
    '| Skenario | Geser median bootstrap (SE) | Batas atas − titik (SE) | Titik − batas bawah (SE) | Metode | hi < θ_info | lo > θ_info | hi < rata-rata | lo > rata-rata |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.scenarios.flatMap((s) => ['percentile', 'basic', 'bc'].map((m, k) => `| ${k ? '' : s.name} | ${k ? '' : num(s.ciShape.shiftSe, 2)} | ${k ? '' : plain(s.ciShape.upperSe, 2)} | `
      + `${k ? '' : plain(s.ciShape.lowerSe, 2)} | ${m === 'percentile' ? 'persentil (beku)' : m} | ${pp(s.ciErrors[m].hiBelowInfo)} | ${pp(s.ciErrors[m].loAboveInfo)} | `
      + `${pp(s.ciErrors[m].hiBelowMean)} | ${pp(s.ciErrors[m].loAboveMean)} |`)),
    '', '## Peluang keputusan per metode CI (A, blok 7 hari)', '',
    'Pada θ_info ≈ 0, "lo > 0" = galat klaim superioritas; pada θ_info ≈ 0,25, "hi < 0,25" = galat klaim "keunggulan < 0,25". Di skenario lain keduanya = daya.', '',
    '| Skenario | θ_info | Persentil (beku): lo > 0 · hi < 0,25 | Basic: lo > 0 · hi < 0,25 | BC: lo > 0 · hi < 0,25 |',
    '| --- | --- | --- | --- | --- |',
    ...r.scenarios.filter((s) => s.decision).map((s) => `| ${s.name} | ${num(s.thetaInfo)} | ${pp(s.decision.percentile.loAboveZero)} · ${pp(s.decision.percentile.hiBelowMargin)} | `
      + `${pp(s.decision.basic.loAboveZero)} · ${pp(s.decision.basic.hiBelowMargin)} | ${pp(s.decision.bc.loAboveZero)} · ${pp(s.decision.bc.hiBelowMargin)} |`),
    '', '## Stabilitas overlap', '',
    '| Skenario | Porsi alert cocok | Alert ≤ 12 candle | Alert ≥ 4 ATR · tercakup | Rata-rata porsi hilang per replikasi | Maks porsi hilang | Atenuasi θ_info/δ |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.scenarios.map((s) => `| ${s.name} | ${(s.matchedShare * 100).toFixed(1).replace('.', ',')}% | ${(s.d12Share * 100).toFixed(0)}% | ${(s.extremeShare * 100).toFixed(0)}% · ${s.extremeCovered === null ? '—' : `${(s.extremeCovered * 100).toFixed(0)}%`} | `
      + `${plain(s.lostMean, 4)} | ${plain(s.lostMax, 4)} | ${s.attenuation === null ? '—' : plain(s.attenuation, 3)} |`),
    '',
  ];
  return md.join('\n');
}

// ── Orkestrasi (worker threads) ──
async function runPool({ tasks, workers }) {
  const results = new Array(tasks.length);
  let next = 0;
  let done = 0;
  const pool = [];
  await new Promise((resolveAll, reject) => {
    const spawn = () => {
      if (next >= tasks.length) return;
      const w = new Worker(SELF, { workerData: { batch: true } });
      pool.push(w);
      const feed = () => {
        if (next >= tasks.length) {
          w.postMessage(null);
          return;
        }
        const k = next;
        next += 1;
        w.postMessage({ k, ...tasks[k] });
      };
      w.on('message', (msg) => {
        results[msg.k] = msg.result;
        done += 1;
        if (done % 50 === 0 || done === tasks.length) process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${done}/${tasks.length} simulasi\n`);
        if (done === tasks.length) resolveAll();
        else feed();
      });
      w.on('error', reject);
      feed();
    };
    for (let i = 0; i < workers; i += 1) spawn();
  });
  await Promise.all(pool.map((w) => w.terminate()));
  return results;
}

if (!isMainThread && workerData?.batch) {
  parentPort.on('message', (task) => {
    if (task === null) {
      process.exit(0);
    }
    const sc = SCENARIOS[task.scenario] ? { ...SCENARIOS[task.scenario], ...(task.override ?? {}) } : task.sc;
    const result = analyzeSimulation(sc, task.seed, task.reps, sc.blocks ? { blocks: sc.blocks } : {});
    parentPort.postMessage({ k: task.k, result });
  });
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      sims: { type: 'string', default: '1000' }, reps: { type: 'string', default: '999' }, scenarios: { type: 'string' },
      workers: { type: 'string', default: String(Math.max(1, Math.min(4, availableParallelism() - 2))) }, out: { type: 'string', default: join(ROOT, 'reports', 'research') },
      'calibrate-sims': { type: 'string', default: '40' }, seed: { type: 'string', default: '900001' },
      // Panjang blok bootstrap untuk SEMUA skenario yang dijalankan (mis. "7"); bawaan: blok skenario atau 7,14,1.
      blocks: { type: 'string' },
    },
    strict: true,
  });
  const blocksOverride = v.blocks ? v.blocks.split(',').map(Number) : null;
  if (blocksOverride && !blocksOverride.every((b) => Number.isInteger(b) && b >= 1)) throw new RangeError(`--blocks tidak sah: ${v.blocks}`);
  const sims = Number(v.sims);
  const reps = Number(v.reps);
  const workers = Number(v.workers);
  const baseSeed = Number(v.seed);
  const names = v.scenarios ? v.scenarios.split(',') : Object.keys(SCENARIOS);
  for (const n of names) if (!SCENARIOS[n]) throw new RangeError(`skenario tidak dikenal: ${n}`);
  const { codeTreeHash } = await import('./research-al-mom-01.js');
  const tree = (await codeTreeHash()).hash;
  const started = Date.now();
  // Kalibrasi δ supaya θ_info ≈ target (atenuasi diukur dari simulasi pendahuluan dengan benih terpisah).
  const overrides = {};
  for (const n of names) {
    const sc = SCENARIOS[n];
    if (!sc.calibrate) continue;
    const pilot = await runPool({ tasks: Array.from({ length: Number(v['calibrate-sims']) }, (_, k) => ({ scenario: n, seed: 500_000 + k, reps: 200 })), workers });
    const theta = meanOf(pilot.filter((p) => !p.failed).map((p) => p.thetaD));
    const factor = theta / sc.delta;
    overrides[n] = { delta: sc.calibrate / factor, deltaAmp: sc.deltaAmp ? sc.deltaAmp / factor : 0 };
    process.stderr.write(`kalibrasi ${n}: θ pada δ ${sc.delta} = ${theta.toFixed(4)} → δ ${overrides[n].delta.toFixed(4)}\n`);
  }
  if (blocksOverride) for (const n of names) overrides[n] = { ...(overrides[n] ?? {}), blocks: blocksOverride };
  const scenarios = [];
  for (const n of names) {
    const tasks = Array.from({ length: sims }, (_, k) => ({ scenario: n, seed: baseSeed + k, reps, override: overrides[n] ?? null }));
    const runs = await runPool({ tasks, workers });
    scenarios.push(aggregateScenario(n, { ...SCENARIOS[n], ...(overrides[n] ?? {}) }, runs));
    process.stderr.write(`${n} selesai (${Math.round((Date.now() - started) / 1000)} s)\n`);
  }
  const result = {
    generatedAt: new Date(started).toISOString(), sims, reps, symbols: BASE.symbols, days: BASE.days, tree, overrides, scenarios,
    durationS: Math.round((Date.now() - started) / 1000),
  };
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await writeFile(join(out, `al-mom-01-coverage-${slug}.json`), JSON.stringify(result, null, 2), 'utf8');
  await writeFile(join(out, `al-mom-01-coverage-${slug}.md`), renderCoverageMarkdown(result), 'utf8');
  process.stderr.write(`Selesai dalam ${result.durationS} s → ${join(out, `al-mom-01-coverage-${slug}.md`)}\n`);
}

if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`Simulasi gagal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
