import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLASSIFICATIONS, RISK_FLAGS, TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import {
  DEFAULT_PVA_PARAMS,
  DEFAULT_SA_PARAMS,
  PatternParamsError,
  classify,
  detectProgressiveVolume,
  detectSilentAccumulation,
  evaluatePatterns,
  requiredCandles,
} from '../../../backend/patterns/index.js';
import {
  bothPatternsCandles,
  downtrendCandles,
  extremeVolatilityCandles,
  flatCandles,
  progressiveVolumeCandles,
  silentAccumulationCandles,
  zigzag,
} from '../../fixtures/candles/scenarios.js';
import { generateCandles } from '../../fixtures/candles/synthetic.js';
import { confirmedAt, findSwings, trailingHigherLows } from '../../../backend/indicators/index.js';
import { SWING_OPTIONS } from '../../../backend/patterns/conditions.js';

// Semua candle berasal dari generator sintetis — bukan data pasar nyata.
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const SCENARIOS = {
  silentAccumulationCandles,
  progressiveVolumeCandles,
  bothPatternsCandles,
  flatCandles,
  downtrendCandles,
  extremeVolatilityCandles,
};

/** Sambungkan candle "masa depan" sintetis setelah candle terakhir `base`. */
function withFuture(base, seed, segment) {
  const last = base.at(-1);
  const future = generateCandles({
    seed,
    startTime: last.openTime + TIMEFRAME_MS[last.timeframe],
    startPrice: last.close,
    segments: [segment],
  });
  return [...base, ...future];
}

