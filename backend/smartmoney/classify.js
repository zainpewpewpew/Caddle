// Klasifikasi transfer → Activity (kontrak docs/15-kontrak-smart-money.md §1–§2 `classify.js`).
// Fungsi murni: tanpa I/O, tanpa waktu sistem. Prinsip utama: HANYA swap yang menjadi beli/jual. Transfer masuk,
// penarikan exchange, bridge, airdrop, mint, dan LP tidak pernah menjadi SWAP_BUY; deposit ke exchange hanya
// indikasi keluar (CEX_DEPOSIT), bukan SWAP_SELL. Identitas token = chain + alamat kontrak (simbol hanya label).
//
// ─── Langkah ────────────────────────────────────────────────────────────────────────────────────────
// 0. Transfer satu tx di-dedupe ulang per (chain, txHash, logIndex) agar duplikat yang lolos tidak menggandakan
//    jumlah. Transfer wallet ke dirinya sendiri diabaikan (bersih 0).
// 1. Jumlah bersih per token (masuk − keluar) untuk wallet. Bersih ≈ 0 (toleransi relatif 1e-9) diabaikan. Setiap
//    token dengan bersih ≠ 0 disebut "kaki" (leg) dengan arah IN/OUT; satu Activity per kaki
//    (id `chain:txHash:wallet:tokenAddress`). Kaki "mint" = semua transfer masuknya dari ZERO_ADDRESS; kaki "burn" =
//    semua transfer keluarnya ke ZERO_ADDRESS. Mint/burn aset quote (termasuk wrapped native: Deposit/Withdrawal
//    WETH/WBNB/… yang diindeks sebagai mint/burn) TIDAK pernah dianggap LP maupun mint tambahan — itu bungkus/buka
//    koin native.
// 2. LP     LP token teridentifikasi bila kakinya berlabel `lp_token` (bersumber), ATAU `providerCategory === 'lp'`
//           dan kaki itu mint/burn non-quote. Tanpa label & kategori, mint/burn saja BUKAN bukti LP (token poin yang
//           di-mint saat swap, bonding curve yang mint saat beli / burn saat jual) — kecuali pola struktur LP
//           klasik: ≥ 2 kaki keluar + tepat 1 kaki masuk hasil mint (tambah likuiditas dua aset) atau tepat 1 kaki
//           keluar yang di-burn + ≥ 2 kaki masuk (tarik likuiditas) → LP dengan confidence MEDIUM (tafsiran: tanpa
//           pola ini setiap tambah likuiditas V2 tanpa label menjadi SWAP_SELL palsu).
//           LP token masuk + ≥ 1 kaki keluar → LP_ADD untuk token yang dikirim; kebalikannya → LP_REMOVE untuk
//           token yang diterima. Kaki LP token itu sendiri TIDAK dijadikan Activity (catatan pembukuan posisi LP,
//           bukan aset trading; bila dijadikan baris, PnL akan salah membaca LP_ADD arah IN sebagai pengeluaran).
//           `providerCategory === 'lp'` satu sisi: keluar → LP_ADD, masuk → LP_REMOVE.
// 3. Bridge lawan/toContract berlabel `bridge` atau `providerCategory === 'bridge'` → BRIDGE_IN/BRIDGE_OUT.
// 4. Exchange (tx satu arah) kaki yang SEMUA lawannya berlabel `cex`/`cex_deposit`: masuk → CEX_WITHDRAWAL,
//           keluar → CEX_DEPOSIT.
// 5. Klaim tx dua arah dengan metode `*claim*`/`*airdrop*` (tanpa kategori provider swap) — klaim yang memungut
//           biaya/donasi: kaki masuk → AIRDROP, kaki keluar (biaya) → TRANSFER_OUT (BURN bila ke alamat nol);
//           TIDAK PERNAH SWAP_BUY. Diprakarsai alamat lain → UNKNOWN. (Tafsiran: aturan "pengirim kaki masuk = target
//           tx yang tidak berlabel dex" TIDAK dipakai sendirian karena strukturnya identik dengan beli bonding curve
//           dan swap aggregator yang meneruskan token dari router — keduanya harus tetap swap.)
// 6. Swap   tx dua arah (keluar A, masuk B, A ≠ B) tanpa lawan cex, atau `providerCategory === 'swap'`
//           (termasuk bila hanya satu sisi terlihat, mis. ETH native tidak tercatat → confidence LOW).
//           Kaki mint non-quote yang menyertai kaki masuk lain (token poin/hadiah) → MINT; kaki burn non-quote yang
//           menyertai kaki keluar lain (gas token, biaya) → BURN; kaki sisanya diproses sebagai swap. Bila SEMUA kaki
//           masuk hasil mint (bonding curve mint saat beli) atau semua kaki keluar di-burn (burn saat jual), kaki itu
//           adalah sisi swap → SWAP_BUY/SWAP_SELL.
//           Kaki non-quote masuk → SWAP_BUY, keluar → SWAP_SELL. Bila ada kaki non-quote, kaki aset quote (alat
//           bayar: native/wrapped/stablecoin) TIDAK dijadikan baris tersendiri — nilainya tercermin di usdValue &
//           reason; ini mencegah setiap pembelian token tampil sebagai "jual WETH" (alert LARGE_SELL palsu).
//           quote↔quote (mis. USDC → WETH) → SWAP_BUY/SWAP_SELL aset quote (tidak masuk radar).
//           usdValue: kaki stablecoin = jumlah × 1 USD (contracts.STABLECOINS); kaki non-quote yang satu-satunya
//           kaki non-quote di sisinya, dengan sisi lawan seluruhnya aset quote = nilai sisi lawan dikurangi nilai
//           kaki quote lain di sisinya (mis. sisa WETH hasil bungkus ETH; stablecoin 1 USD/unit, native/wrapped memakai
//           usdValue provider bila ada); selain itu usdValue provider; selain itu null. Tidak pernah menebak harga.
// 7. Airdrop (tx hanya masuk) lawan/toContract berlabel `airdrop_distributor`, `providerCategory === 'airdrop'`,
//           atau metode `*claim*`/`*airdrop*` yang diprakarsai wallet sendiri (atau pemrakarsa tidak diketahui →
//           confidence LOW). Metode airdrop yang diprakarsai alamat LAIN tidak cukup (pola umum token spam) →
//           TRANSFER_IN. Mint dari ZERO_ADDRESS → MINT; burn ke ZERO_ADDRESS (tx hanya keluar) → BURN.
// 8. Selain itu TRANSFER_IN / TRANSFER_OUT. Masukan kontradiktif → UNKNOWN (confidence LOW, alasan dijelaskan):
//           tx dua arah dengan lawan cex (tanpa kategori swap), tx dua arah berkategori airdrop/mint atau dengan
//           lawan airdrop_distributor, kategori swap satu sisi dengan lawan cex, LP token masuk dan keluar
//           sekaligus.
//
// Label hanya dipakai bila memiliki `source` (label tanpa sumber dianggap tidak ada — kontrak: label tanpa source
// ditolak). confidence: HIGH = label bersumber / kategori provider konsisten; MEDIUM = heuristik struktur tx;
// LOW = data tidak lengkap (decimals token null, satu sisi swap tidak terlihat, pemrakarsa tidak diketahui).
//
// Ekstensi Activity (aditif): `blockNumber` (number|null, dari transfer tx) dan `logIndex` (logIndex on-chain terkecil
// dari transfer kaki tersebut; null bila hanya ada indeks sintetis ≥ SYNTHETIC_LOG_INDEX_MIN) — dipakai pnl.js untuk
// urutan FIFO di dalam detik yang sama.

