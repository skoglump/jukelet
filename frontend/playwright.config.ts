import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'session.spec.ts',
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.JUKELET_E2E_URL,
    browserName: 'chromium',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
