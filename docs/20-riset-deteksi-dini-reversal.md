# 20 — Riset deteksi dini potensi reversal bullish ("Reversal Radar")

Status: dokumen riset & alasan metode (2026-10-26). Kontrak implementasinya ada di
[19 — Kontrak Reversal Radar](19-kontrak-reversal-radar.md); hasil validasinya di
[21 — Validasi Reversal Radar](21-validasi-reversal-radar.md). Dokumen ini menjawab *mengapa* mesin dibangun seperti itu:
metode mana yang dipakai, mana yang ditolak, dan bukti apa yang mendasarinya.

Keterbatasan riset: dari lingkungan pengembangan, Binance dan sebagian situs akademik tidak dapat diakses
(mis. halaman kertas Lo–Mamaysky–Wang di MIT gagal diunduh), sehingga beberapa sumber hanya dibaca lewat ringkasan/abstrak
dan dokumentasi sekunder. Angka statistik dari sumber luar dikutip apa adanya dan **tidak** diverifikasi ulang pada data kripto;
satu-satunya angka yang kami klaim sendiri adalah hasil replay di docs/21.

## 1. Pertanyaan riset dan kriteria pemilihan metode

Pertanyaan pengguna: *"Koin mana yang chart-nya baru mulai membentuk potensi reversal bullish, apa buktinya, apa yang masih perlu
dikonfirmasi, dan kapan setup dianggap batal?"* — dengan prioritas **awal pembentukan**, bukan pola lengkap, dan tanpa
menyatakan tren pasti berbalik.

Kriteria yang dipakai untuk memilih metode (ditetapkan sebelum riset, dari permintaan pengguna):

| Kriteria | Artinya di implementasi |
|---|---|
| Dapat dijelaskan | Setiap bukti adalah aturan geometris/volume yang bisa ditunjuk di chart (penanda mini-chart), bukan keluaran model hitam. |
| Kausal (anti-lookahead) | Hanya candle tutup dengan `closeTime ≤ t`; pivot dinyatakan ada saat candle konfirmasinya tutup; level diuji pada candle *setelah* level terbentuk. |
| Sedikit parameter, tidak mudah overfit | Ambang dinyatakan dalam satuan ATR/relatif, bukan harga absolut; parameter diturunkan dari literatur lalu dicek di seed sintetis 1–20, dievaluasi di seed 21–60 (docs/21). |
| Tidak menumpuk indikator | Satu bukti per *karakter chart*; dua indikator yang mengukur hal sama (mis. RSI & Stochastic) tidak dipakai bersamaan. |
| Efisien untuk banyak pair | Evaluasi O(n) per candle tutup pada jendela 300 candle; tanpa optimisasi iteratif per simbol. |
| False positive terukur | Definisi sukses/gagal ditetapkan SEBELUM evaluasi (docs/19 §10) dan diukur per timeframe & per tahap. |
| Tahan data buruk | Gap/duplikat/candle rusak → `DATA_QUALITY`; data kurang → `INSUFFICIENT_DATA`; replay dari kursor persisten. |

## 2. Temuan per karakter chart → bukti yang dipakai

Daftar "karakter chart" pengguna dipetakan ke lima grup bukti (EXHAUSTION, BASE, STRUCTURE, VOLUME, TRIGGER).
Bobot poin dijelaskan di §5; parameter di §7.

### 2.1 Tekanan turun melemah, lower low berhenti/semakin dangkal, dasar bertahan

Sumber utama: metode Wyckoff (Preliminary Support → Selling Climax → Automatic Rally → Secondary Test; Pruden 2007;
Wyckoff 1931) dan pola *double bottom* Bulkowski (2021). Keduanya mendeskripsikan hal yang sama secara kualitatif:
sebelum reversal, **setiap tekanan jual berikutnya menghasilkan low yang tidak jauh lebih rendah** (secondary test), lalu
retest dasar **gagal menembus close**.

Lo, Mamaysky & Wang (2000) memformalkan pola chart sebagai **urutan ekstrem lokal** dengan syarat geometris
(mis. double bottom = dua minimum lokal yang selisihnya ≤ 1,5 % dari rata-rata keduanya, dipisahkan satu maksimum).
Kami mengambil prinsip "pola = relasi antar swing" itu, tetapi tidak memakai pemulusan kernel mereka (lihat §4).

