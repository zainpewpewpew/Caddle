// Smart Money Radar (#/smart-money): Token Accumulation Radar — token yang dibeli lewat SWAP oleh wallet berkualitas
// yang saling independen, dengan bukti per wallet/tx. GET /api/smart-money/radar (docs/15 §5).
// Panel "Evaluasi historis" (GET /api/smart-money/evaluation) menampilkan laporan terakhir `npm run smart-money:evaluate`
// apa adanya, atau keadaan kosong yang jujur bila belum pernah dijalankan.
// Tampilan hasil: "Daftar" (kartu, bawaan) atau "Peta Benang" (smartThreads.js) dari respons yang SAMA — beralih
// tampilan tidak mengirim request baru. Pilihan tersimpan di hash (?view=benang) lewat history.replaceState.
// Tombol "Sync sekarang" (smartMoneySync.js) menjalankan sinkronisasi tanpa menunggu jadwal worker; setiap run yang
// dipantau selesai → radar dimuat ulang dengan filter & tampilan yang sedang dipakai.
import { api } from '../lib/api.js';
import { badge, dataTable, emptyState, page, panel, segmented, selectField, toggle } from '../lib/components.js';
import { h, icon } from '../lib/dom.js';
import { formatRelative, formatTime } from '../lib/format.js';
import { hashQuery } from '../lib/router.js';
import {
  addressLink, binanceBadge, chainBadge, componentBars, disclaimerBox, externalLink, labelChips, loadable, meter,
  metaHeader, noSourceState, simBadge, stateBadge, textList, txLink, typeBadge, usdText, watchButton,
} from './smartMoneyCommon.js';
import {
  CHAINS, CHAIN_LABELS, CONVICTION_COMPONENT_LABELS, EMPTY, RADAR_STATES, SM_API, buildRadarQuery, disclaimersOf,
  evaluationSummary, excludedSummary, explorerTokenUrl, explorerTxUrl, formatSignedPct, isNoSourceState, parseRadarFilters,
  relevanceLabel, signalPatternLabels, signalsByTimeframe, smartTokenHref, smartWalletHref, stateLabel, symbolChartHref,
} from './smartMoneyFormat.js';
import { syncControl } from './smartMoneySync.js';
import { threadsView } from './smartThreads.js';
import { parseRadarView, radarViewHash } from './smartThreadsLayout.js';

const VIEW_OPTIONS = [{ value: 'daftar', label: 'Daftar' }, { value: 'benang', label: 'Peta Benang' }];
const WINDOW_OPTIONS = [{ value: '1h', label: '1 jam' }, { value: '4h', label: '4 jam' }, { value: '24h', label: '24 jam' }, { value: '7d', label: '7 hari' }];
const ALL = { value: '', label: 'Semua' };
const CHAIN_OPTIONS = [ALL, ...CHAINS.map((c) => ({ value: c, label: CHAIN_LABELS[c] }))];
const MIN_BUYER_OPTIONS = [ALL, { value: '2', label: '≥ 2' }, { value: '3', label: '≥ 3' }, { value: '5', label: '≥ 5' }, { value: '10', label: '≥ 10' }];
const STATE_OPTIONS = [ALL, ...RADAR_STATES.map((s) => ({ value: s, label: stateLabel(s).label }))];

/** Sinyal LONG screener per timeframe (5m/15m/1h) dengan label pola. */
export function screenerSignals(screener, { compact = false } = {}) {
  const list = signalsByTimeframe(screener);
  if (!list.length) return h('span', { class: 'muted' }, 'Tidak ada sinyal LONG aktif (5m/15m/1h)');
  return h('ul', { class: 'sm-signals' }, list.map((s) => {
    const patterns = signalPatternLabels(s);
    return h('li', { class: 'sm-signal' },
      h('span', { class: 'mono sm-signal__tf' }, s.timeframe),
      s.tier && badge(`Tier ${s.tier}`, s.tier === 'A' ? 'bull' : s.tier === 'B' ? 'accent' : undefined),
      s.state && h('span', { class: 'stage', 'data-stage': s.state }, String(s.state).replaceAll('_', ' ')),
      !compact && patterns.length ? h('span', { class: 'sm-signal__patterns' }, patterns.join(' · ')) : null,
      compact && patterns.length ? h('span', { class: 'sr-only' }, patterns.join(', ')) : null);
  }));
}

