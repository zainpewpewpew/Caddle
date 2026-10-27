# 21 — Validasi "Reversal Radar": laporan replay historis

Status: **hasil sintetis terisi, sebelum dan sesudah penyetelan; data nyata run 1, run 2, dan run 3 terisi; uji luar sampel run 4 ditetapkan, belum dijalankan** (2026-10-27). Mesin
`backend/reversal` **sesudah penyetelan** = commit `1e3bf9b` (parameter `DEFAULT_REVERSAL_PARAMS` bawaan saat ini, juga
yang dipakai run 1 data nyata); **sebelum penyetelan** = commit `6bdb4d1` (parameter awal agent A). Bagian data nyata (§6)
berisi hasil run 1 yang dijalankan pengguna di Mac (§6.1–§6.4), perubahan harness untuk run 2 dan target yang ditetapkan
sebelum run 2 (§6.5), hasil run 2 beserta bacaannya (§6.6–§6.7), tambahan harness + target untuk run 3 (§6.8), hasil run 3 dan vonis aturan
pra-registrasi (§6.9), serta pra-registrasi uji luar sampel terakhir run 4 (§6.10). Setiap placeholder `<!-- diisi dari reports/... -->` wajib diganti
dengan nilai dari file laporan yang disebutkan beserta nama filenya.

File laporan yang dikutip (semua `reports/` gitignored; buat ulang dengan perintah di §2/§3 bila perlu):

