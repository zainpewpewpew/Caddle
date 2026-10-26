// Watchlist & Alerts (#/smart-watchlist): wallet/token yang diikuti, notifikasi, dan preferensi notifikasi.
// GET/DELETE /api/smart-money/watchlist, GET /alerts + POST /alerts/read, GET/PUT /alert-prefs (docs/15 §5).
import { ApiError, api } from '../lib/api.js';
import { badge, callout, emptyState, page, panel, selectField, toast, toggle } from '../lib/components.js';
import { h, icon } from '../lib/dom.js';
import { formatRelative, formatUtc } from '../lib/format.js';
import {
  chainBadge, disclaimerBox, loadable, metaHeader, simBadge, txLink, walletLink,
} from './smartMoneyCommon.js';
import {
  ALERT_KINDS, ALERT_PREF_LIMITS, SM_API, alertKindLabel, buildAlertsQuery, disclaimersOf, explorerTxUrl,
  mapServerPrefErrors, parseTokenKey, prefsToForm, safeExternalUrl, shortAddress, smartTokenHref, smartWalletHref,
  validateAlertPrefsClient, watchSummaryText,
} from './smartMoneyFormat.js';

// ------------------------------------------------------------------ watchlist

function watchItem(item, onRemoved) {
  const isWallet = item.kind === 'WALLET';
  const href = isWallet ? smartWalletHref(item.chain, item.address) : smartTokenHref(item.chain, item.address);
  const summary = watchSummaryText(item.summary);
  const remove = h('button', {
    class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `Berhenti mengikuti ${isWallet ? 'wallet' : 'token'} ${item.address}`,
    on: {
      click: async () => {
        remove.setAttribute('aria-disabled', 'true');
        try {
          await api(`${SM_API}/watchlist`, { method: 'DELETE', body: { kind: item.kind, chain: item.chain, address: item.address } });
          toast('Dihapus dari watchlist.', 'accent');
          onRemoved();
        } catch (err) {
          remove.removeAttribute('aria-disabled');
          if (err?.status !== 401) toast(`Gagal menghapus: ${err.message}`, 'bear');
        }
      },
    },
  }, icon('close', 'btn__icon'), 'Hapus');
  return h('li', { class: 'sm-watch-item' },
    h('div', { class: 'sm-watch-item__main' },
      h('div', { class: 'cluster' }, chainBadge(item.chain),
        h('a', { class: 'mono', href, title: item.address }, shortAddress(item.address)),
        summary && h('span', { class: 'muted' }, summary)),
      item.note && h('p', { class: 'muted' }, item.note),
      h('span', { class: 'muted sm-watch-item__time' }, `diikuti ${formatRelative(item.createdAt)}`)),
    remove);
}

function watchlistSection() {
  const view = loadable({
    what: 'watchlist',
    fetcher: () => api(`${SM_API}/watchlist`),
    render: (data) => {
      const items = Array.isArray(data?.items) ? data.items : [];
      const group = (kind, title) => {
        const list = items.filter((i) => i.kind === kind);
        return h('div', { class: 'stack' }, h('h3', { class: 'sm-h' }, `${title} (${list.length})`),
          list.length ? h('ul', { class: 'sm-watch-list' }, list.map((i) => watchItem(i, () => view.load())))
            : h('p', { class: 'muted' }, kind === 'WALLET' ? 'Belum ada wallet diikuti — ikuti dari Wallet Discovery atau profil wallet.' : 'Belum ada token diikuti — ikuti dari radar atau detail token.'));
      };
      return h('div', { class: 'grid grid--2' }, group('WALLET', 'Wallet'), group('TOKEN', 'Token'));
    },
  });
  return { el: panel({ title: 'Diikuti' }, view.el), load: view.load };
}

// ------------------------------------------------------------------ alerts

function alertItem(alert, onRead) {
  const key = parseTokenKey(alert.tokenKey);
  const tone = alert.severity === 'HIGH' ? 'bear' : alert.severity === 'MEDIUM' ? 'warn' : undefined;
  const hashes = Array.isArray(alert.evidence?.txHashes) ? alert.evidence.txHashes : [];
  const urls = Array.isArray(alert.evidence?.explorerUrls) ? alert.evidence.explorerUrls : [];
  const markBtn = !alert.read && h('button', {
    class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `Tandai dibaca: ${alert.title ?? ''}`,
    on: { click: () => onRead([alert.id]) },
  }, 'Tandai dibaca');
  return h('li', { class: 'sm-alert', 'data-read': String(Boolean(alert.read)), 'data-severity': alert.severity ?? '' },
    h('div', { class: 'sm-alert__head cluster' },
      !alert.read && h('span', { class: 'sm-alert__dot', 'aria-hidden': 'true' }),
      badge(alertKindLabel(alert.kind), tone),
      alert.chain && chainBadge(alert.chain),
      simBadge(alert.isSimulated),
      h('span', { class: 'muted', title: formatUtc(alert.createdAt) }, formatRelative(alert.createdAt)),
      !alert.read ? h('span', { class: 'sr-only' }, 'belum dibaca') : null),
    h('p', { class: 'sm-alert__title' }, alert.title ?? ''),
    alert.message && h('p', { class: 'sm-alert__msg' }, alert.message),
    h('div', { class: 'cluster sm-alert__links' },
      key && h('a', { href: smartTokenHref(key.chain, key.address) }, 'Detail token'),
      alert.wallet && key && walletLink(key.chain, alert.wallet),
      hashes.slice(0, 5).map((tx, i) => txLink(safeExternalUrl(urls[i]) ?? explorerTxUrl(alert.chain ?? key?.chain, tx), tx)),
      markBtn));
}

