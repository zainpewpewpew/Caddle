import argon2 from 'argon2';

// Parameter Argon2id. Nilai default melebihi minimum OWASP Password Storage Cheat Sheet
// (m=19 MiB, t=2, p=1). Dapat diturunkan HANYA untuk pengujian.
export const DEFAULT_ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 65_536, // KiB = 64 MiB
  timeCost: 3,
  parallelism: 1,
});

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Validasi kebijakan kata sandi. Mengembalikan daftar pelanggaran (kosong bila valid).
 * @param {string} password
 * @param {{ username?: string }} [context]
 */
export function checkPasswordPolicy(password, { username } = {}) {
  const problems = [];
  if (typeof password !== 'string') return ['Kata sandi harus berupa teks'];
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) problems.push(`Minimal ${PASSWORD_MIN_LENGTH} karakter`);
  if (length > PASSWORD_MAX_LENGTH) problems.push(`Maksimal ${PASSWORD_MAX_LENGTH} karakter`);
  if (username && password.toLowerCase().includes(username.toLowerCase())) problems.push('Tidak boleh memuat username');
  if (new Set(password).size < 5) problems.push('Variasi karakter terlalu sedikit');
  return problems;
}

export function createPasswordHasher(options = DEFAULT_ARGON2_OPTIONS) {
  const opts = { ...options, type: argon2.argon2id };
  // Hash dummy untuk menyamakan waktu respons saat username tidak ditemukan.
  let dummyHash;
  const getDummyHash = async () => (dummyHash ??= await argon2.hash('dummy-password-for-timing', opts));

  return {
    async hash(password) {
      return argon2.hash(password, opts);
    },
    async verify(hash, password) {
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    },
    /** Dijalankan saat user tidak ada agar durasi respons setara. */
    async verifyDummy(password) {
      await this.verify(await getDummyHash(), password);
      return false;
    },
    needsRehash(hash) {
      return argon2.needsRehash(hash, opts);
    },
  };
}
