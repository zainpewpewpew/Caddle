# 25 — Informasi di luar momentum: alert pola live vs pembanding yang dicocokkan (2026-11-15)

Pemicu: tinjauan lanjutan atas docs/24. Angka "alert sebelum breakout ±2,3–2,4 kali lebih sering diikuti breakout"
di docs/24 §4 dibandingkan dengan candle acak biasa, padahal alert memang dirancang muncul saat momentum. Pertanyaan
studi ini: **apakah SA/PVA (LONG 1h) dan SD/PVD (SHORT 15m) membawa informasi tentang gerak berikutnya di luar
momentum yang sudah terlihat dari harga?** Kalau tidak, scanner kemungkinan hanya mengenali momentum biasa.

**Komitmen (keputusan pemilik 2026-11-15, sebelum run):** hasil dicatat di dokumen ini apa pun hasilnya. Desain §1
dikunci di kode dan di-push ke `main` sebelum run penuh; hash file ada di §1.6. Studi ini deskriptif pada data yang
sudah dilihat di docs/24 (2024-01 → 2026-10); uji keputusan atas data baru ada di praregistrasi docs/26.

## 1. Desain (dikunci sebelum run penuh)

### 1.1 Data dan alert

- Sama dengan docs/24: 31 simbol cache Binance USDT-M, sinyal 2024-01-01 → 2026-10-01, fee 5 + slippage 2 bps per sisi.
- Alert = event pertama sebuah sinyal v3 (perilaku live) ke state alert, dari `replaySeries` runner. LONG 1h dan SHORT
  15m dianalisis terpisah.
- Candle memenuhi syarat: indeks ≥ 150 (warm-up runner), gerak awal dan posisi rentang terdefinisi (docs/24 §1.2), dan
  48 candle sesudahnya tersedia.

### 1.2 Pembanding yang dicocokkan

- Kandidat pembanding: candle memenuhi syarat yang berjarak **≥ 13 candle dari alert SA/PVA mana pun** (v2 atau v3)
  pada arah yang sama, jadi "momentum tanpa sinyal".
- Strata (coarsened exact matching): **simbol × kuartal kalender × gerak awal 12 candle** (bin 0,5 ATR; ≤ −4 dan ≥ +6
  ATR digabung) **× posisi rentang 48 candle** (bin 0,2) **× tersil ATR%** (per simbol × kuartal).
- Setiap alert dibandingkan dengan rata-rata kandidat di strata yang sama. Alert tanpa kandidat tidak dihitung; jumlahnya
  dilaporkan, begitu pula keseimbangan kovariat (gerak awal, posisi rentang, ATR%).

### 1.3 Hasil yang diukur (tanpa geometri trade)

- **Utama:** gerak lanjutan 12 candle = arah × (close[i+12] − close[i]) ÷ ATR14[i].
- Sekunder: gerak lanjutan 48 candle; breakout (Donchian 48) dalam 12 candle berikutnya.
- Sensitivitas: breakout dengan Donchian 24 dan 96; porsi kelas timing docs/24 (sebelum/saat/sesudah) dengan Donchian
  24 dan 96.

### 1.4 Ketidakpastian

- Selisih (ATT) = rata-rata (hasil alert − rata-rata pembanding strata).
- CI 95% = **moving-block bootstrap atas hari kalender** (hari tanpa alert ikut dihitung): blok **7 hari = utama**, 14 hari
  dan harian = sensitivitas. Semua simbol pada hari yang sama selalu berada di blok yang sama. 2000 replikasi, benih 7.
- Rata-rata pembanding diperlakukan tetap (variasinya tidak ikut disampling), jadi CI sedikit terlalu sempit.

### 1.5 Pembacaan (ditetapkan sebelum run), per kombinasi

| Hasil utama (gerak lanjutan 12 candle, CI blok 7 hari) | Pembacaan |
|---|---|
| Batas bawah CI > 0 | Alert **menambah informasi** di luar momentum serupa |
| CI memuat 0 | **Tidak terbukti** menambah informasi |
| Batas atas CI < 0 | Alert **lebih buruk** dari momentum serupa |

