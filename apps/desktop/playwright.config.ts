import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:1420' },
  webServer: [
    {
      command: 'pnpm --filter @openfleet/core exec tsx src/main.ts',
      cwd: '../..',
      url: 'http://127.0.0.1:7332/health',
      reuseExistingServer: false,
      env: { OPENFLEET_HOME: '/tmp/of-e2e', OPENFLEET_PORT: '7332' },
    },
    {
      command: 'pnpm start',
      url: 'http://localhost:1420',
      reuseExistingServer: false,
    },
  ],
});
