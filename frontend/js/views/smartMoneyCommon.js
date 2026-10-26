// Komponen DOM bersama halaman Smart Money (radar, wallet, token, watchlist). Semua lewat h() — aman XSS.
// Prinsip: data simulasi selalu berpita "DATA SIMULASI"; nilai USD null tampil '—' (bukan 0); tanpa provider →
// keadaan kosong yang jujur; tautan explorer selalu target=_blank rel=noopener noreferrer.
import { ApiError, api } from '../lib/api.js';
import { badge, emptyState, toast } from '../lib/components.js';
import { h, icon } from '../lib/dom.js';
import { formatRelative, formatUtc } from '../lib/format.js';
import {
  CHAIN_LABELS, EMPTY, SM_API, USD_UNKNOWN, clampScore, componentPercent, disclaimersOf, flagInfo, formatUsdOrDash,
  labelText, matchBadge, metaStatus, safeExternalUrl, shortAddress, signOf, smartTokenHref, smartWalletHref,
  stateLabel, typeHint, typeKind, typeLabel,
} from './smartMoneyFormat.js';

/** Chip chain (teks, bukan warna saja). */
export function chainBadge(chain) {
  const el = badge(CHAIN_LABELS[chain] ?? String(chain ?? '?'));
  el.classList.add('sm-chain');
  el.dataset.chain = chain ?? '';
  return el;
}

export function stateBadge(state) {
  const s = stateLabel(state);
  const el = badge(s.label, s.tone);
  el.classList.add('sm-state');
  el.title = s.text;
  return el;
}

/** Badge status Binance: MATCHED → simbol futures; SYMBOL_ONLY/AMBIGUOUS → peringatan; NOT_LISTED → netral. */
export function binanceBadge(match) {
  const m = matchBadge(match);
  const el = badge(m.status === 'SYMBOL_ONLY' ? '⚠ Simbol sama, kontrak belum terverifikasi' : m.label, m.tone);
  el.classList.add('sm-match');
  el.dataset.status = m.status;
  el.title = m.text;
  return el;
}

/** Badge jenis aktivitas dengan kelompok warna (data-kind): swap beli/jual dibedakan dari transfer/exchange/bridge/airdrop/LP. */
export function typeBadge(type) {
  const el = h('span', { class: 'sm-type', 'data-kind': typeKind(type), title: typeHint(type) }, typeLabel(type));
  return el;
}

/** Tautan eksternal aman (https saja), selalu tab baru tanpa referrer. */
export function externalLink(url, text, { label, className = 'sm-ext' } = {}) {
  const href = safeExternalUrl(url);
  if (!href) return h('span', { class: 'muted' }, text ?? EMPTY);
  return h('a', { class: className, href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label },
    text, icon('external', 'sm-ext__icon'));
}

/** Tautan tx explorer dengan hash pendek. */
export function txLink(url, txHash) {
  return externalLink(url, shortAddress(txHash, 8, 6), { label: `Buka transaksi ${txHash ?? ''} di explorer (tab baru)` });
}

/**
 * Sel USD: null → '—' dengan tooltip "nilai USD tidak diketahui" (null BUKAN nol).
 * @param {number|null} value
 * @param {{ signed?: boolean, tone?: boolean }} [options]
 */
export function usdText(value, { signed = false, tone = false } = {}) {
  const text = formatUsdOrDash(value, { signed });
  if (text === EMPTY) return h('span', { class: 'sm-usd sm-usd--unknown', title: USD_UNKNOWN, 'aria-label': USD_UNKNOWN }, EMPTY);
  const dir = tone ? signOf(value) : null;
  return h('span', { class: dir ? `sm-usd delta delta--${dir}` : 'sm-usd' }, text);
}

/** Alamat pendek (mono) yang menautkan ke profil/halaman detail; teks lengkap di title. */
export function addressLink(address, href, { label } = {}) {
  const text = shortAddress(address);
  if (!href) return h('span', { class: 'mono', title: address }, text);
  return h('a', { class: 'mono sm-addr', href, title: address, 'aria-label': label ?? `Alamat ${address}` }, text);
}

