import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@openfleet/shared';
import { SessionHeaderComponent } from './session-header.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { PendingSwitchesService, type PendingSwitch } from '../core/pending-switches.service';

function aSession(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli · T6', emoji: '⛏️', directory: '/repo/.worktrees/t6', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'idle', stateSince: '2026-09-26T10:00:00.000Z', permissionMode: 'manual',
    createdAt: '2026-09-26T09:00:00.000Z', ...patch,
  } as Session;
}

async function renderHeader(session: Session | ReturnType<typeof signal<Session>>) {
  const currentSession = typeof session === 'function' ? session : signal(session);
  const modelSwitchPendingFor = signal<ReadonlySet<string>>(new Set());
  const pendingSwitches = {
    pendingOf: (sessionId: string, kind: string) => (kind === 'model' && modelSwitchPendingFor().has(sessionId) ? ({} as PendingSwitch) : undefined),
  };
  await render(SessionHeaderComponent, {
    bindings: [inputBinding('session', currentSession)],
    providers: [
      { provide: FleetApiService, useValue: { updateModel: vi.fn(), closeSession: vi.fn(), sendInput: vi.fn(), renameSession: vi.fn() } },
      { provide: FleetEventsService, useValue: { sessions: signal([currentSession()]), approvals: signal([]), managers: signal([]), connected: signal(true) } },
      { provide: PendingSwitchesService, useValue: pendingSwitches },
    ],
  });
  return {
    session: currentSession,
    startPendingModelSwitch: (sessionId = 's1') => modelSwitchPendingFor.set(new Set([sessionId])),
  };
}

const toggle = () => screen.getByRole('button', { name: 'Details' });
const detailsAreOpen = () => toggle().getAttribute('aria-expanded') === 'true';

describe('SessionHeaderComponent collapsible details', () => {
  beforeEach(() => localStorage.clear());

  describe('collapsed by default', () => {
    it('shows the name, the state chip and the Details toggle, and nothing else', async () => {
      await renderHeader(aSession());

      expect(screen.getByTestId('session-name-input')).toBeTruthy();
      expect(screen.getByTestId('state-chip')).toBeTruthy();
      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      for (const hiddenTestId of ['session-harness', 'session-directory', 'session-cost', 'current-model', 'permission-mode', 'session-close']) {
        expect(screen.queryByTestId(hiddenTestId)).toBeNull();
      }
    });

    it('keeps the closed status visible', async () => {
      await renderHeader(aSession({ state: 'closed', exitCode: 1 }));

      expect(screen.getByTestId('session-exit-code')).toHaveTextContent('closed · exit 1');
    });
  });

  describe('Interrupt stays within reach', () => {
    it('shows Interrupt on the collapsed line while the session generates, and leaves Close in the details', async () => {
      await renderHeader(aSession({ state: 'generating' }));

      expect(detailsAreOpen()).toBe(false);
      expect(screen.getByTestId('session-interrupt')).toBeTruthy();
      expect(screen.queryByTestId('session-close')).toBeNull();
    });

    it('shows no Interrupt on the collapsed line when the session is not generating', async () => {
      await renderHeader(aSession({ state: 'idle' }));

      expect(screen.queryByTestId('session-interrupt')).toBeNull();
    });
  });

  describe('toggle', () => {
    it('opens and closes the details with a click, reflecting it in aria-expanded', async () => {
      await renderHeader(aSession());

      await userEvent.click(toggle());
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('session-harness')).toBeTruthy();

      await userEvent.click(toggle());
      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('session-harness')).toBeNull();
    });

    it('is a keyboard-operable button: Enter and Space open and close it', async () => {
      await renderHeader(aSession());
      toggle().focus();

      await userEvent.keyboard('{Enter}');
      expect(detailsAreOpen()).toBe(true);

      await userEvent.keyboard(' ');
      expect(detailsAreOpen()).toBe(false);
    });

    it('reaches the Details toggle by tabbing past the name field', async () => {
      await renderHeader(aSession());

      await userEvent.click(screen.getByTestId('session-name-input'));
      await userEvent.tab();

      expect(toggle()).toHaveFocus();
    });

    it('points aria-controls at the region that holds the details', async () => {
      await renderHeader(aSession());
      await userEvent.click(toggle());

      const controlledRegion = document.getElementById(toggle().getAttribute('aria-controls')!);

      expect(controlledRegion).toContainElement(screen.getByTestId('session-harness'));
    });
  });

  describe('attention auto-opens the details', () => {
    it('opens for the bypassPermissions mode', async () => {
      await renderHeader(aSession({ permissionMode: 'bypassPermissions' }));

      expect(detailsAreOpen()).toBe(true);
      expect(screen.getByTestId('permission-mode')).toBeTruthy();
    });

    it('opens for a model drift and shows the drift chip', async () => {
      await renderHeader(aSession({ modelDriftedFrom: 'claude-opus-4-0' }));

      expect(detailsAreOpen()).toBe(true);
      expect(screen.getByTestId('session-drift-chip')).toBeTruthy();
    });

    it('opens when a model switch is already pending', async () => {
      const { startPendingModelSwitch } = await renderHeader(aSession());
      expect(detailsAreOpen()).toBe(false);

      startPendingModelSwitch();

      await vi.waitFor(() => expect(detailsAreOpen()).toBe(true));
    });

    it('opens when a model drift newly appears on a session the user closed', async () => {
      const { session } = await renderHeader(aSession());
      await userEvent.click(toggle());
      await userEvent.click(toggle());
      expect(detailsAreOpen()).toBe(false);

      session.set(aSession({ modelDriftedFrom: 'claude-opus-4-0' }));

      await vi.waitFor(() => expect(detailsAreOpen()).toBe(true));
    });

    it('stays closed when the user closed it and the condition already held on arrival', async () => {
      localStorage.setItem('openfleet.sessionHeader.open.s1', 'false');

      await renderHeader(aSession({ permissionMode: 'bypassPermissions' }));

      expect(detailsAreOpen()).toBe(false);
    });

    it('stays closed while no condition holds', async () => {
      await renderHeader(aSession({ permissionMode: 'acceptEdits' }));

      expect(detailsAreOpen()).toBe(false);
    });
  });

  describe('remembered choice', () => {
    it('restores an open choice on the next render of the same session', async () => {
      localStorage.setItem('openfleet.sessionHeader.open.s1', 'true');

      await renderHeader(aSession());

      expect(detailsAreOpen()).toBe(true);
    });

    it('remembers the choice the user makes, for a later render', async () => {
      await renderHeader(aSession());
      await userEvent.click(toggle());
      TestBed.resetTestingModule();

      await renderHeader(aSession());

      expect(detailsAreOpen()).toBe(true);
    });

    it('keeps the choice per session: opening one session leaves another collapsed', async () => {
      const { session } = await renderHeader(aSession({ id: 's1' }));
      await userEvent.click(toggle());
      expect(detailsAreOpen()).toBe(true);

      session.set(aSession({ id: 's2' }));
      await vi.waitFor(() => expect(detailsAreOpen()).toBe(false));

      session.set(aSession({ id: 's1' }));
      await vi.waitFor(() => expect(detailsAreOpen()).toBe(true));
    });

    it('still toggles when the storage is unavailable', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
      await renderHeader(aSession());

      await userEvent.click(toggle());

      expect(detailsAreOpen()).toBe(true);
      vi.restoreAllMocks();
    });
  });
});
