// Strip status scanner di bawah topbar, terpasang di SEMUA halaman (app shell): apa yang sedang dikerjakan scanner —
// live / sinkron / berhenti, scan berkala terakhir & berikutnya, cakupan koin/seri, harga terakhir masuk, candle
// berikutnya tutup, kapan tabel halaman dimuat ulang — plus panel "Aktivitas" (± 30 kejadian terakhir worker).
// Data dari poller bersama GET /api/system/sync (syncProgress.js, polling LATAR 2–10 dtk); teks dirakit
// statusStripFormat.js (murni). Hitung mundur diperbarui tiap detik tanpa request. Semua teks lewat textContent (h()).
import { h } from '../lib/dom.js';
import { DATA_EVENT } from './liveData.js';
import { activityEntries, serverSkewMs, stripModel } from './statusStripFormat.js';
import { subscribeSyncStatus } from './syncProgress.js';

const TICK_MS = 1_000;

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Memasang strip status pada elemen host (section#status-strip di index.html). Idempoten per host.
 * @param {HTMLElement} host
 * @returns {{ refresh(): void }}
 */
export function mountStatusStrip(host) {
  if (!host) return { refresh() {} };
  const label = h('strong', { class: 'status-strip__label', 'data-testid': 'status-strip-label' });
  const pill = h('span', { class: 'status status-strip__state', 'data-state': 'idle' }, h('span', { class: 'status__dot', 'aria-hidden': 'true' }), label);
  const detail = h('span', { class: 'status-strip__detail', 'data-testid': 'status-strip-detail', hidden: true });
  const bar = h('span', { class: 'status-strip__bar', hidden: true, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('span', { class: 'status-strip__bar-fill' }));
  const segments = h('ul', { class: 'status-strip__segments', 'data-testid': 'status-strip-segments' });
  const count = h('span', { class: 'status-strip__count num', 'data-testid': 'activity-count' }, '0');
  const toggle = h('button', {
    class: 'status-strip__toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'activity-panel', 'data-testid': 'activity-toggle',
  }, 'Aktivitas', count);
  const list = h('ol', { class: 'activity-list', 'data-testid': 'activity-list' });
  const empty = h('p', { class: 'activity-panel__empty' }, 'Belum ada aktivitas tercatat — muncul begitu scanner berjalan.');
  const panelEl = h('div', {
    class: 'activity-panel', id: 'activity-panel', role: 'region', 'aria-label': 'Aktivitas scanner', 'data-testid': 'activity-panel', hidden: true,
  },
  h('div', { class: 'activity-panel__head' },
    h('span', { class: 'activity-panel__title' }, 'Aktivitas scanner'),
    h('span', { class: 'activity-panel__hint' }, 'terbaru di atas · jam WIB')),
  list, empty);
  // Pengumuman pembaca layar hanya saat keadaan berubah (bukan tiap detik/polling).
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite', 'data-testid': 'status-strip-announce' });
  host.replaceChildren(h('div', { class: 'status-strip__main' }, pill, detail, bar, segments), toggle, panelEl, announcer);
  host.hidden = false;

  let data = null;
  let page = null;
  let announced = null;
  let entriesKey = '';

  function renderActivity() {
    const entries = activityEntries(data);
    setText(count, String(entries.length));
    const key = entries.map((e) => `${e.key}|${e.text}`).join('\n');
    if (key === entriesKey) return;
    entriesKey = key;
    list.replaceChildren(...entries.map((e) => h('li', { class: 'activity-item', 'data-tone': e.tone, 'data-kind': e.kind },
      h('span', { class: 'activity-item__marker', 'aria-hidden': 'true' }),
      h('time', { class: 'activity-item__time num' }, e.time),
      h('span', { class: 'activity-item__text' }, e.text))));
    empty.hidden = entries.length > 0;
  }

  function render() {
    const now = Date.now() + serverSkewMs(data);
    const model = stripModel(data, { now, page });
    host.dataset.mode = model.mode;
    host.dataset.tone = model.tone;
    pill.dataset.state = model.tone;
    if (model.live) pill.dataset.live = '';
    else delete pill.dataset.live;
    setText(label, model.label);
    setText(detail, model.detail ?? '');
    detail.hidden = !model.detail;
    if (model.progress) {
      const pct = Math.floor(Math.min(1, Math.max(0, model.progress.ratio)) * 100);
      bar.hidden = false;
      bar.setAttribute('aria-label', model.progress.label);
      bar.setAttribute('aria-valuenow', String(pct));
      bar.firstElementChild.style.setProperty('--lr-strip-pct', String(pct));
    } else {
      bar.hidden = true;
    }
    host.setAttribute('aria-busy', String(model.busy));
    // Segmen: elemen dipertahankan per kunci, hanya teks yang berubah (tidak berkedip tiap detik).
    const existing = new Map([...segments.children].map((li) => [li.dataset.key, li]));
    const wanted = model.segments.map((s) => {
      const li = existing.get(s.key) ?? h('li', { class: 'status-strip__segment', 'data-key': s.key, 'data-testid': `status-strip-${s.key}` });
      setText(li, s.text);
      if (s.title) li.title = s.title;
      if (s.tone) li.dataset.tone = s.tone;
      else delete li.dataset.tone;
      return li;
    });
    if (wanted.length !== segments.children.length || wanted.some((li, i) => segments.children[i] !== li)) segments.replaceChildren(...wanted);
    const text = `Scanner: ${model.label}${model.detail ? ` — ${model.detail}` : ''}`;
    if (model.mode !== 'loading') {
      if (announced !== null && announced.split(' — ')[0] !== text.split(' — ')[0]) setText(announcer, text);
      announced = text;
    }
  }

  subscribeSyncStatus(host, (d) => {
    data = d;
    render();
    renderActivity();
  });

  // Kabar muat ulang tabel halaman aktif (liveData.reportDataRefresh); dilupakan saat berpindah halaman.
  window.addEventListener(DATA_EVENT, (e) => {
    const detailIn = e.detail ?? {};
    if (typeof detailIn.at !== 'number') return;
    page = { source: String(detailIn.source ?? 'Halaman'), at: detailIn.at, nextAt: typeof detailIn.nextAt === 'number' ? detailIn.nextAt : null };
    render();
  });
  window.addEventListener('hashchange', () => {
    page = null;
    render();
  });

  function setOpen(open) {
    toggle.setAttribute('aria-expanded', String(open));
    panelEl.hidden = !open;
    host.classList.toggle('is-open', open);
    if (open) renderActivity();
  }
  toggle.addEventListener('click', () => setOpen(panelEl.hidden));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panelEl.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!panelEl.hidden && !host.contains(e.target)) setOpen(false);
  });

  // Hitung mundur & "x detik lalu" tiap detik (tanpa request); dilewati saat tab tidak terlihat.
  setInterval(() => {
    if (!document.hidden) render();
  }, TICK_MS);

  render();
  return { refresh: render };
}
