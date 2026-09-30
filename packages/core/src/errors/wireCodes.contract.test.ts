import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';

const API_DIRECTORY = fileURLToPath(new URL('../api/', import.meta.url));
const MCP_DIRECTORY = fileURLToPath(new URL('../mcp/', import.meta.url));
const HAND_WRITTEN_ERROR_ANSWER = /json\(res,\s*[45]\d\d\b/;
const THROWN_CODE = /new OpenFleetError\(\s*'([a-z_]+)'/g;

function sourceFiles(directory: string): { path: string; text: string }[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(file))
    .map((file) => ({ path: `${directory}${file}`, text: readFileSync(`${directory}${file}`, 'utf8') }));
}

describe('every error a REST route or MCP handler answers', () => {
  const routeFiles = sourceFiles(API_DIRECTORY);
  const thrownCodes = [...routeFiles, ...sourceFiles(MCP_DIRECTORY)].flatMap(({ path, text }) =>
    [...text.matchAll(THROWN_CODE)].map(([, code]) => ({ path, code: code! })));

  it('is not written by hand: an error status leaves through the envelope writer only', () => {
    const handWritten = routeFiles.filter(({ text }) => text.search(HAND_WRITTEN_ERROR_ANSWER) >= 0);
    expect(handWritten.map(({ path }) => path.split('/').pop())).toEqual([]);
  });

  it('finds the codes thrown in the route files', () => {
    expect(thrownCodes.length).toBeGreaterThan(5);
  });

  it('names a registered code at every OpenFleetError thrown in the route and MCP files', () => {
    const unregistered = thrownCodes.filter(({ code }) => !(code in ERROR_CODES));
    expect(unregistered).toEqual([]);
  });
});
