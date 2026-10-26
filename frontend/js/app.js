import { ApiError, api, setCsrfToken } from './lib/api.js';
import { toast } from './lib/components.js';
import { h, icon } from './lib/dom.js';
import { formatClockUtc } from './lib/format.js';
import { createRouter } from './lib/router.js';
import { backtestView } from './views/backtest.js';
import { designSystemView } from './views/designSystem.js';
import { healthView } from './views/health.js';
import { labView } from './views/lab.js';
import { overviewView } from './views/overview.js';
import { screenerView, shortScannerView } from './views/screener.js';
import { settingsView } from './views/settings.js';
import { signalsView } from './views/signals.js';
import { symbolView } from './views/symbol.js';

const NAV_KEY = 'lr.nav';
const MOTION_KEY = 'lr.motion';
const PULSE_KINDS = new Set(['bull', 'bear', 'accent']);

const ROUTES = [
  { section: 'Pasar' },
  { path: '/overview', label: 'Overview', icon: 'overview', view: overviewView },
  { path: '/screener', label: 'LONG Scanner', icon: 'screener', view: screenerView },
  { path: '/short-scanner', label: 'SHORT Scanner', icon: 'screener-short', view: shortScannerView },
  { path: '/symbol', label: 'Symbol Intelligence', icon: 'symbol', view: symbolView },
  { path: '/signals', label: 'Signal History', icon: 'signals', view: signalsView },
  { section: 'Riset' },
  { path: '/lab', label: 'Pattern Discovery Lab', icon: 'lab', view: labView },
  { path: '/backtest', label: 'Backtest Lab', icon: 'backtest', view: backtestView },
  { section: 'Sistem' },
  { path: '/settings', label: 'Pengaturan', icon: 'settings', view: settingsView },
  { path: '/health', label: 'System Health', icon: 'health', view: healthView },
  { path: '/design-system', label: 'Design System', icon: 'design', view: designSystemView },
];

const app = document.getElementById('app');
const sidebar = document.getElementById('sidebar');
const main = document.getElementById('main');
const nav = document.getElementById('nav');
const heading = document.getElementById('heading');
const crumb = document.getElementById('crumb');
const navOpen = document.getElementById('nav-open');
const collapseBtn = document.getElementById('nav-collapse');
const mobile = window.matchMedia('(max-width: 820px)');

const ctx = { user: null };
let cleanup = null;
// Nomor urut navigasi: view yang selesai dimuat setelah navigasi yang lebih baru dianggap basi.
let navSeq = 0;

function renderNav() {
  let section = '';
  nav.replaceChildren(...ROUTES.map((r) => {
    if (r.section) {
      section = r.section;
      return h('div', { class: 'nav__section' }, r.section);
    }
    r.crumb = section;
    return h('a', { class: 'nav__link', href: `#${r.path}`, 'data-path': r.path, title: r.label },
      icon(r.icon), h('span', { class: 'nav__label' }, r.label));
  }));
}

function setNavState(state) {
  app.dataset.nav = state;
  collapseBtn.setAttribute('aria-expanded', String(state !== 'collapsed'));
  // Laci mobile yang tertutup tidak boleh dapat difokus atau terbaca pembaca layar.
  sidebar.inert = mobile.matches && state !== 'open';
  navOpen.setAttribute('aria-expanded', String(state === 'open'));
  try {
    if (!mobile.matches) window.localStorage.setItem(NAV_KEY, state);
  } catch {
    // Penyimpanan lokal tidak tersedia — preferensi tidak disimpan.
  }
  document.querySelector('.nav-scrim')?.remove();
  if (state === 'open') {
    app.append(h('div', { class: 'nav-scrim', on: { click: closeDrawer } }));
  }
}

/** Buka laci mobile dan pindahkan fokus ke dalamnya (tautan halaman aktif bila ada). */
function openDrawer() {
  setNavState('open');
  (nav.querySelector('.nav__link[aria-current="page"]') ?? nav.querySelector('.nav__link'))?.focus();
}

/** Tutup laci mobile dan kembalikan fokus ke tombol pembukanya. */
function closeDrawer() {
  setNavState('expanded');
  navOpen.focus();
}

