# 21 — Validasi "Reversal Radar": laporan replay historis

Status: **hasil sintetis terisi** (2026-10-26) untuk mesin `backend/reversal` commit `6bdb4d1` (branch `wt-rr-engine`,
parameter `DEFAULT_REVERSAL_PARAMS` bawaan, **tanpa penyetelan**). Bagian data nyata (§6) masih **kerangka**: angka diisi
pengguna dari keluaran `npm run reversal:replay` di Mac. Setiap placeholder `<!-- diisi dari reports/... -->` wajib diganti
dengan nilai dari file laporan yang disebutkan beserta nama filenya. Semua angka di §2–§4 disalin dari
`reports/evaluation/reversal-replay-20261026T185647Z.md` (set evaluasi) dan `reports/tuning/reversal-replay-20261026T185640Z.md`
(set penyetelan); `reports/` gitignored, jadi file itu harus dibuat ulang dengan perintah di §2/§3 bila diperlukan.

Kontrak yang divalidasi: [docs/19 — Reversal Radar](19-kontrak-reversal-radar.md) §3 (detektor), §4 (state machine),
§9 (replay), **§10 (definisi keberhasilan — ditetapkan sebelum evaluasi)**. Harness: `backend/reversal/replay.js`,
agregasi/laporan: `backend/reversal/replayReport.js`, CLI: `scripts/reversal-replay.js`, skenario sintetis:
`tests/fixtures/candles/reversalScenarios.js`.

> Reversal Radar adalah alat riset: skor = kecocokan aturan yang dapat dijelaskan, **bukan probabilitas**; tidak ada
> perintah transaksi. Laporan replay tidak menyatakan peluang keberhasilan di masa depan. **Data sintetis ≠ pasar nyata**:
> angka di §2–§4 hanya membuktikan mekanisme dan arah perilaku detektor pada bentuk chart yang diketahui.

## 1. Metodologi

### 1.1 Replay berurutan tanpa look-ahead
- Setiap seri (simbol × timeframe) di-replay **candle demi candle** dari candle ke-150 (warm-up = max(150,
  `requiredCandles(params)` = 120)). Pada candle `t` mesin hanya menerima jendela candle tertutup dengan `closeTime ≤ t`
  (maksimum `REVERSAL_LOOKBACK = 300`, sama dengan pipeline live) dan konteks HTF yang dipotong `closeTime ≤ t`
  (`htfCursor`, pola `backend/backtest/runner.js`). HTF diambil dari data asli bila ada; bila tidak, diagregasi dari
  candle dasar hanya untuk kelompok lengkap & tertutup (`aggregateCandles`).
- `evaluateReversal` → `transitionReversal` dipanggil dengan histeresis yang **identik dengan live** (`enterConfirmBars`,
  `expiryBars`, `weakBarsLimit`); snapshot diteruskan utuh dari candle ke candle (termasuk snapshot `NONE` yang membawa
  `pendingStage/pendingBars`; setelah kandidat terminal mesin sendiri memulai dari null). Tidak ada evaluasi provisional
  (candle berjalan) dalam replay — `provisionalFree: true`. Nol anomali kontrak state machine pada 1 440 seri.
- Waktu deteksi = `closeTime` candle tempat kondisi dapat diamati (termasuk keterlambatan konfirmasi swing 2 candle).
- Uji stabilitas prefiks (`assertNoLookahead`, CLI `--check-lookahead`): replay penuh, lalu evaluasi diulang pada prefiks
  `candles.slice(0, k+1)` yang dibangun dari nol (HTF ikut dipotong/diagregasi dari prefiks) untuk 4 `k` acak berbenih;
  hasil wajib identik. Replay pada prefiks juga dibandingkan: kandidat/tahap/penutupan sampai `k` tidak boleh berubah saat
  candle masa depan ditambahkan. CLI menjalankan uji ini **sebelum** replay utama seri yang sama, sehingga mesin yang
  menyimpan keadaan lintas panggilan ("hafal" candle berikutnya) ikut terdeteksi. Kegagalan = hasil replay tidak sah
  (kode keluar 4).

### 1.2 Definisi keberhasilan (§10, tetap)
Dari **close deteksi pertama** (event `OPENED`): target `+2 × ATR deteksi`, stop `levels.invalidation` saat deteksi,
horizon 48 candle (semua timeframe). Urutan intrabar tidak diketahui → TP & SL pada candle yang sama = **FAIL**; open
melewati stop = keluar di open. `SUCCESS | FAIL | TIMEOUT`; `OPEN` (data habis) dan kandidat tanpa level invalidasi/ATR
dikecualikan dari penyebut rasio dan dilaporkan terpisah. Pelabelan memakai `labelTrade` (`backend/backtest/labeler.js`)
tanpa biaya. Definisi ini **tidak boleh disetel** setelah melihat hasil; perubahan definisi = laporan baru dengan versi
metodologi baru (`REVERSAL_VERSION`).

Target awal §10 (hipotesis, diperiksa otomatis di bagian "Pemeriksaan target §10" laporan):
`successfulReversal` SUCCESS ≥ 60 % pada MEDIUM; `continuedDowntrend` ≤ 15 % seri berkandidat (HIGH = semua kandidat);
`uptrendContinuation` 0 kandidat; median lead **kandidat pertama tiap seri** vs **sinyal lama pertama** > 0 candle
(MEDIUM). Catatan: definisi lead "kandidat pertama" dipertegas sebelum angka set evaluasi dibaca; laporan juga memuat lead
semua kandidat sebagai pembanding (kandidat lanjutan wajar bernilai negatif).

