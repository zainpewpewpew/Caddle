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
 * Pendaftaran publik sengaja tidak tersedia; pengguna hanya dibuat lewat CLI di server
 * (atau sebagai akun default prototipe lokal, `via: 'default'` — lihat defaultUser.js).
 * `skipPasswordPolicy` hanya dipakai ensureDefaultUser untuk kredensial default yang dipilih pemilik;
 * CLI tidak pernah menyetelnya, jadi user:create dan user:password tetap wajib lolos kebijakan.
 */
export async function createUser(
  { users, audit, hasher, maxUsers, clock },
  { username, password, role, via = 'cli', skipPasswordPolicy = false },
) {
  if (!USERNAME_PATTERN.test(username ?? '')) {
    throw new UserAdminError('Username harus 3–32 karakter: huruf, angka, titik, garis bawah, atau strip');
  }
  if (!ROLES.includes(role)) throw new UserAdminError(`Peran harus salah satu dari: ${ROLES.join(', ')}`);
  const problems = skipPasswordPolicy ? [] : checkPasswordPolicy(password, { username });
  if (problems.length) throw new UserAdminError(`Kata sandi tidak memenuhi kebijakan: ${problems.join('; ')}`);
  if (await users.findByUsernameForAuth(username)) throw new UserAdminError('Username sudah dipakai');
  if ((await users.count()) >= maxUsers) throw new UserAdminError(`Batas ${maxUsers} pengguna sudah tercapai`);

  const now = clock();
  const id = await users.create({ username, passwordHash: await hasher.hash(password), role, now });
  await audit.record({ occurredAt: now, userId: id, action: 'user.create', outcome: 'success', detail: { role, via } });
  return id;
}

/**
 * Mengganti kata sandi pengguna (CLI di server) lalu mencabut SEMUA sesi aktifnya, sehingga siapa pun
 * yang login dengan kata sandi lama (mis. kredensial default) harus login ulang. Hash diperbarui
 * lebih dulu, baru sesi dicabut: login dengan kata sandi lama setelah titik itu gagal, dan sesi yang
 * terbentuk sebelumnya ikut dicabut. Setiap hasil dicatat di audit `user.password_change`
 * (kata sandi tidak pernah masuk audit).
 * @returns {Promise<{ userId: number, revokedSessions: number }>}
 */
export async function changePassword({ users, sessions, audit, hasher, clock }, { username, password, via = 'cli' }) {
  const fail = async (userId, reason, message) => {
    await audit.record({ occurredAt: clock(), userId, action: 'user.password_change', outcome: 'failure', detail: { reason, via } });
    return new UserAdminError(message);
  };

  const user = USERNAME_PATTERN.test(username ?? '') ? await users.findByUsernameForAuth(username) : null;
  if (!user) throw await fail(null, 'unknown_user', 'Pengguna tidak ditemukan');

  const problems = checkPasswordPolicy(password, { username: user.username });
  if (problems.length) throw await fail(user.id, 'policy', `Kata sandi tidak memenuhi kebijakan: ${problems.join('; ')}`);
  if (await hasher.verify(user.password_hash, password)) {
    throw await fail(user.id, 'unchanged', 'Kata sandi baru harus berbeda dari kata sandi saat ini');
  }

  const passwordHash = await hasher.hash(password);
  const now = clock();
  await users.updatePassword(user.id, { passwordHash, now });
  const revokedSessions = await sessions.revokeAllForUser(user.id, { now, reason: 'password_change' });
  await audit.record({
    occurredAt: now, userId: user.id, action: 'user.password_change', outcome: 'success', detail: { via, revokedSessions },
  });
  return { userId: user.id, revokedSessions };
}
