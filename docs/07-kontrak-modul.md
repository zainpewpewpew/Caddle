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
  sampleServerTime({ clock? }): Promise<{ serverTime, sentAt, receivedAt }>,
      // SATU percobaan tanpa retry/backoff; sentAt/receivedAt (jam pemanggil) diambil setelah antrean limiter,
      // tepat di sekitar fetch → jeda Retry-After/backoff tidak masuk round-trip (sinkronisasi jam, §4)
  getExchangeInfo(): Promise<SymbolInfo[]>,
  getKlines({ symbol, timeframe, startTime?, endTime?, limit? = 500 (maks 1500) }): Promise<Candle[]>,
      // isClosed = closeTime < clock(); source 'rest'; worker memberi clock = serverClock.now (§4)
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
upsertFromExchange(...) → Promise<{ inserted, updated, rejectedCount, rejected: [{ symbol: string|null, errors }] }>
  // entri yang gagal validasi (mis. kontrak delivery XXXUSDT_YYMMDD) tidak disimpan; rejectedCount = total,
  // rejected = maks REJECTED_LIST_MAX (50) entri pertama, symbol dipotong ≤ 64 karakter. Scanner mencatatnya
  // sekali per discovery (debug bila semuanya kontrak delivery, selain itu info) — bukan error ingesti.
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

createServerClock({ getServerTime, clock = Date.now, logger, maxOffsetMs = 600_000, maxRoundTripMs = 1_000, maxAttempts = 3 })
  → { now(), offsetMs(), lastSync(), sync(): Promise<{ ok, offsetMs, measuredOffsetMs, roundTripMs, reason?, message? }> }
  // backend/ingestion/serverClock.js. offset = serverTime − titik tengah round-trip (galat ≤ RTT/2). sync() tidak pernah reject:
  // gagal (REQUEST_FAILED/BAD_RESPONSE) → offset terakhir (awal 0) tetap; RTT > maxRoundTripMs → sampel dibuang;
  // |offset| > maxOffsetMs → TIDAK diterapkan (OFFSET_OUT_OF_RANGE, kemungkinan jam host/NTP rusak) dan dilaporkan.
  // getServerTime({ clock }) dipanggil malas dengan jam lokal → sampel { serverTime, sentAt, receivedAt } (stempel di dalam
  // rentang panggilan, selain itu BAD_RESPONSE) atau angka (RTT = durasi panggilan). Worker: `(o) => rest.sampleServerTime(o)`,
  // sehingga klien REST boleh memakai serverClock.now. Percobaan gagal retryable / RTT terlalu panjang → sampel BARU
  // (maks maxAttempts per sync); error retryable:false (mis. HTTP 400) dan BAD_RESPONSE tidak diulang.

createScanner({ rest, streamFactory, repos, getSettings, onClosedCandles, onMonitoringStopped?, listOpenSeries?, discoverSymbols,
  clock, localClock? = clock, logger, setTimer, clearTimer, options /* SCANNER_DEFAULTS */, serverClock? })
  → { start(), stop(), status(), liquidityOf(symbol) }
  // clock = waktu server (worker: serverClock.now) untuk semua perbandingan dengan closeTime (rencana backfill/gap,
  // sweep, staleStreams, candleLagMs) serta stempel simbol & penutupan sinyal (`at`). localClock = jam host (worker:
  // Date.now) untuk stempel yang dibandingkan API/UI dengan jamnya sendiri: heartbeat `at`, recordRun
  // startedAt/finishedAt (scanDurationMs), recordError `at`, lastIngestionAt. Mencampur keduanya membuat
  // summarizeWorker salah menilai umur heartbeat sebesar offset jam.
  // serverClock: sync() di awal setiap siklus (start, rediscovery, percobaan ulang discovery) sebelum discovery;
  // hasil ok:false dicatat sebagai error ingesti sumber 'clock' (tidak menghentikan worker).
status() = { state, lastIngestionAt, candleLagMs, reconnects, errors, scanDurationMs, queue,
             symbols, streams, staleStreams, ws, gaps, duplicates, clockOffsetMs /* null tanpa serverClock */ }
onClosedCandles({ symbol, timeframe, candles, reason })   // reason: 'stream' | 'sweep' | 'gap' | …
onMonitoringStopped({ symbol, timeframes: string[] | null, reason: 'SYMBOL_DELISTED' | 'MONITORING_STOPPED', at })
  // setelah discovery berhasil & stream lama dilepas: simbol yang sebelumnya dipantau (termasuk daftar DB di siklus
  // pertama) dan tidak terpilih lagi → timeframes null (semua); timeframe yang dilepas dari pengaturan untuk simbol
  // yang tetap dipantau → MONITORING_STOPPED dengan timeframes itu. Error dicatat (sumber 'monitoring').