function initNav() {
  let saved = 'expanded';
  try {
    saved = window.localStorage.getItem(NAV_KEY) === 'collapsed' ? 'collapsed' : 'expanded';
  } catch {
    // abaikan
  }
  const sync = () => {
    navOpen.hidden = !mobile.matches;
    setNavState(mobile.matches ? 'expanded' : saved);
  };
  mobile.addEventListener('change', sync);
  sync();
  collapseBtn.addEventListener('click', () => {
    if (mobile.matches) return closeDrawer();
    saved = app.dataset.nav === 'collapsed' ? 'expanded' : 'collapsed';
    setNavState(saved);
  });
  navOpen.addEventListener('click', openDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.dataset.nav === 'open') closeDrawer();
  });
}

function initSkipLink() {
  // Skip link memindahkan fokus ke konten tanpa mengubah hash (hash dipakai oleh router).
  document.querySelector('.skip-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    main.focus();
  });
}

// ---- Latar jaringan saraf (dekoratif, aria-hidden, tanpa data) ----
// Modul neural dimuat dinamis: bila gagal dimuat atau canvas tidak didukung, aplikasi tetap berjalan.
let neural = null;
let motionApi = null;

/** Cadangan bila modul neural tidak tersedia: preferensi pengguna + prefers-reduced-motion. */
function fallbackReadMotion() {
  let saved = null;
  try {
    saved = window.localStorage.getItem(MOTION_KEY);
  } catch {
    // Penyimpanan lokal tidak tersedia.
  }
  if (saved === 'off') return 'off';
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'on';
}

function fallbackWriteMotion(mode) {
  try {
    window.localStorage.setItem(MOTION_KEY, mode === 'off' ? 'off' : 'on');
  } catch {
    // abaikan
  }
}

function readMotion() {
  try {
    return motionApi?.readMotionPreference() ?? fallbackReadMotion();
  } catch {
    return fallbackReadMotion();
  }
}

function applyMotion(mode) {
  document.documentElement.dataset.motion = mode;
  const btn = document.getElementById('motion-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(mode === 'on'));
    btn.title = mode === 'reduced'
      ? 'Animasi latar dibatasi oleh pengaturan "kurangi gerakan" sistem'
      : mode === 'on' ? 'Matikan animasi jaringan di latar' : 'Nyalakan animasi jaringan di latar';
  }
  try {
    neural?.setMotion(mode);
  } catch {
    // Latar dekoratif: kegagalan tidak boleh mengganggu aplikasi.
  }
}

/** Panggil metode latar dengan aman (pulse/setActivity/resize). */
function neuralCall(method, ...args) {
  try {
    neural?.[method]?.(...args);
  } catch {
    // abaikan
  }
}

async function initMotion() {
  applyMotion(fallbackReadMotion());
  const btn = document.getElementById('motion-toggle');
  btn?.addEventListener('click', () => {
    const next = document.documentElement.dataset.motion === 'off' ? 'on' : 'off';
    try {
      (motionApi?.writeMotionPreference ?? fallbackWriteMotion)(next);
    } catch {
      fallbackWriteMotion(next);
    }
    applyMotion(next === 'off' ? 'off' : readMotion());
  });
  window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => applyMotion(readMotion()));

  // Peristiwa nyata dari view (sinyal baru, scanner mulai/berhenti) → pulsa & tingkat aktivitas latar.
  window.addEventListener('lr:activity', (e) => {
    const detail = e.detail ?? {};
    if (PULSE_KINDS.has(detail.kind)) {
      neuralCall('pulse', detail.kind, Number.isFinite(detail.count) ? detail.count : 6);
    }
    if (typeof detail.level === 'number' && Number.isFinite(detail.level)) {
      neuralCall('setActivity', Math.min(1, Math.max(0, detail.level)));
    }
  });

  // Halaman Pengaturan mengubah preferensi → sinkronkan toggle topbar & latar.
  // (Ukuran canvas diurus neural.js sendiri lewat ResizeObserver/resize.)
  window.addEventListener('lr:motion', (e) => {
    const mode = e.detail?.mode;
    applyMotion(mode === 'on' || mode === 'off' || mode === 'reduced' ? mode : readMotion());
  });

  const canvas = document.getElementById('neural-bg');
  if (!(canvas instanceof HTMLCanvasElement)) return;
  try {
    motionApi = await import('./lib/neural.js');
    const mode = readMotion();
    neural = motionApi.mountNeuralBackground(canvas, { density: mobile.matches ? 0.6 : 1, interactive: !mobile.matches });
    applyMotion(mode);
    neuralCall('setActivity', 0.25);
  } catch {
    // Canvas/modul gagal: sembunyikan kanvas, aurora statis CSS di body tetap tampil.
    neural = null;
    canvas.hidden = true;
  }
}

