import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALPHA_CAPS,
  NODE_LIMITS,
  alphaLevel,
  isCoarsePointer,
  isEmptyAreaTarget,
  pickDpr,
  pickFps,
  spontaneousRate,
  buildGrid,
  canLink,
  createGraph,
  createRng,
  emitPulses,
  mountNeuralBackground,
  neighbors,
  nextHop,
  nodeCountFor,
  parseColor,
  readMotionPreference,
  resizeGraph,
  resolvePalette,
  rippleAt,
  stepGraph,
  writeMotionPreference,
} from '../../frontend/js/lib/neural.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const snapshot = (g) => g.nodes.map((n) => [n.x, n.y, n.vx, n.vy, n.z, n.glow]);

function bruteNeighbors(nodes, i, r) {
  const out = [];
  for (let j = 0; j < nodes.length; j += 1) {
    if (j === i) continue;
    if (Math.hypot(nodes[j].x - nodes[i].x, nodes[j].y - nodes[i].y) <= r) out.push(j);
  }
  return out;
}

describe('neural — graf murni', () => {
  it('UNIT-NEU-001 rng ber-seed sama → graf & simulasi identik (deterministik)', () => {
    const a = createGraph(1280, 800, 80, createRng(42));
    const b = createGraph(1280, 800, 80, createRng(42));
    expect(snapshot(a)).toEqual(snapshot(b));
    for (let k = 0; k < 200; k += 1) {
      if (k === 50) {
        emitPulses(a, 'bull', 5);
        emitPulses(b, 'bull', 5);
      }
      stepGraph(a, 16, 1280, 800);
      stepGraph(b, 16, 1280, 800);
    }
    expect(snapshot(a)).toEqual(snapshot(b));
    expect(a.pulses).toEqual(b.pulses);
    const c = createGraph(1280, 800, 80, createRng(7));
    expect(snapshot(c)).not.toEqual(snapshot(createGraph(1280, 800, 80, createRng(42))));
  });

  it('UNIT-NEU-002 node tetap di dalam batas setelah banyak step (termasuk tarikan kursor & dt ekstrem)', () => {
    const g = createGraph(900, 600, 90, createRng(3));
    g.pointer = { x: 10, y: 590, active: true };
    g.targetActivity = 1;
    for (let k = 0; k < 3000; k += 1) stepGraph(g, k % 97 === 0 ? 5000 : 16, 900, 600);
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(900);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(600);
      expect(Number.isFinite(n.vx) && Number.isFinite(n.vy)).toBe(true);
    }
  });

  it('UNIT-NEU-003 tetangga via spatial grid sama dengan brute force (berbagai radius & ukuran sel)', () => {
    const g = createGraph(1600, 1000, 180, createRng(11));
    for (const [cell, radius] of [[150, 150], [60, 150], [200, 90], [40, 40]]) {
      const grid = buildGrid(g.nodes, cell);
      for (let i = 0; i < g.nodes.length; i += 1) {
        const brute = bruteNeighbors(g.nodes, i, radius);
        expect(neighbors(grid, g.nodes, i, radius)).toEqual(brute);
        // Jalur render (sorted=false): himpunan sama, urutan bebas.
        expect([...neighbors(grid, g.nodes, i, radius, [], false)].sort((a, b) => a - b)).toEqual(brute);
      }
    }
  });

  it('UNIT-NEU-004 jumlah node mengikuti luas layar dengan batas min/maks', () => {
    expect(nodeCountFor(1400, 1000)).toBe(156);
    expect(nodeCountFor(1440, 900)).toBe(144);
    expect(nodeCountFor(1920, 1080)).toBe(Math.min(NODE_LIMITS.max, Math.round((1920 * 1080) / 9000)));
    expect(nodeCountFor(3840, 2160)).toBe(NODE_LIMITS.max);
    expect(nodeCountFor(200, 200)).toBe(NODE_LIMITS.min);
    expect(nodeCountFor(0, 0)).toBe(NODE_LIMITS.min);
    expect(nodeCountFor(390, 2400)).toBeLessThanOrEqual(NODE_LIMITS.mobileMax);
    expect(nodeCountFor(1400, 1000, 0.5)).toBe(78);
    expect(nodeCountFor(1400, 1000, Number.NaN)).toBe(156);
    expect(createGraph(1400, 1000, nodeCountFor(1400, 1000), createRng(1)).nodes).toHaveLength(156);
  });

  it('UNIT-NEU-005 routing pulsa tidak pernah keluar dari graf & hanya lewat edge sah', () => {
    const g = createGraph(1200, 800, 100, createRng(5));
    emitPulses(g, 'accent', 12);
    rippleAt(g, 600, 400, 'bear', 6);
    expect(g.pulses.length).toBeGreaterThan(0);
    let seen = 0;
    for (let k = 0; k < 1500; k += 1) {
      if (k % 40 === 0) emitPulses(g, k % 80 === 0 ? 'bull' : 'bear', 3);
      stepGraph(g, 16, 1200, 800);
      for (const p of g.pulses) {
        seen += 1;
        expect(Number.isInteger(p.a) && p.a >= 0 && p.a < g.nodes.length).toBe(true);
        expect(Number.isInteger(p.b) && p.b >= 0 && p.b < g.nodes.length).toBe(true);
        expect(p.a).not.toBe(p.b);
        expect(p.t).toBeGreaterThanOrEqual(0);
        expect(p.t).toBeLessThan(1);
        expect(p.hops).toBeGreaterThanOrEqual(0);
        expect(['cyan', 'violet', 'bull', 'bear']).toContain(p.key);
      }
      expect(g.pulses.length).toBeLessThanOrEqual(90);
    }
    expect(seen).toBeGreaterThan(0);
    // nextHop: hasil selalu tetangga sah atau -1; tak pernah kembali ke asal.
    const grid = buildGrid(g.nodes, g.linkDist);
    g.grid = grid;
    for (let i = 0; i < g.nodes.length; i += 1) {
      const prev = neighbors(grid, g.nodes, i, g.linkDist)[0] ?? -1;
      const j = nextHop(g, i, prev);
      if (j === -1) continue;
      expect(j).not.toBe(prev);
      expect(Math.hypot(g.nodes[j].x - g.nodes[i].x, g.nodes[j].y - g.nodes[i].y)).toBeLessThanOrEqual(g.linkDist);
      expect(canLink(g.nodes[i], g.nodes[j])).toBe(true);
    }
    expect(nextHop(g, 9999)).toBe(-1);
  });

  it('UNIT-NEU-006 resizeGraph menskalakan posisi, menyesuaikan jumlah, dan membuang pulsa yatim', () => {
    const g = createGraph(1600, 900, 120, createRng(9));
    emitPulses(g, 'accent', 20);
    resizeGraph(g, 400, 800, 40);
    expect(g.nodes).toHaveLength(40);
    for (const n of g.nodes) {
      expect(n.x).toBeLessThanOrEqual(400);
      expect(n.y).toBeLessThanOrEqual(800);
    }
    for (const p of g.pulses) expect(p.a < 40 && p.b < 40).toBe(true);
    resizeGraph(g, 1000, 1000, 70);
    expect(g.nodes).toHaveLength(70);
  });

  it('UNIT-NEU-007 warna: parseColor & resolvePalette fallback aman', () => {
    expect(parseColor('#38e1ff')).toEqual([56, 225, 255]);
    expect(parseColor(' #fff ')).toEqual([255, 255, 255]);
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
    expect(parseColor('bukan-warna')).toBeNull();
    const pal = resolvePalette((name) => (name === '--lr-bull' ? '#00ff00' : ''));
    expect(pal.bull).toEqual([0, 255, 0]);
    expect(pal.bear).toEqual([241, 107, 117]);
    expect(resolvePalette(() => { throw new Error('x'); }).cyan).toEqual([56, 225, 255]);
  });
});

