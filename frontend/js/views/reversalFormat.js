// Label Indonesia & helper murni untuk "Reversal Radar" (LONG Scanner): deteksi dini potensi reversal bullish.
// Kontrak: docs/19-kontrak-reversal-radar.md §2 (konstanta), §5 (bentuk baris API `toView`), §8 (UI).
// Bagian atas file ini bebas DOM (dapat diuji di Node); helper yang membuat elemen ada di bagian "DOM".
// Skor di sini = jumlah poin aturan (0–100) yang dapat dijelaskan — BUKAN probabilitas, BUKAN perintah transaksi.
import { badge, score } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { EMPTY, formatPercent, formatPrice, formatTime } from '../lib/format.js';

// ---------- Konstanta (selaras dengan backend/reversal/constants.js; frontend tidak mengimpor modul backend) ----------

export const REVERSAL_TIMEFRAMES = Object.freeze(['5m', '15m', '1h']);
export const STAGES = Object.freeze(['EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT']);
export const STAGE_RANK = Object.freeze({ EARLY_FORMATION: 1, DEVELOPING_REVERSAL: 2, CONFIRMED_BREAKOUT: 3 });
export const STATUSES = Object.freeze(['NEW', 'DEVELOPING', 'CONFIRMED', 'CANCELLED', 'EXPIRED']);
export const OPEN_STATUSES = Object.freeze(['NEW', 'DEVELOPING', 'CONFIRMED']);
export const STATUS_OF_STAGE = Object.freeze({ EARLY_FORMATION: 'NEW', DEVELOPING_REVERSAL: 'DEVELOPING', CONFIRMED_BREAKOUT: 'CONFIRMED' });
export const SETUP_TYPES = Object.freeze(['ROUNDED_BOTTOM', 'DOUBLE_BOTTOM', 'HIGHER_LOW_BASE', 'STAIRCASE', 'SPRING', 'DIVERGENCE_BOTTOM', 'COMPRESSION']);
export const EVIDENCE_GROUPS = Object.freeze(['EXHAUSTION', 'BASE', 'STRUCTURE', 'VOLUME', 'TRIGGER']);
export const EVIDENCE_IDS = Object.freeze([
  'LL_SHALLOWER', 'LL_STOPPED', 'BOTTOM_HELD', 'DOWN_MOMENTUM_FADING', 'RSI_DIVERGENCE', 'CVD_DIVERGENCE',
  'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'RANGE_CONTRACTION', 'ROUNDED_BOTTOM', 'RISING_FLOOR',
  'HIGHER_LOW', 'SPRING_RECLAIM', 'EMA25_RECLAIM', 'EMA7_TURN_UP', 'CHOCH_BULLISH', 'STAIRCASE',
  'VOLUME_DRY_UP', 'QUIET_RISE',
  'TRIGGER_BREAK', 'BREAK_VOLUME_SUPPORT', 'BREAK_FOLLOW_THROUGH',
]);
export const RISKS = Object.freeze([
  'HTF_DOWNTREND', 'HTF_UNKNOWN', 'LOW_LIQUIDITY', 'ILLIQUID', 'EXTENDED', 'LATE_ENTRY', 'VOLATILITY_EXPANDING',
  'NO_VOLUME_SUPPORT', 'NEAR_INVALIDATION', 'DATA_QUALITY', 'PROVISIONAL',
]);
export const LIQUIDITY_CLASSES = Object.freeze(['LIQUID', 'THIN', 'ILLIQUID', 'UNKNOWN']);
export const SENSITIVITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
/** Sensitivitas = FILTER TAMPILAN di server (skor & jumlah bukti minimum), bukan parameter mesin. */
export const SENSITIVITY_FILTERS = Object.freeze({
  LOW: Object.freeze({ minScore: 60, minEvidence: 4 }),
  MEDIUM: Object.freeze({ minScore: 45, minEvidence: 3 }),
  HIGH: Object.freeze({ minScore: 0, minEvidence: 0 }),
});
export const EVENT_TYPES = Object.freeze(['OPENED', 'STAGE_UP', 'CANCELLED', 'EXPIRED', 'PROVISIONAL_STAGE']);
export const MARKER_KINDS = Object.freeze(['BOTTOM', 'LOWER_LOW', 'HIGHER_LOW', 'SPRING', 'CHOCH', 'TRIGGER', 'DIVERGENCE', 'DETECTED', 'STAGE_UP', 'CANCELLED']);

