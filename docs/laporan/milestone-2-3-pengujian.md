# Laporan Pengujian — Milestone 2 & 3

Laporan ini merangkum metode dan hasil untuk Milestone 2 (data pasar) dan Milestone 3 (mesin pola). Daftar lengkap setiap tes (ID, nama, status, durasi) ada di **[hasil-tes-otomatis.md](hasil-tes-otomatis.md)**, yang dihasilkan `npm run report:tests` dari file hasil eksekusi Vitest (`reports/vitest-results.json`) dan Playwright (`reports/e2e-results.json`). Angka di bawah disalin dari file tersebut, bukan diperkirakan.

> **Pembaruan 2026-10-25 (§6.1):** pemilik menjalankan `npm run test:live` di Mac-nya (Node 24.15.0): **REST live lulus 5/5** (LIVE-BN-001…003), **WebSocket LIVE-BN-004 gagal** karena URL WebSocket lama Binance sudah dimatikan. URL sudah diperbaiki ke rute `/market`; WebSocket live **menunggu uji ulang** pemilik.
>
> **Batasan awal:** integrasi **live** dengan Binance tidak dapat diverifikasi dari lingkungan build. Dari lingkungan build ini setiap request ke `fapi.binance.com` dibalas **HTTP 451** ("Service unavailable from a restricted location") dan WebSocket `fstream.binance.com` tidak menerima pesan. Semua tes otomatis memakai fixture **sintetis** yang mengikuti format dokumentasi resmi Binance, bukan rekaman pasar. Jalankan `npm run test:live` dari mesin pemilik untuk verifikasi live (§6).

## 1. Ringkasan hasil (eksekusi 2026-10-25, Node.js 22.22.0, Chromium build 1243)

| Pemeriksaan | Perintah | Hasil |
|---|---|---|
| Lint | `npm run lint` | 0 error, 0 warning |
| Vitest: unit, integrasi, positif, negatif, edge, keamanan | `npm test` | **956 / 956 lulus** (49 file) |
| Playwright E2E (desktop 1440×900 + mobile 390×844) | `npm run test:e2e` | **48 / 48 lulus** |
| Uji live Binance (opt-in) | `npm run test:live` | **Tidak dapat diverifikasi di sini** — 4/4 gagal dengan HTTP 451 (lokasi dibatasi), bukan cacat kode |
| npm audit (prod + dev) | `npm audit` | 0 kerentanan (218 dependensi) |
| Semgrep (aturan lokal) | `semgrep scan --config config/semgrep/long-radar.yml` (berkas aturan kini bernama `config/semgrep/alphalens.yml`) | 0 temuan (9 aturan, 93 file JS; semgrep 1.182.1) |
| Gitleaks, Trivy, OWASP ZAP | — | **Tidak dijalankan** (sumber unduhan diblokir; dijadwalkan M7) |

## 2. Cakupan tes per area

| Area (prefiks) | Modul / file tes | Fokus |
|---|---|---|
| `BNP`, `BNR`, `BNL` | Parser, klien REST, pembatas bobot Binance (`tests/unit/ingestion/`) | Format kline/ticker/exchangeInfo, angka string presisi kecil, 429/418 + `Retry-After`, 5xx/timeout + backoff, 4xx tidak diulang, allowlist host |
| `DSC` | Discovery simbol | Filter PERPETUAL/USDT/TRADING, volume & spread, mode manual, `maxAuto` |
| `WSC` | Klien WebSocket kline | `x=true` vs provisional, reconnect + jitter, koneksi basi, rotasi, pesan terlalu besar/rusak |
| `CVL`, `CDL`, `SYM`, `IST` | Validator & repositori candle/simbol/status ingesti | OHLC tidak konsisten, candle belum tertutup, duplikat (versi terakhir menang), out-of-order, gap, provisional tidak pernah masuk tabel kanonik |
| `BKF`, `SCN` | Backfill & scanner worker | Rencana chunk ≤ 1500, gap fill, sweep catch-up setelah reconnect/rediscovery, heartbeat, metrik |
| `IND` | Indikator | EMA/ATR/RVOL terhadap nilai acuan, swing terkonfirmasi tanpa lookahead |
| `PSYN`, `PCND`, `PPRM`, `PSA`, `PPVA`, `PEVL` | Generator sintetis & detektor pola | Determinisme generator, kondisi per pola, parameter tidak valid, warm-up, klasifikasi SA/PVA/BOTH/NONE |
| `TRND`, `HTF` | Engine timeframe | Trend 3 kelas, 4 tingkat alignment, HTF hanya candle tertutup pada `t`, HTF basi diabaikan, pola 5m tidak dibuang karena 1h |
| `SVW` | Skor & penjelasan | Skor 0–100, 6 risk flag, penjelasan per faktor, HTF/likuiditas tidak mengubah skor |
| `SSM`, `SREP`, `SPL` | State machine, repositori sinyal, alur pola→sinyal | Semua baris tabel transisi, tanpa downgrade, tanpa alert berulang, idempoten untuk candle lama, transaksi sinyal + event |
| `PIPE` | Pipeline analisis | Replay berurutan, alert hanya candle terakhir, `maxReplay`, `settleMs`, restart tidak memutar ulang |
| `SIG`, `SYS`, `WST` | API & status worker | Filter query tervalidasi, status dari heartbeat (`stale`/`not_running`), konteks BTC/ETH, tanpa angka palsu |
| `RT`, `SES`, `AUTH`, `CFG` | Keamanan | Bypass path ter-encode/absolute-form, rate limit tanpa sesi, race lockout, idle timeout, `TRUST_PROXY` |
| `RTR`, `API`, `A11Y`, `SET` | Frontend (unit) | Router & skip link, header polling, form angka kosong, kontras cincin fokus |
| `E2E-*` | Browser nyata | Screener & Signal History dengan sinyal yang ditulis lewat repositori (bukan mock HTTP), logout, navigasi, laci mobile, "Belum berjalan" saat worker mati |

