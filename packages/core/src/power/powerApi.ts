export interface PowerAssertion {
  release(): void;
  isActive?(): boolean;
}

export interface PowerApi {
  acquire(): PowerAssertion;
  close?(): Promise<void>;
}
