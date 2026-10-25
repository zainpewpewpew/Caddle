import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_SETTINGS } from '../../backend/settings/scannerSettings.js';
import { parseNumberInput, validateSettings } from '../../frontend/js/lib/settingsValidation.js';
import { settingsFromFormData } from '../../frontend/js/views/settings.js';

const NUMBER_FIELDS = ['maxAuto', 'minQuoteVolume24h', 'maxSpreadBps', 'bootstrapCandles', 'restBackfillIntervalSec'];

/** FormData seperti yang dikirim form pengaturan, dari pengaturan default. */
function defaultFormData(overrides = {}) {
  const s = DEFAULT_SCANNER_SETTINGS;
  const fd = new FormData();
  const fields = {
    mode: s.symbols.mode,
    maxAuto: String(s.symbols.maxAuto),
    manual: s.symbols.manual.join(', '),
    minQuoteVolume24h: String(s.liquidity.minQuoteVolume24h),
    maxSpreadBps: String(s.liquidity.maxSpreadBps),
    bootstrapCandles: String(s.refresh.bootstrapCandles),
    restBackfillIntervalSec: String(s.refresh.restBackfillIntervalSec),
    minStage: s.alerts.minStage,
    ...overrides,
  };
  for (const [name, value] of Object.entries(fields)) fd.append(name, value);
  for (const tf of s.timeframes) fd.append('timeframes', tf);
  if (s.alerts.enabled) fd.append('alertsEnabled', 'on');
  return fd;
}

describe('pembacaan form pengaturan', () => {
  it('UNIT-SET-003 form default terbaca sama dengan pengaturan default dan lolos validasi', () => {
    const settings = settingsFromFormData(defaultFormData());
    expect(settings).toEqual(DEFAULT_SCANNER_SETTINGS);
    expect(validateSettings(settings)).toEqual({});
  });

  it('EDGE-SET-004 input angka kosong/spasi/null menjadi NaN, bukan 0', () => {
    for (const raw of ['', '   ', '\t', null, undefined]) expect(parseNumberInput(raw)).toBeNaN();
    expect(parseNumberInput('0')).toBe(0);
    expect(parseNumberInput(' 42 ')).toBe(42);
    expect(parseNumberInput('2.5')).toBe(2.5);
  });

  it.each(NUMBER_FIELDS)('NEG-SET-003 field %s yang dikosongkan ditolak dengan pesan wajib diisi', (field) => {
    const settings = settingsFromFormData(defaultFormData({ [field]: '' }));
    const errors = validateSettings(settings);
    expect(Object.keys(errors)).toEqual([field]);
    expect(errors[field]).toMatch(/^Wajib diisi/);
  });

  it('NEG-SET-004 min. volume 24j yang dikosongkan tidak pernah menjadi 0', () => {
    const settings = settingsFromFormData(defaultFormData({ minQuoteVolume24h: '  ' }));
    expect(settings.liquidity.minQuoteVolume24h).not.toBe(0);
    expect(validateSettings(settings).minQuoteVolume24h).toBeDefined();
  });

  it('EDGE-SET-005 nilai 0 yang diketik eksplisit tetap sah bila rentangnya mengizinkan', () => {
    const settings = settingsFromFormData(defaultFormData({ minQuoteVolume24h: '0', maxSpreadBps: '0' }));
    expect(settings.liquidity).toEqual({ minQuoteVolume24h: 0, maxSpreadBps: 0 });
    expect(validateSettings(settings)).toEqual({});
  });
});
