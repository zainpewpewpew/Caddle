// Latar "jaringan saraf" animasi (canvas 2D) — murni dekoratif, tanpa angka/data pasar.
//
// Struktur modul:
//  - Fungsi MURNI (tanpa DOM, dapat diuji di Node): createRng, nodeCountFor, createGraph, stepGraph,
//    buildGrid, neighbors, nextHop, spawnPulse, emitPulses, rippleAt, resizeGraph.
//  - Lapisan DOM (mountNeuralBackground, readMotionPreference, writeMotionPreference) hanya menyentuh
//    `window`/`document` DI DALAM fungsi, sehingga modul aman di-import di lingkungan Node (Vitest).

export const MOTION_KEY = 'lr.motion';

/** Batas jumlah node: ≈ luas/9000, min 28, maks 180 (layar sempit maks 80). */
export const NODE_LIMITS = Object.freeze({ min: 28, max: 180, mobileMax: 80, areaPerNode: 9000, mobileWidth: 700 });

/** Kedalaman 3 lapis: jauh → dekat (ukuran, alpha, parallax, kecepatan). */
export const LAYERS = Object.freeze([
  Object.freeze({ share: 0.45, rMin: 0.7, rMax: 1.2, alpha: 0.38, parallax: 0.012, speed: 0.55 }),
  Object.freeze({ share: 0.35, rMin: 1.2, rMax: 1.9, alpha: 0.62, parallax: 0.026, speed: 0.8 }),
  Object.freeze({ share: 0.2, rMin: 2.3, rMax: 3.4, alpha: 0.92, parallax: 0.046, speed: 1 }),
]);

const MAX_PULSES = 90;
const MAX_RIPPLES = 8;
const BASE_SPEED = 0.012; // px/ms
const MAX_SPEED = 0.05;
const POINTER_RADIUS = 170;
const GLOW_TAU = 220; // ms, peluruhan nyala node (terlihat ±400ms)
/** Jumlah ember warna (cyan → violet) untuk batching render. */
export const HUE_BUCKETS = 4;

/** PRNG deterministik (mulberry32). */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Jumlah node untuk ukuran layar tertentu. */
export function nodeCountFor(w, h, density = 1) {
  const area = Math.max(0, w) * Math.max(0, h);
  const d = Number.isFinite(density) && density > 0 ? density : 1;
  const max = w < NODE_LIMITS.mobileWidth ? NODE_LIMITS.mobileMax : NODE_LIMITS.max;
  return clamp(Math.round((area / NODE_LIMITS.areaPerNode) * d), NODE_LIMITS.min, max);
}

/** Jarak maksimum sebuah edge, diskalakan dengan kerapatan node. */
export function linkDistanceFor(w, h, count) {
  const spacing = Math.sqrt((Math.max(1, w) * Math.max(1, h)) / Math.max(1, count));
  return clamp(spacing * 1.5 * 1.35, 120, 230);
}

function pickLayer(r) {
  let acc = 0;
  for (let i = 0; i < LAYERS.length; i += 1) {
    acc += LAYERS[i].share;
    if (r < acc) return i;
  }
  return LAYERS.length - 1;
}

function makeNode(w, h, rng) {
  const z = pickLayer(rng());
  const L = LAYERS[z];
  const ang = rng() * Math.PI * 2;
  const sp = BASE_SPEED * (0.5 + rng()) * L.speed;
  const hue = rng(); // 0 = cyan, 1 = violet
  return {
    x: rng() * w,
    y: rng() * h,
    vx: Math.cos(ang) * sp,
    vy: Math.sin(ang) * sp,
    z,
    r: L.rMin + rng() * (L.rMax - L.rMin),
    hue,
    hb: Math.min(HUE_BUCKETS - 1, Math.floor(hue * HUE_BUCKETS)), // ember warna, dihitung sekali
    phase: rng() * Math.PI * 2,
    glow: 0,
    glowKey: 'cyan',
  };
}

/**
 * Membuat graf awal. `rng` harus fungsi () → [0,1); dengan seed yang sama hasilnya identik.
 * @returns {{nodes:object[], pulses:object[], ripples:object[], w:number, h:number, linkDist:number,
 *            activity:number, targetActivity:number, pointer:{x:number,y:number,active:boolean},
 *            rng:Function, grid:object|null, time:number}}
 */
export function createGraph(w, h, count, rng = Math.random) {
  const n = Math.max(0, Math.floor(count));
  const nodes = [];
  for (let i = 0; i < n; i += 1) nodes.push(makeNode(w, h, rng));
  const graph = {
    nodes,
    pulses: [],
    ripples: [],
    w,
    h,
    linkDist: linkDistanceFor(w, h, n),
    activity: 0.25,
    targetActivity: 0.25,
    pointer: { x: 0, y: 0, active: false },
    rng,
    grid: null,
    time: 0,
  };
  graph.grid = buildGrid(nodes, graph.linkDist);
  return graph;
}

/** Spatial hash grid: Map<kunci sel, indeks node[]>. */
export function buildGrid(nodes, cell) {
  const size = Math.max(1, cell);
  const cells = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    const key = cellKey(Math.floor(nodes[i].x / size), Math.floor(nodes[i].y / size));
    const bucket = cells.get(key);
    if (bucket) bucket.push(i);
    else cells.set(key, [i]);
  }
  return { cell: size, cells };
}

