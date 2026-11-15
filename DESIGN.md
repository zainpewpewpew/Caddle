---
name: AlphaLens
description: Terminal riset struktur pasar kripto privat dalam dunia Konsol Grafit, gelap, matte, dan berwarna hanya untuk status.
colors:
  accent: "#74b9ff"
  accent-strong: "#8fc7ff"
  accent-soft: "rgb(116 185 255 / 0.12)"
  accent-line: "rgb(116 185 255 / 0.42)"
  bull: "#74cf91"
  bull-soft: "rgb(116 207 145 / 0.12)"
  bull-line: "rgb(116 207 145 / 0.4)"
  bear: "#f0837d"
  bear-soft: "rgb(240 131 125 / 0.12)"
  bear-line: "rgb(240 131 125 / 0.4)"
  warn: "#e8b85a"
  warn-soft: "rgb(232 184 90 / 0.12)"
  warn-line: "rgb(232 184 90 / 0.4)"
  violet: "#c69cf0"
  violet-soft: "rgb(198 156 240 / 0.12)"
  violet-line: "rgb(198 156 240 / 0.4)"
  stage-breakout: "#a3e8b9"
  stage-early-bear: "#ec9fcf"
  stage-breakdown: "#f2a46f"
  bg: "#141517"
  bg-sunken: "#101113"
  surface: "#1a1c1f"
  surface-2: "#212328"
  surface-3: "#282b31"
  surface-hover: "#25282d"
  surface-rail: "#17181b"
  border: "#2e3137"
  border-subtle: "#25282d"
  border-strong: "#3d414a"
  border-control: "#666c76"
  text: "#e4e6e9"
  text-2: "#a8adb5"
  text-3: "#8d929b"
  text-inverse: "#101113"
  neutral-soft: "rgb(168 173 181 / 0.08)"
  constellation-steel: "#8a94a3"
  constellation-slate: "#5b6472"
typography:
  display:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 1.2rem + 3.6vw, 4.25rem)"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.05em"
    fontFeature: "c2sc, smcp"
  body:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  label:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0em"
  caption:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  figure-kpi:
    fontFamily: "Atkinson Hyperlegible Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "1.5rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.03em"
    fontFeature: "tnum, zero"
  figure:
    fontFamily: "Atkinson Hyperlegible Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.94em"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.01em"
    fontFeature: "tnum, zero"
rounded:
  xs: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text-inverse}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-strong}"
    textColor: "{colors.text-inverse}"
  button-secondary:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.bear}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-danger-hover:
    backgroundColor: "{colors.bear-soft}"
    textColor: "{colors.bear}"
  input:
    backgroundColor: "{colors.bg-sunken}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "16px"
  panel-title:
    textColor: "{colors.text-2}"
    typography: "{typography.title}"
    padding: "8px 16px"
    height: "40px"
  stat:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.figure-kpi}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  badge:
    backgroundColor: "{colors.neutral-soft}"
    textColor: "{colors.text-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "0 6px"
    height: "20px"
  badge-bull:
    backgroundColor: "{colors.bull-soft}"
    textColor: "{colors.bull}"
  badge-bear:
    backgroundColor: "{colors.bear-soft}"
    textColor: "{colors.bear}"
  badge-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
  badge-violet:
    backgroundColor: "{colors.violet-soft}"
    textColor: "{colors.violet}"
  table-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-3}"
    typography: "{typography.title}"
    height: "32px"
  table-row:
    textColor: "{colors.text}"
    typography: "{typography.body}"
    height: "32px"
    padding: "0 12px"
  table-row-selected:
    backgroundColor: "{colors.accent-soft}"
  nav-link:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  nav-link-active:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  sync-step:
    backgroundColor: "{colors.bg-sunken}"
    rounded: "{rounded.sm}"
    padding: "12px"
---

# Design System: AlphaLens

## Overview

**Creative North Star: "Konsol Grafit"**

