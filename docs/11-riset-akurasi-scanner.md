# 11 — Riset akurasi Long Scanner & Short Scanner

Dokumen ini merangkum riset literatur untuk rombak akurasi scanner v3 (lihat `docs/10-kontrak-akurasi-v3.md`).
Ditulis untuk pemilik aplikasi: tidak perlu latar akademik, tetapi setiap klaim penting diberi nomor sumber
`[n]` yang dapat dicek di **Daftar pustaka** di bagian akhir.

> **Catatan metode riset.** Sumber dicari lewat mesin pencari dan halaman resmi (jurnal, SSRN, arXiv, NBER,
> RePEc, dokumentasi). Untuk sebagian besar paper, yang dibaca adalah abstrak, ringkasan repositori, atau
> tabel yang dipublikasikan — **bukan** teks lengkap (akses langsung ke arXiv/Springer diblokir dari
> lingkungan riset ini). Karena itu angka dikutip hanya bila tampil di abstrak/tabel resmi, dan detail metode
> yang tidak terverifikasi ditandai. Tidak ada sitasi yang dikarang; bila suatu topik tidak punya bukti
> akademik yang ditemukan, dokumen ini mengatakannya terus terang.

---

## Ringkasan eksekutif (baca ini dulu)

1. **Akurasi 99% untuk sinyal arah kripto bukan target yang realistis.** Studi akademik yang kredibel untuk
   prediksi arah kripto jangka pendek melaporkan akurasi rata-rata sekitar **55–65%** [16], dan banyak hanya
   "signifikan di atas acak" [17]. Angka di atas ~80% hampir selalu datang dari horizon harian dengan banyak
   fitur, prediksi mid-price tick berikutnya (tidak bisa diperdagangkan setelah spread), atau evaluasi yang
   rawan bocor (lookahead/leakage) [18][19][27].
2. **Yang bisa dibuat "mendekati benar" adalah *kejujuran angka*, bukan arah pasar.** Target yang benar:
   (a) tier A konsisten lebih tepat daripada tier B, C, D; (b) peluang yang ditampilkan **terkalibrasi**
   (bila aplikasi bilang 58%, kira-kira 58 dari 100 sinyal serupa memang menang); (c) **expectancy R bersih
   biaya > 0** pada data out-of-sample, lengkap dengan interval kepercayaan.
3. **Win-rate tinggi tidak berarti untung.** Dengan target kecil dan stop lebar, win-rate 90% pun bisa rugi.
   Metrik utama harus *expectancy* (rata-rata R per trade) dan presisi per tier dengan interval Wilson [24].
4. **Bukti terkuat** untuk komponen scanner: (i) aliran order/ketidakseimbangan beli-jual menjelaskan
   perubahan harga *pada interval yang sama* dengan sangat kuat [5][6]; (ii) momentum deret-waktu ada di
   kripto [10][11]; (iii) aturan teknikal (moving average, breakout) punya daya prediksi di kripto, tetapi
   melemah setelah koreksi data snooping dan untuk Bitcoin hilang di out-of-sample [12][13][14].
5. **Bukti terlemah**: Smart Money Concepts (BOS/CHoCH, order block) dan skema Wyckoff (spring, upthrust)
   **tidak ditemukan uji empiris peer-reviewed**. Konsepnya tetap berguna sebagai *aturan yang bisa
   dijelaskan*, tetapi bobotnya harus dianggap hipotesis sampai lolos backtest aplikasi sendiri.
6. **Peringatan khusus order-flow kripto**: preprint 2026 dengan data Binance menemukan bahwa pada horizon
   15 menit, gerak yang didorong taker agresif cenderung **berbalik arah** (mean reversion), bukan berlanjut
   [7]. Artinya lonjakan taker-buy pada satu-dua candle tidak boleh langsung dianggap konfirmasi LONG.

---

## 1. Struktur pasar: swing, HH/HL/LH/LL, BOS/CHoCH, Dow theory

### 1.1 Apa yang dikatakan teori

- **Dow theory** (abad ke-19, dipopulerkan lewat editorial Charles Dow): tren naik = rangkaian puncak dan
  lembah yang makin tinggi (higher high, higher low/HH-HL); tren turun = lower high, lower low (LH-LL).
- **Swing/fraktal**: titik balik lokal. Swing high pada indeks *i* bila high[i] lebih tinggi daripada *left*
  candle sebelumnya dan *right* candle sesudahnya. Konsekuensi penting: swing baru **terkonfirmasi** setelah
  *right* candle berikutnya tertutup. Repo ini sudah menegakkan `confirmedIndex ≤ indeks evaluasi`
  (`backend/indicators/swings.js`) — ini adalah pencegah lookahead yang paling sering dilanggar di indikator
  publik (indikator yang "menggambar ulang"/repaint).
- **Smart Money Concepts (SMC)**: istilah praktisi. *BOS* (break of structure) = close menembus swing searah
  tren (kelanjutan); *CHoCH* (change of character) = close menembus swing berlawanan (tanda awal balik).
  Definisi ini konsisten di berbagai sumber praktisi yang ditemukan [31], dan sama dengan kontrak v3.

### 1.2 Bukti empiris

- **Lo, Mamaysky & Wang (2000)** [1] membangun pengenal pola grafik otomatis (kernel regression untuk
  menghaluskan harga lalu mencari ekstrem lokal — secara konsep sama dengan deteksi swing) dan mengujinya pada
  saham AS 1962–1996. Kesimpulan: beberapa pola teknikal **memberi informasi tambahan** (distribusi return
  setelah pola berbeda dari distribusi tanpa syarat), tetapi ini bukan klaim akurasi tinggi.
- **Brock, Lakonishok & LeBaron (1992)** [2]: aturan moving average & *trading range break* (breakout dari
  swing high/low — kerabat dekat BOS) pada Dow Jones 1897–1986 menghasilkan return beli lebih tinggi dari jual.
  **Sullivan, Timmermann & White (1999)** [3] mengulang dengan koreksi data snooping (Reality Check White) dan
  memperluas semesta aturan; kajian lanjutan menunjukkan daya prediksi melemah pada periode yang lebih baru.
