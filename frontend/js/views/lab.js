// Pattern Discovery Lab (Milestone 5) — belum dibangun. Halaman ini hanya menjelaskan prinsip & alur kerja yang
// direncanakan; tidak ada definisi pola, hasil, atau angka contoh.
import { callout, emptyState, page, panel } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { comingSoon, milestoneLabel } from './roadmap.js';

const PIPELINE = ['Upload screenshot', 'Anotasi', 'Deskripsi pola', 'Ekstraksi fitur', 'Usulan aturan', 'Review manusia', 'Replay historis', 'Backtest', 'Validasi', 'Aktivasi'];

/** Alur kerja sebagai rantai sinaps: setiap tahap satu node, tersambung ke tahap berikutnya. */
function pipelineChain() {
  return h('ol', { class: 'synapse-chain', 'aria-label': 'Alur kerja Pattern Discovery Lab' },
    PIPELINE.map((step, i) => h('li', { class: 'synapse-chain__step', style: { '--lr-step': i } },
      h('span', { class: 'synapse-chain__node', 'aria-hidden': 'true' }, String(i + 1)),
      h('span', { class: 'synapse-chain__label' }, step))));
}

export async function labView() {
  return page({
    title: 'Pattern Discovery Lab',
    subtitle: 'Ruang riset untuk merumuskan pola grafik kustom menjadi aturan deklaratif yang dapat diuji.',
  },
  comingSoon({
    milestone: 5,
    iconName: 'lab',
    tone: 'violet',
    testId: 'lab-coming-soon',
    title: 'Laboratorium pola sedang dirakit',
    text: 'Di sini screenshot grafik akan dianotasi, diubah menjadi fitur terukur, lalu diusulkan sebagai aturan deklaratif berversi. Setiap aturan wajib lolos replay historis dan review manusia sebelum boleh aktif.',
    plans: ['Upload aman & anotasi area pola', 'Definisi pola JSON berversi', 'Replay aturan pada candle historis', 'Review manusia sebelum aktivasi'],
  }),
  callout([h('strong', null, 'Prinsip: '), 'screenshot tidak pernah otomatis menjadi aturan live. Interpretasi visual adalah hipotesis sampai diverifikasi terhadap data OHLCV historis dan direview pengguna.'], 'warn'),
  panel({ title: 'Alur kerja yang direncanakan' }, pipelineChain()),
  panel({ title: 'Definisi pola' },
    emptyState({ iconName: 'lab', title: 'Belum ada definisi pola', text: `Upload aman, anotasi, dan definisi pola JSON berversi dibangun di ${milestoneLabel(5)}.` })));
}
