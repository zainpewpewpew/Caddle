# 17 — Panduan Insider / Smart Money Radar

Panduan untuk pemilik aplikasi: cara membaca halaman Smart Money, arti angkanya, batas datanya, dan cara mengaktifkan
data live **gratis** di Mac. Dokumen pendukung: [14 — riset sumber data & metodologi](14-riset-smart-money.md),
[15 — kontrak modul](15-kontrak-smart-money.md).

Fitur ini dibuat untuk menjawab satu pertanyaan:

> **Wallet berkualitas mana yang sedang masuk ke token apa, seberapa kuat buktinya, dan apakah aktivitas itu relevan
> untuk saya pantau?**

| Bagian pertanyaan | Tempat menjawabnya | Yang dibaca |
| --- | --- | --- |
| Wallet berkualitas mana? | **Wallet Discovery** → **Profil Wallet** | Skor wallet 0–100, *Eligible*, flag risiko, kelengkapan PnL |
| …sedang masuk ke token apa? | **Smart Money Radar** | Token yang dibeli **lewat swap** dalam jendela 1 jam–7 hari |
| Seberapa kuat buktinya? | Radar → tombol **Bukti**, **Detail Token**, panel **Evaluasi historis radar** | Skor keyakinan + komponennya, pembeli independen, tx yang bisa dicek di explorer, risiko |
| Relevan untuk saya pantau? | Blok **Binance** di Radar/Detail Token, chip **SM ×N** di LONG Scanner, **Watchlist & Alerts** | Status MATCHED, relevansi TINGGI/SEDANG/RENDAH, sinyal LONG 5m/15m/1h |

**Alur 5 menit:** buka Smart Money Radar (jendela 24 jam, nyalakan *Hanya yang terhubung ke Binance*) → pilih kartu
berstatus **Akumulasi** dengan ≥ 3 pembeli independen → tekan **Bukti** dan buka beberapa tx di explorer → baca
relevansi & sinyal LONG, lalu **Buka chart** → **Ikuti token** bila layak dipantau (notifikasi masuk ke Watchlist &
Alerts).

## 1. Apa fitur ini — dan bukan apa

Fitur ini **membaca** riwayat swap wallet on-chain publik (EVM), menilai kualitas wallet dari trade yang sudah tertutup,
lalu menunjukkan token yang sedang mereka akumulasi beserta buktinya.

- **Baca saja.** Tidak mengirim transaksi atau order, bukan copy-trading. Yang dipakai hanya alamat publik.
- **Tidak pernah meminta seed phrase atau private key.** Satu-satunya kunci exchange adalah kunci Binance **read-only**
  yang **opsional** untuk memetakan kontrak token ke pasar Binance (tanpa kunci dipakai daftar publik Binance, §5a).
  Siapa pun yang meminta seed phrase "untuk fitur ini" adalah penipu.
- **"Insider" hanya nama fitur.** Tidak ada kesimpulan bahwa pemilik wallet punya informasi orang dalam.
- **Skor bukan probabilitas profit.** Skor wallet dan skor keyakinan adalah ringkasan bukti yang dapat dijelaskan;
  bobotnya hipotesis awal yang belum dikalibrasi (lihat §4).
- **Spot on-chain ≠ posisi futures.** Pembelian di DEX tidak memberi tahu posisi futures siapa pun di Binance; posisi
  pribadi trader di exchange tidak dapat diketahui dari wallet publik.
- **Label & klaster adalah dugaan berbukti**, bukan identitas pemilik wallet.

## 2. Halaman per halaman

Menu **Smart Money** di sidebar: Smart Money Radar, Wallet Discovery, Watchlist & Alerts. Profil Wallet dan Detail
Token dibuka lewat tautan alamat wallet/token di halaman lain.

**Strip status di atas setiap halaman:**

- **Kesegaran** = waktu aktivitas on-chain terbaru yang tersimpan; **Sinkron terakhir** = kapan sumber data terakhir
  berhasil dihubungi.
- Badge **BASI** = sinkron sukses terakhir lebih tua dari `SMART_MONEY_STALE_MINUTES` (bawaan 60 menit) atau belum pernah.
- **Cakupan** (chain · wallet · aktivitas), **Provider** (jumlah terkonfigurasi), **Sumber data** (atribusi wajib, §5g).
- Pita **DATA SIMULASI** bila ada data simulasi (§3). Tanpa provider aktif tampil "Belum ada sumber data on-chain" —
  tidak pernah data contoh.

### 2.1 Smart Money Radar

Token yang sedang dibeli lewat swap oleh wallet *eligible* yang tidak ber-flag pengecuali. Kartu diurutkan dari skor
keyakinan tertinggi.

| Filter | Pilihan |
| --- | --- |
| Jendela | 1 jam · 4 jam · **24 jam** (bawaan) · 7 hari |
| Chain | Semua atau satu chain |
| Min. pembeli independen | ≥ 2 / 3 / 5 / 10 |
| Status | Akumulasi · Campuran · Distribusi · Keluar |
| Hanya yang terhubung ke Binance | Hanya token berstatus MATCHED (§2.4) |

| Isi kartu | Arti |
| --- | --- |
| Simbol · chain · kontrak | Identitas token = **chain + alamat kontrak** (tautan ke explorer) |
| Skor keyakinan (bukan probabilitas) | 0–100, lihat tabel komponen di bawah |
| Pembeli independen "N dari M" | M wallet pembeli dari N klaster berbeda (wallet satu klaster = satu pembeli) |
| Net flow · Gross beli · Gross jual | USD swap beli/jual dalam jendela; "—" = nilai USD tidak diketahui (**bukan 0**) |
| Perubahan kepemilikan | Perubahan total saldo token milik wallet yang dihitung, selama jendela |
| Indikasi keluar · Tx tanpa nilai USD | Jumlah sinyal keluar; swap yang nilai USD-nya tidak diketahui (tidak dijumlahkan) |
| Blok Binance | Status pencocokan, relevansi, sinyal LONG per timeframe, tombol **Buka chart** |

| Status | Kapan |
| --- | --- |
| Akumulasi | Ada pembeli, porsi jual ≤ 20 %, dan porsi wallet keluar < 25 % |
| Campuran | Selain tiga status lain |
| Distribusi | Tidak ada pembeli, atau porsi jual ≥ 60 % |
| Keluar | Ada wallet yang keluar penuh, atau porsi wallet keluar ≥ 50 % |

Porsi jual = USD jual / (USD beli + USD jual); bila nilai USD < 80 % lengkap, dipakai jumlah swap. Porsi wallet keluar =
wallet yang keluar penuh (bobot 1) atau hanya mendeposit ke exchange (bobot ½), dibagi wallet aktif.

