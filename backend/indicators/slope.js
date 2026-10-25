// Kemiringan regresi linear yang dinormalisasi terhadap nilai rata-rata,
// dinyatakan sebagai fraksi per candle (0.001 = +0,1% per candle).

/**
 * @param {(number|null)[]} values
 * @param {number} lookback jumlah titik (≥ 2)
 * @returns {(number|null)[]}
 */
export function normalizedSlope(values, lookback) {
  if (!Number.isInteger(lookback) || lookback < 2) throw new RangeError('lookback harus ≥ 2');
  const out = new Array(values.length).fill(null);
  const n = lookback;
  const xMean = (n - 1) / 2;
  let sxx = 0;
  for (let x = 0; x < n; x += 1) sxx += (x - xMean) ** 2;
  for (let i = n - 1; i < values.length; i += 1) {
    const win = values.slice(i - n + 1, i + 1);
    if (win.some((v) => v === null || !Number.isFinite(v))) continue;
    const yMean = win.reduce((a, b) => a + b, 0) / n;
    if (yMean === 0) continue;
    let sxy = 0;
    for (let x = 0; x < n; x += 1) sxy += (x - xMean) * (win[x] - yMean);
    out[i] = sxy / sxx / Math.abs(yMean);
  }
  return out;
}

/** Perubahan relatif dari `lookback` candle lalu: (v[i] - v[i-k]) / v[i-k]. */
export function percentChange(values, lookback) {
  return values.map((v, i) => {
    if (i < lookback) return null;
    const base = values[i - lookback];
    return base ? (v - base) / base : null;
  });
}
