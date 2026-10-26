import { describe, expect, it } from 'vitest';
import { DISCLAIMERS, RELEVANCE_LEVELS } from '../../../backend/smartmoney/contracts.js';
import { matchToken } from '../../../backend/smartmoney/binanceMatch.js';
import { PATTERN_LABELS, linkToScreener, signalPatterns } from '../../../backend/smartmoney/screenerLink.js';

// Baris sinyal SINTETIS berbentuk keluaran signalRepository.listActive (toView) — penjelasan memakai faktor yang
// benar-benar ditulis signalView.js (PATTERN:*, EARLY:*, CONTEXT:*) dan pipeline withConfluence (CONFLUENCE:*).
function signalRow({ symbol, timeframe = '15m', classification = 'SA', state = 'EARLY_BULLISH', tier = 'B', direction = 'LONG', extra = [] }) {
  const pattern = classification === 'PVA' ? 'PVA' : 'SA';
  return {
    id: 1, symbol, timeframe, direction, classification, state,
    patternKey: pattern, patternVersion: 1, firstDetectedAt: Date.UTC(2026, 9, 1), firstDetectedPrice: 0.00001,
    invalidationPrice: 0.0000095, patternScore: 78, earlyScore: 55, alignment: 'ALIGNED', riskFlags: [],
    explanation: [
      { factor: 'PATTERN:SELECTION', contribution: 0, detail: `Pola ${pattern} dipilih` },
      { factor: `PATTERN:${pattern}:rvolLow`, contribution: 25, detail: 'Volume senyap: nilai 0.6 memenuhi ambang 0.8 (bobot 20)' },
      { factor: 'EARLY:SA', contribution: 0, detail: 'Skor dini' },
      { factor: 'CONTEXT:ALIGNMENT', contribution: 0, detail: '15m BULLISH, 1h BULLISH' },
      { factor: 'CONFLUENCE:TIER', contribution: 0, detail: `Konfluensi v1: skor 66 → tier ${tier}` },
      ...extra,
    ],
    peakPrice: null, peakState: state, barsInState: 2, finalOutcome: null, updatedAt: Date.UTC(2026, 9, 1, 1), closedAt: null,
    confluenceScore: 66, confidenceTier: tier, winProbability: null,
  };
}

