// Kontrol scanner dari website: kartu "Kontrol scanner" (System Health) dan callout ringkas (Overview).
// Server menjalankan worker sebagai child process terpisah (backend/system/workerSupervisor.js); hanya admin
// yang dapat menjalankan/menghentikan, analyst hanya melihat state.
import { ApiError, api } from '../lib/api.js';
import { callout, panel, toast } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatUtc } from '../lib/format.js';
import { canStartWorker, isWorkerTransitional, workerControlLabel, workerControlPill } from './workerFormat.js';

const POLL_MS = 2_000;

/** Pesan error yang dapat dipahami pengguna; pesan server (Bahasa Indonesia) dipakai bila ada. */
export function workerErrorMessage(err) {
  if (!(err instanceof ApiError)) return 'Server tidak dapat dihubungi. Coba lagi.';
  if (err.code === 'CSRF_INVALID') return 'Token keamanan sesi kedaluwarsa. Muat ulang halaman lalu coba lagi.';
  if (err.status === 403) return 'Hanya admin yang dapat menjalankan atau menghentikan scanner.';
  return err.message || 'Permintaan gagal. Coba lagi.';
}

function describe(status) {
  if (!status?.enabled) {
    return 'Kontrol dari website dinonaktifkan (WORKER_CONTROL=false). Jalankan worker dengan npm run worker di terminal terpisah.';
  }
  switch (status.state) {
    case 'running':
      return `Worker berjalan sebagai proses terpisah yang dikelola server ini${status.startedAt ? ` sejak ${formatUtc(status.startedAt)}` : ''}. Log-nya tampil di terminal npm start.`;
    case 'starting':
      return 'Menyiapkan proses worker…';
    case 'stopping':
      return 'Menunggu worker menyelesaikan tugas aktif dan menulis heartbeat akhir (maks. 15 detik, lalu dihentikan paksa).';
    case 'crashed':
      return 'Worker berhenti tak terduga. Periksa log di terminal npm start, lalu jalankan lagi.';
    case 'external':
      return 'Worker dijalankan di luar website (mis. npm run worker di terminal lain). Hentikan dari terminal tersebut; dua worker pada database yang sama akan menggandakan ingesti.';
    default:
      return status.stoppedAt
        ? `Berhenti sejak ${formatUtc(status.stoppedAt)}. Data pasar dan sinyal tidak diperbarui.`
        : 'Scanner belum dijalankan. Tekan "Jalankan scanner" untuk memulai ingesti candle dan analisis pola.';
  }
}

/**
 * Kartu "Kontrol scanner" untuk System Health. Elemen dibuat sekali; auto-refresh halaman memanggil
 * `update()` sehingga konfirmasi, fokus, dan request yang berjalan tidak hilang.
 * @param {{ user: { role: string }, status: object }} options
 * @returns {{ el: HTMLElement, update: (status: object) => void, cleanup: () => void }}
 */
