import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingComponent } from './onboarding.component';

// Hostile black-box QE suite for P2-U7: what a user sees and can do, never how the component is built.

const HEALTH_POLL_INTERVAL_MS = 2000;
const REPOSITORY_PATH = '/Users/me/repo';
const DAEMON_STEP_HEADING = 'Start the OpenFleet daemon';
const PROJECT_STEP_HEADING = 'Define the project';
const FIRST_SESSION_STEP_HEADING = 'Start your first session';
const realSetTimeout = globalThis.setTimeout;

const daemonStepHeading = () => screen.getByRole('heading', { name: DAEMON_STEP_HEADING });
const projectStepHeading = () => screen.getByRole('heading', { name: PROJECT_STEP_HEADING });
const firstSessionStepHeading = () => screen.getByRole('heading', { name: FIRST_SESSION_STEP_HEADING });

function response({ status = 200, body = {} as unknown }: { status?: number; body?: unknown } = {}): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function responseWithNonJsonBody(): Response {
  return { ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')) } as unknown as Response;
}

function stubDaemon({ isUp = false } = {}) {
  const daemon = {
    answerHealth: (): Promise<Response> => (isUp ? Promise.resolve(response({ body: { ok: true } })) : Promise.reject(new TypeError('Failed to fetch'))),
    answerListSessions: (): Promise<Response> => Promise.resolve(response({ body: [] })),
    answerCreateSession: (): Promise<Response> => Promise.resolve(response({ body: { id: 's-new' } })),
  };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/health')) return daemon.answerHealth();
    if (url.endsWith('/api/sessions')) return init?.method === 'POST' ? daemon.answerCreateSession() : daemon.answerListSessions();
    return Promise.reject(new Error(`unexpected request to ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  const healthRequestCount = () => fetchMock.mock.calls.filter(([url]) => url.endsWith('/health')).length;
  const createSessionRequests = () => fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/api/sessions') && init?.method === 'POST').map(([, init]) => JSON.parse(init?.body as string));
  return { daemon, healthRequestCount, createSessionRequests };
}

async function renderOnboarding() {
  const view = await render(OnboardingComponent, { providers: [provideRouter([{ path: '**', children: [] }])] });
  return { ...view, router: TestBed.inject(Router) };
}

async function letTimePass(milliseconds: number, fixture: { whenStable: () => Promise<unknown> }): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await fixture.whenStable();
}

type Listener = (...args: unknown[]) => void;
type NodeProcess = { listeners(event: string): Listener[]; removeAllListeners(event: string): unknown; on(event: string, listener: Listener): unknown };

// Runs `action` while collecting the promise rejections nobody handled, so the run itself stays green.
async function collectUnhandledRejections(action: () => Promise<void>): Promise<unknown[]> {
  const nodeProcess = (globalThis as unknown as { process: NodeProcess }).process;
  const runnerListeners = nodeProcess.listeners('unhandledRejection');
  const rejections: unknown[] = [];
  nodeProcess.removeAllListeners('unhandledRejection');
  nodeProcess.on('unhandledRejection', (reason) => rejections.push(reason));
  try {
    await action();
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  } finally {
    nodeProcess.removeAllListeners('unhandledRejection');
    runnerListeners.forEach((listener) => nodeProcess.on('unhandledRejection', listener));
  }
  return rejections;
}

function newUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

async function reachProjectStep() {
  const daemonStub = stubDaemon({ isUp: true });
  const view = await renderOnboarding();
  await letTimePass(0, view.fixture);
  return { ...daemonStub, ...view };
}

async function reachFirstSessionStep(repositoryPath = REPOSITORY_PATH) {
  const view = await reachProjectStep();
  const user = newUser();
  await user.type(screen.getByLabelText('Repository path'), repositoryPath);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  return { ...view, user };
}

describe('Onboarding — hostile black-box suite', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('daemon polling', () => {
    it('a /health request that hangs is not stacked with a new /health request every 2 seconds', async () => {
      const { daemon, healthRequestCount } = stubDaemon();
      daemon.answerHealth = () => new Promise<Response>(() => undefined);
      const { fixture } = await renderOnboarding();

      await letTimePass(HEALTH_POLL_INTERVAL_MS * 2, fixture);

      expect(healthRequestCount()).toBe(1);
    });

    it('a /health that never answers is given up on after 5 seconds and checked again', async () => {
      const { daemon, healthRequestCount } = stubDaemon();
      daemon.answerHealth = () => new Promise<Response>(() => undefined);
      const { fixture } = await renderOnboarding();

      await letTimePass(5000 + HEALTH_POLL_INTERVAL_MS, fixture);

      expect(healthRequestCount()).toBe(2);
      expect(daemonStepHeading()).toBeInTheDocument();
    });

    it('user starting the daemon after a few failed checks is moved on to the project step', async () => {
      const { daemon } = stubDaemon();
      const { fixture } = await renderOnboarding();
      await letTimePass(HEALTH_POLL_INTERVAL_MS * 2, fixture);
      expect(daemonStepHeading()).toBeInTheDocument();

      daemon.answerHealth = () => Promise.resolve(response({ body: { ok: true } }));
      await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

      expect(projectStepHeading()).toBeInTheDocument();
    });

    it('user with the daemon already up is taken to the project step at once, without waiting for a poll tick', async () => {
      stubDaemon({ isUp: true });
      const { fixture } = await renderOnboarding();

      await letTimePass(0, fixture);

      expect(projectStepHeading()).toBeInTheDocument();
    });

    it('a /health answering 503 keeps the user on the daemon step', async () => {
      const { daemon } = stubDaemon();
      daemon.answerHealth = () => Promise.resolve(response({ status: 503, body: { error: 'starting' } }));
      const { fixture } = await renderOnboarding();

      await letTimePass(HEALTH_POLL_INTERVAL_MS * 2, fixture);

      expect(daemonStepHeading()).toBeInTheDocument();
    });

    it('a 200 that is not JSON (some other service on the port) keeps the user on the daemon step', async () => {
      const { daemon } = stubDaemon();
      daemon.answerHealth = () => Promise.resolve(responseWithNonJsonBody());
      const { fixture } = await renderOnboarding();

      await letTimePass(HEALTH_POLL_INTERVAL_MS * 2, fixture);

      expect(daemonStepHeading()).toBeInTheDocument();
    });

    it('a 200 whose body says {ok: false} keeps the user on the daemon step', async () => {
      const { daemon } = stubDaemon();
      daemon.answerHealth = () => Promise.resolve(response({ body: { ok: false } }));
      const { fixture } = await renderOnboarding();

      await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

      expect(daemonStepHeading()).toBeInTheDocument();
    });

    it('user leaving onboarding and coming back gets one poll every 2 seconds, not one per visit', async () => {
      const { healthRequestCount } = stubDaemon();
      const firstVisit = await renderOnboarding();
      firstVisit.fixture.destroy();

      const secondVisit = TestBed.createComponent(OnboardingComponent);
      secondVisit.detectChanges();
      const requestsOnSecondArrival = healthRequestCount();
      await letTimePass(HEALTH_POLL_INTERVAL_MS * 2, secondVisit);

      expect(healthRequestCount()).toBe(requestsOnSecondArrival + 2);
    });
  });

  describe('copy command', () => {
    async function clickCopyCommandWhenClipboardIs(clipboard: 'refusing' | 'missing') {
      stubDaemon();
      const user = newUser();
      await renderOnboarding();
      const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      if (clipboard === 'refusing') vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
      if (clipboard === 'missing') Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      try {
        return await collectUnhandledRejections(() => user.click(screen.getByRole('button', { name: 'Copy command' })));
      } finally {
        if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
      }
    }

    it('user whose clipboard write is refused is not told the command was copied, and can still read it', async () => {
      await clickCopyCommandWhenClipboardIs('refusing');

      expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
      expect(screen.getByText('$ pnpm dev:core')).toBeInTheDocument();
    });

    it('user with no clipboard API is not told the command was copied, and can still read it', async () => {
      await clickCopyCommandWhenClipboardIs('missing');

      expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
      expect(screen.getByText('$ pnpm dev:core')).toBeInTheDocument();
    });

    it('user whose clipboard write is refused causes no unhandled promise rejection', async () => {
      const unhandledRejections = await clickCopyCommandWhenClipboardIs('refusing');

      expect(unhandledRejections).toEqual([]);
    });

    it('user with no clipboard API causes no unhandled promise rejection', async () => {
      const unhandledRejections = await clickCopyCommandWhenClipboardIs('missing');

      expect(unhandledRejections).toEqual([]);
    });

    it.each(['refusing', 'missing'] as const)('user whose clipboard is %s is told to copy the command by hand', async (clipboard) => {
      await clickCopyCommandWhenClipboardIs(clipboard);

      expect(screen.getByRole('status')).toHaveTextContent('Couldn’t copy — select the command and copy it by hand');
    });
  });

  describe('stepper', () => {
    it('the stepper is a labelled list, so a screen reader announces "Setup steps, list, 6 items"', async () => {
      stubDaemon();
      await renderOnboarding();

      const stepper = screen.getByRole('list', { name: 'Setup steps' });

      expect(within(stepper).getAllByRole('listitem')).toHaveLength(6);
    });

    it('exactly one step is current at any time, and it follows the user from Daemon to Project', async () => {
      const { daemon } = stubDaemon();
      const { fixture } = await renderOnboarding();
      const currentSteps = () => screen.getAllByRole('listitem').filter((step) => step.getAttribute('aria-current') === 'step');
      expect(currentSteps().map((step) => step.textContent)).toEqual([expect.stringContaining('Daemon')]);

      daemon.answerHealth = () => Promise.resolve(response({ body: { ok: true } }));
      await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

      expect(currentSteps().map((step) => step.textContent)).toEqual([expect.stringContaining('Project')]);
    });

    it('keyboard user tabbing through the page never lands on a step of the stepper, and clicking a later-phase step goes nowhere', async () => {
      stubDaemon();
      const user = newUser();
      await renderOnboarding();
      const stepper = screen.getByRole('list', { name: 'Setup steps' });

      const tabStops: Element[] = [];
      for (let pressCount = 0; pressCount < 6; pressCount++) {
        await user.tab();
        tabStops.push(document.activeElement as Element);
      }
      await user.click(screen.getByText('Playbooks'));

      expect(tabStops.some((stop) => stepper.contains(stop))).toBe(false);
      expect(daemonStepHeading()).toBeInTheDocument();
    });

    it('the first Tab stop is "Skip to app" and the second is "Copy command"', async () => {
      stubDaemon();
      const user = newUser();
      await renderOnboarding();

      await user.tab();
      expect(screen.getByRole('link', { name: /Skip to app/ })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('button', { name: 'Copy command' })).toHaveFocus();
    });

    it('screen reader user is told the Daemon step is done once the user is on the Project step', async () => {
      await reachProjectStep();

      const daemonStep = screen.getAllByRole('listitem').find((step) => step.textContent?.includes('Daemon'));

      expect(daemonStep).toHaveTextContent(/done|complete/i);
    });

    it('the first-session step has a single top-level heading', async () => {
      await reachFirstSessionStep();

      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    });
  });

  describe('project step', () => {
    it('user pressing Enter in the repository path field moves on to the first-session step', async () => {
      const { user } = await reachProjectStepAndType();

      await user.keyboard('{Enter}');

      expect(firstSessionStepHeading()).toBeInTheDocument();
    });

    it('user pressing Enter with an empty repository path stays on the project step', async () => {
      await reachProjectStep();
      const user = newUser();

      await user.click(screen.getByLabelText('Repository path'));
      await user.keyboard('{Enter}');

      expect(projectStepHeading()).toBeInTheDocument();
    });

    it('a repository path made only of spaces cannot be continued, by button or by Enter', async () => {
      await reachProjectStep();
      const user = newUser();

      await user.type(screen.getByLabelText('Repository path'), '    {Enter}');

      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      expect(projectStepHeading()).toBeInTheDocument();
    });

    it('user on the first-session step can go back to the project step and finds the path they typed', async () => {
      const { user } = await reachFirstSessionStep();

      await user.click(screen.getByRole('button', { name: 'Back' }));

      expect(projectStepHeading()).toBeInTheDocument();
      expect(screen.getByLabelText('Repository path')).toHaveValue(REPOSITORY_PATH);
    });
  });

  describe('first-session step', () => {
    it('user gets exactly the documented payload: trimmed path, default identity, default model, and the seeded prompt', async () => {
      const { createSessionRequests, user } = await reachFirstSessionStep(`  ${REPOSITORY_PATH}  `);

      await user.click(screen.getByRole('button', { name: 'Create session' }));

      await vi.waitFor(() => expect(createSessionRequests()).toHaveLength(1));
      const [payload] = createSessionRequests();
      expect(payload).toEqual({
        directory: REPOSITORY_PATH,
        name: 'First session',
        emoji: '🤖',
        model: 'sonnet',
        harness: 'claude-cli',
        seededPrompt: expect.stringMatching(/do not modify/i),
      });
    });

    it('user submitting twice in a row creates one session, so the seeded prompt reaches the daemon once', async () => {
      const { createSessionRequests } = await reachFirstSessionStep();
      const form = screen.getByRole('button', { name: 'Create session' }).closest('form') as HTMLFormElement;

      form.dispatchEvent(new Event('submit', { cancelable: true }));
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect(createSessionRequests()).toHaveLength(1);
    });

    it('the form offers no Session/Manager choice, since onboarding creates a session', async () => {
      await reachFirstSessionStep();

      expect(screen.queryByRole('button', { name: 'Manager' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Session' })).toBeNull();
      expect(screen.queryByRole('group', { name: 'Kind of session' })).toBeNull();
    });

    it('the form has no Cancel link and no title of its own, since Skip to app covers leaving and the step owns the heading', async () => {
      await reachFirstSessionStep();

      expect(screen.queryByRole('link', { name: 'Cancel' })).toBeNull();
      expect(screen.queryByText('New session')).toBeNull();
    });

    it('user arriving with ?mode=manager in the URL still creates a session with the seeded prompt, and the URL is left untouched', async () => {
      const daemonStub = stubDaemon({ isUp: true });
      const { fixture, router } = await renderOnboarding();
      await router.navigateByUrl('/onboarding?mode=manager');
      await letTimePass(0, fixture);
      const user = newUser();
      await user.type(screen.getByLabelText('Repository path'), REPOSITORY_PATH);
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      expect(router.url).toBe('/onboarding?mode=manager');

      await user.click(screen.getByRole('button', { name: 'Create session' }));

      await vi.waitFor(() => expect(daemonStub.createSessionRequests()).toHaveLength(1));
      expect(daemonStub.createSessionRequests()[0]).toHaveProperty('seededPrompt', expect.stringMatching(/do not modify/i));
    });

    it('user can overwrite the pre-filled directory and name, and the payload follows what they typed', async () => {
      const { createSessionRequests, user } = await reachFirstSessionStep();

      await user.clear(screen.getByLabelText('Directory'));
      await user.type(screen.getByLabelText('Directory'), '/Users/me/other-worktree');
      await user.clear(screen.getByLabelText('Name'));
      await user.type(screen.getByLabelText('Name'), 'Gimli');
      await user.click(screen.getByRole('button', { name: 'Create session' }));

      await vi.waitFor(() => expect(createSessionRequests()).toHaveLength(1));
      expect(createSessionRequests()[0]).toEqual(expect.objectContaining({ directory: '/Users/me/other-worktree', name: 'Gimli' }));
    });

    it('user who empties the pre-filled name gets an inline error and nothing is sent', async () => {
      const { createSessionRequests, user } = await reachFirstSessionStep();

      await user.clear(screen.getByLabelText('Name'));
      await user.click(screen.getByRole('button', { name: 'Create session' }));

      expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
      expect(createSessionRequests()).toHaveLength(0);
    });

    it('user whose directory the daemon refuses sees the error, stays on the step, and a retry succeeds and navigates', async () => {
      const { daemon, createSessionRequests, router, user } = await reachFirstSessionStep();
      const urlBeforeSubmit = router.url;
      daemon.answerCreateSession = () => Promise.resolve(response({ status: 400, body: { error: 'directory_missing' } }));

      await user.click(screen.getByRole('button', { name: 'Create session' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('POST /api/sessions → 400');
      expect(router.url).toBe(urlBeforeSubmit);
      daemon.answerCreateSession = () => Promise.resolve(response({ body: { id: 's-retry' } }));
      await user.click(screen.getByRole('button', { name: 'Create session' }));
      await vi.waitFor(() => expect(router.url).toBe('/session/s-retry'));
      expect(createSessionRequests()).toHaveLength(2);
    });

    it('user whose daemon has gone away meanwhile is told to check the connection', async () => {
      const { daemon, user } = await reachFirstSessionStep();
      daemon.answerCreateSession = () => Promise.reject(new TypeError('Failed to fetch'));

      await user.click(screen.getByRole('button', { name: 'Create session' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/check your connection/i);
    });

    it('user is shown the seeded prompt before it is sent on their behalf', async () => {
      await reachFirstSessionStep();

      expect(screen.getByText(/Read the README/i)).toBeInTheDocument();
    });
  });
});

async function reachProjectStepAndType() {
  const view = await reachProjectStep();
  const user = newUser();
  await user.type(screen.getByLabelText('Repository path'), REPOSITORY_PATH);
  return { ...view, user };
}
