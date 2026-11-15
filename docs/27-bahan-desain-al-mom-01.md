# 27 — Bahan desain AL-MOM-01: daya uji SA/PVA vs momentum murni (2026-11-16, belum praregistrasi)

**Status: bahan diskusi dan draf keputusan (§8), bukan praregistrasi.** Semua angka di sini berasal dari data historis
(sinyal 2024-01 → 2026-10: §2–§4 dari 31 koin cache, §7 dari 100 koin semesta AL-SA-ATR-01), dan dipakai untuk memilih
desain, bukan sebagai bukti.

**Urutan disepakati** (tinjauan ChatGPT, disetujui pemilik): AL-SA-ATR-01 (docs/26) diselesaikan dulu, lalu AL-MOM-01,
baru sesudah itu optimasi entri/keluar. Hasil A/B memakai alert yang sama dengan AL-SA-ATR-01, jadi AL-MOM-01 tidak
boleh dijalankan pada data sesudah 2026-11-16 sebelum AL-SA-ATR-01 dievaluasi.

## 1. Pertanyaan dan dua eksperimen

Apakah alert LONG 1h SA/PVA v3 lebih baik daripada momentum biasa? Usulan ChatGPT memisahkannya menjadi dua eksperimen.

- **A — nilai informasi.**
  - Hasil: gerak lanjutan 12 candle dalam ATR, tanpa geometri trade.
  - Pembanding: candle tanpa alert di strata yang sama (simbol × kuartal × gerak awal × posisi rentang × tersil ATR%,
    seperti docs/25).
  - Pembanding utama "tanpa" (semua candle tanpa alert v2/v3 searah), sensitivitas "lampau" (tanpa alert di candle itu
    atau 12 candle sebelumnya). Keduanya tidak memakai informasi masa depan (docs/25 §2.2).
- **B — nilai strategi dengan geometri identik.**
  - Alert dan pembanding sama-sama entri di open candle berikutnya, stop 1,5 × ATR14, target 2R, batas 48 candle, dan
    fee 5 + slippage 2 bps per sisi.
  - Yang diukur: selisih R per alert terhadap rata-rata strata.
  - Keunggulan stop struktur SA/PVA sengaja dihilangkan, supaya yang diukur hanya pemilihan waktu entri.

## 2. Hasil historis (deskriptif)

Laporan: `reports/research/mom-power-20261115T174816Z.{md,json}` (`npm run research:mom-power`, 245 s). Paritas: A
"tanpa" sama persis dengan docs/25 §2.2.

| Pembanding | Alert cocok | A: gerak 12 candle, alert vs pembanding | A: selisih [CI blok 7 hari] | B: R, alert vs pembanding | B: selisih [CI blok 7 hari] |
|---|---|---|---|---|---|
| tanpa (utama) | 1.687 (98,5%) | +0,25 vs +0,16 ATR | +0,09 [−0,09 … +0,31] | +0,01 vs −0,04 | +0,04R [−0,04 … +0,13] |
| lampau | 1.634 (95,4%) | +0,23 vs +0,12 ATR | +0,11 [−0,08 … +0,34] | −0,00 vs −0,05 | +0,05R [−0,04 … +0,16] |

CI blok 14 hari dan harian memberi pembacaan yang sama.

- **Strategi alert saja dengan geometri B** (satu posisi per simbol): +0,02R [−0,08 … +0,12], n 1.685. Angka ini hampir
  sama dengan stop struktur (+0,03R, docs/25 §2.4), jadi pilihan geometri tidak mengubah gambaran.
- **Jarak dari alert sebelumnya** (usul ChatGPT, pembanding "tanpa"): 83% alert muncul ≤ 48 candle sesudah alert v2/v3
  lain.

  | Kelompok | n | Selisih A | Selisih B |
  |---|---|---|---|
  | ≤ 48 candle sesudah alert lain | 1.403 | +0,07 ATR [−0,13 … +0,30] | +0,05R |
  | Tanpa alert dalam 48 candle | 284 | +0,21 ATR [−0,14 … +0,57] | +0,03R |

  Selisih antarkelompok tidak bisa dibedakan dari nol.

## 3. Daya uji

Dasar perhitungan:

- SE blok 7 hari pada n 1.687: A 0,102 ATR, B 0,044R.
- Laju 2,18 alert per simbol-bulan → ±215 alert cocok per bulan di 100 koin. Laju ini diukur dari 31 koin cache; 69 koin
  lainnya belum diukur.
- Uji: "batas bawah CI 95% > 0" dengan daya 80%, dan SE diskalakan dengan √n.

| Lama jendela | Alert cocok | Efek terkecil terdeteksi A | Efek terkecil terdeteksi B |
|---|---|---|---|
| 6 bulan | 1.289 | 0,33 ATR | 0,14R |
| 9 bulan | 1.934 | 0,27 ATR | 0,11R |
| 12 bulan | 2.579 | 0,23 ATR | 0,10R |
| 18 bulan | 3.868 | 0,19 ATR | 0,08R |
| 24 bulan | 5.158 | 0,16 ATR | 0,07R |

Untuk mendeteksi efek sebesar perkiraan historis (A +0,09 ATR, B +0,045R) dibutuhkan ±17.200 dan ±12.600 alert, atau
**±80 dan ±58 bulan** di 100 koin. Efek bulat 0,10 ATR dan 0,05R butuh ±64 dan ±47 bulan. Artinya, uji keunggulan biasa
di 100 koin selama 12 bulan hanya bisa mendeteksi efek 2,2–2,6× perkiraan historis. Kemungkinan besar hasilnya "tidak
terbukti", apa pun kenyataannya.

Proyeksi di bagian ini memakai skala √n dari 31 koin. §7 menggantinya dengan pengukuran langsung di 100 koin.

## 4. Opsi desain (belum dipilih)

1. **Uji batas atas (non-superioritas).** Yang diuji adalah apakah keunggulan SA/PVA lebih kecil dari margin yang
   bermakna. Lulus bila batas atas CI 95% < margin. Waktu untuk daya 80%, bila efek sebenarnya sama dengan perkiraan
   historis:

   | Margin | Waktu di 100 koin |
   |---|---|
   | A 0,35 ATR | ±9 bulan |
   | A 0,30 ATR | ±15 bulan |
   | A 0,25 ATR | ±25 bulan |
   | B 0,15R | ±11 bulan |
   | B 0,12R | ±21 bulan |
   | B 0,10R | ±38 bulan |

   Hasilnya membatasi nilai maksimum pola. Kelemahannya, margin yang terjangkau dalam setahun masih longgar.
2. **Semesta lebih besar.** Pakai semua perpetual USDⓈ-M yang lolos syarat likuiditas. Dengan laju alert yang sama, n
   menjadi ±4× dan efek terkecil terdeteksi turun ±2×. Risikonya, koin tipis punya biaya dan slippage lebih besar.
   (§7.3 membantah perkiraan "±2×": karena sinyal antarkoin berkorelasi, penurunannya hanya ±1,13×.)
3. **Jendela lebih panjang.** Dengan 24 bulan, efek terkecil terdeteksi menjadi A 0,16 ATR dan B 0,07R.
4. **Pengurangan varians.** Misalnya penyesuaian regresi di dalam strata atau winsorizing gerak 12 candle. Opsi ini
   harus diuji dulu pada data historis sebelum dipilih.
5. **Jarak dari alert sebelumnya sebagai strata atau subkelompok.** Alert "segar" punya titik terbesar, tetapi n-nya
   hanya ±17% alert.

## 5. Batas klaim

Kalau AL-MOM-01 nantinya lulus, artinya label SA/PVA punya nilai prediktif tambahan setelah penyesuaian variabel yang
dipilih. Itu belum membuktikan profitabilitas atau hubungan sebab-akibat (tinjauan ChatGPT).

## 6. Alat

- `scripts/research-mom-power.js` (`npm run research:mom-power`), tes UNIT-MOM-001…003. Skrip ini memakai fungsi
  pencocokan dan bootstrap docs/25 apa adanya, serta mask pengecualian dari `scripts/research-matched-exclusion.js`.
  Sejak 2026-11-16 cache berisi 100+ simbol, jadi angka 31 koin §2–§3 diulang dengan `--symbols` berisi 31 koin itu:
  27 koin `DOCS27_IN_UNIVERSE` di `scripts/research-mom-sim.js`, ditambah APRUSDT, DOODUSDT, IRYSUSDT, dan QUSDT.