export function workerControlCard({ user, status: initial }) {
  const isAdmin = user?.role === 'admin';
  let status = initial;
  let pending = false;
  let confirming = false;
  let pollTimer = null;
  let disposed = false;

  const stateEl = h('div', { class: 'worker-control__state', 'aria-live': 'polite', 'data-testid': 'worker-control-state' });
  const descEl = h('p', { class: 'worker-control__desc' });
  const errorEl = h('p', { class: 'field__error', role: 'alert', hidden: true });

  const startBtn = h('button', { class: 'btn btn--primary', type: 'button', on: { click: () => run('start') } }, 'Jalankan scanner');
  const stopBtn = h('button', { class: 'btn btn--danger', type: 'button', on: { click: () => openConfirm() } }, 'Hentikan scanner');
  const confirmBtn = h('button', { class: 'btn btn--danger', type: 'button', on: { click: () => run('stop') } }, 'Ya, hentikan');
  const cancelBtn = h('button', { class: 'btn', type: 'button', on: { click: () => closeConfirm() } }, 'Batal');
  const confirmEl = h('div', {
    class: 'worker-control__confirm', role: 'group', 'aria-labelledby': 'worker-confirm-text', hidden: true,
    on: { keydown: (e) => { if (e.key === 'Escape') closeConfirm(); } },
  },
  h('p', { id: 'worker-confirm-text' }, 'Hentikan scanner? Ingesti candle dan analisis pola berhenti sampai dijalankan lagi.'),
  h('div', { class: 'cluster' }, confirmBtn, cancelBtn));

  const controls = isAdmin
    ? h('div', { class: 'cluster', 'data-testid': 'worker-control-actions' }, startBtn, stopBtn)
    : h('p', { class: 'subtle' }, 'Hanya admin yang dapat menjalankan atau menghentikan scanner.');

  const body = h('div', { class: 'worker-control', tabindex: '-1' }, stateEl, descEl, controls, confirmEl, errorEl);
  const el = panel({ title: 'Kontrol scanner', id: 'worker-control' }, body);

  function showError(message) {
    errorEl.textContent = message ?? '';
    errorEl.hidden = !message;
  }

  function render() {
    // Konten wilayah aria-live hanya diganti saat label berubah, agar refresh berkala tidak diumumkan ulang.
    const { text } = workerControlLabel(status);
    if (stateEl.dataset.label !== text) {
      stateEl.dataset.label = text;
      stateEl.replaceChildren(workerControlPill(status));
    }
    descEl.textContent = describe(status);
    body.setAttribute('aria-busy', String(pending || isWorkerTransitional(status)));
    startBtn.disabled = pending || !canStartWorker(status);
    stopBtn.disabled = pending || confirming || !status?.enabled || status.state !== 'running';
    confirmBtn.disabled = pending;
    cancelBtn.disabled = pending;
    if (confirming && status?.state !== 'running' && !pending) closeConfirm({ restoreFocus: false });
  }

  function openConfirm() {
    confirming = true;
    confirmEl.hidden = false;
    render();
    cancelBtn.focus();
  }

  function closeConfirm({ restoreFocus = true } = {}) {
    confirming = false;
    confirmEl.hidden = true;
    render();
    if (restoreFocus && !stopBtn.disabled) stopBtn.focus();
  }

  function schedulePoll() {
    if (disposed || pollTimer !== null || !isWorkerTransitional(status)) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      try {
        // Polling otomatis bukan aktivitas pengguna: tidak memperpanjang idle timeout sesi.
        const next = await api('/api/system/worker', { background: true });
        if (!disposed) update(next);
      } catch {
        if (!disposed) schedulePoll();
      }
    }, POLL_MS);
  }

  async function run(action) {
    if (pending) return;
    pending = true;
    showError(null);
    render();
    try {
      status = await api(`/api/system/worker/${action}`, { method: 'POST' });
      if (disposed) return;
      if (action === 'stop') {
        confirming = false;
        confirmEl.hidden = true;
      }
      toast(action === 'start' ? 'Scanner dijalankan' : 'Scanner sedang dihentikan', 'bull');
    } catch (err) {
      if (disposed) return;
      showError(workerErrorMessage(err));
      try {
        status = await api('/api/system/worker');
      } catch {
        // State terakhir yang diketahui tetap ditampilkan.
      }
    } finally {
      pending = false;
      if (!disposed) {
        render();
        schedulePoll();
        keepFocus();
      }
    }
  }

  /** Fokus tidak boleh hilang ke <body> saat tombol yang ditekan menjadi nonaktif atau tersembunyi. */
  function keepFocus() {
    const active = document.activeElement;
    const lost = !active || active === document.body || active.disabled || Boolean(active.closest?.('[hidden]'));
    if (!lost) return;
    ([startBtn, stopBtn].find((b) => b.isConnected && !b.disabled) ?? body).focus({ preventScroll: true });
  }

  function update(next) {
    if (disposed || !next) return;
    status = next;
    if (!pending) render();
    schedulePoll();
  }

  render();
  schedulePoll();
  return {
    el,
    update,
    cleanup() {
      disposed = true;
      clearTimeout(pollTimer);
      pollTimer = null;
    },
  };
}

/**
 * Callout ringkas Overview: tampil bila kontrol aktif dan scanner tidak berjalan; tombol hanya untuk admin.
 * @param {{ user: { role: string }, status: object|null }} options
 * @returns {HTMLElement|null}
 */
export function workerStartCallout({ user, status }) {
  if (!canStartWorker(status)) return null;
  const isAdmin = user?.role === 'admin';
  const crashed = status.state === 'crashed';
  const message = h('p', null,
    h('strong', null, crashed ? `Scanner berhenti tak terduga — ${workerControlLabel(status).text}.` : 'Scanner belum berjalan.'),
    ' Data pasar dan sinyal tidak diperbarui.',
    isAdmin ? null : ' Minta admin menjalankannya dari System Health.');
  const errorEl = h('p', { class: 'field__error', role: 'alert', hidden: true });
  const content = h('div', { class: 'callout__content' }, message, errorEl);
  const el = callout([content], 'warn');
  el.classList.add('callout--action');
  el.dataset.testid = 'worker-callout';
  if (!isAdmin) return el;

  const button = h('button', {
    class: 'btn btn--primary btn--sm',
    type: 'button',
    on: {
      click: async () => {
        button.disabled = true;
        errorEl.hidden = true;
        try {
          await api('/api/system/worker/start', { method: 'POST' });
          message.replaceChildren(h('strong', null, 'Scanner berjalan.'), ' Data mulai diperbarui setelah discovery & backfill selesai.');
          button.remove();
          toast('Scanner dijalankan', 'bull');
        } catch (err) {
          errorEl.textContent = workerErrorMessage(err);
          errorEl.hidden = false;
          button.disabled = false;
        }
      },
    },
  }, 'Jalankan scanner');
  el.append(button);
  return el;
}
