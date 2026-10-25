import { callout, emptyState, page, panel, stat } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { milestoneLabel } from './roadmap.js';

const METRICS = ['Jumlah sinyal', 'Target sebelum invalidasi', 'MFE rata-rata', 'MAE rata-rata', 'Waktu ke breakout'];

export async function backtestView() {
  return page({
    title: 'Backtest Lab',
    subtitle: 'Replay historis deterministik dengan pemisahan data train, validasi, dan out-of-sample.',
  },
  callout([h('strong', null, 'Catatan: '), 'metrik hanya ditampilkan dari backtest yang benar-benar dijalankan. Hasil in-sample tidak boleh dianggap bukti profitabilitas.']),
  h('div', { class: 'grid grid--kpi' }, METRICS.map((label) => stat({ label, value: '—', muted: true, hint: 'Belum ada run' }))),
  panel({ title: 'Run backtest' },
    emptyState({ iconName: 'backtest', title: 'Belum ada run backtest', text: `Mesin backtest (fee, spread, slippage, walk-forward) dibangun di ${milestoneLabel(6)}.` })));
}
