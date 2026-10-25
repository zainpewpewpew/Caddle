# 07 — Kontrak Antarmodul (Milestone 2–3)

Dokumen ini mengikat modul yang dikembangkan paralel dan sudah **disesuaikan dengan implementasi** (bukan lagi draf). Konstanta & typedef ada di `backend/market/contracts.js`. Semua waktu epoch ms UTC. Semua angka harga/volume `number` (float64). Bagian terakhir mencatat penyimpangan dari draf awal beserta alasannya.

## Aturan umum

- Modul domain (`indicators`, `patterns`, `timeframe`, `signals`, `scoring`, `analysis/analyzeAt`) adalah **fungsi murni**: tanpa I/O, tanpa `Date.now()`, tanpa state global. Waktu diberikan sebagai argumen.
- Modul ber-I/O (`ingestion`, `worker`, repositori, `createAnalysisPipeline`) menerima dependensi lewat injeksi (`fetch`, `WebSocketImpl`, `clock`, `sleep`, `setTimer`, `logger`, `db`) agar dapat diuji tanpa jaringan.
- Hanya **candle tertutup** (`isClosed: true`) yang masuk tabel kanonik dan dipakai sinyal terkonfirmasi. Candle berjalan disimpan terpisah di `provisional_candles`.
- Tidak ada lookahead: pada waktu evaluasi `t`, hanya data dengan `closeTime <= t` yang boleh dipakai — termasuk candle timeframe lebih tinggi dan swing (`confirmedIndex`).
- Host jaringan yang diizinkan: `fapi.binance.com` (REST) dan `fstream.binance.com` (WebSocket), ditegakkan oleh allowlist di klien. Tidak ada URL dari input pengguna.
- Fixture Binance di `tests/fixtures/binance/` adalah **sintetis** mengikuti format dokumentasi resmi, bukan rekaman pasar nyata.

## Konstanta (`backend/market/contracts.js`)

| Konstanta | Nilai |
|---|---|
| `TIMEFRAMES` | `5m`, `15m`, `1h` |
| `HIGHER_TIMEFRAMES` | `5m → [15m, 1h]`, `15m → [1h]`, `1h → []` |
| `SIGNAL_STATES` | `NO_PATTERN`, `QUIET`, `EARLY_BULLISH`, `MOMENTUM_BUILDING`, `BREAKOUT`, `INVALIDATED`, `EXPIRED` |
| `TERMINAL_STATES` | `INVALIDATED`, `EXPIRED` |
| `ALIGNMENTS` | `ALIGNED`, `PARTIALLY_CONFIRMED`, `UNCONFIRMED`, `COUNTERTREND` |
| `RISK_FLAGS` | `POOR_LIQUIDITY`, `WIDE_SPREAD`, `EXCESSIVE_VOLATILITY`, `COUNTERTREND_HTF`, `EXTENDED_PRICE`, `DATA_QUALITY` |

## 1. Candle

```
{ symbol, timeframe: '5m'|'15m'|'1h', openTime, closeTime (= openTime + intervalMs - 1),
  open, high, low, close, volume, quoteVolume, trades, takerBuyVolume, takerBuyQuoteVolume,
  isClosed: boolean, source: 'rest'|'ws' }
```

Identitas kanonik: `symbol + timeframe + openTime` (PK tabel `candles`).

## 2. Binance REST — `backend/ingestion/binance/restClient.js`

```
createBinanceRestClient({ fetch = globalThis.fetch, baseUrl = 'https://fapi.binance.com',
  clock = Date.now, sleep, logger, maxWeightPerMinute = 1800, timeoutMs = 10_000, maxRetries = 3 (0..10),
  allowedHosts = ['fapi.binance.com'] /* hanya untuk tes */, random = Math.random /* jitter */ })
→ {
  getServerTime(): Promise<number>,
  getExchangeInfo(): Promise<SymbolInfo[]>,
  getKlines({ symbol, timeframe, startTime?, endTime?, limit? = 500 (maks 1500) }): Promise<Candle[]>,
      // isClosed = closeTime < clock(); source 'rest'
  get24hTickers(): Promise<Ticker24h[]>,
  getBookTickers(): Promise<BookTicker[]>,   // spreadBps dihitung
  usedWeight(): number,                      // estimasi lokal ∨ header X-MBX-USED-WEIGHT-1M
}
SymbolInfo  = { symbol, baseAsset, quoteAsset, contractType, status, tickSize, stepSize, onboardDate }
Ticker24h   = { symbol, lastPrice, priceChangePercent, volume, quoteVolume, closeTime }
BookTicker  = { symbol, bidPrice, askPrice, spreadBps }
```

