// Panel grafik satu koin (side panel tabel scanner & halaman Symbol Intelligence) + helper tata letak dua kolom.
// Data = candle tertutup dari GET /api/market/candles; tanpa candle → empty state, tidak pernah data contoh.
// Skor yang ditampilkan adalah kecocokan dengan aturan pola, bukan probabilitas profit. Riset saja.
import { api } from '../lib/api.js';
import { createCandleChart, loadChartLibrary, onDisconnect } from '../lib/chart.js';
import { callout, emptyState, panel, refreshRowSelection, score, segmented } from '../lib/components.js';
import { h, icon } from '../lib/dom.js';
import { formatPrice, formatTime } from '../lib/format.js';
import { alignmentBadge, directionBadge, directionOf, patternBadge, riskBadges, signalStage } from './signalFormat.js';

// 5m tidak lagi diingesti (LONG 15m, SHORT 1h), sehingga grafik hanya menawarkan timeframe yang datanya diperbarui.
export const CHART_TIMEFRAMES = Object.freeze(['15m', '1h']);
export const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;
const DEFAULT_TIMEFRAME = '15m';
// Cukup untuk EMA25 dan ±3 hari candle 15m; batas API 1–1000.
const CANDLE_LIMIT = 300;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const isValidSymbol = (symbol) => typeof symbol === 'string' && SYMBOL_RE.test(symbol);
/** Arah sinyal; field `direction` yang tidak ada (data lama) atau tak dikenal = LONG (sama dengan directionOf). */
export const normalizeDirection = directionOf;
export const normalizeTimeframe = (timeframe, fallback = DEFAULT_TIMEFRAME) => (CHART_TIMEFRAMES.includes(timeframe) ? timeframe : fallback);

// Badge arah dan tahap sinyal dipakai dari signalFormat.js (satu sumber dengan scanner & riwayat sinyal).
export { directionBadge, signalStage };

/**
 * Tautan halaman detail: #/symbol?s=BTCUSDT&tf=15m&dir=LONG&signal=12 (parameter selain s opsional).
 * @param {{ symbol: string, timeframe?: string, direction?: string|null, signalId?: number|null }} target
 */
export function symbolDetailHref({ symbol, timeframe, direction, signalId } = {}) {
  const params = new URLSearchParams({ s: symbol });
  if (CHART_TIMEFRAMES.includes(timeframe)) params.set('tf', timeframe);
  if (direction) params.set('dir', normalizeDirection(direction));
  if (Number.isInteger(signalId)) params.set('signal', String(signalId));
  return `#/symbol?${params.toString()}`;
}

/** Level harga sinyal untuk garis horizontal grafik (invalidasi & harga deteksi pertama). */
export function signalLevels(signal) {
  if (!signal) return [];
  return [
    { price: signal.invalidationPrice, kind: 'invalidation' },
    { price: signal.firstDetectedPrice, kind: 'detected' },
  ].filter((l) => isNum(l.price) && l.price > 0);
}

/** Penanda grafik dari event transisi sinyal (candleTime = openTime candle); tanpa event → titik deteksi pertama. */
export function signalMarkers(signals) {
  const out = [];
  for (const s of Array.isArray(signals) ? signals : []) {
    const events = Array.isArray(s?.events) ? s.events : [];
    if (events.length === 0 && isNum(s?.firstDetectedAt)) out.push({ time: s.firstDetectedAt, kind: 'DETECTED' });
    for (const e of events) {
      const time = isNum(e?.candleTime) ? e.candleTime : e?.occurredAt;
      if (isNum(time) && typeof e.toState === 'string') out.push({ time, kind: e.toState });
    }
  }
  return out;
}

/** Ringkasan sinyal (arah, pola, tahap, skor, level, risiko). Kode klasifikasi/state baru tampil apa adanya. */
export function signalSummary(signal) {
  const dir = normalizeDirection(signal.direction);
  const row = (label, value, attrs) => [h('dt', null, label), h('dd', attrs ?? null, value)];
  return h('div', { class: 'stack', 'data-testid': 'chart-signal-info' },
    h('dl', { class: 'kv' },
      row('Arah', directionBadge(dir)),
      // Arah ikut dikirim: BOTH pada SHORT = SD + PVD (patternBadge yang belum mengenal arah mengabaikannya).
      row('Pola', patternBadge(signal.classification, dir)),
      row('Tahap', typeof signal.state === 'string' ? signalStage(signal.state, dir) : '—'),
      row('TF sinyal', signal.timeframe ?? '—', { class: 'mono' }),
      row('Pattern Score', isNum(signal.patternScore) ? score(signal.patternScore) : '—'),
      row('Early Score', isNum(signal.earlyScore) ? score(signal.earlyScore, dir === 'SHORT' ? 'bear' : 'bull') : '—'),
      row('Alignment', alignmentBadge(signal.alignment)),
      row('Level invalidasi', formatPrice(signal.invalidationPrice), { class: 'num' }),
      row('Harga deteksi', formatPrice(signal.firstDetectedPrice), { class: 'num' }),
      row('Deteksi pertama', formatTime(signal.firstDetectedAt)),
      row('Risiko', riskBadges(signal.riskFlags))),
    h('p', { class: 'chart-note' },
      'Skor = tingkat kecocokan dengan aturan pola (0–100), bukan probabilitas profit. Riset saja, bukan saran transaksi.'));
}

