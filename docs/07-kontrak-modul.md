# 07 — Kontrak Antarmodul (Milestone 2–3)

Dokumen ini mengikat modul yang dikembangkan paralel. Konstanta & typedef ada di `backend/market/contracts.js`. Semua waktu epoch ms UTC. Semua angka harga/volume `number` (float64).

## Aturan umum

- Modul domain (`indicators`, `patterns`, `timeframe`, `signals`, `scoring`) adalah **fungsi murni**: tanpa I/O, tanpa `Date.now()`, tanpa state global. Waktu diberikan sebagai argumen.
- Modul ber-I/O (`ingestion`, `worker`, repositori) menerima dependensi lewat injeksi (`fetch`, `WebSocketImpl`, `clock`, `sleep`, `logger`, `db`) agar dapat diuji tanpa jaringan.
- Hanya **candle tertutup** (`isClosed: true`) yang masuk tabel kanonik dan dipakai sinyal terkonfirmasi.
- Tidak ada lookahead: pada waktu evaluasi `t`, hanya data dengan `closeTime <= t` yang boleh dipakai — termasuk candle timeframe lebih tinggi dan swing (`confirmedIndex`).
- Host jaringan yang diizinkan: `fapi.binance.com` (REST) dan `fstream.binance.com` (WebSocket). Tidak ada URL dari input pengguna.
- Fixture Binance di `tests/fixtures/binance/` adalah **sintetis** mengikuti format dokumentasi resmi, bukan rekaman pasar nyata — beri label demikian.

## 1. Candle (`contracts.js`)

```
{ symbol, timeframe: '5m'|'15m'|'1h', openTime, closeTime (= openTime + intervalMs - 1),
  open, high, low, close, volume, quoteVolume, trades, takerBuyVolume, takerBuyQuoteVolume,
  isClosed: boolean, source: 'rest'|'ws' }
```

## 2. Binance REST — `backend/ingestion/binance/restClient.js`

```
createBinanceRestClient({ fetch = globalThis.fetch, baseUrl = 'https://fapi.binance.com',
  clock = Date.now, sleep, logger, maxWeightPerMinute = 1800, timeoutMs = 10_000, maxRetries = 3 })
→ {
  getServerTime(): Promise<number>,
  getExchangeInfo(): Promise<SymbolInfo[]>,
  getKlines({ symbol, timeframe, startTime?, endTime?, limit? = 500 }): Promise<Candle[]>,
      // isClosed = closeTime < serverNow (dari clock); source 'rest'
  get24hTickers(): Promise<Ticker24h[]>,
  getBookTickers(): Promise<BookTicker[]>,
  usedWeight(): number,
}
SymbolInfo  = { symbol, baseAsset, quoteAsset, contractType, status, tickSize, stepSize, onboardDate }
Ticker24h   = { symbol, lastPrice, priceChangePercent, volume, quoteVolume, closeTime }
BookTicker  = { symbol, bidPrice, askPrice, spreadBps }
```
Error: `BinanceApiError { status, code, retryable, retryAfterMs }`. 429/418 → hormati `Retry-After`; 5xx/timeout → backoff eksponensial + jitter; 4xx lain tidak diulang.

`backend/ingestion/symbolDiscovery.js`:
```
discoverSymbols({ symbols: SymbolInfo[], tickers: Ticker24h[], bookTickers: BookTicker[], settings })
→ { selected: [{ symbol, quoteVolume24h, spreadBps }], rejected: [{ symbol, reason }] }
```
`settings` = pengaturan scanner (`backend/settings/scannerSettings.js`): mode auto → filter `PERPETUAL`+`USDT`+`TRADING`, `minQuoteVolume24h`, `maxSpreadBps`, urut quote volume, ambil `maxAuto`. Mode manual → hanya simbol `manual` yang valid & TRADING.

## 3. Penyimpanan — `backend/database/` (migrasi `003_*`, repositori)

```
validateCandle(candle, { now }) → { ok: boolean, errors: string[] }        // backend/ingestion/candleValidator.js
normalizeBatch(candles) → Candle[]   // urut openTime, buang duplikat (versi terakhir menang)

createCandleRepository(db) → {
  upsertClosed(candles): Promise<{ inserted, updated, rejected: [{ candle, errors }] }>,
  getRange({ symbol, timeframe, from, to }): Promise<Candle[]>,          // inklusif, urut naik
  getLatest({ symbol, timeframe, limit }): Promise<Candle[]>,            // urut naik
  getLastOpenTime({ symbol, timeframe }): Promise<number|null>,
  findGaps({ symbol, timeframe, from, to }): Promise<Array<{ from, to }>>, // openTime yang hilang
  upsertProvisional(candle): Promise<void>,
  getProvisional({ symbol, timeframe }): Promise<Candle|null>,
}
createSymbolRepository(db) → { upsertFromExchange(SymbolInfo[], now), setMonitored(symbols[], now),
  listMonitored(): Promise<string[]>, markDelisted(symbols[], now), getId(symbol) }
createIngestionStateRepository(db) → { recordRun({ startedAt, finishedAt, symbols, candles, errors }),
  recordError({ at, source, message }), heartbeat({ at, state }), getStatus() }
```
Repositori baru didaftarkan di `backend/database/repositories/index.js` (`candles`, `symbols`, `ingestion`).

