// Detail Token (#/smart-token?c=<chain>&a=<kontrak>): identitas token (chain + kontrak), pencocokan Binance,
// ringkasan radar 24 jam, aktivitas per wallet dengan bukti, dan tautan screener. GET /api/smart-money/tokens/:chain/:address.
import { api } from '../lib/api.js';
import { badge, emptyState, page, panel } from '../lib/components.js';
import { h, icon } from '../lib/dom.js';
import { formatRelative, formatTime } from '../lib/format.js';
import { hashQuery } from '../lib/router.js';
import {
  binanceBadge, chainBadge, copyButton, disclaimerBox, externalLink, loadable, meter, metaHeader, simBadge, stateBadge,
  usdText, watchButton,
} from './smartMoneyCommon.js';
import { evidencePanel, screenerSignals } from './smartMoneyRadar.js';
import { activityTable } from './smartWallets.js';
import {
  CHAIN_LABELS, EMPTY, disclaimersOf, entityPath, explorerTokenUrl, formatSignedPct, matchBadge, parseEntityQuery,
  relevanceLabel, shortAddress, symbolChartHref,
} from './smartMoneyFormat.js';

function identity(chain, address, data) {
  const t = data.token ?? {};
  const sym = t.symbol || '?';
  return h('section', { class: 'sm-identity', 'aria-label': 'Identitas token' },
    h('div', { class: 'sm-identity__main' },
      h('div', { class: 'cluster' },
        h('span', { class: 'sm-identity__sym' }, sym),
        t.name && h('span', { class: 'muted' }, t.name),
        chainBadge(chain), simBadge(t.isSimulated)),
      h('p', { class: 'sm-identity__addr mono', 'data-testid': 'sm-token-contract' }, address),
      h('p', { class: 'muted' }, 'Identitas token = chain + alamat kontrak. Simbol hanya label: token lain dapat memakai simbol yang sama.'),
      h('div', { class: 'cluster' }, copyButton(address, 'kontrak'),
        externalLink(t.explorerUrl ?? explorerTokenUrl(chain, address), 'Buka di explorer', { label: `Buka kontrak ${sym} di explorer (tab baru)` }))),
    h('div', { class: 'sm-identity__actions' }, watchButton({ kind: 'TOKEN', chain, address, watching: data.watching, name: sym })));
}

function binancePanel(data) {
  const m = matchBadge(data.binance);
  const rel = relevanceLabel(data.screener?.relevance);
  const chart = symbolChartHref(data.binance);
  const d = disclaimersOf(data.meta);
  return panel({ title: 'Binance & screener' },
    h('div', { class: 'stack' },
      h('div', { class: 'cluster' }, binanceBadge(data.binance), badge(rel.label, rel.tone),
        chart && h('a', { class: 'btn btn--sm', href: chart, 'data-testid': 'sm-open-chart' }, icon('symbol', 'btn__icon'), 'Buka chart')),
      h('p', null, m.text),
      data.binance?.source ? h('p', { class: 'muted' }, `Sumber mapping: ${data.binance.source}`) : null,
      data.screener?.relevanceReason ? h('p', null, data.screener.relevanceReason) : h('p', { class: 'muted' }, rel.text),
      m.status === 'MATCHED'
        ? h('div', null, h('h3', { class: 'sm-h' }, 'Sinyal LONG aktif'), screenerSignals(data.screener))
        : h('p', { class: 'muted' }, 'Tidak ditautkan ke sinyal screener karena kontrak tidak terverifikasi cocok dengan pasar Binance.'),
      h('p', { class: 'sm-disclaimer-inline' }, data.screener?.note || d.spotVsFutures)));
}

function radarPanel(data) {
  const r = data.radar;
  if (!r) {
    return panel({ title: 'Radar 24 jam' }, h('p', { class: 'muted' }, 'Tidak ada pembelian swap oleh wallet eligible dalam 24 jam terakhir.'));
  }
  return panel({ title: 'Radar 24 jam', actions: stateBadge(r.state) },
    h('div', { class: 'stack' },
      meter(r.conviction, { label: 'Skor keyakinan (bukan probabilitas)' }),
      h('dl', { class: 'sm-facts' },
        h('div', null, h('dt', null, 'Pembeli independen'), h('dd', { class: 'num' }, `${r.independentBuyers ?? 0} dari ${r.buyerCount ?? 0}`)),
        h('div', null, h('dt', null, 'Penjual'), h('dd', { class: 'num' }, String(r.sellerCount ?? 0))),
        h('div', null, h('dt', null, 'Net flow'), h('dd', null, usdText(r.netFlowUsd, { signed: true, tone: true }))),
        h('div', null, h('dt', null, 'Gross beli'), h('dd', null, usdText(r.grossBuyUsd))),
        h('div', null, h('dt', null, 'Gross jual'), h('dd', null, usdText(r.grossSellUsd))),
        h('div', null, h('dt', null, 'Perubahan kepemilikan'), h('dd', { class: 'num' }, formatSignedPct(r.holdingChangePct))),
        h('div', null, h('dt', null, 'Aktivitas terakhir'), h('dd', { title: formatTime(r.lastActivityAt) }, formatRelative(r.lastActivityAt)))),
      evidencePanel({ ...r, chain: r.chain ?? data.token?.chain }, data.meta)));
}

export async function smartTokenView() {
  const { chain, address, invalid } = parseEntityQuery(hashQuery());
  const metaHost = h('div');
  const pageEl = (content) => {
    const el = page({ title: 'Detail Token', subtitle: 'Aktivitas smart money pada satu kontrak token, dengan bukti transaksi yang dapat diverifikasi di explorer.' }, metaHost, content);
    el.classList.add('page--smart-money');
    return el;
  };
  if (invalid) {
    return pageEl(emptyState({
      iconName: 'radar', title: 'Parameter token tidak valid', text: 'Tautan harus berisi chain yang dikenal (c=) dan alamat kontrak yang valid (a=).',
      action: h('a', { class: 'btn btn--sm', href: '#/smart-money' }, 'Kembali ke radar'),
    }));
  }
  const view = loadable({
    what: 'detail token',
    fetcher: async () => {
      try {
        return await api(entityPath('tokens', chain, address));
      } catch (err) {
        if (err?.status === 404) return { notFound: true };
        throw err;
      }
    },
    render: (data) => {
      if (data.notFound) {
        return emptyState({ iconName: 'radar', title: 'Token belum tercatat', text: `Belum ada aktivitas tercatat untuk ${shortAddress(address)} di ${CHAIN_LABELS[chain]}.` });
      }
      metaHost.replaceChildren(metaHeader(data.meta, Date.now()));
      const d = disclaimersOf(data.meta);
      const radar = data.radar ? { ...data.radar, chain: data.radar.chain ?? chain } : null;
      return [
        identity(chain, address, data),
        h('div', { class: 'grid grid--2' }, radarPanel({ ...data, radar, token: { ...(data.token ?? {}), chain } }), binancePanel(data)),
        panel({ title: 'Aktivitas wallet', flush: true, footer: 'Setiap baris dapat diverifikasi lewat tautan tx (tab baru). Hanya swap yang dihitung beli/jual.' },
          activityTable(chain, data.activities, { withWallet: true, withToken: false, caption: `Aktivitas wallet pada ${data.token?.symbol ?? EMPTY}` })),
        disclaimerBox([d.conviction, d.insiderName, d.readOnly]),
      ];
    },
  });
  await view.load();
  return pageEl(view.el);
}