**Skor keyakinan** = komponen berbobot dikurangi penalti, dibatasi 0–100:

| Komponen | Bobot | Mengukur |
| --- | --- | --- |
| Lebar (klaster independen) | 30 | Jumlah pembeli independen (penuh di 5) |
| Kualitas wallet | 25 | Rata-rata skor wallet pembeli (satu klaster dihitung sekali) |
| Aliran bersih | 20 | USD beli − jual, skala log (penuh di $1 jt); 0 bila negatif atau nilai USD < 80 % lengkap |
| Akumulasi berulang | 15 | Porsi pembeli yang membeli ≥ 2 kali |
| Kebaruan | 10 | Seberapa baru pembelian terakhir dalam jendela |
| Penalti indikasi keluar | s.d. −40 | Porsi jual atau porsi wallet yang keluar (yang terbesar) |
| Penalti dominasi satu klaster | s.d. −25 | Satu klaster > 50 % pembeli atau USD beli |

**Tombol Bukti** membuka:

- Tabel pembeli: wallet (+ label bersumber), skor wallet, klaster ("mandiri" atau "1 klaster · N pembeli"), net beli,
  jumlah beli/jual, dan setiap tx (jenis, USD, waktu, tautan explorer — buka beberapa untuk memastikan).
- Baris **"tidak dihitung sebagai pembelian"**: jumlah transfer masuk, penarikan exchange, bridge, airdrop, LP, mint.
- **Indikasi keluar**, **Alasan**, **Risiko**, bar **komponen skor keyakinan**, dan penafian.

**Yang TIDAK dihitung beli.** Hanya *swap* (dalam satu tx wallet mengirim token A dan menerima token B) yang menjadi
beli/jual. Transfer masuk, penarikan dari exchange, bridge, airdrop/klaim, mint, tambah/tarik likuiditas (LP), dan swap
antar aset quote (mis. USDC → WETH, bungkus ETH) tidak pernah menjadi pembelian di radar.

| Indikasi keluar | Arti |
| --- | --- |
| Swap jual | Penjualan via swap |
| Deposit ke exchange | Dipindah ke exchange — **belum tentu dijual** (bobot setengah) |
| Keluar penuh | Kepemilikan wallet turun ≥ 90 % dari puncaknya lewat swap jual/deposit exchange |

Transfer keluar, LP, bridge, atau burn hanya dicatat sebagai risiko "dipindah, belum tentu dijual" dan tidak mengubah
status.

**Relevansi ke LONG Scanner.** Hanya token **MATCHED** yang ditautkan ke sinyal LONG aktif 5m/15m/1h lewat simbol
futures-nya. Per timeframe tampil tier, tahap, dan **pola favorit**: *kenaikan perlahan volume rendah (SA)*, *akumulasi
volume progresif (PVA)*, *breakout akumulasi*, *higher low (struktur naik)*, *kompresi volatilitas (squeeze)*.

| Relevansi | Syarat |
| --- | --- |
| TINGGI | Keyakinan ≥ 60 **dan** ada sinyal LONG tier A/B |
| SEDANG | Hanya salah satu dari keduanya |
| RENDAH | Hanya MATCHED — juga untuk status Distribusi/Keluar, berapa pun skornya |
| Tidak terhubung | Kontrak tidak MATCHED — tidak ditautkan ke screener |

**Buka chart** membuka Symbol Intelligence simbol futures itu (15m, LONG). Panel **Evaluasi historis radar** di bawah
halaman dijelaskan di §4.

#### Tombol Sync sekarang

Tombol **Sync sekarang** di kepala halaman Radar menjalankan satu putaran sinkronisasi saat itu juga, tanpa menunggu
jadwal otomatis. Hanya admin yang dapat menekannya; pengguna lain melihat progres dan hasilnya.

- **Progres:** bar dan teks tahap — *Menyiapkan* → *Pemetaan kontrak Binance* → *Penemuan wallet* → *Riwayat transaksi
  wallet* (mis. 12/50 wallet) → *Menghitung skor & radar* → *Menyusun alert*. Putaran berjalan di server; halaman boleh
  ditinggal, dan progresnya muncul lagi saat Radar dibuka kembali.
- **Hasil:** status (*Berhasil*, *Selesai dengan catatan*, *Gagal*, *Dihentikan*, *Belum ada sumber data*), jumlah
  wallet tersinkron, transfer diambil, aktivitas baru, wallet baru, dan alert baru, ditambah catatan & error per
  provider. Data Radar dimuat ulang otomatis dengan filter dan tampilan (Daftar / Peta Benang) yang sedang dipakai.
- **Satu putaran dalam satu waktu.** Saat scanner berjalan, worker juga menyinkronkan otomatis tiap 15 menit
  (`SMART_MONEY_SYNC_MINUTES`). Bila putaran terjadwal itu sedang berjalan, tombol menampilkan progresnya alih-alih
  memulai putaran kedua; sebaliknya, putaran terjadwal yang bertemu sync manual dilewati dan dicoba lagi semenit
  kemudian. Kuota API tidak terpakai dua kali.
- **Jeda 30 detik** setelah putaran terakhir selesai sebelum tombol bisa ditekan lagi (hitung mundur tampil di tombol).
  Tiap putaran memakai kuota harian Etherscan yang sama (paket gratis 100.000 panggilan/hari), jadi tidak perlu
  ditekan berulang-ulang.
- Tombol abu-abu dengan keterangan *Belum ada sumber data* berarti belum ada provider aktif: isi `ETHERSCAN_API_KEY`
  di `.env` (§5) lalu restart `npm start`.
- Kunci Binance **tidak wajib** untuk *Penemuan wallet* (§5a). Hanya dengan `ETHERSCAN_API_KEY`, pemetaan kontrak
  diambil dari daftar publik Binance (`binance-public`, tanpa kunci) dan wallet baru ditemukan dari pembeli token yang
  listing di Binance. Bila daftar publik gagal atau belum memuat token MATCHED, penemuan memakai cadangan **token
  trending GeckoTerminal** di satu chain per putaran (bergiliran). Baris hasil *Penemuan wallet* menyebut jalurnya:
  - *Penemuan wallet (token listing Binance): …* — kandidat dari pembeli token MATCHED.
  - *Penemuan wallet (token trending GeckoTerminal di base — belum tentu listing Binance): …* — jalur cadangan; wallet
    temuannya belum tentu pernah membeli token yang ada di Binance.
  - *Penemuan wallet: …* tanpa keterangan — penemuan tidak berjalan pada putaran itu (lihat catatan hasil); hanya
    wallet yang sudah dilacak, termasuk watchlist, yang diperbarui.

  Baris *Pemetaan Binance (publik, tanpa kunci): N kontrak diperbarui* berarti mapping berasal dari daftar publik;
  tanpa keterangan "(publik…)" berarti dari kunci read-only (§5c).

