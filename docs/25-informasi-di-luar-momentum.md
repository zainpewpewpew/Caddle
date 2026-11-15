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

Ditulis sesudah run penuh pertama dengan file yang hash-nya tercantum di §1.6.
