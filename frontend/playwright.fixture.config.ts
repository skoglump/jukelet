import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'manager.spec.ts', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:4175', browserName: 'chromium', trace: 'off', screenshot: 'only-on-failure', video: 'off' },
  webServer: { command: 'npm run dev:fixture', url: 'http://127.0.0.1:4175', reuseExistingServer: false },
});
