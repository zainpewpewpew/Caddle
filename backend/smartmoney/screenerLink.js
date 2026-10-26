// Tautan radar smart money → LONG Scanner (kontrak docs/15-kontrak-smart-money.md §2 `screenerLink.js`).
// Fungsi murni. `activeSignals` = baris `signalRepository.listActive({ direction: 'LONG' })` (bentuk toView):
//   { symbol, timeframe, direction, classification: 'SA'|'PVA'|'BOTH', state, confidenceTier?: 'A'|'B'|'C'|'D',
//     confluenceScore?, explanation: [{ factor, contribution, detail }] }.
//
// Aturan:
// - Hanya token ber-status MATCHED (kontrak cocok persis) yang ditautkan, berdasarkan `futuresSymbol` mapping.
//   SYMBOL_ONLY / AMBIGUOUS / NOT_LISTED tidak pernah ditautkan (simbol sama ≠ token sama).
// - Hanya sinyal LONG (baris tanpa `direction` = LONG, seperti repositori) pada timeframe 5m/15m/1h.
// - Label pola (Bahasa Indonesia):
//     SA / BOTH          → "kenaikan perlahan volume rendah (SA)"
//     PVA / BOTH         → "akumulasi volume progresif (PVA)"
//     state BREAKOUT     → "breakout akumulasi"
//     higher low         → faktor penjelasan `PATTERN:<SA|PVA>:higherLows` dengan kontribusi > 0 (kondisi lolos),
//                          atau konfirmasi konfluensi "Struktur pasar BULLISH …" (HH + HL, backend/scoring/confluence.js)
//     kompresi           → konfirmasi konfluensi "Rezim SQUEEZE …" (volatilitas terkompresi)
// - Relevansi: TINGGI = keyakinan ≥ 60 dan ada sinyal LONG tier A/B; SEDANG = salah satunya; RENDAH = hanya MATCHED;
//   TIDAK_TERHUBUNG = tidak MATCHED. Radar ber-state EXITING atau DISTRIBUTING (wallet berkualitas keluar/menjual)
//   tidak pernah TINGGI/SEDANG: relevansi dibatasi RENDAH dengan alasan yang menyebut state tersebut — keyakinan
//   atau sinyal LONG tidak menutupi bukti distribusi.
// - `note` selalu memuat DISCLAIMERS.spotVsFutures.
// Token tanpa entri di `matches` diperlakukan NOT_LISTED (mapping belum tersedia).

import { DISCLAIMERS } from './contracts.js';

export const SCREENER_TIMEFRAMES = Object.freeze(['5m', '15m', '1h']);
export const HIGH_CONVICTION = 60;
const STRONG_TIERS = Object.freeze(['A', 'B']);
/** State radar yang membatasi relevansi di RENDAH. */
const BEARISH_STATES = Object.freeze({
  EXITING: 'EXITING (wallet berkualitas keluar dari posisi)',
  DISTRIBUTING: 'DISTRIBUTING (penjualan wallet berkualitas mendominasi)',
});

export const PATTERN_LABELS = Object.freeze({
  SA: 'kenaikan perlahan volume rendah (SA)',
  PVA: 'akumulasi volume progresif (PVA)',
  BREAKOUT: 'breakout akumulasi',
  HIGHER_LOW: 'higher low (struktur naik)',
  COMPRESSION: 'kompresi volatilitas (squeeze)',
});

const NOT_LISTED = Object.freeze({
  status: 'NOT_LISTED', binanceAsset: null, spotSymbol: null, futuresSymbol: null, multiplier: 1, source: null,
  note: 'Mapping Binance untuk kontrak ini belum tersedia.',
});

/**
 * Label pola favorit dari satu baris sinyal LONG.
 * @param {{ classification?: string, state?: string, explanation?: Array<{ factor?: string, contribution?: number, detail?: string }> }} signal
 * @returns {string[]}
 */
export function signalPatterns(signal) {
  const out = [];
  const cls = signal?.classification;
  if (cls === 'SA' || cls === 'BOTH') out.push(PATTERN_LABELS.SA);
  if (cls === 'PVA' || cls === 'BOTH') out.push(PATTERN_LABELS.PVA);
  if (signal?.state === 'BREAKOUT') out.push(PATTERN_LABELS.BREAKOUT);
  const explanation = Array.isArray(signal?.explanation) ? signal.explanation : [];
  const confirms = explanation.filter((e) => e?.factor === 'CONFLUENCE:CONFIRM' && typeof e.detail === 'string').map((e) => e.detail);
  const higherLow = explanation.some((e) => /^PATTERN:(SA|PVA):higherLows$/.test(String(e?.factor ?? ''))
    && typeof e.contribution === 'number' && e.contribution > 0)
    || confirms.some((d) => d.startsWith('Struktur pasar BULLISH'));
  if (higherLow) out.push(PATTERN_LABELS.HIGHER_LOW);
  if (confirms.some((d) => d.startsWith('Rezim SQUEEZE'))) out.push(PATTERN_LABELS.COMPRESSION);
  return out;
}

