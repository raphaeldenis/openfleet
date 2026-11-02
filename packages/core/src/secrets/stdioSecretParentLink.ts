import { createInterface } from 'node:readline';
import * as z from 'zod';
import { SECRET_SCOPE_KINDS } from '@openfleet/shared';
import { SECRET_NAME } from '../playbooks/kernel/secretName.js';
import { SecretAnswerSchema, type ParentToDaemonMessage, type SecretParentLink } from './secretParentLink.js';

/** Every line the daemon and the desktop app exchange for secrets starts with this, so that the sidecar's ordinary log lines never parse as one. */
export const SECRET_LINE_PREFIX = 'OPENFLEET_SECRETS ';

const SecretOperatorNonceSchema = z.object({
  type: z.literal('operator_nonce'),
  nonce: z.string(),
  action: z.enum(['set', 'clear']),
  scopeKind: z.enum(SECRET_SCOPE_KINDS),
  scopeId: z.string().min(1).max(128),
  name: z.string().regex(SECRET_NAME).max(128),
}).strict();

/** The arming of a trigger: the trigger id is the scope id and the name, so a nonce names exactly one trigger. */
const TriggerArmNonceSchema = z.object({
  type: z.literal('operator_nonce'),
  nonce: z.string(),
  action: z.literal('trigger.arm'),
  scopeKind: z.literal('trigger'),
  scopeId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
}).strict().refine((message) => message.name === message.scopeId);

const OperatorNonceSchema = z.union([SecretOperatorNonceSchema, TriggerArmNonceSchema]);
const SecretAnswerLineSchema = z.object({ type: z.literal('secret_answer'), requestId: z.string().min(1) }).and(SecretAnswerSchema);

const parentMessageOf = (line: string): ParentToDaemonMessage | undefined => {
  if (!line.startsWith(SECRET_LINE_PREFIX)) return undefined;
  try {
    const payload: unknown = JSON.parse(line.slice(SECRET_LINE_PREFIX.length));
    const nonce = OperatorNonceSchema.safeParse(payload);
    if (nonce.success) return nonce.data;
    const answer = SecretAnswerLineSchema.safeParse(payload);
    return answer.success ? (answer.data as ParentToDaemonMessage) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The link over the sidecar's pipes: requests are printed to `output` (stdout), nonces and answers are read from `input` (stdin).
 * A line that does not parse is dropped without a trace: the lines may carry a value, so none is ever logged or echoed.
 */
export const createStdioSecretParentLink = ({ input, output }: { input: NodeJS.ReadableStream; output: { write: (chunk: string) => unknown } }): SecretParentLink => {
  const listeners: ((message: ParentToDaemonMessage) => void)[] = [];
  createInterface({ input }).on('line', (line) => {
    const message = parentMessageOf(line);
    if (message !== undefined) for (const listener of listeners) listener(message);
  });
  return {
    send: (message) => void output.write(`${SECRET_LINE_PREFIX}${JSON.stringify(message)}\n`),
    onMessage: (listener) => void listeners.push(listener),
  };
};