import {
  NATIVE_TOKEN, SYNTHETIC_LOG_INDEX_MIN, ZERO_ADDRESS, explorerTxUrl, isQuoteAsset, isStablecoinAsset, normalizeAddress,
} from './contracts.js';
import { groupByTransaction } from './normalize.js';

const CEX_CATEGORIES = new Set(['cex', 'cex_deposit']);
const DEX_CATEGORIES = new Set(['dex_router', 'dex_pool']);
const CLAIM_METHOD_RE = /claim|airdrop/i;
const EPS_REL = 1e-9;
const isNil = (v) => v === null || v === undefined;
const META_FIELDS = ['initiator', 'toContract', 'method', 'providerCategory', 'dex'];

/**
 * true bila token adalah stablecoin USD (1 USD/unit) di chain tersebut — menurut contracts.STABLECOINS (alamat
 * kontrak, bukan simbol).
 */
export function isStablecoin(chain, address) {
  return isStablecoinAsset(chain, address);
}

function fmtQty(q) {
  return String(Number(q.toPrecision(6)));
}

function describeLegs(legs) {
  return legs.map((l) => `${fmtQty(l.amount)} ${l.token.symbol}`).join(' + ');
}

function walletIn(chain, wallet) {
  if (typeof wallet === 'string' && wallet.trim().toLowerCase() === ZERO_ADDRESS) return null;
  const w = normalizeAddress(chain, wallet);
  return w === NATIVE_TOKEN ? null : w;
}

