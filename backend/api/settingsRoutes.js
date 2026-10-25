import {
  DEFAULT_SCANNER_SETTINGS,
  SCANNER_SETTINGS_KEY,
  normalizeScannerSettings,
  scannerSettingsSchema,
  validateScannerSettingsRules,
} from '../settings/scannerSettings.js';

const putBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'settings'],
  properties: {
    version: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    settings: scannerSettingsSchema,
  },
};

export async function settingsRoutes(app, { settings, audit, clock }) {
  app.get('/api/settings/scanner', async () => {
    const record = await settings.get(SCANNER_SETTINGS_KEY);
    return record
      ? { version: record.version, settings: record.value, updatedAt: record.updatedAt, isDefault: false }
      : { version: 0, settings: DEFAULT_SCANNER_SETTINGS, updatedAt: null, isDefault: true };
  });

  app.put('/api/settings/scanner', {
    config: { roles: ['admin'] },
    schema: { body: putBodySchema },
  }, async (request, reply) => {
    const errors = validateScannerSettingsRules(request.body.settings);
    if (errors.length) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Input tidak valid', details: errors });
    }
    const value = normalizeScannerSettings(request.body.settings);
    const userId = request.auth.user.id;
    const record = await settings.save(SCANNER_SETTINGS_KEY, value, {
      expectedVersion: request.body.version,
      userId,
      now: clock(),
    });
    if (!record) {
      return reply.code(409).send({ error: 'VERSION_CONFLICT', message: 'Pengaturan telah diubah pengguna lain. Muat ulang lalu coba lagi.' });
    }
    await audit.record({
      occurredAt: clock(), userId, action: 'settings.scanner.update', outcome: 'success', ip: request.ip,
      detail: { version: record.version },
    });
    return { version: record.version, settings: record.value, updatedAt: record.updatedAt, isDefault: false };
  });
}
