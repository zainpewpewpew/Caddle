# 15 — Kontrak modul Insider / Smart Money Radar

Dokumen ini adalah kontrak antarmuka antarmodul fitur **Insider / Smart Money Radar**. Konstanta dan helper bersama
ada di `backend/smartmoney/contracts.js`. Semua modul inti adalah **fungsi murni** (tanpa I/O, tanpa jaringan,
tanpa `Date.now()` — waktu selalu diberikan lewat argumen `now`) agar dapat diuji dengan fixture dan dipakai ulang
untuk evaluasi historis tanpa look-ahead.

Prinsip yang mengikat semua modul:

1. **Baca saja.** Tidak ada seed phrase, private key, tanda tangan, atau order. Hanya alamat publik.
2. **“Insider” hanya nama fitur.** Teks UI/alasan tidak boleh menyiratkan informasi orang dalam.
3. **Identitas token = `chain` + `contract address`.** Simbol hanya label tampilan; dua token bersimbol sama adalah
   dua token berbeda.
4. **Hanya swap yang dihitung beli/jual.** Transfer masuk, penarikan exchange, bridge, airdrop, mint, dan LP bukan
   pembelian. Deposit ke exchange adalah *indikasi keluar*, bukan penjualan.
5. **Skor bukan probabilitas.** Skor keyakinan dan skor wallet adalah ringkasan bukti yang dapat dijelaskan.
6. **Tidak ada data simulasi yang tampil sebagai live.** Setiap baris membawa `provider` dan `isSimulated`; UI wajib
   menampilkan pita “DATA SIMULASI” bila ada data simulasi.
7. **Keterbatasan wajib ditampilkan**: kesegaran data, cakupan chain, PnL tidak lengkap, label tanpa sumber.
8. Semua waktu epoch milidetik UTC. Nilai USD `number|null` (null = tidak diketahui, **jangan** diganti 0).

## 1. Tipe data kanonik

### RawTransfer (keluaran adapter provider, masukan klasifikasi)

```js
{
  chain: 'ethereum',              // salah satu CHAINS
  txHash: '0x…',                  // dinormalisasi normalizeTxHash
  logIndex: 12,                   // integer ≥ 0 (Solana: indeks instruksi/transfer dalam tx); (chain, txHash, logIndex) unik
  blockNumber: 19000000,          // integer | null
  blockTime: 1767225600000,       // epoch ms
  from: '0x…', to: '0x…',         // dinormalisasi normalizeAddress; ZERO_ADDRESS untuk mint/burn
  token: { address: '0x…'|'native', symbol: 'PEPE', name: 'Pepe'|null, decimals: 18|null },
  amount: 1234.5,                 // satuan token (sudah dibagi decimals), > 0
  usdValue: 512.3 | null,         // nilai USD saat transaksi bila provider memberikannya
  priceSource: 'provider-x' | null,
  provider: 'blockscout',         // id adapter
  isSimulated: false,
  txMeta: {                       // opsional; field tak diketahui = null
    initiator: '0x…' | null,      // tx.from (pengirim transaksi)
    toContract: '0x…' | null,     // tx.to
    method: 'swapExactTokensForETH' | null,
    providerCategory: 'swap'|'transfer'|'airdrop'|'bridge'|'deposit'|'withdraw'|'lp'|'mint'|null,
    dex: 'uniswap-v3' | null,
  },
}
```

### AddressLabel

```js
{ chain, address, label: 'Binance 14', category: 'cex', source: 'etherscan-nametag', confidence: 0.9, fetchedAt }
```

`category` ∈ `LABEL_CATEGORIES`. Label tanpa `source` ditolak repositori.

### Activity (keluaran classify.js)

