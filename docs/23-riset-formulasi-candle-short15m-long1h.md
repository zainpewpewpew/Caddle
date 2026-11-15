# 23 — Riset formulasi candle SHORT 15m & LONG 1h, dan praregistrasi uji luar sampel BSV-1h (2026-11-15)

Permintaan pemilik: *"jika kamu menemukan rekomendasi formulasi candle terbaik untuk short scanner 15 menit tambahkan,
begitu juga pada long scanner 1 jam."*

**Keputusan pemilik (2026-11-15):**
- **SHORT 15m: tidak ditambahkan.** Tidak ditemukan formulasi yang lebih baik dari entri acak setelah biaya (§2).
- **LONG 1h: uji luar sampel dulu.** Satu kandidat, BSV-1h, diuji pada data yang belum dipakai eksplorasi dengan kriteria
  lulus yang ditetapkan **sebelum** hasilnya dilihat (§4). Scanner live tidak diubah; integrasi hanya dibahas bila lulus.

**Hasil (§5): BSV-1h TIDAK LULUS uji luar sampel** (rata-rata −0,066R per trade setelah biaya & funding pada 5.456
sinyal 2024–2026). Kesimpulan untuk kedua permintaan: **tidak ditemukan formulasi candle yang layak ditambahkan**; kedua
scanner tidak diubah.

## 1. Metode

- Workflow multi-agen: satu agen memetakan kode scanner, satu agen per formulasi (SHORT 15m, LONG 1h) meriset literatur
  dan menjalankan uji eksplorasi read-only pada cache kline proyek (`data/backtest-cache`), lalu satu agen **kritik
  adversarial** membaca kode proyek dan menjalankan ulang uji kedua formulasi secara independen.
- Konvensi uji eksplorasi: sinyal pada close candle i, entri di open candle i+1, stop 1,5 × ATR14 (Wilder), target 2R,
  batas 48 candle, stop dihitung lebih dulu bila stop & target tersentuh pada candle yang sama, biaya 5 bps fee + 2 bps
  slippage per sisi, CI 95% dengan bootstrap berklaster per hari.
- Prinsip PRODUCT.md tetap berlaku: skor = kecocokan aturan, bukan probabilitas; tidak ada klaim profit.

Temuan kode yang relevan untuk integrasi (peta kode): timeframe per arah dikunci di `DIRECTION_TIMEFRAMES`
(`backend/market/contracts.js`); worker mengingesti 5m/15m/1h (tidak ada 4h); menambah **jenis pola baru** ke mesin pola
membutuhkan migrasi yang membangun ulang tabel `signals` (CHECK classification) dan menggeneralisasi asumsi "tepat dua pola
per arah" — perubahan berisiko tinggi. Baseline proyek untuk pola yang ada pada kombinasi baru juga negatif OOS (SHORT 15m
v3 −0,13R; LONG 1h v3 −0,08 s/d −0,12R).

## 2. SHORT 15m — tidak ditambahkan

**Literatur:** pola candlestick klasik tidak bernilai setelah biaya (Marshall, Young & Rose 2006; studi 68 pola pada 23
kripto, IEEE BigData 2021: "of little use"). SFP/sapuan likuiditas dan SMC (CHoCH, lower high) tidak punya uji peer-review;
riset Osler (NY Fed) justru menunjukkan stop yang tertembus cenderung mempercepat tren. Pembalikan 15m setelah lonjakan taker
di Binance (preprint 2026) ber-edge kotor ±1,3 bp, di bawah biaya ±5 bp.

**Uji eksplorasi** (29 koin, 2024-01 s/d 2026-09, ±2,27 juta candle 15m, konteks 1h dirakit dari 15m):