listOpenSeries?() → Promise<Array<{ symbol, timeframe }>>   // worker: repos.signals.listOpenSeries
  // Rekonsiliasi LEVEL-TRIGGERED setelah setiap discovery berhasil (sesudah pelaporan di atas): seri bersinyal
  // terbuka yang tidak dipantau → onMonitoringStopped — simbol tidak terpilih → timeframes null, reason
  // SYMBOL_DELISTED bila tidak TRADING / hilang dari exchangeInfo, selain itu MONITORING_STOPPED; simbol terpilih
  // dengan timeframe di luar pengaturan → MONITORING_STOPPED + timeframe itu. Seri yang sudah dilaporkan di siklus
  // yang sama dilewati. Menutup ulang penutupan yang gagal (callback error), stop() di tengah siklus (setMonitored
  // sudah commit), timeframe dilepas saat worker mati, dan sinyal yatim dari DB lama. Fallback daftar DB (discovery
  // gagal) tidak pernah merekonsiliasi. Error listOpenSeries dicatat (sumber 'monitoring').
liquidityOf(symbol) → { quoteVolume24h, spreadBps, thresholds: { minQuoteVolume24h, maxSpreadBps } | null } | null
    // dari discovery terakhir; thresholds = settings.liquidity yang dipakai discovery tersebut
```

Entry point `worker/index.js` (`npm run worker`) membuka SQLite + migrasi, lalu merakit dependensi lewat `worker/assemble.js`; heartbeat ditulis tiap 30 detik (memuat `clockOffsetMs`; `at` = jam lokal); `SIGINT`/`SIGTERM` → graceful shutdown.

```text
assembleWorker({ db, logger, clock = Date.now /* jam lokal */, fetch?, restSleep?, restRandom?, streamFactory?,
  setTimer?, clearTimer?, scannerOptions?, settleMs = WORKER_SETTLE_MS (3000), pipelineSleep?,
  onAlert?, onAnalysed?, onMonitoringStopped? })
  → { serverClock, repos, rest, pipeline, scanner, getSettings }
  // Tanpa efek samping (tidak membuka DB, tidak memasang handler sinyal, tidak memulai timer/jaringan).
  // Merakit jam server, klien REST, repositori, pipeline analisis, dan scanner (onMonitoringStopped →
  // pipeline.closeSymbol, listOpenSeries → repos.signals.listOpenSeries); serverClock.now menjadi clock klien REST, repositori (createRepositories(db, { clock })
  // — validasi "tertutup" candle), dan scanner. Pemanggil menjalankan `await pipeline.ensureDefinitions()`
  // sebelum `scanner.start()`. Dipakai juga oleh tes integrasi worker sehingga perakitan produksi ikut teruji.
  // onAnalysed / onMonitoringStopped hanya pengamat (log/tes).
```

## 5. Indikator — `backend/indicators/`

`ema(values, period)`, `sma`, `atr(candles, period)`, `atrPercent`, `trueRange`, `rvol(volumes, period)` (baseline candle sebelumnya), `spikeDominance(volumes, window)`, `findSwings(candles, {left, right})` → `{ highs, lows }` dengan `confirmedIndex`, `confirmedAt(swings, evalIndex)`, `trailingHigherLows(lows)`, `normalizedSlope(values, lookback)`, `percentChange(values, lookback)`.

## 6. Pola — `backend/patterns/`

```
PATTERN_VERSION = 2          // v1 → v2: earlyScore diukur dari awal struktur; penjaga lonjakan PVA (volumeGrowthBroad)
DEFAULT_SA_PARAMS, DEFAULT_PVA_PARAMS, PARAM_SPECS        // konfigurabel
validateParams(params, pattern, { maxWarmup? }), resolveParams(pattern, overrides, { maxWarmup? })
  // menolak kombinasi dengan requiredCandles > min(maxWarmup, MAX_WARMUP_CANDLES = 300) — PatternParamsError