```js
{
  id: 'ethereum:0xtx…:0xwallet…:0xtoken…',   // kunci dedupe deterministik (satu baris per tx × wallet × token)
  chain, txHash, blockTime, wallet,
  token: { address, symbol, name, decimals },
  type: 'SWAP_BUY',                          // ACTIVITY_TYPES
  direction: 'IN' | 'OUT',
  amount: 1000,                              // jumlah bersih token untuk wallet di tx ini (> 0)
  usdValue: 500 | null,
  counterparty: '0x…' | null,                // pihak lawan utama (pool/router/exchange/bridge)
  counterpartyLabel: { label, category, source } | null,
  confidence: 'HIGH' | 'MEDIUM' | 'LOW',
  reason: 'Swap: wallet mengirim 0.5 WETH dan menerima 1000 PEPE dalam tx yang sama',  // Bahasa Indonesia
  provider, isSimulated,
  explorerUrl: 'https://etherscan.io/tx/0x…',
}
```

## 2. Modul inti (fungsi murni)

### `normalize.js`
- `normalizeTransfers(rawTransfers) → { transfers, rejected: [{ input, reason }], duplicates: number }`
  memvalidasi & menormalkan alamat/hash, membuang duplikat `(chain, txHash, logIndex)` (provider yang sama atau
  berbeda), menolak amount ≤ 0 / chain tak dikenal. Urutan keluaran: `blockTime`, `txHash`, `logIndex`.
- `groupByTransaction(transfers) → Map<chain:txHash, RawTransfer[]>`.

### `classify.js`
- `classifyTransaction(transfers, wallet, { labels }) → Activity[]` — `transfers` = semua transfer satu tx;
  `labels` = `Map<chain:address, AddressLabel>`. Aturan (berurutan):
  1. Hitung jumlah bersih per token untuk `wallet` (masuk − keluar). Token dengan bersih 0 diabaikan.
  2. **LP**: wallet menerima token berlabel `lp_token` (atau mint dari ZERO_ADDRESS) sambil mengirim ≥ 1 token ke
     pool → `LP_ADD` (token yang dikirim) ; kebalikannya (burn LP, terima token) → `LP_REMOVE`. Bukan beli/jual.
  3. **Bridge**: lawan berlabel `bridge` atau `providerCategory === 'bridge'` → `BRIDGE_IN`/`BRIDGE_OUT`.
  4. **Exchange**: hanya masuk dari label `cex`/`cex_deposit` → `CEX_WITHDRAWAL`; hanya keluar ke label tersebut →
     `CEX_DEPOSIT`.
  5. **Swap**: dalam tx yang sama wallet keluar token A dan masuk token B (A≠B), lawan bukan cex/bridge, atau
     `providerCategory === 'swap'`. Token non-quote masuk → `SWAP_BUY`; token non-quote keluar → `SWAP_SELL`;
     quote↔quote → `SWAP_BUY`/`SWAP_SELL` aset quote (tidak masuk radar). `usdValue` dari sisi quote bila tersedia
     (stablecoin = 1 USD/unit), jika tidak dari provider, jika tidak `null`.
  6. **Airdrop**: lawan berlabel `airdrop_distributor`, `providerCategory === 'airdrop'`, atau metode `claim*` /
     `*airdrop*` tanpa token keluar → `AIRDROP`. Mint dari ZERO_ADDRESS tanpa token keluar → `MINT`.
     Burn ke ZERO_ADDRESS tanpa token masuk → `BURN`.
  7. Selain itu: `TRANSFER_IN` / `TRANSFER_OUT`. Masukan kontradiktif → `UNKNOWN` (dengan alasan).
  `confidence`: HIGH bila ada label bersumber atau kategori provider yang konsisten dengan aturan; MEDIUM bila hanya
  heuristik struktur tx; LOW bila data tidak lengkap (mis. token tanpa decimals, satu sisi swap tidak terlihat).
- `classifyWalletTransfers(transfers, wallet, { labels }) → Activity[]` — mengelompokkan per tx lalu memanggil
  `classifyTransaction`; terurut `blockTime`.

