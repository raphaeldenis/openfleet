import { describe, expect, it } from 'vitest';
import type { SessionCloseReason } from '@openfleet/shared';
import { closedSessionPresentationFor } from './closed-session-presentation';

const SIGTERM_EXIT_CODE = 143;

interface Scenario {
  label: string;
  exitCode?: number;
  reason?: SessionCloseReason;
  resumeRequestError?: string;
  stripTitle?: string;
  stripMessage?: string;
  cardTitle: string;
  hasCardBody: boolean;
  cardTone: 'neutral' | 'error';
}

const SCENARIOS: Scenario[] = [
  { label: 'closed_by_user', exitCode: SIGTERM_EXIT_CODE, reason: 'closed_by_user', cardTitle: 'Closed · exit 143', hasCardBody: true, cardTone: 'neutral' },
  { label: 'a clean exit 0', exitCode: 0, cardTitle: 'Closed · exit 0', hasCardBody: true, cardTone: 'neutral' },
  { label: 'a close without exit code', cardTitle: 'Closed', hasCardBody: true, cardTone: 'neutral' },
  {
    label: 'harness_exit', exitCode: 137, reason: 'harness_exit', cardTitle: 'Closed · exit 137', hasCardBody: false, cardTone: 'error',
    stripTitle: 'Agent process exited', stripMessage: 'The agent process ended unexpectedly — reopen the session to resume the conversation.',
  },
  {
    label: 'harness_exit without exit code', reason: 'harness_exit', cardTitle: 'Closed', hasCardBody: false, cardTone: 'error',
    stripTitle: 'Agent process exited', stripMessage: 'The agent process ended unexpectedly — reopen the session to resume the conversation.',
  },
  {
    label: 'a non-zero exit without reason', exitCode: 1, cardTitle: 'Closed · exit 1', hasCardBody: false, cardTone: 'error',
    stripTitle: 'Agent process exited', stripMessage: 'The agent process ended unexpectedly — reopen the session to resume the conversation.',
  },
  {
    label: 'launch_failed', reason: 'launch_failed', cardTitle: 'Not running', hasCardBody: false, cardTone: 'error',
    stripTitle: 'Agent could not start',
    stripMessage: 'The agent could not start — check that the claude CLI is installed and on the PATH the daemon runs with.',
  },
  {
    label: 'daemon_shutdown', exitCode: SIGTERM_EXIT_CODE, reason: 'daemon_shutdown', cardTitle: 'Closed', hasCardBody: false, cardTone: 'neutral',
    stripTitle: 'Daemon stopped', stripMessage: 'The daemon stopped — the session resumes when it starts again.',
  },
  {
    label: 'resume_timeout', reason: 'resume_timeout', cardTitle: 'Not running', hasCardBody: false, cardTone: 'error',
    stripTitle: 'Resume timed out', stripMessage: 'The session did not come back in time — try again.',
  },
  {
    label: 'conversation_not_found', exitCode: 1, reason: 'conversation_not_found', cardTitle: 'Not running', hasCardBody: false, cardTone: 'error',
    stripTitle: 'Conversation not found',
    stripMessage: 'The transcript for this session is gone; start a new session from its handoff.',
  },
  {
    label: 'a refused reopen request', exitCode: 0, resumeRequestError: 'This session’s directory no longer exists — nothing to resume into.',
    cardTitle: 'Not running', hasCardBody: false, cardTone: 'error',
    stripTitle: 'Resume failed', stripMessage: 'This session’s directory no longer exists — nothing to resume into.',
  },
];

const presentationOf = ({ exitCode, reason, resumeRequestError }: Scenario) => closedSessionPresentationFor({ exitCode, reason, resumeRequestError });

describe('what a closed session shows', () => {
  it.each(SCENARIOS)('for $label: strip, card title, card body and tone', (scenario) => {
    const presentation = presentationOf(scenario);

    expect(presentation.strip?.title).toBe(scenario.stripTitle);
    expect(presentation.strip?.message).toBe(scenario.stripMessage);
    expect(presentation.cardTitle).toBe(scenario.cardTitle);
    expect(presentation.cardBody !== undefined).toBe(scenario.hasCardBody);
    expect(presentation.cardTone).toBe(scenario.cardTone);
  });

  it.each([
    ['launch_failed', { reason: 'launch_failed' }],
    ['resume_timeout', { reason: 'resume_timeout' }],
    ['conversation_not_found', { reason: 'conversation_not_found', exitCode: 1 }],
    ['harness_exit', { reason: 'harness_exit', exitCode: 137 }],
  ] as const)('offers to copy the details of a %s close under that code', (code, facts) => {
    expect(closedSessionPresentationFor(facts).strip?.copyableCode).toBe(code);
  });

  it('marks a missing conversation with the stop square', () => {
    expect(closedSessionPresentationFor({ exitCode: 1, reason: 'conversation_not_found' }).strip?.icon).toBe('■');
  });

  it('names a non-zero exit without reason like an unexpected agent exit', () => {
    expect(closedSessionPresentationFor({ exitCode: 1 }).strip?.copyableCode).toBe('harness_exit');
  });

  it.each([
    ['a daemon shutdown', { reason: 'daemon_shutdown' }],
    ['a clean close', { exitCode: 0, reason: 'closed_by_user' }],
    ['a refused reopen request', { exitCode: 0, resumeRequestError: 'Nothing to resume into.' }],
  ] as const)('offers no details to copy for %s', (_label, facts) => {
    expect(closedSessionPresentationFor(facts).strip?.copyableCode).toBeUndefined();
  });

  it('offers to resume every closed session except one whose conversation is gone', () => {
    const resumable = SCENARIOS.filter((scenario) => presentationOf(scenario).isResumeOffered).map((scenario) => scenario.label);
    const notResumable = SCENARIOS.filter((scenario) => !presentationOf(scenario).isResumeOffered).map((scenario) => scenario.label);

    expect(notResumable).toEqual(['conversation_not_found']);
    expect(resumable).toHaveLength(SCENARIOS.length - 1);
  });

  it('never explains a close on the strip and on the card body at once', () => {
    const explainedTwice = SCENARIOS.map(presentationOf).filter((presentation) => presentation.strip && presentation.cardBody);

    expect(explainedTwice).toEqual([]);
  });

  it.each([0, -1, -2, undefined])('never gives a card title an exit code (%s) for a start or a resume that never happened', (exitCode) => {
    const neverRunning = (['launch_failed', 'resume_timeout', 'conversation_not_found', 'daemon_shutdown'] as const).map((reason) => closedSessionPresentationFor({ exitCode, reason }).cardTitle);

    expect(neverRunning.filter((title) => title.includes('exit'))).toEqual([]);
  });

  it('degrades a reason this client does not know to the plain agent-exited presentation', () => {
    const futureReason = 'quota_exceeded' as unknown as SessionCloseReason;

    const presentation = closedSessionPresentationFor({ exitCode: 1, reason: futureReason });

    expect(presentation.strip?.title).toBe('Agent process exited');
    expect(presentation.cardTitle).toBe('Closed · exit 1');
  });

  it('never calls a refused-reopen strip a timeout', () => {
    const presentation = closedSessionPresentationFor({ exitCode: 0, resumeRequestError: 'Conversation not found.' });

    expect(presentation.strip?.title).not.toMatch(/timed out/i);
  });
});
