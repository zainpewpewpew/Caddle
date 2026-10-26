// Notifikasi smart money (kontrak docs/15-kontrak-smart-money.md §2 `alerts.js`). Fungsi murni: tanpa I/O, tanpa
// waktu sistem (waktu lewat `now`). Teks Bahasa Indonesia; setiap alert menyebut alamat wallet singkat, simbol
// token DAN alamat kontrak singkat (simbol sama ≠ token sama), nilai USD, serta tautan explorer di `evidence`.
//
// ─── Aturan ────────────────────────────────────────────────────────────────────────────────────────
// Wallet kandidat = wallet di watchlist ATAU wallet eligible tanpa penanda pengecuali (isWalletExcluded).
// NEW_BUY              SWAP_BUY ≥ minUsd (USD tidak diketahui hanya untuk wallet dipantau) pada token yang belum
//                      dibeli dalam lookback: lookback = positions.qtyBefore (> 0 = sudah memegang) + transaksi
//                      SWAP_BUY radar yang lebih awal + SWAP_BUY lebih awal dalam batch yang sama.
// REPEAT_ACCUMULATION  ada SWAP_BUY baru dan jumlah SWAP_BUY berbeda (tx) wallet atas token di jendela radar
//                      ∪ batch ≥ repeatMinBuys (3).
// MULTI_WALLET_BUY     RadarToken.independentBuyers ≥ prefs.minIndependentBuyers (wallet = null → '*').
// LARGE_SELL           SWAP_SELL dengan USD diketahui ≥ prefs.largeSellUsd.
// WALLET_EXIT          wallet DIPANTAU, positions qtyBefore > 0 dan qtyAfter ≤ 10 % qtyBefore, dengan SWAP_SELL
//                      dan/atau CEX_DEPOSIT di batch. Pengurangan lewat transfer biasa saja tidak memicu alert.
//                      Teks mengikuti jalur DOMINAN dengan persentase dari jumlah yang berkurang: swap ("dijual via
//                      swap"), deposit exchange ("dipindah ke exchange, belum tentu dijual"), dan sisa yang tidak
//                      tercakup swap/deposit di batch ("dipindah lewat transfer/LP/bridge, belum tentu dijual").
//                      Mis. 1 % swap + 99 % transfer → "99% dipindah lewat transfer/LP/bridge …, 1% dijual via swap",
//                      bukan "dijual via swap". Severity HIGH hanya bila swap ≥ 50 % pengurangan, selain itu MEDIUM.
// dedupeKey = `${kind}:${tokenKey}:${wallet|'*'}:${bucket}`, bucket = floor(t / cooldownMs), t = waktu peristiwa
// (blockTime aktivitas pemicu; untuk MULTI_WALLET_BUY pembelian terakhir di radar) sehingga run berulang atas
// peristiwa yang sama dalam satu ember menghasilkan kunci yang sama. Format ini TIDAK berubah.
//
// ─── Waktu: peristiwa basi & cooldown sejati ───────────────────────────────────────────────────────
// - Peristiwa basi: alert dengan now − t > prefs.maxEventAgeMs (default 30 menit = 2 × interval sinkronisasi
//   15 menit) tidak dibuat — data lama yang baru tiba (terlambat) bukan "baru". Dihitung `skipped.stale`.
// - Cooldown sejati (ember tetap tidak cukup: dua jual berjarak 2 menit di sisi berbeda batas ember lolos): argumen
//   ketiga opsional `{ lastAlertAt: Map<baseKey, epochMs> }`, baseKey = alertBaseKey(alert) =
//   `${kind}:${tokenKey}:${wallet|'*'}`. Alert ditahan bila t − lastAlertAt < cooldownMs (termasuk t lebih awal dari
//   alert terakhir). Di dalam satu run, alert yang lolos memperbarui waktu terakhir baseKey-nya (= t), sehingga
//   peristiwa berikutnya untuk baseKey yang sama dalam cooldown juga ditahan. Dihitung `skipped.cooldown`.
//   Pemanggil (sinkronisasi) mengisi lastAlertAt dari alert tersimpan (eventAt, atau createdAt bila tidak ada).
// - deriveAlertsDetailed → { alerts, skipped: { stale, cooldown } }; deriveAlerts → alerts saja (kompatibel).
//
// ─── Provenans ─────────────────────────────────────────────────────────────────────────────────────
// `isSimulated` = true bila ADA aktivitas sumber alert yang isSimulated === true (termasuk tx radar yang dipakai
// REPEAT_ACCUMULATION, dan RadarToken.isSimulated untuk MULTI_WALLET_BUY). Data simulasi tidak boleh tampil live.
//
// Ekstensi kontrak (aditif, dibutuhkan filterAlerts): `usd` (number|null), `walletScore` (number|null),
// `watchlisted` (wallet atau token ada di watchlist), `walletWatched` (wallet ada di watchlist), `symbol`,
// `evidence.walletUrl`, `evidence.tokenUrl`, `eventAt` (t), `isSimulated`.
// filterAlerts: wallet dipantau dikecualikan dari minWalletScore; WALLET_EXIT dikecualikan dari minUsd (keluar
// diukur dari proporsi kepemilikan, bukan nominal); alert ber-USD tidak diketahui hanya lolos minUsd bila dipantau.

