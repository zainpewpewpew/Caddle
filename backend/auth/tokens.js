import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;
// 32 byte → 43 karakter base64url tanpa padding.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isWellFormedToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Perbandingan string konstan-waktu. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
