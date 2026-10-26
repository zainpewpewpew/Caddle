# Kontrak modul akurasi scanner v3 (LONG & SHORT)

Dokumen kerja untuk rombak akurasi scanner. Semua modul baru adalah **fungsi murni** (tanpa I/O, tanpa
`Date.now()`, tanpa acak kecuali PRNG berbenih yang disuntikkan), ES module, komentar & teks dalam bahasa
Indonesia, **tanpa dependensi npm baru**. Evaluasi selalu pada candle TERAKHIR array; tidak boleh memakai data
setelah indeks itu (anti lookahead). Swing hanya dipakai bila `confirmedIndex ≤ indeks evaluasi`
(`backend/indicators/swings.js`). Nilai yang tidak dapat dihitung = `null`, bukan 0 palsu.

Candle mengikuti `backend/market/contracts.js` (termasuk `takerBuyVolume` & `takerBuyQuoteVolume`; bisa 0 atau
tidak ada pada data lama → fitur order-flow mengembalikan `null`).

## Lapisan

```
candle ─► pola SA/PVA (LONG) & SD/PVD (SHORT)   (tetap, PATTERN_VERSION 2)
      └─► fitur v3 (backend/features/*)          (baru)
             marketStructure · orderFlow · regime · liquidity
      └─► konteks HTF (backend/timeframe)        (tetap)
                        │
                        ▼
      confluence (backend/scoring/confluence.js) → skor 0..100, tier A/B/C/D, konfirmasi, konflik, veto
                        │
                        ▼
      kalibrasi historis (backend/backtest/calibration.js) → peluang empiris + interval Wilson, atau null
```

## 1. `backend/features/marketStructure.js`

```js
analyzeMarketStructure(candles, { left = 2, right = 2, maxSwings = 12 } = {}) → {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  swings: [{ type: 'HIGH'|'LOW', label: 'HH'|'LH'|'HL'|'LL'|null, index, price, confirmedIndex }], // ≤ maxSwings terakhir, urut waktu
  counts: { HH, LH, HL, LL },                       // dalam swings di atas
  lastEvent: null | { type: 'BOS'|'CHOCH', direction: 'BULLISH'|'BEARISH', index, level, barsAgo },
  lastSwingHigh: number|null, lastSwingLow: number|null,
  structureScore: number,                          // -1..1, + = bullish
}
```
BOS = close menembus swing searah bias; CHOCH = close menembus swing berlawanan bias sebelumnya (perubahan karakter).

## 2. `backend/features/orderFlow.js`

```js
cvd(candles) → number[]                       // Σ (2·takerBuyVolume − volume); null per indeks bila taker tidak ada
obv(candles) → number[]
accumulationDistribution(candles) → number[]  // Chaikin A/D line
cmf(candles, period = 20) → (number|null)[]   // Chaikin Money Flow
analyzeOrderFlow(candles, { window = 20, divergenceLookback = 30 } = {}) → {
  takerBuyRatio: number|null,   // Σ takerBuy / Σ volume pada window, 0..1
  cvdSlope: number|null,        // ΔCVD window / Σ volume window, -1..1
  obvSlope: number|null,        // ΔOBV window / Σ volume window, -1..1
  cmf: number|null,             // -1..1
  adSlope: number|null,         // ΔA/D window / Σ volume window
  priceChange: number|null,     // close/close[window] − 1
  divergence: 'BULLISH' | 'BEARISH' | null,   // harga turun/datar tapi aliran naik (BULLISH) atau sebaliknya
  flowBias: number|null,        // -1..1 gabungan, + = tekanan beli
}
```

## 3. `backend/features/regime.js`

```js
adx(candles, period = 14) → { adx: (number|null)[], plusDi: [...], minusDi: [...] }   // Wilder
choppiness(candles, period = 14) → (number|null)[]                                     // 0..100
bollingerBandwidth(closes, period = 20, mult = 2) → (number|null)[]
efficiencyRatio(closes, period = 10) → (number|null)[]                                 // Kaufman, 0..1
analyzeRegime(candles, { percentileLookback = 120 } = {}) → {
  adx, plusDi, minusDi, chop, bandwidth, bandwidthPercentile /*0..1*/, squeeze: boolean, efficiencyRatio,
  regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'CHOPPY' | 'SQUEEZE' | null,
}
```

