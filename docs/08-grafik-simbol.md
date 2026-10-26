# 08 — Grafik Simbol: Side Panel Scanner & Symbol Intelligence

Permintaan pemilik: setiap koin di daftar scanner dapat diklik untuk menampilkan grafik — di sebelah tabel, dan di
halaman detail tersendiri. Keduanya dibangun di atas satu komponen grafik. Semua data berasal dari candle **tertutup**
di database; tanpa candle, UI menampilkan empty state (tidak ada data contoh). Skor yang tampil adalah kecocokan dengan
aturan pola, **bukan probabilitas profit**. AlphaLens tetap alat riset — tidak ada eksekusi order.

| Bagian | Berkas |
|---|---|
| Endpoint candle | `backend/api/marketRoutes.js` (didaftarkan di `backend/app/buildApp.js`) |
| File vendor library | `GET /vendor/lightweight-charts.js` (`backend/app/buildApp.js`) |
| Pembungkus grafik | `frontend/js/lib/chart.js` |
| Panel grafik + helper side panel | `frontend/js/views/symbolChart.js` |
| Side panel terpasang di tabel kandidat | `frontend/js/views/screener.js` (`scannerPage`: LONG Scanner route `/screener`, SHORT Scanner route `/short-scanner`) |
| Halaman detail | `frontend/js/views/symbol.js` (route `/symbol`, label "Symbol Intelligence") |
| Seleksi baris tabel | `frontend/js/lib/components.js` (`dataTable` opsi `onRowSelect`, `refreshRowSelection`) |
| Query hash | `frontend/js/lib/router.js` (`splitHash`, `hashQuery`) |
| Gaya | `frontend/css/components.css` (bagian "Grafik simbol") |
| Lisensi pihak ketiga | `THIRD_PARTY_NOTICES.md` |

## 1. Endpoint `GET /api/market/candles`

Terautentikasi seperti semua route `/api/*` (tanpa sesi → 401, gerbang dipasang otomatis oleh `registerAuth`), baca saja,
`Cache-Control: no-store`, dihitung rate limit API.

| Parameter | Wajib | Aturan (AJV, tanpa koersi) |
|---|---|---|
| `symbol` | ya | string `^[A-Z0-9]{2,30}$` |
| `timeframe` | ya | `5m`, `15m`, atau `1h` (`TIMEFRAMES` di `backend/market/contracts.js`) |
| `limit` | tidak | string `^([1-9][0-9]{0,2}\|1000)$` → 1..1000, default 300 |

Parameter lain, `limit` di luar rentang, atau format salah → `400 VALIDATION_ERROR` (tidak dipotong diam-diam).

Respons `200`:

```json
{
  "symbol": "BTCUSDT",
  "timeframe": "15m",
  "items": [{ "openTime": 1793000700000, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1 }],
  "count": 1
}
```

- Hanya candle tertutup (`candleRepository.getLatest` membaca tabel `candles`; candle provisional tidak pernah ikut).
- `items` urut naik menurut `openTime` (epoch ms UTC), `limit` candle terakhir.
- Simbol yang tidak dikenal / belum pernah diingesti → `200` dengan `items: []`, `count: 0` (bukan error, tidak
  membocorkan apakah simbol terdaftar).

## 2. Library grafik pihak ketiga

- **TradingView Lightweight Charts™ 5.2.1** (Apache-2.0, © TradingView, Inc.), sesuai rencana di
  `docs/03-rencana-implementasi.md` (M4) dan `docs/06-evaluasi-dependensi.md`. Dipin eksak
  (`npm install --save-exact --ignore-scripts lightweight-charts@5.2.1`); versi 5.2.1 dirilis 2026-08-12.
  Dependensi transitif: `fancy-canvas` 2.1.0 (MIT).
- **Penyajian:** hanya `node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js` di path tetap
  `GET /vendor/lightweight-charts.js` lewat `reply.sendFile` @fastify/static — satu berkas, tanpa directory listing,
  tipe konten & `Cache-Control` sama dengan aset JS lain. Publik seperti aset statis lain (kode open-source tanpa data).
