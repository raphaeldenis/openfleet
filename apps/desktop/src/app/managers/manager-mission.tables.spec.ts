import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular/zoneless';
import type { ManagerProfile } from '@openfleet/shared';
import { of } from 'rxjs';
import { describe, vi } from 'vitest';
import { itRendersImportedMarkdownTables } from '../../testing/markdown-tables.testing';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { ManagerDashboardComponent } from './manager-dashboard.component';

const MANAGER_SESSION = {
  id: 'm1', name: 'Capitaine', emoji: '🧭', role: 'manager', state: 'closed', harness: 'claude-cli', model: 'sonnet', projectId: 'p-fleet', stateSince: new Date().toISOString(),
};

const profileWithMission = (missionText: string): ManagerProfile => ({
  manager: { sessionId: 'm1', pulseSeconds: 600, childrenCap: 4, missionText, nextPulseAt: new Date(Date.now() + 60_000).toISOString(), childrenCount: 0 },
  scapeImport: 'not_imported',
});

async function renderMissionPanelShowing(missionText: string): Promise<void> {
  const api = {
    getManagerProfile: vi.fn().mockResolvedValue(profileWithMission(missionText)),
    listProjects: vi.fn().mockResolvedValue({ items: [{ id: 'p-fleet', name: 'Fleet', docsFolderPath: null }], total: 1, limit: 200, offset: 0 }),
    models: vi.fn().mockResolvedValue({}),
  };
  const events = {
    sessions: signal([MANAGER_SESSION]), approvals: signal([]), managers: signal([profileWithMission(missionText).manager]), snapshotReceived: signal(true),
    workingStates: signal(new Map()), workingStatesReported: signal(false), workingStateMaxAgeMinutes: signal<number | undefined>(30), workingStateMaxBytes: signal<number | undefined>(6144),
  };
  await render(ManagerDashboardComponent, {
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'm1' })) } },
      { provide: FleetEventsService, useValue: events },
      { provide: FleetApiService, useValue: api },
    ],
  });
  await screen.findByRole('region', { name: 'Profile' });
}

describe('the manager mission panel', () => {
  itRendersImportedMarkdownTables(renderMissionPanelShowing);
});
