import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import type { Session } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { connectFakeDaemon, withoutRealTerminal } from '../testing/session-view.testing';

const openSession = { id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5', harness: 'claude-cli', state: 'idle', stateSince: 't', permissionMode: 'manual', createdAt: 't' } as Session;

async function renderOpenSessionView() {
  const { fixture } = await render(SessionViewComponent, {
    bindings: [inputBinding('sessionId', () => 's1')],
    ...withoutRealTerminal,
  });
  const daemon = await connectFakeDaemon(fixture);
  await daemon.send({ type: 'snapshot', sessions: [openSession], approvals: [], managers: [] });
  await waitFor(() => expect(screen.getByTestId('session-view')).toBeTruthy());
  return fixture.nativeElement as HTMLElement;
}

describe('the session view layout inside the shell outlet (a flex row)', () => {
  it('fills the outlet row instead of shrinking to its content', async () => {
    const host = await renderOpenSessionView();

    const hostStyle = getComputedStyle(host);

    expect(hostStyle.display).toBe('flex');
    expect(hostStyle.flex).toBe('1 1 0%');
    expect(hostStyle.minWidth).toBe('0px');
    expect(hostStyle.minHeight).toBe('0px');
  });
});