AlphaLens adalah permukaan kerja, bukan etalase. Dasar grafit matte, panel yang dipisah seam 1px, dan warna yang hanya muncul ketika ada status untuk dilaporkan: biru untuk info, fokus, dan aksi utama; hijau untuk LONG/bullish; merah untuk SHORT/bearish dan aksi destruktif; amber untuk waspada, basi, atau simulasi; violet untuk metadata. Peneliti memercayai angka karena tidak ada yang dihias. Kepadatannya kepadatan konsol pengembang: baris tabel 32px, teks dasar 13px, angka mono tabular yang sejajar di setiap kolom.

Dunia ini menggantikan "Neural Aurora" lama sepenuhnya. Kaca, blur, glow, gradien dekoratif, dan neon tidak lagi ada di sistem. Nama token lama masih ada di `tokens.css` hanya sebagai alias kompatibilitas yang nilainya sudah diratakan (lihat Do's and Don'ts). Kedalaman datang dari tangga nada permukaan grafit, bukan dari cahaya.

Gerak menandai perubahan status, bukan dekorasi. Hanya satu garis yang benar-benar berjalan: garis sync di tepi bawah topbar, dan itu pun hanya saat scanner nyata aktif. Selebihnya, panel membuka sepanjang satu sumbu, baris baru meluncur masuk sekali, meter skor tumbuh ke nilai nyata, dan rasi grafit di latar bergerak pelan dengan opasitas rendah. Semua gerak padam di `prefers-reduced-motion` dan ketika pengguna mematikan "Animasi latar".

**Key Characteristics:**
- Dark-first, matte. Lima anak tangga permukaan grafit dengan seam 1px sebagai satu-satunya pemisah struktural.
- Warna adalah sinyal status, tidak pernah ornamen. Satu isian biru solid per layar: aksi utama.
- Atkinson Hyperlegible Next untuk UI, Atkinson Hyperlegible Mono tabular untuk setiap angka.
- Judul panel, judul kolom, dan judul kelompok navigasi dalam small caps.
- Radius kecil (2–6px), bayangan hanya untuk lapisan yang benar-benar melayang.
- Pipeline tahap (langkah sync bersambung) sebagai gerak khas.

## Colors

Grafit netral berlapis dengan lima aksen turunan warna sintaks yang masing-masing memegang satu makna status.

### Primary
- **Biru Sintaks** (accent): info, fokus, tautan, tahap EARLY_BULLISH, dan isian tombol aksi utama. Satu-satunya warna yang boleh menjadi isian solid tombol.
- **Biru Sintaks Terang** (accent-strong): hover tombol utama saja.
- **Kabut Biru** (accent-soft) dan **Garis Biru** (accent-line): latar baris terpilih, cincin lembut fokus input, track bar progres, garis pindai statis.

### Secondary
- **Hijau Konfirmasi** (bull): arah LONG, delta naik, status ok, langkah sync selesai, tahap MOMENTUM_BUILDING LONG.
- **Merah Pembatalan** (bear): arah SHORT, delta turun, error, aksi destruktif, tahap INVALIDATED.
- **Amber Waspada** (warn): data basi, peringatan, dan penanda simulasi atau candle berjalan.
- Masing-masing punya varian `-soft` (isian 12%) untuk latar badge dan `-line` (40%) untuk garis badge serta sambungan langkah.

### Tertiary
- **Violet Metadata** (violet): label model/metadata dan garis EMA25 pada grafik. Tidak pernah menandai arah pasar.
- **Tangga tahap sinyal**: Hijau Mint Puncak (stage-breakout) untuk BREAKOUT, Merah Muda Dini (stage-early-bear) untuk EARLY_BEARISH, Jingga Patahan (stage-breakdown) untuk BREAKDOWN. Tahap lain meminjam aksen di atas atau teks sekunder/tersier.

