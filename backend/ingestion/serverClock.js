// Jam yang disinkronkan dengan waktu server Binance (GET /fapi/v1/time).
//
// Mengapa: validasi candle ("tertutup" bila now > closeTime), isClosed kline REST, rencana backfill,
// dan sweep kesegaran semuanya membandingkan closeTime Binance dengan jam lokal. Bila jam lokal
// lebih cepat, kline final WebSocket ditolak sebagai "belum tertutup"; bila lebih lambat, candle yang
// masih berjalan bisa dianggap tertutup. Jam ini mengoreksi jam lokal dengan offset terukur.
//
// Pengukuran: offset = serverTime − titik tengah round-trip (sentAt + RTT/2), dibulatkan ke ms. Rumus ini
// mengandaikan server membaca jamnya di tengah round-trip, sehingga galat maksimum = RTT/2. Karena itu:
// - Sampel sebaiknya berupa SATU percobaan HTTP dengan stempel sentAt/receivedAt di sekitar fetch itu saja
//   (`rest.sampleServerTime`): antrean limiter, Retry-After, backoff, dan retry terjadi SEBELUM request
//   yang berhasil dan akan menggeser titik tengah bila ikut terukur. Bila `getServerTime` hanya
//   mengembalikan angka, RTT diukur di sekitar panggilannya (mencakup semua jeda di dalamnya).
// - Percobaan yang gagal dengan error retryable (atau RTT terlalu panjang) diulang sebagai sampel BARU,
//   maks `maxAttempts` per sync; tiap sampel diukur sendiri, jadi jeda antarpercobaan tidak memengaruhi offset.
// Aturan keamanan:
// - Sinkronisasi gagal (jaringan/HTTP/body) → offset terakhir dipertahankan (awal 0); tidak pernah throw.
// - RTT > maxRoundTripMs (default 1 detik, galat ≤ 500 ms) → sampel dibuang.
// - |offset terukur| > maxOffsetMs (default 10 menit) → TIDAK diterapkan: offset sebesar itu hampir pasti
//   berarti jam host rusak (perbaiki NTP) atau respons tidak wajar; menerapkannya diam-diam akan
//   menggeser semua stempel waktu. Hasil sync melaporkannya agar worker mencatat error ingesti.
// - Offset baru boleh membuat now() mundur beberapa ms; pemakai jam ini tidak bergantung pada monotonisitas.
// Jam acuan penutupan (`closureNow`, untuk keputusan "candle sudah tertutup": isClosed kline REST & rencana
// backfill/sweep): sama dengan now(), KECUALI jam diketahui salah dan sampel menunjukkan server di BELAKANG —
// OFFSET_OUT_OF_RANGE, atau ROUND_TRIP_TOO_LONG selama belum pernah ada sync berhasil (atau sejak
// OFFSET_OUT_OF_RANGE). Saat itu dipakai batas bawah waktu server dari sampel terakhir
// (serverTime − receivedAt: server sudah membaca jamnya sebelum respons diterima), maks. offset terpakai.
// Hanya bisa membuat lebih SEDIKIT candle dianggap tertutup (tidak pernah menyimpan candle berjalan
// sebagai final); stempel waktu tetap memakai now(). Bersih kembali pada sync berikutnya yang berhasil.
// Semua I/O lewat `getServerTime` injeksi; `clock` = jam lokal (default Date.now).

export const SERVER_CLOCK_DEFAULTS = Object.freeze({
  maxOffsetMs: 10 * 60_000,
  maxRoundTripMs: 1_000,
  maxAttempts: 3,
});

export const CLOCK_SYNC_FAILURES = Object.freeze(['REQUEST_FAILED', 'BAD_RESPONSE', 'ROUND_TRIP_TOO_LONG', 'OFFSET_OUT_OF_RANGE']);

const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const MESSAGE_MAX = 300;

const errorText = (err) => String(err?.message ?? err).slice(0, MESSAGE_MAX);

/**
 * @param {{ getServerTime: (opts: { clock: () => number }) => Promise<number | { serverTime: number, sentAt: number, receivedAt: number }>,
 *   clock?: () => number, logger?: object, maxOffsetMs?: number, maxRoundTripMs?: number, maxAttempts?: number }} deps
 *   getServerTime: biasanya `(opts) => rest.sampleServerTime(opts)` — dipanggil malas dengan `{ clock }` (jam
 *   lokal ini), sehingga klien REST boleh dibuat SETELAH jam ini dan memakai `serverClock.now` sebagai jamnya.
 *   Mengembalikan sampel `{ serverTime, sentAt, receivedAt }` (stempel dengan `clock` yang diberikan, di
 *   dalam rentang panggilan) atau angka serverTime saja (RTT = durasi panggilan).
 *   maxAttempts: jumlah sampel maksimum per sync; diulang hanya bila error tidak bertanda `retryable: false`
 *   atau RTT terlalu panjang.
 * @returns {{ now(): number, closureNow(): number, offsetMs(): number, lastSync(): object|null,
 *   sync(): Promise<{ ok: boolean, offsetMs: number, measuredOffsetMs: number|null, roundTripMs: number|null,
 *     reason?: string, message?: string }> }}
 */
