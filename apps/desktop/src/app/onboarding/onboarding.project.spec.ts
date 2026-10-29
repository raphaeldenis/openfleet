import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnboardingComponent } from './onboarding.component';

const PROJECT = { id: '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c', name: 'Fleet', docsFolderPath: null };

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as Response;
}

async function openProjectStep(options: { docsRoot?: { root: string; isDefault: boolean } } = {}) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const daemon = { saveProject: () => Promise.resolve(response(PROJECT)) };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/settings/docs-root' && options.docsRoot) {
      const projectName = new URL(url).searchParams.get('projectName');
      return Promise.resolve(response({ ...options.docsRoot, ...(projectName ? { proposedPath: `${options.docsRoot.root}/${projectName}` } : {}) }));
    }
    const isWrite = init?.method === 'POST';
    if (isWrite) requests.push({ url, body: JSON.parse(init.body as string) });
    if (url.endsWith('/health')) return Promise.resolve(response({ ok: true }));
    if (path === '/api/projects') return isWrite ? daemon.saveProject() : Promise.resolve(response({ items: [PROJECT], total: 1 }));
    if (url.endsWith('/api/sessions')) return Promise.resolve(response(isWrite ? { id: 'first-session' } : []));
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }));
  const view = await render(OnboardingComponent, { providers: [provideRouter([{ path: '**', children: [] }])] });
  await screen.findByRole('heading', { name: 'Define the project' });
  return { ...view, requests, daemon, user: userEvent.setup() };
}

async function saveProject(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Repository path'), '/work/fleet');
  await user.type(screen.getByLabelText('Name'), 'Fleet');
  await user.click(screen.getByRole('button', { name: 'Create project' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
}

describe('onboarding project', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires a saved daemon project before switching to the first session', async () => {
    const { user, requests } = await openProjectStep();

    await user.type(screen.getByLabelText('Repository path'), '/work/fleet');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'Define the project' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Start your first session' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Fleet');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Start your first session' })).toBeInTheDocument();
    expect(requests.filter(({ url }) => url.endsWith('/api/projects'))).toEqual([{ url: expect.any(String), body: { name: 'Fleet' } }]);
    const currentStep = screen.getAllByRole('listitem').filter((step) => step.getAttribute('aria-current') === 'step');
    expect(currentStep).toHaveLength(1);
    expect(currentStep[0]).toHaveTextContent('First session');
  });

  it('links the first session to the saved project and reuses it after Back', async () => {
    const { user, requests } = await openProjectStep();
    await saveProject(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Start your first session' });
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue(PROJECT.id));

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Define the project' });
    expect(screen.getByLabelText('Repository path')).toHaveValue('/work/fleet');
    expect(screen.getByText('Fleet', { exact: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Start your first session' });
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue(PROJECT.id));
    await user.click(screen.getByRole('button', { name: 'Create session' }));

    await waitFor(() => expect(requests.filter(({ url }) => url.endsWith('/api/sessions'))).toEqual([
      { url: expect.any(String), body: expect.objectContaining({ projectId: PROJECT.id, directory: '/work/fleet' }) },
    ]));
    expect(requests.filter(({ url }) => url.endsWith('/api/projects'))).toHaveLength(1);
  });

  it('keeps the project step retryable when the daemon refuses to save', async () => {
    const { user, daemon } = await openProjectStep();
    daemon.saveProject = () => Promise.reject(new TypeError('Failed to fetch'));
    await user.type(screen.getByLabelText('Name'), 'Fleet');

    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The project was not saved — check your connection, then try again.');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByLabelText('Name')).toHaveValue('Fleet');
    expect(screen.getByRole('link', { name: /Skip to app/ })).toBeInTheDocument();
    daemon.saveProject = () => Promise.resolve(response(PROJECT));
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await screen.findByText('Fleet', { exact: true });
  });

  describe('docs folder root', () => {
    it('suggests <root>/<name> for the docs folder once a root is saved, following the typed name', async () => {
      const { user } = await openProjectStep({ docsRoot: { root: '/Users/me/Work/docs', isDefault: false } });

      await user.type(screen.getByLabelText('Name'), 'Fleet');

      expect(await screen.findByTestId('project-docs-folder-suggestion')).toHaveTextContent('/Users/me/Work/docs/Fleet');
    });

    it('suggests nothing while the daemon only knows its default root, and the project is created exactly as before', async () => {
      const { user, requests } = await openProjectStep({ docsRoot: { root: '/Users/me/Documents/OpenFleet', isDefault: true } });

      await saveProject(user);

      expect(screen.queryByTestId('project-docs-folder-suggestion')).not.toBeInTheDocument();
      expect(requests.filter(({ url }) => url.endsWith('/api/projects'))).toEqual([{ url: expect.any(String), body: { name: 'Fleet' } }]);
    });

    it('does not fill the docs folder field, even when a root is saved', async () => {
      const { user, requests } = await openProjectStep({ docsRoot: { root: '/Users/me/Work/docs', isDefault: false } });

      await user.type(screen.getByLabelText('Repository path'), '/work/fleet');
      await user.type(screen.getByLabelText('Name'), 'Fleet');
      await screen.findByTestId('project-docs-folder-suggestion');
      await user.click(screen.getByRole('button', { name: 'Create project' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());

      expect(requests.filter(({ url }) => url.endsWith('/api/projects'))).toEqual([{ url: expect.any(String), body: { name: 'Fleet' } }]);
    });
  });

  it('lets the user cancel project setup without saving a project', async () => {
    const { user, requests } = await openProjectStep();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/onboarding');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(router.url).toBe('/'));
    expect(requests).toHaveLength(0);
  });
});
