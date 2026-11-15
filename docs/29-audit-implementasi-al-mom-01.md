# 29 — Audit implementasi AL-MOM-01: kode beku, diagnostik, dan simulasi coverage (2026-11-16)

**Status: audit pembekuan kode.** Dokumen ini merinci pemeriksaan sebelum kode analisis AL-MOM-01 dibekukan (docs/28
§9.1). Tidak ada hasil A atau B dari data jendela (≥ 2026-11-16) yang dihitung. Pengujian memakai data historis sampai
2026-10-01 dan data sintetis (docs/28 §8).

Label klaim:

- **VERIFIED**: dibuktikan lewat kode atau tes otomatis.
- **SIMULATED**: hasil simulasi dengan asumsi DGP yang disebutkan.
- **HISTORICAL**: data sebelum jendela uji, yang sudah pernah dilihat (docs/24–27).
- **UNVERIFIED**: belum terbukti.

## 1. Vonis

**BELUM SIAP DIBEKUKAN. Implementasi selesai dan teruji; ada satu keputusan metodologis yang terbuka, dan pemilik
menunda pembekuan.**

- **Yang sudah terbukti.**
  - Runner menjalankan desain docs/28 §2–§8 dengan setia, dan paritasnya dengan alat desain terbukti (VERIFIED).
  - Pengaman akses data bekerja (VERIFIED).
  - SMD dan overlap memadai pada data historis (HISTORICAL).
  - SE bootstrap prosedur penuh ±10% konservatif di simulasi (SIMULATED).
- **Yang terbuka.** CI persentil yang dikunci §5 punya galat satu sisi yang tidak simetris (§8.4):
  - klaim superioritas sangat konservatif;
  - bacaan "keunggulan < 0,25 ATR" lebih longgar dari nominal.

  Memperbaikinya berarti mengganti metode CI, dan itu termasuk §5 yang dikunci. Karena itu keputusannya di tangan pemilik
  (§13), dan kode belum dibekukan.

## 2. Kondisi awal dan lingkup

- **Awal kerja.** `main` di `babc95a`, pohon kerja bersih, 2026-11-15 20:12 UTC (sebelum jendela dimulai).
- **Yang sudah ada.** Inti desain di docs/28 §2–§8 (`7da88ce`), serta alat desain `research-mom-power/-sim/-overlap` (docs/27).
- **Yang belum ada.** Runner, SMD lengkap, diagnostik ≥ 4 ATR, bootstrap 10.000 replikasi dengan sensitivitas, simulasi
  coverage, dan pengaman mode.
- **Batas yang dipegang.**
  - docs/28 §2–§8 tidak diubah. Pemeriksaan otomatis membandingkan teks §2–§8 dengan commit `7da88ce`: identik.
  - `backend/` tidak diubah. Hash pohon AL-SA-ATR-01 tetap `25c02256…f8b314` (VERIFIED, UNIT-MOM01-001).

## 3. Temuan dan tingkat keparahan

