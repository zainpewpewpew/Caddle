// Peta Benang (Smart Money Radar, #/smart-money?view=benang): wallet di kiri, token di kanan, satu benang (kurva
// Bézier kubik) per (wallet, token) — siapa membeli apa, dari aktivitas on-chain publik yang sama dengan daftar kartu.
// Tata letak murni ada di smartThreadsLayout.js. SVG dibangun dengan createElementNS dan teks lewat text node: data
// provider (label wallet pihak ketiga, simbol token) TIDAK PERNAH masuk innerHTML.
//
// Interaksi: arahkan/fokus wallet atau token → benang & node terkait disorot, sisanya diredupkan; Enter/klik membuka
// profil wallet / detail token (<a> SVG asli). Klik, ketuk, atau fokus benang → panel bukti (aria-live) di bawah peta.
// Keyboard: tiap kolom (wallet, benang, token) satu tab stop; panah atas/bawah berpindah di kolom, kiri/kanan
// menyusuri benang; Esc menghapus pilihan. Animasi aliran di benang beli mati di bawah prefers-reduced-motion atau
// bila "Animasi latar" dimatikan (CSS). Lebar mengikuti wadah (ResizeObserver) dengan label lebih pendek di layar
// sempit, sehingga tidak ada gulir horizontal di 390 px.
import { emptyState } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatRelative, formatUtc } from '../lib/format.js';
import {
  addressLink, chainBadge, disclaimerBox, labelChips, simBadge, tokenLink, txLink, typeBadge, usdText,
} from './smartMoneyCommon.js';
import {
  CHAIN_LABELS, EMPTY, USD_UNKNOWN, disclaimersOf, explorerTxUrl, formatUsdOrDash, labelText, matchBadge, shortAddress,
  smartTokenHref, smartWalletHref, stateLabel,
} from './smartMoneyFormat.js';
import { buildThreadsLayout, threadsCountText, threadsSummaryLines, tokenDisplayName } from './smartThreadsLayout.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BLOCKED_ATTRS = /^on/i;
const MIN_WIDTH = 300;
const COMPACT_BELOW = 600;
const DEFAULT_WIDTH = 880;
const REBUILD_DELTA = 24;
const MAX_EVIDENCE_TXS = 5;

export const THREADS_NOTE = 'Peta ini hanya menggambarkan aktivitas on-chain publik wallet yang dilacak dalam jendela radar: '
  + 'benang beli = swap beli; indikasi keluar = jual via swap atau dipindah ke exchange (deposit ke exchange belum tentu '
  + 'dijual). Tidak ada informasi orang dalam. Tebal benang mengikuti nilai USD (skala log); garis putus-putus = nilai '
  + 'USD tidak diketahui, tidak dianggap $0.';

let uidSeq = 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const px = (n) => String(Math.round(n * 10) / 10);

/** Elemen SVG aman: atribut lewat setAttribute (on* ditolak), teks lewat text node — cermin h() di lib/dom.js. */
function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (BLOCKED_ATTRS.test(key)) throw new Error(`Atribut event inline dilarang: ${key}`);
    el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Potong teks ke `max` karakter (per code point, aman untuk emoji) dengan elipsis. */
