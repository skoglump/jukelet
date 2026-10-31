import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'ingress.spec.ts', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:4176', browserName: 'chromium', trace: 'off', screenshot: 'off', video: 'off' },
  webServer: { command: 'node fixtures/ingress.ts', url: 'http://127.0.0.1:4176/__proxy/ready', reuseExistingServer: false },
});
