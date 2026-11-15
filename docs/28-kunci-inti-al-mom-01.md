# 28 — Kunci inti AL-MOM-01: apakah alert SA/PVA membawa informasi di luar momentum (dikunci 2026-11-15, sebelum data uji ada)

**Status: KUNCI INTI.** §2–§8 dikunci sebelum jendela data dimulai (2026-11-16 00:00 UTC); waktu tepatnya ada di
timestamp commit yang menambahkan dokumen ini. Mengubah bagian yang dikunci berarti uji baru (AL-MOM-02 dan seterusnya).
Kode analisis dan rincian di §9 dibekukan kemudian, paling lambat sebelum `--mode evaluate` AL-SA-ATR-01, tanpa membuka
hasil AL-MOM-01 (§8). Keputusan diambil pemilik pada 2026-11-16 WIB berdasarkan tinjauan ChatGPT dan docs/27.

> **Pembaruan 2026-11-16:** kode analisis dan rincian §9 sudah ditulis sebagai **draf** (§9.1). §2–§8 tidak berubah.
> Pembekuan ditunda atas keputusan pemilik. Simulasi coverage menunjukkan CI persentil §5 punya galat satu sisi yang
> tidak simetris (docs/29 §8); keputusannya menunggu hasil skenario stres dan tinjauan berikutnya. Selama belum ada hash
> beku, `--mode evaluate` menolak berjalan.

## 1. Latar

- **Bukti sejauh ini.** docs/25 §2.2–§2.3: setelah bias pemilihan pembanding diperbaiki, alert LONG 1h tidak terbukti
  membawa informasi di luar momentum serupa (31 koin). docs/27 §7: di 100 koin semesta AL-SA-ATR-01, titik historisnya
  +0,01 ATR [−0,13 … +0,15]; di 73 koin yang tidak dipakai saat pola dikembangkan, −0,02 ATR.
- **Daya.** Uji batas atas 0,25 ATR dalam 24 bulan punya daya ±80% bila efek sebenarnya ≈ 0 (docs/27 §7.4).
  Menambah koin hampir tidak menolong (§7.3), jadi yang dipakai adalah waktu.
- **Dua uji, dua pertanyaan.** Keduanya tidak digabung menjadi satu klaim.
  - AL-SA-ATR-01 (docs/26) menguji apakah filter momentum 2,7 ATR menghasilkan expectancy bersih positif.
  - AL-MOM-01 menguji apakah SA/PVA memberi informasi tambahan dibanding momentum yang serupa.

## 2. Pertanyaan dan estimand

**Pertanyaan.** Apakah alert LONG 1h SA/PVA v3 diikuti gerak harga 12 candle yang lebih baik daripada candle tanpa alert
yang punya momentum, posisi rentang, volatilitas, dan riwayat alert serupa?

**Estimand utama (A).** ATT gerak 12 candle searah LONG, yaitu (close[i+12] − close[i]) ÷ ATR14[i]: rata-rata selisih
antara alert dan rata-rata candle pembanding di strata yang sama (§4). Estimand ini dihitung **pada alert yang punya
pembanding di strata itu (populasi overlap)**. Alert tanpa pembanding tidak masuk estimand utama; jumlah, ciri, dan
sensitivitasnya dilaporkan (§7).

**Hasil sekunder (B).** Selisih R dengan geometri identik untuk alert dan pembanding:

- entri di open candle i+1, stop 1,5 × ATR14[i], target 2R, batas 48 candle;
- fee 5 + slippage 2 bps per sisi;
- label `labelTrade` apa adanya.

B dilaporkan, tetapi tidak menentukan vonis.

## 3. Data, semesta, dan jendela

