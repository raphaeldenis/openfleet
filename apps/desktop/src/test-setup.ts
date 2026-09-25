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

// ponytail: Node's own experimental localStorage global (gated behind --localstorage-file) shadows
// jsdom's working implementation and resolves to undefined; a real localStorage.spec would drop this.
class InMemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
  getItem(key: string): string | null {
    return this.entries.has(key) ? this.entries.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.entries.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}
globalThis.localStorage ??= new InMemoryStorage();
