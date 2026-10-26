// Render bersama untuk data sinyal (screener, riwayat, overview). Semua via h() — aman XSS.
import { badge, stage } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { EMPTY, formatRelative, formatUtc } from '../lib/format.js';

const ALIGNMENT_LABELS = {
  ALIGNED: ['Aligned', 'bull'],
  PARTIALLY_CONFIRMED: ['Parsial', 'accent'],
  UNCONFIRMED: ['Unconfirmed', undefined],
  COUNTERTREND: ['Countertrend', 'warn'],
};

// Selaras dengan RISK_FLAGS di backend/market/contracts.js.
const RISK_LABELS = {
  POOR_LIQUIDITY: 'Likuiditas rendah',
  WIDE_SPREAD: 'Spread lebar',
  EXCESSIVE_VOLATILITY: 'Volatilitas ekstrem',
  COUNTERTREND_HTF: 'Melawan tren HTF',
  EXTENDED_PRICE: 'Harga melebar',
  DATA_QUALITY: 'Kualitas data',
};

// Nama pola untuk tooltip badge. SD/PVD adalah cermin bearish SA/PVA (pola #003/#004).
const PATTERN_NAMES = {
  SA: 'Silent Accumulation',
  PVA: 'Progressive Volume Accumulation',
  SD: 'Silent Distribution',
  PVD: 'Progressive Volume Distribution',
};
const SHORT_PATTERNS = new Set(['SD', 'PVD']);
const HOT_STAGES = new Set(['BREAKOUT', 'BREAKDOWN']);

/** Arah sinyal; nilai hilang/lama (sebelum SHORT ada) = 'LONG'. */
export const directionOf = (value) => (value === 'SHORT' ? 'SHORT' : 'LONG');

export function alignmentBadge(value) {
  if (!value) return '—';
  const [label, tone] = ALIGNMENT_LABELS[value] ?? [value, undefined];
  return badge(label, tone);
}

export function riskBadges(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return '—';
  return h('span', { class: 'cluster' }, flags.map((f) => badge(RISK_LABELS[f] ?? f.replaceAll('_', ' '), 'warn')));
}

/**
 * Badge klasifikasi pola. SD/PVD (dan BOTH pada arah SHORT = SD + PVD) bernada bear; pola LONG tetap accent.
 * @param {string|null|undefined} classification
 * @param {'LONG'|'SHORT'} [direction] diperlukan hanya untuk membedakan BOTH; default LONG.
 */
export function patternBadge(classification, direction) {
  if (!classification) return '—';
  const short = SHORT_PATTERNS.has(classification) || (classification === 'BOTH' && directionOf(direction) === 'SHORT');
  const el = badge(classification, short ? 'bear' : 'accent');
  const name = classification === 'BOTH' ? (short ? 'SD + PVD' : 'SA + PVA') : PATTERN_NAMES[classification];
  if (name) el.title = name;
  return el;
}

/** Badge arah sinyal: LONG bernada bull, SHORT bernada bear. Selalu berlabel teks (warna bukan satu-satunya penanda). */
export function directionBadge(direction) {
  const value = directionOf(direction);
  return badge(value, value === 'SHORT' ? 'bear' : 'bull');
}

/**
 * Tahap sinyal. State SHORT (EARLY_BEARISH, BREAKDOWN) punya warna sendiri di CSS; MOMENTUM_BUILDING dipakai kedua
 * arah, sehingga sinyal SHORT diberi `data-direction="SHORT"` agar bernada bear. LONG identik dengan stage().
 */
export function signalStage(state, direction) {
  const el = stage(state);
  if (directionOf(direction) === 'SHORT') el.dataset.direction = 'SHORT';
  // Tahap konfirmasi (BREAKOUT/BREAKDOWN) berdenyut halus di CSS (dimatikan saat reduced motion / animasi off).
  if (HOT_STAGES.has(state)) el.classList.add('stage--hot');
  return el;
}

// ---- Konfluensi & tier keyakinan (field opsional dari backend akurasi) ----
// confluenceScore 0..100 = skor ATURAN (bukan probabilitas); confidenceTier 'A'..'D' (A tertinggi); winProbability
// 0..1 hanya bila sudah dikalibrasi backtest, selain itu null. Sinyal lama tidak membawa field ini (undefined) →
// diperlakukan null dan TIDAK ditampilkan apa pun (tanpa placeholder).

const TIER_RANK = Object.freeze({ A: 4, B: 3, C: 2, D: 1 });
const TIER_TONE = Object.freeze({ A: 'bull', B: 'accent', C: 'warn', D: undefined });
const TIER_TEXT = Object.freeze({
  A: 'konfluensi tertinggi',
  B: 'konfluensi baik',
  C: 'konfluensi sedang',
  D: 'konfluensi rendah',
});