| Unsur | Aturan |
|---|---|
| Semesta | 100 simbol beku AL-SA-ATR-01 (`AL_SA_ATR_01.universe`, docs/26 §3), tanpa penggantian |
| Sinyal | `replaySeries` varian v3 (state machine + gerbang tier ≥ B, sama dengan live), arah LONG, timeframe 1h, pada backend dengan hash pohon docs/26 §8 (commit beku `00d33d6`). Satu alert = event pertama ke state alert sejak NO_PATTERN (definisi docs/24–25) |
| Jendela | Candle (alert dan pembanding) dengan openTime di [2026-11-16 00:00 UTC, 2028-11-16 00:00 UTC − 50 candle). Data dimuat sampai cutoff tetap 2028-11-16 00:00 UTC, mulai 30 hari sebelum jendela untuk pemanasan |
| Kelayakan candle | Sama dengan `scripts/research-mom-power.js` pada commit yang menambahkan dokumen ini: ATR14 > 0, gerak 12 dan 48 candle tersedia, dan trade B selesai sebelum cutoff |
| Data | Cache dan audit bersama AL-SA-ATR-01 (docs/26 §10–§11): kline 1h dari REST Binance, dengan manifest status per simbol-bulan |
| Candle datar sesudah delisting | Alert dan pembanding dengan openTime pada atau sesudah waktu delisting yang terverifikasi (docs/26 §11.2) dikecualikan |

## 4. Pembanding dan pencocokan

- **Pembanding utama "tanpa":** semua candle layak yang bukan candle alert v2/v3 LONG.
- **Sensitivitas "lampau":** juga tanpa alert di 12 candle sebelumnya (docs/25 §2.2). "tanpa" dan "lampau" adalah dua
  estimand berbeda dan tidak ditukar.
- **Strata (coarsened exact matching):** simbol × kuartal kalender UTC × bin gerak awal 12 candle (0,5 ATR, ujung −4
  dan +6 digabung) × bin posisi rentang Donchian 48 (0,2) × tersil ATR% per simbol × kuartal × **jarak dari alert v2/v3
  LONG sebelumnya** (≤ 12, 13–48, atau > 48 candle/belum ada). Jarak dihitung dengan cara yang sama untuk alert dan
  pembanding, dan hanya melihat ke belakang.
- **Rata-rata pembanding:** rata-rata hasil semua candle pembanding di strata, dengan bobot sama per candle.

## 5. Analisis statistik

- **CI 95% dua sisi** untuk ATT A dan B, lewat moving-block bootstrap atas hari kalender dengan blok 7 hari yang
  **mengulang prosedur estimasi**. Di setiap replikasi:
  - alert dan candle pembanding diambil ulang bersama per blok hari, dan semua simbol pada hari yang sama ikut bersama;
  - rata-rata pembanding per strata dihitung ulang;
  - alert yang strata-nya tidak punya pembanding pada replikasi itu tidak ikut.

  CI = persentil 2,5% dan 97,5%, dengan paling sedikit 10.000 replikasi; benihnya ditetapkan di §9.
- **Satu analisis, sekali,** pada cutoff 2028-11-16. Tidak ada analisis sela, penghentian dini, atau perpanjangan,
  termasuk bila CI mendekati batas.

## 6. Kriteria dan arti hasil

Margin M = **0,25 ATR**, sebagai batas deskriptif (keputusan pemilik 2026-11-16). CI 95% dua sisi ATT A = [lo, hi].

| Kelompok | Syarat | Bacaan | Keputusan produk |
|---|---|---|---|
| 1 | lo > 0 dan hi < M | Lebih informatif daripada momentum; keunggulannya < 0,25 ATR | Pola dipertahankan; klaim keunggulan prediktif terbatas sesuai CI |
| 2 | lo > 0 dan hi ≥ M | Lebih informatif daripada momentum | Pola dipertahankan; besar keunggulan belum dibatasi |
| 3 | lo ≤ 0 dan hi < M | Keunggulan, kalau ada, < 0,25 ATR | Dipertahankan sebagai klasifikasi momentum, tanpa klaim nilai tambah |
| 4 | lo ≤ 0 dan hi ≥ M | Tidak konklusif | Status riset; klaim tidak berubah |

- **Beban pembuktian ada pada SA/PVA.** Klaim bahwa SA/PVA lebih informatif daripada momentum hanya boleh dibuat pada
  kelompok 1–2.
- **Margin bukan batas nilai ekonomi.** 0,25 ATR ≈ 2,2× biaya pulang-pergi (docs/27 §7.6). Kelompok 3 hanya
  menyingkirkan keunggulan besar, bukan semua keunggulan yang berguna.
