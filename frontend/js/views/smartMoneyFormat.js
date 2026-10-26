// Logika & format murni untuk halaman Insider / Smart Money Radar (tanpa DOM, tanpa jaringan, tanpa Date.now()).
// Bentuk data mengikuti docs/15-kontrak-smart-money.md §5. Frontend tidak dapat mengimpor backend/smartmoney/
// contracts.js (hanya folder frontend/ yang disajikan), sehingga konstanta yang dibutuhkan UI disalin di sini —
// tests/unit/smartmoney/uiFormat.test.js memastikan salinan ini tetap identik dengan kontrak backend.
import { formatDuration, formatInteger } from '../lib/format.js';

export const EMPTY = '—';
export const SM_API = '/api/smart-money';

export const CHAINS = Object.freeze(['ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'solana']);
const EVM_CHAINS = new Set(['ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon']);

export const CHAIN_LABELS = Object.freeze({
  ethereum: 'Ethereum',
  base: 'Base',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  bsc: 'BNB Chain',
  polygon: 'Polygon',
  solana: 'Solana',
});

/** Salinan EXPLORERS (contracts.js) untuk tautan verifikasi bila respons tidak membawa explorerUrl. */
export const EXPLORERS = Object.freeze({
  ethereum: 'https://etherscan.io',
  base: 'https://basescan.org',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
  bsc: 'https://bscscan.com',
  polygon: 'https://polygonscan.com',
  solana: 'https://solscan.io',
});

/** Salinan DISCLAIMERS (contracts.js); dipakai bila `meta.disclaimers` tidak ada (mis. respons error). */
export const DISCLAIMERS = Object.freeze({
  insiderName: '“Insider” hanya nama fitur. Tidak ada kesimpulan bahwa pemilik wallet memiliki informasi orang dalam.',
  conviction: 'Skor keyakinan adalah ringkasan bukti yang dapat dijelaskan, BUKAN probabilitas profit.',
  spotVsFutures: 'Aktivitas spot on-chain ≠ posisi futures. Posisi pribadi trader di Binance tidak dapat diketahui dari wallet publik.',
  readOnly: 'Fitur baca saja: tidak pernah meminta seed phrase / private key dan tidak mengirim transaksi.',
  simulated: 'DATA SIMULASI — bukan data live. Hash transaksi & alamat fiktif.',
});

export const RADAR_WINDOWS = Object.freeze(['1h', '4h', '24h', '7d']);
export const RADAR_STATES = Object.freeze(['ACCUMULATING', 'MIXED', 'DISTRIBUTING', 'EXITING']);
export const TRADING_STYLES = Object.freeze(['SCALPER', 'SWING', 'POSITION', 'MIXED', 'UNKNOWN']);
export const ALERT_KINDS = Object.freeze(['NEW_BUY', 'REPEAT_ACCUMULATION', 'MULTI_WALLET_BUY', 'LARGE_SELL', 'WALLET_EXIT']);
export const DEFAULT_RADAR_LIMIT = 100;
export const DEFAULT_WALLETS_LIMIT = 200;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const HOUR_MS = 3_600_000;

/** Merge disclaimers dari `meta` dengan cadangan lokal (teks server menang). */
export function disclaimersOf(meta) {
  const fromMeta = meta && typeof meta.disclaimers === 'object' && meta.disclaimers ? meta.disclaimers : {};
  const out = { ...DISCLAIMERS };
  for (const key of Object.keys(DISCLAIMERS)) {
    if (typeof fromMeta[key] === 'string' && fromMeta[key]) out[key] = fromMeta[key];
  }
  return out;
}

// ---------------------------------------------------------------- alamat & tautan

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FUTURES_SYMBOL_RE = /^[A-Z0-9]{2,30}$/;

export const isChain = (chain) => CHAINS.includes(chain);

/**
 * Alamat kanonik untuk chain (cermin normalizeAddress di contracts.js): EVM → huruf kecil, Solana apa adanya.
 * @returns {string|null} null bila tidak valid
 */
export function normalizeAddress(chain, address) {
  if (typeof address !== 'string') return null;
  const a = address.trim();
  if (EVM_CHAINS.has(chain)) return EVM_ADDRESS_RE.test(a) ? a.toLowerCase() : null;
  if (chain === 'solana') return SOLANA_ADDRESS_RE.test(a) ? a : null;
  return null;
}

/**
 * Alamat pendek untuk tabel: 0x1234…abcd. Alamat pendek dikembalikan apa adanya; nilai kosong → '—'.
 * @param {string|null|undefined} address
 */
export function shortAddress(address, head = 6, tail = 4) {
  if (typeof address !== 'string' || address === '') return EMPTY;
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** Pecah tokenKey `chain:alamat` → { chain, address } atau null. */
export function parseTokenKey(key) {
  if (typeof key !== 'string') return null;
  const i = key.indexOf(':');
  if (i <= 0 || i === key.length - 1) return null;
  const chain = key.slice(0, i);
  const address = key.slice(i + 1);
  return isChain(chain) ? { chain, address } : null;
}

/**
 * Parameter halaman profil wallet / detail token dari query hash (?c=<chain>&a=<alamat>).
 * @param {URLSearchParams} query
 * @returns {{ chain: string|null, address: string|null, invalid: boolean }}
 */
export function parseEntityQuery(query) {
  const rawChain = (query.get('c') ?? '').trim().toLowerCase();
  const rawAddress = (query.get('a') ?? '').trim();
  const chain = isChain(rawChain) ? rawChain : null;
  const address = chain ? normalizeAddress(chain, rawAddress) : null;
  return { chain, address, invalid: !chain || !address };
}

const entityHref = (path, chain, address) => `#/${path}?${new URLSearchParams({ c: chain, a: address }).toString()}`;
export const smartWalletHref = (chain, address) => entityHref('smart-wallet', chain, address);
export const smartTokenHref = (chain, address) => entityHref('smart-token', chain, address);

export function explorerTxUrl(chain, txHash) {
  const base = EXPLORERS[chain];
  return base && typeof txHash === 'string' && txHash ? `${base}/tx/${txHash}` : null;
}

export function explorerAddressUrl(chain, address) {
  const base = EXPLORERS[chain];
  if (!base || typeof address !== 'string' || !address) return null;
  return chain === 'solana' ? `${base}/account/${address}` : `${base}/address/${address}`;
}

export function explorerTokenUrl(chain, address) {
  const base = EXPLORERS[chain];
  if (!base || typeof address !== 'string' || !address || address === 'native') return null;
  return `${base}/token/${address}`;
}

/**
 * Tautan eksternal hanya bila https:// (URL dari server tetap divalidasi: tidak ada javascript:/data:).
 * @returns {string|null}
 */
export function safeExternalUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Tautan grafik Symbol Intelligence untuk simbol futures — hanya untuk token MATCHED (selain itu null). */
export function symbolChartHref(match) {
  if (!match || match.status !== 'MATCHED' || !FUTURES_SYMBOL_RE.test(match.futuresSymbol ?? '')) return null;
  return `#/symbol?${new URLSearchParams({ s: match.futuresSymbol, tf: '15m', dir: 'LONG' }).toString()}`;
}

// ---------------------------------------------------------------- angka

const usdCompact = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });
const usdPlain = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const pctFmt = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
const qtyFmt = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 4 });

