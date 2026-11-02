import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { SecretScope, SecretStatus } from '@openfleet/shared';
import type { NonceLedger } from './nonceLedger.js';
import type { DaemonToParentMessage, SecretParentLink } from './secretParentLink.js';
import { secretNotConnectedOnThisDevice, secretStoreUnavailable, type SecretStore } from './secretStore.js';

/** What the desktop app answers once it acted on the keychain. `value` travels only for a read, in the body of the loopback delivery. */
export const DeliveredAnswerSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok') }).strict(),
  z.object({ outcome: z.enum(['stored', 'missing']) }).strict(),
  z.object({ outcome: z.literal('value'), value: z.string().min(1) }).strict(),
  z.object({ outcome: z.literal('not_found') }).strict(),
  z.object({ outcome: z.literal('unavailable') }).strict(),
]);
export type DeliveredAnswer = z.infer<typeof DeliveredAnswerSchema>;

/** The two doors the internal routes open on a request in flight. Each nonce opens its door once. */
export interface SecretExchange {
  /** The value a set carries, handed over once to the take nonce; undefined for any other nonce. */
  take: (nonce: string) => string | undefined;
  /** Settles the request the deliver nonce belongs to; false when no live request has it. */
  deliver: (nonce: string, answer: DeliveredAnswer) => boolean;
}

export const NO_EXCHANGE: SecretExchange = { take: () => undefined, deliver: () => false };

type Pending = { settle: (answer: DeliveredAnswer) => void; takeNonce?: string; valueToTake?: string };

type Operation = { op: DaemonToParentMessage['op']; scope: SecretScope; name: string; value?: string };

/**
 * The macOS adapter: the desktop app owns the keychain (Security framework); the daemon asks it, per operation, over the sidecar pipes.
 * Each request carries single-use nonces. A value is held in the daemon only from the PUT that carries it until the app takes it, or from the delivery of a read until the caller got it: no cache.
 * An app that does not answer within `exchangeTimeoutMs` fails the request with secret_store_unavailable and voids its nonces.
 */
export const createParentBridgeSecretStore = ({ link, ledger, exchangeTimeoutMs }: { link: SecretParentLink; ledger: NonceLedger; exchangeTimeoutMs: number }): SecretStore & SecretExchange => {
  const pendingByDeliverNonce = new Map<string, Pending>();
  const deliverNonceByTakeNonce = new Map<string, string>();

  const forget = (deliverNonce: string) => {
    const pending = pendingByDeliverNonce.get(deliverNonce);
    pendingByDeliverNonce.delete(deliverNonce);
    ledger.revoke(deliverNonce);
    if (pending?.takeNonce === undefined) return;
    deliverNonceByTakeNonce.delete(pending.takeNonce);
    ledger.revoke(pending.takeNonce);
  };

  const exchange = ({ op, scope, name, value }: Operation): Promise<DeliveredAnswer> =>
    new Promise((resolve, reject) => {
      const deliverNonce = ledger.issue('deliver');
      const takeNonce = value === undefined ? undefined : ledger.issue('take');
      const timer = setTimeout(() => {
        forget(deliverNonce);
        reject(secretStoreUnavailable('the desktop app did not answer in time.'));
      }, exchangeTimeoutMs);
      timer.unref();
      pendingByDeliverNonce.set(deliverNonce, {
        settle: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
        ...(takeNonce === undefined ? {} : { takeNonce, valueToTake: value }),
      });
      if (takeNonce !== undefined) deliverNonceByTakeNonce.set(takeNonce, deliverNonce);
      link.send({ type: 'secret_request', requestId: randomUUID(), op, scope, name, deliverNonce, ...(takeNonce === undefined ? {} : { takeNonce }) });
    });

  const refuseUnless = (accepted: readonly DeliveredAnswer['outcome'][], answer: DeliveredAnswer): void => {
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
      return (answer as Extract<DeliveredAnswer, { outcome: 'value' }>).value;
    },
    take: (nonce) => {
      if (!ledger.redeem(nonce, 'take')) return undefined;
      const deliverNonce = deliverNonceByTakeNonce.get(nonce);
      deliverNonceByTakeNonce.delete(nonce);
      const pending = deliverNonce === undefined ? undefined : pendingByDeliverNonce.get(deliverNonce);
      const value = pending?.valueToTake;
      if (pending !== undefined) delete pending.valueToTake;
      return value;
    },
    deliver: (nonce, answer) => {
      if (!ledger.redeem(nonce, 'deliver')) return false;
      const pending = pendingByDeliverNonce.get(nonce);
      if (pending === undefined) return false;
      forget(nonce);
      pending.settle(answer);
      return true;
    },
  };
};