### `pnl.js`
- `computeWalletPnl(activities, { prices, now }) → PnlResult`. `prices`: `Map<tokenKey, { priceUsd, at, source }>`.
  FIFO per token:
  - `SWAP_BUY` membuat lot berbiaya `usdValue` (null → lot berbiaya tidak diketahui).
  - `UNKNOWN_COST_IN_TYPES` membuat lot berbiaya **tidak diketahui** (`AIRDROP`/`MINT` ditandai `origin: 'AIRDROP'`).
  - `SWAP_SELL` mengonsumsi lot FIFO; bagian dengan biaya diketahui → realized PnL; bagian berbiaya tidak diketahui
    atau melebihi saldo yang terlihat (histori terpotong) → `unknownCostSoldQty` (tidak dihitung sebagai profit).
  - `MOVE_OUT_TYPES` mengonsumsi lot tanpa realisasi PnL (dicatat `movedOutQty`).
  - Unrealized = (harga sekarang × qty lot berbiaya diketahui) − biayanya; `null` bila tidak ada harga; harga lebih
    tua dari 24 jam ditandai `stalePrice`.
  Keluaran:
  ```js
  {
    positions: [{ tokenKey, token, qtyHeld, knownCostQty, costBasisUsd, unknownCostQty, realizedPnlUsd,
                  unrealizedPnlUsd|null, priceUsd|null, priceAt|null, stalePrice, buys, sells, firstBuyAt|null,
                  lastActivityAt, completeness: 'COMPLETE'|'PARTIAL'|'UNKNOWN', notes: [string] }],
    closedTrades: [{ tokenKey, openAt, closeAt, qty, costUsd, proceedsUsd, pnlUsd, returnPct, holdMs }],
    summary: { realizedPnlUsd, unrealizedPnlUsd|null, totalCostUsd, airdropRealizedUsd, tradesCount, closedTradesCount,
               tokensTraded, completenessRatio /* 0..1 qty jual berbiaya diketahui / total qty jual */,
               completeness: 'COMPLETE'|'PARTIAL'|'UNKNOWN', notes: [string] },
  }
  ```
  PnL dari lot airdrop dilaporkan terpisah (`airdropRealizedUsd`) dan **tidak** dihitung sebagai keahlian trading.

### `walletFlags.js`
- `detectWalletFlags({ chain, address, activities, labels, txTimes? }) → Flag[]`,
  `Flag = { code, severity, reason, evidence, source: 'label:<sumber>' | 'heuristik' }`:
  - `CEX` / `MARKET_MAKER` / `MEV` / `DEX_INFRA` (dex_router/dex_pool) / `CONTRACT`: dari label bersumber (HIGH).
  - `BOT` (heuristik): ≥ 200 tx dengan median jeda < 60 dtk, atau aktif ≥ 22 dari 24 jam UTC secara merata, atau
    banyak tx di blok yang sama.
  - `MEV`: beli & jual token sama di blok/detik yang sama berulang (≥ 3 kali).
  - `MARKET_MAKER` (heuristik): dua arah pada ≥ 5 token dengan |net|/gross < 0,1 dan frekuensi tinggi.
  - `AIRDROP_FARMER`: > 50 % nilai/jumlah masuk berasal dari AIRDROP/MINT dan realized PnL didominasi lot airdrop.
  - `LOW_HISTORY`: riwayat < 30 hari atau < 10 trade tertutup (MEDIUM — tidak mengecualikan, mengurangi skor).
  - `INCOMPLETE_PNL`: `completenessRatio < 0,5`.
- `isExcluded(flags) → boolean` — true bila ada `EXCLUDING_FLAGS` dengan severity HIGH.

### `clusters.js`
- `linkWallets({ chain, wallets: [{ address, activities, transfers? }], labels }) → { clusters, clusterOf, links }`
  Union-find atas tepi berikut (setiap tepi menyimpan bukti tx):
  1. Transfer langsung antar-kandidat (bukan via cex/bridge).
  2. Pendana pertama yang sama (transfer native pertama masuk dari alamat non-cex yang sama).
  3. Alamat deposit exchange yang sama (`cex_deposit`, heuristik deposit-address reuse).
  4. Ko-trading: membeli token yang sama dalam ≤ 60 dtk pada ≥ 3 token berbeda.
  `clusters: [{ id, members: [address], reasons: [{ type, a, b, evidence: { txHash?, token?, at? } }] }]`;
  `clusterOf: Map<address, clusterId>`; wallet tanpa tautan = klaster sendiri. `id` deterministik
  (`chain:alamat-terkecil`).

