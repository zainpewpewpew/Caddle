// Router berbasis hash: #/overview, #/screener, ...
// Query opsional setelah path (#/symbol?s=BTCUSDT&tf=15m) tidak ikut dicocokkan ke route; view membacanya
// lewat hashQuery(). Pindah query pada route yang sama tetap memicu hashchange → view dirender ulang.

/**
 * Memisahkan hash menjadi path route dan query-nya.
 * @param {string} hash contoh '#/symbol?s=BTCUSDT&tf=15m'
 * @returns {{ path: string, query: URLSearchParams }}
 */
export function splitHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const mark = raw.indexOf('?');
  return {
    path: mark === -1 ? raw : raw.slice(0, mark),
    query: new URLSearchParams(mark === -1 ? '' : raw.slice(mark + 1)),
  };
}

/** Query dari hash saat ini (default: window.location.hash). Nilai tetap harus divalidasi pemanggil. */
export function hashQuery(hash = window.location.hash) {
  return splitHash(hash).query;
}

/**
 * Menerjemahkan hash menjadi route. Hash kosong → fallback; path tak dikenal → fallback.
 * Fragmen biasa yang bukan route (mis. #main dari skip link) mengembalikan null agar diabaikan.
 * @param {string} hash nilai window.location.hash
 * @param {Array<{ path: string }>} routes
 * @param {string} fallback
 */
export function resolveRoute(hash, routes, fallback) {
  if (hash && !hash.startsWith('#/')) return null;
  const path = splitHash(hash).path || fallback;
  return routes.find((r) => r.path === path) ?? routes.find((r) => r.path === fallback);
}

/**
 * @param {{ routes: Array<{ path: string }>, fallback: string,
 *   onChange: (route: any) => unknown, onError?: (err: unknown) => void }} options
 */
export function createRouter({ routes, fallback, onChange, onError }) {
  let current = null;
  // Kegagalan onChange (sinkron maupun promise) tidak boleh menjadi unhandled rejection.
  const report = onError ?? ((err) => console.error('Navigasi gagal', err));

  const resolve = () => {
    const route = resolveRoute(window.location.hash, routes, fallback);
    // Hash non-route: pertahankan route saat ini; saat start belum ada route → fallback.
    const target = route ?? (current ? null : routes.find((r) => r.path === fallback));
    if (!target) return;
    current = target;
    let result;
    try {
      result = onChange(target);
    } catch (err) {
      report(err);
      return;
    }
    Promise.resolve(result).catch(report);
  };
  window.addEventListener('hashchange', resolve);
  return { start: resolve };
}