- **Park & Irwin (2007)** [4]: survei besar profitabilitas analisis teknikal — banyak studi positif, tetapi
  banyak juga yang bermasalah (data snooping, biaya transaksi diabaikan, pemilihan aturan setelah melihat data).
- **SMC (BOS/CHoCH, order block, fair value gap)**: pencarian di arXiv/SSRN/jurnal **tidak menemukan** studi
  empiris peer-reviewed. Hasil yang muncul hanya skrip TradingView/vendor dengan "statistik backtest" tanpa
  metodologi out-of-sample [31]. Kesimpulan jujur: BOS ≈ *range breakout* (punya sedikit dukungan historis
  [2][3][13]); CHoCH dan order block **belum terbukti**.

### 1.3 Implikasi untuk scanner

- Struktur dipakai sebagai **filter konteks** (jangan LONG saat bias struktur jelas BEARISH dan sebaliknya),
  bukan pemicu tunggal.
- CHoCH berlawanan arah yang **baru terjadi** adalah alasan kuat untuk veto/penurunan tier (konservatif):
  kesalahan memasuki tren yang baru patah lebih mahal daripada melewatkan satu sinyal.
- Parameter swing kecil (left = right = 2) menghasilkan banyak swing kecil yang bising; konfirmasi datang
  cepat (2 candle). Pada 5m itu 10 menit. Perlu diuji juga 3/3 sebagai alternatif (lihat §6).

---

## 2. Akumulasi/distribusi: Wyckoff, volume, dan order flow kripto

### 2.1 Wyckoff

Skema Wyckoff (1930-an) menggambarkan fase akumulasi: *selling climax* (SC) → *automatic rally* → pengujian
dalam range (fase B) → *spring* (tembus sebentar di bawah range lalu kembali masuk) → *sign of strength*
(SOS). Distribusi adalah cermin: *buying climax*, *upthrust* (UTAD), *sign of weakness* (SOW) [30].

**Bukti empiris:** tidak ditemukan uji akademik peer-reviewed atas skema Wyckoff. Yang ada hanya materi
edukasi, contoh strategi sederhana, dan satu preprint independen yang melatih model pada data **sintetis**
tanpa metrik presisi/recall terhadap label ahli [30]. Konsep "spring" secara mekanis sama dengan **sapuan
likuiditas** (*liquidity sweep*: low menembus swing low lalu close kembali di atasnya) yang dipakai kontrak
`liquidity.js`. Ini aturan yang dapat diukur dan diuji — itu nilai utamanya.

### 2.2 Indikator volume klasik

- **OBV** (Granville): akumulasi volume bertanda arah close. **A/D line** (Chaikin): volume dikali *money flow
  multiplier* `[(C−L) − (H−C)] / (H−L)`, dikumulasi. **CMF** (Chaikin Money Flow): Σ money-flow-volume / Σ
  volume pada jendela 20–21 periode; positif = tekanan beli [32].
- **Karpoff (1987)** [8]: survei klasik — volume berkorelasi positif dengan **besarnya** perubahan harga
  (|Δp|), dan di pasar saham juga dengan perubahan harga itu sendiri. Artinya volume tinggi terutama menandai
  *gerak besar*, belum tentu *arahnya*. Ini mendukung pemakaian volume sebagai pengonfirmasi, bukan penentu
  arah.

### 2.3 Order flow: dari bursa saham ke kline Binance

- **Cont, Kukanov & Stoikov (2014)** [5]: pada 50 saham AS, *order flow imbalance* (OFI, ketidakseimbangan
  penawaran-permintaan di best bid/ask) adalah penggerak utama perubahan harga **pada interval yang sama**;
  hubungannya linear dengan kemiringan berbanding terbalik terhadap kedalaman pasar. Hubungan dengan volume
  murni jauh lebih bising.
- **Silantyev (2019)** [6], data BitMEX XBTUSD: di kripto, **trade flow imbalance** (selisih volume beli
  agresif vs jual agresif — persis yang bisa dihitung dari taker volume) menjelaskan perubahan harga
  kontemporer lebih baik daripada OFI agregat; kedalaman tipis adalah pembeda utama pasar kripto.
- **Chordia & Subrahmanyam (2004)** [9], saham NYSE harian: imbalance **tertinggal** (lagged) berhubungan
  positif dengan return berikutnya (karena order besar dipecah dan imbalance berautokorelasi), tetapi tanda
  itu berbalik setelah imbalance saat ini dikontrol. Jadi daya prediksi imbalance terhadap masa depan ada,
  namun lebih lemah dan halus dibanding hubungan kontemporernya.
- **Easley, O'Hara, Yang & Zhang (2024)** [20]: ukuran mikrostruktur (Roll, VPIN) punya daya prediksi untuk
  dinamika harga lima kripto utama; efek lintas pasar BTC↔ETH ada dan stabil bahkan saat *crypto winter*.
- **Preprint 2026 (arXiv 2608.21888)** [7], 183 pasangan Binance vs 187 saham/ETF AS, horizon 15 menit:
  90% pasangan Binance menunjukkan **pembalikan arah** signifikan; pembalikan terkonsentrasi setelah gerak yang
  didorong taker agresif dan makin kuat bila aliran makin intens. Edge kotor ±1,3 bp per trade vs biaya
  round-trip 5 bp → **tidak menutup biaya**. (Belum peer-review; dicatat karena datanya sama persis dengan
  data aplikasi ini.)
- **Data Binance**: setiap kline menyertakan *taker buy base asset volume* (indeks ke-9) [33]. Dari situ:
  `takerSell = volume − takerBuy`, `delta = 2·takerBuy − volume`, dan **CVD** = kumulatif delta (sesuai kontrak).

