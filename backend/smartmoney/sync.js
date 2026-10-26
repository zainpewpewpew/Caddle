// Layanan sinkronisasi Insider / Smart Money Radar (docs/15 §4): pemetaan Binance → penemuan wallet → tarik transfer
// inkremental per kursor → normalisasi/dedupe → simpan transfer MENTAH → klasifikasi ulang tx yang tersentuh →
// PnL/flag/skor/klaster → alert → status provider. Satu-satunya tempat yang menggabungkan adapter provider (I/O
// jaringan) dengan repositori. Modul inti yang dipanggil tetap murni; waktu berasal dari `clock`.
//
// ─── Jaminan ────────────────────────────────────────────────────────────────────────────────────────
// - Kegagalan provider TIDAK PERNAH dilempar: dicatat per provider (state DEGRADED bila sebagian berhasil, DOWN bila
//   semua gagal) dan provider/wallet lain tetap diproses. RATE_LIMITED, UNAUTHORIZED, dan NOT_CONFIGURED menonaktifkan
//   provider itu sampai akhir run (tidak membebani provider yang sudah membatasi / kunci yang ditolak). Yang dilempar
//   hanya kesalahan pemrograman (argumen tidak valid). Data tak terduga yang membuat pemrosesan SATU wallet gagal
//   diisolasi: dicatat sebagai error INTERNAL di ringkasan & log, wallet lain lanjut.
// - Data terlambat: transfer mentah disimpan per wallet (sm_raw_transfers). Setiap tx yang menerima kaki baru (atau
//   kaki yang kini lebih lengkap) diklasifikasi ULANG secara utuh dari semua kaki tersimpan, lalu baris aktivitas tx
//   itu diganti atomik (replaceActivitiesForTxs): TRANSFER_IN berubah menjadi SWAP_BUY saat kaki quote datang
//   belakangan, dan baris yang tidak berlaku lagi (mis. TRANSFER_OUT USDC) dihapus.
// - Duplikat dibuang normalizeTransfers dua tahap: (1) di dalam kiriman provider, lalu (2) LINTAS RUN bersama kaki
//   tersimpan tx yang sama (baris tersimpan didahulukan dan dipertahankan) — kunci sama berisi berbeda dari run lain
//   (tabrakan logIndex antar-provider) diberi logIndex tabrakan normalize.js alih-alih mencampur dua transfer berbeda
//   pada satu baris, dan transfer berisi sama dari provider lain (aturan c) tidak tersimpan dua kali. Kiriman ulang
//   transfer yang dulu diberi logIndex tabrakan dikenali lebih dulu (isRekeyedResend). Kunci primer transfer mentah
//   (lintas run) menjamin sinkronisasi idempoten. Jumlah tabrakan → `summary.collisions`.
// - Hanya swap yang menjadi beli/jual (classify.js); data simulasi tetap bertanda isSimulated di setiap baris (adapter
//   bertanda isSimulated memaksa semua transfernya bertanda simulasi).
// - Pesan error yang disimpan/dicatat tanpa URL & kunci (ProviderError sudah menyamarkan; di sini URL dibuang lagi).
//
// ─── Kursor wallet ──────────────────────────────────────────────────────────────────────────────────
// sm_sync_cursors(provider, chain, wallet) menyimpan JSON `{ v: 1, cursor, since, maxSeen }`:
// - cursor: kursor provider untuk panggilan berikutnya. Paginasi berjalan selama nextCursor ≠ null sampai
//   maxPagesPerWallet halaman; bila batas tercapai nextCursor disimpan (dilanjutkan run berikutnya). Bila selesai,
//   disimpan `resumeCursor` adapter (ekstensi Etherscan/Routescan: blok terakhir yang terlihat) atau null.
//   Kegagalan di tengah paginasi: halaman yang sudah diterima tetap diproses dan kursor halaman yang gagal disimpan.
// - since: batas bawah waktu yang diminta. Run pertama = now − historyLookbackMs; setelah paginasi selesai =
//   maxSeen − sinceOverlapMs (tumpang-tindih agar data yang terlambat diindeks tetap terambil). `since` TIDAK diubah
//   selama kursor paginasi masih berjalan (offset kursor bergantung padanya).
// - Kegagalan total (tanpa halaman) menulis ulang kursor lama → waktu sinkron wallet maju sehingga wallet bergilir
//   ke belakang antrean (tidak menghalangi wallet lain).
// Urutan wallet per run: wallet di watchlist pengguna mana pun dulu, lalu yang belum pernah / paling lama
// disinkronkan; dibatasi config.maxWalletsPerSync. Wallet di chain tanpa provider transfer dilewati (dicatat).
//
// ─── Alert ──────────────────────────────────────────────────────────────────────────────────────────
// Alert diturunkan (alerts.js deriveAlertsDetailed) dari aktivitas BARU/BERUBAH di run ini yang berumur ≤
// alertMaxAgeMs (data historis yang baru tersinkron tidak membanjiri notifikasi) + radar 24 jam. Ambang = preferensi
// PALING LONGGAR di antara default dan semua preferensi tersimpan; cooldown = SATU nilai tetap server
// (alertCooldownMs) sehingga dedupeKey tidak bergantung preferensi pengguna mana pun. Peristiwa yang lebih tua dari
// maxEventAgeMs saat diturunkan (default alerts.js 30 menit = 2 × interval sinkronisasi) dilewati sebagai BASI: data
// lama yang baru tiba bukan "baru". maxEventAgeMs = nilai server `alertMaxEventAgeMs` (default = default alerts.js;
// hanya pemanggil penyemaian data uji/skenario yang memperbesarnya) atau nilai tersimpan pengguna yang lebih besar.
// Cooldown sejati: `lastAlertAt` = waktu PERISTIWA (event_at, atau created_at bila tidak ada) alert tersimpan per
// alertBaseKey (repo.lastAlertTimes). Jumlah kandidat netral yang ditahan → `summary.alertsSkipped { stale, cooldown }`.
// Penyaringan per pengguna (minUsd, minWalletScore, jenis, watchlistOnly, cooldown pengguna atas eventAt) dilakukan
// saat dibaca (GET /api/smart-money/alerts). Umur peristiwa TIDAK disaring ulang per pengguna (alert tersimpan sudah
// lolos aturan basi saat diturunkan; `eventAt` ikut dikirim sehingga keterlambatan terlihat).
// Teks alert NETRAL terhadap watchlist: alert diturunkan dua kali — tanpa watchlist (netral, disimpan apa adanya)
// dan dengan gabungan watchlist semua pengguna. Alert yang HANYA muncul karena wallet dipantau (mis. WALLET_EXIT,
// NEW_BUY tanpa nilai USD, wallet tidak eligible) disimpan dengan `evidence.watchOnly = true` dan hanya ditampilkan
// kepada pengguna yang memantau wallet tersebut. `isSimulated` alert = provenans alerts.js (aktivitas sumber
// bersimulasi), ditambah secara defensif: tx bukti atau aktivitas token di jendela yang bersimulasi. `eventAt`
// disimpan (sm_alerts.event_at).