- **Pemuatan malas:** `loadChartLibrary()` menyisipkan satu `<script src="/vendor/lightweight-charts.js">` saat grafik
  pertama dibuat dan menunggu event `load`. `login.html`, Overview, dan halaman lain tanpa grafik tidak memuatnya.
  Gagal dimuat → panel menampilkan error dengan tombol "Coba lagi".
- **Atribusi (syarat lisensi):** opsi `layout.attributionLogo: true` dibiarkan aktif (logo + tautan ke
  tradingview.com di pojok kiri bawah grafik) dan footer setiap panel grafik menampilkan
  "Grafik: TradingView Lightweight Charts™ © TradingView, Inc.". Teks lisensi lengkap: `THIRD_PARTY_NOTICES.md`.
  Catatan privasi: tautan logo milik library menambahkan `utm_source=<hostname+path>` — hanya terkirim bila pengguna
  mengklik logo tersebut.

### CSP (`backend/security/headers.js`) — diperiksa statis

| Kebutuhan library | Status di CSP saat ini |
|---|---|
| Script dari `/vendor/lightweight-charts.js` | Lolos `script-src 'self'` (same-origin, file statis) |
| Tanpa `eval` / `new Function` / worker / fetch | Tidak ditemukan di build standalone 5.2.1 |
| Gaya lewat CSSOM (`element.style.x = …`) | Diizinkan CSP (bukan atribut `style` inline) |
| Kanvas & SVG logo statis (`innerHTML` konstanta milik library) | Tidak terkena CSP |
| **`<style>` inline untuk posisi logo atribusi** | **Diblokir `style-src 'self'`** |

Temuan: saat grafik dibuat, library menyisipkan elemen `<style>` berisi aturan posisi logo atribusi
(`a#tv-attr-logo{…}`). CSP **tidak dilonggarkan**; akibatnya browser mencatat satu pelanggaran CSP di konsol
("Refused to apply inline style…") untuk setiap grafik yang dibuat. Aturan yang sama disalin ke `components.css`
sehingga logo tetap tampil dan terposisi benar. Halaman tanpa grafik (termasuk `#/symbol` tanpa simbol, yang dikunjungi
E2E-NAV-001) tidak memuat library sehingga tidak terdampak. Pilihan bagi pemilik bila pesan konsol ini tidak diinginkan:

1. Tetap seperti sekarang (CSP paling ketat; satu pesan konsol per grafik).
2. Menambah hash persis teks gaya library 5.2.1 ke `style-src`:
   `'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='` — pelonggaran sempit (hanya teks itu), tetapi harus dihitung
   ulang setiap upgrade library. Belum diterapkan; memerlukan keputusan pemilik.
3. `attributionLogo: false` + tautan atribusi buatan sendiri ke tradingview.com di panel (README library menyatakan
   tautan di halaman memenuhi syarat). Belum diterapkan karena instruksi saat ini meminta logo bawaan tetap aktif.

## 3. Komponen grafik — `frontend/js/lib/chart.js`

```js
import { createCandleChart } from '../lib/chart.js';

const chart = await createCandleChart(container, {
  candles,            // item dari /api/market/candles (epoch ms UTC)
  timeframe: '15m',   // dipakai untuk membulatkan waktu penanda
  symbol: 'BTCUSDT',  // untuk aria-label
  levels: [{ price: 61250, kind: 'invalidation' }, { price: 62000, kind: 'detected' }],
  markers: [{ time: 1793000700000, kind: 'BREAKOUT' }],
});
chart.setCandles(nextCandles);
chart.setLevels(levels);
chart.setMarkers(markers);
chart.destroy(); // juga otomatis saat container dilepas dari DOM
```

- Isi `container` diganti: kanvas (`.chart__canvas`, `role="figure"`, `aria-label` = simbol, timeframe, jumlah candle,
  close terakhir + waktunya), legenda (EMA7, EMA25, Volume, "Waktu UTC"), dan ringkasan teks tersembunyi visual
  (`.sr-only`) berisi OHLCV candle terakhir, nilai EMA terakhir, dan daftar level. Bukan `role="img"`: library memasang
  tautan logo atribusi yang dapat difokus di dalam kanvas, sedangkan anak `role="img"` presentasional (kontrol
  interaktif bersarang); `figure` boleh memuat tautan itu.