| Label | Mesin | Benih | File |
|---|---|---|---|
| **sesudah, evaluasi** | `1e3bf9b` (default sekarang) | 21–60 | `reports/evaluation/reversal-replay-20261026T191914Z.md` (+ `.json`) |
| **sesudah, penyetelan** | `1e3bf9b` | 1–20 | `reports/tuning/reversal-replay-20261026T191914Z.md` (+ `.json`) |
| sebelum, evaluasi | `6bdb4d1` | 21–60 | `reports/evaluation/reversal-replay-20261026T185647Z.md` (sudah ditimpa; angkanya disalin di kolom "sebelum") |
| sebelum, penyetelan | `6bdb4d1` | 1–20 | `reports/tuning/reversal-replay-20261026T185640Z.md` (idem) |
| varian penyetelan | `1e3bf9b` + `--params` | 1–20, 5m+15m | `scratchpad/tune/{old,g1,t10,new,b8,b8a5,b8a8}/reversal-replay-*.md` (lokal integrator, lihat §3) |
| **data nyata, run 1** | `1e3bf9b` (main setelah PR #21) | — (Binance, 16 simbol, 2025-06-01 → 2025-10-01) | `reports/reversal-replay-20261026T201517Z.md` (+ `.json`), dijalankan pengguna di Mac, dilampirkan di thread proyek |
| **data nyata, run 2** | `1e3bf9b` (main setelah PR #22; laporan diperluas) | — (data sama dengan run 1) | `reports/reversal-replay-20261026T205952Z.md` (+ `.json`), dijalankan pengguna di Mac, dilampirkan di thread proyek |
| **data nyata, run 3** | `1e3bf9b` (main setelah PR #23; basis per subset, bin skor, ekspektasi) | — (Binance, 17 simbol — BULLA masuk, APR keluar — 2025-06-01 → 2025-10-01) | `reports/reversal-replay-20261026T233542Z.md` (+ `.json`), dijalankan pengguna di Mac, dilampirkan di thread proyek |
| data nyata, run 4 (luar sampel) | main setelah PR tindak lanjut run 3 | — (Binance, `--top 20`, 2026-06-01 → 2026-10-01) | belum dijalankan — lihat §6.10 |

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
  (candle berjalan) dalam replay — `provisionalFree: true`. Nol anomali kontrak state machine pada 1 440 seri per run.
- Waktu deteksi = `closeTime` candle tempat kondisi dapat diamati (termasuk keterlambatan konfirmasi swing 2 candle).
- Uji stabilitas prefiks (`assertNoLookahead`, CLI `--check-lookahead`): replay penuh, lalu evaluasi diulang pada prefiks
  `candles.slice(0, k+1)` yang dibangun dari nol (HTF ikut dipotong/diagregasi dari prefiks) untuk 4 `k` acak berbenih;
  hasil wajib identik. Replay pada prefiks juga dibandingkan: kandidat/tahap/penutupan sampai `k` tidak boleh berubah saat
  candle masa depan ditambahkan. CLI menjalankan uji ini **sebelum** replay utama seri yang sama, sehingga mesin yang
  menyimpan keadaan lintas panggilan ("hafal" candle berikutnya) ikut terdeteksi. Kegagalan = hasil replay tidak sah
  (kode keluar 4).
- Kualitas data: sejak `1e3bf9b`, candle rusak/gap/volume nol beruntun yang lebih tua dari sufiks bersih sepanjang
  ≥ warm-up tidak lagi membutakan seri (evaluasi memakai sufiks bersih, `measures.candlesDropped`, risiko
  `DATA_QUALITY` tetap dilaporkan; docs/19 §3.1). Lihat §2.7 butir 5 mengenai mengapa hal ini belum terlihat pada
  skenario `brokenData`.

### 1.2 Definisi keberhasilan (§10, tetap)
Dari **close deteksi pertama** (event `OPENED`): target `+2 × ATR deteksi`, stop `levels.invalidation` saat deteksi,
horizon 48 candle (semua timeframe). Urutan intrabar tidak diketahui → TP & SL pada candle yang sama = **FAIL**; open
melewati stop = keluar di open. `SUCCESS | FAIL | TIMEOUT`; `OPEN` (data habis) dan kandidat tanpa level invalidasi/ATR
dikecualikan dari penyebut rasio dan dilaporkan terpisah. Pelabelan memakai `labelTrade` (`backend/backtest/labeler.js`)
tanpa biaya. Definisi ini **tidak boleh disetel** setelah melihat hasil; perubahan definisi = laporan baru dengan versi
metodologi baru (`REVERSAL_VERSION`). Definisi ini tidak berubah antara run "sebelum" dan "sesudah".

Target awal §10 (hipotesis, diperiksa otomatis di bagian "Pemeriksaan target §10" laporan):
`successfulReversal` SUCCESS ≥ 60 % pada MEDIUM; `continuedDowntrend` ≤ 15 % seri berkandidat (HIGH = semua kandidat);
`uptrendContinuation` 0 kandidat; median lead **kandidat pertama tiap seri** vs **sinyal lama pertama** > 0 candle
(MEDIUM). Catatan: definisi lead "kandidat pertama" dipertegas sebelum angka set evaluasi dibaca; laporan juga memuat lead
semua kandidat sebagai pembanding (kandidat lanjutan wajar bernilai negatif).

### 1.3 Pemisahan benih penyetelan dan evaluasi
- **Set penyetelan**: seed 1–20 (`--seeds 1-20 --tuning`). Hanya set ini yang boleh dipakai untuk menyetel parameter
  `DEFAULT_REVERSAL_PARAMS`; varian diuji dengan `--params '<json>'` (override dicatat di bagian "Parameter" laporan).
- **Set evaluasi**: seed 21–60 (`--seeds 21-60`, bawaan). Tidak boleh dipakai untuk menyetel. CLI memberi peringatan dan
  laporan menandai `seedSet` bila benih penyetelan ikut dievaluasi.
- Urutan yang dijalankan: (1) run "sebelum" pada kedua set (parameter awal A); (2) varian parameter **hanya** pada seed
  1–20 (§3); (3) parameter terpilih dijadikan default (`1e3bf9b`); (4) run "sesudah" pada seed 21–60 sebagai konfirmasi
  out-of-sample (§2). Set evaluasi tidak dipakai untuk memilih parameter; namun karena hasil "sebelum" pada set evaluasi
  sudah dibaca sebelum penyetelan (§2.7 lama memberi arah usulan a–e), konfirmasi ini **tidak sepenuhnya buta** —
  dinyatakan apa adanya.

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
CONFIRMED, **CONFIRMED sesaat** (lihat definisi di §2.7 butir 2), **deteksi per fase rencana** dan lead terhadap
breakout rencana, **frekuensi tiap bukti** (% evaluasi yang meloloskannya / % kandidat yang memuatnya saat deteksi),
false positive pada `continuedDowntrend`/`suddenPump`/`uptrendContinuation`, perbandingan lama vs baru.

### 1.7 Tradeoff yang harus dibaca bersama
Sensitivitas lebih tinggi (HIGH) → lebih banyak kandidat & deteksi lebih dini, tetapi lebih banyak false positive dan
TIMEOUT; LOW → lebih selektif, lebih lambat (lead lebih kecil), lebih sedikit sampel. Keputusan default UI (MEDIUM)
hanya boleh diubah berdasarkan set penyetelan, lalu dikonfirmasi pada set evaluasi.

## 2. Hasil pada skenario sintetis — set evaluasi (seed 21–60), sesudah penyetelan, dengan kolom "sebelum"

Perintah: `npm run reversal:replay -- --synthetic --seeds 21-60 --timeframes 5m,15m,1h --scenarios all --check-lookahead`
File **sesudah**: `reports/evaluation/reversal-replay-20261026T191914Z.md` (+ `.json`), dibuat 2026-10-26 19:19 UTC. 960 seri
(8 skenario × 40 benih × 3 TF), 211 392 evaluasi mesin baru + 211 392 evaluasi mesin lama (mode `fast`), **3 668
kandidat** (sebelum: 4 710), durasi replay 122,7 s. File **sebelum**: `reversal-replay-20261026T185647Z.md` (mesin `6bdb4d1`).
Baris **1h identik dengan 15m** pada semua tabel di kedua run (bentuk chart sama, parameter 15m/1h sama; konteks HTF 1h pada
15m hanya mengubah risiko, bukan kandidat), sehingga 1h tidak diulang di bawah.

### 2.1 Pemeriksaan target §10

| TF | Target | Status sesudah | Nilai sesudah | Nilai sebelum |
|---|---|---|---|---|
| 5m | successfulReversal: SUCCESS ≥ 60 % pada MEDIUM | TERPENUHI | 29/34 = 85,3 % (CI 69,9–93,6 %) | 34/40 = 85,0 % (70,9–92,9 %) |
| 15m/1h | successfulReversal: SUCCESS ≥ 60 % pada MEDIUM | TERPENUHI | 97/103 = 94,2 % (CI 87,9–97,3 %) | 93/107 = 86,9 % (79,2–92,0 %) |
| 5m | continuedDowntrend ≤ 15 % seri berkandidat (HIGH) | **TIDAK terpenuhi** | 13/40 = 32,5 % (CI 20,1–48,0 %), 13 kandidat | 20/40 = 50,0 %, 20 kandidat |
| 15m/1h | continuedDowntrend ≤ 15 % seri berkandidat (HIGH) | **TIDAK terpenuhi** | 15/40 = 37,5 % (CI 24,2–53,0 %), 15 kandidat | 40/40 = 100 %, 125 kandidat |
| semua | uptrendContinuation 0 kandidat | TERPENUHI | 0 kandidat pada 40 seri per TF (semua sensitivitas) | 0 |
| 5m | median lead kandidat pertama vs sinyal lama pertama > 0 (MEDIUM) | **TIDAK terpenuhi** | median −31 candle (Q1–Q3 −32…+2), n = 29 | −24, n = 34 |
| 15m/1h | median lead kandidat pertama vs sinyal lama pertama > 0 (MEDIUM) | **TIDAK terpenuhi** | median −5 candle (−14…+3), n = 39; vs alert lama +4 (−9…+12) | −7, n = 40; vs alert lama 0 |

Pada sensitivitas **MEDIUM (default UI)** false positive downtrend jauh lebih rendah daripada HIGH, tetapi **naik**
dibanding sebelum penyetelan: 15m 7/40 seri = 17,5 % (CI 8,7–32,0 %; 7 kandidat; sebelum 3/40 = 7,5 %, 3 kandidat), 5m
10/40 = 25,0 % (CI 14,2–40,2 %; sebelum 9/40 = 22,5 %). Pada LOW 0/40 di kedua TF. Sebabnya dijelaskan di §2.7 butir 1:
kandidat downtrend yang tersisa kini dibuka sebagai DEVELOPING (skor lebih tinggi) sehingga lolos filter MEDIUM. Target
"≤ 15 % seri" hanya terpenuhi pada LOW; pada MEDIUM/HIGH **masih tidak terpenuhi** — tidak dilonggarkan.

### 2.2 Ringkasan per timeframe × skenario (sensitivitas MEDIUM)
Rasio hasil memakai kandidat berlabel (SUCCESS/FAIL/TIMEOUT); OPEN (data habis) dikecualikan dari penyebut. Kolom
"sebelum" = kandidat dan SUCCESS run `6bdb4d1`.

| TF | Skenario | Seri berkandidat | Kandidat (kand./seri) | SUCCESS (k/n, CI) | FAIL | TIMEOUT | Batal | Kedaluwarsa | Sebelum: kandidat · SUCCESS |
|---|---|---|---|---|---|---|---|---|---|
| 5m | successfulReversal | 29/40 = 72,5 % | 36 (0,90) | 29/34 = 85,3 % (69,9–93,6) | 5/34 = 14,7 % | 0/34 | 5/36 = 13,9 % | 31/36 = 86,1 % | 42 · 34/40 = 85,0 % |
| 5m | failedBounce | 29/40 = 72,5 % | 37 (0,93) | 4/17 = 23,5 % (9,6–47,3) | 10/17 = 58,8 % | 3/17 = 17,6 % | 5/37 = 13,5 % | 17/37 = 45,9 % | 28 · 6/17 = 35,3 % |
| 5m | continuedDowntrend | 10/40 = 25,0 % | 10 (0,25) | 0/10 = 0,0 % (0,0–27,8) | 10/10 = 100 % | 0/10 | 10/10 = 100 % | 0/10 | 9 · 0/9 |
| 5m | longSideways | 33/40 = 82,5 % | 56 (1,40) | 2/44 = 4,5 % (1,3–15,1) | 9/44 = 20,5 % | 33/44 = 75,0 % | 5/56 = 8,9 % | 47/56 = 83,9 % | 36 · 4/33 = 12,1 % |
| 5m | suddenPump | 34/40 = 85,0 % | 55 (1,38) | 16/41 = 39,0 % (25,7–54,3) | 12/41 = 29,3 % | 13/41 = 31,7 % | 6/55 = 10,9 % | 48/55 = 87,3 % | 47 · 16/28 = 57,1 % |
| 5m | lowVolumeIlliquid | identik successfulReversal | | | | | | | identik |
| 5m | brokenData | 5/40 = 12,5 % | 5 (0,13) | 0/5 = 0,0 % (0,0–43,4) | 5/5 = 100 % | 0/5 | 5/5 = 100 % | 0/5 | 6 · 0/6 |
| 5m | uptrendContinuation | 0/40 | 0 | — (n = 0) | — | — | — | — | 0 |
| 15m | successfulReversal | 39/40 = 97,5 % | 103 (2,58) | 97/103 = 94,2 % (87,9–97,3) | 6/103 = 5,8 % | 0/103 | 65/103 = 63,1 % | 38/103 = 36,9 % | 107 · 93/107 = 86,9 % |
| 15m | failedBounce | 27/40 = 67,5 % | 35 (0,88) | 1/15 = 6,7 % (1,2–29,8) | 9/15 = 60,0 % | 5/15 = 33,3 % | 6/35 = 17,1 % | 17/35 = 48,6 % | 40 · 3/25 = 12,0 % |
| 15m | continuedDowntrend | 7/40 = 17,5 % | 7 (0,17) | 0/7 = 0,0 % (0,0–35,4) | 7/7 = 100 % | 0/7 | 7/7 = 100 % | 0/7 | 3 · 0/3 |
| 15m | longSideways | 32/40 = 80,0 % | 54 (1,35) | 1/47 = 2,1 % (0,4–11,1) | 12/47 = 25,5 % | 34/47 = 72,3 % | 5/54 = 9,3 % | 47/54 = 87,0 % | 63 · 1/58 = 1,7 % |
| 15m | suddenPump | 32/40 = 80,0 % | 54 (1,35) | 18/47 = 38,3 % (25,8–52,6) | 11/47 = 23,4 % | 18/47 = 38,3 % | 7/54 = 13,0 % | 46/54 = 85,2 % | 64 · 25/58 = 43,1 % |
| 15m | lowVolumeIlliquid | identik successfulReversal | | | | | | | identik |
| 15m | brokenData | 5/40 = 12,5 % | 5 (0,13) | 0/5 = 0,0 % (0,0–43,4) | 5/5 = 100 % | 0/5 | 5/5 = 100 % | 0/5 | 4 · 0/4 |
| 15m | uptrendContinuation | 0/40 | 0 | — (n = 0) | — | — | — | — | 0 |

Bacaan: pada reversal sukses 15m, SUCCESS MEDIUM naik 86,9 % → 94,2 % dengan jumlah kandidat hampir sama (107 → 103) dan
churn tetap tinggi (63,1 % ditutup CANCELLED — sebagian besar BREAKOUT_FAILED **setelah** target harga tercapai, lihat
§2.7 butir 2). Pada 5m, 11/40 seri reversal sukses kini tidak punya kandidat MEDIUM (sebelum 6/40) dan kandidat MEDIUM
pertama sering baru muncul di fase breakout (§2.7 butir 4) — harga yang dibayar untuk pemicu "puncak range + umur dasar".
`lowVolumeIlliquid` identik dengan `successfulReversal` pada semua tabel: kelas likuiditas hanya menambah risiko (sesuai
kontrak), tidak mengubah deteksi.

### 2.3 Lead deteksi & ekskursi (sensitivitas MEDIUM)
Format kuantil: median (Q1–Q3), n. Lead positif = Reversal Radar lebih awal. Kolom "sebelum" = lead kandidat pertama,
MAE median run `6bdb4d1`.

| TF | Skenario | Lead vs lama — kandidat pertama | Lead vs lama — semua kandidat | vs alert lama (kandidat pertama) | vs breakout (close > pemicu) | ke CONFIRMED | MFE (ATR) | MAE (ATR) | Sebelum: lead · MAE |
|---|---|---|---|---|---|---|---|---|---|
| 5m | successfulReversal | −31 (−32…+2), n = 29 | −31 (−33…+2), n = 36 | −22 (−24…+11), n = 29 | 1 (0–3), n = 29 | 3 (0–11), n = 28 | 2,00 (2,00–2,00), n = 34 | −0,23 (−0,48…−0,08), n = 34 | −24 · −0,55 |
| 5m | failedBounce | −29 (−41…−18), n = 21 | −35 (−56…−24), n = 29 | −29, n = 21 | 8 (4–28), n = 9 | — (n = 0) | 0,65 (0,27–1,93), n = 17 | −2,25 (−2,47…−1,07), n = 17 | −14 · −1,33 |
| 5m | longSideways | −49 (−87…−17), n = 23 | −65 (−101…−21), n = 39 | −49, n = 23 | 19 (13–31), n = 12 | — | 1,11 (0,73–1,44), n = 44 | −1,71 (−2,12…−1,36), n = 44 | −47 · −1,70 |
| 5m | suddenPump | −51 (−84…+64), n = 34 | −58 (−90…+21), n = 55 | −51, n = 34 | 21 (6–27), n = 33 | 6 (0–19), n = 6 | 0,89 (0,46–2,00), n = 41 | −1,54 (−2,11…−1,04), n = 41 | −47 · −1,52 |
| 15m | successfulReversal | −5 (−14…+3), n = 39 | −20 (−27…−5), n = 103 | +4 (−9…+12), n = 39 | 4 (2–4), n = 98 | 4 (3–5), n = 98 | 2,00 (2,00–2,00), n = 103 | −0,23 (−0,37…−0,13), n = 103 | −7 · −0,27 |
| 15m | failedBounce | −24 (−35…−13), n = 20 | −29 (−37…−18), n = 26 | −24, n = 20 | 12 (8–19), n = 12 | — (n = 0) | 1,09 (0,54–1,30), n = 15 | −2,02 (−2,32…−1,78), n = 15 | −25 · −1,40 |
| 15m | longSideways | −19 (−43…−12), n = 22 | −44 (−68…−17), n = 38 | −19, n = 22 | 41 (21–46), n = 8 | — | 1,09 (0,50–1,42), n = 47 | −1,70 (−2,31…−1,44), n = 47 | −13 · −1,49 |
| 15m | suddenPump | −15 (−49…+64), n = 32 | −24 (−68…+58), n = 54 | −15, n = 32 | 24 (5–30), n = 33 | 31 (0–32), n = 18 | 1,16 (0,64–2,00), n = 47 | −1,67 (−2,06…−1,00), n = 47 | −13 · −1,43 |

Bacaan: pada MEDIUM, kandidat pertama Reversal Radar tetap muncul **setelah** sinyal QUIET/EARLY_BULLISH mesin lama (15m:
5 candle, sebelum 7; 5m: 31 candle, sebelum 24 — memburuk) dan kira-kira bersamaan dengan alert lama pertama (15m median
+4). Pada reversal sukses deteksi MEDIUM terjadi ≈ 4 candle sebelum close pertama di atas level pemicu dan 4 candle sebelum
CONFIRMED. MAE median reversal sukses mengecil (15m −0,27 → −0,23 ATR; 5m −0,55 → −0,23 ATR), sedangkan MAE skenario
pantulan gagal/sideways/pump tetap sekitar −1,5…−2,3 ATR (kandidat di sana memang keliru).

### 2.4 False positive

| TF | Skenario | Sens. | Kandidat (FP) — sesudah | FP/seri | Seri berkandidat — sesudah | Terlambat saat deteksi (LATE_ENTRY/EXTENDED) | Sebelum: kandidat · seri berkandidat |
|---|---|---|---|---|---|---|---|
| 5m | continuedDowntrend | LOW / MEDIUM / HIGH | 0 / 10 / 13 | 0,00 / 0,25 / 0,33 | 0 % / 25,0 % (CI 14,2–40,2) / 32,5 % (20,1–48,0) | — / 0/10 / 0/13 | 0 · 0 % / 9 · 22,5 % / 20 · 50,0 % |
| 5m | suddenPump | LOW / MEDIUM / HIGH | 5 / 55 / 198 | 0,13 / 1,38 / 4,95 | 12,5 % / 85,0 % / 100 % | 4/5 / 26/55 = 47,3 % / 66/198 = 33,3 % | 3 · 7,5 % / 47 · 82,5 % / 182 · 100 % |
| 5m | uptrendContinuation | semua | 0 | 0,00 | 0/40 (CI 0,0–8,8 %) | — | 0 |
| 15m | continuedDowntrend | LOW / MEDIUM / HIGH | 0 / 7 / 15 | 0,00 / 0,17 / 0,38 | 0 % / 17,5 % (CI 8,7–32,0) / 37,5 % (24,2–53,0) | — / 0/7 / 0/15 | 0 · 0 % / 3 · 7,5 % / 125 · 100 % |
| 15m | suddenPump | LOW / MEDIUM / HIGH | 5 / 54 / 206 | 0,13 / 1,35 / 5,15 | 12,5 % / 80,0 % / 100 % | 1/5 / 13/54 = 24,1 % / 55/206 = 26,7 % | 4 · 10,0 % / 64 · 90,0 % / 223 · 100 % |
| 15m | uptrendContinuation | semua | 0 | 0,00 | 0/40 (CI 0,0–8,8 %) | — | 0 |

`suddenPump` hampir tidak berubah: pada 15m HIGH 135/206 kandidat dibuka di fase `flat` **sebelum** pump (sebelum
158/223), 2 saat pump, 57 sesudahnya; harapan "tanpa kandidat sebelum pump" tetap tidak terpenuhi pada MEDIUM/HIGH —
sideways sempit yang mirip `longSideways` tetap menghasilkan DEVELOPING. Penyetelan ini tidak menyasar skenario itu.

### 2.5 Sensitivitas vs kecepatan deteksi vs false positive
Ringkasan per timeframe (semua skenario digabung; lead = kandidat pertama vs sinyal lama pertama):

| TF | Sens. | Kandidat (per seri) | SUCCESS (berlabel) | Batal | Lead — kandidat pertama | FP downtrend (seri) | FP pump (seri) | Sebelum: kandidat · SUCCESS · lead |
|---|---|---|---|---|---|---|---|---|
| 5m | LOW | 52 (0,16) | 43/45 = 95,6 % (85,2–98,8) | 0/52 | −32, n = 50 | 0 % | 12,5 % | 39 · 94,4 % · −24 |
| 5m | MEDIUM | 235 (0,73) | 80/185 = 43,2 % (36,3–50,4) | 41/235 = 17,4 % | −31, n = 136 | 25,0 % | 85,0 % | 210 · 54,3 % · −24 |
| 5m | HIGH | 1 020 (3,19) | 354/859 = 41,2 % (38,0–44,5) | 267/1 020 = 26,2 % | +36, n = 177 | 32,5 % | 100 % | 1 152 · 35,5 % · +39 |
| 15m | LOW | 77 (0,24) | 65/73 = 89,0 % (79,8–94,3) | 31/77 = 40,3 % | −20, n = 48 | 0 % | 12,5 % | 84 · 77,8 % · −9 |
| 15m | MEDIUM | 361 (1,13) | 214/327 = 65,4 % (60,1–70,4) | 160/361 = 44,3 % | −13, n = 152 | 17,5 % | 80,0 % | 388 · 59,4 % · −9 |
| 15m | HIGH | 1 324 (4,14) | 509/1 153 = 44,1 % (41,3–47,0) | 569/1 324 = 43,0 % | +47, n = 177 | 37,5 % | 100 % | 1 779 · 29,7 % · +51 |

Untuk `successfulReversal` 15m sesudah penyetelan: LOW 32 kandidat (0,80/seri; hanya 19/40 seri berkandidat) SUCCESS
32/32 = 100 % (CI 89,3–100 %); MEDIUM 103 (2,58/seri; 39/40 seri) 94,2 %; HIGH 371 (9,28/seri; 40/40) 197/337 = 58,5 %
(sebelum 42,3 %). HIGH tetap "lebih dini" (+47 candle vs mesin lama) **hanya** karena 40/40 kandidat pertamanya adalah
false start di fase `decline`/`shallower`; LOW kini melewatkan 21/40 seri reversal sukses (sebelum 14/40). MEDIUM tetap
kompromi terbaik: 39/40 seri reversal sukses terdeteksi, SUCCESS 94,2 %, tetapi FP downtrend 17,5 % seri dan pump/sideways
masih sering berkandidat.

### 2.6 Uji anti-look-ahead
Set evaluasi sesudah: 24 seri diperiksa (1 per skenario × TF; 4 indeks acak per seri + 1 replay prefiks), **0 gagal**.
Set penyetelan sesudah: 24 diperiksa, 0 gagal. Run "sebelum": 24/0 pada kedua set. Uji dengan mesin yang sengaja curang
(tes `UNIT-RRV-056`) menghasilkan kode keluar 4.

### 2.7 Kekhawatiran state machine — sesudah vs sebelum (set evaluasi, HIGH = semua kandidat)
1. **Kandidat pada pantulan di downtrend berlanjut** — 15m: **15 kandidat pada 15/40 seri** (sebelum 125 pada 40/40);
   tahap awal EARLY/DEVELOPING/CONFIRMED = 1/14/0 (sebelum 94/12/19); penutupan: 15 close < invalidasi, 0 breakout gagal
   (sebelum 106 + 17); median terbuka 5 candle (4–5) (sebelum 1); batal 100 %, 0 SUCCESS. Bukti saat deteksi: LL_STOPPED
   100 %, BOTTOM_HELD 100 %, EMA_CONVERGENCE 73 %, HIGHER_LOW 73 %, LL_SHALLOWER 53 %, SPRING_RECLAIM 40 %,
   RANGE_CONTRACTION 27 %, STAIRCASE 27 %, TRIGGER_BREAK 0 % (sebelum: BOTTOM_HELD 80 %, RSI_DIVERGENCE 72 %, LL_STOPPED
   10 %). Aturan "≥ 2 grup bukti" menghapus EARLY dari BOTTOM_HELD + RSI_DIVERGENCE saja; yang tersisa adalah pantulan yang
   sempat membentuk higher low (DEVELOPING) — berskor lebih tinggi sehingga 7 dari 15 lolos MEDIUM (sebelum 3 dari 125).
   5m (histeresis 2 candle): 13 kandidat (DEVELOPING 13), semua close < invalidasi, median 4 candle (sebelum 20 kandidat).
2. **CONFIRMED sesaat** — definisi di laporan: kandidat yang mencapai CONFIRMED_BREAKOUT lalu ditutup BREAKOUT_FAILED,
   **kapan pun**, termasuk setelah target +2 ATR tercapai (label harganya SUCCESS). 15m `successfulReversal`: mencapai
   CONFIRMED 205/371 = 55,3 % (sebelum 325/456 = 71,3 %); BREAKOUT_FAILED setelah CONFIRMED **123/205 = 60,0 %** (sebelum
   226/325 = 69,5 %); dibuka **langsung** sebagai CONFIRMED 30, gagal 12 = 40,0 % (sebelum 156, gagal 136 = 87,2 %). Pada
   MEDIUM: 98/103 mencapai CONFIRMED, 60 BREAKOUT_FAILED, tetapi SUCCESS 94,2 % — jadi mayoritas BREAKOUT_FAILED terjadi
   **sesudah** harga mencapai target. Definisi yang lebih tepat, **"gagal sebelum mencapai target"**, tidak tersedia di
   laporan agregat; analisis per-kandidat integrator (skrip `scratchpad/tune/confirmed-analysis.mjs`, seed 1–20, 15m,
   HIGH) memberi: dengan pemicu puncak range + 1,5 ATR **tanpa** umur dasar: 167/232 mencapai CONFIRMED (48 di fase
   `shallower`), BREAKOUT_FAILED 126 tetapi 63 di antaranya sudah mencapai +2 ATR → **gagal sebelum target 63/167 =
   38 %**, dibuka langsung CONFIRMED 59 (54 gagal); dengan umur dasar 8 (`minBaseBarsForTrigger`): 99/181 mencapai
   CONFIRMED, 0 di `shallower`, BREAKOUT_FAILED 58 (51 sudah mencapai +2 ATR) → **gagal sebelum target 7/99 = 7 %**,
   dibuka langsung CONFIRMED 9 (4 gagal). Skenario lain 15m sesudah: `longSideways` 0/203 mencapai CONFIRMED (sebelum
   73/232, 72 gagal), `failedBounce` 1/146 (sebelum 73/275), `continuedDowntrend` 0/15 (sebelum 19/125), `suddenPump`
   35/206 mencapai, 2 gagal = 5,7 % (sebelum 91/223, 51 = 56,0 %). 5m `successfulReversal`: 94/249 mencapai, 15 gagal =
   16,0 % (sebelum 182/316, 103 = 56,6 %). Angka "gagal sebelum target" untuk set evaluasi belum dihitung (butuh run
   skrip; tidak dijalankan pada iterasi ini) — kolom itu layak ditambahkan ke laporan pada iterasi berikutnya.
3. **Ambang yang belum teruji** (frekuensi bukti 15m sesudah; % evaluasi lolos / % kandidat memuatnya saat deteksi) —
   tidak berubah karena parameternya tidak disentuh:
   - `ROUNDED_BOTTOM` (bowlMinR2 0,6): reversal sukses 7 % / 0 %, suddenPump 9 % / 5 %, longSideways 4 % / 0 % — dasar
     sintetis berbentuk zigzag, bukan mangkuk; **tidak bisa disetel dari sintetis**.
   - `RISING_FLOOR` (risingFloorMinSlopeAtr 0,05, minSwings 3, maxRangeAtr 4): 0 % evaluasi di semua skenario (maks 1 %
     kandidat) — perlu data nyata atau fixture dasar naik khusus.
   - `BOTTOM_HELD` (bottomHeldDepartAtr 1): reversal sukses 25 % / 29 % vs longSideways 57 % / 89 %, suddenPump 51 % / 74 %,
     failedBounce 32 % / 79 %, continuedDowntrend 1 % / 100 % — tetap lebih sering pada sideways/pump dan hadir pada
     semua kandidat downtrend yang tersisa.
   - `VOLUME_DRY_UP` (rasio 10 vs 30 candle ≤ 0,7): 0 % — fixture menurunkan volume linear 80 → 45 selama 32–48 candle
     sehingga rasio ≈ 0,74 > 0,7; **tidak teruji** pada sintetis. `CVD_DIVERGENCE` 0 % (fixture tanpa informasi taker).
   - Pemicu sesudah penyetelan: `TRIGGER_BREAK` 13 % / 8 % pada reversal sukses vs 0 % pada downtrend/sideways/pantulan
     gagal (pump 2 % / 5 %) — sebelum 17 % / 36 % vs ≤ 7 %; `BREAK_FOLLOW_THROUGH` 11 % / 8 % vs 0–1 % (sebelum 15 % /
     34 %); `BREAK_VOLUME_SUPPORT` 3 % / 2 %. Pemicu kini hampir eksklusif untuk bentuk reversal.
4. **Deteksi per fase rencana** (`successfulReversal` 15m): HIGH — 125/371 = 33,7 % kandidat dibuka **sebelum** low
   terendah (sebelum 184/456 = 40,4 %); kandidat pertama tiap seri: decline 12, shallower 28 (tetap 40/40 false start pada
   HIGH); kandidat pertama pada/setelah dasar dibuka median 45 candle (38–46) sebelum breakout rencana (sebelum 47).
   **MEDIUM** — kandidat pertama tiap seri: `base` 29, `decline` 5, `higherLow` 5 (hanya 5/103 = 4,9 % kandidat sebelum
   dasar): pada 15m deteksi MEDIUM pertama umumnya di dasar. 5m MEDIUM: `breakout` 10, `higherLow` 9, `base` 5, `decline` 5
   — sepertiga seri baru terdeteksi saat breakout, sebab lead 5m −31 candle.
5. **Data rusak** — `brokenData` tetap 94,5 % evaluasi DATA_QUALITY (8 288/8 768 per TF; sama dengan sebelum) walaupun
   mesin kini memakai sufiks bersih: fixture menempatkan candle rusak di `base + 20` (≈ indeks 255–280 dari 370) dan
   volume nol di `base + 4`, sehingga sufiks bersih setelah kerusakan terakhir < warm-up 120 candle sampai seri habis.
   Perbaikan (4) **belum terverifikasi** oleh skenario ini; fixture perlu versi dengan kerusakan ≥ 120 candle sebelum akhir
   seri (iterasi berikutnya). Kandidat `brokenData` (12 pada HIGH, semua di fase `decline` sebelum kerusakan) tidak berubah.

## 3. Set penyetelan (seed 1–20) — pemilihan parameter
Perintah: `npm run reversal:replay -- --synthetic --seeds 1-20 --tuning --timeframes 5m,15m,1h --check-lookahead` (varian:
tambah `--params '{"…":…}'`). File sesudah: `reports/tuning/reversal-replay-20261026T191914Z.md` (480 seri, 105 858 evaluasi,
1 828 kandidat, 61,3 s; 24 seri anti-look-ahead, 0 gagal). File sebelum: `reversal-replay-20261026T185640Z.md` (2 281 kandidat).

### 3.1 Varian yang diuji (5m + 15m, seed 1–20, 320 seri per varian, mesin `1e3bf9b` dengan `--params`)
Override di kolom pertama persis seperti tercatat di bagian "Parameter" tiap laporan (relatif terhadap default saat
varian dijalankan: `minEarlyGroups` 2, `minTriggerAboveBottomAtr` 1,5, `minBaseBarsForTrigger` 0, `minBottomAge` 3).
"Downtrend" = seri berkandidat `continuedDowntrend` pada HIGH (jumlah kandidat dalam kurung); "CONFIRMED → gagal" =
BREAKOUT_FAILED setelah CONFIRMED pada `successfulReversal` 15m HIGH; "langsung CONFIRMED → gagal" = kandidat yang dibuka
langsung sebagai CONFIRMED lalu BREAKOUT_FAILED.

| Varian (`--params`) | Arti | 15m downtrend | 15m SUCCESS MEDIUM | 15m lead kand. pertama | 15m CONFIRMED → gagal | 15m langsung CONFIRMED → gagal | 5m downtrend | 5m SUCCESS MEDIUM | 5m lead |
|---|---|---|---|---|---|---|---|---|---|
| `{"minEarlyGroups":1,"minTriggerAboveBottomAtr":0}` | ≈ sebelum penyetelan (grup 1, pemicu tanpa syarat) | 18/20 = 90 % (63) | 38/45 = 84,4 % | −9, n = 20 | 106/157 = 67,5 % | 68/79 = 86,1 % | 8/20 = 40 % (8) | 19/20 = 95,0 % | −24, n = 16 |
| `{"minEarlyGroups":1}` | grup 1 + pemicu ≥ 1,5 ATR | 18/20 = 90 % (52) | 43/44 = 97,7 % | −5, n = 19 | 126/167 = 75,4 % | 52/53 = 98,1 % | 8/20 = 40 % (8) | 95,0 % | −24 |
| `{"minTriggerAboveBottomAtr":1}` | grup 2 + pemicu ≥ 1,0 ATR | 15/20 = 75 % (28) | 40/47 = 85,1 % | −9, n = 20 | 106/157 = 67,5 % | 68/83 = 81,9 % | 7/20 = 35 % (7) | 22/23 = 95,7 % | −28, n = 18 |
| `{}` | grup 2 + pemicu ≥ 1,5 ATR | 13/20 = 65 % (17) | 45/46 = 97,8 % | −5, n = 20 | 126/167 = 75,4 % | 54/59 = 91,5 % | 7/20 = 35 % (7) | 95,7 % | −28 |
| `{"minBaseBarsForTrigger":8}` | + umur dasar ≥ 8 untuk pemicu | 11/20 = 55 % (13) | 45/46 = 97,8 % | −5, n = 20 | 58/99 = 58,6 % | 4/9 = 44,4 % | 6/20 = 30 % (6) | 95,7 % | −24, n = 20 |
| `{"minBaseBarsForTrigger":8,"minBottomAge":5}` | **+ umur dasar ≥ 5 (DIPILIH)** | **6/20 = 30 % (7)** | **46/47 = 97,9 %** | **−5, n = 20** | **58/99 = 58,6 %** | **4/9 = 44,4 %** | **6/20 = 30 % (6)** | **20/21 = 95,2 %** | **−32, n = 17** |
| `{"minBaseBarsForTrigger":8,"minBottomAge":8}` | + umur dasar ≥ 8 | 6/20 = 30 % (6) | 45/46 = 97,8 % | −5, n = 20 | 58/99 = 58,6 % | 4/9 = 44,4 % | 6/20 = 30 % (6) | 23/24 = 95,8 % | −30, n = 18 |

Pada MEDIUM, seri berkandidat `continuedDowntrend` 15m adalah 1/20 = 5,0 % untuk dua varian pertama dan 3/20 = 15,0 %
untuk semua varian dengan grup 2 (5m: 3/20 pada semua varian) — efek yang sama dengan §2.1 (kandidat tersisa berskor
DEVELOPING). Varian lain yang dicoba integrator dan **ditolak** (laporannya tidak disimpan, angka dari catatan run):
`failedBreakAtr` 1,25 → SUCCESS reversal sukses turun (81 vs 118 kandidat SUCCESS); `followThroughAtr` 0,75 → lebih buruk.

### 3.2 Parameter yang dipilih dan alasannya
Dipilih pada seed 1–20, dikonfirmasi pada seed 21–60 (§2):
- `minEarlyGroups` 2 (baru): EARLY wajib bukti dari ≥ 2 grup berbeda di antara EXHAUSTION/BASE/VOLUME — menghapus EARLY
  dari BOTTOM_HELD + RSI_DIVERGENCE saja (usulan a); seri berkandidat downtrend 15m HIGH 90 % → 65 % bersama pemicu 1,5 ATR,
  tanpa menurunkan SUCCESS MEDIUM (84,4 % → 97,8 %).
- Level pemicu = **puncak range sejak dasar** + `minTriggerAboveBottomAtr` 1,5 (baru) + `minBaseBarsForTrigger` 8 (baru)
  (usulan b): CONFIRMED → gagal 67,5 % → 58,6 %, kandidat yang dibuka langsung sebagai CONFIRMED 79 → 9 dengan gagal 86,1 %
  → 44,4 %, dan — menurut analisis per-kandidat §2.7 butir 2 — gagal **sebelum target** 38 % → 7 %. Umur dasar 8 dipilih
  karena tanpa itu 48 CONFIRMED terjadi di fase `shallower` (sebelum dasar).
- `minBottomAge` 3 → 5: menurunkan downtrend 15m HIGH 55 % → 30 % tanpa mengubah SUCCESS/lead 15m; 8 tidak lebih baik
  (30 %) dan mengurangi kandidat 5m, jadi 5 dipilih.
- Kualitas data (sufiks bersih, usulan e): tidak dapat diverifikasi oleh fixture saat ini (§2.7 butir 5).
- **Tidak diubah** (usulan c & d): `bowlMinR2` 0,6, `risingFloor*`, `bottomHeldDepartAtr` 1, `volumeDryUpRatio` 0,7
  (tidak teruji pada sintetis), `followThroughAtr` 0,3, `failedBreakAtr` 0,75 (varian lebih buruk), `SENSITIVITY_FILTERS`
  (konstanta kontrak; menunggu §6).
- Harga yang dibayar (lihat §2): lead 5m memburuk (−24 → −31/−32 candle) karena pemicu menunggu umur dasar; LOW melewatkan
  lebih banyak seri reversal sukses (15m 14/40 → 21/40); FP downtrend pada MEDIUM naik (15m 3 → 7 kandidat).

## 4. Perbandingan mesin lama vs Reversal Radar (set evaluasi, HIGH = semua kandidat)
Kolom "sebelum" = kandidat baru dan lead kandidat pertama run `6bdb4d1`; mesin lama identik di kedua run.

| TF | Skenario | Seri dengan sinyal lama | Sinyal lama (total) | Seri dengan kandidat baru | Kandidat baru (total) | Indeks pertama lama / baru (median) | Lead vs lama — kandidat pertama | Lead — semua kandidat | Sebelum: kandidat · lead kand. pertama |
|---|---|---|---|---|---|---|---|---|---|
| 5m | successfulReversal | 40/40 | 91 | 40/40 | 249 | 264 / 222 | +37 candle, n = 40 | +12, n = 249 | 316 · +49 |
| 5m | failedBounce | 28/40 = 70,0 % | 28 | 40/40 | 124 | 301 / 281 | +20, n = 28 | −14, n = 89 | 127 · +28 |
| 5m | continuedDowntrend | 0/40 | 0 | 13/40 = 32,5 % | 13 | — / 151 | — | — | 20 · — |
| 5m | longSideways | 29/40 = 72,5 % | 29 | 40/40 | 179 | 218 / 192 | +25, n = 29 | −30, n = 129 | 179 · +25 |
| 5m | suddenPump | 40/40 | 73 | 40/40 | 198 | 218 / 192 | +29, n = 40 | −15, n = 198 | 182 · +47 |
| 5m | brokenData | 0/40 | 0 | 8/40 = 20,0 % | 8 | — / 151 | — | — | 12 · — |
| 5m | uptrendContinuation | 3/40 = 7,5 % | 3 | 0/40 | 0 | 227 / — | — | — | 0 |
| 15m | successfulReversal | 40/40 | 91 | 40/40 | 371 | 264 / 213 | +47 candle, n = 40 | −5, n = 371 | 456 · +51 |
| 15m | failedBounce | 28/40 = 70,0 % | 28 | 40/40 | 146 | 301 / 279 | +27, n = 28 | −12, n = 101 | 275 · +66 |
| 15m | continuedDowntrend | 0/40 | 0 | 15/40 = 37,5 % | 15 | — / 150 | — | — | 125 · — |
| 15m | longSideways | 29/40 = 72,5 % | 29 | 40/40 | 203 | 218 / 191 | +26, n = 29 | −29, n = 144 | 232 · +27 |
| 15m | suddenPump | 40/40 | 73 | 40/40 | 206 | 218 / 191 | +47, n = 40 | −12, n = 206 | 223 · +48 |
| 15m | brokenData | 0/40 | 0 | 12/40 = 30,0 % | 12 | — / 150 | — | — | 12 · — |
| 15m | uptrendContinuation | 3/40 = 7,5 % | 3 | 0/40 | 0 | 227 / — | — | — | 0 |

Bacaan: mesin lama **tidak pernah** bersinyal pada `continuedDowntrend`/`brokenData` dan jarang pada `uptrendContinuation`
(3/40), sedangkan Reversal Radar pada HIGH kini berkandidat di 37,5 % seri downtrend berlanjut (15m; sebelum 100 %). Pada
HIGH Reversal Radar lebih dini (+20…+47 candle) tetapi lewat false start; pada MEDIUM (§2.3) ia masih lebih lambat dari
sinyal lama pertama. `lowVolumeIlliquid` = `successfulReversal` (tidak diulang).

## 5. Keterbatasan
- Data sintetis dibangun dengan bentuk yang diketahui; detektor yang "cocok" di sini belum tentu akurat di pasar nyata,
  dan skenario false positive sintetis (zigzag teratur) bisa lebih mudah/sulit daripada pasar nyata. Parameter yang
  dipilih di §3 disetel pada bentuk-bentuk ini — risiko overfitting terhadap fixture nyata ada.
- Horizon 48 candle dan target 2 ATR adalah pilihan desain §10, bukan hasil optimasi.
- 5m sintetis tanpa HTF 1h yang memadai (lihat §1.5); 15m dan 1h identik karena bentuk & parameter sama.
- Fixture tidak memuat dasar mangkuk, lantai naik, volume mengering tajam, maupun informasi taker (CVD), sehingga
  ROUNDED_BOTTOM, RISING_FLOOR, VOLUME_DRY_UP, CVD_DIVERGENCE tidak teruji (0 %); `lowVolumeIlliquid` hanya menguji bahwa
  kelas likuiditas tidak mengubah deteksi; `brokenData` tidak dapat memverifikasi aturan sufiks bersih (§2.7 butir 5).
- "CONFIRMED sesaat" di laporan agregat menghitung semua BREAKOUT_FAILED setelah CONFIRMED, termasuk yang sudah mencapai
  target; angka "gagal sebelum target" baru tersedia dari analisis per-kandidat pada set penyetelan (§2.7 butir 2).
- Pembanding lama mode `fast` tidak mereproduksi gerbang tier v3 untuk indeks alert (sinyal pertama tetap identik).
- Lead "kandidat pertama" mengabaikan apakah kandidat itu benar; baca bersama "kandidat sebelum dasar" (§2.7 butir 4).
- Konfirmasi out-of-sample pada seed 21–60 dilakukan setelah hasil "sebelum" set itu dibaca (§1.3) — bukan uji buta murni.

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
# opsional, membandingkan parameter lama pada data yang sama (override dicatat di laporan):
npm run reversal:replay -- --top 20 --timeframes 15m --from 2025-06-01 --to 2025-10-01 --params '{"minEarlyGroups":1,"minTriggerAboveBottomAtr":0,"minBaseBarsForTrigger":0,"minBottomAge":3}'
```

Run 1 (2026-10-26) sudah terisi di §6.1–§6.4; run 2 memakai perintah yang sama dan mengisi §6.6 (§6.5 menjelaskan apa yang
ditambahkan harness untuk run 2 dan target yang ditetapkan sebelum run itu); run 3 (perintah sama) mengisi §6.9 (§6.8 =
harness & target yang ditetapkan sebelumnya). Run 4 adalah uji **luar sampel** dengan periode berbeda (2026-06-01 →
2026-10-01) dan sel keputusan yang ditetapkan di §6.10 sebelum run.

Yang perlu disalin kembali ke dokumen ini untuk setiap run: dari `reports/reversal-replay-<timestamp>.md` salin **utuh**
(a) daftar "Parameter" (simbol, rentang, horizon, override `--params` bila ada), (b) tabel "Ringkasan per timeframe",
(c) tabel "Per timeframe × skenario × sensitivitas" (skenario = `dataNyata`), (d) tabel "Lead deteksi", (e) tabel
"Alasan penutupan & breakout gagal" dan "Frekuensi bukti per skenario" (untuk memutuskan ambang yang belum teruji, §2.7
butir 3), (f) bagian "Uji anti-look-ahead", dan (g) seluruh "Peringatan kejujuran". Jangan menyalin ringkasan stdout
saja. Lampirkan juga `reports/reversal-replay-<timestamp>.json` (di luar git, `reports/` gitignored) bila diminta analisis
lanjutan.

### 6.1 Parameter run (run 1, dijalankan pengguna 2026-10-26)

- File: `reports/reversal-replay-20261026T201517Z.md` + `.json` (dibuat 2026-10-26 20:15:17 UTC di Mac pengguna; keduanya
  dilampirkan di thread proyek, di luar git). Mesin dan parameter default = `main` setelah PR #21 (`DEFAULT_REVERSAL_PARAMS`
  commit `1e3bf9b`, tanpa `--params`).
- Perintah: `npm run reversal:replay -- --top 20 --timeframes 5m,15m,1h --from 2025-06-01 --to 2025-10-01 --check-lookahead`.
- Sumber: Binance USDT-M, rentang 2025-06-01 → 2025-10-01 (≈ 122 hari). Timeframe 5m, 15m, 1h. Skenario `dataNyata`.
- Simbol dalam laporan (16): BTCUSDT, ETHUSDT, ZECUSDT, SOLUSDT, HYPEUSDT, XRPUSDT, NEARUSDT, DOODUSDT, ENAUSDT, BNBUSDT,
  1000PEPEUSDT, QUSDT, QNTUSDT, DOGEUSDT, BULLAUSDT, SUIUSDT. Perintah meminta `--top 20`; empat simbol lainnya tidak muncul
  dan laporan run 1 tidak mencatat alasannya (lihat §6.5 butir h).
- Volume: 48 seri; 737 528 evaluasi mesin baru + 737 528 evaluasi mesin lama (mode `fast`); 24 092 kandidat (HIGH = semua);
  durasi replay 400,6 s. Candle per seri ≈ 35 000 (5m), ≈ 11 700 (15m), ≈ 2 900 (1h).
- Definisi keberhasilan §10 tetap: horizon 48 candle, target +2 × ATR deteksi, stop = level invalidasi saat deteksi.
  Sensitivitas (filter tampilan): LOW skor ≥ 60 & ≥ 4 bukti, MEDIUM ≥ 45 & ≥ 3, HIGH semua.

### 6.2 Hasil

**(a) Ringkasan per timeframe × sensitivitas** — disalin dari laporan (kolom lead dibahas di (e); angka lead "semua kandidat"
tidak bermakna pada seri multi-peristiwa).

| TF | Sens. | Seri | Kandidat | Kand./seri | SUCCESS (k/n, CI) | FAIL | TIMEOUT | Batal | Kedaluwarsa | Lead vs lama — kandidat pertama (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| 5m | LOW | 16 | 530 | 33,1 | 314/530 = 59,2 % (55,0–63,3) | 30,0 % | 10,8 % | 41,7 % | 58,3 % | −468 candle, n = 16 |
| 5m | MEDIUM | 16 | 3 921 | 245,1 | 2 260/3 919 = 57,7 % (56,1–59,2) | 30,3 % | 12,0 % | 38,6 % | 61,4 % | −105 candle, n = 16 |
| 5m | HIGH | 16 | 16 359 | 1 022,4 | 8 987/16 344 = 55,0 % (54,2–55,7) | 33,8 % | 11,2 % | 39,6 % | 60,3 % | +13 candle, n = 16 |
| 15m | LOW | 16 | 188 | 11,8 | 93/187 = 49,7 % (42,6–56,8) | 29,4 % | 20,9 % | 51,1 % | 48,4 % | −709 candle, n = 16 |
| 15m | MEDIUM | 16 | 1 331 | 83,2 | 791/1 328 = 59,6 % (56,9–62,2) | 25,8 % | 14,6 % | 44,2 % | 55,6 % | +3 candle, n = 16 |
| 15m | HIGH | 16 | 6 209 | 388,1 | 3 401/6 202 = 54,8 % (53,6–56,1) | 33,8 % | 11,3 % | 47,2 % | 52,5 % | +13 candle, n = 16 |
| 1h | LOW | 16 | 49 | 3,1 | 34/49 = 69,4 % (55,5–80,5) | 30,6 % | 0,0 % | 57,1 % | 42,9 % | −530 candle, n = 14 |
| 1h | MEDIUM | 16 | 302 | 18,9 | 186/299 = 62,2 % (56,6–67,5) | 27,8 % | 10,0 % | 43,7 % | 55,3 % | +2 candle, n = 16 |
| 1h | HIGH | 16 | 1 524 | 95,3 | 801/1 505 = 53,2 % (50,7–55,7) | 35,3 % | 11,4 % | 43,6 % | 55,5 % | +6 candle, n = 16 |

Kandidat per simbol per hari (≈ 122 hari): MEDIUM 5m ≈ 2,0 · 15m ≈ 0,7 · 1h ≈ 0,15 (≈ 1 per minggu); HIGH 5m ≈ 8,4 ·
15m ≈ 3,2 · 1h ≈ 0,8; LOW 5m ≈ 0,27 · 15m ≈ 0,1 · 1h ≈ 0,025.

**(b) Tahap awal, keterlambatan, state machine, ekskursi** — dihitung dari `.json` (`firstStage`, `lateEntry`/
`extendedAtDetection`, `reachedConfirmed`, `falseBreakouts`, `confirmedFirstFailed`, `mfe*/mae*`, `barsOpen`).

| TF | Sens. | Tahap awal E / D / C | EARLY % | Terlambat saat deteksi | Mencapai CONFIRMED | CONFIRMED → gagal | Dibuka CONFIRMED → gagal | MAE median (ATR) | MFE / MAE median (%) | Candle terbuka (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| 5m | LOW | 0 / 425 / 105 | 0,0 % | 52,6 % (48,4–56,9) | 44,7 % | 58,6 % | 63,8 % (67/105) | −1,33 | +0,45 / −0,37 | 24 |
| 5m | MEDIUM | 10 / 3 267 / 644 | 0,3 % | 56,6 % (55,0–58,1) | 38,9 % | 54,7 % | 55,7 % (359/644) | −1,43 | +0,46 / −0,44 | 24 |
| 5m | HIGH | 2 395 / 12 905 / 1 059 | 14,6 % | 42,9 % (42,2–43,7) | 28,0 % | 53,3 % | 54,6 % (578/1 059) | −1,50 | +0,45 / −0,45 | 23 |
| 15m | LOW | 0 / 156 / 32 | 0,0 % | 60,1 % (53,0–66,8) | 58,5 % | 58,2 % | 56,2 % (18/32) | −1,62 | +0,69 / −0,83 | 21,5 |
| 15m | MEDIUM | 3 / 1 181 / 147 | 0,2 % | 59,2 % (56,5–61,8) | 55,4 % | 51,5 % | 48,3 % (71/147) | −1,54 | +0,82 / −0,81 | 21 |
| 15m | HIGH | 1 108 / 4 777 / 324 | 17,8 % | 39,1 % (37,8–40,3) | 46,7 % | 51,8 % | 51,5 % (167/324) | −1,47 | +0,85 / −0,83 | 20 |
| 1h | LOW | 0 / 38 / 11 | 0,0 % | 59,2 % (45,2–71,8) | 77,6 % | 47,4 % | 36,4 % (4/11) | −1,04 | +1,48 / −0,66 | 19 |
| 1h | MEDIUM | 0 / 245 / 57 | 0,0 % | 61,6 % (56,0–66,9) | 65,2 % | 48,2 % | 52,6 % (30/57) | −1,29 | +1,63 / −1,39 | 19 |
| 1h | HIGH | 252 / 1 159 / 113 | 16,5 % | 42,4 % (39,9–44,9) | 49,6 % | 46,2 % | 53,1 % (60/113) | −1,48 | +1,74 / −1,75 | 17 |

"Terlambat saat deteksi" = kandidat yang saat pertama muncul sudah membawa risiko LATE_ENTRY/EXTENDED (di run ini kedua
ukuran identik). MFE pada SUCCESS dibatasi di target (2 ATR), sehingga median MFE (ATR) = 2,00 di semua grup dan tidak
ditampilkan.

**(c) Alasan penutupan (HIGH = semua kandidat)** — disalin dari laporan.

| TF | Kandidat | Close < invalidasi | Breakout gagal | Tanpa kemajuan | Bukti melemah | Masih terbuka | Mencapai CONFIRMED | CONFIRMED sesaat | CONFIRMED sejak awal → gagal | Candle terbuka (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| 5m | 16 359 | 4 033 | 2 441 | 4 849 | 5 023 | 13 | 4 576/16 359 = 28,0 % | 2 441/4 576 = 53,3 % (51,9–54,8) | 578/1 059 = 54,6 % (51,6–57,6) | 23 (11–36) |
| 15m | 6 209 | 1 431 | 1 501 | 1 486 | 1 775 | 16 | 2 897/6 209 = 46,7 % | 1 501/2 897 = 51,8 % (50,0–53,6) | 167/324 = 51,5 % (46,1–56,9) | 20 (10–31) |
| 1h | 1 524 | 316 | 349 | 382 | 464 | 13 | 756/1 524 = 49,6 % | 349/756 = 46,2 % (42,6–49,7) | 60/113 = 53,1 % (43,9–62,0) | 17 (10–31) |

**(d) Klasifikasi evaluasi per candle & frekuensi bukti (HIGH)** — klasifikasi dari `.json`; frekuensi disalin dari laporan.
Sel bukti = % evaluasi candle yang meloloskan bukti itu / % kandidat yang memuat bukti itu saat deteksi pertama.

| TF | Evaluasi | REVERSAL_CANDIDATE | NO_SETUP | CONTINUATION | DATA_QUALITY |
|---|---|---|---|---|---|
| 5m | 523 290 | 414 751 = 79,3 % | 87 431 = 16,7 % | 19 338 = 3,7 % | 1 770 = 0,3 % |
| 15m | 172 830 | 136 531 = 79,0 % | 29 105 = 16,8 % | 7 194 = 4,2 % | 0 |
| 1h | 41 408 | 32 722 = 79,0 % | 7 016 = 16,9 % | 1 670 = 4,0 % | 0 |

| Bukti | 5m | 15m | 1h |
|---|---|---|---|
| LL_STOPPED | 74 % / 83 % | 74 % / 80 % | 74 % / 80 % |
| HIGHER_LOW | 54 % / 60 % | 55 % / 58 % | 56 % / 58 % |
| EMA7_TURN_UP | 42 % / 44 % | 42 % / 39 % | 43 % / 38 % |
| EMA_CONVERGENCE | 38 % / 70 % | 38 % / 63 % | 38 % / 61 % |
| CHOCH_BULLISH | 36 % / 43 % | 36 % / 40 % | 36 % / 40 % |
| RANGE_CONTRACTION | 33 % / 33 % | 33 % / 34 % | 32 % / 35 % |
| EMA25_RECLAIM | 27 % / 33 % | 26 % / 27 % | 25 % / 26 % |
| BOTTOM_HELD | 23 % / 28 % | 24 % / 29 % | 24 % / 29 % |
| VOLUME_DRY_UP | 22 % / 19 % | 22 % / 19 % | 20 % / 18 % |
| QUIET_RISE | 20 % / 30 % | 20 % / 30 % | 20 % / 29 % |
| LL_SHALLOWER | 17 % / 24 % | 18 % / 25 % | 19 % / 26 % |
| DOWN_MOMENTUM_FADING | 17 % / 24 % | 17 % / 20 % | 17 % / 19 % |
| ATR_CONTRACTION | 14 % / 11 % | 16 % / 12 % | 15 % / 12 % |
| RSI_DIVERGENCE | 13 % / 17 % | 13 % / 17 % | 14 % / 18 % |
| ROUNDED_BOTTOM | 11 % / 10 % | 11 % / 7 % | 12 % / 8 % |
| SPRING_RECLAIM | 11 % / 10 % | 11 % / 13 % | 11 % / 13 % |
| TRIGGER_BREAK | 5 % / 8 % | 5 % / 7 % | 5 % / 9 % |
| BREAK_FOLLOW_THROUGH | 4 % / 6 % | 4 % / 4 % | 4 % / 6 % |
| BREAK_VOLUME_SUPPORT | 3 % / 3 % | 3 % / 3 % | 3 % / 5 % |
| CVD_DIVERGENCE | 3 % / 3 % | 1 % / 1 % | 0 % / 0 % |
| STAIRCASE | 2 % / 2 % | 3 % / 3 % | 3 % / 4 % |
| RISING_FLOOR | 1 % / 1 % | 2 % / 2 % | 2 % / 2 % |

**(e) Lead deteksi (MEDIUM)** — disalin dari laporan. Pada data nyata tiap seri memuat ratusan peristiwa; "vs mesin lama —
kandidat pertama" hanya membandingkan kandidat pertama dalam 4 bulan dengan sinyal lama pertama (pada HIGH keduanya jatuh
tepat setelah warm-up ≈ candle 150–167, sehingga lead "+13" hanya mencerminkan siapa lebih dulu memenuhi syarat warm-up), dan
"semua kandidat" membandingkan tiap kandidat dengan sinyal lama *pertama* (makin ke belakang makin negatif). Keduanya tidak
dapat dipakai untuk menilai keunggulan waktu di data nyata; metrik per peristiwa disiapkan untuk run 2 (§6.5 butir f).

| TF | vs mesin lama — kandidat pertama | vs mesin lama — semua kandidat | vs alert lama — kandidat pertama | vs breakout (close > pemicu) | ke pemicu | ke CONFIRMED |
|---|---|---|---|---|---|---|
| 5m | −105 (−207…−49), n = 16 | −16 734, n = 3 921 | −102, n = 16 | 3 (0–13), n = 2 940 | 3 (0–10), n = 2 549 | 3 (0–14), n = 1 524 |
| 15m | +3 (−78…+15), n = 16 | −5 524, n = 1 331 | +5, n = 16 | 5 (1–15), n = 957 | 4 (1–12), n = 784 | 6 (1–14), n = 738 |
| 1h | +2 (−49…+5), n = 16 | −1 058, n = 302 | +4, n = 16 | 3 (0–12), n = 236 | 3 (0–10), n = 206 | 4 (0–12), n = 197 |

Yang bermakna di sini hanya tiga kolom terakhir: kandidat MEDIUM muncul median 3–5 candle sebelum close pertama di atas
level pemicu dan 3–6 candle sebelum CONFIRMED — sama dengan pola sintetis (§2.3).

**(f) Perbandingan mesin lama (HIGH)**: sinyal lama (QUIET/EARLY_BULLISH) 10 470 / 3 329 / 746 per TF (alert lama v2
13 792 / 4 399 / 950) vs kandidat Reversal Radar 16 359 / 6 209 / 1 524. Keduanya menandai 16/16 seri. Reversal Radar HIGH
menghasilkan ≈ 1,6–2,0 × lebih banyak penanda daripada sinyal lama; pada MEDIUM (3 921 / 1 331 / 302) ≈ 0,37–0,40 ×.

### 6.3 Peringatan kejujuran & anti-look-ahead

Disalin dari laporan:
- ⚠️ Pembanding mesin lama mode cepat (tanpa konfluensi v3): indeks sinyal pertama identik dengan live, indeks alert pertama
  memakai definisi v2 (tanpa gerbang tier).
- Uji anti-look-ahead (stabilitas prefiks): seri diperiksa 3, gagal 0 — "Semua seri yang diperiksa stabil: hasil pada
  prefiks tidak berubah saat candle masa depan ditambahkan." Catatan: pemeriksaan mencuplik 3 dari 48 seri (biaya replay
  ulang per prefiks), bukan seluruh seri.
- Tabel "Pemeriksaan target §10" di laporan run 1 seluruhnya "tanpa data" karena target §10 diikat ke nama skenario
  sintetis (successfulReversal/continuedDowntrend/uptrendContinuation); pada data nyata skenario hanya `dataNyata`. Target
  khusus data nyata ditetapkan di §6.5 **sebelum** run 2.

Tambahan dari pembacaan `.json`:
- **Tidak ada basis pembanding tanpa keterampilan** di run 1. SUCCESS 55–62 % tidak boleh dibaca sebagai keunggulan: dengan
  target +2 ATR dan stop s ATR, random walk tanpa drift sudah memberi peluang ≈ s/(2 + s) untuk mengenai target lebih dulu
  (s = 2 ATR → 50 %, s = 3 ATR → 60 %). Jarak stop tidak dicatat di laporan run 1; kuartil bawah MAE −2,6 … −3,2 ATR
  menunjukkan banyak kandidat dengan stop ≥ 2,5 ATR, sehingga basis acaknya kemungkinan ≥ 55 %. Run 2 menghitung basis ini
  (§6.5 butir c).
- Satu periode (Jun–Okt 2025, 4 bulan) dan 16 simbol, tanpa biaya/slippage; hasil = statistik historis periode itu.
- `lowVolumeIlliquid`, false positive per skenario, dan "Deteksi per fase" tidak berlaku pada data nyata (tidak ada label
  skenario); false positive di data nyata hanya terbaca lewat FAIL/TIMEOUT dan basis acak.
- n kecil pada 1h LOW (49 kandidat, 14 seri) — CI 55,5–80,5 %.

### 6.4 Bacaan hasil run 1

1. **Volume kandidat.** Mesin mengklasifikasikan 79 % dari seluruh evaluasi candle sebagai REVERSAL_CANDIDATE pada ketiga
   TF (NO_SETUP ≈ 17 %, CONTINUATION ≈ 4 %). Pada HIGH, tiap simbol melahirkan ≈ 1 022 kandidat/4 bulan di 5m (≈ 8 per
   hari), 388 di 15m, 95 di 1h; pada MEDIUM 245 / 83 / 19 (≈ 2 per hari / 0,7 per hari / 1 per minggu); pada LOW 33 / 12 / 3.
   Penyebabnya terbaca di (d): LL_STOPPED lolos pada 74 % evaluasi (hampir selalu benar begitu swing low terakhir tidak
   ditembus), HIGHER_LOW 54–56 %, EMA7_TURN_UP 42 %, EMA_CONVERGENCE 38 %, CHOCH_BULLISH 36 % — bukti-bukti ini bukan pembeda
   di pasar nyata, dan tiga di antaranya cukup untuk membuka kandidat DEVELOPING. Bukti yang jarang: RISING_FLOOR 1–2 %,
   STAIRCASE 2–3 %, CVD_DIVERGENCE 0–3 % (proksi taker-buy hampir tidak pernah lolos), TRIGGER_BREAK 5 %.
2. **Hasil triple-barrier.** MEDIUM: 57,7 % (5m) · 59,6 % (15m) · 62,2 % (1h); LOW: 59,2 % · 49,7 % · 69,4 %; HIGH: 55,0 % ·
   54,8 % · 53,2 %. Menaikkan ambang skor (HIGH → MEDIUM) menaikkan SUCCESS 2–9 poin pada ketiga TF; LOW tidak konsisten (15m
   lebih buruk dari HIGH, 1h lebih baik dengan n = 49). Target §10 "SUCCESS ≥ 60 % pada MEDIUM" (dibuat untuk skenario
   reversal sukses sintetis, bukan untuk campuran seluruh rezim pasar) hanya dicapai titik estimasinya di 1h (CI 56,6–67,5 %);
   di 5m CI seluruhnya di bawah 60 %. **Tanpa basis acak, tidak satu pun angka ini boleh disebut keunggulan** (§6.3).
3. **Early Formation praktis tidak pernah tampil pada sensitivitas default.** Kandidat pertama bertahap EARLY_FORMATION pada
   MEDIUM: 10/3 921 (0,3 %) di 5m, 3/1 331 (0,2 %) di 15m, 0/302 di 1h; pada HIGH 14,6 % / 17,8 % / 16,5 %. Sebabnya
   struktural: skor maksimum tahap EARLY adalah 60 (EXHAUSTION 25 + BASE 25 + VOLUME 10) dan hanya tercapai bila *semua* bukti
   ketiga grup lolos, sedangkan MEDIUM menuntut skor ≥ 45. Daftar "Early Formation" di UI pada setelan default karena itu
   hampir selalu kosong — bertentangan dengan tujuan fitur (§1 kontrak docs/19). Ambang sensitivitas harus dibuat per tahap;
   nilainya dipilih dari distribusi skor per tahap dan hasil per tahap pada run 2 (§6.5 butir a–b), bukan ditebak.
4. **Lebih dari separuh kandidat MEDIUM sudah "terlambat" saat pertama tampil**: 56,6 % (5m), 59,2 % (15m), 61,6 % (1h)
   membawa LATE_ENTRY/EXTENDED pada deteksi pertama (HIGH 39–43 %). Ini konsisten dengan butir 3: kandidat baru melewati ambang
   MEDIUM setelah bukti STRUCTURE/TRIGGER menumpuk, yaitu setelah harga bergerak. Perlu diukur (run 2, butir e) apakah
   kandidat "terlambat" berhasil lebih jarang. Toggle UI "Sembunyikan yang sudah extended" ada tetapi **mati secara
   default** (`hideExtended: false`), sehingga daftar default saat ini memuat kandidat-kandidat ini; bila dimatikan pun,
   daftar yang tersisa tetap didominasi DEVELOPING.
5. **State machine.** 39–47 % kandidat ditutup CANCELLED dan 53–61 % EXPIRED (NO_PROGRESS ≈ 30 %, EVIDENCE_FADED ≈ 30 %);
   kandidat terbuka median 17–24 candle. Dari kandidat yang mencapai CONFIRMED, 46–59 % kemudian BREAKOUT_FAILED; yang
   dibuka langsung sebagai CONFIRMED gagal 48–64 %. Angka "gagal sebelum target" belum terpisah (run 2, butir d).
6. **Ekskursi.** 5m: MFE median +0,46 % vs MAE −0,44 % — ordo biaya pulang-pergi futures (≈ 0,1 % fee + slippage); 15m
   ±0,8 %; 1h +1,6 % / −1,4 %. Pergerakan 5m terlalu kecil untuk ditindaklanjuti sebagai setup mandiri; 5m lebih cocok sebagai
   konteks timing untuk 15m/1h.
7. **Bukti yang belum teruji sintetis kini terukur frekuensinya** (eval/kandidat): ROUNDED_BOTTOM 11 % / 7–10 %, VOLUME_DRY_UP
   20–22 % / 18–19 %, BOTTOM_HELD 23–24 % / 28–29 %, RISING_FLOOR 1–2 %. Nilai diskriminatifnya (lolos pada SUCCESS vs FAIL)
   belum terukur — run 2 tidak menambah ini; menjadi kandidat run 3 bila butir 1–4 sudah ditangani.
8. **Keunggulan waktu vs mesin lama** tidak dapat disimpulkan dari run 1 (lihat (e)); metrik per peristiwa ada di run 2.

### 6.5 Run 2 — perubahan harness (PR #22) & target yang ditetapkan sebelum run

Harness replay (`backend/reversal/replay.js`, `replayReport.js`, `scripts/reversal-replay.js`) diperluas di PR #22 supaya run 2
menjawab pertanyaan yang tidak terjawab run 1 — tanpa mengubah mesin, API, maupun UI. Kunci JSON baru ada di `groups[]` /
`byTimeframe[]`; judul bagian Markdown baru dicetak tebal.

| | Pertanyaan dari run 1 | Yang ditambahkan (JSON → bagian laporan) |
|---|---|---|
| a | Apakah kandidat EARLY/DEVELOPING/CONFIRMED berbeda hasilnya? | `outcomesByFirstStage` → **Hasil per tahap awal** (SUCCESS/FAIL/TIMEOUT per tahap awal, per TF × sensitivitas) |
| b | Ambang sensitivitas per tahap yang mana yang masuk akal? | `firstScoreByStage`, `firstEvidenceByStage`, `firstScoreHistogramByStage` (bin 10 poin, label di `meta.scoreBins`) → **Distribusi skor saat deteksi per tahap awal (sensitivitas HIGH)** |
| c | Apakah SUCCESS 55–62 % melebihi kebetulan? | per kandidat `stopDistanceAtr`, `baselineRandomWalk`, `baselineShuffled`; per grup `stopDistanceAtr` (kuantil), `baselineRandomWalk` (rata-rata s/(2+s)), `baselineShuffled` (k/n/CI), `successMinusBaseline` → **Basis pembanding tanpa keterampilan** + dua kolom "Basis acak RW" / "Basis acak empiris" di "Ringkasan per timeframe" |
| d | Berapa breakout gagal yang tidak pernah mencapai target? | `failedBeforeTarget` → kolom **Breakout gagal sebelum target** di "Alasan penutupan & breakout gagal" |
| e | Apakah kandidat "terlambat" lebih jarang berhasil? | `outcomesByExtended.{extended,notExtended}` → **Hasil menurut status terlambat saat deteksi** |
| f | Apakah Reversal Radar lebih awal dari mesin lama *per peristiwa*? | per kandidat `leadVsOldNearest` (sinyal lama QUIET/EARLY_BULLISH terdekat dalam ±48 candle; per seri `old.signalIndexes`); per grup `leadVsOldNearest` (kuantil), `leadVsOldNearestMatched`, `leadVsOldNearestPositive` → **Lead per peristiwa (padanan sinyal lama terdekat ±horizon)** |
| g | Target apa yang diperiksa pada data nyata? | `targets[]` bertambah `T_NYATA_1..3` (hanya bila ada grup `dataNyata`; didefinisikan di docs/19 §10) → baris baru di "Pemeriksaan target §10" dan ringkasan stdout |
| h | Mengapa hanya 16 dari 20 simbol? | `meta.symbolsRequested`, `meta.topRequested`, `meta.symbolsSkipped[{symbol, reason}]`; unduh gagal per simbol tidak lagi menggagalkan run → baris "Simbol diminta / di-replay / dilewati" di "Parameter" |

**Basis pembanding (c), rumus persis.** Jarak stop per kandidat berlabel s = (close deteksi − level invalidasi yang dipakai
pelabelan) / ATR deteksi. *Basis acak RW* = rata-rata s/(2 + s): peluang random walk tanpa drift menyentuh +2 ATR sebelum
−s ATR (tanpa batas waktu; pembanding kasar). *Basis acak empiris* = untuk tiap kandidat berlabel diambil K = 3 indeks acak
berbeda (PRNG berbenih `symbol|timeframe|basis|id`, deterministik) pada seri yang sama, setelah warm-up dan sebelum
n − 48, lalu dilabeli dengan `labelCandidate` yang sama: entri = close(idx), target = 2 × ATR14(idx), stop = entri − s ×
ATR14(idx) (ATR Wilder 14 dari `backend/indicators`, hanya candle ≤ idx); k/n digabung per grup dengan CI Wilson. Pada
uji asap sintetis (seed 1–3, 15m): reversal sukses HIGH SUCCESS 19/30 = 63,3 % vs basis empiris 41/90 = 45,6 % (+17,8
poin); downtrend berlanjut HIGH 0/4 vs basis 0/12 — basis empiris ikut menangkap rezim seri, sebagaimana dimaksud.

**Target data nyata, ditetapkan SEBELUM run 2** (docs/19 §10; per TF, sensitivitas MEDIUM):
- **T-NYATA-1**: batas bawah CI Wilson 95 % SUCCESS > basis acak empiris (titik). Run 1 tidak punya basis → tanpa data.
- **T-NYATA-2**: median lead per peristiwa (padanan ±48 candle) > 0. Run 1: tidak terukur (lead §10 tidak bermakna).
- **T-NYATA-3**: ≥ 10 % kandidat pertama bertahap EARLY_FORMATION. Run 1: 0,3 % / 0,2 % / 0 % — **tidak terpenuhi**;
  diperiksa ulang pada run 2 dengan filter yang sama (perubahan ambang per tahap baru diputuskan *setelah* run 2).

Perintah run 2 (sama dengan run 1; cache `data/backtest-cache` membuat unduhan tidak diulang):

```bash
cd ~/Caddle && git pull origin main && npm ci
npm run reversal:replay -- --top 20 --timeframes 5m,15m,1h --from 2025-06-01 --to 2025-10-01 --check-lookahead
```

Yang dikirim kembali: `reports/reversal-replay-<ts>.md` dan `.json` utuh (seperti run 1).

### 6.6 Run 2 — hasil (dijalankan pengguna 2026-10-26 20:59 UTC)

- File: `reports/reversal-replay-20261026T205952Z.md` + `.json` (dilampirkan di thread proyek, di luar git). Perintah sama
  dengan run 1; mesin = `main` setelah PR #22 (parameter `1e3bf9b`, tanpa `--params`). Data identik dengan run 1 (48 seri,
  737 528 evaluasi, 24 092 kandidat; semua angka run 1 terulang persis) — yang berbeda hanya laporan (§6.5). Replay 278,8 s.
- Simbol: `--top 20` → discovery mengembalikan 20; 16 di-replay; **4 dilewati** — JCTUSDT, BTWUSDT, CAPUSDT, APRUSDT, ketiga
  TF "tidak ada candle pada rentang" (kontrak tanpa data pada Jun–Okt 2025). Ini jawaban butir h run 1.
- Peringatan kejujuran (dari laporan): pembanding lama mode cepat (indeks alert v2). Anti-look-ahead: 3 seri diperiksa, 0 gagal.

**(a) Target data nyata (docs/19 §10, ditetapkan sebelum run 2) — sensitivitas MEDIUM**

| TF | T-NYATA-1: CI bawah SUCCESS > basis acak empiris | T-NYATA-2: median lead per peristiwa > 0 | T-NYATA-3: EARLY ≥ 10 % kandidat pertama |
|---|---|---|---|
| 5m | **TIDAK** — SUCCESS 57,7 % (CI 56,1–59,2) vs basis 56,8 % (+0,8 poin) | **TIDAK** — median 0 candle (Q1–Q3 −10…+8), n = 3 816; lead > 0 hanya 49,0 % | **TIDAK** — 0,3 % |
| 15m | **TIDAK** — 59,6 % (56,9–62,2) vs 59,8 % (−0,2 poin) | **TIDAK** — median −2 (−13…+8), n = 1 291; lead > 0 43,2 % | **TIDAK** — 0,2 % |
| 1h | **TIDAK** — 62,2 % (56,6–67,5) vs 58,6 % (+3,6 poin; CI memuat basis) | **TIDAK** — median −2 (−15…+9), n = 290; lead > 0 42,4 % | **TIDAK** — 0,0 % |

**(b) Basis pembanding tanpa keterampilan** — disalin dari laporan.

| TF | Sens. | Berlabel | Jarak stop s (ATR) median (Q1–Q3) | Basis acak RW | Basis acak empiris | SUCCESS | Selisih |
|---|---|---|---|---|---|---|---|
| 5m | LOW | 530 | 3,60 (2,30–5,83) | 62,2 % | 875/1 590 = 55,0 % (52,6–57,5) | 314/530 = 59,2 % (55,0–63,3) | +4,2 poin |
| 5m | MEDIUM | 3 919 | 3,92 (2,40–5,98) | 63,4 % | 6 682/11 757 = 56,8 % (55,9–57,7) | 2 260/3 919 = 57,7 % (56,1–59,2) | +0,8 poin |
| 5m | HIGH | 16 344 | 3,44 (2,17–5,43) | 61,7 % | 27 302/49 032 = 55,7 % (55,2–56,1) | 8 987/16 344 = 55,0 % (54,2–55,7) | −0,7 poin |
| 15m | LOW | 187 | 4,39 (2,59–6,75) | 65,0 % | 329/561 = 58,6 % (54,5–62,6) | 93/187 = 49,7 % (42,6–56,8) | −8,9 poin |
| 15m | MEDIUM | 1 328 | 4,32 (2,68–6,53) | 65,7 % | 2 381/3 984 = 59,8 % (58,2–61,3) | 791/1 328 = 59,6 % (56,9–62,2) | −0,2 poin |
| 15m | HIGH | 6 202 | 3,24 (2,08–5,26) | 60,9 % | 10 237/18 606 = 55,0 % (54,3–55,7) | 3 401/6 202 = 54,8 % (53,6–56,1) | −0,2 poin |
| 1h | LOW | 49 | 3,48 (2,28–5,55) | 62,1 % | 82/147 = 55,8 % (47,7–63,6) | 34/49 = 69,4 % (55,5–80,5) | +13,6 poin |
| 1h | MEDIUM | 299 | 3,92 (2,26–6,09) | 63,3 % | 526/897 = 58,6 % (55,4–61,8) | 186/299 = 62,2 % (56,6–67,5) | +3,6 poin |
| 1h | HIGH | 1 505 | 3,19 (2,00–5,32) | 60,5 % | 2 549/4 515 = 56,5 % (55,0–57,9) | 801/1 505 = 53,2 % (50,7–55,7) | −3,2 poin |

**(c) Hasil per tahap awal** — disalin dari laporan (basis acak di kolom terakhir = basis *grup*, bukan subset; lihat §6.7 butir 2).

| TF | Sens. | Tahap awal | Kandidat | SUCCESS | FAIL | TIMEOUT | Basis empiris grup |
|---|---|---|---|---|---|---|---|
| 5m | MEDIUM | EARLY_FORMATION | 10 | 6/10 = 60,0 % (31,3–83,2) | 30,0 % | 10,0 % | 56,8 % |
| 5m | MEDIUM | DEVELOPING_REVERSAL | 3 267 | 2 016/3 265 = 61,7 % (60,1–63,4) | 24,0 % | 14,2 % | 56,8 % |
| 5m | MEDIUM | CONFIRMED_BREAKOUT | 644 | 238/644 = 37,0 % (33,3–40,8) | 62,1 % | 0,9 % | 56,8 % |
| 5m | HIGH | EARLY_FORMATION | 2 395 | 1 092/2 392 = 45,7 % (43,7–47,7) | 50,0 % | 4,4 % | 55,7 % |
| 5m | HIGH | DEVELOPING_REVERSAL | 12 905 | 7 504/12 893 = 58,2 % (57,3–59,1) | 28,5 % | 13,3 % | 55,7 % |
| 5m | HIGH | CONFIRMED_BREAKOUT | 1 059 | 391/1 059 = 36,9 % (34,1–39,9) | 62,3 % | 0,8 % | 55,7 % |
| 15m | MEDIUM | EARLY_FORMATION | 3 | 2/3 | 1/3 | 0/3 | 59,8 % |
| 15m | MEDIUM | DEVELOPING_REVERSAL | 1 181 | 722/1 178 = 61,3 % (58,5–64,0) | 22,2 % | 16,5 % | 59,8 % |
| 15m | MEDIUM | CONFIRMED_BREAKOUT | 147 | 67/147 = 45,6 % (37,7–53,6) | 54,4 % | 0,0 % | 59,8 % |
| 15m | HIGH | EARLY_FORMATION | 1 108 | 469/1 107 = 42,4 % (39,5–45,3) | 51,9 % | 5,8 % | 55,0 % |
| 15m | HIGH | DEVELOPING_REVERSAL | 4 777 | 2 797/4 771 = 58,6 % (57,2–60,0) | 28,0 % | 13,4 % | 55,0 % |
| 15m | HIGH | CONFIRMED_BREAKOUT | 324 | 135/324 = 41,7 % (36,4–47,1) | 58,3 % | 0,0 % | 55,0 % |
| 1h | MEDIUM | DEVELOPING_REVERSAL | 245 | 165/242 = 68,2 % (62,1–73,7) | 19,4 % | 12,4 % | 58,6 % |
| 1h | MEDIUM | CONFIRMED_BREAKOUT | 57 | 21/57 = 36,8 % (25,5–49,8) | 63,2 % | 0,0 % | 58,6 % |
| 1h | HIGH | EARLY_FORMATION | 252 | 120/251 = 47,8 % (41,7–54,0) | 48,6 % | 3,6 % | 56,5 % |
| 1h | HIGH | DEVELOPING_REVERSAL | 1 159 | 642/1 141 = 56,3 % (53,4–59,1) | 29,4 % | 14,3 % | 56,5 % |
| 1h | HIGH | CONFIRMED_BREAKOUT | 113 | 39/113 = 34,5 % (26,4–43,7) | 65,5 % | 0,0 % | 56,5 % |

LOW (tanpa EARLY): DEVELOPING 65,2 % (5m, n = 425) · 52,3 % (15m, n = 155) · 76,3 % (1h, n = 38); CONFIRMED 35,2 % · 37,5 % ·
45,5 % (n = 105 / 32 / 11).

**(d) Hasil menurut status terlambat saat deteksi (MEDIUM)** — disalin dari laporan; HIGH menunjukkan pola yang sama.

| TF | Status saat deteksi | Kandidat | SUCCESS | FAIL | TIMEOUT |
|---|---|---|---|---|---|
| 5m | terlambat (LATE_ENTRY/EXTENDED) | 2 219 | 1 342/2 217 = 60,5 % (58,5–62,5) | 22,5 % | 17,0 % |
| 5m | tepat waktu | 1 702 | 918/1 702 = 53,9 % (51,6–56,3) | 40,5 % | 5,6 % |
| 15m | terlambat | 788 | 485/787 = 61,6 % (58,2–65,0) | 18,0 % | 20,3 % |
| 15m | tepat waktu | 543 | 306/541 = 56,6 % (52,4–60,7) | 37,2 % | 6,3 % |
| 1h | terlambat | 186 | 113/184 = 61,4 % (54,2–68,1) | 23,4 % | 15,2 % |
| 1h | tepat waktu | 116 | 73/115 = 63,5 % (54,4–71,7) | 34,8 % | 1,7 % |

**(e) Distribusi skor saat deteksi per tahap awal (HIGH = semua kandidat)** — disalin dari laporan.

| TF | Tahap awal | Kandidat | Skor median (Q1–Q3) | Skor min–maks | Bukti median (Q1–Q3) | Histogram 0–9 / 10–19 / 20–29 / 30–39 / 40–49 / 50–59 / 60–69 / 70–79 / 80–89 / 90–100 |
|---|---|---|---|---|---|---|
| 5m | EARLY_FORMATION | 2 395 | 19 (16–26) | 10–52 | 3,0 (3,0–4,0) | 0/1244/849/262/39/1/0/0/0/0 |
| 5m | DEVELOPING_REVERSAL | 12 905 | 37 (30–45) | 15–88 | 6,0 (5,0–7,0) | 0/231/2924/4570/3353/1402/358/60/7/0 |
| 5m | CONFIRMED_BREAKOUT | 1 059 | 47 (40–54) | 23–83 | 8,0 (7,0–9,0) | 0/0/36/207/385/326/86/17/2/0 |
| 15m | EARLY_FORMATION | 1 108 | 18 (12–24) | 10–48 | 3,0 (2,0–4,0) | 0/654/346/97/11/0/0/0/0/0 |
| 15m | DEVELOPING_REVERSAL | 4 777 | 36 (29–44) | 15–82 | 5,0 (4,0–7,0) | 0/127/1244/1536/1205/509/131/23/2/0 |
| 15m | CONFIRMED_BREAKOUT | 324 | 43 (36–52) | 19–79 | 8,0 (7,0–9,0) | 0/2/26/90/104/70/26/6/0/0 |
| 1h | EARLY_FORMATION | 252 | 19 (13–25) | 10–44 | 3,0 (2,0–4,0) | 0/135/83/30/4/0/0/0/0/0 |
| 1h | DEVELOPING_REVERSAL | 1 159 | 35 (28–42) | 15–79 | 5,0 (4,0–6,0) | 0/39/314/405/262/101/31/7/0/0 |
| 1h | CONFIRMED_BREAKOUT | 113 | 45 (38–51) | 23–78 | 8,0 (7,0–9,0) | 0/0/3/33/39/27/10/1/0/0 |

**(f) Breakout gagal sebelum target** (HIGH): 714/2 441 = 29,3 % (5m) · 469/1 500 = 31,3 % (15m) · 117/349 = 33,5 % (1h) —
artinya **67–71 % penutupan BREAKOUT_FAILED terjadi setelah target +2 ATR sudah tercapai**.

**(g) Lead per peristiwa (MEDIUM)**: 96–97 % kandidat Reversal Radar punya sinyal lama (QUIET/EARLY_BULLISH) dalam ±48 candle;
median lead 0 (5m) / −2 (15m) / −2 (1h) candle; lead > 0 pada 49,0 % / 43,2 % / 42,4 % kandidat berpadanan.

### 6.7 Bacaan run 2

> **Dikoreksi oleh run 3 (§6.9 butir 2–3):** butir tentang DEVELOPING-first, CONFIRMED-first, dan kandidat terlambat di
> bawah ini memakai basis *grup*; dengan basis *subset* (jarak stop subset) ketiganya setara kebetulan. Teks asli dibiarkan
> sebagai catatan proses.

1. **Tidak ada keunggulan terukur atas kebetulan pada sensitivitas default.** SUCCESS MEDIUM = basis acak empiris ± 1 poin di
   5m/15m dan +3,6 poin di 1h dengan CI yang memuat basis. Basis acak RW (61–66 %) bahkan di atas SUCCESS di semua grup.
   Sebabnya geometri penghalang §10: stop median 3,2–4,4 ATR vs target 2 ATR, sehingga rasio SUCCESS 55–62 % adalah *base
   rate* penghalang asimetris, bukan informasi. Ekspektasi kasar (SUCCESS +2 ATR, FAIL −s, TIMEOUT 0) pada 5m MEDIUM ≈
   0,577 × 2 − 0,303 × 3,92 ≈ −0,03 ATR sebelum biaya — nol. **Kesimpulan ini berlaku untuk definisi §10**; definisi lain
   (mis. target/stop simetris, atau keluar saat kandidat dibatalkan) belum diuji dan tidak boleh diasumsikan lebih baik.
2. **Tahap awal membedakan hasil jauh lebih kuat daripada skor.** Kandidat yang pertama tampil sudah CONFIRMED_BREAKOUT
   (membeli breakout yang sudah terjadi) adalah yang terburuk: SUCCESS 35–46 %, FAIL 54–65 % di semua TF & sensitivitas,
   jauh di bawah basis grup. Kandidat DEVELOPING-first adalah satu-satunya subset di atas basis grup dengan CI bawah di
   atas basis: 5m MEDIUM 61,7 % (CI 60,1–63,4) vs 56,8 % (+4,9 poin), 1h MEDIUM 68,2 % (62,1–73,7) vs 58,6 % (+9,6);
   15m MEDIUM 61,3 % (58,5–64,0) vs 59,8 % (+1,5, tidak signifikan). EARLY-first (hanya terlihat di HIGH) 42–48 % SUCCESS
   dengan FAIL ≈ 50 %. **Peringatan**: basis di tabel (c) adalah basis grup; jarak stop per tahap hampir pasti berbeda
   (EARLY dekat dasar → stop lebih rapat → basisnya sendiri lebih rendah; CONFIRMED jauh dari dasar → stop lebar → basis
   lebih tinggi), jadi selisih per tahap belum sah sampai basis per subset dihitung (run 3, §6.8). Yang sudah sah tanpa
   basis: CONFIRMED-first memiliki FAIL ≈ 60 % *dengan stop lebar* — buruk dari sisi mana pun.
3. **Tanda "terlambat" tidak mengidentifikasi hasil yang lebih buruk** di bawah definisi §10: kandidat terlambat SUCCESS
   60–63 % (FAIL 17–23 %) vs tepat waktu 50–57 % (FAIL 37–45 %). Penjelasan yang paling mungkin kembali ke geometri: harga
   yang sudah menjauh dari dasar berarti stop (invalidasi) lebih jauh → base rate lebih tinggi dan risiko per kandidat lebih
   besar. Karena itu **default `hideExtended` tetap mati**; keputusan final menunggu basis per subset (run 3).
4. **Skor masih membawa informasi di dalam tahap DEVELOPING**: DEVELOPING pada MEDIUM (skor ≥ 45) 61,7 / 61,3 / 68,2 % vs
   DEVELOPING pada HIGH (semua skor) 58,2 / 58,6 / 56,3 %. Distribusi (e): DEVELOPING median 37 (Q1–Q3 30–45) — MEDIUM
   meloloskan ≈ 30 % DEVELOPING dan ≈ 55 % CONFIRMED; EARLY maksimum 44–52, median 18–19, sehingga ambang EARLY yang
   "setara" MEDIUM berada di kisaran 20–25. Ambang per tahap **belum ditetapkan**: hasil EARLY-first belum menunjukkan
   bahwa menampilkannya di default adalah perbaikan (butir 2), dan hasil per bin skor baru ada di run 3.
5. **Reversal Radar tidak lebih awal dari mesin lama.** Hampir semua kandidat (96–97 %) punya sinyal QUIET/EARLY_BULLISH
   lama dalam ±48 candle, dengan lead median 0 … −2 candle dan hanya 42–49 % yang lebih dulu. Pada data nyata mesin ini
   memberi label yang lebih kaya (tahap, bukti, level) atas peristiwa yang sama, bukan deteksi yang lebih dini.
6. **"CONFIRMED sesaat" sebagian besar artefak**: 67–71 % pembatalan BREAKOUT_FAILED terjadi setelah target tercapai
   (retracement pasca-target), bukan setup yang gagal. Kekhawatiran §2.7 butir 2 pada data nyata jauh lebih kecil daripada
   yang tersirat dari angka 46–53 %.
7. **Bukti**: frekuensi identik dengan run 1 (data sama); daya pembeda per bukti (SUCCESS vs FAIL) tetap belum terukur dan
   tidak menjadi prioritas sebelum butir 1–3 terjawab.

### 6.8 Run 3 — pertanyaan yang belum sah dijawab & tambahan harness

Ditambahkan di PR tindak lanjut #23 supaya run 3 menjawab butir 2–4 §6.7 dengan basis yang adil:
- **Basis per subset**: `stopDistanceAtr`, `baselineRandomWalk`, `baselineShuffled`, `successMinusBaseline`, dan
  `expectancyAtr` (rata-rata +2 pada SUCCESS, −s pada FAIL, 0 pada TIMEOUT; tanpa biaya) di `outcomesByFirstStage.<tahap>`
  dan `outcomesByExtended.<status>` serta di level grup → kolom baru di "Hasil per tahap awal" dan "Hasil menurut status
  terlambat saat deteksi".
- **Hasil per bin skor saat deteksi per tahap** (grup HIGH): SUCCESS, basis empiris, selisih, ekspektasi per bin 10 poin →
  bagian "Hasil per bin skor saat deteksi (sensitivitas HIGH)" — dasar memilih ambang per tahap, bila ada bin yang
  melampaui basisnya.
- **T-NYATA-1 per tahap** (`T_NYATA_1_STAGE`): CI bawah SUCCESS subset > basis empiris subset, per TF × tahap pada MEDIUM.

Target run 3 (ditetapkan sekarang): keputusan "ambang per tahap" hanya diambil bila sebuah tahap/bin melampaui basis
subsetnya sendiri dengan CI bawah > basis **dan** ekspektasi ATR > 0; "sembunyikan CONFIRMED-first secara default" diambil
bila CONFIRMED-first tetap di bawah basis subsetnya. Perintah run 3 sama persis dengan run 2.

### 6.9 Run 3 — hasil (dijalankan pengguna 2026-10-26 23:35 UTC)

File: `reports/reversal-replay-20261026T233542Z.md` (+ `.json`), dilampirkan di thread proyek. Mesin `1e3bf9b` (parameter
tidak berubah sejak run 1), harness main setelah PR #23 (basis per subset, ekspektasi ATR, bin skor). Perintah sama persis
dengan run 1–2.

**Parameter run** (disalin dari bagian "Parameter" laporan): sumber Binance; 5m/15m/1h; 2025-06-01 → 2025-10-01; `--top 20`
→ discovery mengembalikan 20 simbol, **17 di-replay** (BTC, ETH, ZEC, SOL, HYPE, Q, XRP, NEAR, DOOD, ENA, BNB, 1000PEPE,
QNT, BULLA, DOGE, SUI, WLD); dilewati JCT, BTW, CAP ("tidak ada candle pada rentang"). Daftar ini **berbeda dari run 2**
(16 simbol: BULLAUSDT masuk top-20, APRUSDT keluar), sehingga angka run 3 tidak identik dengan run 2 walau rentang sama.
51 seri, 786 854 evaluasi mesin baru, 25 680 kandidat (semua sensitivitas), durasi 323 s. Horizon 48 candle, target
+2 × ATR, stop = invalidasi saat deteksi. **Uji anti-look-ahead**: 3 seri diperiksa, 0 gagal. **Peringatan kejujuran**:
pembanding mesin lama mode `fast` (sama dengan run 1–2).

**Pemeriksaan target data nyata** (semua pada MEDIUM; status disalin dari tabel "Pemeriksaan target §10"):

| TF | Target | Status | Nilai |
|---|---|---|---|
| 5m | T-NYATA-1 (grup) | TIDAK terpenuhi | SUCCESS 57,4 % (CI 55,9–58,9) vs basis empiris 56,5 %, n = 4 181 → +0,9 poin |
| 5m | T-NYATA-1 per tahap: EARLY-first | TIDAK terpenuhi | 60,0 % (31,3–83,2) vs 56,7 %, n = 10 — sampel terlalu kecil |
| 5m | T-NYATA-1 per tahap: DEVELOPING-first | TIDAK terpenuhi | 61,4 % (59,8–63,0) vs 60,0 %, n = 3 491 → +1,4; CI bawah 59,8 < basis |
| 5m | T-NYATA-1 per tahap: CONFIRMED-first | TIDAK terpenuhi | 36,6 % (33,1–40,3) vs 38,6 %, n = 680 → −2,0 |
| 5m | T-NYATA-2 lead per peristiwa | TIDAK terpenuhi | median 0 candle, n = 4 066 (lead > 0: 48,8 %) |
| 5m | T-NYATA-3 EARLY-first ≥ 10 % | TIDAK terpenuhi | 0,2 %, n = 4 184 |
| 15m | T-NYATA-1 (grup) | TIDAK terpenuhi | 59,4 % (56,8–61,9) vs 59,2 %, n = 1 394 → +0,2 |
| 15m | T-NYATA-1 per tahap: EARLY-first | TIDAK terpenuhi | 66,7 % vs 66,7 %, n = 3 — sampel terlalu kecil |
| 15m | T-NYATA-1 per tahap: DEVELOPING-first | TIDAK terpenuhi | 61,0 % (58,2–63,7) vs 61,6 %, n = 1 235 → −0,6 |
| 15m | T-NYATA-1 per tahap: CONFIRMED-first | TIDAK terpenuhi | 46,8 % (39,1–54,6) vs 40,4 %, n = 156 → +6,4; CI bawah 39,1 < basis |
| 15m | T-NYATA-2 | TIDAK terpenuhi | median −2 candle, n = 1 357 (lead > 0: 43,1 %) |
| 15m | T-NYATA-3 | TIDAK terpenuhi | 0,2 %, n = 1 397 |
| 1h | T-NYATA-1 (grup) | TIDAK terpenuhi | 62,5 % (57,0–67,6) vs 59,1 %, n = 317 → +3,4 |
| 1h | T-NYATA-1 per tahap: EARLY-first | tanpa data | 0 kandidat EARLY-first pada MEDIUM |
| 1h | T-NYATA-1 per tahap: DEVELOPING-first | TIDAK terpenuhi | 68,1 % (62,2–73,5) vs 63,0 %, n = 257 → +5,1; CI bawah 62,2 < basis |
| 1h | T-NYATA-1 per tahap: CONFIRMED-first | TIDAK terpenuhi | 38,3 % (27,1–51,0) vs 42,2 %, n = 60 → −3,9 |
| 1h | T-NYATA-2 | TIDAK terpenuhi | median −2 candle, n = 307 (lead > 0: 42,0 %) |
| 1h | T-NYATA-3 | TIDAK terpenuhi | 0,0 %, n = 320 |

Ringkasan grup MEDIUM (tabel "Basis pembanding tanpa keterampilan"): SUCCESS 57,4 / 59,4 / 62,5 %; basis acak empiris
56,5 / 59,2 / 59,1 %; basis acak RW 63,3 / 65,6 / 63,4 %; jarak stop median 3,88 / 4,30 / 3,85 ATR; ekspektasi kasar
+0,28 / +0,39 / +0,54 ATR (tanpa biaya). Ekspektasi basis acak **tidak dihitung** harness; karena SUCCESS ≈ basis dengan
jarak stop yang sama, ekspektasi positif ini bukan bukti keunggulan — ia sama-sama dimiliki entri acak pada periode ini.

**Hasil per tahap awal pada MEDIUM dengan basis subset** (tabel yang diminta kerangka §6.9; sumber: "Hasil per tahap awal"):

| TF | Tahap awal (MEDIUM) | Berlabel | SUCCESS (CI) | Jarak stop s median (ATR) | Basis empiris subset | Selisih | Ekspektasi (ATR) | T-NYATA-1 per tahap |
|---|---|---|---|---|---|---|---|---|
| 5m | EARLY_FORMATION | 10 | 60,0 % (31,3–83,2) | 1,83 | 56,7 % | +3,3 | +0,66 | TIDAK (n kecil) |
| 5m | DEVELOPING_REVERSAL | 3 491 | 61,4 % (59,8–63,0) | 4,49 | 60,0 % | +1,4 | +0,35 | TIDAK |
| 5m | CONFIRMED_BREAKOUT | 680 | 36,6 % (33,1–40,3) | 1,21 | 38,6 % | −2,0 | −0,04 | TIDAK |
| 15m | EARLY_FORMATION | 3 | 66,7 % (20,8–93,9) | 2,28 | 66,7 % | 0,0 | +0,58 | TIDAK (n kecil) |
| 15m | DEVELOPING_REVERSAL | 1 235 | 61,0 % (58,2–63,7) | 4,76 | 61,6 % | −0,6 | +0,41 | TIDAK |
| 15m | CONFIRMED_BREAKOUT | 156 | 46,8 % (39,1–54,6) | 1,26 | 40,4 % | +6,4 | +0,25 | TIDAK |
| 1h | EARLY_FORMATION | 0 | — | — | — | — | — | tanpa data |
| 1h | DEVELOPING_REVERSAL | 257 | 68,1 % (62,2–73,5) | 4,71 | 63,0 % | +5,1 | +0,67 | TIDAK |
| 1h | CONFIRMED_BREAKOUT | 60 | 38,3 % (27,1–51,0) | 1,35 | 42,2 % | −3,9 | −0,06 | TIDAK |

**Status terlambat saat deteksi pada MEDIUM, basis subset** (sumber: "Hasil menurut status terlambat saat deteksi"):

| TF | Status saat deteksi | Berlabel | SUCCESS (CI) | s median (ATR) | Basis empiris subset | Selisih | Ekspektasi (ATR) |
|---|---|---|---|---|---|---|---|
| 5m | terlambat (LATE_ENTRY/EXTENDED) | 2 337 | 60,5 % (58,5–62,4) | 5,68 | 58,7 % | +1,8 | +0,46 |
| 5m | tepat waktu | 1 844 | 53,5 % (51,2–55,8) | 2,91 | 53,8 % | −0,3 | +0,06 |
| 15m | terlambat | 823 | 61,7 % (58,4–65,0) | 6,10 | 62,5 % | −0,8 | +0,55 |
| 15m | tepat waktu | 571 | 56,0 % (51,9–60,1) | 2,92 | 54,5 % | +1,6 | +0,17 |
| 1h | terlambat | 194 | 61,3 % (54,3–67,9) | 5,50 | 59,5 % | +1,9 | +0,56 |
| 1h | tepat waktu | 123 | 64,2 % (55,4–72,1) | 2,83 | 58,5 % | +5,7 | +0,49 |

**Hasil per bin skor saat deteksi** (HIGH = semua kandidat; basis & ekspektasi per bin; tabel lengkap 56 baris ada di
laporan). Dihitung dari `.json` (`outcomesByScoreBin`), hanya bin dengan n ≥ 20 kandidat berlabel:

| Ukuran bin | Jumlah bin | CI bawah SUCCESS > basis bin | CI atas SUCCESS < basis bin |
|---|---|---|---|
| n ≥ 20 | 43 | 4 — 5m EARLY 30–39 (n 273, +6,1), 5m DEVELOPING 60–69 (n 380, +5,0; CI bawah 58,5 vs basis 58,4), 5m DEVELOPING 70–79 (n 66, +19,7), 15m CONFIRMED 50–59 (n 74, +12,6) | 8 — 5m DEVELOPING 20–29 (n 3 111, −1,8) dan 30–39 (n 4 889, −1,8), 15m EARLY 10–19 (n 700, −4,6), 15m DEVELOPING 60–69 (n 135, −11,1), 1h DEVELOPING 10–19 (n 41, −17,9), 20–29 (n 329, −11,7), 30–39 (n 425, −4,7), 1h CONFIRMED 30–39 (n 35, −19,0) |
| n ≥ 100 | 27 | 2 | 6 |

Selisih tidak monoton terhadap skor: pada 5m DEVELOPING selisih naik dari −2,3 (bin 10–19) ke +19,7 (70–79), tetapi pada
15m DEVELOPING bin 60–69 justru −11,1 (signifikan di bawah basis) dan pada 1h DEVELOPING bin rendah signifikan di bawah
basis sementara bin 60–79 positif dengan n 33 dan 7. Distribusi skor per tahap (HIGH): EARLY median 18–19 (maks 44–52),
DEVELOPING 35–37, CONFIRMED 43–47 — sama dengan run 2.

**Sensitivitas LOW (skor ≥ 60, bukti ≥ 4) — eksploratif, bukan target pra-registrasi** (sumber: baris LOW pada "Basis
pembanding" dan "Hasil per tahap awal"; kolom terakhir = angka run 2 pada data yang hampir sama, jadi **bukan konfirmasi
independen**):

| TF | Subset LOW | Berlabel | SUCCESS (CI) | Basis empiris subset | Selisih | Ekspektasi (ATR) | Run 2 |
|---|---|---|---|---|---|---|---|
| 5m | semua kandidat | 564 | 59,6 % (55,5–63,5) | 54,3 % | +5,3 (CI bawah > basis) | +0,43 | +4,2 (CI bawah = basis) |
| 5m | DEVELOPING-first | 453 | 65,3 % (60,8–69,6) | 58,0 % | +7,4 (CI bawah > basis) | +0,55 | SUCCESS 65,2 % (basis subset belum ada) |
| 5m | CONFIRMED-first | 111 | 36,0 % (27,7–45,3) | 39,3 % | −3,3 | −0,04 | 35,2 % |
| 15m | semua kandidat | 197 | 49,7 % (42,8–56,7) | 58,2 % | −8,5 (CI atas < basis) | +0,13 | −8,9 |
| 15m | DEVELOPING-first | 163 | 51,5 % (43,9–59,1) | 61,6 % | −10,0 (CI atas < basis) | +0,16 | 52,3 % |
| 1h | semua kandidat | 52 | 71,2 % (57,7–81,7) | 55,8 % | +15,4 (CI bawah > basis) | +0,63 | +13,6 (CI bawah < basis) |
| 1h | DEVELOPING-first | 40 | 77,5 % (62,5–87,7) | 56,7 % | +20,8 (CI bawah > basis) | +0,71 | 76,3 % |

**State machine (HIGH)**: mencapai CONFIRMED 27,9 / 46,5 / 49,0 %; "CONFIRMED sesaat" 53,4 / 51,4 / 46,4 %; breakout gagal
**sebelum** target 29,4 / 30,8 / 33,0 % (sisanya setelah target tercapai — konsisten dengan run 2). **Ekskursi MEDIUM**:
MFE median 2,00 ATR (dibatasi target), MAE median −1,44 / −1,53 / −1,29 ATR; pada 5m MFE median 0,47 % vs MAE −0,45 %
(≈ level biaya). **Frekuensi bukti** sama dengan run 1–2 (LL_STOPPED 74 % evaluasi, HIGHER_LOW 54–55 %, EMA7_TURN_UP 42 %,
EMA_CONVERGENCE 38 %, CHOCH_BULLISH 36 %).

**Bacaan run 3 — vonis aturan yang ditetapkan SEBELUM run (§6.8, docs/19 §10):**

1. **Tidak ada tahap pada MEDIUM yang melampaui basis subsetnya sendiri** (CI bawah > basis): 0 dari 8 sel T-NYATA-1 per
   tahap terpenuhi. Aturan §6.8 → **tidak ada ambang per tahap yang diubah**, tidak ada kalibrasi.
2. **Dua bacaan run 2 ternyata artefak geometri stop, bukan sifat tahap.** DEVELOPING-first "di atas basis grup" (+4,9 /
   +9,6 poin) menyusut menjadi +1,4 / −0,6 / +5,1 terhadap basis subsetnya (jarak stop 4,5–4,8 ATR → basis 60–63 %).
   CONFIRMED-first "paling buruk" (SUCCESS 37–47 %) ternyata **setara basis subsetnya** 38–42 % (jarak stop 1,2–1,35 ATR
   → basis s/(2+s) ≈ 38 %), ekspektasi ≈ 0 ATR. CONFIRMED-first bukan lebih buruk dari kebetulan; ia setup dengan stop rapat
   dan rasio target:stop ≈ 1,5:1. Keputusan "sembunyikan / beri peringatan CONFIRMED-first" **tidak punya dasar hasil** —
   label "breakout sudah terjadi saat deteksi" boleh ada sebagai deskripsi struktur, bukan peringatan mutu.
3. **Terlambat vs tepat waktu**: keduanya setara basis subsetnya (terlambat −0,8 … +1,9 poin; tepat waktu −0,3 … +5,7; CI
   memuat basis). Bacaan run 2 "terlambat tidak lebih buruk" dikonfirmasi sebagai geometri (s 5,5–6,1 vs 2,8–2,9 ATR).
   Default `hideExtended` tidak punya dasar untuk diubah ke arah mana pun.
4. **Bin skor tidak memberi ambang yang didukung data**: dari 43 bin (n ≥ 20) 4 di atas dan 8 di bawah basisnya; pada
   n ≥ 100, 2 vs 6. Sel yang lolos berukuran kecil atau bermargin 0,1–0,2 poin, dan sel yang sama di TF lain berlawanan
   tanda (5m DEVELOPING 60–69 +5,0 vs 15m −11,1). Dengan ~45 pembanding, ini pola derau di sekitar nol, bukan sinyal.
5. **Sensitivitas LOW** memberi dua sel yang konsisten antara run 2 dan run 3 — 5m DEVELOPING-first (+7,4) dan 1h
   keseluruhan (+15,4, n 52) — sementara 15m LOW signifikan **di bawah** basis (−8,5 / −10,0). Run 2 dan run 3 memakai data
   yang hampir sama, jadi ini bukan replikasi. Dengan ~60 pembanding total, dua sel positif dan satu negatif signifikan
   adalah yang diharapkan dari kebetulan. Sel ini **tidak** dijadikan keputusan; satu-satunya cara jujur mengujinya adalah
   data luar sampel yang belum pernah dilihat, ditetapkan di §6.10 sebagai **uji terakhir** dengan konsekuensi yang sudah
   ditulis sebelum run.
6. **Lead per peristiwa** tetap 0 / −2 / −2 candle (lead > 0 hanya 42–49 % kandidat berpadanan): Reversal Radar tetap tidak
   lebih awal dari mesin SA/PVA lama.
7. **Kesimpulan tiga run**: pada data Jun–Okt 2025 Reversal Radar **tidak menunjukkan keunggulan terukur** atas entri acak
   pada penghalang yang sama — di tingkat grup, tahap awal, status terlambat, dan bin skor — dan tidak lebih awal dari mesin
   lama. Yang dapat dipertanggungjawabkan hanyalah fungsi **pelabel struktur** (tahap, bukti, level, invalidasi) yang dapat
   dijelaskan; posisi produk itu keputusan pengguna (§7).

### 6.10 Run 4 — uji luar sampel TERAKHIR (ditetapkan 2026-10-27, SEBELUM run)

- **Pertanyaan**: apakah dua sel LOW yang lolos secara terisolasi pada run 2–3 (§6.9 butir 5) bertahan pada data yang belum
  pernah dilihat oleh siapa pun dalam proses ini?
- **Data**: Binance, periode **2026-06-01 → 2026-10-01** (tidak tumpang tindih dengan Jun–Okt 2025), 5m/15m/1h, simbol =
  `--top 20` saat run (daftar boleh berbeda), parameter mesin dan definisi §10 sama; harness main setelah PR tindak lanjut
  run 3 (target `T_NYATA_4`/`T_NYATA_5` di `REAL_DATA_TARGET_RULES`, tercetak di "Pemeriksaan target §10").
- **Sel keputusan & kriteria**: (T-NYATA-4) **5m**, kandidat pertama DEVELOPING_REVERSAL pada LOW: CI bawah Wilson 95 %
  SUCCESS > basis empiris subset **dan** selisih ≥ 3 poin **dan** ekspektasi ATR > 0; (T-NYATA-5) **1h**, semua kandidat LOW:
  kriteria sama terhadap basis empiris grup. Baris T-NYATA-4/5 pada TF lain adalah **kontrol konsistensi** yang dilaporkan
  di samping sel keputusan, bukan sel keputusan; kontrol yang signifikan di bawah basis dicatat sebagai peringatan pada
  label.
- **Konsekuensi (ditetapkan sekarang)**: sel **lulus** → kandidat sel itu diberi label "didukung satu uji luar sampel
  (docs/21 §6.10)" di UI; default sensitivitas, `SENSITIVITY_FILTERS`, dan parameter mesin **tetap**. Sel **gagal** → sel
  ditutup sebagai derau; **tidak ada** uji lanjutan untuk sel, bin, atau ambang lain pada data mana pun dari proses ini
  (menghindari pencarian hasil). Dengan dua uji pada 95 %, peluang ≥ 1 kelulusan palsu ≈ 10 % — satu kelulusan tetap
  dilabeli "satu uji luar sampel", bukan "terbukti".
- **Perintah di Mac** (setelah PR tindak lanjut run 3 di-merge):

```bash
cd ~/Caddle && git pull origin main && npm ci
npm run reversal:replay -- --top 20 --timeframes 5m,15m,1h --from 2026-06-01 --to 2026-10-01 --check-lookahead
```

- **Hasil run 4**: <!-- diisi dari reports/reversal-replay-<ts>.md run 4: baris T-NYATA-4/5 di "Pemeriksaan target §10", baris LOW di "Basis pembanding tanpa keterampilan" & "Hasil per tahap awal", "Uji anti-look-ahead", "Peringatan kejujuran", daftar simbol & simbol dilewati -->

| TF | Sel (LOW) | Peran | Berlabel | SUCCESS (CI) | Basis empiris subset | Selisih | Ekspektasi (ATR) | Status |
|---|---|---|---|---|---|---|---|---|
| 5m | DEVELOPING-first | **keputusan (T-NYATA-4)** | <!-- diisi --> | | | | | |
| 15m | DEVELOPING-first | kontrol | | | | | | |
| 1h | DEVELOPING-first | kontrol | | | | | | |
| 5m | semua kandidat | kontrol | | | | | | |
| 15m | semua kandidat | kontrol | | | | | | |
| 1h | semua kandidat | **keputusan (T-NYATA-5)** | | | | | | |

## 7. Keputusan

Keputusan setelah set sintetis (§2–§3) tetap berlaku untuk parameter mesin. Di bawah ini keputusan setelah **tiga run data
nyata** (§6.1–§6.9), dalam urutan dari yang paling pasti.

- **Vonis data nyata (Jun–Okt 2025, 16–17 simbol, definisi §10, tiga run)**: Reversal Radar **tidak menunjukkan keunggulan
  terukur atas entri acak pada penghalang yang sama** — di tingkat grup (T-NYATA-1: +0,9 / +0,2 / +3,4 poin, CI memuat
  basis), per tahap awal dengan basis subset (T-NYATA-1 per tahap: 0 dari 8 sel terpenuhi), per status terlambat, dan per
  bin skor (4 bin di atas vs 8 di bawah basisnya dari 43) — **tidak lebih awal dari mesin lama** (T-NYATA-2: median lead per
  peristiwa 0 / −2 / −2 candle; 96–97 % kandidat punya sinyal lama dalam ±48 candle), dan **daftar Early Formation praktis
  kosong** di default (T-NYATA-3: 0–0,2 %). Tidak ada angka dari dokumen ini yang boleh disajikan sebagai peluang atau
  keunggulan.
- **Koreksi bacaan run 2 (§6.7 butir 2)**: "DEVELOPING-first lebih baik" dan "CONFIRMED-first paling buruk" adalah **artefak
  geometri stop** (basis grup vs basis subset, §6.9 butir 2). Dengan basis subsetnya masing-masing, keduanya setara
  kebetulan; CONFIRMED-first hanyalah setup dengan stop rapat.
- **Parameter mesin `DEFAULT_REVERSAL_PARAMS` tidak diubah; `REVERSAL_VERSION` tetap 1.** Bukti yang lolos pada 36–74 %
  evaluasi (LL_STOPPED, HIGHER_LOW, EMA7_TURN_UP, EMA_CONVERGENCE, CHOCH_BULLISH) tetap kandidat penyetelan, tetapi daya
  pembedanya belum terukur dan penyetelan bobot baru masuk akal setelah posisi produk jelas; perubahan apa pun harus melewati
  replay sintetis seed 1–20 → 21–60 lalu data nyata luar sampel.
- **Sensitivitas default MEDIUM, `SENSITIVITY_FILTERS`, dan ambang per tahap tidak diubah** — aturan pra-registrasi §6.8
  tidak terpenuhi oleh tahap/bin mana pun. LOW **tidak** dijadikan default 5m/1h atas dasar dua sel terisolasi (§6.9 butir 5);
  sel itu mendapat satu uji luar sampel terakhir (§6.10) dengan konsekuensi yang sudah ditetapkan sebelum run.
- **CONFIRMED-first tidak disembunyikan dan tidak diberi peringatan mutu** (setara basis subsetnya, §6.9 butir 2). Label
  deskriptif "breakout sudah terjadi saat deteksi" boleh ditambahkan sebagai informasi struktur bila pengguna
  menginginkannya — itu keputusan produk, bukan keputusan validasi.
- **Default toggle "Sembunyikan yang sudah extended" tetap mati**: kedua subset setara basis subsetnya (§6.9 butir 3).
- **Kalibrasi probabilitas tidak dilakukan.** Skor tetap skor aturan; dengan §6.6–§6.9 kalibrasi tidak punya dasar.
- **UI: catatan status validasi diperbarui ke hasil run 3** (`data-testid="reversal-validation"`, teks statis di
  `frontend/js/views/reversalRadar.js`): menyebut tiga run, basis per subset (tahap, status terlambat, bin skor), lead vs
  mesin lama, dan bahwa tidak ada tahap atau ambang skor yang terbukti lebih baik dari kebetulan. Teks bantuan filter
  Sedang/Rendah tetap menyebut bahwa kandidat Early Formation belum terbukti lebih baik dari kebetulan (kini merujuk §6.9).
- **Target §10 sintetis yang masih TIDAK terpenuhi** tetap tercatat dan tidak dilonggarkan: `continuedDowntrend` ≤ 15 % seri
  pada HIGH (32,5 % / 37,5 %) dan lead kandidat pertama > 0 pada MEDIUM (−31 / −5 candle).
- **Definisi keberhasilan §10 tidak diganti setelah melihat hasil.** Definisi tambahan (mis. target/stop simetris 2 ATR,
  atau keluar saat kandidat dibatalkan/kedaluwarsa) boleh **ditetapkan sebelum run berikutnya sebagai hipotesis terpisah**
  dan dilaporkan berdampingan — tidak menggantikan §10 dan tidak dipilih berdasarkan hasilnya. Untuk run 4 **tidak** ada
  definisi tambahan: run 4 hanya menguji dua sel §6.10 dengan definisi §10 yang sama.
- **Posisi produk — keputusan pengguna** (diajukan 2026-10-27 di thread proyek; sampai diputuskan UI tetap seperti sekarang,
  yaitu catatan validasi di kepala panel):
  (A) **reposisi** Reversal Radar sebagai **pelabel struktur** — tahap, bukti, level, invalidasi, dengan teks UI "bukan
  prediksi" — **plus satu uji luar sampel terakhir** §6.10 untuk dua sel LOW (rekomendasi);
  (B) reposisi saja, tanpa uji lagi;
  (C) biarkan seperti sekarang (catatan validasi saja), tanpa uji lagi;
  (D) cabut Reversal Radar dari LONG Scanner dan kembalikan tampilan SA/PVA lama (mesin, API, dan replay tetap ada untuk
  riset).
- **Urutan pekerjaan berikutnya**:
  1. Keputusan produk (A–D) oleh pengguna.
  2. Bila A: run 4 di Mac dengan perintah §6.10 → isi tabel §6.10 → terapkan konsekuensi yang sudah ditetapkan (label UI
     untuk sel yang lulus, atau penutupan sel). Bila A/B: ubah teks UI (subjudul, komentar modul, docs/19 §0/§8) ke posisi
     pelabel struktur. Bila D: PR terpisah yang mengembalikan tampilan LONG lama tanpa menghapus `backend/reversal`.
  3. Tetap terbuka dari §3/§5: fixture `brokenData` ≥ 120 candle rusak; fixture dasar mangkuk / lantai naik / volume
     mengering; pembanding lama mode `full`.
