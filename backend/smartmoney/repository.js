// Repositori Insider / Smart Money Radar: seluruh tabel `sm_*` (migrasi 007). Satu-satunya tempat SQL smart money
// ditulis; semua query statis dengan parameter terikat (daftar nilai dikirim sebagai JSON lalu dibuka json_each).
// Method async agar kontraknya tetap sama saat migrasi ke PostgreSQL. Baris dikembalikan sebagai objek biasa
// camelCase; kolom *_json sudah di-parse. Waktu berasal dari `now` (opsional per panggilan) atau `clock`.
//
// Validasi alamat memakai contracts.js normalizeAddress: EVM huruf kecil, Solana apa adanya. Bentuk data yang
// salah dari kode internal (aktivitas, skor, mapping) melempar RangeError/TypeError; masukan pengguna
// (watchlist) mengembalikan null/false agar route dapat menjawab 400 tanpa try/catch.

import { alertBaseKey } from './alerts.js';
import {
  ACTIVITY_TYPES, ALERT_KINDS, ALERT_SEVERITIES, CLASSIFICATION_CONFIDENCE, EXCLUDING_FLAGS, LABEL_CATEGORIES,
  NATIVE_TOKEN, PROVIDER_ERROR_CODES, TRADING_STYLES, explorerTxUrl, isChain, normalizeAddress, normalizeTxHash, walletKey,
} from './contracts.js';

const WATCH_KINDS = Object.freeze(['WALLET', 'TOKEN']);
const ACTIVITY_LIMIT_MAX = 100_000;
const LIST_LIMIT_MAX = 1000;
const NOTE_MAX = 200;
const ERROR_MESSAGE_MAX = 500;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SYMBOL_RE = /^[A-Z0-9]{1,30}$/;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const toBool = (v) => v === 1;
const flag = (v) => (v ? 1 : 0);
const json = (v) => JSON.stringify(v);
const parse = (v) => (v === null || v === undefined ? null : JSON.parse(v));

function assertChain(chain) {
  if (!isChain(chain)) throw new RangeError(`Chain tidak dikenal: ${String(chain)}`);
}
/** Alamat kanonik atau RangeError. */
function address(chain, value, name = 'alamat') {
  assertChain(chain);
  const a = normalizeAddress(chain, value);
  if (a === null) throw new RangeError(`${name} tidak valid untuk chain ${chain}`);
  return a;
}
function assertTime(v, name) {
  if (!Number.isInteger(v) || v < 0) throw new TypeError(`${name} harus epoch milidetik (bilangan bulat ≥ 0)`);
}
/** Bilangan bulat aman ≥ 0 atau null/undefined (→ null); selain itu RangeError. */
function optionalIndex(v, name) {
  if (v === null || v === undefined) return null;
  if (!(Number.isSafeInteger(v) && v >= 0)) throw new RangeError(`${name} harus bilangan bulat ≥ 0 atau null`);
  return v;
}
function optionalTime(v, name) {
  if (v !== null && v !== undefined) assertTime(v, name);
  return v ?? null;
}
function assertLimit(limit, max) {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new RangeError(`limit harus bilangan bulat 1..${max}`);
}
function assertProvider(provider) {
  if (typeof provider !== 'string' || !PROVIDER_ID_RE.test(provider)) throw new RangeError('id provider tidak valid');
}
function nonEmpty(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function optionalText(v, max = 500) {
  if (v === null || v === undefined) return null;
  return String(v).slice(0, max);
}

/** Kunci kombinasi chain + alamat untuk Map hasil (sama dengan tokenKey/walletKey kontrak). */
const keyOf = (chain, addr) => walletKey(chain, addr);

/**
 * Kategori infrastruktur / pengecuali. Bila satu alamat punya beberapa label, label berkategori ini SELALU menang atas
 * label lain berapa pun keyakinannya — alamat berlabel cex@0,8 + fund@0,9 harus tetap terbaca exchange agar
 * pengecualian (flag CEX, discovery, klasifikasi deposit/penarikan) tidak tersembunyi.
 */
export const INFRA_LABEL_CATEGORIES = Object.freeze([
  'cex', 'cex_deposit', 'bridge', 'dex_router', 'dex_pool', 'market_maker', 'mev_bot', 'contract', 'lp_token',
  'airdrop_distributor',
]);
const INFRA = new Set(INFRA_LABEL_CATEGORIES);

/**
 * Label terbaik per alamat: kategori infrastruktur/pengecuali dulu, lalu keyakinan tertinggi, lalu paling baru, lalu
 * sumber & label (deterministik). Daftar lengkap tetap tersedia lewat listLabelsFor / listLabelsForMany.
 */
function betterLabel(a, b) {
  const ia = INFRA.has(a.category);
  if (ia !== INFRA.has(b.category)) return ia ? a : b;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  if (a.fetchedAt !== b.fetchedAt) return a.fetchedAt > b.fetchedAt ? a : b;
  return `${a.source}\u0000${a.label}` <= `${b.source}\u0000${b.label}` ? a : b;
}

function labelOf(row) {
  return {
    chain: row.chain, address: row.address, label: row.label, category: row.category, source: row.source,
    confidence: row.confidence, fetchedAt: row.fetched_at,
  };
}

function activityOf(row) {
  return {
    id: row.id,
    chain: row.chain,
    txHash: row.tx_hash,
    blockTime: row.block_time,
    blockNumber: row.block_number,
    logIndex: row.log_index,
    wallet: row.wallet,
    token: { address: row.token_address, symbol: row.token_symbol, name: row.token_name, decimals: row.token_decimals },
    type: row.type,
    direction: row.direction,
    amount: row.amount,
    usdValue: row.usd_value,
    counterparty: row.counterparty,
    counterpartyLabel: parse(row.counterparty_label_json),
    confidence: row.confidence,
    reason: row.reason,
    provider: row.provider,
    isSimulated: toBool(row.is_simulated),
    explorerUrl: explorerTxUrl(row.chain, row.tx_hash),
  };
}

function scoreOf(row) {
  return {
    chain: row.chain,
    address: row.address,
    computedAt: row.computed_at,
    score: row.score,
    eligible: toBool(row.eligible),
    style: row.style,
    clusterId: row.cluster_id,
    components: parse(row.components_json),
    metrics: parse(row.metrics_json),
    reasons: parse(row.reasons_json),
    limitations: parse(row.limitations_json),
    flags: parse(row.flags_json),
    pnl: parse(row.pnl_json),
  };
}

function mappingOf(row) {
  return {
    chain: row.chain, contractAddress: row.contract_address, binanceAsset: row.binance_asset,
    spotSymbol: row.spot_symbol, futuresSymbol: row.futures_symbol, multiplier: row.multiplier,
    source: row.source, verifiedAt: row.verified_at,
  };
}

function alertOf(row) {
  return {
    id: row.id, dedupeKey: row.dedupe_key, kind: row.kind, severity: row.severity, chain: row.chain,
    tokenKey: row.token_key, wallet: row.wallet, title: row.title, message: row.message,
    evidence: parse(row.evidence_json), createdAt: row.created_at, eventAt: row.event_at ?? null,
    isSimulated: toBool(row.is_simulated), read: toBool(row.is_read),
  };
}

function providerStatusOf(row) {
  return {
    provider: row.provider, lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code, lastErrorMessage: row.last_error_message,
    coverage: parse(row.coverage_json), isSimulated: toBool(row.is_simulated),
  };
}

/** Activity (kontrak §1) → parameter baris sm_activities; RangeError/TypeError bila tidak valid. */
function activityParams(a, now) {
  if (a === null || typeof a !== 'object') throw new TypeError('aktivitas harus objek');
  if (typeof a.id !== 'string' || a.id.length === 0 || a.id.length > 400) throw new RangeError('activity.id tidak valid');
  const chain = a.chain;
  const txHash = normalizeTxHash(chain, a.txHash);
  if (txHash === null) throw new RangeError('activity.txHash tidak valid');
  assertTime(a.blockTime, 'activity.blockTime');
  const blockNumber = optionalIndex(a.blockNumber, 'activity.blockNumber');
  const logIndex = optionalIndex(a.logIndex, 'activity.logIndex');
  const wallet = address(chain, a.wallet, 'activity.wallet');
  const tokenAddress = address(chain, a.token?.address, 'activity.token.address');
  if (!ACTIVITY_TYPES.includes(a.type)) throw new RangeError(`Jenis aktivitas tidak dikenal: ${String(a.type)}`);
  if (a.direction !== 'IN' && a.direction !== 'OUT') throw new RangeError('activity.direction harus IN atau OUT');
  if (!(isFiniteNumber(a.amount) && a.amount > 0)) throw new RangeError('activity.amount harus > 0');
  if (a.usdValue !== null && a.usdValue !== undefined && !(isFiniteNumber(a.usdValue) && a.usdValue >= 0)) {
    throw new RangeError('activity.usdValue harus ≥ 0 atau null');
  }
  if (!CLASSIFICATION_CONFIDENCE.includes(a.confidence)) throw new RangeError('activity.confidence tidak valid');
  if (!nonEmpty(a.reason)) throw new RangeError('activity.reason wajib diisi');
  if (!nonEmpty(a.provider)) throw new RangeError('activity.provider wajib diisi');
  const counterparty = a.counterparty === null || a.counterparty === undefined
    ? null
    : address(chain, a.counterparty, 'activity.counterparty');
  const decimals = a.token.decimals;
  return {
    id: a.id,
    chain,
    txHash,
    blockTime: a.blockTime,
    blockNumber,
    logIndex,
    wallet,
    tokenAddress,
    tokenSymbol: optionalText(a.token.symbol, 64),
    tokenName: optionalText(a.token.name, 200),
    tokenDecimals: Number.isInteger(decimals) ? decimals : null,
    type: a.type,
    direction: a.direction,
    amount: a.amount,
    usdValue: a.usdValue ?? null,
    counterparty,
    counterpartyLabelJson: a.counterpartyLabel ? json(a.counterpartyLabel) : null,
    confidence: a.confidence,
    reason: a.reason,
    provider: a.provider,
    isSimulated: flag(a.isSimulated),
    now,
  };
}

/** Alasan baris mapping Binance ditolak (Bahasa Indonesia), atau null bila valid. */
function mappingProblem(r) {
  if (r === null || typeof r !== 'object') return 'baris mapping harus objek';
  if (!nonEmpty(r.source)) return 'Mapping Binance tanpa sumber ditolak';
  if (!isChain(r.chain)) return `Chain tidak dikenal: ${String(r.chain).slice(0, 40)}`;
  const contract = normalizeAddress(r.chain, r.contractAddress);
  if (contract === null || contract === NATIVE_TOKEN) return `contractAddress tidak valid untuk chain ${r.chain}`;
  if (!nonEmpty(r.binanceAsset) || r.binanceAsset.trim().length > 32) return 'binanceAsset wajib diisi (1..32 karakter)';
  for (const [name, v] of [['spotSymbol', r.spotSymbol], ['futuresSymbol', r.futuresSymbol]]) {
    if (v !== null && v !== undefined && !(typeof v === 'string' && SYMBOL_RE.test(v))) {
      return `${name} tidak valid (hanya huruf besar A-Z dan angka)`;
    }
  }
  const multiplier = r.multiplier ?? 1;
  if (!Number.isSafeInteger(multiplier) || multiplier < 1) return 'multiplier harus bilangan bulat ≥ 1';
  if (r.verifiedAt !== null && r.verifiedAt !== undefined && !(Number.isInteger(r.verifiedAt) && r.verifiedAt >= 0)) {
    return 'verifiedAt harus epoch milidetik atau null';
  }
  return null;
}

/** Isi baris aktivitas yang menentukan "berubah" saat klasifikasi ulang (baris DB vs parameter baru). */
const activitySignature = (row) => json([row.type, row.direction, row.amount, row.usd_value, row.block_time,
  row.token_symbol, row.counterparty, row.confidence, row.reason, row.block_number, row.log_index]);
const paramsSignature = (p) => json([p.type, p.direction, p.amount, p.usdValue, p.blockTime, p.tokenSymbol,
  p.counterparty, p.confidence, p.reason, p.blockNumber, p.logIndex]);

/** Daftar hash tx kanonik unik; RangeError bila ada yang tidak valid. */
function normalizeTxs(chain, txHashes) {
  if (!Array.isArray(txHashes)) throw new TypeError('txHashes harus array');
  const out = new Set();
  for (const h of txHashes) {
    const n = normalizeTxHash(chain, h);
    if (n === null) throw new RangeError(`Hash transaksi tidak valid untuk chain ${chain}`);
    out.add(n);
  }
  return [...out];
}

/** RawTransfer ternormalisasi (normalize.js) → parameter baris sm_raw_transfers; RangeError/TypeError bila tidak valid. */
function rawParams(t, wallet, now) {
  if (t === null || typeof t !== 'object') throw new TypeError('transfer harus objek');
  assertChain(t.chain);
  const txHash = normalizeTxHash(t.chain, t.txHash);
  if (txHash === null) throw new RangeError('transfer.txHash tidak valid');
  if (!Number.isSafeInteger(t.logIndex) || t.logIndex < 0) throw new RangeError('transfer.logIndex harus bilangan bulat ≥ 0');
  assertTime(t.blockTime, 'transfer.blockTime');
  if (!nonEmpty(t.provider)) throw new RangeError('transfer.provider wajib diisi');
  if (!t.token || typeof t.token !== 'object' || normalizeAddress(t.chain, t.token.address) === null) {
    throw new RangeError('transfer.token.address tidak valid');
  }
  if (!(isFiniteNumber(t.amount) && t.amount > 0)) throw new RangeError('transfer.amount harus > 0');
  const transfer = { ...t, txHash };
  return {
    chain: t.chain, wallet: address(t.chain, wallet, 'wallet'), txHash, logIndex: t.logIndex, blockTime: t.blockTime,
    payload: json(transfer), provider: String(t.provider).trim().slice(0, 64), isSimulated: flag(t.isSimulated), now,
    transfer,
  };
}

const RAW_META_FIELDS = Object.freeze(['initiator', 'toContract', 'method', 'providerCategory', 'dex']);
const isNil = (v) => v === null || v === undefined;

/**
 * Lengkapi field yang belum diketahui pada transfer tersimpan dari kiriman ulang (identitas sama → fakta on-chain
 * sama): usdValue (+ priceSource), blockNumber, decimals/nama/simbol '?' token, field txMeta. Nilai yang sudah ada
 * tidak pernah ditimpa (sama dengan dedupe normalize.js).
 * @returns {{ merged: object, changed: boolean }}
 */
function mergeKnown(stored, incoming) {
  const merged = structuredClone(stored);
  let changed = false;
  const fill = (target, key, value) => {
    if (isNil(target[key]) && !isNil(value)) {
      target[key] = value;
      changed = true;
    }
  };
  if (isNil(merged.usdValue) && isFiniteNumber(incoming.usdValue) && incoming.usdValue >= 0) {
    merged.usdValue = incoming.usdValue;
    merged.priceSource = incoming.priceSource ?? null;
    changed = true;
  }
  fill(merged, 'blockNumber', incoming.blockNumber);
  if (merged.token && incoming.token && typeof incoming.token === 'object') {
    fill(merged.token, 'decimals', incoming.token.decimals);
    fill(merged.token, 'name', incoming.token.name);
    const sym = incoming.token.symbol;
    if (merged.token.symbol === '?' && typeof sym === 'string' && sym !== '' && sym !== '?') {
      merged.token.symbol = sym;
      changed = true;
    }
  }
  if (incoming.txMeta && typeof incoming.txMeta === 'object') {
    const meta = merged.txMeta && typeof merged.txMeta === 'object' ? merged.txMeta : {};
    for (const f of RAW_META_FIELDS) fill(meta, f, incoming.txMeta[f]);
    merged.txMeta = meta;
  }
  return { merged, changed };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ clock?: () => number }} [deps] jam bila `now` tidak diberikan per panggilan (default Date.now)
 */
