# 14 — Riset sumber data & metodologi Insider / Smart Money Radar

Tanggal riset: **2026-10-26**. Dokumen ini adalah masukan riset untuk kontrak modul
`docs/15-kontrak-smart-money.md`. Fitur bersifat **baca saja** (alamat publik, tanpa private key / tanda tangan /
order). “Insider” hanya nama fitur; tidak ada klaim informasi orang dalam.

## 0. Metode, tingkat verifikasi & keterbatasan riset

- **Lingkungan cloud riset ini hampir tidak punya akses keluar.** Semua `curl` ke host data kripto ditolak oleh
  proxy egress (`CONNECT tunnel failed, response 403`), kecuali `fapi.binance.com` yang menjawab **HTTP 451**
  (“Service unavailable from a restricted location…”, pembatasan geografis Binance, bukan proxy). Alat `WebFetch`
  juga gagal DNS untuk semua domain dokumentasi vendor (hanya `github.com` yang bisa dibaca). Akibatnya:
  - Verifikasi dilakukan lewat **mesin pencari yang mengindeks halaman resmi**; setiap klaim di bawah menyebut URL
    resmi yang muncul di hasil pencarian dan cuplikan yang dibaca. Ini **bukan** pembacaan langsung halaman live.
  - Tingkat verifikasi ditandai:
    **[R]** = cuplikan dari halaman resmi vendor (via indeks pencarian, 2026-10-26);
    **[S]** = hanya sumber sekunder (blog pihak ketiga / pesaing) — perlakukan sebagai indikatif;
    **[GH]** = dibaca langsung dari halaman GitHub;
    **belum terverifikasi** = tidak ditemukan bukti; jangan dipakai sebagai fakta.
  - **Tidak ada contoh respons live** yang bisa direkam dari cloud. Nama field di bawah berasal dari contoh di
    dokumentasi resmi / klien open source, bukan dari respons yang ditangkap.
- Harga, kuota, dan cakupan chain berubah cepat (beberapa sumber saling bertentangan — dicatat apa adanya). Sebelum
  integrasi, jalankan uji konektivitas di Mac pengguna (bagian 2.3) dan cek ulang halaman harga.

### 0.1 Hasil uji konektivitas dari cloud (2026-10-26)

| Endpoint | Hasil dari cloud | Catatan |
|---|---|---|
| `https://api.geckoterminal.com/api/v2/networks?page=1` | 000 (proxy 403) | perlu diuji dari Mac |
| `https://api.dexscreener.com/latest/dex/search?q=PEPE` | 000 (proxy 403) | perlu diuji dari Mac |
| `https://eth.blockscout.com/api/v2/stats` | 000 (proxy 403) | perlu diuji dari Mac |
| `https://base.blockscout.com/api/v2/stats` | 000 (proxy 403) | perlu diuji dari Mac |
| `https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethprice` | 000 (proxy 403) | perlu diuji dari Mac |
| `https://api.coingecko.com/api/v3/ping` | 000 (proxy 403) | perlu diuji dari Mac |
| `https://api.llama.fi/protocols`, `https://bridges.llama.fi/bridges` | 000 (proxy 403) | perlu diuji dari Mac |
| `https://api.binance.com/api/v3/ping` | 000 (proxy 403) | perlu diuji dari Mac |
| `https://fapi.binance.com/fapi/v1/ping` / `exchangeInfo` | **451** | geo-block Binance terhadap IP cloud |
| `https://www.binance.com/bapi/...` | 000 (proxy 403) | — |
| Routescan, Mobula, Birdeye, Helius, Moralis, Zerion, Nansen, DeBank, Sim (Dune) | 000 (proxy 403) | — |
| `raw.githubusercontent.com`, `api.github.com` (gh) | 403 | hanya halaman `github.com` terbaca via WebFetch |

**Kesimpulan:** dari lingkungan cloud **tidak ada** sumber yang terjangkau. Semua integrasi harus diuji dan
dijalankan dari Mac pengguna (tempat backend AlphaLens berjalan). Skrip uji ada di bagian 2.3.

---

## 1. Ringkasan rekomendasi

**Arsitektur data berlapis** (selaras dengan adapter `backend/smartmoney/providers/` di dokumen 15):

1. **Lapis 0 — Pemetaan Binance (wajib, gratis).** `GET /sapi/v1/capital/config/getall` dengan API key Binance
   **read-only** (izin default “Enable Reading”) → `networkList[].contractAddress` per jaringan. Silang-cek dengan
   CoinGecko `/coins/{id}` (`platforms`/`detail_platforms`) dan `/derivatives/exchanges/binance_futures` (ticker
   kini membawa `coin_id`). Hasilnya tabel `mappingRows` yang dipakai `binanceMatch.js`. (Bagian 5.)
2. **Lapis 1 — Penemuan wallet dari trade DEX (gratis/keyless).** GeckoTerminal/CoinGecko onchain
   `.../pools/{pool}/trades` memuat **`tx_from_address`** per trade [R] — satu-satunya sumber keyless yang
   ditemukan yang memberi alamat trader per swap. Dipakai untuk menemukan kandidat wallet pada pool token yang
   ter-listing di Binance. DexScreener **tidak** memberi alamat trader (hanya pair/token/boost).
3. **Lapis 2 — Riwayat wallet mentah (gratis dengan kunci).**
   - EVM: Etherscan API V2 (satu kunci, `chainid`), free tier 3 rps / 100k per hari **tetapi tidak mencakup semua
     chain** — BNB Chain (56) dan kemungkinan Base/OP/Avalanche hanya berbayar [R untuk “selected chains”, S untuk
     daftar chain]. Pelengkap: Routescan (keyless 2 rps/10k per hari, kunci gratis 5 rps/100k per hari) [R] dan
     instance Blockscout (`eth.blockscout.com`, `base.blockscout.com`, dst.).
   - Solana: Helius free (1M kredit/bulan, 10 rps RPC, 2 rps Enhanced/DAS) [R]; `getTransactionsForAddress`
     10 kredit per 100 transaksi [R]; Enhanced Transactions (`type`=SWAP/TRANSFER, `source`=JUPITER/RAYDIUM) kini
     **maintenance mode** [R].
   - Klasifikasi swap/transfer/bridge/CEX dilakukan sendiri di `classify.js` dari log Transfer + daftar kontrak.
4. **Lapis 3 — PnL & label berbayar (opsional).** Pilihan termurah yang realistis:
   - **Nansen API Pro** $49/bln (tahunan) / $69/bln (bulanan); Smart Money netflow/holdings/dex-trades 5 kredit per
     panggilan [R]. Label dan endpoint smart-money **dilarang diredistribusi/ditampilkan ke pihak ketiga** [R] —
     aman hanya untuk pemakaian internal pribadi.
   - **Codex** free 10.000 CU/permintaan per bulan (aktivasi $1) [R]; `filterWallets` dengan metrik realized
     profit & label perilaku (mis. `SNIPER`, bot) [R].
   - **Birdeye** Lite $39/bln (2,5 jt CU) untuk Solana: `/defi/v2/tokens/top_traders`, wallet PnL [R, harga ada
     yang bertentangan].
   - **Moralis** kini **tanpa** paket gratis self-serve; Starter $149/bln [R]; PnL hanya realized, hanya
     Ethereum/Polygon/Base [R].
5. **Lapis 4 — Label sendiri.** Label CEX/bridge/router dari daftar open source (cek lisensi; Spellbook Dune
   **BSL 1.1**, bukan Apache) + label buatan sendiri (deposit-address heuristik, bot/MEV). Semua label menyimpan
   `source` dan `confidence`.

**Yang TIDAK mungkin diketahui (wajib ditampilkan sebagai keterbatasan):**

- Posisi futures/perp **pribadi** trader di Binance (atau CEX mana pun), saldo internal exchange, order book
  pribadi, dan siapa pemilik akun CEX. Data on-chain berhenti di alamat deposit exchange.
- Identitas asli pemilik wallet (label pihak ketiga adalah dugaan berprobabilitas, bukan fakta).
- Niat trader (beli untuk hedging, market making, OTC, airdrop, pembayaran) — hanya bisa diduga.
- Transaksi off-chain/OTC, pembagian ke banyak wallet yang tidak terhubung secara on-chain, dan wallet baru tanpa
  riwayat (cold start).
- Cost basis untuk token yang masuk lewat transfer/bridge (PnL menjadi “tidak lengkap”, bukan nol).
- Aktivitas di chain yang tidak dicakup (mis. BNB Chain bila memakai Etherscan free).