- Seri: candlestick (warna `--lr-bull` / `--lr-bear`), histogram volume di skala harga sendiri (`priceScaleId: 'volume'`,
  20% bawah), garis EMA7 (`--lr-accent`) dan EMA25 (`--lr-warn`). Harga diformat `formatPrice` (presisi adaptif, id-ID).
- EMA dihitung di browser oleh `ema(values, period)` — port setia `backend/indicators/ema.js` (alpha `2/(p+1)`, seed
  SMA, `null` selama warm-up, `TypeError` untuk nilai tidak valid). Diekspor agar dapat diuji setara dengan backend.
- Level (`levels[].kind`): `invalidation` → "Invalidasi" (bear), `detected` → "Deteksi pertama" (netral),
  `support` → "Support" (bull), `resistance` → "Resistance" (warn); `label` boleh diganti; harga ≤ 0/tidak valid diabaikan.
- Penanda (`markers[].kind`): `DETECTED`, `QUIET`, `EARLY_BULLISH`, `MOMENTUM_BUILDING`, `BREAKOUT`, `EARLY_BEARISH`,
  `BREAKDOWN`, `INVALIDATED`, `EXPIRED`; kode lain tampil sebagai lingkaran netral berlabel kode itu. Waktu dibulatkan ke
  candle timeframe grafik yang memuatnya; di luar rentang candle diabaikan.
- Waktu dikirim ke library sebagai detik UTC; sumbu waktu tampil dalam UTC.
- Tema: semua warna dibaca dari token CSS lewat `getComputedStyle` pada container (token kosong/tidak valid → nilai
  cadangan), dibaca ulang saat `prefers-contrast` berubah. Ukuran mengikuti CSS via `ResizeObserver`.
- Gerak: kinetic scroll sentuh dimatikan bila `prefers-reduced-motion: reduce`; geser vertikal di layar sentuh tetap
  menggulir halaman.
- Kebocoran: `onDisconnect(el, cb)` (satu `MutationObserver` bersama) memanggil `destroy()` ketika container yang
  pernah terpasang dilepas dari DOM — navigasi hash tidak meninggalkan grafik, `ResizeObserver`, atau listener.
- Ekspor lain: `loadChartLibrary()`, `normalizeCandles()`, `normalizeLevels()`, `LEVEL_KINDS`, `EMA_PERIODS`,
  `CHART_VENDOR_SRC`.

## 4. Panel grafik — `frontend/js/views/symbolChart.js`

`symbolChartPanel({ symbol, timeframe, direction, signal })` → elemen panel. Versi lengkap
`createSymbolChartPanel(options)` → `{ el, close, destroy, timeframe }`.

| Opsi | Keterangan |
|---|---|
| `symbol` | wajib, `^[A-Z0-9]{2,30}$` (selain itu `RangeError`) |
| `timeframe` | `5m`/`15m`/`1h`; default timeframe sinyal, lalu `15m` |
| `direction` | `LONG`/`SHORT`; tidak ada / tak dikenal = `LONG` |
| `signal` | baris sinyal (API `active`/`history`); menampilkan arah, pola, tahap, Pattern/Early Score, alignment, level invalidasi, harga & waktu deteksi, risk flag. Kode klasifikasi/state baru (mis. SD/PVD, EARLY_BEARISH, BREAKDOWN) tampil apa adanya |
| `levels` | default dari `signal` (invalidasi + harga deteksi pertama) |
| `markers` | array atau `(timeframe) => array` |
| `variant` | `side` (grafik 360px) / `detail` (480px); layar ≤ 820px: 300px / 360px |
| `detailLink` | default `true`: tombol "Buka detail" → `#/symbol?s=…&tf=…&dir=…` |
| `onClose` | bila ada: tombol tutup + tombol Esc; juga memancarkan event DOM `symbolchart:close` (bubbles) |
| `onTimeframeChange` | dipanggil saat pemilih timeframe berubah |

Judul `"<SYMBOL> · <TF>"`, pemilih timeframe (segmented 5m/15m/1h), tombol muat ulang. State: loading (kerangka setinggi
grafik, `aria-busy`), error (`role="alert"` + "Coba lagi"), empty ("Belum ada candle tertutup untuk simbol ini"), siap.

