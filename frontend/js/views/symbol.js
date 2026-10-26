// Symbol Intelligence: halaman detail satu koin — grafik besar, sinyal terpilih/terakhir beserta penjelasan
// kondisinya, transisi tahap, dan riwayat sinyal simbol (GET /api/signals/history?symbol=…).
// Parameter dari hash: #/symbol?s=BTCUSDT&tf=15m&dir=LONG&signal=12 — semuanya opsional kecuali s, dan divalidasi.
import { api } from '../lib/api.js';
import { callout, dataTable, emptyState, page, panel, stage } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatPrice, formatUtc } from '../lib/format.js';
import { hashQuery } from '../lib/router.js';
import { patternBadge } from './signalFormat.js';
import {
  CHART_TIMEFRAMES, createSymbolChartPanel, directionBadge, isValidSymbol, normalizeDirection, normalizeTimeframe,
  signalLevels, signalMarkers, signalSummary, symbolDetailHref,
} from './symbolChart.js';

const HISTORY_LIMIT = 100;
const TERMINAL_STATES = new Set(['INVALIDATED', 'EXPIRED']);
const SUBTITLE = 'Grafik candle tertutup, level sinyal, dan riwayat deteksi satu koin. Skor mengukur kecocokan dengan aturan pola, bukan probabilitas profit — riset saja, bukan saran transaksi.';

/**
 * Parameter halaman dari query hash. Nilai tidak valid diabaikan (simbol dinormalisasi ke huruf kapital).
 * @param {URLSearchParams} query
 */
export function parseSymbolQuery(query) {
  const raw = (query.get('s') ?? '').trim().toUpperCase();
  const tf = query.get('tf');
  const dir = query.get('dir');
  const signal = query.get('signal') ?? '';
  return {
    symbol: isValidSymbol(raw) ? raw : null,
    invalidSymbol: raw !== '' && !isValidSymbol(raw),
    timeframe: CHART_TIMEFRAMES.includes(tf) ? tf : null,
    direction: dir === 'LONG' || dir === 'SHORT' ? dir : null,
    signalId: /^[0-9]{1,12}$/.test(signal) ? Number(signal) : null,
  };
}

const directionOf = (signal) => normalizeDirection(signal?.direction);
const statePath = (signal) => (Array.isArray(signal.events) && signal.events.length
  ? signal.events.map((e) => String(e.toState ?? '?').replaceAll('_', ' ')).join(' → ')
  : '—');

/** Form cari simbol; saran diisi dari simbol yang pernah punya sinyal (tanpa menunda render halaman). */
function searchForm(current, direction) {
  const input = h('input', {
    class: 'input input--mono', id: 'f-symbol-search', name: 'symbol', type: 'text', value: current ?? '',
    placeholder: 'BTCUSDT', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 30,
    list: 'symbol-suggestions', 'aria-describedby': 'symbol-search-error',
  });
  const error = h('span', { class: 'field__error', id: 'symbol-search-error', 'data-error-for': 'symbol', hidden: true });
  const suggestions = h('datalist', { id: 'symbol-suggestions' });
  const form = h('form', { class: 'symbol-search', role: 'search', 'aria-label': 'Cari simbol', novalidate: true },
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'f-symbol-search' }, 'Simbol'), input, error),
    h('button', { class: 'btn btn--primary', type: 'submit' }, 'Tampilkan'),
    suggestions);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim().toUpperCase();
    if (!isValidSymbol(value)) {
      input.setAttribute('aria-invalid', 'true');
      error.textContent = 'Format simbol tidak valid: 2–30 huruf kapital/angka, mis. BTCUSDT.';
      error.hidden = false;
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    error.hidden = true;
    window.location.hash = symbolDetailHref({ symbol: value, direction });
  });

  api(`/api/signals/history?limit=${HISTORY_LIMIT}`)
    .then(({ items }) => {
      const symbols = [...new Set((items ?? []).map((s) => s.symbol).filter(isValidSymbol))].sort();
      suggestions.replaceChildren(...symbols.map((s) => h('option', { value: s })));
    })
    .catch(() => {}); // saran bersifat pelengkap; gagal = tanpa saran
  return form;
}