### Neutral
- **Grafit Dasar** (bg): latar halaman dan topbar.
- **Grafit Cekung** (bg-sunken): isi input, kontrol segmen, sel langkah sync, bidang grafik.
- **Panel Grafit** (surface), **Grafit Terangkat** (surface-2), **Grafit Puncak** (surface-3): panel, tombol default dan hover, opsi segmen terpilih, track meter. Hover baris tabel memakai surface-hover; rail navigasi memakai surface-rail.
- **Seam** (border): garis 1px antarpanel dan di bawah header panel. border-subtle untuk garis baris tabel; border-strong untuk tombol, badge netral, dan header kolom; border-control (≥ 3:1) untuk input, switch, dan penanda langkah.
- **Teks Utama** (text), **Teks Sekunder** (text-2), **Teks Tersier** (text-3): semuanya ≥ 4.5:1 terhadap bg, surface, dan surface-2. text-inverse adalah teks di atas isian aksen.
- **Baja Rasi** (constellation-steel) dan **Batu Tulis Rasi** (constellation-slate): hanya untuk canvas latar animasi.

Catatan divergensi: kontrak arah menulis seam #2c2f35 dan teks #e3e5e8 / #a2a7af. Build mengirim nilai di frontmatter (dihitung ulang untuk kontras), dan build yang berlaku. Di `prefers-contrast: more`, text-2, text-3, dan keempat border dinaikkan satu tingkat.

### Named Rules
**The Status-Only Rule.** Warna hanya dipakai bila ada status yang dilaporkan. Panel, judul, dan latar tetap grafit; sebuah elemen tanpa makna status tidak mendapat aksen.

**The One Fill Rule.** Isian biru solid hanya untuk aksi utama, satu per layar. Tombol lain bergaris atau transparan.

**The Small Marker Rule.** Nada panel, KPI, dan toast ditandai dengan kotak 7px (radius 1px) di depan judul atau label, bukan dengan border atau latar berwarna.

## Typography

**Display Font:** Atkinson Hyperlegible Next (fallback ui-sans-serif, system-ui)
**Body Font:** Atkinson Hyperlegible Next
**Label/Mono Font:** Atkinson Hyperlegible Mono (fallback ui-monospace, SFMono-Regular, Menlo)

**Character:** Satu keluarga yang dirancang untuk keterbacaan, dipilih karena membedakan 0/O, 1/l/I, dan 5/S pada ticker dan angka yang dibaca berjam-jam. Sans untuk prosa dan kontrol, mono untuk data. Keduanya self-hosted (woff2, OFL, `font-display: swap`).

### Hierarchy
- **Display** (600, clamp 36–68px, 1): judul besar halaman awal saja, rata kiri, maksimal 14ch.
- **Headline** (600, 22px, 1.2): judul halaman di header halaman. Subjudul di bawahnya teks sekunder, maksimal 28rem.
- **Title** (600, 14px, small caps, tracking 0.05em): judul panel, judul kelompok rail, dan (13px, tracking 0.03em) judul kolom tabel. Judul topbar memakai ukuran yang sama tanpa small caps.
- **Body** (400, 13px, 1.5): teks dasar terminal, sel tabel, input, tombol.
- **Label** (500, 12px): label field, label KPI, status, tahap. Caption (11px) untuk petunjuk, badge, dan hint.
- **Figure KPI** (mono 500, 24px, 1, -0.03em, tabular + slashed zero): nilai utama kartu statistik.
- **Figure** (mono, 0.94em relatif ke konteks, tabular + slashed zero): setiap angka lain: harga, skor, delta, jam, hitungan.

### Named Rules
**The Mono Figure Rule.** Setiap angka dirender dalam Atkinson Hyperlegible Mono dengan `tabular-nums slashed-zero`. Bila nilai KPI mencampur angka dan kata ("12 menit lalu"), kata satuannya kembali ke sans 13px sekunder; hanya angkanya yang mono. Prosa tidak pernah mono.

**The Small Caps Rule.** Judul struktural (panel, kolom, kelompok navigasi) memakai small caps sungguhan, bukan kapital penuh dan bukan label mono.

## Layout

Kerangka aplikasi adalah grid dua kolom: rail navigasi 224px (56px saat diciutkan) di kiri, topbar sticky 48px di atas, konten maksimal 1600px. Rail berisi kelompok berjudul small caps dan tautan setinggi 32px; topbar memuat breadcrumb, judul layar, status scanner, jam mono, dan tombol "Animasi latar". Header halaman menaruh judul dan subjudul jujur di kiri, kontrol scanner terisolasi di kanan, dipisah dari isi oleh seam bawah.

