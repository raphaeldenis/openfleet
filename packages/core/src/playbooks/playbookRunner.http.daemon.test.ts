import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createInMemorySecretStore, type InMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { SecretRefRepository } from '../secrets/secretRefRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { REAL_HTTP_STEP_NETWORK, type HttpStepNetwork } from './httpStepRequest.js';
import { PlaybookRepository } from './playbookRepository.js';

/*
 * Guards of the http cell, each with the test that fails when the guard is removed (replay: break the line, run this file and httpStepRequest.test.ts, restore).
 *  1. allowed host            httpStepRequest.ts `isHostAllowed` -> 'refuses a host the policy does not list', 'refuses every host when the policy lists none', 'refuses a policy stored before the allowed hosts existed'
 *  2. address filter          `answers.some(isForbiddenAddress)` in pinAddressOf -> 'refuses a host name that resolves to %s', 'refuses a host name when any one of its addresses is forbidden'
 *  3. pinned lookup           the `lookup` option in connectTo -> 'is resolved once and the connection goes to that very address'
 *  4. redirect refused        `isRedirect` -> 'refuses to follow a redirect, even to the same host'
 *  5. https only              schemeIsAcceptedFor -> 'reaches a public address over https only'
 *  6. first address only      `target: first` -> 'is resolved once ...' (the second answer of the DNS has no effect)
 *  7. safe headers            httpStepTemplates.ts header refusal -> 'refuses %s and sends nothing' (line break, Host, Content-Length)
 *  8. headers of the client   same table, 'a header the client sets itself' and 'a content length written by the cell'
 *  9. header cap              'refuses headers that grow past the cap once their tokens are resolved'
 * 10. templates               'refuses a secret in %s ...', 'never lets the output of a step into %s ...', 'refuses an input that moves the url to another host'
 * 11. output masking          'sends a secret in the authentication and masks it ...', 'masks the base64 form of a secret ...', 'keeps at most the cap of the response body'
 * 12. abort and deadline      'the deadline and the stop of a cell cover the DNS resolution ...' and, in httpStepRequest.test.ts, 'sendHttpStep while the name is being resolved'
 */
type RunView = {
  id: string; status: string; errorCode: string | null;
  steps: { seq: number; stepId: string; status: string; errorCode: string | null; output: { status?: number; output?: string } | null }[];
};
type SeenRequest = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
type Reply = (request: SeenRequest, response: ServerResponse) => void;

const directories = createTempDirTracker();
let fixture: GovernanceFixture | undefined;
let secretStore: InMemorySecretStore;
const fakeServers: Server[] = [];
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  for (const server of fakeServers.splice(0)) { server.closeAllConnections(); server.close(); }
  directories.removeAll();
});

const SECRET_NAME = 'API_KEY';
const LOOPBACK = '127.0.0.1';
const OUTPUT_CAP_CHARS = 256 * 1024;
const TRUNCATION_MARKER = '[truncated]';

/** A fake third-party server on the loopback; it records every request it receives. */
const listenFakeServer = async (reply: Reply) => {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const seenRequest: SeenRequest = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(seenRequest);
      reply(seenRequest, response);
    });
  });
  const connections = { opened: 0 };
  server.on('connection', () => { connections.opened += 1; });
  fakeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const port = (server.address() as { port: number }).port;
  return { seen, connections, port, origin: `http://${LOOPBACK}:${port}` };
};
const answer = (status: number, body: string): Reply => (_request, response) => { response.writeHead(status, { 'content-type': 'text/plain' }); response.end(body); };

const boot = async (httpNetwork?: HttpStepNetwork) => {
  secretStore = createInMemorySecretStore();
  fixture = await startGovernanceFixture({ playbooks: { scriptRoots: [directories.make('playbook-scripts-')], httpNetwork }, secrets: { store: secretStore } });
  return fixture;
};

