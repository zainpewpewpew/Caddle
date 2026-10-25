-- 004: kursor analisis per seri (titik awal replay pipeline yang persisten).
-- Semua timestamp INTEGER epoch milidetik UTC. Perubahan berikutnya wajib melalui migrasi baru.

-- openTime candle dasar terakhir yang SUDAH dievaluasi pipeline per simbol × timeframe — termasuk candle
-- tanpa event (NO_PATTERN, snapshot tanpa transisi). Setelah restart pipeline hanya mengevaluasi candle
-- dengan open_time > last_open_time. Hanya maju (repositori menolak mundur).
CREATE TABLE analysis_cursors (
  symbol_id       INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe       TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  last_open_time  INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (symbol_id, timeframe)
) STRICT, WITHOUT ROWID;