- **Fitur tidak dihapus hanya karena uji ini.** Penghapusan adalah keputusan produk yang menimbang biaya pemeliharaan,
  manfaat bagi pengguna, dan riset lain.
- **Modal nyata butuh bukti lain.** Hasil A tidak membuktikan profitabilitas. Keputusan memakai uang nyata bergantung
  pada bukti profitabilitas sesudah biaya dan risiko (misalnya AL-SA-ATR-01), bukan pada A.
- **Standar bukti.** Tidak menemukan keunggulan bukan kegagalan riset; mengklaim keunggulan tanpa bukti yang memadai
  adalah kegagalan riset.

## 7. Yang dilaporkan, tetapi bukan penentu

- **B** dengan CI yang sama.
- **Sensitivitas pencocokan:**
  - pembanding "lampau";
  - strata tanpa jarak;
  - fallback (strata + jarak, selain itu strata dasar).
- **Alert tanpa pembanding:** jumlah, porsi, ciri (jarak, gerak awal, posisi, ATR%, kelompok koin, waktu), dan hasilnya
  bila dicocokkan pada strata dasar.
- **Keseimbangan kovariat** sesudah pencocokan (selisih rata-rata terstandar, SMD) untuk gerak awal, posisi rentang,
  ATR%, dan jarak.
- **Subkelompok** "segar" (> 48 candle) vs berulang, dengan uji interaksi eksplisit (selisih dengan CI bootstrap yang
  sama).
- **Laporan tambahan:** CI blok 14 hari dan harian, laju alert per bulan, rezim BTC seperti docs/26 §10.3, dan CI
  versi bootstrap alert saja sebagai pembanding metode.
- **Hubungan dengan AL-SA-ATR-01.** AL-MOM-01 adalah uji prospektif dengan periode data bersama dan pembekuan desain
  sebelum outcome dibuka, jadi tidak sepenuhnya independen dari AL-SA-ATR-01. Bila hasil AL-SA-ATR-01 ikut membentuk
  tafsir AL-MOM-01, hubungan itu dijelaskan di laporan.

## 8. Protokol akses data

- **Tidak ada yang menghitung atau membuka hasil A atau B pada data jendela sampai evaluasi AL-MOM-01.** Ini berlaku
  untuk alert, pembanding, kelompok, distribusi, maupun subset, dan mencakup pemilik maupun asisten AI yang bekerja di
  repo.
- **Yang boleh:**
  - audit integritas dan jumlah observasi (docs/26 §10–§11);
  - count AL-SA-ATR-01;
  - uji kode pada data historis sebelum 2026-11-16 atau data sintetis.
- **AL-SA-ATR-01.** Evaluasi tunggalnya (docs/26 §4) membuka R trade SA/PVA dengan stop struktur pada sebagian data
  yang sama. Karena itu kode AL-MOM-01 dibekukan sebelum `--mode evaluate` AL-SA-ATR-01 dijalankan.
- **Siapa yang punya akses** ke data dan kode: pemilik repo serta asisten AI yang dipakainya (Claude Code di repo, dan
  ChatGPT lewat ZIP repo). Repo dan ZIP tidak memuat hasil A atau B, karena hasil itu tidak dihitung sebelum evaluasi.
- **Pelanggaran,** misalnya analisis yang tak sengaja dijalankan, dicatat di §10 dengan tanggal dan isinya. Uji tetap
  dijalankan, tetapi dilaporkan bersama catatan itu.

## 9. Yang dibekukan kemudian (paling lambat sebelum evaluate AL-SA-ATR-01)

- Kode analisis `scripts/research-al-mom-01.js` beserta tes, dan hash pohon kodenya (cara docs/26 §8).
- Jumlah replikasi bootstrap (≥ 10.000) dan benihnya.
- Batas ketidakseimbangan kovariat (SMD) dan cara melaporkan pelanggarannya. Pelanggaran dilaporkan, estimand tidak
  diubah.
- Format laporan dan rincian sensitivitas di §7.

