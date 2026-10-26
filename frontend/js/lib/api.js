// Klien API same-origin. Token CSRF disimpan di memori saja (bukan localStorage).
// Cookie sesi HttpOnly dikirim otomatis oleh browser.

let csrfToken = null;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error ?? 'UNKNOWN';
    this.details = body?.details ?? [];
    // Badan respons error apa adanya (mis. retryAfterMs / run pada 429/409 sinkronisasi smart money); null bila bukan JSON.
    this.body = body && typeof body === 'object' ? body : null;
  }
}

export function setCsrfToken(token) {
  csrfToken = token;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, redirectOn401?: boolean, signal?: AbortSignal, background?: boolean }} [options]
 *   `background`: polling otomatis (GET) yang tidak dihitung sebagai aktivitas pengguna,
 *   sehingga tidak memperpanjang idle timeout sesi.
 */
export async function api(path, { method = 'GET', body, redirectOn401 = true, signal, background = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (background && method === 'GET') headers['X-LR-Background'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (UNSAFE.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
  });

  if (res.status === 401 && redirectOn401) {
    window.location.assign('/login.html');
    throw new ApiError(401, { error: 'UNAUTHENTICATED' });
  }
  if (res.status === 204) return null;

  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
