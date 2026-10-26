import { describe, expect, it } from 'vitest';
import { effectiveMotion } from '../../frontend/js/views/settings.js';
import { parseSymbolQuery, splitPair } from '../../frontend/js/views/symbol.js';
import { MILESTONES, milestoneLabel } from '../../frontend/js/views/roadmap.js';

describe('Symbol Intelligence & tampilan', () => {
  it('UNIT-SYM-001 splitPair memisahkan quote yang dikenal saja', () => {
    expect(splitPair('BTCUSDT')).toEqual(['BTC', 'USDT']);
    expect(splitPair('1000PEPEUSDC')).toEqual(['1000PEPE', 'USDC']);
    expect(splitPair('USDT')).toEqual(['USDT', null]);
    expect(splitPair('BTCETH')).toEqual(['BTCETH', null]);
  });

  it('UNIT-SYM-002 parseSymbolQuery menolak nilai tidak valid', () => {
    const q = parseSymbolQuery(new URLSearchParams('s=btcusdt&tf=4h&dir=UP&signal=abc'));
    expect(q).toEqual({ symbol: 'BTCUSDT', invalidSymbol: false, timeframe: null, direction: null, signalId: null });
    expect(parseSymbolQuery(new URLSearchParams('s=<x>')).invalidSymbol).toBe(true);
  });

  it('UNIT-SYM-003 effectiveMotion: pilihan eksplisit menang, auto mengikuti sistem', () => {
    expect(effectiveMotion('off', false)).toBe('off');
    expect(effectiveMotion('off', true)).toBe('off');
    expect(effectiveMotion('on', true)).toBe('on');
    expect(effectiveMotion('auto', true)).toBe('reduced');
    expect(effectiveMotion('auto', false)).toBe('on');
  });

  it('UNIT-SYM-004 milestone berurutan dengan state yang dikenal', () => {
    MILESTONES.forEach((m, i) => {
      expect(m.n).toBe(i + 1);
      expect(['done', 'active', 'todo']).toContain(m.state);
    });
    expect(milestoneLabel(6)).toBe('Milestone 6 — Backtesting');
  });
});
