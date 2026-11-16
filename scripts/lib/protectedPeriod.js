// Periode terlindungi riset prospektif AlphaLens (docs/26 §3, docs/28 §8, docs/29 §19). Alert LONG 1h SA/PVA pada candle
// ≥ 2026-11-16 00:00 UTC adalah data uji AL-SA-ATR-01 dan AL-MOM-01, jadi statistik kinerjanya (R, win rate, expectancy)
// tidak boleh dibuka sebelum evaluasi resmi masing-masing. Penjaga ini mencegah pembukaan TAK SENGAJA lewat alat produk
// (`npm run backtest`); ia bukan pengaman terhadap orang yang sengaja melanggar protokol.

import { createInterface } from 'node:readline/promises';
import { AL_MOM_01_WINDOW_START } from '../research-window-guard.js';

export const PROTECTED_FROM = AL_MOM_01_WINDOW_START;
export const PROTECTED_TIMEFRAMES = Object.freeze(['1h']);
export const UNLOCK_OPTION = 'buka-periode-terlindungi';
export const UNLOCK_PHRASE = 'SAYA MEMBUKA DATA UJI AL-MOM-01';

const ISO_DAY = new Date(PROTECTED_FROM).toISOString().slice(0, 10);

/** Apakah permintaan menyentuh timeframe dasar yang dilindungi (data sintetis tidak dilindungi). */
export const touchesProtected = (source, timeframes) => source !== 'synthetic' && timeframes.some((tf) => PROTECTED_TIMEFRAMES.includes(tf));

/**
 * Terapkan periode terlindungi pada rentang backtest.
 * - Tanpa flag buka dan `--to` bawaan (sekarang): `to` dipotong ke awal periode (clipped).
 * - Tanpa flag buka dan `--to` eksplisit sesudah awal periode, atau `--from` di dalamnya: RangeError.
 * - `cutoff` = batas openTime eksklusif yang dipaksakan saat memuat data (dipakai juga untuk CSV tanpa --to); null bila
 *   tidak berlaku atau dibuka dengan flag.
 * @returns {{ applies: boolean, from: number, to: number, clipped: boolean, cutoff: number|null, unlocked: boolean }}
 */
export function applyProtectedPeriod({ source, timeframes, from, to, toExplicit, unlock }) {
  const base = { from: PROTECTED_FROM, to, clipped: false, cutoff: null, unlocked: false };
  if (!touchesProtected(source, timeframes)) return { ...base, applies: false };
  if (unlock) return { ...base, applies: true, unlocked: true };
  if (from >= PROTECTED_FROM) {
    throw new RangeError(`--from ${new Date(from).toISOString().slice(0, 10)} ada di periode terlindungi (≥ ${ISO_DAY}) untuk timeframe 1h: `
      + `hasil alert di periode itu adalah data uji AL-SA-ATR-01/AL-MOM-01 (docs/28 §8)`);
  }
  if (toExplicit && to > PROTECTED_FROM) {
    throw new RangeError(`--to melewati ${ISO_DAY} untuk timeframe 1h: hasil alert sesudah tanggal itu adalah data uji AL-SA-ATR-01/AL-MOM-01 `
      + `dan baru boleh dibuka oleh evaluasi resminya (docs/28 §8). Pakai --to ≤ ${ISO_DAY}, atau timeframe lain.`);
  }
  return { ...base, applies: true, to: Math.min(to, PROTECTED_FROM), clipped: to > PROTECTED_FROM, cutoff: PROTECTED_FROM };
}

/** Lempar galat bila data yang dimuat masih memuat candle timeframe terlindungi di periode terlindungi (pertahanan lapis kedua). */
export function assertNoProtectedCandles(candles, timeframes, cutoff = PROTECTED_FROM) {
  for (const [symbol, byTf] of Object.entries(candles)) {
    for (const tf of timeframes) {
      if (!PROTECTED_TIMEFRAMES.includes(tf)) continue;
      const list = byTf?.[tf] ?? [];
      if (list.some((c) => c.openTime >= cutoff)) throw new RangeError(`${symbol} ${tf}: data memuat candle periode terlindungi (≥ ${ISO_DAY}); backtest dihentikan`);
    }
  }
}

/**
 * Konfirmasi pembukaan periode terlindungi: hanya di terminal interaktif (stdin & stderr TTY) di luar CI, dengan
 * mengetik frasa persis. Skrip otomatis, CI, dan asisten AI yang menjalankan perintah tanpa TTY selalu ditolak.
 */
export async function confirmUnlock({ input = process.stdin, output = process.stderr, env = process.env } = {}) {
  if (!input?.isTTY || !output?.isTTY || env.CI) {
    output?.write?.(`--${UNLOCK_OPTION} butuh konfirmasi di terminal interaktif (bukan skrip, CI, atau asisten AI). Dibatalkan.\n`);
    return false;
  }
  output.write([
    '',
    `PERINGATAN: Anda akan membuka statistik kinerja alert 1h pada periode terlindungi (≥ ${ISO_DAY}).`,
    'Data ini adalah data uji AL-SA-ATR-01 dan AL-MOM-01 (docs/26, docs/28 §8). Membukanya sebelum evaluasi resmi',
    'adalah pelanggaran protokol yang wajib dicatat di docs/28 §10 (tanggal, siapa, apa yang dilihat).',
    '',
  ].join('\n'));
  const rl = createInterface({ input, output, terminal: false });
  try {
    const answer = await rl.question(`Ketik persis "${UNLOCK_PHRASE}" untuk melanjutkan: `);
    return answer.trim() === UNLOCK_PHRASE;
  } finally {
    rl.close();
  }
}