export const walletLink = (chain, address) => addressLink(address, smartWalletHref(chain, address), { label: `Profil wallet ${address}` });
export const tokenLink = (chain, address, symbol) => h('a', { class: 'sm-token-link', href: smartTokenHref(chain, address), title: `${symbol ?? ''} ${address}` },
  h('span', { class: 'sm-token-link__sym' }, symbol || '?'), h('span', { class: 'mono sm-token-link__addr' }, shortAddress(address)));

/** Daftar label alamat; setiap label membawa sumbernya. */
export function labelChips(labels) {
  const list = (Array.isArray(labels) ? labels : labels ? [labels] : []).filter((l) => l?.label);
  if (!list.length) return null;
  return h('span', { class: 'cluster sm-labels' }, list.map((l) => {
    const el = badge(l.label, l.source ? 'violet' : 'warn');
    el.title = labelText(l);
    el.append(h('span', { class: 'sr-only' }, l.source ? ` (sumber: ${l.source})` : ' (tanpa sumber)'));
    return el;
  }));
}

/** Chip penanda wallet dengan tooltip alasan. */
export function flagChips(flags) {
  const list = Array.isArray(flags) ? flags.filter(Boolean) : [];
  if (!list.length) return h('span', { class: 'muted' }, EMPTY);
  return h('span', { class: 'cluster sm-flags' }, list.map((f) => {
    const info = flagInfo(f);
    const el = badge(info.label, info.tone);
    el.title = info.title;
    el.tabIndex = 0; // tooltip juga terjangkau keyboard (title + aria-label)
    el.setAttribute('aria-label', `${info.label}: ${info.title}`);
    return el;
  }));
}

/**
 * Bar skor 0–100 dengan label eksplisit (mis. "Skor keyakinan (bukan probabilitas)").
 * @param {number|null} value
 * @param {{ label: string, tone?: string }} options
 */
export function meter(value, { label, tone = 'accent' }) {
  const v = clampScore(value);
  return h('div', { class: 'sm-meter', 'data-tone': tone },
    h('div', { class: 'sm-meter__head' },
      h('span', { class: 'sm-meter__label' }, label),
      h('span', { class: 'sm-meter__value num' }, v === null ? EMPTY : `${v}/100`)),
    h('div', {
      class: 'sm-meter__track', role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100,
      'aria-valuenow': v ?? undefined, 'aria-valuetext': v === null ? 'tidak diketahui' : `${v} dari 100`,
    }, h('span', { class: 'sm-meter__fill', style: { '--lr-score': v ?? 0 } })));
}

/** Daftar komponen skor (0..1) sebagai bar kecil berlabel. Penalti (nama berakhiran Penalty) bernada bear. */
export function componentBars(components, labels) {
  const entries = Object.entries(components ?? {}).filter(([, v]) => typeof v === 'number');
  if (!entries.length) return null;
  return h('ul', { class: 'sm-components' }, entries.map(([key, value]) => {
    const pct = componentPercent(value);
    const penalty = /penalty$/i.test(key);
    return h('li', { class: 'sm-component', 'data-penalty': penalty || undefined },
      h('span', { class: 'sm-component__label' }, labels[key] ?? key),
      h('span', { class: 'sm-component__track', 'aria-hidden': 'true' }, h('span', { class: 'sm-component__fill', style: { '--lr-score': pct ?? 0 } })),
      h('span', { class: 'sm-component__value num' }, pct === null ? EMPTY : `${penalty && value > 0 ? '−' : ''}${pct}%`));
  }));
}

export function textList(items, { className = 'sm-list', empty = null } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((t) => typeof t === 'string' && t);
  if (!list.length) return empty;
  return h('ul', { class: className }, list.map((t) => h('li', null, t)));
}

/** Pita "DATA SIMULASI" — tampil mencolok di atas halaman setiap kali ada data simulasi. */
export function simulatedRibbon(meta) {
  const d = disclaimersOf(meta);
  return h('div', { class: 'sm-sim-ribbon', role: 'alert', 'data-testid': 'sm-simulated' },
    h('strong', null, 'DATA SIMULASI'), h('span', null, d.simulated));
}

