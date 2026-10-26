# 11 — Riset desain "Neural Aurora": terminal premium, latar jaringan saraf, kaca, gerak

Status: riset (Oktober 2026). Penulis: Agent RISET-DESAIN. Dokumen ini read-only terhadap kode; ia
memberi **nilai angka konkret** yang bisa langsung dipakai di `frontend/js/lib/neural.js`,
`frontend/css/tokens.css`, `frontend/css/neural.css`, `components.css`, dan view.

> Catatan metodologi: penelusuran memakai mesin pencari web. Beberapa sumber primer (MDN, W3C, Tech at
> Bloomberg) tidak bisa diambil langsung dari lingkungan ini, sehingga isinya dikutip lewat ringkasan
> hasil pencarian. Angka yang ditandai **(uji)** adalah titik awal yang masuk akal dan **harus diukur**
> di DevTools (Performance + Rendering → Frame Rendering Stats) di perangkat kelas menengah.
> Rasio kontras di §6 **dihitung sendiri** dengan rumus luminans relatif WCAG 2.x.

---

## 1. Ringkasan eksekutif (TL;DR)

1. **Terminal premium itu padat dan disiplin warna.** Merah/hijau hanya untuk arah (LONG/SHORT); aksen
   tunggal untuk aksi dan data live. Dekorasi (kaca, aurora, jaringan) harus berada **di belakang** data,
   tidak pernah bersaing dengan warna semantik.
2. **Latar neural di canvas 2D** murah bila: grid spasial (sel = jarak sambung), path dibatch per bucket
   alfa (≤ 8 bucket), glow dari sprite pra-render (tanpa `shadowBlur`), DPR ≤ 2 (≤ 1.5 untuk layar besar),
   ±30–45 fps, berhenti saat `document.hidden`, satu frame statis untuk reduced motion.
3. **`backdrop-filter` adalah properti CSS termahal** yang umum dipakai; biayanya ∝ **luas** × **radius**,
   dan di atas canvas yang berubah tiap frame ia **dihitung ulang tiap frame**. Batasi ke panel, jangan
   pada area full-viewport; radius 10–14px; jangan bersarang.
4. **Kontras:** kaca `alpha 0.74` lolos AA untuk `--lr-text-3` hanya bila luminans latar yang terblur di
   belakang panel ≤ ±35% cyan. Maka **redupkan canvas di area konten** (intensitas puncak node ≤ 0.55,
   garis ≤ 0.22) dan naikkan `--lr-glass-soft` ke ≥ 0.78.
5. **A11y gerak:** latar beranimasi > 5 detik yang tampil berdampingan dengan konten = wajib ada
   mekanisme jeda (WCAG 2.2.2, Level A). Toggle "Animasi latar" di topbar memenuhi ini, asalkan mudah
   dijangkau keyboard dan statusnya diumumkan (`aria-pressed`).
6. **Micro-interaction jujur:** flash 300–500ms hanya saat nilai benar-benar berubah dari server;
   count-up hanya dari 0 → nilai nyata dan maksimal 600ms; skeleton hanya bila muat > 300ms, dengan
   `aria-busy` di kontainer.

---

## 2. Studi pembanding: terminal trading & intelijen kripto