### 1.3 Pemisahan benih penyetelan dan evaluasi
- **Set penyetelan**: seed 1–20 (`--seeds 1-20 --tuning`). Hanya set ini yang boleh dipakai untuk menyetel parameter
  `DEFAULT_REVERSAL_PARAMS`.
- **Set evaluasi**: seed 21–60 (`--seeds 21-60`, bawaan). Tidak boleh dipakai untuk menyetel. CLI memberi peringatan dan
  laporan menandai `seedSet` bila benih penyetelan ikut dievaluasi.
- Setiap perubahan parameter setelah melihat hasil set evaluasi membatalkan status "out-of-sample" set itu. Pada run ini
  **tidak ada parameter yang diubah**; usulan di §3 harus diuji pada seed 1–20 dulu, lalu dikonfirmasi ulang pada 21–60.

### 1.4 Pembanding mesin lama
`analyzeAt` (pola SA/PVA + state machine lama) di-replay pada jendela & HTF yang sama. "Sinyal lama" = sinyal pertama
yang dibuka (`QUIET`/`EARLY_BULLISH`), "alert lama" = state alert pertama. `--old fast` (bawaan) mematikan konfluensi v3:
pola dan indeks sinyal pertama identik dengan live, indeks alert memakai definisi v2 (tanpa gerbang tier); `--old full`
memakai parameter live (≈ 4× lebih lambat). `leadVsOld = indeks sinyal lama pertama − indeks deteksi`
(positif = Reversal Radar lebih awal); "kandidat pertama" = kandidat pertama tiap seri yang lolos filter sensitivitas.

### 1.5 Skenario sintetis
Deterministik per seed, ≥ 350 candle (150 warm-up + fase), bentuk chart identik untuk 5m/15m/1h (hanya stempel waktu
berbeda, sehingga perbedaan antar-timeframe berasal dari parameter mesin per timeframe & konteks HTF), harga awal
tersebar log-uniform 0,01–1000, quote volume ≈ 100 ribu USDT/candle (kecuali `lowVolumeIlliquid` ≈ 2 ribu).

| Skenario | Bentuk | Harapan |
|---|---|---|
| `successfulReversal` | downtrend ≥ 4 ATR → lower low makin dangkal → dasar naik + volume mengering → higher low → breakout RVOL ≥ 1,5 → markup | ≥ 1 kandidat, deteksi sebelum breakout, mayoritas SUCCESS |
| `failedBounce` | downtrend → pantulan 1–2 ATR tanpa dasar → lower low baru menembus dasar | kandidat (bila ada) CANCELLED/FAIL |
| `continuedDowntrend` | lower low terus, kedalaman tetap/bertambah | ≤ 15 % seri berkandidat (false positive) |
| `longSideways` | penurunan singkat → range sempit datar tanpa dasar naik | sedikit kandidat; cenderung EXPIRED |
| `suddenPump` | sideways sempit → 2 candle +5 % → sideways di atas | tanpa kandidat sebelum pump; setelahnya LATE_ENTRY/EXTENDED (false positive) |
| `lowVolumeIlliquid` | = successfulReversal, quote volume sangat kecil | risiko ILLIQUID; VOLUME_DRY_UP bukan bukti |
| `brokenData` | = successfulReversal + gap 2 candle, 5 candle volume nol, 1 candle rusak | DATA_QUALITY tanpa crash |
| `uptrendContinuation` | EMA25 naik, HH/HL, tanpa penurunan awal | **0 kandidat** |

Laporan juga membawa **fase rencana** tiap skenario (`phases`, mis. `decline → shallower → base → higherLow → breakout →
markup`) dan `landmarks` (indeks dasar & breakout rencana) sehingga deteksi dapat dipetakan ke fase (false start sebelum
dasar vs deteksi di dasar). Catatan 5m: 370 candle 5m ≈ 31 jam, sehingga HTF 1h hanya ≈ 30 candle → `HTF_UNKNOWN`
wajar pada 5m sintetis.

### 1.6 Metrik
Per timeframe × skenario × sensitivitas (`LOW`/`MEDIUM`/`HIGH` = filter skor & jumlah bukti saat deteksi pertama):
jumlah kandidat & kandidat/seri, seri berkandidat, rasio batal (CANCELLED) & kedaluwarsa (EXPIRED) beserta **alasan
penutupan** (close < invalidasi, breakout gagal, tanpa kemajuan, bukti melemah), rasio SUCCESS/FAIL/TIMEOUT dengan **k/n
dan CI Wilson 95 %**, median & kuartil MFE/MAE (ATR deteksi dan %), lead vs mesin lama (kandidat pertama & semua
kandidat) / vs alert lama / vs breakout (close pertama di atas level pemicu saat deteksi) / ke bukti TRIGGER_BREAK / ke
CONFIRMED, **CONFIRMED sesaat** (mencapai CONFIRMED_BREAKOUT lalu BREAKOUT_FAILED), **deteksi per fase rencana** dan lead
terhadap breakout rencana, **frekuensi tiap bukti** (% evaluasi yang meloloskannya / % kandidat yang memuatnya saat
deteksi), false positive pada `continuedDowntrend`/`suddenPump`/`uptrendContinuation`, perbandingan lama vs baru.

### 1.7 Tradeoff yang harus dibaca bersama
Sensitivitas lebih tinggi (HIGH) → lebih banyak kandidat & deteksi lebih dini, tetapi lebih banyak false positive dan
TIMEOUT; LOW → lebih selektif, lebih lambat (lead lebih kecil), lebih sedikit sampel. Keputusan default UI (MEDIUM)
hanya boleh diubah berdasarkan set penyetelan, lalu dikonfirmasi pada set evaluasi.

