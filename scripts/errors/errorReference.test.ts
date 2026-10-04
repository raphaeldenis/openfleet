import { readFileSync } from 'node:fs';
import { ERROR_CODES } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { REFERENCE_PATH } from './referencePath.js';
import { REGENERATE_COMMAND, renderErrorReference } from './renderErrorReference.js';

const firstDifferingLine = (committed: string, rendered: string): string => {
  const committedLines = committed.split('\n');
  const renderedLines = rendered.split('\n');
  const index = renderedLines.findIndex((line, position) => line !== committedLines[position]);
  const position = index === -1 ? renderedLines.length : index;
  return `line ${position + 1}: committed ${JSON.stringify(committedLines[position])}, generated ${JSON.stringify(renderedLines[position])}`;
};

describe('docs/errors.md', () => {
  it('is the reference generated from ERROR_CODES', () => {
    const committed = readFileSync(REFERENCE_PATH, 'utf8');
    const rendered = renderErrorReference();

    const isUpToDate = committed === rendered;

    expect(isUpToDate, `docs/errors.md is out of date (${firstDifferingLine(committed, rendered)}): run ${REGENERATE_COMMAND}`).toBe(true);
  });

  it('lists every code of the registry', () => {
    const rendered = renderErrorReference();

    const missingCodes = Object.keys(ERROR_CODES).filter((code) => !rendered.includes(`| \`${code}\` |`));

    expect(missingCodes).toEqual([]);
  });
});
