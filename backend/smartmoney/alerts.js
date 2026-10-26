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
//                      dan/atau CEX_DEPOSIT di batch; teks membedakan "dijual" vs "dipindah ke exchange, belum
//                      tentu dijual". Pengurangan lewat transfer biasa tidak memicu alert.
// dedupeKey = `${kind}:${tokenKey}:${wallet|'*'}:${bucket}`, bucket = floor(t / cooldownMs), t = waktu peristiwa
// (blockTime aktivitas pemicu; untuk MULTI_WALLET_BUY pembelian terakhir di radar) sehingga run berulang atas
// peristiwa yang sama dalam satu ember menghasilkan kunci yang sama.
//
// Ekstensi kontrak (aditif, dibutuhkan filterAlerts): `usd` (number|null), `walletScore` (number|null),
// `watchlisted` (wallet atau token ada di watchlist), `walletWatched` (wallet ada di watchlist), `symbol`,
// `evidence.walletUrl`, `evidence.tokenUrl`.
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
});

const REPEAT_MIN_BUYS = 3;
const EXIT_DROP = 0.9;
const COOLDOWN_MIN = 60_000;
const COOLDOWN_MAX = 7 * 24 * 3_600_000;
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

/**
 * Menurunkan alert dari aktivitas baru & radar terkini.
 * @param {{ activities: object[], radar?: object[], watchlist?: { wallets?: Set<string>, tokens?: Set<string> },
 *   walletScores?: Map<string, { score: number, eligible: boolean, flags: object[] }>,
 *   positions?: Map<string, Map<string, { qtyBefore: number, qtyAfter: number }>>, now: number }} input
 * @param {Partial<typeof DEFAULT_ALERT_PREFS>} [prefs]
 * @returns {object[]} Alert[] unik per dedupeKey, terurut (jenis, dedupeKey).
 */
export function deriveAlerts(input, prefs = {}) {
  if (input === null || typeof input !== 'object') throw new TypeError('Input alert harus objek');
  const {
    activities = [], radar = [], watchlist = {}, walletScores = new Map(), positions = new Map(), now,
  } = input;
  if (!Array.isArray(activities)) throw new TypeError('activities harus array');
  if (!Array.isArray(radar)) throw new TypeError('radar harus array');
  if (!Number.isInteger(now)) throw new TypeError('now harus epoch ms bilangan bulat');
  const p = resolvePrefs(prefs);
  const watchedWallets = watchlist.wallets instanceof Set ? watchlist.wallets : new Set();
  const watchedTokens = watchlist.tokens instanceof Set ? watchlist.tokens : new Set();
  const radarByToken = new Map(radar.map((r) => [r.tokenKey, r]));
  const bucket = (t) => Math.floor(t / p.cooldownMs);

  const out = new Map();
  const emit = (alert) => {
    if (!out.has(alert.dedupeKey)) out.set(alert.dedupeKey, alert);
  };
  const base = ({ kind, severity, chain, tKey, wallet, t, token }) => ({
    kind, severity,
    dedupeKey: `${kind}:${tKey}:${wallet ?? '*'}:${bucket(t)}`,
    chain, tokenKey: tKey, wallet: wallet ?? null, symbol: token?.symbol ?? null,
    createdAt: now,
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
      });
    }

    // WALLET_EXIT — hanya wallet dipantau, kepemilikan turun ≥ 90 % lewat swap dan/atau deposit exchange.
    const exits = [...sells, ...deposits].sort((x, y) => x.blockTime - y.blockTime);
    if (watched && exits.length && isNum(pos?.qtyBefore) && pos.qtyBefore > 0 && isNum(pos?.qtyAfter)
      && pos.qtyAfter <= (1 - EXIT_DROP) * pos.qtyBefore) {
      const viaSwap = sells.length > 0;
      const viaCex = deposits.length > 0;
      const dropPct = Math.round((1 - Math.max(0, pos.qtyAfter) / pos.qtyBefore) * 100);
      const usd = exits.every((a) => isNum(a.usdValue)) ? exits.reduce((s, a) => s + a.usdValue, 0) : null;
      let verb; let detail;
      if (viaSwap && !viaCex) { verb = 'menjual'; detail = 'dijual via swap'; }
      else if (viaCex && !viaSwap) { verb = 'memindahkan ke exchange'; detail = 'dipindah ke exchange, belum tentu dijual'; }
      else { verb = 'menjual / memindahkan'; detail = 'sebagian dijual via swap, sebagian dipindah ke exchange (belum tentu dijual)'; }
      emit({
        ...base({ kind: 'WALLET_EXIT', severity: viaSwap ? 'HIGH' : 'MEDIUM', chain, tKey, wallet, t: exits[exits.length - 1].blockTime, token }),
        title: `Keluar: ${shortAddress(wallet)} ${verb} ${token.symbol ?? '?'} (${shortAddress(token.address)})`,
        message: `${who} mengurangi kepemilikan ${tl} sebesar ${dropPct}% — ${detail} (${formatUsd(usd)}).`,
        evidence: evidenceOf(exits),
        ...extra, usd,
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
    });
  }

  return [...out.values()].sort((x, y) => (KIND_ORDER[x.kind] - KIND_ORDER[y.kind]) || cmp(x.dedupeKey, y.dedupeKey));
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
