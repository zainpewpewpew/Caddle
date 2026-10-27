# 19 — Kontrak "Reversal Radar": deteksi dini potensi reversal bullish di LONG Scanner

Status: kontrak implementasi (2026-10-26). Mengikat modul yang dikembangkan paralel. Semua waktu epoch ms UTC.
Latar riset & keputusan metode: [20 — riset deteksi dini reversal](20-riset-deteksi-dini-reversal.md).

## 0. Ringkasan keputusan

| Hal | Keputusan |
|---|---|
| Lingkup | Hanya LONG Scanner. SHORT Scanner (SD/PVD, 1h) **tidak disentuh**. Pipeline SA/PVA LONG 15m tetap berjalan (Signal History, Symbol Intelligence, Overview tidak berubah). |
| Mesin baru | `backend/reversal/*` — mesin TERPISAH dari `backend/patterns` & `backend/signals`: fungsi murni, tanpa I/O, anti-lookahead. Versi metodologi `REVERSAL_VERSION = 1`. |
| Timeframe | `REVERSAL_TIMEFRAMES = ['5m', '15m', '1h']`, dievaluasi **terpisah** per timeframe; konteks HTF: 5m → 15m & 1h, 15m → 1h, 1h → tidak ada (`htf.trend = null`). Worker kembali mengingesti 5m. `DIRECTION_TIMEFRAMES` (LONG 15m / SHORT 1h untuk SA/PVA & SD/PVD) **tidak berubah**. |
| Tahap (`stage`) | `EARLY_FORMATION` → `DEVELOPING_REVERSAL` → `CONFIRMED_BREAKOUT` (hanya maju; boleh melompat). |
| Status (`status`) | `NEW` (baru), `DEVELOPING` (berkembang), `CONFIRMED` (terkonfirmasi), `CANCELLED` (batal), `EXPIRED` (kedaluwarsa). `OPEN_STATUSES = ['NEW','DEVELOPING','CONFIRMED']`. Status mengikuti tahap: masuk EARLY → NEW; masuk DEVELOPING → DEVELOPING; masuk CONFIRMED → CONFIRMED; batal/kedaluwarsa = terminal (kandidat ditutup, kandidat berikutnya = baris baru). |
| Candle berjalan | Evaluasi provisional (candle belum tutup) disimpan TERPISAH (`reversal_provisional`), selalu berlabel `provisional: true`, tidak pernah membuka/menutup kandidat, tidak pernah mencatat event tutup-candle. Event provisional hanya dicatat saat tahap provisional berubah (anti-spam). |
| Skor | `score` 0–100 = jumlah poin komponen aturan (dapat dijelaskan). **Bukan probabilitas**. Tidak ada klaim peluang. |
| Sensitivitas | Mesin selalu mengevaluasi dengan ambang paling permisif yang stabil (`HIGH`). `LOW`/`MEDIUM`/`HIGH` di API/UI adalah **filter tampilan** (skor & jumlah bukti minimum), bukan parameter mesin, sehingga histori tidak bergantung pilihan UI. |
| Anti-kedip | Histeresis: masuk tahap butuh kondisi terpenuhi pada `enterConfirmBars` candle tutup berurutan (5m: 2, 15m: 1, 1h: 1); keluar hanya lewat CANCELLED (close < level invalidasi, bukan wick) atau EXPIRED (tanpa kemajuan `expiryBars` / bukti melemah `weakBars` berturut-turut). Tidak ada downgrade tahap. |
| Extended | `moveSinceDetectionAtr = (close − firstDetectedPrice) / firstDetectedAtr`; `extended = moveSinceDetectionAtr ≥ 2.5` atau `moveSinceDetectionPct ≥ 0.08`. Ditandai, tidak dibuang. `LATE_ENTRY` bila saat deteksi pertama `(close − bottom)/ATR ≥ 4`. |
| Kelanjutan uptrend | `context.classification = 'CONTINUATION'` (EMA25 naik & tidak ada penurunan awal) → **bukan** kandidat reversal (tidak dibuka). |
| Tanpa eksekusi | Tidak ada perintah entry/exit; teks UI hanya menyatakan bukti, kondisi berikutnya, dan pembatalan. |
| Posisi produk (2026-10-27) | **Pelabel struktur, bukan prediksi** — keputusan pengguna setelah tiga run data nyata (docs/21 §6.6–§6.9, §7): tahap, bukti, level, dan invalidasi dijelaskan apa adanya; tidak ada klaim lebih awal atau lebih akurat dari SA/PVA, dan rasio keberhasilan kandidat setara entri acak pada penghalang yang sama. Satu uji luar sampel terakhir (§10, T-NYATA-4/5) hanya dapat menambah label "didukung satu uji luar sampel" pada sel yang lulus — **dijalankan 2026-10-27 (Binance Jun–Okt 2026, 20 simbol; docs/21 §6.10): kedua sel TIDAK terpenuhi, tidak ada label, validasi ditutup tanpa uji lanjutan.** |

## 1. Modul & kepemilikan

| Modul | Isi | Agent |
|---|---|---|
| `backend/indicators/rsi.js` | RSI Wilder (`rsi(closes, period=14)` → array, null saat warm-up) | A |
| `backend/reversal/params.js` | `DEFAULT_REVERSAL_PARAMS`, `resolveReversalParams(overrides, timeframe)`, `SENSITIVITY_FILTERS` | A |
| `backend/reversal/features.js` | fitur per seri (swing, lower-low depth, kurva kuadrat, kontraksi, divergensi, dsb.) | A |
| `backend/reversal/detector.js` | `evaluateReversal(input)` → `ReversalEvaluation` (§3) | A |
| `backend/reversal/stateMachine.js` | `transitionReversal(prev, input)` → `{ next, events, alert }` (§4) | A |
| `backend/reversal/index.js` | re-export konstanta (§2), params, detector, state machine | A |
| `backend/database/migrations/008_reversal_radar.sql` | tabel §5 | B |
| `backend/reversal/repository.js` | `createReversalRepository(db, { clock })` (§5) | B |
| `backend/reversal/pipeline.js` | `createReversalPipeline(deps)` (§6): replay dari kursor, provisional, alert | B |
| `backend/api/reversalRoutes.js` | `GET /api/reversal/candidates`, `GET /api/reversal/history`, `GET /api/reversal/candidates/:id` (§7) | B |
| `worker/assemble.js`, `worker/scanner.js`, `backend/app/buildApp.js`, `backend/database/repositories/index.js` | ingest 5m, hook provisional, registrasi route & repo | B |
| `frontend/js/views/reversalRadar.js`, `reversalFormat.js`, `screener.js` (LONG), `frontend/css/reversal.css`, `index.html` | UI §8 | C |
| `tests/e2e/reversal.spec.js` | E2E UI (mock API via `page.route` + 1 tes server seeded setelah integrasi) | C (+ integrator) |
| `backend/reversal/replay.js`, `scripts/reversal-replay.js`, `tests/fixtures/candles/reversalScenarios.js`, `docs/21-validasi-reversal-radar.md` | replay berurutan, perbandingan lama vs baru, metrik, CLI (§9) | D |
| `docs/20-riset-deteksi-dini-reversal.md` | riset & alasan metode | integrator |