| Produk | Pola yang layak ditiru | Yang **tidak** ditiru |
|---|---|---|
| **Bloomberg Terminal** | Kepadatan ekstrem, perubahan inkremental (UX Bloomberg menyebut ganti font saja bisa merusak alur kerja), **skema warna alternatif untuk buta warna** (deuteranopia/protanomali, perintah `PDFU COLORS`) karena ±20.000 pengguna terdampak; merah-hijau tampak hampir sama bagi deuteranopia. | Warna amber-on-black klasik; tanpa animasi. |
| **TradingView** | Workspace referensi: chart di tengah tetap, toolbar permanen di tepi; tema gelap kontras rendah di grid, tinggi di label. | — |
| **Binance / Bybit Pro** | "Disiplin densitas": lima region live tetap terbaca bersamaan; merah/hijau dicadangkan untuk arah saja. | Banner promosi, warna kuning brand bersaing dengan data. |
| **Hyperliquid** | Biru-hitam sangat gelap, **satu** aksen mint untuk aksi utama & data live, kolom angka monospasi ala terminal. Secara sadar *menolak* gradien & glassmorphism → pelajaran: efek kita harus subtil & di latar. | — |
| **Nansen / Arkham** | Label entitas/dompet sebagai "chip", feed peringatan real-time; grafik relasi (graph) sebagai visual inti — cocok dengan metafora jaringan saraf. | — |
| **Kaito / "crypto intelligence" berbasis AI** | Narasi "AI membaca pasar": ringkasan teks + skor; visual graf/konstelasi. Tidak ditemukan dokumentasi desain resmi (Saraf: tidak ditemukan sumber). | Angka/skor dekoratif yang bukan data nyata. |