/** Kunci sm_sync_state untuk lease putaran sinkronisasi (lihat acquireSyncLease). */
export const SYNC_LEASE_KEY = 'runLease';
const LEASE_TRIGGERS = Object.freeze(['manual', 'schedule']);

function assertLeaseOwner(owner) {
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 64) throw new RangeError('owner lease tidak valid');
}

export function createSmartMoneyRepository(db, { clock = () => Date.now() } = {}) {
  // WHERE statis dari kode ini sendiri (bukan masukan pengguna); semua nilai tetap parameter terikat.
  const activityQueries = (where) => ({
    asc: db.prepare(`SELECT * FROM sm_activities WHERE ${where} ORDER BY block_time, id LIMIT @limit`),
    desc: db.prepare(`SELECT * FROM sm_activities WHERE ${where} ORDER BY block_time DESC, id DESC LIMIT @limit`),
  });
  const stmt = {
    // --- wallet, label, token ---
    upsertWallet: db.prepare(`INSERT INTO sm_wallets
        (chain, address, first_seen_at, last_activity_at, discovered_via, discovery_reason, is_simulated, updated_at)
      VALUES (@chain, @address, @firstSeenAt, @lastActivityAt, @discoveredVia, @discoveryReason, @isSimulated, @now)
      ON CONFLICT (chain, address) DO UPDATE SET
        first_seen_at = MIN(sm_wallets.first_seen_at, excluded.first_seen_at),
        last_activity_at = CASE WHEN excluded.last_activity_at IS NULL THEN sm_wallets.last_activity_at
                                WHEN sm_wallets.last_activity_at IS NULL THEN excluded.last_activity_at
                                ELSE MAX(sm_wallets.last_activity_at, excluded.last_activity_at) END,
        discovery_reason = COALESCE(sm_wallets.discovery_reason, excluded.discovery_reason),
        is_simulated = MAX(sm_wallets.is_simulated, excluded.is_simulated),
        updated_at = excluded.updated_at`),
    getWallet: db.prepare('SELECT * FROM sm_wallets WHERE chain = ? AND address = ?'),
    listWallets: db.prepare(`SELECT * FROM sm_wallets WHERE (@chain IS NULL OR chain = @chain)
      ORDER BY chain, address LIMIT @limit`),
    upsertLabel: db.prepare(`INSERT INTO sm_labels (chain, address, source, label, category, confidence, fetched_at)
      VALUES (@chain, @address, @source, @label, @category, @confidence, @fetchedAt)
      ON CONFLICT (chain, address, source, label) DO UPDATE SET
        category = excluded.category, confidence = excluded.confidence, fetched_at = excluded.fetched_at`),
    // Empat varian (bukan pola `@x IS NULL OR …`) agar indeks PK (chain, address, …) terpakai.
    labelsAll: db.prepare('SELECT * FROM sm_labels ORDER BY chain, address, source, label'),
    labelsByChain: db.prepare('SELECT * FROM sm_labels WHERE chain = @chain ORDER BY chain, address, source, label'),
    labelsByAddresses: db.prepare(`SELECT * FROM sm_labels WHERE address IN (SELECT value FROM json_each(@addresses))
      ORDER BY chain, address, source, label`),
    labelsByChainAddresses: db.prepare(`SELECT * FROM sm_labels
      WHERE chain = @chain AND address IN (SELECT value FROM json_each(@addresses))
      ORDER BY chain, address, source, label`),
    upsertToken: db.prepare(`INSERT INTO sm_tokens (chain, address, symbol, name, decimals, updated_at)
      VALUES (@chain, @address, @symbol, @name, @decimals, @now)
      ON CONFLICT (chain, address) DO UPDATE SET
        symbol = COALESCE(excluded.symbol, sm_tokens.symbol), name = COALESCE(excluded.name, sm_tokens.name),
        decimals = COALESCE(excluded.decimals, sm_tokens.decimals), updated_at = excluded.updated_at`),
    getToken: db.prepare('SELECT * FROM sm_tokens WHERE chain = ? AND address = ?'),

    // --- aktivitas ---
    insertActivity: db.prepare(`INSERT OR IGNORE INTO sm_activities
        (id, chain, tx_hash, block_time, block_number, log_index, wallet, token_address, token_symbol, token_name,
         token_decimals, type, direction, amount, usd_value, counterparty, counterparty_label_json, confidence, reason,
         provider, is_simulated, ingested_at)
      VALUES (@id, @chain, @txHash, @blockTime, @blockNumber, @logIndex, @wallet, @tokenAddress, @tokenSymbol, @tokenName,
         @tokenDecimals, @type, @direction, @amount, @usdValue, @counterparty, @counterpartyLabelJson, @confidence,
         @reason, @provider, @isSimulated, @now)`),
    // Data terlambat: nilai USD yang dulu tidak diketahui diisi bila batch berikutnya membawanya. Nilai yang sudah
    // ada tidak pernah ditimpa (hasil pertama tetap, agar riwayat tidak berubah diam-diam).
    fillUsd: db.prepare(`UPDATE sm_activities SET usd_value = @usdValue
      WHERE id = @id AND usd_value IS NULL AND @usdValue IS NOT NULL`),
    // Tiga varian agar indeks yang tepat terpakai: per wallet, per token, atau per waktu — masing-masing dalam dua
    // urutan (asc: tertua dulu; desc: TERBARU dulu, agar LIMIT memotong yang tertua, bukan yang terbaru).
    activitiesByWallet: activityQueries(`chain = @chain AND wallet = @wallet AND block_time BETWEEN @since AND @until
        AND (@token IS NULL OR token_address = @token)
        AND (@types IS NULL OR type IN (SELECT value FROM json_each(@types)))`),
    activitiesByToken: activityQueries(`chain = @chain AND token_address = @token AND block_time BETWEEN @since AND @until
        AND (@types IS NULL OR type IN (SELECT value FROM json_each(@types)))`),
    activitiesByTime: activityQueries(`block_time BETWEEN @since AND @until
        AND (@chain IS NULL OR chain = @chain)
        AND (@types IS NULL OR type IN (SELECT value FROM json_each(@types)))`),
    // Seluruh aktivitas tanpa batas (analisis universe di sinkronisasi; bukan untuk API).
    allActivities: db.prepare('SELECT * FROM sm_activities ORDER BY block_time, id'),
    activitiesForTxs: db.prepare(`SELECT * FROM sm_activities WHERE chain = @chain AND wallet = @wallet
        AND tx_hash IN (SELECT value FROM json_each(@txs))`),
    deleteActivitiesForTxs: db.prepare(`DELETE FROM sm_activities WHERE chain = @chain AND wallet = @wallet
        AND tx_hash IN (SELECT value FROM json_each(@txs))`),
    // Saldo bersih (IN − OUT) per wallet × token sebelum `before` — saldo awal jendela radar (holdingsBefore).
    // @wallets = JSON [[chain, alamat], …]; join per wallet memakai indeks (chain, wallet, block_time).
    holdingsBefore: db.prepare(`SELECT a.chain, a.wallet, a.token_address,
        SUM(CASE a.direction WHEN 'IN' THEN a.amount ELSE -a.amount END) AS qty, SUM(a.amount) AS gross
      FROM json_each(@wallets) w
      JOIN sm_activities a ON a.chain = json_extract(w.value, '$[0]') AND a.wallet = json_extract(w.value, '$[1]')
        AND a.block_time < @before
      GROUP BY a.chain, a.wallet, a.token_address`),

    // --- transfer mentah (klasifikasi ulang data terlambat) ---
    getRaw: db.prepare(`SELECT payload_json FROM sm_raw_transfers
      WHERE chain = @chain AND wallet = @wallet AND tx_hash = @txHash AND log_index = @logIndex`),
    insertRaw: db.prepare(`INSERT INTO sm_raw_transfers
        (chain, wallet, tx_hash, log_index, block_time, payload_json, provider, is_simulated, ingested_at)
      VALUES (@chain, @wallet, @txHash, @logIndex, @blockTime, @payload, @provider, @isSimulated, @now)`),
    updateRaw: db.prepare(`UPDATE sm_raw_transfers SET payload_json = @payload
      WHERE chain = @chain AND wallet = @wallet AND tx_hash = @txHash AND log_index = @logIndex`),
    rawForTxs: db.prepare(`SELECT payload_json FROM sm_raw_transfers
      WHERE chain = @chain AND wallet = @wallet AND tx_hash IN (SELECT value FROM json_each(@txs))
      ORDER BY block_time, tx_hash, log_index`),

    // --- skor & klaster ---
    upsertScore: db.prepare(`INSERT INTO sm_wallet_scores
        (chain, address, computed_at, score, eligible, style, cluster_id, components_json, metrics_json, reasons_json,
         limitations_json, flags_json, pnl_json)
      VALUES (@chain, @address, @computedAt, @score, @eligible, @style, @clusterId, @components, @metrics, @reasons,
         @limitations, @flags, @pnl)
      ON CONFLICT (chain, address) DO UPDATE SET
        computed_at = excluded.computed_at, score = excluded.score, eligible = excluded.eligible, style = excluded.style,
        cluster_id = excluded.cluster_id, components_json = excluded.components_json, metrics_json = excluded.metrics_json,
        reasons_json = excluded.reasons_json, limitations_json = excluded.limitations_json, flags_json = excluded.flags_json,
        pnl_json = excluded.pnl_json`),
    // includeFlagged = 0 → buang wallet dengan flag pengecualian (EXCLUDING_FLAGS) ber-severity HIGH.
    listScores: db.prepare(`SELECT * FROM sm_wallet_scores s
      WHERE (@chain IS NULL OR s.chain = @chain)
        AND (@eligible IS NULL OR s.eligible = @eligible)
        AND (@style IS NULL OR s.style = @style)
        AND s.score >= @minScore
        AND (@includeFlagged = 1 OR NOT EXISTS (
          SELECT 1 FROM json_each(s.flags_json) f
          WHERE json_extract(f.value, '$.severity') = 'HIGH'
            AND json_extract(f.value, '$.code') IN (SELECT value FROM json_each(@excluding))))
      ORDER BY s.score DESC, s.chain, s.address LIMIT @limit`),
    getScore: db.prepare('SELECT * FROM sm_wallet_scores WHERE chain = ? AND address = ?'),
    // Ringkas (tanpa batas) untuk radar on-request: skor, kelayakan, flag, klaster setiap wallet.
    scoreSummaries: db.prepare(`SELECT chain, address, score, eligible, style, cluster_id, flags_json
      FROM sm_wallet_scores WHERE (@chain IS NULL OR chain = @chain) ORDER BY chain, address`),
    clusterSizes: db.prepare(`SELECT chain, cluster_id, COUNT(*) AS size FROM sm_wallet_scores
      WHERE cluster_id IS NOT NULL GROUP BY chain, cluster_id`),
    clusterMembers: db.prepare('SELECT address FROM sm_wallet_scores WHERE chain = ? AND cluster_id = ? ORDER BY address'),
    deleteLinks: db.prepare('DELETE FROM sm_wallet_links WHERE chain = ?'),
    insertLink: db.prepare(`INSERT OR REPLACE INTO sm_wallet_links (chain, a, b, reason_type, evidence_json, created_at)
      VALUES (@chain, @a, @b, @reasonType, @evidence, @now)`),
    linksOf: db.prepare(`SELECT * FROM sm_wallet_links WHERE chain = @chain AND (a = @address OR b = @address)
      ORDER BY a, b, reason_type`),

    // --- Binance ---
    // Satu kontrak boleh beberapa baris (→ AMBIGUOUS di binanceMatch.js); entri identik ditulis ulang.
    upsertMapping: db.prepare(`INSERT INTO sm_binance_map
        (chain, contract_address, binance_asset, spot_symbol, futures_symbol, multiplier, source, provider, verified_at)
      VALUES (@chain, @contractAddress, @binanceAsset, @spotSymbol, @futuresSymbol, @multiplier, @source, @provider, @verifiedAt)
      ON CONFLICT (chain, contract_address, binance_asset, IFNULL(futures_symbol, ''), multiplier) DO UPDATE SET
        spot_symbol = excluded.spot_symbol, source = excluded.source, provider = excluded.provider,
        verified_at = excluded.verified_at`),
    deleteMappingOf: db.prepare('DELETE FROM sm_binance_map WHERE provider = ?'),
    listMapping: db.prepare(`SELECT * FROM sm_binance_map
      ORDER BY chain, contract_address, binance_asset, IFNULL(futures_symbol, ''), multiplier, id`),

    // --- watchlist ---
    addWatch: db.prepare(`INSERT INTO sm_watchlist (user_id, kind, chain, address, note, created_at)
      VALUES (@userId, @kind, @chain, @address, @note, @now)
      ON CONFLICT (user_id, kind, chain, address) DO UPDATE SET note = excluded.note
      RETURNING kind, chain, address, note, created_at`),
    removeWatch: db.prepare('DELETE FROM sm_watchlist WHERE user_id = @userId AND kind = @kind AND chain = @chain AND address = @address'),
    listWatch: db.prepare(`SELECT kind, chain, address, note, created_at FROM sm_watchlist WHERE user_id = ?
      ORDER BY kind, chain, address`),
    listAllWatch: db.prepare('SELECT user_id, kind, chain, address FROM sm_watchlist ORDER BY user_id, kind, chain, address'),

    // --- alert ---
    insertAlert: db.prepare(`INSERT OR IGNORE INTO sm_alerts
        (dedupe_key, kind, severity, chain, token_key, wallet, title, message, evidence_json, created_at, event_at,
         is_simulated)
      VALUES (@dedupeKey, @kind, @severity, @chain, @tokenKey, @wallet, @title, @message, @evidence, @createdAt, @eventAt,
         @isSimulated)`),
    existingKeys: db.prepare('SELECT dedupe_key FROM sm_alerts WHERE dedupe_key IN (SELECT value FROM json_each(?))'),
    // Waktu peristiwa (event_at; created_at bila tidak diketahui) alert yang DIBUAT sejak @since.
    alertTimesSince: db.prepare(`SELECT dedupe_key, kind, token_key, wallet, COALESCE(event_at, created_at) AS at
      FROM sm_alerts WHERE created_at >= ?`),
    listAlerts: db.prepare(`SELECT a.*, (r.alert_id IS NOT NULL) AS is_read FROM sm_alerts a
      LEFT JOIN sm_alert_reads r ON r.alert_id = a.id AND r.user_id = @userId
      WHERE (@kind IS NULL OR a.kind = @kind) AND (@unreadOnly = 0 OR r.alert_id IS NULL)
      ORDER BY a.created_at DESC, a.id DESC LIMIT @limit`),
    markRead: db.prepare(`INSERT OR IGNORE INTO sm_alert_reads (user_id, alert_id, read_at)
      SELECT @userId, id, @now FROM sm_alerts WHERE id IN (SELECT value FROM json_each(@ids))`),
    markAllRead: db.prepare(`INSERT OR IGNORE INTO sm_alert_reads (user_id, alert_id, read_at)
      SELECT @userId, id, @now FROM sm_alerts`),
    getPrefs: db.prepare('SELECT prefs_json, updated_at FROM sm_alert_prefs WHERE user_id = ?'),
    listAllPrefs: db.prepare('SELECT user_id, prefs_json FROM sm_alert_prefs ORDER BY user_id'),
    savePrefs: db.prepare(`INSERT INTO sm_alert_prefs (user_id, prefs_json, updated_at) VALUES (@userId, @prefs, @now)
      ON CONFLICT (user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`),

    // --- status provider & kursor ---
    providerAttempt: db.prepare(`INSERT INTO sm_provider_status (provider, last_attempt_at, is_simulated)
      VALUES (@provider, @now, @isSimulated)
      ON CONFLICT (provider) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, is_simulated = excluded.is_simulated`),
    providerSuccess: db.prepare(`INSERT INTO sm_provider_status
        (provider, last_attempt_at, last_success_at, last_error_code, last_error_message, coverage_json, is_simulated)
      VALUES (@provider, @now, @now, NULL, NULL, @coverage, @isSimulated)
      ON CONFLICT (provider) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
        last_success_at = excluded.last_success_at, last_error_code = NULL, last_error_message = NULL,
        coverage_json = COALESCE(excluded.coverage_json, sm_provider_status.coverage_json),
        is_simulated = excluded.is_simulated`),
    providerFailure: db.prepare(`INSERT INTO sm_provider_status
        (provider, last_attempt_at, last_error_code, last_error_message, is_simulated)
      VALUES (@provider, @now, @code, @message, @isSimulated)
      ON CONFLICT (provider) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
        last_error_code = excluded.last_error_code, last_error_message = excluded.last_error_message,
        is_simulated = excluded.is_simulated`),
    listProviders: db.prepare('SELECT * FROM sm_provider_status ORDER BY provider'),
    getCursor: db.prepare('SELECT cursor FROM sm_sync_cursors WHERE provider = ? AND chain = ? AND address = ?'),
    setCursor: db.prepare(`INSERT INTO sm_sync_cursors (provider, chain, address, cursor, updated_at)
      VALUES (@provider, @chain, @address, @cursor, @now)
      ON CONFLICT (provider, chain, address) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`),
    walletSyncTimes: db.prepare(`SELECT chain, address, MAX(updated_at) AS synced_at FROM sm_sync_cursors
      WHERE address <> '' GROUP BY chain, address`),
    getSyncState: db.prepare('SELECT value_json, updated_at FROM sm_sync_state WHERE key = ?'),
    setSyncState: db.prepare(`INSERT INTO sm_sync_state (key, value_json, updated_at) VALUES (@key, @value, @now)
      ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`),
    deleteSyncState: db.prepare('DELETE FROM sm_sync_state WHERE key = ?'),

    // --- evaluasi & ringkasan ---
    insertEvaluation: db.prepare(`INSERT INTO sm_evaluations (computed_at, params_json, report_json, is_simulated)
      VALUES (@computedAt, @params, @report, @isSimulated)`),
    latestEvaluation: db.prepare('SELECT * FROM sm_evaluations ORDER BY computed_at DESC, id DESC LIMIT 1'),
    hasSimulated: db.prepare(`SELECT
        EXISTS (SELECT 1 FROM sm_activities WHERE is_simulated = 1)
        OR EXISTS (SELECT 1 FROM sm_wallets WHERE is_simulated = 1)
        OR EXISTS (SELECT 1 FROM sm_alerts WHERE is_simulated = 1)
        OR EXISTS (SELECT 1 FROM sm_evaluations WHERE is_simulated = 1)
        OR EXISTS (SELECT 1 FROM sm_provider_status WHERE is_simulated = 1) AS simulated`),
    coverageCounts: db.prepare(`SELECT (SELECT COUNT(*) FROM sm_wallets) AS wallets,
        (SELECT COUNT(*) FROM sm_activities) AS activities,
        (SELECT MAX(block_time) FROM sm_activities) AS last_activity_at`),
    coverageChains: db.prepare(`SELECT chain FROM sm_wallets UNION SELECT DISTINCT chain FROM sm_activities ORDER BY chain`),
  };

  /** Pemegang lease saat ini (null bila tidak ada / rusak). Kedaluwarsa tetap dikembalikan; pemanggil yang menilai. */
  const readLease = () => {
    const row = stmt.getSyncState.get(SYNC_LEASE_KEY);
    if (!row) return null;
    try {
      const v = JSON.parse(row.value_json);
      return v && typeof v.owner === 'string' && Number.isSafeInteger(v.expiresAt) ? v : null;
    } catch {
      return null;
    }
  };
  const writeLease = (lease, now) => stmt.setSyncState.run({ key: SYNC_LEASE_KEY, value: json(lease), now });

  const tx = {
    acquireLease: db.transaction((owner, trigger, ttlMs, now) => {
      const current = readLease();
      if (current && current.expiresAt > now) return { acquired: false, lease: current };
      const lease = {
        owner, trigger, acquiredAt: now, expiresAt: now + ttlMs, progress: { phase: 'start', done: null, total: null, updatedAt: now },
      };
      writeLease(lease, now);
      return { acquired: true, lease };
    }),
    renewLease: db.transaction((owner, ttlMs, progress, now) => {
      const current = readLease();
      if (!current || current.owner !== owner) return false;
      writeLease({ ...current, expiresAt: now + ttlMs, progress: progress ? { ...progress, updatedAt: now } : current.progress }, now);
      return true;
    }),
    releaseLease: db.transaction((owner) => {
      const current = readLease();
      if (!current || current.owner !== owner) return false;
      stmt.deleteSyncState.run(SYNC_LEASE_KEY);
      return true;
    }),
    upsertWallets: db.transaction((rows) => { for (const r of rows) stmt.upsertWallet.run(r); }),
    upsertLabels: db.transaction((rows) => { for (const r of rows) stmt.upsertLabel.run(r); }),
    upsertTokens: db.transaction((rows) => { for (const r of rows) stmt.upsertToken.run(r); }),
    insertActivities: db.transaction((rows) => {
      let inserted = 0;
      let duplicates = 0;
      let usdFilled = 0;
      for (const r of rows) {
        if (stmt.insertActivity.run(r).changes === 1) {
          inserted += 1;
        } else {
          duplicates += 1;
          usdFilled += stmt.fillUsd.run({ id: r.id, usdValue: r.usdValue }).changes;
        }
      }
      return { inserted, duplicates, usdFilled };
    }),
    saveScores: db.transaction((rows) => { for (const r of rows) stmt.upsertScore.run(r); }),
    replaceLinks: db.transaction((chain, rows) => {
      stmt.deleteLinks.run(chain);
      for (const r of rows) stmt.insertLink.run(r);
    }),
    replaceMapping: db.transaction((owners, rows) => {
      for (const owner of owners) stmt.deleteMappingOf.run(owner);
      for (const r of rows) stmt.upsertMapping.run(r);
    }),
    insertRaw: db.transaction((rows) => {
      const fresh = [];
      for (const r of rows) {
        const stored = stmt.getRaw.get(r);
        if (!stored) {
          stmt.insertRaw.run(r);
          fresh.push(r.transfer);
          continue;
        }
        const { merged, changed } = mergeKnown(JSON.parse(stored.payload_json), r.transfer);
        if (changed) {
          stmt.updateRaw.run({ ...r, payload: json(merged) });
          fresh.push(merged);
        }
      }
      return fresh;
    }),
    replaceActivities: db.transaction((key, rows, now) => {
      const before = new Map(stmt.activitiesForTxs.all(key).map((row) => [row.id, row]));
      const deleted = stmt.deleteActivitiesForTxs.run(key).changes;
      let inserted = 0;
      const newIds = [];
      const changedIds = [];
      for (const r of rows) {
        const prev = before.get(r.id);
        if (stmt.insertActivity.run({ ...r, now: prev ? prev.ingested_at : now }).changes !== 1) continue;
        inserted += 1;
        if (!prev) newIds.push(r.id);
        else if (activitySignature(prev) !== paramsSignature(r)) changedIds.push(r.id);
      }
      const after = new Set(rows.map((r) => r.id));
      const removedIds = [...before.keys()].filter((id) => !after.has(id)).sort();
      return { deleted, inserted, newIds, changedIds, removedIds };
    }),
    insertAlerts: db.transaction((rows) => {
      let inserted = 0;
      for (const r of rows) inserted += stmt.insertAlert.run(r).changes;
      return inserted;
    }),
  };

  /** Validasi item watchlist dari masukan pengguna → baris kanonik atau null. */
  /** Baris sm_labels untuk filter chain/alamat opsional (alamat sudah kanonik). */
  function labelRows(chain, addresses) {
    if (addresses !== null && addresses.length === 0) return [];
    if (chain === null) return addresses === null ? stmt.labelsAll.all() : stmt.labelsByAddresses.all({ addresses: json(addresses) });
    return addresses === null ? stmt.labelsByChain.all({ chain })
      : stmt.labelsByChainAddresses.all({ chain, addresses: json(addresses) });
  }

  function watchItem(userId, item) {
    if (!Number.isInteger(userId) || userId < 1) return null;
    if (item === null || typeof item !== 'object') return null;
    const { kind, chain } = item;
    if (!WATCH_KINDS.includes(kind) || !isChain(chain)) return null;
    const addr = normalizeAddress(chain, item.address);
    if (addr === null || (kind === 'WALLET' && addr === 'native')) return null;
    return { userId, kind, chain, address: addr };
  }

  return {
    /**
     * Upsert wallet yang dilacak. `discoveredVia` (sumber penemuan) pertama dipertahankan; waktu awal = paling awal.
     * @param {Array<{ chain, address, firstSeenAt, lastActivityAt?, discoveredVia, discoveryReason?, isSimulated? }>} rows
     * @returns {Promise<number>} jumlah baris diproses
     */
    async upsertWallets(rows, { now = clock() } = {}) {
      const params = rows.map((r) => {
        assertTime(r.firstSeenAt, 'wallet.firstSeenAt');
        if (!nonEmpty(r.discoveredVia)) throw new RangeError('wallet.discoveredVia wajib diisi');
        return {
          chain: r.chain, address: address(r.chain, r.address, 'wallet.address'), firstSeenAt: r.firstSeenAt,
          lastActivityAt: optionalTime(r.lastActivityAt, 'wallet.lastActivityAt'),
          discoveredVia: String(r.discoveredVia).slice(0, 64), discoveryReason: optionalText(r.discoveryReason),
          isSimulated: flag(r.isSimulated), now,
        };
      });
      tx.upsertWallets(params);
      return params.length;
    },

    /** @returns {Promise<object|null>} */
    async getWallet(chain, addr) {
      const a = isChain(chain) ? normalizeAddress(chain, addr) : null;
      const row = a === null ? undefined : stmt.getWallet.get(chain, a);
      return row ? {
        chain: row.chain, address: row.address, firstSeenAt: row.first_seen_at, lastActivityAt: row.last_activity_at,
        discoveredVia: row.discovered_via, discoveryReason: row.discovery_reason, isSimulated: toBool(row.is_simulated),
        updatedAt: row.updated_at,
      } : null;
    },

    /** Daftar wallet dilacak (urut chain, alamat). */
    async listWallets({ chain = null, limit = LIST_LIMIT_MAX } = {}) {
      if (chain !== null) assertChain(chain);
      assertLimit(limit, ACTIVITY_LIMIT_MAX);
      return stmt.listWallets.all({ chain, limit }).map((row) => ({
        chain: row.chain, address: row.address, firstSeenAt: row.first_seen_at, lastActivityAt: row.last_activity_at,
        discoveredVia: row.discovered_via, discoveryReason: row.discovery_reason, isSimulated: toBool(row.is_simulated),
        updatedAt: row.updated_at,
      }));
    },

    /**
     * Simpan label alamat. Label tanpa `source` (atau kategori/keyakinan tidak valid) DITOLAK dan tidak disimpan;
     * label valid lainnya tetap disimpan.
     * @returns {Promise<{ upserted: number, rejected: Array<{ input, reason: string }> }>}
     */
    async upsertLabels(labels) {
      const rows = [];
      const rejected = [];
      for (const l of labels) {
        const reason = !l || typeof l !== 'object' ? 'label harus objek'
          : !nonEmpty(l.source) ? 'label tanpa sumber ditolak'
            : !isChain(l.chain) ? 'chain tidak dikenal'
              : normalizeAddress(l.chain, l.address) === null ? 'alamat tidak valid'
                : !nonEmpty(l.label) ? 'teks label kosong'
                  : !LABEL_CATEGORIES.includes(l.category) ? 'kategori label tidak dikenal'
                    : !(isFiniteNumber(l.confidence) && l.confidence >= 0 && l.confidence <= 1) ? 'keyakinan harus 0..1'
                      : !(Number.isInteger(l.fetchedAt) && l.fetchedAt >= 0) ? 'fetchedAt tidak valid'
                        : null;
        if (reason) {
          rejected.push({ input: l, reason });
          continue;
        }
        rows.push({
          chain: l.chain, address: normalizeAddress(l.chain, l.address), source: l.source.trim(),
          label: String(l.label).slice(0, 200), category: l.category, confidence: l.confidence, fetchedAt: l.fetchedAt,
        });
      }
      tx.upsertLabels(rows);
      return { upserted: rows.length, rejected };
    },

    /**
     * Label terbaik per alamat — bentuk `labels` yang dipakai classify.js. Urutan pilihan: kategori infrastruktur/
     * pengecuali (INFRA_LABEL_CATEGORIES) dulu berapa pun keyakinannya, lalu keyakinan tertinggi, lalu terbaru.
     * Tanpa `addresses` → semua label chain tersebut; tanpa `chain` → semua chain.
     * @returns {Promise<Map<string, object>>} kunci `chain:address`
     */
    async getLabels({ chain = null, addresses = null } = {}) {
      if (chain !== null) assertChain(chain);
      const normalized = addresses === null ? null
        : [...new Set(addresses.map((a) => (chain === null ? a : normalizeAddress(chain, a))).filter((a) => typeof a === 'string'))];
      const out = new Map();
      for (const row of labelRows(chain, normalized)) {
        const label = labelOf(row);
        const key = keyOf(row.chain, row.address);
        const prev = out.get(key);
        out.set(key, prev ? betterLabel(prev, label) : label);
      }
      return out;
    },

    /** Semua label (setiap sumber) untuk satu alamat — untuk profil wallet "label + sumber". */
    async listLabelsFor(chain, addr) {
      const a = isChain(chain) ? normalizeAddress(chain, addr) : null;
      if (a === null) return [];
      return labelRows(chain, [a]).map(labelOf);
    },

    /** Upsert metadata token; field null tidak menimpa nilai yang sudah ada. */
    async upsertTokens(rows, { now = clock() } = {}) {
      const params = rows.map((r) => ({
        chain: r.chain, address: address(r.chain, r.address, 'token.address'),
        symbol: optionalText(r.symbol, 64), name: optionalText(r.name, 200),
        decimals: Number.isInteger(r.decimals) ? r.decimals : null, now,
      }));
      tx.upsertTokens(params);
      return params.length;
    },

    async getToken(chain, addr) {
      const a = isChain(chain) ? normalizeAddress(chain, addr) : null;
      const row = a === null ? undefined : stmt.getToken.get(chain, a);
      return row ? { chain: row.chain, address: row.address, symbol: row.symbol, name: row.name, decimals: row.decimals, updatedAt: row.updated_at } : null;
    },

    /**
     * Simpan aktivitas (Activity kontrak §1). Duplikat `id` diabaikan (INSERT OR IGNORE); bila duplikat membawa
     * `usdValue` sementara baris tersimpan masih null (data terlambat), nilai USD diisi.
     * @returns {Promise<{ inserted: number, duplicates: number, usdFilled: number }>}
     */
    async insertActivities(activities, { now = clock() } = {}) {
      const params = activities.map((a) => activityParams(a, now));
      return tx.insertActivities(params);
    },

    /**
     * Aktivitas terurut `block_time, id` (order 'asc', default) atau TERBARU dulu (order 'desc' — LIMIT lalu memotong
     * yang tertua, bukan yang terbaru). `wallet` butuh `chain`; `tokenAddress` butuh `chain`.
     * @param {{ chain?, wallet?, tokenAddress?, since?, until?, types?: string[], limit?: number,
     *   order?: 'asc'|'desc' }} [filter]
     */
    async listActivities({
      chain = null, wallet = null, tokenAddress = null, since = null, until = null, types = null, limit = 10_000, order = 'asc',
    } = {}) {
      if (chain !== null) assertChain(chain);
      assertLimit(limit, ACTIVITY_LIMIT_MAX);
      if (order !== 'asc' && order !== 'desc') throw new RangeError("order harus 'asc' atau 'desc'");
      if ((wallet !== null || tokenAddress !== null) && chain === null) throw new RangeError('Filter wallet/token membutuhkan chain');
      if (types !== null && (!Array.isArray(types) || types.some((t) => !ACTIVITY_TYPES.includes(t)))) {
        throw new RangeError('types harus subset ACTIVITY_TYPES');
      }
      const params = {
        chain,
        wallet: wallet === null ? null : address(chain, wallet, 'wallet'),
        token: tokenAddress === null ? null : address(chain, tokenAddress, 'tokenAddress'),
        since: optionalTime(since, 'since') ?? 0,
        until: optionalTime(until, 'until') ?? Number.MAX_SAFE_INTEGER,
        types: types === null ? null : json(types),
        limit,
      };
      const query = params.wallet !== null ? stmt.activitiesByWallet
        : params.token !== null ? stmt.activitiesByToken : stmt.activitiesByTime;
      return query[order].all(params).map(activityOf);
    },

    /**
     * SELURUH aktivitas tersimpan (urut block_time, id) tanpa batas — hanya untuk analisis universe di sinkronisasi
     * (PnL FIFO butuh riwayat lengkap; pemotongan diam-diam akan merusak skor). Bukan untuk route API.
     */
    async listAllActivities() {
      return stmt.allActivities.all().map(activityOf);
    },

    /**
     * Saldo bersih (Σ IN − Σ OUT aktivitas tersimpan) per wallet × token SEBELUM `before` — masukan `holdingsBefore`
     * radar. Setiap wallet yang diminta selalu tercantum (Map kosong = tidak memegang apa pun). Saldo ≤ 1e-9 × total
     * volume (sisa pembulatan) atau negatif (aktivitas masuk tidak tercatat) dianggap 0.
     * @param {{ before: number, wallets: string[] }} input walletKey `chain:alamat`
     * @returns {Promise<Map<string, Map<string, number>>>} walletKey → tokenKey → jumlah
     */
    async holdingsBefore({ before, wallets }) {
      assertTime(before, 'before');
      const keys = [...new Set(wallets)];
      const out = new Map(keys.map((k) => [k, new Map()]));
      const pairs = keys.map((k) => [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)]);
      if (pairs.length === 0) return out;
      for (const row of stmt.holdingsBefore.all({ before, wallets: json(pairs) })) {
        const qty = row.qty > row.gross * 1e-9 ? row.qty : 0;
        if (qty > 0) out.get(keyOf(row.chain, row.wallet))?.set(keyOf(row.chain, row.token_address), qty);
      }
      return out;
    },

    /**
     * Simpan transfer mentah (keluaran normalizeTransfers) untuk SATU wallet yang dilacak (chain dari tiap transfer).
     * Kunci (chain, wallet, txHash, logIndex): kiriman ulang diabaikan, kecuali membawa info yang sebelumnya tidak
     * diketahui (usdValue, decimals, txMeta, …) — baris tersimpan dilengkapi (lihat mergeKnown).
     * @param {object[]} transfers RawTransfer ternormalisasi
     * @param {string} wallet alamat wallet
     * @returns {Promise<object[]>} transfer BARU bagi wallet ini + transfer tersimpan yang kini lebih lengkap (bentuk
     *   gabungan). Tx dari transfer-transfer ini perlu diklasifikasi ulang.
     */
    async insertRawTransfers(transfers, wallet, { now = clock() } = {}) {
      if (!Array.isArray(transfers)) throw new TypeError('transfers harus array');
      return tx.insertRaw(transfers.map((t) => rawParams(t, wallet, now)));
    },

    /**
     * Transfer mentah tersimpan milik wallet untuk sekumpulan tx (urut blockTime, txHash, logIndex) — seluruh kaki
     * yang diketahui, untuk klasifikasi ulang tx utuh.
     * @returns {Promise<object[]>}
     */
    async listRawTransfersForTxs(chain, wallet, txHashes) {
      assertChain(chain);
      const w = address(chain, wallet, 'wallet');
      const txs = normalizeTxs(chain, txHashes);
      if (txs.length === 0) return [];
      return stmt.rawForTxs.all({ chain, wallet: w, txs: json(txs) }).map((r) => JSON.parse(r.payload_json));
    },

    /**
     * Ganti SELURUH aktivitas satu wallet untuk sekumpulan tx: hapus lalu sisip dalam SATU transaksi (klasifikasi ulang
     * tx utuh saat kaki terlambat datang — baris lama yang tidak lagi berlaku ikut terhapus). `ingested_at` aktivitas
     * yang tetap ada dipertahankan. Aktivitas di luar chain × wallet × tx tersebut → RangeError (tidak ada yang ditulis).
     * @returns {Promise<{ deleted: number, inserted: number, newIds: string[], changedIds: string[], removedIds: string[] }>}
     *   newIds = id yang sebelumnya tidak ada; changedIds = id lama yang isinya berubah; removedIds = id lama yang hilang
     */
    async replaceActivitiesForTxs(chain, wallet, txHashes, activities, { now = clock() } = {}) {
      assertChain(chain);
      const w = address(chain, wallet, 'wallet');
      const txs = normalizeTxs(chain, txHashes);
      if (!Array.isArray(activities)) throw new TypeError('activities harus array');
      const allowed = new Set(txs);
      const rows = activities.map((a) => {
        const p = activityParams(a, now);
        if (p.chain !== chain || p.wallet !== w || !allowed.has(p.txHash)) {
          throw new RangeError('Aktivitas di luar wallet × tx yang diganti');
        }
        return p;
      });
      if (txs.length === 0) return { deleted: 0, inserted: 0, newIds: [], changedIds: [], removedIds: [] };
      return tx.replaceActivities({ chain, wallet: w, txs: json(txs) }, rows, now);
    },

    /**
     * Upsert skor wallet (WalletScore kontrak §2 + chain/address/clusterId/flags/pnl).
     * @returns {Promise<number>}
     */
    async saveWalletScores(rows) {
      const params = rows.map((r) => {
        if (!(isFiniteNumber(r.score) && r.score >= 0 && r.score <= 100)) throw new RangeError('score harus 0..100');
        if (!TRADING_STYLES.includes(r.style)) throw new RangeError(`Gaya trading tidak dikenal: ${String(r.style)}`);
        assertTime(r.computedAt, 'computedAt');
        return {
          chain: r.chain, address: address(r.chain, r.address, 'score.address'), computedAt: r.computedAt,
          score: r.score, eligible: flag(r.eligible), style: r.style, clusterId: r.clusterId ?? null,
          components: json(r.components ?? {}), metrics: json(r.metrics ?? {}), reasons: json(r.reasons ?? []),
          limitations: json(r.limitations ?? []), flags: json(r.flags ?? []), pnl: r.pnl === undefined || r.pnl === null ? null : json(r.pnl),
        };
      });
      tx.saveScores(params);
      return params.length;
    },

    /**
     * Wallet Discovery: skor turun, lalu chain & alamat. `includeFlagged` false (default) membuang wallet dengan
     * flag pengecualian HIGH (CEX/MM/BOT/MEV/CONTRACT/DEX_INFRA).
     */
    async listWalletScores({ chain = null, eligible = null, style = null, minScore = 0, includeFlagged = false, limit = 100 } = {}) {
      if (chain !== null) assertChain(chain);
      if (style !== null && !TRADING_STYLES.includes(style)) throw new RangeError('style tidak dikenal');
      if (!isFiniteNumber(minScore)) throw new RangeError('minScore harus angka');
      assertLimit(limit, LIST_LIMIT_MAX);
      return stmt.listScores.all({
        chain, eligible: eligible === null ? null : flag(eligible), style, minScore,
        includeFlagged: flag(includeFlagged), excluding: json(EXCLUDING_FLAGS), limit,
      }).map(scoreOf);
    },

    async getWalletScore(chain, addr) {
      const a = isChain(chain) ? normalizeAddress(chain, addr) : null;
      const row = a === null ? undefined : stmt.getScore.get(chain, a);
      return row ? scoreOf(row) : null;
    },

    /**
     * Ringkasan skor SEMUA wallet (tanpa batas; tanpa komponen/metrik/PnL) — masukan radar on-request.
     * @returns {Promise<Array<{ chain, address, score, eligible, style, clusterId, flags }>>}
     */
    async listScoreSummaries({ chain = null } = {}) {
      if (chain !== null) assertChain(chain);
      return stmt.scoreSummaries.all({ chain }).map((r) => ({
        chain: r.chain, address: r.address, score: r.score, eligible: toBool(r.eligible), style: r.style,
        clusterId: r.cluster_id, flags: parse(r.flags_json),
      }));
    },

    /** @returns {Promise<Map<string, number>>} clusterId → jumlah anggota (id klaster sudah memuat chain) */
    async clusterSizes() {
      return new Map(stmt.clusterSizes.all().map((r) => [r.cluster_id, r.size]));
    },

    /**
     * Ganti seluruh tepi tautan satu chain (hasil clusters.js run terakhir). Pasangan diurutkan (a < b);
     * `type` (atau `reasonType`) = jenis bukti.
     * @param {Array<{ a, b, type?, reasonType?, evidence? }>} links
     * @returns {Promise<number>} jumlah tepi yang ditulis
     */
    async replaceWalletLinks(chain, links, { now = clock() } = {}) {
      assertChain(chain);
      const rows = links.map((l) => {
        const a = address(chain, l.a, 'link.a');
        const b = address(chain, l.b, 'link.b');
        if (a === b) throw new RangeError('Tautan wallet ke dirinya sendiri tidak valid');
        const reasonType = l.type ?? l.reasonType;
        if (!nonEmpty(reasonType)) throw new RangeError('Jenis tautan wajib diisi');
        const [lo, hi] = a < b ? [a, b] : [b, a];
        return { chain, a: lo, b: hi, reasonType: String(reasonType).slice(0, 64), evidence: json(l.evidence ?? {}), now };
      });
      tx.replaceLinks(chain, rows);
      return rows.length;
    },

    /** Tepi tautan yang melibatkan satu alamat. */
    async listWalletLinks(chain, addr) {
      const a = isChain(chain) ? normalizeAddress(chain, addr) : null;
      if (a === null) return [];
      return stmt.linksOf.all({ chain, address: a }).map((row) => ({
        chain: row.chain, a: row.a, b: row.b, type: row.reason_type, evidence: parse(row.evidence_json), createdAt: row.created_at,
      }));
    },

    /** Anggota klaster menurut skor tersimpan (cluster_id). */
    async getClusterMembers(chain, clusterId) {
      if (!isChain(chain) || typeof clusterId !== 'string') return [];
      return stmt.clusterMembers.all(chain, clusterId).map((r) => r.address);
    },

    /**
     * Simpan mapping Binance (bentuk mappingRows binanceMatch.js). Satu kontrak boleh memiliki beberapa baris berbeda
     * (→ AMBIGUOUS); entri identik (chain, kontrak, aset, futures, multiplier) ditulis ulang.
     * PENGGANTIAN per penyegaran: dalam SATU transaksi, seluruh baris milik `provider` dihapus lalu diganti baris baru,
     * sehingga kontrak yang delisting/migrasi ikut hilang. Tanpa opsi `provider`, pemilik = `source` tiap baris
     * (baris dari satu sumber mengganti baris sumber itu). Sumber komposit adapter (mis. 'binance-getall+prefix-rule')
     * membutuhkan opsi `provider` agar penggantian mencakup semua variannya.
     * Validasi PER BARIS: baris tidak valid (mis. simbol aset non-ASCII, tanpa sumber, multiplier ≤ 0) DILEWATI dan
     * dilaporkan di `rejected` — satu baris rusak tidak menggagalkan seluruh penyegaran. Penyegaran tanpa satu pun
     * baris valid TIDAK menghapus mapping lama (respons rusak tidak boleh mengosongkan peta).
     * @param {object[]} rows
     * @param {{ provider?: string|null }} [options] id provider pemilik penyegaran (mis. 'binance-mapping')
     * @returns {Promise<{ upserted: number, rejected: Array<{ input: any, reason: string }> }>}
     */
    async upsertBinanceMap(rows, { provider = null } = {}) {
      if (provider !== null) assertProvider(provider);
      if (!Array.isArray(rows)) throw new TypeError('rows harus array');
      const params = [];
      const rejected = [];
      for (const r of rows) {
        const reason = mappingProblem(r);
        if (reason !== null) {
          rejected.push({ input: r, reason });
          continue;
        }
        params.push({
          chain: r.chain, contractAddress: normalizeAddress(r.chain, r.contractAddress), binanceAsset: r.binanceAsset.trim(),
          spotSymbol: r.spotSymbol ?? null, futuresSymbol: r.futuresSymbol ?? null, multiplier: r.multiplier ?? 1,
          source: r.source.trim(), provider: provider ?? r.source.trim().slice(0, 64), verifiedAt: r.verifiedAt ?? null,
        });
      }
      if (params.length > 0) {
        const owners = provider !== null ? [provider] : [...new Set(params.map((p) => p.provider))];
        tx.replaceMapping(owners, params);
      }
      return { upserted: params.length, rejected };
    },

    async listBinanceMap() {
      return stmt.listMapping.all().map(mappingOf);
    },

    /**
     * Tambah item watchlist pengguna (idempoten; catatan diperbarui).
     * @returns {Promise<{ kind, chain, address, note, createdAt }|null>} null bila kind/chain/alamat tidak valid
     */
    async addToWatchlist(userId, item, { now = clock() } = {}) {
      const w = watchItem(userId, item);
      if (w === null) return null;
      const note = item.note === null || item.note === undefined ? null : String(item.note).slice(0, NOTE_MAX);
      const row = stmt.addWatch.get({ ...w, note, now });
      return { kind: row.kind, chain: row.chain, address: row.address, note: row.note, createdAt: row.created_at };
    },

    /** @returns {Promise<boolean>} true bila ada yang dihapus; false bila tidak ada / masukan tidak valid */
    async removeFromWatchlist(userId, item) {
      const w = watchItem(userId, item);
      if (w === null) return false;
      return stmt.removeWatch.run(w).changes > 0;
    },

    async listWatchlist(userId) {
      if (!Number.isInteger(userId) || userId < 1) return [];
      return stmt.listWatch.all(userId).map((r) => ({ kind: r.kind, chain: r.chain, address: r.address, note: r.note, createdAt: r.created_at }));
    },

    /** Watchlist SEMUA pengguna (sinkronisasi: wallet dipantau selalu dilacak; gabungan watchlist untuk alert). */
    async listAllWatchlist() {
      return stmt.listAllWatch.all().map((r) => ({ userId: r.user_id, kind: r.kind, chain: r.chain, address: r.address }));
    },

    /** Semua label (setiap sumber) untuk banyak alamat SATU chain → Map alamat kanonik → label[]. */
    async listLabelsForMany(chain, addresses) {
      assertChain(chain);
      const normalized = [...new Set(addresses.map((a) => normalizeAddress(chain, a)).filter((a) => a !== null))];
      const out = new Map();
      for (const row of labelRows(chain, normalized)) {
        const list = out.get(row.address) ?? [];
        list.push(labelOf(row));
        out.set(row.address, list);
      }
      return out;
    },

    /**
     * Simpan alert (Alert kontrak alerts.js). Key dedupe yang sudah ada diabaikan. `isSimulated` WAJIB boolean
     * (tidak ada default 0 — alert dari data simulasi tidak boleh tersimpan sebagai data live).
     * @returns {Promise<number>} jumlah alert baru
     */
    async insertAlerts(alerts) {
      const params = alerts.map((a) => {
        if (!ALERT_KINDS.includes(a.kind)) throw new RangeError(`Jenis alert tidak dikenal: ${String(a.kind)}`);
        if (!ALERT_SEVERITIES.includes(a.severity)) throw new RangeError('severity alert tidak valid');
        if (!nonEmpty(a.dedupeKey)) throw new RangeError('dedupeKey wajib diisi');
        assertChain(a.chain);
        assertTime(a.createdAt, 'alert.createdAt');
        const eventAt = optionalTime(a.eventAt, 'alert.eventAt');
        if (!nonEmpty(a.title) || !nonEmpty(a.message)) throw new RangeError('Judul dan pesan alert wajib diisi');
        // Tanpa default: alert dari data simulasi tidak boleh tersimpan diam-diam sebagai data live.
        if (typeof a.isSimulated !== 'boolean') throw new RangeError('alert.isSimulated wajib boolean');
        return {
          dedupeKey: a.dedupeKey, kind: a.kind, severity: a.severity, chain: a.chain, tokenKey: a.tokenKey ?? null,
          wallet: a.wallet ?? null, title: a.title, message: a.message, evidence: json(a.evidence ?? {}),
          createdAt: a.createdAt, eventAt, isSimulated: flag(a.isSimulated),
        };
      });
      return tx.insertAlerts(params);
    },

    /** @returns {Promise<Set<string>>} key dedupe yang sudah tersimpan */
    async existingAlertKeys(keys) {
      if (keys.length === 0) return new Set();
      return new Set(stmt.existingKeys.all(json([...keys])).map((r) => r.dedupe_key));
    },

    /**
     * Waktu PERISTIWA alert terakhir per kunci dasar alerts.js alertBaseKey (`${kind}:${tokenKey}:${wallet|'*'}`)
     * untuk alert yang dibuat (createdAt) ≥ `since` — masukan cooldown sejati deriveAlertsDetailed (`lastAlertAt`).
     * Waktu = eventAt; createdAt bila eventAt tidak diketahui (baris tanpa event_at). Alert tanpa tokenKey memakai
     * dedupeKey tanpa segmen ember terakhir.
     * @returns {Promise<Map<string, number>>}
     */
    async lastAlertTimes({ since = 0 } = {}) {
      assertTime(since, 'since');
      const out = new Map();
      for (const r of stmt.alertTimesSince.all(since)) {
        const i = r.dedupe_key.lastIndexOf(':');
        const base = r.token_key !== null
          ? alertBaseKey({ kind: r.kind, tokenKey: r.token_key, wallet: r.wallet })
          : (i > 0 ? r.dedupe_key.slice(0, i) : r.dedupe_key);
        if (!(out.get(base) >= r.at)) out.set(base, r.at);
      }
      return out;
    },

    /** Alert terbaru dulu dengan status `read` milik pengguna tersebut. */
    async listAlerts({ userId, unreadOnly = false, kind = null, limit = 50 } = {}) {
      if (!Number.isInteger(userId) || userId < 1) throw new RangeError('userId tidak valid');
      if (kind !== null && !ALERT_KINDS.includes(kind)) throw new RangeError('kind alert tidak dikenal');
      assertLimit(limit, LIST_LIMIT_MAX);
      return stmt.listAlerts.all({ userId, unreadOnly: flag(unreadOnly), kind, limit }).map(alertOf);
    },

    /**
     * Tandai alert dibaca untuk satu pengguna. `ids` = daftar id atau 'all'.
     * @returns {Promise<number>} jumlah tanda baca baru
     */
    async markAlertsRead(userId, ids, { now = clock() } = {}) {
      if (!Number.isInteger(userId) || userId < 1) throw new RangeError('userId tidak valid');
      if (ids === 'all') return stmt.markAllRead.run({ userId, now }).changes;
      if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id) || id < 1)) throw new RangeError('ids harus daftar id alert');
      if (ids.length === 0) return 0;
      return stmt.markRead.run({ userId, ids: json(ids), now }).changes;
    },

    /** @returns {Promise<object|null>} preferensi tersimpan atau null (pemanggil memakai DEFAULT_ALERT_PREFS) */
    async getAlertPrefs(userId) {
      const row = stmt.getPrefs.get(userId);
      return row ? JSON.parse(row.prefs_json) : null;
    },

    /** Simpan preferensi (validasi isi dilakukan alerts.js validateAlertPrefs sebelum memanggil). */
    async saveAlertPrefs(userId, prefs, { now = clock() } = {}) {
      if (!Number.isInteger(userId) || userId < 1) throw new RangeError('userId tidak valid');
      if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs)) throw new TypeError('prefs harus objek');
      stmt.savePrefs.run({ userId, prefs: json(prefs), now });
      return prefs;
    },

    /** Preferensi notifikasi semua pengguna yang pernah menyimpannya (sinkronisasi: ambang paling longgar). */
    async listAllAlertPrefs() {
      return stmt.listAllPrefs.all().map((r) => ({ userId: r.user_id, prefs: JSON.parse(r.prefs_json) }));
    },

    async recordProviderAttempt(provider, { now = clock(), isSimulated = false } = {}) {
      assertProvider(provider);
      stmt.providerAttempt.run({ provider, now, isSimulated: flag(isSimulated) });
    },

    /** Sukses menghapus error terakhir; `coverage` (mis. { chains, wallets }) opsional. */
    async recordProviderSuccess(provider, { now = clock(), coverage = null, isSimulated = false } = {}) {
      assertProvider(provider);
      stmt.providerSuccess.run({ provider, now, coverage: coverage === null ? null : json(coverage), isSimulated: flag(isSimulated) });
    },

    /** Kegagalan provider. `message` dipotong 500 karakter; pemanggil wajib sudah menyamarkan kunci API. */
    async recordProviderFailure(provider, { now = clock(), code, message = null, isSimulated = false } = {}) {
      assertProvider(provider);
      if (!PROVIDER_ERROR_CODES.includes(code)) throw new RangeError(`Kode error provider tidak dikenal: ${String(code)}`);
      stmt.providerFailure.run({ provider, now, code, message: optionalText(message, ERROR_MESSAGE_MAX), isSimulated: flag(isSimulated) });
    },

    async listProviderStatus() {
      return stmt.listProviders.all().map(providerStatusOf);
    },

    /** Kursor sinkronisasi; `addr` kosong ('') = kursor tingkat chain. */
    async getCursor(provider, chain, addr = '') {
      const a = addr === '' || addr === null || addr === undefined ? '' : (isChain(chain) ? normalizeAddress(chain, addr) : null);
      if (a === null) return null;
      const row = stmt.getCursor.get(provider, chain, a);
      return row ? row.cursor : null;
    },

    async setCursor(provider, chain, addr, cursor, { now = clock() } = {}) {
      assertProvider(provider);
      assertChain(chain);
      const a = addr === '' || addr === null || addr === undefined ? '' : address(chain, addr, 'alamat kursor');
      if (cursor !== null && typeof cursor !== 'string') throw new TypeError('cursor harus string atau null');
      stmt.setCursor.run({ provider, chain, address: a, cursor, now });
    },

    /** @returns {Promise<Map<string, number>>} walletKey → waktu kursor wallet terakhir ditulis (provider mana pun) */
    async listWalletSyncTimes() {
      return new Map(stmt.walletSyncTimes.all().map((r) => [keyOf(r.chain, r.address), r.synced_at]));
    },

    /** @returns {Promise<{ value: any, updatedAt: number }|null>} status sinkronisasi tersimpan untuk `key` */
    async getSyncState(key) {
      const row = typeof key === 'string' ? stmt.getSyncState.get(key) : undefined;
      return row ? { value: JSON.parse(row.value_json), updatedAt: row.updated_at } : null;
    },

    /** Simpan status sinkronisasi (nilai JSON) untuk `key` (1..64 karakter). */
    async setSyncState(key, value, { now = clock() } = {}) {
      if (typeof key !== 'string' || key.length < 1 || key.length > 64) throw new RangeError('key status sinkronisasi tidak valid');
      if (value === undefined) throw new TypeError('value wajib diisi');
      stmt.setSyncState.run({ key, value: json(value), now });
    },

    /**
     * Lease putaran sinkronisasi lintas proses (server dan worker scanner memakai database yang sama): diambil hanya bila
     * belum ada atau sudah kedaluwarsa (pemegangnya mati tanpa melepas). Tidak re-entrant — pemilik yang sama pun
     * ditolak selama lease berlaku, jadi dua permintaan serentak di satu proses juga tidak menjalankan dua putaran.
     * Atomik (BEGIN IMMEDIATE), jadi dua proses tidak pernah sama-sama mendapatkannya.
     * @param {{ owner: string, trigger: 'manual'|'schedule', ttlMs: number, now?: number }} options
     * @returns {Promise<{ acquired: boolean, lease: { owner: string, trigger: string, acquiredAt: number, expiresAt: number,
     *   progress: { phase: string, done: number|null, total: number|null, updatedAt: number } } }>} lease = pemegang saat ini
     */
    async acquireSyncLease({ owner, trigger, ttlMs, now = clock() }) {
      assertLeaseOwner(owner);
      if (!LEASE_TRIGGERS.includes(trigger)) throw new RangeError('trigger lease tidak valid');
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs lease harus bilangan bulat > 0');
      assertTime(now, 'now');
      return tx.acquireLease.immediate(owner, trigger, ttlMs, now);
    },

    /** Perpanjang lease milik `owner` (opsional dengan progres terbaru). @returns {Promise<boolean>} false bila bukan pemegang */
    async renewSyncLease({ owner, ttlMs, progress = null, now = clock() }) {
      assertLeaseOwner(owner);
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs lease harus bilangan bulat > 0');
      assertTime(now, 'now');
      const p = progress ? {
        phase: typeof progress.phase === 'string' ? progress.phase.slice(0, 32) : 'start',
        done: Number.isSafeInteger(progress.done) && progress.done >= 0 ? progress.done : null,
        total: Number.isSafeInteger(progress.total) && progress.total >= 0 ? progress.total : null,
      } : null;
      return tx.renewLease.immediate(owner, ttlMs, p, now);
    },

    /** Lepas lease milik `owner`. @returns {Promise<boolean>} false bila lease sudah dipegang proses lain / tidak ada */
    async releaseSyncLease({ owner }) {
      assertLeaseOwner(owner);
      return tx.releaseLease.immediate(owner);
    },

    /** @returns {Promise<object|null>} lease aktif (belum kedaluwarsa pada `now`), atau null */
    async getSyncLease({ now = clock() } = {}) {
      const lease = readLease();
      return lease && lease.expiresAt > now ? lease : null;
    },

    /** @returns {Promise<number>} id evaluasi */
    async saveEvaluation({ computedAt, params, report, isSimulated = false }) {
      assertTime(computedAt, 'computedAt');
      return Number(stmt.insertEvaluation.run({
        computedAt, params: json(params ?? {}), report: json(report), isSimulated: flag(isSimulated),
      }).lastInsertRowid);
    },

    /** @returns {Promise<{ id, computedAt, params, report, isSimulated }|null>} */
    async latestEvaluation() {
      const row = stmt.latestEvaluation.get();
      return row ? {
        id: row.id, computedAt: row.computed_at, params: parse(row.params_json), report: parse(row.report_json),
        isSimulated: toBool(row.is_simulated),
      } : null;
    },

    /** true bila ada data simulasi tersimpan → UI wajib menampilkan pita "DATA SIMULASI". */
    async hasSimulatedData() {
      return stmt.hasSimulated.get().simulated === 1;
    },

    /** @returns {Promise<{ wallets: number, activities: number, chains: string[], lastActivityAt: number|null }>} */
    async coverage() {
      const c = stmt.coverageCounts.get();
      return {
        wallets: c.wallets, activities: c.activities, chains: stmt.coverageChains.all().map((r) => r.chain),
        lastActivityAt: c.last_activity_at ?? null,
      };
    },
  };
}