// ---------- Label Indonesia ----------

/** Nama tahap dipakai apa adanya (Inggris, sesuai permintaan pengguna) dengan keterangan Indonesia di bawahnya. */
export const STAGE_LABELS = Object.freeze({
  EARLY_FORMATION: Object.freeze({
    title: 'Early Formation',
    short: 'Early',
    text: 'Tekanan turun melemah dan dasar mulai terbentuk — belum ada perubahan struktur, masih perlu konfirmasi.',
  }),
  DEVELOPING_REVERSAL: Object.freeze({
    title: 'Developing Reversal',
    short: 'Developing',
    text: 'Struktur minor berubah (higher low, reclaim EMA25, CHoCH) — menunggu close di atas level pemicu.',
  }),
  CONFIRMED_BREAKOUT: Object.freeze({
    title: 'Confirmed Breakout',
    short: 'Confirmed',
    text: 'Close di atas level pemicu dengan dukungan volume atau follow-through — pantau retest, bukan jaminan lanjut.',
  }),
});

export const STATUS_LABELS = Object.freeze({
  NEW: 'Baru', DEVELOPING: 'Berkembang', CONFIRMED: 'Terkonfirmasi', CANCELLED: 'Batal', EXPIRED: 'Kedaluwarsa',
});

export const SETUP_TYPE_LABELS = Object.freeze({
  ROUNDED_BOTTOM: 'Dasar membulat',
  DOUBLE_BOTTOM: 'Double bottom',
  HIGHER_LOW_BASE: 'Basis higher low',
  STAIRCASE: 'Tangga naik',
  SPRING: 'Spring (sapuan)',
  DIVERGENCE_BOTTOM: 'Dasar divergensi',
  COMPRESSION: 'Kompresi',
});

export const EVIDENCE_GROUP_LABELS = Object.freeze({
  EXHAUSTION: 'Tekanan turun melemah',
  BASE: 'Dasar & kompresi',
  STRUCTURE: 'Perubahan struktur',
  VOLUME: 'Karakter volume',
  TRIGGER: 'Pemicu',
});

export const EVIDENCE_LABELS = Object.freeze({
  LL_SHALLOWER: 'Lower low makin dangkal',
  LL_STOPPED: 'Lower low berhenti',
  BOTTOM_HELD: 'Dasar bertahan saat retest',
  DOWN_MOMENTUM_FADING: 'Momentum turun memudar',
  RSI_DIVERGENCE: 'Divergensi RSI bullish',
  CVD_DIVERGENCE: 'Divergensi CVD bullish',
  ATR_CONTRACTION: 'Kontraksi ATR',
  EMA_CONVERGENCE: 'EMA7 & EMA25 merapat',
  RANGE_CONTRACTION: 'Range menyempit',
  ROUNDED_BOTTOM: 'Dasar membulat',
  RISING_FLOOR: 'Dasar makin tinggi',
  HIGHER_LOW: 'Higher low terkonfirmasi',
  SPRING_RECLAIM: 'Spring: sapuan lalu reclaim',
  EMA25_RECLAIM: 'Reclaim EMA25',
  EMA7_TURN_UP: 'EMA7 berbalik naik',
  CHOCH_BULLISH: 'CHoCH bullish',
  STAIRCASE: 'Struktur tangga naik',
  VOLUME_DRY_UP: 'Volume mengering',
  QUIET_RISE: 'Naik tenang (RVOL rendah)',
  TRIGGER_BREAK: 'Close di atas level pemicu',
  BREAK_VOLUME_SUPPORT: 'Breakout didukung volume',
  BREAK_FOLLOW_THROUGH: 'Follow-through breakout',
});

export const RISK_LABELS = Object.freeze({
  HTF_DOWNTREND: 'Tren HTF turun',
  HTF_UNKNOWN: 'Tren HTF tidak diketahui',
  LOW_LIQUIDITY: 'Likuiditas tipis',
  ILLIQUID: 'Tidak likuid',
  EXTENDED: 'Sudah extended',
  LATE_ENTRY: 'Terlambat (jauh dari bottom)',
  VOLATILITY_EXPANDING: 'Volatilitas melebar',
  NO_VOLUME_SUPPORT: 'Breakout tanpa dukungan volume',
  NEAR_INVALIDATION: 'Dekat level invalidasi',
  DATA_QUALITY: 'Kualitas data',
  PROVISIONAL: 'Candle belum tutup (provisional)',
});