Jumlah per kategori (dari `reports/vitest-results.json` dan `reports/e2e-results.json`):

| Prefiks | Kategori | Jumlah |
|---|---|---|
| `UNIT` | Unit (fungsi murni, repositori, klien dengan transport palsu) | 257 |
| `POS` | Alur positif | 87 |
| `NEG` | Alur negatif (input tidak sah, kegagalan dependensi) | 381 |
| `EDGE` | Kasus tepi (batas waktu, gap, presisi, jam miring) | 154 |
| `SEC` | Kontrol keamanan | 49 |
| `INT` | Integrasi worker end-to-end (modul asli, jaringan palsu) | 28 |
| `E2E` | Browser nyata (desktop + mobile) | 48 |
| `LIVE` | Live Binance (opt-in, di luar `npm test`) | 4 — tidak dapat diverifikasi di sini |


## 3. Prakondisi & metode

| Suite | Prakondisi | Metode |
|---|---|---|
| `tests/unit/**` (domain) | Candle sintetis deterministik dari `tests/helpers` (generator berbasis seed, tanpa `Math.random`) | Pemanggilan fungsi murni langsung; setiap skenario memiliki ekspektasi tertulis per kondisi |
| `tests/unit/ingestion`, `worker` | `fetch` dan `WebSocket` diinjeksi dengan **fixture sintetis** format resmi Binance; jam & timer manual | Klien/scanner nyata dengan transport palsu — tidak ada jaringan |
| `tests/unit/database`, `signals` | SQLite `:memory:` baru per tes, migrasi 001–003 nyata | Repositori nyata, constraint `CHECK`/PK diuji langsung |
| `tests/integration` | Worker + pipeline + SQLite dengan transport palsu | Alur candle → tabel kanonik → sinyal → API |
| `tests/positive`, `negative`, `edge`, `security` | Aplikasi Fastify lengkap via `buildApp`, DB `:memory:`, jam deterministik | `app.inject()` dan socket HTTP nyata untuk request absolute-form |
| `tests/e2e` | Dua server nyata: port 8181 (kosong) dan 8182 (berisi sinyal yang ditulis lewat `signalRepository`) | Chromium headless; menangkap error konsol, `pageerror`, pelanggaran CSP |
| `tests/live` | `LIVE_BINANCE=1`, akses jaringan ke Binance | Endpoint publik saja (time, exchangeInfo, ticker, bookTicker, klines, WS kline), tanpa API key dan tanpa order |

Tidak ada hasil tes yang ditulis tangan. Fixture Binance diberi label sintetis; tidak ada data pasar palsu yang ditampilkan di UI (tanpa heartbeat worker, UI menampilkan "Belum berjalan").

## 4. Validasi end-to-end mesin pola (skenario sintetis)

