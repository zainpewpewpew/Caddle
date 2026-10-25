# 04 — Design System

Arah visual: terminal intelijen trading institusional — latar charcoal hampir hitam, permukaan graphite, garis tipis, aksen emerald untuk bullish, amber untuk kewaspadaan, merah redup untuk risiko. Padat informasi, tenang, tanpa neon, tanpa gradien berat. Terinspirasi kecanggihan visual Saraf, **tanpa menyalin** aset, logo, atau antarmuka proprietary. Logo lensa dan seluruh ikon digambar khusus untuk proyek ini.

Referensi hidup: layar **Design System** di aplikasi (`#/design-system`).

## 1. Struktur file

| File | Isi |
|---|---|
| `css/tokens.css` | Satu-satunya sumber nilai visual (warna, tipografi, spasi, radius, elevasi, gerak, layout) |
| `css/base.css` | Reset, tipografi dasar, fokus, reduced motion, scrollbar |
| `css/layout.css` | Kerangka aplikasi: sidebar, topbar, grid konten, responsif |
| `css/components.css` | Komponen: brand, panel, stat, tombol, badge, tahap sinyal, status, skor, form, tabel, empty state, timeline, callout, toast |
| `css/login.css` | Halaman login |
| `js/lib/components.js` | Pembuat komponen di JavaScript (aman XSS) |

Aturan: komponen hanya merujuk variabel `--lr-*`. Tidak ada warna heksadesimal di luar `tokens.css` kecuali state hover tombol primer.

## 2. Warna & kontras

Kontras dihitung dengan rumus luminans relatif WCAG 2.x.

| Token | Rasio vs `--lr-bg` #080B10 | vs `--lr-surface` #10151D | vs `--lr-surface-2` #171E28 |
|---|---|---|---|
| `--lr-text` `#eaf0f6` | 17.17 | 15.95 | 14.60 |
| `--lr-text-2` `#8b98a8` | 6.71 | 6.24 | 5.71 |
| `--lr-text-3` `#7a8696` | 5.33 | 4.95 | 4.53 |
| `--lr-bull` `#21c58e` | 8.86 | 8.23 | 7.54 |
| `--lr-warn` `#f4b860` | 11.14 | 10.35 | 9.48 |
| `--lr-bear` `#f16b75` | 6.66 | 6.19 | 5.67 |
| `--lr-accent` `#69a8ff` | 8.11 | 7.54 | 6.90 |

Semua kombinasi teks di atas ≥ 4.5:1 (WCAG AA teks normal). `--lr-text-3` awalnya `#6b7787` (4.33:1, gagal AA) dan dinaikkan ke `#7a8696`. Teks gelap di atas tombol primer emerald: 8.86:1.

`prefers-contrast: more` menaikkan teks sekunder/tersier dan border.

### Semantik

| Makna | Token | Pemakaian |
|---|---|---|
| Bullish / sukses | `--lr-bull` (+ `-soft`, `-line`) | Pola SA/PVA, tahap momentum, status OK, tombol primer |
| Waspada | `--lr-warn` | Risk flag ringan, data tertunda, countertrend |
| Risiko / bearish | `--lr-bear` | Invalidasi, error, tombol destruktif |
| Informasi / fokus | `--lr-accent` | Tahap early bullish, fokus, tautan |

Warna tidak pernah menjadi satu-satunya pembawa makna: tahap sinyal selalu disertai label teks.

### Tahap sinyal (state machine)

| State | Warna |
|---|---|
| `QUIET` | teks sekunder |
| `EARLY_BULLISH` | accent |
| `MOMENTUM_BUILDING` | bull |
| `BREAKOUT` | bull terang `#4fe0ae` |
| `INVALIDATED` | bear |
| `EXPIRED` | teks tersier |

## 3. Tipografi

Stack sans: Inter (bila terpasang) → `system-ui`. Stack mono: JetBrains Mono / IBM Plex Mono → `ui-monospace`. Tidak ada font eksternal yang diunduh (privasi & CSP `font-src 'self'`).

| Token | Ukuran | Pemakaian |
|---|---|---|
| `--lr-text-2xl` | 26px | Angka KPI |
| `--lr-text-xl` | 20px | Judul halaman |
| `--lr-text-lg` | 16px | Judul seksi |
| `--lr-text-md` | 14px | Penekanan |
| `--lr-text-sm` | 13px | **Teks dasar** (kepadatan terminal) |
| `--lr-text-xs` | 12px | Metadata |
| `--lr-text-2xs` | 11px | Label tabel uppercase |

