import { api } from '../lib/api.js';
import { dataTable, emptyState, page, panel } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatPercent, formatPrice, formatUtc } from '../lib/format.js';
import { directionBadge, directionOf, patternBadge, signalStage } from './signalFormat.js';

const firstEventAt = (signal, states) => signal.events.find((e) => states.includes(e.toState))?.occurredAt ?? null;

/** Baris riwayat dari sinyal + event transisinya (GET /api/signals/history, kedua arah). */
export function historyRow(signal) {
  const move = signal.peakPrice && signal.firstDetectedPrice ? signal.peakPrice / signal.firstDetectedPrice - 1 : null;
  return {
    ...signal,
    // Sinyal lama tanpa field direction = LONG (kontrak API).
    direction: directionOf(signal.direction),
    // Konfirmasi: BREAKOUT untuk LONG, BREAKDOWN untuk SHORT.
    confirmedAt: firstEventAt(signal, ['BREAKOUT', 'BREAKDOWN']),
    invalidatedAt: firstEventAt(signal, ['INVALIDATED']),
    expiredAt: firstEventAt(signal, ['EXPIRED']),
    move,
  };
}

export async function signalsView() {
  const { items } = await api('/api/signals/history?limit=200');
  const rows = items.map(historyRow);
  return page({
    title: 'Signal History',
    subtitle: 'Riwayat setiap sinyal LONG dan SHORT: deteksi pertama, transisi tahap, invalidasi, dan kedaluwarsa.',
  },
  panel({
    title: 'Riwayat sinyal',
    flush: true,
    footer: 'Pergerakan = perubahan dari harga deteksi ke harga ekstrem yang dicatat sejak deteksi pertama (LONG: harga tertinggi, MFE); nilai negatif berarti harga turun. Bukan hasil trading.',
  },
  dataTable({
    caption: 'Riwayat sinyal',
    initialSort: { key: 'firstDetectedAt', dir: 'desc' },
    columns: [
      { key: 'firstDetectedAt', label: 'Deteksi pertama', render: (r) => formatUtc(r.firstDetectedAt) },
      { key: 'symbol', label: 'Symbol', render: (r) => h('span', { class: 'mono' }, r.symbol) },
      { key: 'direction', label: 'Arah', render: (r) => directionBadge(r.direction) },
      { key: 'classification', label: 'Pola', render: (r) => patternBadge(r.classification, r.direction) },
      { key: 'timeframe', label: 'TF', render: (r) => h('span', { class: 'mono' }, r.timeframe) },
      { key: 'firstDetectedPrice', label: 'Harga deteksi', numeric: true, render: (r) => formatPrice(r.firstDetectedPrice) },
      { key: 'state', label: 'Tahap terakhir', render: (r) => signalStage(r.state, r.direction) },
      { key: 'confirmedAt', label: 'Breakout/Breakdown', render: (r) => formatUtc(r.confirmedAt) },
      { key: 'invalidatedAt', label: 'Invalidasi', render: (r) => formatUtc(r.invalidatedAt) },
      { key: 'expiredAt', label: 'Kedaluwarsa', render: (r) => formatUtc(r.expiredAt) },
      { key: 'move', label: 'Pergerakan', numeric: true, render: (r) => formatPercent(r.move) },
    ],
    rows,
    empty: emptyState({ iconName: 'signals', title: 'Belum ada riwayat sinyal', text: 'Setiap transisi state machine dipersistensi saat worker berjalan. Tidak ada data contoh yang ditampilkan.' }),
  })));
}
