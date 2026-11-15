// AlphaLens — halaman awal (pintu depan privat). Tiga tugas, semuanya opsional dan aman gagal:
// 1) latar rasi grafit (dekoratif, sama dengan aplikasi), 2) strip "Proses sync scanner" yang berjalan sebagai ILUSTRASI
// alur (ditandai jelas di halaman, bukan data langsung), 3) tautan Masuk membawa hash-route yang diminta (mis.
// /#/settings) agar setelah login pengguna kembali ke layar itu.

const HASH_ROUTE = /^#\/[\w-]+(\?[\w=&%.-]*)?$/;

function motionAllowed() {
  const mode = document.documentElement.dataset.motion;
  if (mode === 'off' || mode === 'reduced') return false;
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Tautan Masuk → /login.html + hash-route yang diminta (hanya bentuk #/route, tidak pernah URL lain). */
function carryRequestedRoute() {
  const hash = window.location.hash;
  if (!HASH_ROUTE.test(hash)) return;
  for (const link of document.querySelectorAll('[data-login-link]')) link.setAttribute('href', `/login.html${hash}`);
}

/**
 * Ilustrasi pipeline: langkah berjalan satu per satu (aktif → selesai), backfill mengisi bar, stream & analisis
 * menjadi live, lalu mengulang. Tanpa gerak (reduced/off): langsung keadaan akhir statis.
 */
function runPipelineDemo() {
  const steps = [...document.querySelectorAll('[data-demo-step]')];
  if (steps.length === 0) return;
  const progressStep = steps.find((s) => s.hasAttribute('data-demo-progress'));
  const setProgress = (pct) => progressStep?.style.setProperty('--lp-progress', String(pct));
  const finalState = (s) => (s.hasAttribute('data-demo-live') ? 'live' : 'done');

  const showFinal = () => {
    for (const s of steps) s.dataset.state = finalState(s);
    setProgress(100);
  };

  if (!motionAllowed()) {
    showFinal();
    return;
  }

  let timer = 0;
  const wait = (ms) => new Promise((resolve) => { timer = window.setTimeout(resolve, ms); });

  async function cycle() {
    for (const s of steps) s.dataset.state = 'pending';
    setProgress(0);
    await wait(700);
    for (const s of steps) {
      if (!motionAllowed()) { showFinal(); return; }
      s.dataset.state = 'active';
      if (s === progressStep) {
        for (let pct = 0; pct <= 100; pct += 20) {
          setProgress(pct);
          await wait(360);
        }
      } else {
        await wait(1100);
      }
      s.dataset.state = finalState(s);
    }
    await wait(5200);
    if (!document.hidden) cycle();
    else document.addEventListener('visibilitychange', () => cycle(), { once: true });
  }

  cycle();
  window.addEventListener('pagehide', () => window.clearTimeout(timer));
}

async function mountBackground() {
  const canvas = document.getElementById('neural-bg');
  if (!(canvas instanceof HTMLCanvasElement)) return;
  try {
    const mod = await import('./lib/neural.js');
    const mode = mod.readMotionPreference?.() ?? 'on';
    document.documentElement.dataset.motion = mode;
    const neural = mod.mountNeuralBackground(canvas, { density: 0.8, interactive: true });
    neural?.setMotion?.(mode);
    neural?.setActivity?.(0.3);
  } catch {
    canvas.hidden = true;
  }
}

carryRequestedRoute();
mountBackground().finally(runPipelineDemo);
