// LONG Scanner — Reversal Radar: pelabel struktur proses dasar bullish — deskriptif, bukan prediksi (docs/19 §0/§8, docs/21 §7).
// Data = GET /api/reversal/candidates (kandidat terbuka + evaluasi candle berjalan/provisional) dari mesin
// backend/reversal (terpisah dari SA/PVA). Tiga panel bertumpuk urutan tetap — Early Formation, Developing Reversal,
// Confirmed Breakout — dua pertama di atas agar tidak tertutup koin yang sudah pump. Klik baris → panel detail di
// samping: mini-chart dengan level & penanda bukti, alasan masuk, level penting, konfirmasi berikutnya, batal bila,
// risiko, skor & komponen, riwayat. Panel sekunder terlipat di bawah memuat tabel SA/PVA 15m lama apa adanya.
// Skor = kecocokan aturan (0–100), bukan probabilitas. Tidak ada perintah entry/exit. Tidak ada data contoh.
import { ApiError, api } from '../lib/api.js';
import { callout, dataTable, emptyState, page, panel, refreshRowSelection, segmented, toggle } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatPrice, formatTime } from '../lib/format.js';
import {
  DEFAULT_FILTERS, FILTER_STORAGE_KEY, REVERSAL_LIMIT, REVERSAL_TIMEFRAMES, SENSITIVITY_FILTERS, STAGES, STAGE_LABELS,
  applyFilters, buildReversalQuery, candleStatusBadge, candleStatusOf, countsByTimeframe, diffRows, effectiveStage,
  effectiveStatus, evidenceCell, evidenceLabel, evidencePreview, firstDetectedText, groupByStage, historyEntries,
  importantLevels, isProvisionalOnly, lastEvaluatedAtOf, levelsOf, liquidityBadge, markersOf, moveCell, moveInfo,
  normalizeFilters, readFilters, riskBadges, rowKey, scoreCell, scoreComponentBars, scoreValue, setupTypeLabel,
  snapshotOf, stageBadge, statusLabel, statusPill, timeframeLabel,
} from './reversalFormat.js';
import { createScannerSection, currentSort, decorateRows, focusedRowKey, restoreRowFocus, rowTextKey, scanRadar } from './screener.js';
import { refreshUpdatedCells, updatedCell } from './signalFormat.js';
import { createSymbolChartPanel, isValidSymbol, normalizeTimeframe } from './symbolChart.js';
import { workerControlBar } from './workerControl.js';
import { isWorkerActive } from './workerFormat.js';

const SUBTITLE = 'Pelabel struktur proses dasar pada 5m/15m/1h: di tahap mana chart berada (Early Formation → Developing Reversal → Confirmed Breakout), bukti yang terpenuhi, level kunci, dan kapan setup batal. Deskriptif, bukan prediksi — lihat status validasi di bawah. Skor = kecocokan aturan, bukan probabilitas; bukan perintah transaksi.';
/** Penyegaran latar (hanya saat scanner benar-benar berjalan & halaman terlihat), pola screener.js. */
const REFRESH_MS = 30_000;
/** Teks relatif kolom "Update" dihitung ulang tiap interval ini. */
const CLOCK_TICK_MS = 15_000;
/** Preferensi lipatan panel sekunder SA/PVA ('1' terbuka, '0' terlipat). */
const LEGACY_OPEN_KEY = 'lr.reversal.legacyOpen';
const STAGE_TEST_IDS = Object.freeze({ EARLY_FORMATION: 'reversal-early', DEVELOPING_REVERSAL: 'reversal-developing', CONFIRMED_BREAKOUT: 'reversal-confirmed' });
const NOTE = 'Skor = jumlah poin aturan yang terpenuhi (0–100), bukan probabilitas; tidak ada perintah transaksi. Riset saja.';
/** Status validasi data nyata (docs/21 §6.6–§6.10: run 1–3 Jun–Okt 2025 + uji luar sampel run 4 Jun–Okt 2026): ditampilkan apa adanya di kepala panel. */
const VALIDATION_NOTE = 'Status validasi (data Binance: tiga run replay Jun–Okt 2025 pada 16–17 simbol plus satu uji luar sampel Jun–Okt 2026 pada 20 simbol — docs/21 §6.6–§6.10): rasio keberhasilan kandidat setara entri acak pada penghalang yang sama — juga per tahap, per status terlambat, dan per bin skor dengan basis per subset — dan kandidat tidak lebih awal dari scanner SA/PVA lama; belum ada bukti keunggulan. Dua sel sensitivitas Rendah yang menonjol pada data 2025 gagal pada uji luar sampel 2026. Tidak ada tahap, sensitivitas, atau ambang skor yang terbukti lebih baik dari kebetulan, termasuk Early Formation; validasi ditutup tanpa uji lanjutan.';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** Kunci teks baris tabel Reversal Radar: sel Pair (0) + sel TF (1). */
const keyOf = (tr) => rowTextKey(tr, 1);

