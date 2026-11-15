# 22 — Riset sumber data pemicu kenaikan koin: top trader, insider (wallet Binance), dan berita (2026-11-15)

Pertanyaan pemilik: *"riset dan analisis coin itu naik berdasarkan berita, top trader, dan insider"* — data top trader diambil
dari mana (utamakan gratis; yang berbayar cukup disebutkan), alamat wallet Binance dilihat di mana agar pergerakannya ke
koin apa terlihat, dan berita apa yang berkaitan dengan koinnya.

**Status:** riset saja. Belum ada sumber di dokumen ini yang diintegrasikan ke AlphaLens. Langkah integrasi di §6 butuh
keputusan pemilik.

## 0. Metode & tingkat verifikasi

- Workflow multi-agen pada 2026-11-15: tiga agen riset (top trader, wallet Binance, berita) lalu satu agen **cek fakta
  adversarial** atas 26 klaim terpenting (status gratis/berbayar, harga, kunci API, batas). Hasil cek fakta: 16 benar,
  7 benar sebagian (dikoreksi di bawah), 3 tidak dapat diverifikasi, tidak ada yang salah total.
- Uji konektivitas hanya GET publik tanpa kunci dari Mac pemilik. Selama riset, semua host `*.binance.com` gagal di level
  koneksi karena **DNS dibajak ISP** (lihat §5). Beberapa klaim Binance karena itu bersumber dari dokumentasi/indeks
  pencarian, bukan respons langsung; ditandai.
- Harga dan paket gratis sering berubah. Semua angka berlaku per 2026-11-15.
- Bukti empiris dikutip apa adanya, termasuk kelemahannya. Prinsip produk tetap berlaku: data ini **konteks**, bukan
  sinyal ber-skor, sampai lolos validasi data nyata (disiplin docs/21).

## 1. Ringkasan & tumpukan gratis yang disarankan

| Faktor | Sumber gratis terbaik | Yang berbayar (cukup diketahui) | Kekuatan bukti |
|---|---|---|---|
| Top trader | Endpoint publik Binance Futures `/futures/data/*` (rasio long/short top trader, OI, funding), riwayat di `data.binance.vision`, posisi terbuka Hyperliquid | API CoinGlass, Laevitas Enterprise, Hyblock Professional | Lemah: tidak ada studi yang membuktikan rasio top trader memprediksi kenaikan; berguna sebagai konteks "kerumunan" |
| Insider (wallet Binance) | Proof of Reserves Binance (daftar alamat), DefiLlama `binance-cex` (saldo harian per token), explorer + Routescan, Whale Alert/Lookonchain di X | Arkham API (per panggilan), CryptoQuant Professional, Nansen, Whale Alert API | Campuran: inflow ETH ke bursa memprediksi return negatif 1–6 jam; BTC umumnya tidak; false positive tinggi |
| Berita | Pengumuman bursa (CMS Binance, API Upbit/OKX/Bybit, diff `exchangeInfo`), Tree News, RSS media kripto, Google News RSS | CryptoPanic (status gratis simpang siur), CoinDesk Data, CoinGecko `/news`, X API | Kuat tetapi singkat: listing memberi lonjakan menit-jam; harga bereaksi dalam detik, sehingga candle 15m/1h hampir selalu terlambat |

## 2. Top trader

### 2.1 Sumber

