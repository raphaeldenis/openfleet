import * as z from 'zod';
import type { SecretScope } from '@openfleet/shared';
import type { OperatorAction, OperatorBinding } from './nonceLedger.js';

/**
 * What the daemon prints for the desktop app that spawned it: a request to act on the keychain. It names the operation, the scope and the secret name under a random request id.
 * A set also carries the value: the line travels on the private stdout pipe of the sidecar, which only the app reads and which the app never writes to its log.
 */
export type DaemonToParentMessage = {
  type: 'secret_request';
  requestId: string;
  op: 'set' | 'clear' | 'status' | 'read';
  scope: SecretScope;
  name: string;
  /** Present for a set only. */
  value?: string;
};

/** What the desktop app answers once it acted on the keychain. `value` travels for a read only. */
export const SecretAnswerSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok') }),
  z.object({ outcome: z.enum(['stored', 'missing']) }),
  z.object({ outcome: z.literal('value'), value: z.string().min(1) }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('unavailable') }),
]);
export type SecretAnswer = z.infer<typeof SecretAnswerSchema>;

/**
 * What the desktop app writes to the daemon over the stdin of the sidecar, which only the app holds the writing end of:
 * the operator nonce its Tauri command minted, which authorises one REST set or clear, or the arming of one trigger, and the answer to a request, which names it by its request id.
 */
export type ParentToDaemonMessage =
  | { type: 'operator_nonce'; nonce: string; action: OperatorAction; scopeKind: OperatorBinding['scope']['kind']; scopeId: string; name: string }
  | ({ type: 'secret_answer'; requestId: string } & SecretAnswer);

/** The line between the daemon and the app that spawned it: the sidecar's stdout towards the app, its stdin from the app. No other process can write to either pipe, nor take it over. */
export interface SecretParentLink {
  send: (message: DaemonToParentMessage) => void;
  /** Every listener hears every message; a message never reaches a log. */
  onMessage: (listener: (message: ParentToDaemonMessage) => void) => void;
}
