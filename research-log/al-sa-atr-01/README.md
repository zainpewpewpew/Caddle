# Log audit AL-SA-ATR-01 (append-only)

Log ini memenuhi docs/26 §11.5. Isinya hanya data integritas, tanpa R atau hasil trade.

- `audit-YYYY-MM-DD.json` dan `audit-YYYY-MM-DD.md`: laporan audit bulanan (cutoff = tanggal di nama file).
- `manifest-YYYY-MM-DD.json`: status setiap simbol-bulan (§11.2) dan SHA-256 setiap file cache bulan lengkap.
- Audit ulang pada cutoff yang sama: akhiran `-r2`, `-r3`, dan seterusnya. File yang sudah ada tidak pernah ditimpa.
- `PERUBAHAN.md`: perubahan skrip audit sesudah audit pertama (tanggal, commit, SHA-256, alasan).
- Verifikasi delisting manual (§11.2, simbol yang sudah hilang dari exchangeInfo) dicatat di `delisting-manual.json`.

Setiap audit di-commit dan di-push pada hari yang sama (§11.7).
