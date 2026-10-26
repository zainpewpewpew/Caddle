// API Insider / Smart Money Radar (docs/15 §4–§5) di bawah /api/smart-money/*. Semua route wajib sesi (gerbang
// authPlugin); metode yang mengubah state (POST/PUT/DELETE) otomatis wajib token CSRF (requireCsrf).
//
// Prinsip:
// - Baca dari database saja: route TIDAK PERNAH memanggil provider (sinkronisasi berjalan di worker / skrip
//   `npm run smart-money:sync`), sehingga error provider mentah tidak dapat bocor ke respons. Pesan status provider
//   yang tersimpan disaring ulang (tanpa URL, nilai kunci disamarkan, dipotong).
// - Radar dihitung saat diminta: buildAccumulationRadar atas aktivitas tersimpan dalam jendela → matchToken (mapping
//   Binance) → linkToScreener (sinyal LONG aktif).
// - Query string tidak dikoersi (AJV coerceTypes: false): angka/boolean divalidasi sebagai pola string; parameter tak
//   dikenal → 400. Alamat divalidasi per chain (normalizeAddress) → 400 dengan details [{ path, message }].
// - Setiap respons daftar membawa blok `meta` (kesegaran, cakupan, simulasi, penafian).
// - Watchlist, status baca, dan preferensi notifikasi bersifat PER PENGGUNA; perubahan watchlist & preferensi
//   dicatat di audit log.
//
// Ekstensi kontrak docs/15 §5 (aditif; frontend lama tetap kompatibel):
// - meta.attributions: string[] — atribusi wajib provider aktif (terms.attribution). meta.truncated (opsional): true
//   bila aktivitas jendela melebihi batas muat (radar dihitung dari aktivitas TERBARU).
// - GET /status: providers[].attribution/docsUrl/note, providers yang pernah tercatat tetapi tidak lagi dikonfigurasi
//   (configured: false), dan `lastRun` (ringkasan run sinkronisasi terakhir yang sudah disaring).
// - Radar: item.isSimulated; GET /wallets: item.isSimulated; GET /evaluation: isSimulated; GET /watchlist: meta.
// - Alert: usd, walletScore, symbol, watchlisted, walletWatched — DIHITUNG ULANG terhadap watchlist pengguna yang
//   meminta (bukan watchlist gabungan saat sinkronisasi). Alert yang hanya muncul karena wallet dipantau
//   (evidence.watchOnly) hanya tampil bagi pengguna yang memantau wallet tersebut; penanda internal itu dibuang.
// - Cooldown per pengguna (prefs.cooldownMs): kunci dedupe tersimpan memakai cooldown TETAP server (stabil antar
//   pengguna); cooldown pengguna diterapkan saat dibaca — alert pertama dalam jeda dipertahankan, sisanya
//   disembunyikan. Akibatnya cooldown pengguna < cooldown server tidak membuat alert lebih sering dari ember server.

import { DEFAULT_ALERT_PREFS, filterAlerts, validateAlertPrefs } from '../smartmoney/alerts.js';
import { matchToken } from '../smartmoney/binanceMatch.js';
import {
  ALERT_KINDS, CHAINS, DISCLAIMERS, NATIVE_TOKEN, RADAR_STATES, RADAR_WINDOWS, TRADING_STYLES, explorerAddressUrl,
  explorerTokenUrl, isEvmChain, normalizeAddress, tokenKey as makeTokenKey, walletKey as makeWalletKey,
} from '../smartmoney/contracts.js';
import { buildImpliedPriceIndex } from '../smartmoney/prices.js';
import { redactSecrets } from '../smartmoney/providers/errors.js';
import { buildAccumulationRadar } from '../smartmoney/radar.js';
import { linkToScreener } from '../smartmoney/screenerLink.js';
import { DEFAULT_SYNC_TUNING, SYNC_STATE_KEYS, sanitizeProviderMessage } from '../smartmoney/sync.js';

const PREFIX = '/api/smart-money';

// limit 1..500 & skor 0..100 sebagai pola string (sama dengan signalRoutes). Di luar rentang → 400, bukan dipotong.
const LIMIT = { type: 'string', pattern: '^([1-9][0-9]?|[1-4][0-9]{2}|500)$' };
const SCORE = { type: 'string', pattern: '^(100|[1-9]?[0-9])$' };
const BOOL = { type: 'string', enum: ['true', 'false'] };
const CHAIN = { type: 'string', enum: [...CHAINS] };
// Bentuk alamat diperiksa per chain di handler (normalizeAddress); skema hanya membatasi panjang.
const ADDRESS = { type: 'string', minLength: 1, maxLength: 100 };
const WATCH_KIND = { type: 'string', enum: ['WALLET', 'TOKEN'] };

const RADAR_DEFAULT_LIMIT = 100;
const WALLETS_DEFAULT_LIMIT = 200;
const ALERTS_DEFAULT_LIMIT = 100;
/** Batas aktivitas yang dimuat untuk satu perhitungan radar (terbaru dulu; selebihnya → meta.truncated). */
const RADAR_ACTIVITY_LIMIT = 100_000;
const ENTITY_ACTIVITY_LIMIT = 200;
/** Alert terbaru yang dipindai untuk visibilitas per pengguna (batas listAlerts repositori). */
const ALERT_SCAN_LIMIT = 1000;
const WATCHLIST_MAX = 500;
const NOTE_MAX = 200;
const CLUSTER_MEMBERS_MAX = 200;
const CLUSTER_REASONS_MAX = 200;
const DETAIL_MESSAGE_MAX = 200;
const LAST_RUN_LIST_MAX = 20;
const PREF_KEYS = Object.keys(DEFAULT_ALERT_PREFS);

const radarQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    window: { type: 'string', enum: Object.keys(RADAR_WINDOWS) },
    chain: CHAIN,
    minBuyers: { type: 'string', pattern: '^([1-9][0-9]?|100)$' },
    state: { type: 'string', enum: [...RADAR_STATES] },
    // 'true' = hanya token MATCHED (terhubung ke Binance); 'false' = tanpa filter.
    linked: BOOL,
    limit: LIMIT,
  },
};

const walletsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chain: CHAIN,
    eligible: BOOL,
    style: { type: 'string', enum: [...TRADING_STYLES] },
    minScore: SCORE,
    includeFlagged: BOOL,
    limit: LIMIT,
  },
};

const entityParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['chain', 'address'],
  properties: { chain: CHAIN, address: ADDRESS },
};

const watchAddBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'chain', 'address'],
  properties: { kind: WATCH_KIND, chain: CHAIN, address: ADDRESS, note: { type: 'string', maxLength: NOTE_MAX } },
};

const watchRemoveBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'chain', 'address'],
  properties: { kind: WATCH_KIND, chain: CHAIN, address: ADDRESS },
};

const alertsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // 'true' = hanya belum dibaca; 'false' = semua.
    unread: BOOL,
    kind: { type: 'string', enum: [...ALERT_KINDS] },
    limit: LIMIT,
  },
};

// Tepat satu dari { ids: [...] } atau { all: true }.
const alertsReadBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  properties: {
    ids: {
      type: 'array', minItems: 1, maxItems: ALERT_SCAN_LIMIT,
      items: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    },
    all: { type: 'boolean', enum: [true] },
  },
};

// Amplop saja; isi preferensi divalidasi validateAlertPrefs (pesan per field Bahasa Indonesia, kunci tak dikenal ditolak).
const prefsBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prefs'],
  properties: { prefs: { type: 'object', maxProperties: 16 } },
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const toInt = (value, fallback) => (value === undefined ? fallback : Number.parseInt(value, 10));
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Pesan aman untuk respons: nilai kunci di URL/teks disamarkan, URL dibuang, karakter kontrol dibersihkan, dipotong. */
function safeMessage(message) {
  if (message === null || message === undefined) return null;
  const text = sanitizeProviderMessage(redactSecrets(String(message)));
  return text === '' ? null : text;
}

/**
 * Status provider dari baris sm_provider_status (urutan rekam sinkronisasi: attempt → success → failure).
 * NEVER = belum pernah dicoba / belum ada hasil; OK = sukses terakhir tanpa error; DEGRADED = run terakhir sebagian
 * berhasil (sukses & error pada waktu percobaan yang sama); DOWN = error tanpa sukses pada percobaan terakhir.
 * @param {{ lastAttemptAt: number|null, lastSuccessAt: number|null, lastErrorCode: string|null }|null|undefined} row
 * @returns {'OK'|'DEGRADED'|'DOWN'|'NEVER'}
 */
export function providerState(row) {
  if (!row || !isTime(row.lastAttemptAt)) return 'NEVER';
  if (row.lastErrorCode === null || row.lastErrorCode === undefined) return isTime(row.lastSuccessAt) ? 'OK' : 'NEVER';
  return isTime(row.lastSuccessAt) && row.lastSuccessAt === row.lastAttemptAt ? 'DEGRADED' : 'DOWN';
}

/** Kunci dasar dedupe: dedupeKey tanpa segmen ember cooldown terakhir (`kind:tokenKey:wallet|*`). */
function baseKeyOf(dedupeKey) {
  const i = dedupeKey.lastIndexOf(':');
  return i > 0 ? dedupeKey.slice(0, i) : dedupeKey;
}

/**
 * Cooldown per pengguna atas alert tersimpan: diproses kronologis per kunci dasar; alert pertama dipertahankan dan
 * alert berikutnya yang berjarak < `cooldownMs` dari alert terakhir yang dipertahankan disembunyikan. Urutan masukan
 * dipertahankan pada keluaran.
 * @param {Array<{ id: number, dedupeKey: string, createdAt: number }>} alerts
 * @param {number} cooldownMs
 * @returns {object[]}
 */
export function applyUserCooldown(alerts, cooldownMs) {
  if (!Array.isArray(alerts)) throw new TypeError('alerts harus array');
  if (!(isNum(cooldownMs) && cooldownMs >= 0)) throw new RangeError('cooldownMs harus angka ≥ 0');
  const chronological = [...alerts].sort((x, y) => (x.createdAt - y.createdAt) || (x.id - y.id));
  const lastKept = new Map();
  const kept = new Set();
  for (const a of chronological) {
    const base = baseKeyOf(a.dedupeKey);
    const prev = lastKept.get(base);
    if (prev !== undefined && a.createdAt - prev < cooldownMs) continue;
    lastKept.set(base, a.createdAt);
    kept.add(a);
  }
  return alerts.filter((a) => kept.has(a));
}

/** Preferensi efektif: tersimpan & valid digabung default; selain itu default. `kinds` mengikuti urutan ALERT_KINDS. */
function normalizePrefs(prefs) {
  const merged = { ...DEFAULT_ALERT_PREFS, ...(prefs ?? {}) };
  return { ...merged, kinds: ALERT_KINDS.filter((k) => merged.kinds.includes(k)) };
}

