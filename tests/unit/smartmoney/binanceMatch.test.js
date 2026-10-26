import { describe, expect, it } from 'vitest';
import { MATCH_STATUSES } from '../../../backend/smartmoney/contracts.js';
import { matchToken } from '../../../backend/smartmoney/binanceMatch.js';

// Mapping SINTETIS (alamat & waktu fiktif kecuali alamat PEPE publik sebagai contoh bentuk).
const PEPE_ADDR = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const FAKE_PEPE = '0x00000000000000000000000000000000000bbbb2';
const SOL_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ROWS = [
  { chain: 'ethereum', contractAddress: PEPE_ADDR, binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT', multiplier: 1000, source: 'binance-capital-config', verifiedAt: 1 },
  { chain: 'ethereum', contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca', binanceAsset: 'LINK', spotSymbol: 'LINKUSDT', futuresSymbol: 'LINKUSDT', multiplier: 1, source: 'manual', verifiedAt: 1 },
  { chain: 'solana', contractAddress: SOL_MINT, binanceAsset: 'BONK', spotSymbol: 'BONKUSDT', futuresSymbol: '1000BONKUSDT', multiplier: 1000, source: 'manual', verifiedAt: 1 },
];

describe('matchToken', () => {
  it('UNIT-SM-BNC-001 kontrak sama persis → MATCHED; masukan EVM huruf besar tetap cocok', () => {
    const m = matchToken({ chain: 'ethereum', address: PEPE_ADDR.toUpperCase().replace('0X', '0x'), symbol: 'PEPE' }, ROWS);
    expect(m).toMatchObject({ status: 'MATCHED', binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT', multiplier: 1000, source: 'binance-capital-config' });
    expect(m.note).toContain('1 kontrak = 1000 token');
    const link = matchToken({ chain: 'ethereum', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK' }, ROWS);
    expect(link).toMatchObject({ status: 'MATCHED', futuresSymbol: 'LINKUSDT', multiplier: 1 });
  });

  it('UNIT-SM-BNC-002 simbol sama kontrak berbeda → SYMBOL_ONLY (bukan MATCHED, tanpa futuresSymbol)', () => {
    const m = matchToken({ chain: 'ethereum', address: FAKE_PEPE, symbol: 'pepe' }, ROWS);
    expect(m.status).toBe('SYMBOL_ONLY');
    expect(m.futuresSymbol).toBeNull();
    expect(m.spotSymbol).toBeNull();
    expect(m.note).toContain('tidak ditautkan');
    // chain berbeda dengan alamat sama juga bukan MATCHED
    expect(matchToken({ chain: 'base', address: PEPE_ADDR, symbol: 'PEPE' }, ROWS).status).toBe('SYMBOL_ONLY');
  });

  it('UNIT-SM-BNC-003 dua baris mapping berbeda untuk kontrak sama → AMBIGUOUS; baris identik digabung', () => {
    const rows = [...ROWS, { ...ROWS[0], binanceAsset: 'PEPE2', spotSymbol: null, futuresSymbol: 'PEPE2USDT', multiplier: 1, source: 'lain' }];
    const m = matchToken({ chain: 'ethereum', address: PEPE_ADDR, symbol: 'PEPE' }, rows);
    expect(m.status).toBe('AMBIGUOUS');
    expect(m.futuresSymbol).toBeNull();
    expect(m.note).toContain('1000PEPEUSDT');
    const dup = matchToken({ chain: 'ethereum', address: PEPE_ADDR, symbol: 'PEPE' }, [...ROWS, { ...ROWS[0], source: 'sumber-lain' }]);
    expect(dup.status).toBe('MATCHED');
  });

  it('UNIT-SM-BNC-004 futures ber-prefix 1000 diambil dari multiplier baris mapping, tidak ditebak', () => {
    const rows = [{ ...ROWS[0], futuresSymbol: 'PEPEUSDT', multiplier: 1 }];
    const m = matchToken({ chain: 'ethereum', address: PEPE_ADDR, symbol: 'PEPE' }, rows);
    expect(m).toMatchObject({ futuresSymbol: 'PEPEUSDT', multiplier: 1 });
    const noMult = matchToken({ chain: 'ethereum', address: PEPE_ADDR }, [{ ...ROWS[0], multiplier: undefined }]);
    expect(noMult.multiplier).toBe(1);
    expect(matchToken({ chain: 'ethereum', address: PEPE_ADDR }, [{ ...ROWS[0], multiplier: -5 }]).status).toBe('NOT_LISTED');
  });

  it('UNIT-SM-BNC-005 mint Solana peka huruf besar/kecil', () => {
    expect(matchToken({ chain: 'solana', address: SOL_MINT, symbol: 'BONK' }, ROWS)).toMatchObject({ status: 'MATCHED', futuresSymbol: '1000BONKUSDT', multiplier: 1000 });
    expect(matchToken({ chain: 'solana', address: SOL_MINT.toLowerCase(), symbol: 'BONK' }, ROWS).status).toBe('SYMBOL_ONLY');
    expect(matchToken({ chain: 'solana', address: SOL_MINT.toLowerCase(), symbol: 'XYZ' }, ROWS).status).toBe('NOT_LISTED');
  });

  it('UNIT-SM-BNC-006 tidak terdaftar → NOT_LISTED; status selalu anggota MATCH_STATUSES; validasi input', () => {
    const m = matchToken({ chain: 'ethereum', address: '0x00000000000000000000000000000000000c0ffe', symbol: 'ZZZ' }, ROWS);
    expect(m).toEqual({ status: 'NOT_LISTED', binanceAsset: null, spotSymbol: null, futuresSymbol: null, multiplier: 1, source: null, note: expect.any(String) });
    expect(MATCH_STATUSES).toContain(m.status);
    expect(matchToken({ chain: 'ethereum', address: null, symbol: 'PEPE' }, ROWS).status).toBe('NOT_LISTED');
    expect(matchToken({ chain: 'ethereum', address: PEPE_ADDR }, []).status).toBe('NOT_LISTED');
    expect(() => matchToken(null, ROWS)).toThrow(TypeError);
    expect(() => matchToken({ chain: 'ethereum', address: PEPE_ADDR }, null)).toThrow(TypeError);
  });
});
