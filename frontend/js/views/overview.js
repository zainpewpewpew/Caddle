import { api } from '../lib/api.js';
import { badge, dataTable, emptyState, page, panel, stage, stat, statusPill } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatInteger, formatRelative, formatUtc } from '../lib/format.js';
import { MILESTONES, milestoneLabel } from './roadmap.js';

export async function overviewView() {
  const data = await api('/api/overview');
  const noScanner = data.scanner.status === 'not_implemented';

  const kpis = h('div', { class: 'grid grid--kpi' },
    stat({ label: 'Simbol dipantau', value: formatInteger(data.monitoredSymbols), hint: 'USDT-M perpetual', testId: 'kpi-monitored' }),
    stat({ label: 'Kandidat LONG aktif', value: formatInteger(data.activeSignals), hint: 'QUIET → BREAKOUT', testId: 'kpi-active' }),
    stat({ label: 'Sinyal tahap awal', value: formatInteger(data.earlySignals), hint: 'EARLY_BULLISH' }),
    stat({ label: 'Konfirmasi multi-TF', value: '—', muted: true, hint: `Tersedia di ${milestoneLabel(3)}` }),
    stat({
      label: 'Ingesti terakhir',
      value: data.lastIngestionAt ? formatRelative(data.lastIngestionAt) : '—',
      muted: !data.lastIngestionAt,
      hint: data.lastIngestionAt ? formatUtc(data.lastIngestionAt) : 'Belum ada candle tersimpan',
    }),
  );

  const market = panel({ title: 'Konteks pasar · BTC & ETH', actions: badge('Belum aktif') },
    emptyState({
      iconName: 'symbol',
      title: 'Konteks BTC/ETH belum tersedia',
      text: `Data ini akan diambil dari Binance USDT-M Futures setelah ${milestoneLabel(2)}. Tidak ada data contoh yang ditampilkan.`,
    }));

  const detections = panel({ title: 'Deteksi pola terbaru', flush: true },
    dataTable({
      compact: true,
      caption: 'Deteksi pola terbaru',
      columns: [
        { key: 'symbol', label: 'Symbol' },
        { key: 'timeframe', label: 'TF' },
        { key: 'classification', label: 'Pola' },
        { key: 'state', label: 'Tahap', render: (r) => stage(r.state) },
        { key: 'first_detected_at', label: 'Deteksi pertama', render: (r) => formatUtc(r.first_detected_at) },
      ],
      rows: data.recentDetections,
      empty: emptyState({ iconName: 'radar', title: 'Belum ada deteksi', text: 'Detektor SA/PVA berjalan setelah data pasar dan mesin pola tersedia.' }),
    }));

  const status = panel({ title: 'Status pemindaian' },
    h('dl', { class: 'kv' },
      h('dt', null, 'Scanner'), h('dd', null, noScanner ? statusPill('idle', 'Belum diimplementasi') : statusPill('ok', 'Berjalan', { live: true })),
      h('dt', null, 'Koneksi Binance'), h('dd', null, statusPill('idle', 'Belum diimplementasi')),
      h('dt', null, 'Kesegaran data'), h('dd', null, data.lastIngestionAt ? formatRelative(data.lastIngestionAt) : '—'),
      h('dt', null, 'Timeframe'), h('dd', { class: 'mono' }, '5m · 15m · 1h')));

  const roadmap = panel({ title: 'Roadmap' },
    h('ol', { class: 'timeline' }, MILESTONES.map((m) => h('li', { class: 'timeline__item', 'data-state': m.state },
      h('span', { class: 'timeline__dot', 'aria-hidden': 'true' }),
      h('span', null, h('span', { class: 'timeline__title' }, `${m.n}. ${m.title}`), h('br'), h('span', { class: 'timeline__text' }, m.text)),
      m.state === 'active' ? badge('Berjalan', 'accent') : null))));

  return page({
    title: 'Overview',
    subtitle: 'Ringkasan kondisi pemindaian. Semua angka berasal dari database; nilai nol berarti memang belum ada data.',
  },
  kpis,
  h('div', { class: 'grid grid--main-side' },
    h('div', { class: 'stack' }, market, detections),
    h('div', { class: 'stack' }, status, roadmap)));
}
