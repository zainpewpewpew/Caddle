# 29 — Audit implementasi AL-MOM-01: kode beku, diagnostik, dan simulasi coverage (2026-11-16)

**Status: audit pembekuan kode, belum beku.** Dokumen ini merinci pemeriksaan sebelum kode analisis AL-MOM-01 dibekukan
(docs/28 §9.1).

- **Babak pertama** (§1–§12; 2026-11-15, sebelum jendela dimulai): implementasi, validasi historis, dan simulasi coverage
  inti.
- **Babak lanjutan** (§13–§20; 2026-11-15 23:10 sampai 2026-11-16 ±01:30 UTC): skenario stres, investigasi asimetri CI,
  target inferensi, kekuatan pasangan, perbandingan metode CI, komponen waktu, dan akses data.
  - Jendela uji dimulai 2026-11-16 00:00 UTC, di tengah babak ini.
  - Seluruh komputasi babak ini memakai data sintetis atau data historis sampai 2026-10-01 saja.
  - Tidak ada hasil A atau B dari data jendela (≥ 2026-11-16) yang dihitung atau dilihat (docs/28 §8).
- **Babak ketiga** (§19–§21; 2026-11-16 ±06:00–08:00 UTC): keputusan pemilik soal tujuan AL-MOM-01, penjaga akses
  `backtest` dan snapshot cache riset, kalibrasi rezim dari ciri historis, dan **praregistrasi simulasi konfirmasi** (§21).
  Run konfirmasi belum dijalankan. Data yang dipakai: sintetis, dan historis ≤ 2026-10-01 (ciri return dan jumlah saja).

Label klaim:

- **VERIFIED**: dibuktikan lewat kode, tes otomatis, atau argumen matematis yang ditulis di sini.
- **SIMULATED**: hasil simulasi dengan asumsi DGP yang disebutkan.
- **HISTORICAL**: data sebelum jendela uji, yang sudah pernah dilihat (docs/24–27).
- **UNVERIFIED**: belum terbukti.

## 1. Vonis

**BELUM SIAP DIBEKUKAN. Implementasi teruji. Bukti simulasi cukup untuk satu keputusan metode CI, tetapi keputusan itu,
dan satu masalah estimand, ada di tangan pemilik (§20).**

- **Yang sudah terbukti.**
  - Runner menjalankan desain docs/28 §2–§8 dengan setia, dan paritasnya dengan alat desain terbukti (VERIFIED).
  - Pengaman akses data runner bekerja. Ada satu celah di luar runner, yaitu CLI `backtest` (§19).
  - SMD dan overlap memadai pada data historis (HISTORICAL).
- **Klaim superioritas** (batas bawah CI > 0) **terkendali di semua DGP** yang diuji dengan CI persentil yang dikunci:
  galat 0,0–1,0% (nominal 2,5%) di 10 DGP (SIMULATED, §8.5–§8.6).
- **Bacaan "keunggulan < 0,25 ATR"** (batas atas < M; kelompok 1/3) **tidak terkalibrasi dengan CI persentil**: galatnya
  6–10% pada 40 simbol dan 13–15% pada skala 100 simbol, terhadap target prosedural (SIMULATED, §16–§17).
- **Masalah yang lebih besar dari pilihan metode CI** (SIMULATED, §15). Terhadap estimand populasi, estimator docs/28
  bias ke bawah ±25%, karena:
  - pembanding sebelum alert menangkap gerak pemicu;
  - pembanding sesudah alert membawa drift informasi alert itu sendiri.

  Tidak ada metode CI yang memperbaikinya. Bacaan "< 0,25" harus dibaca pada skala estimand prosedural, bukan sebagai
  batas efek informasi.
- **Babak pertama keliru di dua klaim:** "komponen waktu = sifat estimand" dan "atenuasi = sifat estimand". Koreksinya di
  §15 dan §18.
- **Babak ketiga.**
  - Pemilik memutuskan bahwa AL-MOM-01 adalah **uji konfirmasi superioritas**. Batas 0,25 ATR deskriptif dan berlaku pada
    skala prosedural (§20.1).
  - Simulasi konfirmasi menjadi **syarat pembekuan**. Kriterianya dikunci di §21 sebelum run apa pun.
  - Celah `backtest` ditutup (§19).
  - Ada temuan baru dari ciri historis: hari yang padat alert LONG 1h justru lebih tenang dan korelasinya lebih rendah.
    Hipotesis "rezim padat", yaitu korelasi, volatilitas, dan alert naik bersama, bertentangan dengan data historis
    (HISTORICAL, §21.2).

## 2. Kondisi awal dan lingkup

- **Awal kerja.** `main` di `babc95a`, pohon kerja bersih, 2026-11-15 20:12 UTC (sebelum jendela dimulai). Babak lanjutan
  mulai dari `14b00f7`.
- **Yang sudah ada.** Inti desain di docs/28 §2–§8 (`7da88ce`), serta alat desain `research-mom-power/-sim/-overlap` (docs/27).
- **Batas yang dipegang.**
  - docs/28 §2–§8 tidak diubah. Pemeriksaan otomatis membandingkan teks §2–§8 dengan commit `7da88ce`: identik.
  - `backend/` dan runner tidak diubah di babak lanjutan.
    - Hash pohon AL-MOM-01 tetap `f3004d2c…`.
    - Hash AL-SA-ATR-01 tetap `25c02256…f8b314` (VERIFIED, UNIT-MOM01-001).
  - Tidak ada `evaluate` yang dijalankan, baik AL-SA-ATR-01 maupun AL-MOM-01.

## 3. Temuan dan tingkat keparahan

| # | Temuan | Label | Keparahan | Status |
|---|---|---|---|---|
| 1 | **Komponen waktu adalah bias estimator, bukan sifat estimand** (koreksi babak pertama). Di DGP tanpa informasi, harga dasar martingale dan seleksi hanya dari candle ≤ t, sehingga estimand populasi tepat 0 (dibuktikan juga oleh oracle: −0,001 ± 0,005). Estimator memberi −0,021 sampai −0,030, terutama karena rata-rata pembanding strata ikut naik (pembanding pra-alert memuat gerak pemicu) | VERIFIED + SIMULATED | sedang | dilaporkan; arahnya merugikan SA/PVA (§15, §18) |
| 2 | **Galat satu sisi CI persentil.** Superioritas palsu 0,0–1,0% (sangat konservatif). "< M" palsu 6,0–9,6% (40 simbol) dan 13–15% (100 simbol) terhadap target prosedural | SIMULATED | **mayor** | keputusan pemilik §20 |
| 3 | **"Atenuasi" juga bias estimator** (koreksi). Terhadap estimand populasi (oracle 0,300 pada δ 0,2946), komponen drift plug-in hanya 0,250. Penyebabnya kontaminasi diri: pembanding sesudah alert di strata yang sama membawa drift informasi alert itu sendiri. Total bias −0,076 ≈ −1,1 SE | SIMULATED | **mayor (tafsir)** | bacaan "< M" hanya pada skala prosedural (§15) |
| 4 | `--log-dir` memungkinkan evaluate kedua tanpa `--rerun-reason` (temuan peninjau independen) | VERIFIED | mayor | diperbaiki: evaluate menolak folder log/cache non-bawaan |
| 5 | Bootstrap fallback tidak mengulang aturan fallback per replikasi | VERIFIED | minor | diperbaiki (UNIT-MOM01-016) |
| 6 | Deret hasil resampling lebih panjang dari D, karena blok terakhir tidak dipotong (+0,8% untuk D = 729) | VERIFIED | minor | diperbaiki: MBB baku (UNIT-MOM01-008) |
| 7 | Profil alert tak cocok belum memuat "kelompok koin" yang diminta §7 | VERIFIED | minor | diperbaiki |
| 8 | Data yang berhenti sebelum cutoff tanpa delisting terverifikasi tidak menghalangi evaluate | VERIFIED | minor | diperbaiki (UNIT-MOM01-006) |
| 9 | SMD pada rata-rata null menghasilkan angka semu | VERIFIED | minor | diperbaiki (UNIT-MOM01-007) |
| 10 | Audit AL-SA-ATR-01 berhenti di 2027-11-16, padahal AL-MOM-01 butuh data sampai 2028-11-16 | VERIFIED | sedang | ditutup: `--mode count` menjadi log integritas tahun kedua |
| 11 | Skrip riset lama bisa membuka hasil jendela lewat `--to` | VERIFIED | sedang | 4 skrip dijaga; 2 skrip terkunci docs/25 tidak bisa diubah (§19) |
| 12 | Kandidat diagnostik "ATT tanpa pembanding pra-alert" **ditolak**: membagi pembanding menurut alert yang akan datang adalah seleksi masa depan (+0,26 ATR pada data tanpa informasi) | SIMULATED | — | tidak dipakai |
| 13 | **Pergeseran distribusi bootstrap** muncul hanya bila rata-rata pembanding diboboti bersama alert pada hari yang sama. Ia mereproduksi ±40% bias estimator (§14) | SIMULATED | sedang | dasar perbandingan metode §17 |
| 14 | **CI basic dan BC melampaui nominal superioritas palsu** bila alert sangat tak merata: 4,8% [3,2–7,0] dan 4,6%. Juga sedikit pada episode tren (3,4%) | SIMULATED | sedang | alasan AL-MOM-02 basic tidak direkomendasikan (§17) |
| 15 | **Efek yang berubah per rezim:** SE bootstrap terlalu kecil (rasio 0,67), dan coverage rata-rata jangka panjang hanya 75–77% untuk semua metode. Coverage target jendela terealisasi θ_d tetap 96,6% | SIMULATED | sedang | CI berlaku untuk jendela 2026–2028, bukan rezim lain (§15) |
| 16 | **Stres gabungan** (korelasi 0,85, ekor tebal, alert tak merata, strata sedikit): SE bootstrap 9–24% terlalu kecil, coverage 82–92% | SIMULATED | sedang | risiko sisa §12 |
| 17 | **Kekuatan pasangan historis (rasio SE 0,71) dijelaskan terutama oleh jumlah simbol** (100 vs 40), bukan oleh struktur strata yang ternyata mirip. Kalibrasi DGP parsial (§16) | SIMULATED + HISTORICAL | — | dilaporkan |
| 18 | **CLI `npm run backtest`** memakai `--to` bawaan = sekarang, sehingga bisa menampilkan R dan win rate trade v3 LONG 1h pada data jendela | VERIFIED | **mayor** | usulan isolasi, keputusan pemilik (§19) |
| 19 | **Diagnostik landmark lintas simbol** tak bias di bawah H0 dan mengembalikan estimand populasi tanpa atenuasi. Estimand-nya berbeda | SIMULATED | — | usulan pelengkap, keputusan pemilik (§18) |

Temuan 4–9 berasal dari tinjauan independen atas kode (subagen yang hanya membaca, diberi kode dan docs/28 tanpa
kesimpulan penulis). Tinjauan itu tidak menemukan cacat kritis.

## 4. Perubahan kode

