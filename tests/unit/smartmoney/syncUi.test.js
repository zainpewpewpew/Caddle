// Tombol "Sync sekarang" Smart Money Radar: helper murni (smartMoneyFormat.js — fase, progres, status, ringkasan hasil,
// pesan error) dan komponen syncControl (smartMoneySync.js) dengan DOM tiruan (helpers/fakeDom.js) + timer tiruan:
// GET status saat dibuat, POST + polling 1,5 detik, hasil, keadaan nonaktif, hitung mundur, dan pemuatan ulang radar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCLAIMERS } from '../../../backend/smartmoney/contracts.js';
import { ApiError, setCsrfToken } from '../../../frontend/js/lib/api.js';
import {
  SYNC_DEFAULT_INTERVAL_MINUTES, SYNC_NOT_ADMIN, SYNC_NO_PROVIDERS_HELP, SYNC_NO_WALLETS_HINT, SYNC_PHASES, isSyncResultOf,
  syncAutoHint, syncCooldownText, syncErrorText, syncPhaseLabel, syncProgressParts, syncProgressRatio, syncProgressText,
  syncResultLines, syncRunnerLabel, syncStatusLabel,
} from '../../../frontend/js/views/smartMoneyFormat.js';
import { smartMoneyView } from '../../../frontend/js/views/smartMoneyRadar.js';
import { SYNC_PATH, SYNC_POLL_MS, syncControl } from '../../../frontend/js/views/smartMoneySync.js';
import { installFakeDom } from './helpers/fakeDom.js';

const NOW = Date.UTC(2026, 9, 26, 9, 0);
const NO_WALLETS_TEXT = 'Belum ada wallet yang dilacak — penemuan otomatis (cukup ETHERSCAN_API_KEY, kunci Binance tidak wajib) belum menemukan kandidat; lihat catatan run, jalankan npm run smart-money:check, atau ikuti wallet lewat Watchlist & Alerts.';
const NO_RESULT_TEXT = 'Sinkronisasi selesai, tetapi ringkasannya belum tersedia — muat ulang halaman atau lihat log server';

/** Ringkasan run (`lastRun`) berbentuk kontrak GET /api/smart-money/sync. */
const summary = (over = {}) => ({
  status: 'OK', trigger: 'manual', startedAt: NOW - 60_000, finishedAt: NOW - 20_000,
  fetched: 1234, inserted: 120, reclassified: 2, duplicates: 7, rejected: 1, collisions: 0, alerts: 3, scored: 50,
  alertsSkipped: { stale: 0, cooldown: 1 },
  wallets: { tracked: 50, selected: 50, synced: 48, failed: 2, deferred: 1, skippedNoProvider: 3 },
  discovery: { candidates: 30, added: 8 }, mapping: { upserted: 12, rejected: 1 },
  notes: [], errors: [],
  ...over,
});

// Run terakhir yang sudah lama (putaran terjadwal 1 jam lalu).
const OLD = summary({
  status: 'OK', trigger: 'schedule', startedAt: NOW - 3_600_000, finishedAt: NOW - 3_540_000, fetched: 10, inserted: 2, alerts: 0,
  wallets: { tracked: 5, selected: 5, synced: 5, failed: 0, deferred: 0, skippedNoProvider: 0 },
  discovery: { candidates: 0, added: 0 }, mapping: { upserted: 0, rejected: 0 },
});
// Run manual yang dimulai tepat saat tombol diklik (respons 202).
const RUN0 = { owner: 'server', trigger: 'manual', phase: 'start', startedAt: NOW, updatedAt: NOW, done: 0, total: 0 };
// Ringkasan run manual itu: 5 catatan & 4 error (UI menampilkan 3 + "+N … lain").
const FRESH = summary({
  status: 'DEGRADED', trigger: 'manual', startedAt: NOW, finishedAt: NOW + 2_500,
  notes: ['Catatan 1', 'Catatan 2', 'Catatan 3', 'Catatan 4', 'Catatan 5'],
  errors: [
    { provider: 'etherscan', code: 'RATE_LIMIT', method: 'txlist', chain: 'ethereum', message: 'Max rate limit reached' },
    { provider: 'etherscan', code: 'TIMEOUT', method: 'tokentx', chain: 'base', message: 'Permintaan habis waktu' },
    { provider: 'binance', code: 'HTTP_451', method: 'exchangeInfo', chain: null, message: 'Wilayah dibatasi' },
    { provider: 'etherscan', code: 'INVALID', method: 'txlist', chain: 'ethereum', message: 'Respons tidak valid' },
  ],
});

const statusBody = (over = {}) => ({
  running: false, run: null, lastRun: null, canTrigger: true, reason: null, cooldownUntil: null, providersConfigured: 1, intervalMinutes: 15,
  ...over,
});

const text = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : null);

