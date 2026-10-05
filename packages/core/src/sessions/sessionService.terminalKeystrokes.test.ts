import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { EventBus } from '../events/eventBus.js';
import { describeError } from '../errors/describeError.js';
import { SessionService, SUBMIT_KEYSTROKE_DELAY_MS } from './sessionService.js';

const ENTER = '\r';
const SHIFT_ENTER_AS_XTERM_ENCODES_IT = '\r';
const CTRL_J = '\n';
const BRACKETED_PASTE_OF_TWO_LINES = '\x1b[200~line one\nline two\x1b[201~';

function setup() {
  const harness = new FakeHarness();
  const service = new SessionService({
    db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', describeError,
  });
  return { harness, service };
}

async function createIdleSession(service: SessionService) {
  const session = await service.create({ directory: '/tmp', name: 'typing', harness: 'fake', emoji: '⌨️' });
  service.applyInput(session.id, { kind: 'hook', event: { session_id: session.id, hook_event_name: 'SessionStart' } as never });
  return session;
}

function typeIntoTerminal(service: SessionService, sessionId: string, keystrokes: readonly string[]): void {
  for (const keystroke of keystrokes) service.writeRaw(sessionId, keystroke);
}

afterEach(() => vi.useRealTimers());

describe('the bytes the pty receives for keys typed in the embedded terminal', () => {
  it('writes each keystroke as its own chunk, in order, so the CLI sees the Enter as a lone key and not as text pasted with a line break', async () => {
    const { harness, service } = setup();
    const session = await createIdleSession(service);

    typeIntoTerminal(service, session.id, ['h', 'i', ENTER]);

    expect(harness.handles[0]!.written).toEqual(['h', 'i', '\r']);
  });

  it.each([
    ['Enter', ENTER, '\r'],
    ['Shift+Enter, which xterm.js encodes like Enter', SHIFT_ENTER_AS_XTERM_ENCODES_IT, '\r'],
    ['Ctrl+J', CTRL_J, '\n'],
    ['Alt+Enter', '\x1b\r', '\x1b\r'],
  ])('forwards %s untouched', async (_label, keystroke, expectedBytes) => {
    const { harness, service } = setup();
    const session = await createIdleSession(service);

    service.writeRaw(session.id, keystroke);

    expect(harness.handles[0]!.written).toEqual([expectedBytes]);
  });

  it('forwards a bracketed paste of several lines as one unmodified chunk', async () => {
    const { harness, service } = setup();
    const session = await createIdleSession(service);

    service.writeRaw(session.id, BRACKETED_PASTE_OF_TWO_LINES);

    expect(harness.handles[0]!.written).toEqual([BRACKETED_PASTE_OF_TWO_LINES]);
  });

  it('keeps h, i, Enter in order and separate when they were typed while a queued message waits for its own Enter', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service);
    service.sendMessage({ sessionId: session.id, body: 'do X' });

    typeIntoTerminal(service, session.id, ['h', 'i', ENTER]);
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(harness.handles[0]!.written).toEqual(['do X', '\r', 'h', 'i', '\r']);
  });
});
