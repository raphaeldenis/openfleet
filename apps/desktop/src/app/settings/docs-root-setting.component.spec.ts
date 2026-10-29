import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocsRootSettingComponent } from './docs-root-setting.component';

const DEFAULT_ROOT = '/Users/me/Documents/OpenFleet';

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refusal(code: string, kind: string, retry: string): Response {
  return answer({ error: code, kind, retry, message: 'the docs root cannot be used.' }, kind === 'conflict' ? 409 : 400);
}

async function renderDocsRootRow(daemon: (request: { method: string; body?: unknown }) => Response | Promise<Response>) {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ method, path: new URL(url).pathname, body });
    return Promise.resolve(daemon({ method, body }));
  }));
  const view = await render(DocsRootSettingComponent);
  return { ...view, requests, user: userEvent.setup() };
}

describe('Settings → General → Docs folder root', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the daemon root in an enabled field', async () => {
    await renderDocsRootRow(() => answer({ root: DEFAULT_ROOT, isDefault: true }));

    const field = await screen.findByRole('textbox', { name: 'Docs folder root' });

    expect(field).toBeEnabled();
    expect(field).toHaveValue(DEFAULT_ROOT);
    expect(screen.queryByText(/Not configurable in this build yet/)).not.toBeInTheDocument();
  });

  it('saves the typed root and shows the root the daemon stored', async () => {
    const { user, requests } = await renderDocsRootRow(({ method }) =>
      method === 'PATCH' ? answer({ root: '/Users/me/Work/docs', isDefault: false }) : answer({ root: DEFAULT_ROOT, isDefault: true }),
    );
    const field = await screen.findByRole('textbox', { name: 'Docs folder root' });

    await user.clear(field);
    await user.type(field, '/Users/me/Work/docs');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('general-docs-root-saved')).toHaveTextContent('Saved');
    expect(field).toHaveValue('/Users/me/Work/docs');
    expect(requests.filter(({ method }) => method === 'PATCH')).toEqual([{ method: 'PATCH', path: '/api/settings/docs-root', body: { root: '/Users/me/Work/docs' } }]);
  });

  it('does not send anything while the field still holds the saved root', async () => {
    const { user, requests } = await renderDocsRootRow(() => answer({ root: DEFAULT_ROOT, isDefault: true }));
    await screen.findByRole('textbox', { name: 'Docs folder root' });

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(requests.filter(({ method }) => method === 'PATCH')).toEqual([]);
  });

  it.each([
    ['docs_root_invalid', 'invalid_request', 'never', 'That docs root cannot be used — give an absolute path inside your home folder.'],
    ['docs_root_forbidden', 'invalid_request', 'never', 'That docs root is a folder OpenFleet or its tools keep for themselves — pick another folder.'],
    ['docs_root_not_writable', 'conflict', 'later', 'That docs root is not writable — fix the folder permissions, then try again.'],
  ])('tells why the daemon refused (%s) and keeps what was typed', async (code, kind, retry, expectedText) => {
    const { user } = await renderDocsRootRow(({ method }) =>
      method === 'PATCH' ? refusal(code, kind, retry) : answer({ root: DEFAULT_ROOT, isDefault: true }),
    );
    const field = await screen.findByRole('textbox', { name: 'Docs folder root' });

    await user.clear(field);
    await user.type(field, '/Users/me/.claude');
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(expectedText);
    expect(field).toHaveValue('/Users/me/.claude');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('is drawn disabled, with the reason, when the daemon does not return a root', async () => {
    await renderDocsRootRow(() => answer({}));

    expect(await screen.findByText(/the daemon did not return the docs folder root/)).toBeVisible();
    expect(screen.getByTestId('general-docs-root')).toBeDisabled();
  });
});
