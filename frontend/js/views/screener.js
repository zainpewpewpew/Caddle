import { api } from '../lib/api.js';
import { badge, callout, dataTable, emptyState, page, panel, score, selectField } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatPrice, formatRelative, formatUtc } from '../lib/format.js';
import { alignmentBadge, directionOf, patternBadge, riskBadges, signalStage } from './signalFormat.js';
import { attachChartSidePanel } from './symbolChart.js';
import { workerControlBar } from './workerControl.js';

/**
 * Kolom sesuai spesifikasi 6.2, per arah. Baris = sinyal aktif dari GET /api/signals/active (data nyata di database).
 * Early Score LONG mengukur struktur bullish awal (nada bull); SHORT mengukur struktur bearish awal (nada bear).
 * @param {'LONG'|'SHORT'} [direction]
 */
export function scannerColumns(direction = 'LONG') {
  const dir = directionOf(direction);
  return [
    { key: 'symbol', label: 'Symbol', render: (r) => h('span', { class: 'mono' }, r.symbol) },
    { key: 'lastPrice', label: 'Harga', numeric: true, render: (r) => formatPrice(r.lastPrice) },
    { key: 'timeframe', label: 'TF', render: (r) => h('span', { class: 'mono' }, r.timeframe) },
    { key: 'classification', label: 'Pola', render: (r) => patternBadge(r.classification, dir) },
    { key: 'patternScore', label: 'Pattern Score', numeric: true, render: (r) => score(r.patternScore) },
    { key: 'earlyScore', label: 'Early Score', numeric: true, render: (r) => score(r.earlyScore, dir === 'SHORT' ? 'bear' : 'bull') },
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
const SERVER_FILTERS = { tf: 'timeframe', pattern: 'classification', stage: 'state', alignment: 'alignment', minScore: 'minScore' };
// Batas maksimum API (1–500). Sinyal terbuka maks. 1 per simbol × timeframe × arah dan tiap halaman meminta satu
// arah (≤ 100 × 3), sehingga daftar lengkap dan urutan Early Score di klien mencakup seluruh hasil. API tidak
// mengirim total/penanda terpotong (count = panjang halaman), jadi count = limit hanya berarti "batas tercapai": bisa
// tepat 500, bisa lebih. UI menyatakan itu apa adanya ("≥ 500", "mungkin terpotong"), tidak mengklaim ada sisa yang
// belum tentu ada.
const SCREENER_LIMIT = 500;

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
  const columns = dir === 'LONG' ? SCREENER_COLUMNS : scannerColumns(dir);
  // Status kontrol scanner bersifat pelengkap: kegagalannya tidak boleh menggagalkan halaman.
  const workerStatus = api('/api/system/worker').catch(() => null);

  const filters = h('form', { class: 'toolbar', 'aria-label': cfg.filterLabel },
    selectField({ label: 'Timeframe', name: 'tf', options: TIMEFRAME_OPTIONS }),
    selectField({ label: 'Pola', name: 'pattern', options: cfg.patterns }),
    selectField({ label: 'Tahap', name: 'stage', options: cfg.stages }),
    selectField({ label: 'Alignment', name: 'alignment', options: ALIGNMENT_OPTIONS }),
    selectField({ label: 'Skor minimum', name: 'minScore', options: MIN_SCORE_OPTIONS }),
  );

  const count = badge('0 hasil');
  const host = h('div', { 'data-testid': cfg.testId });
  // Klik / Enter pada baris kandidat → grafik koin di sebelah tabel (layar sempit: di bawahnya) untuk arah halaman ini,
  // dengan tombol "Buka detail" ke Symbol Intelligence. Pilihan bertahan saat tabel dibuat ulang oleh filter.
  const chartSide = attachChartSidePanel({ layoutHost: host, direction: dir });
  let request = 0;

  async function load() {
    const id = ++request;
    let data;
    try {
      data = await api(buildQuery(filters, cfg));
    } catch (err) {
      if (id !== request) return;
      host.replaceChildren(callout(`Gagal memuat kandidat: ${err.message}`, 'bear'));
      return;
    }
    if (id !== request) return; // respons usang dari filter sebelumnya
    // Penjaga kontrak, bukan filter: API hanya mengirim arah yang diminta (baris lama tanpa direction = LONG).
    // Baris arah lain tidak pernah ditampilkan dengan label arah halaman ini.
    const rows = data.items.filter((r) => directionOf(r.direction) === dir);
    const filtered = [...new FormData(filters).values()].some(Boolean);
    const limitReached = data.count >= SCREENER_LIMIT;
    count.textContent = limitReached ? `≥ ${SCREENER_LIMIT} hasil` : `${rows.length} hasil`;
    const table = dataTable({
      columns,
      rows,
      caption: cfg.caption,
      initialSort: { key: 'earlyScore', dir: 'desc' },
      empty: emptyResult(filtered, cfg),
      ...chartSide.tableOptions,
    });
    host.replaceChildren(...(limitReached
      ? [callout(`Batas ${SCREENER_LIMIT} kandidat tercapai (urut Pattern Score); hasil mungkin terpotong. Persempit filter agar tidak ada kandidat yang terlewat.`, 'warn'), table]
      : [table]));
  }

  filters.addEventListener('change', () => { load(); });
  filters.addEventListener('submit', (e) => e.preventDefault());
  await load();
  // Dibuat setelah semua await: kontrol menghentikan polling-nya sendiri bila tidak terpasang di halaman.
  const control = workerControlBar({ user: ctx?.user, status: await workerStatus });

  const el = page({ title: cfg.title, subtitle: cfg.subtitle },
    control,
    panel({ title: cfg.panelTitle, actions: count, flush: true, footer: cfg.footer }, filters, chartSide.el));
  return { el, cleanup: () => chartSide.cleanup() };
}

/** LONG Scanner (route /screener). Tetap dapat dipanggil tanpa argumen seperti sebelumnya. */
export function screenerView(ctx) {
  return scannerPage(ctx, 'LONG');
}

/** SHORT Scanner (route /short-scanner): GET /api/signals/active?direction=SHORT. */
export function shortScannerView(ctx) {
  return scannerPage(ctx, 'SHORT');
}
