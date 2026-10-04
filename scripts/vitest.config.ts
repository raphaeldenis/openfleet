import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['*.test.ts', 'release/**/*.test.ts', 'errors/**/*.test.ts'], passWithNoTests: true } });