export const LIQUIDITY_LABELS = Object.freeze({
  LIQUID: 'Likuid', THIN: 'Tipis', ILLIQUID: 'Tidak likuid', UNKNOWN: 'Tidak diketahui',
});

export const CANCEL_REASON_LABELS = Object.freeze({
  CLOSE_BELOW_INVALIDATION: 'Close di bawah level invalidasi',
  BREAKOUT_FAILED: 'Breakout gagal',
  NO_PROGRESS: 'Tanpa kemajuan',
  EVIDENCE_FADED: 'Bukti melemah',
  SYMBOL_DELISTED: 'Simbol dihapus dari bursa',
  MONITORING_STOPPED: 'Pemantauan dihentikan',
});

export const EVENT_TYPE_LABELS = Object.freeze({
  OPENED: 'Kandidat dibuka',
  STAGE_UP: 'Naik tahap',
  CANCELLED: 'Batal',
  EXPIRED: 'Kedaluwarsa',
  PROVISIONAL_STAGE: 'Tahap provisional (candle berjalan)',
});

export const NEXT_CONFIRMATION_LABELS = Object.freeze({
  HIGHER_LOW: 'Higher low terkonfirmasi',
  EMA25_RECLAIM: 'Close di atas EMA25',
  TRIGGER_BREAK: 'Close di atas level pemicu',
  HOLD_ABOVE_TRIGGER: 'Bertahan di atas pemicu saat retest',
  NONE: 'Tidak ada',
});

/** Label timeframe untuk badge jumlah ("5m 3 · 15m 2 · 1H 1"). */
export const TIMEFRAME_LABELS = Object.freeze({ '5m': '5m', '15m': '15m', '1h': '1H' });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** Kode tak dikenal tampil terbaca (garis bawah → spasi), bukan disembunyikan. */
const codeText = (code) => (typeof code === 'string' && code ? code.replaceAll('_', ' ') : EMPTY);

export const stageLabel = (stage) => STAGE_LABELS[stage]?.title ?? codeText(stage);
export const statusLabel = (status) => STATUS_LABELS[status] ?? codeText(status);
export const setupTypeLabel = (type) => SETUP_TYPE_LABELS[type] ?? codeText(type);
export const evidenceLabel = (id) => EVIDENCE_LABELS[id] ?? codeText(id);
export const riskLabel = (id) => RISK_LABELS[id] ?? codeText(id);
export const liquidityLabel = (cls) => LIQUIDITY_LABELS[cls] ?? codeText(cls);
export const timeframeLabel = (tf) => TIMEFRAME_LABELS[tf] ?? String(tf ?? EMPTY);

// ---------- Baris kandidat (bentuk `toView`, docs/19 §5) ----------

/** Kandidat provisional-only: hanya ada di evaluasi candle berjalan (id null), belum menjadi kandidat. */
export const isProvisionalOnly = (row) => row?.provisionalOnly === true || (row?.id === null && row?.provisional !== null && row?.provisional !== undefined);

/** Tahap yang menentukan panel: tahap kandidat; kandidat provisional-only memakai tahap evaluasi berjalannya. */
export function effectiveStage(row) {
  if (!row) return null;
  if (STAGES.includes(row.stage)) return row.stage;
  const prov = row.provisional?.stage;
  return STAGES.includes(prov) ? prov : null;
}

/** Status efektif: status kandidat; provisional-only tanpa status → status tahap evaluasinya. */
export function effectiveStatus(row) {
  if (STATUSES.includes(row?.status)) return row.status;
  const stage = effectiveStage(row);
  return stage ? STATUS_OF_STAGE[stage] : null;
}

/** Skor 0..100 dibulatkan; provisional-only tanpa skor kandidat memakai skor evaluasi berjalan. null bila tidak ada. */
export function scoreValue(row) {
  const raw = isNum(row?.score) ? row.score : row?.provisional?.score;
  return isNum(raw) ? Math.round(Math.max(0, Math.min(100, raw))) : null;
}

/** Status candle evaluasi terakhir: 'CLOSED' | 'RUNNING' (provisional-only tanpa field = RUNNING). */
export function candleStatusOf(row) {
  if (row?.candleStatus === 'RUNNING' || row?.candleStatus === 'CLOSED') return row.candleStatus;
  return isProvisionalOnly(row) ? 'RUNNING' : 'CLOSED';
}

