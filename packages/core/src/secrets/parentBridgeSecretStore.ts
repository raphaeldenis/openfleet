import type { SecretStatus } from '@openfleet/shared';
import { NONCE_LIFETIME_MS, newRequestId } from './nonceLedger.js';
import type { DaemonToParentMessage, SecretAnswer, SecretParentLink } from './secretParentLink.js';
import { secretNotConnectedOnThisDevice, secretStoreUnavailable, type SecretStore } from './secretStore.js';

export interface ParentBridgeSecretStore extends SecretStore {
  /** How many answers arrived that no request in flight claimed: unknown, expired or already answered. They changed nothing. */
  ignoredAnswerCount: () => number;
}

type Pending = { settle: (answer: SecretAnswer) => void; expiresAt: number };

type Operation = Pick<DaemonToParentMessage, 'op' | 'scope' | 'name' | 'value'>;

/**
 * The macOS adapter: the desktop app owns the keychain (Security framework); the daemon asks it, per operation, over the pipes of the sidecar.
 * A request leaves on stdout under a random request id and is answered on stdin; there is no network hop, so no other process can answer in the app's place or take the connection over.
 * An answer is accepted once, within 30 seconds measured on the monotonic clock; one without a request in flight, expired or repeated is ignored and counted.
 * The daemon keeps no copy of a value: a set value leaves with the request, a read value goes to the caller. An app that does not answer within `exchangeTimeoutMs` fails the request with secret_store_unavailable.
 */
export const createParentBridgeSecretStore = ({ link, monotonicClock, exchangeTimeoutMs }: { link: SecretParentLink; monotonicClock: () => number; exchangeTimeoutMs: number }): ParentBridgeSecretStore => {
  const pendingByRequestId = new Map<string, Pending>();
  let ignoredAnswers = 0;

  link.onMessage((message) => {
    if (message.type !== 'secret_answer') return;
    const pending = pendingByRequestId.get(message.requestId);
    pendingByRequestId.delete(message.requestId);
    const isLive = pending !== undefined && monotonicClock() < pending.expiresAt;
    if (!isLive) {
      ignoredAnswers += 1;
      return;
    }
    const { type: _type, requestId: _requestId, ...answer } = message;
    pending.settle(answer);
  });

  const exchange = (operation: Operation): Promise<SecretAnswer> =>
    new Promise((resolve, reject) => {
      const requestId = newRequestId();
      const timer = setTimeout(() => {
        pendingByRequestId.delete(requestId);
        reject(secretStoreUnavailable('the desktop app did not answer in time.'));
      }, exchangeTimeoutMs);
      timer.unref();
      pendingByRequestId.set(requestId, {
        expiresAt: monotonicClock() + NONCE_LIFETIME_MS,
        settle: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
      });
      link.send({ type: 'secret_request', requestId, ...operation });
    });

  const refuseUnless = (accepted: readonly SecretAnswer['outcome'][], answer: SecretAnswer): void => {
    if (answer.outcome === 'unavailable') throw secretStoreUnavailable('the keychain of the desktop app is locked or unreadable.');
    if (!accepted.includes(answer.outcome)) throw secretStoreUnavailable('the desktop app answered something this request did not ask for.');
  };

  return {
    set: async (scope, name, value) => refuseUnless(['ok'], await exchange({ op: 'set', scope, name, value })),
    clear: async (scope, name) => refuseUnless(['ok'], await exchange({ op: 'clear', scope, name })),
    status: async (scope, name): Promise<SecretStatus> => {
      const answer = await exchange({ op: 'status', scope, name });
      refuseUnless(['stored', 'missing'], answer);
      return answer.outcome === 'stored' ? 'stored' : 'missing';
    },
    read: async (scope, name) => {
      const answer = await exchange({ op: 'read', scope, name });
      if (answer.outcome === 'not_found') throw secretNotConnectedOnThisDevice(name);
      refuseUnless(['value'], answer);
      return (answer as Extract<SecretAnswer, { outcome: 'value' }>).value;
    },
    ignoredAnswerCount: () => ignoredAnswers,
  };
};