**Pelajaran untuk AlphaLens**
- Warna arah tetap emerald (LONG) / rose (SHORT); **selalu disertai ikon/teks** (▲ LONG / ▼ SHORT), bukan
  warna saja (Bloomberg CVD). Pertimbangkan opsi tema "CVD" (biru #4ea8ff ↔ oranye #ff9f43) di Pengaturan.
- Neural cyan/violet = **aksen dekoratif & brand**, bukan sinyal. Jangan gunakan cyan untuk "bull".
- Angka: `font-variant-numeric: tabular-nums` di semua tabel/KPI agar flash/count-up tidak menggeser layout.

---

## 3. Tren UI 2025–2026 untuk dashboard data gelap

- **Glassmorphism yang terbaca** (dipicu Apple *Liquid Glass*, 2025): panel lebih opak di bawah teks,
  border dalam 1px, jangan menumpuk kaca di atas kaca. W3C CSSWG (Juni 2025) bahkan membahas kebutuhan
  `prefers-reduced-transparency` karena tren ini memperburuk kontras.
- **Aurora gradients**: 2–3 blob radial lembut di atas basis hampir hitam; paling efektif di mode gelap.
  Versi statis cukup dengan radial-gradient bertumpuk; versi animasi sebaiknya **digambar di canvas yang
  sudah ada** (bukan elemen CSS full-screen yang di-blur — itu mahal).
- **Bento grid**: kartu dengan ukuran berbeda (1×1, 2×1, 2×2) untuk KPI/overview; gap 12–16px, radius
  10–14px. Cocok untuk halaman Overview, **tidak** untuk tabel scanner (tetap tabel padat).
- **Motion design**: durasi pendek & bermakna. Material 3: token 150/200/300ms; elemen masuk memakai
  *decelerate* `cubic-bezier(0,0,0,1)`, perpindahan di layar `cubic-bezier(0.2,0,0,1)`; > 400ms terasa lambat.

---

## 4. Teknik latar jaringan saraf di canvas 2D

### 4.1 Arsitektur render per frame
1. `ctx.setTransform(dpr,0,0,dpr,0,0)`; `clearRect` (atau `fillRect` warna latar bila canvas `alpha:false`).
2. **Aurora**: 3 radial gradient besar digambar ke **canvas offscreen beresolusi rendah** (¼ ukuran),
   diperbarui tiap ±250ms (4 fps) — lalu `drawImage` di-skala ke layar. Gradien besar per frame itu mahal;
   pergeserannya pelan sehingga 4 fps tidak terlihat.
3. **Edge**: bangun grid → untuk tiap node cek sel sendiri + 8 tetangga (hanya pasangan `j > i`) →
   kelompokkan segmen ke **bucket alfa** (mis. 6 bucket: 0.04, 0.08, 0.12, 0.16, 0.20, 0.24) →
   per bucket: `beginPath()`, banyak `moveTo/lineTo`, **satu** `stroke()`. web.dev: satu path dengan
   banyak segmen jauh lebih murah daripada satu `stroke` per garis.
4. **Node**: `drawImage(sprite, x - r, y - r)` dengan sprite glow pra-render per warna (cyan, violet,
   emerald, rose) dan 2–3 ukuran. **Jangan** pakai `shadowBlur` (dihitung ulang per draw call).
   Pakai `globalAlpha` per node atau bucket kecerahan.
5. **Pulsa sinaps**: titik/sprite kecil bergerak sepanjang edge (`t += v*dt`), maks 24 pulsa aktif,
   pool objek (tanpa alokasi per frame). Saat tiba, node tujuan `glow = 1` lalu meluruh `glow *= 0.92^(dt/16)`.
6. **Vignette**: satu `radialGradient` statis dirender sekali ke offscreen saat `resize()`.

### 4.2 Angka yang direkomendasikan

| Parameter | Nilai | Catatan |
|---|---|---|
| Jumlah node | `clamp(round(w*h/14000), 28, 140)`; mobile (`w < 768` atau `pointer: coarse`) × 0.6, maks 60 | 1920×1080 → 140 (cap); 1366×768 → 75; 390×844 → 24→28 |
| Jarak sambung (`linkDist`) | `clamp(min(w,h)*0.16, 110, 170)` px CSS | = ukuran sel grid |
| Maks sambungan per node | 6 | mencegah N(N-1)/2 edge di klaster padat |
| Kecepatan node | 0.010–0.030 px/ms (6–18 px/detik) | "melayang pelan" |
| Radius node | 1.2–2.4 px; sprite glow 4× radius | |
| Alfa garis | `0.24 * (1 - d/linkDist)^1.5`, dibatch ke 6 bucket | puncak ≤ 0.24 agar kontras panel aman |
| Alfa node dasar / menyala | 0.45 / ≤ 0.85 | |
| Pulsa | spawn acak 0.6/detik di idle; `setActivity(0.8)` → 2.5/detik; `pulse(kind,6)` sekaligus 6; maks 24 aktif; kecepatan 0.25–0.4 px/ms | |
| Kursor | radius tarik 140px, gaya ≤ 0.00006·d, terang +0.35; update posisi via `pointermove` passive, dibaca di rAF | jangan pakai `mousemove` + kerja berat |
| FPS | target 45 fps (`minFrameMs = 22`); turun ke 30 bila 20 frame berturut-turut > 28ms; `setActivity < 0.3` → 30 fps | rAF tetap, skip frame berdasar delta |
| Delta | clamp `dt ≤ 50ms`; reset `last` saat kembali visible | cegah "lompatan" setelah tab tersembunyi |
| DPR | `min(devicePixelRatio, 2)`; bila `w*h*dpr² > 4.5 jt px` → dpr 1.5; perangkat lemah (`hardwareConcurrency ≤ 4` atau `deviceMemory ≤ 4`) → 1 | fill-rate adalah batas di ponsel (PlayCanvas) |
| Context | `getContext('2d', { alpha: true, desynchronized: false })`; koordinat dibulatkan ke 0.5 hanya untuk garis 1px | sub-pixel boleh untuk node |
| Resize | debounce 150ms, `ResizeObserver` atau `resize` | regenerasi node hanya jika jumlah target berubah > 15% |

### 4.3 Siklus hidup & heuristik hemat daya
- `document.addEventListener('visibilitychange')` → `cancelAnimationFrame` saat hidden; saat visible reset
  baseline waktu (browser memang menghentikan rAF di tab tersembunyi, tapi delta besar saat kembali harus diclamp).
- `matchMedia('(prefers-reduced-motion: reduce)')` → mode `'reduced'`: gambar **satu frame statis**
  (node + edge, tanpa pulsa), tanpa listener kursor; dengarkan `change` agar responsif.
- `navigator.connection?.saveData === true` → anggap default `'reduced'` (bukan 'off'), hanya Chromium/Samsung;
  feature-detect. `navigator.getBattery()` **deprecated** & di Chrome/Edge modern bisa mengembalikan nilai
  palsu (level 1, charging) → **jangan dipakai**.
- `IntersectionObserver` tidak perlu (canvas fixed full-screen).
- Jika `ctx` null (mis. canvas diblokir) → keluar diam-diam, kembalikan objek no-op dengan API sama.
- Saat `setMotion('off')`: hentikan loop, `clearRect`, biarkan latar CSS statis (`--lr-gradient-aurora`).

### 4.4 Fungsi murni (testability)
`createGraph(w,h,count,rng)`, `stepGraph(graph,dt,w,h)`, `buildGrid(nodes,cell)`, `neighbors(grid,node,cell)`
tanpa DOM; `rng` dapat di-seed (mulberry32) agar unit test deterministik. Uji: jumlah node sesuai clamp,
node tetap di dalam batas (wrap/bounce), `neighbors` setara brute-force pada 200 node acak, dt diclamp.

---

## 5. Biaya `backdrop-filter` di atas canvas beranimasi

**Fakta**
- Disebut properti CSS termahal yang umum; worst case browser menggambar pohon dua kali dan membaca balik
  piksel (diskusi W3C). Karena canvas di belakang berubah tiap frame, **setiap panel kaca di-blur ulang tiap frame**.
- Biaya ∝ luas area × radius. Satu panel besar lebih mahal dari beberapa kecil. Kasus terburuk umum:
  header sticky blur di atas konten yang bergulir. Di atas ±20px perbedaan visual hampir tak terlihat.
- `backdrop-filter` bersarang tanpa isolasi → degradasi eksponensial (tiap lapis menggandakan kerja).
- `will-change` membuat layer komposit → **memakan memori GPU**; hanya untuk elemen yang benar-benar beranimasi.

**Rekomendasi**
| Item | Nilai |
|---|---|
| Blur panel (`--lr-blur`) | `blur(12px) saturate(135%)` (dari 14px; tak terlihat bedanya, ±15% lebih murah) |
| Blur kuat (modal/overlay) | `blur(16px) saturate(140%)` (dari 20px) |
| Topbar sticky | boleh blur 10px, **tapi** `background` alpha ≥ 0.86 (sudah) |
| Sidebar & tabel scanner besar | **tanpa** backdrop-filter; pakai `--lr-glass-strong` (0.88) solid-ish |
| Elemen di dalam panel kaca (kartu, chip, tooltip) | **jangan** pakai backdrop-filter lagi (no nesting) |
| Maks elemen ber-blur yang terlihat bersamaan | ≤ 6 (uji) |
| `will-change` | **jangan** di panel; hanya `will-change: transform` sementara pada elemen yang sedang dianimasikan, lepas setelah `animationend` |
| `isolation: isolate` | pada `.app` (wrapper konten) agar backdrop panel tidak menangkap lapisan lain secara tak terduga |
| Fallback | `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))` → `background: var(--lr-glass-strong)` |
| Reduced transparency | `@media (prefers-reduced-transparency: reduce)` (Chrome/Edge 118+, Firefox di balik flag, Safari belum) → `backdrop-filter: none; background: var(--lr-surface)` |
| `data-motion="off"` | Pertimbangkan juga `backdrop-filter: none` + alpha 0.92 — saat canvas diam, blur tidak bernilai, dan hemat GPU |
| Prefiks | sertakan `-webkit-backdrop-filter` (Safari) |

**Mitigasi tambahan:** karena latar adalah canvas milik kita, alternatif termurah adalah **meredupkan
canvas di bawah area konten** (gradien mask di canvas atau vignette lebih gelap di tengah) sehingga
panel cukup alpha 0.80 **tanpa** blur pun tetap elegan. Pertimbangkan blur hanya pada topbar + kartu KPI.

---

## 6. Kontras di atas kaca — perhitungan

Dihitung: teks di atas panel `rgb(10 15 25 / α)` yang dikomposit di atas latar (luminans relatif WCAG).
"cyan 35%" = latar terblur di belakang panel setara 35% #38e1ff di atas #05070d (realistis setelah blur
12–14px bila beberapa node/garis terang lewat di belakang). "cyan penuh" = worst case (node menyala persis
di belakang dan tak terblur; tidak realistis dengan blur, tapi relevan saat **fallback tanpa blur**).

