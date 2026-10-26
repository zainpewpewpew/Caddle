# 07 — Kontrak Antarmodul (Milestone 2–3 + Short Scanner)

Dokumen ini mengikat modul yang dikembangkan paralel dan sudah **disesuaikan dengan implementasi** (bukan lagi draf). Konstanta & typedef ada di `backend/market/contracts.js`. Semua waktu epoch ms UTC. Semua angka harga/volume `number` (float64). Bagian terakhir mencatat penyimpangan dari draf awal beserta alasannya.

## Aturan umum

- Modul domain (`indicators`, `patterns`, `timeframe`, `signals`, `scoring`, `analysis/analyzeAt`) adalah **fungsi murni**: tanpa I/O, tanpa `Date.now()`, tanpa state global. Waktu diberikan sebagai argumen.
- Modul ber-I/O (`ingestion`, `worker`, repositori, `createAnalysisPipeline`) menerima dependensi lewat injeksi (`fetch`, `WebSocketImpl`, `clock`, `closureClock`, `sleep`, `setTimer`, `yieldToEventLoop`, `logger`, `db`) agar dapat diuji tanpa jaringan.
- Hanya **candle tertutup** (`isClosed: true`) yang masuk tabel kanonik dan dipakai sinyal terkonfirmasi. Candle berjalan disimpan terpisah di `provisional_candles`.
- Penutupan dengan margin: candle REST dianggap tertutup hanya bila `closeTime < (jam acuan penutupan saat request dimulai − CLOSE_MARGIN_MS)` (2 detik, §2/§4); kline final WebSocket (`k.x`) diterima walau jam worker tertinggal kurang dari `WS_CLOCK_TOLERANCE_MS` (2 detik, §3). Selisih jam yang lebih besar → candle WS ditolak.
- Tidak ada lookahead: pada waktu evaluasi `t`, hanya data dengan `closeTime <= t` yang boleh dipakai — termasuk candle timeframe lebih tinggi dan swing (`confirmedIndex`). Ukuran likuiditas 24 jam saat ini hanya dipakai untuk candle terbaru (§8).
- Host jaringan yang diizinkan: `fapi.binance.com` (REST) dan `fstream.binance.com` (WebSocket), ditegakkan oleh allowlist di klien. WebSocket kline wajib memakai rute kategori `/market` (`wss://fstream.binance.com/market/stream?streams=…`, §4). Tidak ada URL dari input pengguna.
- Fixture Binance di `tests/fixtures/binance/` adalah **sintetis** mengikuti format dokumentasi resmi, bukan rekaman pasar nyata.
- **Arah sinyal** (`direction`): `'LONG'` (struktur bullish, pola SA/PVA) atau `'SHORT'` (struktur bearish, pola SD/PVD — Short Scanner). Argumen, snapshot, dan baris database tanpa arah (data/pemanggil lama) = `'LONG'`; parameter arah baru selalu opsional sehingga perilaku lama tidak berubah. Sinyal SHORT adalah **kandidat riset**, bukan rekomendasi jual/short; aplikasi tidak pernah mengeksekusi order di arah mana pun. Semua harga yang disimpan/ditampilkan adalah harga nyata (bukan harga cermin, §6).

## Konstanta (`backend/market/contracts.js`)

| Konstanta | Nilai |
|---|---|
| `TIMEFRAMES` | `5m`, `15m`, `1h` |
| `HIGHER_TIMEFRAMES` | `5m → [15m, 1h]`, `15m → [1h]`, `1h → []` |
| `SIGNAL_STATES` | `NO_PATTERN`, `QUIET`, `EARLY_BULLISH`, `MOMENTUM_BUILDING`, `BREAKOUT`, `INVALIDATED`, `EXPIRED`, `EARLY_BEARISH`, `BREAKDOWN` (dua terakhir khusus SHORT; `EARLY_BULLISH`/`BREAKOUT` khusus LONG) |
| `DIRECTIONS` / `DEFAULT_DIRECTION` | `LONG`, `SHORT` / `LONG` — `resolveDirection(d)`: `undefined`/`null` → `'LONG'`, nilai lain di luar daftar → `RangeError` |
| `PATTERN_KEYS` / `SHORT_PATTERN_KEYS` | `SA`, `PVA` (LONG) / `SD`, `PVD` (SHORT); `PATTERN_KEYS_BY_DIRECTION = { LONG, SHORT }` |
| `CLASSIFICATIONS` / `SHORT_CLASSIFICATIONS` | `SA`, `PVA`, `BOTH`, `NONE` / `SD`, `PVD`, `BOTH`, `NONE`; `CLASSIFICATIONS_BY_DIRECTION = { LONG, SHORT }` |
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
  allowedHosts = ['fapi.binance.com'] /* hanya untuk tes */, random = Math.random /* jitter */,
  closeMarginMs = CLOSE_MARGIN_MS /* 2000; bilangan bulat 0..60000 */, closureClock = clock })
→ {
  getServerTime(): Promise<number>,
  sampleServerTime({ clock? }): Promise<{ serverTime, sentAt, receivedAt }>,
      // SATU percobaan tanpa retry/backoff; sentAt/receivedAt (jam pemanggil) diambil setelah antrean limiter,
      // tepat di sekitar fetch → jeda Retry-After/backoff tidak masuk round-trip (sinkronisasi jam, §4)
  getExchangeInfo(): Promise<SymbolInfo[]>,
  getKlines({ symbol, timeframe, startTime?, endTime?, limit? = 500 (maks 1500) }): Promise<Candle[]>,
      // isClosed = closeTime < (closureClock() saat request DIMULAI − closeMarginMs); jam dibaca SEBELUM antrean
      // limiter/retry, karena snapshot Binance diambil setelah request dikirim. source 'rest'.
      // Worker: clock = serverClock.now, closureClock = serverClock.closureNow (§4)
  get24hTickers(): Promise<Ticker24h[]>,
  getBookTickers(): Promise<BookTicker[]>,   // spreadBps dihitung
  usedWeight(): number,                      // estimasi lokal ∨ header X-MBX-USED-WEIGHT-1M
}
SymbolInfo  = { symbol, baseAsset, quoteAsset, contractType, status, tickSize, stepSize, onboardDate }
Ticker24h   = { symbol, lastPrice, priceChangePercent, volume, quoteVolume, closeTime }
BookTicker  = { symbol, bidPrice, askPrice, spreadBps }
```

Error: `BinanceApiError { status, code, retryable, retryAfterMs }`. 429/418 → hormati `Retry-After`. Status dan `Retry-After` diproses **sebelum** body dibaca: 418/429 yang body-nya macet sampai timeout tetap menjadi error rate-limit (`code` dari body bila ada, selain itu `RATE_LIMITED`/`IP_BANNED`; `status`, `retryAfterMs`, `retryable: true`) dan tetap menahan limiter (429 dengan `Retry-After`; 418 selama `Retry-After` atau 120 detik) — tidak pernah menjadi `TIMEOUT`. 418 tidak diulang di dalam panggilan; jeda `Retry-After` > 60 detik dikembalikan ke pemanggil. 5xx/timeout → backoff eksponensial "equal jitter"; 4xx lain (termasuk **451**, lokasi dibatasi) tidak diulang. `baseUrl` di luar allowlist ditolak saat konstruksi (`resolveBaseUrl`).

`backend/ingestion/symbolDiscovery.js`:

```
discoverSymbols({ symbols: SymbolInfo[], tickers: Ticker24h[], bookTickers: BookTicker[], settings })
→ { selected: [{ symbol, quoteVolume24h, spreadBps }], rejected: [{ symbol, reason }] }
REJECT_REASONS: NOT_PERPETUAL, NOT_USDT, NOT_TRADING, INVALID_SYMBOL, NO_TICKER, LOW_VOLUME,
                WIDE_SPREAD, NOT_IN_MANUAL_LIST, MAX_AUTO_LIMIT
```

Mode auto → filter `PERPETUAL`+`USDT`+`TRADING`, `minQuoteVolume24h`, `maxSpreadBps`, urut quote volume, ambil `maxAuto`. Mode manual → hanya simbol `manual` yang valid & TRADING. Simbol valid: basis 1–20 karakter `[A-Z0-9]` + `USDT`. Scanner memakai `REJECT_REASONS` untuk penjaga discovery 0 simbol (§4).

## 3. Validasi & penyimpanan — `backend/ingestion/candleValidator.js`, `backend/database/`

```
isValidSymbol(symbol) → boolean
WS_CLOCK_TOLERANCE_MS = CLOSE_MARGIN_MS              // 2000
validateCandle(candle, { now, wsClockToleranceMs = WS_CLOCK_TOLERANCE_MS /* bilangan bulat 0..60000 */ })
  → { ok: boolean, errors: string[] }
  // source 'rest': isClosed sah bila now > closeTime; openTime > now → "di masa depan".
  // source 'ws' (isClosed dari bendera bursa k.x): sah bila now > closeTime − toleransi; openTime "di masa depan"
  // hanya bila openTime > now + toleransi. Jam yang tertinggal lebih dari toleransi → candle ditolak.
normalizeBatch(candles) → Candle[]          // urut openTime, buang duplikat (versi terakhir menang)
floorToInterval(time, timeframe) → number
assessFreshness({ lastOpenTime, timeframe, now, graceMs = 0 })
  → { expectedLastOpenTime, missingCandles: number|null, lagMs: number|null, stale: boolean }
  // expectedLastOpenTime = openTime candle tertutup terbaru pada now; lagMs = max(0, now − (lastOpenTime + interval));
  // stale = missingCandles > 0 ∧ now − (lastOpenTime + 2·interval) > graceMs — diukur dari candle tertinggal PALING LAMA.
  // lastOpenTime null → { missingCandles: null, lagMs: null, stale: true }

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
  heartbeat({ at, state }),                       // state = snapshot scanner.status() lengkap (+ owner bila diset)
  getStatus(): { lastRun, recentErrors, heartbeat: { at, state } | null },
}
```

Semua repositori dirakit oleh `createRepositories(db, { clock })` di `backend/database/repositories/index.js`: `users`, `sessions`, `settings`, `audit`, `overview`, `candles`, `symbols`, `ingestion`, `signals`.

## 4. Streaming, backfill, worker — `backend/ingestion/binance/wsClient.js`, `backend/ingestion/backfill.js`, `worker/`

```
createKlineStream({ WebSocketImpl = globalThis.WebSocket, baseUrl = 'wss://fstream.binance.com/market',
  streams: [{ symbol, timeframe }], onCandle(candle), onState(state), clock, setTimer, clearTimer, random,
  backoff = { initialMs: 1000, maxMs: 60_000 }, staleMs, connectTimeoutMs, stableMs,
  maxConnectionAgeMs, maxMessageBytes, maxStreamsPerConnection = 200 })
  → { start(), stop(), state() }
  // k.x === true → isClosed true; lainnya provisional. Koneksi dipecah per ≤ 200 stream,
  // diputar sebelum batas 24 jam Binance, dianggap stale bila tidak ada pesan selama staleMs.
  // URL: `${baseUrl}/stream?streams=a/b` → wss://fstream.binance.com/market/stream?streams=btcusdt@kline_5m/…
  // Sejak upgrade WebSocket USDⓈ-M Binance (pemberitahuan 2026-03-06; URL lama /ws & /stream dimatikan setelah
  // 2026-04-23) stream dibagi ke rute /public, /market, /private; kline = /market. URL tanpa rute tidak mengirim
  // kline, jadi baseUrl selain rute /market (tanpa query/fragment) ditolak saat konstruksi (fail closed).
