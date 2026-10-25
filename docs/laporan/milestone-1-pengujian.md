# Laporan Pengujian — Milestone 1

Laporan ini merangkum metode dan hasil. Daftar lengkap setiap tes (ID, nama, status, durasi) ada di **[hasil-tes-otomatis.md](hasil-tes-otomatis.md)**, yang dihasilkan otomatis oleh `npm run report:tests` dari file hasil eksekusi Vitest (`reports/vitest-results.json`) dan Playwright (`reports/e2e-results.json`). Angka di bawah disalin dari file tersebut.

## 1. Ringkasan hasil (eksekusi 2026-10-25, Node.js 22.22.0, Chromium build 1243)

| Pemeriksaan | Perintah | Hasil |
|---|---|---|
| Instalasi bersih | `rm -rf node_modules && npm ci` | Berhasil, 0 kerentanan (setelah perbaikan `.npmrc`, lihat §5) |
| Lint | `npm run lint` | 0 error, 0 warning |
| Vitest: unit, positif, negatif, edge, keamanan | `npm test` | **181 / 181 lulus** |
| Playwright E2E (desktop 1440×900 + mobile 390×844) | `npm run test:e2e` | **18 / 18 lulus** |
| npm audit (prod + dev) | `npm audit` | 0 kerentanan |
| Semgrep (aturan lokal) | lihat §4 | 0 temuan |
| detect-secrets | lihat §4 | 22 kandidat, semua false positive (fixture tes) |
| Gitleaks, Trivy, OWASP ZAP | — | **Tidak dijalankan** (sumber unduhan diblokir; dijadwalkan M7) |
| Docker startup | — | **Tidak diverifikasi** (daemon tidak tersedia; M8) |

## 2. Konvensi ID tes

Setiap tes diawali ID `KATEGORI-AREA-NNN`. Nama tes memuat input dan hasil yang diharapkan (mis. `NEG-CSRF-003 Origin asing ditolak, termasuk pada login`).

| Prefiks | Kategori | Jumlah |
|---|---|---|
| `UNIT` | Unit (fungsi murni, repositori, migrasi) | 21 |
| `POS` | Alur positif | 16 |
| `NEG` | Alur negatif (input/akses tidak sah) | 110 |
| `EDGE` | Kasus tepi | 16 |
| `SEC` | Kontrol keamanan | 18 |
| `E2E` | End-to-end di browser nyata | 18 (9 skenario × 2 viewport) |

Area: `AUTH` autentikasi, `SES` sesi, `CSRF`, `RL` rate limit, `AZ` otorisasi, `IN` validasi input, `SET` pengaturan, `SYS` status sistem, `DB` database, `CFG` konfigurasi, `PWD` kata sandi, `TOK` token, `HDR` header, `PATH` traversal, `ERR` error, `UI`, `NAV`, `USR` pengguna, `RST` restart, `FMT` format.

## 3. Prakondisi & metode per suite

| Suite | Prakondisi | Metode |
|---|---|---|
| `tests/unit` | Database SQLite `:memory:` baru per tes; jam deterministik (`createClock`, mulai 2026-01-01T00:00Z) | Pemanggilan fungsi langsung |
| `tests/positive`, `negative`, `edge`, `security` | Aplikasi Fastify lengkap via `buildApp` dengan DB `:memory:`, dua pengguna (`mary` admin, `rekan` analyst), jam deterministik, Argon2id parameter ringan **khusus tes** | `app.inject()` — HTTP in-process tanpa jaringan; menguji seluruh pipeline hook, parser, validasi, handler |
| `tests/edge` (`EDGE-RST-*`) | File database sementara di disk | Aplikasi ditutup lalu dibuka ulang dengan file yang sama |
| `tests/e2e` | Server nyata (`tests/e2e/server.js`) di port 8181, DB file sementara, Argon2id **parameter produksi** | Chromium headless via Playwright; menangkap error konsol, `pageerror`, dan pelanggaran CSP |

Tes tidak memakai mock untuk HTTP, database, atau hashing. Belum ada integrasi eksternal (Binance) di M1, sehingga tidak ada klaim verifikasi live.

