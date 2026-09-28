import { render, screen, fireEvent, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@openfleet/shared';
import { SessionHeaderComponent } from './session-header.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

const LONG_NAME = 'Gimli · T6 · make the desktop client reconnect to the daemon with exponential backoff and jitter';

function baseSession(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli · T6', emoji: '⛏️', directory: '/repo/.worktrees/t6', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'idle', stateSince: '2026-09-26T10:00:00.000Z', permissionMode: 'manual',
    createdAt: '2026-09-26T09:00:00.000Z', ...patch,
  } as Session;
}

async function renderHeader(session: ReturnType<typeof signal<Session>>) {
  const api = { updateModel: vi.fn(), updatePermissionMode: vi.fn(), closeSession: vi.fn(), sendInput: vi.fn(), renameSession: vi.fn().mockResolvedValue({}) };
  await render(SessionHeaderComponent, {
    bindings: [inputBinding('session', session)],
    providers: [
      { provide: FleetApiService, useValue: api },
      { provide: FleetEventsService, useValue: { sessions: signal([session()]), approvals: signal([]), managers: signal([]) } },
    ],
  });
  return { api };
}

const nameField = () => screen.getByTestId('session-name-input') as HTMLInputElement;

describe('SessionHeaderComponent long-name ellipsis', () => {
  it('renames with the whole edited long name, not the visible fragment', async () => {
    // Arrange
    const { api } = await renderHeader(signal(baseSession({ name: LONG_NAME })));

    // Act
    await userEvent.click(nameField());
    await userEvent.keyboard('{End} v2');
    fireEvent.change(nameField());

    // Assert
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('s1', { name: `${LONG_NAME} v2` }));
  });

  it('follows the session on a switch: the tooltip is the NEW session\'s full name, never the previous one', async () => {
    // Arrange
    const session = signal(baseSession({ id: 's1', name: LONG_NAME }));
    await renderHeader(session);
    expect(nameField()).toHaveAttribute('title', LONG_NAME);

    // Act
    const nextName = 'Legolas · T9 · a different, equally long session name that also overflows the field';
    session.set(baseSession({ id: 's2', name: nextName }));

    // Assert
    await waitFor(() => expect(nameField()).toHaveAttribute('title', nextName));
    expect(nameField().value).toBe(nextName);
  });

  it('keeps the tooltip in step with a rename landing over the wire', async () => {
    const session = signal(baseSession({ name: LONG_NAME }));
    await renderHeader(session);

    session.set(baseSession({ name: 'Short' }));

    await waitFor(() => expect(nameField()).toHaveAttribute('title', 'Short'));
  });

  it('names the name field "Session name" for assistive tech, not with the session name itself', async () => {
    await renderHeader(signal(baseSession({ name: LONG_NAME })));

    expect(screen.getByRole('textbox', { name: /session name/i })).toBeTruthy();
  });
});