---

## 2. Tabel per sumber

Legenda kolom “Cloud?”: semuanya **tidak terjangkau dari cloud** (lihat 0.1); kolom “Mac?” = perlu diuji.

### 2.1 Explorer & data mentah

| Sumber | Kemampuan aktual (relevan) | Chain | Kesegaran / histori | Label | Biaya & tier gratis | Rate limit | Izin / atribusi | Kunci? | Dokumen resmi (cek 2026-10-26) |
|---|---|---|---|---|---|---|---|---|---|
| **Etherscan API V2** | `txlist`, `tokentx` (ERC-20 transfer per alamat), harga, ABI; satu kunci untuk banyak chain via `chainid` [R]. Maks rekaman per permintaan free turun 10.000 → **1.000** mulai 2026-07-01 [S: blog Blockscout mengutip changelog Etherscan]. | 60+ EVM [R]; free = “selected chains (90% coverage)” [R]. BNB (56) “Paid Tier Only” [S]; Base, OP, Avalanche, Gnosis berbayar [S, satu sumber] | Near real-time; histori penuh | Name tag/label hanya via `module=nametag&action=getaddresstag` — **Pro Plus saja**, 2 rps, ≤100 alamat/panggilan [R]; ekspor massal hanya Enterprise [R] | Free $0; Lite ±$49/bln [S] (Etherscan: “25% dari tier berbayar terendah sebelumnya” [R]); Standard $179,10/bln; Advanced $269,10; Professional $359,10; Pro Plus ±$809,10 [R, cuplikan harga — kemungkinan termasuk diskon] | Free 3 rps / 100k per hari; Lite 5 rps / 100k; Standard 10 rps / 200k; Advanced 20/500k; Professional 30/1 jt [R] | Free: “Attribution required” [R]; lisensi terbatas, dapat dicabut, untuk integrasi software [R: apiterms]. Redistribusi: **belum terverifikasi** | Ya (gratis) | https://docs.etherscan.io/resources/rate-limits · https://etherscan.io/api/pricing · https://info.etherscan.com/whats-changing-in-the-free-api-tier-coverage-and-why/ · https://docs.etherscan.io/api-reference/endpoint/getaddresstag · https://etherscan.io/apiterms |
| **BscScan** | API lama dihentikan; wajib ke Etherscan V2 `chainid=56` [R: blog BNB Chain] | BNB | — | — | V2 untuk BNB **tanpa free tier** [R: BNB Chain] | — | — | — | https://www.bnbchain.org/en/blog/migration-guide-bscscan-api-to-bsctrace-api-via-meganode · https://kb.etherscan.com/etherscan-api-v1-will-be-fully-deprecated-by-15th-august-2025 |
| **Routescan** | API kompatibel Etherscan per chain: `https://api.routescan.io/v2/network/mainnet/evm/{chainId}/etherscan/api` [R] | 70+ chain (angka berbeda antar halaman: 57/63/70+) [R]; termasuk Ethereum, Avalanche, Base, OP, BNB disebut di daftar ekosistem [R] — daftar chain-ID mainnet **belum terverifikasi** | Near real-time | Tidak ada API label (belum terverifikasi) | Free keyless dan free berkunci [R]; harga berbayar belum dicek | **Keyless 2 rps / 10.000 per hari; kunci gratis 5 rps / 100.000 per hari**; 429 bila lewat [R] | Kunci via header `apikey` [R]; atribusi belum terverifikasi | Opsional | https://routescan.io/docs/plans-and-limits/rate-limits · https://routescan.io/docs/plans-and-limits/api-keys-and-pricing · https://routescan.io/docs/api/conventions |
| **Blockscout** (instance publik + PRO API) | REST v2 per instance (`/api/v2/addresses/{addr}/token-transfers`, dll.) dan PRO API multichain [R] | eth, base, optimism, arbitrum, gnosis, polygon, dst. (per instance) | Near real-time | Sebagian instance punya tag publik (belum terverifikasi per instance) | PRO API: free 100k kredit/hari @5 rps, **kini wajib kunci** termasuk free; $49/bln 15 rps 100 jt kredit; $199/bln 30 rps 500 jt kredit; default 20 kredit/endpoint [R]. Akses keyless berbayar via x402 [R] | Per-instance tanpa kunci ±10 rps per IP (default env `API_RATE_LIMIT`) [S: mirror docs/DeepWiki]; operator bisa berbeda | Lisensi kode: README menyebut “**Blockscout Software Licence**” [GH] (bukan lagi GPL murni) — hanya relevan bila self-host | Per-instance: belum pasti (dulu opsional); PRO: ya | https://docs.blockscout.com/rate-limits · https://docs.blockscout.com/devs/pro-api-routes · https://docs.blockscout.com/devs/x402-payments · https://github.com/blockscout/blockscout |
| **Helius** (Solana) | `getTransactionsForAddress` (10 kredit per 100 tx penuh, maks 1.000) [R]; Enhanced Transactions `/v0/addresses/{addr}/transactions` dengan `type` (SWAP, TRANSFER…) & `source` (JUPITER, RAYDIUM…), field `nativeTransfers`, `tokenTransfers` — **legacy, maintenance mode**, 100 kredit [R]; penerusnya Parsed Events 10 kredit [R]. Wallet API (beta): `/v1/wallet/{w}/history`, `/transfers`, `/balances`, `/funded-by` (sumber dana pertama SOL), `/identity` — 100 kredit/panggilan; identity & funded-by hanya paket berbayar [R] | Solana | Real-time; histori arsip | `identity` (paket berbayar) [R] | Free $0: 1 jt kredit/bln; Developer $49/bln 10 jt kredit; Business $499/bln 100 jt [R] | Free: 10 rps RPC, 2 rps DAS/Enhanced [R] | Docs: parser DeFi di luar NFT/Jupiter/SPL jangan diandalkan [R] | Ya (gratis) | https://www.helius.dev/docs/billing/plans · https://www.helius.dev/docs/billing/credits · https://www.helius.dev/docs/billing/rate-limits · https://www.helius.dev/docs/enhanced-transactions/overview · https://www.helius.dev/docs/wallet-api/overview |
| **Alchemy** | `alchemy_getAssetTransfers` (external/internal/ERC-20/721/1155, halaman ≤1.000, 120 CU) [R]; Prices API (by-address = harga DEX saja; historis 40 CU) [R]; Portfolio “Tokens By Wallet” (ETH, Solana, 30+ EVM) [R]; “Transactions By Wallet” (beta) | Transfers API: Ethereum, Base, Polygon, Arbitrum, Optimism disebut eksplisit; internal transfer hanya ETH/Polygon/Base/Arc [R] | Real-time | Tidak | Free 30 jt CU/bln; PAYG $0,525 per 1 jt CU [R] | Free 300 CUPS [R] | Belum terverifikasi | Ya | https://www.alchemy.com/pricing · https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers · https://www.alchemy.com/docs/reference/compute-unit-costs |
| **QuickNode** | RPC + marketplace add-on | Banyak | — | Tidak | Halaman harga kini: trial gratis 1 bulan (10 jt kredit, 15 rps); tier berbayar terendah ±$49/bln (80 jt kredit, 50 rps) [R, teks cache tidak konsisten]; “Discover” plan saat ini **belum terverifikasi** | — | — | Ya | https://www.quicknode.com/pricing |
| **Moralis** | Wallet history dengan kategori ter-decode: Send, Receive, Token Send/Receive, Deposit, Withdraw, **Token Swap**, **Airdrop**, Mint, Burn, Borrow, Approve, dll. [R]; Wallet PnL summary, PnL per token, **top-gainers** per token (`timeframe` all/7/30) [R]; Solana `getSwapsByWalletAddress` [R] | PnL live: **Ethereum, Polygon, Base** saja [R]; Solana PnL **belum terverifikasi** (hanya klaim marketing) | Real-time | Tidak (kategori, bukan entitas) | **Tidak ada free self-serve** (hanya trial atas permintaan); Starter $149/bln 2 jt CU; Pro $249/bln 100 jt CU; Business $749/bln [R] | Starter 40 rps [R] | Business menghapus kewajiban atribusi → paket di bawahnya wajib atribusi [R] | Ya | https://docs.moralis.com/get-started/pricing · https://docs.moralis.com/data-api/data-features/data-enrichment/transaction-decoding · https://docs.moralis.com/web3-data-api/evm/reference/wallet-api/get-wallet-profitability · https://docs.moralis.com/web3-data-api/evm/reference/get-top-profitable-wallet-per-token |
| **GoldRush (Covalent)** | Transaksi, saldo, 100+ chain [R] | 100+ | — | Tidak | Trial 14 hari 25.000 kredit, 4 rps; “Vibe Coding” $10/bln 10.000 kredit; Professional $250/bln 300.000 kredit, 50 rps; x402 pay-per-request [R]. Biaya kredit `transactions_v3` belum terverifikasi | — | Belum terverifikasi | Ya | https://goldrush.dev/pricing/ |
| **Zerion API** | Riwayat transaksi ter-decode (approve, swap, deposit, withdraw), Wallet P&L; satu permintaan untuk semua chain [R] | Multi-chain EVM + Solana (daftar belum dicek) | Real-time | Tidak | Developer $0: 2.000 permintaan/hari, 3 rps (ada halaman Zerion lain: 3.000/hari 2 rps — bertentangan) [R]; Builder $149/bln 250k/bln; Startup $499/bln [R]; P&L dibatasi 25% kuota [R] | lihat kiri | Free “local development only” [R] | Ya | https://zerion.io/api · https://zerion.io/blog/top-questions-about-zerion-api/ |
| **Sim API (Dune)** | **DIHENTIKAN**: pendaftaran ditutup 2026-05-18, layanan mati **2026-08-01** [R: blog Dune] | — | — | — | — | — | — | — | https://dune.com/blog/sunsetting-sim |
| **Dune (SQL API)** | Query SQL atas tabel kurasi `dex.trades` (`taker`, `maker`, `tx_from`, `tx_to`, `amount_usd`, `token_bought_address`, `project`, `version`, `blockchain`) [R] | Banyak EVM + `dex_solana.trades` | Tertunda (batch, menit–jam) | `labels.*` (lisensi Spellbook, lihat bagian 7) | Free kini **view-only, tanpa API**; trial 14 hari 2.500 kredit; Analyst $75/bln, Plus $399/bln [R/S campuran] | Plus 70 rpm (low) / 200 rpm (high) [R] | Hasil query/ekspor: internal & laporan sesekali, wajib kredit Dune & pembuat query, **dilarang dijual/ditawarkan berkelanjutan sebagai produk data** [R] | Ya | https://docs.dune.com/api-reference/overview/rate-limits · https://docs.dune.com/learning/how-tos/credit-system · https://dune.com/terms · https://dune.com/sql-api-terms · https://docs.dune.com/data-catalog/curated/dex-trades/evm/dex-trades |
| **Bitquery** | GraphQL DEXTrades, filter per wallet/trader [R] | EVM + Solana | Real-time + histori | Tidak | Bertentangan: blog 2026-10-05 “tidak ada free plan, trial 7 hari”; halaman harga “Free 100 kredit”; Personal $29, Pro $69, Scale $199/bln (tahunan) [R] | Poin per query | Belum terverifikasi | Ya | https://bitquery.io/pricing · https://docs.bitquery.io/v1/docs/graphql-ide/points |
| **Codex.io** | GraphQL; `filterWallets` (filter realized profit per jendela 1d/1w/30d/1y, ≤100 wallet/permintaan, include/exclude label perilaku: `SMART_TRADER_TOKENS_OVER_TWO_DAYS_OLD`, `WEALTHY`, `SNIPER`, nilai bot/scammer) [R]; `detailedWalletStats`, `walletChart` [R]; win/loss hanya posisi tertutup dengan |PnL| > $1 [R] | 80+ jaringan [R] | Real-time | Label **perilaku**, bukan identitas entitas [R] | Free 10.000 CU (atau “requests”, halaman berbeda) per bulan + aktivasi $1, 5 rps; Growth dari $350–360/bln [R] | 5 rps (free) | Belum terverifikasi | Ya | https://www.codex.io/pricing · https://docs.codex.io/api-reference/queries/filterwallets · https://docs.codex.io/concepts/wallet-pnl |
| **Mobula** | `wallet/analysis` (PnL, win-rate, periode 1d/7d/30d/90d), wallet position PnL realized+unrealized [R] | Multi-chain incl. Solana | — | — | Mobula **diakuisisi fomo** (dilaporkan 2026-08-31) [S]; Zerion menerbitkan panduan migrasi dari Mobula [R]. Status API untuk pihak luar **belum terverifikasi** — jangan dijadikan dependensi | — | — | Ya | https://docs.mobula.io/rest-api-reference/endpoint/wallet-analysis · https://zerion.io/blog/migrating-from-mobula-to-zerion-api/ |
| **Solscan Pro** | Account DeFi activities, transfers, dsb.; flat 100 CU per panggilan [R] | Solana | Real-time | Tag publik (API belum dicek) | Level 2 $199/bln 150 jt CU 1.000 req/60 dtk; Level 3 $399/bln 500 jt CU [R] | lihat kiri | Belum terverifikasi | Ya | https://pro-api.solscan.io/pro-api-docs/v2.0/docs · https://docs.solscan.io/api-access/pro-api-endpoints |

