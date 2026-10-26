import { api } from '../lib/api.js';
import { badge, dataTable, emptyState, page, panel, stat } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatInteger, formatPercent, formatPrice, formatRelative, formatUtc } from '../lib/format.js';
import { MILESTONES } from './roadmap.js';
import { directionBadge, directionOf, signalStage } from './signalFormat.js';
import { workerControlBar } from './workerControl.js';
import { binancePill, scannerPill } from './workerFormat.js';

const TREND_TONE = { BULLISH: 'bull', NEUTRAL: undefined, BEARISH: 'bear' };

/**
 * Label badge trend konteks pasar. Trend null (data 1h kurang dari warm-up / tidak diketahui) tampil
 * sebagai "tidak tersedia" bernada peringatan — tidak pernah sebagai badge NEUTRAL.
 * @returns {{ text: string, tone: string|undefined }}
 */
export function marketTrendBadge(item) {
  if (item?.trend && Object.hasOwn(TREND_TONE, item.trend)) return { text: item.trend, tone: TREND_TONE[item.trend] };
  const count = Number.isInteger(item?.candleCount) ? ` (${item.candleCount} candle 1h)` : '';
  return { text: item?.status === 'insufficient_data' ? `Trend tidak tersedia: data kurang${count}` : 'Trend tidak tersedia', tone: 'warn' };
}

const HAS_PRICE = new Set(['ok', 'insufficient_data']);

function trendBadge(item) {
  const { text, tone } = marketTrendBadge(item);
  return badge(text, tone);
}

/**
 * Jumlah kandidat aktif per arah dari `activeByDirection` (bila payload Overview memuatnya).
 * @returns {{ LONG: number, SHORT: number }|null} null → payload lama: KPI memakai activeSignals saja.
 */
export function activeCountsByDirection(data) {
  const map = data?.activeByDirection;
  if (!map || typeof map !== 'object') return null;
  return Number.isInteger(map.LONG) && Number.isInteger(map.SHORT) ? { LONG: map.LONG, SHORT: map.SHORT } : null;
}

export async function overviewView(ctx) {
  // Status kontrol scanner bersifat pelengkap: kegagalannya tidak boleh menggagalkan Overview.
  const [data, worker] = await Promise.all([api('/api/overview'), api('/api/system/worker').catch(() => null)]);

  const byDirection = activeCountsByDirection(data);
  const kpis = h('div', { class: 'grid grid--kpi' },
    stat({ label: 'Simbol dipantau', value: formatInteger(data.monitoredSymbols), hint: 'USDT-M perpetual', testId: 'kpi-monitored' }),
    stat({ label: 'Kandidat LONG aktif', value: formatInteger(byDirection ? byDirection.LONG : data.activeSignals), hint: 'QUIET → BREAKOUT', testId: 'kpi-active' }),
    // Hanya bila server melaporkan jumlah per arah; payload lama tidak menampilkan angka SHORT tebakan.
    byDirection && stat({ label: 'Kandidat SHORT aktif', value: formatInteger(byDirection.SHORT), hint: 'QUIET → BREAKDOWN', testId: 'kpi-active-short' }),
    stat({ label: 'Sinyal tahap awal', value: formatInteger(data.earlySignals), hint: 'EARLY_BULLISH' }),
    stat({ label: 'Konfirmasi multi-TF', value: formatInteger(data.alignedSignals), hint: 'Sinyal aktif ALIGNED' }),
    stat({
      label: 'Ingesti terakhir',
      value: data.lastIngestionAt ? formatRelative(data.lastIngestionAt) : '—',
      muted: !data.lastIngestionAt,
      hint: data.lastIngestionAt ? formatUtc(data.lastIngestionAt) : 'Belum ada candle tersimpan',
    }),
  );

  const hasContext = data.marketContext.some((m) => HAS_PRICE.has(m.status));
  const market = panel({ title: 'Konteks pasar · BTC & ETH', actions: badge('1h · candle tertutup') },
    hasContext
      ? h('dl', { class: 'kv' }, data.marketContext.flatMap((m) => [
        h('dt', { class: 'mono' }, m.symbol),
        h('dd', null, HAS_PRICE.has(m.status)
          ? h('span', { class: 'cluster' },
            trendBadge(m),
            h('span', { class: 'num' }, formatPrice(m.lastPrice)),
            h('span', { class: 'num' }, `24j ${formatPercent(m.change24h)}`),
            h('span', { class: 'muted' }, formatUtc(m.asOf)))
          : 'Belum ada data'),
      ]))
      : emptyState({
        iconName: 'symbol',
        title: 'Konteks BTC/ETH belum tersedia',
        text: 'Muncul setelah worker mengingesti candle 1h BTCUSDT/ETHUSDT dari Binance USDT-M Futures. Tidak ada data contoh yang ditampilkan.',
      }));

  // Kolom Arah hanya bila baris membawa field direction: baris tanpa field itu tidak pernah diberi label arah tebakan.
  const hasDirection = data.recentDetections.some((r) => r.direction !== undefined);
  const detections = panel({ title: 'Deteksi pola terbaru', flush: true },
    dataTable({
      compact: true,
      caption: 'Deteksi pola terbaru',
      columns: [
        { key: 'symbol', label: 'Symbol' },
        hasDirection && { key: 'direction', label: 'Arah', render: (r) => directionBadge(r.direction), sortValue: (r) => directionOf(r.direction) },
        { key: 'timeframe', label: 'TF' },
        { key: 'classification', label: 'Pola' },
        { key: 'state', label: 'Tahap', render: (r) => signalStage(r.state, r.direction) },
        { key: 'first_detected_at', label: 'Deteksi pertama', render: (r) => formatUtc(r.first_detected_at) },
      ].filter(Boolean),
      rows: data.recentDetections,
      empty: emptyState({ iconName: 'radar', title: 'Belum ada deteksi', text: 'Deteksi SA/PVA (LONG) dan SD/PVD (SHORT) muncul di sini setelah worker berjalan dan menemukan pola pada candle tertutup.' }),
    }));

  const status = panel({ title: 'Status pemindaian' },
    h('dl', { class: 'kv' },
      h('dt', null, 'Scanner'), h('dd', null, scannerPill(data.scanner)),
      h('dt', null, 'Koneksi Binance'), h('dd', null, binancePill(data.binance)),
      h('dt', null, 'Kesegaran data'), h('dd', null, data.lastIngestionAt ? formatRelative(data.lastIngestionAt) : '—'),
      h('dt', null, 'Timeframe'), h('dd', { class: 'mono' }, '5m · 15m · 1h')));

  const roadmap = panel({ title: 'Roadmap' },
    h('ol', { class: 'timeline' }, MILESTONES.map((m) => h('li', { class: 'timeline__item', 'data-state': m.state },
      h('span', { class: 'timeline__dot', 'aria-hidden': 'true' }),
      h('span', null, h('span', { class: 'timeline__title' }, `${m.n}. ${m.title}`), h('br'), h('span', { class: 'timeline__text' }, m.text)),
      m.state === 'active' ? badge('Berjalan', 'accent') : null))));

  return page({
    title: 'Overview',
    subtitle: 'Ringkasan kondisi pemindaian. Semua angka berasal dari database; nilai nol berarti memang belum ada data.',
  },
  workerControlBar({ user: ctx?.user, status: worker }),
  kpis,
  h('div', { class: 'grid grid--main-side' },
    h('div', { class: 'stack' }, market, detections),
    h('div', { class: 'stack' }, status, roadmap)));
}
