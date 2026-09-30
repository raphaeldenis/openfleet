import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { FakeHandle, FakeHarness } from '../harness/fakeHarness.js';
import { EventBus } from '../events/eventBus.js';
import type { ServerEvent } from '@openfleet/shared';
import { describeError } from '../errors/describeError.js';
import {
  MAX_REVIEW_CONFIRMATIONS, REVIEW_CONFIRMATION_PATIENCE_MS, REVIEW_NOTICE_WINDOW_MS, REVIEW_SETTLE_MS, SessionService, SUBMIT_KEYSTROKE_DELAY_MS,
} from './sessionService.js';

const UNTIL_REVIEW_CONFIRMED_MS = SUBMIT_KEYSTROKE_DELAY_MS + REVIEW_SETTLE_MS + 1;
// The real CLI's hooks: the turn starts ~55 ms after an accepted Enter and ends a moment later.
const TURN_STARTS_AFTER_SUBMIT_MS = 55;
const TURN_ENDS_AFTER_SUBMIT_MS = 300;

function setup() {
  const harness = new FakeHarness();
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new SessionService({ db: openDatabase(':memory:'), bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', describeError });
  return { harness, service, events };
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
    await vi.advanceTimersByTimeAsync(UNTIL_REVIEW_CONFIRMED_MS);

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
    await vi.advanceTimersByTimeAsync(REVIEW_SETTLE_MS + 1);

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
    await vi.advanceTimersByTimeAsync(UNTIL_REVIEW_CONFIRMED_MS);

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
    await vi.advanceTimersByTimeAsync(UNTIL_REVIEW_CONFIRMED_MS);
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
    await vi.advanceTimersByTimeAsync(REVIEW_SETTLE_MS + 1);

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

function useRealCliTiming(service: SessionService, sessionId: string, handle: FakeHandle, options: { neverAcceptsEnter?: boolean } = {}) {
  handle.reviewsInvisibleCharacters = true;
  handle.reviewTiming = { noticeDelayMs: 3, ignoresEnterForMs: 150, neverAcceptsEnter: options.neverAcceptsEnter ?? false };
  handle.onSubmit = () => {
    setTimeout(() => service.applyInput(sessionId, hook(sessionId, { hook_event_name: 'UserPromptSubmit' })), TURN_STARTS_AFTER_SUBMIT_MS);
    setTimeout(() => service.applyInput(sessionId, hook(sessionId, { hook_event_name: 'Stop' })), TURN_ENDS_AFTER_SUBMIT_MS);
  };
}
const countOf = (events: ServerEvent[], type: ServerEvent['type']) => events.filter((event) => event.type === type).length;
const carriageReturnsIn = (handle: FakeHandle) => handle.written.filter((data) => data === '\r').length;
const RLO_AND_PDF = text(0x202e, 0x202c);

describe('delivery against the real CLI timing: a notice 3 ms after the Enter, Enters ignored for 150 ms', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('submits a queue of a reviewed, a plain and another reviewed message once each and in order, never merged', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0));
    const first = text(0x200b);
    const second = 'Reply with exactly the word Q6-OK';
    const third = RLO_AND_PDF;

    [first, second, third].forEach((body) => service.sendMessage({ sessionId: session.id, body }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(handleOf(harness, 0).submitted).toEqual([first, second, third]);
  });

  it('waits the settle delay after the notice before pressing Enter again, and presses it once it passed', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0));
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 3);
    await vi.advanceTimersByTimeAsync(REVIEW_SETTLE_MS - 1);
    const pressesBeforeSettle = carriageReturnsIn(handleOf(harness, 0));
    await vi.advanceTimersByTimeAsync(1);
    const pressesAfterSettle = carriageReturnsIn(handleOf(harness, 0));

    expect({ pressesBeforeSettle, pressesAfterSettle }).toEqual({ pressesBeforeSettle: 1, pressesAfterSettle: 2 });
    expect(handleOf(harness, 0).submitted).toHaveLength(1);
  });

  it('retries the confirmation a bounded number of times when the CLI never accepts it', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true });
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(60_000);

    const submitEnterPlusConfirmations = 1 + MAX_REVIEW_CONFIRMATIONS;
    expect(carriageReturnsIn(handleOf(harness, 0))).toBe(submitEnterPlusConfirmations);
  });

  it('does not report a reviewed message delivered before the CLI accepted it, then reports it once the turn started', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0));
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 3);
    await vi.advanceTimersByTimeAsync(REVIEW_SETTLE_MS - 1);
    const deliveredWhileUnderReview = countOf(events, 'message.delivered');
    await vi.advanceTimersByTimeAsync(1 + TURN_STARTS_AFTER_SUBMIT_MS);
    const deliveredOnceAccepted = countOf(events, 'message.delivered');
    await vi.advanceTimersByTimeAsync(10_000);

    expect({ deliveredWhileUnderReview, deliveredOnceAccepted, deliveredInTheEnd: countOf(events, 'message.delivered') })
      .toEqual({ deliveredWhileUnderReview: 0, deliveredOnceAccepted: 1, deliveredInTheEnd: 1 });
  });

  it('never reports a message delivered that the CLI never accepted, and announces a delivery failure with advice', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true });
    service.sendMessage({ sessionId: session.id, body: RLO_AND_PDF });

    await vi.advanceTimersByTimeAsync(60_000);

    const failures = events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
    expect(countOf(events, 'message.delivered')).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ error: 'delivery_failed' });
    expect(failures[0]?.message).toContain('invisible characters');
    expect(failures[0]?.hint).toBeTruthy();
  });

  it('empties a composer the CLI never let go of, so the next message is not typed on top of it', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true });
    service.sendMessage({ sessionId: session.id, body: RLO_AND_PDF });
    await vi.advanceTimersByTimeAsync(60_000);
    const composerAfterFailure = handleOf(harness, 0).composerText;
    handleOf(harness, 0).reviewTiming.neverAcceptsEnter = false;

    service.sendMessage({ sessionId: session.id, body: 'plain follow-up' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(composerAfterFailure).toBe('');
    expect(handleOf(harness, 0).composerClearCount).toBe(1);
    expect(handleOf(harness, 0).submitted).toEqual(['plain follow-up']);
  });

  it('never types the next queued message on top of a reviewed one the CLI still holds', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true });
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    service.sendMessage({ sessionId: session.id, body: 'plain behind it' });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(handleOf(harness, 0).submitted).toEqual(['plain behind it']);
  });

  it('keeps a plain body exactly as before: one Enter, reported delivered the moment it is submitted', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0));
    const body = 'Reply with exactly the word OK';
    service.sendMessage({ sessionId: session.id, body });

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(handleOf(harness, 0).written).toEqual([body, '\r']);
    expect(countOf(events, 'message.delivered')).toBe(1);
  });

  it('reports a body the CLI submits directly but that looks reviewable (an emoji joiner) delivered once the review window passed', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    handle.reviewsInvisibleCharacters = true;
    service.sendMessage({ sessionId: session.id, body: EMOJI_ZWJ_FAMILY });

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    const deliveredRightAfterSubmit = countOf(events, 'message.delivered');
    await vi.advanceTimersByTimeAsync(REVIEW_NOTICE_WINDOW_MS);

    expect({ deliveredRightAfterSubmit, deliveredAfterWindow: countOf(events, 'message.delivered') })
      .toEqual({ deliveredRightAfterSubmit: 0, deliveredAfterWindow: 1 });
    expect(carriageReturnsIn(handle)).toBe(1);
  });

  it('presses Enter again at the settle pace while the CLI keeps ignoring it, each press after the patience delay', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true });
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 3 + REVIEW_SETTLE_MS);
    const pressesAfterFirstConfirmation = carriageReturnsIn(handleOf(harness, 0));
    await vi.advanceTimersByTimeAsync(REVIEW_CONFIRMATION_PATIENCE_MS - 1);
    const pressesBeforePatience = carriageReturnsIn(handleOf(harness, 0));
    await vi.advanceTimersByTimeAsync(1);

    expect({ pressesAfterFirstConfirmation, pressesBeforePatience, pressesAfterPatience: carriageReturnsIn(handleOf(harness, 0)) })
      .toEqual({ pressesAfterFirstConfirmation: 2, pressesBeforePatience: 2, pressesAfterPatience: 3 });
  });
});