const jsonOf = async <T>(response: Response) => await response.json() as T;
const httpCell = (id: string, url: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'http', method: 'GET', url, ...extra });
const createPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  jsonOf<{ id: string }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P', cells, ...extra }) }));
const approve = async (f: GovernanceFixture, playbookId: string) => {
  const { digest } = await jsonOf<{ digest: string }>(await f.api(`/api/playbooks/${playbookId}/approval`));
  return f.api(`/api/playbooks/${playbookId}/approve`, { method: 'POST', body: JSON.stringify({ digest }) });
};
const createApprovedPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
  const playbook = await createPlaybook(f, cells, extra);
  expect((await approve(f, playbook.id)).status).toBe(200);
  return playbook;
};
const viewOfRun = async (f: GovernanceFixture, runId: string) => jsonOf<RunView>(await f.api(`/api/playbook-runs/${runId}`));
const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (what: string, isDone: () => boolean | Promise<boolean>, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await isDone())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleepMs(25);
  }
};
const runToTheEnd = async (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown> = {}) => {
  const started = await f.api(`/api/playbooks/${playbookId}/run`, { method: 'POST', body: JSON.stringify({ inputs }) });
  expect(started.status).toBe(202);
  const { id } = await jsonOf<RunView>(started);
  await waitUntil('the run to end', async () => (await viewOfRun(f, id)).status !== 'running');
  return viewOfRun(f, id);
};
const everythingPersistedByRuns = (f: GovernanceFixture) =>
  JSON.stringify(['playbook_runs', 'playbook_run_steps', 'activity_log'].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()));
const allowing = (...allowedHosts: string[]) => ({ policy: { allowedHosts } });

describe('an http cell reaches only the hosts a human approved', () => {
  it('calls an allowed host and answers the status and the body of the response', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'hello from the fake'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/ping?x=1`)], allowing(LOOPBACK));

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'succeeded', steps: [{ stepId: 'call', status: 'succeeded', output: { status: 200, output: 'hello from the fake' } }] });
    expect(server.seen.map((request) => [request.method, request.url])).toEqual([['GET', '/ping?x=1']]);
  });

  it('refuses a host the policy does not list, and sends nothing', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'x'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`)], allowing('example.com'));

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_host_not_allowed' });
    expect(server.seen).toEqual([]);
  });

  it('refuses every host when the policy lists none', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'x'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`)]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_host_not_allowed' });
    expect(server.seen).toEqual([]);
  });

  it('refuses a policy stored before the allowed hosts existed, as a policy with no host', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'x'));
    new PlaybookRepository(f.db).insert({
      id: 'old-policy', projectId: OWN_PROJECT_ID, name: 'Old', inputs: [], agentLocked: false, origin: 'native', createdAt: 'now',
      policy: { browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 50 } as never, flow: { cells: [httpCell('call', `${server.origin}/`)] as never },
    });
    expect((await approve(f, 'old-policy')).status).toBe(200);

    const run = await runToTheEnd(f, 'old-policy');

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_host_not_allowed' });
    expect(server.seen).toEqual([]);
  });

  it('clears the approval when the allowed hosts change', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'x'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`)], allowing(LOOPBACK));
    await f.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, policy: { allowedHosts: [LOOPBACK, 'evil.example.com'] } }) });

    const refused = await f.api(`/api/playbooks/${playbook.id}/run`, { method: 'POST', body: JSON.stringify({ inputs: {} }) });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_unapproved' });
    expect(server.seen).toEqual([]);
  });

  it('refuses to follow a redirect, even to the same host, and never contacts the target', async () => {
    const f = await boot();
    const target = await listenFakeServer(answer(200, 'target'));
    const redirecting = await listenFakeServer((_request, response) => { response.writeHead(302, { location: `${target.origin}/landed` }); response.end(); });
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${redirecting.origin}/`)], allowing(LOOPBACK));

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_redirect_refused' });
    expect(target.seen).toEqual([]);
  });

  it('fails a response outside 2xx with http_status_failed and keeps its masked body for the journal', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(503, 'maintenance'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`)], allowing(LOOPBACK));

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_status_failed', steps: [{ output: { status: 503, output: 'maintenance' } }] });
  });

  it('fails with http_request_failed when nothing listens, without the text of the system error', async () => {
    const f = await boot();
    const closed = await listenFakeServer(answer(200, 'x'));
    fakeServers[0]!.close();
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${closed.origin}/`)], allowing(LOOPBACK));

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_request_failed' });
    expect(everythingPersistedByRuns(f)).not.toMatch(/ECONNREFUSED/);
  });

  it('fails with http_timeout when the server never answers within the timeout of the cell', async () => {
    const f = await boot();
    const server = await listenFakeServer(() => undefined);
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`, { timeoutSeconds: 1 })], allowing(LOOPBACK));

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_timeout' });
  });

  it('keeps at most the cap of the response body, whatever the server sends', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'a'.repeat(OUTPUT_CAP_CHARS * 2)));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`)], allowing(LOOPBACK));

    const run = await runToTheEnd(f, playbook.id);

    expect(run.status).toBe('succeeded');
    const output = run.steps[0]!.output!.output!;
    expect(output.length).toBeLessThanOrEqual(OUTPUT_CAP_CHARS + TRUNCATION_MARKER.length);
    expect(output.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('sends the method, the declared headers and the resolved body, and no cookie of its own', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'ok'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/items`, {
      method: 'POST', headers: { 'X-Kind': 'demo' }, body: '{"name":"{{inputs.name}}"}',
    })], { ...allowing(LOOPBACK), inputs: [{ name: 'name', type: 'string', required: true }] });

    await runToTheEnd(f, playbook.id, { name: 'robert' });

    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]).toMatchObject({ method: 'POST', url: '/items', body: '{"name":"robert"}', headers: { 'x-kind': 'demo' } });
    expect(server.seen[0]!.headers.cookie).toBeUndefined();
  });
});

