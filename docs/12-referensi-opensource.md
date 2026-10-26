# 12 — Riset referensi open source (indikator, struktur pasar, backtest, data)

Tanggal riset: 2026-10-26. Pertanyaan pemilik: "apakah ada proyek open source di GitHub yang bisa dijadikan
referensi untuk website saya; bila ada, analisis dulu lalu implementasikan".

**Ringkasan keputusan:** tidak ada pustaka yang layak menjadi dependensi runtime baru. Nilai terbesar dari
open source untuk AlphaLens adalah (1) **definisi algoritma** yang ditulis ulang sendiri di
`backend/features/*` dan `backend/backtest/*`, (2) **golden test** (angka acuan dari pustaka lain yang dihitung
di luar repo lalu dibekukan sebagai fixture), dan (3) **sumber data historis** `data.binance.vision` untuk
backtest. Ini selaras dengan kontrak v3 (`docs/10-kontrak-akurasi-v3.md`: fungsi murni, tanpa dependensi npm
baru) dan kebijakan `docs/06-evaluasi-dependensi.md` (`ignore-scripts=true`, versi exact).

**Kejujuran soal akurasi:** tidak satu pun proyek di bawah menerbitkan bukti bahwa sinyalnya "benar 99%".
Pustaka indikator hanya dapat dibuktikan *konsisten secara matematis* dengan pustaka lain (TA-Lib, TradingView),
bukan *prediktif*. Pustaka SMC tidak menyertakan evaluasi out-of-sample sama sekali. Satu-satunya cara jujur
untuk mengukur akurasi adalah backtest walk-forward dengan label triple barrier, interval kepercayaan Wilson,
dan koreksi multiple testing (bagian 4.3) pada data nyata.

## 1. Metode & keterbatasan

- Metadata npm dibaca dari registry (`npm view`, `registry.npmjs.org/<pkg>`): versi `latest`, tanggal rilis
  versi itu, lisensi, `dependencies`, script `preinstall/install/postinstall`, `type`.
- Metadata PyPI dibaca dari `https://pypi.org/pypi/<pkg>/json` (versi, `upload_time`, lisensi/classifier).
- README GitHub dibaca lewat penelusur web. Kode sumber `smartmoneyconcepts/smc.py` dibaca dari halaman GitHub
  (bukan diunduh/dijalankan). **Tidak ada paket pihak ketiga yang dipasang atau dijalankan.**
- Domain `www.tradingview.com`, `www.luxalgo.com`, `www.freqtrade.io`, `raw.githubusercontent.com`,
  `*.readthedocs.io` tidak dapat dijangkau dari lingkungan ini. Dokumen Freqtrade dibaca dari folder `docs/`
  di repo GitHub-nya. Uraian LuxAlgo SMC (4.1.2) disusun dari pengetahuan umum tentang skrip publik tersebut dan
  **belum diverifikasi ulang terhadap sumber** — perlakukan sebagai deskripsi konsep, bukan kutipan.
- Jumlah bintang/commit berubah cepat; hanya dicantumkan bila terbaca.

## 2. Tabel kandidat

Legenda keputusan: **(a)** layak jadi dependensi · **(b)** referensi algoritma / golden test · **(c)** ditolak.

### 2.1 Pustaka indikator JavaScript / Node

