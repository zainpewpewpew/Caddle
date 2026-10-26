// Sinkronisasi smart money manual di halaman Smart Money Radar: tombol "Sync sekarang" (aksi header) + status tepat di
// bawah header. Kontrak: GET /api/smart-money/sync (semua pengguna yang login) → { running, run, lastRun, canTrigger,
// reason, cooldownUntil, providersConfigured, intervalMinutes }; POST /api/smart-money/sync (admin + CSRF, tanpa body) →
// 202 { started, run } | 409 SYNC_RUNNING (+run: ikut memantau run itu) | 409 NO_PROVIDERS | 429 SYNC_COOLDOWN
// (+retryAfterMs: hitung mundur) | 403 FORBIDDEN / CSRF_INVALID | 429 RATE_LIMITED.
// - GET sekali saat dibuat: run yang sedang berjalan (biasanya putaran terjadwal worker scanner) langsung dipantau.
// - Klik → POST, lalu GET tiap 1,5 detik selama run berjalan (polling LATAR: tidak memperpanjang idle timeout sesi),
//   dibatasi 15 menit. Run selesai → ringkasan hasil (badge status, angka, ≤ 3 catatan, ≤ 3 error) yang tetap tampil
//   sampai klik berikutnya atau "Tutup", lalu onFinished() (radar dimuat ulang dengan filter & tampilan saat ini).
// - Timer berhenti sendiri begitu elemen dilepas dari halaman (pindah route), seperti kontrol scanner persisten
//   (workerControl.js) dan panel proses sync (syncProgress.js) — view radar tidak memerlukan cleanup; cleanup() ada.
// - Wilayah status aria-live="polite" hanya mengumumkan fase, pesan, dan hasil: angka x/y dan lama berjalan (berubah
//   tiap polling) disembunyikan dari pembaca layar dan tersedia lewat progressbar "Progres sinkronisasi".
// Semua teks dari server (catatan, pesan error) lewat h()/textContent.
import { ApiError, api } from '../lib/api.js';
import { badge, callout } from '../lib/components.js';
import { h, icon } from '../lib/dom.js';
import { formatDuration, formatInteger, formatRelative, formatUtc } from '../lib/format.js';
import {
  EMPTY, SM_API, SYNC_NOT_ADMIN, SYNC_NO_WALLETS_HINT, SYNC_POLL_CAP_MINUTES, isSyncResultOf, syncAutoHint, syncCooldownText,
  syncErrorText, syncProgressParts, syncProgressRatio, syncResultLines, syncRunnerLabel, syncStatusLabel,
} from './smartMoneyFormat.js';

