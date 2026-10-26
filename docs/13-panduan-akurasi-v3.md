# Panduan akurasi scanner v3 (LONG & SHORT)

Ringkasan untuk pemilik aplikasi: apa yang berubah, kenapa, cara membacanya di website, dan cara **mengukur**
akurasinya sendiri di Mac. Dokumen pendukung: [10 — kontrak modul](10-kontrak-akurasi-v3.md),
[11 — riset metodologi (43 sumber)](11-riset-akurasi-scanner.md), [12 — referensi open source](12-referensi-opensource.md).

## 1. Jawaban jujur soal "99% benar"

Tidak ada metode analisis teknikal yang terbukti mencapai 99% untuk sinyal arah kripto 5m–1h. Studi akademik yang
kredibel melaporkan sekitar 55–65% pada kondisi terbaik, sering hanya "sedikit di atas acak" (docs/11 §5). Angka
mendekati 99% hampir selalu tanda kebocoran data masa depan (lookahead), sampel terlalu kecil, atau target sangat kecil
dengan stop sangat lebar (win rate tinggi tetapi tetap rugi).

Karena itu v3 tidak mengejar angka win rate, melainkan:

1. **Lebih selektif**: hanya sinyal dengan konfirmasi dari beberapa sudut (tier A/B) yang memicu alert.
2. **Dapat diukur**: setiap perubahan dibandingkan sebelum/sesudah dengan backtest out-of-sample.
3. **Jujur**: "peluang historis" hanya muncul bila sudah ada kalibrasi backtest dengan ≥ 100 sampel, selalu bersama
   interval kepercayaan 95%. Tanpa itu, yang tampil hanya skor & tier (aturan, bukan probabilitas).

Target realistis pada target 2R: tier A dengan win rate 40–48% dan expectancy +0,1 s/d +0,3R per trade sudah bagus.
Titik impas 2R (sebelum biaya) adalah 33%.

## 2. Apa yang berubah

| Lapisan | Sebelum (v2) | Sesudah (v3) |
| --- | --- | --- |
| Pola | SA/PVA (LONG), SD/PVD (SHORT, cermin) | Tetap (versi pola 2), menjadi salah satu komponen |
| Struktur pasar | Hanya hitungan higher-low | Label HH/HL/LH/LL, BOS & CHoCH kausal, bias struktur (`backend/features/marketStructure.js`) |
| Order flow | Tidak ada | CVD dari taker buy volume Binance, rasio taker, OBV, A/D, CMF, divergensi (`orderFlow.js`) |
| Rezim | Tidak ada | ADX/+DI/−DI (Wilder), Choppiness, Bollinger squeeze, efficiency ratio (`regime.js`) |
| Likuiditas/Wyckoff | Tidak ada | Range, spring/upthrust (sapuan swing + reclaim), climax, absorption (`liquidity.js`) |
| Konteks HTF | Label saja | Komponen berbobot + veto bila berlawanan |
| Keputusan | earlyScore ≥ 60 → EARLY + alert | Skor konfluensi 0–100 → tier A/B/C/D; sinyal di bawah tier B tetap QUIET (tanpa alert) |

Bobot konfluensi (hipotesis, mengikuti bukti di docs/11): pola 25, konteks HTF 20, struktur 20, order flow 15,
rezim 10, likuiditas/Wyckoff 10. Veto (tier maksimal C): HTF berlawanan, tren kuat berlawanan (ADX ≥ 25), order flow
kuat berlawanan, CHoCH berlawanan yang segar, risiko berat (volatilitas ekstrem, kualitas data, likuiditas, spread).
LONG dan SHORT memakai aturan yang sama persis dalam cermin (diuji: input SHORT cermin → skor & tier identik).

Indikator dicocokkan dengan pustaka open source `ta` (MIT): ADX/±DI & Bollinger bandwidth selisih ≤ 5e-11; OBV, A/D,
CMF toleransi relatif 1e-9 (fixture di `tests/fixtures/features/`). Tidak ada dependensi npm baru (alasan di docs/12).

## 3. Di website

- Kolom/field baru per sinyal: `confluenceScore`, `confidenceTier`, `winProbability` (null sampai dikalibrasi).
- `GET /api/signals/active?minTier=B` menampilkan hanya tier B ke atas; urutan bawaan: tier tertinggi dulu.
- Penjelasan sinyal memuat `CONFLUENCE:TIER` (skor, tier, veto, peluang historis), kontribusi tiap komponen, serta
  daftar konfirmasi dan konflik dalam kalimat.
- Sinyal lama (sebelum migrasi `006`) tidak punya tier; mereka tetap berjalan seperti biasa.

## 4. Mengukur akurasi di Mac (wajib sebelum mempercayai tier)

