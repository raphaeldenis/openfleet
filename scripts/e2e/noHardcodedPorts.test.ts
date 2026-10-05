import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const e2eDirectory = join(repoRoot, 'apps/desktop/e2e');
const FIXED_DEV_PORT_PATTERN = /\b(1420|7331|7332)\b/;

const filesOfE2eRun = [
  join(repoRoot, 'apps/desktop/playwright.config.ts'),
  join(repoRoot, 'scripts/pre-push.sh'),
  ...readdirSync(e2eDirectory, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts')).map((name) => join(e2eDirectory, name)),
];

describe('the e2e run', () => {
  it.each(filesOfE2eRun.map((file) => [file.replace(`${repoRoot}/`, ''), file]))('%s names no fixed dev port', (_label, file) => {
    const fixedPortLines = readFileSync(file as string, 'utf8').split('\n').filter((line) => FIXED_DEV_PORT_PATTERN.test(line));

    expect(fixedPortLines).toEqual([]);
  });
});