Aturan umum (sama dengan docs/07): modul domain = fungsi murni (tanpa `Date.now()`, tanpa I/O); hanya candle `isClosed: true` untuk hasil non-provisional; swing hanya dipakai bila `confirmedIndex ≤ indeks evaluasi`; nilai yang tidak terhitung = `null`, bukan 0 palsu. Semua teks UI/komentar/dok dalam bahasa Indonesia. Tidak ada dependensi npm baru.

## 2. Konstanta (`backend/reversal/index.js`)

```js
export const REVERSAL_VERSION = 1;
export const REVERSAL_TIMEFRAMES = Object.freeze(['5m', '15m', '1h']);
export const STAGES = Object.freeze(['EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT']);
export const STAGE_RANK = Object.freeze({ EARLY_FORMATION: 1, DEVELOPING_REVERSAL: 2, CONFIRMED_BREAKOUT: 3 });
export const STATUSES = Object.freeze(['NEW', 'DEVELOPING', 'CONFIRMED', 'CANCELLED', 'EXPIRED']);
export const OPEN_STATUSES = Object.freeze(['NEW', 'DEVELOPING', 'CONFIRMED']);
export const TERMINAL_STATUSES = Object.freeze(['CANCELLED', 'EXPIRED']);
export const STATUS_OF_STAGE = Object.freeze({ EARLY_FORMATION: 'NEW', DEVELOPING_REVERSAL: 'DEVELOPING', CONFIRMED_BREAKOUT: 'CONFIRMED' });
export const SETUP_TYPES = Object.freeze(['ROUNDED_BOTTOM', 'DOUBLE_BOTTOM', 'HIGHER_LOW_BASE', 'STAIRCASE', 'SPRING', 'DIVERGENCE_BOTTOM', 'COMPRESSION']);
export const CLASSIFICATIONS = Object.freeze(['REVERSAL_CANDIDATE', 'CONTINUATION', 'NO_SETUP', 'INSUFFICIENT_DATA', 'DATA_QUALITY']);
export const EVIDENCE_GROUPS = Object.freeze(['EXHAUSTION', 'BASE', 'STRUCTURE', 'VOLUME', 'TRIGGER']);
export const EVIDENCE_IDS = Object.freeze([
  // EXHAUSTION — tekanan turun melemah
  'LL_SHALLOWER', 'LL_STOPPED', 'BOTTOM_HELD', 'DOWN_MOMENTUM_FADING', 'RSI_DIVERGENCE', 'CVD_DIVERGENCE',
  // BASE — dasar & kompresi
  'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'RANGE_CONTRACTION', 'ROUNDED_BOTTOM', 'RISING_FLOOR',
  // STRUCTURE — perubahan struktur minor
  'HIGHER_LOW', 'SPRING_RECLAIM', 'EMA25_RECLAIM', 'EMA7_TURN_UP', 'CHOCH_BULLISH', 'STAIRCASE',
  // VOLUME — karakter volume
  'VOLUME_DRY_UP', 'QUIET_RISE',
  // TRIGGER — pemicu
  'TRIGGER_BREAK', 'BREAK_VOLUME_SUPPORT', 'BREAK_FOLLOW_THROUGH',
]);
export const RISKS = Object.freeze([
  'HTF_DOWNTREND', 'HTF_UNKNOWN', 'LOW_LIQUIDITY', 'ILLIQUID', 'EXTENDED', 'LATE_ENTRY', 'VOLATILITY_EXPANDING',
  'NO_VOLUME_SUPPORT', 'NEAR_INVALIDATION', 'DATA_QUALITY', 'PROVISIONAL',
]);
export const LIQUIDITY_CLASSES = Object.freeze(['LIQUID', 'THIN', 'ILLIQUID', 'UNKNOWN']);
export const SENSITIVITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
export const CANCEL_REASONS = Object.freeze(['CLOSE_BELOW_INVALIDATION', 'BREAKOUT_FAILED', 'NO_PROGRESS', 'EVIDENCE_FADED', 'SYMBOL_DELISTED', 'MONITORING_STOPPED']);
export const EVENT_TYPES = Object.freeze(['OPENED', 'STAGE_UP', 'CANCELLED', 'EXPIRED', 'PROVISIONAL_STAGE']);
export const MARKER_KINDS = Object.freeze(['BOTTOM', 'LOWER_LOW', 'HIGHER_LOW', 'SPRING', 'CHOCH', 'TRIGGER', 'DIVERGENCE', 'DETECTED', 'STAGE_UP', 'CANCELLED']);
```

## 3. Detektor — `evaluateReversal(input)` (`backend/reversal/detector.js`)

```js
evaluateReversal({
  candles,                 // Candle[] satu simbol × timeframe, urut naik; candle terakhir = titik evaluasi.
                           // provisional=true: candle terakhir boleh isClosed=false (candle berjalan).
  timeframe,               // '5m' | '15m' | '1h' (wajib, menentukan parameter per timeframe)
  higher = {},             // { '15m'?: Candle[], '1h'?: Candle[] } hanya candle dengan closeTime ≤ closeTime candle evaluasi
  liquidity,               // { quoteVolume24h?: number|null, spreadBps?: number|null, thresholds?: { minQuoteVolume24h, maxSpreadBps } } | undefined
  provisional = false,
  params,                  // override parsial DEFAULT_REVERSAL_PARAMS (resolveReversalParams)
}) → ReversalEvaluation
```

`REVERSAL_LOOKBACK = 300` (candle yang dimuat pemanggil). Warm-up minimum `requiredCandles(params) ≤ 150` → di bawahnya `classification: 'INSUFFICIENT_DATA'`. Kualitas data mengikuti `inspectCandles` (gap waktu, volume nol beruntun, candle rusak) → `classification: 'DATA_QUALITY'` + risk `DATA_QUALITY`; **kecuali** bila sufiks candle yang bersih (setelah kerusakan terakhir, `features.cleanSuffixStart`) masih ≥ warm-up: evaluasi memakai sufiks itu, `measures.candlesDropped` mencatat jumlah candle yang dibuang, dan risk `DATA_QUALITY` tetap dilaporkan (satu candle rusak/gap lama tidak membutakan seri selama 300 candle — docs/21 §3 usulan e). Candle terakhir `isClosed !== true` saat `provisional=false` → `RangeError`.

