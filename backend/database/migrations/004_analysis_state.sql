-- 004: kursor analisis per seri (titik awal replay pipeline yang persisten) dan indeks riwayat sinyal.
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

-- Riwayat sinyal (signalRepository.history) terbaru dulu: ORDER BY first_detected_at DESC, id DESC dilayani
-- indeks (dipindai mundur; id = rowid ikut di akhir indeks) tanpa SCAN penuh + sort sementara.
CREATE INDEX idx_signals_first_detected ON signals(first_detected_at);
-- Riwayat per simbol (semua timeframe) dengan urutan yang sama.
CREATE INDEX idx_signals_symbol_first_detected ON signals(symbol_id, first_detected_at);
