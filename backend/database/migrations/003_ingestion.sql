-- 003: penyimpanan ingesti Milestone 2 — volume taker pada candle, candle provisional,
-- riwayat run ingesti, log error ingesti, dan heartbeat worker.
-- Semua timestamp INTEGER epoch milidetik UTC. Perubahan berikutnya wajib melalui migrasi baru.

-- Volume taker buy dari kline Binance. Baris lama (sebelum 003) bernilai 0.
ALTER TABLE candles ADD COLUMN taker_buy_volume REAL NOT NULL DEFAULT 0 CHECK (taker_buy_volume >= 0);
ALTER TABLE candles ADD COLUMN taker_buy_quote_volume REAL NOT NULL DEFAULT 0 CHECK (taker_buy_quote_volume >= 0);

-- Kapan simbol mulai dipantau; NULL bila tidak dipantau.
ALTER TABLE symbols ADD COLUMN monitored_since INTEGER;

CREATE INDEX idx_symbols_monitored ON symbols(symbol) WHERE is_monitored = 1 AND delisted_at IS NULL;

-- Candle yang belum tertutup: hanya satu baris terbaru per simbol × timeframe.
-- Tidak pernah dipakai untuk sinyal terkonfirmasi dan tidak pernah masuk tabel candles.
CREATE TABLE provisional_candles (
  symbol_id               INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  timeframe               TEXT    NOT NULL CHECK (timeframe IN ('5m', '15m', '1h')),
  open_time               INTEGER NOT NULL,
  close_time              INTEGER NOT NULL CHECK (close_time > open_time),
  open                    REAL    NOT NULL CHECK (open > 0),
  high                    REAL    NOT NULL,
  low                     REAL    NOT NULL CHECK (low > 0),
  close                   REAL    NOT NULL CHECK (close > 0),
  volume                  REAL    NOT NULL CHECK (volume >= 0),
  quote_volume            REAL    NOT NULL CHECK (quote_volume >= 0),
  trade_count             INTEGER NOT NULL CHECK (trade_count >= 0),
  taker_buy_volume        REAL    NOT NULL CHECK (taker_buy_volume >= 0),
  taker_buy_quote_volume  REAL    NOT NULL CHECK (taker_buy_quote_volume >= 0),
  source                  TEXT    NOT NULL CHECK (source IN ('rest', 'ws')),
  updated_at              INTEGER NOT NULL,
  CHECK (high >= low AND high >= open AND high >= close AND low <= open AND low <= close),
  PRIMARY KEY (symbol_id, timeframe)
) STRICT, WITHOUT ROWID;

-- Riwayat run ingesti (satu baris per siklus scanner/backfill).
CREATE TABLE ingestion_runs (
  id           INTEGER PRIMARY KEY,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER NOT NULL,
  symbols      INTEGER NOT NULL CHECK (symbols >= 0),
  candles      INTEGER NOT NULL CHECK (candles >= 0),
  errors       INTEGER NOT NULL CHECK (errors >= 0),
  CHECK (finished_at >= started_at)
) STRICT;

CREATE INDEX idx_ingestion_runs_started ON ingestion_runs(started_at);

-- Error ingesti terbaru untuk halaman kesehatan. Pesan dipotong ≤ 500 karakter.
CREATE TABLE ingestion_errors (
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL,
  source   TEXT    NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  message  TEXT    NOT NULL CHECK (length(message) <= 500)
) STRICT;

CREATE INDEX idx_ingestion_errors_at ON ingestion_errors(at);

-- Heartbeat worker: tabel singleton (id selalu 1).
CREATE TABLE worker_heartbeat (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  at          INTEGER NOT NULL,
  state_json  TEXT    NOT NULL CHECK (json_valid(state_json))
) STRICT;