KLINE_WS_ROUTE = '/market'

CLOSE_MARGIN_MS = 2_000      // margin penutupan: isClosed REST, rencana backfill/gap/sweep, toleransi jam WS (§3)
lastClosedOpenTime(now, timeframe) → number
planBackfill({ lastOpenTime, now, timeframe, maxCandles, chunkSize = 1500 }) → Array<{ startTime, endTime, limit }>
planGapFill({ gaps, timeframe, now, mergeWithin = 0, chunkSize = 1500 }) → Array<{ startTime, endTime, limit }>
  // Fungsi murni tanpa margin; scanner memberi now = closureClock() − closeMarginMs.

createServerClock({ getServerTime, clock = Date.now, logger, maxOffsetMs = 600_000, maxRoundTripMs = 1_000, maxAttempts = 3 })
  → { now(), closureNow(), offsetMs(), lastSync(), sync(): Promise<{ ok, offsetMs, measuredOffsetMs, roundTripMs, reason?, message? }> }
  // backend/ingestion/serverClock.js. offset = serverTime − titik tengah round-trip (galat ≤ RTT/2). sync() tidak pernah reject:
  // gagal (REQUEST_FAILED/BAD_RESPONSE) → offset terakhir (awal 0) tetap; RTT > maxRoundTripMs → sampel dibuang;
  // |offset| > maxOffsetMs → TIDAK diterapkan (OFFSET_OUT_OF_RANGE, kemungkinan jam host/NTP rusak) dan dilaporkan.
  // getServerTime({ clock }) dipanggil malas dengan jam lokal → sampel { serverTime, sentAt, receivedAt } (stempel di dalam
  // rentang panggilan, selain itu BAD_RESPONSE) atau angka (RTT = durasi panggilan). Worker: `(o) => rest.sampleServerTime(o)`,
  // sehingga klien REST boleh memakai serverClock.now. Percobaan gagal retryable / RTT terlalu panjang → sampel BARU
  // (maks maxAttempts per sync); error retryable:false (mis. HTTP 400) dan BAD_RESPONSE tidak diulang.
  // closureNow() = acuan keputusan "candle sudah tertutup" (isClosed kline REST, rencana REST & staleness sweep scanner):
  // sama dengan now(), KECUALI jam diketahui salah — OFFSET_OUT_OF_RANGE, atau ROUND_TRIP_TOO_LONG selama belum pernah
  // ada sync berhasil (atau sejak OFFSET_OUT_OF_RANGE): saat itu clock() + min(offset, serverTime − receivedAt sampel
  // terakhir), yaitu batas bawah waktu server. Hanya dapat membuat lebih SEDIKIT candle dianggap tertutup; stempel waktu
  // tetap now(); bersih lagi pada sync berikutnya yang berhasil. Batas: bila /fapi/v1/time tidak pernah menjawab (tanpa
  // sampel), closureNow() = jam lokal + offset terakhir (awal 0).

createScanner({ rest, streamFactory, repos, getSettings, onClosedCandles, onMonitoringStopped?, listOpenSeries?, discoverSymbols,
  clock, localClock? = clock, closureClock? = clock, logger, setTimer, clearTimer, options /* SCANNER_DEFAULTS */, serverClock?,
  heartbeatOwner? = null /* { pid: int > 0, host: string } */ })
  → { start(), stop(), status(), liquidityOf(symbol) }
  // heartbeatOwner: disimpan sebagai state.owner di SETIAP heartbeat (tidak di status()); dipakai supervisor worker
  // (§11) untuk mengenali heartbeat segar dari proses yang sudah mati. Nilai lain → TypeError.
  // clock = waktu server (worker: serverClock.now) untuk staleStreams, candleLagMs, awal bootstrap stream (liveFrom),
  // serta stempel simbol & penutupan sinyal (`at`). closureClock (worker: serverClock.closureNow) − closeMarginMs = acuan
  // rencana REST (bootstrap/backfill, gap, repair) dan staleness sweep (closureClock() − max(grace, closeMarginMs)).
  // localClock = jam host (worker: Date.now) untuk stempel yang dibandingkan API/UI dengan jamnya sendiri: heartbeat `at`,
  // recordRun startedAt/finishedAt (scanDurationMs), recordError `at`, lastIngestionAt. Mencampur keduanya membuat
  // summarizeWorker salah menilai umur heartbeat sebesar offset jam.
  // serverClock: sync() di awal setiap siklus (start, rediscovery, percobaan ulang discovery) sebelum discovery;
  // hasil ok:false dicatat sebagai error ingesti sumber 'clock' (tidak menghentikan worker). OFFSET_OUT_OF_RANGE →
  // clockFault + state 'degraded' (log warning) sampai sync berikutnya berhasil; kegagalan lain tidak mengubah state.
SCANNER_DEFAULTS = { heartbeatMs: 30_000, rediscoveryMs: 3_600_000, discoveryRetryMs: 60_000, restConcurrency: 3,
  provisionalThrottleMs: 1_000, closeMarginMs: CLOSE_MARGIN_MS /* divalidasi 0..60000 */, sweepGraceMs: 30_000,
  maxGapCandles: 10_000, gapMergeWithin: 50, errorThrottleMs: 60_000, emitBootstrap: false }
status() = { state, lastIngestionAt, candleLagMs, reconnects, errors, scanDurationMs, queue,
             symbols, streams /* termasuk seri konteks HTF */, staleStreams, ws, gaps, duplicates,
             clockOffsetMs /* null tanpa serverClock */, clockFault: 'OFFSET_OUT_OF_RANGE' | null }
  // state = fase ('idle'|'starting'|'stopping'|'stopped'); saat berjalan 'running', atau 'degraded' bila stream WS
  // belum ada / tidak 'open' atau clockFault ≠ null.
onClosedCandles({ symbol, timeframe, candles, reason })
  // reason: 'live' (candle WS berikutnya) | 'gap' (lompatan openTime → backfill REST dulu, candle WS pemicu ikut) |
  // 'sweep' (sweep berkala) | 'reconnect' (catch-up setelah reconnect/penggantian stream) | 'catchup' (sweep sekali
  // setelah margin pada open pertama stream awal) | 'bootstrap' (hanya bila options.emitBootstrap).
  // Seri tanpa data (bootstrap murni) tidak dianalisis kecuali emitBootstrap; duplikat/out-of-order disimpan tanpa analisis;
  // 'catchup' hanya menganalisis candle yang tutup setelah bootstrap stream dimulai (yang lebih awal = histori).
onMonitoringStopped({ symbol, timeframes: string[] | null, reason: 'SYMBOL_DELISTED' | 'MONITORING_STOPPED', at })
  // setelah stream lama dilepas: simbol yang sebelumnya dipantau (termasuk daftar DB di siklus pertama) dan tidak
  // terpilih lagi → timeframes null (semua); timeframe yang berhenti dianalisis untuk simbol yang tetap dipantau —
  // stream-nya dilepas ATAU turun menjadi seri konteks HTF saja — → MONITORING_STOPPED dengan timeframes itu.
  // Dipicu discovery berhasil, atau discovery anomali yang tetap melepas simbol delisted (lihat bawah). Error dicatat
  // (sumber 'monitoring').
listOpenSeries?() → Promise<Array<{ symbol, timeframe }>>   // worker: repos.signals.listOpenSeries
  // Rekonsiliasi LEVEL-TRIGGERED setelah setiap discovery berhasil (sesudah pelaporan di atas): seri bersinyal
  // terbuka yang tidak dipantau → onMonitoringStopped — simbol tidak terpilih → timeframes null, reason
  // SYMBOL_DELISTED bila tidak TRADING / hilang dari exchangeInfo, selain itu MONITORING_STOPPED; simbol terpilih
  // dengan timeframe di luar settings.timeframes (termasuk timeframe yang hanya diingesti sebagai konteks HTF) →
  // MONITORING_STOPPED + timeframe itu. Seri yang sudah dilaporkan di siklus yang sama dilewati. Menutup ulang
  // penutupan yang gagal (callback error), stop() di tengah siklus (setMonitored sudah commit), timeframe dilepas saat
  // worker mati, dan sinyal yatim dari DB lama. Fallback daftar DB (discovery gagal) dan discovery anomali tidak pernah
  // merekonsiliasi. Error listOpenSeries dicatat (sumber 'monitoring').
liquidityOf(symbol) → { quoteVolume24h, spreadBps, thresholds: { minQuoteVolume24h, maxSpreadBps } | null } | null
    // dari discovery terakhir; thresholds = settings.liquidity yang dipakai discovery tersebut
