// Pembuat fixture SINTETIS berbentuk kontrak docs/15 §1 (Activity) untuk uji unit smart money.
// Alamat & hash fiktif; tidak mewakili wallet atau transaksi nyata.
import { explorerTxUrl, walletKey } from '../../../backend/smartmoney/contracts.js';

export const T0 = Date.UTC(2026, 9, 1, 12);
export const HOUR = 3_600_000;

/** Alamat EVM fiktif deterministik dari angka. */
export const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
/** Hash tx EVM fiktif deterministik dari angka. */
export const txh = (n) => `0x${n.toString(16).padStart(64, '0')}`;

export const PEPE = Object.freeze({ address: addr(0xaaa1), symbol: 'PEPE', name: 'Pepe', decimals: 18 });
export const PEPE_FAKE = Object.freeze({ address: addr(0xbbb2), symbol: 'PEPE', name: 'Pepe Palsu', decimals: 18 });
export const WETH = Object.freeze({ address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 });

const DIRECTION = {
  SWAP_BUY: 'IN', SWAP_SELL: 'OUT', TRANSFER_IN: 'IN', TRANSFER_OUT: 'OUT', CEX_WITHDRAWAL: 'IN', CEX_DEPOSIT: 'OUT',
  BRIDGE_IN: 'IN', BRIDGE_OUT: 'OUT', AIRDROP: 'IN', MINT: 'IN', BURN: 'OUT', LP_ADD: 'OUT', LP_REMOVE: 'IN', UNKNOWN: 'IN',
};

let seq = 1;
/** Activity sesuai kontrak; `tx` angka unik → txHash. */
export function act({ wallet, token = PEPE, type = 'SWAP_BUY', at = T0, amount = 1000, usd = 1000, tx, chain = 'ethereum', id } = {}) {
  const n = tx ?? seq++;
  const txHash = txh(n);
  return {
    id: id ?? `${chain}:${txHash}:${wallet}:${token.address}`,
    chain, txHash, blockTime: at, wallet,
    token: { ...token },
    type, direction: DIRECTION[type],
    amount, usdValue: usd,
    counterparty: null, counterpartyLabel: null,
    confidence: 'HIGH', reason: 'fixture sintetis',
    provider: 'fixture', isSimulated: true,
    explorerUrl: explorerTxUrl(chain, txHash),
  };
}

/** Peta skor wallet: entri [address, score, extra]. */
export function scores(entries, chain = 'ethereum') {
  return new Map(entries.map(([address, score, extra = {}]) => [walletKey(chain, address), { score, eligible: true, flags: [], ...extra }]));
}
