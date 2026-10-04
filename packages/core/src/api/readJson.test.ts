import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { describeError } from '../errors/describeError.js';
import { InvalidJsonBodyError } from '../errors/requestBodyErrors.js';
import { readJson } from './router.js';

const requestWithBody = (body: string) => ({ async *[Symbol.asyncIterator]() { yield Buffer.from(body); } }) as unknown as IncomingMessage;

describe('a malformed JSON body', () => {
  it('is refused with a fixed diagnostic that holds no fragment of the body', async () => {
    const body = '{"tool_response":BAD_SECRET_FRAGMENT}';

    const refusal = await readJson(requestWithBody(body)).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(InvalidJsonBodyError);
    const { message } = refusal as InvalidJsonBodyError;
    expect(message).not.toContain('BAD');
    expect(message).not.toContain('SECRET');
    expect(message).not.toContain('tool_response');
    expect(describeError(refusal).detail).toBe(message);
  });
});
