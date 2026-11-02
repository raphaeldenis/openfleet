import { randomBytes } from 'node:crypto';

/** operator: minted by a desktop command for a REST set or clear. deliver and take: minted by the daemon for one request to the desktop app. */
export type NoncePurpose = 'operator' | 'deliver' | 'take';

export const NONCE_LIFETIME_MS = 30_000;
const MAX_LIVE_OPERATOR_NONCES = 16;
const MIN_REGISTERED_NONCE_CHARS = 16;
const MAX_REGISTERED_NONCE_CHARS = 128;
const NONCE_CHARACTERS = /^[A-Za-z0-9_-]+$/;

export interface NonceLedger {
  /** Mints a nonce of 192 random bits that `redeem` accepts once, for `purpose`, within 30 seconds. */
  issue: (purpose: NoncePurpose) => string;
  /** Accepts a nonce the desktop app minted; refuses (false) one that is too short, too long or not URL-safe base64. */
  register: (purpose: 'operator', nonce: string) => boolean;
  /** True exactly once for a live nonce of that purpose; a spent, expired, unknown or wrong-purpose nonce answers false. */
  redeem: (nonce: string, purpose: NoncePurpose) => boolean;
  revoke: (nonce: string) => void;
}

/** The live nonces of the daemon, in memory only: a restart voids them all. */
export const createNonceLedger = ({ clock }: { clock: () => number }): NonceLedger => {
  const live = new Map<string, { purpose: NoncePurpose; expiresAt: number }>();

  const dropExpired = () => {
    for (const [nonce, { expiresAt }] of live) if (expiresAt <= clock()) live.delete(nonce);
  };
  const dropOldestOperatorNoncesBeyondTheCap = () => {
    const operatorNonces = [...live].filter(([, { purpose }]) => purpose === 'operator').map(([nonce]) => nonce);
    for (const nonce of operatorNonces.slice(0, Math.max(0, operatorNonces.length - MAX_LIVE_OPERATOR_NONCES))) live.delete(nonce);
  };
  const keep = (purpose: NoncePurpose, nonce: string) => {
    dropExpired();
    live.set(nonce, { purpose, expiresAt: clock() + NONCE_LIFETIME_MS });
    dropOldestOperatorNoncesBeyondTheCap();
  };

  return {
    issue: (purpose) => {
      const nonce = randomBytes(24).toString('base64url');
      keep(purpose, nonce);
      return nonce;
    },
    register: (purpose, nonce) => {
      const isWellFormed = nonce.length >= MIN_REGISTERED_NONCE_CHARS && nonce.length <= MAX_REGISTERED_NONCE_CHARS && NONCE_CHARACTERS.test(nonce);
      if (isWellFormed) keep(purpose, nonce);
      return isWellFormed;
    },
    redeem: (nonce, purpose) => {
      const entry = live.get(nonce);
      if (entry === undefined || entry.purpose !== purpose) return false;
      live.delete(nonce);
      return entry.expiresAt > clock();
    },
    revoke: (nonce) => void live.delete(nonce),
  };
};