Fungsi murni `analyzeAt` (detektor nyata → konteks HTF → skor → state machine) dijalankan candle demi candle pada seri sintetis, dengan definisi pola **versi 2**. Alur yang sama lewat worker + SQLite diuji `INT-WRK-*`.

| Skenario | Hasil yang diamati |
|---|---|
| Akumulasi senyap lalu kenaikan bertahap (`silentAccumulationCandles`, seed 1) | Candle ke-63: `NO_PATTERN → EARLY_BULLISH` (SA, patternScore 100, earlyScore 66,4); candle ke-68: `→ MOMENTUM_BUILDING` (`PRICE_ATR_ADVANCE`) |
| Volume progresif (`progressiveVolumeCandles`, seed 1–5) | SA lebih dulu (candle ke-63, `QUIET`); PVA terdeteksi mulai candle ke-70–73 dan klasifikasi sinyal menjadi gabungan; candle ke-69 `→ MOMENTUM_BUILDING` (`RVOL_EXPANSION`) |
| Tren turun | Tidak ada sinyal, tidak ada event |
| Datar tanpa pola | Tidak ada sinyal, tidak ada event |

Ini memverifikasi **perilaku mesin**, bukan efektivitas pola. Efektivitas di pasar nyata hanya dapat dinilai dengan backtest out-of-sample (M6). **Tidak ada klaim bahwa pola ini menguntungkan.**

## 5. Cacat yang ditemukan dan diperbaiki

