import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

describe('FleetApiService notes', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;

  function lastRequest() {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url: new URL(url), init };
  }

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the projects the notes are scoped to', async () => {
    const page = { items: [{ id: 'p1', name: 'OpenFleet', docsFolderPath: '/docs' }], total: 1, limit: 100, offset: 0 };
    fetchMock.mockResolvedValue(jsonResponse(200, page));

    await expect(api.listProjects()).resolves.toEqual(page);

    expect(lastRequest().url.pathname).toBe('/api/projects');
    expect(lastRequest().init.method ?? 'GET').toBe('GET');
  });

  it('lists the notes of a project', async () => {
    await api.listNotes('p 1');

    expect(lastRequest().url.pathname).toBe('/api/notes');
    expect(lastRequest().url.searchParams.get('projectId')).toBe('p 1');
  });

  it('reads one note within its project', async () => {
    await api.getNote('p1', 'n/1');

    expect(lastRequest().url.pathname).toBe('/api/notes/n%2F1');
    expect(lastRequest().url.searchParams.get('projectId')).toBe('p1');
  });

  it('creates a note with a POST carrying the project in the body', async () => {
    await api.createNote({ projectId: 'p1', title: 'voice', bodyMd: 'hello' });

    expect(lastRequest().url.pathname).toBe('/api/notes');
    expect(lastRequest().init.method).toBe('POST');
    expect(JSON.parse(lastRequest().init.body as string)).toEqual({ projectId: 'p1', title: 'voice', bodyMd: 'hello' });
  });

  it('updates a note against the revision the user last saw', async () => {
    await api.updateNote('p1', 'n1', { expectedRev: 3, bodyMd: 'new body' });

    expect(lastRequest().url.pathname).toBe('/api/notes/n1');
    expect(lastRequest().url.searchParams.get('projectId')).toBe('p1');
    expect(lastRequest().init.method).toBe('PATCH');
    expect(JSON.parse(lastRequest().init.body as string)).toEqual({ expectedRev: 3, bodyMd: 'new body' });
  });

  it('reports a stale revision as a 409 the caller can recognise', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'stale_revision', currentRev: 5 }));

    await expect(api.updateNote('p1', 'n1', { expectedRev: 3, bodyMd: 'x' })).rejects.toMatchObject({ status: 409, code: 'stale_revision' });
  });

  it('searches the notes of a project', async () => {
    await api.searchNotes('p1', 'reconnect backoff');

    expect(lastRequest().url.pathname).toBe('/api/notes/search');
    expect(lastRequest().url.searchParams.get('projectId')).toBe('p1');
    expect(lastRequest().url.searchParams.get('q')).toBe('reconnect backoff');
  });

  it('lists the versions of a note', async () => {
    await api.listNoteVersions('p1', 'n1');

    expect(lastRequest().url.pathname).toBe('/api/notes/n1/versions');
    expect(lastRequest().url.searchParams.get('projectId')).toBe('p1');
  });

  it('restores a version by its revision', async () => {
    await api.restoreNoteVersion('p1', 'n1', { rev: 2, expectedRev: 4 });

    expect(lastRequest().url.pathname).toBe('/api/notes/n1/restore');
    expect(lastRequest().init.method).toBe('POST');
    expect(JSON.parse(lastRequest().init.body as string)).toEqual({ projectId: 'p1', rev: 2, expectedRev: 4 });
  });
});