| # | Temuan | Label | Keparahan | Status |
|---|---|---|---|---|
| 1 | Estimand punya **komponen waktu**: candle pembanding 1–12 candle sebelum alert, di strata yang sama, punya jendela 12 candle yang memuat gerak pemicu alert. Tanpa informasi apa pun, ATT bergeser −0,019 ± 0,002 ATR (§8.3) | SIMULATED | sedang | dilaporkan; sifat estimand terkunci, bukan bug |
| 2 | **Batas atas CI persentil** jatuh di bawah target informasi lebih sering dari nominal 2,5% (6,1% pada efek 0,25); sisi superioritas konservatif (0,1% pada efek 0) | SIMULATED | sedang | dilaporkan + pembanding metode CI (laporan saja); keputusan pemilik §13 |
| 3 | **Atenuasi**: drift informasi δ selama 12 candle hanya tertangkap ±85% oleh estimand, karena pembanding di dekat alert ikut membawa sebagian drift | SIMULATED | rendah (tafsir) | dilaporkan |
| 4 | `--log-dir` memungkinkan evaluate kedua tanpa `--rerun-reason` (temuan peninjau independen) | VERIFIED | mayor | diperbaiki: evaluate menolak folder log/cache non-bawaan |
| 5 | Bootstrap fallback tidak mengulang aturan fallback per replikasi | VERIFIED | minor | diperbaiki (UNIT-MOM01-016) |
| 6 | Deret hasil resampling lebih panjang dari D, karena blok terakhir tidak dipotong (+0,8% untuk D = 729) | VERIFIED | minor | diperbaiki: MBB baku (UNIT-MOM01-008) |
| 7 | Profil alert tak cocok belum memuat "kelompok koin" yang diminta §7 | VERIFIED | minor | diperbaiki |
| 8 | Data yang berhenti sebelum cutoff tanpa delisting terverifikasi tidak menghalangi evaluate | VERIFIED | minor | diperbaiki (UNIT-MOM01-006) |
| 9 | SMD pada rata-rata null menghasilkan angka semu | VERIFIED | minor | diperbaiki (UNIT-MOM01-007) |
| 10 | Audit AL-SA-ATR-01 berhenti di 2027-11-16, padahal AL-MOM-01 butuh data sampai 2028-11-16 | VERIFIED | sedang | ditutup: `--mode count` menjadi log integritas tahun kedua |
| 11 | Skrip riset lama bisa membuka hasil jendela lewat `--to` | VERIFIED | sedang | 4 skrip dijaga; 2 skrip terkunci docs/25 tidak bisa diubah (risiko sisa §12) |
| 12 | Kandidat diagnostik "ATT tanpa pembanding pra-alert" **ditolak**: membagi pembanding menurut alert yang akan datang adalah seleksi masa depan (pada data sintetis tanpa informasi memberi +0,26 ATR) | SIMULATED | — | tidak dipakai; sama dengan pelajaran pembanding "simetris" docs/25 |

Temuan 4–9 berasal dari tinjauan independen atas kode (subagen yang hanya membaca, diberi kode dan docs/28 tanpa
kesimpulan penulis). Tinjauan itu tidak menemukan cacat kritis. Ia memeriksa estimand, look-ahead, bootstrap, mode
count/evaluate, SMD, dan determinisme.

## 4. Perubahan kode

| File | Isi | Di hash beku? |
|---|---|---|
| `scripts/research-al-mom-01.js` | Runner beku. Kelayakan tanpa hasil; strata numerik; pengumpulan per simbol (sel hanya untuk strata ber-alert); bootstrap prosedur penuh (penuh, populasi tetap, himpunan sama, alert saja, subkelompok, fallback per replikasi); SMD; overlap & ≥ 4 ATR; pembanding metode CI; presisi MC; laporan; mode validate/count/evaluate dengan pengaman | ya |
| `scripts/research-al-mom-01-coverage.js` | Simulasi coverage: DGP sintetis + fungsi runner beku, worker thread | tidak (SHA-256 di §10) |
| `scripts/research-window-guard.js` | `assertBeforeMomWindow`: `--to` ≤ 2026-11-16 | tidak |
| `scripts/research-mom-power.js`, `-overlap.js`, `-sim.js`, `research-matched-exclusion.js` | Satu baris penjaga `--to`. Kelayakan di `research-mom-power.js` sama dengan `7da88ce`; perubahan sejak itu hanya tambahan sel/kovariat (`babc95a`) dan penjaga ini | tidak |
| `tests/unit/research/alMom01.test.js` | UNIT-MOM01-001…017 | tidak (SHA-256 di §10) |
| `docs/28` §9.1, docs/29, README, `package.json` | Rincian beku, audit ini, perintah `research:al-mom-01`, `research:al-mom-01-coverage` | — |

Runner sengaja **mandiri**: hanya mengimpor `backend/` dan modul Node, jadi hash pohon (semua `.js` di `backend/` + runner)
mencakup seluruh kode penentu hasil (VERIFIED, UNIT-MOM01-001). Logika yang sama dengan `research-mom-power.js` ditulis
ulang, lalu dibuktikan setara:

- **UNIT-MOM01-002.** Kelayakan dan `prePos` ≡ `timingAt`/`forwardMove`/`atrTrade` pada candle sintetis, termasuk ATR 0
  dan ujung deret.
- **UNIT-MOM01-003.** `collectMomData` asli dijalankan pada cache sintetis dengan `replaySeries` di-mock. Untuk 222 alert,
  kunci strata, hasil A/B, jarak, serta n dan jumlah A/B pembanding per strata (utama, dasar, lampau) sama persis.

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

