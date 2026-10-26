# 10 — Riset Open-Source untuk UI "Neural Aurora"

Tanggal riset: 2026-10-26. Pertanyaan pemilik: *apakah ada proyek open-source (GitHub) yang bisa menambah
referensi/kemampuan website AlphaLens; bila ada, analisis dulu lalu implementasi.*

**Kesimpulan singkat:** tidak ada paket yang lolos kriteria ADOPSI saat ini. Kebutuhan inti (latar jaringan saraf
animasi, count-up angka, konstelasi pasar) sudah dipenuhi oleh kode sendiri tanpa dependensi
(`frontend/js/lib/neural.js`, `animateNumber()` di `frontend/js/lib/components.js`, `frontend/js/views/constellation.js`)
yang lebih kecil, patuh CSP ketat, dan memuat perilaku khusus (pulsa sinaps dari peristiwa nyata `lr:activity`) yang
tidak dimiliki library mana pun. Beberapa proyek dijadikan **referensi pola desain** saja (tanpa menyalin kode).

## 1. Metodologi & sumber data

| Aspek | Cara diperiksa |
|---|---|
| Versi, lisensi, dependensi, tanggal rilis | `npm view <paket> version license dependencies time --json` (registry npm, 2026-10-26) |
| Ukuran | Tarball diunduh dengan `npm pack --ignore-scripts` ke scratchpad (tidak dipasang ke proyek), file build diukur `wc -c` (raw) dan `gzip -9` |
| Kepatuhan CSP | `grep` pada file build: `eval(`, `new Function(`, `createElement("style")`, `setAttribute("style")`, `.cssText`, `insertRule`, `innerHTML`, `fetch(` |
| Keamanan | Endpoint advisori npm `POST /-/npm/v1/security/advisories/bulk` (dasar `npm audit`); divalidasi dulu dengan `lodash@4.17.15` (mengembalikan 6 advisori) |
| Aktivitas repo / lisensi proyek non-npm | Pencarian web (github.com & api.github.com **diblokir** proxy di lingkungan ini; jsDelivr/unpkg juga 403) |

Paket yang gagal diunduh dalam batas waktu (registry lambat): `animejs` dan `@tsparticles/engine` (engine sudah
termasuk di bundle `@tsparticles/slim`) — nilai anime.js diberi tanda *(perkiraan)* dan tidak dijadikan dasar keputusan.

### Syarat teknis dari proyek (dibaca dari kode, tidak diubah)

- CSP (`backend/security/headers.js`): `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'`,
  **tanpa** `'unsafe-inline'`/`'unsafe-eval'`. Artinya:
  - `eval`/`new Function` → diblokir.
  - Elemen `<style>` yang disisipkan JS dan `setAttribute('style', …)` / `el.style.cssText = …` → diblokir
    (style-src tanpa `'unsafe-inline'`). `el.style.prop = …` / `el.style.setProperty()` → **diizinkan**.
  - Import map inline (untuk bare specifier seperti `import 'd3-quadtree'`) → diblokir. Jadi library ESM yang
    terpecah menjadi banyak paket dengan bare import **tidak bisa** dipakai tanpa bundler.
- Pola vendor (`backend/app/buildApp.js`): satu file build dari `node_modules/<paket>/dist` disajikan lewat route tetap
  `GET /vendor/lightweight-charts.js` (`reply.sendFile`, `config.public`, 503 bila paket belum terpasang). Library baru
  hanya layak bila punya **satu file build mandiri** (ESM atau IIFE) yang bisa disajikan dengan pola yang sama.
- Kebijakan dependensi (`docs/06-evaluasi-dependensi.md`): sesedikit mungkin, permisif, `--save-exact`, dan versi yang
  sudah beredar cukup lama (lightweight-charts dipasang >2 bulan setelah rilis). Versi yang dirilis < 14 hari dianggap
  belum matang untuk dipin.
- Lisensi proyek `UNLICENSED` (privat, dipakai sendiri). MIT/ISC/Apache-2.0/Unlicense kompatibel. LGPL/GPL/AGPL
  tidak cocok untuk disertakan; aman hanya sebagai referensi visual (tanpa menyalin kode).