**Kesimpulan untuk scanner:**
1. Taker flow sangat bagus untuk *menjelaskan* candle yang sedang terjadi, **lemah** untuk *meramal* candle
   berikutnya, dan pada horizon menit-jam di Binance bahkan cenderung **berbalik** setelah lonjakan [7].
2. Karena itu fitur order flow sebaiknya dipakai dalam bentuk **jendela** (rata-rata 20 candle: rasio taker
   buy, kemiringan CVD) dan **divergensi** (harga turun/datar tetapi CVD naik = penyerapan/akumulasi), bukan
   lonjakan satu candle.
3. Lonjakan taker-buy ekstrem + harga sudah jauh dari EMA = **risiko**, bukan konfirmasi (gabungkan dengan flag
   `EXTENDED_PRICE` yang sudah ada).

---

## 3. Konfirmasi multi-timeframe & rezim pasar

### 3.1 Momentum & tren di kripto

- **Moskowitz, Ooi & Pedersen (2012)** [10]: *time-series momentum* (return masa lalu sendiri memprediksi
  return masa depan) ada di 58 kontrak berjangka, horizon 1–12 bulan. Kritik: sebagian hasil bergantung pada
  skala volatilitas [10, ringkasan sekunder].
- **Liu & Tsyvinski (2021)** [11]: return kripto digerakkan faktor khas kripto; ada **time-series momentum
  yang kuat**. **Liu, Tsyvinski & Wu** [22]: tiga faktor — pasar kripto, ukuran, momentum — menjelaskan
  return lintas-koin. Ada juga temuan (seminar Rotterdam, belum terverifikasi teks lengkap) bahwa momentum
  1 hari–1 bulan melemah setelah futures Bitcoin diluncurkan [15].
- **Detzel dkk. (2021)** [14]: rasio harga terhadap moving average memprediksi return harian Bitcoin in-sample
  dan out-of-sample.
- **Corbet dkk. (2019)** [13]: pada return Bitcoin frekuensi tinggi, aturan moving average (terutama
  panjang-variabel) didukung; sinyal beli lebih baik daripada sinyal jual.
- **Hudson & Urquhart (2021)** [12]: ±15.000 aturan teknikal pada beberapa kripto; prediktabilitas
  signifikan setelah koreksi data snooping, **tetapi Bitcoin tidak punya prediktabilitas out-of-sample**.

Implikasi: arah **timeframe lebih tinggi** (HTF) yang searah adalah salah satu filter dengan dukungan bukti
paling konsisten; ini sudah ada di repo (`alignment` dari `backend/timeframe`). Pertahankan dan beri bobot
signifikan.

### 3.2 Indikator rezim

| Indikator | Definisi singkat | Ambang yang lazim (praktisi) | Sumber |
|---|---|---|---|
| ADX (Wilder) | kekuatan tren 0–100, dari +DI/−DI dihaluskan Wilder | ≥ 25 tren, ≤ 20 tanpa tren (konvensi, bukan hasil uji) | Wilder 1978 (buku; konvensi umum) |
| Choppiness Index | 0–100, tinggi = sideways | ≥ 61,8 konsolidasi, ≤ 38,2 tren (rasio Fibonacci, bukan hasil uji) | [34] |
| Efficiency Ratio (Kaufman) | \|Δ harga netto\| / Σ \|Δ per candle\|, 0–1 | dekat 1 = tren lurus, dekat 0 = bising | [35] |
| Bollinger BandWidth | (atas − bawah)/tengah | *squeeze* = BandWidth terendah dalam ±6 bulan (≈125 bar harian) | [36] |

Ambang-ambang di atas **konvensi praktisi**; tidak ditemukan studi yang membuktikan angka 25/61,8/dst.
optimal untuk kripto 5m–1h. Keunggulannya: tidak dioptimasi pada data kita sehingga tidak menambah risiko
overfitting. Squeeze **tidak memberi arah** [36] — hanya memberi tahu bahwa ekspansi volatilitas mungkin
dekat; arah harus dari struktur/aliran.

### 3.3 Bitcoin sebagai faktor pasar

Return altcoin sangat terikat pada faktor pasar kripto [22], dan ada limpahan volatilitas dua arah antara
Bitcoin dan Ether/Litecoin dengan korelasi kondisional yang berubah-ubah tetapi umumnya positif [21].
Implikasi praktis: sinyal LONG altcoin saat BTC sedang patah struktur turun di HTF punya peluang lebih buruk
(hipotesis kuat, perlu diukur). Kontrak v3 belum punya input BTC; ini **rekomendasi lanjutan** (lihat §6.4).

---

## 4. Validasi sinyal yang benar

### 4.1 Pelabelan: triple barrier

López de Prado (2018) [25] memperkenalkan **triple-barrier**: setiap sinyal diberi tiga batas — take profit
(atas), stop loss (bawah), dan batas waktu. Label = batas mana yang tersentuh pertama. Ini lebih jujur
daripada "harga naik setelah N candle?" karena meniru trade nyata. Kontrak `labeler.js` sudah mengikuti ini,
termasuk asumsi konservatif **LOSS bila TP & SL tersentuh di candle yang sama** (dengan data OHLC kita tidak
tahu mana yang duluan).

### 4.2 Purging, embargo, walk-forward

Label triple-barrier memakai harga *masa depan* sampai `maxBars`. Bila sampel latih dan uji bersebelahan,
label latih "melihat" periode uji → skor terlalu bagus. **Purging** membuang sampel latih yang jendela labelnya
tumpang tindih dengan periode uji; **embargo** membuang sedikit sampel tepat setelah blok uji [25][37].
Untuk walk-forward murni (latih selalu sebelum uji), purging dengan jarak ≥ `maxBars` sudah memadai; embargo
tetap murah dan aman. Rekomendasi: `embargoBars = maxBars` (48).

### 4.3 Kalibrasi probabilitas

