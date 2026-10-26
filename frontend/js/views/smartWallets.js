// Wallet Discovery (#/smart-wallets) dan Profil Wallet (#/smart-wallet?c=<chain>&a=<alamat>).
// GET /api/smart-money/wallets dan /wallets/:chain/:address (docs/15 §5).
import { api } from '../lib/api.js';
import { badge, callout, dataTable, emptyState, page, panel, score, selectField, stat, toggle } from '../lib/components.js';
import { h, icon } from '../lib/dom.js';
import { formatInteger, formatRelative, formatUtc } from '../lib/format.js';
import { hashQuery } from '../lib/router.js';
import {
  chainBadge, componentBars, copyButton, disclaimerBox, externalLink, flagChips, labelChips, loadable, metaHeader,
  noSourceState, simBadge, textList, tokenLink, txLink, typeBadge, usdText, walletLink, watchButton,
} from './smartMoneyCommon.js';
import {
  CHAINS, CHAIN_LABELS, EMPTY, SCORE_COMPONENT_LABELS, TRADING_STYLES, buildWalletsQuery, clampScore, clusterEvidenceText,
  clusterReasonLabel, clusterText, completenessBasisText, completenessLabel, disclaimersOf, entityPath, evidenceLines, explorerAddressUrl,
  explorerTxUrl, flagInfo, formatDrawdownPct, formatQty, formatRatioPct, isNoSourceState, labelText, parseEntityQuery,
  shortAddress, styleLabel,
} from './smartMoneyFormat.js';

const ALL = { value: '', label: 'Semua' };
const CHAIN_OPTIONS = [ALL, ...CHAINS.map((c) => ({ value: c, label: CHAIN_LABELS[c] }))];
const STYLE_OPTIONS = [ALL, ...TRADING_STYLES.filter((s) => s !== 'UNKNOWN').map((s) => ({ value: s, label: styleLabel(s) }))];
const MIN_SCORE_OPTIONS = [ALL, { value: '40', label: '≥ 40' }, { value: '60', label: '≥ 60' }, { value: '75', label: '≥ 75' }, { value: '90', label: '≥ 90' }];

const RANKING_NOTE = 'Peringkat TIDAK didasarkan pada saldo atau win rate saja. Skor menggabungkan profitabilitas per trade dengan shrinkage (satu transaksi beruntung tidak bisa mendominasi), konsistensi mingguan, ukuran sampel, risiko drawdown, diversifikasi, dan lama riwayat — lalu dikalikan faktor kelengkapan PnL. Saldo tidak dibaca sama sekali; win rate hanya informasi.';

function completenessCell(ratio) {
  const text = formatRatioPct(ratio);
  const tone = typeof ratio !== 'number' ? undefined : ratio >= 0.9 ? 'bull' : ratio >= 0.5 ? 'warn' : 'bear';
  const el = badge(text, tone);
  el.title = 'Proporsi jumlah jual yang biaya belinya diketahui (PnL lengkap = 100%).';
  return el;
}

