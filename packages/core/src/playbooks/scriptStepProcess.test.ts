import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { runScriptStep, type ScriptStepRun } from './scriptStepProcess.js';

const directories = createTempDirTracker();
afterEach(() => directories.removeAll());

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BACKGROUND_EFFECT_DELAY_SECONDS = 0.7;
const LONGER_THAN_THE_BACKGROUND_EFFECT_DELAY_MS = 1_300;

const arrangeScript = (body: string) => {
  const folder = directories.make('script-step-');
  const path = join(folder, 'step.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return { folder, path, marker: join(folder, 'late-effect') };
};

const runOf = (script: { folder: string; path: string }, overrides: Partial<ScriptStepRun> = {}): ScriptStepRun => ({
  path: script.path, args: [], env: {}, workingDirectory: script.folder, timeoutMs: 10_000, maxRetainedChars: 262_144, signal: new AbortController().signal, ...overrides,
});

describe('a script that cannot be spawned', () => {
  it('answers spawn_failed, without throwing, when the spawn itself throws because a variable holds a NUL', async () => {
    const script = arrangeScript('printf never');

    const outcome = await runScriptStep(runOf(script, { env: { VALUE: 'dummy-value\u0000' } }));

    expect(outcome).toEqual({ kind: 'spawn_failed', output: '' });
  });

  it('answers spawn_failed when the file is not there', async () => {
    const script = arrangeScript('printf never');

    const outcome = await runScriptStep(runOf(script, { path: join(script.folder, 'missing.sh') }));

    expect(outcome).toEqual({ kind: 'spawn_failed', output: '' });
  });
});

describe('the processes a step leaves behind', () => {
  const backgroundEffect = (marker: string, { ignoresTermination }: { ignoresTermination: boolean }) =>
    `(${ignoresTermination ? "trap '' TERM; " : ''}sleep ${BACKGROUND_EFFECT_DELAY_SECONDS}; printf late > '${marker}') >/dev/null 2>&1 &`;

  it('kills a descendant still running when the script exits 0', async () => {
    const script = arrangeScript('');
    writeFileSync(script.path, `#!/bin/sh\n${backgroundEffect(script.marker, { ignoresTermination: false })}\nexit 0\n`);

    const outcome = await runScriptStep(runOf(script));
    await sleepMs(LONGER_THAN_THE_BACKGROUND_EFFECT_DELAY_MS);

    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 0 });
    expect(existsSync(script.marker)).toBe(false);
  });

  it('kills a descendant still running when the script exits non-zero', async () => {
    const script = arrangeScript('');
    writeFileSync(script.path, `#!/bin/sh\n${backgroundEffect(script.marker, { ignoresTermination: false })}\nexit 3\n`);

    const outcome = await runScriptStep(runOf(script));
    await sleepMs(LONGER_THAN_THE_BACKGROUND_EFFECT_DELAY_MS);

    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 3 });
    expect(existsSync(script.marker)).toBe(false);
  });

  it('kills a descendant that ignores SIGTERM when the step times out', async () => {
    const script = arrangeScript('');
    writeFileSync(script.path, `#!/bin/sh\n${backgroundEffect(script.marker, { ignoresTermination: true })}\nsleep 30\n`);

    const outcome = await runScriptStep(runOf(script, { timeoutMs: 300 }));
    await sleepMs(LONGER_THAN_THE_BACKGROUND_EFFECT_DELAY_MS);

    expect(outcome.kind).toBe('timeout');
    expect(existsSync(script.marker)).toBe(false);
  }, 15_000);

  it('kills a descendant that ignores SIGTERM when the step is aborted', async () => {
    const script = arrangeScript('');
    writeFileSync(script.path, `#!/bin/sh\n${backgroundEffect(script.marker, { ignoresTermination: true })}\nsleep 30\n`);
    const abort = new AbortController();

    const running = runScriptStep(runOf(script, { signal: abort.signal }));
    await sleepMs(150);
    abort.abort();
    const outcome = await running;
    await sleepMs(LONGER_THAN_THE_BACKGROUND_EFFECT_DELAY_MS);

    expect(outcome.kind).toBe('aborted');
    expect(existsSync(script.marker)).toBe(false);
  }, 15_000);
});