| File | Isi | Di hash beku? |
|---|---|---|
| `scripts/research-al-mom-01.js` | Runner. Tidak berubah di babak lanjutan | ya |
| `scripts/research-al-mom-01-coverage.js` | Simulasi coverage. Babak lanjutan menambah: `innovationSeed` (lapisan rezim tetap, inovasi berganti; mode oracle), tuas `marketKappa`, skenario kekuatan pasangan 100 simbol, dan pilihan blok per skenario. Urutan bilangan acak DGP lama tidak berubah (sidik jari 6 skenario identik sebelum dan sesudah) | tidak |
| `scripts/research-al-mom-01-diagnose.js` | **Baru.** Diagnostik: ciri historis vs sintetis, dekomposisi y = y0 + Δ, pergeseran bootstrap per komponen/varian/blok, probe bobot terpisah, oracle estimand populasi, landmark lintas simbol, kelayakan landmark historis tanpa hasil | tidak |
| `scripts/research-window-guard.js` | `assertBeforeMomWindow`: `--to` ≤ 2026-11-16 (dipakai juga oleh mode historis diagnostik) | tidak |
| `scripts/research-mom-power.js`, `-overlap.js`, `-sim.js`, `research-matched-exclusion.js` | Satu baris penjaga `--to` (babak pertama) | tidak |
| `tests/unit/research/alMom01.test.js` | UNIT-MOM01-001…017 | tidak |
| `tests/unit/research/alMom01Diagnose.test.js` | **Baru.** UNIT-MOM01-018…022 | tidak |
| docs/28 (catatan status), docs/29, README, `package.json` | Audit ini, perintah `research:al-mom-01-diagnose` | — |

Paritas runner (babak pertama, VERIFIED):

- **UNIT-MOM01-002.** Kelayakan dan `prePos` setara `timingAt`/`forwardMove`/`atrTrade`.
- **UNIT-MOM01-003.** `collectMomData` asli pada cache sintetis: untuk 222 alert, kunci strata, hasil A/B, dan agregat
  pembanding sama persis.
- **Paritas diagnostik.**
  - UNIT-MOM01-022: dekomposisi diagnostik = simulasi coverage pada benih yang sama, termasuk batas CI.
  - Mode historis mereproduksi titik validasi runner: 3.864 alert cocok, A −0,006413.

## 5. Keseimbangan kovariat (SMD)

**Definisi** (VERIFIED, UNIT-MOM01-007; lengkapnya di docs/28 §9.1):

- **Rumus.** (rata-rata alert − rata-rata pembanding) ÷ SD alert sebelum pencocokan, dengan penyebut yang sama untuk
  sebelum dan sesudah pencocokan.
- **Pembanding sesudah pencocokan.** Rata-rata atas alert dari rata-rata pembanding strata-nya, setara dengan bobot
  pembanding = alert ÷ pembanding per strata.
- **Kategori.** SD alert = √(p(1 − p)).
- **Varians nol.** Bila SD alert 0, dipakai SD gabungan. Bila itu juga 0, SMD = 0 kalau selisihnya 0, selain itu "tak
  terdefinisi".
- **Ambang.** 0,10 dan 0,20.

**Hasil historis** (HISTORICAL; jendela semu 24 bulan [2024-10-01, 2026-09-28], 100 koin, 4.247 alert):

| Kovariat | Sebelum | Utama (strata + jarak) | Dasar | Bin 0,25 ATR | Lampau |
|---|---|---|---|---|---|
| Gerak awal | +1,46 | +0,005 | +0,004 | +0,003 | +0,006 |
| Posisi rentang | +1,43 | +0,063 | +0,068 | +0,069 | +0,075 |
| ATR% | −0,47 | −0,060 | −0,064 | −0,066 | −0,079 |
| Jarak (candle) | −0,70 | −0,013 | −0,198 | −0,014 | −0,824 |
| Jarak ≤ 12 (proporsi) | +0,49 | 0 | +0,099 | 0 | +0,844 |
| Jarak > 48 (proporsi) | −0,63 | 0 | −0,210 | 0 | −0,562 |

- **Pencocokan utama menyeimbangkan semua kovariat.** |SMD| ≤ 0,063, jadi sensitivitas bin 0,25 ATR **tidak dipicu**.
- **Tanpa jarak, kovariat jarak tidak seimbang.** Karena itu strata dasar dan pembanding lampau dibaca sebagai estimand
  yang berbeda (docs/28 §4).

## 6. Overlap dan gerak awal ≥ 4 ATR

HISTORICAL, jendela yang sama:

- **Cakupan.** 3.864 dari 4.247 alert cocok (91,0%) dan 383 tidak cocok. Dari yang tidak cocok, 64 tidak punya pembanding
  bahkan di strata dasar.
- **Gerak awal ≥ 4 ATR.** 599 alert. Dari jumlah itu, 448 (74,8%) tercakup estimand dan 151 (25,2%) tidak cocok.
  Kelompok ini 39,4% dari alert tak cocok, tetapi hanya 11,6% dari alert cocok.
- **Fallback strata dasar untuk alert tak cocok** (n 319): A −0,067 [−0,575 … +0,336]. Khusus ≥ 4 ATR (n 108): A −0,277
  [−1,22 … +0,57].
- **Tafsir.** Ini deskriptif, dan CI-nya terlalu lebar untuk tafsir apa pun. Ambang 4 ATR adalah diagnostik overlap.

## 7. Bootstrap prosedur penuh

**Perbandingan metode** (HISTORICAL; A, ATR; 10.000 replikasi, benih 20261116):

| Blok | Prosedur penuh | Populasi tetap | Himpunan sama | Alert saja |
|---|---|---|---|---|
| 7 hari (utama) | −0,006 [−0,137 … +0,092], SE 0,059 | SE 0,060 | SE 0,081 | SE 0,084 |
| 14 hari | [−0,133 … +0,100], SE 0,060 | SE 0,062 | SE 0,083 | SE 0,087 |
| harian | [−0,154 … +0,092], SE 0,063 | SE 0,062 | SE 0,076 | SE 0,077 |

- **Pengurangan SE berasal dari kovariasi, bukan dari perubahan komposisi overlap.** Untuk blok 7 hari, Var(alert saja)
  0,0070 turun ke Var(populasi tetap) 0,0036 ≈ Var(penuh) 0,0035. Kovarians alert ↔ pergeseran pembanding = 0,0027.
- **Diagnostik per replikasi** (7 hari):
  - Bobot alert yang kehilangan pembanding: median 5,9%, maks 10,4%.
  - Korelasi porsi hilang ↔ ATT: ≈ 0.
  - Tidak ada replikasi tidak valid.
- **Bentuk CI.** Batas atas = titik + 1,66 SE, batas bawah = titik − 2,20 SE; median bootstrap bergeser −0,28 SE. CI basic
  [−0,105 … +0,124] dan BC [−0,106 … +0,130] juga kelompok 3, jadi data ini tidak rapuh terhadap metode CI.
- **Presisi Monte Carlo** (10 benih × 10.000): SD batas bawah 0,0011, batas atas 0,0015.

## 8. Simulasi coverage

### 8.1 Rancangan

- **Data.** Pasar sintetis per jam: 40 simbol × 730 hari, ditambah 30 hari pemanasan. Komponennya:
  - faktor pasar bersama (β² = 0,5 pada skenario dasar);
  - rezim volatilitas pasar dan per simbol;
  - inovasi t (ν 5);
  - OHLC dengan sumbu acak.
- **Alert.** Alert v3 dan event v2 (v2 ≈ 5× v3) dibangkitkan dari hazard yang naik bersama gerak awal dan posisi rentang,
  saling memicu, dengan rezim alert bersama dan heterogenitas laju per simbol. Hazard hanya memakai candle ≤ t.
- **Efek yang diketahui.** Sesudah alert v3, jalur harga mendapat drift δ × ATR selama 12 candle. Jadi pembanding di dekat
  alert ikut membawa sebagian drift itu.
- **Dekomposisi.** Karena estimator linear terhadap hasil, estimasi = estimator(Δ) + estimator(y0), dengan Δ = drift
  (i, i+12] ÷ ATR_i dan y0 = komponen harga dasar.
  - θ_d = estimator(Δ) per dataset.
  - θ_info = rata-rata θ_d.
  - Skenario "efek 0,10 / 0,25" berarti δ dikalibrasi sampai θ_info ≈ 0,10 / 0,25.
  - Definisi target lain ada di §15.
- **Kode analisis.** Fungsi runner (hash `f3004d2c…`), tanpa salinan. Kurung siku = interval Wilson 95% (ketidakpastian
  Monte Carlo).

### 8.2 Hasil inti (A, prosedur penuh 7 hari, 1.000 simulasi per skenario)

| | Efek 0 | Efek +0,10 | Efek +0,25 |
|---|---|---|---|
| θ_info (SD θ_d) | 0 (0) | +0,100 (0,001) | +0,250 (0,003) |
| Rata-rata estimasi | −0,019 | +0,081 | +0,232 |
| Estimator(y0) ± SE MC | −0,019 ± 0,002 | −0,019 ± 0,002 | −0,019 ± 0,002 |
| SE empiris · rata-rata SE bootstrap (rasio) | 0,066 · 0,073 (1,11) | 0,066 · 0,073 (1,10) | 0,066 · 0,073 (1,10) |
| Coverage θ_info | 96,3% [94,9–97,3] | 94,9% [93,4–96,1] | 93,6% [91,9–95,0] |
| lo > 0 | **0,1%** [0,0–0,6] | 9,3% | 82,1% (daya) |
| hi < 0,25 | 98,3% (daya) | 77,3% | **6,1%** [4,8–7,8] |
| Replikasi tidak valid | 0 | 0 | 0 |

### 8.3 Komponen dasar: bias estimator, bukan sifat estimand (koreksi)

**Koreksi.** Babak pertama menulis bahwa −0,019 adalah "sifat estimand yang dikunci, bukan galat estimator". Itu keliru
menurut definisi estimand populasi.

- **Mengapa targetnya tepat 0 (VERIFIED, argumen).** Di DGP, harga dasar martingale: E[y0 | informasi ≤ t] = 0 untuk tiap
  candle. Strata, alert, dan status pembanding semuanya ditentukan informasi ≤ t. Maka rata-rata populasi y0 di setiap
  strata adalah 0, baik untuk alert maupun pembanding. Jadi estimand populasi komponen dasar tepat 0.
- **Konfirmasi oracle (SIMULATED, §15).** Rata-rata pembanding dari sampel independen memberi −0,001 ± 0,005 (δ 0,29) dan
  −0,000 ± 0,006 (δ 0).
- **Asal −0,02 di estimator** (300 simulasi, δ 0; benih 930001+):
  - Rata-rata y0 alert cocok: +0,011 ± 0,005. Ini seleksi overlap ex-post: alert yang punya pembanding cenderung diikuti
    kenaikan.
  - Rata-rata y0 pembanding strata (diboboti alert): +0,032 ± 0,004.
  - Selisihnya: −0,021 ± 0,004.
- **Mekanisme sisi pembanding (HISTORICAL + SIMULATED).** Pembanding 1–12 candle sebelum alert adalah 13–15% dari
  pembanding strata. Hasil A-nya +0,54 (historis) dan ±+0,50 (sintetis), karena jendela 12 candle-nya memuat gerak yang
  memicu alert. Bobotnya di estimator (banyaknya alert di strata itu) berkorelasi dengan hasil itu, sedangkan populasi
  tidak.
- **Menurut definisi prosedural** (pembanding terealisasi, docs/28), angka ini bagian dari ekspektasi prosedur. Menurut
  pertanyaan riset ("informasi di luar momentum"), ini bias yang merugikan SA/PVA. §15 memisahkan keduanya.

### 8.4 Bentuk CI dan galat satu sisi