Skor 0–100 **bukan peluang**. Untuk mengubahnya menjadi peluang, gunakan data out-of-sample dan regresi
**isotonik** (pool-adjacent-violators) atau Platt/sigmoid [26]. Isotonik lebih fleksibel tetapi mudah
overfit bila data sedikit [26] — kontrak memakai PAV + Laplace smoothing dan mengembalikan `null` bila
sampel kurang, itu sudah benar. Model modern pun sering salah kalibrasi tanpa koreksi [28]. Ukuran
kalibrasi: **Brier score** dan diagram reliabilitas (prediksi vs frekuensi aktual per bin).

### 4.4 Interval kepercayaan

Untuk win-rate gunakan **interval Wilson**, bukan rumus Wald `p ± 1,96·√(p(1−p)/n)` yang cakupannya buruk
pada n kecil atau p ekstrem [24]. Gambaran ukuran sampel (setengah lebar interval 95% di sekitar p = 0,5):

| Jumlah trade n | ± kira-kira |
|---|---|
| 30 | ±18 poin persen |
| 100 | ±10 |
| 400 | ±5 |
| 1.000 | ±3 |

Artinya: klaim "tier A menang 60%" dari 30 trade **tidak bisa dibedakan** dari 50%. Butuh ratusan trade
per tier.

### 4.5 Multiple testing & overfitting backtest

- **White (2000) Reality Check** [29] dan **Hansen (2005) SPA** [38]: bila banyak aturan/parameter diuji,
  yang terbaik akan tampak bagus karena kebetulan; uji ini mengoreksi untuk itu dengan bootstrap.
- **Harvey, Liu & Zhu (2016)** [23]: setelah ratusan "faktor" diuji di literatur, faktor baru perlu
  t-statistik **> 3,0**, bukan 2,0; kebanyakan temuan yang diklaim kemungkinan palsu.
- **Bailey dkk. (2014) "Pseudo-Mathematics and Financial Charlatanism"** [39] dan **Probability of Backtest
  Overfitting (PBO)** [40]: metode CSCV memperkirakan peluang bahwa konfigurasi terbaik in-sample berada di
  bawah median out-of-sample. Hold-out tunggal sering menyesatkan.
- **Deflated Sharpe Ratio** [41]: menyesuaikan Sharpe untuk jumlah percobaan dan return tidak normal.
  Praktisnya: **catat berapa konfigurasi yang dicoba**; tanpa angka itu hasil backtest tak bisa dinilai.
- **Kebocoran data (leakage)**: Kapoor & Narayanan [27] menemukan leakage memengaruhi 294 paper di 17 bidang;
  setelah dikoreksi, keunggulan model ML sering hilang. Jenis yang relevan bagi kita: memakai candle belum
  tertutup, swing belum terkonfirmasi, normalisasi/persentil yang memakai data masa depan, dan memilih
  parameter berdasarkan seluruh data lalu "menguji" pada data yang sama.

### 4.6 Biaya, slippage, survivorship

- Biaya: komisi taker dua sisi + spread + slippage. Preprint [7] memakai 5 bp round-trip sebagai patokan
  biaya spot; untuk futures pakai tabel fee akun pengguna (parameter, jangan di-hardcode). Biaya dinyatakan
  dalam R: `biayaR = biaya% × entry / |entry − stop|`. Stop yang sempit membuat biaya dalam R membengkak.
- **Survivorship bias**: Stöckl & Liebi [42] (3.904 koin, 2014–2021) memperkirakan bias tahunan ±0,93% untuk
  portofolio berbobot nilai tetapi ±62% untuk berbobot sama — sangat besar. Backtest yang hanya memakai
  simbol yang *masih* listing hari ini akan terlalu optimistis. Simpan daftar simbol per tanggal (point-in-time)
  termasuk yang sudah delisting bila memungkinkan; minimal laporkan bahwa semesta mengandung bias ini.

---

## 5. Jawaban jujur: apakah akurasi 99% realistis?

**Tidak.** Untuk sinyal arah kripto 5m–1h yang diperdagangkan setelah biaya, akurasi 99% tidak didukung oleh
satu pun sumber kredibel yang ditemukan, dan secara statistik hampir pasti merupakan tanda kesalahan evaluasi.

### 5.1 Angka yang dilaporkan

| Studi | Horizon | Hasil yang dilaporkan | Catatan |
|---|---|---|---|
| Akyildirim, Göncü & Şensoy (2021) [16] | harian & menit, 12 koin | rata-rata akurasi ±55–65%; semua model > 50% | SVM paling konsisten |
| Jaquart, Dann & Weinhardt (2021) [17] | 1–60 menit, Bitcoin | semua model signifikan > acak; GBM & RNN terbaik | angka per horizon tidak dikutip di sini (teks lengkap tak terbaca); dikritik soal kelas tak seimbang |
| Chen, Li & Sun (2020) [18] | 5 menit & harian | ±67% (5 menit), ±66% (harian) | belum terverifikasi out-of-sample murni / keseimbangan kelas |
| Omole & Enke (2024) [19] | harian + data on-chain | 82,44%; backtest "6654% per tahun" | contoh angka yang tak masuk akal secara ekonomi → curigai |
| Fang dkk. (arXiv 2003.00803) [43] | tick berikutnya (mid-price) | 78% | mid-price tick ≠ trade yang bisa dieksekusi setelah spread |
| Preprint Binance 15 menit [7] | 15 menit | selisih AUC +0,011 vs pembanding; edge 1,3 bp < biaya 5 bp | sinyal nyata, tetapi tidak untung |

Pola yang konsisten: **makin realistis evaluasinya** (out-of-sample, biaya, horizon yang bisa
diperdagangkan), **makin dekat ke 50–60%**.

### 5.2 Kenapa 99% hampir pasti overfitting atau lookahead

