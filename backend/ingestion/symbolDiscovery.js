// Discovery simbol USDT-M perpetual + pre-filter likuiditas. Fungsi murni: input data
// exchangeInfo/ticker yang sudah diparse (restClient) + pengaturan scanner → daftar terpilih
// dan daftar ditolak beserta alasannya. Setiap simbol input muncul tepat satu kali.

/** Alasan penolakan (string stabil, dipakai UI/log). */
export const REJECT_REASONS = Object.freeze({
  NOT_PERPETUAL: 'NOT_PERPETUAL',
  NOT_USDT: 'NOT_USDT',
  NOT_TRADING: 'NOT_TRADING',
  INVALID_SYMBOL: 'INVALID_SYMBOL',
  NO_TICKER: 'NO_TICKER',
  LOW_VOLUME: 'LOW_VOLUME',
  WIDE_SPREAD: 'WIDE_SPREAD',
  NOT_IN_MANUAL_LIST: 'NOT_IN_MANUAL_LIST',
  // Lolos semua filter tetapi berada di luar peringkat `maxAuto` (mode auto).
  MAX_AUTO_LIMIT: 'MAX_AUTO_LIMIT',
});

// Simbol USDT perpetual yang dapat dipindai: basis 1–20 huruf besar/angka + "USDT"
// (contoh valid: BTCUSDT, 1000PEPEUSDT, WUSDT). Nama non-ASCII/bertanda baca ditolak.
const USDT_PERP_SYMBOL_RE = /^[A-Z0-9]{1,20}USDT$/;

const isFiniteNonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function assertInputs({ symbols, tickers, bookTickers, settings }) {
  if (!Array.isArray(symbols)) throw new TypeError('symbols wajib array SymbolInfo');
  if (!Array.isArray(tickers)) throw new TypeError('tickers wajib array Ticker24h');
  if (!Array.isArray(bookTickers)) throw new TypeError('bookTickers wajib array BookTicker');
  const mode = settings?.symbols?.mode;
  if (mode !== 'auto' && mode !== 'manual') throw new TypeError('settings.symbols.mode harus auto atau manual');
  if (mode === 'manual') {
    const { manual } = settings.symbols;
    if (!Array.isArray(manual) || !manual.every((s) => typeof s === 'string')) throw new TypeError('settings.symbols.manual wajib array string');
    return;
  }
  const { maxAuto } = settings.symbols;
  if (!Number.isInteger(maxAuto) || maxAuto < 1) throw new TypeError('settings.symbols.maxAuto harus bilangan bulat ≥ 1');
  const { minQuoteVolume24h, maxSpreadBps } = settings.liquidity ?? {};
  if (!isFiniteNonNegative(minQuoteVolume24h)) throw new TypeError('settings.liquidity.minQuoteVolume24h harus angka ≥ 0');
  if (!isFiniteNonNegative(maxSpreadBps)) throw new TypeError('settings.liquidity.maxSpreadBps harus angka ≥ 0');
}

/** Peta symbol → entri pertama (entri duplikat berikutnya diabaikan). */
function firstBySymbol(items) {
  const map = new Map();
  for (const item of items) {
    if (item && typeof item.symbol === 'string' && !map.has(item.symbol)) map.set(item.symbol, item);
  }
  return map;
}

/** Filter kontrak (berlaku di kedua mode), urut prioritas alasan. */
function contractRejection(info) {
  if (info.contractType !== 'PERPETUAL') return REJECT_REASONS.NOT_PERPETUAL;
  if (info.quoteAsset !== 'USDT') return REJECT_REASONS.NOT_USDT;
  if (info.status !== 'TRADING') return REJECT_REASONS.NOT_TRADING;
  if (!USDT_PERP_SYMBOL_RE.test(info.symbol) || typeof info.tickSize !== 'string' || typeof info.stepSize !== 'string') {
    return REJECT_REASONS.INVALID_SYMBOL;
  }
  return null;
}

