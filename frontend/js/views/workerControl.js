// Kontrol scanner dari website: kartu "Kontrol scanner" (System Health) dan kontrol persisten ringkas
// (Overview, LONG Scanner, SHORT Scanner).
// Server menjalankan worker sebagai child process terpisah (backend/system/workerSupervisor.js); hanya admin
// yang dapat menjalankan/menghentikan, analyst hanya melihat state.
import { ApiError, api } from '../lib/api.js';
import { callout, panel, toast } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatUtc } from '../lib/format.js';
import { requestSyncRefresh, syncProgressInline } from './syncProgress.js';
import { canStartWorker, isWorkerActive, isWorkerTransitional, workerControlLabel, workerControlPill } from './workerFormat.js';

const POLL_MS = 2_000;
/**
 * Setelah start berhasil, state 'running' hanya berarti proses sudah di-spawn: worker masih dapat crash sesaat
 * kemudian (mis. konfigurasi tidak valid). Selama jendela ini UI tetap memantau tiap POLL_MS agar crash tampil
 * dalam beberapa detik, bukan menunggu auto-refresh halaman.
 */
const SETTLE_MS = 10_000;

/** Durasi kelas `is-pulsing` (ring berdenyut) setelah scanner benar-benar mulai/berhenti. */
const PULSE_MS = 1_400;

/**
 * Pelacak peralihan aktif ↔ tidak aktif dari state supervisor NYATA (respons API). Hanya peralihan yang menjalankan
 * efek: state awal halaman tidak memicu apa pun, sehingga navigasi tidak menghasilkan pulsa palsu.
 * Peralihan → event global `lr:activity` (accent; level 0.8 saat berjalan, 0.25 saat berhenti) yang diteruskan app.js ke
 * animasi latar, plus kelas `is-pulsing` sesaat pada `el` (ring berdenyut di CSS).
 * @param {HTMLElement} el
 * @returns {(status: object|null) => void}
 */
function activityTracker(el) {
  let last = null;
  let pulseTimer = null;
  return (status) => {
    const active = isWorkerActive(status);
    el.dataset.active = String(active);
    if (status?.state) el.dataset.workerState = status.state;
    if (last === null || last === active) {
      last = active;
      return;
    }
    last = active;
    window.dispatchEvent(new CustomEvent('lr:activity', { detail: { kind: 'accent', level: active ? 0.8 : 0.25 } }));
    el.classList.remove('is-pulsing');
    // Reflow agar animasi dapat diulang bila peralihan terjadi beruntun.
    void el.offsetWidth;
    el.classList.add('is-pulsing');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => el.classList.remove('is-pulsing'), PULSE_MS);
  };
}

/** Pesan error yang dapat dipahami pengguna; pesan server (Bahasa Indonesia) dipakai bila ada. */
export function workerErrorMessage(err) {
  if (!(err instanceof ApiError)) return 'Server tidak dapat dihubungi. Coba lagi.';
  if (err.code === 'CSRF_INVALID') return 'Token keamanan sesi kedaluwarsa. Muat ulang halaman lalu coba lagi.';
  if (err.status === 403) return 'Hanya admin yang dapat menjalankan atau menghentikan scanner.';
  return err.message || 'Permintaan gagal. Coba lagi.';
}

/**
 * Bar progres indeterminate (animasi) selama perintah scanner diproses: request berjalan, state memulai/menghentikan,
 * dan jendela pemantauan sesaat setelah start. Tanpa persentase, karena durasi spawn/stop tidak diketahui.
 */
