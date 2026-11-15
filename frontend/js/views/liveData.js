// Data "live" tabel scanner (keputusan pengguna 2026-11-15: data diperbarui tiap 1 menit, scanner terus memindai):
// - DATA_REFRESH_MS: tabel LONG/SHORT Scanner dimuat ulang tiap menit selama scanner berjalan;
// - harga live: kolom "Harga" memakai close candle BERJALAN dari WebSocket (livePrice dari API) selama masih segar,
//   selain itu close candle tertutup terakhir (lastPrice). Sinyal tetap dihitung dari candle tertutup (tanpa repaint);
// - reportDataRefresh: kabar "tabel diperbarui jam sekian, berikutnya jam sekian" ke strip status (statusStrip.js).
import { h } from '../lib/dom.js';
import { EMPTY, formatClock, formatPrice } from '../lib/format.js';

/** Interval muat ulang tabel scanner selama scanner berjalan. */
export const DATA_REFRESH_MS = 60_000;
/** Harga live lebih tua dari ini (scanner berhenti / WebSocket putus) tidak dipakai: kembali ke close candle tertutup. */
export const LIVE_PRICE_MAX_AGE_MS = 120_000;
/** Nama event window untuk kabar muat ulang data halaman (lihat reportDataRefresh). */
export const DATA_EVENT = 'lr:data';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Harga yang ditampilkan untuk satu baris: live bila livePrice segar (≤ LIVE_PRICE_MAX_AGE_MS), selain itu lastPrice.
 * @param {{ livePrice?: number|null, livePriceAt?: number|null, lastPrice?: number|null, lastCandleAt?: number|null }} row
 * @param {number} [now]
 * @returns {{ price: number|null, live: boolean, at: number|null }}
 */
export function livePriceOf(row, now = Date.now()) {
  if (isNum(row?.livePrice) && isNum(row?.livePriceAt) && now - row.livePriceAt <= LIVE_PRICE_MAX_AGE_MS) {
    return { price: row.livePrice, live: true, at: row.livePriceAt };
  }
  return { price: isNum(row?.lastPrice) ? row.lastPrice : null, live: false, at: isNum(row?.lastCandleAt) ? row.lastCandleAt : null };
}

/** Nilai urut kolom Harga (sama dengan yang tampil). */
export const priceSortValue = (row) => livePriceOf(row).price;

/**
 * Sel "Harga": angka + titik live kecil bila harga berasal dari candle berjalan. Title menjelaskan sumbernya.
 * @param {object} row baris API (lastPrice, livePrice, livePriceAt, timeframe)
 */
export function priceCell(row, now = Date.now()) {
  const { price, live, at } = livePriceOf(row, now);
  if (price === null) return EMPTY;
  const tf = typeof row?.timeframe === 'string' ? row.timeframe : '';
  const title = live
    ? `Harga live dari candle ${tf} yang sedang berjalan (WebSocket Binance), diterima ${formatClock(at)}. Sinyal tetap dihitung dari candle tertutup.`
    : `Harga penutupan candle ${tf} tertutup terakhir${at === null ? '' : ` (${formatClock(at + 1)})`}.`;
  return h('span', { class: 'price-cell', 'data-testid': 'price-cell', 'data-live': live ? 'true' : undefined, title }, formatPrice(price));
}

/**
 * Mengabarkan muat ulang data halaman ke strip status: kapan terakhir dimuat dan kapan berikutnya (null = tidak ada
 * muat ulang otomatis, mis. scanner berhenti).
 * @param {{ source: string, at: number, nextAt: number|null }} detail
 */
export function reportDataRefresh(detail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(DATA_EVENT, { detail }));
}
