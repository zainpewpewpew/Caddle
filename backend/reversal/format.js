// Pemformatan angka untuk teks bukti/kondisi Reversal Radar (bahasa Indonesia: desimal koma, ribuan titik).
// Hanya dipakai oleh detektor & state machine untuk menyusun `detail`/`text`; UI punya pemformat sendiri.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Angka dengan `digits` desimal, pemisah Indonesia. Nilai non-hingga → '–'. */
export function fmtNum(v, digits = 1) {
  if (!isNum(v)) return '–';
  const fixed = Math.abs(v).toFixed(digits);
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const negative = v < 0 && Number(fixed) !== 0; // −0,0 ditampilkan tanpa tanda
  return `${negative ? '−' : ''}${grouped}${frac ? `,${frac}` : ''}`;
}

/** Harga: jumlah desimal menyesuaikan besaran, nol di belakang dibuang (minimal 2 desimal untuk harga ≥ 1). */
export function fmtPrice(v) {
  if (!isNum(v)) return '–';
  const a = Math.abs(v);
  const digits = a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  let fixed = a.toFixed(digits);
  if (fixed.includes('.')) {
    const minFrac = a >= 1 ? 2 : 4;
    const [int, frac] = fixed.split('.');
    const trimmed = frac.replace(/0+$/, '');
    fixed = `${int}.${trimmed.length < minFrac ? frac.slice(0, minFrac) : trimmed}`;
  }
  const [int, frac] = fixed.split('.');
  return `${v < 0 ? '−' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${frac ? `,${frac}` : ''}`;
}

/** Kelipatan ATR dengan satu desimal (mis. "0,4 ATR"). */
export function fmtAtr(v) {
  return `${fmtNum(v, 1)} ATR`;
}

/** Fraksi sebagai persen satu desimal (0.062 → "6,2 %"). */
export function fmtPct(v) {
  return isNum(v) ? `${fmtNum(v * 100, 1)} %` : '–';
}
