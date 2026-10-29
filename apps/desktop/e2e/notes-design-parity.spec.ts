import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { api, adminHeaders, signInAsAdmin } from './support/daemon';

const REVISIONS_THAT_OVERFLOW_THE_PANEL = 40;
const THEMES = ['light', 'dark'] as const;

async function createProject(request: APIRequestContext): Promise<string> {
  const created = await request.post(`${api}/api/projects`, { headers: adminHeaders, data: { name: `Notes parity ${randomUUID().slice(0, 8)}` } });
  return (await created.json()).id;
}

async function createNote(request: APIRequestContext, projectId: string, data: { title: string; bodyMd: string; folder?: string }): Promise<{ id: string; rev: number }> {
  const created = await request.post(`${api}/api/notes`, { headers: adminHeaders, data: { projectId, ...data } });
  return created.json();
}

async function rewriteBody(request: APIRequestContext, projectId: string, note: { id: string; rev: number }, times: number): Promise<number> {
  let rev = note.rev;
  for (let write = 1; write <= times; write++) {
    const patched = await request.patch(`${api}/api/notes/${note.id}`, { headers: adminHeaders, data: { projectId, expectedRev: rev, bodyMd: `Write number ${write}` } });
    rev = (await patched.json()).rev;
  }
  return rev;
}

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

for (const theme of THEMES) {
  test(`${theme} theme: the restore control stays visible at the bottom of a long history while the revisions scroll`, async ({ page, request }) => {
    const projectId = await createProject(request);
    const note = await createNote(request, projectId, { title: 'Long history', bodyMd: 'Start' });
    await rewriteBody(request, projectId, note, REVISIONS_THAT_OVERFLOW_THE_PANEL);
    await page.goto(`/notes?projectId=${projectId}&noteId=${note.id}`);
    await page.evaluate((name) => document.documentElement.setAttribute('data-theme', name), theme);

    await page.getByTestId('note-editor-history-toggle').click();

    const restore = page.getByTestId('note-history-restore');
    await expect(restore).toBeInViewport({ ratio: 1 });
    await page.getByTestId('note-history-version-1').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('note-history-version-1')).toBeInViewport();
    await expect(restore).toBeInViewport({ ratio: 1 });
  });

  test(`${theme} theme: notes sit under their folder heading and the open note shows its last change`, async ({ page, request }) => {
    const projectId = await createProject(request);
    const spec = await createNote(request, projectId, { title: 'Daemon protocol', bodyMd: 'Spec body', folder: 'specs' });
    await createNote(request, projectId, { title: 'Release checklist', bodyMd: 'Plan body', folder: 'plans' });
    await page.goto(`/notes?projectId=${projectId}&noteId=${spec.id}`);
    await page.evaluate((name) => document.documentElement.setAttribute('data-theme', name), theme);

    await expect(page.getByTestId('note-list-group-specs')).toHaveText(/specs\s*1/);
    await expect(page.getByTestId('note-list-group-plans')).toHaveText(/plans\s*1/);
    await expect(page.getByTestId('note-editor-last-change')).toContainText(/Last change · rev 1 · /);
  });
}