| Tes regresi | Gejala | Akar masalah | Perbaikan |
|---|---|---|---|
| SEC-RT-001…004, 007 | `GET /%61pi/overview` atau `GET http://host/api/...` tanpa sesi → **200 dengan data** | Gerbang auth, header `no-store`, dan allowlist rate limit memeriksa `request.url` mentah, sedangkan router mendekode path | Keputusan dari route yang cocok (`routeOptions.url`); gerbang dipasang per route; route API tanpa gerbang ditolak (fail-closed); catch-all `/api/*` → 404 setelah gerbang |
| SEC-RT-005, 006 | Request API tanpa sesi tidak pernah terkena rate limit | Hook rate limit route-level berjalan setelah hook auth global | Gerbang dipindah ke hook route setelah rate limit |
| EDGE-AUTH-006, 007 | 12 tebakan kata sandi paralel semuanya diverifikasi (melewati batas penguncian) | Hitungan gagal ditulis setelah verifikasi Argon2 asinkron | Reservasi percobaan atomik (`UPDATE … RETURNING`) sebelum verifikasi |
| SEC-RT-008, UNIT-SES-003 | Polling `/api/ready` dan aset statis memperpanjang idle timeout | `resolve()` sesi selalu menggeser idle | `resolve` tanpa geser; `touch()` hanya untuk API terautentikasi; polling memakai `credentials: 'omit'` |
| SEC-RT-011, UNIT-API-001/002 | Tab System Health yang terbuka menahan sesi hidup sampai batas absolut | Auto-refresh 10 detik dihitung sebagai aktivitas | GET dengan `X-LR-Background: 1` tidak memanggil `touch()` |
| SEC-RT-010, UNIT-CFG-* | `TRUST_PROXY=1` (jumlah hop) diam-diam tidak memercayai proxy apa pun | Perilaku Fastify 5.12.7 untuk hop count | Hanya menerima `false` atau daftar IP/CIDR/kata kunci; nilai lain ditolak saat start |
| UNIT-CFG-004 | Produksi dapat berjalan dengan `DATABASE_PATH=:memory:` (data hilang saat restart) | Tidak ada validasi | Ditolak di produksi |
| POS-SYS-005 | Metrik worker di System Health selalu kosong | Scanner mengirim metrik terpisah, repositori hanya menyimpan `state` | Heartbeat menyimpan snapshot `status()` lengkap |
| EDGE-SET-003, NEG-IN-006 | Simbol manual ber-base 1 karakter (mis. `WUSDT`) ditolak | Pola `{2,20}` tidak selaras dengan discovery | `{1,20}USDT` di server & klien |
| E2E-AUTH-004/005 | Logout dengan token CSRF basi tetap pindah ke login padahal sesi masih hidup | Respons logout tidak diperiksa | Ambil ulang token & coba sekali; kegagalan lain → toast |
| E2E-NAV-002/003, NEG-RTR-* | Interval Health bocor setelah navigasi cepat; error view tidak terlihat | View basi tidak dibuang; penolakan `onChange` tidak ditangkap | Nomor urut navigasi + cleanup; callout "Gagal memuat halaman." |
| E2E-NAV-004, EDGE-RTR-* | Skip link mengubah route ke Overview | Router memperlakukan `#main` sebagai route | Hash non-route diabaikan; skip link memfokuskan `#main` |
| E2E-SET-002, NEG-SET-003/004 | Field angka yang dikosongkan tersimpan sebagai 0 | `Number('') === 0` | Kosong → NaN → "Wajib diisi (…)" |
| E2E-UI-003 | Laci navigasi mobile tertutup masih dapat difokus dengan Tab | Hanya digeser keluar layar | `inert` + `visibility: hidden`, `aria-expanded`, fokus dikembalikan |
| UNIT-A11Y-001/002, E2E-UI-004 | Cincin fokus 2,18:1 (< 3:1 WCAG) | Token warna 40% alpha | Token `--lr-accent` solid (8,11:1), fallback `forced-colors` |
| UNIT-SCK-*, INT-WRK-014/015/018–020 | Worker memakai jam lokal: jam yang lebih cepat menolak kline final WS, yang lebih lambat dapat menyimpan candle berjalan sebagai tertutup | Tidak ada sinkronisasi waktu server Binance | `createServerClock` (offset dari `/fapi/v1/time`, sampel satu percobaan, RTT ≤ 1 dtk, offset > 10 menit tidak diterapkan); heartbeat tetap distempel jam lokal |
| UNIT-BNR-012, NEG-BNR-014, UNIT-SCN-020/021, EDGE-CVL-009/010, INT-WRK-008/023 | Snapshot REST candle yang masih berjalan dapat disimpan sebagai tertutup; kline final WS ditolak bila jam sedikit tertinggal | `isClosed` dari jam setelah respons, tanpa margin | `isClosed = closeTime < waktu server saat request − 2 dtk`; rencana backfill memakai margin yang sama; kline WS `x=true` diterima dalam toleransi ±2 dtk |
| UNIT-SCN-022, INT-WRK-024 | Jam host rusak (offset > 10 menit) tetap dipakai diam-diam | — | Worker `degraded`, error `clock`, candle REST tidak ditandai tertutup dari jam yang diketahui salah |
| UNIT-PIPE-006, POS-PIPE-004, INT-WRK-013 | Risk flag likuiditas memakai batas default, bukan pengaturan pengguna | `analyzeAt` tidak meneruskan ambang | `liquidityOf()` membawa ambang discovery; `params.view` di `analyzeAt` |
| NEG-PIPE-006 | Candle historis hasil replay mendapat flag likuiditas dari ticker 24 jam saat ini (lookahead) | Likuiditas terkini dipakai untuk semua candle batch | Hanya candle terbaru memakai likuiditas terkini; candle replay = "tidak tersedia (replay)" |
| POS-SREP-003, INT-WRK-016/021/022 | Sinyal simbol delisted/tak dipantau tampil selamanya di screener | Expiry hanya maju bila ada candle baru | `closeOpenForSymbol` → `EXPIRED` (`SYMBOL_DELISTED`/`MONITORING_STOPPED`), rekonsiliasi tiap discovery |
| NEG-SCN-009, EDGE-SCN-008, INT-WRK-026 | Discovery yang tiba-tiba memilih 0 simbol akan menutup semua sinyal | — | Dianggap anomali (error `discovery`, retry) kecuali simbol memang delisted atau pengaturan memang berubah |
| UNIT-SCN-023, INT-WRK-025 | Menonaktifkan 15m/1h di pengaturan menghilangkan konteks HTF untuk 5m | Hanya timeframe terpilih yang diingesti | HTF yang dibutuhkan diingesti sebagai seri konteks (tanpa analisis) |
| NEG-BNR-015, NEG-SCN-007/008, UNIT-SCN-024, EDGE-CVL-011 | 418/429 hilang saat body timeout; sweep tidak terjadwal bila pengaturan pertama gagal dimuat; candle sebelum reconnect terlewat; error simbol lain tertahan throttle; `assessFreshness` salah di batas candle | Masing-masing kecil | Diperbaiki satu per satu dengan tes regresi |
| EDGE-PIPE-007/008/009, UNIT-SREP-008, INT-WRK-007 | Setelah restart hingga 288 candle per seri dievaluasi ulang dan event loop tertahan | Titik awal replay = event terakhir, bukan candle terakhir yang dievaluasi | Kursor analisis persisten (migrasi `004_analysis_state`), jeda event loop dengan anggaran bersama |
| UNIT-SREP-009, NEG-SREP-005, EDGE-HTF-007, EDGE-SSM-006 | Riwayat sinyal scan penuh; state dapat berubah tanpa event; candle HTF yang hilang lama tetap dianggap segar; sinyal jatuh tempo "hidup lagi" setelah gap data | — | Indeks riwayat; `save()` menolak perubahan state tanpa event; toleransi HTF hanya di jendela settle; expiry diperiksa lebih dulu |
| UNIT-PIPE-007, UNIT-MCTX-001/002, EDGE-HTF-005 | Data kurang tampil sebagai trend `NEUTRAL` yang tampak nyata (termasuk konteks BTC/ETH) | `INSUFFICIENT_DATA` dipetakan ke NEUTRAL | Trend `null` / status `insufficient_data`, UI "Trend tidak tersedia" |
| UNIT-PCND-008/009, EDGE-PSA-008/009 | Early Score dapat naik lagi setelah pullback walau harga sudah jauh berjalan (alert `EARLY_BULLISH` terlambat) | Jarak diukur dari higher low terbaru | Jarak diukur dari awal struktur (`maxRunAtr` 6); **versi pola 2** |
| NEG-PPVA-009…012, POS-PPVA-002 | PVA terdeteksi (skor 100) padahal pertumbuhan volume dipasok satu–dua candle 2–5× | Penjaga lonjakan mengukur jendela 20 candle | Kondisi wajib `volumeGrowthBroad` (median bawah sub-jendela terakhir); **versi pola 2** |
| EDGE-PPRM-001…004, NEG-PIPE-007 | Parameter dengan warm-up > lookback membuat pola diam-diam tidak pernah terdeteksi | Tanpa batas | Ditolak `PatternParamsError` terhadap lookback pipeline |
| UNIT-PEVL-004, UNIT-TRND-003, NEG-PIPE-004 | Tes anti-lookahead / antrean lolos tanpa menguji apa pun (tautologis) | — | Ditulis ulang; terbukti gagal pada mutan yang mengintip candle masa depan |
| POS-SIG-*, NEG-SIG-*, E2E-SIG-004…006 | Filter alignment screener diterapkan di klien setelah potongan top-N; `limit` > 500 dipotong diam-diam; tes API tidak membedakan filter | — | Filter `alignment` di server sebelum LIMIT; `limit` 1–500 (di atas → 400); matriks sinyal sintetis; screener menandai bila batas 500 tercapai |

