import { ApiError, api } from './lib/api.js';

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const submit = document.getElementById('login-submit');
const card = document.getElementById('auth-card');

// Tombol baru aktif setelah modul ini termuat, sehingga form tidak pernah terkirim secara native.
submit.disabled = false;

/**
 * Latar jaringan saraf bersifat dekoratif. Dimuat secara dinamis dan dibungkus try/catch sehingga
 * kegagalan memuat/menjalankannya tidak pernah mengganggu login.
 */
let neural = null;
const pulse = (kind, count) => {
  try { neural?.pulse(kind, count); } catch { /* dekoratif — abaikan */ }
};
const setActivity = (level) => {
  try { neural?.setActivity(level); } catch { /* dekoratif — abaikan */ }
};

(async () => {
  try {
    const canvas = document.getElementById('neural-bg');
    if (!canvas) return;
    const mod = await import('./lib/neural.js');
    const mode = mod.readMotionPreference?.() ?? 'on';
    document.documentElement.dataset.motion = mode;
    neural = mod.mountNeuralBackground(canvas, { density: 1, interactive: true, palette: 'aurora' });
    neural?.setMotion?.(mode);
    setActivity(0.35);
  } catch {
    neural = null;
  }
})();

// Pulsa halus saat pengguna mulai mengisi form.
for (const input of [form.username, form.password]) {
  input.addEventListener('focus', () => pulse('accent', 3));
}

const setCardState = (state) => {
  if (!card) return;
  card.classList.remove('is-busy', 'is-error', 'is-success');
  if (state) {
    // Paksa reflow agar animasi (mis. guncangan) diputar ulang pada kegagalan berturut-turut.
    void card.offsetWidth;
    card.classList.add(state);
  }
};

const showError = (message) => {
  errorBox.textContent = message;
  errorBox.hidden = false;
};

const prefersReducedMotion = () => document.documentElement.dataset.motion !== 'on'
  || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username || !password) {
    showError('Username dan kata sandi wajib diisi.');
    setCardState('is-error');
    pulse('bear', 4);
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Memverifikasi…';
  setCardState('is-busy');
  pulse('accent', 6);
  setActivity(0.8);
  try {
    await api('/api/auth/login', { method: 'POST', body: { username, password }, redirectOn401: false });
    setCardState('is-success');
    pulse('bull', 10);
    // Jeda singkat agar pulsa sukses terlihat; dilewati bila gerak dimatikan/dikurangi.
    if (!prefersReducedMotion()) await new Promise((resolve) => setTimeout(resolve, 320));
    window.location.replace('/');
  } catch (err) {
    form.password.value = '';
    setCardState('is-error');
    pulse('bear', 6);
    setActivity(0.35);
    if (err instanceof ApiError && err.status === 429) {
      showError('Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.');
    } else if (err instanceof ApiError && (err.status === 401 || err.status === 400)) {
      showError('Username atau kata sandi salah.');
    } else {
      showError('Tidak dapat terhubung ke server. Coba lagi.');
    }
    form.password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Masuk';
  }
});
