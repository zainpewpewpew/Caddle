// Konstelasi Sinyal: visualisasi canvas 2D dari sinyal AKTIF NYATA (GET /api/signals/active, LONG & SHORT).
// Setiap node = satu sinyal terbuka di database. Tidak ada node contoh/palsu: daftar kosong → empty state jujur.
//
// Modul ini terbagi dua:
// 1. Fungsi murni (tanpa DOM) — normalizeSignals, layoutConstellation, hitTest, diffNewSignals,
//    describeConstellation, signalHref. Diuji di tests/unit/constellation.test.js (Vitest, lingkungan node).
// 2. mountConstellation() — elemen DOM + canvas + loop animasi. DOM hanya disentuh saat fungsi ini dipanggil,
//    bukan saat modul diimpor.
import { emptyState } from '../lib/components.js';
import { h } from '../lib/dom.js';

/** Peringkat tahap: makin tinggi makin dekat ke inti klaster. */
export const STAGE_RANK = Object.freeze({
  QUIET: 0,
  EARLY_BULLISH: 1,
  EARLY_BEARISH: 1,
  MOMENTUM_BUILDING: 2,
  BREAKOUT: 3,
  BREAKDOWN: 3,
});

/** Tahap yang membuat node berdenyut. */
export const PULSE_STATES = Object.freeze(new Set(['BREAKOUT', 'BREAKDOWN']));

const STAGE_LABELS = {
  QUIET: 'Quiet',
  EARLY_BULLISH: 'Early bullish',
  EARLY_BEARISH: 'Early bearish',
  MOMENTUM_BUILDING: 'Momentum',
  BREAKOUT: 'Breakout',
  BREAKDOWN: 'Breakdown',
};

const TF_ORDER = { '5m': 0, '15m': 1, '1h': 2 };
// Jari-jari orbit (fraksi jari-jari klaster) per peringkat tahap: BREAKOUT/BREAKDOWN di inti, QUIET di tepi.
const RING = [0.9, 0.68, 0.44, 0.18];
const MAX_EDGES_PER_NODE = 3;

export const stageLabel = (state) => STAGE_LABELS[state] ?? String(state ?? '—').replaceAll('_', ' ');

/** FNV-1a 32-bit: hash deterministik untuk sudut/jitter (tanpa Math.random). */
export function hash32(text) {
  let x = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x >>> 0;
}

const unit = (text) => hash32(text) / 0x1_0000_0000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Menyaring & menormalkan item API menjadi sinyal konstelasi. Item tanpa simbol/timeframe/tahap terbuka dibuang
 * (tidak pernah ditebak). earlyScore di luar 0..100 dijepit; null/NaN → null (ukuran minimum, tooltip "—").
 * @param {Array<object>|null|undefined} items
 * @param {'LONG'|'SHORT'} [fallbackDirection] arah bila item tidak membawa field direction (respons per arah)
 * @returns {Array<{ key: string, id: number|null, symbol: string, timeframe: string, direction: 'LONG'|'SHORT',
 *   state: string, earlyScore: number|null, patternScore: number|null, classification: string|null }>}
 */
export function normalizeSignals(items, fallbackDirection = 'LONG') {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const symbol = typeof item.symbol === 'string' ? item.symbol : '';
    const timeframe = typeof item.timeframe === 'string' ? item.timeframe : '';
    if (!symbol || !timeframe || !Object.hasOwn(STAGE_RANK, item.state)) continue;
    const direction = (item.direction ?? fallbackDirection) === 'SHORT' ? 'SHORT' : 'LONG';
    const id = Number.isInteger(item.id) ? item.id : null;
    const key = `${direction}:${symbol}:${timeframe}:${id ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const score = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 100) : null);
    out.push({
      key,
      id,
      symbol,
      timeframe,
      direction,
      state: item.state,
      earlyScore: score(item.earlyScore),
      patternScore: score(item.patternScore),
      classification: typeof item.classification === 'string' ? item.classification : null,
    });
  }
  return out;
}

/** Tautan Symbol Intelligence untuk sebuah sinyal. */
export function signalHref(signal) {
  const params = new URLSearchParams({ s: signal.symbol, tf: signal.timeframe, dir: signal.direction });
  return `#/symbol?${params.toString()}`;
}