## 4. Pemindaian keamanan — bukti

```
$ semgrep scan --metrics=off --config config/semgrep/long-radar.yml .
Ran 9 rules on 48 files: 0 findings.        (semgrep 1.182.1)

$ npm audit --json → metadata.vulnerabilities
{ info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }   (218 dependensi)

$ detect-secrets scan --all-files (kecuali node_modules, lockfile, hasil tes)
22 kandidat "Secret Keyword"/"Basic Auth"/"Hex High Entropy":
  tests/** (kata sandi fixture uji), backend/auth/password.js:22 (string dummy timing),
  docs/laporan/hasil-tes-otomatis.md (judul tes). Ditriase: false positive, tidak ada rahasia nyata.
```

Catatan: berkas aturan Semgrep pada perintah di atas kini bernama `config/semgrep/alphalens.yml`; hasil di atas tidak diubah.

Registry ruleset Semgrep (`p/javascript`, `p/nodejs`, `p/owasp-top-ten`, `p/secrets`) gagal diunduh: `ProxyError ... semgrep.dev ... 403 Forbidden`.

## 5. Cacat yang ditemukan tes dan diperbaiki

| ID tes | Gejala | Akar masalah | Perbaikan | Retest |
|---|---|---|---|---|
| NEG-AUTH-003 | `PUT /api/settings/scanner` tanpa sesi → 400 dengan detail skema | Validasi body berjalan sebelum gerbang auth (`preHandler`) | Gerbang auth dipindah ke `onRequest` | Lulus |
| E2E-AUTH-001 dst. | Kredensial muncul di URL `login.html?username=…&password=…` | Rate limit global menghitung aset statis → `login.js` 429 → form terkirim native (GET) | Aset statis dikecualikan dari rate limit; `method="post"`; tombol nonaktif sampai JS termuat | Lulus; ditambah `SEC-RL-002`, `SEC-UI-001` |
| E2E-NAV-001 | `pageerror: Atribut event inline dilarang: on` | Regex larangan atribut `on*` juga menangkap opsi `on` | Regex `^on.` | Lulus |
| (instalasi) | `npm ci` gagal di `node-gyp rebuild` better-sqlite3 (unduhan header 403) | npm otomatis membangun paket ber-`binding.gyp` | `.npmrc` `ignore-scripts=true`, binary prebuilt | `npm ci` + lint + tes lulus |
| SEC-HDR-002 | `X-Frame-Options: SAMEORIGIN` tidak konsisten dengan `frame-ancestors 'none'` | Default helmet | `frameguard: deny` | Lulus |

## 6. Keterbatasan yang diketahui

- Tidak ada uji beban/DoS; batas waktu & ukuran body diuji fungsional saja.
- Rate limit memakai store memori — reset saat restart dan tidak dibagi antarproses (cukup untuk satu instans API).
- Uji E2E hanya di Chromium.
- TOTP MFA belum diimplementasikan.
- Tes kontras warna dihitung dari token (lihat `docs/04-design-system.md`), belum ada audit aksesibilitas otomatis (axe) — direncanakan M7.

## 7. Cara mereproduksi

```bash
npm ci
npm run lint
npm run report:tests     # menjalankan Vitest + Playwright lalu menulis hasil-tes-otomatis.md
npm audit
```

## 8. Tangkapan layar

Diambil dari aplikasi yang berjalan (server E2E, database kosong) dengan Playwright — bukan mockup. Layar Design System memuat tabel berlabel "Data ilustratif · bukan data pasar".

| Layar | File |
|---|---|
| Login | [login.png](tangkapan-layar/login.png) |
| Overview | [overview.png](tangkapan-layar/overview.png) |
| LONG Screener | [screener.png](tangkapan-layar/screener.png) |
| Pengaturan | [settings.png](tangkapan-layar/settings.png) |
| System Health | [health.png](tangkapan-layar/health.png) |
| Design System | [design-system.png](tangkapan-layar/design-system.png) |
| Overview (mobile 390px) | [mobile-overview.png](tangkapan-layar/mobile-overview.png) |