export const USD_UNKNOWN = 'nilai USD tidak diketahui';

/**
 * USD ringkas: 1234 → '$1,2 rb'; null/undefined (tidak diketahui — BUKAN nol) → '—'.
 * @param {number|null|undefined} value
 * @param {{ signed?: boolean }} [options] signed: tanda +/- eksplisit (aliran bersih, PnL)
 */
export function formatUsdOrDash(value, { signed = false } = {}) {
  if (!isNum(value)) return EMPTY;
  const abs = Math.abs(value);
  const body = abs >= 10_000 ? usdCompact.format(abs) : usdPlain.format(abs);
  const sign = value < 0 ? '-' : signed && value > 0 ? '+' : '';
  return `${sign}$${body}`;
}

/** Arah nilai untuk pewarnaan: 'up' | 'down' | 'flat' | null (tidak diketahui). */
export function signOf(value) {
  if (!isNum(value)) return null;
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}

/**
 * Persen bertanda dari angka POIN persen (holdingChangePct 12.5 → '+12,5%'). null → '—'.
 * Asumsi kontrak: field ber-akhiran `Pct` berisi poin persen, bukan rasio.
 */
export function formatSignedPct(value) {
  if (!isNum(value)) return EMPTY;
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${pctFmt.format(Math.abs(value))}%`;
}

/**
 * Drawdown maksimum (metrics.maxDrawdownPct, poin persen BESARAN penurunan ≥ 0) → '−12,5%'. Drawdown selalu
 * penurunan: tanda dari server (positif atau negatif) diabaikan dan tidak pernah tampil sebagai '+'. null → '—'.
 */
export function formatDrawdownPct(value) {
  if (!isNum(value)) return EMPTY;
  const abs = Math.abs(value);
  return abs === 0 ? '0%' : `−${pctFmt.format(abs)}%`;
}

/** Return sebagai PECAHAN (0,0123 = +1,23 %) → '+1,2%' (laporan evaluasi historis). null → '—'. */
export function formatReturnFraction(value) {
  return isNum(value) ? formatSignedPct(value * 100) : EMPTY;
}

/** Durasi ms → '4 jam' / '1 hari' / '30 mnt' (label horizon & langkah evaluasi). */
export function formatDurationShort(ms) {
  if (!isNum(ms) || ms <= 0) return EMPTY;
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} hari`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} jam`;
  return `${Math.round(ms / 60_000)} mnt`;
}

/** Rasio 0..1 → '75%'; null → '—'. */
export function formatRatioPct(ratio) {
  if (!isNum(ratio)) return EMPTY;
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

export function formatQty(value) {
  return isNum(value) ? qtyFmt.format(value) : EMPTY;
}

/** Skor 0..100 dibulatkan, atau null bila bukan angka. */
export function clampScore(value) {
  return isNum(value) ? Math.round(Math.max(0, Math.min(100, value))) : null;
}

/**
 * Komponen skor → persen lebar bar 0..100. Komponen kontrak bernilai 0..1; nilai > 1 dianggap sudah poin (0..100).
 * Penalti boleh negatif: lebar memakai nilai absolut, tanda dibaca pemanggil.
 */
export function componentPercent(value) {
  if (!isNum(value)) return null;
  const abs = Math.abs(value);
  return Math.round(Math.min(100, abs <= 1 ? abs * 100 : abs));
}

// ---------------------------------------------------------------- label

const TYPE_LABELS = Object.freeze({
  SWAP_BUY: ['Swap beli', 'buy'],
  SWAP_SELL: ['Swap jual', 'sell'],
  TRANSFER_IN: ['Transfer masuk', 'move'],
  TRANSFER_OUT: ['Transfer keluar', 'move'],
  CEX_WITHDRAWAL: ['Penarikan exchange', 'cex'],
  CEX_DEPOSIT: ['Deposit ke exchange', 'cex'],
  BRIDGE_IN: ['Bridge masuk', 'bridge'],
  BRIDGE_OUT: ['Bridge keluar', 'bridge'],
  AIRDROP: ['Airdrop', 'airdrop'],
  MINT: ['Mint', 'airdrop'],
  BURN: ['Burn', 'move'],
  LP_ADD: ['Tambah likuiditas', 'lp'],
  LP_REMOVE: ['Tarik likuiditas', 'lp'],
  UNKNOWN: ['Tidak dikenali', 'unknown'],
  FULL_EXIT: ['Keluar penuh', 'sell'],
});

/** Label Bahasa Indonesia jenis aktivitas (ACTIVITY_TYPES + FULL_EXIT dari exitSignals). */
export function typeLabel(type) {
  return TYPE_LABELS[type]?.[0] ?? (typeof type === 'string' && type ? type.replaceAll('_', ' ') : EMPTY);
}

/**
 * Kelompok warna jenis aktivitas: hanya swap yang 'buy'/'sell'; transfer/exchange/bridge/airdrop/LP punya kelompok
 * sendiri agar tidak pernah terbaca sebagai pembelian.
 * @returns {'buy'|'sell'|'move'|'cex'|'bridge'|'airdrop'|'lp'|'unknown'}
 */
export function typeKind(type) {
  return TYPE_LABELS[type]?.[1] ?? 'unknown';
}

/** Penjelasan jenis aktivitas untuk tooltip. */
export function typeHint(type) {
  if (type === 'SWAP_BUY') return 'Swap: dihitung sebagai pembelian.';
  if (type === 'SWAP_SELL') return 'Swap: dihitung sebagai penjualan.';
  if (type === 'CEX_DEPOSIT') return 'Indikasi keluar: dipindah ke exchange, belum tentu dijual.';
  if (type === 'FULL_EXIT') return 'Kepemilikan wallet atas token ini habis.';
  return 'Bukan pembelian/penjualan — tidak dihitung di radar.';
}

const STATE_LABELS = Object.freeze({
  ACCUMULATING: ['Akumulasi', 'bull', 'Pembelian swap dari wallet independen mendominasi.'],
  MIXED: ['Campuran', 'accent', 'Ada pembelian dan penjualan dengan bobot sebanding.'],
  DISTRIBUTING: ['Distribusi', 'warn', 'Penjualan swap mulai mendominasi.'],
  EXITING: ['Keluar', 'bear', 'Wallet yang sebelumnya mengakumulasi sedang keluar (jual / pindah ke exchange).'],
});

/** @returns {{ label: string, tone: string|undefined, text: string }} */
export function stateLabel(state) {
  const s = STATE_LABELS[state];
  return s ? { label: s[0], tone: s[1], text: s[2] } : { label: state ? String(state) : EMPTY, tone: undefined, text: 'Status tidak dikenal.' };
}

/**
 * Status pencocokan Binance. Hanya MATCHED (chain + kontrak sama persis) yang boleh ditautkan ke grafik/sinyal.
 * @param {{ status?: string, futuresSymbol?: string|null, spotSymbol?: string|null, note?: string }|null|undefined} match
 * @returns {{ status: string, label: string, tone: string|undefined, text: string, linkable: boolean }}
 */
export function matchBadge(match) {
  const status = match?.status ?? 'UNKNOWN';
  const note = typeof match?.note === 'string' && match.note ? ` ${match.note}` : '';
  if (status === 'MATCHED') {
    const sym = match.futuresSymbol ?? match.spotSymbol ?? match.binanceAsset ?? 'Binance';
    const mult = isNum(match.multiplier) && match.multiplier !== 1 ? ` (1 kontrak = ${match.multiplier} token)` : '';
    return { status, label: sym, tone: 'bull', text: `Kontrak terverifikasi cocok dengan ${sym}${mult}.${note}`, linkable: Boolean(match.futuresSymbol) };
  }
  if (status === 'SYMBOL_ONLY') {
    return { status, label: 'Simbol sama', tone: 'warn', text: `Simbol sama, kontrak belum terverifikasi — tidak ditautkan ke sinyal.${note}`, linkable: false };
  }
  if (status === 'AMBIGUOUS') {
    return { status, label: 'Ambigu', tone: 'warn', text: `Lebih dari satu pasar Binance cocok — tidak ditautkan.${note}`, linkable: false };
  }
  if (status === 'NOT_LISTED') {
    return { status, label: 'Tidak di Binance', tone: undefined, text: `Token tidak terdaftar di Binance.${note}`, linkable: false };
  }
  return { status: 'UNKNOWN', label: 'Status Binance ?', tone: undefined, text: 'Status pencocokan Binance tidak diketahui.', linkable: false };
}

const RELEVANCE = Object.freeze({
  TINGGI: ['Relevansi tinggi', 'bull', 'Keyakinan ≥ 60 dan ada sinyal LONG tier A/B.'],
  SEDANG: ['Relevansi sedang', 'accent', 'Keyakinan ≥ 60 atau ada sinyal LONG tier A/B (salah satu).'],
  RENDAH: ['Relevansi rendah', undefined, 'Terhubung ke Binance, tanpa keyakinan tinggi maupun sinyal LONG kuat.'],
  TIDAK_TERHUBUNG: ['Tidak terhubung', undefined, 'Kontrak tidak terverifikasi di Binance — tidak ditautkan ke screener.'],
});

/** @returns {{ label: string, tone: string|undefined, text: string }} */
export function relevanceLabel(level) {
  const r = RELEVANCE[level] ?? RELEVANCE.TIDAK_TERHUBUNG;
  return { label: r[0], tone: r[1], text: r[2] };
}

const PATTERN_LABELS = Object.freeze({
  SA: 'SA · kenaikan perlahan volume rendah',
  PVA: 'PVA · akumulasi volume progresif',
  BOTH: 'SA + PVA',
});

/**
 * Label pola untuk satu sinyal screener ({ timeframe, state, classification, tier, patterns }).
 * `patterns` dari server sudah Bahasa Indonesia; bila kosong, label diturunkan dari classification/state.
 * @returns {string[]}
 */
export function signalPatternLabels(signal) {
  if (Array.isArray(signal?.patterns) && signal.patterns.length) return signal.patterns.filter((p) => typeof p === 'string' && p);
  const out = [];
  if (PATTERN_LABELS[signal?.classification]) out.push(PATTERN_LABELS[signal.classification]);
  if (signal?.state === 'BREAKOUT') out.push('breakout akumulasi');
  return out;
}

/** Sinyal LONG per timeframe 5m/15m/1h dalam urutan tetap (timeframe tanpa sinyal dilewati). */
export function signalsByTimeframe(screener) {
  const list = Array.isArray(screener?.signals) ? screener.signals : [];
  return ['5m', '15m', '1h'].flatMap((tf) => list.filter((s) => s?.timeframe === tf));
}

const FLAG_LABELS = Object.freeze({
  CEX: ['CEX', 'Alamat exchange terpusat'],
  MARKET_MAKER: ['MM', 'Market maker'],
  BOT: ['BOT', 'Pola transaksi bot'],
  MEV: ['MEV', 'Bot MEV / sandwich'],
  AIRDROP_FARMER: ['Airdrop farmer', 'Sebagian besar token berasal dari airdrop/mint'],
  CONTRACT: ['Kontrak', 'Alamat kontrak, bukan wallet'],
  DEX_INFRA: ['Infra DEX', 'Router/pool DEX'],
  LINKED: ['Terkait', 'Terhubung dengan wallet lain (satu klaster)'],
  LOW_HISTORY: ['Riwayat pendek', 'Riwayat < 30 hari atau < 10 trade tertutup'],
  INCOMPLETE_PNL: ['PnL tidak lengkap', 'Biaya beli sebagian penjualan tidak diketahui'],
});

/**
 * Chip penanda wallet. Tooltip = alasan server bila ada, selain itu deskripsi umum.
 * @param {{ code: string, severity?: string, reason?: string, source?: string }} flag
 * @returns {{ label: string, tone: string|undefined, title: string }}
 */
export function flagInfo(flag) {
  const code = flag?.code ?? '?';
  const [label, desc] = FLAG_LABELS[code] ?? [String(code).replaceAll('_', ' '), 'Penanda wallet'];
  const tone = flag?.severity === 'HIGH' ? 'bear' : flag?.severity === 'MEDIUM' ? 'warn' : undefined;
  const reason = typeof flag?.reason === 'string' && flag.reason ? flag.reason : desc;
  const source = typeof flag?.source === 'string' && flag.source ? ` · sumber: ${flag.source}` : '';
  const sev = flag?.severity ? ` · ${flag.severity}` : '';
  return { label, tone, title: `${reason}${sev}${source}` };
}

const STYLE_LABELS = Object.freeze({
  SCALPER: 'Scalper',
  SWING: 'Swing',
  POSITION: 'Posisi',
  MIXED: 'Campuran',
  UNKNOWN: 'Tidak diketahui',
});
export const styleLabel = (style) => STYLE_LABELS[style] ?? STYLE_LABELS.UNKNOWN;

const COMPLETENESS = Object.freeze({
  COMPLETE: ['Lengkap', 'bull'],
  PARTIAL: ['Sebagian', 'warn'],
  UNKNOWN: ['Tidak diketahui', undefined],
});
/** @returns {{ label: string, tone: string|undefined }} */
export function completenessLabel(value) {
  const c = COMPLETENESS[value] ?? COMPLETENESS.UNKNOWN;
  return { label: c[0], tone: c[1] };
}

const COMPLETENESS_BASIS = Object.freeze({
  USD: 'dari nilai jual (USD) punya biaya beli yang diketahui.',
  TOKEN_AVERAGE: 'rata-rata per token dari kuantitas jual yang punya biaya beli diketahui (sebagian nilai jual USD tidak diketahui, jadi tidak ditimbang USD).',
  NONE: 'belum ada penjualan, jadi belum ada PnL realisasi yang bisa tidak lengkap.',
});
/** Penjelasan dasar perhitungan `pnl.summary.completenessRatio` (`completenessBasis`: USD | TOKEN_AVERAGE | NONE). */
export function completenessBasisText(basis) {
  return COMPLETENESS_BASIS[basis] ?? 'dasar perhitungan tidak diketahui (data lama — sinkronkan ulang).';
}

const ALERT_LABELS = Object.freeze({
  NEW_BUY: 'Beli baru',
  REPEAT_ACCUMULATION: 'Akumulasi berulang',
  MULTI_WALLET_BUY: 'Beli multi-wallet',
  LARGE_SELL: 'Jual besar',
  WALLET_EXIT: 'Wallet keluar',
});
export const alertKindLabel = (kind) => ALERT_LABELS[kind] ?? (kind ? String(kind).replaceAll('_', ' ') : EMPTY);

/**
 * Penanda "dipantau" per pengguna pada notifikasi (walletWatched / watchlisted dihitung server untuk PENGGUNA INI).
 * @param {{ walletWatched?: boolean, watchlisted?: boolean }} alert
 * @returns {{ label: string, title: string }|null}
 */
export function alertWatchInfo(alert) {
  if (alert?.walletWatched === true) return { label: 'Wallet dipantau', title: 'Wallet ini ada di watchlist Anda.' };
  if (alert?.watchlisted === true) return { label: 'Token dipantau', title: 'Token ini ada di watchlist Anda.' };
  return null;
}

export const SCORE_COMPONENT_LABELS = Object.freeze({
  profitability: 'Profitabilitas (ber-shrinkage)',
  consistency: 'Konsistensi mingguan',
  sampleSize: 'Ukuran sampel',
  risk: 'Risiko (drawdown)',
  diversification: 'Diversifikasi',
  history: 'Lama riwayat',
});

export const CONVICTION_COMPONENT_LABELS = Object.freeze({
  breadth: 'Lebar (klaster independen)',
  quality: 'Kualitas wallet',
  flow: 'Aliran bersih',
  repeat: 'Akumulasi berulang',
  recency: 'Kebaruan',
  exitPenalty: 'Penalti indikasi keluar',
  concentrationPenalty: 'Penalti dominasi satu klaster',
});

// Nama resmi = LINK_TYPES di backend/smartmoney/clusters.js (DIRECT_TRANSFER, COMMON_FUNDER, SHARED_DEPOSIT,
// CO_TRADING); alias lama tetap dikenali.
const CLUSTER_REASONS = Object.freeze({
  DIRECT_TRANSFER: 'Transfer langsung antar-wallet',
  TRANSFER: 'Transfer langsung antar-wallet',
  COMMON_FUNDER: 'Pendana pertama sama',
  SAME_FUNDER: 'Pendana pertama sama',
  FUNDER: 'Pendana pertama sama',
  SHARED_DEPOSIT: 'Alamat deposit exchange sama',
  SAME_DEPOSIT: 'Alamat deposit exchange sama',
  DEPOSIT: 'Alamat deposit exchange sama',
  CO_TRADING: 'Ko-trading (beli token sama ≤ 60 dtk)',
  COTRADE: 'Ko-trading (beli token sama ≤ 60 dtk)',
});
/** Jenis tautan klaster (nama `type` tidak dibakukan kontrak → dikenali longgar, sisanya apa adanya). */
export function clusterReasonLabel(type) {
  const key = String(type ?? '').toUpperCase().replaceAll('-', '_');
  return CLUSTER_REASONS[key] ?? (type ? String(type).replaceAll('_', ' ') : EMPTY);
}

/**
 * Keterangan bukti tautan klaster (selain tx): pendana bersama, alamat deposit bersama, atau jumlah token ko-trading.
 * @param {string} type jenis tautan (LINK_TYPES clusters.js atau alias)
 * @param {object|null} evidence
 * @returns {string|null}
 */
export function clusterEvidenceText(type, evidence) {
  const key = String(type ?? '').toUpperCase().replaceAll('-', '_');
  const e = evidence && typeof evidence === 'object' ? evidence : {};
  if (['COMMON_FUNDER', 'SAME_FUNDER', 'FUNDER'].includes(key) && typeof e.funder === 'string' && e.funder) return `pendana ${shortAddress(e.funder)}`;
  if (['SHARED_DEPOSIT', 'SAME_DEPOSIT', 'DEPOSIT'].includes(key) && typeof e.depositAddress === 'string' && e.depositAddress) {
    return `alamat deposit ${shortAddress(e.depositAddress)}`;
  }
  if (['CO_TRADING', 'COTRADE'].includes(key) && Array.isArray(e.tokens) && e.tokens.length) return `${e.tokens.length} token dibeli bersamaan`;
  return null;
}

/** "terkait N wallet" (N = anggota klaster selain wallet ini) atau 'mandiri'. */
export function clusterText(clusterSize) {
  if (!isNum(clusterSize) || clusterSize <= 1) return 'mandiri';
  return `terkait ${clusterSize - 1} wallet`;
}

/**
 * Label alamat dengan sumbernya. Label tanpa sumber tetap ditandai (prinsip kontrak #7).
 * @param {{ label?: string, category?: string, source?: string }|null} label
 */
export function labelText(label) {
  if (!label?.label) return null;
  return label.source ? `${label.label} (sumber: ${label.source})` : `${label.label} (tanpa sumber)`;
}

/**
 * Kalimat aktivitas yang TIDAK dihitung sebagai pembelian (RadarToken.excluded).
 * @param {{ transferIn?: number, cexWithdrawal?: number, bridge?: number, airdrop?: number, lp?: number, mint?: number }|null} excluded
 */
export function excludedSummary(excluded) {
  const n = (v) => (isNum(v) ? v : 0);
  const e = excluded ?? {};
  const parts = [
    `transfer masuk ${n(e.transferIn)}`,
    `penarikan exchange ${n(e.cexWithdrawal)}`,
    `bridge ${n(e.bridge)}`,
    `airdrop ${n(e.airdrop)}`,
    `LP ${n(e.lp)}`,
  ];
  if (n(e.mint) > 0) parts.push(`mint ${n(e.mint)}`);
  return `tidak dihitung sebagai pembelian: ${parts.join(', ')}`;
}

/**
 * Bukti flag (objek bebas dari server) → baris teks "kunci: nilai". Nilai objek/array diringkas, tidak pernah HTML.
 * @returns {string[]}
 */
export function evidenceLines(evidence) {
  if (evidence === null || evidence === undefined) return [];
  if (typeof evidence !== 'object') return [String(evidence)];
  if (Array.isArray(evidence)) return evidence.slice(0, 10).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
  return Object.entries(evidence).slice(0, 12).map(([k, v]) => {
    const text = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `${k}: ${text.length > 160 ? `${text.slice(0, 157)}…` : text}`;
  });
}

/**
 * Ringkasan item watchlist (`summary` tidak dibakukan kontrak): string apa adanya; objek → potongan dikenal.
 * @returns {string}
 */
export function watchSummaryText(summary) {
  if (typeof summary === 'string') return summary;
  if (!summary || typeof summary !== 'object') return '';
  const parts = [];
  if (summary.label) parts.push(String(summary.label));
  if (summary.symbol) parts.push(String(summary.symbol));
  if (isNum(summary.score)) parts.push(`skor ${Math.round(summary.score)}`);
  if (isNum(summary.conviction)) parts.push(`keyakinan ${Math.round(summary.conviction)}`);
  if (summary.state) parts.push(stateLabel(summary.state).label);
  if (summary.text) parts.push(String(summary.text));
  return parts.join(' · ');
}

// ---------------------------------------------------------------- meta / status

/**
 * Teks strip status dari blok `meta` respons. `now` disuplai pemanggil.
 * @returns {{ simulated: boolean, stale: boolean, noProvider: boolean, dataAsOf: number|null, lastSyncAt: number|null,
 *   chains: string[], wallets: number|null, activities: number|null, providersConfigured: number|null,
 *   attributions: string[], truncated: boolean }} attributions = atribusi wajib provider aktif (ekstensi meta)
 */
export function metaStatus(meta) {
  const m = meta ?? {};
  const cov = m.coverage ?? {};
  return {
    simulated: m.simulated === true,
    // Tanpa meta (respons rusak) dianggap basi: lebih aman memperingatkan daripada menyiratkan data segar.
    stale: m.isStale !== false,
    noProvider: m.providersConfigured === 0,
    dataAsOf: isNum(m.dataAsOf) ? m.dataAsOf : null,
    lastSyncAt: isNum(m.lastSyncAt) ? m.lastSyncAt : null,
    chains: Array.isArray(cov.chains) ? cov.chains.filter((c) => typeof c === 'string') : [],
    wallets: isNum(cov.wallets) ? cov.wallets : null,
    activities: isNum(cov.activities) ? cov.activities : null,
    providersConfigured: isNum(m.providersConfigured) ? m.providersConfigured : null,
    attributions: Array.isArray(m.attributions) ? [...new Set(m.attributions.filter((a) => typeof a === 'string' && a.trim()))].slice(0, 10) : [],
    truncated: m.truncated === true,
  };
}

/** Keadaan "belum ada sumber data": tidak ada provider terkonfigurasi DAN tidak ada data. */
export function isNoSourceState(meta, itemCount) {
  return meta?.providersConfigured === 0 && !(itemCount > 0);
}

// ---------------------------------------------------------------- query

const ALLOWED_MIN_BUYERS = /^[1-9][0-9]?$/;

/**
 * Filter radar (nilai form/hash mentah) → path API. Nilai tidak valid diabaikan; jendela default 24h.
 * @param {{ window?: string, chain?: string, minBuyers?: string|number, state?: string, linked?: boolean|string, limit?: number }} f
 */
export function buildRadarQuery(f = {}) {
  const p = new URLSearchParams();
  p.set('window', RADAR_WINDOWS.includes(f.window) ? f.window : '24h');
  if (isChain(f.chain)) p.set('chain', f.chain);
  if (ALLOWED_MIN_BUYERS.test(String(f.minBuyers ?? ''))) p.set('minBuyers', String(Number(f.minBuyers)));
  if (RADAR_STATES.includes(f.state)) p.set('state', f.state);
  if (f.linked === true || f.linked === 'true' || f.linked === '1' || f.linked === 'on') p.set('linked', 'true');
  const limit = Number.isInteger(f.limit) && f.limit > 0 && f.limit <= 500 ? f.limit : DEFAULT_RADAR_LIMIT;
  p.set('limit', String(limit));
  return `${SM_API}/radar?${p.toString()}`;
}

/** Filter awal radar dari query hash (#/smart-money?window=4h&chain=base…). */
export function parseRadarFilters(query) {
  const window = query.get('window');
  const chain = query.get('chain');
  const state = query.get('state');
  const minBuyers = query.get('minBuyers') ?? '';
  return {
    window: RADAR_WINDOWS.includes(window) ? window : '24h',
    chain: isChain(chain) ? chain : '',
    minBuyers: ALLOWED_MIN_BUYERS.test(minBuyers) ? minBuyers : '',
    state: RADAR_STATES.includes(state) ? state : '',
    linked: query.get('linked') === 'true' || query.get('linked') === '1',
  };
}

/**
 * Filter Wallet Discovery → path API.
 * @param {{ chain?: string, eligible?: boolean, style?: string, minScore?: string|number, includeFlagged?: boolean, limit?: number }} f
 */
export function buildWalletsQuery(f = {}) {
  const p = new URLSearchParams();
  if (isChain(f.chain)) p.set('chain', f.chain);
  if (f.eligible === true) p.set('eligible', 'true');
  if (TRADING_STYLES.includes(f.style)) p.set('style', f.style);
  const min = Number(f.minScore);
  if (f.minScore !== '' && f.minScore !== null && f.minScore !== undefined && Number.isInteger(min) && min >= 0 && min <= 100) p.set('minScore', String(min));
  if (f.includeFlagged === true) p.set('includeFlagged', 'true');
  const limit = Number.isInteger(f.limit) && f.limit > 0 && f.limit <= 500 ? f.limit : DEFAULT_WALLETS_LIMIT;
  p.set('limit', String(limit));
  return `${SM_API}/wallets?${p.toString()}`;
}

/** Path API alerts: ?unread=true&kind=…&limit=… */
export function buildAlertsQuery({ unread = false, kind = '', limit = 100 } = {}) {
  const p = new URLSearchParams();
  if (unread) p.set('unread', 'true');
  if (ALERT_KINDS.includes(kind)) p.set('kind', kind);
  p.set('limit', String(limit));
  return `${SM_API}/alerts?${p.toString()}`;
}

export const entityPath = (kind, chain, address) => `${SM_API}/${kind}/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`;

// ---------------------------------------------------------------- preferensi notifikasi

/**
 * Batas validasi klien — cermin validateAlertPrefs (backend/smartmoney/alerts.js); server tetap memvalidasi ulang.
 * cooldownHours = cooldownMs server 60 000..604 800 000 ms (1 menit..7 hari) dalam jam.
 */
export const ALERT_PREF_LIMITS = Object.freeze({
  minUsd: [0, 1e12],
  largeSellUsd: [0, 1e12],
  minWalletScore: [0, 100],
  minIndependentBuyers: [1, 100],
  cooldownHours: [1 / 60, 168],
});

const RULE_SUFFIX = Object.freeze({ cooldownHours: ' jam (minimal 1 menit, maksimal 7 hari)' });

/**
 * maxEventAgeMs (umur peristiwa maksimum, alerts.js: bilangan bulat 60 000..604 800 000 ms) tidak ditampilkan sebagai
 * field form — nilai dari server dibawa apa adanya agar penyimpanan form tidak diam-diam mengembalikannya ke default.
 */
const EVENT_AGE_LIMITS_MS = Object.freeze([60_000, 7 * 24 * HOUR_MS]);
const validEventAge = (v) => Number.isInteger(v) && v >= EVENT_AGE_LIMITS_MS[0] && v <= EVENT_AGE_LIMITS_MS[1];
const limitText = (v) => v.toLocaleString('id-ID', { maximumFractionDigits: 3 });

const toNumber = (raw) => {
  if (raw === null || raw === undefined) return Number.NaN;
  if (typeof raw === 'number') return raw;
  const text = String(raw).trim().replace(',', '.');
  return text === '' ? Number.NaN : Number(text);
};

/** Preferensi server → nilai form (cooldownMs → jam; maxEventAgeMs valid dibawa tanpa field). */
export function prefsToForm(prefs) {
  const p = prefs ?? {};
  return {
    ...(validEventAge(p.maxEventAgeMs) ? { maxEventAgeMs: p.maxEventAgeMs } : {}),
    kinds: Array.isArray(p.kinds) ? p.kinds.filter((k) => ALERT_KINDS.includes(k)) : [...ALERT_KINDS],
    minUsd: isNum(p.minUsd) ? p.minUsd : 1000,
    largeSellUsd: isNum(p.largeSellUsd) ? p.largeSellUsd : 10000,
    minWalletScore: isNum(p.minWalletScore) ? p.minWalletScore : 60,
    minIndependentBuyers: isNum(p.minIndependentBuyers) ? p.minIndependentBuyers : 3,
    cooldownHours: isNum(p.cooldownMs) ? p.cooldownMs / HOUR_MS : 6,
    watchlistOnly: p.watchlistOnly === true,
  };
}

/**
 * Validasi form preferensi notifikasi di klien.
 * @param {{ kinds?: string[], minUsd?: unknown, largeSellUsd?: unknown, minWalletScore?: unknown,
 *   minIndependentBuyers?: unknown, cooldownHours?: unknown, watchlistOnly?: unknown, maxEventAgeMs?: unknown }} form
 *   maxEventAgeMs (bawaan server, tanpa field) diteruskan hanya bila valid; selain itu dihilangkan (server memakai
 *   nilai default).
 * @returns {{ prefs: object|null, errors: Record<string, string> }} prefs null bila ada error
 */
export function validateAlertPrefsClient(form) {
  const f = form ?? {};
  const errors = {};
  const kinds = Array.isArray(f.kinds) ? [...new Set(f.kinds)] : [];
  const unknownKinds = kinds.filter((k) => !ALERT_KINDS.includes(k));
  if (unknownKinds.length) errors.kinds = `Jenis tidak dikenal: ${unknownKinds.join(', ')}`;

  const num = (field, { integer = false } = {}) => {
    const value = toNumber(f[field]);
    const [lo, hi] = ALERT_PREF_LIMITS[field];
    const rule = `${integer ? 'Bilangan bulat' : 'Angka'} ${limitText(lo)}–${limitText(hi)}${RULE_SUFFIX[field] ?? ''}`;
    if (Number.isNaN(value)) errors[field] = `Wajib diisi (${rule.toLowerCase()})`;
    else if (!Number.isFinite(value) || value < lo || value > hi || (integer && !Number.isInteger(value))) errors[field] = rule;
    return value;
  };
  const minUsd = num('minUsd');
  const largeSellUsd = num('largeSellUsd');
  const minWalletScore = num('minWalletScore');
  const minIndependentBuyers = num('minIndependentBuyers', { integer: true });
  const cooldownHours = num('cooldownHours');
  const watchlistOnly = f.watchlistOnly === true || f.watchlistOnly === 'on' || f.watchlistOnly === 'true';

  if (Object.keys(errors).length) return { prefs: null, errors };
  return {
    prefs: {
      kinds: ALERT_KINDS.filter((k) => kinds.includes(k)),
      minUsd,
      largeSellUsd,
      minWalletScore,
      minIndependentBuyers,
      cooldownMs: Math.round(cooldownHours * HOUR_MS),
      watchlistOnly,
      ...(validEventAge(f.maxEventAgeMs) ? { maxEventAgeMs: f.maxEventAgeMs } : {}),
    },
    errors,
  };
}

const PREF_FIELDS = ['kinds', 'minUsd', 'largeSellUsd', 'minWalletScore', 'minIndependentBuyers', 'cooldownMs', 'watchlistOnly'];

/**
 * `details` error 400 server → error per field form + daftar umum. Detail berupa string (dicocokkan dengan nama
 * field yang disebut) atau objek { field|path, message } — path gaya JSON Pointer `/prefs/minUsd` (server
 * smart money) maupun `prefs.minUsd`.
 * @returns {{ fields: Record<string, string>, general: string[] }}
 */
export function mapServerPrefErrors(details) {
  const out = { fields: {}, general: [] };
  const list = Array.isArray(details) ? details : details ? [details] : [];
  for (const d of list) {
    const message = typeof d === 'string' ? d : typeof d?.message === 'string' ? d.message : JSON.stringify(d);
    let field = typeof d === 'object' && d ? String(d.field ?? d.path ?? '').replace(/^\/?prefs[./]/, '') : '';
    if (!PREF_FIELDS.includes(field)) field = PREF_FIELDS.find((name) => message.includes(name)) ?? '';
    const formField = field === 'cooldownMs' ? 'cooldownHours' : field;
    if (formField && !out.fields[formField]) out.fields[formField] = message;
    else out.general.push(message);
  }
  return out;
}

// ---------------------------------------------------------------- LONG Scanner

/**
 * Info chip "SM ×N" untuk baris LONG Scanner dari GET /screener-links (`items[futuresSymbol]`).
 * `simulated` = meta.simulated respons; item.isSimulated juga dibaca. Data simulasi WAJIB diberi penanda SIMULASI.
 * @param {Record<string, object>|null} links
 * @param {string} symbol
 * @param {{ simulated?: boolean }} [options]
 * @returns {{ text: string, title: string, href: string|null, simulated: boolean }|null} null bila simbol tidak ada di peta
 */
export function screenerChipInfo(links, symbol, { simulated = false } = {}) {
  if (!links || typeof links !== 'object' || typeof symbol !== 'string' || !Object.hasOwn(links, symbol)) return null;
  const info = links[symbol];
  if (!info || typeof info !== 'object') return null;
  const n = isNum(info.independentBuyers) ? Math.max(0, Math.round(info.independentBuyers)) : 0;
  const conviction = clampScore(info.conviction);
  const st = stateLabel(info.state).label;
  const key = parseTokenKey(info.tokenKey) ?? (isChain(info.chain) && typeof info.address === 'string' ? { chain: info.chain, address: info.address } : null);
  const chainName = CHAIN_LABELS[key?.chain ?? info.chain] ?? info.chain ?? '';
  const sim = simulated === true || info.isSimulated === true;
  const title = `${sim ? 'DATA SIMULASI — bukan data live. ' : ''}Smart money on-chain${chainName ? ` (${chainName})` : ''}: ${n} pembeli independen · keyakinan ${conviction ?? EMPTY}/100 (bukan probabilitas) · ${st}. Aktivitas spot on-chain ≠ posisi futures.`;
  return { text: `SM ×${n}`, title, href: key ? smartTokenHref(key.chain, key.address) : null, simulated: sim };
}

// ---------------------------------------------------------------- evaluasi historis

const ciText = (v) => (Array.isArray(v) && v.length === 2 && v.every(isNum) ? `${formatRatioPct(v[0])}–${formatRatioPct(v[1])}` : EMPTY);
const stringsOf = (list, max) => (Array.isArray(list) ? list.filter((w) => typeof w === 'string' && w).slice(0, max) : []);

/**
 * Ringkasan laporan evaluasi historis (GET /api/smart-money/evaluation → laporan terakhir `npm run smart-money:evaluate`)
 * untuk panel UI. Hanya membaca angka laporan (return dalam PECAHAN); tidak ada yang dihitung ulang atau dikarang.
 * @param {{ available?: boolean, computedAt?: number, isSimulated?: boolean, report?: object }|null} data
 * @returns {{ available: false }|{ available: true, simulated: boolean, computedAt: number|null, start: number|null,
 *   end: number|null, steps: number|null, stepLabel: string, windowLabel: string, minIndependentBuyers: number|null,
 *   signals: number, candidates: number, rows: Array<{ horizon: string, signals: number, coverage: string, mean: string,
 *   median: string, hitRate: string, hitRateCi: string, baseline: string, excess: string, warnings: string[] }>,
 *   warnings: string[] }}
 */
export function evaluationSummary(data) {
  const report = data?.report;
  if (data?.available !== true || !report || typeof report !== 'object' || !Array.isArray(report.overall)) return { available: false };
  const p = report.params ?? {};
  const s = report.summary ?? {};
  return {
    available: true,
    simulated: data.isSimulated === true || report.data?.simulated === true,
    computedAt: isNum(data.computedAt) ? data.computedAt : null,
    start: isNum(p.start) ? p.start : null,
    end: isNum(p.end) ? p.end : null,
    steps: isNum(s.steps) ? s.steps : null,
    stepLabel: formatDurationShort(p.stepMs),
    windowLabel: formatDurationShort(p.windowMs),
    minIndependentBuyers: isNum(p.minIndependentBuyers) ? p.minIndependentBuyers : null,
    signals: isNum(s.signals) ? s.signals : 0,
    candidates: isNum(s.candidates) ? s.candidates : 0,
    rows: report.overall.map((m) => ({
      horizon: formatDurationShort(m?.horizonMs),
      signals: isNum(m?.signals) ? m.signals : 0,
      coverage: formatRatioPct(m?.coverage),
      mean: formatReturnFraction(m?.mean),
      median: formatReturnFraction(m?.median),
      hitRate: formatRatioPct(m?.hitRate),
      hitRateCi: ciText(m?.hitRateCi),
      baseline: formatReturnFraction(m?.baselineMean),
      excess: formatReturnFraction(m?.excessMean),
      warnings: stringsOf(m?.warnings, 6),
    })),
    warnings: stringsOf(report.warnings, 12),
  };
}

// ---------------------------------------------------------------- sinkronisasi manual (GET/POST /api/smart-money/sync)

/** Fase run sinkronisasi (`run.phase` GET /api/smart-money/sync), urut. */
export const SYNC_PHASES = Object.freeze(['start', 'mapping', 'discovery', 'transfers', 'analysis', 'alerts']);

const SYNC_PHASE_LABELS = Object.freeze({
  start: 'Menyiapkan',
  mapping: 'Pemetaan kontrak Binance',
  discovery: 'Penemuan wallet',
  transfers: 'Riwayat transaksi wallet',
  analysis: 'Menghitung skor & radar',
  alerts: 'Menyusun alert',
});

/** Jeda bawaan loop terjadwal worker scanner (SMART_MONEY_SYNC_MINUTES) bila server tidak mengirim intervalMinutes. */
export const SYNC_DEFAULT_INTERVAL_MINUTES = 15;
/** Batas pemantauan progres di UI (menit) — lihat syncErrorText('POLL_TIMEOUT'). */
export const SYNC_POLL_CAP_MINUTES = 15;
export const SYNC_NOT_ADMIN = 'Hanya admin yang dapat menjalankan sinkronisasi';
/** Penjelasan reason/error NO_PROVIDERS (langkah lengkap: docs/17-panduan-smart-money.md §5). */
export const SYNC_NO_PROVIDERS_HELP = 'Belum ada provider data smart money yang aktif, jadi sinkronisasi tidak dapat dijalankan. '
  + 'Isi ETHERSCAN_API_KEY di file .env folder proyek, lalu hentikan server (Ctrl+C) dan jalankan npm start lagi — '
  + '.env hanya dibaca saat server mulai. Langkah lengkap: docs/17-panduan-smart-money.md §5.';
/**
 * Petunjuk hasil saat tidak ada wallet yang dilacak (lastRun.wallets.tracked === 0): hanya kunci Etherscan → penemuan
 * wallet dilewati dan run "berhasil" dengan angka nol semua.
 */
export const SYNC_NO_WALLETS_HINT = 'Belum ada wallet yang dilacak — ikuti wallet lewat Watchlist & Alerts, atau isi kunci '
  + 'Binance read-only (BINANCE_API_KEY + BINANCE_API_SECRET) agar wallet baru ditemukan otomatis.';

const SYNC_MESSAGE_MAX = 300;
const clipText = (text) => (text.length > SYNC_MESSAGE_MAX ? `${text.slice(0, SYNC_MESSAGE_MAX - 1)}…` : text);

/** 'Otomatis tiap 15 menit saat scanner berjalan' dari `intervalMinutes` GET /sync (null/tidak valid → 15). */
export function syncAutoHint(intervalMinutes) {
  const minutes = isNum(intervalMinutes) && intervalMinutes > 0 ? Math.round(intervalMinutes) : SYNC_DEFAULT_INTERVAL_MINUTES;
  return `Otomatis tiap ${minutes || SYNC_DEFAULT_INTERVAL_MINUTES} menit saat scanner berjalan`;
}

/** Label fase run; fase baru yang belum dikenal tampil apa adanya. */
export function syncPhaseLabel(phase) {
  if (typeof phase === 'string' && Object.hasOwn(SYNC_PHASE_LABELS, phase)) return SYNC_PHASE_LABELS[phase];
  return typeof phase === 'string' && phase ? phase.replaceAll('_', ' ') : 'Sinkronisasi';
}

/**
 * Siapa yang menjalankan run: 'terjadwal (worker scanner)' (loop worker) atau 'manual' (tombol Sync sekarang).
 * `trigger` didahulukan; tanpa trigger, owner 'worker' berarti loop terjadwal dan owner 'server' berarti manual.
 * @param {{ owner?: string, trigger?: string }|null|undefined} run
 * @returns {string|null}
 */
export function syncRunnerLabel(run) {
  const owner = run?.owner;
  const trigger = run?.trigger === 'manual' || run?.trigger === 'schedule' ? run.trigger
    : owner === 'worker' ? 'schedule' : owner === 'server' ? 'manual' : null;
  if (trigger === 'manual') return 'manual';
  if (trigger === 'schedule') return owner === 'server' ? 'terjadwal' : 'terjadwal (worker scanner)';
  return null;
}

/** Rasio progres 0..1 dari done/total, atau null bila tidak diketahui (bar indeterminate). */
export function syncProgressRatio(run) {
  if (!isNum(run?.done) || !isNum(run?.total) || run.total <= 0) return null;
  return Math.min(1, Math.max(0, run.done / run.total));
}

/**
 * Bagian teks progres run yang sedang berjalan: fase, 'x/y wallet', lama berjalan, dan siapa yang menjalankan.
 * `now` disuplai pemanggil (epoch ms). Bagian yang tidak diketahui → null.
 * @returns {{ phase: string, count: string|null, elapsed: string|null, runner: string|null }}
 */
export function syncProgressParts(run, now) {
  const r = run && typeof run === 'object' ? run : {};
  const count = syncProgressRatio(r) === null ? null
    : `${formatInteger(r.done)}/${formatInteger(r.total)}${r.phase === 'transfers' ? ' wallet' : ''}`;
  const elapsed = isNum(r.startedAt) && isNum(now) ? `berjalan ${formatDuration(Math.max(0, now - r.startedAt) / 1000)}` : null;
  return { phase: syncPhaseLabel(r.phase), count, elapsed, runner: syncRunnerLabel(r) };
}

/** 'Riwayat transaksi wallet · 12/50 wallet · berjalan 1 mnt 20 dtk · terjadwal (worker scanner)' */
export function syncProgressText(run, now) {
  const p = syncProgressParts(run, now);
  return [p.phase, p.count, p.elapsed, p.runner].filter(Boolean).join(' · ');
}

const SYNC_STATUS = Object.freeze({
  OK: ['Berhasil', 'bull'],
  DEGRADED: ['Selesai dengan catatan', 'warn'],
  NO_PROVIDERS: ['Belum ada sumber data', 'warn'],
  ABORTED: ['Dihentikan', 'warn'],
  FAILED: ['Gagal', 'bear'],
});

/**
 * Status run terakhir (`lastRun.status`) → label badge. Status baru yang belum dikenal tampil apa adanya.
 * @returns {{ label: string, tone: string|undefined }}
 */
export function syncStatusLabel(status) {
  if (typeof status === 'string' && Object.hasOwn(SYNC_STATUS, status)) {
    const [label, tone] = SYNC_STATUS[status];
    return { label, tone };
  }
  return { label: typeof status === 'string' && status ? status : EMPTY, tone: undefined };
}

/**
 * Ringkasan angka run (`lastRun`, bentuk publicLastRun di backend/api/smartMoneyRoutes.js) sebagai baris pendek.
 * Baris yang angkanya tidak ada dilewati; status NO_PROVIDERS tidak menyentuh data sehingga tanpa baris angka.
 * Tanpa wallet yang dilacak (wallets.tracked === 0) baris terakhir adalah SYNC_NO_WALLETS_HINT.
 * @returns {string[]}
 */
export function syncResultLines(lastRun) {
  const r = lastRun && typeof lastRun === 'object' ? lastRun : {};
  if (r.status === 'NO_PROVIDERS') return [];
  const n = formatInteger;
  const positive = (v) => isNum(v) && v > 0;
  const lines = [];
  const w = r.wallets && typeof r.wallets === 'object' ? r.wallets : {};
  if (isNum(w.synced)) {
    const extra = [];
    if (positive(w.failed)) extra.push(`${n(w.failed)} gagal`);
    if (positive(w.deferred)) extra.push(`${n(w.deferred)} ditunda`);
    if (positive(w.skippedNoProvider)) extra.push(`${n(w.skippedNoProvider)} tanpa provider`);
    lines.push(`Wallet: ${n(w.synced)} tersinkron${isNum(w.selected) ? ` dari ${n(w.selected)} dipilih` : ''}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  }
  const transfer = [isNum(r.fetched) ? `${n(r.fetched)} diambil` : null, isNum(r.inserted) ? `${n(r.inserted)} aktivitas baru` : null].filter(Boolean);
  if (transfer.length) lines.push(`Transfer: ${transfer.join(' · ')}`);
  const d = r.discovery && typeof r.discovery === 'object' ? r.discovery : {};
  if (isNum(d.added)) lines.push(`Penemuan wallet: ${n(d.added)} wallet baru${positive(d.candidates) ? ` dari ${n(d.candidates)} kandidat` : ''}`);
  const m = r.mapping && typeof r.mapping === 'object' ? r.mapping : {};
  if (isNum(m.upserted)) lines.push(`Pemetaan Binance: ${n(m.upserted)} kontrak diperbarui${positive(m.rejected) ? ` (${n(m.rejected)} ditolak)` : ''}`);
  if (isNum(r.alerts)) lines.push(`Alert baru: ${n(r.alerts)}`);
  if (w.tracked === 0) lines.push(SYNC_NO_WALLETS_HINT);
  return lines;
}

