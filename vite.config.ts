import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Importing the pixi.js barrel is slow on a cold cache and the default
    // 5 s timeout flakes when the whole suite runs in parallel.
    testTimeout: 30000,
  },
});