| Kandidat | n | R bersih | Catatan |
|---|---|---|---|
| Baseline short tanpa syarat | 282.412 | −0,142 | R kotor +0,025, biaya 0,168R |
| SFP (sapuan swing high, close kembali di bawah), stop ATR, konteks 1h BEARISH | 23.218 | −0,128 | sama dengan baseline; dengan stop struktural −0,46…−0,48R (biaya 0,48R) |
| Bearish engulfing / shooting star di resistance, RVOL ≥ 1,5 | 20.165 | −0,170 | lebih buruk dari baseline, tidak stabil per tahun |
| Penolakan EMA25 dalam tren turun 1h | 23.836 | −0,133 | sama dengan baseline |
| LHB-15: lower high setelah CHoCH turun, konteks 1h tidak bullish | 15.530 | −0,124 | selisih +0,015R terhadap baseline, dalam derau |

**Putusan kritik: tidak layak.** Sel terbaik dipilih sesudah melihat data; filter risiko ≥ 150 bps praktis hanya
meloloskan altcoin volatil (8% sinyal di 9 koin besar); selisih per tahun tidak konsisten (+0,156 / +0,014 / +0,049R);
15% sinyal sel itu akan terkena veto EXCESSIVE_VOLATILITY proyek; uji keputusannya berdaya rendah (setengah lebar CI ±0,17–
0,26R pada n = 250).

**Hipotesis yang dibekukan untuk uji ulang di data segar (paling cepat setelah 2027-01-03):** LHB-15 — pada 15m, CHoCH
turun (close menembus swing low terkonfirmasi terakhir setelah struktur HH+HL), lalu lower high baru di bawah high
sebelum CHoCH (berlaku 48 candle), lalu candle pemicu merah dengan close < low candle sebelumnya dalam 16 candle; stop
1,5 ATR, target 2R, batas 48 candle; konteks 1h tidak bullish sebagai gerbang eksplisit (bukan poin skor). Sebelum diuji,
empat ketidaksesuaian spesifikasi-vs-skrip yang dicatat kritik harus diputuskan, dan aturan veto volatilitas ditetapkan.

## 3. LONG 1h — kandidat BSV-1h

**Literatur:** breakout trading range punya daya prediksi di BTC harian (Gerritsen dkk. 2020, tanpa biaya); mekanisme
Osler: order stop menumpuk di balik level sehingga harga berakselerasi setelah level ditembus (jam, bukan hari; data FX).
Volume menandai besarnya gerak (Karpoff 1987). Pola candle klasik, SFP, reclaim EMA, dan higher low setelah CHoCH tidak
didukung bukti — dan SPRING/HIGHER_LOW/CHOCH Reversal Radar sudah gagal validasi data nyata (docs/21 §7).

**Uji eksplorasi** (30 koin teratas menurut volume, sinyal 2026-07-01 → 2026-09-29, 90 hari, tanpa funding):

| Kandidat | n | R bersih | Selisih vs baseline |
|---|---|---|---|
| Baseline B0 (setiap candle, geometri sama) | 64.800 | +0,030 | — |
| SFP (sapuan swing low lalu close kembali di atas) | 1.236 | +0,055 | +0,024 (CI memuat 0) |
| Bullish engulfing / hammer di support, RVOL ≥ 1,5 | 639 | +0,042 | +0,009 |
| Reclaim EMA25 | 3.032 | −0,043 | −0,072 (signifikan lebih buruk) |
| **BSV-1h: close pertama di atas swing high 1h terkonfirmasi, RVOL20 ≥ 2** | **851** | **+0,175** [+0,002 … +0,328] | **+0,145** [+0,008 … +0,287] |

Ketahanan di jendela yang sama (kritik): tanpa posisi tumpang tindih +0,199R; "tembusan pertama" +0,182R; leave-one-symbol-out
0,162–0,192R; CI blok mingguan [+0,051 … +0,308]; 21 dari 30 simbol positif. Dengan funding historis: +0,170R
[−0,001 … +0,323]. Keunggulan terkonsentrasi pada simbol yang sudah ada sejak 2024-01 (+0,261R, selisih +0,257R); pada
simbol lebih baru selisihnya −0,015R.

**Putusan kritik: layak dengan perbaikan.** Tetap satu periode 90 hari dengan ±44 sel yang dilihat, jadi angka eksplorasi
kemungkinan terlalu optimistis. Dua penghalang: runner backtest proyek menguji aturan yang berbeda (entri lewat state machine
dan gerbang tier, stop dari swing), dan tidak bisa menghitung kriteria lulus (tanpa baseline, CI berklaster, rincian per
tahun, atau ekspor per trade). Keduanya diselesaikan dengan alat studi kejadian khusus (§4.1) alih-alih runner.