export function walletColumns() {
  return [
    {
      key: 'address', label: 'Wallet', render: (w) => h('span', { class: 'stack sm-cell-stack' },
        h('span', { class: 'cluster' }, walletLink(w.chain, w.address), chainBadge(w.chain)), labelChips(w.labels)),
    },
    {
      key: 'score', label: 'Skor', numeric: true, render: (w) => {
        const v = clampScore(w.score);
        if (v === null) return EMPTY;
        const el = score(v, w.eligible ? 'accent' : 'warn');
        el.title = `Skor wallet ${v}/100 — ringkasan bukti, bukan probabilitas.${w.eligible ? '' : ' Tidak eligible untuk radar.'}`;
        return el;
      },
    },
    { key: 'eligible', label: 'Eligible', render: (w) => (w.eligible ? badge('Ya', 'bull') : badge('Tidak')) },
    { key: 'style', label: 'Gaya', render: (w) => styleLabel(w.style) },
    { key: 'closedTrades', label: 'Posisi tertutup', numeric: true, sortValue: (w) => w.metrics?.closedTrades ?? null, render: (w) => formatInteger(w.metrics?.closedTrades) },
    { key: 'distinctTokens', label: 'Token', numeric: true, sortValue: (w) => w.metrics?.distinctTokens ?? null, render: (w) => formatInteger(w.metrics?.distinctTokens) },
    { key: 'historyDays', label: 'Riwayat (hari)', numeric: true, sortValue: (w) => w.metrics?.historyDays ?? null, render: (w) => formatInteger(w.metrics?.historyDays) },
    { key: 'completeness', label: 'Kelengkapan PnL', sortValue: (w) => w.metrics?.completenessRatio ?? null, render: (w) => completenessCell(w.metrics?.completenessRatio) },
    { key: 'flags', label: 'Flag', sortable: false, render: (w) => flagChips(w.flags) },
    { key: 'clusterSize', label: 'Klaster', numeric: true, render: (w) => clusterText(w.clusterSize) },
    { key: 'topReason', label: 'Alasan utama', sortable: false, render: (w) => h('span', { class: 'sm-reason' }, w.topReason || EMPTY) },
    { key: 'watching', label: 'Ikuti', sortable: false, render: (w) => watchButton({ kind: 'WALLET', chain: w.chain, address: w.address, watching: w.watching, compact: true, name: shortAddress(w.address) }) },
  ];
}

export async function smartWalletsView() {
  const q = hashQuery();
  const form = h('form', { class: 'toolbar sm-toolbar', 'aria-label': 'Filter wallet discovery' },
    selectField({ label: 'Chain', name: 'chain', options: CHAIN_OPTIONS, value: CHAINS.includes(q.get('chain')) ? q.get('chain') : '' }),
    selectField({ label: 'Gaya', name: 'style', options: STYLE_OPTIONS }),
    selectField({ label: 'Skor minimum', name: 'minScore', options: MIN_SCORE_OPTIONS }),
    h('div', { class: 'field sm-toolbar__switch' }, toggle({ name: 'eligible', label: 'Hanya eligible', checked: true })),
    h('div', { class: 'field sm-toolbar__switch' }, toggle({ name: 'includeFlagged', label: 'Tampilkan wallet ber-flag', checked: false })));
  form.addEventListener('submit', (e) => e.preventDefault());
  const count = badge('0 wallet');
  const metaHost = h('div');
  const readFilters = () => ({
    chain: form.elements.chain.value,
    style: form.elements.style.value,
    minScore: form.elements.minScore.value,
    eligible: form.elements.eligible.checked,
    includeFlagged: form.elements.includeFlagged.checked,
  });
  const view = loadable({
    what: 'daftar wallet',
    fetcher: () => api(buildWalletsQuery(readFilters())),
    render: (data) => {
      const items = Array.isArray(data?.items) ? data.items : [];
      metaHost.replaceChildren(metaHeader(data?.meta, Date.now()));
      count.textContent = `${items.length} wallet`;
      if (isNoSourceState(data?.meta, items.length)) return noSourceState();
      return dataTable({
        columns: walletColumns(),
        rows: items,
        caption: 'Wallet smart money',
        initialSort: { key: 'score', dir: 'desc' },
        empty: emptyState({ iconName: 'wallet', title: 'Tidak ada wallet yang cocok', text: 'Longgarkan filter (mis. matikan "Hanya eligible"). Tidak ada data contoh yang ditampilkan.' }),
      });
    },
  });
  form.addEventListener('change', () => { view.load(); });
  await view.load();
  const d = disclaimersOf(null);
  const el = page({
    title: 'Wallet Discovery',
    subtitle: 'Wallet on-chain yang dilacak beserta skor, gaya trading, kelengkapan data, dan penanda risiko (CEX, bot, market maker, …).',
    actions: h('a', { class: 'btn btn--sm btn--ghost', href: '#/smart-money' }, icon('radar', 'btn__icon'), 'Radar'),
  },
  metaHost,
  callout(h('span', null, h('strong', null, 'Cara peringkat: '), RANKING_NOTE)),
  panel({ title: 'Wallet', actions: count, flush: true, footer: `${d.insiderName} ${d.readOnly}` }, form, view.el));
  el.classList.add('page--smart-money');
  return el;
}

