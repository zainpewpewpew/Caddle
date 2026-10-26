import { api } from '../lib/api.js';
import { animateNumber, badge, dataTable, emptyState, page, panel, stat } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatInteger, formatPercent, formatPrice, formatRelative, formatTime } from '../lib/format.js';
import { diffNewSignals, mountConstellation, normalizeSignals, stageLabel } from './constellation.js';
import { MILESTONES } from './roadmap.js';
import { directionBadge, directionOf, signalStage } from './signalFormat.js';
import { workerControlBar } from './workerControl.js';
import { binancePill, scannerPill } from './workerFormat.js';

const TREND_TONE = { BULLISH: 'bull', NEUTRAL: undefined, BEARISH: 'bear' };
// Penyegaran latar Overview. Sengaja bukan 10 dtk (interval health) dan memakai setTimeout berantai.
export const OVERVIEW_REFRESH_MS = 20_000;
// Sama dengan batas Screener: sinyal terbuka maks. 1 per simbol × TF × arah, sehingga 500 mencakup seluruh hasil.
const ACTIVE_LIMIT = 500;
const COUNT_UP_MS = 900;

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

/**
 * Distribusi tahap per arah dari sinyal aktif nyata (untuk panel samping konstelasi).
 * @param {Array<{ direction: string, state: string }>} signals
 */
export function stageDistribution(signals) {
  const order = {
    LONG: ['QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT'],
    SHORT: ['QUIET', 'EARLY_BEARISH', 'MOMENTUM_BUILDING', 'BREAKDOWN'],
  };
  const out = {};
  for (const dir of ['LONG', 'SHORT']) {
    const list = signals.filter((s) => s.direction === dir);
    out[dir] = { total: list.length, stages: order[dir].map((state) => ({ state, count: list.filter((s) => s.state === state).length })) };
  }
  return out;
}

/**
 * KPI angka yang dapat diperbarui. Nilai dihitung naik (animateNumber dari components.js) dari angka tampil terakhir
 * ke nilai NYATA berikutnya; nilai bukan angka → '—'. `stop()` menghentikan animasi dan menulis nilai akhir.
 */
function kpi({ label, hint, testId, tone }) {
  const el = stat({ label, value: '—', hint, testId, tone });
  el.classList.add('ov-kpi');
  const valueEl = el.querySelector('.stat__value');
  let current = 0;
  return {
    el,
    set(value) {
      if (!Number.isFinite(value)) {
        animateNumber(valueEl, Number.NaN, { format: () => '—' });
        valueEl.classList.add('stat__value--muted');
        return;
      }
      valueEl.classList.remove('stat__value--muted');
      animateNumber(valueEl, value, { from: current, format: formatInteger, duration: COUNT_UP_MS });
      current = value;
    },
    stop() {
      // from === to → membatalkan animasi berjalan dan langsung menulis nilai akhir.
      if (valueEl.hasAttribute('data-counting')) animateNumber(valueEl, current, { from: current, format: formatInteger });
    },
  };
}

function marketBody(data) {
  const hasContext = (data.marketContext ?? []).some((m) => HAS_PRICE.has(m.status));
  return hasContext
    ? h('dl', { class: 'kv ov-market' }, data.marketContext.flatMap((m) => [
      h('dt', { class: 'mono' }, m.symbol),
      h('dd', null, HAS_PRICE.has(m.status)
        ? h('span', { class: 'cluster' },
          trendBadge(m),
          h('span', { class: 'num' }, formatPrice(m.lastPrice)),
          h('span', { class: Number(m.change24h) < 0 ? 'num ov-delta ov-delta--down' : 'num ov-delta ov-delta--up' }, `24j ${formatPercent(m.change24h)}`),
          h('span', { class: 'muted' }, formatTime(m.asOf)))
        : 'Belum ada data'),
    ]))
    : emptyState({
      iconName: 'symbol',
      title: 'Konteks BTC/ETH belum tersedia',
      text: 'Muncul setelah worker mengingesti candle 1h BTCUSDT/ETHUSDT dari Binance USDT-M Futures. Tidak ada data contoh yang ditampilkan.',
    });
}