- `scripts/research-mom-sim.js` (`npm run research:mom-sim`), tes UNIT-MOM-004…006: simulasi §7 di 100 koin semesta
  AL-SA-ATR-01. Opsi `--save-acc`/`--load-acc` menyimpan agregat, supaya analisis bisa diulang tanpa replay.

## 7. Simulasi daya di 100 koin (2026-11-16)

Pemicunya tinjauan ChatGPT (2026-11-16). Proyeksi §3 memakai skala √n dari 31 koin, dan belum mengukur laju alert koin
lain, korelasi sinyal lintas simbol, maupun pergeseran rezim.

**Data.** Kline 1h historis untuk 73 koin semesta AL-SA-ATR-01 yang belum ada di cache diunduh dari REST Binance
(2024-01 → 2026-10, 1,23 juta candle). Seluruhnya sebelum jendela uji AL-SA-ATR-01. Laporan:
`reports/research/mom-sim-20261115T190220Z.{md,json}` (`npm run research:mom-sim`, 715 s). Semesta dipilih pada
2026-11-15 menurut volume saat itu, jadi data historisnya punya bias survivorship. Karena itu laju dan SE lebih bisa
dipakai daripada titik efek.

### 7.1 Laju alert dan efek historis

| Kelompok | Alert per simbol-bulan | n cocok | A: selisih [CI 7 hari] | B: selisih [CI 7 hari] |
|---|---|---|---|---|
| 27 koin docs/27 (yang ada di semesta) | 2,20 | 1.589 | +0,07 [−0,10 … +0,28] ATR | +0,050 [−0,034 … +0,140]R |
| 73 koin tambahan | 2,02 | 3.381 | −0,02 [−0,16 … +0,12] ATR | −0,020 [−0,087 … +0,054]R |
| 100 koin | 2,07 | 4.970 (99% alert) | +0,01 [−0,13 … +0,15] ATR | +0,003 [−0,060 … +0,070]R |

- **Koin tambahan tidak menunjukkan keunggulan.** Koin ini tidak dipakai saat pola dikembangkan dan diperiksa
  (docs/24–25). Jadi titik 31 koin di §2 (+0,09 ATR) kemungkinan besar terlalu optimistis. Sensitivitas "lampau"
  memberi gambaran yang sama: A +0,01, B −0,005.
- **Laju koin tambahan 8% lebih rendah.** Ini indikasi (bukan hitungan ulang) bahwa perkiraan ±8,4 bulan untuk n 600
  AL-SA-ATR-01 (docs/26 §4) bisa sedikit lebih lama.

### 7.2 SE langsung vs proyeksi √n

Jendela 12 dan 24 bulan bergeser per kuartal di 100 koin.

| Jendela | SE A: median [min … maks] | SE B: median [min … maks] | Jendela terakhir: A · B | Proyeksi √n gaya §3: A · B | Rasio median/proyeksi |
|---|---|---|---|---|---|
| 12 bulan (8 jendela) | 0,115 [0,102 … 0,140] | 0,051 [0,045 … 0,063] | 0,102 · 0,046 | 0,077 · 0,035 | 1,51 · 1,48 |
| 24 bulan (4 jendela) | 0,086 [0,080 … 0,099] | 0,041 [0,038 … 0,044] | 0,083 · 0,038 | 0,054 · 0,025 | 1,59 · 1,67 |

- **Proyeksi diulang dari 27 koin docs/27** dengan cara §3, supaya perbandingannya setara.
- **Median sedikit pesimistis.** Jendela awal memuat lebih sedikit koin, karena banyak yang baru listing. Jendela 12
  bulan terakhir punya 215 alert cocok per bulan, sama dengan perkiraan jendela maju, dan SE-nya tetap 1,3×
  proyeksi.
- **Jadi proyeksi √n §3 terlalu optimistis 30–70%.** Penyebab utamanya ada di §7.3.

### 7.3 Efek desain lintas simbol

SE periode penuh pada subset simbol acak (20 undian per ukuran):

| Jumlah simbol | 10 | 25 | 50 | 75 | 100 |
|---|---|---|---|---|---|
| SE A (ATR) | 0,139 | 0,099 | 0,084 | 0,076 | 0,073 |
| SE B (R) | 0,068 | 0,048 | 0,040 | 0,035 | 0,033 |

