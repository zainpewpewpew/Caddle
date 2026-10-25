import { describe, expect, it } from 'vitest';
import { EMPTY, formatBytes, formatDuration, formatPrice, formatRelative, formatUtc } from '../../frontend/js/lib/format.js';

describe('format data finansial', () => {
  it('UNIT-FMT-001 waktu UTC kanonik', () => {
    expect(formatUtc(Date.UTC(2026, 9, 25, 13, 5, 9))).toBe('2026-10-25 13:05:09 UTC');
  });

  it('EDGE-FMT-001 nilai non-finite ditampilkan sebagai tanda kosong, bukan angka palsu', () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '12']) {
      expect(formatPrice(v)).toBe(EMPTY);
      expect(formatUtc(v)).toBe(EMPTY);
    }
  });

  it('EDGE-FMT-002 presisi harga adaptif untuk aset sangat murah', () => {
    expect(formatPrice(0.00001234)).toMatch(/0,00001234/);
    expect(formatPrice(64250.1)).toMatch(/64\.250,1/);
  });

  it('UNIT-FMT-002 bytes, durasi, relatif', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatDuration(3_725)).toBe('1j 2m');
    expect(formatRelative(0, 120_000)).toBe('2 menit lalu');
  });
});
