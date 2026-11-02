import { createInterface } from 'node:readline';
import * as z from 'zod';
import type { ParentToDaemonMessage, SecretParentLink } from './secretParentLink.js';

/** Every line the daemon and the desktop app exchange for secrets starts with this, so that the sidecar's ordinary log lines never parse as one. */
export const SECRET_LINE_PREFIX = 'OPENFLEET_SECRETS ';

const ParentMessageSchema = z.object({ type: z.literal('operator_nonce'), nonce: z.string() }).strict();

const parentMessageOf = (line: string): ParentToDaemonMessage | undefined => {
  if (!line.startsWith(SECRET_LINE_PREFIX)) return undefined;
  try {
    const parsed = ParentMessageSchema.safeParse(JSON.parse(line.slice(SECRET_LINE_PREFIX.length)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** The link over the sidecar's pipes: requests are printed to `output` (stdout), operator nonces are read from `input` (stdin). A line that does not parse is ignored. */
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
