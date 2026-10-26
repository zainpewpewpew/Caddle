-- 006: skor konfluensi v3 (backend/scoring/confluence.js) pada sinyal: skor aturan 0..100, tier keyakinan A..D,
-- dan peluang menang historis hasil kalibrasi backtest out-of-sample (NULL bila belum ada kalibrasi). Semua
-- kolom boleh NULL: sinyal lama (sebelum v3) tidak memiliki nilai ini. ADD COLUMN cukup (tanpa bangun ulang
-- tabel) karena kolom baru tidak mengubah CHECK yang sudah ada.
ALTER TABLE signals ADD COLUMN confluence_score REAL
  CHECK (confluence_score IS NULL OR confluence_score BETWEEN 0 AND 100);
ALTER TABLE signals ADD COLUMN confidence_tier TEXT
  CHECK (confidence_tier IS NULL OR confidence_tier IN ('A', 'B', 'C', 'D'));
ALTER TABLE signals ADD COLUMN win_probability REAL
  CHECK (win_probability IS NULL OR win_probability BETWEEN 0 AND 1);
