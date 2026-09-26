import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Approval } from '@openfleet/shared';
import { PermissionGateCardComponent } from './permission-gate-card.component';
import { FleetApiService } from '../core/fleet-api.service';

function approval(patch: Partial<Approval> = {}): Approval {
  return { id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'git push -u origin t6' }, status: 'pending', createdAt: 't', ...patch };
}

describe('PermissionGateCardComponent', () => {
  it('renders the tool name and its arguments as formatted JSON', async () => {
    await render(PermissionGateCardComponent, {
      bindings: [inputBinding('approval', () => approval())],
      providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }],
    });
    expect(screen.getByTestId('gate-tool-name')).toHaveTextContent('Bash');
    expect(screen.getByTestId('gate-tool-input')).toHaveTextContent('"command": "git push -u origin t6"');
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