function cellKey(cx, cy) {
  return (cx + 2048) * 8192 + (cy + 2048);
}

/**
 * Indeks tetangga node `i` dalam `radius` (inklusif), kecuali `i` sendiri.
 * Dengan `sorted=true` (default) terurut naik & identik dengan brute force; jalur render memakai
 * `sorted=false` (himpunan sama, tanpa biaya pengurutan).
 */
export function neighbors(grid, nodes, i, radius, out = [], sorted = true) {
  out.length = 0;
  const p = nodes[i];
  if (!p) return out;
  const size = grid.cell;
  const span = Math.max(1, Math.ceil(radius / size));
  const cx = Math.floor(p.x / size);
  const cy = Math.floor(p.y / size);
  const r2 = radius * radius;
  for (let gx = cx - span; gx <= cx + span; gx += 1) {
    for (let gy = cy - span; gy <= cy + span; gy += 1) {
      const bucket = grid.cells.get(cellKey(gx, gy));
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k += 1) {
        const j = bucket[k];
        if (j === i) continue;
        const dx = nodes[j].x - p.x;
        const dy = nodes[j].y - p.y;
        if (dx * dx + dy * dy <= r2) out.push(j);
      }
    }
  }
  if (sorted) out.sort((a, b) => a - b);
  return out;
}

/** Dua node boleh tersambung bila lapisnya bersebelahan (parallax tetap meyakinkan). */
export function canLink(a, b) {
  return Math.abs(a.z - b.z) <= 1;
}

const scratch = [];

/**
 * Memilih hop berikutnya untuk pulsa yang tiba di `from` (datang dari `prev`).
 * Lebih suka tetangga dekat & yang "searah" agar rantai tampak mengalir. -1 bila buntu.
 */
export function nextHop(graph, from, prev = -1, rng = graph.rng) {
  const { nodes } = graph;
  if (!nodes[from]) return -1;
  const grid = graph.grid || buildGrid(nodes, graph.linkDist);
  const list = neighbors(grid, nodes, from, graph.linkDist, scratch);
  const a = nodes[from];
  let dirX = 0;
  let dirY = 0;
  if (prev >= 0 && nodes[prev]) {
    dirX = a.x - nodes[prev].x;
    dirY = a.y - nodes[prev].y;
    const m = Math.hypot(dirX, dirY) || 1;
    dirX /= m;
    dirY /= m;
  }
  let total = 0;
  const weights = [];
  const cands = [];
  for (let k = 0; k < list.length; k += 1) {
    const j = list[k];
    if (j === prev || !canLink(a, nodes[j])) continue;
    const dx = nodes[j].x - a.x;
    const dy = nodes[j].y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const forward = prev >= 0 ? 0.35 + Math.max(0, (dx * dirX + dy * dirY) / d) : 1;
    const wgt = (1 - d / (graph.linkDist + 1)) * forward + 0.02;
    cands.push(j);
    weights.push(wgt);
    total += wgt;
  }
  if (!cands.length) return -1;
  let r = rng() * total;
  for (let k = 0; k < cands.length; k += 1) {
    r -= weights[k];
    if (r <= 0) return cands[k];
  }
  return cands[cands.length - 1];
}

/** Warna pulsa: bull/bear tetap; accent bergantian cyan/violet. */
export function pulseColorKey(kind, rng) {
  if (kind === 'bull' || kind === 'bear') return kind;
  if (kind === 'violet' || kind === 'cyan') return kind;
  return rng() < 0.55 ? 'cyan' : 'violet';
}

/** Memulai rantai pulsa dari node `from`. Mengembalikan true bila berhasil. */
export function spawnPulse(graph, from, kind = 'accent', hops = 4) {
  if (graph.pulses.length >= MAX_PULSES) return false;
  const to = nextHop(graph, from, -1);
  if (to < 0) return false;
  graph.pulses.push({ a: from, b: to, t: 0, hops: Math.max(0, Math.floor(hops)), key: pulseColorKey(kind, graph.rng) });
  return true;
}

/** Memancarkan `count` rantai pulsa dari node acak. Mengembalikan jumlah yang benar-benar terpancar. */
export function emitPulses(graph, kind = 'accent', count = 6) {
  const { nodes, rng } = graph;
  if (!nodes.length) return 0;
  let made = 0;
  const attempts = Math.max(0, count) * 3;
  for (let k = 0; k < attempts && made < count; k += 1) {
    const from = Math.floor(rng() * nodes.length);
    if (spawnPulse(graph, from, kind, 3 + Math.floor(rng() * 4))) {
      nodes[from].glow = 1;
      nodes[from].glowKey = graph.pulses[graph.pulses.length - 1].key;
      made += 1;
    }
  }
  return made;
}

/** Riak lokal (klik/tap): node terdekat menyala & memancarkan pulsa. */
export function rippleAt(graph, x, y, kind = 'accent', count = 5) {
  const { nodes } = graph;
  const R = 240;
  const near = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const d = Math.hypot(nodes[i].x - x, nodes[i].y - y);
    if (d <= R) near.push([d, i]);
  }
  near.sort((p, q) => p[0] - q[0]);
  const key = pulseColorKey(kind, graph.rng);
  if (graph.ripples.length >= MAX_RIPPLES) graph.ripples.shift();
  graph.ripples.push({ x, y, age: 0, life: 1100, key });
  let made = 0;
  for (let k = 0; k < near.length && made < count; k += 1) {
    const i = near[k][1];
    if (spawnPulse(graph, i, key, 2 + Math.floor(graph.rng() * 3))) {
      nodes[i].glow = 1;
      nodes[i].glowKey = key;
      made += 1;
    }
  }
  return made;
}

