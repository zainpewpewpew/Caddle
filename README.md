# AlphaLens

Terminal intelijen kripto privat untuk **riset dan pendukung keputusan** — mendeteksi struktur bullish lebih awal pada USDT-M perpetual Binance, dengan sinyal yang dapat dijelaskan. Aplikasi ini **bukan** sistem trading otomatis dan tidak mengeksekusi order.

> Skor pola bukan probabilitas profit yang terkalibrasi. Jangan menganggap strategi apa pun menguntungkan tanpa bukti out-of-sample yang andal.

## Status

| Milestone | Cakupan | Status |
|---|---|---|
| 1 — Fondasi | Audit, arsitektur, autentikasi, shell frontend, API, migrasi | **Selesai (di `main`)** |
| 2 — Data pasar | Binance REST/WS, candle historis, validasi, worker | **Selesai (di `main`; REST live terverifikasi, WebSocket live menunggu uji ulang, lihat laporan)** |
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
npm run user:create -- --username mary --role admin   # kata sandi diminta secara tersembunyi
npm start                            # http://127.0.0.1:8080
npm run worker                       # terminal terpisah: scanner & analisis pola
```

Pendaftaran publik sengaja tidak ada. Maksimal dua pengguna (`MAX_USERS=2`) dibuat lewat CLI di server. Kata sandi minimal 12 karakter.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | Menjalankan server (memuat `.env` bila ada) |
| `npm run dev` | Server dengan auto-reload |
| `npm run worker` | Worker scanner: discovery simbol, candle REST/WebSocket, analisis pola |
| `npm run migrate` | Menerapkan migrasi database |
| `npm run user:create -- --username <u> --role admin\|analyst` | Membuat pengguna |
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
  users/        administrasi pengguna (CLI)
  database/     koneksi, runner migrasi, migrations/, repositories/
  ingestion/    klien REST/WebSocket Binance, validasi candle, discovery, backfill
  indicators/   EMA, ATR, RVOL, swing (fungsi murni)
  patterns/     detektor SA & PVA berversi
  timeframe/    trend & alignment multi-timeframe
  scoring/      skor, risk flag, penjelasan
  signals/      state machine sinyal & repositori
  analysis/     pipeline analisis (live & backtest)
  system/       status worker, konteks pasar
worker/         proses scanner terpisah (npm run worker)
frontend/
  index.html, login.html
  css/          tokens.css (design tokens), base, layout, components, login
  js/lib/       dom (render aman XSS), api, router, format, komponen UI
  js/views/     satu modul per layar
  assets/       logo & sprite ikon SVG
scripts/        migrate, create-user, laporan tes
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