function makeLabelLookup(labels, chain) {
  return (address) => {
    if (!labels || typeof labels.get !== 'function' || !address) return null;
    const l = labels.get(`${chain}:${address}`);
    if (!l || typeof l.source !== 'string' || l.source.trim() === '' || !l.category) return null;
    return l;
  };
}

/** Gabungkan txMeta seluruh transfer tx: nilai non-null pertama per field. */
function mergeTxMeta(transfers) {
  const meta = Object.fromEntries(META_FIELDS.map((f) => [f, null]));
  for (const t of transfers) {
    for (const f of META_FIELDS) {
      if (meta[f] === null && !isNil(t.txMeta?.[f])) meta[f] = t.txMeta[f];
    }
  }
  return meta;
}

/** Bangun kaki per token (jumlah bersih untuk wallet). */
function buildLegs(transfers, wallet) {
  const byToken = new Map();
  for (const t of transfers) {
    const isIn = t.to === wallet;
    const isOut = t.from === wallet;
    if (isIn === isOut) continue; // tidak melibatkan wallet, atau transfer ke diri sendiri
    let acc = byToken.get(t.token.address);
    if (!acc) {
      acc = { token: { ...t.token }, inQty: 0, outQty: 0, ins: [], outs: [] };
      byToken.set(t.token.address, acc);
    }
    if (isNil(acc.token.decimals) && !isNil(t.token.decimals)) acc.token = { ...t.token };
    if (isIn) { acc.inQty += t.amount; acc.ins.push(t); } else { acc.outQty += t.amount; acc.outs.push(t); }
  }
  const legs = [];
  for (const acc of byToken.values()) {
    const net = acc.inQty - acc.outQty;
    if (Math.abs(net) <= EPS_REL * Math.max(acc.inQty, acc.outQty)) continue;
    const direction = net > 0 ? 'IN' : 'OUT';
    const sideTransfers = direction === 'IN' ? acc.ins : acc.outs;
    const sideQty = direction === 'IN' ? acc.inQty : acc.outQty;
    const amount = Math.abs(net);
    const allUsd = sideTransfers.every((t) => t.usdValue !== null && t.usdValue !== undefined);
    const providerUsd = allUsd ? (sideTransfers.reduce((s, t) => s + t.usdValue, 0) / sideQty) * amount : null;
    const counterparties = [...new Set(sideTransfers.map((t) => (direction === 'IN' ? t.from : t.to)))];
    legs.push({ token: acc.token, direction, amount, providerUsd, transfers: sideTransfers, counterparties });
  }
  return legs;
}

