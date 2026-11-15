// Praregistrasi AL-SA-ATR-01 (docs/26): konstanta beku, biaya & funding, kriteria keputusan, gerak awal, hash pohon kode.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AL_SA_ATR_01 as CFG, evaluateCriteria, netOutcome, preMoveAt } from '../../../backend/research/alSaAtr01.js';
import { codeTreeHash, frozenTreeHash } from '../../../scripts/research-al-sa-atr-01.js';

describe('AL-SA-ATR-01', () => {
  let dir;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('UNIT-ALSA-001 konstanta beku: jendela, aturan, biaya, semesta 100 simbol unik, ukuran sampel', () => {
    expect(Object.isFrozen(CFG)).toBe(true);
    expect(Object.isFrozen(CFG.universe)).toBe(true);
    expect(CFG).toMatchObject({
      direction: 'LONG', timeframe: '1h', preThresholdAtr: 2.7, look: 12, entry: 'nextOpen', targetR: 2, maxBars: 48,
      feeBps: 5, slippageBps: 2, stressFeeBps: 5, stressSlippageBps: 5, blockDays: 7, settleBars: 50, nRequired: 600,
    });
    expect(CFG.settleBars).toBeGreaterThanOrEqual(CFG.maxBars + 2); // semua trade sempat selesai sebelum cutoff
    expect(CFG.warmupDays * 24).toBeGreaterThanOrEqual(300 + 150); // ANALYSIS_LOOKBACK + BACKTEST_WARMUP
    expect(new Date(CFG.windowStart).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(new Date(CFG.maxWindowEnd).toISOString()).toBe('2027-11-16T00:00:00.000Z');
    expect(CFG.universe).toHaveLength(100);
    expect(new Set(CFG.universe).size).toBe(100);
    expect(CFG.universe.every((s) => /^[A-Z0-9]{1,30}USDT$/.test(s))).toBe(true); // mis. HUSDT
  });

  it('UNIT-ALSA-002 netOutcome: funding dikurangkan, biaya stres = biaya utama × (5+5)/(5+2)', () => {
    const t = { rMultiple: 1.9, grossR: 2, costR: 0.1 };
    const o = netOutcome(t, 0.05);
    expect(o.netR).toBeCloseTo(1.85, 12);
    expect(o.stressR).toBeCloseTo(2 - 0.1 * (10 / 7) - 0.05, 12);
  });

  it('UNIT-ALSA-003 evaluateCriteria: urutan vonis TIDAK SAH → TIDAK KONKLUSIF → LULUS / TIDAK LULUS', () => {
    const ok = { n: 700, nRequired: 600, main: { mean: 0.1, lo: 0.01 }, diff: { diff: 0.05, lo: 0.001 }, stressMean: 0.02, hashesMatch: true };
    expect(evaluateCriteria(ok).verdict).toBe('LULUS');
    expect(evaluateCriteria({ ...ok, hashesMatch: false }).verdict).toMatch(/^TIDAK SAH/);
    expect(evaluateCriteria({ ...ok, n: 599 }).verdict).toMatch(/^TIDAK KONKLUSIF/);
    expect(evaluateCriteria({ ...ok, main: { mean: 0.1, lo: -0.01 } })).toMatchObject({ P1: false, verdict: 'TIDAK LULUS' });
    expect(evaluateCriteria({ ...ok, diff: { diff: 0.05, lo: -0.01 } })).toMatchObject({ P2: false, verdict: 'TIDAK LULUS' });
    expect(evaluateCriteria({ ...ok, stressMean: -0.001 })).toMatchObject({ P3: false, verdict: 'TIDAK LULUS' });
    expect(evaluateCriteria({ ...ok, main: null }).verdict).toBe('TIDAK LULUS');
  });

  it('UNIT-ALSA-004 preMoveAt: (close[i] − close[i−12]) / ATR[i]; null bila data kurang', () => {
    const c = Array.from({ length: 20 }, (_, i) => ({ close: 100 + 2 * i }));
    const a = c.map(() => 4);
    expect(preMoveAt(c, a, 15)).toBeCloseTo(6, 12);
    expect(preMoveAt(c, a, 11)).toBeNull();
    expect(preMoveAt(c, a.map(() => 0), 15)).toBeNull();
  });

  it('UNIT-ALSA-005 hash pohon kode: deterministik, berubah bila isi berubah; hash beku dibaca dari dokumen', async () => {
    dir = await mkdtemp(join(tmpdir(), 'alsa-'));
    await mkdir(join(dir, 'backend', 'x'), { recursive: true });
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'backend', 'x', 'a.js'), 'export const a = 1;\n');
    await writeFile(join(dir, 'backend', 'b.js'), 'export const b = 2;\n');
    await writeFile(join(dir, 'backend', 'catatan.md'), 'bukan kode\n');
    await writeFile(join(dir, 'scripts', 'research-al-sa-atr-01.js'), '// skrip\n');
    const h1 = await codeTreeHash(dir);
    expect(h1.files).toBe(3);
    expect(await codeTreeHash(dir)).toEqual(h1);
    await writeFile(join(dir, 'backend', 'catatan.md'), 'diubah\n');
    expect((await codeTreeHash(dir)).hash).toBe(h1.hash); // hanya .js yang dihitung
    await writeFile(join(dir, 'backend', 'b.js'), 'export const b = 3;\n');
    expect((await codeTreeHash(dir)).hash).not.toBe(h1.hash);
    const doc = join(dir, 'doc.md');
    await writeFile(doc, `Hash pohon kode: \`${'ab'.repeat(32)}\`\n`);
    expect(await frozenTreeHash(doc)).toBe('ab'.repeat(32));
    await writeFile(doc, 'tanpa hash\n');
    expect(await frozenTreeHash(doc)).toBeNull();
  });
});