describe('Sync UI — helper murni', () => {
  it('UNIT-SM-SYNCUI-001 label fase Bahasa Indonesia; fase baru tampil apa adanya; tanpa fase → "Sinkronisasi"', () => {
    expect(SYNC_PHASES).toEqual(['start', 'mapping', 'discovery', 'transfers', 'analysis', 'alerts']);
    expect(SYNC_PHASES.map(syncPhaseLabel)).toEqual([
      'Menyiapkan', 'Pemetaan kontrak Binance', 'Penemuan wallet', 'Riwayat transaksi wallet', 'Menghitung skor & radar', 'Menyusun alert',
    ]);
    expect(syncPhaseLabel('price_refresh')).toBe('price refresh');
    expect(syncPhaseLabel('constructor')).toBe('constructor'); // bukan properti prototipe
    for (const v of [undefined, null, '', 42]) expect(syncPhaseLabel(v)).toBe('Sinkronisasi');
  });

  it('UNIT-SM-SYNCUI-002 siapa yang menjalankan: manual vs terjadwal (worker scanner); trigger didahulukan dari owner', () => {
    expect(syncRunnerLabel({ owner: 'server', trigger: 'manual' })).toBe('manual');
    expect(syncRunnerLabel({ owner: 'worker', trigger: 'schedule' })).toBe('terjadwal (worker scanner)');
    expect(syncRunnerLabel({ owner: 'server', trigger: 'schedule' })).toBe('terjadwal');
    expect(syncRunnerLabel({ owner: 'worker', trigger: 'manual' })).toBe('manual');
    expect(syncRunnerLabel({ owner: 'worker' })).toBe('terjadwal (worker scanner)');
    expect(syncRunnerLabel({ owner: 'server' })).toBe('manual');
    expect(syncRunnerLabel({ trigger: 'schedule' })).toBe('terjadwal (worker scanner)');
    for (const v of [null, undefined, {}, { owner: 'cron', trigger: 'webhook' }]) expect(syncRunnerLabel(v)).toBeNull();
  });

  it('UNIT-SM-SYNCUI-003 progres: rasio done/total (null bila tidak diketahui) dan teks fase · x/y · lama berjalan · pelaksana', () => {
    expect(syncProgressRatio({ done: 12, total: 50 })).toBe(0.24);
    expect(syncProgressRatio({ done: 60, total: 50 })).toBe(1);
    expect(syncProgressRatio({ done: -3, total: 50 })).toBe(0);
    for (const r of [{ done: 0, total: 0 }, { done: 1 }, { done: '1', total: 2 }, null, undefined]) expect(syncProgressRatio(r)).toBeNull();

    const run = { owner: 'worker', trigger: 'schedule', phase: 'transfers', done: 12, total: 50, startedAt: NOW - 80_000 };
    expect(syncProgressText(run, NOW)).toBe('Riwayat transaksi wallet · 12/50 wallet · berjalan 1 mnt 20 dtk · terjadwal (worker scanner)');
    expect(syncProgressParts({ owner: 'server', trigger: 'manual', phase: 'mapping', done: 2, total: 10, startedAt: NOW - 5_000 }, NOW))
      .toEqual({ phase: 'Pemetaan kontrak Binance', count: '2/10', elapsed: 'berjalan 5 dtk', runner: 'manual' });
    // Angka besar berformat id-ID; satuan "wallet" hanya pada fase riwayat transaksi.
    expect(syncProgressText({ phase: 'transfers', done: 1234, total: 5000, startedAt: NOW - 3_700_000 }, NOW))
      .toBe('Riwayat transaksi wallet · 1.234/5.000 wallet · berjalan 1 jam 1 mnt');
    // Total belum diketahui → tanpa x/y (bar indeterminate); tanpa startedAt atau now → tanpa lama berjalan.
    expect(syncProgressText({ phase: 'discovery', done: 0, total: 0 }, NOW)).toBe('Penemuan wallet');
    expect(syncProgressText({ phase: 'alerts', startedAt: NOW })).toBe('Menyusun alert');
    // Jam server sedikit di depan → tidak pernah negatif.
    expect(syncProgressText({ startedAt: NOW + 5_000 }, NOW)).toBe('Sinkronisasi · berjalan 0 dtk');
    expect(syncProgressText(null, NOW)).toBe('Sinkronisasi');
  });

  it('UNIT-SM-SYNCUI-004 status run terakhir → badge: OK/DEGRADED/NO_PROVIDERS/ABORTED/FAILED; status baru apa adanya', () => {
    expect(syncStatusLabel('OK')).toEqual({ label: 'Berhasil', tone: 'bull' });
    expect(syncStatusLabel('DEGRADED')).toEqual({ label: 'Selesai dengan catatan', tone: 'warn' });
    expect(syncStatusLabel('NO_PROVIDERS')).toEqual({ label: 'Belum ada sumber data', tone: 'warn' });
    expect(syncStatusLabel('ABORTED')).toEqual({ label: 'Dihentikan', tone: 'warn' });
    expect(syncStatusLabel('FAILED')).toEqual({ label: 'Gagal', tone: 'bear' });
    expect(syncStatusLabel('PARTIAL')).toEqual({ label: 'PARTIAL', tone: undefined });
    expect(syncStatusLabel('hasOwnProperty')).toEqual({ label: 'hasOwnProperty', tone: undefined });
    for (const v of [null, undefined, '', 7]) expect(syncStatusLabel(v)).toEqual({ label: '—', tone: undefined });
    // Keadaan kosong radar (E2E) memakai "Belum ada sumber data on-chain": teks sinkron tidak boleh ikut cocok.
    for (const t of [syncStatusLabel('NO_PROVIDERS').label, SYNC_NO_PROVIDERS_HELP]) expect(t).not.toContain('sumber data on-chain');
  });

  it('UNIT-SM-SYNCUI-005 ringkasan angka run: baris pendek id-ID, angka yang tidak ada dilewati, NO_PROVIDERS tanpa baris', () => {
    expect(syncResultLines(summary())).toEqual([
      'Wallet: 48 tersinkron dari 50 dipilih (2 gagal, 1 ditunda, 3 tanpa provider)',
      'Transfer: 1.234 diambil · 120 aktivitas baru',
      'Penemuan wallet: 8 wallet baru dari 30 kandidat',
      'Pemetaan Binance: 12 kontrak diperbarui (1 ditolak)',
      'Alert baru: 3',
    ]);
    // Nol pada rincian tambahan tidak ditulis; nol pada angka utama tetap jujur ditampilkan.
    expect(syncResultLines(summary({
      fetched: 0, inserted: 0, alerts: 0, wallets: { tracked: 5, selected: 5, synced: 5, failed: 0, deferred: 0, skippedNoProvider: 0 },
      discovery: { candidates: 0, added: 0 }, mapping: { upserted: 0, rejected: 0 },
    }))).toEqual([
      'Wallet: 5 tersinkron dari 5 dipilih', 'Transfer: 0 diambil · 0 aktivitas baru', 'Penemuan wallet: 0 wallet baru',
      'Pemetaan Binance: 0 kontrak diperbarui', 'Alert baru: 0',
    ]);
    expect(syncResultLines({ status: 'DEGRADED', inserted: 4 })).toEqual(['Transfer: 4 aktivitas baru']);
    expect(syncResultLines({ wallets: { synced: 3 } })).toEqual(['Wallet: 3 tersinkron']);
    expect(syncResultLines({ fetched: '5', alerts: null, wallets: 'x', discovery: [], mapping: null })).toEqual([]);
    expect(syncResultLines(summary({ status: 'NO_PROVIDERS' }))).toEqual([]);
    for (const v of [null, undefined, 'OK']) expect(syncResultLines(v)).toEqual([]);
  });

  it('UNIT-SM-SYNCUI-006 tanpa wallet yang dilacak (wallets.tracked === 0) → petunjuk penemuan otomatis (kunci Binance tidak wajib) / Watchlist & Alerts', () => {
    expect(SYNC_NO_WALLETS_HINT).toBe(NO_WALLETS_TEXT);
    const zero = { tracked: 0, selected: 0, synced: 0, failed: 0, deferred: 0, skippedNoProvider: 0 };
    for (const status of ['OK', 'DEGRADED', 'ABORTED', 'FAILED']) {
      const lines = syncResultLines(summary({ status, wallets: zero }));
      expect(lines.at(-1)).toBe(NO_WALLETS_TEXT);
      expect(lines.filter((l) => l === NO_WALLETS_TEXT)).toHaveLength(1);
    }
    // Ringkasan tanpa angka lain pun tetap memberi petunjuk.
    expect(syncResultLines({ status: 'OK', wallets: { tracked: 0 } })).toEqual(['Belum ada wallet yang dilacak — penemuan otomatis (cukup ETHERSCAN_API_KEY, kunci Binance tidak wajib) belum menemukan kandidat; lihat catatan run, jalankan npm run smart-money:check, atau ikuti wallet lewat Watchlist & Alerts.']);
    // NO_PROVIDERS punya penjelasannya sendiri (ETHERSCAN_API_KEY); wallet yang dilacak, tidak diketahui, atau bukan angka → tanpa petunjuk.
    expect(syncResultLines(summary({ status: 'NO_PROVIDERS', wallets: zero }))).toEqual([]);
    for (const tracked of [3, null, undefined, '0']) {
      expect(syncResultLines(summary({ wallets: { ...zero, tracked } }))).not.toContain(NO_WALLETS_TEXT);
    }
    expect(syncResultLines(summary({ wallets: undefined }))).not.toContain(NO_WALLETS_TEXT);
  });

  it('UNIT-SM-SYNCUI-007 ringkasan milik run yang dipantau: startedAt ringkasan ≥ startedAt run (atau finishedAt bila tanpa startedAt)', () => {
    expect(isSyncResultOf(null, NOW)).toBe(false);
    expect(isSyncResultOf({ startedAt: NOW }, NOW)).toBe(true);
    expect(isSyncResultOf({ startedAt: NOW + 10 }, NOW)).toBe(true);
    expect(isSyncResultOf({ startedAt: NOW - 1 }, NOW)).toBe(false);
    expect(isSyncResultOf({ finishedAt: NOW + 5_000 }, NOW)).toBe(true);
    expect(isSyncResultOf({ finishedAt: NOW - 5_000 }, NOW)).toBe(false);
    expect(isSyncResultOf({}, NOW)).toBe(false);
    // startedAt run tidak diketahui → ringkasan apa pun diterima.
    expect(isSyncResultOf({ startedAt: NOW - 3_600_000 }, null)).toBe(true);
    expect(isSyncResultOf({ startedAt: NOW - 3_600_000 }, undefined)).toBe(true);
  });

  it('UNIT-SM-SYNCUI-008 pesan error/penolakan Bahasa Indonesia: retryAfterMs, pesan server dipotong & tanpa titik ganda', () => {
    expect(syncErrorText('SYNC_RUNNING')).toBe('Sinkronisasi lain sedang berjalan — progresnya ditampilkan di sini.');
    expect(syncErrorText('NO_PROVIDERS')).toBe(SYNC_NO_PROVIDERS_HELP);
    for (const part of ['ETHERSCAN_API_KEY', '.env', 'npm start', 'docs/17-panduan-smart-money.md §5']) expect(SYNC_NO_PROVIDERS_HELP).toContain(part);
    expect(syncErrorText('SYNC_COOLDOWN', { retryAfterMs: 45_000 })).toBe('Sinkronisasi manual baru saja dijalankan. Coba lagi dalam 45 dtk.');
    expect(syncErrorText('SYNC_COOLDOWN', { retryAfterMs: 1_500 })).toBe('Sinkronisasi manual baru saja dijalankan. Coba lagi dalam 2 dtk.');
    for (const retryAfterMs of [undefined, 0, -1, Number.NaN]) {
      expect(syncErrorText('SYNC_COOLDOWN', { retryAfterMs })).toBe('Sinkronisasi manual baru saja dijalankan. Coba lagi sebentar lagi.');
    }
    expect(syncErrorText('RATE_LIMITED')).toBe('Terlalu banyak permintaan ke server. Coba lagi sebentar lagi.');
    expect(syncErrorText('RATE_LIMITED', { retryAfterMs: 61_000 })).toBe('Terlalu banyak permintaan ke server. Coba lagi dalam 1 mnt 1 dtk.');
    expect(syncErrorText('FORBIDDEN')).toBe('Hanya admin yang dapat menjalankan sinkronisasi.');
    expect(syncErrorText('NOT_ADMIN')).toBe(`${SYNC_NOT_ADMIN}.`);
    expect(syncErrorText('CSRF_INVALID')).toBe('Token keamanan sesi kedaluwarsa. Muat ulang halaman lalu coba lagi.');
    expect(syncErrorText('NETWORK')).toBe('Server tidak dapat dihubungi. Periksa koneksi lalu coba lagi.');
    expect(syncErrorText('POLL_TIMEOUT')).toBe('Pemantauan dihentikan setelah 15 menit. Sinkronisasi mungkin masih berjalan — muat ulang halaman untuk memeriksa statusnya.');
    expect(syncErrorText('NO_RESULT')).toBe(NO_RESULT_TEXT);
    expect(syncErrorText('STATUS_FAILED')).toBe('Status sinkronisasi tidak dapat dimuat.');
    expect(syncErrorText('STATUS_FAILED', { message: 'Kesalahan server (INTERNAL)' })).toBe('Status sinkronisasi tidak dapat dimuat: Kesalahan server (INTERNAL).');
    // Kode lain: pesan server (teks biasa) + kode; tanpa pesan → ajakan mencoba lagi; UNKNOWN tidak ditulis.
    expect(syncErrorText('INTERNAL', { message: '  Database terkunci...  ' })).toBe('Sinkronisasi gagal: Database terkunci (INTERNAL)');
    expect(syncErrorText('INTERNAL', { message: '   ' })).toBe('Sinkronisasi gagal (INTERNAL). Coba lagi.');
    expect(syncErrorText('UNKNOWN', { message: 'HTTP 502' })).toBe('Sinkronisasi gagal: HTTP 502');
    expect(syncErrorText(undefined)).toBe('Sinkronisasi gagal. Coba lagi.');
    expect(syncErrorText('BOOM', { message: 'a'.repeat(500) })).toBe(`Sinkronisasi gagal: ${'a'.repeat(299)}… (BOOM)`);
  });

  it('UNIT-SM-SYNCUI-009 hitung mundur jeda & petunjuk jadwal otomatis (intervalMinutes, cadangan 15 menit)', () => {
    expect(syncCooldownText(45_000)).toBe('Bisa dijalankan lagi dalam 45 dtk');
    expect(syncCooldownText(44_001)).toBe('Bisa dijalankan lagi dalam 45 dtk');
    expect(syncCooldownText(90_000)).toBe('Bisa dijalankan lagi dalam 1 mnt 30 dtk');
    expect(syncCooldownText(1)).toBe('Bisa dijalankan lagi dalam 1 dtk');
    for (const v of [0, -5, null, undefined, Number.NaN]) expect(syncCooldownText(v)).toBe('');

    expect(SYNC_DEFAULT_INTERVAL_MINUTES).toBe(15);
    expect(syncAutoHint(30)).toBe('Otomatis tiap 30 menit saat scanner berjalan');
    expect(syncAutoHint(7.6)).toBe('Otomatis tiap 8 menit saat scanner berjalan');
    for (const v of [null, undefined, 0, -5, 0.2, Number.NaN, Number.POSITIVE_INFINITY, '20']) {
      expect(syncAutoHint(v)).toBe('Otomatis tiap 15 menit saat scanner berjalan');
    }
  });

  it('UNIT-SM-SYNCUI-010 ApiError menyimpan badan respons error (retryAfterMs / run untuk 429 / 409)', () => {
    const run = { owner: 'worker', trigger: 'schedule', phase: 'transfers', startedAt: NOW, done: 1, total: 2 };
    const cooldown = new ApiError(429, { error: 'SYNC_COOLDOWN', message: 'Tunggu sebentar.', retryAfterMs: 5_000 });
    expect(cooldown).toMatchObject({ status: 429, code: 'SYNC_COOLDOWN', message: 'Tunggu sebentar.' });
    expect(cooldown.body.retryAfterMs).toBe(5_000);
    expect(new ApiError(409, { error: 'SYNC_RUNNING', message: 'Sedang berjalan.', run }).body.run).toEqual(run);
    expect(new ApiError(500, null)).toMatchObject({ status: 500, code: 'UNKNOWN', message: 'HTTP 500', body: null });
    expect(new ApiError(502, 'Bad Gateway').body).toBeNull();
  });

  it('UNIT-SM-SYNCUI-011 jalur penemuan & pemetaan: mode binance / trending (+ chain), pemetaan binance-public "(publik, tanpa kunci)"', () => {
    const lines = (discovery, mapping = { upserted: 12, rejected: 1 }) => syncResultLines(summary({ discovery, mapping }));
    expect(lines({ candidates: 30, added: 8, mode: 'binance' })).toContain('Penemuan wallet (token listing Binance): 8 wallet baru dari 30 kandidat');
    expect(lines({ candidates: 6, added: 2, mode: 'trending', trendingChain: 'base' }))
      .toContain('Penemuan wallet (token trending GeckoTerminal di base — belum tentu listing Binance): 2 wallet baru dari 6 kandidat');
    expect(lines({ candidates: 0, added: 0, mode: 'trending', trendingChain: null }))
      .toContain('Penemuan wallet (token trending GeckoTerminal — belum tentu listing Binance): 0 wallet baru');
    // Mode tidak dikenal / 'none' / tidak ada → tanpa keterangan jalur.
    for (const mode of ['none', undefined, 'lain', 7]) {
      expect(lines({ candidates: 0, added: 0, mode })).toContain('Penemuan wallet: 0 wallet baru');
    }
    expect(lines({ added: 1 }, { refreshed: ['binance-public'], upserted: 120, rejected: 0 }))
      .toContain('Pemetaan Binance (publik, tanpa kunci): 120 kontrak diperbarui');
    expect(lines({ added: 1 }, { refreshed: ['binance-mapping'], upserted: 120, rejected: 2 }))
      .toContain('Pemetaan Binance: 120 kontrak diperbarui (2 ditolak)');
    for (const refreshed of [[], 'binance-public', null]) {
      expect(lines({ added: 1 }, { refreshed, upserted: 0, rejected: 0 })).toContain('Pemetaan Binance: 0 kontrak diperbarui');
    }
  });
});