function showLoadError() {
  main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'callout callout--bear', role: 'alert' }, 'Gagal memuat halaman.')));
}

async function show(route) {
  const seq = ++navSeq;
  if (cleanup) cleanup();
  cleanup = null;
  for (const link of nav.querySelectorAll('.nav__link')) {
    if (link.dataset.path === route.path) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  heading.textContent = route.label;
  crumb.textContent = route.crumb ?? 'AlphaLens';
  document.title = `${route.label} · AlphaLens`;
  if (app.dataset.nav === 'open') setNavState('expanded');

  let result;
  try {
    result = await route.view(ctx);
  } catch (err) {
    // Error milik navigasi yang sudah ditinggalkan tidak relevan; 401 sudah diarahkan ke login oleh api().
    if (seq !== navSeq || err?.status === 401) return;
    showLoadError();
    main.focus({ preventScroll: true });
    return;
  }
  if (seq !== navSeq) {
    // Pengguna sudah berpindah halaman: buang hasil basi dan hentikan timer/listener miliknya.
    result?.cleanup?.();
    return;
  }
  main.replaceChildren(result.el ?? result);
  cleanup = result.cleanup ?? null;
  main.focus({ preventScroll: true });
}

function startClock() {
  const el = document.getElementById('clock');
  const tick = () => { el.textContent = formatClockUtc(Date.now()); };
  tick();
  setInterval(tick, 1000);
}

async function pollConnection() {
  const el = document.getElementById('conn-status');
  const label = el.querySelector('span:last-child');
  const before = el.dataset.state;
  try {
    // Tanpa cookie sesi: polling latar tidak boleh memperpanjang idle timeout sesi.
    const res = await fetch('/api/ready', { cache: 'no-store', credentials: 'omit' });
    el.dataset.state = res.ok ? 'ok' : 'error';
    label.textContent = res.ok ? 'Server terhubung' : 'Server tidak siap';
  } catch {
    el.dataset.state = 'error';
    label.textContent = 'Server tidak terjangkau';
  }
  // Koneksi (kembali) sehat: satu pulsa aksen di latar.
  if (el.dataset.state === 'ok' && before !== 'ok') neuralCall('pulse', 'accent', 8);
}

async function requestLogout() {
  const post = () => api('/api/auth/logout', { method: 'POST', redirectOn401: false });
  try {
    await post();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 403 && err.code === 'CSRF_INVALID')) throw err;
    // Token CSRF di memori basi: ambil ulang dari sesi lalu coba sekali lagi.
    const session = await api('/api/auth/session', { redirectOn401: false });
    setCsrfToken(session.csrfToken);
    await post();
  }
}

/** Pindah ke halaman login hanya bila sesi benar-benar berakhir (sukses atau 401). */
async function logout() {
  try {
    await requestLogout();
  } catch (err) {
    // Selain 401, sesi masih berlaku — login.html akan memantulkan kembali ke dashboard.
    if (!(err instanceof ApiError && err.status === 401)) {
      toast('Gagal keluar. Coba lagi.', 'bear');
      return;
    }
  }
  window.location.replace('/login.html');
}

async function boot() {
  initSkipLink();
  // Latar dimulai segera (paralel dengan pemeriksaan sesi); tidak pernah melempar.
  initMotion().catch(() => {});
  const session = await api('/api/auth/session');
  setCsrfToken(session.csrfToken);
  ctx.user = session.user;
  document.getElementById('user-name').textContent = session.user.username;
  document.getElementById('user-avatar').textContent = session.user.username.slice(0, 1);

  document.getElementById('logout').addEventListener('click', logout);

  renderNav();
  initNav();
  startClock();
  pollConnection();
  setInterval(pollConnection, 30_000);
  createRouter({
    routes: ROUTES.filter((r) => r.path),
    fallback: '/overview',
    onChange: show,
    onError: (err) => { if (err?.status !== 401) showLoadError(); },
  }).start();
}

boot().catch((err) => {
  if (err?.status === 401) return;
  main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'callout callout--bear' }, 'Gagal memuat aplikasi. Muat ulang halaman.')));
});
