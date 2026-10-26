// Baris respons Etherscan / Routescan untuk tes adapter riwayat EVM.
// BENTUK DARI DOKUMENTASI resmi Etherscan (contoh respons account txlist, tokentx, txlistinternal) — BELUM DIREKAM
// LIVE: lingkungan cloud tidak dapat menjangkau API mana pun (docs/14 §0). Nilai (alamat, hash, jumlah) fiktif.
// Tanpa jaringan: `createFakeEtherscan` meniru server kompatibel Etherscan (filter address/startblock/endblock,
// urut naik per blok, potong `offset`).

export const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Alamat EVM huruf kecil dari satu karakter hex berulang. */
export const addr = (c) => `0x${c.repeat(40)}`;
/** Hash tx EVM deterministik dari bilangan ≥ 1. */
export const txHash = (n) => `0x${n.toString(16).padStart(64, '0')}`;

/** Jumlah desimal (string) → satuan dasar (string bilangan bulat). */
export function units(amount, decimals = 18) {
  const [int, frac = ''] = String(amount).split('.');
  const fracUnits = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(int) * 10n ** BigInt(decimals) + BigInt(fracUnits === '' ? '0' : fracUnits)).toString();
}

const seconds = (ms) => String(Math.floor(ms / 1000));

/** Baris tokentx (transfer ERC-20) — tanpa logIndex, seperti contoh dokumentasi. */
export function tokenTxRow({
  block, at, hash, from, to, contract, value, decimals = 18, symbol = 'PEPE', name = 'Pepe',
  methodId = '0x', functionName = '', ...extra
}) {
  return {
    blockNumber: String(block), timeStamp: seconds(at), hash, nonce: '7', blockHash: `0x${'b'.repeat(64)}`,
    from, contractAddress: contract, to, value: String(value), tokenName: name, tokenSymbol: symbol,
    tokenDecimal: String(decimals), transactionIndex: '12', gas: '250000', gasPrice: '21000000000', gasUsed: '180000',
    cumulativeGasUsed: '3500000', input: 'deprecated', methodId, functionName, confirmations: '1200',
    ...extra,
  };
}

/** Baris txlist (transaksi normal). `value` dalam wei (string). */
export function txListRow({
  block, at, hash, from, to, value = '0', isError = '0', receipt = '1', methodId = '0x', functionName = '',
  contractAddress = '', ...extra
}) {
  return {
    blockNumber: String(block), timeStamp: seconds(at), hash, nonce: '8', blockHash: `0x${'c'.repeat(64)}`,
    transactionIndex: '3', from, to, value: String(value), gas: '300000', gasPrice: '21000000000', isError,
    txreceipt_status: receipt, input: methodId === '0x' ? '0x' : `${methodId}${'0'.repeat(64)}`, contractAddress,
    cumulativeGasUsed: '2100000', gasUsed: '160000', confirmations: '1200', methodId, functionName,
    ...extra,
  };
}

/** Baris txlistinternal (transfer native internal). */
export function internalRow({
  block, at, hash, from, to, value, type = 'call', traceId = '0', isError = '0', contractAddress = '', ...extra
}) {
  return {
    blockNumber: String(block), timeStamp: seconds(at), hash, from, to, value: String(value), contractAddress,
    input: '', type, gas: '2300', gasUsed: '0', traceId, isError, errCode: '',
    ...extra,
  };
}

export const ok = (rows) => ({ status: '1', message: 'OK', result: rows });
export const NO_TX = Object.freeze({ status: '0', message: 'No transactions found', result: [] });

/** Respons fetch minimal (bentuk yang dibaca fetchJson). */
export function httpResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/**
 * Server palsu kompatibel Etherscan. `data` = { tokentx, txlist, txlistinternal } (array baris, boleh diubah saat
 * tes berjalan). `respond(url, init)` opsional: kembalikan respons/amplop sendiri, atau undefined untuk perilaku
 * standar. Setiap panggilan dicatat di `calls` ({ url: URL, headers, action, at }).
 */
export function createFakeEtherscan(data = {}, { respond, clock = () => NOW } = {}) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const action = u.searchParams.get('action');
    calls.push({ url: u, headers: init.headers ?? {}, action, at: clock() });
    if (respond) {
      const custom = await respond(u, init);
      if (custom !== undefined) return typeof custom?.text === 'function' ? custom : httpResponse(200, custom);
    }
    const address = (u.searchParams.get('address') ?? '').toLowerCase();
    const start = Number(u.searchParams.get('startblock') ?? 0);
    const end = Number(u.searchParams.get('endblock') ?? Number.MAX_SAFE_INTEGER);
    const offset = Number(u.searchParams.get('offset') ?? 10_000);
    const rows = (data[action] ?? [])
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => [row.from, row.to].some((a) => String(a).toLowerCase() === address)
        && Number(row.blockNumber) >= start && Number(row.blockNumber) <= end)
      .sort((a, b) => Number(a.row.blockNumber) - Number(b.row.blockNumber) || a.i - b.i)
      .slice(0, offset)
      .map(({ row }) => row);
    return httpResponse(200, rows.length > 0 ? ok(rows) : NO_TX);
  }
  return { fetchImpl, calls };
}

/** Jam tetap + tidur instan (tanpa jeda nyata). */
export function frozenTime(start = NOW) {
  let now = start;
  return { clock: () => now, sleep: async () => {}, set: (t) => { now = t; }, advance: (ms) => { now += ms; } };
}

/** Jam palsu yang maju saat `sleep` dipanggil (untuk menguji jarak throttle). */
export function advancingTime(start = NOW) {
  let now = start;
  const slept = [];
  return {
    clock: () => now,
    sleep: async (ms) => { slept.push(ms); now += ms; },
    advance: (ms) => { now += ms; },
    slept,
  };
}
