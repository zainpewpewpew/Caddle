import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { createFixtureProvider } from '../../../backend/smartmoney/providers/fixtureProvider.js';
import { createLiveProviderRegistry } from '../../../backend/smartmoney/providers/live.js';
import { createSmartMoneyRepository } from '../../../backend/smartmoney/repository.js';
import {
  EVALUATE_USAGE, EVALUATION_WARMUP_MS, THIN_DATA, assessData, evaluationRange, main as evaluateMain, parseEvaluateArgs,
} from '../../../scripts/smart-money-evaluate.js';
import {
  SYNC_USAGE, createCliLogger, createSyncDeps, formatSyncSummary, main as syncMain, noProviderMessage, parseSyncArgs,
} from '../../../scripts/smart-money-sync.js';
import { buildScenario } from '../../fixtures/smartmoney/scenario.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SCENARIO = buildScenario();
const clock = () => SCENARIO.now;

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (t) => out.push(t), err: (t) => err.push(t) }, text: () => out.join('\n'), errText: () => err.join('\n') };
}

/** Registri dengan fixture (DATA SIMULASI) — hanya sah karena NODE_ENV=test. */
const fixtureRegistry = (cfg) => createLiveProviderRegistry(cfg, { clock, extraAdapters: [createFixtureProvider(SCENARIO)] });

