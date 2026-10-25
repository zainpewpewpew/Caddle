# 06 — Evaluasi Dependensi

Prinsip: dependensi sesedikit mungkin, terpelihara, berlisensi permisif, dipin versi eksak (`--save-exact`) dengan `package-lock.json`. Data di bawah diambil dari registry npm pada 2026-10-25 (`npm view`, `npm audit`). Status repositori GitHub tidak dapat diperiksa langsung karena github.com diblokir di lingkungan build.

## Runtime (88 paket transitif)

| Paket | Versi | Lisensi | Alasan | Catatan pemeliharaan & keamanan |
|---|---|---|---|---|
| fastify | 5.12.7 | MIT | Framework HTTP (disyaratkan spesifikasi) | Organisasi Fastify, 5 maintainer npm, rilis Okt 2026. Parser JSON aman prototype-poisoning bawaan. |
| @fastify/cookie | 11.1.3 | MIT | Parsing/penulisan cookie sesi | Plugin resmi Fastify. |
| @fastify/helmet | 13.2.0 | MIT | CSP & header keamanan | Plugin resmi, membungkus `helmet`. |
| @fastify/rate-limit | 11.2.1 | MIT | Rate limit login & API | Plugin resmi; store memori cukup untuk 1 instans. |
| @fastify/static | 10.1.7 | MIT | Menyajikan frontend | Plugin resmi; proteksi traversal bawaan, diuji `SEC-PATH-001`. |
| argon2 | 0.45.1 | MIT | Hash kata sandi Argon2id (disyaratkan) | Binding referensi C `phc-winner-argon2`; **prebuilt binary disertakan di tarball npm** (tanpa unduhan saat install). 1 maintainer — risiko bus factor dicatat; alternatif: `@node-rs/argon2`. |
| better-sqlite3 | 13.0.3 | MIT | Driver SQLite sinkron, cepat, prepared statement | Prebuilt disertakan di tarball. Paket memiliki `binding.gyp`, sehingga npm secara default menjalankan `node-gyp rebuild` saat `npm ci` (gagal bila header Node tidak dapat diunduh) — dinonaktifkan lewat `.npmrc` (lihat bawah). 1 maintainer — alternatif jangka panjang: `node:sqlite` bawaan Node setelah stabil, atau PostgreSQL. |

`npm audit`: **0 kerentanan** (prod + dev, 218 paket).

### `.npmrc`: `ignore-scripts=true`

Install/postinstall script dari dependensi **tidak dijalankan** — menutup vektor supply chain yang umum (script berbahaya saat install). Kedua modul native (argon2, better-sqlite3) memuat binary prebuilt dari tarball npm saat runtime, diverifikasi dengan `npm ci` bersih lalu lint + 181 tes lulus. Bila platform target tidak memiliki prebuilt, build manual harus dilakukan secara sadar (`npm rebuild better-sqlite3 --ignore-scripts=false`).

## Pengembangan

| Paket | Versi | Lisensi | Alasan |
|---|---|---|---|
| vitest | 5.0.5 | MIT | Unit & integrasi (disyaratkan) |
| @playwright/test | 1.63.0 | Apache-2.0 | E2E (disyaratkan). Dipin ke 1.63.0 agar cocok dengan browser Chromium yang terpasang di lingkungan. |
| eslint, @eslint/js, globals | 10.13.0 / 10.0.1 / 17.13.0 | MIT | Lint + aturan larangan `innerHTML`/`eval` |

## Tidak dipakai (sengaja)

| Kandidat | Alasan ditolak |
|---|---|
| Framework frontend (React/Vue/…) | Dilarang spesifikasi |
| Bundler (Vite/webpack) | Tidak diperlukan untuk ES Modules native; mengurangi supply chain |
| ORM (Prisma/Knex) | Repositori SQL eksplisit lebih mudah diaudit; migrasi berupa SQL murni |
| `jsonwebtoken` | Sesi server-side dipilih (ADR-0003) |
| `dotenv` | Diganti `node --env-file-if-exists` bawaan Node 22 |
| `@fastify/cors` | Aplikasi same-origin; tanpa CORS = tanpa permukaan salah konfigurasi |
| Font CDN / Google Fonts | Privasi & CSP `'self'` |
| TradingView Lightweight Charts | Akan dipasang di M4 (Apache-2.0, perlu atribusi TradingView sesuai lisensinya) sebagai file vendor lokal |

## Alat keamanan

| Alat | Status di M1 |
|---|---|
| Semgrep 1.182.1 (PyPI, LGPL-2.1, dipasang di virtualenv terpisah, tidak masuk dependensi proyek) | Dijalankan dengan aturan lokal |
| detect-secrets 1.5.0 (PyPI, Apache-2.0) | Dijalankan sebagai pengganti sementara Gitleaks |
| Gitleaks, Trivy, OWASP ZAP | Belum dijalankan — sumber unduhan diblokir; dijadwalkan di CI/M7 |