1. **Batas informasi.** Bila harga intraday bisa ditebak 99%, arbitrase akan menghapusnya dalam sekejap; bahkan
   aliran order yang menjelaskan harga *kontemporer* dengan kuat [5][6] hanya memberi edge kecil ke depan [7][9].
2. **Lookahead tersembunyi**: swing yang dikonfirmasi oleh candle masa depan, candle belum tertutup, indikator
   repaint, persentil/normalisasi seluruh data, atau label yang dihitung dengan high/low candle sinyal itu
   sendiri. Hasilnya sering 90–99% di backtest dan ±50% di live.
3. **Sampel kecil**: 5 dari 5 trade menang = "100%", padahal interval Wilson 95%-nya kira-kira 57%–100%.
4. **Multiple testing**: menguji 1.000 kombinasi parameter dan memilih yang terbaik hampir pasti menghasilkan
   satu konfigurasi dengan win-rate sangat tinggi secara kebetulan [23][29][40].
5. **Ketidakseimbangan kelas**: "akurasi 99%" bisa berarti model menebak "tidak ada sinyal" pada 99% candle.
6. **Target kecil / stop lebar** (lihat §5.3).

### 5.3 Win-rate tinggi ≠ untung

Dengan target `T` R dan stop 1 R, *win-rate impas* (sebelum biaya) = `1 / (1 + T)`.

| Target (R) | Win-rate impas | Contoh |
|---|---|---|
| 0,1 | 90,9% | win-rate 90% → expectancy = 0,9·0,1 − 0,1·1 = **−0,01 R** (rugi) |
| 0,5 | 66,7% | |
| 1 | 50% | |
| 2 | 33,3% | win-rate 40% → expectancy = 0,4·2 − 0,6 = **+0,20 R** |
| 3 | 25% | |

Ditambah biaya, win-rate impas naik lagi. Jadi sistem "win-rate 90%" bisa rugi, sedangkan sistem "win-rate
40%" bisa untung. Itu sebabnya kontrak memakai `targetR = 2` dan melaporkan `expectancyR`.

### 5.4 Trade-off presisi vs jumlah sinyal

Menaikkan ambang tier A akan menaikkan presisi **sampai titik tertentu** sambil memangkas jumlah sinyal.
Pada sinyal sangat sedikit, interval kepercayaan melebar sehingga presisi tinggi itu tidak bisa dibuktikan.
Cara yang benar: plot presisi (dengan CI) dan expectancy terhadap ambang skor pada data out-of-sample, pilih
ambang dengan **batas bawah CI** yang masih di atas win-rate impas + biaya, **bukan** titik dengan presisi
tertinggi.

### 5.5 Metrik yang diusulkan untuk aplikasi

Ditampilkan per arah (LONG/SHORT) × timeframe × tier, hanya dari data out-of-sample:

1. **n** (jumlah sinyal) dan **sinyal per hari** — kejujuran tentang frekuensi.
2. **Presisi (win-rate) + interval Wilson 95%** [24]; TIMEOUT dihitung terpisah (bukan menang).
3. **Expectancy R bersih biaya** + CI (bootstrap) dan **profit factor**.
4. **Monotonisitas tier**: presisi & expectancy A ≥ B ≥ C ≥ D. Bila tidak monoton, bobot salah.
5. **Kalibrasi**: Brier score dan tabel reliabilitas; peluang hanya ditampilkan bila n ≥ ambang (mis. 100
   per bin) — sesuai kontrak `applyCalibration → null`.
6. **MFE/MAE R** rata-rata — untuk menilai apakah stop/target masuk akal.
7. **Jumlah konfigurasi yang dicoba** dan, bila memungkinkan, **PBO** [40] / Deflated Sharpe [41].
8. **Perbandingan dengan baseline**: sinyal acak dengan stop/target yang sama pada simbol & jam yang sama, dan
   strategi "searah HTF saja". Tier A harus mengalahkan keduanya, bukan hanya mengalahkan 50%.

Target realistis (estimasi penulis, **bukan** dari literatur, wajib diverifikasi): dengan `targetR = 2`,
tier A dengan win-rate out-of-sample ±40–48% dan expectancy +0,1 s.d. +0,3 R bersih biaya sudah merupakan
hasil yang **baik**. Win-rate di atas 60% pada 2R perlu dicurigai sebagai kebocoran sebelum dirayakan.

---

## 6. Pemetaan ke arsitektur v3 dan rekomendasi awal

### 6.1 Pemetaan temuan → modul

| Temuan | Modul v3 | Catatan desain |
|---|---|---|
| Swing terkonfirmasi, HH/HL/LH/LL, BOS ≈ range breakout [1][2][3] | `features/marketStructure.js` | swing hanya bila `confirmedIndex ≤ i`; CHoCH berlawanan = veto/penalti |
| Trade-flow imbalance kuat kontemporer, lemah prediktif, rawan berbalik [5][6][7][9] | `features/orderFlow.js` | pakai jendela & divergensi; lonjakan satu candle bukan konfirmasi |
| Volume ∝ \|Δp\| [8]; CMF/A-D/OBV [32] | `features/orderFlow.js` | pengonfirmasi, bobot kecil |
| Momentum/tren HTF [10][11][13][14] | `timeframe` (alignment) | bobot besar; COUNTERTREND = penalti/veto |
| Rezim (ADX, CHOP, ER, BBW) [34][35][36] | `features/regime.js` | CHOPPY = veto; SQUEEZE tanpa arah |
| Spring/upthrust = sweep + reclaim; klimaks volume [30] | `features/liquidity.js` | hipotesis; bobot kecil sampai terbukti |
| Skor ≠ peluang; kalibrasi isotonik [26][28] | `backtest/calibration.js` | `null` bila sampel kurang |
| Triple barrier, purging/embargo [25][37] | `backtest/labeler.js`, `splits.js` | LOSS bila TP & SL di candle sama |
| Wilson, Brier, expectancy [24] | `backtest/metrics.js` | tampilkan CI selalu |
| Data snooping/PBO/DSR [23][29][38]–[41] | `scripts/backtest.js` | catat jumlah konfigurasi; jangan optimasi bobot di data uji |
| Survivorship [42] | `scripts/backtest.js` | semesta point-in-time bila ada |
| Faktor BTC [21][22] | belum ada | usulan input `market` (§6.4) |

