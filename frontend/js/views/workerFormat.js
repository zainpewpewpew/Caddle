// Label status worker & koneksi Binance (dari heartbeat di database, lihat backend/system/workerStatus.js).
import { statusPill } from '../lib/components.js';

const SCANNER = {
  ok: ['ok', 'Berjalan', true],
  starting: ['warn', 'Memulai'],
  degraded: ['warn', 'Terdegradasi'],
  stopping: ['warn', 'Berhenti…'],
  stopped: ['idle', 'Berhenti'],
  stale: ['error', 'Heartbeat basi'],
  not_running: ['idle', 'Belum berjalan'],
};

const BINANCE = {
  ok: ['ok', 'Terhubung', true],
  connecting: ['warn', 'Menghubungkan'],
  reconnecting: ['warn', 'Menyambung ulang'],
  idle: ['idle', 'Belum terhubung'],
  stopped: ['idle', 'Terputus'],
  unknown: ['idle', 'Tidak diketahui'],
};

function pill(table, status) {
  const [state, label, live] = table[status] ?? ['idle', 'Tidak diketahui'];
  return statusPill(state, label, { live: Boolean(live) });
}

export const scannerPill = (scanner) => pill(SCANNER, scanner?.status);
export const binancePill = (binance) => pill(BINANCE, binance?.status);