## 4. Praregistrasi uji luar sampel BSV-1h

**Ditulis dan dibekukan 2026-11-15, SEBELUM uji luar sampel dijalankan.** Hanya hasil run pertama dengan file yang hash-nya
tercantum di §4.8 yang dihitung. Tidak ada parameter yang boleh diubah setelah hasil terlihat; perubahan apa pun berarti uji
baru dengan praregistrasi baru pada data yang belum dilihat.

### 4.1 Alat

- `backend/research/bsv1h.js` — detektor `detectBsvSignals` (aturan v1, tidak dipakai worker/scanner).
- `backend/backtest/eventStudy.js` — barrier tiga sisi LONG, biaya & funding dalam R, bootstrap berklaster per hari.
- `backend/backtest/funding.js` — riwayat funding Binance (`/fapi/v1/fundingRate`) dengan cache per bulan.
- `scripts/research-bsv-1h.js` — orkestrasi, baseline, kriteria, laporan (`npm run research:bsv -- --window oos`).
- **Paritas alat** (jendela eksplorasi yang sudah dilihat, tanpa funding): alat mereproduksi angka eksplorasi persis — B0
  n = 64.800, +0,030R; BSV-1h n = 851, +0,175R [+0,002 … +0,328], selisih +0,145R [+0,008 … +0,287].
- Tes: UNIT-BSV-001…007 (termasuk invariansi prefiks = tanpa lookahead), UNIT-EVS-001…010, UNIT-FND-001…003,
  UNIT-FUN-001…004.

### 4.2 Aturan (v1, dibekukan)

Pada candle 1h TERTUTUP i:
1. Level = swing high fraktal 2-2 terbaru yang sudah terkonfirmasi sebelum i (`confirmedIndex < i`), dengan indeks swing
   ≥ i − 48.
2. Pemicu: `close[i] > level` DAN `close[i−1] ≤ level` DAN `RVOL20[i] ≥ 2` (volume candle i ÷ rata-rata 20 candle sebelumnya).
3. Pemanasan: i ≥ 25 dan ATR14[i] > 0; jeda 6 candle antarsinyal per simbol (dihitung dari sinyal terakhir yang terbit).

Eksekusi: entri open candle i+1; stop = entri − 1,5 × ATR14[i]; target = entri + 2R; batas 48 candle (keluar di close
candle i+48); stop diperiksa lebih dulu bila stop & target tersentuh pada candle yang sama. Posisi boleh tumpang tindih
(seperti eksplorasi); varian tanpa tumpang tindih dilaporkan sebagai ketahanan.

### 4.3 Data & semesta

- Kline 1h Binance USDT-M dari `data/backtest-cache` (hanya dibaca). Dimuat 2024-01-01 → 2026-07-01.
- **Jendela sinyal: openTime candle i di [2024-01-15, 2026-06-28).** Jendela ini tidak beririsan dengan jendela eksplorasi
  (sinyal 2026-07-01 → 2026-09-29).
- Semesta: **semua 31 simbol** di cache; sinyal dan baseline suatu simbol baru dihitung setelah ≥ 300 candle 1h riwayatnya.
- Keterbatasan yang diterima: daftar simbol cache dipilih menurut volume 2026-10 (bias survivorship; cenderung
  menguntungkan LONG). Keputusan karena itu juga mensyaratkan selisih terhadap baseline pada simbol yang sama (P2, P3),
  dan subset simbol sejak 2024-01 dilaporkan terpisah.

### 4.4 Biaya & funding

- Biaya utama: 5 bps fee + 2 bps slippage per sisi (14 bps pulang-pergi), dalam R = biaya × harga entri ÷ jarak stop.
- Biaya stres: 5 + 5 bps per sisi (20 bps pulang-pergi).
- Funding: riwayat nyata Binance per simbol. Setiap funding dengan waktu di [open candle entri, akhir candle keluar)
  dihitung dengan harga open candle saat itu (konservatif saat funding positif). Funding positif mengurangi hasil LONG.

