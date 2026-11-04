import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 840 },
    deviceScaleFactor: 2,
    permissions: ['clipboard-read', 'clipboard-write'],
    screenshot: 'only-on-failure',
  },
});
