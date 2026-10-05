import { defineConfig } from '@playwright/test';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '../../packages/shared/src/e2e';
import { E2E_API_ENV, E2E_WEB_URL_ENV, resolveE2ePorts } from '../../scripts/e2e/e2ePorts';
import { ensureE2eHome } from '../../scripts/e2e/e2eHome';

const e2eHome = ensureE2eHome();
const { webPort, daemonPort } = resolveE2ePorts();
const daemonUrl = process.env[E2E_API_ENV]!;
const webUrl = process.env[E2E_WEB_URL_ENV]!;

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: webUrl },
  webServer: [
    {
      command: 'pnpm --filter @openfleet/core exec tsx src/main.ts',
      cwd: '../..',
      url: `${daemonUrl}/health`,
      reuseExistingServer: false,
      env: { OPENFLEET_HOME: e2eHome, OPENFLEET_PORT: String(daemonPort), OPENFLEET_ALLOWED_ORIGINS: webUrl, [E2E_FLAG_ENV]: E2E_FLAG_ON },
    },
    {
      command: `pnpm exec ng serve --port ${webPort}`,
      url: webUrl,
      reuseExistingServer: false,
    },
  ],
});
