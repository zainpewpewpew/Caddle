// Pengguna uji E2E. Hanya ada di database sementara server E2E.
export const E2E_PORT = 8181;
// Server kedua dengan sinyal hasil pipeline asli atas candle SINTETIS (bukan data pasar nyata).
export const E2E_SEEDED_PORT = 8182;
export const E2E_USERS = {
  admin: { username: 'mary', password: 'e2e-admin-password-91', role: 'admin' },
  analyst: { username: 'rekan', password: 'e2e-analyst-password-72', role: 'analyst' },
};
