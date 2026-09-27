import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { DaemonStatusComponent } from './daemon-status.component';

describe('DaemonStatusComponent', () => {
  it('shows "Connected" with the daemon address in the tooltip when connected', async () => {
    await render(DaemonStatusComponent, { bindings: [inputBinding('connected', () => true)] });

    const status = screen.getByTestId('daemon-status');
    expect(status).toHaveTextContent('Connected');
    expect(status).toHaveAttribute('title', 'Connected to the daemon on 127.0.0.1:7331');
  });

  it('shows "Reconnecting" when the daemon connection drops, per FleetEventsService.connected', async () => {
    await render(DaemonStatusComponent, { bindings: [inputBinding('connected', () => false)] });

    const status = screen.getByTestId('daemon-status');
    expect(status).toHaveTextContent('Reconnecting');
    expect(status).toHaveAttribute('title', 'Reconnecting to the daemon on 127.0.0.1:7331');
  });

  it('derives the tooltip address from the same source as the socket (environment.apiUrl), not a hardcoded constant', async () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:9999');

    await render(DaemonStatusComponent, { bindings: [inputBinding('connected', () => true)] });

    expect(screen.getByTestId('daemon-status')).toHaveAttribute('title', 'Connected to the daemon on 127.0.0.1:9999');
    localStorage.removeItem('openfleet.apiUrl');
  });
});
