import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { FakeHandle, FakeHarness } from '../harness/fakeHarness.js';
import { EventBus } from '../events/eventBus.js';
import type { ServerEvent } from '@openfleet/shared';
import { describeError } from '../errors/describeError.js';
import {
  MAX_REVIEW_CONFIRMATIONS, REVIEW_CONFIRMATION_PATIENCE_MS, REVIEW_NOTICE_WINDOW_MS, REVIEW_SETTLE_MS, REVIEW_UNCONFIRMED_RELEASE_MS, SessionService, SUBMIT_KEYSTROKE_DELAY_MS, TURN_START_TIMEOUT_MS,
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
  const db = openDatabase(':memory:');
  const service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', describeError });
  return { harness, service, events, db };
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
  'several lines, a carriage return and a tab, as every agent envelope is': 'line one\nline two\r\nline three\tend',
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

function useRealCliTiming(service: SessionService, sessionId: string, handle: FakeHandle, options: { neverAcceptsEnter?: boolean; redrawsNoticeOnIgnoredEnter?: boolean } = {}) {
  handle.reviewsInvisibleCharacters = true;
  handle.reviewTiming = { noticeDelayMs: 3, ignoresEnterForMs: 150, neverAcceptsEnter: options.neverAcceptsEnter ?? false, redrawsNoticeOnIgnoredEnter: options.redrawsNoticeOnIgnoredEnter ?? false };
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
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true, redrawsNoticeOnIgnoredEnter: true });
    service.sendMessage({ sessionId: session.id, body: RLO_AND_PDF });

    await vi.advanceTimersByTimeAsync(60_000);

    const failures = events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
    expect(countOf(events, 'message.delivered')).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ error: 'message_held_for_review' });
    expect(failures[0]?.message).toContain('invisible characters');
    expect(failures[0]?.hint).toBeTruthy();
  });

  it('empties a composer the CLI never let go of, so the next message is not typed on top of it', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true, redrawsNoticeOnIgnoredEnter: true });
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
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true, redrawsNoticeOnIgnoredEnter: true });
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

const ESCAPE = '\u001b';
const errorsOf = (events: ServerEvent[]) => events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
const PLAIN_BODY_QUOTING_THE_NOTICE = 'please review and press Enter to send the report';
// The hook of the turn never reaches the daemon (no onSubmit): only the pty output tells what the CLI does.
function useRealCliWithLostHooks(handle: FakeHandle, options: { neverAcceptsEnter?: boolean; redrawsNoticeOnIgnoredEnter?: boolean } = {}) {
  handle.reviewsInvisibleCharacters = true;
  handle.showsGeneratingMarker = true;
  handle.reviewTiming = { noticeDelayMs: 3, ignoresEnterForMs: 150, neverAcceptsEnter: options.neverAcceptsEnter ?? false, redrawsNoticeOnIgnoredEnter: options.redrawsNoticeOnIgnoredEnter ?? false };
}

