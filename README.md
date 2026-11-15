# AlphaLens

Terminal intelijen kripto privat untuk **riset dan pendukung keputusan** — mendeteksi struktur bullish (kandidat LONG) dan, lewat [Short Scanner](#short-scanner-riset), struktur bearish (kandidat SHORT) lebih awal pada USDT-M perpetual Binance, dengan sinyal yang dapat dijelaskan. Aplikasi ini **bukan** sistem trading otomatis dan tidak mengeksekusi order di arah mana pun.

> Skor pola bukan probabilitas profit yang terkalibrasi. Jangan menganggap strategi apa pun menguntungkan tanpa bukti out-of-sample yang andal.

## Status

| Milestone | Cakupan | Status |
|---|---|---|
| 1 — Fondasi | Audit, arsitektur, autentikasi, shell frontend, API, migrasi | **Selesai (di `main`)** |
| 2 — Data pasar | Binance REST/WS, candle historis, validasi, worker | **Selesai (di `main`; REST + WebSocket live terverifikasi di Mac pemilik, lihat laporan)** |
| 3 — Mesin pola | SA, PVA, hybrid timeframe, skor, state machine | **Selesai (di `main`)** |
| Short Scanner (lanjutan M3) | Pola SHORT SD & PVD, state SHORT, API `direction`, migrasi `005`, halaman SHORT Scanner | **Di `main`** — kode selesai; pengujian end-to-end dilakukan pemilik di mesin lokal |
| 4 — Dashboard premium | Screener, grafik, real-time | **Sebagian** — grafik koin di sebelah tabel scanner, halaman detail Symbol Intelligence ([docs/08](docs/08-grafik-simbol.md)), proses sync scanner live ([docs/09](docs/09-proses-sync.md)) |
| 5 — Pattern Discovery Lab | Upload, anotasi, definisi pola berversi | Belum dimulai |
| Akurasi scanner v3 | Fitur struktur pasar/order flow/rezim/Wyckoff, skor konfluensi + tier A–D LONG & SHORT, gerbang tier, migrasi `006` | **Di `main`** — lihat [docs/13](docs/13-panduan-akurasi-v3.md); bobot = hipotesis yang wajib diverifikasi backtest data nyata |
| 6 — Backtesting | Replay historis, metrik, out-of-sample | **Sebagian** — `npm run backtest` (walk-forward, triple barrier, Wilson CI, kalibrasi); dijalankan pemilik di Mac karena Binance diblokir dari cloud |
| Riset ML (meta-labeling) | Lab regresi logistik & gradient boosting murni JS vs kalibrasi skor, walk-forward 5 fold + embargo, kontrol label acak, aturan adopsi | **Lab saja** — `npm run backtest -- ... --ml`; scanner live tidak berubah. Lihat [docs/16](docs/16-riset-machine-learning.md) |
| 7 — Keamanan & QA | Pengujian lengkap, pemindaian, pentest | Berjalan terus sejak M1 |
| 8 — Deployment privat | Docker, HTTPS, backup, monitoring | Belum dimulai |

Detail: [docs/03-rencana-implementasi.md](docs/03-rencana-implementasi.md).

## Teknologi

- **Frontend:** HTML5, CSS3, Vanilla JavaScript (ES Modules), tanpa framework dan tanpa bundler. Grafik koin memakai TradingView Lightweight Charts (Apache-2.0, dipin eksak, disajikan dari `node_modules` lewat satu rute file tetap — lihat [docs/08](docs/08-grafik-simbol.md) dan `THIRD_PARTY_NOTICES.md`).
- **Backend:** Node.js 22 atau 24 (LTS), Fastify 5, JSON Schema validation, arsitektur modular monolith.
- **Database:** SQLite (better-sqlite3) dengan migrasi berversi dan lapisan repositori — disiapkan untuk migrasi ke PostgreSQL.
- **Pengujian:** Vitest (unit/integrasi), Playwright (E2E), ESLint, npm audit, Semgrep.

## Menjalankan secara lokal

Prasyarat: Node.js 22.12+ atau 24 (keduanya LTS; diuji di 22.22.0 dan 24.15.0). Node 25+ belum didukung.

```bash
git clone https://github.com/zainpewpewpew/Caddle.git
cd Caddle
```

> **macOS:** `.npmrc` memakai `ignore-scripts=true`, sehingga modul native memakai binary prebuilt bawaan paket. Di Mac Apple Silicon (M1/M2/M3/M4) semuanya langsung jalan. Di Mac Intel, `argon2` belum menyertakan binary `darwin-x64`; setelah `npm ci` jalankan sekali `npm rebuild argon2 --ignore-scripts=false` (butuh Xcode Command Line Tools: `xcode-select --install`).

> **Upgrade dari nama lama (Long Radar):** default database kini `./data/alphalens.db`. Jika `.env` Anda menyetel `DATABASE_PATH=./data/long-radar.db` (hasil salinan `.env.example` lama), tidak ada yang perlu diubah. Jika tidak ada `.env` atau `DATABASE_PATH` kosong, pindahkan `data/long-radar.db` beserta file `-wal`/`-shm`-nya menjadi `data/alphalens.db`, atau setel `DATABASE_PATH=./data/long-radar.db`; tanpa itu server membuka database baru yang kosong.

```bash
npm ci
cp config/.env.example .env          # sesuaikan bila perlu
npm run migrate                      # membuat/memperbarui skema database
npm run user:create -- --username mary --role admin   # opsional (lihat Login prototipe); kata sandi diminta tersembunyi
npm start                            # http://127.0.0.1:8080 → halaman awal; tombol Masuk ke /login.html
```

> **Setelah `git pull`:** jalankan `npm ci` lagi bila `package.json`/`package-lock.json` berubah (mis. library grafik `lightweight-charts`). Server tetap start tanpa paket itu, tetapi grafik koin tidak tersedia dan log startup memperingatkan.

Cukup **satu terminal** dan **satu perintah**: `npm start` langsung menjalankan scanner (default `WORKER_AUTOSTART` di development) dan membuka browser ke website (`OPEN_BROWSER`). Server menjalankan worker scanner (discovery simbol, candle REST/WebSocket, analisis pola) sebagai proses terpisah; bila worker crash, server menjalankannya ulang otomatis. Lihat [Scanner (worker)](#scanner-worker).

**Melihat apa yang sedang dikerjakan:**

- **Terminal `npm start`** menampilkan banner alamat website + status scanner, lalu log ringkas berjam WIB (bukan JSON). Tiap menit muncul satu baris ringkasan scan, mis. `19:04:05  scanner  scan #57: 120/120 seri mutakhir · harga live 120 seri · sinyal terbuka LONG 4 · SHORT 2`, plus baris untuk candle yang dianalisis, sinyal baru, dan galat. Log per-request tidak dicetak di terminal interaktif. Output yang dialihkan ke file/layanan tetap JSON (`LOG_FORMAT`).
- **Website:** strip status di bawah topbar (semua halaman) menampilkan *Live* / *Sinkron data* / *Berhenti* / *Berhenti tak terduga — dijalankan ulang otomatis dalam …*, scan terakhir dan hitung mundur ke scan berikutnya, jumlah koin & seri yang mutakhir, kapan harga terakhir masuk, kapan candle 15m/1h berikutnya tutup, dan kapan tabel halaman dimuat ulang. Tombol **Aktivitas** membuka ±30 kejadian terakhir worker (scan, candle dianalisis, sinyal baru, galat).
- **Data tiap 1 menit:** worker memindai semua seri tiap menit (detik :05) dan menambal candle yang tertinggal; tabel LONG/SHORT Scanner dimuat ulang tiap menit dan kolom **Harga** memakai harga live candle berjalan (titik kecil = live). Sinyal tetap dihitung dari candle **tertutup** (SHORT 15m, LONG 1h), jadi tidak berubah-ubah sebelum candle tutup.

Pendaftaran publik sengaja tidak ada. Maksimal dua pengguna (`MAX_USERS=2`) dibuat lewat CLI di server; batas ini berlaku juga bila beberapa `user:create` berjalan bersamaan. Kata sandi minimal 12 karakter (kecuali kata sandi akun default prototipe di bawah, yang dipilih pemilik).

### Login prototipe

Selama masih prototipe, `npm start` otomatis membuat akun default pada start pertama **bila belum ada pengguna sama sekali**:

| Username | Kata sandi | Peran |
|---|---|---|
| `admin` | `admin123@` | admin |

- **Hanya untuk pengembangan lokal.** Akun dibuat hanya bila `NODE_ENV=development` (default), server hanya lokal (`HOST` dan `APP_ORIGIN` loopback — `127.0.0.1`, `::1`, atau `localhost` — dan `TRUST_PROXY=false`), serta tabel pengguna masih kosong. Akun yang sudah ada tidak pernah ditimpa atau di-reset. Log server menampilkan peringatan saat akun dibuat, atau alasan bila tidak dibuat (bila sudah ada pengguna: jumlahnya saja, tanpa username).
- **Ganti kata sandinya:** `npm run user:password -- --username admin` (prompt tersembunyi dengan konfirmasi; semua sesi akun itu dicabut, dan login dengan kata sandi lama yang sedang berjalan saat itu ikut ditolak). Selama `admin` masih memakai kata sandi default, server menolak start bila tidak lagi hanya lokal (mis. `HOST=0.0.0.0`) atau `NODE_ENV=production`.
- **Ketik kata sandi secara manual** setelah prompt muncul: prompt `user:create`/`user:password` menolak tempelan multi-baris, ketikan sebelum prompt tampil, dan karakter kontrol (panah, Esc, Tab, Ctrl+D). Untuk otomasi, kirim satu baris lewat stdin: `printf '%s' "$PASS" | npm run user:password -- --username admin`.
- **Nonaktifkan:** set `DEFAULT_USER=false` di `.env` sebelum start pertama. `DEFAULT_USER=true` ditolak di produksi.
- Akun `admin` dihitung dalam `MAX_USERS`. Bila ingin dua akun pribadi tanpa `admin`, jalankan `npm run user:create` sebelum `npm start` pertama (akun default tidak dibuat bila sudah ada pengguna, juga bila `user:create` selesai saat start pertama masih berjalan).

## Scanner (worker)

Worker scanner selalu berjalan sebagai **proses terpisah** dari server API, dengan dua cara menjalankannya. Pilih salah satu, jangan keduanya.

1. **Dari website (disarankan):** System Health → kartu **Kontrol scanner** → **Jalankan scanner** / **Hentikan scanner** (dengan konfirmasi). Overview, LONG Scanner, dan SHORT Scanner juga selalu menampilkan kontrol scanner ringkas (selama `WORKER_CONTROL` aktif): status scanner dan satu tombol yang berganti antara **Jalankan scanner** dan **Hentikan scanner** (dengan konfirmasi). Satu worker memindai LONG dan SHORT sekaligus, jadi satu kontrol mencakup keduanya. Hanya **admin** yang dapat menjalankan atau menghentikan; analyst hanya melihat statusnya.
   - Status: *Berjalan*, *Berhenti*, *Memulai…*, *Menghentikan…*, *Gagal (kode keluar N)*, atau *Berjalan di luar website*.
   - **Proses sync terlihat langsung:** setelah start, kontrol ringkas menampilkan langkah yang sedang berjalan (sinkron jam → discovery simbol → backfill candle x/y seri → stream live → analisis pola) dan System Health memuat panel **Proses sync scanner** lengkap, diperbarui tiap 2 detik selama sync dan tiap 10 detik saat live ([docs/09](docs/09-proses-sync.md)).
   - Menghentikan scanner mengirim SIGTERM (worker menyelesaikan tugas aktif dan menulis heartbeat akhir); bila belum berhenti dalam 15 detik, worker dihentikan paksa (SIGKILL).
   - Menutup server (Ctrl+C / SIGTERM, atau menutup jendela terminal `npm start` yang mengirim SIGHUP) menghentikan worker lebih dulu. Bila server mati mendadak, worker berhenti sendiri saat koneksi IPC ke server terputus.
   - Worker yang crash **dijalankan ulang otomatis**: status *Gagal (kode keluar N)* dengan jadwal start ulang (strip status menampilkan hitung mundurnya). Jeda 10 detik untuk crash pertama, berlipat ganda untuk crash beruntun (20 → 40 … maks 5 menit); worker yang sempat berjalan ≥ 10 menit dianggap stabil sehingga jeda kembali 10 detik. Setiap percobaan tercatat di audit (`worker.start`, `via: auto-restart`). **Hentikan scanner** saat start ulang terjadwal membatalkannya. Berhenti normal (tombol Hentikan, Ctrl+C) tidak pernah memicu start ulang.
   - **Jeda start ulang 10 detik:** setelah worker berhenti atau crash, start berikutnya baru diterima 10 detik kemudian (sebelumnya: pesan "Scanner baru saja berhenti. Tunggu beberapa detik lalu coba lagi.", HTTP 429). Setiap proses worker baru memulai pembatas bobot dan status blokir Binance (418/429) dari nol, jadi restart beruntun tidak boleh membanjiri Binance. Tombol start/stop juga dibatasi 10 permintaan per menit.
   - **Audit:** setiap permintaan start/stop dari pengguna yang sudah login tercatat di log audit (`worker.start` / `worker.stop`): berhasil, ditolak supervisor (mis. sudah berjalan, jeda), ditolak karena bukan admin atau token CSRF tidak valid (403), maupun error internal (500). Permintaan yang ditolak sebelum sesi dikenali (tanpa login 401, Origin lintas situs, atau rate limit 429) tidak tercatat karena tidak ada pengguna yang dapat dicatat.
2. **Terminal terpisah:** `npm run worker` tetap tersedia (mis. bila kontrol website dinonaktifkan). Jangan jalankan bersamaan dengan worker dari website: dua worker pada satu database menggandakan ingesti. Selama worker dari terminal masih mengirim heartbeat (< 90 detik), tombol menolak menjalankan worker kedua dan status tampil *Berjalan di luar website*. Hentikan worker itu dari terminalnya (Ctrl+C). Heartbeat memuat pid worker penulisnya: bila proses itu sudah tidak ada di komputer yang sama (mis. dibunuh paksa sebelum sempat menulis heartbeat akhir), heartbeatnya tidak lagi memblokir tombol maupun `WORKER_AUTOSTART`.

| Variabel | Default | Fungsi |
|---|---|---|
| `WORKER_CONTROL` | aktif bila `NODE_ENV=development`; nonaktif di `test` & `production` | `true`/`false`: menampilkan & mengizinkan tombol scanner di website. Saat nonaktif, API start/stop menjawab 503 dan System Health menyarankan `npm run worker`. |
| `WORKER_AUTOSTART` | aktif bila `NODE_ENV=development` dan `WORKER_CONTROL` aktif; `false` di `test` & `production` | `true`: server langsung menjalankan worker saat start (butuh `WORKER_CONTROL` aktif; tercatat di audit, `via: autostart`). Dibatalkan bila worker di luar website sedang berjalan. `false`: scanner menunggu tombol **Jalankan scanner**. |
| `OPEN_BROWSER` | aktif bila `NODE_ENV=development` | `true`: setelah server siap, browser default dibuka ke `APP_ORIGIN` — hanya untuk `npm start` di terminal interaktif (tidak untuk `npm run dev` yang memuat ulang, atau output yang dialihkan). |
| `LOG_FORMAT` | `auto` | `auto`: teks ringkas berjam WIB bila stdout terminal interaktif, JSON per baris bila tidak. `pretty` / `json`: paksa salah satunya. Warna mengikuti `NO_COLOR`. |
| `BINANCE_DNS` | `doh` | Cara me-resolve host Binance. `doh`: DNS-over-HTTPS **khusus** `*.binance.com` / `*.binance.vision` (lihat di bawah). `system`: resolver sistem saja (perilaku lama). Nilai lain membuat server dan worker menolak start. |

Nilai selain `true`/`false` membuat server menolak start (fail fast).

### Jaringan yang memblokir DNS Binance (tanpa WARP/VPN)

Sebagian ISP membajak DNS `*.binance.com`: resolver sistem, dan bahkan DNS biasa ke 1.1.1.1/8.8.8.8, dijawab IP halaman blokir, padahal koneksi ke IP asli Binance tetap lancar. Dulu scanner hanya jalan setelah WARP dinyalakan. Dengan `BINANCE_DNS=doh` (default), worker dan server me-resolve **hanya** host Binance lewat DNS-over-HTTPS ke `1.1.1.1`, `8.8.8.8`, `1.0.0.1`, `8.8.4.4` (dipanggil dengan IP, jadi tidak butuh DNS sistem). Host lain tetap memakai resolver sistem.

- TLS tidak berubah: SNI dan verifikasi sertifikat tetap memakai nama host asli Binance. DoH hanya memilih IP tujuan; jawaban yang menunjuk jaringan lokal/privat ditolak.
- Jawaban di-cache sesuai TTL (30 detik–10 menit). Bila semua resolver DoH gagal, jawaban lama dipakai hingga 1 jam; tanpa cache, worker jatuh ke resolver sistem dan mencatat peringatan.
- Berlaku untuk scanner (REST + WebSocket), funding riset, dan pemetaan kontrak Binance di Smart Money (`binance-public` / `binance-mapping`). Provider non-Binance (Etherscan, Routescan, GeckoTerminal) tetap memakai DNS sistem.
- Log worker saat start: `DNS Binance: DNS-over-HTTPS (khusus host Binance)`.
- Jaringan yang memblokir koneksi ke Binance di level TLS/IP (bukan hanya DNS) tetap butuh VPN; DoH tidak menolong di situ. Cek cepat: `curl --resolve fapi.binance.com:443:<IP dari DoH> https://fapi.binance.com/fapi/v1/ping` harus menjawab `{}`.
- Implementasi: `backend/ingestion/binance/doh.js` dan `network.js` (undici); tes UNIT-DOH-*, INT-DOH-*.

## Grafik koin & detail simbol

Klik (atau Enter pada) baris kandidat di LONG/SHORT Scanner untuk membuka grafik candlestick koin itu di sebelah tabel (di layar sempit: di bawahnya): volume, EMA7/EMA25, level invalidasi & deteksi pertama, serta ringkasan sinyal (arah, pola, tahap, skor, risk flag). Tombol **Buka detail** membuka halaman **Symbol Intelligence** (`#/symbol?s=BTCUSDT&tf=15m&dir=LONG`) dengan grafik besar, riwayat sinyal kedua arah, dan penjelasan kondisi sinyal terakhir. Data grafik = candle tertutup dari database (`GET /api/market/candles`); tanpa candle tampil empty state, tidak pernah data contoh. Detail: [docs/08](docs/08-grafik-simbol.md).

## Short Scanner (riset)

Selain kandidat **LONG** (struktur bullish), worker yang sama memindai kandidat **SHORT** (struktur bearish) pada setiap candle tertutup. Sinyal SHORT adalah **kandidat riset** untuk diteliti lebih lanjut — bukan rekomendasi jual/short, bukan probabilitas, dan tidak ada klaim profitabilitas. Aplikasi tidak pernah mengirim order, baik LONG maupun SHORT.

| | LONG | SHORT |
|---|---|---|
| Pola | Silent Accumulation (SA, #001), Progressive Volume Accumulation (PVA, #002) | Silent Distribution (SD, #003), Progressive Volume Distribution (PVD, #004) |
| Klasifikasi | `SA`, `PVA`, `BOTH` | `SD`, `PVD`, `BOTH` |
| Tahap | `QUIET` → `EARLY_BULLISH` → `MOMENTUM_BUILDING` → `BREAKOUT` | `QUIET` → `EARLY_BEARISH` → `MOMENTUM_BUILDING` → `BREAKDOWN` |
| Invalidasi | close di bawah `invalidationPrice` (di bawah swing low) | close di atas `invalidationPrice` (di atas swing high) |
| Alignment `ALIGNED` | semua timeframe lebih tinggi bullish | semua timeframe lebih tinggi bearish |

- **SD/PVD adalah cermin SA/PVA:** candle dicerminkan (harga → 1/harga, high ↔ low) lalu detektor SA/PVA yang sama dijalankan, sehingga aturan kedua arah selalu konsisten. Semua harga yang disimpan dan ditampilkan adalah harga nyata. Parameter default SD/PVD sama dengan SA/PVA — titik awal, bukan hasil optimasi; wajib divalidasi backtest out-of-sample (Milestone 6).
- **`BREAKDOWN`** = close di bawah support (swing low terkonfirmasi terakhir) **dan** di bawah harga deteksi pertama, dengan RVOL ≥ ambang breakout. Sinyal SHORT dan LONG pada simbol & timeframe yang sama berjalan terpisah.
- **Tampilan:** halaman **SHORT Scanner** (`#/short-scanner`) di samping **LONG Scanner** (`#/screener`), dengan filter pola SD/PVD/BOTH dan tahap Early bearish/Momentum/Breakdown; tanpa kandidat, halaman menampilkan keadaan kosong (tanpa data contoh). Signal History menampilkan kedua arah dengan badge arah; Overview menambah KPI *Kandidat SHORT aktif*. Skor tetap skor kecocokan aturan 0–100, bukan probabilitas.
- **LONG Scanner = pola SA/PVA 1h** (tabel utama, sama seperti SHORT Scanner). **Reversal Radar dihapus** dari website (halaman & API `/api/reversal/*`) dan worker pada 2026-11-15 atas keputusan pengguna: mesin SA/PVA lebih sesuai (contoh UNIUSDT, AAVEUSDT, ZECUSDT, HYPEUSDT). Riwayat kandidat radar tetap di database (tabel `reversal_*`); mesinnya tetap tersedia untuk riset lewat `npm run reversal:replay`.
- **API:** `GET /api/signals/active?direction=SHORT` (tanpa `direction` = LONG, seperti sebelumnya); `GET /api/signals/history?direction=LONG|SHORT` (tanpa `direction` = kedua arah). Setiap item memuat field `direction`. `GET /api/overview` menambah `activeByDirection`, `earlyByDirection`, dan `alignedByDirection`; field lama (`activeSignals`, `earlySignals`, `alignedSignals`) tetap menghitung LONG.
- **Upgrade database:** jalankan `npm run migrate` (server dan worker juga menerapkannya otomatis saat start). Migrasi `005` menambah kolom `signals.direction`; semua sinyal lama menjadi LONG. Setelah upgrade, pemindaian SHORT dimulai dari candle terbaru (tanpa replay histori).

Kontrak lengkap: [docs/07-kontrak-modul.md](docs/07-kontrak-modul.md) §6–§9.

## Insider / Smart Money Radar (baca saja)

- Menu **Smart Money** (Radar, Wallet Discovery, Watchlist & Alerts) menunjukkan token yang sedang dibeli **lewat swap** oleh beberapa wallet on-chain berkualitas yang saling independen, dengan bukti tx, flag risiko, dan tautan ke LONG Scanner (chip **SM ×N**) bila kontraknya cocok persis dengan pasar Binance. Hanya alamat publik — tidak pernah meminta seed phrase/private key; skor bukan probabilitas. Data live gratis aktif otomatis setelah `ETHERSCAN_API_KEY` dan kunci Binance **read-only** diisi di `.env`. Panduan lengkap: [docs/17](docs/17-panduan-smart-money.md). Perintah: `npm run smart-money:check` (cek koneksi & izin kunci), `npm run smart-money:sync` (sinkron sekali; `-- --loop` berulang), `npm run smart-money:evaluate` (evaluasi historis tanpa look-ahead).

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | Menjalankan server (memuat `.env` bila ada), langsung menjalankan scanner (`WORKER_AUTOSTART`), dan membuka browser (`OPEN_BROWSER`) |
| `npm run dev` | Server dengan auto-reload |
| `npm run worker` | Worker scanner di terminal terpisah (alternatif tombol website; jangan dijalankan bersamaan) |
| `npm run migrate` | Menerapkan migrasi database (termasuk `005` arah sinyal Short Scanner) |
| `npm run user:create -- --username <u> --role admin\|analyst` | Membuat pengguna |
| `npm run user:password -- --username <u>` | Mengganti kata sandi pengguna (prompt tersembunyi) dan mencabut semua sesinya |
| `npm run backtest -- --top 30 --timeframes 15m,1h --from 2024-01-01` | Backtest walk-forward sebelum (v2) vs sesudah (v3); laporan di `reports/` ([docs/13](docs/13-panduan-akurasi-v3.md)). Biaya bawaan fee 5 + slippage 2 bps per sisi (taker Binance Futures VIP 0); ubah dengan `--fee-bps` / `--slippage-bps` |
| `npm run backtest -- --top 30 --timeframes 15m,1h --from 2024-01-01 --ml` | Sama, plus lab meta-labeling ML (bagian "Lab meta-labeling" di laporan; [docs/16](docs/16-riset-machine-learning.md)) |
| `npm run reversal:replay -- --synthetic --seeds 21-60` / `-- --top 20 --timeframes 5m,15m,1h --from 2025-06-01` | Alat riset saja (Reversal Radar sudah dihapus dari website & worker): replay berurutan Reversal Radar (tanpa look-ahead) pada skenario sintetis atau data Binance nyata, pembanding mesin lama SA/PVA, laporan di `reports/` ([docs/21](docs/21-validasi-reversal-radar.md)); `--params '{"minEarlyGroups":1}'` meng-override parameter mesin untuk penyetelan (hanya pada `--seeds 1-20 --tuning`) |
| `npm run research:bsv -- --window explore` / `-- --window oos` | Riset formulasi LONG 1h BSV-1h: paritas eksplorasi atau uji luar sampel terpraregistrasi (studi kejadian + funding historis), laporan di `reports/research/` ([docs/23](docs/23-riset-formulasi-candle-short15m-long1h.md)). Hasil 2026-11-15: tidak lulus, tidak dipakai scanner |
| `npm run research:timing` / `-- --symbols UNIUSDT,ZECUSDT` | Riset timing sinyal live (LONG 1h SA/PVA, SHORT 15m SD/PVD): alert muncul sebelum, saat, atau sesudah breakout, gerak harga sebelum alert, dan hasil trade per kelompok; data dari cache backtest, laporan di `reports/research/` ([docs/24](docs/24-backtest-31-koin-dan-timing-sinyal.md)) |
| `npm run research:matched` / `-- --symbols UNIUSDT,ZECUSDT` | Riset "informasi di luar momentum": alert pola live vs candle tanpa sinyal yang dicocokkan (simbol, kuartal, gerak awal, posisi rentang, volatilitas), CI moving-block bootstrap 7/14 hari, kohort simbol, sensitivitas Donchian 24/96, persiapan ukuran sampel praregistrasi; laporan di `reports/research/` ([docs/25](docs/25-informasi-di-luar-momentum.md)) |
| `npm run research:matched-exclusion` / `-- --jobs 1` | Sensitivitas pasca-run docs/25: hasil pembanding dicocokkan dengan tiga jendela pengecualian pembanding (desain terkunci ±12 candle vs dua varian kausal yang hanya memakai masa lalu), 4 proses paralel; laporan di `reports/research/` ([docs/25 §2](docs/25-informasi-di-luar-momentum.md)) |
| `npm run research:al-sa-atr-01 -- --mode count --to YYYY-MM-DD` / `--mode evaluate` | Praregistrasi AL-SA-ATR-01 (LONG 1h, gerak awal ≥ 2,7 ATR) pada data sesudah 2026-11-16: `count` hanya menghitung trade (tanpa hasil R), `evaluate` menjalankan uji keputusan sekali saja pada commit beku; laporan di `reports/research/` ([docs/26](docs/26-praregistrasi-al-sa-atr-01.md)) |
| `npm run research:al-sa-atr-01-audit -- --to YYYY-MM-01 --count-report <JSON count>` | Audit data bulanan AL-SA-ATR-01 (adendum docs/26 §10–§11), dijalankan dari `main` yang bersih sesudah `--mode count` di checkout beku: memuat kline, funding, dan bulan kohort ke cache; status setiap simbol-bulan (termasuk delisting terverifikasi dari candle datar); paritas jumlah trade dengan count; versi/hash skrip; log append-only di `research-log/al-sa-atr-01/`. Tanpa R |
| `npm run research:mom-power` | Bahan desain AL-MOM-01 (SA/PVA vs momentum murni): selisih alert vs pembanding strata untuk gerak 12 candle (A) dan trade dengan stop 1,5 ATR identik (B), lalu daya uji per lama jendela; data cache historis, laporan di `reports/research/` ([docs/27](docs/27-bahan-desain-al-mom-01.md)). Angka 31 koin docs/27 diulang dengan `--symbols` daftar 31 koin itu |
| `npm run research:mom-sim` | Simulasi daya AL-MOM-01 di 100 koin semesta AL-SA-ATR-01 (docs/27 §7): SE langsung per jendela 12/24 bulan, efek desain lintas simbol, kovariat jarak alert, jangkar biaya, daya uji batas atas satu/dua sisi. `--save-acc`/`--load-acc` menyimpan agregat supaya analisis bisa diulang tanpa replay |
| `npm run lint` | ESLint |
| `npm test` | Seluruh tes Vitest |
| `npm run test:e2e` | Tes Playwright (desktop & mobile) |
| `npm run test:live` | Uji integrasi live Binance (opt-in, butuh jaringan ke `fapi.binance.com` dan `fstream.binance.com/market`; tidak termasuk `npm test`) |
| `npm run audit` | npm audit dependensi produksi |
| `npm run report:tests` | Menyusun laporan tes dari hasil eksekusi nyata |

## Struktur

```
backend/
  app/          konfigurasi, perakitan Fastify, entry point server
  api/          route HTTP (tipis — memanggil service)
  auth/         hashing Argon2id, sesi, layanan login, plugin autentikasi
  security/     header keamanan, CSP, guard Origin/CSRF
  settings/     skema & aturan pengaturan scanner
  users/        administrasi pengguna (CLI) & akun default prototipe lokal
  database/     koneksi, runner migrasi, migrations/, repositories/
  ingestion/    klien REST/WebSocket Binance (DNS-over-HTTPS khusus host Binance), validasi candle, discovery, backfill
  indicators/   EMA, ATR, RVOL, swing (fungsi murni)
  research/     formulasi & studi riset (BSV-1h, timing sinyal, pembanding dicocokkan, praregistrasi AL-SA-ATR-01);
                tidak dipakai worker/scanner live (docs/23–27)
  patterns/     detektor SA & PVA (LONG) serta SD & PVD (SHORT, cermin SA/PVA) berversi
  timeframe/    trend & alignment multi-timeframe
  scoring/      skor, risk flag, penjelasan
  signals/      state machine sinyal (LONG & SHORT) & repositori
  analysis/     pipeline analisis (live & backtest)
  ml/           lab meta-labeling: fitur entri, regresi logistik, gradient boosting, evaluasi walk-forward
  system/       status worker, supervisor worker (tombol scanner), konteks pasar
worker/         proses scanner terpisah (dijalankan server lewat tombol, atau npm run worker)
frontend/
  index.html, login.html, landing.html (halaman awal publik di "/" tanpa sesi)
  css/          tokens.css (design tokens "Konsol Grafit"), base, layout, components, login, landing
  fonts/        Atkinson Hyperlegible Next & Mono (self-hosted, SIL OFL 1.1)
  js/lib/       dom (render aman XSS), api, router, format, komponen UI
  js/views/     satu modul per layar
  assets/       logo & sprite ikon SVG
scripts/        migrate, create-user, change-password, laporan tes
tests/          unit, positive, negative, edge, security, integration, e2e, live, helpers
docs/           dokumentasi (Bahasa Indonesia)
config/         contoh environment
```

## Dokumentasi

- [00 — Audit repositori](docs/00-audit-repositori.md)
- [01 — Arsitektur](docs/01-arsitektur.md)
- [02 — Model ancaman & kontrol keamanan](docs/02-model-ancaman.md)
- [03 — Rencana implementasi](docs/03-rencana-implementasi.md)
- [04 — Design system](docs/04-design-system.md)
- [05 — Database](docs/05-database.md)
- [06 — Evaluasi dependensi](docs/06-evaluasi-dependensi.md)
- [07 — Kontrak antarmodul](docs/07-kontrak-modul.md)
- [08 — Grafik simbol & side panel tabel](docs/08-grafik-simbol.md)
- [09 — Proses sync scanner](docs/09-proses-sync.md)
- [Architecture Decision Records](docs/adr/)
- [Laporan pengujian Milestone 1](docs/laporan/milestone-1-pengujian.md)
- [Laporan pengujian Milestone 2–3](docs/laporan/milestone-2-3-pengujian.md)
