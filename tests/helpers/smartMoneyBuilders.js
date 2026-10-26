// Pembangun data uji Smart Money sesuai bentuk kontrak docs/15-kontrak-smart-money.md §1–§2
// (Activity dari classify.js, closedTrades/PnlResult dari pnl.js). Modul tersebut TIDAK diimpor.

import { explorerTxUrl, tokenKey } from '../../backend/smartmoney/contracts.js';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const T0 = Date.UTC(2026, 0, 5); // Senin 5 Jan 2026 00:00 UTC

const IN_TYPES = new Set(['SWAP_BUY', 'TRANSFER_IN', 'CEX_WITHDRAWAL', 'BRIDGE_IN', 'AIRDROP', 'MINT', 'LP_REMOVE']);

/** Alamat EVM deterministik (huruf kecil) dari bilangan ≥ 1. */
export function addr(n) {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

/** Alamat token EVM deterministik (berbeda ruang dari addr). */
export function tokenAddr(n) {
  return `0x${('7' + n.toString(16)).padStart(40, '0')}`;
}

/** Hash tx EVM deterministik. */
export function txh(n, salt = 0) {
  return `0x${salt.toString(16).padStart(8, '0')}${n.toString(16).padStart(56, '0')}`;
}

/**
 * Activity sesuai kontrak. Default: SWAP_BUY 1000 TOKEN senilai 500 USD di ethereum.
 * `token` boleh string alamat atau objek token.
 */
export function makeActivity({
  chain = 'ethereum', wallet = addr(1), txHash = txh(1), blockTime = T0, type = 'SWAP_BUY', token = tokenAddr(1),
  symbol = 'TKN', amount = 1000, usdValue = 500, counterparty = null, counterpartyLabel = null, direction,
  confidence = 'HIGH', reason = 'aktivitas uji', provider = 'test', isSimulated = true,
} = {}) {
  const tok = typeof token === 'string' ? { address: token, symbol, name: null, decimals: 18 } : token;
  return {
    id: `${chain}:${txHash}:${wallet}:${tok.address}`,
    chain, txHash, blockTime, wallet,
    token: tok,
    type,
    direction: direction ?? (IN_TYPES.has(type) ? 'IN' : 'OUT'),
    amount, usdValue, counterparty, counterpartyLabel, confidence, reason, provider, isSimulated,
    explorerUrl: explorerTxUrl(chain, txHash),
  };
}

/** Satu entri closedTrades sesuai kontrak pnl.js. `returnPct` dalam persen (900 = +900 %). */
export function makeClosedTrade({
  chain = 'ethereum', token = tokenAddr(1), tokenKey: tk, openAt = T0, closeAt, holdMs, qty = 1000, costUsd = 1000,
  returnPct = 10,
} = {}) {
  const hold = holdMs ?? (closeAt !== undefined ? closeAt - openAt : DAY);
  const close = closeAt ?? openAt + hold;
  const pnlUsd = (costUsd * returnPct) / 100;
  return {
    tokenKey: tk ?? tokenKey(chain, token),
    openAt, closeAt: close, qty, costUsd, proceedsUsd: costUsd + pnlUsd, pnlUsd, returnPct, holdMs: hold,
  };
}

/** PnlResult sesuai kontrak; summary dihitung dari closedTrades kecuali di-override. */
export function makePnl({
  closedTrades = [], positions = [], completenessRatio = 1, airdropRealizedUsd = 0, unrealizedPnlUsd = null,
  summary = {},
} = {}) {
  const realized = closedTrades.reduce((s, t) => s + t.pnlUsd, 0);
  return {
    positions,
    closedTrades,
    summary: {
      realizedPnlUsd: realized,
      unrealizedPnlUsd,
      totalCostUsd: closedTrades.reduce((s, t) => s + t.costUsd, 0),
      airdropRealizedUsd,
      tradesCount: closedTrades.length * 2,
      closedTradesCount: closedTrades.length,
      tokensTraded: new Set(closedTrades.map((t) => t.tokenKey)).size,
      completenessRatio,
      completeness: completenessRatio >= 1 ? 'COMPLETE' : completenessRatio > 0 ? 'PARTIAL' : 'UNKNOWN',
      notes: [],
      ...summary,
    },
  };
}

/** Label alamat bersumber. */
export function makeLabel({ chain = 'ethereum', address, label = 'Label', category = 'other', source = 'etherscan-nametag', confidence = 0.9, fetchedAt = T0 } = {}) {
  return { chain, address, label, category, source, confidence, fetchedAt };
}

/** Map<chain:address, AddressLabel> dari daftar label. */
export function labelMap(labels) {
  return new Map(labels.map((l) => [`${l.chain}:${l.address}`, l]));
}
