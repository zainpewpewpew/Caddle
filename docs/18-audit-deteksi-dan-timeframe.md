# 18 — Audit deteksi LONG/SHORT & timeframe tetap per arah (2026-10-26)

Latar: pengguna mencocokkan sinyal live dengan chart Binance dan menilai deteksinya "ngaco". Audit dilakukan
pada empat area dengan tes reproduksi atas candle SINTETIS (tests/unit/audit/*). Data Binance live tidak dapat
diakses dari lingkungan pengembangan (HTTP 451/403), jadi verifikasi live dilakukan pengguna di Mac.

## 1. Timeframe tetap per arah

| Arah | Timeframe | Konteks HTF |
|------|-----------|-------------|
| LONG Scanner | 15m | 1h |
| SHORT Scanner | 1h | tidak ada (alignment selalu UNCONFIRMED, komponen HTF konfluensi dikeluarkan dari penyebut) |

- Sumber: `DIRECTION_TIMEFRAMES` di `backend/market/contracts.js`.
- Worker hanya mengingesti 15m + 1h (5m tidak lagi diambil) dan hanya mengevaluasi arah pada timeframe-nya
  (`createAnalysisPipeline({ directionTimeframes })`). Pengaturan `timeframes` lama diabaikan.
- Sinyal terbuka lama (LONG 5m/1h, SHORT 5m/15m) ditutup `EXPIRED` dengan reason `MONITORING_STOPPED`.
- `GET /api/signals/active` hanya mengembalikan timeframe arah yang diminta; timeframe lain → daftar kosong.
- UI: filter timeframe di LONG/SHORT Scanner diganti label tetap; Pengaturan menampilkan "LONG 15m / SHORT 1h".

## 2. Waktu tampil WIB

Semua waktu di UI (tabel, grafik, ringkasan) kini ditampilkan dalam WIB (UTC+7), bukan UTC. Sebelumnya tampilan UTC
berselisih 7 jam dengan jam di aplikasi Binance. Catatan: "Deteksi pertama" = waktu **tutup** candle (closeTime),
sedangkan label candle di Binance = waktu **buka**. Sinyal 15m dengan deteksi 17:14:59 WIB = candle Binance 17:00.

## 3. Hasil audit

| # | Temuan | Jenis | Perbaikan |
|---|--------|-------|-----------|
| 1 | Struktur higher-low dianggap utuh walau wick 1–2 candle terakhir sudah menembus swing low (lower low belum terkonfirmasi) → sinyal terbit dengan level invalidasi yang sudah tertembus | BUG | `analyzeStructure`: struktur patah bila ada low sesudah swing low di bawahnya |
| 2 | Resistance/support BREAKOUT/BREAKDOWN = swing terkonfirmasi terakhir yang bisa sudah lama tertembus → candle merah ber-RVOL tinggi bisa jadi BREAKOUT (SHORT: candle hijau jadi BREAKDOWN) | BUG | Level berjalan (`runningLevel`): swing high dinaikkan ke high tertinggi sesudahnya (support: low terendah) |
| 3 | Replay setelah backfill: candle 15m dievaluasi sebelum backfill 1h tersimpan → konteks 1h `STALE_DATA`, alignment salah tersimpan permanen | BUG | `settleHigherTimeframes` menunggu sekali bila candle HTF yang seharusnya sudah tutup belum ada |
| 4 | SA terdeteksi saat EMA25 masih turun (pantulan pendek di tengah downtrend) karena kondisi EMA25 hanya opsional | Kelemahan aturan | SA (dan SD cermin) mewajibkan EMA25 datar/naik (SD: datar/turun) |
| 5 | SHORT 1h tidak pernah bisa tier A (syarat alignment HTF mustahil tanpa HTF) | Kelemahan aturan | Tanpa komponen HTF, syarat alignment tier A tidak berlaku |
| – | Indikator (EMA, ATR Wilder, RVOL, swing fraktal, slope), cermin SHORT, fitur v3 (ADX, CVD, dsb.), konfluensi, parsing kline, kursor evaluasi, aturan "Basi" | Benar | Dikunci dengan tes |

Versi metodologi naik: `PATTERN_VERSION` 2 → 3 (SA/PVA), `SHORT_PATTERN_VERSION` 1 → 2 (SD/PVD). Sinyal lama tetap
merujuk versinya; sinyal baru memakai v3/v2.

## 4. Kelemahan desain yang tersisa (belum diubah)

- PVA tidak punya syarat tren (EMA25); "harga naik 20 candle + higher low" cukup.
- MOMENTUM_BUILDING via RVOL hanya butuh RVOL ≥ 1,5 dan close di atas harga deteksi (candle merah bisa memicu).
- Kolom "Harga" = close candle tertutup terakhir; di 1h bisa tertinggal hingga 1 jam dari harga live.
- Seri baru: evaluasi pertama hanya candle terakhir, sehingga "deteksi pertama" = candle terbaru, bukan awal pola di chart.
- SHORT 1h tanpa konteks timeframe lebih tinggi (mis. 4h); veto COUNTERTREND tidak mungkin terjadi.
- Semua ambang tetap hipotesis awal; wajib divalidasi `npm run backtest` dengan data nyata.
