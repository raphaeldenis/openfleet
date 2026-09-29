import { newToken } from '../ids.js';

export interface WsTicketStore {
  /** Mints a fresh single-use ticket, valid for this store's TTL. */
  issue(): string;
  /** Burns the ticket regardless of outcome, then reports whether it was valid (known and not yet expired). */
  consume(ticket: string): boolean;
}

const DEFAULT_TTL_MS = 30_000;

export function createWsTicketStore(opts: { ttlMs?: number; now?: () => number } = {}): WsTicketStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const expiresAtByTicket = new Map<string, number>();

  return {
    issue(): string {
      const ticket = newToken();
      expiresAtByTicket.set(ticket, now() + ttlMs);
      return ticket;
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
