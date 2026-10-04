import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { FleetApiService } from '../core/fleet-api.service';
import { connectFakeDaemon, withoutRealTerminal } from '../testing/session-view.testing';

const openSession = { id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5', harness: 'claude-cli', state: 'idle', stateSince: 't', permissionMode: 'manual', createdAt: 't' } as Session;

async function renderSessionClosedWithExitCode1() {
  const { fixture } = await render(SessionViewComponent, {
    bindings: [inputBinding('sessionId', () => 's1')],
    providers: [{ provide: FleetApiService, useValue: { reopenSession: vi.fn() } }],
    ...withoutRealTerminal,
  });
  const daemon = await connectFakeDaemon(fixture);
  await daemon.send({ type: 'snapshot', sessions: [openSession], approvals: [], managers: [] });
  await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 1, reason: 'harness_exit' });
  await waitFor(() => expect(screen.getByTestId('session-closed-footer')).toBeTruthy());
}

const glyphOf = (title: HTMLElement) => title.querySelector('[aria-hidden="true"]') as Element;

describe('the colours of a closed session title and strip title', () => {
  it('writes the card title in the foreground colour and keeps the state colour on its glyph', async () => {
    await renderSessionClosedWithExitCode1();

    const title = screen.getByTestId('session-closed-title');

    expect(title).toHaveTextContent('Closed · exit 1');
    expect(getComputedStyle(title).color).toBe('var(--fg)');
    expect(getComputedStyle(glyphOf(title)).color).toBe('var(--closed-color)');
  });

  it('writes the strip title in the foreground colour and keeps the state colour on its glyph', async () => {
    await renderSessionClosedWithExitCode1();

    const title = screen.getByTestId('lifecycle-title');

    expect(title).toHaveTextContent('Agent process exited');
    expect(getComputedStyle(title).color).toBe('var(--fg)');
    expect(getComputedStyle(glyphOf(title)).color).toBe('var(--lifecycle-color)');
  });
});