/** Waktu evaluasi terakhir untuk kolom "Update": closeTime candle terakhir yang dievaluasi (provisional: evaluatedAt). */
export function lastEvaluatedAtOf(row) {
  if (isNum(row?.lastEvaluatedAt)) return row.lastEvaluatedAt;
  if (isNum(row?.provisional?.evaluatedAt)) return row.provisional.evaluatedAt;
  return isNum(row?.updatedAt) ? row.updatedAt : null;
}

/** Kunci identitas: satu kandidat terbuka (atau provisional-only) per simbol × timeframe. */
export const rowKey = (row) => `${row?.symbol}|${row?.timeframe}`;

/** Pengelompokan per tahap, urutan tetap STAGES; baris tanpa tahap dikenal masuk `other` (tidak dibuang diam-diam). */
export function groupByStage(items) {
  const out = { EARLY_FORMATION: [], DEVELOPING_REVERSAL: [], CONFIRMED_BREAKOUT: [], other: [] };
  for (const row of Array.isArray(items) ? items : []) {
    const stage = effectiveStage(row);
    (stage ? out[stage] : out.other).push(row);
  }
  return out;
}

/** Jumlah baris per timeframe (selalu memuat ketiga timeframe, 0 bila kosong) + `total`. */
export function countsByTimeframe(items) {
  const out = { '5m': 0, '15m': 0, '1h': 0, total: 0 };
  for (const row of Array.isArray(items) ? items : []) {
    out.total += 1;
    if (Object.hasOwn(out, row?.timeframe) && row.timeframe !== 'total') out[row.timeframe] += 1;
  }
  return out;
}

/** "5m 3 · 15m 2 · 1H 1" dari countsByTimeframe (timeframe dengan 0 tetap tampil agar jujur). */
export function formatTimeframeCounts(counts) {
  return REVERSAL_TIMEFRAMES.map((tf) => `${TIMEFRAME_LABELS[tf]} ${counts?.[tf] ?? 0}`).join(' · ');
}

/** Pergerakan sejak deteksi pertama: % dan ×ATR (null bila tidak terhitung) + penanda Extended / Terlambat. */
export function moveInfo(row) {
  const risks = Array.isArray(row?.risks) ? row.risks : [];
  return {
    pct: isNum(row?.moveSinceDetectionPct) ? row.moveSinceDetectionPct : null,
    atr: isNum(row?.moveSinceDetectionAtr) ? row.moveSinceDetectionAtr : null,
    extended: row?.extended === true || risks.includes('EXTENDED'),
    late: risks.includes('LATE_ENTRY'),
  };
}

/** Ringkasan bukti untuk sel tabel: jumlah + dua label pertama. */
export function evidencePreview(row, max = 2) {
  const list = Array.isArray(row?.evidence) ? row.evidence : [];
  const count = isNum(row?.evidenceCount) ? row.evidenceCount : list.length;
  const labels = list.slice(0, max).map((e) => (typeof e === 'string' ? evidenceLabel(e) : e?.label || evidenceLabel(e?.id)));
  return { count, labels, more: Math.max(0, count - labels.length) };
}

// ---------- Filter & query (docs/19 §7–§8.3) ----------

export const FILTER_STORAGE_KEY = 'lr.reversal.filters';
/** Batas maksimum API (1–500). */
export const REVERSAL_LIMIT = 500;

export const DEFAULT_FILTERS = Object.freeze({
  timeframe: '', stage: '', status: '', liquidity: '', sensitivity: 'MEDIUM', hideExtended: false, showProvisional: true,
});

const pick = (value, allowed) => (allowed.includes(value) ? value : '');

/** Filter tersimpan/masukan → bentuk valid (nilai tak dikenal → default). Tidak pernah melempar. */
export function normalizeFilters(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    timeframe: pick(src.timeframe, REVERSAL_TIMEFRAMES),
    stage: pick(src.stage, STAGES),
    status: pick(src.status, OPEN_STATUSES),
    liquidity: pick(src.liquidity, ['LIQUID', 'THIN']),
    sensitivity: SENSITIVITIES.includes(src.sensitivity) ? src.sensitivity : DEFAULT_FILTERS.sensitivity,
    hideExtended: src.hideExtended === true || src.hideExtended === 'true' || src.hideExtended === 'on' || src.hideExtended === '1',
    showProvisional: !(src.showProvisional === false || src.showProvisional === 'false' || src.showProvisional === '0'),
  };
}

