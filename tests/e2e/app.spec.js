import { expect, test } from '@playwright/test';
import { E2E_PORT, E2E_USERS } from './fixtures.js';

const ROUTES = ['overview', 'screener', 'short-scanner', 'symbol', 'signals', 'lab', 'backtest', 'settings', 'health', 'design-system'];

/** Kumpulkan error konsol, error JS, dan pelanggaran CSP selama test. */
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    // 401 dari percobaan login yang memang salah adalah perilaku yang diharapkan.
    if (msg.type() === 'error' && !/status of 401/.test(text)) errors.push(`console: ${text}`);
  });
  return errors;
}

async function signIn(page, user = E2E_USERS.admin) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\.html$/);
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Kata sandi').fill(user.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page).toHaveURL(/\/(#\/overview)?$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

/** Di layar sempit tombol Keluar berada di laci navigasi. */
async function openNavIfNeeded(page) {
  const opener = page.getByRole('button', { name: 'Buka navigasi' });
  if (await opener.isVisible()) await opener.click();
}

/** Ubah hash lalu tunggu sampai listener hashchange (router) selesai dijalankan. */
async function setHash(page, hash) {
  await page.evaluate((next) => new Promise((resolve) => {
    window.addEventListener('hashchange', () => setTimeout(resolve, 0), { once: true });
    window.location.hash = next;
  }), hash);
}

test('E2E-AUTH-001 kredensial salah menampilkan pesan generik dan tetap di halaman login', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/login.html');
  await page.getByLabel('Username').fill('mary');
  await page.getByLabel('Kata sandi').fill('definitely-wrong-pass');
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('alert')).toHaveText('Username atau kata sandi salah.');
  await expect(page).toHaveURL(/login\.html$/);
  await expect(page.getByLabel('Kata sandi')).toHaveValue('');
  expect(errors).toEqual([]);
});

test('E2E-AUTH-002 login valid → dashboard; cookie sesi HttpOnly tidak terbaca JavaScript', async ({ page, context }) => {
  const errors = watchErrors(page);
  await signIn(page);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'lr_session');
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Strict');
  expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => !k.startsWith('lr.nav')))).toEqual([]);
  expect(errors).toEqual([]);
});

test('E2E-NAV-001 seluruh layar dapat dibuka tanpa error konsol atau pelanggaran CSP', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  for (const route of ROUTES) {
    await page.goto(`/#/${route}`);
    await expect(page.locator('.page h1')).toBeVisible();
    await expect(page.locator(`.nav__link[data-path="/${route}"]`)).toHaveAttribute('aria-current', 'page');
  }
  expect(errors).toEqual([]);
});

test('E2E-UI-001 overview menampilkan angka nyata dari database (nol) dan status jujur', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('kpi-monitored').locator('.stat__value')).toHaveText('0');
  await expect(page.getByTestId('kpi-active').locator('.stat__value')).toHaveText('0');
  await expect(page.getByText('Belum berjalan').first()).toBeVisible();
});

test('E2E-UI-002 tidak ada horizontal overflow halaman di setiap layar', async ({ page }) => {
  await signIn(page);
  for (const route of ROUTES) {
    await page.goto(`/#/${route}`);
    await expect(page.locator('.page h1')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `overflow di ${route}`).toBeLessThanOrEqual(1);
  }
});

test('E2E-SET-001 admin menyimpan pengaturan; validasi klien menolak input tidak valid', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/settings');
  const manual = page.getByLabel('Simbol manual');
  await manual.fill('BTCUSDT, <script>');
  await page.getByRole('button', { name: 'Simpan pengaturan' }).click();
  await expect(page.locator('[data-error-for="manual"]')).toContainText('Format tidak valid');

  await manual.fill('BTCUSDT ETHUSDT');
  await page.getByLabel('Maks. simbol otomatis').fill('35');
  await page.getByRole('button', { name: 'Simpan pengaturan' }).click();
  await expect(page.getByRole('status')).toContainText('Pengaturan disimpan');
  await page.reload();
  await expect(page.getByLabel('Maks. simbol otomatis')).toHaveValue('35');
  await expect(page.getByLabel('Simbol manual')).toHaveValue('BTCUSDT, ETHUSDT');
});

