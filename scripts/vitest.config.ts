import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['*.test.ts', 'release/**/*.test.ts', 'errors/**/*.test.ts', 'e2e/**/*.test.ts'], passWithNoTests: true } });