- **Pencocokan utama menyeimbangkan semua kovariat.** |SMD| ≤ 0,063, jadi sensitivitas bin 0,25 ATR **tidak dipicu**
  pada data ini.
- **Tanpa jarak, kovariat jarak tidak seimbang.** Strata dasar dan pembanding lampau menyisakan ketidakseimbangan jarak.
  Pada lampau, ini terjadi menurut definisi, karena pembanding ≤ 12 candle sesudah alert dikeluarkan. Ini alasan kedua
  sensitivitas itu dibaca sebagai estimand yang berbeda (docs/28 §4).

## 6. Overlap dan gerak awal ≥ 4 ATR

HISTORICAL, jendela yang sama:

- **Cakupan.** 3.864 dari 4.247 alert cocok (91,0%) dan 383 tidak cocok. Dari yang tidak cocok, 64 tidak punya pembanding
  bahkan di strata dasar.
- **Gerak awal ≥ 4 ATR.** 599 alert. Dari jumlah itu, 448 (74,8%) tercakup estimand dan 151 (25,2%) tidak cocok.
  Kelompok ini 39,4% dari alert tak cocok, tetapi hanya 11,6% dari alert cocok.
  - Median gerak awal: 3,26 ATR pada alert tak cocok vs 1,89 pada alert cocok.
  - Ciri lain mirip: jarak, posisi, kelompok koin, tahun, dan ATR% (1,28% vs 1,24%).
- **Fallback strata dasar untuk alert tak cocok** (n 319): A −0,067 [−0,575 … +0,336]. Khusus ≥ 4 ATR (n 108): A −0,277
  [−1,22 … +0,57].
- **Di dalam estimand:** ≥ 4 ATR −0,010 [−0,36 … +0,36] vs < 4 ATR −0,006 [−0,15 … +0,09].
- **Tafsir.** Ini deskriptif, dan CI-nya terlalu lebar untuk tafsir apa pun. Ambang 4 ATR adalah diagnostik overlap, tidak
  diganti 2,7 ATR, dan tidak menjadi dasar keputusan produk.

## 7. Bootstrap prosedur penuh

**Perbandingan metode** (HISTORICAL; A, ATR; 10.000 replikasi, benih 20261116):

| Blok | Prosedur penuh | Populasi tetap | Himpunan sama | Alert saja |
|---|---|---|---|---|
| 7 hari (utama) | −0,006 [−0,137 … +0,092], SE 0,059 | SE 0,060 | SE 0,081 | SE 0,084 |
| 14 hari | [−0,133 … +0,100], SE 0,060 | SE 0,062 | SE 0,083 | SE 0,087 |
| harian | [−0,154 … +0,092], SE 0,063 | SE 0,062 | SE 0,076 | SE 0,077 |

- **Pengurangan SE berasal dari kovariasi, bukan dari perubahan komposisi overlap.** Untuk blok 7 hari, Var(alert saja)
  0,0070 turun ke Var(populasi tetap) 0,0036 ≈ Var(penuh) 0,0035. Var(himpunan sama) 0,0066 ≈ alert saja.
- **Penjelasannya.** Misalkan populasi tetap = alert saja − Δc, dengan Δc = pergeseran rata-rata pembanding strata dalam
  replikasi. Maka Var(fp) = Var(ao) + Var(Δc) − 2 Cov(ao, Δc) = 0,0070 + 0,0021 − 2 × 0,0027.
  - Rata-rata pembanding strata bergerak searah dengan hasil alert. Keduanya berasal dari simbol, kuartal, dan sering
    hari yang sama (pembanding sebelum dan sesudah alert berbagi sebagian jendela 12 candle).
  - Bootstrap alert saja menganggap rata-rata pembanding tetap, sehingga mengabaikan kovariasi itu.
  - **SE yang lebih kecil tidak otomatis lebih akurat.** Kalibrasinya diuji di §8.
- **Target tiap metode.**
  - Alert saja mengestimasi varians bersyarat pada rata-rata pembanding. Targetnya berbeda, jadi dipakai hanya sebagai
    pembanding metode.
  - Populasi tetap mempertahankan alert overlap asli, sedangkan prosedur penuh mengulang aturan "alert tanpa pembanding
    tidak ikut". Selisih keduanya = efek komposisi, yang di sini kecil.