| Paket | Versi terakhir (tgl rilis) | Lisensi | Dependensi & install script | Cocok Node 22/24 ESM tanpa bundler? | Keputusan |
|---|---|---|---|---|---|
| `trading-signals` (bennycode) | 8.3.0 (2026-08-11) | MIT | 0 dependensi, tanpa install script | Ya, `"type": "module"` | **(b)** golden test sekunder; API streaming (`update()` per candle) bagus sebagai pola. Bukan dependensi: kontrak v3 melarang dependensi baru dan indikator kita sudah ada. |
| `@ixjb94/indicators` | 1.2.6 (2026-06-26) | MIT | 0 dependensi, tanpa install script | Ya (ES6 + CJS) | **(b)** golden test; README mengklaim "diuji dengan data TradingView dan pustaka lain" (data DOGEUSDT 4h) — klaim konsistensi, bukan akurasi prediksi. |
| `indicatorts` (cinar) | 2.2.2 (2025-02-26) | MIT | 0 dependensi | Ya (TS → JS) | **(b)** referensi rumus saja; rilis terakhir > 1,5 tahun. |
| `fast-technical-indicators` | 1.1.6 (2026-08-24) | MIT | 0 dependensi | CJS saja (`"type": "commonjs"`) | **(c)** 1 maintainer, tanpa rekam jejak; tidak menambah apa pun. |
| `technicalindicators` | 3.1.0 (2020-03-16) | MIT | `@types/node@^6` sebagai dependensi runtime | CJS | **(c)** tidak terpelihara sejak 2020; dependensi runtime aneh. |
| `tulind` (Tulip) | 0.8.20 (2021-08-08) | **LGPL-3.0** | `node-pre-gyp`, `nan`, `bindings`; **install script** `node-pre-gyp install --fallback-to-build` | Native addon; rusak dengan `ignore-scripts=true` | **(c)** native + install script + LGPL + mati. |
| `talib` (binding TA-Lib) | 2.0.6 (2026-10-06) | **LGPL-3.0-or-later** | `nan`; **install script** `node build.js && node-gyp configure && node-gyp build`; tarball ±27 MB | Native, CJS | **(c)** butuh kompilasi saat install (bertentangan dengan `ignore-scripts=true`), LGPL, permukaan supply chain besar. TA-Lib tetap berguna sebagai *sumber angka acuan* di luar repo. |
| `@debut/indicators` | 2.0.1 | **GPL-3.0** | — | — | **(c)** GPL menular ke kode yang ditautkan. |
| `pinets` (LuxAlgo, runtime Pine di JS) | 0.13.0 (2026-10-22) | **AGPL-3.0-only** | `acorn`, `acorn-walk`, `astring` | ESM | **(c)** AGPL; menjalankan Pine pihak ketiga = interpretasi kode tak tepercaya; skrip LuxAlgo sendiri berlisensi NC. |

### 2.2 Struktur pasar / Smart Money Concepts

| Proyek | Versi (tgl) | Lisensi | Catatan teknis | Keputusan |
|---|---|---|---|---|
| `smartmoneyconcepts` (joshyattridge/smart-money-concepts, Python) | 0.0.27 (PyPI 2026-04-03); ±2,1k bintang | MIT (file LICENSE di repo; metadata PyPI kosong) | pandas + numpy + numba. **Punya lookahead bawaan** (lihat 4.1.1) dan beberapa bug kecil. | **(b)** referensi definisi BOS/CHoCH, OB, FVG, likuiditas — ditulis ulang secara kausal. **Tidak** untuk golden test langsung karena keluarannya memakai data masa depan. |
| Smart Money Concepts [LuxAlgo] (Pine Script, TradingView) | — | CC BY-NC-SA 4.0 (tercantum di header salinan kode; halaman resmi tidak terjangkau) | Desain kausal (pivot terkonfirmasi tertunda, status tren internal) — paling dekat dengan kontrak v3. | **(b)** hanya **konsep** (ide tidak dilindungi hak cipta). **Dilarang menyalin/menerjemahkan kode baris per baris**: NC (non-komersial) + SA (share-alike) tidak cocok dengan aplikasi privat `UNLICENSED`. |

### 2.3 Backtest & validasi