/** Filter dari elemen form toolbar (nama field = kunci filter; toggle = checkbox). */
export function readFilters(form) {
  const el = form?.elements;
  if (!el) return normalizeFilters(null);
  const value = (name) => el[name]?.value ?? '';
  const checked = (name) => Boolean(el[name]?.checked);
  return normalizeFilters({
    timeframe: value('timeframe'), stage: value('stage'), status: value('status'), liquidity: value('liquidity'),
    sensitivity: value('sensitivity'), hideExtended: checked('hideExtended'), showProvisional: checked('showProvisional'),
  });
}

/**
 * URL GET /api/reversal/candidates dari filter (objek filter atau elemen form). SEMUA filter dikirim ke server dan
 * diterapkan sebelum limit; sensitivitas, extended, provisional, dan limit selalu eksplisit.
 */
export function buildReversalQuery(filtersOrForm, { limit = REVERSAL_LIMIT } = {}) {
  const f = filtersOrForm?.elements ? readFilters(filtersOrForm) : normalizeFilters(filtersOrForm);
  const params = new URLSearchParams();
  if (f.timeframe) params.set('timeframe', f.timeframe);
  if (f.stage) params.set('stage', f.stage);
  if (f.status) params.set('status', f.status);
  if (f.liquidity) params.set('liquidity', f.liquidity);
  params.set('sensitivity', f.sensitivity);
  params.set('includeExtended', f.hideExtended ? '0' : '1');
  params.set('includeProvisional', f.showProvisional ? '1' : '0');
  params.set('limit', String(limit));
  return `/api/reversal/candidates?${params.toString()}`;
}

const LIQUIDITY_RANK = Object.freeze({ LIQUID: 3, THIN: 2, ILLIQUID: 1, UNKNOWN: 0 });

/**
 * Penjaga kontrak di klien (bukan pengganti filter server): baris yang tidak cocok dengan filter yang dikirim
 * tidak pernah ditampilkan, walau server (versi lama) mengabaikan salah satu parameter. Idempoten terhadap hasil
 * server yang benar. Sensitivitas tidak diulang di klien: ambangnya milik server (meta.filters).
 */
export function applyFilters(items, filters) {
  const f = normalizeFilters(filters);
  return (Array.isArray(items) ? items : []).filter((row) => {
    if (f.timeframe && row?.timeframe !== f.timeframe) return false;
    if (f.stage && effectiveStage(row) !== f.stage) return false;
    if (f.status && effectiveStatus(row) !== f.status) return false;
    if (f.liquidity && (LIQUIDITY_RANK[row?.liquidityClass] ?? 0) < LIQUIDITY_RANK[f.liquidity]) return false;
    if (f.hideExtended && moveInfo(row).extended) return false;
    if (!f.showProvisional && isProvisionalOnly(row)) return false;
    return true;
  });
}

// ---------- Diff antarpolling (sorotan baris baru / naik) ----------

/** Snapshot ringkas per kunci untuk diffRows. */
export const snapshotOf = (rows) => new Map((Array.isArray(rows) ? rows : [])
  .map((r) => [rowKey(r), { stage: effectiveStage(r), score: scoreValue(r), provisionalOnly: isProvisionalOnly(r) }]));

/**
 * Selisih dua muatan nyata pada filter yang sama → Map kunci → 'new' | 'up' | 'down'.
 * 'new' = belum ada sebelumnya; 'up' = tahap naik, provisional-only menjadi kandidat, atau skor naik;
 * 'down' = skor turun (tahap tidak pernah turun). `previous` null → Map kosong (muatan pertama / filter berubah).
 * @param {Map<string, { stage: string|null, score: number|null, provisionalOnly: boolean }>|null} previous
 */
export function diffRows(previous, rows) {
  const out = new Map();
  if (!previous) return out;
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = rowKey(r);
    const before = previous.get(key);
    if (!before) {
      out.set(key, 'new');
      continue;
    }
    const stageDelta = (STAGE_RANK[effectiveStage(r)] ?? 0) - (STAGE_RANK[before.stage] ?? 0);
    if (stageDelta > 0 || (before.provisionalOnly && !isProvisionalOnly(r))) {
      out.set(key, 'up');
      continue;
    }
    const delta = (scoreValue(r) ?? 0) - (before.score ?? 0);
    if (delta !== 0) out.set(key, delta > 0 ? 'up' : 'down');
  }
  return out;
}

