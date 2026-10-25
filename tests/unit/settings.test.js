import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_SETTINGS, normalizeScannerSettings, validateScannerSettingsRules } from '../../backend/settings/scannerSettings.js';
import { validateSettings } from '../../frontend/js/lib/settingsValidation.js';

const clone = () => structuredClone(DEFAULT_SCANNER_SETTINGS);

describe('pengaturan scanner', () => {
  it('UNIT-SET-001 default lolos validasi server & klien', () => {
    expect(validateScannerSettingsRules(clone())).toEqual([]);
    expect(validateSettings(clone())).toEqual({});
  });

  it('NEG-SET-001 mode manual tanpa simbol ditolak', () => {
    const s = clone();
    s.symbols.mode = 'manual';
    expect(validateScannerSettingsRules(s)).toHaveLength(1);
    expect(validateSettings(s).manual).toBeDefined();
  });

  it('UNIT-SET-002 timeframe dinormalisasi ke urutan kanonik', () => {
    const s = clone();
    s.timeframes = ['1h', '5m'];
    expect(normalizeScannerSettings(s).timeframes).toEqual(['5m', '1h']);
  });

  it.each([
    ['timeframes kosong', (s) => { s.timeframes = []; }, 'timeframes'],
    ['simbol berformat salah', (s) => { s.symbols.manual = ['<script>']; }, 'manual'],
    ['maxAuto pecahan', (s) => { s.symbols.maxAuto = 10.5; }, 'maxAuto'],
    ['volume NaN', (s) => { s.liquidity.minQuoteVolume24h = Number.NaN; }, 'minQuoteVolume24h'],
    ['spread di atas batas', (s) => { s.liquidity.maxSpreadBps = 5000; }, 'maxSpreadBps'],
    ['bootstrap di bawah batas', (s) => { s.refresh.bootstrapCandles = 10; }, 'bootstrapCandles'],
  ])('NEG-SET-002 validasi klien menolak %s', (_label, mutate, field) => {
    const s = clone();
    mutate(s);
    expect(validateSettings(s)[field]).toBeDefined();
  });
});
