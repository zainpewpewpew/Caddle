# Riset kritis: machine learning / deep learning untuk AlphaLens

Tanggal: 26 Oktober 2026. Status: **riset + lab evaluasi** (tidak mengubah perilaku scanner live).

Dokumen ini menjawab pertanyaan: *apakah machine learning (ML) atau deep learning (DL) layak ditambahkan ke AlphaLens,
dan kalau iya, dalam bentuk apa?* Jawabannya ditulis sejujur mungkin, termasuk bagian yang mengecewakan.
Dokumen pendukung: [11 — riset akurasi scanner](11-riset-akurasi-scanner.md), [13 — panduan akurasi v3](13-panduan-akurasi-v3.md).

## Ringkasan (baca ini dulu)

1. **ML tidak bisa membuat AlphaLens "99% benar".** Studi jujur (walk-forward, tanpa kebocoran) untuk arah harga
   kripto 5m–1h dari data candle umumnya hanya mencapai **50–53% akurasi arah**, sering tidak signifikan di atas acak.
   Angka di atas 60% dari fitur candle saja pada horizon ini hampir selalu tanda kebocoran data atau salah baca base rate.
2. **Deep learning (LSTM, Transformer, model fondasi seperti Chronos/TimesFM) tidak terbukti lebih baik** daripada model
   sederhana (regresi logistik, gradient boosting) untuk tugas ini — dan sering kalah dari keduanya. Biayanya jauh lebih
   besar (dependensi native/Python, waktu latih, risiko overfitting). **Rekomendasi: jangan pakai DL sekarang.**
3. **Peran ML yang masuk akal: meta-labeling.** Scanner (aturan pola + konfluensi) tetap menentukan arah LONG/SHORT.
   Model ML kedua hanya menilai: *"dari sinyal ini, mana yang lebih mungkin untung setelah biaya?"*. Ekspektasi realistis
   dari literatur: AUC 0,52–0,58 dan win rate +2 s/d +5 poin persen pada sinyal teratas — dengan jumlah sinyal lebih sedikit.
4. **Temuan penting dari lab kami sendiri:** pada pasar acak murni (random walk, tidak ada edge sama sekali), model ML
   tetap "berhasil" memprediksi peluang WIN dengan AUC 0,65 — karena jarak stop relatif ATR secara mekanis memengaruhi
   peluang TP tersentuh. Tetapi sinyal yang dipilih model justru **lebih rugi** (−0,30R vs −0,22R per trade).
   Pelajarannya: *peluang yang tampak tajam belum tentu menghasilkan uang*. Karena itu lab ini memakai label
   "untung neto setelah biaya" dan **wajib** membuktikan kenaikan expectancy, bukan hanya akurasi (§7).
5. **Yang dibangun di PR ini:** lab meta-labeling (`npm run backtest -- ... --ml`) tanpa dependensi baru: regresi
   logistik L2 dan gradient boosting kecil dalam JavaScript murni, evaluasi walk-forward 5 fold dengan purging + embargo,
   kontrol label acak (detektor kebocoran), bootstrap per hari, dan **aturan adopsi otomatis yang konservatif**.
   Hasilnya hanya ditulis di laporan backtest; scanner live **tidak** berubah.
6. **Langkah berikutnya bergantung pada data nyata di Mac Anda.** Bila laporan `--ml` pada data Binance nyata
   (≥ 1,5 tahun, ≥ 20 simbol) menyatakan "LOLOS aturan adopsi", baru kita bahas integrasi live. Bila tidak lolos —
   yang menurut literatur paling mungkin — AlphaLens tetap memakai kalibrasi skor konfluensi yang sudah ada, dan itu
   adalah hasil yang jujur, bukan kegagalan.

## 1. Apa yang sebenarnya bisa diprediksi?

