import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingComponent } from './onboarding.component';

const PROJECT = { id: '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c', name: 'Fleet', docsFolderPath: null };
const DOCS_ROOT = '/Users/me/Documents/OpenFleet';
const PROPOSED_FOLDER = `${DOCS_ROOT}/Fleet`;
const DETECTION = {
  isGitRepository: true,
  stack: ['TypeScript', 'Angular'],
  commands: { install: { command: 'pnpm install', source: 'package.json' }, test: { command: 'pnpm test', source: 'package.json' } },
};

const NOTHING_DETECTED = { isGitRepository: false, stack: [], commands: {} };
const detectionFound = () => Promise.resolve(response(DETECTION));

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as Response;
}

async function openProjectStep(options: { docsRoot?: { root: string; isDefault: boolean } } = {}) {
  const docsRoot = options.docsRoot ?? { root: DOCS_ROOT, isDefault: true };
  const requests: Array<{ url: string; body: unknown }> = [];
  const daemon = { saveProject: () => Promise.resolve(response(PROJECT)), detect: () => Promise.resolve(response(NOTHING_DETECTED)) };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/settings/docs-root') {
      const projectName = new URL(url).searchParams.get('projectName');
      return Promise.resolve(response({ ...docsRoot, ...(projectName ? { proposedPath: `${docsRoot.root}/${projectName}` } : {}) }));
    }
    if (path === '/api/projects/detect') return daemon.detect();
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

const projectPosts = (requests: Array<{ url: string; body: unknown }>) => requests.filter(({ url }) => url.endsWith('/api/projects'));

async function typeName(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByLabelText('Name'), name);
  await waitFor(() => expect(screen.getByTestId('docs-folder-path')).toHaveTextContent(`${DOCS_ROOT}/${name}`));
}

