# 04 — Design System

Arah visual (sejak 2026-11-15): **Konsol Grafit**. AlphaLens adalah permukaan kerja: dasar grafit matte, panel
dipisah seam 1px, satu langkah elevasi, dan **warna hanya untuk status**. Tanpa kaca, glow, neon, atau gradien
dekoratif. Dunia ini menggantikan "Neural Aurora" (kaca gelap, gradien cyan → violet, glow) atas permintaan pemilik:
"gelap yang elegan — matte dan tenang, tanpa neon, glow, kaca, dan gradien", dengan animasi yang bergerak
(lihat `.impeccable/surfaces/` untuk kontrak arahnya dan `PRODUCT.md` untuk kebenaran produk).

Referensi hidup: layar **Design System** di aplikasi (`#/design-system`).

## 1. Struktur file

| File | Isi |
|---|---|
| `css/tokens.css` | Satu-satunya sumber nilai visual (warna, tipografi, spasi, radius, elevasi, gerak, layout) |
| `css/base.css` | `@font-face`, reset, tipografi dasar, fokus, seleksi teks, caret, scrollbar, keyframes umum |
| `css/layout.css` | Kerangka aplikasi: rail navigasi, topbar (garis sync), area konten, responsif |
| `css/components.css` | Komponen: panel, stat, tombol, badge, tahap sinyal, status, skor, form, tabel, empty state, timeline, callout, toast, kontrol scanner, pipeline sync, grafik |
| `css/login.css` | Halaman login (kartu konsol + pipeline status login) |
| `css/landing.css` | Halaman awal publik (`landing.html`, disajikan di `/` tanpa sesi) |
| `css/neural.css` | Latar animasi (canvas rasi grafit) |
| `css/overview.css`, `scanner.css`, `reversal.css`, `symbol.css`, `smartmoney.css` | Gaya per layar |
| `js/lib/components.js` | Pembuat komponen di JavaScript (aman XSS) |

Aturan: komponen hanya merujuk variabel `--lr-*`. Tidak ada warna heksadesimal di luar `tokens.css` kecuali atribusi
TradingView (disalin apa adanya, syarat lisensi) dan logo SVG. Token lama untuk kaca/glow/gradien
(`--lr-glass*`, `--lr-blur*`, `--lr-glow-*`, `--lr-gradient-*`) **dipertahankan namanya tetapi dibuat datar**, agar
CSS lama yang masih merujuknya ikut rata; jangan dipakai untuk komponen baru.

## 2. Warna & kontras

Kontras dihitung dengan rumus luminans relatif WCAG 2.x.

| Token | Nilai | vs `--lr-bg` #141517 | vs `--lr-surface` #1a1c1f | vs `--lr-surface-2` #212328 |
|---|---|---|---|---|
| `--lr-text` | `#e4e6e9` | 14.61 | 13.66 | 12.57 |
| `--lr-text-2` | `#a8adb5` | 8.10 | 7.57 | 6.97 |
| `--lr-text-3` | `#8d929b` | 5.84 | 5.46 | 5.03 |
| `--lr-bull` | `#74cf91` | 9.64 | 9.01 | 8.29 |
| `--lr-warn` | `#e8b85a` | 9.95 | 9.30 | 8.56 |
| `--lr-bear` | `#f0837d` | 7.18 | 6.71 | 6.17 |
| `--lr-accent` | `#74b9ff` | 8.81 | 8.23 | 7.58 |
| `--lr-violet` | `#c69cf0` | 8.19 | 7.66 | 7.05 |
| `--lr-stage-breakout` | `#a3e8b9` | 12.88 | 12.03 | 11.08 |
| `--lr-stage-early-bear` | `#ec9fcf` | 9.07 | 8.48 | 7.81 |
| `--lr-stage-breakdown` | `#f2a46f` | 8.97 | 8.39 | 7.72 |

