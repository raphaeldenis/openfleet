import { randomBytes } from 'node:crypto';
import type { SecretScope } from '@openfleet/shared';
import type { DaemonToParentMessage, ParentToDaemonMessage, SecretAnswer, SecretParentLink } from './secretParentLink.js';

export type SecretRequest = Extract<DaemonToParentMessage, { type: 'secret_request' }>;

export type ParentBehaviour = 'answers' | 'stays_silent' | 'keychain_locked';

export const keychainKeyOf = (scope: SecretScope, name: string): string => `${scope.kind}/${scope.id}/${name}`;

/** Plays the desktop app on the pipes of the sidecar: reads the requests the daemon prints, owns a fake keychain and answers on the stdin of the daemon. No network is involved. */
export function createFakeTauriParent() {
  const keychain = new Map<string, string>();
  const requests: SecretRequest[] = [];
  let behaviour: ParentBehaviour = 'answers';
  let listeners: ((message: ParentToDaemonMessage) => void)[] = [];

  const writeToDaemon = (message: ParentToDaemonMessage) => listeners.forEach((listener) => listener(message));

  const answerOf = (request: SecretRequest): SecretAnswer => {
    const key = keychainKeyOf(request.scope, request.name);
    if (behaviour === 'keychain_locked') return { outcome: 'unavailable' };
    if (request.op === 'set') {
      keychain.set(key, request.value ?? '');
      return { outcome: 'ok' };
    }
    if (request.op === 'clear') {
      keychain.delete(key);
      return { outcome: 'ok' };
    }
    if (request.op === 'status') return { outcome: keychain.has(key) ? 'stored' : 'missing' };
    const value = keychain.get(key);
    return value === undefined ? { outcome: 'not_found' } : { outcome: 'value', value };
  };

  const link: SecretParentLink = {
    send: (message) => {
      requests.push(message);
      if (behaviour === 'stays_silent') return;
      setImmediate(() => writeToDaemon({ type: 'secret_answer', requestId: message.requestId, ...answerOf(message) }));
    },
    onMessage: (listener) => void listeners.push(listener),
  };

  return {
    link,
    keychain,
    requests,
    setBehaviour: (next: ParentBehaviour) => {
      behaviour = next;
    },
    /** What the Tauri command that mints the operator nonce does: draws a random nonce and writes it to the stdin of the daemon. */
    mintOperatorNonce: ({ action, scope, name }: { action: 'set' | 'clear'; scope: SecretScope; name: string }): string => {
      const nonce = randomBytes(24).toString('base64url');
      writeToDaemon({ type: 'operator_nonce', nonce, action, scopeKind: scope.kind, scopeId: scope.id, name });
      return nonce;
    },
    /** Writes any answer to the stdin of the daemon, as a process holding the pipe could: the answer of a request, replayed, late, forged or from another generation. */
    writeAnswer: (requestId: string, answer: SecretAnswer) => writeToDaemon({ type: 'secret_answer', requestId, ...answer }),
    /** A new daemon starts on the same app: the old daemon's pipe is gone, so nothing written from now on reaches it. */
    startNewGeneration: () => {
      listeners = [];
    },
  };
}

export type FakeTauriParent = ReturnType<typeof createFakeTauriParent>;
