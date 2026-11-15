// Penanda geser horizontal. Wadah yang lebih sempit dari isinya diberi data-overflow = "start", "end", atau
// "start end" menurut arah konten yang masih tersembunyi; CSS memudarkan tepi itu (components.css). Ponsel
// menyembunyikan scrollbar, jadi tanpa penanda kolom di sebelah kanan mudah terlewat. Tanpa ResizeObserver
// (mis. lingkungan uji non-browser) tidak ada penanda dan konten tetap utuh.

const EPSILON_PX = 1;

/**
 * Arah konten tersembunyi dari ukuran gulir sebuah wadah.
 * @param {{ scrollLeft: number, scrollWidth: number, clientWidth: number }} box
 * @returns {'' | 'start' | 'end' | 'start end'}
 */
export function overflowState({ scrollLeft, scrollWidth, clientWidth }) {
  const max = scrollWidth - clientWidth;
  if (!(max > EPSILON_PX)) return '';
  const parts = [];
  if (scrollLeft > EPSILON_PX) parts.push('start');
  if (scrollLeft < max - EPSILON_PX) parts.push('end');
  return /** @type {'' | 'start' | 'end' | 'start end'} */ (parts.join(' '));
}

/**
 * Pasang penanda pada wadah gulir (dan isi pertamanya, mis. tabel yang melebar saat baris dirender ulang).
 * Pengamat dilepas sendiri setelah wadah yang pernah tampil dikeluarkan dari dokumen.
 * @param {HTMLElement} el
 * @returns {() => void} pelepas manual
 */
export function attachScrollHint(el) {
  if (typeof ResizeObserver !== 'function' || typeof requestAnimationFrame !== 'function') return () => {};
  let frame = 0;
  let shown = false;
  let ro = null;
  const update = () => {
    frame = 0;
    const state = overflowState(el);
    if (state) el.dataset.overflow = state;
    else delete el.dataset.overflow;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const stop = () => {
    ro?.disconnect();
    el.removeEventListener('scroll', schedule);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  ro = new ResizeObserver(() => {
    if (el.isConnected) shown = true;
    else if (shown) {
      stop();
      return;
    }
    schedule();
  });
  ro.observe(el);
  if (el.firstElementChild) ro.observe(el.firstElementChild);
  el.addEventListener('scroll', schedule, { passive: true });
  return stop;
}
