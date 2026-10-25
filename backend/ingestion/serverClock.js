// Jam yang disinkronkan dengan waktu server Binance (GET /fapi/v1/time).
//
// Mengapa: validasi candle ("tertutup" bila now > closeTime), isClosed kline REST, rencana backfill,
// dan sweep kesegaran semuanya membandingkan closeTime Binance dengan jam lokal. Bila jam lokal
// lebih cepat, kline final WebSocket ditolak sebagai "belum tertutup"; bila lebih lambat, candle yang
// masih berjalan bisa dianggap tertutup. Jam ini mengoreksi jam lokal dengan offset terukur.
//
// Pengukuran: offset = serverTime − titik tengah round-trip (sentAt + RTT/2), dibulatkan ke ms.
// Aturan keamanan:
// - Sinkronisasi gagal (jaringan/HTTP/body) → offset terakhir dipertahankan (awal 0); tidak pernah throw.
// - RTT > maxRoundTripMs (mis. request sempat di-retry/backoff) → sampel dibuang (ketidakpastian RTT/2 terlalu besar).
// - |offset terukur| > maxOffsetMs (default 10 menit) → TIDAK diterapkan: offset sebesar itu hampir pasti
//   berarti jam host rusak (perbaiki NTP) atau respons tidak wajar; menerapkannya diam-diam akan
//   menggeser semua stempel waktu. Hasil sync melaporkannya agar worker mencatat error ingesti.
// - Offset baru boleh membuat now() mundur beberapa ms; pemakai jam ini tidak bergantung pada monotonisitas.
// Semua I/O lewat `getServerTime` injeksi; `clock` = jam lokal (default Date.now).

export const SERVER_CLOCK_DEFAULTS = Object.freeze({
  maxOffsetMs: 10 * 60_000,
  maxRoundTripMs: 5_000,
});

export const CLOCK_SYNC_FAILURES = Object.freeze(['REQUEST_FAILED', 'BAD_RESPONSE', 'ROUND_TRIP_TOO_LONG', 'OFFSET_OUT_OF_RANGE']);

const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const MESSAGE_MAX = 300;

const errorText = (err) => String(err?.message ?? err).slice(0, MESSAGE_MAX);

/**
 * @param {{ getServerTime: () => Promise<number>, clock?: () => number, logger?: object,
 *   maxOffsetMs?: number, maxRoundTripMs?: number }} deps
 *   getServerTime: biasanya `() => rest.getServerTime()` — dipanggil malas, sehingga klien REST boleh
 *   dibuat SETELAH jam ini dan memakai `serverClock.now` sebagai jamnya (tanpa dependensi melingkar).
 * @returns {{ now(): number, offsetMs(): number, lastSync(): object|null,
 *   sync(): Promise<{ ok: boolean, offsetMs: number, measuredOffsetMs: number|null, roundTripMs: number|null,
 *     reason?: string, message?: string }> }}
 */
export function createServerClock({
  getServerTime,
  clock = Date.now,
  logger = NOOP_LOGGER,
  maxOffsetMs = SERVER_CLOCK_DEFAULTS.maxOffsetMs,
  maxRoundTripMs = SERVER_CLOCK_DEFAULTS.maxRoundTripMs,
} = {}) {
  if (typeof getServerTime !== 'function') throw new TypeError('getServerTime wajib fungsi');
  if (typeof clock !== 'function') throw new TypeError('clock wajib fungsi');
  if (!Number.isInteger(maxOffsetMs) || maxOffsetMs < 0) throw new RangeError('maxOffsetMs harus bilangan bulat ≥ 0');
  if (!Number.isInteger(maxRoundTripMs) || maxRoundTripMs < 0) throw new RangeError('maxRoundTripMs harus bilangan bulat ≥ 0');

  let offset = 0;
  let last = null;
  let inflight = null;

  function finish(result) {
    last = { at: clock() + offset, ...result };
    if (result.ok) {
      logger.debug?.({ offsetMs: result.offsetMs, roundTripMs: result.roundTripMs }, 'jam server Binance tersinkron');
    } else {
      logger.warn?.({ reason: result.reason, offsetMs: result.offsetMs, measuredOffsetMs: result.measuredOffsetMs,
        roundTripMs: result.roundTripMs }, 'sinkronisasi jam server gagal, offset terakhir dipakai');
    }
    return result;
  }

  const fail = (reason, message, extra = {}) => finish({
    ok: false, reason, message, offsetMs: offset, measuredOffsetMs: null, roundTripMs: null, ...extra,
  });

  async function measure() {
    const sentAt = clock();
    let serverTime;
    try {
      serverTime = await getServerTime();
    } catch (err) {
      return fail('REQUEST_FAILED', `sinkronisasi jam server gagal: ${errorText(err)}`);
    }
    const receivedAt = clock();
    if (!Number.isSafeInteger(serverTime) || serverTime <= 0) {
      return fail('BAD_RESPONSE', 'sinkronisasi jam server gagal: serverTime tidak valid');
    }
    const roundTripMs = receivedAt - sentAt;
    if (roundTripMs < 0 || roundTripMs > maxRoundTripMs) {
      return fail('ROUND_TRIP_TOO_LONG', `sinkronisasi jam server dilewati: round-trip ${roundTripMs} ms > ${maxRoundTripMs} ms`, { roundTripMs });
    }
    const measuredOffsetMs = Math.round(serverTime - (sentAt + roundTripMs / 2));
    if (Math.abs(measuredOffsetMs) > maxOffsetMs) {
      return fail('OFFSET_OUT_OF_RANGE',
        `selisih jam lokal vs server ${measuredOffsetMs} ms melebihi batas ±${maxOffsetMs} ms; tidak diterapkan (periksa NTP host)`,
        { measuredOffsetMs, roundTripMs });
    }
    offset = measuredOffsetMs;
    return finish({ ok: true, offsetMs: offset, measuredOffsetMs, roundTripMs });
  }

  return {
    /** Waktu sekarang menurut server (jam lokal + offset terakhir yang diterima). */
    now: () => clock() + offset,
    /** Offset terakhir yang diterapkan (ms; positif = server di depan jam lokal). */
    offsetMs: () => offset,
    /** Hasil sinkronisasi terakhir (null bila belum pernah). */
    lastSync: () => (last ? { ...last } : null),
    /** Ukur ulang offset. Tidak pernah reject; panggilan bersamaan berbagi satu request. */
    sync() {
      inflight ??= measure().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
