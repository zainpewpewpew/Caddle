// Supervisor proses worker scanner. Atas permintaan admin dari website (atau WORKER_AUTOSTART), server
// menjalankan worker/index.js sebagai child process TERPISAH, meneruskan log-nya ke stdout server, dan
// menghentikannya dengan SIGTERM → (batas waktu) → SIGKILL. Scanner tidak pernah berjalan di dalam proses server.
//
// Keamanan: path skrip tetap di kode (WORKER_SCRIPT_PATH); argv selalu kosong; env berasal dari environment
// server, tidak pernah dari request. Hanya satu child per server, dan start ditolak bila heartbeat segar
// menunjukkan worker lain (mis. `npm run worker` di terminal) sudah menulis ke database yang sama.
// Start ulang dibatasi jeda RESTART_COOLDOWN_MS setelah child keluar: tiap proses worker baru memulai limiter
// bobot & status blokir 418/429 Binance dari nol (hanya di memori), jadi restart beruntun tidak boleh membanjiri Binance.
// Start ulang OTOMATIS (opsi autoRestart, aktif di server produksi lewat buildApp): child yang dijalankan supervisor lalu
// keluar tak terduga (crash) dijalankan lagi setelah jeda yang berlipat ganda per crash beruntun (10 dtk → 20 → 40 … maks
// 5 menit; child yang sempat berjalan ≥ 10 menit dianggap stabil sehingga hitungan mulai dari awal). Berhenti normal
// (tombol Hentikan, kode keluar 0) dan penutupan server tidak pernah memicu start ulang otomatis.

import { fork as nodeFork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
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
/** Jeda minimum sejak child yang sempat berjalan keluar (stop maupun crash) sampai start berikutnya diizinkan. */
export const RESTART_COOLDOWN_MS = 10_000;
/** Jeda start ulang otomatis untuk crash pertama; berlipat ganda per crash beruntun sampai AUTO_RESTART_MAX_MS. */
export const AUTO_RESTART_BASE_MS = 10_000;
/** Batas atas jeda start ulang otomatis. */
export const AUTO_RESTART_MAX_MS = 300_000;
/** Child yang berjalan sekurangnya selama ini sebelum crash dianggap stabil: hitungan crash beruntun mulai dari 1 lagi. */
export const AUTO_RESTART_STABLE_MS = 600_000;
/** Cara child dijalankan (snapshot `via`): tombol/API, WORKER_AUTOSTART saat boot, atau start ulang otomatis setelah crash. */
export const START_VIAS = Object.freeze(['manual', 'autostart', 'auto-restart']);

export const WORKER_STATES = Object.freeze(['stopped', 'starting', 'running', 'stopping', 'crashed', 'external']);

const ERRORS = Object.freeze({
  WORKER_ALREADY_RUNNING: [409, 'Scanner sudah berjalan.'],
  WORKER_STARTING: [409, 'Scanner sedang dimulai. Tunggu sampai berjalan.'],
  WORKER_STOPPING: [409, 'Scanner sedang dihentikan. Tunggu sampai berhenti.'],
  WORKER_EXTERNAL: [409, 'Worker lain sudah berjalan di luar website (mis. npm run worker di terminal). Hentikan dari terminal tersebut.'],
  WORKER_NOT_RUNNING: [409, 'Scanner tidak sedang berjalan.'],
  WORKER_COOLDOWN: [429, 'Scanner baru saja berhenti. Tunggu beberapa detik lalu coba lagi.'],
  WORKER_SHUTTING_DOWN: [503, 'Server sedang berhenti.'],
  WORKER_SPAWN_FAILED: [500, 'Scanner gagal dijalankan. Periksa log server.'],
});

export class WorkerSupervisorError extends Error {
  /**
   * @param {keyof typeof ERRORS} code
   * @param {{ retryAfterMs?: number }} [options] retryAfterMs: sisa jeda (WORKER_COOLDOWN), untuk header Retry-After
   */
  constructor(code, { retryAfterMs } = {}) {
    const [statusCode, message] = ERRORS[code];
    super(message);
    this.name = 'WorkerSupervisorError';
    this.code = code;
    this.statusCode = statusCode;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Huruf state proses dari /proc/<pid>/stat (Linux), mis. 'R', 'S', 'Z' (zombie); null bila tidak tersedia
 * (bukan Linux, proses sudah hilang). Nama proses di dalam kurung dapat memuat spasi/kurung, jadi state dibaca
 * setelah ')' terakhir.
 * @param {number} pid bilangan bulat > 0 (sudah divalidasi pemanggil)
 */
function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).charAt(0) || null;
  } catch {
    return null;
  }
}