Implementasi: `LL_SHALLOWER` (kedalaman lower low terakhir ≤ 0,7 × sebelumnya atau ≤ 0,5 ATR), `LL_STOPPED`
(tidak ada swing low baru di bawah bottom ≥ 8 candle), `BOTTOM_HELD` (retest ≤ bottom + 0,5 ATR lalu close ≥ bottom + 0,25 ATR),
`DOWN_MOMENTUM_FADING` (body candle merah mengecil & porsi volume candle merah ≤ 55 %). Semua memakai swing fraktal 2-2
(Williams 1995) yang **baru terkonfirmasi dua candle setelah pivot**, sehingga waktu deteksi = waktu konfirmasi sebenarnya.

### 2.2 Divergensi (RSI, CVD)

Divergensi bullish RSI adalah sinyal reversal paling populer, tetapi bukti publiknya lemah sebagai sinyal berdiri sendiri:
backtest publik CoinQuant pada BTC melaporkan *win rate* ~22 % untuk divergensi RSI standar, dan banyak indikator
divergensi di TradingView **repaint** karena pivot-nya memakai candle di sisi kanan (lookahead).
Kesimpulan: divergensi dipakai hanya sebagai **bukti pendukung** (`RSI_DIVERGENCE` 8 poin, `CVD_DIVERGENCE` 5 poin, keduanya
di grup EXHAUSTION), dihitung pada swing low **terkonfirmasi**, dan tidak pernah sendirian membuka tahap. RSI memakai
pemulusan Wilder (1978) periode 14; CVD/OBV memakai modul `features/orderFlow` yang sudah ada.

### 2.3 Dasar membulat (mangkok)

Bulkowski (2021) menempatkan *rounding bottom* di antara pola dengan tingkat kegagalan terendah dalam katalognya
(gagal = kenaikan < 5 % setelah breakout), dan *bump-and-run reversal bottom* dengan kegagalan ~9 %. Pola ini juga paling
cocok dengan permintaan "dasar membulat" dan "sideways dengan dasar makin tinggi".