Dilaporkan sebagai deskripsi, bukan penentu: hasil sekunder dan sensitivitas, kohort simbol lama (data sejak Jan 2024)
vs baru, R trade docs/24 dengan CI blok 1/7/14 hari (menjawab kritik CI harian), kelompok gerak awal ≥ / < 2,7 ATR
dengan aturan satu posisi per simbol, dan bagian E (SD, efek desain, frekuensi trade) yang hanya dipakai untuk
menghitung ukuran sampel praregistrasi docs/26.

### 1.6 Perubahan setelah uji asap, dan hash

- Uji asap 1 (HYPEUSDT, UNIUSDT) dengan strata simbol × **bulan** × posisi rentang bin **0,1**: hanya 47% alert LONG 1h
  mendapat pembanding (median 2 per alert). Strata dilonggarkan menjadi simbol × kuartal × posisi bin 0,2. Uji asap 2
  (simbol sama; hanya baris kecocokan yang dilihat): 90% / 99% alert cocok, median 6 / 21 pembanding. Ini satu-satunya
  perubahan desain, dan dasarnya tingkat kecocokan. Catatan jujur: hasil uji asap 1 untuk 2 simbol itu sempat terlihat,
  dan tidak ada yang signifikan (CI sangat lebar).
- Alat: `backend/research/matchedBaseline.js` (tes UNIT-MTB-001…007) dan `scripts/research-matched.js`
  (`npm run research:matched`), memakai `backend/research/signalTiming.js` dan `scripts/research-timing.js` (docs/24).

| File | SHA-256 |
|---|---|
| `backend/research/matchedBaseline.js` | `e60ef8c1ecff5bf435251da70e8ccf4dac6e846bfaa94bd3f583ae0ed8d4b55b` |
| `backend/research/signalTiming.js` | `d8ead262b92c500c60704d475eb893783cc8b971ca34d0cd5ecbd3e705504876` |
| `scripts/research-matched.js` | `ba625aab1c927a0ca594c12f259bf9b6019e6173f452585b41559a1e79ccd768` |
| `scripts/research-timing.js` | `7a16f7f27cda6ce46326f7b4c8b6874b8dfcf83a4446e5d975f7a75a99008a58` |

## 2. Hasil

Run penuh pertama berjalan 2026-11-15 dengan file yang hash-nya tercantum di §1.6. Laporannya
`reports/research/matched-20261115T160408Z.{md,json}`: 31 simbol, tidak ada seri dilewati, 1198 s. Sensitivitas pasca-run
§2.2 ada di `reports/research/matched-exclusion-20261115T163216Z.{md,json}` (421 s, 4 proses). Folder `reports/` tidak
masuk git; angka di bawah ini salinannya.

### 2.1 Pembacaan yang ditetapkan sebelum run

| Kombinasi | Alert v3 | Cocok | Median pembanding | Gerak lanjutan 12 candle: alert vs pembanding | Selisih [CI blok 7 hari] | Pembacaan §1.5 |
|---|---|---|---|---|---|---|
| LONG 1h SA/PVA | 1.713 | 1.550 (90,5%) | 5 | +0,21 vs −0,36 ATR | +0,57 [+0,35 … +0,81] | menambah informasi |
| SHORT 15m SD/PVD | 19.739 | 19.619 (99,4%) | 22 | −0,07 vs −0,45 ATR | +0,38 [+0,31 … +0,45] | menambah informasi |

Keseimbangan kovariatnya baik. Gerak awal alert vs pembanding: +2,17 vs +2,16 ATR (LONG) dan +1,73 vs +1,72 ATR (SHORT).
Posisi rentang dan ATR% hanya berselisih ≤ 0,02 dan ≤ 0,1 poin persen. Hasilnya konsisten di:

- CI blok 14 hari dan CI harian;
- horizon 48 candle: +0,75 [+0,15 … +1,32] dan +0,32 [+0,09 … +0,54];
- breakout Donchian 24/48/96, misalnya D48 +6,8 pp dan +7,6 pp;
- kohort lama dan baru.

**Pembacaan ini tidak dapat dipakai** karena desainnya cacat (§2.2).

### 2.2 Cacat desain yang ditemukan sesudah run: pemilihan pembanding memakai data masa depan

§1.2 mengeluarkan kandidat pembanding yang berjarak ≤ 12 candle dari alert mana pun, **termasuk 12 candle sebelum alert**.
Pada candle k, alert yang baru muncul di k+1…k+12 belum diketahui. Mengeluarkan candle itu berarti memilih pembanding
menurut masa depannya. Candle yang tidak diikuti alert cenderung tidak menguat, jadi pembanding tampak lebih buruk dan
selisihnya terlalu besar. Buktinya terlihat langsung:

| Kombinasi | Dikeluarkan hanya karena alert menyusul ≤ 12 candle | Gerak lanjutan 12 candle | Kandidat pembanding terkunci | Gerak lanjutan 12 candle |
|---|---|---|---|---|
| LONG 1h | 92.650 candle (gerak awal +0,52 ATR) | **+1,11 ATR** | 359.399 candle (−0,45 ATR) | −0,26 ATR |
| SHORT 15m | 424.077 candle (+0,53 ATR) | **+1,00 ATR** | 1.306.413 candle (−0,53 ATR) | −0,34 ATR |

Cacat ini ditemukan saat menulis hasil, sesudah laporan run terkunci dibaca. Sensitivitasnya ada di
`scripts/research-matched-exclusion.js` (`npm run research:matched-exclusion`, tes UNIT-MEX-001…002) dan tidak dikunci
sebelum run. Skrip itu hanya mengubah kumpulan kandidat pembanding. Strata, hasil, dan bootstrap memakai fungsi terkunci
apa adanya, dan varian "simetris" mereproduksi §2.1 persis. Uji asap 2 simbol sempat terlihat sebelum run penuh; tidak ada
yang diubah sesudahnya. Candle k dikeluarkan bila ada alert v2/v3 searah di e dengan e − before ≤ k ≤ e + after:

- **simetris** (12, 12): desain terkunci, memakai masa depan.
- **lampau** (0, 12): alert di candle k atau 12 candle sebelumnya. Kausal.
- **tanpa** (0, 0): hanya candle alert itu sendiri. Kausal; pembandingnya semua candle tanpa alert.

| Kombinasi | Pengecualian | Cocok | Gerak 12: alert vs pembanding | Selisih gerak 12 [CI 7 hari] | CI 14 hari · harian | Breakout D48: alert vs pembanding | Pembacaan §1.5 |
|---|---|---|---|---|---|---|---|
| LONG 1h | simetris | 90,5% | +0,21 vs −0,36 | +0,57 [+0,35 … +0,81] | [+0,33 … +0,82] · [+0,37 … +0,78] | 41,2% vs 34,4% | menambah informasi |
| LONG 1h | lampau | 95,4% | +0,23 vs +0,12 | +0,11 [−0,08 … +0,34] | [−0,10 … +0,36] · [−0,07 … +0,31] | 41,0% vs 40,1% | **tidak terbukti** |
| LONG 1h | tanpa | 98,5% | +0,25 vs +0,16 | +0,09 [−0,09 … +0,31] | [−0,10 … +0,31] · [−0,08 … +0,27] | 41,4% vs 40,3% | **tidak terbukti** |
| SHORT 15m | simetris | 99,4% | −0,07 vs −0,45 | +0,38 [+0,31 … +0,45] | [+0,32 … +0,45] · [+0,31 … +0,46] | 38,8% vs 31,1% | menambah informasi |
| SHORT 15m | lampau | 99,7% | −0,07 vs +0,02 | −0,08 [−0,15 … −0,02] | [−0,15 … −0,02] · [−0,15 … −0,01] | 38,8% vs 37,7% | **lebih buruk** |
| SHORT 15m | tanpa | 99,8% | −0,07 vs −0,00 | −0,07 [−0,13 … −0,00] | [−0,13 … −0,01] · [−0,14 … +0,00] | 38,7% vs 37,4% | **lebih buruk** (CI harian menyentuh 0) |

Hasil lain dari dua varian kausal:

- **LONG 1h.** Gerak lanjutan 48 candle +0,24…+0,28 ATR, dengan CI memuat 0. Selisih breakout: D24 +4,1 pp (CI > 0),
  D48 +0,9…+1,1 pp dan D96 +1,9…+2,0 pp (CI memuat 0). Selisih gerak 12 candle per kohort: lama +0,05 ATR di kedua varian,
  baru +0,21…+0,34 ATR; semua CI memuat 0.
- **SHORT 15m.** Selisih breakout D24 +3,1…+3,3 pp, D48 +1,0…+1,4 pp, dan D96 +5,7…+5,8 pp. Sesudah alert, harga sedikit
  lebih sering mencetak low baru dibanding momentum serupa, tetapi gerak 12 candle-nya tetap lebih buruk. Kedua kohort
  negatif.

