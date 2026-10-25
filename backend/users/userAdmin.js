import { checkPasswordPolicy } from '../auth/password.js';

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
export const ROLES = Object.freeze(['admin', 'analyst']);

export class UserAdminError extends Error {
  /**
   * @param {string} message pesan Bahasa Indonesia, aman ditampilkan di CLI
   * @param {string} [code] alasan yang dapat diperiksa kode, mis. 'username_taken', 'limit_reached', 'users_exist'
   */
  constructor(message, code) {
    super(message);
    this.name = 'UserAdminError';
    this.code = code;
  }
}

const usernameTaken = () => new UserAdminError('Username sudah dipakai', 'username_taken');
const limitReached = (maxUsers) => new UserAdminError(`Batas ${maxUsers} pengguna sudah tercapai`, 'limit_reached');
const usersExist = () => new UserAdminError('Sudah ada pengguna', 'users_exist');
const CREATE_REFUSED = { username_taken: usernameTaken, limit_reached: limitReached, not_empty: usersExist };

/**
 * Membuat pengguna baru dengan batas jumlah pengguna (default 2 pengguna privat).
 * Pendaftaran publik sengaja tidak tersedia; pengguna hanya dibuat lewat CLI di server
 * (atau sebagai akun default prototipe lokal, `via: 'default'`, `requireEmpty: true` — lihat defaultUser.js).
 * `skipPasswordPolicy` hanya dipakai ensureDefaultUser untuk kredensial default yang dipilih pemilik;
 * CLI tidak pernah menyetelnya, jadi user:create dan user:password tetap wajib lolos kebijakan.
 * Cek username/batas di awal hanya agar gagal cepat sebelum Argon2; keputusan final diambil
 * users.createWithLimit setelah hash dibuat, atomik terhadap proses lain yang membuat pengguna bersamaan.
 */
export async function createUser({ users, audit, hasher, maxUsers, clock }, {
  username, password, role, via = 'cli', requireEmpty = false, skipPasswordPolicy = false,
}) {
  if (!USERNAME_PATTERN.test(username ?? '')) {
    throw new UserAdminError('Username harus 3–32 karakter: huruf, angka, titik, garis bawah, atau strip', 'invalid_username');
  }
  if (!ROLES.includes(role)) throw new UserAdminError(`Peran harus salah satu dari: ${ROLES.join(', ')}`, 'invalid_role');
  const problems = skipPasswordPolicy ? [] : checkPasswordPolicy(password, { username });
  if (problems.length) throw new UserAdminError(`Kata sandi tidak memenuhi kebijakan: ${problems.join('; ')}`, 'policy');
  if (await users.findByUsernameForAuth(username)) throw usernameTaken();
  const count = await users.count();
  if (requireEmpty && count > 0) throw usersExist();
  if (count >= maxUsers) throw limitReached(maxUsers);

  const passwordHash = await hasher.hash(password);
  const now = clock();
  const result = await users.createWithLimit({ username, passwordHash, role, now, maxUsers, requireEmpty });
  if (!result.created) throw CREATE_REFUSED[result.reason](maxUsers);
  await audit.record({ occurredAt: now, userId: result.id, action: 'user.create', outcome: 'success', detail: { role, via } });
  return result.id;
}

/**
 * Mengganti kata sandi pengguna (CLI di server) lalu mencabut SEMUA sesi aktifnya, sehingga siapa pun
 * yang login dengan kata sandi lama (mis. kredensial default) harus login ulang. Hash diperbarui
 * lebih dulu, baru sesi dicabut: login dengan kata sandi lama setelah titik itu gagal, dan sesi yang
 * terbentuk sebelumnya ikut dicabut. Login yang sedang berjalan (hash lama sudah diverifikasi, sesi
 * belum dibuat) ditolak oleh pemeriksaan hash atomik saat insert sesi (authService + sessions.createIfPasswordUnchanged).
 * Setiap hasil dicatat di audit `user.password_change` (kata sandi tidak pernah masuk audit).
 * @returns {Promise<{ userId: number, revokedSessions: number }>}
 */
export async function changePassword({ users, sessions, audit, hasher, clock }, { username, password, via = 'cli' }) {
  const fail = async (userId, reason, message) => {
    await audit.record({ occurredAt: clock(), userId, action: 'user.password_change', outcome: 'failure', detail: { reason, via } });
    return new UserAdminError(message, reason);
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