import {
  ALERT_KINDS, explorerAddressUrl, explorerTokenUrl, explorerTxUrl, isQuoteAsset, tokenKey as makeTokenKey,
  walletKey as makeWalletKey,
} from './contracts.js';
import { dedupeActivities, formatUsd, isWalletExcluded, shortAddress } from './radar.js';

/** Preferensi notifikasi default (per pengguna). */
export const DEFAULT_ALERT_PREFS = Object.freeze({
  kinds: Object.freeze([...ALERT_KINDS]),
  minUsd: 1000,
  largeSellUsd: 10_000,
  minWalletScore: 60,
  minIndependentBuyers: 3,
  cooldownMs: 6 * 3_600_000,
  watchlistOnly: false,
  /** Umur maksimum peristiwa (now − waktu peristiwa) agar dialertkan: 2 × interval sinkronisasi 15 menit. */
  maxEventAgeMs: 2 * 15 * 60_000,
});

const REPEAT_MIN_BUYS = 3;
const EXIT_DROP = 0.9;
const COOLDOWN_MIN = 60_000;
const COOLDOWN_MAX = 7 * 24 * 3_600_000;
const EVENT_AGE_MIN = 60_000;
const EVENT_AGE_MAX = 7 * 24 * 3_600_000;
const SWAP_HIGH_SHARE = 0.5;
const KIND_ORDER = Object.fromEntries(ALERT_KINDS.map((k, i) => [k, i]));

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Validasi preferensi notifikasi (parsial diizinkan; field yang tidak ada memakai default).
 * @param {object} prefs
 * @returns {string[]} daftar kesalahan (kosong = valid)
 */
