// Backtest Lab (Milestone 6) — belum dibangun. Tidak ada run, jadi tidak ada angka: halaman hanya menjelaskan
// metrik yang AKAN diukur dan aturan mainnya. Metrik hanya boleh tampil dari backtest yang benar-benar dijalankan.
import { callout, emptyState, page, panel } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { comingSoon, milestoneLabel } from './roadmap.js';

const METRICS = [
  { label: 'Jumlah sinyal', text: 'Berapa kali pola terdeteksi pada periode uji.' },
  { label: 'Target sebelum invalidasi', text: 'Porsi sinyal yang mencapai target lebih dulu daripada level invalidasi.' },
  { label: 'MFE rata-rata', text: 'Pergerakan menguntungkan maksimum setelah deteksi.' },
  { label: 'MAE rata-rata', text: 'Pergerakan merugikan maksimum setelah deteksi.' },
  { label: 'Waktu ke breakout', text: 'Jarak candle dari deteksi pertama ke tahap breakout/breakdown.' },
];

export async function backtestView() {
  return page({
    title: 'Backtest Lab',
    subtitle: 'Replay historis deterministik dengan pemisahan data train, validasi, dan out-of-sample.',
  },
  comingSoon({
    milestone: 6,
    iconName: 'backtest',
    tone: 'accent',
    testId: 'backtest-coming-soon',
    title: 'Mesin replay historis segera hadir',
    text: 'Backtest akan memutar ulang candle tertutup secara deterministik — lengkap dengan fee, spread, dan slippage — lalu menguji aturan pola secara walk-forward dengan data out-of-sample yang tidak pernah dipakai saat merumuskan aturan.',
    plans: ['Replay deterministik candle tertutup', 'Biaya realistis: fee, spread, slippage', 'Walk-forward & out-of-sample', 'Laporan per pola & per arah (LONG/SHORT)'],
  }),
  callout([h('strong', null, 'Catatan: '), 'metrik hanya ditampilkan dari backtest yang benar-benar dijalankan. Hasil in-sample tidak boleh dianggap bukti profitabilitas.']),
  panel({ title: 'Metrik yang akan diukur' },
    h('ul', { class: 'metric-plan' }, METRICS.map((m) => h('li', { class: 'metric-plan__item' },
      h('span', { class: 'metric-plan__label' }, m.label),
      h('span', { class: 'metric-plan__text' }, m.text),
      h('span', { class: 'metric-plan__state' }, 'Belum ada run'))))),
  panel({ title: 'Run backtest' },
    emptyState({ iconName: 'backtest', title: 'Belum ada run backtest', text: `Mesin backtest (fee, spread, slippage, walk-forward) dibangun di ${milestoneLabel(6)}.` })));
}
