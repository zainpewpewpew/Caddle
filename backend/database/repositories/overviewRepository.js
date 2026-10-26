// Query agregat untuk dashboard. Hanya membaca data nyata dari database.
//
// Arah sinyal (migrasi 005): activeSignals, earlySignals, dan alignedSignals tetap bermakna LONG (kandidat
// LONG aktif, tahap awal = EARLY_BULLISH) sehingga klien lama tidak berubah. Rincian per arah ada di
// activeByDirection / earlyByDirection / alignedByDirection = { LONG, SHORT } (tahap awal SHORT =
// EARLY_BEARISH). recentDetections memuat kedua arah dengan field `direction`.

/** @param {import('better-sqlite3').Database} db */
export function createOverviewRepository(db) {
  const stmt = {
    monitored: db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE is_monitored = 1 AND delisted_at IS NULL'),
    // Satu pemindaian sinyal terbuka untuk semua hitungan; LONG tidak pernah EARLY_BEARISH dan SHORT tidak pernah
    // EARLY_BULLISH (CHECK migrasi 005), jadi "tahap awal" per arah = gabungan keduanya.
    openByDirection: db.prepare(`SELECT direction,
        COUNT(*) AS active,
        SUM(CASE WHEN state IN ('EARLY_BULLISH', 'EARLY_BEARISH') THEN 1 ELSE 0 END) AS early,
        SUM(CASE WHEN alignment = 'ALIGNED' THEN 1 ELSE 0 END) AS aligned
      FROM signals
      WHERE state IN ('QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'EARLY_BEARISH', 'BREAKDOWN')
      GROUP BY direction`),
    recent: db.prepare(`SELECT s.id, sym.symbol, s.timeframe, s.direction, s.classification, s.state, s.first_detected_at
                        FROM signals s JOIN symbols sym ON sym.id = s.symbol_id
                        ORDER BY s.first_detected_at DESC LIMIT 10`),
  };

  return {
    async summary() {
      const counts = { LONG: { active: 0, early: 0, aligned: 0 }, SHORT: { active: 0, early: 0, aligned: 0 } };
      for (const row of stmt.openByDirection.all()) {
        if (Object.hasOwn(counts, row.direction)) counts[row.direction] = { active: row.active, early: row.early, aligned: row.aligned };
      }
      const perDirection = (key) => ({ LONG: counts.LONG[key], SHORT: counts.SHORT[key] });
      return {
        monitoredSymbols: stmt.monitored.get().n,
        activeSignals: counts.LONG.active,
        earlySignals: counts.LONG.early,
        alignedSignals: counts.LONG.aligned,
        activeByDirection: perDirection('active'),
        earlyByDirection: perDirection('early'),
        alignedByDirection: perDirection('aligned'),
        recentDetections: stmt.recent.all(),
      };
    },
  };
}