function alertsSection() {
  const filters = h('form', { class: 'toolbar sm-toolbar', 'aria-label': 'Filter notifikasi' },
    h('div', { class: 'field sm-toolbar__switch' }, toggle({ name: 'unread', label: 'Hanya belum dibaca', checked: true })),
    selectField({ label: 'Jenis', name: 'kind', options: [{ value: '', label: 'Semua' }, ...ALERT_KINDS.map((k) => ({ value: k, label: alertKindLabel(k) }))] }));
  filters.addEventListener('submit', (e) => e.preventDefault());
  const unreadBadge = badge('0 belum dibaca');
  const metaHost = h('div');

  async function markRead(body) {
    try {
      const res = await api(`${SM_API}/alerts/read`, { method: 'POST', body });
      toast(`${res?.updated ?? 0} notifikasi ditandai dibaca.`, 'bull');
      await view.load();
    } catch (err) {
      if (err?.status !== 401) toast(`Gagal menandai dibaca: ${err.message}`, 'bear');
    }
  }
  const markAll = h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => markRead({ all: true }) } }, 'Tandai semua dibaca');

  const view = loadable({
    what: 'notifikasi',
    fetcher: () => api(buildAlertsQuery({ unread: filters.elements.unread.checked, kind: filters.elements.kind.value })),
    render: (data) => {
      const items = Array.isArray(data?.items) ? data.items : [];
      metaHost.replaceChildren(metaHeader(data?.meta, Date.now()));
      const unread = typeof data?.unread === 'number' ? data.unread : items.filter((a) => !a.read).length;
      unreadBadge.textContent = `${unread} belum dibaca`;
      unreadBadge.className = unread > 0 ? 'badge badge--accent' : 'badge';
      markAll.disabled = unread === 0;
      if (!items.length) {
        return emptyState({ iconName: 'bell', title: filters.elements.unread.checked ? 'Tidak ada notifikasi belum dibaca' : 'Belum ada notifikasi', text: 'Notifikasi dibuat saat sinkronisasi menemukan aktivitas yang memenuhi preferensi Anda.' });
      }
      return h('ul', { class: 'sm-alerts', 'aria-label': 'Notifikasi' }, items.map((a) => alertItem(a, (ids) => markRead({ ids }))));
    },
  });
  filters.addEventListener('change', () => { view.load(); });
  return {
    metaHost,
    el: panel({ title: 'Notifikasi', actions: [unreadBadge, markAll], flush: true }, filters, h('div', { class: 'sm-panel-body' }, view.el)),
    load: view.load,
  };
}

// ------------------------------------------------------------------ preferensi

function numberField({ name, label, value, hint, step = 'any' }) {
  const [min, max] = ALERT_PREF_LIMITS[name];
  const id = `f-sm-${name}`;
  const errId = `${id}-error`;
  return h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    h('input', { class: 'input', id, name, type: 'number', inputmode: 'decimal', min, max, step, value: String(value), 'aria-describedby': `${errId} ${id}-hint` }),
    h('span', { class: 'field__hint', id: `${id}-hint` }, hint),
    h('span', { class: 'field__error', id: errId, 'data-error-for': name, hidden: true }));
}

function readPrefsForm(form) {
  const fd = new FormData(form);
  return {
    kinds: fd.getAll('kinds'),
    minUsd: fd.get('minUsd'),
    largeSellUsd: fd.get('largeSellUsd'),
    minWalletScore: fd.get('minWalletScore'),
    minIndependentBuyers: fd.get('minIndependentBuyers'),
    cooldownHours: fd.get('cooldownHours'),
    watchlistOnly: form.elements.watchlistOnly.checked,
  };
}