## 2. Hasil pada skenario sintetis — set evaluasi (seed 21–60)

Perintah: `npm run reversal:replay -- --synthetic --seeds 21-60 --timeframes 5m,15m,1h --scenarios all --check-lookahead`
File laporan: `reports/evaluation/reversal-replay-20261026T185647Z.md` (+ `.json`), dibuat 2026-10-26 18:56 UTC dengan
`--out reports/evaluation`. 960 seri (8 skenario × 40 benih × 3 TF), 211 392 evaluasi mesin baru + 211 392 evaluasi mesin
lama (mode `fast`), 4 710 kandidat, durasi replay 123,6 s (≈ 0,58 ms per evaluasi termasuk pembanding lama).
Baris **1h identik dengan 15m** pada semua tabel (bentuk chart sama, parameter 15m/1h sama; konteks HTF 1h pada 15m hanya
mengubah risiko, bukan kandidat) sehingga 1h tidak diulang di bawah.

### 2.1 Pemeriksaan target §10

| TF | Target | Status | Nilai | Catatan |
|---|---|---|---|---|
| 5m | successfulReversal: SUCCESS ≥ 60 % pada MEDIUM | TERPENUHI | 34/40 = 85,0 % (CI 70,9–92,9 %) | — |
| 15m | successfulReversal: SUCCESS ≥ 60 % pada MEDIUM | TERPENUHI | 93/107 = 86,9 % (CI 79,2–92,0 %) | — |
| 1h | successfulReversal: SUCCESS ≥ 60 % pada MEDIUM | TERPENUHI | 93/107 = 86,9 % (CI 79,2–92,0 %) | identik 15m |
| 5m | continuedDowntrend ≤ 15 % seri berkandidat (HIGH) | TIDAK terpenuhi | 20/40 = 50,0 % seri; MEDIUM 9/40 = 22,5 %; LOW 0/40 | semua kandidat CANCELLED |
| 15m/1h | continuedDowntrend ≤ 15 % seri berkandidat (HIGH) | TIDAK terpenuhi | 40/40 = 100 % seri (125 kandidat); MEDIUM 3/40 = 7,5 %; LOW 0/40 | semua kandidat CANCELLED |
| semua | uptrendContinuation 0 kandidat | TERPENUHI | 0 kandidat pada 40 seri per TF (semua sensitivitas) | — |
| 5m | median lead kandidat pertama vs sinyal lama pertama > 0 (MEDIUM) | TIDAK terpenuhi | median −24 candle (Q1–Q3 −24…+2), n = 34 | HIGH: +39, tetapi lihat §2.7 (false start) |
| 15m/1h | median lead kandidat pertama vs sinyal lama pertama > 0 (MEDIUM) | TIDAK terpenuhi | median −7 candle (−9…−3), n = 40; vs alert lama 0 (−2…+5) | HIGH: +51, tetapi 100 % kandidat pertama = false start sebelum dasar |

### 2.2 Ringkasan per timeframe × skenario (sensitivitas MEDIUM)
Rasio hasil memakai kandidat berlabel (SUCCESS/FAIL/TIMEOUT); OPEN (data habis) dikecualikan dari penyebut.

| TF | Skenario | Seri | Kandidat | Kand./seri | SUCCESS (k/n, CI) | FAIL | TIMEOUT | Batal | Kedaluwarsa |
|---|---|---|---|---|---|---|---|---|---|
| 5m | successfulReversal | 40 | 42 | 1,05 | 34/40 = 85,0 % (70,9–92,9) | 6/40 = 15,0 % | 0/40 | 6/42 = 14,3 % | 36/42 = 85,7 % |
| 5m | failedBounce | 40 | 28 | 0,70 | 6/17 = 35,3 % (17,3–58,7) | 8/17 = 47,1 % | 3/17 = 17,6 % | 6/28 = 21,4 % | 12/28 = 42,9 % |
| 5m | continuedDowntrend | 40 | 9 | 0,23 | 0/9 = 0,0 % (0,0–29,9) | 9/9 = 100 % | 0/9 | 9/9 = 100 % | 0/9 |
| 5m | longSideways | 40 | 36 | 0,90 | 4/33 = 12,1 % (4,8–27,3) | 6/33 = 18,2 % | 23/33 = 69,7 % | 6/36 = 16,7 % | 28/36 = 77,8 % |
| 5m | suddenPump | 40 | 47 | 1,18 | 16/28 = 57,1 % (39,1–73,5) | 8/28 = 28,6 % | 4/28 = 14,3 % | 6/47 = 12,8 % | 38/47 = 80,9 % |
| 5m | lowVolumeIlliquid | 40 | 42 | 1,05 | identik successfulReversal | | | | |
| 5m | brokenData | 40 | 6 | 0,15 | 0/6 = 0,0 % (0,0–39,0) | 6/6 = 100 % | 0/6 | 6/6 = 100 % | 0/6 |
| 5m | uptrendContinuation | 40 | 0 | 0,00 | — (n = 0) | — | — | — | — |
| 15m | successfulReversal | 40 | 107 | 2,67 | 93/107 = 86,9 % (79,2–92,0) | 14/107 = 13,1 % | 0/107 | 69/107 = 64,5 % | 38/107 = 35,5 % |
| 15m | failedBounce | 40 | 40 | 1,00 | 3/25 = 12,0 % (4,2–30,0) | 17/25 = 68,0 % | 5/25 = 20,0 % | 18/40 = 45,0 % | 9/40 = 22,5 % |
| 15m | continuedDowntrend | 40 | 3 | 0,07 | 0/3 = 0,0 % (0,0–56,2) | 3/3 = 100 % | 0/3 | 3/3 = 100 % | 0/3 |
| 15m | longSideways | 40 | 63 | 1,57 | 1/58 = 1,7 % (0,3–9,1) | 18/58 = 31,0 % | 39/58 = 67,2 % | 28/63 = 44,4 % | 34/63 = 54,0 % |
| 15m | suddenPump | 40 | 64 | 1,60 | 25/58 = 43,1 % (31,2–55,9) | 16/58 = 27,6 % | 17/58 = 29,3 % | 22/64 = 34,4 % | 42/64 = 65,6 % |
| 15m | lowVolumeIlliquid | 40 | 107 | 2,67 | identik successfulReversal | | | | |
| 15m | brokenData | 40 | 4 | 0,10 | 0/4 = 0,0 % (0,0–49,0) | 4/4 = 100 % | 0/4 | 4/4 = 100 % | 0/4 |
| 15m | uptrendContinuation | 40 | 0 | 0,00 | — (n = 0) | — | — | — | — |