#### Peta Benang

Tombol **Daftar | Peta Benang** di atas hasil radar menampilkan data yang sama sebagai graf: wallet di kiri, token di
kanan, dan satu benang per pasangan wallet → token. Pilihan tersimpan di alamat halaman (`#/smart-money?view=benang`),
jadi tetap terbuka setelah reload. Filter radar (jendela, chain, dan lainnya) tetap berlaku.

- **Warna benang:** hijau = beli via swap; merah/jingga = indikasi keluar (jual via swap atau setor ke exchange — setoran
  ke exchange *belum tentu dijual*). Benang putus-putus = nilai USD tidak diketahui (tidak pernah dianggap 0).
- **Tebal benang** mengikuti nilai net beli USD (skala log). **Wallet tertaut** (satu klaster, mis. `K1`) dikelompokkan
  dan dihitung sebagai satu pembeli independen.
- Arahkan kursor atau fokus keyboard ke wallet/token untuk menyorot benangnya. Klik benang untuk panel **Bukti benang**
  (jumlah beli/jual, net USD, waktu, link transaksi). Klik wallet/token untuk membuka profil atau detail token.
- Agar tetap terbaca, peta menampilkan token dengan skor keyakinan tertinggi dan wallet terbaiknya, dengan keterangan
  "Menampilkan X dari Y". Animasi aliran benang mati bila sistem meminta gerak dikurangi.

### 2.2 Wallet Discovery

Daftar wallet yang dilacak, urut skor tertinggi. Filter: chain, gaya (Scalper: median lama pegang < 1 jam, Swing:
< 7 hari, Posisi: ≥ 7 hari, Campuran), skor minimum, **Hanya eligible** (bawaan nyala), **Tampilkan wallet ber-flag**
(bawaan mati).

Wallet ditemukan dari pembeli bernilai besar (bawaan ≥ $1.000) di pool token yang MATCHED di Binance dalam 24 jam
terakhir (GeckoTerminal), lalu dinilai **dari riwayat swap-nya sendiri**. Bila belum ada token MATCHED sama sekali,
dipakai pool token **trending** GeckoTerminal (sumber `geckoterminal-trending`, alasan "belum tentu listing Binance").
Alamat temuan adalah pengirim transaksi — bisa relayer, bot, atau aggregator — jadi cara ditemukan bukan bukti kualitas.

**Cara peringkat (skor wallet 0–100):**

| Komponen | Bobot | Ringkas |
| --- | --- | --- |
| Profitabilitas | 30 % | Return per trade (dipangkas di +200 %), nilai **terkecil** antara rata-rata dan rata-rata tanpa trade terbaik, × n/(n+10) |
| Konsistensi mingguan | 25 % | Porsi minggu dengan PnL realisasi positif, ditarik ke 50 % bila minggunya sedikit |
| Ukuran sampel | 15 % | n/(n+20), n = trade tertutup |
| Risiko (drawdown) | 15 % | Drawdown maksimum kurva PnL realisasi + kerugian trade terburuk |
| Diversifikasi | 10 % | Jumlah token; penalti bila > 60 % PnL dari satu token |
| Lama riwayat | 5 % | Penuh di 180 hari |

Total dikalikan faktor kelengkapan PnL (0,5 + 0,5 × kelengkapan). Bobot = hipotesis awal.

**Kenapa bukan saldo, win rate, atau satu trade beruntung:**

- **Saldo tidak dibaca sama sekali** — saldo besar bisa milik exchange, treasury, atau whale pasif.
- **Win rate hanya informasi** — mudah dipoles dengan banyak profit kecil plus satu rugi besar.
- **Satu trade beruntung tidak bisa mendominasi** — dengan satu trade, "rata-rata tanpa trade terbaik" = 0 sehingga
  profitabilitas 0; return ekstrem dipangkas; sampel kecil ditarik ke 0.

**Syarat *Eligible*** (hanya wallet eligible yang masuk radar): ≥ 10 trade tertutup, ≥ 3 token, riwayat ≥ 30 hari,
kelengkapan PnL ≥ 50 %, tanpa flag pengecuali ber-severity HIGH, bukan Airdrop farmer HIGH.

| Chip | Kode | Arti | Efek |
| --- | --- | --- | --- |
| BOT | BOT | ≥ 200 tx dengan jeda median < 60 dtk, aktif merata ≥ 22 dari 24 jam, atau berulang banyak tx di blok yang sama | Dikeluarkan |
| MM | MARKET_MAKER | Label, atau beli & jual seimbang (net < 10 %) di ≥ 5 token dengan frekuensi tinggi | Dikeluarkan |
| CEX | CEX | Alamat exchange (label bersumber) | Dikeluarkan |
| MEV | MEV | Label, atau beli & jual token sama di blok/detik yang sama ≥ 3 kali | Dikeluarkan |
| Airdrop farmer | AIRDROP_FARMER | > 50 % token masuk berasal dari airdrop/mint | HIGH (PnL airdrop dominan): tidak eligible; MEDIUM: peringatan |
| Terkait | LINKED | Satu klaster dengan wallet lain | Tidak dikeluarkan; satu klaster = satu pembeli independen |
| Kontrak / Infra DEX | CONTRACT / DEX_INFRA | Kontrak, bridge, router/pool (label) | Dikeluarkan |
| Riwayat pendek / PnL tidak lengkap | LOW_HISTORY / INCOMPLETE_PNL | < 30 hari atau < 10 trade; kelengkapan < 50 % | Peringatan (dan gagal syarat eligible) |

Merah = HIGH, kuning = MEDIUM; arahkan kursor ke chip untuk alasan & sumbernya. Flag dari label berkeyakinan rendah
turun ke MEDIUM (tidak mengeluarkan).

**Trade tertutup = round trip posisi**, bukan potongan lot: posisi per token dibuka saat saldo naik dari ~0 dan ditutup
saat saldo turun ke ≤ 1 % dari puncaknya. Sepuluh beli kecil lalu satu jual = **1** trade. Posisi yang belum pernah
kembali datar: setiap transaksi jual dihitung satu trade.

### 2.3 Profil Wallet

- **Identitas**: alamat lengkap (salin, buka di explorer), pertama terlihat, aktivitas terakhir, **Ditemukan via**.
- **Skor wallet**: bar komponen, metrik (trade tertutup, token, lama riwayat, median return, rata-rata dengan
  shrinkage, rata-rata tanpa trade terbaik, drawdown maks., porsi PnL token teratas, minggu positif, *win rate — info
  saja*) dan daftar **Alasan**.
