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