Bacaan: pada bentuk reversal sukses, MEDIUM memberi 2,7 kandidat per seri di 15m (churn: dibuka → batal → dibuka lagi;
64,5 % ditutup CANCELLED walaupun label harganya SUCCESS 86,9 %). `lowVolumeIlliquid` identik dengan `successfulReversal`
pada semua tabel: kelas likuiditas hanya menambah risiko (sesuai kontrak), tidak mengubah deteksi. `brokenData`:
94,5 % evaluasi (8 288/8 768 per TF) berklasifikasi DATA_QUALITY — satu candle rusak di dalam jendela 300 candle membuat
seri "buta" selama ±300 candle (lihat §3 usulan e).

### 2.3 Lead deteksi & ekskursi (sensitivitas MEDIUM)
Format kuantil: median (Q1–Q3), n. Lead positif = Reversal Radar lebih awal.

| TF | Skenario | Lead vs lama — kandidat pertama | Lead vs lama — semua kandidat | vs alert lama (kandidat pertama) | vs breakout (close > pemicu) | ke CONFIRMED | MFE (ATR) | MAE (ATR) |
|---|---|---|---|---|---|---|---|---|
| 5m | successfulReversal | −24 (−24…+2), n = 34 | −24 (−27…+2), n = 42 | −15 (−21…+11), n = 34 | 1 (1–2), n = 34 | 9 (3–17), n = 32 | 2,00 (2,00–2,00), n = 40 | −0,55 (−1,52…−0,21), n = 40 |
| 5m | failedBounce | −14 (−46…+71), n = 15 | −23 (−55…−7), n = 20 | −14, n = 15 | 14 (4–31), n = 6 | — (n = 0) | 1,44 (0,44–2,00), n = 17 | −1,33 (−2,27…−0,32), n = 17 |
| 5m | longSideways | −47 (−60…−9), n = 19 | −48, n = 26 | −47, n = 19 | 15 (14–19), n = 7 | — | 0,98 (0,75–1,31), n = 33 | −1,70 (−2,08…−1,42), n = 33 |
| 5m | suddenPump | −47 (−64…+62), n = 33 | −47, n = 47 | −47, n = 33 | 23 (7–27), n = 26 | 28 (27–28), n = 14 | 2,00 (0,69–2,00), n = 28 | −1,52 (−2,12…−1,31), n = 28 |
| 15m | successfulReversal | −7 (−9…−3), n = 40 | −20 (−21…−9), n = 107 | 0 (−2…+5), n = 40 | 3 (2–4), n = 103 | 4 (3–5), n = 103 | 2,00 (2,00–2,00), n = 107 | −0,27 (−0,68…−0,14), n = 107 |
| 15m | failedBounce | −25 (−36…−14), n = 24 | −28, n = 28 | −25, n = 24 | 6 (0–15), n = 24 | 0 (0–5), n = 12 | 0,64 (0,15–1,25), n = 25 | −1,40 (−1,92…−1,16), n = 25 |
| 15m | longSideways | −13 (−19…−2), n = 25 | −24, n = 43 | −13, n = 25 | 0 (0–14), n = 20 | 6 (0–17), n = 24 | 0,93 (0,29–1,59), n = 58 | −1,49 (−2,11…−1,03), n = 58 |
| 15m | suddenPump | −13 (−44…+67), n = 36 | −13, n = 64 | −13, n = 36 | 9 (3–30), n = 43 | 17 (2–30), n = 37 | 1,29 (0,75–2,00), n = 58 | −1,43 (−1,89…−0,98), n = 58 |

Bacaan: pada MEDIUM, kandidat pertama Reversal Radar muncul **setelah** sinyal QUIET/EARLY_BULLISH mesin lama (15m: 7
candle; 5m: 24 candle) dan kira-kira bersamaan dengan alert lama pertama (15m median 0). Pada reversal sukses deteksi
MEDIUM terjadi ≈ 3 candle sebelum close pertama di atas level pemicu dan 4 candle sebelum CONFIRMED — jadi "lebih dini
dari breakout", tetapi tidak lebih dini dari mesin lama. MAE median reversal sukses kecil (−0,27 ATR di 15m).

### 2.4 False positive

