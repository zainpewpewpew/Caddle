// Format data finansial. Semua waktu internal adalah epoch ms UTC.

const LOCALE = 'id-ID';

const compact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat(LOCALE, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });

export const EMPTY = '—';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function formatInteger(value) {
  return isNum(value) ? integer.format(value) : EMPTY;
}

export function formatCompact(value) {
  return isNum(value) ? compact.format(value) : EMPTY;
}

/** Harga dengan presisi adaptif: aset murah butuh lebih banyak desimal. */
export function formatPrice(value) {
  if (!isNum(value)) return EMPTY;
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits }).format(value);
}

/** @param {number} ratio contoh 0.0123 → +1,23% */
export function formatPercent(ratio) {
  return isNum(ratio) ? percent.format(ratio) : EMPTY;
}

export function formatBytes(bytes) {
  if (!isNum(bytes)) return EMPTY;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  if (!isNum(seconds)) return EMPTY;
  const d = Math.floor(seconds / 86400);
  const hrs = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  // Satuan ditulis jelas agar tidak ambigu ("6d" bisa dibaca 6 hari).
  if (d) return `${d} hari ${hrs} jam`;
  if (hrs) return `${hrs} jam ${m} mnt`;
  if (m) return `${m} mnt ${s} dtk`;
  return `${s} dtk`;
}

const pad = (n) => String(n).padStart(2, '0');

/** Waktu UTC kanonik, contoh 2026-10-25 13:05:00 UTC. */
export function formatUtc(ms) {
  if (!isNum(ms)) return EMPTY;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function formatClockUtc(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function formatRelative(ms, now = Date.now()) {
  if (!isNum(ms)) return EMPTY;
  const diff = Math.round((now - ms) / 1000);
  if (diff < 5) return 'baru saja';
  if (diff < 60) return `${diff} detik lalu`;
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  return `${Math.floor(diff / 86400)} hari lalu`;
}