| Hal yang ingin diprediksi | Bukti di literatur | Kesimpulan untuk AlphaLens |
| --- | --- | --- |
| Arah candle berikutnya (5m–1h) dari OHLCV | Lemah: 50–53% pada studi jujur. Mesfin 2026 (arXiv 2605.17724, 5m futures Nasdaq): GBM 50,0–50,9%, LSTM 50,6%, base rate 51,8%, p permutasi 0,14 dan 0,52 → **tidak ada edge**. Baquero 2026 (arXiv 2606.00071, review 23 studi): pada horizon per jam **tidak ada model yang signifikan mengalahkan random walk**. | Jangan jadikan target |
| Arah dengan biaya transaksi | Bysik & Ślepaczuk 2026 (arXiv 2606.00060, BTC 1h, 27 fold walk-forward): strategi tanda (sign) **kehilangan edge pada biaya 10 bps**; hanya filter "prediksi > biaya" yang memulihkan profit di sebagian konfigurasi. XGBoost vs LSTM vs iTransformer: **tidak berbeda signifikan**. | Biaya adalah musuh utama |
| Order book < 1 menit | Kuat (60–78%, Jha dkk. 2020) | Tidak relevan: AlphaLens memakai candle dan masuk sebagai taker |
| Volatilitas / apakah harga akan bergerak cukup jauh dalam 48 candle | Jauh lebih dapat diprediksi daripada arah | Target ML yang lebih menjanjikan (tahap berikutnya) |
| Kualitas sinyal aturan yang sudah ada (meta-labeling) | Mekanisme kuat (López de Prado 2018; seri Joubert/Hudson & Thames 2022–2023); bukti independen untuk kripto intraday **lemah** | **Satu-satunya pendekatan yang kami uji** |

Tingkat bukti: KUAT = direplikasi/peer-review; SEDANG = satu studi baik; LEMAH = preprint/cuplikan. Banyak sumber 2026
hanya dapat dibaca dari abstrak/cuplikan pencarian di lingkungan cloud kami; daftar sumber lengkap di §11.

### Kenapa angka "ML 80–90% akurat" di internet menyesatkan

Pola yang berulang pada studi dengan angka fantastis (Kapoor & Narayanan 2023 menemukan kebocoran pada 294 makalah di
17 bidang):

- cross-validation acak (k-fold diacak) pada data deret waktu → masa depan bocor ke data latih;
- normalisasi/skala dihitung dari seluruh data (termasuk periode uji);
- memprediksi **level** harga (bukan return) — R² tampak tinggi karena harga besok ≈ harga hari ini;
- tidak membandingkan dengan base rate (contoh arXiv 2607.12248: "80% akurat" ternyata base rate 70%, model di bawahnya);
- memilih fitur/parameter terbaik dari ratusan percobaan lalu melaporkan yang terbaik saja (backtest overfitting:
  Bailey & López de Prado, *Deflated Sharpe Ratio* 2014; *Probability of Backtest Overfitting* 2017; Harvey, Liu & Zhu
  2016: ambang t > 3,0, bukan 2,0).

## 2. Deep learning: kenapa tidak sekarang

- **Zeng dkk. (AAAI 2023)**, "Are Transformers Effective for Time Series Forecasting?": model linear satu lapis mengalahkan
  semua Transformer peramal yang diuji. (KUAT)
- **Grinsztajn dkk. (NeurIPS 2022)**: pada data tabular berukuran sedang (±10 ribu baris), model pohon mengalahkan jaringan
  saraf; jaringan saraf dirugikan oleh fitur tidak informatif — persis kondisi fitur analisis teknikal. (KUAT)
- **Rahimikia, Ni & Wang (2025, arXiv 2511.18578)**: model fondasi deret waktu siap pakai (Chronos, TimesFM, dll.) pada return
  keuangan **buruk zero-shot maupun setelah fine-tuning**, kalah dari CatBoost/LightGBM, dan tidak menghasilkan strategi
  yang menguntungkan. (SEDANG–KUAT)
- **Kronos (arXiv 2508.02739)**, model fondasi khusus candle: klaim besar dari penulisnya sendiri, belum direplikasi
  independen; juga berisiko "look-ahead pralatih" (dilatih pada candle yang tumpang-tindih dengan periode uji). (LEMAH–SEDANG)