- **Keterbatasan data** — baca sebelum mempercayai skor: kelengkapan PnL (Lengkap/Sebagian/Tidak diketahui + persen),
  alasan tidak eligible, catatan PnL, harga lebih tua dari 24 jam, label tanpa sumber, data basi.
- **Ringkasan PnL** — tiga angka yang sengaja dipisah:

| Angka | Arti |
| --- | --- |
| PnL realisasi (trading) | Dari penjualan lot yang biaya belinya diketahui |
| PnL belum realisasi | Harga terakhir × lot berbiaya diketahui − biaya; "—" bila harga tidak tersedia |
| Realisasi dari airdrop | Hasil jual token airdrop/mint — **terpisah**, bukan keahlian trading, tidak masuk skor |

- **Kelengkapan** = porsi penjualan (ditimbang nilai USD) yang biaya belinya diketahui. Penjualan token yang masuk lewat
  transfer/bridge/exchange/airdrop tidak punya biaya, sehingga tidak pernah dihitung sebagai profit.
- **Penanda (flag)** beserta bukti & sumber. **Wallet terkait** (klaster) beserta alasan tautan: transfer langsung,
  pendana pertama sama, alamat deposit exchange sama, ko-trading (beli token sama ≤ 60 dtk pada ≥ 3 token).
- **Posisi terbuka** (termasuk *Qty tanpa biaya* dan penanda harga basi) dan **Riwayat aktivitas** (≤ 200 terbaru,
  dengan *keyakinan klasifikasi* HIGH/MEDIUM/LOW, alasan, dan tautan tx).

Wallet yang belum dilacak tampil "Wallet tidak dilacak" tanpa data.

### 2.4 Detail Token

Satu kontrak token: identitas, **Radar 24 jam** (skor keyakinan, pembeli, aliran, bukti), **Binance & screener**, dan
aktivitas per wallet. Pencocokan Binance hanya memakai kontrak — simbol tidak pernah cukup:

| Status | Tampilan | Arti | Ditautkan ke sinyal/chart? |
| --- | --- | --- | --- |
| MATCHED | Simbol futures, mis. `1000PEPEUSDT` | Chain + kontrak sama persis dengan daftar kontrak Binance | Ya |
| SYMBOL_ONLY | ⚠ Simbol sama, kontrak belum terverifikasi | Simbol ada di Binance tetapi untuk kontrak lain — kemungkinan token lain bersimbol sama | Tidak |
| AMBIGUOUS | Ambigu | Kontrak cocok dengan > 1 entri Binance | Tidak, sampai mapping diverifikasi |
| NOT_LISTED | Tidak di Binance | Kontrak tidak ada di mapping | Tidak |

- **Token bersimbol sama**: di DEX banyak token "PEPE"/"AI" tiruan. Selalu cek alamat kontrak (tampil penuh di halaman
  ini) — dua token bersimbol sama adalah dua token berbeda.
- **Pengali 1000PEPE**: beberapa perp Binance memakai pengali, mis. `1000PEPEUSDT` = 1.000 PEPE per unit, sehingga harga
  di chart perp = harga 1 PEPE × 1.000. Pengali berasal dari data Binance (tooltip "1 kontrak = 1000 token"), tidak
  ditebak dari nama.
- **Sumber mapping** tampil di panel: `binance-getall` (kunci read-only) atau `binance-public` (daftar publik tanpa
  kunci), kadang berakhiran `+prefix-rule`/`+denomination`; mapping disegarkan sekali sehari.

### 2.5 Watchlist & Alerts

- **Diikuti**: wallet (ikuti dari Wallet Discovery/Profil Wallet) dan token (ikuti dari Radar/Detail Token), per
  pengguna. Wallet di watchlist disinkronkan lebih dulu di setiap putaran.
- **Notifikasi** dibuat saat sinkronisasi (bukan real-time). Filter *Hanya belum dibaca* (bawaan) dan *Jenis*; tombol
  **Tandai dibaca** / **Tandai semua dibaca**. Tiap notifikasi memuat wallet, token (simbol + kontrak), USD, dan tx.

| Jenis | Kapan dibuat |
| --- | --- |
| Beli baru | Wallet eligible/dipantau melakukan swap beli ≥ nilai minimum pada token yang belum dipegang/dibelinya |
| Akumulasi berulang | Wallet ≥ 3 kali swap beli token yang sama dalam 24 jam |
| Beli multi-wallet | Token dibeli ≥ N pembeli independen (bawaan 3) |
| Jual besar | Swap jual ≥ ambang jual besar (bawaan $10.000) |
| Wallet keluar | Wallet **dipantau** mengurangi kepemilikan ≥ 90 % lewat swap/deposit exchange; teks membedakan "dijual via swap", "dipindah ke exchange, belum tentu dijual", dan "dipindah lewat transfer/LP/bridge" |

- **Preferensi** (per pengguna): jenis, nilai beli minimum (bawaan $1.000), ambang jual besar ($10.000), skor wallet
  minimum (60; wallet dipantau dikecualikan), min. pembeli independen (3), jeda notifikasi (6 jam; 1 menit–7 hari),
  *Hanya wallet/token di watchlist*. Filter diterapkan saat notifikasi dibaca; ambang yang diturunkan di bawah bawaan
  berlaku mulai sinkronisasi berikutnya.
- **Dedupe & cooldown**: notifikasi sejenis untuk token + wallet yang sama tidak diulang selama jeda. Kunci dedupe server
  memakai jeda tetap 6 jam, jadi jeda pengguna < 6 jam tidak membuat notifikasi lebih sering.
- **Alert basi**: peristiwa yang sudah > 30 menit saat sinkronisasi (data terlambat, Mac tidur, sinkron pertama riwayat
  180 hari) tidak dijadikan notifikasi — tetap terlihat di radar dan profil.

### 2.6 Chip "SM ×N" di LONG Scanner

Di kolom Symbol LONG Scanner, simbol futures yang punya token on-chain **MATCHED** dengan aktivitas smart money 24 jam
terakhir mendapat chip **SM ×N** (N = pembeli independen). Tooltip: chain, skor keyakinan /100 (bukan probabilitas),
status, dan "Aktivitas spot on-chain ≠ posisi futures". Klik → Detail Token. Data simulasi diberi penanda SIMULASI.
Tanpa data, atau bila permintaannya gagal, tabel tampil seperti biasa tanpa chip. Tidak ada di SHORT Scanner.

## 3. Data & keterbatasan

