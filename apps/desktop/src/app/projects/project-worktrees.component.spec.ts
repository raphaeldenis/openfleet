import { inputBinding, signal } from '@angular/core';
import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ERROR_CODES, HTTP_STATUS_BY_KIND, WORKTREE_REFUSAL_REASONS, type ErrorCode, type RemovedWorktree, type WorktreeEntry, type WorktreeRefusalReason } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { refusalSentence } from '../core/worktree-refusal';
import { ProjectWorktreesComponent } from './project-worktrees.component';

const FLEET_ID = 'p-fleet';
const ARMADA_ID = 'p-armada';

const worktree = (overrides: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
  repoPath: '/src/fleet', path: '/home/me/.openfleet/worktrees/t1-api', branch: 't1/api', head: 'abc1234', isMain: false, isDetached: false, isLocked: false,
  isPrunable: false, isDirty: false, isInUse: false, isUnderWorktreesRoot: true, removable: true, ...overrides,
});
const mainWorktree = () => worktree({ path: '/src/fleet', branch: 'main', isMain: true, removable: false, notRemovableReason: 'main' });
const refused = (reason: WorktreeRefusalReason, overrides: Partial<WorktreeEntry> = {}) => worktree({ removable: false, notRemovableReason: reason, ...overrides });
const listOf = (items: WorktreeEntry[]) => ({ items, total: items.length });

function refusalError(code: 'constraint_violation' | 'directory_in_use', reason: string): ApiError {
  const kind = ERROR_CODES[code].kind;
  const envelope = { error: code as ErrorCode, kind, retry: 'never' as const, message: 'raw daemon words', detail: { reason } };
  return new ApiError(HTTP_STATUS_BY_KIND[kind], 'DELETE /x', code, envelope);
}

function fakeApi(lists: Record<string, WorktreeEntry[] | Promise<never>> = { [FLEET_ID]: [mainWorktree(), worktree()] }) {
  return {
    listWorktrees: vi.fn((projectId: string) => {
      const list = lists[projectId] ?? [];
      return Array.isArray(list) ? Promise.resolve(listOf(list)) : list;
    }),
    removeWorktree: vi.fn((_projectId: string, path: string): Promise<RemovedWorktree> => Promise.resolve({ removed: path, branch: 't1/api', ignoredFileCount: 4 })),
  };
}

async function renderWorktrees({ api = fakeApi(), sessions = [] as unknown[], projectId = signal(FLEET_ID) } = {}) {
  const { fixture } = await render(ProjectWorktreesComponent, {
    bindings: [inputBinding('projectId', projectId)],
    providers: [
      { provide: FleetApiService, useValue: api },
      { provide: FleetEventsService, useValue: { sessions: signal(sessions) } },
    ],
  });
  return { api, fixture, projectId };
}

const removeButtonOf = (name: string) => screen.getByRole('button', { name: `Remove worktree ${name}` });
const confirmation = () => screen.getByRole('group', { name: /^Confirm removing/ });
const confirmButton = () => within(confirmation()).getByRole('button', { name: 'Remove worktree' });