export function validateAlertPrefs(prefs) {
  if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs)) return ['Preferensi notifikasi harus objek'];
  const errors = [];
  for (const key of Object.keys(prefs)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_ALERT_PREFS, key)) errors.push(`Preferensi tidak dikenal: ${key}`);
  }
  if ('kinds' in prefs) {
    const k = prefs.kinds;
    if (!Array.isArray(k)) errors.push('kinds harus array');
    else {
      const bad = k.filter((x) => !ALERT_KINDS.includes(x));
      if (bad.length) errors.push(`Jenis notifikasi tidak dikenal: ${bad.map(String).join(', ')}`);
      if (new Set(k).size !== k.length) errors.push('kinds tidak boleh berisi duplikat');
    }
  }
  const nonNeg = (key, max) => {
    if (!(key in prefs)) return;
    const v = prefs[key];
    if (!(isNum(v) && v >= 0 && v <= max)) errors.push(`${key} harus angka 0..${max}`);
  };
  nonNeg('minUsd', 1e12);
  nonNeg('largeSellUsd', 1e12);
  nonNeg('minWalletScore', 100);
  if ('minIndependentBuyers' in prefs) {
    const v = prefs.minIndependentBuyers;
    if (!(Number.isInteger(v) && v >= 1 && v <= 100)) errors.push('minIndependentBuyers harus bilangan bulat 1..100');
  }
  if ('cooldownMs' in prefs) {
    const v = prefs.cooldownMs;
    if (!(Number.isInteger(v) && v >= COOLDOWN_MIN && v <= COOLDOWN_MAX)) {
      errors.push(`cooldownMs harus bilangan bulat ${COOLDOWN_MIN}..${COOLDOWN_MAX} ms`);
    }
  }
  if ('watchlistOnly' in prefs && typeof prefs.watchlistOnly !== 'boolean') errors.push('watchlistOnly harus boolean');
  if ('maxEventAgeMs' in prefs) {
    const v = prefs.maxEventAgeMs;
    if (!(Number.isInteger(v) && v >= EVENT_AGE_MIN && v <= EVENT_AGE_MAX)) {
      errors.push(`maxEventAgeMs harus bilangan bulat ${EVENT_AGE_MIN}..${EVENT_AGE_MAX} ms`);
    }
  }
  return errors;
}

function resolvePrefs(prefs) {
  const errors = validateAlertPrefs(prefs ?? {});
  if (errors.length) throw new RangeError(`Preferensi notifikasi tidak valid: ${errors.join('; ')}`);
  return { ...DEFAULT_ALERT_PREFS, ...(prefs ?? {}) };
}

function tokenLabel(chain, token) {
  return `${token?.symbol ?? '?'} (kontrak ${shortAddress(token?.address)}, ${chain})`;
}

function txUrl(a) {
  return a.explorerUrl ?? explorerTxUrl(a.chain, a.txHash);
}

const simulated = (x) => x?.isSimulated === true;

/**
 * Kunci dasar cooldown sebuah alert: dedupeKey tanpa ember waktu.
 * @param {{ kind: string, tokenKey: string, wallet?: string|null }} alert
 * @returns {string} `${kind}:${tokenKey}:${wallet ?? '*'}`
 */
export function alertBaseKey(alert) {
  return `${alert.kind}:${alert.tokenKey}:${alert.wallet ?? '*'}`;
}

function resolveLastAlertAt(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Opsi alert harus objek');
  }
  const { lastAlertAt = new Map() } = options;
  if (!(lastAlertAt instanceof Map)) throw new TypeError('lastAlertAt harus Map<baseKey, epoch ms>');
  return lastAlertAt;
}

/** Jumlah (amount) yang diketahui dari daftar aktivitas; null bila ada yang tidak diketahui. */
function knownQty(list) {
  let sum = 0;
  for (const a of list) {
    if (!(isNum(a.amount) && a.amount >= 0)) return null;
    sum += a.amount;
  }
  return sum;
}

/**
 * Teks jalur keluar WALLET_EXIT berdasarkan jalur dominan (porsi dari jumlah yang berkurang).
 * @returns {{ verb: string, detail: string, swapShare: number }}
 */