/** Blok relevansi screener + status Binance. */
export function binanceBlock(item) {
  const rel = relevanceLabel(item.screener?.relevance);
  const relBadge = badge(rel.label, rel.tone);
  relBadge.title = item.screener?.relevanceReason || rel.text;
  const chart = symbolChartHref(item.binance);
  return h('div', { class: 'sm-binance' },
    h('div', { class: 'cluster' }, h('span', { class: 'sm-k' }, 'Binance'), binanceBadge(item.binance), relBadge,
      chart && h('a', { class: 'btn btn--sm btn--ghost', href: chart }, icon('symbol', 'btn__icon'), 'Buka chart')),
    item.binance?.status === 'MATCHED' ? screenerSignals(item.screener) : null);
}

/** Tabel pembeli (bukti) per wallet. */
function buyersTable(item) {
  const buyers = Array.isArray(item.buyers) ? item.buyers : [];
  // Pembeli dalam klaster yang sama dihitung SATU pembeli independen.
  const clusterCounts = new Map();
  for (const b of buyers) if (b.clusterId) clusterCounts.set(b.clusterId, (clusterCounts.get(b.clusterId) ?? 0) + 1);
  return dataTable({
    compact: true,
    caption: `Pembeli ${item.token?.symbol ?? ''}`,
    initialSort: { key: 'netBuyUsd', dir: 'desc' },
    animateRows: false,
    columns: [
      {
        key: 'wallet', label: 'Wallet', render: (b) => h('span', { class: 'stack sm-cell-stack' },
          addressLink(b.wallet, smartWalletHref(item.chain, b.wallet), { label: `Profil wallet ${b.wallet}` }),
          labelChips(b.label)),
      },
      { key: 'score', label: 'Skor wallet', numeric: true, render: (b) => (typeof b.score === 'number' ? String(Math.round(b.score)) : EMPTY) },
      {
        key: 'clusterId', label: 'Klaster', render: (b) => {
          const n = clusterCounts.get(b.clusterId) ?? 1;
          return h('span', { title: b.clusterId ? `Klaster ${b.clusterId}` : 'Tanpa klaster' },
            n > 1 ? badge(`1 klaster · ${n} pembeli`, 'warn') : 'mandiri');
        },
      },
      { key: 'netBuyUsd', label: 'Net beli', numeric: true, render: (b) => usdText(b.netBuyUsd, { signed: true, tone: true }) },
      { key: 'buys', label: 'Beli/Jual', numeric: true, render: (b) => `${b.buys ?? 0} / ${b.sells ?? 0}` },
      {
        key: 'txs', label: 'Transaksi', sortable: false, render: (b) => h('ul', { class: 'sm-txs' }, (b.txs ?? []).slice(0, 8).map((t) => h('li', null,
          typeBadge(t.type), ' ', usdText(t.usd), ' ', h('span', { class: 'muted', title: formatTime(t.at) }, formatRelative(t.at)), ' ',
          txLink(t.explorerUrl ?? explorerTxUrl(item.chain, t.txHash), t.txHash), simBadge(t.isSimulated)))),
      },
    ],
    rows: buyers,
    empty: h('p', { class: 'empty__text' }, 'Tidak ada pembeli tercatat.'),
  });
}