### 2.3 Kesimpulan

1. Pembacaan terkunci §2.1 gugur karena cacat §2.2. Dengan pembanding kausal, dan konsisten di kedua varian:
   - **LONG 1h SA/PVA tidak terbukti menambah informasi** di luar momentum serupa. Selisihnya +0,09…+0,11 ATR, CI memuat 0.
   - **SHORT 15m SD/PVD sedikit lebih buruk** dari momentum serupa: −0,07…−0,08 ATR.
2. Peluang breakout bersyarat: dibanding semua candle, alert jauh lebih sering diikuti breakout D48 dalam 12 candle
   (LONG 41% vs 18%, SHORT 39% vs 18%). Dibanding candle dengan momentum serupa, selisihnya tinggal +0,9…+1,4 pp. Rasio
   besar terhadap candle acak (docs/24 §4) hampir seluruhnya berasal dari momentum.
3. Scanner saat ini paling tepat dibaca sebagai **pendeteksi momentum dengan label pola**. Itu tidak berarti trade-nya
   pasti rugi (§2.4). Hanya saja, keunggulan apa pun yang ada belum bisa diatribusikan ke pola.

### 2.4 R trade (tidak terpengaruh cacat §2.2)

Bagian D dan E laporan terkunci tidak memakai pembanding.

| LONG 1h | n | R bersih | CI blok 7 hari | CI 14 hari | CI harian |
|---|---|---|---|---|---|
| Semua alert | 1.713 | +0,03 | [−0,07 … +0,13] | [−0,07 … +0,12] | [−0,05 … +0,11] |
| Periode uji | 945 | +0,02 | [−0,12 … +0,15] | [−0,12 … +0,15] | [−0,10 … +0,13] |
| Gerak awal ≥ 2,7 ATR, satu posisi per simbol | 560 | +0,17 | [+0,05 … +0,28] | [+0,05 … +0,27] | [+0,06 … +0,27] |
| Gerak awal < 2,7 ATR, satu posisi per simbol | 1.109 | −0,04 | [−0,13 … +0,07] | [−0,14 … +0,08] | [−0,13 … +0,05] |
| ≥ 2,7 ATR, satu posisi per simbol, periode uji | 295 | +0,11 | [−0,06 … +0,26] | [−0,06 … +0,26] | [−0,04 … +0,25] |
| Selisih ≥ − < 2,7 ATR (satu posisi per simbol) | — | +0,20 | [+0,07 … +0,33] | [+0,07 … +0,32] | [+0,07 … +0,33] |

SHORT 15m:

- Semua alert: −0,12R [−0,16 … −0,08], n 19.741.
- Periode uji: −0,14R [−0,20 … −0,08].
- Gerak awal ≥ 2,7 ATR, satu posisi per simbol: −0,08R [−0,13 … −0,02].

CI blok 7 dan 14 hari hampir sama dengan CI harian, jadi kritik "CI harian terlalu sempit" tidak mengubah kesimpulan
docs/24.

Persiapan praregistrasi (bagian E, LONG 1h, ≥ 2,7 ATR, satu posisi per simbol):

- n 560, SD 1,06R, efek desain 1,77;
- R bersih dengan biaya stres 5 + 5 bps: +0,15R;
- 0,713 trade per simbol-bulan (785 simbol-bulan).

Ukuran sampel dan dayanya dibahas di docs/26 §4.

### 2.5 Sensitivitas definisi breakout (bagian C)

Porsi alert yang muncul tepat di candle breakout dengan Donchian 24/48/96:

- LONG: 31,6% / 23,8% / 18,2%, dibanding semua candle 4,2% / 2,8% / 1,9%.
- SHORT: 23,6% / 18,2% / 13,4%, dibanding 4,1% / 2,7% / 1,7%.

Kesimpulan docs/24 bahwa alert terkonsentrasi di candle breakout tidak bergantung pada pilihan Donchian 48.

### 2.6 Pelajaran

- Kelayakan pembanding hanya boleh memakai informasi yang sudah ada pada candle itu. Aturan ini wajib di studi berikutnya.
- Mengunci desain menjamin urutan yang jujur, bukan desain yang benar. Karena itu hasil terkunci tetap dicatat di §2.1,
  berdampingan dengan koreksinya.
