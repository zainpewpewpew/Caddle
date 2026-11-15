// Praregistrasi AL-SA-ATR-01 (docs/26): aturan, data, dan kriteria lulus yang DIBEKUKAN sebelum data uji ada.
// Riset saja: tidak dipakai worker/scanner live. Mengubah apa pun di sini sesudah dibekukan = uji baru dengan
// praregistrasi baru; evaluasi wajib dijalankan pada commit beku (docs/26 §6).

export const AL_SA_ATR_01 = Object.freeze({
  id: 'AL-SA-ATR-01',
  version: 1,
  frozenAt: '2026-11-15',
  hypothesis: 'Alert LONG 1h SA/PVA v3 (tier ≥ B) dengan gerak 12 candle ≥ 2,7 × ATR14 pada candle sinyal punya R bersih '
    + 'rata-rata > 0 (setelah fee, slippage, dan funding) pada data yang belum ada saat praregistrasi.',
  direction: 'LONG',
  timeframe: '1h',
  // Filter (definisi docs/24 §1.2): gerak awal = (close[i] − close[i−12]) ÷ ATR14[i].
  preThresholdAtr: 2.7,
  look: 12,
  donchian: 48,
  atrPeriod: 14,
  // Eksekusi (runner backtest): entri open candle berikutnya, stop = level invalidasi sinyal, target 2R, 48 candle,
  // stop & target di candle yang sama = LOSS.
  entry: 'nextOpen',
  targetR: 2,
  maxBars: 48,
  feeBps: 5,
  slippageBps: 2,
  stressFeeBps: 5,
  stressSlippageBps: 5,
  // Jendela data: sinyal dengan openTime candle sinyal di [windowStart, end), end = min(cutoff, maxWindowEnd) − settleBars
  // candle, jadi setiap trade punya cukup data untuk selesai sebelum cutoff (tidak ada seleksi menurut cepat-lambatnya trade
  // selesai). Trade yang tetap terbuka (mis. data bolong) dilaporkan jumlahnya, tidak dihitung.
  windowStart: Date.UTC(2026, 10, 16),
  maxWindowEnd: Date.UTC(2027, 10, 16),
  settleBars: 50, // = maxBars + 2
  warmupDays: 30, // 720 candle ≥ ANALYSIS_LOOKBACK 300 + BACKTEST_WARMUP 150; timeframe 1h tidak punya konteks HTF
  // Ukuran sampel (docs/26 §4): trade kelompok filter (satu posisi per simbol) yang wajib tercapai. 600 → daya ±80% untuk
  // P1 & P2 bersama bila efek sebenarnya = efek teramati docs/25 (+0,17R; selisih +0,20R), ±22% bila efek setengahnya.
  nRequired: 600,
  blockDays: 7,
  sensitivityBlockDays: Object.freeze([14, 1]),
  reps: 2000,
  seed: 7,
  diffSeed: 11,
  // Kohort (dilaporkan, bukan penentu): simbol yang punya candle 1h pada [oldCohortFrom, oldCohortTo) = lama.
  oldCohortFrom: Date.UTC(2025, 9, 1),
  oldCohortTo: Date.UTC(2025, 10, 1),
  universeAt: '2026-11-15T16:04:30.837Z',
  universeMethod: 'listTopSymbols({ limit: 100 }): discovery scanner, urut quote volume 24 jam, spread ≤ 1000 bps',
  universe: Object.freeze([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ZECUSDT', 'XRPUSDT', 'HYPEUSDT', 'BNBUSDT', 'EVAAUSDT', 'DOGEUSDT', 'NEARUSDT',
    'AKEUSDT', '1000PEPEUSDT', 'UNIUSDT', 'ADAUSDT', 'SUIUSDT', 'KAVAUSDT', 'ENAUSDT', 'INITUSDT', 'ASTERUSDT', 'SOPHUSDT',
    'LINKUSDT', 'AVAXUSDT', 'INJUSDT', 'JCTUSDT', 'WLDUSDT', 'TAOUSDT', 'AAVEUSDT', 'PUMPUSDT', 'LTCUSDT', 'TRUMPUSDT',
    'FILUSDT', 'ARBUSDT', 'BCHUSDT', 'XMRUSDT', 'LITUSDT', 'PENGUUSDT', 'DOTUSDT', 'XLMUSDT', 'ARIAUSDT', 'QNTUSDT',
    'ONDOUSDT', 'SHELLUSDT', 'ZROUSDT', 'PAXGUSDT', 'PIEVERSEUSDT', 'VVVUSDT', 'TRXUSDT', 'APTUSDT', 'HBARUSDT', 'BTWUSDT',
    'FETUSDT', 'XAUTUSDT', '1000SHIBUSDT', 'BARDUSDT', 'IDOLUSDT', 'XPLUSDT', 'ONEUSDT', 'DODOXUSDT', 'FARTCOINUSDT', 'NIGHTUSDT',
    'JUPUSDT', 'STRKUSDT', 'ETCUSDT', 'MEGAUSDT', 'AGTUSDT', 'ICPUSDT', 'USELESSUSDT', 'TIAUSDT', 'ETHFIUSDT', 'OPUSDT',
    'BLESSUSDT', 'DASHUSDT', 'BERAUSDT', 'BULLAUSDT', 'CRVUSDT', '1000BONKUSDT', 'PONSUSDT', 'GRAMUSDT', 'WLFIUSDT', 'WIFUSDT',
    'MAGMAUSDT', 'UAIUSDT', 'RENDERUSDT', 'TACUSDT', 'AEROUSDT', 'ATOMUSDT', 'VIRTUALUSDT', 'SKYAIUSDT', 'JELLYJELLYUSDT', 'BANANAS31USDT',
    'PYTHUSDT', 'SEIUSDT', 'CAPUSDT', 'AINUSDT', 'HUSDT', 'PENDLEUSDT', 'ERAUSDT', 'GRASSUSDT', 'ORDIUSDT', 'LSKUSDT',
  ]),
});