### 4.5 Pembanding

Baseline B0: setiap candle di jendela (simbol, riwayat, dan syarat ATR yang sama) dengan eksekusi, biaya, dan funding yang
sama, tanpa jeda. Selisih BSV − B0 dihitung dengan bootstrap berpasangan per hari (hari baseline disampling ulang; sinyal &
baseline pada hari terpilih ikut bersama), 2000 replikasi, benih 11. CI rata-rata: bootstrap berklaster per hari, 2000
replikasi, benih 7.

### 4.6 Kriteria lulus (SEMUA harus terpenuhi)

| ID | Kriteria |
|---|---|
| P0 | n sinyal ≥ 200 |
| P1 | rata-rata R bersih (biaya utama + funding) > 0 **dan** batas bawah CI 95% berklaster harian > 0 |
| P2 | selisih terhadap baseline B0: batas bawah CI 95% bootstrap berpasangan harian > 0 |
| P3 | selisih terhadap B0 > 0 di ≥ 2 dari 3 sub-periode: 2024, 2025, 2026H1 |
| P4 | rata-rata R bersih dengan biaya stres 5 + 5 bps per sisi > 0 |
| P5 | leave-one-symbol-out: rata-rata R bersih minimum > 0 |

Dilaporkan tetapi **bukan** penentu: varian tanpa tumpang tindih, "tembusan pertama", subset simbol sejak 2024-01 vs lebih
baru, label tren 4h saat sinyal, hasil per simbol, dan ekspor per trade.

### 4.7 Konsekuensi

- **LULUS:** BSV-1h boleh diusulkan ke LONG Scanner sebagai pola **eksperimen** — keputusan pemilik terpisah. Prasyarat
  dari tinjauan kritik sebelum masuk scanner: parameter sinyal per pola (gerbang tier, kedaluwarsa 48 bar sejak sinyal,
  invalidasi dikunci), migrasi kunci pola baru dengan cadangan database, label tren 4h netral (bukan alignment/veto),
  kalibrasi per pola tanpa fallback ke tabel `LONG:*`, keputusan tertulis soal prinsip cermin LONG/SHORT di PRODUCT.md,
  teks UI tanpa angka R/peluang, serta tes invariansi jendela, paritas skrip-vs-produksi, dan kasus batas.
- **TIDAK LULUS:** BSV-1h tidak masuk scanner. Hasil dicatat apa adanya di §5; tidak ada penyetelan ulang pada data ini.

### 4.8 Hash SHA-256 file yang dibekukan

| File | SHA-256 |
|---|---|
| `backend/research/bsv1h.js` | `423b64eef2d8afff0753f2ab62d99cd91494f5364ce058eb96cacaf4532fc3b1` |
| `backend/backtest/eventStudy.js` | `634acc705ef9fc528e83ea7107bd699199efcf35a76ebeb3f6baeee2262b717a` |
| `backend/backtest/funding.js` | `e885eadeb036c9154c1565041bf2d381e99e89474f6c433fd0e43da9cf61d928` |
| `scripts/research-bsv-1h.js` | `9ee562bdcb94fbc10f49e634070bbc0469cf9ab8221b362d5096c81f4ee49f60` |

Laporan run mencantumkan hash yang sama; bila berbeda, run itu tidak sah sebagai uji keputusan.

## 5. Hasil uji luar sampel (run pertama, 2026-11-15, ditulis SESUDAH praregistrasi §4)

Run: `npm run research:bsv -- --window oos` → `reports/research/bsv-1h-oos-funding-on.{json,md}` (laporan lokal, tidak
di-commit). Hash keempat file dalam laporan **sama** dengan §4.8. Funding diambil dari Binance lewat DoH (`BINANCE_DNS=doh`).