## 5. Side panel untuk tabel — `attachChartSidePanel`

```js
const chartSide = attachChartSidePanel({ layoutHost, direction: 'LONG', onSelect, onClose });
// → { el, tableOptions: { onRowSelect, isRowSelected }, select(row), close(), isSelected(row), cleanup() }
```

- `layoutHost` = elemen yang memuat tabel (isinya boleh diganti setiap reload). Helper membungkusnya dalam
  `div.chart-split` (`el`); bila `layoutHost` sudah terpasang, posisinya diambil alih `el`.
- Layar lebar: tabel kiri, panel kanan (`minmax(360px, 40%)`, sticky di bawah topbar). Layar ≤ 1100px: panel ditumpuk di
  bawah tabel, digulir ke tampilan (`behavior: auto` bila reduced motion) dan menerima fokus.
- Baris terpilih: `aria-current="true"` + `data-selected` (dihitung dari `symbol|timeframe|direction`, sehingga tetap
  tertandai setelah tabel dibuat ulang oleh filter/refresh). Mode warna paksa (High Contrast) menandainya dengan garis
  kiri `Highlight` karena latar & box-shadow dibuang. Tutup (tombol, Esc di panel, atau Esc pada baris tabel) → panel
  dihapus, grafik dihancurkan, tanda baris dibersihkan; fokus yang berada di panel kembali ke baris.
- Tabel hanya satu tab stop (lihat di bawah), jadi di layar lebar Tab dari baris langsung masuk ke kontrol panel.
- `toTarget(row, direction)` opsional untuk baris berbentuk lain (default: `row.symbol`, `row.timeframe`,
  `row.direction ?? direction`, `signal: row`).

### `dataTable` — opsi tambahan (opsional, aditif)

- `onRowSelect(row)`: kursor pointer, klik / Enter / Spasi memilih, `aria-current="true"` + `data-selected` pada baris
  terpilih (`aria-selected` tidak dipakai: tabel biasa, bukan grid, tidak mengumumkannya secara andal). Roving tabindex:
  satu baris `tabindex=0` (baris terfokus → terpilih → pertama), sisanya `-1`; panah atas/bawah, Home/End memindahkan
  fokus antarbaris tanpa memilih. Klik pada tautan/tombol di dalam sel tidak memilih baris.
- `isRowSelected(row)`: status terpilih ditentukan pemanggil (dipakai side panel). Tanpa itu seleksi per tabel.
- `refreshRowSelection(scope)`: menggambar ulang tanda seleksi semua tabel ber-`onRowSelect` di dalam `scope`.
- Tanpa `onRowSelect`, keluaran tabel identik dengan sebelumnya (tidak ada atribut baru).

### Cara screener memasangnya (satu hook)

`screener.js` sudah memasangnya untuk LONG Scanner (`/screener`) dan SHORT Scanner (`/short-scanner`) lewat
`scannerPage(ctx, direction)`: klik / Enter pada baris kandidat membuka grafik koin di sebelah tabel, dengan tombol
"Buka detail" ke `#/symbol`. Halaman lain yang menampilkan tabel kandidat cukup memanggil `attachChartSidePanel` sekali
per halaman dengan arahnya, lalu menyebarkan `tableOptions` ke setiap `dataTable` yang dibuat:

```js
import { attachChartSidePanel } from './symbolChart.js';

async function scannerPage(ctx, direction) { // 'LONG' (route /screener) atau 'SHORT' (route /short-scanner)
  const host = h('div', { 'data-testid': 'screener-results' });
  const chartSide = attachChartSidePanel({ layoutHost: host, direction });

  async function load() {
    // ...
    const table = dataTable({ columns, rows, caption, initialSort, empty, ...chartSide.tableOptions });
    host.replaceChildren(table);
  }
  // ...
  return {
    el: page({ ... }, panel({ title: 'Kandidat', flush: true, ... }, filters, chartSide.el)), // el menggantikan host
    cleanup: () => chartSide.cleanup(), // gabungkan dengan cleanup lain (timer auto-refresh, dll.)
  };
}
```