| Proyek | Versi (tgl) | Lisensi | Bahasa | Yang berguna | Keputusan |
|---|---|---|---|---|---|
| freqtrade | 2026.9 (2026-09-29) | **GPL-3.0** | Python | Metodologi `lookahead-analysis` & `recursive-analysis` (4.2) | **(b)** metodologi saja; kode tidak disalin (GPL). |
| jesse | 3.5.1 (2026-10-25) | MIT | Python | Konsep "candle tidak boleh melihat masa depan", simulasi multi-timeframe | **(b)** referensi ringan; terlalu besar untuk dijadikan apa pun selain bacaan. |
| backtesting.py (`backtesting`) | 0.6.6 (2026-07-22) | **AGPL-3.0** | Python | Statistik standar (SQN, profit factor, expectancy) | **(c)** AGPL; tidak ada yang tidak kita punya. |
| vectorbt | 1.2.0 (2026-10-19) | Apache-2.0 + **Commons Clause** | Python | Backtest vektorisasi cepat | **(c)** bukan open source OSI; Commons Clause membatasi penggunaan komersial. |
| mlfinlab (Hudson & Thames) | tidak lagi di PyPI publik | **"All rights reserved"**, berbayar (versi lama BSD-3 di mirror) | Python | Triple barrier, meta-labeling, purged CV | **(c)** sebagai kode. Algoritmanya berasal dari buku López de Prado (2018) dan **ditulis ulang dari buku**, bukan dari mlfinlab atau fork-nya (fork seperti `famlafl` tetap membawa lisensi H&T). |
| mlfinpy | 0.1.2 (2024-10-09) | MIT | Python | Implementasi ulang AFML | **(b)** pembanding sekunder untuk triple barrier; tidak terpelihara aktif. |
| hftbacktest | 2.4.4 (2025-12-10) | MIT | Rust/Python | Simulasi order book tick, latensi, antrean | **(c)** domain HFT; AlphaLens bekerja di candle 15m–1d. |
| Lumibot | 4.6.30 (2026-10-24) | **GPL-3.0** | Python | Framework bot multi-broker | **(c)** GPL, di luar lingkup (kita tidak mengeksekusi order). |
| pandas-ta | 0.4.71b0 (2025-09-14, beta) | — (tidak diperiksa) | Python | Indikator | **(c)** untuk golden test pilih `ta` (MIT) yang sudah dipakai agent lain; pandas-ta berstatus beta. |
| `ta` (bukosabino) | 0.11.0 (2023-11-02) | MIT | Python | OBV, CMF, ADX, Bollinger, A/D | **(b)** golden test utama (sudah dipakai). Rilis lama tetapi rumus stabil. |

### 2.4 Data

| Proyek | Versi (tgl) | Lisensi | Catatan | Keputusan |
|---|---|---|---|---|
| ccxt | 4.5.90 (2026-10) | MIT | 6 dependensi runtime (`ws`, `undici`, `@noble/*`, `@scure/*`), **`postinstall: node postinstall.js`**, metadata registry ±23 MB, rilis hampir harian | **(c)** kita hanya memakai Binance publik dan sudah punya klien sendiri; ccxt menambah permukaan supply chain besar dan churn versi tinggi demi fitur yang tidak dipakai. Boleh dibaca sebagai referensi penanganan rate-limit. |
| `data.binance.vision` (binance/binance-public-data) | dataset | Repo MIT + Terms & Conditions Binance untuk dataset | Arsip ZIP klines harian/bulanan + file `.CHECKSUM` SHA-256; kolom identik dengan REST klines (termasuk taker buy volume) | **(a — sebagai sumber data, bukan paket npm)** untuk backtest `scripts/backtest.js`. Lihat 4.4. |
| Screener/bot kripto open source (OctoBot GPL-3, Hummingbot Apache-2.0, Superalgos Apache-2.0) | tidak diverifikasi versi | lihat kiri | Framework eksekusi bot, bukan screener riset | **(c)** di luar lingkup; tidak ada yang menerbitkan validasi akurasi sinyal. |

## 3. Kesimpulan per kategori

- **(a) Layak jadi dependensi:** *tidak ada paket npm*. Setiap kandidat bermanfaat sudah 0-dependensi dan
  rumusnya pendek, sehingga menulis ulang (±30–80 baris per fitur, teruji) lebih murah daripada menambah
  dependensi yang harus diaudit tiap rilis. Satu-satunya sumber eksternal yang diadopsi adalah **data**
  `data.binance.vision`.
