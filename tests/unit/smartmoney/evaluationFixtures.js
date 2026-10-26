// Fixture SINTETIS untuk uji analyze/prices/evaluate (alamat & hash fiktif; tidak mewakili wallet atau transaksi
// nyata). Dibangun di atas tests/helpers/smartMoneyBuilders.js (bentuk Activity kontrak docs/15 §1).
import { DAY, HOUR, T0, addr, makeActivity, tokenAddr, txh } from '../../helpers/smartMoneyBuilders.js';

export { DAY, HOUR, T0, addr, tokenAddr };

export const CHAIN = 'ethereum';
export const WETH_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

/**
 * Riwayat trade tertutup: `trades` pasang SWAP_BUY → SWAP_SELL (1000 unit, biaya `costUsd`, return `returnPct` %),
 * token bergilir `tokenBase … tokenBase + tokens − 1`, satu trade per `spacingMs`, dipegang `holdMs`.
 * Default (12 trade, 4 token, jarak 3 hari) → wallet layak setelah ±34 hari riwayat.
 */
export function tradeHistory({
  wallet, salt, from = T0, trades = 12, tokens = 4, tokenBase = 100, spacingMs = 3 * DAY, holdMs = DAY,
  costUsd = 1000, returnPct = 20, chain = CHAIN,
} = {}) {
  const out = [];
  for (let i = 0; i < trades; i += 1) {
    const token = tokenAddr(tokenBase + (i % tokens));
    const openAt = from + i * spacingMs;
    out.push(makeActivity({ chain, wallet, token, txHash: txh(2 * i + 1, salt), blockTime: openAt, type: 'SWAP_BUY', amount: 1000, usdValue: costUsd }));
    out.push(makeActivity({
      chain, wallet, token, txHash: txh(2 * i + 2, salt), blockTime: openAt + holdMs, type: 'SWAP_SELL', amount: 1000,
      usdValue: costUsd * (1 + returnPct / 100),
    }));
  }
  return out;
}

/** Satu aktivitas (default SWAP_BUY) dengan hash unik dari (n, salt). */
export function swap({ wallet, token, at, n, salt = 0xb0, usd = 1000, amount = 1000, type = 'SWAP_BUY', chain = CHAIN, symbol = 'TKN' }) {
  return makeActivity({ chain, wallet, token, symbol, txHash: txh(n, salt), blockTime: at, type, amount, usdValue: usd });
}

/**
 * priceAt sintetis dari tabel { tokenKey: [[at, harga|null], ...] }: harga baris terakhir dengan at ≤ t
 * (null = harga tidak tersedia sejak titik itu), opsional batas basi.
 */
export function tablePriceAt(table, { maxStalenessMs = Infinity } = {}) {
  const series = new Map(Object.entries(table).map(([key, rows]) => [key, [...rows].sort((a, b) => a[0] - b[0])]));
  return (key, t) => {
    let last = null;
    for (const row of series.get(key) ?? []) {
      if (row[0] > t) break;
      last = row;
    }
    if (!last || t - last[0] > maxStalenessMs) return null;
    return last[1];
  };
}

/** Acak deterministik (LCG Park–Miller + Fisher–Yates) untuk menguji ketidaktergantungan pada urutan masukan. */
export function shuffled(list, seed = 7) {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 48_271) % 2_147_483_647;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