## 2. Latar animasi jaringan / partikel

| Kandidat | Versi (rilis) | Lisensi | Ukuran build | Format tanpa bundler | CSP `'self'` | Advisori | Keputusan |
|---|---|---|---|---|---|---|---|
| tsParticles (`@tsparticles/slim`) | 4.5.0 (2026-10-25, 1 hari) | MIT | `tsparticles.slim.bundle.min.js` 161,7 KB / **45,8 KB gz** | IIFE global (bukan ESM); bisa via `/vendor` | Tidak ada eval/`<style>`; memakai `style.setProperty` (boleh); punya `fetch()` untuk preset/SVG (tak terpakai bila konfigurasi lokal) | 0 | **TOLAK** |
| particles.js | 2.0.0 (2015-05) | MIT | `particles.js` 43,0 KB / 9,0 KB gz (tanpa min) | Global script | Tanpa eval; memuat konfigurasi lewat `XMLHttpRequest` | 0 | **TOLAK** (tak dirilis sejak 2015) |
| Vanta.js (`vanta`, efek NET) | 0.5.24 (2022-09) | MIT | `vanta.net.min.js` 13,2 KB / 4,5 KB gz **+ three.js** | Butuh `THREE` global | — | 0 | **TOLAK** |
| three.js | 0.186.1 (2026-09-24) | MIT | `three.module.js` 130,7 KB gz **+ `three.core.js` 286,4 KB gz** | ESM 2 file (import relatif, bisa) | OK | 0 (historis: ReDoS `<0.125.0`) | **TOLAK** |
| OGL | 1.0.11 (2025-01) | Unlicense | sumber ESM 496 KB, banyak file | ESM multi-file relatif | OK | 0 | **TOLAK** |
| Pts.js (`pts`) | 1.0.3 (2026-10-16) | Apache-2.0 | paket 7 MB, `dist/index.mjs` | ESM | Tidak dianalisis penuh | 0 | **REFERENSI** (contoh "connected points") |
| p5.js | 2.3.4 (2026-09-25) | **LGPL-2.1** | paket 17 MB, build ±1 MB | Global | — | 0 | **TOLAK** (lisensi & ukuran) |
| sketch.js (`sketch-js`) | 1.1.3 (2016-12) | MIT | kecil | Global | — | 0 | **TOLAK** (tak terpelihara) |
| canvas-nest.js | 2.0.4 (2018-12) | MIT | 7,2 KB / 2,5 KB gz (+`size-sensor`) | Global/UMD | **Gagal**: `setAttribute("style", …)` + `.cssText` (diblokir) dan `size-sensor` menyisipkan `<object type="text/html">` (diblokir `object-src 'none'`) | 0 | **TOLAK** |
| Demo "neural network background" (CodePen dsb.) | — | beragam/tidak jelas | — | — | — | — | **REFERENSI** visual saja |

Analisis:

- **tsParticles** adalah satu-satunya kandidat teknis yang realistis (MIT, aktif, bundle mandiri, tanpa eval). Tetapi:
  (1) 45,8 KB gz untuk fitur yang sudah ada di `neural.js` (≈1.050 baris, 0 dependensi); (2) tidak punya konsep
  **pulsa yang merambat sepanjang edge dan menyalakan node** — efek inti "sinaps" pada arah Neural Aurora harus
  ditulis sebagai plugin sendiri juga; (3) mesin generik berbasis konfigurasi JSON besar menyulitkan unit test
  fungsi murni (`createGraph/stepGraph/buildGrid/neighbors`) yang sudah kita miliki; (4) versi 4.5.0 baru dirilis
  2026-10-25 (melanggar kebijakan kematangan), dan metapaket `tsparticles` menarik ±40 sub-paket `@tsparticles/*`
  (permukaan supply-chain besar walau hanya satu file yang disajikan); (5) ada jalur `fetch()` untuk memuat
  preset/gambar — tidak berbahaya di bawah `connect-src 'self'`, tapi kode mati yang perlu diaudit.