describe('the address a host name resolves to', () => {
  const noForbiddenAddress: HttpStepNetwork['isForbiddenAddress'] = () => false;
  const networkAnswering = (answers: { address: string; family: 4 | 6 }[][], isForbiddenAddress = noForbiddenAddress) => {
    const lookups: string[] = [];
    const network: HttpStepNetwork = {
      isForbiddenAddress,
      resolveAddresses: async (hostname) => { lookups.push(hostname); return answers[Math.min(lookups.length - 1, answers.length - 1)]!; },
    };
    return { network, lookups };
  };

  it('is resolved once and the connection goes to that very address: a second answer of the DNS has no effect', async () => {
    const server = await listenFakeServer(answer(200, 'pinned'));
    const { network, lookups } = networkAnswering([[{ address: LOOPBACK, family: 4 }], [{ address: '203.0.113.9', family: 4 }]]);
    const f = await boot(network);
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `http://api.pinned.test:${server.port}/`)], allowing('api.pinned.test'));

    const run = await runToTheEnd(f, playbook.id);

    expect(run.status).toBe('succeeded');
    expect(lookups).toEqual(['api.pinned.test']);
    expect(server.seen[0]!.headers.host).toBe(`api.pinned.test:${server.port}`);
  });

  it.each([
    ['a loopback address', '127.0.0.2'], ['a private address', '10.1.2.3'], ['a link-local address (cloud metadata)', '169.254.169.254'],
    ['a shared address space', '100.64.0.1'], ['an IPv4 address mapped in IPv6', '::ffff:7f00:1'], ['a unique-local IPv6 address', 'fd00::1'],
  ])('refuses a host name that resolves to %s, and never connects', async (_label, address) => {
    const server = await listenFakeServer(answer(200, 'x'));
    const { network } = networkAnswering([[{ address, family: address.includes(':') ? 6 : 4 }]], REAL_HTTP_STEP_NETWORK.isForbiddenAddress);
    const f = await boot(network);
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `http://internal.example.test:${server.port}/`)], allowing('internal.example.test'));

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_address_blocked' });
    expect(server.seen).toEqual([]);
  });

  it('refuses a host name when any one of its addresses is forbidden', async () => {
    const { network } = networkAnswering([[{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]], REAL_HTTP_STEP_NETWORK.isForbiddenAddress);
    const f = await boot(network);
    const playbook = await createApprovedPlaybook(f, [httpCell('call', 'https://mixed.example.test/')], allowing('mixed.example.test'));

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_address_blocked' });
  });

  it('reaches a public address over https only: plain http to it is refused before any connection', async () => {
    const { network } = networkAnswering([[{ address: '93.184.216.34', family: 4 }]], REAL_HTTP_STEP_NETWORK.isForbiddenAddress);
    const f = await boot(network);
    const playbook = await createApprovedPlaybook(f, [httpCell('call', 'http://public.example.test/')], allowing('public.example.test'));

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_host_not_allowed' });
  });

  it('fails with http_request_failed when the name resolves to nothing', async () => {
    const { network } = networkAnswering([[]]);
    const f = await boot(network);
    const playbook = await createApprovedPlaybook(f, [httpCell('call', 'https://nowhere.example.test/')], allowing('nowhere.example.test'));

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_request_failed' });
  });
});

