import { TestBed } from '@angular/core/testing';
import userEvent from '@testing-library/user-event';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { signal } from '@angular/core';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';
import { silentWorkingStateSignals } from './working-state/working-state-fixtures';
import { FleetApiService } from './core/fleet-api.service';

function configureTestBed() {
  const managerSession = { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle', harness: 'claude-cli' };
  const workerSession = { id: 's1', name: 'Gimli', emoji: '⛏️', state: 'idle', harness: 'claude-cli', directory: '/repo' };
  const secondWorkerSession = { id: 's2', name: 'Legolas', emoji: '🏹', state: 'idle', harness: 'claude-cli', directory: '/repo' };
  return TestBed.configureTestingModule({
    providers: [
      provideRouter(routes, withComponentInputBinding()),
      {
        provide: FleetEventsService,
        useValue: {
          sessions: signal([managerSession, workerSession, secondWorkerSession]),
          approvals: signal([]),
          managers: signal([]),
          ...silentWorkingStateSignals(),
          connect: () => {},
          connected: signal(true),
          snapshotReceived: signal(true),
          reconnectCount: signal(0),
          deliveredMessageIds: signal(new Set()),
          output: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
          sendInput: () => {},
          sendResize: () => {},
          sendAttach: () => {},
          dropQueuedSendsFor: () => {},
        },
      },
    ],
  }).compileComponents();
}

describe('app.routes', () => {
  afterEach(() => localStorage.clear());

  it("renders the app shell with an empty state at ''", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="empty-state"]')).toBeTruthy();
  });

  it("renders the components sheet at '/components', outside the shell chrome", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/components');
    expect(harness.routeNativeElement?.querySelector('[data-testid="components-sheet"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeFalsy();
  });

  it("renders onboarding at '/onboarding', outside the shell chrome", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/onboarding');
    expect(harness.routeNativeElement?.querySelector('[data-testid="onboarding"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeFalsy();
  });

  it("renders the inbox in its own panel at '/inbox', inside the shell", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/inbox');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('of-inbox')).toBeTruthy();
  });

  it("renders the notes screen at '/notes', inside the shell", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/notes');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="notes-view"]')).toBeTruthy();
  });

  it("renders the tables screen at '/tables' inside the shell, scoped by the projectId query parameter", async () => {
    await configureTestBed();
    const api = {
      listProjects: () => Promise.resolve({ items: [{ id: 'p1', name: 'openfleet', docsFolderPath: null }, { id: 'p2', name: 'other', docsFolderPath: null }], total: 2, limit: 100, offset: 0 }),
      listDataStores: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
    };
    TestBed.overrideProvider(FleetApiService, { useValue: api });

    const harness = await RouterTestingHarness.create('/tables?projectId=p2');
    await harness.fixture.whenStable();

    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="tables-view"]')).toBeTruthy();
    expect(api.listDataStores).toHaveBeenCalledWith('p2');
  });

  it("renders the new-session form at '/new' inside the shell", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/new');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="new-session-form"]')).toBeTruthy();
  });

  it("opens the new-session form in manager mode at '/new?mode=manager'", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/new?mode=manager');
    expect(harness.routeNativeElement?.querySelector('[data-testid="manager-mission"]')).toBeTruthy();
  });

  it("renders the manager dashboard at '/manager/:id' without losing the sidebar (the old three-column layout's dead end)", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/manager/m1');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-nav"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="manager-dashboard"]')).toBeTruthy();
  });

  it("renders the session view at '/session/:sessionId' without losing the sidebar (the old three-column layout's dead end)", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/session/s1');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-nav"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="session-view"]')).toBeTruthy();
  });

  it('user picking a different session while already on a session view sees the new session, not the old one (zoneless router-input-binding regression)', async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/session/s1');
    const openPanelButton = harness.routeNativeElement?.querySelector('[data-testid="right-panel-rail"]') as HTMLButtonElement | null;
    openPanelButton?.click();
    await harness.fixture.whenStable();
    const shownName = () => (harness.routeNativeElement?.querySelector('[data-testid="session-name-input"]') as HTMLInputElement | null)?.value;
    await vi.waitFor(() => expect(shownName()).toBe('Gimli'));

    await harness.navigateByUrl('/session/s2');

    await vi.waitFor(() => expect(shownName()).toBe('Legolas'));
  });

  it("user opening a crafted '/new?…' link creates a session without the prompt, the mode and the pre-fills the link tried to inject", async () => {
    await configureTestBed();
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 's-new' }) } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);
    const harness = await RouterTestingHarness.create('/new?seededPrompt=evil&embedded=true&initialName=Injected&initialDirectory=/injected');
    const field = (testId: string) => harness.routeNativeElement?.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
    const user = userEvent.setup({ delay: null });
    expect(harness.routeNativeElement?.querySelector('[data-testid="new-session-cancel"]')).toBeTruthy();

    await user.type(field('new-session-directory'), '/tmp/wt');
    await user.type(field('new-session-name'), 'Gimli');
    await user.click(field('new-session-submit'));

    const sentRequests = () => (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(([, request]) => request);
    const createRequestSent = () => sentRequests().find((request) => request.method === 'POST');
    await vi.waitFor(() => expect(createRequestSent()).toBeDefined());
    await harness.fixture.whenStable();
    expect(JSON.parse(createRequestSent()!.body as string)).toStrictEqual({ directory: '/tmp/wt', name: 'Gimli', emoji: '🤖', model: 'sonnet', harness: 'claude-cli' });
    vi.unstubAllGlobals();
    // A loaded CI runner needs more than Vitest's 5 s default for the lazy route, the typing and the submit.
  }, 20_000);

  it('user visiting an unknown path still lands inside the app shell instead of a blank page', async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/this-page-does-not-exist');

    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="not-found"]')).toBeTruthy();
  });
});
