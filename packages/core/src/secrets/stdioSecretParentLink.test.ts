import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { recentLogLines } from '../logger.js';
import type { ParentToDaemonMessage } from './secretParentLink.js';
import { createStdioSecretParentLink, SECRET_LINE_PREFIX } from './stdioSecretParentLink.js';

const NONCE = 'AbCdEf0123456789-_AbCdEf';
const OPERATOR_NONCE_MESSAGE = { type: 'operator_nonce', nonce: NONCE, action: 'set', scopeKind: 'playbook', scopeId: 'pb-1', name: 'JIRA_TOKEN' };

const openLink = () => {
  const input = new PassThrough();
  const written: string[] = [];
  const received: ParentToDaemonMessage[] = [];
  const link = createStdioSecretParentLink({ input, output: { write: (chunk) => written.push(chunk) } });
  link.onMessage((message) => received.push(message));
  return { input, written, received, link };
};

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const lineOf = (message: unknown) => `${SECRET_LINE_PREFIX}${JSON.stringify(message)}\n`;

describe('the stdio link to the desktop app', () => {
  it('prints one prefixed JSON line per request, ending with a newline', () => {
    const { link, written } = openLink();

    link.send({ type: 'secret_request', requestId: 'r1', op: 'read', scope: { kind: 'playbook', id: 'pb' }, name: 'TOKEN' });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(new RegExp(`^${SECRET_LINE_PREFIX}\\{.*\\}\\n$`));
    expect(JSON.parse(written[0]!.slice(SECRET_LINE_PREFIX.length))).toMatchObject({ type: 'secret_request', op: 'read', name: 'TOKEN' });
  });

  it('hears the operator nonce the app writes to its stdin', async () => {
    const { input, received } = openLink();

    input.write(lineOf(OPERATOR_NONCE_MESSAGE));
    await nextTurn();

    expect(received).toEqual([OPERATOR_NONCE_MESSAGE]);
  });

  it('hears the nonce that arms one trigger, whose id is not shaped like a secret name', async () => {
    const { input, received } = openLink();
    const armingNonce = { type: 'operator_nonce', nonce: NONCE, action: 'trigger.arm', scopeKind: 'trigger', scopeId: '0b1c-trigger', name: '0b1c-trigger' };

    input.write(lineOf(armingNonce));
    await nextTurn();

    expect(received).toEqual([armingNonce]);
  });

  it.each([
    ['a value', { type: 'secret_answer', requestId: 'r1', outcome: 'value', value: 'a-value-of-the-keychain' }],
    ['an outcome without a value', { type: 'secret_answer', requestId: 'r1', outcome: 'ok' }],
  ])('hears the answer of a request, with %s', async (_label, message) => {
    const { input, received } = openLink();

    input.write(lineOf(message));
    await nextTurn();

    expect(received).toEqual([message]);
  });

  it.each([
    ['a line without the prefix', JSON.stringify(OPERATOR_NONCE_MESSAGE)],
    ['an operator nonce bound to no action', `${SECRET_LINE_PREFIX}${JSON.stringify({ type: 'operator_nonce', nonce: NONCE })}`],
    ['an operator nonce bound to an action nobody defined', `${SECRET_LINE_PREFIX}${JSON.stringify({ ...OPERATOR_NONCE_MESSAGE, action: 'read' })}`],
    ['an operator nonce bound to a secret name that is not one', `${SECRET_LINE_PREFIX}${JSON.stringify({ ...OPERATOR_NONCE_MESSAGE, name: 'not a name' })}`],
    ['an arming nonce for a scope that is not a trigger', `${SECRET_LINE_PREFIX}${JSON.stringify({ type: 'operator_nonce', nonce: NONCE, action: 'trigger.arm', scopeKind: 'playbook', scopeId: 'pb-1', name: 'pb-1' })}`],
    ['an arming nonce whose name is not the trigger id', `${SECRET_LINE_PREFIX}${JSON.stringify({ type: 'operator_nonce', nonce: NONCE, action: 'trigger.arm', scopeKind: 'trigger', scopeId: 't-1', name: 't-2' })}`],
    ['a prefixed line that is not JSON', `${SECRET_LINE_PREFIX}{not json`],
    ['a prefixed message of another type', `${SECRET_LINE_PREFIX}${JSON.stringify({ type: 'shutdown' })}`],
    ['an operator nonce that is not a string', `${SECRET_LINE_PREFIX}${JSON.stringify({ ...OPERATOR_NONCE_MESSAGE, nonce: 12 })}`],
    ['an answer without a request id', `${SECRET_LINE_PREFIX}${JSON.stringify({ type: 'secret_answer', outcome: 'ok' })}`],
    ['an answer with an outcome nobody defined', `${SECRET_LINE_PREFIX}${JSON.stringify({ type: 'secret_answer', requestId: 'r1', outcome: 'maybe' })}`],
    ['a value answer with an empty value', `${SECRET_LINE_PREFIX}${JSON.stringify({ type: 'secret_answer', requestId: 'r1', outcome: 'value', value: '' })}`],
  ])('ignores %s', async (_label, line) => {
    const { input, received } = openLink();

    input.write(`${line}\n`);
    await nextTurn();

    expect(received).toEqual([]);
  });

  it('echoes nothing and logs nothing of the lines it reads, whether they parse or not', async () => {
    const { input, written } = openLink();
    const value = ['canary', randomUUID()].join('-');

    input.write(lineOf({ type: 'secret_answer', requestId: 'r1', outcome: 'value', value }));
    input.write(`${SECRET_LINE_PREFIX}{"type":"secret_answer","value":"${value}`);
    input.write('\n');
    await nextTurn();

    expect(written).toEqual([]);
    expect(recentLogLines().join('\n').includes(value)).toBe(false);
  });
});