| Panel | Latar di belakang | text | text-2 | text-3 | bull | bear | accent |
|---|---|---|---|---|---|---|---|
| glass 0.74 | #05070d | 16.9 | 7.4 | 5.6 | 8.7 | 6.6 | 9.0 |
| glass 0.74 | cyan 35% | 14.4 | 6.3 | **4.72** | 7.4 | 5.6 | 7.7 |
| glass 0.74 | cyan penuh | 9.0 | **3.94** | **2.95** | 4.65 | **3.50** | 4.80 |
| glass-soft 0.72 | cyan 35% | 13.5 | 5.9 | **4.42 ✗** | 7.0 | 5.2 | 7.2 |
| glass 0.80 | cyan 35% | 15.0 | 6.6 | 4.92 | 7.8 | 5.8 | 8.0 |
| glass 0.80 | cyan penuh | 10.7 | 4.69 | **3.52 ✗** | 5.5 | **4.17 ✗** | 5.7 |
| glass-strong 0.86 | cyan penuh | 13.1 | 5.7 | **4.28 ✗** | 6.7 | 5.1 | 7.0 |

**Kesimpulan & aturan**
1. `--lr-glass-soft` 0.72 **gagal** AA untuk `--lr-text-3` dengan latar terang 35% → naikkan ke **0.80**.
2. `--lr-glass` 0.74 lolos tipis (4.72) → naikkan ke **0.78** untuk margin (≈ 4.85).
3. Panel yang memuat teks kecil `--lr-text-3` atau angka bear di atas area yang bisa dilewati node terang
   tanpa blur (fallback) → pakai `--lr-glass-strong` (≥ 0.88).