### 2.2 Data trade DEX, PnL & label “smart money”

| Sumber | Kemampuan aktual | Chain | Kesegaran / histori | Label | Biaya & gratis | Rate limit | Izin / atribusi | Kunci? | Dokumen resmi |
|---|---|---|---|---|---|---|---|---|---|
| **GeckoTerminal / CoinGecko onchain** | Trades per pool: `/networks/{network}/pools/{pool}/trades` (keyless di `api.geckoterminal.com/api/v2`; berkunci di `/onchain/...`) — default 300 trade terakhir 24 jam, filter `trade_volume_in_usd_greater_than` [R]. Changelog 2026-09-08: trades by pool/token kini bisa melihat >24 jam dengan cursor [R] (perilaku di tier keyless **belum terverifikasi**). Varian `/trades/range` berbayar [R]. Juga trades per token (300 trade lintas pool) [R] | 200+ jaringan, 1.800+ DEX [R] | Real-time; histori trade pendek di tier gratis | Tidak | Keyless gratis; Demo (kunci gratis) 100 call/menit, 10.000/bulan, OHLCV onchain maks 6 bulan [R] | **Keyless ±10 call/menit** untuk endpoint GeckoTerminal, pool IP bersama, bukan untuk produksi/polling [R]; error 4xx/5xx ikut terhitung [R]. (Angka lama 30/menit sudah usang) | Demo: “Attribution required” [R]; ToS API: tampilkan “Powered by CoinGecko” [R] | Tidak (keyless) / Demo opsional | https://docs.coingecko.com/docs/keyless-public-api · https://docs.coingecko.com/reference/pool-trades-contract-address · https://docs.coingecko.com/demo/reference/pool-trades-contract-address · https://docs.coingecko.com/changelog · https://www.coingecko.com/en/api/pricing · https://www.coingecko.com/en/api_terms |
| **DexScreener** | Pair/pool/token lookup (`/latest/dex/pairs/{chainId}/{pairId}`, `/token-pairs/v1/{chainId}/{token}`, `/tokens/v1/{chainId}/{addrs≤30}`, search), token profiles, boosts [R]. **Tidak ada endpoint trade atau alamat trader** di referensi [R: daftar endpoint] | Banyak | Real-time | Tidak | Gratis | 60 rpm (profiles/boosts) / 300 rpm (pairs/tokens/search) [R] | Boleh komersial; dilarang membangun produk pesaing & resale [R] | Tidak | https://docs.dexscreener.com/api/reference · https://docs.dexscreener.com/api/api-terms-and-conditions |
| **Birdeye Data** | `/defi/v2/tokens/top_traders` [R], wallet PnL `/wallet/v2/pnl/multiple` (≤50 wallet per token, mulai 10 CU) [R], wallet tx list/portfolio [R] | 17–20+ chain (Solana utama; daftar EVM **belum terverifikasi**) | Real-time | Tidak | Standard (free) 30.000 CU/bln, 1 rps [R]; Lite $39 (2,5 jt CU, 15 rps), Starter $99 (8 jt), Premium $199 (20 jt, 50 rps), Business $499 [R; halaman beta menampilkan angka berbeda] | Grup Wallet API dibatasi tersendiri (30 rpm di satu dok) [R] | Atribusi/redistribusi **belum terverifikasi** (https://docs.birdeye.so/docs/terms) | Ya | https://birdeye.so/data-api/pricing · https://docs.birdeye.so/reference/get-wallet-v2-pnl-multiple · https://docs.birdeye.so/docs/per-api-rate-limit |
| **CoinGecko API (Demo)** | `/coins/{id}` → `platforms` & `detail_platforms` (`contract_address`, `decimal_place`) [R]; `/coins/list?include_platform=true` [R]; `/coins/{id}/tickers?exchange_ids=binance` (100/halaman) [R]; `/derivatives/exchanges/binance_futures?include_tickers=unexpired` dengan `contract_type`, kini `coin_id`/`target_coin_id` [R]; `/asset_platforms` [R] | — | — | — | Demo gratis 100/menit, 10.000/bulan [R] | lihat kiri | Wajib atribusi [R] | Ya (Demo) | https://docs.coingecko.com/reference/coins-id · https://docs.coingecko.com/reference/coins-id-tickers · https://docs.coingecko.com/reference/derivatives-exchanges-id · https://docs.coingecko.com/reference/coins-list |
| **Nansen API** | Smart Money: netflow(s), holdings, dex-trades, historical holdings, DCAs (Solana/Jupiter), perp trades (Hyperliquid) [R]; TGM `pnl-leaderboard`, `holders`, `flows`, `dex-trades` [R] | 37 jaringan; Smart Money netflow/dex-trades/holdings: Arbitrum, Avalanche, Base, BNB, Ethereum, HyperEVM, Linea, Mantle, Monad, Optimism, Polygon, Sei, Solana, Sonic, dll. [R] | Near real-time | Label Smart Money: 30D/90D/180D/2Y Smart Trader, Fund, dll.; kriteria berubah dan ambang numerik tidak dipublikasi [R] | Free: 100 kredit sekali + top-up harian ke 10 kredit; **Pro $49/bln (tahunan) / $69 (bulanan)**; tambahan $10 per 10.000 kredit [R]. Smart-money endpoint 5 kredit; `premium_labels=true` 150 kredit & hanya berbayar [R]. x402: $0,05/panggilan smart-money [R] | Free 15 rps/300 rpm; Pro 75 rps/1.500 rpm [R] | Lisensi **internal business purposes**; `address/labels`, smart-money holdings & dex-trades **dilarang** ditampilkan ke pelanggan/diredistribusi; endpoint lain boleh dengan atribusi “Powered by Nansen API” [R] | Ya | https://docs.nansen.ai/getting-started/credits · https://docs.nansen.ai/api/smart-money · https://docs.nansen.ai/reference/chains · https://docs.nansen.ai/guides/redistribution-guide · https://nansen.ai/legal/api |
| **Arkham Intel API** | Entitas/label, transfer, swaps, counterparties (≈135 operasi menurut katalog) [S] | Multi-chain | — | Label entitas (sumber Arkham) | Akses lewat **aplikasi** di arkm.com/api / intel.arkm.com/api, kunci dikirim via email [R]; harga tidak dipublikasi [S] | 20 rps umum / 1 rps endpoint berat [S, tidak resmi] | Hanya untuk operasi bisnis sendiri; dilarang sublisensi/redistribusi/menampilkan kompilasi [R] | Ya | https://info.arkm.com/announcements/the-new-arkham-api · https://arkm.com/api-terms-of-service |
| **DeBank Cloud OpenAPI** | Portofolio/riwayat wallet multi-chain | EVM | Real-time | Tidak (protokol) | Prabayar: 1 jt unit = 200 USDC; biaya per endpoint dalam unit (mis. 30/50/4) [R]; unit `history_list` **belum terverifikasi** | — | Perubahan harga diumumkan ≥3 bulan sebelumnya [R] | Ya | https://cloud.debank.com/ · https://docs.cloud.debank.com/en/readme/open-api |
| **Cielo** | Feed wallet, PnL, related wallets [S: klien Go tidak resmi] | 25–30+ chain [S] | — | — | **belum terverifikasi** (hanya sumber sekunder: Builder $89/bln) | — | — | Ya | developer.cielo.finance (tidak terverifikasi) |
| **GMGN** | **Tidak ada API data publik resmi yang terverifikasi.** Sumber sekunder menyebut Agent API/`gmgn-cli` (kunci Ed25519, IP whitelist) dan whitelist IP crawling hanya untuk pengguna dengan riwayat transaksi GMGN [S] | — | — | — | — | — | Scraping situs web: **jangan** (ToS & etika) | — | belum terverifikasi |
| **Etherscan name tags** | Lihat Etherscan: `getaddresstag` hanya **Pro Plus**; ekspor hanya Enterprise [R]. Tidak ada lisensi data label publik | — | — | — | — | — | Scraping label situs: melanggar semangat ToS (belum terverifikasi pasal spesifik) | — | https://docs.etherscan.io/api-reference/endpoint/getaddresstag |

### 2.3 Uji konektivitas yang perlu dijalankan di Mac pengguna

```bash
for u in \
 "https://api.geckoterminal.com/api/v2/networks?page=1" \
 "https://api.geckoterminal.com/api/v2/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades" \
 "https://api.dexscreener.com/latest/dex/search?q=PEPE" \
 "https://eth.blockscout.com/api/v2/stats" "https://base.blockscout.com/api/v2/stats" \
 "https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethprice" \
 "https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api?module=stats&action=ethprice" \
 "https://api.coingecko.com/api/v3/ping" "https://api.llama.fi/protocols" \
 "https://api.binance.com/api/v3/ping" "https://fapi.binance.com/fapi/v1/ping"; do
  printf '%s -> ' "$u"; curl -sS -m 15 -o /dev/null -w '%{http_code}\n' "$u"; done
# Kunci atribut trade GeckoTerminal yang sebenarnya:
curl -sS "https://api.geckoterminal.com/api/v2/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s).data[0].attributes)))'
```

(Pool contoh = Uniswap V3 USDC/WETH 0.05% di Ethereum; alamat dari pengetahuan umum, verifikasi via respons.)

**Field trade GeckoTerminal yang terverifikasi dari dokumentasi/klien:** `tx_from_address` [R, contoh respons
dok CoinGecko], `kind` (`buy`/`sell`), `volume_in_usd`, `block_timestamp` [GH: README klien
`dineshpinto/geckoterminal-api`]. Dok resmi juga menyebut nomor blok, hash transaksi, jumlah token from/to, harga
USD, dan alamat token from — **nama persis field-field tersebut belum terverifikasi dari respons live** (perkiraan
umum: `block_number`, `tx_hash`, `from_token_amount`, `to_token_amount`, `price_from_in_usd`, `price_to_in_usd`,
`from_token_address`, `to_token_address`). Kode adapter wajib membaca field secara defensif dan mencatat kunci
yang tidak dikenal.

Catatan penting: `tx_from_address` adalah **pengirim transaksi (EOA)**, bukan selalu “pemilik” swap — bisa
relayer, bot, solver aggregator (CoW/1inch Fusion/UniswapX) atau smart account (ERC-4337 bundler). Hal sama berlaku
untuk `tx_from` di Dune (“biasanya trader, tapi bisa keeper atau bot arbitrase” [R]).

---

## 3. Metodologi penilaian wallet & deteksi bot / MM / CEX / airdrop / wallet terkait

### 3.1 Unit analisis & PnL

- **Posisi per (wallet, chain, token).** Hanya event yang diklasifikasi `SWAP` (bagian 4) yang membentuk lot beli
  dan menutup lot jual. Transfer masuk/airdrop/bridge **tidak** membuat cost basis harga pasar; lot seperti itu diberi
  `costBasisUsd = null` dan posisi ditandai `pnlIncomplete` (sesuai prinsip 8 dokumen 15: null ≠ 0).
- **Metode biaya:** pakai **FIFO** sebagai default (deterministik, mudah diuji, cocok dengan konvensi
  pelaporan pajak di banyak yurisdiksi) dan simpan **average cost** sebagai pembanding. Laporkan selisihnya; bila
  besar, itu tanda pola trading berlapis. (Moralis hanya menghitung **realized** PnL, tanpa gas [R]; Codex hanya
  menghitung win/loss untuk posisi tertutup dengan |PnL| > $1 [R] — dua konvensi industri yang berguna sebagai
  acuan.)
- **Realized vs unrealized:** skor kualitas terutama dari **realized** (tertutup). Unrealized hanya untuk
  tampilan “sedang mengakumulasi”, dihitung dengan harga saat ini dan ditandai sumber + umur harga.
- **Biaya:** gas & fee DEX dicatat terpisah; untuk wallet frekuensi tinggi gas bisa membalik tanda PnL.
- **Token quote** (WETH, USDC, USDT, SOL, WBNB) tidak dihitung sebagai posisi spekulatif; swap quote↔quote diabaikan.

### 3.2 Skor wallet (anti “satu trade beruntung”)

Komponen yang disarankan (semua dengan interval/jumlah sampel ditampilkan):

1. **Jumlah posisi tertutup independen** `n` (token berbeda, tidak tumpang tindih waktu berlebihan). Minimum
   tampil sebagai “berkualitas”: misalnya `n ≥ 10` dalam 90 hari dan `≥ 3` token berbeda (ambang adalah keputusan
   desain, bukan dari literatur; disetel lewat evaluasi historis).
2. **Win rate yang disusutkan (Bayesian shrinkage).** Gunakan prior Beta yang diestimasi dari populasi (empirical
   Bayes): `wr_shrunk = (wins + α) / (n + α + β)`. Wallet dengan sedikit trade otomatis ditarik ke rata-rata
   populasi. Rujukan: David Robinson, *Introduction to Empirical Bayes* / seri “Understanding empirical Bayes
   estimation (using baseball statistics)” (https://www.r-bloggers.com/2015/09/understanding-empirical-bayes-estimation-using-baseball-statistics/);
   Efron & Morris (James–Stein) — konteks di https://arxiv.org/pdf/0803.3697.pdf. Robinson juga mencatat bahwa
   jumlah sampel berkorelasi dengan kualitas (beta-binomial regression) — relevan: wallet aktif cenderung bot.
3. **Return per trade terdistribusi, bukan total PnL.** Pakai median return dan **expectancy** (rata-rata R),
   batasi kontribusi satu trade (mis. winsorize persentil 95 atau “PnL tanpa trade terbaik” harus tetap positif).
4. **Konsistensi lintas periode:** bagi histori ke jendela (mis. 4 × 30 hari); hitung proporsi jendela dengan
   realized PnL > 0. Nansen sendiri membedakan label 30D/90D/180D/2Y dan menyebut label jangka pendek menuntut win
   rate lebih tinggi, label jangka panjang menuntut profit lebih besar & diversifikasi token [R:
   https://academy.nansen.ai/articles/2132837-smart-money-101].
5. **Max drawdown** pada kurva realized PnL kumulatif wallet (dan rasio PnL/drawdown).
6. **Gaya & holding time:** median durasi posisi (detik → sniper/bot; jam → scalper; hari–minggu → swing). Untuk
   AlphaLens (LONG 5m/15m/1H di perp Binance), gaya swing/akumulasi multi-jam paling relevan; sniper blok-pertama
   kurang bisa ditiru.
7. **Koreksi seleksi:** bila memilih “top N” dari ribuan wallet, skor teratas sebagian besar keberuntungan.
   Konsep Deflated Sharpe Ratio dan Probability of Backtest Overfitting (Bailey & López de Prado,
   https://papers.ssrn.com/abstract=2460551 , https://papers.ssrn.com/abstract=2326253) — terapkan secara
   semangat: semakin banyak wallet disaring, semakin tinggi ambang yang dibutuhkan, dan validasi out-of-sample.
8. **Hindari:** ranking berdasar win rate saja (mudah dimanipulasi dengan banyak profit kecil + satu rugi besar),
   total PnL saja (didominasi satu trade / modal besar), dan ROI saja (wallet kecil).

Skor akhir = kombinasi terbobot komponen yang sudah dinormalisasi, plus **penalti flag** (3.3). Skor bukan
probabilitas (prinsip 5 dokumen 15).

### 3.3 Heuristik flag (wallet yang harus dikeluarkan / diberi bobot rendah)

| Flag | Sinyal yang bisa dihitung | Rujukan / catatan |
|---|---|---|
| **MEV / sandwich bot** | Dua swap berlawanan arah di **blok yang sama** mengapit swap korban di pool yang sama; `tx_to` kontrak non-router yang sama berulang; profit dalam token quote; frekuensi sangat tinggi | Qin, Zhou, Gervais, “Quantifying Blockchain Extractable Value: How dark is the forest?”, IEEE S&P 2022, https://arxiv.org/pdf/2101.05511 ; `flashbots/mev-inspect-py` (MIT, **diarsipkan 2024-11-27**) [GH] |
| **Arbitrase / bot** | Banyak swap per blok, siklus token yang kembali ke token awal dalam satu tx, holding time ≈ 0, tx dikirim lewat kontrak milik sendiri | Label `bot` di Codex [R] sebagai pembanding |
| **Market maker** | Beli & jual token yang sama dalam jumlah seimbang, inventory berputar di sekitar nol, banyak pool/token, pasangan dengan alamat CEX | Heuristik; tidak ada standar publik |
| **CEX hot wallet / deposit address** | Label dari daftar (bagian 7); pola “deposit address”: alamat menerima dana lalu **cepat meneruskan** hampir seluruhnya ke hot wallet exchange yang sama (parameter selisih jumlah & selisih waktu) | Victor (2020) “Address Clustering Heuristics for Ethereum”, Financial Cryptography 2020 (deposit address reuse, airdrop multi-participation, token self-authorization) — dijelaskan ulang di Tutela https://arxiv.org/pdf/2201.06811 dan https://arxiv.org/pdf/2203.09360 . Metadata bibliografis lengkap (volume LNCS/halaman) **belum terverifikasi** |
| **Airdrop farmer / Sybil** | Banyak wallet dengan sumber dana sama (`funded-by`), pola aktivitas identik, menerima airdrop lalu mengkonsolidasikan ke satu alamat dalam waktu singkat | “Fighting Sybils in Airdrops” https://arxiv.org/pdf/2209.04603 ; Trusta (Louvain/K-Core pada graf transfer) https://ethresear.ch/t/trusta-s-ai-and-machine-learning-framework-for-robust-sybil-resistance-in-airdrops/16828 ; Victor 2020 (airdrop multi-participation) |
| **Kontrak / smart account** | Alamat punya bytecode (`eth_getCode` ≠ `0x`) — bisa router, vault, Safe, ERC-4337 account; perlakukan berbeda dari EOA | — |
| **Deployer / insider token** | Wallet yang mendanai deployer, menerima alokasi dari deployer, atau membeli di blok pembuatan pool | Codex label `SNIPER` [R] sebagai pembanding |
| **Wash trading** | Beli-jual bolak-balik antar wallet dalam satu klaster dengan volume besar tanpa perubahan posisi bersih | — |

### 3.4 Klaster wallet terkait

- **Sumber dana bersama:** transfer native pertama yang masuk (Helius `funded-by` untuk Solana [R], hitung sendiri
  di EVM dari tx pertama). Pengecualian: sumber dana berupa CEX hot wallet / bridge **bukan** bukti keterkaitan.
- **Deposit address reuse** (Victor 2020): beberapa EOA yang mengirim ke alamat deposit CEX yang sama kemungkinan
  satu pemilik.
- **Self-authorization:** `approve` dari satu EOA ke EOA lain lalu `transferFrom` (Victor 2020).
- **Pola waktu & ukuran:** beli token yang sama dalam blok/menit yang sama dengan ukuran mirip.
- Output klaster selalu “dugaan + bukti + confidence”; untuk radar, **beberapa wallet satu klaster dihitung sebagai
  satu pembeli independen** (`minIndependentBuyers` di `evaluate.js`).

---

## 4. Klasifikasi aktivitas — sinyal data yang dibutuhkan

| Kelas | Sinyal minimum (EVM) | Sinyal minimum (Solana) | Catatan |
|---|---|---|---|
| **SWAP (beli/jual)** | Dalam satu tx, wallet **mengirim** token A dan **menerima** token B (log ERC-20 `Transfer` / native value / WETH Deposit-Withdrawal), dan ada event `Swap` dari pool DEX dikenal (Uniswap V2 `Swap`, V3 `Swap`, Curve `TokenExchange`, dsb.) atau `tx_to` = router/aggregator dikenal | Helius `type=SWAP` + `source` (JUPITER/RAYDIUM…) [R] atau perubahan saldo token per tx (pre/post token balances) dengan program DEX dikenal | Beli = menerima token non-quote dan membayar quote. Aggregator/solver: pengirim tx bisa berbeda dari penerima token — pakai penerima token akhir |
| **TRANSFER masuk/keluar** | Hanya satu arah `Transfer` tanpa token balik | `type=TRANSFER` | Bukan beli/jual; transfer masuk tanpa cost basis → `pnlIncomplete` |
| **Deposit ke CEX** | Transfer keluar ke alamat berlabel CEX atau ke “deposit address” terdeteksi | Sama, label alamat CEX Solana | **Indikasi keluar/penjualan potensial**, bukan penjualan (prinsip 4 dok 15) |
| **Penarikan dari CEX** | Transfer masuk dari hot wallet CEX | Sama | Bukan pembelian on-chain; harga beli tidak diketahui |
| **BRIDGE** | Interaksi dengan kontrak bridge dikenal (event Deposit/Lock/Burn) + transfer keluar tanpa token balik di chain sama; pasangan masuk di chain tujuan | Wormhole/deBridge dsb. | Daftar kontrak bridge: DefiLlama bridges (repo `bridges-server` akan diarsipkan, adapter pindah ke `dimension-adapters` [GH]); lisensi kedua repo **belum terverifikasi** (tidak ada file LICENSE di halaman) |
| **AIRDROP / klaim** | Transfer masuk dari kontrak distributor (fungsi `claim`, Merkle distributor) tanpa pembayaran; atau mint dari zero address | Kategori Airdrop di Moralis sebagai pembanding [R] | Cost basis 0? **Tidak** — simpan null & tandai “airdrop”; jangan masuk ke win rate |
| **LP add/remove** | Event `Mint`/`Burn` (V2), `IncreaseLiquidity`/`DecreaseLiquidity` (V3 NonfungiblePositionManager), penerimaan LP token/NFT | Program AMM add/remove liquidity | Bukan beli/jual; keluar LP bisa menghasilkan token tanpa swap |
| **Mint/Burn, Approve, Wrap** | `Transfer` dari/ke `0x0`; `Approval`; WETH `Deposit`/`Withdrawal` | — | Wrap/unwrap bukan trade |
| **Lending (borrow/repay)** | Event protokol lending (Aave, dsb.) | — | Token pinjaman yang dijual adalah short sintetis — tandai |

Data yang dibutuhkan per tx: `hash`, `blockNumber`, `blockTime`, `from`, `to`, `logIndex` + semua log `Transfer`
dan event pool, alamat kontrak, decimals token, dan daftar kontrak terkenal (router, pool factory, bridge, CEX).
Etherscan `tokentx` memberi transfer ERC-20 per alamat tapi **tidak** memberi event `Swap`; klasifikasi swap dari
`tokentx` saja dilakukan dengan mengelompokkan transfer per `hash` (keluar A + masuk B dalam satu hash) — cukup
akurat untuk EOA, kurang untuk aggregator/smart account.

---

## 5. Pemetaan ke pasar Binance (chain + contract)

### 5.1 Sumber resmi

1. **`GET /sapi/v1/capital/config/getall`** — “All Coins' Information (USER_DATA)” [R:
   https://developers.binance.com/docs/wallet/capital]. Butuh **API key + signature HMAC** (USER_DATA = signed)
   [R: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security]. Izin default kunci
   baru adalah **Enable Reading** [R: https://developers.binance.com/docs/derivatives/quick-start] — cukup; jangan
   aktifkan trading/withdraw. Setiap koin punya `networkList[]` dengan `network`, `isDefault`, `depositEnable`,
   `withdrawEnable`, `contractAddress`, `contractAddressUrl`, dll.; satu koin bisa punya beberapa jaringan dengan
   kontrak berbeda [R]. Bobot request (weight) **belum terverifikasi**. Kunci tanpa batasan IP hanya bisa “reading”
   — itu justru yang diinginkan. Verifikasi izin kunci secara programatik: `GET /sapi/v1/account/apiRestrictions`
   (`enableReading`, `ipRestrict`, …) [R].
2. **Binance Alpha Token List** (publik, tanpa kunci): `/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list`
   → `chainId`, `contractAddress`, `alphaId` [R: https://developers.binance.com/docs/alpha/market-data/rest-api/token-list].
   Hanya token Binance Alpha — pelengkap, bukan pengganti.
3. **USDⓈ-M `GET /fapi/v1/exchangeInfo`**: `symbol`, `pair`, `contractType` (PERPETUAL), `baseAsset`,
   `quoteAsset`, `marginAsset`, `underlyingType`, `underlyingSubType`, `status` [R:
   https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information].
   **Tidak** memuat contract address.
4. Endpoint tidak resmi `www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll` (dipakai web Binance)
   **tidak terdokumentasi**. Awalnya tidak dipakai; sejak 2026-10-26 dipakai sebagai sumber **tanpa kunci**
   (`binance-public`) untuk pengguna tanpa kunci Binance, dengan pembacaan defensif dan cadangan — lihat §9.3.
5. **Cross-check CoinGecko:** `/derivatives/exchanges/binance_futures?include_tickers=unexpired` → ticker perp
   dengan `contract_type: "perpetual"` dan (changelog) `coin_id` [R]; lalu `/coins/{coin_id}` → `platforms`
   (map `asset_platform_id → contract_address`) [R]. Juga `/coins/{id}/tickers?exchange_ids=binance` untuk spot [R].

### 5.2 Algoritma pemetaan yang disarankan (mengisi `mappingRows` dok 15)

1. Ambil `getall` → untuk setiap `coin` dan setiap `networkList[i]` dengan `contractAddress` non-kosong, buat baris
   kandidat `(chain = normalisasi(network), contractAddress = lowercase untuk EVM / apa adanya untuk Solana,
   binanceAsset = coin)`. Tabel normalisasi jaringan Binance → id chain internal dikelola manual (mis. `ETH`→
   `ethereum`, `BSC`→`bsc`, `BASE`→`base`, `ARBITRUM`→`arbitrum`, `OPTIMISM`→`optimism`, `MATIC`/`POLYGON`→`polygon`,
   `SOL`→`solana`) — nilai persis kode jaringan Binance **harus dibaca dari respons**, jangan ditebak.
2. Ambil `exchangeInfo` spot & USDⓈ-M. Untuk perp, turunkan `binanceAsset` dari `baseAsset` dengan tabel pengali
   eksplisit: `1000PEPE`→`PEPE` ×1000, `1000SHIB`, `1000BONK`, `1000FLOKI`, `1MBABYDOGE`→×1.000.000, dll.
   **Jangan** strip prefix dengan regex buta: ada aset yang namanya memang diawali angka. Simpan `multiplier`
   eksplisit di baris mapping (dok 15 sudah mensyaratkan ini). (Peluncuran 1000PEPEUSDT USDⓈ-M: pengumuman resmi
   https://www.binance.com/en/support/announcement/binance-futures-will-launch-usd%E2%93%A2-m-1000pepe-perpetual-contract-with-up-to-20x-leverage-41993e3389654713946bcb6b9b032eaf;
   ukuran pengali per kontrak **belum terverifikasi** dari tabel spesifikasi — verifikasi dengan membandingkan harga
   perp vs spot.)
3. Silang-cek dengan CoinGecko: kontrak dari Binance harus muncul di `platforms` koin CoinGecko yang ticker
   Binance-nya cocok. Hasil: `source = 'binance+coingecko'` (kuat), `'binance'` (sedang), `'coingecko'` saja (lemah,
   tidak dipakai untuk menautkan sinyal).
4. Status `MATCHED` hanya bila `(chain, contractAddress)` sama persis. Simbol sama tanpa kontrak cocok →
   `SYMBOL_ONLY`. Lebih dari satu baris → `AMBIGUOUS`.
5. Segarkan harian dan simpan `verifiedAt`; perubahan kontrak (migrasi token) memicu peringatan.

### 5.3 Jebakan

- **Simbol sama, token berbeda** (banyak token “PEPE”/“AI” palsu di DEX). Selalu pakai kontrak.
- **Prefix pengali** (`1000PEPEUSDT`, `1MBABYDOGEUSDT`): harga perp = harga token × pengali; volume/qty juga.
- **Rebrand/migrasi kontrak** (mis. ticker diganti, token v2 dengan kontrak baru): `getall` hanya menunjukkan
  kontrak yang saat ini didukung deposit/withdraw; kontrak lama tidak lagi cocok.
- **Banyak jaringan**: satu aset Binance dapat ada di ETH, BSC, Base, Solana dengan kontrak berbeda; token
  *bridged* (wrapped oleh bridge pihak ketiga) **bukan** token yang sama kecuali Binance mencantumkannya.
- **Jaringan dinonaktifkan sementara** (`depositEnable=false`) tetap valid untuk pemetaan identitas, tapi tandai.
- **Native coin** (ETH, BNB, SOL) tidak punya kontrak; petakan ke wrapped (WETH/WBNB/WSOL) secara eksplisit.
- **Perp tanpa spot** dan **spot tanpa perp**: AlphaLens LONG-first di perp → token tanpa perp = “tidak relevan untuk
  sinyal”, tetap boleh ditampilkan di radar.
- **Geo-block**: dari IP cloud riset ini `fapi.binance.com` menjawab 451. Jalankan dari Mac.

---

## 6. Bias evaluasi historis & cara menghindarinya

| Bias | Bentuk dalam “smart money” | Pencegahan |
|---|---|---|
| **Look-ahead** | Memilih wallet berdasarkan PnL seluruh histori (termasuk masa depan) lalu “membuktikan” bahwa mengikuti mereka menguntungkan. Label smart money vendor dihitung **hari ini** atas histori penuh — memakai label vendor saat ini untuk backtest masa lalu = bocor | `evaluate.js` (dok 15): skor pada waktu `t` hanya dari trade tertutup `< t`; harga masuk = `priceAt(t)`; tes kebocoran (ubah data setelah `t` tidak mengubah sinyal). Jangan pakai label vendor terkini untuk periode historis |
| **Survivorship** | Hanya wallet yang masih aktif/untung hari ini yang masuk sampel; wallet yang bangkrut/tidak aktif hilang. Token yang delisting/rug hilang dari data harga | Universe wallet di `t` = semua wallet yang memenuhi syarat **pada saat itu**, termasuk yang kemudian rugi/berhenti. Token tanpa harga di horizon → catat sebagai “harga hilang”, jangan dibuang diam-diam |
| **Selection / multiple testing** | Menyaring ribuan wallet → teratas sebagian besar keberuntungan | DSR / PBO (Bailey & López de Prado) secara konsep; walk-forward; laporkan jumlah wallet/parameter yang diuji |
| **Persistensi rendah** | Contoh praktisi (copy-trading Polymarket): korelasi Spearman peringkat wallet periode ke periode berikutnya hanya −0,09 s.d. +0,15 [S: https://dev.to/ekocam/backtesting-a-polymarket-copy-trading-bot-without-fooling-yourself-4fec] | Ukur persistensi peringkat di data sendiri sebelum percaya skor |
| **Latensi eksekusi** | Sinyal muncul setelah blok terkonfirmasi + latensi API; harga sudah bergerak | Harga masuk = harga **setelah** waktu data tersedia (`asOf` provider), bukan waktu blok |
| **Literatur dana** | Brown dkk. (1992) dan Carpenter & Lynch (1999): survivorship & look-ahead memalsukan bukti persistensi kinerja reksa dana | Rujukan konsep (dikutip via sumber sekunder di atas; teks asli belum dibaca) |
| **Baseline** | “Smart money membeli lalu harga naik” juga terjadi pada semua pembeli di pasar naik | Bandingkan dengan baseline semua token yang dibeli di jendela sama (sudah ada di `evaluate.js`) |

---

## 7. Proyek & dataset open source relevan (lisensi)

Aplikasi AlphaLens privat (UNLICENSED): MIT/Apache/BSD aman; GPL/AGPL/BSL = **tandai**, jangan disalin ke kode.

| Proyek | Isi | Lisensi | Status / catatan | Keputusan |
|---|---|---|---|---|
| `duneanalytics/spellbook` | `dex.trades`, `cex` addresses (`_sector/cex/addresses`, `deposit_addresses`), `labels`, bridge | **Business Source License 1.1**; Additional Use Grant: boleh dipakai asal **bukan untuk “Data or Analytics Platform”**; Change Date 2027-03-03 → GPL-3.0+ [GH: LICENSE] | Aktif | **Tandai.** Jangan salin daftar alamat ke repo. Menjalankan query lewat Dune API tunduk ToS Dune (bagian 2.1). Pemakaian sebagai referensi konsep saja |
| `dawsbot/eth-labels` | 170k+ label akun & token, chain: Ethereum, Base, Arbitrum, Optimism, BSC, Gnosis, Celo; API lokal + MCP | MIT (kode) [GH] | Data **di-scrape dari Etherscan** (scraper login ke Etherscan) [GH] — lisensi MIT tidak otomatis memberi hak atas data Etherscan | Boleh sebagai **label berkepercayaan rendah** dengan `source: 'eth-labels (etherscan scrape)'`; jangan tampilkan sebagai fakta |
| `brianleect/etherscan-labels` | 45.198 label, 7 chain (ETH, BSC, Polygon, OP, Arbitrum, Fantom, Avalanche) | MIT [GH] | **Basi**: scrape terakhir 2023-03/2023-06; README “Currently broken” [GH] | Hanya untuk CEX/bridge besar yang alamatnya stabil; verifikasi silang |
| `flashbots/mev-inspect-py` | Klasifikasi swap, arbitrase, pembayaran miner | MIT [GH] | **Diarsipkan 2024-11-27**, deprecated [GH] | Referensi algoritma deteksi arbitrase/sandwich (tulis ulang di JS) |
| `paradigmxyz/cryo` | Ekstraksi `logs`, `erc20_transfers`, `native_transfers`, `traces`, dll. via JSON-RPC | MIT **atau** Apache-2.0 [GH] | Aktif | Alat opsional bila nanti memakai RPC sendiri; bukan dependensi runtime |
| `blockchain-etl/ethereum-etl` | Ekspor blok, tx, transfer token, log, traces | MIT [GH] | Pengembangan berlanjut (tanpa status resmi) | Referensi skema |
| `rotki/rotki` | Pelacakan portofolio, PnL, decoding transaksi | **AGPL-3.0** (ada lisensi komersial alternatif) [GH] | Aktif | **Jangan salin kode**; hanya baca konsep di dokumentasi |
| `blockscout/blockscout` | Explorer | “Blockscout Software Licence” [GH] | — | Hanya dipakai sebagai API |
| `DefiLlama/bridges-server` → `DefiLlama/dimension-adapters` | Adapter bridge (event deposit/withdraw) | **belum terverifikasi** (tidak ada LICENSE terlihat) [GH] | `bridges-server` akan diarsipkan [GH] | Referensi daftar kontrak bridge; verifikasi lisensi sebelum menyalin data |
| `dineshpinto/geckoterminal-api` (Python) | Klien GeckoTerminal; contoh field trade | belum dicek | — | Referensi nama field |

Daftar lain yang diminta (“OpenSea-free lists”, label CEX publik lain): **belum terverifikasi** — tidak ditemukan
sumber resmi berlisensi jelas dalam riset ini.

---

## 8. Keputusan & kredensial dari pengguna, estimasi biaya, urutan integrasi

### 8.1 Keputusan yang dibutuhkan

1. **API key Binance read-only** (Enable Reading saja, tanpa trading/withdraw; idealnya batasi IP Mac) untuk
   `getall`. **Opsional sejak 2026-10-26:** tanpa kunci dipakai endpoint publik `getNetworkCoinAll` (§9.3); kunci
   read-only tetap didahulukan bila diisi.
2. **Chain prioritas awal:** usul **Ethereum + Base + Solana** (+ BNB Chain bila sanggup berbayar). BNB Chain di
   Etherscan memerlukan paket berbayar; alternatif gratis: Routescan / instance Blockscout (uji dulu).
3. **Etherscan free vs Lite (±$49/bln)** — Lite membuka chain berbayar? (**belum terverifikasi** apakah Lite
   mencakup semua chain; halaman Etherscan: paket berbayar = semua chain [R]).
4. **Helius free vs Developer ($49/bln)** untuk Solana (Developer membuka `funded-by` & `identity`).
5. **Label berbayar:** Nansen Pro ($49–69/bln) — hanya untuk tampilan pribadi; setuju dengan batasan redistribusi?
   Atau tanpa label vendor (label sendiri + daftar open source berkepercayaan rendah).
6. **PnL vendor sebagai pembanding:** Codex free (10k/bln, $1) dan/atau Birdeye Lite ($39) — atau hitung sendiri
   saja.
7. **Atribusi di UI**: “Powered by CoinGecko” (wajib Demo/keyless), atribusi Etherscan free, “Powered by Nansen
   API” bila dipakai.
8. **Ambang skor** (`n` minimum, jendela) disetel lewat `evaluate.js`, bukan ditebak — setuju untuk menjalankan
   evaluasi historis dulu sebelum menampilkan “berkualitas”?

### 8.2 Estimasi biaya bulanan

| Opsi | Komponen | Estimasi/bln |
|---|---|---|
| **Minimum (gratis)** | Binance read-only key; GeckoTerminal keyless (~10/menit) atau CoinGecko Demo (100/menit, 10k/bln); Etherscan free (ETH, Arbitrum, Polygon, …); Routescan keyless/free key; Blockscout per-instance; Helius free (1 jt kredit); label open source + heuristik sendiri | **$0** (+$1 sekali bila Codex) |
| **Direkomendasikan** | Minimum + Etherscan Lite (±$49, chain berbayar spt BNB/Base — verifikasi) + Helius Developer ($49) + Nansen Pro ($49 tahunan / $69 bulanan) | **±$147–167** |
| **Lengkap (Solana PnL & top traders)** | Rekomendasi + Birdeye Lite ($39) | **±$186–206** |
| Tidak disarankan untuk awal | Moralis ($149+, PnL hanya 3 chain), Solscan Pro ($199), Etherscan Pro Plus (±$809, label), Arkham (aplikasi, harga tak publik), Dune Plus ($399), DeBank (prabayar) | — |

### 8.3 Urutan integrasi yang disarankan

1. **Pemetaan Binance** (`getall` + `exchangeInfo` spot & USDⓈ-M + tabel pengali + cross-check CoinGecko) →
   `binanceMatch.js`. Tanpa ini radar tidak bisa ditautkan ke sinyal.
2. **Penemuan wallet keyless**: trades GeckoTerminal untuk pool utama token yang `MATCHED` → kandidat
   `tx_from_address` (filter USD minimum, buang kontrak/router/bot jelas).
3. **Riwayat wallet EVM**: Etherscan V2 `tokentx` (chain free) + Routescan/Blockscout untuk chain lain → `RawTransfer`
   → `classify.js` (kelompokkan per hash).
4. **Label dasar**: CEX hot wallet & bridge (daftar kecil yang diverifikasi manual + eth-labels berkepercayaan
   rendah) → deteksi deposit address.
5. **PnL & skor** (`pnl.js` FIFO, `walletFlags.js`, `walletScore.js` dengan shrinkage) + **evaluasi historis**
   (`evaluate.js`) sebelum UI menyebut wallet “berkualitas”.
6. **Solana** via Helius (`getTransactionsForAddress` / Wallet API history).
7. **Opsional berbayar**: Nansen (smart-money dex-trades/netflow sebagai sumber kandidat & pembanding), Codex/
   Birdeye sebagai pembanding PnL.
8. **Watchlist & alert** di atas data yang sudah tervalidasi; setiap alert membawa provider, umur data, dan
   keterbatasan.

---

## 9. Pembaruan 2026-10-26 — jalur Etherscan-saja (tanpa kunci Binance)

Pertanyaan riset: apakah Smart Money Radar bisa berjalan penuh hanya dengan `ETHERSCAN_API_KEY` gratis? Hasilnya
dipakai untuk provider `binance-public`, metode `trendingTokens` GeckoTerminal, dan mode otomatis (docs/15 §3–4,
docs/17 §5a). Tingkat verifikasi memakai legenda §0; lingkungan cloud tetap tidak menjangkau host vendor, jadi
semua bentuk respons diverifikasi lewat `npm run smart-money:check` di Mac.

### 9.1 Etherscan API V2 — batas paket gratis yang relevan

| Fakta | Dampak ke AlphaLens | Sumber |
|---|---|---|
| **Akses gratis untuk Base (8453), BNB Chain (56), OP Mainnet (10), dan Avalanche C-Chain (43114) dihentikan pada November 2025**; permintaan paket gratis ke chain tersebut ditolak dengan pesan `free API access is not supported for this chain` | Paket gratis Etherscan dipakai untuk Ethereum, Arbitrum, Polygon saja; Base, Optimism, BNB Chain lewat Routescan (tanpa kunci). Pesan itu dipetakan ke `NOT_SUPPORTED` (⚪ di cek), bukan `UNAUTHORIZED` | [R] https://info.etherscan.com/whats-changing-in-the-free-api-tier-coverage-and-why/ ; [S] berita CCN dan Yahoo Finance (November 2025) yang melaporkan perubahan cakupan chain paket gratis |
| Maks. **1.000 rekaman per respons** di paket gratis sejak **2026-07-01** (sebelumnya 10.000) | Paginasi `tokentx`/`txlist` memakai halaman ≤ 1.000; sinkron pertama riwayat 180 hari wallet aktif butuh beberapa putaran | [S] blog Blockscout mengutip changelog Etherscan (lihat §2.1) |
| `tokenholderlist` dan `topholders` (daftar pemegang token) berlabel **API PRO** — tidak tersedia di paket gratis | Penemuan wallet tidak bisa berangkat dari "pemegang teratas token" lewat Etherscan gratis; dipakai trade pool GeckoTerminal | [R] dok endpoint Etherscan (`module=token&action=tokenholderlist`, `action=topholders`) |
| `getLogs` (`module=logs&action=getLogs`) **tersedia di paket gratis** | Opsi masa depan: pembeli awal dari log `Transfer`/`Swap` per kontrak tanpa endpoint PRO (belum dipakai) | [R] dok endpoint Etherscan `logs` |

### 9.2 GeckoTerminal — pool trending tanpa kunci

- `GET https://api.geckoterminal.com/api/v2/networks/{network}/trending_pools` — pool trending per jaringan,
  **tanpa kunci**, kuota keyless yang sama (±10 panggilan/menit, pool IP bersama; AlphaLens memakai 6/menit) [R:
  https://docs.coingecko.com/docs/keyless-public-api, referensi "Trending Pools by Network"]. Bentuk
  `data[].relationships.base_token/quote_token.data.id` (`{network}_{address}`) sama dengan endpoint pool lain [R].
- Dipakai **hanya sebagai cadangan** penemuan wallet bila belum ada token MATCHED: satu chain per putaran (bergiliran)
  agar kuota keyless tidak habis. Token trending sering token baru yang **belum tentu listing di Binance** — kandidatnya
  ditandai `geckoterminal-trending`. Atribusi "Powered by CoinGecko / GeckoTerminal" tetap berlaku (§2.2).

### 9.3 Binance `bapi` `getNetworkCoinAll` — pemetaan kontrak tanpa kunci

- `GET https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll` mengembalikan daftar koin +
  `networkList[]` (`network`, `contractAddress`, …) seperti `getall`, **tanpa saldo dan tanpa tanda tangan**. Endpoint
  ini dipakai halaman deposit/penarikan binance.com dan dirujuk beberapa proyek open source, tetapi **tidak
  terdokumentasi** di developers.binance.com [belum terverifikasi secara resmi — tidak ada halaman dok].
- Konsekuensi desain: dibaca **defensif** (`{ code: "000000", data: [...], success: true }` atau array langsung; selain
  itu `BAD_RESPONSE`), tidak pernah menerima kunci, dan diverifikasi tiap kali lewat `npm run smart-money:check`
  (PEPE → `1000PEPEUSDT` ×1000). Bila berubah/diblokir, penemuan jatuh ke cadangan trending (§9.2) dan pengguna
  disarankan mengisi kunci read-only (`getall`, §5.1 butir 1), yang tetap **didahulukan** bila diisi.
- Dari IP cloud riset endpoint `bapi` tidak terjangkau (proxy 403, §0.1); bentuk respons belum direkam langsung.

### 9.4 Riset open source: penemuan smart money hanya dengan Etherscan

- Tidak ditemukan repositori yang **masih dirawat** dan melakukan penemuan smart money hanya dengan Etherscan (tanpa
  data DEX/label berbayar). Proyek yang ada umumnya skrip sekali pakai, basi, atau bergantung pada Dune/Nansen/Birdeye
  [GH, pencarian GitHub 2026-10-26].
- Teknik yang paling umum: **pembeli awal (early buyers)** — ambil `tokentx` per kontrak token (`module=account&
  action=tokentx&contractaddress=…`), urutkan dari blok awal, kumpulkan penerima transfer dari pool/router di jam-jam
  pertama, lalu nilai riwayat wallet tersebut; dikombinasikan antar beberapa token untuk mencari wallet yang
  berulang kali masuk awal. Batas 1.000 rekaman/respons (§9.1) membuat teknik ini mahal untuk token ramai. AlphaLens
  tidak memakainya sekarang (trade pool GeckoTerminal sudah memberi `tx_from_address` dengan nilai USD), tetapi
  dicatat sebagai alternatif.
- **Peringatan keamanan:** sebuah listing skill bernama **"insider-wallets-finder"** meminta pengguna **mengunduh
  binary berpassword** (arsip terkunci yang tidak bisa dipindai antivirus) untuk dijalankan secara lokal — pola umum
  distribusi malware/pencuri kunci wallet. Listing itu **tidak dipakai**, tidak diunduh, dan tidak dijadikan rujukan
  kode. Jangan pernah menjalankan binary semacam itu di Mac yang memuat `.env` atau wallet.