/** Pesan validateAlertPrefs → detail 400 { field?, path, message } (field = nama preferensi bila dikenali). */
function prefErrorDetail(message) {
  const text = truncate(String(message), DETAIL_MESSAGE_MAX);
  const unknown = /^Preferensi tidak dikenal: (.*)$/s.exec(text);
  if (unknown) return { path: `/prefs/${truncate(unknown[1], 64)}`, message: text };
  const field = PREF_KEYS.find((k) => text.startsWith(`${k} `)) ?? (text.startsWith('Jenis notifikasi') ? 'kinds' : null);
  return field ? { field, path: `/prefs/${field}`, message: text } : { path: '/prefs', message: text };
}

function invalidAddress(reply, chain, path = '/address') {
  return reply.code(400).send({
    error: 'VALIDATION_ERROR',
    message: 'Input tidak valid',
    details: [{ path, message: `Alamat tidak valid untuk chain ${chain}` }],
  });
}

const publicLabel = (l) => ({ label: l.label, category: l.category, source: l.source });

/** Salinan angka (dan daftar string) dari objek hitungan ringkasan run — tidak ada teks bebas yang diteruskan. */
function plainCounts(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isNum(v)) out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v.slice(0, LAST_RUN_LIST_MAX).map((x) => truncate(x, 64));
  }
  return out;
}

/** Ringkasan run sinkronisasi terakhir (sm_sync_state) dalam bentuk aman untuk API. */
function publicLastRun(entry) {
  const v = entry?.value;
  if (!v || typeof v !== 'object') return null;
  const num = (x) => (isNum(x) ? x : null);
  const str = (x) => (typeof x === 'string' ? truncate(x, 64) : null);
  return {
    status: str(v.status),
    startedAt: num(v.startedAt),
    finishedAt: num(v.finishedAt),
    fetched: num(v.fetched),
    inserted: num(v.inserted),
    reclassified: num(v.reclassified),
    duplicates: num(v.duplicates),
    rejected: num(v.rejected),
    alerts: num(v.alerts),
    scored: num(v.scored),
    wallets: plainCounts(v.wallets),
    discovery: plainCounts(v.discovery),
    mapping: plainCounts(v.mapping),
    notes: (Array.isArray(v.notes) ? v.notes : []).filter((n) => typeof n === 'string').slice(0, LAST_RUN_LIST_MAX).map(safeMessage),
    errors: (Array.isArray(v.errors) ? v.errors : []).slice(0, LAST_RUN_LIST_MAX).map((e) => ({
      provider: str(e?.provider), code: str(e?.code), method: str(e?.method), chain: str(e?.chain), message: safeMessage(e?.message),
    })),
  };
}

/** Pencocok Binance dengan indeks kontrak & simbol (hasil identik dengan matchToken atas seluruh baris). */
function createMatcher(mappingRows) {
  const byContract = new Map();
  const bySymbol = new Map();
  const push = (map, key, row) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };
  for (const r of mappingRows) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.contractAddress === 'string') {
      const a = r.contractAddress.trim();
      push(byContract, `${r.chain}:${isEvmChain(r.chain) ? a.toLowerCase() : a}`, r);
    }
    if (typeof r.binanceAsset === 'string') push(bySymbol, r.binanceAsset.toUpperCase(), r);
  }
  return (token) => {
    const a = typeof token.address === 'string' ? token.address.trim() : '';
    const sym = typeof token.symbol === 'string' ? token.symbol.trim().toUpperCase() : '';
    const rows = new Set([...(byContract.get(`${token.chain}:${isEvmChain(token.chain) ? a.toLowerCase() : a}`) ?? []), ...(bySymbol.get(sym) ?? [])]);
    return matchToken(token, [...rows]);
  };
}

/**
 * Plugin route smart money.
 * @param {import('fastify').FastifyInstance} app
 * @param {{
 *   repo: ReturnType<typeof import('../smartmoney/repository.js').createSmartMoneyRepository>,
 *   signals: { listActive: (filters: object) => Promise<object[]> },
 *   registry: { list: () => object[], missing?: () => string[], unavailable?: () => object[], configuredIds?: () => string[] },
 *   config: { staleAfterMinutes: number },
 *   clock: () => number,
 *   audit: { record: (entry: object) => Promise<void> },
 * }} deps config = config.smartMoney (parseSmartMoneyConfig)
 */