4. **Batasi kecerahan canvas**: alfa node ≤ 0.85 hanya untuk ≤ 300ms (menyala), dasar ≤ 0.45, garis ≤ 0.24.
   Dengan blur 12px dan node 2px, luminans latar efektif di belakang panel tetap jauh di bawah 35%.
5. Teks di atas canvas **tanpa panel** (mis. hero login) hanya boleh `--lr-text` (bukan text-2/3) dan
   diberi `text-shadow: 0 1px 2px rgb(0 0 0 / 0.6)` atau plat gelap.
6. Fokus ring tetap solid `--lr-accent` (sudah ≥ 3:1).

---

## 7. Aksesibilitas gerak

- **WCAG 2.2.2 Pause, Stop, Hide (A)**: informasi yang bergerak, mulai otomatis, berlangsung > 5 detik,
  dan ditampilkan berdampingan dengan konten lain **harus** bisa dijeda/dihentikan/disembunyikan. Latar
  neural termasuk. Jeda yang hanya berlaku selama fokus/hover **tidak** memenuhi. → Toggle topbar wajib:
  `<button aria-pressed="true|false">Animasi latar</button>`, terjangkau keyboard, persist `lr.motion`.
- **WCAG 2.3.3 Animation from Interactions (AAA)**: gerak yang dipicu interaksi (parallax, kursor menarik
  node, hover glow besar) harus bisa dimatikan → `prefers-reduced-motion` + `data-motion="off"` mematikan
  efek kursor juga.
- **WCAG 2.3.1 Tiga kilatan**: flash/pulsa tidak boleh > 3 kali per detik dengan area besar. Pulsa badge
  BREAKOUT: periode ≥ 2s (sudah 2.4s) dan perubahan luminans kecil.
- `prefers-reduced-motion: reduce` → canvas statis, tanpa shimmer (skeleton warna datar), tanpa count-up
  (langsung nilai akhir), tanpa stagger; transisi opacity ≤ 120ms boleh tetap.
