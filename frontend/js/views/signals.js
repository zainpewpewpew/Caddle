import { api } from '../lib/api.js';
import { dataTable, emptyState, page, panel, stage } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatPercent, formatPrice, formatUtc } from '../lib/format.js';
import { patternBadge } from './signalFormat.js';

const firstEventAt = (signal, states) => signal.events.find((e) => states.includes(e.toState))?.occurredAt ?? null;

/** Baris riwayat dari sinyal + event transisinya (GET /api/signals/history). */
export function historyRow(signal) {
  const move = signal.peakPrice && signal.firstDetectedPrice ? signal.peakPrice / signal.firstDetectedPrice - 1 : null;
  return {
    ...signal,
    confirmedAt: firstEventAt(signal, ['BREAKOUT']),
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
    subtitle: 'Riwayat setiap sinyal: deteksi pertama, transisi tahap, invalidasi, dan kedaluwarsa.',
  },
  panel({ title: 'Riwayat sinyal', flush: true, footer: 'Pergerakan = harga tertinggi sejak deteksi pertama dibanding harga deteksi (MFE), bukan hasil trading.' },
    dataTable({
      caption: 'Riwayat sinyal',
      initialSort: { key: 'firstDetectedAt', dir: 'desc' },
      columns: [
        { key: 'firstDetectedAt', label: 'Deteksi pertama', render: (r) => formatUtc(r.firstDetectedAt) },
        { key: 'symbol', label: 'Symbol', render: (r) => h('span', { class: 'mono' }, r.symbol) },
        { key: 'classification', label: 'Pola', render: (r) => patternBadge(r.classification) },
        { key: 'timeframe', label: 'TF', render: (r) => h('span', { class: 'mono' }, r.timeframe) },
        { key: 'firstDetectedPrice', label: 'Harga deteksi', numeric: true, render: (r) => formatPrice(r.firstDetectedPrice) },
        { key: 'state', label: 'Tahap terakhir', render: (r) => stage(r.state) },
        { key: 'confirmedAt', label: 'Breakout', render: (r) => formatUtc(r.confirmedAt) },
        { key: 'invalidatedAt', label: 'Invalidasi', render: (r) => formatUtc(r.invalidatedAt) },
        { key: 'expiredAt', label: 'Kedaluwarsa', render: (r) => formatUtc(r.expiredAt) },
        { key: 'move', label: 'Pergerakan', numeric: true, render: (r) => formatPercent(r.move) },
      ],
      rows,
      empty: emptyState({ iconName: 'signals', title: 'Belum ada riwayat sinyal', text: 'Setiap transisi state machine dipersistensi saat worker berjalan. Tidak ada data contoh yang ditampilkan.' }),
    })));
}