- **Data kita kecil untuk DL.** Unit belajar meta-labeling adalah *sinyal*, bukan candle. Backtest sintetis kita
  menghasilkan ±2,3 sinyal per hari per simbol pada 15m. Perkiraan untuk data nyata 21 bulan × 30 simbol: ±40 ribu sinyal
  15m dan ±6 ribu sinyal 1h — dan sinyal di banyak simbol pada jam yang sama sangat berkorelasi (seluruh pasar mengikuti
  BTC), sehingga jumlah "sampel independen" efektif jauh lebih kecil. Ini cukup untuk model dengan puluhan parameter,
  tidak untuk jaringan dengan ratusan ribu parameter.
- **Biaya teknis.** Lihat §6: DL di Node berarti `onnxruntime-node`/`tfjs-node` (biner native ratusan MB) atau server
  Python terpisah — keduanya menambah titik gagal di Mac Anda, padahal manfaatnya belum terbukti.

**Kesimpulan:** DL ditunda sampai (a) meta-labeling sederhana terbukti memberi edge pada data nyata, dan (b) ada data
baru yang tidak dimiliki aturan (funding rate, open interest, basis, order book). Tanpa data baru, model yang lebih rumit
hanya mempelajari ulang informasi yang sama dari OHLCV.

## 3. Meta-labeling: cara kerja di AlphaLens

```
candle → pola SA/PVA/SD/PVD + konteks HTF + fitur v3 → skor konfluensi → state machine → SINYAL (arah dari aturan)
                                                                                           │
                                       fitur saat entri (31 angka) ──► model ML kedua ──► P(untung neto)
```

- **Model primer** (aturan) menentukan arah dan kapan ada sinyal. Tidak diubah.
- **Model sekunder** (ML) dilatih hanya pada sinyal masa lalu yang sudah selesai, dengan label
  **1 = trade untung neto (R > 0 setelah fee 4 bps + slippage 2 bps per sisi), 0 = tidak**.
- Kegunaannya nanti: menyaring sinyal lemah dan/atau menampilkan peluang yang lebih tajam daripada tabel kalibrasi skor.

### Kenapa label "untung neto", bukan "WIN (TP tersentuh)"

Uji random walk lab ini (8 simbol × 6.000 candle 15m, 1.207 trade, tanpa edge sama sekali):

| Label | Hasil ML pada data uji | Expectancy sinyal pilihan ML vs semua sinyal |
| --- | --- | --- |
| WIN (TP tersentuh) | AUC 0,656, skill log-loss +4,5% → **tampak "pintar"**, lolos aturan lama | −0,30R vs −0,22R → **lebih rugi** |
| Untung neto (dipakai sekarang) | AUC 0,515–0,533, skill ≤ 0 → ditolak | aturan ekonomi tidak lolos → **ditolak (benar)** |

Penyebabnya mekanis: stop yang sempit relatif ATR lebih cepat menyentuh TP *maupun* SL (lebih sedikit TIMEOUT), sehingga
"peluang WIN" naik — tetapi biaya dalam satuan R juga naik, sehingga expectancy turun. Model belajar sesuatu yang nyata
tetapi tidak menghasilkan uang. Inilah alasan aturan adopsi (§7) mewajibkan bukti ekonomi.

## 4. Fitur meta-labeling (31 angka, semuanya tersedia saat entri)

`backend/ml/metaFeatures.js` — semua besaran bertanda dikali arah (+ = searah sinyal), sama dengan konfluensi:

| Kelompok | Fitur |
| --- | --- |
| Skor aturan | skor konfluensi, nilai 6 komponen (pola, HTF, struktur, order flow, rezim, likuiditas), jumlah veto, tier, skor pola, skor dini |
| Konteks sinyal | arah SHORT?, timeframe 5m/15m (1h = acuan), tahap state (EARLY / MOMENTUM / BREAKOUT) |
| Rezim | ADX, efficiency ratio, persentil bandwidth Bollinger, choppiness |
| Order flow & struktur | flow bias, slope CVD, ketimpangan taker, skor struktur, posisi dalam range |
| Harga & risiko | jarak stop dalam ATR, return 12 & 48 candle dalam ATR, volume relatif 20 candle |
| Waktu | jam UTC (sin/cos), akhir pekan |

Nilai yang tidak tersedia = NaN → diisi median **data train** (bukan seluruh data). Uji `NEG-ML-FEAT-001` membuktikan
vektor fitur entri identik walaupun candle masa depan dipotong/diubah (tanpa lookahead).