const tfRank = (tf) => SCREENER_TIMEFRAMES.indexOf(tf);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Menautkan token radar ke sinyal LONG Scanner lewat mapping Binance.
 * @param {object[]} radarTokens RadarToken[]
 * @param {{ matches?: Map<string, object>, activeSignals?: object[] }} options
 * @returns {object[]} RadarToken & { binance, screener } dengan urutan masukan dipertahankan.
 */
export function linkToScreener(radarTokens, { matches = new Map(), activeSignals = [] } = {}) {
  if (!Array.isArray(radarTokens)) throw new TypeError('radarTokens harus array');
  if (!(matches instanceof Map)) throw new TypeError('matches harus Map');
  if (!Array.isArray(activeSignals)) throw new TypeError('activeSignals harus array');

  const bySymbol = new Map();
  for (const s of activeSignals) {
    if (!s || typeof s !== 'object') continue;
    if ((s.direction ?? 'LONG') !== 'LONG' || !SCREENER_TIMEFRAMES.includes(s.timeframe)) continue;
    if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, []);
    bySymbol.get(s.symbol).push(s);
  }

  return radarTokens.map((r) => {
    const binance = matches.get(r.tokenKey) ?? NOT_LISTED;
    const matched = binance.status === 'MATCHED';
    const signals = matched && binance.futuresSymbol
      ? (bySymbol.get(binance.futuresSymbol) ?? [])
        .map((s) => ({
          timeframe: s.timeframe, state: s.state, classification: s.classification,
          tier: s.confidenceTier ?? null, patterns: signalPatterns(s),
        }))
        .sort((x, y) => (tfRank(x.timeframe) - tfRank(y.timeframe)) || cmp(String(x.state), String(y.state)))
      : [];

    const highConviction = typeof r.conviction === 'number' && r.conviction >= HIGH_CONVICTION;
    const strong = signals.filter((s) => STRONG_TIERS.includes(s.tier));
    let relevance;
    let relevanceReason;
    if (!matched) {
      relevance = 'TIDAK_TERHUBUNG';
      relevanceReason = binance.status === 'SYMBOL_ONLY'
        ? 'Simbol sama dengan aset Binance tetapi kontrak berbeda — tidak ditautkan ke sinyal'
        : binance.status === 'AMBIGUOUS'
          ? 'Mapping Binance ambigu untuk kontrak ini — tidak ditautkan ke sinyal'
          : 'Token tidak terdaftar di Binance (berdasarkan kontrak)';
    } else if (Object.hasOwn(BEARISH_STATES, r.state)) {
      relevance = 'RENDAH';
      const despite = [
        highConviction ? `keyakinan ${r.conviction}` : null,
        strong.length ? `sinyal LONG tier ${strong.map((s) => `${s.tier} (${s.timeframe})`).join(', ')}` : null,
      ].filter(Boolean);
      relevanceReason = `Status radar ${BEARISH_STATES[r.state]} — relevansi dibatasi RENDAH`
        + (despite.length ? ` walau ada ${despite.join(' dan ')}` : '');
    } else if (highConviction && strong.length) {
      relevance = 'TINGGI';
      relevanceReason = `Keyakinan ${r.conviction} ≥ ${HIGH_CONVICTION} dan ada sinyal LONG tier ${strong.map((s) => `${s.tier} (${s.timeframe})`).join(', ')}`;
    } else if (highConviction || strong.length) {
      relevance = 'SEDANG';
      relevanceReason = highConviction
        ? `Keyakinan ${r.conviction} ≥ ${HIGH_CONVICTION}, tetapi belum ada sinyal LONG tier A/B${signals.length ? '' : ' (tidak ada sinyal LONG aktif)'}`
        : `Ada sinyal LONG tier ${strong.map((s) => `${s.tier} (${s.timeframe})`).join(', ')}, tetapi keyakinan ${r.conviction} < ${HIGH_CONVICTION}`;
    } else {
      relevance = 'RENDAH';
      relevanceReason = `Terdaftar di Binance (${binance.futuresSymbol ?? binance.spotSymbol ?? binance.binanceAsset}); keyakinan rendah dan tanpa sinyal LONG tier A/B`;
    }

    const note = [binance.note, DISCLAIMERS.spotVsFutures].filter(Boolean).join(' ');
    return { ...r, binance, screener: { signals, relevance, relevanceReason, note } };
  });
}
