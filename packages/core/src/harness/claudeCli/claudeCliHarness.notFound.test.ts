import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenFleetError } from '@openfleet/shared';
import { openDatabase } from '../../db/database.js';
import { describeError } from '../../errors/describeError.js';
import { EventBus } from '../../events/eventBus.js';
import { RESUME_LAUNCH_FAILED_EXIT_CODE, SessionService } from '../../sessions/sessionService.js';

const spawn = vi.fn();
vi.mock('node-pty', () => ({ spawn }));
vi.mock('./trustDirectory.js', () => ({ markDirectoryTrusted: vi.fn() }));

const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

let scratch: string;
let emptyBin: string;
let binWithClaude: string;

beforeEach(() => {
  spawn.mockReset();
  scratch = mkdtempSync(join(tmpdir(), 'of-claude-not-found-'));
  emptyBin = join(scratch, 'empty-bin');
  mkdirSync(emptyBin);
  binWithClaude = join(scratch, 'bin-with-claude');
  mkdirSync(binWithClaude);
  writeFileSync(join(binWithClaude, 'claude'), '#!/bin/sh\n');
  chmodSync(join(binWithClaude, 'claude'), 0o755);
});
afterEach(() => vi.restoreAllMocks());

function bootSessions(env: NodeJS.ProcessEnv) {
  const bus = new EventBus();
  const events: Array<Record<string, unknown>> = [];
  bus.subscribe((event) => events.push(event as unknown as Record<string, unknown>));
  const sessions = new SessionService({
    db: openDatabase(':memory:'), bus, harnesses: [new ClaudeCliHarness(join(scratch, 'sessions'), env)],
    baseUrl: 'http://127.0.0.1:0', worktreesRoot: join(scratch, 'worktrees'), describeError,
  });
  return { sessions, events };
}

const spec = (directory: string) => ({ name: 'a', emoji: '🤖', directory, harness: 'claude-cli' }) as const;

describe('creating a claude-cli session when claude is not on the daemon PATH', () => {
  it('fails the launch with claude_not_found, closes the row -2 launch_failed and never spawns', async () => {
    const { sessions, events } = bootSessions({ PATH: emptyBin });

    const failure = await sessions.create(spec(scratch)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenFleetError);
    expect((failure as OpenFleetError).code).toBe('claude_not_found');
    expect(spawn).not.toHaveBeenCalled();
    expect(sessions.list()[0]).toMatchObject({ state: 'closed', exitCode: RESUME_LAUNCH_FAILED_EXIT_CODE });
    expect(events.find((event) => event.type === 'session.closed')).toMatchObject({ exitCode: RESUME_LAUNCH_FAILED_EXIT_CODE, reason: 'launch_failed' });
  });

  it('broadcasts the claude_not_found envelope with message and hint, and no PATH', async () => {
    const { sessions, events } = bootSessions({ PATH: emptyBin });

    await sessions.create(spec(scratch)).catch(() => undefined);

    const errorEvent = events.find((event) => event.type === 'error') as { error: Record<string, unknown> };
    expect(errorEvent.error).toMatchObject({
      error: 'claude_not_found', kind: 'unavailable', retry: 'never',
      message: 'the claude CLI is not on the daemon PATH.', hint: 'Install Claude Code or start the daemon from a shell where claude runs.',
    });
    expect(errorEvent.error).not.toHaveProperty('id');
    expect(JSON.stringify(errorEvent)).not.toContain(emptyBin);
  });

  it('logs one warn line naming the searched directories', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sessions } = bootSessions({ PATH: `${emptyBin}:/usr/bin` });

    await sessions.create(spec(scratch)).catch(() => undefined);

    const lines = warned.mock.calls.map((call) => call.map(String).join(' ')).filter((line) => line.includes('claude'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(emptyBin);
    expect(lines[0]).toContain('/usr/bin');
  });

  it('launches when claude is found on the PATH it was given', async () => {
    spawn.mockReturnValue({ onData: () => ({ dispose: () => undefined }), onExit: () => ({ dispose: () => undefined }), write: vi.fn(), resize: vi.fn(), kill: vi.fn() });
    const { sessions } = bootSessions({ PATH: `${emptyBin}:${binWithClaude}` });

    await sessions.create(spec(scratch));

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
