import { describe, expect, it } from 'vitest';
import { EMPTY, formatBytes, formatDuration, formatPrice, formatRelative, formatClock, formatTime } from '../../frontend/js/lib/format.js';

describe('format data finansial', () => {
  it('UNIT-FMT-001 waktu tampilan WIB (UTC+7), termasuk lintas tanggal', () => {
    expect(formatTime(Date.UTC(2026, 9, 25, 13, 5, 9))).toBe('2026-10-25 20:05:09 WIB');
    expect(formatTime(Date.UTC(2026, 9, 25, 18, 0, 0))).toBe('2026-10-26 01:00:00 WIB');
    expect(formatClock(Date.UTC(2026, 9, 25, 23, 59, 1))).toBe('06:59:01 WIB');
  });

  it('EDGE-FMT-001 nilai non-finite ditampilkan sebagai tanda kosong, bukan angka palsu', () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '12']) {
      expect(formatPrice(v)).toBe(EMPTY);
      expect(formatTime(v)).toBe(EMPTY);
    }
  });

  it('EDGE-FMT-002 presisi harga adaptif untuk aset sangat murah', () => {
    expect(formatPrice(0.00001234)).toMatch(/0,00001234/);
    expect(formatPrice(64250.1)).toMatch(/64\.250,1/);
  });

  it('UNIT-FMT-002 bytes, durasi, relatif', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatDuration(3_725)).toBe('1 jam 2 mnt');
    expect(formatDuration(6)).toBe('6 dtk');
    expect(formatDuration(90_061)).toBe('1 hari 1 jam');
    expect(formatRelative(0, 120_000)).toBe('2 menit lalu');
  });
});
