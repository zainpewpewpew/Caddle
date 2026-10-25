// Supervisor proses worker scanner. Atas permintaan admin dari website (atau WORKER_AUTOSTART), server
// menjalankan worker/index.js sebagai child process TERPISAH, meneruskan log-nya ke stdout server, dan
// menghentikannya dengan SIGTERM → (batas waktu) → SIGKILL. Scanner tidak pernah berjalan di dalam proses server.
//
// Keamanan: path skrip tetap di kode (WORKER_SCRIPT_PATH); argv selalu kosong; env berasal dari environment
// server, tidak pernah dari request. Hanya satu child per server, dan start ditolak bila heartbeat segar
// menunjukkan worker lain (mis. `npm run worker` di terminal) sudah menulis ke database yang sama.

import { fork as nodeFork } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHeartbeatLive } from './workerStatus.js';

/** Satu-satunya skrip yang dijalankan supervisor di produksi. Tes/E2E menyuntik path lain lewat kode. */
export const WORKER_SCRIPT_PATH = fileURLToPath(new URL('../../worker/index.js', import.meta.url));
/** Batas tunggu graceful shutdown worker sebelum SIGKILL (worker sendiri keluar paksa setelah 10 detik). */
export const STOP_TIMEOUT_MS = 15_000;
/** Batas tunggu event 'spawn' child. */
export const START_TIMEOUT_MS = 10_000;
/** Panjang maksimum satu baris log child yang diteruskan; sisanya dibuang sampai newline berikutnya. */
export const MAX_LINE_LENGTH = 16_384;

export const WORKER_STATES = Object.freeze(['stopped', 'starting', 'running', 'stopping', 'crashed', 'external']);

const ERRORS = Object.freeze({
  WORKER_ALREADY_RUNNING: [409, 'Scanner sudah berjalan.'],
  WORKER_STARTING: [409, 'Scanner sedang dimulai. Tunggu sampai berjalan.'],
  WORKER_STOPPING: [409, 'Scanner sedang dihentikan. Tunggu sampai berhenti.'],
  WORKER_EXTERNAL: [409, 'Worker lain sudah berjalan di luar website (mis. npm run worker di terminal). Hentikan dari terminal tersebut.'],
  WORKER_NOT_RUNNING: [409, 'Scanner tidak sedang berjalan.'],
  WORKER_SHUTTING_DOWN: [503, 'Server sedang berhenti.'],
  WORKER_SPAWN_FAILED: [500, 'Scanner gagal dijalankan. Periksa log server.'],
});

