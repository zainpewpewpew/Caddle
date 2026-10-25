import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrfToken } from '../../frontend/js/lib/api.js';

const okJson = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('klien API frontend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('UNIT-API-001 opsi background menandai GET polling dengan X-LR-Background: 1', async () => {
    const fetchMock = vi.fn(async () => okJson());
    vi.stubGlobal('fetch', fetchMock);
    await api('/api/system/status', { background: true });
    expect(fetchMock.mock.calls[0][1].headers['X-LR-Background']).toBe('1');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin');
  });

  it('UNIT-API-002 request biasa dan request tidak aman tidak membawa header background', async () => {
    const fetchMock = vi.fn(async () => okJson());
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('csrf-x');
    await api('/api/overview');
    await api('/api/settings/scanner', { method: 'PUT', body: {}, background: true });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('X-LR-Background');
    expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty('X-LR-Background');
    expect(fetchMock.mock.calls[1][1].headers['X-CSRF-Token']).toBe('csrf-x');
  });
});