```

Perilaku scanner yang mengikat:

- **Seri yang diingesti** per simbol = `settings.timeframes` ∪ `HIGHER_TIMEFRAMES`-nya (mis. hanya `5m` dipilih → `5m`, `15m`, `1h` diingesti). Hanya timeframe terpilih yang memanggil `onClosedCandles`; seri konteks saja disimpan agar konteks HTF live sama dengan replay, tetapi tidak pernah dianalisis.
- **Catch-up WebSocket:** saat socket terbuka kembali (reconnect, atau open pertama stream pengganti) → sweep segera dengan grace = `closeMarginMs`, lalu satu sweep ulang setelah `closeMarginMs` yang juga mengantrekan stream yang sinkronisasinya masih berjalan (rencana dihitung ulang dari high-water mark saat berjalan; tanpa request bila candle sudah diterima). Open pertama stream awal → satu sweep `catchup` setelah `closeMarginMs` (stream yang bootstrap-nya gagal dilewati).
- **Sweep berkala** tiap `settings.refresh.restBackfillIntervalSec` (30–3600, default 300) dengan `sweepGraceMs`; dijadwalkan begitu scanner berjalan **dan** pengaturan pernah termuat (bila pemuatan pertama gagal, siklus berikutnya yang berhasil menjadwalkannya).
- **Discovery 0 simbol:** bila discovery memilih 0 simbol padahal set pantauan sebelumnya (memori, atau daftar DB di siklus pertama) tidak kosong, hasilnya dianggap **anomali** bila data tidak menjelaskannya: exchangeInfo kosong; mode auto dengan ticker 24 jam / book ticker kosong; atau ada simbol lama yang masih `TRADING` tanpa alasan tolak atau hanya `NO_TICKER`. Anomali diperlakukan seperti discovery gagal (error sumber `'discovery'`, coba ulang setelah `min(rediscoveryMs, discoveryRetryMs × 2^(gagal−1))`, data likuiditas terakhir tetap, tanpa rekonsiliasi); set pantauan dipertahankan, kecuali simbol lama yang menurut exchangeInfo (tidak kosong) tidak lagi `TRADING` atau tidak tercantum — simbol itu tetap dilepas (`markDelisted`, `SYMBOL_DELISTED`). 0 simbol yang dijelaskan (simbol lama delisted, atau ditolak filter pengaturan yang sah, mis. `NOT_IN_MANUAL_LIST`, `LOW_VOLUME`, `WIDE_SPREAD`) diterapkan seperti discovery biasa.
- **Throttle error:** setiap error dihitung (`errors`), tetapi ditulis ke `ingestion_errors` maksimal sekali per `source|pesan` per `errorThrottleMs` (60 detik); pesan memuat simbol & timeframe, sehingga error yang sama di seri lain tetap tercatat.

Entry point `worker/index.js` (`npm run worker`) membuka SQLite + migrasi, lalu merakit dependensi lewat `worker/assemble.js`; heartbeat ditulis tiap 30 detik (memuat `clockOffsetMs`, `clockFault`, dan `owner: { pid: process.pid, host: os.hostname() }`; `at` = jam lokal); `SIGINT`/`SIGTERM`/`SIGHUP` (jendela terminal ditutup) → graceful shutdown.

```text
assembleWorker({ db, logger, clock = Date.now /* jam lokal */, fetch?, restSleep?, restRandom?, streamFactory?,
  setTimer?, clearTimer?, scannerOptions?, settleMs = WORKER_SETTLE_MS (3000), pipelineSleep?,
  onAlert?, onAnalysed?, onMonitoringStopped?, heartbeatOwner? = null /* diteruskan ke createScanner */,
  directions = DIRECTIONS /* ['LONG', 'SHORT'] — diteruskan ke createAnalysisPipeline */ })
  → { serverClock, repos, rest, pipeline, scanner, getSettings }
  // Satu worker memindai KEDUA arah: setiap candle tertutup dievaluasi untuk LONG dan SHORT dengan candle & fitur
  // bersama (§8). onAlert menerima { symbol, timeframe, direction, state, event, view }; worker/index.js
  // mencatatnya ke log ('sinyal baru / naik tahap', termasuk field direction).
  // Tanpa efek samping (tidak membuka DB, tidak memasang handler sinyal, tidak memulai timer/jaringan).
  // Merakit jam server, klien REST, repositori, pipeline analisis, dan scanner (onMonitoringStopped →
  // pipeline.closeSymbol, listOpenSeries → repos.signals.listOpenSeries); serverClock.now menjadi clock klien REST, repositori (createRepositories(db, { clock })
  // — validasi "tertutup" candle), dan scanner; serverClock.closureNow menjadi closureClock klien REST dan scanner.
  // closeMarginMs yang sama (scannerOptions.closeMarginMs ?? CLOSE_MARGIN_MS) dipakai klien REST dan scanner.
  // Pemanggil menjalankan `await pipeline.ensureDefinitions()`
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
  // menolak kombinasi dengan requiredCandles > min(maxWarmup, MAX_WARMUP_CANDLES = 300): validateParams mengembalikan
  // daftar error [{ path, message }] (tidak melempar), resolveParams melempar PatternParamsError
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

### Pola SHORT — Silent Distribution (SD, #003) & Progressive Volume Distribution (PVD, #004)

```
SHORT_PATTERN_VERSION = 1    // v1 = cermin SA/PVA PATTERN_VERSION 2 (MIRRORED_LONG_VERSION); setiap kenaikan
                             // PATTERN_VERSION WAJIB ikut menaikkan versi ini
DEFAULT_SD_PARAMS, DEFAULT_PVD_PARAMS, PARAM_SPECS.SD, PARAM_SPECS.PVD
  // = parameter & rentang SA/PVA; minHigherLows bernama minLowerHighs (higher low cermin = lower high nyata)
MIRROR_BASE = { SD: 'SA', PVD: 'PVA' }, toMirrorBaseParams(params)   // parameter SHORT → parameter detektor cermin
validateParams / resolveParams / requiredCandles menerima 'SD'|'PVD' (warm-up = formula pola cerminnya: SD 63, PVD 70)
mirrorCandles(candles) → candle cermin (harga p → 1/p, high ↔ low; volume & waktu tetap)
unmirrorPrice(p) → 1/p | null,  realChangeOf(m) → 1/(1+m) − 1 | null
detectSilentDistribution(candles, params?)      → PatternResult (pattern 'SD',  version SHORT_PATTERN_VERSION)
detectProgressiveDistribution(candles, params?) → PatternResult (pattern 'PVD', version SHORT_PATTERN_VERSION)
evaluateShortPatterns(candles, { sd?, pvd? }) → { direction: 'SHORT', classification: 'SD'|'PVD'|'BOTH'|'NONE', sd, pvd }
evaluatePatternsFor(direction, candles, options)   // LONG → evaluatePatterns, SHORT → evaluateShortPatterns; lainnya → RangeError
classifyShort(sdDetected, pvdDetected), SD_CONDITIONS, PVD_CONDITIONS
```

Metode: candle dicerminkan (harga p → 1/p, high ↔ low), lalu detektor SA/PVA yang **sama** dijalankan pada cermin — higher low cermin = lower high nyata, EMA naik pada cermin = EMA nyata turun, harga naik pada cermin = harga nyata turun. Logika SA/PVA tidak diduplikasi, sehingga gerbang, bobot, `minScore`, `detected`, dan `insufficientData` berperilaku persis sama. Hasil cermin dipetakan kembali ke harga nyata:

- **Eksak:** perubahan harga (`priceFalling`, `priceGradual`) — nilai & ambang = 1/(1+m) − 1. Ambang parameter `maxPriceChange` berlaku pada skala cermin: penurunan nyata d setara kenaikan cermin d / (1 − d). `invalidationPrice` = 1 / level cermin → harga nyata **di atas** harga, yaitu di atas swing high terkonfirmasi terakhir (buffer `invalidationBufferAtr` × ATR dihitung pada skala cermin).
- **Aproksimasi orde pertama:** slope EMA (`ema7Falling`, `ema25NotRising`) = slope cermin dengan tanda dibalik; ATR%, rasio berbasis ATR (mis. `notExtended`), dan porsi penurunan satu candle (`dropNotSingleCandle`) diteruskan dari cermin (≈ nilai nyata untuk pergerakan kecil). Volume, RVOL, dan porsi volume identik.
- Status lulus/gagal tiap kondisi, `patternScore`, `earlyScore`, dan risk flag diambil apa adanya dari evaluasi cermin. `EXTENDED_PRICE` pada cermin = harga nyata jauh **di bawah** EMA25. `earlyScore` = jarak close dari high pertama rantai lower high (dalam ATR) + umur struktur.

Kondisi (bobot; * = wajib) — id kondisi LONG diganti padanan SHORT:

| SD (cermin SA) | PVD (cermin PVA) |
|---|---|
| `rvolLow`* 20, `priceFalling`* 10 (perubahan < 0), `priceGradual`* 10 (perubahan ≥ −ambang), `lowerHighs`* 20, `ema7Falling`* 10, `atrPercentLow`* 5, `ema25NotRising` 10, `atrNotExpanding` 5, `notExtended` 5 ((EMA25 − close) / ATR ≤ ambang), `liquidity` 5 | `volumeRising`* 15, `volumeGrowth`* 10, `noSpikeDominance`* 10, `volumeGrowthBroad`* 5, `priceFalling`* 10, `dropNotSingleCandle`* 10 (porsi penurunan dari satu candle ≤ ambang), `lowerHighs`* 10, `atrPercentLow`* 5, `priorQuiet` 15, `ema7Falling` 5, `atrNotExpanding` 5 |

Default SD/PVD = default SA/PVA: titik awal, **bukan** hasil optimasi; wajib divalidasi backtest out-of-sample seperti pola LONG. Definisi tersimpan (`pattern_definitions`, §8) memuat `direction: 'SHORT'` dan `mirrorOf: { pattern, version }`, sehingga perubahan SA/PVA tanpa menaikkan `SHORT_PATTERN_VERSION` ditolak `DEFINITION_CONFLICT` saat start. Skor SHORT tetap skor aturan yang dapat dijelaskan — bukan probabilitas, bukan rekomendasi jual/short.

## 7. Timeframe, sinyal, skor — `backend/timeframe/`, `backend/signals/`, `backend/scoring/`