Error: `BinanceApiError { status, code, retryable, retryAfterMs }`. 429/418 → hormati `Retry-After`; 5xx/timeout → backoff eksponensial "equal jitter"; 4xx lain (termasuk **451**, lokasi dibatasi) tidak diulang. `baseUrl` di luar allowlist ditolak saat konstruksi (`resolveBaseUrl`).

`backend/ingestion/symbolDiscovery.js`:

```
discoverSymbols({ symbols: SymbolInfo[], tickers: Ticker24h[], bookTickers: BookTicker[], settings })
→ { selected: [{ symbol, quoteVolume24h, spreadBps }], rejected: [{ symbol, reason }] }
REJECT_REASONS: NOT_PERPETUAL, NOT_USDT, NOT_TRADING, INVALID_SYMBOL, NO_TICKER, LOW_VOLUME,
                WIDE_SPREAD, NOT_IN_MANUAL_LIST, MAX_AUTO_LIMIT
```

Mode auto → filter `PERPETUAL`+`USDT`+`TRADING`, `minQuoteVolume24h`, `maxSpreadBps`, urut quote volume, ambil `maxAuto`. Mode manual → hanya simbol `manual` yang valid & TRADING. Simbol valid: basis 1–20 karakter `[A-Z0-9]` + `USDT`.

## 3. Validasi & penyimpanan — `backend/ingestion/candleValidator.js`, `backend/database/`

```
isValidSymbol(symbol) → boolean
validateCandle(candle, { now }) → { ok: boolean, errors: string[] }
normalizeBatch(candles) → Candle[]          // urut openTime, buang duplikat (versi terakhir menang)
floorToInterval(time, timeframe) → number
assessFreshness({ lastOpenTime, timeframe, now, graceMs = 0 }) → { fresh, lagMs, missing }

createCandleRepository(db, { clock = Date.now }) → {
  upsertClosed(candles, { now }?): Promise<{ inserted, updated, rejected: [{ candle, errors }] }>,
      // candle tidak valid / belum tertutup / simbol belum terdaftar → rejected, batch tidak gagal
  getRange({ symbol, timeframe, from, to }): Promise<Candle[]>,          // inklusif, urut naik
  getLatest({ symbol, timeframe, limit }): Promise<Candle[]>,            // urut naik
  getLastOpenTime({ symbol, timeframe }): Promise<number|null>,
  findGaps({ symbol, timeframe, from, to }): Promise<Array<{ from, to }>>,
  upsertProvisional(candle, { now }?): Promise<void>,   // diabaikan bila sudah ada versi lebih baru/tertutup
  getProvisional({ symbol, timeframe }): Promise<Candle|null>,
}
createSymbolRepository(db) → { upsertFromExchange(SymbolInfo[], now), setMonitored(symbols[], now),
  listMonitored(): Promise<string[]>, markDelisted(symbols[], now), getId(symbol) }
createIngestionStateRepository(db, { errorRetention }) → {
  recordRun({ startedAt, finishedAt, symbols, candles, errors }),
  recordError({ at, source, message }),           // pesan dipotong ≤ 500 karakter
  heartbeat({ at, state }),                       // state = snapshot scanner.status() lengkap
  getStatus(): { lastRun, recentErrors, heartbeat: { at, state } | null },
}
```

Semua repositori dirakit oleh `createRepositories(db, { clock })` di `backend/database/repositories/index.js`: `users`, `sessions`, `settings`, `audit`, `overview`, `candles`, `symbols`, `ingestion`, `signals`.

## 4. Streaming, backfill, worker — `backend/ingestion/binance/wsClient.js`, `backend/ingestion/backfill.js`, `worker/`

