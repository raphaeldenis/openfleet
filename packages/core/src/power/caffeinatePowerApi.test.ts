import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { CaffeinatePowerApi } from './caffeinatePowerApi.js';

class FakeHelper extends EventEmitter {
  pid: number | undefined = 123;
  failsTermination = false;
  failsAllSignals = false;
  readonly signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.failsAllSignals) return false;
    if (this.failsTermination && signal === 'SIGTERM') {
      this.emit('error', new Error('termination failed'));
      return false;
    }
    this.emit('close', 0);
    return true;
  }
}

describe('macOS caffeinate power adapter', () => {
  it('bounds failed escalation, diagnoses it and retains ownership until the helper closes', async () => {
    vi.useFakeTimers();
    try {
      const helper = new FakeHelper();
      helper.failsAllSignals = true;
      const onPowerUnavailable = vi.fn();
      const power = new CaffeinatePowerApi({ platform: 'darwin', spawn: (() => helper) as unknown as typeof spawn, onPowerUnavailable });
      power.acquire().release();
      let closeCompletes = false;
      const closing = power.close().then(() => { closeCompletes = true; });

      await vi.advanceTimersByTimeAsync(2000);

      expect(closeCompletes).toBe(true);
      expect(helper.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(onPowerUnavailable).toHaveBeenCalledTimes(1);
      expect(helper.listenerCount('close')).toBe(1);
      helper.emit('close', 0);
      await closing;
      await power.close();
      expect(helper.listenerCount('close')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ties only an idle-system assertion to the daemon PID and reaps its helper on release', async () => {
    const helper = new FakeHelper();
    const launch = vi.fn(() => helper as unknown as ChildProcess);
    const power = new CaffeinatePowerApi({ daemonPid: 1234, platform: 'darwin', spawn: launch as typeof spawn });

    const assertion = power.acquire();
    expect(launch).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-i', '-w', '1234'], expect.objectContaining({ shell: false, detached: false, stdio: 'ignore' }));
    assertion.release();
    assertion.release();
    await power.close();
    expect(helper.signals).toEqual(['SIGTERM']);
    expect(assertion.isActive?.()).toBe(false);
  });

  it('makes a failed helper observable and closes without leaking a pending reaper', async () => {
    const helper = new FakeHelper();
    helper.pid = undefined;
    const power = new CaffeinatePowerApi({ daemonPid: 1234, platform: 'darwin', spawn: (() => helper) as unknown as typeof spawn });
    const assertion = power.acquire();

    helper.emit('error', new Error('cannot spawn'));

    expect(assertion.isActive?.()).toBe(false);
    await power.close();
    expect(helper.signals).toEqual([]);
  });

  it('escalates and reaps a spawned helper whose graceful termination reports an error', async () => {
    vi.useFakeTimers();
    try {
      const helper = new FakeHelper();
      helper.failsTermination = true;
      const power = new CaffeinatePowerApi({ daemonPid: 1234, platform: 'darwin', spawn: (() => helper) as unknown as typeof spawn });
      const assertion = power.acquire();

      const closing = power.close();
      await vi.advanceTimersByTimeAsync(1000);
      await closing;

      expect(helper.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(assertion.isActive?.()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spawn a helper on other platforms', async () => {
    const launch = vi.fn();
    const power = new CaffeinatePowerApi({ daemonPid: 1234, platform: 'linux', spawn: launch as typeof spawn });
    power.acquire().release();
    await power.close();
    expect(launch).not.toHaveBeenCalled();
  });
});