// ---------- Preferensi (localStorage hanya untuk preferensi UI, selalu dalam try/catch) ----------

function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Penyimpanan lokal tidak tersedia — preferensi tidak disimpan.
  }
}

function loadStoredFilters() {
  const raw = readStored(FILTER_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_FILTERS };
  try {
    return normalizeFilters(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

// ---------- Toolbar filter (docs/19 §8.3) ----------

/** Select berlabel dengan id khusus (rr-*) agar tidak bentrok dengan id field tabel SA/PVA (f-stage dsb.) di halaman yang sama. */
function rrSelect({ label, name, options, value, hint }) {
  const id = `rr-${name}`;
  return h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    h('select', { class: 'select', id, name },
      options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))),
    hint && h('span', { class: 'field__hint' }, hint));
}

function filterForm(filters) {
  return h('form', { class: 'toolbar rr-toolbar', 'aria-label': 'Filter Reversal Radar', 'data-testid': 'reversal-filters' },
    h('div', { class: 'field rr-toolbar__tf' },
      h('span', { class: 'field__label' }, 'Timeframe'),
      segmented({
        name: 'timeframe', label: 'Timeframe', value: filters.timeframe,
        options: [{ value: '', label: 'Semua' }, ...REVERSAL_TIMEFRAMES.map((tf) => ({ value: tf, label: timeframeLabel(tf) }))],
      })),
    rrSelect({
      label: 'Tahap', name: 'stage', value: filters.stage,
      options: [{ value: '', label: 'Semua' }, ...STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s].title }))],
    }),
    rrSelect({
      label: 'Status', name: 'status', value: filters.status,
      options: [{ value: '', label: 'Semua terbuka' }, { value: 'NEW', label: 'Baru' }, { value: 'DEVELOPING', label: 'Berkembang' }, { value: 'CONFIRMED', label: 'Terkonfirmasi' }],
    }),
    rrSelect({
      label: 'Likuiditas', name: 'liquidity', value: filters.liquidity,
      options: [{ value: '', label: 'Semua' }, { value: 'LIQUID', label: 'Likuid saja' }, { value: 'THIN', label: 'Likuid + tipis' }],
    }),
    rrSelect({
      label: 'Sensitivitas', name: 'sensitivity', value: filters.sensitivity,
      options: [{ value: 'LOW', label: 'Rendah' }, { value: 'MEDIUM', label: 'Sedang' }, { value: 'HIGH', label: 'Tinggi' }],
      hint: 'Filter tampilan (skor & bukti minimum), bukan parameter mesin',
    }),
    h('div', { class: 'field rr-toolbar__toggles' },
      toggle({ name: 'hideExtended', label: 'Sembunyikan yang sudah extended', checked: filters.hideExtended }),
      toggle({ name: 'showProvisional', label: 'Tampilkan candle berjalan (provisional)', checked: filters.showProvisional })));
}

// ---------- Tabel per tahap (docs/19 §8.4) ----------

function setupCell(row) {
  const all = Array.isArray(row.setupTypes) ? row.setupTypes.map(setupTypeLabel) : [];
  const el = h('span', { class: 'rr-setup' }, setupTypeLabel(row.setupType));
  if (all.length > 1) el.title = `Semua yang cocok: ${all.join(', ')}`;
  return el;
}

