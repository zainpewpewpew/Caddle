import { dataTable, emptyState, page, panel } from '../lib/components.js';
import { milestoneLabel } from './roadmap.js';

export async function signalsView() {
  return page({
    title: 'Signal History',
    subtitle: 'Riwayat setiap sinyal: deteksi pertama, transisi tahap, invalidasi, dan kedaluwarsa.',
  },
  panel({ title: 'Riwayat sinyal', flush: true },
    dataTable({
      columns: [
        { key: 'firstDetectedAt', label: 'Deteksi pertama' },
        { key: 'symbol', label: 'Symbol' },
        { key: 'pattern', label: 'Pola' },
        { key: 'timeframe', label: 'TF' },
        { key: 'stage', label: 'Tahap terakhir' },
        { key: 'confirmedAt', label: 'Konfirmasi' },
        { key: 'invalidatedAt', label: 'Invalidasi' },
        { key: 'expiresAt', label: 'Kedaluwarsa' },
        { key: 'move', label: 'Pergerakan', numeric: true },
      ],
      rows: [],
      empty: emptyState({ iconName: 'signals', title: 'Belum ada riwayat sinyal', text: `Transisi state machine dipersistensi mulai ${milestoneLabel(3)}.` }),
    })));
}
