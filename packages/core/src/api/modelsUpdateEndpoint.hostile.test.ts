import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE, loadModelTable } from '../models.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { createMcpHandler } from '../mcp/mcpServer.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';
import { newId } from '../ids.js';
import { startServer } from './server.js';

// Black-box hostile tests for PUT /api/models: REST in and out, config.json on disk, nothing private.

const ADMIN_TOKEN = 'admin';
const AUTHORIZED = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
const RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let homeDirectory: string;
let configPath: string;

async function startDaemon(modelConfigPath: string) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const modelTable = loadModelTable(modelConfigPath);
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => new Date().toISOString(), newId });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString() });
  const mcp = createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }), worktreesRoot: '/tmp/of-wt' });
  return startServer({ host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath, mcp });
}

beforeEach(async () => {
  homeDirectory = mkdtempSync(join(tmpdir(), 'of-models-hostile-'));
  configPath = join(homeDirectory, 'config.json');
  server = await startDaemon(configPath);
});

afterEach(async () => {
  await server.close();
  rmSync(homeDirectory, { recursive: true, force: true });
});

const putRaw = (rawBody: string | undefined) => fetch(`${server.url}/api/models`, { method: 'PUT', headers: AUTHORIZED, body: rawBody });
const putModels = (body: unknown) => putRaw(JSON.stringify(body));
const getModels = async () => (await (await fetch(`${server.url}/api/models`, { headers: AUTHORIZED })).json()) as Record<string, string>;
const readConfigFile = () => JSON.parse(readFileSync(configPath, 'utf8')) as { models?: Record<string, string> };

async function expectRefusedAndNothingChanged(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(await getModels()).toEqual(DEFAULT_MODEL_TABLE);
  expect(readdirSync(homeDirectory)).toEqual([]);
}

describe('PUT /api/models — hostile bodies', () => {
  it('refuses a __proto__ key next to a valid rung with a 400, pollutes no prototype and changes nothing', async () => {
    const res = await putRaw('{"opus":"claude-opus-5-5","__proto__":{"polluted":"yes"}}');

    await expectRefusedAndNothingChanged(res, 400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).opus).toBeUndefined();
  });

  it.each([
    ['a Cyrillic look-alike letter', 'claude-оpus-5-5'],
    ['a zero-width space inside', 'claude-opus​-5-5'],
    ['a newline inside', 'claude-opus\n-5-5'],
    ['a slash (path traversal shaped)', 'claude-opus/../../etc/passwd'],
  ])('refuses an id with %s, since the id ends up on the claude command line', async (_label, modelId) => {
    const res = await putModels({ opus: modelId });

    await expectRefusedAndNothingChanged(res, 400);
  });

  it('refuses a request with no body at all', async () => {
    const res = await putRaw(undefined);

    await expectRefusedAndNothingChanged(res, 400);
  });

  it('refuses a body larger than the daemon accepts with a 413 and changes nothing', async () => {
    const oversizedBody = JSON.stringify({ opus: 'a'.repeat(2 * 1024 * 1024) });

    const res = await putRaw(oversizedBody);

    await expectRefusedAndNothingChanged(res, 413);
  });

  it('answers a body that is not JSON with a 400, not a 500', async () => {
    const res = await putRaw('{"opus": ');

    expect(res.status).toBe(400);
  });

  it('refuses a flag-shaped id', async () => {
    const res = await putModels({ opus: '-x' });

    await expectRefusedAndNothingChanged(res, 400);
  });
});

describe('PUT /api/models — concurrency and round trip', () => {
  it('keeps every rung of a burst of concurrent PUTs, memory and disk agreeing, while GETs interleave', async () => {
    const sentIds = Object.fromEntries(RUNGS.map((rung) => [rung, [] as string[]]));
    const requests = Array.from({ length: 20 }, (_, index) => {
      const rung = RUNGS[index % RUNGS.length]!;
      const modelId = `claude-${rung}-burst-${index}`;
      sentIds[rung]!.push(modelId);
      return [putModels({ [rung]: modelId }), getModels()] as const;
    }).flat();

    const settled = await Promise.all(requests);

    const puts = settled.filter((answer): answer is Response => answer instanceof Response);
    expect(puts.map((res) => res.status)).toEqual(Array(20).fill(200));
    const table = await getModels();
    expect(readConfigFile().models).toEqual(table);
    for (const rung of RUNGS) expect(sentIds[rung]).toContain(table[rung]);
    expect(readdirSync(homeDirectory)).toEqual(['config.json']);
    for (const seen of settled.filter((answer): answer is Record<string, string> => !(answer instanceof Response))) {
      expect(Object.keys(seen).sort()).toEqual([...RUNGS].sort());
    }
  });

  it('never rewrites the defaults a daemon without a config file falls back to', async () => {
    const defaultsBeforeThePut = { ...DEFAULT_MODEL_TABLE };

    await putModels({ opus: 'changed-at-runtime' });

    const tableOfADaemonWithoutConfig = loadModelTable(join(homeDirectory, 'nonexistent.json'));
    expect(tableOfADaemonWithoutConfig).toEqual(defaultsBeforeThePut);
    expect(tableOfADaemonWithoutConfig).not.toBe(DEFAULT_MODEL_TABLE);
    expect(DEFAULT_MODEL_TABLE).toEqual(defaultsBeforeThePut);
  });

  it('writes a file a daemon restart reads back as exactly the table it served', async () => {
    await putModels({ opus: '  claude-opus-9  ', haiku: 'claude-haiku-4-5-20251001' });

    expect(loadModelTable(configPath)).toEqual(await getModels());
  });
});