Binance tidak dapat diakses dari lingkungan cloud pengembang, jadi angka pasar nyata hanya bisa dihasilkan di Mac.

```bash
cd ~/path/ke/Caddle
git pull origin main
npm ci
# 1) Uji mekanisme cepat (data sintetis, ±30 detik)
npm run backtest -- --synthetic --seed 7 --timeframes 15m
# 2) Backtest data nyata: 10 koin teratas, 15m & 1h, ±22 bulan (unduhan pertama beberapa menit, lalu dari cache)
npm run backtest -- --top 10 --timeframes 15m,1h --from 2024-01-01 --to 2025-11-01
# 3) Bila hasil out-of-sample masuk akal, tulis kalibrasi agar website menampilkan peluang historis
npm run backtest -- --top 10 --timeframes 15m,1h --from 2024-01-01 --to 2025-11-01 --write-calibration config/calibration.json
```

Laporan muncul di `reports/backtest-<waktu>.md` (dan `.json`). Cara membacanya:

1. Lihat baris **Out-of-sample (test)** saja untuk menilai; in-sample hanya untuk mendeteksi overfitting.
2. Bandingkan **Sebelum (v2)** vs **Sesudah (v3)**: yang penting expectancy (R) dan profit factor, bukan hanya win rate.
3. Tabel **Per tier** harus terurut: A ≥ B ≥ C ≥ D. Bila tidak, bobot konfluensi belum bermakna untuk data itu.
4. Bila interval kepercayaan sebelum/sesudah beririsan, perbedaannya belum signifikan — perlu lebih banyak data.
5. Sampel < 30 per baris = abaikan.

Setelah `config/calibration.json` ditulis, restart scanner (Hentikan → Jalankan). Worker memuatnya otomatis; tanpa
file itu peluang historis tidak ditampilkan.

## 5. Hasil yang sudah diverifikasi di cloud (data sintetis — BUKAN akurasi pasar nyata)

- **Uji kebocoran (random walk murni, 4 simbol × 1.600 candle):** tidak ada edge positif signifikan pada v2 maupun
  v3 (batas bawah CI expectancy < 0, win rate < 45%). Ini bukti bahwa backtest dan fitur tidak mengintip masa depan.
- **Pasar sintetis dengan akumulasi/distribusi tertanam** (`--synthetic --seed 7`, 6 simbol, 15m, out-of-sample):
  lihat angka di bagian 6. Tier D konsisten terburuk (win rate ±13%, expectancy negatif), sehingga gerbang tier
  membuang sinyal yang paling sering gagal. Karena polanya ditanam, angka ini hanya membuktikan mekanisme.

## 6. Angka backtest sintetis (seed 7)

Perintah: `npm run backtest -- --synthetic --seed 7 --timeframes 15m,1h` (6 simbol × 3.000 candle 15m + 1h hasil
agregasi; target 2R, batas 48 candle, biaya 4 bps + slippage 2 bps per sisi; holdout waktu 60/40 + embargo).

| Out-of-sample (test) | n | Win rate (CI 95%) | Expectancy | Profit factor |
| --- | --- | --- | --- | --- |
| Sebelum (v2) | 199 | 32,2% (26,1–38,9%) | +0,18R | 1,32 |
| Sesudah (v3, tier ≥ B) | 112 | 38,4% (29,9–47,6%) | +0,48R | 2,29 |

Per tier (sinyal v2 dikelompokkan menurut tier saat entri, out-of-sample): B 39,2% / +0,52R (n 79), C 40,7% / +0,32R
(n 54), D 14,3% / −0,40R (n 63); tier A baru 3 sampel. Interval kepercayaan sebelum/sesudah masih beririsan, jadi
perbedaannya belum signifikan secara statistik walau searah. Sekali lagi: polanya DITANAM oleh generator, jadi ini
hanya bukti bahwa mesin backtest, gerbang tier, dan pelaporan bekerja — angka pasar nyata wajib dari Mac (bagian 4).

## 7. Batasan yang diketahui

- Bobot & ambang konfluensi adalah hipotesis yang belum dioptimasi pada data nyata.
- Studi terbaru menemukan lonjakan taker agresif 15m cenderung berbalik; karena itu bobot order flow diturunkan.
  Bila backtest Mac menunjukkan komponen order flow merugikan, turunkan bobotnya lewat `params.confluence`.
- Survivorship bias: `--top` memakai koin teratas SAAT INI; koin yang sudah delisting tidak ikut, sehingga hasil
  cenderung sedikit lebih bagus dari kenyataan.
- Konteks BTC (bias/rezim BTC) belum menjadi input konfluensi; diusulkan sebagai langkah berikutnya (docs/11 §6.4).