Bagian ini hanya boleh merinci §2–§8, tidak mengubahnya. Sesudah kode dibekukan, perubahan hanya boleh berupa koreksi
kesalahan implementasi yang terdokumentasi, dan tidak boleh dipilih berdasarkan arah hasil.

### 9.1 Draf rincian (2026-11-16, belum beku)

Ditambahkan tanpa membuka hasil A atau B dari data jendela. Pengujian memakai data historis sebelum 2026-11-16 dan data
sintetis saja (§8). Audit implementasinya, termasuk simulasi coverage dan validasi historis, ada di docs/29.

**Kode dan hash.**

- Runner: `scripts/research-al-mom-01.js`, dengan mode `validate`, `count`, dan `evaluate`. File ini mandiri: hanya
  mengimpor `backend/` dan modul bawaan Node. Tes UNIT-MOM01-001 memeriksa hal ini.
- Hash kandidat (belum beku): `f3004d2c3f32d9df3924f5f266505268e6fd49da3d41441393ce758de8fe5c28`. Baris hash beku
  ("Hash pohon kode AL-MOM-01: …") baru ditambahkan saat pembekuan. Tanpa baris itu, `--mode evaluate` menolak berjalan.
- Hash di atas = SHA-256 atas baris "path relatif + SHA-256 isi", diurutkan menurut path, untuk 145 file: semua `.js` di
  `backend/` ditambah `scripts/research-al-mom-01.js` (fungsi `codeTreeHash`; cara docs/26 §8). `backend/` sama persis
  dengan pohon beku AL-SA-ATR-01 (hash docs/26 §8 tetap `25c02256…f8b314`).
- Di luar hash, tetapi SHA-256-nya dicatat:
  - tes `tests/unit/research/alMom01.test.js`: UNIT-MOM01-001…017;
  - simulasi coverage `scripts/research-al-mom-01-coverage.js`.

  Keduanya tercatat di docs/29 §10.
- Commit pembekuan nanti adalah commit yang menambahkan baris hash beku.

**Data dan populasi** (merinci §3):

- **Alert.** Alert = trade v3 LONG dari `replaySeries` dengan opsi bawaan, sama dengan `research-mom-power.js`. Event state
  alert yang tidak menjadi trade (entri sudah melewati invalidasi) tidak dihitung sebagai alert dan tidak dikeluarkan
  dari pembanding.
- **Kelayakan.** Kelayakan ditentukan tanpa menghitung hasil: i ∈ [150, n − 49], ATR14 > 0, open candle i+1 > 0, dan
  stop > 0. Dengan i ≤ n − 49, gerak 12/48 candle tersedia dan trade B pasti selesai. UNIT-MOM01-002 dan -003 memeriksa
  bahwa aturan ini setara dengan `research-mom-power.js`.
- **Tersil ATR%.** Tersil dihitung per simbol × kuartal dari candle analisis saja, yaitu candle jendela sebelum delisting
  dengan ATR > 0. Candle pemanasan tidak ikut.
- **Delisting.** Aturan delisting sama dengan audit AL-SA-ATR-01 (docs/26 §11.2). Candle pada atau sesudah waktu delisting
  yang terverifikasi dikeluarkan. Jumlah candle yang jendela 48 candle-nya melintasi delisting dilaporkan.
- **Hari bootstrap.** Hari bootstrap = hari UTC dari closeTime candle. Rentangnya semua hari kalender jendela
  [2026-11-16, 2028-11-13], termasuk hari kosong.
- **Integritas data tahun kedua.** Audit AL-SA-ATR-01 tidak menerima cutoff > 2027-11-16. Untuk bulan sesudahnya,
  `--mode count` AL-MOM-01 menjadi log integritas: celah, candle datar bervolume 0, dan status delisting per simbol.
  Lognya ditulis append-only di `research-log/al-mom-01/`.

**Bootstrap** (merinci §5):

- **Replikasi dan benih.** 10.000 replikasi, benih `20261116`, blok 7 hari, dan awal blok diambil seragam di [0, D − 7].
  Ada ⌈D/7⌉ blok, dan blok terakhir dipotong, sehingga deret hasil resampling tepat D hari (MBB baku).