describe('neural — anggaran performa & kecerahan', () => {
  it('UNIT-NEU-010 pickDpr: maks 2, 1.5 bila > 4.5 MPx, 1 pada perangkat lemah', () => {
    expect(pickDpr(1280, 800, 3, 8, 8)).toBe(2);
    expect(pickDpr(1920, 1080, 2, 8, 8)).toBe(1.5); // 8.3 MPx
    expect(pickDpr(1280, 800, 2, 4, 8)).toBe(1);
    expect(pickDpr(1280, 800, 2, 8, 4)).toBe(1);
    expect(pickDpr(1280, 800, Number.NaN)).toBe(1);
    expect(pickDpr(1280, 800, 2)).toBe(2); // info perangkat tak tersedia → tidak diturunkan
  });

  it('UNIT-NEU-011 pickFps: default 45, turun ke 30 bila lambat atau aktivitas < 0.3', () => {
    expect(pickFps(45, 0.8, false)).toBe(45);
    expect(pickFps(45, 0.25, false)).toBe(30);
    expect(pickFps(45, 0.9, true)).toBe(30);
    expect(pickFps(undefined, 0.5)).toBe(45);
    expect(pickFps(20, 0.1)).toBe(20);
  });

  it('UNIT-NEU-012 alpha garis dibatasi & nyala node padam dalam ±300ms', () => {
    expect(alphaLevel(0)).toBe(1);
    expect(alphaLevel(ALPHA_CAPS.line)).toBe(6);
    expect(alphaLevel(5)).toBe(6);
    expect(ALPHA_CAPS.line).toBeLessThanOrEqual(0.42);
    expect(ALPHA_CAPS.node).toBeLessThanOrEqual(0.7);
    expect(ALPHA_CAPS.glow).toBeLessThanOrEqual(1);
    expect(ALPHA_CAPS.cursor).toBeLessThanOrEqual(0.2);
    const g = createGraph(800, 600, 40, createRng(2));
    g.targetActivity = 0;
    g.activity = 0;
    g.nodes[0].glow = 1;
    for (let k = 0; k < 30; k += 1) stepGraph(g, 16, 800, 600); // 480ms
    expect(g.nodes[0].glow).toBeLessThan(0.15);
  });

  it('UNIT-NEU-015 laju pulsa spontan: ±1 per 1.2 dtk pada 0.25, ±3/dtk pada 0.8', () => {
    expect(spontaneousRate(0.25)).toBeCloseTo(1 / 1.2, 1);
    expect(spontaneousRate(0.8)).toBeCloseTo(3, 1);
    expect(spontaneousRate(0)).toBeGreaterThan(0);
    expect(spontaneousRate(Number.NaN)).toBe(spontaneousRate(0));
    // Empiris: 60 dtk simulasi pada aktivitas 0.8 memancarkan ±180 pulsa spontan.
    const g = createGraph(1440, 900, 144, createRng(4));
    g.activity = 0.8;
    g.targetActivity = 0.8;
    let spawned = 0;
    const origPush = g.pulses.push.bind(g.pulses);
    g.pulses.push = (...items) => { spawned += items.length; return origPush(...items); };
    for (let k = 0; k < 3750; k += 1) stepGraph(g, 16, 1440, 900);
    expect(spawned).toBeGreaterThan(120);
    expect(spawned).toBeLessThan(240);
  });

  it('UNIT-NEU-013 riak hanya di area kosong; pointer sentuh diabaikan untuk parallax', () => {
    const el = (hit) => ({ closest: (sel) => (hit && sel.includes(hit) ? {} : null) });
    expect(isEmptyAreaTarget(el(null))).toBe(true);
    expect(isEmptyAreaTarget(el('.app'))).toBe(false);
    expect(isEmptyAreaTarget(el('.auth-card'))).toBe(false);
    expect(isEmptyAreaTarget(el('button'))).toBe(false);
    expect(isEmptyAreaTarget(null)).toBe(true);
    expect(isEmptyAreaTarget({ closest: () => { throw new Error('x'); } })).toBe(false);
    expect(isCoarsePointer({ pointerType: 'touch' })).toBe(true);
    expect(isCoarsePointer({ pointerType: 'mouse' })).toBe(false);
    expect(isCoarsePointer({ pointerType: 'mouse' }, true)).toBe(true);
  });
});

