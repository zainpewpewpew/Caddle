# AlphaLens

Terminal intelijen kripto privat untuk **riset dan pendukung keputusan** — mendeteksi struktur bullish lebih awal pada USDT-M perpetual Binance, dengan sinyal yang dapat dijelaskan. Aplikasi ini **bukan** sistem trading otomatis dan tidak mengeksekusi order.

> Skor pola bukan probabilitas profit yang terkalibrasi. Jangan menganggap strategi apa pun menguntungkan tanpa bukti out-of-sample yang andal.

## Status

| Milestone | Cakupan | Status |
|---|---|---|
| 1 — Fondasi | Audit, arsitektur, autentikasi, shell frontend, API, migrasi | **Selesai (di `main`)** |
| 2 — Data pasar | Binance REST/WS, candle historis, validasi, worker | **Selesai (di `main`; REST + WebSocket live terverifikasi di Mac pemilik, lihat laporan)** |
| 3 — Mesin pola | SA, PVA, hybrid timeframe, skor, state machine | **Selesai (di `main`)** |
| 4 — Dashboard premium | Screener, grafik, real-time | Belum dimulai |
| 5 — Pattern Discovery Lab | Upload, anotasi, definisi pola berversi | Belum dimulai |
| 6 — Backtesting | Replay historis, metrik, out-of-sample | Belum dimulai |
| 7 — Keamanan & QA | Pengujian lengkap, pemindaian, pentest | Berjalan terus sejak M1 |
| 8 — Deployment privat | Docker, HTTPS, backup, monitoring | Belum dimulai |

Detail: [docs/03-rencana-implementasi.md](docs/03-rencana-implementasi.md).

## Teknologi

- **Frontend:** HTML5, CSS3, Vanilla JavaScript (ES Modules), tanpa framework dan tanpa bundler. TradingView Lightweight Charts direncanakan di Milestone 4.
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

1. **Dari website (disarankan):** System Health → kartu **Kontrol scanner** → **Jalankan scanner** / **Hentikan scanner** (dengan konfirmasi). Bila scanner belum berjalan, Overview juga menampilkan callout dengan tombol **Jalankan scanner**. Hanya **admin** yang dapat menjalankan atau menghentikan; analyst hanya melihat statusnya.
   - Status: *Berjalan*, *Berhenti*, *Memulai…*, *Menghentikan…*, *Gagal (kode keluar N)*, atau *Berjalan di luar website*.
   - Menghentikan scanner mengirim SIGTERM (worker menyelesaikan tugas aktif dan menulis heartbeat akhir); bila belum berhenti dalam 15 detik, worker dihentikan paksa (SIGKILL).
   - Menutup server (Ctrl+C / SIGTERM) menghentikan worker lebih dulu. Bila server mati mendadak, worker berhenti sendiri saat koneksi IPC ke server terputus.
   - Worker yang crash **tidak** dijalankan ulang otomatis: status menjadi *Gagal (kode keluar N)*. Periksa log di terminal `npm start`, lalu tekan **Jalankan scanner** lagi.
   - Setiap start/stop (berhasil maupun ditolak) tercatat di log audit (`worker.start` / `worker.stop`).
2. **Terminal terpisah:** `npm run worker` tetap tersedia (mis. bila kontrol website dinonaktifkan). Jangan jalankan bersamaan dengan worker dari website: dua worker pada satu database menggandakan ingesti. Selama worker dari terminal masih mengirim heartbeat (< 90 detik), tombol menolak menjalankan worker kedua dan status tampil *Berjalan di luar website*. Hentikan worker itu dari terminalnya (Ctrl+C).

| Variabel | Default | Fungsi |
|---|---|---|
| `WORKER_CONTROL` | aktif bila `NODE_ENV=development`; nonaktif di `test` & `production` | `true`/`false`: menampilkan & mengizinkan tombol scanner di website. Saat nonaktif, API start/stop menjawab 503 dan System Health menyarankan `npm run worker`. |
| `WORKER_AUTOSTART` | `false` | `true`: server langsung menjalankan worker saat start (butuh `WORKER_CONTROL` aktif; tercatat di audit). Dibatalkan bila worker di luar website sedang berjalan. |

Nilai selain `true`/`false` membuat server menolak start (fail fast).

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | Menjalankan server (memuat `.env` bila ada); scanner dijalankan dari tombol di System Health |
| `npm run dev` | Server dengan auto-reload |
| `npm run worker` | Worker scanner di terminal terpisah (alternatif tombol website; jangan dijalankan bersamaan) |
| `npm run migrate` | Menerapkan migrasi database |
| `npm run user:create -- --username <u> --role admin\|analyst` | Membuat pengguna |
| `npm run user:password -- --username <u>` | Mengganti kata sandi pengguna (prompt tersembunyi) dan mencabut semua sesinya |
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
  patterns/     detektor SA & PVA berversi
  timeframe/    trend & alignment multi-timeframe
  scoring/      skor, risk flag, penjelasan
  signals/      state machine sinyal & repositori
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
- [Architecture Decision Records](docs/adr/)
- [Laporan pengujian Milestone 1](docs/laporan/milestone-1-pengujian.md)
- [Laporan pengujian Milestone 2–3](docs/laporan/milestone-2-3-pengujian.md)
