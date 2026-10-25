# 02 — Model Ancaman & Kontrol Keamanan

Acuan: OWASP ASVS 4.0.3 (level 2 sebagai target), OWASP Top 10 2021. Status dinilai per Milestone 1.

## 1. Aset & batas kepercayaan

| Aset | Sensitivitas |
|---|---|
| Kredensial & sesi dua pengguna | Tinggi |
| Definisi pola, contoh pola, screenshot (M5) | Tinggi (kekayaan intelektual riset) |
| Riwayat sinyal & hasil backtest | Sedang–tinggi |
| Pengaturan scanner | Sedang |
| Data pasar Binance | Rendah (publik), tetapi integritasnya kritis |

Batas kepercayaan: (1) browser ↔ reverse proxy/API, (2) API ↔ database/file, (3) worker ↔ Binance (data eksternal tidak tepercaya), (4) upload pengguna ↔ penyimpanan (M5).

## 2. Ancaman, kontrol, dan status

Legenda status: **Diterapkan** = ada di kode M1 dan diuji · **Sebagian** · **Direncanakan** (milestone).

| Ancaman | CWE | Kontrol | Bukti tes | Status |
|---|---|---|---|---|
| Bypass autentikasi | CWE-287 | Semua route `/api/*` wajib sesi kecuali `public` eksplisit; gerbang per route (pola route yang cocok, bukan URL mentah) di `onRequest` sebelum parsing body; fail closed untuk route tanpa gerbang | NEG-AUTH-003/004/005, SEC-RT-001…009 | Diterapkan |
| Broken access control | CWE-284/639 | Peran `admin`/`analyst`; ubah pengaturan hanya admin; operasi sesi dibatasi `user_id` pemilik | NEG-AZ-001/002/003 | Diterapkan |
| Brute force / credential stuffing | CWE-307 | Rate limit login 5/15 menit per IP (juga untuk path ter-encode); kunci akun 15 menit setelah 10 gagal — percobaan dipesan atomik SEBELUM verifikasi Argon2 sehingga tebakan paralel tidak melewati ambang; login sukses tidak menghapus kunci aktif; Argon2id m=64MiB t=3 | NEG-RL-001, NEG-AUTH-007, EDGE-AUTH-004/006/007, SEC-RT-005 | Diterapkan |
| Enumerasi akun | CWE-204 | Pesan & status identik untuk user tidak ada/kata sandi salah/akun terkunci; verifikasi hash dummy untuk menyamakan waktu | NEG-AUTH-002 | Diterapkan |
| Penyimpanan kata sandi lemah | CWE-916 | Argon2id; kebijakan 12–128 karakter; rehash otomatis bila parameter naik | UNIT-PWD-* | Diterapkan |
| Session hijacking | CWE-384/613 | Token 256-bit acak, hanya hash SHA-256 disimpan; HttpOnly, SameSite=Strict, `__Host-` + Secure di HTTPS; idle 30 menit & absolut 12 jam — idle hanya digeser oleh aktivitas API terautentikasi, bukan polling `/api/ready`, aset statis, atau auto-refresh (`X-LR-Background: 1`, hanya dapat memperpendek sesi); sesi lama dicabut saat login ulang; daftar & cabut sesi | UNIT-SES-*, EDGE-AUTH-003/005, SEC-RT-008/011, E2E-AUTH-002, E2E-SEC-002 | Diterapkan |
| XSS | CWE-79 | CSP `script-src 'self'` tanpa inline/eval; render via `textContent`; `innerHTML` dilarang ESLint+Semgrep; validasi pola simbol di server | SEC-HDR-001, E2E-SEC-001, NEG-IN-006 | Diterapkan |
| CSRF | CWE-352 | SameSite=Strict; Origin harus = `APP_ORIGIN`; `Sec-Fetch-Site: cross-site` ditolak; token CSRF per sesi di header; hanya `application/json` (text/plain & form ditolak 415) | NEG-CSRF-001…005 | Diterapkan |
| Injeksi SQL | CWE-89 | Hanya prepared statement berparameter; aturan Semgrep `lr-sql-interpolation` | NEG-IN-005, Semgrep 0 temuan | Diterapkan |
| Prototype pollution | CWE-1321 | `onProtoPoisoning`/`onConstructorPoisoning: 'error'`; `additionalProperties: false` | NEG-IN-004 | Diterapkan |
| Mass assignment / input tak valid | CWE-20/915 | JSON Schema ketat tanpa coercion & tanpa default; aturan lintas-field | NEG-IN-003/006/007/008 | Diterapkan |
| Path traversal | CWE-22 | `@fastify/static` dengan root tetap, `dotfiles: deny`, `index.html` hanya via route berautentikasi | SEC-PATH-001 | Diterapkan (upload: M5) |
| Clickjacking | CWE-1021 | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | SEC-HDR-001/002 | Diterapkan |
| Kebocoran informasi via error | CWE-209 | Error handler generik; stack hanya di log server | SEC-ERR-001/002, NEG-IN-001 | Diterapkan |
| Kredensial di URL/log | CWE-598/532 | Form login `method=post`, tombol aktif setelah JS termuat; redaksi cookie/CSRF di log; audit tidak menyimpan kata sandi | SEC-UI-001, NEG-AUTH-009 | Diterapkan |
| DoS (aplikasi) | CWE-400 | Body ≤64KB; timeout koneksi/request 30 detik; rate limit API 300/menit/IP; panjang input dibatasi skema | NEG-IN-002, SEC-RL-001 | Sebagian (uji beban: M7) |
| Race condition | CWE-362 | Versi optimistik pada pengaturan (409); penghitung gagal login dalam transaksi | EDGE-SET-001/002, EDGE-AUTH-004 | Diterapkan |
| CORS terlalu longgar | CWE-942 | Tidak ada plugin CORS → hanya same-origin | SEC-CORS-001 | Diterapkan |
| Konfigurasi produksi tidak aman | CWE-16 | Startup gagal bila produksi tanpa HTTPS/cookie Secure/path DB eksplisit; HSTS di produksi | NEG-CFG-*, SEC-HDR-003 | Diterapkan |
| Kebocoran rahasia di repo | CWE-798 | `.env` di-gitignore; tidak ada rahasia aplikasi (sesi tidak butuh secret); detect-secrets ditriase | Laporan §4 | Sebagian (Gitleaks di CI: M7) |
| Dependensi rentan | CWE-1104 | Versi dipin eksak + lockfile; `npm audit` | npm audit 0 | Sebagian (Trivy: M7/M8) |
| SSRF | CWE-918 | Tidak ada fetch URL dari input pengguna. Worker M2 hanya memanggil host Binance yang di-allowlist | — | Direncanakan (M2) |
| Otorisasi WebSocket | CWE-1385 | Upgrade WS wajib cookie sesi valid + cek Origin | — | Direncanakan (M4) |
| Upload berbahaya | CWE-434 | Magic-byte sniffing, batas ukuran, re-encode gambar, nama acak, direktori di luar web root | — | Direncanakan (M5) |
| Eksekusi aturan pola | CWE-94/95 | Evaluator deklaratif; `eval`/`new Function` dilarang ESLint+Semgrep | Semgrep `lr-dynamic-code` | Kontrol dasar diterapkan |
| MFA | — | TOTP opsional (kolom `totp_secret` sudah ada) | — | Direncanakan (M7) |

