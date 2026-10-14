import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP_SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'desktop', 'src');
const CHILDREN_CAP_MAXIMUM_LITERAL = /\b64\b/;
const MENTIONS_THE_CHILDREN_CAP = /cap/i;

const productionSourceFilesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFilesUnder(path);
    const isProductionSource = entry.name.endsWith('.ts') && !entry.name.includes('.spec.');
    return isProductionSource ? [path] : [];
  });

describe('the children cap maximum in the desktop sources', () => {
  it('comes from the shared constant, never from a literal', () => {
    const desktopSourceFiles = productionSourceFilesUnder(DESKTOP_SOURCE_DIR);
    const linesWithTheMaximumLiteral = desktopSourceFiles.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, location: `${relative(DESKTOP_SOURCE_DIR, path)}:${index + 1}` }))
        .filter(({ line }) => CHILDREN_CAP_MAXIMUM_LITERAL.test(line) && MENTIONS_THE_CHILDREN_CAP.test(line))
        .map(({ location }) => location),
    );

    expect(desktopSourceFiles.length).toBeGreaterThan(0);
    expect(linesWithTheMaximumLiteral).toEqual([]);
  });
});
