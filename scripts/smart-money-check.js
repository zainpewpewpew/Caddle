// Cek koneksi & bentuk data sumber Insider / Smart Money Radar — jalankan di Mac: `npm run smart-money:check`.
// Lingkungan pengembangan cloud tidak dapat menjangkau API on-chain mana pun (docs/14 §0), jadi skrip ini adalah
// verifikasi live pertama atas adapter jalur gratis: Etherscan V2, Routescan, GeckoTerminal, pemetaan Binance
// (kunci read-only), dan harga koin native per jam dari Binance. BACA SAJA: hanya permintaan GET; kunci API tidak
// pernah dicetak (pesan error adapter sudah disamarkan). Hasil: ringkasan per sumber & chain + kode keluar
// 0 (tidak ada masalah fatal) / 1 (ada sumber terkonfigurasi yang gagal fatal, mis. kunci ditolak).

import { createBinanceRestClient } from '../backend/ingestion/binance/restClient.js';
import { matchToken } from '../backend/smartmoney/binanceMatch.js';
import { EVM_CHAINS } from '../backend/smartmoney/contracts.js';
import { createNativePriceResolver } from '../backend/smartmoney/nativePrices.js';
import { createBinanceMappingProvider } from '../backend/smartmoney/providers/binanceMapping.js';
import { createEtherscanProvider } from '../backend/smartmoney/providers/etherscan.js';
import {
  GECKOTERMINAL_BASE_URL, GECKOTERMINAL_NETWORKS, createGeckoTerminalProvider,
} from '../backend/smartmoney/providers/geckoTerminal.js';
import { createRoutescanProvider } from '../backend/smartmoney/providers/routescan.js';

// Alamat publik contoh dokumentasi Etherscan (hanya untuk menguji bentuk respons, bukan kandidat smart money).
const SAMPLE_WALLET = '0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae';
// Kontrak PEPE di Ethereum (perp Binance 1000PEPEUSDT) — uji pemetaan kontrak → pasar & penemuan wallet.
const PEPE = { chain: 'ethereum', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', symbol: 'PEPE' };
const FATAL_CODES = new Set(['UNAUTHORIZED', 'BAD_RESPONSE']);
const DAY_MS = 86_400_000;

const env = process.env;
const now = Date.now();
const problems = [];
const usable = { etherscan: [], routescan: [] };

const line = (text = '') => process.stdout.write(`${text}\n`);
const errText = (err) => `${err?.code ?? 'ERROR'} — ${err?.message ?? String(err)}`;
const list = (items, max = 8) => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} … (+${items.length - max})`);

async function timed(fn) {
  const start = Date.now();
  try {
    return { ok: true, value: await fn(), ms: Date.now() - start };
  } catch (err) {
    return { ok: false, err, ms: Date.now() - start };
  }
}

async function checkTransfers(name, provider, key) {
  line(`\n▶ ${name}`);
  if (provider.configured === false) {
    line('  ⏭  dilewati: kunci belum diisi di .env');
    return;
  }
  for (const chain of EVM_CHAINS) {
    const r = await timed(() => provider.fetchWalletTransfers({ chain, address: SAMPLE_WALLET, since: now - 30 * DAY_MS }));
    if (r.ok) {
      const d = r.value.diagnostics ?? {};
      const notes = [];
      if (d.missingFields?.length) notes.push(`field hilang: ${list(d.missingFields)}`);
      if (d.unknownFields?.length) notes.push(`field baru: ${list(d.unknownFields)}`);
      if (d.syntheticLogIndex) notes.push('logIndex sintetis');
      line(`  ✅ ${chain.padEnd(9)} ${String(r.value.transfers.length).padStart(4)} transfer (${r.ms} ms)${notes.length ? ` — ${notes.join('; ')}` : ''}`);
      usable[key].push(chain);
    } else if (r.err?.code === 'NOT_SUPPORTED') {
      line(`  ⚪ ${chain.padEnd(9)} tidak tercakup: ${r.err.message}`);
    } else {
      line(`  ❌ ${chain.padEnd(9)} ${errText(r.err)}`);
      if (FATAL_CODES.has(r.err?.code)) problems.push(`${name} ${chain}: ${r.err.code}`);
    }
  }
}

async function fetchGeckoNetworkIds() {
  const ids = new Set();
  for (let page = 1; page <= 10; page += 1) {
    const res = await fetch(`${GECKOTERMINAL_BASE_URL}/networks?page=${page}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: res.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE' });
    const body = await res.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    for (const n of data) if (typeof n?.id === 'string') ids.add(n.id);
    if (data.length === 0 || Object.values(GECKOTERMINAL_NETWORKS).every((id) => ids.has(id))) break;
  }
  return ids;
}