- Animasi fungsional (spinner, progres sync) tetap boleh tapi tanpa gerak besar.
- Jangan mengumumkan perubahan harga setiap tick ke screen reader; gunakan `aria-live="polite"` hanya
  untuk peristiwa bermakna (sinyal baru, scanner selesai) dengan kalimat lengkap
  ("Sinyal LONG baru: BTCUSDT tahap BREAKOUT").

---

## 8. Micro-interaction untuk data real-time yang jujur

| Pola | Aturan | Angka |
|---|---|---|
| **Flash on change** | Hanya bila nilai dari server berbeda dari render sebelumnya; arah naik → bull-soft, turun → bear-soft; CSS saja (kelas + `animationend`), throttle per sel | 400ms, `ease-out`, maks 1 flash per sel per 1s |
| **Count-up KPI** | Hanya dari 0 (atau nilai lama) ke **nilai nyata**; tidak pernah angka acak; `tabular-nums`; pembaca layar mendapat nilai akhir langsung (`aria-label`/teks final di DOM setelah selesai) | 600ms, easeOutExpo; dilewati bila reduced/off atau nilai < 10 |
| **Skeleton** | `aria-busy="true"` pada kontainer, skeleton `aria-hidden="true"`; dimensi = konten akhir (no layout shift); tampil hanya bila muat > 300ms; timeout → error state jujur, bukan skeleton abadi | shimmer 1.4–1.6s linear; transform pseudo-element, bukan `background-position` |
| **Stagger baris** | Hanya saat render awal / ganti filter, bukan tiap refresh polling | 18ms per baris, maks 12 baris (≤ 216ms total), fade+translateY(4px) 180ms |
| **Masuk halaman** | fade + translateY(6px) | 220–280ms decelerate `cubic-bezier(0,0,0,1)` (420ms sekarang sedikit lambat) |
| **Badge BREAKOUT/BREAKDOWN** | denyut halus via **opacity pseudo-element**, bukan `box-shadow` keyframe | periode 2.4s, opacity 0 → 0.6 |
| **Scan line scanner** | hanya saat status worker = berjalan (dari API); `transform: translateX` pada `::after` | 2.2s linear infinite |
| **Pulsa canvas** | dipicu `lr:activity` hanya dari peristiwa nyata (sinyal baru, start/stop) | `pulse(kind, 6)` |
| **"Live" dot** | hanya hijau jika data < 2× interval polling; selain itu abu + "tertunda" | — |

**Biaya properti animasi:** animasikan hanya `transform` dan `opacity` (komposit). `box-shadow`,
`background-position`, `filter`, `width` memicu paint tiap frame — di atas latar kaca itu juga memaksa
re-blur.

---

## 9. Daftar rekomendasi konkret (siap diterapkan)

### tokens.css (SHELL)
```css
--lr-glass: rgb(10 15 25 / 0.78);          /* dari 0.74 */
--lr-glass-soft: rgb(14 21 34 / 0.80);     /* dari 0.72 — gagal AA text-3 */
--lr-glass-strong: rgb(8 12 21 / 0.90);
--lr-blur: blur(12px) saturate(135%);      /* dari 14px */
--lr-blur-strong: blur(16px) saturate(140%);
--lr-dur-page: 260ms;                      /* dari 420ms */
--lr-ease-enter: cubic-bezier(0, 0, 0, 1);
--lr-ease-standard: cubic-bezier(0.2, 0, 0, 1);
--lr-dur-flash: 400ms;
--lr-dur-countup: 600ms;
--lr-stagger: 18ms;
```
Tambahkan:
```css
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  :root { --lr-glass: var(--lr-glass-strong); --lr-glass-soft: var(--lr-glass-strong); }
}
@media (prefers-reduced-transparency: reduce) {
  :root { --lr-blur: none; --lr-blur-strong: none; --lr-glass: var(--lr-surface); --lr-glass-soft: var(--lr-surface-2); }
}
```

