import { api } from '../lib/api.js';
import { badge, callout, dataTable, emptyState, page, panel, score, selectField } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatPrice, formatRelative, formatUtc } from '../lib/format.js';
import {
  alignmentBadge, confluenceFieldsOf, confluenceValue, directionOf, formatWinProbability, meetsMinTier, patternBadge,
  riskBadges, signalStage, tierBadge, tierRank,
} from './signalFormat.js';
import { attachChartSidePanel } from './symbolChart.js';
import { workerControlBar } from './workerControl.js';
import { isWorkerActive } from './workerFormat.js';

/**
 * Kolom sesuai spesifikasi 6.2, per arah. Baris = sinyal aktif dari GET /api/signals/active (data nyata di database).
 * Early Score LONG mengukur struktur bullish awal (nada bull); SHORT mengukur struktur bearish awal (nada bear).
 * Kolom Tier / Konfluensi / Prob. menang hanya ditambahkan bila data membawanya (`fields`, lihat confluenceFieldsOf):
 * sinyal lama tanpa field ini tidak memunculkan kolom kosong, dan sel baris tanpa nilai dibiarkan kosong (tanpa
 * placeholder rekaan).
 * @param {'LONG'|'SHORT'} [direction]
 * @param {{ tier?: boolean, score?: boolean, winProbability?: boolean }} [fields]
 */
export function scannerColumns(direction = 'LONG', fields = {}) {
  const dir = directionOf(direction);
  const confluence = [];
  if (fields.tier) {
    confluence.push({ key: 'confidenceTier', label: 'Tier', sortValue: (r) => tierRank(r.confidenceTier), render: (r) => tierBadge(r.confidenceTier) });
  }
  if (fields.score) {
    confluence.push({
      key: 'confluenceScore',
      label: 'Konfluensi',
      numeric: true,
      sortValue: (r) => confluenceValue(r.confluenceScore),
      render: (r) => {
        const v = confluenceValue(r.confluenceScore);
        if (v === null) return null;
        const el = score(v, 'accent');
        el.classList.add('confluence-score');
        el.title = `Skor konfluensi ${v}/100 — kecocokan dengan aturan multi-faktor, bukan probabilitas profit.`;
        el.setAttribute('aria-label', el.title);
        return el;
      },
    });
  }
  if (fields.winProbability) {
    confluence.push({
      key: 'winProbability',
      label: 'Prob. (kalibrasi)',
      numeric: true,
      sortValue: (r) => (formatWinProbability(r.winProbability) === null ? null : r.winProbability),
      render: (r) => {
        const text = formatWinProbability(r.winProbability);
        if (text === null) return null;
        return h('span', { class: 'num', title: 'Probabilitas historis terkalibrasi dari backtest — bukan jaminan hasil.' }, text);
      },
    });
  }
  return [
    { key: 'symbol', label: 'Symbol', render: (r) => h('span', { class: 'mono' }, r.symbol) },
    { key: 'lastPrice', label: 'Harga', numeric: true, render: (r) => formatPrice(r.lastPrice) },
    { key: 'timeframe', label: 'TF', render: (r) => h('span', { class: 'mono' }, r.timeframe) },
    { key: 'classification', label: 'Pola', render: (r) => patternBadge(r.classification, dir) },
    { key: 'patternScore', label: 'Pattern Score', numeric: true, render: (r) => score(r.patternScore) },
    { key: 'earlyScore', label: 'Early Score', numeric: true, render: (r) => score(r.earlyScore, dir === 'SHORT' ? 'bear' : 'bull') },
    ...confluence,
    { key: 'alignment', label: 'Alignment', render: (r) => alignmentBadge(r.alignment) },
    { key: 'state', label: 'Tahap', render: (r) => signalStage(r.state, dir) },
    { key: 'riskFlags', label: 'Risiko', sortable: false, render: (r) => riskBadges(r.riskFlags) },
    { key: 'firstDetectedAt', label: 'Deteksi pertama', render: (r) => formatUtc(r.firstDetectedAt) },
    { key: 'updatedAt', label: 'Update', render: (r) => formatRelative(r.updatedAt) },
  ];
}