- **three.js / OGL / Vanta**: WebGL. Brief menetapkan canvas 2D (baterai, kompatibilitas, fallback statis mudah).
  three.js ±417 KB gz total — tidak sebanding untuk latar dekoratif.
- **canvas-nest.js** gagal CSP dan tak terpelihara sejak 2018.

## 3. Referensi desain terminal trading / dashboard (hanya pola, tanpa kode)

| Proyek | Lisensi | Pola yang layak ditiru | Catatan |
|---|---|---|---|
| OpenBB (Platform/ODP, Workspace) | AGPL-3.0 (+ lisensi komersial) | Panel padat ber-widget, header widget dengan sumber data & waktu pembaruan, palet gelap netral | Jangan salin kode (AGPL). Pola "sumber + timestamp di tiap widget" selaras aturan anti-data-palsu kita. |
| FreqUI (frontend freqtrade) | GPL-3.0 (Vue + PrimeVue) | Status bot yang jelas (running/stopped), tabel trade padat, warna profit/loss konsisten | Hanya referensi. |
| Superalgos | Apache-2.0 | Visualisasi "workspace" berbasis node/graph | Gaya terlalu ramai; inspirasi untuk konstelasi saja. |
| Hummingbot dashboard | Apache-2.0 (Streamlit) | Kartu metrik + grafik ringkas per strategi | Streamlit, tidak relevan teknis. |
| Ghostfolio | AGPL-3.0 (Angular) | Hierarki KPI yang tenang, empty state yang jujur, mode gelap rapi | Hanya referensi. |
| TradingView lightweight-charts (contoh resmi) | Apache-2.0 | Crosshair sinkron, legend mengambang, warna candle semantik | Sudah dipakai (`/vendor/lightweight-charts.js`). |
| Tremor (`@tremor/react` 3.18.7, 2025-01) | Apache-2.0 | Tipografi KPI, *badge delta*, kartu metrik dengan sparkline, skala abu-abu yang konsisten | React + Tailwind + recharts → tidak bisa dipakai; pola saja. |
| shadcn/ui charts | MIT | Token warna chart `--chart-1..5`, tooltip minimal, legenda di bawah | Pola token sudah setara dengan `--lr-*`. |

## 4. Grafik & visualisasi jaringan

| Kandidat | Versi (rilis) | Lisensi | Ukuran build | Tanpa bundler | CSP | Advisori | Keputusan |
|---|---|---|---|---|---|---|---|
| sigma.js (`sigma`) | 4.0.3 (2026-10-15) | MIT | paket 3,4 MB, `sigma.esm.js` terpecah ±13 chunk relatif; wajib `graphology` 0.26.0 (bergantung `events`, bare import) | Praktis **perlu bundler** | WebGL | 0 | **TOLAK** |
| cytoscape.js | 3.34.4 (2026-10-15) | MIT | `cytoscape.esm.min.mjs` 434 KB / **135,7 KB gz** | ESM mandiri | **Gagal sebagian**: menyisipkan `<style>` (`.<cls> { position: relative; }`) → diblokir | 0 | **TOLAK** |
| d3-force | 3.0.0 (2021-06) | ISC | `d3-force.min.js` 8,3 KB / 3,0 KB gz | UMD butuh `d3-quadtree`, `d3-dispatch`, `d3-timer` global; ESM `src/` pakai bare import | OK | 0 | **REFERENSI** (algoritme gaya Barnes–Hut, bila konstelasi butuh layout gaya) |
| vis-network | 10.1.3 (2026-10-25, 1 hari) | Apache-2.0 / MIT | paket 84,5 MB | Build standalone ada | Menyuntik CSS/elemen gaya (perlu verifikasi) | 0 | **TOLAK** (ukuran, versi terlalu baru) |
| force-graph | 1.52.0 (2026-09-28) | MIT | paket 6,4 MB; ±15 dependensi (d3-*, lodash-es, kapsule, tween.js, float-tooltip) | Perlu bundler | — | 0 (langsung) | **TOLAK** |
| uPlot | 1.6.32 (2025-03) | MIT | `uPlot.esm.js` 145 KB / 41,7 KB gz; `uPlot.iife.min.js` 51 KB / **22,0 KB gz** + `uPlot.min.css` | ESM/IIFE mandiri | **Lolos**: tanpa eval/`<style>`/`setAttribute("style")`; CSS berupa file (cocok `style-src 'self'`) | 0 | **REFERENSI** (kandidat cadangan bila kelak butuh time-series ribuan titik, mis. equity curve backtest) |

