# ADR-0004 — Strategi CSRF berlapis

- Status: Diterima (Milestone 1)

## Keputusan
1. Cookie `SameSite=Strict`.
2. Untuk metode POST/PUT/PATCH/DELETE: header `Origin` (bila ada) wajib sama dengan `APP_ORIGIN`; `Sec-Fetch-Site: cross-site` ditolak.
3. Route terautentikasi wajib header `X-CSRF-Token` yang cocok (perbandingan konstan-waktu) dengan token sesi. Token dikirim saat login / `GET /api/auth/session` dan disimpan di memori JS.
4. Hanya `application/json` yang diterima; parser `text/plain` dihapus sehingga form HTML lintas situs dan "simple request" ditolak 415.

## Alasan
Lapisan 1–2 menahan serangan dari browser modern; lapisan 3 tetap melindungi bila salah satu lapisan lain gagal (mis. browser lama, proxy yang membuang header). Login dilindungi lapisan 1, 2, dan 4 karena token CSRF belum ada sebelum login.