## 4. Streaming & worker — `backend/ingestion/binance/wsClient.js`, `backend/ingestion/backfill.js`, `worker/`

```
createKlineStream({ WebSocketImpl = globalThis.WebSocket, baseUrl = 'wss://fstream.binance.com',
  streams: [{ symbol, timeframe }], onCandle(candle), onState(state), clock, setTimer, clearTimer,
  backoff = { initialMs: 1000, maxMs: 60_000 } }) → { start(), stop(), state() }
  // candle dengan k.x === true → isClosed true; lainnya provisional
planBackfill({ lastOpenTime, now, timeframe, maxCandles }) → Array<{ startTime, endTime, limit }>
createScanner({ rest, streamFactory, repos, getSettings, onClosedCandles, clock, logger })
  → { start(), stop(), status() }   // status: { state, lastIngestionAt, candleLagMs, errors, scanDurationMs, queue }
```

## 5. Indikator — `backend/indicators/` (sudah tersedia)

`ema(values, period)`, `sma`, `atr(candles, period)`, `atrPercent`, `trueRange`, `rvol(volumes, period)` (baseline candle sebelumnya), `spikeDominance(volumes, window)`, `findSwings(candles, {left, right})` → `{ highs, lows }` dengan `confirmedIndex`, `confirmedAt(swings, evalIndex)`, `trailingHigherLows(lows)`, `normalizedSlope(values, lookback)`, `percentChange(values, lookback)`.

## 6. Pola — `backend/patterns/`

```
DEFAULT_SA_PARAMS, DEFAULT_PVA_PARAMS      // konfigurabel, divalidasi skema
detectSilentAccumulation(candles, params?) → PatternResult
detectProgressiveVolume(candles, params?)  → PatternResult
evaluatePatterns(candles, { sa?, pva? }) → { classification: 'SA'|'PVA'|'BOTH'|'NONE', sa, pva }

PatternResult = {
  pattern: 'SA'|'PVA', version: 1, detected: boolean,
  patternScore: 0..100, earlyScore: 0..100,
  conditions: [{ id, label, passed, value, threshold, weight }],
  invalidationPrice: number|null, evaluatedAt: closeTime candle terakhir,
  riskFlags: string[] (subset RISK_FLAGS), insufficientData: boolean,
}
```
`candles`: tertutup, satu simbol & timeframe, urut naik. Bila data kurang dari warm-up → `detected: false, insufficientData: true`.

## 7. Timeframe, sinyal, skor — `backend/timeframe/`, `backend/signals/`, `backend/scoring/`

```
classifyTrend(candles, params?) → { trend: 'BULLISH'|'NEUTRAL'|'BEARISH', reasons: string[] }
closedAsOf(candles, t) → Candle[]                         // closeTime <= t
resolveAlignment({ baseTrendOk: boolean, higherTrends: Array<'BULLISH'|'NEUTRAL'|'BEARISH'|null> })
  → 'ALIGNED'|'PARTIALLY_CONFIRMED'|'UNCONFIRMED'|'COUNTERTREND'
buildTimeframeContext({ baseTimeframe, evaluationTime, candlesByTimeframe }) → { alignment, trends }

transition(prev: SignalSnapshot|null, input, params?) → { next: SignalSnapshot, event: SignalEvent|null, alert: boolean }
SignalSnapshot = { state, classification, firstDetectedAt, firstDetectedPrice, invalidationPrice,
  patternScore, earlyScore, alignment, riskFlags, lastCandleTime, barsInState, peakPrice }
SignalEvent = { fromState, toState, candleTime, price, reason }

buildSignalView({ symbol, timeframe, patterns, context, liquidity, dataQuality }) → { patternScore, earlyScore,
  riskFlags, explanation: [{ factor, contribution, detail }] }

createSignalRepository(db) → { ensurePatternDefinition({ key, version, name, definition }), getOpen({ symbol, timeframe }),
  save({ symbol, timeframe, snapshot, event }), listActive(filters), history({ symbol?, limit }) }
```