## 4. `backend/features/liquidity.js` (range Wyckoff & sapuan likuiditas)

```js
analyzeLiquidity(candles, { lookback = 48, sweepBars = 5 } = {}) → {
  rangeHigh, rangeLow, rangeWidthAtr, position /*0..1 posisi close dalam range*/, inRange: boolean,
  sweepLow: null | { index, level, reclaimed: boolean, barsAgo },   // low < swing low sebelumnya lalu close kembali di atasnya (spring)
  sweepHigh: null | { index, level, reclaimed: boolean, barsAgo },  // cermin (upthrust)
  climax: null | { type: 'SELLING'|'BUYING', index, volumeRatio, barsAgo },
  absorption: number|null,      // -1..1: volume tinggi tetapi range kecil di dekat low (+) / high (−)
}
```

## 5. `backend/scoring/confluence.js`

```js
computeConfluence({ direction, view, context, structure, orderFlow, regime, liquidity }, params?) → {
  version: 1,
  score: number,              // 0..100 (skor aturan, BUKAN probabilitas)
  tier: 'A' | 'B' | 'C' | 'D',
  components: [{ id, label, weight, value, contribution, passed }],
  confirmations: string[],    // kalimat bahasa Indonesia
  conflicts: string[],
  vetoes: string[],           // id veto; tier A/B mustahil bila ada veto
}
```
`view` = hasil `buildSignalView` (patternScore, earlyScore, classification, alignment, riskFlags). Semua fitur
direction-aware: untuk SHORT tanda dibalik (bias BEARISH = konfirmasi, flowBias negatif = konfirmasi, dst.).
Input fitur boleh `null` → komponen dilewati (tidak dihitung lulus).

## 6. Backtest & validasi (`backend/backtest/*`)

- `labeler.js` — `labelTrade({ candles, entryIndex, direction, entryPrice, stopPrice, targetR = 2, maxBars = 48 })`
  → `{ outcome: 'WIN'|'LOSS'|'TIMEOUT', exitIndex, exitPrice, rMultiple, mfeR, maeR, barsHeld }`. Triple barrier;
  bila TP & SL tersentuh di candle yang sama → asumsikan LOSS (konservatif). Entry = close candle sinyal.
- `metrics.js` — `wilsonInterval(k, n, z = 1.96)`, `summarize(trades)` → `{ n, wins, losses, timeouts, winRate,
  winRateCi: [lo, hi], expectancyR, profitFactor, avgMfeR, avgMaeR }`, `brierScore`, `groupBy`.
- `splits.js` — `walkForwardSplits(times, { folds, embargoBars })` (urut waktu, purging/embargo).
- `calibration.js` — `fitCalibration(samples /*{score, win}*/, { bins })` (PAV isotonik + Laplace) dan
  `applyCalibration(table, score)` → `{ probability, lower, upper, samples } | null`.
- `synthetic.js` — generator pasar sintetis berbenih (random walk, rezim tren, akumulasi/distribusi tertanam).
- `runner.js` — replay walk-forward memanggil `analyzeDirectionsAt` + fitur + confluence, menghasilkan trade.
- `scripts/backtest.js` — CLI (Binance REST di Mac, cache disk, atau CSV) → laporan `reports/backtest-*.md|json`.

## Kejujuran

Skor & tier adalah aturan yang dapat dijelaskan. Angka "peluang" hanya ditampilkan bila berasal dari kalibrasi
backtest out-of-sample dengan jumlah sampel memadai, selalu bersama interval kepercayaan. Hasil pada data
sintetis hanya membuktikan mekanisme (tanpa lookahead, metrik benar), bukan akurasi pasar nyata.
