-- 008: Reversal Radar (docs/19-kontrak-reversal-radar.md §5) — deteksi dini potensi reversal bullish di LONG Scanner.
-- Mesin TERPISAH dari signals/signal_events (SA/PVA & SD/PVD tidak disentuh): tabel sendiri, kursor sendiri.
-- Semua timestamp INTEGER epoch milidetik UTC. Perubahan berikutnya wajib melalui migrasi baru.
-- Skor adalah skor aturan yang dapat dijelaskan (0..100), BUKAN probabilitas keberhasilan.

-- Kandidat reversal per simbol × timeframe. Satu baris per kandidat: dibuka saat event OPENED, ditutup
-- (closed_at + close_reason) saat CANCELLED/EXPIRED; kandidat berikutnya = baris BARU. snapshot_json = ReversalSnapshot
-- (§4) lengkap agar state machine dapat dilanjutkan setelah restart; kolom lain = salinan untuk filter/urutan/indeks.
CREATE TABLE reversal_candidates (
  id                    INTEGER PRIMARY KEY,
  symbol_id             INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe             TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  version               INTEGER NOT NULL CHECK (version >= 1),
  stage                 TEXT    NOT NULL CHECK (stage IN ('EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT')),
  status                TEXT    NOT NULL CHECK (status IN ('NEW', 'DEVELOPING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  setup_type            TEXT    CHECK (setup_type IS NULL OR setup_type IN
                        ('ROUNDED_BOTTOM', 'DOUBLE_BOTTOM', 'HIGHER_LOW_BASE', 'STAIRCASE', 'SPRING', 'DIVERGENCE_BOTTOM', 'COMPRESSION')),
  score                 REAL    NOT NULL CHECK (score BETWEEN 0 AND 100),
  first_detected_at     INTEGER NOT NULL,
  first_detected_price  REAL    NOT NULL CHECK (first_detected_price > 0),
  first_detected_atr    REAL    CHECK (first_detected_atr IS NULL OR first_detected_atr >= 0),
  stage_entered_at      INTEGER NOT NULL,
  last_candle_time      INTEGER NOT NULL,
  last_evaluated_at     INTEGER NOT NULL,
  invalidation_price    REAL    CHECK (invalidation_price IS NULL OR invalidation_price > 0),
  trigger_price         REAL    CHECK (trigger_price IS NULL OR trigger_price > 0),
  extended              INTEGER NOT NULL DEFAULT 0 CHECK (extended IN (0, 1)),
  liquidity_class       TEXT    CHECK (liquidity_class IS NULL OR liquidity_class IN ('LIQUID', 'THIN', 'ILLIQUID', 'UNKNOWN')),
  snapshot_json         TEXT    NOT NULL CHECK (json_valid(snapshot_json)),
  close_reason          TEXT    CHECK (close_reason IS NULL OR close_reason IN
                        ('CLOSE_BELOW_INVALIDATION', 'BREAKOUT_FAILED', 'NO_PROGRESS', 'EVIDENCE_FADED', 'SYMBOL_DELISTED', 'MONITORING_STOPPED')),
  closed_at             INTEGER,
  updated_at            INTEGER NOT NULL,
  -- Status terminal ⇔ closed_at terisi (keduanya selalu ditulis bersama oleh repositori).
  CHECK ((closed_at IS NULL) = (status NOT IN ('CANCELLED', 'EXPIRED')))
) STRICT;

-- Paling banyak SATU kandidat terbuka per simbol × timeframe. Repositori sudah menolaknya (OPEN_CANDIDATE_EXISTS);
-- indeks ini penjaga terakhir di level database.
CREATE UNIQUE INDEX idx_reversal_one_open ON reversal_candidates(symbol_id, timeframe) WHERE closed_at IS NULL;
-- Riwayat terbaru dulu (ORDER BY first_detected_at DESC, id DESC) tanpa SCAN penuh + sort sementara.
CREATE INDEX idx_reversal_first_detected ON reversal_candidates(first_detected_at);
-- Riwayat per simbol dengan urutan yang sama.
CREATE INDEX idx_reversal_symbol_first ON reversal_candidates(symbol_id, first_detected_at);

-- Event kandidat: OPENED / STAGE_UP / CANCELLED / EXPIRED dari candle TERTUTUP (provisional = 0), dan PROVISIONAL_STAGE
-- dari candle berjalan (provisional = 1; hanya saat tahap provisional berubah — anti-spam). Event provisional tidak
-- pernah membuka/menutup kandidat. candle_time = openTime candle, occurred_at = closeTime candle (closed) / jam saat
-- evaluasi (provisional). detail_json = { reason, score, evidence, levels, … } saat event.
CREATE TABLE reversal_events (
  id            INTEGER PRIMARY KEY,
  candidate_id  INTEGER NOT NULL REFERENCES reversal_candidates(id) ON DELETE CASCADE,
  occurred_at   INTEGER NOT NULL,
  candle_time   INTEGER NOT NULL,
  type          TEXT    NOT NULL CHECK (type IN ('OPENED', 'STAGE_UP', 'CANCELLED', 'EXPIRED', 'PROVISIONAL_STAGE')),
  from_stage    TEXT    CHECK (from_stage IS NULL OR from_stage IN ('EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT')),
  to_stage      TEXT    CHECK (to_stage IS NULL OR to_stage IN ('EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT')),
  from_status   TEXT    CHECK (from_status IS NULL OR from_status IN ('NONE', 'NEW', 'DEVELOPING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  to_status     TEXT    CHECK (to_status IS NULL OR to_status IN ('NONE', 'NEW', 'DEVELOPING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  price         REAL    CHECK (price IS NULL OR price > 0),
  provisional   INTEGER NOT NULL DEFAULT 0 CHECK (provisional IN (0, 1)),
  detail_json   TEXT    CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE INDEX idx_reversal_events_candidate ON reversal_events(candidate_id, candle_time);

-- Kursor pipeline reversal per simbol × timeframe: openTime candle dasar terakhir yang SUDAH dievaluasi (termasuk
-- candle tanpa kandidat/event). Setelah restart pipeline hanya mengevaluasi candle dengan open_time > last_open_time.
-- Hanya maju (repositori menolak mundur). Terpisah dari analysis_cursors (pipeline SA/PVA) agar kedua pipeline
-- tidak saling melompati candle.
CREATE TABLE reversal_cursors (
  symbol_id       INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe       TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  last_open_time  INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (symbol_id, timeframe)
) STRICT, WITHOUT ROWID;

-- Evaluasi provisional (candle BERJALAN) terakhir per simbol × timeframe: satu baris, selalu berlabel provisional,
-- disimpan TERPISAH dari kandidat agar tidak pernah membuka/menutup kandidat maupun memajukan kursor.
-- snapshot_json = ReversalEvaluation (§3) dengan provisional: true. Dihapus (clearProvisional) saat candle tutup.
CREATE TABLE reversal_provisional (
  symbol_id         INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe         TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  candle_open_time  INTEGER NOT NULL,
  evaluated_at      INTEGER NOT NULL,
  stage             TEXT    CHECK (stage IS NULL OR stage IN ('EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT')),
  score             REAL    CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  snapshot_json     TEXT    NOT NULL CHECK (json_valid(snapshot_json)),
  PRIMARY KEY (symbol_id, timeframe)
) STRICT, WITHOUT ROWID;