describe('a review that never gets the proof the composer still holds the paste: no Escape is ever pressed blindly', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('presses no Escape into a CLI that took the message although its turn-start hook is lost', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliWithLostHooks(handle);

    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(120_000);

    expect({ submitted: handle.submitted.length, escapes: handle.written.filter((data) => data === ESCAPE).length, interrupts: handle.interruptCount, rewinds: handle.rewindOpenCount })
      .toEqual({ submitted: 1, escapes: 0, interrupts: 0, rewinds: 0 });
  });

  it('keeps the queue behind a held message until its hook arrives, then reports it delivered without any error', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliWithLostHooks(handleOf(harness, 0));
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    service.sendMessage({ sessionId: session.id, body: 'plain behind it' });

    await vi.advanceTimersByTimeAsync(30_000);
    const writtenWhileHeld = handleOf(harness, 0).written.filter((data) => data.includes('plain behind it')).length;
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    expect({ writtenWhileHeld, writtenAfterHook: handleOf(harness, 0).written.filter((data) => data.includes('plain behind it')).length, errors: errorsOf(events).length, delivered: countOf(events, 'message.delivered') })
      .toEqual({ writtenWhileHeld: 0, writtenAfterHook: 1, errors: 0, delivered: 2 });
  });

  it('releases the queue after 60 seconds without a hook, announcing one error and pressing nothing more', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliWithLostHooks(handle, { neverAcceptsEnter: true });
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    service.sendMessage({ sessionId: session.id, body: 'plain behind it' });

    await vi.advanceTimersByTimeAsync(58_000);
    const writtenJustBeforeTheLimit = handle.written.filter((data) => data.includes('plain behind it')).length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect({ writtenJustBeforeTheLimit, writtenAfter: handle.written.filter((data) => data.includes('plain behind it')).length, escapes: handle.written.filter((data) => data === ESCAPE).length, errors: errorsOf(events).map((error) => error.error) })
      .toEqual({ writtenJustBeforeTheLimit: 0, writtenAfter: 1, escapes: 0, errors: ['message_held_for_review'] });
  });

  it('presses no Escape when the CLI shows its generating marker, even with the notice redrawn', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliWithLostHooks(handle, { neverAcceptsEnter: true, redrawsNoticeOnIgnoredEnter: true });
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 1000);
    handle.emitData('✻ Thinking… (esc to interrupt)');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(handle.written.filter((data) => data === ESCAPE)).toEqual([]);
  });

  it('clears the composer with the Escape pair only when the notice was redrawn after the last confirmation', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliWithLostHooks(handle, { neverAcceptsEnter: true, redrawsNoticeOnIgnoredEnter: true });
    handle.showsGeneratingMarker = false;

    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(10_000);

    expect({ escapes: handle.written.filter((data) => data === ESCAPE).length, composer: handle.composerText, cleared: handle.composerClearCount, rewinds: handle.rewindOpenCount })
      .toEqual({ escapes: 2, composer: '', cleared: 1, rewinds: 0 });
  });

  it('ignores the notice text echoed by a plain message that quotes it, pressing no Enter beyond the submit', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    handle.onSubmit = (body) => { setTimeout(() => handle.emitData(body), 5); };

    service.sendMessage({ sessionId: session.id, body: PLAIN_BODY_QUOTING_THE_NOTICE });
    await vi.advanceTimersByTimeAsync(10_000);

    expect({ enters: carriageReturnsIn(handle), escapes: handle.written.filter((data) => data === ESCAPE).length }).toEqual({ enters: 1, escapes: 0 });
  });

  it.each([
    ['60 columns', 'Removed 1 invisible character · review and press Enter …'],
    ['64 columns', 'Removed 1 invisible character · review and press Enter to s…'],
    ['a start alone', 'Removed 12 invisible characters'],
    ['a tail alone', '… press Enter to s…'],
  ])('confirms the review when a narrow terminal truncates the notice (%s)', async (_width, noticeText) => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliTiming(service, session.id, handle);
    handle.noticeText = noticeText;

    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(10_000);

    expect({ submitted: handle.submitted.length, composer: handle.composerText, errors: countOf(events, 'error') }).toEqual({ submitted: 1, composer: '', errors: 0 });
  });

  it('ignores the truncated notice start echoed by a plain message that quotes it', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    handle.onSubmit = (body) => { setTimeout(() => handle.emitData(body), 5); };

    service.sendMessage({ sessionId: session.id, body: 'the log said Removed 3 invisible characters earlier' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect({ enters: carriageReturnsIn(handle), escapes: handle.written.filter((data) => data === ESCAPE).length }).toEqual({ enters: 1, escapes: 0 });
  });

  it('keeps the queue gated after a silent swallow, announces one error and releases without pressing anything', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliWithLostHooks(handle);
    handle.swallowsReviewSilently = true;
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    service.sendMessage({ sessionId: session.id, body: 'second message' });

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + REVIEW_NOTICE_WINDOW_MS + TURN_START_TIMEOUT_MS + 1_000);
    const typedWhileGated = handle.composerText.includes('second message');
    await vi.advanceTimersByTimeAsync(REVIEW_UNCONFIRMED_RELEASE_MS);

    const errors = events.flatMap((event) => (event.type === 'error' ? [event.error.error] : []));
    expect({ typedWhileGated, errors, escapes: handle.written.filter((data) => data === ESCAPE).length, enters: carriageReturnsIn(handle) })
      .toEqual({ typedWhileGated: false, errors: ['message_held_for_review'], escapes: 0, enters: 2 });
  });

  it('counts only a notice drawn after the last confirmation: one drawn before it proves nothing', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliWithLostHooks(handle, { neverAcceptsEnter: true });
    handle.showsGeneratingMarker = false;
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(150 + 3 + 400);
    handle.emitData('Removed 1 invisible character · review and press Enter to send');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(handle.written.filter((data) => data === ESCAPE)).toEqual([]);
  });

  it('keeps the second Escape back when the CLI shows its generating marker between the two', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliWithLostHooks(handle, { neverAcceptsEnter: true, redrawsNoticeOnIgnoredEnter: true });
    handle.showsGeneratingMarker = false;
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(150 + 3 + 300 + 700 * 3 + 50);
    const escapesAfterTheFirst = handle.written.filter((data) => data === ESCAPE).length;
    handle.emitData('✻ Working… (esc to interrupt)');
    await vi.advanceTimersByTimeAsync(1000);

    expect({ escapesAfterTheFirst, escapesInTheEnd: handle.written.filter((data) => data === ESCAPE).length }).toEqual({ escapesAfterTheFirst: 1, escapesInTheEnd: 1 });
  });

  it('reports a multi-line plain body delivered the moment it is submitted, without any review watch', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0));

    service.sendMessage({ sessionId: session.id, body: 'line one\nline two\r\nline three\tend' });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    expect({ enters: carriageReturnsIn(handleOf(harness, 0)), delivered: countOf(events, 'message.delivered') }).toEqual({ enters: 1, delivered: 1 });
  });
});