const COLUMNS = [
  { key: 'symbol', label: 'Pair', render: (r) => h('span', { class: 'mono' }, r.symbol) },
  { key: 'timeframe', label: 'TF', render: (r) => h('span', { class: 'mono' }, r.timeframe) },
  { key: 'setupType', label: 'Jenis setup', sortValue: (r) => setupTypeLabel(r.setupType), render: setupCell },
  { key: 'status', label: 'Status', sortValue: (r) => statusLabel(effectiveStatus(r)), render: statusPill },
  { key: 'score', label: 'Skor', numeric: true, sortValue: scoreValue, render: scoreCell },
  { key: 'evidenceCount', label: 'Bukti', numeric: true, sortValue: (r) => evidencePreview(r).count, render: evidenceCell },
  { key: 'lastPrice', label: 'Harga', numeric: true, render: (r) => formatPrice(r.lastPrice) },
  { key: 'moveSinceDetectionPct', label: 'Sejak deteksi', numeric: true, sortValue: (r) => moveInfo(r).pct, render: moveCell },
  { key: 'liquidityClass', label: 'Likuiditas', render: (r) => liquidityBadge(r.liquidityClass) },
  { key: 'candleStatus', label: 'Candle', sortValue: candleStatusOf, render: candleStatusBadge },
  { key: 'firstDetectedAt', label: 'Deteksi pertama', render: firstDetectedText },
  // Waktu tutup candle terakhir yang dievaluasi (provisional: waktu evaluasi); "Basi" bila > 2 candle tanpa evaluasi.
  { key: 'updatedAt', label: 'Update', sortValue: lastEvaluatedAtOf, render: (r) => updatedCell({ updatedAt: lastEvaluatedAtOf(r), timeframe: r.timeframe }) },
];

/** Badge jumlah per timeframe: teks persis "5m 3 · 15m 2 · 1H 1" (chip per timeframe, 0 ditampilkan redup). */
function renderCounts(el, counts) {
  const chips = REVERSAL_TIMEFRAMES.map((tf) => h('span', { class: 'rr-count', 'data-tf': tf, 'data-zero': counts[tf] === 0 ? 'true' : undefined },
    `${timeframeLabel(tf)} ${counts[tf]}`));
  el.replaceChildren(...chips.flatMap((chip, i) => (i === 0 ? [chip] : [' · ', chip])));
  el.setAttribute('aria-label', `Jumlah kandidat per timeframe: ${REVERSAL_TIMEFRAMES.map((tf) => `${timeframeLabel(tf)} ${counts[tf]}`).join(', ')}`);
}

function stagePanel(stage) {
  const info = STAGE_LABELS[stage];
  const counts = h('span', { class: 'rr-counts', 'data-testid': `${STAGE_TEST_IDS[stage]}-counts` });
  const host = h('div', { class: 'rr-stage__host', 'data-testid': STAGE_TEST_IDS[stage] });
  const el = panel({ title: info.title, actions: counts, flush: true },
    h('p', { class: 'rr-stage__desc' }, info.text),
    host);
  el.classList.add('rr-stage');
  el.dataset.stage = stage;
  return { stage, el, host, counts };
}

function emptyFor(stage, filters) {
  const f = normalizeFilters(filters);
  const narrowed = f.timeframe || f.stage || f.status || f.liquidity || f.hideExtended || !f.showProvisional;
  const sens = SENSITIVITY_FILTERS[f.sensitivity];
  const text = narrowed
    ? 'Longgarkan filter (timeframe, tahap, status, likuiditas, extended, provisional) untuk melihat kandidat lain.'
    : f.sensitivity === 'HIGH'
      ? 'Kandidat muncul setelah worker mengingesti candle tertutup 5m/15m/1h dan mesin Reversal Radar menemukan bukti awal. Tidak ada data contoh yang ditampilkan.'
      : `Sensitivitas ${f.sensitivity === 'LOW' ? 'Rendah' : 'Sedang'} hanya menampilkan skor ≥ ${sens.minScore} dengan ≥ ${sens.minEvidence} bukti; pilih Tinggi untuk melihat kandidat dengan bukti lebih sedikit, termasuk Early Formation (belum terbukti lebih baik dari kebetulan — docs/21 §6.9). Tidak ada data contoh yang ditampilkan.`;
  return emptyState({ iconName: 'screener', title: `Belum ada kandidat ${STAGE_LABELS[stage].title} pada filter ini`, text });
}

// ---------- Panel detail di samping (docs/19 §8.5) ----------