| Efek | Geser median bootstrap | Batas atas − titik | Titik − batas bawah | Persentil: hi < θ_info · lo > θ_info | Basic | BC |
|---|---|---|---|---|---|---|
| 0 | −0,18 SE | 1,78 SE | 2,16 SE | 3,6% · 0,1% | 3,0% · 2,3% | 2,9% · 2,2% |
| +0,10 | −0,27 SE | 1,69 SE | 2,25 SE | 4,9% · 0,2% | 2,3% · 2,7% | 2,7% · 2,6% |
| +0,25 | −0,42 SE | 1,54 SE | 2,40 SE | 6,3% · 0,1% | 1,9% · 4,3% | 2,3% · 4,5% |

Data historis: geser −0,28 SE. Investigasi penyebabnya ada di §14.

### 8.5 Peluang keputusan per metode CI

Run independen 500 simulasi per skenario (benih 990001+, kode coverage `669c621f…`). Kolom kiri: superioritas palsu bila
θ = 0. Kolom kanan: "< M" palsu bila θ_info ≈ 0,25. Di sel lain angkanya = daya.

| Skenario | Persentil (beku): lo > 0 · hi < 0,25 | Basic | BC |
|---|---|---|---|
| dasar, efek 0 | **0,2%** [0,0–1,1] · 97,6% | **2,2%** [1,2–3,9] · 92,6% | **2,6%** [1,5–4,4] · 93,0% |
| dasar, θ_info +0,250 | 81,4% · **9,6%** [7,3–12,5] | 93,0% · **3,4%** [2,1–5,4] | 92,8% · **3,2%** [2,0–5,1] |
| episode tren, θ_info +0,251 | 81,0% · **6,0%** [4,2–8,4] | 94,4% · **2,2%** [1,2–3,9] | 94,4% · **2,4%** [1,4–4,1] |

- **Replikasi independen.** Run inti (1.000 simulasi, benih lain) memberi "< M" palsu persentil 6,1% [4,8–7,8] dan basic
  1,9%. Gabungan tiga run dasar efek 0,25 (1.800 simulasi): persentil 7,6%, basic 2,3%.
- **Daya superioritas** pada θ_info 0,25: persentil 81–82%, basic/BC 93–94%.

### 8.6 Skenario stres (500 simulasi per skenario)

Benih 950001+. Run dimulai 2026-11-15 22:32 UTC, laporan `al-mom-01-coverage-20261115T223209Z`.

- **Versi kode.** Pekerja skenario pertama memuat versi `e3f7afdc…`, skenario sesudahnya `669c621f…`. Fungsi simulasi
  per dataset kedua versi identik; yang berbeda hanya agregasi di proses utama, yang tetap versi lama.
- **Asal kolom basic/BC.** Diturunkan dari galat satu sisi terhadap θ_info, yang tepat 0 pada skenario efek 0.

| Skenario | Bias (estimator − θ_d) ± SE MC | SE boot ÷ empiris | Geser median | Coverage θ_info: persentil · basic · BC | Superioritas palsu (lo > 0): persentil · basic · BC | "< M" palsu (hi < θ_info): persentil · basic · BC |
|---|---|---|---|---|---|---|
| korelasi tinggi (β² 0,85) | −0,027 ± 0,003 | 1,08 | −0,17 | 94,4 · 94,4 · 94,8 | 0,0 · 1,0 · 0,8% | — |
| serial (efek per rezim, rata-rata +0,11) | −0,025 ± 0,003 | **0,67** | −0,24 | **76,8 · 74,6 · 75,6** | — | — |
| alert sangat tak merata | +0,002 ± 0,004 | 0,94 | −0,11 | 96,2 · 91,4 · 91,2 | 1,0 · **4,8** [3,2–7,0] · **4,6**% | — |
| strata sedikit | −0,030 ± 0,003 | 1,03 | −0,25 | 90,6 · 95,0 · 95,0 | 0,2 · 1,6 · 1,4% | — |
| ekor tebal + lompatan | −0,024 ± 0,003 | 1,02 | −0,15 | 93,8 · 92,0 · 92,2 | 0,8 · 2,2 · 2,0% | — |
| momentum pasar | −0,020 ± 0,003 | 1,11 | −0,20 | 96,4 · 94,2 · 94,2 | 0,0 · 2,8 · 2,8% | — |
| episode tren per simbol | −0,018 ± 0,003 | 1,05 | −0,19 | 94,2 · 93,2 · 93,0 | 0,2 · **3,4** [2,1–5,4] · 3,4% | — |
| episode tren, θ_info +0,25 | −0,019 ± 0,003 | 1,07 | −0,43 | 93,0 · 94,4 · 94,0 | — | **6,8** · 1,0 · 1,4% |
| stres gabungan, θ_info +0,26 | −0,005 ± 0,007 | **0,76** | −0,30 | **87,2 · 82,2 · 82,6** | — | **12,4** · 9,0 · 9,4% |

- **Replikasi tidak valid:** 0 di semua skenario. Alert cocok 81–89%.
- **Serial.** Coverage target bersyarat θ_d = 96,6% (persentil), padahal coverage rata-rata jangka panjang hanya 76,8%. SD
  θ_d antar-simulasi 0,096. CI-nya sah untuk jendela terealisasi, tetapi tidak mencakup rezim lain (§15).
- **Stres gabungan.** Coverage θ_d 92,0%. SE bootstrap 9% terlalu kecil terhadap SD (estimasi − θ_d), dan 24% terhadap SD
  total.
- **Pola umum.**
  - Persentil tidak pernah melampaui 1,0% superioritas palsu.
  - Basic/BC melampaui nominal 2,5% pada alert sangat tak merata (CI Monte Carlo tidak memuat 2,5%) dan cenderung di atas
    nominal pada episode tren dan momentum.
  - Di sisi "< M", basic/BC 1,0–3,4% di luar stres gabungan; persentil 6,0–12,4%.

## 9. Daya uji

1. **Daya model historis (HISTORICAL).** Model normal, SE prosedur penuh 0,0594: batas atas pada M 0,25 dengan efek 0
   98,8%; MDE superioritas 0,166. Ini model, bukan kalibrasi.
2. **Daya berdasarkan simulasi (SIMULATED).** Dengan CI persentil yang dikunci:
   - **Batas atas:** P(hi < 0,25 | θ = 0) = 97,6–98,3%.
   - **Superioritas:** P(lo > 0 | θ_info = 0,25) = 81–82%. **Klaim MDE 0,18 di docs/27 tidak bertahan; MDE efektif ±0,25
     ATR pada skala θ_info.** Dengan basic/BC: 93–94%.
   - **Pada skala estimand populasi,** 0,25 prosedural ≈ 0,30 populasi (§15), jadi MDE populasinya ±0,30.
3. **Daya prospektif: belum diketahui (UNVERIFIED).**
   - Dengan 100 simbol aktif penuh, simulasi memberi SE ±0,04 (§16) dan daya superioritas persentil 99% pada θ_info 0,25.
   - Bias estimator di bawah H0 tetap ±0,02 ATR, jadi dalam satuan SE menjadi lebih besar (±0,5 SE).

## 10. Status pembekuan: ditunda

- **Hash kandidat pohon kode AL-MOM-01.** `f3004d2c3f32d9df3924f5f266505268e6fd49da3d41441393ce758de8fe5c28` (145 file:
  `backend/` + runner), tidak berubah di babak lanjutan.
  - Hash ini **belum** dicatat sebagai baris beku di docs/28 §9.1, jadi `--mode evaluate` menolak berjalan.
  - Semua run dokumen ini memakai pohon dengan hash ini.
- **Hash AL-SA-ATR-01.** Tetap `25c022560e99565ecc3de0f62872d5116da756caf89984c589bcd74ac2f8b314`.
- **SHA-256 file** (versi di commit babak lanjutan):

  | File | SHA-256 |
  |---|---|
  | `scripts/research-al-mom-01.js` | `25af1b6db48d2e02c5c0be711b78e23e27c11066492439ba1beaa3b2be53af92` (tidak berubah) |
  | `scripts/research-al-mom-01-coverage.js` | `15a6d006ed1c4cf5a0f750be62e5f48ab85c51a839ca1232a3b15d77a2c0fe3e` (run kekuatan pasangan §16). Run sebelumnya: `e3f7afdc…`/`669c621f…` (§8.6), dengan fungsi simulasi per dataset identik |
  | `scripts/research-al-mom-01-diagnose.js` | `9a36f8b6bf9d9c575db975c8640c45244c661c32f7437ae125f68ee4968b981b`. Run diagnostik memakai versi antara; fungsi yang dipakai tiap run tidak berubah sesudahnya, hanya ada tambahan mode dan kolom |
  | `tests/unit/research/alMom01.test.js` | `94ada32cd106c7e88d7ab3f193ff043282f03a0425e9f5311e16b4c111de995c` |
  | `tests/unit/research/alMom01Diagnose.test.js` | `42326ecf4b057db410b232394d9dc30d0fbd2aa421608e82f493bb77a7fab3ac` |
  | `scripts/research-window-guard.js` | `c139430518f5844535eaee34218e947bc242ad6e80138ebf15adab7a1bf52dba` |

- **Rincian bootstrap** (draf §9.1): 10.000 replikasi, benih `20261116`, blok 7 hari; replikasi tidak valid dikeluarkan dan
  dihitung, dan bila > 1% → kelompok 4.
- **Commit pembekuan.** Belum ada.

## 11. Tes otomatis

| Jenis | Hasil |
|---|---|
| Lint (`npm run lint`) | bersih |
| Vitest (`npx vitest run`) | 159 file; 2.381 lulus, 1 dilewati |
| Tes AL-MOM-01 | UNIT-MOM01-001…022, semuanya lulus |
| Playwright | 148/148 di babak pertama; babak lanjutan tidak menyentuh UI |
| Integrasi | Validasi historis runner (2×), diagnostik historis (2×, paritas titik runner), simulasi end-to-end |

Tes baru (UNIT-MOM01-018…022):

- **018.** Probe bootstrap dengan aliran bobot tunggal = `runBootstrap` runner pada benih yang sama. Bobot terpisah
  memutus kovarians; ada juga tes `shiftStats`.
- **019.** Struktur strata: jumlah, hari, porsi posisi, dan kontribusi pembanding yang berjumlah tepat rata-rata strata.
- **020.** Korelasi, korelasi antarsimbol dari jumlah terstandar, dan ACF.
- **021.** Oracle leave-one-out, termasuk alert tak cocok di draw sendiri.
- **022.** Dekomposisi diagnostik = simulasi coverage pada benih yang sama. Mode historis menolak `--to` > 2026-11-16
  sebelum I/O apa pun.

Yang tidak dijalankan: mode count/evaluate pada data jendela, dan panggilan jaringan Binance.

**Babak ketiga.** Lint bersih. Vitest: 161 file, 2.391 lulus, 1 dilewati. Tes baru:

- **UNIT-BTCLI-004…006 dan 022.** Periode terlindungi `backtest`:
  - pemotongan `--to` bawaan;
  - penolakan `--to`/`--from` sesudah 2026-11-16;
  - cutoff CSV;
  - konfirmasi hanya di TTY di luar CI;
  - pertahanan lapis kedua.
- **UNIT-SNAP-001.** Snapshot: hanya bulan < 2026-11, baca-saja, hanya bertambah, dan isi yang berubah ditolak.
- **UNIT-MOM01-023…025.** Evaluasi konfirmasi: batas atas gabungan, T2 antar-konfigurasi, kriteria K1–K3, vonis, dan
  pencocokan δ oracle.
- **UNIT-MOM01-026…027.** Rezim padat di DGP (`stressEnter` 0 = DGP lama), dan korelasi subset yang dinormalisasi.

## 12. Risiko metodologis yang tersisa