const NOTICE = 'Removed 1 invisible character · review and press Enter to send';
const turnStartedBy = (sessionId: string) => hook(sessionId, { hook_event_name: 'UserPromptSubmit' });

describe('what counts as the CLI having accepted a reviewed message', () => {
  afterEach(() => { vi.useRealTimers(); });

  async function holdReviewedMessage() {
    vi.useFakeTimers();
    const context = setup();
    const session = await createIdleSession(context.service, 'Target');
    const handle = handleOf(context.harness, 0);
    useRealCliWithLostHooks(handle, { neverAcceptsEnter: true });
    context.service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    context.service.sendMessage({ sessionId: session.id, body: 'plain behind it' });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 1000);
    return { ...context, session, handle };
  }
  const plainBehindItWritten = (handle: FakeHandle) => handle.written.filter((data) => data.includes('plain behind it')).length;

  it.each([
    ['a Notification asking for input', { hook_event_name: 'Notification', notification_type: 'agent_needs_input' }],
    ['a SessionEnd', { hook_event_name: 'SessionEnd', reason: 'other' }],
  ])('does not take %s for the CLI accepting the held message', async (_label, event) => {
    const { service, session, events, handle } = await holdReviewedMessage();

    service.applyInput(session.id, hook(session.id, event));
    await vi.advanceTimersByTimeAsync(100);

    expect({ delivered: countOf(events, 'message.delivered'), typedOnTopOfIt: plainBehindItWritten(handle) }).toEqual({ delivered: 0, typedOnTopOfIt: 0 });
  });

  it.each([
    ['the UserPromptSubmit hook', { hook_event_name: 'UserPromptSubmit' }],
    ['a transition into generating (PreToolUse)', { hook_event_name: 'PreToolUse' }],
    ['a transition into waiting_permission', { hook_event_name: 'PermissionRequest' }],
  ])('takes %s for the CLI accepting the held message', async (_label, event) => {
    const { service, session, events } = await holdReviewedMessage();

    service.applyInput(session.id, hook(session.id, event));

    expect(countOf(events, 'message.delivered')).toBe(1);
  });
});