- **Persentil.** CI = nilai terurut ke-⌊p·m⌋ dari m replikasi valid, untuk p = 0,025 dan 0,975 (sama dengan
  `matchedBaseline.js`).
- **Replikasi tidak valid.** Replikasi tidak valid adalah replikasi tanpa satu pun alert berpembanding (bobot 0).
  Replikasi ini dikeluarkan dari persentil dan jumlahnya dilaporkan. Bila lebih dari 1% replikasi utama tidak valid, CI
  dinyatakan tidak stabil dan hasil dibaca sebagai kelompok 4 (keputusan pemilik 2026-11-16).
- **Pembanding metode CI (laporan, bukan penentu).** Keputusan §6 tetap memakai CI persentil. Yang dilaporkan di
  sampingnya:
  - median bootstrap dan pergeserannya terhadap titik (dalam SE), serta jarak batas atas dan batas bawah dari titik;
  - CI basic [2θ̂ − q97,5; 2θ̂ − q2,5];
  - CI persentil bias-corrected (BC);
  - kelompok §6 untuk masing-masing metode.

  Bila kelompoknya berbeda antarmetode, hasil ditandai **rapuh terhadap metode CI**, dan catatan itu ditulis di §10
  bersama vonis. Vonisnya tidak berubah (alasannya di docs/29 §8).
- **Presisi Monte Carlo (laporan, bukan penentu).** Diukur dengan 10 benih lain, `20261117` … `20261126`, masing-masing
  10.000 replikasi. Hasil ditandai "dekat batas" bila |lo| < 3 × SD lo atau |hi − M| < 3 × SD hi.
- **Sensitivitas metode (laporan, bukan penentu),** dengan benih dan jumlah replikasi yang sama:
  - prosedur penuh dengan blok 14 hari dan harian;
  - populasi tetap: alert overlap asli tetap ikut, rata-rata pembanding dihitung ulang bila ada, selain itu memakai
    rata-rata penuh;
  - himpunan sama;
  - alert saja.

  "Alert saja" mengestimasi varians dengan rata-rata pembanding yang dianggap tetap, jadi dipakai hanya sebagai pembanding
  metode.

**Keseimbangan kovariat** (merinci §7 dan §9):

- **Kovariat.** Gerak awal 12 candle (ATR), posisi Donchian 48, ATR%, jarak dari alert sebelumnya (candle; > 48 atau belum
  ada = 49), serta proporsi tiap bin jarak.
- **Rumus.** SMD = (rata-rata alert − rata-rata pembanding) ÷ SD alert sebelum pencocokan. SD dihitung atas semua alert
  layak dengan n − 1, dan penyebut yang sama dipakai untuk sebelum dan sesudah pencocokan.
  - Sesudah pencocokan, pembanding = rata-rata atas alert dari rata-rata pembanding strata-nya. Ini setara dengan bobot
    pembanding (alert ÷ pembanding di strata).
  - Untuk kategori, SD alert = √(p(1 − p)).
  - Bila SD alert 0, dipakai SD gabungan √((s²_alert + s²_pembanding)/2). Bila itu juga 0, SMD = 0 kalau selisihnya 0;
    selain itu "tak terdefinisi".
- **Ambang.** |SMD| ≤ 0,10 seimbang; > 0,10 tidak seimbang; > 0,20 tidak seimbang besar.
- **Laporan.** SMD dilaporkan sebelum pencocokan dan sesudah pencocokan pada keempat strata: utama, dasar, bin 0,25 ATR,
  dan lampau.
- **Pelanggaran.** Pelanggaran tidak mengubah estimand. Sensitivitas bin gerak awal 0,25 ATR (strata + jarak, ujung −4/+6
  digabung) selalu dihitung. Sensitivitas ini ditandai **dipicu** bila ada |SMD| utama > 0,10 atau SMD utama yang tak
  terdefinisi.

**Overlap dan gerak awal ≥ 4 ATR** (diagnostik, bukan hipotesis; ambang 4 ATR, bukan 2,7):

- **Jumlah dan profil.** Jumlah dan porsi alert cocok dan tidak cocok, serta profilnya: sebaran gerak awal (termasuk p10,
  p50, p90), jarak, posisi, kelompok koin (27 koin pengembangan docs/24–27 vs lainnya), tahun, dan ATR%.
