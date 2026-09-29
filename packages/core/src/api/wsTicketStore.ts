import { newToken } from '../ids.js';

export interface WsTicketStore {
  /** Mints a fresh single-use ticket, valid for this store's TTL. */
  issue(): string;
  /** Burns the ticket regardless of outcome, then reports whether it was valid (known and not yet expired). */
  consume(ticket: string): boolean;
  /** Number of outstanding (not yet consumed) tickets, expired or not. */
  size(): number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_OUTSTANDING = 1_000;

export function createWsTicketStore(opts: { ttlMs?: number; now?: () => number; maxOutstanding?: number } = {}): WsTicketStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const maxOutstanding = opts.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING;
  const expiresAtByTicket = new Map<string, number>();

  function sweepExpired(): void {
    const currentTimeMs = now();
    for (const [ticket, expiresAt] of expiresAtByTicket) {
      if (currentTimeMs >= expiresAt) expiresAtByTicket.delete(ticket);
    }
  }

  return {
    issue(): string {
      sweepExpired();
      while (expiresAtByTicket.size >= maxOutstanding) {
        const oldestTicket = expiresAtByTicket.keys().next().value as string;
        expiresAtByTicket.delete(oldestTicket);
      }
      const ticket = newToken();
      expiresAtByTicket.set(ticket, now() + ttlMs);
      return ticket;
    },
    size(): number {
      return expiresAtByTicket.size;
    },
    // ponytail: a Map.get is a hash lookup, not the byte-by-byte compare tokensMatch guards the long-lived
    // admin token against — and a ticket is single-use, so even a hypothetical timing signal would buy an
    // attacker at most one bit of one guess before the ticket is burned either way. Constant-time compare
    // belongs on the admin token itself, not here.
    consume(ticket: string): boolean {
      const expiresAt = expiresAtByTicket.get(ticket);
      expiresAtByTicket.delete(ticket);
      return expiresAt !== undefined && now() < expiresAt;
    },
  };
}