- **(b) Referensi algoritma / golden test:** `smartmoneyconcepts` (definisi), LuxAlgo SMC (konsep kausal),
  López de Prado (triple barrier, purged/embargo CV, deflated Sharpe), freqtrade (uji lookahead & rekursif),
  `ta` (golden test utama), `trading-signals` / `@ixjb94/indicators` (golden test sekunder, dihitung di luar
  repo).
- **(c) Ditolak:** native/LGPL (`talib`, `tulind`), GPL/AGPL (`@debut/indicators`, `pinets`, backtesting.py,
  freqtrade sebagai kode, Lumibot), non-OSI (vectorbt, mlfinlab), tidak terpelihara (`technicalindicators`),
  di luar lingkup (hftbacktest, ccxt, framework bot).

## 4. Algoritma yang patut ditiru (spesifikasi untuk integrator)

### 4.1 Struktur pasar (`backend/features/marketStructure.js`, `liquidity.js`)

#### 4.1.1 Definisi `smartmoneyconcepts` (joshyattridge) dan jebakannya

Dibaca dari `smartmoneyconcepts/smc.py` (cabang `master`):

1. **Swing** `swing_highs_lows(ohlc, swing_length=50)`: high di bar *t* adalah swing high bila ia maksimum
   jendela `t−L+1 … t+L` (implementasi: `swing_length *= 2`, lalu `high.shift(-(L//2)).rolling(2L).max()`),
   cermin untuk low. Lalu dipaksa **berselang-seling**: dua swing high berurutan → simpan yang lebih tinggi;
   dua low berurutan → simpan yang lebih rendah; diulang sampai stabil. Baris pertama/terakhir diberi swing
   sintetis. *Jebakan:* tidak ada `confirmedIndex`; swing baru sah setelah L bar ke depan.
   → **Tiru:** aturan selang-seling (alternation) di atas `findSwings` + `confirmedAt` kita. Jangan tiru
   swing sintetis di ujung.
2. **BOS/CHoCH** `bos_choch(ohlc, swings, close_break=True)` memakai 4 swing terakhir P1..P4 (urutan waktu):

   | Sinyal | Pola tipe | Syarat level | Level yang harus ditembus |
   |---|---|---|---|
   | BOS bullish | L, H, L, H | L1 < L3 < H2 < H4 | H2 |
   | BOS bearish | H, L, H, L | H1 > H3 > L2 > L4 | L2 |
   | CHoCH bullish | L, H, L, H | H4 > H2 > L1 > L3 | H2 |
   | CHoCH bearish | H, L, H, L | L4 < L2 < H1 < H3 | L2 |

   "Broken index" = bar pertama ≥ indeks P2 + 2 yang `close` (atau high/low bila `close_break=False`)
   melewati level. Sinyal yang tidak pernah tertembus dibuang; sinyal lama yang ditembus setelah sinyal baru
   dihapus. *Jebakan:* sinyal ditempatkan di bar P2 (masa lalu) dan penembusan dicari ke depan → **lookahead
   bila dipakai langsung untuk backtest**; ada variabel `j` basi pada pembersihan tumpang-tindih.
   → **Tiru:** syarat level 4-titik sebagai *klasifikasi* struktur (HH/HL/LH/LL) dan `close_break=True`
   (penembusan berdasarkan close, bukan wick) sebagai default. Event dicatat **di bar penembusan** (`index` =
   bar close yang menembus, `barsAgo` dari situ), dan hanya swing dengan `confirmedIndex < index penembusan`.