function detectionsBody(data) {
  const rows = data.recentDetections ?? [];
  // Kolom Arah hanya bila baris membawa field direction: baris tanpa field itu tidak pernah diberi label arah tebakan.
  const hasDirection = rows.some((r) => r.direction !== undefined);
  return dataTable({
    compact: true,
    caption: 'Deteksi pola terbaru',
    columns: [
      { key: 'symbol', label: 'Symbol', render: (r) => h('span', { class: 'mono' }, r.symbol) },
      hasDirection && { key: 'direction', label: 'Arah', render: (r) => directionBadge(r.direction), sortValue: (r) => directionOf(r.direction) },
      { key: 'timeframe', label: 'TF' },
      { key: 'classification', label: 'Pola' },
      { key: 'state', label: 'Tahap', render: (r) => signalStage(r.state, r.direction) },
      { key: 'first_detected_at', label: 'Deteksi pertama', render: (r) => formatTime(r.first_detected_at) },
    ].filter(Boolean),
    rows,
    empty: emptyState({ iconName: 'radar', title: 'Belum ada deteksi', text: 'Deteksi SA/PVA (LONG) dan SD/PVD (SHORT) muncul di sini setelah worker berjalan dan menemukan pola pada candle tertutup.' }),
  });
}

function statusBody(data) {
  return h('dl', { class: 'kv' },
    h('dt', null, 'Scanner'), h('dd', null, scannerPill(data.scanner)),
    h('dt', null, 'Koneksi Binance'), h('dd', null, binancePill(data.binance)),
    h('dt', null, 'Kesegaran data'), h('dd', null, data.lastIngestionAt ? formatRelative(data.lastIngestionAt) : '—'),
    h('dt', null, 'Timeframe'), h('dd', { class: 'mono' }, '5m · 15m · 1h'));
}

/** Panel samping konstelasi: distribusi tahap per arah (angka nyata) + keseimbangan LONG/SHORT. */
function distributionBody(signals, failed) {
  const dist = stageDistribution(signals);
  const total = dist.LONG.total + dist.SHORT.total;
  const longShare = total ? dist.LONG.total / total : 0.5;
  const balance = h('div', { class: 'ov-balance' },
    h('div', { class: 'ov-balance__labels' },
      h('span', { class: 'ov-balance__long' }, `LONG ${formatInteger(dist.LONG.total)}`),
      h('span', { class: 'ov-balance__short' }, `SHORT ${formatInteger(dist.SHORT.total)}`)),
    h('div', {
      class: total ? 'ov-balance__track' : 'ov-balance__track ov-balance__track--empty',
      role: 'img',
      'aria-label': total ? `Keseimbangan kandidat: ${dist.LONG.total} LONG, ${dist.SHORT.total} SHORT` : 'Belum ada kandidat aktif',
    }, h('span', { class: 'ov-balance__fill', style: { '--ov-share': `${(longShare * 100).toFixed(1)}%` } })));
  const group = (dir) => {
    const d = dist[dir];
    const max = Math.max(1, ...d.stages.map((s) => s.count));
    return h('section', { class: 'ov-dist', 'data-direction': dir },
      h('h3', { class: 'ov-dist__title' }, dir === 'LONG' ? 'Tahap LONG' : 'Tahap SHORT',
        failed.includes(dir) && badge('Gagal dimuat', 'warn')),
      h('ul', { class: 'ov-dist__list' }, d.stages.map((s) => h('li', { class: 'ov-dist__row', 'data-stage': s.state },
        h('span', { class: 'ov-dist__label' }, stageLabel(s.state)),
        h('span', { class: 'ov-dist__bar', 'aria-hidden': 'true' },
          h('span', { class: 'ov-dist__fill', style: { '--ov-frac': (s.count / max).toFixed(3) } })),
        h('span', { class: 'num ov-dist__count' }, formatInteger(s.count))))));
  };
  return [balance, group('LONG'), group('SHORT')];
}