describe('neural — preferensi gerak & mount', () => {
  it('UNIT-NEU-008 readMotionPreference/writeMotionPreference aman tanpa window', () => {
    expect(typeof globalThis.window).toBe('undefined');
    expect(readMotionPreference()).toBe('reduced');
    expect(writeMotionPreference('on')).toBe('reduced');
    const api = mountNeuralBackground(null);
    expect(() => { api.pulse('bull'); api.setActivity(1); api.setMotion('off'); api.resize(); api.destroy(); }).not.toThrow();
  });

  it('UNIT-NEU-009 localStorage menang atas matchMedia; error penyimpanan tidak melempar', () => {
    const store = new Map();
    const docEl = { dataset: {} };
    let reduce = true;
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
      },
      matchMedia: () => ({ matches: reduce }),
      document: { documentElement: docEl },
    });
    expect(readMotionPreference()).toBe('reduced');
    reduce = false;
    expect(readMotionPreference()).toBe('on');
    expect(writeMotionPreference('off')).toBe('off');
    expect(store.get('lr.motion')).toBe('off');
    expect(docEl.dataset.motion).toBe('off');
    expect(readMotionPreference()).toBe('off');
    expect(writeMotionPreference('on')).toBe('on');
    expect(readMotionPreference()).toBe('on');

    vi.stubGlobal('window', {
      get localStorage() { throw new Error('diblokir'); },
      matchMedia: () => { throw new Error('tak didukung'); },
    });
    expect(readMotionPreference()).toBe('on');
    expect(() => writeMotionPreference('off')).not.toThrow();
  });

  it('UNIT-NEU-014 saveData → default reduced bila belum ada pilihan tersimpan', () => {
    const store = new Map();
    vi.stubGlobal('window', {
      localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
      matchMedia: () => ({ matches: false }),
      navigator: { connection: { saveData: true } },
    });
    expect(readMotionPreference()).toBe('reduced');
    store.set('lr.motion', 'on');
    expect(readMotionPreference()).toBe('on');
  });
});
