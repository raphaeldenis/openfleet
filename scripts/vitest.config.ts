import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['*.test.ts', 'release/**/*.test.ts', 'errors/**/*.test.ts', 'e2e/**/*.test.ts', 'ports/**/*.test.ts', 'dev/**/*.test.ts'], passWithNoTests: true } });
