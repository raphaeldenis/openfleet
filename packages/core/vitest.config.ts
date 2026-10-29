import { defineConfig } from 'vitest/config';

// 20 s: the integration suites (SQLite on disk, git, spawned processes) take under 3 s alone and several times that on a loaded machine; see docs/test-load-timeouts.md.
const INTEGRATION_TIMEOUT_MILLISECONDS = 20_000;

export default defineConfig({ test: { include: ['src/**/*.test.ts'], passWithNoTests: true, testTimeout: INTEGRATION_TIMEOUT_MILLISECONDS, hookTimeout: INTEGRATION_TIMEOUT_MILLISECONDS } });