### `walletScore.js`
- `scoreWallet({ chain, address, pnl, activities, flags, now }, params?) → WalletScore`
  ```js
  {
    score: 0..100, eligible: boolean, style: TRADING_STYLES,
    components: { profitability, consistency, sampleSize, risk, diversification, history }, // masing-masing 0..1
    metrics: { closedTrades, distinctTokens, historyDays, winRate /* info saja */, medianReturnPct,
               shrunkMeanReturnPct, meanReturnExTopPct, maxDrawdownPct, topTokenPnlShare, completenessRatio,
               weeklyPositiveShare },
    reasons: [string], limitations: [string], computedAt: now,
  }
  ```
  Aturan anti-menyesatkan:
  - Profitabilitas memakai rata-rata return per trade **dengan shrinkage** ke 0 (`n/(n+k)`, k = 10) dan nilai
    terkecil antara rata-rata dengan & tanpa trade terbaik — satu transaksi beruntung tidak bisa mendominasi.
  - Win rate hanya ditampilkan; tidak menjadi komponen skor sendiri.
  - Saldo besar tidak pernah menaikkan skor (skor tidak membaca saldo).
  - Konsistensi = proporsi minggu aktif dengan PnL realisasi positif, shrinkage ke 0,5, minimal 4 minggu.
  - Risiko = drawdown maksimum kurva PnL realisasi kumulatif + kerugian trade terburuk.
  - Diversifikasi = jumlah token dengan trade tertutup + penalti bila > 60 % PnL dari satu token.
  - Bobot: profitabilitas 0,30 · konsistensi 0,25 · ukuran sampel 0,15 · risiko 0,15 · diversifikasi 0,10 ·
    lama riwayat 0,05; total × faktor kelengkapan PnL (`0,5 + 0,5 × completenessRatio`).
  - `eligible = false` bila: trade tertutup < 10, token < 3, riwayat < 30 hari, `isExcluded(flags)`,
    AIRDROP_FARMER HIGH, atau completenessRatio < 0,5 — dengan alasan di `limitations`.
  - Gaya: median lama pegang < 1 jam SCALPER, < 7 hari SWING, ≥ 7 hari POSITION, campuran MIXED.

### `discovery.js`
- `rankCandidates(candidates, { labels, existing }) → [{ chain, address, source, reason }]` — buang duplikat,
  alamat berlabel cex/dex_router/dex_pool/bridge/contract, dan alamat yang sudah dilacak; pertahankan sumber penemuan.

### `radar.js`
- `buildAccumulationRadar({ activities, walletScores, clusterOf, now, windowMs, prices, holdingsBefore? }, params?)
  → RadarToken[]` — hanya aktivitas `blockTime ∈ [now − windowMs, now]` dari wallet `eligible` dan tidak
  `isExcluded`. Token quote diabaikan. Per token:
  ```js
  {
    tokenKey, chain, token,
    buyers: [{ wallet, score, clusterId, netBuyUsd, buys, sells, firstBuyAt, lastBuyAt, txs: [{ txHash, explorerUrl, type, at, usd }] }],
    buyerCount, independentBuyers /* klaster berbeda */, sellerCount,
    grossBuyUsd, grossSellUsd, netFlowUsd, unknownUsdCount,
    holdingChangePct | null,
    exitSignals: [{ wallet, type: 'SWAP_SELL'|'CEX_DEPOSIT'|'FULL_EXIT', at, usd, txHash, explorerUrl }],
    excluded: { transferIn, cexWithdrawal, bridge, airdrop, lp, mint },   // ditampilkan, tidak dihitung beli
    firstActivityAt, lastActivityAt,
    state: 'ACCUMULATING'|'MIXED'|'DISTRIBUTING'|'EXITING',
    conviction: 0..100, convictionComponents: { breadth, quality, flow, repeat, recency, exitPenalty, concentrationPenalty },
    reasons: [string], risks: [string],
  }
  ```
  Skor keyakinan: lebar (log klaster independen), kualitas (rata-rata skor wallet), aliran bersih (log USD),
  akumulasi berulang (wallet ≥ 2 beli), kebaruan; dikurangi penjualan/indikasi keluar dan dominasi satu klaster.
  Teks selalu menyertakan `DISCLAIMERS.conviction`. Urutan: conviction turun, lalu tokenKey.

