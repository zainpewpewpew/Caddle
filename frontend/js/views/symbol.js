import { emptyState, page, panel } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { milestoneLabel } from './roadmap.js';

const OVERLAYS = ['EMA7', 'EMA25', 'EMA99', 'ATR', 'RVOL', 'Swing high/low', 'Support/resistance', 'Penanda pola', 'Deteksi pertama', 'Level invalidasi'];

export async function symbolView() {
  return page({
    title: 'Symbol Intelligence',
    subtitle: 'Analisis mendalam satu simbol: grafik candlestick, indikator, dan penjelasan sinyal.',
  },
  h('div', { class: 'grid grid--main-side' },
    panel({ title: 'Grafik' },
      emptyState({
        iconName: 'symbol',
        title: 'Grafik belum tersedia',
        text: `Grafik TradingView Lightweight Charts dengan volume dan overlay indikator dibangun di ${milestoneLabel(4)}, setelah candle historis tersedia.`,
      })),
    h('div', { class: 'stack' },
      panel({ title: 'Overlay yang direncanakan' },
        h('div', { class: 'cluster' }, OVERLAYS.map((o) => h('span', { class: 'badge' }, o)))),
      panel({ title: 'Penjelasan risiko' },
        h('p', { class: 'muted' }, 'Setiap sinyal akan menampilkan alasan skor, risk flag, dan konteks timeframe lebih tinggi.')))));
}
