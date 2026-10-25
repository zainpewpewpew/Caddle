import { api } from '../lib/api.js';
import { badge, callout, dataTable, emptyState, page, panel, score, selectField, stage } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatPrice, formatRelative, formatUtc } from '../lib/format.js';
import { alignmentBadge, patternBadge, riskBadges } from './signalFormat.js';

// Kolom sesuai spesifikasi 6.2. Baris = sinyal aktif dari GET /api/signals/active (data nyata di database).
export const SCREENER_COLUMNS = [
  { key: 'symbol', label: 'Symbol', render: (r) => h('span', { class: 'mono' }, r.symbol) },
  { key: 'lastPrice', label: 'Harga', numeric: true, render: (r) => formatPrice(r.lastPrice) },
  { key: 'timeframe', label: 'TF', render: (r) => h('span', { class: 'mono' }, r.timeframe) },
  { key: 'classification', label: 'Pola', render: (r) => patternBadge(r.classification) },
  { key: 'patternScore', label: 'Pattern Score', numeric: true, render: (r) => score(r.patternScore) },
  { key: 'earlyScore', label: 'Early Score', numeric: true, render: (r) => score(r.earlyScore, 'bull') },
  { key: 'alignment', label: 'Alignment', render: (r) => alignmentBadge(r.alignment) },
  { key: 'state', label: 'Tahap', render: (r) => stage(r.state) },
  { key: 'riskFlags', label: 'Risiko', sortable: false, render: (r) => riskBadges(r.riskFlags) },
  { key: 'firstDetectedAt', label: 'Deteksi pertama', render: (r) => formatUtc(r.firstDetectedAt) },
  { key: 'updatedAt', label: 'Update', render: (r) => formatRelative(r.updatedAt) },
];

const ALL = { value: '', label: 'Semua' };
// Semua filter dikirim ke server (nama field form → parameter query API) dan diterapkan SEBELUM limit.
// Tidak ada filter di klien: memfilter setelah potongan top-N patternScore membuat hasil diam-diam tidak lengkap.
const SERVER_FILTERS = { tf: 'timeframe', pattern: 'classification', stage: 'state', alignment: 'alignment', minScore: 'minScore' };
// Batas maksimum API (1–500). Sinyal terbuka maks. 1 per simbol × timeframe (≤ 100 × 3), sehingga daftar lengkap
// dan urutan Early Score di klien mencakup seluruh hasil; bila batas tercapai, UI menandainya secara eksplisit.
const SCREENER_LIMIT = 500;

function buildQuery(form) {
  const params = new URLSearchParams();
  for (const [field, param] of Object.entries(SERVER_FILTERS)) {
    const value = form.elements[field].value;
    if (value) params.set(param, value);
  }
  params.set('limit', String(SCREENER_LIMIT));
  return `/api/signals/active?${params.toString()}`;
}

function emptyResult(filtered) {
  return filtered
    ? emptyState({ iconName: 'screener', title: 'Tidak ada kandidat yang cocok', text: 'Longgarkan filter untuk melihat kandidat lain.' })
    : emptyState({
      iconName: 'screener',
      title: 'Belum ada kandidat LONG',
      text: 'Kandidat muncul setelah worker mengingesti candle tertutup Binance dan detektor SA/PVA menemukan pola. Tidak ada data contoh yang ditampilkan.',
    });
}

export async function screenerView() {
  const filters = h('form', { class: 'toolbar', 'aria-label': 'Filter screener' },
    selectField({ label: 'Timeframe', name: 'tf', options: [ALL, { value: '5m', label: '5m' }, { value: '15m', label: '15m' }, { value: '1h', label: '1h' }] }),
    selectField({ label: 'Pola', name: 'pattern', options: [ALL, { value: 'SA', label: 'SA' }, { value: 'PVA', label: 'PVA' }, { value: 'BOTH', label: 'BOTH' }] }),
    selectField({ label: 'Tahap', name: 'stage', options: [ALL, { value: 'QUIET', label: 'Quiet' }, { value: 'EARLY_BULLISH', label: 'Early bullish' }, { value: 'MOMENTUM_BUILDING', label: 'Momentum' }, { value: 'BREAKOUT', label: 'Breakout' }] }),
    selectField({ label: 'Alignment', name: 'alignment', options: [ALL, { value: 'ALIGNED', label: 'Aligned' }, { value: 'PARTIALLY_CONFIRMED', label: 'Parsial' }, { value: 'UNCONFIRMED', label: 'Unconfirmed' }, { value: 'COUNTERTREND', label: 'Countertrend' }] }),
    selectField({ label: 'Skor minimum', name: 'minScore', options: [ALL, { value: '50', label: '≥ 50' }, { value: '70', label: '≥ 70' }, { value: '85', label: '≥ 85' }] }),
  );

  const count = badge('0 hasil');
  const host = h('div', { 'data-testid': 'screener-results' });
  let request = 0;

  async function load() {
    const id = ++request;
    let data;
    try {
      data = await api(buildQuery(filters));
    } catch (err) {
      if (id !== request) return;
      host.replaceChildren(callout(`Gagal memuat kandidat: ${err.message}`, 'bear'));
      return;
    }
    if (id !== request) return; // respons usang dari filter sebelumnya
    const rows = data.items;
    const filtered = [...new FormData(filters).values()].some(Boolean);
    const truncated = data.count >= SCREENER_LIMIT;
    count.textContent = truncated ? `${data.count}+ hasil` : `${data.count} hasil`;
    const table = dataTable({
      columns: SCREENER_COLUMNS,
      rows,
      caption: 'Kandidat LONG',
      initialSort: { key: 'earlyScore', dir: 'desc' },
      empty: emptyResult(filtered),
    });
    host.replaceChildren(...(truncated
      ? [callout(`Menampilkan ${SCREENER_LIMIT} kandidat teratas menurut Pattern Score; persempit filter untuk melihat sisanya.`, 'warn'), table]
      : [table]));
  }

  filters.addEventListener('change', () => { load(); });
  filters.addEventListener('submit', (e) => e.preventDefault());
  await load();

  return page({
    title: 'LONG Screener',
    subtitle: 'Kandidat struktur bullish per timeframe. Skor mengukur kemiripan dengan aturan pola, bukan probabilitas profit.',
  },
  panel({ title: 'Kandidat', actions: count, flush: true, footer: 'Hanya sinyal dari candle tertutup. Alignment = konteks timeframe lebih tinggi, tidak membuang pola.' }, filters, host));
}