- **Sebagian besar varians bersifat bersama.** Model SE² = a + b/k (k = jumlah simbol) memberi bagian bersama a = 72%
  (A) dan 67% (B) dari SE² di 100 simbol. Bagian ini berasal dari hari-hari ketika banyak koin bergerak bersama, dan
  tidak mengecil bila simbol ditambah.
- **4× simbol hampir tidak menolong.** Dengan ±400 koin, SE hanya mengecil 1,13× (A) dan 1,15× (B), bukan 2×. Efek
  terkecil yang terdeteksi turun ±12%, bukan ±50%.
- **Yang mengecilkan SE adalah waktu.** SE 24 bulan ≈ 0,75–0,80× SE 12 bulan (akar rasionya 0,71).

### 7.4 Daya uji batas atas

Daya dihitung dari SE median antarjendela. Efek sebenarnya diasumsikan sama dengan titik 100 koin, yaitu hampir nol.

> **Pembaruan (§9.4):** SE di sini berasal dari bootstrap alert saja. Bootstrap yang mengulang prosedur, yaitu metode
> yang dikunci docs/28 §5, memberi SE ±25% lebih kecil. Jadi angka daya di bagian ini konservatif.

| Hasil | Margin | Batas | Daya 12 bulan | Daya 24 bulan | Bulan untuk daya 80% |
|---|---|---|---|---|---|
| A | 0,25 ATR | dua sisi | 56% | 80% | 24 |
| A | 0,25 ATR | satu sisi | 68% | 88% | 19 |
| A | 0,30 ATR | dua sisi | 72% | 92% | 16 |
| A | 0,30 ATR | satu sisi | 81% | 96% | 13 |
| B | 0,10R | dua sisi | 47% | 66% | 33 |
| B | 0,10R | satu sisi | 60% | 77% | 26 |
| B | 0,12R | dua sisi | 63% | 82% | 23 |
| B | 0,12R | satu sisi | 74% | 89% | 18 |

- **Pengaruh pilihan SE.** Dengan SE jendela terakhir, daya 24 bulan sedikit lebih tinggi: A 0,25 dua sisi 83%, B 0,10
  dua sisi 72%. Dengan SE jendela terburuk lebih rendah: A 0,25 dua sisi 69%.
- **Superioritas lebih lemah dari perkiraan §3.** Untuk batas bawah CI 95% > 0 dengan daya 80%, efek terkecil yang
  terdeteksi adalah A 0,32 ATR (12 bulan) dan 0,24 ATR (24 bulan), serta B 0,14R dan 0,115R. Angka §3 untuk A adalah
  0,23 dan 0,16 ATR.

### 7.5 Jarak dari alert sebelumnya (pembanding "tanpa")

| Jarak | Porsi alert | Porsi candle pembanding | n cocok | A [CI 7 hari] | B [CI 7 hari] |
|---|---|---|---|---|---|
| ≤ 12 candle | 43% | 18% | 2.116 | +0,06 [−0,11 … +0,25] | +0,019 [−0,064 … +0,112] |
| 13–48 candle | 40% | 41% | 2.012 | −0,08 [−0,24 … +0,10] | −0,004 [−0,087 … +0,078] |
| > 48 atau belum ada ("segar") | 17% | 41% | 842 | +0,08 [−0,14 … +0,33] | −0,021 [−0,128 … +0,094] |

- **Penyesuaian jarak perlu untuk keseimbangan.** Alert jauh lebih sering muncul dekat alert lain dibanding candle
  pembanding: 43% vs 18% dalam 12 candle.
- **Overlap memadai.** Dengan strata + jarak, 91% alert tetap mendapat pembanding. Hasilnya A +0,01 [−0,13 … +0,15]
  dan B +0,008 [−0,058 … +0,078]; titiknya tidak berubah dan SE nyaris sama (A 0,071 vs 0,073).
- **Interaksi tidak terbukti.** Selisih segar − berulang: A +0,09 [−0,14 … +0,31], B −0,029 [−0,134 … +0,087].

### 7.6 Jangkar biaya

- **Biaya pulang-pergi pada alert cocok.** Fee + slippage 14 bps setara median 0,11 ATR [kuartil 0,08 … 0,16], atau
  0,076R [0,055 … 0,105] dengan stop 1,5 ATR.
