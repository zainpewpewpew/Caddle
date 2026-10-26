import { createAnalysisPipeline, patternDefinitions } from '../../backend/analysis/pipeline.js';
import { TIMEFRAME_MS } from '../../backend/market/contracts.js';
import { silentAccumulationCandles } from '../fixtures/candles/scenarios.js';

// Mengisi database dengan sinyal hasil pipeline ASLI atas candle SINTETIS (bukan data pasar nyata).
export const SEED_SYMBOL = 'SYNUSDT';
const NOW = Date.UTC(2027, 0, 1);

/**
 * @param {{ symbol?: string, seed?: number, timeframe?: '5m'|'15m' }} [options] timeframe '15m' = candle sintetis yang
 *   sama dengan waktu diregangkan ke interval 15m (LONG Scanner produksi hanya 15m); bentuk harga/volume identik.
 */
export async function seedSignals(repos, { symbol = SEED_SYMBOL, seed = 1, timeframe = '5m' } = {}) {
  await repos.symbols.upsertFromExchange([{
    symbol, baseAsset: symbol.replace(/USDT$/, ''), quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
    tickSize: '0.0001', stepSize: '1', onboardDate: 0,
  }], NOW);
  const pipeline = createAnalysisPipeline({ repos, signals: repos.signals });
  const raw = silentAccumulationCandles(seed);
  const ms = TIMEFRAME_MS[timeframe];
  const start = Math.floor(raw[0].openTime / ms) * ms;
  const candles = raw.map((c, i) => (timeframe === '5m' ? { ...c, symbol }
    : { ...c, symbol, timeframe, openTime: start + i * ms, closeTime: start + (i + 1) * ms - 1 }));
  for (const candle of candles) {
    await repos.candles.upsertClosed([candle], { now: NOW });
    await pipeline.onClosedCandles({ symbol, timeframe });
  }
  return { candles };
}

/** Heartbeat worker terakhir berstatus 'stopped' + satu error ingesti (sintetis) untuk layar System Health. */
export async function seedWorkerHistory(repos, { at = Date.now() } = {}) {
  await repos.ingestion.heartbeat({ at, state: { state: 'stopped', symbols: 1, streams: 3, staleStreams: 0, lastIngestionAt: at - 60_000,
    candleLagMs: null, scanDurationMs: 850, queue: 0, reconnects: 0, errors: 1, ws: 'stopped', gaps: 0, duplicates: 0 } });
  await repos.ingestion.recordError({ at: at - 30_000, source: 'ws', message: 'contoh error uji E2E (sintetis)' });
}


// Matriks sinyal SINTETIS (bukan data pasar nyata) untuk uji filter & urutan API sinyal. Disimpan langsung
// lewat repos.signals.save dengan definisi pola asli pipeline, sehingga setiap kombinasi skor, state,
// klasifikasi, alignment, dan timeframe dapat dikendalikan. Setiap sinyal menempuh rantai event berurutan
// (QUIET → … → state target), persis seperti yang dipersistensi state machine. Tanpa candle → lastPrice null.
const PATTERN_RANK = ['QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT'];
const MATRIX_T0 = Date.UTC(2027, 0, 2);
const MS_5M = 5 * 60_000;

export const SIGNAL_MATRIX = Object.freeze([
  // symbol,  timeframe, classification, state,               patternScore, earlyScore, alignment,             urutan update
  { symbol: 'AAAUSDT', timeframe: '5m', classification: 'SA', state: 'EARLY_BULLISH', patternScore: 90, earlyScore: 40, alignment: 'ALIGNED', tick: 1 },
  { symbol: 'BBBUSDT', timeframe: '15m', classification: 'PVA', state: 'QUIET', patternScore: 60, earlyScore: 80, alignment: 'COUNTERTREND', tick: 2 },
  { symbol: 'CCCUSDT', timeframe: '1h', classification: 'BOTH', state: 'MOMENTUM_BUILDING', patternScore: 75, earlyScore: 55, alignment: 'PARTIALLY_CONFIRMED', tick: 3 },
  // Skor sama dengan CCC tetapi diperbarui lebih baru → harus tampil sebelum CCC (urutan updated_at DESC).
  { symbol: 'DDDUSDT', timeframe: '5m', classification: 'PVA', state: 'BREAKOUT', patternScore: 75, earlyScore: 20, alignment: 'UNCONFIRMED', tick: 4 },
  // Alignment tidak diketahui (konteks HTF belum tersedia) → null, tidak pernah dikarang.
  { symbol: 'EEEUSDT', timeframe: '5m', classification: 'SA', state: 'QUIET', patternScore: 45, earlyScore: 30, alignment: null, tick: 5 },
  // ALIGNED dengan patternScore terendah tetapi earlyScore tertinggi (kasus pemotongan top-N U15).
  { symbol: 'GGGUSDT', timeframe: '15m', classification: 'SA', state: 'EARLY_BULLISH', patternScore: 50, earlyScore: 95, alignment: 'ALIGNED', tick: 6 },
  // Sinyal tertutup (terminal) dengan skor tertinggi: tidak boleh muncul di daftar aktif, tetap ada di riwayat.
  { symbol: 'FFFUSDT', timeframe: '5m', classification: 'SA', state: 'INVALIDATED', patternScore: 99, earlyScore: 90, alignment: 'ALIGNED', tick: 7 },
]);

function stateChain(target) {
  if (target === 'INVALIDATED') return ['QUIET', 'INVALIDATED'];
  return PATTERN_RANK.slice(0, PATTERN_RANK.indexOf(target) + 1);
}

export async function seedSignalMatrix(repos, { rows = SIGNAL_MATRIX } = {}) {
  await repos.symbols.upsertFromExchange(rows.map(({ symbol }) => ({
    symbol, baseAsset: symbol.replace(/USDT$/, ''), quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
    tickSize: '0.0001', stepSize: '1', onboardDate: 0,
  })), NOW);
  const pipeline = createAnalysisPipeline({ repos, signals: repos.signals });
  await pipeline.ensureDefinitions();
  const versions = Object.fromEntries(patternDefinitions().map((d) => [d.key, d.version]));

  for (const row of rows) {
    const patternKey = row.classification === 'PVA' ? 'PVA' : 'SA';
    const firstDetectedAt = MATRIX_T0 + row.tick * 60 * MS_5M;
    let fromState = 'NO_PATTERN';
    const chain = stateChain(row.state);
    for (const [i, state] of chain.entries()) {
      const candleTime = firstDetectedAt + i * MS_5M;
      const price = 10 + i * 0.1;
      const snapshot = {
        state, classification: row.classification, patternKey, patternVersion: versions[patternKey],
        firstDetectedAt, firstDetectedPrice: 10, invalidationPrice: 9.5,
        patternScore: row.patternScore, earlyScore: row.earlyScore, alignment: row.alignment, riskFlags: [],
        lastCandleTime: candleTime, lastEvaluatedAt: candleTime + MS_5M,
        barsInState: 0, peakPrice: price, peakState: state === 'INVALIDATED' ? chain[i - 1] : state,
      };
      const event = { fromState, toState: state, candleTime, occurredAt: candleTime + MS_5M, price, reason: 'SEED_SINTETIS' };
      await repos.signals.save({
        symbol: row.symbol, timeframe: row.timeframe, snapshot, event,
        explanation: [{ factor: 'SEED', detail: 'sinyal sintetis untuk uji API' }],
      });
      fromState = state;
    }
  }
  return { rows };
}