describe('PUT /api/models — config.json in a hostile state', () => {
  it.each([
    ['an empty file', ''],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a JSON string', '"models"'],
    ['a null models entry', '{"models":null}'],
    ['an array models entry', '{"models":[]}'],
    ['a truncated file', '{"models":{"opus":'],
  ])('answers 409 and leaves %s byte-for-byte untouched, with no temp file', async (_label, content) => {
    writeFileSync(configPath, content);

    const res = await putModels({ opus: 'claude-opus-5-5-b' });

    expect(res.status).toBe(409);
    expect(readFileSync(configPath, 'utf8')).toBe(content);
    expect(readdirSync(homeDirectory)).toEqual(['config.json']);
    expect(await getModels()).toEqual(DEFAULT_MODEL_TABLE);
  });

  it('answers 409, not a crash, when config.json is a directory, and leaves the directory alone', async () => {
    mkdirSync(join(configPath, 'inner'), { recursive: true });

    const res = await putModels({ opus: 'claude-opus-5-5-b' });

    expect(res.status).toBe(409);
    expect(lstatSync(configPath).isDirectory()).toBe(true);
    expect(readdirSync(homeDirectory)).toEqual(['config.json']);
    expect(await getModels()).toEqual(DEFAULT_MODEL_TABLE);
  });

  it.skipIf(process.getuid?.() === 0)('answers 500, keeps the served table and leaves no temp file when the home directory is not writable', async () => {
    chmodSync(homeDirectory, 0o500);
    try {
      const res = await putModels({ opus: 'claude-opus-5-5-b' });

      expect(res.status).toBe(500);
      expect(await getModels()).toEqual(DEFAULT_MODEL_TABLE);
      expect(readdirSync(homeDirectory)).toEqual([]);
    } finally {
      chmodSync(homeDirectory, 0o700);
    }
  });

  // macOS only: an immutable file is readable but cannot be replaced, so the write succeeds and the final
  // rename is the step that fails — the only black-box way to reach the temp-file cleanup path.
  it.runIf(process.platform === 'darwin')('removes its temp file when the final swap fails', async () => {
    writeFileSync(configPath, '{"theme":"dark"}');
    execFileSync('chflags', ['uchg', configPath]);
    try {
      const res = await putModels({ opus: 'claude-opus-5-5-b' });

      expect(res.status).toBe(500);
      expect(readdirSync(homeDirectory)).toEqual(['config.json']);
      expect(readFileSync(configPath, 'utf8')).toBe('{"theme":"dark"}');
      expect(await getModels()).toEqual(DEFAULT_MODEL_TABLE);
    } finally {
      execFileSync('chflags', ['nouchg', configPath]);
    }
  });

  it('never writes through a symlink planted at the temp file name a previous release used', async () => {
    const victimDirectory = mkdtempSync(join(tmpdir(), 'of-models-victim-'));
    const victimPath = join(victimDirectory, 'victim.txt');
    writeFileSync(victimPath, 'precious');
    chmodSync(victimPath, 0o644);
    const plantedLinkPath = `${configPath}.${process.pid}.tmp`;
    symlinkSync(victimPath, plantedLinkPath);
    try {
      const res = await putModels({ opus: 'claude-opus-5-5-b' });

      expect(res.status).toBe(200);
      expect(readFileSync(victimPath, 'utf8')).toBe('precious');
      expect(statSync(victimPath).mode & 0o777).toBe(0o644);
      expect(readlinkSync(plantedLinkPath)).toBe(victimPath);
      expect(readConfigFile()).toEqual({ models: { opus: 'claude-opus-5-5-b' } });
    } finally {
      rmSync(victimDirectory, { recursive: true, force: true });
    }
  });

  it('keeps the permissions of the config.json it rewrites', async () => {
    writeFileSync(configPath, '{"theme":"dark"}');
    chmodSync(configPath, 0o600);

    await putModels({ opus: 'claude-opus-5-5-b' });

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('writes through a symlinked config.json instead of replacing the link', async () => {
    const realConfigPath = join(homeDirectory, 'dotfiles-config.json');
    writeFileSync(realConfigPath, '{"theme":"dark"}');
    symlinkSync(realConfigPath, configPath);

    await putModels({ opus: 'claude-opus-5-5-b' });

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configPath)).toBe(realConfigPath);
    expect(JSON.parse(readFileSync(realConfigPath, 'utf8'))).toEqual({ theme: 'dark', models: { opus: 'claude-opus-5-5-b' } });
  });

  it('refuses with a 409 and does not overwrite a config.json the user made read-only', async () => {
    writeFileSync(configPath, '{"theme":"dark"}');
    chmodSync(configPath, 0o444);

    const res = await putModels({ opus: 'claude-opus-5-5-b' });

    expect(res.status).toBe(409);
    expect(readFileSync(configPath, 'utf8')).toBe('{"theme":"dark"}');
    expect(statSync(configPath).mode & 0o777).toBe(0o444);
    expect(readdirSync(homeDirectory)).toEqual(['config.json']);
    expect(await getModels()).toEqual(DEFAULT_MODEL_TABLE);
  });

  it('gives a config.json it creates the private mode 0600', async () => {
    await putModels({ opus: 'claude-opus-5-5-b' });

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('creates config.json when there is none, holding only the saved rung', async () => {
    expect(existsSync(configPath)).toBe(false);

    await putModels({ sonnet: 'claude-sonnet-5' });

    expect(readConfigFile()).toEqual({ models: { sonnet: 'claude-sonnet-5' } });
  });
});

describe('PUT /api/models — the new table reaches every consumer', () => {
  const REPLACEMENT = { sonnet: 'claude-sonnet-5-b', opus: 'claude-opus-5-5-b' };
  const existingSessionDirectory = () => {
    const directory = join('/tmp/of-wt', 'hostile-models');
    mkdirSync(directory, { recursive: true });
    return directory;
  };

  async function connectMcp(token: string) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }
  const createRestSession = (model: string) =>
    fetch(`${server.url}/api/sessions`, { method: 'POST', headers: AUTHORIZED, body: JSON.stringify({ directory: '/tmp', name: 'S', harness: 'fake', model }) });
  const modelOfFirstSession = async () => {
    const sessions = (await (await fetch(`${server.url}/api/sessions`, { headers: AUTHORIZED })).json()) as Array<{ model: string }>;
    return sessions[0]?.model;
  };
  const mcpText = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);

  it('resolves a rung name to the saved id for a session created over REST', async () => {
    await putModels(REPLACEMENT);

    const created = (await (await createRestSession('sonnet')).json()) as { model: string };

    expect(created.model).toBe(REPLACEMENT.sonnet);
    expect(harness.launches.at(-1)?.model).toBe(REPLACEMENT.sonnet);
  });

  it('resolves a rung name to the saved id for a session created over MCP', async () => {
    const parent = (await (await createRestSession('haiku')).json()) as { id: string };
    const parentClient = await connectMcp(harness.launches[0]!.mcpToken);
    await putModels(REPLACEMENT);

    const child = mcpText(await parentClient.callTool({ name: 'create_session', arguments: { directory: existingSessionDirectory(), name: 'Kid', model: 'sonnet' } }));

    expect(child.parentId).toBe(parent.id);
    expect(child.model).toBe(REPLACEMENT.sonnet);
    expect(harness.launches.at(-1)?.model).toBe(REPLACEMENT.sonnet);
  });

  it('resolves a rung name to the saved id when a session switches model over MCP', async () => {
    await createRestSession('haiku');
    const client = await connectMcp(harness.launches[0]!.mcpToken);
    await putModels(REPLACEMENT);

    await client.callTool({ name: 'update_session', arguments: { model: 'opus' } });

    expect(await modelOfFirstSession()).toBe(REPLACEMENT.opus);
  });

  it('resolves a rung name to the saved id when a session switches model over REST', async () => {
    const created = (await (await createRestSession('haiku')).json()) as { id: string };
    await putModels(REPLACEMENT);

    const switched = await fetch(`${server.url}/api/sessions/${created.id}/model`, { method: 'POST', headers: AUTHORIZED, body: JSON.stringify({ model: 'opus' }) });

    expect(switched.status).toBe(200);
    expect(await modelOfFirstSession()).toBe(REPLACEMENT.opus);
  });
});