| TF | Skenario | Sens. | Seri | Kandidat (FP) | FP/seri | Seri berkandidat | Terlambat saat deteksi (LATE_ENTRY/EXTENDED) |
|---|---|---|---|---|---|---|---|
| 5m | continuedDowntrend | LOW / MEDIUM / HIGH | 40 | 0 / 9 / 20 | 0,00 / 0,23 / 0,50 | 0 % / 22,5 % / 50,0 % | — / 0/9 / 0/20 |
| 5m | suddenPump | LOW / MEDIUM / HIGH | 40 | 3 / 47 / 182 | 0,07 / 1,18 / 4,55 | 7,5 % / 82,5 % / 100 % | 1/3 / 18/47 = 38,3 % / 46/182 = 25,3 % |
| 5m | uptrendContinuation | semua | 40 | 0 | 0,00 | 0/40 (CI 0,0–8,8 %) | — |
| 15m | continuedDowntrend | LOW / MEDIUM / HIGH | 40 | 0 / 3 / 125 | 0,00 / 0,07 / 3,13 | 0 % / 7,5 % / 100 % | — / 0/3 / 0/125 |
| 15m | suddenPump | LOW / MEDIUM / HIGH | 40 | 4 / 64 / 223 | 0,10 / 1,60 / 5,58 | 10,0 % / 90,0 % / 100 % | 0/4 / 12/64 = 18,8 % / 47/223 = 21,1 % |
| 15m | uptrendContinuation | semua | 40 | 0 | 0,00 | 0/40 (CI 0,0–8,8 %) | — |

`suddenPump`: pada 15m HIGH 158/223 kandidat dibuka di fase `flat` **sebelum** pump (sideways sempit yang mirip
`longSideways`), 1 saat pump, 51 sesudahnya; harapan "tanpa kandidat sebelum pump" tidak terpenuhi pada MEDIUM/HIGH.

### 2.5 Sensitivitas vs kecepatan deteksi vs false positive
Ringkasan per timeframe (semua skenario digabung; lead = kandidat pertama vs sinyal lama pertama):

| TF | Sens. | Kandidat (per seri) | SUCCESS (berlabel) | Batal | Lead vs lama — kandidat pertama | FP downtrend (seri) | FP pump (seri) |
|---|---|---|---|---|---|---|---|
| 5m | LOW | 39 (0,12) | 34/36 = 94,4 % (81,9–98,5) | 0/39 | −24, n = 37 | 0 % | 7,5 % |
| 5m | MEDIUM | 210 (0,66) | 94/173 = 54,3 % (46,9–61,6) | 45/210 = 21,4 % | −24, n = 135 | 22,5 % | 82,5 % |
| 5m | HIGH | 1 152 (3,60) | 352/992 = 35,5 % (32,6–38,5) | 425/1 152 = 36,9 % | +39, n = 177 | 50,0 % | 100 % |
| 15m | LOW | 84 (0,26) | 63/81 = 77,8 % (67,6–85,5) | 51/84 = 60,7 % | −9, n = 60 | 0 % | 10,0 % |
| 15m | MEDIUM | 388 (1,21) | 215/362 = 59,4 % (54,3–64,3) | 213/388 = 54,9 % | −9, n = 165 | 7,5 % | 90,0 % |
| 15m | HIGH | 1 779 (5,56) | 479/1 615 = 29,7 % (27,5–31,9) | 1 113/1 779 = 62,6 % | +51, n = 177 | 100 % | 100 % |

Untuk `successfulReversal` 15m: LOW 37 kandidat (0,93/seri; 26/40 seri berkandidat) SUCCESS 31/37 = 83,8 %; MEDIUM 107
(2,67/seri; 40/40 seri) 86,9 %; HIGH 456 (11,4/seri) 42,3 %. HIGH mendeteksi jauh lebih dini (+51 candle vs mesin lama)
**hanya** karena 40/40 kandidat pertamanya adalah false start di fase `decline`/`shallower` (sebelum dasar rencana);
LOW melewatkan 14/40 seri reversal sukses. MEDIUM adalah kompromi: semua seri reversal sukses terdeteksi, FP downtrend
7,5 % seri (15m), tetapi pump/sideways masih sering berkandidat.

### 2.6 Uji anti-look-ahead
Set evaluasi: 24 seri diperiksa (1 per skenario × TF; 4 indeks acak per seri + 1 replay prefiks), **0 gagal**. Set
penyetelan: 24 diperiksa, 0 gagal. Uji dengan mesin yang sengaja curang (tes `UNIT-RRV-056`) menghasilkan kode keluar 4.

### 2.7 Kekhawatiran state machine (angka untuk agent A; set evaluasi, HIGH = semua kandidat)
1. **EARLY dibuka pada pantulan di downtrend berlanjut** — 15m: 125 kandidat pada 40/40 seri; tahap awal
   EARLY/DEVELOPING/CONFIRMED = 94/12/19; penutupan: 106 close < invalidasi + 17 breakout gagal (2 masih terbuka saat
   data habis); median terbuka **1 candle** (Q1–Q3 1–2); 123/125 = 98,4 % batal; 0 SUCCESS. Bukti saat deteksi pertama:
   BOTTOM_HELD 80 %, RSI_DIVERGENCE 72 %, SPRING_RECLAIM 22 %, TRIGGER_BREAK 15 %, BREAK_FOLLOW_THROUGH 15 %,
   LL_SHALLOWER 14 %, QUIET_RISE 12 %, **LL_STOPPED hanya 10 %** → pemicunya BOTTOM_HELD + RSI_DIVERGENCE (dua bukti grup
   EXHAUSTION/BASE = `minEarlyEvidence` 2), bukan LL_STOPPED + QUIET_RISE. 5m (histeresis 2 candle): 20 kandidat
   (0,50/seri), semua close < invalidasi, median 4 candle; bukti: BOTTOM_HELD 90 %, LL_STOPPED 75 %, LL_SHALLOWER 65 %.