| Sumber | Data | Akses | Biaya | Catatan |
|---|---|---|---|---|
| Binance `/futures/data/topLongShortPositionRatio` | Rasio long/short **posisi** top trader | REST tanpa kunci | Gratis | Lebih dekat ke eksposur pemain besar |
| Binance `/futures/data/topLongShortAccountRatio` | Rasio long/short **akun** top trader | REST tanpa kunci | Gratis | Mengukur jumlah akun, bukan notional |
| Binance `/futures/data/globalLongShortAccountRatio` | Rasio akun semua pengguna (ritel) | REST tanpa kunci | Gratis | Bias struktural long di altcoin; pakai z-score per simbol |
| Binance `/futures/data/openInterestHist`, `/fapi/v1/openInterest` | Open interest | REST tanpa kunci | Gratis | Kuadran ΔOI × Δharga (lihat 2.2) |
| Binance `/fapi/v1/premiumIndex` (tanpa simbol), `/fapi/v1/fundingRate` | Funding semua koin | REST tanpa kunci | Gratis | Satu panggilan untuk semua simbol |
| Binance `/futures/data/takerlongshortRatio`, `basis` | Taker buy/sell, basis | REST tanpa kunci | Gratis | Taker hampir redundan: AlphaLens sudah menghitung CVD dari kline |
| `data.binance.vision` "metrics" UM futures | OI, rasio top trader & global, taker; resolusi 5 menit sejak 2020-09-01 | Unduh CSV harian | Gratis | Untuk backtest out-of-sample; terbit H+1, baris tidak terurut, kolom `count_*` = akun, `sum_*` = posisi |
| Binance WebSocket `!forceOrder@arr` | Likuidasi semua pasar | WebSocket tanpa kunci | Gratis | Deteksi short squeeze |
| Hyperliquid leaderboard + Info API (`clearinghouseState`) | Posisi **alamat mana pun** dan PnL leaderboard | GET leaderboard (tidak resmi), POST `/info` (resmi, 1200 weight/menit) | Gratis | Satu-satunya tempat posisi trader top benar-benar terbuka |
| OKX Rubik, Gate `contract_stats`, Bybit `account-ratio`, Bitget long/short | Rasio top trader / akun di bursa lain | REST tanpa kunci (diuji 200) | Gratis | Konfirmasi lintas bursa; definisi populasi "top" tiap bursa belum diverifikasi |
| Coinalyze API | OI/funding/likuidasi agregat multi-bursa | REST, kunci gratis | Gratis (minta atribusi) | 40 call/menit; **kuota dihitung per simbol**, bukan per request (522 simbol ≈ 13 menit per metrik) |
| Binance Futures Leaderboard / Copy Trading | Posisi trader yang membagikan | Hanya endpoint web "bapi" tidak resmi | Gratis | Tidak ada API resmi; rawan berubah & risiko ToS; pakai manual saja |
| CoinGlass API | Agregat multi-bursa siap pakai | REST, kunci | **Berbayar**: Hobbyist $420/thn (±$35/bln) harga normal; promo $273/thn s/d 1 Des 2026. Hobbyist & Startup hanya penggunaan pribadi | Web gratis untuk cek manual |
| Laevitas | Funding/basis lintas bursa | Web; API di Enterprise | Free (riwayat 1 minggu), Premium $50/bln tanpa API, Enterprise $500/bln | — |
| Hyblock Capital, Velo Data, TradingView | Indikator & chart | Web | Freemium; harga API Hyblock/Velo belum terverifikasi | Manual |

Batas Binance `/futures/data/*`: riwayat ±30 hari, kuota 1000 request / 5 menit / IP, satu simbol per request (522 simbol
USDT perpetual saat riset → perlu dijadwalkan; 150–200 simbol teratas per volume cukup longgar). Cuplikan changelog Binance
(Agustus 2026) menyebut parameter opsional `contractType`; tanpa parameter itu BTC/ETH bisa tercampur kontrak kuartalan —
uji `contractType=PERPETUAL` sebelum dipakai.

**Definisi penting:** "top trader" versi Binance = 20% pengguna dengan **margin balance terbesar**, belum tentu yang paling
profit. Rasio akun dan rasio posisi bisa jauh berbeda (uji BTC: akun 3,12 vs posisi 1,87).

### 2.2 Mekanisme (kerangka, bukan bukti kausal)

| ΔOI | Δharga | Tafsiran |
|---|---|---|
| naik | naik | Long baru (momentum berleverage); rapuh bila funding/basis ekstrem |
| turun | naik | Short covering / squeeze; cepat, sering diikuti retrace |
| naik | turun | Short baru |
| turun | turun | Long ditutup / dilikuidasi |

- Divergensi yang populer di praktisi: rasio **posisi** top naik sementara rasio **akun** turun/datar (segelintir akun besar
  menambah long). Belum terbukti empiris.
- Funding sangat positif = long membayar mahal (crowded long, risiko long squeeze). Funding negatif saat harga mulai naik
  = short crowded (bahan bakar squeeze).

### 2.3 Bukti (jujur: lemah)

- BIS Working Paper 1087 "Crypto Carry" (Schmeling, Schrimpf, Todorov): basis/funding tinggi mencerminkan permintaan leverage
  investor pengejar tren dan berkaitan dengan risiko crash → **peringatan**, bukan sinyal beli (studi memakai futures
  kuartalan).
- Jurnalistik (The Block): rasio L/S BTC Binance di atas 3 tidak andal sebagai penanda dasar; November 2025 BTC turun > 35%
  saat rasio akun di level tertinggi multi-tahun.
- Klaim vendor seperti "rasio > 2,8 lalu turun dalam 48 jam pada 71% kasus" tanpa metodologi → diabaikan.

