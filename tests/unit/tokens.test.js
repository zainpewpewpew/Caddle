import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, isWellFormedToken, safeEqual } from '../../backend/auth/tokens.js';

describe('token sesi', () => {
  it('UNIT-TOK-001 token 256-bit base64url dan unik', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(isWellFormedToken(t)).toBe(true);
  });

  it('UNIT-TOK-002 hash SHA-256 heksadesimal 64 karakter dan deterministik', () => {
    const t = generateToken();
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
  });

  it.each([undefined, null, 123, '', 'short', 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}/`])(
    'NEG-TOK-001 token tidak valid ditolak: %s', (value) => {
      expect(isWellFormedToken(value)).toBe(false);
    });

  it('UNIT-TOK-003 safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
  });
});
