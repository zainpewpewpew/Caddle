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

// Baris → data barisnya, dan tbody → fungsi pewarna seleksinya (hanya tabel dengan onRowSelect).
// WeakMap: tidak menahan baris/tabel yang sudah dibuang dari DOM.
const ROW_DATA = new WeakMap();
const SELECTION_PAINTERS = new WeakMap();
const INNER_CONTROL = 'a, button, input, select, textarea, label, summary, [role="button"]';
// Tombol navigasi antarbaris tabel yang dapat dipilih → baris tujuan dari baris yang sedang difokus.
const ROW_NAV_KEYS = {
  ArrowDown: (tr) => tr.nextElementSibling,
  ArrowUp: (tr) => tr.previousElementSibling,
  Home: (tr) => tr.parentNode.firstElementChild,
  End: (tr) => tr.parentNode.lastElementChild,
};

/**
 * Tabel data dengan header yang dapat diurutkan (klik / Enter).
 * Opsional `onRowSelect(row)`: baris dapat dipilih (klik, Enter/Spasi saat baris terfokus), kursor pointer,
 * `aria-current="true"` + `data-selected` pada baris terpilih. Satu tab stop per tabel (roving tabindex: baris
 * terfokus → terpilih → pertama); panah atas/bawah, Home/End memindahkan fokus antarbaris tanpa memilih, sehingga
 * Tab langsung keluar dari tabel. Tanpa opsi ini tabel berperilaku persis seperti sebelumnya.
 * `isRowSelected(row)` (opsional) membuat status terpilih ditentukan pemanggil — dipakai agar seleksi
 * bertahan saat tabel dibuat ulang (filter/refresh); tanpa itu seleksi disimpan per tabel (referensi baris).
 * @param {{ columns: Array<{ key: string, label: string, numeric?: boolean, sortable?: boolean,
 *   render?: (row: any) => any, sortValue?: (row: any) => any }>, rows: any[], empty?: Node,
 *   initialSort?: { key: string, dir: 'asc' | 'desc' }, compact?: boolean, caption?: string,
 *   onRowSelect?: (row: any) => void, isRowSelected?: (row: any) => boolean }} options
 */
export function dataTable({ columns, rows, empty, initialSort, compact = false, caption, onRowSelect, isRowSelected }) {
  let sort = initialSort ?? null;
  const tbody = h('tbody');
  const selectable = typeof onRowSelect === 'function';
  let selectedRow = null;
  const isSelected = (row) => (typeof isRowSelected === 'function' ? Boolean(isRowSelected(row)) : row === selectedRow);
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

  const setTabStop = (target) => {
    for (const tr of tbody.children) tr.tabIndex = tr === target ? 0 : -1;
  };

  // aria-current, bukan aria-selected: tabel biasa (bukan grid) tidak mengumumkan aria-selected secara andal.
  const paintSelection = () => {
    let selectedEl = null;
    for (const tr of tbody.children) {
      const on = ROW_DATA.has(tr) && isSelected(ROW_DATA.get(tr));
      if (on) {
        tr.setAttribute('aria-current', 'true');
        tr.dataset.selected = 'true';
        selectedEl ??= tr;
      } else {
        tr.removeAttribute('aria-current');
        delete tr.dataset.selected;
      }
    }
    const active = document.activeElement;
    setTabStop(active?.parentNode === tbody ? active : selectedEl ?? tbody.firstElementChild);
  };

  const selectRow = (row) => {
    selectedRow = row;
    onRowSelect(row);
    paintSelection();
  };

  const cellsOf = (row) => columns.map((c) => h('td', { class: c.numeric ? 'num' : undefined }, c.render ? c.render(row) : row[c.key] ?? '—'));

  const rowEl = (row) => {
    if (!selectable) return h('tr', null, cellsOf(row));
    const tr = h('tr', {
      class: 'table__row--selectable',
      tabindex: -1, // satu-satunya tab stop (0) ditetapkan paintSelection()
      on: {
        click: (e) => {
          // Kontrol di dalam sel (tautan, tombol) tetap menjalankan aksinya sendiri tanpa memilih baris.
          const control = e.target instanceof Element ? e.target.closest(INNER_CONTROL) : null;
          if (control && control !== e.currentTarget && e.currentTarget.contains(control)) return;
          selectRow(row);
        },
        keydown: (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); // Spasi tidak menggulir halaman
            selectRow(row);
            return;
          }
          const move = Object.hasOwn(ROW_NAV_KEYS, e.key) && !e.altKey && !e.ctrlKey && !e.metaKey ? ROW_NAV_KEYS[e.key] : null;
          const next = move?.(e.currentTarget);
          if (!next) return;
          e.preventDefault(); // panah/Home/End tidak menggulir halaman
          setTabStop(next);
          next.focus();
        },
      },
    }, cellsOf(row));
    ROW_DATA.set(tr, row);
    return tr;
  };

  const renderBody = () => {
    const data = sortedRows();
    emptyHost.hidden = data.length > 0;
    tbody.replaceChildren(...data.map(rowEl));
    if (selectable) paintSelection();
  };

  if (selectable) {
    tbody.dataset.selectable = 'true';
    SELECTION_PAINTERS.set(tbody, paintSelection);
  }

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

/**
 * Menyegarkan tanda baris terpilih semua tabel ber-onRowSelect di dalam `scope` (mis. setelah panel grafik
 * ditutup atau pilihan diganti dari luar tabel). Status terpilih dibaca ulang dari isRowSelected tiap tabel.
 * @param {ParentNode} scope
 */
export function refreshRowSelection(scope) {
  for (const tbody of scope.querySelectorAll('tbody[data-selectable]')) SELECTION_PAINTERS.get(tbody)?.();
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