/**
 * Pilih simbol yang dipindai.
 * - Mode auto: PERPETUAL + USDT + TRADING + nama valid, lalu quote volume 24 jam ≥ minQuoteVolume24h
 *   dan spreadBps ≤ maxSpreadBps (ambang inklusif), urut quote volume menurun (seri → simbol naik),
 *   ambil `maxAuto` teratas; sisanya ditolak MAX_AUTO_LIMIT.
 * - Mode manual: hanya simbol di `manual`; filter kontrak tetap berlaku, filter likuiditas dan
 *   maxAuto tidak. quoteVolume24h/spreadBps bernilai null bila ticker tidak tersedia.
 *   Simbol manual yang tidak ada di exchangeInfo → INVALID_SYMBOL.
 * @param {{ symbols: import('./binance/parse.js').SymbolInfo[], tickers: import('./binance/parse.js').Ticker24h[],
 *           bookTickers: import('./binance/parse.js').BookTicker[], settings: object }} input
 * @returns {{ selected: Array<{ symbol: string, quoteVolume24h: number|null, spreadBps: number|null }>,
 *             rejected: Array<{ symbol: string, reason: string }> }}
 */
export function discoverSymbols(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('Input discovery wajib objek');
  assertInputs(input);
  const { symbols, tickers, bookTickers, settings } = input;
  const auto = settings.symbols.mode === 'auto';
  const manualSet = auto ? null : new Set(settings.symbols.manual);
  const tickerMap = firstBySymbol(tickers);
  const bookMap = firstBySymbol(bookTickers);

  const seen = new Set();
  const candidates = [];
  const rejected = [];
  const reject = (symbol, reason) => rejected.push({ symbol, reason });

  for (const info of symbols) {
    if (info === null || typeof info !== 'object' || typeof info.symbol !== 'string') {
      reject(String(info?.symbol ?? ''), REJECT_REASONS.INVALID_SYMBOL);
      continue;
    }
    const { symbol } = info;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    if (manualSet && !manualSet.has(symbol)) {
      reject(symbol, REJECT_REASONS.NOT_IN_MANUAL_LIST);
      continue;
    }
    const contractReason = contractRejection(info);
    if (contractReason) {
      reject(symbol, contractReason);
      continue;
    }

    const quoteVolume = tickerMap.get(symbol)?.quoteVolume;
    const spread = bookMap.get(symbol)?.spreadBps;
    const quoteVolume24h = isFiniteNonNegative(quoteVolume) ? quoteVolume : null;
    const spreadBps = isFiniteNonNegative(spread) ? spread : null;
    if (auto) {
      if (quoteVolume24h === null || spreadBps === null) {
        reject(symbol, REJECT_REASONS.NO_TICKER);
        continue;
      }
      if (quoteVolume24h < settings.liquidity.minQuoteVolume24h) {
        reject(symbol, REJECT_REASONS.LOW_VOLUME);
        continue;
      }
      if (spreadBps > settings.liquidity.maxSpreadBps) {
        reject(symbol, REJECT_REASONS.WIDE_SPREAD);
        continue;
      }
    }
    candidates.push({ symbol, quoteVolume24h, spreadBps });
  }

  if (manualSet) {
    for (const symbol of manualSet) {
      if (!seen.has(symbol)) reject(symbol, REJECT_REASONS.INVALID_SYMBOL);
    }
  }

  // Quote volume menurun; null (mode manual tanpa ticker) di akhir; seri → simbol naik.
  candidates.sort((a, b) => {
    if (a.quoteVolume24h !== b.quoteVolume24h) {
      if (a.quoteVolume24h === null) return 1;
      if (b.quoteVolume24h === null) return -1;
      return b.quoteVolume24h - a.quoteVolume24h;
    }
    return byCodePoint(a.symbol, b.symbol);
  });

  let selected = candidates;
  if (auto && candidates.length > settings.symbols.maxAuto) {
    selected = candidates.slice(0, settings.symbols.maxAuto);
    for (const c of candidates.slice(settings.symbols.maxAuto)) reject(c.symbol, REJECT_REASONS.MAX_AUTO_LIMIT);
  }
  rejected.sort((a, b) => byCodePoint(a.symbol, b.symbol));
  return { selected, rejected };
}