/**
 * Satu langkah simulasi (murni terhadap `graph`, deterministik terhadap graph.rng).
 * Node selalu dijaga di dalam [0,w]×[0,h].
 */
export function stepGraph(graph, dtMs, w = graph.w, h = graph.h) {
  const dt = clamp(Number.isFinite(dtMs) ? dtMs : 16, 0, 64);
  graph.w = w;
  graph.h = h;
  graph.time += dt;
  const { nodes, rng, pointer } = graph;

  // Aktivitas dihaluskan menuju target.
  graph.activity += (graph.targetActivity - graph.activity) * (1 - Math.exp(-dt / 600));
  const energy = 1 + graph.activity * 0.7;

  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    // Gerak acak halus (wander).
    n.vx += (rng() - 0.5) * 0.0006 * dt * 0.06;
    n.vy += (rng() - 0.5) * 0.0006 * dt * 0.06;
    if (pointer.active) {
      const dx = pointer.x - n.x;
      const dy = pointer.y - n.y;
      const d = Math.hypot(dx, dy);
      if (d > 1 && d < POINTER_RADIUS) {
        const f = (1 - d / POINTER_RADIUS) * 0.00004 * dt * (0.6 + n.z * 0.3);
        n.vx += (dx / d) * f;
        n.vy += (dy / d) * f;
      }
    }
    // Batas kecepatan: jangan diam, jangan liar.
    const sp = Math.hypot(n.vx, n.vy);
    const maxSp = MAX_SPEED * LAYERS[n.z].speed;
    const minSp = BASE_SPEED * 0.35 * LAYERS[n.z].speed;
    if (sp > maxSp) {
      n.vx *= maxSp / sp;
      n.vy *= maxSp / sp;
    } else if (sp < minSp) {
      const ang = sp > 1e-9 ? Math.atan2(n.vy, n.vx) : rng() * Math.PI * 2;
      n.vx = Math.cos(ang) * minSp;
      n.vy = Math.sin(ang) * minSp;
    }
    // Perlambatan ringan setelah tarikan kursor.
    if (sp > BASE_SPEED * 1.6) {
      n.vx *= 0.995;
      n.vy *= 0.995;
    }
    n.x += n.vx * dt * energy;
    n.y += n.vy * dt * energy;
    // Pantul di tepi + clamp.
    if (n.x < 0) { n.x = -n.x; n.vx = Math.abs(n.vx); }
    else if (n.x > w) { n.x = 2 * w - n.x; n.vx = -Math.abs(n.vx); }
    if (n.y < 0) { n.y = -n.y; n.vy = Math.abs(n.vy); }
    else if (n.y > h) { n.y = 2 * h - n.y; n.vy = -Math.abs(n.vy); }
    n.x = clamp(n.x, 0, Math.max(0, w));
    n.y = clamp(n.y, 0, Math.max(0, h));
    n.glow *= Math.exp(-dt / GLOW_TAU);
    if (n.glow < 0.002) n.glow = 0;
  }

  graph.grid = buildGrid(nodes, graph.linkDist);

  // Pulsa merambat; saat tiba, node menyala dan rantai berlanjut.
  const speed = 0.2 * (1 + graph.activity * 0.9); // px/ms
  for (let k = graph.pulses.length - 1; k >= 0; k -= 1) {
    const p = graph.pulses[k];
    const A = nodes[p.a];
    const B = nodes[p.b];
    if (!A || !B) { graph.pulses.splice(k, 1); continue; }
    const len = Math.max(20, Math.hypot(B.x - A.x, B.y - A.y));
    p.t += (dt * speed) / len;
    if (p.t >= 1) {
      B.glow = 1;
      B.glowKey = p.key;
      if (p.hops > 0) {
        const nxt = nextHop(graph, p.b, p.a);
        if (nxt >= 0) {
          p.a = p.b;
          p.b = nxt;
          p.t = 0;
          p.hops -= 1;
          continue;
        }
      }
      graph.pulses.splice(k, 1);
    }
  }

  // Pulsa spontan ∝ aktivitas: ±0.83/dtk pada 0.25, ±3/dtk pada 0.8.
  const ratePerSec = spontaneousRate(graph.activity);
  if (nodes.length && rng() < (ratePerSec * dt) / 1000) {
    const from = Math.floor(rng() * nodes.length);
    if (spawnPulse(graph, from, 'accent', 2 + Math.floor(rng() * 4))) {
      nodes[from].glow = Math.max(nodes[from].glow, 0.7);
      nodes[from].glowKey = graph.pulses[graph.pulses.length - 1].key;
    }
  }

  for (let k = graph.ripples.length - 1; k >= 0; k -= 1) {
    graph.ripples[k].age += dt;
    if (graph.ripples[k].age >= graph.ripples[k].life) graph.ripples.splice(k, 1);
  }
  return graph;
}