describe('evaluatePatterns', () => {
  it('POS-PEVL-001 klasifikasi SA | PVA | BOTH | NONE sesuai skenario pada semua seed', () => {
    for (const seed of SEEDS) {
      expect(evaluatePatterns(silentAccumulationCandles(seed)).classification, `SA s${seed}`).toBe('SA');
      expect(evaluatePatterns(progressiveVolumeCandles(seed)).classification, `PVA s${seed}`).toBe('PVA');
      expect(evaluatePatterns(bothPatternsCandles(seed)).classification, `BOTH s${seed}`).toBe('BOTH');
      expect(evaluatePatterns(flatCandles(seed)).classification).toBe('NONE');
      expect(evaluatePatterns(downtrendCandles(seed)).classification).toBe('NONE');
      expect(evaluatePatterns(extremeVolatilityCandles(seed)).classification).toBe('NONE');
    }
  });

  it('POS-PEVL-002 BOTH: kedua hasil terdeteksi dengan invalidationPrice di bawah close', () => {
    const candles = bothPatternsCandles(3);
    const { sa, pva } = evaluatePatterns(candles);
    for (const r of [sa, pva]) {
      expect(r.detected).toBe(true);
      expect(r.invalidationPrice).toBeLessThan(candles.at(-1).close);
      expect(r.evaluatedAt).toBe(candles.at(-1).closeTime);
    }
  });

  it('UNIT-PEVL-001 tabel kebenaran klasifikasi', () => {
    expect(classify(true, true)).toBe('BOTH');
    expect(classify(true, false)).toBe('SA');
    expect(classify(false, true)).toBe('PVA');
    expect(classify(false, false)).toBe('NONE');
  });

  it('UNIT-PEVL-002 detektor independen: hasil sama dengan pemanggilan terpisah, parameter satu pola tidak memengaruhi pola lain', () => {
    const candles = bothPatternsCandles(2);
    const combined = evaluatePatterns(candles);
    expect(combined.sa).toEqual(detectSilentAccumulation(candles));
    expect(combined.pva).toEqual(detectProgressiveVolume(candles));
    const pvaStrict = evaluatePatterns(candles, { pva: { minVolumeGrowth: 10 } });
    expect(pvaStrict.sa).toEqual(combined.sa);
    expect(pvaStrict.pva.detected).toBe(false);
    expect(pvaStrict.classification).toBe('SA');
    const saStrict = evaluatePatterns(candles, { sa: { maxAvgRvol: 0.2 } });
    expect(saStrict.pva).toEqual(combined.pva);
    expect(saStrict.classification).toBe('PVA');
  });

  it('UNIT-PEVL-003 modul detektor tidak saling mengimpor', () => {
    const read = (f) => readFileSync(new URL(`../../../backend/patterns/${f}`, import.meta.url), 'utf8');
    expect(read('silentAccumulation.js')).not.toMatch(/progressiveVolume|detectProgressiveVolume/);
    expect(read('progressiveVolume.js')).not.toMatch(/silentAccumulation|detectSilentAccumulation/);
    expect(read('conditions.js')).not.toMatch(/silentAccumulation|progressiveVolume/);
  });

  it('UNIT-PEVL-004 anti lookahead: anchor & higher low pada prefix k = swing low deret PENUH (dengan masa depan) yang confirmedIndex ≤ k−1', () => {
    // Buffer invalidasi 0 → invalidationPrice = anchor struktur persis, sehingga swing yang dipakai
    // detektor dapat dibandingkan dengan model acuan. Acuan dihitung dari deret penuh (termasuk
    // candle masa depan yang mengubah swing di tepi prefix) lalu disaring confirmedAt(k − 1).
    // Detektor yang memakai swing tepi yang belum terkonfirmasi (repaint) atau mengintip candle
    // sesudah k akan berbeda dari acuan.
    const opts = { sa: { invalidationBufferAtr: 0 }, pva: { invalidationBufferAtr: 0 } };
    const windows = { SA: DEFAULT_SA_PARAMS.priceLookback, PVA: DEFAULT_PVA_PARAMS.subWindows * DEFAULT_PVA_PARAMS.subWindowLength };
    const minK = Math.max(requiredCandles('SA', DEFAULT_SA_PARAMS), requiredCandles('PVA', DEFAULT_PVA_PARAMS));
    const expectedStructure = (prefix, lows, window) => {
      const last = prefix.length - 1;
      const close = prefix[last].close;
      const from = Math.max(0, last - window + 1);
      const lastLow = lows.at(-1);
      // Struktur utuh: close di atas swing low DAN tidak ada low sesudahnya yang menembusnya.
      const unbroken = lastLow && prefix.slice(lastLow.index + 1).every((c) => c.low >= lastLow.price);
      if (lastLow && lastLow.index >= from && unbroken && close > lastLow.price) return { anchor: lastLow.price, higherLows: trailingHigherLows(lows) };
      let idx = from;
      for (let i = from + 1; i <= last; i += 1) if (prefix[i].low < prefix[idx].low) idx = i;
      return { anchor: prefix[idx].low, higherLows: 0 };
    };
    const base = bothPatternsCandles(1);
    const futures = [
      withFuture(base, 11, { bars: 30, drift: -0.01, volume: 5000, wick: 0.01 }),
      withFuture(base, 12, { bars: 30, drift: 0.01, volume: 200 }),
      withFuture(base, 13, { bars: 30, cycle: zigzag(2, 0.003, 2, 0.004), wick: 0.002, volume: 800 }),
    ];
    let checked = 0;
    let peekDiffers = 0;
    for (const full of futures) {
      const swings = findSwings(full, SWING_OPTIONS);
      for (let k = minK; k <= full.length; k += 1) {
        const prefix = full.slice(0, k);
        const r = evaluatePatterns(prefix, opts);
        for (const p of [r.sa, r.pva]) {
          const exp = expectedStructure(prefix, confirmedAt(swings, k - 1).lows, windows[p.pattern]);
          const at = `${p.pattern} prefix ${k}`;
          expect(p.conditions.find((c) => c.id === 'higherLows').value, at).toBe(exp.higherLows);
          expect(p.invalidationPrice, at).toBe(exp.anchor < prefix.at(-1).close ? exp.anchor : null);
          checked += 1;
          // Kontrol: acuan yang mengintip `right` candle masa depan memberi anchor berbeda di sini.
          const peekLows = swings.lows.filter((s) => s.index <= k - 1 && s.confirmedIndex <= k - 1 + SWING_OPTIONS.right);
          if (expectedStructure(prefix, peekLows, windows[p.pattern]).anchor !== exp.anchor) peekDiffers += 1;
        }
      }
    }
    expect(checked).toBe(futures.length * 2 * (base.length + 30 - minK + 1));
    // Skenario memang peka lookahead: ada banyak indeks di mana swing yang belum terkonfirmasi mengubah anchor.
    expect(peekDiffers).toBeGreaterThan(20);
  });

  it('UNIT-PEVL-005 deterministik: input sama → output identik (termasuk serialisasi)', () => {
    for (const seed of [1, 5]) {
      const a = evaluatePatterns(bothPatternsCandles(seed));
      const b = evaluatePatterns(bothPatternsCandles(seed));
      expect(b).toEqual(a);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  it('EDGE-PEVL-001 invarian walk-forward: skor dalam [0,100], invalidasi di (0, close), flag & klasifikasi valid', () => {
    const minSa = requiredCandles('SA', DEFAULT_SA_PARAMS);
    const minPva = requiredCandles('PVA', DEFAULT_PVA_PARAMS);
    for (const make of Object.values(SCENARIOS)) {
      for (const seed of [1, 2, 3]) {
        const candles = make(seed);
        for (let k = 0; k <= candles.length; k += 1) {
          const prefix = candles.slice(0, k);
          const r = evaluatePatterns(prefix);
          expect(CLASSIFICATIONS).toContain(r.classification);
          expect(r.sa.insufficientData).toBe(k < minSa);
          expect(r.pva.insufficientData).toBe(k < minPva);
          for (const p of [r.sa, r.pva]) {
            expect(p.patternScore).toBeGreaterThanOrEqual(0);
            expect(p.patternScore).toBeLessThanOrEqual(100);
            expect(p.earlyScore).toBeGreaterThanOrEqual(0);
            expect(p.earlyScore).toBeLessThanOrEqual(100);
            if (p.invalidationPrice !== null) {
              expect(p.invalidationPrice).toBeGreaterThan(0);
              expect(p.invalidationPrice).toBeLessThan(prefix.at(-1).close);
            }
            expect(p.riskFlags).toEqual(RISK_FLAGS.filter((f) => p.riskFlags.includes(f)));
            if (p.detected) expect(p.insufficientData).toBe(false);
          }
        }
      }
    }
  });

  it('EDGE-PEVL-002 opsi kosong/null setara default; parameter tidak valid tetap ditolak', () => {
    const candles = silentAccumulationCandles(2);
    const expected = evaluatePatterns(candles);
    expect(evaluatePatterns(candles, null)).toEqual(expected);
    expect(evaluatePatterns(candles, {})).toEqual(expected);
    expect(evaluatePatterns(candles, { sa: DEFAULT_SA_PARAMS, pva: DEFAULT_PVA_PARAMS })).toEqual(expected);
    expect(() => evaluatePatterns(candles, { sa: { minScore: 200 } })).toThrow(PatternParamsError);
    expect(() => evaluatePatterns(candles, { pva: { subWindowLength: 0 } })).toThrow(PatternParamsError);
  });

  it('EDGE-PEVL-003 data cukup untuk SA (63) tetapi belum untuk PVA (70) → PVA insufficientData', () => {
    const candles = silentAccumulationCandles(1).slice(-66);
    const r = evaluatePatterns(candles);
    expect(r.sa.insufficientData).toBe(false);
    expect(r.pva).toMatchObject({ insufficientData: true, detected: false });
    expect(r.classification).toBe(r.sa.detected ? 'SA' : 'NONE');
  });

  it('EDGE-PEVL-004 harga jatuh menembus struktur → klasifikasi kembali NONE', () => {
    const base = silentAccumulationCandles(4);
    expect(evaluatePatterns(base).classification).toBe('SA');
    const broken = withFuture(base, 21, { bars: 6, cycle: zigzag(0, 0, 1, 0.006), volume: 450 });
    const r = evaluatePatterns(broken);
    expect(r.classification).toBe('NONE');
    expect(r.sa.invalidationPrice === null || r.sa.invalidationPrice < broken.at(-1).close).toBe(true);
  });
});
