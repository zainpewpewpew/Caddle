// Log aktivitas worker scanner — "apa yang sedang dikerjakan" untuk strip status website (frontend/js/views/statusStrip.js)
// dan terminal `npm start`. Cincin ACTIVITY_LIMIT entri terakhir di memori proses worker, disalin ke setiap heartbeat
// (status().activity di worker/scanner.js) lalu disaring server (backend/system/workerStatus.js) sebelum sampai ke UI.
//
// Entri TERSTRUKTUR — { id, at, kind, ...field } — bukan teks bebas: teks dirakit UI (jam WIB) dan terminal, sehingga
// server cukup memeriksa kind & tipe field. Tidak pernah memuat rahasia, path, atau isi respons Binance mentah.
// Aktivitas baru hilang saat worker dijalankan ulang (log ini milik satu proses worker, bukan riwayat permanen).

import { TIMEFRAMES } from '../backend/market/contracts.js';

/** Jumlah entri yang disimpan (dan dikirim di heartbeat). */
export const ACTIVITY_LIMIT = 30;

/**
 * Jenis aktivitas:
 * start      worker mulai (sinkron jam & discovery menyusul)
 * discovery  discovery simbol selesai { cycle, symbols } / gagal { cycle, failed: true }
 * bootstrap  backfill histori candle selesai { series, candles, failed }
 * ws         koneksi WebSocket { state: 'open'|'down', reconnects }
 * scan       scan berkala 1 menit { seq, series, fresh, stale, repaired, priced, durationMs, open }
 * candles    candle tertutup dianalisis (digabung per timeframe × waktu tutup) { timeframe, closeTime, count }
 * signal     sinyal SA/PVA/SD/PVD baru / naik tahap { symbol, timeframe, direction, state, tier }
 * reversal   kandidat Reversal Radar dibuka / naik tahap / batal { symbol, timeframe, stage, status }
 * error      galat ingesti tercatat { source, symbol, timeframe, message }
 * stopping   worker diminta berhenti
 */
export const ACTIVITY_KINDS = Object.freeze(['start', 'discovery', 'bootstrap', 'ws', 'scan', 'candles', 'signal', 'reversal', 'error', 'stopping']);

const SYMBOL = /^[A-Z0-9]{2,30}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
const MESSAGE_MAX = 160;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const symbolOrNull = (v) => (typeof v === 'string' && SYMBOL.test(v) ? v : null);
const timeframeOrNull = (v) => (TIMEFRAMES.includes(v) ? v : null);
const codeOrNull = (v) => (typeof v === 'string' && CODE.test(v) ? v : null);

/**
 * @param {{ limit?: number, clock?: () => number, onAdd?: ((entry: object) => void) | null }} [options]
 *   clock: jam host (stempel `at`, dibandingkan UI dengan jam server API); onAdd: dipanggil setelah entri baru / entri
 *   candle yang digabung bertambah (scanner menjadwalkan heartbeat cepat agar UI melihatnya dalam beberapa detik).
 */
export function createActivityFeed({ limit = ACTIVITY_LIMIT, clock = Date.now, onAdd = null } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('limit harus bilangan bulat 1..500');
  const entries = [];
  // Entri `candles` yang masih dapat digabung: `${timeframe}:${closeTime}` → entri (dibuang bersama entrinya).
  const candleEntries = new Map();
  let seq = 0;

  function push(kind, fields) {
    seq += 1;
    const entry = { id: seq, at: clock(), kind, ...fields };
    entries.push(entry);
    while (entries.length > limit) {
      const removed = entries.shift();
      if (removed.kind === 'candles') candleEntries.delete(`${removed.timeframe}:${removed.closeTime}`);
    }
    onAdd?.(entry);
    return entry;
  }

  return {
    start: () => push('start', {}),
    stopping: () => push('stopping', {}),
    discovery: ({ cycle, symbols = null, failed = false }) => push('discovery', {
      cycle: cycle === 'rediscovery' ? 'rediscovery' : 'initial',
      symbols: isNum(symbols) ? symbols : null,
      failed: failed === true,
    }),
    bootstrap: ({ series, candles, failed }) => push('bootstrap', {
      series: isNum(series) ? series : null, candles: isNum(candles) ? candles : null, failed: isNum(failed) ? failed : 0,
    }),
    ws: ({ state, reconnects }) => push('ws', { state: state === 'open' ? 'open' : 'down', reconnects: isNum(reconnects) ? reconnects : 0 }),
    scan: (summary) => push('scan', {
      seq: summary.seq, series: summary.series, fresh: summary.fresh, stale: summary.stale, repaired: summary.repaired,
      priced: summary.priced, durationMs: summary.durationMs,
      open: summary.open && typeof summary.open === 'object' ? { ...summary.open } : null,
    }),
    /** Candle tertutup seri yang dianalisis: digabung per (timeframe, closeTime) menjadi satu entri "n koin". */
    candles({ timeframe, closeTime }) {
      const tf = timeframeOrNull(timeframe);
      if (tf === null || !isNum(closeTime)) return null;
      const key = `${tf}:${closeTime}`;
      const existing = candleEntries.get(key);
      if (existing) {
        existing.count += 1;
        onAdd?.(existing);
        return existing;
      }
      const entry = push('candles', { timeframe: tf, closeTime, count: 1 });
      candleEntries.set(key, entry);
      return entry;
    },
    signal: (alert) => push('signal', {
      symbol: symbolOrNull(alert?.symbol),
      timeframe: timeframeOrNull(alert?.timeframe),
      direction: alert?.direction === 'SHORT' ? 'SHORT' : 'LONG',
      state: codeOrNull(alert?.state),
      tier: ['A', 'B', 'C', 'D'].includes(alert?.view?.confluence?.tier) ? alert.view.confluence.tier : null,
    }),
    reversal: (alert) => push('reversal', {
      symbol: symbolOrNull(alert?.symbol),
      timeframe: timeframeOrNull(alert?.timeframe),
      stage: codeOrNull(alert?.stage),
      status: codeOrNull(alert?.status),
    }),
    error: ({ source, symbol, timeframe, message }) => push('error', {
      source: typeof source === 'string' && /^[a-z][a-z-]{0,29}$/.test(source) ? source : 'scanner',
      symbol: symbolOrNull(symbol),
      timeframe: timeframeOrNull(timeframe),
      message: String(message ?? '').slice(0, MESSAGE_MAX),
    }),
    /** Salinan entri, terlama → terbaru. */
    list: () => entries.map((e) => (e.open ? { ...e, open: { ...e.open } } : { ...e })),
  };
}

/** Feed tanpa efek (default scanner/tes yang tidak memakai log aktivitas). */
export const NOOP_ACTIVITY = Object.freeze({
  start() {}, stopping() {}, discovery() {}, bootstrap() {}, ws() {}, scan() {}, candles() {}, signal() {}, reversal() {}, error() {},
  list: () => [],
});