1. **Estimand teratenuasi terhadap pertanyaan riset (SIMULATED, §15).** Di DGP, estimand prosedural ≈ 75% estimand
   populasi pada efek 0,3. Besarnya di data nyata tidak diketahui, karena bergantung pada berapa banyak pembanding di dekat
   alert yang membawa informasi alert itu.
2. **Bias di bawah H0 bergantung pada mekanisme alert (SIMULATED).** Di semua DGP realistis bias ini negatif (−0,018 sampai
   −0,030). Ada satu pengecualian: pada DGP buatan dengan alert serentak sangat kuat dengan pasar (§16, `marketKappa` ≥ 2,
   tidak realistis), biasnya positif (+0,08 sampai +0,20). Jadi tanda bias tidak dijamin oleh desain.
3. **SE bootstrap terlalu kecil** bila efek berubah per rezim (rasio 0,67) atau pada stres gabungan (0,76–0,91). CI
   berlaku untuk jendela terealisasi.
4. **Kalibrasi DGP parsial (§16).** Rasio SE historis 0,71 baru dapat ditiru dengan korelasi antarsimbol yang terlalu tinggi
   (0,71 vs 0,40), dan komposisi variansnya berbeda.
5. **Galat satu sisi CI** (§17): persentil di sisi "< M", basic/BC di sisi superioritas pada alert tak merata.
6. **Akses data di luar runner** (§19): CLI `backtest`, dua skrip terkunci docs/25, dan UI produk yang menampilkan status
   sinyal live.
7. **Label trade di replay.** Mode count menghitung label trade SA/PVA secara internal lalu membuangnya. Ini tidak bisa
   dihindari tanpa mengubah backend beku.
8. **Definisi alert = trade v3.** Event yang gagal menjadi trade tidak terlihat dari luar backend.
9. **Integritas data** bergantung pada exchangeInfo dan daftar delisting manual.
10. **Strata ex-post.** Tersil ATR% dan keberadaan pembanding ditentukan atas seluruh kuartal, dan inilah salah satu jalur
    bias §8.3.
11. **Batas simulasi.** Alert berasal dari model hazard, bukan replay SA/PVA; DGP disederhanakan.
12. **Tepi MBB.** 6 hari pertama dan terakhir sedikit kurang terwakili.

## 13. Registri run babak lanjutan

Semua run memakai pohon `f3004d2c…`. Laporan JSON ada di `reports/research/` (di-gitignore). Benih tercatat di tiap JSON.

| Run | Isi | Simulasi × replikasi | Benih | Laporan |
|---|---|---|---|---|
| Stres | 9 skenario §8.6 | 500 × 999 | 950001+ (pilot 500000+) | `al-mom-01-coverage-20261115T223209Z` |
| Keputusan | dasar0, dasar025, episode025 | 500 × 999 | 990001+ | `al-mom-01-coverage-20261115T224258Z` |
| Diagnostik sim | dasar0 / dasar025 (δ 0,2946) | 300 × 999 | 930001+ / 931001+ | `al-mom-01-diag-sim-dasar0-*`, `-dasar025-*` |
| Oracle | dasar025 (8 konfigurasi × 40 draw) / dasar0 (6 × 40) | — | rezim 950101+ / 951101+; inovasi 7.000.000 + 1.000c + k | `al-mom-01-diag-oracle-*` |
| Landmark | dasar0 / dasar025 | 200 | 940001+ / 941001+ | `al-mom-01-diag-landmark-*` |
| Level pembanding | dasar0 / dasar025, titik per level docs/28 §4 | 60 | 980001+ / 981001+ | `al-mom-01-diag-levels-*` |
| Historis | ciri 100 koin, 2024-10-01 … 2026-10-01; v2 + SD & kelayakan landmark | — | — | `al-mom-01-diag-historical-*` |
| Pindai | β² 0,42 × `marketKappa` 0–3; 100 simbol × β² 0,42/0,6/0,75 | 16 × 199 | 960001+, 963001+ | `al-mom-01-diag-sim-scan-*` |
| Kekuatan pasangan | 100 simbol, β² 0,5 dan 0,75; efek 0 dan θ_info 0,25; blok 7 hari | 400 × 999 | 970001+ (pilot 500000+) | `al-mom-01-coverage-20261116T001522Z` |
| Historis v3 (babak ketiga) | ciri rezim 100 koin (2024-10-01 … 2026-10-01), dibaca dari snapshot | — | — | `al-mom-01-diag-historical-v3-rezim-20261116T063644Z` |
| Ciri DGP (babak ketiga) | `describe` tanpa bootstrap: dasar0, pasangan084, kandidat rezim (histA, hipA, histB, hist40), rezimHistoris100, rezimPadat100, takMerata100 | 12–16 | 1090001+ / 1090101+ | `al-mom-01-diag-describe-*` |

Kegagalan selama babak ini:

- **Pekerja diagnostik pertama bertabrakan dengan penangan pekerja modul coverage** (kunci `workerData.batch` sama), dan
  hasilnya tercampur. Kuncinya diganti, lalu semua run diagnostik diulang dari awal.
- **Hipotesis yang gugur:** lonjakan volatilitas sesudah alert dan alert yang serentak dengan pasar (§16).
- **Uji kecil awal** (8 simbol, 3 simulasi) memberi kesan dua seleksi besar saling meniadakan (+0,43 vs +0,43). Pada 300
  simulasi itu hanya derau: +0,011 vs +0,032.

## 14. Asimetri CI persentil: investigasi

Diagnostik 300 simulasi per skenario. Pergeseran = median replikasi − titik, dalam SE replikasi; dalam kurung, rata-rata
replikasi − titik dalam ATR.

| Varian bootstrap | Efek 0 | δ 0,2946 (θ_info 0,25) |
|---|---|---|
| Prosedur penuh (utama) | −0,173 SE (−0,013) | −0,403 SE (−0,029) |
| … komponen dasar y0 | −0,173 SE (−0,013) | −0,177 SE (−0,013) |
| … komponen drift Δ | — | (−0,0165) |
| Populasi tetap (rata-rata pembanding diboboti ulang) | −0,196 SE (−0,014) | −0,385 SE (−0,027) |
| Himpunan sama (rata-rata pembanding tetap) | +0,023 SE (+0,001) | −0,025 SE (−0,002) |
| Alert saja | −0,002 SE (−0,001) | −0,016 SE (−0,002) |
| Probe: bobot alert dan pembanding dari aliran acak terpisah | **+0,278 SE (+0,031)** | **+0,329 SE (+0,036)** |
| Blok harian · 7 · 14 hari | −0,12 · −0,17 · −0,15 | −0,36 · −0,40 · −0,37 |

Untuk tiap sumber yang diminta:

1. **Resampling blok kalender.** Pergeseran ada di semua panjang blok, termasuk harian. Jadi bukan efek panjang blok.
2. **Penggandaan alert dan pembanding dalam blok yang sama: penyebab utama.**
   - Pergeseran hanya muncul bila rata-rata pembanding diboboti ulang dengan bobot hari yang sama dengan alert (penuh ≈
     populasi tetap). Alert saja dan himpunan sama ≈ 0.
   - Bila bobotnya diputus, tandanya berbalik (+0,28 SE), menjadi bias rasio rata-rata pembanding.
   - Mekanismenya: hari alert yang terambil k kali ikut menggandakan pembanding di sekitarnya yang hasilnya mirip alert,
     yaitu gerak pemicu dan drift alert itu sendiri.
3. **Pembanding dekat sebelum alert.** Ini sumber pergeseran komponen dasar, karena hasilnya memuat gerak pemicu (§8.3).
   Komponen drift datang dari pembanding sesudah alert.
4. **Korelasi serial.** Skenario serial: geser −0,24. Masalah utamanya SE yang terlalu kecil, bukan pergeseran.
5. **Korelasi antarsimbol.** β² 0,85 pada 40 simbol: geser −0,17, sama dengan dasar. Pada 100 simbol (§16): −0,28 sampai
   −0,30 SE pada efek 0, dan −0,63 sampai −0,66 SE pada θ_info 0,25. Dalam ATR pergeserannya mirip, tetapi SE-nya lebih
   kecil (0,04).
6. **Perubahan komposisi strata** dan **7. perubahan overlap.** Populasi tetap (overlap dibekukan) bergeser sama dengan
   prosedur penuh. Historis: porsi bobot yang hilang per replikasi tidak berkorelasi dengan ATT.
8. **Bias estimator, bias distribusi bootstrap, dan bias definisi estimand** adalah tiga besaran berbeda:

   | Besaran | Efek 0 | δ 0,2946 |
   |---|---|---|
   | Bias estimator terhadap estimand populasi (oracle) | −0,027 ± 0,003 (seluruhnya komponen dasar) | −0,076 = −0,027 (dasar) − 0,050 (drift) |
   | Bias distribusi bootstrap, E*[θ*] − θ̂ | −0,013 | −0,029 = −0,013 − 0,0165 |
   | Porsi bias estimator yang direproduksi bootstrap | 49% | 38% (dasar 49%, drift 33%) |
   | Selisih estimand prosedural vs populasi (definisi) | −0,021 | −0,072 |

   - **Pergeseran bootstrap juga bergantung pada θ̂.** Korelasi (median − titik) dengan titik = −0,34 (efek 0) dan −0,28
     (δ 0,29).
   - **Distribusi θ̂ antar-simulasi sedikit menceng kiri** (skew −0,26).
   - **Akibatnya, CI basic tidak sekadar "persentil yang dikoreksi".** Pada dataset dengan θ̂ rendah, basic justru
     melenceng di sisi atas: hi < 0 sebesar 4,0–4,3%, padahal pendekatan normal memperkirakan 1,4%.

**Kesimpulan.** Asimetri CI persentil = pergeseran distribusi bootstrap (dari penggandaan alert bersama pembanding yang
hasilnya mirip alert), ditambah bias estimator yang searah.

- Persentil mewarisi pergeseran itu dengan tanda yang memperparah bias.
- Basic membaliknya, sehingga mengoreksi sebagian bias (±40%), tetapi tidak tepat. Arah koreksinya benar terhadap estimand
  populasi, tetapi berlebihan terhadap estimand prosedural (§15).

## 15. Target inferensi dan coverage

**Lima target yang berbeda** (DGP dasar, δ 0,2946; SIMULATED):

| Target | Definisi | Nilai | Dipakai untuk |
|---|---|---|---|
| T1 Efek kausal yang disisipkan | Drift informasi alert itu sendiri atas 12 candle-nya | δ = 0,2946 | parameter DGP |
| T2 Estimand populasi overlap | E[y alert − rata-rata populasi pembanding strata], dengan rata-rata pembanding dari sampel independen (oracle leave-one-out, lapisan rezim sama). Overlap praktis semua alert (99,9%) | **0,300** (dasar −0,001 ± 0,005; drift 0,2996) | pertanyaan riset: informasi di luar momentum |
| T3 θ_info | Ekspektasi estimator docs/28 pada komponen drift | 0,2505 | babak pertama |
| T4 Ekspektasi prosedur | E[θ̂], termasuk bias komponen dasar | 0,228 | estimand prosedural docs/28 |
| T5 θ_d | Komponen drift estimator pada dataset itu (bersyarat sampel) | SD antar-simulasi 0,0035 | coverage bersyarat |

- **Hubungan efek drift dengan ATT.** T2 ≈ T1 + 0,005. Jendela alert ikut memuat drift alert lain di klasternya (+0,04),
  sementara pembanding populasi membawa kontaminasi acak ±0,035.