Analisis: konstelasi pasar (`constellation.js`) memuat simbol & angka NYATA dari API dan butuh kendali penuh atas
empty state serta aksesibilitas; canvas 2D sendiri dengan layout sederhana sudah cukup untuk puluhan node. Library graf
di atas dirancang untuk ribuan node + interaksi editor, tidak sebanding biayanya. uPlot lolos semua uji teknis, tetapi
lightweight-charts sudah menutup kebutuhan grafik harga saat ini; menambah library grafik kedua tanpa kebutuhan nyata
melanggar prinsip dependensi minimal.

## 5. Micro-interaction / motion

| Kandidat | Versi (rilis) | Lisensi | Ukuran build | Tanpa bundler | CSP | Advisori | Keputusan |
|---|---|---|---|---|---|---|---|
| Motion (`motion`, dulu Motion One) | 14.6.0 (2026-10-22, 4 hari) | MIT | `dist/motion.js` (UMD) 172 KB / **57,1 KB gz**; `dist/es/index.mjs` = `export * from 'framer-motion/dom'` | ESM bare import → perlu bundler; UMD bisa | **Berisiko**: memuat `createElement("style")` (fitur view transition) dan `setAttribute("style", …)` → diblokir bila jalur itu terpanggil | 0 | **TOLAK** |
| anime.js (`animejs`) | 4.5.0 (2026-06-22) | MIT | paket 2,1 MB; ±10–17 KB gz *(perkiraan)* | ESM `dist/modules` | Tidak terverifikasi (unduhan gagal) | 0 | **REFERENSI** (kurva easing/stagger) |
| GSAP | 3.15.0 (2026-04-13) | **"Standard no-charge license" Webflow — bukan lisensi OSI** | paket 6,3 MB; `dist/gsap.min.js` 72,9 KB / 28,3 KB gz | UMD/ESM | **Berisiko**: menulis `.cssText` (diblokir `style-src` tanpa `'unsafe-inline'`) | 0 | **TOLAK** (lisensi proprietary: gratis termasuk komersial, tetapi dapat dicabut Webflow, melarang pemakaian dalam alat yang bersaing dengan Webflow, dan bukan open-source) |
| AutoAnimate (`@formkit/auto-animate`) | 0.10.0 (2026-07-10) | MIT | `index.min.js` 8,4 KB / **3,3 KB gz**, 0 dependensi | ESM mandiri | **Lolos** (Web Animations API, tanpa `<style>`/eval/innerHTML) | 0 | **REFERENSI / ditunda** (lihat bawah) |
| countUp.js | 2.10.1 (2026-07-02) | MIT | `countUp.min.js` 6,8 KB / 2,2 KB gz | ESM mandiri | Lolos CSP, **tetapi menulis `el.innerHTML`** (bertentangan dengan aturan ESLint proyek yang melarang `innerHTML`) | 0 | **TOLAK** (sudah ada `animateNumber()` yang memakai `textContent`) |

Analisis:

- **Count-up** sudah diimplementasikan (`animateNumber()` di `components.js`, hanya dari 0 ke nilai NYATA, menghormati
  `data-motion`). countUp.js tidak memberi manfaat tambahan dan memakai `innerHTML`.
- **Transisi masuk, stagger baris, shimmer, badge berdenyut, scan line** semuanya bisa (dan lebih baik) dengan CSS
  `@keyframes` + `transition` di file CSS sendiri — dinonaktifkan sekaligus lewat `[data-motion="off"]` /
  `prefers-reduced-motion`. Library JS tidak diperlukan.
