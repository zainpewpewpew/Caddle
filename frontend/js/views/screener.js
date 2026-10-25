import { badge, dataTable, emptyState, page, panel, selectField } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { milestoneLabel } from './roadmap.js';

// Kolom sesuai spesifikasi 6.2. Baris diisi oleh API sinyal di Milestone 3–4.
export const SCREENER_COLUMNS = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'price', label: 'Harga', numeric: true },
  { key: 'volume24h', label: 'Vol 24j', numeric: true },
  { key: 'timeframe', label: 'TF' },
  { key: 'pattern', label: 'Pola' },
  { key: 'patternScore', label: 'Pattern Score', numeric: true },
  { key: 'earlyScore', label: 'Early Score', numeric: true },
  { key: 'alignment', label: 'Alignment' },
  { key: 'stage', label: 'Tahap' },
  { key: 'riskFlags', label: 'Risiko', sortable: false },
  { key: 'firstDetectedAt', label: 'Deteksi pertama' },
  { key: 'updatedAt', label: 'Update' },
];

const ALL = { value: '', label: 'Semua' };

export async function screenerView() {
  const filters = h('form', { class: 'toolbar', 'aria-label': 'Filter screener' },
    selectField({ label: 'Timeframe', name: 'tf', options: [ALL, { value: '5m', label: '5m' }, { value: '15m', label: '15m' }, { value: '1h', label: '1h' }] }),
    selectField({ label: 'Pola', name: 'pattern', options: [ALL, { value: 'SA', label: 'SA' }, { value: 'PVA', label: 'PVA' }, { value: 'BOTH', label: 'BOTH' }] }),
    selectField({ label: 'Tahap', name: 'stage', options: [ALL, { value: 'QUIET', label: 'Quiet' }, { value: 'EARLY_BULLISH', label: 'Early bullish' }, { value: 'MOMENTUM_BUILDING', label: 'Momentum' }, { value: 'BREAKOUT', label: 'Breakout' }] }),
    selectField({ label: 'Alignment', name: 'alignment', options: [ALL, { value: 'ALIGNED', label: 'Aligned' }, { value: 'PARTIALLY_CONFIRMED', label: 'Parsial' }, { value: 'UNCONFIRMED', label: 'Unconfirmed' }, { value: 'COUNTERTREND', label: 'Countertrend' }] }),
    selectField({ label: 'Skor minimum', name: 'minScore', options: [ALL, { value: '50', label: '≥ 50' }, { value: '70', label: '≥ 70' }, { value: '85', label: '≥ 85' }] }),
    selectField({ label: 'Likuiditas', name: 'liquidity', options: [ALL, { value: 'high', label: 'Tinggi' }, { value: 'mid', label: 'Menengah' }] }),
  );
  for (const el of filters.querySelectorAll('select')) el.disabled = true;

  const table = dataTable({
    columns: SCREENER_COLUMNS,
    rows: [],
    caption: 'Kandidat LONG',
    initialSort: { key: 'earlyScore', dir: 'desc' },
    empty: emptyState({
      iconName: 'screener',
      title: 'Belum ada kandidat LONG',
      text: `Screener akan terisi oleh detektor SA/PVA (${milestoneLabel(3)}) dari data candle tertutup Binance (${milestoneLabel(2)}).`,
    }),
  });

  return page({
    title: 'LONG Screener',
    subtitle: 'Kandidat struktur bullish per timeframe. Skor mengukur kemiripan dengan aturan pola, bukan probabilitas profit.',
  },
  panel({ title: 'Kandidat', actions: badge('0 hasil'), flush: true, footer: 'Filter diaktifkan setelah data sinyal tersedia.' }, filters, table));
}