- **Diagnostik per replikasi** (7 hari):
  - Bobot alert yang kehilangan pembanding: median 5,9%, p95 7,5%, maks 10,4%.
  - Strata aktif: median 2.264.
  - Alert ≥ 4 ATR yang tetap cocok: median 90%.
  - Korelasi porsi hilang ↔ ATT: Pearson 0,001, Spearman −0,000. Rata-rata ATT pada 10% replikasi dengan kehilangan
    terbesar −0,025 vs lainnya −0,023.
  - Tidak ada replikasi tidak valid.
- **Bentuk CI.** CI persentil tidak simetris: batas atas = titik + 1,66 SE, batas bawah = titik − 2,20 SE. Median bootstrap
  −0,023 vs titik −0,006 (geser −0,28 SE). CI basic [−0,105 … +0,124] dan BC [−0,106 … +0,130] juga kelompok 3, jadi data
  ini tidak rapuh terhadap metode CI. Dampaknya pada galat batas atas diukur di §8.4.
- **Presisi Monte Carlo** (10 benih × 10.000): SD batas bawah 0,0011, batas atas 0,0015. 10.000 replikasi lebih dari cukup.

## 8. Simulasi coverage

### 8.1 Rancangan

- **Data.** Pasar sintetis per jam: 40 simbol × 730 hari, ditambah 30 hari pemanasan. Komponennya:
  - faktor pasar bersama (β² = 0,5 pada skenario dasar);
  - rezim volatilitas pasar dan per simbol (AR(1) harian);
  - inovasi t (ν 5);
  - OHLC dengan sumbu (wick) acak.
- **Alert.** Alert v3 dan event v2 (v2 ≈ 5× v3) dibangkitkan dari hazard yang naik bersama gerak awal dan posisi
  rentang, dan saling memicu (×6 dalam 48 candle sesudah event). Ada juga rezim alert bersama dan heterogenitas laju per
  simbol.
- **Kalibrasi terhadap data historis 100 koin.**

  | Ciri | Data sintetis | Data historis |
  |---|---|---|
  | Alert per simbol-bulan | 1,9 | 2,07 |
  | Jarak ≤ 12 / 13–48 / > 48 candle | 48 / 32 / 20% | 43 / 40 / 17% |
  | Alert ≥ 4 ATR | 18% | 14% |
  | Posisi ≥ 0,8 | 59% | 60% |
  | Rata-rata gerak awal | 2,0 | 2,2 |
  | Alert cocok | 88–89% | 91% |
  | SE empiris A | 0,066 | SE bootstrap historis 0,059 |
- **Efek yang diketahui.** Efek tidak ditambahkan sebagai konstanta ke hasil alert. Sesudah alert v3, jalur harga mendapat
  drift δ × ATR selama 12 candle. Jadi pembanding di dekat alert ikut membawa sebagian drift itu, dan fitur candle sesudahnya
  ikut berubah.
- **Target per dataset (θ_d).** θ_d = estimator yang sama, diterapkan pada komponen drift Δ = Σ drift (i, i+12] ÷ ATR_i,
  dengan strata dan populasi overlap yang sama persis. Karena estimator linear terhadap hasil, estimasi = θ_d +
  estimator(komponen tanpa drift).
  - θ_info = rata-rata θ_d.
  - Skenario "efek 0,10 / 0,25" berarti δ dikalibrasi lewat simulasi pendahuluan dengan benih terpisah, sampai θ_info ≈
    0,10 / 0,25.
- **Kode analisis.** Kode analisis = fungsi runner (hash kandidat §10), tanpa salinan. Tiap simulasi menjalankan bootstrap
  999 replikasi dengan blok 7 hari (ditambah varian), 14 hari, dan harian.
- **Jumlah simulasi.** 1.000 simulasi untuk tiga skenario inti, 500 untuk skenario stres. Kurung siku = interval Wilson 95%
  sebagai ketidakpastian Monte Carlo.

### 8.2 Hasil inti (A, prosedur penuh 7 hari, 1.000 simulasi per skenario)