Ritme spasi berbasis 4px (4, 8, 12, 16, 20, 24, 32, 40, 48). Celah antarpanel dan antarbagian halaman 16px; padding dalam panel 16px; header panel 8px × 16px dengan tinggi minimal 40px. Baris tabel 32px (26px untuk tabel ringkas), header kolom sticky dan opak. Detektor mencatat dua catatan spasi monoton yang bersifat anjuran; keduanya diterima sebagai akibat ritme padat ini, bukan aturan untuk ditiru di luar tempatnya.

Responsif: di bawah 1100px grid tiga kolom menjadi dua dan tata letak utama-samping menjadi satu kolom. Di bawah 820px rail menjadi laci geser (maksimal 280px atau 86vw) dengan bayangan dan scrim, konten mendapat padding 16px. Langkah 640px dan 480px menumpuk toolbar dan kontrol.

## Elevation & Depth

Sistem ini datar dan bertingkat nada. Kedalaman di permukaan kerja datang dari tangga grafit (bg-sunken → bg → surface → surface-2 → surface-3) dan seam 1px. Bayangan hanya dipakai untuk elemen yang benar-benar melayang di atas konten; bayangannya jatuh ke bawah (offset + blur), tidak pernah berupa glow.

### Shadow Vocabulary
- **Lapisan melayang** (`box-shadow: 0 10px 24px -10px rgb(0 0 0 / 0.55)`): toast dan tooltip grafik Overview.
- **Lapisan modal** (`box-shadow: 0 18px 44px -14px rgb(0 0 0 / 0.65)`): laci navigasi mobile dan kartu login.
- **Cincin fokus** (`box-shadow: 0 0 0 2px #141517, 0 0 0 4px #74b9ff`): setiap fokus keyboard; di forced-colors diganti outline `Highlight`.

### Named Rules
**The Flat Panel Rule.** Panel, kartu statistik, dan tabel tidak pernah berbayang. Bila sesuatu perlu menonjol, naikkan satu anak tangga permukaan atau pertegas seamnya.

**The Muted Constellation Rule.** Canvas rasi grafit di latar tetap ada sebagai satu-satunya atmosfer, pada opasitas 0.55 (0.3 bila animasi dimatikan), tanpa halo atau glow, dan disembunyikan saat dicetak.

## Shapes

Bentuknya persegi dengan sudut yang sedikit dilunakkan. Radius 2px untuk badge, opsi segmen, dan skeleton; 4px untuk tombol, input, tautan rail, sel langkah sync; 6px untuk panel, kartu statistik, callout, dan toast; 8px hanya untuk wadah lipat besar (panel mesin lama di Reversal Radar). Bentuk pil (999px) hanya untuk switch dan thumb scrollbar; titik status dan penanda tahap berupa lingkaran 6–7px.

Garis adalah alat utama: seam 1px antarpanel, garis 1px bernada di tepi kiri sel pertama untuk baris terpilih (aksen) atau baris provisional (amber), dan garis putus-putus 1px untuk aksi destruktif. Track meter skor tingginya 4px dengan radius 1px.

## Components

### Buttons
Tegas dan pendiam: kontrol konsol, bukan ajakan pemasaran.
- **Shape:** sudut lunak kecil (4px), tinggi 32px (26px untuk ukuran kecil, 38px untuk tombol blok di login).
- **Default:** surface-2 dengan garis border-strong, teks utama 500.
- **Primary:** isian accent, teks text-inverse 600. Satu per layar.
- **Hover / Focus:** default naik ke surface-3 dengan garis border-control; primary ke accent-strong. Transisi warna 120ms. Ditekan bergeser 0.5px. Fokus memakai cincin fokus global.
- **Ghost:** transparan, teks sekunder; hover mendapat surface-2.
- **Danger:** transparan dengan garis putus-putus bear-line dan teks bear; menjadi garis solid dengan latar bear-soft saat hover atau fokus. Selalu terisolasi dari aksi lain.
- **Disabled:** opasitas 0.45; `aria-disabled` tetap dapat difokus tetapi tidak bereaksi.