/** Panel "Bukti" token radar: pembeli, indikasi keluar, aktivitas yang tidak dihitung, alasan, risiko, penafian. */
export function evidencePanel(item, meta) {
  const d = disclaimersOf(meta);
  const exits = Array.isArray(item.exitSignals) ? item.exitSignals : [];
  return h('div', { class: 'sm-evidence stack' },
    h('h4', { class: 'sm-h' }, 'Pembeli (hanya swap beli yang dihitung)'),
    buyersTable(item),
    h('p', { class: 'sm-excluded', 'data-testid': 'sm-excluded' }, excludedSummary(item.excluded)),
    exits.length > 0 && h('div', null,
      h('h4', { class: 'sm-h' }, 'Indikasi keluar'),
      h('ul', { class: 'sm-txs' }, exits.map((e) => h('li', null,
        typeBadge(e.type), ' ', addressLink(e.wallet, smartWalletHref(item.chain, e.wallet)), ' ', usdText(e.usd), ' ',
        h('span', { class: 'muted' }, formatRelative(e.at)), ' ', txLink(e.explorerUrl ?? explorerTxUrl(item.chain, e.txHash), e.txHash),
        simBadge(e.isSimulated))))),
    h('div', { class: 'grid grid--2 sm-reasons' },
      h('div', null, h('h4', { class: 'sm-h' }, 'Alasan'), textList(item.reasons, { empty: h('p', { class: 'muted' }, EMPTY) })),
      h('div', null, h('h4', { class: 'sm-h' }, 'Risiko'), textList(item.risks, { className: 'sm-list sm-list--risk', empty: h('p', { class: 'muted' }, 'Tidak ada risiko tercatat.') }))),
    item.convictionComponents && h('div', null, h('h4', { class: 'sm-h' }, 'Komponen skor keyakinan'), componentBars(item.convictionComponents, CONVICTION_COMPONENT_LABELS)),
    disclaimerBox([d.conviction, item.screener?.note || d.spotVsFutures]));
}

/** Kartu satu token radar (dapat diperluas untuk bukti). */
function radarCard(item, meta, index) {
  const sym = item.token?.symbol || '?';
  const contract = item.token?.address ?? '';
  const evidenceId = `sm-evidence-${index}`;
  const evidenceHost = h('div', { class: 'sm-card__evidence', id: evidenceId, hidden: true });
  const toggleBtn = h('button', {
    class: 'btn btn--sm', type: 'button', 'aria-expanded': 'false', 'aria-controls': evidenceId,
    on: {
      click: () => {
        const open = toggleBtn.getAttribute('aria-expanded') !== 'true';
        toggleBtn.setAttribute('aria-expanded', String(open));
        if (open && !evidenceHost.firstChild) evidenceHost.append(evidencePanel(item, meta));
        evidenceHost.hidden = !open;
        card.dataset.open = String(open);
      },
    },
  }, icon('signals', 'btn__icon'), 'Bukti');
  const holding = formatSignedPct(item.holdingChangePct);
  const exitsCount = Array.isArray(item.exitSignals) ? item.exitSignals.length : 0;
  const card = h('li', { class: 'sm-card', 'data-state': item.state ?? '', 'data-testid': 'sm-radar-item' },
    h('div', { class: 'sm-card__head' },
      h('div', { class: 'sm-card__id' },
        h('a', { class: 'sm-card__sym', href: smartTokenHref(item.chain, contract) }, sym),
        chainBadge(item.chain),
        externalLink(explorerTokenUrl(item.chain, contract), h('span', { class: 'mono' }, contract.length > 14 ? `${contract.slice(0, 8)}…${contract.slice(-6)}` : contract),
          { label: `Kontrak ${sym} ${contract} di explorer (tab baru)` }),
        item.isSimulated ? badge('SIMULASI', 'warn') : null),
      h('div', { class: 'cluster' }, stateBadge(item.state),
        h('span', { class: 'muted sm-card__time', title: formatTime(item.lastActivityAt) }, `aktivitas ${formatRelative(item.lastActivityAt)}`))),
    h('div', { class: 'sm-card__body' },
      meter(item.conviction, { label: 'Skor keyakinan (bukan probabilitas)' }),
      h('dl', { class: 'sm-facts' },
        h('div', null, h('dt', null, 'Pembeli independen'), h('dd', { class: 'num' }, `${item.independentBuyers ?? 0} dari ${item.buyerCount ?? 0}`)),
        h('div', null, h('dt', null, 'Net flow'), h('dd', null, usdText(item.netFlowUsd, { signed: true, tone: true }))),
        h('div', null, h('dt', null, 'Gross beli'), h('dd', null, usdText(item.grossBuyUsd))),
        h('div', null, h('dt', null, 'Gross jual'), h('dd', null, usdText(item.grossSellUsd))),
        h('div', null, h('dt', null, 'Perubahan kepemilikan'), h('dd', { class: 'num', title: holding === EMPTY ? 'Kepemilikan sebelumnya tidak diketahui' : undefined }, holding)),
        h('div', null, h('dt', null, 'Indikasi keluar'), h('dd', { class: 'num' }, exitsCount ? h('span', { class: 'delta delta--down' }, String(exitsCount)) : '0')),
        item.unknownUsdCount > 0 && h('div', null, h('dt', null, 'Tx tanpa nilai USD'), h('dd', { class: 'num', title: 'nilai USD tidak diketahui — tidak dihitung sebagai 0' }, String(item.unknownUsdCount)))),
      binanceBlock(item)),
    h('div', { class: 'sm-card__actions cluster' },
      toggleBtn,
      watchButton({ kind: 'TOKEN', chain: item.chain, address: contract, watching: item.watching, compact: true, name: sym }),
      h('a', { class: 'btn btn--sm btn--ghost', href: smartTokenHref(item.chain, contract) }, 'Detail token')),
    evidenceHost);
  return card;
}

