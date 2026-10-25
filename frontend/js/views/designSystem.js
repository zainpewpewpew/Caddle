import { badge, callout, dataTable, emptyState, inputField, page, panel, score, segmented, selectField, stage, stat, statusPill, toggle } from '../lib/components.js';
import { h } from '../lib/dom.js';

// Halaman referensi design system untuk review visual. Tabel memakai baris ilustratif
// yang ditandai jelas — bukan data pasar.

const COLORS = [
  ['Background', '--lr-bg'], ['Surface', '--lr-surface'], ['Surface elevated', '--lr-surface-2'], ['Border', '--lr-border'],
  ['Teks utama', '--lr-text'], ['Teks sekunder', '--lr-text-2'], ['Bullish', '--lr-bull'], ['Warning', '--lr-warn'],
  ['Bearish', '--lr-bear'], ['Accent', '--lr-accent'],
];

const TYPE = [
  ['2xl · KPI', '--lr-text-2xl', '26px / 600'], ['xl · Judul halaman', '--lr-text-xl', '20px / 600'],
  ['lg · Judul seksi', '--lr-text-lg', '16px / 600'], ['md · Penekanan', '--lr-text-md', '14px / 500'],
  ['sm · Teks dasar', '--lr-text-sm', '13px / 400'], ['xs · Metadata', '--lr-text-xs', '12px / 400'],
  ['2xs · Label tabel', '--lr-text-2xs', '11px / 600'],
];

const ILLUSTRATIVE_ROWS = [
  { symbol: 'DEMO-A', tf: '15m', pattern: 'SA', p: 78, e: 84, stage: 'EARLY_BULLISH', align: 'ALIGNED' },
  { symbol: 'DEMO-B', tf: '5m', pattern: 'PVA', p: 66, e: 52, stage: 'MOMENTUM_BUILDING', align: 'PARTIALLY_CONFIRMED' },
  { symbol: 'DEMO-C', tf: '1h', pattern: 'BOTH', p: 91, e: 38, stage: 'BREAKOUT', align: 'ALIGNED' },
  { symbol: 'DEMO-D', tf: '15m', pattern: 'SA', p: 44, e: 70, stage: 'INVALIDATED', align: 'COUNTERTREND' },
];

const ALIGN_TONE = { ALIGNED: 'bull', PARTIALLY_CONFIRMED: 'accent', UNCONFIRMED: undefined, COUNTERTREND: 'warn' };

export async function designSystemView() {
  const styles = getComputedStyle(document.documentElement);

  return page({
    title: 'Design System',
    subtitle: 'Referensi token dan komponen. Semua nilai berasal dari css/tokens.css.',
  },
  panel({ title: 'Warna' },
    h('div', { class: 'swatches' }, COLORS.map(([name, token]) => h('div', { class: 'swatch' },
      h('div', { class: 'swatch__color', style: { '--lr-swatch': `var(${token})` } }),
      h('div', { class: 'swatch__meta' }, h('span', null, name), h('span', null, `${token} ${styles.getPropertyValue(token).trim()}`)))))),
  h('div', { class: 'grid grid--2' },
    panel({ title: 'Tipografi' },
      TYPE.map(([label, token, meta]) => h('div', { class: 'type-sample' },
        h('span', { style: { 'font-size': `var(${token})` } }, label),
        h('span', { class: 'type-sample__meta' }, meta))),
      h('div', { class: 'type-sample' }, h('span', { class: 'mono' }, '0.00012345  64,250.10  +2.41%'), h('span', { class: 'type-sample__meta' }, 'mono · tabular'))),
    panel({ title: 'Status & tahap sinyal' },
      h('div', { class: 'stack' },
        h('div', { class: 'cluster' }, ['QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'INVALIDATED', 'EXPIRED'].map((s) => stage(s))),
        h('div', { class: 'cluster' }, badge('SA', 'bull'), badge('PVA', 'accent'), badge('BOTH', 'bull'), badge('Wide spread', 'warn'), badge('Countertrend', 'bear'), badge('Netral')),
        h('div', { class: 'cluster' }, statusPill('ok', 'Terhubung', { live: true }), statusPill('warn', 'Lag 2 candle'), statusPill('error', 'Terputus'), statusPill('idle', 'Idle')),
        h('div', { class: 'cluster' }, score(84, 'bull'), score(61), score(35, 'warn')),
        h('div', { class: 'cluster' }, h('span', { class: 'delta delta--up' }, '+3,12%'), h('span', { class: 'delta delta--down' }, '−1,04%'), h('span', { class: 'delta delta--flat' }, '0,00%'))))),
  h('div', { class: 'grid grid--kpi' },
    stat({ label: 'Stat tile', value: '42', hint: 'Dengan hint' }),
    stat({ label: 'Nilai belum ada', value: '—', muted: true, hint: 'State kosong yang jujur' })),
  panel({ title: 'Tombol & kontrol' },
    h('div', { class: 'stack' },
      h('div', { class: 'cluster' },
        h('button', { class: 'btn btn--primary', type: 'button' }, 'Primary'),
        h('button', { class: 'btn', type: 'button' }, 'Default'),
        h('button', { class: 'btn btn--ghost', type: 'button' }, 'Ghost'),
        h('button', { class: 'btn btn--danger', type: 'button' }, 'Danger'),
        h('button', { class: 'btn', type: 'button', disabled: true }, 'Disabled'),
        h('button', { class: 'btn btn--sm', type: 'button' }, 'Small')),
      h('div', { class: 'form-grid' },
        inputField({ label: 'Input', name: 'demo-input', value: '', attrs: { placeholder: 'BTCUSDT' } }),
        selectField({ label: 'Select', name: 'demo-select', options: [{ value: '15m', label: '15m' }, { value: '1h', label: '1h' }] }),
        h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Segmented'), segmented({ name: 'demo-seg', label: 'Contoh', value: '15m', options: [{ value: '5m', label: '5m' }, { value: '15m', label: '15m' }, { value: '1h', label: '1h' }] })),
        h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Toggle'), toggle({ name: 'demo-toggle', label: 'Aktif', checked: true }))))),
  panel({ title: 'Tabel data', actions: badge('Data ilustratif · bukan data pasar', 'warn'), flush: true },
    dataTable({
      caption: 'Contoh tabel',
      initialSort: { key: 'e', dir: 'desc' },
      columns: [
        { key: 'symbol', label: 'Symbol', render: (r) => h('span', { class: 'symbol' }, r.symbol) },
        { key: 'tf', label: 'TF' },
        { key: 'pattern', label: 'Pola', render: (r) => badge(r.pattern, r.pattern === 'PVA' ? 'accent' : 'bull') },
        { key: 'p', label: 'Pattern Score', numeric: true, render: (r) => score(r.p, 'accent') },
        { key: 'e', label: 'Early Score', numeric: true, render: (r) => score(r.e, 'bull') },
        { key: 'align', label: 'Alignment', render: (r) => badge(r.align.replaceAll('_', ' '), ALIGN_TONE[r.align]) },
        { key: 'stage', label: 'Tahap', render: (r) => stage(r.stage) },
      ],
      rows: ILLUSTRATIVE_ROWS,
    })),
  h('div', { class: 'grid grid--2' },
    panel({ title: 'Empty state' }, emptyState({ title: 'Belum ada data', text: 'Komponen ini dipakai bila data memang belum tersedia — tidak pernah diganti data palsu.' })),
    panel({ title: 'Callout' }, h('div', { class: 'stack' },
      callout('Informasi netral.'),
      callout('Peringatan: candle belum tertutup.', 'warn'),
      callout('Risiko: likuiditas rendah.', 'bear')))));
}
