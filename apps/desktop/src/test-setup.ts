import { configure } from '@testing-library/angular/zoneless';
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import './testing/leaked-timers';

// waitFor, findBy* and the spec itself return as soon as their condition holds; these ceilings only bound one that never holds.
// The 1 000 ms and 5 000 ms defaults fail a passing spec on a loaded machine, where one render and a few keystrokes already take that long.
const NEVER_HOLDS_CEILING_MS = 15_000;
const SPEC_CEILING_MS = 30_000;
configure({ asyncUtilTimeout: NEVER_HOLDS_CEILING_MS });
vi.setConfig({ testTimeout: SPEC_CEILING_MS, hookTimeout: SPEC_CEILING_MS });

// xterm needs a ResizeObserver in jsdom, which doesn't implement one.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

// xterm watches devicePixelRatio changes via matchMedia, which jsdom doesn't implement.
globalThis.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

// ponytail: Node's own experimental localStorage global (gated behind --localstorage-file) makes
// vitest skip copying jsdom's working one onto globalThis; reuse jsdom's own instance instead of
// hand-rolling a Storage. Depends on vitest's jsdom env exposing the JSDOM instance as the
// undocumented `globalThis.jsdom` — a vitest upgrade that drops it fails the admin-token/environment
// specs loudly.
globalThis.localStorage ??= (globalThis as { jsdom?: { window: { localStorage: Storage } } }).jsdom
  ?.window.localStorage as Storage;
