import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { shutdownOnStdinEof } from './stdinEofShutdown.js';

describe('shutdownOnStdinEof', () => {
  it('runs the shutdown when stdin ends and the variable is 1', () => {
    const stdin = new PassThrough();
    const shutdown = vi.fn();
    shutdownOnStdinEof(shutdown, stdin, { OPENFLEET_EXIT_ON_STDIN_EOF: '1' });

    stdin.end();

    return vi.waitFor(() => expect(shutdown).toHaveBeenCalled());
  });

  it('removes the variable from the env it read, so nothing else in the process inherits it', () => {
    const env: NodeJS.ProcessEnv = { OPENFLEET_EXIT_ON_STDIN_EOF: '1', PATH: '/usr/bin' };

    shutdownOnStdinEof(vi.fn(), new PassThrough(), env);

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it.each([{},{ OPENFLEET_EXIT_ON_STDIN_EOF: '0' }, { OPENFLEET_EXIT_ON_STDIN_EOF: '' }])('does nothing when the variable is %j', async (env) => {
    const stdin = new PassThrough();
    const shutdown = vi.fn();
    shutdownOnStdinEof(shutdown, stdin, env);

    stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(shutdown).not.toHaveBeenCalled();
  });
});