function noSymbolState(invalid) {
  return [
    invalid ? callout('Simbol di URL tidak valid. Gunakan 2–30 huruf kapital/angka, mis. BTCUSDT.', 'warn') : null,
    panel({ title: 'Grafik simbol' },
      emptyState({
        iconName: 'symbol',
        title: 'Pilih koin terlebih dahulu',
        text: 'Klik baris koin di LONG Scanner atau SHORT Scanner, atau ketik simbol di kolom pencarian (mis. BTCUSDT). Grafik hanya memakai candle tertutup yang tersimpan — tidak ada data contoh.',
        action: h('div', { class: 'cluster' },
          h('a', { class: 'btn btn--sm', href: '#/screener' }, 'Buka LONG Scanner'),
          h('a', { class: 'btn btn--sm', href: '#/short-scanner' }, 'Buka SHORT Scanner')),
      })),
  ];
}

function explanationPanel(signal) {
  const factors = Array.isArray(signal?.explanation) ? signal.explanation : [];
  return panel({ title: 'Penjelasan kondisi' },
    factors.length
      ? h('div', { class: 'stack' },
        h('ul', { class: 'factor-list', 'data-testid': 'signal-explanation' }, factors.map((f) => h('li', { class: 'factor' },
          h('span', { class: 'factor__code mono' }, String(f.factor ?? '—')),
          h('span', { class: 'factor__detail' }, String(f.detail ?? '')),
          typeof f.contribution === 'number' && f.contribution > 0
            ? h('span', { class: 'factor__points num' }, `+${f.contribution.toFixed(1)}`)
            : null))),
        h('p', { class: 'chart-note' }, 'Poin = kontribusi aturan yang terpenuhi terhadap skor pola. Konteks & risiko informatif (0 poin).'))
      : h('p', { class: 'muted' }, signal ? 'Penjelasan kondisi belum tersedia untuk sinyal ini.' : 'Belum ada sinyal untuk simbol ini.'));
}

function transitionsPanel(signal) {
  const events = Array.isArray(signal?.events) ? signal.events : [];
  return panel({ title: 'Transisi tahap' },
    events.length
      ? h('ol', { class: 'timeline' }, events.map((e, i) => h('li', {
        class: 'timeline__item',
        // Tahap terakhir sinyal yang masih terbuka = aktif; sisanya sudah dilalui.
        'data-state': i === events.length - 1 && !TERMINAL_STATES.has(e.toState) ? 'active' : 'done',
      },
        h('span', { class: 'timeline__dot', 'aria-hidden': 'true' }),
        h('span', null,
          h('span', { class: 'timeline__title' }, e.fromState ? [stage(e.fromState), ' → ', stage(e.toState)] : stage(e.toState)),
          h('br'),
          h('span', { class: 'timeline__text' }, `${formatUtc(e.occurredAt)} · harga ${formatPrice(e.price)}`)))))
      : h('p', { class: 'muted' }, signal ? 'Belum ada transisi tercatat.' : 'Belum ada sinyal untuk simbol ini.'));
}

