# 24 — Backtest ulang pola live di 31 koin & studi timing sinyal (2026-11-15)

Pemicu: audit eksternal atas ZIP repo menyarankan (1) membuktikan edge statistik pola live dengan data Binance nyata,
biaya, dan uji luar sampel; (2) memeriksa apakah sinyal muncul **sebelum breakout** atau **setelah momentum berjalan**.
Temuan teknis audit itu (`entryTime` backtest tercatat 1 ms lebih awal) diperbaiki di commit `9de2d3c`, bersama fee
bawaan 5 bps per sisi (taker Binance USDⓈ-M VIP 0).

**Komitmen sebelum hasil terlihat (keputusan pemilik 2026-11-15):** hasil kedua uji dicatat di dokumen ini apa pun
hasilnya. Definisi timing (§1.2) dikunci di kode sebelum run penuh. Satu-satunya perubahan setelah uji asap satu koin
(HYPEUSDT): angka R untuk pecahan "diikuti breakout" dihapus, karena pecahan itu memakai data sesudah alert (hasilnya
tautologis); kini hanya frekuensinya yang dilaporkan.

**Ringkasan:**
- **LONG 1h (SA/PVA, perilaku live v3): sekitar impas setelah biaya.** +0,02R per trade di periode uji (n = 945,
  CI 95% berklaster harian −0,09 … +0,12) dan +0,03R di seluruh periode (n = 1.713). Tidak terbukti punya edge, tidak
  terbukti rugi. Pada 6 koin besar saja (laporan sebelumnya, fee 4 bps) hasilnya −0,12R.
- **SHORT 15m (SD/PVD, v3): rugi konsisten.** −0,14R per trade di periode uji (n = 9.627, CI −0,20 … −0,09) dan
  −0,12R di seluruh periode; negatif di semua kelompok timing, state, dan tersil.
- **Timing: alert umumnya muncul setelah harga sudah bergerak.** Median gerak searah sinyal dalam 12 candle sebelum
  alert +2,0 ATR (LONG 1h) dan +1,7 ATR (SHORT 15m), dengan harga di ±85% rentang 48 candle terakhir. Sekitar separuh
  alert muncul sebelum breakout 48 candle (54% / 61%), seperempat tepat di candle breakout (24% / 18%, 7–8 kali lipat
  candle acak), sisanya sesudah breakout (22% / 21%). Tidak ada kelompok timing yang positif signifikan setelah biaya.
- **Scanner tidak diubah.** Posisi produk tetap: skor = kecocokan aturan, bukan peluang; tanpa klaim profit.

## 1. Metode

### 1.1 Backtest ulang (runner proyek, perilaku live)

- Perintah: `npm run backtest -- --symbols <31 simbol> --timeframes 15m,1h --from 2024-01-01 --to 2026-10-01`
  → `reports/backtest-20261115T145358Z.{md,json}` (laporan lokal, tidak di-commit; durasi 24 menit).
- Data: kline Binance USDT-M dari `data/backtest-cache`. 31 simbol: 1000PEPE, ADA, APR, BCH, BNB, BTC, BTW, BULLA, CAP,
  DODOX, DOGE, DOOD, ENA, ERA, ETH, HYPE, INJ, IRYS, JCT, LINK, NEAR, PUMP, QNT, Q, SOL, SUI, TAO, UNI, WLD, XRP, ZEC
  (semua …USDT). Simbol yang listing belakangan hanya punya data sejak listing.
- Trade: entri saat sinyal pertama kali masuk state alert, di **open candle berikutnya**; stop = level invalidasi
  sinyal; target 2R; batas 48 candle; stop & target tersentuh di candle yang sama = LOSS; biaya fee 5 + slippage 2 bps
  per sisi (14 bps pulang-pergi); tanpa funding.
- Validasi: holdout berurutan waktu — sinyal sebelum 2025-08-26 = train (60%), sesudahnya = test (40%), embargo 48 candle
  dan purging trade train yang keluar setelah awal test.
- Varian: **v3** = perilaku scanner live (gerbang tier konfluensi ≥ B); **v2** = tanpa gerbang tier (pembanding).
  Kombinasi live: LONG 1h dan SHORT 15m. Runner juga menghitung LONG 15m dan SHORT 1h (tidak live; ada di laporan).

### 1.2 Studi timing (`npm run research:timing`)

- Alat: `backend/research/signalTiming.js` (definisi; tes UNIT-TMG-001…005, termasuk tanpa lookahead dan simetri
  LONG/SHORT) dan `scripts/research-timing.js` (orkestrasi). Trade diambil dari `replaySeries` runner yang sama, sehingga
  n periode uji sama persis dengan §1.1 (945 dan 139 + 9.488 = 9.627).