export const SCREENER_COLUMNS = scannerColumns('LONG');

const ALL = { value: '', label: 'Semua' };
const TIMEFRAME_OPTIONS = [ALL, { value: '5m', label: '5m' }, { value: '15m', label: '15m' }, { value: '1h', label: '1h' }];
const ALIGNMENT_OPTIONS = [ALL, { value: 'ALIGNED', label: 'Aligned' }, { value: 'PARTIALLY_CONFIRMED', label: 'Parsial' }, { value: 'UNCONFIRMED', label: 'Unconfirmed' }, { value: 'COUNTERTREND', label: 'Countertrend' }];
const MIN_TIER_OPTIONS = [ALL, { value: 'A', label: 'A' }, { value: 'B', label: '≥ B' }, { value: 'C', label: '≥ C' }, { value: 'D', label: '≥ D' }];
const MIN_SCORE_OPTIONS = [ALL, { value: '50', label: '≥ 50' }, { value: '70', label: '≥ 70' }, { value: '85', label: '≥ 85' }];

// Konfigurasi halaman per arah. LONG tidak mengirim parameter direction (default API = LONG), sehingga request
// LONG identik dengan sebelum SHORT ada. Teks skor selalu menyatakan aturan pola, bukan probabilitas profit.
const SCANNERS = {
  LONG: {
    title: 'LONG Scanner',
    subtitle: 'Kandidat struktur bullish per timeframe. Skor mengukur kemiripan dengan aturan pola, bukan probabilitas profit.',
    queryDirection: null,
    filterLabel: 'Filter LONG scanner',
    patterns: [ALL, { value: 'SA', label: 'SA' }, { value: 'PVA', label: 'PVA' }, { value: 'BOTH', label: 'BOTH' }],
    stages: [ALL, { value: 'QUIET', label: 'Quiet' }, { value: 'EARLY_BULLISH', label: 'Early bullish' }, { value: 'MOMENTUM_BUILDING', label: 'Momentum' }, { value: 'BREAKOUT', label: 'Breakout' }],
    panelTitle: 'Kandidat',
    caption: 'Kandidat LONG',
    testId: 'screener-results',
    iconName: 'screener',
    emptyTitle: 'Belum ada kandidat LONG',
    emptyText: 'Kandidat muncul setelah worker mengingesti candle tertutup Binance dan detektor SA/PVA menemukan pola. Tidak ada data contoh yang ditampilkan.',
    footer: 'Klik baris (atau tekan Enter) untuk menampilkan grafik koin di sebelah tabel; Esc menutupnya. Hanya sinyal dari candle tertutup. Alignment = konteks timeframe lebih tinggi, tidak membuang pola.',
  },
  SHORT: {
    title: 'SHORT Scanner',
    subtitle: 'Kandidat struktur bearish (distribusi) per timeframe — hanya riset, tanpa eksekusi order. Skor mengukur kemiripan dengan aturan pola, bukan probabilitas profit.',
    queryDirection: 'SHORT',
    filterLabel: 'Filter SHORT scanner',
    patterns: [ALL, { value: 'SD', label: 'SD' }, { value: 'PVD', label: 'PVD' }, { value: 'BOTH', label: 'BOTH' }],
    stages: [ALL, { value: 'QUIET', label: 'Quiet' }, { value: 'EARLY_BEARISH', label: 'Early bearish' }, { value: 'MOMENTUM_BUILDING', label: 'Momentum' }, { value: 'BREAKDOWN', label: 'Breakdown' }],
    panelTitle: 'Kandidat SHORT',
    caption: 'Kandidat SHORT',
    testId: 'short-screener-results',
    iconName: 'screener-short',
    emptyTitle: 'Belum ada kandidat SHORT',
    emptyText: 'Kandidat muncul setelah worker mengingesti candle tertutup Binance dan detektor SD/PVD menemukan pola distribusi. Tidak ada data contoh yang ditampilkan.',
    footer: 'Klik baris (atau tekan Enter) untuk menampilkan grafik koin di sebelah tabel; Esc menutupnya. Hanya sinyal dari candle tertutup. Alignment relatif terhadap arah SHORT (Aligned = timeframe lebih tinggi sedang turun), tidak membuang pola. Riset saja — tidak ada eksekusi order.',
  },
};

