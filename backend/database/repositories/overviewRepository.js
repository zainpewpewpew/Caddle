// Query agregat untuk dashboard. Hanya membaca data nyata dari database.

/** @param {import('better-sqlite3').Database} db */
export function createOverviewRepository(db) {
  const stmt = {
    monitored: db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE is_monitored = 1 AND delisted_at IS NULL'),
    active: db.prepare("SELECT COUNT(*) AS n FROM signals WHERE state IN ('QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT')"),
    early: db.prepare("SELECT COUNT(*) AS n FROM signals WHERE state = 'EARLY_BULLISH'"),
    lastCandle: db.prepare('SELECT MAX(ingested_at) AS t FROM candles'),
    recent: db.prepare(`SELECT s.id, sym.symbol, s.timeframe, s.classification, s.state, s.first_detected_at
                        FROM signals s JOIN symbols sym ON sym.id = s.symbol_id
                        ORDER BY s.first_detected_at DESC LIMIT 10`),
  };

  return {
    async summary() {
      return {
        monitoredSymbols: stmt.monitored.get().n,
        activeSignals: stmt.active.get().n,
        earlySignals: stmt.early.get().n,
        lastIngestionAt: stmt.lastCandle.get().t ?? null,
        recentDetections: stmt.recent.all(),
      };
    },
  };
}