### `alerts.js`
- `deriveAlerts({ activities /* baru sejak run terakhir */, radar, watchlist: { wallets: Set<walletKey>, tokens: Set<tokenKey> },
  walletScores, positions /* Map walletKey → Map tokenKey → { qtyBefore, qtyAfter } */, now }, prefs) → Alert[]`
  `Alert = { kind, severity, dedupeKey, chain, tokenKey, wallet|null, title, message, evidence: { txHashes, explorerUrls }, createdAt }`
  - `NEW_BUY` — wallet dipantau/berkualitas `SWAP_BUY` ≥ `minUsd` pada token yang belum dibeli dalam lookback.
  - `REPEAT_ACCUMULATION` — wallet ≥ 3 `SWAP_BUY` token sama dalam jendela.
  - `MULTI_WALLET_BUY` — `independentBuyers ≥ prefs.minIndependentBuyers` (default 3).
  - `LARGE_SELL` — `SWAP_SELL` ≥ `prefs.largeSellUsd`.
  - `WALLET_EXIT` — kepemilikan wallet dipantau atas token yang sebelumnya diakumulasi turun ≥ 90 % (swap atau
    deposit exchange; teks membedakan “dijual” vs “dipindah ke exchange, belum tentu dijual”).
  - `dedupeKey = kind:tokenKey:wallet|*:bucket`, `bucket = floor(t / prefs.cooldownMs)`.
- `filterAlerts(alerts, { existingKeys: Set, prefs }) → Alert[]` — buang duplikat key, jenis yang dimatikan,
  di bawah `minUsd`/`minWalletScore`, dan non-watchlist bila `prefs.watchlistOnly`.
- `DEFAULT_ALERT_PREFS = { kinds: [...ALERT_KINDS], minUsd: 1000, largeSellUsd: 10000, minWalletScore: 60,
  minIndependentBuyers: 3, cooldownMs: 6 jam, watchlistOnly: false }`; `validateAlertPrefs(prefs) → string[]`.

### `binanceMatch.js`
- `matchToken({ chain, address, symbol }, mappingRows) → Match` —
  `mappingRows: [{ chain, contractAddress, binanceAsset, spotSymbol|null, futuresSymbol|null, multiplier, source, verifiedAt }]`.
  `MATCHED` hanya bila `chain` + `contractAddress` sama persis (EVM huruf kecil). Simbol sama tanpa kontrak cocok →
  `SYMBOL_ONLY` (peringatan, tidak ditautkan ke sinyal). Lebih dari satu baris cocok → `AMBIGUOUS`. Selain itu
  `NOT_LISTED`. Perp ber-prefix (mis. `1000PEPEUSDT`, `multiplier: 1000`) dari baris mapping, tidak ditebak.
  `Match = { status, binanceAsset|null, spotSymbol|null, futuresSymbol|null, multiplier, source|null, note }`.

### `screenerLink.js`
- `linkToScreener(radarTokens, { matches /* Map tokenKey → Match */, activeSignals /* baris listActive LONG */ })
  → RadarToken & { binance: Match, screener: { signals: [{ timeframe, state, classification, tier, patterns: [string] }],
  relevance: RELEVANCE_LEVELS, relevanceReason, note } }` — hanya `MATCHED` yang ditautkan ke sinyal LONG 5m/15m/1h
  berdasarkan `futuresSymbol`. Label pola favorit (Bahasa Indonesia): SA = kenaikan perlahan volume rendah, PVA =
  akumulasi volume progresif, state BREAKOUT = breakout akumulasi; fitur struktur (higher low) & kompresi (squeeze)
  dari penjelasan sinyal bila tersedia. `note` selalu berisi `DISCLAIMERS.spotVsFutures`.