| Sel | n | Win rate | R kotor | Biaya R | Funding R | R bersih [CI 95% klaster harian] | Selisih vs B0 [CI 95%] |
|---|---|---|---|---|---|---|---|
| Baseline B0 (setiap candle) | 491.071 | 29,9% | −0,044 | 0,077 | 0,004 | −0,125 [−0,163 … −0,083] | — |
| **BSV-1h v1 (keputusan)** | **5.456** | **33,0%** | **+0,020** | **0,082** | **0,004** | **−0,066 [−0,140 … +0,001]** | **+0,059 [−0,004 … +0,121]** |
| Ketahanan: tanpa tumpang tindih | 4.969 | 33,5% | +0,033 | 0,081 | 0,004 | −0,052 [−0,123 … +0,019] | +0,073 [+0,008 … +0,137] |
| Ketahanan: tembusan pertama | 5.211 | 33,3% | +0,026 | 0,082 | 0,004 | −0,060 [−0,129 … +0,009] | +0,065 [+0,001 … +0,127] |
| Ketahanan: simbol sejak 2024-01 | 4.306 | 33,0% | +0,020 | 0,090 | 0,005 | −0,075 [−0,154 … +0,001] | +0,062 [−0,010 … +0,131] |
| Ketahanan: simbol lebih baru | 1.150 | 33,3% | +0,018 | 0,052 | 0,002 | −0,035 [−0,126 … +0,053] | +0,048 [−0,039 … +0,137] |

| Sub-periode | n sinyal | R bersih sinyal | R bersih B0 | Selisih |
|---|---|---|---|---|
| 2024 | 1.796 | −0,103 | −0,138 | +0,035 |
| 2025 | 2.186 | −0,076 | −0,109 | +0,034 |
| 2026H1 | 1.474 | −0,009 | −0,134 | +0,126 |

Biaya stres 5 + 5 bps: −0,102R. Leave-one-symbol-out: −0,075 … −0,061R. Label tren 4h saat sinyal (laporan saja): BULLISH
−0,009R (n = 2.260), NEUTRAL −0,020R (n = 1.489), BEARISH −0,182R (n = 1.707) — kebalikan dari eksplorasi (BEARISH terbaik
+0,331R), jadi pola 4h di eksplorasi adalah derau.

**Kriteria:** P0 ✅ (n = 5.456) · P1 ❌ (CI [−0,140 … +0,001]) · P2 ❌ (batas bawah −0,004) · P3 ✅ (3/3 sub-periode) ·
P4 ❌ (−0,102R) · P5 ❌ (maks −0,061R). **Putusan: TIDAK LULUS → BSV-1h tidak masuk scanner** (§4.7).

**Tafsiran (jujur, bukan klaim):**
- Setelah biaya dan funding, BSV-1h **rugi rata-rata ±0,07R per trade** di 2,5 tahun data yang tidak dipakai eksplorasi.
  Angka +0,175R di eksplorasi sebagian besar milik periode Jul–Sep 2026 (drift naik) dan pemilihan sel.
- Breakout bervolume konsisten ±0,06R lebih baik daripada entri LONG acak dengan geometri sama (positif di ketiga
  sub-periode), tetapi tidak signifikan pada aturan keputusan dan jauh di bawah biaya ±0,08R per trade. Paling jauh ini
  informasi deskriptif lemah, bukan aturan entri.
- Varian "tanpa tumpang tindih" punya selisih dengan CI di atas nol, tetapi itu varian ketahanan yang dilihat bersama banyak
  sel lain dan hasil bersihnya tetap negatif; memakainya sekarang berarti memilih sel sesudah melihat data. Bila ingin
  diuji, perlu praregistrasi baru pada data segar.

Alat riset (§4.1) tetap di repo untuk menguji kandidat berikutnya dengan disiplin yang sama.

## 6. Keterbatasan umum

- Semua uji memakai satu bursa (Binance USDT-M) dan 29–31 simbol yang dipilih menurut volume terkini.
- Celah data (maintenance) tidak dikoreksi; barrier menghitung candle, bukan jam.
- Eksekusi diasumsikan di open candle berikutnya tanpa dampak harga di luar slippage yang dimodelkan.
- Hasil uji historis bukan jaminan kinerja dan tidak boleh ditampilkan di UI sebagai peluang atau ekspektasi.