describe('CLI sinkronisasi smart money (scripts/smart-money-sync.js)', () => {
  let dir;
  let env;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'alphalens-sm-cli-'));
    env = { NODE_ENV: 'test', DATABASE_PATH: join(dir, 'app.db') };
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('UNIT-SM-CLI-001 parseSyncArgs: bawaan, --loop, --verbose, -h; opsi asing / argumen posisi ditolak', () => {
    expect(parseSyncArgs([])).toEqual({ loop: false, verbose: false, help: false });
    expect(parseSyncArgs(['--loop', '--verbose'])).toEqual({ loop: true, verbose: true, help: false });
    expect(parseSyncArgs(['-h'])).toMatchObject({ help: true });
    expect(() => parseSyncArgs(['--interval', '5'])).toThrow(/Opsi tidak dikenal/);
    expect(() => parseSyncArgs(['sekarang'])).toThrow(TypeError);
    expect(SYNC_USAGE).toContain('--loop');
  });

  it('UNIT-SM-CLI-002 tanpa provider → kode 0, penjelasan Bahasa Indonesia, database TIDAK dibuat', async () => {
    const c = capture();
    expect(await syncMain([], { env, clock, ...c.io })).toBe(0);
    expect(c.text()).toContain('Belum ada sumber data smart money yang aktif');
    expect(c.text()).toContain('SMART_MONEY_PROVIDERS belum diisi');
    expect(c.text()).toContain('Tidak ada data contoh/simulasi');
    expect(c.text()).toContain('Mengaktifkan data live (jalur gratis)');
    expect(existsSync(env.DATABASE_PATH)).toBe(false);
  });

  it('UNIT-SM-CLI-003 provider dikonfigurasi tetapi belum tersedia → alasan per id, kode 0, tanpa data simulasi', async () => {
    const c = capture();
    expect(await syncMain([], { env: { ...env, SMART_MONEY_PROVIDERS: 'etherscan,fixture' }, clock, ...c.io })).toBe(0);
    expect(c.text()).toContain('SMART_MONEY_PROVIDERS: etherscan, fixture');
    expect(c.text()).toMatch(/etherscan: Adapter untuk id ini belum dirakit/);
    expect(c.text()).toMatch(/fixture: Provider fixture \(data simulasi\) hanya tersedia di tes/);
    expect(existsSync(env.DATABASE_PATH)).toBe(false);
    expect(noProviderMessage({ smartMoney: { providers: [] } }, null)).toContain('belum diisi');
  });

  it('UNIT-SM-CLI-004 satu putaran dengan provider fixture: ringkasan bertanda DATA SIMULASI, data tersimpan, tanpa harga live', async () => {
    const c = capture();
    let restCreated = 0;
    const code = await syncMain([], {
      env: { ...env, SMART_MONEY_PROVIDERS: 'fixture' }, clock, ...c.io, createRegistry: fixtureRegistry,
      createRest: () => { restCreated += 1; return { getKlines: async () => [] }; },
    });
    expect(code).toBe(0);
    expect(c.text()).toMatch(/^Sinkronisasi smart money: berhasil \(2026-10-01 12:00 UTC, 0,0 dtk\) — DATA SIMULASI/);
    expect(c.text()).toMatch(/Provider fixture: OK/);
    expect(c.text()).toMatch(/Transfer: \d+ diambil · \d+ aktivitas baru/);
    expect(restCreated).toBe(0); // data simulasi tidak pernah dinilai dengan harga live
    const db = openDatabase(env.DATABASE_PATH);
    try {
      const repo = createSmartMoneyRepository(db, { clock });
      expect((await repo.coverage()).activities).toBeGreaterThan(0);
      expect(await repo.hasSimulatedData()).toBe(true);
    } finally {
      db.close();
    }
  });

  it('UNIT-SM-CLI-005 --loop: putaran pertama langsung, ringkasan via onRun, berhenti bersih saat diminta', async () => {
    const c = capture();
    const code = await syncMain(['--loop'], {
      env: { ...env, SMART_MONEY_PROVIDERS: 'fixture', SMART_MONEY_SYNC_MINUTES: '20' }, clock, ...c.io, createRegistry: fixtureRegistry,
      waitForStop: (loop) => loop.runNow(),
    });
    expect(code).toBe(0);
    const text = c.text();
    expect(text).toContain('Loop sinkronisasi smart money aktif (setiap 20 menit; provider: fixture)');
    expect(text).toMatch(/Sinkronisasi smart money: berhasil .* — DATA SIMULASI/);
    expect(text).toContain('Putaran berikutnya ± 20 menit lagi');
    expect(text.trim().endsWith('Loop sinkronisasi smart money berhenti.')).toBe(true);
  });

  it('UNIT-SM-CLI-006 argumen / konfigurasi tidak valid → kode 1 dengan pesan jelas; --help → kode 0', async () => {
    const c = capture();
    expect(await syncMain(['--bogus'], { env, clock, ...c.io })).toBe(1);
    expect(c.errText()).toContain('Opsi tidak dikenal');
    expect(await syncMain([], { env: { ...env, SMART_MONEY_SYNC_MINUTES: '1' }, clock, ...c.io })).toBe(1);
    expect(c.errText()).toContain('Konfigurasi tidak valid: SMART_MONEY_SYNC_MINUTES');
    const h = capture();
    expect(await syncMain(['--help'], { env, clock, ...h.io })).toBe(0);
    expect(h.text()).toBe(SYNC_USAGE);
  });

  it('UNIT-SM-CLI-007 formatSyncSummary: status, error disaring (tanpa URL/kunci), catatan, ringkasan kosong', () => {
    const text = formatSyncSummary({
      status: 'DEGRADED', startedAt: Date.UTC(2026, 9, 1, 12), finishedAt: Date.UTC(2026, 9, 1, 12, 0, 3, 200),
      fetched: 10, inserted: 4, reclassified: 1, duplicates: 2, rejected: 0, alerts: 1, scored: 3, links: 0,
      wallets: { tracked: 3, selected: 3, synced: 2, failed: 1, deferred: 0, skippedNoProvider: 0 },
      discovery: { candidates: 0, added: 0, skippedChains: [] }, mapping: { refreshed: [], upserted: 0, rejected: 0 },
      providers: [{ id: 'contoh', calls: 5, ok: 4, failed: 1, notSupported: 0, lastErrorCode: 'TIMEOUT', state: 'DEGRADED' }],
      errors: [{ provider: 'contoh', code: 'TIMEOUT', method: 'fetchWalletTransfers', chain: 'base', message: 'habis waktu https://x.io/?apikey=RAHASIA' }],
      notes: ['1 wallet ditunda.'],
    });
    expect(text).toContain('Sinkronisasi smart money: selesai dengan gangguan sebagian (2026-10-01 12:00 UTC, 3,2 dtk)');
    expect(text).toContain('Wallet: 3 dilacak · 3 dipilih · 2 tersinkron · 1 gagal · 0 ditunda');
    expect(text).toContain('Provider contoh: DEGRADED · 5 panggilan · 4 berhasil · 1 gagal · error terakhir TIMEOUT');
    expect(text).toContain('Error [contoh/fetchWalletTransfers/base]: TIMEOUT — habis waktu [url]');
    expect(text).not.toContain('RAHASIA');
    expect(text).toContain('Catatan: 1 wallet ditunda.');
    expect(text).not.toContain('DATA SIMULASI');
    const none = formatSyncSummary({ status: 'NO_PROVIDERS', startedAt: 0, finishedAt: 0, notes: ['Belum ada provider.'] });
    expect(none).toContain('tidak ada provider aktif');
    expect(none).not.toContain('Wallet:');
    expect(formatSyncSummary(null)).toMatch(/tidak ada ringkasan/);
  });

  it('UNIT-SM-CLI-008 createSyncDeps: harga native per jam hanya untuk adapter live; createCliLogger menyaring level', async () => {
    let created = 0;
    const createRest = () => { created += 1; return { getKlines: async () => [] }; };
    expect(createSyncDeps({ list: () => [{ id: 'fixture', isSimulated: true }] }, { createRest })).toEqual({ nativePrices: null, enrichNativeUsd: null });
    expect(created).toBe(0);
    const deps = createSyncDeps({ list: () => [{ id: 'contoh', isSimulated: false }] }, { createRest });
    expect(created).toBe(1);
    expect(typeof deps.nativePrices.priceAt).toBe('function');
    expect(typeof deps.enrichNativeUsd).toBe('function');

    const lines = [];
    const quiet = createCliLogger({ write: (l) => lines.push(l) });
    quiet.info({ a: 1 }, 'tidak tampil');
    quiet.warn({ provider: 'contoh', err: new Error('gagal https://x.io/?k=RAHASIA') }, 'panggilan gagal');
    quiet.error('pesan', { n: 2, obj: { b: [1] } });
    expect(lines).toEqual([
      '[peringatan] panggilan gagal · provider=contoh err=gagal [url]',
      '[error] pesan · n=2 obj={"b":[1]}',
    ]);
    const verbose = createCliLogger({ verbose: true, write: (l) => lines.push(l) });
    verbose.debug({}, 'detail');
    expect(lines.at(-1)).toBe('[debug] detail');
  });
});

