# Hasil Tes Otomatis

> Dokumen ini **dihasilkan otomatis** oleh `npm run report:tests` dari file hasil eksekusi Vitest dan Playwright.
> Jangan diedit manual.

- Waktu eksekusi Vitest: 2026-10-25T13:54:14.219Z
- Commit basis: `c1db260` (perubahan yang belum di-commit dapat ikut teruji)
- Node.js: v22.22.0

## Ringkasan

| Suite | Total | Lulus | Gagal | Dilewati |
|---|---|---|---|---|
| Vitest (unit, positif, negatif, edge, keamanan) | 181 | 181 | 0 | 0 |
| Playwright E2E (desktop + mobile) | 18 | 18 | 0 | 0 |

### Per kategori ID

| Prefiks | Arti | Total | Lulus |
|---|---|---|---|
| E2E | End-to-end | 18 | 18 |
| EDGE | Kasus tepi | 16 | 16 |
| NEG | Negatif | 110 | 110 |
| POS | Positif | 16 | 16 |
| SEC | Keamanan | 18 | 18 |
| UNIT | Unit | 21 | 21 |

## Detail Vitest

| ID | Tes | File | Status | ms |
|---|---|---|---|---|
| EDGE-SET-001 | EDGE-SET-001 dua update bersamaan dengan versi sama → satu sukses, satu 409 (tanpa lost update) | tests/edge/edge.test.js | LULUS | 270 |
| EDGE-SET-002 | EDGE-SET-002 versi usang setelah update → 409 | tests/edge/edge.test.js | LULUS | 82 |
| EDGE-AUTH-001 | EDGE-AUTH-001 username tidak case-sensitive | tests/edge/edge.test.js | LULUS | 43 |
| EDGE-AUTH-002 | EDGE-AUTH-002 banyak login paralel untuk user yang sama menghasilkan sesi independen | tests/edge/edge.test.js | LULUS | 53 |
| EDGE-AUTH-003 | EDGE-AUTH-003 login ulang dari browser yang sama mencabut sesi lama (anti session fixation) | tests/edge/edge.test.js | LULUS | 54 |
| EDGE-AUTH-004 | EDGE-AUTH-004 kegagalan login paralel tetap dihitung atomik dan memicu penguncian | tests/edge/edge.test.js | LULUS | 100 |
| EDGE-AUTH-005 | EDGE-AUTH-005 sesi kedaluwarsa absolut meskipun terus aktif | tests/edge/edge.test.js | LULUS | 76 |
| EDGE-USR-001 | EDGE-USR-001 maksimal dua pengguna; pengguna ketiga ditolak | tests/edge/edge.test.js | LULUS | 12 |
| EDGE-RST-001 | EDGE-RST-001 sesi & pengaturan bertahan setelah restart; migrasi tidak diterapkan ulang | tests/edge/edge.test.js | LULUS | 91 |
| EDGE-RST-002 | EDGE-RST-002 readiness 503 bila database tidak tersedia | tests/edge/edge.test.js | LULUS | 41 |
| NEG-AUTH-001 | NEG-AUTH-001 kata sandi salah → 401 generik tanpa cookie | tests/negative/auth.negative.test.js | LULUS | 221 |
| NEG-AUTH-002 | NEG-AUTH-002 username tidak dikenal → respons identik dengan kata sandi salah (anti enumerasi) | tests/negative/auth.negative.test.js | LULUS | 63 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/auth/session tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 29 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/auth/sessions tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 33 |
| NEG-AUTH-003 | NEG-AUTH-003 POST /api/auth/logout tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 68 |
| NEG-AUTH-003 | NEG-AUTH-003 DELETE /api/auth/sessions/1 tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 48 |
| NEG-AUTH-003 | NEG-AUTH-003 POST /api/auth/sessions/revoke-others tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 54 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/settings/scanner tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 48 |
| NEG-AUTH-003 | NEG-AUTH-003 PUT /api/settings/scanner tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 40 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/system/status tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 33 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/overview tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 35 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/does-not-exist tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 55 |
| NEG-AUTH-004 | NEG-AUTH-004 cookie palsu (token acak berformat benar) → 401 | tests/negative/auth.negative.test.js | LULUS | 39 |
| NEG-AUTH-004 | NEG-AUTH-004 cookie palsu (token berformat salah) → 401 | tests/negative/auth.negative.test.js | LULUS | 33 |
| NEG-AUTH-004 | NEG-AUTH-004 cookie palsu (cookie kosong) → 401 | tests/negative/auth.negative.test.js | LULUS | 45 |
| NEG-AUTH-005 | NEG-AUTH-005 dashboard tanpa sesi diarahkan ke login; /index.html tidak dapat diakses langsung | tests/negative/auth.negative.test.js | LULUS | 44 |
| NEG-AUTH-006 | NEG-AUTH-006 sesi idle kedaluwarsa → 401 | tests/negative/auth.negative.test.js | LULUS | 40 |
| NEG-AUTH-007 | NEG-AUTH-007 akun terkunci setelah N kegagalan — kata sandi benar pun ditolak sampai masa kunci habis | tests/negative/auth.negative.test.js | LULUS | 65 |
| NEG-AUTH-008 | NEG-AUTH-008 akun dinonaktifkan tidak dapat login | tests/negative/auth.negative.test.js | LULUS | 63 |
| NEG-AUTH-009 | NEG-AUTH-009 audit kegagalan tidak menyimpan kata sandi yang dicoba | tests/negative/auth.negative.test.js | LULUS | 46 |
| NEG-RL-001 | NEG-RL-001 percobaan ke-6 dalam jendela waktu → 429 | tests/negative/auth.negative.test.js | LULUS | 70 |
| NEG-CSRF-001 | NEG-CSRF-001 request terautentikasi tanpa X-CSRF-Token → 403 | tests/negative/auth.negative.test.js | LULUS | 41 |
| NEG-CSRF-002 | NEG-CSRF-002 token CSRF salah atau milik sesi lain → 403 | tests/negative/auth.negative.test.js | LULUS | 36 |
| NEG-CSRF-003 | NEG-CSRF-003 Origin asing ditolak, termasuk pada login | tests/negative/auth.negative.test.js | LULUS | 38 |
| NEG-CSRF-004 | NEG-CSRF-004 Sec-Fetch-Site: cross-site ditolak | tests/negative/auth.negative.test.js | LULUS | 43 |
| NEG-CSRF-005 | NEG-CSRF-005 content-type "simple request" text/plain ditolak (415) | tests/negative/auth.negative.test.js | LULUS | 41 |
| NEG-CSRF-005 | NEG-CSRF-005 content-type "simple request" application/x-www-form-urlencoded ditolak (415) | tests/negative/auth.negative.test.js | LULUS | 32 |
| NEG-CSRF-005 | NEG-CSRF-005 content-type "simple request" multipart/form-data; boundary=x ditolak (415) | tests/negative/auth.negative.test.js | LULUS | 36 |
| NEG-IN-001 | NEG-IN-001 JSON rusak → 400 tanpa stack trace | tests/negative/input.negative.test.js | LULUS | 252 |
| NEG-IN-002 | NEG-IN-002 payload > 64KB → 413 | tests/negative/input.negative.test.js | LULUS | 63 |
| NEG-IN-003 | NEG-IN-003 login dengan field tambahan → 400 | tests/negative/input.negative.test.js | LULUS | 51 |
| NEG-IN-003 | NEG-IN-003 login dengan username bukan string → 400 | tests/negative/input.negative.test.js | LULUS | 70 |
| NEG-IN-003 | NEG-IN-003 login dengan username karakter ilegal → 400 | tests/negative/input.negative.test.js | LULUS | 54 |
| NEG-IN-003 | NEG-IN-003 login dengan tanpa password → 400 | tests/negative/input.negative.test.js | LULUS | 48 |
| NEG-IN-003 | NEG-IN-003 login dengan password terlalu panjang → 400 | tests/negative/input.negative.test.js | LULUS | 48 |
| NEG-IN-003 | NEG-IN-003 login dengan body array → 400 | tests/negative/input.negative.test.js | LULUS | 68 |
| NEG-IN-004 | NEG-IN-004 prototype pollution via __proto__ / constructor ditolak | tests/negative/input.negative.test.js | LULUS | 45 |
| NEG-IN-005 | NEG-IN-005 SQL injection pada password diperlakukan sebagai teks biasa | tests/negative/input.negative.test.js | LULUS | 58 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan XSS pada simbol manual → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 40 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan simbol non-USDT → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 34 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan timeframe tidak didukung → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 36 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan timeframe duplikat → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 47 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan timeframe kosong → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 48 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan angka sebagai string (tanpa coercion) → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 50 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan maxAuto pecahan → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 38 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan spread negatif → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 53 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan volume di atas batas → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 49 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan field tak dikenal → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 53 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan mode manual tanpa simbol → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 37 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan tahap alert tidak dikenal → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 49 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan simbol > 100 → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 54 |
| NEG-IN-007 | NEG-IN-007 version negatif / bukan integer → 400 | tests/negative/input.negative.test.js | LULUS | 67 |
| NEG-IN-008 | NEG-IN-008 id sesi tidak valid "0" → 400 | tests/negative/input.negative.test.js | LULUS | 36 |
| NEG-IN-008 | NEG-IN-008 id sesi tidak valid "-1" → 400 | tests/negative/input.negative.test.js | LULUS | 46 |
| NEG-IN-008 | NEG-IN-008 id sesi tidak valid "abc" → 400 | tests/negative/input.negative.test.js | LULUS | 31 |
| NEG-IN-008 | NEG-IN-008 id sesi tidak valid "1e3" → 400 | tests/negative/input.negative.test.js | LULUS | 37 |
| NEG-IN-008 | NEG-IN-008 id sesi tidak valid "99999999999999999999" → 400 | tests/negative/input.negative.test.js | LULUS | 48 |
| NEG-AZ-001 | NEG-AZ-001 analyst tidak dapat mengubah pengaturan (403) dan tidak ada perubahan | tests/negative/input.negative.test.js | LULUS | 46 |
| NEG-AZ-002 | NEG-AZ-002 pengguna tidak dapat mencabut sesi milik pengguna lain (404, sesi tetap aktif) | tests/negative/input.negative.test.js | LULUS | 50 |
| NEG-AZ-003 | NEG-AZ-003 daftar sesi hanya memuat sesi milik sendiri | tests/negative/input.negative.test.js | LULUS | 61 |
| POS-SYS-001 | POS-SYS-001 health & ready publik | tests/positive/api.positive.test.js | LULUS | 265 |
| POS-SYS-002 | POS-SYS-002 status sistem berisi metrik nyata & komponen yang belum ada ditandai jujur | tests/positive/api.positive.test.js | LULUS | 92 |
| POS-SYS-003 | POS-SYS-003 overview menghitung dari database (kosong → nol) | tests/positive/api.positive.test.js | LULUS | 44 |
| POS-SYS-004 | POS-SYS-004 overview mencerminkan baris nyata di database | tests/positive/api.positive.test.js | LULUS | 45 |
| POS-SET-001 | POS-SET-001 pengaturan default dikembalikan sebelum pernah disimpan | tests/positive/api.positive.test.js | LULUS | 70 |
| POS-SET-002 | POS-SET-002 admin menyimpan pengaturan valid → versi naik, persisten, tercatat audit | tests/positive/api.positive.test.js | LULUS | 68 |
| POS-SET-003 | POS-SET-003 analyst dapat membaca pengaturan | tests/positive/api.positive.test.js | LULUS | 62 |
| POS-AUTH-001 | POS-AUTH-001 login valid → 200, cookie HttpOnly + SameSite=Strict, token CSRF, tanpa hash di respons | tests/positive/auth.positive.test.js | LULUS | 270 |
| POS-AUTH-002 | POS-AUTH-002 cookie __Host- dan Secure saat origin HTTPS | tests/positive/auth.positive.test.js | LULUS | 115 |
| POS-AUTH-003 | POS-AUTH-003 sesi aktif dapat dibaca | tests/positive/auth.positive.test.js | LULUS | 50 |
| POS-AUTH-004 | POS-AUTH-004 logout mencabut sesi di server | tests/positive/auth.positive.test.js | LULUS | 63 |
| POS-AUTH-005 | POS-AUTH-005 dashboard disajikan hanya untuk sesi valid; login page mengarahkan ke dashboard | tests/positive/auth.positive.test.js | LULUS | 92 |
| POS-AUTH-006 | POS-AUTH-006 daftar sesi & cabut sesi lain | tests/positive/auth.positive.test.js | LULUS | 69 |
| POS-AUTH-007 | POS-AUTH-007 cabut satu sesi tertentu milik sendiri | tests/positive/auth.positive.test.js | LULUS | 63 |
| POS-AUTH-008 | POS-AUTH-008 login & logout tercatat di audit log | tests/positive/auth.positive.test.js | LULUS | 39 |
| POS-AUTH-009 | POS-AUTH-009 dua pengguna dapat login bersamaan secara independen | tests/positive/auth.positive.test.js | LULUS | 47 |
| SEC-HDR-001 | SEC-HDR-001 CSP ketat tanpa unsafe-inline/unsafe-eval | tests/security/headers.security.test.js | LULUS | 12 |
| SEC-HDR-002 | SEC-HDR-002 header pelindung standar | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-HDR-003 | SEC-HDR-003 HSTS hanya aktif di produksi | tests/security/headers.security.test.js | LULUS | 66 |
| SEC-HDR-004 | SEC-HDR-004 respons API tidak di-cache | tests/security/headers.security.test.js | LULUS | 3 |
| SEC-CORS-001 | SEC-CORS-001 preflight lintas origin tidak diberi izin CORS | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /../package.json tidak bocor | tests/security/headers.security.test.js | LULUS | 5 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /%2e%2e/package.json tidak bocor | tests/security/headers.security.test.js | LULUS | 3 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /css/..%2f..%2fpackage.json tidak bocor | tests/security/headers.security.test.js | LULUS | 3 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /..%5c..%5cpackage.json tidak bocor | tests/security/headers.security.test.js | LULUS | 1 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /.env tidak bocor | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /.git/config tidak bocor | tests/security/headers.security.test.js | LULUS | 1 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /js/../../backend/app/config.js tidak bocor | tests/security/headers.security.test.js | LULUS | 1 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /index.html tidak bocor | tests/security/headers.security.test.js | LULUS | 1 |
| SEC-ERR-001 | SEC-ERR-001 respons error tidak membocorkan stack trace atau path internal | tests/security/headers.security.test.js | LULUS | 1 |
| SEC-ERR-002 | SEC-ERR-002 rute API tak dikenal (dengan sesi) → 404 JSON generik | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-RL-001 | SEC-RL-001 rate limit global aktif pada API | tests/security/headers.security.test.js | LULUS | 1 |
| SEC-RL-002 | SEC-RL-002 aset statis tidak dihitung rate limit API (mencegah JS login gagal dimuat) | tests/security/headers.security.test.js | LULUS | 31 |
| SEC-UI-001 | SEC-UI-001 form login memakai POST dan tombol nonaktif sampai JS termuat (kredensial tidak pernah masuk URL) | tests/security/headers.security.test.js | LULUS | 54 |
| UNIT-CFG-001 | UNIT-CFG-001 default pengembangan valid dan cookie non-Secure untuk origin http | tests/unit/config.test.js | LULUS | 3 |
| UNIT-CFG-002 | UNIT-CFG-002 COOKIE_SECURE=auto menjadi true untuk origin https | tests/unit/config.test.js | LULUS | 1 |
| NEG-CFG-001 | NEG-CFG-001 produksi tanpa APP_ORIGIN ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-002 | NEG-CFG-002 produksi tanpa DATABASE_PATH ditolak | tests/unit/config.test.js | LULUS | 1 |
| NEG-CFG-003 | NEG-CFG-003 produksi dengan origin http ditolak | tests/unit/config.test.js | LULUS | 1 |
| NEG-CFG-004 | NEG-CFG-004 produksi dengan COOKIE_SECURE=false ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid PORT=abc ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid PORT=0 ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid PORT=70000 ditolak | tests/unit/config.test.js | LULUS | 1 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid NODE_ENV=staging ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid LOG_LEVEL=verbose ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid TRUST_PROXY=yes ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid APP_ORIGIN=notaurl ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid APP_ORIGIN=ftp://x.local ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid APP_ORIGIN=https://x.local/path ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid APP_ORIGIN=https://user:pw@x.local ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid SESSION_IDLE_MINUTES=-5 ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid MAX_USERS=0 ditolak | tests/unit/config.test.js | LULUS | 0 |
| UNIT-CFG-003 | UNIT-CFG-003 produksi lengkap diterima dan bersifat immutable | tests/unit/config.test.js | LULUS | 0 |
| UNIT-FMT-001 | UNIT-FMT-001 waktu UTC kanonik | tests/unit/format.test.js | LULUS | 3 |
| EDGE-FMT-001 | EDGE-FMT-001 nilai non-finite ditampilkan sebagai tanda kosong, bukan angka palsu | tests/unit/format.test.js | LULUS | 1 |
| EDGE-FMT-002 | EDGE-FMT-002 presisi harga adaptif untuk aset sangat murah | tests/unit/format.test.js | LULUS | 1 |
| UNIT-FMT-002 | UNIT-FMT-002 bytes, durasi, relatif | tests/unit/format.test.js | LULUS | 1 |
| UNIT-DB-001 | UNIT-DB-001 seluruh entitas wajib dibuat | tests/unit/migrate.test.js | LULUS | 6 |
| UNIT-DB-002 | UNIT-DB-002 migrasi idempoten — run kedua tidak menerapkan apa pun | tests/unit/migrate.test.js | LULUS | 4 |
| UNIT-DB-003 | UNIT-DB-003 foreign key aktif | tests/unit/migrate.test.js | LULUS | 1 |
| NEG-DB-001 | NEG-DB-001 checksum migrasi yang berubah terdeteksi | tests/unit/migrate.test.js | LULUS | 4 |
| NEG-DB-002 | NEG-DB-002 migrasi di database yang tidak dikenal kode ditolak | tests/unit/migrate.test.js | LULUS | 6 |
| NEG-DB-003 | NEG-DB-003 nomor migrasi tidak berurutan / nama tidak valid ditolak | tests/unit/migrate.test.js | LULUS | 3 |
| EDGE-DB-001 | EDGE-DB-001 migrasi gagal di tengah di-rollback seluruhnya | tests/unit/migrate.test.js | LULUS | 3 |
| UNIT-DB-004 | UNIT-DB-004 identitas candle unik: symbol + timeframe + open_time | tests/unit/migrate.test.js | LULUS | 1 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: high < low | tests/unit/migrate.test.js | LULUS | 1 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: timeframe tidak didukung | tests/unit/migrate.test.js | LULUS | 1 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: volume negatif | tests/unit/migrate.test.js | LULUS | 0 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: close_time <= open_time | tests/unit/migrate.test.js | LULUS | 0 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: harga nol | tests/unit/migrate.test.js | LULUS | 0 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: tipe data salah (STRICT) | tests/unit/migrate.test.js | LULUS | 0 |
| NEG-DB-005 | NEG-DB-005 password_hash wajib argon2id | tests/unit/migrate.test.js | LULUS | 0 |
| NEG-DB-006 | NEG-DB-006 settings wajib JSON valid | tests/unit/migrate.test.js | LULUS | 0 |
| UNIT-PWD-001 | UNIT-PWD-001 hash memakai varian argon2id dan salt acak | tests/unit/password.test.js | LULUS | 16 |
| UNIT-PWD-002 | UNIT-PWD-002 verifikasi benar/salah | tests/unit/password.test.js | LULUS | 7 |
| NEG-PWD-001 | NEG-PWD-001 hash rusak tidak melempar error, hanya false | tests/unit/password.test.js | LULUS | 0 |
| UNIT-PWD-003 | UNIT-PWD-003 parameter produksi ≥ minimum OWASP (m=19MiB, t=2) | tests/unit/password.test.js | LULUS | 0 |
| UNIT-PWD-004 | UNIT-PWD-004 hash dengan parameter lemah terdeteksi perlu rehash | tests/unit/password.test.js | LULUS | 2 |
| NEG-PWD-002 | NEG-PWD-002 kebijakan menolak kata sandi pendek | tests/unit/password.test.js | LULUS | 1 |
| NEG-PWD-002 | NEG-PWD-002 kebijakan menolak kata sandi terlalu panjang | tests/unit/password.test.js | LULUS | 0 |
| NEG-PWD-002 | NEG-PWD-002 kebijakan menolak kata sandi memuat username | tests/unit/password.test.js | LULUS | 0 |
| NEG-PWD-002 | NEG-PWD-002 kebijakan menolak kata sandi variasi rendah | tests/unit/password.test.js | LULUS | 1 |
| EDGE-PWD-001 | EDGE-PWD-001 panjang dihitung per code point (emoji/Unicode) | tests/unit/password.test.js | LULUS | 2 |
| UNIT-SES-001 | UNIT-SES-001 token mentah tidak disimpan di database | tests/unit/sessionService.test.js | LULUS | 24 |
| EDGE-SES-001 | EDGE-SES-001 tepat di batas idle → kedaluwarsa | tests/unit/sessionService.test.js | LULUS | 4 |
| UNIT-SES-002 | UNIT-SES-002 aktivitas memperpanjang idle (sliding) tetapi tidak melewati batas absolut | tests/unit/sessionService.test.js | LULUS | 5 |
| NEG-SES-001 | NEG-SES-001 sesi dicabut tidak dapat dipakai | tests/unit/sessionService.test.js | LULUS | 4 |
| NEG-SES-002 | NEG-SES-002 pengguna lain tidak dapat mencabut sesi bukan miliknya | tests/unit/sessionService.test.js | LULUS | 4 |
| NEG-SES-003 | NEG-SES-003 user dinonaktifkan → sesi tidak valid | tests/unit/sessionService.test.js | LULUS | 4 |
| EDGE-SES-002 | EDGE-SES-002 user-agent sangat panjang dipotong | tests/unit/sessionService.test.js | LULUS | 4 |
| UNIT-SES-003 | UNIT-SES-003 purge menghapus sesi kedaluwarsa | tests/unit/sessionService.test.js | LULUS | 4 |
| UNIT-SET-001 | UNIT-SET-001 default lolos validasi server & klien | tests/unit/settings.test.js | LULUS | 2 |
| NEG-SET-001 | NEG-SET-001 mode manual tanpa simbol ditolak | tests/unit/settings.test.js | LULUS | 1 |
| UNIT-SET-002 | UNIT-SET-002 timeframe dinormalisasi ke urutan kanonik | tests/unit/settings.test.js | LULUS | 0 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak timeframes kosong | tests/unit/settings.test.js | LULUS | 1 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak simbol berformat salah | tests/unit/settings.test.js | LULUS | 0 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak maxAuto pecahan | tests/unit/settings.test.js | LULUS | 0 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak volume NaN | tests/unit/settings.test.js | LULUS | 0 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak spread di atas batas | tests/unit/settings.test.js | LULUS | 0 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak bootstrap di bawah batas | tests/unit/settings.test.js | LULUS | 0 |
| UNIT-TOK-001 | UNIT-TOK-001 token 256-bit base64url dan unik | tests/unit/tokens.test.js | LULUS | 13 |
| UNIT-TOK-002 | UNIT-TOK-002 hash SHA-256 heksadesimal 64 karakter dan deterministik | tests/unit/tokens.test.js | LULUS | 1 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: undefined | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: null | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: 123 | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak:  | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: short | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa= | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ | tests/unit/tokens.test.js | LULUS | 0 |
| UNIT-TOK-003 | UNIT-TOK-003 safeEqual | tests/unit/tokens.test.js | LULUS | 0 |