function clip(value, max) {
  const chars = Array.from(String(value ?? ''));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

const chainName = (chain) => CHAIN_LABELS[chain] ?? String(chain ?? '?');
const convText = (v) => (v === null ? EMPTY : `${v}/100`);

/**
 * Geometri SVG (px) untuk lebar wadah. Di bawah COMPACT_BELOW: label wallet pihak ketiga hanya di tooltip/bukti,
 * alamat & teks token dipendekkan. viewBox = lebar wadah → teks tidak mengecil, tanpa gulir horizontal.
 * @param {{ height: number }} layout
 * @param {number} [width]
 */
export function threadsGeometry(layout, width) {
  const W = Math.max(MIN_WIDTH, Math.round(isNum(width) && width > 0 ? width : DEFAULT_WIDTH));
  const compact = W < COMPACT_BELOW;
  const rowH = compact ? 30 : 28;
  const padY = 18;
  return {
    W,
    H: Math.round(layout.height * rowH + padY * 2),
    compact,
    rowH,
    r: compact ? 5 : 5.5,
    // Ringkas (ponsel): kolom teks diberi ruang cukup agar tag klaster & teks token tidak terpotong tepi viewBox.
    xW: compact ? 112 : Math.min(300, Math.max(236, Math.round(W * 0.3))),
    xT: compact ? W - 120 : W - Math.min(280, Math.max(222, Math.round(W * 0.27))),
    y: (u) => padY + u * rowH,
  };
}

/** Kurva Bézier kubik horizontal (gaya sankey); titik tengahnya tepat di tengah kedua ujung. */
function strandPath(x1, y1, x2, y2) {
  const dx = (x2 - x1) / 2;
  return `M${px(x1)} ${px(y1)} C${px(x1 + dx)} ${px(y1)} ${px(x2 - dx)} ${px(y2)} ${px(x2)} ${px(y2)}`;
}

// ---------------------------------------------------------------- teks

/** Nada benang untuk warna CSS: beli / beli & jual / keluar via swap / dipindah ke exchange. */
function toneOf(st) {
  if (st.kind === 'BUY') return st.mixed ? 'mixed' : 'buy';
  return st.exitVia === 'CEX' ? 'cex' : 'sell';
}

/** Jenis benang dalam kata — deposit ke exchange tidak pernah disebut penjualan. */
export function strandKindText(st) {
  if (st.kind === 'BUY') return st.mixed ? 'Beli & jual via swap' : 'Beli via swap';
  if (st.exitVia === 'CEX') return 'Indikasi keluar: dipindah ke exchange, belum tentu dijual';
  if (st.exitVia === 'MIXED') return 'Indikasi keluar: sebagian dijual via swap, sebagian dipindah ke exchange (belum tentu dijual)';
  if (st.exitVia === 'SWAP') return 'Indikasi keluar: dijual via swap';
  return 'Indikasi keluar';
}

function strandUsdText(st) {
  if (!st.usdKnown) return USD_UNKNOWN;
  return st.kind === 'BUY' ? `net ${formatUsdOrDash(st.usd, { signed: true })}` : `nilai keluar ${formatUsdOrDash(st.usd)}`;
}

function walletAria(w, strandCount) {
  const parts = [`Wallet ${shortAddress(w.address)} di ${chainName(w.chain)}`];
  parts.push(w.score === null ? 'skor wallet tidak tersedia (hanya indikasi keluar)' : `skor wallet ${Math.round(w.score)}`);
  if (w.label?.label) parts.push(`label ${labelText(w.label)}`);
  if (w.group) parts.push(`anggota klaster ${w.group}: ${w.groupSize} wallet terkait dihitung 1 pembeli independen`);
  else if (w.linkedHidden > 0) parts.push(`tertaut dengan ${w.linkedHidden} wallet lain yang tidak ditampilkan`);
  parts.push(`${strandCount} benang`);
  return `${parts.join(', ')}. Enter membuka profil wallet.`;
}

function walletTitle(w) {
  const lines = [`${w.address} (${chainName(w.chain)})`, w.score === null ? 'Skor wallet: —' : `Skor wallet: ${Math.round(w.score)}/100 (bukan probabilitas)`];
  if (w.label?.label) lines.push(`Label: ${labelText(w.label)}`);
  if (w.group) lines.push(`Klaster ${w.group}: ${w.groupSize} wallet terkait — dihitung 1 pembeli independen`);
  else if (w.linkedHidden > 0) lines.push(`Tertaut dengan ${w.linkedHidden} wallet lain (tidak ditampilkan)`);
  return lines.join('\n');
}

function binanceShort(binance, compact) {
  const m = matchBadge(binance);
  if (m.status === 'MATCHED') return compact ? 'Binance ✓' : `✓ ${m.label}`;
  if (m.status === 'SYMBOL_ONLY') return '⚠ simbol sama';
  if (m.status === 'AMBIGUOUS') return '⚠ ambigu';
  if (m.status === 'NOT_LISTED') return compact ? '' : 'tidak di Binance';
  return compact ? '' : 'Binance ?';
}

function tokenFacts(t) {
  const st = stateLabel(t.state);
  const buyers = isNum(t.independentBuyers) ? `${t.independentBuyers} dari ${t.buyerCount ?? EMPTY}` : EMPTY;
  return { st, buyers, match: matchBadge(t.binance) };
}

function tokenAria(t) {
  const { st, buyers, match } = tokenFacts(t);
  const conv = t.conviction === null ? 'skor keyakinan tidak diketahui' : `skor keyakinan ${t.conviction} dari 100, bukan probabilitas`;
  const hidden = t.hiddenWallets ? `, ${t.hiddenWallets} wallet tidak ditampilkan` : '';
  return `Token ${t.symbol ?? '?'} di ${chainName(t.chain)}, kontrak ${shortAddress(t.address)}, status ${st.label}, ${conv}, `
    + `pembeli independen ${buyers}, Binance: ${match.label}${t.isSimulated ? ', data simulasi' : ''}, ${t.walletCount} benang${hidden}. `
    + 'Enter membuka detail token.';
}

function tokenTitle(t) {
  const { st, buyers, match } = tokenFacts(t);
  return [
    `${t.symbol ?? '?'}${t.name ? ` — ${t.name}` : ''} (${chainName(t.chain)})`,
    `Kontrak ${t.address}`,
    `Status: ${st.label} — ${st.text}`,
    `Skor keyakinan ${convText(t.conviction)} — ringkasan bukti, BUKAN probabilitas profit.`,
    `Pembeli independen: ${buyers} (wallet satu klaster dihitung satu)`,
    `Binance: ${match.text}`,
    t.hiddenWallets ? `${t.hiddenWallets} wallet terkait tidak ditampilkan (batas peta)` : null,
    t.isSimulated ? 'DATA SIMULASI — bukan data live.' : null,
  ].filter(Boolean).join('\n');
}

function strandAria(st, w, t) {
  return `Benang ${strandKindText(st).toLowerCase()}: wallet ${shortAddress(w.address)} ke ${t.symbol ?? '?'} (${chainName(t.chain)}); `
    + `${st.buys} beli, ${st.sells} jual; ${strandUsdText(st)}${st.isSimulated ? '; data simulasi' : ''}. Pilih untuk melihat bukti.`;
}

// ---------------------------------------------------------------- node SVG

function walletNode(w, g, strandCount) {
  const cy = g.y(w.y);
  const addr = g.compact ? shortAddress(w.address, 4, 4) : shortAddress(w.address);
  const addrRight = g.xW - (g.compact ? 30 : 34);
  const addrWidth = Array.from(addr).length * (g.compact ? 6 : 6.6);
  const tagW = g.compact ? 18 : 22;
  // Tag klaster tidak pernah keluar dari tepi kiri viewBox.
  const tagX = Math.max(1, addrRight - addrWidth - (g.compact ? 5 : 6) - tagW);
  const parts = [];
  if (w.group) {
    parts.push(svg('g', { class: 'sm-thr-tag', 'aria-hidden': 'true' },
      svg('rect', { x: px(tagX), y: px(cy - 8), width: tagW, height: 16, rx: 4 }),
      svg('text', { x: px(tagX + tagW / 2), y: px(cy), dy: '0.35em', 'text-anchor': 'middle' }, w.group)));
  }
  if (!g.compact && w.label?.label) {
    const chipText = clip(w.label.label, 14);
    const chipW = Array.from(chipText).length * 5.8 + 12;
    const chipRight = (w.group ? tagX : addrRight - addrWidth) - 6;
    parts.push(svg('g', { class: 'sm-thr-chip', 'data-sourced': w.label.source ? 'true' : 'false', 'aria-hidden': 'true' },
      svg('rect', { x: px(chipRight - chipW), y: px(cy - 8), width: px(chipW), height: 16, rx: 4 }),
      svg('text', { x: px(chipRight - chipW / 2), y: px(cy), dy: '0.35em', 'text-anchor': 'middle' }, chipText)));
  }
  return svg('a', {
    class: 'sm-thr-node sm-thr-wallet', href: smartWalletHref(w.chain, w.address), tabindex: '-1',
    'data-thr': 'wallet', 'data-id': w.id, 'data-scored': w.score === null ? 'false' : 'true', 'aria-label': walletAria(w, strandCount),
  },
  svg('title', null, walletTitle(w)),
  svg('rect', { class: 'sm-thr-node__hit', x: 1, y: px(cy - g.rowH / 2 + 1), width: px(g.xW + g.r + 5), height: px(g.rowH - 2), rx: 5 }),
  parts,
  svg('text', { class: 'sm-thr-wallet__addr', x: px(addrRight), y: px(cy), dy: '0.35em', 'text-anchor': 'end' }, addr),
  svg('text', { class: 'sm-thr-wallet__score', x: px(g.xW - (g.compact ? 10 : 12)), y: px(cy), dy: '0.35em', 'text-anchor': 'end' },
    w.score === null ? EMPTY : String(Math.round(w.score))),
  svg('circle', { class: 'sm-thr-node__halo', cx: px(g.xW), cy: px(cy), r: px(g.r + 4) }),
  svg('circle', { class: 'sm-thr-node__dot', cx: px(g.xW), cy: px(cy), r: px(g.r) }));
}

function tokenNode(t, g) {
  const cy = g.y(t.y);
  const x = g.xT + 12;
  const name = clip(tokenDisplayName(t, { compact: true }), g.compact ? 9 : 14);
  const st = stateLabel(t.state);
  const binance = binanceShort(t.binance, g.compact);
  const matchStatus = matchBadge(t.binance).status;
  const sim = t.isSimulated ? svg('tspan', { class: 'sm-thr-token__sim', dx: g.compact ? 4 : 6 }, 'SIMULASI') : null;
  // Ringkas: simbol / status + keyakinan / chain + SIMULASI / status Binance — tiap baris muat ±105px.
  const top = cy - (binance ? 15 : 9);
  const lines = g.compact
    ? [
      svg('text', { class: 'sm-thr-token__l1', x, y: px(top) }, svg('tspan', { class: 'sm-thr-token__sym' }, name)),
      svg('text', { class: 'sm-thr-token__l2', x, y: px(top + 13) },
        svg('tspan', { class: 'sm-thr-token__state' }, st.label), ' ', svg('tspan', { class: 'sm-thr-token__conv' }, t.conviction === null ? EMPTY : String(t.conviction))),
      svg('text', { class: 'sm-thr-token__l3', x, y: px(top + 25) }, svg('tspan', null, clip(chainName(t.chain), 9)), sim),
      binance
        ? svg('text', { class: 'sm-thr-token__l3', x, y: px(top + 37) },
          svg('tspan', { class: 'sm-thr-token__match', 'data-status': matchStatus }, binance))
        : null,
    ]
    : [
      svg('text', { class: 'sm-thr-token__l1', x, y: px(cy - 4) },
        svg('tspan', { class: 'sm-thr-token__sym' }, name), svg('tspan', { class: 'sm-thr-token__chain', dx: 6 }, chainName(t.chain)), sim),
      svg('text', { class: 'sm-thr-token__l2', x, y: px(cy + 12) },
        svg('tspan', { class: 'sm-thr-token__state' }, st.label), ' · ',
        svg('tspan', { class: 'sm-thr-token__conv' }, convText(t.conviction)),
        binance ? [' · ', svg('tspan', { class: 'sm-thr-token__match', 'data-status': matchStatus }, clip(binance, 18))] : null),
    ];
  return svg('a', {
    class: 'sm-thr-node sm-thr-token', href: smartTokenHref(t.chain, t.address), tabindex: '-1',
    'data-thr': 'token', 'data-id': t.id, 'data-state': t.state ?? '', 'aria-label': tokenAria(t),
  },
  svg('title', null, tokenTitle(t)),
  svg('rect', { class: 'sm-thr-node__hit', x: px(g.xT - g.r - 6), y: px(cy - g.rowH + 3), width: px(g.W - (g.xT - g.r - 6) - 1), height: px(g.rowH * 2 - 6), rx: 6 }),
  svg('circle', { class: 'sm-thr-node__halo', cx: px(g.xT), cy: px(cy), r: px(g.r + 5) }),
  svg('circle', { class: 'sm-thr-node__dot', cx: px(g.xT), cy: px(cy), r: px(g.r + 1) }),
  lines);
}

function strandNode(st, w, t, g, ids) {
  const x1 = g.xW + g.r + 3;
  const x2 = g.xT - g.r - 4;
  const y1 = g.y(w.y);
  const y2 = g.y(t.y);
  const d = strandPath(x1, y1, x2, y2);
  const tone = toneOf(st);
  const width = g.compact ? Math.max(1, st.width * 0.8) : st.width;
  const flows = st.kind === 'BUY' && !st.mixed && !st.hasExit && st.usdKnown;
  return svg('g', {
    class: 'sm-thr-strand', role: 'button', tabindex: '-1', 'data-thr': 'strand', 'data-id': st.id, 'data-kind': st.kind,
    'data-tone': tone, 'data-usd': st.usdKnown ? 'known' : 'unknown', 'data-sim': st.isSimulated ? 'true' : undefined,
    'aria-label': strandAria(st, w, t),
  },
  svg('title', null, `${strandKindText(st)} · ${shortAddress(w.address)} → ${t.symbol ?? '?'} · ${strandUsdText(st)}${st.isSimulated ? ' · SIMULASI' : ''}`),
  svg('path', { class: 'sm-thr-strand__hit', d }),
  svg('path', {
    class: 'sm-thr-strand__line', d, 'stroke-width': px(width),
    'marker-start': st.kind === 'EXIT' ? `url(#${tone === 'cex' ? ids.cex : ids.sell})` : undefined,
  }),
  flows ? svg('path', { class: 'sm-thr-strand__flow', d, 'stroke-width': px(Math.max(1.2, width * 0.6)) }) : null,
  st.mixed || (st.kind === 'BUY' && st.hasExit)
    ? svg('circle', { class: 'sm-thr-strand__mix', cx: px((x1 + x2) / 2), cy: px((y1 + y2) / 2), r: 3.2 })
    : null);
}

/** Lapisan latar (aria-hidden): tanda air simulasi, pita & tulang klaster. */
function backdrop(layout, g) {
  const items = [];
  if (layout.isSimulated) {
    items.push(svg('text', {
      class: 'sm-thr__watermark', x: px(g.W / 2), y: px(g.H / 2), 'text-anchor': 'middle', dy: '0.35em',
      transform: `rotate(-14 ${px(g.W / 2)} ${px(g.H / 2)})`,
    }, 'DATA SIMULASI'));
  }
  for (const c of layout.clusters) {
    const top = g.y(c.y0) - g.rowH / 2 + 2;
    const bottom = g.y(c.y1) + g.rowH / 2 - 2;
    items.push(svg('rect', { class: 'sm-thr-band', x: 0, y: px(top), width: px(g.xW + g.r + 8), height: px(bottom - top), rx: 7 }));
  }
  return svg('g', { class: 'sm-thr__backdrop', 'aria-hidden': 'true' }, items);
}

function markerDefs(ids) {
  const arrow = (id, tone) => svg('marker', {
    id, class: `sm-thr-mk sm-thr-mk--${tone}`, viewBox: '0 0 10 10', refX: 2, refY: 5,
    markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse',
  }, svg('path', { d: 'M0 0 L10 5 L0 10 z' }));
  return svg('defs', null, arrow(ids.sell, 'sell'), arrow(ids.cex, 'cex'));
}

// ---------------------------------------------------------------- HTML pendamping

function legendSwatch(tone, { dashed = false, mix = false, exit = false } = {}) {
  return svg('svg', { class: 'sm-thr-swatch', viewBox: '0 0 28 10', width: 28, height: 10, 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { class: 'sm-thr-swatch__line', 'data-tone': tone, 'data-dashed': dashed ? 'true' : undefined, d: 'M3 5 L25 5' }),
    exit ? svg('path', { class: 'sm-thr-swatch__arrow', 'data-tone': tone, d: 'M1 5 L6 2 L6 8 z' }) : null,
    mix ? svg('circle', { class: 'sm-thr-swatch__mix', cx: 14, cy: 5, r: 3 }) : null);
}

function legend() {
  const item = (swatch, label) => h('li', { class: 'sm-thr-legend__item' }, swatch, h('span', null, label));
  return h('ul', { class: 'sm-thr-legend', 'aria-label': 'Keterangan Peta Benang' },
    item(legendSwatch('buy'), 'Beli (swap)'),
    item(legendSwatch('mixed', { mix: true }), 'Beli & jual'),
    item(legendSwatch('sell', { exit: true }), 'Keluar: jual via swap'),
    item(legendSwatch('cex', { exit: true }), 'Keluar: dipindah ke exchange (belum tentu dijual)'),
    item(legendSwatch('unknown', { dashed: true }), USD_UNKNOWN),
    item(h('span', { class: 'sm-thr-legend__tag', 'aria-hidden': 'true' }, 'K1'), 'Klaster wallet terkait = 1 pembeli independen'));
}

const fact = (label, value) => h('div', null, h('dt', null, label), h('dd', null, value));
const timeText = (ms, now) => (isNum(ms) ? h('span', { title: formatUtc(ms) }, `${formatUtc(ms)} · ${formatRelative(ms, now)}`) : EMPTY);

/** Isi panel bukti untuk satu benang. */
function evidenceContent(st, w, t, now) {
  const usd = st.usdKnown
    ? usdText(st.usd, { signed: st.kind === 'BUY', tone: st.kind === 'BUY' })
    : h('span', { class: 'sm-usd sm-usd--unknown', title: 'Tidak dihitung sebagai $0' }, USD_UNKNOWN);
  const events = (st.kind === 'BUY' ? st.txs : st.exits.filter((e) => e.type !== 'FULL_EXIT'))
    .slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const notes = [...new Set(st.exits.map((e) => e.note).filter(Boolean))];
  return [
    h('div', { class: 'cluster sm-thr-ev__head' },
      h('span', { class: 'sm-thr-ev__kind', 'data-tone': toneOf(st) }, strandKindText(st)),
      simBadge(st.isSimulated)),
    h('dl', { class: 'sm-facts sm-thr-ev__facts' },
      fact('Wallet', h('span', { class: 'cluster' },
        addressLink(w.address, smartWalletHref(w.chain, w.address), { label: `Profil wallet ${w.address}` }), labelChips(w.label))),
      fact('Token', h('span', { class: 'cluster' }, tokenLink(t.chain, t.address, t.symbol), chainBadge(t.chain))),
      fact('Beli / jual (swap)', h('span', { class: 'num' }, `${st.buys} / ${st.sells}`)),
      st.deposits > 0 ? fact('Deposit ke exchange', `${st.deposits}× — belum tentu dijual`) : null,
      fact(st.kind === 'BUY' ? 'Net beli' : 'Nilai keluar', usd),
      st.kind === 'BUY' ? fact('Beli pertama', timeText(st.firstBuyAt, now)) : null,
      st.kind === 'BUY' ? fact('Beli terakhir', timeText(st.lastBuyAt, now)) : null,
      w.group ? fact('Klaster', `${w.group}: ${w.groupSize} wallet terkait — dihitung 1 pembeli independen`) : null),
    notes.length ? h('ul', { class: 'sm-list sm-list--risk' }, notes.map((n) => h('li', null, `Indikasi keluar: ${n}`))) : null,
    h('h5', { class: 'sm-h' }, `Transaksi${events.length > MAX_EVIDENCE_TXS ? ` (${MAX_EVIDENCE_TXS} terbaru dari ${events.length})` : ''}`),
    events.length
      ? h('ul', { class: 'sm-txs' }, events.slice(0, MAX_EVIDENCE_TXS).map((e) => h('li', null,
        typeBadge(e.type), ' ', usdText(e.usd), ' ',
        h('span', { class: 'muted', title: formatUtc(e.at) }, formatRelative(e.at, now)), ' ',
        txLink(e.explorerUrl ?? explorerTxUrl(st.chain, e.txHash), e.txHash), simBadge(e.isSimulated))))
      : h('p', { class: 'muted' }, 'Tidak ada transaksi tercatat untuk pasangan ini.'),
    h('div', { class: 'cluster' },
      h('a', { class: 'btn btn--sm btn--ghost', href: smartWalletHref(w.chain, w.address) }, 'Profil wallet'),
      h('a', { class: 'btn btn--sm btn--ghost', href: smartTokenHref(t.chain, t.address) }, 'Detail token')),
  ];
}

const EVIDENCE_HINT = 'Pilih benang — klik, ketuk, atau fokus dengan keyboard — untuk melihat bukti transaksinya.';

/** Perkiraan lebar wadah sebelum dipasang ke DOM (dikoreksi ResizeObserver setelah tampil). */
function estimateWidth() {
  const vw = typeof window !== 'undefined' && isNum(window.innerWidth) ? window.innerWidth : null;
  if (vw === null) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, vw - (vw <= 820 ? 70 : 310));
}