### 2.4 Aturan deskriptif usulan (hipotesis, belum diuji)

Hanya untuk kolom konteks, bukan skor, sampai lolos backtest out-of-sample di `data.binance.vision`:
- `TOP_ACCUM`: z(Δln rasio posisi top) ≥ 1, Δln rasio akun top ≤ 0, ΔOI% > 0, z(funding) < 1,5.
- `SQUEEZE_FUEL`: z(funding) < −1 atau z(rasio global) < −1, ΔOI > 0, dan harga menembus level.
- `CROWDED_LONG`: z(funding) > 2, z(rasio global) > 2, OI di level tertinggi 30 hari (konteks risiko untuk SHORT).

## 3. Insider: alamat wallet Binance dan pergerakannya per koin

"Insider" di sini berarti **data on-chain publik** (sah dipantau). Ini berbeda dengan perdagangan berdasarkan informasi orang
dalam yang tidak publik.

### 3.1 Di mana melihat alamat Binance

- **Resmi:** halaman Proof of Reserves — <https://www.binance.com/en/proof-of-reserves> → bagian alamat → "Download All
  Address" (format file & perlu login atau tidak: belum terverifikasi). Endpoint mesin tidak resmi yang dipakai DefiLlama:
  `/bapi/apex/v1/public/apex/market/por/address` (respons belum berhasil direkam dari sesi ini; uji ulang sebelum dipakai).
- **Perhatian:** menurut investigasi Bitquery dan media kripto, hot wallet Binance diretas pada 29-10-2026 dan alamatnya
  dirotasi. Label lama di explorer dan daftar open source (mis. "Binance 14") bisa sudah usang. Ambil ulang daftar PoR
  tiap minggu.

### 3.2 Sumber

| Sumber | Untuk apa | Biaya | Catatan |
|---|---|---|---|
| DefiLlama `https://api.llama.fi/protocol/binance-cex` | **Saldo harian per token** Binance (821 token) → Δ hari ini vs kemarin/7 hari = arus bersih per koin | Gratis, tanpa kunci (diuji 200, ±47 MB) | Cara gratis paling praktis. Abaikan lonjakan bersamaan dengan perubahan set alamat |
| Explorer: Etherscan / BscScan / Basescan / Arbiscan / Solscan / Tronscan | Tab Holders (baris berlabel Binance) & Transfers pada alamat PoR | Web gratis. API Etherscan gratis 3 rps / 100 rb per hari hanya untuk Ethereum/Arbitrum/Polygon; BSC/Base/OP **tidak** gratis (terbukti uji langsung) | Detail per transaksi |
| Routescan (API kompatibel Etherscan) | `tokentx` per alamat & token | Gratis tanpa kunci (2 rps / 10 rb per hari) | Sudah dipakai provider Smart Money AlphaLens |
| Arkham Intelligence (web) | Entitas Binance: portofolio per token, transaksi terbaru | Gratis; menurut media sejak 20-10-2026 dibatasi 100 transaksi terbaru tanpa filter (belum dari halaman resmi) | API: bayar per panggilan (x402), mis. `entity-balance-changes` $0,40 |
| Whale Alert (X/Telegram), Lookonchain, Spot On Chain, EmberCN (X) | Notifikasi transfer besar "to/from #Binance" | Gratis | Selalu verifikasi tx hash di explorer; cek apakah harga sudah bergerak sebelum posting. API Whale Alert mulai $29,95/bln |
| Binance Alpha token list (endpoint web) | Token yang belum listing CEX (`listingCex=false`) | Gratis | Analisis agen: 62 dari 71 perp USDT baru dalam 365 hari sudah ada di Alpha, median 1,1 hari sebelum perp diluncurkan |
| Binance USDⓈ-M `exchangeInfo` | Perp baru (`onboardDate`) | Gratis (sudah dipakai worker) | Cocokkan dengan daftar Alpha dan arus token |
| Tokenomist | Jadwal unlock | Free (cek manual). Pro $99→$69/bln (harga diskon, tagihan tahunan), API Standard/Elite lebih mahal | Unlock tim/investor ≤ 30 hari = konteks SHORT |
| CryptoQuant | Exchange netflow per aset | Basic gratis (harian, BTC/ETH); altcoin & API on-chain di Professional $99/bln (tahunan) | — |
| Nansen, DeBank, Dune, Santiment, Glassnode | Arus CEX, portofolio alamat, tabel `cex.flows` | Nansen Pro $49–69/bln; Dune lihat dashboard gratis, query/API berbayar; lainnya freemium/belum terverifikasi | — |