- **Estimator docs/28 memberi ±75% dari T2.** Sebabnya kontaminasi diri: pembanding sesudah alert di strata yang sama
  membawa drift alert itu sendiri, padahal di sampel independen tidak. Ditambah gerak pemicu.
- **Apakah kebenaran berubah karena pembentukan alert atau pencocokan?** Ya:
  - T3/T4 bergantung pada konfigurasi alert terealisasi.
  - T5 berubah antar-simulasi. SD-nya kecil di DGP dasar (0,05 SE), tetapi besar bila efek berubah per rezim (0,096,
    skenario serial) atau pada stres gabungan (0,076).
- **Galat satu sisi pada margin, per definisi target** (gabungan 800 simulasi dasar δ 0,2946; run keputusan + diagnostik):

  | Target | Persentil: hi < θ · lo > θ | Basic | BC |
  |---|---|---|---|
  | T2 populasi 0,300 | **24,9%** [22,0–28,0] · 0,0% | **9,2%** [7,4–11,5] · 0,6% | **10,1%** · 0,5% |
  | T1 δ 0,2946 | 23,1% · 0,0% | 8,8% · 0,8% | 9,4% · 0,6% |
  | T3 θ_info 0,2505 | **9,2%** [7,4–11,5] · 0,1% | **2,9%** [1,9–4,3] · 2,8% | 2,9% · 2,6% |
  | T4 prosedur 0,228 | 5,5% · 0,1% | 0,8% · **6,5%** | 1,0% · 6,2% |

- **Pada H0** (efek 0), T1 = T2 = 0 tepat, dan T4 = −0,021. Superioritas palsu terhadap 0: persentil 0,1–0,2%, basic
  2,2–2,3%, BC 2,2–2,6%.
- **Estimand per level pembanding yang sudah dikunci** (docs/28 §4; 60 simulasi per efek, benih 980001+/981001+, titik saja):

  | Level | Efek 0: titik (dasar) | δ 0,2946: titik | komponen drift | komponen dasar | Alert cocok |
  |---|---|---|---|---|---|
  | utama (strata + jarak) | −0,023 ± 0,009 | 0,224 ± 0,008 | 0,250 | −0,026 | 89% |
  | dasar (tanpa jarak) | −0,029 ± 0,008 | 0,256 ± 0,008 | 0,285 | −0,029 | 99% |
  | halus (bin 0,25 ATR) | −0,027 ± 0,010 | 0,224 ± 0,009 | 0,253 | −0,029 | 77% |
  | **lampau** (candle ≤ 12 sesudah event dikeluarkan) | −0,022 ± 0,010 | **0,290 ± 0,009** | **0,315** | −0,025 | 96% |

  - **Lampau menghapus kontaminasi diri, karena pembanding sesudah alert tidak ikut.** Titiknya hampir sama dengan estimand
    populasi T2 (0,300). Gerak pemicu tetap ada (komponen dasar −0,025).
  - **Lampau sudah dihitung sebagai sensitivitas di desain yang dikunci,** jadi tidak perlu analisis baru. Kelemahannya
    jarak tidak seimbang di data nyata (SMD −0,82, §5). Di DGP itu tidak berpengaruh, karena jarak hanya memengaruhi
    hazard, bukan hasil.
- **Konsekuensinya.**
  - **Klaim superioritas** tidak bergantung pada definisi target: nolnya sama, dan estimator bias ke bawah. Galatnya
    terkendali untuk ketiga metode di DGP dasar.
  - **Bacaan "< 0,25"** sepenuhnya bergantung pada definisi.
    - Terhadap pertanyaan riset (T2), semua metode keliru 9–25%.
    - Terhadap skala prosedural (T3/T4), basic dan BC ≤ 3%, sedangkan persentil 5,5–9,2%.
  - **Bila efek berubah per rezim,** CI berlaku untuk T5, yaitu jendela 2026–2028, bukan rata-rata rezim jangka panjang
    (coverage T5 96,6% vs T3 76,8%).

## 16. Kekuatan pasangan dan kalibrasi DGP

**Ciri data historis vs DGP** (HISTORICAL: 100 koin, 2024-10-01 … 2026-09-28; SIMULATED: 300 simulasi dasar, 16 untuk
pindai):

| Ciri | Historis | DGP dasar (40 simbol) | 100 simbol β² 0,42 | 100 simbol β² 0,6 | 100 simbol β² 0,75 |
|---|---|---|---|---|---|
| Korelasi antarsimbol 1 jam | 0,40 | 0,47 | 0,40 | 0,57 | 0,71 |
| Autokorelasi blok 12 jam · VR48 | −0,019 · 0,94 | −0,002 · 1,00 | −0,004 · 1,00 | −0,005 · 1,00 | −0,006 · 1,00 |
| Alert per simbol-tahun | 21,5 | 24,3 | 24,6 | 24,5 | 24,4 |
| Dispersi alert harian (var/mean) | 6,5 | 2,7 | 4,5 | 5,5 | 6,3 |
| Alert cocok | 91,0% | 88,6% | 88,6% | 88,4% | 88,7% |
| Pembanding per strata (rata-rata) · hari | 5,7 · 3,6 | 5,5 · 3,4 | 5,5 | 5,5 | 5,5 |
| Porsi pembanding hari sama · tumpang tindih · 1–12 sebelum | 19 · 21 · 13% | 21 · 23 · 15% | 21 · — · 15% | 21 · — · 15% | 22 · — · 16% |
| Korelasi y alert ↔ pembanding hari sama | 0,84 | 0,76 | 0,76 | 0,76 | 0,76 |
| SD hasil alert · pembanding | 2,90 · 2,78 | 2,57 · 2,56 | — | — | — |
| Alert ≥ 4 ATR | 14% | 18% | — | — | — |
| **SE penuh ÷ alert saja** | **0,71** | 0,94 | 0,88 | 0,79 | **0,71** |
| Geser median bootstrap | −0,28 | −0,17 | −0,23 | −0,22 | −0,29 |
| Var per alert: alert saja · pembanding · kovarians | 27 · 7,9 · 10,5 | 10,5 · 9,5 · 5,3 | 11,8 · 13,6 · 8,1 | 15,7 · 17,9 · 11,9 | 19,4 · 20,9 · 15,3 |

- **Struktur strata DGP sudah mirip data nyata.** Jumlah pembanding, hari, porsi pembanding di dekat alert, dan korelasi
  pasangan per alert hampir sama.
- **Pembeda utamanya jumlah alert per blok.**
  - Data nyata: 100 simbol, ±37 alert/minggu. DGP dasar: 40 simbol, ±16.
  - Komponen pasar bersama tidak menghilang bila rata-rata atas lebih banyak simbol, sedangkan bagian idiosinkratik makin
    kecil.
  - Pasangan alert–pembanding menghapus komponen bersama itu, jadi rasio turun bersama jumlah simbol.
- **Hipotesis yang gugur.**
  - **Lonjakan volatilitas sesudah alert.** SD hasil alert historis hanya 4% di atas pembanding.
  - **Alert serentak dengan pasar** (`marketKappa`).
    - Dispersi melonjak ke 33–143 dan laju alert dua kali lipat.
    - Rasio tidak turun (0,93–1,00).
    - Di bawah H0 bias estimatornya **positif** (+0,08 / +0,20 pada `marketKappa` 2 / 3).
- **Tiga tingkat pasangan.**
  - Lemah: DGP dasar, rasio 0,94.
  - Sedang: 100 simbol, β² 0,5, rasio **0,82**.
  - Kuat: 100 simbol, β² 0,75, rasio **0,73**. Tingkat ini meniru rasio, dispersi alert, dan geser bootstrap historis.
  - **Kalibrasinya parsial.** Korelasi antarsimbol terlalu tinggi (0,71 vs 0,40), dan komposisi variansnya berbeda:
    pembanding ÷ alert 1,1 vs 0,3. Data nyata kemungkinan punya korelasi yang naik justru pada periode padat alert. DGP
    ini tidak memodelkannya.
- **Hasil per tingkat** (400 simulasi per skenario, benih 970001+; lemah = run keputusan 500 simulasi):

  | Tingkat (rasio) | SE emp · boot (rasio) | Bias ± SE MC | Geser (efek 0 · 0,25) | Superioritas palsu: persentil · basic · BC | "< M" palsu (θ_info): persentil · basic · BC · gabungan | Daya superioritas (θ_info 0,25): persentil · basic |
  |---|---|---|---|---|---|---|
  | lemah (0,94) | 0,070 · 0,074 (1,05) | −0,021 ± 0,003 | −0,18 · −0,41 | 0,2 · 2,2 · 2,6% | 9,6 · 3,4 · 3,2 · 3,4% | 81% · 93% |
  | sedang (0,82) | 0,041 · 0,048 (1,17) | −0,020 ± 0,002 | −0,30 · −0,66 | 0,0 · 1,5 [0,7–3,2] · 1,5% | **13,0** [10,1–16,7] · **0,5** · 0,8 · 0,5% | 99,8% · 100% |
  | kuat (0,73) | 0,043 · 0,049 (1,13) | −0,022 ± 0,002 | −0,28 · −0,63 | 0,0 · 1,8 [0,9–3,6] · 2,0% | **15,0** [11,8–18,8] · **2,2** · 2,5 · 2,2% | 99,0% · 100% |

  - **Pada skala 100 simbol**, SE mengecil menjadi 0,04, sedangkan bias estimator dalam ATR tetap (−0,02). Bias dan
    pergeseran bootstrap jadi lebih besar dalam satuan SE.
    - Persentil makin buruk di sisi "< M": 13–15%.
    - Basic dan BC tetap dalam nominal di kedua sisi pada DGP ini.
    - Daya superioritas persentil 99%, jadi konservatismenya hampir tanpa ongkos.
  - **Terhadap efek kausal δ** (≈ estimand populasi; oracle hanya dijalankan pada 40 simbol), "< M" palsu menjadi:
    persentil 51,7% / 51,5%, basic 9,2% / 9,8%, BC 12,5% / 14,2%.
- **Biaya komputasi.** Per simulasi 100 simbol, blok 7 hari saja: ±6,5 detik-pekerja. Tiap skenario 400 simulasi ±11 menit
  dengan 4 pekerja; run empat skenario 2.822 s. Mengulang 9 skenario stres pada 100 simbol (500 simulasi, satu panjang
  blok) ±1,5 jam; dengan tiga panjang blok, ±3–4 jam.

## 17. Perbandingan metode CI

Semua metode memakai replikasi, data, benih, dan prosedur pencocokan yang sama. Basic dan BC dihitung dari replikasi yang
sama dengan persentil, jadi biaya tambahannya nol.

