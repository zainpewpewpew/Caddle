-- 007: Insider / Smart Money Radar (docs/15-kontrak-smart-money.md). Semua tabel ber-prefix `sm_`.
-- Fitur BACA SAJA: hanya alamat publik — tidak ada kolom untuk seed phrase, private key, atau tanda tangan.
-- Semua timestamp INTEGER epoch milidetik UTC. Identitas token = (chain, alamat kontrak); simbol hanya label.
-- Alamat EVM disimpan huruf kecil (dinormalisasi repositori lewat contracts.js normalizeAddress).
-- Kolom `is_simulated` menandai data fixture/demo agar tidak pernah tampil sebagai data live.
-- Nilai USD boleh NULL (= tidak diketahui); NULL tidak pernah diganti 0.

-- Wallet yang dilacak beserta asal penemuannya.
CREATE TABLE sm_wallets (
  chain             TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  address           TEXT    NOT NULL CHECK (length(address) BETWEEN 32 AND 44),
  first_seen_at     INTEGER NOT NULL,
  last_activity_at  INTEGER,
  discovered_via    TEXT    NOT NULL CHECK (length(discovered_via) BETWEEN 1 AND 64),
  discovery_reason  TEXT,
  is_simulated      INTEGER NOT NULL DEFAULT 0 CHECK (is_simulated IN (0, 1)),
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (chain, address)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_sm_wallets_simulated ON sm_wallets(is_simulated) WHERE is_simulated = 1;

-- Label alamat. Satu alamat boleh memiliki beberapa label dari sumber berbeda; label tanpa sumber ditolak.
CREATE TABLE sm_labels (
  chain       TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  address     TEXT    NOT NULL,
  source      TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  label       TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  category    TEXT    NOT NULL CHECK (category IN ('cex', 'cex_deposit', 'bridge', 'dex_router', 'dex_pool', 'lp_token',
                        'airdrop_distributor', 'mev_bot', 'market_maker', 'fund', 'smart_money', 'contract', 'other')),
  confidence  REAL    NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (chain, address, source, label)
) STRICT, WITHOUT ROWID;

-- Pencarian label per alamat lintas chain (tanpa filter chain, PK tidak terpakai).
CREATE INDEX idx_sm_labels_address ON sm_labels(address);

-- Metadata token (tampilan saja; identitas tetap chain + alamat).
CREATE TABLE sm_tokens (
  chain       TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  address     TEXT    NOT NULL,
  symbol      TEXT,
  name        TEXT,
  decimals    INTEGER CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 255),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (chain, address)
) STRICT, WITHOUT ROWID;

