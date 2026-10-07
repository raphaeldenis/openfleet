import { spawn, type ChildProcess } from 'node:child_process';
import type { PowerApi, PowerAssertion } from './powerApi.js';

const RELEASE_GRACE_MS = 1000;

interface CaffeinateOptions {
  daemonPid?: number;
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
}

class CaffeinateAssertion implements PowerAssertion {
  private hasEnded = false;
  private hasFailed = false;
  private releaseRequested = false;
  private escalation: ReturnType<typeof setTimeout> | undefined;
  private resolveExit: () => void = () => undefined;
  readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });

  constructor(private readonly helper: ChildProcess, onExit: () => void) {
    const finish = () => {
      if (this.hasEnded) return;
      this.hasEnded = true;
      if (this.escalation) clearTimeout(this.escalation);
      helper.removeListener('error', handleFailure);
      this.resolveExit();
      onExit();
    };
    const handleFailure = () => {
      this.hasFailed = true;
      const neverSpawns = helper.pid === undefined;
      if (neverSpawns) finish();
    };
    helper.on('error', handleFailure);
    helper.once('close', finish);
  }

  isActive(): boolean { return !this.hasEnded && !this.hasFailed; }

  release(): void {
    if (this.hasEnded || this.releaseRequested) return;
    this.releaseRequested = true;
    this.signalHelper('SIGTERM');
    if (this.hasEnded) return;
    this.escalation = setTimeout(() => { if (!this.hasEnded) this.signalHelper('SIGKILL'); }, RELEASE_GRACE_MS);
    this.escalation.unref();
  }

  private signalHelper(signal: NodeJS.Signals): void {
    try {
      const signalSent = this.helper.kill(signal);
      if (!signalSent) this.hasFailed = true;
    } catch {
      this.hasFailed = true;
    }
  }
}

export class CaffeinatePowerApi implements PowerApi {
  private readonly assertions = new Set<CaffeinateAssertion>();
  private readonly options: Required<CaffeinateOptions>;

  constructor(options: CaffeinateOptions = {}) {
    this.options = { daemonPid: process.pid, platform: process.platform, spawn, ...options };
  }

  acquire(): PowerAssertion {
    if (this.options.platform !== 'darwin') return { release: () => undefined };
    const helper = this.options.spawn('/usr/bin/caffeinate', ['-i', '-w', String(this.options.daemonPid)], {
      shell: false, detached: false, stdio: 'ignore', windowsHide: true,
    });
    const assertion = new CaffeinateAssertion(helper, () => this.assertions.delete(assertion));
    this.assertions.add(assertion);
    return assertion;
  }

  async close(): Promise<void> {
    const assertions = [...this.assertions];
    for (const assertion of assertions) assertion.release();
    await Promise.all(assertions.map((assertion) => assertion.exited));
  }
}