// ---------------------------------------------------------------------------------------------- komponen

let dom = null;
let active = null;

function teardown() {
  active?.sync.cleanup();
  active = null;
  dom?.uninstall();
  dom = null;
}

/**
 * Pasang DOM tiruan dengan server sinkron tiruan, lalu buat kontrol (terpasang di <body> kecuali mount: false).
 * server.status = badan GET; server.getReply = balasan GET pengganti (mis. error); server.post = balasan POST (atau
 * fungsi). server.gets/posts = init fetch yang diterima (headers, method, body).
 */
function setup({ user = { role: 'admin' }, status = statusBody(), getReply = null, mount = true } = {}) {
  const server = { status, getReply, post: { status: 202, body: { started: true, run: RUN0 } }, gets: [], posts: [] };
  dom = installFakeDom({
    responses: (url, init) => {
      if (url !== SYNC_PATH) return { status: 404, body: { error: 'NOT_FOUND', message: 'tidak ada' } };
      if ((init.method ?? 'GET') === 'POST') {
        server.posts.push(init);
        return typeof server.post === 'function' ? server.post() : server.post;
      }
      server.gets.push(init);
      return server.getReply ?? { status: 200, body: server.status };
    },
  });
  const finished = [];
  const sync = syncControl({ user, onFinished: (lastRun) => { finished.push(lastRun); } });
  if (mount) globalThis.document.body.append(sync.button, sync.el);
  active = { sync, server, finished };
  return active;
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms) => vi.advanceTimersByTimeAsync(ms);
const q = (sync, id) => sync.el.querySelector(`[data-testid="${id}"]`);
const disabled = (button) => button.getAttribute('aria-disabled') === 'true';
const progressbar = (sync) => sync.el.querySelector('[role="progressbar"]');
const hintOf = (sync) => text(sync.el.querySelector('#sm-sync-hint'));