-- Aktivitas hasil klasifikasi (Activity). `id` = kunci dedupe deterministik chain:tx:wallet:token, sehingga
-- transaksi duplikat (batch berulang / provider berbeda) diabaikan INSERT OR IGNORE.
-- `block_number` / `log_index` (classify.js): nomor blok & logIndex on-chain TERKECIL dari kaki-kaki aktivitas;
-- NULL bila tidak diketahui / hanya kaki sintetis (logIndex buatan adapter ≥ SYNTHETIC_LOG_INDEX_MIN).
CREATE TABLE sm_activities (
  id                       TEXT    PRIMARY KEY,
  chain                    TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  tx_hash                  TEXT    NOT NULL,
  block_time               INTEGER NOT NULL,
  block_number             INTEGER CHECK (block_number IS NULL OR block_number >= 0),
  log_index                INTEGER CHECK (log_index IS NULL OR log_index >= 0),
  wallet                   TEXT    NOT NULL,
  token_address            TEXT    NOT NULL,
  token_symbol             TEXT,
  token_name               TEXT,
  token_decimals           INTEGER CHECK (token_decimals IS NULL OR token_decimals BETWEEN 0 AND 255),
  type                     TEXT    NOT NULL CHECK (type IN ('SWAP_BUY', 'SWAP_SELL', 'TRANSFER_IN', 'TRANSFER_OUT',
                             'CEX_WITHDRAWAL', 'CEX_DEPOSIT', 'BRIDGE_IN', 'BRIDGE_OUT', 'AIRDROP', 'MINT', 'BURN',
                             'LP_ADD', 'LP_REMOVE', 'UNKNOWN')),
  direction                TEXT    NOT NULL CHECK (direction IN ('IN', 'OUT')),
  amount                   REAL    NOT NULL CHECK (amount > 0),
  usd_value                REAL    CHECK (usd_value IS NULL OR usd_value >= 0),
  counterparty             TEXT,
  counterparty_label_json  TEXT    CHECK (counterparty_label_json IS NULL OR json_valid(counterparty_label_json)),
  confidence               TEXT    NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  reason                   TEXT    NOT NULL,
  provider                 TEXT    NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  is_simulated             INTEGER NOT NULL DEFAULT 0 CHECK (is_simulated IN (0, 1)),
  ingested_at              INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_sm_activities_wallet_time ON sm_activities(chain, wallet, block_time);
CREATE INDEX idx_sm_activities_token_time ON sm_activities(chain, token_address, block_time);
CREATE INDEX idx_sm_activities_time ON sm_activities(block_time);
-- Indeks parsial "ada data simulasi?" (pita DATA SIMULASI di setiap respons): EXISTS cukup membaca indeks kecil,
-- tidak memindai seluruh tabel ketika tidak ada data simulasi. Pola sama untuk sm_wallets/sm_alerts/sm_evaluations.
CREATE INDEX idx_sm_activities_simulated ON sm_activities(is_simulated) WHERE is_simulated = 1;

-- Skor wallet terakhir (walletScore.js) beserta penjelasan, keterbatasan, flag, dan ringkasan PnL.
CREATE TABLE sm_wallet_scores (
  chain             TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  address           TEXT    NOT NULL,
  computed_at       INTEGER NOT NULL,
  score             REAL    NOT NULL CHECK (score BETWEEN 0 AND 100),
  eligible          INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  style             TEXT    NOT NULL CHECK (style IN ('SCALPER', 'SWING', 'POSITION', 'MIXED', 'UNKNOWN')),
  cluster_id        TEXT,
  components_json   TEXT    NOT NULL CHECK (json_valid(components_json)),
  metrics_json      TEXT    NOT NULL CHECK (json_valid(metrics_json)),
  reasons_json      TEXT    NOT NULL CHECK (json_valid(reasons_json)),
  limitations_json  TEXT    NOT NULL CHECK (json_valid(limitations_json)),
  flags_json        TEXT    NOT NULL CHECK (json_valid(flags_json)),
  pnl_json          TEXT    CHECK (pnl_json IS NULL OR json_valid(pnl_json)),
  PRIMARY KEY (chain, address)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_sm_wallet_scores_rank ON sm_wallet_scores(chain, eligible, score);
CREATE INDEX idx_sm_wallet_scores_cluster ON sm_wallet_scores(chain, cluster_id);

-- Tepi tautan antar-wallet (clusters.js). Pasangan disimpan terurut (a < b) agar tidak tercatat dua kali.
CREATE TABLE sm_wallet_links (
  chain          TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  a              TEXT    NOT NULL,
  b              TEXT    NOT NULL,
  reason_type    TEXT    NOT NULL CHECK (length(reason_type) BETWEEN 1 AND 64),
  evidence_json  TEXT    NOT NULL CHECK (json_valid(evidence_json)),
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (chain, a, b, reason_type),
  CHECK (a < b)
) STRICT, WITHOUT ROWID;

-- Pemetaan token on-chain → pasar Binance. Hanya kecocokan chain + kontrak persis yang ditautkan ke sinyal.
-- Satu kontrak BOLEH memiliki beberapa baris (kontrak bersama beberapa aset Binance, atau beberapa perp ber-prefix
-- seperti PEPEUSDT & 1000PEPEUSDT) → binanceMatch.js menilainya AMBIGUOUS. Kunci (chain, kontrak) saja akan
-- meruntuhkan baris-baris itu menjadi satu dan menghasilkan MATCHED palsu. `provider` = pemilik baris: setiap
-- penyegaran dari satu provider MENGGANTI seluruh barisnya (kontrak yang delisting/migrasi ikut hilang).
CREATE TABLE sm_binance_map (
  id                INTEGER PRIMARY KEY,
  chain             TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  contract_address  TEXT    NOT NULL,
  binance_asset     TEXT    NOT NULL CHECK (length(binance_asset) BETWEEN 1 AND 32),
  spot_symbol       TEXT    CHECK (spot_symbol IS NULL OR spot_symbol GLOB '[A-Z0-9]*'),
  futures_symbol    TEXT    CHECK (futures_symbol IS NULL OR futures_symbol GLOB '[A-Z0-9]*'),
  multiplier        INTEGER NOT NULL DEFAULT 1 CHECK (multiplier >= 1),
  source            TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  provider          TEXT    NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 64),
  verified_at       INTEGER
) STRICT;

CREATE UNIQUE INDEX idx_sm_binance_map_entry
  ON sm_binance_map(chain, contract_address, binance_asset, IFNULL(futures_symbol, ''), multiplier);
CREATE INDEX idx_sm_binance_map_provider ON sm_binance_map(provider);

-- Watchlist per pengguna (wallet atau token). Terhapus bersama penggunanya.
CREATE TABLE sm_watchlist (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('WALLET', 'TOKEN')),
  chain       TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  address     TEXT    NOT NULL,
  note        TEXT    CHECK (note IS NULL OR length(note) <= 200),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, chain, address)
) STRICT, WITHOUT ROWID;