### Chips (Badge, Tahap, Status)
- **Badge:** tinggi 20px, radius 2px, caption 600 tracking 0.02em. Netral memakai neutral-soft dan border-strong; varian bull/bear/warn/accent/violet memakai pasangan -soft dan -line warnanya.
- **Tahap sinyal:** label 12px berwarna tahap dengan titik 6px di depannya. QUIET dan EXPIRED bertitik berongga; INVALIDATED dicoret tipis; BREAKOUT dan BREAKDOWN tebal dengan cincin tipis yang mengembang. SHORT dan LONG adalah cermin warna.
- **Status:** titik 7px (ok hijau, warn amber, error merah, idle berongga) dengan teks sekunder; status live mendapat cincin berdenyut.
- **Kontrol segmen:** wadah bg-sunken bergaris border-strong; opsi terpilih naik ke surface-3 dengan garis border-control.

### Cards / Containers
- **Corner Style:** 6px.
- **Background:** surface, tanpa bayangan (lihat Elevation & Depth).
- **Border:** seam 1px; header panel dipisah seam bawah, footer dipisah seam atas dengan teks tersier 12px.
- **Internal Padding:** 16px untuk isi, 8px × 16px untuk header; varian flush tanpa padding untuk tabel.
- **Kartu statistik:** label 12px sekunder (dengan kotak nada opsional), nilai Figure KPI, hint caption tersier. Saat menghitung naik ke nilai nyata, nilai berwarna sekunder.
- **Callout:** latar campuran 7% nada + surface, garis 34% nada, radius 6px. Bilah kontrol scanner adalah callout netral yang tidak pernah dilepas.

### Inputs / Fields
- **Style:** bg-sunken, garis 1px border-control, radius 4px, tinggi 32px, padding 12px.
- **Focus:** garis berubah ke accent dengan cincin lembut 3px accent-soft.
- **Error / Disabled:** garis bear dengan cincin bear-soft; disabled opasitas 0.55. Label field 12px sekunder, petunjuk caption tersier, pesan error 12px bear.
- **Switch:** pil 34 × 20px; aktif bergaris accent di atas accent-soft dengan thumb accent.

### Navigation
- **Rail:** surface-rail dengan seam kanan. Judul kelompok small caps tersier 13px. Tautan 32px, teks sekunder 500, ikon 18px; hover surface-2; halaman aktif mendapat surface-2, garis seam, teks utama, dan ikon biru.
- **Topbar:** bg dengan seam bawah, judul 14px 600, breadcrumb tersier dengan pemisah "/", jam mono.
- **Mobile:** di bawah 820px rail menjadi laci geser dari kiri dengan bayangan modal dan scrim; laci tertutup dibuat inert.

### Data Table
Pusat dari setiap layar pemindai.
- Baris 32px, garis bawah border-subtle, hover surface-hover. Header kolom sticky opak, small caps tersier, dengan panah sort yang menjadi biru saat aktif.
- Kolom angka rata kanan dan mono tabular.
- **Baris terpilih:** latar accent-soft plus garis 1px accent di tepi kiri sel pertama. Di forced-colors, latar dan bayangan hilang, jadi garis kiri 4px `Highlight` menggantikannya; garis 4px itu hanya ada di mode tersebut.
- **Baris baru** meluncur masuk sekali dari kiri (6px, 320ms, berjenjang 18ms per baris hingga 16 baris); meter skor hanya beranimasi pada baris baru, bukan setiap polling.

### Score Meter
Angka mono 28px lebar diikuti track 56 × 4px. Isian tumbuh dari nol ke nilai nyata (600ms), berwarna accent secara default, atau bull/warn/bear sesuai nada. Skor adalah kecocokan aturan 0–100, bukan probabilitas.