const EVALUATION_NOTE = 'Hasil in-sample terhadap data yang tersedia; harga masuk/keluar memakai harga tersirat dari swap (kasar). Hit rate per horizon BUKAN peluang terkalibrasi, dan kinerja masa lalu tidak menjamin hasil masa depan.';

/** Isi panel evaluasi historis dari respons GET /evaluation. */
export function evaluationContent(data) {
  const ev = evaluationSummary(data);
  if (!ev.available) {
    return emptyState({
      iconName: 'backtest',
      title: 'Belum ada evaluasi historis',
      text: 'Skor keyakinan radar belum diuji pada data historis di server ini. Setelah data tersinkron cukup lama (± 45 hari), admin dapat menjalankan `npm run smart-money:evaluate`; laporannya tampil di sini. Sampai saat itu perlakukan skor keyakinan sebagai ringkasan bukti — bukan peluang profit.',
    });
  }
  const range = ev.start !== null && ev.end !== null ? `${formatTime(ev.start)} → ${formatTime(ev.end)}` : EMPTY;
  return h('div', { class: 'stack sm-eval', 'data-testid': 'sm-evaluation' },
    h('p', { class: 'cluster sm-eval__meta' },
      simBadge(ev.simulated),
      h('span', null, `Dihitung ${ev.computedAt ? formatTime(ev.computedAt) : EMPTY}`),
      h('span', { class: 'muted' }, `rentang ${range} · ${ev.steps ?? EMPTY} titik setiap ${ev.stepLabel} · jendela radar ${ev.windowLabel}`),
      h('span', { class: 'muted' }, `syarat sinyal ≥ ${ev.minIndependentBuyers ?? EMPTY} pembeli independen · ${ev.signals} sinyal dari ${ev.candidates} kandidat`)),
    dataTable({
      compact: true,
      animateRows: false,
      caption: 'Hasil evaluasi historis per horizon (semua ember keyakinan)',
      columns: [
        { key: 'horizon', label: 'Horizon', sortable: false },
        { key: 'signals', label: 'Sinyal', numeric: true, sortable: false },
        { key: 'coverage', label: 'Cakupan harga', numeric: true, sortable: false },
        { key: 'mean', label: 'Rata-rata return', numeric: true, sortable: false },
        { key: 'median', label: 'Median', numeric: true, sortable: false },
        { key: 'hitRate', label: 'Hit rate', numeric: true, sortable: false, render: (r) => h('span', { title: `CI 95%: ${r.hitRateCi}` }, r.hitRate) },
        { key: 'baseline', label: 'Baseline', numeric: true, sortable: false },
        { key: 'excess', label: 'Selisih vs baseline', numeric: true, sortable: false },
        { key: 'warnings', label: 'Catatan', sortable: false, render: (r) => h('span', { class: 'sm-reason' }, r.warnings.join('; ') || EMPTY) },
      ],
      rows: ev.rows,
      empty: h('p', { class: 'empty__text' }, 'Laporan tidak memuat horizon.'),
    }),
    ev.warnings.length > 0 && h('div', null, h('h4', { class: 'sm-h' }, 'Peringatan laporan'), textList(ev.warnings, { className: 'sm-list sm-list--risk' })),
    h('p', { class: 'sm-disclaimer-inline' }, EVALUATION_NOTE));
}

