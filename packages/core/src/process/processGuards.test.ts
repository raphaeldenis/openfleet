import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installProcessGuards } from './processGuards.js';

// A process with no listener for these two events exits fatally the moment one fires (Node's default
// behaviour) — the only way to observe "the daemon stays up" black-box is to install the guard on the
// real process and confirm the event no longer reaches that default handler, i.e. a listener ran instead.
describe('installProcessGuards', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

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
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('uncaughtException'), expect.any(Error));
  });

  it('logs and survives an unhandledRejection instead of crashing', () => {
    process.emit('unhandledRejection', new Error('boom'), Promise.resolve());
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unhandledRejection'), expect.any(Error));
  });
});