### Sync Pipeline (Signature)
Gerak khas Konsol Grafit: proses sync scanner dan mesin tahap digambar sebagai sel langkah tersambung. Tiap langkah adalah sel bg-sunken bergaris seam dengan penanda lingkaran 18px, disambung garis 1px (hijau setelah selesai). Selesai: penanda hijau penuh bercentang. Aktif: sel bergaris accent dan penanda bercincin aksen yang berputar pelan. Live: titik hijau dengan denyut. Berikutnya: penanda kosong. Halaman awal memakai pipeline yang sama sebagai ilustrasi berlabel "bukan data langsung".

### Topbar Sync Line
Satu-satunya garis yang bergerak di sistem: garis 1px accent selebar 32% di tepi bawah topbar, berjalan kiri ke kanan setiap 2.8 detik. Garis ini hanya tampil saat `:root[data-scanner="active"]`, yaitu ketika status API menyatakan scanner benar-benar berjalan. Di tempat lain, garis pindai berupa garis aksen 1px statis.

### Indeterminate Progress
Bar 2px berlatar accent-soft dengan sapuan accent 36% yang berjalan (1.3 detik). Dipakai di tiga tempat untuk perintah scanner yang durasinya tidak diketahui. Ini animasi fungsional: tetap berjalan saat "Animasi latar" mati, dan menjadi bar penuh statis (opasitas 0.6) di `prefers-reduced-motion`.

### Simulation & Provisional Marker
Garis-garis diagonal 135° adalah penanda semantik untuk data yang disimulasikan atau candle yang belum tertutup, dan hanya dipakai untuk itu. Pita SIMULASI di Smart Money: garis putus-putus amber, garis-garis warn-soft 12px, label amber solid. Baris provisional di Reversal Radar: garis-garis amber 5% tipis, garis 1px amber di tepi kiri, angka miring.

### Toast
surface-2 bergaris border-strong, radius 6px, bayangan lapisan melayang, kotak nada 7px, masuk dari kanan 16px, dan garis sisa waktu 1px bernada di tepi bawah yang menyusut selama 4 detik.

## Do's and Don'ts

### Do:
- **Do** rujuk hanya variabel `--lr-*` dari `tokens.css`; komponen tidak menulis warna mentah.
- **Do** render setiap angka dengan Atkinson Hyperlegible Mono `tabular-nums slashed-zero`, dan biarkan kata satuan di nilai KPI tetap sans.
- **Do** pisahkan panel dengan seam 1px dan naikkan anak tangga grafit untuk hierarki, bukan bayangan.
- **Do** tandai nada dengan kotak 7px, titik status, badge -soft/-line, atau garis 1px di tepi sel, sesuai pola yang sudah ada.
- **Do** isolasi aksi destruktif dengan garis putus-putus merah dan pisahkan dari aksi utama.
- **Do** ikat setiap gerak berulang ke keadaan nyata (scanner aktif, data live, perintah diproses), dan tambahkan aturan `:root[data-motion="off"|"reduced"]` untuk setiap animasi dekoratif baru.
- **Do** pakai garis-garis diagonal amber hanya untuk data simulasi atau candle berjalan.

### Don't:
- **Don't** pakai kaca, backdrop blur, glow, neon, atau gradien dekoratif; dunia Neural Aurora sudah pensiun.
- **Don't** pakai alias lama `--lr-glass-*`, `--lr-blur-*`, `--lr-glow-*`, `--lr-gradient-*`, `.glass`, `.gradient-text`, `.btn--neural`, atau keyframes `lr-float` / `lr-hue-drift` di kode baru. Nilainya sudah diratakan hanya agar CSS lama tetap terbaca; token `--lr-neural-*` hanya untuk canvas latar.
- **Don't** menambah garis bergerak kedua; garis sync topbar adalah satu-satunya, dan hanya saat scanner nyata berjalan.
- **Don't** beri panel, kartu statistik, atau tabel bayangan atau border berwarna penuh.
- **Don't** pakai isian aksen solid untuk apa pun selain aksi utama.
- **Don't** pakai warna untuk dekorasi: biru, hijau, merah, amber, dan violet masing-masing hanya membawa makna statusnya.
- **Don't** set prosa dalam mono, dan jangan ganti judul small caps dengan kapital penuh.