/** Mengambil data Overview + sinyal aktif LONG & SHORT. Kegagalan sinyal tidak menggagalkan Overview. */
async function loadSignals(background) {
  const opts = { background };
  const [longRes, shortRes] = await Promise.all([
    api(`/api/signals/active?limit=${ACTIVE_LIMIT}`, opts).catch(() => null),
    api(`/api/signals/active?direction=SHORT&limit=${ACTIVE_LIMIT}`, opts).catch(() => null),
  ]);
  const failed = [];
  if (!longRes) failed.push('LONG');
  if (!shortRes) failed.push('SHORT');
  return {
    signals: [...normalizeSignals(longRes?.items, 'LONG'), ...normalizeSignals(shortRes?.items, 'SHORT')],
    failed,
  };
}

function emitActivity(diff) {
  if (typeof window === 'undefined') return;
  for (const [kind, n] of [['bull', diff.bull], ['bear', diff.bear]]) {
    if (n > 0) window.dispatchEvent(new CustomEvent('lr:activity', { detail: { kind, count: Math.min(12, n) } }));
  }
}

export async function overviewView(ctx) {
  // Status kontrol scanner bersifat pelengkap: kegagalannya tidak boleh menggagalkan Overview.
  const [data, worker, initialSignals] = await Promise.all([
    api('/api/overview'),
    api('/api/system/worker').catch(() => null),
    loadSignals(false),
  ]);

  const k = {
    monitored: kpi({ label: 'Simbol dipantau', hint: 'USDT-M perpetual', testId: 'kpi-monitored', tone: 'accent' }),
    long: kpi({ label: 'Kandidat LONG aktif', hint: 'QUIET → BREAKOUT', testId: 'kpi-active', tone: 'bull' }),
    short: kpi({ label: 'Kandidat SHORT aktif', hint: 'QUIET → BREAKDOWN', testId: 'kpi-active-short', tone: 'bear' }),
    // earlySignals & alignedSignals dari server tetap hitungan LONG (rincian per arah: earlyByDirection/alignedByDirection).
    early: kpi({ label: 'Sinyal tahap awal', hint: 'EARLY_BULLISH' }),
    aligned: kpi({ label: 'Konfirmasi multi-TF', hint: 'Sinyal LONG aktif ALIGNED' }),
  };
  const ingestEl = stat({ label: 'Ingesti terakhir', value: '—', muted: true, hint: 'Belum ada candle tersimpan' });
  ingestEl.classList.add('ov-kpi');
  const kpis = h('div', { class: 'grid grid--kpi ov-kpis' }, k.monitored.el, k.long.el, k.short.el, k.early.el, k.aligned.el, ingestEl);

  const marketSlot = h('div', { class: 'ov-slot' });
  const detectionsSlot = h('div', { class: 'ov-slot ov-detections' });
  const statusSlot = h('div', { class: 'ov-slot' });
  const distSlot = h('div', { class: 'ov-hero__aside' });
  const updatedEl = h('span', { class: 'ov-live__time num' });
  const live = h('span', { class: 'ov-live', title: `Diperbarui otomatis tiap ${OVERVIEW_REFRESH_MS / 1000} detik` },
    h('span', { class: 'ov-live__dot', 'aria-hidden': 'true' }), 'Langsung', updatedEl);

  const constellation = mountConstellation({ signals: initialSignals.signals, error: initialSignals.failed.length === 2 });
  // Muatan awal sebagian gagal → belum ada pembanding: muatan lengkap berikutnya menjadi dasar, tanpa event.
  let knownKeys = initialSignals.failed.length ? null : diffNewSignals(null, initialSignals.signals).keys;

  function applyOverview(d) {
    const byDirection = activeCountsByDirection(d);
    k.monitored.set(d.monitoredSymbols);
    k.long.set(byDirection ? byDirection.LONG : d.activeSignals);
    // Hanya bila server melaporkan jumlah per arah; payload lama tidak menampilkan angka SHORT tebakan.
    k.short.el.hidden = !byDirection;
    if (byDirection) k.short.set(byDirection.SHORT);
    k.early.set(d.earlySignals);
    k.aligned.set(d.alignedSignals);
    const ingestValue = ingestEl.querySelector('.stat__value');
    ingestValue.textContent = d.lastIngestionAt ? formatRelative(d.lastIngestionAt) : '—';
    ingestValue.classList.toggle('stat__value--muted', !d.lastIngestionAt);
    ingestEl.querySelector('.stat__hint').textContent = d.lastIngestionAt ? formatTime(d.lastIngestionAt) : 'Belum ada candle tersimpan';
    marketSlot.replaceChildren(marketBody(d));
    detectionsSlot.replaceChildren(detectionsBody(d));
    statusSlot.replaceChildren(statusBody(d));
  }

  function applySignals({ signals, failed }) {
    constellation.update(signals, { error: failed.length === 2 });
    distSlot.replaceChildren(...distributionBody(signals, failed));
    updatedEl.textContent = formatTime(Date.now());
  }

  applyOverview(data);
  applySignals(initialSignals);

  const hero = panel({
    title: 'Konstelasi sinyal',
    actions: [badge('Sinyal aktif nyata', 'accent'), live],
    footer: 'Node = sinyal terbuka di database · ukuran ∝ Early Score · garis = simbol, tahap, atau timeframe sama · berdenyut = BREAKOUT/BREAKDOWN. Klik node (atau fokus kanvas + panah, Enter) untuk membuka Symbol Intelligence.',
  }, h('div', { class: 'ov-hero' }, h('div', { class: 'ov-hero__main' }, constellation.el), distSlot));
  hero.classList.add('ov-hero-panel');

  const roadmap = panel({ title: 'Roadmap' },
    h('ol', { class: 'timeline' }, MILESTONES.map((m) => h('li', { class: 'timeline__item', 'data-state': m.state },
      h('span', { class: 'timeline__dot', 'aria-hidden': 'true' }),
      h('span', null, h('span', { class: 'timeline__title' }, `${m.n}. ${m.title}`), h('br'), h('span', { class: 'timeline__text' }, m.text)),
      m.state === 'active' ? badge('Berjalan', 'accent') : null))));

  const el = page({
    title: 'Overview',
    subtitle: 'Ringkasan kondisi pemindaian. Semua angka berasal dari database; nilai nol berarti memang belum ada data.',
  },
  workerControlBar({ user: ctx?.user, status: worker }),
  kpis,
  hero,
  h('div', { class: 'grid grid--main-side ov-grid' },
    h('div', { class: 'stack' },
      panel({ title: 'Konteks pasar · BTC & ETH', actions: badge('1h · candle tertutup') }, marketSlot),
      panel({ title: 'Deteksi pola terbaru', flush: true }, detectionsSlot)),
    h('div', { class: 'stack' }, panel({ title: 'Status pemindaian' }, statusSlot), roadmap)));
  el.classList.add('ov-page');

  let timer = null;
  let stopped = false;
  let inFlight = false;

  async function refresh() {
    timer = null;
    // Halaman sudah tidak terpasang (dilepas tanpa cleanup) → berhenti sendiri, seperti kontrol scanner.
    if (stopped || !el.isConnected) {
      if (!stopped) constellation.destroy();
      return;
    }
    if (!inFlight && !document.hidden) {
      inFlight = true;
      try {
        // Penyegaran latar bukan aktivitas pengguna: tidak memperpanjang idle timeout sesi.
        const [d, s] = await Promise.all([api('/api/overview', { background: true }).catch(() => null), loadSignals(true)]);
        if (stopped) return;
        if (d) applyOverview(d);
        applySignals(s);
        // Hanya sinyal dari arah yang berhasil dimuat yang dibandingkan: kegagalan sesaat bukan "sinyal hilang/baru".
        if (s.failed.length === 0) {
          const diff = diffNewSignals(knownKeys, s.signals);
          knownKeys = diff.keys;
          emitActivity(diff);
        }
      } catch {
        // Error ditampilkan oleh indikator koneksi di topbar; dicoba lagi pada putaran berikutnya.
      } finally {
        inFlight = false;
      }
    }
    if (!stopped) timer = setTimeout(refresh, OVERVIEW_REFRESH_MS);
  }
  timer = setTimeout(refresh, OVERVIEW_REFRESH_MS);

  return {
    el,
    cleanup: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const tile of Object.values(k)) tile.stop();
      constellation.destroy();
    },
  };
}