/** A clock the test drives by hand: a timer fires only when the test elapses its delay. */
const createManualClock = () => {
  let now = 0;
  let nextId = 0;
  const armed = new Map<number, { dueAt: number; delayMs: number; onElapsed: () => void }>();
  const startTimer: NonNullable<HttpStepNetwork['startTimer']> = (onElapsed, delayMs) => {
    const id = nextId++;
    armed.set(id, { dueAt: now + delayMs, delayMs, onElapsed });
    return () => { armed.delete(id); };
  };
  const elapse = (ms: number) => {
    now += ms;
    const due = [...armed].filter(([, timer]) => timer.dueAt <= now);
    for (const [id, timer] of due) { armed.delete(id); timer.onElapsed(); }
  };
  return { startTimer, elapse, armedDelays: () => [...armed.values()].map((timer) => timer.delayMs) };
};

/** A resolver whose first answer is held until the test releases it; every later lookup answers the loopback at once. */
const createStalledFirstResolver = () => {
  const lookups: string[] = [];
  let releaseFirstAnswer!: (answers: { address: string; family: 4 | 6 }[]) => void;
  const resolveAddresses: HttpStepNetwork['resolveAddresses'] = (hostname) => {
    lookups.push(hostname);
    const isFirstLookup = lookups.length === 1;
    if (!isFirstLookup) return Promise.resolve([{ address: LOOPBACK, family: 4 }]);
    return new Promise((resolve) => { releaseFirstAnswer = resolve; });
  };
  return { resolveAddresses, lookups, releaseFirstAnswer: (answers: { address: string; family: 4 | 6 }[]) => releaseFirstAnswer(answers) };
};

