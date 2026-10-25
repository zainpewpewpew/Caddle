import { defineConfig } from 'vitest/config';

// Suite LIVE terpisah (jaringan ke Binance). Tidak pernah ikut `npm test`.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.js'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
  },
});
