# ADR-0001 — Modular monolith

- Status: Diterima (Milestone 1)

## Konteks
Dua pengguna privat, target 30–50 pasangan × 3 timeframe. Beban kecil; kompleksitas utama ada pada kebenaran data dan logika pola, bukan skala.

## Keputusan
Satu basis kode Node.js dengan modul berbatas jelas (`auth`, `api`, `database`, lalu `ingestion`, `indicators`, `patterns`, `timeframe`, `scoring`, `signals`, `backtest`). Dua proses runtime: API dan worker scanner (mulai M2), berbagi database SQLite.

## Konsekuensi
+ Deploy & debugging sederhana, tidak ada latensi jaringan antar layanan.
+ Kode indikator/pola dipakai bersama oleh worker live dan backtest.
− SQLite membatasi ke satu host; diterima untuk MVP, jalur ke PostgreSQL disiapkan (ADR-0002).