function historyPanel(symbol, signals, focused, error) {
  if (error) return panel({ title: `Riwayat sinyal ${symbol}` }, callout(`Gagal memuat riwayat sinyal: ${error.message}`, 'bear'));
  return panel({
    title: `Riwayat sinyal ${symbol}`,
    flush: true,
    footer: 'Klik baris untuk menampilkan level & penanda sinyal tersebut di grafik. Hanya sinyal dari candle tertutup.',
  },
  dataTable({
    caption: `Riwayat sinyal ${symbol}`,
    initialSort: { key: 'firstDetectedAt', dir: 'desc' },
    rows: signals,
    onRowSelect: (row) => {
      window.location.hash = symbolDetailHref({ symbol, timeframe: row.timeframe, direction: directionOf(row), signalId: row.id });
    },
    isRowSelected: (row) => focused !== null && row.id === focused.id,
    columns: [
      { key: 'firstDetectedAt', label: 'Deteksi pertama', render: (r) => formatUtc(r.firstDetectedAt) },
      { key: 'direction', label: 'Arah', sortValue: directionOf, render: (r) => directionBadge(r.direction) },
      { key: 'timeframe', label: 'TF', render: (r) => h('span', { class: 'mono' }, r.timeframe) },
      { key: 'classification', label: 'Pola', render: (r) => patternBadge(r.classification) },
      { key: 'firstDetectedPrice', label: 'Harga deteksi', numeric: true, render: (r) => formatPrice(r.firstDetectedPrice) },
      { key: 'invalidationPrice', label: 'Invalidasi', numeric: true, render: (r) => formatPrice(r.invalidationPrice) },
      { key: 'state', label: 'Tahap terakhir', render: (r) => (typeof r.state === 'string' ? stage(r.state) : '—') },
      { key: 'events', label: 'Transisi', sortable: false, render: (r) => h('span', { class: 'subtle' }, statePath(r)) },
      { key: 'updatedAt', label: 'Update', render: (r) => formatUtc(r.updatedAt) },
    ],
    empty: emptyState({
      iconName: 'signals',
      title: 'Belum ada riwayat sinyal untuk simbol ini',
      text: 'Riwayat muncul setelah worker mendeteksi pola pada candle tertutup simbol ini. Tidak ada data contoh yang ditampilkan.',
    }),
  }));
}

export async function symbolView() {
  const params = parseSymbolQuery(hashQuery());
  const form = searchForm(params.symbol, params.direction);
  if (!params.symbol) {
    return page({ title: 'Symbol Intelligence', subtitle: SUBTITLE, actions: form }, noSymbolState(params.invalidSymbol));
  }
  const { symbol } = params;

  let signals = [];
  let historyError = null;
  try {
    const data = await api(`/api/signals/history?${new URLSearchParams({ symbol, limit: String(HISTORY_LIMIT) }).toString()}`);
    signals = Array.isArray(data?.items) ? data.items : [];
  } catch (err) {
    if (err?.status === 401) throw err;
    historyError = err;
  }

  // Sinyal fokus: id dari URL → sinyal terbaru arah & TF yang diminta → sinyal terbaru arah yang diminta.
  const pool = params.direction ? signals.filter((s) => directionOf(s) === params.direction) : signals;
  const focused = (params.signalId !== null ? signals.find((s) => s.id === params.signalId) : null)
    ?? (params.timeframe ? pool.find((s) => s.timeframe === params.timeframe) : null)
    ?? pool[0]
    ?? null;
  const direction = params.direction ?? (focused ? directionOf(focused) : 'LONG');
  const timeframe = params.timeframe ?? normalizeTimeframe(focused?.timeframe);

  const chartPanel = createSymbolChartPanel({
    symbol,
    timeframe,
    direction,
    variant: 'detail',
    detailLink: false,
    levels: signalLevels(focused),
    // Penanda transisi hanya untuk sinyal searah pada timeframe grafik yang sedang tampil.
    markers: (tf) => signalMarkers(signals.filter((s) => directionOf(s) === direction && s.timeframe === tf)),
    // URL ikut diperbarui tanpa memicu hashchange (halaman tidak dirender ulang).
    onTimeframeChange: (tf) => {
      window.history.replaceState(window.history.state, '', symbolDetailHref({
        symbol, timeframe: tf, direction: params.direction, signalId: params.signalId,
      }));
    },
  });

  const summaryPanel = panel({ title: focused && focused === pool[0] && params.signalId === null ? 'Sinyal terakhir' : 'Sinyal dipilih' },
    focused
      ? signalSummary(focused)
      : h('p', { class: 'muted' }, historyError
        ? 'Riwayat sinyal tidak dapat dimuat; grafik tetap menampilkan candle tersimpan.'
        : 'Belum ada sinyal untuk simbol ini. Grafik tetap menampilkan candle tertutup yang tersimpan.'));

  const el = page({ title: 'Symbol Intelligence', subtitle: SUBTITLE, actions: form },
    h('div', { class: 'grid grid--main-side' },
      chartPanel.el,
      h('div', { class: 'stack' }, summaryPanel, explanationPanel(focused), transitionsPanel(focused))),
    historyPanel(symbol, signals, focused, historyError));

  return { el, cleanup: () => chartPanel.destroy() };
}
