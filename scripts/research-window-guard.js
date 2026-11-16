// Pengaman protokol akses AL-MOM-01 (docs/28 §8) untuk skrip riset lama yang menghitung hasil alert LONG 1h (gerak
// lanjutan, R) dari cache: --to tidak boleh melewati awal jendela uji 2026-11-16 00:00 UTC. Data sesudahnya hanya
// boleh dibuka oleh `--mode evaluate` AL-MOM-01 (scripts/research-al-mom-01.js) dan AL-SA-ATR-01 sesuai praregistrasinya.

export const AL_MOM_01_WINDOW_START = Date.UTC(2026, 10, 16);

/**
 * Snapshot cache riset historis (docs/29 §19): salinan baca-saja bulan cache < 2026-11 (dibuat `npm run research:snapshot`).
 * Skrip pengembangan membacanya secara bawaan; `data/backtest-cache` (cache hidup, yang akan memuat bulan jendela) hanya
 * untuk count/audit dan evaluate resmi.
 */
export const RESEARCH_SNAPSHOT_DIR = 'data/research-snapshot';
/** Bulan pertama (YYYY-MM) yang TIDAK boleh masuk snapshot: bulan yang memuat awal jendela. */
export const SNAPSHOT_FIRST_EXCLUDED_MONTH = new Date(AL_MOM_01_WINDOW_START).toISOString().slice(0, 7);

/** Lempar galat bila batas akhir data (ms, eksklusif) melewati awal jendela AL-MOM-01. */
export function assertBeforeMomWindow(toMs, name = '--to') {
  if (!(toMs <= AL_MOM_01_WINDOW_START)) {
    throw new RangeError(`${name} melewati 2026-11-16: hasil pada data jendela AL-MOM-01 tidak boleh dihitung sebelum evaluasi resminya (docs/28 §8)`);
  }
}
