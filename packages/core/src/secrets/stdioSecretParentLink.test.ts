import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ParentToDaemonMessage } from './secretParentLink.js';
import { createStdioSecretParentLink, SECRET_LINE_PREFIX } from './stdioSecretParentLink.js';

const NONCE = 'AbCdEf0123456789-_AbCdEf';

const openLink = () => {
  const input = new PassThrough();
  const written: string[] = [];
  const received: ParentToDaemonMessage[] = [];
  const link = createStdioSecretParentLink({ input, output: { write: (chunk) => written.push(chunk) } });
  link.onMessage((message) => received.push(message));
  return { input, written, received, link };
};

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

describe('the stdio link to the desktop app', () => {
  it('prints one prefixed JSON line per request, ending with a newline', () => {
    const { link, written } = openLink();

    link.send({ type: 'secret_request', requestId: 'r1', op: 'read', scope: { kind: 'playbook', id: 'pb' }, name: 'TOKEN', deliverNonce: 'n1' });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(new RegExp(`^${SECRET_LINE_PREFIX}\\{.*\\}\\n$`));
    expect(JSON.parse(written[0]!.slice(SECRET_LINE_PREFIX.length))).toMatchObject({ type: 'secret_request', op: 'read', name: 'TOKEN' });
  });

  it('hears the operator nonce the app writes to its stdin', async () => {
    const { input, received } = openLink();

    input.write(`${SECRET_LINE_PREFIX}${JSON.stringify({ type: 'operator_nonce', nonce: NONCE })}\n`);
    await nextTurn();

    expect(received).toEqual([{ type: 'operator_nonce', nonce: NONCE }]);
  });

  it.each([
    ['a line without the prefix', JSON.stringify({ type: 'operator_nonce', nonce: NONCE })],
    ['a prefixed line that is not JSON', `${SECRET_LINE_PREFIX}{not json`],
    ['a prefixed message of another type', `${SECRET_LINE_PREFIX}${JSON.stringify({ type: 'shutdown' })}`],
    ['an operator nonce that is not a string', `${SECRET_LINE_PREFIX}${JSON.stringify({ type: 'operator_nonce', nonce: 12 })}`],
  ])('ignores %s', async (_label, line) => {
    const { input, received } = openLink();

    input.write(`${line}\n`);
    await nextTurn();

    expect(received).toEqual([]);
  });
});
