import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { FakeHandle, FakeHarness } from '../harness/fakeHarness.js';
import { EventBus } from '../events/eventBus.js';
import { SessionService, SUBMIT_KEYSTROKE_DELAY_MS } from './sessionService.js';

function setup() {
  const harness = new FakeHarness();
  const service = new SessionService({ db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  return { harness, service };
}
const hook = (session_id: string, event: object) => ({ kind: 'hook' as const, event: { session_id, ...event } as never });
const text = (...codePoints: number[]) => `before ${String.fromCodePoint(...codePoints)} after`;

const EMOJI_ZWJ_FAMILY = text(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const BODIES_THE_CLI_ASKS_TO_REVIEW: Record<string, string> = {
  'zero width space U+200B': text(0x200b),
  'left-to-right mark U+200E': text(0x200e),
  'right-to-left mark U+200F': text(0x200f),
  'right-to-left override U+202E': text(0x202e),
  'embedding and override controls U+202A-U+202D': text(0x202a, 0x202b, 0x202c, 0x202d),
  'isolates U+2066-U+2069': text(0x2066, 0x2067, 0x2068, 0x2069),
  'byte order mark U+FEFF': text(0xfeff),
  'word joiner U+2060': text(0x2060),
  'soft hyphen U+00AD': text(0xad),
  'tag character U+E0041': text(0xe0041),
  'line separator U+2028': text(0x2028),
  'zero width joiner between letters': `ab${String.fromCodePoint(0x200d)}cd`,
  'invisible characters mixed with a zero width joiner emoji': `${EMOJI_ZWJ_FAMILY}${String.fromCodePoint(0x200b)}`,
};
const BODIES_THE_CLI_SUBMITS_DIRECTLY: Record<string, string> = {
  'plain text': 'Reply with exactly the word OK',
  'combining mark': text(0x65, 0x301),
  'emoji zero width joiner sequence': EMOJI_ZWJ_FAMILY,
  'non breaking space': text(0xa0),
};

async function createIdleSession(service: SessionService, name: string) {
  const session = await service.create({ directory: '/tmp', name, harness: 'fake', emoji: '🤖' });
  service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
  return session;
}
const handleOf = (harness: FakeHarness, index: number): FakeHandle => harness.handles[index]!;

describe('delivery of messages holding characters the CLI strips from a paste', () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each(Object.entries(BODIES_THE_CLI_ASKS_TO_REVIEW))('submits a body with %s exactly once, although the CLI asks to review the stripped paste first', async (_label, body) => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    handleOf(harness, 0).reviewsInvisibleCharacters = true;

    service.sendMessage({ sessionId: session.id, body });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(handleOf(harness, 0).submitted).toEqual([body]);
  });

  it.each(Object.entries(BODIES_THE_CLI_SUBMITS_DIRECTLY))('submits a body with %s exactly once with a single Enter', async (_label, body) => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    handleOf(harness, 0).reviewsInvisibleCharacters = true;

    service.sendMessage({ sessionId: session.id, body });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(handleOf(harness, 0).submitted).toEqual([body]);
    expect(handleOf(harness, 0).written).toEqual([body, '\r']);
  });

  it('submits a body with a lone surrogate exactly once, stored by the queue as the replacement character', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    handleOf(harness, 0).reviewsInvisibleCharacters = true;

    service.sendMessage({ sessionId: session.id, body: `before ${String.fromCharCode(0xd800)} after` });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(handleOf(harness, 0).submitted).toEqual([text(0xfffd)]);
    expect(handleOf(harness, 0).written.filter((data) => data === '\r')).toHaveLength(1);
  });

  it('submits an agent message whose body holds a right-to-left override, header included, exactly once', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const sender = await createIdleSession(service, 'Sender');
    const target = await createIdleSession(service, 'Target');
    handleOf(harness, 1).reviewsInvisibleCharacters = true;
    const body = text(0x202e);

    service.sendMessage({ sessionId: target.id, fromSessionId: sender.id, body });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    const submitted = handleOf(harness, 1).submitted;
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain(`[from agent`);
    expect(submitted[0]).toContain(body);
  });

  it('delivers a reviewed message then the next plain one, each submitted once and in order', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    handleOf(harness, 0).reviewsInvisibleCharacters = true;
    const reviewed = text(0x200b);
    const plain = 'second, plain';

    service.sendMessage({ sessionId: session.id, body: reviewed });
    service.sendMessage({ sessionId: session.id, body: plain });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(handleOf(harness, 0).submitted).toEqual([reviewed, plain]);
  });

  it('confirms the review of one message with a single extra Enter, however often the notice is redrawn', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    handleOf(harness, 0).reviewsInvisibleCharacters = true;
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    handleOf(harness, 0).emitData('Removed 1 invisible character · review and press Enter to send');

    expect(handleOf(harness, 0).written.filter((data) => data === '\r')).toHaveLength(2);
  });

  it('never presses Enter on a review notice that no delivery of ours is waiting on', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    await createIdleSession(service, 'Target');

    handleOf(harness, 0).emitData('Removed 1 invisible character · review and press Enter to send');

    expect(handleOf(harness, 0).written).toEqual([]);
  });
});