import { DEFAULT_ALERT_PREFS, deriveAlertsDetailed, validateAlertPrefs } from './alerts.js';
import { analyzeUniverse } from './analyze.js';
import { matchToken } from './binanceMatch.js';
import { classifyWalletTransfers } from './classify.js';
import {
  ALERT_KINDS, CHAINS, NATIVE_TOKEN, RADAR_WINDOWS, ZERO_ADDRESS, isChain, isQuoteAsset, normalizeAddress,
  tokenKey as makeTokenKey, walletKey as makeWalletKey,
} from './contracts.js';
import { rankCandidates } from './discovery.js';
import { COLLISION_LOG_INDEX_BASE, normalizeTransfers } from './normalize.js';
import { buildImpliedPriceIndex } from './prices.js';
import { toProviderError } from './providers/errors.js';
import { buildAccumulationRadar } from './radar.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Parameter operasional sinkronisasi (dapat di-override lewat argumen `tuning`). */
export const DEFAULT_SYNC_TUNING = Object.freeze({
  /** Halaman fetchWalletTransfers maksimum per wallet per run (sisanya dilanjutkan via kursor). */
  maxPagesPerWallet: 5,
  /** Kedalaman riwayat pada sinkronisasi pertama wallet. */
  historyLookbackMs: 180 * DAY,
  /** Tumpang-tindih `since` terhadap transfer terbaru yang sudah terlihat. */
  sinceOverlapMs: HOUR,
  /** Interval penyegaran mapping Binance per provider. */
  mappingRefreshMs: DAY,
  /** Rentang waktu penemuan wallet (GeckoTerminal sendiri membatasi 24 jam). */
  discoveryLookbackMs: DAY,
  /** Kandidat maksimum per panggilan discoverWallets. */
  discoveryLimit: 100,
  /** Token MATCHED yang dipindai per run (bergilir; menjaga kuota provider penemuan yang lambat). */
  discoveryTokensPerRun: 4,
  /** Alamat per panggilan fetchLabels. */
  labelBatchSize: 100,
  /** Alamat per panggilan fetchPrices. */
  priceBatchSize: 100,
  /** Token maksimum yang harganya diminta ke provider per run. */
  maxPriceTokens: 300,
  /** Umur maksimum harga tersirat swap untuk PnL belum terealisasi. */
  impliedPriceStalenessMs: 7 * DAY,
  /** Aktivitas lebih tua dari ini tidak memicu alert (data historis yang baru tersinkron). */
  alertMaxAgeMs: DAY,
  /** Cooldown TETAP server untuk dedupeKey alert. */
  alertCooldownMs: DEFAULT_ALERT_PREFS.cooldownMs,
  /**
   * Umur maksimum peristiwa (saat diturunkan) agar dialertkan — lebih tua = basi (alerts.js maxEventAgeMs). Default =
   * default alerts.js. JANGAN diubah untuk produksi; hanya penyemaian data uji/skenario (peristiwa fixture berumur
   * berjam-jam) yang memberi nilai lebih besar secara eksplisit di panggilan penyemaian.
   */
  alertMaxEventAgeMs: DEFAULT_ALERT_PREFS.maxEventAgeMs,
  /** Entri error maksimum di ringkasan. */
  maxErrorsReported: 50,
});

/** Kunci sm_sync_state. */
export const SYNC_STATE_KEYS = Object.freeze({
  mapping: 'binanceMapRefresh',
  discovery: 'discoveryRotation',
  lastRun: 'lastRun',
});

const CURSOR_VERSION = 1;
const RAW_TX_CHUNK = 500;
const MESSAGE_MAX = 300;
const DISABLING_CODES = new Set(['RATE_LIMITED', 'UNAUTHORIZED', 'NOT_CONFIGURED']);
const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

const AMOUNT_REL_TOLERANCE = 1e-9; // sama dengan normalize.js (sisa pembulatan desimal antar-provider)

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const splitKey = (key) => {
  const i = key.indexOf(':');
  return { chain: key.slice(0, i), address: key.slice(i + 1) };
};
const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** Pesan aman untuk disimpan/dicatat: tanpa URL, tanpa karakter kontrol, dipotong. */
export function sanitizeProviderMessage(message) {
  return String(message ?? '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ') // eslint-disable-line no-control-regex
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MESSAGE_MAX);
}

function encodeCursorState({ cursor, since, maxSeen }) {
  return JSON.stringify({ v: CURSOR_VERSION, cursor: cursor ?? null, since: since ?? null, maxSeen: maxSeen ?? null });
}

/** Kursor tersimpan → { cursor, since, maxSeen }; nilai asing (bukan format v1) dianggap kursor provider mentah. */
function decodeCursorState(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && v.v === CURSOR_VERSION) {
      return {
        cursor: typeof v.cursor === 'string' && v.cursor !== '' ? v.cursor : null,
        since: isTime(v.since) ? v.since : null,
        maxSeen: isTime(v.maxSeen) ? v.maxSeen : null,
      };
    }
  } catch {
    // bukan JSON → kursor provider mentah
  }
  return { cursor: String(raw), since: null, maxSeen: null };
}

/** Parameter tuning yang diteruskan ke preferensi alerts.js → divalidasi dengan aturan yang sama di awal run. */
const TUNING_ALERT_PREFS = Object.freeze({ alertCooldownMs: 'cooldownMs', alertMaxEventAgeMs: 'maxEventAgeMs' });

function resolveTuning(tuning) {
  if (tuning === null || typeof tuning !== 'object' || Array.isArray(tuning)) throw new TypeError('tuning harus objek');
  for (const [key, value] of Object.entries(tuning)) {
    if (!Object.hasOwn(DEFAULT_SYNC_TUNING, key)) throw new TypeError(`Parameter sinkronisasi tidak dikenal: ${key}`);
    if (!(Number.isSafeInteger(value) && value >= 1)) throw new RangeError(`${key} harus bilangan bulat ≥ 1`);
    const pref = TUNING_ALERT_PREFS[key];
    const errors = pref ? validateAlertPrefs({ [pref]: value }) : [];
    if (errors.length) throw new RangeError(`${key}: ${errors.join('; ')}`);
  }
  return { ...DEFAULT_SYNC_TUNING, ...tuning };
}

function resolveConfig(config) {
  if (config === null || typeof config !== 'object') throw new TypeError('config (config.smartMoney) wajib objek');
  const maxWallets = config.maxWalletsPerSync ?? 50;
  if (!(Number.isSafeInteger(maxWallets) && maxWallets >= 1)) throw new RangeError('config.maxWalletsPerSync harus bilangan bulat ≥ 1');
  return { maxWalletsPerSync: maxWallets };
}

