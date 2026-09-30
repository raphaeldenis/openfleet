import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, HTTP_STATUS_BY_KIND, type ErrorCode } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';

const API_DIRECTORY = fileURLToPath(new URL('../api/', import.meta.url));
const ANSWER_WITH_CODE = /json\(res,\s*(\d{3}),\s*\{\s*error:\s*'([a-z_]+)'/g;

interface WireAnswer { file: string; status: number; code: string }

function answersWrittenInRoutes(): WireAnswer[] {
  const routeFiles = readdirSync(API_DIRECTORY).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  return routeFiles.flatMap((file) =>
    [...readFileSync(`${API_DIRECTORY}${file}`, 'utf8').matchAll(ANSWER_WITH_CODE)].map(([, status, code]) => ({ file, status: Number(status), code: code! })));
}

describe('every error code a REST route answers today', () => {
  const answers = answersWrittenInRoutes();

  it('finds the answers written in the route files', () => {
    expect(answers.length).toBeGreaterThan(30);
  });

  it('is registered in ERROR_CODES', () => {
    const unregistered = answers.filter(({ code }) => !(code in ERROR_CODES));

    expect(unregistered).toEqual([]);
  });

  it('is answered with the http status of its registered kind', () => {
    const drifted = answers
      .filter(({ code }) => code in ERROR_CODES)
      .map(({ file, status, code }) => ({ file, code, status, registered: HTTP_STATUS_BY_KIND[ERROR_CODES[code as ErrorCode].kind] }))
      .filter(({ status, registered }) => status !== registered);

    expect(drifted).toEqual([]);
  });
});