| | Efek 0 | Efek +0,10 | Efek +0,25 |
|---|---|---|---|
| θ_info (SD θ_d) | 0 (0) | +0,100 (0,001) | +0,250 (0,003) |
| Rata-rata estimasi | −0,019 | +0,081 | +0,232 |
| Komponen waktu/seleksi ± SE MC | −0,019 ± 0,002 | −0,019 ± 0,002 | −0,019 ± 0,002 |
| SE empiris · rata-rata SE bootstrap (rasio) | 0,066 · 0,073 (1,11) | 0,066 · 0,073 (1,10) | 0,066 · 0,073 (1,10) |
| Coverage θ_info | 96,3% [94,9–97,3] | 94,9% [93,4–96,1] | 93,6% [91,9–95,0] |
| Coverage rata-rata estimasi | 97,9% | 97,1% | 96,1% |
| lo > 0 | **0,1%** [0,0–0,6] (galat tipe I superioritas) | 9,3% | 82,1% (daya) |
| hi < 0,25 | 98,3% (daya) | 77,3% | **6,1%** [4,8–7,8] (galat tipe I batas atas) |
| Replikasi tidak valid | 0 | 0 | 0 |
| Atenuasi θ_info/δ | — | 0,848 | 0,850 |

- **Bias estimator** terhadap targetnya sendiri (rata-rata estimasi) tidak dapat dipisahkan tanpa target lain. Yang dapat
  diukur adalah selisih terhadap θ_info, dan selisih itu persis komponen waktu −0,019 ± 0,002 di ketiga skenario.
- **Pergeseran replikasi.** Porsi bobot alert yang hilang per replikasi rata-rata 5,9% (maks 13%), mirip data historis
  (5,9%; maks 10,4%).

**Metode bootstrap lain** (rasio SE bootstrap ÷ SE empiris; coverage θ_info pada efek +0,25):

| Metode | Rasio | Coverage | hi < θ_info |
|---|---|---|---|
| prosedur penuh 7 hari | 1,10 | 93,6% | 6,3% |
| 14 hari | 1,08 | 93,7% | 6,2% |
| harian | 1,13 | 95,1% | 4,9% |
| populasi tetap | 1,06 | 92,4% | 7,2% |
| himpunan sama | 1,18 | 97,3% | 2,4% |
| alert saja | 1,17 | 96,3% | 3,1% |

### 8.3 Komponen waktu (akar masalah 1)

Diukur dengan membedah pembanding strata alert menurut posisi waktunya (16 dataset, skenario dasar, efek 0):

- **Pembanding 1–12 candle sebelum alert** rata-rata 15% dari pembanding strata. Hasil A-nya rata-rata +0,50 ATR, naik
  dari +0,17 (lag 1) sampai +1,4 (lag 12), karena jendela 12 candle-nya memuat gerak yang memicu alert.
- **Pembanding sesudah alert dan yang jauh** ≈ 0.
- **Tafsir.**
  - Dengan pembanding kausal "tanpa" (docs/25 §2), alert tanpa informasi tampak sedikit lebih buruk daripada candle serupa
    yang datang lebih awal.
  - Ini sifat estimand yang dikunci: alert dinilai pada saat ia muncul. Ini bukan galat estimator.
  - Komponen ini tidak bisa "dikoreksi" dengan membuang pembanding pra-alert, karena itu seleksi masa depan seperti
    pembanding "simetris" docs/25. Pada data sintetis tanpa informasi, cara itu memberi +0,26 ATR.

### 8.4 Bentuk CI dan galat satu sisi (akar masalah 2)

| Efek | Geser median bootstrap | Batas atas − titik | Titik − batas bawah | Persentil: hi < θ_info · lo > θ_info | Basic | BC |
|---|---|---|---|---|---|---|
| 0 | −0,18 SE | 1,78 SE | 2,16 SE | 3,6% · 0,1% | 3,0% · 2,3% | 2,9% · 2,2% |
| +0,10 | −0,27 SE | 1,69 SE | 2,25 SE | 4,9% · 0,2% | 2,3% · 2,7% | 2,7% · 2,6% |
| +0,25 | −0,42 SE | 1,54 SE | 2,40 SE | 6,3% · 0,1% | 1,9% · 4,3% | 2,3% · 4,5% |

Data historis: geser −0,28 SE; batas atas titik + 1,66 SE; batas bawah titik − 2,20 SE. Ini setara dengan skenario efek
+0,10.