```
classifyTrend(candles, params?) → { trend: 'BULLISH'|'NEUTRAL'|'BEARISH', reasons: string[], score: -4..4 }
  // TIDAK pernah null: data < trendWarmup (slowPeriod + slopeLookback − 1 = 29) → NEUTRAL, reasons ['INSUFFICIENT_DATA'],
  // score 0. Pemetaan ke null dilakukan pemanggil (buildTimeframeContext, buildMarketContext §9).
closedAsOf(candles, t) → Candle[]                         // closeTime <= t, tanpa candle isClosed false
lastClosedCloseTime(t, timeframe) → number
resolveAlignment({ baseTrendOk: boolean, higherTrends: Array<'BULLISH'|'NEUTRAL'|'BEARISH'|null>, direction? = 'LONG' })
  → 'ALIGNED'|'PARTIALLY_CONFIRMED'|'UNCONFIRMED'|'COUNTERTREND'
  // SHORT: BULLISH ↔ BEARISH ditukar sebelum tabel keputusan (ALIGNED = semua HTF BEARISH, COUNTERTREND = ada HTF BULLISH)
orientTrend(trend, direction? = 'LONG') → trend dari sudut arah (SHORT: BULLISH ↔ BEARISH; null/NEUTRAL tetap)
buildTimeframeContext({ baseTimeframe, evaluationTime, candlesByTimeframe,
  params: { maxStaleBars = 1, settleWindowMs = 60_000, trend }, direction? = 'LONG' })
  → { alignment, trends: { [tf]: { trend: 'BULLISH'|'NEUTRAL'|'BEARISH'|null, reasons, score?, asOf, candleCount } } }
  // trend null (tidak tersedia, tanpa score) dengan reason 'NO_DATA' (tanpa candle tertutup; asOf null, candleCount 0),
  // 'STALE_DATA' (candle HTF tertinggal), atau 'INSUFFICIENT_DATA' (candle kurang dari warm-up trend).
  // STALE_DATA: HTF boleh tertinggal maxStaleBars bar hanya dalam settleWindowMs setelah closeTime candle HTF yang
  // seharusnya sudah tutup (race ingesti di batas bersama); di luar jendela itu toleransinya max(0, maxStaleBars − 1).
  // Hanya trend dasar yang BERLAWANAN arah (LONG: BEARISH, SHORT: BULLISH) yang membuat baseTrendOk false; HTF tidak
  // pernah membuang pola dasar. `trends` tidak bergantung arah; `alignment` relatif terhadap arah.
contextForDirection(context, baseTimeframe, direction) → { alignment, trends }
  // alignment arah lain dari trend yang sudah dihitung (tanpa menghitung ulang EMA/swing HTF); `trends` dibagi

transition(prev: SignalSnapshot|null, input, params?) → { next: SignalSnapshot, event: SignalEvent|null, alert: boolean }
  input = { candle, patterns, direction?, context: { alignment }, market: { atr, rvol, resistance, support }, view }
  // direction default = arah `patterns` (evaluateShortPatterns → 'SHORT'; tanpa keduanya LONG). direction yang
  // berbeda dari arah pola, atau prev arah lain → RangeError. LONG memakai market.resistance; SHORT memakai
  // market.support dan candle.low (wajib angka).
deriveMarketInputs(candles, params?) → { atr, rvol, resistance }   // resistance = swing high terkonfirmasi (LONG)
deriveDirectionalMarketInputs(candles, params?) → { LONG: { atr, rvol, resistance }, SHORT: { atr, rvol, support } }
  // satu perhitungan indikator untuk kedua arah; support = swing low terkonfirmasi terakhir (tanpa lookahead)
isTerminal(state) → boolean
DEFAULT_SIGNAL_PARAMS = { earlyMinScore: 60, momentumAtrMultiple: 1, momentumRvol: 1.5, breakoutRvol: 2,
  expiryBars: { QUIET: 48, EARLY_BULLISH: 36, MOMENTUM_BUILDING: 24, BREAKOUT: 12, EARLY_BEARISH: 36, BREAKDOWN: 12 } }
LONG_PATTERN_STATES  = QUIET, EARLY_BULLISH, MOMENTUM_BUILDING, BREAKOUT
SHORT_PATTERN_STATES = QUIET, EARLY_BEARISH, MOMENTUM_BUILDING, BREAKDOWN
PATTERN_STATES = gabungan state terbuka kedua arah (urutan LONG dulu); PATTERN_STATES_BY_DIRECTION = { LONG, SHORT }
ALERT_STATES (LONG) / SHORT_ALERT_STATES = EARLY_BEARISH, MOMENTUM_BUILDING, BREAKDOWN; ALERT_STATES_BY_DIRECTION
STATE_RANK: EARLY_BEARISH = EARLY_BULLISH (2), BREAKDOWN = BREAKOUT (4)

SignalSnapshot = { direction, state, classification, patternKey, patternVersion, firstDetectedAt, firstDetectedPrice,
  invalidationPrice, patternScore, earlyScore, alignment, riskFlags, lastCandleTime, barsInState,
  peakPrice, peakState }
  // direction 'LONG'|'SHORT' (snapshot lama tanpa direction = LONG). SHORT: invalidationPrice di atas harga,
  // peakPrice = harga terendah (ekskursi searah sinyal).
SignalEvent = { fromState, toState, candleTime, price, reason }

buildSignalView({ symbol, timeframe, patterns, context, liquidity, dataQuality, params })
  → { symbol, timeframe, direction, classification, alignment, patternScore, earlyScore, riskFlags,
      explanation: [{ factor, contribution, detail }] }
  // direction = arah `patterns`. SHORT: skor dari SD/PVD (aturan pemilihan sama dengan SA/PVA), baris penjelasan
  // CONTEXT:DIRECTION (kontribusi 0), COUNTERTREND_HTF = HTF bullish. context.alignment wajib relatif terhadap arah.

createSignalRepository(db, { clock }) → {
  // `direction` opsional di setiap method per seri: tidak diberikan = 'LONG' (pemanggil lama); nilai lain → RangeError.
  ensurePatternDefinition({ key, version, name, definition, status = 'active', now }),
  getOpen({ symbol, timeframe, direction? }): Promise<SignalSnapshot|null>,
  save({ symbol, timeframe, snapshot, event, explanation, now }): Promise<{ id, opened, closed, saved }>,
      // arah = snapshot.direction (tidak ada = LONG); klasifikasi & state wajib milik arah itu (RangeError).
      // OPEN_SIGNAL_EXISTS hanya untuk sinyal terbuka arah yang SAMA (LONG & SHORT satu seri boleh terbuka bersamaan).
      // satu transaksi: sinyal + event + kursor analisis arah itu (analysis_cursors, migrasi 004/005) maju ke snapshot.lastCandleTime.
      // Snapshot dengan state berbeda dari sinyal terbuka tanpa event → SignalRepositoryError STATE_CHANGE_WITHOUT_EVENT.
      // Snapshot NO_PATTERN/NONE atau terminal tanpa event → no-op (saved: false).
  lastEventCandleTime({ symbol, timeframe, direction? }): Promise<number|null>,   // MAX signal_events.candle_time seri × arah
  lastEvaluatedCandleTime({ symbol, timeframe, direction? }): Promise<number|null>,
      // openTime candle terakhir yang sudah dievaluasi = max(kursor analisis, candle event terakhir) — fallback event
      // agar DB sebelum migrasi 004 tetap bekerja. Titik awal replay pipeline (§8).
  markEvaluated({ symbol, timeframe, openTime, now? = clock(), direction? }): Promise<{ advanced: boolean }>,
      // kursor untuk candle yang tidak menyimpan apa pun (mis. NO_PATTERN); hanya maju (nilai lama/sama diabaikan);
      // simbol belum terdaftar → UNKNOWN_SYMBOL
  closeOpenForSymbol({ symbol, timeframes? = null /* semua */, reason, at })
    : Promise<{ closed: [{ id, timeframe, fromState, price }] }>,
      // Menutup sinyal terbuka KEDUA arah (LONG & SHORT); bentuk hasil tidak berubah (tanpa field direction).
      // reason ∈ MONITORING_STOP_REASONS = ['SYMBOL_DELISTED', 'MONITORING_STOPPED'] (signals/params.js).
      // Satu transaksi: state → EXPIRED, closed_at = updated_at = at, final_outcome 'EXPIRED:<peakState>',
      // event { occurredAt: at, candleTime: candle terakhir yang dievaluasi, price: close candle tersimpan
      // terakhir | null, detail: { reason, barsInPrevState, firstDetectedPrice, invalidationPrice, priceCandleTime } }.
  listOpenSeries(): Promise<Array<{ symbol, timeframe }>>,
      // pasangan simbol × timeframe yang masih punya sinyal terbuka (arah apa pun), tanpa duplikat, urut simbol lalu timeframe
      // (rekonsiliasi level-triggered scanner)
  listActive({ direction = 'LONG', timeframe?, classification?, state?, alignment?, minScore?, limit = 200 (1..500) }),
      // SATU arah (default LONG = perilaku lama); classification ∈ SA/PVA/SD/PVD/BOTH dan state ∈ PATTERN_STATES —
      // nilai milik arah lain menghasilkan [] (bukan error). Setiap baris memuat `direction`.
      // hanya state aktif; alignment ∈ ALIGNMENTS (alignment null tidak dapat dipilih sebagai filter, tetapi tampil
      // tanpa filter); semua filter diterapkan SEBELUM LIMIT; urut pattern_score DESC, updated_at DESC, id DESC.
      // Nilai tidak valid / limit > 500 → RangeError (tidak dipotong); kunci filter tak dikenal → TypeError.
  history({ symbol?, limit = 50 (1..500), direction? = null }),       // termasuk events[]; urut first_detected_at DESC, id DESC
      // direction null = kedua arah (perilaku lama); 'LONG'/'SHORT' = satu arah. Setiap baris memuat `direction`.
}
```

Tabel transisi lengkap (kondisi, reason, kapan alert) didokumentasikan di kepala `backend/signals/stateMachine.js` dan diuji di `tests/unit/signals/`. Satu-satunya transisi di luar `transition()` adalah penutupan sinyal simbol yang berhenti dipantau (`EXPIRED` dengan reason `SYMBOL_DELISTED`/`MONITORING_STOPPED`, tanpa alert) lewat `closeOpenForSymbol`, karena simbol tersebut tidak lagi menerima candle sehingga `NO_PROGRESS` tidak akan pernah tercapai. Ringkasnya: transisi maju hanya ke peringkat lebih tinggi (tanpa downgrade, sehingga alert untuk state yang sama tidak berulang), satu transisi per candle baru, candle duplikat/lama idempoten, `INVALIDATED` bila close < harga invalidasi, `EXPIRED` bila tidak ada kemajuan selama `expiryBars[state]` bar. Setelah gap data, sinyal yang sudah jatuh tempo **di dalam gap** (`barsInState − 1 ≥ expiryBars[state]`) di-`EXPIRED` (`NO_PROGRESS`, tanpa alert) lebih dulu — sebelum pemeriksaan invalidasi dan kemajuan — dan setiap event pada candle pasca-gap memuat `detail.gapBars` (jumlah candle yang hilang).

**Arah SHORT** (Short Scanner) — cermin LONG; parameter, urutan pemeriksaan, aturan gap, expiry, dan tanpa-downgrade sama. Kandidat riset, bukan rekomendasi jual/short:

| State SHORT | Kondisi masuk | reason |
|---|---|---|
| `NO_PATTERN` | tidak ada sinyal SHORT terbuka (tidak dipersistensi); juga bila SD/PVD terdeteksi tetapi close ≥ `invalidationPrice` pola | (tanpa event) |
| `QUIET` | SD/PVD terdeteksi, `earlyScore` < `earlyMinScore` | `PATTERN_DETECTED` |
| `EARLY_BEARISH` | SD/PVD terdeteksi dengan `earlyScore` ≥ `earlyMinScore` (langsung, atau naik dari `QUIET`) | `PATTERN_DETECTED_EARLY` / `EARLY_SCORE_THRESHOLD` |
| `MOMENTUM_BUILDING` | dari `QUIET`/`EARLY_BEARISH`: close ≤ `firstDetectedPrice` − `momentumAtrMultiple` × ATR, atau RVOL ≥ `momentumRvol` dengan close < `firstDetectedPrice` | `PRICE_ATR_DECLINE` / `RVOL_EXPANSION` |
| `BREAKDOWN` | dari `QUIET`/`EARLY_BEARISH`/`MOMENTUM_BUILDING`: close < support **dan** < `firstDetectedPrice` (close < min(support, `firstDetectedPrice`)) dengan RVOL ≥ `breakoutRvol`; support = swing low terkonfirmasi terakhir | `BREAKDOWN_CONFIRMED` |
| `INVALIDATED` | terminal: close > `invalidationPrice` (level di atas harga) | `CLOSE_ABOVE_INVALIDATION` |
| `EXPIRED` | terminal: tanpa kemajuan selama `expiryBars[state]` bar (`EARLY_BEARISH` 36, `BREAKDOWN` 12), jatuh tempo di dalam gap, atau simbol berhenti dipantau | `NO_PROGRESS` / `SYMBOL_DELISTED` / `MONITORING_STOPPED` |

Alert SHORT saat masuk `EARLY_BEARISH`, `MOMENTUM_BUILDING`, atau `BREAKDOWN`, dan saat `INVALIDATED` bila state sebelumnya state alert SHORT. `invalidationPrice` SHORT hanya boleh **turun** (dari pola utama versi sama yang masih terdeteksi dan masih di atas close); `peakPrice` = harga terendah; pola utama seri → SD. Event SHORT memuat `detail.support` (LONG tetap `detail.resistance`). Sinyal LONG dan SHORT pada simbol × timeframe yang sama independen — masing-masing punya state, event, dan kursor analisis sendiri. Alignment selalu relatif terhadap arah sinyal.

**Migrasi 005** (`backend/database/migrations/005_signal_direction.sql`; diterapkan `npm run migrate`, server, dan worker saat start):

- `signals.direction` TEXT NOT NULL DEFAULT `'LONG'` CHECK `('LONG', 'SHORT')`; **semua baris lama menjadi `LONG`** (id dipertahankan). CHECK klasifikasi diperluas dengan `SD`/`PVD`, CHECK state dengan `EARLY_BEARISH`/`BREAKDOWN`, plus CHECK lintas kolom: LONG hanya `SA`/`PVA`/`BOTH` tanpa state khusus SHORT; SHORT hanya `SD`/`PVD`/`BOTH` tanpa state khusus LONG.
- `idx_signals_one_open` UNIQUE `(symbol_id, timeframe, direction) WHERE closed_at IS NULL`: paling banyak satu sinyal terbuka per simbol × timeframe × arah (penjaga terakhir di bawah `OPEN_SIGNAL_EXISTS` repositori). Database yang melanggar invarian itu (dua sinyal terbuka pada seri yang sama) membuat migrasi gagal dan di-rollback seluruhnya, bukan diperbaiki diam-diam.
- `analysis_cursors` berkunci `(symbol_id, timeframe, direction)`; kursor lama menjadi kursor LONG. Arah SHORT belum punya kursor, sehingga evaluasi SHORT pertama setelah upgrade hanya memakai candle terakhir (bootstrap, tanpa replay histori).
- `signals`, `signal_events`, dan `analysis_cursors` dibangun ulang (CHECK tidak dapat diubah lewat ALTER TABLE) dalam satu transaksi dengan foreign key aktif: `signal_events` disalin lalu dihapus **sebelum** `signals`, agar `ON DELETE CASCADE` dari DELETE implisit DROP TABLE tidak menghapus event. Indeks 002/004 dibuat ulang dengan nama yang sama (riwayat satu arah memakai `INDEXED BY idx_signals_first_detected` / `idx_signals_symbol_first_detected`).

Skor **bukan probabilitas**. `patternScore` = jumlah bobot kondisi yang lulus (§6); `earlyScore` = seberapa dini posisi harga (jarak dari awal struktur dalam ATR dan umur struktur, §6). Konteks HTF, likuiditas 24 jam (ticker), dan kualitas data seri hanya menambah risk flag dan baris penjelasan di `buildSignalView` — tidak mengubah skor. Pengecualian yang disengaja: kondisi pola SA `liquidity` (quote volume rata-rata per candle di jendela pola) adalah kondisi berbobot 5 di `patternScore`.

## 8. Pipeline analisis — `backend/analysis/pipeline.js`

```
ANALYSIS_LOOKBACK = 300
REPLAY_LIQUIDITY_DETAIL = 'Data likuiditas tidak tersedia untuk candle historis (replay): …'   // teks penjelasan
assessSeriesQuality(candles, timeframe) → { ok, issues: ['UNCLOSED_CANDLE'|'MIXED_SERIES'|'GAP:n', …] }
analyzeAt({ symbol, timeframe, candlesByTimeframe, prev, liquidity, dataQuality, params, direction? = 'LONG' })   // MURNI
  → { direction, evaluationTime, patterns, context, view, market, next, event, alert } | null (tanpa candle dasar)
  // params = { sa?, pva?, sd?, pvd?, signals?, view?: { minQuoteVolume24h?, maxSpreadBps? } }
  // direction SHORT: pola SD/PVD (params.sd/pvd), alignment relatif SHORT, market { atr, rvol, support };
  // prev wajib sinyal SHORT. Tanpa direction = LONG (perilaku lama).
  // params.view diteruskan ke buildSignalView (ambang risk flag likuiditas; default DEFAULT_VIEW_PARAMS)
  // konteks HTF memakai default buildTimeframeContext (maxStaleBars 1, settleWindowMs 60 000)
analyzeDirectionsAt({ symbol, timeframe, candlesByTimeframe, prevByDirection = {}, liquidity, dataQuality, params,
  directions = DIRECTIONS })   // MURNI
  → { LONG?: hasil analyzeAt, SHORT?: hasil analyzeAt } | null (tanpa candle dasar)
  // kualitas seri, trend per timeframe, dan input pasar dihitung SEKALI untuk semua arah; hasil tiap arah identik
  // dengan analyzeAt({ ..., direction }). directions: array tidak kosong (TypeError), tanpa arah ganda/asing (RangeError).
patternDefinitions(params, { maxWarmup?, directions? = ['LONG'] })
  → [{ key: 'SA'|'PVA'|'SD'|'PVD', version, name, definition: { params, conditions, requiredCandles } }]
  // maxWarmup diteruskan ke resolveParams: parameter dengan warm-up > min(maxWarmup, 300) → PatternParamsError
  // LONG: bentuk definisi tidak berubah. SHORT: version = SHORT_PATTERN_VERSION; definition + { direction: 'SHORT',
  // mirrorOf: { pattern: 'SA'|'PVA', version: PATTERN_VERSION } }.
createAnalysisPipeline({ repos, signals, getLiquidity, logger, params, lookback = 300 (100..1500),
  maxReplay = 288 (1..5000), settleMs = 0 (0..30000), sleep, onAlert,
  yieldEvery = 25 (1..5000), yieldToEventLoop = setImmediate (node:timers/promises), directions = ['LONG'] })
  → { ensureDefinitions(), onClosedCandles({ symbol, timeframe, candles, reason }),
      closeSymbol({ symbol, timeframes? = null, reason, at }) → signals.closeOpenForSymbol(...), directions }
  // Saat konstruksi: patternDefinitions(params, { maxWarmup: lookback, directions }) — parameter pola yang warm-up-nya
  // melebihi lookback ditolak PatternParamsError (bukan pola yang diam-diam selalu insufficientData).
  // directions: default ['LONG'] (perilaku lama); worker (assembleWorker, §4) memakai ['LONG', 'SHORT'].
  // onClosedCandles → { symbol, timeframe, direction, evaluationTime, state, evaluated, classification, event, alert,
  //     directions: { [arah]: { state, classification, event, alert, evaluated } } }
  //   (field tingkat atas = arah utama, LONG bila ikut dievaluasi; evaluated tingkat atas = jumlah candle yang dievaluasi)
  //   atau { symbol, timeframe, skipped: 'NO_DATA' | 'ALREADY_EVALUATED' } (ALREADY_EVALUATED = semua arah sudah).
  // onAlert({ symbol, timeframe, direction, state, event, view }) — per arah, hanya untuk candle terbaru.
  // closeSymbol diserialkan dengan evaluasi yang masih berjalan untuk seri yang sama; menutup kedua arah; tanpa alert.
```

`analyzeAt` / `analyzeDirectionsAt` dipakai bersama oleh worker live dan (nanti) backtest M6, sehingga hasil keduanya identik untuk data yang sama (per arah). `onClosedCandles`:

1. Evaluasi diserialisasi per simbol×timeframe (semua arah dalam satu evaluasi).
2. Memuat `lookback + maxReplay` candle terakhir; titik awal **per arah** = `signals.lastEvaluatedCandleTime` — kursor analisis persisten (`analysis_cursors`, migrasi 004, per arah sejak migrasi 005; fallback candle event terakhir arah itu), di-cache di memori. Candle terbaru ≤ kursor semua arah → `ALREADY_EVALUATED`. Karena kursor juga maju untuk candle tanpa event, restart hanya mengevaluasi candle setelah kursor (DB yang dimigrasi dari sebelum 004 dapat me-replay sekali dari event terakhir per seri).
3. Candle baru diputar ulang berurutan (maks `maxReplay` per arah; pemotongan dicatat sekali di log). Seri/arah tanpa kursor → hanya candle terakhir (bootstrap = histori) — termasuk SHORT pertama kali setelah migrasi 005. Candle yang belum dievaluasi digabung lintas arah: setiap candle dievaluasi sekali untuk arah yang belum mengevaluasinya.
4. Bila `settleMs > 0`, menunggu sekali agar candle HTF yang tutup pada waktu yang sama sempat tersimpan (worker memakai 3 detik).
5. Setiap candle: `getOpen` per arah → `analyzeDirectionsAt` → per arah (LONG dulu) `save` bila ada event atau sinyal terbuka yang snapshot-nya diperbarui (memajukan kursor arah itu dalam transaksi yang sama); arah yang tidak menyimpan apa pun → `markEvaluated` arah itu. Panggilan repositori LONG tidak membawa `direction` (bentuk lama); SHORT membawa `direction: 'SHORT'`. Satu candle = satu slot `yieldEvery`, berapa pun arahnya. **Alert hanya untuk candle terakhir** batch, sehingga backfill tidak membanjiri alert historis. Sebelum setiap candle diambil satu slot dari anggaran `yieldEvery` yang **dibagi seluruh pipeline** (bukan per seri): bila habis, satu `yieldToEventLoop()` dijadwalkan dan semua seri yang kehabisan menunggu jeda yang sama, sehingga timer/heartbeat/WS mendapat giliran setelah ±`yieldEvery` candle total. Anggaran di-reset saat jeda berjalan atau saat tidak ada evaluasi yang berjalan.
6. `getLiquidity(symbol)` (worker: `scanner.liquidityOf`) memberi ukuran likuiditas; bila menyertakan `thresholds`, ambang itu menggantikan `params.view`, sehingga `POOR_LIQUIDITY`/`WIDE_SPREAD` dan baris penjelasan `CONTEXT:LIQUIDITY` memakai batas pengaturan pengguna (penting di mode manual, yang tidak memfilter likuiditas saat discovery). Ukuran itu menggambarkan pasar saat ini, jadi **hanya candle terbaru** batch yang memakainya; candle historis hasil replay dievaluasi dengan likuiditas tidak diketahui (tanpa `POOR_LIQUIDITY`/`WIDE_SPREAD`) dan detail `CONTEXT:LIQUIDITY` = `REPLAY_LIQUIDITY_DETAIL`.