```
createKlineStream({ WebSocketImpl = globalThis.WebSocket, baseUrl = 'wss://fstream.binance.com',
  streams: [{ symbol, timeframe }], onCandle(candle), onState(state), clock, setTimer, clearTimer, random,
  backoff = { initialMs: 1000, maxMs: 60_000 }, staleMs, connectTimeoutMs, stableMs,
  maxConnectionAgeMs, maxMessageBytes, maxStreamsPerConnection = 200 })
  → { start(), stop(), state() }
  // k.x === true → isClosed true; lainnya provisional. Koneksi dipecah per ≤ 200 stream,
  // diputar sebelum batas 24 jam Binance, dianggap stale bila tidak ada pesan selama staleMs.

lastClosedOpenTime(now, timeframe) → number
planBackfill({ lastOpenTime, now, timeframe, maxCandles, chunkSize = 1500 }) → Array<{ startTime, endTime, limit }>
planGapFill({ gaps, timeframe, now, mergeWithin = 0, chunkSize = 1500 }) → Array<{ startTime, endTime, limit }>

createScanner({ rest, streamFactory, repos, getSettings, onClosedCandles, discoverSymbols,
  clock, logger, setTimer, clearTimer, options /* SCANNER_DEFAULTS */ })
  → { start(), stop(), status(), liquidityOf(symbol) }
status() = { state, lastIngestionAt, candleLagMs, reconnects, errors, scanDurationMs, queue,
             symbols, streams, staleStreams, ws, gaps, duplicates }
onClosedCandles({ symbol, timeframe, candles, reason })   // reason: 'stream' | 'sweep' | 'gap' | …
liquidityOf(symbol) → { quoteVolume24h, spreadBps } | null   // dari discovery terakhir
```

Entry point `worker/index.js` (`npm run worker`) merakit klien REST, stream, scanner, dan pipeline analisis; heartbeat ditulis tiap 30 detik; `SIGINT`/`SIGTERM` → graceful shutdown.

## 5. Indikator — `backend/indicators/`

`ema(values, period)`, `sma`, `atr(candles, period)`, `atrPercent`, `trueRange`, `rvol(volumes, period)` (baseline candle sebelumnya), `spikeDominance(volumes, window)`, `findSwings(candles, {left, right})` → `{ highs, lows }` dengan `confirmedIndex`, `confirmedAt(swings, evalIndex)`, `trailingHigherLows(lows)`, `normalizedSlope(values, lookback)`, `percentChange(values, lookback)`.

## 6. Pola — `backend/patterns/`

```
PATTERN_VERSION = 1
DEFAULT_SA_PARAMS, DEFAULT_PVA_PARAMS, PARAM_SPECS        // konfigurabel; validateParams/resolveParams
requiredCandles(pattern, params) → number                  // warm-up
detectSilentAccumulation(candles, params?) → PatternResult
detectProgressiveVolume(candles, params?)  → PatternResult
evaluatePatterns(candles, { sa?, pva? }) → { classification: 'SA'|'PVA'|'BOTH'|'NONE', sa, pva }
SA_CONDITIONS, PVA_CONDITIONS, GATE_CONDITIONS             // daftar kondisi untuk dokumentasi/UI

PatternResult = {
  pattern: 'SA'|'PVA', version: 1, detected: boolean,
  patternScore: 0..100, earlyScore: 0..100,
  conditions: [{ id, label, passed, value, threshold, weight }],
  invalidationPrice: number|null, evaluatedAt: closeTime candle terakhir,
  riskFlags: string[] (subset RISK_FLAGS), insufficientData: boolean,
}
```

`candles`: tertutup, satu simbol & timeframe, urut naik. Data kurang dari warm-up → `detected: false, insufficientData: true`. `detected` = semua kondisi gerbang (`GATE_CONDITIONS`) lulus **dan** `patternScore ≥ minScore`. Parameter tak dikenal ditolak `PatternParamsError`.

## 7. Timeframe, sinyal, skor — `backend/timeframe/`, `backend/signals/`, `backend/scoring/`

