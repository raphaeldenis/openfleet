import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { api, adminHeaders, signInAsAdmin } from './support/daemon';

interface CreatedNote { id: string; rev: number }

const NOTES_PAGE_MARKER = 'notes-page-was-not-reloaded';

async function createProject(request: APIRequestContext): Promise<string> {
  const created = await request.post(`${api}/api/projects`, { headers: adminHeaders, data: { name: `Live notes ${randomUUID().slice(0, 8)}` } });
  return (await created.json()).id;
}

async function createNote(request: APIRequestContext, projectId: string, { title, bodyMd }: { title: string; bodyMd: string }): Promise<CreatedNote> {
  const created = await request.post(`${api}/api/notes`, { headers: adminHeaders, data: { projectId, title, bodyMd } });
  return created.json();
}

async function writeBody(request: APIRequestContext, projectId: string, note: CreatedNote, bodyMd: string): Promise<number> {
  const patched = await request.patch(`${api}/api/notes/${note.id}`, { headers: adminHeaders, data: { projectId, expectedRev: note.rev, bodyMd } });
  return (await patched.json()).rev;
}

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

test('a write made while the note is open refreshes the display without reloading the page and says the note was updated', async ({ page, request }) => {
  const projectId = await createProject(request);
  const note = await createNote(request, projectId, { title: 'Live note', bodyMd: 'Before the write' });
  await page.goto(`/notes?projectId=${projectId}&noteId=${note.id}`);
  await expect(page.getByTestId('note-editor-body')).toContainText('Before the write');
  await page.evaluate((marker) => { (window as unknown as Record<string, boolean>)[marker] = true; }, NOTES_PAGE_MARKER);
  await expect(page.getByTestId('note-updated-notice')).toHaveCount(0);

  await writeBody(request, projectId, note, 'After the write, seen without a click');

  await expect(page.getByTestId('note-editor-body')).toContainText('After the write, seen without a click');
  await expect(page.getByTestId('note-updated-notice')).toHaveText(/This note was updated/);
  await expect(page.getByTestId('note-updated-notice')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId(`note-list-item-${note.id}`)).toHaveAttribute('aria-current', 'true');
  expect(await page.evaluate((marker) => (window as unknown as Record<string, boolean>)[marker], NOTES_PAGE_MARKER)).toBe(true);
});

test('five consecutive writes end on the last body, one notice and the same selection', async ({ page, request }) => {
  const projectId = await createProject(request);
  const note = await createNote(request, projectId, { title: 'Burst note', bodyMd: 'Start' });
  await page.goto(`/notes?projectId=${projectId}&noteId=${note.id}`);
  await expect(page.getByTestId('note-editor-body')).toContainText('Start');

  let current = note;
  for (let write = 1; write <= 5; write++) current = { id: note.id, rev: await writeBody(request, projectId, current, `Write number ${write}`) };

  await expect(page.getByTestId('note-editor-body')).toContainText('Write number 5');
  await expect(page.getByTestId('note-updated-notice')).toHaveCount(1);
  await expect(page.getByTestId(`note-list-item-${note.id}`)).toHaveAttribute('aria-current', 'true');
});

test('a note created elsewhere appears in the list, and a write to a note that is not open shows no message', async ({ page, request }) => {
  const projectId = await createProject(request);
  const openNote = await createNote(request, projectId, { title: 'Open note', bodyMd: 'Stays as it is' });
  const otherNote = await createNote(request, projectId, { title: 'Other note', bodyMd: 'Other before' });
  await page.goto(`/notes?projectId=${projectId}&noteId=${openNote.id}`);
  await expect(page.getByTestId('note-editor-body')).toContainText('Stays as it is');

  await createNote(request, projectId, { title: 'Created by an agent', bodyMd: 'x' });
  await writeBody(request, projectId, otherNote, 'Other after');

  await expect(page.getByTestId('note-list-items')).toContainText('Created by an agent');
  await expect(page.getByTestId('note-editor-body')).toContainText('Stays as it is');
  await expect(page.getByTestId('note-updated-notice')).toHaveCount(0);
});