Baris memakai `row.direction` bila ada (field baru dari backend); bila tidak ada, `direction` halaman dipakai.

## 6. Halaman detail — `#/symbol`

URL: `#/symbol?s=BTCUSDT&tf=15m&dir=LONG&signal=12` (`tf`, `dir`, `signal` opsional). Router mencocokkan route tanpa
query (`splitHash`); view membaca query lewat `hashQuery()`. Semua nilai divalidasi: simbol dinormalisasi ke kapital lalu
dicek `^[A-Z0-9]{2,30}$`, `tf` ∈ {5m, 15m, 1h}, `dir` ∈ {LONG, SHORT}, `signal` angka.

- **Tanpa simbol:** empty state "Pilih koin terlebih dahulu" dengan tombol ke LONG Scanner (`#/screener`) dan SHORT
  Scanner (`#/short-scanner`); simbol tidak valid di URL → callout peringatan. Library grafik tidak dimuat.
- **Form cari:** input simbol (`role="search"`, saran dari simbol yang pernah punya sinyal), validasi klien yang sama.
  Pencarian baru selalu ke `#/symbol?s=<SIMBOL>` saja — `dir`/`tf`/`signal` halaman sebelumnya tidak ikut terbawa.
- **Grafik besar** (480px) memakai panel di atas, dengan level dari sinyal fokus dan penanda transisi sinyal searah pada
  timeframe yang tampil. Ganti timeframe memperbarui URL (`history.replaceState`) tanpa render ulang.
- **Sinyal fokus:** `signal` dari URL → sinyal terbaru arah & timeframe yang diminta → sinyal terbaru arah yang diminta.
  Panel "Sinyal dipilih" (hanya bila `signal` dari URL ditemukan) atau "Sinyal terakhir", "Penjelasan kondisi", dan
  "Transisi tahap" (timeline event). `signal` yang tidak ada di riwayat termuat → callout peringatan, fokus jatuh ke
  sinyal terakhir. `dir` hanya menyaring sinyal fokus (tabel riwayat tetap memuat semua arah); bila arah itu tidak punya
  sinyal, pesan kosong menyebut arahnya ("Belum ada sinyal SHORT untuk simbol ini; …").
- **Penjelasan kondisi:** faktor `explanation` dari API. Poin (`+`/`−`) hanya untuk `PATTERN:<pola>:<kondisi>` — jumlahnya
  membentuk Pattern Score, termasuk `RESIDUAL` (selisih/penalti detektor, bisa negatif). `EARLY:*` membawa Early Score
  utuh (skor terpisah), jadi tampil sebagai "Early Score N", bukan poin. `PATTERN:SELECTION`, `CONTEXT:*`, `RISK:*`
  informatif tanpa angka.
- **Riwayat sinyal** (`GET /api/signals/history?symbol=…&limit=100`, tanpa parameter `direction` sehingga kompatibel
  sebelum/sesudah backend arah): badge arah, TF, pola, harga deteksi, invalidasi, tahap, jalur transisi. Klik baris →
  sinyal itu menjadi fokus (URL `signal=`). Gagal memuat riwayat tidak menggagalkan grafik.

## 7. Pengujian

Sesuai arahan pemilik, pengujian dilakukan sendiri oleh pemilik; perubahan ini hanya diverifikasi dengan `npm run lint`.
Tidak ada tes baru yang ditambahkan dan tidak ada tes yang dijalankan. Area yang disarankan untuk diuji: validasi
`/api/market/candles` (tanpa sesi 401, parameter salah 400, simbol tak dikenal `items: []`, urutan naik, `limit`),
`GET /vendor/lightweight-charts.js` (200, tipe JavaScript, path lain di `/vendor/` 404), kesetaraan `ema()` klien dengan
backend, `dataTable` tanpa `onRowSelect` tetap identik, router `splitHash`, serta E2E side panel di `#/screener`
(klik/Enter baris, panah/Home/End antarbaris, Tab dari baris ke panel, tutup/Esc di panel maupun di baris, fokus
kembali, mode warna paksa) dan halaman detail (`signal` tidak ditemukan, `dir` tanpa sinyal, poin penjelasan negatif /
Early Score) di viewport desktop & mobile.
