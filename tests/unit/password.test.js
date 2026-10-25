import { describe, expect, it } from 'vitest';
import { DEFAULT_ARGON2_OPTIONS, checkPasswordPolicy, createPasswordHasher } from '../../backend/auth/password.js';
import { TEST_HASHER_OPTIONS } from '../helpers/testApp.js';

describe('hashing kata sandi Argon2id', () => {
  const hasher = createPasswordHasher(TEST_HASHER_OPTIONS);

  it('UNIT-PWD-001 hash memakai varian argon2id dan salt acak', async () => {
    const a = await hasher.hash('correct-horse-battery-9');
    const b = await hasher.hash('correct-horse-battery-9');
    expect(a.startsWith('$argon2id$')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('UNIT-PWD-002 verifikasi benar/salah', async () => {
    const hash = await hasher.hash('correct-horse-battery-9');
    expect(await hasher.verify(hash, 'correct-horse-battery-9')).toBe(true);
    expect(await hasher.verify(hash, 'correct-horse-battery-0')).toBe(false);
  });

  it('NEG-PWD-001 hash rusak tidak melempar error, hanya false', async () => {
    expect(await hasher.verify('not-a-hash', 'x')).toBe(false);
  });

  it('UNIT-PWD-003 parameter produksi ≥ minimum OWASP (m=19MiB, t=2)', () => {
    expect(DEFAULT_ARGON2_OPTIONS.memoryCost).toBeGreaterThanOrEqual(19_456);
    expect(DEFAULT_ARGON2_OPTIONS.timeCost).toBeGreaterThanOrEqual(2);
  });

  it('UNIT-PWD-004 hash dengan parameter lemah terdeteksi perlu rehash', async () => {
    const weak = await hasher.hash('correct-horse-battery-9');
    expect(createPasswordHasher().needsRehash(weak)).toBe(true);
  });

  it.each([
    ['pendek', 'short', /Minimal/],
    ['terlalu panjang', 'a1b2c3d4e5'.repeat(13), /Maksimal/],
    ['memuat username', 'xx-mary-password-xx', /username/],
    ['variasi rendah', 'aaaaaaaaaaaaaaa', /Variasi/],
  ])('NEG-PWD-002 kebijakan menolak kata sandi %s', (_label, pwd, re) => {
    expect(checkPasswordPolicy(pwd, { username: 'mary' }).join(';')).toMatch(re);
  });

  it('EDGE-PWD-001 panjang dihitung per code point (emoji/Unicode)', () => {
    expect(checkPasswordPolicy('🔒🔑🛡️⚔️🗝️ab', {})).toContain('Minimal 12 karakter');
    expect(checkPasswordPolicy('kata-sandi-ünïcødé', {})).toEqual([]);
  });
});