/** Komponen konfluensi yang dikenal → label Bahasa Indonesia. Komponen lain tampil dengan namanya apa adanya. */
export const CONFLUENCE_COMPONENT_LABELS = Object.freeze({
  pattern: 'Pola',
  htf: 'Timeframe lebih tinggi',
  structure: 'Struktur pasar',
  orderFlow: 'Order flow',
  regime: 'Rezim pasar',
  liquidity: 'Likuiditas',
});

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Tier valid ('A'|'B'|'C'|'D', huruf kecil diterima) atau null. */
export function normalizeTier(tier) {
  if (typeof tier !== 'string') return null;
  const t = tier.trim().toUpperCase();
  return Object.hasOwn(TIER_RANK, t) ? t : null;
}

/** Peringkat tier untuk pengurutan (A=4 … D=1); null bila tidak ada tier. */
export function tierRank(tier) {
  const t = normalizeTier(tier);
  return t ? TIER_RANK[t] : null;
}

/**
 * Apakah tier memenuhi tier minimum. Tanpa minimum (kosong/tidak valid) → selalu true. Baris tanpa tier tidak
 * memenuhi minimum apa pun (keyakinannya tidak diketahui).
 */
export function meetsMinTier(tier, minTier) {
  const min = normalizeTier(minTier);
  if (!min) return true;
  const rank = tierRank(tier);
  return rank !== null && rank >= TIER_RANK[min];
}

/** Skor konfluensi 0..100 dibulatkan, atau null bila tidak ada/tidak valid. */
export function confluenceValue(score) {
  return isFiniteNum(score) ? Math.round(Math.max(0, Math.min(100, score))) : null;
}

/**
 * Probabilitas menang terkalibrasi → teks persen ('62%'), atau null bila belum dikalibrasi / tidak valid.
 * null berarti JANGAN tampilkan apa pun (bukan '—').
 * @param {number|null|undefined} p 0..1
 * @returns {string|null}
 */
export function formatWinProbability(p) {
  if (!isFiniteNum(p) || p < 0 || p > 1) return null;
  return `${Math.round(p * 100)}%`;
}

/**
 * Badge tier keyakinan: A = emerald dengan glow (kelas tier-badge--a), B = accent, C = warn, D = netral.
 * Berlabel teks "Tier X" (warna bukan satu-satunya penanda) + tooltip/aria-label. null bila tidak ada tier.
 * @returns {HTMLElement|null}
 */
export function tierBadge(tier) {
  const t = normalizeTier(tier);
  if (!t) return null;
  const el = badge(`Tier ${t}`, TIER_TONE[t]);
  el.classList.add('tier-badge', `tier-badge--${t.toLowerCase()}`);
  el.dataset.tier = t;
  const text = `Tier keyakinan ${t} — ${TIER_TEXT[t]} (A tertinggi, D terendah). Peringkat aturan, bukan probabilitas profit.`;
  el.title = text;
  el.setAttribute('aria-label', text);
  return el;
}

/**
 * Faktor konfluensi dari explanation[] ({ factor, contribution, detail }):
 * - 'CONFLUENCE:<komponen>' (pattern, htf, structure, orderFlow, regime, liquidity, …) → components
 * - 'CONFLUENCE:CONFIRM' → confirms, 'CONFLUENCE:CONFLICT' → conflicts
 * - 'CONFLUENCE:TIER' → tier (detail-nya), bukan komponen
 * Faktor non-konfluensi diabaikan. Tidak ada angka rekaan: contribution non-angka → null.
 * @param {Array<{ factor?: string, contribution?: number, detail?: string }>|null|undefined} explanation
 * @returns {{ components: Array<{ name: string, label: string, contribution: number|null, detail: string|null }>,
 *   confirms: Array<{ contribution: number|null, detail: string|null }>,
 *   conflicts: Array<{ contribution: number|null, detail: string|null }>, tier: { detail: string|null }|null }}
 */
export function confluenceBreakdown(explanation) {
  const out = { components: [], confirms: [], conflicts: [], tier: null };
  if (!Array.isArray(explanation)) return out;
  for (const item of explanation) {
    const factor = typeof item?.factor === 'string' ? item.factor : '';
    if (!factor.startsWith('CONFLUENCE:')) continue;
    const name = factor.slice('CONFLUENCE:'.length);
    if (!name) continue;
    const contribution = isFiniteNum(item.contribution) ? item.contribution : null;
    const detail = typeof item.detail === 'string' && item.detail ? item.detail : null;
    if (name === 'TIER') out.tier = { detail };
    else if (name === 'CONFIRM') out.confirms.push({ contribution, detail });
    else if (name === 'CONFLICT') out.conflicts.push({ contribution, detail });
    else out.components.push({ name, label: CONFLUENCE_COMPONENT_LABELS[name] ?? name, contribution, detail });
  }
  return out;
}

