import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { provideRouter, Router } from '@angular/router';
import { Component, inputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { CommandPaletteComponent } from './command-palette.component';

@Component({ selector: 'of-stub', template: '' })
class StubComponent {}

function routes() {
  return [
    { path: '', component: StubComponent },
    { path: 'inbox', component: StubComponent },
    { path: 'components', component: StubComponent },
  ];
}

describe('CommandPaletteComponent', () => {
  it('stays out of the DOM while closed', async () => {
    await render(CommandPaletteComponent, { bindings: [inputBinding('open', () => false)], providers: [provideRouter(routes())] });

    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('lists only Pages — Sessions, Inbox, Components — and no fake actions', async () => {
    await render(CommandPaletteComponent, { bindings: [inputBinding('open', () => true)], providers: [provideRouter(routes())] });

    expect(screen.getByTestId('palette-item-sessions')).toHaveTextContent('Sessions');
    expect(screen.getByTestId('palette-item-inbox')).toHaveTextContent('Inbox');
    expect(screen.getByTestId('palette-item-components')).toHaveTextContent('Components');
    expect(screen.queryByText(/Pulse now/i)).toBeNull();
    expect(screen.queryByText(/New session/i)).toBeNull();
  });

  it('navigates to the page and emits closed when a palette item is picked', async () => {
    const { fixture } = await render(CommandPaletteComponent, { bindings: [inputBinding('open', () => true)], providers: [provideRouter(routes())] });
    const router = fixture.debugElement.injector.get(Router);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    await userEvent.click(screen.getByTestId('palette-item-inbox'));

    expect(router.url).toBe('/inbox');
    expect(closed).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked, without navigating', async () => {
    const { fixture } = await render(CommandPaletteComponent, { bindings: [inputBinding('open', () => true)], providers: [provideRouter(routes())] });
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    await userEvent.click(screen.getByTestId('command-palette'));

    expect(closed).toHaveBeenCalled();
  });
});