/**
 * Klasifikasikan semua transfer SATU transaksi untuk satu wallet.
 * @param {object[]} transfers RawTransfer ternormalisasi dari tx yang sama
 * @param {string} wallet alamat wallet (dinormalisasi di sini)
 * @param {{ labels?: Map<string, object> }} [opts] labels: kunci `chain:address`
 * @returns {object[]} Activity[] (urut alamat token agar deterministik)
 */
export function classifyTransaction(transfers, wallet, { labels } = {}) {
  if (!Array.isArray(transfers) || transfers.length === 0) return [];
  const { chain, txHash } = transfers[0];
  const w = walletIn(chain, wallet);
  if (!w) return [];

  // Langkah 0: dedupe defensif per (chain, txHash, logIndex) dan hanya transfer tx yang sama.
  const seen = new Set();
  const txTransfers = [];
  for (const t of transfers) {
    if (t.chain !== chain || t.txHash !== txHash) continue;
    const key = t.logIndex;
    if (seen.has(key)) continue;
    seen.add(key);
    txTransfers.push(t);
  }

  const legs = buildLegs(txTransfers, w);
  if (legs.length === 0) return [];
  legs.sort((a, b) => (a.token.address < b.token.address ? -1 : a.token.address > b.token.address ? 1 : 0));

  const labelOf = makeLabelLookup(labels, chain);
  const meta = mergeTxMeta(txTransfers);
  const pc = meta.providerCategory;
  const toContractLabel = labelOf(meta.toContract);
  // Loop (bukan Math.min(...arr)) agar aman untuk tx dengan sangat banyak transfer.
  let blockTime = Infinity;
  let blockNumber = null;
  for (const t of txTransfers) {
    if (t.blockTime < blockTime) blockTime = t.blockTime;
    if (blockNumber === null && Number.isInteger(t.blockNumber)) blockNumber = t.blockNumber;
  }
  const explorerUrl = explorerTxUrl(chain, txHash);
  const ins = legs.filter((l) => l.direction === 'IN');
  const outs = legs.filter((l) => l.direction === 'OUT');
  const twoSided = ins.length > 0 && outs.length > 0;

  const cpLabels = (leg) => leg.counterparties.map(labelOf).filter(Boolean);
  const legHasCategory = (leg, cats) => cpLabels(leg).some((l) => cats.has(l.category));
  const anyHasCategory = (cats) => legs.some((l) => legHasCategory(l, cats))
    || (toContractLabel !== null && cats.has(toContractLabel.category));

  const make = (leg, type, { confidence, reason, usdValue = leg.providerUsd }) => {
    const labelled = leg.counterparties.find((a) => labelOf(a));
    const counterparty = labelled ?? leg.counterparties[0] ?? meta.toContract ?? null;
    const lbl = labelOf(counterparty);
    return {
      id: `${chain}:${txHash}:${w}:${leg.token.address}`,
      chain,
      txHash,
      blockTime,
      blockNumber,
      logIndex: legLogIndex(leg),
      wallet: w,
      token: { address: leg.token.address, symbol: leg.token.symbol, name: leg.token.name ?? null, decimals: leg.token.decimals ?? null },
      type,
      direction: leg.direction,
      amount: leg.amount,
      usdValue: usdValue ?? null,
      counterparty,
      counterpartyLabel: lbl ? { label: lbl.label ?? null, category: lbl.category, source: lbl.source } : null,
      confidence: isNil(leg.token.decimals) ? 'LOW' : confidence,
      reason: isNil(leg.token.decimals) ? `${reason} (decimals token tidak diketahui — keyakinan rendah)` : reason,
      provider: leg.transfers[0].provider,
      isSimulated: leg.transfers.some((t) => t.isSimulated === true),
      explorerUrl,
    };
  };
  const unknownAll = (why) => legs.map((leg) => make(leg, 'UNKNOWN', {
    confidence: 'LOW', reason: `Tidak dapat diklasifikasikan: ${why}`,
  }));

  // Mint/burn non-quote: kandidat LP token (dengan label/kategori) atau token tambahan (poin/hadiah, gas token).
  const isQuote = (leg) => isQuoteAsset(chain, leg.token.address);
  const isMint = (leg) => leg.direction === 'IN' && !isQuote(leg) && leg.transfers.every((t) => t.from === ZERO_ADDRESS);
  const isBurn = (leg) => leg.direction === 'OUT' && !isQuote(leg) && leg.transfers.every((t) => t.to === ZERO_ADDRESS);

  // ── 2. LP ──
  const isLpToken = (leg) => labelOf(leg.token.address)?.category === 'lp_token';
  let lpIn = ins.filter((l) => isLpToken(l) || (pc === 'lp' && isMint(l)));
  let lpOut = outs.filter((l) => isLpToken(l) || (pc === 'lp' && isBurn(l)));
  let structural = false;
  if (twoSided && lpIn.length === 0 && lpOut.length === 0) {
    // Pola struktur LP klasik tanpa label/kategori (lihat catatan langkah 2).
    if (ins.length === 1 && isMint(ins[0]) && outs.length >= 2) {
      lpIn = ins;
      structural = true;
    } else if (outs.length === 1 && isBurn(outs[0]) && ins.length >= 2) {
      lpOut = outs;
      structural = true;
    }
  }
  if (twoSided && lpIn.length > 0 && lpOut.length > 0) {
    return unknownAll('LP token terlihat masuk dan keluar sekaligus dalam satu tx (kontradiktif)');
  }
  if (twoSided && (lpIn.length > 0 || lpOut.length > 0)) {
    const adding = lpIn.length > 0;
    const lpLegs = adding ? lpIn : lpOut;
    const sourced = !structural && (pc === 'lp' || lpLegs.some(isLpToken));
    const lpDesc = lpLegs.map((l) => l.token.symbol).join(', ');
    const targets = adding ? outs : ins;
    let how = '';
    if (structural) {
      how = adding
        ? ' (pola dua aset masuk pool + satu token di-mint, tanpa label)'
        : ' (pola satu token di-burn + dua aset diterima, tanpa label)';
    }
    return targets.map((leg) => make(leg, adding ? 'LP_ADD' : 'LP_REMOVE', {
      confidence: sourced ? 'HIGH' : 'MEDIUM',
      reason: adding
        ? `Tambah likuiditas${how}: wallet mengirim ${describeLegs(outs)} ke pool dan menerima LP token ${lpDesc} — bukan pembelian/penjualan`
        : `Tarik likuiditas${how}: wallet mengembalikan LP token ${lpDesc} dan menerima ${describeLegs(ins)} — bukan pembelian/penjualan`,
    }));
  }
  if (twoSided && pc === 'lp') {
    return unknownAll('kategori provider "lp", tetapi LP token tidak teridentifikasi (tanpa label lp_token / mint / burn non-quote)');
  }
  if (!twoSided && pc === 'lp') {
    return legs.map((leg) => make(leg, leg.direction === 'OUT' ? 'LP_ADD' : 'LP_REMOVE', {
      confidence: 'HIGH',
      reason: leg.direction === 'OUT'
        ? `Tambah likuiditas menurut kategori provider: wallet mengirim ${describeLegs([leg])} — bukan penjualan`
        : `Tarik likuiditas menurut kategori provider: wallet menerima ${describeLegs([leg])} — bukan pembelian`,
    }));
  }

  // ── 3. Bridge ──
  const bridgeCats = new Set(['bridge']);
  if (pc === 'bridge' || anyHasCategory(bridgeCats)) {
    const byLabel = anyHasCategory(bridgeCats);
    return legs.map((leg) => make(leg, leg.direction === 'IN' ? 'BRIDGE_IN' : 'BRIDGE_OUT', {
      confidence: 'HIGH',
      reason: `${leg.direction === 'IN' ? 'Bridge masuk' : 'Bridge keluar'}: ${describeLegs([leg])} `
        + `${byLabel ? 'melalui alamat berlabel bridge' : 'menurut kategori provider'} — bukan pembelian/penjualan`,
    }));
  }

  const method = meta.method ?? '';
  const claimMethod = CLAIM_METHOD_RE.test(method);
  const selfInitiated = meta.initiator === w;
  const otherInitiated = meta.initiator !== null && meta.initiator !== w;

  // ── 4/5/6. Tx dua arah: exchange kontradiktif, klaim berbayar, atau swap ──
  if (twoSided) {
    if (pc !== 'swap' && anyHasCategory(CEX_CATEGORIES)) {
      return unknownAll('wallet mengirim dan menerima token dalam tx yang sama dengan lawan berlabel exchange');
    }
    if (pc === 'airdrop' || pc === 'mint') {
      return unknownAll(`kategori provider "${pc}" bertentangan dengan struktur tx (ada token keluar dan masuk)`);
    }
    if (pc !== 'swap' && anyHasCategory(new Set(['airdrop_distributor']))) {
      return unknownAll('ada token keluar dan masuk dengan lawan berlabel distributor airdrop');
    }
    if (pc !== 'swap' && claimMethod) {
      if (otherInitiated) {
        return unknownAll(`metode klaim "${method}" dengan token keluar dan masuk, tetapi tx diprakarsai alamat lain`);
      }
      const fee = describeLegs(outs);
      return legs.map((leg) => {
        if (leg.direction === 'IN') {
          return make(leg, 'AIRDROP', {
            confidence: selfInitiated ? 'MEDIUM' : 'LOW',
            reason: `Klaim/airdrop berbayar: metode "${method}" ${selfInitiated ? 'dipanggil wallet sendiri' : '(pemrakarsa tx tidak diketahui)'}, `
              + `wallet membayar ${fee} dan menerima ${describeLegs([leg])} — bukan pembelian swap`,
          });
        }
        return make(leg, isBurn(leg) ? 'BURN' : 'TRANSFER_OUT', {
          confidence: 'MEDIUM',
          reason: `Biaya klaim: wallet mengirim ${describeLegs([leg])} dalam tx klaim "${method}" — bukan penjualan`,
        });
      });
    }
    return classifySwapWithExtras({ chain, legs, ins, outs, pc, make, isMint, isBurn, sourcedDex: anyHasCategory(DEX_CATEGORIES) });
  }

  // ── Tx satu arah ──
  if (pc === 'swap') {
    if (anyHasCategory(CEX_CATEGORIES)) {
      return unknownAll('kategori provider "swap" bertentangan dengan lawan berlabel exchange');
    }
    return classifySwap({ chain, legs, ins, outs, pc, make, sourcedDex: anyHasCategory(DEX_CATEGORIES), oneSided: true });
  }

  const airdropByLabel = anyHasCategory(new Set(['airdrop_distributor']));

  return legs.map((leg) => {
    const cpls = cpLabels(leg);
    const allCex = leg.counterparties.length > 0
      && leg.counterparties.every((a) => CEX_CATEGORIES.has(labelOf(a)?.category));
    if (allCex) {
      const name = cpls.find((l) => CEX_CATEGORIES.has(l.category))?.label ?? 'exchange';
      return leg.direction === 'IN'
        ? make(leg, 'CEX_WITHDRAWAL', {
          confidence: 'HIGH',
          reason: `Penarikan dari exchange (${name}): wallet menerima ${describeLegs([leg])} — bukan pembelian on-chain`,
        })
        : make(leg, 'CEX_DEPOSIT', {
          confidence: 'HIGH',
          reason: `Deposit ke exchange (${name}): wallet mengirim ${describeLegs([leg])} — indikasi keluar, belum tentu dijual`,
        });
    }
    if (leg.direction === 'IN') {
      if (airdropByLabel || pc === 'airdrop') {
        return make(leg, 'AIRDROP', {
          confidence: 'HIGH',
          reason: `Airdrop: wallet menerima ${describeLegs([leg])} ${airdropByLabel ? 'dari alamat berlabel distributor airdrop' : 'menurut kategori provider'} tanpa token keluar — bukan pembelian`,
        });
      }
      if (claimMethod && !otherInitiated) {
        return make(leg, 'AIRDROP', {
          confidence: selfInitiated ? 'MEDIUM' : 'LOW',
          reason: `Airdrop/klaim: metode "${method}" ${selfInitiated ? 'dipanggil wallet sendiri' : '(pemrakarsa tx tidak diketahui)'}, wallet menerima ${describeLegs([leg])} tanpa token keluar — bukan pembelian`,
        });
      }
      if (leg.transfers.every((t) => t.from === ZERO_ADDRESS)) {
        return make(leg, 'MINT', {
          confidence: pc === 'mint' ? 'HIGH' : 'MEDIUM',
          reason: `Mint: wallet menerima ${describeLegs([leg])} dari alamat nol tanpa token keluar — bukan pembelian`,
        });
      }
      const spamHint = otherInitiated ? '; tx diprakarsai alamat lain (bisa token kiriman/spam)' : '';
      return make(leg, 'TRANSFER_IN', {
        confidence: pc === 'transfer' ? 'HIGH' : 'MEDIUM',
        reason: `Transfer masuk: wallet menerima ${describeLegs([leg])} tanpa token keluar dalam tx yang sama${spamHint} — bukan pembelian`,
      });
    }
    if (leg.transfers.every((t) => t.to === ZERO_ADDRESS)) {
      return make(leg, 'BURN', {
        confidence: 'MEDIUM',
        reason: `Burn: wallet mengirim ${describeLegs([leg])} ke alamat nol tanpa token masuk — bukan penjualan`,
      });
    }
    return make(leg, 'TRANSFER_OUT', {
      confidence: pc === 'transfer' ? 'HIGH' : 'MEDIUM',
      reason: `Transfer keluar: wallet mengirim ${describeLegs([leg])} tanpa token masuk dalam tx yang sama — bukan penjualan`,
    });
  });
}

