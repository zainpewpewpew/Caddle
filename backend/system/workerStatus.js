// Ringkasan status worker scanner untuk /api/system/status dan /api/overview.
// Sumber tunggal: heartbeat yang ditulis worker ke database (proses terpisah dari API).
// Tidak ada nilai rekaan: bila worker belum pernah berjalan, status 'not_running'.

/** Heartbeat ditulis tiap 30 detik; lebih tua dari ini = worker dianggap tidak aktif. */
export const HEARTBEAT_STALE_MS = 90_000;

const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Kode langkah & siklus progres sync worker (worker/scanner.js status().sync) yang diteruskan apa adanya. */
const SYNC_STEPS = new Set(['idle', 'clock', 'discovery', 'bootstrap', 'live', 'stopping', 'stopped']);
const SYNC_CYCLES = new Set(['initial', 'rediscovery']);

/**
 * Progres sync yang disaring (docs/09-proses-sync.md): hanya kode langkah/siklus yang dikenal, angka lewat
 * numberOrNull, tanpa field lain (owner/pid tidak pernah ikut). Heartbeat tidak hidup → step 'stopped' (heartbeat
 * akhir) atau 'stale' (basi) dan progres siklus null karena tidak lagi berjalan; lastCandleAt/lastAnalysisAt/updatedAt
 * tetap diteruskan sebagai fakta historis. Heartbeat hidup tanpa objek sync (worker versi lama) → null.
 * `progress` = streamsDone/streamsTotal (0..1) hanya selama backfill dengan streamsTotal > 0.
 */
function summarizeSync(raw, { live, phase }) {
  const s = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (live && s === null) return null;
  const current = (key) => (live ? numberOrNull(s[key]) : null);
  const step = !live ? (phase === 'stopped' ? 'stopped' : 'stale') : (SYNC_STEPS.has(s.step) ? s.step : null);
  const streamsTotal = current('streamsTotal');
  const streamsDone = current('streamsDone');
  return {
    step,
    cycle: live && SYNC_CYCLES.has(s.cycle) ? s.cycle : null,
    cycleStartedAt: current('cycleStartedAt'),
    streamsTotal,
    streamsDone,
    streamsFailed: current('streamsFailed'),
    candlesStored: current('candlesStored'),
    symbolsDiscovered: current('symbolsDiscovered'),
    lastCandleAt: numberOrNull(s?.lastCandleAt),
    lastAnalysisAt: numberOrNull(s?.lastAnalysisAt),
    updatedAt: numberOrNull(s?.updatedAt),
    progress: step === 'bootstrap' && streamsTotal > 0 && streamsDone !== null
      ? Math.min(1, Math.max(0, streamsDone / streamsTotal)) : null,
  };
}

/**
 * true bila heartbeat menandakan worker yang masih hidup: fase bukan 'stopped' dan umur ≤ HEARTBEAT_STALE_MS.
 * Dipakai summarizeWorker dan supervisor worker (deteksi worker di luar website).
 * @param {null|{ at: number, state: unknown }} beat
 * @param {number} now
 */
export function isHeartbeatLive(beat, now) {
  if (!beat || typeof beat.at !== 'number' || !Number.isFinite(beat.at)) return false;
  const st = beat.state !== null && typeof beat.state === 'object' ? beat.state : {};
  return st.state !== 'stopped' && Math.max(0, now - beat.at) <= HEARTBEAT_STALE_MS;
}

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
      scanner: { status: 'not_running', heartbeatAt: null, sync: null },
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
      clockOffsetMs: numberOrNull(st.clockOffsetMs),
      // Hanya kode alasan yang dikenal yang diteruskan (mis. OFFSET_OUT_OF_RANGE), bukan teks bebas.
      clockFault: st.clockFault === 'OFFSET_OUT_OF_RANGE' ? st.clockFault : null,
      // Proses sync (langkah + progres backfill) untuk panel "Proses sync scanner"; null bila tidak dilaporkan.
      sync: summarizeSync(st.sync, { live, phase }),
    },
    // Status koneksi WebSocket hanya bermakna selama heartbeat masih segar.
    binance: { status: !live ? 'unknown' : ws === 'open' ? 'ok' : (ws ?? 'unknown'), ws: live ? ws : null },
    ingestion: { lastRun, recentErrors },
  };
}
