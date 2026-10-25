// Router berbasis hash: #/overview, #/screener, ...

export function createRouter({ routes, fallback, onChange }) {
  const resolve = () => {
    const path = window.location.hash.replace(/^#/, '') || fallback;
    const route = routes.find((r) => r.path === path) ?? routes.find((r) => r.path === fallback);
    onChange(route);
  };
  window.addEventListener('hashchange', resolve);
  return { start: resolve };
}