/**
 * Strip status dari `meta`: kesegaran data, sinkron terakhir, peringatan basi, cakupan, provider.
 * @param {object} meta
 * @param {number} now
 */
export function statusStrip(meta, now) {
  const s = metaStatus(meta);
  const items = [
    h('span', { class: 'sm-strip__item', title: s.dataAsOf ? formatUtc(s.dataAsOf) : 'Belum ada aktivitas tersimpan' },
      h('span', { class: 'sm-strip__k' }, 'Kesegaran'), s.dataAsOf ? `data per ${formatUtc(s.dataAsOf)}` : 'belum ada data'),
    h('span', { class: 'sm-strip__item', title: s.lastSyncAt ? formatUtc(s.lastSyncAt) : undefined },
      h('span', { class: 'sm-strip__k' }, 'Sinkron terakhir'), s.lastSyncAt ? formatRelative(s.lastSyncAt, now) : 'belum pernah'),
    h('span', { class: 'sm-strip__item' },
      h('span', { class: 'sm-strip__k' }, 'Cakupan'),
      `${s.chains.length ? s.chains.map((c) => CHAIN_LABELS[c] ?? c).join(', ') : 'tanpa chain'} · ${s.wallets ?? EMPTY} wallet · ${s.activities ?? EMPTY} aktivitas`),
    h('span', { class: 'sm-strip__item' },
      h('span', { class: 'sm-strip__k' }, 'Provider'), s.providersConfigured === null ? EMPTY : `${s.providersConfigured} terkonfigurasi`),
    // Atribusi wajib sumber data (syarat penggunaan API gratis, mis. "Powered by Etherscan").
    s.attributions.length > 0 && h('span', { class: 'sm-strip__item sm-strip__attr', 'data-testid': 'sm-attributions' },
      h('span', { class: 'sm-strip__k' }, 'Sumber data'), s.attributions.join(' · ')),
  ];
  return h('div', { class: 'sm-strip', 'data-stale': String(s.stale), 'data-testid': 'sm-status' },
    s.stale && h('span', { class: 'sm-strip__stale', role: 'status' }, badge('BASI', 'warn'),
      s.lastSyncAt ? ' Data belum diperbarui sesuai jadwal — angka mungkin tertinggal.' : ' Belum pernah sinkron.'),
    items,
    s.truncated && h('span', { class: 'sm-strip__item sm-strip__note', role: 'status' },
      'Jendela ini memuat aktivitas melebihi batas perhitungan — hanya aktivitas terbaru yang dihitung.'));
}

/** Bagian atas setiap halaman Smart Money: pita simulasi (bila ada) + strip status. */
export function metaHeader(meta, now) {
  const s = metaStatus(meta);
  return h('div', { class: 'stack sm-meta' }, s.simulated && simulatedRibbon(meta), statusStrip(meta, now));
}

/** Keadaan jujur "belum ada sumber data" (providersConfigured === 0 dan tanpa data). */
export function noSourceState() {
  return emptyState({
    iconName: 'radar',
    title: 'Belum ada sumber data on-chain',
    text: 'Belum ada provider data yang dikonfigurasi, sehingga tidak ada data yang ditampilkan — tidak ada data contoh atau rekaan. Admin perlu memilih provider (SMART_MONEY_PROVIDERS) dan mengisi API key gratis bila diperlukan; langkahnya ada di panduan docs/16-panduan-smart-money.md.',
    action: h('a', { class: 'btn btn--sm', href: '#/health' }, 'Buka System Health'),
  });
}

/** Keadaan error API dengan tombol coba lagi. 401 dilempar ulang (api() sudah mengarahkan ke login). */
export function errorState(err, onRetry, what = 'data smart money') {
  if (err?.status === 401) throw err;
  const detail = err instanceof ApiError ? `${err.message}${err.code && err.code !== 'UNKNOWN' ? ` (${err.code})` : ''}` : (err?.message ?? 'kesalahan jaringan');
  return h('div', { class: 'callout callout--bear sm-error', role: 'alert' },
    h('div', { class: 'stack' },
      h('span', null, h('strong', null, `Gagal memuat ${what}. `), detail),
      onRetry && h('div', null, h('button', { class: 'btn btn--sm', type: 'button', on: { click: onRetry } }, icon('refresh', 'btn__icon'), 'Coba lagi'))));
}