// ---------------------------------------------------------------- tampilan

/**
 * Peta Benang dari item radar (respons yang sama dengan daftar kartu — tidak ada request tambahan).
 * @param {object[]} items
 * @param {object|null} meta blok meta respons (penafian)
 * @param {{ now?: number, width?: number, maxTokens?: number, maxWallets?: number }} [options]
 * @returns {HTMLElement}
 */
export function threadsView(items, meta, { now = Date.now(), width, maxTokens, maxWallets } = {}) {
  const layout = buildThreadsLayout(items, { maxTokens, maxWallets });
  const d = disclaimersOf(meta);
  if (!layout.tokens.length) {
    return emptyState({
      iconName: 'radar',
      title: 'Belum ada benang untuk ditampilkan',
      text: 'Tidak ada token dengan pembeli atau indikasi keluar pada jendela ini. Tidak ada data contoh yang ditampilkan.',
    });
  }

  const uid = `sm-thr-${(uidSeq += 1)}`;
  const ids = { title: `${uid}-title`, desc: `${uid}-desc`, sell: `${uid}-mk-sell`, cex: `${uid}-mk-cex`, evidence: `${uid}-evidence` };
  const walletById = new Map(layout.wallets.map((w) => [w.id, w]));
  const tokenById = new Map(layout.tokens.map((t) => [t.id, t]));
  const strandById = new Map(layout.strands.map((st) => [st.id, st]));
  const strandsOfWallet = new Map(layout.wallets.map((w) => [w.id, []]));
  const strandsOfToken = new Map(layout.tokens.map((t) => [t.id, []]));
  for (const st of layout.strands) {
    strandsOfWallet.get(st.walletId).push(st.id);
    strandsOfToken.get(st.tokenId).push(st.id);
  }
  // Benang per token mengikuti urutan wallet (dari atas) agar panah kiri dari token mendarat di benang teratas.
  const walletIndex = new Map(layout.wallets.map((w) => [w.id, w.index]));
  for (const list of strandsOfToken.values()) list.sort((a, b) => walletIndex.get(strandById.get(a).walletId) - walletIndex.get(strandById.get(b).walletId));

  const evidence = h('section', {
    class: 'sm-thr-evidence', 'aria-live': 'polite', 'aria-labelledby': ids.evidence, 'data-testid': 'sm-threads-evidence',
  });
  const evidenceTitle = h('h4', { class: 'sm-h', id: ids.evidence }, 'Bukti benang');
  const showHint = () => evidence.replaceChildren(evidenceTitle, h('p', { class: 'muted sm-thr-evidence__hint' }, EVIDENCE_HINT));
  showHint();

  const frame = h('div', { class: 'sm-thr__frame' });
  let svgRoot = null;
  let els = null;
  let selected = null;
  let hoverEl = null;
  let focusEl = null;
  let lit = [];
  const roving = { wallet: null, strand: null, token: null };

  const related = (el) => {
    const kind = el.dataset.thr;
    const id = el.dataset.id;
    if (kind === 'strand') {
      const st = strandById.get(id);
      return [el, els.wallet.get(st.walletId), els.token.get(st.tokenId)];
    }
    const own = (kind === 'wallet' ? strandsOfWallet : strandsOfToken).get(id) ?? [];
    const out = [el];
    for (const sid of own) {
      const st = strandById.get(sid);
      out.push(els.strand.get(sid), kind === 'wallet' ? els.token.get(st.tokenId) : els.wallet.get(st.walletId));
    }
    return out;
  };

  function paint() {
    for (const e of lit) e.classList.remove('is-on');
    lit = [];
    const target = hoverEl ?? focusEl ?? (selected ? els.strand.get(selected) : null);
    if (!target) {
      svgRoot.removeAttribute('data-focus');
      return;
    }
    svgRoot.setAttribute('data-focus', target.dataset.thr);
    for (const e of related(target)) {
      if (!e || e.classList.contains('is-on')) continue;
      e.classList.add('is-on');
      lit.push(e);
    }
  }

  function select(id) {
    if (!strandById.has(id)) return;
    if (selected !== id) {
      if (selected) els.strand.get(selected)?.classList.remove('is-selected');
      selected = id;
      const st = strandById.get(id);
      evidence.replaceChildren(evidenceTitle, ...evidenceContent(st, walletById.get(st.walletId), tokenById.get(st.tokenId), now).filter(Boolean));
    }
    els.strand.get(id)?.classList.add('is-selected');
    paint();
  }

  function clearSelection() {
    if (selected) els.strand.get(selected)?.classList.remove('is-selected');
    selected = null;
    hoverEl = null;
    showHint();
    paint();
  }

  function setRoving(el) {
    const kind = el.dataset.thr;
    const prev = roving[kind];
    if (prev && prev !== el) prev.setAttribute('tabindex', '-1');
    el.setAttribute('tabindex', '0');
    roving[kind] = el;
  }

  function move(el) {
    if (!el) return;
    setRoving(el);
    el.focus();
  }

  /** Tetangga dalam kolom/urutan yang sama. */
  function step(kind, id, delta) {
    const order = kind === 'wallet' ? layout.wallets : kind === 'token' ? layout.tokens : layout.strands;
    const i = order.findIndex((x) => x.id === id);
    const next = order[Math.min(order.length - 1, Math.max(0, i + delta))];
    return next ? els[kind].get(next.id) : null;
  }

  function onKey(e) {
    const el = e.target?.closest?.('[data-thr]');
    if (!el) return;
    const kind = el.dataset.thr;
    const id = el.dataset.id;
    const order = kind === 'wallet' ? layout.wallets : kind === 'token' ? layout.tokens : layout.strands;
    let next = null;
    switch (e.key) {
      case 'ArrowDown': next = step(kind, id, 1); break;
      case 'ArrowUp': next = step(kind, id, -1); break;
      case 'Home': next = els[kind].get(order[0].id); break;
      case 'End': next = els[kind].get(order[order.length - 1].id); break;
      case 'ArrowRight':
        if (kind === 'wallet') next = els.strand.get(strandsOfWallet.get(id)?.[0]);
        else if (kind === 'strand') next = els.token.get(strandById.get(id).tokenId);
        break;
      case 'ArrowLeft':
        if (kind === 'token') next = els.strand.get(strandsOfToken.get(id)?.[0]);
        else if (kind === 'strand') next = els.wallet.get(strandById.get(id).walletId);
        break;
      case 'Enter':
      case ' ':
        if (kind !== 'strand') return; // <a>: Enter mengikuti tautan secara bawaan
        e.preventDefault();
        select(id);
        return;
      case 'Escape':
        clearSelection();
        return;
      default:
        return;
    }
    if (next) {
      e.preventDefault();
      move(next);
    }
  }

  function build(w) {
    const g = threadsGeometry(layout, w);
    const map = { wallet: new Map(), token: new Map(), strand: new Map() };
    const walletLayer = svg('g', { class: 'sm-thr__wallets', role: 'list', 'aria-label': 'Wallet' });
    for (const wl of layout.wallets) {
      const node = walletNode(wl, g, strandsOfWallet.get(wl.id).length);
      map.wallet.set(wl.id, node);
      walletLayer.append(svg('g', { role: 'listitem' }, node));
    }
    const strandLayer = svg('g', { class: 'sm-thr__strands', role: 'list', 'aria-label': 'Benang' });
    for (const st of layout.strands) {
      const node = strandNode(st, walletById.get(st.walletId), tokenById.get(st.tokenId), g, ids);
      map.strand.set(st.id, node);
      strandLayer.append(svg('g', { role: 'listitem' }, node));
    }
    const tokenLayer = svg('g', { class: 'sm-thr__tokens', role: 'list', 'aria-label': 'Token' });
    for (const t of layout.tokens) {
      const node = tokenNode(t, g);
      map.token.set(t.id, node);
      tokenLayer.append(svg('g', { role: 'listitem' }, node));
    }
    const root = svg('svg', {
      class: 'sm-thr__svg', viewBox: `0 0 ${g.W} ${g.H}`, width: '100%', preserveAspectRatio: 'xMidYMin meet',
      role: 'group', 'aria-labelledby': ids.title, 'aria-describedby': ids.desc,
      'data-compact': g.compact ? 'true' : 'false', 'data-sim': layout.isSimulated ? 'true' : undefined,
    },
    svg('title', { id: ids.title }, 'Peta Benang: wallet → token'),
    svg('desc', { id: ids.desc }, 'Wallet di kiri, token di kanan. Setiap benang menghubungkan satu wallet dengan token yang dibelinya '
      + 'lewat swap (atau yang menunjukkan indikasi keluar) dalam jendela radar, dari aktivitas on-chain publik. Tebal benang '
      + `mengikuti nilai USD (skala log); garis putus-putus berarti ${USD_UNKNOWN}.${layout.isSimulated ? ' Berisi DATA SIMULASI — bukan data live.' : ''}`),
    markerDefs(ids),
    backdrop(layout, g),
    walletLayer, strandLayer, tokenLayer);

    // Roving tabindex: satu tab stop per kolom, posisi terakhir dipertahankan saat dibangun ulang.
    for (const kind of ['wallet', 'strand', 'token']) {
      const prevId = roving[kind]?.dataset?.id;
      roving[kind] = null;
      const first = (kind === 'wallet' ? layout.wallets : kind === 'token' ? layout.tokens : layout.strands)[0];
      const el = map[kind].get(prevId) ?? (first ? map[kind].get(first.id) : null);
      if (el) setRoving(el);
    }

    for (const el of [...map.wallet.values(), ...map.token.values(), ...map.strand.values()]) {
      el.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'touch') return;
        hoverEl = el;
        paint();
      });
      el.addEventListener('pointerleave', () => {
        if (hoverEl !== el) return;
        hoverEl = null;
        paint();
      });
    }

    els = map;
    hoverEl = null;
    focusEl = null;
    lit = [];
    svgRoot = root;
    frame.replaceChildren(root);
    if (selected && map.strand.has(selected)) map.strand.get(selected).classList.add('is-selected');
    paint();
    return g.W;
  }

  // Delegasi di wadah HTML, bukan di <svg>: Chromium menjadikan elemen SVG yang punya pendengar focus/focusin
  // bisa difokus lewat Tab — <svg> akan menjadi tab stop kosong sebelum node pertama.
  frame.addEventListener('keydown', onKey);
  frame.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-thr="strand"]');
    if (el) select(el.dataset.id);
  });
  frame.addEventListener('focusin', (e) => {
    const el = e.target?.closest?.('[data-thr]');
    if (!el) return;
    setRoving(el);
    focusEl = el;
    if (el.dataset.thr === 'strand') select(el.dataset.id);
    else paint();
  });
  frame.addEventListener('focusout', (e) => {
    if (e.relatedTarget && frame.contains(e.relatedTarget)) return;
    focusEl = null;
    paint();
  });

  let builtWidth = build(isNum(width) && width > 0 ? width : estimateWidth());

  // Lebar nyata wadah → bangun ulang bila berubah berarti (mis. rotasi layar, sidebar diciutkan).
  if (!isNum(width) && typeof ResizeObserver === 'function') {
    let seenConnected = false;
    const ro = new ResizeObserver((entries) => {
      if (!frame.isConnected) {
        if (seenConnected) ro.disconnect();
        return;
      }
      seenConnected = true;
      const next = Math.round(entries[entries.length - 1]?.contentRect?.width ?? 0);
      if (next > 0 && Math.abs(Math.max(MIN_WIDTH, next) - builtWidth) >= REBUILD_DELTA) builtWidth = build(next);
    });
    ro.observe(frame);
  }

  const clusterNote = layout.clusters.length
    ? h('p', { class: 'sm-thr-clusters', 'data-testid': 'sm-threads-clusters' },
      h('span', { class: 'sm-k' }, 'Klaster'), ' ',
      layout.clusters.map((c, i) => [i ? ' · ' : '', h('span', { class: 'sm-thr-legend__tag' }, c.id),
        ` ${c.size} wallet terkait${c.totalSize > c.size ? ` (dari ${c.totalSize})` : ''} di ${chainName(c.chain)} — dihitung 1 pembeli independen`]))
    : null;

  return h('div', { class: 'sm-thr', 'data-testid': 'sm-threads' },
    h('div', { class: 'sm-thr__head' },
      h('p', { class: 'sm-thr__count', 'data-testid': 'sm-threads-count' }, threadsCountText(layout), ` · ${layout.shown.strands} benang`),
      simBadge(layout.isSimulated)),
    legend(),
    h('div', { class: 'sm-thr__cols', 'aria-hidden': 'true' }, h('span', null, 'Wallet · skor'), h('span', null, 'Token · keyakinan')),
    frame,
    h('p', { class: 'sm-thr__hint muted' }, 'Arahkan atau fokus untuk menyorot benang. Enter/klik node membuka profil wallet atau detail token. '
      + 'Keyboard: Tab berpindah kolom, panah atas/bawah di dalam kolom, kiri/kanan menyusuri benang, Esc menghapus pilihan.'),
    clusterNote,
    evidence,
    h('div', { class: 'sr-only', 'data-testid': 'sm-threads-summary' }, h('ul', null, threadsSummaryLines(layout).map((line) => h('li', null, line)))),
    disclaimerBox([THREADS_NOTE, d.conviction]));
}