Tes regresi keamanan (SEC-RT-001…007, SEC-RT-011, EDGE-AUTH-006/007), frontend, dan seluruh perbaikan hasil review di atas diverifikasi **gagal** pada kode sebelum perbaikan (dengan mengembalikan sementara file produksi lama) dan lulus setelahnya. Untuk tes yang hanya memperbaiki tes (tanpa perubahan produksi) bukti diperoleh dengan mutan.

### Review adversarial

Kode M2/M3 direview oleh enam reviewer independen per subsistem, lalu setiap temuan diuji ulang oleh skeptik terpisah yang mencoba membantahnya: **13 terkonfirmasi** (5 medium, 8 low; tidak ada yang critical/high setelah verifikasi), 5 dibantah, 23 belum terverifikasi. Semua yang terkonfirmasi dan seluruh 23 yang belum terverifikasi ditindaklanjuti — diperbaiki, atau (untuk dokumen) dikoreksi (tabel di atas, plus penguatan UNIT-WSC-009); setiap kelompok perbaikan direview ulang oleh reviewer independen dan temuan susulannya ikut diperbaiki.

## 6. Verifikasi live (wajib dijalankan pemilik)

```bash
npm run test:live
```

Menjalankan LIVE-BN-001…004 terhadap endpoint publik Binance USDT-M (tanpa API key, tanpa order, bobot request kecil): waktu server & selisih jam, discovery simbol perpetual USDT, kline tertutup 5m/15m/1h tervalidasi, dan satu pesan WebSocket kline. Hasil di lingkungan build ini:

```
LIVE-BN-001…003  BinanceApiError: HTTP 451 — Service unavailable from a restricted location
LIVE-BN-004      tidak ada pesan WebSocket dalam batas waktu
```

Status ini **bukan** bukti bahwa integrasi bekerja maupun gagal; ini hanya menunjukkan lokasi build diblokir Binance.

### 6.1 Hasil live dari mesin pemilik (2026-10-25)