requiredCandles(pattern, params) → number                  // warm-up
detectSilentAccumulation(candles, params?) → PatternResult
detectProgressiveVolume(candles, params?)  → PatternResult
evaluatePatterns(candles, { sa?, pva? }) → { classification: 'SA'|'PVA'|'BOTH'|'NONE', sa, pva }
SA_CONDITIONS, PVA_CONDITIONS, GATE_CONDITIONS             // daftar kondisi untuk dokumentasi/UI

PatternResult = {
  pattern: 'SA'|'PVA', version: PATTERN_VERSION, detected: boolean,
  patternScore: 0..100, earlyScore: 0..100,
  conditions: [{ id, label, passed, value, threshold, weight }],
  invalidationPrice: number|null, evaluatedAt: closeTime candle terakhir,
  riskFlags: string[] (subset RISK_FLAGS), insufficientData: boolean,
}
```

`candles`: tertutup, satu simbol & timeframe, urut naik. Data kurang dari warm-up → `detected: false, insufficientData: true`. `detected` = kondisi gerbang (`GATE_CONDITIONS`: `enoughData`, `dataQuality`) lulus **dan** setiap kondisi `required: true` lulus **dan** `patternScore ≥ minScore` (default 85) **dan** `!insufficientData`. Parameter tak dikenal ditolak `PatternParamsError`.

`patternScore` = Σ bobot kondisi lulus / Σ bobot × 100. Kondisi (bobot; * = wajib):

| SA | PVA |
|---|---|
| `rvolLow`* 20, `priceRising`* 10, `priceGradual`* 10, `higherLows`* 20, `ema7Rising`* 10, `atrPercentLow`* 5, `ema25NotFalling` 10, `atrNotExpanding` 5, `notExtended` 5, `liquidity` 5 (rata-rata quote volume per candle) | `volumeRising`* 15, `volumeGrowth`* 10, `noSpikeDominance`* 10, `volumeGrowthBroad`* 5 (median bawah sub-jendela terakhir / rata-rata sub-jendela pertama — menolak pertumbuhan yang dipasok satu–dua lonjakan), `priceRising`* 10, `riseNotSingleCandle`* 10, `higherLows`* 10, `atrPercentLow`* 5, `priorQuiet` 15, `ema7Rising` 5, `atrNotExpanding` 5 |

`earlyScore` = `distanceWeight` (0,6) × komponen jarak + `ageWeight` (0,4) × komponen umur, dengan jarak = (close − low pertama rantai higher low) / ATR, bernilai 0 pada ≥ `EARLY_SCORE.maxRunAtr` (6) ATR, dan umur = bar sejak awal struktur, 0 pada ≥ `maxAgeBars` (60). Keduanya diukur dari **awal struktur** sehingga skor tidak naik lagi setelah pullback. `invalidationPrice` tetap dari swing low terbaru dikurangi `invalidationBufferAtr` × ATR.

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
  closeOpenForSymbol({ symbol, timeframes? = null /* semua */, reason, at })
    : Promise<{ closed: [{ id, timeframe, fromState, price }] }>,
      // reason ∈ MONITORING_STOP_REASONS = ['SYMBOL_DELISTED', 'MONITORING_STOPPED'] (signals/params.js).
      // Satu transaksi: state → EXPIRED, closed_at = updated_at = at, final_outcome 'EXPIRED:<peakState>',
      // event { occurredAt: at, candleTime: candle terakhir yang dievaluasi, price: close candle tersimpan
      // terakhir | null, detail: { reason, barsInPrevState, firstDetectedPrice, invalidationPrice, priceCandleTime } }.
  listOpenSeries(): Promise<Array<{ symbol, timeframe }>>,
      // pasangan simbol × timeframe yang masih punya sinyal terbuka, tanpa duplikat, urut simbol lalu timeframe
      // (rekonsiliasi level-triggered scanner)
  listActive({ timeframe?, classification?, state?, minScore?, limit = 200 (maks 500) }),
  history({ symbol?, limit = 50 }),                                   // termasuk events[]
}
```

Tabel transisi lengkap (kondisi, reason, kapan alert) didokumentasikan di kepala `backend/signals/stateMachine.js` dan diuji di `tests/unit/signals/`. Satu-satunya transisi di luar `transition()` adalah penutupan sinyal simbol yang berhenti dipantau (`EXPIRED` dengan reason `SYMBOL_DELISTED`/`MONITORING_STOPPED`, tanpa alert) lewat `closeOpenForSymbol`, karena simbol tersebut tidak lagi menerima candle sehingga `NO_PROGRESS` tidak akan pernah tercapai. Ringkasnya: transisi maju hanya ke peringkat lebih tinggi (tanpa downgrade, sehingga alert untuk state yang sama tidak berulang), satu transisi per candle baru, candle duplikat/lama idempoten, `INVALIDATED` bila close < harga invalidasi, `EXPIRED` bila tidak ada kemajuan selama `expiryBars[state]` bar.