/** Apakah baris membawa data konfluensi/tier/probabilitas (untuk memutuskan kolom mana yang tampil). */
export function confluenceFieldsOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    tier: list.some((r) => normalizeTier(r?.confidenceTier) !== null),
    score: list.some((r) => confluenceValue(r?.confluenceScore) !== null),
    winProbability: list.some((r) => formatWinProbability(r?.winProbability) !== null),
  };
}

// ---------- kesegaran kolom "Update" ----------

// Selaras dengan TIMEFRAME_MS di backend/market/contracts.js (frontend tidak dapat mengimpor modul backend).
const UPDATE_TF_MS = Object.freeze({ '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000 });
/** Kelonggaran di atas 2 candle (antrean analisis, settle HTF, jeda polling) sebelum sinyal dinyatakan basi. */
const STALE_GRACE_MS = 2 * 60_000;

/**
 * Kesegaran sinyal terbuka. `updatedAt` = waktu tutup candle terakhir yang dievaluasi worker (bukan jam klien):
 * selama scanner berjalan nilainya maju tiap candle timeframe sinyal tertutup, jadi umur normal < 1 candle.
 * Basi = lebih dari 2 candle + kelonggaran tanpa evaluasi baru — scanner mati, sedang mengejar data setelah
 * restart, atau seri ini tertinggal. Timeframe tak dikenal / updatedAt kosong → tidak pernah dinyatakan basi.
 * @param {{ updatedAt?: number|null, timeframe?: string }} row
 * @param {number} [now]
 * @returns {{ stale: boolean, ageMs: number|null, staleAfterMs: number|null }}
 */
export function signalFreshness(row, now = Date.now()) {
  const at = row?.updatedAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return { stale: false, ageMs: null, staleAfterMs: null };
  const tfMs = UPDATE_TF_MS[row?.timeframe];
  const staleAfterMs = tfMs ? 2 * tfMs + STALE_GRACE_MS : null;
  const ageMs = Math.max(0, now - at);
  return { stale: staleAfterMs !== null && ageMs > staleAfterMs, ageMs, staleAfterMs };
}

/** Mengisi ulang teks, judul, dan penanda basi sel "Update" dari data-* miliknya (dipakai render & ticker). */
export function paintUpdatedCell(el, now = Date.now()) {
  const updatedAt = Number(el.dataset.updatedAt);
  const row = { updatedAt: el.dataset.updatedAt === '' ? null : updatedAt, timeframe: el.dataset.timeframe };
  const { stale } = signalFreshness(row, now);
  const text = formatRelative(row.updatedAt, now);
  const label = el.firstChild;
  if (label.textContent !== text) label.textContent = text;
  const tag = el.querySelector('.updated-at__stale');
  tag.hidden = !stale;
  if (stale) el.dataset.stale = 'true';
  else delete el.dataset.stale;
  el.title = row.updatedAt === null ? 'Belum ada evaluasi tercatat'
    : stale
      ? `Basi: evaluasi terakhir pada candle ${row.timeframe} yang tutup ${formatUtc(row.updatedAt)}. Lebih dari 2 candle tanpa evaluasi baru — scanner mati, sedang mengejar data setelah restart, atau seri ini tertinggal.`
      : `Evaluasi terakhir: candle ${row.timeframe} yang tutup ${formatUtc(row.updatedAt)}. Diperbarui tiap candle tertutup selama scanner berjalan.`;
}

/**
 * Sel kolom "Update": waktu relatif evaluasi terakhir + penanda "Basi" bila sinyal tidak dievaluasi ulang lebih dari
 * 2 candle. Teks dihitung ulang oleh refreshUpdatedCells (ticker halaman), jadi "x menit lalu" tidak membeku.
 */
export function updatedCell(row, now = Date.now()) {
  const at = typeof row?.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? String(row.updatedAt) : '';
  const el = h('span', { class: 'updated-at', 'data-updated-at': at, 'data-timeframe': row?.timeframe ?? '', 'data-testid': 'updated-at' },
    h('span', { class: 'updated-at__text' }, EMPTY),
    h('span', { class: 'updated-at__stale', hidden: true }, 'Basi'));
  paintUpdatedCell(el, now);
  return el;
}

/** Menghitung ulang semua sel "Update" di dalam `root` terhadap `now`. */
export function refreshUpdatedCells(root, now = Date.now()) {
  for (const el of root.querySelectorAll('.updated-at[data-updated-at]')) paintUpdatedCell(el, now);
}