### 3.3 Cara manual hari ini (gratis, ±15 menit per koin)

1. Unduh alamat PoR Binance (§3.1); simpan per chain.
2. Buka `api.llama.fi/protocol/binance-cex` (atau halaman CEX Transparency Binance di defillama.com). Bandingkan jumlah token
   hari ini vs kemarin dan 7 hari lalu: **naik** = koin masuk ke Binance (potensi suplai jual, konteks SHORT); **turun** =
   koin ditarik (konteks LONG).
3. Detail di explorer: halaman token (kontrak dari mapping Smart Money AlphaLens) → Holders (baris Binance) dan Transfers
   (filter alamat PoR, 24 jam).
4. Arkham web: entitas Binance → portofolio per token.
5. Notifikasi: Whale Alert/Lookonchain/Spot On Chain/EmberCN; verifikasi di explorer.
6. Konteks: unlock ≤ 30 hari (Tokenomist) dan token Alpha yang belum listing CEX.

### 3.4 Bukti

- Chi, Chu & Hao, *Return and Volatility Forecasting Using On-Chain Flows in Cryptocurrency Markets* (arXiv:2411.06327):
  net inflow **ETH** ke bursa memprediksi return ETH negatif pada interval 1–6 jam; inflow **BTC** umumnya tidak; inflow
  USDT ke bursa memprediksi return BTC/ETH positif (dana siap beli). Untuk altcoin per Binance tidak ditemukan studi
  peer-review.
- Keyrock (penerbitnya market maker): ±90% unlock diikuti tekanan harga, mulai ±30 hari sebelum unlock; unlock tim terburuk.
- Felez-Vinas, Johnson & Putniņš (preprint): dugaan insider trading pada 10–25% listing Coinbase (harga DEX naik sebelum
  pengumuman). Deposit proyek/MM ke bursa biasanya terjadi **setelah** pengumuman (mis. ASTER Okt 2025).
- Deposit ke Binance bukan bukti penjualan; transfer hot↔cold dan antar-wallet Binance adalah noise (buang transfer yang
  kedua sisinya berlabel Binance). Inflow di hot wallet adalah hasil sweep dari alamat deposit, jadi tertinggal menit–jam.

## 4. Berita

### 4.1 Sumber

| Sumber | Data | Akses & latensi | Biaya | Catatan |
|---|---|---|---|---|
| Binance Announcement CMS (endpoint web `bapi/composite/v1/public/cms/article/list/query`) | Listing, delisting, Monitoring Tag, HODLer/Launchpool, Alpha | Poll 20–30 detik | Gratis, tidak resmi | Klasifikasi judul ("Binance Will List…", "…Will Delist…") |
| Binance Announcement WebSocket (`com_announcement_en`) | Sama, real-time | WebSocket resmi, butuh API key **read-only** (HMAC) | Gratis | Sumber resmi tercepat. Telegram resmi tertinggal median ±4 menit |
| Diff `exchangeInfo` USDⓈ-M | Perp dijadwalkan (`PENDING_TRADING`, `onboardDate`), delist (`deliveryDate` berubah, `SETTLING`) | Sudah diambil worker | Gratis | Langkah integrasi termurah |
| Binance product tags & Alpha token list | Tag Monitoring/Seed/HODLer; token Alpha baru | Poll 5–15 menit | Gratis, tidak resmi | Monitoring baru = risiko delist |
| Upbit (pengumuman + `market/all`), Bithumb (`market/all`) | Listing KRW, peringatan (유의 종목) | Poll 30 detik | Gratis | Listing KRW sering memicu lonjakan |
| OKX & Bybit announcements API, Coinbase products | Listing di bursa lain | Poll 30–60 detik / diff 5 menit | Gratis | Listing Bybit kadang mendahului Binance |
| Tree News (Tree of Alpha) REST | Berita per koin, sudah dipetakan ke simbol `binance-futures` | Poll 60 detik | REST publik gratis; langganan/WebSocket belum terverifikasi | Item `AMBIGUOUS` jangan dipetakan |
| RSS CoinDesk, Cointelegraph, The Block, Decrypt, Blockworks | Hack, ETF, regulasi, kemitraan | Poll 3–5 menit | Gratis | Cocokkan nama proyek/ticker |
| Google News RSS, GDELT | Cadangan per kata kunci; makro | Menit–jam | Gratis | Google News tertinggal berjam-jam; GDELT lemah untuk altcoin |
| CryptoPanic API | Agregat berita per koin | — | Status paket gratis **simpang siur** (klaim dihentikan vs cuplikan lama "free tier 5 req/sec"); RSS lama 410 | Web masih bisa dibuka manual |
| CoinDesk Data News API (eks CryptoCompare) | Berita | — | Free tier dipensiunkan 21-05-2026; lewat sales | — |
| CoinGecko `/news` | Berita per koin | — | Mulai Analyst $129/bln | `/search/trending` gratis sebagai proksi perhatian |
| X API, LunarCrush, Santiment, NewsAPI | Sosial & sentimen | — | X $0,005 per post dibaca; LunarCrush mulai $1/1.000 request; Santiment Pro $49/bln; NewsAPI gratis tertunda 24 jam | Nilai rendah untuk timing 15m/1h |

