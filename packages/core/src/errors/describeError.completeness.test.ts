import { ERROR_CODES, OpenFleetError, retryOf, type ErrorCode } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { describeError } from './describeError.js';

const registeredCodes = Object.keys(ERROR_CODES) as ErrorCode[];

describe('describeError covers the whole registry', () => {
  it.each(registeredCodes)('describes %s with the kind and retry of the registry', (code) => {
    const thrown = new OpenFleetError(code, 'x');

    const envelope = describeError(thrown);

    expect(envelope).toMatchObject({ error: code, kind: ERROR_CODES[code].kind, retry: retryOf(code) });
  });
});