function section(id, title, ...body) {
  return h('section', { class: 'rr-section', 'data-section': id, 'aria-labelledby': `rr-sec-${id}` },
    h('h3', { class: 'rr-section__title', id: `rr-sec-${id}` }, title),
    body);
}

const levelSuffix = (level) => (isNum(level) ? ` (${formatPrice(level)})` : '');

function evidenceList(row) {
  const list = Array.isArray(row.evidence) ? row.evidence : [];
  if (list.length === 0) return h('p', { class: 'muted' }, 'Belum ada bukti tercatat pada evaluasi terakhir.');
  return h('ul', { class: 'rr-evidence', 'data-testid': 'reversal-evidence' }, list.map((e) => {
    const item = typeof e === 'string' ? { id: e } : e ?? {};
    return h('li', { class: 'rr-evidence__item', 'data-group': item.group ?? undefined },
      h('span', { class: 'rr-evidence__label' }, item.label || evidenceLabel(item.id)),
      item.detail ? h('span', { class: 'rr-evidence__detail' }, String(item.detail)) : null,
      isNum(item.time) ? h('span', { class: 'rr-evidence__meta' }, `${formatTime(item.time)}${isNum(item.price) ? ` · ${formatPrice(item.price)}` : ''}`) : null);
  }));
}

function levelList(row) {
  const levels = importantLevels(row);
  if (levels.length === 0) return h('p', { class: 'muted' }, 'Level belum tersedia.');
  return h('dl', { class: 'kv rr-levels', 'data-testid': 'reversal-levels' }, levels.flatMap((l) => [h('dt', null, l.label), h('dd', { class: 'num' }, formatPrice(l.price))]));
}

function historyList(row, state) {
  if (isProvisionalOnly(row)) {
    return h('p', { class: 'muted', 'data-testid': 'reversal-history-note' },
      'Evaluasi candle berjalan (provisional): belum ada riwayat karena kandidat belum dibuka — riwayat dicatat hanya dari candle tertutup.');
  }
  if (state.loading) return h('p', { class: 'muted', role: 'status' }, 'Memuat riwayat…');
  if (state.error) {
    return callout([
      h('span', { role: 'alert' }, `Riwayat gagal dimuat: ${state.error}`),
      h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => state.retry?.() } }, 'Coba lagi'),
    ], 'bear');
  }
  const entries = historyEntries(state.events);
  if (entries.length === 0) return h('p', { class: 'muted', 'data-testid': 'reversal-history-note' }, 'Belum ada event tercatat untuk kandidat ini.');
  return h('ol', { class: 'timeline rr-history', 'data-testid': 'reversal-history' }, entries.map((e, i) => h('li', {
    class: 'timeline__item',
    'data-state': e.terminal ? 'done' : i === entries.length - 1 && !e.provisional ? 'active' : 'done',
    'data-provisional': e.provisional ? 'true' : undefined,
    'data-type': e.type,
  },
  h('span', { class: 'timeline__dot', 'aria-hidden': 'true' }),
  h('span', null,
    h('span', { class: 'timeline__title' }, e.title, e.stage ? ` · ${e.stage}` : '', e.status ? ` (${e.status})` : ''),
    e.provisional ? h('span', { class: 'rr-pill__prov rr-history__prov', title: 'Dicatat dari candle yang belum tutup' }, 'provisional') : null,
    h('br'),
    h('span', { class: 'timeline__text' }, [formatTime(e.at), e.price !== null ? `harga ${formatPrice(e.price)}` : null, e.reason].filter(Boolean).join(' · '))))));
}