function exitWording(sells, deposits, dropQty) {
  const swapQty = knownQty(sells);
  const cexQty = knownQty(deposits);
  const PHRASE = {
    swap: { verb: 'menjual', single: 'dijual via swap', part: 'dijual via swap' },
    cex: { verb: 'memindahkan ke exchange', single: 'dipindah ke exchange, belum tentu dijual', part: 'dipindah ke exchange (belum tentu dijual)' },
    other: {
      verb: 'memindahkan', single: 'dipindah lewat transfer/LP/bridge, belum tentu dijual',
      part: 'dipindah lewat transfer/LP/bridge (belum tentu dijual)',
    },
  };
  if (swapQty === null || cexQty === null || !(swapQty + cexQty > 0)) {
    // Jumlah tidak diketahui → hanya jenis jalur yang disebut, tanpa persentase dan tanpa klaim "dijual" penuh.
    if (!sells.length) return { verb: PHRASE.cex.verb, detail: PHRASE.cex.single, swapShare: 0 };
    if (!deposits.length) {
      return { verb: 'menjual / memindahkan', detail: 'ada penjualan via swap (porsi tidak diketahui; sisanya belum tentu dijual)', swapShare: 0 };
    }
    return {
      verb: 'menjual / memindahkan',
      detail: 'sebagian dijual via swap, sebagian dipindah ke exchange (porsi tidak diketahui; belum tentu dijual)',
      swapShare: 0,
    };
  }
  const total = Math.max(dropQty, swapQty + cexQty);
  const shares = [
    { key: 'swap', share: swapQty / total },
    { key: 'cex', share: cexQty / total },
    { key: 'other', share: Math.max(0, total - swapQty - cexQty) / total },
  ].filter((x) => x.share > 0).sort((x, y) => y.share - x.share);
  const swapShare = swapQty / total;
  const dominant = shares[0].key;
  if (shares.length === 1) return { verb: PHRASE[dominant].verb, detail: PHRASE[dominant].single, swapShare };
  const pct = (v) => (v > 0 && v < 0.01 ? '< 1' : String(Math.round(v * 100)));
  return {
    verb: PHRASE[dominant].verb,
    detail: shares.map((x) => `${pct(x.share)}% ${PHRASE[x.key].part}`).join(', '),
    swapShare,
  };
}

/**
 * Menurunkan alert dari aktivitas baru & radar terkini.
 * @param {{ activities: object[], radar?: object[], watchlist?: { wallets?: Set<string>, tokens?: Set<string> },
 *   walletScores?: Map<string, { score: number, eligible: boolean, flags: object[] }>,
 *   positions?: Map<string, Map<string, { qtyBefore: number, qtyAfter: number }>>, now: number }} input
 * @param {Partial<typeof DEFAULT_ALERT_PREFS>} [prefs]
 * @param {{ lastAlertAt?: Map<string, number> }} [options] waktu alert terakhir per alertBaseKey (cooldown sejati)
 * @returns {object[]} Alert[] unik per dedupeKey, terurut (jenis, dedupeKey).
 */
export function deriveAlerts(input, prefs = {}, options = {}) {
  return deriveAlertsDetailed(input, prefs, options).alerts;
}

/**
 * Seperti deriveAlerts, ditambah jumlah alert yang ditahan karena peristiwa basi atau cooldown.
 * @param {object} input lihat deriveAlerts
 * @param {Partial<typeof DEFAULT_ALERT_PREFS>} [prefs]
 * @param {{ lastAlertAt?: Map<string, number> }} [options]
 * @returns {{ alerts: object[], skipped: { stale: number, cooldown: number } }}
 */