## 3. Keputusan desain keamanan penting

- **Sesi server-side, bukan JWT** (ADR-0003): pencabutan instan, tidak ada token di Web Storage.
- **Tanpa pendaftaran publik**: pengguna dibuat via CLI dengan batas `MAX_USERS=2`. Kata sandi dibaca dari prompt tersembunyi/stdin, tidak pernah dari argumen CLI.
- **Login CSRF** dicegah oleh cek Origin + JSON-only + SameSite, karena token CSRF belum ada sebelum login.
- **`TRUST_PROXY`** default `false`. Di belakang reverse proxy, isi dengan **IP/CIDR proxy tersebut** (mis. `127.0.0.1`), bukan `true`: hanya hop dari alamat itu yang dipercaya sehingga `request.ip` (kunci rate limit & audit) tidak dapat dipalsukan via `X-Forwarded-For`. Nilai `true` dan jumlah hop ditolak saat startup. Proxy wajib menimpa header (nginx: `proxy_set_header X-Forwarded-For $remote_addr;`).

## 4. Pemindaian keamanan Milestone 1

| Alat | Hasil | Catatan |
|---|---|---|
| `npm audit` (prod + dev, 218 paket) | 0 kerentanan | Dijalankan 2026-10-25. |
| Semgrep 1.182.1, aturan lokal `config/semgrep/alphalens.yml` (9 aturan, 48 file) | 0 temuan | Ruleset registry (`p/javascript`, `p/owasp-top-ten`, dll.) **tidak dapat diunduh** — semgrep.dev diblokir jaringan build. Harus dijalankan di CI (M7). Dua temuan awal (interpolasi konstanta SQL, `execSync`) direfaktor walau bukan celah nyata. |
| detect-secrets 1.5.0 (pengganti sementara Gitleaks) | 22 kandidat, **semuanya false positive** | Kata sandi fixture tes (`tests/**`), string dummy timing di `password.js`, contoh `user:pw@` di tes konfigurasi, judul tes di laporan. Tidak ada rahasia nyata. |
| Gitleaks | **Tidak dijalankan** | Binary hanya tersedia dari GitHub Releases/Docker Hub yang diblokir. Direncanakan di CI. |
| Trivy | **Tidak dijalankan** | Sama seperti di atas; belum ada image container (M8). |
| OWASP ZAP | **Tidak dijalankan** | DAST dijadwalkan M7 terhadap staging terisolasi. |

Tidak ada CVE atau temuan yang dikarang. Semua angka di atas berasal dari eksekusi alat di lingkungan build.
