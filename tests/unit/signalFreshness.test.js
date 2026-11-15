import { describe, expect, it } from 'vitest';
import { candleCloseClock, signalFreshness } from '../../frontend/js/views/signalFormat.js';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

describe('kesegaran kolom "Update" scanner (frontend)', () => {
  it('UNIT-FRS-001 umur ≤ 2 candle + 2 menit = segar; lewat batas = basi (per timeframe)', () => {
    expect(signalFreshness({ timeframe: '5m', updatedAt: NOW - 12 * MIN }, NOW)).toEqual({ stale: false, fresh: false, ageMs: 12 * MIN, staleAfterMs: 12 * MIN });
    expect(signalFreshness({ timeframe: '5m', updatedAt: NOW - 12 * MIN - 1 }, NOW).stale).toBe(true);
    expect(signalFreshness({ timeframe: '15m', updatedAt: NOW - 20 * MIN }, NOW).stale).toBe(false);
    expect(signalFreshness({ timeframe: '15m', updatedAt: NOW - 33 * MIN }, NOW).stale).toBe(true);
    expect(signalFreshness({ timeframe: '1h', updatedAt: NOW - 59 * MIN }, NOW).stale).toBe(false);
    // Kasus laporan: sinyal 1h yang terakhir dievaluasi 4 jam lalu → basi.
    expect(signalFreshness({ timeframe: '1h', updatedAt: NOW - 240 * MIN }, NOW)).toMatchObject({ stale: true, ageMs: 240 * MIN });
  });

  it('UNIT-FRS-002 data kosong / timeframe tak dikenal tidak pernah ditandai basi; jam klien di belakang → umur 0', () => {
    expect(signalFreshness({ timeframe: '5m', updatedAt: null }, NOW)).toEqual({ stale: false, fresh: false, ageMs: null, staleAfterMs: null });
    expect(signalFreshness({ timeframe: '4h', updatedAt: NOW - 1e9 }, NOW)).toMatchObject({ stale: false, staleAfterMs: null });
    expect(signalFreshness(undefined, NOW).stale).toBe(false);
    expect(signalFreshness({ timeframe: '5m', updatedAt: NOW + 5_000 }, NOW)).toMatchObject({ stale: false, ageMs: 0 });
  });

  it('UNIT-FRS-003 "Terbaru" = sudah dievaluasi pada candle terakhir yang tutup (≤ 1 candle + 2 menit); jam tutup candle WIB', () => {
    // Kasus laporan pengguna: candle 1h tutup 17:00 WIB, dilihat 17:36 WIB → terbaru (bukan "36 menit lalu" yang tampak basi).
    const close1h = Date.UTC(2026, 10, 15, 10, 0, 0) - 1; // 16:59:59.999 WIB = candle 16:00–17:00
    expect(candleCloseClock(close1h)).toBe('17:00');
    expect(signalFreshness({ timeframe: '1h', updatedAt: close1h }, close1h + 36 * MIN)).toMatchObject({ fresh: true, stale: false });
    expect(signalFreshness({ timeframe: '1h', updatedAt: close1h }, close1h + 62 * MIN).fresh).toBe(true);
    // Lewat 1 candle + kelonggaran tanpa evaluasi baru → bukan terbaru (teks relatif), belum basi.
    expect(signalFreshness({ timeframe: '1h', updatedAt: close1h }, close1h + 62 * MIN + 1)).toMatchObject({ fresh: false, stale: false });
    expect(signalFreshness({ timeframe: '15m', updatedAt: NOW - 17 * MIN }, NOW).fresh).toBe(true);
    expect(signalFreshness({ timeframe: '15m', updatedAt: NOW - 17 * MIN - 1 }, NOW).fresh).toBe(false);
    expect(signalFreshness({ timeframe: '4h', updatedAt: NOW }, NOW).fresh).toBe(false);
  });
});