- **Margin dalam satuan biaya.** Margin A 0,25 ATR ≈ 2,2× biaya pulang-pergi, dan margin B 0,10R ≈ 1,3× biaya.
- **Margin yang lebih ketat tidak terjangkau.** Margin A sebesar satu kali biaya (0,11 ATR) butuh ±125 bulan untuk
  daya 80%.

### 7.7 Kesimpulan untuk desain

1. **Semesta tetap 100 koin.** Perluasan ke ±400 koin hanya memperkecil SE ±12%, karena ±70% varians bersifat bersama.
   Biaya data dan likuiditas koin tipis tidak sebanding.
2. **Horizon 24 bulan memang perlu.** Dalam 12 bulan, tidak ada margin kandidat yang mencapai daya 80% dengan batas dua
   sisi.
3. **A dengan margin 0,25 ATR layak secara daya** (24 bulan: 80% dua sisi, 88% satu sisi) bila efek sebenarnya ≈ 0,
   seperti di data 100 koin. B dengan 0,10R sebagai hasil sekunder kurang daya (66% dua sisi). Dengan bootstrap
   prosedur penuh, dayanya naik menjadi 96% (A) dan 78% (B); lihat §9.4.
4. **Uji ini hanya bisa menyingkirkan keunggulan besar.** Margin yang bisa diuji (0,25 ATR ≈ 2,2× biaya) tidak
   menyingkirkan keunggulan kecil yang masih bernilai. Uji superioritas pun hanya mendeteksi keunggulan ≥ 0,24 ATR.
5. **Jarak alert masuk sebagai strata.** Ketidakseimbangannya besar, dan overlap 91% memadai.
6. **Perkiraan daya memakai titik 100 koin (≈ 0)**, bukan titik 31 koin yang kemungkinan terlalu optimistis.

## 8. Draf keputusan desain (2026-11-16, belum beku)

> **Pembaruan:** inti desain ini sudah dikunci di docs/28 (2026-11-15 UTC, sebelum data uji ada). Yang diputuskan
> sesudah tinjauan ChatGPT berikutnya: CI 95% dua sisi; beban pembuktian ada pada SA/PVA, dengan tabel keputusan
> produk; margin 0,25 ATR sebagai batas deskriptif; jendela mulai 2026-11-16 dengan protokol akses; dan estimand pada
> populasi overlap. Tabel di bawah dipertahankan sebagai catatan proses.

Dari tinjauan ChatGPT (2026-11-16) dan keputusan pemilik pada hari yang sama. Angka pendukungnya di §7.

| Unsur | Draf | Catatan |
|---|---|---|
| Hasil utama | **A**: nilai informasi, yaitu gerak 12 candle alert vs pembanding strata "tanpa" | Pemilik: AlphaLens adalah scanner; nilai strategi alert sudah diuji AL-SA-ATR-01 |
| Hasil sekunder | **B**: R dengan geometri identik, dilaporkan tetapi tidak menentukan vonis | Daya pada 24 bulan dengan margin 0,10R dua sisi: 66% dengan bootstrap alert saja (§7.4), 78% dengan bootstrap prosedur penuh (§9.4) |
| Jenis uji | Batas atas (non-superioritas) untuk A dengan margin kandidat 0,25 ATR; batas bawah > 0 (superioritas) dibaca dari CI yang sama | 0,25 ATR ≈ 2,2× biaya pulang-pergi (§7.6), jadi uji ini hanya menyingkirkan keunggulan besar (§7.7) |
| Batas CI | Belum diputuskan. Usulan: CI 95% dua sisi, yaitu α 2,5% per arah | Konsisten dengan docs/25–26; satu CI menjawab kedua arah tanpa menaikkan galat total |
| Horizon | Maksimal 24 bulan | |
| Semesta | 100 simbol beku AL-SA-ATR-01 | Perluasan tidak direncanakan: 4× simbol hanya memperkecil SE 1,13× (§7.3). Kalau tetap dipertimbangkan, syarat likuiditasnya memakai data pada waktunya (point-in-time) |
| Jarak dari alert sebelumnya | Strata penyesuaian (≤ 12, 13–48, > 48 candle); kelompok "segar" sebagai subkelompok sekunder; interaksi segar vs berulang diuji eksplisit | Overlap 91% (§7.5). Dihitung sama untuk alert dan pembanding, hanya melihat ke belakang |
| Pembanding | "tanpa" utama, "lampau" sensitivitas | Dua estimand berbeda; tidak ditukar karena overlap |
| Candle datar pasca-delisting | Sinyal pada atau sesudah waktu delisting dikecualikan oleh aturan | AL-MOM-01 belum beku, jadi aturan ini bisa masuk kodenya (beda dengan AL-SA-ATR-01, docs/26 §11) |
| Pembekuan | Paling lambat sebelum `--mode evaluate` AL-SA-ATR-01 | Evaluasi itu membuka R alert yang sama di jendela yang sama |

