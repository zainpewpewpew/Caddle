import { ApiError, api } from '../lib/api.js';
import { badge, callout, inputField, page, panel, segmented, selectField, toast, toggle } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { onDisconnect } from '../lib/chart.js';
import { formatTime } from '../lib/format.js';
import { parseNumberInput, validateSettings } from '../lib/settingsValidation.js';

// Timeframe tetap per arah (selaras DIRECTION_TIMEFRAMES backend): LONG 15m, SHORT 1h. Tidak dapat diubah dari form;
// nilai ini tetap dikirim agar skema pengaturan lama (field `timeframes` wajib) tetap valid.
const FIXED_TIMEFRAMES = Object.freeze(['15m', '1h']);

/**
 * Membaca isi form pengaturan dari FormData. Field angka yang dikosongkan menjadi NaN
 * (bukan 0) sehingga ditolak validasi alih-alih tersimpan diam-diam.
 * @param {FormData} fd
 */
export function settingsFromFormData(fd) {
  const num = (name) => parseNumberInput(fd.get(name));
  const manual = String(fd.get('manual') ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return {
    symbols: { mode: fd.get('mode'), maxAuto: num('maxAuto'), manual: [...new Set(manual)] },
    timeframes: [...FIXED_TIMEFRAMES],
    liquidity: { minQuoteVolume24h: num('minQuoteVolume24h'), maxSpreadBps: num('maxSpreadBps') },
    refresh: { bootstrapCandles: num('bootstrapCandles'), restBackfillIntervalSec: num('restBackfillIntervalSec') },
    alerts: { enabled: fd.get('alertsEnabled') === 'on', minStage: fd.get('minStage') },
  };
}

function readForm(form) {
  return settingsFromFormData(new FormData(form));
}

function showErrors(form, errors) {
  for (const el of form.querySelectorAll('[data-error-for]')) {
    const msg = errors[el.dataset.errorFor];
    el.textContent = msg ?? '';
    el.hidden = !msg;
    form.querySelector(`[name="${el.dataset.errorFor}"]`)?.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
}

const MOTION_KEY = 'lr.motion';
const MOTION_CHOICES = ['auto', 'on', 'off'];
const systemReduced = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Mode efektif untuk <html data-motion> — sama dengan aturan neural.js: pilihan eksplisit pengguna menang;
 * 'auto' (tanpa pilihan) mengikuti prefers-reduced-motion sistem operasi.
 * @param {'auto'|'on'|'off'} choice
 * @param {boolean} reducedBySystem
 * @returns {'on'|'off'|'reduced'}
 */
export function effectiveMotion(choice, reducedBySystem) {
  if (choice === 'off' || choice === 'on') return choice;
  return reducedBySystem ? 'reduced' : 'on';
}

/** Pilihan tersimpan di localStorage `lr.motion` ('on'|'off'); tidak ada / diblokir → 'auto'. */
function storedMotionChoice() {
  try {
    const value = window.localStorage.getItem(MOTION_KEY);
    return value === 'on' || value === 'off' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Penulis preferensi: writeMotionPreference dari ../lib/neural.js (dimuat dinamis agar modul ini tetap dapat diimpor
 * unit test di Node tanpa DOM). Bila modul itu gagal dimuat, cadangan lokal menulis localStorage yang sama.
 * @returns {Promise<(mode: string|null) => string>} mengembalikan mode efektif
 */
async function motionWriter() {
  try {
    const mod = await import('../lib/neural.js');
    if (typeof mod.writeMotionPreference === 'function') return mod.writeMotionPreference;
  } catch {
    // jatuh ke cadangan lokal
  }
  return (mode) => {
    try {
      if (mode === 'on' || mode === 'off') window.localStorage.setItem(MOTION_KEY, mode);
      else window.localStorage.removeItem(MOTION_KEY);
    } catch { /* penyimpanan diblokir: tetap berlaku untuk sesi ini */ }
    return effectiveMotion(mode === 'on' || mode === 'off' ? mode : 'auto', systemReduced());
  };
}

/**
 * Bagian "Tampilan" — preferensi per browser (bukan pengaturan scanner), jadi berada di luar form scanner dan tetap
 * dapat diubah analyst. Perubahan langsung diterapkan: <html data-motion> + event window `lr:motion` {detail:{mode}}
 * yang didengar app.js (toggle topbar & latar). Toggle topbar yang diklik saat halaman ini terbuka ikut tercermin.
 */
function appearancePanel() {
  const control = segmented({
    name: 'motion', label: 'Animasi latar',
    value: storedMotionChoice(),
    options: [{ value: 'auto', label: 'Ikuti sistem' }, { value: 'on', label: 'Aktif' }, { value: 'off', label: 'Nonaktif' }],
  });
  control.setAttribute('aria-describedby', 'motion-hint');
  const note = h('span', { class: 'field__hint', id: 'motion-hint', 'aria-live': 'polite' });
  const preview = h('div', { class: 'appearance__preview', 'aria-hidden': 'true' },
    h('span', { class: 'appearance__dot' }), h('span', { class: 'appearance__dot' }), h('span', { class: 'appearance__dot' }),
    h('span', { class: 'appearance__link' }), h('span', { class: 'appearance__link appearance__link--2' }));

  const sync = () => {
    const choice = storedMotionChoice();
    for (const input of control.querySelectorAll('input')) input.checked = input.value === choice;
    const mode = document.documentElement.dataset.motion ?? effectiveMotion(choice, systemReduced());
    preview.dataset.motion = mode;
    note.textContent = mode === 'off'
      ? 'Nonaktif: latar jaringan statis, animasi dekoratif dimatikan.'
      : mode === 'reduced'
        ? 'Sistem operasi meminta gerak dikurangi — latar ditampilkan statis. Pilih "Aktif" untuk tetap menganimasikannya.'
        : 'Aktif: node & pulsa sinaps bergerak pelan di belakang panel.';
    note.textContent += ' Disimpan di browser ini saja.';
  };

  const writer = motionWriter();
  control.addEventListener('change', async (e) => {
    const choice = MOTION_CHOICES.includes(e.target.value) ? e.target.value : 'auto';
    const write = await writer;
    let mode;
    try {
      mode = write(choice === 'auto' ? null : choice);
    } catch {
      mode = effectiveMotion(choice, systemReduced());
    }
    if (mode !== 'on' && mode !== 'off' && mode !== 'reduced') mode = effectiveMotion(choice, systemReduced());
    document.documentElement.dataset.motion = mode;
    window.dispatchEvent(new CustomEvent('lr:motion', { detail: { mode } }));
    sync();
  });

  const el = panel({ title: 'Tampilan' },
    h('div', { class: 'appearance' },
      h('div', { class: 'field appearance__field' },
        h('span', { class: 'field__label' }, 'Animasi latar jaringan saraf'),
        control,
        note),
      preview));

  // Toggle topbar mengubah <html data-motion> → cerminkan di sini; berhenti saat halaman ditinggalkan.
  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  onDisconnect(el, () => observer.disconnect());
  sync();
  return el;
}

function sessionsPanel() {
  const list = h('div', { class: 'stack' }, h('span', { class: 'skeleton' }));
  const load = async () => {
    const { sessions } = await api('/api/auth/sessions');
    list.replaceChildren(...sessions.map((s) => h('div', { class: 'cluster', style: { 'justify-content': 'space-between' } },
      h('div', null,
        h('div', null, s.userAgent ? (s.userAgent.length > 60 ? `${s.userAgent.slice(0, 60)}…` : s.userAgent) : 'Perangkat tidak dikenal', ' ', s.current ? badge('Sesi ini', 'bull') : null),
        h('div', { class: 'subtle' }, `${s.ipAddress ?? '—'} · aktif ${formatTime(s.lastSeenAt)}`)),
      s.current ? null : h('button', {
        class: 'btn btn--danger btn--sm',
        type: 'button',
        on: { click: async () => { await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' }); toast('Sesi dicabut', 'bull'); load(); } },
      }, 'Cabut'))));
  };
  load().catch(() => list.replaceChildren(h('p', { class: 'muted' }, 'Gagal memuat sesi.')));
  return panel({
    title: 'Sesi aktif',
    actions: h('button', {
      class: 'btn btn--sm',
      type: 'button',
      on: { click: async () => { const r = await api('/api/auth/sessions/revoke-others', { method: 'POST' }); toast(`${r.revoked} sesi lain dicabut`, 'bull'); load(); } },
    }, 'Cabut sesi lain'),
  }, list);
}

export async function settingsView(ctx) {
  let current = await api('/api/settings/scanner');
  const canEdit = ctx.user.role === 'admin';
  const s = current.settings;

  const versionBadge = badge(current.isDefault ? 'Default' : `Versi ${current.version}`, current.isDefault ? undefined : 'accent');
  const form = h('form', { class: 'stack', novalidate: true, 'aria-label': 'Pengaturan scanner' },
    panel({ title: 'Simbol & timeframe', actions: versionBadge },
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' },
          h('span', { class: 'field__label' }, 'Mode simbol'),
          segmented({ name: 'mode', label: 'Mode simbol', value: s.symbols.mode, options: [{ value: 'auto', label: 'Otomatis (likuiditas)' }, { value: 'manual', label: 'Manual' }] })),
        inputField({ label: 'Maks. simbol otomatis', name: 'maxAuto', type: 'number', value: s.symbols.maxAuto, hint: 'Target MVP 30–50 pasangan', attrs: { min: 10, max: 100, step: 1 } }),
        h('div', { class: 'field', 'data-testid': 'settings-timeframes' },
          h('span', { class: 'field__label' }, 'Timeframe'),
          h('div', { class: 'cluster' }, badge('LONG 15m', 'bull'), badge('SHORT 1h', 'bear')),
          h('span', { class: 'field__hint' }, 'Tetap: LONG Scanner memakai 15m (konteks 1h), SHORT Scanner memakai 1h.'))),
      h('div', { class: 'field', style: { 'margin-top': 'var(--lr-space-4)' } },
        h('label', { class: 'field__label', for: 'f-manual' }, 'Simbol manual'),
        h('textarea', { class: 'input input--mono', id: 'f-manual', name: 'manual', rows: 3, spellcheck: 'false', placeholder: 'BTCUSDT, ETHUSDT' }, s.symbols.manual.join(', ')),
        h('span', { class: 'field__hint' }, 'Dipisah koma atau spasi. Format: XXXUSDT.'),
        h('span', { class: 'field__error', 'data-error-for': 'manual', hidden: true }))),
    panel({ title: 'Filter likuiditas' },
      h('div', { class: 'form-grid' },
        inputField({ label: 'Min. quote volume 24j (USDT)', name: 'minQuoteVolume24h', type: 'number', value: s.liquidity.minQuoteVolume24h, attrs: { min: 0, step: 'any' } }),
        inputField({ label: 'Maks. spread (bps)', name: 'maxSpreadBps', type: 'number', value: s.liquidity.maxSpreadBps, attrs: { min: 0, max: 1000, step: 'any' } }))),
    panel({ title: 'Kebijakan refresh data' },
      h('div', { class: 'form-grid' },
        inputField({ label: 'Candle bootstrap', name: 'bootstrapCandles', type: 'number', value: s.refresh.bootstrapCandles, hint: 'Per simbol per timeframe', attrs: { min: 100, max: 1500, step: 1 } }),
        inputField({ label: 'Interval backfill REST (detik)', name: 'restBackfillIntervalSec', type: 'number', value: s.refresh.restBackfillIntervalSec, attrs: { min: 30, max: 3600, step: 1 } }))),
    panel({ title: 'Alert' },
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Status'), toggle({ name: 'alertsEnabled', label: 'Aktifkan alert', checked: s.alerts.enabled })),
        selectField({ label: 'Tahap minimum', name: 'minStage', value: s.alerts.minStage, options: [
          { value: 'EARLY_BULLISH', label: 'Early bullish' }, { value: 'MOMENTUM_BUILDING', label: 'Momentum building' }, { value: 'BREAKOUT', label: 'Breakout' }] }))),
    h('div', { class: 'cluster' },
      h('button', { class: 'btn btn--primary', type: 'submit', disabled: !canEdit }, 'Simpan pengaturan'),
      h('span', { class: 'subtle', 'data-testid': 'settings-meta' }, current.updatedAt ? `Terakhir diubah ${formatTime(current.updatedAt)}` : 'Belum pernah diubah')));

  if (!canEdit) for (const el of form.querySelectorAll('input, select, textarea')) el.disabled = true;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const settings = readForm(form);
    const errors = validateSettings(settings);
    showErrors(form, errors);
    if (Object.keys(errors).length) return;
    try {
      current = await api('/api/settings/scanner', { method: 'PUT', body: { version: current.version, settings } });
      versionBadge.textContent = `Versi ${current.version}`;
      versionBadge.className = 'badge badge--accent';
      form.querySelector('[data-testid="settings-meta"]').textContent = `Terakhir diubah ${formatTime(current.updatedAt)}`;
      toast('Pengaturan disimpan', 'bull');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) toast('Pengaturan diubah pengguna lain. Muat ulang halaman.', 'bear');
      else if (err instanceof ApiError && err.status === 400) toast('Server menolak input. Periksa nilai yang diisi.', 'bear');
      else toast('Gagal menyimpan pengaturan', 'bear');
    }
  });

  return page({
    title: 'Pengaturan',
    subtitle: 'Konfigurasi scanner. Setiap perubahan divalidasi di server, berversi, dan tercatat di log audit.',
  },
  canEdit ? null : callout('Akun Anda berperan analyst: pengaturan hanya dapat dibaca.', 'warn'),
  callout('Ambang pola dan bobot skor ditambahkan bersama mesin pola di Milestone 3.'),
  form,
  appearancePanel(),
  sessionsPanel());
}