/** Kotak penafian (konservatif, tidak mencolok). */
export function disclaimerBox(texts) {
  const list = texts.filter(Boolean);
  return h('aside', { class: 'sm-disclaimer', 'aria-label': 'Penafian' }, list.map((t) => h('p', null, t)));
}

/**
 * Tombol ikuti/berhenti mengikuti (watchlist per pengguna). Status awal dari respons (`watching`).
 * @param {{ kind: 'WALLET'|'TOKEN', chain: string, address: string, watching: boolean, compact?: boolean, name?: string }} o
 */
export function watchButton({ kind, chain, address, watching, compact = false, name = '' }) {
  let on = watching === true;
  const noun = kind === 'WALLET' ? 'wallet' : 'token';
  const label = h('span');
  const btn = h('button', { class: compact ? 'btn btn--sm sm-watch' : 'btn sm-watch', type: 'button' }, icon('eye', 'btn__icon'), label);
  const paint = () => {
    label.textContent = on ? 'Diikuti' : `Ikuti ${noun}`;
    btn.setAttribute('aria-pressed', String(on));
    btn.dataset.on = String(on);
    btn.title = on ? `Berhenti mengikuti ${noun} ${name}`.trim() : `Ikuti ${noun} ${name} (watchlist & notifikasi)`.trim();
  };
  paint();
  btn.addEventListener('click', async () => {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    btn.setAttribute('aria-disabled', 'true');
    try {
      await api(`${SM_API}/watchlist`, { method: on ? 'DELETE' : 'POST', body: { kind, chain, address } });
      on = !on;
      paint();
      toast(on ? `${noun[0].toUpperCase()}${noun.slice(1)} diikuti.` : `Berhenti mengikuti ${noun}.`, on ? 'bull' : 'accent');
    } catch (err) {
      if (err?.status !== 401) toast(`Gagal memperbarui watchlist: ${err.message}`, 'bear');
    } finally {
      btn.removeAttribute('aria-disabled');
    }
  });
  return btn;
}

/** Tombol salin teks ke clipboard (alamat lengkap). */
export function copyButton(text, what = 'alamat') {
  return h('button', {
    class: 'btn btn--ghost btn--sm btn--icon', type: 'button', title: `Salin ${what}`, 'aria-label': `Salin ${what}`,
    on: {
      click: async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast(`${what[0].toUpperCase()}${what.slice(1)} disalin.`, 'bull');
        } catch {
          toast('Clipboard tidak tersedia — salin manual dari teks.', 'warn');
        }
      },
    },
  }, icon('copy', 'btn__icon'));
}

/**
 * Halaman Smart Money dengan muat-ulang terkendali: `fetcher()` → data, `render(data)` → node konten.
 * Kegagalan → error state dengan coba lagi (bukan halaman gagal total). Request basi diabaikan.
 * @param {{ fetcher: () => Promise<any>, render: (data: any) => any, what?: string }} o
 */
export function loadable({ fetcher, render, what }) {
  const host = h('div', { class: 'stack sm-host', 'aria-busy': 'false' });
  let seq = 0;
  async function load() {
    const id = ++seq;
    host.setAttribute('aria-busy', 'true');
    try {
      const data = await fetcher();
      if (id !== seq) return;
      host.replaceChildren(...[render(data)].flat().filter(Boolean));
    } catch (err) {
      if (id !== seq) return;
      if (err?.status === 401) return;
      host.replaceChildren(errorState(err, () => { load(); }, what));
    } finally {
      if (id === seq) host.setAttribute('aria-busy', 'false');
    }
  }
  return { el: host, load };
}

/** Penanda baris/item simulasi. */
export function simBadge(isSimulated) {
  if (!isSimulated) return null;
  const el = badge('SIMULASI', 'warn');
  el.title = 'Data simulasi — bukan data live';
  return el;
}
