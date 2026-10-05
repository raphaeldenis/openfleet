import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { EventBus } from '../events/eventBus.js';
import { DRAFT_IDLE_EXPIRY_MS, SessionService, SUBMIT_KEYSTROKE_DELAY_MS, TURN_START_TIMEOUT_MS } from './sessionService.js';

const CTRL_C = '\x03';
const CTRL_U = '\x15';
const BACKSPACE = '\x7f';
const UP_ARROW = '\x1b[A';
const ENTER = '\r';
const AGENT_MESSAGE = 'agent: please check the build';

const hook = (session_id: string, event: object) => ({ kind: 'hook' as const, event: { session_id, ...event } as never });

async function idleSession() {
  vi.useFakeTimers();
  const harness = new FakeHarness();
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new SessionService({ db: openDatabase(':memory:'), bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
  service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
  const typeAsHuman = (keys: string) => service.writeRaw(session.id, keys);
  const sendFromAgent = (body = AGENT_MESSAGE) => service.sendMessage({ sessionId: session.id, body, fromSessionId: 'agent-1' });
  const hookOf = (event: object) => service.applyInput(session.id, hook(session.id, event));
  const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const wasTypedIntoThePrompt = () => harness.handles[0]!.written.some((chunk) => chunk.includes(AGENT_MESSAGE));
  return { service, harness, session, events, typeAsHuman, sendFromAgent, hookOf, elapse, wasTypedIntoThePrompt };
}

afterEach(() => vi.useRealTimers());

describe('SessionService delivery while the human has an unsent draft in the terminal prompt', () => {
  it('holds an agent message that arrives behind a typed draft and tells the sender why', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('h');
    typeAsHuman('i');

    const result = sendFromAgent();
    await elapse(SUBMIT_KEYSTROKE_DELAY_MS + TURN_START_TIMEOUT_MS);

    expect(result).toMatchObject({ status: 'queued', heldFor: 'human_draft' });
    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('types the held message only after the human sent their prompt', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    sendFromAgent();

    typeAsHuman(ENTER);
    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(true);
  });

  it.each([['Ctrl-C', CTRL_C], ['Ctrl-U', CTRL_U]])('types the held message once %s emptied the prompt', async (_name, key) => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    sendFromAgent();

    typeAsHuman(key);
    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(true);
  });

  it('types the held message once the human erased every character they typed', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    sendFromAgent();

    typeAsHuman(BACKSPACE + BACKSPACE);
    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(true);
  });

  it('keeps holding while an erased draft was partly recalled from history', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman(UP_ARROW);
    typeAsHuman(BACKSPACE);
    sendFromAgent();

    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('counts a history recall (Up arrow) as a draft the daemon cannot see', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman(UP_ARROW);

    const result = sendFromAgent();
    await elapse(TURN_START_TIMEOUT_MS);

    expect(result).toMatchObject({ status: 'queued', heldFor: 'human_draft' });
    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('counts a paste as a draft', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('\x1b[200~some pasted words\x1b[201~');

    sendFromAgent();
    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('keeps the draft when Enter follows a backslash, which only adds a line to the prompt', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('line one\\');
    typeAsHuman(ENTER);

    sendFromAgent();
    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('keeps the draft when Shift+Enter (Escape then Enter) adds a line to the prompt', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('line one');
    typeAsHuman('\x1b\r');

    sendFromAgent();
    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('types the held message once two Escapes in a row emptied the prompt', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    sendFromAgent();

    typeAsHuman('\x1b');
    typeAsHuman('\x1b');
    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(true);
  });

  it('keeps holding after a single Escape, which leaves the prompt text alone', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    typeAsHuman('\x1b');

    sendFromAgent();
    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('ignores cursor movement keys: they neither start nor clear a draft', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('\x1b[D\x1b[C');

    sendFromAgent();
    await elapse(0);

    expect(wasTypedIntoThePrompt()).toBe(true);
  });

  it('keeps holding the message behind a draft left alone past DRAFT_IDLE_EXPIRY_MS: typing it would submit the human\'s text with it', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    sendFromAgent();

    await elapse(DRAFT_IDLE_EXPIRY_MS * 3);

    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('tells the human once, without the message body, that a message waits behind an abandoned draft', async () => {
    const { typeAsHuman, sendFromAgent, elapse, events } = await idleSession();
    typeAsHuman('hi');
    const { messageId } = sendFromAgent();

    await elapse(DRAFT_IDLE_EXPIRY_MS * 3);

    const announcements = events.filter((event) => event.type === 'message.held');
    expect(announcements).toEqual([{ type: 'message.held', sessionId: expect.any(String), messageId, ageMs: DRAFT_IDLE_EXPIRY_MS, heldFor: 'human_draft' }]);
    expect(JSON.stringify(announcements)).not.toContain(AGENT_MESSAGE);
  });

  it('types the message held past the expiry once the human sends the draft', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    sendFromAgent();
    await elapse(DRAFT_IDLE_EXPIRY_MS);

    typeAsHuman(ENTER);
    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(true);
  });

  it('lists the held messages of a session with the reason they wait', async () => {
    const { service, session, typeAsHuman, sendFromAgent } = await idleSession();
    typeAsHuman('hi');
    const { messageId } = sendFromAgent();

    expect(service.heldMessagesOf(session.id)).toEqual([
      { messageId, fromSessionId: 'agent-1', body: expect.stringContaining(AGENT_MESSAGE), createdAt: expect.any(String), heldFor: 'human_draft' },
    ]);
  });

  it('lets the human discard a held message: it is never typed, even once the prompt is empty', async () => {
    const { service, session, typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    const { messageId } = sendFromAgent();

    const isDiscarded = service.discardHeldMessage(session.id, messageId);
    typeAsHuman(ENTER);
    await elapse(TURN_START_TIMEOUT_MS);

    expect(isDiscarded).toBe(true);
    expect(service.heldMessagesOf(session.id)).toEqual([]);
    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('lets the human release a held message: it is typed behind the draft that is still in the prompt', async () => {
    const { service, session, typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    const { messageId } = sendFromAgent();

    const isReleased = service.releaseHeldMessage(session.id, messageId);
    await elapse(0);

    expect(isReleased).toBe(true);
    expect(wasTypedIntoThePrompt()).toBe(true);
  });

  it('refuses to discard or release a message that is not held', async () => {
    const { service, session, typeAsHuman, sendFromAgent } = await idleSession();
    const { messageId } = sendFromAgent();
    typeAsHuman('hi');

    expect(service.discardHeldMessage(session.id, messageId)).toBe(false);
    expect(service.releaseHeldMessage(session.id, 'unknown-message')).toBe(false);
  });

  describe('chunk-boundary invariance: the same bytes leave the same draft wherever the transport cuts them', () => {
    const CTRL_A = '\x01';
    const SHIFT_ENTER = '\x1b\r';
    const PASTE_START = '\x1b[200~';
    const PASTE_END = '\x1b[201~';
    const scenarios: Array<{ name: string; keys: string; isHeld: boolean }> = [
      { name: 'Shift+Enter after text', keys: `human draft${SHIFT_ENTER}`, isHeld: true },
      { name: 'Shift+Enter then more text', keys: `one${SHIFT_ENTER}two`, isHeld: true },
      { name: 'Shift+Enter then Ctrl-U (earlier lines stay)', keys: `one${SHIFT_ENTER}two${CTRL_U}`, isHeld: true },
      { name: 'history recall', keys: UP_ARROW, isHeld: true },
      { name: 'history recall then Ctrl-U', keys: `${UP_ARROW}${CTRL_U}`, isHeld: true },
      { name: 'history recall then Ctrl-C', keys: `${UP_ARROW}${CTRL_C}`, isHeld: false },
      { name: 'SS3 history recall', keys: '\x1bOA', isHeld: true },
      { name: 'multiline bracketed paste', keys: `${PASTE_START}line one\rline two${PASTE_END}`, isHeld: true },
      { name: 'paste ending with a newline', keys: `${PASTE_START}line one\n${PASTE_END}`, isHeld: true },
      { name: 'paste then Ctrl-C', keys: `${PASTE_START}some words${PASTE_END}${CTRL_C}`, isHeld: false },
      { name: 'paste then Enter', keys: `${PASTE_START}some words${PASTE_END}${ENTER}`, isHeld: false },
      { name: 'paste ending with a backslash then Enter', keys: `${PASTE_START}some words\\${PASTE_END}${ENTER}`, isHeld: true },
      { name: 'paste whose text holds an Escape', keys: `${PASTE_START}a\x1bb${PASTE_END}${CTRL_C}`, isHeld: false },
      { name: 'text then Enter', keys: `hi${ENTER}`, isHeld: false },
      { name: 'backslash then Enter', keys: `hi\\${ENTER}`, isHeld: true },
      { name: 'two Escapes', keys: 'hi\x1b\x1b', isHeld: false },
      { name: 'one Escape', keys: 'hi\x1b', isHeld: true },
      { name: 'cursor keys on an empty prompt', keys: '\x1b[D\x1b[C', isHeld: false },
      { name: 'forward delete', keys: 'a\x1b[3~', isHeld: true },
      { name: 'Ctrl-U on a plain line', keys: `abc${CTRL_U}`, isHeld: false },
      { name: 'Ctrl-A then Ctrl-U (the text after the cursor stays)', keys: `abc${CTRL_A}${CTRL_U}`, isHeld: true },
      { name: 'Left arrow then Ctrl-U', keys: `abc\x1b[D${CTRL_U}`, isHeld: true },
      { name: 'Home then Backspaces (nothing is erased before the cursor)', keys: `abc\x1b[H${BACKSPACE}${BACKSPACE}${BACKSPACE}`, isHeld: true },
      { name: 'Ctrl-A then Backspaces', keys: `abc${CTRL_A}${BACKSPACE}${BACKSPACE}${BACKSPACE}`, isHeld: true },
      { name: 'Backspaces on a plain line', keys: `abc${BACKSPACE}${BACKSPACE}${BACKSPACE}`, isHeld: false },
    ];
    const splitsOf = (keys: string) => {
      const characters = Array.from(keys);
      const cutPoints = Array.from({ length: characters.length + 1 }, (_, cut) => cut);
      const twoChunks = cutPoints.map((cut) => [characters.slice(0, cut).join(''), characters.slice(cut).join('')]);
      const oneCharacterPerChunk = [characters];
      return [...twoChunks, ...oneCharacterPerChunk];
    };

    it.each(scenarios)('$name', async ({ keys, isHeld }) => {
      for (const chunks of splitsOf(keys)) {
        const { typeAsHuman, sendFromAgent } = await idleSession();
        chunks.filter((chunk) => chunk !== '').forEach(typeAsHuman);

        const result = sendFromAgent();

        expect({ chunks, heldFor: result.heldFor }).toEqual({ chunks, heldFor: isHeld ? 'human_draft' : undefined });
        vi.useRealTimers();
      }
    });
  });

  it('measures the expiry from the human\'s last keystroke', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('h');
    sendFromAgent();
    await elapse(DRAFT_IDLE_EXPIRY_MS - 1000);

    typeAsHuman('i');
    await elapse(DRAFT_IDLE_EXPIRY_MS - 1);

    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('forgets a draft when the human\'s own prompt turn starts (UserPromptSubmit), and delivers at the turn end', async () => {
    const { typeAsHuman, sendFromAgent, hookOf, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    sendFromAgent();

    hookOf({ hook_event_name: 'UserPromptSubmit' });
    hookOf({ hook_event_name: 'Stop' });
    await elapse(0);

    expect(wasTypedIntoThePrompt()).toBe(true);
  });

  it('holds a message that arrives mid-turn behind a draft typed during the turn, and delivers it after the human sent it', async () => {
    const { typeAsHuman, sendFromAgent, hookOf, elapse, wasTypedIntoThePrompt } = await idleSession();
    hookOf({ hook_event_name: 'UserPromptSubmit' });
    typeAsHuman('next idea');
    sendFromAgent();

    hookOf({ hook_event_name: 'Stop' });
    await elapse(TURN_START_TIMEOUT_MS);
    expect(wasTypedIntoThePrompt()).toBe(false);

    typeAsHuman(ENTER);
    hookOf({ hook_event_name: 'UserPromptSubmit' });
    hookOf({ hook_event_name: 'Stop' });
    await elapse(0);

    expect(wasTypedIntoThePrompt()).toBe(true);
  });

  it('never interrupts a delivery already typing: the message is submitted alone and what the human types meanwhile follows the Enter', async () => {
    const { harness, typeAsHuman, sendFromAgent, elapse } = await idleSession();
    sendFromAgent();

    typeAsHuman('w');
    await elapse(SUBMIT_KEYSTROKE_DELAY_MS);

    const { submitted, written } = harness.handles[0]!;
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain(AGENT_MESSAGE);
    expect(written).toEqual([submitted[0], ENTER, 'w']);
  });

  it('keeps the draft typed during a delivery: the turn the agent message starts does not erase it', async () => {
    const { typeAsHuman, sendFromAgent, hookOf, elapse, wasTypedIntoThePrompt } = await idleSession();
    sendFromAgent('first');
    typeAsHuman('w');
    await elapse(SUBMIT_KEYSTROKE_DELAY_MS);
    hookOf({ hook_event_name: 'UserPromptSubmit' });
    hookOf({ hook_event_name: 'Stop' });

    sendFromAgent(AGENT_MESSAGE);
    await elapse(TURN_START_TIMEOUT_MS);

    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('forgets the draft of a process that was replaced: the new prompt is empty', async () => {
    const { service, harness, session, typeAsHuman, sendFromAgent, hookOf, elapse } = await idleSession();
    harness.markPrompted(session.id);
    typeAsHuman('hi');
    service.updateModel(session.id, 'claude-opus-5-5');
    await elapse(0);
    hookOf({ hook_event_name: 'SessionStart' });
    sendFromAgent();
    await elapse(0);

    expect(harness.handles[1]!.written.some((chunk) => chunk.includes(AGENT_MESSAGE))).toBe(true);
  });
});