| Kriteria (urutan prioritas) | Persentil (beku) | Basic | BC |
|---|---|---|---|
| 1a. Galat superioritas pada H0 | **0,0–1,0%** di 10 DGP | 1,0–**4,8%**; > nominal pada alert tak merata, cenderung di atas pada episode/momentum | 0,8–**4,6%**, pola sama |
| 1b. Galat "< M" di margin (target prosedural θ_info) | **6,0–9,6%** pada 40 simbol, **13–15%** pada 100 simbol (12,4% stres gabungan) | **0,5–3,4%** (9,0%) | 0,8–3,4% (9,4%) |
| 1b'. Sama, terhadap estimand populasi (T2) | 24,9% | 9,2% | 10,1% |
| 2. Coverage sesuai target | 90–96% (θ_info, DGP non-stres); tidak simetris | 91–95%; lebih simetris terhadap θ_info, tidak simetris terhadap prosedur | ≈ basic |
| 3. Stabilitas antar-DGP | sisi superioritas sangat stabil; sisi "< M" tidak | sisi "< M" stabil; sisi superioritas tidak | ≈ basic |
| 4. Ketahanan pada korelasi & overlap | sama (masalah SE serial/stres berlaku untuk semua) | sama | sama |
| 5. Reprodusibilitas | benih tetap; SD batas MC 0,001 | sama (kuantil sama) | + derau estimasi z0 (kecil untuk 10.000 replikasi) |
| 6. Kompleksitas komputasi | nol tambahan | nol | nol |
| 7. Daya superioritas (θ_info 0,25) | 81–82% | 93–94% | 93–94% |
| Pada 100 simbol, pasangan sedang/kuat (§16) | superioritas 0,0%; **"< M" 13–15%**; daya 99% | superioritas 1,5–1,8%; "< M" 0,5–2,2% | 1,5–2,0%; 0,8–2,5% |

- **Studentized CI: hanya kelayakan.**
  - **Bootstrap bersarang.** Misalnya 999 × 200 replikasi per dataset menaikkan biaya simulasi ±200× (berhari-hari untuk
    validasi yang setara). Untuk evaluasi tunggal (10.000 × 200) biayanya beberapa menit, jadi layak, tetapi tanpa bukti
    kalibrasi.
  - **Varian murah.** Studentisasi dengan SE berbasis fungsi pengaruh per blok hari perlu estimator varians yang menangani
    ketergantungan blok, dan itu sendiri harus divalidasi.
  - **Studentisasi tidak menghapus bias estimator §15.** Ia hanya memperbaiki skala dan kemencengan.
  - **Kesimpulan:** tidak dimasukkan ke usulan mana pun tanpa simulasi sendiri.
- **Jawaban atas pertanyaan.**
  1. **Apakah persentil masih layak sebagai penentu formal AL-MOM-01?** Ya untuk klaim superioritas: itulah satu-satunya
     metode yang galatnya terkendali di semua DGP. Tidak untuk bacaan "< M" tanpa pendamping.
  2. **Apakah basic konsisten lebih terkalibrasi?** Tidak. Ia lebih baik di sisi "< M" pada semua definisi target, tetapi
     lebih buruk di sisi superioritas pada alert tak merata.
  3. **Apakah BC lebih baik daripada basic?** Tidak ada keuntungan nyata. Perbedaannya dalam derau Monte Carlo di semua
     skenario, dan BC bergantung pada estimasi z0.
  4. **Apakah perbedaannya cukup kuat untuk protokol baru?** Tidak untuk mengganti persentil dengan basic: masalahnya
     berpindah sisi.
  5. **Perlukah simulasi tambahan?** Untuk usulan §20 butir 1, cukup dengan data yang ada. Simulasi berikut dianjurkan
     sebelum beku, bukan syarat:
     - aturan gabungan (persentil untuk lo, maks(persentil, basic) untuk hi) pada 9 skenario stres dengan agregator baru;
     - alert tak merata pada 100 simbol.

## 18. Komponen waktu dan diagnostik landmark

- **Estimand utama tetap** (docs/28 §2–§4).
- **Deskriptif** (HISTORICAL + SIMULATED, §8.3). Ya, pembanding 1–12 candle sebelum alert menangkap momentum pemicu:
  - porsinya 13% (historis) dan 15% (sintetis) dari pembanding strata;
  - hasil A-nya +0,54 / ±+0,50 ATR;
  - pembanding sesudah alert +0,007 (historis), pembanding lain +0,13 (historis; momentum kelanjutan pada keadaan gerak
    awal tinggi).
- **Diagnostik usulan: landmark waktu keputusan lintas simbol.** Untuk alert simbol X pada jam t, pembandingnya adalah
  candle "tanpa" milik simbol **lain** pada **jam yang sama** t dengan sel fitur yang sama: gerak awal bin 1 ATR, posisi
  0,2, jarak 3 bin. Fiturnya sama dengan strata utama, tanpa simbol, kuartal, dan tersil ATR%.
  - **Syarat ChatGPT terpenuhi.**
    - Keanggotaan sel dan keberadaan pembanding hanya ditentukan informasi ≤ t.
    - Tidak ada candle yang dikeluarkan karena kelak menjadi alert.
    - Estimand utama tidak diganti.
    - Tidak ada parameter yang dipilih dari arah hasil.
    - Kelayakan historisnya dihitung tanpa membuka hasil apa pun.
  - **Mengapa tak bias di bawah H0 (VERIFIED, argumen).** Jendela hasil pembanding = jendela hasil alert, dan seluruh bobot
    ditentukan pada t. Dengan martingale, E[y | ≤ t] = 0 untuk semua anggota sel.
  - **Hasil simulasi** (200 simulasi per skenario):
    - Efek 0: −0,003 ± 0,006, sedangkan estimator utama −0,023.
    - δ 0,2946: 0,306 ± 0,006, setara estimand populasi T2 0,300. Estimator utama 0,232. Komponen dasar +0,005 ± 0,006,
      komponen drift 0,301, tanpa atenuasi.
    - Overlap 49–50% dengan 2,0 pembanding per alert (40 simbol). SD antar-simulasi 0,077–0,078 vs 0,065 estimator utama.
  - **Kelayakan historis** (100 koin, tanpa hasil): 71% alert punya pembanding, rata-rata 4,1.
  - **Estimand-nya BERBEDA.**
    - Ia membandingkan alert dengan simbol lain pada waktu yang sama, jadi heterogenitas simbol tidak dikontrol.
    - Populasinya adalah alert yang punya kembaran keadaan di simbol lain, cenderung pada gerak pasar luas.
    - Bila informasi SA/PVA menyebar ke simbol lain pada jam yang sama, estimand ini bias ke 0.
  - **Usulan.** Analisis pelengkap deskriptif, dengan bootstrap prosedur penuh yang sama. Ia dikunci sebagai adendum
    **sebelum outcome jendela dibuka**, dan tidak menggantikan atau mengubah keputusan utama. Keputusan pemilik (§20).

## 19. Pengamanan akses data

Audit skrip yang memuat cache dan bisa menghitung hasil (VERIFIED, grep + baca kode):

| Jalur | Bisa membuka hasil jendela? | Status |
|---|---|---|
| Runner AL-MOM-01 | hanya `evaluate` sesudah beku & cutoff | dijaga |
| `research-mom-power/-overlap/-sim`, `research-matched-exclusion` | tidak (`--to` ≤ 2026-11-16) | dijaga |
| `research-al-mom-01-diagnose.js` mode historis | tidak (penjaga sebelum I/O; tes 022) | dijaga |
| `research-matched.js`, `research-timing.js` | ya, lewat `--to` | **tidak bisa diubah** (hash docs/25 §1.6); hanya protokol |
| **`scripts/backtest.js`** (CLI produk) | sebelum babak ketiga: ya (`--to` bawaan = sekarang; R dan win rate v3 LONG 1h) | **dijaga sejak babak ketiga** (lihat bawah) |
| UI produk / database sinyal | status siklus sinyal live (mis. MOMENTUM_BUILDING, `final_outcome`), yaitu info kualitatif gerak sesudah alert | protokol |
| `research-al-sa-atr-01*.js`, `reversal-replay.js`, `research-bsv-1h.js` | tidak menghitung A/B AL-MOM-01 | — |

Usulan isolasi (keputusan pemilik):

1. **Snapshot cache riset.** Salin cache bulan < 2026-11 ke folder baca-saja. Semua skrip pengembangan diarahkan ke sana
   lewat `--cache-dir`. Cache hidup hanya untuk count/audit, dan untuk evaluate sesudah cutoff.
2. **Penjaga di `backtest.js`.** Bila `--timeframes` memuat 1h dan `--to` > 2026-11-16, minta flag eksplisit
   `--allow-prospective` dan cetak peringatan protokol. File ini di luar hash beku, tetapi perilaku produk berubah.
3. **Protokol pemilik.** Selama jendela, jangan membuka statistik kinerja alert LONG 1h, baik di UI, database, maupun
   backtest. Catat di laporan evaluate siapa yang punya akses.
4. **Keputusan apa pun di babak ini diambil sesudah jendela dimulai,** termasuk §20. Laporan harus menyatakan bahwa
   keputusan didasarkan hanya pada data sintetis dan historis ≤ 2026-10-01, dan bahwa tidak ada hasil jendela yang
   dihitung.

**Diterapkan di babak ketiga** (keputusan pemilik §20.1). Lapisan teknis:

- **Penjaga `backtest`** (`scripts/lib/protectedPeriod.js`, `scripts/lib/backtestArgs.js`, `scripts/backtest.js`). Berlaku
  bila timeframe dasar memuat 1h dan sumbernya Binance atau CSV; data sintetis tidak dijaga.
  - `--to` bawaan dipotong ke 2026-11-16 00:00 UTC, dengan pesan.
  - `--to` eksplisit sesudahnya, atau `--from` di dalam periode itu, ditolak.
  - CSV tanpa `--to`: candle ≥ 2026-11-16 dibuang saat dimuat.
  - Sesudah data dimuat, ada pemeriksaan lapis kedua: candle 1h di periode terlindungi menghentikan run.
  - `--buka-periode-terlindungi` hanya berjalan sesudah frasa persis diketik di terminal interaktif (stdin dan stderr
    TTY, bukan CI). Skrip otomatis, CI, dan asisten AI tanpa TTY selalu ditolak.
  - Laporan JSON mencatat `meta.protectedPeriod`.
  - Penjaga ini mencegah pembukaan tak sengaja; ia bukan pengaman terhadap pelanggaran yang disengaja.
  - Perilaku produk berubah: run 1h tanpa `--to` kini berhenti di 2026-11-16 sampai jendela selesai. Timeframe lain tidak
    berubah.
- **Snapshot cache riset** (`npm run research:snapshot`, `data/research-snapshot`, di-gitignore). Isinya salinan baca-saja
  bulan cache < 2026-11, saat ini 4.452 file (500,4 MB), 2024-01 … 2026-09. Hash pohonnya
  `618e0a5c24f5e0cc8c033b19ba5721b67d89bc2c93311e9e8f92aba89793c884` (manifest `MANIFEST.json`).
  - Snapshot hanya bertambah: file lama tidak pernah ditimpa, dan isi yang berbeda menghentikan proses.
  - Skrip pengembangan membacanya secara bawaan: `research-al-mom-01-diagnose`, `research-mom-power/-overlap/-sim`, dan
    `research-matched-exclusion`.
  - `data/backtest-cache` (cache hidup, yang nanti memuat bulan jendela) hanya dipakai untuk count/audit AL-SA-ATR-01 dan
    AL-MOM-01, serta untuk evaluate resmi. Skrip beku tidak diubah.
- **File yang tidak disentuh.** `backend/`, runner AL-MOM-01, `research-al-sa-atr-01*.js`, dan
  `research-matched.js`/`research-timing.js`. Hash pohon tetap `f3004d2c…`, dan hash AL-SA-ATR-01 tetap `25c02256…`.

Lapisan operasional (protokol, tanpa kode): UI live tetap berjalan, tetapi statistik hasil alert live tidak dipakai untuk
merevisi hipotesis atau memilih metode selama protokol berjalan. Sisa risikonya:

- skrip beku docs/25 (`research-matched/-timing`) masih bisa membaca cache hidup lewat `--to`;
- UI dan database sinyal live.

## 20. Keputusan pemilik