export class WorkerSupervisorError extends Error {
  /** @param {keyof typeof ERRORS} code */
  constructor(code) {
    const [statusCode, message] = ERRORS[code];
    super(message);
    this.name = 'WorkerSupervisorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const TRUNCATED_MARK = ' …[dipotong]';
// Karakter kontrol (kecuali tab) dibuang agar output child tidak dapat menyisipkan escape terminal.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Pemecah stream teks menjadi baris. Baris yang melebihi `maxLength` diteruskan terpotong (+ penanda) dan
 * sisanya dibuang sampai newline berikutnya, sehingga child yang menulis tanpa newline tidak menimbun memori.
 * @param {(line: string) => void} write
 * @param {number} [maxLength]
 */
export function createLineForwarder(write, maxLength = MAX_LINE_LENGTH) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new RangeError('maxLength harus bilangan bulat ≥ 1');
  let buffer = '';
  let dropping = false;
  const emit = (line) => {
    const clean = line.replace(/\r$/, '').replace(CONTROL_CHARS, '');
    if (clean.length > 0) write(clean);
  };
  return {
    /** @param {string|Buffer} chunk */
    push(chunk) {
      let text = String(chunk);
      for (;;) {
        const nl = text.indexOf('\n');
        if (!dropping) {
          buffer += nl === -1 ? text : text.slice(0, nl);
          if (buffer.length > maxLength) {
            emit(buffer.slice(0, maxLength) + TRUNCATED_MARK);
            buffer = '';
            dropping = true;
          }
        }
        if (nl === -1) return;
        if (!dropping) emit(buffer);
        buffer = '';
        dropping = false;
        text = text.slice(nl + 1);
      }
    },
    /** Meneruskan sisa baris tanpa newline (saat stream berakhir). */
    flush() {
      if (!dropping && buffer.length > 0) emit(buffer);
      buffer = '';
      dropping = false;
    },
  };
}

/**
 * @param {{
 *   fork?: typeof import('node:child_process').fork,
 *   scriptPath?: string,
 *   env?: Record<string, string|undefined>,
 *   logger?: { debug: Function, info: Function, warn: Function, error: Function },
 *   clock?: () => number,
 *   stopTimeoutMs?: number,
 *   startTimeoutMs?: number,
 *   readExternalHeartbeat?: () => Promise<null|{ at: number, state: unknown }>,
 *   output?: (line: string) => void,
 *   maxLineLength?: number,
 *   setTimer?: (fn: Function, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void,
 * }} [options]
 *   fork: injeksi untuk tes (default child_process.fork). scriptPath: path ABSOLUT skrip worker — default
 *   WORKER_SCRIPT_PATH; hanya kode (tes/E2E) yang boleh menggantinya, tidak pernah env atau request.
 *   readExternalHeartbeat: heartbeat worker dari database (repos.ingestion) untuk deteksi worker di luar website.
 *   output: tujuan baris stdout/stderr child (default stdout server).
 */
export function createWorkerSupervisor({
  fork = nodeFork,
  scriptPath = WORKER_SCRIPT_PATH,
  env = process.env,
  logger = NOOP_LOGGER,
  clock = Date.now,
  stopTimeoutMs = STOP_TIMEOUT_MS,
  startTimeoutMs = START_TIMEOUT_MS,
  readExternalHeartbeat = async () => null,
  output = (line) => process.stdout.write(`${line}\n`),
  maxLineLength = MAX_LINE_LENGTH,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof fork !== 'function') throw new TypeError('fork wajib berupa fungsi');
  if (typeof scriptPath !== 'string' || !isAbsolute(scriptPath)) throw new TypeError('scriptPath wajib berupa path absolut');
  for (const [name, value] of [['stopTimeoutMs', stopTimeoutMs], ['startTimeoutMs', startTimeoutMs]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} harus bilangan bulat ≥ 1`);
  }
  // Snapshot env saat dibuat: perubahan process.env sesudahnya (atau dari request) tidak mencapai child.
  const childEnv = Object.freeze({ ...env });

  /** @type {'stopped'|'starting'|'running'|'stopping'|'crashed'} */
  let state = 'stopped';
  let child = null;
  let startedAt = null;
  let stoppedAt = null;
  let exitCode = null;
  let exitSignal = null;
  // Waktu child terakhir milik server ini keluar: heartbeat yang ditulis SEBELUM waktu ini berasal dari child
  // tersebut (mis. dibunuh sebelum heartbeat akhir), bukan dari worker lain.
  let lastExitAt = null;
  let startPromise = null;
  let stopPromise = null;
  let stopResolvers = [];
  let stopTimer = null;
  let closed = false;

  const snapshot = () => ({ state, startedAt, stoppedAt, exitCode, signal: exitSignal });

  /** Heartbeat segar dari worker yang BUKAN child server ini, atau null. `strict`: error baca dilempar. */
  async function externalHeartbeat({ strict = false, provided } = {}) {
    let beat;
    try {
      beat = provided === undefined ? await readExternalHeartbeat() : provided;
    } catch (err) {
      if (strict) throw err;
      logger.warn({ err: err?.message }, 'gagal membaca heartbeat worker');
      return null;
    }
    if (!isHeartbeatLive(beat, clock())) return null;
    if (lastExitAt !== null && beat.at <= lastExitAt) return null;
    return beat;
  }

  function pipe(stream) {
    if (!stream) return;
    const forwarder = createLineForwarder(output, maxLineLength);
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => forwarder.push(chunk));
    stream.on('end', () => forwarder.flush());
    stream.on('error', (err) => logger.warn({ err: err?.message }, 'stream log worker error'));
  }

  function finishStop() {
    const resolvers = stopResolvers;
    stopResolvers = [];
    stopPromise = null;
    for (const resolve of resolvers) resolve(snapshot());
  }

  function onExit(proc, code, signal) {
    if (child !== proc) return;
    child = null;
    if (stopTimer !== null) {
      clearTimer(stopTimer);
      stopTimer = null;
    }
    const requested = state === 'stopping';
    stoppedAt = clock();
    lastExitAt = stoppedAt;
    exitCode = typeof code === 'number' ? code : null;
    exitSignal = typeof signal === 'string' ? signal : null;
    // Keluar sendiri dengan kode 0 (mis. Ctrl+C di terminal npm start juga mengirim SIGINT ke child) = berhenti normal.
    state = requested || (exitCode === 0 && exitSignal === null) ? 'stopped' : 'crashed';
    const fields = { workerPid: proc.pid, exitCode, signal: exitSignal };
    if (state === 'crashed') logger.error(fields, 'worker scanner berhenti tak terduga');
    else logger.info(fields, 'worker scanner berhenti');
    finishStop();
  }

  function spawnChild() {
    let proc;
    try {
      // execArgv kosong: flag server (mis. --watch dari `npm run dev`) tidak diwariskan ke worker.
      proc = fork(scriptPath, [], {
        env: { ...childEnv },
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
    } catch (err) {
      state = 'crashed';
      stoppedAt = clock();
      exitCode = null;
      exitSignal = null;
      logger.error({ err: err?.message }, 'gagal menjalankan worker scanner');
      throw new WorkerSupervisorError('WORKER_SPAWN_FAILED');
    }
    child = proc;
    startedAt = null;
    stoppedAt = null;
    exitCode = null;
    exitSignal = null;
    pipe(proc.stdout);
    pipe(proc.stderr);

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        fn(value);
      };
      const timer = setTimer(() => {
        if (settled || child !== proc) return;
        logger.error({ timeoutMs: startTimeoutMs }, 'worker tidak berjalan dalam batas waktu; dihentikan paksa');
        try {
          proc.kill('SIGKILL');
        } catch {
          // proses sudah tidak ada
        }
        onExit(proc, null, 'SIGKILL');
        settle(reject, new WorkerSupervisorError('WORKER_SPAWN_FAILED'));
      }, startTimeoutMs);

      proc.once('spawn', () => {
        if (child !== proc || state !== 'starting') return;
        state = 'running';
        startedAt = clock();
        logger.info({ workerPid: proc.pid }, 'worker scanner dijalankan');
        settle(resolve, snapshot());
      });
      // 'on' (bukan 'once'): event 'error' kedua tanpa listener akan menjatuhkan proses server.
      proc.on('error', (err) => {
        logger.error({ err: err?.message }, 'error proses worker scanner');
        if (child === proc && state === 'starting') {
          onExit(proc, null, null);
          settle(reject, new WorkerSupervisorError('WORKER_SPAWN_FAILED'));
        }
      });
      proc.once('exit', (code, signal) => {
        onExit(proc, code, signal);
        settle(reject, new WorkerSupervisorError('WORKER_SPAWN_FAILED'));
      });
    });
  }

  async function doStart(previous) {
    let external;
    try {
      external = await externalHeartbeat({ strict: true });
    } catch (err) {
      state = previous;
      throw err;
    }
    if (external) {
      state = previous;
      throw new WorkerSupervisorError('WORKER_EXTERNAL');
    }
    if (closed) {
      state = previous;
      throw new WorkerSupervisorError('WORKER_SHUTTING_DOWN');
    }
    return spawnChild();
  }

  const supervisor = {
    /**
     * Status supervisor. Saat tidak ada child, heartbeat segar dari worker lain → state 'external'.
     * @param {{ heartbeat?: null|{ at: number, state: unknown } }} [options] heartbeat yang sudah dibaca pemanggil
     */
    async status({ heartbeat } = {}) {
      if (state === 'stopped' || state === 'crashed') {
        const external = await externalHeartbeat({ provided: heartbeat });
        if (external) return { ...snapshot(), state: 'external' };
      }
      return snapshot();
    },

    /** Menjalankan child. Resolve setelah event 'spawn' (state 'running'). */
    start() {
      if (closed) return Promise.reject(new WorkerSupervisorError('WORKER_SHUTTING_DOWN'));
      if (state === 'starting' || state === 'running') return Promise.reject(new WorkerSupervisorError('WORKER_ALREADY_RUNNING'));
      if (state === 'stopping') return Promise.reject(new WorkerSupervisorError('WORKER_STOPPING'));
      const previous = state;
      // Klaim sinkron sebelum await pertama: start() kedua yang datang bersamaan langsung ditolak (satu instance).
      state = 'starting';
      const promise = doStart(previous).finally(() => {
        if (startPromise === promise) startPromise = null;
      });
      startPromise = promise;
      return promise;
    },

    /**
     * Menghentikan child: SIGTERM, lalu SIGKILL bila belum keluar setelah stopTimeoutMs.
     * @param {{ wait?: boolean }} [options] wait=false → resolve segera setelah SIGTERM dikirim (state 'stopping')
     */
    async stop({ wait = true } = {}) {
      if (state === 'stopping') return wait ? stopPromise : snapshot();
      if (state === 'starting') throw new WorkerSupervisorError('WORKER_STARTING');
      if (state !== 'running') {
        if (await externalHeartbeat()) throw new WorkerSupervisorError('WORKER_EXTERNAL');
        throw new WorkerSupervisorError('WORKER_NOT_RUNNING');
      }
      const proc = child;
      state = 'stopping';
      stopPromise = new Promise((resolve) => { stopResolvers.push(resolve); });
      const done = stopPromise;
      logger.info({ workerPid: proc.pid, timeoutMs: stopTimeoutMs }, 'menghentikan worker scanner (SIGTERM)');
      try {
        proc.kill('SIGTERM');
      } catch (err) {
        logger.warn({ err: err?.message }, 'gagal mengirim SIGTERM ke worker');
      }
      stopTimer = setTimer(() => {
        stopTimer = null;
        if (child !== proc) return;
        logger.warn({ workerPid: proc.pid, timeoutMs: stopTimeoutMs }, 'worker tidak berhenti dalam batas waktu; SIGKILL');
        try {
          proc.kill('SIGKILL');
        } catch (err) {
          logger.error({ err: err?.message }, 'gagal mengirim SIGKILL ke worker');
        }
      }, stopTimeoutMs);
      return wait ? done : snapshot();
    },

    /** Untuk penutupan server: tolak start baru, tunggu start yang berjalan, lalu hentikan child. Idempoten. */
    async shutdown() {
      closed = true;
      if (startPromise) await startPromise.catch(() => {});
      if (state === 'running' || state === 'stopping') await supervisor.stop();
    },

    /**
     * Mengirim sinyal ke child secara SINKRON (untuk handler process 'exit' / keluar paksa server).
     * @param {'SIGTERM'|'SIGKILL'} [signal]
     * @returns {boolean} true bila ada child yang dikirimi sinyal
     */
    killChild(signal = 'SIGKILL') {
      if (!child) return false;
      try {
        child.kill(signal);
        return true;
      } catch {
        return false;
      }
    },
  };
  return supervisor;
}
