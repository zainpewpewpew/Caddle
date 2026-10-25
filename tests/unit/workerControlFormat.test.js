import { describe, expect, it } from 'vitest';
import { ApiError } from '../../frontend/js/lib/api.js';
import { workerErrorMessage } from '../../frontend/js/views/workerControl.js';
import { canStartWorker, isWorkerTransitional, workerControlLabel } from '../../frontend/js/views/workerFormat.js';

describe('label kontrol scanner (frontend)', () => {
  it.each([
    [{ state: 'running' }, 'ok', 'Berjalan'],
    [{ state: 'stopped' }, 'idle', 'Berhenti'],
    [{ state: 'starting' }, 'warn', 'Memulai…'],
    [{ state: 'stopping' }, 'warn', 'Menghentikan…'],
    [{ state: 'crashed', exitCode: 1, signal: null }, 'error', 'Gagal (kode keluar 1)'],
    [{ state: 'crashed', exitCode: null, signal: 'SIGKILL' }, 'error', 'Gagal (sinyal SIGKILL)'],
    [{ state: 'crashed', exitCode: null, signal: '<img>' }, 'error', 'Gagal (tanpa kode keluar)'],
    [{ state: 'external' }, 'ok', 'Berjalan di luar website'],
    [{ state: 'lain' }, 'idle', 'Tidak diketahui'],
    [null, 'idle', 'Tidak diketahui'],
  ])('UNIT-WCF-001 %j → %s "%s"', (status, tone, text) => {
    expect(workerControlLabel(status)).toMatchObject({ tone, text });
  });

  it('UNIT-WCF-002 transisi (starting/stopping) dipantau; start hanya bila kontrol aktif dan tidak ada worker berjalan', () => {
    expect(['starting', 'stopping'].every((state) => isWorkerTransitional({ state }))).toBe(true);
    expect(['running', 'stopped', 'crashed', 'external'].some((state) => isWorkerTransitional({ state }))).toBe(false);
    expect(canStartWorker({ enabled: true, state: 'stopped' })).toBe(true);
    expect(canStartWorker({ enabled: true, state: 'crashed' })).toBe(true);
    expect(canStartWorker({ enabled: false, state: 'stopped' })).toBe(false);
    for (const state of ['running', 'starting', 'stopping', 'external']) expect(canStartWorker({ enabled: true, state })).toBe(false);
    expect(canStartWorker(null)).toBe(false);
  });

  it('UNIT-WCF-003 pesan error: pesan server dipakai; CSRF, 403, dan jaringan diberi pesan yang dapat ditindaklanjuti', () => {
    expect(workerErrorMessage(new ApiError(409, { error: 'WORKER_EXTERNAL', message: 'Worker lain sudah berjalan di luar website.' })))
      .toBe('Worker lain sudah berjalan di luar website.');
    expect(workerErrorMessage(new ApiError(403, { error: 'CSRF_INVALID', message: 'Token CSRF tidak valid' }))).toMatch(/Muat ulang halaman/);
    expect(workerErrorMessage(new ApiError(403, { error: 'FORBIDDEN', message: 'Akses ditolak' }))).toMatch(/Hanya admin/);
    expect(workerErrorMessage(new TypeError('Failed to fetch'))).toMatch(/tidak dapat dihubungi/);
  });
});