```
classifyTrend(candles, params?) → { trend: 'BULLISH'|'NEUTRAL'|'BEARISH'|null, reasons: string[], score? }
closedAsOf(candles, t) → Candle[]                         // closeTime <= t
lastClosedCloseTime(t, timeframe) → number
resolveAlignment({ baseTrendOk: boolean, higherTrends: Array<'BULLISH'|'NEUTRAL'|'BEARISH'|null> })
  → 'ALIGNED'|'PARTIALLY_CONFIRMED'|'UNCONFIRMED'|'COUNTERTREND'
buildTimeframeContext({ baseTimeframe, evaluationTime, candlesByTimeframe, params: { maxStaleBars = 1, trend } })
  → { alignment, trends: { [tf]: { trend, reasons, score?, asOf, candleCount } } }
  // HTF yang candle tertutup terakhirnya lebih tua dari maxStaleBars → trend null (tidak dipakai).
  // Hanya trend dasar BEARISH yang membuat baseTrendOk false; HTF tidak pernah membuang pola dasar.

transition(prev: SignalSnapshot|null, input, params?) → { next: SignalSnapshot, event: SignalEvent|null, alert: boolean }
  input = { candle, patterns, context: { alignment }, market: { atr, rvol, resistance }, view }
deriveMarketInputs(candles, params?) → { atr, rvol, resistance }   // resistance = swing high terkonfirmasi
isTerminal(state) → boolean
DEFAULT_SIGNAL_PARAMS = { earlyMinScore: 60, momentumAtrMultiple: 1, momentumRvol: 1.5, breakoutRvol: 2,
  expiryBars: { QUIET: 48, EARLY_BULLISH: 36, MOMENTUM_BUILDING: 24, BREAKOUT: 12 } }

SignalSnapshot = { state, classification, patternKey, patternVersion, firstDetectedAt, firstDetectedPrice,
  invalidationPrice, patternScore, earlyScore, alignment, riskFlags, lastCandleTime, barsInState,
  peakPrice, peakState }
SignalEvent = { fromState, toState, candleTime, price, reason }

buildSignalView({ symbol, timeframe, patterns, context, liquidity, dataQuality, params })
  → { symbol, timeframe, classification, alignment, patternScore, earlyScore, riskFlags,
      explanation: [{ factor, contribution, detail }] }

createSignalRepository(db, { clock }) → {
  ensurePatternDefinition({ key, version, name, definition, status = 'active', now }),
  getOpen({ symbol, timeframe }): Promise<SignalSnapshot|null>,
  save({ symbol, timeframe, snapshot, event, explanation, now }),   // satu transaksi: sinyal + event
  lastEventCandleTime({ symbol, timeframe }): Promise<number|null>,
  listActive({ timeframe?, classification?, state?, minScore?, limit = 200 (maks 500) }),
  history({ symbol?, limit = 50 }),                                   // termasuk events[]
}
```

Tabel transisi lengkap (kondisi, reason, kapan alert) didokumentasikan di kepala `backend/signals/stateMachine.js` dan diuji di `tests/unit/signals/`. Ringkasnya: transisi maju hanya ke peringkat lebih tinggi (tanpa downgrade, sehingga alert untuk state yang sama tidak berulang), satu transisi per candle baru, candle duplikat/lama idempoten, `INVALIDATED` bila close < harga invalidasi, `EXPIRED` bila tidak ada kemajuan selama `expiryBars[state]` bar.

Skor **bukan probabilitas**. `patternScore` = jumlah bobot kondisi yang lulus; `earlyScore` = seberapa dini posisi harga (jarak dari awal struktur dalam ATR dan umur struktur). HTF, likuiditas, dan kualitas data hanya menambah risk flag dan baris penjelasan — tidak mengubah skor.

## 8. Pipeline analisis — `backend/analysis/pipeline.js`

