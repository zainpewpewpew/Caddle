-- 002: draf awal entitas domain pasar, pola, sinyal, dan backtest.
-- Tabel ini belum dipakai di Milestone 1; disiapkan agar desain skema dapat direview sejak awal.
-- Perubahan berikutnya wajib melalui migrasi baru, bukan mengedit file ini.

CREATE TABLE symbols (
  id               INTEGER PRIMARY KEY,
  symbol           TEXT    NOT NULL UNIQUE CHECK (symbol GLOB '[A-Z0-9]*'),
  base_asset       TEXT    NOT NULL,
  quote_asset      TEXT    NOT NULL,
  contract_type    TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  tick_size        TEXT,
  step_size        TEXT,
  is_monitored     INTEGER NOT NULL DEFAULT 0 CHECK (is_monitored IN (0, 1)),
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  delisted_at      INTEGER
) STRICT;

-- Identitas kanonik candle: symbol + timeframe + open_time.
CREATE TABLE candles (
  symbol_id      INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe      TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  open_time      INTEGER NOT NULL,
  close_time     INTEGER NOT NULL CHECK (close_time > open_time),
  open           REAL    NOT NULL CHECK (open > 0),
  high           REAL    NOT NULL,
  low            REAL    NOT NULL CHECK (low > 0),
  close          REAL    NOT NULL CHECK (close > 0),
  volume         REAL    NOT NULL CHECK (volume >= 0),
  quote_volume   REAL    NOT NULL CHECK (quote_volume >= 0),
  trade_count    INTEGER NOT NULL CHECK (trade_count >= 0),
  is_closed      INTEGER NOT NULL CHECK (is_closed IN (0, 1)),
  source         TEXT    NOT NULL CHECK (source IN ('rest', 'ws')),
  ingested_at    INTEGER NOT NULL,
  CHECK (high >= low AND high >= open AND high >= close AND low <= open AND low <= close),
  PRIMARY KEY (symbol_id, timeframe, open_time)
) STRICT, WITHOUT ROWID;

CREATE TABLE features (
  symbol_id      INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe      TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  open_time      INTEGER NOT NULL,
  feature_set    TEXT    NOT NULL,
  values_json    TEXT    NOT NULL CHECK (json_valid(values_json)),
  computed_at    INTEGER NOT NULL,
  PRIMARY KEY (symbol_id, timeframe, open_time, feature_set),
  FOREIGN KEY (symbol_id, timeframe, open_time) REFERENCES candles(symbol_id, timeframe, open_time) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE pattern_definitions (
  id               INTEGER PRIMARY KEY,
  pattern_key      TEXT    NOT NULL CHECK (pattern_key GLOB '[A-Z0-9_]*'),
  version          INTEGER NOT NULL CHECK (version >= 1),
  name             TEXT    NOT NULL,
  definition_json  TEXT    NOT NULL CHECK (json_valid(definition_json)),
  status           TEXT    NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'review', 'validated', 'active', 'retired')),
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  activated_at     INTEGER,
  UNIQUE (pattern_key, version)
) STRICT;

CREATE TABLE pattern_examples (
  id                     INTEGER PRIMARY KEY,
  pattern_definition_id  INTEGER NOT NULL REFERENCES pattern_definitions(id) ON DELETE CASCADE,
  label                  TEXT    NOT NULL CHECK (label IN ('positive', 'negative')),
  symbol                 TEXT,
  timeframe              TEXT    CHECK (timeframe IS NULL OR timeframe IN ('5m', '15m', '1h')),
  range_start            INTEGER,
  range_end              INTEGER,
  detection_time         INTEGER,
  image_path             TEXT,
  image_sha256           TEXT,
  annotations_json       TEXT    CHECK (annotations_json IS NULL OR json_valid(annotations_json)),
  notes                  TEXT,
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  CHECK (range_start IS NULL OR range_end IS NULL OR range_end > range_start)
) STRICT;

CREATE TABLE signals (
  id                     INTEGER PRIMARY KEY,
  symbol_id              INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe              TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  pattern_definition_id  INTEGER NOT NULL REFERENCES pattern_definitions(id),
  classification         TEXT    NOT NULL CHECK (classification IN ('SA', 'PVA', 'BOTH')),
  state                  TEXT    NOT NULL CHECK (state IN
                         ('NO_PATTERN', 'QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'INVALIDATED', 'EXPIRED')),
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
  closed_at              INTEGER
) STRICT;

CREATE INDEX idx_signals_open ON signals(state, updated_at);
CREATE INDEX idx_signals_symbol_tf ON signals(symbol_id, timeframe, first_detected_at);

CREATE TABLE signal_events (
  id            INTEGER PRIMARY KEY,
  signal_id     INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  occurred_at   INTEGER NOT NULL,
  candle_time   INTEGER NOT NULL,
  from_state    TEXT,
  to_state      TEXT    NOT NULL,
  price         REAL,
  detail_json   TEXT    CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE INDEX idx_signal_events_signal ON signal_events(signal_id, occurred_at);

CREATE TABLE backtest_runs (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL,
  config_json    TEXT    NOT NULL CHECK (json_valid(config_json)),
  data_split     TEXT    NOT NULL CHECK (data_split IN ('train', 'validation', 'out_of_sample', 'walk_forward')),
  range_start    INTEGER NOT NULL,
  range_end      INTEGER NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  code_version   TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER,
  CHECK (range_end > range_start)
) STRICT;

CREATE TABLE backtest_results (
  id                   INTEGER PRIMARY KEY,
  backtest_run_id      INTEGER NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  symbol               TEXT    NOT NULL,
  timeframe            TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  pattern_key          TEXT    NOT NULL,
  pattern_version      INTEGER NOT NULL,
  detected_at          INTEGER NOT NULL,
  entry_price          REAL    NOT NULL,
  outcome              TEXT    NOT NULL,
  mfe_pct              REAL,
  mae_pct              REAL,
  time_to_breakout_ms  INTEGER,
  market_regime        TEXT,
  detail_json          TEXT    CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE INDEX idx_backtest_results_run ON backtest_results(backtest_run_id, timeframe);