async function checkGeckoTerminal() {
  line('\n▶ GeckoTerminal (tanpa kunci, ±6 panggilan/menit — bagian ini lambat secara sengaja)');
  const ids = await timed(fetchGeckoNetworkIds);
  if (ids.ok) {
    for (const [chain, id] of Object.entries(GECKOTERMINAL_NETWORKS)) {
      line(`  ${ids.value.has(id) ? '✅' : '❌'} jaringan ${chain} → id "${id}" ${ids.value.has(id) ? 'ada' : 'TIDAK ditemukan di /networks'}`);
      if (!ids.value.has(id)) problems.push(`GeckoTerminal: id jaringan ${id} untuk ${chain} tidak ditemukan`);
    }
  } else {
    line(`  ❌ /networks: ${errText(ids.err)}`);
  }
  const gt = createGeckoTerminalProvider();
  const disc = await timed(() => gt.discoverWallets({ chain: PEPE.chain, since: now - DAY_MS, limit: 20, tokens: [PEPE.address] }));
  if (disc.ok) {
    const d = disc.value.diagnostics ?? gt.lastDiagnostics?.() ?? {};
    const missing = Object.keys(d.missingTradeKeys ?? {});
    const unknown = d.unknownTradeKeys ?? [];
    line(`  ✅ penemuan wallet (pembeli PEPE ≥ $1.000, 24 jam): ${disc.value.length} kandidat (${disc.ms} ms)`);
    if (missing.length || unknown.length) line(`     field trade hilang: ${list(missing) || '-'} · field baru: ${list(unknown) || '-'}`);
    if (d.errors?.length) line(`     galat parsial: ${list(d.errors.map((e) => e.code ?? String(e)))}`);
  } else {
    line(`  ❌ penemuan wallet: ${errText(disc.err)}`);
  }
  const price = await timed(() => gt.fetchPrices({ chain: PEPE.chain, addresses: [PEPE.address] }));
  if (price.ok) line(`  ✅ harga PEPE: ${price.value[0]?.priceUsd ?? 'tidak ada'} USD`);
  else line(`  ❌ harga token: ${errText(price.err)}`);
}

async function checkBinanceMapping() {
  line('\n▶ Pemetaan Binance (kunci READ-ONLY)');
  const provider = createBinanceMappingProvider({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET });
  if (!provider.isConfigured()) {
    line('  ⏭  dilewati: BINANCE_API_KEY / BINANCE_API_SECRET belum diisi di .env');
    return;
  }
  const restr = await timed(() => provider.checkKeyRestrictions());
  if (!restr.ok) {
    line(`  ❌ izin kunci: ${errText(restr.err)}`);
    problems.push(`Binance: ${restr.err?.code}`);
    return;
  }
  line('  ✅ izin kunci: hanya membaca (tidak ada izin trading/penarikan)');
  const rows = await timed(() => provider.fetchBinanceMapping());
  if (!rows.ok) {
    line(`  ❌ daftar kontrak: ${errText(rows.err)}`);
    if (FATAL_CODES.has(rows.err?.code)) problems.push(`Binance mapping: ${rows.err.code}`);
    return;
  }
  const d = provider.lastDiagnostics?.() ?? {};
  const chains = [...new Set(rows.value.map((r) => r.chain))].sort();
  line(`  ✅ ${rows.value.length} baris kontrak → pasar (${rows.ms} ms), chain: ${chains.join(', ')}`);
  if (d.unknownNetworks?.length) line(`  ℹ️  kode jaringan Binance belum dipetakan: ${list(d.unknownNetworks.map((n) => n.network ?? n))}`);
  for (const key of ['multiplePerps', 'sharedContracts', 'unmappedPerps', 'prefixRule']) {
    if (Array.isArray(d[key]) && d[key].length) line(`  ℹ️  ${key}: ${d[key].length}`);
  }
  const m = matchToken(PEPE, rows.value);
  const ok = m.status === 'MATCHED' && m.futuresSymbol === '1000PEPEUSDT' && m.multiplier === 1000;
  line(`  ${ok ? '✅' : '⚠️ '} PEPE (Ethereum) → ${m.status} ${m.futuresSymbol ?? '-'} ×${m.multiplier}${ok ? '' : ' (diharapkan MATCHED 1000PEPEUSDT ×1000)'}`);
}

async function checkNativePrices() {
  line('\n▶ Harga koin native per jam (Binance futures, publik)');
  const rest = createBinanceRestClient();
  const resolver = createNativePriceResolver({ getKlines: rest.getKlines });
  for (const chain of [...EVM_CHAINS, 'solana']) {
    const r = await timed(() => resolver.priceAt(chain, now - 2 * 3_600_000));
    if (r.ok && r.value) line(`  ✅ ${chain.padEnd(9)} ${r.value.priceUsd} USD (${r.value.source})`);
    else line(`  ❌ ${chain.padEnd(9)} ${r.ok ? 'harga tidak tersedia' : errText(r.err)}`);
  }
  const errors = resolver.errors();
  if (errors.length) line(`  ℹ️  galat: ${list(errors.map((e) => `${e.symbol} ${e.code}`))}`);
}

line('Cek sumber data Insider / Smart Money Radar (baca saja, kunci tidak dicetak)');
line(`Waktu: ${new Date(now).toISOString()}`);
await checkTransfers('Etherscan API V2', createEtherscanProvider({ apiKey: env.ETHERSCAN_API_KEY ?? null, chains: [...EVM_CHAINS] }), 'etherscan');
await checkTransfers('Routescan (tanpa kunci)', createRoutescanProvider({ apiKey: env.ROUTESCAN_API_KEY ?? null, chains: [...EVM_CHAINS] }), 'routescan');
await checkGeckoTerminal();
await checkBinanceMapping();
await checkNativePrices();

line('\n— Ringkasan —');
line(`Riwayat wallet via Etherscan : ${usable.etherscan.join(', ') || '-'}`);
const viaRoutescan = usable.routescan.filter((c) => !usable.etherscan.includes(c));
line(`Riwayat wallet via Routescan : ${viaRoutescan.join(', ') || '-'} (chain yang tidak dicakup Etherscan)`);
if (usable.etherscan.length === 0 && usable.routescan.length === 0) {
  problems.push('belum ada sumber riwayat wallet yang berhasil dihubungi (cek koneksi internet & ETHERSCAN_API_KEY)');
}
if (problems.length) {
  line(`Masalah yang perlu diperbaiki: ${problems.join(' · ')}`);
  process.exitCode = 1;
} else {
  line('Tidak ada masalah fatal. Tempel output ini ke thread bila ada baris ❌ atau ⚠️ yang perlu dibahas.');
}
