import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { syntheticJwt, syntheticToken } from './syntheticTokens.js';

const CORE_SRC = fileURLToPath(new URL('.', import.meta.url));
const SHARED_SRC = join(CORE_SRC, '..', '..', 'shared', 'src');
const REPOSITORY_ROOT = join(CORE_SRC, '..', '..', '..');
const MINIMUM_BODY = '{8,}';

// Each shape is spelled from fragments, so this file holds no full literal token either.
const TOKEN_SHAPE_SOURCES = [
  `${['gl', 'pat-'].join('')}[A-Za-z0-9_-]${MINIMUM_BODY}`,
  `${['gh', 'p_'].join('')}[A-Za-z0-9]${MINIMUM_BODY}`,
  `${['github', '_pat_'].join('')}[A-Za-z0-9_]${MINIMUM_BODY}`,
  `${['s', 'k-'].join('')}[A-Za-z0-9_-]${MINIMUM_BODY}`,
  `${['AK', 'IA'].join('')}[A-Z0-9]${MINIMUM_BODY}`,
  `${['AS', 'IA'].join('')}[A-Z0-9]${MINIMUM_BODY}`,
  `${['xo', 'x'].join('')}[abeprs]-[A-Za-z0-9-]${MINIMUM_BODY}`,
  `${['ey', 'J'].join('')}[A-Za-z0-9_-]${MINIMUM_BODY}`,
];
const NOT_PART_OF_A_WORD = '(^|[^A-Za-z0-9_])';
const LITERAL_TOKEN_SHAPE = new RegExp(`${NOT_PART_OF_A_WORD}(${TOKEN_SHAPE_SOURCES.join('|')})`);

function testSourcesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testSourcesUnder(path);
    return entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function literalTokenLinesOf(text: string): number[] {
  return text.split('\n').flatMap((line, index) => (LITERAL_TOKEN_SHAPE.test(line) ? [index + 1] : []));
}

function offendersIn(directories: string[]): string[] {
  return directories.flatMap(testSourcesUnder).flatMap((path) => {
    const lines = literalTokenLinesOf(readFileSync(path, 'utf8'));
    return lines.map((line) => `${relative(REPOSITORY_ROOT, path)}:${line}`);
  });
}

describe('no literal token shape in test sources', () => {
  it('holds no literal credential shape in the core and shared tests', () => {
    expect(offendersIn([CORE_SRC, SHARED_SRC])).toEqual([]);
  });

  it.each([
    ['an anthropic key', syntheticToken({ shape: 'anthropic', bodyLength: 36 })],
    ['a github token', syntheticToken({ shape: 'github', bodyLength: 36 })],
    ['a gitlab token', syntheticToken({ shape: 'gitlab', bodyLength: 20 })],
    ['an aws key id', syntheticToken({ shape: 'aws', bodyLength: 16 })],
    ['an aws temporary key id', syntheticToken({ shape: 'awsSession', bodyLength: 16 })],
    ['a slack rotation token', syntheticToken({ shape: 'slackRefresh', bodyLength: 24 })],
    ['a slack bot token', syntheticToken({ shape: 'slackBot', bodyLength: 24 })],
    ['a fine-grained github token', syntheticToken({ shape: 'githubFineGrained', bodyLength: 40 })],
    ['a jwt', syntheticJwt({ segmentBodyLength: 20 })],
  ])('recognises %s when it is written out literally', (_name, literal) => {
    expect(literalTokenLinesOf(`const secret = '${literal}';`)).toEqual([1]);
  });

  it('leaves a word that merely contains a prefix alone', () => {
    expect(literalTokenLinesOf("const branch = 'phase2/task-12-session-lifecycle-routes';")).toEqual([]);
  });
});