test('E2E-AZ-001 analyst melihat pengaturan dalam mode baca saja', async ({ page }) => {
  await signIn(page, E2E_USERS.analyst);
  await page.goto('/#/settings');
  await expect(page.getByText('pengaturan hanya dapat dibaca')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simpan pengaturan' })).toBeDisabled();
});

test('E2E-SEC-001 data yang ditampilkan di-escape (tidak dieksekusi sebagai HTML)', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/settings');
  // User-agent dikontrol klien dan ditampilkan di panel sesi; pastikan dirender sebagai teks.
  const injected = await page.evaluate(async () => {
    const el = document.createElement('div');
    const { h } = await import('/js/lib/dom.js');
    el.append(h('span', null, '<img src=x onerror="window.__xss=1">'));
    return { html: el.innerHTML, executed: window.__xss === 1 };
  });
  expect(injected.executed).toBe(false);
  expect(injected.html).toContain('&lt;img');
});

test('E2E-AUTH-003 logout mengakhiri sesi; kembali ke dashboard diarahkan ke login', async ({ page }) => {
  await signIn(page);
  await openNavIfNeeded(page);
  await page.getByRole('button', { name: 'Keluar' }).click();
  await expect(page).toHaveURL(/login\.html$/);
  await page.goto('/#/settings');
  // Browser mempertahankan fragmen (#/settings) saat mengikuti redirect 302.
  await expect(page).toHaveURL(/login\.html(#.*)?$/);
});

// Server E2E membatasi login 20 kali per 15 menit per IP; tes di atas sudah memakai 18 (9 per proyek).
// Grup ini karena itu memakai SATU sesi admin per proyek (login lewat API) dan berjalan serial:
// E2E-AUTH-004 benar-benar logout sehingga harus menjadi tes terakhir.
test.describe('sesi bersama', () => {
  test.describe.configure({ mode: 'serial' });
  let sharedState;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${E2E_PORT}` });
    const { username, password } = E2E_USERS.admin;
    const res = await request.post('/api/auth/login', { data: { username, password } });
    expect(res.status()).toBe(200);
    sharedState = await request.storageState();
    await request.dispose();
  });
  // Playwright mewajibkan pola destrukturisasi objek pada argumen pertama fixture.
  // eslint-disable-next-line no-empty-pattern
  test.use({ storageState: async ({}, use) => { await use(sharedState); } });

  async function openApp(page) {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  }

  test('E2E-SEC-002 polling /api/ready tidak mengirim cookie sesi (tidak memperpanjang idle timeout)', async ({ page }) => {
    const ready = [];
    const session = [];
    page.on('request', (req) => {
      const { pathname } = new URL(req.url());
      if (pathname === '/api/ready') ready.push(req);
      if (pathname === '/api/auth/session') session.push(req);
    });
    await openApp(page);
    await expect.poll(() => ready.length).toBeGreaterThan(0);
    // Kontrol: request API biasa memang membawa cookie, jadi pemeriksaan di bawah bermakna.
    expect((await session[0].allHeaders()).cookie).toContain('lr_session=');
    for (const req of ready) expect((await req.allHeaders()).cookie).toBeUndefined();
  });

  test('E2E-NAV-002 view lambat yang selesai setelah navigasi baru dibuang beserta timer-nya', async ({ page }) => {
    // Instrumen tes: catat interval aktif agar kebocoran auto-refresh System Health terlihat.
    await page.addInitScript(() => {
      const active = new Map();
      const created = [];
      const nativeSet = window.setInterval.bind(window);
      const nativeClear = window.clearInterval.bind(window);
      window.setInterval = (fn, ms, ...args) => {
        const id = nativeSet(fn, ms, ...args);
        created.push(ms);
        active.set(id, ms);
        return id;
      };
      window.clearInterval = (id) => {
        active.delete(id);
        nativeClear(id);
      };
      window.__lrIntervals = { created, active };
    });
    await openApp(page);

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let statusRequests = 0;
    await page.route('**/api/system/status', async (route) => {
      statusRequests += 1;
      await held;
      await route.continue();
    });
    await setHash(page, '#/health');
    await expect.poll(() => statusRequests).toBe(1);
    await setHash(page, '#/overview');
    await expect(page.locator('.page h1')).toHaveText('Overview');

    release();
    // Tunggu sampai view health selesai (interval 10 dtk-nya dibuat) — interval itu harus langsung dibersihkan.
    const healthIntervals = () => page.evaluate(() => ({
      created: window.__lrIntervals.created.filter((ms) => ms === 10_000).length,
      active: [...window.__lrIntervals.active.values()].filter((ms) => ms === 10_000).length,
    }));
    await expect.poll(async () => (await healthIntervals()).created).toBe(1);
    expect((await healthIntervals()).active).toBe(0);
    await expect(page.locator('.page h1')).toHaveText('Overview');
    await expect(page.locator('#heading')).toHaveText('Overview');
  });

  test('E2E-NAV-003 view yang gagal dimuat menampilkan pesan error, bukan halaman lama', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await openApp(page);
    await page.route('**/api/system/status', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Terjadi kesalahan internal' }),
    }));
    await setHash(page, '#/health');
    await expect(page.locator('.page .callout.callout--bear')).toHaveText('Gagal memuat halaman.');
    await expect(page.locator('.page h1')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('E2E-NAV-004 skip link memindahkan fokus ke konten tanpa berpindah route', async ({ page }) => {
    await openApp(page);
    await setHash(page, '#/screener');
    await expect(page.locator('#heading')).toHaveText('LONG Scanner');
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
    await expect(page).toHaveURL(/#\/screener$/);
    await expect(page.locator('#heading')).toHaveText('LONG Scanner');

    // Fragmen non-route yang dibuka langsung juga tidak dianggap route Overview.
    await setHash(page, '#main');
    await expect(page.locator('#heading')).toHaveText('LONG Scanner');
    await expect(page.locator('.nav__link[data-path="/screener"]')).toHaveAttribute('aria-current', 'page');
  });

  test('E2E-UI-003 laci navigasi mobile: tertutup tidak dapat difokus; buka/tutup mengatur fokus & aria-expanded', async ({ page, isMobile }) => {
    await openApp(page);
    const sidebar = page.locator('#sidebar');
    if (!isMobile) {
      // Desktop: sidebar selalu tampil dan dapat dipakai.
      await expect(sidebar).not.toHaveAttribute('inert');
      return;
    }
    const toggle = page.getByRole('button', { name: 'Buka navigasi' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar).toHaveAttribute('inert', '');
    // Tab dari skip link langsung ke tombol menu, melewati isi laci yang tertutup.
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar).not.toHaveAttribute('inert');
    await expect(page.locator('.nav__link[aria-current="page"]')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar).toHaveAttribute('inert', '');
    await expect(toggle).toBeFocused();
  });

  test('E2E-UI-004 mode warna paksa: fokus keyboard tetap terlihat lewat outline', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await openApp(page);
    // Tombol menu (mobile) atau tautan brand (desktop) adalah elemen pertama setelah skip link.
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(outline.style).toBe('solid');
    expect(outline.width).toBeGreaterThanOrEqual(2);
  });

  test('E2E-SET-002 field angka yang dikosongkan ditolak, tidak tersimpan sebagai 0', async ({ page }) => {
    await openApp(page);
    await setHash(page, '#/settings');
    const volume = page.getByLabel('Min. quote volume 24j (USDT)');
    await expect(volume).not.toHaveValue('');
    const original = await volume.inputValue();
    let saveRequests = 0;
    page.on('request', (req) => {
      if (req.method() === 'PUT' && new URL(req.url()).pathname === '/api/settings/scanner') saveRequests += 1;
    });
    await volume.fill('');
    await page.getByRole('button', { name: 'Simpan pengaturan' }).click();
    await expect(page.locator('[data-error-for="minQuoteVolume24h"]')).toContainText('Wajib diisi');
    await expect(volume).toHaveAttribute('aria-invalid', 'true');
    expect(saveRequests).toBe(0);
    await page.reload();
    await expect(page.getByLabel('Min. quote volume 24j (USDT)')).toHaveValue(original);
  });

  test('E2E-AUTH-005 logout yang gagal menampilkan pesan dan tetap di aplikasi', async ({ page }) => {
    await openApp(page);
    await page.route('**/api/auth/logout', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Terjadi kesalahan internal' }),
    }));
    await openNavIfNeeded(page);
    await page.getByRole('button', { name: 'Keluar' }).click();
    await expect(page.getByRole('status')).toContainText('Gagal keluar. Coba lagi.');
    await expect(page).not.toHaveURL(/login\.html/);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  });

  // Harus terakhir: mengakhiri sesi bersama.
  test('E2E-AUTH-004 logout dengan token CSRF basi mengambil ulang token lalu benar-benar keluar', async ({ page }) => {
    await openApp(page);
    // Modul yang sama dengan milik aplikasi (URL identik) — token CSRF di memori dibuat basi.
    await page.evaluate(async () => {
      const { setCsrfToken } = await import('/js/lib/api.js');
      setCsrfToken('token-csrf-basi');
    });
    const logoutStatuses = [];
    page.on('response', (res) => {
      if (new URL(res.url()).pathname === '/api/auth/logout') logoutStatuses.push(res.status());
    });
    await openNavIfNeeded(page);
    await page.getByRole('button', { name: 'Keluar' }).click();
    await expect(page).toHaveURL(/login\.html$/);
    expect(logoutStatuses).toEqual([403, 204]);
    // Sesi benar-benar berakhir: dashboard kembali diarahkan ke login.
    await page.goto('/');
    await expect(page).toHaveURL(/login\.html$/);
  });
});