/** logIndex on-chain terkecil dari transfer kaki; null bila tidak ada logIndex asli (hanya sintetis). */
function legLogIndex(leg) {
  let min = null;
  for (const t of leg.transfers) {
    const li = t.logIndex;
    if (Number.isInteger(li) && li >= 0 && li < SYNTHETIC_LOG_INDEX_MIN && (min === null || li < min)) min = li;
  }
  return min;
}

/** Nilai USD sebuah kaki aset quote: stablecoin = 1 USD/unit, native/wrapped = usdValue provider atau null. */
function quoteLegUsd(chain, leg) {
  if (isStablecoin(chain, leg.token.address)) return leg.amount;
  return leg.providerUsd;
}

/**
 * Swap dua arah dengan kaki mint/burn tambahan (langkah 6): mint non-quote yang menyertai kaki masuk lain → MINT,
 * burn non-quote yang menyertai kaki keluar lain → BURN, sisanya classifySwap. Urutan keluaran = urutan kaki.
 */
function classifySwapWithExtras({ chain, legs, ins, outs, pc, make, isMint, isBurn, sourcedDex }) {
  const extraMints = ins.some((l) => !isMint(l)) ? ins.filter(isMint) : [];
  const extraBurns = outs.some((l) => !isBurn(l)) ? outs.filter(isBurn) : [];
  if (extraMints.length === 0 && extraBurns.length === 0) {
    return classifySwap({ chain, legs, ins, outs, pc, make, sourcedDex, oneSided: false });
  }
  const extras = new Set([...extraMints, ...extraBurns]);
  const swapActs = classifySwap({
    chain,
    legs: legs.filter((l) => !extras.has(l)),
    ins: ins.filter((l) => !extras.has(l)),
    outs: outs.filter((l) => !extras.has(l)),
    pc, make, sourcedDex, oneSided: false,
  });
  const actOf = new Map(swapActs.map((a) => [a.token.address, a]));
  const out = [];
  for (const leg of legs) {
    if (extraMints.includes(leg)) {
      out.push(make(leg, 'MINT', {
        confidence: 'MEDIUM',
        reason: `Mint tambahan: wallet menerima ${describeLegs([leg])} dari alamat nol bersama swap (token poin/hadiah) — bukan pembelian`,
      }));
    } else if (extraBurns.includes(leg)) {
      out.push(make(leg, 'BURN', {
        confidence: 'MEDIUM',
        reason: `Burn tambahan: wallet mengirim ${describeLegs([leg])} ke alamat nol bersama swap — bukan penjualan`,
      }));
    } else if (actOf.has(leg.token.address)) {
      out.push(actOf.get(leg.token.address));
    }
  }
  return out;
}