- Relevansi: TINGGI = keyakinan ≥ 60 dan ada sinyal LONG tier A/B; SEDANG = salah satunya; RENDAH = hanya MATCHED;
  TIDAK_TERHUBUNG = tidak MATCHED.

### `evaluate.js` (evaluasi historis tanpa look-ahead)
- `evaluateHistorically({ activities, priceAt /* (tokenKey, t) → number|null */, start, end, stepMs, windowMs,
  horizonsMs, minIndependentBuyers }, params?) → Report`
  Pada setiap titik `t`: skor wallet dihitung **hanya** dari aktivitas `blockTime < t` (trade tertutup sebelum `t`),
  kandidat wallet hanya yang sudah aktif sebelum `t`, radar dari `[t − windowMs, t)`, harga masuk = `priceAt(t)`,
  return ke depan dari `priceAt(t + h)`. Baseline = semua token non-quote yang dibeli (oleh siapa pun) di jendela yang
  sama. Laporan: jumlah sinyal, rata-rata/median return, hit rate per ember keyakinan & horizon, perbandingan dengan
  baseline, cakupan harga, dan peringatan sampel kecil. Tes kebocoran: mengubah data setelah `t` tidak mengubah
  sinyal di `t`.

## 3. Provider (adapter, satu-satunya tempat I/O jaringan)

`backend/smartmoney/providers/` — setiap adapter:

```js
{
  id: 'blockscout', displayName: 'Blockscout', requiresKey: false, isSimulated: false,
  chains: ['ethereum', 'base'], capabilities: new Set(['walletTransfers', 'tokenMeta']),
  terms: { docsUrl, attribution: string|null, displayAllowed: boolean, notes: string },
  async fetchWalletTransfers({ chain, address, since, cursor, signal }) → { transfers: RawTransfer[], nextCursor|null, asOf },
  async fetchLabels({ chain, addresses, signal }) → AddressLabel[],
  async fetchPrices({ chain, addresses, signal }) → [{ chain, address, priceUsd, at, source }],
  async discoverWallets({ chain, since, limit, signal }) → [{ chain, address, source, reason }],
  async fetchBinanceMapping({ signal }) → mappingRows,
}
```
Metode yang tidak didukung melempar `ProviderError('NOT_SUPPORTED')`. Semua kegagalan → `ProviderError { provider,
code: PROVIDER_ERROR_CODES, retryAfterMs|null, message }`; tidak pernah melempar error mentah ke API.
`fixtureProvider` (`isSimulated: true`) hanya untuk tes, E2E, dan mode demo eksplisit; tidak pernah aktif default.

## 4. Persistensi & API

Migrasi `007_smart_money.sql` (tabel `sm_*`), repositori `backend/smartmoney/repository.js`, layanan sinkronisasi
`backend/smartmoney/sync.js` (discover → tarik transfer inkremental per kursor → normalisasi/dedupe → klasifikasi →
simpan → PnL/flag/skor/klaster → alert → status provider; satu provider gagal = status DEGRADED, provider lain lanjut),
route `backend/api/smartMoneyRoutes.js` di bawah `/api/smart-money/*` (semua wajib sesi; mutasi wajib CSRF):