describe('the review notice as the CLI really draws it', () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ['wrapped onto the next line by a narrow terminal', 'Removed 1 invisible character · review and\r\n      press Enter to send'],
    ['split by cursor moves', 'Removed 1 invisible character · review and\u001b[1B\u001b[4Dpress Enter\u001b[2Cto send'],
    ['styled word by word', '\u001b[2mRemoved 1 invisible character · \u001b[22mreview\u001b[1m and\u001b[22m press\u001b[0m Enter to send'],
  ])('confirms the paste when the notice is %s', async (_label, drawnNotice) => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 10);

    handle.emitData(drawnNotice);
    await vi.advanceTimersByTimeAsync(301);

    expect({ enters: carriageReturnsIn(handle), submitted: handle.submitted.length }).toEqual({ enters: 2, submitted: 1 });
  });

  it('confirms the paste when the notice is cut in two pty chunks', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 10);

    handle.emitData('Removed 1 invisible character · review and pre');
    handle.emitData('ss Enter to send');
    await vi.advanceTimersByTimeAsync(301);

    expect(carriageReturnsIn(handle)).toBe(2);
  });

  it('confirms a notice that shows 100 ms after the Enter, inside the watch window', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0));
    handleOf(harness, 0).reviewTiming.noticeDelayMs = 100;
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 200);
    const deliveredWhileUnderReview = countOf(events, 'message.delivered');
    await vi.advanceTimersByTimeAsync(1000);

    expect({ deliveredWhileUnderReview, delivered: countOf(events, 'message.delivered'), submitted: handleOf(harness, 0).submitted.length }).toEqual({ deliveredWhileUnderReview: 0, delivered: 1, submitted: 1 });
  });

  it('confirms a notice that follows a body classified plain, reporting it delivered once', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    service.sendMessage({ sessionId: session.id, body: 'Reply with exactly the word OK' });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 5);

    handle.emitData(NOTICE);
    await vi.advanceTimersByTimeAsync(301);
    service.applyInput(session.id, turnStartedBy(session.id));

    expect({ enters: carriageReturnsIn(handle), delivered: countOf(events, 'message.delivered') }).toEqual({ enters: 2, delivered: 1 });
  });

  it('never presses Enter on a notice that is still drawn from the previous message when the next one is submitted', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    service.sendMessage({ sessionId: session.id, body: 'first plain' });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    service.applyInput(session.id, turnStartedBy(session.id));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    handle.emitData(NOTICE);
    handle.onSubmit = () => { setTimeout(() => handle.emitData('> '), 5); };
    service.sendMessage({ sessionId: session.id, body: 'second plain' });

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 2000);

    expect(carriageReturnsIn(handle)).toBe(2);
  });
});

describe('the real CLI numbers, pinned as literals', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('delivers on the first confirmation although the CLI ignores Enter for 250 ms after its notice', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0));
    handleOf(harness, 0).reviewTiming.ignoresEnterForMs = 250;
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(150 + 3 + 301);

    expect({ enters: carriageReturnsIn(handleOf(harness, 0)), submitted: handleOf(harness, 0).submitted.length }).toEqual({ enters: 2, submitted: 1 });
  });

  it('delivers on the third confirmation when the CLI ignores Enter for 1500 ms after its notice', async () => {
    vi.useFakeTimers();
    const { harness, service, events } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0));
    handleOf(harness, 0).reviewTiming.ignoresEnterForMs = 1500;
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(10_000);

    expect({ submitted: handleOf(harness, 0).submitted.length, enters: carriageReturnsIn(handleOf(harness, 0)), errors: errorsOf(events).length, delivered: countOf(events, 'message.delivered') })
      .toEqual({ submitted: 1, enters: 4, errors: 0, delivered: 1 });
  });

  it('stays bounded at three confirmations when the notice is redrawn after each ignored Enter', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true, redrawsNoticeOnIgnoredEnter: true });
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(carriageReturnsIn(handleOf(harness, 0))).toBe(4);
  });
});

