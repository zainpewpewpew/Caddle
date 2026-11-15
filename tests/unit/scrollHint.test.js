// Penanda geser horizontal (frontend/js/lib/scrollHint.js): arah konten tersembunyi dari ukuran gulir.
import { describe, expect, it } from 'vitest';
import { attachScrollHint, overflowState } from '../../frontend/js/lib/scrollHint.js';

describe('scrollHint', () => {
  it('UNIT-UI-SCROLL-001 overflowState: kosong bila muat, end di awal, start di ujung, keduanya di tengah', () => {
    expect(overflowState({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })).toBe('');
    expect(overflowState({ scrollLeft: 0, scrollWidth: 301, clientWidth: 300 })).toBe(''); // selisih ≤ 1 px: dianggap muat
    expect(overflowState({ scrollLeft: 0, scrollWidth: 600, clientWidth: 300 })).toBe('end');
    expect(overflowState({ scrollLeft: 300, scrollWidth: 600, clientWidth: 300 })).toBe('start');
    expect(overflowState({ scrollLeft: 299.5, scrollWidth: 600, clientWidth: 300 })).toBe('start'); // pembulatan sub-piksel
    expect(overflowState({ scrollLeft: 120, scrollWidth: 600, clientWidth: 300 })).toBe('start end');
  });

  it('UNIT-UI-SCROLL-002 tanpa ResizeObserver (lingkungan non-browser) tidak memasang apa pun', () => {
    const el = { dataset: {}, addEventListener: () => { throw new Error('tidak boleh dipanggil'); } };
    const stop = attachScrollHint(el);
    expect(typeof stop).toBe('function');
    expect(el.dataset).toEqual({});
    stop();
  });
});