/** Panel evaluasi historis (dimuat terpisah: kegagalannya tidak memengaruhi radar). */
function evaluationSection() {
  const view = loadable({ what: 'evaluasi historis', fetcher: () => api(`${SM_API}/evaluation`), render: evaluationContent });
  return { el: panel({ title: 'Evaluasi historis radar' }, view.el), load: view.load };
}

function readFilters(form) {
  const fd = new FormData(form);
  return {
    window: fd.get('window'),
    chain: fd.get('chain'),
    minBuyers: fd.get('minBuyers'),
    state: fd.get('state'),
    linked: form.elements.linked.checked,
  };
}

function setSelect(form, name, value) {
  const el = form.elements[name];
  if (el && value !== undefined) el.value = value;
}

/** Simpan tampilan di hash tanpa memicu hashchange (halaman tidak dirender ulang, tidak ada request baru). */
function persistView(view) {
  try {
    const next = radarViewHash(window.location.hash, view);
    if (next !== window.location.hash) window.history?.replaceState?.(window.history.state, '', next);
  } catch {
    // History API tidak tersedia — pilihan tetap berlaku sampai halaman dimuat ulang.
  }
}

/**
 * Pengalih "Daftar | Peta Benang" untuk hasil radar. Di luar <form> filter: perubahannya tidak memuat ulang radar.
 * Peta dibangun malas pada kali pertama dibuka dari respons terakhir yang sudah dimuat.
 */
function resultViews(initialView) {
  let mode = initialView;
  let current = null; // { items, meta, now, list, mapHost }
  const control = segmented({ name: 'radarView', options: VIEW_OPTIONS, value: mode, label: 'Tampilan hasil radar' });
  const apply = () => {
    if (!current) return;
    current.list.hidden = mode !== 'daftar';
    current.mapHost.hidden = mode !== 'benang';
    if (mode === 'benang' && !current.mapHost.firstChild) {
      current.mapHost.append(threadsView(current.items, current.meta, { now: current.now }));
    }
  };
  control.addEventListener('change', (e) => {
    const value = e.target?.value;
    if (value !== 'daftar' && value !== 'benang') return;
    mode = value;
    apply();
    persistView(mode);
  });
  return {
    bar: h('div', { class: 'sm-viewbar' }, h('span', { class: 'sm-k', 'aria-hidden': 'true' }, 'Tampilan'), control),
    /** Daftar kartu + wadah peta untuk satu respons; mengembalikan node yang ditampilkan. */
    show({ items, meta, now, list }) {
      const mapHost = h('div', { class: 'sm-thr-host', 'data-testid': 'sm-threads-host' });
      current = { items, meta, now, list, mapHost };
      apply();
      return [list, mapHost];
    },
    reset() {
      current = null;
    },
  };
}

