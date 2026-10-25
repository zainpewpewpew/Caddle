# Hasil Tes Otomatis

> Dokumen ini **dihasilkan otomatis** oleh `npm run report:tests` dari file hasil eksekusi Vitest dan Playwright.
> Jangan diedit manual.

- Waktu eksekusi Vitest: 2026-10-25T19:38:15.230Z
- Commit basis: `c6e350a` (perubahan yang belum di-commit dapat ikut teruji)
- Node.js: v22.22.0

## Ringkasan

| Suite | Total | Lulus | Gagal | Dilewati |
|---|---|---|---|---|
| Vitest (unit, positif, negatif, edge, keamanan) | 1135 | 1135 | 0 | 0 |
| Playwright E2E (desktop + mobile) | 56 | 56 | 0 | 0 |

### Per kategori ID

| Prefiks | Arti | Total | Lulus |
|---|---|---|---|
| E2E | End-to-end | 56 | 56 |
| EDGE | Kasus tepi | 164 | 164 |
| INT | INT | 38 | 38 |
| NEG | Negatif | 453 | 453 |
| POS | Positif | 93 | 93 |
| SEC | Keamanan | 63 | 63 |
| UNIT | Unit | 324 | 324 |

## Detail Vitest

| ID | Tes | File | Status | ms |
|---|---|---|---|---|
| EDGE-SET-001 | EDGE-SET-001 dua update bersamaan dengan versi sama → satu sukses, satu 409 (tanpa lost update) | tests/edge/edge.test.js | LULUS | 232 |
| EDGE-SET-002 | EDGE-SET-002 versi usang setelah update → 409 | tests/edge/edge.test.js | LULUS | 74 |
| EDGE-AUTH-001 | EDGE-AUTH-001 username tidak case-sensitive | tests/edge/edge.test.js | LULUS | 72 |
| EDGE-AUTH-002 | EDGE-AUTH-002 banyak login paralel untuk user yang sama menghasilkan sesi independen | tests/edge/edge.test.js | LULUS | 65 |
| EDGE-AUTH-003 | EDGE-AUTH-003 login ulang dari browser yang sama mencabut sesi lama (anti session fixation) | tests/edge/edge.test.js | LULUS | 70 |
| EDGE-AUTH-004 | EDGE-AUTH-004 kegagalan login paralel tetap dihitung atomik dan memicu penguncian | tests/edge/edge.test.js | LULUS | 89 |
| EDGE-AUTH-006 | EDGE-AUTH-006 tebakan paralel melebihi ambang: hanya ambang yang diverifikasi, kata sandi benar sesudahnya ditolak | tests/edge/edge.test.js | LULUS | 144 |
| EDGE-AUTH-007 | EDGE-AUTH-007 login benar yang paralel dengan tebakan salah tidak menghapus kunci yang dipasang tebakan tersebut | tests/edge/edge.test.js | LULUS | 99 |
| EDGE-AUTH-005 | EDGE-AUTH-005 sesi kedaluwarsa absolut meskipun terus aktif | tests/edge/edge.test.js | LULUS | 73 |
| EDGE-USR-001 | EDGE-USR-001 maksimal dua pengguna; pengguna ketiga ditolak | tests/edge/edge.test.js | LULUS | 21 |
| EDGE-RST-001 | EDGE-RST-001 sesi & pengaturan bertahan setelah restart; migrasi tidak diterapkan ulang | tests/edge/edge.test.js | LULUS | 112 |
| EDGE-RST-002 | EDGE-RST-002 readiness 503 bila database tidak tersedia | tests/edge/edge.test.js | LULUS | 49 |
| EDGE-SUP-001 | EDGE-SUP-001 dua request start bersamaan → tepat satu 200 dan satu 409; hanya satu child | tests/edge/workerControl.edge.test.js | LULUS | 301 |
| EDGE-SUP-002 | EDGE-SUP-002 worker crash → crashed dengan kode keluar; heartbeat segar milik child yang crash tidak memblokir start ulang | tests/edge/workerControl.edge.test.js | LULUS | 106 |
| EDGE-SUP-003 | EDGE-SUP-003 heartbeat worker luar tepat di batas basi masih external; 1 ms setelahnya start diizinkan | tests/edge/workerControl.edge.test.js | LULUS | 65 |
| EDGE-SUP-004 | EDGE-SUP-004 stop kedua saat masih stopping → 200 idempoten (tanpa sinyal tambahan); worker yang tidak merespons di-SIGKILL setelah 15 detik | tests/edge/workerControl.edge.test.js | LULUS | 73 |
| INT-PWC-001 | INT-PWC-001 kata sandi dari stdin: hash diganti, sesi lama dicabut, audit via cli | tests/integration/userPassword.cli.test.js | LULUS | 959 |
| INT-PWC-002 | INT-PWC-002 tanpa --username atau dengan kata sandi di argumen → pemakaian, database tidak berubah | tests/integration/userPassword.cli.test.js | LULUS | 204 |
| INT-PWC-003 | INT-PWC-003 pelanggaran kebijakan & pengguna tidak dikenal → exit 1 dengan pesan | tests/integration/userPassword.cli.test.js | LULUS | 324 |
| INT-WRK-001 | INT-WRK-001 start: discovery REST → tabel symbols → bootstrap candle tertutup per simbol×timeframe → heartbeat berisi metrik & recordRun di SQLite | tests/integration/worker.integration.test.js | LULUS | 142 |
| INT-WRK-002 | INT-WRK-002 kline WS tertutup satu per satu → candle "ws" di SQLite → sinyal SA identik dengan replay murni; kline berjalan hanya ke tabel provisional | tests/integration/worker.integration.test.js | LULUS | 322 |
| INT-WRK-003 | INT-WRK-003 lompatan openTime di WS → backfill REST sebelum analisis; pipeline me-replay candle backfill berurutan tanpa sinyal ganda | tests/integration/worker.integration.test.js | LULUS | 261 |
| INT-WRK-004 | INT-WRK-004 stop(): tanpa timer tersisa, socket ditutup 1000, heartbeat akhir "stopped" di SQLite, tidak ada aktivitas sesudahnya | tests/integration/worker.integration.test.js | LULUS | 67 |
| INT-WRK-005 | INT-WRK-005 likuiditas discovery (mode manual) mengalir ke pipeline → risk flag POOR_LIQUIDITY & WIDE_SPREAD di sinyal tersimpan | tests/integration/worker.integration.test.js | LULUS | 150 |
| INT-WRK-013 | INT-WRK-013 ambang likuiditas pengguna (mode manual, min 5 jt / maks 50 bps) → risk flag & penjelasan memakai batas pengguna: POOR_LIQUIDITY tetap, WIDE_SPREAD hilang | tests/integration/worker.integration.test.js | LULUS | 181 |
| INT-WRK-006 | INT-WRK-006 delisting (SETTLING) saat rediscovery → repositori simbol menandai delisted, stream diganti, pesan terlambat diabaikan; listing ulang menyambung histori tanpa gap | tests/integration/worker.integration.test.js | LULUS | 196 |
| INT-WRK-016 | INT-WRK-016 delisting simbol dengan sinyal terbuka (SA, EARLY_BULLISH) → sinyal EXPIRED reason SYMBOL_DELISTED tanpa alert & hilang dari screener; listing ulang → replay membuka sinyal BARU, identik dengan replay murni sejak candle 64 | tests/integration/worker.integration.test.js | LULUS | 175 |
| INT-WRK-026 | INT-WRK-026 rediscovery menerima exchangeInfo tanpa simbol (respons anomali) saat SA punya sinyal terbuka → 0 simbol terpilih dianggap anomali: tidak ada delisting/penutupan sinyal, stream tetap, error "discovery"; percobaan ulang normal → hasil akhir = replay murni seolah tidak terjadi apa-apa | tests/integration/worker.integration.test.js | LULUS | 217 |
| INT-WRK-027 | INT-WRK-027 mode manual [SYNUSDT] dengan sinyal SA terbuka, simbol menjadi SETTLING → 0 simbol terpilih dijelaskan exchangeInfo (bukan anomali): simbol delisted, stream dilepas, sinyal EXPIRED reason SYMBOL_DELISTED tersimpan; tanpa error "discovery" | tests/integration/worker.integration.test.js | LULUS | 119 |
| INT-WRK-021 | INT-WRK-021 penutupan sinyal simbol delisted gagal sekali (SQLITE_BUSY) → error "monitoring" tercatat, sinyal masih terbuka; rediscovery berikutnya mencoba lagi (level-triggered) → EXPIRED reason SYMBOL_DELISTED | tests/integration/worker.integration.test.js | LULUS | 140 |
| INT-WRK-022 | INT-WRK-022 restart di atas database dengan sinyal yatim (simbol is_monitored=0 — DB lama / stop() di tengah siklus) yang kini SETTLING → start pertama menutupnya EXPIRED SYMBOL_DELISTED; simbol lain tidak tersentuh | tests/integration/worker.integration.test.js | LULUS | 98 |
| INT-WRK-007 | INT-WRK-007 restart worker di atas database yang sama: bootstrap hanya mengambil candle setelah lastOpenTime, sinyal terbuka dilanjutkan tanpa sinyal/event ganda | tests/integration/worker.integration.test.js | LULUS | 147 |
| INT-WRK-008 | INT-WRK-008 kline final tiba 200 ms sebelum closeTime menurut jam worker (jam tertinggal ≤ toleransi WS 2 d) → bendera x bursa dipercaya: langsung disimpan & dianalisis "live", tanpa error validasi dan tanpa backfill gap | tests/integration/worker.integration.test.js | LULUS | 198 |
| INT-WRK-023 | INT-WRK-023 kline final tiba 2,5 d sebelum closeTime menurut jam worker (melebihi toleransi WS 2 d — jam rusak) → ditolak validasi, dicatat, lalu dipulihkan backfill gap tanpa mengubah sinyal | tests/integration/worker.integration.test.js | LULUS | 228 |
| INT-WRK-014 | INT-WRK-014 jam server 1 detik di depan jam lokal: sync /fapi/v1/time → offset +1000; kline final yang tiba 500 ms sebelum closeTime menurut jam lokal langsung diterima (tanpa error validasi & tanpa backfill gap) | tests/integration/worker.integration.test.js | LULUS | 246 |
| INT-WRK-015 | INT-WRK-015 /fapi/v1/time gagal (HTTP 400) saat start → worker tetap bootstrap dengan offset 0, error ingesti "clock" tercatat; rediscovery berikutnya menyinkronkan ulang | tests/integration/worker.integration.test.js | LULUS | 67 |
| INT-WRK-024 | INT-WRK-024 /fapi/v1/time melaporkan jam 11 menit di depan (melebihi batas ±10 menit, OFFSET_OUT_OF_RANGE) → offset tidak diterapkan, worker tetap ingest tetapi heartbeat "degraded" + clockFault, error ingesti "clock" tercatat; sync normal berikutnya → "running" lagi | tests/integration/worker.integration.test.js | LULUS | 64 |
| INT-WRK-028 | INT-WRK-028 jam host 11 menit DI DEPAN Binance (/fapi/v1/time → OFFSET_OUT_OF_RANGE, offset tidak diterapkan) → degraded, tetapi isClosed REST & rencana bootstrap/sweep memakai serverClock.closureNow: tidak ada candle berjalan yang tersimpan sebagai tertutup atau dianalisis; sweep berkala hanya menambah candle yang final menurut server | tests/integration/worker.integration.test.js | LULUS | 19 |
| INT-WRK-018 | INT-WRK-018 /fapi/v1/time dijawab 429 (Retry-After 4 d) saat start lalu 503 saat rediscovery → sampel jam satu percobaan tanpa retry/antrean limiter di dalam round-trip: offset tetap 0 (bukan +2000 / +187), tanpa error ingesti | tests/integration/worker.integration.test.js | LULUS | 64 |
| INT-WRK-019 | INT-WRK-019 jam host 2 menit di DEPAN server (offset −120000): heartbeat, run, error, dan lastIngestionAt distempel jam LOKAL → summarizeWorker dengan jam lokal API melaporkan scanner "ok" (umur 0), bukan "stale"; candleLagMs tetap memakai jam server | tests/integration/worker.integration.test.js | LULUS | 18 |
| INT-WRK-020 | INT-WRK-020 jam host 5 menit di BELAKANG server (offset +300000): heartbeat distempel jam lokal → worker yang berhenti menulis heartbeat terdeteksi "stale" setelah 90 detik, bukan 90 detik + offset | tests/integration/worker.integration.test.js | LULUS | 10 |
| INT-WRK-017 | INT-WRK-017 perakitan produksi (worker/assemble.js), jam server 4 m 56 d di DEPAN jam lokal → candle 5m #48 yang sudah tertutup menurut server (belum menurut jam lokal) ikut di-bootstrap: isClosed REST & validasi repositori memakai serverClock.now; candle #49 yang masih berjalan ditolak repositori | tests/integration/worker.integration.test.js | LULUS | 11 |
| INT-WRK-009 | INT-WRK-009 histori panjang: bootstrap 500 candle penuh, konteks HTF bertrend nyata; candle 15m/1h yang tiba SETELAH candle 5m ditunggu (settleMs seperti worker/index.js) → snapshot per candle = replay murni | tests/integration/worker.integration.test.js | LULUS | 390 |
| INT-WRK-025 | INT-WRK-025 pengaturan hanya 5m (15m/1h tidak dipilih) → 15m/1h tetap diingesti sebagai konteks HTF: snapshot 5m (alignment, risk flag, penjelasan) = replay murni dengan konteks HTF; 15m/1h tidak pernah dianalisis | tests/integration/worker.integration.test.js | LULUS | 313 |
| INT-WRK-010 | INT-WRK-010 kontrol: tanpa settleMs, candle HTF yang tiba belakangan membuat snapshot 5m di batas jam berbeda dari replay (race yang ditutup settleMs) | tests/integration/worker.integration.test.js | LULUS | 245 |
| INT-WRK-011 | INT-WRK-011 WS putus ~20 menit (handshake ditolak) → heartbeat degraded, reconnect dengan backoff, sweep REST mengisi candle terlewat; sinyal tetap = replay | tests/integration/worker.integration.test.js | LULUS | 210 |
| INT-WRK-012 | INT-WRK-012 Binance HTTP 503 saat backfill gap → klien REST mengulang dengan backoff lalu menyerah, error tercatat; gap berikutnya menutup semuanya berurutan | tests/integration/worker.integration.test.js | LULUS | 224 |
| INT-SUP-001 | INT-SUP-001 start → proses hidup & heartbeat running di SQLite; stop → SIGTERM, keluar kode 0, heartbeat akhir stopped, tanpa proses tersisa | tests/integration/workerSupervisor.integration.test.js | LULUS | 169 |
| INT-SUP-002 | INT-SUP-002 child yang mengabaikan SIGTERM dihentikan paksa dengan SIGKILL setelah stopTimeoutMs | tests/integration/workerSupervisor.integration.test.js | LULUS | 509 |
| INT-SUP-003 | INT-SUP-003 child yang keluar sendiri dengan kode 3 → crashed (kode keluar 3); start ulang berhasil | tests/integration/workerSupervisor.integration.test.js | LULUS | 222 |
| INT-SUP-004 | INT-SUP-004 baris stdout raksasa dari child dipotong pada MAX_LINE_LENGTH | tests/integration/workerSupervisor.integration.test.js | LULUS | 114 |
| INT-SUP-007 | INT-SUP-007 server dibunuh paksa (SIGKILL, tanpa shutdown) → child mendeteksi kanal IPC putus dan berhenti sendiri (heartbeat akhir stopped, tanpa yatim) | tests/integration/workerSupervisor.integration.test.js | LULUS | 1167 |
| INT-SUP-005 | INT-SUP-005 skrip yang tidak ada → node keluar kode 1 → crashed, error tampil di log server | tests/integration/workerSupervisor.integration.test.js | LULUS | 66 |
| INT-SUP-006 | INT-SUP-006 tombol start lewat API menjalankan child yang menulis ke DATABASE_PATH server; app.close() menghentikan child (tanpa yatim) | tests/integration/workerSupervisor.integration.test.js | LULUS | 380 |
| NEG-AUTH-001 | NEG-AUTH-001 kata sandi salah → 401 generik tanpa cookie | tests/negative/auth.negative.test.js | LULUS | 283 |
| NEG-AUTH-002 | NEG-AUTH-002 username tidak dikenal → respons identik dengan kata sandi salah (anti enumerasi) | tests/negative/auth.negative.test.js | LULUS | 101 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/auth/session tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 78 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/auth/sessions tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 73 |
| NEG-AUTH-003 | NEG-AUTH-003 POST /api/auth/logout tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 67 |
| NEG-AUTH-003 | NEG-AUTH-003 DELETE /api/auth/sessions/1 tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 48 |
| NEG-AUTH-003 | NEG-AUTH-003 POST /api/auth/sessions/revoke-others tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 30 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/settings/scanner tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 74 |
| NEG-AUTH-003 | NEG-AUTH-003 PUT /api/settings/scanner tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 50 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/system/status tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 44 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/overview tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 40 |
| NEG-AUTH-003 | NEG-AUTH-003 GET /api/does-not-exist tanpa sesi → 401 | tests/negative/auth.negative.test.js | LULUS | 95 |
| NEG-AUTH-004 | NEG-AUTH-004 cookie palsu (token acak berformat benar) → 401 | tests/negative/auth.negative.test.js | LULUS | 48 |
| NEG-AUTH-004 | NEG-AUTH-004 cookie palsu (token berformat salah) → 401 | tests/negative/auth.negative.test.js | LULUS | 61 |
| NEG-AUTH-004 | NEG-AUTH-004 cookie palsu (cookie kosong) → 401 | tests/negative/auth.negative.test.js | LULUS | 50 |
| NEG-AUTH-005 | NEG-AUTH-005 dashboard tanpa sesi diarahkan ke login; /index.html tidak dapat diakses langsung | tests/negative/auth.negative.test.js | LULUS | 78 |
| NEG-AUTH-006 | NEG-AUTH-006 sesi idle kedaluwarsa → 401 | tests/negative/auth.negative.test.js | LULUS | 79 |
| NEG-AUTH-007 | NEG-AUTH-007 akun terkunci setelah N kegagalan — kata sandi benar pun ditolak sampai masa kunci habis | tests/negative/auth.negative.test.js | LULUS | 95 |
| NEG-AUTH-008 | NEG-AUTH-008 akun dinonaktifkan tidak dapat login | tests/negative/auth.negative.test.js | LULUS | 51 |
| NEG-AUTH-009 | NEG-AUTH-009 audit kegagalan tidak menyimpan kata sandi yang dicoba | tests/negative/auth.negative.test.js | LULUS | 43 |
| NEG-RL-001 | NEG-RL-001 percobaan ke-6 dalam jendela waktu → 429 | tests/negative/auth.negative.test.js | LULUS | 55 |
| NEG-CSRF-001 | NEG-CSRF-001 request terautentikasi tanpa X-CSRF-Token → 403 | tests/negative/auth.negative.test.js | LULUS | 56 |
| NEG-CSRF-002 | NEG-CSRF-002 token CSRF salah atau milik sesi lain → 403 | tests/negative/auth.negative.test.js | LULUS | 52 |
| NEG-CSRF-003 | NEG-CSRF-003 Origin asing ditolak, termasuk pada login | tests/negative/auth.negative.test.js | LULUS | 67 |
| NEG-CSRF-004 | NEG-CSRF-004 Sec-Fetch-Site: cross-site ditolak | tests/negative/auth.negative.test.js | LULUS | 50 |
| NEG-CSRF-005 | NEG-CSRF-005 content-type "simple request" text/plain ditolak (415) | tests/negative/auth.negative.test.js | LULUS | 34 |
| NEG-CSRF-005 | NEG-CSRF-005 content-type "simple request" application/x-www-form-urlencoded ditolak (415) | tests/negative/auth.negative.test.js | LULUS | 48 |
| NEG-CSRF-005 | NEG-CSRF-005 content-type "simple request" multipart/form-data; boundary=x ditolak (415) | tests/negative/auth.negative.test.js | LULUS | 46 |
| NEG-IN-001 | NEG-IN-001 JSON rusak → 400 tanpa stack trace | tests/negative/input.negative.test.js | LULUS | 317 |
| NEG-IN-002 | NEG-IN-002 payload > 64KB → 413 | tests/negative/input.negative.test.js | LULUS | 86 |
| NEG-IN-003 | NEG-IN-003 login dengan field tambahan → 400 | tests/negative/input.negative.test.js | LULUS | 52 |
| NEG-IN-003 | NEG-IN-003 login dengan username bukan string → 400 | tests/negative/input.negative.test.js | LULUS | 70 |
| NEG-IN-003 | NEG-IN-003 login dengan username karakter ilegal → 400 | tests/negative/input.negative.test.js | LULUS | 82 |
| NEG-IN-003 | NEG-IN-003 login dengan tanpa password → 400 | tests/negative/input.negative.test.js | LULUS | 58 |
| NEG-IN-003 | NEG-IN-003 login dengan password terlalu panjang → 400 | tests/negative/input.negative.test.js | LULUS | 56 |
| NEG-IN-003 | NEG-IN-003 login dengan body array → 400 | tests/negative/input.negative.test.js | LULUS | 66 |
| NEG-IN-004 | NEG-IN-004 prototype pollution via __proto__ / constructor ditolak | tests/negative/input.negative.test.js | LULUS | 66 |
| NEG-IN-005 | NEG-IN-005 SQL injection pada password diperlakukan sebagai teks biasa | tests/negative/input.negative.test.js | LULUS | 51 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan XSS pada simbol manual → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 57 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan simbol non-USDT → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 51 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan simbol tanpa base asset → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 60 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan timeframe tidak didukung → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 53 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan timeframe duplikat → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 50 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan timeframe kosong → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 39 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan angka sebagai string (tanpa coercion) → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 33 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan maxAuto pecahan → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 28 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan spread negatif → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 34 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan volume di atas batas → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 36 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan field tak dikenal → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 34 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan mode manual tanpa simbol → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 77 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan tahap alert tidak dikenal → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 47 |
| NEG-IN-006 | NEG-IN-006 pengaturan dengan simbol > 100 → 400 dan tidak tersimpan | tests/negative/input.negative.test.js | LULUS | 48 |
| NEG-IN-007 | NEG-IN-007 version negatif / bukan integer → 400 | tests/negative/input.negative.test.js | LULUS | 56 |
| NEG-IN-008 | NEG-IN-008 id sesi tidak valid "0" → 400 | tests/negative/input.negative.test.js | LULUS | 43 |
| NEG-IN-008 | NEG-IN-008 id sesi tidak valid "-1" → 400 | tests/negative/input.negative.test.js | LULUS | 50 |
| NEG-IN-008 | NEG-IN-008 id sesi tidak valid "abc" → 400 | tests/negative/input.negative.test.js | LULUS | 50 |
| NEG-IN-008 | NEG-IN-008 id sesi tidak valid "1e3" → 400 | tests/negative/input.negative.test.js | LULUS | 56 |
| NEG-IN-008 | NEG-IN-008 id sesi tidak valid "99999999999999999999" → 400 | tests/negative/input.negative.test.js | LULUS | 67 |
| NEG-AZ-001 | NEG-AZ-001 analyst tidak dapat mengubah pengaturan (403) dan tidak ada perubahan | tests/negative/input.negative.test.js | LULUS | 37 |
| NEG-AZ-002 | NEG-AZ-002 pengguna tidak dapat mencabut sesi milik pengguna lain (404, sesi tetap aktif) | tests/negative/input.negative.test.js | LULUS | 47 |
| NEG-AZ-003 | NEG-AZ-003 daftar sesi hanya memuat sesi milik sendiri | tests/negative/input.negative.test.js | LULUS | 53 |
| NEG-SIG-001 | NEG-SIG-001 /api/signals/active tanpa sesi → 401 | tests/negative/signals.negative.test.js | LULUS | 278 |
| NEG-SIG-001 | NEG-SIG-001 /api/signals/history tanpa sesi → 401 | tests/negative/signals.negative.test.js | LULUS | 57 |
| NEG-SIG-002 | NEG-SIG-002 timeframe tidak didukung → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 50 |
| NEG-SIG-002 | NEG-SIG-002 state terminal bukan filter aktif → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 49 |
| NEG-SIG-002 | NEG-SIG-002 klasifikasi NONE → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 82 |
| NEG-SIG-002 | NEG-SIG-002 minScore di atas 100 → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 63 |
| NEG-SIG-002 | NEG-SIG-002 minScore negatif → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 54 |
| NEG-SIG-002 | NEG-SIG-002 minScore pecahan → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 56 |
| NEG-SIG-002 | NEG-SIG-002 limit nol → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 55 |
| NEG-SIG-002 | NEG-SIG-002 limit bukan angka → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 43 |
| NEG-SIG-002 | NEG-SIG-002 limit > 999 → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 51 |
| NEG-SIG-002 | NEG-SIG-002 parameter tak dikenal → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 64 |
| NEG-SIG-002 | NEG-SIG-002 parameter ganda (array) → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 53 |
| NEG-SIG-002 | NEG-SIG-002 simbol huruf kecil → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 50 |
| NEG-SIG-002 | NEG-SIG-002 simbol injeksi SQL → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 43 |
| NEG-SIG-002 | NEG-SIG-002 simbol terlalu panjang → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 42 |
| NEG-SIG-004 | NEG-SIG-004 timeframe kosong → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 58 |
| NEG-SIG-004 | NEG-SIG-004 timeframe huruf besar → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 44 |
| NEG-SIG-004 | NEG-SIG-004 timeframe 1d → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 37 |
| NEG-SIG-004 | NEG-SIG-004 klasifikasi huruf kecil → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 29 |
| NEG-SIG-004 | NEG-SIG-004 klasifikasi kosong → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 40 |
| NEG-SIG-004 | NEG-SIG-004 state NO_PATTERN → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 53 |
| NEG-SIG-004 | NEG-SIG-004 state EXPIRED → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 38 |
| NEG-SIG-004 | NEG-SIG-004 state huruf kecil → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 49 |
| NEG-SIG-004 | NEG-SIG-004 minScore kosong → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 38 |
| NEG-SIG-004 | NEG-SIG-004 minScore nol di depan → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 34 |
| NEG-SIG-004 | NEG-SIG-004 minScore bukan angka → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 42 |
| NEG-SIG-004 | NEG-SIG-004 minScore eksponen → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 42 |
| NEG-SIG-004 | NEG-SIG-004 limit kosong → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 45 |
| NEG-SIG-004 | NEG-SIG-004 limit negatif → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 32 |
| NEG-SIG-004 | NEG-SIG-004 limit pecahan → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 49 |
| NEG-SIG-004 | NEG-SIG-004 limit nol di depan → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 27 |
| NEG-SIG-004 | NEG-SIG-004 history limit nol → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 30 |
| NEG-SIG-004 | NEG-SIG-004 history limit bukan angka → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 26 |
| NEG-SIG-004 | NEG-SIG-004 history parameter filter aktif → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 39 |
| NEG-SIG-005 | NEG-SIG-005 active limit 501 (di atas 500) → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 38 |
| NEG-SIG-005 | NEG-SIG-005 active limit 750 (di atas 500) → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 44 |
| NEG-SIG-005 | NEG-SIG-005 active limit 999 (di atas 500) → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 48 |
| NEG-SIG-005 | NEG-SIG-005 history limit 501 (di atas 500) → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 61 |
| NEG-SIG-005 | NEG-SIG-005 history limit 999 (di atas 500) → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 59 |
| NEG-SIG-006 | NEG-SIG-006 listActive dengan limit 501 → RangeError (batas repositori = batas API 500); 500 diterima | tests/negative/signals.negative.test.js | LULUS | 55 |
| NEG-SIG-007 | NEG-SIG-007 alignment tidak dikenal → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 54 |
| NEG-SIG-007 | NEG-SIG-007 alignment huruf kecil → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 44 |
| NEG-SIG-007 | NEG-SIG-007 alignment kosong → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 40 |
| NEG-SIG-007 | NEG-SIG-007 alignment null literal → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 52 |
| NEG-SIG-007 | NEG-SIG-007 alignment ganda (array) → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 42 |
| NEG-SIG-007 | NEG-SIG-007 alignment di riwayat → 400 VALIDATION_ERROR | tests/negative/signals.negative.test.js | LULUS | 45 |
| NEG-SIG-008 | NEG-SIG-008 listActive menolak alignment tidak valid (termasuk upaya injeksi SQL) dengan RangeError | tests/negative/signals.negative.test.js | LULUS | 49 |
| NEG-SIG-003 | NEG-SIG-003 POST ke endpoint sinyal (baca saja) → 404 | tests/negative/signals.negative.test.js | LULUS | 50 |
| NEG-SIG-003 | NEG-SIG-003 PUT ke endpoint sinyal (baca saja) → 404 | tests/negative/signals.negative.test.js | LULUS | 46 |
| NEG-SIG-003 | NEG-SIG-003 DELETE ke endpoint sinyal (baca saja) → 404 | tests/negative/signals.negative.test.js | LULUS | 51 |
| NEG-SUP-001 | NEG-SUP-001 GET /api/system/worker tanpa sesi → 401, worker tidak dijalankan | tests/negative/workerControl.negative.test.js | LULUS | 274 |
| NEG-SUP-001 | NEG-SUP-001 POST /api/system/worker/start tanpa sesi → 401, worker tidak dijalankan | tests/negative/workerControl.negative.test.js | LULUS | 73 |
| NEG-SUP-001 | NEG-SUP-001 POST /api/system/worker/stop tanpa sesi → 401, worker tidak dijalankan | tests/negative/workerControl.negative.test.js | LULUS | 66 |
| NEG-SUP-002 | NEG-SUP-002 analyst POST start → 403 FORBIDDEN, worker tidak disentuh | tests/negative/workerControl.negative.test.js | LULUS | 85 |
| NEG-SUP-002 | NEG-SUP-002 analyst POST stop → 403 FORBIDDEN, worker tidak disentuh | tests/negative/workerControl.negative.test.js | LULUS | 67 |
| NEG-SUP-003 | NEG-SUP-003 start kedua saat berjalan → 409 WORKER_ALREADY_RUNNING; audit failure berisi alasan | tests/negative/workerControl.negative.test.js | LULUS | 67 |
| NEG-SUP-004 | NEG-SUP-004 stop tanpa worker berjalan → 409 WORKER_NOT_RUNNING (audit failure) | tests/negative/workerControl.negative.test.js | LULUS | 70 |
| NEG-SUP-005 | NEG-SUP-005 worker di luar website (heartbeat segar di database) → GET external; start & stop 409 WORKER_EXTERNAL tanpa fork | tests/negative/workerControl.negative.test.js | LULUS | 88 |
| NEG-SUP-006 | NEG-SUP-006 start saat worker sedang dihentikan → 409 WORKER_STOPPING | tests/negative/workerControl.negative.test.js | LULUS | 49 |
| NEG-SUP-007 | NEG-SUP-007 kontrol nonaktif (default test/produksi) → POST start 503 WORKER_CONTROL_DISABLED, audit failure | tests/negative/workerControl.negative.test.js | LULUS | 56 |
| NEG-SUP-007 | NEG-SUP-007 kontrol nonaktif (default test/produksi) → POST stop 503 WORKER_CONTROL_DISABLED, audit failure | tests/negative/workerControl.negative.test.js | LULUS | 60 |
| NEG-SUP-008 | NEG-SUP-008 WORKER_AUTOSTART=true tanpa WORKER_CONTROL → diabaikan (tidak ada fork) | tests/negative/workerControl.negative.test.js | LULUS | 44 |
| NEG-SUP-009 | NEG-SUP-009 autostart saat worker lain sudah berjalan → dibatalkan & diaudit, server tetap siap | tests/negative/workerControl.negative.test.js | LULUS | 46 |
| POS-SYS-001 | POS-SYS-001 health & ready publik | tests/positive/api.positive.test.js | LULUS | 321 |
| POS-SYS-002 | POS-SYS-002 status sistem berisi metrik nyata; worker yang belum pernah berjalan dilaporkan jujur | tests/positive/api.positive.test.js | LULUS | 89 |
| POS-SYS-005 | POS-SYS-005 heartbeat worker di database tampil di status sistem & overview; heartbeat basi → stale | tests/positive/api.positive.test.js | LULUS | 81 |
| POS-SYS-003 | POS-SYS-003 overview menghitung dari database (kosong → nol) | tests/positive/api.positive.test.js | LULUS | 61 |
| POS-SYS-004 | POS-SYS-004 overview mencerminkan baris nyata di database | tests/positive/api.positive.test.js | LULUS | 80 |
| POS-SYS-006 | POS-SYS-006 konteks pasar BTC/ETH dari candle 1h tersimpan; simbol tanpa data → no_data (bukan angka contoh) | tests/positive/api.positive.test.js | LULUS | 75 |
| POS-SET-001 | POS-SET-001 pengaturan default dikembalikan sebelum pernah disimpan | tests/positive/api.positive.test.js | LULUS | 44 |
| POS-SET-002 | POS-SET-002 admin menyimpan pengaturan valid → versi naik, persisten, tercatat audit | tests/positive/api.positive.test.js | LULUS | 52 |
| POS-SET-003 | POS-SET-003 analyst dapat membaca pengaturan | tests/positive/api.positive.test.js | LULUS | 43 |
| POS-AUTH-001 | POS-AUTH-001 login valid → 200, cookie HttpOnly + SameSite=Strict, token CSRF, tanpa hash di respons | tests/positive/auth.positive.test.js | LULUS | 281 |
| POS-AUTH-002 | POS-AUTH-002 cookie __Host- dan Secure saat origin HTTPS | tests/positive/auth.positive.test.js | LULUS | 130 |
| POS-AUTH-003 | POS-AUTH-003 sesi aktif dapat dibaca | tests/positive/auth.positive.test.js | LULUS | 77 |
| POS-AUTH-004 | POS-AUTH-004 logout mencabut sesi di server | tests/positive/auth.positive.test.js | LULUS | 69 |
| POS-AUTH-005 | POS-AUTH-005 dashboard disajikan hanya untuk sesi valid; login page mengarahkan ke dashboard | tests/positive/auth.positive.test.js | LULUS | 78 |
| POS-AUTH-006 | POS-AUTH-006 daftar sesi & cabut sesi lain | tests/positive/auth.positive.test.js | LULUS | 66 |
| POS-AUTH-007 | POS-AUTH-007 cabut satu sesi tertentu milik sendiri | tests/positive/auth.positive.test.js | LULUS | 62 |
| POS-AUTH-008 | POS-AUTH-008 login & logout tercatat di audit log | tests/positive/auth.positive.test.js | LULUS | 73 |
| POS-AUTH-009 | POS-AUTH-009 dua pengguna dapat login bersamaan secara independen | tests/positive/auth.positive.test.js | LULUS | 55 |
| POS-SIG-001 | POS-SIG-001 database kosong → daftar kosong, bukan data contoh | tests/positive/signals.api.test.js | LULUS | 297 |
| POS-SIG-002 | POS-SIG-002 sinyal dari pipeline tampil di daftar aktif dengan skor, penjelasan, dan harga terakhir | tests/positive/signals.api.test.js | LULUS | 180 |
| POS-SIG-003 | POS-SIG-003 filter timeframe/klasifikasi/skor diterapkan di server | tests/positive/signals.api.test.js | LULUS | 118 |
| POS-SIG-004 | POS-SIG-004 riwayat memuat transisi state berurutan, dapat difilter per simbol | tests/positive/signals.api.test.js | LULUS | 137 |
| POS-SIG-005 | POS-SIG-005 analyst (bukan admin) boleh membaca sinyal | tests/positive/signals.api.test.js | LULUS | 55 |
| POS-SIG-006 | POS-SIG-006 tanpa filter → 6 sinyal aktif urut patternScore lalu update terbaru; sinyal tertutup & harga tak dikenal tidak dikarang | tests/positive/signals.api.test.js | LULUS | 59 |
| POS-SIG-007 | POS-SIG-007 timeframe=5m → hanya sinyal timeframe itu ["AAAUSDT","DDDUSDT","EEEUSDT"] | tests/positive/signals.api.test.js | LULUS | 48 |
| POS-SIG-007 | POS-SIG-007 timeframe=15m → hanya sinyal timeframe itu ["BBBUSDT","GGGUSDT"] | tests/positive/signals.api.test.js | LULUS | 64 |
| POS-SIG-007 | POS-SIG-007 timeframe=1h → hanya sinyal timeframe itu ["CCCUSDT"] | tests/positive/signals.api.test.js | LULUS | 43 |
| POS-SIG-008 | POS-SIG-008 classification=SA → hanya klasifikasi itu ["AAAUSDT","GGGUSDT","EEEUSDT"] | tests/positive/signals.api.test.js | LULUS | 43 |
| POS-SIG-008 | POS-SIG-008 classification=PVA → hanya klasifikasi itu ["DDDUSDT","BBBUSDT"] | tests/positive/signals.api.test.js | LULUS | 49 |
| POS-SIG-008 | POS-SIG-008 classification=BOTH → hanya klasifikasi itu ["CCCUSDT"] | tests/positive/signals.api.test.js | LULUS | 44 |
| POS-SIG-009 | POS-SIG-009 state=QUIET → hanya sinyal pada tahap itu ["BBBUSDT","EEEUSDT"] | tests/positive/signals.api.test.js | LULUS | 42 |
| POS-SIG-009 | POS-SIG-009 state=EARLY_BULLISH → hanya sinyal pada tahap itu ["AAAUSDT","GGGUSDT"] | tests/positive/signals.api.test.js | LULUS | 40 |
| POS-SIG-009 | POS-SIG-009 state=MOMENTUM_BUILDING → hanya sinyal pada tahap itu ["CCCUSDT"] | tests/positive/signals.api.test.js | LULUS | 41 |
| POS-SIG-009 | POS-SIG-009 state=BREAKOUT → hanya sinyal pada tahap itu ["DDDUSDT"] | tests/positive/signals.api.test.js | LULUS | 46 |
| POS-SIG-010 | POS-SIG-010 minScore=0 → hanya patternScore ≥ batas (inklusif) ["AAAUSDT","DDDUSDT","CCCUSDT","BBBUSDT","GGGUSDT","EEEUSDT"] | tests/positive/signals.api.test.js | LULUS | 55 |
| POS-SIG-010 | POS-SIG-010 minScore=75 → hanya patternScore ≥ batas (inklusif) ["AAAUSDT","DDDUSDT","CCCUSDT"] | tests/positive/signals.api.test.js | LULUS | 50 |
| POS-SIG-010 | POS-SIG-010 minScore=76 → hanya patternScore ≥ batas (inklusif) ["AAAUSDT"] | tests/positive/signals.api.test.js | LULUS | 47 |
| POS-SIG-010 | POS-SIG-010 minScore=100 → hanya patternScore ≥ batas (inklusif) [] | tests/positive/signals.api.test.js | LULUS | 42 |
| POS-SIG-011 | POS-SIG-011 limit=1 → limit memotong setelah urutan & filter digabung (AND) ["AAAUSDT"] | tests/positive/signals.api.test.js | LULUS | 36 |
| POS-SIG-011 | POS-SIG-011 limit=3 → limit memotong setelah urutan & filter digabung (AND) ["AAAUSDT","DDDUSDT","CCCUSDT"] | tests/positive/signals.api.test.js | LULUS | 46 |
| POS-SIG-011 | POS-SIG-011 timeframe=5m&minScore=50&limit=1 → limit memotong setelah urutan & filter digabung (AND) ["AAAUSDT"] | tests/positive/signals.api.test.js | LULUS | 47 |
| POS-SIG-011 | POS-SIG-011 timeframe=5m&state=QUIET → limit memotong setelah urutan & filter digabung (AND) ["EEEUSDT"] | tests/positive/signals.api.test.js | LULUS | 51 |
| POS-SIG-011 | POS-SIG-011 classification=SA&state=EARLY_BULLISH&minScore=60 → limit memotong setelah urutan & filter digabung (AND) ["AAAUSDT"] | tests/positive/signals.api.test.js | LULUS | 48 |
| POS-SIG-013 | POS-SIG-013 limit=1 (batas 1–500) diterima untuk daftar aktif & riwayat | tests/positive/signals.api.test.js | LULUS | 48 |
| POS-SIG-013 | POS-SIG-013 limit=9 (batas 1–500) diterima untuk daftar aktif & riwayat | tests/positive/signals.api.test.js | LULUS | 50 |
| POS-SIG-013 | POS-SIG-013 limit=10 (batas 1–500) diterima untuk daftar aktif & riwayat | tests/positive/signals.api.test.js | LULUS | 50 |
| POS-SIG-013 | POS-SIG-013 limit=99 (batas 1–500) diterima untuk daftar aktif & riwayat | tests/positive/signals.api.test.js | LULUS | 39 |
| POS-SIG-013 | POS-SIG-013 limit=100 (batas 1–500) diterima untuk daftar aktif & riwayat | tests/positive/signals.api.test.js | LULUS | 40 |
| POS-SIG-013 | POS-SIG-013 limit=499 (batas 1–500) diterima untuk daftar aktif & riwayat | tests/positive/signals.api.test.js | LULUS | 36 |
| POS-SIG-013 | POS-SIG-013 limit=500 (batas 1–500) diterima untuk daftar aktif & riwayat | tests/positive/signals.api.test.js | LULUS | 38 |
| POS-SIG-014 | POS-SIG-014 alignment=ALIGNED → hanya alignment itu, alignment null (tidak diketahui) tidak ikut ["AAAUSDT","GGGUSDT"] | tests/positive/signals.api.test.js | LULUS | 40 |
| POS-SIG-014 | POS-SIG-014 alignment=PARTIALLY_CONFIRMED → hanya alignment itu, alignment null (tidak diketahui) tidak ikut ["CCCUSDT"] | tests/positive/signals.api.test.js | LULUS | 37 |
| POS-SIG-014 | POS-SIG-014 alignment=UNCONFIRMED → hanya alignment itu, alignment null (tidak diketahui) tidak ikut ["DDDUSDT"] | tests/positive/signals.api.test.js | LULUS | 49 |
| POS-SIG-014 | POS-SIG-014 alignment=COUNTERTREND → hanya alignment itu, alignment null (tidak diketahui) tidak ikut ["BBBUSDT"] | tests/positive/signals.api.test.js | LULUS | 38 |
| POS-SIG-015 | POS-SIG-015 alignment difilter SEBELUM limit: ALIGNED dengan patternScore terendah tetap masuk (bukan potongan top-N) | tests/positive/signals.api.test.js | LULUS | 42 |
| POS-SIG-012 | POS-SIG-012 riwayat memuat sinyal tertutup, urut deteksi terbaru, limit & simbol membedakan baris | tests/positive/signals.api.test.js | LULUS | 41 |
| POS-SUP-001 | POS-SUP-001 GET /api/system/worker untuk admin & analyst: state awal stopped | tests/positive/workerControl.positive.test.js | LULUS | 256 |
| POS-SUP-002 | POS-SUP-002 admin start → 200 running; fork worker/index.js; audit worker.start success; status sistem ikut berubah | tests/positive/workerControl.positive.test.js | LULUS | 85 |
| POS-SUP-003 | POS-SUP-003 admin stop → 200 stopping (SIGTERM); setelah child keluar → stopped; audit worker.stop success | tests/positive/workerControl.positive.test.js | LULUS | 64 |
| POS-SUP-004 | POS-SUP-004 /api/system/status memuat workerControl; default lingkungan test: kontrol nonaktif | tests/positive/workerControl.positive.test.js | LULUS | 80 |
| POS-SUP-005 | POS-SUP-005 WORKER_AUTOSTART=true → worker dijalankan saat server siap; audit tanpa user (via autostart) | tests/positive/workerControl.positive.test.js | LULUS | 59 |
| POS-SUP-006 | POS-SUP-006 app.close() (shutdown server) menghentikan worker lebih dulu: SIGTERM dan menunggu exit | tests/positive/workerControl.positive.test.js | LULUS | 72 |
| SEC-DEF-004 | SEC-DEF-004 buildApp sendiri (harness tes/E2E) tidak pernah membuat akun default | tests/security/defaultUser.security.test.js | LULUS | 259 |
| SEC-DEF-005 | SEC-DEF-005 akun default dapat login sebagai admin, lalu ganti kata sandi mencabut sesinya dan kata sandi lama ditolak | tests/security/defaultUser.security.test.js | LULUS | 106 |
| SEC-HDR-001 | SEC-HDR-001 CSP ketat tanpa unsafe-inline/unsafe-eval | tests/security/headers.security.test.js | LULUS | 15 |
| SEC-HDR-002 | SEC-HDR-002 header pelindung standar | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-HDR-003 | SEC-HDR-003 HSTS hanya aktif di produksi | tests/security/headers.security.test.js | LULUS | 79 |
| SEC-HDR-004 | SEC-HDR-004 respons API tidak di-cache | tests/security/headers.security.test.js | LULUS | 7 |
| SEC-CORS-001 | SEC-CORS-001 preflight lintas origin tidak diberi izin CORS | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /../package.json tidak bocor | tests/security/headers.security.test.js | LULUS | 6 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /%2e%2e/package.json tidak bocor | tests/security/headers.security.test.js | LULUS | 3 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /css/..%2f..%2fpackage.json tidak bocor | tests/security/headers.security.test.js | LULUS | 3 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /..%5c..%5cpackage.json tidak bocor | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /.env tidak bocor | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /.git/config tidak bocor | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /js/../../backend/app/config.js tidak bocor | tests/security/headers.security.test.js | LULUS | 3 |
| SEC-PATH-001 | SEC-PATH-001 path traversal / file tersembunyi /index.html tidak bocor | tests/security/headers.security.test.js | LULUS | 1 |
| SEC-ERR-001 | SEC-ERR-001 respons error tidak membocorkan stack trace atau path internal | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-ERR-002 | SEC-ERR-002 rute API tak dikenal (dengan sesi) → 404 JSON generik | tests/security/headers.security.test.js | LULUS | 2 |
| SEC-RL-001 | SEC-RL-001 rate limit global aktif pada API | tests/security/headers.security.test.js | LULUS | 1 |
| SEC-RL-002 | SEC-RL-002 aset statis tidak dihitung rate limit API (mencegah JS login gagal dimuat) | tests/security/headers.security.test.js | LULUS | 62 |
| SEC-UI-001 | SEC-UI-001 form login memakai POST dan tombol nonaktif sampai JS termuat (kredensial tidak pernah masuk URL) | tests/security/headers.security.test.js | LULUS | 45 |
| SEC-RT-001 | SEC-RT-001 /%61pi/overview tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 245 |
| SEC-RT-001 | SEC-RT-001 /%61%70%69/overview tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 66 |
| SEC-RT-001 | SEC-RT-001 /ap%69/overview tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 46 |
| SEC-RT-001 | SEC-RT-001 /%61pi/system/status tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 63 |
| SEC-RT-001 | SEC-RT-001 /%61%70%69/system/status tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 40 |
| SEC-RT-001 | SEC-RT-001 /ap%69/system/status tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 49 |
| SEC-RT-001 | SEC-RT-001 /%61pi/settings/scanner tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 34 |
| SEC-RT-001 | SEC-RT-001 /%61%70%69/settings/scanner tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 49 |
| SEC-RT-001 | SEC-RT-001 /ap%69/settings/scanner tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 36 |
| SEC-RT-001 | SEC-RT-001 /%61pi/signals/active tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 44 |
| SEC-RT-001 | SEC-RT-001 /%61%70%69/signals/active tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 41 |
| SEC-RT-001 | SEC-RT-001 /ap%69/signals/active tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 44 |
| SEC-RT-001 | SEC-RT-001 /%61pi/auth/session tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 46 |
| SEC-RT-001 | SEC-RT-001 /%61%70%69/auth/session tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 48 |
| SEC-RT-001 | SEC-RT-001 /ap%69/auth/session tanpa sesi → 401, tanpa data | tests/security/routing.security.test.js | LULUS | 53 |
| SEC-RT-002 | SEC-RT-002 analyst tidak dapat mengubah pengaturan admin lewat path ter-encode, dengan atau tanpa CSRF | tests/security/routing.security.test.js | LULUS | 76 |
| SEC-RT-003 | SEC-RT-003 admin dengan sesi tetap wajib CSRF lewat path ter-encode | tests/security/routing.security.test.js | LULUS | 52 |
| SEC-RT-004 | SEC-RT-004 rute API tak dikenal /api/tidak-ada: tanpa sesi 401, dengan sesi 404 | tests/security/routing.security.test.js | LULUS | 42 |
| SEC-RT-004 | SEC-RT-004 rute API tak dikenal /%61pi/tidak-ada: tanpa sesi 401, dengan sesi 404 | tests/security/routing.security.test.js | LULUS | 63 |
| SEC-RT-004 | SEC-RT-004 rute API tak dikenal /api/settings/scanner/extra: tanpa sesi 401, dengan sesi 404 | tests/security/routing.security.test.js | LULUS | 44 |
| SEC-RT-005 | SEC-RT-005 rate limit login berlaku juga untuk path ter-encode | tests/security/routing.security.test.js | LULUS | 69 |
| SEC-RT-006 | SEC-RT-006 rate limit global API menghitung request tanpa sesi juga | tests/security/routing.security.test.js | LULUS | 146 |
| SEC-RT-007 | SEC-RT-007 GET http://127.0.0.1/api/overview tanpa sesi → 401 | tests/security/routing.security.test.js | LULUS | 48 |
| SEC-RT-007 | SEC-RT-007 GET https://evil.example/api/system/status tanpa sesi → 401 | tests/security/routing.security.test.js | LULUS | 40 |
| SEC-RT-007 | SEC-RT-007 GET http://127.0.0.1/%61pi/settings/scanner tanpa sesi → 401 | tests/security/routing.security.test.js | LULUS | 62 |
| SEC-RT-008 | SEC-RT-008 polling /api/ready dengan cookie tidak memperpanjang idle; aktivitas API terautentikasi memperpanjang | tests/security/routing.security.test.js | LULUS | 59 |
| SEC-RT-011 | SEC-RT-011 auto-refresh (GET + X-LR-Background: 1) tetap terautentikasi tetapi tidak memperpanjang idle | tests/security/routing.security.test.js | LULUS | 48 |
| SEC-RT-009 | SEC-RT-009 route API yang terdaftar sebelum registerAuth (tanpa gerbang) ditolak, bukan dilayani | tests/security/routing.security.test.js | LULUS | 4 |
| SEC-RT-010 | SEC-RT-010 tanpa proxy tepercaya: X-Forwarded-For palsu di kiri tidak menjadi IP klien | tests/security/routing.security.test.js | LULUS | 56 |
| SEC-RT-010 | SEC-RT-010 proxy tepercaya 127.0.0.1: X-Forwarded-For palsu di kiri tidak menjadi IP klien | tests/security/routing.security.test.js | LULUS | 47 |
| SEC-RT-010 | SEC-RT-010 proxy tepercaya bukan peer ini: X-Forwarded-For palsu di kiri tidak menjadi IP klien | tests/security/routing.security.test.js | LULUS | 41 |
| SEC-SUP-001 | SEC-SUP-001 admin start tanpa header X-CSRF-Token → 403, worker tidak dijalankan | tests/security/workerControl.security.test.js | LULUS | 274 |
| SEC-SUP-001 | SEC-SUP-001 admin start token CSRF salah → 403, worker tidak dijalankan | tests/security/workerControl.security.test.js | LULUS | 83 |
| SEC-SUP-001 | SEC-SUP-001 admin start Origin lintas situs → 403, worker tidak dijalankan | tests/security/workerControl.security.test.js | LULUS | 60 |
| SEC-SUP-001 | SEC-SUP-001 admin start Sec-Fetch-Site cross-site → 403, worker tidak dijalankan | tests/security/workerControl.security.test.js | LULUS | 68 |
| SEC-SUP-002 | SEC-SUP-002 stop tanpa token CSRF → 403, worker tetap berjalan | tests/security/workerControl.security.test.js | LULUS | 58 |
| SEC-SUP-003 | SEC-SUP-003 body & query request tidak dapat memengaruhi skrip, argumen, atau environment child | tests/security/workerControl.security.test.js | LULUS | 68 |
| SEC-SUP-004 | SEC-SUP-004 respons status hanya berisi field state — tanpa pid, path, env, atau log | tests/security/workerControl.security.test.js | LULUS | 50 |
| SEC-SUP-005 | SEC-SUP-005 rute start/stop hanya POST; GET start → 404 lewat catch-all (bukan menjalankan worker) | tests/security/workerControl.security.test.js | LULUS | 54 |
| UNIT-API-001 | UNIT-API-001 opsi background menandai GET polling dengan X-LR-Background: 1 | tests/unit/apiClient.test.js | LULUS | 27 |
| UNIT-API-002 | UNIT-API-002 request biasa dan request tidak aman tidak membawa header background | tests/unit/apiClient.test.js | LULUS | 2 |
| UNIT-CFG-001 | UNIT-CFG-001 default pengembangan valid dan cookie non-Secure untuk origin http | tests/unit/config.test.js | LULUS | 3 |
| UNIT-CFG-002 | UNIT-CFG-002 COOKIE_SECURE=auto menjadi true untuk origin https | tests/unit/config.test.js | LULUS | 1 |
| NEG-CFG-001 | NEG-CFG-001 produksi tanpa APP_ORIGIN ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-002 | NEG-CFG-002 produksi tanpa DATABASE_PATH ditolak | tests/unit/config.test.js | LULUS | 1 |
| NEG-CFG-003 | NEG-CFG-003 produksi dengan origin http ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-004 | NEG-CFG-004 produksi dengan COOKIE_SECURE=false ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid PORT=abc ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid PORT=0 ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid PORT=70000 ditolak | tests/unit/config.test.js | LULUS | 1 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid NODE_ENV=staging ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid LOG_LEVEL=verbose ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid TRUST_PROXY=yes ditolak | tests/unit/config.test.js | LULUS | 4 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid TRUST_PROXY=true ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid TRUST_PROXY=1 ditolak | tests/unit/config.test.js | LULUS | 1 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid TRUST_PROXY=0 ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid TRUST_PROXY=10.0.0.0/33 ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid TRUST_PROXY=proxy.local ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid TRUST_PROXY=127.0.0.1, ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid APP_ORIGIN=notaurl ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid APP_ORIGIN=ftp://x.local ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid APP_ORIGIN=https://x.local/path ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid APP_ORIGIN=https://user:pw@x.local ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid SESSION_IDLE_MINUTES=-5 ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-005 | NEG-CFG-005 nilai tidak valid MAX_USERS=0 ditolak | tests/unit/config.test.js | LULUS | 0 |
| UNIT-CFG-004 | UNIT-CFG-004 TRUST_PROXY menerima daftar IP/CIDR/kata kunci proxy, bukan true atau jumlah hop | tests/unit/config.test.js | LULUS | 1 |
| EDGE-CFG-001 | EDGE-CFG-001 nilai env berisi spasi saja memakai default; produksi menolak path kosong & :memory: | tests/unit/config.test.js | LULUS | 1 |
| UNIT-CFG-003 | UNIT-CFG-003 produksi lengkap diterima dan bersifat immutable | tests/unit/config.test.js | LULUS | 0 |
| UNIT-CFG-005 | UNIT-CFG-005 tanpa DEFAULT_USER: aktif hanya di development | tests/unit/config.test.js | LULUS | 0 |
| UNIT-CFG-006 | UNIT-CFG-006 DEFAULT_USER eksplisit true/false dihormati di luar produksi | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-006 | NEG-CFG-006 DEFAULT_USER=true di produksi ditolak (fail fast) | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-007 | NEG-CFG-007 DEFAULT_USER=yes tidak valid ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-007 | NEG-CFG-007 DEFAULT_USER=1 tidak valid ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-007 | NEG-CFG-007 DEFAULT_USER=TRUE tidak valid ditolak | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-007 | NEG-CFG-007 DEFAULT_USER=on tidak valid ditolak | tests/unit/config.test.js | LULUS | 3 |
| UNIT-CFG-007 | UNIT-CFG-007 WORKER_CONTROL kosong: aktif hanya di development, nonaktif di test & produksi | tests/unit/config.test.js | LULUS | 0 |
| UNIT-CFG-008 | UNIT-CFG-008 WORKER_CONTROL eksplisit true/false dihormati (termasuk mengaktifkan di produksi) | tests/unit/config.test.js | LULUS | 0 |
| UNIT-CFG-009 | UNIT-CFG-009 WORKER_AUTOSTART default false; true/false eksplisit dihormati | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-008 | NEG-CFG-008 WORKER_CONTROL=yes tidak valid ditolak dengan pesan berbahasa Indonesia | tests/unit/config.test.js | LULUS | 1 |
| NEG-CFG-008 | NEG-CFG-008 WORKER_CONTROL=1 tidak valid ditolak dengan pesan berbahasa Indonesia | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-008 | NEG-CFG-008 WORKER_CONTROL=TRUE tidak valid ditolak dengan pesan berbahasa Indonesia | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-008 | NEG-CFG-008 WORKER_CONTROL=on tidak valid ditolak dengan pesan berbahasa Indonesia | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-008 | NEG-CFG-008 WORKER_AUTOSTART=yes tidak valid ditolak dengan pesan berbahasa Indonesia | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-008 | NEG-CFG-008 WORKER_AUTOSTART=0 tidak valid ditolak dengan pesan berbahasa Indonesia | tests/unit/config.test.js | LULUS | 0 |
| NEG-CFG-008 | NEG-CFG-008 WORKER_AUTOSTART=False tidak valid ditolak dengan pesan berbahasa Indonesia | tests/unit/config.test.js | LULUS | 0 |
| UNIT-DEF-001 | UNIT-DEF-001 kredensial default pilihan pemilik (admin / admin123@) — pengecualian kebijakan HANYA untuk akun default | tests/unit/defaultUser.test.js | LULUS | 35 |
| NEG-DEF-007 | NEG-DEF-007 kata sandi default ditolak createUser biasa (jalur CLI user:create) walau dikecualikan untuk seed | tests/unit/defaultUser.test.js | LULUS | 10 |
| UNIT-DEF-002 | UNIT-DEF-002 development + loopback + tabel kosong → akun admin dibuat, kata sandi terverifikasi, audit via default | tests/unit/defaultUser.test.js | LULUS | 49 |
| UNIT-DEF-003 | UNIT-DEF-003 HOST loopback 127.0.0.1 → akun dibuat | tests/unit/defaultUser.test.js | LULUS | 14 |
| UNIT-DEF-003 | UNIT-DEF-003 HOST loopback ::1 → akun dibuat | tests/unit/defaultUser.test.js | LULUS | 9 |
| UNIT-DEF-003 | UNIT-DEF-003 HOST loopback localhost → akun dibuat | tests/unit/defaultUser.test.js | LULUS | 11 |
| UNIT-DEF-004 | UNIT-DEF-004 idempoten: start kedua tidak membuat ulang, tidak me-reset hash, tidak menulis audit/log lagi | tests/unit/defaultUser.test.js | LULUS | 12 |
| NEG-DEF-001 | NEG-DEF-001 sudah ada pengguna → tidak ada yang dibuat; hash pengguna lama tidak tersentuh | tests/unit/defaultUser.test.js | LULUS | 9 |
| NEG-DEF-002 | NEG-DEF-002 akun "admin" yang sudah ada dengan kata sandi lain tidak ditimpa atau di-reset | tests/unit/defaultUser.test.js | LULUS | 12 |
| NEG-DEF-003 | NEG-DEF-003 HOST 0.0.0.0 bukan loopback → tidak dibuat, peringatan dicatat | tests/unit/defaultUser.test.js | LULUS | 7 |
| NEG-DEF-003 | NEG-DEF-003 HOST :: bukan loopback → tidak dibuat, peringatan dicatat | tests/unit/defaultUser.test.js | LULUS | 6 |
| NEG-DEF-003 | NEG-DEF-003 HOST 192.168.1.10 bukan loopback → tidak dibuat, peringatan dicatat | tests/unit/defaultUser.test.js | LULUS | 6 |
| NEG-DEF-003 | NEG-DEF-003 HOST radar.local bukan loopback → tidak dibuat, peringatan dicatat | tests/unit/defaultUser.test.js | LULUS | 6 |
| NEG-DEF-006 | NEG-DEF-006 HOST loopback tetapi APP_ORIGIN publik → tidak dibuat, peringatan dicatat | tests/unit/defaultUser.test.js | LULUS | 8 |
| NEG-DEF-006 | NEG-DEF-006 HOST loopback tetapi APP_ORIGIN IP LAN → tidak dibuat, peringatan dicatat | tests/unit/defaultUser.test.js | LULUS | 10 |
| NEG-DEF-006 | NEG-DEF-006 HOST loopback tetapi di belakang reverse proxy → tidak dibuat, peringatan dicatat | tests/unit/defaultUser.test.js | LULUS | 8 |
| UNIT-DEF-006 | UNIT-DEF-006 APP_ORIGIN loopback http://localhost:8080 → akun dibuat | tests/unit/defaultUser.test.js | LULUS | 8 |
| UNIT-DEF-006 | UNIT-DEF-006 APP_ORIGIN loopback http://[::1]:8080 → akun dibuat | tests/unit/defaultUser.test.js | LULUS | 9 |
| NEG-DEF-004 | NEG-DEF-004 DEFAULT_USER=false → tidak dibuat, tanpa log | tests/unit/defaultUser.test.js | LULUS | 6 |
| NEG-DEF-005 | NEG-DEF-005 NODE_ENV test/produksi → tidak dibuat (juga bila flag dipaksa aktif) | tests/unit/defaultUser.test.js | LULUS | 6 |
| UNIT-DEF-005 | UNIT-DEF-005 isLoopbackHost hanya menerima 127.0.0.1, ::1, localhost | tests/unit/defaultUser.test.js | LULUS | 6 |
| UNIT-DEF-007 | UNIT-DEF-007 exposureOf: null hanya untuk server lokal non-produksi | tests/unit/defaultUser.test.js | LULUS | 5 |
| SEC-DEF-001 | SEC-DEF-001 server menolak start bila admin masih berkata sandi default dan server tidak lagi hanya lokal / produksi | tests/unit/defaultUser.test.js | LULUS | 16 |
| SEC-DEF-006 | SEC-DEF-006 admin dengan kata sandi default LAMA (alphalens-demo, database versi sebelumnya) tetap memblokir start non-lokal | tests/unit/defaultUser.test.js | LULUS | 23 |
| SEC-DEF-002 | SEC-DEF-002 setelah kata sandi diganti, server boleh start di HOST non-loopback / produksi | tests/unit/defaultUser.test.js | LULUS | 13 |
| SEC-DEF-003 | SEC-DEF-003 kata sandi default tidak pernah masuk audit | tests/unit/defaultUser.test.js | LULUS | 6 |
| UNIT-A11Y-001 | UNIT-A11Y-001 cincin fokus ≥ 3:1 terhadap --lr-bg | tests/unit/focusRing.test.js | LULUS | 2 |
| UNIT-A11Y-001 | UNIT-A11Y-001 cincin fokus ≥ 3:1 terhadap --lr-surface | tests/unit/focusRing.test.js | LULUS | 0 |
| UNIT-A11Y-001 | UNIT-A11Y-001 cincin fokus ≥ 3:1 terhadap --lr-surface-2 | tests/unit/focusRing.test.js | LULUS | 0 |
| UNIT-A11Y-002 | UNIT-A11Y-002 mode warna paksa memakai outline untuk :focus-visible | tests/unit/focusRing.test.js | LULUS | 1 |
| UNIT-FMT-001 | UNIT-FMT-001 waktu UTC kanonik | tests/unit/format.test.js | LULUS | 3 |
| EDGE-FMT-001 | EDGE-FMT-001 nilai non-finite ditampilkan sebagai tanda kosong, bukan angka palsu | tests/unit/format.test.js | LULUS | 1 |
| EDGE-FMT-002 | EDGE-FMT-002 presisi harga adaptif untuk aset sangat murah | tests/unit/format.test.js | LULUS | 1 |
| UNIT-FMT-002 | UNIT-FMT-002 bytes, durasi, relatif | tests/unit/format.test.js | LULUS | 1 |
| UNIT-DB-001 | UNIT-DB-001 seluruh entitas wajib dibuat | tests/unit/migrate.test.js | LULUS | 21 |
| UNIT-DB-002 | UNIT-DB-002 migrasi idempoten — run kedua tidak menerapkan apa pun | tests/unit/migrate.test.js | LULUS | 7 |
| UNIT-DB-003 | UNIT-DB-003 foreign key aktif | tests/unit/migrate.test.js | LULUS | 1 |
| NEG-DB-001 | NEG-DB-001 checksum migrasi yang berubah terdeteksi | tests/unit/migrate.test.js | LULUS | 3 |
| NEG-DB-002 | NEG-DB-002 migrasi di database yang tidak dikenal kode ditolak | tests/unit/migrate.test.js | LULUS | 2 |
| NEG-DB-003 | NEG-DB-003 nomor migrasi tidak berurutan / nama tidak valid ditolak | tests/unit/migrate.test.js | LULUS | 2 |
| EDGE-DB-001 | EDGE-DB-001 migrasi gagal di tengah di-rollback seluruhnya | tests/unit/migrate.test.js | LULUS | 3 |
| UNIT-DB-004 | UNIT-DB-004 identitas candle unik: symbol + timeframe + open_time | tests/unit/migrate.test.js | LULUS | 1 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: high < low | tests/unit/migrate.test.js | LULUS | 1 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: timeframe tidak didukung | tests/unit/migrate.test.js | LULUS | 0 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: volume negatif | tests/unit/migrate.test.js | LULUS | 1 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: close_time <= open_time | tests/unit/migrate.test.js | LULUS | 0 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: harga nol | tests/unit/migrate.test.js | LULUS | 0 |
| NEG-DB-004 | NEG-DB-004 candle tidak valid ditolak: tipe data salah (STRICT) | tests/unit/migrate.test.js | LULUS | 0 |
| NEG-DB-005 | NEG-DB-005 password_hash wajib argon2id | tests/unit/migrate.test.js | LULUS | 1 |
| NEG-DB-006 | NEG-DB-006 settings wajib JSON valid | tests/unit/migrate.test.js | LULUS | 0 |
| UNIT-PWD-001 | UNIT-PWD-001 hash memakai varian argon2id dan salt acak | tests/unit/password.test.js | LULUS | 27 |
| UNIT-PWD-002 | UNIT-PWD-002 verifikasi benar/salah | tests/unit/password.test.js | LULUS | 6 |
| NEG-PWD-001 | NEG-PWD-001 hash rusak tidak melempar error, hanya false | tests/unit/password.test.js | LULUS | 0 |
| UNIT-PWD-003 | UNIT-PWD-003 parameter produksi ≥ minimum OWASP (m=19MiB, t=2) | tests/unit/password.test.js | LULUS | 0 |
| UNIT-PWD-004 | UNIT-PWD-004 hash dengan parameter lemah terdeteksi perlu rehash | tests/unit/password.test.js | LULUS | 2 |
| NEG-PWD-002 | NEG-PWD-002 kebijakan menolak kata sandi pendek | tests/unit/password.test.js | LULUS | 1 |
| NEG-PWD-002 | NEG-PWD-002 kebijakan menolak kata sandi terlalu panjang | tests/unit/password.test.js | LULUS | 0 |
| NEG-PWD-002 | NEG-PWD-002 kebijakan menolak kata sandi memuat username | tests/unit/password.test.js | LULUS | 0 |
| NEG-PWD-002 | NEG-PWD-002 kebijakan menolak kata sandi variasi rendah | tests/unit/password.test.js | LULUS | 1 |
| EDGE-PWD-001 | EDGE-PWD-001 panjang dihitung per code point (emoji/Unicode) | tests/unit/password.test.js | LULUS | 1 |
| UNIT-PWI-001 | UNIT-PWI-001 ketikan lintas potongan: dua prompt, kata sandi dikembalikan, tidak ada gema, terminal dipulihkan | tests/unit/passwordInput.test.js | LULUS | 15 |
| UNIT-PWI-002 | UNIT-PWI-002 backspace \x7f dan \b menghapus satu karakter (emoji utuh); backspace pada input kosong diabaikan | tests/unit/passwordInput.test.js | LULUS | 1 |
| EDGE-PWI-001 | EDGE-PWI-001 Enter sebagai \n dalam satu potongan diterima | tests/unit/passwordInput.test.js | LULUS | 1 |
| EDGE-PWI-001 | EDGE-PWI-001 Enter sebagai \r\n dalam satu potongan diterima | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-001 | NEG-PWI-001 kata sandi dan konfirmasi berbeda → PasswordInputError | tests/unit/passwordInput.test.js | LULUS | 5 |
| NEG-PWI-002 | NEG-PWI-002 tempelan multi-baris dalam satu potongan ditolak: dua perintah shell (\r) | tests/unit/passwordInput.test.js | LULUS | 2 |
| NEG-PWI-002 | NEG-PWI-002 tempelan multi-baris dalam satu potongan ditolak: dua perintah shell (\n) | tests/unit/passwordInput.test.js | LULUS | 0 |
| NEG-PWI-002 | NEG-PWI-002 tempelan multi-baris dalam satu potongan ditolak: baris kosong menyusul (\r\r) | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-002 | NEG-PWI-002 tempelan multi-baris dalam satu potongan ditolak: baris kosong menyusul (\n\n) | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-002 | NEG-PWI-002 tempelan multi-baris dalam satu potongan ditolak: sisa tanpa Enter | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-003 | NEG-PWI-003 type-ahead (baris lengkap) sebelum prompt tampil langsung ditolak; prompt tidak ditulis | tests/unit/passwordInput.test.js | LULUS | 1 |
| EDGE-PWI-003 | EDGE-PWI-003 type-ahead sebagian: prompt tetap tampil, penolakan menunggu Enter (sisa ketikan tidak tumpah ke shell) | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-004 | NEG-PWI-004 type-ahead sebelum prompt konfirmasi tampil ditolak | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-005 | NEG-PWI-005 karakter kontrol ditolak: panah kiri (ESC [ D) | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-005 | NEG-PWI-005 karakter kontrol ditolak: ESC saja | tests/unit/passwordInput.test.js | LULUS | 0 |
| NEG-PWI-005 | NEG-PWI-005 karakter kontrol ditolak: penanda bracketed paste | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-005 | NEG-PWI-005 karakter kontrol ditolak: Ctrl+D (langsung, tanpa Enter) | tests/unit/passwordInput.test.js | LULUS | 0 |
| NEG-PWI-005 | NEG-PWI-005 karakter kontrol ditolak: tab | tests/unit/passwordInput.test.js | LULUS | 0 |
| NEG-PWI-005 | NEG-PWI-005 karakter kontrol ditolak: NUL | tests/unit/passwordInput.test.js | LULUS | 0 |
| NEG-PWI-005 | NEG-PWI-005 karakter kontrol ditolak: C1 CSI (U+009B) | tests/unit/passwordInput.test.js | LULUS | 0 |
| EDGE-PWI-004 | EDGE-PWI-004 karakter kontrol di tengah ketikan: ditolak saat Enter, sisa ketikan tetap tersembunyi | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-006 | NEG-PWI-006 Ctrl+C di prompt pertama → PasswordInputError "Dibatalkan", listener dilepas, raw mode mati | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-006 | NEG-PWI-006 Ctrl+C di prompt konfirmasi → PasswordInputError "Dibatalkan", listener dilepas, raw mode mati | tests/unit/passwordInput.test.js | LULUS | 0 |
| UNIT-PWI-003 | UNIT-PWI-003 satu baris baru di akhir dibuang: diakhiri \n | tests/unit/passwordInput.test.js | LULUS | 2 |
| UNIT-PWI-003 | UNIT-PWI-003 satu baris baru di akhir dibuang: diakhiri \r\n | tests/unit/passwordInput.test.js | LULUS | 1 |
| UNIT-PWI-003 | UNIT-PWI-003 satu baris baru di akhir dibuang: tanpa baris baru (printf) | tests/unit/passwordInput.test.js | LULUS | 0 |
| UNIT-PWI-003 | UNIT-PWI-003 satu baris baru di akhir dibuang: lintas potongan | tests/unit/passwordInput.test.js | LULUS | 0 |
| EDGE-PWI-002 | EDGE-PWI-002 karakter UTF-8 multi-byte yang terpotong antar-chunk tetap utuh | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-007 | NEG-PWI-007 baris baru tertanam atau karakter kontrol ditolak: dua baris | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-007 | NEG-PWI-007 baris baru tertanam atau karakter kontrol ditolak: baris kosong menyusul | tests/unit/passwordInput.test.js | LULUS | 0 |
| NEG-PWI-007 | NEG-PWI-007 baris baru tertanam atau karakter kontrol ditolak: \r di tengah | tests/unit/passwordInput.test.js | LULUS | 0 |
| NEG-PWI-007 | NEG-PWI-007 baris baru tertanam atau karakter kontrol ditolak: ESC | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-007 | NEG-PWI-007 baris baru tertanam atau karakter kontrol ditolak: NUL | tests/unit/passwordInput.test.js | LULUS | 1 |
| NEG-PWI-007 | NEG-PWI-007 baris baru tertanam atau karakter kontrol ditolak: tab | tests/unit/passwordInput.test.js | LULUS | 0 |
| NEG-PWI-007 | NEG-PWI-007 baris baru tertanam atau karakter kontrol ditolak: DEL | tests/unit/passwordInput.test.js | LULUS | 0 |
| UNIT-RTR-001 | UNIT-RTR-001 hash route dipetakan ke route; kosong & tak dikenal → fallback | tests/unit/router.test.js | LULUS | 2 |
| EDGE-RTR-001 | EDGE-RTR-001 fragmen non-route (#main dari skip link) diabaikan, bukan dianggap Overview | tests/unit/router.test.js | LULUS | 0 |
| EDGE-RTR-002 | EDGE-RTR-002 hashchange ke #main mempertahankan route saat ini | tests/unit/router.test.js | LULUS | 2 |
| EDGE-RTR-003 | EDGE-RTR-003 start dengan hash non-route tetap merender fallback | tests/unit/router.test.js | LULUS | 1 |
| NEG-RTR-001 | NEG-RTR-001 penolakan promise onChange diteruskan ke onError (bukan unhandled rejection) | tests/unit/router.test.js | LULUS | 3 |
| NEG-RTR-002 | NEG-RTR-002 onChange yang melempar sinkron juga ditangkap | tests/unit/router.test.js | LULUS | 1 |
| NEG-RTR-003 | NEG-RTR-003 tanpa onError, penolakan tetap ditangani (dilaporkan ke console.error) | tests/unit/router.test.js | LULUS | 2 |
| UNIT-SES-001 | UNIT-SES-001 token mentah tidak disimpan di database | tests/unit/sessionService.test.js | LULUS | 31 |
| EDGE-SES-001 | EDGE-SES-001 tepat di batas idle → kedaluwarsa | tests/unit/sessionService.test.js | LULUS | 13 |
| UNIT-SES-002 | UNIT-SES-002 aktivitas memperpanjang idle (sliding) tetapi tidak melewati batas absolut | tests/unit/sessionService.test.js | LULUS | 8 |
| UNIT-SES-003 | UNIT-SES-003 resolve saja (tanpa touch) tidak memperpanjang idle timeout | tests/unit/sessionService.test.js | LULUS | 7 |
| NEG-SES-001 | NEG-SES-001 sesi dicabut tidak dapat dipakai | tests/unit/sessionService.test.js | LULUS | 12 |
| NEG-SES-002 | NEG-SES-002 pengguna lain tidak dapat mencabut sesi bukan miliknya | tests/unit/sessionService.test.js | LULUS | 8 |
| NEG-SES-003 | NEG-SES-003 user dinonaktifkan → sesi tidak valid | tests/unit/sessionService.test.js | LULUS | 7 |
| EDGE-SES-002 | EDGE-SES-002 user-agent sangat panjang dipotong | tests/unit/sessionService.test.js | LULUS | 13 |
| UNIT-SES-003 | UNIT-SES-003 purge menghapus sesi kedaluwarsa | tests/unit/sessionService.test.js | LULUS | 8 |
| UNIT-SET-001 | UNIT-SET-001 default lolos validasi server & klien | tests/unit/settings.test.js | LULUS | 2 |
| NEG-SET-001 | NEG-SET-001 mode manual tanpa simbol ditolak | tests/unit/settings.test.js | LULUS | 1 |
| UNIT-SET-002 | UNIT-SET-002 timeframe dinormalisasi ke urutan kanonik | tests/unit/settings.test.js | LULUS | 0 |
| EDGE-SET-003 | EDGE-SET-003 simbol manual dengan base 1 karakter (mis. WUSDT) diterima; "USDT" saja ditolak | tests/unit/settings.test.js | LULUS | 1 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak timeframes kosong | tests/unit/settings.test.js | LULUS | 0 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak simbol berformat salah | tests/unit/settings.test.js | LULUS | 0 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak maxAuto pecahan | tests/unit/settings.test.js | LULUS | 0 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak volume NaN | tests/unit/settings.test.js | LULUS | 0 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak spread di atas batas | tests/unit/settings.test.js | LULUS | 0 |
| NEG-SET-002 | NEG-SET-002 validasi klien menolak bootstrap di bawah batas | tests/unit/settings.test.js | LULUS | 0 |
| UNIT-SET-003 | UNIT-SET-003 form default terbaca sama dengan pengaturan default dan lolos validasi | tests/unit/settingsForm.test.js | LULUS | 31 |
| EDGE-SET-004 | EDGE-SET-004 input angka kosong/spasi/null menjadi NaN, bukan 0 | tests/unit/settingsForm.test.js | LULUS | 1 |
| NEG-SET-003 | NEG-SET-003 field maxAuto yang dikosongkan ditolak dengan pesan wajib diisi | tests/unit/settingsForm.test.js | LULUS | 1 |
| NEG-SET-003 | NEG-SET-003 field minQuoteVolume24h yang dikosongkan ditolak dengan pesan wajib diisi | tests/unit/settingsForm.test.js | LULUS | 1 |
| NEG-SET-003 | NEG-SET-003 field maxSpreadBps yang dikosongkan ditolak dengan pesan wajib diisi | tests/unit/settingsForm.test.js | LULUS | 0 |
| NEG-SET-003 | NEG-SET-003 field bootstrapCandles yang dikosongkan ditolak dengan pesan wajib diisi | tests/unit/settingsForm.test.js | LULUS | 0 |
| NEG-SET-003 | NEG-SET-003 field restBackfillIntervalSec yang dikosongkan ditolak dengan pesan wajib diisi | tests/unit/settingsForm.test.js | LULUS | 0 |
| NEG-SET-004 | NEG-SET-004 min. volume 24j yang dikosongkan tidak pernah menjadi 0 | tests/unit/settingsForm.test.js | LULUS | 1 |
| EDGE-SET-005 | EDGE-SET-005 nilai 0 yang diketik eksplisit tetap sah bila rentangnya mengizinkan | tests/unit/settingsForm.test.js | LULUS | 1 |
| UNIT-TOK-001 | UNIT-TOK-001 token 256-bit base64url dan unik | tests/unit/tokens.test.js | LULUS | 6 |
| UNIT-TOK-002 | UNIT-TOK-002 hash SHA-256 heksadesimal 64 karakter dan deterministik | tests/unit/tokens.test.js | LULUS | 1 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: undefined | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: null | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: 123 | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak:  | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: short | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | tests/unit/tokens.test.js | LULUS | 0 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa= | tests/unit/tokens.test.js | LULUS | 1 |
| NEG-TOK-001 | NEG-TOK-001 token tidak valid ditolak: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ | tests/unit/tokens.test.js | LULUS | 0 |
| UNIT-TOK-003 | UNIT-TOK-003 safeEqual | tests/unit/tokens.test.js | LULUS | 0 |
| UNIT-PWC-001 | UNIT-PWC-001 sukses: hash baru Argon2id, kata sandi lama tidak berlaku, semua sesi pengguna dicabut, audit tercatat | tests/unit/userAdmin.test.js | LULUS | 78 |
| EDGE-PWC-001 | EDGE-PWC-001 username tidak case-sensitive; tanpa sesi aktif → 0 dicabut | tests/unit/userAdmin.test.js | LULUS | 13 |
| NEG-PWC-001 | NEG-PWC-001 kebijakan menolak kata sandi pendek; hash & sesi tidak berubah | tests/unit/userAdmin.test.js | LULUS | 11 |
| NEG-PWC-001 | NEG-PWC-001 kebijakan menolak kata sandi memuat username; hash & sesi tidak berubah | tests/unit/userAdmin.test.js | LULUS | 17 |
| NEG-PWC-001 | NEG-PWC-001 kebijakan menolak kata sandi memuat username (beda huruf); hash & sesi tidak berubah | tests/unit/userAdmin.test.js | LULUS | 11 |
| NEG-PWC-001 | NEG-PWC-001 kebijakan menolak kata sandi variasi rendah; hash & sesi tidak berubah | tests/unit/userAdmin.test.js | LULUS | 9 |
| NEG-PWC-001 | NEG-PWC-001 kebijakan menolak kata sandi bukan teks; hash & sesi tidak berubah | tests/unit/userAdmin.test.js | LULUS | 11 |
| NEG-PWC-002 | NEG-PWC-002 pengguna tidak dikenal (ghost) ditolak dan diaudit | tests/unit/userAdmin.test.js | LULUS | 11 |
| NEG-PWC-002 | NEG-PWC-002 pengguna tidak dikenal () ditolak dan diaudit | tests/unit/userAdmin.test.js | LULUS | 18 |
| NEG-PWC-002 | NEG-PWC-002 pengguna tidak dikenal (undefined) ditolak dan diaudit | tests/unit/userAdmin.test.js | LULUS | 20 |
| NEG-PWC-002 | NEG-PWC-002 pengguna tidak dikenal (../etc) ditolak dan diaudit | tests/unit/userAdmin.test.js | LULUS | 14 |
| NEG-PWC-003 | NEG-PWC-003 kata sandi baru sama dengan yang sekarang ditolak | tests/unit/userAdmin.test.js | LULUS | 12 |
| UNIT-PWC-002 | UNIT-PWC-002 createUser tetap mencatat via cli secara default | tests/unit/userAdmin.test.js | LULUS | 9 |
| UNIT-WCF-001 | UNIT-WCF-001 {"state":"running"} → ok "Berjalan" | tests/unit/workerControlFormat.test.js | LULUS | 3 |
| UNIT-WCF-001 | UNIT-WCF-001 {"state":"stopped"} → idle "Berhenti" | tests/unit/workerControlFormat.test.js | LULUS | 0 |
| UNIT-WCF-001 | UNIT-WCF-001 {"state":"starting"} → warn "Memulai…" | tests/unit/workerControlFormat.test.js | LULUS | 0 |
| UNIT-WCF-001 | UNIT-WCF-001 {"state":"stopping"} → warn "Menghentikan…" | tests/unit/workerControlFormat.test.js | LULUS | 0 |
| UNIT-WCF-001 | UNIT-WCF-001 {"state":"crashed","exitCode":1,"signal":null} → error "Gagal (kode keluar 1)" | tests/unit/workerControlFormat.test.js | LULUS | 0 |
| UNIT-WCF-001 | UNIT-WCF-001 {"state":"crashed","exitCode":null,"signal":"SIGKILL"} → error "Gagal (sinyal SIGKILL)" | tests/unit/workerControlFormat.test.js | LULUS | 0 |
| UNIT-WCF-001 | UNIT-WCF-001 {"state":"crashed","exitCode":null,"signal":"<img>"} → error "Gagal (tanpa kode keluar)" | tests/unit/workerControlFormat.test.js | LULUS | 0 |
| UNIT-WCF-001 | UNIT-WCF-001 {"state":"external"} → ok "Berjalan di luar website" | tests/unit/workerControlFormat.test.js | LULUS | 0 |
| UNIT-WCF-001 | UNIT-WCF-001 {"state":"lain"} → idle "Tidak diketahui" | tests/unit/workerControlFormat.test.js | LULUS | 0 |
| UNIT-WCF-001 | UNIT-WCF-001 null → idle "Tidak diketahui" | tests/unit/workerControlFormat.test.js | LULUS | 0 |
| UNIT-WCF-002 | UNIT-WCF-002 transisi (starting/stopping) dipantau; start hanya bila kontrol aktif dan tidak ada worker berjalan | tests/unit/workerControlFormat.test.js | LULUS | 1 |
| UNIT-WCF-003 | UNIT-WCF-003 pesan error: pesan server dipakai; CSRF, 403, dan jaringan diberi pesan yang dapat ditindaklanjuti | tests/unit/workerControlFormat.test.js | LULUS | 0 |
| UNIT-PIPE-001 | UNIT-PIPE-001 skenario SA sintetis membuka EARLY_BULLISH dengan alert, skor & penjelasan | tests/unit/analysis/pipeline.test.js | LULUS | 73 |
| UNIT-PIPE-002 | UNIT-PIPE-002 tanpa lookahead: candle HTF & dasar masa depan tidak mengubah hasil pada waktu t | tests/unit/analysis/pipeline.test.js | LULUS | 7 |
| UNIT-PIPE-007 | UNIT-PIPE-007 HTF dengan candle kurang dari warm-up (15m: 22, 1h: 5) → trend null INSUFFICIENT_DATA; penjelasan menyebut "tidak tersedia", bukan NEUTRAL | tests/unit/analysis/pipeline.test.js | LULUS | 3 |
| UNIT-PIPE-003 | UNIT-PIPE-003 kualitas seri: celah, candle belum tertutup, campuran seri terdeteksi | tests/unit/analysis/pipeline.test.js | LULUS | 2 |
| NEG-PIPE-001 | NEG-PIPE-001 seri dengan celah → risk flag DATA_QUALITY dan tidak membuka sinyal | tests/unit/analysis/pipeline.test.js | LULUS | 27 |
| NEG-PIPE-002 | NEG-PIPE-002 downtrend sintetis tidak pernah menghasilkan sinyal | tests/unit/analysis/pipeline.test.js | LULUS | 57 |
| NEG-PIPE-003 | NEG-PIPE-003 timeframe tidak didukung ditolak; seri kosong → null | tests/unit/analysis/pipeline.test.js | LULUS | 0 |
| UNIT-PIPE-004 | UNIT-PIPE-004 definisi pola berversi memuat parameter efektif & kondisi | tests/unit/analysis/pipeline.test.js | LULUS | 1 |
| POS-PIPE-001 | POS-PIPE-001 replay candle demi candle: sinyal SA tersimpan dengan event, penjelasan, dan definisi pola | tests/unit/analysis/pipeline.test.js | LULUS | 125 |
| EDGE-PIPE-001 | EDGE-PIPE-001 candle yang sama dipicu ulang → dilewati, tanpa event ganda | tests/unit/analysis/pipeline.test.js | LULUS | 96 |
| EDGE-PIPE-002 | EDGE-PIPE-002 pemicu bersamaan untuk seri yang sama diserialkan → tepat satu sinyal terbuka | tests/unit/analysis/pipeline.test.js | LULUS | 40 |
| EDGE-PIPE-003 | EDGE-PIPE-003 setelah restart, candle terakhir yang sudah menghasilkan event tidak dievaluasi ulang | tests/unit/analysis/pipeline.test.js | LULUS | 45 |
| EDGE-PIPE-007 | EDGE-PIPE-007 restart setelah candle tanpa event: candle yang sudah dievaluasi tidak di-replay (kursor analisis persisten), hanya candle baru | tests/unit/analysis/pipeline.test.js | LULUS | 151 |
| EDGE-PIPE-008 | EDGE-PIPE-008 replay panjang memberi giliran ke event loop tiap yieldEvery (25) candle → timer/heartbeat tidak tertahan sampai replay selesai | tests/unit/analysis/pipeline.test.js | LULUS | 50 |
| EDGE-PIPE-009 | EDGE-PIPE-009 empat seri me-replay 80 candle bersamaan (yieldEvery 25) → tiap giliran event loop paling banyak 25 candle TOTAL (anggaran bersama), bukan 4 × 25 | tests/unit/analysis/pipeline.test.js | LULUS | 94 |
| POS-PIPE-002 | POS-PIPE-002 close di bawah invalidation menutup sinyal (INVALIDATED) dan tidak membuka ulang di candle yang sama | tests/unit/analysis/pipeline.test.js | LULUS | 47 |
| NEG-PIPE-004 | NEG-PIPE-004 tanpa candle → NO_DATA; dependensi wajib & lookback divalidasi | tests/unit/analysis/pipeline.test.js | LULUS | 9 |
| NEG-PIPE-005 | NEG-PIPE-005 parameter pola tidak valid ditolak saat pipeline dibuat | tests/unit/analysis/pipeline.test.js | LULUS | 14 |
| NEG-PIPE-007 | NEG-PIPE-007 warm-up parameter pola melebihi lookback pipeline ditolak saat pipeline dibuat, bukan diam-diam insufficientData | tests/unit/analysis/pipeline.test.js | LULUS | 11 |
| EDGE-PIPE-005 | EDGE-PIPE-005 backfill beberapa candle sekaligus di-replay berurutan: event identik dengan pemrosesan per candle | tests/unit/analysis/pipeline.test.js | LULUS | 145 |
| EDGE-PIPE-006 | EDGE-PIPE-006 replay dibatasi maxReplay dan pemotongan dicatat (tidak diam-diam) | tests/unit/analysis/pipeline.test.js | LULUS | 16 |
| UNIT-PIPE-005 | UNIT-PIPE-005 candle 5m di batas jam menunggu sekali bila candle 1h yang tutup bersamaan belum tersimpan | tests/unit/analysis/pipeline.test.js | LULUS | 24 |
| POS-PIPE-003 | POS-PIPE-003 likuiditas dari discovery diteruskan ke skor → risk flag likuiditas/spread | tests/unit/analysis/pipeline.test.js | LULUS | 5 |
| NEG-PIPE-006 | NEG-PIPE-006 replay batch backfill dengan likuiditas buruk saat ini → candle historis tanpa POOR_LIQUIDITY/WIDE_SPREAD dan penjelasan "tidak tersedia (replay)"; hanya candle terbaru memakai likuiditas | tests/unit/analysis/pipeline.test.js | LULUS | 61 |
| POS-PIPE-005 | POS-PIPE-005 closeSymbol (SYMBOL_DELISTED) → sinyal terbuka EXPIRED tanpa alert, diserialkan setelah evaluasi yang sedang berjalan; candle berikutnya membuka sinyal BARU | tests/unit/analysis/pipeline.test.js | LULUS | 67 |
| UNIT-PIPE-006 | UNIT-PIPE-006 analyzeAt params.view (ambang pengguna 2 jt / 50 bps) → quote volume 2,5 jt & spread 40 bps tidak ditandai; penjelasan memuat batas yang dipakai | tests/unit/analysis/pipeline.test.js | LULUS | 2 |
| POS-PIPE-004 | POS-PIPE-004 getLiquidity menyertakan thresholds (pengaturan pengguna) → sinyal tersimpan & alert memakai batas tersebut, bukan default | tests/unit/analysis/pipeline.test.js | LULUS | 99 |
| UNIT-CDL-001 | UNIT-CDL-001 batch tertutup disisipkan; getRange mengembalikan Candle kanonik | tests/unit/database/candleRepository.test.js | LULUS | 44 |
| UNIT-CDL-002 | UNIT-CDL-002 idempoten: data persis sama tidak dihitung sebagai update | tests/unit/database/candleRepository.test.js | LULUS | 16 |
| UNIT-CDL-003 | UNIT-CDL-003 koreksi data (REST menimpa WS) dihitung updated dan menggantikan nilai lama | tests/unit/database/candleRepository.test.js | LULUS | 8 |
| UNIT-CDL-004 | UNIT-CDL-004 hanya sumber berbeda (data sama) → bukan update, sumber awal dipertahankan | tests/unit/database/candleRepository.test.js | LULUS | 7 |
| UNIT-CDL-005 | UNIT-CDL-005 urutan acak (out-of-order) diterima; hasil baca urut naik | tests/unit/database/candleRepository.test.js | LULUS | 7 |
| UNIT-CDL-006 | UNIT-CDL-006 duplikat dalam satu batch: versi terakhir menang, dihitung sekali | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| NEG-CDL-001 | NEG-CDL-001 candle rusak ditolak dengan alasan; candle valid dalam batch yang sama tetap disimpan | tests/unit/database/candleRepository.test.js | LULUS | 8 |
| NEG-CDL-002 | NEG-CDL-002 candle belum tertutup & candle "tertutup" dari masa depan ditolak | tests/unit/database/candleRepository.test.js | LULUS | 11 |
| NEG-CDL-003 | NEG-CDL-003 simbol yang belum terdaftar di tabel symbols ditolak dengan error jelas | tests/unit/database/candleRepository.test.js | LULUS | 7 |
| NEG-CDL-004 | NEG-CDL-004 masukan bukan array → TypeError: null | tests/unit/database/candleRepository.test.js | LULUS | 15 |
| NEG-CDL-004 | NEG-CDL-004 masukan bukan array → TypeError: x | tests/unit/database/candleRepository.test.js | LULUS | 5 |
| NEG-CDL-004 | NEG-CDL-004 masukan bukan array → TypeError: { length: 0 } | tests/unit/database/candleRepository.test.js | LULUS | 4 |
| EDGE-CDL-001 | EDGE-CDL-001 presisi kecil (0.00001234) tersimpan & terbaca persis | tests/unit/database/candleRepository.test.js | LULUS | 11 |
| EDGE-CDL-002 | EDGE-CDL-002 volume nol (tanpa transaksi) valid dan tersimpan | tests/unit/database/candleRepository.test.js | LULUS | 10 |
| EDGE-CDL-003 | EDGE-CDL-003 seluruh batch dalam satu transaksi: error di tengah → rollback penuh | tests/unit/database/candleRepository.test.js | LULUS | 8 |
| EDGE-CDL-004 | EDGE-CDL-004 simbol delisted: candle historis tetap diterima & terbaca | tests/unit/database/candleRepository.test.js | LULUS | 7 |
| EDGE-CDL-005 | EDGE-CDL-005 opsi { now } (waktu server) menggantikan jam lokal yang tertinggal | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| EDGE-CDL-006 | EDGE-CDL-006 batch besar (3 timeframe × 500) tersimpan dalam satu panggilan | tests/unit/database/candleRepository.test.js | LULUS | 37 |
| EDGE-CDL-007 | EDGE-CDL-007 ingested_at memakai jam repositori yang diteruskan createRepositories | tests/unit/database/candleRepository.test.js | LULUS | 10 |
| UNIT-CDL-007 | UNIT-CDL-007 getRange inklusif di kedua batas dan terisolasi per simbol/timeframe | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| UNIT-CDL-008 | UNIT-CDL-008 getLatest: N candle terakhir urut naik; getLastOpenTime | tests/unit/database/candleRepository.test.js | LULUS | 7 |
| NEG-CDL-005 | NEG-CDL-005 argumen baca tidak valid ditolak: timeframe tidak didukung | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| NEG-CDL-005 | NEG-CDL-005 argumen baca tidak valid ditolak: from bukan angka | tests/unit/database/candleRepository.test.js | LULUS | 7 |
| NEG-CDL-005 | NEG-CDL-005 argumen baca tidak valid ditolak: simbol format salah | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| NEG-CDL-005 | NEG-CDL-005 argumen baca tidak valid ditolak: limit nol | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| NEG-CDL-005 | NEG-CDL-005 argumen baca tidak valid ditolak: limit pecahan | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| NEG-CDL-005 | NEG-CDL-005 argumen baca tidak valid ditolak: limit terlalu besar | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| NEG-CDL-005 | NEG-CDL-005 argumen baca tidak valid ditolak: findGaps to NaN | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| NEG-CDL-005 | NEG-CDL-005 argumen baca tidak valid ditolak: getLastOpenTime timeframe kosong | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| UNIT-CDL-009 | UNIT-CDL-009 tanpa gap → [] | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| UNIT-CDL-010 | UNIT-CDL-010 gap di awal, tengah, dan akhir rentang | tests/unit/database/candleRepository.test.js | LULUS | 5 |
| EDGE-CDL-008 | EDGE-CDL-008 batas tidak sejajar dibulatkan ke dalam; rentang terbalik → [] | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| EDGE-CDL-009 | EDGE-CDL-009 tanpa data / simbol tidak dikenal → seluruh rentang hilang | tests/unit/database/candleRepository.test.js | LULUS | 7 |
| EDGE-CDL-010 | EDGE-CDL-010 gap dihitung per timeframe; candle provisional tidak menutup gap | tests/unit/database/candleRepository.test.js | LULUS | 7 |
| UNIT-CDL-011 | UNIT-CDL-011 provisional disimpan terpisah dan tidak pernah masuk tabel candles | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| UNIT-CDL-012 | UNIT-CDL-012 hanya satu baris terbaru per simbol × timeframe; update lebih lama diabaikan | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| UNIT-CDL-013 | UNIT-CDL-013 candle tertutup menggantikan provisional; provisional terlambat untuk candle tertutup diabaikan | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| NEG-CDL-006 | NEG-CDL-006 upsertProvisional menolak: candle tertutup | tests/unit/database/candleRepository.test.js | LULUS | 7 |
| NEG-CDL-006 | NEG-CDL-006 upsertProvisional menolak: OHLC rusak | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| NEG-CDL-006 | NEG-CDL-006 upsertProvisional menolak: open time di masa depan | tests/unit/database/candleRepository.test.js | LULUS | 5 |
| NEG-CDL-006 | NEG-CDL-006 upsertProvisional menolak: simbol belum terdaftar | tests/unit/database/candleRepository.test.js | LULUS | 5 |
| NEG-CDL-006 | NEG-CDL-006 upsertProvisional menolak: bukan objek | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| UNIT-CDL-014 | UNIT-CDL-014 kolom taker baru berdefault 0 untuk insert gaya lama | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| NEG-CDL-007 | NEG-CDL-007 constraint lama tetap berlaku & kolom baru tervalidasi | tests/unit/database/candleRepository.test.js | LULUS | 8 |
| NEG-CDL-008 | NEG-CDL-008 provisional_candles: satu baris per simbol × timeframe, STRICT, FK ke symbols | tests/unit/database/candleRepository.test.js | LULUS | 6 |
| EDGE-CDL-011 | EDGE-CDL-011 candle & provisional bertahan setelah database ditutup dan dibuka ulang | tests/unit/database/candleRepository.test.js | LULUS | 28 |
| UNIT-IST-001 | UNIT-IST-001 status kosong sebelum worker pernah berjalan | tests/unit/database/ingestionStateRepository.test.js | LULUS | 21 |
| UNIT-IST-002 | UNIT-IST-002 recordRun: run terakhir (berdasarkan startedAt) beserta durasinya | tests/unit/database/ingestionStateRepository.test.js | LULUS | 5 |
| UNIT-IST-003 | UNIT-IST-003 recordRun menerima array (dihitung panjangnya) | tests/unit/database/ingestionStateRepository.test.js | LULUS | 5 |
| UNIT-IST-004 | UNIT-IST-004 recordError: ≤ 20 error terbaru, terbaru lebih dulu | tests/unit/database/ingestionStateRepository.test.js | LULUS | 6 |
| UNIT-IST-005 | UNIT-IST-005 heartbeat singleton: panggilan berikutnya menimpa, state JSON utuh | tests/unit/database/ingestionStateRepository.test.js | LULUS | 5 |
| EDGE-IST-001 | EDGE-IST-001 pesan error panjang dipotong 500 karakter; Error & non-string dikonversi | tests/unit/database/ingestionStateRepository.test.js | LULUS | 4 |
| EDGE-IST-002 | EDGE-IST-002 retensi: hanya N error terbaru yang disimpan | tests/unit/database/ingestionStateRepository.test.js | LULUS | 5 |
| EDGE-IST-003 | EDGE-IST-003 heartbeat tanpa state disimpan sebagai objek kosong | tests/unit/database/ingestionStateRepository.test.js | LULUS | 4 |
| NEG-IST-001 | NEG-IST-001 recordRun tidak valid ditolak: finishedAt < startedAt | tests/unit/database/ingestionStateRepository.test.js | LULUS | 5 |
| NEG-IST-001 | NEG-IST-001 recordRun tidak valid ditolak: startedAt bukan angka | tests/unit/database/ingestionStateRepository.test.js | LULUS | 4 |
| NEG-IST-001 | NEG-IST-001 recordRun tidak valid ditolak: jumlah negatif | tests/unit/database/ingestionStateRepository.test.js | LULUS | 4 |
| NEG-IST-001 | NEG-IST-001 recordRun tidak valid ditolak: jumlah pecahan | tests/unit/database/ingestionStateRepository.test.js | LULUS | 4 |
| NEG-IST-001 | NEG-IST-001 recordRun tidak valid ditolak: jumlah hilang | tests/unit/database/ingestionStateRepository.test.js | LULUS | 4 |
| NEG-IST-002 | NEG-IST-002 recordError tidak valid ditolak: at bukan angka | tests/unit/database/ingestionStateRepository.test.js | LULUS | 4 |
| NEG-IST-002 | NEG-IST-002 recordError tidak valid ditolak: source kosong | tests/unit/database/ingestionStateRepository.test.js | LULUS | 4 |
| NEG-IST-002 | NEG-IST-002 recordError tidak valid ditolak: source bukan teks | tests/unit/database/ingestionStateRepository.test.js | LULUS | 4 |
| NEG-IST-003 | NEG-IST-003 heartbeat tidak valid ditolak (at bukan angka, state tidak dapat di-serialisasi) | tests/unit/database/ingestionStateRepository.test.js | LULUS | 12 |
| NEG-IST-004 | NEG-IST-004 constraint skema 003: singleton heartbeat, panjang pesan, JSON valid, STRICT | tests/unit/database/ingestionStateRepository.test.js | LULUS | 5 |
| NEG-IST-005 | NEG-IST-005 opsi retensi tidak valid → RangeError | tests/unit/database/ingestionStateRepository.test.js | LULUS | 4 |
| EDGE-IST-004 | EDGE-IST-004 status bertahan setelah restart (file database sementara) | tests/unit/database/ingestionStateRepository.test.js | LULUS | 19 |
| UNIT-SYM-001 | UNIT-SYM-001 upsertFromExchange menyisipkan simbol baru beserta atributnya | tests/unit/database/symbolRepository.test.js | LULUS | 19 |
| UNIT-SYM-002 | UNIT-SYM-002 pembaruan dari exchange: atribut berubah, first_seen_at tetap, last_seen_at maju | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| UNIT-SYM-003 | UNIT-SYM-003 setMonitored: daftar baru dipantau, sisanya dilepas; listMonitored terurut | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| UNIT-SYM-004 | UNIT-SYM-004 markDelisted: simbol dilepas dari pantauan; panggilan ulang idempoten | tests/unit/database/symbolRepository.test.js | LULUS | 4 |
| UNIT-SYM-005 | UNIT-SYM-005 simbol delisted tidak dapat dipantau lagi lewat setMonitored | tests/unit/database/symbolRepository.test.js | LULUS | 7 |
| UNIT-SYM-006 | UNIT-SYM-006 repositori terdaftar di createRepositories & konsisten dengan overview | tests/unit/database/symbolRepository.test.js | LULUS | 11 |
| EDGE-SYM-001 | EDGE-SYM-001 listing ulang: muncul lagi dengan status TRADING → delisted_at dihapus | tests/unit/database/symbolRepository.test.js | LULUS | 6 |
| EDGE-SYM-002 | EDGE-SYM-002 setMonitored([]) melepas semua pantauan | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| EDGE-SYM-003 | EDGE-SYM-003 duplikat dalam satu panggilan: entri terakhir menang | tests/unit/database/symbolRepository.test.js | LULUS | 6 |
| EDGE-SYM-004 | EDGE-SYM-004 tickSize/stepSize angka disimpan sebagai teks; null diperbolehkan | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| NEG-SYM-001 | NEG-SYM-001 SymbolInfo tidak valid ditolak tanpa menggagalkan entri valid | tests/unit/database/symbolRepository.test.js | LULUS | 7 |
| UNIT-SYM-007 | UNIT-SYM-007 kontrak delivery dari exchangeInfo (SYNUSDT_270326) tidak disimpan tetapi dilaporkan: rejectedCount 1 + simbol & alasannya | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| EDGE-SYM-005 | EDGE-SYM-005 120 entri tidak valid → rejected dibatasi 50 entri pertama, rejectedCount 120; simbol panjang dipotong 64 karakter, simbol non-teks → null | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| NEG-SYM-002 | NEG-SYM-002 simbol tidak dikenal: dilewati / null / nol | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| NEG-SYM-003 | NEG-SYM-003 argumen tidak valid → TypeError: upsertFromExchange non-array | tests/unit/database/symbolRepository.test.js | LULUS | 6 |
| NEG-SYM-003 | NEG-SYM-003 argumen tidak valid → TypeError: upsertFromExchange tanpa now | tests/unit/database/symbolRepository.test.js | LULUS | 7 |
| NEG-SYM-003 | NEG-SYM-003 argumen tidak valid → TypeError: setMonitored non-array | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| NEG-SYM-003 | NEG-SYM-003 argumen tidak valid → TypeError: setMonitored now NaN | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| NEG-SYM-003 | NEG-SYM-003 argumen tidak valid → TypeError: markDelisted non-array | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| NEG-SYM-003 | NEG-SYM-003 argumen tidak valid → TypeError: markDelisted now string | tests/unit/database/symbolRepository.test.js | LULUS | 5 |
| UNIT-IND-001 | UNIT-IND-001 SMA & EMA: warm-up null, seed SMA, rekursi alpha=2/(n+1) | tests/unit/indicators/indicators.test.js | LULUS | 3 |
| EDGE-IND-001 | EDGE-IND-001 data lebih pendek dari periode → seluruhnya null | tests/unit/indicators/indicators.test.js | LULUS | 1 |
| NEG-IND-001 | NEG-IND-001 periode & nilai tidak valid ditolak | tests/unit/indicators/indicators.test.js | LULUS | 1 |
| UNIT-IND-002 | UNIT-IND-002 true range memakai close sebelumnya untuk gap | tests/unit/indicators/indicators.test.js | LULUS | 1 |
| UNIT-IND-003 | UNIT-IND-003 ATR Wilder | tests/unit/indicators/indicators.test.js | LULUS | 1 |
| UNIT-IND-004 | UNIT-IND-004 RVOL memakai baseline candle sebelumnya (tanpa candle saat ini) | tests/unit/indicators/indicators.test.js | LULUS | 1 |
| EDGE-IND-002 | EDGE-IND-002 RVOL dengan baseline volume nol → null, bukan Infinity | tests/unit/indicators/indicators.test.js | LULUS | 1 |
| EDGE-IND-003 | EDGE-IND-003 dominasi lonjakan tunggal | tests/unit/indicators/indicators.test.js | LULUS | 0 |
| UNIT-IND-005 | UNIT-IND-005 swing terkonfirmasi dengan jeda `right` (anti lookahead) | tests/unit/indicators/indicators.test.js | LULUS | 2 |
| EDGE-IND-004 | EDGE-IND-004 harga datar tidak menghasilkan swing ganda | tests/unit/indicators/indicators.test.js | LULUS | 1 |
| UNIT-IND-006 | UNIT-IND-006 slope ternormalisasi | tests/unit/indicators/indicators.test.js | LULUS | 1 |
| EDGE-IND-005 | EDGE-IND-005 presisi floating point stabil pada harga sangat kecil | tests/unit/indicators/indicators.test.js | LULUS | 1 |
| POS-SVW-001 | POS-SVW-001 skor dari pola sesuai klasifikasi dan dapat dijelaskan per kondisi | tests/unit/scoring/signalView.test.js | LULUS | 4 |
| UNIT-SVW-001 | UNIT-SVW-001 setiap entri penjelasan berbentuk { factor, contribution, detail } dan skor bukan probabilitas | tests/unit/scoring/signalView.test.js | LULUS | 2 |
| UNIT-SVW-002 | UNIT-SVW-002 skor detektor yang tidak sama dengan bobot lolos dijelaskan lewat RESIDUAL | tests/unit/scoring/signalView.test.js | LULUS | 1 |
| UNIT-SVW-003 | UNIT-SVW-003 BOTH → skor maksimum SA/PVA, sumber dicatat di PATTERN:SELECTION | tests/unit/scoring/signalView.test.js | LULUS | 1 |
| UNIT-SVW-004 | UNIT-SVW-004 NONE → skor diagnostik maksimum dari hasil yang tersedia | tests/unit/scoring/signalView.test.js | LULUS | 1 |
| POS-SVW-002 | POS-SVW-002 risk flag gabungan: pola + COUNTERTREND_HTF + likuiditas + spread + kualitas data | tests/unit/scoring/signalView.test.js | LULUS | 1 |
| EDGE-SVW-001 | EDGE-SVW-001 tepat di batas likuiditas/spread tidak ditandai | tests/unit/scoring/signalView.test.js | LULUS | 1 |
| UNIT-SVW-005 | UNIT-SVW-005 params (ambang pengguna 1 jt / 30 bps) → flag dinilai dengan batas itu dan penjelasan menampilkan batas yang dipakai | tests/unit/scoring/signalView.test.js | LULUS | 1 |
| EDGE-SVW-002 | EDGE-SVW-002 likuiditas/konteks/kualitas data tidak tersedia → tanpa flag, dijelaskan | tests/unit/scoring/signalView.test.js | LULUS | 1 |
| EDGE-SVW-003 | EDGE-SVW-003 flag tak dikenal dari detektor dibuang; flag duplikat hanya sekali | tests/unit/scoring/signalView.test.js | LULUS | 1 |
| EDGE-SVW-004 | EDGE-SVW-004 skor di luar 0..100 dijepit; kondisi tanpa bobot tidak membagi nol | tests/unit/scoring/signalView.test.js | LULUS | 1 |
| NEG-SVW-001 | NEG-SVW-001 input tidak valid ditolak | tests/unit/scoring/signalView.test.js | LULUS | 1 |
| UNIT-PCND-001 | UNIT-PCND-001 mean & median menolak nilai null/non-hingga | tests/unit/patterns/conditions.test.js | LULUS | 2 |
| UNIT-PCND-002 | UNIT-PCND-002 kondisi deklaratif: pembanding gt/gte/lte, nilai null selalu gagal | tests/unit/patterns/conditions.test.js | LULUS | 1 |
| UNIT-PCND-003 | UNIT-PCND-003 patternScore = Σ bobot lulus / Σ bobot × 100; total bobot 0 → 0 | tests/unit/patterns/conditions.test.js | LULUS | 0 |
| UNIT-PCND-004 | UNIT-PCND-004 earlyScore mengikuti formula 100 × (0,6 × jarak + 0,4 × usia), jarak dari awal struktur | tests/unit/patterns/conditions.test.js | LULUS | 1 |
| UNIT-PCND-008 | UNIT-PCND-008 higher low baru (anchor naik, awal sama) → earlyScore tidak naik; invalidasi tetap ikut anchor | tests/unit/patterns/conditions.test.js | LULUS | 0 |
| UNIT-PCND-009 | UNIT-PCND-009 analyzeStructure: startPrice = low swing pertama rantai higher-low, anchor = swing low terbaru | tests/unit/patterns/conditions.test.js | LULUS | 2 |
| EDGE-PCND-001 | EDGE-PCND-001 earlyScore 0 tanpa struktur bullish atau ATR nol | tests/unit/patterns/conditions.test.js | LULUS | 0 |
| UNIT-PCND-005 | UNIT-PCND-005 harga invalidasi = anchor − buffer × ATR; null bila tidak di antara 0 dan close | tests/unit/patterns/conditions.test.js | LULUS | 0 |
| POS-PCND-001 | POS-PCND-001 struktur higher-low: swing baru dipakai hanya setelah terkonfirmasi (anti lookahead) | tests/unit/patterns/conditions.test.js | LULUS | 1 |
| EDGE-PCND-002 | EDGE-PCND-002 struktur patah (close di bawah swing low) atau swing di luar jendela → anchor = low terendah jendela | tests/unit/patterns/conditions.test.js | LULUS | 0 |
| UNIT-PCND-006 | UNIT-PCND-006 inspeksi data valid tidak menghasilkan masalah | tests/unit/patterns/conditions.test.js | LULUS | 2 |
| NEG-PCND-001 | NEG-PCND-001 candle tidak valid, belum tertutup, tidak urut, campuran seri → fatal | tests/unit/patterns/conditions.test.js | LULUS | 4 |
| NEG-PCND-002 | NEG-PCND-002 gap waktu & volume nol beruntun di jendela evaluasi → issue (bukan fatal) | tests/unit/patterns/conditions.test.js | LULUS | 1 |
| EDGE-PCND-003 | EDGE-PCND-003 volume nol < ambang beruntun dan gap di luar jendela evaluasi tidak dianggap masalah | tests/unit/patterns/conditions.test.js | LULUS | 0 |
| UNIT-PCND-007 | UNIT-PCND-007 risk flag terurut sesuai RISK_FLAGS | tests/unit/patterns/conditions.test.js | LULUS | 0 |
| POS-PEVL-001 | POS-PEVL-001 klasifikasi SA \| PVA \| BOTH \| NONE sesuai skenario pada semua seed | tests/unit/patterns/evaluate.test.js | LULUS | 84 |
| POS-PEVL-002 | POS-PEVL-002 BOTH: kedua hasil terdeteksi dengan invalidationPrice di bawah close | tests/unit/patterns/evaluate.test.js | LULUS | 6 |
| UNIT-PEVL-001 | UNIT-PEVL-001 tabel kebenaran klasifikasi | tests/unit/patterns/evaluate.test.js | LULUS | 1 |
| UNIT-PEVL-002 | UNIT-PEVL-002 detektor independen: hasil sama dengan pemanggilan terpisah, parameter satu pola tidak memengaruhi pola lain | tests/unit/patterns/evaluate.test.js | LULUS | 9 |
| UNIT-PEVL-003 | UNIT-PEVL-003 modul detektor tidak saling mengimpor | tests/unit/patterns/evaluate.test.js | LULUS | 1 |
| UNIT-PEVL-004 | UNIT-PEVL-004 anti lookahead: anchor & higher low pada prefix k = swing low deret PENUH (dengan masa depan) yang confirmedIndex ≤ k−1 | tests/unit/patterns/evaluate.test.js | LULUS | 55 |
| UNIT-PEVL-005 | UNIT-PEVL-005 deterministik: input sama → output identik (termasuk serialisasi) | tests/unit/patterns/evaluate.test.js | LULUS | 2 |
| EDGE-PEVL-001 | EDGE-PEVL-001 invarian walk-forward: skor dalam [0,100], invalidasi di (0, close), flag & klasifikasi valid | tests/unit/patterns/evaluate.test.js | LULUS | 308 |
| EDGE-PEVL-002 | EDGE-PEVL-002 opsi kosong/null setara default; parameter tidak valid tetap ditolak | tests/unit/patterns/evaluate.test.js | LULUS | 2 |
| EDGE-PEVL-003 | EDGE-PEVL-003 data cukup untuk SA (63) tetapi belum untuk PVA (70) → PVA insufficientData | tests/unit/patterns/evaluate.test.js | LULUS | 1 |
| EDGE-PEVL-004 | EDGE-PEVL-004 harga jatuh menembus struktur → klasifikasi kembali NONE | tests/unit/patterns/evaluate.test.js | LULUS | 1 |
| UNIT-PPRM-001 | UNIT-PPRM-001 parameter default lolos validasi dan beku (termasuk spesifikasi rentang) | tests/unit/patterns/params.test.js | LULUS | 3 |
| UNIT-PPRM-002 | UNIT-PPRM-002 setiap parameter default punya spesifikasi dan sebaliknya | tests/unit/patterns/params.test.js | LULUS | 1 |
| POS-PPRM-001 | POS-PPRM-001 parameter dapat disimpan sebagai JSON (pattern_definitions) dan dibaca ulang tanpa kehilangan | tests/unit/patterns/params.test.js | LULUS | 1 |
| UNIT-PPRM-003 | UNIT-PPRM-003 resolveParams menggabungkan override parsial dengan default | tests/unit/patterns/params.test.js | LULUS | 1 |
| NEG-PPRM-001 | NEG-PPRM-001 nilai di luar rentang ditolak dengan daftar error per path | tests/unit/patterns/params.test.js | LULUS | 1 |
| NEG-PPRM-002 | NEG-PPRM-002 tipe salah ditolak: string, NaN, Infinity, pecahan untuk integer, boolean | tests/unit/patterns/params.test.js | LULUS | 0 |
| NEG-PPRM-003 | NEG-PPRM-003 key tidak dikenal dan key wajib yang hilang ditolak | tests/unit/patterns/params.test.js | LULUS | 1 |
| NEG-PPRM-004 | NEG-PPRM-004 bukan objek polos atau pola tidak dikenal ditolak | tests/unit/patterns/params.test.js | LULUS | 1 |
| NEG-PPRM-005 | NEG-PPRM-005 key __proto__ dari JSON ditolak sebagai key tidak dikenal (tanpa polusi prototipe) | tests/unit/patterns/params.test.js | LULUS | 1 |
| NEG-PPRM-006 | NEG-PPRM-006 aturan lintas-field PVA: maxSpikeDominance harus > 1/(subWindows×subWindowLength) | tests/unit/patterns/params.test.js | LULUS | 0 |
| NEG-PPRM-008 | NEG-PPRM-008 PVA tidak punya ambang porsi lonjakan terpisah: maxSpikeGrowthShare → parameter tidak dikenal | tests/unit/patterns/params.test.js | LULUS | 1 |
| NEG-PPRM-007 | NEG-PPRM-007 resolveParams melempar PatternParamsError (RangeError) berisi daftar error | tests/unit/patterns/params.test.js | LULUS | 1 |
| UNIT-PPRM-004 | UNIT-PPRM-004 jumlah candle minimum diturunkan dari parameter | tests/unit/patterns/params.test.js | LULUS | 0 |
| EDGE-PPRM-001 | EDGE-PPRM-001 batas warm-up PVA: rvolPeriod + subWindows×subWindowLength = 300 diterima, 301 ditolak dengan pesan jelas | tests/unit/patterns/params.test.js | LULUS | 1 |
| EDGE-PPRM-002 | EDGE-PPRM-002 batas warm-up SA: rvolPeriod 250 + rvolWindow 50 = 300 diterima; rvolPeriod 251 (atau 300) ditolak | tests/unit/patterns/params.test.js | LULUS | 0 |
| EDGE-PPRM-003 | EDGE-PPRM-003 setiap parameter yang lolos validasi punya warm-up ≤ ANALYSIS_LOOKBACK pipeline | tests/unit/patterns/params.test.js | LULUS | 1 |
| EDGE-PPRM-004 | EDGE-PPRM-004 batas warm-up mengikuti lookback pemanggil: maxWarmup 150 menolak SA rvolPeriod 200 (warm-up 205) dan PVA rvolPeriod 200 (220) | tests/unit/patterns/params.test.js | LULUS | 1 |
| POS-PPVA-001 | POS-PPVA-001 volume progresif + harga naik bertahap terdeteksi pada semua seed | tests/unit/patterns/progressiveVolume.test.js | LULUS | 21 |
| UNIT-PPVA-001 | UNIT-PPVA-001 bentuk output kontrak §6, bobot total 100 (wajib 75), skor dapat dijelaskan | tests/unit/patterns/progressiveVolume.test.js | LULUS | 5 |
| NEG-PPVA-001 | NEG-PPVA-001 satu lonjakan volume raksasa pada ramp asli → tidak terdeteksi; alasannya noSpikeDominance | tests/unit/patterns/progressiveVolume.test.js | LULUS | 19 |
| NEG-PPVA-002 | NEG-PPVA-002 lonjakan tunggal pada volume datar tidak dianggap pertumbuhan progresif | tests/unit/patterns/progressiveVolume.test.js | LULUS | 1 |
| NEG-PPVA-009 | NEG-PPVA-009 satu candle 3,5× rata-rata pada volume datar (porsi jendela 0,15 lolos) → ditolak volumeGrowthBroad | tests/unit/patterns/progressiveVolume.test.js | LULUS | 4 |
| NEG-PPVA-010 | NEG-PPVA-010 satu lonjakan realistis 3–5× di sub-jendela terakhir pada volume datar berderau → tidak pernah terdeteksi | tests/unit/patterns/progressiveVolume.test.js | LULUS | 284 |
| NEG-PPVA-011 | NEG-PPVA-011 ramp ringan di bawah ambang + satu candle 2–3× → tetap tidak terdeteksi (lonjakan tidak boleh mengangkatnya) | tests/unit/patterns/progressiveVolume.test.js | LULUS | 712 |
| NEG-PPVA-012 | NEG-PPVA-012 dua candle 2,3–3,5× (berdampingan atau terpisah) pada volume datar → tidak terdeteksi; ditolak volumeGrowthBroad | tests/unit/patterns/progressiveVolume.test.js | LULUS | 143 |
| POS-PPVA-002 | POS-PPVA-002 ramp volume progresif asli (juga dengan satu candle 2×) tetap terdeteksi; pertumbuhan median bawah jauh di atas ambang | tests/unit/patterns/progressiveVolume.test.js | LULUS | 3 |
| NEG-PPVA-003 | NEG-PPVA-003 harga datar dengan volume progresif → tidak terdeteksi (volume saja tidak cukup) | tests/unit/patterns/progressiveVolume.test.js | LULUS | 2 |
| NEG-PPVA-004 | NEG-PPVA-004 volume tidak naik (akumulasi senyap) → volumeGrowth gagal | tests/unit/patterns/progressiveVolume.test.js | LULUS | 3 |
| NEG-PPVA-005 | NEG-PPVA-005 downtrend → tidak terdeteksi | tests/unit/patterns/progressiveVolume.test.js | LULUS | 2 |
| NEG-PPVA-006 | NEG-PPVA-006 volatilitas ekstrem → tidak terdeteksi, flag EXCESSIVE_VOLATILITY | tests/unit/patterns/progressiveVolume.test.js | LULUS | 3 |
| NEG-PPVA-007 | NEG-PPVA-007 kenaikan harga dari satu candle (bukan bertahap) → riseNotSingleCandle gagal | tests/unit/patterns/progressiveVolume.test.js | LULUS | 1 |
| NEG-PPVA-008 | NEG-PPVA-008 parameter tidak valid → PatternParamsError | tests/unit/patterns/progressiveVolume.test.js | LULUS | 2 |
| UNIT-PPVA-002 | UNIT-PPVA-002 parameter jendela mengubah ambang dan warm-up | tests/unit/patterns/progressiveVolume.test.js | LULUS | 1 |
| EDGE-PPVA-001 | EDGE-PPVA-001 warm-up PVA = 70 candle: 69 → insufficientData, 70 → dievaluasi | tests/unit/patterns/progressiveVolume.test.js | LULUS | 1 |
| EDGE-PPVA-002 | EDGE-PPVA-002 volume nol beruntun di sub-jendela → DATA_QUALITY dan tidak terdeteksi | tests/unit/patterns/progressiveVolume.test.js | LULUS | 1 |
| EDGE-PPVA-003 | EDGE-PPVA-003 candle terakhir belum tertutup → ditolak | tests/unit/patterns/progressiveVolume.test.js | LULUS | 1 |
| EDGE-PPVA-004 | EDGE-PPVA-004 harga sangat kecil (×1e-8) → hasil setara dengan harga normal | tests/unit/patterns/progressiveVolume.test.js | LULUS | 2 |
| UNIT-PPVA-003 | UNIT-PPVA-003 deterministik dan tidak memutasi input | tests/unit/patterns/progressiveVolume.test.js | LULUS | 1 |
| POS-PSA-001 | POS-PSA-001 akumulasi senyap terdeteksi pada semua seed: kondisi wajib lulus, skor ≥ minScore | tests/unit/patterns/silentAccumulation.test.js | LULUS | 17 |
| UNIT-PSA-001 | UNIT-PSA-001 bentuk output persis kontrak PatternResult §6 | tests/unit/patterns/silentAccumulation.test.js | LULUS | 5 |
| UNIT-PSA-002 | UNIT-PSA-002 bobot total 100 (wajib 75) dan patternScore dapat dijelaskan per kondisi | tests/unit/patterns/silentAccumulation.test.js | LULUS | 2 |
| UNIT-PSA-003 | UNIT-PSA-003 ambang kondisi berasal dari parameter | tests/unit/patterns/silentAccumulation.test.js | LULUS | 2 |
| NEG-PSA-001 | NEG-PSA-001 volume tidak senyap (skenario volume progresif) → tidak terdeteksi karena RVOL tinggi | tests/unit/patterns/silentAccumulation.test.js | LULUS | 8 |
| NEG-PSA-002 | NEG-PSA-002 harga datar dengan volume senyap → tidak terdeteksi (senyap saja tidak cukup) | tests/unit/patterns/silentAccumulation.test.js | LULUS | 7 |
| NEG-PSA-003 | NEG-PSA-003 downtrend → tidak terdeteksi, tanpa higher low, earlyScore 0 | tests/unit/patterns/silentAccumulation.test.js | LULUS | 7 |
| NEG-PSA-004 | NEG-PSA-004 volatilitas ekstrem → tidak terdeteksi dan diberi flag EXCESSIVE_VOLATILITY | tests/unit/patterns/silentAccumulation.test.js | LULUS | 5 |
| NEG-PSA-005 | NEG-PSA-005 kenaikan melebihi batas "kecil" → priceGradual gagal, tidak terdeteksi | tests/unit/patterns/silentAccumulation.test.js | LULUS | 1 |
| NEG-PSA-006 | NEG-PSA-006 higher low kurang dari minimum → tidak terdeteksi | tests/unit/patterns/silentAccumulation.test.js | LULUS | 1 |
| NEG-PSA-007 | NEG-PSA-007 parameter tidak valid → PatternParamsError, bukan hasil diam-diam | tests/unit/patterns/silentAccumulation.test.js | LULUS | 3 |
| NEG-PSA-008 | NEG-PSA-008 input bukan array → TypeError | tests/unit/patterns/silentAccumulation.test.js | LULUS | 0 |
| EDGE-PSA-001 | EDGE-PSA-001 data kurang dari warm-up (63) → insufficientData, nilai kondisi null, tanpa invalidasi | tests/unit/patterns/silentAccumulation.test.js | LULUS | 1 |
| EDGE-PSA-002 | EDGE-PSA-002 array kosong → insufficientData dengan evaluatedAt null | tests/unit/patterns/silentAccumulation.test.js | LULUS | 3 |
| EDGE-PSA-003 | EDGE-PSA-003 volume nol beruntun → DATA_QUALITY dan tidak terdeteksi; satu candle volume nol masih diterima | tests/unit/patterns/silentAccumulation.test.js | LULUS | 1 |
| EDGE-PSA-004 | EDGE-PSA-004 candle belum tertutup ditolak; gap waktu → DATA_QUALITY | tests/unit/patterns/silentAccumulation.test.js | LULUS | 1 |
| EDGE-PSA-005 | EDGE-PSA-005 harga sangat kecil (×1e-7) → hasil setara (perhitungan invarian skala, presisi aman) | tests/unit/patterns/silentAccumulation.test.js | LULUS | 4 |
| EDGE-PSA-006 | EDGE-PSA-006 quote volume sangat kecil → flag POOR_LIQUIDITY (kondisi opsional, tidak memblokir) | tests/unit/patterns/silentAccumulation.test.js | LULUS | 1 |
| EDGE-PSA-007 | EDGE-PSA-007 earlyScore turun ketika harga sudah jauh berjalan dari struktur | tests/unit/patterns/silentAccumulation.test.js | LULUS | 4 |
| EDGE-PSA-008 | EDGE-PSA-008 kenaikan matang (≈10 ATR dari awal struktur) setelah pullback → earlyScore < 60 walau higher low terbaru dekat | tests/unit/patterns/silentAccumulation.test.js | LULUS | 1 |
| EDGE-PSA-009 | EDGE-PSA-009 walk-forward satu struktur: harga makin jauh dari awal struktur → earlyScore tidak pernah naik | tests/unit/patterns/silentAccumulation.test.js | LULUS | 78 |
| UNIT-PSA-004 | UNIT-PSA-004 deterministik dan tidak memutasi input | tests/unit/patterns/silentAccumulation.test.js | LULUS | 1 |
| UNIT-PSYN-001 | UNIT-PSYN-001 PRNG seeded deterministik dan berbeda antar-seed | tests/unit/patterns/synthetic.test.js | LULUS | 3 |
| UNIT-PSYN-002 | UNIT-PSYN-002 candle mengikuti kontrak: waktu sejajar, closeTime = openTime + interval − 1, OHLC konsisten, tertutup | tests/unit/patterns/synthetic.test.js | LULUS | 8 |
| UNIT-PSYN-003 | UNIT-PSYN-003 seed & segmen sama → candle identik; generator tidak memakai Math.random | tests/unit/patterns/synthetic.test.js | LULUS | 4 |
| UNIT-PSYN-004 | UNIT-PSYN-004 modifier tidak mengubah array asli | tests/unit/patterns/synthetic.test.js | LULUS | 2 |
| POS-SPL-001 | POS-SPL-001 sinyal 5m dibuka walau 1h netral; HTF berbalik bearish → tetap terbuka dengan COUNTERTREND_HTF | tests/unit/signals/pipeline.test.js | LULUS | 34 |
| UNIT-SREP-001 | UNIT-SREP-001 ensurePatternDefinition idempoten per (pattern_key, version) | tests/unit/signals/signalRepository.test.js | LULUS | 53 |
| NEG-SREP-001 | NEG-SREP-001 definisi pola tidak valid ditolak sebelum menyentuh database | tests/unit/signals/signalRepository.test.js | LULUS | 7 |
| POS-SREP-001 | POS-SREP-001 siklus hidup lengkap tersimpan: sinyal, snapshot, event, closed_at | tests/unit/signals/signalRepository.test.js | LULUS | 14 |
| UNIT-SREP-002 | UNIT-SREP-002 NO_PATTERN/NONE tidak pernah disimpan; terminal tanpa event = no-op | tests/unit/signals/signalRepository.test.js | LULUS | 9 |
| UNIT-SREP-003 | UNIT-SREP-003 getOpen mengembalikan snapshot yang identik dengan hasil transition | tests/unit/signals/signalRepository.test.js | LULUS | 11 |
| POS-SREP-002 | POS-SREP-002 persistensi & restart (file DB sementara): hasil sama dengan proses tanpa restart | tests/unit/signals/signalRepository.test.js | LULUS | 40 |
| UNIT-SREP-004 | UNIT-SREP-004 perubahan versi pola: sinyal lama tetap mereferensikan versi lamanya | tests/unit/signals/signalRepository.test.js | LULUS | 8 |
| UNIT-SREP-005 | UNIT-SREP-005 listActive memfilter timeframe, klasifikasi, state, dan skor minimum | tests/unit/signals/signalRepository.test.js | LULUS | 10 |
| NEG-SREP-002 | NEG-SREP-002 filter tidak valid ditolak (termasuk upaya injeksi SQL) | tests/unit/signals/signalRepository.test.js | LULUS | 7 |
| NEG-SREP-003 | NEG-SREP-003 save menolak keadaan yang tidak konsisten | tests/unit/signals/signalRepository.test.js | LULUS | 8 |
| NEG-SREP-005 | NEG-SREP-005 save snapshot BREAKOUT tanpa event di atas sinyal QUIET → ditolak STATE_CHANGE_WITHOUT_EVENT; state & riwayat tidak berubah | tests/unit/signals/signalRepository.test.js | LULUS | 7 |
| EDGE-SREP-001 | EDGE-SREP-001 kegagalan di tengah save di-rollback seluruhnya | tests/unit/signals/signalRepository.test.js | LULUS | 6 |
| POS-SREP-003 | POS-SREP-003 closeOpenForSymbol SYMBOL_DELISTED: semua sinyal terbuka BTCUSDT (5m, 1h) → EXPIRED + event dalam satu transaksi; price = close tersimpan terakhir (null tanpa candle); ETHUSDT tidak tersentuh | tests/unit/signals/signalRepository.test.js | LULUS | 13 |
| UNIT-SREP-006 | UNIT-SREP-006 closeOpenForSymbol MONITORING_STOPPED dengan timeframes [1h] → hanya sinyal 1h ditutup; simbol tak dikenal → { closed: [] } | tests/unit/signals/signalRepository.test.js | LULUS | 7 |
| UNIT-SREP-007 | UNIT-SREP-007 listOpenSeries → pasangan simbol×timeframe bersinyal terbuka (tanpa duplikat, urut simbol lalu timeframe); sinyal terminal & yang ditutup closeOpenForSymbol tidak ikut; DB kosong → [] | tests/unit/signals/signalRepository.test.js | LULUS | 8 |
| NEG-SREP-004 | NEG-SREP-004 closeOpenForSymbol menolak reason di luar MONITORING_STOP_REASONS, waktu/timeframe/simbol tidak valid — tanpa perubahan | tests/unit/signals/signalRepository.test.js | LULUS | 7 |
| EDGE-SREP-003 | EDGE-SREP-003 closeOpenForSymbol gagal di tengah (INSERT event sinyal kedua ditolak) → di-rollback seluruhnya | tests/unit/signals/signalRepository.test.js | LULUS | 8 |
| UNIT-SREP-008 | UNIT-SREP-008 kursor analisis: markEvaluated hanya maju; save memajukannya dalam transaksi yang sama; lastEvaluatedCandleTime = max(kursor, event terakhir); bertahan setelah restart (file DB) | tests/unit/signals/signalRepository.test.js | LULUS | 20 |
| UNIT-SREP-009 | UNIT-SREP-009 history (dengan & tanpa simbol) memakai indeks terurut: tanpa SCAN penuh + TEMP B-TREE; hasil terbaru dulu, simbol tak dikenal → [] | tests/unit/signals/signalRepository.test.js | LULUS | 10 |
| EDGE-SREP-002 | EDGE-SREP-002 simpan ulang snapshot yang sama idempoten; penjelasan dipertahankan bila tidak dikirim | tests/unit/signals/signalRepository.test.js | LULUS | 7 |
| UNIT-SSM-001 | UNIT-SSM-001 tanpa pola → NO_PATTERN tanpa event | tests/unit/signals/stateMachine.test.js | LULUS | 6 |
| POS-SSM-001 | POS-SSM-001 transisi lengkap QUIET → EARLY_BULLISH → MOMENTUM_BUILDING → BREAKOUT | tests/unit/signals/stateMachine.test.js | LULUS | 3 |
| POS-SSM-002 | POS-SSM-002 deteksi dengan earlyScore tinggi langsung EARLY_BULLISH (alert) | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| UNIT-SSM-002 | UNIT-SSM-002 MOMENTUM_BUILDING juga dipicu ekspansi RVOL di atas harga deteksi | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| NEG-SSM-001 | NEG-SSM-001 tembus resistance tanpa RVOL cukup bukan BREAKOUT | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| EDGE-SSM-001 | EDGE-SSM-001 resistance basi di bawah harga deteksi tidak menghasilkan breakout palsu | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| UNIT-SSM-003 | UNIT-SSM-003 QUIET dapat langsung BREAKOUT bila syarat breakout terpenuhi | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| POS-SSM-003 | POS-SSM-003 pola gagal tanpa breakout → INVALIDATED; sinyal berikutnya dibuka baru | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| EDGE-SSM-002 | EDGE-SSM-002 close tepat di invalidationPrice belum invalidasi; QUIET invalidasi tanpa alert | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| EDGE-SSM-003 | EDGE-SSM-003 deteksi saat close sudah ≤ invalidationPrice tidak membuka sinyal | tests/unit/signals/stateMachine.test.js | LULUS | 4 |
| UNIT-SSM-004 | UNIT-SSM-004 EXPIRED bila tidak ada kemajuan dalam N bar (per state) | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| UNIT-SSM-005 | UNIT-SSM-005 BREAKOUT berakhir EXPIRED setelah jendela pemantauan; peakState tetap BREAKOUT | tests/unit/signals/stateMachine.test.js | LULUS | 0 |
| UNIT-SSM-006 | UNIT-SSM-006 tidak ada alert berulang untuk state yang sama | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| EDGE-SSM-004 | EDGE-SSM-004 candle duplikat / out-of-order diabaikan (idempoten) | tests/unit/signals/stateMachine.test.js | LULUS | 0 |
| EDGE-SSM-005 | EDGE-SSM-005 gap candle dihitung berdasarkan waktu untuk expiry | tests/unit/signals/stateMachine.test.js | LULUS | 0 |
| EDGE-SSM-006 | EDGE-SSM-006 gap 200 bar setelah EARLY_BULLISH (expiry 36) lalu close +1,5 ATR → EXPIRED NO_PROGRESS tanpa alert, bukan MOMENTUM_BUILDING; jatuh tempo tepat di candle pasca-gap tetap boleh maju | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| UNIT-SSM-007 | UNIT-SSM-007 invalidationPrice dibekukan saat deteksi: boleh naik, tidak boleh turun, tidak di atas close | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| UNIT-SSM-008 | UNIT-SSM-008 perubahan versi pola: sinyal lama tetap versi lama, sinyal baru memakai versi baru | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| POS-SSM-004 | POS-SSM-004 HTF hanya konteks: 5m tetap EARLY_BULLISH walau HTF netral/tidak tersedia/countertrend | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| UNIT-SSM-009 | UNIT-SSM-009 BOTH: pola utama = skor tertinggi; klasifikasi digabung tanpa event | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| UNIT-SSM-010 | UNIT-SSM-010 skor & risk flag dari signal view bila diberikan | tests/unit/signals/stateMachine.test.js | LULUS | 0 |
| UNIT-SSM-011 | UNIT-SSM-011 input & snapshot sebelumnya tidak dimutasi | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| NEG-SSM-002 | NEG-SSM-002 input, snapshot, dan parameter tidak valid ditolak | tests/unit/signals/stateMachine.test.js | LULUS | 1 |
| UNIT-SSM-012 | UNIT-SSM-012 parameter default tervalidasi dan beku | tests/unit/signals/stateMachine.test.js | LULUS | 0 |
| UNIT-SSM-013 | UNIT-SSM-013 ATR, RVOL, dan swing high terkonfirmasi terakhir (tanpa lookahead) | tests/unit/signals/stateMachine.test.js | LULUS | 2 |
| UNIT-MCTX-001 | UNIT-MCTX-001 BTC dengan 5 candle 1h → status insufficient_data, trend null (harga nyata tetap); 120 candle naik → ok BULLISH; tanpa candle → no_data | tests/unit/system/marketContext.test.js | LULUS | 7 |
| UNIT-MCTX-002 | UNIT-MCTX-002 badge overview: trend null / insufficient_data → "Trend tidak tersedia" (nada warn), tidak pernah badge NEUTRAL; trend nyata → label & nada trend | tests/unit/system/marketContext.test.js | LULUS | 1 |
| UNIT-WST-001 | UNIT-WST-001 tanpa heartbeat → not_running; tanpa getStatus → tetap aman | tests/unit/system/workerStatus.test.js | LULUS | 3 |
| UNIT-WST-002 | UNIT-WST-002 running + ws open | tests/unit/system/workerStatus.test.js | LULUS | 1 |
| UNIT-WST-002 | UNIT-WST-002 degraded + reconnecting | tests/unit/system/workerStatus.test.js | LULUS | 0 |
| UNIT-WST-002 | UNIT-WST-002 starting | tests/unit/system/workerStatus.test.js | LULUS | 0 |
| UNIT-WST-002 | UNIT-WST-002 stopped (heartbeat akhir) | tests/unit/system/workerStatus.test.js | LULUS | 0 |
| UNIT-WST-002 | UNIT-WST-002 running tetapi heartbeat basi | tests/unit/system/workerStatus.test.js | LULUS | 0 |
| UNIT-WST-002 | UNIT-WST-002 tepat di batas basi masih segar | tests/unit/system/workerStatus.test.js | LULUS | 0 |
| UNIT-WST-002 | UNIT-WST-002 state bukan objek | tests/unit/system/workerStatus.test.js | LULUS | 0 |
| UNIT-WST-004 | UNIT-WST-004 offset jam & clockFault diteruskan; nilai clockFault tak dikenal dibuang | tests/unit/system/workerStatus.test.js | LULUS | 1 |
| UNIT-WST-003 | UNIT-WST-003 metrik non-angka tidak diteruskan; error dibatasi 5 terbaru | tests/unit/system/workerStatus.test.js | LULUS | 1 |
| UNIT-WST-005 | UNIT-WST-005 isHeartbeatLive: segar & bukan stopped; batas basi inklusif; input rusak → false | tests/unit/system/workerStatus.test.js | LULUS | 0 |
| UNIT-SUP-001 | UNIT-SUP-001 stopped → starting → running: fork skrip tetap, argv kosong, IPC + pipe, execArgv kosong | tests/unit/system/workerSupervisor.test.js | LULUS | 6 |
| UNIT-SUP-002 | UNIT-SUP-002 running → stopping (SIGTERM) → stopped saat child keluar; stop({ wait: false }) langsung mengembalikan stopping | tests/unit/system/workerSupervisor.test.js | LULUS | 2 |
| UNIT-SUP-003 | UNIT-SUP-003 start ganda ditolak 409 (saat starting, running, dan dua panggilan bersamaan); hanya satu fork | tests/unit/system/workerSupervisor.test.js | LULUS | 11 |
| UNIT-SUP-004 | UNIT-SUP-004 start saat stopping → 409 WORKER_STOPPING; stop saat starting → 409 WORKER_STARTING | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-005 | UNIT-SUP-005 stop tanpa worker → 409 WORKER_NOT_RUNNING | tests/unit/system/workerSupervisor.test.js | LULUS | 0 |
| UNIT-SUP-006 | UNIT-SUP-006 child tidak keluar setelah SIGTERM → SIGKILL setelah stopTimeoutMs → stopped (signal SIGKILL) | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-007 | UNIT-SUP-007 batas stop default 15 detik | tests/unit/system/workerSupervisor.test.js | LULUS | 0 |
| UNIT-SUP-008 | UNIT-SUP-008 child keluar tanpa diminta (kode keluar 1) → 1; start ulang diizinkan | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-008 | UNIT-SUP-008 child keluar tanpa diminta (sinyal SIGSEGV) → null; start ulang diizinkan | tests/unit/system/workerSupervisor.test.js | LULUS | 2 |
| UNIT-SUP-008 | UNIT-SUP-008 child keluar tanpa diminta (keluar sendiri kode 0 (mis. Ctrl+C di terminal npm start)) → 0; start ulang diizinkan | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-009 | UNIT-SUP-009 heartbeat segar tanpa child milik server → external; start & stop ditolak 409 tanpa fork | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-010 | UNIT-SUP-010 heartbeat basi → bukan external, start diizinkan | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-010 | UNIT-SUP-010 heartbeat akhir stopped → bukan external, start diizinkan | tests/unit/system/workerSupervisor.test.js | LULUS | 0 |
| UNIT-SUP-010 | UNIT-SUP-010 tanpa heartbeat → bukan external, start diizinkan | tests/unit/system/workerSupervisor.test.js | LULUS | 0 |
| UNIT-SUP-011 | UNIT-SUP-011 heartbeat "running" yang ditinggalkan child milik server (dibunuh sebelum heartbeat akhir) bukan external | tests/unit/system/workerSupervisor.test.js | LULUS | 0 |
| UNIT-SUP-012 | UNIT-SUP-012 heartbeat yang ditulis SETELAH child milik server keluar → worker lain → external | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-013 | UNIT-SUP-013 heartbeat yang diberikan pemanggil dipakai tanpa membaca ulang; gagal baca: status aman, start ditolak | tests/unit/system/workerSupervisor.test.js | LULUS | 2 |
| UNIT-SUP-014 | UNIT-SUP-014 fork melempar → 500 WORKER_SPAWN_FAILED, state crashed | tests/unit/system/workerSupervisor.test.js | LULUS | 0 |
| UNIT-SUP-015 | UNIT-SUP-015 event error sebelum spawn → crashed & start ditolak; error berulang setelah spawn tidak menjatuhkan server | tests/unit/system/workerSupervisor.test.js | LULUS | 5 |
| UNIT-SUP-016 | UNIT-SUP-016 tidak ada event spawn dalam startTimeoutMs → SIGKILL & start ditolak | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-017 | UNIT-SUP-017 child keluar sebelum spawn (mis. skrip error saat dimuat) → start ditolak, crashed dengan kode keluar | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-018 | UNIT-SUP-018 scriptPath wajib absolut; opsi batas waktu divalidasi | tests/unit/system/workerSupervisor.test.js | LULUS | 0 |
| UNIT-SUP-019 | UNIT-SUP-019 env child adalah snapshot saat supervisor dibuat | tests/unit/system/workerSupervisor.test.js | LULUS | 0 |
| UNIT-SUP-020 | UNIT-SUP-020 shutdown menghentikan child (SIGTERM, menunggu exit) dan menolak start berikutnya (503) | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-021 | UNIT-SUP-021 shutdown saat starting menunggu spawn lalu menghentikan child | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-022 | UNIT-SUP-022 shutdown selama pembacaan heartbeat → start dibatalkan tanpa fork | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-023 | UNIT-SUP-023 killChild mengirim sinyal sinkron; tanpa child → false | tests/unit/system/workerSupervisor.test.js | LULUS | 0 |
| UNIT-SUP-024 | UNIT-SUP-024 baris stdout & stderr child diteruskan utuh, termasuk baris yang terbelah antar-chunk | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-025 | UNIT-SUP-025 baris terlalu panjang dipotong (+ penanda) dan sisanya dibuang sampai newline; baris berikutnya normal | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-SUP-026 | UNIT-SUP-026 createLineForwarder: CRLF & karakter kontrol dibuang, baris kosong dilewati, batas default 16 KiB | tests/unit/system/workerSupervisor.test.js | LULUS | 1 |
| UNIT-BKF-001 | UNIT-BKF-001 tepat di batas interval → candle sebelumnya adalah yang terakhir tertutup | tests/unit/ingestion/backfill.test.js | LULUS | 2 |
| UNIT-BKF-002 | UNIT-BKF-002 tanpa lastOpenTime → bootstrap maxCandles terakhir yang tertutup | tests/unit/ingestion/backfill.test.js | LULUS | 2 |
| UNIT-BKF-003 | UNIT-BKF-003 setelah lastOpenTime sampai candle tertutup terakhir | tests/unit/ingestion/backfill.test.js | LULUS | 1 |
| EDGE-BKF-001 | EDGE-BKF-001 sudah up-to-date → [] | tests/unit/ingestion/backfill.test.js | LULUS | 0 |
| UNIT-BKF-004 | UNIT-BKF-004 rentang besar dipecah ≤1500 candle per request, berurutan tanpa celah | tests/unit/ingestion/backfill.test.js | LULUS | 1 |
| EDGE-BKF-002 | EDGE-BKF-002 bootstrap tepat 1500 → satu request; 1501 → dua request | tests/unit/ingestion/backfill.test.js | LULUS | 1 |
| EDGE-BKF-003 | EDGE-BKF-003 maxCandles membatasi gap sangat panjang → ambil candle paling baru | tests/unit/ingestion/backfill.test.js | LULUS | 0 |
| UNIT-BKF-005 | UNIT-BKF-005 chunkSize kustom dihormati namun tidak boleh melebihi 1500 | tests/unit/ingestion/backfill.test.js | LULUS | 1 |
| NEG-BKF-001 | NEG-BKF-001 argumen tidak valid ditolak | tests/unit/ingestion/backfill.test.js | LULUS | 1 |
| UNIT-BKF-006 | UNIT-BKF-006 gap dari findGaps (openTime inklusif) menjadi request ≤1500 | tests/unit/ingestion/backfill.test.js | LULUS | 1 |
| UNIT-BKF-007 | UNIT-BKF-007 gap berdekatan digabung bila muat dalam satu request | tests/unit/ingestion/backfill.test.js | LULUS | 0 |
| EDGE-BKF-004 | EDGE-BKF-004 gap panjang dipecah; gap melewati candle tertutup terakhir dipotong | tests/unit/ingestion/backfill.test.js | LULUS | 1 |
| NEG-BKF-002 | NEG-BKF-002 gap rusak ditolak | tests/unit/ingestion/backfill.test.js | LULUS | 0 |
| UNIT-CVL-001 | UNIT-CVL-001 candle tertutup yang valid diterima | tests/unit/ingestion/candleValidator.test.js | LULUS | 4 |
| UNIT-CVL-002 | UNIT-CVL-002 volume nol (tanpa transaksi) tetap valid | tests/unit/ingestion/candleValidator.test.js | LULUS | 1 |
| UNIT-CVL-003 | UNIT-CVL-003 presisi kecil (0.00001234) valid | tests/unit/ingestion/candleValidator.test.js | LULUS | 1 |
| UNIT-CVL-004 | UNIT-CVL-004 candle provisional (belum tertutup, interval sedang berjalan) valid | tests/unit/ingestion/candleValidator.test.js | LULUS | 1 |
| UNIT-CVL-005 | UNIT-CVL-005 timeframe 5m: closeTime = openTime + interval - 1 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| UNIT-CVL-005 | UNIT-CVL-005 timeframe 15m: closeTime = openTime + interval - 1 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| UNIT-CVL-005 | UNIT-CVL-005 timeframe 1h: closeTime = openTime + interval - 1 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-001 | NEG-CVL-001 high < low ditolak | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-002 | NEG-CVL-002 OHLC tidak konsisten ditolak: high < open | tests/unit/ingestion/candleValidator.test.js | LULUS | 1 |
| NEG-CVL-002 | NEG-CVL-002 OHLC tidak konsisten ditolak: high < close | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-002 | NEG-CVL-002 OHLC tidak konsisten ditolak: low > open | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-002 | NEG-CVL-002 OHLC tidak konsisten ditolak: low > close | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-003 | NEG-CVL-003 harga tidak valid ditolak: open NaN | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-003 | NEG-CVL-003 harga tidak valid ditolak: high Infinity | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-003 | NEG-CVL-003 harga tidak valid ditolak: low nol | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-003 | NEG-CVL-003 harga tidak valid ditolak: close negatif | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-003 | NEG-CVL-003 harga tidak valid ditolak: open string | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-003 | NEG-CVL-003 harga tidak valid ditolak: close hilang | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-004 | NEG-CVL-004 open time tidak sejajar batas interval: tidak sejajar 5m | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-004 | NEG-CVL-004 open time tidak sejajar batas interval: sejajar 5m tetapi bukan 1h | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-005 | NEG-CVL-005 openTime bukan bilangan bulat ms ≥ 0: openTime pecahan | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-005 | NEG-CVL-005 openTime bukan bilangan bulat ms ≥ 0: openTime negatif | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-005 | NEG-CVL-005 openTime bukan bilangan bulat ms ≥ 0: openTime string | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-006 | NEG-CVL-006 closeTime salah ditolak: tanpa -1 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-006 | NEG-CVL-006 closeTime salah ditolak: interval timeframe lain | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-006 | NEG-CVL-006 closeTime salah ditolak: detik, bukan ms | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-007 | NEG-CVL-007 timeframe tidak didukung ditolak: 1m | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-007 | NEG-CVL-007 timeframe tidak didukung ditolak: 4h | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-007 | NEG-CVL-007 timeframe tidak didukung ditolak: 1H | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-007 | NEG-CVL-007 timeframe tidak didukung ditolak:  | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-007 | NEG-CVL-007 timeframe tidak didukung ditolak: undefined | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-008 | NEG-CVL-008 format simbol salah ditolak: btcusdt | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-008 | NEG-CVL-008 format simbol salah ditolak: BTC-USDT | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-008 | NEG-CVL-008 format simbol salah ditolak: BTCUSDT_250627 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-008 | NEG-CVL-008 format simbol salah ditolak:  | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-008 | NEG-CVL-008 format simbol salah ditolak:  BTCUSDT | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-008 | NEG-CVL-008 format simbol salah ditolak: BTC'; DROP TABLE candles;-- | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-008 | NEG-CVL-008 format simbol salah ditolak: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-008 | NEG-CVL-008 format simbol salah ditolak: 123 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-008 | NEG-CVL-008 format simbol salah ditolak: null | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-009 | NEG-CVL-009 volume tidak valid ditolak: volume negatif | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-009 | NEG-CVL-009 volume tidak valid ditolak: quoteVolume NaN | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-009 | NEG-CVL-009 volume tidak valid ditolak: takerBuyVolume negatif | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-009 | NEG-CVL-009 volume tidak valid ditolak: takerBuyVolume > volume | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-009 | NEG-CVL-009 volume tidak valid ditolak: takerBuyQuoteVolume > quoteVolume | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-009 | NEG-CVL-009 volume tidak valid ditolak: takerBuyQuoteVolume hilang | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-010 | NEG-CVL-010 jumlah trade tidak valid ditolak: 1.5 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-010 | NEG-CVL-010 jumlah trade tidak valid ditolak: -1 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-010 | NEG-CVL-010 jumlah trade tidak valid ditolak: NaN | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-010 | NEG-CVL-010 jumlah trade tidak valid ditolak: 42 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-011 | NEG-CVL-011 candle "tertutup" dari masa depan ditolak (now ≤ closeTime) | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-012 | NEG-CVL-012 openTime di masa depan ditolak (juga untuk provisional) | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-013 | NEG-CVL-013 input bukan objek ditolak: null | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-013 | NEG-CVL-013 input bukan objek ditolak: undefined | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-013 | NEG-CVL-013 input bukan objek ditolak: candle | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-013 | NEG-CVL-013 input bukan objek ditolak: 42 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-013 | NEG-CVL-013 input bukan objek ditolak: undefined | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-014 | NEG-CVL-014 flag & sumber tidak valid ditolak: isClosed string | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-014 | NEG-CVL-014 flag & sumber tidak valid ditolak: isClosed hilang | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-014 | NEG-CVL-014 flag & sumber tidak valid ditolak: source tidak dikenal | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-015 | NEG-CVL-015 now tidak valid → TypeError: undefined | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-015 | NEG-CVL-015 now tidak valid → TypeError: NaN | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-015 | NEG-CVL-015 now tidak valid → TypeError: 1767225600000 | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-016 | NEG-CVL-016 validateCandle tanpa opsi → TypeError | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| EDGE-CVL-009 | EDGE-CVL-009 kline WS tertutup (bendera x bursa) dengan jam worker tertinggal ≤ 2 d dari closeTime diterima; > 2 d ditolak; candle REST tetap ketat (now > closeTime) | tests/unit/ingestion/candleValidator.test.js | LULUS | 1 |
| EDGE-CVL-010 | EDGE-CVL-010 tick provisional WS pertama dengan jam worker tertinggal ≤ 2 d dari openTime tidak dianggap "openTime di masa depan"; REST tetap ketat | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| EDGE-CVL-001 | EDGE-CVL-001 batas tertutup: now = closeTime + 1 diterima | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| EDGE-CVL-002 | EDGE-CVL-002 toleransi floating kecil pada taker buy ≤ volume | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| EDGE-CVL-003 | EDGE-CVL-003 seluruh pelanggaran dikumpulkan, bukan hanya yang pertama | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| EDGE-CVL-004 | EDGE-CVL-004 candle datar (O=H=L=C) valid | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| EDGE-CVL-005 | EDGE-CVL-005 openTime 0 (epoch) sejajar & valid | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| UNIT-CVL-006 | UNIT-CVL-006 batch acak diurutkan openTime naik | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| UNIT-CVL-007 | UNIT-CVL-007 duplikat (symbol, timeframe, openTime) dibuang — versi terakhir menang | tests/unit/ingestion/candleValidator.test.js | LULUS | 2 |
| UNIT-CVL-008 | UNIT-CVL-008 tidak memutasi input; batch kosong → [] | tests/unit/ingestion/candleValidator.test.js | LULUS | 1 |
| EDGE-CVL-006 | EDGE-CVL-006 openTime sama tetapi simbol/timeframe berbeda tidak dianggap duplikat; urutan deterministik | tests/unit/ingestion/candleValidator.test.js | LULUS | 1 |
| NEG-CVL-017 | NEG-CVL-017 input bukan array → TypeError: null | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-017 | NEG-CVL-017 input bukan array → TypeError: x | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-017 | NEG-CVL-017 input bukan array → TypeError: { length: 1 } | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-018 | NEG-CVL-018 elemen bukan objek → TypeError | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| UNIT-CVL-009 | UNIT-CVL-009 floorToInterval membulatkan ke batas interval UTC | tests/unit/ingestion/candleValidator.test.js | LULUS | 3 |
| UNIT-CVL-010 | UNIT-CVL-010 data segar: candle tertutup terakhir sudah tersimpan | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| UNIT-CVL-011 | UNIT-CVL-011 data basi: tertinggal beberapa candle melewati masa tenggang | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| EDGE-CVL-007 | EDGE-CVL-007 candle baru saja tertutup masih dalam masa tenggang → belum basi | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| EDGE-CVL-011 | EDGE-CVL-011 tertinggal 3 candle, now 1 d setelah batas interval (grace 30 d) → basi: masa tenggang dihitung dari candle tertinggal PALING LAMA, bukan candle yang baru tutup | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| EDGE-CVL-008 | EDGE-CVL-008 belum ada data → basi, lag tidak diketahui | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| NEG-CVL-019 | NEG-CVL-019 argumen kesegaran tidak valid → TypeError | tests/unit/ingestion/candleValidator.test.js | LULUS | 0 |
| UNIT-BNP-001 | UNIT-BNP-001 baris kline fixture → Candle kanonik (angka string → number, source rest) | tests/unit/ingestion/parse.test.js | LULUS | 5 |
| EDGE-BNP-001 | EDGE-BNP-001 isClosed = closeTime < now: tepat di closeTime masih terbuka, +1 ms tertutup | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| EDGE-BNP-002 | EDGE-BNP-002 presisi string kecil "0.00001234" dan volume besar dipertahankan; candle volume nol valid | tests/unit/ingestion/parse.test.js | LULUS | 2 |
| NEG-BNP-001 | NEG-BNP-001 panjang array salah / bukan array → BinanceDataError terstruktur | tests/unit/ingestion/parse.test.js | LULUS | 2 |
| NEG-BNP-002 | NEG-BNP-002 angka tidak valid ditolak, tidak diam-diam menjadi 0/NaN | tests/unit/ingestion/parse.test.js | LULUS | 3 |
| NEG-BNP-003 | NEG-BNP-003 OHLC tidak konsisten (high<low, high<close, low>open) ditolak | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| NEG-BNP-004 | NEG-BNP-004 closeTime ≠ openTime + interval − 1 atau openTime tidak sejajar ditolak | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| NEG-BNP-005 | NEG-BNP-005 trades bukan bilangan bulat dan taker buy > volume ditolak | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| NEG-BNP-006 | NEG-BNP-006 urutan openTime tidak naik / duplikat dalam satu respons ditolak | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| UNIT-BNP-002 | UNIT-BNP-002 semua masalah dikumpulkan per baris; respons kosong → array kosong | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| NEG-BNP-007 | NEG-BNP-007 konteks parse tidak valid (timeframe tak dikenal, now bukan angka, simbol kosong) → TypeError | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| UNIT-BNP-003 | UNIT-BNP-003 exchangeInfo → SymbolInfo: tickSize dari PRICE_FILTER, stepSize dari LOT_SIZE (string) | tests/unit/ingestion/parse.test.js | LULUS | 2 |
| EDGE-BNP-003 | EDGE-BNP-003 status delisting (SETTLING/BREAK) dipertahankan; filter hilang → tickSize/stepSize null | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| NEG-BNP-008 | NEG-BNP-008 exchangeInfo rusak (tanpa symbols, field wajib hilang, tickSize tidak valid) ditolak | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| UNIT-BNP-004 | UNIT-BNP-004 ticker 24 jam → angka; priceChangePercent boleh negatif | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| NEG-BNP-009 | NEG-BNP-009 ticker 24 jam rusak (volume negatif, closeTime string, bukan array) ditolak | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| UNIT-BNP-005 | UNIT-BNP-005 book ticker → spreadBps = (ask − bid) / mid × 10000 | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| EDGE-BNP-004 | EDGE-BNP-004 kuotasi kosong (bid/ask 0) atau tersilang → spreadBps null | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| UNIT-BNP-006 | UNIT-BNP-006 parseDecimal & parseServerTime | tests/unit/ingestion/parse.test.js | LULUS | 1 |
| UNIT-BNL-001 | UNIT-BNL-001 bobot klines mengikuti tabel limit Binance; bobot endpoint lain | tests/unit/ingestion/rateLimiter.test.js | LULUS | 3 |
| UNIT-BNL-002 | UNIT-BNL-002 di bawah batas: tidak tidur, bobot terakumulasi | tests/unit/ingestion/rateLimiter.test.js | LULUS | 1 |
| UNIT-BNL-003 | UNIT-BNL-003 melewati batas → tidur sampai jendela menit berikutnya, lalu jendela direset | tests/unit/ingestion/rateLimiter.test.js | LULUS | 1 |
| EDGE-BNL-001 | EDGE-BNL-001 tepat sama dengan batas diizinkan; +1 menunggu | tests/unit/ingestion/rateLimiter.test.js | LULUS | 0 |
| EDGE-BNL-002 | EDGE-BNL-002 satu bobot melebihi batas pada jendela kosong tetap jalan (tanpa deadlock) | tests/unit/ingestion/rateLimiter.test.js | LULUS | 0 |
| UNIT-BNL-004 | UNIT-BNL-004 header X-MBX-USED-WEIGHT-1M menaikkan pemakaian; nilai lebih kecil tidak menurunkan; header jendela lama diabaikan | tests/unit/ingestion/rateLimiter.test.js | LULUS | 0 |
| UNIT-BNL-005 | UNIT-BNL-005 jendela bergulir: usedWeight kembali 0 setelah menit berganti | tests/unit/ingestion/rateLimiter.test.js | LULUS | 0 |
| UNIT-BNL-006 | UNIT-BNL-006 blokir (429/418): acquire menunggu blokir selesai; blokir panjang melempar error retryable | tests/unit/ingestion/rateLimiter.test.js | LULUS | 1 |
| EDGE-BNL-003 | EDGE-BNL-003 blokir lebih pendek tidak memperpendek blokir yang sudah ada | tests/unit/ingestion/rateLimiter.test.js | LULUS | 1 |
| UNIT-BNL-007 | UNIT-BNL-007 permintaan konkuren yang menunggu tidak melampaui batas bersama | tests/unit/ingestion/rateLimiter.test.js | LULUS | 1 |
| NEG-BNL-001 | NEG-BNL-001 konfigurasi & bobot tidak valid ditolak | tests/unit/ingestion/rateLimiter.test.js | LULUS | 2 |
| NEG-BNL-002 | NEG-BNL-002 header bobot tidak valid diabaikan | tests/unit/ingestion/rateLimiter.test.js | LULUS | 1 |
| UNIT-BNR-001 | UNIT-BNR-001 getServerTime: GET /fapi/v1/time ke host allowlist, tanpa redirect & tanpa kredensial | tests/unit/ingestion/restClient.test.js | LULUS | 6 |
| UNIT-BNR-002 | UNIT-BNR-002 getKlines: parameter query benar, Candle kanonik, isClosed dari clock | tests/unit/ingestion/restClient.test.js | LULUS | 4 |
| UNIT-BNR-012 | UNIT-BNR-012 getKlines: isClosed diukur dari jam saat request DIMULAI dikurangi margin 2 d — request 100 ms sebelum close yang dijawab 100 ms sesudahnya → candle itu false; candle yang tutup 1,5 d sebelum request → false (margin 0 → true) | tests/unit/ingestion/restClient.test.js | LULUS | 3 |
| UNIT-BNR-013 | UNIT-BNR-013 getKlines: isClosed memakai closureClock bila diberikan (jam host 11 menit di depan, closureClock = waktu server) → candle ke-3 yang masih berjalan menurut server tetap false walau `clock` sudah jauh melewati closeTime-nya; closureClock bukan fungsi ditolak | tests/unit/ingestion/restClient.test.js | LULUS | 2 |
| UNIT-BNR-003 | UNIT-BNR-003 getKlines default limit 500; startTime/endTime opsional tidak dikirim | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| UNIT-BNR-004 | UNIT-BNR-004 getExchangeInfo, get24hTickers, getBookTickers → bentuk kontrak | tests/unit/ingestion/restClient.test.js | LULUS | 3 |
| EDGE-BNR-001 | EDGE-BNR-001 harga string sangat kecil ("0.00001234") tetap presisi lewat klien | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| NEG-BNR-001 | NEG-BNR-001 baris kline rusak → BinanceDataError, tidak diulang dan tidak dibuang diam-diam | tests/unit/ingestion/restClient.test.js | LULUS | 6 |
| NEG-BNR-002 | NEG-BNR-002 parameter klines tidak valid ditolak sebelum request (tanpa fetch) | tests/unit/ingestion/restClient.test.js | LULUS | 3 |
| NEG-BNR-003 | NEG-BNR-003 simbol tidak dikenal Binance (400, -1121) → BinanceApiError tidak diulang | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| NEG-BNR-004 | NEG-BNR-004 4xx lain (403 WAF, 451) tidak diulang; pesan eksternal dibersihkan | tests/unit/ingestion/restClient.test.js | LULUS | 2 |
| NEG-BNR-005 | NEG-BNR-005 respons 200 bukan JSON / bukan Response-like → BAD_RESPONSE tidak diulang | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| UNIT-BNR-005 | UNIT-BNR-005 429 dengan Retry-After (detik) → tunggu sesuai header lalu ulang dan sukses | tests/unit/ingestion/restClient.test.js | LULUS | 2 |
| UNIT-BNR-006 | UNIT-BNR-006 429 Retry-After berupa HTTP-date dihormati | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| NEG-BNR-006 | NEG-BNR-006 429 dengan Retry-After panjang → langsung error retryable + retryAfterMs; request lain ditahan tanpa fetch | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| NEG-BNR-007 | NEG-BNR-007 418 (IP diblokir) → error retryable dengan retryAfterMs, tidak diulang otomatis, klien fail-fast sampai ban berakhir | tests/unit/ingestion/restClient.test.js | LULUS | 2 |
| NEG-BNR-015 | NEG-BNR-015 418 (Retry-After 7200) / 429 (Retry-After 120) yang body-nya macet sampai timeout → tetap error rate-limit (status, retryAfterMs), tidak diulang, limiter diblokir: request berikutnya RATE_LIMIT_BLOCKED tanpa fetch | tests/unit/ingestion/restClient.test.js | LULUS | 64 |
| EDGE-BNR-002 | EDGE-BNR-002 418 tanpa Retry-After tetap memblokir (default 2 menit) | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| EDGE-BNR-005 | EDGE-BNR-005 429 tanpa Retry-After → backoff (semua request ditahan lewat limiter) lalu sukses | tests/unit/ingestion/restClient.test.js | LULUS | 3 |
| UNIT-BNR-007 | UNIT-BNR-007 500 lalu sukses → backoff eksponensial dengan jitter deterministik | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| UNIT-BNR-008 | UNIT-BNR-008 backoff berlipat per percobaan (5xx berulang) dan jitter mengikuti fungsi random | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| NEG-BNR-008 | NEG-BNR-008 maxRetries habis → error 5xx retryable dilempar; jumlah percobaan = maxRetries + 1 | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| NEG-BNR-009 | NEG-BNR-009 timeout (AbortController) → TIMEOUT retryable, diulang, lalu dilempar | tests/unit/ingestion/restClient.test.js | LULUS | 35 |
| EDGE-BNR-003 | EDGE-BNR-003 timeout tetap berlaku bila fetch/body mengabaikan signal; timeout lalu sukses | tests/unit/ingestion/restClient.test.js | LULUS | 32 |
| NEG-BNR-010 | NEG-BNR-010 error jaringan → diulang; bila tetap gagal → NETWORK retryable | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| UNIT-BNR-009 | UNIT-BNR-009 pembatasan bobot perkiraan memanggil sleep sebelum melewati maxWeightPerMinute | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| UNIT-BNR-010 | UNIT-BNR-010 header X-MBX-USED-WEIGHT-1M dilacak dan menahan request berikutnya | tests/unit/ingestion/restClient.test.js | LULUS | 0 |
| EDGE-BNR-004 | EDGE-BNR-004 bobot klines mengikuti limit (99 → 1, 100 → 2, 1500 → 10) | tests/unit/ingestion/restClient.test.js | LULUS | 0 |
| UNIT-BNR-011 | UNIT-BNR-011 sampleServerTime: 429 Retry-After 4 d → langsung dilempar tanpa retry/tidur; sampel berikutnya menunggu limiter 4 d DULU, stempel sentAt/receivedAt dengan jam pemanggil diambil sesudahnya | tests/unit/ingestion/restClient.test.js | LULUS | 2 |
| NEG-BNR-013 | NEG-BNR-013 sampleServerTime: 503 / error jaringan → dilempar setelah SATU percobaan (tanpa backoff); serverTime tidak valid → BinanceDataError; clock bukan fungsi ditolak | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| NEG-BNR-014 | NEG-BNR-014 closeMarginMs bukan bilangan bulat 0..60000 ditolak saat pembuatan klien | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| NEG-BNR-011 | NEG-BNR-011 baseUrl di luar allowlist / tidak aman ditolak saat pembuatan klien | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| POS-BNR-001 | POS-BNR-001 allowedHosts eksplisit (khusus tes) mengizinkan host lain; host default & trailing slash diterima | tests/unit/ingestion/restClient.test.js | LULUS | 1 |
| NEG-BNR-012 | NEG-BNR-012 opsi klien tidak valid ditolak | tests/unit/ingestion/restClient.test.js | LULUS | 0 |
| UNIT-SCK-001 | UNIT-SCK-001 server 1200 ms di depan, RTT 0 → offset 1200; now() = jam lokal + 1200 | tests/unit/ingestion/serverClock.test.js | LULUS | 5 |
| UNIT-SCK-002 | UNIT-SCK-002 titik tengah round-trip: server −750 ms, RTT 400 ms → offset −750 (bukan −950/−550) | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| UNIT-SCK-003 | UNIT-SCK-003 sync ulang memperbarui offset (drift 1200 → 900 ms); lastSync mencatat hasil terakhir dengan waktu server | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| NEG-SCK-001 | NEG-SCK-001 request gagal → tidak reject, offset terakhir (1200) dipertahankan, hasil REQUEST_FAILED + log warn | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| NEG-SCK-002 | NEG-SCK-002 gagal sejak awal → offset tetap 0 (jam lokal apa adanya) | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| NEG-SCK-003 | NEG-SCK-003 offset absurd (+11 menit > batas 10 menit) → TIDAK diterapkan, dilaporkan OFFSET_OUT_OF_RANGE dengan nilai terukur | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| UNIT-SCK-006 | UNIT-SCK-006 jam host 11 menit DI DEPAN server (OFFSET_OUT_OF_RANGE, RTT 400 ms) → offset/now() tidak berubah, tetapi closureNow() = batas bawah waktu server (jam lokal − 660000 − 200); sync berikutnya yang berhasil → closureNow() = now() lagi | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| NEG-SCK-007 | NEG-SCK-007 jam host 11 menit DI BELAKANG server (OFFSET_OUT_OF_RANGE positif) → closureNow() tidak pernah maju melebihi now() (offset terpakai 300): candle tidak dianggap tertutup lebih awal | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| EDGE-SCK-003 | EDGE-SCK-003 belum pernah tersinkron dan setiap sampel ROUND_TRIP_TOO_LONG (RTT 3 d, host 90 d di depan) → closureNow() = batas bawah dari sampel lambat (lokal − 90000 − 1500), now() tetap jam lokal; setelah sync berhasil, sampel lambat tidak lagi menggeser closureNow() | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| EDGE-SCK-001 | EDGE-SCK-001 offset tepat di batas (−10 menit) diterapkan; RTT tepat di batas default 1000 ms diterima, 1001 ms dibuang (setelah maxAttempts sampel) | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| NEG-SCK-004 | NEG-SCK-004 serverTime bukan epoch ms (string/NaN/negatif) → BAD_RESPONSE, offset tidak berubah | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| EDGE-SCK-002 | EDGE-SCK-002 sync bersamaan berbagi satu request | tests/unit/ingestion/serverClock.test.js | LULUS | 0 |
| UNIT-SCK-004 | UNIT-SCK-004 sampel bertimestamp { serverTime, sentAt, receivedAt }: jeda 3 d SEBELUM request (antrean limiter/Retry-After) dan 3 d SESUDAHNYA (event loop sibuk) tidak menggeser offset; getServerTime menerima jam lokal | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| UNIT-SCK-005 | UNIT-SCK-005 percobaan gagal retryable (503) → sampel baru diambil langsung (maks maxAttempts), offset dari sampel yang berhasil saja; error retryable:false (400) tidak diulang | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| NEG-SCK-006 | NEG-SCK-006 stempel sampel tidak valid (di luar rentang panggilan, terbalik, bukan bilangan bulat) → BAD_RESPONSE tanpa percobaan ulang, offset tidak berubah | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| NEG-SCK-005 | NEG-SCK-005 dependensi/parameter tidak valid ditolak saat konstruksi | tests/unit/ingestion/serverClock.test.js | LULUS | 1 |
| UNIT-DSC-001 | UNIT-DSC-001 mode auto: filter PERPETUAL+USDT+TRADING, likuiditas, urut quote volume menurun | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 6 |
| UNIT-DSC-002 | UNIT-DSC-002 setiap simbol masuk tepat satu kali ke selected atau rejected | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 3 |
| UNIT-DSC-003 | UNIT-DSC-003 maxAuto memotong peringkat; sisanya ditolak MAX_AUTO_LIMIT | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 1 |
| EDGE-DSC-001 | EDGE-DSC-001 ambang inklusif: quote volume = minimum lolos, spread = maksimum lolos | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 1 |
| EDGE-DSC-002 | EDGE-DSC-002 quote volume sama → urut simbol (deterministik); hasil identik bila diulang | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 1 |
| UNIT-DSC-004 | UNIT-DSC-004 mode manual: filter TRADING/PERPETUAL/USDT tetap berlaku, tanpa filter likuiditas & tanpa potong maxAuto | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 1 |
| NEG-DSC-001 | NEG-DSC-001 delisting/penghentian (SETTLING, BREAK, CLOSE, PENDING_TRADING) → NOT_TRADING meski volume tinggi | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 1 |
| EDGE-DSC-003 | EDGE-DSC-003 1000PEPEUSDT & basis 1 huruf valid; nama tak wajar atau tickSize/stepSize hilang → INVALID_SYMBOL | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 1 |
| NEG-DSC-002 | NEG-DSC-002 ticker/book ticker hilang, kuotasi kosong, atau quote volume tidak finite → NO_TICKER (mode auto) | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 1 |
| EDGE-DSC-004 | EDGE-DSC-004 prioritas alasan: kontrak → quote → status → format → ticker → volume → spread | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 1 |
| EDGE-DSC-005 | EDGE-DSC-005 entri duplikat: yang pertama dipakai, tidak dihitung dua kali | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 0 |
| NEG-DSC-003 | NEG-DSC-003 input atau pengaturan tidak valid → TypeError | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 6 |
| EDGE-DSC-006 | EDGE-DSC-006 daftar kosong → hasil kosong; entri bukan objek → INVALID_SYMBOL | tests/unit/ingestion/symbolDiscovery.test.js | LULUS | 0 |
| UNIT-WSC-001 | UNIT-WSC-001 combined stream memakai simbol lowercase | tests/unit/ingestion/wsClient.test.js | LULUS | 3 |
| UNIT-WSC-002 | UNIT-WSC-002 lebih dari 200 stream dipecah ke beberapa koneksi | tests/unit/ingestion/wsClient.test.js | LULUS | 8 |
| UNIT-WSC-014 | UNIT-WSC-014 kline memakai rute kategori /market (URL lama tanpa rute tidak mengirim kline sejak 2026-04-23) | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| NEG-WSC-005 | NEG-WSC-005 baseUrl tanpa rute /market (URL lama, /public, /private, path lain, query, fragment) ditolak | tests/unit/ingestion/wsClient.test.js | LULUS | 3 |
| EDGE-WSC-001 | EDGE-WSC-001 stream duplikat dibuang sebelum dipecah | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| NEG-WSC-001 | NEG-WSC-001 host di luar allowlist, skema non-wss, atau stream tidak valid ditolak | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| UNIT-WSC-003 | UNIT-WSC-003 x=true → candle tertutup; x=false → provisional; source ws | tests/unit/ingestion/wsClient.test.js | LULUS | 2 |
| NEG-WSC-002 | NEG-WSC-002 bentuk pesan rusak ditolak dengan alasan | tests/unit/ingestion/wsClient.test.js | LULUS | 2 |
| EDGE-WSC-002 | EDGE-WSC-002 harga numerik (bukan string) yang valid tetap diterima | tests/unit/ingestion/wsClient.test.js | LULUS | 4 |
| UNIT-WSC-004 | UNIT-WSC-004 pesan diteruskan ke onCandle; state idle→connecting→open | tests/unit/ingestion/wsClient.test.js | LULUS | 2 |
| NEG-WSC-003 | NEG-WSC-003 pesan rusak dicatat lewat onState dan diabaikan tanpa memutus koneksi | tests/unit/ingestion/wsClient.test.js | LULUS | 2 |
| EDGE-WSC-003 | EDGE-WSC-003 pesan raksasa ditolak sebelum JSON.parse | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| EDGE-WSC-004 | EDGE-WSC-004 event untuk stream yang tidak dilanggan diabaikan | tests/unit/ingestion/wsClient.test.js | LULUS | 5 |
| EDGE-WSC-005 | EDGE-WSC-005 onCandle yang melempar error tidak menghentikan stream | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| UNIT-WSC-005 | UNIT-WSC-005 reconnect setelah close | tests/unit/ingestion/wsClient.test.js | LULUS | 3 |
| UNIT-WSC-006 | UNIT-WSC-006 backoff tumbuh eksponensial dan dibatasi maxMs | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| UNIT-WSC-007 | UNIT-WSC-007 computeBackoff: jitter dalam [base/2, base] dan tidak melewati maxMs | tests/unit/ingestion/wsClient.test.js | LULUS | 0 |
| UNIT-WSC-008 | UNIT-WSC-008 backoff di-reset setelah koneksi stabil, tidak di-reset bila singkat | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| UNIT-WSC-009 | UNIT-WSC-009 koneksi basi (tanpa pesan ≥ staleMs) ditutup lalu reconnect | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| UNIT-WSC-010 | UNIT-WSC-010 batas waktu connect: tidak pernah open → reconnect | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| UNIT-WSC-011 | UNIT-WSC-011 reconnect terjadwal sebelum batas 24 jam Binance, tanpa menambah backoff | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| NEG-WSC-004 | NEG-WSC-004 event error dan constructor yang melempar memicu reconnect | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| UNIT-WSC-012 | UNIT-WSC-012 hanya koneksi yang putus yang reconnect; state agregat mengikuti | tests/unit/ingestion/wsClient.test.js | LULUS | 1 |
| UNIT-WSC-013 | UNIT-WSC-013 stop() menutup bersih tanpa reconnect dan tanpa timer tersisa | tests/unit/ingestion/wsClient.test.js | LULUS | 2 |
| EDGE-WSC-006 | EDGE-WSC-006 stop() saat menunggu reconnect membatalkan timer | tests/unit/ingestion/wsClient.test.js | LULUS | 0 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=["BULLISH","BULLISH"] → ALIGNED | tests/unit/timeframe/context.test.js | LULUS | 3 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=["BULLISH","NEUTRAL"] → PARTIALLY_CONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 1 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=["NEUTRAL","BULLISH"] → PARTIALLY_CONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 1 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=["BULLISH",null] → PARTIALLY_CONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 0 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=["BULLISH","BEARISH"] → COUNTERTREND | tests/unit/timeframe/context.test.js | LULUS | 0 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=["NEUTRAL","BEARISH"] → COUNTERTREND | tests/unit/timeframe/context.test.js | LULUS | 1 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=["BEARISH",null] → COUNTERTREND | tests/unit/timeframe/context.test.js | LULUS | 0 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=["NEUTRAL","NEUTRAL"] → UNCONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 0 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=[null,null] → UNCONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 1 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=["NEUTRAL",null] → UNCONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 0 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=true, HTF=[] → UNCONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 0 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=false, HTF=["BULLISH","BULLISH"] → PARTIALLY_CONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 0 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=false, HTF=["BULLISH","NEUTRAL"] → PARTIALLY_CONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 0 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=false, HTF=["NEUTRAL","BEARISH"] → COUNTERTREND | tests/unit/timeframe/context.test.js | LULUS | 0 |
| UNIT-HTF-001 | UNIT-HTF-001 baseTrendOk=false, HTF=[] → UNCONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 0 |
| NEG-HTF-001 | NEG-HTF-001 input alignment tidak valid ditolak | tests/unit/timeframe/context.test.js | LULUS | 1 |
| EDGE-HTF-001 | EDGE-HTF-001 batas inklusif closeTime <= t | tests/unit/timeframe/context.test.js | LULUS | 2 |
| NEG-HTF-002 | NEG-HTF-002 candle provisional (isClosed false) tidak pernah dipakai walau closeTime <= t | tests/unit/timeframe/context.test.js | LULUS | 2 |
| UNIT-HTF-002 | UNIT-HTF-002 lastClosedCloseTime menghitung candle HTF terakhir yang sudah tertutup pada t | tests/unit/timeframe/context.test.js | LULUS | 0 |
| EDGE-HTF-002 | EDGE-HTF-002 candle 5m tutup 10:04:59.999 memakai 15m 09:45–09:59:59.999, bukan 10:00 yang belum tutup | tests/unit/timeframe/context.test.js | LULUS | 8 |
| EDGE-HTF-003 | EDGE-HTF-003 tepat saat 15m ikut tutup (10:14:59.999) candle 15m 10:00 boleh dipakai | tests/unit/timeframe/context.test.js | LULUS | 1 |
| EDGE-HTF-004 | EDGE-HTF-004 menambah candle HTF masa depan tidak mengubah konteks | tests/unit/timeframe/context.test.js | LULUS | 2 |
| POS-HTF-001 | POS-HTF-001 sinyal 5m tetap mendapat konteks walau 1h netral → PARTIALLY_CONFIRMED (tidak dibuang) | tests/unit/timeframe/context.test.js | LULUS | 1 |
| UNIT-HTF-003 | UNIT-HTF-003 konflik timeframe: 5m netral/bullish, 15m bearish → COUNTERTREND | tests/unit/timeframe/context.test.js | LULUS | 1 |
| UNIT-HTF-004 | UNIT-HTF-004 1h tidak punya HTF → UNCONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 1 |
| EDGE-HTF-005 | EDGE-HTF-005 HTF tidak tersedia / data kurang → UNCONFIRMED dengan alasan | tests/unit/timeframe/context.test.js | LULUS | 1 |
| EDGE-HTF-006 | EDGE-HTF-006 data HTF basi (candle terakhir tertinggal > maxStaleBars) dianggap tidak tersedia | tests/unit/timeframe/context.test.js | LULUS | 1 |
| EDGE-HTF-007 | EDGE-HTF-007 candle HTF hilang di luar jendela settle → STALE_DATA (1h tertinggal 1 bar pada 10:54:59.999, 15m pada 10:09:59.999); tepat di batas bersama tetap diterima | tests/unit/timeframe/context.test.js | LULUS | 4 |
| UNIT-HTF-005 | UNIT-HTF-005 trend dasar BEARISH menurunkan ALIGNED menjadi PARTIALLY_CONFIRMED | tests/unit/timeframe/context.test.js | LULUS | 0 |
| NEG-HTF-003 | NEG-HTF-003 argumen konteks tidak valid ditolak | tests/unit/timeframe/context.test.js | LULUS | 1 |
| POS-TRND-001 | POS-TRND-001 tren naik bergelombang → BULLISH dengan alasan EMA, slope, dan struktur swing | tests/unit/timeframe/trend.test.js | LULUS | 4 |
| POS-TRND-002 | POS-TRND-002 tren turun bergelombang → BEARISH | tests/unit/timeframe/trend.test.js | LULUS | 1 |
| UNIT-TRND-001 | UNIT-TRND-001 pasar datar → NEUTRAL dengan slope datar | tests/unit/timeframe/trend.test.js | LULUS | 1 |
| EDGE-TRND-001 | EDGE-TRND-001 data kurang dari warm-up → NEUTRAL dengan INSUFFICIENT_DATA | tests/unit/timeframe/trend.test.js | LULUS | 1 |
| UNIT-TRND-002 | UNIT-TRND-002 sinyal campuran (harga di atas EMA tetapi struktur & slope turun) → NEUTRAL | tests/unit/timeframe/trend.test.js | LULUS | 1 |
| UNIT-TRND-003 | UNIT-TRND-003 lower low yang baru punya 1 candle sesudahnya (< swingRight) tidak dipakai → SWING_HH_HL; setelah terkonfirmasi → SWING_MIXED (anti lookahead) | tests/unit/timeframe/trend.test.js | LULUS | 4 |
| UNIT-TRND-004 | UNIT-TRND-004 parameter dapat dikonfigurasi (minScore 4 → sinyal 3/4 menjadi NEUTRAL) | tests/unit/timeframe/trend.test.js | LULUS | 1 |
| NEG-TRND-001 | NEG-TRND-001 input & parameter tidak valid ditolak | tests/unit/timeframe/trend.test.js | LULUS | 2 |
| POS-SCN-001 | POS-SCN-001 start: discovery → simpan simbol → bootstrap REST → upsert → stream dibuka | tests/unit/worker/scanner.test.js | LULUS | 20 |
| UNIT-SCN-001 | UNIT-SCN-001 data tersimpan dipakai: hanya candle setelah lastOpenTime yang diambil | tests/unit/worker/scanner.test.js | LULUS | 2 |
| UNIT-SCN-002 | UNIT-SCN-002 gap historis dalam jendela bootstrap ditutup lewat findGaps | tests/unit/worker/scanner.test.js | LULUS | 2 |
| UNIT-SCN-003 | UNIT-SCN-003 paralelisme REST bootstrap dibatasi (default 3) | tests/unit/worker/scanner.test.js | LULUS | 27 |
| NEG-SCN-001 | NEG-SCN-001 error REST saat bootstrap dicatat; scanner tetap berjalan dan mencoba ulang | tests/unit/worker/scanner.test.js | LULUS | 5 |
| NEG-SCN-008 | NEG-SCN-008 error yang sama di beberapa simbol (bootstrap HTTP 500) → satu baris ingestion_errors per simbol, bukan hanya yang pertama; simbol yang sama dalam 60 d tetap di-throttle | tests/unit/worker/scanner.test.js | LULUS | 3 |
| NEG-SCN-002 | NEG-SCN-002 discovery gagal saat start → pakai simbol terpantau di DB, coba ulang dengan jeda | tests/unit/worker/scanner.test.js | LULUS | 3 |
| NEG-SCN-007 | NEG-SCN-007 pemuatan pengaturan pertama gagal (SQLITE_BUSY) → error "settings" dicatat, start tidak crash (heartbeat pasca-start tetap ditulis); siklus berikutnya berhasil → sweep berkala terjadwal dan menambal stream yang diam | tests/unit/worker/scanner.test.js | LULUS | 6 |
| EDGE-SCN-001 | EDGE-SCN-001 discovery gagal dan DB kosong → degraded tanpa stream, tidak crash | tests/unit/worker/scanner.test.js | LULUS | 2 |
| POS-SCN-002 | POS-SCN-002 candle tertutup berurutan → upsertClosed lalu onClosedCandles | tests/unit/worker/scanner.test.js | LULUS | 2 |
| UNIT-SCN-004 | UNIT-SCN-004 candle provisional → upsertProvisional (di-throttle), tanpa analisis | tests/unit/worker/scanner.test.js | LULUS | 2 |
| UNIT-SCN-005 | UNIT-SCN-005 duplikat WS tidak memicu analisis ganda | tests/unit/worker/scanner.test.js | LULUS | 1 |
| EDGE-SCN-002 | EDGE-SCN-002 event out-of-order (openTime lebih lama) tetap di-upsert tanpa analisis | tests/unit/worker/scanner.test.js | LULUS | 1 |
| UNIT-SCN-006 | UNIT-SCN-006 lompatan openTime (gap setelah reconnect) → backfill REST dulu, analisis berurutan | tests/unit/worker/scanner.test.js | LULUS | 1 |
| NEG-SCN-003 | NEG-SCN-003 backfill gap gagal → candle WS tetap disimpan, analisis ditunda lalu dipulihkan berurutan | tests/unit/worker/scanner.test.js | LULUS | 1 |
| NEG-SCN-004 | NEG-SCN-004 candle yang ditolak validasi tidak diteruskan ke analisis | tests/unit/worker/scanner.test.js | LULUS | 1 |
| NEG-SCN-005 | NEG-SCN-005 onClosedCandles yang melempar error dicatat; candle berikutnya tetap diproses | tests/unit/worker/scanner.test.js | LULUS | 1 |
| UNIT-SCN-007 | UNIT-SCN-007 event error WS dicatat (throttle) dan state degraded saat stream tidak open | tests/unit/worker/scanner.test.js | LULUS | 1 |
| UNIT-SCN-008 | UNIT-SCN-008 sweep berkala: stream tertinggal tanpa event WS di-backfill via REST | tests/unit/worker/scanner.test.js | LULUS | 12 |
| UNIT-SCN-009 | UNIT-SCN-009 reconnect stream (reconnecting → open) memicu backfill tertinggal segera | tests/unit/worker/scanner.test.js | LULUS | 4 |
| UNIT-SCN-024 | UNIT-SCN-024 socket putus 1 d sebelum close dan terbuka lagi 1,5 d sesudahnya (kline final terlewat) → candle itu diambil REST begitu margin penutupan berlalu (≈ 2 d setelah open), tidak menunggu candle berikutnya/sweep berkala; tanpa duplikat | tests/unit/worker/scanner.test.js | LULUS | 1 |
| UNIT-SCN-025 | UNIT-SCN-025 outage 2 candle, socket terbuka lagi 1 d setelah close #13, latensi REST 3 d (> margin 2 d) → sweep ulang setelah margin tetap mengantre stream yang sinkronisasi pertamanya masih berjalan: #13 dianalisis "reconnect" ≈ 7 d setelah open, bukan di sweep berkala 5 menit kemudian; tanpa duplikat | tests/unit/worker/scanner.test.js | LULUS | 2 |
| UNIT-SCN-026 | UNIT-SCN-026 start 1 d setelah batas 5m (bootstrap tidak boleh mengambil candle yang baru tutup), socket terbuka sebelum kline final berikutnya → satu sweep catch-up ≈ 2 d setelah open mengambil candle itu via REST sebagai histori (tanpa analisis, seperti bootstrap); stream mutakhir tidak menyentuh REST | tests/unit/worker/scanner.test.js | LULUS | 1 |
| UNIT-SCN-020 | UNIT-SCN-020 jam worker 300 ms di depan Binance, reconnect 100 ms setelah batas 5m dengan stream tertinggal → REST tidak meminta candle yang baru tutup, snapshot parsialnya tidak pernah tersimpan/dianalisis sebagai tertutup; candle itu masuk lewat kline final WS | tests/unit/worker/scanner.test.js | LULUS | 7 |
| UNIT-SCN-021 | UNIT-SCN-021 rencana REST (bootstrap, gap, sweep) berakhir di candle tertutup terakhir pada (clock − closeMarginMs); options.closeMarginMs 0 → tanpa margin; nilai tidak valid ditolak | tests/unit/worker/scanner.test.js | LULUS | 3 |
| UNIT-SCN-027 | UNIT-SCN-027 jam host 11 menit DI DEPAN Binance (serverClock asli → OFFSET_OUT_OF_RANGE, offset tidak diterapkan): state degraded, dan bootstrap + sweep berkala memakai closureClock = serverClock.closureNow → candle yang masih berjalan menurut server (volume 3) tidak pernah tersimpan atau dianalisis sebagai tertutup | tests/unit/worker/scanner.test.js | LULUS | 7 |
| POS-SCN-003 | POS-SCN-003 rediscovery tiap jam: simbol baru di-bootstrap, simbol delisted dihentikan | tests/unit/worker/scanner.test.js | LULUS | 16 |
| EDGE-SCN-003 | EDGE-SCN-003 simbol hilang dari exchangeInfo juga dianggap delisted; simbol keluar karena likuiditas tidak | tests/unit/worker/scanner.test.js | LULUS | 8 |
| EDGE-SCN-005 | EDGE-SCN-005 stream pengganti (rediscovery) memicu catch-up candle yang terlewat saat open | tests/unit/worker/scanner.test.js | LULUS | 7 |
| UNIT-SCN-012 | UNIT-SCN-012 liquidityOf → ukuran discovery + ambang settings.liquidity yang dipakai discovery itu; perubahan pengaturan berlaku pada rediscovery berikutnya | tests/unit/worker/scanner.test.js | LULUS | 8 |
| UNIT-SCN-014 | UNIT-SCN-014 onMonitoringStopped: delisted → SYMBOL_DELISTED, keluar seleksi → MONITORING_STOPPED (timeframes null), dipanggil setelah stream lama dihentikan | tests/unit/worker/scanner.test.js | LULUS | 12 |
| UNIT-SCN-015 | UNIT-SCN-015 timeframe dilepas dari pengaturan → MONITORING_STOPPED hanya untuk timeframe itu; simbol terpantau di DB yang hilang dari exchangeInfo saat start → SYMBOL_DELISTED; discovery gagal → tidak ada pelepasan; error callback dicatat; callback bukan fungsi ditolak | tests/unit/worker/scanner.test.js | LULUS | 15 |
| UNIT-SCN-023 | UNIT-SCN-023 HTF konteks selalu diingesti: pengaturan 5m saja → stream & bootstrap 5m+15m+1h, candle 15m/1h tersimpan tetapi hanya 5m yang dianalisis; ganti ke 15m → 5m dilepas (MONITORING_STOPPED [5m]), 15m mulai dianalisis; kembali ke 5m → 15m turun jadi konteks (MONITORING_STOPPED [15m], stream tetap) | tests/unit/worker/scanner.test.js | LULUS | 14 |
| UNIT-SCN-018 | UNIT-SCN-018 listOpenSeries (level-triggered): seri bersinyal terbuka yang tidak dipantau dilaporkan tiap discovery berhasil — timeframe di luar pengaturan → MONITORING_STOPPED [tf], TRADING tak terpilih → MONITORING_STOPPED, hilang dari exchangeInfo → SYMBOL_DELISTED; callback gagal dicoba lagi siklus berikutnya; discovery gagal → tidak ada pelepasan | tests/unit/worker/scanner.test.js | LULUS | 16 |
| UNIT-SCN-019 | UNIT-SCN-019 stop() saat setMonitored rediscovery (simbol delisted) → tidak ada pelepasan di siklus itu; scanner berikutnya di atas DB yang sama menutupnya saat start lewat listOpenSeries; listOpenSeries gagal → error "monitoring" | tests/unit/worker/scanner.test.js | LULUS | 8 |
| UNIT-SCN-016 | UNIT-SCN-016 simbol exchangeInfo yang ditolak repositori dicatat sekali per discovery: delivery saja → debug, bentuk lain → info; bukan error ingesti | tests/unit/worker/scanner.test.js | LULUS | 13 |
| NEG-SCN-009 | NEG-SCN-009 discovery memilih 0 simbol padahal 2 simbol dipantau → anomali: set pantauan, stream, likuiditas dipertahankan, tidak ada markDelisted/setMonitored/pelepasan/rekonsiliasi; error "discovery" + peringatan; percobaan ulang normal → pulih tanpa error baru | tests/unit/worker/scanner.test.js | LULUS | 7 |
| EDGE-SCN-008 | EDGE-SCN-008 siklus pertama: discovery 0 simbol dan DB memantau BTCUSDT → anomali, stream dari daftar DB tanpa pelepasan; DB kosong → 0 simbol bukan anomali (tanpa error) | tests/unit/worker/scanner.test.js | LULUS | 2 |
| EDGE-SCN-009 | EDGE-SCN-009 satu-satunya simbol terpantau (AAAUSDT) menjadi SETTLING → 0 simbol terpilih dijelaskan exchangeInfo, bukan anomali: markDelisted + SYMBOL_DELISTED, stream dilepas, setMonitored([]), tanpa error "discovery" | tests/unit/worker/scanner.test.js | LULUS | 8 |
| POS-SCN-005 | POS-SCN-005 pengaturan sah yang memilih 0 simbol (discoverSymbols asli) diterapkan, bukan anomali: (a) filter auto maxSpreadBps 0 → WIDE_SPREAD; (b) mode manual [XYZUSDT] yang tidak terdaftar → simbol lama MONITORING_STOPPED, stream dilepas, perubahan timeframe ikut diterapkan, tanpa error | tests/unit/worker/scanner.test.js | LULUS | 19 |
| NEG-SCN-010 | NEG-SCN-010 mode auto: ticker 24 jam kosong (anomali) bersamaan dengan ETHUSDT menjadi SETTLING → error "discovery", BTCUSDT & stream-nya dipertahankan, tetapi ETHUSDT tetap dilepas: markDelisted + SYMBOL_DELISTED, setMonitored([BTCUSDT]); tanpa rekonsiliasi atas hasil anomali | tests/unit/worker/scanner.test.js | LULUS | 6 |
| EDGE-SCN-004 | EDGE-SCN-004 rediscovery tanpa perubahan tidak membuat ulang stream | tests/unit/worker/scanner.test.js | LULUS | 3 |
| UNIT-SCN-010 | UNIT-SCN-010 heartbeat tiap 30 detik membawa state dan metrik | tests/unit/worker/scanner.test.js | LULUS | 1 |
| UNIT-SCN-011 | UNIT-SCN-011 stop() membersihkan semua timer, menghentikan stream, heartbeat akhir "stopped" | tests/unit/worker/scanner.test.js | LULUS | 1 |
| EDGE-SCN-006 | EDGE-SCN-006 stop() saat bootstrap berjalan menunggu tugas aktif dan tidak memulai REST baru | tests/unit/worker/scanner.test.js | LULUS | 1 |
| UNIT-SCN-013 | UNIT-SCN-013 serverClock: sync di awal setiap siklus (start & rediscovery) sebelum discovery; gagal → error ingesti "clock", scanner tetap jalan; offset di status/heartbeat | tests/unit/worker/scanner.test.js | LULUS | 12 |
| UNIT-SCN-022 | UNIT-SCN-022 serverClock OFFSET_OUT_OF_RANGE → state "degraded" + clockFault di status/heartbeat, error ingesti "clock", peringatan log; kegagalan sync lain tidak mengubah state; sync berhasil berikutnya → "running" | tests/unit/worker/scanner.test.js | LULUS | 19 |
| EDGE-SCN-007 | EDGE-SCN-007 tanpa serverClock → clockOffsetMs null; serverClock tanpa sync()/offsetMs() ditolak | tests/unit/worker/scanner.test.js | LULUS | 1 |
| UNIT-SCN-017 | UNIT-SCN-017 localClock (jam host 2 menit di depan clock/waktu server) → heartbeat at, recordRun, recordError, lastIngestionAt memakai localClock; rencana bootstrap, candleLagMs, dan stempel simbol memakai clock | tests/unit/worker/scanner.test.js | LULUS | 3 |
| NEG-SCN-006 | NEG-SCN-006 dependensi wajib tidak lengkap ditolak | tests/unit/worker/scanner.test.js | LULUS | 1 |
| POS-SCN-004 | POS-SCN-004 close → reconnect → candle terlewat di-backfill sebelum analisis, tanpa duplikat | tests/unit/worker/scanner.test.js | LULUS | 7 |

## Detail Playwright

| ID | Tes | Proyek | Status | ms |
|---|---|---|---|---|
| E2E-AUTH-001 | E2E-AUTH-001 kredensial salah menampilkan pesan generik dan tetap di halaman login | desktop | LULUS | 818 |
| E2E-AUTH-002 | E2E-AUTH-002 login valid → dashboard; cookie sesi HttpOnly tidak terbaca JavaScript | desktop | LULUS | 787 |
| E2E-NAV-001 | E2E-NAV-001 seluruh layar dapat dibuka tanpa error konsol atau pelanggaran CSP | desktop | LULUS | 1349 |
| E2E-UI-001 | E2E-UI-001 overview menampilkan angka nyata dari database (nol) dan status jujur | desktop | LULUS | 939 |
| E2E-UI-002 | E2E-UI-002 tidak ada horizontal overflow halaman di setiap layar | desktop | LULUS | 1219 |
| E2E-SET-001 | E2E-SET-001 admin menyimpan pengaturan; validasi klien menolak input tidak valid | desktop | LULUS | 1537 |
| E2E-AZ-001 | E2E-AZ-001 analyst melihat pengaturan dalam mode baca saja | desktop | LULUS | 903 |
| E2E-SEC-001 | E2E-SEC-001 data yang ditampilkan di-escape (tidak dieksekusi sebagai HTML) | desktop | LULUS | 889 |
| E2E-AUTH-003 | E2E-AUTH-003 logout mengakhiri sesi; kembali ke dashboard diarahkan ke login | desktop | LULUS | 1039 |
| E2E-AUTH-001 | E2E-AUTH-001 kredensial salah menampilkan pesan generik dan tetap di halaman login | mobile | LULUS | 759 |
| E2E-AUTH-002 | E2E-AUTH-002 login valid → dashboard; cookie sesi HttpOnly tidak terbaca JavaScript | mobile | LULUS | 771 |
| E2E-NAV-001 | E2E-NAV-001 seluruh layar dapat dibuka tanpa error konsol atau pelanggaran CSP | mobile | LULUS | 1130 |
| E2E-UI-001 | E2E-UI-001 overview menampilkan angka nyata dari database (nol) dan status jujur | mobile | LULUS | 731 |
| E2E-UI-002 | E2E-UI-002 tidak ada horizontal overflow halaman di setiap layar | mobile | LULUS | 1151 |
| E2E-SET-001 | E2E-SET-001 admin menyimpan pengaturan; validasi klien menolak input tidak valid | mobile | LULUS | 1466 |
| E2E-AZ-001 | E2E-AZ-001 analyst melihat pengaturan dalam mode baca saja | mobile | LULUS | 801 |
| E2E-SEC-001 | E2E-SEC-001 data yang ditampilkan di-escape (tidak dieksekusi sebagai HTML) | mobile | LULUS | 870 |
| E2E-AUTH-003 | E2E-AUTH-003 logout mengakhiri sesi; kembali ke dashboard diarahkan ke login | mobile | LULUS | 1375 |
| E2E-SEC-002 | E2E-SEC-002 polling /api/ready tidak mengirim cookie sesi (tidak memperpanjang idle timeout) | desktop | LULUS | 351 |
| E2E-NAV-002 | E2E-NAV-002 view lambat yang selesai setelah navigasi baru dibuang beserta timer-nya | desktop | LULUS | 619 |
| E2E-NAV-003 | E2E-NAV-003 view yang gagal dimuat menampilkan pesan error, bukan halaman lama | desktop | LULUS | 376 |
| E2E-NAV-004 | E2E-NAV-004 skip link memindahkan fokus ke konten tanpa berpindah route | desktop | LULUS | 494 |
| E2E-UI-003 | E2E-UI-003 laci navigasi mobile: tertutup tidak dapat difokus; buka/tutup mengatur fokus & aria-expanded | desktop | LULUS | 416 |
| E2E-UI-004 | E2E-UI-004 mode warna paksa: fokus keyboard tetap terlihat lewat outline | desktop | LULUS | 463 |
| E2E-SET-002 | E2E-SET-002 field angka yang dikosongkan ditolak, tidak tersimpan sebagai 0 | desktop | LULUS | 970 |
| E2E-AUTH-005 | E2E-AUTH-005 logout yang gagal menampilkan pesan dan tetap di aplikasi | desktop | LULUS | 508 |
| E2E-AUTH-004 | E2E-AUTH-004 logout dengan token CSRF basi mengambil ulang token lalu benar-benar keluar | desktop | LULUS | 648 |
| E2E-SEC-002 | E2E-SEC-002 polling /api/ready tidak mengirim cookie sesi (tidak memperpanjang idle timeout) | mobile | LULUS | 330 |
| E2E-NAV-002 | E2E-NAV-002 view lambat yang selesai setelah navigasi baru dibuang beserta timer-nya | mobile | LULUS | 525 |
| E2E-NAV-003 | E2E-NAV-003 view yang gagal dimuat menampilkan pesan error, bukan halaman lama | mobile | LULUS | 396 |
| E2E-NAV-004 | E2E-NAV-004 skip link memindahkan fokus ke konten tanpa berpindah route | mobile | LULUS | 553 |
| E2E-UI-003 | E2E-UI-003 laci navigasi mobile: tertutup tidak dapat difokus; buka/tutup mengatur fokus & aria-expanded | mobile | LULUS | 582 |
| E2E-UI-004 | E2E-UI-004 mode warna paksa: fokus keyboard tetap terlihat lewat outline | mobile | LULUS | 424 |
| E2E-SET-002 | E2E-SET-002 field angka yang dikosongkan ditolak, tidak tersimpan sebagai 0 | mobile | LULUS | 1603 |
| E2E-AUTH-005 | E2E-AUTH-005 logout yang gagal menampilkan pesan dan tetap di aplikasi | mobile | LULUS | 961 |
| E2E-AUTH-004 | E2E-AUTH-004 logout dengan token CSRF basi mengambil ulang token lalu benar-benar keluar | mobile | LULUS | 1032 |
| E2E-SUP-001 | E2E-SUP-001 admin menjalankan scanner dari System Health, membatalkan lalu mengonfirmasi penghentian | desktop | LULUS | 5558 |
| E2E-SUP-002 | E2E-SUP-002 analyst melihat state scanner tanpa tombol kontrol (System Health & Overview) | desktop | LULUS | 1567 |
| E2E-SUP-003 | E2E-SUP-003 admin menjalankan scanner dari callout Overview | desktop | LULUS | 4718 |
| E2E-SUP-004 | E2E-SUP-004 tombol nonaktif selama request; penolakan server (worker di luar website) tampil sebagai alert | desktop | LULUS | 1745 |
| E2E-SUP-001 | E2E-SUP-001 admin menjalankan scanner dari System Health, membatalkan lalu mengonfirmasi penghentian | mobile | LULUS | 4966 |
| E2E-SUP-002 | E2E-SUP-002 analyst melihat state scanner tanpa tombol kontrol (System Health & Overview) | mobile | LULUS | 800 |
| E2E-SUP-003 | E2E-SUP-003 admin menjalankan scanner dari callout Overview | mobile | LULUS | 4315 |
| E2E-SUP-004 | E2E-SUP-004 tombol nonaktif selama request; penolakan server (worker di luar website) tampil sebagai alert | mobile | LULUS | 1234 |
| E2E-SIG-001 | E2E-SIG-001 screener menampilkan sinyal dari API; filter server bekerja | desktop | LULUS | 1523 |
| E2E-SIG-004 | E2E-SIG-004 filter alignment screener dikirim ke server bersama limit=500, bukan disaring di klien | desktop | LULUS | 1471 |
| E2E-SIG-005 | E2E-SIG-005 respons tepat 500 baris (= limit, tanpa total dari API) → "≥ 500 hasil" & "mungkin terpotong", tidak mengklaim ada sisa | desktop | LULUS | 2242 |
| E2E-SIG-006 | E2E-SIG-006 batas: respons 499 baris (< limit 500) → "499 hasil" tanpa callout batas tercapai | desktop | LULUS | 2401 |
| E2E-SIG-002 | E2E-SIG-002 Signal History menampilkan sinyal dengan tahap & harga deteksi | desktop | LULUS | 1345 |
| E2E-SIG-003 | E2E-SIG-003 System Health menampilkan heartbeat worker & error ingesti dari database | desktop | LULUS | 1403 |
| E2E-SIG-001 | E2E-SIG-001 screener menampilkan sinyal dari API; filter server bekerja | mobile | LULUS | 1429 |
| E2E-SIG-004 | E2E-SIG-004 filter alignment screener dikirim ke server bersama limit=500, bukan disaring di klien | mobile | LULUS | 1404 |
| E2E-SIG-005 | E2E-SIG-005 respons tepat 500 baris (= limit, tanpa total dari API) → "≥ 500 hasil" & "mungkin terpotong", tidak mengklaim ada sisa | mobile | LULUS | 2049 |
| E2E-SIG-006 | E2E-SIG-006 batas: respons 499 baris (< limit 500) → "499 hasil" tanpa callout batas tercapai | mobile | LULUS | 2082 |
| E2E-SIG-002 | E2E-SIG-002 Signal History menampilkan sinyal dengan tahap & harga deteksi | mobile | LULUS | 1277 |
| E2E-SIG-003 | E2E-SIG-003 System Health menampilkan heartbeat worker & error ingesti dari database | mobile | LULUS | 1235 |