**Batas penting:** hampir semua fitur ini turunan OHLCV yang sudah dipakai aturan. Literatur (QuantConnect "meta labeling
is not a silver bullet"; Joubert dkk.) menegaskan meta-labeling paling membantu bila diberi informasi **ortogonal** —
funding rate, perubahan open interest, basis, rezim BTC. Itu kandidat fitur tahap berikutnya (§10).

## 5. Model yang diuji (dan kenapa hanya dua)

| Model | File | Alasan |
| --- | --- | --- |
| Base rate | — | Pembanding paling bodoh: selalu menebak rata-rata train |
| Kalibrasi isotonik skor konfluensi | `backend/backtest/calibration.js` (sudah ada) | **Pembanding utama**: inilah yang dipakai AlphaLens sekarang |
| Regresi logistik L2 | `backend/ml/logistic.js` | Konveks, deterministik, ±32 parameter, dapat dijelaskan (koefisien) |
| Gradient boosting pohon dangkal | `backend/ml/gbdt.js` | Gaya LightGBM/XGBoost (histogram kuantil, daun Newton, L2), menangkap interaksi |

Hyperparameter **tetap dan konservatif** (logistik λ = 5; boosting kedalaman 2, 100 ronde, laju 0,05, minimal 40 sampel per
daun, λ = 5) dan **tidak di-tuning** pada data uji. Setiap kandidat tambahan menaikkan peluang "menang karena kebetulan"
(multiple testing), jadi sengaja hanya dua.

## 6. Opsi teknis: kenapa JavaScript murni (tanpa dependensi baru)

| Opsi | Kelebihan | Kekurangan untuk AlphaLens | Putusan |
| --- | --- | --- | --- |
| **JS murni** (dipilih) | Tanpa dependensi, tanpa biner native, jalan di Mac & cloud, deterministik, mudah diuji | Harus menulis & menguji sendiri (±400 baris) | ✅ Cukup untuk ribuan–puluhan ribu baris × 31 fitur |
| `onnxruntime-node` | Menjalankan model LightGBM/XGBoost/NN yang diekspor (ONNX-ML) | ±290 MB; **tidak ada biner Mac Intel** sejak 1.24; perlu pipeline Python untuk melatih & mengekspor | Hanya bila nanti butuh model besar |
| `onnxruntime-web` (WASM) | Jalan di semua platform, tanpa skrip instalasi | ±2× lebih lambat dari native (masih ±1 ms per 300 baris); tetap butuh Python untuk melatih | Cadangan terbaik bila kelak pakai LightGBM |
| `@tensorflow/tfjs-node` | DL di Node | Skrip instalasi mengunduh libtensorflow → gagal dengan `ignore-scripts=true`; tanpa rilis stabil sejak 10-2024 | ❌ |
| `@tensorflow/tfjs` (JS murni) | Tanpa native | Lambat untuk melatih; tidak dibutuhkan model kecil | ❌ |
| Paket ml.js (`ml-logistic-regression`, `ml-random-forest`, dll.) | Pure JS | Banyak yang jarang dirawat; tidak ada boosting yang matang | ❌ |
| Sidecar Python (LightGBM, scikit-learn) | Ekosistem terbaik | Anda harus memasang & menjalankan Python di Mac; dua runtime, dua sumber kebenaran | Hanya untuk riset offline bila diperlukan |

### 6a. Fakta yang diuji di lingkungan cloud (Linux 4 vCPU, Node 22)

- `onnxruntime-node` 1.30.0 (MIT): biner CPU untuk darwin-arm64 & linux-x64 sudah dibundel, bisa dipasang dengan
  `ignore-scripts=true`; darwin-x64 (Mac Intel) terakhir ada di 1.23.2.
- `onnxruntime-web` 1.30.0 (MIT): terpasang tanpa skrip, berjalan dari ESM biasa. Model LightGBM yang diekspor via
  onnxmltools memberi prediksi yang sama dengan LightGBM aslinya.
- Paket npm `lightgbm`/`xgboost` butuh build cmake-js/node-gyp (bertentangan dengan `.npmrc` proyek). `ml-random-forest`:
  20 pohon pada 3 ribu baris butuh 48 detik. `ml-xgboost` tidak dirawat sejak 2022.
- **JS murni cukup cepat**: 50 ribu baris × 40 fitur — regresi logistik IRLS 0,75 detik, GBDT 200 pohon 7,3 detik.
- Bila kelak pakai LightGBM dari Python: ekspor JSON-nya bisa dibaca ±15 baris JS (prediksi identik) tanpa dependensi.
  LightGBM di Mac butuh `brew install libomp` — hambatan untuk pemakaian sehari-hari.
- DL: satu epoch LSTM(32) atas 200 ribu sekuens ±8,7 menit (tfjs WASM) s/d 38 menit (tfjs JS murni) → melatih ulang
  rutin di Node tidak praktis. Inferensi murah (300 sekuens ±3–11 ms).

## 7. Protokol evaluasi (tanpa lookahead) dan aturan adopsi

`backend/ml/evaluate.js`, dipanggil runner backtest bila `--ml`:

1. **Data**: semua sinyal v2 (semua yang masuk state alert) yang sudah selesai (WIN/LOSS/TIMEOUT), urut waktu entri.
2. **Walk-forward anchored 5 fold**: 40% awal rentang waktu selalu train; sisanya dibagi 5 jendela uji berurutan.
   Train fold k = trade dengan entri < awal uji − embargo **dan** exit < awal uji (*purging*: label train tidak boleh
   melihat periode uji). Embargo = max-bars × timeframe (48 candle).
3. **Semua yang dipelajari hanya dari train**: median imputasi, mean/sd, ambang histogram, tabel isotonik, ambang seleksi.
4. **Kontrol label acak**: model yang sama dilatih pada label train yang diacak. Bila kontrol ini tampak punya skill pada
   data uji (n uji ≥ 500), ada bug/kebocoran → seluruh hasil dinyatakan tidak sah.
5. **Metrik peluang**: log-loss (utama), Brier, AUC, skill = 1 − log-loss / log-loss base rate.
6. **Metrik ekonomi**: per fold, ambang = persentil 70 prediksi model pada train → 30% sinyal uji teratas dipilih.
   Expectancy R neto seleksi vs semua sinyal vs seleksi skor konfluensi.
7. **Bootstrap blok per hari UTC** (1.000 resample) untuk interval 95% — sinyal pada hari yang sama berkorelasi, jadi
   resampling per trade akan membuat interval terlalu sempit.

**Aturan adopsi — SEMUA wajib terpenuhi**, kalau tidak, laporan menulis "ML TIDAK diadopsi":

| # | Aturan |
| --- | --- |
| 1 | Sampel uji ≥ 500 trade; setiap fold ≥ 200 trade train |
| 2 | Kontrol label acak tidak menunjukkan skill > 1% |
| 3 | Log-loss uji lebih baik dari kalibrasi isotonik **dan** dari base rate |
| 4 | Menang atas isotonik di ≥ 60% fold (konsisten antar periode, bukan satu periode beruntung) |
| 5 | Interval bootstrap 95% perbaikan log-loss > 0 |
| 6 | Interval bootstrap 95% *lift* expectancy (seleksi − semua sinyal) > 0 |
| 7 | Expectancy seleksi > expectancy seleksi skor konfluensi |
| 8 | Interval bootstrap 95% expectancy seleksi > 0R (untung **setelah biaya**) |

### Hasil uji mekanisme (data sintetis — BUKAN akurasi pasar nyata)

| Skenario | Hasil |
| --- | --- |
| Random walk murni, 8 simbol × 6.000 candle 15m (1.207 trade) | **Ditolak** (benar). Logistik: skill −0,07%, GBDT −0,98%; kontrol acak tanpa skill |
| Pasar sintetis dengan pola tertanam (akumulasi → markup dengan taker buy tinggi), 6 simbol × 6.000 candle | Lolos — generator memang menanam informasi yang dapat dipelajari; membuktikan pipeline mampu menemukan edge yang benar-benar ada |
| Tes unit: fitur acak tanpa informasi | Ditolak; edge tertanam pada satu fitur → diadopsi, fitur itu teratas |

Data sintetis tidak berkata apa pun tentang pasar nyata; laporan otomatis menampilkan peringatan "Data sintetis".

### Daya statistik: berapa data yang dibutuhkan

Perhitungan (α 5% dua sisi, power 80%) untuk mendeteksi kenaikan win rate 3–5 poin persen pada base rate 33–40%:
**700–2.100 trade uji** (dibanding nilai tetap) atau **1.400–4.200 per kelompok** (seleksi vs tanpa seleksi). Bila filter
hanya menyisakan 30–40% sinyal, butuh ±5.000+ sinyal mentah out-of-sample. Korelasi antarsimbol dan banyaknya varian
yang diuji melipatgandakan angka ini (±2×). Karena itu aturan #1 (≥ 500) adalah batas *minimum*, bukan jaminan.

## 8. Cara membaca bagian "Lab meta-labeling" di laporan

- **Keputusan** di baris tebal paling atas, beserta alasan per model (mis. "menang hanya di 2/5 fold").
- **Kualitas peluang out-of-sample**: lihat kolom *Skill*. ≤ 0% = tidak lebih baik dari menebak rata-rata.
  Bandingkan baris ML dengan baris *Kalibrasi isotonik* — itu yang harus dikalahkan. Baris *Kontrol* harus ≤ 0%.
- **Per fold**: ML yang bagus menang di hampir semua fold. Menang di satu fold saja = kebetulan/rezim.
- **Bukti ekonomi**: kolom *Lift* harus positif dengan interval yang tidak mencakup 0, dan *Expectancy seleksi*
  harus > 0R. Inilah yang menentukan apakah ML menghasilkan uang.
- **Fitur paling berpengaruh**: koefisien logistik terstandar dari seluruh data — hanya penjelasan. Bila fitur teratas
  adalah `riskAtr` (jarak stop), itu efek mekanis biaya/target, bukan "ramalan arah".

## 9. Risiko & jebakan yang masih ada (jujur)

1. **Bias survivorship universe.** `--top 30` memilih simbol berdasarkan volume *hari ini* — koin yang sudah delisting
   atau tenggelam tidak ikut, koin yang kemudian naik ikut. Stöckl (St. Gallen, 3.904 koin 2014–2021) mengukur bias
   ±62%/tahun untuk portofolio equal-weighted. Lebih aman: daftar simbol tetap yang dipilih di awal periode
   (`--symbols ...`) atau CSV data.binance.vision yang menyertakan simbol lama.
2. **Entri di close candle sinyal.** Runner masuk di close candle sinyal (+ slippage 2 bps). Live, order baru bisa
   dikirim setelah candle tutup, jadi harga nyata = open candle berikutnya. Untuk 5m selisih ini dapat berarti.
3. **Funding rate** perpetual belum dihitung (trade 1h × 48 candle dapat melewati 6 kali funding).
4. **Kalibrasi isotonik pada sampel kecil cenderung overfit** (Niculescu-Mizil & Caruana 2005; Kull dkk. 2017). Pembanding
   yang lebih kuat untuk masa depan: kalibrasi Platt/Beta. Seleksi isotonik juga bertangga (banyak skor seri), sehingga
   "30% teratas" isotonik bisa memilih lebih dari 30%.
5. **Non-stasioner.** Rezim 2021 (bull), 2022 (bear), 2024 (ETF) berbeda. Hasil yang lolos harus dicek per tahun dan
   pada periode baru yang belum pernah dilihat (forward test) sebelum dipakai live.
6. **Banyak percobaan = overfitting.** Setiap kali Anda menjalankan `--ml` dengan rentang/simbol berbeda lalu memilih
   hasil terbaik, peluang "lolos karena kebetulan" naik. Catat setiap percobaan; percayai hasil yang konsisten.

## 10. Rekomendasi & rencana bertahap

| Tahap | Isi | Syarat lanjut |
| --- | --- | --- |
| **0 (PR ini)** | Lab meta-labeling di backtest, aturan adopsi, dokumen ini. Scanner live tidak berubah | — |
| 1 (Anda, di Mac) | Jalankan `--ml` pada data Binance nyata ≥ 1,5 tahun, 15m & 1h, ≥ 20 simbol; kirim bagian "Lab meta-labeling" | — |
| 2 | Bila **ditolak**: tetap pakai kalibrasi skor; perbaikan yang lebih bernilai menurut literatur adalah filter biaya (jarak stop minimum relatif biaya), entri open berikutnya, dan kalibrasi Platt/Beta | — |
| 2' | Bila **lolos**: uji ulang pada periode baru (forward 1–3 bulan) tanpa mengubah apa pun | Lolos lagi |
| 3 | Integrasi live **opsional**: model disimpan ke `config/meta-model.json` (dilatih hanya pada data train), ditampilkan sebagai "peluang ML" berdampingan dengan skor & tier, dengan interval dan jumlah sampel; bisa dimatikan | Persetujuan Anda |
| 4 | Data ortogonal: funding rate, open interest, basis, rezim BTC sebagai fitur | Fitur baru lolos aturan yang sama |
| 5 | Baru pertimbangkan DL (mis. model sekuens kecil via ONNX) | Tahap 4 terbukti & data ≥ puluhan ribu sinyal independen |

## 11. Sumber utama

- López de Prado, M. (2018). *Advances in Financial Machine Learning*, Wiley — bab 3 (triple barrier, meta-labeling), bab 7 (purged CV, embargo).
- Bailey, D. & López de Prado, M. (2014). The Deflated Sharpe Ratio. *J. Portfolio Management* 40(5).
- Bailey, Borwein, López de Prado & Zhu (2017). The Probability of Backtest Overfitting. *J. Computational Finance* 20(4).
- Harvey, Liu & Zhu (2016). …and the Cross-Section of Expected Returns. *Review of Financial Studies* 29(1).
- Zeng, Chen, Zhang & Xu (2023). Are Transformers Effective for Time Series Forecasting? *AAAI* 37.
- Grinsztajn, Oyallon & Varoquaux (2022). Why do tree-based models still outperform deep learning on tabular data? *NeurIPS*.
- Rahimikia, Ni & Wang (2025). Re(Visiting) Time Series Foundation Models in Finance. arXiv 2511.18578.
- Bysik & Ślepaczuk (2026). ML-Based Bitcoin Trading Under Transaction Costs. arXiv 2606.00060 (preprint; dibaca dari cuplikan).
- Mesfin (2026). Sequential Structure in Intraday Futures Data: LSTM vs Gradient Boosting on MNQ. arXiv 2605.17724 (preprint).
- Baquero (2026). Bitcoin Price Prediction: Peer-Reviewed Evidence. arXiv 2606.00071 (preprint; dibaca dari abstrak).
- Cakici, Shahzad, Będowska-Sójka & Zaremba (2024). *International Review of Financial Analysis* 94:103244.
- Gu, Kelly & Xiu (2020). Empirical Asset Pricing via Machine Learning. *Review of Financial Studies* 33(5).
- Joubert (2022), Meta-Labeling: Theory and Framework; Meyer, Joubert & Alfeus (2022), Meta-Labeling Architecture; Meyer, Barziy & Joubert (2023), Meta-Labeling: Calibration and Position Sizing — *J. Financial Data Science* (abstrak tidak dapat dibaca penuh).
- Niculescu-Mizil & Caruana (2005). Predicting good probabilities with supervised learning. *ICML*.
- Kull, Silva Filho & Flach (2017). Beta calibration. *AISTATS*.
- Kapoor & Narayanan (2023). Leakage and the reproducibility crisis in ML-based science. *Patterns* 4(9).
- Stöckl. Survivorship and Delisting Bias in Cryptocurrency Markets. Univ. St. Gallen (venue belum terverifikasi).
- Jha dkk. (2020). Deep Learning for Digital Asset Limit Order Books. arXiv 2010.01241.
- Shi dkk. Kronos: a foundation model for K-line data. arXiv 2508.02739.

Catatan verifikasi: di lingkungan cloud kami sebagian besar situs penerbit diblokir, sehingga banyak angka diambil dari
abstrak/cuplikan pencarian. Angka-angka tersebut dipakai untuk arah kesimpulan, bukan sebagai kutipan presisi.
