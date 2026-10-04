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
    { path: 'notes', component: StubComponent },
    { path: 'tables', component: StubComponent },
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
    expect(screen.getByTestId('palette-item-tables')).toHaveTextContent('Tables');
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

  it('user can open Notes from the palette', async () => {
    const { fixture } = await render(CommandPaletteComponent, { bindings: [inputBinding('open', () => true)], providers: [provideRouter(routes())] });
    const router = fixture.debugElement.injector.get(Router);

    await userEvent.click(screen.getByTestId('palette-item-notes'));

    expect(router.url).toBe('/notes');
  });

  it('emits closed even when the navigation rejects, so a dead route never traps the palette open', async () => {
    const { fixture } = await render(CommandPaletteComponent, { bindings: [inputBinding('open', () => true)], providers: [provideRouter(routes())] });
    const router = fixture.debugElement.injector.get(Router);
    vi.spyOn(router, 'navigate').mockRejectedValue(new Error('navigation failed'));
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    await expect(fixture.componentInstance.go('/inbox')).rejects.toThrow('navigation failed');

    expect(closed).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked, without navigating', async () => {
    const { fixture } = await render(CommandPaletteComponent, { bindings: [inputBinding('open', () => true)], providers: [provideRouter(routes())] });
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    await userEvent.click(screen.getByTestId('command-palette'));

    expect(closed).toHaveBeenCalled();
  });

  it('exposes the panel as a named, modal dialog for assistive tech', async () => {
    await render(CommandPaletteComponent, { bindings: [inputBinding('open', () => true)], providers: [provideRouter(routes())] });

    const dialog = screen.getByRole('dialog', { name: /command palette/i });

    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('wraps focus from the last item back to the first on Tab', async () => {
    await render(CommandPaletteComponent, { bindings: [inputBinding('open', () => true)], providers: [provideRouter(routes())] });
    const first = screen.getByTestId('palette-item-sessions');
    const last = screen.getByTestId('palette-item-toggle-theme');
    last.focus();

    await userEvent.tab();

    expect(document.activeElement).toBe(first);
  });

  it('wraps focus from the first item back to the last on Shift+Tab', async () => {
    await render(CommandPaletteComponent, { bindings: [inputBinding('open', () => true)], providers: [provideRouter(routes())] });
    const first = screen.getByTestId('palette-item-sessions');
    const last = screen.getByTestId('palette-item-toggle-theme');
    first.focus();

    await userEvent.tab({ shift: true });

    expect(document.activeElement).toBe(last);
  });
});
