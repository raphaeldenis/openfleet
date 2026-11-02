import { randomBytes } from 'node:crypto';

export const NONCE_LIFETIME_MS = 30_000;
const MAX_LIVE_NONCES = 16;
const MIN_REGISTERED_NONCE_CHARS = 16;
const MAX_REGISTERED_NONCE_CHARS = 128;
const NONCE_CHARACTERS = /^[A-Za-z0-9_-]+$/;

/** The operator nonces a desktop command minted and wrote to the stdin of the sidecar. Each authorises one REST set or clear. */
export interface NonceLedger {
  /** Accepts a nonce the desktop app minted; refuses (false) one that is too short, too long or not URL-safe base64. */
  register: (nonce: string) => boolean;
  /** True exactly once for a live nonce; a spent, expired or unknown nonce answers false. */
  redeem: (nonce: string) => boolean;
}

/** The live nonces of the daemon, in memory only: a restart voids them all. `monotonicClock` measures expiry, so a change of the wall clock cannot extend a nonce. */
export const createNonceLedger = ({ monotonicClock }: { monotonicClock: () => number }): NonceLedger => {
  const expiryByNonce = new Map<string, number>();

  const dropExpired = () => {
    for (const [nonce, expiresAt] of expiryByNonce) if (expiresAt <= monotonicClock()) expiryByNonce.delete(nonce);
  };
  const dropOldestBeyondTheCap = () => {
    for (const nonce of [...expiryByNonce.keys()].slice(0, Math.max(0, expiryByNonce.size - MAX_LIVE_NONCES))) expiryByNonce.delete(nonce);
  };

  return {
    register: (nonce) => {
      const isWellFormed = nonce.length >= MIN_REGISTERED_NONCE_CHARS && nonce.length <= MAX_REGISTERED_NONCE_CHARS && NONCE_CHARACTERS.test(nonce);
      if (!isWellFormed) return false;
      dropExpired();
      expiryByNonce.set(nonce, monotonicClock() + NONCE_LIFETIME_MS);
      dropOldestBeyondTheCap();
      return true;
    },
    redeem: (nonce) => {
      const expiresAt = expiryByNonce.get(nonce);
      if (expiresAt === undefined) return false;
      expiryByNonce.delete(nonce);
      return expiresAt > monotonicClock();
    },
  };
};

/** A request id: 192 random bits, unguessable by a process that cannot read the pipes. */
export const newRequestId = (): string => randomBytes(24).toString('base64url');
