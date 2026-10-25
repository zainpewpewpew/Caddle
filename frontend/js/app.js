import { api, setCsrfToken } from './lib/api.js';
import { h, icon } from './lib/dom.js';
import { formatClockUtc } from './lib/format.js';
import { createRouter } from './lib/router.js';
import { backtestView } from './views/backtest.js';
import { designSystemView } from './views/designSystem.js';
import { healthView } from './views/health.js';
import { labView } from './views/lab.js';
import { overviewView } from './views/overview.js';
import { screenerView } from './views/screener.js';
import { settingsView } from './views/settings.js';
import { signalsView } from './views/signals.js';
import { symbolView } from './views/symbol.js';

const NAV_KEY = 'lr.nav';

const ROUTES = [
  { section: 'Pasar' },
  { path: '/overview', label: 'Overview', icon: 'overview', view: overviewView },
  { path: '/screener', label: 'LONG Screener', icon: 'screener', view: screenerView },
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
const main = document.getElementById('main');
const nav = document.getElementById('nav');
const heading = document.getElementById('heading');
const crumb = document.getElementById('crumb');
const navOpen = document.getElementById('nav-open');
const collapseBtn = document.getElementById('nav-collapse');
const mobile = window.matchMedia('(max-width: 820px)');

const ctx = { user: null };
let cleanup = null;

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
  try {
    if (!mobile.matches) window.localStorage.setItem(NAV_KEY, state);
  } catch {
    // Penyimpanan lokal tidak tersedia — preferensi tidak disimpan.
  }
  document.querySelector('.nav-scrim')?.remove();
  if (state === 'open') {
    app.append(h('div', { class: 'nav-scrim', on: { click: () => setNavState('expanded') } }));
  }
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
    if (mobile.matches) return setNavState('expanded');
    saved = app.dataset.nav === 'collapsed' ? 'expanded' : 'collapsed';
    setNavState(saved);
  });
  navOpen.addEventListener('click', () => setNavState('open'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.dataset.nav === 'open') setNavState('expanded');
  });
}

async function show(route) {
  if (cleanup) cleanup();
  cleanup = null;
  for (const link of nav.querySelectorAll('.nav__link')) {
    if (link.dataset.path === route.path) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  heading.textContent = route.label;
  crumb.textContent = route.crumb ?? 'Long Radar';
  document.title = `${route.label} · Long Radar`;
  if (app.dataset.nav === 'open') setNavState('expanded');

  const result = await route.view(ctx);
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
  try {
    const res = await fetch('/api/ready', { cache: 'no-store' });
    el.dataset.state = res.ok ? 'ok' : 'error';
    label.textContent = res.ok ? 'Server terhubung' : 'Server tidak siap';
  } catch {
    el.dataset.state = 'error';
    label.textContent = 'Server tidak terjangkau';
  }
}

async function boot() {
  const session = await api('/api/auth/session');
  setCsrfToken(session.csrfToken);
  ctx.user = session.user;
  document.getElementById('user-name').textContent = session.user.username;
  document.getElementById('user-avatar').textContent = session.user.username.slice(0, 1);

  document.getElementById('logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.replace('/login.html');
    }
  });

  renderNav();
  initNav();
  startClock();
  pollConnection();
  setInterval(pollConnection, 30_000);
  createRouter({ routes: ROUTES.filter((r) => r.path), fallback: '/overview', onChange: show }).start();
}

boot().catch((err) => {
  if (err?.status === 401) return;
  main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'callout callout--bear' }, 'Gagal memuat aplikasi. Muat ulang halaman.')));
});