| Sumber (jalur gratis) | Dipakai untuk | Kunci | Batas yang dipakai AlphaLens |
| --- | --- | --- | --- |
| Etherscan API V2 | Riwayat transfer wallet: Ethereum, Arbitrum, Polygon | `ETHERSCAN_API_KEY` (gratis) | 2 panggilan/detik, 90.000/hari |
| Routescan | Riwayat transfer chain EVM lain (Base, Optimism, BNB Chain) | Tanpa kunci (`ROUTESCAN_API_KEY` opsional) | 1,5/detik; 9.000/hari (90.000 dengan kunci) |
| GeckoTerminal | Penemuan wallet dari trade pool, token trending (cadangan penemuan), harga token | Tanpa kunci | 6 panggilan/menit |
| Binance publik (`binance-public`) | Daftar kontrak aset → pasar spot/futures bila kunci Binance kosong | Tanpa kunci (endpoint situs binance.com, tidak resmi) | Disegarkan sekali sehari |
| Binance (kunci read-only, **opsional**) | Sama dengan baris di atas lewat API resmi; didahulukan bila kunci terisi | `BINANCE_API_KEY` + `BINANCE_API_SECRET` | Disegarkan sekali sehari |
| Binance klines publik | Harga ETH/BNB/POL per jam untuk nilai USD swap | Tanpa kunci | — |

- **Kesegaran.** Sinkronisasi berjalan tiap `SMART_MONEY_SYNC_MINUTES` (15) menit dan memproses maks.
  `SMART_MONEY_MAX_WALLETS` (50) wallet per putaran — watchlist dulu, lalu yang paling lama tidak disinkronkan. Dengan
  150 wallet, tiap wallet diperbarui kira-kira tiap 3 putaran (±45 menit). Sinkron pertama sebuah wallet menarik
  riwayat 180 hari (bisa butuh beberapa putaran). Radar dihitung saat halaman dibuka, dari data tersimpan.
- **Cakupan chain.** Hanya EVM: Ethereum, Arbitrum, Polygon (Etherscan); Base, Optimism, BNB Chain (Routescan —
  cakupan per chain dibuktikan `npm run smart-money:check`). **Solana belum tercakup** di jalur gratis; penemuan wallet
  hanya berjalan di chain yang juga punya sumber riwayat transfer. Aktivitas di exchange, OTC, atau chain lain tidak
  terlihat.
- **Nilai USD swap.** Stablecoin = 1 USD/unit. Kaki ETH/WETH, BNB/WBNB, POL/WPOL dinilai dari **close candle 1 jam
  Binance USDⓈ-M terakhir yang sudah tutup sebelum tx** (ETHUSDT, BNBUSDT, POLUSDT) — perkiraan: tertinggal ≤ 1 jam,
  harga perp dipakai sebagai harga spot, USDT ≈ 1 USD. Swap token↔token tanpa aset quote: nilai USD tidak diketahui
  ("—"), **tidak pernah dianggap 0**.
- **PnL tidak lengkap** untuk token yang masuk lewat transfer, bridge, penarikan exchange, atau airdrop (biaya beli tidak
  diketahui), dan untuk penjualan yang melebihi saldo terlihat (riwayat terpotong). Bagian itu tidak dihitung sebagai
  profit. Biaya gas tidak termasuk PnL.
- **Label & klaster = dugaan berbukti.** Jalur gratis belum punya sumber label alamat (name tag Etherscan hanya paket
  berbayar Pro Plus), sehingga flag CEX/MM/MEV berbasis label jarang muncul dan deposit/penarikan exchange umumnya
  tercatat sebagai transfer biasa (tetap tidak dihitung beli/jual). Klaster bisa keliru dua arah: wallet satu pemilik
  tanpa jejak on-chain tidak tertaut; wallet tak terkait bisa tertaut lewat pendana yang sama.
- **Pita DATA SIMULASI** ("bukan data live. Hash transaksi & alamat fiktif.") hanya muncul bila database berisi data dari
  provider simulasi `fixture`, yang hanya aktif di tes/E2E dan ditolak di produksi. Fitur tidak pernah jatuh ke data
  simulasi; bila pita ini muncul di Mac saat memakai data live, laporkan di thread.

## 4. Evaluasi historis

**Yang diukur:** apakah token yang sedang diakumulasi ≥ 3 pembeli independen (status Akumulasi) bergerak lebih baik
daripada **baseline** = semua token yang dibeli wallet mana pun di jendela yang sama. Bawaan: titik evaluasi tiap
6 jam selama 60 hari, radar 24 jam per titik, return pada horizon 4 jam / 24 jam / 3 hari, token yang sama tidak
disinyalkan lagi selama 3 hari, hasil per ember keyakinan (< 40, 40–60, 60–80, ≥ 80).

**Kenapa tanpa look-ahead:**

- Skor & kelayakan wallet di titik t dihitung **hanya** dari trade yang tertutup sebelum t; radar memakai aktivitas
  [t − 24 jam, t).
- Harga masuk = harga tersirat swap terbaru ≤ t (maks. 1 jam sebelumnya), harga keluar = harga pada t + horizon.
  Harga yang tidak ada dicatat "harga hilang", tidak dibuang diam-diam.
- Wallet yang kemudian rugi atau berhenti tetap dihitung di t. Label performa vendor masa kini tidak dipakai. Tes
  kebocoran memastikan mengubah data setelah t tidak mengubah sinyal di t.

Syarat data (bila kurang, skrip menjelaskan dan tidak menyimpan apa pun): ≥ 200 aktivitas, ≥ 5 wallet, rentang ≥ 45 hari.

```bash
npm run smart-money:evaluate                                  # 60 hari, titik tiap 6 jam, ≥ 3 pembeli independen
npm run smart-money:evaluate -- --days 90 --step-hours 12 --min-buyers 4
npm run smart-money:evaluate -- --no-save                     # cetak saja, jangan simpan
```

Laporan dicetak sebagai Markdown dan disimpan ke database; ringkasannya tampil di panel **Evaluasi historis radar**
(halaman Smart Money Radar). Cara membacanya:

1. Lihat **Selisih vs baseline**, bukan return mentah — pasar yang naik membuat semua token tampak bagus.
2. Baris dengan < 30 sinyal = abaikan (ada peringatan sampel kecil). Cakupan harga < 80 % = banyak harga hilang, hasil
   tidak andal.
3. **Hit rate** (porsi return > 0) selalu dibaca bersama CI 95 % (tooltip di panel, kolom tersendiri di laporan). CI
   yang lebar = belum ada bukti.
4. Ember keyakinan seharusnya terurut: ≥ 80 ≥ 60–80 ≥ 40–60 ≥ < 40. Bila tidak, skor keyakinan belum bermakna untuk
   data ini.
