import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SHARED_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const NAMESPACE_ZOD_IMPORT = "import * as z from 'zod';";
const ANY_ZOD_IMPORT = /^import\s.+\sfrom\s+'zod';?$/gm;

const productionSourceFiles = () =>
  readdirSync(SHARED_SOURCE_DIR).filter((fileName) => fileName.endsWith('.ts') && !fileName.includes('.test.'));

const zodImportsOf = (fileName: string) => readFileSync(join(SHARED_SOURCE_DIR, fileName), 'utf8').match(ANY_ZOD_IMPORT) ?? [];

describe('how @openfleet/shared imports zod', () => {
  it('imports the namespace only, which the desktop bundler can tree-shake through the barrel', () => {
    const importsOtherThanNamespace = productionSourceFiles().flatMap((fileName) =>
      zodImportsOf(fileName)
        .filter((zodImport) => zodImport !== NAMESPACE_ZOD_IMPORT)
        .map((zodImport) => `${fileName}: ${zodImport}`),
    );

    expect(importsOtherThanNamespace).toEqual([]);
  });
});