- **Cakupan alert ≥ 4 ATR.** Porsi alert ≥ 4 ATR yang tidak cocok, dan porsi yang tercakup estimand.
- **Estimasi fallback.** Estimasi fallback strata dasar untuk alert tak cocok, seluruhnya maupun khusus ≥ 4 ATR, dengan CI
  prosedur penuh.
- **Pembanding deskriptif.** Subkelompok ≥ 4 ATR vs < 4 ATR di dalam estimand, beserta selisihnya.
- **Tidak terestimasi.** Bila tidak ada alert atau pembanding, hasil ditulis "tidak terestimasi", bukan nol.
- **Tanpa keputusan produk.** Tidak ada keputusan produk yang diambil dari subkelompok ini.

**Rincian sensitivitas §7.**

- **Lampau.** Sensitivitas "lampau" memakai strata tanpa jarak. Dengan pembanding lampau, bin jarak ≤ 12 kosong menurut
  definisi.
- **Fallback.** Strata + jarak; bila tidak ada, strata dasar. Aturan ini diulang di setiap replikasi bootstrap.
- **Strata tanpa jarak.**
- **Subkelompok.**
  - Segar (> 48 candle) vs berulang, dengan interaksi = selisih ATT per replikasi.
  - Rezim BTC docs/26 §10.3: tren 720 candle, dan tersil volatilitas realisasi 30 hari atas jam jendela.
- **Laju alert per bulan.**
- **CI 14 hari dan harian.**

**Mode dan pengaman** (merinci §8):

- **`validate`.** `--to ≤ 2026-11-16`, cache saja, jendela minimal 90 hari.
- **`count`.**
  - Tidak ada fungsi hasil yang dipanggil. Pembungkusnya menolak `outcomeFn` di mode ini, dan keluarannya tanpa A/B; tes
    UNIT-MOM01-005 memeriksanya.
  - `replaySeries` backend beku tetap memberi label trade SA/PVA dengan stop struktur secara internal. Label itu langsung
    dibuang, dan hanya indeks alert yang dipakai.
- **`evaluate`.**
  - Ditolak bila: sekarang < 2028-11-16 00:00 UTC, `--to` ≠ 2028-11-16, hash pohon ≠ baris di atas, pohon kerja git
    kotor, atau `--log-dir`/`--cache-dir` bukan bawaan.
  - Ditolak juga bila log `evaluate-*` sudah ada, kecuali `--rerun-reason` (≥ 10 karakter) diberikan dan dicatat di
    laporan.
  - Integritas data diperiksa sebelum hasil dihitung. Evaluate ditolak bila ada simbol yang gagal dimuat, yang datanya
    berhenti lebih dari 2 candle sebelum cutoff tanpa delisting terverifikasi, atau yang delisting/ekor datarnya belum
    terselesaikan.
  - Penanda `evaluate-started-*` ditulis sesudah semua syarat lolos dan sebelum hasil dihitung.
- **Skrip riset lama.** `research-mom-power/-overlap/-sim` dan `research-matched-exclusion` menolak `--to` sesudah
  2026-11-16. `research-matched.js` dan `research-timing.js` tidak diubah, karena hash-nya dikunci docs/25 §1.6.

**Format laporan.**

- **File.** `research-log/al-mom-01/evaluate-2028-11-16.{json,md}`.
- **Bagian, berurutan:**
  1. kelompok hasil docs/28 §6 dan keputusan produknya;
  2. estimand utama A dan B, dengan replikasi valid dan status stabil;
  3. pembanding metode CI dan presisi Monte Carlo;
  4. perbandingan metode bootstrap dan dekomposisi varians;
  5. diagnostik per replikasi;
  6. sensitivitas pencocokan;
  7. SMD;
  8. overlap dan gerak awal ≥ 4 ATR;
  9. subkelompok;
  10. laju bulanan;
  11. integritas data;
  12. catatan hubungan dengan AL-SA-ATR-01.

## 10. Catatan dan hasil

Belum ada. Hasil dicatat sekali, sesudah evaluasi, apa pun kelompoknya.