- Definisi (dikunci sebelum run penuh):
  - **Breakout** candle j: close menembus ekstrem 48 candle sebelumnya (LONG: di atas high tertinggi; SHORT: di bawah low
    terendah).
  - Kelompok yang diketahui saat alert (hanya candle ≤ candle sinyal i): **sebelum** (tidak ada breakout di [i−12, i]),
    **saat** (candle sinyal itu breakout), **sesudah** (breakout di [i−12, i−1]).
  - **Gerak awal** = arah × (close[i] − close[i−12]) ÷ ATR14[i]; positif = harga sudah bergerak searah sinyal.
  - **Posisi rentang** = letak close[i] di rentang high–low 48 candle terakhir; 1 = ujung searah sinyal.
  - Pembanding: setiap candle setelah warm-up di seri yang sama, dengan definisi yang sama.
  - CI rata-rata R = bootstrap berklaster per hari (2000 replikasi, benih 7); win rate = interval Wilson.
- Laporan: `reports/research/timing-20261115T151927Z.{md,json}` (lokal, tidak di-commit; durasi 20 menit).
  **Paritas:** skrip draf yang menghasilkan angka pertama dan skrip repo menghasilkan angka identik (perbandingan
  otomatis semua field angka) pada 2 simbol dan pada 31 simbol.

## 2. Hasil backtest (31 koin)

CI expectancy dari runner dihitung per trade, tidak berklaster, sehingga lebih sempit dari seharusnya. CI berklaster harian
untuk trade yang sama ada di §3.

| Varian | Kombinasi | Sampel | n | Win rate (Wilson) | Expectancy [CI 95% per trade] | Profit factor |
|---|---|---|---|---|---|---|
| v3 (live) | LONG 1h | test | 945 | 25,6% (22,9–28,5%) | +0,02R [−0,06 … +0,10] | 1,03 |
| v3 (live) | LONG 1h | train | 768 | 24,1% (21,2–27,2%) | +0,04R [−0,05 … +0,13] | 1,07 |
| v3 (live) | SHORT 15m tier B | test | 9.488 | 22,5% (21,7–23,4%) | −0,14R [−0,17 … −0,12] | 0,78 |
| v3 (live) | SHORT 15m tier B | train | 9.967 | 24,0% (23,2–24,9%) | −0,10R [−0,12 … −0,07] | 0,85 |
| v3 (live) | SHORT 15m tier A | test | 139 | 22,3% (16,2–29,9%) | −0,21R [−0,41 … −0,00] | 0,69 |
| v2 | LONG 1h tier B / C / D | test | 326 / 2.894 / 666 | 32,8% / 27,1% / 29,7% | +0,05R / −0,07R / −0,10R | 1,09 / 0,89 / 0,85 |
| v2 | SHORT 15m tier A / B / C / D | test | 115 / 5.703 / 6.524 / 5.869 | 20,0% / 25,9% / 26,7% / 27,6% | −0,32R / −0,14R / −0,13R / −0,15R | 0,56 / 0,80 / 0,81 / 0,79 |

- Gerbang tier v3 membantu LONG 1h: v2 di periode uji rata-rata ±−0,07R, v3 +0,02R. Untuk SHORT 15m gerbang tier tidak
  mengubah apa-apa (v2 ±−0,14R, v3 −0,14R).
- Dibanding laporan sebelumnya (6 koin besar BTC/ETH/SOL/XRP/DOGE/BNB, sinyal 2025-01 → 2026-10, fee 4 bps): LONG 1h v3
  −0,12R (n = 167) dan SHORT 15m v3 −0,13R. Semesta 31 koin membuat LONG 1h sekitar impas; SHORT 15m tetap negatif.

## 3. Hasil studi timing

### 3.1 LONG 1h (SA/PVA)

Seri 31 · alert v3 1.714 (tanpa OPEN dan data cukup: 1.713; periode uji: 945) · pembanding 566.390 candle.

| Hasil | n | Win rate (Wilson) | R bersih [CI 95% klaster harian] |
|---|---|---|---|
| Semua periode | 1.713 | 24,9% (22,9–27,0%) | +0,03R [−0,05 … +0,10] |
| Periode uji | 945 | 25,6% (22,9–28,5%) | +0,02R [−0,09 … +0,12] |