Deteksi membulat di literatur/open-source umumnya dua cara: (a) pemulusan kernel + ekstrem lokal (Lo–Mamaysky–Wang),
(b) **fit kuadrat** `close ≈ a·x² + b·x + c` pada jendela tetap dengan syarat `a > 0` dan R² tinggi (umumnya ≥ 0,8 di
implementasi open-source untuk saham harian). Kami memilih (b): O(n), tiga koefisien, mudah dijelaskan ("lengkung ke atas,
titik terendah kurva di tengah jendela, harga sudah naik dari vertex"). Karena candle kripto intraday lebih berisik, ambang awal
R² ≥ 0,6 dengan vertex di 15–85 % jendela 40 candle, dan **harus** dicek di replay (docs/21) — ini parameter dengan risiko
overfit terbesar, maka dinyatakan di dokumen ini sebelum evaluasi.

Implementasi: `ROUNDED_BOTTOM` (8) dan `RISING_FLOOR` (7: range 30 candle ≤ 4 ATR dan regresi swing low naik).

### 2.4 Range & EMA merapat setelah penurunan (kompresi)

Dua sumber praktisi yang konsisten: **Volatility Contraction Pattern** (Minervini 2013) — setiap kontraksi berikutnya
menyusut kira-kira setengah hingga 70 % dari sebelumnya dan volume mengering di titik pivot — dan **TTM Squeeze**
(Carter 2005) — Bollinger Band (20, 2σ) berada *di dalam* Keltner Channel (20, 1,5 ATR). Keduanya mengukur hal yang sama
(volatilitas menyusut) dengan alat berbeda, jadi hanya **satu** mekanisme squeeze yang dipakai (modul `features/regime`
yang sudah ada), ditambah dua ukuran yang saling melengkapi: ATR14 menyusut ≥ 20 % dalam 20 candle (`ATR_CONTRACTION`)
dan jarak EMA7–EMA25 ≤ 1 ATR dan mengecil (`EMA_CONVERGENCE`). `RANGE_CONTRACTION` (range 20 candle ≤ 0,75 × sebelumnya
**atau** squeeze) menangkap VCP tanpa harus menghitung kontraksi bertingkat yang butuh banyak parameter.

### 2.5 Spring / sapuan likuiditas

*Spring* Wyckoff = harga menembus support sebentar (wick) lalu kembali ke dalam range; Wyckoff membedakan derajat spring dari
seberapa dalam penetrasi dan seberapa besar volumenya. Skrip open-source modern (mis. "Wyckoff Spring" LuxAlgo) menilai
spring dari tiga hal: **penetrasi dangkal, volume tenang, reclaim cepat** — tanpa ambang kanonik yang disepakati.
Implementasi `SPRING_RECLAIM` (6): wick menembus swing low terkonfirmasi ≤ 3 candle lalu, close kembali di atasnya, volume
candle sapuan ≤ 1,5 × rata-rata. Modul `features/liquidity` (findSweep) yang sudah ada dipakai bila bentuknya kausal.

### 2.6 Perubahan struktur minor (pembeli mulai mengambil kendali)

Konsep *Change of Character / Break of Structure* (SMC) menyatakan reversal awal sebagai close di atas lower high terakhir.
Catatan penting: pustaka Python `smartmoneyconcepts` yang populer menentukan swing dengan candle di **kedua sisi** sehingga
mengandung lookahead bila dipakai bar-demi-bar. Kami memakai `features/marketStructure` yang sudah ada (swing terkonfirmasi,
kausal) dengan syarat `barsAgo ≤ 10` (`CHOCH_BULLISH` 8). Bukti struktur lainnya: `HIGHER_LOW` (10, higher low terkonfirmasi
yang masih utuh — aturan audit PR #19), `EMA25_RECLAIM` (6), `EMA7_TURN_UP` (4), `STAIRCASE` (6: ≥ 2 HL dan ≥ 2 HH dengan
kaki ≤ 2 ATR — "kenaikan bertahap seperti tangga").

### 2.7 Volume: naik perlahan dengan volume rendah vs pasar sepi

Wyckoff dan Minervini sama-sama menyebut **supply mengering** (volume turun di dasar) sebagai prasyarat; pengguna meminta
"harga naik perlahan dengan volume relatif rendah" diterima sebagai tanda awal. Risikonya: pasar yang memang tidak likuid
terlihat persis seperti itu. Pemisahan dilakukan dengan **kelas likuiditas** (LIQUID/THIN/ILLIQUID dari quote volume 24 jam,
fallback rata-rata quote volume per candle per timeframe): `VOLUME_DRY_UP` tidak dihitung sebagai bukti untuk ILLIQUID, dan
ILLIQUID selalu tampil sebagai risiko. Bukti: `VOLUME_DRY_UP` (5), `QUIET_RISE` (5).

### 2.8 Pemicu / breakout

Bulkowski mendefinisikan konfirmasi sebagai **close** di atas puncak pola; statistiknya menunjukkan breakout dengan
volume tinggi sedikit lebih baik, tetapi banyak pola tetap berhasil tanpa lonjakan volume. Karena itu CONFIRMED butuh
`TRIGGER_BREAK` **dan salah satu** dari `BREAK_VOLUME_SUPPORT` (RVOL ≥ 1,5) **atau** `BREAK_FOLLOW_THROUGH` (dua close
berurutan di atas pemicu atau close ≥ pemicu + 0,3 ATR). Level pemicu = resistance berjalan (swing high terkonfirmasi
terakhir sejak bottom, dinaikkan ke high tertinggi sesudahnya **sampai candle sebelum evaluasi** — aturan `runningLevel` PR #19,
mencegah "menembus level yang dibuat candle itu sendiri").

### 2.9 Membedakan reversal dari kelanjutan uptrend

Semua bukti di atas bisa muncul di pullback dalam uptrend. Prasyarat **penurunan awal** (dari close tertinggi 120 candle ke
bottom ≥ 3 ATR atau ≥ 6 %, bottom berumur ≥ 3 candle, belum ditembus close) membedakan keduanya; bila tidak ada penurunan awal
dan EMA25 naik dengan close di atasnya → `CONTINUATION`, bukan kandidat reversal. Ini sejalan dengan Bulkowski yang
mensyaratkan tren turun sebelumnya untuk pola *reversal* (tanpa itu pola yang sama dicatat sebagai *continuation*).

## 3. Tahapan, histeresis, dan status

**Tahapan.** Literatur praktisi memisahkan "pembentukan" dari "konfirmasi" (Wyckoff fase A–E; Bulkowski *confirmation
point*; Minervini *pivot*). Pengguna meminta kandidat awal tidak tertutup koin yang sudah pump, maka tiga tahap ditampilkan
sebagai daftar terpisah: EARLY_FORMATION (≥ 2 bukti EXHAUSTION/BASE/VOLUME, minimal satu dari EXHAUSTION/BASE),
DEVELOPING_REVERSAL (EARLY + ≥ 1 STRUCTURE + ≥ 3 bukti), CONFIRMED_BREAKOUT (§2.8). Bukti volume saja tidak cukup untuk
EARLY — agar pasar sepi tidak lolos hanya karena volumenya rendah.

**Histeresis (anti-kedip).** Dari praktik rekayasa kendali (Schmitt trigger/debounce): syarat *masuk* lebih ketat daripada
syarat *bertahan*. Masuk tahap butuh kondisi terpenuhi `enterConfirmBars` candle tutup berurutan (5m: 2, 15m: 1, 1h: 1);
keluar hanya lewat CANCELLED (close di bawah level invalidasi, bukan wick) atau EXPIRED (tanpa kemajuan selama `expiryBars`,
atau bukti melemah `weakBars` berturut-turut). Tahap tidak pernah turun. Ini yang membuat daftar tidak berkedip dan
notifikasi tidak duplikat: event hanya OPENED, STAGE_UP, CANCELLED, EXPIRED.

**Candle berjalan.** Mengikuti pembedaan *real-time vs historical bar* di dokumentasi TradingView (sumber umum "repaint"):
evaluasi pada candle yang belum tutup selalu berlabel `provisional`, disimpan di tabel terpisah, tidak membuka/menutup
kandidat, dan riwayat event mencatat perubahan tahap provisional terpisah dari tahap candle tutup.

## 4. Anti-lookahead: jebakan yang ditemukan dan cara menghindarinya

| Jebakan | Contoh di sumber | Penanganan di Reversal Radar |
|---|---|---|
| Pivot/zigzag memakai candle masa depan | Indikator divergensi TradingView; `smartmoneyconcepts` (Python) | Swing fraktal 2-2 dengan `confirmedIndex`; bukti dihitung hanya dari swing yang sudah terkonfirmasi. |
| Pemulusan dua sisi | Regresi kernel Lo–Mamaysky–Wang, moving average terpusat | Tidak dipakai live; fit kuadrat memakai jendela yang **berakhir di candle saat ini**. |
| Level diuji pada candle yang membentuknya | Breakout "menembus" high yang baru dibuat candle itu sendiri | Level pemicu dihitung tanpa candle evaluasi (aturan `runningLevel`). |
| HTF bocor | Memakai candle 1h yang belum tutup untuk konteks 15m | Konteks HTF hanya dari candle dengan `closeTime ≤ t`. |
| Repaint diam-diam | Hasil evaluasi berubah saat data historis ditambah | Tes stabilitas prefiks (docs/19 §3.2): evaluasi pada prefiks harus sama dengan evaluasi penuh di indeks yang sama. |
| Waktu deteksi terlalu dini | Mencatat waktu pivot, bukan waktu konfirmasinya | `firstDetectedAt` = closeTime candle saat bukti terkonfirmasi. |

Replay (docs/21) dijalankan **berurutan** candle demi candle lewat pipeline yang sama dengan produksi, sehingga "seberapa awal"
diukur dari waktu yang benar-benar tersedia saat itu.

## 5. Skor: aturan berbobot, bukan probabilitas

Skor = jumlah poin bukti per grup, dibatasi maksimum grup (EXHAUSTION 25, BASE 25, STRUCTURE 30, VOLUME 10, TRIGGER 10).
Bobot ditetapkan dari kekuatan bukti di literatur (struktur & dasar lebih berat daripada volume/divergensi) dan bersifat
**hipotesis awal**. Skor **bukan probabilitas**: Bailey, Borwein, López de Prado & Zhu (2014) menunjukkan betapa mudahnya
backtest yang disetel berulang tampak bagus di luar sampel palsu; karena itu (1) parameter disetel hanya pada seed sintetis
1–20 dan dievaluasi pada 21–60, (2) kalibrasi ke probabilitas (mis. Platt seperti PR #15 untuk mesin lama) **tidak** dilakukan
sebelum ada evaluasi pada data Binance asli di Mac pengguna, (3) UI menyebut "skor kualitas" dan menampilkan komponennya.

Definisi keberhasilan yang ditetapkan sebelum evaluasi (docs/19 §10, mengikuti *triple barrier* López de Prado 2018 yang sudah
dipakai `backend/backtest/labeler.js`): dalam 48 candle setelah deteksi pertama, harga menyentuh +2 × ATR sebelum ada close di
bawah level invalidasi (SUCCESS); close di bawah invalidasi lebih dulu (FAIL); selain itu TIMEOUT.

## 6. Metode yang ditolak dan alasannya

| Metode | Alasan tidak dipakai |
|---|---|
| Deep learning / model ML sebagai detektor | docs/16: tidak ada bukti keunggulan pada data pengguna; tidak dapat dijelaskan; butuh pelabelan besar; risiko overfit rezim. |
| Regresi kernel (Lo–Mamaysky–Wang) secara live | Pemulusan dua sisi → repaint; cocok untuk riset offline, bukan scanner bar-demi-bar. |
| Pustaka SMC siap pakai | Deteksi swing memakai candle masa depan. Konsep BOS/CHoCH tetap dipakai lewat modul kausal yang ada. |
| TD Sequential / hitungan DeMark | Tidak ditemukan backtest publik yang ketat; aturan hitung sulit dijelaskan ke pengguna. |
| Menumpuk osilator (MACD, Stochastic, CCI, Williams %R) | Mengukur momentum yang sama dengan RSI/slope EMA; menambah parameter tanpa informasi baru. |
| Pola candlestick tunggal (hammer, engulfing) | Marshall, Young & Rose (2006) tidak menemukan nilai prediktif pola candlestick pada DJIA; terlalu sering muncul di kripto intraday. |
| Volume profile / order book | Tidak tersedia di penyimpanan candle; di luar arsitektur yang ada. |
| Directional change / intrinsic time (Guillaume dkk. 1997) | Menarik untuk sampling berbasis ambang, tetapi mengubah model data candle seluruh aplikasi; ditunda. |

## 7. Parameter: nilai awal, alasan, dan cara validasi

| Parameter | Nilai awal | Alasan | Diperiksa di |
|---|---|---|---|
| `bottomLookback` / `declineLookback` | 60 / 120 candle | Setara 5 jam / 10 jam (5m), 15 / 30 jam (15m), 2,5 / 5 hari (1h) — cukup untuk "penurunan sebelumnya" tanpa menjangkau rezim lama. | seed 1–20 |
| `minDeclineAtr` / `minDeclinePct` | 3 ATR / 6 % | Di bawah ini pullback biasa; Bulkowski mensyaratkan tren turun nyata sebelum pola reversal. | seed 1–20 |
| `enterConfirmBars` | 5m: 2, 15m: 1, 1h: 1 | 5m paling berisik; satu candle ekstra = 5 menit penundaan untuk mengurangi kedip. | docs/21 (jumlah kandidat & pembatalan) |
| `expiryBars` (NO_PROGRESS) | 48 / 36 / 24 | ≈ 4 jam (5m), 9 jam (15m), 1 hari (1h): base yang tidak maju selama itu bukan lagi "awal pembentukan". | docs/21 |
| `weakBars` (EVIDENCE_FADED) | 6 | Bukti hilang 6 candle berturut-turut = struktur tidak lagi mendukung. | docs/21 |
| `bowlWindow`, R², vertex | 40, ≥ 0,6, 15–85 % | Open-source memakai R² ≥ 0,8 pada saham harian; kripto intraday lebih berisik. Risiko overfit tertinggi → wajib cek. | seed 1–20, lalu data Mac |
| `breakRvol` | 1,5 | Ambang RVOL umum untuk "volume mendukung"; alternatif follow-through disediakan agar tidak bergantung volume. | docs/21 |
| Extended | ≥ 2,5 ATR atau ≥ 8 % sejak deteksi pertama | Menandai "terlambat dikejar?" tanpa membuang; LATE_ENTRY bila deteksi pertama sudah ≥ 4 ATR dari bottom. | — |
| Sensitivitas (filter tampilan) | LOW skor ≥ 60 & ≥ 4 bukti; MEDIUM ≥ 45 & ≥ 3; HIGH tanpa batas | Mesin selalu mengevaluasi di HIGH; histori tidak bergantung pilihan UI. | — |

**Tradeoff yang disadari.** Sensitivitas tinggi = lebih awal dan lebih banyak kandidat, tetapi lebih banyak pembatalan
(false positive); `enterConfirmBars` lebih besar = lebih stabil tetapi lebih lambat; ambang R² lebih rendah = lebih banyak
"mangkok" terdeteksi tetapi lebih banyak yang sebenarnya hanya sideways berisik. Angka nyatanya per timeframe ada di docs/21;
dokumen ini sengaja tidak mengklaim peningkatan apa pun tanpa hasil uji.

## 8. Efisiensi, data terlambat/hilang/belum lengkap

- Evaluasi dipicu per candle tutup, O(n) pada jendela 300 candle; fitur (EMA, ATR, RSI, swing) dihitung sekali per evaluasi
  tanpa iterasi ulang per bukti. Pipeline memberi jeda ke event loop tiap `yieldEvery` simbol agar API tetap responsif saat
  ratusan pair 5m tutup bersamaan.
- Candle provisional di-throttle 15 detik per seri dan tidak pernah menyentuh kursor.
- Gap/duplikat/candle rusak (high < low, volume negatif) → `DATA_QUALITY` dan tidak membuka kandidat; data < kebutuhan warm-up
  → `INSUFFICIENT_DATA`. Candle terlambat ditangani kursor persisten: replay dari kursor terakhir, maksimum 288 candle per
  putaran, dengan `settleMs` agar candle yang baru tutup tidak dievaluasi sebelum feed stabil.

## 9. Sumber

Akademik
- Lo, A. W., Mamaysky, H., & Wang, J. (2000). *Foundations of Technical Analysis: Computational Algorithms, Statistical Inference, and Empirical Implementation.* Journal of Finance 55(4).
- Bailey, D. H., Borwein, J. M., López de Prado, M., & Zhu, Q. J. (2014). *Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance.* Notices of the AMS 61(5).
- López de Prado, M. (2018). *Advances in Financial Machine Learning.* Wiley (triple-barrier labeling; purged cross-validation).
- Marshall, B. R., Young, M. R., & Rose, L. C. (2006). *Candlestick technical trading strategies: Can they create value for investors?* Journal of Banking & Finance 30(8).
- Guillaume, D. M., Dacorogna, M. M., Davé, R. R., Müller, U. A., Olsen, R. B., & Pictet, O. V. (1997). *From the bird's eye to the microscope: A survey of new stylized facts of the intra-daily foreign exchange markets.* Finance and Stochastics 1(2) (directional change / intrinsic time).

Buku praktisi
- Wyckoff, R. D. (1931). *The Richard D. Wyckoff Method of Trading and Investing in Stocks*; Pruden, H. (2007). *The Three Skills of Top Trading* (fase akumulasi, spring, secondary test).
- Bulkowski, T. N. (2021). *Encyclopedia of Chart Patterns*, 3rd ed. Wiley; thepatternsite.com (statistik rounding bottom, bump-and-run reversal, double bottom; definisi gagal = kenaikan < 5 %).
- Minervini, M. (2013). *Trade Like a Stock Market Wizard.* McGraw-Hill (Volatility Contraction Pattern).
- Carter, J. F. (2005). *Mastering the Trade.* McGraw-Hill (TTM Squeeze: Bollinger 20/2 di dalam Keltner 20/1,5 ATR).
- Wilder, J. W. (1978). *New Concepts in Technical Trading Systems* (RSI, ATR, pemulusan Wilder).
- Williams, B. (1995). *Trading Chaos* (fraktal 2-2).
- Bollinger, J. (2001). *Bollinger on Bollinger Bands* (bandwidth, squeeze).

Dokumentasi & open-source
- Dokumentasi Pine Script TradingView: *Repainting* (real-time vs historical bars; indikator berbasis pivot).
- LuxAlgo, skrip open-source "Wyckoff Spring" dan indikator struktur pasar (penilaian spring: penetrasi, volume, reclaim).
- `smartmoneyconcepts` (Python, joshyattridge): implementasi BOS/CHoCH — dicatat sebagai contoh deteksi swing non-kausal.
- CoinQuant: backtest publik divergensi RSI pada BTC (win rate ~22 %) — dikutip sebagai peringatan, bukan sebagai bukti untuk kripto lain.
- Implementasi open-source deteksi rounding bottom berbasis fit kuadrat/R² (umumnya R² ≥ 0,8 untuk saham harian).
- Modul internal yang dipakai ulang: `backend/indicators/{ema,atr,volume,swings}`, `backend/features/{marketStructure,regime,orderFlow,liquidity}`, `backend/backtest/labeler.js`.