2. **CONFIRMED sesaat (BREAK_FOLLOW_THROUGH dua close berurutan)** — 15m `successfulReversal`: 325/456 = 71,3 % kandidat
   mencapai CONFIRMED, **226/325 = 69,5 %** lalu BREAKOUT_FAILED; kandidat yang dibuka **langsung** sebagai CONFIRMED:
   156, gagal 136 (87,2 %); yang mencapai CONFIRMED lewat EARLY/DEVELOPING: 169, gagal 90 (53 %). Skenario lain 15m:
   `longSideways` 72/73 = 98,6 % breakout gagal setelah CONFIRMED, `failedBounce` 72/73 = 98,6 %, `continuedDowntrend`
   17/19 = 89,5 %, `suddenPump` 51/91 = 56,0 %. Saat deteksi, TRIGGER_BREAK hadir pada 36 % dan BREAK_FOLLOW_THROUGH
   34 % kandidat reversal sukses, BREAK_VOLUME_SUPPORT **0 %** → CONFIRMED hampir selalu lewat follow-through, bukan
   volume. 5m: 103/182 = 56,6 % (reversal sukses); skenario lain tidak mencapai CONFIRMED.
3. **Ambang yang belum teruji** (frekuensi bukti, 15m; % evaluasi lolos / % kandidat memuatnya saat deteksi):
   - `ROUNDED_BOTTOM` (bowlMinR2 0,6): reversal sukses 7 % / 0 %, suddenPump 9 % / 2 %, longSideways 4 % / 3 %,
     continuedDowntrend 0 % — tidak diskriminatif dan nyaris tidak pernah ada saat deteksi; dasar sintetis berbentuk
     zigzag, bukan mangkuk, jadi **tidak bisa disetel dari sintetis**.
   - `RISING_FLOOR` (risingFloorMinSlopeAtr 0,05, minSwings 3, maxRangeAtr 4): 0 % di semua skenario (maks 1 % kandidat)
     — tidak pernah lolos; perlu data nyata atau fixture dasar naik khusus.
   - `BOTTOM_HELD` (bottomHeldDepartAtr 1): reversal sukses 26 % / 32 % vs longSideways 58 % / 81 %, suddenPump 52 % / 66 %,
     failedBounce 35 % / 68 %, continuedDowntrend 5 % / 80 % — lebih sering pada sideways/pump daripada reversal sukses
     (arah sebaliknya dari yang diinginkan) dan menjadi bukti dominan pada false positive downtrend.
   - `VOLUME_DRY_UP` (rasio 10 vs 30 candle ≤ 0,7): 0 % di semua skenario — fixture menurunkan volume linear 80 → 45 selama
     32–48 candle sehingga rasio 10 vs 30 candle ≈ 0,74 > 0,7; bukti ini **tidak teruji** pada sintetis (keterbatasan
     fixture, lihat §5). `CVD_DIVERGENCE` juga 0 % (fixture tanpa informasi taker).
   - Pembanding yang diskriminatif pada sintetis: `STAIRCASE` 17 % / 25 % (reversal) vs ≤ 4 % (lainnya), `CHOCH_BULLISH`
     20 % / 18 % vs ≤ 12 %, `TRIGGER_BREAK`/`BREAK_FOLLOW_THROUGH` 17 %/15 % vs ≤ 7 %.
4. **Deteksi per fase rencana** (`successfulReversal` 15m): 184/456 = 40,4 % kandidat dibuka **sebelum** low terendah
   (fase `decline` 15, `shallower` 169); kandidat pertama tiap seri: decline 14, shallower 26 (40/40 false start);
   kandidat pertama pada/setelah dasar dibuka median 47 candle (40–48) sebelum breakout rencana (≈ awal fase `base`).

## 3. Set penyetelan (seed 1–20) — hanya untuk menyetel parameter
Perintah: `npm run reversal:replay -- --synthetic --seeds 1-20 --tuning --timeframes 5m,15m,1h --check-lookahead`
File: `reports/tuning/reversal-replay-20261026T185640Z.md` (480 seri, 105 858 evaluasi, 2 281 kandidat, 65,3 s; 24 seri
anti-look-ahead, 0 gagal). **Tidak ada parameter yang diubah** pada run ini. Angka set ini in-sample dan bukan hasil
evaluasi; arah temuannya sama dengan §2:

| Ukuran (15m, HIGH kecuali disebut) | Set penyetelan (1–20) | Set evaluasi (21–60) |
|---|---|---|
| continuedDowntrend: seri berkandidat | 18/20 = 90,0 % (63 kandidat; E/D/C 41/5/17; 46 close < inv. + 17 breakout gagal; median 1 candle) | 40/40 = 100 % (125; 94/12/19; 106 + 17; median 1 candle) |
| continuedDowntrend MEDIUM: kandidat | 1 (5,0 % seri) | 3 (7,5 % seri) |
| successfulReversal: CONFIRMED sesaat | 106/157 = 67,5 %; dibuka langsung CONFIRMED gagal 68/79 = 86,1 % | 226/325 = 69,5 %; 136/156 = 87,2 % |
| successfulReversal MEDIUM: SUCCESS | 38/45 = 84,4 % (CI 71,2–92,3 %) | 93/107 = 86,9 % (CI 79,2–92,0 %) |
| successfulReversal MEDIUM: lead kandidat pertama vs lama (15m / 5m) | −9 (n = 20) / −24 (n = 16) | −7 (n = 40) / −24 (n = 34) |
| successfulReversal: kandidat sebelum dasar | 90/219 = 41,1 % | 184/456 = 40,4 % |
| Frekuensi bukti ROUNDED_BOTTOM / RISING_FLOOR / VOLUME_DRY_UP (reversal sukses, % evaluasi) | 7 % / 0 % / 0 % | 7 % / 0 % / 0 % |
| BOTTOM_HELD: reversal sukses vs longSideways (% evaluasi) | 26 % vs 59 % | 26 % vs 58 % |