export const SYNC_PATH = `${SM_API}/sync`;
/** Jeda GET selama run berjalan. */
export const SYNC_POLL_MS = 1_500;
const POLL_CAP_MS = SYNC_POLL_CAP_MINUTES * 60_000;
const TICK_MS = 1_000;
/** Elemen yang tidak pernah terpasang di halaman selama ini dianggap dibuang (view basi): timer berhenti. */
const MOUNT_GRACE_MS = 5_000;
/** Kegagalan GET beruntun saat memantau sebelum pesan ditampilkan (polling tetap berjalan). */
const POLL_FAILURES_SHOWN = 3;
const LIST_MAX = 3;
const HINT_ID = 'sm-sync-hint';
const BAR_LABEL = 'Progres sinkronisasi';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Payload GET /sync → bentuk tetap (field hilang atau salah tipe → null/false). */
function normalizeStatus(d) {
  if (!isObj(d)) return null;
  return {
    running: d.running === true,
    run: isObj(d.run) ? d.run : null,
    lastRun: isObj(d.lastRun) ? d.lastRun : null,
    canTrigger: d.canTrigger === true,
    reason: typeof d.reason === 'string' && d.reason ? d.reason : null,
    cooldownUntil: isNum(d.cooldownUntil) ? d.cooldownUntil : null,
    intervalMinutes: isNum(d.intervalMinutes) ? d.intervalMinutes : null,
  };
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** Rincian kegagalan request untuk pesan: 'pesan server (KODE)', respons tidak valid, atau penanda jaringan. */
function errorDetail(err) {
  if (!(err instanceof ApiError)) {
    // fetch() melempar TypeError saat jaringan gagal; Error lain berasal dari respons yang tidak sesuai kontrak.
    return err instanceof TypeError || typeof err?.message !== 'string' || !err.message ? 'server tidak dapat dihubungi' : err.message;
  }
  const message = String(err.message ?? '').replace(/\.+$/, '');
  return err.code && err.code !== 'UNKNOWN' ? `${message} (${err.code})` : message;
}

const resultKey = (r) => `${r.status}|${r.startedAt}|${r.finishedAt}`;

// ---------------------------------------------------------------- progres

/** Bar progres: 'ratio' (determinate, done/total) atau 'busy' (indeterminate). Kelas global components.css. */
function makeBar(kind) {
  if (kind === 'ratio') {
    return h('div', {
      class: 'sync-bar sm-sync__meter', role: 'progressbar', 'aria-label': BAR_LABEL, 'aria-valuemin': 0, dataset: { kind },
    }, h('span', { class: 'sync-bar__fill' }));
  }
  return h('div', { class: 'progress-indeterminate sm-sync__meter', role: 'progressbar', 'aria-label': BAR_LABEL, dataset: { kind } });
}

/** Kotak progres satu run: dibuat sekali, diperbarui di tempat (bar dibuat ulang hanya bila jenisnya berubah). */
function createProgress() {
  const barSlot = h('div', { class: 'sm-sync__barslot' });
  const phase = h('span', { class: 'sm-sync__phase' });
  // Berubah tiap polling: tidak diumumkan ulang (angka tersedia di progressbar).
  const count = h('span', { class: 'num', 'aria-hidden': 'true' });
  const elapsed = h('span', { class: 'num', 'aria-hidden': 'true' });
  const runner = h('span');
  const line = h('p', { class: 'sm-sync__line', 'data-testid': 'sm-sync-progress' }, phase, count, elapsed, runner);
  const el = h('div', { class: 'sm-sync__progress sm-sync__block' }, barSlot, line);
  return {
    el,
    update(run, now) {
      const parts = syncProgressParts(run, now);
      setText(phase, parts.phase);
      setText(count, parts.count ? ` · ${parts.count}` : '');
      setText(elapsed, parts.elapsed ? ` · ${parts.elapsed}` : '');
      setText(runner, parts.runner ? ` · ${parts.runner}` : '');
      const ratio = syncProgressRatio(run);
      const kind = ratio === null ? 'busy' : 'ratio';
      let bar = barSlot.firstElementChild;
      if (bar?.dataset.kind !== kind) {
        bar = makeBar(kind);
        barSlot.replaceChildren(bar);
      }
      if (kind === 'ratio') {
        const unit = run.phase === 'transfers' ? ' wallet' : '';
        bar.setAttribute('aria-valuemax', String(run.total));
        bar.setAttribute('aria-valuenow', String(Math.min(Math.max(run.done, 0), run.total)));
        bar.setAttribute('aria-valuetext', `${formatInteger(run.done)} dari ${formatInteger(run.total)}${unit}`);
        bar.firstElementChild.style.setProperty('--lr-sync-pct', String(Math.floor(ratio * 100)));
      }
    },
  };
}

// ---------------------------------------------------------------- hasil

function errorItem(e) {
  const meta = [e.provider, e.code].filter((v) => typeof v === 'string' && v).join(' · ') || 'internal';
  return h('li', null,
    h('span', { class: 'sync-errors__meta mono' }, meta),
    h('span', { class: 'sync-errors__msg' }, typeof e.message === 'string' && e.message ? e.message : EMPTY));
}

/** Daftar berjudul dengan paling banyak LIST_MAX butir + "+N … lain". */
function listGroup(title, items, render, noun, className) {
  if (!items.length) return null;
  return h('div', { class: 'sm-sync__group' },
    h('p', { class: 'sm-k' }, title),
    h('ul', { class: className }, items.slice(0, LIST_MAX).map(render)),
    items.length > LIST_MAX && h('p', { class: 'subtle' }, `+${formatInteger(items.length - LIST_MAX)} ${noun} lain`));
}

/**
 * Ringkasan satu run (`lastRun`): <details> dengan badge status, waktu, durasi, baris angka, catatan, dan error.
 * observed: hasil run yang baru dipantau (terbuka, dengan tombol Tutup); selain itu ringkasan run terakhir (tertutup).
 */
function resultDetails(lastRun, { now, observed, onDismiss }) {
  const st = syncStatusLabel(lastRun.status);
  const at = isNum(lastRun.finishedAt) ? lastRun.finishedAt : isNum(lastRun.startedAt) ? lastRun.startedAt : null;
  const took = isNum(lastRun.finishedAt) && isNum(lastRun.startedAt) && lastRun.finishedAt >= lastRun.startedAt
    ? formatDuration((lastRun.finishedAt - lastRun.startedAt) / 1000) : null;
  const runner = lastRun.trigger === 'manual' || lastRun.trigger === 'schedule' ? syncRunnerLabel({ trigger: lastRun.trigger }) : null;
  const lines = syncResultLines(lastRun);
  const notes = (Array.isArray(lastRun.notes) ? lastRun.notes : []).filter((t) => typeof t === 'string' && t);
  const errors = (Array.isArray(lastRun.errors) ? lastRun.errors : []).filter(isObj);
  const summary = h('summary', { class: 'sm-sync__summary' },
    h('span', { class: 'sm-sync__title' }, observed ? 'Sinkronisasi selesai' : 'Hasil sinkron terakhir'),
    badge(st.label, st.tone),
    at !== null && h('span', { class: 'subtle', title: formatUtc(at) }, formatRelative(at, now)),
    took && h('span', { class: 'subtle' }, `durasi ${took}`),
    runner && h('span', { class: 'subtle' }, runner));
  const body = h('div', { class: 'sm-sync__body' },
    lines.length > 0 && h('ul', { class: 'sm-sync__lines' }, lines.map((t) => h('li', { 'data-hint': t === SYNC_NO_WALLETS_HINT || undefined }, t))),
    listGroup('Catatan', notes, (t) => h('li', null, t), 'catatan', 'sm-sync__notes'),
    listGroup('Error', errors, errorItem, 'error', 'sync-errors sm-sync__errors'),
    !lines.length && !notes.length && !errors.length && h('p', { class: 'subtle' }, 'Tidak ada rincian hasil.'),
    onDismiss && h('div', null, h('button', { class: 'btn btn--sm btn--ghost', type: 'button', on: { click: onDismiss } },
      icon('close', 'btn__icon'), 'Tutup')));
  return h('details', {
    class: 'sm-sync__result sm-sync__block', 'data-tone': st.tone ?? 'neutral', 'data-status': lastRun.status ?? '',
    'data-testid': observed ? 'sm-sync-result' : 'sm-sync-last', open: observed,
  }, summary, body);
}

// ---------------------------------------------------------------- komponen

/**
 * Kontrol sinkronisasi manual Smart Money Radar.
 * @param {{ user?: { role?: string }|null, onFinished?: (lastRun: object|null) => void }} [options]
 *   user: pengguna sesi (ctx.user), hanya cadangan sebelum/bila GET gagal — `canTrigger`/`reason` server yang berlaku.
 *   onFinished: dipanggil setiap kali run yang dipantau selesai (manual maupun terjadwal yang sedang berjalan), dengan
 *   ringkasannya (null bila run berakhir tanpa ringkasan baru).
 * @returns {{ button: HTMLButtonElement, el: HTMLElement, cleanup: () => void }} button untuk aksi header halaman;
 *   el (petunjuk, progres, hasil) dipasang tepat di bawah header.
 */
export function syncControl({ user, onFinished } = {}) {
  const role = typeof user?.role === 'string' ? user.role : null;
  const fallbackReason = role !== null && role !== 'admin' ? 'NOT_ADMIN' : null;
  let loading = true;
  let pending = false;
  let running = false;
  let run = null;
  let watchedStart = null;
  let pollSince = 0;
  let pollFailures = 0;
  let inflight = false;
  let canTrigger = fallbackReason === null;
  let reason = fallbackReason;
  let cooldownUntil = null;
  let intervalMinutes = null;
  let lastRun = null;
  let result = null;
  let notice = null;
  let progress = null;
  let pollTimer = null;
  let tickTimer = null;
  // Naik setiap kali POST dikirim: respons GET yang diminta sebelumnya basi.
  let epoch = 0;
  let disposed = false;
  let mounted = false;
  const createdAt = Date.now();

  const button = h('button', {
    class: 'btn btn--sm btn--neural sm-sync__btn', type: 'button', 'aria-describedby': HINT_ID, 'data-testid': 'sm-sync-button',
    on: { click: () => { trigger(); } },
  }, icon('refresh', 'btn__icon'), 'Sync sekarang');

  const hintText = h('span');
  const reasonText = h('span', { class: 'sm-sync__reason', hidden: true });
  const waitText = h('span', { class: 'sm-sync__wait num', hidden: true, 'data-testid': 'sm-sync-cooldown' });
  const hint = h('p', { class: 'sm-sync__hint', id: HINT_ID }, hintText, reasonText, waitText);
  // Slot selalu ada di wilayah live (konten disisipkan/dilepas di dalamnya) agar pengumuman andal.
  const helpSlot = h('div', { class: 'sm-sync__slot' });
  const noticeSlot = h('div', { class: 'sm-sync__slot' });
  const progressSlot = h('div', { class: 'sm-sync__slot' });
  const resultSlot = h('div', { class: 'sm-sync__slot' });
  const live = h('div', { class: 'sm-sync__live', 'aria-live': 'polite', 'data-testid': 'sm-sync-status' },
    helpSlot, noticeSlot, progressSlot, resultSlot);
  // Ringkasan run terakhir saat halaman dibuka: di luar wilayah live (tidak diumumkan tiap kunjungan).
  const lastSlot = h('div', { class: 'sm-sync__slot' });
  const el = h('div', { class: 'sm-sync', 'data-testid': 'sm-sync', 'data-state': 'loading' }, hint, live, lastSlot);

  const blockReason = () => (canTrigger ? null : reason ?? 'UNAVAILABLE');

  function buttonTitle(block, cooling, now) {
    if (loading) return 'Memeriksa status sinkronisasi…';
    // NO_PROVIDERS didahulukan: berlaku untuk semua peran.
    if (block === 'NO_PROVIDERS') return 'Belum ada sumber data aktif — isi ETHERSCAN_API_KEY di .env lalu jalankan ulang server';
    if (block === 'NOT_ADMIN') return SYNC_NOT_ADMIN;
    if (block) return 'Sinkronisasi manual tidak tersedia';
    if (pending) return 'Mengirim permintaan sinkronisasi…';
    if (running) return 'Sinkronisasi sedang berjalan';
    if (cooling) return syncCooldownText(cooldownUntil - now);
    return 'Jalankan sinkronisasi smart money sekarang tanpa menunggu jadwal';
  }

  function renderSlot(slot, key, build) {
    if ((slot.dataset.key ?? '') === key) return;
    slot.dataset.key = key;
    slot.replaceChildren(...(key ? [build()] : []));
  }

  function render() {
    const now = Date.now();
    if (cooldownUntil !== null && cooldownUntil <= now) {
      cooldownUntil = null;
      if (notice?.code === 'SYNC_COOLDOWN') notice = null;
    }
    const block = blockReason();
    const cooling = cooldownUntil !== null && !running;
    button.setAttribute('aria-disabled', String(loading || pending || running || block !== null || cooling));
    button.dataset.busy = String(pending || running);
    button.title = buttonTitle(block, cooling, now);

    setText(hintText, syncAutoHint(intervalMinutes));
    // Alasan ditampilkan setelah status server dibaca (sebelum itu peran sesi hanya tebakan cadangan).
    const why = loading ? '' : block === 'NO_PROVIDERS' ? 'Belum ada sumber data aktif'
      : block === 'NOT_ADMIN' ? SYNC_NOT_ADMIN : block ? 'Sinkronisasi manual tidak tersedia' : '';
    setText(reasonText, why ? ` · ${why}` : '');
    reasonText.hidden = !why;
    const wait = cooling ? syncCooldownText(cooldownUntil - now) : '';
    setText(waitText, wait ? ` · ${wait}` : '');
    waitText.hidden = !wait;

    renderSlot(helpSlot, block === 'NO_PROVIDERS' ? 'NO_PROVIDERS' : '', () => {
      const box = callout(syncErrorText('NO_PROVIDERS'), 'warn');
      box.classList.add('sm-sync__help', 'sm-sync__block');
      box.dataset.testid = 'sm-sync-help';
      return box;
    });
    renderSlot(noticeSlot, notice ? `${notice.tone}|${notice.text}` : '', () => h('p', {
      class: 'sm-sync__notice sm-sync__block', 'data-tone': notice.tone, 'data-code': notice.code, 'data-testid': 'sm-sync-notice',
    }, notice.text));
    if (running) {
      if (!progress) {
        progress = createProgress();
        progressSlot.replaceChildren(progress.el);
      }
      progress.update(run ?? {}, now);
    } else if (progress) {
      progress = null;
      progressSlot.replaceChildren();
    }
    renderSlot(resultSlot, result ? resultKey(result) : '', () => resultDetails(result, { now, observed: true, onDismiss: dismiss }));
    const showLast = lastRun !== null && !result && !running && !pending;
    renderSlot(lastSlot, showLast ? resultKey(lastRun) : '', () => resultDetails(lastRun, { now, observed: false }));

    el.dataset.state = loading ? 'loading' : pending ? 'pending' : running ? 'running' : block ? 'blocked'
      : cooling ? 'cooldown' : result ? 'finished' : 'idle';
  }

  /** Masih layak menjalankan timer: terpasang di halaman, atau baru dibuat dan belum sempat dipasang router. */
  function alive() {
    if (disposed) return false;
    if (el.isConnected || button.isConnected) {
      mounted = true;
      return true;
    }
    if (!mounted && Date.now() - createdAt < MOUNT_GRACE_MS) return true;
    cleanup();
    return false;
  }

  function schedule() {
    clearTimeout(pollTimer);
    clearTimeout(tickTimer);
    pollTimer = null;
    tickTimer = null;
    if (disposed) return;
    if (running && !pending) pollTimer = setTimeout(poll, SYNC_POLL_MS);
    if (cooldownUntil !== null && !running) tickTimer = setTimeout(tick, Math.min(TICK_MS, Math.max(0, cooldownUntil - Date.now())));
  }

  function tick() {
    tickTimer = null;
    if (!alive()) return;
    render();
    schedule();
  }

  function startWatching(nextRun) {
    running = true;
    run = isObj(nextRun) ? nextRun : null;
    watchedStart = isNum(run?.startedAt) ? run.startedAt : null;
    pollSince = Date.now();
    pollFailures = 0;
    result = null;
  }

  function finish(summary) {
    running = false;
    run = null;
    const fresh = isSyncResultOf(summary, watchedStart);
    watchedStart = null;
    result = fresh ? summary : null;
    notice = fresh ? null : { code: 'NO_RESULT', tone: 'neutral', text: syncErrorText('NO_RESULT') };
    try {
      onFinished?.(fresh ? summary : null);
    } catch {
      // Kegagalan pemuatan ulang milik pemanggil tidak boleh menghentikan kontrol ini.
    }
  }

  /** Terapkan status GET: izin, jeda, interval, dan peralihan berjalan ↔ selesai. */
  function apply(next) {
    canTrigger = next.canTrigger;
    reason = next.reason;
    intervalMinutes = next.intervalMinutes;
    cooldownUntil = next.cooldownUntil !== null && next.cooldownUntil > Date.now() ? next.cooldownUntil : null;
    if (next.running) {
      if (!running) startWatching(next.run);
      else if (next.run) run = next.run;
    } else if (running) {
      finish(next.lastRun);
    }
    lastRun = next.lastRun;
  }

  async function load() {
    const started = epoch;
    try {
      const next = normalizeStatus(await api(SYNC_PATH, { background: true }));
      if (disposed || started !== epoch) return;
      if (!next) throw new Error('respons status tidak valid');
      apply(next);
    } catch (err) {
      if (disposed || started !== epoch || err?.status === 401) return;
      notice = { code: 'STATUS_FAILED', tone: 'warn', text: syncErrorText('STATUS_FAILED', { message: errorDetail(err) }) };
    } finally {
      if (!disposed && started === epoch) {
        loading = false;
        render();
        schedule();
      }
    }
  }

  async function poll() {
    pollTimer = null;
    if (!alive() || !running || inflight) return;
    if (Date.now() - pollSince >= POLL_CAP_MS) {
      // Status run tidak lagi diketahui: tombol aktif kembali (409 SYNC_RUNNING akan memantau ulang bila masih berjalan).
      running = false;
      run = null;
      watchedStart = null;
      notice = { code: 'POLL_TIMEOUT', tone: 'warn', text: syncErrorText('POLL_TIMEOUT') };
      render();
      schedule();
      return;
    }
    const started = epoch;
    inflight = true;
    let next = null;
    let failure = null;
    try {
      // Polling otomatis bukan aktivitas pengguna: tidak memperpanjang idle timeout sesi.
      next = normalizeStatus(await api(SYNC_PATH, { background: true }));
    } catch (err) {
      failure = err;
    } finally {
      inflight = false;
    }
    if (failure?.status === 401) {
      cleanup(); // api() sudah mengarahkan ke halaman login
      return;
    }
    if (disposed || started !== epoch) return;
    if (next) {
      pollFailures = 0;
      if (notice?.code === 'STATUS_FAILED') notice = null;
      apply(next);
    } else {
      pollFailures += 1;
      if (pollFailures >= POLL_FAILURES_SHOWN) {
        notice = { code: 'STATUS_FAILED', tone: 'warn', text: `${syncErrorText('STATUS_FAILED', { message: errorDetail(failure) })} Mencoba lagi…` };
      }
    }
    render();
    schedule();
  }

  /** Penolakan POST → pesan, dan untuk 409 SYNC_RUNNING ikut memantau run yang sedang berjalan. */
  function rejected(err) {
    const code = err instanceof ApiError ? err.code : 'NETWORK';
    const body = err instanceof ApiError && err.body ? err.body : {};
    switch (code) {
      case 'SYNC_RUNNING':
        startWatching(body.run);
        notice = { code, tone: 'info', text: syncErrorText(code) };
        return;
      case 'NO_PROVIDERS':
        // Penjelasan .env tampil di kotak bantuan (reason), bukan pesan terpisah.
        canTrigger = false;
        reason = 'NO_PROVIDERS';
        return;
      case 'SYNC_COOLDOWN': {
        const waitMs = isNum(body.retryAfterMs) && body.retryAfterMs > 0 ? body.retryAfterMs : null;
        if (waitMs !== null) cooldownUntil = Date.now() + waitMs;
        // Sisa waktu tampil sebagai hitung mundur di baris petunjuk; pesan ini tidak memuat angka yang menjadi basi.
        notice = { code, tone: 'warn', text: syncErrorText(code) };
        return;
      }
      case 'FORBIDDEN':
        canTrigger = false;
        if (reason !== 'NO_PROVIDERS') reason = 'NOT_ADMIN';
        notice = { code, tone: 'bear', text: syncErrorText(code) };
        return;
      default:
        notice = { code, tone: 'bear', text: syncErrorText(code, { message: err?.message, retryAfterMs: body.retryAfterMs }) };
    }
  }

  async function trigger() {
    if (disposed || pending || running || button.getAttribute('aria-disabled') === 'true') return;
    pending = true;
    epoch += 1;
    notice = null;
    result = null;
    render();
    try {
      const res = await api(SYNC_PATH, { method: 'POST' });
      if (!disposed) startWatching(res?.run);
    } catch (err) {
      if (!disposed && err?.status !== 401) rejected(err);
    } finally {
      pending = false;
      if (!disposed) {
        render();
        schedule();
      }
    }
  }

  /** "Tutup": hasil disembunyikan (tetap tersedia sebagai ringkasan tertutup); fokus kembali ke tombol Sync. */
  function dismiss() {
    result = null;
    render();
    button.focus({ preventScroll: true });
  }

  function cleanup() {
    disposed = true;
    clearTimeout(pollTimer);
    clearTimeout(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  render();
  load();
  return { button, el, cleanup };
}