/**
 * Preferensi alert paling longgar (ambang terendah) di antara default & semua preferensi tersimpan yang valid.
 * Cooldown TIDAK diambil dari pengguna (dedupeKey stabil) — selalu `cooldownMs` server. Umur peristiwa maksimum =
 * nilai server `maxEventAgeMs` atau nilai tersimpan pengguna yang LEBIH BESAR (jendela basi paling longgar).
 * @param {Array<{ prefs: object }>} saved
 * @param {number} [cooldownMs]
 * @param {number} [maxEventAgeMs] nilai server (tuning alertMaxEventAgeMs)
 * @returns {typeof DEFAULT_ALERT_PREFS}
 */
export function permissiveAlertPrefs(saved, cooldownMs = DEFAULT_ALERT_PREFS.cooldownMs, maxEventAgeMs = DEFAULT_ALERT_PREFS.maxEventAgeMs) {
  const users = [];
  for (const row of Array.isArray(saved) ? saved : []) {
    if (row?.prefs && validateAlertPrefs(row.prefs).length === 0) users.push({ ...DEFAULT_ALERT_PREFS, ...row.prefs });
  }
  const all = [DEFAULT_ALERT_PREFS, ...users];
  return {
    kinds: [...ALERT_KINDS],
    minUsd: Math.min(...all.map((p) => p.minUsd)),
    largeSellUsd: Math.min(...all.map((p) => p.largeSellUsd)),
    minWalletScore: 0,
    minIndependentBuyers: Math.min(...all.map((p) => p.minIndependentBuyers)),
    cooldownMs,
    watchlistOnly: false,
    maxEventAgeMs: Math.max(maxEventAgeMs, ...users.map((p) => p.maxEventAgeMs)),
  };
}

/** Token MATCHED (chain + kontrak persis, tidak ambigu) dari baris mapping, urut chain lalu alamat. */
export function matchedTokensFromMapping(rows) {
  const byContract = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !isChain(r.chain) || typeof r.contractAddress !== 'string') continue;
    const key = `${r.chain}:${r.contractAddress}`;
    if (!byContract.has(key)) byContract.set(key, []);
    byContract.get(key).push(r);
  }
  const out = [];
  for (const list of byContract.values()) {
    const { chain, contractAddress } = list[0];
    const m = matchToken({ chain, address: contractAddress, symbol: null }, list);
    if (m.status === 'MATCHED') out.push({ chain, address: contractAddress, symbol: m.binanceAsset });
  }
  return out.sort((a, b) => cmp(a.chain, b.chain) || cmp(a.address, b.address));
}

/** Saldo bersih per wallet × token dari aktivitas sebelum `before` untuk wallet tertentu (masukan radar). */
function holdingsFromActivities(activities, before, walletKeys) {
  const wanted = new Set(walletKeys);
  const acc = new Map();
  for (const a of activities) {
    if (a.blockTime >= before) continue;
    const wKey = makeWalletKey(a.chain, a.wallet);
    if (!wanted.has(wKey)) continue;
    const tKey = makeTokenKey(a.chain, a.token.address);
    const k = `${wKey}|${tKey}`;
    const e = acc.get(k) ?? { wKey, tKey, qty: 0, gross: 0 };
    e.qty += a.direction === 'IN' ? a.amount : -a.amount;
    e.gross += a.amount;
    acc.set(k, e);
  }
  const out = new Map([...wanted].map((k) => [k, new Map()]));
  for (const e of acc.values()) {
    if (e.qty > e.gross * 1e-9) out.get(e.wKey).set(e.tKey, e.qty);
  }
  return out;
}

/** positions deriveAlerts: saldo sebelum aktivitas baru pertama & saldo akhir per wallet × token yang tersentuh. */
function positionsForAlerts(recent, activities) {
  const firstAt = new Map();
  for (const a of recent) {
    const k = `${makeWalletKey(a.chain, a.wallet)}|${makeTokenKey(a.chain, a.token.address)}`;
    if (!(firstAt.get(k) <= a.blockTime)) firstAt.set(k, a.blockTime);
  }
  const acc = new Map();
  for (const a of activities) {
    const wKey = makeWalletKey(a.chain, a.wallet);
    const tKey = makeTokenKey(a.chain, a.token.address);
    const k = `${wKey}|${tKey}`;
    const t0 = firstAt.get(k);
    if (t0 === undefined) continue;
    const e = acc.get(k) ?? { wKey, tKey, before: 0, after: 0, gross: 0 };
    const signed = a.direction === 'IN' ? a.amount : -a.amount;
    if (a.blockTime < t0) e.before += signed;
    e.after += signed;
    e.gross += a.amount;
    acc.set(k, e);
  }
  const out = new Map();
  const clean = (q, gross) => (q > gross * 1e-9 ? q : 0);
  for (const e of acc.values()) {
    if (!out.has(e.wKey)) out.set(e.wKey, new Map());
    out.get(e.wKey).set(e.tKey, { qtyBefore: clean(e.before, e.gross), qtyAfter: clean(e.after, e.gross) });
  }
  return out;
}

const rawKey = (t) => `${t.txHash}:${t.logIndex}`;

/** Isi transfer sama (alamat token, from, to, amount dengan toleransi relatif) — aturan isi normalize.js. */
function sameTransferContent(a, b) {
  return a.token?.address === b.token?.address && a.from === b.from && a.to === b.to
    && Math.abs(a.amount - b.amount) <= AMOUNT_REL_TOLERANCE * Math.max(Math.abs(a.amount), Math.abs(b.amount));
}

/**
 * Kiriman ulang (provider sama) transfer yang pada run SEBELUMNYA diberi logIndex tabrakan oleh normalize.js: kunci
 * aslinya dipegang transfer tersimpan berisi berbeda, dan ada transfer tersimpan berlogIndex ≥ COLLISION_LOG_INDEX_BASE
 * dari provider yang sama dengan isi sama. normalize.js mengenali kiriman ulang seperti ini hanya dalam SATU panggilan
 * (peta kunci asli tidak ikut tersimpan) — tanpa pemeriksaan ini transfer yang sama tersimpan lagi dengan logIndex
 * tabrakan berikutnya (dihitung ganda).
 * @param {object} t transfer ternormalisasi kiriman ini
 * @param {Map<string, object[]>} legsByTx kaki tersimpan per txHash
 */
function isRekeyedResend(t, legsByTx) {
  const legs = legsByTx.get(t.txHash) ?? [];
  const atKey = legs.find((x) => x.logIndex === t.logIndex);
  if (!atKey || sameTransferContent(atKey, t)) return false;
  return legs.some((x) => x.logIndex >= COLLISION_LOG_INDEX_BASE && x.provider === t.provider && sameTransferContent(x, t));
}

/** Alamat lawan dari transfer (from/to/initiator/toContract) selain wallet sendiri, nol, dan native. */
function counterpartiesOf(transfers, wallet) {
  const out = new Set();
  for (const t of transfers) {
    for (const a of [t.from, t.to, t.txMeta?.initiator, t.txMeta?.toContract, t.token?.address]) {
      if (typeof a === 'string' && a !== wallet && a !== ZERO_ADDRESS && a !== NATIVE_TOKEN) out.add(a);
    }
  }
  return [...out];
}

