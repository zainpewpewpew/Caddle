// Log audit append-only untuk peristiwa keamanan.

/** @param {import('better-sqlite3').Database} db */
export function createAuditRepository(db) {
  const insert = db.prepare(`INSERT INTO audit_logs (occurred_at, user_id, action, outcome, ip_address, detail_json)
                             VALUES (@occurredAt, @userId, @action, @outcome, @ip, @detailJson)`);
  const recent = db.prepare(`SELECT id, occurred_at, user_id, action, outcome, ip_address, detail_json
                             FROM audit_logs ORDER BY id DESC LIMIT ?`);

  return {
    async record({ occurredAt, userId = null, action, outcome, ip = null, detail = null }) {
      insert.run({ occurredAt, userId, action, outcome, ip, detailJson: detail ? JSON.stringify(detail) : null });
    },
    async recent(limit = 50) {
      return recent.all(limit).map((row) => ({ ...row, detail: row.detail_json ? JSON.parse(row.detail_json) : null }));
    },
  };
}
