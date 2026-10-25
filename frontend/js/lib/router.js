// Router berbasis hash: #/overview, #/screener, ...

/**
 * Menerjemahkan hash menjadi route. Hash kosong → fallback; path tak dikenal → fallback.
 * Fragmen biasa yang bukan route (mis. #main dari skip link) mengembalikan null agar diabaikan.
 * @param {string} hash nilai window.location.hash
 * @param {Array<{ path: string }>} routes
 * @param {string} fallback
 */
export function resolveRoute(hash, routes, fallback) {
  if (hash && !hash.startsWith('#/')) return null;
  const path = hash.replace(/^#/, '') || fallback;
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