/** Isi panel detail (di bawah mini-chart). `state` = { events, loading, error, retry }. */
function detailBody(row, state) {
  const provisionalOnly = isProvisionalOnly(row);
  const next = row.nextConfirmation ?? {};
  const cancel = row.cancelCondition ?? {};
  const total = scoreValue(row);
  return h('div', { class: 'rr-detail stack', 'data-testid': 'reversal-detail-body' },
    h('div', { class: 'cluster rr-detail__head' },
      stageBadge(effectiveStage(row)), statusPill(row), setupCell(row), candleStatusBadge(row), liquidityBadge(row.liquidityClass)),
    provisionalOnly
      ? callout('Evaluasi dari candle yang belum tutup (provisional): belum menjadi kandidat dan dapat berubah sampai candle tutup. Tidak ada event yang dicatat dari evaluasi ini.', 'warn')
      : null,
    section('evidence', 'Alasan masuk', evidenceList(row)),
    section('levels', 'Level penting', levelList(row)),
    section('next', 'Konfirmasi berikutnya',
      h('p', { class: 'rr-section__text', 'data-testid': 'reversal-next' },
        next.text ? `${next.text}${levelSuffix(next.level)}` : 'Kondisi konfirmasi berikutnya belum tersedia.')),
    section('cancel', 'Batal bila',
      h('p', { class: 'rr-section__text', 'data-testid': 'reversal-cancel' },
        cancel.text ? `${cancel.text}${levelSuffix(cancel.level)}` : 'Kondisi pembatalan belum tersedia.')),
    section('risks', 'Risiko utama', h('div', { 'data-testid': 'reversal-risks' }, riskBadges(row.risks))),
    section('score', 'Skor & komponen',
      h('p', { class: 'rr-section__text' }, total === null ? 'Skor belum tersedia.' : `Total ${total}/100 — jumlah poin lima grup bukti di bawah.`),
      scoreComponentBars(row.scoreComponents)),
    section('history', 'Riwayat', historyList(row, state)),
    h('p', { class: 'chart-note' }, NOTE));
}

/**
 * Tata letak dua kolom tiga panel tahap + panel detail kandidat terpilih (kanan; layar ≤ 1100px: di bawah, digulir
 * ke tampilan dan menerima fokus). Mengikuti pola attachChartSidePanel (symbolChart.js): baris terpilih ditandai
 * aria-current/data-selected, Esc (di panel maupun baris) atau tombol tutup menutup panel, fokus kembali ke baris.
 * Mini-chart memakai createSymbolChartPanel (candle tertutup dari API) dengan level & penanda bukti kandidat;
 * riwayat event diambil dari GET /api/reversal/candidates/:id saat baris dipilih (provisional-only: dari baris saja).
 */