let panelSeq = 0;

/**
 * Panel grafik satu koin: pemilih timeframe, grafik candle + volume + EMA7/EMA25 + level sinyal, info sinyal.
 * Memuat candle sendiri; loading, error (dengan tombol coba lagi) dan empty state ditangani di dalam panel.
 * @param {{ symbol: string, timeframe?: string, direction?: 'LONG'|'SHORT', signal?: object|null,
 *   levels?: object[], markers?: object[] | ((timeframe: string) => object[]), variant?: 'side'|'detail',
 *   detailLink?: boolean, onClose?: () => void, onTimeframeChange?: (timeframe: string) => void }} options
 *   Tombol tutup tampil bila `onClose` diberikan; menutup juga memancarkan event DOM 'symbolchart:close' (bubbles).
 * @returns {{ el: HTMLElement, close: () => void, destroy: () => void, readonly timeframe: string }}
 */
export function createSymbolChartPanel(options) {
  const { symbol, signal = null, onClose, onTimeframeChange, detailLink = true, variant = 'side' } = options;
  if (!isValidSymbol(symbol)) throw new RangeError('Simbol tidak valid');
  const direction = normalizeDirection(options.direction ?? signal?.direction);
  const levels = options.levels ?? signalLevels(signal);
  const markersFor = typeof options.markers === 'function' ? options.markers : () => options.markers ?? [];
  const uid = ++panelSeq;
  let timeframe = normalizeTimeframe(options.timeframe ?? signal?.timeframe);
  let chart = null;
  let chartTimeframe = null;
  let controller = null;
  let loadSeq = 0;
  let disposed = false;

  const tfControl = segmented({
    name: `chart-tf-${uid}`, label: `Timeframe grafik ${symbol}`, value: timeframe,
    options: CHART_TIMEFRAMES.map((tf) => ({ value: tf, label: tf })),
  });
  const chartHost = h('div', { class: `chart chart--${variant}`, hidden: true });
  const statusHost = h('div', { class: 'chart-status' });
  const detailAnchor = detailLink
    ? h('a', { class: 'btn btn--sm', href: symbolDetailHref({ symbol, timeframe, direction }), 'data-testid': 'chart-detail-link' }, 'Buka detail')
    : null;
  const refreshBtn = h('button', {
    class: 'btn btn--ghost btn--icon btn--sm', type: 'button', title: 'Muat ulang candle', 'aria-label': `Muat ulang candle ${symbol}`,
    on: { click: () => { load(); } },
  }, icon('refresh', 'btn__icon'));
  const closeBtn = typeof onClose === 'function'
    ? h('button', {
      class: 'btn btn--ghost btn--icon btn--sm', type: 'button', title: 'Tutup grafik', 'aria-label': `Tutup grafik ${symbol}`,
      'data-testid': 'chart-close', on: { click: () => close() },
    }, icon('close', 'btn__icon'))
    : null;

  const el = panel({
    title: `${symbol} · ${timeframe}`,
    actions: [directionBadge(direction), refreshBtn, detailAnchor, closeBtn],
    // Teks atribusi (NOTICE lisensi Lightweight Charts) melengkapi logo TradingView di dalam grafik.
    footer: 'Candle tertutup Binance USDT-M · waktu UTC · EMA7/EMA25 dihitung di browser · Grafik: TradingView Lightweight Charts™ © TradingView, Inc.',
  },
  h('div', { class: 'chart-toolbar' }, tfControl),
  statusHost,
  chartHost,
  signal ? signalSummary(signal) : null);
  el.classList.add('chart-panel', `chart-panel--${variant}`);
  el.setAttribute('data-testid', 'symbol-chart-panel');
  el.dataset.symbol = symbol;
  // Target fokus saat panel dibuka di layar sempit; judul panel menjadi nama region.
  el.setAttribute('tabindex', '-1');
  const heading = el.querySelector('.panel__title');
  heading.id = `chart-panel-title-${uid}`;
  el.setAttribute('aria-labelledby', heading.id);

  function setStatus(kind, message) {
    if (kind === 'loading') el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
    if (kind === 'loading') {
      // Grafik timeframe yang sama tetap tampil saat dimuat ulang; selain itu kerangka setinggi grafik.
      const keep = chart !== null && chartTimeframe === timeframe;
      chartHost.hidden = !keep;
      statusHost.replaceChildren(keep
        ? h('p', { class: 'chart-note', role: 'status' }, 'Memuat candle…')
        : h('div', { class: `chart-skeleton chart-skeleton--${variant}`, role: 'status' },
          h('span', { class: 'skeleton' }), h('span', { class: 'sr-only' }, 'Memuat candle…')));
      return;
    }
    if (kind === 'ready') {
      statusHost.replaceChildren();
      chartHost.hidden = false;
      return;
    }
    chart?.destroy();
    chart = null;
    chartHost.hidden = true;
    statusHost.replaceChildren(kind === 'empty'
      ? emptyState({
        iconName: 'symbol',
        title: 'Belum ada candle tertutup untuk simbol ini',
        text: `Candle ${timeframe} ${symbol} muncul setelah worker mengingesti data Binance. Tidak ada data contoh yang ditampilkan.`,
      })
      : callout([
        h('span', { role: 'alert' }, `Gagal memuat grafik: ${message}`),
        h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => { load(); } } }, 'Coba lagi'),
      ], 'bear'));
  }

  async function load() {
    if (disposed) return;
    const id = ++loadSeq;
    controller?.abort();
    controller = new AbortController();
    setStatus('loading');
    const query = new URLSearchParams({ symbol, timeframe, limit: String(CANDLE_LIMIT) });
    let data;
    try {
      [data] = await Promise.all([api(`/api/market/candles?${query.toString()}`, { signal: controller.signal }), loadChartLibrary()]);
    } catch (err) {
      if (disposed || id !== loadSeq || err?.name === 'AbortError') return;
      setStatus('error', err?.message || 'permintaan gagal');
      return;
    }
    if (disposed || id !== loadSeq) return;
    const candles = Array.isArray(data?.items) ? data.items : [];
    if (candles.length === 0) {
      setStatus('empty');
      return;
    }
    if (chart && !chart.destroyed && chartTimeframe === timeframe) {
      chart.setCandles(candles);
      setStatus('ready');
      return;
    }
    chart?.destroy();
    chart = null;
    setStatus('ready'); // kontainer harus terlihat sebelum grafik dibuat agar ukurannya terbaca
    let created;
    try {
      created = await createCandleChart(chartHost, { candles, timeframe, symbol, levels, markers: markersFor(timeframe) });
    } catch (err) {
      if (disposed || id !== loadSeq) return;
      setStatus('error', err?.message || 'grafik tidak dapat dibuat');
      return;
    }
    if (disposed || id !== loadSeq) {
      created.destroy();
      return;
    }
    chart = created;
    chartTimeframe = timeframe;
  }

  tfControl.addEventListener('change', (e) => {
    const next = e.target.value;
    if (!CHART_TIMEFRAMES.includes(next) || next === timeframe) return;
    timeframe = next;
    heading.textContent = `${symbol} · ${timeframe}`;
    detailAnchor?.setAttribute('href', symbolDetailHref({ symbol, timeframe, direction }));
    onTimeframeChange?.(timeframe);
    load();
  });

  function destroy() {
    if (disposed) return;
    disposed = true;
    stopWatching();
    controller?.abort();
    chart?.destroy();
    chart = null;
  }
  // Panel dilepas dari DOM (navigasi hash / panel diganti) → hentikan request & grafik.
  const stopWatching = onDisconnect(el, destroy);

  function close() {
    el.dispatchEvent(new CustomEvent('symbolchart:close', { bubbles: true, detail: { symbol, timeframe, direction } }));
    onClose?.();
  }

  if (typeof onClose === 'function') {
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    });
  }

  load();
  return { el, close, destroy, get timeframe() { return timeframe; } };
}