export function createServerClock({
  getServerTime,
  clock = Date.now,
  logger = NOOP_LOGGER,
  maxOffsetMs = SERVER_CLOCK_DEFAULTS.maxOffsetMs,
  maxRoundTripMs = SERVER_CLOCK_DEFAULTS.maxRoundTripMs,
  maxAttempts = SERVER_CLOCK_DEFAULTS.maxAttempts,
} = {}) {
  if (typeof getServerTime !== 'function') throw new TypeError('getServerTime wajib fungsi');
  if (typeof clock !== 'function') throw new TypeError('clock wajib fungsi');
  if (!Number.isInteger(maxOffsetMs) || maxOffsetMs < 0) throw new RangeError('maxOffsetMs harus bilangan bulat ≥ 0');
  if (!Number.isInteger(maxRoundTripMs) || maxRoundTripMs < 0) throw new RangeError('maxRoundTripMs harus bilangan bulat ≥ 0');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new RangeError('maxAttempts harus bilangan bulat 1..10');

  let offset = 0;
  let last = null;
  let inflight = null;
  let everSynced = false;
  /** Batas bawah offset server dari sampel saat jam diketahui salah (lihat closureNow), null bila tidak ada. */
  let closureBound = null;

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

  /** Satu sampel → { ok: true, measuredOffsetMs, roundTripMs } | { ok: false, reason, message, retry, ...extra }. */
  async function sample() {
    const callStart = clock();
    let raw;
    try {
      raw = await getServerTime({ clock });
    } catch (err) {
      return { ok: false, reason: 'REQUEST_FAILED', message: `sinkronisasi jam server gagal: ${errorText(err)}`, retry: err?.retryable !== false };
    }
    const callEnd = clock();
    const timed = raw !== null && typeof raw === 'object';
    const serverTime = timed ? raw.serverTime : raw;
    const sentAt = timed ? raw.sentAt : callStart;
    const receivedAt = timed ? raw.receivedAt : callEnd;
    if (!Number.isSafeInteger(serverTime) || serverTime <= 0) {
      return { ok: false, reason: 'BAD_RESPONSE', message: 'sinkronisasi jam server gagal: serverTime tidak valid', retry: false };
    }
    // Stempel sampel harus berada di dalam rentang panggilan dan berurutan (jam yang sama).
    if (!Number.isSafeInteger(sentAt) || !Number.isSafeInteger(receivedAt)
      || sentAt < callStart || receivedAt < sentAt || receivedAt > callEnd) {
      return { ok: false, reason: 'BAD_RESPONSE', message: 'sinkronisasi jam server gagal: stempel sampel tidak valid', retry: false };
    }
    const roundTripMs = receivedAt - sentAt;
    const lowerBoundOffsetMs = serverTime - receivedAt;
    if (roundTripMs > maxRoundTripMs) {
      return {
        ok: false, reason: 'ROUND_TRIP_TOO_LONG', retry: true, roundTripMs, lowerBoundOffsetMs,
        message: `sinkronisasi jam server dilewati: round-trip ${roundTripMs} ms > ${maxRoundTripMs} ms`,
      };
    }
    return { ok: true, measuredOffsetMs: Math.round(serverTime - (sentAt + roundTripMs / 2)), roundTripMs, lowerBoundOffsetMs };
  }

  async function measure() {
    let s = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      s = await sample();
      if (s.ok || !s.retry) break;
    }
    if (!s.ok) {
      const extra = s.roundTripMs === undefined ? {} : { roundTripMs: s.roundTripMs };
      // Sampel lambat masih memberi batas bawah waktu server; dipakai bila offset terpakai tidak dapat dipercaya.
      if (s.reason === 'ROUND_TRIP_TOO_LONG' && (!everSynced || closureBound !== null)) closureBound = s.lowerBoundOffsetMs;
      return fail(s.reason, s.message, extra);
    }
    const { measuredOffsetMs, roundTripMs } = s;
    if (Math.abs(measuredOffsetMs) > maxOffsetMs) {
      closureBound = s.lowerBoundOffsetMs;
      return fail('OFFSET_OUT_OF_RANGE',
        `selisih jam lokal vs server ${measuredOffsetMs} ms melebihi batas ±${maxOffsetMs} ms; tidak diterapkan (periksa NTP host)`,
        { measuredOffsetMs, roundTripMs });
    }
    offset = measuredOffsetMs;
    everSynced = true;
    closureBound = null;
    return finish({ ok: true, offsetMs: offset, measuredOffsetMs, roundTripMs });
  }

  return {
    /** Waktu sekarang menurut server (jam lokal + offset terakhir yang diterima). */
    now: () => clock() + offset,
    /** Acuan keputusan "candle sudah tertutup": now(), atau batas bawah waktu server bila jam diketahui salah. */
    closureNow: () => clock() + (closureBound === null ? offset : Math.min(offset, closureBound)),
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