/**
 * Jalankan satu putaran sinkronisasi smart money.
 * @param {{
 *   repo: ReturnType<typeof import('./repository.js').createSmartMoneyRepository>,
 *   registry: { list: () => object[], withCapability: (cap: string, chain?: string) => object[], missing?: () => string[] },
 *   clock?: () => number, logger?: object,
 *   config: { maxWalletsPerSync?: number } ,
 *   nativePrices?: { priceAt: Function }|null,
 *   enrichNativeUsd?: ((transfers: object[], resolver: object) => Promise<object[]>)|null,
 *   signal?: AbortSignal, tuning?: Partial<typeof DEFAULT_SYNC_TUNING>,
 * }} deps config = config.smartMoney. nativePrices + enrichNativeUsd (nativePrices.js) mengisi nilai USD kaki
 *   native/wrapped-native yang tidak diberi provider.
 * @returns {Promise<object>} ringkasan run: { status: 'OK'|'DEGRADED'|'NO_PROVIDERS'|'ABORTED', startedAt, finishedAt,
 *   fetched, duplicates, rejected, collisions, reclassified, inserted, alerts, alertsSkipped: { stale, cooldown },
 *   wallets, discovery, mapping, scored, links, providers, errors, notes }
 */
export async function runSmartMoneySync({
  repo, registry, clock = Date.now, logger = NOOP_LOGGER, config, nativePrices = null, enrichNativeUsd = null, signal,
  tuning = {},
} = {}) {
  if (!repo || typeof repo.listAllActivities !== 'function') throw new TypeError('repo smart money wajib diisi');
  if (!registry || typeof registry.list !== 'function' || typeof registry.withCapability !== 'function') {
    throw new TypeError('registry provider wajib diisi');
  }
  if (typeof clock !== 'function') throw new TypeError('clock wajib fungsi');
  const cfg = resolveConfig(config);
  const tune = resolveTuning(tuning);
  const log = logger ?? NOOP_LOGGER;
  const now = Math.floor(clock());
  if (!isTime(now)) throw new TypeError('clock() harus mengembalikan epoch milidetik');

  const summary = {
    status: 'OK', startedAt: now, finishedAt: null,
    fetched: 0, duplicates: 0, rejected: 0, collisions: 0, reclassified: 0, inserted: 0, alerts: 0,
    alertsSkipped: { stale: 0, cooldown: 0 },
    wallets: { tracked: 0, selected: 0, synced: 0, failed: 0, deferred: 0, skippedNoProvider: 0 },
    discovery: { candidates: 0, added: 0, skippedChains: [] },
    mapping: { refreshed: [], upserted: 0, rejected: 0 },
    scored: 0, links: 0,
    providers: [], errors: [], notes: [],
  };
  let errorCount = 0;
  const pushError = (entry) => {
    errorCount += 1;
    if (summary.errors.length < tune.maxErrorsReported) summary.errors.push(entry);
  };
  const note = (text) => {
    if (!summary.notes.includes(text)) summary.notes.push(text);
  };
  const aborted = () => signal?.aborted === true;

  const adapters = registry.list();
  for (const id of typeof registry.missing === 'function' ? registry.missing() : []) {
    note(`Provider "${id}" dikonfigurasi tetapi belum tersedia (adapter belum dirakit atau kunci belum diisi).`);
  }
  if (adapters.length === 0) {
    summary.status = 'NO_PROVIDERS';
    note('Belum ada provider data smart money yang aktif (SMART_MONEY_PROVIDERS). Tidak ada data simulasi yang dipakai sebagai pengganti.');
    summary.finishedAt = Math.floor(clock());
    await repo.setSyncState(SYNC_STATE_KEYS.lastRun, summary, { now: summary.finishedAt });
    return summary;
  }

  // ---------------------------------------------------------------- pemanggil provider
  const stats = new Map(adapters.map((a) => [a.id, { attempted: 0, ok: 0, failed: 0, notSupported: 0, lastError: null, chains: new Set() }]));
  const disabled = new Set();
  const unsupported = new Set();

  /** Kegagalan provider (termasuk respons berbentuk salah) → statistik, ringkasan, log. */
  function recordFailure(adapter, code, message, ctx) {
    const st = stats.get(adapter.id);
    st.failed += 1;
    const clean = sanitizeProviderMessage(message);
    st.lastError = { code, message: clean };
    pushError({ provider: adapter.id, code, message: clean, method: ctx.method, chain: ctx.chain ?? null });
    log.warn({ provider: adapter.id, code, method: ctx.method, chain: ctx.chain ?? null }, 'panggilan provider smart money gagal');
    if (DISABLING_CODES.has(code) && !disabled.has(adapter.id)) {
      disabled.add(adapter.id);
      note(`Provider "${adapter.id}" dihentikan sampai akhir run (${code}).`);
    }
  }

  /**
   * Panggil metode adapter. Tidak pernah melempar untuk kegagalan provider.
   * @returns {Promise<{ ok: true, value: any } | { ok: false, code?: string, skipped?: boolean, aborted?: boolean }>}
   */
  async function call(adapter, method, args, ctx = {}) {
    if (aborted()) return { ok: false, aborted: true };
    if (disabled.has(adapter.id)) return { ok: false, skipped: true };
    const st = stats.get(adapter.id);
    st.attempted += 1;
    try {
      const value = await adapter[method]({ ...args, signal });
      st.ok += 1;
      if (ctx.chain) st.chains.add(ctx.chain);
      return { ok: true, value };
    } catch (err) {
      if (aborted()) return { ok: false, aborted: true };
      const e = toProviderError(err, adapter.id);
      if (e.code === 'NOT_SUPPORTED') {
        st.notSupported += 1;
        if (ctx.chain) unsupported.add(`${adapter.id}|${method}|${ctx.chain}`);
        return { ok: false, code: 'NOT_SUPPORTED' };
      }
      recordFailure(adapter, e.code, e.message, { ...ctx, method });
      return { ok: false, code: e.code };
    }
  }
  const usable = (adapter, method, chain) => !disabled.has(adapter.id) && !unsupported.has(`${adapter.id}|${method}|${chain}`);

  // ---------------------------------------------------------------- label
  const labelsFetched = new Set();
  /** Ambil label alamat dari provider berkapabilitas `labels` (sekali per alamat per run) lalu simpan. */
  async function fetchLabelsFor(chain, addresses) {
    const pending = addresses.filter((a) => !labelsFetched.has(`${chain}:${a}`));
    for (const a of pending) labelsFetched.add(`${chain}:${a}`);
    if (pending.length === 0) return;
    for (const p of registry.withCapability('labels', chain)) {
      for (const batch of chunks(pending, tune.labelBatchSize)) {
        if (!usable(p, 'fetchLabels', chain)) break;
        const r = await call(p, 'fetchLabels', { chain, addresses: batch }, { chain });
        if (!r.ok) continue;
        if (!Array.isArray(r.value)) {
          recordFailure(p, 'BAD_RESPONSE', `${p.id}: fetchLabels tidak mengembalikan array`, { method: 'fetchLabels', chain });
          continue;
        }
        const rows = r.value.filter((l) => l && typeof l === 'object' && l.chain === chain);
        const res = await repo.upsertLabels(rows);
        if (res.rejected.length) note(`Sebagian label dari "${p.id}" ditolak (mis. tanpa sumber) dan tidak disimpan.`);
      }
    }
  }

  // ---------------------------------------------------------------- (a) mapping Binance (≤ 1× / mappingRefreshMs)
  const mapState = (await repo.getSyncState(SYNC_STATE_KEYS.mapping))?.value ?? {};
  const mapByProvider = { ...(mapState && typeof mapState.byProvider === 'object' ? mapState.byProvider : {}) };
  for (const p of registry.withCapability('binanceMapping')) {
    const last = mapByProvider[p.id];
    if (isTime(last) && now - last < tune.mappingRefreshMs) continue;
    const r = await call(p, 'fetchBinanceMapping', {}, {});
    if (!r.ok) continue;
    if (!Array.isArray(r.value)) {
      recordFailure(p, 'BAD_RESPONSE', `${p.id}: fetchBinanceMapping tidak mengembalikan array`, { method: 'fetchBinanceMapping' });
      continue;
    }
    if (r.value.length === 0) {
      note(`Mapping Binance dari "${p.id}" kosong — mapping lama dipertahankan.`);
      continue;
    }
    const res = await repo.upsertBinanceMap(r.value, { provider: p.id });
    summary.mapping.upserted += res.upserted;
    summary.mapping.rejected += res.rejected.length;
    if (res.rejected.length) note(`${res.rejected.length} baris mapping Binance dari "${p.id}" ditolak (data tidak valid) dan dilewati.`);
    if (res.upserted > 0) {
      mapByProvider[p.id] = now;
      summary.mapping.refreshed.push(p.id);
    }
  }
  if (summary.mapping.refreshed.length) await repo.setSyncState(SYNC_STATE_KEYS.mapping, { byProvider: mapByProvider }, { now });

  // ---------------------------------------------------------------- wallet dilacak + watchlist
  const watch = await repo.listAllWatchlist();
  const watchedWallets = new Set();
  const watchedTokens = new Set();
  for (const w of watch) (w.kind === 'WALLET' ? watchedWallets : watchedTokens).add(makeWalletKey(w.chain, w.address));
  const tracked = new Map((await repo.listWallets({ limit: 100_000 })).map((w) => [makeWalletKey(w.chain, w.address), w]));
  const watchRows = [...watchedWallets].filter((k) => !tracked.has(k)).map((k) => ({
    ...splitKey(k), firstSeenAt: now, discoveredVia: 'watchlist', discoveryReason: 'Diikuti pengguna (watchlist)', isSimulated: false,
  }));
  if (watchRows.length) {
    await repo.upsertWallets(watchRows, { now });
    for (const r of watchRows) tracked.set(makeWalletKey(r.chain, r.address), { ...r, lastActivityAt: null });
  }

  // ---------------------------------------------------------------- (b) penemuan wallet
  const discoverers = registry.list().filter((p) => p.capabilities.has('walletDiscovery'));
  if (discoverers.length > 0 && !aborted()) {
    const matched = matchedTokensFromMapping(await repo.listBinanceMap());
    const discoveryChains = CHAINS.filter((c) => discoverers.some((p) => p.chains.includes(c)));
    for (const chain of discoveryChains) {
      if (!matched.some((t) => t.chain === chain)) {
        summary.discovery.skippedChains.push(chain);
        note(`Penemuan wallet ${chain} dilewati: belum ada token yang MATCHED di mapping Binance.`);
      }
    }
    const eligibleTokens = matched.filter((t) => discoveryChains.includes(t.chain));
    const rotState = (await repo.getSyncState(SYNC_STATE_KEYS.discovery))?.value ?? {};
    const offset = Number.isSafeInteger(rotState?.offset) && rotState.offset >= 0 ? rotState.offset % Math.max(1, eligibleTokens.length) : 0;
    const take = Math.min(tune.discoveryTokensPerRun, eligibleTokens.length);
    const picked = Array.from({ length: take }, (_, i) => eligibleTokens[(offset + i) % eligibleTokens.length]);
    if (eligibleTokens.length > 0) {
      await repo.setSyncState(SYNC_STATE_KEYS.discovery, { offset: (offset + take) % eligibleTokens.length }, { now });
    }
    const candidates = [];
    const simulatedCandidates = new Set();
    for (const chain of discoveryChains) {
      const tokens = picked.filter((t) => t.chain === chain);
      if (tokens.length === 0) continue;
      for (const p of registry.withCapability('walletDiscovery', chain)) {
        if (!usable(p, 'discoverWallets', chain)) continue;
        const r = await call(p, 'discoverWallets', {
          chain, since: now - tune.discoveryLookbackMs, limit: tune.discoveryLimit, tokens,
        }, { chain });
        if (!r.ok) continue;
        if (!Array.isArray(r.value)) {
          recordFailure(p, 'BAD_RESPONSE', `${p.id}: discoverWallets tidak mengembalikan array`, { method: 'discoverWallets', chain });
          continue;
        }
        for (const c of r.value) {
          if (!c || typeof c !== 'object' || (c.chain !== undefined && c.chain !== chain)) continue;
          candidates.push({ chain, address: c.address, source: nonEmpty(c.source) ? c.source : p.id, reason: c.reason ?? null });
          const a = normalizeAddress(chain, c.address);
          if (p.isSimulated && a) simulatedCandidates.add(makeWalletKey(chain, a));
        }
      }
    }
    summary.discovery.candidates = candidates.length;
    if (candidates.length) {
      for (const chain of CHAINS) {
        const addrs = [...new Set(candidates.filter((c) => c.chain === chain).map((c) => normalizeAddress(chain, c.address)).filter(Boolean))];
        if (addrs.length) await fetchLabelsFor(chain, addrs);
      }
      const labels = new Map();
      for (const chain of CHAINS) {
        const addrs = candidates.filter((c) => c.chain === chain).map((c) => c.address);
        if (addrs.length) for (const [k, v] of await repo.getLabels({ chain, addresses: addrs })) labels.set(k, v);
      }
      const ranked = rankCandidates(candidates, { labels, existing: [...tracked.keys()] }).slice(0, cfg.maxWalletsPerSync);
      const rows = ranked.map((c) => ({
        chain: c.chain, address: c.address, firstSeenAt: now, discoveredVia: c.source ?? 'discovery',
        discoveryReason: c.reason, isSimulated: simulatedCandidates.has(makeWalletKey(c.chain, c.address)),
      }));
      if (rows.length) {
        await repo.upsertWallets(rows, { now });
        for (const r of rows) tracked.set(makeWalletKey(r.chain, r.address), { ...r, lastActivityAt: null });
      }
      summary.discovery.added = rows.length;
    }
  }

  // ---------------------------------------------------------------- (c) transfer per wallet
  summary.wallets.tracked = tracked.size;
  const syncTimes = await repo.listWalletSyncTimes();
  const order = [];
  for (const [key, w] of tracked) {
    if (registry.withCapability('walletTransfers', w.chain).length === 0) {
      summary.wallets.skippedNoProvider += 1;
      continue;
    }
    order.push({ key, w, watched: watchedWallets.has(key), syncedAt: syncTimes.get(key) ?? null });
  }
  if (summary.wallets.skippedNoProvider > 0) {
    note(`${summary.wallets.skippedNoProvider} wallet dilewati: belum ada provider riwayat transfer untuk chain-nya.`);
  }
  order.sort((a, b) => (Number(b.watched) - Number(a.watched)) || ((a.syncedAt ?? -1) - (b.syncedAt ?? -1)) || cmp(a.key, b.key));
  const selected = order.slice(0, cfg.maxWalletsPerSync);
  summary.wallets.selected = selected.length;

  const touchedIds = new Set();
  const tokenMeta = new Map();
  let enrichFailed = false;

  /**
   * normalize (dalam kiriman, lalu lintas run bersama kaki tersimpan) → (USD native) → simpan mentah → label →
   * klasifikasi ulang tx tersentuh → ganti aktivitas.
   */
  async function processTransfers(adapter, chain, wallet, raw) {
    summary.fetched += raw.length;
    const sameChain = [];
    for (const t of raw) {
      if (!t || typeof t !== 'object' || t.chain !== chain) {
        summary.rejected += 1;
        continue;
      }
      if (!Number.isSafeInteger(t.blockTime) || !Number.isSafeInteger(t.logIndex)) {
        summary.rejected += 1; // repositori menyimpan epoch ms & logIndex sebagai bilangan bulat
        continue;
      }
      // Adapter simulasi → setiap transfernya bertanda simulasi (tidak pernah tampil sebagai data live).
      sameChain.push(adapter.isSimulated ? { ...t, isSimulated: true } : t);
    }
    // (1) Validasi & dedupe di dalam kiriman ini. Penolakan hanya dihitung untuk kiriman (bukan baris tersimpan).
    const batch = normalizeTransfers(sameChain);
    summary.rejected += batch.rejected.length;
    summary.collisions += batch.collisions;
    const valid = sameChain.length - batch.rejected.length;
    if (batch.transfers.length === 0) {
      summary.duplicates += valid;
      return;
    }
    // (2) Lintas run: kaki tersimpan tx yang sama dinormalisasi lebih dulu (dipertahankan); kiriman ulang transfer yang
    //     dulu diberi logIndex tabrakan dibuang lebih dulu (isRekeyedResend).
    const stored = [];
    for (const txBatch of chunks([...new Set(batch.transfers.map((t) => t.txHash))], RAW_TX_CHUNK)) {
      stored.push(...await repo.listRawTransfersForTxs(chain, wallet, txBatch));
    }
    let transfers = batch.transfers;
    let sameKeyResends = [];
    if (stored.length) {
      const legsByTx = new Map();
      for (const x of stored) {
        const list = legsByTx.get(x.txHash);
        if (list) list.push(x);
        else legsByTx.set(x.txHash, [x]);
      }
      const incoming = batch.transfers.filter((t) => !isRekeyedResend(t, legsByTx));
      const merged = normalizeTransfers([...stored, ...incoming]);
      summary.collisions += merged.collisions;
      transfers = merged.transfers;
      // Kiriman ulang berkunci & berisi sama diteruskan juga apa adanya: penyimpanan (mergeKnown) melengkapi field
      // yang belum diketahui pada baris tersimpan (mis. simbol '?') — normalize.js tidak melengkapi simbol.
      const storedByKey = new Map(stored.map((x) => [rawKey(x), x]));
      sameKeyResends = incoming.filter((t) => {
        const x = storedByKey.get(rawKey(t));
        return x !== undefined && sameTransferContent(x, t);
      });
    }
    const storedKeys = new Set(stored.map(rawKey));
    summary.duplicates += valid - transfers.filter((t) => !storedKeys.has(rawKey(t))).length;
    let priced = transfers;
    if (typeof enrichNativeUsd === 'function' && nativePrices && transfers.length) {
      try {
        priced = await enrichNativeUsd(transfers, nativePrices);
      } catch (err) {
        priced = transfers;
        if (!enrichFailed) {
          enrichFailed = true;
          note('Penilaian USD koin native gagal pada run ini — nilai USD tetap tidak diketahui (null), bukan 0.');
          log.warn({ err: sanitizeProviderMessage(err?.message) }, 'enrichNativeUsd gagal');
        }
      }
    }
    if (!Array.isArray(priced) || priced.length !== transfers.length) priced = transfers;
    // Baris tersimpan yang tidak berubah tidak ditulis ulang (insertRawTransfers hanya mengembalikan yang baru/berubah).
    const fresh = await repo.insertRawTransfers([...priced, ...sameKeyResends], wallet, { now });
    if (fresh.length === 0) return;
    for (const t of fresh) {
      const k = makeTokenKey(chain, t.token.address);
      if (!tokenMeta.has(k)) {
        tokenMeta.set(k, { chain, address: t.token.address, symbol: t.token.symbol === '?' ? null : t.token.symbol, name: t.token.name, decimals: t.token.decimals });
      }
    }
    await fetchLabelsFor(chain, counterpartiesOf(fresh, wallet));
    const txs = [...new Set(fresh.map((t) => t.txHash))];
    for (const batch of chunks(txs, RAW_TX_CHUNK)) {
      const legs = await repo.listRawTransfersForTxs(chain, wallet, batch);
      const labels = await repo.getLabels({ chain, addresses: counterpartiesOf(legs, wallet) });
      const activities = classifyWalletTransfers(legs, wallet, { labels });
      const res = await repo.replaceActivitiesForTxs(chain, wallet, batch, activities, { now });
      summary.inserted += res.newIds.length;
      summary.reclassified += res.changedIds.length + res.removedIds.length;
      for (const id of res.newIds) touchedIds.add(id);
      for (const id of res.changedIds) touchedIds.add(id);
    }
  }

  /**
   * Sinkronkan satu wallet dengan satu provider.
   * @returns {Promise<'DONE'|'FAILED'|'FALLBACK'|'ABORTED'>}
   */
  async function syncWalletWith(adapter, chain, wallet) {
    const stored = decodeCursorState(await repo.getCursor(adapter.id, chain, wallet));
    const since = stored?.since ?? now - tune.historyLookbackMs;
    let cursor = stored?.cursor ?? null;
    let maxSeen = stored?.maxSeen ?? null;
    let pages = 0;
    let failed = false;
    let resume = null;
    const raw = [];
    while (pages < tune.maxPagesPerWallet) {
      const r = await call(adapter, 'fetchWalletTransfers', { chain, address: wallet, since, cursor }, { chain });
      if (!r.ok) {
        if (r.aborted) return 'ABORTED';
        if (pages === 0 && (r.code === 'NOT_SUPPORTED' || r.code === 'NOT_CONFIGURED' || r.skipped)) return 'FALLBACK';
        failed = true;
        break;
      }
      const v = r.value;
      if (!v || typeof v !== 'object' || !Array.isArray(v.transfers)) {
        recordFailure(adapter, 'BAD_RESPONSE', `${adapter.id}: fetchWalletTransfers tidak mengembalikan { transfers: [] }`,
          { method: 'fetchWalletTransfers', chain });
        failed = true;
        break;
      }
      pages += 1;
      raw.push(...v.transfers);
      // Waktu dari masa depan (jam provider salah) tidak boleh memajukan `since` melewati sekarang.
      for (const t of v.transfers) if (t && isTime(t.blockTime) && t.blockTime <= now && t.blockTime > (maxSeen ?? -1)) maxSeen = t.blockTime;
      if (typeof v.resumeCursor === 'string' && v.resumeCursor !== '') resume = v.resumeCursor;
      const next = typeof v.nextCursor === 'string' && v.nextCursor !== '' ? v.nextCursor : null;
      if (next !== null && next === cursor) {
        note(`Provider "${adapter.id}" mengembalikan kursor yang sama — paginasi dihentikan untuk mencegah perulangan.`);
        cursor = null;
        break;
      }
      cursor = next;
      if (cursor === null) break;
    }
    if (raw.length) await processTransfers(adapter, chain, wallet, raw);
    let state;
    if (pages === 0) {
      state = stored ?? { cursor: null, since, maxSeen: null }; // tulis ulang → wallet bergilir ke belakang
    } else if (failed || cursor !== null) {
      state = { cursor, since, maxSeen }; // lanjutkan dari halaman berikutnya / yang gagal dengan `since` sama
    } else {
      state = { cursor: resume, since: maxSeen !== null ? Math.max(since, maxSeen - tune.sinceOverlapMs) : since, maxSeen };
    }
    await repo.setCursor(adapter.id, chain, wallet, encodeCursorState(state), { now });
    return failed ? 'FAILED' : 'DONE';
  }

  for (const item of selected) {
    if (aborted()) break;
    const { chain, address } = item.w;
    let outcome = 'FALLBACK';
    try {
      for (const p of registry.withCapability('walletTransfers', chain)) {
        if (!usable(p, 'fetchWalletTransfers', chain)) continue;
        outcome = await syncWalletWith(p, chain, address);
        if (outcome !== 'FALLBACK') break;
      }
    } catch (err) {
      if (aborted()) break;
      outcome = 'FAILED';
      pushError({ provider: null, code: 'INTERNAL', message: 'Kesalahan internal saat memproses wallet', method: 'sync', chain });
      log.error({ chain, err: sanitizeProviderMessage(err?.message) }, 'kesalahan internal sinkronisasi wallet smart money');
    }
    if (outcome === 'ABORTED') break;
    if (outcome === 'DONE') summary.wallets.synced += 1;
    else if (outcome === 'FAILED') summary.wallets.failed += 1;
    else {
      summary.wallets.deferred += 1;
      note(`Sebagian wallet ${chain} ditunda: provider transfer untuk chain ini tidak mendukungnya, belum dikonfigurasi, `
        + 'atau dihentikan sementara pada run ini (batas laju / kunci ditolak).');
    }
  }

  // ---------------------------------------------------------------- (d) metadata token
  if (tokenMeta.size) await repo.upsertTokens([...tokenMeta.values()], { now });

  if (aborted()) {
    summary.status = 'ABORTED';
    note('Sinkronisasi dihentikan sebelum analisis (shutdown / dibatalkan) — dilanjutkan pada run berikutnya.');
    await finish();
    return summary;
  }

  // ---------------------------------------------------------------- (e) analisis universe
  const analysisNow = Math.floor(clock());
  const activities = await repo.listAllActivities();
  const labelsAll = await repo.getLabels();
  const prices = buildImpliedPriceIndex(activities, { maxStalenessMs: tune.impliedPriceStalenessMs }).pricesAt(analysisNow);
  await mergeProviderPrices(activities, prices, analysisNow);
  const analysis = analyzeUniverse({ activities, labels: labelsAll, prices, now: analysisNow });

  const scoreRows = [];
  const walletRows = [];
  for (const [key, w] of analysis.wallets) {
    scoreRows.push({
      chain: w.chain, address: w.address, computedAt: analysisNow, score: w.score.score, eligible: w.score.eligible,
      style: w.score.style, clusterId: w.clusterId, components: w.score.components, metrics: w.score.metrics,
      reasons: w.score.reasons, limitations: w.score.limitations, flags: w.flags,
      pnl: { summary: w.pnl.summary, positions: w.pnl.positions },
    });
    const t = tracked.get(key);
    if (t && isTime(w.lastActivityAt) && w.lastActivityAt !== t.lastActivityAt) {
      walletRows.push({
        chain: t.chain, address: t.address, firstSeenAt: t.firstSeenAt, lastActivityAt: w.lastActivityAt,
        discoveredVia: t.discoveredVia, discoveryReason: t.discoveryReason ?? null, isSimulated: t.isSimulated === true,
      });
    }
  }
  summary.scored = await repo.saveWalletScores(scoreRows);
  if (walletRows.length) await repo.upsertWallets(walletRows, { now: analysisNow });
  for (const chain of CHAINS) {
    const links = analysis.links.filter((l) => l.chain === chain).map((l) => ({ a: l.a, b: l.b, type: l.type, evidence: l.evidence }));
    summary.links += await repo.replaceWalletLinks(chain, links, { now: analysisNow });
  }

  // ---------------------------------------------------------------- (f) alert
  summary.alerts = await deriveAndStoreAlerts({ activities, analysis, prices, analysisNow });

  await finish();
  return summary;

  // ================================================================= fungsi pembantu (closure)

  /** Harga provider (bila ada) menimpa harga tersirat untuk token non-quote yang masih dipegang wallet dilacak. */
  async function mergeProviderPrices(acts, priceMap, at) {
    const net = new Map();
    for (const a of acts) {
      if (a.token.address === NATIVE_TOKEN || isQuoteAsset(a.chain, a.token.address)) continue;
      const k = makeTokenKey(a.chain, a.token.address);
      net.set(k, (net.get(k) ?? 0) + (a.direction === 'IN' ? a.amount : -a.amount));
    }
    const held = [...net].filter(([, q]) => q > 0).map(([k]) => k).sort(cmp).slice(0, tune.maxPriceTokens);
    for (const chain of CHAINS) {
      let remaining = held.filter((k) => k.startsWith(`${chain}:`)).map((k) => splitKey(k).address);
      for (const p of registry.withCapability('prices', chain)) {
        if (remaining.length === 0 || aborted()) break;
        const got = new Set();
        for (const batch of chunks(remaining, tune.priceBatchSize)) {
          if (!usable(p, 'fetchPrices', chain)) break;
          const r = await call(p, 'fetchPrices', { chain, addresses: batch }, { chain });
          if (!r.ok) continue;
          if (!Array.isArray(r.value)) {
            recordFailure(p, 'BAD_RESPONSE', `${p.id}: fetchPrices tidak mengembalikan array`, { method: 'fetchPrices', chain });
            continue;
          }
          for (const row of r.value) {
            if (!row || row.chain !== chain) continue;
            const addr = normalizeAddress(chain, row.address);
            if (!addr || addr === NATIVE_TOKEN || !(isNum(row.priceUsd) && row.priceUsd > 0)) continue;
            if (!isTime(row.at) || row.at > at) continue; // tanpa harga dari masa depan
            priceMap.set(makeTokenKey(chain, addr), { priceUsd: row.priceUsd, at: row.at, source: nonEmpty(row.source) ? row.source : p.id });
            got.add(addr);
          }
        }
        remaining = remaining.filter((a) => !got.has(a));
      }
    }
  }

  async function deriveAndStoreAlerts({ activities: acts, analysis: an, prices: priceMap, analysisNow: at }) {
    const recent = acts.filter((a) => touchedIds.has(a.id) && a.blockTime <= at && a.blockTime >= at - tune.alertMaxAgeMs);
    const windowMs = RADAR_WINDOWS['24h'];
    const windowActs = acts.filter((a) => a.blockTime >= at - windowMs && a.blockTime <= at);
    const windowWallets = [...new Set(windowActs.map((a) => makeWalletKey(a.chain, a.wallet)))];
    const radar = buildAccumulationRadar({
      activities: windowActs, walletScores: an.walletScores, clusterOf: an.clusterOf, now: at, windowMs, prices: priceMap,
      holdingsBefore: holdingsFromActivities(acts, at - windowMs, windowWallets),
    });
    const prefs = permissiveAlertPrefs(await repo.listAllAlertPrefs(), tune.alertCooldownMs, tune.alertMaxEventAgeMs);
    // Cooldown sejati: waktu peristiwa alert tersimpan terakhir per alertBaseKey (7 hari = batas cooldown alerts.js).
    const options = { lastAlertAt: await repo.lastAlertTimes({ since: Math.max(0, at - 7 * DAY) }) };
    const base = { activities: recent, radar, walletScores: an.walletScores, positions: positionsForAlerts(recent, acts), now: at };
    const neutral = deriveAlertsDetailed({ ...base, watchlist: { wallets: new Set(), tokens: new Set() } }, prefs, options);
    summary.alertsSkipped = { stale: neutral.skipped.stale, cooldown: neutral.skipped.cooldown };
    const byKey = new Map(neutral.alerts.map((a) => [a.dedupeKey, a]));
    if (watchedWallets.size > 0) {
      const withWatch = deriveAlertsDetailed({ ...base, watchlist: { wallets: watchedWallets, tokens: new Set() } }, prefs, options);
      for (const a of withWatch.alerts) if (!byKey.has(a.dedupeKey)) byKey.set(a.dedupeKey, { ...a, watchOnly: true });
    }
    if (byKey.size === 0) return 0;

    const simulatedTx = new Set();
    const simulatedToken = new Set();
    for (const a of acts) {
      if (a.isSimulated !== true) continue;
      simulatedTx.add(`${a.chain}:${a.txHash}`);
      if (a.blockTime >= at - windowMs) simulatedToken.add(makeTokenKey(a.chain, a.token.address));
    }
    const radarByToken = new Map(radar.map((r) => [r.tokenKey, r]));
    const rows = [...byKey.values()].map((a) => {
      const txHashes = Array.isArray(a.evidence?.txHashes) ? a.evidence.txHashes : [];
      const isSimulated = a.isSimulated === true || txHashes.some((h) => simulatedTx.has(`${a.chain}:${h}`))
        || (a.tokenKey !== null && simulatedToken.has(a.tokenKey));
      const r = radarByToken.get(a.tokenKey);
      return {
        kind: a.kind, severity: a.severity, dedupeKey: a.dedupeKey, chain: a.chain, tokenKey: a.tokenKey, wallet: a.wallet,
        title: a.title, message: a.message, createdAt: a.createdAt, eventAt: isTime(a.eventAt) ? a.eventAt : null,
        evidence: {
          ...a.evidence,
          usd: isNum(a.usd) ? a.usd : null,
          walletScore: isNum(a.walletScore) ? a.walletScore : null,
          symbol: a.symbol ?? null,
          watchOnly: a.watchOnly === true,
          ...(a.kind === 'MULTI_WALLET_BUY' && r ? { independentBuyers: r.independentBuyers, conviction: r.conviction } : {}),
        },
        isSimulated,
      };
    });
    const existing = await repo.existingAlertKeys(rows.map((r) => r.dedupeKey));
    const fresh = rows.filter((r) => !existing.has(r.dedupeKey));
    return fresh.length ? repo.insertAlerts(fresh) : 0;
  }

  /** Status provider, status ringkasan, log, dan penyimpanan run terakhir. */
  async function finish() {
    const finishedAt = Math.floor(clock());
    summary.finishedAt = finishedAt;
    for (const p of adapters) {
      const st = stats.get(p.id);
      let state = 'NEVER';
      if (st.ok > 0 && st.failed > 0) state = 'DEGRADED';
      else if (st.ok > 0) state = 'OK';
      else if (st.failed > 0) state = 'DOWN';
      summary.providers.push({
        id: p.id, calls: st.attempted, ok: st.ok, failed: st.failed, notSupported: st.notSupported,
        lastErrorCode: st.lastError?.code ?? null, state,
      });
      if (st.ok === 0 && st.failed === 0) continue; // tidak dipakai (atau semua NOT_SUPPORTED) → status tidak berubah
      await repo.recordProviderAttempt(p.id, { now: finishedAt, isSimulated: p.isSimulated });
      if (st.ok > 0) {
        await repo.recordProviderSuccess(p.id, {
          now: finishedAt, isSimulated: p.isSimulated, coverage: { chains: [...st.chains].sort(), calls: st.ok },
        });
      }
      if (st.failed > 0) {
        await repo.recordProviderFailure(p.id, {
          now: finishedAt, code: st.lastError.code, message: st.lastError.message, isSimulated: p.isSimulated,
        });
      }
    }
    if (summary.status === 'OK' && errorCount > 0) summary.status = 'DEGRADED';
    if (errorCount > summary.errors.length) note(`${errorCount - summary.errors.length} error lain tidak dicantumkan.`);
    await repo.setSyncState(SYNC_STATE_KEYS.lastRun, summary, { now: finishedAt });
    const fields = {
      status: summary.status, fetched: summary.fetched, inserted: summary.inserted, reclassified: summary.reclassified,
      duplicates: summary.duplicates, rejected: summary.rejected, collisions: summary.collisions, alerts: summary.alerts,
      alertsStale: summary.alertsSkipped.stale, wallets: summary.wallets.synced,
      errors: errorCount, ms: finishedAt - now,
    };
    if (summary.status === 'OK') log.info(fields, 'sinkronisasi smart money selesai');
    else log.warn(fields, 'sinkronisasi smart money selesai dengan catatan');
  }
}