// ------------------------------------------------------------------------------------------------ Profil wallet

function scoreCard(s) {
  if (!s) return panel({ title: 'Skor wallet' }, h('p', { class: 'muted' }, 'Skor belum dihitung untuk wallet ini (data belum cukup atau sinkron belum selesai).'));
  const v = clampScore(s.score);
  const m = s.metrics ?? {};
  return panel({ title: 'Skor wallet', actions: s.eligible ? badge('Eligible', 'bull') : badge('Tidak eligible', 'warn') },
    h('div', { class: 'stack' },
      h('div', { class: 'sm-bigscore' },
        h('span', { class: 'sm-bigscore__value num' }, v === null ? EMPTY : String(v)),
        h('span', { class: 'sm-bigscore__unit' }, '/100 · bukan probabilitas'),
        h('span', { class: 'badge' }, `Gaya: ${styleLabel(s.style)}`)),
      componentBars(s.components, SCORE_COMPONENT_LABELS),
      h('dl', { class: 'kv' },
        h('dt', { title: 'Dihitung per round trip (posisi dibuka sampai datar lagi), bukan per potongan lot' }, 'Posisi tertutup'), h('dd', { class: 'num' }, formatInteger(m.closedTrades)),
        h('dt', null, 'Token berbeda'), h('dd', { class: 'num' }, formatInteger(m.distinctTokens)),
        h('dt', null, 'Lama riwayat'), h('dd', { class: 'num' }, m.historyDays === undefined ? EMPTY : `${formatInteger(m.historyDays)} hari`),
        h('dt', null, 'Median return / trade'), h('dd', { class: 'num' }, pct(m.medianReturnPct)),
        h('dt', null, 'Rata-rata return (shrinkage)'), h('dd', { class: 'num' }, pct(m.shrunkMeanReturnPct)),
        h('dt', null, 'Rata-rata tanpa trade terbaik'), h('dd', { class: 'num' }, pct(m.meanReturnExTopPct)),
        h('dt', null, 'Drawdown maks.'), h('dd', { class: 'num', title: 'Penurunan terbesar ekuitas realisasi dari puncaknya' }, formatDrawdownPct(m.maxDrawdownPct)),
        h('dt', null, 'Porsi PnL token teratas'), h('dd', { class: 'num' }, formatRatioPct(m.topTokenPnlShare)),
        h('dt', null, 'Minggu positif'), h('dd', { class: 'num' }, formatRatioPct(m.weeklyPositiveShare)),
        h('dt', null, 'Win rate (info saja)'), h('dd', { class: 'num', title: 'Tidak menjadi komponen skor' }, formatRatioPct(m.winRate))),
      h('h3', { class: 'sm-h' }, 'Alasan'),
      textList(s.reasons, { empty: h('p', { class: 'muted' }, EMPTY) }),
      s.computedAt ? h('p', { class: 'muted' }, `Dihitung ${formatUtc(s.computedAt)}`) : null));
}

// Field *Pct dari metrik = poin persen (konsisten dengan holdingChangePct). maxDrawdownPct = besaran penurunan (≥ 0)
// → formatDrawdownPct (selalu bertanda −, tidak pernah '+').
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')}%` : EMPTY);

function limitationsBox(data) {
  const s = data.score;
  const summary = data.pnl?.summary ?? {};
  const completeness = completenessLabel(summary.completeness);
  const staleNotes = (data.pnl?.positions ?? []).filter((p) => p.stalePrice).map((p) => `Harga ${p.token?.symbol ?? shortAddress(p.tokenKey)} lebih tua dari 24 jam${p.priceAt ? ` (per ${formatUtc(p.priceAt)})` : ''} — unrealized PnL mungkin tidak akurat.`);
  const unsourced = (data.labels ?? []).filter((l) => l?.label && !l.source).map((l) => `Label "${l.label}" tanpa sumber — perlakukan sebagai tidak terverifikasi.`);
  const notes = [...(s?.limitations ?? []), ...(summary.notes ?? []), ...staleNotes, ...unsourced];
  if (data.meta?.isStale !== false) notes.push('Data on-chain belum diperbarui sesuai jadwal (basi).');
  return h('section', { class: 'sm-limits', 'aria-label': 'Keterbatasan data' },
    h('h2', { class: 'sm-limits__title' }, icon('lock', 'sm-limits__icon'), 'Keterbatasan data'),
    h('p', null, 'Kelengkapan PnL: ', badge(completeness.label, completeness.tone), ' ', formatRatioPct(summary.completenessRatio),
      ' ', completenessBasisText(summary.completenessBasis), ' Bagian tanpa biaya tidak dihitung sebagai profit.'),
    textList(notes, { empty: h('p', { class: 'muted' }, 'Tidak ada keterbatasan tambahan tercatat.') }));
}