1. **Metode CI (§5) dan pembekuan.** Pemilik menunda pembekuan. Pilihan berdasarkan §14–§17:
   - **Rekomendasi: tetap persentil untuk keputusan formal, ditambah aturan pelaporan untuk bacaan "< M"**, dikunci di
     §9.1 sebelum pembekuan.
     - Kelompok §6 tetap dihitung dari CI persentil.
     - Bila kelompoknya 1 atau 3 (hi < 0,25) tetapi batas atas basic ≥ 0,25, bacaan "keunggulan < 0,25" ditandai **rapuh**,
       dan konsekuensi produknya ditahan seperti kelompok 4.
     - Laporan selalu menyatakan bahwa 0,25 adalah skala estimand prosedural.
     - Dengan aturan ini, galat superioritas tetap ≤ 1% (persentil). Galat "< M" diverifikasi dari CI per simulasi run
       keputusan: 3,4% [2,1–5,4] pada dasar dan 2,0% [1,1–3,6] pada episode (persentil 9,6% dan 6,0%), dan 0,5% [0,1–1,8]
       dan 2,2% [1,2–4,2] pada pasangan sedang dan kuat dengan 100 simbol (persentil 13,0% dan 15,0%).
     - Biayanya: daya "< M" pada efek 0 turun dari 97,6% ke 92,4%. Daya superioritas tidak berubah.
     - Bacaan "< M" sebaiknya juga dilaporkan berdampingan dengan sensitivitas lampau (§15), yang di DGP mendekati estimand
       populasi.
     - Catatan: aturan ini menyentuh konsekuensi produk kelompok §6, jadi perlu keputusan eksplisit pemilik. Ia bukan
       perubahan diam-diam.
   - **Tetap persentil murni.** Galat "< M" 6–10% didokumentasikan, dan penanda rapuh hanya informatif.
   - **AL-MOM-02 basic: tidak direkomendasikan.** Galat superioritasnya > nominal pada alert tak merata (4,8%).
2. **Masalah estimand (§15).** Pilihannya: menerima bahwa bacaan "< M" hanya berlaku pada skala prosedural, atau
   mengunci diagnostik landmark (§18) sebagai pelengkap deskriptif yang menargetkan estimand populasi, sebelum outcome
   jendela dibuka.
3. **Akses data (§19).** Snapshot cache riset, penjaga `backtest.js`, dan protokol UI.
4. **Simulasi konfirmasi sebelum beku** (opsional, ±1,5–4 jam komputasi): aturan gabungan pada 9 skenario stres, dan alert
   tak merata pada 100 simbol.
5. **Kelompok koin kedua** (opsional, dari babak pertama).

### 20.1 Keputusan pemilik babak ketiga (2026-11-16 ±06:20 UTC)

Keputusan ini diambil sesudah tinjauan ChatGPT atas §13–§20, dan berdasarkan data sintetis dan historis ≤ 2026-10-01
saja.

1. **Tujuan AL-MOM-01: uji konfirmasi superioritas saja.**
   - Klaim formal satu-satunya adalah batas bawah CI persentil > 0 (kelompok 1–2 docs/28 §6).
   - Batas 0,25 ATR deskriptif dan hanya berlaku pada skala estimand operasional (§21.4). Ini sejalan dengan docs/28 §6,
     yang sudah menyebut M sebagai "batas deskriptif".
   - Kelompok 3 dibaca "superioritas belum terbukti", bukan "SA/PVA tidak punya nilai tambah yang berarti".
   - Klaim batas atas efek populasi tidak dibuat. Bila klaim itu kelak dibutuhkan, ia butuh penelitian baru dengan estimand
     dan estimator yang sesuai.
2. **Aturan gabungan dan landmark: menunggu tinjauan ChatGPT.**
   - Usulan adendum keputusan produk ditulis di balasan ke ChatGPT, bukan di repo. Isinya: kelompok formal tetap dari CI
     persentil, ditambah lapisan produk yang menahan konsekuensi kelompok 1/3 bila batas atas basic ≥ 0,25.
   - Landmark lintas simbol diusulkan sebagai analisis sekunder eksploratif.
   - Keduanya baru ditulis sebagai adendum bertanggal yang merujuk docs/28 §6 sesudah disepakati, dan sebelum outcome
     jendela dibuka.
3. **Simulasi konfirmasi: kriteria dikunci di §21, run menunggu tinjauan ChatGPT.** Sebelum run dimulai, perubahan atas
   masukan ChatGPT dicatat sebagai versi baru §21.
4. **Akses data: penjaga `backtest` dan snapshot cache riset diterapkan** (§19).

## 21. Praregistrasi simulasi konfirmasi (v1, 2026-11-16; belum dijalankan)

**Status: DIKUNCI v1, BELUM DIJALANKAN.**

- Kriteria, skenario, benih, dan jumlah simulasi di bagian ini di-commit sebelum run konfirmasi apa pun.
- Sesuai keputusan pemilik (§20.1), run menunggu tinjauan ChatGPT.
- Perubahan sebelum run dicatat di §21.9 sebagai versi baru, dengan tanggal dan alasan. Sesudah run pertama dimulai,
  kriteria tidak boleh diubah.

**Batas kejujuran.**

- Kriteria ini ditulis sesudah hasil eksploratif §8 dan §14–§17 diketahui, dan hasil itu tidak dipraregistrasi.
- Run konfirmasi memakai benih baru dan empat DGP baru. Sepuluh DGP lainnya sudah pernah dijalankan dengan benih lain.

### 21.1 Pertanyaan

1. Apakah klaim superioritas (batas bawah CI persentil > 0) terkendali di semua DGP bila SA/PVA tidak membawa informasi?
2. Apakah lapisan produk "< M" (batas atas gabungan = maks(persentil, basic)) terkendali terhadap estimand operasional?
3. Seberapa besar galat batas atas terhadap estimand populasi (pertanyaan riset)?

### 21.2 Kalibrasi rezim dari ciri historis (bukan hasil CI)

Hari diurutkan dua kali: menurut volatilitas pasar harian (√Σ_h m_h², m_h = rata-rata return terstandar antarsimbol), dan
menurut jumlah alert harian. Lalu 15% hari teratas dibandingkan dengan sisanya. Korelasi subset dihitung sebagai
kovarians rata-rata antarpasangan dibagi varians rata-rata pada subset yang sama.

Historis: 100 koin, 2024-10 … 2026-09, dibaca dari snapshot; ciri return dan jumlah saja (HISTORICAL). DGP: 12–16
simulasi, mode `describe` tanpa bootstrap (SIMULATED).

| Ciri | Historis | dasar0 (40) | pasangan084 (100) | **rezimHistoris100** | rezimPadat100 | takMerata100 |
|---|---|---|---|---|---|---|
| Korelasi 1 jam | 0,40 | 0,47 | 0,47 | 0,39 | 0,39 | 0,47 |
| Alert/simbol-tahun · dispersi harian · porsi 10% hari teratas | 21,5 · 6,5 · 0,34 | 24,2 · 2,6 · 0,32 | 24,6 · 5,0 · 0,29 | 21,8 · 6,7 · 0,34 | 21,8 · 13,8 · 0,43 | 33,6 · 31,5 · 0,53 |
| **Hari bergejolak:** volatilitas ÷ lainnya | 2,38 | 1,99 | 1,99 | 2,67 | 2,67 | 2,02 |
| … korelasi (teratas / lainnya) | 0,64 / 0,34 | 0,54 / 0,44 | 0,54 / 0,44 | 0,59 / 0,27 | 0,59 / 0,27 | 0,54 / 0,44 |
| … konsentrasi alert (1 = merata) | **0,39** | 1,01 | 1,01 | 0,49 | 2,26 | 0,92 |
| **Hari padat alert:** volatilitas ÷ lainnya | **0,69** | 1,01 | 1,02 | 0,83 | 1,58 | 0,97 |
| … korelasi (teratas / lainnya) | **0,28 / 0,42** | 0,48 / 0,47 | 0,48 / 0,47 | 0,28 / 0,41 | 0,57 / 0,34 | 0,47 / 0,47 |
| … konsentrasi alert | 3,02 | 2,85 | 2,60 | 2,98 | 3,52 | 4,26 |
| Alert berpembanding (%): hari bergejolak / padat alert / hari lain (pembagian volatilitas) | 91,9 / 90,8 / 90,9 | 88,5 / 88,9 / 88,6 | 88,3 / 89,6 / 89,0 | 88,1 / 88,6 / 88,0 | 88,2 / 88,1 / 87,6 | 86,7 / 88,4 / 88,8 |

**Temuan (HISTORICAL).**

- Hari pasar paling bergejolak menekan alert LONG 1h: konsentrasinya 0,39, padahal 1 berarti merata.
- Hari yang padat alert lebih tenang (volatilitas 0,69×) dan korelasinya lebih rendah (0,28 vs 0,42).
- Overlap tidak berubah menurut rezim (91–92%).
- Jadi hipotesis tinjauan, yaitu korelasi, volatilitas, dan kepadatan alert naik bersama, **bertentangan dengan data
  historis**.
- DGP lama tidak meniru ketiga pola itu: konsentrasinya 1,0, dan hari padat alert tidak lebih tenang.

**Lapisan rezim baru** (`stressEnter` dkk. di `simulateMarket`). Lapisan ini adalah rantai Markov harian bersama yang
ditarik dari aliran rezim, jadi tetap sama antar-draw oracle.

- Masuk 0,02 per hari dan keluar 0,15 per hari (episode ±6,7 hari, ±12% hari).
- Di hari episode: β² naik dari 0,30 ke 0,75, volatilitas pasar ×1,6, dan hazard alert dikali `stressHazard`.
- Dispersi rezim alert 0,45.
- Dengan `stressEnter` 0, urutan bilangan acak DGP lama identik. Ini diverifikasi dengan sidik jari SHA-256 enam skenario
  dan UNIT-MOM01-026.

Parameter dipilih dari empat kandidat `describe`. Hanya ciri di atas yang dibandingkan, tanpa bias, SE, atau CI:

| Kandidat | Konsentrasi alert hari bergejolak | Volatilitas hari padat alert | Dispersi |
|---|---|---|---|
| histA (hazard ×0,3, h0 0,00175, dispersi rezim 0,3) | 0,52 | 0,83 | 4,8 |
| hipA (hazard ×3) | 2,28 | 1,70 | 12,5 |
| **histB (hazard ×0,2, h0 0,0016, dispersi rezim 0,45)** | 0,49 | 0,83 | 6,7 |
| hist40 (histB, 40 simbol) | 0,50 | 0,84 | 3,3 |

Hasilnya dua skenario:

- **rezimHistoris100**: histB, alert ×0,2 di hari episode, dikalibrasi ke data historis.
- **rezimPadat100**: hipotesis tinjauan, alert ×3 dan h0 0,00117 supaya laju alert sama. Ia digolongkan **ekstrem** karena
  bertentangan dengan data historis.

### 21.3 Skenario dan golongan

