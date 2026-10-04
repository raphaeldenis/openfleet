import { expect, test, type Page } from '@playwright/test';
import { fulfillWithJson, interceptDaemonGet, signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();

const SECTION_LABELS = ['Goal', 'State', 'Decisions', 'Files touched', 'Next steps', 'Open questions'];
const LOADING_TEXT = 'Collecting the state…';
const META_TEXT = 'From the state panel and git status · edit before saving';
const DAEMON_SILENT_COPY = 'The preview could not be loaded — the daemon did not answer in time.';
const NETWORK_DOWN_COPY = 'The preview could not be loaded — check your connection, then try again.';

const previewPathOf = (sessionId: string) => `/api/sessions/${sessionId}/handoff-preview`;

async function openHandoffPanel(page: Page, sessionId: string) {
  await page.goto(`/session/${sessionId}`);
  await page.getByTestId('session-header-toggle').click();
  await page.getByRole('button', { name: 'Write handoff' }).click();
  return page.getByRole('dialog', { name: 'Handoff preview' });
}

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

test('the handoff preview shows a spinner while the daemon collects, then six editable sections', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Handoff ready' });
  await session.hooks.announceIdle();
  let releasePreview: () => void = () => undefined;
  const previewMayAnswer = new Promise<void>((resolve) => { releasePreview = resolve; });
  await interceptDaemonGet(page, previewPathOf(session.id), async (route) => {
    await previewMayAnswer;
    await route.fallback();
  });

  const panel = await openHandoffPanel(page, session.id);

  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('handoff-spinner')).toBeVisible();
  await expect(panel.getByText(LOADING_TEXT)).toBeVisible();
  await expect(panel.getByRole('textbox')).toHaveCount(0);

  releasePreview();

  await expect(panel.getByTestId('handoff-spinner')).toHaveCount(0);
  for (const label of SECTION_LABELS) await expect(panel.getByRole('textbox', { name: label, exact: true })).toBeEnabled();
  await expect(panel.getByRole('textbox')).toHaveCount(SECTION_LABELS.length);
  await expect(panel.getByText(META_TEXT)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Cancel' })).toBeVisible();
});

test('a session outside any project cannot save its handoff and the panel says why', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Handoff no project' });
  await session.hooks.announceIdle();

  const panel = await openHandoffPanel(page, session.id);

  const saveButton = panel.getByRole('button', { name: 'Save handoff' });
  await expect(saveButton).toBeVisible();
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).toHaveAccessibleDescription(/^Save is off: /);
});

test('cancelling the handoff hides the panel and puts the focus back on Write handoff', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Handoff cancel' });
  await session.hooks.announceIdle();
  const panel = await openHandoffPanel(page, session.id);
  await expect(panel.getByRole('textbox', { name: 'Goal' })).toBeVisible();

  await panel.getByRole('button', { name: 'Cancel' }).click();

  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Write handoff' })).toBeFocused();
});

test('while the handoff panel is open the header details cannot be collapsed and the toggle says why', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Handoff locks details' });
  await session.hooks.announceIdle();
  const panel = await openHandoffPanel(page, session.id);
  await expect(panel).toBeVisible();

  const detailsToggle = page.getByTestId('session-header-toggle');
  await detailsToggle.click({ force: true });

  await expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(detailsToggle).toHaveAttribute('aria-disabled', 'true');
  await expect(detailsToggle).toHaveAccessibleDescription('Details stay open while the handoff panel is open.');
});

test('a daemon that does not answer shows the load-failed row, with no fields and no save, and Try again recovers', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Handoff daemon silent' });
  await session.hooks.announceIdle();
  let previewRequests = 0;
  await interceptDaemonGet(page, previewPathOf(session.id), async (route) => {
    previewRequests += 1;
    const isFirstAttempt = previewRequests === 1;
    if (isFirstAttempt) return fulfillWithJson(route, 500, 'gateway timeout');
    return route.fallback();
  });

  const panel = await openHandoffPanel(page, session.id);

  const failure = panel.getByRole('alert');
  await expect(failure).toContainText(DAEMON_SILENT_COPY);
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Save handoff' })).toHaveCount(0);

  await failure.getByRole('button', { name: 'Try again' }).click();

  await expect(panel.getByRole('textbox')).toHaveCount(SECTION_LABELS.length);
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('a network that is down shows the load-failed row with the connection advice', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Handoff offline' });
  await session.hooks.announceIdle();
  await interceptDaemonGet(page, previewPathOf(session.id), (route) => route.abort('failed'));

  const panel = await openHandoffPanel(page, session.id);

  await expect(panel.getByRole('alert')).toContainText(NETWORK_DOWN_COPY);
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(panel.getByRole('textbox')).toHaveCount(0);
});
