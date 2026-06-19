import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/visual',
  outputDir: './test-results',
  fullyParallel: false,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:3333',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'DIFFVIEWER_ARCH_PATH=test/fixtures/architecture-minimal.json node server.js .',
    url: 'http://127.0.0.1:3333',
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
});