## Detail Playwright

| ID | Tes | Proyek | Status | ms |
|---|---|---|---|---|
| E2E-AUTH-001 | E2E-AUTH-001 kredensial salah menampilkan pesan generik dan tetap di halaman login | desktop | LULUS | 752 |
| E2E-AUTH-002 | E2E-AUTH-002 login valid → dashboard; cookie sesi HttpOnly tidak terbaca JavaScript | desktop | LULUS | 946 |
| E2E-NAV-001 | E2E-NAV-001 seluruh layar dapat dibuka tanpa error konsol atau pelanggaran CSP | desktop | LULUS | 1342 |
| E2E-UI-001 | E2E-UI-001 overview menampilkan angka nyata dari database (nol) dan status jujur | desktop | LULUS | 892 |
| E2E-UI-002 | E2E-UI-002 tidak ada horizontal overflow halaman di setiap layar | desktop | LULUS | 1234 |
| E2E-SET-001 | E2E-SET-001 admin menyimpan pengaturan; validasi klien menolak input tidak valid | desktop | LULUS | 1657 |
| E2E-AZ-001 | E2E-AZ-001 analyst melihat pengaturan dalam mode baca saja | desktop | LULUS | 962 |
| E2E-SEC-001 | E2E-SEC-001 data yang ditampilkan di-escape (tidak dieksekusi sebagai HTML) | desktop | LULUS | 849 |
| E2E-AUTH-003 | E2E-AUTH-003 logout mengakhiri sesi; kembali ke dashboard diarahkan ke login | desktop | LULUS | 1119 |
| E2E-AUTH-001 | E2E-AUTH-001 kredensial salah menampilkan pesan generik dan tetap di halaman login | mobile | LULUS | 796 |
| E2E-AUTH-002 | E2E-AUTH-002 login valid → dashboard; cookie sesi HttpOnly tidak terbaca JavaScript | mobile | LULUS | 715 |
| E2E-NAV-001 | E2E-NAV-001 seluruh layar dapat dibuka tanpa error konsol atau pelanggaran CSP | mobile | LULUS | 1199 |
| E2E-UI-001 | E2E-UI-001 overview menampilkan angka nyata dari database (nol) dan status jujur | mobile | LULUS | 736 |
| E2E-UI-002 | E2E-UI-002 tidak ada horizontal overflow halaman di setiap layar | mobile | LULUS | 1150 |
| E2E-SET-001 | E2E-SET-001 admin menyimpan pengaturan; validasi klien menolak input tidak valid | mobile | LULUS | 1542 |
| E2E-AZ-001 | E2E-AZ-001 analyst melihat pengaturan dalam mode baca saja | mobile | LULUS | 775 |
| E2E-SEC-001 | E2E-SEC-001 data yang ditampilkan di-escape (tidak dieksekusi sebagai HTML) | mobile | LULUS | 756 |
| E2E-AUTH-003 | E2E-AUTH-003 logout mengakhiri sesi; kembali ke dashboard diarahkan ke login | mobile | LULUS | 1277 |