/**
 * Tata letak deterministik (input sama → output sama, tanpa bergantung pada urutan input).
 * Lebar ≥ tinggi×1.1: LONG klaster kiri, SHORT kanan; lebih sempit (mobile): LONG atas, SHORT bawah.
 * Dalam klaster, tahap menentukan jarak ke inti; sudut dari hash simbol (+ geser kecil per timeframe) sehingga
 * timeframe berbeda dari simbol yang sama berdekatan. Ukuran ∝ early score. Tumpang tindih diurai beberapa iterasi.
 * Edge: simbol sama (antar-timeframe/arah), plus tetangga terdekat dengan tahap sama atau timeframe sama di arah
 * yang sama (maks. MAX_EDGES_PER_NODE per node agar tetap terbaca).
 * @param {ReturnType<typeof normalizeSignals>} signals
 * @param {number} width
 * @param {number} height
 */
export function layoutConstellation(signals, width, height) {
  const w = Math.max(1, Number(width) || 1);
  const hgt = Math.max(1, Number(height) || 1);
  const list = [...(Array.isArray(signals) ? signals : [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const orientation = w >= hgt * 1.1 ? 'horizontal' : 'vertical';
  const clusters = orientation === 'horizontal'
    ? {
      LONG: { cx: w * 0.27, cy: hgt / 2, r: Math.min(w * 0.22, hgt * 0.42) },
      SHORT: { cx: w * 0.73, cy: hgt / 2, r: Math.min(w * 0.22, hgt * 0.42) },
    }
    : {
      LONG: { cx: w / 2, cy: hgt * 0.27, r: Math.min(w * 0.42, hgt * 0.22) },
      SHORT: { cx: w / 2, cy: hgt * 0.73, r: Math.min(w * 0.42, hgt * 0.22) },
    };

  const counts = { LONG: 0, SHORT: 0 };
  for (const s of list) counts[s.direction] += 1;

  const nodes = list.map((s) => {
    const c = clusters[s.direction];
    const density = clamp(Math.sqrt(36 / Math.max(1, counts[s.direction])), 0.4, 1);
    const rMin = Math.max(2.5, c.r * 0.035) * density;
    const rMax = Math.max(rMin + 2, c.r * 0.12 * density);
    const scoreFrac = s.earlyScore === null ? 0 : s.earlyScore / 100;
    const rank = STAGE_RANK[s.state];
    const angle = unit(s.symbol) * Math.PI * 2 + (TF_ORDER[s.timeframe] ?? 3) * 0.32;
    const orbit = clamp(RING[rank] + (unit(`${s.key}|j`) - 0.5) * 0.16, 0.05, 0.96) * c.r;
    return {
      ...s,
      rank,
      pulse: PULSE_STATES.has(s.state),
      r: rMin + (rMax - rMin) * scoreFrac,
      x: c.cx + Math.cos(angle) * orbit,
      y: c.cy + Math.sin(angle) * orbit,
      phase: unit(`${s.key}|p`) * Math.PI * 2,
    };
  });

  relax(nodes, clusters, w, hgt);
  const edges = buildEdges(nodes);
  return { width: w, height: hgt, orientation, clusters, nodes, edges };
}

/** Mengurai tumpang tindih antar-node dalam klaster yang sama (deterministik, urutan tetap). */
function relax(nodes, clusters, w, hgt) {
  const byDir = { LONG: [], SHORT: [] };
  for (const n of nodes) byDir[n.direction].push(n);
  const iterations = nodes.length > 400 ? 10 : 24;
  for (const dir of ['LONG', 'SHORT']) {
    const group = byDir[dir];
    const c = clusters[dir];
    for (let it = 0; it < iterations; it += 1) {
      for (let i = 0; i < group.length; i += 1) {
        const a = group[i];
        for (let j = i + 1; j < group.length; j += 1) {
          const b = group[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const min = a.r + b.r + 2;
          let d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          if (d2 < 1e-6) {
            // Titik identik: arah dorong dari hash kunci agar tetap deterministik.
            const ang = unit(`${a.key}|${b.key}`) * Math.PI * 2;
            dx = Math.cos(ang) * 0.01;
            dy = Math.sin(ang) * 0.01;
            d2 = 1e-4;
          }
          const d = Math.sqrt(d2);
          const push = (min - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
        }
      }
      for (const n of group) {
        // Tetap di dalam klaster (sedikit longgar) dan di dalam kanvas.
        const dx = n.x - c.cx;
        const dy = n.y - c.cy;
        const lim = c.r * 1.08;
        const d = Math.hypot(dx, dy);
        if (d > lim) {
          n.x = c.cx + (dx / d) * lim;
          n.y = c.cy + (dy / d) * lim;
        }
        n.x = clamp(n.x, n.r + 2, w - n.r - 2);
        n.y = clamp(n.y, n.r + 2, hgt - n.r - 2);
      }
    }
  }
}

function buildEdges(nodes) {
  const edges = [];
  const seen = new Set();
  const degree = new Array(nodes.length).fill(0);
  const add = (i, j, kind, force = false) => {
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const id = `${a}-${b}`;
    if (a === b || seen.has(id)) return;
    if (!force && (degree[a] >= MAX_EDGES_PER_NODE || degree[b] >= MAX_EDGES_PER_NODE)) return;
    seen.add(id);
    degree[a] += 1;
    degree[b] += 1;
    edges.push({ a, b, kind });
  };

  // 1) Simbol sama: selalu tersambung (beda timeframe atau beda arah).
  const bySymbol = new Map();
  nodes.forEach((n, i) => {
    if (!bySymbol.has(n.symbol)) bySymbol.set(n.symbol, []);
    bySymbol.get(n.symbol).push(i);
  });
  for (const idx of bySymbol.values()) {
    for (let k = 1; k < idx.length; k += 1) add(idx[k - 1], idx[k], 'symbol', true);
  }

  // 2) Tahap sama / timeframe sama (arah sama): tetangga terdekat menurut jarak tata letak.
  const nearest = (groupKey, kind, k) => {
    const groups = new Map();
    nodes.forEach((n, i) => {
      const g = groupKey(n);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    });
    for (const idx of groups.values()) {
      if (idx.length < 2) continue;
      for (const i of idx) {
        const a = nodes[i];
        const cand = idx.filter((j) => j !== i)
          .map((j) => ({ j, d: (nodes[j].x - a.x) ** 2 + (nodes[j].y - a.y) ** 2 }))
          .sort((p, q) => p.d - q.d || p.j - q.j)
          .slice(0, k);
        for (const { j } of cand) add(i, j, kind);
      }
    }
  };
  nearest((n) => `${n.direction}|${n.state}`, 'stage', 2);
  nearest((n) => `${n.direction}|${n.timeframe}`, 'timeframe', 1);
  return edges;
}

/**
 * Node di bawah titik (x, y), atau null. Bila tumpang tindih, yang paling dekat ke pusatnya.
 * @param {Array<{ x: number, y: number, r: number }>} nodes
 */
export function hitTest(nodes, x, y, slop = 4) {
  let best = null;
  let bestD = Infinity;
  for (const n of nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= n.r + slop && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

/**
 * Sinyal yang belum ada di `prevKeys`. Dipakai untuk memicu `lr:activity` hanya pada sinyal yang BENAR-BENAR baru.
 * @param {Set<string>|null} prevKeys null → muatan pertama: tidak ada yang dianggap baru.
 * @returns {{ added: Array<object>, bull: number, bear: number, keys: Set<string> }}
 */
export function diffNewSignals(prevKeys, signals) {
  const keys = new Set(signals.map((s) => s.key));
  if (!prevKeys) return { added: [], bull: 0, bear: 0, keys };
  const added = signals.filter((s) => !prevKeys.has(s.key));
  return {
    added,
    bull: added.filter((s) => s.direction === 'LONG').length,
    bear: added.filter((s) => s.direction === 'SHORT').length,
    keys,
  };
}

/** Ringkasan teks untuk aria-label kanvas. */
export function describeConstellation(signals) {
  if (!signals.length) return 'Konstelasi sinyal: belum ada sinyal aktif.';
  const part = (dir, peak) => {
    const list = signals.filter((s) => s.direction === dir);
    const hot = list.filter((s) => s.state === peak).length;
    return `${list.length} ${dir}${hot ? ` (${hot} ${peak})` : ''}`;
  };
  return `Konstelasi sinyal: ${signals.length} sinyal aktif — ${part('LONG', 'BREAKOUT')}, ${part('SHORT', 'BREAKDOWN')}. Daftar lengkap tersedia sebagai tabel.`;
}

const formatScore = (v) => (v === null ? '—' : String(Math.round(v)));

// ---------------------------------------------------------------------------------------------------------------
// Bagian DOM (hanya dijalankan di browser).

const FRAME_MS = 1000 / 45;
const ENTER_MS = 700;

/** Mode gerak global: 'off'/'reduced' → gambar statis. Mengikuti data-motion milik shell + prefers-reduced-motion. */
export function motionAllowed() {
  if (typeof document === 'undefined') return false;
  const mode = document.documentElement.dataset.motion;
  if (mode === 'off' || mode === 'reduced') return false;
  return !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function readPalette(el) {
  const css = getComputedStyle(el);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    bull: v('--lr-bull', '#21c58e'),
    bear: v('--lr-bear', '#f16b75'),
    cyan: v('--lr-neural-cyan', '#38e1ff'),
    violet: v('--lr-neural-violet', '#7c6cff'),
    text: v('--lr-text-2', '#8b98a8'),
  };
}

/**
 * Memasang konstelasi. `update(signals, { error })` mengganti data (node baru masuk dengan animasi), `destroy()`
 * menghentikan rAF, observer dan listener.
 * @param {{ signals?: ReturnType<typeof normalizeSignals>, error?: boolean }} [options]
 */
export function mountConstellation({ signals: initial = [], error: initialError = false } = {}) {
  const canvas = h('canvas', { class: 'constellation__canvas', tabindex: 0, role: 'img', 'aria-describedby': 'constellation-hint' });
  const tooltip = h('div', { class: 'constellation__tooltip', 'aria-hidden': 'true', hidden: true });
  const labels = h('div', { class: 'constellation__labels', 'aria-hidden': 'true' },
    h('span', { class: 'constellation__label constellation__label--long' }, 'LONG'),
    h('span', { class: 'constellation__label constellation__label--short' }, 'SHORT'));
  const stage = h('div', { class: 'constellation__stage' }, canvas, labels, tooltip);
  const hint = h('p', { class: 'sr-only', id: 'constellation-hint' }, 'Gunakan panah untuk berpindah antar-sinyal, Enter untuk membuka Symbol Intelligence.');
  const srTable = h('div', { class: 'sr-only' });
  const empty = h('div', { class: 'constellation__empty', hidden: true });
  const el = h('div', { class: 'constellation', 'data-testid': 'constellation' }, stage, empty, hint, srTable);

  let signals = [];
  let layout = layoutConstellation([], 1, 1);
  let width = 0;
  let height = 0;
  let dpr = 1;
  let ctx2d = null;
  let palette = null;
  let raf = 0;
  let lastFrame = 0;
  let hover = null;
  let focusIndex = -1;
  let destroyed = false;
  const born = new Map(); // key → waktu masuk (animasi node baru)
  let knownKeys = null;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function renderSrTable() {
    if (!signals.length) {
      srTable.replaceChildren();
      return;
    }
    const rows = [...layout.nodes].sort((a, b) => (b.earlyScore ?? -1) - (a.earlyScore ?? -1));
    srTable.replaceChildren(h('table', null,
      h('caption', null, 'Daftar sinyal aktif pada konstelasi'),
      h('thead', null, h('tr', null, ['Symbol', 'Arah', 'TF', 'Tahap', 'Early Score'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows.map((n) => h('tr', null,
        // tabindex -1: tabel ini tersembunyi visual; pengguna keyboard memakai panah di kanvas.
        h('td', null, h('a', { href: signalHref(n), tabindex: -1 }, n.symbol)),
        h('td', null, n.direction), h('td', null, n.timeframe), h('td', null, stageLabel(n.state)),
        h('td', null, formatScore(n.earlyScore)))))));
  }

  function renderEmpty(error) {
    const show = error || signals.length === 0;
    empty.hidden = !show;
    stage.hidden = show;
    if (!show) return;
    empty.replaceChildren(error
      ? emptyState({ iconName: 'radar', title: 'Sinyal aktif gagal dimuat', text: 'Konstelasi tidak dapat menampilkan data saat ini. Akan dicoba lagi pada penyegaran berikutnya.' })
      : emptyState({ iconName: 'radar', title: 'Belum ada sinyal aktif — jalankan scanner', text: 'Node muncul hanya dari sinyal LONG/SHORT terbuka di database. Tidak ada titik contoh yang ditampilkan.' }));
  }

  function relayout() {
    layout = layoutConstellation(signals, width, height);
    if (hover) hover = layout.nodes.find((n) => n.key === hover.key) ?? null;
    if (focusIndex >= layout.nodes.length) focusIndex = layout.nodes.length - 1;
  }

  function resize() {
    if (destroyed) return;
    const rect = stage.getBoundingClientRect();
    const w = Math.round(rect.width);
    const hh = Math.round(rect.height);
    if (!w || !hh) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === width && hh === height && canvas.width === Math.round(w * dpr)) return;
    width = w;
    height = hh;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    ctx2d = canvas.getContext('2d');
    palette = readPalette(el);
    relayout();
    labels.dataset.orientation = layout.orientation;
    schedule(true);
  }

  // Posisi tampil (drift halus) — dipakai gambar & hit test agar konsisten.
  const animated = () => motionAllowed() && !document.hidden;
  const pos = (n, t) => {
    if (!animated()) return { x: n.x, y: n.y };
    const amp = Math.min(2.2, n.r * 0.4);
    return { x: n.x + Math.cos(t * 0.00045 + n.phase) * amp, y: n.y + Math.sin(t * 0.0006 + n.phase) * amp };
  };

  function draw(t) {
    if (!ctx2d || !width) return;
    const g = ctx2d;
    const moving = animated();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);

    // Halo klaster.
    for (const dir of ['LONG', 'SHORT']) {
      const c = layout.clusters[dir];
      const color = dir === 'LONG' ? palette.bull : palette.bear;
      const grad = g.createRadialGradient(c.cx, c.cy, 0, c.cx, c.cy, c.r * 1.25);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'transparent');
      g.globalAlpha = 0.07;
      g.fillStyle = grad;
      g.beginPath();
      g.arc(c.cx, c.cy, c.r * 1.25, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 0.12;
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.setLineDash([2, 6]);
      for (const f of [0.18, 0.44, 0.68, 0.9]) {
        g.beginPath();
        g.arc(c.cx, c.cy, c.r * f, 0, Math.PI * 2);
        g.stroke();
      }
      g.setLineDash([]);
    }

    const p = layout.nodes.map((n) => pos(n, t));
    const enter = (n) => {
      const b = born.get(n.key);
      if (b === undefined || !moving) return 1;
      return clamp((t - b) / ENTER_MS, 0, 1);
    };

    // Edge + pulsa merambat (sinaps).
    for (let i = 0; i < layout.edges.length; i += 1) {
      const e = layout.edges[i];
      const A = layout.nodes[e.a];
      const B = layout.nodes[e.b];
      const k = Math.min(enter(A), enter(B));
      const cross = A.direction !== B.direction;
      const color = cross ? palette.violet : e.kind === 'symbol' ? palette.cyan : A.direction === 'LONG' ? palette.bull : palette.bear;
      const lit = hover && (hover.key === A.key || hover.key === B.key);
      g.globalAlpha = (lit ? 0.75 : e.kind === 'symbol' ? 0.38 : 0.16) * k;
      g.strokeStyle = color;
      g.lineWidth = lit ? 1.4 : 1;
      g.beginPath();
      g.moveTo(p[e.a].x, p[e.a].y);
      g.lineTo(p[e.b].x, p[e.b].y);
      g.stroke();
      if (moving) {
        const f = ((t * 0.00018 + (i * 0.6180339) % 1) % 1);
        g.globalAlpha = 0.85 * k * Math.sin(f * Math.PI);
        g.fillStyle = color;
        g.beginPath();
        g.arc(p[e.a].x + (p[e.b].x - p[e.a].x) * f, p[e.a].y + (p[e.b].y - p[e.a].y) * f, 1.4, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Node.
    layout.nodes.forEach((n, i) => {
      const { x, y } = p[i];
      const k = enter(n);
      const color = n.direction === 'LONG' ? palette.bull : palette.bear;
      const r = n.r * (0.4 + 0.6 * k);
      if (n.pulse) {
        // Denyut BREAKOUT/BREAKDOWN: cincin mengembang; statis saat gerak dimatikan.
        const ph = moving ? ((t / 2200 + n.phase / (Math.PI * 2)) % 1) : 0.45;
        g.globalAlpha = (1 - ph) * 0.6 * k;
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x, y, r * (1.2 + ph * 2.2), 0, Math.PI * 2);
        g.stroke();
      }
      const glow = g.createRadialGradient(x, y, 0, x, y, r * 2.6);
      glow.addColorStop(0, color);
      glow.addColorStop(1, 'transparent');
      g.globalAlpha = (n.pulse ? 0.45 : 0.25) * k;
      g.fillStyle = glow;
      g.beginPath();
      g.arc(x, y, r * 2.6, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = (0.55 + 0.45 * ((n.earlyScore ?? 0) / 100)) * k;
      g.fillStyle = color;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      const focused = i === focusIndex && document.activeElement === canvas;
      if ((hover && hover.key === n.key) || focused) {
        g.globalAlpha = 1;
        g.strokeStyle = palette.cyan;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, r + 4, 0, Math.PI * 2);
        g.stroke();
      }
    });
    g.globalAlpha = 1;
    positionTooltip(p);
  }

  function positionTooltip(p) {
    const node = hover ?? (document.activeElement === canvas ? layout.nodes[focusIndex] : null);
    if (!node) {
      tooltip.hidden = true;
      return;
    }
    const i = layout.nodes.indexOf(node);
    const at = p?.[i] ?? node;
    tooltip.hidden = false;
    const left = clamp(at.x + 14, 4, Math.max(4, width - 190));
    const top = clamp(at.y - 12, 4, Math.max(4, height - 92));
    tooltip.style.setProperty('transform', `translate(${Math.round(left)}px, ${Math.round(top)}px)`);
  }

  function showTooltip(node) {
    if (!node) {
      tooltip.hidden = true;
      return;
    }
    tooltip.dataset.direction = node.direction;
    tooltip.replaceChildren(
      h('strong', { class: 'constellation__tip-symbol' }, node.symbol),
      h('span', { class: 'constellation__tip-row' }, `${node.direction} · ${node.timeframe}`),
      h('span', { class: 'constellation__tip-row' }, `Tahap: ${stageLabel(node.state)}`),
      h('span', { class: 'constellation__tip-row' }, `Early Score: ${formatScore(node.earlyScore)}`),
      node.classification && h('span', { class: 'constellation__tip-row' }, `Pola: ${node.classification}`));
  }

  function frame(t) {
    raf = 0;
    if (destroyed) return;
    if (t - lastFrame >= FRAME_MS) {
      lastFrame = t;
      draw(t);
    }
    if (animated() && signals.length) raf = requestAnimationFrame(frame);
  }

  // force: gambar ulang sekali walau gerak mati (data/ukuran/hover berubah).
  function schedule(force = false) {
    if (destroyed || raf) return;
    if (force) lastFrame = -Infinity;
    if (animated() && signals.length) raf = requestAnimationFrame(frame);
    else if (force) raf = requestAnimationFrame((t) => { raf = 0; draw(t); });
  }

  function localPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  const onMove = (e) => {
    const { x, y } = localPoint(e);
    const t = now();
    const next = hitTest(layout.nodes.map((n) => ({ ...n, ...pos(n, t) })), x, y);
    const found = next ? layout.nodes.find((n) => n.key === next.key) : null;
    if (found?.key !== hover?.key) {
      hover = found;
      showTooltip(hover);
      canvas.classList.toggle('is-pointing', Boolean(hover));
      schedule(true);
    }
  };
  const onLeave = () => {
    hover = null;
    showTooltip(null);
    canvas.classList.remove('is-pointing');
    schedule(true);
  };
  const onClick = (e) => {
    const { x, y } = localPoint(e);
    const t = now();
    const hit = hitTest(layout.nodes.map((n) => ({ ...n, ...pos(n, t) })), x, y);
    if (hit) window.location.hash = signalHref(hit);
  };
  // Urutan keyboard: arah (LONG dulu), lalu early score menurun — mudah ditebak pengguna.
  const keyboardOrder = () => layout.nodes.map((n, i) => ({ n, i }))
    .sort((a, b) => (a.n.direction === b.n.direction ? (b.n.earlyScore ?? -1) - (a.n.earlyScore ?? -1) || a.i - b.i : a.n.direction === 'LONG' ? -1 : 1))
    .map((x) => x.i);
  const onKey = (e) => {
    if (!layout.nodes.length) return;
    const order = keyboardOrder();
    const at = order.indexOf(focusIndex);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = order[(at + 1) % order.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = order[(at - 1 + order.length) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order[order.length - 1];
    else if (e.key === 'Enter' && focusIndex >= 0) {
      window.location.hash = signalHref(layout.nodes[focusIndex]);
      return;
    } else if (e.key === 'Escape') {
      focusIndex = -1;
      showTooltip(null);
      schedule(true);
      return;
    }
    if (next === null || next === undefined) return;
    e.preventDefault();
    focusIndex = next;
    hover = null;
    showTooltip(layout.nodes[focusIndex]);
    schedule(true);
  };
  const onBlur = () => {
    showTooltip(hover);
    schedule(true);
  };
  const onVisibility = () => schedule(true);

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('keydown', onKey);
  canvas.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(stage);
  const onWinResize = () => resize();
  if (!ro) window.addEventListener('resize', onWinResize);
  // Mode gerak dari shell (data-motion) atau preferensi OS berubah → lanjut/berhenti tanpa memuat ulang.
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(() => schedule(true)) : null;
  mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const onMq = () => schedule(true);
  mq?.addEventListener?.('change', onMq);

  function update(next, { error = false } = {}) {
    if (destroyed) return;
    signals = Array.isArray(next) ? next : [];
    const t = now();
    const keys = new Set(signals.map((s) => s.key));
    if (knownKeys) for (const k of keys) if (!knownKeys.has(k)) born.set(k, t);
    for (const k of born.keys()) if (!keys.has(k)) born.delete(k);
    knownKeys = keys;
    canvas.setAttribute('aria-label', describeConstellation(signals));
    renderEmpty(error);
    relayout();
    renderSrTable();
    if (hover && !keys.has(hover.key)) onLeave();
    // Stage baru saja ditampilkan (hidden → terlihat): ukur ulang pada frame berikut.
    requestAnimationFrame(() => resize());
    schedule(true);
  }

  update(initial, { error: initialError });

  return {
    el,
    update,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro?.disconnect();
      mo?.disconnect();
      mq?.removeEventListener?.('change', onMq);
      window.removeEventListener('resize', onWinResize);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('keydown', onKey);
      canvas.removeEventListener('blur', onBlur);
    },
  };
}
