import type { Project, TriggerFireView } from '@openfleet/shared';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import type { PlaybookVersionContent, PlaybookVersionList, PlaybookView, TriggerView } from '../core/playbook-trigger-views';
import { TriggersViewComponent } from './triggers-view.component';

const PROJECT = { id: 'p1', name: 'Alpha' } as Project;
const RENDER_FLUSH_MS = 50;

const playbook = (overrides: Partial<PlaybookView> = {}): PlaybookView => ({
  id: 'pb1', projectId: 'p1', name: 'Déployer', inputs: [], flow: { cells: [{ id: 'build', kind: 'script', program: 'scripts/build.sh', args: [], env: {} }] }, contentRev: 3,
  agentLocked: false, policy: { browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 50 }, approvedDigest: null, approvedAt: null, origin: 'native', updatedAt: '2026-11-05T10:00:00Z',
  secrets: ['JIRA_TOKEN'], unreferencedSecrets: [], ...overrides,
});

const versions = (): PlaybookVersionList => ({
  currentContentRev: 3,
  versions: [
    { rev: 3, name: 'Déployer', sha256: 'c', source: 'edit', approvedDigest: null, createdAt: '2026-11-05T10:00:00Z', cellCount: 1 },
    { rev: 2, name: 'Déployer', sha256: 'b', source: 'edit', approvedDigest: null, createdAt: '2026-11-04T10:00:00Z', cellCount: 2 },
  ],
});

const trigger = (overrides: Partial<TriggerView> = {}): TriggerView => ({
  id: 't1', projectId: 'p1', ownerManagerId: null, title: 'Réveiller Capitaine', when: { source: 'session_state', state: 'idle', minutes: 10 }, conditions: [],
  run: { kind: 'notify', title: 'Inactive', message: 'Une session dort.' }, policy: { cooldownSeconds: 0, batchMode: 'per_event', backlogPolicy: 'fire_all' },
  contentRev: 2, armedAt: null, approvedRev: null, approvedGraphDigest: null, updatedAt: '2026-11-05T10:00:00Z', ...overrides,
});

const fire = (overrides: Partial<TriggerFireView> = {}): TriggerFireView => ({
  id: 'f1', triggerId: 't1', ledgerState: 'completed', firedAt: '2026-11-05T11:00:00Z', settledAt: '2026-11-05T11:00:01Z', reason: null, runId: null, chainDepth: 0, ...overrides,
});

type FakeApi = Partial<Record<keyof FleetApiService, ReturnType<typeof vi.fn>>>;

const never = () => new Promise<never>(() => undefined);