## 9. API — `backend/api/signalRoutes.js`, `backend/api/systemRoutes.js`

Semua route di bawah `/api/` melewati gerbang autentikasi berbasis route (lihat `docs/01-arsitektur.md`). Coercion tipe dimatikan, sehingga query divalidasi sebagai string berpola. Nilai di luar enum/pola, parameter tak dikenal, dan parameter ganda (array) → **400 `VALIDATION_ERROR`**.

| Endpoint | Query | Respons |
|---|---|---|
| `GET /api/signals/active` | `direction` (LONG/SHORT, default LONG), `timeframe`, `classification` (SA/PVA/SD/PVD/BOTH; klasifikasi arah lain → daftar kosong), `state` (state aktif kedua arah: QUIET, EARLY_BULLISH, MOMENTUM_BUILDING, BREAKOUT, EARLY_BEARISH, BREAKDOWN; state arah lain → daftar kosong), `alignment` (ALIGNED/PARTIALLY_CONFIRMED/UNCONFIRMED/COUNTERTREND), `minScore` (bilangan bulat 0–100, `pattern_score ≥`), `limit` (1–500, default 200; > 500 → 400, tidak dipotong) | `{ items: [...], count }` — `items` = `listActive` satu arah (setiap baris memuat `direction`) + `lastPrice`, `lastCandleAt` (null bila belum ada candle) per baris; `count` = `items.length` (bukan total) |
| `GET /api/signals/history` | `symbol` (`^[A-Z0-9]{2,30}$`), `direction` (LONG/SHORT; tanpa = kedua arah), `limit` (1–500, default 100) | `{ items: [...], count }` dengan `direction` dan `events[]` per sinyal |
| `GET /api/system/status` | — | status proses API + `scanner`, `binance`, `ingestion` dari `summarizeWorker` |
| `GET /api/overview` | — | ringkasan (`monitoredSymbols`; `activeSignals`/`earlySignals`/`alignedSignals` tetap bermakna LONG; `activeByDirection`/`earlyByDirection`/`alignedByDirection` = `{ LONG, SHORT }`; `recentDetections` kedua arah dengan `direction`) + `scanner`, `binance`, `marketContext` (BTC/ETH 1h) |

Nilai `direction` di luar LONG/SHORT → 400. Sinyal SHORT adalah kandidat riset (struktur bearish), bukan rekomendasi jual/short; API tidak pernah mengeksekusi order. Filter `alignment` diterapkan di server sebelum `LIMIT`. Screener mengirim semua filter ke server dengan `limit=500`; karena API tidak memberi total, `count` = 500 hanya berarti batas tercapai — UI menampilkan `≥ 500 hasil` dan callout "hasil mungkin terpotong", bukan klaim ada sisa.

`backend/system/workerStatus.js` — `summarizeWorker(ingestion, now)` membaca heartbeat di database; `now` = `Date.now()` proses API, sehingga `heartbeat.at` (dan `lastIngestionAt`, `lastRun`, `recentErrors[].at`) wajib distempel jam lokal host oleh worker (`localClock` scanner), bukan waktu server Binance. Heartbeat lebih tua dari 90 detik → `stale`; tanpa heartbeat → `not_running` (tidak pernah angka palsu). `scanner.clockOffsetMs` (angka atau null) dan `scanner.clockFault` (hanya `'OFFSET_OUT_OF_RANGE'` atau null) diteruskan dari heartbeat; System Health menampilkan offset atau peringatan NTP; `streams` termasuk seri konteks HTF.

`backend/system/marketContext.js` — `buildMarketContext(candles, symbols = ['BTCUSDT', 'ETHUSDT'])` → `classifyTrend` pada 120 candle 1h terakhir per simbol:

```
tanpa candle      → { symbol, status: 'no_data' }
selain itu        → { symbol, status: 'ok' | 'insufficient_data', timeframe: '1h', lastPrice, asOf, change24h,
                      trend /* null bila insufficient_data */, reasons, candleCount }
  // insufficient_data = classifyTrend memberi INSUFFICIENT_DATA (< warm-up); harga/asOf/change24h tetap dari candle nyata.
  // Overview menampilkan trend null sebagai "Trend tidak tersedia" bernada peringatan, tidak pernah badge NEUTRAL.
```

## 10. Administrasi pengguna — `backend/users/`

Dipanggil oleh CLI (`scripts/create-user.js`, `scripts/change-password.js`) dan oleh entry point server (`backend/app/server.js`, setelah `buildApp` menjalankan migrasi). `buildApp` sendiri tidak pernah membuat pengguna, sehingga harness tes & E2E tidak terpengaruh. Kegagalan validasi → `UserAdminError(message, code)` (pesan Bahasa Indonesia, aman ditampilkan di CLI; `code` untuk pemanggil, mis. `'username_taken'`, `'limit_reached'`, `'users_exist'`, atau alasan audit `changePassword`).

CLI berjalan sebagai proses terpisah dari server, dan Argon2 (≥ 100 ms) adalah titik `await` yang panjang. Karena itu setiap keputusan "baca lalu tulis" diambil ulang **atomik di repositori** sesudah Argon2, bukan dari hasil baca sebelum hash.

```
// backend/users/userAdmin.js
createUser({ users, audit, hasher, maxUsers, clock }, { username, password, role, via = 'cli', requireEmpty = false }) → id
  // username ^[A-Za-z0-9_.-]{3,32}$, role ∈ ROLES ('admin'|'analyst'), checkPasswordPolicy; cek awal username/batas
  // hanya untuk gagal cepat. Hash Argon2id LEBIH DULU, lalu users.createWithLimit (atomik) memutuskan:
  // username_taken → 'Username sudah dipakai' | limit_reached → 'Batas N pengguna sudah tercapai'
  // | not_empty (requireEmpty) → code 'users_exist'. Audit user.create success { role, via }  (via: 'cli' | 'default')
changePassword({ users, sessions, audit, hasher, clock }, { username, password, via = 'cli' })
  → { userId, revokedSessions }
  // Pengguna tidak dikenal → 'Pengguna tidak ditemukan'; checkPasswordPolicy (konteks username tersimpan);
  // sama dengan kata sandi saat ini → ditolak. Sukses: users.updatePassword lalu
  // sessions.revokeAllForUser(userId, { reason: 'password_change' }) — SEMUA sesi pengguna itu. Login yang sedang
  // berjalan dengan kata sandi lama ditolak oleh pemeriksaan hash atomik saat insert sesi (lihat di bawah).
  // Audit user.password_change: success { via, revokedSessions } | failure { reason: 'unknown_user'|'policy'|'unchanged', via }.
  // Kata sandi tidak pernah masuk audit.

// backend/database/repositories/userRepository.js (async; SQLite: transaksi better-sqlite3 BEGIN IMMEDIATE)
users.createWithLimit({ username, passwordHash, role, now, maxUsers, requireEmpty = false })
  → { created: true, id } | { created: false, reason: 'not_empty' | 'limit_reached' | 'username_taken' }
  // COUNT + INSERT satu transaksi IMMEDIATE; SQLITE_CONSTRAINT_UNIQUE → username_taken (tidak pernah SqliteError mentah).
  // PostgreSQL: kunci (advisory/tabel) di transaksi yang sama sebelum COUNT.
users.updatePasswordIfUnchanged(id, { expectedHash, passwordHash, now }) → boolean
  // Compare-and-swap: UPDATE ... WHERE id = @id AND password_hash = @expectedHash. Dipakai rehash saat login.
users.create(row) → id   // insert tanpa batas, hanya untuk fixture tes

// backend/database/repositories/sessionRepository.js
sessions.createIfPasswordUnchanged(row, { passwordHash }) → id | null
  // SELECT users.password_hash + INSERT sesi satu transaksi IMMEDIATE; null bila hash sudah berbeda / pengguna tidak ada.
  // PostgreSQL: SELECT ... FOR UPDATE pada baris users di transaksi yang sama.

// backend/auth/sessionService.js
sessionService.create(userId, { ip, userAgent, passwordHash? }) → { id, token, csrfToken, expiresAt, idleExpiresAt } | null
  // Tanpa passwordHash: insert biasa. Dengan passwordHash (login): lewat createIfPasswordUnchanged; null = kata sandi diganti.

// backend/auth/authService.js — login()
  // verify(hash lama) → bila needsRehash: hash baru lalu users.updatePasswordIfUnchanged (CAS; gagal → tetap hash lama)
  // → sessionService.create(..., { passwordHash: hash yang diverifikasi/di-rehash }) → null ⇒ gagal seperti
  // kata sandi salah (recordFailedLogin + penguncian, audit auth.login failure { reason: 'bad_password', passwordChanged: true },
  // respons 401 LOGIN_FAILED generik) → sukses: recordSuccessfulLogin + audit. Urutan ganti kata sandi (hash baru LALU
  // revokeAllForUser) + pemeriksaan atomik ini menjamin tidak ada sesi berkata sandi lama yang tersisa.

// backend/users/defaultUser.js
DEFAULT_CREDENTIALS = { username: 'admin', password: 'admin123@', role: 'admin' }   // frozen; pilihan pemilik, TIDAK lolos checkPasswordPolicy
LEGACY_DEFAULT_PASSWORDS = ['alphalens-demo']   // default versi sebelumnya, tetap diperiksa penjaga paparan
// createUser(deps, { ..., skipPasswordPolicy = false }) — hanya ensureDefaultUser yang menyetel true; CLI tidak pernah.
isLoopbackHost(host) → boolean            // hanya '127.0.0.1', '::1', 'localhost' (trim, tanpa beda huruf)
exposureOf(config) → null | { reason, detail }   // null = hanya lokal; urutan cek & reason:
  // 'production' (NODE_ENV) → 'non_loopback_host' (HOST) → 'non_loopback_origin' (hostname APP_ORIGIN) → 'behind_proxy' (TRUST_PROXY)
ensureDefaultUser({ users, audit, hasher, maxUsers, clock,
                    config: { nodeEnv, host, appOrigin, trustProxy, defaultUser }, log: { info, warn } })
  → { created: true, id }
  | { created: false, reason: 'disabled'|'not_development'|'users_exist'|'non_loopback_host'|'non_loopback_origin'|'behind_proxy' }
  // Urutan: (1) exposureOf ≠ null → DefaultUserError bila 'admin' aktif & masih berkata sandi default (server.js exit 1);
  // (2) !defaultUser → disabled; (3) nodeEnv ≠ development → not_development (+ warn);
  // (4) users.count() > 0 → users_exist (tanpa menyentuh akun) + satu log.info netral: jumlah pengguna dan cara
  //     ganti kata sandi dengan placeholder `<nama>` — tanpa username; (5) exposureOf ≠ null → reason-nya (+ warn);
  // (6) createUser(..., via: 'default', requireEmpty: true) + satu log.warn berisi username, kata sandi, dan cara
  //     menggantinya. Bila proses lain (user:create, instance server kedua) membuat pengguna selama Argon2
  //     (code 'users_exist' / 'username_taken') → users_exist + log.info yang sama, tanpa akun default.
  // Idempoten lintas restart.
```