3. **Order block** `ob(ohlc, swings, close_mitigation=False)`: saat `close` menembus swing high terakhir
   yang belum dipakai, OB bullish = candle dengan **low terendah** di antara swing high itu dan bar penembusan
   (seri: ambil yang terakhir); `Top/Bottom` = high/low candle itu. Mitigasi bullish saat harga turun di
   bawah `Bottom` (atau close bila `close_mitigation`); OB yang termitigasi menjadi *breaker* dan dihapus bila
   harga menembus sisi berlawanan. `OBVolume` = volume 3 candle terakhir, `Percentage` = min/max volume.
   Cermin untuk bearish. *Bug:* fallback bullish (tanpa candle di antara) menukar top/bottom; indeks mitigasi
   bullish/bearish tidak konsisten (−1).
   → **Tiru** (opsional, bila ditambahkan ke `liquidity.js`): pemilihan candle ekstrem antara swing dan
   penembusan, mitigasi berbasis wick, status aktif/termitigasi. Uji khusus untuk kasus 0 candle di antara.
4. **FVG** `fvg(ohlc)`: bullish di bar *i* bila `high[i−1] < low[i+1]` dan candle *i* bullish
   (`close > open`); zona `[high[i−1], low[i+1]]`. Bearish: `low[i−1] > high[i+1]` dan candle *i* bearish.
   Mitigasi = bar pertama ≥ *i+2* yang masuk ke zona. *Jebakan:* FVG di bar *i* baru diketahui setelah bar
   *i+1* tutup; `MitigatedIndex = 0` ambigu.
   → **Tiru** dengan penanda kausal: catat FVG pada indeks *i+1* (`confirmedIndex = i+1`), pakai `null` untuk
   "belum termitigasi".
5. **Likuiditas (equal highs/lows)** `liquidity(ohlc, swings, range_percent=0.01)`: kelompokkan ≥ 2 swing
   high yang berada dalam ±r dari swing pertama; level = rata-rata; "swept" = bar pertama yang high-nya ≥
   batas atas pita. *Jebakan:* `r = (max(high) − min(low)) × 1%` dihitung dari **seluruh dataset** (lookahead).
   → **Tiru** dengan toleransi kausal `r = k × ATR(14)` pada bar evaluasi (mis. k = 0,1–0,25), yang juga
   dipakai LuxAlgo (4.1.2). Cocok untuk `sweepHigh/sweepLow` di kontrak v3: sapuan = wick menembus level
   kelompok lalu `close` kembali di dalam (reclaimed).

#### 4.1.2 Konsep LuxAlgo SMC (hanya ide; kode NC, jangan disalin)

- Dua lapis struktur: **internal** (pivot pendek, ±5 bar) dan **swing** (pivot panjang, ±50 bar). Pivot
  dikonfirmasi tertunda sebesar panjang pivot — setara `findSwings({left: n, right: n})` + `confirmedIndex`.
- Variabel **tren berjalan** (bullish/bearish). Saat `close` menembus pivot high terakhir yang belum
  ditembus: bila tren sebelumnya bearish → **CHoCH bullish**, selain itu → **BOS bullish**; tren menjadi
  bullish dan pivot ditandai "sudah ditembus" (tidak memicu dua kali). Cermin untuk pivot low. Inilah definisi
  kontrak v3 (`BOS` = searah bias, `CHOCH` = berlawanan bias) dan **lebih sederhana serta kausal** daripada
  pola 4-titik di 4.1.1 — rekomendasi: pakai ini sebagai mesin event, pola 4-titik sebagai label HH/HL/LH/LL.
- Equal highs/lows: dua pivot dianggap sama bila selisihnya < ambang × ATR (ambang default kecil, ±0,1).
- Order block memakai filter volatilitas: candle dengan range ≥ 2 × ATR(200) dianggap "volatilitas tinggi" dan
  high/low-nya ditukar saat memilih ekstrem, agar candle spike tidak menjadi OB.
- FVG memakai ambang otomatis: |perubahan candle tengah| harus melebihi rata-rata kumulatif |Δ%| × 2, untuk
  membuang gap kecil tak bermakna.

### 4.2 Uji anti-lookahead ala freqtrade (wajib untuk `tests/` fitur v3 & `backtest/runner.js`)

Dari `docs/lookahead-analysis.md` & `docs/recursive-analysis.md` freqtrade (metodologi; GPL tidak relevan
karena tidak ada kode yang disalin):

