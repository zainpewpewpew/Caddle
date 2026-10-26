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
npm start                            # http://127.0.0.1:8080
```

> **Setelah `git pull`:** jalankan `npm ci` lagi bila `package.json`/`package-lock.json` berubah (mis. library grafik `lightweight-charts`). Server tetap start tanpa paket itu, tetapi grafik koin tidak tersedia dan log startup memperingatkan.

Cukup **satu terminal**: login sebagai admin, buka **System Health**, lalu tekan **Jalankan scanner**. Server menjalankan worker scanner (discovery simbol, candle REST/WebSocket, analisis pola) sebagai proses terpisah, dan log worker tampil di terminal `npm start` yang sama. Lihat [Scanner (worker)](#scanner-worker).

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
   - Worker yang crash **tidak** dijalankan ulang otomatis: status menjadi *Gagal (kode keluar N)*. Sesaat setelah start, System Health dan kontrol scanner ringkas terus memantau selama ±10 detik, jadi worker yang langsung crash tampil sebagai *Gagal* dalam beberapa detik. Periksa log di terminal `npm start`, lalu tekan **Jalankan scanner** lagi.
   - **Jeda start ulang 10 detik:** setelah worker berhenti atau crash, start berikutnya baru diterima 10 detik kemudian (sebelumnya: pesan "Scanner baru saja berhenti. Tunggu beberapa detik lalu coba lagi.", HTTP 429). Setiap proses worker baru memulai pembatas bobot dan status blokir Binance (418/429) dari nol, jadi restart beruntun tidak boleh membanjiri Binance. Tombol start/stop juga dibatasi 10 permintaan per menit.
   - **Audit:** setiap permintaan start/stop dari pengguna yang sudah login tercatat di log audit (`worker.start` / `worker.stop`): berhasil, ditolak supervisor (mis. sudah berjalan, jeda), ditolak karena bukan admin atau token CSRF tidak valid (403), maupun error internal (500). Permintaan yang ditolak sebelum sesi dikenali (tanpa login 401, Origin lintas situs, atau rate limit 429) tidak tercatat karena tidak ada pengguna yang dapat dicatat.
2. **Terminal terpisah:** `npm run worker` tetap tersedia (mis. bila kontrol website dinonaktifkan). Jangan jalankan bersamaan dengan worker dari website: dua worker pada satu database menggandakan ingesti. Selama worker dari terminal masih mengirim heartbeat (< 90 detik), tombol menolak menjalankan worker kedua dan status tampil *Berjalan di luar website*. Hentikan worker itu dari terminalnya (Ctrl+C). Heartbeat memuat pid worker penulisnya: bila proses itu sudah tidak ada di komputer yang sama (mis. dibunuh paksa sebelum sempat menulis heartbeat akhir), heartbeatnya tidak lagi memblokir tombol maupun `WORKER_AUTOSTART`.

| Variabel | Default | Fungsi |
|---|---|---|
| `WORKER_CONTROL` | aktif bila `NODE_ENV=development`; nonaktif di `test` & `production` | `true`/`false`: menampilkan & mengizinkan tombol scanner di website. Saat nonaktif, API start/stop menjawab 503 dan System Health menyarankan `npm run worker`. |
| `WORKER_AUTOSTART` | `false` | `true`: server langsung menjalankan worker saat start (butuh `WORKER_CONTROL` aktif; tercatat di audit). Dibatalkan bila worker di luar website sedang berjalan. |

Nilai selain `true`/`false` membuat server menolak start (fail fast).

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
- **API:** `GET /api/signals/active?direction=SHORT` (tanpa `direction` = LONG, seperti sebelumnya); `GET /api/signals/history?direction=LONG|SHORT` (tanpa `direction` = kedua arah). Setiap item memuat field `direction`. `GET /api/overview` menambah `activeByDirection`, `earlyByDirection`, dan `alignedByDirection`; field lama (`activeSignals`, `earlySignals`, `alignedSignals`) tetap menghitung LONG.
- **Upgrade database:** jalankan `npm run migrate` (server dan worker juga menerapkannya otomatis saat start). Migrasi `005` menambah kolom `signals.direction`; semua sinyal lama menjadi LONG. Setelah upgrade, pemindaian SHORT dimulai dari candle terbaru (tanpa replay histori).

Kontrak lengkap: [docs/07-kontrak-modul.md](docs/07-kontrak-modul.md) §6–§9.

## Insider / Smart Money Radar (baca saja)

- Menu **Smart Money** (Radar, Wallet Discovery, Watchlist & Alerts) menunjukkan token yang sedang dibeli **lewat swap** oleh beberapa wallet on-chain berkualitas yang saling independen, dengan bukti tx, flag risiko, dan tautan ke LONG Scanner (chip **SM ×N**) bila kontraknya cocok persis dengan pasar Binance. Hanya alamat publik — tidak pernah meminta seed phrase/private key; skor bukan probabilitas. Data live gratis aktif otomatis setelah `ETHERSCAN_API_KEY` dan kunci Binance **read-only** diisi di `.env`. Panduan lengkap: [docs/16](docs/16-panduan-smart-money.md). Perintah: `npm run smart-money:check` (cek koneksi & izin kunci), `npm run smart-money:sync` (sinkron sekali; `-- --loop` berulang), `npm run smart-money:evaluate` (evaluasi historis tanpa look-ahead).

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | Menjalankan server (memuat `.env` bila ada); scanner dijalankan dari tombol di System Health |
| `npm run dev` | Server dengan auto-reload |
| `npm run worker` | Worker scanner di terminal terpisah (alternatif tombol website; jangan dijalankan bersamaan) |
| `npm run migrate` | Menerapkan migrasi database (termasuk `005` arah sinyal Short Scanner) |
| `npm run user:create -- --username <u> --role admin\|analyst` | Membuat pengguna |
| `npm run user:password -- --username <u>` | Mengganti kata sandi pengguna (prompt tersembunyi) dan mencabut semua sesinya |
| `npm run backtest -- --top 30 --timeframes 15m,1h --from 2024-01-01` | Backtest walk-forward sebelum (v2) vs sesudah (v3); laporan di `reports/` ([docs/13](docs/13-panduan-akurasi-v3.md)) |
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
  ingestion/    klien REST/WebSocket Binance, validasi candle, discovery, backfill
  indicators/   EMA, ATR, RVOL, swing (fungsi murni)
  patterns/     detektor SA & PVA (LONG) serta SD & PVD (SHORT, cermin SA/PVA) berversi
  timeframe/    trend & alignment multi-timeframe
  scoring/      skor, risk flag, penjelasan
  signals/      state machine sinyal (LONG & SHORT) & repositori
  analysis/     pipeline analisis (live & backtest)
  system/       status worker, supervisor worker (tombol scanner), konteks pasar
worker/         proses scanner terpisah (dijalankan server lewat tombol, atau npm run worker)
frontend/
  index.html, login.html
  css/          tokens.css (design tokens), base, layout, components, login
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