// Semua filter dikirim ke server (nama field form → parameter query API) dan diterapkan SEBELUM limit.
// Tidak ada filter di klien: memfilter setelah potongan top-N patternScore membuat hasil diam-diam tidak lengkap.
const SERVER_FILTERS = { tf: 'timeframe', pattern: 'classification', stage: 'state', alignment: 'alignment', minScore: 'minScore', minTier: 'minTier' };
// Batas maksimum API (1–500). Sinyal terbuka maks. 1 per simbol × timeframe × arah dan tiap halaman meminta satu
// arah (≤ 100 × 3), sehingga daftar lengkap dan urutan Early Score di klien mencakup seluruh hasil. API tidak
// mengirim total/penanda terpotong (count = panjang halaman), jadi count = limit hanya berarti "batas tercapai": bisa
// tepat 500, bisa lebih. UI menyatakan itu apa adanya ("≥ 500", "mungkin terpotong"), tidak mengklaim ada sisa yang
// belum tentu ada.
const SCREENER_LIMIT = 500;

/**
 * Penyegaran latar daftar kandidat selama scanner benar-benar berjalan (state supervisor nyata dari kontrol scanner).
 * Hasilnya dibandingkan dengan muatan sebelumnya pada filter yang sama: baris baru / skor berubah disorot sesaat.
 */
const REFRESH_MS = 30_000;
/** Durasi sorotan baris (harus ≥ durasi animasi flash 1.2s di scanner.css). */
const FLASH_MS = 1_300;
/** Satu baris tidak disorot ulang lebih dari sekali per detik. */
const FLASH_MIN_GAP_MS = 1_000;
/** Stagger masuk dibatasi pada N baris pertama agar tabel panjang tidak menunggu lama. */
const STAGGER_MAX = 18;

/** Kunci identitas kandidat: satu sinyal terbuka per simbol × timeframe × arah. */
export const rowKey = (r) => `${r.symbol}|${r.timeframe}|${directionOf(r.direction)}`;

/**
 * Selisih dua muatan nyata pada filter yang sama → Map kunci → 'new' | 'up' | 'down'.
 * 'new' = kandidat yang tidak ada sebelumnya; 'up'/'down' = Early Score (atau Pattern Score bila Early sama) berubah.
 * `previous` null (muatan pertama / filter berubah) → Map kosong: tidak ada yang disorot.
 * @param {Map<string, { earlyScore?: number, patternScore?: number }>|null} previous
 * @param {Array<object>} rows
 * @returns {Map<string, 'new'|'up'|'down'>}
 */
export function diffRows(previous, rows) {
  const out = new Map();
  if (!previous) return out;
  for (const r of rows) {
    const key = rowKey(r);
    const before = previous.get(key);
    if (!before) {
      out.set(key, 'new');
      continue;
    }
    const delta = (Number(r.earlyScore) || 0) - (Number(before.earlyScore) || 0)
      || (Number(r.patternScore) || 0) - (Number(before.patternScore) || 0);
    if (Math.round(delta) !== 0) out.set(key, delta > 0 ? 'up' : 'down');
  }
  return out;
}

const snapshotOf = (rows) => new Map(rows.map((r) => [rowKey(r), { earlyScore: r.earlyScore, patternScore: r.patternScore }]));

/**
 * Urutan kolom yang sedang dipilih pengguna pada tabel lama (dari aria-sort header), agar penyegaran latar tidak
 * mengembalikan urutan ke default. null bila tidak ada tabel/urutan.
 */