describe('what a step prints is retained up to a cap, as it arrives', () => {
  const FLOOD_CHARS = 400_000;
  const CAP = 1_000;
  const flood = `head -c ${FLOOD_CHARS} /dev/zero | tr '\\0' 'a'`;

  it('retains the characters of the cap and drops the rest of a flood', async () => {
    const script = arrangeScript(flood);

    const outcome = await runScriptStep(runOf(script, { maxRetainedChars: CAP }));

    expect(outcome.output).toBe('a'.repeat(CAP));
  });

  it('retains the cap over stdout and stderr together', async () => {
    const script = arrangeScript(`${flood}\n${flood} >&2`);

    const outcome = await runScriptStep(runOf(script, { maxRetainedChars: CAP }));

    expect(outcome.output).toBe('a'.repeat(CAP));
  });

  it('retains an output shorter than the cap whole', async () => {
    const script = arrangeScript("printf 'short\\n'");

    const outcome = await runScriptStep(runOf(script, { maxRetainedChars: CAP }));

    expect(outcome.output).toBe('short\n');
  });

  it('joins a multibyte character split across two chunks of the pipe', async () => {
    const script = arrangeScript("printf '\\303'\nsleep 0.2\nprintf '\\251\\n'");

    const outcome = await runScriptStep(runOf(script));

    expect(outcome.output).toBe('é\n');
  });

  it('retains the control characters as printed, so that a secret holding one is still whole for the masker', async () => {
    const script = arrangeScript("printf 'a\\033[31mb\\tc\\nd\\000e\\015f'");

    const outcome = await runScriptStep(runOf(script));

    expect(outcome.output).toBe('a\u001b[31mb\tc\nd\u0000e\rf');
  });
});

describe('a flood of characters that decode to nothing useful', () => {
  const SIXTY_FOUR_MIB = 64 * 1024 * 1024;
  const CAP = 1_000;
  const MOST_PIECES_A_CAPPED_COLLECTOR_KEEPS = 5;

  const stringsPushedWhile = async (action: () => Promise<unknown>): Promise<string[]> => {
    const originalPush = Array.prototype.push;
    const strings: string[] = [];
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      for (const item of items) if (typeof item === 'string') strings.push(item);
      return originalPush.apply(this, items);
    };
    try {
      await action();
    } finally {
      Array.prototype.push = originalPush;
    }
    return strings;
  };

  it('keeps no piece beyond the cap: 64 MiB of NUL with a cap of 1000 grows no array', async () => {
    const script = arrangeScript(`head -c ${SIXTY_FOUR_MIB} /dev/zero`);
    let outcome: Awaited<ReturnType<typeof runScriptStep>> | undefined;

    const pushedStrings = await stringsPushedWhile(async () => { outcome = await runScriptStep(runOf(script, { maxRetainedChars: CAP, timeoutMs: 60_000 })); });

    expect(outcome?.output).toBe('\u0000'.repeat(CAP));
    expect(pushedStrings.length).toBeLessThanOrEqual(MOST_PIECES_A_CAPPED_COLLECTOR_KEEPS);
  }, 90_000);
});

describe('the signals a step sends to its process group', () => {
  const SIGNALS_ARE_DUE_WITHIN_THE_GRACE_AND_A_LITTLE_MORE_MS = 2_600;

  const signalsAfterResolution = async (start: () => Promise<unknown>): Promise<string[]> => {
    const originalKill = process.kill;
    let resolvedAt = Number.POSITIVE_INFINITY;
    const late: string[] = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0 && Date.now() > resolvedAt) late.push(String(signal));
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      await start();
      resolvedAt = Date.now();
      await sleepMs(SIGNALS_ARE_DUE_WITHIN_THE_GRACE_AND_A_LITTLE_MORE_MS);
    } finally {
      process.kill = originalKill;
    }
    return late;
  };

  it('sends none after a timeout resolved the step', async () => {
    const script = arrangeScript('sleep 30');

    const late = await signalsAfterResolution(() => runScriptStep(runOf(script, { timeoutMs: 40 })));

    expect(late).toEqual([]);
  }, 15_000);

  it('sends none after an abort resolved the step', async () => {
    const script = arrangeScript('sleep 30');
    const abort = new AbortController();

    const late = await signalsAfterResolution(async () => {
      const running = runScriptStep(runOf(script, { signal: abort.signal }));
      await sleepMs(100);
      abort.abort();
      await running;
    });

    expect(late).toEqual([]);
  }, 15_000);

  it('sends none after a script that ignores SIGTERM and ends by itself resolved the step, though the timeout and an abort both asked it to stop', async () => {
    const script = arrangeScript('');
    const readyMarker = `${script.marker}-ready`;
    writeFileSync(script.path, `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(${JSON.stringify(readyMarker)}, '1');\nsetTimeout(() => {}, 1200);\n`);
    const abort = new AbortController();

    const late = await signalsAfterResolution(async () => {
      const running = runScriptStep(runOf(script, { signal: abort.signal, timeoutMs: 800 }));
      while (!existsSync(readyMarker)) await sleepMs(10);
      abort.abort();
      await running;
    });

    expect(late).toEqual([]);
  }, 15_000);

  it('sends none after a script that exited 0 resolved the step', async () => {
    const script = arrangeScript('exit 0');

    const late = await signalsAfterResolution(() => runScriptStep(runOf(script)));

    expect(late).toEqual([]);
  }, 15_000);
});
