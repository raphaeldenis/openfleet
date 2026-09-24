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