/**
 * `lastRun` adalah ringkasan run yang dipantau (run.startedAt, waktu server) — atau run sesudahnya. Ringkasan dengan
 * startedAt lebih awal berarti run itu berakhir tanpa menulis ringkasan baru. Tanpa `startedAt` run, ringkasan apa pun
 * diterima.
 */
export function isSyncResultOf(lastRun, startedAt) {
  if (!lastRun || typeof lastRun !== 'object') return false;
  if (!isNum(startedAt)) return true;
  if (isNum(lastRun.startedAt)) return lastRun.startedAt >= startedAt;
  return isNum(lastRun.finishedAt) && lastRun.finishedAt >= startedAt;
}

/** Sisa jeda trigger manual → 'Bisa dijalankan lagi dalam 45 dtk' ('' bila jeda sudah lewat). */
export function syncCooldownText(remainingMs) {
  if (!isNum(remainingMs) || remainingMs <= 0) return '';
  return `Bisa dijalankan lagi dalam ${formatDuration(Math.ceil(remainingMs / 1000))}`;
}

/**
 * Pesan Bahasa Indonesia untuk kode error/penolakan sinkronisasi (respons POST/GET /api/smart-money/sync, plus kode UI:
 * NETWORK, POLL_TIMEOUT, NO_RESULT, STATUS_FAILED). Kode tak dikenal memakai pesan server (teks biasa, dipotong).
 * @param {string|null|undefined} code
 * @param {{ retryAfterMs?: number|null, message?: string|null }} [options]
 */