/** Bentuk ringkas: hanya elemen panel (grafik tetap dibersihkan otomatis saat panel dilepas dari DOM). */
export function symbolChartPanel(options) {
  return createSymbolChartPanel(options).el;
}

const defaultTarget = (row, direction) => ({
  symbol: row?.symbol, timeframe: row?.timeframe, direction: row?.direction ?? direction, signal: row ?? null,
});

/**
 * Tata letak dua kolom untuk halaman tabel: tabel (kiri) + panel grafik koin terpilih (kanan, ±40% / min 360px).
 * Layar ≤ 1100px: panel ditumpuk di bawah tabel, digulir ke tampilan, dan menerima fokus. Baris terpilih ditandai
 * aria-current/data-selected. Esc (di panel maupun pada baris tabel) atau tombol tutup menutup panel; fokus yang
 * berada di panel kembali ke baris. Tabel hanya satu tab stop, jadi Tab dari baris langsung masuk ke panel.
 *
 * Hook untuk halaman scanner (satu panggilan + sebar opsi tabel):
 *   const chartSide = attachChartSidePanel({ layoutHost: host, direction: 'LONG' });
 *   dataTable({ ...opsiTabel, ...chartSide.tableOptions });   // tiap kali tabel dibuat ulang
 *   panel({ ... }, filters, chartSide.el);                      // el menggantikan host di halaman
 *   return { el: halaman, cleanup: chartSide.cleanup };
 *
 * @param {{ layoutHost: HTMLElement, direction?: 'LONG'|'SHORT', onSelect?: (target: object, row: object) => void,
 *   onClose?: () => void, toTarget?: (row: object, direction: string) => { symbol: string, timeframe?: string,
 *   direction?: string, signal?: object } }} options
 *   layoutHost = elemen yang memuat tabel (isinya boleh diganti kapan saja). Bila sudah terpasang di DOM,
 *   posisinya diambil alih oleh `el`.
 * @returns {{ el: HTMLElement, tableOptions: { onRowSelect: (row: object) => void, isRowSelected: (row: object) => boolean },
 *   select: (row: object) => void, close: () => void, isSelected: (row: object) => boolean, cleanup: () => void }}
 */
