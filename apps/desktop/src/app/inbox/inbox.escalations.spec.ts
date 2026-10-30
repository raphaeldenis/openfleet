import { provideRouter } from '@angular/router';
import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { EscalationView, WorkingState } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { sessionOf, stateOf } from '../working-state/working-state-fixtures';
import { connectToScriptedDaemon } from './governance-events-harness';
import { InboxComponent } from './inbox.component';

const manager = sessionOf({ id: 'm1', name: 'Lloyd', role: 'manager', projectId: 'p1' });

const escalationOf = (id: string, patch: Partial<EscalationView> = {}): EscalationView => ({
  id, managerId: 'm1', ticket: `CCM-${id}`, status: 'pending', body: `Escalation ${id}`, createdAt: new Date().toISOString(),
  questions: [{ questionId: 'q1', text: `Question of ${id}?`, declaredClass: 'technical', effectiveClasses: ['contract'], status: 'pending_human' }], ...patch,
});

async function renderInbox(escalations: EscalationView[], workingStates: WorkingState[] = []) {
  const daemon = await connectToScriptedDaemon({ sessions: [manager], escalations, workingStates });
  const api = { decide: vi.fn(), answerEscalation: vi.fn().mockResolvedValue({}) };
  await render(InboxComponent, { providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: daemon.events }] });
  return { ...daemon, api };
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('InboxComponent escalations', () => {
  it('user sees a pending escalation with its question, and the Inbox count rises by one', async () => {
    await renderInbox([escalationOf('1')]);

    expect(screen.getByText('Question of 1?')).toBeVisible();
    expect(screen.getByTestId('inbox-count')).toHaveTextContent('1');
  });

  it('user sees the Escalations chip count the pending escalations and the All chip include them', async () => {
    await renderInbox([escalationOf('1'), escalationOf('2')]);

    expect(screen.getByTestId('inbox-filter-escalations')).toHaveTextContent('Escalations 2');
    expect(screen.getByTestId('inbox-filter-all')).toHaveTextContent('All 2');
  });

  it('user keeps only the escalations by choosing the Escalations chip', async () => {
    await renderInbox([escalationOf('1')], [stateOf({ sessionId: 'm1', questionsForHuman: ['A free question'] })]);

    await userEvent.click(screen.getByTestId('inbox-filter-escalations'));

    expect(screen.getByTestId('escalation-card')).toBeVisible();
    expect(screen.queryByTestId('inbox-attention-card')).toBeNull();
  });

  it('user does not see the empty state while an escalation is shown', async () => {
    await renderInbox([escalationOf('1')]);
    await userEvent.click(screen.getByTestId('inbox-filter-escalations'));

    expect(screen.queryByTestId('inbox-empty')).toBeNull();
  });

  it('user sees the empty state on the Escalations chip when none is pending', async () => {
    await renderInbox([]);
    await userEvent.click(screen.getByTestId('inbox-filter-escalations'));

    expect(screen.getByTestId('inbox-empty')).toBeVisible();
  });

  it('user sees the count and the card go when the daemon resolves the escalation', async () => {
    const { resolveEscalationOnDaemon } = await renderInbox([escalationOf('1')]);

    resolveEscalationOnDaemon(escalationOf('1'));

    await waitFor(() => expect(screen.queryByTestId('escalation-card')).toBeNull());
    expect(screen.queryByTestId('inbox-count')).toBeNull();
  });

  describe('the [esc:<id>] line the daemon leaves in the manager questions', () => {
    const stateWith = (lines: string[]) => stateOf({ sessionId: 'm1', questionsForHuman: lines });

    it('user does not see it twice: the escalation card replaces the question card', async () => {
      await renderInbox([escalationOf('1')], [stateWith(['[esc:1] Escalation 1 on CCM-1'])]);

      expect(screen.queryByText(/\[esc:1\]/)).toBeNull();
      expect(screen.getByTestId('inbox-count')).toHaveTextContent('1');
    });

    it('user still sees a free question the manager asked next to the escalation line', async () => {
      await renderInbox([escalationOf('1')], [stateWith(['[esc:1] Escalation 1 on CCM-1', 'A free question'])]);

      expect(screen.getByText('A free question')).toBeVisible();
      expect(screen.queryByText(/\[esc:1\]/)).toBeNull();
    });

    it('user still sees the line when no escalation card exists for it', async () => {
      await renderInbox([], [stateWith(['[esc:gone] Escalation gone on CCM-9'])]);

      expect(screen.getByText(/\[esc:gone\]/)).toBeVisible();
      expect(screen.getByTestId('inbox-count')).toHaveTextContent('1');
    });

    it('user no longer sees the line, nor a count for it, once the daemon resolves its escalation', async () => {
      const { resolveEscalationOnDaemon } = await renderInbox([escalationOf('1')], [stateWith(['[esc:1] Escalation 1 on CCM-1'])]);

      resolveEscalationOnDaemon(escalationOf('1'));

      await waitFor(() => expect(screen.queryByTestId('escalation-card')).toBeNull());
      expect(screen.queryByText(/\[esc:1\]/)).toBeNull();
      expect(screen.queryByTestId('inbox-attention-card')).toBeNull();
      expect(screen.queryByTestId('inbox-count')).toBeNull();
    });

    it('user does not see the line of an escalation the daemon announces already answered', async () => {
      const { raiseEscalationOnDaemon } = await renderInbox([], [stateWith(['[esc:1] Escalation 1 on CCM-1'])]);

      raiseEscalationOnDaemon(escalationOf('1', { status: 'answered' }));

      await waitFor(() => expect(screen.queryByText(/\[esc:1\]/)).toBeNull());
      expect(screen.queryByTestId('inbox-count')).toBeNull();
    });

    it('user still sees the line of another escalation when one escalation is resolved', async () => {
      const { resolveEscalationOnDaemon } = await renderInbox([escalationOf('1')], [stateWith(['[esc:1] Escalation 1 on CCM-1', '[esc:gone] Escalation gone on CCM-9'])]);

      resolveEscalationOnDaemon(escalationOf('1'));

      await waitFor(() => expect(screen.queryByText(/\[esc:1\]/)).toBeNull());
      expect(screen.getByText(/\[esc:gone\]/)).toBeVisible();
      await waitFor(() => expect(screen.getByTestId('inbox-count')).toHaveTextContent('1'));
    });
  });
});
