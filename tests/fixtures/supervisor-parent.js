// Proses induk TIRUAN untuk INT-SUP-007: menjalankan worker tiruan lewat supervisor lalu menunggu dibunuh
// (SIGKILL) oleh tes. Mencetak satu baris JSON { workerPid } setelah child berjalan.
import { fileURLToPath } from 'node:url';
import { createWorkerSupervisor } from '../../backend/system/workerSupervisor.js';

const stub = fileURLToPath(new URL('./worker-stub.js', import.meta.url));
let reported = false;
const supervisor = createWorkerSupervisor({
  scriptPath: stub,
  env: { DATABASE_PATH: process.env.DATABASE_PATH, WORKER_STUB_HEARTBEAT: '1' },
  output: (line) => {
    if (reported) return;
    try {
      const entry = JSON.parse(line);
      if (entry.msg === 'worker stub mulai') {
        reported = true;
        process.stdout.write(`${JSON.stringify({ workerPid: entry.pid })}\n`);
      }
    } catch {
      // baris bukan JSON
    }
  },
});
await supervisor.start();
setInterval(() => {}, 1 << 30);
