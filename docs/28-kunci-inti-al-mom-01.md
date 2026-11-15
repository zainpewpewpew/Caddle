# 28 — Kunci inti AL-MOM-01: apakah alert SA/PVA membawa informasi di luar momentum (dikunci 2026-11-15, sebelum data uji ada)

**Status: KUNCI INTI.** §2–§8 dikunci sebelum jendela data dimulai (2026-11-16 00:00 UTC); waktu tepatnya ada di
timestamp commit yang menambahkan dokumen ini. Mengubah bagian yang dikunci berarti uji baru (AL-MOM-02 dan seterusnya).
Kode analisis dan rincian di §9 dibekukan kemudian, paling lambat sebelum `--mode evaluate` AL-SA-ATR-01, tanpa membuka
hasil AL-MOM-01 (§8). Keputusan diambil pemilik pada 2026-11-16 WIB berdasarkan tinjauan ChatGPT dan docs/27.

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

## 10. Catatan dan hasil

Belum ada. Hasil dicatat sekali, sesudah evaluasi, apa pun kelompoknya.
