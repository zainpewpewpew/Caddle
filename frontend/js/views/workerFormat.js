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

// ---- Kontrol scanner dari website (supervisor worker, lihat backend/system/workerSupervisor.js) ----

/** State supervisor yang sedang berpindah: UI memantau tiap 2 detik sampai stabil. */
export const isWorkerTransitional = (status) => status?.state === 'starting' || status?.state === 'stopping';

/** Scanner dapat dijalankan dari website: kontrol aktif dan tidak ada worker yang berjalan. */
export const canStartWorker = (status) => Boolean(status?.enabled) && (status.state === 'stopped' || status.state === 'crashed');

/**
 * Label badge state supervisor.
 * @param {{ state?: string, exitCode?: number|null, signal?: string|null }|null|undefined} status
 * @returns {{ tone: 'ok'|'warn'|'error'|'idle', text: string, live: boolean }}
 */
export function workerControlLabel(status) {
  switch (status?.state) {
    case 'running': return { tone: 'ok', text: 'Berjalan', live: true };
    case 'starting': return { tone: 'warn', text: 'Memulai…', live: false };
    case 'stopping': return { tone: 'warn', text: 'Menghentikan…', live: false };
    case 'stopped': return { tone: 'idle', text: 'Berhenti', live: false };
    case 'external': return { tone: 'ok', text: 'Berjalan di luar website', live: true };
    case 'crashed': {
      const cause = Number.isInteger(status.exitCode) ? `kode keluar ${status.exitCode}`
        : typeof status.signal === 'string' && /^SIG[A-Z0-9]+$/.test(status.signal) ? `sinyal ${status.signal}` : 'tanpa kode keluar';
      return { tone: 'error', text: `Gagal (${cause})`, live: false };
    }
    default: return { tone: 'idle', text: 'Tidak diketahui', live: false };
  }
}

export function workerControlPill(status) {
  const { tone, text, live } = workerControlLabel(status);
  return statusPill(tone, text, { live });
}