```
ANALYSIS_LOOKBACK = 300
assessSeriesQuality(candles, timeframe) → { ok, issues: ['UNCLOSED_CANDLE'|'MIXED_SERIES'|'GAP:n', …] }
analyzeAt({ symbol, timeframe, candlesByTimeframe, prev, liquidity, dataQuality, params })   // MURNI
  → { evaluationTime, patterns, context, view, market, next, event, alert }
patternDefinitions(params) → [{ key: 'SA'|'PVA', version, name, definition: { params, conditions, requiredCandles } }]
createAnalysisPipeline({ repos, signals, getLiquidity, logger, params, lookback = 300,
  maxReplay = 288, settleMs = 0, sleep, onAlert })
  → { ensureDefinitions(), onClosedCandles({ symbol, timeframe, candles, reason }) }
```

`analyzeAt` dipakai bersama oleh worker live dan (nanti) backtest M6, sehingga hasil keduanya identik untuk data yang sama. `onClosedCandles`:

1. Evaluasi diserialisasi per simbol×timeframe.
2. Memuat `lookback + maxReplay` candle terakhir; titik awal = `lastEventCandleTime` (persisten, sehingga restart tidak memutar ulang).
3. Candle baru diputar ulang berurutan (maks `maxReplay`; pemotongan dicatat di log). Tanpa riwayat → hanya candle terakhir.
4. Bila `settleMs > 0`, menunggu sekali agar candle HTF yang tutup pada waktu yang sama sempat tersimpan (worker memakai 3 detik).
5. Setiap candle: `getOpen` → `analyzeAt` → `save` bila ada event/perubahan. **Alert hanya untuk candle terakhir** batch, sehingga backfill tidak membanjiri alert historis.

## 9. API — `backend/api/signalRoutes.js`, `backend/api/systemRoutes.js`

Semua route di bawah `/api/` melewati gerbang autentikasi berbasis route (lihat `docs/01-arsitektur.md`). Coercion tipe dimatikan, sehingga query divalidasi sebagai string berpola.

| Endpoint | Query | Respons |
|---|---|---|
| `GET /api/signals/active` | `timeframe`, `classification` (SA/PVA/BOTH), `state` (state aktif), `minScore` (0–100), `limit` (1–500) | `{ signals: [...] }` + `lastPrice`, `lastCandleAt` per baris |
| `GET /api/signals/history` | `symbol` (`^[A-Z0-9]{2,30}$`), `limit` | `{ signals: [...] }` dengan `events[]` |
| `GET /api/system/status` | — | status proses API + `scanner`, `binance`, `ingestion` dari `summarizeWorker` |
| `GET /api/overview` | — | ringkasan + `alignedSignals`, `scanner`, `binance`, `marketContext` (BTC/ETH 1h) |

`backend/system/workerStatus.js` — `summarizeWorker(ingestion, now)` membaca heartbeat di database. Heartbeat lebih tua dari 90 detik → `stale`; tanpa heartbeat → `not_running` (tidak pernah angka palsu). `backend/system/marketContext.js` — `buildMarketContext(candles, symbols)` → `classifyTrend` pada 120 candle 1h; tanpa data → `{ status: 'no_data' }`.

## 10. Penyimpangan dari draf awal

| Draf | Implementasi | Alasan |
|---|---|---|
| `heartbeat({ at, state })` dengan metrik terpisah | `state` = snapshot `status()` lengkap | Metrik sempat hilang karena kontrak tidak cocok; satu objek menghindari drift |
| Scanner tanpa info likuiditas | `liquidityOf(symbol)` | Risk flag `POOR_LIQUIDITY`/`WIDE_SPREAD` butuh data discovery |
| `createSignalRepository(db)` | `+ { clock }`, `lastEventCandleTime` | Tes deterministik; titik awal replay yang persisten |
| Kolom tracking (`barsInState`, `peakPrice`, `lastCandleTime`) di tabel `signals` | Disimpan di `explanation_json.tracking` | Menghindari migrasi skema saat M3; kandidat migrasi `004` (lihat `docs/05-database.md`) |
| `classifyTrend` selalu mengembalikan trend | `trend: null` bila data kurang/HTF basi | Tidak memalsukan konteks saat data tidak cukup |
| Batas simbol 2–30 karakter di semua tempat | Discovery: basis 1–20 + `USDT`; API riwayat: 2–30 | Discovery mengikuti format USDT-M; API menerima simbol lama yang masih tersimpan |
