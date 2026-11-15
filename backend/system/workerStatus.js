// Ringkasan status worker scanner untuk /api/system/status dan /api/overview.
// Sumber tunggal: heartbeat yang ditulis worker ke database (proses terpisah dari API).
// Tidak ada nilai rekaan: bila worker belum pernah berjalan, status 'not_running'.
// Scan berkala (scanner.scan) dan log aktivitas (scanner.activity, worker/activity.js) disaring per field: hanya kind,
// kode, simbol, timeframe, dan angka yang dikenal yang diteruskan; teks galat dipotong & dibersihkan karakter kontrol.

import { TIMEFRAMES } from '../market/contracts.js';

/** Heartbeat ditulis tiap 30 detik; lebih tua dari ini = worker dianggap tidak aktif. */
export const HEARTBEAT_STALE_MS = 90_000;
/** Entri log aktivitas maksimum yang diteruskan ke klien (worker menyimpan ACTIVITY_LIMIT = 30). */
export const ACTIVITY_MAX = 30;

const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const countOrNull = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const SYMBOL = /^[A-Z0-9]{2,30}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
const SOURCE = /^[a-z][a-z-]{0,29}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
const symbolOrNull = (v) => (typeof v === 'string' && SYMBOL.test(v) ? v : null);
const timeframeOrNull = (v) => (TIMEFRAMES.includes(v) ? v : null);
const codeOrNull = (v) => (typeof v === 'string' && CODE.test(v) ? v : null);

/** Hitungan sinyal terbuka ringkasan scan { long, short, radar } atau null. */
function summarizeOpen(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  return { long: countOrNull(raw.long), short: countOrNull(raw.short), radar: countOrNull(raw.radar) };
}

/** Ringkasan scan berkala terakhir (worker/scanner.js status().scan) yang disaring, atau null. */
export function summarizeScan(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || countOrNull(raw.seq) === null || numberOrNull(raw.at) === null) return null;
  return {
    seq: raw.seq,
    at: raw.at,
    finishedAt: numberOrNull(raw.finishedAt),
    durationMs: numberOrNull(raw.durationMs),
    symbols: countOrNull(raw.symbols),
    series: countOrNull(raw.series),
    fresh: countOrNull(raw.fresh),
    stale: countOrNull(raw.stale),
    repaired: countOrNull(raw.repaired),
    priced: countOrNull(raw.priced),
    lastPriceAt: numberOrNull(raw.lastPriceAt),
    open: summarizeOpen(raw.open),
    intervalMs: countOrNull(raw.intervalMs),
    nextAt: numberOrNull(raw.nextAt),
  };
}

/** Field per jenis aktivitas (lihat worker/activity.js); entri dengan kind tak dikenal dibuang. */
const ACTIVITY_FIELDS = Object.freeze({
  start: () => ({}),
  stopping: () => ({}),
  discovery: (e) => ({ cycle: e.cycle === 'rediscovery' ? 'rediscovery' : 'initial', symbols: countOrNull(e.symbols), failed: e.failed === true }),
  bootstrap: (e) => ({ series: countOrNull(e.series), candles: countOrNull(e.candles), failed: countOrNull(e.failed) ?? 0 }),
  ws: (e) => ({ state: e.state === 'open' ? 'open' : 'down', reconnects: countOrNull(e.reconnects) ?? 0 }),
  scan: (e) => ({
    seq: countOrNull(e.seq), series: countOrNull(e.series), fresh: countOrNull(e.fresh), stale: countOrNull(e.stale),
    repaired: countOrNull(e.repaired), priced: countOrNull(e.priced), durationMs: numberOrNull(e.durationMs), open: summarizeOpen(e.open),
  }),
  candles: (e) => ({ timeframe: timeframeOrNull(e.timeframe), closeTime: numberOrNull(e.closeTime), count: countOrNull(e.count) }),
  signal: (e) => ({
    symbol: symbolOrNull(e.symbol), timeframe: timeframeOrNull(e.timeframe), direction: e.direction === 'SHORT' ? 'SHORT' : 'LONG',
    state: codeOrNull(e.state), tier: ['A', 'B', 'C', 'D'].includes(e.tier) ? e.tier : null,
  }),
  reversal: (e) => ({ symbol: symbolOrNull(e.symbol), timeframe: timeframeOrNull(e.timeframe), stage: codeOrNull(e.stage), status: codeOrNull(e.status) }),
  error: (e) => ({
    source: typeof e.source === 'string' && SOURCE.test(e.source) ? e.source : 'scanner',
    symbol: symbolOrNull(e.symbol), timeframe: timeframeOrNull(e.timeframe),
    message: typeof e.message === 'string' ? e.message.replace(CONTROL_CHARS, ' ').slice(0, 160) : '',
  }),
});

/** Log aktivitas worker yang disaring: maks ACTIVITY_MAX entri terbaru, urut terlama → terbaru. */
export function summarizeActivity(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw.slice(-ACTIVITY_MAX)) {
    if (e === null || typeof e !== 'object') continue;
    const fields = Object.hasOwn(ACTIVITY_FIELDS, e.kind) ? ACTIVITY_FIELDS[e.kind] : null;
    if (!fields || countOrNull(e.id) === null || numberOrNull(e.at) === null) continue;
    out.push({ id: e.id, at: e.at, kind: e.kind, ...fields(e) });
  }
  return out;
}

/** Kode langkah & siklus progres sync worker (worker/scanner.js status().sync) yang diteruskan apa adanya. */
const SYNC_STEPS = new Set(['idle', 'clock', 'discovery', 'bootstrap', 'live', 'stopping', 'stopped']);
const SYNC_CYCLES = new Set(['initial', 'rediscovery']);

/**
 * Progres sync yang disaring (docs/09-proses-sync.md): hanya kode langkah/siklus yang dikenal, angka lewat
 * numberOrNull, tanpa field lain (owner/pid tidak pernah ikut). Heartbeat tidak hidup → step 'stopped' (heartbeat
 * akhir) atau 'stale' (basi) dan progres siklus null karena tidak lagi berjalan; lastCandleAt/lastAnalysisAt/updatedAt
 * tetap diteruskan sebagai fakta historis. Heartbeat hidup tanpa objek sync (worker versi lama) → null.
 * `progress` = streamsDone/streamsTotal (0..1) hanya selama backfill dengan streamsTotal > 0. `clockSynced` = boolean
 * atau null; melengkapi clockOffsetMs sehingga diteruskan seperti fakta historis (false = offset jam run itu belum
 * pernah terukur: nilai awal serverClock, bukan pengukuran).
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
    clockSynced: typeof s?.clockSynced === 'boolean' ? s.clockSynced : null,
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
      // Scan berkala tiap menit & log aktivitas (strip status): fakta historis tetap diteruskan walau heartbeat basi;
      // jadwal scan berikutnya hanya bermakna selama worker hidup.
      scan: summarizeScan(st.scan),
      scanIntervalMs: countOrNull(st.scanIntervalMs),
      nextScanAt: live ? numberOrNull(st.nextScanAt) : null,
      activity: summarizeActivity(st.activity),
    },
    // Status koneksi WebSocket hanya bermakna selama heartbeat masih segar.
    binance: { status: !live ? 'unknown' : ws === 'open' ? 'ok' : (ws ?? 'unknown'), ws: live ? ws : null },
    ingestion: { lastRun, recentErrors },
  };
}
