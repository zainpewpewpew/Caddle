// Kontrak adapter provider smart money (docs/15 §3) dan utilitas HTTP bersama. Adapter adalah satu-satunya tempat
// I/O jaringan fitur ini. Modul ini TIDAK PERNAH mencatat log; URL di pesan error disamarkan dari kunci API, dan
// header (yang dapat memuat kunci) tidak pernah dimasukkan ke pesan error.

import { CHAINS, PROVIDER_CAPABILITIES } from '../contracts.js';
import { ProviderError, codeForStatus, parseRetryAfter, redactSecrets, toProviderError } from './errors.js';

/** Metode wajib setiap adapter (yang tidak didukung melempar ProviderError NOT_SUPPORTED). */
export const ADAPTER_METHODS = Object.freeze([
  'fetchWalletTransfers', 'fetchLabels', 'fetchPrices', 'discoverWallets', 'fetchBinanceMapping',
]);

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Periksa bentuk adapter terhadap kontrak.
 * @returns {string[]} daftar masalah (kosong = valid)
 */
export function validateAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object') return ['adapter harus objek'];
  const errors = [];
  if (typeof adapter.id !== 'string' || !PROVIDER_ID_RE.test(adapter.id)) errors.push('id harus huruf kecil/angka/-, 1..32 karakter');
  if (typeof adapter.displayName !== 'string' || adapter.displayName.trim() === '') errors.push('displayName wajib diisi');
  if (typeof adapter.requiresKey !== 'boolean') errors.push('requiresKey harus boolean');
  if (typeof adapter.isSimulated !== 'boolean') errors.push('isSimulated harus boolean');
  if (!Array.isArray(adapter.chains) || adapter.chains.length === 0 || adapter.chains.some((c) => !CHAINS.includes(c))) {
    errors.push('chains harus daftar tidak kosong dari CHAINS');
  }
  if (!(adapter.capabilities instanceof Set) || [...adapter.capabilities].some((c) => !PROVIDER_CAPABILITIES.includes(c))) {
    errors.push('capabilities harus Set bagian dari PROVIDER_CAPABILITIES');
  }
  const t = adapter.terms;
  if (t === null || typeof t !== 'object') {
    errors.push('terms wajib diisi');
  } else {
    if (t.docsUrl !== null && typeof t.docsUrl !== 'string') errors.push('terms.docsUrl harus string atau null');
    if (t.attribution !== null && typeof t.attribution !== 'string') errors.push('terms.attribution harus string atau null');
    if (typeof t.displayAllowed !== 'boolean') errors.push('terms.displayAllowed harus boolean');
    if (typeof t.notes !== 'string') errors.push('terms.notes harus string');
  }
  for (const m of ADAPTER_METHODS) {
    if (typeof adapter[m] !== 'function') errors.push(`metode ${m} wajib ada (lempar NOT_SUPPORTED bila tidak didukung)`);
  }
  return errors;
}

/**
 * Implementasi metode yang tidak didukung: fungsi async yang selalu menolak dengan ProviderError NOT_SUPPORTED.
 * Contoh: `fetchLabels: notSupported('blockscout', 'fetchLabels')`.
 */
export function notSupported(provider, method) {
  return async () => {
    throw new ProviderError('NOT_SUPPORTED', `${provider}: ${method} tidak didukung`, { provider });
  };
}

/** URL tanpa nilai parameter rahasia (untuk pesan error). */
export function redactUrl(url) {
  return redactSecrets(String(url));
}

/**
 * GET JSON dengan batas waktu. Semua kegagalan menjadi ProviderError (TIMEOUT / UNAUTHORIZED / RATE_LIMITED +
 * retryAfterMs / UNAVAILABLE / BAD_RESPONSE). Pesan error hanya memuat URL tersamar, tidak pernah header.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{ headers?: Record<string,string>, timeoutMs?: number, signal?: AbortSignal, provider: string }} options
 */
export async function fetchJson(fetchImpl, url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal, provider }) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const safeUrl = redactUrl(url);
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', ...headers }, signal: AbortSignal.any(signals) });
  } catch (err) {
    const e = toProviderError(err, provider);
    // Pesan error jaringan bawaan bisa memuat URL lengkap → bangun ulang dengan URL tersamar.
    if (e.code === 'UNAVAILABLE') throw new ProviderError('UNAVAILABLE', `${provider}: gagal menghubungi ${safeUrl}`, { provider });
    throw e;
  }
  if (!res.ok) {
    const code = codeForStatus(res.status);
    const retryAfterMs = code === 'RATE_LIMITED' ? parseRetryAfter(res.headers?.get?.('retry-after')) : null;
    throw new ProviderError(code, `${provider}: HTTP ${res.status} untuk ${safeUrl}`, { provider, retryAfterMs, status: res.status });
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw toProviderError(err, provider);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('BAD_RESPONSE', `${provider}: respons ${safeUrl} bukan JSON yang valid`, { provider });
  }
}