-- Notifikasi bersama (satu baris per kejadian); `dedupe_key` unik mencegah alert ganda dalam satu ember cooldown.
CREATE TABLE sm_alerts (
  id             INTEGER PRIMARY KEY,
  dedupe_key     TEXT    NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  kind           TEXT    NOT NULL CHECK (kind IN ('NEW_BUY', 'REPEAT_ACCUMULATION', 'MULTI_WALLET_BUY', 'LARGE_SELL', 'WALLET_EXIT')),
  severity       TEXT    NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW')),
  chain          TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  token_key      TEXT,
  wallet         TEXT,
  title          TEXT    NOT NULL,
  message        TEXT    NOT NULL,
  evidence_json  TEXT    NOT NULL CHECK (json_valid(evidence_json)),
  created_at     INTEGER NOT NULL,
  -- Waktu peristiwa sumber alert (alerts.js `eventAt`): dasar cooldown sejati & penanda keterlambatan data.
  -- NULL = tidak diketahui (pembaca memakai created_at).
  event_at       INTEGER CHECK (event_at IS NULL OR event_at >= 0),
  is_simulated   INTEGER NOT NULL DEFAULT 0 CHECK (is_simulated IN (0, 1))
) STRICT;

CREATE INDEX idx_sm_alerts_created ON sm_alerts(created_at);
CREATE INDEX idx_sm_alerts_simulated ON sm_alerts(is_simulated) WHERE is_simulated = 1;

-- Status baca alert per pengguna.
CREATE TABLE sm_alert_reads (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_id  INTEGER NOT NULL REFERENCES sm_alerts(id) ON DELETE CASCADE,
  read_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, alert_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_sm_alert_reads_alert ON sm_alert_reads(alert_id);

-- Preferensi filter notifikasi per pengguna (validasi isi di alerts.js validateAlertPrefs).
CREATE TABLE sm_alert_prefs (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs_json  TEXT    NOT NULL CHECK (json_valid(prefs_json)),
  updated_at  INTEGER NOT NULL
) STRICT;

-- Status terakhir setiap provider data (System Health / GET /status). Pesan error tidak pernah memuat kunci API.
CREATE TABLE sm_provider_status (
  provider            TEXT    PRIMARY KEY CHECK (length(provider) BETWEEN 1 AND 64),
  last_attempt_at     INTEGER,
  last_success_at     INTEGER,
  last_error_code     TEXT    CHECK (last_error_code IS NULL OR last_error_code IN ('RATE_LIMITED', 'UNAUTHORIZED',
                        'UNAVAILABLE', 'BAD_RESPONSE', 'TIMEOUT', 'NOT_SUPPORTED', 'NOT_CONFIGURED')),
  last_error_message  TEXT    CHECK (last_error_message IS NULL OR length(last_error_message) <= 500),
  coverage_json       TEXT    CHECK (coverage_json IS NULL OR json_valid(coverage_json)),
  is_simulated        INTEGER NOT NULL DEFAULT 0 CHECK (is_simulated IN (0, 1))
) STRICT, WITHOUT ROWID;

-- Kursor sinkronisasi inkremental per provider × chain × alamat ('' = kursor tingkat chain).
CREATE TABLE sm_sync_cursors (
  provider    TEXT    NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  chain       TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  address     TEXT    NOT NULL DEFAULT '',
  cursor      TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, chain, address)
) STRICT, WITHOUT ROWID;

-- Transfer mentah (RawTransfer ternormalisasi, docs/15 §1) per wallet yang dilacak: dasar klasifikasi ULANG satu tx
-- utuh saat kaki yang terlambat datang (mis. kaki quote-keluar muncul di batch berikutnya → TRANSFER_IN menjadi
-- SWAP_BUY). Kunci menyertakan `wallet`: transfer antara dua wallet yang sama-sama dilacak (L1 → L2) harus tercatat
-- "baru" bagi KEDUA wallet agar masing-masing mengklasifikasi tx tersebut.
CREATE TABLE sm_raw_transfers (
  chain         TEXT    NOT NULL CHECK (chain IN ('ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana')),
  wallet        TEXT    NOT NULL,
  tx_hash       TEXT    NOT NULL,
  log_index     INTEGER NOT NULL CHECK (log_index >= 0),
  block_time    INTEGER NOT NULL,
  payload_json  TEXT    NOT NULL CHECK (json_valid(payload_json)),
  provider      TEXT    NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  is_simulated  INTEGER NOT NULL DEFAULT 0 CHECK (is_simulated IN (0, 1)),
  ingested_at   INTEGER NOT NULL,
  PRIMARY KEY (chain, wallet, tx_hash, log_index)
) STRICT, WITHOUT ROWID;

-- Status layanan sinkronisasi (kunci → JSON): mis. waktu penyegaran mapping Binance terakhir, ringkasan run terakhir.
CREATE TABLE sm_sync_state (
  key         TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value_json  TEXT    NOT NULL CHECK (json_valid(value_json)),
  updated_at  INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- Laporan evaluasi historis tanpa look-ahead (evaluate.js).
CREATE TABLE sm_evaluations (
  id            INTEGER PRIMARY KEY,
  computed_at   INTEGER NOT NULL,
  params_json   TEXT    NOT NULL CHECK (json_valid(params_json)),
  report_json   TEXT    NOT NULL CHECK (json_valid(report_json)),
  is_simulated  INTEGER NOT NULL DEFAULT 0 CHECK (is_simulated IN (0, 1))
) STRICT;

CREATE INDEX idx_sm_evaluations_computed ON sm_evaluations(computed_at);
CREATE INDEX idx_sm_evaluations_simulated ON sm_evaluations(is_simulated) WHERE is_simulated = 1;