function attachDetailPanel({ layoutHost }) {
  const main = h('div', { class: 'chart-split__main' });
  const aside = h('aside', { class: 'chart-split__aside', 'aria-label': 'Detail kandidat terpilih', hidden: true, 'data-testid': 'reversal-detail' });
  const el = h('div', { class: 'chart-split rr-split', 'data-open': 'false' });
  main.append(layoutHost);
  el.append(main, aside);
  const narrow = window.matchMedia('(max-width: 1100px)');
  let current = null; // { key, row, handle, body, state, seq }

  const isSelected = (row) => current !== null && rowKey(row) === current.key;

  function reveal() {
    if (!narrow.matches || !current) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    aside.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    current.handle.el.focus({ preventScroll: true });
  }

  function close() {
    if (!current) return;
    const returnRow = main.querySelector('tbody[data-selectable] > tr[data-selected]')
      ?? main.querySelector('tbody[data-selectable] > tr[tabindex="0"]');
    const focusInside = aside.contains(document.activeElement);
    current.handle.destroy();
    current = null;
    if (focusInside) returnRow?.focus();
    aside.replaceChildren();
    aside.hidden = true;
    el.dataset.open = 'false';
    refreshRowSelection(main);
  }

  main.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !current) return;
    if (!(e.target instanceof Element) || !e.target.matches('tbody[data-selectable] > tr')) return;
    close();
  });

  function paint() {
    if (!current) return;
    const next = detailBody(current.row, current.state);
    if (current.body) current.body.replaceWith(next);
    else current.handle.el.querySelector('.panel__body')?.append(next);
    current.body = next;
    current.handle.setMarkers(markersOf(current.row, current.state.events));
  }

  async function loadEvents(entry) {
    const { row } = entry;
    if (isProvisionalOnly(row) || !Number.isInteger(row.id)) {
      entry.state = { events: Array.isArray(row.events) ? row.events : [], loading: false, error: null };
      paint();
      return;
    }
    const seq = ++entry.seq;
    entry.state = { events: Array.isArray(row.events) ? row.events : [], loading: true, error: null };
    paint();
    let data;
    try {
      data = await api(`/api/reversal/candidates/${row.id}`);
    } catch (err) {
      if (current !== entry || seq !== entry.seq) return;
      entry.state = { events: entry.state.events, loading: false, error: err?.message || 'permintaan gagal', retry: () => loadEvents(entry) };
      paint();
      return;
    }
    if (current !== entry || seq !== entry.seq) return;
    const item = data && typeof data === 'object' && data.item && typeof data.item === 'object' ? data.item : data;
    const events = Array.isArray(data?.events) ? data.events : Array.isArray(item?.events) ? item.events : [];
    // Detail dari server lebih lengkap/baru daripada baris daftar: field baris dipertahankan bila detail tidak membawanya.
    if (item && typeof item === 'object' && item.symbol === row.symbol) entry.row = { ...row, ...item };
    entry.state = { events, loading: false, error: null };
    paint();
  }

  function select(row) {
    if (!row || !isValidSymbol(row.symbol)) return;
    const key = rowKey(row);
    if (current?.key !== key) {
      current?.handle.destroy();
      const entry = { key, row, handle: null, body: null, state: { events: [], loading: false, error: null }, seq: 0 };
      entry.handle = createSymbolChartPanel({
        symbol: row.symbol,
        timeframe: normalizeTimeframe(row.timeframe),
        direction: 'LONG',
        signal: null,
        levels: levelsOf(row),
        markers: () => markersOf(entry.row, entry.state.events),
        variant: 'side',
        onClose: close,
      });
      entry.handle.el.classList.add('rr-detail-panel');
      entry.handle.el.dataset.testid = 'reversal-detail-panel';
      current = entry;
      aside.replaceChildren(entry.handle.el);
      paint();
      loadEvents(entry);
    }
    aside.hidden = false;
    el.dataset.open = 'true';
    refreshRowSelection(main);
    reveal();
  }

  /** Setelah penyegaran latar: baris terpilih yang masih ada diperbarui isinya (skor/level/riwayat), tanpa menutup panel. */
  function refresh(rows) {
    if (!current) return;
    const fresh = rows.find((r) => rowKey(r) === current.key);
    if (!fresh) return;
    const changed = lastEvaluatedAtOf(fresh) !== lastEvaluatedAtOf(current.row) || scoreValue(fresh) !== scoreValue(current.row)
      || effectiveStage(fresh) !== effectiveStage(current.row);
    if (!changed) return;
    current.row = { ...current.row, ...fresh };
    loadEvents(current);
  }

  return {
    el,
    tableOptions: { onRowSelect: select, isRowSelected: isSelected },
    select,
    close,
    refresh,
    cleanup() {
      current?.handle.destroy();
      current = null;
    },
  };
}

// ---------- Halaman ----------

/**
 * Halaman LONG Scanner — Reversal Radar (route /screener). Mengembalikan { el, cleanup }.
 * @param {{ user?: { role: string } }|undefined} ctx
 */