/** Laju pulsa spontan (per detik) untuk tingkat aktivitas 0..1. */
export function spontaneousRate(activity) {
  const a = clamp(Number.isFinite(activity) ? activity : 0, 0, 1);
  return Math.max(0.1, -0.15 + 3.94 * a);
}

/** Menyesuaikan graf ke ukuran baru: posisi diskalakan, jumlah node ditambah/dikurangi. */
export function resizeGraph(graph, w, h, count) {
  const sx = graph.w > 0 ? w / graph.w : 1;
  const sy = graph.h > 0 ? h / graph.h : 1;
  for (const n of graph.nodes) {
    n.x = clamp(n.x * sx, 0, w);
    n.y = clamp(n.y * sy, 0, h);
  }
  const target = Math.max(0, Math.floor(count));
  while (graph.nodes.length < target) graph.nodes.push(makeNode(w, h, graph.rng));
  if (graph.nodes.length > target) {
    graph.nodes.length = target;
    graph.pulses = graph.pulses.filter((p) => p.a < target && p.b < target);
  }
  graph.w = w;
  graph.h = h;
  graph.linkDist = linkDistanceFor(w, h, target);
  graph.grid = buildGrid(graph.nodes, graph.linkDist);
  return graph;
}

// ---------------------------------------------------------------------------------------------
// Preferensi gerak (DOM, aman tanpa window)
// ---------------------------------------------------------------------------------------------

function safeWindow() {
  return typeof window === 'undefined' ? null : window;
}

