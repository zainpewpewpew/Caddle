// Komponen UI yang dapat dipakai ulang. Semua merender lewat h() (aman XSS).
import { h, icon } from './dom.js';

export function page({ title, subtitle, actions }, ...content) {
  return h('section', { class: 'page' },
    h('header', { class: 'page__header' },
      h('div', null,
        h('h1', { class: 'page__title' }, title),
        subtitle && h('p', { class: 'page__subtitle' }, subtitle)),
      actions && h('div', { class: 'cluster' }, actions)),
    content);
}

export function panel({ title, actions, flush = false, footer, id }, ...body) {
  return h('section', { class: 'panel', id },
    title && h('header', { class: 'panel__header' },
      h('h2', { class: 'panel__title' }, title),
      actions && h('div', { class: 'panel__actions' }, actions)),
    h('div', { class: flush ? 'panel__body panel__body--flush' : 'panel__body' }, body),
    footer && h('footer', { class: 'panel__footer' }, footer));
}

export function stat({ label, value, hint, muted = false, testId }) {
  return h('div', { class: 'stat', 'data-testid': testId },
    h('span', { class: 'stat__label' }, label),
    h('span', { class: muted ? 'stat__value stat__value--muted' : 'stat__value' }, value),
    hint && h('span', { class: 'stat__hint' }, hint));
}

export function emptyState({ iconName = 'radar', title, text, action }) {
  return h('div', { class: 'empty' },
    icon(iconName, 'empty__icon'),
    h('p', { class: 'empty__title' }, title),
    text && h('p', { class: 'empty__text' }, text),
    action);
}

export function badge(text, tone) {
  return h('span', { class: tone ? `badge badge--${tone}` : 'badge' }, text);
}

export function statusPill(state, text, { live = false } = {}) {
  return h('span', { class: 'status', 'data-state': state, 'data-live': live || undefined },
    h('span', { class: 'status__dot', 'aria-hidden': 'true' }), text);
}

export function stage(state, label = state.replaceAll('_', ' ')) {
  return h('span', { class: 'stage', 'data-stage': state }, label);
}

export function score(value, tone = 'accent') {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  return h('span', { class: 'score', 'data-tone': tone },
    h('span', { class: 'num' }, String(Math.round(clamped))),
    h('span', { class: 'score__track', 'aria-hidden': 'true' },
      h('span', { class: 'score__fill', style: { '--lr-score': clamped } })));
}

/**
 * Tabel data dengan header yang dapat diurutkan (klik / Enter).
 * @param {{ columns: Array<{ key: string, label: string, numeric?: boolean, sortable?: boolean,
 *   render?: (row: any) => any, sortValue?: (row: any) => any }>, rows: any[], empty?: Node,
 *   initialSort?: { key: string, dir: 'asc' | 'desc' }, compact?: boolean, caption?: string }} options
 */
export function dataTable({ columns, rows, empty, initialSort, compact = false, caption }) {
  let sort = initialSort ?? null;
  const tbody = h('tbody');
  const headCells = new Map();
  // Empty state dirender di luar area scroll tabel agar tetap terbaca di layar sempit.
  const emptyHost = h('div', { class: 'table-empty', hidden: true }, empty ?? h('p', { class: 'empty' }, 'Tidak ada data'));

  const sortedRows = () => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    const get = col?.sortValue ?? ((row) => row[sort.key]);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return va > vb ? dir : -dir;
    });
  };

  const renderBody = () => {
    const data = sortedRows();
    emptyHost.hidden = data.length > 0;
    tbody.replaceChildren(...data.map((row) => h('tr', null,
      columns.map((c) => h('td', { class: c.numeric ? 'num' : undefined }, c.render ? c.render(row) : row[c.key] ?? '—')))));
  };

  const updateHeader = () => {
    for (const [key, th] of headCells) {
      th.setAttribute('aria-sort', sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
  };

  const thead = h('thead', null, h('tr', null, columns.map((c) => {
    const th = h('th', { scope: 'col', class: c.numeric ? 'num' : undefined },
      c.sortable === false ? c.label : h('button', {
        class: 'sort-btn',
        type: 'button',
        on: {
          click: () => {
            sort = sort?.key === c.key ? { key: c.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.numeric ? 'desc' : 'asc' };
            updateHeader();
            renderBody();
          },
        },
      }, c.label));
    if (c.sortable !== false) headCells.set(c.key, th);
    return th;
  })));

  updateHeader();
  renderBody();
  return h('div', null,
    h('div', { class: 'table-wrap' },
      h('table', { class: compact ? 'table table--compact' : 'table' },
        caption && h('caption', { class: 'sr-only' }, caption), thead, tbody)),
    emptyHost);
}

export function selectField({ label, name, options, value, hint }) {
  const id = `f-${name}`;
  return h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    h('select', { class: 'select', id, name },
      options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))),
    hint && h('span', { class: 'field__hint' }, hint));
}

export function inputField({ label, name, value = '', type = 'text', hint, attrs = {} }) {
  const id = `f-${name}`;
  return h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    h('input', { class: 'input', id, name, type, value, ...attrs }),
    hint && h('span', { class: 'field__hint' }, hint),
    h('span', { class: 'field__error', 'data-error-for': name, hidden: true }));
}

export function segmented({ name, options, value, type = 'radio', label }) {
  const values = new Set(Array.isArray(value) ? value : [value]);
  return h('div', { class: 'segmented', role: type === 'radio' ? 'radiogroup' : 'group', 'aria-label': label },
    options.map((o) => h('label', { class: 'segmented__option' },
      h('input', { type, name, value: o.value, checked: values.has(o.value) }),
      h('span', null, o.label))));
}

export function toggle({ name, label, checked }) {
  return h('label', { class: 'switch' },
    h('input', { type: 'checkbox', name, role: 'switch', checked }),
    h('span', null, label));
}

export function callout(content, tone) {
  return h('div', { class: tone ? `callout callout--${tone}` : 'callout', role: 'note' }, content);
}

let toastHost;
export function toast(message, tone = 'accent') {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: 'toast', 'data-tone': tone }, message);
  toastHost.append(el);
  setTimeout(() => el.remove(), 4000);
}
