import { ApiError, api } from './lib/api.js';

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const submit = document.getElementById('login-submit');

// Tombol baru aktif setelah modul ini termuat, sehingga form tidak pernah terkirim secara native.
submit.disabled = false;

const showError = (message) => {
  errorBox.textContent = message;
  errorBox.hidden = false;
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username || !password) {
    showError('Username dan kata sandi wajib diisi.');
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Memverifikasi…';
  try {
    await api('/api/auth/login', { method: 'POST', body: { username, password }, redirectOn401: false });
    window.location.replace('/');
  } catch (err) {
    form.password.value = '';
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