/** 'on' | 'off' | 'reduced'. Pilihan eksplisit pengguna menang; tanpa window → 'reduced' (aman, statis). */
export function readMotionPreference() {
  const win = safeWindow();
  if (!win) return 'reduced';
  let stored;
  try {
    stored = win.localStorage ? win.localStorage.getItem(MOTION_KEY) : null;
  } catch {
    stored = null;
  }
  if (stored === 'off') return 'off';
  if (stored === 'on') return 'on';
  try {
    if (win.navigator && win.navigator.connection && win.navigator.connection.saveData) return 'reduced';
  } catch {
    /* abaikan */
  }
  try {
    if (typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'reduced';
  } catch {
    /* abaikan */
  }
  return 'on';
}

/** Menyimpan 'on'|'off' (selain itu → hapus pilihan), menyetel data-motion, mengembalikan mode efektif. */
export function writeMotionPreference(mode) {
  const win = safeWindow();
  if (!win) return 'reduced';
  try {
    if (mode === 'on' || mode === 'off') win.localStorage.setItem(MOTION_KEY, mode);
    else win.localStorage.removeItem(MOTION_KEY);
  } catch {
    /* penyimpanan diblokir: tetap terapkan untuk sesi ini */
  }
  let effective = readMotionPreference();
  if ((mode === 'on' || mode === 'off') && effective !== mode) effective = mode;
  try {
    if (win.document && win.document.documentElement) win.document.documentElement.dataset.motion = effective;
  } catch {
    /* abaikan */
  }
  return effective;
}

// ---------------------------------------------------------------------------------------------
// Warna (dibaca dari CSS custom property, dengan fallback)
// ---------------------------------------------------------------------------------------------

const FALLBACK = Object.freeze({ cyan: '#38e1ff', violet: '#7c6cff', bull: '#21c58e', bear: '#f16b75' });
const VARS = Object.freeze({ cyan: '--lr-neural-cyan', violet: '--lr-neural-violet', bull: '--lr-bull', bear: '--lr-bear' });

/** Mengurai '#rgb', '#rrggbb', 'rgb(...)' / 'rgba(...)' → [r,g,b] atau null. */
export function parseColor(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return [0, 2, 4].map((o) => parseInt(m[1].slice(o, o + 2), 16));
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [m[1], m[2], m[3]].map((v) => clamp(Math.round(Number(v)), 0, 255));
  return null;
}

/** Membaca palet dari CSS; `getter(name)` → string (diinjeksi agar bisa diuji). */
export function resolvePalette(getter) {
  const out = {};
  for (const key of Object.keys(FALLBACK)) {
    let val;
    try {
      val = getter ? parseColor(getter(VARS[key])) : null;
    } catch {
      val = null;
    }
    out[key] = val || parseColor(FALLBACK[key]);
  }
  return out;
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round);

// ---------------------------------------------------------------------------------------------
// Anggaran performa & kecerahan (murni, dapat diuji)
// ---------------------------------------------------------------------------------------------

/** Batas kecerahan agar latar tidak mengganggu keterbacaan panel. */
export const ALPHA_CAPS = Object.freeze({ line: 0.42, node: 0.7, glow: 1, halo: 0.32, cursor: 0.18, ripple: 0.3 });
const ALPHA_LEVELS = 6;
const MAX_LAYER_ALPHA = LAYERS[LAYERS.length - 1].alpha;

/**
 * DPR adaptif: maks 2; 1.5 bila w·h·dpr² > 4.5 MPx; 1 pada perangkat lemah
 * (hardwareConcurrency ≤ 4 atau deviceMemory ≤ 4).
 */
export function pickDpr(w, h, raw = 1, cores, memory) {
  const dpr = clamp(Number.isFinite(raw) && raw > 0 ? raw : 1, 1, 2);
  if ((Number.isFinite(cores) && cores <= 4) || (Number.isFinite(memory) && memory <= 4)) return 1;
  if (w * h * dpr * dpr > 4.5e6) return Math.min(dpr, 1.5);
  return dpr;
}

/** fps target: default 45; 30 bila perangkat terdeteksi lambat atau aktivitas rendah (< 0.3). */
export function pickFps(base = 45, activity = 0, slow = false) {
  const b = clamp(Number.isFinite(base) ? base : 45, 15, 60);
  return slow || activity < 0.3 ? Math.min(b, 30) : b;
}

/** Ember alpha garis (1..ALPHA_LEVELS) untuk alpha yang sudah dibatasi ALPHA_CAPS.line. */
export function alphaLevel(alpha) {
  return clamp(Math.ceil((alpha / ALPHA_CAPS.line) * ALPHA_LEVELS), 1, ALPHA_LEVELS);
}

/** Pointer yang tidak ikut parallax/garis kursor (sentuh). */
export function isCoarsePointer(e, coarseMedia = false) {
  return coarseMedia || (e && (e.pointerType === 'touch' || e.pointerType === 'pen'));
}

/** Selektor area yang klik-nya TIDAK memicu riak (hanya area kosong). */
export const RIPPLE_IGNORE_SELECTOR = '.app, .auth-card, button, a, input, select, textarea, label, tr, [role="button"]';

/** true bila klik di area kosong (bukan di dalam app/kartu login/elemen interaktif). */
export function isEmptyAreaTarget(target) {
  if (!target || typeof target.closest !== 'function') return true;
  try {
    return !target.closest(RIPPLE_IGNORE_SELECTOR);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Mesin render (DOM)
// ---------------------------------------------------------------------------------------------

/** Wadah segmen yang dipakai ulang antar frame (tanpa alokasi setelah pemanasan). */
function makeBuckets(n) {
  return { data: Array.from({ length: n }, () => []), count: new Int32Array(n) };
}

/**
 * Memasang latar jaringan saraf pada `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {{density?:number, interactive?:boolean, palette?:'aurora'|'bull'|'bear', fps?:number, seed?:number}} opts
 */
export function mountNeuralBackground(canvas, opts = {}) {
  const noop = { setActivity() {}, pulse() {}, setMotion() {}, resize() {}, destroy() {} };
  const win = safeWindow();
  if (!win || !canvas || typeof canvas.getContext !== 'function') return noop;
  const ctx = canvas.getContext('2d');
  if (!ctx) return noop;

  const doc = win.document;
  const nav = win.navigator || {};
  const density = Number.isFinite(opts.density) && opts.density > 0 ? opts.density : 1;
  const interactive = opts.interactive !== false;
  const paletteMode = opts.palette === 'bull' || opts.palette === 'bear' ? opts.palette : 'aurora';
  const baseFps = clamp(Number.isFinite(opts.fps) ? opts.fps : 45, 15, 60);
  const rng = Number.isFinite(opts.seed) ? createRng(opts.seed) : Math.random;

  let W = 0;
  let H = 0;
  let mode = readMotionPreference();
  let raf = 0;
  let lastRender = 0;
  let lastTick = 0;
  let slowStreak = 0;
  let slow = false;
  let destroyed = false;
  let palette = resolvePalette(null);
  let sprites = {};
  let auroraAt = -Infinity;
  const view = { px: 0, py: 0 };
  const ox = new Float64Array(LAYERS.length);
  const oy = new Float64Array(LAYERS.length);
  const listeners = [];
  let ro = null;
  let resizeTimer = 0;

  // Cache gaya (string rgba) — dibangun ulang hanya saat palet berubah.
  const EDGE_BUCKETS = HUE_BUCKETS * ALPHA_LEVELS;
  const NODE_BUCKETS = HUE_BUCKETS * LAYERS.length;
  const edges = makeBuckets(EDGE_BUCKETS);
  const dots = makeBuckets(NODE_BUCKETS);
  const cursorLines = makeBuckets(3);
  let edgeStyle = [];
  let nodeStyle = [];
  let tailStyle = {};
  let solidStyle = {};
  let cursorStyle = '';
  const nb = [];

  const aurora = doc.createElement('canvas');
  const actx = aurora.getContext ? aurora.getContext('2d') : null;
  const vignette = doc.createElement('canvas');
  const vctx = vignette.getContext ? vignette.getContext('2d') : null;

  const graph = createGraph(1, 1, 0, rng);
  let coarse = false;
  try {
    coarse = typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches;
  } catch {
    coarse = false;
  }

  function on(target, type, fn, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  }

  function makeSprite(color) {
    const size = 64;
    const c = doc.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext ? c.getContext('2d') : null;
    if (!g) return null;
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, rgba([255, 255, 255], 0.9));
    grad.addColorStop(0.12, rgba(color, 0.85));
    grad.addColorStop(0.4, rgba(color, 0.25));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  function readPaletteFromCss() {
    let style;
    try {
      style = win.getComputedStyle(doc.documentElement);
    } catch {
      style = null;
    }
    palette = resolvePalette(style ? (name) => style.getPropertyValue(name) : null);
    if (paletteMode === 'bull') palette = { ...palette, violet: palette.bull };
    if (paletteMode === 'bear') palette = { ...palette, cyan: palette.bear };
    sprites = {};
    tailStyle = {};
    solidStyle = {};
    for (const key of Object.keys(palette)) {
      sprites[key] = makeSprite(palette[key]);
      tailStyle[key] = [0.14, 0.32, 0.58, 0.92].map((a) => rgba(palette[key], a));
      solidStyle[key] = rgba(palette[key], 1);
    }
    edgeStyle = [];
    nodeStyle = [];
    for (let hb = 0; hb < HUE_BUCKETS; hb += 1) {
      const c = mix(palette.cyan, palette.violet, (hb + 0.5) / HUE_BUCKETS);
      for (let lv = 1; lv <= ALPHA_LEVELS; lv += 1) edgeStyle.push(rgba(c, (lv / ALPHA_LEVELS) * ALPHA_CAPS.line));
      for (let z = 0; z < LAYERS.length; z += 1) nodeStyle.push(rgba(c, (LAYERS[z].alpha / MAX_LAYER_ALPHA) * ALPHA_CAPS.node));
    }
    cursorStyle = rgba(palette.cyan, 1);
  }

  function renderAurora(t) {
    if (!actx) return;
    const w = aurora.width;
    const h = aurora.height;
    const R = Math.max(w, h);
    const act = graph.activity;
    actx.clearRect(0, 0, w, h);
    const blobs = [
      [palette.cyan, 0.22 + 0.14 * Math.sin(t * 0.00006), 0.18 + 0.1 * Math.cos(t * 0.00005), 0.17],
      [palette.violet, 0.78 + 0.12 * Math.cos(t * 0.00004 + 1.3), 0.3 + 0.14 * Math.sin(t * 0.00005 + 0.4), 0.18],
      [palette.bull, 0.5 + 0.2 * Math.sin(t * 0.00003 + 2.1), 0.95 + 0.06 * Math.cos(t * 0.00004), 0.11],
    ];
    for (let k = 0; k < blobs.length; k += 1) {
      const [c, fx, fy, a] = blobs[k];
      const g = actx.createRadialGradient(fx * w, fy * h, 0, fx * w, fy * h, R * 0.6);
      g.addColorStop(0, rgba(c, a + act * 0.05));
      g.addColorStop(1, rgba(c, 0));
      actx.fillStyle = g;
      actx.fillRect(0, 0, w, h);
    }
    auroraAt = t;
  }

  function renderVignette() {
    if (!vctx) return;
    const w = vignette.width;
    const h = vignette.height;
    vctx.clearRect(0, 0, w, h);
    const g = vctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    vctx.fillStyle = g;
    vctx.fillRect(0, 0, w, h);
  }

  function measure() {
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    const w = Math.max(1, Math.round((rect && rect.width) || win.innerWidth || 1));
    const h = Math.max(1, Math.round((rect && rect.height) || win.innerHeight || 1));
    return { w, h };
  }

  function resize() {
    if (destroyed) return;
    const { w, h } = measure();
    const dpr = pickDpr(w, h, win.devicePixelRatio || 1, nav.hardwareConcurrency, nav.deviceMemory);
    W = w;
    H = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    aurora.width = Math.max(1, Math.ceil(w / 4));
    aurora.height = Math.max(1, Math.ceil(h / 4));
    vignette.width = Math.max(1, Math.ceil(w / 2));
    vignette.height = Math.max(1, Math.ceil(h / 2));
    const count = nodeCountFor(w, h, density);
    if (graph.nodes.length === 0) {
      const fresh = createGraph(w, h, count, rng);
      Object.assign(graph, fresh, { activity: graph.activity, targetActivity: graph.targetActivity, pointer: graph.pointer });
    } else {
      resizeGraph(graph, w, h, count);
    }
    readPaletteFromCss();
    renderAurora(graph.time);
    renderVignette();
    if (mode !== 'on') drawStatic();
  }

  function pushSeg(b, idx, x1, y1, x2, y2) {
    const arr = b.data[idx];
    const c = b.count[idx];
    arr[c] = x1;
    arr[c + 1] = y1;
    arr[c + 2] = x2;
    arr[c + 3] = y2;
    b.count[idx] = c + 4;
  }

  function strokeBuckets(b, styles) {
    for (let k = 0; k < b.count.length; k += 1) {
      const n = b.count[k];
      if (!n) continue;
      const arr = b.data[k];
      ctx.strokeStyle = styles[k];
      ctx.beginPath();
      for (let s = 0; s < n; s += 4) {
        ctx.moveTo(arr[s], arr[s + 1]);
        ctx.lineTo(arr[s + 2], arr[s + 3]);
      }
      ctx.stroke();
    }
  }

  function render(t, animate) {
    const { nodes } = graph;
    const LD = graph.linkDist;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    if (animate && t - auroraAt >= 250) renderAurora(t); // ±4 fps
    if (actx) ctx.drawImage(aurora, 0, 0, W, H);

    const pointerOn = interactive && animate && graph.pointer.active;
    const tx = pointerOn ? graph.pointer.x - W / 2 : 0;
    const ty = pointerOn ? graph.pointer.y - H / 2 : 0;
    const ease = animate ? 0.04 : 1;
    view.px += (tx - view.px) * ease;
    view.py += (ty - view.py) * ease;
    for (let z = 0; z < LAYERS.length; z += 1) {
      ox[z] = -view.px * LAYERS[z].parallax;
      oy[z] = -view.py * LAYERS[z].parallax;
    }

    const grid = graph.grid || buildGrid(nodes, LD);
    const boost = 0.85 + graph.activity * 0.3;
    edges.count.fill(0);
    dots.count.fill(0);
    cursorLines.count.fill(0);

    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      const ax = a.x + ox[a.z];
      const ay = a.y + oy[a.z];
      // Node dasar dibatch per (warna, lapis).
      const di = a.hb * LAYERS.length + a.z;
      const darr = dots.data[di];
      const dc = dots.count[di];
      darr[dc] = ax;
      darr[dc + 1] = ay;
      darr[dc + 2] = a.r;
      dots.count[di] = dc + 3;

      neighbors(grid, nodes, i, LD, nb, false);
      for (let k = 0; k < nb.length; k += 1) {
        const j = nb[k];
        if (j <= i) continue;
        const b = nodes[j];
        if (!canLink(a, b)) continue;
        const f = 1 - Math.hypot(a.x - b.x, a.y - b.y) / LD;
        const depth = (LAYERS[a.z].alpha + LAYERS[b.z].alpha) / (2 * MAX_LAYER_ALPHA);
        const glow = a.glow > b.glow ? a.glow : b.glow;
        const al = Math.min(ALPHA_CAPS.line, ALPHA_CAPS.line * (Math.pow(f, 1.25) * depth * boost + glow * 0.55 * f));
        if (al < 0.012) continue;
        const hb = (a.hb + b.hb + ((i + j) & 1)) >> 1;
        pushSeg(edges, hb * ALPHA_LEVELS + alphaLevel(al) - 1, ax, ay, b.x + ox[b.z], b.y + oy[b.z]);
      }

      if (pointerOn) {
        const d = Math.hypot(ax - graph.pointer.x, ay - graph.pointer.y);
        if (d < POINTER_RADIUS) {
          const lv = d < POINTER_RADIUS / 3 ? 2 : d < (2 * POINTER_RADIUS) / 3 ? 1 : 0;
          pushSeg(cursorLines, lv, graph.pointer.x, graph.pointer.y, ax, ay);
        }
      }
    }

    ctx.lineWidth = 1;
    strokeBuckets(edges, edgeStyle);

    if (pointerOn) {
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = cursorStyle;
      for (let lv = 0; lv < 3; lv += 1) {
        const n = cursorLines.count[lv];
        if (!n) continue;
        const arr = cursorLines.data[lv];
        ctx.globalAlpha = ((lv + 1) / 3) * ALPHA_CAPS.cursor;
        ctx.beginPath();
        for (let s = 0; s < n; s += 4) {
          ctx.moveTo(arr[s], arr[s + 1]);
          ctx.lineTo(arr[s + 2], arr[s + 3]);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    for (let k = 0; k < NODE_BUCKETS; k += 1) {
      const n = dots.count[k];
      if (!n) continue;
      const arr = dots.data[k];
      ctx.fillStyle = nodeStyle[k];
      ctx.beginPath();
      for (let s = 0; s < n; s += 3) {
        ctx.moveTo(arr[s] + arr[s + 2], arr[s + 1]);
        ctx.arc(arr[s], arr[s + 1], arr[s + 2], 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // Lapisan cahaya aditif: nyala node, pulsa, riak, kursor.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      // Halo lembut permanen untuk lapis depan (sprite pra-render, bukan shadowBlur).
      if (n.z === LAYERS.length - 1 && sprites[n.hb < HUE_BUCKETS / 2 ? 'cyan' : 'violet']) {
        const hs = n.r * 9;
        ctx.globalAlpha = ALPHA_CAPS.halo;
        ctx.drawImage(sprites[n.hb < HUE_BUCKETS / 2 ? 'cyan' : 'violet'], n.x + ox[n.z] - hs / 2, n.y + oy[n.z] - hs / 2, hs, hs);
      }
      if (n.glow <= 0.02) continue;
      const spr = sprites[n.glowKey] || sprites.cyan;
      if (!spr) continue;
      const s = n.r * (6 + 9 * n.glow);
      ctx.globalAlpha = Math.min(ALPHA_CAPS.glow, n.glow * ALPHA_CAPS.glow) * (LAYERS[n.z].alpha / MAX_LAYER_ALPHA);
      ctx.drawImage(spr, n.x + ox[n.z] - s / 2, n.y + oy[n.z] - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    ctx.lineWidth = 1.9;
    for (let k = 0; k < graph.pulses.length; k += 1) {
      const p = graph.pulses[k];
      const A = nodes[p.a];
      const B = nodes[p.b];
      if (!A || !B) continue;
      const ax = A.x + ox[A.z];
      const ay = A.y + oy[A.z];
      const dx = B.x + ox[B.z] - ax;
      const dy = B.y + oy[B.z] - ay;
      const tails = tailStyle[p.key] || tailStyle.cyan;
      // Ekor: 4 segmen dengan alpha naik ke arah kepala (tanpa gradien per pulsa).
      for (let s = 0; s < 4; s += 1) {
        const t0 = Math.max(0, p.t - 0.72 + s * 0.18);
        const t1 = Math.max(0, p.t - 0.72 + (s + 1) * 0.18);
        if (t1 <= t0) continue;
        ctx.strokeStyle = tails[s];
        ctx.beginPath();
        ctx.moveTo(ax + dx * t0, ay + dy * t0);
        ctx.lineTo(ax + dx * t1, ay + dy * t1);
        ctx.stroke();
      }
      const spr = sprites[p.key] || sprites.cyan;
      if (spr) {
        const s = 16 + B.z * 4;
        ctx.globalAlpha = ALPHA_CAPS.glow;
        ctx.drawImage(spr, ax + dx * p.t - s / 2, ay + dy * p.t - s / 2, s, s);
        ctx.globalAlpha = 1;
      }
    }

    ctx.lineWidth = 1;
    for (let k = 0; k < graph.ripples.length; k += 1) {
      const r = graph.ripples[k];
      const q = r.age / r.life;
      ctx.strokeStyle = solidStyle[r.key] || solidStyle.cyan;
      ctx.globalAlpha = (1 - q) * ALPHA_CAPS.ripple;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 8 + q * 200, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (pointerOn && sprites.cyan) {
      ctx.globalAlpha = ALPHA_CAPS.cursor;
      ctx.drawImage(sprites.cyan, graph.pointer.x - 36, graph.pointer.y - 36, 72, 72);
      ctx.globalAlpha = 1;
    }

    ctx.globalCompositeOperation = 'source-over';
    if (vctx) ctx.drawImage(vignette, 0, 0, W, H);
  }

  function markReady() {
    if (canvas.classList && !canvas.classList.contains('is-ready')) canvas.classList.add('is-ready');
  }

  function drawStatic() {
    if (!W || !H) return;
    render(graph.time, false);
    markReady();
  }

  function frame(now) {
    raf = 0;
    if (destroyed || mode !== 'on' || doc.hidden) return;
    raf = win.requestAnimationFrame(frame);
    // Deteksi perangkat lambat dari jeda antar callback rAF (bukan antar frame yang dirender).
    if (lastTick && !slow) {
      slowStreak = now - lastTick > 28 ? slowStreak + 1 : 0;
      if (slowStreak >= 20) slow = true;
    }
    lastTick = now;
    const interval = 1000 / pickFps(baseFps, graph.activity, slow);
    if (lastRender) {
      const elapsed = now - lastRender;
      if (elapsed < interval - 1) return;
      stepGraph(graph, elapsed, W, H);
      lastRender = now - (elapsed % interval);
    } else {
      stepGraph(graph, 16, W, H);
      lastRender = now;
    }
    render(graph.time, true);
    markReady();
  }

  function start() {
    if (destroyed || raf || mode !== 'on' || doc.hidden) return;
    lastRender = 0;
    lastTick = 0;
    slowStreak = 0;
    raf = win.requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
  }

  function setMotion(next) {
    mode = next === 'off' || next === 'reduced' ? next : 'on';
    if (mode === 'on') start();
    else {
      stop();
      graph.pulses.length = 0;
      graph.ripples.length = 0;
      graph.pointer.active = false;
      drawStatic();
    }
  }

  function setActivity(level) {
    const v = Number(level);
    graph.targetActivity = clamp(Number.isFinite(v) ? v : 0.25, 0, 1);
  }

  function pulse(kind = 'accent', count = 6) {
    if (mode !== 'on' || destroyed) return 0;
    const k = kind === 'bull' || kind === 'bear' ? kind : 'accent';
    return emitPulses(graph, k, clamp(Math.floor(Number(count) || 0), 0, 24));
  }

  // --- Listener ---
  const scheduleResize = () => {
    win.clearTimeout(resizeTimer);
    resizeTimer = win.setTimeout(resize, 150);
  };
  if (typeof win.ResizeObserver === 'function') {
    ro = new win.ResizeObserver(scheduleResize);
    ro.observe(canvas);
  } else {
    on(win, 'resize', scheduleResize, { passive: true });
  }
  on(doc, 'visibilitychange', () => (doc.hidden ? stop() : start()));
  if (interactive) {
    on(win, 'pointermove', (e) => {
      if (isCoarsePointer(e, coarse)) return; // sentuh: tanpa parallax/garis kursor
      graph.pointer.x = e.clientX;
      graph.pointer.y = e.clientY;
      graph.pointer.active = mode === 'on';
    }, { passive: true });
    on(win, 'pointerdown', (e) => {
      if (mode !== 'on' || (e.button && e.button !== 0)) return;
      if (!isEmptyAreaTarget(e.target)) return; // riak hanya di area kosong
      rippleAt(graph, e.clientX, e.clientY, 'accent', 3);
    }, { passive: true });
    const leave = () => { graph.pointer.active = false; };
    on(doc, 'pointerleave', leave);
    on(win, 'blur', leave);
  }
  let mql;
  try {
    mql = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {
    mql = null;
  }
  if (mql) on(mql, 'change', () => setMotion(readMotionPreference()));

  resize();
  setMotion(mode);

  return {
    setActivity,
    pulse,
    setMotion,
    resize,
    destroy() {
      destroyed = true;
      stop();
      win.clearTimeout(resizeTimer);
      if (ro) ro.disconnect();
      while (listeners.length) listeners.pop()();
    },
  };
}
