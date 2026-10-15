import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { parseManagerBase } from '../managers/managerBase.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const SHIPPED_BASE_URL = new URL('../../templates/manager/base.md', import.meta.url);
const WHOLE_BASE_RESULT_BUDGET_BYTES = 8192 + 2048;
const SECTION_COUNT = 10;

const tempDirs = createTempDirTracker();
let daemon: Daemon;
let managerClient: Client;
let plainChildClient: Client;

const shippedBase = () => parseManagerBase(readFileSync(SHIPPED_BASE_URL, 'utf8'));
const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const payloadOf = (result: unknown) => JSON.parse(textOf(result)) as { version: number; sha: string; bytes: number; sections: { id: string; title: string; type: string; bytes: number }[]; body: string };
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const getManagerBase = (client: Client, args: Record<string, unknown> = {}) => client.callTool({ name: 'get_manager_base', arguments: args });

async function connectedClient(config: Config, sessionBody: Record<string, unknown>): Promise<Client> {
  const created = await fetch(`${daemon.server.url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` }, body: JSON.stringify({ directory: '/tmp', harness: 'fake', emoji: '🧭', ...sessionBody }) });
  const { id } = (await created.json()) as { id: string };
  const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(id) as { mcp_token: string };
  const client = new Client({ name: 'base-tool', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
  return client;
}

beforeAll(async () => {
  const config: Config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-base-tool-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
  managerClient = await connectedClient(config, { name: 'Lead', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Ship' } });
  plainChildClient = await connectedClient(config, { name: 'Gimli' });
});
afterAll(async () => {
  await managerClient.close();
  await plainChildClient.close();
  await daemon.close();
  tempDirs.removeAll();
});

describe('get_manager_base', () => {
  it('is published with an optional section input', async () => {
    const tool = (await managerClient.listTools()).tools.find((candidate) => candidate.name === 'get_manager_base');

    expect(tool?.description).toBeTruthy();
    expect(Object.keys((tool?.inputSchema.properties ?? {}) as object)).toEqual(['section']);
    expect(tool?.inputSchema.required ?? []).not.toContain('section');
  });

  it('gives a manager the whole body and the list of its sections', async () => {
    const shipped = shippedBase();

    const payload = payloadOf(await getManagerBase(managerClient));

    expect(payload.body).toBe(shipped.body);
    expect(payload.sections.map((section) => section.id)).toEqual(Array.from({ length: SECTION_COUNT }, (_, index) => `§${index + 1}`));
    expect(payload.sections[4]).toEqual({ id: '§5', title: 'Children', type: 'default', bytes: expect.any(Number) });
  });

  it('carries the version and the sha of the body it returns', async () => {
    const shipped = shippedBase();

    const payload = payloadOf(await getManagerBase(managerClient));

    expect(payload.version).toBe(shipped.version);
    expect(payload.sha).toBe(shipped.sha);
    expect(payload.sha).toBe(sha256(payload.body));
    expect(payload.bytes).toBe(Buffer.byteLength(payload.body, 'utf8'));
  });

  it('does not truncate the whole body and stays within the result budget', async () => {
    const result = await getManagerBase(managerClient);

    expect(payloadOf(result).body).toBe(shippedBase().body);
    expect(Buffer.byteLength(textOf(result), 'utf8')).toBeLessThanOrEqual(WHOLE_BASE_RESULT_BUDGET_BYTES);
  });

  it('returns only the asked section', async () => {
    const payload = payloadOf(await getManagerBase(managerClient, { section: '§5' }));

    expect(payload.body.startsWith('## §5 Children [default]')).toBe(true);
    expect(payload.body).not.toContain('## §4');
    expect(payload.body).not.toContain('## §6');
    expect(payload.body.length).toBeLessThan(shippedBase().body.length / 2);
  });

  it('keeps the version and the sha of the whole base on a section', async () => {
    const shipped = shippedBase();

    const payload = payloadOf(await getManagerBase(managerClient, { section: '§5' }));

    expect([payload.version, payload.sha]).toEqual([shipped.version, shipped.sha]);
  });

  it('refuses an unknown section with invalid_body and lists the valid ids', async () => {
    const result = await getManagerBase(managerClient, { section: '§99' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('invalid_body');
    expect(textOf(result)).toContain('§1');
    expect(textOf(result)).toContain('§10');
  });

  it('refuses a session that is not a manager with not_a_manager and gives no text', async () => {
    const result = await getManagerBase(plainChildClient);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not_a_manager');
    expect(textOf(result)).not.toContain('## §1');
  });

  it('refuses a session that is not a manager even for a section', async () => {
    const result = await getManagerBase(plainChildClient, { section: '§5' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not_a_manager');
  });
});