const PEPE_ADDR = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const FAKE_ADDR = '0x00000000000000000000000000000000000bbbb2';
const ROWS = [{ chain: 'ethereum', contractAddress: PEPE_ADDR, binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT', multiplier: 1000, source: 'manual', verifiedAt: 1 }];
const radarToken = (address, conviction, symbol = 'PEPE') => ({
  tokenKey: `ethereum:${address}`, chain: 'ethereum', token: { address, symbol, name: null, decimals: 18 }, conviction, state: 'ACCUMULATING',
});
const matchesFor = (tokens) => new Map(tokens.map((t) => [t.tokenKey, matchToken({ chain: t.chain, address: t.token.address, symbol: t.token.symbol }, ROWS)]));

describe('linkToScreener', () => {
  it('UNIT-SM-SCR-001 MATCHED + keyakinan ≥ 60 + sinyal LONG tier A/B → TINGGI, pola berlabel Indonesia', () => {
    const t = radarToken(PEPE_ADDR, 72);
    const signals = [
      signalRow({ symbol: '1000PEPEUSDT', timeframe: '1h', classification: 'BOTH', state: 'BREAKOUT', tier: 'A', extra: [
        { factor: 'PATTERN:SA:higherLows', contribution: 20, detail: 'Higher low terkonfirmasi berurutan: nilai 3 memenuhi ambang 2 (bobot 20)' },
        { factor: 'CONFLUENCE:CONFIRM', contribution: 0, detail: 'Rezim SQUEEZE (bandwidth persentil 10%) — volatilitas terkompresi, potensi ekspansi' },
      ] }),
      signalRow({ symbol: '1000PEPEUSDT', timeframe: '5m', classification: 'PVA', tier: 'C' }),
    ];
    const [out] = linkToScreener([t], { matches: matchesFor([t]), activeSignals: signals });
    expect(out.conviction).toBe(72);
    expect(out.binance.status).toBe('MATCHED');
    expect(out.screener.relevance).toBe('TINGGI');
    expect(out.screener.signals.map((s) => s.timeframe)).toEqual(['5m', '1h']);
    const h1 = out.screener.signals[1];
    expect(h1).toMatchObject({ timeframe: '1h', state: 'BREAKOUT', classification: 'BOTH', tier: 'A' });
    expect(h1.patterns).toEqual([PATTERN_LABELS.SA, PATTERN_LABELS.PVA, PATTERN_LABELS.BREAKOUT, PATTERN_LABELS.HIGHER_LOW, PATTERN_LABELS.COMPRESSION]);
    expect(PATTERN_LABELS.SA).toContain('kenaikan perlahan volume rendah');
    expect(PATTERN_LABELS.PVA).toContain('akumulasi volume progresif');
    expect(out.screener.signals[0].patterns).toEqual([PATTERN_LABELS.PVA]);
    expect(out.screener.note).toContain(DISCLAIMERS.spotVsFutures);
    expect(out.screener.note).toContain('1 kontrak = 1000 token');
  });

  it('UNIT-SM-SCR-002 token simbol sama kontrak berbeda → TIDAK_TERHUBUNG, tanpa sinyal walau simbol futures ada', () => {
    const fake = radarToken(FAKE_ADDR, 90);
    const [out] = linkToScreener([fake], { matches: matchesFor([fake]), activeSignals: [signalRow({ symbol: '1000PEPEUSDT', tier: 'A' }), signalRow({ symbol: 'PEPEUSDT', tier: 'A' })] });
    expect(out.binance.status).toBe('SYMBOL_ONLY');
    expect(out.screener.signals).toEqual([]);
    expect(out.screener.relevance).toBe('TIDAK_TERHUBUNG');
    expect(out.screener.relevanceReason).toContain('kontrak berbeda');
    expect(out.screener.note).toContain(DISCLAIMERS.spotVsFutures);
  });

  it('UNIT-SM-SCR-003 hanya sinyal LONG pada 5m/15m/1h; SHORT & timeframe lain diabaikan', () => {
    const t = radarToken(PEPE_ADDR, 30);
    const signals = [
      { ...signalRow({ symbol: '1000PEPEUSDT', tier: 'A' }), direction: 'SHORT', classification: 'SD', state: 'EARLY_BEARISH' },
      signalRow({ symbol: '1000PEPEUSDT', timeframe: '4h', tier: 'A' }),
      signalRow({ symbol: 'PEPEUSDT', tier: 'A' }), // simbol spot, bukan futuresSymbol
    ];
    const [out] = linkToScreener([t], { matches: matchesFor([t]), activeSignals: signals });
    expect(out.screener.signals).toEqual([]);
    expect(out.screener.relevance).toBe('RENDAH');
  });

  it('UNIT-SM-SCR-004 SEDANG bila hanya keyakinan tinggi atau hanya sinyal tier A/B', () => {
    const hi = radarToken(PEPE_ADDR, 65);
    const [a] = linkToScreener([hi], { matches: matchesFor([hi]), activeSignals: [signalRow({ symbol: '1000PEPEUSDT', tier: 'C' })] });
    expect(a.screener.relevance).toBe('SEDANG');
    const lo = radarToken(PEPE_ADDR, 40);
    const [b] = linkToScreener([lo], { matches: matchesFor([lo]), activeSignals: [signalRow({ symbol: '1000PEPEUSDT', tier: 'B' })] });
    expect(b.screener.relevance).toBe('SEDANG');
    expect(b.screener.relevanceReason).toContain('tier B');
    // sinyal lama tanpa tier konfluensi → tier null, tidak dihitung kuat
    const legacy = { ...signalRow({ symbol: '1000PEPEUSDT' }) };
    delete legacy.confidenceTier;
    const [c] = linkToScreener([lo], { matches: matchesFor([lo]), activeSignals: [legacy] });
    expect(c.screener.signals[0].tier).toBeNull();
    expect(c.screener.relevance).toBe('RENDAH');
  });

  it('UNIT-SM-SCR-005 token tanpa entri matches → NOT_LISTED / TIDAK_TERHUBUNG; urutan masukan dipertahankan', () => {
    const t1 = radarToken(FAKE_ADDR, 80, 'XYZ');
    const t2 = radarToken(PEPE_ADDR, 10);
    const out = linkToScreener([t1, t2], { matches: matchesFor([t2]), activeSignals: [] });
    expect(out.map((r) => r.tokenKey)).toEqual([t1.tokenKey, t2.tokenKey]);
    expect(out[0].binance.status).toBe('NOT_LISTED');
    expect(out[0].screener.relevance).toBe('TIDAK_TERHUBUNG');
    expect(out.every((r) => RELEVANCE_LEVELS.includes(r.screener.relevance))).toBe(true);
    expect(out.every((r) => r.screener.note.includes(DISCLAIMERS.spotVsFutures))).toBe(true);
    expect(() => linkToScreener(null, {})).toThrow(TypeError);
  });

  it('UNIT-SM-SCR-006 higher low dari struktur konfluensi; kondisi higherLows yang gagal tidak dilabeli', () => {
    const fromStructure = signalPatterns(signalRow({ symbol: 'X', extra: [
      { factor: 'CONFLUENCE:CONFIRM', contribution: 0, detail: 'Struktur pasar BULLISH, skor struktur 0.7 — searah LONG' },
    ] }));
    expect(fromStructure).toContain(PATTERN_LABELS.HIGHER_LOW);
    const failed = signalPatterns(signalRow({ symbol: 'X', extra: [
      { factor: 'PATTERN:SA:higherLows', contribution: 0, detail: 'Higher low: nilai 0 tidak memenuhi ambang 2' },
      { factor: 'CONFLUENCE:CONFLICT', contribution: 0, detail: 'Rezim CHOPPY — pergerakan acak' },
    ] }));
    expect(failed).toEqual([PATTERN_LABELS.SA]);
    expect(signalPatterns({})).toEqual([]);
  });
});