function progressBar(testid) {
  return h('div', {
    class: 'progress-indeterminate', role: 'progressbar', 'aria-label': 'Memproses perintah scanner', hidden: true, 'data-testid': testid,
  });
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
  let settleUntil = 0;
  const settling = () => status?.state === 'running' && Date.now() < settleUntil;

  const stateEl = h('div', { class: 'worker-control__state', 'aria-live': 'polite', 'data-testid': 'worker-control-state' });
  const progressEl = progressBar('worker-control-progress');
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

  const body = h('div', { class: 'worker-control', tabindex: '-1' }, stateEl, progressEl, descEl, controls, confirmEl, errorEl);
  const el = panel({ title: 'Kontrol scanner', id: 'worker-control' }, body);
  body.classList.add('scan-control');
  body.append(h('span', { class: 'scan-control__line', 'aria-hidden': 'true' }));
  const track = activityTracker(body);

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
    track(status);
    body.setAttribute('aria-busy', String(pending || isWorkerTransitional(status)));
    progressEl.hidden = !(pending || isWorkerTransitional(status) || settling());
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
    if (disposed || pollTimer !== null || !(isWorkerTransitional(status) || settling())) return;
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
      settleUntil = action === 'start' ? Date.now() + SETTLE_MS : 0;
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

/** Isi pesan kontrol persisten (Overview, LONG/SHORT Scanner) untuk state supervisor. */
function barMessage(status, isAdmin) {
  if (canStartWorker(status)) {
    const crashed = status.state === 'crashed';
    const parts = [
      h('strong', null, crashed ? `Scanner berhenti tak terduga — ${workerControlLabel(status).text}.` : 'Scanner belum berjalan.'),
      ' Data pasar dan sinyal tidak diperbarui.',
    ];
    // replaceChildren() mengubah null menjadi teks "null": bagian opsional ditambahkan hanya bila ada.
    if (!isAdmin) parts.push(' Minta admin menjalankannya dari System Health.');
    return parts;
  }
  switch (status?.state) {
    case 'running':
      return [h('strong', null, 'Scanner berjalan.'), ' Satu worker memindai LONG dan SHORT dari candle yang sama. Data mulai diperbarui setelah discovery & backfill selesai.'];
    case 'starting':
      return [h('strong', null, 'Scanner sedang dimulai…')];
    case 'stopping':
      return [h('strong', null, 'Scanner sedang dihentikan…'), ' Menunggu tugas aktif selesai (maks. 15 detik).'];
    case 'external':
      return [h('strong', null, 'Scanner berjalan di luar website.'), ' Hentikan dari terminal tempat npm run worker dijalankan.'];
    default:
      return [h('strong', null, 'Status scanner tidak diketahui.'), ' Periksa System Health.'];
  }
}

/**
 * Saat state stabil, kontrol tetap menyegarkan state (latar) dengan jeda panjang: Overview dan halaman Scanner tidak
 * punya auto-refresh, dan pill yang dibiarkan terbuka lama tidak boleh terus menyatakan "Berjalan" bila worker crash.
 */
const STEADY_POLL_MS = 30_000;
/** State berlabel "Hentikan scanner" (aktif hanya saat 'running'); state lain berlabel "Jalankan scanner". */
const STOP_LABEL_STATES = new Set(['running', 'starting', 'external']);

/**
 * Kontrol scanner persisten untuk Overview, LONG Scanner, dan SHORT Scanner: pill state + satu tombol toggle.
 * Elemen TIDAK PERNAH dilepas dari halaman selama WORKER_CONTROL aktif — tombol hanya berganti label dan status:
 * - "Jalankan scanner" bila scanner dapat dijalankan (berhenti/crash);
 * - "Hentikan scanner" saat berjalan, dengan konfirmasi inline seperti kartu System Health (role=group, fokus ke
 *   Batal, Esc menutup);
 * - tetap tampil tetapi nonaktif (dengan bar progres) selama request, state memulai/menghentikan, dan SETTLE_MS
 *   pemantauan setelah start; state 'external' menampilkan penjelasan dengan tombol nonaktif.
 * Tombol nonaktif memakai aria-disabled (bukan atribut disabled) sehingga tetap dapat difokus: fokus keyboard tidak
 * jatuh ke <body> saat label/state berubah. Analyst hanya melihat pill dan pesan, tanpa tombol.
 * Satu worker memindai LONG dan SHORT dari candle yang sama, sehingga satu kontrol mencakup kedua arah.
 * Saat scanner berjalan, baris proses sync ringkas (syncProgressInline) menampilkan langkah yang sedang berjalan —
 * sinkron jam, discovery, backfill x/y seri, lalu Live — dengan tautan ke panel lengkap di System Health. Baris itu
 * hanya tampil bila umpan sync (GET /api/system/sync) sudah melaporkan state supervisor yang sama dengan kontrol, dan
 * snapshot supervisor dari umpan itu (dibaca tiap 2–10 detik) diadopsi bila berbeda (onSyncData): pesan/tombol kontrol
 * dan baris sync tidak pernah saling bertentangan, dan worker yang crash tampil dalam ≤10 detik walau kontrol sendiri
 * hanya membaca ulang tiap STEADY_POLL_MS saat stabil.
 * Selama transisi/pemantauan GET /api/system/worker dipantau tiap POLL_MS (latar), selain itu tiap STEADY_POLL_MS.
 * Halaman pemakainya tidak punya cleanup: polling berhenti sendiri bila elemen sudah tidak ada di halaman. Karena itu
 * elemen dibuat setelah seluruh await view selesai, tepat sebelum halaman dipasang.
 * `onState(status)` (opsional) dipanggil setiap render dengan snapshot supervisor nyata yang sedang ditampilkan — dipakai
 * halaman scanner untuk radar header dan untuk memutuskan apakah daftar kandidat perlu disegarkan.
 * @param {{ user: { role: string }, status: object|null, onState?: (status: object) => void }} options
 * @returns {HTMLElement|null} null hanya bila kontrol dari website nonaktif (WORKER_CONTROL=false) atau status gagal dibaca.
 */
export function workerControlBar({ user, status: initial, onState }) {
  if (!initial?.enabled) return null;
  const isAdmin = user?.role === 'admin';
  let status = initial;
  let pending = false;
  let confirming = false;
  let settleUntil = 0;
  let pollTimer = null;
  // Naik setiap kali perintah dikirim: respons polling yang dimulai sebelum perintah itu dianggap basi.
  let epoch = 0;
  // Waktu (Date.now()) request yang menghasilkan `status` dikirim; 0 untuk status awal halaman. Snapshot dari request
  // yang dikirim lebih dulu tidak boleh menimpa yang dikirim belakangan, apa pun sumbernya (urutan respons tidak dijamin).
  let statusAt = 0;
  // State supervisor terakhir menurut umpan sync (onSyncData); baris sync tampil hanya bila sama dengan `status`.
  let syncState = null;
  let shownKey = '';
  const settling = () => status?.state === 'running' && Date.now() < settleUntil;
  const busy = () => pending || isWorkerTransitional(status) || settling();
  const toggleAction = () => {
    if (canStartWorker(status)) return 'start';
    return status?.state === 'running' ? 'stop' : null;
  };

  const stateEl = h('div', { class: 'worker-bar__state', 'data-testid': 'worker-callout-state' });
  const message = h('p', { id: 'worker-bar-message', 'aria-live': 'polite', 'data-testid': 'worker-callout-message' });
  const progressEl = progressBar('worker-callout-progress');
  const errorEl = h('p', { class: 'field__error', role: 'alert', hidden: true });
  // Proses sync ringkas (langkah + bar + x/y seri, lalu Live · candle terakhir) dan tautan ke panel lengkap di System
  // Health. Varian ringkas syncProgress.js memantau GET /api/system/sync sendiri (latar) dan berhenti saat kontrol
  // dilepas — tanpa cleanup. Disembunyikan selama scanner dapat dijalankan (berhenti/crash) agar pesan tidak ganda,
  // dan sampai umpan sync melaporkan state supervisor yang sama dengan kontrol (render/onSyncData).
  const syncRow = h('div', { class: 'cluster callout__sync', 'data-testid': 'worker-callout-sync', hidden: true },
    syncProgressInline({ initial: null, onData: (d) => onSyncData(d) }),
    h('a', { href: '#/health' }, 'Lihat proses sync di System Health'));
  const content = h('div', { class: 'callout__content' }, stateEl, message, progressEl, syncRow, errorEl);
  const el = callout([content]);
  el.classList.add('callout--action', 'worker-bar', 'scan-control');
  el.dataset.testid = 'worker-callout';
  // Garis scan dekoratif (bergerak di CSS hanya saat data-active="true" = scanner benar-benar berjalan).
  el.prepend(h('span', { class: 'scan-control__line', 'aria-hidden': 'true' }));
  const track = activityTracker(el);

  const toggle = isAdmin
    ? h('button', { class: 'btn btn--sm btn--primary', type: 'button', 'aria-describedby': 'worker-bar-message', on: { click: () => onToggle() } }, 'Jalankan scanner')
    : null;
  const confirmBtn = h('button', { class: 'btn btn--sm btn--danger', type: 'button', on: { click: () => confirmStop() } }, 'Ya, hentikan');
  const cancelBtn = h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => closeConfirm() } }, 'Batal');
  const confirmEl = h('div', {
    class: 'worker-control__confirm worker-bar__confirm', role: 'group', 'aria-labelledby': 'worker-bar-confirm-text', hidden: true,
    on: { keydown: (e) => { if (e.key === 'Escape') closeConfirm(); } },
  },
  h('p', { id: 'worker-bar-confirm-text' }, 'Hentikan scanner? Ingesti candle dan analisis pola LONG & SHORT berhenti sampai dijalankan lagi.'),
  h('div', { class: 'cluster' }, confirmBtn, cancelBtn));
  if (isAdmin) el.append(toggle, confirmEl);
  // Analyst tidak punya tombol: callout dapat menerima fokus (tabindex -1) saat baris sync yang sedang difokus disembunyikan.
  if (!toggle) el.setAttribute('tabindex', '-1');

  function showError(text) {
    errorEl.textContent = text ?? '';
    errorEl.hidden = !text;
  }

  function render() {
    // Wilayah aria-live hanya diganti saat state berubah, agar refresh berkala tidak diumumkan ulang.
    const key = `${status?.state}|${workerControlLabel(status).text}`;
    if (key !== shownKey) {
      shownKey = key;
      stateEl.replaceChildren(workerControlPill(status));
      message.replaceChildren(...barMessage(status, isAdmin));
    }
    track(status);
    if (onState) onState(status);
    const crashed = status?.state === 'crashed';
    el.classList.toggle('callout--bear', crashed);
    el.classList.toggle('callout--warn', !crashed && canStartWorker(status));
    el.setAttribute('aria-busy', String(busy()));
    progressEl.hidden = !busy();
    // Baris sync hanya saat scanner tidak dapat dijalankan DAN umpan sync sudah melihat state yang sama (onSyncData).
    const hideSync = canStartWorker(status) || syncState !== status?.state;
    // Fokus di dalam baris yang akan disembunyikan (tautan System Health) dipindahkan dulu agar tidak jatuh ke <body>.
    if (hideSync && !syncRow.hidden && syncRow.contains(document.activeElement)) (toggle ?? el).focus({ preventScroll: true });
    syncRow.hidden = hideSync;
    if (!toggle) return;
    const stopLabel = STOP_LABEL_STATES.has(status?.state);
    const label = stopLabel ? 'Hentikan scanner' : 'Jalankan scanner';
    if (toggle.textContent !== label) toggle.textContent = label;
    toggle.classList.toggle('btn--danger', stopLabel);
    toggle.classList.toggle('btn--primary', !stopLabel);
    toggle.setAttribute('aria-disabled', String(busy() || confirming || toggleAction() === null));
    confirmBtn.disabled = pending;
    cancelBtn.disabled = pending;
    if (confirming && status?.state !== 'running') closeConfirm({ restoreFocus: false });
  }

  /**
   * Umpan sync (GET /api/system/sync, dipantau syncProgressInline tiap 2–10 detik) memuat snapshot supervisor yang sama
   * dengan GET /api/system/worker dan jauh lebih sering dibaca daripada polling kontrol saat stabil (STEADY_POLL_MS).
   * State yang berbeda diadopsi agar pesan/tombol kontrol dan baris sync tidak bertentangan — worker yang crash tampil
   * dalam ≤10 detik, bukan ≤30. Diabaikan selama perintah berjalan dan untuk respons yang diminta sebelum `status` ini.
   */
  function onSyncData(d) {
    if (pending || typeof d.worker?.state !== 'string' || !(d.requestedAt > statusAt)) return;
    syncState = d.worker.state;
    const changed = syncState !== status?.state;
    if (changed) {
      status = d.worker;
      statusAt = d.requestedAt;
    }
    render();
    if (changed) schedulePoll();
  }

  function onToggle() {
    if (toggle.getAttribute('aria-disabled') === 'true') return;
    const action = toggleAction();
    if (action === 'start') run('start');
    else if (action === 'stop') openConfirm();
  }

  function openConfirm() {
    confirming = true;
    confirmEl.hidden = false;
    render();
    cancelBtn.focus();
  }

  function closeConfirm({ restoreFocus = true } = {}) {
    // Fokus di dalam konfirmasi yang disembunyikan dikembalikan ke tombol toggle (tidak hilang ke <body>).
    const hadFocus = confirmEl.contains(document.activeElement);
    confirming = false;
    confirmEl.hidden = true;
    render();
    if (restoreFocus || hadFocus) toggle.focus({ preventScroll: true });
  }

  function confirmStop() {
    if (pending) return;
    // Konfirmasi ditutup lebih dulu; tombol toggle (nonaktif selama request, tetap dapat difokus) menerima fokus.
    closeConfirm();
    run('stop');
  }

  async function run(action) {
    if (pending) return;
    pending = true;
    epoch += 1;
    showError(null);
    render();
    try {
      status = await api(`/api/system/worker/${action}`, { method: 'POST' });
      // Respons perintah selalu berlaku: snapshot apa pun yang diminta sebelum perintah selesai sudah basi.
      statusAt = Date.now();
      settleUntil = action === 'start' ? Date.now() + SETTLE_MS : 0;
      toast(action === 'start' ? 'Scanner dijalankan' : 'Scanner sedang dihentikan', 'bull');
      // Proses sync dipantau cepat (tiap 2 detik) agar langkah pertama langsung terlihat.
      requestSyncRefresh();
    } catch (err) {
      // Termasuk 429 WORKER_COOLDOWN (jeda start ulang) dan 409 WORKER_EXTERNAL: pesan server ditampilkan apa adanya.
      showError(workerErrorMessage(err));
      try {
        status = await api('/api/system/worker');
        statusAt = Date.now();
      } catch {
        // State terakhir yang diketahui tetap ditampilkan.
      }
    } finally {
      pending = false;
      render();
      schedulePoll();
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    const delay = isWorkerTransitional(status) || settling() ? POLL_MS : STEADY_POLL_MS;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      // Overview/Scanner tidak punya cleanup: berhenti sendiri bila kontrol sudah tidak ada di halaman.
      // Selama perintah berjalan, run() menjadwalkan ulang setelah selesai.
      if (!el.isConnected || pending) return;
      const started = epoch;
      const sentAt = Date.now();
      try {
        // Polling otomatis bukan aktivitas pengguna: tidak memperpanjang idle timeout sesi.
        const next = await api('/api/system/worker', { background: true });
        if (started !== epoch) return; // perintah baru dikirim selama polling: respons ini basi
        // Umpan sync mungkin sudah memberi snapshot dari request yang lebih baru (onSyncData): itu yang dipertahankan.
        if (sentAt >= statusAt) {
          status = next;
          statusAt = sentAt;
        }
        render();
      } catch {
        if (started !== epoch) return;
        // Coba lagi pada putaran berikutnya.
      }
      if (el.isConnected) schedulePoll();
    }, delay);
  }

  render();
  schedulePoll();
  return el;
}

/**
 * @deprecated Nama lama callout Overview; kini kontrol persisten yang sama (lihat workerControlBar).
 * @param {{ user: { role: string }, status: object|null }} options
 * @returns {HTMLElement|null}
 */
export const workerStartCallout = (options) => workerControlBar(options);