Dijalankan pemilik di macOS, Node.js 24.15.0, npm 12.2.0, setelah `npm ci` (0 kerentanan) dan `npm test` (49 file, 956/956 lulus). Keluaran `npm run test:live` (Vitest 5.0.5) yang dikirim pemilik:

```
✓ LIVE-BN-001 waktu server dekat dengan jam lokal (selisih < 60 dtk) 484ms
✓ LIVE-BN-002 exchangeInfo + ticker + bookTicker → discovery memilih perpetual USDT yang TRADING 468ms
✓ LIVE-BN-003 klines BTCUSDT 5m: candle valid, berurutan, hanya yang lewat closeTime bertanda tertutup 205ms
✓ LIVE-BN-003 klines BTCUSDT 15m: … 144ms
✓ LIVE-BN-003 klines BTCUSDT 1h: … 140ms
× LIVE-BN-004 WebSocket kline menerima update (provisional) BTCUSDT 5m dalam 20 detik 20142ms
  AssertionError: expected 0 to be greater than 0
Tests  1 failed | 5 passed (6)
```

**Penyebab LIVE-BN-004.** Klien memakai URL combined stream lama `wss://fstream.binance.com/stream?streams=…`. Binance mengumumkan upgrade WebSocket USDⓈ-M (pemberitahuan 2026-03-06) yang membagi stream ke rute `/public`, `/market`, dan `/private`; URL lama `/ws` dan `/stream` dimatikan setelah 2026-04-23, dan koneksi tanpa rute hanya menerima data kategori *public* (depth/bookTicker). Kline termasuk kategori *market*, sehingga koneksi lama tidak pernah mengirim pesan kline. Bukti: SDK resmi Binance `@binance/derivatives-trading-usds-futures` 39.0.2 (npm) membangun `${wsURL}/market/stream?streams=…` untuk kline, dan SDK Python resmi `binance-sdk-derivatives-trading-usds-futures` 18.1.0 (PyPI) memakai `url_path` `market`; library lain (go-binance, python-binance, node-binance-api, Hummingbot) melakukan migrasi yang sama. Halaman dokumentasi Binance tidak dapat dibuka dari lingkungan build (DNS/proxy), jadi kutipan dokumen resmi berasal dari ringkasan mesin pencari.

**Perbaikan.** `BINANCE_WS_BASE_URL` kini `wss://fstream.binance.com/market`, sehingga URL menjadi `wss://fstream.binance.com/market/stream?streams=…`. `baseUrl` tanpa rute `/market` ditolak saat konstruksi (fail closed). Tes regresi UNIT-WSC-014 dan NEG-WSC-005 terbukti gagal pada kode lama dan lulus setelah perbaikan. LIVE-BN-004 kini mencantumkan URL, jumlah koneksi terbuka, jumlah pesan, parse error, dan event koneksi pada pesan kegagalannya, sehingga handshake yang ditolak dapat dibedakan dari socket yang terbuka tetapi diam. **Uji ulang live oleh pemilik belum dilakukan**; hasilnya akan dicatat di sini.

## 7. Keterbatasan yang diketahui

- REST live Binance terverifikasi di mesin pemilik; WebSocket live menunggu uji ulang setelah perbaikan rute `/market` (§6.1).
- Efektivitas pola belum divalidasi out-of-sample; skor bukan probabilitas.
- Kolom tracking sinyal masih di `explanation_json` (usulan migrasi berikutnya, `docs/05-database.md`).
- Ambang default pola (mis. `minScore` 85, `maxRunAtr` 6, `minVolumeGrowth` 1,5) adalah nilai awal yang belum dikalibrasi pada data nyata.
- Alert hanya untuk candle terakhir sebuah batch; transisi di tengah backfill tercatat di riwayat tetapi tidak di-alert (disengaja, agar backfill tidak membanjiri alert historis).
- Saat laci navigasi mobile terbuka, fokus belum dikunci di dalam laci (Tab dapat mencapai konten di belakang overlay).
- Rate limit memakai store memori (satu instans API).
- Uji E2E hanya di Chromium; belum ada audit aksesibilitas otomatis (axe) — M7.

## 8. Cara mereproduksi

```bash
npm ci
npm run lint
npm test
npm run test:e2e
npm run report:tests        # menulis ulang docs/laporan/hasil-tes-otomatis.md dari hasil eksekusi
npm run test:live           # hanya dari jaringan yang tidak diblokir Binance
```
