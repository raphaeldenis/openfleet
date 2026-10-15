import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { loadManagerBase, parseManagerBase } from './managerBase.js';
import { lintManagerBase } from './managerBaseLint.testkit.js';

const SHIPPED_BASE_URL = new URL('../../templates/manager/base.md', import.meta.url);
const SHIPPED_SHA_URL = new URL('../../templates/manager/base.sha256', import.meta.url);
const TARGET_BYTES = 6144;
const MAX_BYTES = 8192;
const SECTION_COUNT = 10;

// A shipped version is immutable: managers already read it by (version, sha). A body change means a new version
// and a new line here; editing a line below means a shipped version was edited, which is never allowed.
const RELEASED_BASE_SHAS: Record<number, string> = {
  1: '4ee6ed1d031e912d825972627a8e759ea881218bcd33f4f9609e6c066daa56a6',
  2: 'fe4afd8ff81625b6ff76711c059222f817472fe3c2a4f6e0daa291c13a7a077c',
};

const tempDirs = createTempDirTracker();
let daemon: Daemon;
let registeredToolNames: ReadonlySet<string>;
const shippedSource = () => readFileSync(SHIPPED_BASE_URL, 'utf8');
const lint = (source: string) => lintManagerBase({ source, bodyBytes: parseManagerBase(source).bytes, registeredToolNames });

beforeAll(async () => {
  const config: Config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-base-lint-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
  const created = await fetch(`${daemon.server.url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` }, body: JSON.stringify({ directory: '/tmp', name: 'Root', harness: 'fake', emoji: '🧭' }) });
  const { id } = (await created.json()) as { id: string };
  const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(id) as { mcp_token: string };
  const client = new Client({ name: 'base-lint', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
  registeredToolNames = new Set((await client.listTools()).tools.map((tool) => tool.name));
  await client.close();
});
afterAll(async () => {
  await daemon.close();
  tempDirs.removeAll();
});

describe('the shipped manager base', () => {
  it('breaks none of the delivery rules', () => {
    expect(lint(shippedSource())).toEqual([]);
  });

  it('has the ten sections §1 to §10 in order', () => {
    expect(loadManagerBase().sections.map((section) => section.id)).toEqual(Array.from({ length: SECTION_COUNT }, (_, index) => `§${index + 1}`));
  });

  it('stays within the byte budget', () => {
    const { bytes } = loadManagerBase();

    expect(bytes).toBeLessThanOrEqual(TARGET_BYTES);
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('carries the sha of its body in base.sha256', () => {
    expect(readFileSync(SHIPPED_SHA_URL, 'utf8').trim()).toBe(loadManagerBase().sha);
  });

  it('keeps the released sha of its version: a changed body needs a bumped version', () => {
    const { version, sha } = loadManagerBase();

    expect(RELEASED_BASE_SHAS[version], `version ${version} is not recorded in RELEASED_BASE_SHAS, or its body changed without a version bump`).toBe(sha);
  });

  it('cites only tools the real daemon registers', () => {
    expect(registeredToolNames.has('get_argus_status')).toBe(true);
    expect(registeredToolNames.has('get_manager_base')).toBe(true);
  });

  it('tells the manager to read the base with get_manager_base, whole, after a reset and on a version change', () => {
    const source = shippedSource();

    expect(source).toContain('`get_manager_base`');
    expect(source).toMatch(/Read this base again with `get_manager_base`, whole\./);
    expect(source).toMatch(/again after every reset \(§4\) or when its version changes/);
  });
});

describe('the delivery lint', () => {
  it.each([
    "QA is the human's job.",
    'QA = travail de l\'humain.',
    'The tests are for the human to run.',
  ])('fails when the base says: %s', (sentence) => {
    expect(lint(`${shippedSource()}\n${sentence}\n`)).not.toEqual([]);
  });

  it.each(['Spawn at most 2 children.', 'Spawn 3 children.', 'Keep a cap of 8.', 'cap = 4', 'Spawn 3 enfants.'])('fails when the base writes a children cap: %s', (sentence) => {
    expect(lint(`${shippedSource()}\n${sentence}\n`)).not.toEqual([]);
  });

  it('fails when the base names an exact model id', () => {
    expect(lint(`${shippedSource()}\nUse claude-sonnet-5-5 for review.\n`)).not.toEqual([]);
  });

  it('fails when the base cites a tool the daemon does not register', () => {
    expect(lint(`${shippedSource()}\nCall \`get_unicorn_status\` first.\n`)).toEqual([expect.stringContaining('get_unicorn_status')]);
  });

  it('fails when the body is over 8192 bytes', () => {
    expect(lint(`${shippedSource()}\n${'x'.repeat(MAX_BYTES)}\n`)).toEqual([expect.stringContaining('over 8192')]);
  });
});