describe('CLI evaluasi smart money (scripts/smart-money-evaluate.js)', () => {
  let dir;
  let env;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'alphalens-sm-eval-'));
    env = { NODE_ENV: 'test', DATABASE_PATH: join(dir, 'app.db'), SMART_MONEY_PROVIDERS: 'fixture' };
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const latestEvaluation = async () => {
    const db = openDatabase(env.DATABASE_PATH);
    try {
      return await createSmartMoneyRepository(db, { clock }).latestEvaluation();
    } finally {
      db.close();
    }
  };

  it('UNIT-SM-CLI-009 parseEvaluateArgs: bawaan & rentang yang sah', () => {
    expect(parseEvaluateArgs([])).toEqual({ help: false, days: 60, stepHours: 6, minBuyers: 3, save: true });
    expect(parseEvaluateArgs(['--days', '90', '--step-hours', '12', '--min-buyers', '4', '--no-save']))
      .toEqual({ help: false, days: 90, stepHours: 12, minBuyers: 4, save: false });
    expect(parseEvaluateArgs(['-h']).help).toBe(true);
    for (const bad of [['--days', '6'], ['--days', '181'], ['--days', '7.5'], ['--step-hours', '0'], ['--step-hours', '25'],
      ['--min-buyers', '0'], ['--min-buyers', 'tiga'], ['--hari', '5'], ['posisi']]) {
      expect(() => parseEvaluateArgs(bad), bad.join(' ')).toThrow(/--|Opsi tidak dikenal/);
    }
    expect(EVALUATE_USAGE).toContain('--no-save');
  });

  it('UNIT-SM-CLI-010 assessData & evaluationRange: ambang data tipis, pemanasan, horizon, dan pembulatan jam', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const acts = (n, wallets, spanDays) => Array.from({ length: n }, (_, i) => ({
      chain: 'ethereum', wallet: `w${i % wallets}`, blockTime: t0 + Math.round((spanDays * DAY * i) / Math.max(1, n - 1)),
    }));
    expect(assessData(acts(THIN_DATA.minActivities, THIN_DATA.minWallets, THIN_DATA.minSpanDays))).toMatchObject({ ok: true, reasons: [] });
    const thin = assessData(acts(10, 2, 3));
    expect(thin.ok).toBe(false);
    expect(thin.reasons).toHaveLength(3);
    expect(thin.reasons.join(' ')).toMatch(/10 aktivitas.*2 wallet.*3,0 hari/);
    expect(assessData([])).toMatchObject({ ok: false, activities: 0, wallets: 0, firstAt: null, spanDays: 0 });

    const firstAt = t0 + 30 * 60_000; // 00:30
    const lastAt = t0 + 100 * DAY + 30 * 60_000;
    const r = evaluationRange({ firstAt, lastAt, days: 60, now: lastAt + DAY });
    expect(r.end).toBe(t0 + 97 * DAY); // terakhir + 1 ms − 3 hari, dibulatkan ke bawah per jam
    expect(r.start).toBe(t0 + 37 * DAY); // end − 60 hari (lebih lambat dari pemanasan 30 hari)
    const short = evaluationRange({ firstAt, lastAt: firstAt + 40 * DAY, days: 60, now: lastAt });
    expect(short.start).toBe(firstAt - 30 * 60_000 + EVALUATION_WARMUP_MS + HOUR); // pertama + 30 hari, dibulatkan ke atas
    expect(evaluationRange({ firstAt, lastAt: firstAt + 31 * DAY, days: 60, now: lastAt })).toBeNull();
    // `now` membatasi data dari masa depan (jam tidak sinkron).
    expect(evaluationRange({ firstAt, lastAt, days: 60, now: t0 + 90 * DAY }).end).toBe(t0 + 87 * DAY);
  });

  it('UNIT-SM-CLI-011 data tipis → penolakan sopan, kode 0, tidak ada laporan yang disimpan', async () => {
    const c = capture();
    expect(await evaluateMain([], { env, clock, ...c.io })).toBe(0);
    expect(c.text()).toContain('Data smart money belum cukup untuk evaluasi historis yang bermakna');
    expect(c.text()).toContain('npm run smart-money:sync');
    expect(c.text()).not.toContain('# Laporan Evaluasi');
    expect(await latestEvaluation()).toBeNull();
  });

  it('UNIT-SM-CLI-012 data cukup: laporan Markdown dicetak & disimpan (DATA SIMULASI ditandai); --no-save tidak menyimpan', async () => {
    expect(await syncMain([], { env, clock, ...capture().io, createRegistry: fixtureRegistry })).toBe(0);

    const dry = capture();
    expect(await evaluateMain(['--no-save'], { env, clock, ...dry.io })).toBe(0);
    expect(dry.text()).toContain('# Laporan Evaluasi Historis — Smart Money Radar');
    expect(dry.errText()).toContain('tidak disimpan');
    expect(await latestEvaluation()).toBeNull();

    const c = capture();
    expect(await evaluateMain(['--days', '30', '--step-hours', '12'], { env, clock, ...c.io })).toBe(0);
    expect(c.text()).toContain('**DATA SIMULASI**');
    expect(c.errText()).toMatch(/Laporan disimpan \(id \d+\)/);
    const saved = await latestEvaluation();
    expect(saved).toMatchObject({ computedAt: SCENARIO.now, isSimulated: true });
    expect(saved.report.kind).toBe('smart-money-evaluation');
    expect(saved.params).toMatchObject({ stepMs: 12 * HOUR, minIndependentBuyers: 3 });
    expect(saved.params.end - saved.params.start).toBe(30 * DAY);
    expect(saved.params.end).toBeLessThanOrEqual(SCENARIO.now - 3 * DAY);
  });
});
