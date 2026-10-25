// Validasi pengaturan scanner di sisi klien (umpan balik cepat). Server tetap memvalidasi ulang.

const SYMBOL_PATTERN = /^[A-Z0-9]{1,20}USDT$/;

/**
 * Mengubah nilai input angka dari form menjadi number.
 * Kosong/spasi/null → NaN (bukan 0 seperti Number('')) agar field yang dikosongkan ditolak validasi.
 */
export function parseNumberInput(raw) {
  if (raw === null || raw === undefined) return Number.NaN;
  const text = String(raw).trim();
  return text === '' ? Number.NaN : Number(text);
}

// NaN berarti field kosong atau tidak dapat dibaca sebagai angka.
const numberError = (value, rule) => (Number.isNaN(value) ? `Wajib diisi (${rule.toLowerCase()})` : rule);

/** Mengembalikan objek { namaField: pesan }; kosong bila valid. */
export function validateSettings(s) {
  const errors = {};
  if (!s.timeframes.length) errors.timeframes = 'Pilih minimal satu timeframe';
  if (!Number.isInteger(s.symbols.maxAuto) || s.symbols.maxAuto < 10 || s.symbols.maxAuto > 100) errors.maxAuto = numberError(s.symbols.maxAuto, 'Bilangan bulat 10–100');
  const bad = s.symbols.manual.filter((sym) => !SYMBOL_PATTERN.test(sym));
  if (bad.length) errors.manual = `Format tidak valid: ${bad.slice(0, 3).join(', ')}`;
  else if (s.symbols.manual.length > 100) errors.manual = 'Maksimal 100 simbol';
  else if (s.symbols.mode === 'manual' && !s.symbols.manual.length) errors.manual = 'Mode manual membutuhkan minimal satu simbol';
  if (!Number.isFinite(s.liquidity.minQuoteVolume24h) || s.liquidity.minQuoteVolume24h < 0 || s.liquidity.minQuoteVolume24h > 1e12) errors.minQuoteVolume24h = numberError(s.liquidity.minQuoteVolume24h, 'Angka 0–1.000.000.000.000');
  if (!Number.isFinite(s.liquidity.maxSpreadBps) || s.liquidity.maxSpreadBps < 0 || s.liquidity.maxSpreadBps > 1000) errors.maxSpreadBps = numberError(s.liquidity.maxSpreadBps, 'Angka 0–1000');
  if (!Number.isInteger(s.refresh.bootstrapCandles) || s.refresh.bootstrapCandles < 100 || s.refresh.bootstrapCandles > 1500) errors.bootstrapCandles = numberError(s.refresh.bootstrapCandles, 'Bilangan bulat 100–1500');
  if (!Number.isInteger(s.refresh.restBackfillIntervalSec) || s.refresh.restBackfillIntervalSec < 30 || s.refresh.restBackfillIntervalSec > 3600) errors.restBackfillIntervalSec = numberError(s.refresh.restBackfillIntervalSec, 'Bilangan bulat 30–3600');
  return errors;
}