export async function smartMoneyRoutes(app, { repo, signals, registry, config, clock, audit }) {
  const staleMs = (config?.staleAfterMinutes ?? 60) * 60_000;
  const nowMs = () => Math.floor(clock());

  function attributions() {
    return [...new Set(registry.list().map((a) => a.terms?.attribution).filter(nonEmpty))];
  }

  /** Blok meta (docs/15 §5). `simulated` tambahan dari hasil; data simulasi tersimpan mana pun selalu menyalakannya. */
  async function buildMeta({ now, simulated = false, truncated = false }) {
    const [hasSimulated, coverage, statuses] = await Promise.all([
      repo.hasSimulatedData(), repo.coverage(), repo.listProviderStatus(),
    ]);
    let lastSyncAt = null;
    for (const s of statuses) if (isTime(s.lastSuccessAt) && (lastSyncAt === null || s.lastSuccessAt > lastSyncAt)) lastSyncAt = s.lastSuccessAt;
    const meta = {
      simulated: hasSimulated || simulated === true,
      dataAsOf: coverage.lastActivityAt ?? null,
      lastSyncAt,
      isStale: lastSyncAt === null || now - lastSyncAt > staleMs,
      coverage: { chains: coverage.chains, wallets: coverage.wallets, activities: coverage.activities },
      providersConfigured: registry.list().length,
      disclaimers: DISCLAIMERS,
      attributions: attributions(),
    };
    if (truncated) meta.truncated = true;
    return meta;
  }

  /** Watchlist pengguna sebagai himpunan kunci `chain:alamat`. */
  async function watchSets(userId) {
    const items = await repo.listWatchlist(userId);
    const wallets = new Set();
    const tokens = new Set();
    for (const i of items) (i.kind === 'WALLET' ? wallets : tokens).add(makeWalletKey(i.chain, i.address));
    return { items, wallets, tokens };
  }

  /** Label terbaik per alamat (kategori infrastruktur dulu) → Map `chain:alamat` → { label, category, source }. */
  async function bestLabels(entries) {
    const byChain = new Map();
    for (const { chain, address } of entries) {
      if (!byChain.has(chain)) byChain.set(chain, new Set());
      byChain.get(chain).add(address);
    }
    const out = new Map();
    for (const [chain, addresses] of byChain) {
      for (const [key, l] of await repo.getLabels({ chain, addresses: [...addresses] })) out.set(key, publicLabel(l));
    }
    return out;
  }

  /**
   * Radar akumulasi on-request atas aktivitas tersimpan `[now − windowMs, now]` (opsional satu chain / satu token —
   * hasil per token tidak bergantung pada token lain). Harga = harga tersirat swap di jendela (hanya untuk risiko
   * "harga tidak tersedia").
   */
  async function computeRadar({ now, windowMs, chain = null, tokenAddress = null }) {
    const since = Math.max(0, now - windowMs);
    const acts = await repo.listActivities({
      chain, tokenAddress, since, until: now, limit: RADAR_ACTIVITY_LIMIT, order: 'desc',
    });
    const simulatedTokens = new Set();
    for (const a of acts) if (a.isSimulated) simulatedTokens.add(makeTokenKey(a.chain, a.token.address));
    if (acts.length === 0) return { radar: [], simulatedTokens, truncated: false };
    const walletScores = new Map();
    const clusterOf = new Map();
    for (const s of await repo.listScoreSummaries({ chain })) {
      const key = makeWalletKey(s.chain, s.address);
      walletScores.set(key, { score: s.score, eligible: s.eligible, flags: Array.isArray(s.flags) ? s.flags : [] });
      if (s.clusterId) clusterOf.set(key, s.clusterId);
    }
    const wallets = [...new Set(acts.map((a) => makeWalletKey(a.chain, a.wallet)))];
    const holdingsBefore = await repo.holdingsBefore({ before: since, wallets });
    const prices = buildImpliedPriceIndex(acts, { maxStalenessMs: DEFAULT_SYNC_TUNING.impliedPriceStalenessMs }).pricesAt(now);
    const radar = buildAccumulationRadar({ activities: acts, walletScores, clusterOf, now, windowMs, prices, holdingsBefore });
    return { radar, simulatedTokens, truncated: acts.length >= RADAR_ACTIVITY_LIMIT };
  }

  /** Tautkan token radar ke Binance (mapping tersimpan) dan — bila diminta & ada yang MATCHED — ke sinyal LONG aktif. */
  async function linkRadar(radar, { withSignals }) {
    if (radar.length === 0) return [];
    const match = createMatcher(await repo.listBinanceMap());
    const matches = new Map(radar.map((r) => [r.tokenKey, match({ chain: r.chain, address: r.token?.address, symbol: r.token?.symbol ?? null })]));
    const anyMatched = [...matches.values()].some((m) => m.status === 'MATCHED');
    const activeSignals = withSignals && anyMatched ? await signals.listActive({ direction: 'LONG', limit: 500 }) : [];
    return linkToScreener(radar, { matches, activeSignals });
  }

  /** Item radar untuk respons: label pembeli, penanda simulasi, status ikuti. */
  async function decorateRadar(items, { simulatedTokens, watch }) {
    const labels = await bestLabels(items.flatMap((r) => (r.buyers ?? []).map((b) => ({ chain: r.chain, address: b.wallet }))));
    return items.map((r) => ({
      ...r,
      buyers: (r.buyers ?? []).map((b) => ({ ...b, label: labels.get(makeWalletKey(r.chain, b.wallet)) ?? null })),
      isSimulated: simulatedTokens.has(r.tokenKey),
      watching: watch.tokens.has(r.tokenKey),
    }));
  }

  /**
   * Alert yang terlihat oleh pengguna (terbaru dulu): watchlist & preferensi pengguna, filterAlerts, cooldown pengguna.
   * @returns {Promise<object[]>} alert lengkap dengan field ekstensi (read per pengguna)
   */
  async function visibleAlerts(userId) {
    const [rows, watch, saved] = await Promise.all([
      repo.listAlerts({ userId, limit: ALERT_SCAN_LIMIT }), watchSets(userId), repo.getAlertPrefs(userId),
    ]);
    const prefs = saved !== null && validateAlertPrefs(saved).length === 0 ? normalizePrefs(saved) : normalizePrefs(null);
    const candidates = [];
    for (const a of rows) {
      const ev = a.evidence && typeof a.evidence === 'object' && !Array.isArray(a.evidence) ? a.evidence : {};
      const walletWatched = a.wallet !== null && watch.wallets.has(makeWalletKey(a.chain, a.wallet));
      if (ev.watchOnly === true && !walletWatched) continue;
      const usd = isNum(ev.usd) ? ev.usd : null;
      // Ambang per pengguna yang tidak dibaca filterAlerts (alert disimpan dengan ambang paling longgar).
      if (a.kind === 'LARGE_SELL' && !(usd !== null && usd >= prefs.largeSellUsd)) continue;
      if (a.kind === 'MULTI_WALLET_BUY' && isNum(ev.independentBuyers) && ev.independentBuyers < prefs.minIndependentBuyers) continue;
      const evidence = { ...ev };
      delete evidence.watchOnly; // penanda internal sinkronisasi, bukan untuk klien
      candidates.push({
        ...a,
        evidence,
        // Teks tersimpan netral; tingkat kepentingan beli baru naik bila wallet dipantau PENGGUNA INI.
        severity: a.kind === 'NEW_BUY' && walletWatched ? 'HIGH' : a.severity,
        usd,
        walletScore: isNum(ev.walletScore) ? ev.walletScore : null,
        symbol: typeof ev.symbol === 'string' ? ev.symbol : null,
        watchlisted: walletWatched || (a.tokenKey !== null && watch.tokens.has(a.tokenKey)),
        walletWatched,
      });
    }
    return applyUserCooldown(filterAlerts(candidates, { prefs }), prefs.cooldownMs);
  }

  const publicAlert = (a) => ({
    id: a.id, kind: a.kind, severity: a.severity, dedupeKey: a.dedupeKey, chain: a.chain, tokenKey: a.tokenKey,
    wallet: a.wallet, title: a.title, message: a.message, evidence: a.evidence, createdAt: a.createdAt,
    isSimulated: a.isSimulated, read: a.read, usd: a.usd, walletScore: a.walletScore, symbol: a.symbol,
    watchlisted: a.watchlisted, walletWatched: a.walletWatched,
  });

  // ------------------------------------------------------------------ status

  app.get(`${PREFIX}/status`, async () => {
    const now = nowMs();
    const rows = new Map((await repo.listProviderStatus()).map((r) => [r.provider, r]));
    const active = registry.list();
    const activeById = new Map(active.map((a) => [a.id, a]));
    const unavailable = typeof registry.unavailable === 'function'
      ? registry.unavailable()
      : (registry.missing?.() ?? []).map((id) => ({
        id, displayName: id, requiresKey: null, isSimulated: false, reason: 'Adapter untuk provider ini tidak tersedia',
      }));
    const unavailableById = new Map(unavailable.map((u) => [u.id, u]));
    const ids = typeof registry.configuredIds === 'function'
      ? registry.configuredIds()
      : [...activeById.keys(), ...unavailableById.keys()];
    const history = (id) => {
      const row = rows.get(id);
      return {
        lastAttemptAt: row?.lastAttemptAt ?? null,
        lastSuccessAt: row?.lastSuccessAt ?? null,
        lastErrorCode: row?.lastErrorCode ?? null,
        lastErrorMessage: safeMessage(row?.lastErrorMessage),
        state: providerState(row),
      };
    };
    const providers = [];
    const listed = new Set();
    const pushActive = (a) => {
      providers.push({
        id: a.id, displayName: a.displayName, requiresKey: a.requiresKey, configured: true, isSimulated: a.isSimulated,
        chains: [...a.chains], capabilities: [...a.capabilities].sort(), ...history(a.id),
        attribution: a.terms?.attribution ?? null, docsUrl: a.terms?.docsUrl ?? null,
      });
      listed.add(a.id);
    };
    for (const id of ids) {
      if (listed.has(id)) continue;
      if (activeById.has(id)) {
        pushActive(activeById.get(id));
        continue;
      }
      const u = unavailableById.get(id) ?? { id, displayName: id, requiresKey: null, isSimulated: false, reason: null };
      const h = history(id);
      providers.push({
        id, displayName: u.displayName, requiresKey: u.requiresKey, configured: false, isSimulated: u.isSimulated,
        chains: [], capabilities: [], ...h,
        lastErrorCode: 'NOT_CONFIGURED',
        lastErrorMessage: safeMessage(u.reason) ?? 'Provider belum dikonfigurasi',
        state: 'DOWN',
        attribution: null, docsUrl: null,
      });
      listed.add(id);
    }
    for (const a of active) if (!listed.has(a.id)) pushActive(a);
    // Provider yang pernah tercatat tetapi tidak lagi dikonfigurasi: data lamanya mungkin masih tersimpan.
    for (const [id, row] of [...rows].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
      if (listed.has(id)) continue;
      providers.push({
        id, displayName: id, requiresKey: null, configured: false, isSimulated: row.isSimulated, chains: [], capabilities: [],
        ...history(id), attribution: null, docsUrl: null, note: 'Tidak lagi dikonfigurasi — data lama dari provider ini mungkin masih tersimpan',
      });
    }
    const lastRun = publicLastRun(await repo.getSyncState(SYNC_STATE_KEYS.lastRun));
    const meta = await buildMeta({ now, simulated: active.some((a) => a.isSimulated) });
    return { meta, providers, lastRun };
  });

  // ------------------------------------------------------------------ radar

  app.get(`${PREFIX}/radar`, { schema: { querystring: radarQuerySchema } }, async (request) => {
    const q = request.query;
    const now = nowMs();
    const windowKey = q.window ?? '24h';
    const { radar, simulatedTokens, truncated } = await computeRadar({ now, windowMs: RADAR_WINDOWS[windowKey], chain: q.chain ?? null });
    let items = await linkRadar(radar, { withSignals: true });
    if (q.minBuyers !== undefined) {
      const minBuyers = toInt(q.minBuyers);
      items = items.filter((r) => r.independentBuyers >= minBuyers);
    }
    if (q.state !== undefined) items = items.filter((r) => r.state === q.state);
    if (q.linked === 'true') items = items.filter((r) => r.binance?.status === 'MATCHED');
    items = items.slice(0, toInt(q.limit, RADAR_DEFAULT_LIMIT));
    const watch = await watchSets(request.auth.user.id);
    const out = await decorateRadar(items, { simulatedTokens, watch });
    const meta = await buildMeta({ now, simulated: out.some((i) => i.isSimulated), truncated });
    return { meta, window: windowKey, computedAt: now, items: out };
  });

  // ------------------------------------------------------------------ wallets

  app.get(`${PREFIX}/wallets`, { schema: { querystring: walletsQuerySchema } }, async (request) => {
    const q = request.query;
    const now = nowMs();
    const rows = await repo.listWalletScores({
      chain: q.chain ?? null,
      eligible: q.eligible === undefined ? null : q.eligible === 'true',
      style: q.style ?? null,
      minScore: q.minScore === undefined ? 0 : toInt(q.minScore),
      includeFlagged: q.includeFlagged === 'true',
      limit: toInt(q.limit, WALLETS_DEFAULT_LIMIT),
    });
    const [sizes, watch] = await Promise.all([repo.clusterSizes(), watchSets(request.auth.user.id)]);
    const labels = new Map();
    const byChain = new Map();
    for (const s of rows) {
      if (!byChain.has(s.chain)) byChain.set(s.chain, []);
      byChain.get(s.chain).push(s.address);
    }
    for (const [chain, addresses] of byChain) {
      for (const [address, list] of await repo.listLabelsForMany(chain, addresses)) labels.set(makeWalletKey(chain, address), list);
    }
    const items = [];
    for (const s of rows) {
      const key = makeWalletKey(s.chain, s.address);
      const w = await repo.getWallet(s.chain, s.address);
      items.push({
        chain: s.chain,
        address: s.address,
        score: s.score,
        eligible: s.eligible,
        style: s.style,
        clusterId: s.clusterId,
        clusterSize: s.clusterId ? sizes.get(s.clusterId) ?? 1 : 1,
        flags: Array.isArray(s.flags) ? s.flags : [],
        metrics: s.metrics ?? {},
        topReason: (s.eligible ? s.reasons?.[0] : s.limitations?.[0] ?? s.reasons?.[0]) ?? null,
        labels: (labels.get(key) ?? []).map(publicLabel),
        lastActivityAt: w?.lastActivityAt ?? null,
        watching: watch.wallets.has(key),
        isSimulated: w?.isSimulated === true,
      });
    }
    const meta = await buildMeta({ now, simulated: items.some((i) => i.isSimulated) });
    return { meta, items };
  });

  app.get(`${PREFIX}/wallets/:chain/:address`, { schema: { params: entityParamsSchema } }, async (request, reply) => {
    const { chain } = request.params;
    const address = normalizeAddress(chain, request.params.address);
    if (address === null || address === NATIVE_TOKEN) return invalidAddress(reply, chain);
    const wallet = await repo.getWallet(chain, address);
    if (!wallet) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Wallet tidak dilacak' });
    const now = nowMs();
    const [labels, scoreRow, activities, watch] = await Promise.all([
      repo.listLabelsFor(chain, address),
      repo.getWalletScore(chain, address),
      repo.listActivities({ chain, wallet: address, limit: ENTITY_ACTIVITY_LIMIT, order: 'desc' }),
      watchSets(request.auth.user.id),
    ]);
    let cluster = null;
    if (scoreRow?.clusterId) {
      const members = (await repo.getClusterMembers(chain, scoreRow.clusterId)).slice(0, CLUSTER_MEMBERS_MAX);
      const seen = new Set();
      const reasons = [];
      for (const m of members.length ? members : [address]) {
        for (const l of await repo.listWalletLinks(chain, m)) {
          const k = `${l.a}|${l.b}|${l.type}`;
          if (seen.has(k)) continue;
          seen.add(k);
          reasons.push({ type: l.type, a: l.a, b: l.b, evidence: l.evidence ?? {} });
        }
      }
      cluster = { id: scoreRow.clusterId, members, reasons: reasons.slice(0, CLUSTER_REASONS_MAX) };
    }
    const score = scoreRow ? {
      score: scoreRow.score, eligible: scoreRow.eligible, style: scoreRow.style, components: scoreRow.components ?? {},
      metrics: scoreRow.metrics ?? {}, reasons: scoreRow.reasons ?? [], limitations: scoreRow.limitations ?? [],
      computedAt: scoreRow.computedAt,
    } : null;
    const meta = await buildMeta({ now, simulated: wallet.isSimulated || activities.some((a) => a.isSimulated) });
    return {
      meta,
      wallet: {
        chain, address, explorerUrl: explorerAddressUrl(chain, address), firstSeenAt: wallet.firstSeenAt,
        lastActivityAt: wallet.lastActivityAt, discoveredVia: wallet.discoveredVia, discoveryReason: wallet.discoveryReason,
        isSimulated: wallet.isSimulated,
      },
      labels: labels.map((l) => ({ ...publicLabel(l), confidence: l.confidence, fetchedAt: l.fetchedAt })),
      score,
      flags: Array.isArray(scoreRow?.flags) ? scoreRow.flags : [],
      cluster,
      pnl: { summary: scoreRow?.pnl?.summary ?? null, positions: scoreRow?.pnl?.positions ?? [] },
      activities,
      watching: watch.wallets.has(makeWalletKey(chain, address)),
    };
  });

  // ------------------------------------------------------------------ token

  app.get(`${PREFIX}/tokens/:chain/:address`, { schema: { params: entityParamsSchema } }, async (request, reply) => {
    const { chain } = request.params;
    const address = normalizeAddress(chain, request.params.address);
    if (address === null) return invalidAddress(reply, chain);
    const [tokenRow, activities] = await Promise.all([
      repo.getToken(chain, address),
      repo.listActivities({ chain, tokenAddress: address, limit: ENTITY_ACTIVITY_LIMIT, order: 'desc' }),
    ]);
    if (!tokenRow && activities.length === 0) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Token belum tercatat' });
    const now = nowMs();
    const tKey = makeTokenKey(chain, address);
    const { radar, simulatedTokens, truncated } = await computeRadar({ now, windowMs: RADAR_WINDOWS['24h'], chain, tokenAddress: address });
    const radarItem = radar.find((r) => r.tokenKey === tKey) ?? null;
    const latest = activities[0]?.token ?? null;
    const token = {
      chain,
      address,
      symbol: tokenRow?.symbol ?? latest?.symbol ?? null,
      name: tokenRow?.name ?? latest?.name ?? null,
      decimals: tokenRow?.decimals ?? latest?.decimals ?? null,
      explorerUrl: explorerTokenUrl(chain, address),
      isSimulated: activities.some((a) => a.isSimulated) || simulatedTokens.has(tKey),
    };
    // Tanpa aktivitas radar 24 jam: token semu berkeyakinan 0 hanya untuk menurunkan status Binance & sinyal screener.
    const [linked] = await linkRadar([radarItem ?? {
      tokenKey: tKey, chain, token: { address, symbol: token.symbol, name: token.name, decimals: token.decimals }, conviction: 0,
    }], { withSignals: true });
    const watch = await watchSets(request.auth.user.id);
    const radarOut = radarItem ? (await decorateRadar([linked], { simulatedTokens, watch }))[0] : null;
    const meta = await buildMeta({ now, simulated: token.isSimulated, truncated });
    return {
      meta,
      token,
      binance: linked.binance,
      radar: radarOut,
      activities,
      screener: linked.screener,
      watching: watch.tokens.has(tKey),
    };
  });

  // ------------------------------------------------------------------ watchlist

  app.get(`${PREFIX}/watchlist`, async (request) => {
    const now = nowMs();
    const { items } = await watchSets(request.auth.user.id);
    const tokenItems = items.filter((i) => i.kind === 'TOKEN');
    const radarByToken = new Map();
    if (tokenItems.length) {
      const { radar } = await computeRadar({ now, windowMs: RADAR_WINDOWS['24h'] });
      for (const r of radar) radarByToken.set(r.tokenKey, r);
    }
    const walletLabels = await bestLabels(items.filter((i) => i.kind === 'WALLET'));
    const out = [];
    for (const i of items) {
      const key = makeWalletKey(i.chain, i.address);
      let summary;
      if (i.kind === 'WALLET') {
        const s = await repo.getWalletScore(i.chain, i.address);
        const tracked = await repo.getWallet(i.chain, i.address);
        summary = {
          label: walletLabels.get(key)?.label ?? null,
          score: s ? s.score : null,
          eligible: s ? s.eligible : null,
          tracked: tracked !== null,
          ...(tracked === null ? { text: 'menunggu sinkronisasi berikutnya' } : {}),
        };
      } else {
        const t = await repo.getToken(i.chain, i.address);
        const r = radarByToken.get(key);
        summary = { symbol: t?.symbol ?? r?.token?.symbol ?? null, conviction: r ? r.conviction : null, state: r ? r.state : null };
      }
      out.push({ kind: i.kind, chain: i.chain, address: i.address, note: i.note, createdAt: i.createdAt, summary });
    }
    return { meta: await buildMeta({ now }), items: out };
  });

  app.post(`${PREFIX}/watchlist`, { schema: { body: watchAddBodySchema } }, async (request, reply) => {
    const { kind, chain, note } = request.body;
    const address = normalizeAddress(chain, request.body.address);
    if (address === null || (kind === 'WALLET' && address === NATIVE_TOKEN)) return invalidAddress(reply, chain);
    const userId = request.auth.user.id;
    const now = nowMs();
    const current = await repo.listWatchlist(userId);
    const exists = current.some((i) => i.kind === kind && i.chain === chain && i.address === address);
    if (!exists && current.length >= WATCHLIST_MAX) {
      return reply.code(409).send({ error: 'WATCHLIST_LIMIT', message: `Watchlist penuh (maksimal ${WATCHLIST_MAX} item). Hapus item lain lebih dulu.` });
    }
    const item = await repo.addToWatchlist(userId, { kind, chain, address, note: note ?? null }, { now });
    if (item === null) return invalidAddress(reply, chain);
    await audit.record({
      occurredAt: now, userId, action: 'smartmoney.watchlist.add', outcome: 'success', ip: request.ip,
      detail: { kind, chain, address },
    });
    return reply.code(201).send(item);
  });

  app.delete(`${PREFIX}/watchlist`, { schema: { body: watchRemoveBodySchema } }, async (request, reply) => {
    const { kind, chain } = request.body;
    const address = normalizeAddress(chain, request.body.address);
    if (address === null || (kind === 'WALLET' && address === NATIVE_TOKEN)) return invalidAddress(reply, chain);
    const userId = request.auth.user.id;
    const removed = await repo.removeFromWatchlist(userId, { kind, chain, address });
    if (!removed) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Item watchlist tidak ditemukan' });
    await audit.record({
      occurredAt: nowMs(), userId, action: 'smartmoney.watchlist.remove', outcome: 'success', ip: request.ip,
      detail: { kind, chain, address },
    });
    return reply.code(204).send();
  });

  // ------------------------------------------------------------------ alerts

  app.get(`${PREFIX}/alerts`, { schema: { querystring: alertsQuerySchema } }, async (request) => {
    const q = request.query;
    const now = nowMs();
    const visible = await visibleAlerts(request.auth.user.id);
    const unread = visible.filter((a) => !a.read).length;
    let items = visible;
    if (q.kind !== undefined) items = items.filter((a) => a.kind === q.kind);
    if (q.unread === 'true') items = items.filter((a) => !a.read);
    items = items.slice(0, toInt(q.limit, ALERTS_DEFAULT_LIMIT)).map(publicAlert);
    const meta = await buildMeta({ now, simulated: items.some((a) => a.isSimulated) });
    return { meta, items, unread };
  });

  app.post(`${PREFIX}/alerts/read`, { schema: { body: alertsReadBodySchema } }, async (request) => {
    const userId = request.auth.user.id;
    const now = nowMs();
    if (request.body.all === true) {
      // Hanya alert yang TERLIHAT oleh pengguna ini (markAlertsRead 'all' akan menandai alert milik siapa pun).
      const ids = (await visibleAlerts(userId)).filter((a) => !a.read).map((a) => a.id);
      return { updated: ids.length ? await repo.markAlertsRead(userId, ids, { now }) : 0 };
    }
    return { updated: await repo.markAlertsRead(userId, [...new Set(request.body.ids)], { now }) };
  });

  // ------------------------------------------------------------------ preferensi notifikasi

  app.get(`${PREFIX}/alert-prefs`, async (request) => {
    const saved = await repo.getAlertPrefs(request.auth.user.id);
    const valid = saved !== null && validateAlertPrefs(saved).length === 0;
    return { prefs: normalizePrefs(valid ? saved : null), isDefault: !valid };
  });

  app.put(`${PREFIX}/alert-prefs`, { schema: { body: prefsBodySchema } }, async (request, reply) => {
    const errors = validateAlertPrefs(request.body.prefs);
    if (errors.length) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Input tidak valid', details: errors.slice(0, 10).map(prefErrorDetail) });
    }
    const userId = request.auth.user.id;
    const now = nowMs();
    const prefs = normalizePrefs(request.body.prefs);
    await repo.saveAlertPrefs(userId, prefs, { now });
    await audit.record({
      occurredAt: now, userId, action: 'smartmoney.alertPrefs.update', outcome: 'success', ip: request.ip, detail: { prefs },
    });
    return { prefs, isDefault: false };
  });

  // ------------------------------------------------------------------ LONG Scanner & evaluasi

  // Selalu 200: tanpa provider / tanpa data → { meta, items: {} } (chip tidak tampil, bukan error).
  app.get(`${PREFIX}/screener-links`, async () => {
    const now = nowMs();
    const { radar, simulatedTokens, truncated } = await computeRadar({ now, windowMs: RADAR_WINDOWS['24h'] });
    const items = {};
    for (const r of await linkRadar(radar, { withSignals: false })) {
      const sym = r.binance?.status === 'MATCHED' ? r.binance.futuresSymbol : null;
      if (typeof sym !== 'string' || sym === '') continue;
      const prev = Object.hasOwn(items, sym) ? items[sym] : null;
      if (prev && prev.conviction >= r.conviction) continue;
      items[sym] = {
        tokenKey: r.tokenKey, symbol: r.token?.symbol ?? null, chain: r.chain, address: r.token?.address ?? null,
        independentBuyers: r.independentBuyers, conviction: r.conviction, state: r.state, lastActivityAt: r.lastActivityAt,
        isSimulated: simulatedTokens.has(r.tokenKey),
      };
    }
    const meta = await buildMeta({ now, simulated: Object.values(items).some((i) => i.isSimulated), truncated });
    return { meta, items };
  });

  app.get(`${PREFIX}/evaluation`, async () => {
    const now = nowMs();
    const ev = await repo.latestEvaluation();
    if (!ev) return { meta: await buildMeta({ now }), available: false };
    return {
      meta: await buildMeta({ now, simulated: ev.isSimulated }),
      available: true,
      computedAt: ev.computedAt,
      params: ev.params,
      report: ev.report,
      isSimulated: ev.isSimulated,
    };
  });
}
