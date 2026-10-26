// Status milestone yang ditampilkan di UI (Overview, Lab, Backtest). Diperbarui manual setiap milestone berganti
// status — selaras dengan tabel status di README.md. Modul ini juga menyediakan tampilan "segera hadir" untuk fitur
// yang belum dibangun: ilustrasi jaringan saraf dekoratif (SVG, aria-hidden) TANPA angka atau hasil apa pun.
import { badge } from '../lib/components.js';
import { h, icon } from '../lib/dom.js';

export const MILESTONES = [
  { n: 1, title: 'Fondasi', text: 'Arsitektur, autentikasi, shell frontend, API, migrasi', state: 'done' },
  { n: 2, title: 'Data pasar', text: 'Binance REST/WS, candle historis, validasi, worker', state: 'done' },
  { n: 3, title: 'Mesin pola', text: 'SA, PVA, SD, PVD, hybrid timeframe, skor, state machine', state: 'done' },
  { n: 4, title: 'Dashboard premium', text: 'Screener, grafik candlestick, update real-time', state: 'active' },
  { n: 5, title: 'Pattern Discovery Lab', text: 'Upload, anotasi, definisi pola berversi, replay', state: 'todo' },
  { n: 6, title: 'Backtesting', text: 'Replay historis, metrik, out-of-sample', state: 'todo' },
  { n: 7, title: 'Keamanan & QA', text: 'Uji positif/negatif/edge, pemindaian, pentest', state: 'active' },
  { n: 8, title: 'Deployment privat', text: 'Docker, HTTPS, backup, monitoring', state: 'todo' },
];

export const milestoneLabel = (n) => `Milestone ${n} — ${MILESTONES[n - 1].title}`;

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// Tata letak node tetap (viewBox 320×200): tiga lapis seperti jaringan saraf kecil. Murni dekoratif.
const ART_NODES = [
  [36, 52], [36, 100], [36, 148],
  [124, 36], [124, 84], [124, 128], [124, 170],
  [212, 60], [212, 112], [212, 158],
  [288, 100],
];
const ART_EDGES = [
  [0, 3], [0, 4], [1, 4], [1, 5], [2, 5], [2, 6], [0, 5], [2, 4],
  [3, 7], [4, 7], [4, 8], [5, 8], [5, 9], [6, 9], [3, 8], [6, 8],
  [7, 10], [8, 10], [9, 10],
];

/**
 * Ilustrasi sinaps SVG dekoratif (aria-hidden): edge dengan pulsa merambat & node berdenyut lewat CSS
 * (symbol.css, dimatikan oleh prefers-reduced-motion / data-motion="off").
 * @param {'accent'|'bull'|'bear'|'violet'} [tone]
 */
export function synapseArt(tone = 'accent') {
  const root = svg('svg', { class: 'synapse-art', viewBox: '0 0 320 200', 'aria-hidden': 'true', focusable: 'false' });
  root.dataset.tone = tone;
  const edges = svg('g', { class: 'synapse-art__edges' });
  const pulses = svg('g', { class: 'synapse-art__pulses' });
  ART_EDGES.forEach(([a, b], i) => {
    const [x1, y1] = ART_NODES[a];
    const [x2, y2] = ART_NODES[b];
    edges.append(svg('line', { class: 'synapse-art__edge', x1, y1, x2, y2 }));
    // Pulsa hanya pada sebagian edge, dengan jeda berbeda agar terasa organik.
    if (i % 3 === 0) {
      const pulse = svg('line', { class: 'synapse-art__pulse', x1, y1, x2, y2, pathLength: 100 });
      pulse.style.setProperty('--lr-synapse-delay', `${(i * 0.37) % 3.2}s`);
      pulses.append(pulse);
    }
  });
  const nodes = svg('g', { class: 'synapse-art__nodes' });
  ART_NODES.forEach(([cx, cy], i) => {
    const node = svg('circle', { class: 'synapse-art__node', cx, cy, r: i === ART_NODES.length - 1 ? 7 : 4.5 });
    node.style.setProperty('--lr-synapse-delay', `${(i * 0.29) % 2.4}s`);
    nodes.append(node);
  });
  const core = svg('circle', { class: 'synapse-art__core', cx: 288, cy: 100, r: 16 });
  root.append(edges, pulses, core, nodes);
  return root;
}

/**
 * Kartu "segera hadir" untuk fitur yang belum dibangun. Hanya teks rencana nyata (milestone & kemampuan yang
 * direncanakan) — tidak ada angka, metrik, atau hasil contoh.
 * @param {{ milestone: number, iconName: string, title: string, text: string, plans?: string[],
 *   tone?: 'accent'|'bull'|'bear'|'violet', testId?: string }} options
 */
export function comingSoon({ milestone, iconName, title, text, plans = [], tone = 'accent', testId }) {
  const m = MILESTONES[milestone - 1];
  return h('section', { class: 'soon', 'data-tone': tone, 'data-testid': testId, 'aria-label': title },
    h('div', { class: 'soon__art' }, synapseArt(tone)),
    h('div', { class: 'soon__body' },
      h('div', { class: 'soon__eyebrow' },
        icon(iconName, 'soon__icon'),
        badge('Segera hadir', 'accent'),
        h('span', { class: 'soon__milestone' }, milestoneLabel(milestone)),
        m?.state === 'active' ? badge('Sedang dikerjakan', 'bull') : null),
      h('h2', { class: 'soon__title' }, title),
      h('p', { class: 'soon__text' }, text),
      plans.length
        ? h('ul', { class: 'soon__plans', 'aria-label': 'Kemampuan yang direncanakan' },
          plans.map((p) => h('li', { class: 'soon__plan' }, h('span', { class: 'soon__plan-dot', 'aria-hidden': 'true' }), p)))
        : null));
}
