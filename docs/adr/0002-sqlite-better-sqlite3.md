# ADR-0002 — SQLite via better-sqlite3 dengan repositori async

- Status: Diterima (Milestone 1)

## Konteks
Spesifikasi meminta SQLite untuk MVP dengan rencana migrasi PostgreSQL. Node 22 memiliki `node:sqlite`, tetapi masih berstatus eksperimental.

## Keputusan
- `better-sqlite3` 13 (stabil, prepared statement, transaksi sinkron yang atomik, prebuilt tanpa install script).
- Mode WAL agar API dan worker dapat membaca sambil menulis.
- Semua SQL di `database/repositories/`; method repositori **async** walau driver sinkron, agar pemanggil tidak berubah saat pindah ke `pg`.
- Migrasi SQL bernomor dengan checksum.

## Konsekuensi
+ Constraint (`CHECK`, `STRICT`, PK kanonik candle) menjaga integritas di level database.
− Query berat yang sinkron dapat memblokir event loop; untuk scan besar (M2+) query berat dijalankan di proses worker.
