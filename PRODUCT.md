# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Pemilik (peran `admin`).** Peneliti/trader kripto yang menjalankan AlphaLens di Mac miliknya sendiri (server lokal `127.0.0.1`). Ia membuka terminal ini untuk sesi riset yang panjang: memantau kandidat LONG dan SHORT, membaca grafik dan alasan sinyal, memeriksa aktivitas wallet on-chain, serta menjalankan atau menghentikan scanner.
- **Analyst (opsional).** Paling banyak satu pengguna lain (`MAX_USERS=2`). Akunnya dibuat admin lewat CLI (`npm run user:create`). Analyst hanya melihat; ia tidak dapat menjalankan atau menghentikan scanner.
- Tidak ada pendaftaran publik. Halaman awal (landing) adalah **pintu depan privat** untuk orang yang sudah diberi akun: menjelaskan singkat apa AlphaLens dan modulnya, lalu tombol Masuk. Halaman ini bukan materi pemasaran, tidak mengajak mendaftar, dan tetap `noindex` (keputusan pemilik, 2026-11-15).

## Product Purpose

AlphaLens adalah terminal intelijen kripto privat untuk **riset dan pendukung keputusan**. Ia mendeteksi lebih awal struktur bullish (kandidat LONG) dan struktur bearish (kandidat SHORT) pada USDT-M perpetual Binance, dengan sinyal yang dapat dijelaskan. AlphaLens bukan sistem trading otomatis dan tidak pernah mengeksekusi order di arah mana pun.

AlphaLens berhasil bila pengguna dapat menemukan kandidat, memahami *mengapa* kandidat itu muncul, dan menilai sendiri apakah layak diteliti lebih lanjut, tanpa dibuat percaya pada klaim yang belum terbukti.

## Positioning

- Membaca struktur pasar **dua arah** dengan aturan cermin: pola SHORT (Silent Distribution #003, Progressive Volume Distribution #004) adalah cermin harga dari pola LONG (Silent Accumulation #001, Progressive Volume Accumulation #002), sehingga kedua arah selalu konsisten.
- Sinyal terkonfirmasi hanya dari candle tertutup; setiap skor dapat ditelusuri ke aturan pola yang berversi.
- Jujur tentang batasnya. Skor adalah kecocokan aturan 0–100, bukan probabilitas profit. Hasil validasi Reversal Radar (run 1–4, termasuk uji luar sampel) tidak menunjukkan keunggulan terukur; fitur itu kini diposisikan sebagai pelabel struktur, bukan prediksi.
- Smart Money Radar menampilkan token yang sedang dibeli lewat swap oleh beberapa wallet on-chain yang saling independen, dengan bukti transaksi dan flag risiko. Hanya alamat publik; tidak pernah meminta seed phrase atau private key.

## Operating Context

- Satu terminal `npm start` di Mac pemilik. Scanner (worker terpisah) dijalankan dari System Health atau dari kontrol scanner ringkas di Overview, LONG Scanner, dan SHORT Scanner. Satu worker memindai LONG dan SHORT sekaligus.
- Sumber data: Binance REST/WebSocket (simbol, candle), Etherscan dan kunci Binance read-only untuk smart money. Tanpa data, layar menampilkan empty state; tidak pernah data contoh.
- Layar: Overview, LONG Scanner (memuat Reversal Radar, `#/screener`), SHORT Scanner, Symbol Intelligence, Signal History, Smart Money Radar, Wallet Discovery, Watchlist & Alerts, Profil Wallet, Detail Token, Pattern Discovery Lab (belum dimulai), Backtest Lab, Pengaturan, System Health, Design System.
- Perangkat utama: desktop/laptop (Mac). Tes E2E juga mencakup ponsel 390×844, jadi setiap layar harus tetap dapat dipakai di ponsel.
- Inferensi (belum dikonfirmasi): sesi sering berlangsung lama dan bisa malam hari karena pasar kripto buka 24 jam.

## Capabilities and Constraints

- Frontend tanpa framework dan tanpa bundler: HTML5, CSS3, vanilla JavaScript ES modules. DOM dirender lewat `h()` + `textContent`; `innerHTML` dilarang oleh ESLint (pencegahan XSS).
- Disajikan Fastify dari `frontend/` dengan CSP ketat (`default-src 'self'`, `style-src 'self'`, `font-src 'self'`, tanpa inline script). Semua aset self-hosted: tanpa CDN dan tanpa font eksternal.
- Semua halaman `noindex, nofollow`.
- Grafik candle memakai TradingView Lightweight Charts 5.2.1 (Apache-2.0); atribusinya wajib dipertahankan.
- Bahasa UI: Indonesia. Istilah pasar tetap dalam bentuk aslinya (LONG, SHORT, BREAKOUT, Early Score, tier A–D).
- Format: angka `id-ID`, waktu `YYYY-MM-DD HH:mm:ss UTC`, nilai yang belum ada ditampilkan `—`, tidak pernah `0` palsu.
- Pengujian: Vitest (unit/integrasi/keamanan) dan Playwright (desktop 1440×900 dan mobile 390×844) harus tetap lulus.
- Dalam perombakan UI 2026-11, menu, alamat halaman (hash route), dan semua fungsi tetap sama; yang berubah adalah tampilan dan penataan isi tiap layar (keputusan pemilik, 2026-11-15).
- Belum dimulai: Pattern Discovery Lab, deployment privat (Docker, HTTPS).

## Brand Commitments

- Nama produk: **AlphaLens**. Nama folder repo "Caddle" dan prefix token `--lr-` (dari nama lama "Long Radar") bukan nama produk.
- Suara: Bahasa Indonesia yang lugas, teknis, dan jujur. Peringatan dan batasan ditulis terang, misalnya "Skor bukan probabilitas profit yang terkalibrasi."
- Logo lensa digambar khusus untuk proyek ini (bukan aset pihak ketiga).
- Tidak boleh terasa seperti dasbor kripto generik: latar gelap dengan neon, glow, dan gradien (keputusan pemilik, 2026-11-15).

## Evidence on Hand

- Data nyata hanya dari API (Binance, Etherscan). Tidak ada testimoni, pelanggan, harga, atau klaim kinerja, dan semua itu tidak boleh dikarang.
- Hasil validasi tersedia di repo: `docs/21-validasi-reversal-radar.md` (Reversal Radar run 1–4), `docs/13-panduan-akurasi-v3.md`, `docs/16-riset-machine-learning.md`.
- Fixture E2E (`tests/fixtures/`) berisi data SIMULASI. Boleh dipakai untuk tangkapan layar pengujian, bukan sebagai bukti.

## Product Principles

1. Jujur sebelum meyakinkan: setiap angka diberi konteks; tidak ada klaim profit atau prediksi.
2. Dapat dijelaskan: setiap sinyal menunjukkan aturan, tahap, dan alasannya.
3. Riset, bukan eksekusi.
4. Privat secara default: lokal, `noindex`, tanpa pihak ketiga.
5. Padat tetapi tetap terbaca untuk sesi yang panjang.

## Accessibility & Inclusion

- WCAG 2.x AA: teks ≥ 4.5:1; teks besar, kontrol, dan indikator fokus ≥ 3:1 (tes `UNIT-A11Y-001` menghitung kontras cincin fokus).
- Fokus selalu terlihat; skip link, landmark, `aria-current` pada navigasi, header tabel sortable berupa tombol dengan `aria-sort`.
- Menghormati `prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast: more`, dan `forced-colors`.
- Warna tidak pernah menjadi satu-satunya pembawa makna: tahap sinyal selalu berlabel teks.
- Tanpa scroll horizontal halaman pada lebar 390 px.
