# 03 — Rencana Implementasi

## Milestone 1 — Fondasi (selesai, di `main`)

### Cakupan

| Item | Status | Lokasi |
|---|---|---|
| Audit repositori | Selesai | `docs/00-audit-repositori.md` |
| Dokumen arsitektur + ADR | Selesai | `docs/01-arsitektur.md`, `docs/adr/` |
| Model ancaman | Selesai | `docs/02-model-ancaman.md` |
| Skema database (13 entitas) + migrasi berchecksum | Selesai | `backend/database/` |
| Autentikasi (Argon2id, sesi, CSRF, rate limit, penguncian, audit) | Selesai | `backend/auth/`, `backend/security/` |
| API: auth, sesi, pengaturan scanner berversi, overview, status sistem, health/ready | Selesai | `backend/api/` |
| Design system (token, komponen) | Selesai | `frontend/css/`, `docs/04-design-system.md` |
| Shell frontend 9 layar (Overview, Screener, Symbol, Signal History, Lab, Backtest, Settings, Health, Design System) | Selesai sebagai kerangka; data nyata menyusul | `frontend/` |
| Tes positif/negatif/edge/keamanan/E2E | 181 Vitest + 18 Playwright lulus | `tests/`, `docs/laporan/` |
| TOTP MFA opsional | **Ditunda ke M7** | Kolom `totp_secret` sudah ada |
| Docker | **Ditunda ke M8** | Daemon Docker tidak tersedia di lingkungan build |

### Definition of Done — status M1

| Kriteria | Status |
|---|---|
| Implementasi ada | Ya |
| Perilaku terdokumentasi | Ya (docs 00–06, ADR) |
| Tes otomatis relevan lulus | Ya — `docs/laporan/hasil-tes-otomatis.md` |
| Jalur kegagalan diuji | Ya — 110 tes negatif |
| Implikasi keamanan direview | Ya — model ancaman |
| Tidak ada regresi kritis | Ya (greenfield) |
| Bukti eksekusi | Ya — laporan dihasilkan dari file hasil eksekusi |

## Milestone 2 — Data pasar (selesai, di `main`)

| Item | Status | Lokasi |
|---|---|---|
| Klien REST Binance USDT-M (allowlist host, timeout, pembatas bobot `X-MBX-USED-WEIGHT-1M`, backoff 429/418, `Retry-After`) | Selesai | `backend/ingestion/binance/restClient.js` |
| Discovery simbol (PERPETUAL + USDT + TRADING, pre-filter likuiditas & spread, mode auto/manual) | Selesai | `backend/ingestion/symbolDiscovery.js` |
| Validasi candle, normalisasi batch, deteksi gap, upsert idempoten pada PK kanonik | Selesai | `backend/ingestion/candleValidator.js`, `backend/database/repositories/candleRepository.js` |
| WebSocket kline (hanya `x=true` ke tabel kanonik, candle berjalan ke `provisional_candles`), reconnect + jitter, rotasi koneksi, deteksi stale | Selesai | `backend/ingestion/binance/wsClient.js` |
| Backfill REST setelah reconnect/gap, duplikat & out-of-order | Selesai | `backend/ingestion/backfill.js`, `worker/scanner.js` |
| Proses `worker/` terpisah (`npm run worker`), heartbeat + metrik ke System Health | Selesai | `worker/`, `backend/system/workerStatus.js` |
| Tes fixture sintetis deterministik + uji live opt-in (`npm run test:live`) | Selesai; **REST + WebSocket live terverifikasi** di mesin pemilik (2026-10-25, 6/6 setelah perbaikan rute `/market`) (lihat `docs/laporan/milestone-2-3-pengujian.md` §6.1) | `tests/unit/ingestion/`, `tests/live/` |

## Milestone 3 — Mesin pola (selesai, di `main`)

| Item | Status | Lokasi |
|---|---|---|
| Indikator murni (EMA, ATR, RVOL, swing terkonfirmasi tanpa lookahead) | Selesai | `backend/indicators/` |
| Detektor Silent Accumulation & Progressive Volume Accumulation, parameter konfigurabel tervalidasi, klasifikasi SA/PVA/BOTH/NONE | Selesai | `backend/patterns/` |
| Engine timeframe hibrida (trend BULLISH/NEUTRAL/BEARISH, alignment 4 tingkat, hanya HTF tertutup, HTF tidak membuang pola dasar) | Selesai | `backend/timeframe/` |
| Pattern Score, Early Score, 6 risk flag, penjelasan per faktor | Selesai | `backend/scoring/` |
| State machine 7 state, transisi & event dipersistensi, tanpa alert berulang | Selesai | `backend/signals/` |
| Pipeline analisis (`analyzeAt` murni, dipakai bersama live & backtest M6) terhubung ke worker; kursor analisis persisten (migrasi `004`: `analysis_cursors` + indeks riwayat sinyal) agar restart tidak me-replay | Selesai | `backend/analysis/pipeline.js`, `worker/assemble.js`, `backend/database/migrations/004_analysis_state.sql` |
| API sinyal + Screener & Signal History memakai data nyata; Overview/Health memakai heartbeat worker | Selesai | `backend/api/signalRoutes.js`, `frontend/js/views/` |
| Validasi out-of-sample efektivitas pola | **Belum** — butuh data historis nyata & backtest (M6). Tidak ada klaim profitabilitas | — |

Laporan pengujian: `docs/laporan/milestone-2-3-pengujian.md`.

## Milestone 4–8

Mengikuti roadmap spesifikasi. Prioritas teknis yang sudah diputuskan:

- **M4:** Lightweight Charts dipasang sebagai file vendor lokal (bukan CDN) agar CSP tetap `'self'`; update real-time via WebSocket terautentikasi.
- **M5:** definisi pola JSON berversi divalidasi JSON Schema; evaluator deklaratif tanpa eksekusi kode.
- **M6:** pemisahan train/validasi/out-of-sample berbasis waktu; fee, spread, slippage, funding; walk-forward.
- **M7:** Gitleaks, Trivy, Semgrep registry, OWASP ZAP baseline + active scan di staging terisolasi; TOTP.
- **M8:** Docker Compose non-root, read-only filesystem, reverse proxy HTTPS, backup SQLite (`.backup`) + uji restore.

## Keputusan yang membutuhkan persetujuan pemilik

| Topik | Usulan default |
|---|---|
| Peran pengguna kedua | `analyst` (baca saja untuk pengaturan) atau `admin` — dapat dipilih saat `user:create`. |
| Bahasa UI | Bahasa Indonesia dengan istilah trading standar dalam bahasa Inggris (Screener, Breakout, dll.). |
| Lanjut ke Milestone 4 | Prasyarat uji live sudah terpenuhi (2026-10-25); menunggu keputusan pemilik untuk mulai M4. |
| Migrasi `005` kolom tracking sinyal | Usulan di `docs/05-database.md` §6 (nomor `004` sudah dipakai kursor analisis); dibuat sebelum M6. |