**Mekanismenya.** Di setiap replikasi, hari alert yang terambil k kali ikut menggandakan pembanding strata pada hari yang
sama. Pembanding itu berbagi jendela 12 candle dengan alert, termasuk drift informasinya bila ada.

- Rata-rata pembanding replikasi jadi condong ke pembanding yang mirip alert itu, sehingga ATT replikasi tertarik ke bawah.
- Makin besar efeknya, makin besar pergeserannya.
- CI persentil mewarisi pergeseran itu: batas atas terlalu rendah, batas bawah terlalu rendah.
- Ditambah komponen waktu (§8.3), hasilnya:
  - klaim superioritas sangat konservatif (0,1% pada efek 0, nominal 2,5%);
  - bacaan "keunggulan < 0,25" lebih longgar dari nominal (6,1% pada efek 0,25).
- CI basic dan BC mengoreksi pergeseran itu, sehingga galat keputusannya mendekati nominal (§8.5). Tetapi docs/28 §5
  menetapkan CI persentil. Mengganti metode CI berarti uji baru (§13).

### 8.5 Peluang keputusan per metode CI

Menyusul: run 500 simulasi (skenario dasar efek 0 dan +0,25, serta episode tren +0,25) masih berjalan saat commit ini.

### 8.6 Skenario stres (500 simulasi per skenario)

Menyusul: sembilan skenario stres masih berjalan saat commit ini. Yang sudah selesai: korelasi antarsimbol tinggi dan korelasi serial.

## 9. Daya uji

Tiga hal yang berbeda, dan tidak boleh dicampur:

1. **Daya model historis (HISTORICAL).** Model normal dengan SE prosedur penuh dari jendela semu 24 bulan (0,0594;
   100 koin, tetapi baru 55–100 simbol aktif per bulan):
   - **Uji batas atas, M 0,25 ATR, efek 0:** daya 98,8%. Bila efek = titik docs/27 (+0,009): 98,2%.
   - **Superioritas** (batas bawah CI 95% > 0, daya 80%): efek terkecil terdeteksi (MDE) 0,166 ATR. Dengan SE alert saja
     (0,084), angkanya 84,8% dan 0,234.
   - **Klaim docs/27 §9.4** (96%; MDE 0,18; SE prosedur penuh ±25% lebih kecil) **bertahan di model ini.** Rasio SE
     penuh/alert saja = 0,71.
2. **Daya berdasarkan simulasi (SIMULATED; 40 simbol, SE empiris 0,066, mirip historis).** Dengan CI persentil yang
   dikunci:
   - **Batas atas:** P(hi < 0,25 | θ = 0) = 98,3%. Ini sejalan dengan model.
   - **Superioritas:** P(lo > 0 | θ = 0,25) = **82,1%** dan P(lo > 0 | θ = 0,10) = 9,3%. Model normal pada SE yang sama
     memperkirakan ±96% untuk θ = 0,25.
   - **Penyebab selisihnya:** komponen waktu (−0,019), SE bootstrap yang 10% konservatif, dan batas bawah yang jatuh
     2,4 SE di bawah titik.
   - **Akibatnya, MDE superioritas efektif ±0,25 ATR**, bukan 0,17–0,18. **Klaim MDE 0,18 tidak bertahan** sesudah
     diagnostik coverage. Klaim daya batas atas tetap bertahan.
   - Peluang keputusan untuk CI basic dan BC ada di §8.5.
3. **Daya prospektif: belum diketahui (UNVERIFIED).** Daya ini bergantung pada laju alert dan rezim pasar 2026-11 →
   2028-11.
   - Ke-100 simbol aktif sepanjang jendela, jadi n kemungkinan lebih besar daripada jendela historis, dan SE lebih kecil.
   - Korelasi bersama dan rezim bisa bekerja ke arah sebaliknya.
   - Angka di atas bukan janji hasil.

## 10. Status pembekuan: ditunda

- **Hash kandidat pohon kode AL-MOM-01.** `f3004d2c3f32d9df3924f5f266505268e6fd49da3d41441393ce758de8fe5c28` (145 file:
  `backend/` + runner). Semua validasi dan simulasi di dokumen ini memakai kode dengan hash ini.
  - Hash ini **belum** dicatat sebagai baris beku di docs/28 §9.1, jadi `--mode evaluate` menolak berjalan.
  - Bila pemilik memilih "tetap persentil", baris beku ditambahkan dengan hash yang sama, asalkan runner tidak berubah.