### neural.js (NEURAL)
- count = `clamp(round(w*h/14000), 28, 140)`, coarse pointer ×0.6 maks 60; `linkDist = clamp(min(w,h)*0.16,110,170)`.
- Grid sel = `linkDist`; cek 9 sel; `j > i`; maks 6 link/node; bandingkan `dx*dx+dy*dy < d²` sebelum `sqrt`.
- 6 bucket alfa edge, satu `stroke()` per bucket per warna; `lineWidth = 1` (CSS px).
- Sprite glow pra-render (OffscreenCanvas bila ada, fallback `document.createElement('canvas')`), tanpa `shadowBlur`.
- Aurora ke offscreen ¼ resolusi, refresh 4 fps.
- FPS 45 (22ms), adaptif ke 30; `dt` clamp 50ms; DPR `min(dpr,2)`, 1.5 bila > 4.5 MPx, 1 di perangkat lemah.
- Pause saat `document.hidden`; reduced → 1 frame statis; `saveData` → reduced; tanpa Battery API.
- Pool objek pulsa (maks 24), nol alokasi di loop (hindari array/closure baru per frame).
- `pointermove` `{ passive: true }`, simpan koordinat, hitung di rAF; nonaktif saat reduced/off/coarse.
- `destroy()` melepas semua listener, ResizeObserver, matchMedia, dan rAF.

### neural.css (NEURAL)
```css
.neural-bg { position: fixed; inset: 0; width: 100%; height: 100%; z-index: var(--lr-z-bg);
  pointer-events: none; display: block; background: var(--lr-bg) var(--lr-gradient-aurora); }
:root[data-motion="off"] .neural-bg { opacity: 0.6; }   /* tetap ada, diam */
@media print { .neural-bg { display: none; } }
```

### components.css / view CSS
- Panel kaca: `background: var(--lr-glass); backdrop-filter: var(--lr-blur); -webkit-backdrop-filter: var(--lr-blur);`
  border 1px `--lr-glass-border`, highlight atas `inset 0 1px 0 var(--lr-glass-highlight)`.
- Border gradien: teknik `::before` dengan `mask-composite: exclude` (atau `padding-box/border-box`
  dua background) — **statis**; hover hanya ubah `opacity` pseudo-element.
- Tabel besar & sidebar: tanpa blur, `--lr-glass-strong`.
- Ganti keyframe `lr-pulse-glow` (box-shadow) → pseudo-element dengan glow statis yang dianimasikan `opacity`.
- Ganti `lr-shimmer` (`background-position`) → `::after` gradien yang dianimasikan `transform: translateX`.
- Semua angka: `font-variant-numeric: tabular-nums`.
- Setiap animasi dekoratif mendapat aturan `:root[data-motion="off"] …, :root[data-motion="reduced"] … { animation: none }`.

### Ambang kinerja (untuk test/QA)
- Frame time median ≤ 16ms di laptop menengah, ≤ 33ms di ponsel menengah, dengan halaman scanner terbuka.
- CPU main thread untuk canvas ≤ 3ms/frame pada 140 node (uji dengan Performance panel).
- Long task 0 akibat canvas; tidak ada layout thrash (canvas tidak membaca layout per frame —
  `getBoundingClientRect` hanya saat resize).

---

## 10. Sumber

