import { randomBytes } from 'node:crypto';
import type { SecretScope } from '@openfleet/shared';

export const NONCE_LIFETIME_MS = 30_000;
const MAX_LIVE_NONCES = 16;
const MIN_REGISTERED_NONCE_CHARS = 16;
const MAX_REGISTERED_NONCE_CHARS = 128;
const NONCE_CHARACTERS = /^[A-Za-z0-9_-]+$/;

/** `set` and `clear` act on a secret; `trigger.arm` arms the trigger whose id is both the scope id and the name. */
export const OPERATOR_ACTIONS = ['set', 'clear', 'trigger.arm'] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

/** What an operator nonce authorises: one action on one secret, or the arming of one trigger. */
export type OperatorBinding = { action: OperatorAction; scope: SecretScope; name: string };

const bindingKeyOf = ({ action, scope, name }: OperatorBinding): string => JSON.stringify([action, scope.kind, scope.id, name]);

/** The operator nonces a desktop command minted and wrote to the stdin of the sidecar. Each authorises one REST set or clear, of the secret it was minted for. */
export interface NonceLedger {
  /** Accepts a nonce the desktop app minted for a binding; refuses (false) one that is too short, too long or not URL-safe base64. */
  register: (nonce: string, binding: OperatorBinding) => boolean;
  /** True exactly once, for a live nonce presented with the binding it was minted for. A nonce presented for another action or secret is refused and spent. */
  redeem: (nonce: string, binding: OperatorBinding) => boolean;
}

/** The live nonces of the daemon, in memory only: a restart voids them all. `monotonicClock` measures expiry, so a change of the wall clock cannot extend a nonce. */
export const createNonceLedger = ({ monotonicClock }: { monotonicClock: () => number }): NonceLedger => {
  const liveByNonce = new Map<string, { expiresAt: number; bindingKey: string }>();

  const dropExpired = () => {
    for (const [nonce, { expiresAt }] of liveByNonce) if (expiresAt <= monotonicClock()) liveByNonce.delete(nonce);
  };
  const dropOldestBeyondTheCap = () => {
    for (const nonce of [...liveByNonce.keys()].slice(0, Math.max(0, liveByNonce.size - MAX_LIVE_NONCES))) liveByNonce.delete(nonce);
  };

  return {
    register: (nonce, binding) => {
      const isWellFormed = nonce.length >= MIN_REGISTERED_NONCE_CHARS && nonce.length <= MAX_REGISTERED_NONCE_CHARS && NONCE_CHARACTERS.test(nonce);
      if (!isWellFormed) return false;
      dropExpired();
      liveByNonce.set(nonce, { expiresAt: monotonicClock() + NONCE_LIFETIME_MS, bindingKey: bindingKeyOf(binding) });
      dropOldestBeyondTheCap();
      return true;
    },
    redeem: (nonce, binding) => {
      const live = liveByNonce.get(nonce);
      if (live === undefined) return false;
      liveByNonce.delete(nonce);
      const isForThisAction = live.bindingKey === bindingKeyOf(binding);
      return isForThisAction && live.expiresAt > monotonicClock();
    },
  };
};

/** A request id: 192 random bits, unguessable by a process that cannot read the pipes. */
export const newRequestId = (): string => randomBytes(24).toString('base64url');