describe('the session around a review', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('runs a model change requested during the review once the review was abandoned', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true, redrawsNoticeOnIgnoredEnter: true });
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 1000);

    const answer = service.updateModel(session.id, 'sonnet');
    await vi.advanceTimersByTimeAsync(10_000);

    expect({ answer: answer.status, launches: harness.launches.length }).toEqual({ answer: 'deferred', launches: 2 });
  });

  it('presses no more Enter once a resume replaced the process during the confirmations', async () => {
    vi.useFakeTimers();
    const { harness, service, db } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliTiming(service, session.id, handle, { neverAcceptsEnter: true });
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 10);
    const enterPressesBeforeTheResume = carriageReturnsIn(handle);

    await new SessionService({ db, bus: new EventBus(), harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' }).resumeAll();
    await vi.advanceTimersByTimeAsync(5000);

    expect(carriageReturnsIn(handle)).toBe(enterPressesBeforeTheResume);
  });

  it('reports nothing delivered for a message typed into a process a resume replaced before the notice window ended', async () => {
    vi.useFakeTimers();
    const { service, db, events } = setup();
    const session = await createIdleSession(service, 'Target');
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    await new SessionService({ db, bus: new EventBus(), harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' }).resumeAll();
    await vi.advanceTimersByTimeAsync(1000);

    expect(countOf(events, 'message.delivered')).toBe(0);
  });

  it('keeps a throwing confirmation from wedging the queue: the review resumes and the next message is delivered', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliTiming(service, session.id, handle);
    const write = handle.write.bind(handle);
    let enterCount = 0;
    handle.write = (data: string) => {
      if (data === '\r') enterCount += 1;
      const isTheFirstConfirmation = data === '\r' && enterCount === 2;
      if (isTheFirstConfirmation) throw new Error('pty write failed');
      write(data);
    };
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    service.sendMessage({ sessionId: session.id, body: 'plain behind it' });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(handle.submitted).toEqual([text(0x200b), 'plain behind it']);
  });
});

describe('a message held for review is not a message that can be rewritten or replayed', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('refuses to rewrite the body of a message the composer already holds', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true });
    const { messageId } = service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 10);

    expect(service.replaceQueuedMessageBody({ sessionId: session.id, messageId, body: 'a longer wake line' })).toBe(false);
  });

  it('never reports an abandoned message delivered when its sender replays the same message_id', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    useRealCliTiming(service, session.id, handleOf(harness, 0), { neverAcceptsEnter: true, redrawsNoticeOnIgnoredEnter: true });
    const replay = { sessionId: session.id, body: text(0x200b), messageId: 'msg-held-1' };
    service.sendMessage(replay);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(() => service.sendMessage(replay)).toThrow(expect.objectContaining({ code: 'message_held_for_review' }));
  });
});

describe('raw terminal input typed while a message is under review', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reaches the pty only after the review ended, never submitted together with the held message', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliTiming(service, session.id, handle);
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 10);

    service.writeRaw(session.id, ' HUMAN-DRAFT');
    const writtenWhileUnderReview = handle.written.includes(' HUMAN-DRAFT');
    await vi.advanceTimersByTimeAsync(1000);

    expect({ writtenWhileUnderReview, writtenAfterTheReview: handle.written.lastIndexOf(' HUMAN-DRAFT') > handle.written.lastIndexOf('\r') }).toEqual({ writtenWhileUnderReview: false, writtenAfterTheReview: true });
  });

  it('passes an Escape through at once, and then never presses the Escape pair over the human', async () => {
    vi.useFakeTimers();
    const { harness, service } = setup();
    const session = await createIdleSession(service, 'Target');
    const handle = handleOf(harness, 0);
    useRealCliTiming(service, session.id, handle, { neverAcceptsEnter: true, redrawsNoticeOnIgnoredEnter: true });
    service.sendMessage({ sessionId: session.id, body: text(0x200b) });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + 10);

    service.writeRaw(session.id, ESCAPE);
    const escapesRightAway = handle.written.filter((data) => data === ESCAPE).length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect({ escapesRightAway, escapesInTheEnd: handle.written.filter((data) => data === ESCAPE).length }).toEqual({ escapesRightAway: 1, escapesInTheEnd: 1 });
  });
});