describe('Sync UI — komponen syncControl', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    setCsrfToken('csrf-sync');
  });

  afterEach(() => {
    teardown();
    vi.useRealTimers();
  });

  it('UNIT-SM-SYNCUI-020 admin: idle → klik (POST + CSRF) → progres → selesai (hasil, onFinished sekali, polling berhenti) → Tutup', async () => {
    const { sync, server, finished } = setup({ status: statusBody({ lastRun: OLD, intervalMinutes: 30 }) });
    // Sebelum status dibaca tombol menunggu.
    expect(sync.el.dataset.state).toBe('loading');
    expect(disabled(sync.button)).toBe(true);
    await settle();
    expect(server.gets).toHaveLength(1);
    expect(server.gets[0].headers['X-LR-Background']).toBe('1'); // polling latar: tidak memperpanjang sesi
    expect(sync.el.dataset.state).toBe('idle');

    // Nama aksesibel tepat "Sync sekarang" (E2E: getByRole('button', { name: 'Sync sekarang' })).
    expect(sync.button.tagName).toBe('BUTTON');
    expect(sync.button.type).toBe('button');
    expect(sync.button.textContent.trim()).toBe('Sync sekarang');
    expect(sync.button.hasAttribute('aria-label')).toBe(false);
    expect(sync.button.getAttribute('aria-describedby')).toBe('sm-sync-hint');
    expect(disabled(sync.button)).toBe(false);
    expect(hintOf(sync)).toBe('Otomatis tiap 30 menit saat scanner berjalan');
    const live = q(sync, 'sm-sync-status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    // Run terakhir: ringkasan tertutup di luar wilayah live (tidak diumumkan tiap kunjungan).
    const last = q(sync, 'sm-sync-last');
    expect(last.tagName).toBe('DETAILS');
    expect(last.hasAttribute('open')).toBe(false);
    expect(live.contains(last)).toBe(false);
    expect(text(last)).toContain('Hasil sinkron terakhir');
    expect(text(last.querySelector('.badge'))).toBe('Berhasil');

    server.status = statusBody({ running: true, run: RUN0, lastRun: OLD, intervalMinutes: 30 });
    sync.button.click();
    expect(sync.el.dataset.state).toBe('pending');
    expect(sync.button.dataset.busy).toBe('true');
    await settle();
    expect(server.posts).toHaveLength(1);
    expect(server.posts[0].method).toBe('POST');
    expect(server.posts[0].headers['X-CSRF-Token']).toBe('csrf-sync');
    expect(server.posts[0].body).toBeUndefined(); // tanpa body
    expect(sync.el.dataset.state).toBe('running');
    expect(disabled(sync.button)).toBe(true);
    expect(sync.button.title).toBe('Sinkronisasi sedang berjalan');
    expect(q(sync, 'sm-sync-last')).toBeNull();
    let bar = progressbar(sync);
    expect(bar.getAttribute('aria-label')).toBe('Progres sinkronisasi');
    expect(bar.classList.contains('progress-indeterminate')).toBe(true);
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    const line = q(sync, 'sm-sync-progress');
    expect(text(line)).toBe('Menyiapkan · berjalan 0 dtk · manual');
    expect(live.contains(line)).toBe(true);

    const RUN1 = { ...RUN0, phase: 'transfers', done: 12, total: 50, updatedAt: NOW + 1_000 };
    server.status = statusBody({ running: true, run: RUN1, lastRun: OLD, intervalMinutes: 30 });
    await advance(SYNC_POLL_MS);
    expect(server.gets).toHaveLength(2);
    expect(server.gets[1].headers['X-LR-Background']).toBe('1');
    bar = progressbar(sync);
    expect(bar.classList.contains('sync-bar')).toBe(true);
    expect(bar.getAttribute('aria-label')).toBe('Progres sinkronisasi');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('50');
    expect(bar.getAttribute('aria-valuenow')).toBe('12');
    expect(bar.getAttribute('aria-valuetext')).toBe('12 dari 50 wallet');
    expect(bar.querySelector('.sync-bar__fill').style.props['--lr-sync-pct']).toBe('24');
    expect(text(q(sync, 'sm-sync-progress'))).toBe(syncProgressText(RUN1, Date.now()));
    expect(text(q(sync, 'sm-sync-progress'))).toBe('Riwayat transaksi wallet · 12/50 wallet · berjalan 1 dtk · manual');
    // Angka & lama berjalan (berubah tiap polling) tidak diumumkan ulang — tersedia lewat progressbar.
    expect(q(sync, 'sm-sync-progress').querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    expect(finished).toHaveLength(0);

    server.status = statusBody({ lastRun: FRESH, intervalMinutes: 30 });
    await advance(SYNC_POLL_MS);
    expect(finished).toEqual([FRESH]);
    const result = q(sync, 'sm-sync-result');
    expect(result.hasAttribute('open')).toBe(true);
    expect(live.contains(result)).toBe(true);
    expect(result.getAttribute('data-tone')).toBe('warn');
    expect(result.getAttribute('data-status')).toBe('DEGRADED');
    expect(text(result.querySelector('.sm-sync__title'))).toBe('Sinkronisasi selesai');
    const statusBadge = result.querySelector('.badge');
    expect(text(statusBadge)).toBe('Selesai dengan catatan');
    expect(statusBadge.classList.contains('badge--warn')).toBe(true);
    expect(text(result.querySelector('summary'))).toContain('durasi 2 dtk');
    expect(text(result.querySelector('summary'))).toContain('manual');
    expect(result.querySelectorAll('.sm-sync__lines li').map(text)).toEqual(syncResultLines(FRESH));
    expect(result.querySelectorAll('.sm-sync__notes li').map(text)).toEqual(['Catatan 1', 'Catatan 2', 'Catatan 3']);
    expect(text(result)).toContain('+2 catatan lain');
    const errors = result.querySelectorAll('.sm-sync__errors li');
    expect(errors).toHaveLength(3);
    expect(text(errors[0].querySelector('.sync-errors__meta'))).toBe('etherscan · RATE_LIMIT');
    expect(text(errors[0].querySelector('.sync-errors__msg'))).toBe('Max rate limit reached');
    expect(text(errors[2].querySelector('.sync-errors__meta'))).toBe('binance · HTTP_451');
    expect(text(result)).toContain('+1 error lain');
    expect(text(result)).not.toContain('Respons tidak valid');
    expect(progressbar(sync)).toBeNull();
    expect(sync.el.dataset.state).toBe('finished');
    expect(disabled(sync.button)).toBe(false);
    expect(sync.button.dataset.busy).toBe('false');

    // Run selesai → polling berhenti; hasil tetap tampil sampai klik berikutnya atau Tutup.
    const gets = server.gets.length;
    await advance(10 * SYNC_POLL_MS);
    expect(server.gets).toHaveLength(gets);
    expect(finished).toHaveLength(1);
    expect(q(sync, 'sm-sync-result')).toBe(result);

    result.querySelectorAll('button').find((b) => text(b) === 'Tutup').click();
    expect(q(sync, 'sm-sync-result')).toBeNull();
    expect(globalThis.document.activeElement).toBe(sync.button);
    const collapsed = q(sync, 'sm-sync-last');
    expect(collapsed.hasAttribute('open')).toBe(false);
    expect(text(collapsed.querySelector('.badge'))).toBe('Selesai dengan catatan');
    expect(sync.el.dataset.state).toBe('idle');
  });

  it('UNIT-SM-SYNCUI-021 bukan admin (NOT_ADMIN): tombol nonaktif dengan alasan, klik tidak mengirim POST', async () => {
    const { sync, server } = setup({ user: { role: 'analyst' }, status: statusBody({ canTrigger: false, reason: 'NOT_ADMIN', lastRun: OLD, intervalMinutes: null }) });
    expect(disabled(sync.button)).toBe(true);
    await settle();
    expect(disabled(sync.button)).toBe(true);
    expect(sync.button.title).toBe('Hanya admin yang dapat menjalankan sinkronisasi');
    expect(sync.button.textContent.trim()).toBe('Sync sekarang');
    // intervalMinutes null → cadangan 15 menit.
    expect(hintOf(sync)).toBe(`Otomatis tiap 15 menit saat scanner berjalan · ${SYNC_NOT_ADMIN}`);
    expect(sync.el.dataset.state).toBe('blocked');
    expect(q(sync, 'sm-sync-help')).toBeNull();
    sync.button.click();
    await settle();
    expect(server.posts).toHaveLength(0);
    expect(sync.button.dataset.busy).toBe('false');
    expect(q(sync, 'sm-sync-last')).not.toBeNull(); // ringkasan run terakhir tetap terlihat untuk semua peran
  });

  it('UNIT-SM-SYNCUI-022 NO_PROVIDERS didahulukan untuk semua peran: penjelasan ETHERSCAN_API_KEY/.env; 409 NO_PROVIDERS sama', async () => {
    let t = setup({ user: { role: 'analyst' }, status: statusBody({ canTrigger: false, reason: 'NO_PROVIDERS', providersConfigured: 0 }) });
    await settle();
    const help = q(t.sync, 'sm-sync-help');
    expect(text(help)).toBe(SYNC_NO_PROVIDERS_HELP);
    expect(text(help)).toContain('ETHERSCAN_API_KEY');
    expect(text(help)).toContain('docs/17-panduan-smart-money.md §5');
    expect(q(t.sync, 'sm-sync-status').contains(help)).toBe(true);
    expect(disabled(t.sync.button)).toBe(true);
    expect(t.sync.button.title).toContain('ETHERSCAN_API_KEY');
    expect(hintOf(t.sync)).toContain('Belum ada sumber data aktif');
    expect(hintOf(t.sync)).not.toContain(SYNC_NOT_ADMIN);
    expect(t.sync.el.dataset.state).toBe('blocked');
    teardown();

    // Admin: status awal mengizinkan, tetapi POST ditolak 409 NO_PROVIDERS → penjelasan yang sama, tombol nonaktif.
    t = setup({ status: statusBody({ lastRun: OLD }) });
    t.server.post = { status: 409, body: { error: 'NO_PROVIDERS', message: 'Belum ada provider data smart money.' } };
    await settle();
    expect(q(t.sync, 'sm-sync-help')).toBeNull();
    t.sync.button.click();
    await settle();
    expect(text(q(t.sync, 'sm-sync-help'))).toBe(SYNC_NO_PROVIDERS_HELP);
    expect(q(t.sync, 'sm-sync-notice')).toBeNull();
    expect(disabled(t.sync.button)).toBe(true);
    expect(t.sync.el.dataset.state).toBe('blocked');
  });

  it('UNIT-SM-SYNCUI-023 429 SYNC_COOLDOWN: hitung mundur dari retryAfterMs, tombol aktif lagi setelah jeda', async () => {
    const { sync, server } = setup({ status: statusBody({ lastRun: OLD }) });
    server.post = { status: 429, body: { error: 'SYNC_COOLDOWN', message: 'Tunggu 3 detik.', retryAfterMs: 3_000 } };
    await settle();
    sync.button.click();
    await settle();
    const notice = q(sync, 'sm-sync-notice');
    expect(notice.getAttribute('data-code')).toBe('SYNC_COOLDOWN');
    expect(notice.getAttribute('data-tone')).toBe('warn');
    // Pesan tanpa angka (tidak menjadi basi); sisa waktu ada di hitung mundur.
    expect(text(notice)).toBe('Sinkronisasi manual baru saja dijalankan. Coba lagi sebentar lagi.');
    const wait = q(sync, 'sm-sync-cooldown');
    expect(wait.hidden).toBe(false);
    expect(text(wait)).toBe('· Bisa dijalankan lagi dalam 3 dtk');
    expect(q(sync, 'sm-sync-status').contains(wait)).toBe(false); // tidak diumumkan tiap detik
    expect(disabled(sync.button)).toBe(true);
    expect(sync.button.title).toBe('Bisa dijalankan lagi dalam 3 dtk');
    expect(sync.el.dataset.state).toBe('cooldown');

    await advance(1_000);
    expect(text(wait)).toBe('· Bisa dijalankan lagi dalam 2 dtk');
    await advance(1_000);
    expect(text(wait)).toBe('· Bisa dijalankan lagi dalam 1 dtk');
    expect(disabled(sync.button)).toBe(true);
    await advance(1_000);
    expect(wait.hidden).toBe(true);
    expect(disabled(sync.button)).toBe(false);
    expect(q(sync, 'sm-sync-notice')).toBeNull();
    expect(sync.el.dataset.state).toBe('idle');

    server.post = { status: 202, body: { started: true, run: RUN0 } };
    server.status = statusBody({ running: true, run: RUN0, lastRun: OLD });
    sync.button.click();
    await settle();
    expect(server.posts).toHaveLength(2);
    expect(sync.el.dataset.state).toBe('running');
  });

  it('UNIT-SM-SYNCUI-024 cooldownUntil dari GET (trigger manual baru saja) → hitung mundur sejak halaman dibuka', async () => {
    const { sync } = setup({ status: statusBody({ lastRun: OLD, cooldownUntil: NOW + 45_000 }) });
    await settle();
    expect(text(q(sync, 'sm-sync-cooldown'))).toBe('· Bisa dijalankan lagi dalam 45 dtk');
    expect(disabled(sync.button)).toBe(true);
    expect(q(sync, 'sm-sync-notice')).toBeNull();
    await advance(30_000);
    expect(text(q(sync, 'sm-sync-cooldown'))).toBe('· Bisa dijalankan lagi dalam 15 dtk');
    await advance(15_000);
    expect(q(sync, 'sm-sync-cooldown').hidden).toBe(true);
    expect(disabled(sync.button)).toBe(false);
  });

  it('UNIT-SM-SYNCUI-025 409 SYNC_RUNNING: ikut memantau run yang sedang berjalan (putaran terjadwal worker) sampai selesai', async () => {
    const WORKER = { owner: 'worker', trigger: 'schedule', phase: 'discovery', startedAt: NOW - 80_000, updatedAt: NOW - 1_000, done: 0, total: 0 };
    const { sync, server, finished } = setup({ status: statusBody({ lastRun: OLD }) });
    server.post = { status: 409, body: { error: 'SYNC_RUNNING', message: 'Sinkronisasi sedang berjalan.', run: WORKER } };
    await settle();
    server.status = statusBody({ running: true, run: { ...WORKER, phase: 'transfers', done: 3, total: 4 }, lastRun: OLD });
    sync.button.click();
    await settle();
    const notice = q(sync, 'sm-sync-notice');
    expect(notice.getAttribute('data-tone')).toBe('info');
    expect(text(notice)).toBe('Sinkronisasi lain sedang berjalan — progresnya ditampilkan di sini.');
    expect(text(q(sync, 'sm-sync-progress'))).toBe('Penemuan wallet · berjalan 1 mnt 20 dtk · terjadwal (worker scanner)');
    expect(sync.el.dataset.state).toBe('running');
    expect(disabled(sync.button)).toBe(true);

    await advance(SYNC_POLL_MS);
    expect(progressbar(sync).getAttribute('aria-valuenow')).toBe('3');
    expect(progressbar(sync).getAttribute('aria-valuemax')).toBe('4');
    expect(text(q(sync, 'sm-sync-progress'))).toBe('Riwayat transaksi wallet · 3/4 wallet · berjalan 1 mnt 21 dtk · terjadwal (worker scanner)');

    const DONE = summary({ status: 'OK', trigger: 'schedule', startedAt: WORKER.startedAt, finishedAt: NOW + 2_000 });
    server.status = statusBody({ lastRun: DONE });
    await advance(SYNC_POLL_MS);
    expect(finished).toEqual([DONE]);
    const result = q(sync, 'sm-sync-result');
    expect(text(result.querySelector('.badge'))).toBe('Berhasil');
    expect(result.querySelector('.badge').classList.contains('badge--bull')).toBe(true);
    expect(text(result.querySelector('summary'))).toContain('terjadwal (worker scanner)');
    expect(q(sync, 'sm-sync-notice')).toBeNull();
    expect(disabled(sync.button)).toBe(false);
    expect(server.posts).toHaveLength(1);
  });

  it('UNIT-SM-SYNCUI-026 run yang sudah berjalan saat halaman dibuka langsung dipantau (juga untuk analis) → onFinished', async () => {
    const RUN = { owner: 'worker', trigger: 'schedule', phase: 'mapping', startedAt: NOW - 5_000, updatedAt: NOW, done: 2, total: 10 };
    const { sync, server, finished } = setup({
      user: { role: 'analyst' }, status: statusBody({ running: true, run: RUN, lastRun: OLD, canTrigger: false, reason: 'NOT_ADMIN' }),
    });
    await settle();
    expect(server.posts).toHaveLength(0);
    expect(sync.el.dataset.state).toBe('running');
    expect(text(q(sync, 'sm-sync-progress'))).toBe('Pemetaan kontrak Binance · 2/10 · berjalan 5 dtk · terjadwal (worker scanner)');
    expect(progressbar(sync).getAttribute('aria-valuetext')).toBe('2 dari 10');
    expect(disabled(sync.button)).toBe(true);
    expect(q(sync, 'sm-sync-last')).toBeNull(); // ringkasan lama disembunyikan selama run berjalan

    const DONE = summary({ ...OLD, startedAt: RUN.startedAt, finishedAt: NOW + 1_000 });
    server.status = statusBody({ lastRun: DONE, canTrigger: false, reason: 'NOT_ADMIN' });
    await advance(SYNC_POLL_MS);
    expect(finished).toEqual([DONE]);
    expect(q(sync, 'sm-sync-result')).not.toBeNull();
    expect(sync.el.dataset.state).toBe('blocked');
    expect(disabled(sync.button)).toBe(true);
  });

  it('UNIT-SM-SYNCUI-027 run berakhir tanpa ringkasan baru (lastRun.startedAt < run.startedAt) → kalimat netral, onFinished(null)', async () => {
    const { sync, server, finished } = setup({ status: statusBody({ lastRun: OLD }) });
    await settle();
    server.status = statusBody({ running: true, run: RUN0, lastRun: OLD });
    sync.button.click();
    await settle();
    server.status = statusBody({ lastRun: OLD });
    await advance(SYNC_POLL_MS);
    const notice = q(sync, 'sm-sync-notice');
    expect(text(notice)).toBe(NO_RESULT_TEXT);
    expect(notice.getAttribute('data-tone')).toBe('neutral');
    expect(q(sync, 'sm-sync-status').contains(notice)).toBe(true);
    expect(q(sync, 'sm-sync-result')).toBeNull();
    expect(finished).toEqual([null]);
    expect(disabled(sync.button)).toBe(false);
    // Ringkasan lama tetap tersedia sebagai "Hasil sinkron terakhir" (tertutup).
    expect(text(q(sync, 'sm-sync-last'))).toContain('Hasil sinkron terakhir');
  });

  it('UNIT-SM-SYNCUI-028 status FAILED → badge "Gagal" (bear); hasil tanpa wallet dilacak memuat petunjuk penemuan otomatis / Watchlist', async () => {
    const FAILED = summary({
      status: 'FAILED', trigger: 'schedule', startedAt: NOW - 600_000, finishedAt: NOW - 590_000,
      notes: ['Run dihentikan karena error provider.'], errors: [{ provider: 'etherscan', code: 'INVALID_KEY', message: 'Invalid API Key' }],
    });
    const { sync, server } = setup({ status: statusBody({ lastRun: FAILED }) });
    await settle();
    const last = q(sync, 'sm-sync-last');
    expect(last.getAttribute('data-tone')).toBe('bear');
    expect(text(last.querySelector('.badge'))).toBe('Gagal');
    expect(last.querySelector('.badge').classList.contains('badge--bear')).toBe(true);
    expect(text(last)).toContain('etherscan · INVALID_KEY');
    expect(text(last)).toContain('Invalid API Key');
    expect(text(last)).toContain('Run dihentikan karena error provider.');

    const EMPTY_RUN = summary({
      status: 'OK', startedAt: NOW, finishedAt: NOW + 1_000, fetched: 0, inserted: 0, alerts: 0,
      wallets: { tracked: 0, selected: 0, synced: 0, failed: 0, deferred: 0, skippedNoProvider: 0 },
      discovery: { candidates: 0, added: 0 }, mapping: { upserted: 0, rejected: 0 },
    });
    server.status = statusBody({ running: true, run: RUN0, lastRun: FAILED });
    sync.button.click();
    await settle();
    server.status = statusBody({ lastRun: EMPTY_RUN });
    await advance(SYNC_POLL_MS);
    const hints = q(sync, 'sm-sync-result').querySelectorAll('li[data-hint]');
    expect(hints).toHaveLength(1);
    expect(text(hints[0])).toBe(NO_WALLETS_TEXT);
  });

  it('UNIT-SM-SYNCUI-029 penolakan POST lain: 403 FORBIDDEN → nonaktif; CSRF_INVALID / RATE_LIMITED / 500 / jaringan → pesan', async () => {
    const cases = [
      { reply: { status: 403, body: { error: 'FORBIDDEN', message: 'Akses ditolak.' } }, notice: 'Hanya admin yang dapat menjalankan sinkronisasi.', blocked: true },
      { reply: { status: 403, body: { error: 'CSRF_INVALID', message: 'Token CSRF tidak valid.' } }, notice: 'Token keamanan sesi kedaluwarsa. Muat ulang halaman lalu coba lagi.', blocked: false },
      { reply: { status: 429, body: { error: 'RATE_LIMITED', message: 'Terlalu banyak permintaan. Coba lagi nanti.' } }, notice: 'Terlalu banyak permintaan ke server. Coba lagi sebentar lagi.', blocked: false },
      { reply: { status: 500, body: { error: 'INTERNAL', message: 'Kesalahan internal.' } }, notice: 'Sinkronisasi gagal: Kesalahan internal (INTERNAL)', blocked: false },
      { reply: () => { throw new TypeError('Failed to fetch'); }, notice: 'Server tidak dapat dihubungi. Periksa koneksi lalu coba lagi.', blocked: false },
    ];
    for (const c of cases) {
      const { sync, server } = setup({ status: statusBody({ lastRun: OLD }) });
      server.post = c.reply;
      await settle();
      sync.button.click();
      await settle();
      const notice = q(sync, 'sm-sync-notice');
      expect(text(notice)).toBe(c.notice);
      expect(notice.getAttribute('data-tone')).toBe('bear');
      expect(disabled(sync.button)).toBe(c.blocked);
      expect(sync.el.dataset.state).toBe(c.blocked ? 'blocked' : 'idle');
      if (c.blocked) expect(sync.button.title).toBe(SYNC_NOT_ADMIN);
      expect(progressbar(sync)).toBeNull();
      expect(server.posts).toHaveLength(1);
      teardown();
    }
  });

  it('UNIT-SM-SYNCUI-030 status gagal dimuat → pesan (admin tetap bisa mencoba); polling gagal 3× beruntun → "Mencoba lagi…", lalu pulih', async () => {
    let t = setup({ getReply: { status: 500, body: { error: 'INTERNAL', message: 'Kesalahan server.' } } });
    await settle();
    const notice = q(t.sync, 'sm-sync-notice');
    expect(text(notice)).toBe('Status sinkronisasi tidak dapat dimuat: Kesalahan server (INTERNAL).');
    expect(notice.getAttribute('data-tone')).toBe('warn');
    expect(disabled(t.sync.button)).toBe(false); // server tetap memeriksa izin saat POST
    expect(hintOf(t.sync)).toBe('Otomatis tiap 15 menit saat scanner berjalan');
    teardown();

    // Analis: tanpa status server, peran sesi menjadi cadangan → nonaktif.
    t = setup({ user: { role: 'analyst' }, getReply: { status: 503, body: { error: 'UNAVAILABLE', message: 'Tidak tersedia.' } } });
    await settle();
    expect(disabled(t.sync.button)).toBe(true);
    expect(t.sync.button.title).toBe(SYNC_NOT_ADMIN);
    teardown();

    const RUN = { owner: 'worker', trigger: 'schedule', phase: 'transfers', startedAt: NOW - 1_000, done: 1, total: 9 };
    t = setup({ status: statusBody({ running: true, run: RUN, lastRun: OLD }) });
    await settle();
    t.server.getReply = { status: 502, body: { error: 'BAD_GATEWAY', message: 'Gateway.' } };
    await advance(2 * SYNC_POLL_MS);
    expect(t.server.gets).toHaveLength(3);
    expect(q(t.sync, 'sm-sync-notice')).toBeNull(); // kegagalan sesaat tidak langsung ditampilkan
    await advance(SYNC_POLL_MS);
    expect(text(q(t.sync, 'sm-sync-notice'))).toBe('Status sinkronisasi tidak dapat dimuat: Gateway (BAD_GATEWAY). Mencoba lagi…');
    expect(t.sync.el.dataset.state).toBe('running');
    t.server.getReply = null;
    await advance(SYNC_POLL_MS);
    expect(q(t.sync, 'sm-sync-notice')).toBeNull();
    expect(progressbar(t.sync)).not.toBeNull();
  });

  it('UNIT-SM-SYNCUI-031 polling berhenti saat kontrol dilepas (pindah route), bila tak pernah dipasang, dan lewat cleanup()', async () => {
    const RUN = { owner: 'worker', trigger: 'schedule', phase: 'transfers', startedAt: NOW - 1_000, done: 1, total: 9 };
    let t = setup({ status: statusBody({ running: true, run: RUN, lastRun: OLD }) });
    await settle();
    await advance(SYNC_POLL_MS);
    expect(t.server.gets).toHaveLength(2);
    t.sync.el.remove();
    t.sync.button.remove();
    await advance(10 * SYNC_POLL_MS);
    expect(t.server.gets).toHaveLength(2);
    expect(t.finished).toHaveLength(0);
    teardown();

    // View basi yang tidak pernah dipasang: berhenti setelah masa tenggang 5 detik.
    t = setup({ status: statusBody({ running: true, run: RUN, lastRun: OLD }), mount: false });
    await settle();
    await advance(60_000);
    expect(t.server.gets).toHaveLength(4); // GET awal + polling pada 1,5 / 3 / 4,5 detik
    teardown();

    t = setup({ status: statusBody({ running: true, run: RUN, lastRun: OLD }) });
    await settle();
    t.sync.cleanup();
    await advance(60_000);
    expect(t.server.gets).toHaveLength(1);
  });

  it('UNIT-SM-SYNCUI-032 pemantauan dibatasi 15 menit → pesan, tombol aktif lagi, polling berhenti', async () => {
    const RUN = { owner: 'server', trigger: 'manual', phase: 'transfers', startedAt: NOW, done: 1, total: 9 };
    const { sync, server, finished } = setup({ status: statusBody({ running: true, run: RUN, lastRun: OLD }) });
    await settle();
    await advance(SYNC_POLL_MS);
    expect(server.gets).toHaveLength(2);
    vi.setSystemTime(Date.now() + 15 * 60_000);
    await advance(SYNC_POLL_MS);
    const notice = q(sync, 'sm-sync-notice');
    expect(notice.getAttribute('data-code')).toBe('POLL_TIMEOUT');
    expect(text(notice)).toBe(syncErrorText('POLL_TIMEOUT'));
    expect(text(notice)).toContain('15 menit');
    expect(progressbar(sync)).toBeNull();
    expect(disabled(sync.button)).toBe(false);
    expect(sync.el.dataset.state).toBe('idle');
    await advance(60_000);
    expect(server.gets).toHaveLength(2);
    expect(finished).toHaveLength(0);
  });

  it('UNIT-SM-SYNCUI-033 teks server (catatan, error, pesan) selalu teks biasa — tidak pernah menjadi elemen', async () => {
    const EVIL = summary({
      notes: ['<img src=x onerror=alert(1)>'], errors: [{ provider: '<b>p</b>', code: 'X', message: '<script>alert(1)</script>' }],
    });
    const { sync, server } = setup({ status: statusBody({ lastRun: EVIL }) });
    server.post = { status: 500, body: { error: 'INTERNAL', message: '<img src=y onerror=alert(2)>' } };
    await settle();
    sync.button.click();
    await settle();
    for (const tag of ['img', 'script', 'b']) expect(sync.el.querySelectorAll(tag)).toHaveLength(0);
    const all = text(sync.el);
    expect(all).toContain('<img src=x onerror=alert(1)>');
    expect(all).toContain('<script>alert(1)</script>');
    expect(text(sync.el.querySelector('.sync-errors__meta'))).toBe('<b>p</b> · X');
    expect(text(q(sync, 'sm-sync-notice'))).toBe('Sinkronisasi gagal: <img src=y onerror=alert(2)> (INTERNAL)');
  });
});

