import { randomBytes } from 'node:crypto';
import type { SecretScope } from '@openfleet/shared';
import type { DaemonToParentMessage, ParentToDaemonMessage, SecretParentLink } from './secretParentLink.js';

type SecretRequest = Extract<DaemonToParentMessage, { type: 'secret_request' }>;

export type ParentBehaviour = 'answers' | 'stays_silent' | 'keychain_locked';

export const keychainKeyOf = (scope: SecretScope, name: string): string => `${scope.kind}/${scope.id}/${name}`;

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Plays the desktop app: reads the requests the daemon prints, owns a fake keychain and answers over the daemon's loopback routes, as the Tauri side does. */
export function createFakeTauriParent({ daemonUrl }: { daemonUrl: () => string }) {
  const keychain = new Map<string, string>();
  const requests: SecretRequest[] = [];
  let behaviour: ParentBehaviour = 'answers';
  let listener: ((message: ParentToDaemonMessage) => void) | undefined;

  const take = async (request: SecretRequest): Promise<string> => {
    const answer = await postJson(`${daemonUrl()}/internal/secrets/take`, { nonce: request.takeNonce });
    return ((await answer.json()) as { value: string }).value;
  };
  const deliver = (request: SecretRequest, body: Record<string, unknown>) => postJson(`${daemonUrl()}/internal/secrets/deliver`, { nonce: request.deliverNonce, ...body });

  const answerTheRequest = async (request: SecretRequest): Promise<void> => {
    const key = keychainKeyOf(request.scope, request.name);
    if (behaviour === 'stays_silent') return;
    if (behaviour === 'keychain_locked') return void (await deliver(request, { outcome: 'unavailable' }));
    if (request.op === 'set') {
      keychain.set(key, await take(request));
      return void (await deliver(request, { outcome: 'ok' }));
    }
    if (request.op === 'clear') {
      keychain.delete(key);
      return void (await deliver(request, { outcome: 'ok' }));
    }
    if (request.op === 'status') return void (await deliver(request, { outcome: keychain.has(key) ? 'stored' : 'missing' }));
    const value = keychain.get(key);
    await deliver(request, value === undefined ? { outcome: 'not_found' } : { outcome: 'value', value });
  };

  const link: SecretParentLink = {
    send: (message) => {
      if (message.type !== 'secret_request') return;
      requests.push(message);
      void answerTheRequest(message);
    },
    onMessage: (handler) => {
      listener = handler;
    },
  };

  return {
    link,
    keychain,
    requests,
    setBehaviour: (next: ParentBehaviour) => {
      behaviour = next;
    },
    /** What the Tauri command that mints the operator nonce does: draws a random nonce and hands it to the daemon over the sidecar's stdin. */
    mintOperatorNonce: (): string => {
      const nonce = randomBytes(24).toString('base64url');
      listener?.({ type: 'operator_nonce', nonce });
      return nonce;
    },
    answerTheRequest,
  };
}

export type FakeTauriParent = ReturnType<typeof createFakeTauriParent>;
