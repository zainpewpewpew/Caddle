# 03 — Rencana Implementasi

## Milestone 1 — Fondasi (PR ini)

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

## Milestone 2 — Data pasar (berikutnya, menunggu persetujuan)

1. Klien REST Binance USDT-M (`/fapi/v1/exchangeInfo`, `/fapi/v1/klines`, `/fapi/v1/ticker/24hr`) dengan allowlist host, timeout, dan pembatas bobot request (header `X-MBX-USED-WEIGHT-1M`), backoff pada 429/418.
2. Discovery simbol: filter `contractType=PERPETUAL`, `quoteAsset=USDT`, `status=TRADING`, lalu pre-filter likuiditas dari pengaturan.
3. Bootstrap candle historis per simbol×timeframe; validasi (OHLC konsisten, `close_time`, kontinuitas), deteksi gap, upsert idempoten pada PK kanonik.
4. WebSocket kline: hanya `x=true` (candle tertutup) yang masuk tabel kanonik; candle berjalan disimpan terpisah sebagai provisional.
5. Reconnect dengan jitter, backfill REST untuk gap setelah reconnect, penanganan event tidak berurutan & duplikat.
6. Proses `worker/` terpisah dengan metrik (durasi scan, lag candle, error API) yang mengisi layar System Health.
7. Tes dengan fixture respons Binance yang direkam (deterministik) + satu uji integrasi live terbatas yang ditandai jelas dan tidak dijalankan di CI default.

## Milestone 3–8

Mengikuti roadmap spesifikasi. Prioritas teknis yang sudah diputuskan:

- **M3:** indikator & detektor sebagai fungsi murni; resolver timeframe hanya memakai candle HTF dengan `close_time <= t_evaluasi`; state machine dengan transisi yang dipersistensi ke `signal_events`; skor disertai `explanation_json`.
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
| Lanjut ke Milestone 2 | Setelah PR M1 direview. |
