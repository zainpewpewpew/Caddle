// Metrik evaluasi trade hasil backtest. Fungsi murni; trade 'OPEN' (belum selesai) selalu dikecualikan.

const Z95 = 1.96;

const isClosed = (t) => t && t.outcome !== 'OPEN' && Number.isFinite(t.rMultiple);

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Interval skor Wilson untuk proporsi binomial k/n.
 * n = 0 → [0, 1] (tidak ada informasi).
 * @returns {[number, number]}
 */
export function wilsonInterval(k, n, z = Z95) {
  if (!Number.isFinite(n) || n <= 0) return [0, 1];
  if (!Number.isFinite(k) || k < 0 || k > n) throw new RangeError('k harus di antara 0 dan n');
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Proporsi WIN di antara trade selesai (null bila tidak ada). */
export function baseRate(trades) {
  const closed = (trades ?? []).filter(isClosed);
  if (closed.length === 0) return null;
  return closed.filter((t) => t.outcome === 'WIN').length / closed.length;
}

/** Drawdown maksimum (≥ 0, dalam R) kurva ekuitas kumulatif yang dimulai dari 0. */
function maxDrawdown(rs) {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return dd;
}

/**
 * Ringkasan statistik trade selesai (OPEN diabaikan).
 * - winRate = WIN / n (TIMEOUT dihitung sebagai bukan-menang); hitRate = proporsi rMultiple > 0.
 * - expectancyCi = rata-rata ± 1,96·sd/√n (sd sampel, n−1); null bila n < 2.
 * - profitFactor = Σ R positif / |Σ R negatif|; null bila tidak ada R negatif.
 * - maxDrawdownR: kurva ekuitas R kumulatif diurutkan menurut waktu exit (exitTime, lalu exitIndex).
 */
export function summarize(trades) {
  const closed = (trades ?? []).filter(isClosed);
  const n = closed.length;
  const wins = closed.filter((t) => t.outcome === 'WIN').length;
  const losses = closed.filter((t) => t.outcome === 'LOSS').length;
  const timeouts = closed.filter((t) => t.outcome === 'TIMEOUT').length;
  if (n === 0) {
    return {
      n: 0, wins: 0, losses: 0, timeouts: 0, winRate: null, winRateCi: [0, 1], hitRate: null,
      expectancyR: null, expectancyCi: null, profitFactor: null, avgMfeR: null, avgMaeR: null,
      medianBarsHeld: null, maxDrawdownR: null,
    };
  }

  const rs = closed.map((t) => t.rMultiple);
  const expectancyR = mean(rs);
  let expectancyCi = null;
  if (n >= 2) {
    const variance = rs.reduce((a, r) => a + (r - expectancyR) ** 2, 0) / (n - 1);
    const half = (Z95 * Math.sqrt(variance)) / Math.sqrt(n);
    expectancyCi = [expectancyR - half, expectancyR + half];
  }
  const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);

  const exitKey = (t) => (Number.isFinite(t.exitTime) ? t.exitTime : Number.isFinite(t.exitIndex) ? t.exitIndex : 0);
  const ordered = closed.map((t, i) => ({ t, i })).sort((a, b) => exitKey(a.t) - exitKey(b.t) || a.i - b.i);

  const finite = (key) => closed.map((t) => t[key]).filter(Number.isFinite);
  return {
    n,
    wins,
    losses,
    timeouts,
    winRate: wins / n,
    winRateCi: wilsonInterval(wins, n),
    hitRate: rs.filter((r) => r > 0).length / n,
    expectancyR,
    expectancyCi,
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null,
    avgMfeR: mean(finite('mfeR')),
    avgMaeR: mean(finite('maeR')),
    medianBarsHeld: median(finite('barsHeld')),
    maxDrawdownR: maxDrawdown(ordered.map(({ t }) => t.rMultiple)),
  };
}

/**
 * Brier score = rata-rata (p − y)² untuk pasangan { p, y } (y 0|1). null bila tidak ada pasangan valid.
 */
export function brierScore(pairs) {
  const valid = (pairs ?? []).filter((x) => x && Number.isFinite(x.p) && (x.y === 0 || x.y === 1));
  if (valid.length === 0) return null;
  return valid.reduce((a, { p, y }) => a + (p - y) ** 2, 0) / valid.length;
}

/** Kelompokkan trade menurut keyFn lalu ringkas per kelompok. @returns {Map<any, ReturnType<typeof summarize>>} */
export function groupBy(trades, keyFn) {
  const groups = new Map();
  for (const t of trades ?? []) {
    const key = keyFn(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const out = new Map();
  for (const [key, list] of groups) out.set(key, summarize(list));
  return out;
}
