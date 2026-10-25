import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/{unit,integration,positive,negative,edge,security}/**/*.test.js'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
  },
});
