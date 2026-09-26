import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NewManagerFormComponent } from './new-manager-form.component';
import { FleetApiService } from '../core/fleet-api.service';

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
});