| Timing alert | Porsi alert | Porsi candle acak | n | Win rate | R bersih [CI 95%] |
|---|---|---|---|---|---|
| Sebelum breakout | 54,3% | 81,0% | 930 | 30,0% (27,1–33,0%) | +0,02R [−0,09 … +0,12] |
| Tepat di candle breakout | 23,8% | 2,8% | 407 | 18,9% (15,4–23,0%) | +0,11R [−0,02 … +0,23] |
| Sesudah breakout (≤ 12 candle) | 21,9% | 16,2% | 376 | 18,9% (15,2–23,1%) | −0,03R [−0,17 … +0,11] |

Dari alert "sebelum breakout", 32,3% diikuti breakout dalam 12 candle berikutnya; candle acak dalam kondisi sama 13,5%
(memakai data sesudah alert — deskriptif, bukan aturan).

| Ukuran | Alert | Candle acak |
|---|---|---|
| Gerak awal 12 candle, median [p25 … p75] | +2,04 ATR [+1,19 … +3,26] | −0,04 ATR [−1,36 … +1,29] |
| Gerak awal ≥ 2 ATR | 51,4% | 15,4% |
| Posisi di rentang 48 candle, median | 0,86 | 0,48 |
| Posisi ≥ 0,9 (10% teratas rentang) | 39,9% | 7,5% |

| State alert pertama | Porsi | Gerak awal median | n | R bersih [CI 95%] |
|---|---|---|---|---|
| EARLY_BULLISH | 31,5% | +1,15 ATR | 539 | −0,07R [−0,20 … +0,06] |
| MOMENTUM_BUILDING | 49,9% | +2,36 ATR | 854 | +0,07R [−0,03 … +0,18] |
| BREAKOUT | 18,7% | +3,64 ATR | 320 | +0,07R [−0,07 … +0,20] |

| Tersil gerak awal | n | Win rate | R bersih [CI 95%] |
|---|---|---|---|
| < +1,5 ATR | 571 | 29,9% (26,3–33,8%) | −0,04R [−0,16 … +0,08] |
| +1,5 … +2,7 ATR | 571 | 27,5% (24,0–31,3%) | −0,03R [−0,15 … +0,09] |
| ≥ +2,7 ATR | 571 | 17,3% (14,5–20,7%) | +0,15R [+0,05 … +0,26] |

### 3.2 SHORT 15m (SD/PVD)

Seri 31 · alert v3 19.747 (tanpa OPEN dan data cukup: 19.741; periode uji: 9.627) · pembanding 2.280.604 candle.

| Hasil | n | Win rate (Wilson) | R bersih [CI 95% klaster harian] |
|---|---|---|---|
| Semua periode | 19.741 | 23,3% (22,8–23,9%) | −0,12R [−0,16 … −0,08] |
| Periode uji | 9.627 | 22,5% (21,7–23,4%) | −0,14R [−0,20 … −0,09] |

| Timing alert | Porsi alert | Porsi candle acak | n | Win rate | R bersih [CI 95%] |
|---|---|---|---|---|---|
| Sebelum breakout | 60,6% | 80,7% | 11.964 | 26,9% (26,1–27,7%) | −0,13R [−0,17 … −0,08] |
| Tepat di candle breakout | 18,2% | 2,7% | 3.598 | 15,8% (14,6–17,0%) | −0,10R [−0,16 … −0,04] |
| Sesudah breakout (≤ 12 candle) | 21,2% | 16,7% | 4.179 | 19,7% (18,6–21,0%) | −0,10R [−0,15 … −0,05] |

Dari alert "sebelum breakout", 33,5% diikuti breakout (ke bawah) dalam 12 candle berikutnya; candle acak 14,5%.

| Ukuran | Alert | Candle acak |
|---|---|---|
| Gerak awal 12 candle, median [p25 … p75] | +1,65 ATR [+0,89 … +2,50] | +0,02 ATR [−1,29 … +1,33] |
| Gerak awal ≥ 2 ATR | 38,3% | 15,5% |
| Posisi di rentang 48 candle, median | 0,84 | 0,51 |
| Posisi ≥ 0,9 | 34,1% | 7,6% |

| State alert pertama | Porsi | Gerak awal median | n | R bersih [CI 95%] |
|---|---|---|---|---|
| EARLY_BEARISH | 34,2% | +1,03 ATR | 6.745 | −0,17R [−0,22 … −0,11] |
| MOMENTUM_BUILDING | 51,3% | +1,88 ATR | 10.133 | −0,09R [−0,14 … −0,04] |
| BREAKDOWN | 14,5% | +2,62 ATR | 2.863 | −0,09R [−0,15 … −0,03] |

