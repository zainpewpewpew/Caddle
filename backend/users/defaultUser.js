// Akun default untuk prototipe LOKAL. Kredensialnya sengaja publik (README), jadi pembuatannya
// dibatasi agar aman sejak konstruksi (CWE-1392/798):
//   1. NODE_ENV=development dan DEFAULT_USER aktif (default hanya di development; `true` di produksi
//      sudah ditolak loadConfig),
//   2. server hanya lokal: HOST loopback, APP_ORIGIN loopback, dan TRUST_PROXY tidak diset — origin
//      publik atau reverse proxy berarti server dijangkau dari jaringan walau bind ke 127.0.0.1,
//   3. tabel users kosong — akun yang ada tidak pernah ditimpa, dibuat ulang, atau di-reset.
// Pembuatan memakai createUser, sehingga kebijakan kata sandi, Argon2id, batas MAX_USERS, dan audit
// `user.create` sama dengan CLI. Selain itu, server menolak start bila akun default MASIH memakai
// kata sandi default sementara server tidak lagi hanya lokal atau NODE_ENV=production.
import { createUser } from './userAdmin.js';

export const DEFAULT_CREDENTIALS = Object.freeze({ username: 'admin', password: 'alphalens-demo', role: 'admin' });

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const CHANGE_COMMAND = `npm run user:password -- --username ${DEFAULT_CREDENTIALS.username}`;

export class DefaultUserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DefaultUserError';
  }
}

/** Host yang hanya dapat dijangkau dari mesin ini. Nilai lain (0.0.0.0, ::, IP LAN, nama domain) → false. */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? '').trim().toLowerCase());
}

/**
 * Mengapa server dapat dijangkau dari luar mesin ini (atau berjalan sebagai produksi); null bila hanya lokal.
 * @param {{ nodeEnv: string, host: string, appOrigin: string, trustProxy: false | string[] }} config
 * @returns {{ reason: 'production' | 'non_loopback_host' | 'non_loopback_origin' | 'behind_proxy', detail: string } | null}
 */
export function exposureOf(config) {
  if (config.nodeEnv === 'production') return { reason: 'production', detail: 'NODE_ENV=production' };
  if (!isLoopbackHost(config.host)) {
    return { reason: 'non_loopback_host', detail: `HOST=${config.host} bukan loopback (127.0.0.1, ::1, localhost)` };
  }
  const originHost = new URL(config.appOrigin).hostname.replace(/^\[(.*)\]$/, '$1');
  if (!isLoopbackHost(originHost)) {
    return { reason: 'non_loopback_origin', detail: `APP_ORIGIN=${config.appOrigin} bukan loopback` };
  }
  if (config.trustProxy) return { reason: 'behind_proxy', detail: 'TRUST_PROXY diset (server di belakang reverse proxy)' };
  return null;
}

/** Melempar DefaultUserError bila akun default aktif dan masih memakai kata sandi default. */
async function assertDefaultPasswordNotExposed({ users, hasher }, exposure) {
  const { username, password } = DEFAULT_CREDENTIALS;
  const user = await users.findByUsernameForAuth(username);
  if (!user || user.is_disabled) return;
  if (!(await hasher.verify(user.password_hash, password))) return;
  throw new DefaultUserError(
    `Akun "${username}" masih memakai kata sandi default, padahal ${exposure.detail}. Ganti dulu dengan: ${CHANGE_COMMAND}`,
  );
}

/**
 * Membuat akun default prototipe bila (dan hanya bila) semua syarat di kepala file terpenuhi.
 * Idempoten: start berikutnya melihat tabel users tidak kosong dan tidak melakukan apa pun.
 * @param {{ users: any, audit: any, hasher: any, maxUsers: number, clock: () => number,
 *           config: { nodeEnv: string, host: string, appOrigin: string, trustProxy: false | string[], defaultUser: boolean },
 *           log: { warn: (msg: string) => void } }} deps
 * @returns {Promise<{ created: true, id: number } | { created: false, reason: 'disabled' | 'not_development'
 *   | 'users_exist' | 'non_loopback_host' | 'non_loopback_origin' | 'behind_proxy' }>}
 * @throws {DefaultUserError} akun default masih berkata sandi default saat server tidak hanya lokal / produksi
 */
export async function ensureDefaultUser({ users, audit, hasher, maxUsers, clock, config, log }) {
  const exposure = exposureOf(config);
  if (exposure) await assertDefaultPasswordNotExposed({ users, hasher }, exposure);

  if (!config.defaultUser) return { created: false, reason: 'disabled' };
  if (config.nodeEnv !== 'development') {
    log.warn(`DEFAULT_USER diabaikan: akun default hanya dibuat saat NODE_ENV=development (sekarang ${config.nodeEnv})`);
    return { created: false, reason: 'not_development' };
  }
  if ((await users.count()) > 0) return { created: false, reason: 'users_exist' };
  if (exposure) {
    log.warn(`Akun default TIDAK dibuat: ${exposure.detail}, sehingga server dapat dijangkau dari jaringan dan `
      + 'kredensial default yang publik dapat dipakai siapa pun. Buat pengguna dengan npm run user:create, '
      + 'atau jalankan lokal (HOST=127.0.0.1, APP_ORIGIN http://127.0.0.1:<port>, TRUST_PROXY=false).');
    return { created: false, reason: exposure.reason };
  }

  const { username, password, role } = DEFAULT_CREDENTIALS;
  const id = await createUser({ users, audit, hasher, maxUsers, clock }, { username, password, role, via: 'default' });
  log.warn(`Akun default prototipe dibuat — username: ${username}, kata sandi: ${password} (peran ${role}). `
    + `HANYA untuk prototipe lokal. Ganti kata sandinya dengan: ${CHANGE_COMMAND}`);
  return { created: true, id };
}
