import { describe, expect, it } from 'vitest';
import { SERVER_CLOCK_DEFAULTS, createServerClock } from '../../../backend/ingestion/serverClock.js';

// Jam lokal & "server" palsu yang deterministik (waktu SINTETIS, tanpa jaringan).
const LOCAL = Date.UTC(2027, 0, 1, 0, 0, 0);

/** getServerTime palsu: server berada `skewMs` di depan jam lokal; request memakan `rttMs` (separuh tiap arah). */
function fakeServer({ skewMs = 0, rttMs = 0 } = {}) {
  let local = LOCAL;
  const state = { skewMs, rttMs, fail: null, response: undefined, calls: 0 };
  const clock = () => local;
  const getServerTime = async () => {
    state.calls += 1;
    local += Math.floor(state.rttMs / 2);
    if (state.fail) throw state.fail;
    const serverTime = state.response !== undefined ? state.response : local + state.skewMs;
    local += state.rttMs - Math.floor(state.rttMs / 2);
    return serverTime;
  };
  const advance = (ms) => { local += ms; };
  return { clock, getServerTime, advance, state };
}

function createLogger() {
  const entries = [];
  const at = (level) => (fields, msg) => entries.push({ level, fields, msg });
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, entries };
}

describe('serverClock', () => {
  it('UNIT-SCK-001 server 1200 ms di depan, RTT 0 → offset 1200; now() = jam lokal + 1200', async () => {
    const srv = fakeServer({ skewMs: 1_200 });
    const clock = createServerClock({ getServerTime: srv.getServerTime, clock: srv.clock });
    expect(clock.offsetMs()).toBe(0);
    expect(clock.now()).toBe(LOCAL);
    const r = await clock.sync();
    expect(r).toEqual({ ok: true, offsetMs: 1_200, measuredOffsetMs: 1_200, roundTripMs: 0 });
    expect(clock.offsetMs()).toBe(1_200);
    srv.advance(5_000);
    expect(clock.now()).toBe(LOCAL + 5_000 + 1_200);
  });

  it('UNIT-SCK-002 titik tengah round-trip: server −750 ms, RTT 400 ms → offset −750 (bukan −950/−550)', async () => {
    const srv = fakeServer({ skewMs: -750, rttMs: 400 });
    const clock = createServerClock({ getServerTime: srv.getServerTime, clock: srv.clock });
    const r = await clock.sync();
    expect(r).toMatchObject({ ok: true, offsetMs: -750, roundTripMs: 400 });
    expect(clock.now()).toBe(srv.clock() - 750);
  });

  it('UNIT-SCK-003 sync ulang memperbarui offset (drift 1200 → 900 ms); lastSync mencatat hasil terakhir dengan waktu server', async () => {
    const srv = fakeServer({ skewMs: 1_200 });
    const clock = createServerClock({ getServerTime: srv.getServerTime, clock: srv.clock });
    await clock.sync();
    srv.state.skewMs = 900;
    srv.advance(3_600_000);
    expect((await clock.sync()).offsetMs).toBe(900);
    expect(clock.lastSync()).toEqual({ at: LOCAL + 3_600_000 + 900, ok: true, offsetMs: 900, measuredOffsetMs: 900, roundTripMs: 0 });
  });

  it('NEG-SCK-001 request gagal → tidak reject, offset terakhir (1200) dipertahankan, hasil REQUEST_FAILED + log warn', async () => {
    const srv = fakeServer({ skewMs: 1_200 });
    const { logger, entries } = createLogger();
    const clock = createServerClock({ getServerTime: srv.getServerTime, clock: srv.clock, logger });
    await clock.sync();
    srv.state.fail = Object.assign(new Error('Binance /fapi/v1/time gagal: HTTP 503'), { status: 503 });
    const r = await clock.sync();
    expect(r).toEqual({
      ok: false, reason: 'REQUEST_FAILED', message: 'sinkronisasi jam server gagal: Binance /fapi/v1/time gagal: HTTP 503',
      offsetMs: 1_200, measuredOffsetMs: null, roundTripMs: null,
    });
    expect(clock.offsetMs()).toBe(1_200);
    expect(entries.filter((e) => e.level === 'warn').map((e) => e.msg)).toEqual(['sinkronisasi jam server gagal, offset terakhir dipakai']);
  });

  it('NEG-SCK-002 gagal sejak awal → offset tetap 0 (jam lokal apa adanya)', async () => {
    const srv = fakeServer({ skewMs: 500 });
    srv.state.fail = new Error('kesalahan jaringan');
    const clock = createServerClock({ getServerTime: srv.getServerTime, clock: srv.clock });
    expect(await clock.sync()).toMatchObject({ ok: false, reason: 'REQUEST_FAILED', offsetMs: 0 });
    expect(clock.now()).toBe(srv.clock());
  });

  it('NEG-SCK-003 offset absurd (+11 menit > batas 10 menit) → TIDAK diterapkan, dilaporkan OFFSET_OUT_OF_RANGE dengan nilai terukur', async () => {
    const srv = fakeServer({ skewMs: 300 });
    const clock = createServerClock({ getServerTime: srv.getServerTime, clock: srv.clock });
    await clock.sync();
    srv.state.skewMs = 11 * 60_000;
    const r = await clock.sync();
    expect(r).toMatchObject({ ok: false, reason: 'OFFSET_OUT_OF_RANGE', offsetMs: 300, measuredOffsetMs: 660_000, roundTripMs: 0 });
    expect(r.message).toMatch(/660000 ms melebihi batas ±600000 ms; tidak diterapkan/);
    expect(clock.offsetMs()).toBe(300);
    expect(SERVER_CLOCK_DEFAULTS.maxOffsetMs).toBe(600_000);
  });

  it('EDGE-SCK-001 offset tepat di batas (−10 menit) diterapkan; RTT tepat di batas 5000 ms diterima, 5001 ms dibuang', async () => {
    const srv = fakeServer({ skewMs: -600_000 });
    const clock = createServerClock({ getServerTime: srv.getServerTime, clock: srv.clock });
    expect(await clock.sync()).toMatchObject({ ok: true, offsetMs: -600_000 });

    const rtt = fakeServer({ skewMs: 40, rttMs: 5_000 });
    const c2 = createServerClock({ getServerTime: rtt.getServerTime, clock: rtt.clock });
    expect(await c2.sync()).toMatchObject({ ok: true, offsetMs: 40, roundTripMs: 5_000 });
    rtt.state.rttMs = 5_001;
    rtt.state.skewMs = 900;
    expect(await c2.sync()).toMatchObject({ ok: false, reason: 'ROUND_TRIP_TOO_LONG', offsetMs: 40, roundTripMs: 5_001 });
    expect(c2.offsetMs()).toBe(40);
  });

  it('NEG-SCK-004 serverTime bukan epoch ms (string/NaN/negatif) → BAD_RESPONSE, offset tidak berubah', async () => {
    const srv = fakeServer();
    const clock = createServerClock({ getServerTime: srv.getServerTime, clock: srv.clock });
    for (const response of ['1767225600000', Number.NaN, -5, 1.5]) {
      srv.state.response = response;
      expect(await clock.sync()).toMatchObject({ ok: false, reason: 'BAD_RESPONSE', offsetMs: 0 });
    }
  });

  it('EDGE-SCK-002 sync bersamaan berbagi satu request', async () => {
    const srv = fakeServer({ skewMs: 10 });
    const clock = createServerClock({ getServerTime: srv.getServerTime, clock: srv.clock });
    const [a, b] = await Promise.all([clock.sync(), clock.sync()]);
    expect(a).toBe(b);
    expect(srv.state.calls).toBe(1);
    await clock.sync();
    expect(srv.state.calls).toBe(2);
  });

  it('NEG-SCK-005 dependensi/parameter tidak valid ditolak saat konstruksi', () => {
    expect(() => createServerClock({})).toThrow(TypeError);
    expect(() => createServerClock({ getServerTime: async () => 1, clock: 5 })).toThrow(TypeError);
    expect(() => createServerClock({ getServerTime: async () => 1, maxOffsetMs: -1 })).toThrow(RangeError);
    expect(() => createServerClock({ getServerTime: async () => 1, maxRoundTripMs: 1.5 })).toThrow(RangeError);
  });
});