export function deriveAlertsDetailed(input, prefs = {}, options = {}) {
  if (input === null || typeof input !== 'object') throw new TypeError('Input alert harus objek');
  const {
    activities = [], radar = [], watchlist = {}, walletScores = new Map(), positions = new Map(), now,
  } = input;
  if (!Array.isArray(activities)) throw new TypeError('activities harus array');
  if (!Array.isArray(radar)) throw new TypeError('radar harus array');
  if (!Number.isInteger(now)) throw new TypeError('now harus epoch ms bilangan bulat');
  const p = resolvePrefs(prefs);
  const lastAlertAt = resolveLastAlertAt(options ?? {});
  const watchedWallets = watchlist.wallets instanceof Set ? watchlist.wallets : new Set();
  const watchedTokens = watchlist.tokens instanceof Set ? watchlist.tokens : new Set();
  const radarByToken = new Map(radar.map((r) => [r.tokenKey, r]));
  const bucket = (t) => Math.floor(t / p.cooldownMs);

  const out = new Map();
  const skipped = { stale: 0, cooldown: 0 };
  const lastEmitted = new Map(); // baseKey → waktu peristiwa alert terakhir yang lolos di run ini
  const emit = (alert) => {
    if (out.has(alert.dedupeKey)) return;
    if (now - alert.eventAt > p.maxEventAgeMs) { skipped.stale += 1; return; }
    const key = alertBaseKey(alert);
    const last = lastEmitted.has(key) ? lastEmitted.get(key) : lastAlertAt.get(key);
    if (isNum(last) && alert.eventAt - last < p.cooldownMs) { skipped.cooldown += 1; return; }
    lastEmitted.set(key, alert.eventAt);
    out.set(alert.dedupeKey, alert);
  };
  const base = ({ kind, severity, chain, tKey, wallet, t, token }) => ({
    kind, severity,
    dedupeKey: `${kind}:${tKey}:${wallet ?? '*'}:${bucket(t)}`,
    chain, tokenKey: tKey, wallet: wallet ?? null, symbol: token?.symbol ?? null,
    createdAt: now,
    eventAt: t,
  });

  const acts = dedupeActivities(activities).filter((a) => isNum(a.blockTime) && a.blockTime <= now && !isQuoteAsset(a.chain, a.token.address));

  // Kelompokkan per wallet × token.
  const groups = new Map();
  for (const a of acts) {
    const wKey = makeWalletKey(a.chain, a.wallet);
    const tKey = makeTokenKey(a.chain, a.token.address);
    const ws = walletScores instanceof Map ? walletScores.get(wKey) : undefined;
    const watched = watchedWallets.has(wKey);
    if (!watched && isWalletExcluded(ws)) continue;
    const gKey = `${wKey}|${tKey}`;
    if (!groups.has(gKey)) groups.set(gKey, { wKey, tKey, chain: a.chain, wallet: a.wallet, token: a.token, ws, watched, acts: [] });
    groups.get(gKey).acts.push(a);
  }

  for (const g of [...groups.values()].sort((x, y) => cmp(`${x.wKey}|${x.tKey}`, `${y.wKey}|${y.tKey}`))) {
    const { chain, wallet, token, tKey, wKey, ws, watched } = g;
    const score = isNum(ws?.score) ? ws.score : null;
    const watchlisted = watched || watchedTokens.has(tKey);
    const who = `${watched ? 'Wallet dipantau' : 'Wallet'} ${shortAddress(wallet)}${score !== null ? ` (skor ${Math.round(score)})` : ''}`;
    const tl = tokenLabel(chain, token);
    const evidenceOf = (list) => ({
      txHashes: list.map((a) => a.txHash),
      explorerUrls: list.map(txUrl),
      walletUrl: explorerAddressUrl(chain, wallet),
      tokenUrl: explorerTokenUrl(chain, token.address),
    });
    const extra = { usd: null, walletScore: score, watchlisted, walletWatched: watched };
    const radarBuyer = radarByToken.get(tKey)?.buyers?.find((b) => b.wallet === wallet) ?? null;
    const radarBuyTimes = (radarBuyer?.txs ?? []).filter((t) => t.type === 'SWAP_BUY');
    const pos = positions instanceof Map ? positions.get(wKey)?.get(tKey) : undefined;
    const buys = g.acts.filter((a) => a.type === 'SWAP_BUY');
    const sells = g.acts.filter((a) => a.type === 'SWAP_SELL');
    const deposits = g.acts.filter((a) => a.type === 'CEX_DEPOSIT');

    // NEW_BUY — hanya pembelian pertama dalam lookback.
    const first = buys[0];
    if (first) {
      const heldBefore = isNum(pos?.qtyBefore) && pos.qtyBefore > 0;
      const earlierInRadar = radarBuyTimes.some((t) => t.at < first.blockTime && t.txHash !== first.txHash);
      const usd = isNum(first.usdValue) ? first.usdValue : null;
      const usdOk = usd === null ? watched : usd >= p.minUsd;
      if (!heldBefore && !earlierInRadar && usdOk) {
        emit({
          ...base({ kind: 'NEW_BUY', severity: watched ? 'HIGH' : 'MEDIUM', chain, tKey, wallet, t: first.blockTime, token }),
          title: `Beli baru: ${shortAddress(wallet)} membeli ${token.symbol ?? '?'} (${shortAddress(token.address)})`,
          message: `${who} membeli ${tl} via swap senilai ${formatUsd(usd)}. Pembelian swap pertama atas token ini dalam periode pantauan.`,
          evidence: evidenceOf([first]),
          ...extra, usd,
          isSimulated: simulated(first),
        });
      }
    }

    // REPEAT_ACCUMULATION
    if (buys.length) {
      const txs = new Set([...radarBuyTimes.map((t) => t.txHash), ...buys.map((a) => a.txHash)]);
      if (txs.size >= REPEAT_MIN_BUYS) {
        const last = buys[buys.length - 1];
        const known = buys.filter((a) => isNum(a.usdValue));
        const radarUsd = radarBuyer && isNum(radarBuyer.netBuyUsd) ? radarBuyer.netBuyUsd : null;
        const usd = radarUsd ?? (known.length ? known.reduce((s, a) => s + a.usdValue, 0) : null);
        emit({
          ...base({ kind: 'REPEAT_ACCUMULATION', severity: 'MEDIUM', chain, tKey, wallet, t: last.blockTime, token }),
          title: `Akumulasi berulang: ${shortAddress(wallet)} membeli ${token.symbol ?? '?'} (${shortAddress(token.address)}) ${txs.size}×`,
          message: `${who} sudah ${txs.size} kali membeli ${tl} via swap dalam jendela radar (beli bersih ${formatUsd(usd)}).`,
          evidence: evidenceOf(buys),
          ...extra, usd,
          isSimulated: buys.some(simulated) || radarBuyTimes.some(simulated),
        });
      }
    }

    // LARGE_SELL
    for (const s of sells) {
      if (!(isNum(s.usdValue) && s.usdValue >= p.largeSellUsd)) continue;
      emit({
        ...base({ kind: 'LARGE_SELL', severity: 'HIGH', chain, tKey, wallet, t: s.blockTime, token }),
        title: `Jual besar: ${shortAddress(wallet)} menjual ${token.symbol ?? '?'} (${shortAddress(token.address)}) ${formatUsd(s.usdValue)}`,
        message: `${who} menjual ${tl} via swap senilai ${formatUsd(s.usdValue)}.`,
        evidence: evidenceOf([s]),
        ...extra, usd: s.usdValue,
        isSimulated: simulated(s),
      });
    }

    // WALLET_EXIT — hanya wallet dipantau, kepemilikan turun ≥ 90 % dengan swap dan/atau deposit exchange di batch;
    // teks mengikuti jalur dominan (lihat header).
    const exits = [...sells, ...deposits].sort((x, y) => x.blockTime - y.blockTime);
    if (watched && exits.length && isNum(pos?.qtyBefore) && pos.qtyBefore > 0 && isNum(pos?.qtyAfter)
      && pos.qtyAfter <= (1 - EXIT_DROP) * pos.qtyBefore) {
      const dropQty = pos.qtyBefore - Math.max(0, pos.qtyAfter);
      const dropPct = Math.round((dropQty / pos.qtyBefore) * 100);
      const usd = exits.every((a) => isNum(a.usdValue)) ? exits.reduce((s, a) => s + a.usdValue, 0) : null;
      const { verb, detail, swapShare } = exitWording(sells, deposits, dropQty);
      emit({
        ...base({
          kind: 'WALLET_EXIT', severity: swapShare >= SWAP_HIGH_SHARE ? 'HIGH' : 'MEDIUM', chain, tKey, wallet,
          t: exits[exits.length - 1].blockTime, token,
        }),
        title: `Keluar: ${shortAddress(wallet)} ${verb} ${token.symbol ?? '?'} (${shortAddress(token.address)})`,
        message: `${who} mengurangi kepemilikan ${tl} sebesar ${dropPct}% — ${detail} (nilai swap/deposit ${formatUsd(usd)}).`,
        evidence: evidenceOf(exits),
        ...extra, usd,
        isSimulated: exits.some(simulated),
      });
    }
  }

  // MULTI_WALLET_BUY dari radar.
  for (const r of [...radar].sort((x, y) => cmp(x.tokenKey, y.tokenKey))) {
    if (!(Number.isInteger(r.independentBuyers) && r.independentBuyers >= p.minIndependentBuyers)) continue;
    const buyers = Array.isArray(r.buyers) ? r.buyers : [];
    const lastBuyAt = buyers.reduce((m, b) => Math.max(m, isNum(b.lastBuyAt) ? b.lastBuyAt : -Infinity), -Infinity);
    const t = Number.isFinite(lastBuyAt) ? lastBuyAt : (r.lastActivityAt ?? now);
    const txs = buyers.flatMap((b) => (b.txs ?? []).filter((x) => x.type === 'SWAP_BUY'));
    const usd = isNum(r.grossBuyUsd) ? r.grossBuyUsd : null;
    const tl = tokenLabel(r.chain, r.token);
    emit({
      ...base({ kind: 'MULTI_WALLET_BUY', severity: r.independentBuyers >= p.minIndependentBuyers + 2 ? 'HIGH' : 'MEDIUM', chain: r.chain, tKey: r.tokenKey, wallet: null, t, token: r.token }),
      title: `Beli serentak: ${r.independentBuyers} wallet independen membeli ${r.token?.symbol ?? '?'} (${shortAddress(r.token?.address)})`,
      message: `${r.independentBuyers} pembeli independen (${r.buyerCount} wallet) membeli ${tl} via swap senilai ${formatUsd(usd)}; `
        + `keyakinan ${r.conviction}/100 — ringkasan bukti, bukan probabilitas profit.`,
      evidence: {
        txHashes: txs.map((x) => x.txHash), explorerUrls: txs.map((x) => x.explorerUrl),
        walletUrl: null, tokenUrl: explorerTokenUrl(r.chain, r.token?.address),
      },
      usd, walletScore: null, watchlisted: watchedTokens.has(r.tokenKey), walletWatched: false,
      isSimulated: simulated(r) || txs.some(simulated),
    });
  }

  const alerts = [...out.values()].sort((x, y) => (KIND_ORDER[x.kind] - KIND_ORDER[y.kind]) || cmp(x.dedupeKey, y.dedupeKey));
  return { alerts, skipped };
}

/**
 * Menyaring alert sebelum disimpan / dikirim.
 * @param {object[]} alerts
 * @param {{ existingKeys?: Set<string>, prefs?: Partial<typeof DEFAULT_ALERT_PREFS> }} options
 * @returns {object[]}
 */
export function filterAlerts(alerts, { existingKeys = new Set(), prefs = {} } = {}) {
  if (!Array.isArray(alerts)) throw new TypeError('alerts harus array');
  const p = resolvePrefs(prefs);
  const seen = new Set(existingKeys);
  const out = [];
  for (const a of alerts) {
    if (!a || seen.has(a.dedupeKey)) continue;
    if (!p.kinds.includes(a.kind)) continue;
    const walletWatched = a.wallet !== null && a.walletWatched === true;
    if (p.watchlistOnly && a.watchlisted !== true) continue;
    if (a.kind !== 'WALLET_EXIT') {
      if (isNum(a.usd) ? a.usd < p.minUsd : a.watchlisted !== true) continue;
    }
    if (a.wallet !== null && !walletWatched) {
      if (!(isNum(a.walletScore) && a.walletScore >= p.minWalletScore)) continue;
    }
    seen.add(a.dedupeKey);
    out.push(a);
  }
  return out;
}