function classifySwap({ chain, legs, ins, outs, pc, make, sourcedDex, oneSided }) {
  const isQuote = (l) => isQuoteAsset(chain, l.token.address);
  const nonQuote = legs.filter((l) => !isQuote(l));
  const quoteOnly = nonQuote.length === 0;
  const targets = quoteOnly ? legs : nonQuote;
  const sideValue = (side) => {
    let sum = 0;
    for (const l of side) {
      const v = quoteLegUsd(chain, l);
      if (v === null) return null;
      sum += v;
    }
    return sum;
  };
  const legUsd = (leg) => {
    if (isStablecoin(chain, leg.token.address)) return leg.amount;
    const same = leg.direction === 'IN' ? ins : outs;
    const opposite = leg.direction === 'IN' ? outs : ins;
    const sameOthers = same.filter((l) => l !== leg);
    if (opposite.length > 0 && opposite.every(isQuote) && sameOthers.every(isQuote)) {
      const v = sideValue(opposite);
      const others = sideValue(sameOthers);
      if (v !== null && others !== null && v - others > 0) return v - others;
    }
    return leg.providerUsd;
  };
  const confidence = oneSided ? 'LOW' : (pc === 'swap' || sourcedDex ? 'HIGH' : 'MEDIUM');
  const basis = oneSided
    ? `kategori provider "swap", namun hanya satu sisi swap yang terlihat (${describeLegs(legs)} ${ins.length ? 'masuk' : 'keluar'})`
    : `wallet mengirim ${describeLegs(outs)} dan menerima ${describeLegs(ins)} dalam tx yang sama`;
  let kind = 'Swap';
  if (quoteOnly) kind = 'Swap antar aset quote (tidak masuk radar)';
  else if (!oneSided && !legs.some(isQuote)) kind = 'Swap token-ke-token';
  return targets.map((leg) => make(leg, leg.direction === 'IN' ? 'SWAP_BUY' : 'SWAP_SELL', {
    confidence,
    usdValue: legUsd(leg),
    reason: `${kind}: ${basis}${leg.direction === 'IN' ? ` → beli ${leg.token.symbol}` : ` → jual ${leg.token.symbol}`}`,
  }));
}

/**
 * Kelompokkan transfer wallet per tx lalu klasifikasikan.
 * @param {object[]} transfers RawTransfer ternormalisasi (boleh lintas tx)
 * @param {string} wallet
 * @param {{ labels?: Map<string, object> }} [opts]
 * @returns {object[]} Activity[] terurut blockTime lalu id
 */
export function classifyWalletTransfers(transfers, wallet, { labels } = {}) {
  const out = [];
  for (const group of groupByTransaction(transfers ?? []).values()) {
    for (const a of classifyTransaction(group, wallet, { labels })) out.push(a);
  }
  return out.sort((a, b) => a.blockTime - b.blockTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
