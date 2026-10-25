// Ringkasan status worker scanner untuk /api/system/status dan /api/overview.
// Sumber tunggal: heartbeat yang ditulis worker ke database (proses terpisah dari API).
// Tidak ada nilai rekaan: bila worker belum pernah berjalan, status 'not_running'.

/** Heartbeat ditulis tiap 30 detik; lebih tua dari ini = worker dianggap tidak aktif. */
export const HEARTBEAT_STALE_MS = 90_000;

const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param {{ heartbeat: null|{ at: number, state: object }, lastRun: object|null, recentErrors: object[] }|null} ingestion
 *   hasil repos.ingestion.getStatus()
 * @param {number} now
 */
export function summarizeWorker(ingestion, now) {
  const beat = ingestion?.heartbeat ?? null;
  const lastRun = ingestion?.lastRun ?? null;
  const recentErrors = (ingestion?.recentErrors ?? []).slice(0, 5);
  if (!beat) {
    return {
      scanner: { status: 'not_running', heartbeatAt: null },
      binance: { status: 'unknown', ws: null },
      ingestion: { lastRun, recentErrors },
    };
  }

  const st = beat.state !== null && typeof beat.state === 'object' ? beat.state : {};
  const phase = typeof st.state === 'string' ? st.state : 'unknown';
  const ageMs = Math.max(0, now - beat.at);
  const stale = ageMs > HEARTBEAT_STALE_MS;
  let status;
  if (phase === 'stopped') status = 'stopped';
  else if (stale) status = 'stale';
  else if (phase === 'running') status = 'ok';
  else status = phase; // starting | degraded | stopping | unknown

  const ws = typeof st.ws === 'string' ? st.ws : null;
  const live = !stale && phase !== 'stopped';
  return {
    scanner: {
      status,
      phase,
      heartbeatAt: beat.at,
      heartbeatAgeMs: ageMs,
      symbols: numberOrNull(st.symbols),
      streams: numberOrNull(st.streams),
      staleStreams: numberOrNull(st.staleStreams),
      lastIngestionAt: numberOrNull(st.lastIngestionAt),
      candleLagMs: live ? numberOrNull(st.candleLagMs) : null,
      scanDurationMs: numberOrNull(st.scanDurationMs),
      queue: numberOrNull(st.queue),
      reconnects: numberOrNull(st.reconnects),
      errors: numberOrNull(st.errors),
      gaps: numberOrNull(st.gaps),
      duplicates: numberOrNull(st.duplicates),
    },
    // Status koneksi WebSocket hanya bermakna selama heartbeat masih segar.
    binance: { status: !live ? 'unknown' : ws === 'open' ? 'ok' : (ws ?? 'unknown'), ws: live ? ws : null },
    ingestion: { lastRun, recentErrors },
  };
}
