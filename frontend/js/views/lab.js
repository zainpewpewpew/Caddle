import { callout, emptyState, page, panel } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { milestoneLabel } from './roadmap.js';

const PIPELINE = ['Upload screenshot', 'Anotasi', 'Deskripsi pola', 'Ekstraksi fitur', 'Usulan aturan', 'Review manusia', 'Replay historis', 'Backtest', 'Validasi', 'Aktivasi'];

export async function labView() {
  return page({
    title: 'Pattern Discovery Lab',
    subtitle: 'Ruang riset untuk merumuskan pola grafik kustom menjadi aturan deklaratif yang dapat diuji.',
  },
  callout([h('strong', null, 'Prinsip: '), 'screenshot tidak pernah otomatis menjadi aturan live. Interpretasi visual adalah hipotesis sampai diverifikasi terhadap data OHLCV historis dan direview pengguna.'], 'warn'),
  panel({ title: 'Alur kerja' },
    h('ol', { class: 'timeline' }, PIPELINE.map((step, i) => h('li', { class: 'timeline__item' },
      h('span', { class: 'timeline__dot', 'aria-hidden': 'true' }),
      h('span', null, h('span', { class: 'timeline__title' }, `${i + 1}. ${step}`)),
      null)))),
  panel({ title: 'Definisi pola' },
    emptyState({ iconName: 'lab', title: 'Belum ada definisi pola', text: `Upload aman, anotasi, dan definisi pola JSON berversi dibangun di ${milestoneLabel(5)}.` })));
}