function flagsPanel(flags) {
  const list = Array.isArray(flags) ? flags : [];
  return panel({ title: 'Penanda (flag)' },
    list.length ? h('ul', { class: 'sm-flaglist' }, list.map((f) => {
      const info = flagInfo(f);
      return h('li', { class: 'sm-flaglist__item' },
        h('div', { class: 'cluster' }, badge(info.label, info.tone), f.severity && h('span', { class: 'muted' }, f.severity), f.source && h('span', { class: 'muted' }, `sumber: ${f.source}`)),
        h('p', null, f.reason || info.title),
        evidenceLines(f.evidence).length ? h('ul', { class: 'sm-evidence-lines mono' }, evidenceLines(f.evidence).map((t) => h('li', null, t))) : null);
    })) : h('p', { class: 'muted' }, 'Tidak ada penanda risiko.'));
}

function clusterPanel(chain, address, cluster) {
  const members = (cluster?.members ?? []).filter((m) => m !== address);
  if (!cluster || !members.length) return panel({ title: 'Wallet terkait' }, h('p', { class: 'muted' }, 'Tidak ditemukan tautan ke wallet lain — dihitung sebagai pembeli independen.'));
  return panel({ title: `Wallet terkait (${members.length})` },
    h('p', { class: 'muted' }, 'Wallet dalam satu klaster dihitung sebagai SATU pembeli independen di radar.'),
    h('ul', { class: 'cluster' }, members.map((m) => h('li', null, walletLink(chain, m)))),
    h('h3', { class: 'sm-h' }, 'Alasan tautan'),
    h('ul', { class: 'sm-list' }, (cluster.reasons ?? []).slice(0, 50).map((r) => h('li', null,
      h('strong', null, clusterReasonLabel(r.type)), ': ', walletLink(chain, r.a), ' ↔ ', walletLink(chain, r.b),
      clusterEvidenceText(r.type, r.evidence) ? h('span', { class: 'muted' }, ` · ${clusterEvidenceText(r.type, r.evidence)}`) : null,
      r.evidence?.txHash ? [' · ', txLink(explorerTxUrl(chain, r.evidence.txHash), r.evidence.txHash)] : null,
      r.evidence?.at ? h('span', { class: 'muted' }, ` · ${formatUtc(r.evidence.at)}`) : null))));
}

function pnlPanel(pnl) {
  const s = pnl?.summary ?? {};
  const c = completenessLabel(s.completeness);
  return panel({ title: 'Ringkasan PnL', actions: badge(`Kelengkapan: ${c.label}`, c.tone) },
    h('div', { class: 'grid grid--kpi' },
      stat({ label: 'PnL realisasi (trading)', value: usdText(s.realizedPnlUsd, { signed: true, tone: true }), hint: 'Dari lot dengan biaya diketahui' }),
      stat({ label: 'PnL belum realisasi', value: usdText(s.unrealizedPnlUsd, { signed: true, tone: true }), hint: s.unrealizedPnlUsd === null ? 'Harga tidak tersedia' : 'Harga terakhir × lot berbiaya diketahui' }),
      stat({ label: 'Realisasi dari airdrop', value: usdText(s.airdropRealizedUsd, { signed: true }), hint: 'Terpisah — bukan keahlian trading' }),
      stat({ label: 'Total biaya', value: usdText(s.totalCostUsd) }),
      stat({
        label: 'Transaksi / posisi tertutup',
        value: `${formatInteger(s.tradesCount)} / ${formatInteger(s.roundTripsCount)}`,
        hint: `Posisi tertutup dihitung per round trip, bukan per potongan lot · ${formatInteger(s.tokensTraded)} token`,
      })));
}