describe('the deadline and the stop of a cell cover the DNS resolution as much as the transport', () => {
  const GUARD_AGAINST_A_HANG_MS = 5_000;
  const CELL_TIMEOUT_SECONDS = 1;
  const FOUR_TIMES_THE_TIMEOUT_MS = 4 * CELL_TIMEOUT_SECONDS * 1000;

  const startWithAStalledResolver = async () => {
    const clock = createManualClock();
    const resolver = createStalledFirstResolver();
    const f = await boot({ resolveAddresses: resolver.resolveAddresses, isForbiddenAddress: () => false, startTimer: clock.startTimer });
    const server = await listenFakeServer(answer(200, 'reached'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `http://slow-dns.test:${server.port}/`, { timeoutSeconds: CELL_TIMEOUT_SECONDS })], allowing('slow-dns.test'));
    const started = await f.api(`/api/playbooks/${playbook.id}/run`, { method: 'POST', body: JSON.stringify({ inputs: {} }) });
    const { id: runId } = await jsonOf<RunView>(started);
    await waitUntil('the resolver to be asked', () => resolver.lookups.length === 1, GUARD_AGAINST_A_HANG_MS);
    return { f, clock, resolver, server, playbook, runId };
  };

  it('arms the deadline of the cell before the resolution starts', async () => {
    const { clock } = await startWithAStalledResolver();

    expect(clock.armedDelays()).toEqual([CELL_TIMEOUT_SECONDS * 1000]);
  });

  it('fails with http_timeout when the resolver stays silent for four times the timeout, and opens no connection', async () => {
    const { f, clock, server, runId } = await startWithAStalledResolver();

    clock.elapse(FOUR_TIMES_THE_TIMEOUT_MS);
    await waitUntil('the run to end', async () => (await viewOfRun(f, runId)).status !== 'running', GUARD_AGAINST_A_HANG_MS);

    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'failed', errorCode: 'http_timeout', steps: [{ status: 'failed', errorCode: 'http_timeout' }] });
    expect(server.connections.opened).toBe(0);
  });

  it('lets stop() return while the resolver is silent, and journals the step as needs_review', async () => {
    const { f, server, runId } = await startWithAStalledResolver();

    await f.daemon.playbookRunner.stop();

    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'needs_review', errorCode: 'interrupted', steps: [{ status: 'needs_review' }] });
    expect(server.connections.opened).toBe(0);
  });

  it('opens no connection when the resolver answers after the deadline, and the next run of the playbook is served normally', async () => {
    const { f, clock, resolver, server, playbook, runId } = await startWithAStalledResolver();
    clock.elapse(FOUR_TIMES_THE_TIMEOUT_MS);
    await waitUntil('the run to end', async () => (await viewOfRun(f, runId)).status !== 'running', GUARD_AGAINST_A_HANG_MS);

    resolver.releaseFirstAnswer([{ address: LOOPBACK, family: 4 }]);
    const nextRun = await runToTheEnd(f, playbook.id);

    expect(nextRun.status).toBe('succeeded');
    expect(server.connections.opened).toBe(1);
    expect(server.seen).toHaveLength(1);
  });
});