### 4.2 Bukti & jeda waktu

- Listing: abnormal return +6,51% di hari listing (studi 250 cross-listing, ringkasan pencarian). Tetapi 7 hari setelah
  listing perdana, Binance spot rata-rata −8% (median −19%) dan Binance Alpha median −13,8% (Tophash, Jan 2024–Jun 2025).
  Listing sekunder (koin yang sudah beredar) mengungguli listing perdana.
- Hack: token governance DeFi rata-rata −27% dalam 24 jam; ±36% dampak sudah terserap sebelum berita (NY Fed Staff Report 1153).
- Insider: perdagangan berinformasi sebelum 10–25% listing Coinbase — harga sering sudah naik sebelum berita.
- **Jeda:** bot berita bereaksi dalam milidetik–detik. Candle 15m/1h tertutup hampir selalu terlambat untuk mengejar berita.
  Karena itu berita paling jujur ditampilkan sebagai **lencana konteks/risiko** (LISTING, DELIST, MONITORING, UNLOCK, HACK)
  dengan waktu terbit dan waktu terlihat, tanpa menambah skor sampai ada event study internal.

## 5. Catatan konektivitas (penting untuk AlphaLens)

Selama riset, dari Mac pemilik tanpa WARP, semua host `*.binance.com` (dan `api.bybit.com`) gagal di level koneksi, sedangkan
`data.binance.vision`, OKX, Gate, Upbit, dan host lain normal. Diagnosis 2026-11-15: ISP membajak DNS domain itu; koneksi ke
IP asli Binance tetap lancar. Diperbaiki di AlphaLens dengan DNS-over-HTTPS khusus host Binance (`BINANCE_DNS=doh`, default;
lihat README "Jaringan yang memblokir DNS Binance"). Sumber non-Binance yang ikut diblokir (mis. Bybit) belum dicakup.

## 6. Langkah integrasi yang disarankan (belum dikerjakan, butuh keputusan pemilik)

Urutan dari yang termurah; semuanya tampil sebagai **konteks**, bukan skor, sampai lolos validasi out-of-sample:

1. **Berita dari data yang sudah ada (±0,5–1 hari):** perluas parser `exchangeInfo` (`deliveryDate`, `underlyingSubType`) dan
   buat `backend/news/exchangeInfoEvents.js` (LISTING_PERP_SCHEDULED, LISTING_PERP_LIVE, DELIST_SCHEDULED, DELISTED).
   Catatan: `symbolDiscovery.js` menolak status selain TRADING, jadi diff dijalankan pada `exchangeInfo` mentah.
2. **Top trader:** metode baru di `restClient.js` (host sama, allowlist tidak berubah) dan limiter terpisah untuk kuota
   1000/5 menit; kolom konteks "top trader naik/turun, OI, funding" untuk simbol yang tampil di scanner.
3. **Wallet Binance:** provider label `binance-por` di modul Smart Money. Kapabilitas `labels` dan kategori `cex`/`cex_deposit`
   sudah ada di kontrak, jadi provider ini menghidupkan klasifikasi CEX_DEPOSIT/CEX_WITHDRAWAL yang selama ini belum punya
   sumber label gratis. Tambahan: arus harian per koin dari DefiLlama.
4. **Pengumuman bursa:** poller CMS Binance + Upbit, lalu Tree News + RSS, ditampilkan sebagai lencana.
5. **Validasi sebelum bobot:** backfill riwayat (metrics `data.binance.vision`, riwayat CMS) lalu event study internal dengan
   candle yang sudah ada: return dan MFE/MAE 15m/1h/4h/24h per jenis kejadian dibanding baseline.

Etika polling: User-Agent generik dan jitter, ETag/If-Modified-Since untuk RSS, backoff saat 403/418/429, satu permintaan per
sumber per interval, simpan hanya judul, tautan, dan metadata.