- **Hash AL-SA-ATR-01.** Tetap `25c022560e99565ecc3de0f62872d5116da756caf89984c589bcd74ac2f8b314`.
- **SHA-256 file.**

  | File | SHA-256 |
  |---|---|
  | `scripts/research-al-mom-01.js` | `25af1b6db48d2e02c5c0be711b78e23e27c11066492439ba1beaa3b2be53af92` |
  | `scripts/research-al-mom-01-coverage.js` | `669c621f251adb523506135dbdaff191979aa474ff59d464df922d3777e0a611` (run keputusan §8.5). Run inti §8.2–§8.4 dan run stres §8.6 memakai versi `e3f7afdc…`, yang hanya berbeda karena belum menyimpan peluang keputusan per metode CI dan ringkasan per simulasi; fungsi simulasi per dataset sama |
  | `tests/unit/research/alMom01.test.js` | `94ada32cd106c7e88d7ab3f193ff043282f03a0425e9f5311e16b4c111de995c` |
  | `scripts/research-window-guard.js` | `c139430518f5844535eaee34218e947bc242ad6e80138ebf15adab7a1bf52dba` |

- **Bootstrap.** 10.000 replikasi, benih `20261116`, blok 7 hari; sensitivitas 14 hari dan harian, populasi tetap, himpunan
  sama, alert saja.
- **Presisi MC.** Benih `20261117` … `20261126`.
- **Replikasi tidak valid.** Dikeluarkan dan dihitung; bila > 1% → tidak stabil → kelompok 4 (keputusan pemilik).
- **SMD.** Ambang 0,10 dan 0,20. Sensitivitas bin 0,25 ATR selalu dihitung dan ditandai bila dipicu.
- **Laporan.** Format dan urutan bagian di docs/28 §9.1.
- **Commit pembekuan.** Belum ada. Commit pembekuan nanti adalah commit yang menambahkan baris hash beku ke docs/28 §9.1.

## 11. Tes otomatis

| Jenis | Hasil |
|---|---|
| Lint (`npm run lint`) | bersih |
| Vitest (`npx vitest run`) | 158 file; 2.376 lulus, 1 dilewati (sebelumnya 157 file, 2.359) |
| Tes AL-MOM-01 | UNIT-MOM01-001…017, semuanya lulus |
| Playwright (`npm run test:e2e`) | 148/148, desktop dan mobile; UI tidak berubah |
| Integrasi | Validasi historis 100 koin dengan runner (693 s dan 1.545 s; dua kali, sebelum dan sesudah perbaikan), plus simulasi end-to-end UNIT-MOM01-012 |

Cakupan tes AL-MOM-01:

- **Konfigurasi dan hash:**
  - cakupan hash dan impor mandiri;
  - paritas kelayakan, fitur, dan pengumpulan dengan `research-mom-power.js`;
  - jendela, tersil populasi jendela, dan delisting.
- **Mode count:** fungsi hasil tidak pernah dipanggil, dan keluarannya tanpa A/B.
- **Delisting:** paritas dengan audit AL-SA-ATR-01, serta data yang berhenti sebelum cutoff.
- **SMD:** rumus, varians nol, dan rata-rata null.
- **Bootstrap:**
  - determinisme, blok terakhir dipotong, dan varian;
  - replikasi tidak valid dan aturan 1%;
  - fallback per replikasi.
- **Keputusan dan pengaman:**
  - pembanding metode CI;
  - kelompok §6;
  - pengaman semua mode, termasuk folder log dan cache;
  - analisis ujung ke ujung yang deterministik;
  - "tidak terestimasi" untuk subkelompok kosong;
  - DGP dan agregasi simulasi;
  - penjaga skrip lama.

Yang tidak dijalankan:

- **Mode count dan evaluate pada data jendela.** Jendela baru dimulai 2026-11-16, dan evaluate memang ditolak. Kedua mode
  ini diuji lewat fungsi dan pengamannya saja.
- **Panggilan jaringan ke Binance.**

## 12. Risiko metodologis yang tersisa

