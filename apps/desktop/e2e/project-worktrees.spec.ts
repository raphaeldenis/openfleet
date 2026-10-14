import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminHeaders, api, signInAsAdmin } from './support/daemon';

const uniqueName = (prefix: string) => `${prefix} ${randomUUID().slice(0, 8)}`;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd, encoding: 'utf8' });

interface Fixture {
  projectId: string;
  projectName: string;
  repo: string;
  startSession: (name: string) => Promise<{ id: string; branch: string; directory: string }>;
  closeSession: (id: string) => Promise<void>;
}

/** A project whose sessions work in worktrees of one real git repository. */
async function withProjectWorktrees(request: APIRequestContext, use: (fixture: Fixture) => Promise<void>): Promise<void> {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'of-e2e-wt-repo-')));
  git(repo, 'init', '--initial-branch=main');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  const projectName = uniqueName('Worktree project');
  const project = await (await request.post(`${api}/api/projects`, { headers: adminHeaders, data: { name: projectName } })).json();
  const sessionIds: string[] = [];
  const worktreePaths: string[] = [];
  try {
    await use({
      projectId: project.id, projectName, repo,
      startSession: async (name) => {
        const branch = `e2e/${randomUUID().slice(0, 8)}`;
        const created = await request.post(`${api}/api/sessions`, { headers: adminHeaders, data: { directory: repo, repoPath: repo, branchName: branch, name, emoji: '🧪', harness: 'fake', projectId: project.id } });
        expect(created.ok()).toBe(true);
        const session = await created.json();
        sessionIds.push(session.id);
        worktreePaths.push(session.directory);
        return { id: session.id, branch, directory: session.directory };
      },
      closeSession: async (id) => { await request.post(`${api}/api/sessions/${id}/close`, { headers: adminHeaders }); },
    });
  } finally {
    for (const id of sessionIds) await request.post(`${api}/api/sessions/${id}/close`, { headers: adminHeaders });
    for (const path of worktreePaths) rmSync(path, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

const worktreesCard = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Repositories & worktrees' });
const rowOf = (page: import('@playwright/test').Page, branch: string) => worktreesCard(page).getByRole('listitem').filter({ hasText: branch });

test('Project home lists the worktrees with the reason each one stays, and offers no removal where git or the daemon refuses', async ({ page, request }) => {
  await withProjectWorktrees(request, async ({ projectId, repo, startSession }) => {
    const sessionName = uniqueName('Worker');
    const { branch } = await startSession(sessionName);
    await signInAsAdmin(page);

    await page.goto(`/project/${projectId}`);

    const mainRow = rowOf(page, 'main');
    await expect(mainRow).toContainText(repo);
    await expect(mainRow).toContainText('This is the main worktree of the repository and cannot be removed.');
    await expect(page.getByRole('button', { name: 'Remove worktree main' })).toHaveAttribute('aria-disabled', 'true');
    const busyRow = rowOf(page, branch);
    await expect(busyRow).toContainText(`In use by ${sessionName}`);
    await expect(busyRow).toContainText('A session is working in it — close that session first.');
    await page.getByRole('button', { name: `Remove worktree ${branch}` }).click({ force: true });
    await expect(page.getByRole('group', { name: /^Confirm removing/ })).toHaveCount(0);
  });
});

test('removing a clean worktree asks for a confirmation that names the loss of ignored files, then the folder and the entry go and the branch stays', async ({ page, request }) => {
  await withProjectWorktrees(request, async ({ projectId, repo, startSession, closeSession }) => {
    const { id, branch, directory } = await startSession(uniqueName('Worker'));
    await closeSession(id);
    await signInAsAdmin(page);
    await page.goto(`/project/${projectId}`);

    await page.getByRole('button', { name: `Remove worktree ${branch}` }).click();

    const confirmation = page.getByRole('group', { name: `Confirm removing ${branch}` });
    await expect(confirmation).toContainText('every file git ignores');
    await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    expect(existsSync(directory)).toBe(true);

    await page.getByRole('button', { name: `Remove worktree ${branch}` }).click();
    await page.getByRole('group', { name: `Confirm removing ${branch}` }).getByRole('button', { name: 'Remove worktree' }).click();

    await expect(page.getByRole('status', { name: 'Removal result' })).toContainText(`Removed ${branch}`);
    await expect(rowOf(page, branch)).toHaveCount(0);
    expect(existsSync(directory)).toBe(false);
    expect(git(repo, 'branch', '--list', branch)).toContain(branch);
  });
});

test('a removal the daemon refuses shows the reason in words and leaves the worktree in place', async ({ page, request }) => {
  await withProjectWorktrees(request, async ({ projectId, startSession, closeSession }) => {
    const { id, branch, directory } = await startSession(uniqueName('Worker'));
    await closeSession(id);
    await signInAsAdmin(page);
    await page.goto(`/project/${projectId}`);
    await page.getByRole('button', { name: `Remove worktree ${branch}` }).click();
    writeFileSync(join(directory, 'unsaved.txt'), 'work in progress\n');

    await page.getByRole('group', { name: `Confirm removing ${branch}` }).getByRole('button', { name: 'Remove worktree' }).click();

    await expect(page.getByRole('alert')).toContainText('It has uncommitted, staged or untracked files — commit or discard them first.');
    await expect(page.getByRole('alert')).not.toContainText(/constraint_violation|409|400/);
    expect(existsSync(join(directory, 'unsaved.txt'))).toBe(true);
    await expect(page.getByRole('button', { name: `Remove worktree ${branch}` })).toHaveAttribute('aria-disabled', 'true');
    await expect(rowOf(page, branch)).toContainText('Modified');
  });
});

test('the post-create hook is set, refused when it cannot run, and removed from the project settings card', async ({ page, request }) => {
  await withProjectWorktrees(request, async ({ projectId }) => {
    const scriptDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'of-e2e-hook-')));
    const goodScript = join(scriptDirectory, 'setup.sh');
    const notExecutable = join(scriptDirectory, 'plain.sh');
    writeFileSync(goodScript, '#!/bin/sh\nexit 0\n');
    chmodSync(goodScript, 0o700);
    writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n');
    chmodSync(notExecutable, 0o600);
    try {
      await signInAsAdmin(page);
      await page.goto(`/project/${projectId}`);
      const hook = page.getByRole('region', { name: 'Post-create hook' });
      await expect(hook).toContainText('No hook');
      await expect(hook).toContainText("runs on this computer as the daemon's user");

      await hook.getByRole('button', { name: 'Set a hook…' }).click();
      await hook.getByRole('textbox', { name: 'Script path' }).fill(notExecutable);
      await hook.getByRole('button', { name: 'Save' }).click();
      await expect(hook.getByRole('alert')).toContainText('That script cannot be used: give the absolute path of an executable file that only you can write.');

      await hook.getByRole('textbox', { name: 'Script path' }).fill(goodScript);
      await hook.getByRole('textbox', { name: 'Timeout in seconds' }).fill('90');
      await hook.getByRole('button', { name: 'Save' }).click();
      await expect(hook).toContainText(goodScript);
      await expect(hook).toContainText('Times out after 90 s');
      await page.reload();
      await expect(page.getByRole('region', { name: 'Post-create hook' })).toContainText(goodScript);

      await page.getByRole('region', { name: 'Post-create hook' }).getByRole('button', { name: 'Change…' }).click();
      await page.getByRole('button', { name: 'Remove hook' }).click();
      await expect(page.getByRole('region', { name: 'Post-create hook' })).toContainText('No hook');
    } finally {
      rmSync(scriptDirectory, { recursive: true, force: true });
    }
  });
});