async function saveProject(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Repository path'), '/work/fleet');
  await typeName(user, 'Fleet');
  await user.click(screen.getByRole('button', { name: 'Create project' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
}

const REMEMBERED_PROJECT_KEY = 'openfleet.onboarding.projectId';
const REMEMBERED_REPOSITORY_PATH_KEY = 'openfleet.onboarding.repositoryPath';

describe('onboarding project', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe('resuming after a reload', () => {
    it('remembers the project it creates', async () => {
      const { user } = await openProjectStep();

      await saveProject(user);

      expect(localStorage.getItem(REMEMBERED_PROJECT_KEY)).toBe(PROJECT.id);
    });

    it('shows the project it created before the reload as ready, with its repository path, Continue enabled and no second creation', async () => {
      localStorage.setItem(REMEMBERED_PROJECT_KEY, PROJECT.id);
      localStorage.setItem('openfleet.onboarding.repositoryPath', '/work/fleet');

      const { requests } = await openProjectStep();

      expect(await screen.findByText('Fleet', { exact: true })).toBeInTheDocument();
      expect(screen.getByLabelText('Repository path')).toHaveValue('/work/fleet');
      expect(screen.getByText(/Project ready/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
      expect(projectPosts(requests)).toHaveLength(0);
    });

    it('forgets the remembered project and repository path once the user continues to the first session', async () => {
      const { user } = await openProjectStep();
      await saveProject(user);

      await user.click(screen.getByRole('button', { name: 'Continue' }));

      await screen.findByRole('heading', { name: 'Start your first session' });
      expect(localStorage.getItem(REMEMBERED_PROJECT_KEY)).toBeNull();
      expect(localStorage.getItem(REMEMBERED_REPOSITORY_PATH_KEY)).toBeNull();
    });

    it('still shows the project step when the browser storage refuses to be read', async () => {
      const readStorage = Storage.prototype.getItem;
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        const isOnboardingKey = key.startsWith('openfleet.onboarding.');
        if (isOnboardingKey) throw new DOMException('storage is blocked', 'SecurityError');
        return readStorage.call(this, key);
      });

      await openProjectStep();

      expect(screen.getByRole('button', { name: 'Create project' })).toBeInTheDocument();
    });

    it('shows the empty form when the remembered project no longer exists on the daemon', async () => {
      localStorage.setItem(REMEMBERED_PROJECT_KEY, 'deleted-project-id');

      await openProjectStep();

      expect(screen.getByRole('button', { name: 'Create project' })).toBeInTheDocument();
      expect(screen.queryByText(/Project ready/)).not.toBeInTheDocument();
    });
  });

  it('requires a saved daemon project before switching to the first session', async () => {
    const { user, requests } = await openProjectStep();

    await user.type(screen.getByLabelText('Repository path'), '/work/fleet');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'Define the project' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Start your first session' })).not.toBeInTheDocument();
    await typeName(user, 'Fleet');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Start your first session' })).toBeInTheDocument();
    expect(projectPosts(requests)).toEqual([{ url: expect.any(String), body: { name: 'Fleet', docsFolderPath: PROPOSED_FOLDER, profile: { repositories: ['/work/fleet'] } } }]);
    const currentStep = screen.getAllByRole('listitem').filter((step) => step.getAttribute('aria-current') === 'step');
    expect(currentStep).toHaveLength(1);
    expect(currentStep[0]).toHaveTextContent('First session');
  });

  it('links the first session to the saved project and reuses it after Back without creating it twice', async () => {
    const { user, requests } = await openProjectStep();
    await saveProject(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Start your first session' });
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue(PROJECT.id));

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Define the project' });
    expect(screen.getByLabelText('Repository path')).toHaveValue('/work/fleet');
    expect(screen.getByText('Fleet', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Start your first session' });
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue(PROJECT.id));
    await user.click(screen.getByRole('button', { name: 'Create session' }));

    await waitFor(() => expect(requests.filter(({ url }) => url.endsWith('/api/sessions'))).toEqual([
      { url: expect.any(String), body: expect.objectContaining({ projectId: PROJECT.id, directory: '/work/fleet' }) },
    ]));
    expect(projectPosts(requests)).toHaveLength(1);
  });

  it('keeps the project step retryable when the daemon refuses to save', async () => {
    const { user, daemon } = await openProjectStep();
    daemon.saveProject = () => Promise.reject(new TypeError('Failed to fetch'));
    await typeName(user, 'Fleet');

    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The project was not saved — check your connection, then try again.');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByLabelText('Name')).toHaveValue('Fleet');
    expect(screen.getByRole('link', { name: /Skip to app/ })).toBeInTheDocument();
    daemon.saveProject = () => Promise.resolve(response(PROJECT));
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await screen.findByText('Fleet', { exact: true });
  });

  it('no longer tells the user to type a path because there is no folder picker', async () => {
    await openProjectStep();

    expect(screen.queryByText(/no folder picker yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Optional\. Type the absolute path/i)).not.toBeInTheDocument();
  });

  describe('specs and docs folder', () => {
    it('shows the proposed folder under the docs root, following the typed name, with its subfolders', async () => {
      const { user } = await openProjectStep({ docsRoot: { root: '/Users/me/Work/docs', isDefault: false } });

      await user.type(screen.getByLabelText('Name'), 'Fleet');

      await waitFor(() => expect(screen.getByTestId('docs-folder-path')).toHaveTextContent('/Users/me/Work/docs/Fleet'));
      expect(screen.getByTestId('docs-folder-block')).toHaveTextContent('specs/ plans/ handoffs/ reports/');
    });

    it.each(['Change…', 'Use an existing folder'])('lets the user type another folder after %s, and sends it', async (buttonName) => {
      const { user, requests } = await openProjectStep();
      await typeName(user, 'Fleet');

      await user.click(screen.getByRole('button', { name: buttonName }));
      const folderField = screen.getByLabelText('Specs and docs are saved in');
      expect(folderField).toHaveValue(PROPOSED_FOLDER);
      await user.clear(folderField);
      await user.type(folderField, '/Users/me/notes/fleet');
      await user.click(screen.getByRole('button', { name: 'Create project' }));

      await waitFor(() => expect(projectPosts(requests)).toHaveLength(1));
      expect(projectPosts(requests)[0]!.body).toMatchObject({ docsFolderPath: '/Users/me/notes/fleet' });
    });

    it.each(['/Users/me/qa-docs/../x', '/Users/me/./x', '/Users/me/x/..'])('tells that %s holds a "." or ".." segment instead of calling an absolute path unusable, and sends nothing', async (typedFolder) => {
      const { user, requests } = await openProjectStep();
      await typeName(user, 'Fleet');
      await user.click(screen.getByRole('button', { name: 'Change…' }));
      const folderField = screen.getByLabelText('Specs and docs are saved in');
      await user.clear(folderField);
      await user.type(folderField, typedFolder);

      await user.click(screen.getByRole('button', { name: 'Create project' }));

      expect(await screen.findByTestId('project-form-error')).toHaveTextContent('That folder path cannot contain "." or ".." — type the full absolute path.');
      expect(folderField).toHaveAttribute('aria-invalid', 'true');
      expect(projectPosts(requests)).toHaveLength(0);
    });

    it('shows a folder the daemon refuses under the field, keeps what was typed and focuses the field', async () => {
      const { user, daemon } = await openProjectStep();
      daemon.saveProject = () => Promise.resolve(response({ error: 'docs_folder_not_writable', message: 'the docs folder is not writable.' }, 400));
      await typeName(user, 'Fleet');

      await user.click(screen.getByRole('button', { name: 'Create project' }));

      const folderField = await screen.findByLabelText('Specs and docs are saved in');
      expect(await screen.findByTestId('project-form-error')).toHaveTextContent('That folder is not writable');
      expect(folderField).toHaveValue(PROPOSED_FOLDER);
      expect(folderField).toHaveAttribute('aria-invalid', 'true');
      await waitFor(() => expect(folderField).toHaveFocus());
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });
  });

  describe('project profile', () => {
    it('shows the note preview following the name, goal, stack chips and commands', async () => {
      const { user } = await openProjectStep();

      await typeName(user, 'Fleet');
      await user.type(screen.getByLabelText('Goal · one paragraph'), 'Run fleets of agents');
      await user.type(screen.getByLabelText('Stack'), 'Rust{Enter}Angular{Enter}');
      await user.type(screen.getByLabelText('install'), 'pnpm install');

      const preview = screen.getByTestId('note-preview');
      expect(preview).toHaveTextContent('# Project: Fleet');
      expect(preview).toHaveTextContent('Run fleets of agents');
      expect(preview).toHaveTextContent('- Rust');
      expect(preview).toHaveTextContent('- Angular');
      expect(preview).toHaveTextContent('- install: `pnpm install`');
    });

    it('removes a stack chip from the form and from the preview', async () => {
      const { user } = await openProjectStep();
      await user.type(screen.getByLabelText('Stack'), 'Rust{Enter}Angular{Enter}');

      await user.click(screen.getByRole('button', { name: 'Remove Rust' }));

      expect(screen.queryByRole('button', { name: 'Remove Rust' })).not.toBeInTheDocument();
      expect(screen.getByTestId('note-preview')).not.toHaveTextContent('- Rust');
      expect(screen.getByTestId('note-preview')).toHaveTextContent('- Angular');
    });

    it('prefills the commands and the stack from the detection and labels the detected commands', async () => {
      const { user, daemon } = await openProjectStep();
      daemon.detect = detectionFound;

      await user.type(screen.getByLabelText('Repository path'), '/work/fleet');
      await user.tab();

      await waitFor(() => expect(screen.getByLabelText('install')).toHaveValue('pnpm install'));
      expect(screen.getByLabelText('test')).toHaveValue('pnpm test');
      expect(screen.getByLabelText('build')).toHaveValue('');
      expect(screen.getAllByTestId('detected-label')).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Remove TypeScript' })).toBeInTheDocument();
    });

    it('drops the detected label from a command the user edits', async () => {
      const { user, daemon } = await openProjectStep();
      daemon.detect = detectionFound;
      await user.type(screen.getByLabelText('Repository path'), '/work/fleet');
      await user.tab();
      await waitFor(() => expect(screen.getAllByTestId('detected-label')).toHaveLength(2));

      await user.type(screen.getByLabelText('install'), ' --frozen-lockfile');

      expect(screen.getAllByTestId('detected-label')).toHaveLength(1);
    });

    it('replaces the commands detected in the first repository with those of the second, and keeps the ones the user typed', async () => {
      const { user, daemon } = await openProjectStep();
      daemon.detect = detectionFound;
      await user.type(screen.getByLabelText('Repository path'), '/work/first');
      await user.tab();
      await waitFor(() => expect(screen.getByLabelText('test')).toHaveValue('pnpm test'));
      await user.type(screen.getByLabelText('install'), ' --frozen-lockfile');
      const secondRepositoryDetection = { isGitRepository: true, stack: [], commands: { build: { command: 'make build', source: 'Makefile' } } };
      daemon.detect = () => Promise.resolve(response(secondRepositoryDetection));

      await user.clear(screen.getByLabelText('Repository path'));
      await user.type(screen.getByLabelText('Repository path'), '/work/second');
      await user.tab();

      await waitFor(() => expect(screen.getByLabelText('build')).toHaveValue('make build'));
      expect(screen.getByLabelText('test')).toHaveValue('');
      expect(screen.getByLabelText('install')).toHaveValue('pnpm install --frozen-lockfile');
      expect(screen.getAllByTestId('detected-label')).toHaveLength(1);
    });

    it('leaves the commands to type by hand when the detection fails', async () => {
      const { user, daemon } = await openProjectStep();
      daemon.detect = () => Promise.resolve(response({ error: 'invalid_body', message: 'no such folder' }, 400));

      await user.type(screen.getByLabelText('Repository path'), '/nowhere');
      await user.tab();

      expect(screen.queryByTestId('detected-label')).not.toBeInTheDocument();
      expect(screen.getByLabelText('install')).toHaveValue('');
    });

    it('creates the project with its name, docs folder and profile', async () => {
      const { user, requests, daemon } = await openProjectStep();
      daemon.detect = detectionFound;
      await user.type(screen.getByLabelText('Repository path'), '/work/fleet');
      await user.tab();
      await waitFor(() => expect(screen.getByLabelText('install')).toHaveValue('pnpm install'));
      await typeName(user, 'Fleet');
      await user.type(screen.getByLabelText('Goal · one paragraph'), 'Run fleets of agents');
      await user.type(screen.getByLabelText('Stack'), 'Rust{Enter}');

      await user.click(screen.getByRole('button', { name: 'Create project' }));

      await waitFor(() => expect(projectPosts(requests)).toHaveLength(1));
      expect(projectPosts(requests)[0]!.body).toEqual({
        name: 'Fleet',
        docsFolderPath: PROPOSED_FOLDER,
        profile: {
          goal: 'Run fleets of agents',
          stack: ['TypeScript', 'Angular', 'Rust'],
          commands: { install: 'pnpm install', test: 'pnpm test' },
          repositories: ['/work/fleet'],
        },
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
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
