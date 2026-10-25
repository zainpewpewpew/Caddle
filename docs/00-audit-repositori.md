# 00 — Audit Repositori

Tanggal audit: 2026-10-25 · Milestone 1

## 1. Kondisi awal

| Aspek | Temuan |
|---|---|
| Repositori | `zainpewpewpew/Caddle` |
| Riwayat git | **Kosong** — tidak ada commit, tidak ada branch di remote (`git ls-remote` tidak mengembalikan ref). |
| Kode yang ada | Tidak ada. Tidak ada fungsionalitas lama yang harus dipertahankan atau direfaktor. |
| Konfigurasi CI | Tidak ada. |
| Rahasia ter-commit | Tidak ada (repositori kosong). |

Konsekuensinya, Milestone 1 adalah **greenfield**. Agar pull request dapat dibuka, sebuah commit awal berisi `README.md` singkat dibuat di branch `main` sebagai basis. Seluruh kode Milestone 1 berada di branch fitur dan masuk melalui PR.

## 2. Lingkungan pengembangan yang terverifikasi

| Komponen | Versi | Catatan |
|---|---|---|
| Node.js | 22.22.0 | LTS. `engines` dipin `>=22.12 <23`. |
| npm | 10.9.4 | |
| SQLite (via better-sqlite3) | 3.53.4 | Binary prebuilt terpasang tanpa kompilasi. |
| Chromium (Playwright) | build 1243 | Terpasang di lingkungan; `@playwright/test` dipin 1.63.0 agar cocok. |
| Docker | CLI ada, **daemon tidak berjalan** | Verifikasi Docker ditunda ke Milestone 8. |

## 3. Alur kerja Superpowers (obra/superpowers)

Spesifikasi meminta inspeksi repositori `obra/superpowers` sebelum dipakai. Dari lingkungan build ini **akses ke github.com dan raw.githubusercontent.com diblokir oleh kebijakan jaringan** (HTTP 403 pada CONNECT), sehingga dokumentasi, lisensi, status pemeliharaan, dan skrip instalasinya **tidak dapat diverifikasi**. Sesuai aturan "jangan memasang skrip pihak ketiga secara membabi buta", plugin tersebut **tidak dipasang**.

Praktik yang dianjurkan Superpowers tetap diterapkan secara manual:

| Praktik | Penerapan di Milestone 1 |
|---|---|
| Brainstorming & perencanaan arsitektur | `docs/01-arsitektur.md`, ADR di `docs/adr/` |
| Test-driven development | Perilaku kritis (auth, CSRF, validasi, migrasi) dicakup tes positif/negatif/edge; beberapa bug ditemukan oleh tes sebelum rilis (lihat §5). |
| Systematic debugging | Kegagalan tes ditelusuri ke akar masalah, bukan dilonggarkan asersinya. |
| Implementasi inkremental & commit kecil | 6 commit fungsional terpisah di PR. |
| Verification before completion | Laporan tes dihasilkan otomatis dari file hasil eksekusi (`npm run report:tests`). |

Rekomendasi: bila pemilik ingin memakai Superpowers di mesin lokal, inspeksi repositorinya langsung (lisensi, `hooks/`, skrip instalasi) sebelum memasang.

## 4. Risiko keamanan & keandalan yang teridentifikasi sejak awal

| ID | Risiko | Dampak | Mitigasi (milestone) |
|---|---|---|---|
| R-01 | Aplikasi finansial diekspos ke internet | Akses tidak sah ke riset privat | Auth wajib di semua API (M1); jaringan privat + reverse proxy HTTPS (M8) |
| R-02 | Brute force login | Pengambilalihan akun | Rate limit per IP, penguncian akun, Argon2id (M1) |
| R-03 | Pencurian sesi via XSS | Pembajakan sesi | Cookie HttpOnly, CSP ketat tanpa inline, render DOM tanpa `innerHTML` (M1) |
| R-04 | CSRF | Perubahan pengaturan tanpa izin | SameSite=Strict, cek Origin, token CSRF, JSON-only (M1) |
| R-05 | Lookahead bias pada sinyal/backtest | Hasil riset menyesatkan | Hanya candle tertutup; resolver timeframe hanya memakai candle HTF yang sudah tutup (M3, M6) |
| R-06 | Data candle duplikat / tidak berurutan | Indikator salah | PK kanonik `symbol+timeframe+open_time` sudah di skema (M1); validasi ingesti (M2) |
| R-07 | Rate limit Binance | Ban IP, data bolong | Pembatas laju & backoff, backfill REST (M2) |
| R-08 | Upload screenshot berbahaya | RCE / path traversal | Deteksi tipe file, batas ukuran, nama file acak, penyimpanan terisolasi (M5) |
| R-09 | Eksekusi aturan pola buatan pengguna | Injeksi kode | Evaluator deklaratif, tanpa `eval`/`Function` — ditegakkan Semgrep & ESLint sejak M1 |
| R-10 | Overfitting & klaim profit palsu | Keputusan buruk | Pemisahan train/validasi/out-of-sample, walk-forward (M6); UI tidak menampilkan angka palsu (M1) |
| R-11 | Kehilangan database SQLite | Kehilangan riwayat sinyal | WAL mode (M1); backup & uji restore (M8) |
| R-12 | Dependensi rentan | Supply chain | Versi dipin, `npm audit` (M1); Trivy & SBOM (M7/M8) |

## 5. Temuan selama Milestone 1 (diperbaiki sebelum PR)

| Temuan | Ditemukan oleh | Perbaikan |
|---|---|---|
| Request tanpa sesi ke `PUT /api/settings/scanner` menerima detail validasi skema (400) alih-alih 401 — membocorkan bentuk API. | Tes `NEG-AUTH-003` | Gerbang autentikasi dipindah ke hook `onRequest` (sebelum parsing & validasi). |
| Rate limit global ikut menghitung aset statis; saat batas tercapai `login.js` gagal dimuat dan form login terkirim secara native via **GET — kredensial muncul di URL**. | Tes E2E Playwright | Aset statis dikecualikan dari rate limit; form diberi `method="post"` dan tombol nonaktif sampai JS termuat (`SEC-RL-002`, `SEC-UI-001`). |
| `npm ci` bersih gagal: npm menjalankan `node-gyp rebuild` untuk better-sqlite3 (punya `binding.gyp`) dan unduhan header Node diblokir (403). | Verifikasi instalasi bersih | `.npmrc` `ignore-scripts=true`; binary prebuilt dimuat saat runtime. Juga mengurangi risiko supply chain. |
| Builder DOM menolak opsi `on` karena regex `^on` terlalu luas. | Uji visual Playwright | Regex dipersempit ke `^on.` (atribut event inline tetap dilarang). |
