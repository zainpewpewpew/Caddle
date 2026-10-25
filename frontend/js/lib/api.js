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
  }
}

export function setCsrfToken(token) {
  csrfToken = token;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, redirectOn401?: boolean, signal?: AbortSignal }} [options]
 */
export async function api(path, { method = 'GET', body, redirectOn401 = true, signal } = {}) {
  const headers = { Accept: 'application/json' };
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