| DGP | Efek 0 | Efek ≈ margin | Simbol · simulasi | Golongan | Basis harga martingale? |
|---|---|---|---|---|---|
| dasar | `dasar0` | `dasar025` | 40 · 500 | realistis | ya |
| korelasi β² 0,85 | `korelasi` | `korelasiM` | 40 · 500 | realistis | ya |
| alert sangat tak merata | `takMerata` | `takMerataM` | 40 · 500 | realistis | ya |
| strata sedikit | `sedikit` | `sedikitM` | 40 · 500 | realistis | ya |
| ekor tebal | `ekor` | `ekorM` | 40 · 500 | realistis | ya |
| momentum pasar | `momentum` | `momentumM` | 40 · 500 | realistis | **tidak** |
| episode tren per simbol | `episode` | `episode025` | 40 · 500 | realistis | **tidak** |
| serial (efek per rezim, amplitudo ±0,30 θ) | `serial0` | `serialM` | 40 · 500 | ekstrem* | ya |
| stres gabungan | `stres0` | `stres025` | 40 · 500 | ekstrem | ya |
| dasar 100 simbol | `pasangan084` | `pasangan084e` | 100 · 400 | realistis | ya |
| alert sangat tak merata, 100 simbol | `takMerata100` | `takMerata100M` | 100 · 400 | realistis | ya |
| rezim episode, kalibrasi historis | `rezimHistoris100` | `rezimHistoris100M` | 100 · 400 | realistis | ya |
| rezim padat, hipotesis | `rezimPadat100` | `rezimPadat100M` | 100 · 400 | ekstrem | ya |

- "Efek ≈ margin" berarti δ dikalibrasi lewat pilot (40 simulasi × 200 replikasi, benih 500000+) supaya θ_info ≈ 0,25.
- \* **Serial** digolongkan ekstrem karena menyangkut definisi target, bukan kegagalan metode. Bila efek berubah per rezim,
  CI berlaku untuk jendela terealisasi (θ_d), bukan rata-rata jangka panjang (§15). Galatnya terhadap θ_d tetap
  dilaporkan.

### 21.4 Target inferensi

**Jawaban atas pertanyaan tinjauan: apakah T4 target yang didefinisikan sebelum data?**

- docs/28 §2 (dikunci di `7da88ce`, sebelum data) memberi dua hal yang tidak dibedakan:
  - kata "ATT", yang menyarankan estimand populasi kausal (T2);
  - rumus operasional "rata-rata selisih antara alert dan rata-rata candle pembanding di strata yang sama (§4)" pada
    populasi overlap, dengan bootstrap prosedur penuh (§5).
- **Estimand operasional** θ_op adalah ekspektasi rumus itu di bawah proses data yang sebenarnya, dengan strata, jendela,
  dan aturan overlap yang dikunci. Definisinya ada sebelum data, karena ia ditentukan seluruhnya oleh prosedur yang dikunci.
  Ia juga besaran yang ditargetkan CI bootstrap prosedur penuh.
- **T4 bukan definisi baru,** melainkan nilai θ_op pada satu DGP (rata-rata Monte Carlo θ̂). Nilainya bergantung pada DGP
  dan tidak diketahui di pasar nyata.
- Jadi kami tidak menamai T4 estimand penelitian baru. Istilah yang dipakai adalah "estimand operasional docs/28 §2
  (skala prosedural)". Teks §2 tidak diubah.

| Target | Definisi di simulasi | Dipakai untuk |
|---|---|---|
| T1 tanpa informasi | δ = 0, yaitu SA/PVA tidak membawa informasi | **K1** (superioritas palsu) |
| T4 = θ_op | rata-rata θ̂ antar-simulasi pada run yang sama (SE MC dilaporkan) | **K2**, K4 |
| T2 populasi overlap | oracle `--configs 20 --draws 10` (serialM 40 × 10): rata-rata antar-konfigurasi (unit independen) dari y alert − rata-rata pembanding sel dari draw lain | **K3** |
| T3 θ_info | estimator pada komponen drift | dilaporkan |
| θ_d terealisasi | komponen drift per dataset | dilaporkan (khususnya serial) |

Pada efek 0, T2 = 0 menurut konstruksi bila basis harga martingale (argumen §8.3; oracle dasar0: −0,001 ± 0,005). Untuk
`momentum` dan `episode` basisnya bukan martingale, jadi T2 efek 0 diestimasi oracle. `rezimPadat100` efek 0 juga diberi
satu oracle sebagai pemeriksaan DGP baru.

K1 diuji terhadap T1, bukan terhadap θ_op, karena pertanyaan riset adalah informasi di luar momentum. Bila θ_op > 0 tanpa
informasi, misalnya karena sisa momentum di dalam bin, superioritas tetap merupakan kesimpulan yang keliru.

### 21.5 Kriteria

Semua proporsi memakai interval Wilson 95%. Nominal satu sisi 2,5%. Lulus berarti batas bawah Wilson ≤ 2,5%, artinya
galat tidak terbukti di atas nominal.

| Kode | Metrik | Run | Lulus bila | Konsekuensi bila gagal |
|---|---|---|---|---|
| **K1** | P(lo persentil > 0) | efek 0 | Wilson bawah ≤ 2,5% | realistis → **tinjau desain, tidak beku**; ekstrem → klaim superioritas dibatasi dan rezimnya disebut di laporan |
| **K2** | P(hi gabungan < T4) | ≈ margin | Wilson bawah ≤ 2,5% | realistis → lapisan produk "< M" tidak dipakai sama sekali (kelompok 1/3 diperlakukan seperti 2/4 untuk produk); ekstrem → lapisan itu dibatasi |
| **K3** | P(hi gabungan < T2), juga persentil dan basic | ≈ margin | tidak ada (dilaporkan) | > 5% → larangan klaim batas atas efek populasi (§20.1) ditegaskan; kepekaan T2 ± 2 SE dilaporkan |
| **K4** | coverage dua sisi CI persentil terhadap T4 | ≈ margin | ≥ 85% | realistis → tinjau desain; ekstrem → klaim dibatasi |
| **K5** | simulasi gagal per run | keduanya | ≤ 1% | realistis → tinjau desain |

- **Daya kriteria** (dihitung tepat dari binomial).
  - Galat sebenarnya 5% terdeteksi (Wilson bawah > 2,5%) dengan peluang 87% pada 500 simulasi, dan 79% pada 400.
  - Galat 3,5% hanya terdeteksi 24–30%.
  - Bila galatnya tepat nominal, peluang "gagal" keliru 2,5–2,9%.
- **Dilaporkan tanpa kriteria.** Galat basic dan BC di sisi superioritas, galat terhadap θ_d (serial), dan T3.
- **Kegagalan besar tidak diberi label "sensitivitas" saja.** Konsekuensi di atas mengikat.

**Vonis gabungan** (fungsi `verdict` di `scripts/research-al-mom-01-confirm.js`):

- **BELUM LENGKAP:** ada run atau T2 yang belum ada.
- **TINJAU DESAIN (tidak dibekukan):** ada golongan realistis yang gagal K1, K4, atau K5.
- **LULUS DENGAN PEMBATASAN KLAIM:** ada golongan ekstrem yang gagal K1 atau K4, atau golongan realistis yang gagal K2.
- **LULUS:** selain itu.

Lulus bukan pernyataan siap beku. Pembekuan juga menunggu adendum §6 dan keputusan pemilik.

### 21.6 Benih, jumlah, dan perintah

Kode: commit yang menambahkan §21. Seluruh run memakai `--reps 999 --blocks 7 --workers 6`.

```
# 40 simbol (18 run, 500 simulasi, benih 1100001 + k; benih sama antarskenario)
npm run research:al-mom-01-coverage -- --sims 500 --reps 999 --blocks 7 --seed 1100001 --workers 6 \
  --scenarios dasar0,dasar025,korelasi,korelasiM,takMerata,takMerataM,sedikit,sedikitM,ekor,ekorM,momentum,momentumM,episode,episode025,serial0,serialM,stres0,stres025
# 100 simbol (8 run, 400 simulasi)
npm run research:al-mom-01-coverage -- --sims 400 --reps 999 --blocks 7 --seed 1100001 --workers 6 \
  --scenarios pasangan084,pasangan084e,takMerata100,takMerata100M,rezimHistoris100,rezimHistoris100M,rezimPadat100,rezimPadat100M
# Oracle T2 untuk tiap skenario ≈ margin (δ dan deltaAmp hasil kalibrasi disalin persis dari laporan coverage),
# serta efek 0 untuk momentum, episode, dan rezimPadat100. Benih rezim 1200001 + c, inovasi 7.000.000 + 1.000c + k.
node --max-old-space-size=3072 scripts/research-al-mom-01-diagnose.js --mode oracle --scenario <nama> --set delta=<δ> \
  [--set deltaAmp=<a>] --configs 20 --draws 10 --seed 1200001 --workers 6 --tag konfirmasi-<nama>   # serialM: --configs 40
# Evaluasi menurut kriteria §21.5
npm run research:al-mom-01-confirm -- --coverage <dua laporan coverage> --oracle <laporan oracle>
```

**Perkiraan biaya** (6 pekerja; dari run sebelumnya):

| Bagian | Waktu |
|---|---|
| Coverage 40 simbol (18 run, termasuk pilot kalibrasi) | ±1,5 jam |
| Coverage 100 simbol (8 run) | ±1,2 jam |
| Oracle 40 simbol (11 run, 2.400 draw) | ±0,8 jam |
| Oracle 100 simbol (5 run, 1.000 draw) | ±0,8 jam |
| **Total** | **±4–5 jam** |

Run yang gagal karena error teknis diulang dengan benih yang sama, dan kejadiannya dicatat.

### 21.7 SHA-256 kode praregistrasi

| File | SHA-256 |
|---|---|
| `scripts/research-al-mom-01.js` (runner, tidak berubah) | `25af1b6db48d2e02c5c0be711b78e23e27c11066492439ba1beaa3b2be53af92` |
| `scripts/research-al-mom-01-coverage.js` | `46cdda87f9518799306262cd3217211ff39611b2d908c3154acca313ea36332b` |
| `scripts/research-al-mom-01-diagnose.js` | `86f458e15d032f3531a4e7f62503006b003413f7d08b5f4c62b169529df14c07` |
| `scripts/research-al-mom-01-confirm.js` | `c6b3486aa582291654e043f92bb2e1a1a05e8311d94a66780bed9fc145987973` |
| `tests/unit/research/alMom01Confirm.test.js` | `867a6d941a85b9f8252434f3f41500a4d3d19fd0b5da43cf149cf5a0d1fcf460` |
| `tests/unit/research/alMom01Diagnose.test.js` | `ba2acb2c59167bd36e77f1f3e2eb8bc964e7407705a61dba3532d5f49f920844` |

- **Hash pohon** `f3004d2c…` (backend + runner) tidak berubah.
- **Uji asap teknis** sebelum commit: 2 simulasi × 19 replikasi untuk `serial0`, `serialM`, `stres0`, `rezimPadat100M`,
  dan `takMerata100`; ditambah satu oracle 1 × 2 dan evaluator. Hasilnya ditulis ke folder sementara di luar repo, dan
  angkanya tidak dibaca. Yang diperiksa hanya bahwa jalur kode berjalan: 0 simulasi gagal, pencocokan δ oracle, dan vonis
  "BELUM LENGKAP".
- **δ untuk oracle disalin persis** dari `overrides` laporan coverage (representasi angka terpendek JavaScript), sehingga
  pencocokan δ di evaluator tepat.

### 21.8 Yang tidak dicakup

- Alert di DGP berasal dari model hazard, bukan replay SA/PVA.
- Kalibrasi rezim hanya meniru ciri tingkat hari. Ciri dalam hari dan asimetri arah (crash vs rally) tidak ditiru.
- Hasil simulasi tidak membuktikan kalibrasi di pasar nyata. Kriteria ini hanya menyaring kegagalan metode pada DGP yang
  masuk akal.

### 21.9 Riwayat versi

- **v1 (2026-11-16):** versi awal. Belum ditinjau ChatGPT, dan belum ada run.