### 6.2 Rekomendasi bobot awal `computeConfluence` (HIPOTESIS — wajib dikalibrasi)

Setiap komponen menghasilkan `value` 0..1 (sudah dibalik untuk SHORT), `contribution = weight × value`,
skor = Σ kontribusi / Σ bobot komponen yang **tersedia** × 100 (komponen `null` dilewati, sesuai kontrak).

| id | Bobot | Cara menilai `value` (LONG; SHORT dicerminkan) | `passed` bila | Alasan |
|---|---|---|---|---|
| `pattern` | 25 | `patternScore / 100` (dari `view`) | ≥ 0,6 | detektor inti SA/PVA/SD/PVD tetap pusat |
| `htf` | 20 | ALIGNED 1 · PARTIALLY_CONFIRMED 0,6 · UNCONFIRMED 0,3 · COUNTERTREND 0 | ≥ 0,6 | bukti momentum/tren paling konsisten [10]–[14] |
| `structure` | 20 | `(structureScore + 1)/2`, +0,15 bila BOS searah ≤ 12 bar, −0,3 bila CHOCH berlawanan ≤ 12 bar (klem 0..1) | ≥ 0,6 dan bias ≠ berlawanan | Dow/breakout [2][3]; CHoCH = hipotesis |
| `flow` | 15 | rata-rata dari: `(flowBias+1)/2`; 1 bila divergence searah; 0 bila berlawanan | ≥ 0,55 | imbalance kuat secara kontemporer [5][6], prediktif lemah [7][9] → bobot sedang |
| `regime` | 10 | TRENDING searah 1 · SQUEEZE 0,6 · RANGING 0,5 · TRENDING berlawanan 0,1 · CHOPPY 0 | ≥ 0,5 | hindari pasar bising; squeeze tanpa arah [36] |
| `liquidity` | 10 | sweepLow reclaimed ≤ 5 bar 1 · climax SELLING ≤ 20 bar 0,8 · absorption>0,3 0,7 · posisi < 0,35 dalam range 0,6 · lainnya 0,3 | ≥ 0,6 | Wyckoff/sweep: belum terbukti → bobot kecil |
| **Total** | **100** | | | |

`earlyScore` dari `view` tidak dijadikan komponen terpisah (sudah berkorelasi tinggi dengan `pattern`;
menghitungnya dua kali membuat skor terlalu percaya diri). Bisa ditampilkan sebagai informasi.

### 6.3 Ambang tier & veto (HIPOTESIS)

**Tier**

| Tier | Syarat |
|---|---|
| A | skor ≥ 75 **dan** tanpa veto **dan** `htf`, `structure`, `pattern` lulus **dan** ≥ 4 komponen lulus |
| B | skor ≥ 60 **dan** tanpa veto **dan** ≥ 3 komponen lulus |
| C | skor ≥ 45 (veto boleh ada; tampil sebagai "pantau") |
| D | lainnya |

Mewajibkan beberapa komponen *independen* untuk tier A lebih tahan overfitting daripada sekadar menaikkan
ambang skor: satu komponen bernilai ekstrem tidak bisa sendirian mendorong sinyal ke tier atas.

**Veto** (tier A/B mustahil):

| id veto | Kondisi |
|---|---|
| `HTF_COUNTERTREND` | `alignment = COUNTERTREND` **dan** bias struktur berlawanan arah |
| `CHOCH_AGAINST` | CHOCH berlawanan arah dengan `barsAgo ≤ 5` |
| `CHOPPY` | regime `CHOPPY` (CHOP ≥ 61,8 dan ER ≤ 0,2) |
| `POOR_LIQUIDITY` / `WIDE_SPREAD` / `DATA_QUALITY` | risk flag dari `view` |
| `EXTENDED_PRICE` | risk flag dari `view` (harga terlalu jauh dari EMA dalam ATR) |
| `FLOW_EXHAUSTION` | rasio taker searah > 0,65 pada 3 candle terakhir **dan** harga sudah extended → risiko pembalikan [7] |

**Ambang fitur awal** (konvensi praktisi atau pilihan bulat; tidak dioptimasi):

| Fitur | Ambang awal | Dasar |
|---|---|---|
| ADX tren | ≥ 25; tanpa tren ≤ 20 | konvensi Wilder |
| Choppiness | ≥ 61,8 choppy; ≤ 38,2 tren | konvensi [34] |
| Efficiency Ratio (10) | ≥ 0,30 tren; ≤ 0,20 bising | angka bulat, hipotesis [35] |
| Squeeze | `bandwidthPercentile ≤ 0,10` dalam 120 bar | adaptasi "terendah 6 bulan" [36] ke intraday |
| Taker buy ratio (20 bar) | > 0,52 tekanan beli; < 0,48 tekanan jual | kecil sengaja; delta murni ±4% volume |
| CVD slope / OBV slope | > +0,05 / < −0,05 | hipotesis |
| CMF (20) | > +0,05 / < −0,05 | hipotesis (zona netral di sekitar nol) |
| Climax | volume ≥ 3× median 48 bar | hipotesis |
| Swing | left = right = 2 (uji juga 3/3) | kontrak |
| Labeler | `targetR = 2`, `maxBars = 48`, stop = level invalidasi pola | win-rate impas 33,3% + biaya |
| Split | ≥ 5 fold walk-forward, `embargoBars = 48` | §4.2 |
| Kalibrasi tampil | n ≥ 100 sampel OOS per bin, selalu dengan interval | §4.4 |

### 6.4 Rekomendasi lanjutan (di luar kontrak saat ini)