```ts
ReversalEvaluation = {
  version: 1, timeframe, provisional: boolean,
  candleOpenTime: number, evaluatedAt: number,            // openTime & closeTime candle terakhir
  classification: 'REVERSAL_CANDIDATE'|'CONTINUATION'|'NO_SETUP'|'INSUFFICIENT_DATA'|'DATA_QUALITY',
  stage: 'EARLY_FORMATION'|'DEVELOPING_REVERSAL'|'CONFIRMED_BREAKOUT'|null,   // tahap yang BUKTINYA terpenuhi pada candle ini (belum histeresis)
  setupType: string|null, setupTypes: string[],           // utama + semua yang cocok (SETUP_TYPES)
  context: {
    priorDecline: { ok: boolean, declinePct: number|null, declineAtr: number|null, highIndex: number|null, bottomIndex: number|null,
                    bottomPrice: number|null, barsSinceBottom: number|null, ema25Falling: boolean|null },
    htf: { timeframe: string|null, trend: 'BULLISH'|'BEARISH'|'NEUTRAL'|null, detail: string },
    liquidityClass: 'LIQUID'|'THIN'|'ILLIQUID'|'UNKNOWN',
  },
  checks: Array<{ id, group, label, detail, passed: boolean, value: number|null, threshold: number|null, weight: number,
                  index: number|null, time: number|null, price: number|null }>,   // SEMUA pemeriksaan (deterministik, urutan EVIDENCE_IDS)
  evidence: Array<check>,                                  // checks.filter(passed)
  evidenceCount: number,
  score: { total: number /* 0..100 bulat */, components: Array<{ id: EVIDENCE_GROUP, label, points, max }> },
  levels: { bottom, lastSwingLow, higherLow, trigger, ema25, ema7, atr, invalidation },  // number|null, harga nyata
  nextConfirmation: { kind: 'HIGHER_LOW'|'EMA25_RECLAIM'|'TRIGGER_BREAK'|'HOLD_ABOVE_TRIGGER'|'NONE', text: string, level: number|null },
  cancelCondition: { text: string, level: number|null },   // level = levels.invalidation
  risks: string[],                                         // subset RISKS, urut RISKS
  markers: Array<{ time: number /* openTime */, kind: MARKER_KIND, price: number|null, label: string }>,
  measures: Record<string, number|null>,                   // angka mentah untuk laporan replay (rsi, atrRatio, dst.)
}
```

### 3.1 Aturan deteksi (parameter default di `params.js`; semua boleh di-override; nilai = hipotesis awal yang WAJIB divalidasi replay)

Fitur (dari candle tertutup, indeks terakhir `L`): EMA7/EMA25 (`indicators/ema`), ATR14 Wilder, RVOL20, RSI14, swing fraktal 2-2 terkonfirmasi (`indicators/swings`), struktur BOS/CHoCH (`features/marketStructure`), bandwidth Bollinger & squeeze (`features/regime`), divergensi CVD/OBV (`features/orderFlow.analyzeOrderFlow().divergence`), sapuan/spring (`features/liquidity` atau implementasi sendiri yang kausal).

**A. Konteks penurunan awal (prasyarat reversal, membedakan dari kelanjutan uptrend)**
- `bottomIndex` = indeks low terendah pada `bottomLookback` (60) candle terakhir; `highIndex` = indeks close tertinggi pada `declineLookback` (120) candle SEBELUM/sampai bottom.
- `priorDecline.ok` bila `declineAtr = (closeTertinggi − bottomLow) / ATR(bottom) ≥ minDeclineAtr` (3) **atau** `declinePct ≥ minDeclinePct` (0.06), **dan** `barsSinceBottom ≥ minBottomAge` (5; semula 3, disetel di docs/21 §3 — dasar harus bertahan ≥ 5 candle sebelum disebut "lower low berhenti"), **dan** tidak ada close < bottomLow sesudah bottom (bottom belum ditembus close).
- `CONTINUATION` bila `priorDecline.ok === false` **dan** EMA25 naik (slope ≥ 0 selama `slopeLookback`) **dan** close > EMA25. Selain itu tanpa penurunan awal → `NO_SETUP`.

**B. EXHAUSTION (maks 25 poin)**
- `LL_SHALLOWER` (8): ≥ 2 lower-low swing berurutan, kedalaman (prevLow − low)/ATR terakhir ≤ 0,7 × kedalaman sebelumnya **atau** ≤ 0,5 ATR.
- `LL_STOPPED` (6): tidak ada swing low baru di bawah bottom selama ≥ `llStoppedBars` (8) candle sejak bottom, dan close saat ini > bottom.
- `BOTTOM_HELD` (7): sesudah bottom ada candle yang low-nya kembali ke ≤ bottom + 0,5 ATR (retest) lalu close ≥ bottom + 0,25 ATR (double bottom / dasar bertahan). `index` = candle retest.
- `DOWN_MOMENTUM_FADING` (5): rata-rata body candle merah 10 candle terakhir ≤ 0,7 × rata-rata 10 candle sebelumnya **dan** porsi volume candle merah 10 terakhir ≤ 0,55.
- `RSI_DIVERGENCE` (8): dua swing low terkonfirmasi terakhir: harga lower low, RSI14 higher low (selisih ≥ 2 poin). `index` = swing low terakhir.
- `CVD_DIVERGENCE` (5): `analyzeOrderFlow(candles).divergence === 'BULLISH'`.
Skor grup = min(25, jumlah poin).

**C. BASE (maks 25 poin)**
- `ATR_CONTRACTION` (6): ATR14[L] / ATR14[L − 20] ≤ 0,8.
- `EMA_CONVERGENCE` (6): |EMA7 − EMA25| / ATR ≤ 1,0 **dan** lebih kecil dari 10 candle lalu.
- `RANGE_CONTRACTION` (5): (max high − min low) 20 candle terakhir ≤ 0,75 × 20 candle sebelumnya **atau** `regime.squeeze === true`.
- `ROUNDED_BOTTOM` (8): fit kuadrat close pada `bowlWindow` (40) candle: koefisien `a > 0`, R² ≥ 0,6, titik vertex di dalam 15–85 % jendela, close saat ini ≥ nilai kurva di vertex + 0,3 ATR → "dasar membulat".
- `RISING_FLOOR` (7): range 30 candle terakhir ≤ 4 ATR **dan** regresi harga swing low (≥ 3 swing low terakhir) naik (slope > 0,05 ATR/candle) → "sideways dengan dasar makin tinggi".