| Tersil gerak awal | n | Win rate | R bersih [CI 95%] |
|---|---|---|---|
| < +1,2 ATR | 6.580 | 28,1% (27,0–29,2%) | −0,15R [−0,20 … −0,10] |
| +1,2 … +2,2 ATR | 6.580 | 25,1% (24,1–26,2%) | −0,11R [−0,17 … −0,07] |
| ≥ +2,2 ATR | 6.581 | 16,8% (15,9–17,7%) | −0,09R [−0,13 … −0,04] |

## 4. Tafsiran (jujur, bukan klaim)

- **Edge.** Dengan aturan keluar runner (stop invalidasi, target 2R, 48 candle) dan biaya realistis, tidak ada pola live
  yang terbukti menguntungkan. LONG 1h sekitar impas; SHORT 15m rugi ±0,1R per trade secara konsisten di train dan test.
  AlphaLens tetap alat penyaring pola untuk ditinjau manusia, bukan sistem sinyal yang terbukti profit.
- **Timing.** Detektor menandai momentum yang **sudah berjalan**, bukan akumulasi diam-diam sebelum harga bergerak:
  median gerak awal +2 ATR, harga di atas 85% rentang 48 candle, dan 40% alert LONG berada di 10% teratas rentang
  (candle acak 7,5%). "Sebelum breakout" di sini berarti belum menembus high 48 candle, tetapi biasanya sudah naik ±2 ATR.
- **Ada informasi, tetapi tidak menutup biaya.** Alert "sebelum breakout" ±2,3–2,4 kali lebih sering diikuti breakout
  daripada candle acak (LONG 32,3% vs 13,5%; SHORT 33,5% vs 14,5%). Detektor membawa informasi tentang gerak lanjutan jangka
  pendek, tetapi dengan geometri stop/target saat ini hasil bersihnya tidak positif.
- **Satu sel menonjol, belum temuan.** LONG 1h dengan gerak awal ≥ +2,7 ATR: +0,15R [+0,05 … +0,26]. Arahnya sejalan
  dengan literatur momentum time-series, tetapi ini 1 dari 18 sel kelompok/state/tersil yang dilihat; pada 95% sekitar
  satu kelulusan palsu memang diharapkan. Sel ini hanya boleh menjadi hipotesis untuk uji luar sampel terpraregistrasi
  pada data segar (sinyal setelah 2026-10-01, paling cepat dievaluasi setelah 2027-01-03), bukan dasar mengubah scanner.
- **Semesta simbol menentukan.** LONG 1h −0,12R pada 6 koin besar vs +0,02R pada 31 koin. Daftar 31 koin dipilih menurut
  volume Oktober 2026, sehingga koin yang sudah naik lebih mungkin masuk (bias survivorship yang menguntungkan LONG); angka
  +0,02R karena itu cenderung optimistis.

## 5. Keterbatasan

- Bias survivorship (di atas); satu bursa (Binance USDT-M).
- Runner tanpa funding; studi kejadian docs/23 mengukur pengaruhnya ±0,004R per trade.
- Trade tumpang tindih dan berkorelasi antarkoin: CI runner tidak berklaster; CI studi timing berklaster per hari.
- Satu aturan keluar (2R / 48 candle); hasil trader diskresioner bisa berbeda.
- Parameter pola dirancang manusia dan mungkin dibuat setelah melihat sebagian periode ini, jadi "periode uji" hanya
  luar sampel untuk kalibrasi, bukan untuk desain pola.
- Studi timing deskriptif dengan satu definisi breakout (Donchian 48, jendela 12); definisi lain bisa memberi angka lain.

## 6. Cara mengulang

```bash
npm run backtest -- --symbols 1000PEPEUSDT,ADAUSDT,APRUSDT,BCHUSDT,BNBUSDT,BTCUSDT,BTWUSDT,BULLAUSDT,CAPUSDT,DODOXUSDT,DOGEUSDT,DOODUSDT,ENAUSDT,ERAUSDT,ETHUSDT,HYPEUSDT,INJUSDT,IRYSUSDT,JCTUSDT,LINKUSDT,NEARUSDT,PUMPUSDT,QNTUSDT,QUSDT,SOLUSDT,SUIUSDT,TAOUSDT,UNIUSDT,WLDUSDT,XRPUSDT,ZECUSDT --timeframes 15m,1h --from 2024-01-01 --to 2026-10-01
npm run research:timing
```

Untuk angka dengan fee lama 4 bps, tambahkan `--fee-bps 4` pada perintah backtest.