1. **Komponen waktu estimand.**
   - Tanpa informasi apa pun, estimand utama di simulasi = −0,019 ATR, karena pembanding sebelum alert menangkap gerak
     pemicu.
   - Besarnya di data nyata tidak bisa dipisahkan dari informasi. Bila SA/PVA memicu alert lebih lambat daripada DGP
     sintetis, komponennya bisa lebih besar.
   - Ini sifat estimand yang dikunci (pembanding kausal "tanpa", docs/25), bukan bug. Arahnya merugikan klaim SA/PVA.
2. **Galat satu sisi CI persentil.** Keputusan pemilik masih terbuka (§13). Datanya di §8.4–§8.5.
3. **Kalibrasi pada struktur ketergantungan nyata belum terbukti (UNVERIFIED).**
   - Di DGP sintetis, SE prosedur penuh hanya ±5% lebih kecil dari alert saja. Di data historis, 29% lebih kecil.
   - Simulasi menguji mekanisme yang sama (pembanding berbagi jendela dengan alert), tetapi dengan kekuatan pasangan yang
     lebih lemah.
   - Pergeseran median bootstrap historis (−0,28 SE) setara dengan skenario dasar efek +0,10 di simulasi.
4. **Generalisasi rezim.** CI mencerminkan variasi sampling di dalam jendela 24 bulan, bukan rezim pasar di luarnya
   (§8, skenario serial).
5. **Atenuasi.** Efek informasi berupa drift 12 candle hanya tertangkap ±85%. Margin 0,25 ATR adalah skala estimand,
   setara drift ±0,29 ATR.
6. **Skrip riset terkunci.** `research-matched.js` dan `research-timing.js` (hash docs/25 §1.6) masih bisa diberi
   `--to` sesudah 2026-11-16. Yang menjaganya hanya protokol docs/28 §8.
7. **Label trade di replay.** `replaySeries` di mode count menghitung label trade SA/PVA dengan stop struktur secara
   internal (bukan A atau B), lalu langsung dibuang. Ini tidak bisa dihindari tanpa mengubah backend beku.
8. **Definisi alert.** Alert = trade v3. Event yang gagal menjadi trade (gap melewati invalidasi) tidak dihitung dan tidak
   dikeluarkan dari pembanding; jumlahnya tidak terlihat dari luar backend.
9. **Integritas data.** Bergantung pada exchangeInfo dan daftar delisting manual. Simbol yang hilang tanpa catatan manual
   memblokir evaluate, dan memang dirancang begitu.
10. **Strata ex-post.** Tersil ATR% dan keberadaan pembanding ditentukan atas seluruh kuartal. Ini bagian dari estimand
    (simetris; tidak memakai hasil), dan salah satu sumber komponen waktu.
11. **Bias survivorship di validasi historis.** Semesta dipilih 2026-11-15. Di jendela prospektif bias ini tidak ada,
    karena tidak ada penggantian simbol.
12. **Batas simulasi.** 40 simbol (bukan 100). Alert berasal dari model hazard, bukan replay SA/PVA, yang tidak menghasilkan
    alert pada data sintetis. DGP disederhanakan.
13. **Tepi MBB.** 6 hari pertama dan terakhir sedikit kurang terwakili (awal blok seragam tanpa wrap). Dampaknya kecil
    untuk D = 729.

## 13. Keputusan pemilik

1. **Metode CI (§5) dan pembekuan.** Pemilik memutuskan **menunda pembekuan** sampai hasil skenario stres dan tinjauan
   berikutnya tersedia. Pilihannya:
   - **Tetap persentil.** AL-MOM-01 dibekukan apa adanya. Galat satu sisi didokumentasikan, dan laporannya memuat CI basic
     dan BC beserta penanda "rapuh terhadap metode CI".
   - **AL-MOM-02.** Uji baru yang identik dengan AL-MOM-01 kecuali metode CI (basic atau BC dari prosedur penuh yang
     sama). Dikunci sebelum outcome jendela dibuka.

   Dasar pilihannya ada di §8.4–§8.5: galat keputusan, dan daya yang dibayar untuk tiap metode. Selama belum beku,
   `--mode evaluate` menolak berjalan. Count, audit, dan protokol akses tetap berlaku.
2. **Kelompok koin kedua.** Opsional: kohort lama/baru AL-SA-ATR-01 sebagai ciri tambahan alert tak cocok. Saat ini yang
   dipakai adalah 27 koin pengembangan vs lainnya.
