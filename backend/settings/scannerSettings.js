// Skema & default pengaturan scanner. Validasi dilakukan oleh JSON Schema di route
// (additionalProperties: false, tanpa coercion) ditambah aturan lintas-field di bawah.

export const SCANNER_SETTINGS_KEY = 'scanner';
export const TIMEFRAMES = Object.freeze(['5m', '15m', '1h']);
export const ALERT_STAGES = Object.freeze(['EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT']);

export const DEFAULT_SCANNER_SETTINGS = Object.freeze({
  symbols: { mode: 'auto', maxAuto: 40, manual: [] },
  timeframes: ['5m', '15m', '1h'],
  liquidity: { minQuoteVolume24h: 50_000_000, maxSpreadBps: 10 },
  refresh: { bootstrapCandles: 500, restBackfillIntervalSec: 300 },
  alerts: { enabled: false, minStage: 'EARLY_BULLISH' },
});

export const scannerSettingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['symbols', 'timeframes', 'liquidity', 'refresh', 'alerts'],
  properties: {
    symbols: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'maxAuto', 'manual'],
      properties: {
        mode: { type: 'string', enum: ['auto', 'manual'] },
        maxAuto: { type: 'integer', minimum: 10, maximum: 100 },
        manual: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[A-Z0-9]{2,20}USDT$' },
        },
      },
    },
    timeframes: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { type: 'string', enum: TIMEFRAMES },
    },
    liquidity: {
      type: 'object',
      additionalProperties: false,
      required: ['minQuoteVolume24h', 'maxSpreadBps'],
      properties: {
        minQuoteVolume24h: { type: 'number', minimum: 0, maximum: 1e12 },
        maxSpreadBps: { type: 'number', minimum: 0, maximum: 1000 },
      },
    },
    refresh: {
      type: 'object',
      additionalProperties: false,
      required: ['bootstrapCandles', 'restBackfillIntervalSec'],
      properties: {
        bootstrapCandles: { type: 'integer', minimum: 100, maximum: 1500 },
        restBackfillIntervalSec: { type: 'integer', minimum: 30, maximum: 3600 },
      },
    },
    alerts: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'minStage'],
      properties: {
        enabled: { type: 'boolean' },
        minStage: { type: 'string', enum: ALERT_STAGES },
      },
    },
  },
};

/** Aturan yang tidak dapat diekspresikan dengan JSON Schema. Mengembalikan daftar error. */
export function validateScannerSettingsRules(settings) {
  const errors = [];
  if (settings.symbols.mode === 'manual' && settings.symbols.manual.length === 0) {
    errors.push({ path: '/symbols/manual', message: 'Mode manual membutuhkan minimal satu simbol' });
  }
  return errors;
}

/** Urutkan timeframe secara kanonik agar penyimpanan deterministik. */
export function normalizeScannerSettings(settings) {
  return {
    ...settings,
    timeframes: TIMEFRAMES.filter((tf) => settings.timeframes.includes(tf)),
  };
}
