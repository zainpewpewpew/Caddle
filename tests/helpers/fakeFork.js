// child_process.fork TIRUAN untuk tes supervisor worker: tidak ada proses nyata yang dijalankan.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    /** Sinyal yang dikirim supervisor, berurutan. */
    this.signals = [];
    /** Perilaku kill opsional: (signal) => boolean. */
    this.onKill = null;
  }

  kill(signal = 'SIGTERM') {
    this.signals.push(signal);
    return this.onKill ? this.onKill(signal) : true;
  }

  /** Proses keluar: stream ditutup lalu event 'exit' (urutan seperti Node). */
  exit(code, signal = null) {
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
  }
}

/**
 * @param {{ autoSpawn?: boolean, gracefulExit?: boolean }} [options]
 *   autoSpawn: emit 'spawn' pada microtask berikutnya (default true).
 *   gracefulExit: SIGTERM → exit(0), SIGKILL → exit(null, 'SIGKILL') pada microtask berikutnya (seperti worker/index.js).
 */
export function createFakeFork({ autoSpawn = true, gracefulExit = false } = {}) {
  const calls = [];
  let pid = 40_000;
  const fork = (scriptPath, args, options) => {
    pid += 1;
    const child = new FakeChild(pid);
    calls.push({ scriptPath, args, options, child });
    if (autoSpawn) queueMicrotask(() => child.emit('spawn'));
    if (gracefulExit) {
      child.onKill = (signal) => {
        queueMicrotask(() => (signal === 'SIGKILL' ? child.exit(null, 'SIGKILL') : child.exit(0, null)));
        return true;
      };
    }
    return child;
  };
  fork.calls = calls;
  fork.last = () => calls.at(-1)?.child;
  return fork;
}

/** Timer manual deterministik (pengganti setTimeout/clearTimeout yang diinjeksi). */
export function createManualTimers() {
  const timers = new Map();
  let seq = 0;
  return {
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { fn, ms });
      return seq;
    },
    clearTimer: (id) => { timers.delete(id); },
    /** Durasi timer yang masih tertunda. */
    pending: () => [...timers.values()].map((t) => t.ms),
    /** Jalankan (dan hapus) semua timer dengan durasi `ms`. */
    fire: (ms) => {
      for (const [id, t] of [...timers]) {
        if (t.ms !== ms) continue;
        timers.delete(id);
        t.fn();
      }
    },
  };
}

/** Tunggu microtask & callback I/O tertunda selesai. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));