- web.dev — Improving HTML5 Canvas performance: https://web.dev/articles/canvas-performance
- MDN — Optimizing canvas: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
- web.dev — High DPI Canvas: https://web.dev/articles/canvas-hidipi
- PlayCanvas — Runtime devicePixelRatio: https://developer.playcanvas.com/user-manual/optimization/runtime-devicepixelratio/
- Gorilla Sun — Grid lookup & spatial hashing: https://gorillasun.de/blog/particle-system-optimization-grid-lookup-spatial-hashing
- constellation_particles (grid = jarak sambung): https://pub.dev/packages/constellation_particles
- particles_network (batas koneksi per partikel, batching): https://pub.dev/documentation/particles_network/1.9.6/
- Blix (batch render, palet terbatas, pooling): https://github.com/voormann/blix
- react.doctor — no-large-animated-blur: https://www.react.doctor/docs/rules/react-doctor/no-large-animated-blur
- OpenReplay — CSS backdrop-filter: https://blog.openreplay.com/creating-blurred-backgrounds-css-backdrop-filter/
- W3C www-style — Blurring an element's backdrop (biaya): https://lists.w3.org/Archives/Public/www-style/2013Nov/0394.html
- W3C public-fxtf — backdrop-filter bersarang: https://lists.w3.org/Archives/Public/public-fxtf-archive/2018Nov/0106.html
- WebKit r188530 (will-change memicu compositing): https://trac.webkit.org/r188530
- will-change & memori GPU: https://mspk.substack.com/p/what-will-change-actually-does-to
- Chrome — CSS prefers-reduced-transparency: https://developer.chrome.com/blog/css-prefers-reduced-transparency
- W3C CSSWG (2025, Liquid Glass & transparansi): https://lists.w3.org/Archives/Public/public-css-archive/2025Jun/0328.html
- web.dev — Save-Data: https://web.dev/articles/optimizing-content-efficiency-save-data
- MDN — Save-Data header: https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Save-Data
- Battery Status API (deprecated): https://www.codeproject.com/ref/dom/Navigator/getBattery
- GSAP — rAF dijeda saat tab tersembunyi: https://gsap.com/docs/v3/HelperFunctions/helpers/tickGSAPWhileHidden
- Bugnet — tab throttling, clamp delta: https://bugnet.io/blog/how-to-fix-web-game-tab-throttling-backgrounded
- W3C — Understanding SC 2.2.2: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide
- Deque — 2.3.3 Animation from Interactions: https://dequeuniversity.com/resources/wcag2.1/2.3.3-animations-from-interactions
- Hidde de Vries — 2.2.2 & prefers-reduced-motion: https://hidde.blog/meeting-2-22-pause-stop-hide-with-prefers-reduced-motion/
- Axess Lab — Glassmorphism meets accessibility: https://axesslab.com/?p=5111
- UX Collective/Bootcamp — Glassmorphism lebih aksesibel: https://bootcamp.uxdesign.cc/how-to-make-glassmorphism-more-accessible-9121d816004c
- Tech at Bloomberg — Designing the Terminal for color accessibility: https://www.techatbloomberg.com/blog/designing-the-terminal-for-color-accessibility/
- Bloomberg UX — Accessibility: https://www.bloomberg.com/ux/accessibility/
- Hyperliquid design breakdown (pihak ketiga): https://www.webdesignhot.com/design.md/hyperliquid/
- QuickNode — Top trading terminals on Hyperliquid 2026: https://www.quicknode.com/builders-guide/best/top-10-trading-terminals-on-hyperliquid-2026
- AdminLTE — Trading dashboard design examples: https://adminlte.io/blog/trading-dashboard-design-examples/
- Lazarev — Crypto dashboard design: https://www.lazarev.agency/articles/crypto-dashboard-design
- Nansen — situs baru: https://www.nansen.ai/post/announcing-the-launch-of-our-new-website
- SuperDesign — gaya Aurora: https://www.superdesign.dev/styles/aurora
- Material 1 — Duration & easing: https://m1.material.io/motion/duration-easing.html
- Material Components Android — Motion (token durasi M3): https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md
- Financial UI patterns (flash 300–500ms): https://www.mdskills.ai/ko/skills/financial-ui-patterns?tab=source
- AG Grid — flash on update: https://ag-grid.com/charts/vue/flash-on-update/
- WebAIM — pengumuman harga ke screen reader: https://webaim.org/discussion/mail_message?id=41353
- Vercel Design — Skeleton: https://vercel.com/design/skeleton
- Volvo Cars DS — Skeleton (aria-busy): https://designsystem.volvocars.com/web/components/skeleton/
- Zuora Occam — Skeleton: https://occam.zuora.com/components-skeleton
