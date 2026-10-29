import { Component } from '@angular/core';
import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { SessionActionsComponent } from './session-actions.component';

const panelCollapsed = vi.fn();

/** Stands in for the right panel, which collapses itself on any Escape that reaches it. */
@Component({
  selector: 'of-escape-listening-panel-host',
  imports: [SessionActionsComponent],
  template: `
    <aside data-testid="panel" (keydown.escape)="panelCollapsed()">
      <of-session-actions sessionId="s1" state="idle" stateSince="t1" sessionName="Gimli" />
    </aside>
  `,
})
class EscapeListeningPanelHostComponent {
  protected readonly panelCollapsed = panelCollapsed;
}

async function renderInsidePanel(): Promise<void> {
  panelCollapsed.mockClear();
  await render(EscapeListeningPanelHostComponent, { providers: [{ provide: FleetApiService, useValue: { closeSession: vi.fn(), sendInput: vi.fn() } }] });
}

describe('Escape in the close confirmation dialog, hosted by a panel that closes on Escape', () => {
  it('closes only the dialog and leaves the panel alone', async () => {
    await renderInsidePanel();
    await userEvent.click(screen.getByTestId('session-close'));

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByTestId('close-confirm-dialog')).toBeNull();
    expect(panelCollapsed).not.toHaveBeenCalled();
  });

  it('returns the focus to the button that opened the dialog', async () => {
    await renderInsidePanel();
    await userEvent.click(screen.getByTestId('session-close'));

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.getByTestId('session-close')).toHaveFocus());
  });

  it('lets the panel see an Escape pressed outside the dialog', async () => {
    await renderInsidePanel();
    screen.getByTestId('session-close').focus();

    await userEvent.keyboard('{Escape}');

    expect(panelCollapsed).toHaveBeenCalledTimes(1);
  });
});