// ---------------------------------------------------------------------------------------------- halaman radar

const T1 = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const W1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const radarMeta = (over = {}) => ({
  simulated: false, dataAsOf: NOW - 60_000, lastSyncAt: NOW - 120_000, isStale: false,
  coverage: { chains: ['ethereum'], wallets: 3, activities: 20 }, providersConfigured: 1, disclaimers: DISCLAIMERS, ...over,
});
const radarItems = () => [{
  tokenKey: `ethereum:${T1}`, chain: 'ethereum', token: { address: T1, symbol: 'PEPE', name: 'Pepe' },
  buyers: [{ wallet: W1, score: 81, clusterId: `ethereum:${W1}`, netBuyUsd: 5000, buys: 2, sells: 0, firstBuyAt: NOW - 3e6, lastBuyAt: NOW - 1e6, txs: [], label: null }],
  buyerCount: 1, independentBuyers: 1, exitSignals: [], state: 'ACCUMULATING', conviction: 64, binance: { status: 'SYMBOL_ONLY' }, isSimulated: false,
}];

describe('Sync UI — halaman Smart Money Radar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    setCsrfToken('csrf-sync');
  });

  afterEach(() => {
    teardown();
    vi.useRealTimers();
  });

  it('UNIT-SM-SYNCUI-034 tombol pertama di aksi header, status di bawah header; run selesai → radar dimuat ulang dengan filter & Peta Benang', async () => {
    let lastSyncAt = NOW - 4 * 3_600_000;
    const radarUrls = [];
    const server = { status: statusBody({ lastRun: OLD }), posts: 0 };
    dom = installFakeDom({
      hash: '#/smart-money?window=4h&view=benang',
      responses: (url, init) => {
        const path = url.split('?')[0];
        const method = init.method ?? 'GET';
        if (path === '/api/smart-money/radar') {
          radarUrls.push(url);
          return { status: 200, body: { meta: radarMeta({ lastSyncAt }), window: '4h', computedAt: Date.now(), items: radarItems() } };
        }
        if (path === '/api/smart-money/evaluation') return { status: 200, body: { meta: radarMeta(), available: false } };
        if (path === SYNC_PATH && method === 'POST') {
          server.posts += 1;
          return { status: 202, body: { started: true, run: RUN0 } };
        }
        if (path === SYNC_PATH) return { status: 200, body: server.status };
        return { status: 404, body: { error: 'NOT_FOUND', message: 'tidak ada' } };
      },
    });
    const el = await smartMoneyView({ user: { role: 'admin' } });
    globalThis.document.body.append(el);
    await settle();

    const header = el.querySelector('.page__header');
    const actions = header.querySelector('.cluster').children;
    expect(actions.map(text)).toEqual(['Sync sekarang', 'Wallet Discovery', 'Watchlist & Alerts']);
    expect(actions[0].getAttribute('data-testid')).toBe('sm-sync-button');
    expect(header.nextElementSibling.getAttribute('data-testid')).toBe('sm-sync');
    expect(el.querySelectorAll('button').filter((b) => text(b) === 'Sync sekarang')).toHaveLength(1);
    const strip = () => text(el.querySelector('[data-testid="sm-status"]'));
    expect(strip()).toContain('4 jam lalu');

    // Filter diubah sebelum sinkron: dipertahankan saat radar dimuat ulang.
    const form = el.querySelector('form');
    form.elements.state.value = 'ACCUMULATING';
    form.dispatchEvent({ type: 'change' });
    await settle();
    const first = '/api/smart-money/radar?window=4h&limit=100';
    const filtered = '/api/smart-money/radar?window=4h&state=ACCUMULATING&limit=100';
    expect(radarUrls).toEqual([first, filtered]);

    server.status = statusBody({ running: true, run: RUN0, lastRun: OLD });
    actions[0].click();
    await settle();
    expect(server.posts).toBe(1);
    expect(el.querySelector('[data-testid="sm-sync-progress"]')).not.toBeNull();
    expect(radarUrls).toHaveLength(2); // radar belum dimuat ulang selama run berjalan

    lastSyncAt = Date.now();
    server.status = statusBody({ lastRun: FRESH });
    await advance(SYNC_POLL_MS);
    await settle();
    expect(radarUrls).toEqual([first, filtered, filtered]);
    expect(el.querySelector('[data-testid="sm-sync-result"]')).not.toBeNull();
    // "Sinkron terakhir" ikut diperbarui; tampilan Peta Benang tetap.
    expect(strip()).toContain('baru saja');
    expect(el.querySelector('ul.sm-radar').hidden).toBe(true);
    expect(el.querySelector('[data-testid="sm-threads"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Tampilan hasil radar"] input[value="benang"]').checked).toBe(true);
    expect(el.querySelectorAll('[data-testid="sm-radar-item"]')).toHaveLength(1);
  });
});