Usulan untuk agent A (diuji pada seed 1–20 lebih dulu, lalu dikonfirmasi pada 21–60 — keputusan di §7):
- (a) EARLY: `minEarlyEvidence` 2 → 3, atau EARLY wajib memuat ≥ 1 bukti selain BOTTOM_HELD/RSI_DIVERGENCE (mis.
  LL_STOPPED/LL_SHALLOWER/RANGE_CONTRACTION), karena 94/125 kandidat downtrend berlanjut dibuka EARLY dengan
  BOTTOM_HELD + RSI_DIVERGENCE saja dan 98 % batal dalam 1–2 candle. Ukur ulang: seri berkandidat `continuedDowntrend`
  HIGH (target ≤ 15 %) dan seri berkandidat `successfulReversal` MEDIUM (harus tetap 100 %).
- (b) CONFIRMED: jangan membuka kandidat **langsung** pada CONFIRMED_BREAKOUT (wajib lewat EARLY/DEVELOPING dengan
  histeresis) dan/atau follow-through minimal 2 close ≥ pemicu + `followThroughAtr` 0,3 → 0,5 ATR, atau wajibkan
  BREAK_VOLUME_SUPPORT untuk CONFIRMED pada 15m/1h. Ukur ulang: "CONFIRMED sesaat" (69,5 % → target < 30 %) dan lead ke
  CONFIRMED pada reversal sukses (sekarang 4 candle).
- (c) `bowlMinR2` 0,6, `risingFloorMinSlopeAtr` 0,05, `bottomHeldDepartAtr` 1, `volumeDryUpRatio` 0,7: **jangan diubah
  berdasarkan sintetis** — ROUNDED_BOTTOM/RISING_FLOOR/VOLUME_DRY_UP tidak pernah/nyaris tidak pernah lolos di sini
  (fixture tidak memuat bentuk itu), sedangkan BOTTOM_HELD lolos lebih sering pada sideways/pump. Butuh data nyata (§6)
  atau fixture tambahan (dasar mangkuk, lantai naik, volume mengering tajam).
- (d) Lead: pada MEDIUM kandidat pertama 7–9 candle (15m) / 24 candle (5m) **setelah** sinyal lama pertama. Filter
  sensitivitas adalah konstanta kontrak (`SENSITIVITY_FILTERS`, FINAL); jangan diubah sebelum §6 terisi.
- (e) DATA_QUALITY: satu candle rusak/5 candle volume nol di dalam jendela 300 candle membuat 94,5 % evaluasi
  `brokenData` DATA_QUALITY. Usul: periksa kualitas hanya pada `requiredCandles` (120) candle terakhir, atau anggap
  anomali yang lebih tua dari warm-up tidak fatal (dengan risiko DATA_QUALITY tetap dilaporkan).

## 4. Perbandingan mesin lama vs Reversal Radar (set evaluasi, HIGH = semua kandidat)

| TF | Skenario | Seri dengan sinyal lama | Sinyal lama (total) | Seri dengan kandidat baru | Kandidat baru (total) | Indeks pertama lama / baru (median) | Lead vs lama — kandidat pertama | Lead — semua kandidat |
|---|---|---|---|---|---|---|---|---|
| 5m | successfulReversal | 40/40 | 91 | 40/40 | 316 | 264 / 218 | +49 candle, n = 40 | +15, n = 316 |
| 5m | failedBounce | 28/40 = 70,0 % | 28 | 40/40 | 127 | 301 / 277 | +28, n = 28 | −17, n = 92 |
| 5m | continuedDowntrend | 0/40 | 0 | 20/40 = 50,0 % | 20 | — / 151 | — | — |
| 5m | longSideways | 29/40 = 72,5 % | 29 | 40/40 | 179 | 218 / 192 | +25, n = 29 | −20, n = 126 |
| 5m | suddenPump | 40/40 | 73 | 40/40 | 182 | 218 / 192 | +47, n = 40 | −8, n = 182 |
| 5m | brokenData | 0/40 | 0 | 12/40 = 30,0 % | 12 | — / 151 | — | — |
| 5m | uptrendContinuation | 3/40 = 7,5 % | 3 | 0/40 | 0 | 227 / — | — | — |
| 15m | successfulReversal | 40/40 | 91 | 40/40 | 456 | 264 / 210 | +51 candle, n = 40 | +11, n = 456 |
| 15m | failedBounce | 28/40 = 70,0 % | 28 | 40/40 | 275 | 301 / 225 | +66, n = 28 | +20, n = 178 |
| 15m | continuedDowntrend | 0/40 | 0 | 40/40 = 100 % | 125 | — / 170 | — | — |
| 15m | longSideways | 29/40 = 72,5 % | 29 | 40/40 | 232 | 218 / 191 | +27, n = 29 | −30, n = 157 |
| 15m | suddenPump | 40/40 | 73 | 40/40 | 223 | 218 / 191 | +48, n = 40 | −2, n = 223 |
| 15m | brokenData | 0/40 | 0 | 12/40 = 30,0 % | 12 | — / 150 | — | — |
| 15m | uptrendContinuation | 3/40 = 7,5 % | 3 | 0/40 | 0 | 227 / — | — | — |

Bacaan: mesin lama **tidak pernah** bersinyal pada `continuedDowntrend`/`brokenData` dan jarang pada `uptrendContinuation`
(3/40), sedangkan Reversal Radar pada HIGH berkandidat di 100 % seri downtrend berlanjut (15m). Pada HIGH Reversal Radar
lebih dini (+49…+66 candle) tetapi lewat false start; pada MEDIUM (§2.3) ia lebih lambat dari sinyal lama pertama.
`lowVolumeIlliquid` = `successfulReversal` (tidak diulang).