export function syncErrorText(code, { retryAfterMs, message } = {}) {
  const wait = isNum(retryAfterMs) && retryAfterMs > 0 ? formatDuration(Math.ceil(retryAfterMs / 1000)) : null;
  const later = wait ? `dalam ${wait}` : 'sebentar lagi';
  // Pesan server tanpa titik penutup (kalimat ini menambah tanda baca sendiri).
  const msg = typeof message === 'string' && message.trim() ? clipText(message.trim().replace(/\.+$/, '')) : null;
  switch (code) {
    case 'SYNC_RUNNING': return 'Sinkronisasi lain sedang berjalan — progresnya ditampilkan di sini.';
    case 'NO_PROVIDERS': return SYNC_NO_PROVIDERS_HELP;
    case 'SYNC_COOLDOWN': return `Sinkronisasi manual baru saja dijalankan. Coba lagi ${later}.`;
    case 'RATE_LIMITED': return `Terlalu banyak permintaan ke server. Coba lagi ${later}.`;
    case 'FORBIDDEN':
    case 'NOT_ADMIN': return `${SYNC_NOT_ADMIN}.`;
    case 'CSRF_INVALID': return 'Token keamanan sesi kedaluwarsa. Muat ulang halaman lalu coba lagi.';
    case 'NETWORK': return 'Server tidak dapat dihubungi. Periksa koneksi lalu coba lagi.';
    case 'POLL_TIMEOUT':
      return `Pemantauan dihentikan setelah ${SYNC_POLL_CAP_MINUTES} menit. Sinkronisasi mungkin masih berjalan — muat ulang halaman untuk memeriksa statusnya.`;
    case 'NO_RESULT': return 'Sinkronisasi selesai, tetapi ringkasannya belum tersedia — muat ulang halaman atau lihat log server';
    case 'STATUS_FAILED': return `Status sinkronisasi tidak dapat dimuat${msg ? `: ${msg}` : ''}.`;
    default: {
      const tag = typeof code === 'string' && code && code !== 'UNKNOWN' ? ` (${code})` : '';
      return msg ? `Sinkronisasi gagal: ${msg}${tag}` : `Sinkronisasi gagal${tag}. Coba lagi.`;
    }
  }
}