`config.defaultUser` (`loadConfig`): `DEFAULT_USER` kosong → `nodeEnv === 'development'`; `'true'`/`'false'` eksplisit; nilai lain → `ConfigError`; `true` dengan `NODE_ENV=production` → `ConfigError`.

## 11. Kontrol scanner dari website — `backend/system/workerSupervisor.js`, `backend/api/workerRoutes.js`

Tujuan: cukup `npm start`, lalu admin menekan **Jalankan scanner** di System Health. Server menjalankan `worker/index.js` sebagai **child process terpisah** (`child_process.fork`); scanner tidak pernah berjalan di dalam proses server. `npm run worker` di terminal lain tetap didukung, tetapi tidak boleh bersamaan dengan worker dari website.

```
WORKER_SCRIPT_PATH = <repo>/worker/index.js   // path absolut tetap di kode
STOP_TIMEOUT_MS = 15_000   START_TIMEOUT_MS = 10_000   MAX_LINE_LENGTH = 16_384   RESTART_COOLDOWN_MS = 10_000
WORKER_STATES = ['stopped', 'starting', 'running', 'stopping', 'crashed', 'external']

createWorkerSupervisor({ fork = child_process.fork, scriptPath = WORKER_SCRIPT_PATH /* wajib absolut */,
  env = process.env /* disnapshot saat dibuat */, logger, clock = Date.now, stopTimeoutMs, startTimeoutMs,
  readExternalHeartbeat = async () => null /* { at, state } | null */, output = baris → stdout server,
  maxLineLength, restartCooldownMs = RESTART_COOLDOWN_MS /* int ≥ 0; 0 hanya tes/E2E */,
  isPidAlive = isProcessAlive, hostname = os.hostname(), setTimer, clearTimer })
  → {
    status({ heartbeat? }) → Promise<{ state, startedAt, stoppedAt, exitCode, signal }>
      // Tanpa child (stopped/crashed) + heartbeat segar (isHeartbeatLive) yang BUKAN milik child server ini
      // → state 'external'. Bukan worker luar bila: at ≤ waktu keluar child terakhir (milik child tsb), ATAU
      // state.owner.host === hostname dan owner.pid (int > 0) tidak hidup lagi (isPidAlive) — mis. child server
      // sebelumnya yang dibunuh (SIGKILL/OOM/SIGHUP) sebelum heartbeat akhir; lastExitAt hanya di memori, jadi
      // tanpa pid heartbeat itu memblokir start & autostart ≤ 90 detik setelah server restart. Owner tanpa host
      // yang cocok / pid tidak valid → tidak diperiksa, tetap 'external' (aman). Pid yang dipakai ulang proses
      // lain → tetap 'external' sampai heartbeat basi.
    start() → Promise<status>          // resolve setelah event 'spawn' (state 'running')
      // Ditolak WORKER_COOLDOWN (429, err.retryAfterMs) bila child yang SEMPAT berjalan (event spawn) keluar —
      // stop maupun crash — kurang dari restartCooldownMs lalu. Spawn gagal tidak memicu jeda.
    stop({ wait = true }) → Promise<status>   // SIGTERM; SIGKILL bila belum keluar setelah stopTimeoutMs
    shutdown() → Promise<void>         // tolak start baru, tunggu start berjalan, lalu stop(); idempoten
    killChild(signal = 'SIGKILL') → boolean   // sinkron, untuk handler process 'exit' / keluar paksa
  }
createLineForwarder(write, maxLength) → { push(chunk), flush() }
  // Baris > maxLength: dipotong + ' …[dipotong]', sisa dibuang sampai newline; CR akhir baris dibuang. Dibuang juga:
  // kontrol C0 kecuali tab (U+0000–U+0008, U+000B–U+001F), DEL & C1 (U+007F–U+009F: CSI U+009B, ST U+009C, OSC U+009D
  // dijalankan terminal UTF-8), serta kontrol bidi (U+061C, U+200E/F, U+202A–U+202E, U+2066–U+2069). Teks dari
  // Binance (mis. `msg` error HTTP) tidak dapat membersihkan layar, mengubah judul, atau menulis clipboard (OSC 52).
isProcessAlive(pid) → boolean   // process.kill(pid, 0): ESRCH → false; EPERM/lainnya → true; pid ≤ 0 → false tanpa sinyal;
  // Linux: state /proc/<pid>/stat 'Z'/'X' (zombie: sudah keluar, belum di-reap — mis. induknya ikut dibunuh) → false
WorkerSupervisorError { code, statusCode, message /* Bahasa Indonesia */, retryAfterMs? /* WORKER_COOLDOWN */ }
```

Transisi: `stopped|crashed → starting` (klaim sinkron sebelum await pertama, sehingga start bersamaan ditolak) `→ running` (event `spawn`) `→ stopping` (stop) `→ stopped`. Child keluar tanpa diminta: kode 0 → `stopped` (mis. Ctrl+C di terminal `npm start` juga mengirim SIGINT ke child), selain itu → `crashed` dengan `exitCode`/`signal`. Tidak ada restart otomatis. Spawn gagal (fork melempar, `error` sebelum `spawn`, keluar sebelum `spawn`, atau tanpa `spawn` dalam `startTimeoutMs` → SIGKILL) → `crashed` + `WORKER_SPAWN_FAILED`.

`fork(scriptPath, [], { env: snapshot, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })`: argv selalu kosong; `execArgv: []` agar flag server (mis. `--watch` dari `npm run dev`) tidak diwariskan. Baris stdout & stderr child diteruskan ke stdout server (log JSON worker tetap terlihat di terminal `npm start`).

| Kode | HTTP | Kapan |
|---|---|---|
| `WORKER_ALREADY_RUNNING` | 409 | start saat starting/running |
| `WORKER_STARTING` | 409 | stop saat starting |
| `WORKER_STOPPING` | 409 | start saat stopping (stop kedua saat stopping = idempoten) |
| `WORKER_EXTERNAL` | 409 | start/stop saat worker lain (heartbeat segar) berjalan di luar website |
| `WORKER_NOT_RUNNING` | 409 | stop tanpa worker |
| `WORKER_COOLDOWN` | 429 | start < `RESTART_COOLDOWN_MS` setelah child yang sempat berjalan keluar; route mengirim `Retry-After` (detik, dibulatkan ke atas) |
| `WORKER_SHUTTING_DOWN` | 503 | start setelah `shutdown()` |
| `WORKER_SPAWN_FAILED` | 500 | child gagal dijalankan |
| `WORKER_CONTROL_DISABLED` | 503 | route start/stop saat `WORKER_CONTROL=false` |

API (gerbang autentikasi & CSRF standar, lihat `docs/01-arsitektur.md` §4):

| Endpoint | Peran | Respons |
|---|---|---|
| `GET /api/system/worker` | semua pengguna terautentikasi | `{ enabled, state, startedAt, stoppedAt, exitCode, signal }` |
| `POST /api/system/worker/start` | admin + `X-CSRF-Token` | 200 status (`running`) · 409/429/500/503 `{ error, message }` |
| `POST /api/system/worker/stop` | admin + `X-CSRF-Token` | 200 status (`stopping`, tidak menunggu exit) · 409/429/503 |
| `GET /api/system/status` | semua | `+ workerControl` (bentuk sama dengan `GET /api/system/worker`, memakai heartbeat yang sudah dibaca) |

Body/query start/stop diabaikan. Rate limit khusus route `WORKER_ACTION_RATE_LIMIT = { max: 10, timeWindow: 60_000 }` per IP untuk masing-masing POST (menggantikan batas global 300/menit; 429 `RATE_LIMITED`). Audit `worker.start` / `worker.stop` untuk setiap POST dari sesi yang dikenali:

| Kasus | `outcome` | `detail` |
|---|---|---|
| berhasil | `success` | `{ state }` |
| ditolak supervisor / kontrol nonaktif | `failure` | `{ reason: <kode tabel di atas> }` |
| ditolak gerbang authPlugin (analyst 403, token CSRF hilang/salah 403) | `failure` | `{ reason: 'FORBIDDEN' \| 'CSRF_INVALID' }` — dicatat hook `onSend` tingkat route (tanpa mengubah authPlugin) |
| error tak terduga (mis. `SQLITE_BUSY` saat membaca heartbeat) | `failure` | `{ reason: 'INTERNAL_ERROR' }`, lalu error dilempar ulang → 500 generik |

Tidak tercatat (tidak ada pengguna yang dikenali): tanpa sesi (401), Origin/`Sec-Fetch-Site` lintas situs (403 dari `registerRequestGuards`, sebelum sesi dibaca), dan rate limit (429). Respons tidak memuat pid, path, env, atau log.

