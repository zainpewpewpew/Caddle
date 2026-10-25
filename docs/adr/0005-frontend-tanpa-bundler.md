# ADR-0005 — Frontend Vanilla JS tanpa bundler

- Status: Diterima (Milestone 1)

## Keputusan
ES Modules native dimuat langsung (`<script type="module">`). Tidak ada langkah build. Render DOM lewat helper `h()` yang hanya memakai `textContent`/`setAttribute`; `innerHTML` dilarang lint. CSP `script-src 'self'; style-src 'self'` tanpa `unsafe-inline`.

## Konsekuensi
+ Tidak ada supply chain build tool; kode yang dijalankan browser = kode di repositori.
+ CSP ketat dapat diterapkan sejak awal.
− Tidak ada minifikasi/tree-shaking; ukuran aset kecil (<100 KB) sehingga dapat diterima. HTTP/2 di reverse proxy (M8) mengurangi biaya banyak file kecil.
