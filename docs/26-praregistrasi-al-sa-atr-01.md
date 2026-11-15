# 26 — Praregistrasi AL-SA-ATR-01: alert LONG 1h dengan gerak awal ≥ 2,7 ATR (dibekukan 2026-11-15)

**Status: DIBEKUKAN sebelum data uji ada.** Data uji dimulai **2026-11-16 00:00 UTC**, sehari sesudah pembekuan. Commit
beku = commit pertama yang menambahkan dokumen ini; aturan, semesta, ukuran sampel, kriteria, dan kode analisis tidak
boleh diubah sesudahnya. Perubahan apa pun = uji baru dengan praregistrasi baru (AL-SA-ATR-02 dst.). Hasil dicatat di §9
apa pun vonisnya (keputusan pemilik 2026-11-15).

## 1. Latar

- docs/24 §3.1: di antara alert LONG 1h SA/PVA v3 (31 koin, 2024-01 → 2026-10), tersil atas gerak awal (≥ 2,7 ATR)
  memberi +0,15R. Itu 1 dari 18 sel yang diperiksa, dan ambang 2,7 dipilih **sesudah** melihat data, jadi angka itu
  hipotesis, bukan bukti.
- docs/25 §2 (bagian D–E), dengan aturan satu posisi per simbol: +0,17R, CI blok 7 hari [+0,05 … +0,28], n 560;
  pelengkap (< 2,7 ATR) −0,04R; selisih +0,20R [+0,07 … +0,33]. Pada periode uji kronologis saja: +0,11R
  [−0,06 … +0,26], n 295, jadi efeknya lebih lemah di data yang lebih baru.
- docs/25 §2.3 juga menemukan bahwa, setelah bias pemilihan pembanding diperbaiki, alert LONG 1h **tidak terbukti**
  membawa informasi di luar momentum serupa: selisih gerak 12 candle +0,09…+0,11 ATR, CI memuat 0. Jadi, kalaupun uji
  ini lulus, sumbernya bisa saja momentum biasa, bukan pola SA/PVA. Itu pertanyaan terpisah dan tidak menjadi kriteria
  di sini.

## 2. Hipotesis

**H1.** Alert LONG 1h SA/PVA v3 (perilaku live, gerbang tier ≥ B) yang gerak awal 12 candle-nya ≥ 2,7 × ATR14 pada candle
sinyal punya R bersih rata-rata > 0 sesudah fee, slippage, dan funding, **dan** lebih baik daripada alert LONG 1h v3
lainnya (gerak awal < 2,7 ATR), pada data yang belum ada saat praregistrasi.

## 3. Aturan beku

Konstanta di `backend/research/alSaAtr01.js` (`AL_SA_ATR_01`, beku dengan `Object.freeze`); eksekusi oleh runner backtest
(`replaySeries`, `labelTrade`) apa adanya pada commit beku.

| Unsur | Aturan |
|---|---|
| Sinyal | Replay `replaySeries`, varian v3 (state machine + gerbang tier ≥ B, sama dengan live), arah LONG, timeframe 1h; satu sinyal = event pertama ke state alert sejak NO_PATTERN (definisi docs/24–25). Timeframe 1h tidak memakai konteks HTF; analisis memakai 300 candle terakhir. |
| Filter | Gerak awal = (close[i] − close[i−12]) ÷ ATR14[i] pada candle sinyal i. Kelompok **filter**: ≥ 2,7. Kelompok **pelengkap**: < 2,7. |
| Entri & keluar | Entri di open candle i+1. Stop = level invalidasi sinyal; target 2R; batas 48 candle (TIMEOUT). Stop & target di candle yang sama = LOSS. Entri yang sudah melewati stop (gap) tidak dimasuki. |
| Biaya | Fee 5 + slippage 2 bps per sisi (taker USDⓈ-M VIP 0) di dalam R runner; funding historis Binance dikurangkan selama posisi terbuka. Stres: 5 + 5 bps per sisi. |
| Posisi | Per kelompok, maksimal satu posisi per simbol: sinyal baru pada simbol yang trade-nya masih terbuka (entri ≤ waktu keluar trade sebelumnya) diabaikan. |
| Semesta | 100 simbol beku (daftar di `AL_SA_ATR_01.universe`): `listTopSymbols({ limit: 100 })` discovery scanner (perpetual USDⓈ-M, urut quote volume 24 jam, spread ≤ 1000 bps) pada 2026-11-15T16:04:30.837Z. Tidak ada penggantian; simbol yang delisting dihitung sampai data terakhirnya. |
| Jendela | Sinyal dengan openTime candle sinyal di [2026-11-16 00:00 UTC, end), end = min(cutoff, 2027-11-16 00:00 UTC) − 50 candle, jadi setiap trade sempat selesai sebelum cutoff. Trade yang tetap terbuka (data bolong) dilaporkan jumlahnya, tidak dihitung. Data dimuat sejak 30 hari sebelum jendela untuk pemanasan (720 candle ≥ 300 + 150). |
| Data | Kline 1h dan funding rate dari REST publik Binance USDⓈ-M, di-cache di `data/backtest-cache`. |
| Kohort (laporan) | Lama = simbol yang punya candle 1h pada Oktober 2025; baru = selain itu. |