export function attachChartSidePanel({ layoutHost, direction = 'LONG', onSelect, onClose, toTarget = defaultTarget }) {
  const main = h('div', { class: 'chart-split__main' });
  const aside = h('aside', { class: 'chart-split__aside', 'aria-label': 'Grafik koin terpilih', hidden: true, 'data-testid': 'chart-side-panel' });
  const el = h('div', { class: 'chart-split', 'data-open': 'false' });
  if (layoutHost.parentNode) layoutHost.replaceWith(el);
  main.append(layoutHost);
  el.append(main, aside);

  const narrow = window.matchMedia('(max-width: 1100px)');
  const keyOf = (t) => `${t.symbol}|${t.timeframe}|${t.direction}`;
  let current = null; // { key, handle }

  function targetOf(row) {
    const t = toTarget(row, direction);
    if (!t || !isValidSymbol(t.symbol)) return null;
    return { ...t, timeframe: normalizeTimeframe(t.timeframe), direction: normalizeDirection(t.direction ?? direction) };
  }

  const isSelected = (row) => {
    if (!current) return false;
    const t = targetOf(row);
    return t !== null && keyOf(t) === current.key;
  };

  function reveal() {
    if (!narrow.matches || !current) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    aside.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    current.handle.el.focus({ preventScroll: true });
  }

  function close() {
    if (!current) return;
    // Baris terpilih; bila sudah tersaring dari tabel, tab stop tabel (agar fokus tidak jatuh ke <body>).
    const returnRow = main.querySelector('tbody[data-selectable] > tr[data-selected]')
      ?? main.querySelector('tbody[data-selectable] > tr[tabindex="0"]');
    const focusInside = aside.contains(document.activeElement);
    current.handle.destroy();
    current = null;
    // Fokus dipindah SEBELUM panel dikosongkan & tanda baris diperbarui, sehingga baris itu tetap memegang tab stop.
    if (focusInside) returnRow?.focus();
    aside.replaceChildren();
    aside.hidden = true;
    el.dataset.open = 'false';
    refreshRowSelection(main);
    onClose?.();
  }

  // Esc pada baris tabel juga menutup grafik; fokus tetap di baris (Esc di dalam panel ditangani panel itu sendiri).
  main.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !current) return;
    if (!(e.target instanceof Element) || !e.target.matches('tbody[data-selectable] > tr')) return;
    close();
  });

  function select(row) {
    const target = targetOf(row);
    if (!target) return;
    const key = keyOf(target);
    if (current?.key !== key) {
      current?.handle.destroy();
      const handle = createSymbolChartPanel({ ...target, variant: 'side', onClose: close });
      current = { key, handle };
      aside.replaceChildren(handle.el);
    }
    aside.hidden = false;
    el.dataset.open = 'true';
    refreshRowSelection(main);
    onSelect?.(target, row);
    reveal();
  }

  function cleanup() {
    current?.handle.destroy();
    current = null;
  }

  return { el, tableOptions: { onRowSelect: select, isRowSelected: isSelected }, select, close, isSelected, cleanup };
}