async function renderScreen(overrides: FakeApi = {}) {
  const api = {
    listProjects: vi.fn(() => Promise.resolve({ items: [PROJECT], total: 1, limit: 200, offset: 0 })),
    listPlaybooks: vi.fn(() => Promise.resolve([playbook()])),
    listPlaybookVersions: vi.fn(() => Promise.resolve(versions())),
    getPlaybookVersion: vi.fn(() => Promise.resolve({ ...versions().versions[1], inputs: [], flow: { cells: [{ id: 'old-step', kind: 'manual', prompt: 'ok' }] } } as unknown as PlaybookVersionContent)),
    restorePlaybookVersion: vi.fn(() => Promise.resolve(playbook())),
    getPlaybookSecretStatus: vi.fn((_id: string, name: string) => Promise.resolve({ scopeKind: 'playbook', scopeId: 'pb1', name, status: 'missing' })),
    listTriggers: vi.fn(() => Promise.resolve([trigger()])),
    listTriggerFires: vi.fn(() => Promise.resolve([fire()])),
    ...overrides,
  };
  await render(TriggersViewComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
  return api;
}

describe('TriggersViewComponent: playbooks', () => {
  it('shows a loading state until the daemon answers', async () => {
    await renderScreen({ listPlaybooks: vi.fn(never) });

    expect(await screen.findByTestId('playbooks-loading')).toBeInTheDocument();
  });

  it('says there is no playbook when the project has none', async () => {
    await renderScreen({ listPlaybooks: vi.fn(() => Promise.resolve([])) });

    expect(await screen.findByTestId('playbooks-empty')).toHaveTextContent('Aucun playbook');
  });

  it('tells the user the playbooks are unavailable in French and reads again on Réessayer', async () => {
    let attempts = 0;
    const api = await renderScreen({ listPlaybooks: vi.fn(() => (++attempts === 1 ? Promise.reject(new ApiError(500, 'boom')) : Promise.resolve([playbook()]))) });
    expect(await screen.findByTestId('playbooks-error')).toHaveTextContent('Playbooks indisponibles');

    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(await screen.findByRole('button', { name: /Déployer/ })).toBeInTheDocument();
    expect(api.listPlaybooks).toHaveBeenCalledTimes(2);
  });

  it('shows the cells, the secret status and the versions of the chosen playbook', async () => {
    await renderScreen();

    await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));

    expect(await screen.findByTestId('secret-JIRA_TOKEN')).toHaveTextContent('Manquant');
    expect(screen.getByTestId('secret-JIRA_TOKEN')).toHaveTextContent('à saisir dans l’app, pas encore possible ici');
    expect(screen.getByRole('list', { name: 'Cellules du playbook' })).toHaveTextContent('build');
    expect(screen.getByRole('button', { name: 'Restaurer la révision 2' })).toBeInTheDocument();
  });

  it('offers no control to type a secret value', async () => {
    await renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
    await screen.findByTestId('secret-JIRA_TOKEN');

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /saisir/i })).toBeNull();
  });

  it('reads a version without restoring it', async () => {
    const api = await renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));

    await userEvent.click(await screen.findByRole('button', { name: 'Lire la révision 2' }));

    expect(await screen.findByTestId('opened-version')).toHaveTextContent('old-step');
    expect(api.restorePlaybookVersion).not.toHaveBeenCalled();
  });

  it('restores a version against the revision it read', async () => {
    const api = await renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));

    await userEvent.click(await screen.findByRole('button', { name: 'Restaurer la révision 2' }));

    expect(api.restorePlaybookVersion).toHaveBeenCalledWith({ playbookId: 'pb1', rev: 2, expectedRev: 3 });
  });

  it('does not offer to restore the current revision', async () => {
    await renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
    await screen.findByRole('list', { name: 'Versions du playbook' });

    expect(screen.queryByRole('button', { name: 'Restaurer la révision 3' })).toBeNull();
  });

  it('tells the user when the playbook changed since they read it, and keeps the versions', async () => {
    await renderScreen({ restorePlaybookVersion: vi.fn(() => Promise.reject(new ApiError(409, 'conflict', 'playbook_conflict'))) });
    await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));

    await userEvent.click(await screen.findByRole('button', { name: 'Restaurer la révision 2' }));

    expect(await screen.findByTestId('restore-error')).toHaveTextContent('This playbook changed since you opened it');
    expect(screen.getByRole('button', { name: 'Restaurer la révision 2' })).toBeEnabled();
  });

  it('shows the detail of the last playbook chosen when an earlier answer arrives late', async () => {
    let answerFirst: (value: PlaybookVersionList) => void = () => undefined;
    const lateFirst = new Promise<PlaybookVersionList>((resolve) => { answerFirst = resolve; });
    const secondVersions = { currentContentRev: 9, versions: [{ ...versions().versions[0], rev: 9 }] };
    const listPlaybookVersions = vi.fn((id: string) => (id === 'pb1' ? lateFirst : Promise.resolve(secondVersions)));
    await renderScreen({ listPlaybooks: vi.fn(() => Promise.resolve([playbook(), playbook({ id: 'pb2', name: 'Livrer', secrets: [] })])), listPlaybookVersions });
    await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
    await userEvent.click(screen.getByRole('button', { name: /Livrer/ }));
    await screen.findByRole('button', { name: 'Lire la révision 9' });

    answerFirst(versions());
    await new Promise((resolve) => setTimeout(resolve, RENDER_FLUSH_MS));

    expect(screen.getByRole('heading', { name: 'Livrer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lire la révision 9' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lire la révision 2' })).toBeNull();
  });
});

describe('TriggersViewComponent: triggers', () => {
  async function openTriggers(overrides: FakeApi = {}) {
    const api = await renderScreen(overrides);
    await userEvent.click(screen.getByRole('tab', { name: 'Triggers' }));
    return api;
  }

  it('shows a loading state, then says there is no trigger', async () => {
    await openTriggers({ listTriggers: vi.fn(() => Promise.resolve([])) });

    expect(await screen.findByTestId('triggers-empty')).toHaveTextContent('Aucun trigger');
  });

  it('tells the user the triggers are unavailable', async () => {
    await openTriggers({ listTriggers: vi.fn(() => Promise.reject(new ApiError(500, 'boom'))) });

    expect(await screen.findByTestId('triggers-error')).toHaveTextContent('Triggers indisponibles');
  });

  it('reads the rule of a disarmed trigger and says it is disarmed', async () => {
    await openTriggers();

    await userEvent.click(await screen.findByRole('button', { name: /Réveiller Capitaine/ }));

    expect(screen.getByTestId('trigger-arming')).toHaveTextContent('Désarmé');
    expect(screen.getByTestId('trigger-detail')).toHaveTextContent('Une session enfant est inactive depuis 10 min');
  });

  it('shows the approved digest of an armed trigger', async () => {
    await openTriggers({ listTriggers: vi.fn(() => Promise.resolve([trigger({ armedAt: '2026-11-05T12:00:00Z', approvedRev: 2, approvedGraphDigest: 'abc123' })])) });

    await userEvent.click(await screen.findByRole('button', { name: /Réveiller Capitaine/ }));

    expect(screen.getByTestId('trigger-arming')).toHaveTextContent('digest approuvé abc123');
  });

  it('lists the fires with their state and why one ended', async () => {
    await openTriggers({ listTriggerFires: vi.fn(() => Promise.resolve([fire(), fire({ id: 'f2', ledgerState: 'cancelled', reason: 'cooldown' })])) });

    await userEvent.click(await screen.findByRole('button', { name: /Réveiller Capitaine/ }));

    expect(await screen.findByTestId('fire-f2')).toHaveTextContent('Annulé');
    expect(screen.getByTestId('fire-f2')).toHaveTextContent('délai de repos');
    expect(screen.getByTestId('fire-f1')).toHaveTextContent('Terminé');
  });

  it('says the trigger has not fired yet', async () => {
    await openTriggers({ listTriggerFires: vi.fn(() => Promise.resolve([])) });

    await userEvent.click(await screen.findByRole('button', { name: /Réveiller Capitaine/ }));

    expect(await screen.findByTestId('fires-empty')).toHaveTextContent('pas encore tiré');
  });

  it('tells the user the fire history is unavailable and keeps the rule', async () => {
    await openTriggers({ listTriggerFires: vi.fn(() => Promise.reject(new ApiError(500, 'boom'))) });

    await userEvent.click(await screen.findByRole('button', { name: /Réveiller Capitaine/ }));

    expect(await screen.findByTestId('fires-error')).toHaveTextContent('Historique indisponible');
    expect(screen.getByTestId('trigger-detail')).toHaveTextContent('Une session enfant est inactive');
  });

  it('offers no arm, edit or run control in this version', async () => {
    await openTriggers();
    await userEvent.click(await screen.findByRole('button', { name: /Réveiller Capitaine/ }));
    await screen.findByTestId('fire-f1');

    expect(screen.queryByRole('button', { name: /armer|modifier|lancer|exécuter/i })).toBeNull();
  });
});

describe('TriggersViewComponent: screen', () => {
  it('says there is no project when the daemon lists none', async () => {
    await renderScreen({ listProjects: vi.fn(() => Promise.resolve({ items: [], total: 0, limit: 200, offset: 0 })) });

    expect(await screen.findByTestId('triggers-no-project')).toHaveTextContent('Aucun projet');
  });

  it('tells the user the projects are unavailable', async () => {
    await renderScreen({ listProjects: vi.fn(() => Promise.reject(new ApiError(500, 'boom'))) });

    expect(await screen.findByTestId('triggers-projects-error')).toHaveTextContent('Projets indisponibles');
  });

  it('moves between the tabs with the arrow keys', async () => {
    await renderScreen();
    await screen.findByRole('button', { name: /Déployer/ });
    screen.getByRole('tab', { name: 'Playbooks' }).focus();

    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Triggers' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Triggers' })).toHaveAttribute('aria-selected', 'true');
  });

  it('reads the playbooks of another project when the user changes the project', async () => {
    const other = { id: 'p2', name: 'Beta' } as Project;
    const api = await renderScreen({ listProjects: vi.fn(() => Promise.resolve({ items: [PROJECT, other], total: 2, limit: 200, offset: 0 })) });
    await screen.findByRole('button', { name: /Déployer/ });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Projet' }), 'p2');

    expect(api.listPlaybooks).toHaveBeenLastCalledWith('p2');
  });
});