/** Gerak awal candle sinyal i dalam ATR: (close[i] − close[i − look]) ÷ ATR[i] (LONG); null bila data kurang. */
export function preMoveAt(candles, atrValues, i, look = AL_SA_ATR_01.look) {
  const a = atrValues[i];
  if (!(a > 0) || i < look || i >= candles.length) return null;
  return (candles[i].close - candles[i - look].close) / a;
}

/**
 * R bersih trade (fee + slippage utama sudah di rMultiple runner) dikurangi funding, dan versi biaya stres.
 * Biaya runner proporsional terhadap (fee + slippage), jadi biaya stres = costR × (fee_s + slip_s) / (fee + slip).
 * @param {{ rMultiple: number, grossR: number, costR: number }} trade
 * @param {number} fundingR biaya funding dalam R (positif = LONG membayar)
 */
export function netOutcome(trade, fundingR, cfg = AL_SA_ATR_01) {
  const stressScale = (cfg.stressFeeBps + cfg.stressSlippageBps) / (cfg.feeBps + cfg.slippageBps);
  return { netR: trade.rMultiple - fundingR, stressR: trade.grossR - trade.costR * stressScale - fundingR };
}

/**
 * Kriteria keputusan docs/26 §5 (semua wajib). Urutan pembacaan: hash beda → TIDAK SAH; n kurang → TIDAK KONKLUSIF;
 * semua terpenuhi → LULUS; selain itu TIDAK LULUS.
 * @param {{ n: number, nRequired: number, main: {mean:number, lo:number}|null, diff: {diff:number, lo:number}|null,
 *   stressMean: number|null, hashesMatch: boolean }} input
 */
export function evaluateCriteria({ n, nRequired, main, diff, stressMean, hashesMatch }) {
  const P0 = Number.isInteger(nRequired) && n >= nRequired;
  const P1 = !!main && main.mean > 0 && main.lo > 0;
  const P2 = !!diff && diff.diff > 0 && diff.lo > 0;
  const P3 = Number.isFinite(stressMean) && stressMean > 0;
  const P4 = hashesMatch === true;
  let verdict = 'TIDAK LULUS';
  if (!P4) verdict = 'TIDAK SAH (kode berbeda dari commit beku)';
  else if (!P0) verdict = 'TIDAK KONKLUSIF (n kurang)';
  else if (P1 && P2 && P3) verdict = 'LULUS';
  return { P0, P1, P2, P3, P4, verdict };
}
