# Long Radar

Terminal intelijen kripto privat untuk **riset dan pendukung keputusan** — mendeteksi struktur bullish lebih awal pada USDT-M perpetual Binance, dengan sinyal yang dapat dijelaskan. Aplikasi ini **bukan** sistem trading otomatis dan tidak mengeksekusi order.

> Skor pola bukan probabilitas profit yang terkalibrasi. Jangan menganggap strategi apa pun menguntungkan tanpa bukti out-of-sample yang andal.

## Status

| Milestone | Cakupan | Status |
|---|---|---|
| 1 — Fondasi | Audit, arsitektur, autentikasi, shell frontend, API, migrasi | **Selesai (menunggu review PR)** |
| 2 — Data pasar | Binance REST/WS, candle historis, validasi, worker | Belum dimulai |
| 3 — Mesin pola | SA, PVA, hybrid timeframe, skor, state machine | Belum dimulai |
| 4 — Dashboard premium | Screener, grafik, real-time | Belum dimulai |
| 5 — Pattern Discovery Lab | Upload, anotasi, definisi pola berversi | Belum dimulai |
| 6 — Backtesting | Replay historis, metrik, out-of-sample | Belum dimulai |
| 7 — Keamanan & QA | Pengujian lengkap, pemindaian, pentest | Berjalan terus sejak M1 |
| 8 — Deployment privat | Docker, HTTPS, backup, monitoring | Belum dimulai |

Detail: [docs/03-rencana-implementasi.md](docs/03-rencana-implementasi.md).

## Teknologi

- **Frontend:** HTML5, CSS3, Vanilla JavaScript (ES Modules), tanpa framework dan tanpa bundler. TradingView Lightweight Charts direncanakan di Milestone 4.
- **Backend:** Node.js 22 LTS, Fastify 5, JSON Schema validation, arsitektur modular monolith.
- **Database:** SQLite (better-sqlite3) dengan migrasi berversi dan lapisan repositori — disiapkan untuk migrasi ke PostgreSQL.
- **Pengujian:** Vitest (unit/integrasi), Playwright (E2E), ESLint, npm audit, Semgrep.

## Menjalankan secara lokal

Prasyarat: Node.js 22.12+ (LTS).

```bash
npm ci
cp config/.env.example .env          # sesuaikan bila perlu
npm run migrate                      # membuat/memperbarui skema database
npm run user:create -- --username mary --role admin   # kata sandi diminta secara tersembunyi
npm start                            # http://127.0.0.1:8080
```

Pendaftaran publik sengaja tidak ada. Maksimal dua pengguna (`MAX_USERS=2`) dibuat lewat CLI di server. Kata sandi minimal 12 karakter.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | Menjalankan server (memuat `.env` bila ada) |
| `npm run dev` | Server dengan auto-reload |
| `npm run migrate` | Menerapkan migrasi database |
| `npm run user:create -- --username <u> --role admin\|analyst` | Membuat pengguna |
| `npm run lint` | ESLint |
| `npm test` | Seluruh tes Vitest |
| `npm run test:e2e` | Tes Playwright (desktop & mobile) |
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
frontend/
  index.html, login.html
  css/          tokens.css (design tokens), base, layout, components, login
  js/lib/       dom (render aman XSS), api, router, format, komponen UI
  js/views/     satu modul per layar
  assets/       logo & sprite ikon SVG
scripts/        migrate, create-user, laporan tes
tests/          unit, positive, negative, edge, security, e2e, helpers
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
- [Architecture Decision Records](docs/adr/)
- [Laporan pengujian Milestone 1](docs/laporan/milestone-1-pengujian.md)
