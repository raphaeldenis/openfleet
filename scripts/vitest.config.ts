import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['release/**/*.test.ts'], passWithNoTests: true } });