1. **Uji potong (lookahead):** hitung fitur pada seluruh deret (baseline). Untuk sejumlah indeks sinyal
   *t* (≥ 20, termasuk acak berbenih), hitung ulang pada `candles.slice(0, t+1)`; nilai pada *t* dan keputusan
   (bias, event, tier) **harus identik**. Perbedaan apa pun = lookahead. Kelemahan yang diakui freqtrade:
   sinyal yang tidak pernah muncul tidak teruji → pastikan data uji menghasilkan banyak sinyal LONG & SHORT.
2. **Uji rekursif (warm-up):** hitung indikator rekursif (EMA, ATR/ADX Wilder, OBV, CVD, A/D) dengan panjang
   riwayat berbeda (mis. 300, 500, 1000, 5000 candle) dan bandingkan nilai candle terakhir. Tetapkan
   `startupCandles` minimum per fitur sehingga selisih < 0,1 % (ADX Wilder butuh ±10× periode). Nilai `null`
   bila riwayat kurang dari batas itu — sesuai prinsip "null bila tak terhitung".
3. Fitur kumulatif (OBV, CVD, A/D) hanya boleh dipakai sebagai **kemiringan/selisih dalam jendela**, bukan
   level absolut, karena levelnya bergantung pada titik awal data (kontrak v3 sudah begitu: `obvSlope`,
   `cvdSlope`, `adSlope`).

### 4.3 Label & validasi (López de Prado, *Advances in Financial Machine Learning*, 2018)

- **Triple barrier** (AFML bab 3.4; sudah di kontrak `labeler.js`): dari entry di close candle sinyal, pasang
  barier atas/bawah dan barier waktu `maxBars`; label = barier yang tersentuh pertama. Penyempurnaan dari buku
  yang patut ditiru: lebar barier **diskalakan volatilitas** (AFML memakai EWM std return harian; padanan kita:
  stop = k × ATR atau struktur swing, target = `targetR` × risiko), sehingga label sebanding antar koin dan
  rezim. Bila TP & SL dalam candle yang sama → LOSS (konservatif, sudah di kontrak). Simpan juga `TIMEOUT`
  sebagai kelas tersendiri, jangan digabung ke WIN/LOSS.
- **Meta-labeling** (AFML 3.6): model sekunder hanya memutuskan *ambil / lewati* sinyal primer (arah sudah
  ditentukan pola SA/PVA atau SD/PVD). Padanan kita: `calibration.js` memetakan skor confluence → peluang WIN
  sinyal primer. Ini cara yang benar untuk menaikkan presisi tanpa mengubah arah.
- **Purging & embargo** (AFML 7.4): pada split walk-forward, buang sampel latih yang rentang labelnya
  (`entryIndex … exitIndex`) tumpang tindih dengan periode uji, lalu buang `embargoBars` (≈ `maxBars`) setelah
  periode uji. Sudah ada di kontrak `splits.js`; pastikan purging memakai **exitIndex**, bukan entryIndex.
- **Koreksi multiple testing** — Probabilistic / Deflated Sharpe Ratio (Bailey & López de Prado, 2012/2014):
  `PSR = Φ( (SR − SR*)·√(n−1) / √(1 − γ₃·SR + ((γ₄−1)/4)·SR²) )`, dengan γ₃ skewness, γ₄ kurtosis (bukan excess)
  dari return per trade. Untuk DSR, `SR* = √Var[SR_k] · ((1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e)))`, γ ≈ 0,5772
  (Euler–Mascheroni), N = jumlah konfigurasi parameter yang dicoba. Laporkan di `reports/backtest-*.md` agar
  penyetelan bobot confluence tidak menghasilkan "akurasi" palsu karena overfitting.
- **Interval Wilson** untuk win rate & kalibrasi isotonik (PAV) sudah di kontrak; tambahkan **Brier score**
  dan reliabilitas per bin pada data uji, bukan data latih.