1. **Konteks BTC**: tambahkan input opsional `market = { btcStructureBias, btcRegime }` dari analisis BTCUSDT
   pada timeframe yang sama/HTF. Untuk altcoin LONG: BTC BEARISH + TRENDING_DOWN → penalti/veto. Ukur dulu
   efeknya pada backtest sebelum diberi bobot [21][22].
2. **Prosedur kalibrasi bobot yang aman**: bobot di §6.2 dikunci sebagai versi 1. Bila diubah, ubah di fold
   latih saja, catat setiap konfigurasi, dan nilai pada fold uji. Lebih baik sedikit konfigurasi yang
   dipikirkan matang daripada grid search besar [23][40].
3. **Laporan backtest** wajib mencantumkan: periode, semesta simbol (dan bias survivorship), biaya yang
   diasumsikan, jumlah konfigurasi yang dicoba, metrik §5.5 per tier, dan perbandingan dengan baseline acak.
4. **Data sintetis** (`synthetic.js`) hanya membuktikan mekanisme bebas lookahead. Uji wajib: pada random
   walk murni, win-rate tier A harus ≈ win-rate impas dan expectancy ≈ −biaya. Bila tier A di random walk
   menang jauh di atas impas, **ada kebocoran**.

---

## Daftar pustaka

1. Lo, A. W., Mamaysky, H., & Wang, J. (2000). Foundations of Technical Analysis: Computational Algorithms,
   Statistical Inference, and Empirical Implementation. *Journal of Finance* 55, 1705–1765. NBER WP 7613.
   https://www.nber.org/papers/w7613
2. Brock, W., Lakonishok, J., & LeBaron, B. (1992). Simple Technical Trading Rules and the Stochastic Properties
   of Stock Returns. *Journal of Finance* 47(5), 1731–1764.
   https://ideas.repec.org/a/bla/jfinan/v47y1992i5p1731-64.html
3. Sullivan, R., Timmermann, A., & White, H. (1999). Data-Snooping, Technical Trading Rule Performance, and the
   Bootstrap. *Journal of Finance* 54(5), 1647–1691. https://ideas.repec.org/p/fmg/fmgdps/dp303.html
4. Park, C.-H., & Irwin, S. H. (2007). What Do We Know About the Profitability of Technical Analysis?
   *Journal of Economic Surveys* 21(4), 786–826. https://ideas.repec.org/a/bla/jecsur/v21y2007i4p786-826.html
5. Cont, R., Kukanov, A., & Stoikov, S. (2014). The Price Impact of Order Book Events. *Journal of Financial
   Econometrics* 12(1), 47–88. https://arxiv.org/abs/1011.6402
6. Silantyev, E. (2019). Order flow analysis of cryptocurrency markets. *Digital Finance* 1, 191–218.
   https://ideas.repec.org/a/spr/digfin/v1y2019i1d10.1007_s42521-019-00007-w.html
7. (Preprint, 2026). Short-horizon mean reversion in cryptocurrency markets: a matched cross-market
   measurement. arXiv:2608.21888 (belum peer-review). https://arxiv.org/abs/2608.21888 ·
   https://ideas.repec.org/p/arx/papers/2608.21888.html
8. Karpoff, J. M. (1987). The Relation between Price Changes and Trading Volume: A Survey. *JFQA* 22(1),
   109–126. https://ideas.repec.org/a/cup/jfinqa/v22y1987i01p109-126_01.html
9. Chordia, T., & Subrahmanyam, A. (2004). Order imbalance and individual stock returns: Theory and evidence.
   *Journal of Financial Economics* 72, 485–518. https://www.cis.upenn.edu/~mkearns/finread/stock-misbalance.pdf
10. Moskowitz, T., Ooi, Y. H., & Pedersen, L. H. (2012). Time Series Momentum. *Journal of Financial Economics*
    104, 228–250. https://papers.ssrn.com/abstract=2089463
11. Liu, Y., & Tsyvinski, A. (2021). Risks and Returns of Cryptocurrency. *Review of Financial Studies* 34(6),
    2689–2727. https://www.nber.org/system/files/working_papers/w24877/w24877.pdf
12. Hudson, R., & Urquhart, A. (2021). Technical trading and cryptocurrencies. *Annals of Operations Research*
    297, 191–220. https://hull-repository.worktribe.com/output/2328042
13. Corbet, S., Eraslan, V., Lucey, B., & Sensoy, A. (2019). The effectiveness of technical trading rules in
    cryptocurrency markets. *Finance Research Letters* 31, 32–37. https://doras.dcu.ie/25053
14. Detzel, A., Liu, H., Strauss, J., Zhou, G., & Zhu, Y. (2021). Learning and predictability via technical
    analysis: Evidence from bitcoin and stocks with hard-to-value fundamentals. *Financial Management* 50(1),
    107–137. https://ideas.repec.org/a/bla/finmgt/v50y2021i1p107-137.html
15. Swinkels, L. (abstrak seminar Rotterdam Brown Bag Seminars in Finance) — time-series momentum pada >3.100 kripto,
    melemah setelah futures Bitcoin (hanya abstrak yang terbaca). https://utilities.tinbergen.nl/?p=66235
16. Akyildirim, E., Göncü, A., & Sensoy, A. (2021). Prediction of cryptocurrency returns using machine learning.
    *Annals of Operations Research* 297, 3–36.
    https://repository.bilkent.edu.tr/items/8f518a9d-24b8-4b2a-a6ea-f17847399ccd/full
17. Jaquart, P., Dann, D., & Weinhardt, C. (2021). Short-term bitcoin market prediction via machine learning.
    *Journal of Finance and Data Science* 7, 45–66. https://publikationen.bibliothek.kit.edu/1000150665
18. Chen, Z. dkk. (2020). Bitcoin price prediction using machine learning: An approach to sample
    dimension engineering. *Journal of Computational and Applied Mathematics*.
    https://www.sciencedirect.com/science/article/pii/S037704271930398X