// ---------- Detail: level, penanda grafik, riwayat ----------

/** Level grafik: invalidasi (bear), bottom (support), trigger (resistance), harga deteksi pertama. Nilai kosong dilewati. */
export function levelsOf(row) {
  const lv = row?.levels ?? {};
  return [
    { price: lv.invalidation, kind: 'invalidation' },
    { price: lv.bottom, kind: 'support', label: 'Bottom' },
    { price: lv.trigger, kind: 'resistance', label: 'Trigger' },
    { price: row?.firstDetectedPrice, kind: 'detected' },
  ].filter((l) => isNum(l.price) && l.price > 0);
}

/** Daftar level penting untuk bagian "Level penting" (hanya yang tersedia; angka nyata dari API). */
export function importantLevels(row) {
  const lv = row?.levels ?? {};
  return [
    ['Invalidasi', lv.invalidation], ['Bottom', lv.bottom], ['Swing low terakhir', lv.lastSwingLow], ['Higher low', lv.higherLow],
    ['Level pemicu (trigger)', lv.trigger], ['EMA25', lv.ema25], ['EMA7', lv.ema7], ['ATR', lv.atr],
    ['Harga deteksi pertama', row?.firstDetectedPrice], ['Harga tertinggi sejak deteksi', row?.peakPrice],
  ].filter(([, price]) => isNum(price)).map(([label, price]) => ({ label, price }));
}

/** Jenis penanda grafik dari jenis event riwayat. */
const EVENT_MARKER = Object.freeze({ OPENED: 'DETECTED', STAGE_UP: 'STAGE_UP', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED', PROVISIONAL_STAGE: 'PROVISIONAL' });

/**
 * Penanda grafik: bukti dari `markers` kandidat + event riwayat (OPENED → DETECTED, STAGE_UP, CANCELLED, EXPIRED,
 * PROVISIONAL_STAGE → PROVISIONAL). Tanpa event & tanpa marker DETECTED → titik deteksi pertama. Waktu = openTime candle.
 */
export function markersOf(row, events = []) {
  const out = [];
  let detected = false;
  for (const m of Array.isArray(row?.markers) ? row.markers : []) {
    if (!m || !isNum(m.time) || typeof m.kind !== 'string') continue;
    if (m.kind === 'DETECTED') detected = true;
    out.push({ time: m.time, kind: m.kind });
  }
  for (const e of Array.isArray(events) ? events : []) {
    const time = isNum(e?.candleTime) ? e.candleTime : e?.occurredAt;
    const kind = EVENT_MARKER[e?.type];
    if (!isNum(time) || !kind) continue;
    if (kind === 'DETECTED') detected = true;
    out.push({ time, kind });
  }
  if (!detected && isNum(row?.firstDetectedAt) && !isProvisionalOnly(row)) out.push({ time: row.firstDetectedAt, kind: 'DETECTED' });
  return out;
}

/** Entri riwayat (urut waktu naik) dari event API; event provisional ditandai. Tanpa event → []. */
export function historyEntries(events) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && typeof e.type === 'string');
  const entries = list.map((e) => {
    const stage = e.toStage ? stageLabel(e.toStage) : null;
    const transition = e.fromStage && e.toStage ? `${stageLabel(e.fromStage)} → ${stageLabel(e.toStage)}` : stage;
    const reason = e.reason ? CANCEL_REASON_LABELS[e.reason] ?? codeText(e.reason) : null;
    return {
      at: isNum(e.occurredAt) ? e.occurredAt : isNum(e.candleTime) ? e.candleTime : null,
      type: e.type,
      title: EVENT_TYPE_LABELS[e.type] ?? codeText(e.type),
      stage: transition,
      status: e.toStatus ? statusLabel(e.toStatus) : null,
      price: isNum(e.price) ? e.price : null,
      reason,
      provisional: e.provisional === true,
      terminal: e.type === 'CANCELLED' || e.type === 'EXPIRED',
      changes: 1,
    };
  }).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  // Perubahan tahap provisional yang berurutan (tanpa event candle tutup di antaranya) dilipat menjadi entri terakhirnya
  // dengan jumlah perubahan: candle berjalan bisa berpindah tahap berkali-kali sebelum tutup — riwayatnya tetap
  // tersimpan di server, tetapi daftar tidak dipenuhi entri provisional yang berkedip.
  const out = [];
  for (const entry of entries) {
    const prev = out[out.length - 1];
    if (entry.provisional && prev?.provisional) {
      out[out.length - 1] = { ...entry, changes: prev.changes + 1 };
    } else {
      out.push(entry);
    }
  }
  return out.map((e) => (e.changes > 1 ? { ...e, title: `${e.title} · ${e.changes} perubahan berurutan` } : e));
}