## 4. Ukuran sampel dan aturan berhenti

**n wajib = 600 trade di kelompok filter** (sesudah aturan satu posisi per simbol).

Dasar (docs/25 §2 bagian E, data 2024-01 → 2026-10): SD 1,06R, efek desain 1,77 (bootstrap blok 7 hari vs naif), rata-rata
+0,17R, selisih vs pelengkap +0,20R, korelasi statistik P1–P2 0,65. Frekuensi 0,713 trade per simbol-bulan → ±71 trade per
bulan di 100 simbol → **±8,4 bulan** (perkiraan: 69 koin di luar 31 koin cache belum diukur).

| Skenario efek sebenarnya | Daya P1 | Daya P2 | Daya P1 & P2 (lulus) |
|---|---|---|---|
| Sama dengan teramati (+0,17R; selisih +0,20R) | 84% | 90% | **80%** |
| Seperti periode uji (+0,11R) | 48% | 56% | 38% |
| Setengah teramati | 31% | 37% | 22% |
| Nol | 2,5% | 2,5% | 0,8% (lulus palsu) |

Efek teramati kemungkinan terlalu tinggi karena ambangnya dipilih sesudah melihat data. Jadi n 600 memberi daya ±80% hanya
bila efeknya nyata sebesar itu. Untuk daya 80% pada setengah efek dibutuhkan ±2.200 trade (±30 bulan), dan itu tidak
dipilih. Pembandingnya: n 200 (usulan awal) hanya memberi daya lulus 30% pada efek teramati.

**Aturan berhenti.**

1. `--mode count` boleh dijalankan kapan saja. Mode ini hanya menghitung trade, tanpa hasil R.
2. Jalankan count pada tanggal 1 setiap bulan, dengan cutoff tanggal itu pukul 00:00 UTC. Pada cutoff pertama yang
   count-nya ≥ 600, jalankan `--mode evaluate` dengan cutoff yang sama. Bila sampai 2027-11-16 belum tercapai,
   evaluasi dijalankan dengan cutoff 2027-11-16.
3. Evaluasi hanya sekali. Hasil R tidak dilihat sebelumnya dan jendela tidak diperpanjang.

## 5. Kriteria keputusan

Semua wajib dipenuhi. Implementasinya ada di `evaluateCriteria`.

| Kode | Kriteria |
|---|---|
| P0 | n kelompok filter ≥ 600 |
| P1 | R bersih rata-rata kelompok filter > 0 **dan** batas bawah CI 95% > 0 (moving-block bootstrap atas hari kalender, blok 7 hari, 2000 replikasi, benih 7) |
| P2 | Selisih rata-rata filter − pelengkap > 0 **dan** batas bawah CI 95% > 0 (bootstrap blok 7 hari pada sumbu hari bersama, benih 11) |
| P3 | R bersih rata-rata kelompok filter dengan biaya stres 5 + 5 bps > 0 |
| P4 | Hash pohon kode saat evaluasi = hash di §8 |

Vonis dibaca berurutan:

1. P4 gagal → **TIDAK SAH**.
2. P0 gagal → **TIDAK KONKLUSIF**.
3. P1, P2, dan P3 terpenuhi → **LULUS**.
4. Selain itu → **TIDAK LULUS**.

Yang dilaporkan tetapi bukan penentu: CI blok 14 hari dan harian, rata-rata pelengkap, funding rata-rata, drawdown maksimum,
jumlah WIN/LOSS/TIMEOUT, kohort lama vs baru, dan hasil per simbol.

Arti vonis:

- **LULUS** berarti aturan ini punya ekspektasi positif di jendela uji. Itu bukti dari satu uji, bukan jaminan, dan belum
  cukup untuk menaikkan ukuran posisi live.
- **TIDAK LULUS** berarti filter 2,7 ATR tidak dipakai scanner. Filter tidak boleh diselamatkan dengan mengubah ambang atau
  aturan; varian baru apa pun harus lewat praregistrasi baru.

## 6. Perbedaan dari usulan awal (tinjauan ChatGPT 2026-11-15)

- **Pembanding P2** = alert pelengkap (< 2,7 ATR) dari semesta dan jendela yang sama, bukan "semua alert", karena "semua
  alert" ikut memuat kelompok filter itu sendiri.
- **Satu posisi per simbol** dihitung ulang dari awal. Angka docs/24 belum memakai aturan ini.
- **Semesta 100 simbol**, bukan 31, supaya n tercapai dalam ±8–9 bulan.
- **n dari analisis daya** (600), bukan 200.
- **Sinyal ≥ 50 candle sebelum cutoff**, supaya trade yang cepat selesai tidak terlalu banyak terwakili di ujung jendela.

## 7. Prosedur

1. Cari commit beku dengan `git log --diff-filter=A --format=%H -- docs/26-praregistrasi-al-sa-atr-01.md`, lalu buat
   checkout bersih, misalnya `git worktree add ../alsa-01 <commit>`. File `.js` yang tidak ter-track di `backend/` ikut
   terhitung di hash. Folder `data/backtest-cache` boleh disalin ke checkout itu.
2. Jalankan `npm ci` (saat pembekuan dipakai Node 24.22.2).
3. Setiap bulan: `npm run research:al-sa-atr-01 -- --mode count --to YYYY-MM-01`.
4. Sekali (lihat §4): `npm run research:al-sa-atr-01 -- --mode evaluate --to YYYY-MM-DD`.
5. Salin `reports/research/al-sa-atr-01-evaluate-<waktu>.md` ke §9 apa pun vonisnya.

**Deviasi yang diizinkan.** Bila API Binance berubah sehingga pengambilan data dari commit beku gagal, data boleh diunduh
ke `data/backtest-cache` dengan commit lain (format cache sama). Evaluasinya tetap dijalankan pada commit beku. Deviasi
lain apa pun dicatat di §9, dan hasilnya tidak berlaku sebagai uji keputusan.

## 8. Hash

Hash pohon kode: `25c022560e99565ecc3de0f62872d5116da756caf89984c589bcd74ac2f8b314`

Hash ini adalah SHA-256 atas baris "path relatif + SHA-256 isi", diurutkan menurut path, untuk 145 file: semua `.js` di
`backend/` ditambah `scripts/research-al-sa-atr-01.js` (fungsi `codeTreeHash`). Mode evaluate membandingkannya dengan hash
pohon saat dijalankan. Hash dihitung dari byte file, jadi checkout harus tanpa konversi akhir baris
(`core.autocrlf=false`). File kunci:

| File | SHA-256 |
|---|---|
| `backend/research/alSaAtr01.js` | `85a817cf4dcec50c80610f99f090447c5a697da18e84fd0dc53db58e4374baf5` |
| `scripts/research-al-sa-atr-01.js` | `258b01e43c5db01debc1dc4eb34628457d90fd21b5ecb1c442cc56a8757e3cc0` |
| `backend/research/matchedBaseline.js` | `e60ef8c1ecff5bf435251da70e8ccf4dac6e846bfaa94bd3f583ae0ed8d4b55b` (sama dengan docs/25 §1.6) |
| `backend/backtest/runner.js` | `0f9147699e64a603775b618518580706af8bdc8a09fa55dfcbfe5b40fbc26813` |
| `backend/backtest/labeler.js` | `836407d5340e33d4c65d3ddda43ee3a06c6df6f7fea414718145163911cc66b5` |
| `backend/backtest/eventStudy.js` | `634acc705ef9fc528e83ea7107bd699199efcf35a76ebeb3f6baeee2262b717a` |
| `backend/backtest/funding.js` | `e885eadeb036c9154c1565041bf2d381e99e89474f6c433fd0e43da9cf61d928` |
| `backend/backtest/dataSource.js` | `4da0344e19c3c8d1962e90fba488a1c9141bdf28bf560bab76af939c0c022081` |

## 9. Hasil

Belum ada. Diisi sekali, sesudah evaluasi (§4).