/** @param {{ user?: { role: string } }|undefined} ctx */
export async function smartMoneyView(ctx) {
  const initial = parseRadarFilters(hashQuery());
  const results = resultViews(parseRadarView(hashQuery()));
  const form = h('form', { class: 'toolbar sm-toolbar', 'aria-label': 'Filter radar smart money' },
    h('div', { class: 'field' }, h('span', { class: 'field__label', 'aria-hidden': 'true' }, 'Jendela'),
      segmented({ name: 'window', options: WINDOW_OPTIONS, value: initial.window, label: 'Jendela waktu radar' })),
    selectField({ label: 'Chain', name: 'chain', options: CHAIN_OPTIONS, value: initial.chain }),
    selectField({ label: 'Min. pembeli independen', name: 'minBuyers', options: MIN_BUYER_OPTIONS, value: initial.minBuyers }),
    selectField({ label: 'Status', name: 'state', options: STATE_OPTIONS, value: initial.state }),
    h('div', { class: 'field sm-toolbar__switch' }, toggle({ name: 'linked', label: 'Hanya yang terhubung ke Binance', checked: initial.linked })));
  setSelect(form, 'chain', initial.chain);
  form.addEventListener('submit', (e) => e.preventDefault());

  const count = badge('0 token');
  const metaHost = h('div');
  const view = loadable({
    what: 'radar smart money',
    fetcher: () => api(buildRadarQuery(readFilters(form))),
    render: (data) => {
      const now = Date.now();
      const items = Array.isArray(data?.items) ? data.items : [];
      metaHost.replaceChildren(metaHeader(data?.meta, now));
      count.textContent = `${items.length} token`;
      results.reset();
      if (isNoSourceState(data?.meta, items.length)) return noSourceState();
      if (!items.length) {
        const filtered = Boolean(form.elements.chain.value || form.elements.minBuyers.value || form.elements.state.value || form.elements.linked.checked);
        return emptyState({
          iconName: 'radar',
          title: filtered ? 'Tidak ada token yang cocok dengan filter' : 'Belum ada akumulasi pada jendela ini',
          text: filtered ? 'Longgarkan filter atau pilih jendela waktu lebih panjang.' : 'Radar hanya menghitung swap beli dari wallet eligible yang tidak ber-flag. Tidak ada data contoh yang ditampilkan.',
        });
      }
      return [
        data.computedAt ? h('p', { class: 'muted sm-computed' }, `Dihitung ${formatRelative(data.computedAt, now)} · ${formatTime(data.computedAt)} · jendela ${data.window ?? EMPTY}`) : null,
        ...results.show({
          items,
          meta: data.meta,
          now,
          list: h('ul', { class: 'sm-radar', 'aria-label': 'Token yang diakumulasi' }, items.map((item, i) => radarCard(item, data.meta, i))),
        }),
      ];
    },
  });
  form.addEventListener('change', () => { view.load(); });
  await view.load();
  const evaluation = evaluationSection();
  await evaluation.load();

  // Dibuat setelah semua await, tepat sebelum halaman dipasang: timer polling-nya berhenti sendiri saat halaman dilepas
  // (tanpa cleanup, seperti kontrol scanner persisten). Run yang dipantau selesai → radar dimuat ulang (view.load
  // membaca filter form saat ini; tampilan Daftar/Peta Benang dipertahankan resultViews).
  const sync = syncControl({ user: ctx?.user, onFinished: () => { view.load(); } });

  const d = disclaimersOf(null);
  const el = page({
    title: 'Smart Money Radar',
    subtitle: 'Token Accumulation Radar: token yang sedang dibeli lewat swap oleh beberapa wallet berkualitas yang saling independen. Transfer, penarikan exchange, bridge, airdrop, dan LP tidak dihitung sebagai pembelian.',
    actions: [sync.button,
      h('a', { class: 'btn btn--sm btn--ghost', href: '#/smart-wallets' }, icon('wallet', 'btn__icon'), 'Wallet Discovery'),
      h('a', { class: 'btn btn--sm btn--ghost', href: '#/smart-watchlist' }, icon('bell', 'btn__icon'), 'Watchlist & Alerts')],
  },
  sync.el,
  metaHost,
  h('p', { class: 'sm-insider-note', 'data-testid': 'sm-insider-note' }, icon('lock', 'sm-insider-note__icon'), d.insiderName),
  panel({ title: 'Token yang diakumulasi', actions: count, flush: true, footer: `${d.conviction} ${d.readOnly}` }, form,
    h('div', { class: 'sm-panel-body stack' }, results.bar, view.el)),
  evaluation.el);
  el.classList.add('page--smart-money');
  return el;
}
