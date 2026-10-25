# ADR-0003 — Sesi server-side, bukan JWT

- Status: Diterima (Milestone 1)

## Keputusan
Token acak 256-bit di cookie `HttpOnly; SameSite=Strict; Path=/` (prefix `__Host-` dan `Secure` saat HTTPS). Database hanya menyimpan hash SHA-256 token. Kedaluwarsa idle (30 menit, sliding) dan absolut (12 jam). Sesi dapat dicabut per perangkat.

## Alasan
- Pencabutan instan (logout, "cabut sesi lain") tanpa daftar hitam token.
- Tidak ada token yang dapat dibaca JavaScript → XSS tidak dapat mencuri sesi.
- Kebocoran database tidak memberikan token sesi yang dapat dipakai.

## Konsekuensi
Setiap request membaca tabel sesi (indeks unik pada hash). `last_seen_at` hanya diperbarui maksimal sekali per menit untuk mengurangi penulisan.
