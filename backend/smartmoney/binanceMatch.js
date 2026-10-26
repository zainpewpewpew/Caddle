// Pencocokan token on-chain → pasar Binance (kontrak docs/15-kontrak-smart-money.md §2 `binanceMatch.js`).
// Fungsi murni. Identitas token = chain + alamat kontrak; simbol TIDAK PERNAH cukup untuk menautkan.
//
// Aturan:
// - MATCHED      tepat satu entri mapping (setelah dedupe baris identik) dengan `chain` sama dan `contractAddress`
//                sama persis. EVM dibandingkan huruf kecil (masukan boleh checksum/huruf besar); Solana (base58)
//                peka huruf besar/kecil.
// - AMBIGUOUS    > 1 entri mapping berbeda untuk kontrak yang sama (mis. dua aset Binance berbeda).
//                Baris identik (binanceAsset, spotSymbol, futuresSymbol, multiplier sama — mis. dari dua sumber)
//                dianggap satu entri; ini tafsiran kontrak ("lebih dari satu baris cocok") yang paling masuk akal.
// - SYMBOL_ONLY  tidak ada kontrak cocok, tetapi ada baris mapping dengan `binanceAsset` = simbol (tanpa beda
//                huruf besar/kecil) → peringatan saja, tidak pernah ditautkan ke sinyal.
// - NOT_LISTED   selain itu.
// Kontrak futures ber-prefix (mis. 1000PEPEUSDT) dan `multiplier`-nya diambil dari baris mapping, tidak ditebak.
// Baris tanpa `multiplier` (null/undefined) = 1; baris dengan multiplier tidak valid (≤ 0 / bukan angka) diabaikan.
// Untuk status selain MATCHED, field pasar bernilai null dan `multiplier` = 1 (tidak ada kontrak yang ditautkan).

import { isEvmChain } from './contracts.js';

function normContract(chain, address) {
  if (typeof address !== 'string') return null;
  const a = address.trim();
  if (!a) return null;
  return isEvmChain(chain) ? a.toLowerCase() : a;
}

function multiplierOf(row) {
  if (row.multiplier === null || row.multiplier === undefined) return 1;
  return typeof row.multiplier === 'number' && Number.isFinite(row.multiplier) && row.multiplier > 0 ? row.multiplier : null;
}

const empty = (status, note) => ({
  status, binanceAsset: null, spotSymbol: null, futuresSymbol: null, multiplier: 1, source: null, note,
});

/**
 * Cocokkan token on-chain ke aset/pasar Binance berdasarkan alamat kontrak.
 * @param {{ chain: string, address: string, symbol?: string|null }} token
 * @param {Array<{ chain: string, contractAddress: string, binanceAsset: string, spotSymbol: string|null,
 *   futuresSymbol: string|null, multiplier: number, source: string, verifiedAt: number }>} mappingRows
 * @returns {{ status: 'MATCHED'|'SYMBOL_ONLY'|'AMBIGUOUS'|'NOT_LISTED', binanceAsset: string|null,
 *   spotSymbol: string|null, futuresSymbol: string|null, multiplier: number, source: string|null, note: string }}
 */
export function matchToken(token, mappingRows) {
  if (token === null || typeof token !== 'object') throw new TypeError('token harus objek { chain, address, symbol }');
  if (!Array.isArray(mappingRows)) throw new TypeError('mappingRows harus array');
  const { chain, symbol = null } = token;
  const address = normContract(chain, token.address);
  if (!address) return empty('NOT_LISTED', 'Alamat kontrak token tidak tersedia — tidak dapat dicocokkan ke Binance');

  const rows = mappingRows.filter((r) => r && typeof r === 'object' && r.chain === chain
    && normContract(chain, r.contractAddress) === address && multiplierOf(r) !== null);
  const distinct = new Map();
  for (const r of rows) {
    const key = JSON.stringify([r.binanceAsset ?? null, r.spotSymbol ?? null, r.futuresSymbol ?? null, multiplierOf(r)]);
    if (!distinct.has(key)) distinct.set(key, r);
  }

  if (distinct.size === 1) {
    const r = [...distinct.values()][0];
    const multiplier = multiplierOf(r);
    const parts = [`Kontrak ${chain}:${address} terdaftar sebagai aset Binance ${r.binanceAsset}`];
    if (r.futuresSymbol) {
      parts.push(multiplier !== 1
        ? `futures ${r.futuresSymbol} (1 kontrak = ${multiplier} token)`
        : `futures ${r.futuresSymbol}`);
    } else parts.push('tanpa pasar futures');
    if (r.spotSymbol) parts.push(`spot ${r.spotSymbol}`);
    return {
      status: 'MATCHED',
      binanceAsset: r.binanceAsset ?? null,
      spotSymbol: r.spotSymbol ?? null,
      futuresSymbol: r.futuresSymbol ?? null,
      multiplier,
      source: r.source ?? null,
      note: `${parts.join('; ')} (sumber: ${r.source ?? 'tidak diketahui'}).`,
    };
  }
  if (distinct.size > 1) {
    const assets = [...distinct.values()].map((r) => r.futuresSymbol ?? r.spotSymbol ?? r.binanceAsset).sort();
    return empty('AMBIGUOUS', `Kontrak ${chain}:${address} cocok dengan ${distinct.size} entri Binance berbeda (${assets.join(', ')}) — tidak ditautkan sampai mapping diverifikasi.`);
  }

  const sym = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  if (sym) {
    const same = mappingRows.filter((r) => r && typeof r.binanceAsset === 'string' && r.binanceAsset.toUpperCase() === sym);
    if (same.length) {
      const where = [...new Set(same.map((r) => `${r.chain}:${r.contractAddress}`))].sort().join(', ');
      return empty('SYMBOL_ONLY', `Simbol ${sym} ada di Binance tetapi untuk kontrak lain (${where}); token ini (${chain}:${address}) `
        + 'kemungkinan token berbeda bersimbol sama — tidak ditautkan ke sinyal.');
    }
  }
  return empty('NOT_LISTED', `Kontrak ${chain}:${address} tidak ditemukan di mapping Binance.`);
}
