import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const service = new SessionService({ db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
  service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
  const typeAsHuman = (keys: string) => service.writeRaw(session.id, keys);
  const sendFromAgent = (body = AGENT_MESSAGE) => service.sendMessage({ sessionId: session.id, body, fromSessionId: 'agent-1' });
  const hookOf = (event: object) => service.applyInput(session.id, hook(session.id, event));
  const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const wasTypedIntoThePrompt = () => harness.handles[0]!.written.some((chunk) => chunk.includes(AGENT_MESSAGE));
  return { service, harness, session, typeAsHuman, sendFromAgent, hookOf, elapse, wasTypedIntoThePrompt };
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

  it('releases the held message when the draft has been left alone for DRAFT_IDLE_EXPIRY_MS', async () => {
    const { typeAsHuman, sendFromAgent, elapse, wasTypedIntoThePrompt } = await idleSession();
    typeAsHuman('hi');
    sendFromAgent();

    await elapse(DRAFT_IDLE_EXPIRY_MS - 1);
    expect(wasTypedIntoThePrompt()).toBe(false);
    await elapse(1);

    expect(wasTypedIntoThePrompt()).toBe(true);
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