function positionsTable(chain, positions) {
  return dataTable({
    compact: true,
    caption: 'Posisi terbuka',
    initialSort: { key: 'lastActivityAt', dir: 'desc' },
    columns: [
      { key: 'token', label: 'Token', render: (p) => tokenLink(chain, p.token?.address ?? '', p.token?.symbol) },
      { key: 'qtyHeld', label: 'Jumlah', numeric: true, render: (p) => formatQty(p.qtyHeld) },
      { key: 'costBasisUsd', label: 'Biaya', numeric: true, render: (p) => usdText(p.costBasisUsd) },
      { key: 'unknownCostQty', label: 'Qty tanpa biaya', numeric: true, render: (p) => formatQty(p.unknownCostQty) },
      { key: 'priceUsd', label: 'Harga', numeric: true, render: (p) => h('span', null, usdText(p.priceUsd), p.stalePrice ? [' ', badge('basi', 'warn')] : null) },
      { key: 'unrealizedPnlUsd', label: 'Belum realisasi', numeric: true, render: (p) => usdText(p.unrealizedPnlUsd, { signed: true, tone: true }) },
      { key: 'realizedPnlUsd', label: 'Realisasi', numeric: true, render: (p) => usdText(p.realizedPnlUsd, { signed: true, tone: true }) },
      { key: 'completeness', label: 'Kelengkapan', render: (p) => { const c = completenessLabel(p.completeness); const el = badge(c.label, c.tone); el.title = (p.notes ?? []).join(' '); return el; } },
      { key: 'lastActivityAt', label: 'Aktivitas', render: (p) => formatRelative(p.lastActivityAt) },
    ],
    rows: (positions ?? []).filter((p) => p.qtyHeld > 0),
    empty: h('p', { class: 'empty__text' }, 'Tidak ada posisi terbuka yang terlihat.'),
  });
}

/** Tabel riwayat aktivitas (dipakai profil wallet; detail token memakai varian dengan kolom wallet). */
export function activityTable(chain, activities, { withWallet = false, withToken = true, caption = 'Riwayat aktivitas' } = {}) {
  const columns = [
    { key: 'blockTime', label: 'Waktu', render: (a) => h('span', { title: formatUtc(a.blockTime) }, formatRelative(a.blockTime)) },
    { key: 'type', label: 'Jenis', render: (a) => typeBadge(a.type) },
    withWallet && { key: 'wallet', label: 'Wallet', render: (a) => walletLink(chain, a.wallet) },
    withToken && { key: 'token', label: 'Token', render: (a) => tokenLink(chain, a.token?.address ?? '', a.token?.symbol) },
    { key: 'amount', label: 'Jumlah', numeric: true, render: (a) => formatQty(a.amount) },
    { key: 'usdValue', label: 'USD', numeric: true, render: (a) => usdText(a.usdValue) },
    { key: 'counterparty', label: 'Lawan', sortable: false, render: (a) => (a.counterpartyLabel?.label ? h('span', { title: labelText(a.counterpartyLabel) }, a.counterpartyLabel.label) : h('span', { class: 'mono' }, shortAddress(a.counterparty))) },
    { key: 'confidence', label: 'Keyakinan klasifikasi', render: (a) => badge(a.confidence ?? EMPTY, a.confidence === 'HIGH' ? 'bull' : a.confidence === 'LOW' ? 'warn' : undefined) },
    { key: 'reason', label: 'Alasan', sortable: false, render: (a) => h('span', { class: 'sm-reason' }, a.reason || EMPTY) },
    { key: 'tx', label: 'Tx', sortable: false, render: (a) => h('span', null, txLink(a.explorerUrl ?? explorerTxUrl(chain, a.txHash), a.txHash), simBadge(a.isSimulated)) },
  ].filter(Boolean);
  return dataTable({
    compact: true,
    caption,
    columns,
    rows: Array.isArray(activities) ? activities : [],
    initialSort: { key: 'blockTime', dir: 'desc' },
    empty: h('p', { class: 'empty__text' }, 'Belum ada aktivitas tercatat.'),
  });
}