Perakitan (`buildApp`): supervisor dibuat dengan `scriptPath = WORKER_SCRIPT_PATH`, `env = { ...process.env, DATABASE_PATH: config.databasePath }`, `readExternalHeartbeat = repos.ingestion.getStatus().heartbeat`. Opsi `workerSupervisor` / `workerScriptPath` / `workerRestartCooldownMs` hanya untuk tes & E2E (kode), tidak pernah dari env atau request (server E2E memakai jeda 0 karena desktop & mobile berbagi satu server). `WORKER_AUTOSTART=true` + `WORKER_CONTROL` aktif → `start()` di hook `onReady` (audit `worker.start` tanpa user, `detail.via = 'autostart'`); autostart tanpa kontrol → diabaikan + peringatan log. Hook `onClose` → `shutdown()`.

Penutupan server (`backend/app/server.js`): SIGINT/SIGTERM/SIGHUP (jendela terminal ditutup) → `supervisor.shutdown()` (SIGTERM → ≤ 15 detik → SIGKILL) → `app.close()`; keluar paksa setelah `STOP_TIMEOUT_MS + 5 detik` dengan `killChild('SIGKILL')` lebih dulu. Handler `process.on('exit')` mengirim SIGTERM ke child yang tersisa. Bila server mati tanpa sempat menjalankan handler (SIGKILL/OOM), `worker/index.js` mendeteksi kanal IPC terputus (`process.on('disconnect')`, hanya bila dijalankan dengan IPC) dan berhenti dengan graceful; error tulis stdout/stderr (EPIPE ke server yang sudah mati) diabaikan agar shutdown itu selesai.

Konfigurasi (`loadConfig`): `WORKER_CONTROL` kosong → `nodeEnv === 'development'`; `WORKER_AUTOSTART` kosong → `false`; nilai selain `'true'`/`'false'` → `ConfigError` (`"<NAMA> harus 'true' atau 'false'"`).

Frontend: `frontend/js/views/workerControl.js` — kartu **Kontrol scanner** (System Health; dibuat sekali, auto-refresh 10 detik hanya memanggil `update()`) dan callout ringkas Overview (`canStartWorker`: kontrol aktif & state `stopped`/`crashed`). Label di `workerFormat.js` (`workerControlLabel`): Berjalan / Berhenti / Memulai… / Menghentikan… / Gagal (kode keluar N | sinyal X) / Berjalan di luar website. Tombol hanya untuk admin, nonaktif selama request; stop butuh konfirmasi; state diumumkan lewat `aria-live="polite"`; saat starting/stopping — dan selama `SETTLE_MS` (10 detik) setelah start berhasil, karena 'running' hanya berarti proses sudah di-spawn — UI memantau `GET /api/system/worker` tiap 2 detik dengan `X-LR-Background: 1`, sehingga worker yang crash sesaat setelah start tampil *Gagal* dalam beberapa detik. Callout Overview dirender dari status: setelah start berhasil pesan berganti "Scanner berjalan." (`aria-live`), tombol dilepas dan fokus keyboard dipindah ke pesan (`tabindex="-1"`, tidak jatuh ke `<body>`); callout memantau dengan cara yang sama dan menampilkan pesan crash + tombol lagi bila worker crash.

## 12. Penyimpangan dari draf awal

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
| `isClosed` REST = `closeTime < clock()` (jam dibaca setelah respons); kline final WS divalidasi ketat `now > closeTime` | `CLOSE_MARGIN_MS` (2 detik): `isClosed` REST = `closeTime < closureClock()` saat request dimulai − margin, rencana REST pada `now − margin`; kline final WS sah dalam `WS_CLOCK_TOLERANCE_MS` | Galat sinkronisasi (≤ RTT/2) + drift membuat snapshot candle berjalan tersimpan sebagai tertutup, atau kline final WS ditolak saat jam sedikit tertinggal |
| `OFFSET_OUT_OF_RANGE` hanya dicatat sebagai error `'clock'`, state tetap `running` | `clockFault` + state `degraded`; `serverClock.closureNow()` (batas bawah waktu server dari sampel) untuk `isClosed` REST & rencana REST | Host > 10 menit di depan server menyimpan candle berjalan sebagai tertutup di bootstrap dan setiap sweep |
| Hanya timeframe terpilih yang diingesti | Timeframe terpilih ∪ HTF-nya diingesti; seri konteks saja tidak dianalisis | Tanpa candle HTF (mis. hanya 5m dipilih) alignment & risk flag live berbeda dari replay |
| Discovery 0 simbol diterapkan apa adanya | 0 simbol yang tidak dijelaskan data discovery = discovery gagal (set dipertahankan; hanya simbol delisted yang dilepas); 0 simbol yang sah tetap diterapkan | Respons exchangeInfo/ticker kosong sementara akan melepas semua simbol dan menutup semua sinyal terbuka |
| Sweep reconnect dengan grace `reconnectSweepGraceMs` | Sweep segera (grace = margin) + satu ulangan setelah margin, juga untuk stream yang masih sinkron; sweep `catchup` setelah open pertama | Candle yang tutup tepat sebelum socket terbuka kembali tertunda sampai sweep berkala (±5 menit) |
| Risk flag likuiditas selalu dinilai dengan `DEFAULT_VIEW_PARAMS` | `liquidityOf` menyertakan `thresholds` dari `settings.liquidity`; `analyzeAt` menerima `params.view` | Batas pengguna (terutama mode manual) harus sama dengan batas yang ditampilkan di penjelasan; backtest tetap dapat memberi ambangnya sendiri |
| Likuiditas saat ini dipakai untuk setiap candle batch | Hanya candle terbaru; candle replay = likuiditas tidak diketahui (`REPLAY_LIQUIDITY_DETAIL`) | Ukuran 24 jam saat ini untuk candle historis adalah lookahead |
| `createSignalRepository(db)`; titik awal replay = `lastEventCandleTime` | `+ { clock }`, `lastEvaluatedCandleTime`, `markEvaluated`; kursor `analysis_cursors` (migrasi 004) maju di `save()` | Tes deterministik; candle tanpa event tidak lagi dievaluasi ulang setiap restart |
| Replay berjalan sinkron tanpa jeda | `yieldEvery`/`yieldToEventLoop`, anggaran bersama seluruh pipeline | Replay banyak seri setelah outage menahan timer heartbeat/WS hingga beberapa detik |
| `save()` menerima perubahan state tanpa event | Ditolak `STATE_CHANGE_WITHOUT_EVENT` | `signal_events` tidak boleh tertinggal dari state tersimpan |
| Expiry dinilai setelah kondisi invalidasi/kemajuan | Sinyal yang jatuh tempo di dalam gap `EXPIRED` lebih dulu; event pasca-gap memuat `detail.gapBars` | Setelah outage, sinyal basi dapat dipromosikan/di-alert berdasarkan `firstDetectedPrice` lama |
| Kolom tracking (`barsInState`, `peakPrice`, `lastCandleTime`) di tabel `signals` | Disimpan di `explanation_json.tracking` | Menghindari migrasi skema saat M3; kandidat migrasi `006` (`004` dipakai kursor analisis, `005` arah sinyal; `docs/05-database.md` §6 masih menyebut `005`) |
| `classifyTrend` selalu mengembalikan trend | `classifyTrend` tetap memberi `NEUTRAL` + `INSUFFICIENT_DATA` di bawah warm-up; `buildTimeframeContext` & `buildMarketContext` memetakan tanpa data/HTF basi/data kurang → `trend: null` | Tidak memalsukan konteks (NEUTRAL tampak nyata) saat data tidak cukup |
| HTF tertinggal ≤ `maxStaleBars` bar selalu ditoleransi | Toleransi 1 bar hanya dalam `settleWindowMs` (60 detik) setelah close HTF yang diharapkan | Candle 1h yang hilang sejak lama tetap dibaca sebagai trend dari data yang lebih tua |
| Screener memfilter alignment di klien setelah potongan top-200; `limit` > 500 dipotong diam-diam | Filter `alignment` di server sebelum `LIMIT`; `limit` 1–500 (lebih → 400); screener meminta `limit=500` dan menandai batas tercapai (`≥ 500 hasil`) | Hasil screener diam-diam tidak lengkap |
| `createUser`: hitung → Argon2 → insert; seed default: "tabel kosong" → Argon2 → insert | Argon2 → `users.createWithLimit` (COUNT + INSERT satu transaksi IMMEDIATE, `requireEmpty` untuk seed, UNIQUE → `username_taken`/`users_exist`) | `user:create` bersamaan / seed vs `user:create` melewati `MAX_USERS` atau membuat `admin` padahal pengguna lain sudah ada; seed ganda crash dengan SqliteError UNIQUE |
| Login: verify → rehash tanpa syarat → `sessionService.create` | Rehash compare-and-swap; sesi dibuat hanya bila `password_hash` masih yang diverifikasi (`sessions.createIfPasswordUnchanged`, atomik) | `npm run user:password` selama verifikasi Argon2 login: sesi baru berkata sandi lama lolos dari `revokeAllForUser`, dan rehash dapat menimpa hash baru dengan kata sandi lama |
| Batas simbol 2–30 karakter di semua tempat | Discovery: basis 1–20 + `USDT`; API riwayat: 2–30 | Discovery mengikuti format USDT-M; API menerima simbol lama yang masih tersimpan |
| Pola SHORT dengan detektor & logika sendiri | SD/PVD = detektor SA/PVA atas candle cermin (p → 1/p, high ↔ low), hasil dipetakan ke harga nyata (§6) | Satu sumber logika: perbaikan SA/PVA otomatis berlaku untuk SHORT (wajib menaikkan `SHORT_PATTERN_VERSION`, dijaga `mirrorOf`); konversi perubahan harga & invalidasi eksak, slope EMA/ATR% aproksimasi orde pertama |
| Satu sinyal terbuka per simbol × timeframe | Satu per simbol × timeframe × arah (`idx_signals_one_open`, migrasi 005) | Kandidat LONG dan SHORT adalah hipotesis riset berbeda yang dapat muncul bersamaan pada seri yang sama |
| Kursor analisis per simbol × timeframe | Per simbol × timeframe × arah | `save()`/`markEvaluated()` per arah: crash di antara simpan LONG dan SHORT tidak membuat satu arah melompati candle |
| Field ringkasan overview menghitung semua sinyal | `activeSignals`/`earlySignals`/`alignedSignals` tetap LONG; rincian `*ByDirection` ditambahkan | Klien lama (label "Kandidat LONG aktif") tidak berubah makna; kedua arah tersedia tanpa memecah kontrak |