Skor **bukan probabilitas**. `patternScore` = jumlah bobot kondisi yang lulus (§6); `earlyScore` = seberapa dini posisi harga (jarak dari awal struktur dalam ATR dan umur struktur, §6). Konteks HTF, likuiditas 24 jam (ticker), dan kualitas data seri hanya menambah risk flag dan baris penjelasan di `buildSignalView` — tidak mengubah skor. Pengecualian yang disengaja: kondisi pola SA `liquidity` (quote volume rata-rata per candle di jendela pola) adalah kondisi berbobot 5 di `patternScore`.

## 8. Pipeline analisis — `backend/analysis/pipeline.js`

```
ANALYSIS_LOOKBACK = 300
assessSeriesQuality(candles, timeframe) → { ok, issues: ['UNCLOSED_CANDLE'|'MIXED_SERIES'|'GAP:n', …] }
analyzeAt({ symbol, timeframe, candlesByTimeframe, prev, liquidity, dataQuality, params })   // MURNI
  → { evaluationTime, patterns, context, view, market, next, event, alert }
  // params = { sa?, pva?, signals?, view?: { minQuoteVolume24h?, maxSpreadBps? } }
  // params.view diteruskan ke buildSignalView (ambang risk flag likuiditas; default DEFAULT_VIEW_PARAMS)
patternDefinitions(params) → [{ key: 'SA'|'PVA', version, name, definition: { params, conditions, requiredCandles } }]
createAnalysisPipeline({ repos, signals, getLiquidity, logger, params, lookback = 300,
  maxReplay = 288, settleMs = 0, sleep, onAlert })
  → { ensureDefinitions(), onClosedCandles({ symbol, timeframe, candles, reason }),
      closeSymbol({ symbol, timeframes? = null, reason, at }) → signals.closeOpenForSymbol(...) }
  // closeSymbol diserialkan dengan evaluasi yang masih berjalan untuk seri yang sama; tanpa alert.
```

`analyzeAt` dipakai bersama oleh worker live dan (nanti) backtest M6, sehingga hasil keduanya identik untuk data yang sama. `onClosedCandles`:

1. Evaluasi diserialisasi per simbol×timeframe.
2. Memuat `lookback + maxReplay` candle terakhir; titik awal = `lastEventCandleTime` (persisten, sehingga restart tidak memutar ulang).
3. Candle baru diputar ulang berurutan (maks `maxReplay`; pemotongan dicatat di log). Tanpa riwayat → hanya candle terakhir.
4. Bila `settleMs > 0`, menunggu sekali agar candle HTF yang tutup pada waktu yang sama sempat tersimpan (worker memakai 3 detik).
5. Setiap candle: `getOpen` → `analyzeAt` → `save` bila ada event/perubahan. **Alert hanya untuk candle terakhir** batch, sehingga backfill tidak membanjiri alert historis.
6. `getLiquidity(symbol)` (worker: `scanner.liquidityOf`) memberi ukuran likuiditas; bila menyertakan `thresholds`, ambang itu menggantikan `params.view`, sehingga `POOR_LIQUIDITY`/`WIDE_SPREAD` dan baris penjelasan `CONTEXT:LIQUIDITY` memakai batas pengaturan pengguna (penting di mode manual, yang tidak memfilter likuiditas saat discovery).

## 9. API — `backend/api/signalRoutes.js`, `backend/api/systemRoutes.js`

Semua route di bawah `/api/` melewati gerbang autentikasi berbasis route (lihat `docs/01-arsitektur.md`). Coercion tipe dimatikan, sehingga query divalidasi sebagai string berpola.

| Endpoint | Query | Respons |
|---|---|---|
| `GET /api/signals/active` | `timeframe`, `classification` (SA/PVA/BOTH), `state` (state aktif), `minScore` (0–100), `limit` (1–500) | `{ signals: [...] }` + `lastPrice`, `lastCandleAt` per baris |
| `GET /api/signals/history` | `symbol` (`^[A-Z0-9]{2,30}$`), `limit` | `{ signals: [...] }` dengan `events[]` |
| `GET /api/system/status` | — | status proses API + `scanner`, `binance`, `ingestion` dari `summarizeWorker` |
| `GET /api/overview` | — | ringkasan + `alignedSignals`, `scanner`, `binance`, `marketContext` (BTC/ETH 1h) |

