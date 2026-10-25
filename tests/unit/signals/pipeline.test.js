import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { buildSignalView } from '../../../backend/scoring/index.js';
import { createSignalRepository, deriveMarketInputs, transition } from '../../../backend/signals/index.js';
import { buildTimeframeContext, closedAsOf } from '../../../backend/timeframe/index.js';

// Rangkaian lengkap seperti worker: candle → konteks HTF → signal view → transisi → simpan.
// Data uji deterministik — sintetis, bukan data pasar nyata.
const END = Date.UTC(2026, 0, 5, 10, 0);

function series(timeframe, n, f, end) {
  const ms = TIMEFRAME_MS[timeframe];
  const start = end - n * ms;
  return Array.from({ length: n }, (_, i) => {
    const close = f(i);
    const open = i === 0 ? close : f(i - 1);
    return {
      symbol: 'BTCUSDT', timeframe, openTime: start + i * ms, closeTime: start + (i + 1) * ms - 1,
      open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close,
      volume: 100, quoteVolume: 100 * close, trades: 10, takerBuyVolume: 50, takerBuyQuoteVolume: 50 * close,
      isClosed: true, source: 'rest',
    };
  });
}
const up = (i) => 100 + 0.3 * i + 0.6 * Math.sin((2 * Math.PI * i) / 6);
const down = (i) => 300 - 0.3 * i + 0.6 * Math.sin((2 * Math.PI * i) / 6);
const flat = (i) => 100 + 0.3 * Math.sin((2 * Math.PI * i) / 6);

// PatternResult palsu sesuai kontrak docs/07 §6.
const sa = (o = {}) => ({
  pattern: 'SA', version: 1, detected: true, patternScore: 75, earlyScore: 70,
  conditions: [{ id: 'flat_range', label: 'Rentang sempit', passed: true, value: 0.01, threshold: 0.02, weight: 3 },
    { id: 'volume_rise', label: 'Volume naik', passed: false, value: 1.1, threshold: 1.2, weight: 1 }],
  invalidationPrice: 99, evaluatedAt: 0, riskFlags: [], insufficientData: false, ...o,
});
const pva = () => ({ pattern: 'PVA', version: 1, detected: false, patternScore: 20, earlyScore: 10, conditions: [],
  invalidationPrice: null, evaluatedAt: 0, riskFlags: [], insufficientData: false });

function evaluate(prev, { m5, m15, h1, patterns, liquidity }) {
  const base = m5[m5.length - 1];
  const t = base.closeTime;
  const context = buildTimeframeContext({ baseTimeframe: '5m', evaluationTime: t, candlesByTimeframe: { '5m': m5, '15m': m15, '1h': h1 } });
  const view = buildSignalView({ symbol: 'BTCUSDT', timeframe: '5m', patterns, context, liquidity, dataQuality: { ok: true } });
  const market = deriveMarketInputs(closedAsOf(m5, t));
  return { ...transition(prev, { candle: base, patterns, context, market, view }), view, context };
}

describe('rangkaian sinyal end-to-end (murni + repositori)', () => {
  it('POS-SPL-001 sinyal 5m dibuka walau 1h netral; HTF berbalik bearish → tetap terbuka dengan COUNTERTREND_HTF', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO symbols (symbol, base_asset, quote_asset, contract_type, status, first_seen_at, last_seen_at)
      VALUES ('BTCUSDT', 'BTC', 'USDT', 'PERPETUAL', 'TRADING', 0, 0)`).run();
    const repo = createSignalRepository(db, { clock: () => END });
    await repo.ensurePatternDefinition({ key: 'SA', version: 1, name: 'Silent Accumulation', definition: { window: 48 } });

    const m5 = series('5m', 60, flat, END);
    const first = evaluate(null, {
      m5, m15: series('15m', 60, up, END), h1: series('1h', 60, flat, END),
      patterns: { classification: 'SA', sa: sa(), pva: pva() }, liquidity: { quoteVolume24h: 10_000_000, spreadBps: 3 },
    });
    expect(first.context.alignment).toBe('PARTIALLY_CONFIRMED');
    expect(first.next).toMatchObject({ state: 'EARLY_BULLISH', alignment: 'PARTIALLY_CONFIRMED', riskFlags: ['POOR_LIQUIDITY'], patternScore: 75 });
    expect(first.alert).toBe(true);
    await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: first.next, event: first.event, explanation: first.view.explanation });

    // Candle 5m berikutnya; 15m kini bearish (data 15m baru yang SUDAH tutup).
    const nextEnd = END + TIMEFRAME_MS['5m'];
    const m5b = [...m5, ...series('5m', 1, () => 99.9, nextEnd)];
    const second = evaluate(first.next, {
      m5: m5b, m15: series('15m', 60, down, END), h1: series('1h', 60, flat, END),
      patterns: { classification: 'SA', sa: sa(), pva: pva() }, liquidity: { quoteVolume24h: 90_000_000, spreadBps: 3 },
    });
    expect(second.context.alignment).toBe('COUNTERTREND');
    expect(second.event).toBeNull();
    expect(second.next).toMatchObject({ state: 'EARLY_BULLISH', alignment: 'COUNTERTREND', riskFlags: ['COUNTERTREND_HTF'] });
    await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: second.next, event: second.event, explanation: second.view.explanation });

    const [active] = await repo.listActive({ timeframe: '5m' });
    expect(active).toMatchObject({ state: 'EARLY_BULLISH', alignment: 'COUNTERTREND', riskFlags: ['COUNTERTREND_HTF'], patternScore: 75 });
    expect(active.explanation.find((e) => e.factor === 'PATTERN:SA:flat_range').contribution).toBeCloseTo(75, 9);
    expect(active.explanation.find((e) => e.factor === 'RISK:COUNTERTREND_HTF').detail).toMatch(/15m/);
    db.close();
  });
});