function showErrors(form, fields, general, generalHost) {
  for (const el of form.querySelectorAll('[data-error-for]')) {
    const msg = fields[el.dataset.errorFor];
    el.textContent = msg ?? '';
    el.hidden = !msg;
    const input = form.querySelector(`[name="${el.dataset.errorFor}"]`);
    if (input && input.type !== 'checkbox') input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
  generalHost.replaceChildren(...(general.length ? [callout(h('ul', { class: 'sm-list' }, general.map((g) => h('li', null, g))), 'bear')] : []));
  const first = Object.keys(fields)[0];
  if (first) form.querySelector(`[name="${first}"]`)?.focus();
}

function prefsForm(data) {
  const v = prefsToForm(data?.prefs);
  const generalHost = h('div', { role: 'alert' });
  const saveBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Simpan preferensi');
  const form = h('form', { class: 'stack sm-prefs', novalidate: true, 'aria-label': 'Preferensi notifikasi' },
    data?.isDefault ? h('p', { class: 'muted' }, 'Saat ini memakai preferensi bawaan.') : null,
    h('fieldset', { class: 'sm-fieldset' },
      h('legend', { class: 'field__label' }, 'Jenis notifikasi'),
      h('div', { class: 'sm-kinds' }, ALERT_KINDS.map((k) => h('label', { class: 'sm-check' },
        h('input', { type: 'checkbox', name: 'kinds', value: k, checked: v.kinds.includes(k) }), h('span', null, alertKindLabel(k))))),
      h('span', { class: 'field__error', 'data-error-for': 'kinds', hidden: true })),
    h('div', { class: 'form-grid' },
      numberField({ name: 'minUsd', label: 'Nilai beli minimum (USD)', value: v.minUsd, hint: 'Untuk notifikasi beli baru.' }),
      numberField({ name: 'largeSellUsd', label: 'Ambang jual besar (USD)', value: v.largeSellUsd, hint: 'Swap jual ≥ nilai ini.' }),
      numberField({ name: 'minWalletScore', label: 'Skor wallet minimum', value: v.minWalletScore, hint: '0–100, bukan probabilitas.' }),
      numberField({ name: 'minIndependentBuyers', label: 'Min. pembeli independen', value: v.minIndependentBuyers, hint: 'Untuk notifikasi beli multi-wallet.', step: '1' }),
      numberField({ name: 'cooldownHours', label: 'Jeda notifikasi (jam)', value: v.cooldownHours, hint: 'Notifikasi sejenis tidak diulang dalam jeda ini.' })),
    toggle({ name: 'watchlistOnly', label: 'Hanya wallet/token di watchlist', checked: v.watchlistOnly }),
    generalHost,
    h('div', { class: 'cluster' }, saveBtn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { prefs, errors } = validateAlertPrefsClient(readPrefsForm(form));
    if (!prefs) {
      showErrors(form, errors, [], generalHost);
      return;
    }
    showErrors(form, {}, [], generalHost);
    saveBtn.disabled = true;
    try {
      await api(`${SM_API}/alert-prefs`, { method: 'PUT', body: { prefs } });
      toast('Preferensi notifikasi disimpan.', 'bull');
    } catch (err) {
      if (err?.status === 401) return;
      if (err instanceof ApiError && err.status === 400) {
        const mapped = mapServerPrefErrors(err.details);
        showErrors(form, mapped.fields, mapped.general.length || Object.keys(mapped.fields).length ? mapped.general : [err.message], generalHost);
      } else {
        showErrors(form, {}, [`Gagal menyimpan: ${err.message}`], generalHost);
      }
    } finally {
      saveBtn.disabled = false;
    }
  });
  return form;
}

function prefsSection() {
  const view = loadable({ what: 'preferensi notifikasi', fetcher: () => api(`${SM_API}/alert-prefs`), render: prefsForm });
  return { el: panel({ title: 'Preferensi notifikasi' }, view.el), load: view.load };
}

export async function smartWatchlistView() {
  const watch = watchlistSection();
  const alerts = alertsSection();
  const prefs = prefsSection();
  // Tiap bagian menampilkan error/retry-nya sendiri; satu kegagalan tidak menggagalkan halaman.
  await Promise.all([watch.load(), alerts.load(), prefs.load()]).catch((err) => {
    if (err?.status === 401) throw err;
  });
  const d = disclaimersOf(null);
  const el = page({
    title: 'Watchlist & Alerts',
    subtitle: 'Wallet dan token yang Anda ikuti, notifikasi aktivitas, dan filter notifikasi. Notifikasi adalah ringkasan bukti on-chain, bukan saran transaksi.',
    actions: h('a', { class: 'btn btn--sm btn--ghost', href: '#/smart-money' }, icon('radar', 'btn__icon'), 'Radar'),
  },
  alerts.metaHost,
  h('div', { class: 'grid grid--main-side' }, h('div', { class: 'stack' }, alerts.el, watch.el), prefs.el),
  disclaimerBox([d.insiderName, d.readOnly]));
  el.classList.add('page--smart-money');
  return el;
}