/**
 * true bila proses dengan `pid` masih hidup di host ini. kill(pid, 0): ESRCH → tidak ada; EPERM → ada (milik
 * pengguna lain); error lain → dianggap ada (aman: worker kedua tidak dijalankan). Di Linux, proses zombie
 * ('Z'/'X' di /proc — sudah keluar tetapi belum di-reap, mis. induknya ikut dibunuh) dianggap mati, karena
 * kill(pid, 0) masih berhasil untuknya. pid ≤ 0 tidak pernah dikirimi sinyal (kill(0)/kill(-n) menyasar grup proses).
 * @param {number} pid
 * @param {{ readState?: (pid: number) => string|null }} [options] readState: injeksi untuk tes (default /proc)
 */
export function isProcessAlive(pid, { readState = procState } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
  const st = readState(pid);
  return st !== 'Z' && st !== 'X';
}

const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const TRUNCATED_MARK = ' …[dipotong]';
// Karakter kontrol dibuang agar output child (yang dapat memuat teks dari Binance, mis. `msg` error HTTP) tidak
// dapat menyisipkan escape terminal: C0 kecuali tab, DEL, dan C1 U+0080–U+009F (CSI U+009B, OSC U+009D, ST U+009C
// dijalankan terminal xterm/VTE dalam UTF-8). Kontrol arah bidi (U+061C, U+200E/F, U+202A–E, U+2066–9) juga dibuang
// agar baris log tidak dapat disamarkan (Trojan Source).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

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
 *   restartCooldownMs?: number,
 *   isPidAlive?: (pid: number) => boolean,
 *   hostname?: string,
 *   setTimer?: (fn: Function, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void,
 *   autoRestart?: boolean,
 *   autoRestartBaseMs?: number,
 *   autoRestartMaxMs?: number,
 *   autoRestartStableMs?: number,
 *   onAutoRestart?: ((e: { outcome: 'success'|'failure', attempt: number, state?: string, reason?: string }) => unknown) | null,
 * }} [options]
 *   fork: injeksi untuk tes (default child_process.fork). scriptPath: path ABSOLUT skrip worker — default
 *   WORKER_SCRIPT_PATH; hanya kode (tes/E2E) yang boleh menggantinya, tidak pernah env atau request.
 *   readExternalHeartbeat: heartbeat worker dari database (repos.ingestion) untuk deteksi worker di luar website.
 *   output: tujuan baris stdout/stderr child (default stdout server).
 *   restartCooldownMs: jeda start ulang (default RESTART_COOLDOWN_MS; 0 = tanpa jeda, hanya untuk tes/E2E).
 *   isPidAlive / hostname: memeriksa `state.owner` heartbeat ({ pid, host } yang ditulis worker/index.js); heartbeat
 *   segar dari pid yang sudah tidak hidup di host ini (worker mati tanpa heartbeat akhir) bukan worker luar.
 *   autoRestart: jalankan ulang child yang crash (default false; buildApp mengaktifkannya). Jeda = autoRestartBaseMs ×
 *   2^(crash beruntun − 1), maks autoRestartMaxMs, dan tidak pernah kurang dari sisa jeda start ulang (restartCooldownMs).
 *   onAutoRestart: dipanggil setelah setiap percobaan start ulang otomatis (buildApp mencatatnya di log audit).
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
  restartCooldownMs = RESTART_COOLDOWN_MS,
  isPidAlive = isProcessAlive,
  hostname = osHostname(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  autoRestart = false,
  autoRestartBaseMs = AUTO_RESTART_BASE_MS,
  autoRestartMaxMs = AUTO_RESTART_MAX_MS,
  autoRestartStableMs = AUTO_RESTART_STABLE_MS,
  onAutoRestart = null,
} = {}) {
  if (typeof fork !== 'function') throw new TypeError('fork wajib berupa fungsi');
  if (typeof scriptPath !== 'string' || !isAbsolute(scriptPath)) throw new TypeError('scriptPath wajib berupa path absolut');
  for (const [name, value] of [['stopTimeoutMs', stopTimeoutMs], ['startTimeoutMs', startTimeoutMs], ['autoRestartBaseMs', autoRestartBaseMs]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} harus bilangan bulat ≥ 1`);
  }
  if (!Number.isSafeInteger(restartCooldownMs) || restartCooldownMs < 0) throw new RangeError('restartCooldownMs harus bilangan bulat ≥ 0');
  if (!Number.isSafeInteger(autoRestartMaxMs) || autoRestartMaxMs < autoRestartBaseMs) throw new RangeError('autoRestartMaxMs harus bilangan bulat ≥ autoRestartBaseMs');
  if (!Number.isSafeInteger(autoRestartStableMs) || autoRestartStableMs < 0) throw new RangeError('autoRestartStableMs harus bilangan bulat ≥ 0');
  if (typeof isPidAlive !== 'function') throw new TypeError('isPidAlive wajib berupa fungsi');
  if (onAutoRestart !== null && typeof onAutoRestart !== 'function') throw new TypeError('onAutoRestart harus fungsi atau null');
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
  // Awal jeda start ulang: waktu keluar child yang sempat berjalan (spawn gagal tidak menghubungi Binance).
  let cooldownFrom = null;
  let startPromise = null;
  let stopPromise = null;
  let stopResolvers = [];
  let stopTimer = null;
  let closed = false;
  // Cara child terakhir dijalankan (START_VIAS) — dicatat saat event 'spawn'; `pendingVia` = permintaan start berjalan.
  let via = null;
  let pendingVia = null;
  // Start ulang otomatis: `keepAlive` aktif sejak child berhasil dijalankan (autoRestart) sampai berhenti normal, tombol
  // Hentikan, atau penutupan server. `crashStreak` = crash beruntun (menentukan jeda); `restartAt` = jadwal berikutnya.
  let keepAlive = false;
  let crashStreak = 0;
  let restartTimer = null;
  let restartAt = null;

  const snapshot = () => ({
    state, startedAt, stoppedAt, exitCode, signal: exitSignal, via, autoRestart: keepAlive, restartAt,
  });

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
    // Heartbeat segar dari worker yang sudah mati (SIGKILL, OOM, terminal ditutup) sebelum heartbeat akhir —
    // misalnya child server sebelumnya, yang tidak dikenali lagi setelah server restart karena lastExitAt hanya
    // di memori. Hanya pid di host yang sama yang dapat diperiksa; selain itu tetap dianggap worker luar (aman).
    const owner = beat.state !== null && typeof beat.state === 'object' ? beat.state.owner : null;
    if (owner && typeof owner === 'object' && owner.host === hostname && Number.isSafeInteger(owner.pid) && owner.pid > 0
      && !isPidAlive(owner.pid)) {
      return null;
    }
    return beat;
  }

  const cooldownRemaining = () => (cooldownFrom === null ? 0 : Math.max(0, cooldownFrom + restartCooldownMs - clock()));

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
    if (startedAt !== null) cooldownFrom = stoppedAt;
    exitCode = typeof code === 'number' ? code : null;
    exitSignal = typeof signal === 'string' ? signal : null;
    // Keluar sendiri dengan kode 0 (mis. Ctrl+C di terminal npm start juga mengirim SIGINT ke child) = berhenti normal.
    state = requested || (exitCode === 0 && exitSignal === null) ? 'stopped' : 'crashed';
    const fields = { workerPid: proc.pid, exitCode, signal: exitSignal };
    if (state === 'crashed') logger.error(fields, 'worker scanner berhenti tak terduga');
    else logger.info(fields, 'worker scanner berhenti');
    if (state === 'crashed') {
      // Child yang sempat berjalan lama dianggap stabil: crash berikutnya kembali memakai jeda terpendek.
      const ranMs = startedAt === null ? 0 : stoppedAt - startedAt;
      crashStreak = ranMs >= autoRestartStableMs ? 1 : crashStreak + 1;
      scheduleAutoRestart();
    } else {
      keepAlive = false;
      crashStreak = 0;
    }
    finishStop();
  }

  // ---------- start ulang otomatis ----------

  function cancelAutoRestart() {
    if (restartTimer !== null) clearTimer(restartTimer);
    restartTimer = null;
    restartAt = null;
  }

  /** Jeda untuk crash beruntun ke-n: base × 2^(n−1), maks autoRestartMaxMs. */
  const backoffMs = () => Math.min(autoRestartMaxMs, autoRestartBaseMs * 2 ** Math.max(0, Math.min(30, crashStreak - 1)));

  /** Menjadwalkan start ulang otomatis (bila aktif). `delayMs` menggantikan jeda backoff; sisa cooldown selalu dihormati. */
  function scheduleAutoRestart(delayMs = backoffMs()) {
    if (!keepAlive || closed) return;
    cancelAutoRestart();
    const ms = Math.max(delayMs, cooldownRemaining());
    restartAt = clock() + ms;
    logger.warn({ inMs: ms, attempt: crashStreak },
      `worker scanner akan dijalankan ulang otomatis dalam ${Math.max(1, Math.round(ms / 1000))} dtk (crash beruntun ke-${crashStreak})`);
    restartTimer = setTimer(() => {
      restartTimer = null;
      restartAt = null;
      autoRestartNow().catch((err) => logger.error({ err: err?.message }, 'start ulang otomatis worker gagal'));
    }, ms);
  }

  async function notifyAutoRestart(event) {
    if (!onAutoRestart) return;
    try {
      await onAutoRestart(event);
    } catch (err) {
      logger.warn({ err: err?.message }, 'gagal mencatat start ulang otomatis worker');
    }
  }

  async function autoRestartNow() {
    // Sudah dijalankan lagi (mis. tombol) atau dihentikan sejak jadwal dibuat: tidak ada yang perlu dilakukan.
    if (!keepAlive || closed || state !== 'crashed') return;
    const attempt = crashStreak;
    try {
      const result = await supervisor.start({ via: 'auto-restart' });
      logger.info({ attempt }, 'worker scanner dijalankan ulang otomatis');
      await notifyAutoRestart({ outcome: 'success', attempt, state: result.state });
    } catch (err) {
      const reason = err instanceof WorkerSupervisorError ? err.code : 'INTERNAL_ERROR';
      logger.warn({ attempt, reason }, 'start ulang otomatis worker ditolak');
      await notifyAutoRestart({ outcome: 'failure', attempt, reason });
      if (reason === 'WORKER_COOLDOWN') scheduleAutoRestart(err.retryAfterMs ?? autoRestartBaseMs);
      // Worker lain (mis. npm run worker) sudah memindai database yang sama: start ulang otomatis dihentikan (tidak
      // mencoba berulang & mengisi audit tiap 5 menit); tombol "Jalankan scanner" tetap tersedia setelah worker itu berhenti.
      else if (reason === 'WORKER_EXTERNAL') {
        keepAlive = false;
        crashStreak = 0;
        logger.info({}, 'worker lain sudah berjalan di luar website — start ulang otomatis dihentikan');
      } else if (reason === 'INTERNAL_ERROR') scheduleAutoRestart(autoRestartMaxMs);
      // Fork gagal sebelum child ada (tanpa event exit): dihitung sebagai crash berikutnya. Child yang sempat dibuat lalu
      // keluar sudah dijadwalkan ulang oleh onExit.
      else if (reason === 'WORKER_SPAWN_FAILED' && state === 'crashed' && restartTimer === null) {
        crashStreak += 1;
        scheduleAutoRestart();
      }
    }
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
        via = pendingVia ?? 'manual';
        keepAlive = autoRestart;
        logger.info({ workerPid: proc.pid, via }, 'worker scanner dijalankan');
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

    /**
     * Menjalankan child. Resolve setelah event 'spawn' (state 'running').
     * @param {{ via?: 'manual'|'autostart'|'auto-restart' }} [options] via: dicatat di snapshot (default 'manual')
     */
    start({ via: requestedVia = 'manual' } = {}) {
      if (closed) return Promise.reject(new WorkerSupervisorError('WORKER_SHUTTING_DOWN'));
      if (state === 'starting' || state === 'running') return Promise.reject(new WorkerSupervisorError('WORKER_ALREADY_RUNNING'));
      if (state === 'stopping') return Promise.reject(new WorkerSupervisorError('WORKER_STOPPING'));
      const wait = cooldownRemaining();
      if (wait > 0) return Promise.reject(new WorkerSupervisorError('WORKER_COOLDOWN', { retryAfterMs: wait }));
      const previous = state;
      // Start yang diminta (tombol / autostart) menggantikan start ulang otomatis yang masih terjadwal.
      cancelAutoRestart();
      pendingVia = START_VIAS.includes(requestedVia) ? requestedVia : 'manual';
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
      // Crash dengan start ulang otomatis terjadwal: "Hentikan" membatalkan jadwal itu (scanner tetap berhenti).
      if (state === 'crashed' && restartTimer !== null) {
        keepAlive = false;
        crashStreak = 0;
        cancelAutoRestart();
        logger.info({}, 'start ulang otomatis worker dibatalkan');
        return snapshot();
      }
      if (state !== 'running') {
        if (await externalHeartbeat()) throw new WorkerSupervisorError('WORKER_EXTERNAL');
        throw new WorkerSupervisorError('WORKER_NOT_RUNNING');
      }
      const proc = child;
      state = 'stopping';
      // Berhenti atas permintaan: tidak dijalankan ulang otomatis.
      keepAlive = false;
      crashStreak = 0;
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
      keepAlive = false;
      cancelAutoRestart();
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
