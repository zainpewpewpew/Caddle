-- 001: entitas inti — pengguna, sesi, pengaturan, log audit.
-- Semua timestamp disimpan sebagai INTEGER milidetik epoch UTC.

CREATE TABLE users (
  id                  INTEGER PRIMARY KEY,
  username            TEXT    NOT NULL COLLATE NOCASE UNIQUE
                      CHECK (length(username) BETWEEN 3 AND 32),
  password_hash       TEXT    NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  role                TEXT    NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin', 'analyst')),
  totp_secret         TEXT,
  is_disabled         INTEGER NOT NULL DEFAULT 0 CHECK (is_disabled IN (0, 1)),
  failed_login_count  INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until        INTEGER,
  last_login_at       INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id              INTEGER PRIMARY KEY,
  token_hash      TEXT    NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token      TEXT    NOT NULL,
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  revoke_reason   TEXT
) STRICT;

CREATE INDEX idx_sessions_user_active ON sessions(user_id, revoked_at, expires_at);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE settings (
  key         TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value_json  TEXT    NOT NULL CHECK (json_valid(value_json)),
  version     INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT    NOT NULL,
  outcome     TEXT    NOT NULL CHECK (outcome IN ('success', 'failure')),
  ip_address  TEXT,
  detail_json TEXT    CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE INDEX idx_audit_logs_time ON audit_logs(occurred_at);
CREATE INDEX idx_audit_logs_user_time ON audit_logs(user_id, occurred_at);
