import { test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { readE2eAdminToken } from '../../../../scripts/e2e/e2eHome';

/**
 * Black-box helpers shared by the screen-family specs. They talk to the daemon the Playwright config boots with
 * OPENFLEET_E2E=1 (fake harness, `fake-output`, `fake-exit` and `fail-next-pulses` routes) on a per-run temp home.
 */
const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7332';
export const api = process.env['OPENFLEET_E2E_API'] ?? DEFAULT_DAEMON_URL;
const token = readE2eAdminToken();
export const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

const CORS_HEADERS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

/** The right panel starts open, the way a user who works with a session's details keeps it, unless `rightPanel` says otherwise. */
export async function signInAsAdmin(page: Page, { theme, rightPanel = 'open' }: { theme?: 'light' | 'dark'; rightPanel?: 'open' | 'closed' } = {}): Promise<void> {
  await page.addInitScript(([adminToken, apiUrl, chosenTheme, rightPanelChoice]) => {
    localStorage.setItem('openfleet.adminToken', adminToken);
    localStorage.setItem('openfleet.apiUrl', apiUrl);
    localStorage.setItem('openfleet.rightPanel.open', String(rightPanelChoice === 'open'));
    if (chosenTheme) localStorage.setItem('openfleet.theme', chosenTheme);
  }, [token, api, theme ?? '', rightPanel] as const);
}

interface FakeSessionSpec { name: string; emoji?: string; directory?: string; model?: string; manager?: { pulseSeconds: number; childrenCap: number; mission: string } }

/** Hooks of a fake session, played the way the Claude CLI would post them. */
export interface SessionHooks {
  announceIdle(): Promise<void>;
  startTurn(): Promise<void>;
  endTurn(): Promise<void>;
  /** Resolves with the behavior the human decided ('allow' | 'deny'), once the gate is decided. */
  requestPermission(toolInput: { command: string }): Promise<string>;
}

export interface FakeSession { id: string; hooks: SessionHooks }

/** Creates fake-harness sessions and closes every one of them after each test. */
export function useFakeSessions() {
  const createdIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdIds.splice(0)) await request.post(`${api}/api/sessions/${id}/close`, { headers: adminHeaders });
  });

  return {
    async create(request: APIRequestContext, { name, emoji = '🧪', directory = '/tmp', model, manager }: FakeSessionSpec): Promise<FakeSession> {
      const created = await request.post(`${api}/api/sessions`, { headers: adminHeaders, data: { directory, name, emoji, harness: 'fake', ...(model ? { model } : {}), ...(manager ? { manager } : {}) } });
      const { id } = await created.json();
      createdIds.push(id);
      const { hookToken } = await (await request.get(`${api}/api/sessions/${id}/tokens`, { headers: adminHeaders })).json();
      const postHook = (payload: Record<string, unknown>) => request.post(`${api}/hooks/${hookToken}`, { data: { session_id: 'x', ...payload } });
      const hooks: SessionHooks = {
        announceIdle: async () => { await postHook({ hook_event_name: 'SessionStart' }); },
        startTurn: async () => { await postHook({ hook_event_name: 'UserPromptSubmit' }); },
        // A SessionStart proves the CLI waits on its composer again; a bare Stop is answered with a block by the daemon's stop-refusal.
        endTurn: async () => { await postHook({ hook_event_name: 'SessionStart' }); },
        requestPermission: async (toolInput) => (await (await postHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: toolInput })).json()).hookSpecificOutput.decision.behavior,
      };
      return { id, hooks };
    },
  };
}

/** Makes the fake CLI of a session exit by itself with `code`, as a crashed or a refused CLI would. */
export async function exitFakeCli(request: APIRequestContext, sessionId: string, exit: { code: number; conversationNotFound?: boolean }): Promise<void> {
  await request.post(`${api}/api/sessions/${sessionId}/fake-exit`, { headers: adminHeaders, data: exit });
}

/** Answers the CORS preflight itself and hands every GET of `pathname` to `respond`; any other request goes to the real daemon. */
export async function interceptDaemonGet(page: Page, pathname: string, respond: (route: Route) => Promise<void>): Promise<void> {
  const isRequestedPath = (url: URL) => url.origin === api && url.pathname === pathname;
  await page.route(isRequestedPath, async (route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS });
    if (method === 'GET') return respond(route);
    return route.fallback();
  });
}

export const fulfillWithJson = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, headers: CORS_HEADERS, contentType: 'application/json', body: JSON.stringify(body) });

/** The state label of the open session in the right panel's Session tab; the sidebar lists one chip per session, so the page-wide test id is ambiguous. */
export const sessionStateLabel = (page: Page) => page.getByTestId('session-details').getByTestId('state-chip-label');

/** Size of an element as a user sees it: height and font size in px. */
export async function sizeOf(locator: ReturnType<Page['getByTestId']>): Promise<{ height: number; fontSize: number }> {
  return locator.evaluate((element) => ({ height: element.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(element).fontSize) }));
}
