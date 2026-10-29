import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { outputBinding } from '@angular/core';
import type { EscalationQuestionView, EscalationView, ManagerView, Session } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { EscalationCardsComponent } from './escalation-cards.component';
import { connectToScriptedDaemon } from './governance-events-harness';

const MANAGER_ID = 'm1';
const MINUTE_MS = 60_000;
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);

const questionOf = (id: string, patch: Partial<EscalationQuestionView> = {}): EscalationQuestionView => ({
  questionId: id, text: `Question ${id}?`, declaredClass: 'technical', effectiveClasses: ['contract'], status: 'pending_human', ...patch,
});

const escalationOf = (patch: Partial<EscalationView> = {}): EscalationView => ({
  id: 'e1', managerId: MANAGER_ID, ticket: 'CCM-1', status: 'pending', body: 'Escalation e1 on CCM-1: 2 question(s) — contract, spend',
  createdAt: new Date(Date.now() - 5 * MINUTE_MS).toISOString(), questions: [questionOf('q1'), questionOf('q2', { effectiveClasses: ['spend'] })], ...patch,
});

const managerSession = { id: MANAGER_ID, name: 'Lloyd', emoji: '🧭', state: 'idle', role: 'manager', projectId: 'p1' } as Session;
const managerView = { sessionId: MANAGER_ID } as ManagerView;

interface SetupOptions {
  readonly apiPatch?: Record<string, unknown>;
  readonly onNoCardLeft?: () => void;
}

async function setup(escalations: EscalationView[], { apiPatch = {}, onNoCardLeft = () => undefined }: SetupOptions = {}) {
  const daemon = await connectToScriptedDaemon({ sessions: [managerSession], managers: [managerView], escalations });
  const api = { answerEscalation: vi.fn().mockResolvedValue({}), ...apiPatch };
  const { fixture } = await render(EscalationCardsComponent, {
    bindings: [outputBinding('noCardLeft', onNoCardLeft)],
    providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: daemon.events }],
  });
  return { ...daemon, api, fixture };
}