`backend/system/workerStatus.js` — `summarizeWorker(ingestion, now)` membaca heartbeat di database; `now` = `Date.now()` proses API, sehingga `heartbeat.at` (dan `lastIngestionAt`, `lastRun`, `recentErrors[].at`) wajib distempel jam lokal host oleh worker (`localClock` scanner), bukan waktu server Binance. Heartbeat lebih tua dari 90 detik → `stale`; tanpa heartbeat → `not_running` (tidak pernah angka palsu). `backend/system/marketContext.js` — `buildMarketContext(candles, symbols)` → `classifyTrend` pada 120 candle 1h; tanpa data → `{ status: 'no_data' }`.

## 10. Penyimpangan dari draf awal

| Draf | Implementasi | Alasan |
|---|---|---|
| `heartbeat({ at, state })` dengan metrik terpisah | `state` = snapshot `status()` lengkap | Metrik sempat hilang karena kontrak tidak cocok; satu objek menghindari drift |
| Scanner tanpa info likuiditas | `liquidityOf(symbol)` | Risk flag `POOR_LIQUIDITY`/`WIDE_SPREAD` butuh data discovery |
| Sinyal simbol yang delisted/berhenti dipantau tetap terbuka selamanya | `closeOpenForSymbol` + `pipeline.closeSymbol` + `onMonitoringStopped` scanner | Expiry hanya maju saat ada candle baru; tanpa penutupan eksplisit screener terus menampilkan sinyal basi |
| Penutupan hanya saat simbol/timeframe berubah (edge-triggered) | `+ listOpenSeries` (scanner & `signalRepository`): rekonsiliasi tiap discovery berhasil | Callback yang gagal, stop() di tengah siklus, perubahan saat worker mati, dan sinyal yatim DB lama tidak pernah dicoba ulang |
| `upsertFromExchange` → `{ inserted, updated, rejected }` (tak terbatas, diabaikan scanner) | `+ rejectedCount`, `rejected` dibatasi 50; scanner mencatatnya per discovery | Simbol yang tidak lolos pola (kontrak delivery) sebelumnya hilang tanpa jejak |
| Perakitan worker hanya di `main()` `worker/index.js` (tes integrasi menyalin perakitannya) | `worker/assemble.js` → `assembleWorker` | Regresi perakitan (mis. repositori/REST kembali ke `Date.now`) tidak tertangkap tes |
| Semua stempel scanner memakai `clock` = waktu server | `localClock` (jam host) untuk heartbeat/run/error/lastIngestionAt | API membandingkan heartbeat dengan `Date.now` lokal; dengan waktu server, host yang > 60 detik lebih cepat tampil `stale` dan worker mati tersembunyi selama offset bila host lebih lambat |
| Worker memakai jam lokal (`Date.now`) | `createServerClock` + sinkronisasi `/fapi/v1/time` tiap siklus scanner (sampel satu percobaan `rest.sampleServerTime`, RTT ≤ 1 detik) | Jam lokal yang lebih cepat membuat kline final WS ditolak ("belum tertutup"); yang lebih lambat dapat menganggap candle berjalan tertutup |
| Risk flag likuiditas selalu dinilai dengan `DEFAULT_VIEW_PARAMS` | `liquidityOf` menyertakan `thresholds` dari `settings.liquidity`; `analyzeAt` menerima `params.view` | Batas pengguna (terutama mode manual) harus sama dengan batas yang ditampilkan di penjelasan; backtest tetap dapat memberi ambangnya sendiri |
| `createSignalRepository(db)` | `+ { clock }`, `lastEventCandleTime` | Tes deterministik; titik awal replay yang persisten |
| Kolom tracking (`barsInState`, `peakPrice`, `lastCandleTime`) di tabel `signals` | Disimpan di `explanation_json.tracking` | Menghindari migrasi skema saat M3; kandidat migrasi `004` (lihat `docs/05-database.md`) |
| `classifyTrend` selalu mengembalikan trend | `trend: null` bila data kurang/HTF basi | Tidak memalsukan konteks saat data tidak cukup |
| Batas simbol 2–30 karakter di semua tempat | Discovery: basis 1–20 + `USDT`; API riwayat: 2–30 | Discovery mengikuti format USDT-M; API menerima simbol lama yang masih tersimpan |
