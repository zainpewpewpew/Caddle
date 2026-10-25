// Moving average. Output sepanjang input; null selama warm-up.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Simple moving average. */
export function sma(values, period) {
  assertPeriod(period);
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (!isNum(values[i])) throw new TypeError(`Nilai tidak valid pada indeks ${i}`);
    sum += values[i];
    valid += 1;
    if (valid > period) sum -= values[i - period];
    if (valid >= period) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, alpha = 2 / (period + 1), diseed dengan SMA `period` nilai pertama.
 * Indeks 0..period-2 bernilai null (warm-up).
 */
export function ema(values, period) {
  assertPeriod(period);
  const out = new Array(values.length).fill(null);
  if (values.length < period) {
    values.forEach((v, i) => { if (!isNum(v)) throw new TypeError(`Nilai tidak valid pada indeks ${i}`); });
    return out;
  }
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) {
    if (!isNum(values[i])) throw new TypeError(`Nilai tidak valid pada indeks ${i}`);
    seed += values[i];
  }
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    if (!isNum(values[i])) throw new TypeError(`Nilai tidak valid pada indeks ${i}`);
    prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

export function assertPeriod(period) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('Periode harus bilangan bulat ≥ 1');
}
