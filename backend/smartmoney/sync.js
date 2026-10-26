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
// - Duplikat (chain, txHash, logIndex) dibuang normalizeTransfers (dalam batch) dan kunci primer transfer mentah
//   (lintas run) → sinkronisasi idempoten.
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
// Alert diturunkan dari aktivitas BARU/BERUBAH di run ini yang berumur ≤ alertMaxAgeMs (data historis yang baru
// tersinkron tidak membanjiri notifikasi) + radar 24 jam. Ambang = preferensi PALING LONGGAR di antara default dan
// semua preferensi tersimpan; cooldown = SATU nilai tetap server (alertCooldownMs) sehingga dedupeKey tidak
// bergantung preferensi pengguna mana pun. Penyaringan per pengguna (minUsd, minWalletScore, jenis, watchlistOnly,
// cooldown pengguna) dilakukan saat dibaca (GET /api/smart-money/alerts).
// Teks alert NETRAL terhadap watchlist: alert diturunkan dua kali — tanpa watchlist (netral, disimpan apa adanya)
// dan dengan gabungan watchlist semua pengguna. Alert yang HANYA muncul karena wallet dipantau (mis. WALLET_EXIT,
// NEW_BUY tanpa nilai USD, wallet tidak eligible) disimpan dengan `evidence.watchOnly = true` dan hanya ditampilkan
// kepada pengguna yang memantau wallet tersebut. `isSimulated` alert = true bila ada aktivitas sumber (tx bukti atau
// aktivitas token di jendela) yang bersimulasi. Peta `lastAlertAt` (repo.lastAlertTimes) diteruskan sebagai argumen
// ketiga deriveAlerts (ekstensi cooldown; diabaikan versi deriveAlerts yang belum mendukungnya).

import { DEFAULT_ALERT_PREFS, deriveAlerts, validateAlertPrefs } from './alerts.js';
import { analyzeUniverse } from './analyze.js';
import { matchToken } from './binanceMatch.js';
import { classifyWalletTransfers } from './classify.js';
import {
  ALERT_KINDS, CHAINS, NATIVE_TOKEN, RADAR_WINDOWS, ZERO_ADDRESS, isChain, isQuoteAsset, normalizeAddress,
  tokenKey as makeTokenKey, walletKey as makeWalletKey,
} from './contracts.js';
import { rankCandidates } from './discovery.js';
import { normalizeTransfers } from './normalize.js';
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

function resolveTuning(tuning) {
  if (tuning === null || typeof tuning !== 'object' || Array.isArray(tuning)) throw new TypeError('tuning harus objek');
  for (const [key, value] of Object.entries(tuning)) {
    if (!Object.hasOwn(DEFAULT_SYNC_TUNING, key)) throw new TypeError(`Parameter sinkronisasi tidak dikenal: ${key}`);
    if (!(Number.isSafeInteger(value) && value >= 1)) throw new RangeError(`${key} harus bilangan bulat ≥ 1`);
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
 * Cooldown TIDAK diambil dari pengguna (dedupeKey stabil) — selalu `cooldownMs` server.
 * @param {Array<{ prefs: object }>} saved
 * @param {number} cooldownMs
 */
export function permissiveAlertPrefs(saved, cooldownMs = DEFAULT_ALERT_PREFS.cooldownMs) {
  const all = [DEFAULT_ALERT_PREFS];
  for (const row of Array.isArray(saved) ? saved : []) {
    if (row?.prefs && validateAlertPrefs(row.prefs).length === 0) all.push({ ...DEFAULT_ALERT_PREFS, ...row.prefs });
  }
  return {
    kinds: [...ALERT_KINDS],
    minUsd: Math.min(...all.map((p) => p.minUsd)),
    largeSellUsd: Math.min(...all.map((p) => p.largeSellUsd)),
    minWalletScore: 0,
    minIndependentBuyers: Math.min(...all.map((p) => p.minIndependentBuyers)),
    cooldownMs,
    watchlistOnly: false,
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
 *   fetched, duplicates, rejected, reclassified, inserted, alerts, wallets, discovery, mapping, scored, links,
 *   providers, errors, notes }
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
    fetched: 0, duplicates: 0, rejected: 0, reclassified: 0, inserted: 0, alerts: 0,
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
    // Hanya chain yang juga punya provider riwayat transfer: wallet temuan di chain lain tidak dapat dinilai.
    const discoveryChains = CHAINS.filter((c) => discoverers.some((p) => p.chains.includes(c))
      && registry.withCapability('walletTransfers', c).length > 0);
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

  /** normalize → (USD native) → simpan mentah → label → klasifikasi ulang tx tersentuh → ganti aktivitas. */
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
    const { transfers, rejected, duplicates } = normalizeTransfers(sameChain);
    summary.rejected += rejected.length;
    summary.duplicates += duplicates;
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
    const fresh = priced.length ? await repo.insertRawTransfers(priced, wallet, { now }) : [];
    summary.duplicates += priced.length - fresh.length;
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
    const prefs = permissiveAlertPrefs(await repo.listAllAlertPrefs(), tune.alertCooldownMs);
    const extension = { lastAlertAt: await repo.lastAlertTimes({ since: Math.max(0, at - 7 * DAY) }) };
    const base = { activities: recent, radar, walletScores: an.walletScores, positions: positionsForAlerts(recent, acts), now: at };
    const neutral = deriveAlerts({ ...base, watchlist: { wallets: new Set(), tokens: new Set() } }, prefs, extension);
    const byKey = new Map(neutral.map((a) => [a.dedupeKey, a]));
    if (watchedWallets.size > 0) {
      const withWatch = deriveAlerts({ ...base, watchlist: { wallets: watchedWallets, tokens: new Set() } }, prefs, extension);
      for (const a of withWatch) if (!byKey.has(a.dedupeKey)) byKey.set(a.dedupeKey, { ...a, watchOnly: true });
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
        title: a.title, message: a.message, createdAt: a.createdAt,
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
      duplicates: summary.duplicates, rejected: summary.rejected, alerts: summary.alerts, wallets: summary.wallets.synced,
      errors: errorCount, ms: finishedAt - now,
    };
    if (summary.status === 'OK') log.info(fields, 'sinkronisasi smart money selesai');
    else log.warn(fields, 'sinkronisasi smart money selesai dengan catatan');
  }
}
