import type { Project, TriggerFireView } from '@openfleet/shared';
import type { ComponentFixture } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import type { PlaybookVersionContent, PlaybookVersionList, PlaybookView, TriggerView } from '../core/playbook-trigger-views';
import { TriggersViewComponent } from './triggers-view.component';

const PROJECT = { id: 'p1', name: 'Alpha' } as Project;

const playbook = (overrides: Partial<PlaybookView> = {}): PlaybookView => ({
  id: 'pb1', projectId: 'p1', name: 'Déployer', inputs: [], flow: { cells: [{ id: 'build', kind: 'script', program: 'scripts/build.sh', args: [], env: {} }] }, contentRev: 3,
  agentLocked: false, policy: { allowedHosts: [], browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 50 }, approvedDigest: null, approvedAt: null, origin: 'native', updatedAt: '2026-11-05T10:00:00Z',
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

const versionContent = (): PlaybookVersionContent => ({ ...versions().versions[1], inputs: [], flow: { cells: [{ id: 'old-step', kind: 'manual', prompt: 'ok' }] } } as unknown as PlaybookVersionContent);

/** An answer the test settles itself, in the order it wants. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

/** Barrier: a zero-delay macrotask runs after every queued microtask, so each pending answer has been consumed; then Angular renders. */
async function letPendingAnswersLand(fixture: ComponentFixture<unknown>): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await fixture.whenStable();
}

async function renderScreen(overrides: FakeApi = {}) {
  const api = {
    listProjects: vi.fn(() => Promise.resolve({ items: [PROJECT], total: 1, limit: 200, offset: 0 })),
    listPlaybooks: vi.fn(() => Promise.resolve([playbook()])),
    listPlaybookVersions: vi.fn(() => Promise.resolve(versions())),
    getPlaybookVersion: vi.fn(() => Promise.resolve(versionContent())),
    restorePlaybookVersion: vi.fn(() => Promise.resolve(playbook())),
    getPlaybookSecretStatus: vi.fn((_id: string, name: string) => Promise.resolve({ scopeKind: 'playbook', scopeId: 'pb1', name, status: 'missing' })),
    listTriggers: vi.fn(() => Promise.resolve([trigger()])),
    listTriggerFires: vi.fn(() => Promise.resolve([fire()])),
    ...overrides,
  };
  const { fixture } = await render(TriggersViewComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
  return { api, fixture };
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
    const { api } = await renderScreen({ listPlaybooks: vi.fn(() => (++attempts === 1 ? Promise.reject(new ApiError(500, 'boom')) : Promise.resolve([playbook()]))) });
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
    const { api } = await renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));

    await userEvent.click(await screen.findByRole('button', { name: 'Lire la révision 2' }));

    expect(await screen.findByTestId('opened-version')).toHaveTextContent('old-step');
    expect(api.restorePlaybookVersion).not.toHaveBeenCalled();
  });

  it('restores a version against the revision it read', async () => {
    const { api } = await renderScreen();
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
    const lateFirst = deferred<PlaybookVersionList>();
    const listPlaybookVersions = vi.fn((id: string) => (id === 'pb1' ? lateFirst.promise : Promise.resolve(versionsOfSecondPlaybook())));
    const { fixture } = await renderScreen({ listPlaybooks: vi.fn(() => Promise.resolve([playbook(), secondPlaybook()])), listPlaybookVersions });
    await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
    await userEvent.click(screen.getByRole('button', { name: /Livrer/ }));
    await screen.findByRole('button', { name: 'Lire la révision 9' });

    lateFirst.resolve(versions());
    await letPendingAnswersLand(fixture);

    expect(screen.getByRole('heading', { name: 'Livrer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lire la révision 9' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lire la révision 2' })).toBeNull();
  });
});

const secondPlaybook = () => playbook({ id: 'pb2', name: 'Livrer', secrets: [] });
const versionsOfSecondPlaybook = (): PlaybookVersionList => ({ currentContentRev: 9, versions: [{ ...versions().versions[0], rev: 9 }] });
const playbookOfOtherProject = () => playbook({ id: 'pb3', projectId: 'p2', name: 'Publier', secrets: [] });
const OTHER_PROJECT = { id: 'p2', name: 'Beta' } as Project;

async function renderTwoProjects(overrides: FakeApi = {}) {
  const listPlaybooks = vi.fn((projectId: string) => Promise.resolve(projectId === 'p1' ? [playbook(), secondPlaybook()] : [playbookOfOtherProject()]));
  const listProjects = vi.fn(() => Promise.resolve({ items: [PROJECT, OTHER_PROJECT], total: 2, limit: 200, offset: 0 }));
  const listPlaybookVersions = vi.fn((id: string) => Promise.resolve(id === 'pb2' ? versionsOfSecondPlaybook() : versions()));
  return renderScreen({ listProjects, listPlaybooks, listPlaybookVersions, ...overrides });
}

async function openFirstPlaybookAndReadItsOldVersion() {
  await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Lire la révision 2' }));
}

async function chooseSecondPlaybook() {
  await userEvent.click(screen.getByRole('button', { name: /Livrer/ }));
  await screen.findByRole('button', { name: 'Lire la révision 9' });
}

async function chooseOtherProjectAndItsPlaybook() {
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Projet' }), 'p2');
  await userEvent.click(await screen.findByRole('button', { name: /Publier/ }));
  await screen.findByRole('button', { name: 'Lire la révision 2' });
}

describe('TriggersViewComponent: answers that arrive after the user moved on', () => {
  describe('reading a version', () => {
    it('does not open the version of the previous playbook under the one now chosen', async () => {
      const lateVersion = deferred<PlaybookVersionContent>();
      const { fixture } = await renderTwoProjects({ getPlaybookVersion: vi.fn(() => lateVersion.promise) });
      await openFirstPlaybookAndReadItsOldVersion();
      await chooseSecondPlaybook();

      lateVersion.resolve(versionContent());
      await letPendingAnswersLand(fixture);

      expect(screen.queryByTestId('opened-version')).toBeNull();
    });

    it('does not show the read error of the previous playbook under the one now chosen', async () => {
      const lateVersion = deferred<PlaybookVersionContent>();
      const { fixture } = await renderTwoProjects({ getPlaybookVersion: vi.fn(() => lateVersion.promise) });
      await openFirstPlaybookAndReadItsOldVersion();
      await chooseSecondPlaybook();

      lateVersion.reject(new ApiError(500, 'boom'));
      await letPendingAnswersLand(fixture);

      expect(screen.queryByTestId('version-error')).toBeNull();
    });

    it('does not open a version read in another project under a playbook of the new project', async () => {
      const lateVersion = deferred<PlaybookVersionContent>();
      const { fixture } = await renderTwoProjects({ getPlaybookVersion: vi.fn(() => lateVersion.promise) });
      await openFirstPlaybookAndReadItsOldVersion();
      await chooseOtherProjectAndItsPlaybook();

      lateVersion.resolve(versionContent());
      await letPendingAnswersLand(fixture);

      expect(screen.queryByTestId('opened-version')).toBeNull();
    });
  });

  describe('restoring a version', () => {
    async function startRestoringFirstPlaybook(restoreAnswer: ReturnType<typeof deferred<PlaybookView>>) {
      const rendered = await renderTwoProjects({ restorePlaybookVersion: vi.fn(() => restoreAnswer.promise) });
      await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
      await userEvent.click(await screen.findByRole('button', { name: 'Restaurer la révision 2' }));
      return rendered;
    }

    it('keeps the playbook chosen meanwhile when the restoration succeeds late', async () => {
      const restoreAnswer = deferred<PlaybookView>();
      const { api, fixture } = await startRestoringFirstPlaybook(restoreAnswer);
      await chooseSecondPlaybook();

      restoreAnswer.resolve(playbook());
      await letPendingAnswersLand(fixture);

      expect(screen.getByRole('heading', { name: 'Livrer' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Lire la révision 9' })).toBeInTheDocument();
      expect(api.listPlaybooks).toHaveBeenCalledTimes(2);
    });

    describe('the list read again for the playbook restored while another one is chosen', () => {
      const revisionOfFirstPlaybookOnceRestored = 4;

      /** The list answers rev 3 until the restoration is sent, then rev 4; the answer to the list read after it is held by the test. */
      async function startRestoringFirstPlaybookWithListHeldAfterwards(overrides: FakeApi = {}) {
        const restoreAnswer = deferred<PlaybookView>();
        const listAnswerAfterRestore = deferred<PlaybookView[]>();
        let restorationSent = false;
        const listPlaybooks = vi.fn((projectId: string) => {
          if (projectId !== 'p1') return Promise.resolve([playbookOfOtherProject()]);
          const firstPlaybookNow = playbook({ contentRev: restorationSent ? revisionOfFirstPlaybookOnceRestored : 3 });
          return restorationSent ? listAnswerAfterRestore.promise : Promise.resolve([firstPlaybookNow, secondPlaybook()]);
        });
        const restorePlaybookVersion = vi.fn(() => { restorationSent = true; return restoreAnswer.promise; });
        const rendered = await renderTwoProjects({ listPlaybooks, restorePlaybookVersion, ...overrides });
        await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
        await userEvent.click(await screen.findByRole('button', { name: 'Restaurer la révision 2' }));
        await chooseSecondPlaybook();
        return { ...rendered, restoreAnswer, listAnswerAfterRestore };
      }

      const firstPlaybookRestored = () => [playbook({ contentRev: revisionOfFirstPlaybookOnceRestored }), secondPlaybook()];

      it('shows the new revision of the restored playbook in the list and stays on the one chosen meanwhile', async () => {
        const { fixture, restoreAnswer, listAnswerAfterRestore } = await startRestoringFirstPlaybookWithListHeldAfterwards();

        restoreAnswer.resolve(playbook({ contentRev: revisionOfFirstPlaybookOnceRestored }));
        listAnswerAfterRestore.resolve(firstPlaybookRestored());
        await letPendingAnswersLand(fixture);

        expect(screen.getByRole('button', { name: /Déployer/ })).toHaveTextContent('rév. 4');
        expect(screen.getByRole('heading', { name: 'Livrer' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Lire la révision 9' })).toBeInTheDocument();
      });

      it('keeps the detail of the playbook chosen meanwhile on screen while the list is read again', async () => {
        const { fixture, restoreAnswer } = await startRestoringFirstPlaybookWithListHeldAfterwards();

        restoreAnswer.resolve(playbook({ contentRev: revisionOfFirstPlaybookOnceRestored }));
        await letPendingAnswersLand(fixture);

        expect(screen.getByRole('heading', { name: 'Livrer' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Lire la révision 9' })).toBeInTheDocument();
      });

      it('leaves the list of the project chosen meanwhile alone when the list of the previous project arrives late', async () => {
        const { fixture, restoreAnswer, listAnswerAfterRestore } = await startRestoringFirstPlaybookWithListHeldAfterwards();
        restoreAnswer.resolve(playbook({ contentRev: revisionOfFirstPlaybookOnceRestored }));
        await letPendingAnswersLand(fixture);
        await chooseOtherProjectAndItsPlaybook();

        listAnswerAfterRestore.resolve(firstPlaybookRestored());
        await letPendingAnswersLand(fixture);

        expect(screen.getByRole('heading', { name: 'Publier' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Déployer/ })).toBeNull();
      });

      it('keeps the list and says nothing when it cannot be read again', async () => {
        const { fixture, restoreAnswer, listAnswerAfterRestore } = await startRestoringFirstPlaybookWithListHeldAfterwards();

        restoreAnswer.resolve(playbook({ contentRev: revisionOfFirstPlaybookOnceRestored }));
        listAnswerAfterRestore.reject(new ApiError(500, 'boom'));
        await letPendingAnswersLand(fixture);

        expect(screen.queryByTestId('playbooks-error')).toBeNull();
        expect(screen.getByRole('button', { name: /Déployer/ })).toHaveTextContent('rév. 3');
        expect(screen.getByRole('heading', { name: 'Livrer' })).toBeInTheDocument();
      });
    });

    it('does not report a late restoration failure under the playbook chosen meanwhile', async () => {
      const restoreAnswer = deferred<PlaybookView>();
      const { fixture } = await startRestoringFirstPlaybook(restoreAnswer);
      await chooseSecondPlaybook();

      restoreAnswer.reject(new ApiError(409, 'conflict', 'playbook_conflict'));
      await letPendingAnswersLand(fixture);

      expect(screen.queryByTestId('restore-error')).toBeNull();
    });

    it('leaves the project chosen meanwhile alone when the restoration succeeds late', async () => {
      const restoreAnswer = deferred<PlaybookView>();
      const { api, fixture } = await startRestoringFirstPlaybook(restoreAnswer);
      await chooseOtherProjectAndItsPlaybook();

      restoreAnswer.resolve(playbook());
      await letPendingAnswersLand(fixture);

      expect(screen.getByRole('heading', { name: 'Publier' })).toBeInTheDocument();
      expect(api.listPlaybooks).toHaveBeenCalledTimes(2);
    });
  });

  describe('keyboard focus after a restoration', () => {
    it('lands on the heading of the playbook once its restored versions are shown', async () => {
      const restoreAnswer = deferred<PlaybookView>();
      const afterRestore: PlaybookVersionList = { currentContentRev: 4, versions: [{ ...versions().versions[0], rev: 4, source: 'restore' }, ...versions().versions] };
      let restored = false;
      const { fixture } = await renderScreen({
        restorePlaybookVersion: vi.fn(() => { restored = true; return restoreAnswer.promise; }),
        listPlaybookVersions: vi.fn(() => Promise.resolve(restored ? afterRestore : versions())),
      });
      await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
      await userEvent.click(await screen.findByRole('button', { name: 'Restaurer la révision 2' }));

      restoreAnswer.resolve(playbook({ contentRev: 4 }));
      await screen.findByRole('button', { name: 'Lire la révision 4' });
      await fixture.whenStable();

      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Déployer' }));
    });

    it('lands on the announced error when the restoration fails', async () => {
      const { fixture } = await renderScreen({ restorePlaybookVersion: vi.fn(() => Promise.reject(new ApiError(409, 'conflict', 'playbook_conflict'))) });
      await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
      await userEvent.click(await screen.findByRole('button', { name: 'Restaurer la révision 2' }));

      const announcedError = await screen.findByTestId('restore-error');
      await fixture.whenStable();

      expect(document.activeElement).toBe(announcedError);
    });
  });

  describe('reloading after the playbook changed since it was opened', () => {
    const conflict = () => new ApiError(409, 'conflict', 'playbook_conflict');
    const versionsOnceEditedElsewhere = (): PlaybookVersionList => ({ currentContentRev: 4, versions: [{ ...versions().versions[0], rev: 4 }, ...versions().versions] });

    /** The playbook is at rev 3 when opened and at rev 4 once the restoration has been refused. */
    async function failToRestoreBecauseEditedElsewhere() {
      let editedElsewhere = false;
      const rendered = await renderScreen({
        restorePlaybookVersion: vi.fn(() => { editedElsewhere = true; return Promise.reject(conflict()); }),
        listPlaybooks: vi.fn(() => Promise.resolve([playbook({ contentRev: editedElsewhere ? 4 : 3 })])),
        listPlaybookVersions: vi.fn(() => Promise.resolve(editedElsewhere ? versionsOnceEditedElsewhere() : versions())),
      });
      await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
      await userEvent.click(await screen.findByRole('button', { name: 'Restaurer la révision 2' }));
      await screen.findByTestId('restore-error');
      return rendered;
    }

    it('reads the playbook and its versions again on Recharger and shows the current revision', async () => {
      const { api } = await failToRestoreBecauseEditedElsewhere();

      await userEvent.click(screen.getByRole('button', { name: 'Recharger' }));

      expect(await screen.findByRole('button', { name: 'Lire la révision 4' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Déployer/ })).toHaveTextContent('rév. 4');
      expect(screen.getByRole('button', { name: 'Restaurer la révision 3' })).toBeEnabled();
      expect(screen.queryByTestId('restore-error')).toBeNull();
      expect(api.listPlaybookVersions).toHaveBeenCalledTimes(2);
    });

    it('puts the keyboard focus back on the heading of the playbook once reloaded', async () => {
      const { fixture } = await failToRestoreBecauseEditedElsewhere();

      await userEvent.click(screen.getByRole('button', { name: 'Recharger' }));
      await screen.findByRole('button', { name: 'Lire la révision 4' });
      await fixture.whenStable();

      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Déployer' }));
    });

    it('does not offer Recharger for a failure that reloading would not fix', async () => {
      await renderScreen({ restorePlaybookVersion: vi.fn(() => Promise.reject(new ApiError(500, 'boom'))) });
      await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));

      await userEvent.click(await screen.findByRole('button', { name: 'Restaurer la révision 2' }));

      expect(await screen.findByTestId('restore-error')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Recharger' })).toBeNull();
    });

    it('does not bring back the playbook of the previous project when the project changes during the reload', async () => {
      const listAnswerOfReload = deferred<PlaybookView[]>();
      let readsOfFirstProject = 0;
      const listPlaybooks = vi.fn((projectId: string) => {
        if (projectId !== 'p1') return Promise.resolve([playbookOfOtherProject()]);
        readsOfFirstProject += 1;
        return readsOfFirstProject === 1 ? Promise.resolve([playbook(), secondPlaybook()]) : listAnswerOfReload.promise;
      });
      const { api, fixture } = await renderTwoProjects({ listPlaybooks, restorePlaybookVersion: vi.fn(() => Promise.reject(conflict())) });
      await userEvent.click(await screen.findByRole('button', { name: /Déployer/ }));
      await userEvent.click(await screen.findByRole('button', { name: 'Restaurer la révision 2' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Recharger' }));
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Projet' }), 'p2');
      await screen.findByRole('button', { name: /Publier/ });

      listAnswerOfReload.resolve([playbook(), secondPlaybook()]);
      await letPendingAnswersLand(fixture);

      expect(screen.queryByRole('heading', { name: 'Déployer' })).toBeNull();
      expect(api.listPlaybookVersions).toHaveBeenCalledTimes(1);
    });
  });
});

describe('TriggersViewComponent: triggers', () => {
  async function openTriggers(overrides: FakeApi = {}) {
    const rendered = await renderScreen(overrides);
    await userEvent.click(screen.getByRole('tab', { name: 'Triggers' }));
    return rendered;
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
    const { api } = await renderScreen({ listProjects: vi.fn(() => Promise.resolve({ items: [PROJECT, other], total: 2, limit: 200, offset: 0 })) });
    await screen.findByRole('button', { name: /Déployer/ });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Projet' }), 'p2');

    expect(api.listPlaybooks).toHaveBeenLastCalledWith('p2');
  });
});