Semua teks ≥ 4.5:1 (WCAG AA). Tombol utama: teks `--lr-text-inverse` #101113 di atas aksen = 9.11:1.
Batas kontrol form `--lr-border-control` #666c76 = 3.46 / 3.23 / 2.97:1 (WCAG 1.4.11; form berada di permukaan
`--lr-bg`/`--lr-surface`). Seam antarpanel (`--lr-border` #2e3137) dekoratif, bukan batas kontrol.
`prefers-contrast: more` menaikkan teks sekunder/tersier, seam, dan batas kontrol.

### Peran warna

| Makna | Token | Pemakaian |
|---|---|---|
| Aksi utama, fokus, seleksi, info | `--lr-accent` | Satu-satunya isian aksen (tombol utama), cincin fokus, baris terpilih, tahap Early bullish |
| Bullish / LONG / sukses | `--lr-bull` | Badge arah LONG, skor LONG, tahap momentum LONG, status OK, langkah selesai |
| Waspada / basi | `--lr-warn` | Risk flag ringan, data basi, provisional, scanner berhenti |
| Bearish / SHORT / destruktif | `--lr-bear` | Badge arah SHORT, skor SHORT, invalidasi, error, tombol destruktif |
| Metadata | `--lr-violet` | Label model/metadata (bukan arah pasar), EMA25 di grafik |

Warna tidak pernah menjadi satu-satunya pembawa makna: tahap sinyal selalu berlabel teks; QUIET/EXPIRED bertitik
berongga, INVALIDATED dicoret tipis.

### Tahap sinyal (state machine)

| State | Warna | Bentuk |
|---|---|---|
| `QUIET` | teks sekunder | titik berongga |
| `EARLY_BULLISH` / `EARLY_BEARISH` | accent / `#ec9fcf` | titik penuh |
| `MOMENTUM_BUILDING` | bull (SHORT: bear lewat `data-direction="SHORT"`) | titik penuh |
| `BREAKOUT` / `BREAKDOWN` | `#a3e8b9` / `#f2a46f` | titik penuh + cincin tipis yang mengembang, label tebal |
| `INVALIDATED` | bear | label dicoret tipis |
| `EXPIRED` | teks tersier | titik berongga |

## 3. Tipografi

- **Atkinson Hyperlegible Next** untuk UI dan **Atkinson Hyperlegible Mono** untuk setiap angka (tabular, nol
  bergaris). Dipilih karena membedakan karakter yang mudah tertukar (0/O, 1/l/I, 5/S) pada ticker dan angka yang
  dibaca berjam-jam. Self-hosted di `frontend/fonts/` (woff2 variabel 200–800, subset latin & latin-ext, SIL OFL 1.1 —
  lihat `THIRD_PARTY_NOTICES.md`); CSP `font-src 'self'`, tanpa permintaan pihak ketiga.
- Judul panel, header tabel, dan grup navigasi memakai small caps (`font-variant-caps: all-small-caps`), bukan label mono.

| Token | Ukuran | Pemakaian |
|---|---|---|
| `--lr-text-display` | clamp 36–68px | Judul halaman awal saja |
| `--lr-text-2xl` | 24px | Angka KPI (mono) |
| `--lr-text-xl` | 22px | Judul halaman |
| `--lr-text-lg` | 16px | Judul seksi, paragraf utama halaman awal |
| `--lr-text-md` | 14px | Penekanan, judul panel |
| `--lr-text-sm` | 13px | **Teks dasar** (kepadatan terminal) |
| `--lr-text-xs` | 12px | Metadata |
| `--lr-text-2xs` | 11px | Caption |

Format angka `id-ID`, waktu kanonik `YYYY-MM-DD HH:mm:ss UTC`, presisi harga adaptif. Nilai yang belum ada
ditampilkan `—`, tidak pernah `0` palsu.

## 4. Spasi, radius, elevasi

- Spasi basis 4px: `--lr-space-1` (4) … `--lr-space-12` (48).
- Radius kecil dan konsisten: 2 / 4 / 6 / 8px.
- Elevasi: seam 1px + satu langkah permukaan (`--lr-surface` → `--lr-surface-2`); bayangan berpusat ke bawah dengan
  offset dan blur (`--lr-shadow-1..3`) hanya untuk lapisan yang melayang (toast, laci, kartu login). Tidak ada glow.

## 5. Komponen

| Komponen | Kelas | Catatan |
|---|---|---|
| Panel | `.panel`, `__header`, `__title`, `__body`, `__footer` | Permukaan grafit + seam; judul small caps; `--bull/--bear` = penanda kotak nada di depan judul |
| Stat/KPI | `.stat` | Angka mono; `data-tone` = penanda kotak nada di depan label; `--muted` untuk nilai belum ada |
| Tombol | `.btn` + `--primary`, `--ghost`, `--danger`, `--sm`, `--icon`, `--block` | `--primary` = satu-satunya isian aksen; `--danger` bergaris putus-putus sampai disorot/difokus; `aria-disabled="true"` tetap dapat difokus |
| Badge | `.badge` + `--bull/--warn/--bear/--accent/--violet` | Border 1px bernada, tanpa glow |
| Tahap | `.stage[data-stage]`, `[data-direction="SHORT"]` | Lihat §2 |
| Status | `.status[data-state]` | `ok/warn/error/idle`; `data-live` = cincin yang mengembang |
| Skor | `.score[data-tone]` | Angka mono + meter datar 0–100 (kecocokan aturan, bukan probabilitas) |
| Form | `.field`, `.input`, `.select`, `.segmented`, `.switch` | Batas `--lr-border-control`; fokus = border aksen + cincin lembut |
| Tabel | `.table` dalam `.table-wrap` | Header sticky opak small caps; sortable via `<button>` + `aria-sort`; baris 32px; terpilih = latar aksen tipis + penanda 1px |
| Callout | `.callout` + `--warn/--bear/--bull` | Latar bernada tipis + border 1px bernada (tanpa garis tepi samping tebal) |
| Empty state | `.empty` | Ikon dalam bingkai putus-putus; selalu menjelaskan *mengapa* kosong |
| Kontrol scanner | `.worker-control`, `.worker-bar` | Konfirmasi hentikan inline bergaris putus-putus bernada bear; state `aria-live="polite"` |
| Pipeline sync | `.sync-steps`, `.sync-step[data-state]` | Gerak khas: selesai bercentang, aktif bercincin berputar, live berdenyut, berikutnya kosong |

## 6. Aksesibilitas

- Skip link, landmark `nav`/`main`/`header`, `aria-current="page"` pada navigasi.
- Fokus terlihat (`--lr-focus-ring`): celah `--lr-bg` + cincin aksen solid, ≥ 6.8:1 terhadap semua permukaan
  (dihitung tes `UNIT-A11Y-001`). Mode `forced-colors` memakai `outline: 2px solid Highlight`.
- Header tabel sortable adalah tombol yang dapat dioperasikan keyboard, dengan `aria-sort`.
- Toast memakai `role="status"`; error login `role="alert"`.
- Responsif: rail menjadi laci di ≤ 820px; tanpa scroll horizontal halaman di 390px (tes `E2E-UI-002`, `E2E-NEU-009`,
  `E2E-LP-001`).

## 7. Gerak

Gerak menyampaikan perubahan status, bukan dekorasi. Semua mati atau statis pada `prefers-reduced-motion` dan saat
"Animasi latar" dimatikan (`data-motion="off"` pada `<html>`).

| Gerak | Kapan | Catatan |
|---|---|---|
| Garis sync topbar | Hanya saat kontrol scanner di layar membaca status "berjalan" | Satu-satunya garis yang bergerak; direset setiap pindah layar |
| Pipeline langkah | Proses sync scanner (System Health, kontrol ringkas) | Cincin aktif berputar, live berdenyut |
| Baris baru meluncur masuk | Render pertama tabel | Sekali, stagger dibatasi 16 baris |
| Sorotan diff | Kandidat baru / skor berubah antarpolling (data nyata) | 1.4 detik |
| Panel grafik membuka | Memilih baris kandidat | Satu sumbu (x) |
| Meter & angka | Skor/KPI dari API | Isi ke nilai NYATA; count-up berakhir persis di nilai |
| Latar animasi | Canvas rasi grafit (`flat: true`), opasitas 0,55 | Pulsa saat sinyal nyata datang; tombol "Animasi latar" mematikannya |
| Halaman awal | Strip "Proses sync scanner" + penanda jalur tahap | **Ilustrasi**, berlabel "bukan data langsung" |

Angka tidak pernah dianimasikan menuju nilai rekaan.

## 8. Halaman awal & login

- `/` tanpa sesi menyajikan `landing.html`: pintu depan privat (noindex, tanpa pendaftaran publik) yang menjelaskan
  AlphaLens, modulnya, cara kerja (jalur tahap LONG/SHORT), dan batasannya, dengan tombol **Masuk** ke `/login.html`.
  Tautan Masuk membawa hash-route yang diminta (mis. `/#/settings`); setelah login pengguna kembali ke layar itu.
- `login.html`: satu kartu konsol; pipeline tiga langkah (Kredensial → Sesi server → Terminal) mencerminkan status
  permintaan login yang nyata (`is-busy` / `is-error` / `is-success`).