function currentSort(host, columns) {
  const ths = [...host.querySelectorAll('thead th')];
  const idx = ths.findIndex((th) => th.getAttribute('aria-sort') === 'ascending' || th.getAttribute('aria-sort') === 'descending');
  if (idx < 0 || !columns[idx]) return null;
  return { key: columns[idx].key, dir: ths[idx].getAttribute('aria-sort') === 'ascending' ? 'asc' : 'desc' };
}

/**
 * Stagger masuk (--i) dan sorotan diff (data-flash) pada baris yang baru dirender. Teks sel tidak diubah.
 * `lastFlashAt` (Map kunci → Date.now()) membatasi sorotan ulang tiap baris ke ≤ 1×/detik.
 */
function decorateRows(table, rows, flashes, animate, lastFlashAt) {
  const now = Date.now();
  const trs = table.querySelectorAll('tbody tr');
  // dataTable merender baris sesuai urutan; tbody dibuat ulang saat header diurutkan, jadi petakan lewat sel Symbol+TF.
  const byText = new Map(rows.map((r) => [`${r.symbol}|${r.timeframe}`, r]));
  trs.forEach((tr, i) => {
    if (animate) {
      tr.classList.add('scan-row');
      tr.style.setProperty('--i', String(Math.min(i, STAGGER_MAX)));
    }
    if (flashes.size === 0) return;
    const cells = tr.children;
    const row = byText.get(`${cells[0]?.textContent}|${cells[2]?.textContent}`);
    const key = row ? rowKey(row) : null;
    const flash = key ? flashes.get(key) : undefined;
    if (!flash || now - (lastFlashAt.get(key) ?? 0) < FLASH_MIN_GAP_MS) return;
    lastFlashAt.set(key, now);
    tr.dataset.flash = flash;
  });
  if (flashes.size > 0) {
    setTimeout(() => {
      for (const tr of table.querySelectorAll('tbody tr[data-flash]')) delete tr.dataset.flash;
    }, FLASH_MS);
  }
}

/** Radar header dekoratif: berputar hanya saat scanner benar-benar berjalan (state supervisor dari API). */
function scanRadar(dir) {
  const label = h('span', { class: 'scan-radar__label' }, 'Scanner: memeriksa…');
  const el = h('div', { class: 'scan-radar', 'data-direction': dir, 'data-active': 'false', 'data-testid': 'scan-radar' },
    h('span', { class: 'scan-radar__dish', 'aria-hidden': 'true' },
      h('span', { class: 'scan-radar__sweep' }),
      h('span', { class: 'scan-radar__blip' }),
      h('span', { class: 'scan-radar__blip scan-radar__blip--2' })),
    label);
  return {
    el,
    /** @param {object|null} status snapshot supervisor nyata; null = tidak diketahui */
    set(status) {
      const active = isWorkerActive(status);
      el.dataset.active = String(active);
      const text = !status ? 'Scanner: status tidak tersedia'
        : active ? 'Scanner aktif — memindai' : status.state === 'starting' ? 'Scanner memulai…' : 'Scanner berhenti';
      if (label.textContent !== text) label.textContent = text;
    },
  };
}

function buildQuery(form, cfg) {
  const params = new URLSearchParams();
  if (cfg.queryDirection) params.set('direction', cfg.queryDirection);
  for (const [field, param] of Object.entries(SERVER_FILTERS)) {
    const value = form.elements[field].value;
    if (value) params.set(param, value);
  }
  params.set('limit', String(SCREENER_LIMIT));
  return `/api/signals/active?${params.toString()}`;
}

function emptyResult(filtered, cfg) {
  return filtered
    ? emptyState({ iconName: cfg.iconName, title: 'Tidak ada kandidat yang cocok', text: 'Longgarkan filter untuk melihat kandidat lain.' })
    : emptyState({ iconName: cfg.iconName, title: cfg.emptyTitle, text: cfg.emptyText });
}

