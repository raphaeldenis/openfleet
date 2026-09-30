import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installProcessGuards } from './processGuards.js';

// A process with no listener for these two events exits fatally the moment one fires (Node's default
// behaviour) — the only way to observe "the daemon stays up" black-box is to install the guard on the
// real process and confirm the event no longer reaches that default handler, i.e. a listener ran instead.
describe('installProcessGuards', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const loggedErrorRecord = () => JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installProcessGuards();
  });
  afterEach(() => {
    errorSpy.mockRestore();
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
  });

  it('logs and survives an uncaughtException instead of crashing', () => {
    process.emit('uncaughtException', new Error('boom'));
    expect(loggedErrorRecord()).toMatchObject({ msg: expect.stringContaining('uncaughtException'), err: { name: 'Error', message: 'boom' } });
  });

  it('logs and survives an unhandledRejection instead of crashing', () => {
    process.emit('unhandledRejection', new Error('boom'), Promise.resolve());
    expect(loggedErrorRecord()).toMatchObject({ msg: expect.stringContaining('unhandledRejection'), err: { name: 'Error', message: 'boom' } });
  });

  it('sets a restrictive umask so every file the daemon creates afterwards defaults to owner-only (AUD-05)', () => {
    // A real process.umask() is process-wide and would leak into every other test sharing this worker, so
    // this asserts the call against an injected fake instead of the real process (same DI as `proc` above).
    const fakeProc = { on: vi.fn(), umask: vi.fn() } as unknown as NodeJS.Process;

    installProcessGuards(fakeProc);

    expect(fakeProc.umask).toHaveBeenCalledWith(0o077);
  });
});
