import { configDefaults, defineConfig } from 'vitest/config';

// 20 s: the integration suites (SQLite on disk, git, spawned processes) take under 3 s alone and several times that on a loaded machine; see docs/test-load-timeouts.md.
const INTEGRATION_TIMEOUT_MILLISECONDS = 20_000;

// The live suites need a logged-in claude CLI: the file is not collected at all unless `pnpm test:live` (OPENFLEET_LIVE=1) asks for it.
const LIVE_TEST_FILES = '**/*.live.test.ts';
const isLiveRun = process.env.OPENFLEET_LIVE === '1';
const excludedFiles = isLiveRun ? configDefaults.exclude : [...configDefaults.exclude, LIVE_TEST_FILES];

export default defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: excludedFiles, passWithNoTests: true, testTimeout: INTEGRATION_TIMEOUT_MILLISECONDS, hookTimeout: INTEGRATION_TIMEOUT_MILLISECONDS } });
