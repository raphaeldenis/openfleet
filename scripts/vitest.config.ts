import { defineConfig } from 'vitest/config';

// 20 s: these suites spawn shells and git per test, which stretches under load; see docs/test-load-timeouts.md.
const SPAWNING_TIMEOUT_MILLISECONDS = 20_000;

export default defineConfig({ test: { include: ['*.test.ts', 'release/**/*.test.ts', 'errors/**/*.test.ts', 'e2e/**/*.test.ts', 'ports/**/*.test.ts', 'dev/**/*.test.ts'], passWithNoTests: true, testTimeout: SPAWNING_TIMEOUT_MILLISECONDS, hookTimeout: SPAWNING_TIMEOUT_MILLISECONDS } });