### 4.4 Data historis `data.binance.vision`

- Spot: `https://data.binance.vision/data/spot/{daily|monthly}/klines/{SYMBOL}/{interval}/{SYMBOL}-{interval}-{YYYY-MM[-DD]}.zip`;
  USD-M futures: `…/data/futures/um/{daily|monthly}/klines/…` (pola sama).
- Kolom CSV: open time, open, high, low, close, volume, close time, quote volume, number of trades,
  **taker buy base volume, taker buy quote volume**, ignore — langsung memetakan ke `backend/market/contracts.js`
  (fitur order-flow mendapat `takerBuyVolume`).
- Tiap ZIP punya `.CHECKSUM` (SHA-256): **verifikasi sebelum parse**; tolak file yang tidak cocok.
- **Perhatian:** timestamp spot sejak 2025-01-01 dalam **mikrodetik** (sebelumnya milidetik). Normalisasi:
  bila `openTime > 1e14` → bagi 1000. Uji khusus untuk batas tahun 2024/2025.
- Unduhan dilakukan oleh `scripts/backtest.js` di mesin pemilik (bukan worker produksi), disimpan di cache
  disk, ZIP diekstrak ke direktori terpisah dan diparse sebagai data (tanpa eksekusi apa pun). Patuhi
  Terms & Conditions Binance (data untuk riset pribadi).

## 5. Golden test: cara memakai pustaka lain tanpa menambah dependensi

1. Di luar repo (virtualenv/folder sementara), hitung indikator dengan pustaka acuan (`ta` MIT sebagai utama;
   opsional `trading-signals`/`@ixjb94/indicators` untuk silang-cek) pada fixture OHLCV tetap
   (mis. 300 candle BTCUSDT 1h dari `data.binance.vision`, dicatat sumber & checksum).
2. Simpan keluaran sebagai JSON kecil di `tests/fixtures/golden/<indikator>.json` beserta versi pustaka &
   parameter. Tidak ada kode pihak ketiga yang masuk repo — hanya angka.
3. Test Vitest membandingkan dengan toleransi relatif ≤ 1e-9 untuk rumus non-rekursif, dan setelah warm-up
   (4.2 butir 2) untuk rumus rekursif. Catat perbedaan konvensi yang disengaja, misalnya: ADX Wilder vs EMA,
   Bollinger memakai deviasi standar populasi (ddof = 0) seperti TradingView, dan OBV saat close sama (tidak
   berubah).
4. SMC tidak punya golden test yang sahih (pustaka acuan memakai lookahead). Untuk `marketStructure.js` gunakan
   fixture buatan tangan dengan jawaban yang diturunkan manual + uji potong 4.2.

## 6. Rujukan

- joshyattridge/smart-money-concepts — https://github.com/joshyattridge/smart-money-concepts (MIT), PyPI `smartmoneyconcepts` 0.0.27.
- LuxAlgo, "Smart Money Concepts [LuxAlgo]", TradingView (CC BY-NC-SA 4.0 menurut header salinan kode).
- freqtrade — https://github.com/freqtrade/freqtrade, `docs/lookahead-analysis.md`, `docs/recursive-analysis.md` (GPL-3.0).
- M. López de Prado, *Advances in Financial Machine Learning*, Wiley, 2018 — bab 3 (triple barrier, meta-labeling), bab 7 (purged k-fold, embargo).
- D. H. Bailey & M. López de Prado, "The Sharpe Ratio Efficient Frontier" (2012, PSR) dan "The Deflated Sharpe Ratio" (2014).
- binance/binance-public-data — https://github.com/binance/binance-public-data (MIT + T&C dataset).
- bukosabino/ta — PyPI `ta` 0.11.0 (MIT). bennycode/trading-signals 8.3.0 (MIT). ixjb94/indicators 1.2.6 (MIT). cinar/indicatorts 2.2.2 (MIT).
- Hudson & Thames mlfinlab — lisensi "all rights reserved" (ditolak sebagai kode).