/**
 * Halaman scanner satu arah (LONG atau SHORT): filter server, tabel kandidat dengan side panel grafik koin, dan
 * kontrol scanner persisten. Mengembalikan { el, cleanup } agar grafik dihancurkan saat pindah halaman.
 * @param {{ user?: { role: string } }|undefined} ctx
 * @param {'LONG'|'SHORT'} direction
 */
async function scannerPage(ctx, direction) {
  const dir = directionOf(direction);
  const cfg = SCANNERS[dir];
  // Kolom ditentukan per muatan (kolom konfluensi hanya bila data membawanya); yang terakhir dipakai membaca urutan.
  let columns = dir === 'LONG' ? SCREENER_COLUMNS : scannerColumns(dir);
  // Filter tier hanya tampil bila setidaknya satu baris membawa confidenceTier (atau filter sedang dipakai).
  const tierField = selectField({ label: 'Tier minimum', name: 'minTier', options: MIN_TIER_OPTIONS });
  tierField.hidden = true;
  // Status kontrol scanner bersifat pelengkap: kegagalannya tidak boleh menggagalkan halaman.
  const workerStatus = api('/api/system/worker').catch(() => null);

  const filters = h('form', { class: 'toolbar', 'aria-label': cfg.filterLabel },
    selectField({ label: 'Timeframe', name: 'tf', options: TIMEFRAME_OPTIONS }),
    selectField({ label: 'Pola', name: 'pattern', options: cfg.patterns }),
    selectField({ label: 'Tahap', name: 'stage', options: cfg.stages }),
    selectField({ label: 'Alignment', name: 'alignment', options: ALIGNMENT_OPTIONS }),
    selectField({ label: 'Skor minimum', name: 'minScore', options: MIN_SCORE_OPTIONS }),
    tierField,
  );

  const count = badge('0 hasil');
  const host = h('div', { 'data-testid': cfg.testId });
  // Klik / Enter pada baris kandidat → grafik koin di sebelah tabel (layar sempit: di bawahnya) untuk arah halaman ini,
  // dengan tombol "Buka detail" ke Symbol Intelligence. Pilihan bertahan saat tabel dibuat ulang oleh filter.
  const chartSide = attachChartSidePanel({ layoutHost: host, direction: dir });
  const radar = scanRadar(dir);
  let request = 0;
  // Muatan terakhir yang berhasil: kunci query + snapshot skor, untuk diff antarpolling pada filter yang sama.
  let lastQuery = null;
  let lastSnapshot = null;
  let workerActive = false;
  let refreshTimer = null;
  const lastFlashAt = new Map();

  /**
   * @param {{ background?: boolean }} [options] background: penyegaran latar (tidak memperpanjang idle timeout,
   *   kegagalan tidak menimpa tabel yang sudah tampil, urutan kolom pengguna dipertahankan).
   */
  async function load({ background = false } = {}) {
    const id = ++request;
    const query = buildQuery(filters, cfg);
    let data;
    try {
      data = await api(query, background ? { background: true } : undefined);
    } catch (err) {
      if (id !== request || background) return;
      lastQuery = null;
      lastSnapshot = null;
      host.replaceChildren(callout(`Gagal memuat kandidat: ${err.message}`, 'bear'));
      return;
    }
    if (id !== request) return; // respons usang dari filter sebelumnya
    // Penjaga kontrak, bukan filter: API hanya mengirim arah yang diminta (baris lama tanpa direction = LONG).
    // Baris arah lain tidak pernah ditampilkan dengan label arah halaman ini.
    // minTier juga disaring di klien: server yang belum mendukungnya mengabaikan parameter itu.
    const minTier = filters.elements.minTier.value;
    const rows = data.items.filter((r) => directionOf(r.direction) === dir && meetsMinTier(r.confidenceTier, minTier));
    const fields = confluenceFieldsOf(data.items);
    tierField.hidden = !(fields.tier || minTier);
    const previousColumns = columns;
    columns = fields.tier || fields.score || fields.winProbability ? scannerColumns(dir, fields)
      : dir === 'LONG' ? SCREENER_COLUMNS : scannerColumns(dir);
    const filtered = [...new FormData(filters).values()].some(Boolean);
    const limitReached = data.count >= SCREENER_LIMIT;
    count.textContent = limitReached ? `≥ ${SCREENER_LIMIT} hasil` : `${rows.length} hasil`;
    const sameQuery = query === lastQuery;
    const flashes = sameQuery ? diffRows(lastSnapshot, rows) : new Map();
    const table = dataTable({
      columns,
      rows,
      caption: cfg.caption,
      initialSort: (background && currentSort(host, previousColumns)) || { key: 'earlyScore', dir: 'desc' },
      empty: emptyResult(filtered, cfg),
      ...chartSide.tableOptions,
    });
    // Stagger masuk hanya saat tabel tampil baru (bukan penyegaran latar yang isinya sama).
    decorateRows(table, rows, flashes, !background, lastFlashAt);
    lastQuery = query;
    lastSnapshot = snapshotOf(rows);
    // Kandidat baru nyata pada penyegaran → pulsa animasi latar (bull untuk LONG, bear untuk SHORT).
    const fresh = [...flashes.values()].filter((f) => f === 'new').length;
    if (fresh > 0) {
      window.dispatchEvent(new CustomEvent('lr:activity', { detail: { kind: dir === 'SHORT' ? 'bear' : 'bull', count: Math.min(12, 3 + fresh * 2) } }));
    }
    host.replaceChildren(...(limitReached
      ? [callout(`Batas ${SCREENER_LIMIT} kandidat tercapai (urut Pattern Score); hasil mungkin terpotong. Persempit filter agar tidak ada kandidat yang terlewat.`, 'warn'), table]
      : [table]));
  }

  filters.addEventListener('change', () => { load(); });
  filters.addEventListener('submit', (e) => e.preventDefault());
  await load();

  let el = null;
  /**
   * Penyegaran latar tiap REFRESH_MS hanya selama scanner berjalan (data dapat berubah), halaman terlihat, dan
   * fokus keyboard tidak berada di dalam tabel (tabel dibuat ulang → fokus tidak boleh hilang). Berhenti sendiri saat
   * halaman dilepas.
   */
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      if (el && !el.isConnected) return;
      const focusInside = host.contains(document.activeElement) && document.activeElement !== document.body;
      if (workerActive && !document.hidden && !focusInside) await load({ background: true });
      if (!el || el.isConnected) scheduleRefresh();
    }, REFRESH_MS);
  }

  const status = await workerStatus;
  radar.set(status);
  workerActive = isWorkerActive(status);
  // Dibuat setelah semua await: kontrol menghentikan polling-nya sendiri bila tidak terpasang di halaman.
  const control = workerControlBar({
    user: ctx?.user,
    status,
    onState: (s) => {
      radar.set(s);
      workerActive = isWorkerActive(s);
    },
  });

  el = page({ title: cfg.title, subtitle: cfg.subtitle, actions: radar.el },
    control,
    panel({ title: cfg.panelTitle, actions: count, flush: true, footer: cfg.footer }, filters, chartSide.el));
  el.classList.add('page--scanner');
  el.dataset.direction = dir;
  scheduleRefresh();
  return {
    el,
    cleanup: () => {
      clearTimeout(refreshTimer);
      refreshTimer = null;
      chartSide.cleanup();
    },
  };
}

/** LONG Scanner (route /screener). Tetap dapat dipanggil tanpa argumen seperti sebelumnya. */
export function screenerView(ctx) {
  return scannerPage(ctx, 'LONG');
}

/** SHORT Scanner (route /short-scanner): GET /api/signals/active?direction=SHORT. */
export function shortScannerView(ctx) {
  return scannerPage(ctx, 'SHORT');
}