- **AutoAnimate** adalah satu-satunya kandidat yang benar-benar kecil (3,3 KB gz), MIT, tanpa dependensi, ESM mandiri
  dan patuh CSP. Manfaatnya: animasi FLIP saat baris tabel scanner berubah posisi. Namun daftar kandidat scanner saat ini
  dirender ulang lewat `host.replaceChildren(...)` (`frontend/js/views/screener.js`), sehingga AutoAnimate akan menganggap semua baris "baru" dan tidak
  menghasilkan animasi urut-ulang tanpa diffing berkunci; selain itu baris yang "melompat" saat data diperbarui dapat
  mengganggu pembacaan di terminal padat. Ditunda sampai ada render berkunci per simbol; bila nanti diadopsi, ia harus
  menghormati `data-motion` (AutoAnimate menyediakan `.disable()`).

## 6. Matriks keputusan akhir

| Kategori | ADOPSI | REFERENSI SAJA | TOLAK |
|---|---|---|---|
| Latar jaringan | — | Pts.js, demo CodePen | tsParticles, particles.js, Vanta, three.js, OGL, p5.js, sketch.js, canvas-nest.js |
| Desain terminal | — | OpenBB, FreqUI, Superalgos, Hummingbot, Ghostfolio, contoh lightweight-charts, Tremor, shadcn charts | — |
| Grafik/jaringan | — | d3-force (algoritme), uPlot (cadangan) | sigma.js, cytoscape.js, vis-network, force-graph |
| Motion | — | anime.js (easing), AutoAnimate (ditunda) | Motion, GSAP, countUp.js |

Alasan umum tidak ada ADOPSI: manfaat nyata < biaya dependensi. Mesin sendiri `neural.js` sudah memenuhi seluruh
spesifikasi Neural Aurora (spatial grid, pulsa edge, nyala node, kursor, batas DPR/FPS, berhenti saat tab tersembunyi,
`prefers-reduced-motion`, toggle `lr.motion`) dengan 0 KB dependensi dan teruji unit; setiap library di atas akan
menambah 2–420 KB gz, permukaan supply-chain, dan/atau melanggar CSP, tanpa fitur yang belum kita miliki.

## 7. Prosedur bila kelak ada yang diadopsi

1. Pin eksak: `npm install --save-exact <paket>@<versi>` (versi yang sudah beredar ≥ 14 hari), jalankan `npm audit`.
2. Sajikan **satu** file build lewat route tetap baru di `backend/app/buildApp.js` meniru pola
   `/vendor/lightweight-charts.js` (resolve via `createRequire(...).resolve('<paket>/package.json')`, `config.public`,
   503 bila hilang). Jangan membuka direktori `node_modules`.
3. Uji CSP di E2E: tidak ada pelanggaran `securitypolicyviolation` di konsol.
4. Tambah entri di `docs/06-evaluasi-dependensi.md` dan `THIRD_PARTY_NOTICES.md` (teks lisensi + atribusi).
5. Hormati `data-motion` dan `prefers-reduced-motion`.

## Sumber

- Registry npm (`npm view`, `npm pack`, endpoint advisori bulk), diakses 2026-10-26.
- GSAP: [Webflow — GSAP becomes free](https://webflow.com/blog/gsap-becomes-free),
  [teks Standard "No Charge" License](https://gsap.com/community/standard-license/),
  [ScanCode LicenseDB](https://scancode-licensedb.aboutcode.org/gsap-standard-no-charge-2025.html).
- OpenBB: [FAQ lisensi](https://docs.openbb.co/odp/python/faqs/license),
  [blog perubahan ke AGPL](https://openbb.co/blog/license-change-openbb-platform-goes-agpl/).
- Ghostfolio: [AlternativeTo](https://alternativeto.net/software/ghostfolio/about).
- FreqUI: [dokumentasi freq-ui](https://gitcode.com/GitHub_Trending/fr/freqtrade/blob/develop/docs/freq-ui.md)
  (lisensi GPL-3.0 dari daftar mirror organisasi; LICENSE asli tidak dapat dibuka karena github.com diblokir).
- CSP: [MDN — style-src](https://developer.mozilla.org/docs/Web/HTTP/Headers/Content-Security-Policy/style-src).
- Vanta: [npm vanta](https://npmjs.com/package/vanta).
