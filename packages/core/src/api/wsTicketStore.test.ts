import { describe, expect, it } from 'vitest';
import { createWsTicketStore } from './wsTicketStore.js';

describe('createWsTicketStore', () => {
  it('keeps its size bounded when issued many tickets across TTL windows without being consumed', () => {
    let clockMs = 0;
    const store = createWsTicketStore({ ttlMs: 1_000, now: () => clockMs, maxOutstanding: 1_000 });

    for (let i = 0; i < 5_000; i++) {
      store.issue();
      clockMs += 1;
    }

    expect(store.size()).toBeLessThanOrEqual(1_000);
  });

  it('still accepts a valid ticket after many other tickets were issued and expired', () => {
    let clockMs = 0;
    const store = createWsTicketStore({ ttlMs: 1_000, now: () => clockMs, maxOutstanding: 1_000 });

    for (let i = 0; i < 5_000; i++) {
      store.issue();
      clockMs += 1;
    }
    const ticket = store.issue();

    expect(store.consume(ticket)).toBe(true);
  });

  it('still refuses an expired ticket after many other tickets were issued', () => {
    let clockMs = 0;
    const store = createWsTicketStore({ ttlMs: 1_000, now: () => clockMs, maxOutstanding: 1_000 });

    const ticket = store.issue();
    clockMs += 1_001;
    for (let i = 0; i < 5_000; i++) {
      store.issue();
      clockMs += 1;
    }

    expect(store.consume(ticket)).toBe(false);
  });

  it('drops the oldest outstanding ticket once the cap is reached', () => {
    let clockMs = 0;
    const store = createWsTicketStore({ ttlMs: 1_000_000, now: () => clockMs, maxOutstanding: 2 });

    const first = store.issue();
    store.issue();
    store.issue();

    expect(store.consume(first)).toBe(false);
  });
});