## 5. Keterbatasan
- Data sintetis dibangun dengan bentuk yang diketahui; detektor yang "cocok" di sini belum tentu akurat di pasar nyata,
  dan skenario false positive sintetis (zigzag teratur) bisa lebih mudah/sulit daripada pasar nyata.
- Horizon 48 candle dan target 2 ATR adalah pilihan desain §10, bukan hasil optimasi.
- 5m sintetis tanpa HTF 1h yang memadai (lihat §1.5); 15m dan 1h identik karena bentuk & parameter sama.
- Fixture tidak memuat dasar mangkuk, lantai naik, volume mengering tajam, maupun informasi taker (CVD), sehingga
  ROUNDED_BOTTOM, RISING_FLOOR, VOLUME_DRY_UP, CVD_DIVERGENCE tidak teruji (0 %); `lowVolumeIlliquid` hanya menguji bahwa
  kelas likuiditas tidak mengubah deteksi.
- Pembanding lama mode `fast` tidak mereproduksi gerbang tier v3 untuk indeks alert (sinyal pertama tetap identik).
- Lead "kandidat pertama" mengabaikan apakah kandidat itu benar; baca bersama "kandidat sebelum dasar" (§2.7 butir 4).

## 6. Perbandingan data nyata di Mac (dijalankan pengguna)

Binance diblokir dari lingkungan cloud; replay data nyata **hanya** dapat dijalankan pengguna di Mac. Data di-cache di
`data/backtest-cache` (gitignored) sehingga run berikutnya tidak mengunduh ulang bulan yang sudah lengkap.

Perintah persis (urutan ini):

```bash
cd ~/Caddle            # folder repositori di Mac
git pull
npm ci                 # hanya bila dependensi berubah
npm run reversal:replay -- --top 20 --timeframes 5m,15m,1h --from 2025-06-01 --to 2025-10-01 --check-lookahead
# opsional, simbol tertentu & pembanding lama parameter live:
npm run reversal:replay -- --symbols BTCUSDT,ETHUSDT,SOLUSDT --timeframes 15m,1h --from 2025-01-01 --to 2025-10-01 --old full
```

Yang perlu disalin kembali ke dokumen ini (bagian 6.1–6.3): dari `reports/reversal-replay-<timestamp>.md` salin **utuh**
(a) daftar "Parameter" (simbol, rentang, horizon), (b) tabel "Ringkasan per timeframe", (c) tabel "Per timeframe ×
skenario × sensitivitas" (skenario = `dataNyata`), (d) tabel "Lead deteksi", (e) tabel "Alasan penutupan & breakout
gagal" dan "Frekuensi bukti per skenario" (untuk memutuskan usulan §3 c), (f) bagian "Uji anti-look-ahead", dan
(g) seluruh "Peringatan kejujuran". Jangan menyalin ringkasan stdout saja. Lampirkan juga
`reports/reversal-replay-<timestamp>.json` (di luar git, `reports/` gitignored) bila diminta analisis lanjutan.

### 6.1 Parameter run
<!-- diisi dari reports/reversal-replay-<timestamp>.md bagian "Parameter" -->

### 6.2 Hasil
<!-- diisi dari bagian "Ringkasan per timeframe", "Per timeframe × skenario × sensitivitas", "Lead deteksi", "Alasan penutupan & breakout gagal", "Frekuensi bukti per skenario" -->

| TF | Sens. | Seri | Kandidat | Kand./seri | SUCCESS (k/n, CI) | FAIL | TIMEOUT | Batal | Kedaluwarsa | Lead vs lama — kandidat pertama (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| <!-- diisi --> | | | | | | | | | | |

### 6.3 Peringatan kejujuran & anti-look-ahead
<!-- diisi utuh dari bagian "Peringatan kejujuran" dan "Uji anti-look-ahead" -->

**Tidak ada klaim** tentang akurasi di pasar nyata sebelum bagian 6.1–6.3 terisi dari run yang benar-benar dijalankan;
bila terisi pun, hasilnya adalah statistik historis periode itu dengan interval kepercayaan, bukan jaminan masa depan.

## 7. Keputusan
- Parameter `DEFAULT_REVERSAL_PARAMS` (commit `6bdb4d1`): **dipertahankan tanpa perubahan** pada run ini. Usulan a–e di
  §3 menunggu keputusan agent A dan harus diuji pada seed 1–20, lalu dikonfirmasi pada 21–60 dengan laporan baru
  (nama file dicatat di sini).
- Sensitivitas default UI: **MEDIUM dipertahankan sementara** — pada set evaluasi 15m: reversal sukses terdeteksi di
  40/40 seri dengan SUCCESS 86,9 % (CI 79,2–92,0 %), FP downtrend 7,5 % seri; HIGH memenuhi "lebih dini" hanya lewat false
  start (100 % kandidat downtrend berlanjut, 100 % seri), LOW melewatkan 35 % seri reversal sukses.
- Target §10 yang **tidak terpenuhi** (continuedDowntrend ≤ 15 % pada HIGH; lead kandidat pertama > 0 pada MEDIUM) tidak
  diubah; keduanya dibaca sebagai temuan untuk penyetelan (usulan a, b, d), bukan dilonggarkan.
- Keputusan final tentang parameter dan sensitivitas menunggu §6 (data nyata) terisi.
<!-- diisi setelah §6 terisi: parameter/sensitivitas default yang dipertahankan atau diubah, beserta alasan yang merujuk angka & file laporan -->