/** Komponen skor: selalu 5 grup berurutan (poin 0 bila tidak ada), nilai dibatasi 0..max. */
export function normalizeScoreComponents(components) {
  const byId = new Map((Array.isArray(components) ? components : []).filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
  const DEFAULT_MAX = { EXHAUSTION: 25, BASE: 25, STRUCTURE: 30, VOLUME: 10, TRIGGER: 10 };
  return EVIDENCE_GROUPS.map((id) => {
    const c = byId.get(id);
    const max = isNum(c?.max) && c.max > 0 ? c.max : DEFAULT_MAX[id];
    const points = isNum(c?.points) ? Math.max(0, Math.min(max, c.points)) : 0;
    return { id, label: c?.label || EVIDENCE_GROUP_LABELS[id], points, max };
  });
}

// ---------- DOM ----------

const STAGE_TONE = Object.freeze({ EARLY_FORMATION: 'accent', DEVELOPING_REVERSAL: 'violet', CONFIRMED_BREAKOUT: 'bull' });

/** Badge tahap (nama Inggris + tooltip keterangan Indonesia). */
export function stageBadge(stage) {
  const el = badge(stageLabel(stage), STAGE_TONE[stage]);
  el.classList.add('rr-stage-badge');
  el.dataset.stage = stage ?? '';
  const text = STAGE_LABELS[stage]?.text;
  if (text) {
    el.title = text;
    el.setAttribute('aria-label', `${stageLabel(stage)} — ${text}`);
  }
  return el;
}

/**
 * Pill status (Baru / Berkembang / Terkonfirmasi / Batal / Kedaluwarsa). Kandidat provisional-only mendapat label
 * "provisional"; kandidat terbuka yang evaluasi candle berjalannya sudah di tahap lebih tinggi diberi petunjuk kecil.
 */
export function statusPill(row) {
  const status = effectiveStatus(row);
  const provisionalOnly = isProvisionalOnly(row);
  const el = h('span', { class: 'rr-pill', 'data-status': status ?? 'UNKNOWN' },
    h('span', { class: 'rr-pill__dot', 'aria-hidden': 'true' }),
    h('span', { class: 'rr-pill__text' }, statusLabel(status)));
  if (provisionalOnly) {
    el.append(h('span', {
      class: 'rr-pill__prov', 'data-testid': 'rr-provisional-label',
      title: 'Evaluasi candle yang belum tutup: belum menjadi kandidat, dapat berubah sampai candle tutup.',
    }, 'provisional'));
    return el;
  }
  const prov = row?.provisional?.stage;
  if (STAGES.includes(prov) && (STAGE_RANK[prov] ?? 0) > (STAGE_RANK[effectiveStage(row)] ?? 0)) {
    el.append(h('span', { class: 'rr-pill__hint', title: 'Tahap pada candle berjalan (provisional) — belum dikonfirmasi candle tutup.' },
      `→ ${STAGE_LABELS[prov].short} (berjalan)`));
  }
  return el;
}

/** Sel "Sejak deteksi": % dan ×ATR + badge Extended / Terlambat. Nilai tidak terhitung → '—'. */
export function moveCell(row) {
  const { pct, atr, extended, late } = moveInfo(row);
  const parts = [];
  if (pct !== null) parts.push(formatPercent(pct));
  if (atr !== null) parts.push(`${atr.toFixed(1).replace('.', ',')}×ATR`);
  const el = h('span', { class: 'rr-move', 'data-extended': extended ? 'true' : undefined },
    h('span', { class: 'num rr-move__text', 'data-sign': pct === null ? undefined : pct >= 0 ? 'up' : 'down' }, parts.length ? parts.join(' · ') : EMPTY));
  if (extended) {
    el.append(h('span', { class: 'rr-move__badge', 'data-kind': 'extended', title: 'Sudah bergerak ≥ 2,5×ATR atau ≥ 8% sejak deteksi pertama — ditandai, tidak dibuang.' }, 'Extended'));
  }
  if (late) {
    el.append(h('span', { class: 'rr-move__badge', 'data-kind': 'late', title: 'Saat deteksi pertama harga sudah ≥ 4×ATR di atas bottom.' }, 'Terlambat'));
  }
  return el;
}

/** Badge candle evaluasi terakhir: Tutup (candle tertutup) / Berjalan (provisional, dapat berubah). */
export function candleStatusBadge(row) {
  const running = candleStatusOf(row) === 'RUNNING';
  const el = badge(running ? 'Berjalan' : 'Tutup', running ? 'warn' : undefined);
  el.classList.add('rr-candle');
  el.dataset.candle = running ? 'RUNNING' : 'CLOSED';
  el.title = running ? 'Evaluasi dari candle yang belum tutup — dapat berubah sampai candle tutup.' : 'Evaluasi dari candle tertutup.';
  return el;
}

/** Badge kelas likuiditas (warna bukan satu-satunya penanda: selalu berlabel teks). */
export function liquidityBadge(cls) {
  const tone = cls === 'LIQUID' ? 'bull' : cls === 'THIN' ? 'warn' : cls === 'ILLIQUID' ? 'bear' : undefined;
  const el = badge(liquidityLabel(cls), tone);
  el.dataset.liquidity = cls ?? 'UNKNOWN';
  return el;
}

/** Badge risiko (subset RISKS). Tanpa risiko → '—'. */
export function riskBadges(risks) {
  const list = Array.isArray(risks) ? risks.filter((r) => typeof r === 'string') : [];
  if (list.length === 0) return h('span', { class: 'subtle' }, 'Tidak ada risiko tercatat');
  return h('span', { class: 'cluster rr-risks' }, list.map((r) => {
    const el = badge(riskLabel(r), r === 'PROVISIONAL' || r === 'HTF_UNKNOWN' || r === 'DATA_QUALITY' ? undefined : 'warn');
    el.dataset.risk = r;
    return el;
  }));
}

/** Sel skor: meter 0–100 bernada bull + tooltip "kecocokan aturan, bukan probabilitas". */
export function scoreCell(row) {
  const value = scoreValue(row);
  if (value === null) return h('span', { class: 'subtle' }, EMPTY);
  const el = score(value, 'bull');
  el.classList.add('rr-score');
  const text = `Skor ${value}/100 — jumlah poin aturan yang terpenuhi, bukan probabilitas.`;
  el.title = text;
  el.setAttribute('aria-label', text);
  return el;
}

/** Sel bukti: jumlah + dua label pertama (sisanya "+N"); tooltip memuat semua label. */
export function evidenceCell(row) {
  const { count, labels, more } = evidencePreview(row);
  const all = (Array.isArray(row?.evidence) ? row.evidence : []).map((e) => (typeof e === 'string' ? evidenceLabel(e) : e?.label || evidenceLabel(e?.id)));
  const el = h('span', { class: 'rr-evidence-cell', title: all.length ? all.join(' · ') : undefined },
    h('span', { class: 'num rr-evidence-cell__count' }, String(count)),
    labels.length ? h('span', { class: 'rr-evidence-cell__labels' }, labels.join(', ') + (more > 0 ? ` +${more}` : '')) : null);
  return el;
}

/** Lima bar komponen skor (poin / maks per grup) — penjelasan skor, bukan probabilitas. */
export function scoreComponentBars(components) {
  const items = normalizeScoreComponents(components);
  return h('ul', { class: 'rr-bars', 'aria-label': 'Komponen skor per grup bukti' }, items.map((c) => h('li', { class: 'rr-bar', 'data-group': c.id },
    h('span', { class: 'rr-bar__label' }, c.label),
    h('span', { class: 'rr-bar__track', 'aria-hidden': 'true' },
      h('span', { class: 'rr-bar__fill', style: { '--lr-meter': String(c.max > 0 ? c.points / c.max : 0) } })),
    h('span', { class: 'rr-bar__value num' }, `${Math.round(c.points)}/${c.max}`))));
}

/** Teks "deteksi pertama" (WIB) atau penjelasan jujur untuk provisional-only. */
export function firstDetectedText(row) {
  if (isNum(row?.firstDetectedAt)) return formatTime(row.firstDetectedAt);
  return EMPTY;
}

/** Harga dengan presisi adaptif; dipakai ulang agar sel tabel & detail konsisten. */
export const priceText = (value) => formatPrice(value);