19. Omole & Enke (2024). Deep learning for Bitcoin price direction prediction: models and trading
    strategies empirically compared. *Financial Innovation* 10, 117.
    https://ideas.repec.org/a/spr/fininn/v10y2024i1d10.1186_s40854-024-00643-1.html
20. Easley, D., O'Hara, M., Yang, S., & Zhang, Z. (2024). Microstructure and Market Dynamics in Crypto Markets.
    SSRN 4814346. https://stoye.economics.cornell.edu/docs/Easley_ssrn-4814346.pdf
21. Katsiampa, P., Corbet, S., & Lucey, B. (2019). Volatility spillover effects in leading cryptocurrencies:
    A BEKK-MGARCH analysis. *Finance Research Letters* 29, 68–74. https://eprints.whiterose.ac.uk/146359/
22. Liu, Y., Tsyvinski, A., & Wu, X. (2022). Common Risk Factors in Cryptocurrency. *Journal of Finance*.
    https://papers.ssrn.com/abstract=3379131
23. Harvey, C. R., Liu, Y., & Zhu, H. (2016). … and the Cross-Section of Expected Returns. *Review of Financial
    Studies* 29(1), 5–68. https://www.nber.org/papers/w20592
24. Brown, L. D., Cai, T. T., & DasGupta, A. (2001). Interval Estimation for a Binomial Proportion. *Statistical
    Science* 16(2), 101–133. https://projecteuclid.org/euclid.ss/1009213286
25. López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley (Bab 3: labeling/triple barrier,
    meta-labeling; Bab 7: purged k-fold & embargo).
    https://www.managementboek.nl/boek/9781119482086/advances-in-financial-machine-learning-marcos-lopez-de-prado
26. Niculescu-Mizil, A., & Caruana, R. (2005). Predicting Good Probabilities with Supervised Learning. *ICML
    2005*, 625–632. https://mlanthology.org/icml/2005/niculescumizil2005icml-predicting
27. Kapoor, S., & Narayanan, A. (2023). Leakage and the Reproducibility Crisis in Machine-learning-based Science.
    *Patterns*. https://pmc.ncbi.nlm.nih.gov/articles/PMC10499856
28. Guo, C., Pleiss, G., Sun, Y., & Weinberger, K. Q. (2017). On Calibration of Modern Neural Networks. *ICML
    2017*. https://proceedings.mlr.press/v70/guo17a.html
29. White, H. (2000). A Reality Check for Data Snooping. *Econometrica* 68(5), 1097–1126.
    https://www.econometricsociety.org/publications/econometrica/2000/09/01/reality-check-data-snooping
30. Materi praktisi Wyckoff (bukan bukti empiris): The Laws of Wyckoff, StockCharts
    https://articles.stockcharts.com/article/articles-wyckoff-2015-12-the-laws-of-wyckoff/ ; preprint pola
    akumulasi berbasis data sintetis arXiv:2403.18839 https://arxiv.org/pdf/2403.18839
31. Contoh definisi BOS/CHoCH praktisi (bukan bukti empiris): TradingView "Smart Money Concepts Probability"
    https://jp.tradingview.com/script/mBINsJlf-Smart-Money-Concepts-Probability-Expo/
32. Definisi A/D line & CMF (Chaikin): Infront Investment Manager help — Chaikin Money Flow
    https://infront-investment-manager.helpcenter.infront.co/en/im/latest/chaikin-money-flow
33. Binance Developers — Kline data (indeks 9 = taker buy base asset volume)
    https://developers.binance.com/en/docs/products/connect-prime/open-apis/11.get-kline-data
34. LuxAlgo Library — Choppiness Index (ambang 61,8/38,2) https://www.luxalgo.com/library/concept/choppiness-index/
35. TA-Lib — Kaufman Efficiency Ratio https://ta-lib.org/functions/er.html ; StockCharts ChartSchool — KAMA
    https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/kaufmans-adaptive-moving-average-kama
36. TradingView Support — Bollinger BandWidth https://www.tradingview.com/support/solutions/43000501972-bollinger-bandwidth-bbw/ ;
    LuxAlgo — Bollinger Squeeze https://www.luxalgo.com/library/concept/bollinger-squeeze/
37. LuxAlgo Library — Purged Cross-validation (ringkasan purging & embargo)
    https://www.luxalgo.com/library/concept/purged-cross-validation.md
38. Hansen, P. R. (2005). A Test for Superior Predictive Ability. *Journal of Business & Economic Statistics*
    23(4), 365–380. Implementasi & ringkasan: https://arch.readthedocs.io/en/latest/multiple-comparison/multiple-comparison-reference.html
39. Bailey, D. H., Borwein, J. M., López de Prado, M., & Zhu, Q. J. (2014). Pseudo-Mathematics and Financial
    Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance. *Notices of the AMS*
    61(5), 458–471. https://scholarworks.wmich.edu/math_pubs/40/
40. Bailey, D. H., Borwein, J. M., López de Prado, M., & Zhu, Q. J. (2017). The Probability of Backtest
    Overfitting. *Journal of Computational Finance* 20(4). https://papers.ssrn.com/abstract=2326253
41. Bailey, D. H., & López de Prado, M. (2014). The Deflated Sharpe Ratio: Correcting for Selection Bias,
    Backtest Overfitting and Non-Normality. *Journal of Portfolio Management* 40(5), 94–107.
    https://papers.ssrn.com/abstract=2460551
42. Stöckl, S., & Liebi, L. Survivorship and Delisting Bias in Cryptocurrency Markets. *Financial Markets and
    Portfolio Management*. https://alexandria.unisg.ch/handle/20.500.14171/108037
43. Fang dkk. (2020). Ascertaining price formation in cryptocurrency markets with DeepLearning.
    arXiv:2003.00803. https://arxiv.org/abs/2003.00803v1