Dengan satu CI 95% dua sisi dan margin M, hasilnya jatuh ke salah satu dari empat kelompok:

| Batas bawah | Batas atas | Bacaan |
|---|---|---|
| > 0 | < M | Lebih baik dari momentum, tetapi keunggulannya < M |
| > 0 | ≥ M | Lebih baik dari momentum |
| ≤ 0 | < M | Keunggulan, kalau ada, < M |
| ≤ 0 | ≥ M | Tidak konklusif |

**Yang tadinya masih terbuka** (keempatnya sudah diputuskan; lihat catatan pembaruan di atas dan docs/28):

- margin akhir dan dasar ekonominya;
- batas CI satu atau dua sisi;
- keputusan produk untuk setiap kelompok hasil. Contohnya, apakah SA/PVA tetap dipakai bila hasilnya "keunggulan < M"
  atau "tidak konklusif". Dengan daya §7, kemungkinan terbesar adalah salah satu dari dua kelompok itu;
- apakah jendela AL-MOM-01 mulai 2026-11-16, berbagi data dengan AL-SA-ATR-01 dan dinyatakan sebagai "data sudah
  terkumpul tetapi belum diakses", atau mulai pada tanggal pembekuannya.

## 9. Diagnostik overlap dan bootstrap (2026-11-16)

Pemicunya tinjauan ChatGPT (2026-11-16). Empat hal diminta: estimand pada populasi overlap, ciri alert tanpa pembanding,
batas ketidakseimbangan kovariat, dan bootstrap yang mengulang prosedur estimasi. Datanya sama dengan §7 (100 koin,
sinyal 2024-01 → 2026-10). Laporan: `reports/research/mom-overlap-20261115T195046Z.{md,json}`
(`npm run research:mom-overlap`; replay 751 s, analisis 90 s).

### 9.1 Cakupan dan sensitivitas estimand

CI di tabel ini berasal dari bootstrap alert saja, sama dengan §7.

| Pencocokan | Alert cocok | A [CI 7 hari] | B [CI 7 hari] |
|---|---|---|---|
| Strata dasar | 4.970 (99%) | +0,01 [−0,13 … +0,15] | +0,003 [−0,060 … +0,070] |
| Strata + jarak (estimand docs/28) | 4.592 (91%) | +0,01 [−0,13 … +0,15] | +0,008 [−0,058 … +0,078] |
| Fallback: strata + jarak, selain itu dasar | 4.970 (99%; 378 lewat dasar) | −0,00 [−0,14 … +0,14] | −0,001 [−0,065 … +0,067] |

Titiknya tidak bergantung pada pilihan pencocokan.

### 9.2 Alert tanpa pembanding pada strata + jarak (451 alert, 9%)

- **Satu ciri yang berbeda tegas: gerak awal.** 41% punya gerak awal ≥ 4 ATR, padahal di alert yang cocok hanya 11%.
  Jadi ±26% alert dengan gerak awal ≥ 4 ATR tidak mendapat pembanding.
- **Ciri lain mirip:**
  - jarak ≤ 12 candle: 43% vs 43%;
  - posisi rentang ≥ 0,8: 62% vs 60%;
  - koin tambahan: 69% vs 68%;
  - ATR% median: 1,25% vs 1,23%;
  - sebaran tahun juga serupa.
- **Hasilnya bila dicocokkan pada strata dasar** (n 378): A −0,12 [−0,50 … +0,24], B −0,103 [−0,281 … +0,077].
  Memasukkannya lewat fallback hampir tidak mengubah titik keseluruhan.