const answerField = (questionText: string) => screen.getByRole<HTMLTextAreaElement>('textbox', { name: questionText });
const submitButton = () => screen.getByRole('button', { name: /^Send answers/ });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('EscalationCardsComponent', () => {
  describe('reading', () => {
    it('shows the escalation with its manager, ticket, age and the body the daemon wrote', async () => {
      await setup([escalationOf()]);

      const card = screen.getByTestId('escalation-card');
      expect(within(card).getByText('ESCALATION')).toBeVisible();
      expect(within(card).getByText('Lloyd')).toBeVisible();
      expect(within(card).getByTestId('escalation-ticket')).toHaveTextContent('CCM-1');
      expect(within(card).getByTestId('escalation-age')).toHaveTextContent('5 min');
      expect(within(card).getByTestId('escalation-body')).toHaveTextContent('Escalation e1 on CCM-1: 2 question(s) — contract, spend');
    });

    it('shows each question with its classes, its options and the manager recommendation', async () => {
      const question = questionOf('q1', { effectiveClasses: ['contract', 'security'], options: ['Bump to 14', 'Keep 13'], recommendation: 'Bump to 14' });
      await setup([escalationOf({ questions: [question] })]);

      const asked = screen.getByTestId('escalation-question');
      expect(within(asked).getByTestId('escalation-classes')).toHaveTextContent('contract, security');
      expect(within(asked).getByText('Keep 13')).toBeVisible();
      expect(within(asked).getByTestId('escalation-recommendation')).toHaveTextContent('Bump to 14');
    });

    it('asks only the questions still awaiting a human answer', async () => {
      const answered = questionOf('q1', { status: 'answered', humanAnswer: 'Done' });
      await setup([escalationOf({ questions: [answered, questionOf('q2')] })]);

      expect(screen.queryByRole('textbox', { name: 'Question q1?' })).toBeNull();
      expect(answerField('Question q2?')).toBeVisible();
    });

    it('draws a hostile question as inert plain text', async () => {
      const hostile = `<img src=x onerror="window.pwned=1"> ${RIGHT_TO_LEFT_OVERRIDE}evil`;
      await setup([escalationOf({ questions: [questionOf('q1', { text: hostile })] })]);

      expect(screen.getByTestId('escalation-question').querySelector('img')).toBeNull();
      expect(screen.getByTestId('escalation-question').textContent).not.toContain(RIGHT_TO_LEFT_OVERRIDE);
    });

    it('shows a closed manager by a neutral name when its session is gone', async () => {
      await setup([escalationOf({ managerId: 'gone' })]);

      expect(within(screen.getByTestId('escalation-card')).getByTestId('escalation-manager')).toHaveTextContent('Unknown manager');
    });

    it('announces how many escalations need the user in a status region', async () => {
      await setup([escalationOf(), escalationOf({ id: 'e2' })]);

      expect(screen.getByRole('status', { name: 'Escalations' })).toHaveTextContent('2 escalations need you');
    });
  });

  describe('answering', () => {
    it('gives one answer field per pending question and keeps the send button off until all are answered', async () => {
      await setup([escalationOf()]);
      expect(submitButton()).toBeDisabled();

      await userEvent.type(answerField('Question q1?'), 'Bump it');
      expect(submitButton()).toBeDisabled();

      await userEvent.type(answerField('Question q2?'), 'Approved');
      expect(submitButton()).toBeEnabled();
    });

    it('does not count an answer made of spaces', async () => {
      await setup([escalationOf()]);

      await userEvent.type(answerField('Question q1?'), 'Bump it');
      await userEvent.type(answerField('Question q2?'), '   ');

      expect(submitButton()).toBeDisabled();
    });

    it('sends the trimmed answers, one per question, to the escalation', async () => {
      const { api } = await setup([escalationOf()]);
      await userEvent.type(answerField('Question q1?'), '  Bump it  ');
      await userEvent.type(answerField('Question q2?'), 'Approved');

      await userEvent.click(submitButton());

      expect(api.answerEscalation).toHaveBeenCalledExactlyOnceWith('e1', { answers: [{ question_id: 'q1', answer: 'Bump it' }, { question_id: 'q2', answer: 'Approved' }] });
    });

    it('does not send twice while the first send is in flight', async () => {
      let finish: () => void = () => undefined;
      const answerEscalation = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      await setup([escalationOf({ questions: [questionOf('q1')] })], { apiPatch: { answerEscalation } });
      await userEvent.type(answerField('Question q1?'), 'Yes');

      await userEvent.click(submitButton());
      await userEvent.click(submitButton());

      expect(answerEscalation).toHaveBeenCalledTimes(1);
      expect(submitButton()).toBeDisabled();
      finish();
    });

    it('removes the card when the daemon announces the escalation resolved', async () => {
      const { resolveEscalationOnDaemon } = await setup([escalationOf()]);

      resolveEscalationOnDaemon(escalationOf());

      await waitFor(() => expect(screen.queryByTestId('escalation-card')).toBeNull());
    });

    it('keeps what is typed when the daemon rebuilds the escalation with one more question', async () => {
      const { raiseEscalationOnDaemon } = await setup([escalationOf()]);
      await userEvent.type(answerField('Question q1?'), 'Bump it');
      await userEvent.type(answerField('Question q2?'), 'Approved');
      expect(submitButton()).toBeEnabled();

      raiseEscalationOnDaemon(escalationOf({ questions: [questionOf('q1'), questionOf('q2'), questionOf('q3', { effectiveClasses: ['security'] })] }));

      expect(await screen.findByRole('textbox', { name: 'Question q3?' })).toBeVisible();
      expect(answerField('Question q1?')).toHaveValue('Bump it');
      expect(answerField('Question q2?')).toHaveValue('Approved');
      expect(submitButton()).toBeDisabled();
    });

    it('keeps the answers typed in one escalation apart from another escalation', async () => {
      const second = escalationOf({ id: 'e2', ticket: 'CCM-2', questions: [questionOf('q1', { text: 'Other question?' })] });
      const { api } = await setup([escalationOf({ questions: [questionOf('q1')] }), second]);

      await userEvent.type(answerField('Question q1?'), 'First');
      await userEvent.type(answerField('Other question?'), 'Second');
      await userEvent.click(screen.getByRole('button', { name: 'Send answers for CCM-2' }));

      expect(api.answerEscalation).toHaveBeenCalledExactlyOnceWith('e2', { answers: [{ question_id: 'q1', answer: 'Second' }] });
      expect(answerField('Question q1?')).toHaveValue('First');
    });
  });

  describe('failing', () => {
    it.each([
      ['already_resolved', 'This was already decided elsewhere'],
      ['escalation_not_found', 'That escalation no longer exists'],
      ['invalid_body', 'The daemon rejected these values'],
    ])('shows the copy of %s and keeps the typed answers', async (code, copy) => {
      const answerEscalation = vi.fn().mockRejectedValue(new ApiError(code === 'invalid_body' ? 400 : 409, code, code));
      await setup([escalationOf({ questions: [questionOf('q1')] })], { apiPatch: { answerEscalation } });
      await userEvent.type(answerField('Question q1?'), 'Yes');

      await userEvent.click(submitButton());

      expect(await screen.findByTestId('escalation-error')).toHaveTextContent(copy);
      expect(answerField('Question q1?')).toHaveValue('Yes');
      expect(submitButton()).toBeEnabled();
    });
  });

  describe('focus', () => {
    it('hands the focus to the answer field of the next card when the answered card leaves', async () => {
      const second = escalationOf({ id: 'e2', ticket: 'CCM-2', questions: [questionOf('q1', { text: 'Other question?' })] });
      const { resolveEscalationOnDaemon } = await setup([escalationOf({ questions: [questionOf('q1')] }), second]);
      await userEvent.type(answerField('Question q1?'), 'Yes');
      await userEvent.click(screen.getByRole('button', { name: 'Send answers for CCM-1' }));

      resolveEscalationOnDaemon(escalationOf({ questions: [questionOf('q1')] }));

      await waitFor(() => expect(answerField('Other question?')).toHaveFocus());
    });

    it('tells its host when no card is left to take the focus', async () => {
      const onNoCardLeft = vi.fn();
      const { resolveEscalationOnDaemon } = await setup([escalationOf({ questions: [questionOf('q1')] })], { onNoCardLeft });
      await userEvent.type(answerField('Question q1?'), 'Yes');
      await userEvent.click(submitButton());

      resolveEscalationOnDaemon(escalationOf({ questions: [questionOf('q1')] }));

      await waitFor(() => expect(onNoCardLeft).toHaveBeenCalledTimes(1));
    });
  });
});