describe('what a request may carry', () => {
  const secretValue = `canary-${randomUUID()}`;

  it('sends a secret in the authentication and masks it where the server echoes it back, in the journal and the activity log', async () => {
    const f = await boot();
    const server = await listenFakeServer((request, response) => { response.writeHead(200); response.end(`you sent ${request.headers.authorization}`); });
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`, { auth: { type: 'bearer', token: `{{secret:${SECRET_NAME}}}` } })], allowing(LOOPBACK));
    await secretStore.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, secretValue);

    const run = await runToTheEnd(f, playbook.id);

    expect(server.seen[0]!.headers.authorization).toBe(`Bearer ${secretValue}`);
    expect(run.steps[0]!.output!.output).toMatch(/^you sent Bearer (\*\*\*|\[secret:API_KEY\])$/);
    expect(everythingPersistedByRuns(f)).not.toContain(secretValue);
  });

  it('sends a secret in a header and in a basic authentication', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'ok'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`, {
      headers: { 'X-Api-Key': `{{secret:${SECRET_NAME}}}` }, auth: { type: 'basic', username: 'bot', password: `{{secret:${SECRET_NAME}}}` },
    })], allowing(LOOPBACK));
    await secretStore.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, secretValue);

    await runToTheEnd(f, playbook.id);

    expect(server.seen[0]!.headers['x-api-key']).toBe(secretValue);
    expect(server.seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`bot:${secretValue}`).toString('base64')}`);
  });

  it('masks the base64 form of a secret that the server echoes', async () => {
    const f = await boot();
    const server = await listenFakeServer((request, response) => { response.writeHead(200); response.end(Buffer.from(String(request.headers['x-api-key'])).toString('base64')); });
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`, { headers: { 'X-Api-Key': `{{secret:${SECRET_NAME}}}` } })], allowing(LOOPBACK));
    await secretStore.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, secretValue);

    const run = await runToTheEnd(f, playbook.id);

    expect(everythingPersistedByRuns(f)).not.toContain(secretValue);
    expect(everythingPersistedByRuns(f)).not.toContain(Buffer.from(secretValue).toString('base64'));
    expect(run.steps[0]!.output!.output).toMatch(/^\[secret:API_KEY\]=*$/);
  });

  it.each([
    ['the body', (origin: string) => ({ url: `${origin}/`, extra: { method: 'POST', body: `{{secret:${SECRET_NAME}}}` } })],
    ['the path of the url', (origin: string) => ({ url: `${origin}/items/{{secret:${SECRET_NAME}}}`, extra: { method: 'GET' } })],
    ['the query of the url', (origin: string) => ({ url: `${origin}/items?key={{secret:${SECRET_NAME}}}`, extra: { method: 'GET' } })],
  ])('refuses a secret in %s for a flow stored outside the save path, and sends nothing', async (_label, cellOf) => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'x'));
    const { url, extra } = cellOf(server.origin);
    new PlaybookRepository(f.db).insert({
      id: 'secret-misplaced', projectId: OWN_PROJECT_ID, name: 'Outside', inputs: [], agentLocked: false, origin: 'native', createdAt: 'now',
      policy: { allowedHosts: [LOOPBACK], browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 50 },
      flow: { cells: [httpCell('call', url, extra)] as never },
    });
    new SecretRefRepository(f.db).declare({ kind: 'playbook', id: 'secret-misplaced' }, SECRET_NAME);
    await secretStore.set({ kind: 'playbook', id: 'secret-misplaced' }, SECRET_NAME, secretValue);
    expect((await approve(f, 'secret-misplaced')).status).toBe(200);

    const run = await runToTheEnd(f, 'secret-misplaced');

    expect(run).toMatchObject({ status: 'failed', errorCode: 'secret_not_allowed_here' });
    expect(server.seen).toEqual([]);
  });

  it.each([
    ['the authority of the url', (_origin: string, port: number) => ({ url: `http://{{steps.first.output}}:${port}/`, extra: {} })],
    ['a header', (origin: string, _port: number) => ({ url: `${origin}/`, extra: { headers: { 'X-From': '{{steps.first.output}}' } } })],
    ['the bearer token of the authentication', (origin: string, _port: number) => ({ url: `${origin}/`, extra: { auth: { type: 'bearer', token: '{{steps.first.output}}' } } })],
  ])('never lets the output of a step into %s, for a flow stored outside the save path', async (_label, secondCellOf) => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, '127.0.0.1'));
    const { url, extra } = secondCellOf(server.origin, server.port);
    new PlaybookRepository(f.db).insert({
      id: 'untrusted-reference', projectId: OWN_PROJECT_ID, name: 'Outside', inputs: [], agentLocked: false, origin: 'native', createdAt: 'now',
      policy: { allowedHosts: [LOOPBACK], browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 50 },
      flow: { cells: [httpCell('first', `${server.origin}/`), httpCell('second', url, extra)] as never },
    });
    expect((await approve(f, 'untrusted-reference')).status).toBe(200);

    const run = await runToTheEnd(f, 'untrusted-reference');

    expect(run).toMatchObject({ status: 'failed', errorCode: 'untrusted_reference' });
    expect(server.seen).toHaveLength(1);
  });

  it('lets the output of a step into the path and the body, where it cannot steer the request elsewhere', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'token-42'));
    new PlaybookRepository(f.db).insert({
      id: 'untrusted-body', projectId: OWN_PROJECT_ID, name: 'Outside', inputs: [], agentLocked: false, origin: 'native', createdAt: 'now',
      policy: { allowedHosts: [LOOPBACK], browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 50 },
      flow: { cells: [httpCell('first', `${server.origin}/`), httpCell('second', `${server.origin}/items/{{steps.first.output}}`, { method: 'POST', body: '{{steps.first.output}}' })] as never },
    });
    expect((await approve(f, 'untrusted-body')).status).toBe(200);

    const run = await runToTheEnd(f, 'untrusted-body');

    expect(run.status).toBe('succeeded');
    expect(server.seen[1]).toMatchObject({ url: '/items/token-42', body: 'token-42' });
  });

  it.each([
    ['a line break in a header', { 'X-Note': '{{inputs.note}}' }, 'header_injection'],
    ['a header the client sets itself', { Host: 'other.example.com' }, 'http_header_refused'],
    ['a content length written by the cell', { 'Content-Length': '0' }, 'http_header_refused'],
  ])('refuses %s and sends nothing', async (_label, headers, errorCode) => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'x'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`, { headers })], { ...allowing(LOOPBACK), inputs: [{ name: 'note', type: 'string' }] });

    const run = await runToTheEnd(f, playbook.id, { note: 'a\r\nX-Injected: 1' });

    expect(run).toMatchObject({ status: 'failed', errorCode });
    expect(server.seen).toEqual([]);
  });

  it('refuses headers that grow past the cap once their tokens are resolved', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'x'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`, { headers: { 'X-Big': '{{inputs.big}}' } })],
      { ...allowing(LOOPBACK), inputs: [{ name: 'big', type: 'string' }] });

    const run = await runToTheEnd(f, playbook.id, { big: 'a'.repeat(20_000) });

    expect(run).toMatchObject({ status: 'failed', errorCode: 'http_headers_too_large' });
    expect(server.seen).toEqual([]);
  });

  it('refuses an input that moves the url to another host', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'x'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `http://{{inputs.host}}:${server.port}/`)], { ...allowing(LOOPBACK), inputs: [{ name: 'host', type: 'string' }] });

    const run = await runToTheEnd(f, playbook.id, { host: `${LOOPBACK}@evil.example.com` });

    expect(run.status).toBe('failed');
    expect(server.seen).toEqual([]);
  });
});

