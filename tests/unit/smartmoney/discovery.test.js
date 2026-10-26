import { describe, expect, it } from 'vitest';
import { EXCLUDED_DISCOVERY_CATEGORIES, rankCandidates } from '../../../backend/smartmoney/discovery.js';
import { ZERO_ADDRESS } from '../../../backend/smartmoney/contracts.js';
import { addr, labelMap, makeLabel } from '../../helpers/smartMoneyBuilders.js';

const A = addr(0xa1);
const B = addr(0xb2);
const C = addr(0xc3);
const upper = (a) => `0x${a.slice(2).toUpperCase()}`;
const cand = (address, source = 'dex-top-traders', reason = 'Trader teratas', chain = 'ethereum') => ({ chain, address, source, reason });

describe('discovery — rankCandidates', () => {
  it('UNIT-SM-DS-001 bentuk keluaran mempertahankan sumber & alasan penemuan', () => {
    const r = rankCandidates([cand(A, 'birdeye', 'PnL 30 hari tertinggi')]);
    expect(r).toEqual([{ chain: 'ethereum', address: A, source: 'birdeye', reason: 'PnL 30 hari tertinggi', sources: ['birdeye'] }]);
  });

  it('UNIT-SM-DS-002 duplikat (termasuk beda huruf besar EVM) digabung; sumber pertama dipertahankan', () => {
    const r = rankCandidates([cand(A, 'birdeye'), cand(upper(A), 'dune'), cand(A, 'birdeye'), cand(B, 'dune')]);
    expect(r.map((x) => x.address)).toEqual([A, B]);
    expect(r[0]).toMatchObject({ source: 'birdeye', sources: ['birdeye', 'dune'] });
  });

  it('UNIT-SM-DS-003 peringkat: lebih banyak sumber berbeda lebih dulu, lalu urutan kemunculan', () => {
    const r = rankCandidates([cand(A, 's1'), cand(B, 's1'), cand(C, 's1'), cand(C, 's2'), cand(C, 's3'), cand(B, 's2')]);
    expect(r.map((x) => x.address)).toEqual([C, B, A]);
  });

  it.each(EXCLUDED_DISCOVERY_CATEGORIES)('UNIT-SM-DS-004 alamat berlabel %s dibuang', (category) => {
    const labels = labelMap([makeLabel({ address: B, category })]);
    expect(rankCandidates([cand(A), cand(B)], { labels }).map((x) => x.address)).toEqual([A]);
  });

  it('UNIT-SM-DS-005 kategori kontrak wajib (cex/dex_router/dex_pool/bridge/contract) termasuk; smart_money dipertahankan', () => {
    for (const c of ['cex', 'dex_router', 'dex_pool', 'bridge', 'contract']) expect(EXCLUDED_DISCOVERY_CATEGORIES).toContain(c);
    const labels = labelMap([makeLabel({ address: B, category: 'smart_money' }), makeLabel({ address: C, category: 'cex', source: '' })]);
    // label tanpa sumber tidak dipercaya → tidak membuang kandidat
    expect(rankCandidates([cand(A), cand(B), cand(C)], { labels }).map((x) => x.address)).toEqual([A, B, C]);
  });

  it('UNIT-SM-DS-006 alamat yang sudah dilacak dibuang (Set walletKey, array objek, beda huruf besar)', () => {
    expect(rankCandidates([cand(A), cand(B)], { existing: new Set([`ethereum:${A}`]) }).map((x) => x.address)).toEqual([B]);
    expect(rankCandidates([cand(A), cand(B)], { existing: [`ethereum:${upper(B)}`] }).map((x) => x.address)).toEqual([A]);
    expect(rankCandidates([cand(A), cand(B)], { existing: [{ chain: 'ethereum', address: upper(A) }] }).map((x) => x.address)).toEqual([B]);
    // alamat sama di chain lain tetap kandidat
    expect(rankCandidates([cand(A, 's', 'r', 'base')], { existing: new Set([`ethereum:${A}`]) })).toHaveLength(1);
  });

  it('UNIT-SM-DS-007 input tidak valid dibuang: chain tak dikenal, alamat rusak, zero address, native, null', () => {
    const r = rankCandidates([
      null, cand(A, 's', 'r', 'dogechain'), cand('0x123'), cand(ZERO_ADDRESS), cand('native'), { chain: 'ethereum' }, cand(B),
    ]);
    expect(r.map((x) => x.address)).toEqual([B]);
    expect(rankCandidates(undefined)).toEqual([]);
  });

  it('UNIT-SM-DS-008 Solana peka huruf besar/kecil: dua alamat beda kapitalisasi tetap dua kandidat', () => {
    const S = 'AbCdEfGhJkMnPqRsTuVwXyZ123456789abcdefghij';
    const r = rankCandidates([cand(S, 's', 'r', 'solana'), cand(S.toLowerCase(), 's', 'r', 'solana')]);
    expect(r.map((x) => x.address)).toEqual([S, S.toLowerCase()]);
  });

  it('UNIT-SM-DS-009 deterministik & tanpa sumber → source null', () => {
    const input = [cand(A, null, null), cand(B)];
    expect(rankCandidates(input)).toEqual(rankCandidates(input));
    expect(rankCandidates(input).map((x) => x.address)).toEqual([B, A]);
    expect(rankCandidates(input)[1]).toMatchObject({ address: A, source: null, reason: null, sources: [] });
  });
});