5. Batasnya: hasil **in-sample**; harga tersirat swap itu kasar (mengandung slippage & fee); wallet yang dilacak
   ditemukan dari trade 24 jam terakhir (masih aktif hari ini), yang bisa membuat hasil tampak lebih baik dari
   kenyataan. Hit rate **bukan** peluang terkalibrasi.

## 5. Mengaktifkan data live (jalur gratis)

Semua langkah dilakukan di **Mac** (lingkungan cloud pengembang tidak dapat menjangkau sumber ini). Biaya: $0.

Urutan: **isi `.env` → `npm run smart-money:check` → `npm start` → tombol **Sync sekarang** di Radar, tombol scanner,
atau `npm run smart-money:sync`.**

### a. Cukup `ETHERSCAN_API_KEY` (jalur Etherscan-saja)

**Satu kunci gratis Etherscan sudah cukup untuk seluruh alur**: riwayat wallet, skor, penemuan wallet otomatis, status
MATCHED, dan tautan ke LONG Scanner. Kunci Binance read-only (§5c) **opsional**; bila diisi, kunci itu didahulukan
untuk pemetaan kontrak (API resmi, lebih stabil). Dengan hanya `ETHERSCAN_API_KEY`, mode otomatis menyalakan:

| Sumber | Kunci | Fungsinya di jalur ini |
| --- | --- | --- |
| `etherscan` | `ETHERSCAN_API_KEY` | Riwayat transfer wallet di Ethereum, Arbitrum, Polygon (chain paket gratis) |
| `routescan` | Tanpa kunci | Riwayat transfer chain yang tidak lagi gratis di Etherscan: Base, Optimism, BNB Chain |
| `geckoterminal` | Tanpa kunci | Penemuan wallet dari pembeli besar di pool DEX; daftar token trending sebagai cadangan; harga token |
| `binance-public` | Tanpa kunci | Daftar kontrak aset Binance (endpoint publik situs binance.com) → status MATCHED, tautan ke LONG Scanner, token untuk penemuan wallet |

Cara kerja penemuan wallet:

1. **Normal:** `binance-public` memetakan kontrak → pasar Binance. Penemuan memakai token MATCHED (4 token per putaran,
   bergiliran) — hasilnya sama dengan memakai kunci Binance.
2. **Cadangan:** bila belum ada token MATCHED sama sekali (endpoint publik gagal atau bentuknya berubah), sync mengambil
   pool trending GeckoTerminal di **satu chain per putaran** (bergiliran, menjaga kuota tanpa kunci). Kandidat ditandai
   sumber `geckoterminal-trending` dengan alasan "belum tentu listing Binance". Wallet tetap dinilai dari riwayat swap
   sendiri, tetapi token trending sering token baru yang tidak ada di Binance — relevansi ke LONG Scanner bisa rendah.

> Endpoint publik Binance (`getNetworkCoinAll`) **tidak terdokumentasi resmi** dan dapat berubah sewaktu-waktu. AlphaLens
> membacanya secara defensif: bila bentuknya berubah, pemetaan dilaporkan `BAD_RESPONSE` dan penemuan otomatis pindah ke
> cadangan trending. Tidak ada kunci yang dikirim ke endpoint ini. Bila pemetaan publik terus gagal, isi kunci
> read-only (§5c).

Verifikasi dengan `npm run smart-money:check` (§5e): bagian **— Jalur Etherscan-saja (tanpa kunci Binance) —** di akhir
output harus ditutup baris *➡️ Penemuan wallet otomatis AKTIF tanpa kunci Binance*.

### b. Kunci Etherscan (gratis)

