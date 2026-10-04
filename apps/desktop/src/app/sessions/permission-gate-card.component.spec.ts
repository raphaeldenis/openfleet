import { render, screen, waitFor, fireEvent } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Approval } from '@openfleet/shared';
import { PermissionGateCardComponent } from './permission-gate-card.component';
import { FleetApiService } from '../core/fleet-api.service';

function approval(patch: Partial<Approval> = {}): Approval {
  return { id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'git push -u origin t6' }, status: 'pending', createdAt: 't', ...patch };
}

describe('PermissionGateCardComponent', () => {
  it('does not shrink when the terminal beside it does, so it stays fully visible above the composer', async () => {
    // Structure/CSS-only: the real layout regression (card pushed below the viewport) is only visible in a browser.
    const { fixture } = await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', () => approval())],
      providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }],
    });
    expect(fixture.nativeElement).toHaveStyle({ flex: 'none' });
  });

  it('renders the tool name and its arguments as formatted JSON', async () => {
    await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', () => approval())],
      providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }],
    });
    expect(screen.getByTestId('gate-tool-name')).toHaveTextContent('Bash');
    expect(screen.getByTestId('gate-tool-input')).toHaveTextContent('"command": "git push -u origin t6"');
  });

  it('writes the warning in the foreground colour behind an amber glyph', async () => {
    await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', () => approval())],
      providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }],
    });

    const warning = screen.getByTestId('gate-warning');
    const glyph = warning.querySelector('[aria-hidden="true"]') as Element;

    expect(warning).toHaveTextContent('Permission needed');
    expect(getComputedStyle(warning).color).toBe('var(--fg)');
    expect(getComputedStyle(glyph).color).toBe('var(--state-waiting-permission)');
  });

  it('approves by calling decide(id, "allow")', async () => {
    const api = { decide: vi.fn().mockResolvedValue({}) };
    await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', () => approval())],
      providers: [{ provide: FleetApiService, useValue: api }],
    });
    await userEvent.click(screen.getByTestId('gate-approve'));
    expect(api.decide).toHaveBeenCalledWith('a1', 'allow');
  });

  it('denies by calling decide(id, "deny")', async () => {
    const api = { decide: vi.fn().mockResolvedValue({}) };
    await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', () => approval())],
      providers: [{ provide: FleetApiService, useValue: api }],
    });
    await userEvent.click(screen.getByTestId('gate-deny'));
    expect(api.decide).toHaveBeenCalledWith('a1', 'deny');
  });

  it('renders deeply nested arguments without crashing', async () => {
    // Arrange
    const nested = approval({ toolInput: { edits: [{ path: 'a.ts', diff: { old: 'x', new: 'y', meta: { lines: [1, 2, 3] } } }] } });
    // Act
    await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', () => nested)],
      providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }],
    });
    // Assert
    expect(screen.getByTestId('gate-tool-input')).toHaveTextContent('"lines"');
  });

  it('renders a non-object (raw string) tool argument without crashing', async () => {
    // Arrange
    const rawString = approval({ toolInput: 'raw non-JSON command text' as never });
    // Act
    await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', () => rawString)],
      providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }],
    });
    // Assert
    expect(screen.getByTestId('gate-tool-input')).toHaveTextContent('raw non-JSON command text');
  });

  it('sends only one decide call when Approve is double-clicked before the request resolves', async () => {
    // Arrange
    let resolveDecide: (value: unknown) => void = () => {};
    const api = { decide: vi.fn(() => new Promise((resolve) => { resolveDecide = resolve; })) };
    await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', () => approval())],
      providers: [{ provide: FleetApiService, useValue: api }],
    });
    const approveButton = screen.getByTestId('gate-approve') as HTMLButtonElement;

    // Act
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);
    resolveDecide({});
    await waitFor(() => expect(api.decide).toHaveBeenCalled());

    // Assert
    expect(api.decide).toHaveBeenCalledTimes(1);
  });

  it('resets a stale pending/error state when the shown approval changes, instead of leaking it onto the new one', async () => {
    // Arrange — session is still waiting_permission, so the gate card's approval input switches
    // straight from one pending approval to the next without the component ever being destroyed.
    const approvalInput = signal<Approval>(approval({ id: 'a1' }));
    let resolveDecide: (value: unknown) => void = () => {};
    const api = { decide: vi.fn(() => new Promise((resolve) => { resolveDecide = resolve; })) };
    await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', approvalInput)],
      providers: [{ provide: FleetApiService, useValue: api }],
    });
    const approveButton = screen.getByTestId('gate-approve') as HTMLButtonElement;

    // Act — approve a1, then move on to a2 before a1's request ever resolves
    await userEvent.click(approveButton);
    approvalInput.set(approval({ id: 'a2', toolName: 'Read' }));

    // Assert — a2 starts clean: it can be decided even though a1's request is still in flight
    await userEvent.click(approveButton);
    expect(api.decide).toHaveBeenNthCalledWith(2, 'a2', 'allow');

    // Act — a1's stale request now resolves
    resolveDecide({});
    await waitFor(() => expect(api.decide).toHaveBeenCalledTimes(2));

    // Assert — a2's card shows no error left over from a1's settled request
    expect(screen.queryByTestId('gate-decision-error')).toBeNull();
  });

  it('disables "Always allow for this session" with a tooltip explaining it is a later-phase feature', async () => {
    await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', () => approval())],
      providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }],
    });
    const always = screen.getByTestId('gate-always-allow') as HTMLButtonElement;
    expect(always.disabled).toBe(true);
    expect(always.title).toMatch(/later phase/i);
  });
});