export async function reversalRadarView(ctx) {
  // Status kontrol scanner bersifat pelengkap: kegagalannya tidak boleh menggagalkan halaman.
  const workerStatus = api('/api/system/worker').catch(() => null);
  const form = filterForm(loadStoredFilters());
  const panels = STAGES.map(stagePanel);
  const stack = h('div', { class: 'rr-stages stack' }, panels.map((p) => p.el));
  const detail = attachDetailPanel({ layoutHost: stack });
  const summary = h('p', { class: 'rr-summary', 'data-testid': 'reversal-summary', 'aria-live': 'polite' }, 'Memuat kandidat…');
  const statusHost = h('div', { class: 'rr-status', 'data-testid': 'reversal-status' });
  const radar = scanRadar('LONG');

  // Panel sekunder: tabel SA/PVA 15m lama apa adanya (filter, kolom, test id, batas 500 — createScannerSection).
  const legacyCount = h('span', { class: 'rr-legacy__count num', 'data-testid': 'reversal-legacy-count' }, '…');
  let legacyAutoOpened = false;
  const legacy = createScannerSection(ctx, 'LONG', {
    onLoaded: ({ rows, limitReached }) => {
      legacyCount.textContent = limitReached ? `≥ ${rows.length} kandidat` : `${rows.length} kandidat`;
      // Terlipat selama kosong; dibuka otomatis SEKALI saat mesin lama punya kandidat (hasil nyata tidak disembunyikan
      // diam-diam) — kecuali pengguna pernah melipat/membukanya sendiri (preferensi tersimpan).
      if (!legacyAutoOpened && rows.length > 0 && readStored(LEGACY_OPEN_KEY) === null) details.open = true;
      legacyAutoOpened = true;
    },
  });
  // Hanya aksi pengguna pada <summary> (klik / Enter / Spasi) yang disimpan sebagai preferensi; pembukaan otomatis tidak.
  let userToggle = false;
  const summaryEl = h('summary', {
    class: 'rr-legacy__summary',
    on: {
      click: () => { userToggle = true; },
      keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') userToggle = true; },
    },
  },
  h('span', { class: 'rr-legacy__title' }, 'Pola SA/PVA 15m (mesin lama)'),
  legacyCount,
  h('span', { class: 'rr-legacy__hint' }, 'Tabel LONG Scanner sebelumnya, tanpa perubahan'));
  const details = h('details', { class: 'rr-legacy', 'data-testid': 'reversal-legacy', open: readStored(LEGACY_OPEN_KEY) === '1' },
    summaryEl, h('div', { class: 'rr-legacy__body' }, legacy.el));
  details.addEventListener('toggle', () => {
    if (!userToggle) return;
    userToggle = false;
    writeStored(LEGACY_OPEN_KEY, details.open ? '1' : '0');
  });

  let request = 0;
  let lastQuery = null;
  let lastSnapshot = null;
  let workerActive = false;
  let refreshTimer = null;
  let clockTimer = null;
  let disposed = false;
  const lastFlashAt = new Map();

  function showError(err) {
    const missing = err instanceof ApiError && err.status === 404;
    statusHost.replaceChildren(callout(missing
      ? 'Endpoint Reversal Radar (/api/reversal/candidates) belum tersedia di server ini — backend belum diperbarui. Tabel SA/PVA di bawah tetap berjalan.'
      : `Gagal memuat kandidat reversal: ${err?.message || 'permintaan gagal'}`, 'bear'));
    summary.textContent = 'Kandidat reversal tidak dapat dimuat.';
    for (const p of panels) {
      p.host.replaceChildren(h('p', { class: 'muted rr-stage__unavailable' }, 'Kandidat tidak dapat dimuat.'));
      renderCounts(p.counts, countsByTimeframe([]));
    }
  }

  /**
   * @param {{ background?: boolean }} [options] background: penyegaran latar (tidak memperpanjang idle timeout,
   *   kegagalan tidak menimpa tabel yang sudah tampil, urutan kolom & fokus pengguna dipertahankan).
   */
  async function load({ background = false } = {}) {
    const id = ++request;
    const filters = readFilters(form);
    const query = buildReversalQuery(filters);
    let data;
    try {
      data = await api(query, background ? { background: true } : undefined);
    } catch (err) {
      if (id !== request || background) return;
      lastQuery = null;
      lastSnapshot = null;
      showError(err);
      return;
    }
    if (id !== request) return; // respons usang dari filter sebelumnya
    // Penjaga kontrak (idempoten terhadap server yang benar): baris yang tidak cocok filter tidak pernah tampil.
    const items = applyFilters(Array.isArray(data?.items) ? data.items : [], filters);
    const groups = groupByStage(items);
    const sameQuery = query === lastQuery;
    const flashes = sameQuery ? diffRows(lastSnapshot, items) : new Map();
    const keepFocus = background ? focusedRowKey(stack, keyOf) : null;
    for (const p of panels) {
      const rows = groups[p.stage];
      renderCounts(p.counts, countsByTimeframe(rows));
      const table = dataTable({
        columns: COLUMNS,
        rows,
        caption: `Kandidat ${STAGE_LABELS[p.stage].title}`,
        initialSort: (background && currentSort(p.host, COLUMNS)) || { key: 'score', dir: 'desc' },
        empty: emptyFor(p.stage, filters),
        rowClass: (row) => (isProvisionalOnly(row) ? 'is-provisional' : null),
        animateRows: !background,
        ...detail.tableOptions,
      });
      decorateRows(table, rows, flashes, !background, lastFlashAt, { keyOf, flashKeyOf: rowKey });
      p.host.replaceChildren(table);
    }
    restoreRowFocus(stack, keepFocus, keyOf);
    lastQuery = query;
    lastSnapshot = snapshotOf(items);
    const fresh = [...flashes.values()].filter((f) => f === 'new').length;
    if (fresh > 0) window.dispatchEvent(new CustomEvent('lr:activity', { detail: { kind: 'bull', count: Math.min(12, 3 + fresh * 2) } }));
    const limitReached = isNum(data?.count) && data.count >= REVERSAL_LIMIT;
    statusHost.replaceChildren(...(limitReached
      ? [callout(`Batas ${REVERSAL_LIMIT} kandidat tercapai; hasil mungkin terpotong. Persempit filter (timeframe/tahap/sensitivitas) agar tidak ada kandidat yang terlewat.`, 'warn')]
      : []));
    const provisional = items.filter(isProvisionalOnly).length;
    summary.textContent = `${items.length} kandidat · Early ${groups.EARLY_FORMATION.length} · Developing ${groups.DEVELOPING_REVERSAL.length} · Confirmed ${groups.CONFIRMED_BREAKOUT.length}`
      + (provisional > 0 ? ` · ${provisional} provisional (candle berjalan)` : '')
      + (groups.other.length > 0 ? ` · ${groups.other.length} tanpa tahap dikenal (tidak ditampilkan)` : '');
    detail.refresh(items);
  }

  form.addEventListener('change', () => {
    writeStored(FILTER_STORAGE_KEY, JSON.stringify(readFilters(form)));
    load();
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  await Promise.all([load(), legacy.ready]);
  const status = await workerStatus;
  radar.set(status);
  workerActive = isWorkerActive(status);
  legacy.setWorkerActive(workerActive);
  // Dibuat setelah semua await: kontrol menghentikan polling-nya sendiri bila tidak terpasang di halaman.
  const control = workerControlBar({
    user: ctx?.user,
    status,
    onState: (s) => {
      radar.set(s);
      workerActive = isWorkerActive(s);
      legacy.setWorkerActive(workerActive);
    },
  });

  const filterPanel = panel({ flush: true, footer: NOTE }, form);
  filterPanel.classList.add('rr-filter-panel');
  const el = page({ title: 'LONG Scanner', subtitle: SUBTITLE, actions: radar.el },
    control, filterPanel, summary, statusHost, detail.el, details);
  // Nama heading tetap "LONG Scanner" (sama dengan nav & topbar); "Reversal Radar" menjadi bagian judul yang tampak.
  const heading = el.querySelector('.page__title');
  const titleWrap = h('div', { class: 'rr-title' });
  heading.before(titleWrap);
  titleWrap.append(heading, h('span', { class: 'rr-title__sub', 'data-testid': 'reversal-title' }, 'Reversal Radar'));
  // Catatan status validasi data nyata (docs/21 §6.6–§6.10) tepat di bawah subjudul — selalu tampil, statis.
  const validation = h('p', { class: 'rr-validation', 'data-testid': 'reversal-validation' }, VALIDATION_NOTE);
  (el.querySelector('.page__subtitle') ?? titleWrap).after(validation);
  el.classList.add('page--scanner', 'page--reversal');
  el.dataset.direction = 'LONG';

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      if (disposed || !el.isConnected) return;
      if (workerActive && !document.hidden) await load({ background: true });
      if (!disposed && el.isConnected) scheduleRefresh();
    }, REFRESH_MS);
  }

  function startClock() {
    clockTimer = setInterval(() => {
      if (disposed || !el.isConnected) {
        clearInterval(clockTimer);
        clockTimer = null;
        return;
      }
      if (!document.hidden) refreshUpdatedCells(stack);
    }, CLOCK_TICK_MS);
  }

  scheduleRefresh();
  startClock();
  legacy.start();
  return {
    el,
    cleanup: () => {
      disposed = true;
      clearTimeout(refreshTimer);
      refreshTimer = null;
      clearInterval(clockTimer);
      clockTimer = null;
      detail.cleanup();
      legacy.cleanup();
    },
  };
}

/** LONG Scanner (route /screener) = Reversal Radar + panel sekunder SA/PVA. Dapat dipanggil tanpa argumen seperti sebelumnya. */
export function screenerView(ctx) {
  return reversalRadarView(ctx);
}