function profileHeader(data) {
  const w = data.wallet ?? {};
  const explorer = w.explorerUrl ?? explorerAddressUrl(w.chain, w.address);
  return h('section', { class: 'sm-identity', 'aria-label': 'Identitas wallet' },
    h('div', { class: 'sm-identity__main' },
      h('div', { class: 'cluster' }, chainBadge(w.chain), simBadge(w.isSimulated), labelChips(data.labels)),
      h('p', { class: 'sm-identity__addr mono', 'data-testid': 'sm-wallet-address' }, w.address),
      h('div', { class: 'cluster' }, copyButton(w.address, 'alamat'), externalLink(explorer, 'Buka di explorer', { label: `Buka wallet ${w.address} di explorer (tab baru)` }))),
    h('dl', { class: 'kv sm-identity__facts' },
      h('dt', null, 'Pertama terlihat'), h('dd', null, formatUtc(w.firstSeenAt)),
      h('dt', null, 'Aktivitas terakhir'), h('dd', null, formatRelative(w.lastActivityAt)),
      h('dt', null, 'Ditemukan via'), h('dd', null, [w.discoveredVia, w.discoveryReason].filter(Boolean).join(' — ') || EMPTY)),
    h('div', { class: 'sm-identity__actions' }, watchButton({ kind: 'WALLET', chain: w.chain, address: w.address, watching: data.watching, name: shortAddress(w.address) })));
}

function invalidParams(what) {
  return emptyState({
    iconName: 'wallet', title: `Parameter ${what} tidak valid`, text: 'Tautan harus berisi chain yang dikenal (c=) dan alamat yang valid untuk chain tersebut (a=).',
    action: h('a', { class: 'btn btn--sm', href: '#/smart-wallets' }, 'Kembali ke Wallet Discovery'),
  });
}

export async function smartWalletView() {
  const { chain, address, invalid } = parseEntityQuery(hashQuery());
  const metaHost = h('div');
  const pageEl = (content) => {
    const el = page({ title: 'Profil Wallet', subtitle: 'Skor, bukti, keterbatasan data, dan riwayat aktivitas satu wallet publik. Baca saja.' }, metaHost, content);
    el.classList.add('page--smart-money');
    return el;
  };
  if (invalid) return pageEl(invalidParams('wallet'));
  const view = loadable({
    what: 'profil wallet',
    fetcher: async () => {
      try {
        return await api(entityPath('wallets', chain, address));
      } catch (err) {
        if (err?.status === 404) return { notFound: true };
        throw err;
      }
    },
    render: (data) => {
      if (data.notFound) {
        return emptyState({
          iconName: 'wallet', title: 'Wallet tidak dilacak',
          text: `${shortAddress(address)} di ${CHAIN_LABELS[chain]} belum ada di daftar wallet yang dilacak. Tidak ada data yang ditampilkan.`,
          action: externalLink(explorerAddressUrl(chain, address), 'Lihat di explorer'),
        });
      }
      const d = disclaimersOf(data.meta);
      metaHost.replaceChildren(metaHeader(data.meta, Date.now()));
      return [
        profileHeader(data),
        h('div', { class: 'grid grid--main-side' }, scoreCard(data.score), limitationsBox(data)),
        pnlPanel(data.pnl),
        h('div', { class: 'grid grid--2' }, flagsPanel(data.flags), clusterPanel(chain, address, data.cluster)),
        panel({ title: 'Posisi terbuka', flush: true }, positionsTable(chain, data.pnl?.positions)),
        panel({ title: 'Riwayat aktivitas', flush: true, footer: 'Hanya Swap beli/jual yang dihitung sebagai pembelian/penjualan. Deposit ke exchange = indikasi keluar, belum tentu dijual.' },
          activityTable(chain, data.activities)),
        disclaimerBox([d.insiderName, d.readOnly]),
      ];
    },
  });
  await view.load();
  return pageEl(view.el);
}
