# 27 — Bahan desain AL-MOM-01: daya uji SA/PVA vs momentum murni (2026-11-16, belum praregistrasi)

**Status: bahan diskusi, bukan praregistrasi.** Semua angka di sini berasal dari data historis yang sudah dilihat
(31 koin cache, sinyal 2024-01 → 2026-10), dan dipakai untuk memilih desain, bukan sebagai bukti.

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
3. **Jendela lebih panjang.** Dengan 24 bulan, efek terkecil terdeteksi menjadi A 0,16 ATR dan B 0,07R.
4. **Pengurangan varians.** Misalnya penyesuaian regresi di dalam strata atau winsorizing gerak 12 candle. Opsi ini
   harus diuji dulu pada data historis sebelum dipilih.
5. **Jarak dari alert sebelumnya sebagai strata atau subkelompok.** Alert "segar" punya titik terbesar, tetapi n-nya
   hanya ±17% alert.

## 5. Batas klaim

Kalau AL-MOM-01 nantinya lulus, artinya label SA/PVA punya nilai prediktif tambahan setelah penyesuaian variabel yang
dipilih. Itu belum membuktikan profitabilitas atau hubungan sebab-akibat (tinjauan ChatGPT).

## 6. Alat

`scripts/research-mom-power.js` (`npm run research:mom-power`), tes UNIT-MOM-001…003. Skrip ini memakai fungsi
pencocokan dan bootstrap docs/25 apa adanya, serta mask pengecualian dari `scripts/research-matched-exclusion.js`.
