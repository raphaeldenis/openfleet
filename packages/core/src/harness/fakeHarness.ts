import type { Harness, HarnessHandle, HarnessLaunch } from './harness.js';

export class FakeHandle implements HarnessHandle {
  readonly written: string[] = [];
  private dataListeners: ((d: string) => void)[] = [];
  private exitListeners: ((c: number) => void)[] = [];
  killed = false;

  write(data: string): void { this.written.push(data); }
  resize(): void {}
  kill(): void { this.killed = true; this.emitExit(137); }
  onData(listener: (d: string) => void): () => void {
    this.dataListeners.push(listener);
    return () => { this.dataListeners = this.dataListeners.filter((l) => l !== listener); };
  }
  onExit(listener: (c: number) => void): () => void {
    this.exitListeners.push(listener);
    return () => { this.exitListeners = this.exitListeners.filter((l) => l !== listener); };
  }
  emitData(data: string): void { for (const l of this.dataListeners) l(data); }
  emitExit(code: number): void { for (const l of this.exitListeners) l(code); }
}

export class FakeHarness implements Harness {
  readonly id = 'fake' as const;
  readonly handles: FakeHandle[] = [];
  readonly launches: HarnessLaunch[] = [];

  start(launch: HarnessLaunch): HarnessHandle {
    const handle = new FakeHandle();
    this.handles.push(handle);
    this.launches.push(launch);
    return handle;
  }
}
