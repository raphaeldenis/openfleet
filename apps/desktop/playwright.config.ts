import { defineConfig } from '@playwright/test';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '../../packages/shared/src/e2e';
import { ensureE2eHome } from '../../scripts/e2e/e2eHome';

const e2eHome = ensureE2eHome();

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:1420' },
  webServer: [
    {
      command: 'pnpm --filter @openfleet/core exec tsx src/main.ts',
      cwd: '../..',
      url: 'http://127.0.0.1:7332/health',
      reuseExistingServer: false,
      env: { OPENFLEET_HOME: e2eHome, OPENFLEET_PORT: '7332', [E2E_FLAG_ENV]: E2E_FLAG_ON },
    },
    {
      command: 'pnpm start',
      url: 'http://localhost:1420',
      reuseExistingServer: false,
    },
  ],
});