- **Akibatnya,** kesimpulan AL-MOM-01 terutama berlaku untuk alert dengan gerak awal moderat; cakupannya untuk gerak
  awal ekstrem lebih lemah. Hal ini dilaporkan bersama hasil (docs/28 §7).

### 9.3 Keseimbangan kovariat (SMD sesudah pencocokan)

| Kovariat | Strata dasar | Strata + jarak |
|---|---|---|
| Gerak awal | +0,004 | +0,005 |
| Posisi rentang | +0,070 | +0,067 |
| ATR% | −0,063 | −0,060 |
| Jarak dari alert sebelumnya | **−0,202** | −0,015 |

- **Strata dasar tidak seimbang pada jarak:** alert lebih dekat ke alert sebelumnya dibanding pembandingnya.
- **Strata + jarak memperbaikinya.** Semua |SMD| ≤ 0,07.
- **Usulan untuk pembekuan kode** (docs/28 §9): batas |SMD| ≤ 0,10 per kovariat. Pelanggaran dilaporkan, estimand
  tidak diubah.

### 9.4 Bootstrap yang mengulang prosedur

Tiga versi dibandingkan pada bobot hari yang sama:

- **prosedur penuh:** alert dan pembanding diambil ulang bersama, rata-rata strata dihitung ulang (metode docs/28 §5);
- **alert saja:** rata-rata pembanding tetap, metode yang dipakai docs/25–27;
- **alert saja, himpunan sama:** seperti alert saja, tetapi hanya alert yang juga ikut di versi penuh pada replikasi
  itu.

| SE (strata + jarak) | A: penuh · alert saja · himpunan sama | B: penuh · alert saja · himpunan sama |
|---|---|---|
| Periode penuh | 0,051 · 0,071 · 0,068 | 0,027 · 0,035 · 0,034 |
| Median 12 bulan (8 jendela) | 0,098 · 0,121 | 0,046 · 0,055 |
| Median 24 bulan (4 jendela) | 0,065 · 0,087 | 0,034 · 0,043 |

- **SE prosedur penuh ±25% lebih kecil** (rasio median per jendela 0,74–0,81, dan konsisten di setiap jendela).
- **Penyebabnya bukan alert yang terbuang.** Versi "himpunan sama" hampir sama dengan versi alert saja. Yang terjadi:
  rata-rata pembanding strata bergerak bersama hasil alert pada hari-hari yang sama, jadi desain berpasangan
  mengurangi varians, sedangkan bootstrap alert saja mengabaikannya.
- **Daya dengan SE prosedur penuh:**

  | Hasil, margin | Daya 12 bulan (dua sisi) | Daya 24 bulan (dua · satu sisi) | Bulan untuk daya 80% (dua · satu sisi) |
  |---|---|---|---|
  | A 0,25 ATR | 69% | 96% · 98% | 14 · 11 |
  | A 0,30 ATR | 85% | 99% · 100% | 9 · 7 |
  | B 0,10R | 51% | 78% · 86% | 25 · 20 |
  | B 0,12R | 68% | 91% · 95% | 17 · 13 |

  Untuk superioritas (batas bawah CI 95% > 0, daya 80%), efek terkecil yang terdeteksi adalah A 0,27 ATR (12 bulan)
  dan 0,18 ATR (24 bulan), serta B 0,13R dan 0,095R.
- **Margin tidak diubah.** 0,25 ATR dipilih sebagai batas deskriptif, bukan karena dayanya (docs/28 §6). Daya yang
  lebih tinggi tidak menjadi alasan untuk menggantinya.
- **docs/25 juga terdampak.** CI docs/25 §2 memakai bootstrap alert saja, jadi kemungkinan juga sedikit konservatif.
  Dengan rasio yang sama, CI selisih A "tanpa" di 31 koin (+0,09 [−0,09 … +0,31], §2) kira-kira menjadi
  [−0,05 … +0,26] dan tetap memuat nol. Kesimpulannya tidak berubah.

### 9.5 Untuk pembekuan kode (docs/28 §9)

- Batas |SMD| ≤ 0,10 per kovariat (usulan §9.3).
- Laporan alert tanpa pembanding memisahkan kelompok gerak awal ≥ 4 ATR.
- Bootstrap prosedur penuh dengan ≥ 10.000 replikasi. Versi alert saja dilaporkan sebagai pembanding metode.