describe('a daemon that stops during an http step', () => {
  it('journals the step as needs_review and never sends the request again', async () => {
    const f = await boot();
    const server = await listenFakeServer(() => undefined);
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`)], allowing(LOOPBACK));
    const started = await f.api(`/api/playbooks/${playbook.id}/run`, { method: 'POST', body: JSON.stringify({ inputs: {} }) });
    const { id } = await jsonOf<RunView>(started);
    await waitUntil('the request to arrive', () => server.seen.length === 1);

    await f.daemon.playbookRunner.stop();
    const run = await viewOfRun(f, id);

    expect(run).toMatchObject({ status: 'needs_review', errorCode: 'interrupted' });
    expect(run.steps.map((step) => step.status)).toEqual(['needs_review']);
    expect(server.seen).toHaveLength(1);
  });

  it('marks a run found running at boot needs_review and sends nothing: the effect may have happened', async () => {
    const f = await boot();
    const server = await listenFakeServer(answer(200, 'x'));
    const playbook = await createApprovedPlaybook(f, [httpCell('call', `${server.origin}/`)], allowing(LOOPBACK));
    f.db.prepare(`INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at) VALUES ('crashed', ?, 1, 'x', 'running', '{}', 'admin', 'now')`).run(playbook.id);
    f.db.prepare(`INSERT INTO playbook_run_steps (run_id, seq, step_id, status, started_at) VALUES ('crashed', 1, 'call', 'running', 'now')`).run();

    const interrupted = f.daemon.playbookRunner.recover();
    const run = await viewOfRun(f, 'crashed');

    expect(interrupted).toBe(1);
    expect(run).toMatchObject({ status: 'needs_review', errorCode: 'interrupted' });
    expect(server.seen).toEqual([]);
  });
});
