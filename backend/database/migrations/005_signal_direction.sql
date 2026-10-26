-- 005: arah sinyal (LONG | SHORT) untuk Short Scanner — pola SD (#003) & PVD (#004), state EARLY_BEARISH
-- dan BREAKDOWN. Semua baris lama menjadi LONG. Semua timestamp INTEGER epoch milidetik UTC.
-- Perubahan berikutnya wajib melalui migrasi baru.
--
-- CHECK kolom tidak dapat diubah lewat ALTER TABLE, jadi signals, signal_events, dan analysis_cursors
-- dibangun ulang (buat tabel _v5 → salin → hapus tabel lama → ganti nama). Migrasi berjalan di dalam
-- transaksi dengan foreign_keys = ON (PRAGMA foreign_keys tidak dapat diubah di dalam transaksi), jadi
-- URUTAN penting: DROP TABLE melakukan DELETE implisit yang memicu ON DELETE CASCADE. Event disalin dulu
-- ke signal_events_v5 (merujuk signals_v5) dan signal_events lama dihapus SEBELUM signals lama, sehingga
-- tidak ada event yang ikut terhapus. ALTER TABLE … RENAME memperbarui referensi FOREIGN KEY ke nama
-- baru. id dipertahankan apa adanya (URL/riwayat yang merujuk id sinyal tetap valid).

-- Sinyal: kolom direction + klasifikasi/state SHORT. Klasifikasi dan state wajib sesuai arahnya.
CREATE TABLE signals_v5 (
  id                     INTEGER PRIMARY KEY,
  symbol_id              INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe              TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  direction              TEXT    NOT NULL DEFAULT 'LONG' CHECK (direction IN ('LONG', 'SHORT')),
  pattern_definition_id  INTEGER NOT NULL REFERENCES pattern_definitions(id),
  classification         TEXT    NOT NULL CHECK (classification IN ('SA', 'PVA', 'SD', 'PVD', 'BOTH')),
  state                  TEXT    NOT NULL CHECK (state IN
                         ('NO_PATTERN', 'QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT',
                          'EARLY_BEARISH', 'BREAKDOWN', 'INVALIDATED', 'EXPIRED')),
  first_detected_at      INTEGER NOT NULL,
  first_detected_price   REAL    NOT NULL CHECK (first_detected_price > 0),
  invalidation_price     REAL,
  pattern_score          REAL    CHECK (pattern_score IS NULL OR pattern_score BETWEEN 0 AND 100),
  early_score            REAL    CHECK (early_score IS NULL OR early_score BETWEEN 0 AND 100),
  alignment              TEXT    CHECK (alignment IS NULL OR alignment IN
                         ('ALIGNED', 'PARTIALLY_CONFIRMED', 'UNCONFIRMED', 'COUNTERTREND')),
  risk_flags_json        TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(risk_flags_json)),
  explanation_json       TEXT    CHECK (explanation_json IS NULL OR json_valid(explanation_json)),
  final_outcome          TEXT,
  updated_at             INTEGER NOT NULL,
  closed_at              INTEGER,
  -- LONG: SA/PVA/BOTH tanpa state khusus SHORT; SHORT: SD/PVD/BOTH tanpa state khusus LONG.
  CHECK (
    (direction = 'LONG' AND classification IN ('SA', 'PVA', 'BOTH') AND state NOT IN ('EARLY_BEARISH', 'BREAKDOWN'))
    OR (direction = 'SHORT' AND classification IN ('SD', 'PVD', 'BOTH') AND state NOT IN ('EARLY_BULLISH', 'BREAKOUT'))
  )
) STRICT;

INSERT INTO signals_v5
  (id, symbol_id, timeframe, direction, pattern_definition_id, classification, state, first_detected_at,
   first_detected_price, invalidation_price, pattern_score, early_score, alignment, risk_flags_json,
   explanation_json, final_outcome, updated_at, closed_at)
SELECT id, symbol_id, timeframe, 'LONG', pattern_definition_id, classification, state, first_detected_at,
   first_detected_price, invalidation_price, pattern_score, early_score, alignment, risk_flags_json,
   explanation_json, final_outcome, updated_at, closed_at
FROM signals;

CREATE TABLE signal_events_v5 (
  id            INTEGER PRIMARY KEY,
  signal_id     INTEGER NOT NULL REFERENCES signals_v5(id) ON DELETE CASCADE,
  occurred_at   INTEGER NOT NULL,
  candle_time   INTEGER NOT NULL,
  from_state    TEXT,
  to_state      TEXT    NOT NULL,
  price         REAL,
  detail_json   TEXT    CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

INSERT INTO signal_events_v5 (id, signal_id, occurred_at, candle_time, from_state, to_state, price, detail_json)
SELECT id, signal_id, occurred_at, candle_time, from_state, to_state, price, detail_json
FROM signal_events;

-- Anak dulu, lalu induk (lihat catatan CASCADE di atas). Indeks lama ikut terhapus bersama tabelnya.
DROP TABLE signal_events;
DROP TABLE signals;
ALTER TABLE signals_v5 RENAME TO signals;
ALTER TABLE signal_events_v5 RENAME TO signal_events;

-- Indeks 002 & 004 dibuat ulang dengan nama yang SAMA (signalRepository memakai INDEXED BY untuk riwayat).
CREATE INDEX idx_signals_open ON signals(state, updated_at);
CREATE INDEX idx_signals_symbol_tf ON signals(symbol_id, timeframe, first_detected_at);
CREATE INDEX idx_signals_first_detected ON signals(first_detected_at);
CREATE INDEX idx_signals_symbol_first_detected ON signals(symbol_id, first_detected_at);
CREATE INDEX idx_signal_events_signal ON signal_events(signal_id, occurred_at);

-- Paling banyak SATU sinyal terbuka per simbol × timeframe × arah (closed_at NULL ⇔ state non-terminal).
-- Repositori sudah menolaknya (OPEN_SIGNAL_EXISTS); indeks ini penjaga terakhir di level database.
-- LONG dan SHORT pada seri yang sama boleh terbuka bersamaan (dua kandidat riset yang berbeda).
CREATE UNIQUE INDEX idx_signals_one_open ON signals(symbol_id, timeframe, direction) WHERE closed_at IS NULL;

-- Kursor analisis per simbol × timeframe × ARAH: pipeline menyimpan & memajukan kursor tiap arah secara
-- terpisah (save() / markEvaluated() per arah), sehingga crash di antara simpan LONG dan SHORT tidak
-- membuat satu arah melompati candle. Kursor lama menjadi kursor LONG; arah SHORT belum punya kursor
-- sehingga evaluasi pertamanya setelah upgrade hanya memakai candle terakhir (bootstrap, tanpa replay).
CREATE TABLE analysis_cursors_v5 (
  symbol_id       INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe       TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  direction       TEXT    NOT NULL DEFAULT 'LONG' CHECK (direction IN ('LONG', 'SHORT')),
  last_open_time  INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (symbol_id, timeframe, direction)
) STRICT, WITHOUT ROWID;

INSERT INTO analysis_cursors_v5 (symbol_id, timeframe, direction, last_open_time, updated_at)
SELECT symbol_id, timeframe, 'LONG', last_open_time, updated_at
FROM analysis_cursors;

DROP TABLE analysis_cursors;
ALTER TABLE analysis_cursors_v5 RENAME TO analysis_cursors;
