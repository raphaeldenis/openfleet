import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const TEST_ONLY_FILE = /\.(test|testkit)\.ts$/;
const IMPORTS_THE_TEST_RUNNER = /(?:from|import)\s*\(?\s*['"]vitest(?:\/[^'"]*)?['"]/;

const sourceFilesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFilesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });

describe('production sources', () => {
  it('never import the test runner: only *.test.ts and *.testkit.ts files may', () => {
    const productionFiles = sourceFilesUnder(SOURCE_DIRECTORY).filter((path) => !TEST_ONLY_FILE.test(path));

    const filesImportingVitest = productionFiles.filter((path) => IMPORTS_THE_TEST_RUNNER.test(readFileSync(path, 'utf8')));

    expect(filesImportingVitest.map((path) => path.slice(SOURCE_DIRECTORY.length))).toEqual([]);
  });
});