describe('the worktrees of a project', () => {
  describe('loading', () => {
    it('user sees a loading message until the worktrees arrive', async () => {
      await renderWorktrees({ api: fakeApi({ [FLEET_ID]: new Promise<never>(() => undefined) }) });

      expect(screen.getByRole('status', { name: 'Loading worktrees' })).toBeInTheDocument();
    });

    it('user is told the worktrees could not be listed, in words, and retries', async () => {
      const api = fakeApi();
      api.listWorktrees.mockRejectedValueOnce(new ApiError(500, 'GET /x'));
      await renderWorktrees({ api });

      expect(await screen.findByRole('alert')).toHaveTextContent('The worktrees could not be listed — try again.');
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('t1/api')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('user sees an empty state when the project has no worktree', async () => {
      await renderWorktrees({ api: fakeApi({ [FLEET_ID]: [] }) });

      expect(await screen.findByText(/No worktrees yet/)).toBeInTheDocument();
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });
  });

  describe('the list', () => {
    it('user sees the branch, the full path and the repository of each worktree', async () => {
      await renderWorktrees();

      const repository = await screen.findByRole('list', { name: 'Worktrees of /src/fleet' });
      const featureRow = within(repository).getByText('t1/api').closest('li')!;
      expect(within(featureRow).getByText('/home/me/.openfleet/worktrees/t1-api')).toBeInTheDocument();
      expect(within(repository).getAllByRole('listitem')).toHaveLength(2);
    });

    it('user sees which worktrees are clean and which are modified', async () => {
      const api = fakeApi({ [FLEET_ID]: [worktree({ branch: 'clean-one' }), worktree({ branch: 'dirty-one', path: '/w/dirty', isDirty: true, removable: false, notRemovableReason: 'dirty' })] });
      await renderWorktrees({ api });

      expect(within((await screen.findByText('clean-one')).closest('li')!).getByText('Clean')).toBeInTheDocument();
      expect(within(screen.getByText('dirty-one').closest('li')!).getByText('Modified')).toBeInTheDocument();
    });

    it('user sees which session works in a worktree, and no session otherwise', async () => {
      const api = fakeApi({ [FLEET_ID]: [worktree({ branch: 'busy', path: '/w/busy', isInUse: true, inUseBySessionId: 's-gimli', removable: false, notRemovableReason: 'in_use' }), worktree({ branch: 'idle', path: '/w/idle' })] });
      await renderWorktrees({ api, sessions: [{ id: 's-gimli', name: 'Gimli' }] });

      expect(within((await screen.findByText('busy')).closest('li')!).getByText('In use by Gimli')).toBeInTheDocument();
      expect(within(screen.getByText('idle').closest('li')!).getByText('No session')).toBeInTheDocument();
    });

    it('user sees a detached worktree by its short head', async () => {
      const api = fakeApi({ [FLEET_ID]: [refused('detached', { branch: null, isDetached: true, head: 'abc1234def5678', path: '/w/detached' })] });
      await renderWorktrees({ api });

      expect(await screen.findByText('detached · abc1234')).toBeInTheDocument();
    });

    it('user sees a worktree whose folder is gone as missing', async () => {
      const api = fakeApi({ [FLEET_ID]: [refused('missing', { branch: 'gone', isPrunable: true, path: '/w/gone' })] });
      await renderWorktrees({ api });

      expect(within((await screen.findByText('gone')).closest('li')!).getByText('Missing')).toBeInTheDocument();
    });

    it('shows a branch name made of markup as plain text', async () => {
      const hostile = '<img src=x onerror=alert(1)>';
      await renderWorktrees({ api: fakeApi({ [FLEET_ID]: [worktree({ branch: hostile })] }) });

      expect(await screen.findByText(hostile)).toBeInTheDocument();
      expect(document.querySelector('img')).toBeNull();
    });

    it('lists fifty worktrees and keeps a very long path whole, readable by wrapping', async () => {
      const longPath = `/home/me/.openfleet/worktrees/${'very-long-segment-'.repeat(30)}end`;
      const many = Array.from({ length: 50 }, (_, index) => worktree({ branch: `task/${index}`, path: index === 49 ? longPath : `/w/${index}` }));
      await renderWorktrees({ api: fakeApi({ [FLEET_ID]: many }) });

      expect(await screen.findAllByRole('listitem')).toHaveLength(50);
      expect(screen.getByText(longPath)).toBeInTheDocument();
    });
  });

  describe('a worktree that cannot be removed', () => {
    it.each(WORKTREE_REFUSAL_REASONS)('user reads why in words when the reason is %s', async (reason) => {
      const api = fakeApi({ [FLEET_ID]: [refused(reason, { branch: 'kept' })] });
      await renderWorktrees({ api });

      const row = (await screen.findByText('kept')).closest('li')!;
      expect(within(row).getByText(refusalSentence(reason))).toBeInTheDocument();
      expect(row).not.toHaveTextContent(reason.includes('_') ? reason : `(${reason})`);
    });

    it('offers no action: Remove is unavailable and a click opens nothing and removes nothing', async () => {
      const api = fakeApi({ [FLEET_ID]: [mainWorktree()] });
      await renderWorktrees({ api });

      const button = await screen.findByRole('button', { name: 'Remove worktree main' });
      await userEvent.click(button);

      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAccessibleDescription(refusalSentence('main'));
      expect(screen.queryByRole('group', { name: /^Confirm removing/ })).not.toBeInTheDocument();
      expect(api.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe('removing a worktree', () => {
    it('asks for a confirmation that names the loss of ignored files and keeps the branch', async () => {
      await renderWorktrees();

      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));

      expect(confirmation()).toHaveTextContent(/every file git ignores/);
      expect(confirmation()).toHaveTextContent(/node_modules, \.env/);
      expect(confirmation()).toHaveTextContent(/branch and its commits are kept/);
    });

    it('moves the focus to Cancel when the confirmation opens', async () => {
      await renderWorktrees();

      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));

      await waitFor(() => expect(within(confirmation()).getByRole('button', { name: 'Cancel' })).toHaveFocus());
    });

    it('removes nothing when the user cancels, and the focus returns to Remove', async () => {
      const { api } = await renderWorktrees();
      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));

      await userEvent.click(within(confirmation()).getByRole('button', { name: 'Cancel' }));

      expect(api.removeWorktree).not.toHaveBeenCalled();
      expect(screen.queryByRole('group', { name: /^Confirm removing/ })).not.toBeInTheDocument();
      await waitFor(() => expect(removeButtonOf('t1/api')).toHaveFocus());
    });

    it('cancels with Escape', async () => {
      await renderWorktrees();
      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('group', { name: /^Confirm removing/ })).not.toBeInTheDocument();
    });

    it('removes the worktree by its path once, then it disappears and the user is told what was deleted', async () => {
      const { api } = await renderWorktrees();
      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));

      await userEvent.click(confirmButton());

      expect(api.removeWorktree).toHaveBeenCalledExactlyOnceWith(FLEET_ID, '/home/me/.openfleet/worktrees/t1-api');
      await waitFor(() => expect(screen.queryByText('t1/api', { selector: 'li *' })).not.toBeInTheDocument());
      expect(screen.getByRole('status', { name: 'Removal result' })).toHaveTextContent('Removed t1/api — 4 ignored files deleted. The branch is kept.');
    });

    it('keeps the worktree on screen until the daemon confirms', async () => {
      const api = fakeApi();
      let confirmRemoval: () => void = () => undefined;
      api.removeWorktree.mockImplementation((_projectId, path) => new Promise((resolve) => (confirmRemoval = () => resolve({ removed: path, branch: 't1/api' }))));
      await renderWorktrees({ api });
      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));

      await userEvent.click(confirmButton());

      expect(screen.getByText('t1/api')).toBeInTheDocument();
      expect(confirmButton()).toHaveAttribute('aria-disabled', 'true');
      confirmRemoval();
      await waitFor(() => expect(screen.queryByText('t1/api', { selector: 'li *' })).not.toBeInTheDocument());
    });

    it('sends a single request when the user confirms twice in a row', async () => {
      const api = fakeApi();
      api.removeWorktree.mockImplementation(() => new Promise(() => undefined));
      await renderWorktrees({ api });
      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));

      await userEvent.dblClick(confirmButton());

      expect(api.removeWorktree).toHaveBeenCalledTimes(1);
    });

    it('says the daemon refused, in words and without a code, and keeps the worktree', async () => {
      const api = fakeApi();
      api.removeWorktree.mockRejectedValue(refusalError('constraint_violation', 'dirty'));
      await renderWorktrees({ api });
      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));

      await userEvent.click(confirmButton());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('It has uncommitted, staged or untracked files — commit or discard them first.');
      expect(alert).not.toHaveTextContent(/constraint_violation|raw daemon words|400|409/);
      expect(screen.getByText('t1/api')).toBeInTheDocument();
    });

    it('lists the worktrees again after a refusal so a changed state is visible', async () => {
      const api = fakeApi();
      api.removeWorktree.mockRejectedValue(refusalError('directory_in_use', 'in_use'));
      await renderWorktrees({ api });
      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));
      api.listWorktrees.mockResolvedValue(listOf([mainWorktree(), refused('in_use', { isInUse: true, inUseBySessionId: 's1' })]));

      await userEvent.click(confirmButton());

      await waitFor(() => expect(screen.getByRole('button', { name: 'Remove worktree t1/api' })).toHaveAttribute('aria-disabled', 'true'));
      expect(screen.getByRole('alert')).toHaveTextContent('A session is working in it — close that session first.');
    });

    it('says the connection is down when the daemon cannot be reached, and lets the user retry', async () => {
      const api = fakeApi();
      api.removeWorktree.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await renderWorktrees({ api });
      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));

      await userEvent.click(confirmButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('The worktree was not removed — check your connection, then try again.');
      await userEvent.click(screen.getByRole('button', { name: 'Remove worktree t1/api' }));
      await userEvent.click(confirmButton());
      await waitFor(() => expect(api.removeWorktree).toHaveBeenCalledTimes(2));
    });
  });

  describe('switching project', () => {
    it('shows the worktrees of the new project and none of the previous one', async () => {
      const api = fakeApi({ [FLEET_ID]: [worktree({ branch: 'fleet-branch' })], [ARMADA_ID]: [worktree({ branch: 'armada-branch', path: '/w/armada', repoPath: '/src/armada' })] });
      const { projectId } = await renderWorktrees({ api });
      expect(await screen.findByText('fleet-branch')).toBeInTheDocument();

      projectId.set(ARMADA_ID);

      expect(await screen.findByText('armada-branch')).toBeInTheDocument();
      expect(screen.queryByText('fleet-branch')).not.toBeInTheDocument();
    });

    it('ignores a late answer for the project the user left', async () => {
      let answerFleet: (list: ReturnType<typeof listOf>) => void = () => undefined;
      const api = fakeApi({ [ARMADA_ID]: [worktree({ branch: 'armada-branch', path: '/w/armada' })] });
      api.listWorktrees.mockImplementation((projectId: string) =>
        projectId === FLEET_ID ? new Promise((resolve) => (answerFleet = resolve)) : Promise.resolve(listOf([worktree({ branch: 'armada-branch', path: '/w/armada' })])),
      );
      const { projectId, fixture } = await renderWorktrees({ api });

      projectId.set(ARMADA_ID);
      expect(await screen.findByText('armada-branch')).toBeInTheDocument();
      answerFleet(listOf([worktree({ branch: 'fleet-branch' })]));

      await fixture.whenStable();
      fixture.detectChanges();
      expect(screen.queryByText('fleet-branch')).not.toBeInTheDocument();
      expect(screen.getByText('armada-branch')).toBeInTheDocument();
    });

    it('closes a confirmation opened for the previous project', async () => {
      const api = fakeApi({ [FLEET_ID]: [worktree()], [ARMADA_ID]: [worktree({ branch: 'other', path: '/w/other' })] });
      const { projectId } = await renderWorktrees({ api });
      await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree t1/api' }));

      projectId.set(ARMADA_ID);

      expect(await screen.findByText('other')).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: /^Confirm removing/ })).not.toBeInTheDocument();
    });
  });
});