**D. STRUCTURE (maks 30 poin)**
- `HIGHER_LOW` (10): ≥ 1 higher low terkonfirmasi setelah bottom yang masih utuh (tidak ada low sesudahnya di bawahnya — aturan audit PR #19).
- `SPRING_RECLAIM` (6): wick menembus swing low terkonfirmasi sebelumnya ≤ 3 candle lalu dan close saat ini kembali di atasnya, volume candle sapuan ≤ 1,5 × rata-rata.
- `EMA25_RECLAIM` (6): close > EMA25 dan ada close ≤ EMA25 dalam 10 candle sebelumnya (baru merebut EMA25).
- `EMA7_TURN_UP` (4): slope EMA7 (5 titik) > 0 dan EMA7 ≥ EMA25 − 0,5 ATR.
- `CHOCH_BULLISH` (8): `analyzeMarketStructure(candles).lastEvent` = `{ type: 'CHOCH', direction: 'BULLISH' }` dengan `barsAgo ≤ 10`, atau close > lower high terkonfirmasi terakhir sejak bottom.
- `STAIRCASE` (6): ≥ 2 higher low **dan** ≥ 2 higher high berurutan pada swing sejak bottom, tiap kaki naik ≤ 2 ATR.

**E. VOLUME (maks 10 poin)**
- `VOLUME_DRY_UP` (5): rata-rata volume 10 candle terakhir ≤ 0,7 × rata-rata 30 candle sebelumnya (supply mengering) — **bukan** bukti bila `liquidityClass === 'ILLIQUID'`.
- `QUIET_RISE` (5): close naik 0 < Δ ≤ 2 ATR dalam 10 candle **dan** rata-rata RVOL 10 candle ≤ 1,0.

**F. TRIGGER (maks 10 poin, hanya untuk CONFIRMED)**
- `levels.trigger` = **puncak range sejak bottom**: high tertinggi dari candle bottom sampai candle SEBELUM evaluasi (resistance range akumulasi Wyckoff / automatic rally). Semula "swing high terkonfirmasi terakhir dinaikkan ke high sesudahnya" — diganti karena lower high di dalam range menjadi pemicu yang terlalu rendah ("CONFIRMED sesaat", docs/21 §2.7). `markers` tetap memuat swing high terkonfirmasi terakhir sejak bottom bila ada.
- `TRIGGER_BREAK` (4): close > trigger **dan** pemicu bermakna: `(trigger − bottom)/ATR ≥ minTriggerAboveBottomAtr` (1,5 — ada rally yang layak ditembus) **dan** `barsSinceBottom ≥ minBaseBarsForTrigger` (8 — penembusan beberapa candle setelah low adalah pantulan V, bukan keluar dari base). Keduanya disetel di docs/21 §3.
- `BREAK_VOLUME_SUPPORT` (3): RVOL candle ≥ `breakRvol` (1,5).
- `BREAK_FOLLOW_THROUGH` (3): close > trigger pada 2 candle tutup berurutan, atau close ≥ trigger + 0,3 ATR.

**Tahap pada evaluasi (sebelum histeresis state machine):**
- prasyarat: `classification === 'REVERSAL_CANDIDATE'` (A ok, data cukup & sehat).
- `EARLY_FORMATION`: jumlah bukti EXHAUSTION+BASE+VOLUME ≥ `minEarlyEvidence` (2), berasal dari ≥ `minEarlyGroups` (2) grup BERBEDA di antara EXHAUSTION/BASE/VOLUME (dua bukti segrup — mis. BOTTOM_HELD + RSI_DIVERGENCE pada setiap pantulan downtrend — tidak cukup; docs/21 §2.7), dan setidaknya 1 dari grup EXHAUSTION atau BASE.
- `DEVELOPING_REVERSAL`: syarat EARLY **dan** ≥ 1 bukti STRUCTURE **dan** total bukti ≥ 3.
- `CONFIRMED_BREAKOUT`: `TRIGGER_BREAK` **dan** (`BREAK_VOLUME_SUPPORT` atau `BREAK_FOLLOW_THROUGH`) **dan** total bukti (tanpa TRIGGER) ≥ 2.
- `stage = null` bila tidak ada yang terpenuhi.

**setupType** (urutan prioritas, yang pertama cocok = utama): `SPRING` (SPRING_RECLAIM), `DOUBLE_BOTTOM` (BOTTOM_HELD), `ROUNDED_BOTTOM`, `STAIRCASE`, `HIGHER_LOW_BASE` (RISING_FLOOR atau HIGHER_LOW), `DIVERGENCE_BOTTOM` (RSI/CVD), `COMPRESSION` (ATR/RANGE/EMA). `setupTypes` = semua yang cocok.

**Skor** `score.total` = Σ poin grup (maks 25+25+30+10+10 = 100). Komponen selalu 5 entri (poin 0 bila tidak ada).

**Risiko**: `HTF_DOWNTREND` bila tren HTF BEARISH (EMA25 HTF turun & close HTF < EMA25 HTF — fungsi `trend` di `backend/timeframe/trend.js` boleh dipakai); `HTF_UNKNOWN` bila timeframe tanpa HTF (1h) atau data HTF belum cukup; `LOW_LIQUIDITY` (THIN) / `ILLIQUID`; `EXTENDED`, `LATE_ENTRY` (diisi state machine/evaluasi dari firstDetected; evaluasi tunggal memakai bottom: `(close − bottom)/ATR ≥ lateAtr` (4) → `LATE_ENTRY`); `VOLATILITY_EXPANDING` (ATR/median ATR 50 ≥ 1,5); `NO_VOLUME_SUPPORT` (stage CONFIRMED tanpa BREAK_VOLUME_SUPPORT); `NEAR_INVALIDATION` (close − invalidation ≤ 0,5 ATR); `DATA_QUALITY`; `PROVISIONAL` (saat provisional=true).

**Kelas likuiditas**: `thresholds.minQuoteVolume24h` (default 50 000 000) → `quoteVolume24h ≥ ambang` = LIQUID; `≥ 0,25 × ambang` = THIN; di bawahnya ILLIQUID; tanpa data → UNKNOWN, lalu fallback rata-rata quote volume per candle: `< minAvgQuoteVolume` (parameter per timeframe: 5m 20 000, 15m 60 000, 1h 240 000 USDT) → ILLIQUID.

**Level**: `bottom` = low bottom; `lastSwingLow` = swing low terkonfirmasi terakhir; `higherLow` = swing low terakhir bila higher low; `invalidation = min(bottom, lastSwingLow) − invalidationBufferAtr (0,25) × ATR` (harus > 0 dan < close, selain itu null); untuk stage CONFIRMED `invalidation = max(invalidation, trigger − failedBreakAtr (0,75) × ATR)` (breakout gagal).

**nextConfirmation**: EARLY → `HIGHER_LOW` ("Higher low terkonfirmasi di atas <lastSwingLow>") bila belum ada, atau `EMA25_RECLAIM` ("Close di atas EMA25 <ema25>"); DEVELOPING → `TRIGGER_BREAK` ("Close di atas level pemicu <trigger> dengan RVOL ≥ 1,5 atau dua close berurutan"); CONFIRMED → `HOLD_ABOVE_TRIGGER` ("Bertahan di atas <trigger> saat retest"); tanpa stage → `NONE`.

**markers** (bukti untuk mini-chart): BOTTOM (bottomIndex), LOWER_LOW/HIGHER_LOW (swing low sejak bottom), SPRING (candle sapuan), CHOCH (candle break), DIVERGENCE (swing low RSI), TRIGGER (level, time = candle evaluasi). Semua `time` = openTime candle.

### 3.2 Anti-lookahead & stabilitas prefiks
Untuk setiap `k`, `evaluateReversal({ candles: c.slice(0, k+1) })` harus identik dengan hasil replay pada candle `k`. Swing memakai `confirmedIndex ≤ L` (deteksi swing tertunda 2 candle — ini waktu deteksi yang jujur). Tes wajib: hasil pada prefiks tidak berubah saat candle masa depan ditambahkan.

## 4. State machine — `transitionReversal(prev, input, params)` (`backend/reversal/stateMachine.js`)

```js
transitionReversal(prev /* ReversalSnapshot|null */, {
  candle,            // candle tertutup (isClosed true) yang dievaluasi
  evaluation,        // ReversalEvaluation (provisional=false) pada candle ini
  timeframe,
}, params) → { next: ReversalSnapshot, events: ReversalEvent[], alert: boolean }
```

```ts
ReversalSnapshot = {
  version: 1, timeframe, stage: STAGE|null, status: STATUS|'NONE',
  setupType, setupTypes, classification,
  firstDetectedAt, firstDetectedPrice, firstDetectedAtr, firstStage,     // saat kandidat dibuka (closeTime, close, ATR)
  stageEnteredAt, barsInStage, barsSinceDetection,
  lastCandleTime /* openTime */, lastEvaluatedAt /* closeTime */,
  score, scoreComponents, evidence /* id[] */, evidenceCount, levels, nextConfirmation, cancelCondition, risks, liquidityClass, markers,
  peakPrice, peakStage, moveSinceDetectionPct, moveSinceDetectionAtr, extended: boolean,
  pendingStage: STAGE|null, pendingBars: number,     // histeresis masuk/naik tahap
  weakBars: number,                                  // candle berurutan tanpa bukti cukup (untuk EVIDENCE_FADED)
  closeReason: CANCEL_REASON|null,
}
ReversalEvent = {
  type: EVENT_TYPE, fromStage, toStage, fromStatus, toStatus, candleTime /* openTime */, occurredAt /* closeTime */,
  price, reason: string|null, provisional: false, detail: object   // detail: score, evidence, levels saat event
}
```

Aturan (urut diperiksa per candle BARU — `candle.openTime > prev.lastCandleTime`; candle lama/duplikat → `{ next: prev, events: [], alert: false }`):
1. Tanpa kandidat terbuka (`prev` null / status terminal / 'NONE'): bila `evaluation.stage !== null` → `pendingStage/pendingBars` bertambah; saat `pendingBars ≥ enterConfirmBars[timeframe]` (5m 2, 15m 1, 1h 1) kandidat DIBUKA: status = `STATUS_OF_STAGE[stage]`, event `OPENED` (reason `STAGE_EVIDENCE`), `alert = true`. Bila close ≤ levels.invalidation → tidak dibuka. `extended` dihitung 0 saat buka; `LATE_ENTRY` dari evaluasi dibawa ke `risks`.
2. Kandidat terbuka: `CANCELLED` bila `close < snapshot.levels.invalidation` (reason `CLOSE_BELOW_INVALIDATION`; untuk CONFIRMED juga `BREAKOUT_FAILED` bila close < trigger − failedBreakAtr × ATR). Event `CANCELLED`, status terminal, `closeReason`. Alert bila stage sebelumnya ≥ DEVELOPING.
3. Naik tahap bila `STAGE_RANK[evaluation.stage] > STAGE_RANK[stage]` selama `enterConfirmBars` candle berurutan (pending) → event `STAGE_UP`, status mengikuti, `barsInStage = 0`, `alert = true`. Tidak ada downgrade.
4. `EXPIRED` bila `barsInStage ≥ expiryBars[stage]` (EARLY 48, DEVELOPING 36, CONFIRMED 24) → reason `NO_PROGRESS`; atau `weakBars ≥ weakBarsLimit` (6) ketika `evaluation.stage === null` dan `evaluation.classification !== 'REVERSAL_CANDIDATE'` berturut-turut → reason `EVIDENCE_FADED`. Tidak di-alert.
5. Selain itu snapshot diperbarui (score, evidence, levels — `invalidation` hanya boleh NAIK; `trigger` boleh berubah; `peakPrice = max(peak, high)`; `moveSinceDetection*`; `extended`; `risks` + `EXTENDED` bila extended), tanpa event.
6. Gap data: `barsElapsed` dari selisih openTime (sama seperti `signals/stateMachine`); event membawa `detail.gapBars` bila > 1.

Alert hanya pada `OPENED`, `STAGE_UP`, dan `CANCELLED` dari tahap ≥ DEVELOPING (tidak pernah dua kali untuk tahap yang sama → tanpa notifikasi duplikat).

## 5. Persistensi (migrasi `008_reversal_radar.sql`, `backend/reversal/repository.js`)

```sql
CREATE TABLE reversal_candidates (
  id INTEGER PRIMARY KEY, symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('5m','15m','1h')), version INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('EARLY_FORMATION','DEVELOPING_REVERSAL','CONFIRMED_BREAKOUT')),
  status TEXT NOT NULL CHECK (status IN ('NEW','DEVELOPING','CONFIRMED','CANCELLED','EXPIRED')),
  setup_type TEXT, score REAL NOT NULL CHECK (score BETWEEN 0 AND 100),
  first_detected_at INTEGER NOT NULL, first_detected_price REAL NOT NULL CHECK (first_detected_price > 0), first_detected_atr REAL,
  stage_entered_at INTEGER NOT NULL, last_candle_time INTEGER NOT NULL, last_evaluated_at INTEGER NOT NULL,
  invalidation_price REAL, trigger_price REAL, extended INTEGER NOT NULL DEFAULT 0, liquidity_class TEXT,
  snapshot_json TEXT NOT NULL, close_reason TEXT, closed_at INTEGER, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_reversal_one_open ON reversal_candidates(symbol_id, timeframe) WHERE closed_at IS NULL;
CREATE INDEX idx_reversal_first_detected ON reversal_candidates(first_detected_at);
CREATE INDEX idx_reversal_symbol_first ON reversal_candidates(symbol_id, first_detected_at);
CREATE TABLE reversal_events (
  id INTEGER PRIMARY KEY, candidate_id INTEGER NOT NULL REFERENCES reversal_candidates(id) ON DELETE CASCADE,
  occurred_at INTEGER NOT NULL, candle_time INTEGER NOT NULL, type TEXT NOT NULL,
  from_stage TEXT, to_stage TEXT, from_status TEXT, to_status TEXT, price REAL,
  provisional INTEGER NOT NULL DEFAULT 0, detail_json TEXT
) STRICT;
CREATE INDEX idx_reversal_events_candidate ON reversal_events(candidate_id, candle_time);
CREATE TABLE reversal_cursors (
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE, timeframe TEXT NOT NULL,
  last_open_time INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (symbol_id, timeframe)
) STRICT, WITHOUT ROWID;
CREATE TABLE reversal_provisional (
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE, timeframe TEXT NOT NULL,
  candle_open_time INTEGER NOT NULL, evaluated_at INTEGER NOT NULL, stage TEXT, score REAL, snapshot_json TEXT NOT NULL,
  PRIMARY KEY (symbol_id, timeframe)
) STRICT, WITHOUT ROWID;
```

Repositori (`createReversalRepository(db, { clock })`, semua async, SQL statis terikat parameter):
- `getOpen({ symbol, timeframe })` → snapshot (+ `id`) atau null.
- `save({ symbol, timeframe, snapshot, events })` → `{ id, opened, closed, saved }` dalam satu transaksi; event `OPENED` → INSERT; lainnya → UPDATE baris terbuka; status terminal → `closed_at`, `close_reason`; kursor maju (`reversal_cursors`) dalam transaksi yang sama; `STATE_CHANGE_WITHOUT_EVENT` ditolak seperti signalRepository.
- `markEvaluated({ symbol, timeframe, openTime, now })`, `lastEvaluatedCandleTime({ symbol, timeframe })`.
- `setProvisional({ symbol, timeframe, evaluation, previousStage })` → upsert `reversal_provisional`; bila kandidat terbuka ada dan `evaluation.stage` berbeda dari tahap provisional sebelumnya → INSERT `reversal_events` dengan `provisional = 1`, `type = 'PROVISIONAL_STAGE'`. `clearProvisional({ symbol, timeframe })` saat candle tutup.
- `listActive({ timeframe = null, stage = null, status = null, liquidity = null /* 'LIQUID'|'THIN' = minimum kelas */, minScore = null, includeExtended = true, includeProvisional = true, limit = 200 })` → baris terbuka (status OPEN) + kolom `provisional` (dari `reversal_provisional`, atau null) + kandidat **provisional-only** (ada di `reversal_provisional` dengan `stage !== null` tanpa baris terbuka; `provisionalOnly: true`, `id: null`). Urutan: `STAGE_RANK` naik? **Tidak** — API mengembalikan semua dan UI mengelompokkan per tahap; urutan default `score DESC, first_detected_at DESC`.
- `history({ symbol = null, timeframe = null, limit = 100 })` → baris (terbuka & tertutup) + `events` (termasuk provisional, ditandai).
- `getById(id)` → baris + events.
- `listOpenSeries()`, `closeOpenForSymbol({ symbol, timeframes, reason, at })` (reason `SYMBOL_DELISTED`/`MONITORING_STOPPED`, event `EXPIRED`).

Bentuk baris API (`toView`): `{ id, symbol, timeframe, version, stage, status, setupType, setupTypes, score, scoreComponents, evidence: [{ id, label, detail, group, time, price }], evidenceCount, firstDetectedAt, firstDetectedPrice, firstDetectedAtr, stageEnteredAt, lastCandleTime, lastEvaluatedAt, levels, nextConfirmation, cancelCondition, risks, liquidityClass, extended, moveSinceDetectionPct, moveSinceDetectionAtr, peakPrice, markers, closeReason, closedAt, updatedAt, provisional: { stage, score, evaluatedAt, candleOpenTime, evidenceCount, evidence, risks } | null, provisionalOnly: boolean, candleStatus: 'CLOSED'|'RUNNING' }` + `lastPrice`, `lastCandleAt` dari route.

## 6. Pipeline (`backend/reversal/pipeline.js`)

```js
createReversalPipeline({ repos /* { candles } */, reversal /* repositori §5 */, getLiquidity, logger, params, lookback = 300,
  maxReplay = 288, timeframes = REVERSAL_TIMEFRAMES, onAlert, yieldEvery = 25, yieldToEventLoop, provisionalMinIntervalMs = 15_000, clock })
→ { onClosedCandles({ symbol, timeframe }), onProvisionalCandle(candle), closeSymbol({ symbol, timeframes, reason, at }), timeframes }
```
- `onClosedCandles`: serial per seri; replay dari kursor seperti `createAnalysisPipeline` (candle belum dievaluasi, maks `maxReplay`, evaluasi pertama seri tanpa kursor = candle terakhir saja); HTF dari `repos.candles.getLatest` dipotong `closeTime ≤ closeTime candle`; likuiditas hanya untuk candle terbaru; `transitionReversal` → `save`/`markEvaluated`; alert hanya untuk candle terbaru; setelah candle tutup `clearProvisional`.
- `onProvisionalCandle(candle)`: throttle per seri `provisionalMinIntervalMs`; ambil `lookback − 1` candle tertutup + candle berjalan → `evaluateReversal({ provisional: true })` → `setProvisional`. Tidak pernah menyentuh kursor/kandidat. Error dicatat, tidak dilempar.
- Kedua pipeline (SA/PVA & reversal) dipanggil dari `worker/assemble.js` pada `onClosedCandles` scanner; scanner mendapat dependensi opsional `onProvisionalCandle(candle)` yang dipanggil dari `handleProvisional` (setelah throttle 1 s yang ada, tanpa menunggu). Scanner `options.timeframes` worker = gabungan `scannedTimeframes(DIRECTIONS)` ∪ `REVERSAL_TIMEFRAMES` = 5m, 15m, 1h.
- Kandidat terbuka lama pada seri yang berhenti dipantau ditutup `MONITORING_STOPPED`/`SYMBOL_DELISTED` (hook `onMonitoringStopped` yang sudah ada memanggil kedua pipeline).

## 7. API (`backend/api/reversalRoutes.js`, terdaftar di `buildApp`)

- `GET /api/reversal/candidates?timeframe=5m|15m|1h&stage=&status=&liquidity=LIQUID|THIN&minScore=0..100&sensitivity=LOW|MEDIUM|HIGH&includeExtended=0|1&includeProvisional=0|1&limit=1..500` → `{ items, count, meta: { timeframes: REVERSAL_TIMEFRAMES, sensitivity, filters: SENSITIVITY_FILTERS } }`. `sensitivity` → `minScore`/`minEvidence` dari `SENSITIVITY_FILTERS = { LOW: { minScore: 60, minEvidence: 4 }, MEDIUM: { minScore: 45, minEvidence: 3 }, HIGH: { minScore: 0, minEvidence: 0 } }` (diterapkan server-side sebelum limit; `minScore` eksplisit menang). Item membawa `lastPrice`, `lastCandleAt` (candle tutup terakhir seri). Skema query AJV tanpa koersi (string pola), seperti signalRoutes.
- `GET /api/reversal/history?symbol=&timeframe=&limit=` → `{ items, count }` (dengan `events`).
- `GET /api/reversal/candidates/:id` → item + `events`; 404 bila tidak ada.
- Semua baca saja, di balik auth yang sama dengan `/api/signals/*`.

## 8. UI (`frontend/js/views/reversalRadar.js` + `reversalFormat.js` + `frontend/css/reversal.css`)

Halaman LONG Scanner (`#/screener`, `screenerView`) menjadi:
1. Judul "LONG Scanner — Reversal Radar"; subjudul (sejak 2026-10-27, posisi pelabel struktur): "Pelabel struktur proses dasar pada 5m/15m/1h: di tahap mana chart berada (Early Formation → Developing Reversal → Confirmed Breakout), bukti yang terpenuhi, level kunci, dan kapan setup batal. Deskriptif, bukan prediksi — lihat status validasi di bawah. Skor = kecocokan aturan, bukan probabilitas; bukan perintah transaksi." Di bawah subjudul: paragraf statis status validasi (`data-testid="reversal-validation"`, docs/21 §6.6–§6.9).
2. Kontrol scanner persisten (`workerControlBar`) + radar header seperti sekarang.
3. Toolbar filter (`form.toolbar`, `aria-label="Filter Reversal Radar"`): `timeframe` (segmented: Semua | 5m | 15m | 1H), `stage` (Semua | Early Formation | Developing Reversal | Confirmed Breakout), `status` (Semua terbuka | Baru | Berkembang | Terkonfirmasi), `liquidity` (Semua | Likuid saja | Likuid + tipis), `sensitivity` (Rendah | Sedang (default) | Tinggi), `extended` (toggle "Sembunyikan yang sudah extended"), `provisional` (toggle "Tampilkan candle berjalan (provisional)", default aktif). Semua filter dikirim ke server; preferensi disimpan di `localStorage` (`lr.reversal.filters`).
4. Tiga panel bertumpuk, urutan tetap: **Early Formation** (`data-testid="reversal-early"`), **Developing Reversal** (`reversal-developing`), **Confirmed Breakout** (`reversal-confirmed`) — dua pertama di atas agar tidak tertutup koin yang sudah pump. Tiap panel: judul + badge jumlah per timeframe ("5m 3 · 15m 2 · 1H 1") + tabel (`dataTable`) kolom: Pair, TF, Jenis setup, Status (pill: Baru/Berkembang/Terkonfirmasi + "provisional" bila provisional-only), Skor (score bar), Bukti (jumlah + 2 label pertama), Harga, Sejak deteksi (% dan ×ATR; badge "Extended"/"Terlambat"), Likuiditas, Candle (Tutup/Berjalan), Deteksi pertama (WIB, `formatTime`), Update (`updatedCell`/relatif). Baris kandidat provisional-only diberi kelas `is-provisional` dan label "provisional".
5. Klik baris → panel detail di samping (reuse `attachChartSidePanel` dengan `toTarget` khusus atau panel detail sendiri): mini-chart (`createCandleChart` dengan `levels`: invalidasi (bear), bottom (support), trigger (resistance), deteksi pertama (detected); `markers` dari `markers` kandidat + event), lalu bagian: **Alasan masuk** (daftar bukti: label + detail), **Level penting**, **Konfirmasi berikutnya**, **Batal bila**, **Risiko utama**, **Skor & komponen** (5 bar), **Riwayat** (event: waktu WIB, tahap/status, provisional ditandai). Tautan "Buka detail" ke `#/symbol?s=...&tf=...&dir=LONG`.
6. Penyegaran latar 30 s saat scanner berjalan (pola `screener.js`), diff → sorot baris baru/naik; fokus dipertahankan.
7. Panel sekunder terlipat di bawah: "Pola SA/PVA 15m (mesin lama)" = tabel LONG lama apa adanya (`data-testid="screener-results"` dipertahankan, filter lama dipertahankan di dalam `<details>`), agar fitur & tes lama tetap berjalan.
8. Grafik: `CHART_TIMEFRAMES` di `symbolChart.js` kembali `['5m','15m','1h']`.
9. Tidak ada data contoh; empty state jujur per panel ("Belum ada kandidat Early Formation pada filter ini").

Format Indonesia di `reversalFormat.js`: `stageLabel`, `statusPill`, `setupTypeLabel`, `evidenceLabel`, `riskLabel`, `liquidityBadge`, `moveCell`, `candleStatusBadge`, `scoreComponents`.

## 9. Replay & validasi (`backend/reversal/replay.js`, `scripts/reversal-replay.js`)

- `replayReversalSeries({ symbol, timeframe, candles, higher, params, horizonBars })` → candle demi candle `evaluateReversal` + `transitionReversal` (histeresis sama dengan live), menghasilkan daftar kandidat `{ firstDetectedIndex, firstStage, stages: [{ stage, index }], closeReason, closeIndex, outcome }` dengan `outcome` = triple barrier dari close deteksi pertama: target `+2 × ATR_deteksi` vs stop `levels.invalidation` dalam `horizonBars` (5m 48, 15m 48, 1h 48) → `SUCCESS|FAIL|TIMEOUT`, plus `mfeAtr`, `maeAtr`, `mfePct`, `maePct`, `barsToTrigger` (bila trigger ditembus), `leadVsOld` (selisih candle vs sinyal pertama mesin lama SA/PVA `analyzeAt` pada seri yang sama — positif = lebih awal), `leadVsBreakout`.
- Pembanding lama: `analyzeAt` (pola SA/PVA, params default) replay pada seri yang sama; "sinyal lama" = state QUIET/EARLY_BULLISH pertama.
- Skenario sintetis (`tests/fixtures/candles/reversalScenarios.js`, deterministik dengan seed, memakai generator `tests/fixtures/candles/synthetic.js`/`backend/backtest/synthetic.js`): `successfulReversal`, `failedBounce`, `continuedDowntrend`, `longSideways`, `suddenPump`, `lowVolumeIlliquid`, `brokenData` (gap, volume nol, candle hilang), `uptrendContinuation`. Set penyetelan = seed 1–20; evaluasi = seed 21–60 (tidak dipakai untuk menyetel parameter).
- Laporan (`reports/reversal-replay-<ts>.md|json` + ringkas di stdout): per timeframe × skenario × sensitivitas: jumlah kandidat, rasio batal, rasio kedaluwarsa, rasio SUCCESS/FAIL/TIMEOUT, median MFE/MAE, median lead vs mesin lama (candle), median lead vs breakout, false positive pada `continuedDowntrend`/`suddenPump`/`uptrendContinuation`. Tes `tests/unit/reversal/replay.test.js` mengunci: tidak ada lookahead (prefiks), reversal sukses terdeteksi lebih awal dari mesin lama, failed bounce → CANCELLED, downtrend lanjut & uptrend lanjut → tanpa kandidat (atau ≤ ambang), data rusak → DATA_QUALITY tanpa crash.
- Tambahan laporan untuk data nyata multi-peristiwa (2026-10-26, setelah run 1 — lihat docs/21 §6.5): hasil per tahap awal (`outcomesByFirstStage`), distribusi/histogram skor saat deteksi per tahap (`firstScoreByStage`, `firstScoreHistogramByStage`), jarak stop & dua basis pembanding tanpa keterampilan (`stopDistanceAtr`, `baselineRandomWalk`, `baselineShuffled`, `successMinusBaseline`), breakout gagal sebelum target (`failedBeforeTarget`), hasil menurut status terlambat (`outcomesByExtended`), lead per peristiwa terhadap sinyal lama terdekat ±horizon (`leadVsOldNearest*`), target `T_NYATA_1..3`, dan `meta.symbolsRequested/symbolsSkipped` (simbol yang gagal diunduh/data kurang dilewati, bukan menggagalkan run).
- Tambahan untuk run 3 (setelah run 2, docs/21 §6.8): basis acak & jarak stop **per subset** (`outcomesByFirstStage.<tahap>` dan `outcomesByExtended.<status>` memuat `stopDistanceAtr`, `baselineRandomWalk`, `baselineShuffled`, `successMinusBaseline`, `expectancyAtr`), `expectancyAtr` level grup (SUCCESS +target, FAIL −s, TIMEOUT 0, tanpa biaya), `outcomesByScoreBin.<tahap>[bin]` (SUCCESS vs basis per bin skor 10 poin; dirender untuk HIGH), dan target `T_NYATA_1_STAGE` per TF × tahap (CI bawah SUCCESS subset > basis empiris subset).
- CLI data nyata (dijalankan pengguna di Mac): `npm run reversal:replay -- --top 20 --timeframes 5m,15m,1h --from 2025-06-01 --to 2025-10-01` memakai `backend/backtest/dataSource.js` (cache Binance); `--synthetic --seeds 21-60` untuk fixture. Hasil ditulis ke `reports/`.

## 10. Definisi keberhasilan (ditetapkan SEBELUM evaluasi)
- Kandidat "berhasil" bila dalam `horizonBars` setelah deteksi pertama harga mencapai `+2 × ATR` dari close deteksi sebelum close < `invalidation` (SUCCESS). Rasio target awal pada data sintetis `successfulReversal`: ≥ 60 % SUCCESS pada sensitivitas MEDIUM; `continuedDowntrend` ≤ 15 % kandidat per seri; `uptrendContinuation` 0 kandidat; lead vs mesin lama > 0 median. Pada data nyata: **tidak ada klaim** sebelum pengguna menjalankan CLI; dokumentasi hanya menampilkan angka yang benar-benar dihasilkan.
- **Target data nyata (skenario `dataNyata`, ditetapkan 2026-10-26 setelah run 1 dan SEBELUM run 2, lihat docs/21 §6.5)**: per timeframe pada sensitivitas MEDIUM — (T-NYATA-1) batas bawah CI Wilson 95 % SUCCESS harus di atas basis acak empiris (entri acak pada seri yang sama dengan jarak stop yang sama); (T-NYATA-2) median lead per peristiwa (padanan sinyal lama terdekat dalam ±`horizonBars`) > 0; (T-NYATA-3) ≥ 10 % kandidat pertama bertahap EARLY_FORMATION. **Ditambahkan sebelum run 3** (2026-10-26, setelah run 2): (T-NYATA-1 per tahap) CI bawah SUCCESS subset tahap awal pada MEDIUM > basis empiris subset itu sendiri (jarak stop subset); keputusan ambang per tahap/bin hanya bila subset/bin melampaui basisnya **dan** ekspektasi ATR > 0 — pada run 3 (docs/21 §6.9) **tidak ada** tahap/bin yang memenuhinya. **Ditambahkan sebelum run 4** (2026-10-27, setelah run 3; docs/21 §6.10): uji luar sampel **terakhir** pada periode 2026-06-01 → 2026-10-01 untuk dua sel LOW yang lolos terisolasi pada run 2–3 — (T-NYATA-4) 5m, kandidat pertama DEVELOPING_REVERSAL pada LOW: CI bawah SUCCESS > basis empiris subset **dan** selisih ≥ 3 poin **dan** ekspektasi ATR > 0; (T-NYATA-5) 1h, semua kandidat LOW, kriteria sama terhadap basis grup; baris TF lain = kontrol konsistensi, bukan sel keputusan. Konsekuensi ditetapkan sekarang: lulus → label "didukung satu uji luar sampel" di UI untuk sel itu (filter & parameter tetap); gagal → sel ditutup, tidak ada uji lanjutan untuk sel/bin/ambang lain. **Hasil run 4** (2026-10-27, Binance Jun–Okt 2026, 20 simbol, docs/21 §6.10): T-NYATA-4 5m SUCCESS 60,9 % (CI 56,7–64,9 %) vs basis subset 59,5 %, selisih +1,3 poin, ekspektasi +0,42 ATR, n = 547; T-NYATA-5 1h SUCCESS 60,4 % (CI 46,3–73,0 %) vs basis grup 60,4 %, selisih 0,0 poin, ekspektasi +0,42 ATR, n = 48 — **keduanya TIDAK terpenuhi**; kedua sel ditutup sebagai derau, tidak ada label di UI, tidak ada uji lanjutan. Target §10 versi sintetis (nama skenario) tidak berlaku pada data nyata; rasio SUCCESS tanpa kolom basis acak **tidak boleh** disebut keunggulan.
