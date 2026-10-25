import { checkPasswordPolicy } from '../auth/password.js';

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
export const ROLES = Object.freeze(['admin', 'analyst']);

export class UserAdminError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserAdminError';
  }
}

/**
 * Membuat pengguna baru dengan batas jumlah pengguna (default 2 pengguna privat).
 * Pendaftaran publik sengaja tidak tersedia; pengguna hanya dibuat lewat CLI di server.
 */
export async function createUser({ users, audit, hasher, maxUsers, clock }, { username, password, role }) {
  if (!USERNAME_PATTERN.test(username ?? '')) {
    throw new UserAdminError('Username harus 3–32 karakter: huruf, angka, titik, garis bawah, atau strip');
  }
  if (!ROLES.includes(role)) throw new UserAdminError(`Peran harus salah satu dari: ${ROLES.join(', ')}`);
  const problems = checkPasswordPolicy(password, { username });
  if (problems.length) throw new UserAdminError(`Kata sandi tidak memenuhi kebijakan: ${problems.join('; ')}`);
  if (await users.findByUsernameForAuth(username)) throw new UserAdminError('Username sudah dipakai');
  if ((await users.count()) >= maxUsers) throw new UserAdminError(`Batas ${maxUsers} pengguna sudah tercapai`);

  const now = clock();
  const id = await users.create({ username, passwordHash: await hasher.hash(password), role, now });
  await audit.record({ occurredAt: now, userId: id, action: 'user.create', outcome: 'success', detail: { role, via: 'cli' } });
  return id;
}