Angka finansial memakai `font-variant-numeric: tabular-nums` agar kolom sejajar. Format angka `id-ID`, waktu kanonik `YYYY-MM-DD HH:mm:ss UTC`, presisi harga adaptif (2–8 desimal sesuai besaran). Nilai yang belum ada ditampilkan `—`, tidak pernah `0` palsu.

## 4. Spasi, radius, elevasi, gerak

- Spasi basis 4px: `--lr-space-1` (4) … `--lr-space-12` (48).
- Radius: 3 / 5 / 8 / 12px; pill untuk chip pengguna.
- Elevasi: garis 1px + bayangan halus (`--lr-shadow-1..3`), tanpa glow.
- Gerak: 120/180/280ms dengan easing `cubic-bezier(0.2, 0.7, 0.2, 1)`. Animasi hanya untuk masuk halaman, toast, pulse status live, dan transisi hover. `prefers-reduced-motion: reduce` menonaktifkan semuanya.

## 5. Komponen

| Komponen | Kelas | Catatan |
|---|---|---|
| Panel | `.panel`, `__header`, `__title`, `__body`, `__footer` | Kontainer utama, judul uppercase kecil |
| Stat/KPI | `.stat` | Varian `--muted` untuk nilai belum tersedia |
| Tombol | `.btn` + `--primary`, `--ghost`, `--danger`, `--sm`, `--icon`, `--block` | Tinggi 32px (26px kecil) |
| Badge | `.badge` + `--bull/--warn/--bear/--accent` | Pola & risk flag |
| Tahap | `.stage[data-stage]` | Titik + label |
| Status | `.status[data-state]` | `ok/warn/error/idle`, `data-live` untuk pulse |
| Skor | `.score[data-tone]` | Angka + bar 0–100, tidak diklaim sebagai probabilitas |
| Form | `.field`, `.input`, `.select`, `.segmented`, `.switch` | Error per field `[data-error-for]` |
| Tabel | `.table` dalam `.table-wrap` | Header sticky, sortable via `<button>` + `aria-sort`, baris 34px |
| Empty state | `.empty` | Selalu menjelaskan *mengapa* kosong dan kapan terisi |
| Callout, toast, timeline | `.callout`, `.toast`, `.timeline` | `.callout--action` + `.callout__content`: callout dengan tombol (membungkus di layar sempit). Bila tombol yang ditekan dilepas (mis. scanner berhasil dijalankan), fokus dipindah ke pesan callout (`tabindex="-1"`, `aria-live="polite"`) agar tidak jatuh ke `<body>` |
| Kontrol scanner | `.worker-control`, `__state`, `__desc`, `__confirm` | State dalam wilayah `aria-live="polite"`; konfirmasi stop inline (`role="group"`, fokus ke **Batal**, Esc menutup) |
| Bar progres indeterminate | `.progress-indeterminate` | `role="progressbar"` tanpa nilai (durasi tidak diketahui), label "Memproses perintah scanner". Tampil di kartu Kontrol scanner dan callout Overview selama request start/stop berjalan, state *Memulai…*/*Menghentikan…*, dan 10 detik pemantauan setelah start; hilang saat state final diketahui. `prefers-reduced-motion: reduce` → bar penuh statis tanpa animasi |

## 6. Aksesibilitas

- Skip link ke konten, landmark `nav`/`main`/`header`, `aria-current="page"` pada navigasi.
- Fokus terlihat (`--lr-focus-ring`) untuk semua kontrol interaktif: cincin `--lr-accent` solid dengan celah `--lr-bg`, kontras 8,11:1 terhadap `--lr-bg` dan 7,54:1 terhadap `--lr-surface` (minimum WCAG 3:1; dihitung tes `UNIT-A11Y-001`). Mode `forced-colors` memakai `outline: 2px solid Highlight`.
- Header tabel sortable adalah tombol yang dapat dioperasikan keyboard, dengan `aria-sort`.
- Toast memakai `role="status"` + `aria-live="polite"`; error login `role="alert"`.
- Responsif: sidebar menjadi laci di ≤820px, KPI 2 kolom, tabel scroll horizontal di dalam panel (halaman tidak overflow — diverifikasi tes `E2E-UI-002` di viewport 390px).