1. Daftar atau masuk di https://etherscan.io.
2. Buka menu akun → **API Keys** (langsung: https://etherscan.io/myapikey).
3. Klik **Add**, beri nama bila diminta (mis. `AlphaLens`), lalu salin kuncinya.
4. Tempel di `.env` folder proyek sebagai `ETHERSCAN_API_KEY=` diikuti kunci (tanpa spasi atau tanda kutip).

Paket gratis Etherscan: penggunaan pribadi & riset, 3 panggilan/detik, 100.000/hari, chain terpilih. AlphaLens sengaja
di bawahnya (2/detik, 90.000/hari) dan memakai Etherscan untuk Ethereum, Arbitrum, Polygon; chain EVM yang tidak
tercakup paket gratis otomatis lewat Routescan (tanpa kunci).

### c. Kunci Binance READ-ONLY (opsional)

Lewati bagian ini bila jalur Etherscan-saja (§5a) sudah cukup. Kunci ini menggantikan daftar publik dengan API resmi
Binance (terdokumentasi, lebih stabil); hasil fiturnya sama.

1. Masuk Binance → **Profil** → **API Management** → **Create API**.
2. Pilih **System generated** (hanya tipe ini yang didukung), beri nama mis. `AlphaLens read-only`, selesaikan
   verifikasi keamanan.
3. Di pengaturan izin kunci, pastikan **hanya "Enable Reading"** yang aktif. Jangan centang trading spot/margin,
   futures, penarikan, transfer, atau opsi. AlphaLens memeriksa izin kunci dan **menolak** kunci yang punya izin lain.
4. Disarankan: batasi akses ke IP tepercaya, isi IP publik Mac Anda.
5. Salin **API Key** dan **Secret Key** (secret hanya ditampilkan sekali) ke `.env` sebagai `BINANCE_API_KEY=` dan
   `BINANCE_API_SECRET=`.

> **Jangan pernah menempel kunci atau secret di chat/thread**, screenshot, atau commit — isi hanya di `.env` Mac
> (`.env` tidak ikut di-commit). Kunci ini hanya dipakai membaca daftar kontrak aset; saldo akun di respons Binance
> diabaikan, dan kunci tidak pernah dipakai untuk order atau penarikan.

### d. Isi `.env`

`config/.env.example` sudah memuat baris kosongnya; bila `.env` Anda disalin dari versi lama, tambahkan sendiri:

```dotenv
ETHERSCAN_API_KEY=
# Opsional: kosong = daftar kontrak dari endpoint publik Binance (binance-public)
BINANCE_API_KEY=
BINANCE_API_SECRET=
# Opsional: kunci gratis Routescan menaikkan kuota Routescan
# ROUTESCAN_API_KEY=
# Kosong atau auto (bawaan) = otomatis mengikuti kunci yang terisi
# SMART_MONEY_PROVIDERS=
```

| `SMART_MONEY_PROVIDERS` | Perilaku |
| --- | --- |
| Kosong atau `auto` (bawaan) | Otomatis mengikuti kunci yang terisi (tabel berikut) |
| `off` | Fitur mati: tidak ada sinkronisasi; halaman menampilkan "Belum ada sumber data" |
| Daftar dipisah koma, mis. `etherscan,routescan,geckoterminal,binance-public` (atau `binance-mapping` bila kunci Binance terisi) | Hanya provider itu; urutan = prioritas |
| `fixture` | Data SIMULASI untuk tes — ditolak di produksi |

| Kunci terisi (mode otomatis) | Provider aktif | Hasil |
| --- | --- | --- |
| `ETHERSCAN_API_KEY` saja | `etherscan` + `routescan` + `geckoterminal` + `binance-public` | **Alur lengkap**: riwayat transfer wallet EVM, penemuan wallet, kontrak → pasar Binance (daftar publik, tanpa kunci), tautan ke LONG Scanner |
| `ETHERSCAN_API_KEY` + `BINANCE_API_KEY` **dan** `BINANCE_API_SECRET` | `etherscan` + `routescan` + `geckoterminal` + `binance-mapping` | Alur lengkap; pemetaan kontrak lewat API resmi Binance (didahulukan, `binance-public` tidak dipakai) |
| Hanya kunci Binance (tanpa Etherscan) | Tidak ada | Tidak ada sumber riwayat wallet → "Belum ada sumber data" |
| Tidak ada | Tidak ada | Tidak ada panggilan jaringan; "Belum ada sumber data"; tidak pernah data simulasi |

> Penemuan wallet otomatis memakai token MATCHED dari pemetaan Binance — publik tanpa kunci atau lewat kunci read-only.
> Bila belum ada token MATCHED, dipakai cadangan token trending GeckoTerminal (§5a). Tautan ke LONG Scanner hanya untuk
> token MATCHED.

| Variabel lain (opsional) | Bawaan | Rentang | Fungsi |
| --- | --- | --- | --- |
| `SMART_MONEY_SYNC_MINUTES` | 15 | 5–1440 | Jeda antar putaran sinkronisasi |
| `SMART_MONEY_STALE_MINUTES` | 60 | 1–10080 | Data ditandai BASI bila sinkron sukses terakhir lebih tua dari ini |
| `SMART_MONEY_MAX_WALLETS` | 50 | 1–500 | Wallet maksimum per putaran |
| `ROUTESCAN_API_KEY` | kosong | — | Kunci gratis Routescan: kuota yang dipakai AlphaLens naik dari 9.000 ke 90.000 panggilan/hari (di bawah batas resmi) |

`.env` hanya dibaca saat start: bila server sedang berjalan, hentikan (Ctrl+C) lalu `npm start` lagi.

### e. Cek koneksi: `npm run smart-money:check`

Baca saja (hanya GET) dan kunci tidak pernah dicetak. Bisa makan beberapa menit — bagian GeckoTerminal sengaja lambat.
Yang dicek: Etherscan & Routescan per chain, GeckoTerminal (id jaringan, penemuan pembeli PEPE, token trending
ethereum, harga), pemetaan Binance **publik** tanpa kunci (jumlah baris kontrak, chain, PEPE → `1000PEPEUSDT` ×1000),
pemetaan Binance berkunci (izin kunci, jumlah kontrak; ⏭ bila kunci kosong — normal karena opsional), harga koin
native per jam, lalu ringkasan chain yang bisa dipakai untuk riwayat wallet.

Bagian akhir **— Jalur Etherscan-saja (tanpa kunci Binance) —** merangkum apa yang jalan hanya dengan
`ETHERSCAN_API_KEY`:

| Baris | Arti bila ✅ | Bila ❌ / ⏭ |
| --- | --- | --- |
| *Riwayat wallet & skor: …* | Daftar chain yang riwayat wallet-nya bisa diambil (Etherscan + Routescan) | `ETHERSCAN_API_KEY` kosong/ditolak atau tidak ada chain yang berhasil |
| *Pemetaan kontrak → pasar Binance (publik): N baris* | Daftar publik Binance terbaca: status MATCHED, tautan LONG Scanner, dan token penemuan tersedia tanpa kunci | Endpoint publik gagal/berubah — penemuan memakai cadangan trending; pertimbangkan kunci read-only (§5c) |
| *Penemuan wallet dari pembeli besar di DEX (GeckoTerminal)* | Trade pool GeckoTerminal terbaca | Penemuan wallet tidak dapat berjalan |
| *Cadangan token trending GeckoTerminal: N token* | Pool trending terbaca (dipakai hanya bila tidak ada token MATCHED) | Tidak ada cadangan bila pemetaan publik juga gagal |
| *➡️ Penemuan wallet otomatis AKTIF …, sumber token: …* | Penemuan berjalan tanpa kunci Binance; sumbernya *token yang listing di Binance (mapping publik)* atau *token trending GeckoTerminal (belum tentu listing Binance)* | *BELUM bisa jalan* — juga dicatat di *Masalah yang perlu diperbaiki* (kode keluar 1) |

| Tanda | Arti | Tindakan |
| --- | --- | --- |
| ✅ | Berhasil (jumlah transfer/kandidat/baris, waktu respons) | — |
| ⚪ | Chain tidak tercakup sumber itu (mis. chain berbayar di Etherscan gratis) | Normal bila chain itu ✅ di Routescan |
| ❌ | Gagal: `KODE — pesan` (UNAUTHORIZED, RATE_LIMITED, UNAVAILABLE, …) | Lihat §6 |
| ⏭ | Dilewati karena kunci belum diisi | Isi kunci bila sumber itu diinginkan |
| ⚠️ | Hasil tak terduga (mis. PEPE bukan MATCHED `1000PEPEUSDT` ×1000) | Tempel output ke thread |
| ℹ️ | Info diagnostik (mis. kode jaringan Binance belum dipetakan) | Tempel output ke thread |

Kode keluar 0 = tidak ada masalah fatal; 1 = ada masalah fatal (mis. kunci ditolak), dirangkum di baris *Masalah yang
perlu diperbaiki*. **Tempel seluruh output ke thread** bila ada ❌, ⚠️, ℹ️, *Masalah yang perlu diperbaiki*, atau
catatan "field hilang"/"field baru" (bentuk respons live berbeda dari dokumentasi — adapter perlu disesuaikan). Output
tidak memuat kunci; tetap periksa sebelum menempel, dan jangan pernah menempel isi `.env`.

### f. Menjalankan

1. `npm start` (migrasi `007` diterapkan otomatis).
2. Pilih salah satu:
   - **Website, sekarang juga:** Smart Money Radar → **Sync sekarang** (admin, §2.1). Satu putaran di server dengan
     progres dan ringkasan hasil di halaman; scanner tidak perlu berjalan.
   - **Website, otomatis:** System Health → **Jalankan scanner** (admin). Worker yang sama menjalankan sinkronisasi
     smart money bila ada provider aktif: putaran pertama ±1 menit setelah start, lalu tiap 15 menit
     (`SMART_MONEY_SYNC_MINUTES`) setelah putaran sebelumnya selesai. Log-nya bertanda `smart-money` di terminal
     `npm start`. Tombol **Sync sekarang** dan jadwal ini tidak pernah berjalan bersamaan.
   - **Terminal:** `npm run smart-money:sync` (satu putaran, cetak ringkasan) atau `npm run smart-money:sync -- --loop`
     (berulang sampai Ctrl+C); tambah `--verbose` untuk log lengkap. Putaran terminal tidak pernah berjalan bersamaan
     dengan worker atau tombol **Sync sekarang** (yang datang belakangan dilewati), tetapi jangan biarkan `--loop`
     hidup bersama worker: jadwalnya jadi dobel dan kuota API habis dua kali lebih cepat.
3. Putaran awal: pemetaan Binance (publik atau berkunci) → penemuan wallet (4 token MATCHED per putaran, bergiliran;
   tanpa token MATCHED: token trending GeckoTerminal di satu chain) → riwayat 180 hari per wallet. Radar baru terisi setelah ada wallet **eligible**; di awal "Belum ada akumulasi pada jendela ini" itu normal.
   Pantau progres di Wallet Discovery dengan *Hanya eligible* dimatikan.

Ringkasan `smart-money:sync` memuat baris *Wallet* (dilacak · dipilih · tersinkron · gagal · ditunda), *Transfer*,
*Alert baru*, *Penemuan wallet*, *Pemetaan Binance diperbarui*, dan *Provider …: OK/DEGRADED/DOWN* — satu provider gagal
tidak menghentikan yang lain. Jalur penemuan (token listing Binance / token trending GeckoTerminal) tampil di catatan
run dan di baris hasil halaman Radar (§2.1).

### g. Atribusi wajib

Syarat pemakaian API gratis: strip **Sumber data** di setiap halaman Smart Money menampilkan atribusi provider aktif —
"Data riwayat transaksi: Etherscan API (Powered by Etherscan)", "Data riwayat transaksi: Routescan", dan "Powered by
CoinGecko / GeckoTerminal". Jangan dihapus bila tampilan diubah, dan biarkan terlihat di screenshot yang dibagikan.

## 6. Pemecahan masalah

| Gejala | Penyebab & solusi |
| --- | --- |
| Etherscan `❌ UNAUTHORIZED` | Kunci salah/terpotong. Salin ulang dari etherscan.io/myapikey (tanpa spasi/tanda kutip) ke `.env` di folder proyek (bukan `config/.env.example`), lalu ulangi cek. |
| Binance "memiliki izin selain membaca" | Kunci punya izin trading/futures/penarikan. Matikan semua izin selain Enable Reading atau buat kunci baru, lalu restart `npm start` (penolakan kunci diingat sampai proses berhenti). |
| Binance `-2015` | Kunci/secret salah, izin kurang, atau IP Mac tidak ada di daftar IP tepercaya (IP berubah karena ganti Wi-Fi/VPN) — perbarui daftar IP di API Management. |
| Binance `-1022` / `-2014` | Secret salah atau kunci bukan **System generated** (-1022); format kunci salah (-2014). Salin ulang. |
| Binance `-1021` | Jam Mac tidak sinkron. Pengaturan Sistem → Umum → Tanggal & Waktu → nyalakan pengaturan waktu otomatis, lalu ulangi. |
| `HTTP 451` | Binance menolak lokasi (pembatasan geografis), mis. lewat VPN/server di wilayah terbatas. Jalankan dari Mac di wilayah yang didukung tanpa VPN tersebut. Selama 451, pemetaan Binance dan nilai USD swap ETH/BNB/POL kosong. |
| Harga native `❌ polygon` | Simbol POLUSDT tidak tersedia → nilai USD swap ber-POL di Polygon tidak diketahui (bukan 0). Tempel output ke thread. |
| Chain `⚪` di Etherscan | Normal (chain di luar paket gratis). Bila juga ⚪/❌ di Routescan, chain itu tidak tercakup: wallet di sana dilewati ("tanpa provider" di ringkasan sync). Solana belum tercakup. |
| `RATE_LIMITED` / kuota habis | Batas harian Etherscan pulih setelah pergantian hari UTC (07.00 WIB). Routescan tanpa kunci: isi `ROUTESCAN_API_KEY` gratis. GeckoTerminal tanpa kunci ±10 panggilan/menit dari pool IP bersama — 429 sesekali normal. Kurangi beban: `SMART_MONEY_SYNC_MINUTES=30`, `SMART_MONEY_MAX_WALLETS=25`. |
| "Belum ada sumber data" padahal kunci terisi | Server belum di-restart setelah `.env` diubah, `SMART_MONEY_PROVIDERS=off`, atau nama variabel salah ketik. |
| Tombol **Sync sekarang** abu-abu | *Hanya admin…*: masuk sebagai admin. *Belum ada sumber data*: lihat baris di atas. Hitung mundur: jeda 30 detik setelah putaran terakhir. |
| "Sinkronisasi terjadwal dari worker scanner sedang berjalan" | Putaran otomatis worker sedang jalan; tombol menampilkan progresnya. Tunggu sampai selesai — hasilnya tampil di tempat yang sama. |
| Sync **Berhasil** tetapi Radar tetap kosong | Belum ada wallet *eligible* — wallet baru butuh beberapa putaran (riwayat 180 hari, ≥ 10 trade tertutup). Bila *Penemuan wallet* selalu 0 atau catatan menyebut "pemetaan Binance belum aktif"/"token trending tidak tersedia", jalankan `npm run smart-money:check` dan baca bagian *Jalur Etherscan-saja*; sementara itu ikuti wallet lewat Watchlist. |
| Binance publik `❌ BAD_RESPONSE` / `UNAVAILABLE` | Endpoint publik Binance (tidak resmi) berubah atau diblokir. Penemuan otomatis tetap jalan lewat token trending GeckoTerminal. Untuk status MATCHED & tautan LONG Scanner, isi kunci read-only (§5c) dan tempel output cek ke thread. |
| Sync berstatus **Gagal** | Kesalahan internal (bukan provider); detailnya ada di log terminal `npm start`. Tempel baris log `smart-money` ke thread. |
| Badge BASI terus | Tidak ada sinkron sukses > 60 menit: scanner mati/Mac tidur, atau semua provider gagal. Lihat log `smart-money` atau jalankan `npm run smart-money:sync`. |