| Method & path | Isi |
| --- | --- |
| `GET /status` | provider (terkonfigurasi?, butuh kunci?, status terakhir, error), kesegaran, cakupan, `simulated` |
| `GET /radar?window=1h\|4h\|24h\|7d&chain&minBuyers&state&linked&limit` | RadarToken + binance + screener |
| `GET /wallets?chain&eligible&style&minScore&includeFlagged&limit` | Wallet Discovery |
| `GET /wallets/:chain/:address` | profil: label+sumber, skor+alasan+keterbatasan, flag, klaster, PnL, posisi, aktivitas |
| `GET /tokens/:chain/:address` | detail token: match Binance, radar, aktivitas per wallet, sinyal screener |
| `GET/POST/DELETE /watchlist` | ikuti/berhenti mengikuti wallet & token (per pengguna) |
| `GET /alerts?unread&kind&limit`, `POST /alerts/read` | notifikasi + tandai dibaca |
| `GET/PUT /alert-prefs` | filter notifikasi per pengguna |
| `GET /screener-links` | peta `futuresSymbol → ringkasan smart money` untuk chip di LONG Scanner |
| `GET /evaluation` | laporan evaluasi historis terakhir atau `{ available: false }` |

## 5. Bentuk respons API (dipakai frontend)

Semua respons daftar menyertakan blok `meta`:

```js
meta: {
  simulated: boolean,                 // true bila ADA data is_simulated di hasil → UI wajib tampilkan pita DATA SIMULASI
  dataAsOf: number|null,              // blockTime aktivitas terbaru yang tersimpan
  lastSyncAt: number|null,            // sukses sinkron terakhir (provider mana pun)
  isStale: boolean,                   // lastSyncAt lebih tua dari staleAfterMinutes, atau belum pernah sinkron
  coverage: { chains: [string], wallets: number, activities: number },
  providersConfigured: number,        // 0 → UI menampilkan keadaan "belum ada sumber data" (bukan data palsu)
  disclaimers: DISCLAIMERS,           // dari contracts.js
}
```

- `GET /status` → `{ meta, providers: [{ id, displayName, requiresKey, configured, isSimulated, chains, capabilities,
  lastAttemptAt, lastSuccessAt, lastErrorCode, lastErrorMessage, state: 'OK'|'DEGRADED'|'DOWN'|'NEVER' }] }`
- `GET /radar` → `{ meta, window, computedAt, items: [RadarToken & { binance: Match, screener, watching: boolean }] }`
  (`buyers[].wallet` adalah alamat; `buyers[].label` label terbaik `{ label, category, source }|null`).
- `GET /wallets` → `{ meta, items: [{ chain, address, score, eligible, style, clusterId, clusterSize, flags,
  metrics, topReason, labels: [{ label, category, source }], lastActivityAt, watching }] }`
- `GET /wallets/:chain/:address` → `{ meta, wallet: { chain, address, explorerUrl, firstSeenAt, lastActivityAt,
  discoveredVia, discoveryReason, isSimulated }, labels, score: WalletScore|null, flags, cluster: { id, members,
  reasons }|null, pnl: { summary, positions }, activities: [Activity] (terbaru dulu, ≤ 200), watching }` — 404
  `{ error: 'NOT_FOUND' }` bila wallet tidak dilacak; 400 bila alamat tidak valid untuk chain.
- `GET /tokens/:chain/:address` → `{ meta, token, binance: Match, radar: RadarToken|null (jendela 24h),
  activities: [Activity] (≤ 200), screener, watching }`
- `GET /watchlist` → `{ items: [{ kind, chain, address, note, createdAt, summary }] }`;
  `POST /watchlist` body `{ kind: 'WALLET'|'TOKEN', chain, address, note? }` → 201 item;
  `DELETE /watchlist` body `{ kind, chain, address }` → 204.
- `GET /alerts` → `{ meta, items: [Alert & { id, read, isSimulated }], unread: number }`;
  `POST /alerts/read` body `{ ids: [int] }` atau `{ all: true }` → `{ updated }`.
- `GET /alert-prefs` → `{ prefs, isDefault }`; `PUT /alert-prefs` body `{ prefs }` → `{ prefs }` (400 dengan
  `details` bila tidak valid).
- `GET /screener-links` → `{ meta, items: { [futuresSymbol]: { tokenKey, symbol, chain, independentBuyers,
  conviction, state, lastActivityAt } } }` — hanya token `MATCHED`.
- `GET /evaluation` → `{ meta, available: false }` atau `{ meta, available: true, computedAt, params, report }`.
