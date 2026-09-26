import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NewManagerFormComponent } from './new-manager-form.component';
import { FleetApiService, ApiError } from '../core/fleet-api.service';

async function fillMinimalValidForm(): Promise<void> {
  await userEvent.type(screen.getByTestId('manager-directory'), '/tmp/wt');
  await userEvent.type(screen.getByTestId('manager-name'), 'Lead');
  await userEvent.type(screen.getByTestId('manager-mission'), 'Ship phase 2');
}

describe('NewManagerFormComponent', () => {
  it('submits the typed fields to createManagerSession', async () => {
    const api = { createManagerSession: vi.fn().mockResolvedValue({}) };
    await render(NewManagerFormComponent, { providers: [{ provide: FleetApiService, useValue: api }] });

    await userEvent.type(screen.getByTestId('manager-directory'), '/tmp/wt');
    await userEvent.type(screen.getByTestId('manager-name'), 'Lead');
    await userEvent.clear(screen.getByTestId('manager-pulse-seconds'));
    await userEvent.type(screen.getByTestId('manager-pulse-seconds'), '1800');
    await userEvent.clear(screen.getByTestId('manager-children-cap'));
    await userEvent.type(screen.getByTestId('manager-children-cap'), '2');
    await userEvent.type(screen.getByTestId('manager-mission'), 'Ship phase 2');
    await userEvent.click(screen.getByTestId('create-manager'));

    expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/wt', name: 'Lead', pulseSeconds: 1800, childrenCap: 2, mission: 'Ship phase 2',
    }));
  });

  it.each([
    ['0, below the 1..86400 minimum', '0'],
    ['86401, above the 1..86400 maximum', '86401'],
  ])('rejects a pulse-seconds value of %s instead of sending it to the backend', async (_label, value) => {
    const api = { createManagerSession: vi.fn().mockResolvedValue({}) };
    await render(NewManagerFormComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
    await fillMinimalValidForm();

    await userEvent.clear(screen.getByTestId('manager-pulse-seconds'));
    await userEvent.type(screen.getByTestId('manager-pulse-seconds'), value);
    await userEvent.click(screen.getByTestId('create-manager'));

    expect(api.createManagerSession).not.toHaveBeenCalled();
  });

  it.each([
    ['0, below the 1..64 minimum', '0'],
    ['65, above the 1..64 maximum', '65'],
  ])('rejects a children-cap value of %s instead of sending it to the backend', async (_label, value) => {
    const api = { createManagerSession: vi.fn().mockResolvedValue({}) };
    await render(NewManagerFormComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
    await fillMinimalValidForm();

    await userEvent.clear(screen.getByTestId('manager-children-cap'));
    await userEvent.type(screen.getByTestId('manager-children-cap'), value);
    await userEvent.click(screen.getByTestId('create-manager'));

    expect(api.createManagerSession).not.toHaveBeenCalled();
  });

  it('shows the server\'s validation message instead of failing silently when the backend rejects the spec with 400', async () => {
    const api = { createManagerSession: vi.fn().mockRejectedValue(new ApiError(400, 'mission must be at most 65536 bytes')) };
    await render(NewManagerFormComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
    await fillMinimalValidForm();

    await userEvent.click(screen.getByTestId('create-manager'));

    expect(screen.getByTestId('manager-form-error')).toHaveTextContent('mission must be at most 65536 bytes');
  });

  it('disables the submit button while a create request is pending, so a double click cannot post twice', async () => {
    let resolveCreate!: () => void;
    const api = { createManagerSession: vi.fn(() => new Promise<void>((resolve) => { resolveCreate = resolve; })) };
    await render(NewManagerFormComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
    await fillMinimalValidForm();

    await userEvent.click(screen.getByTestId('create-manager'));
    expect(screen.getByTestId('create-manager')).toBeDisabled();
    await userEvent.click(screen.getByTestId('create-manager'));

    expect(api.createManagerSession).toHaveBeenCalledTimes(1);
    resolveCreate();
  });

  it('gives the emoji field and model select an accessible name for screen reader users', async () => {
    await render(NewManagerFormComponent, { providers: [{ provide: FleetApiService, useValue: { createManagerSession: vi.fn() } }] });

    expect(screen.getByRole('textbox', { name: /emoji/i })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /model/i })).toBeTruthy();
  });
});
