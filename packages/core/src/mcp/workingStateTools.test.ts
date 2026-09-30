import type { WorkingStateSections } from '@openfleet/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../api/server.js';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';
import { renderWorkingState } from '../workingState/renderWorkingState.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { createMcpHandler } from './mcpServer.js';

const DAEMON_NOW = '2031-04-05T10:00:00.000Z';
const DEFAULT_MAX_BYTES = 6144;

interface Fleet {
  server: Awaited<ReturnType<typeof startServer>>;
  db: DatabaseSync;
  sessions: SessionService;
  workingStates: WorkingStateService;
  stateRoot: string;
  harness: FakeHarness;
  leadToken: string;
  leadId: string;
}

let fleet: Fleet;

async function startFleet({ maxBytes = DEFAULT_MAX_BYTES, clock = () => DAEMON_NOW }: { maxBytes?: number; clock?: () => string } = {}): Promise<Fleet> {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => new Date().toISOString(), newId });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString() });
  const stateRoot = join(mkdtempSync(join(tmpdir(), 'of-state-')), 'state');
  const workingStates = new WorkingStateService({ db, clock, stateRoot, maxBytes });
  const server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json',
    mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, stores, storeRepo, notes, noteRepo, docs, workingStates, worktreesRoot: '/tmp/of-wt' }),
  });
  const lead = await sessions.create({ directory: '/tmp', name: 'Lead', harness: 'fake', emoji: '🧭' });
  return { server, db, sessions, workingStates, stateRoot, harness, leadToken: harness.launches[0]!.mcpToken, leadId: lead.id };
}

async function spawnChild(name: string, parentId: string): Promise<{ id: string; token: string }> {
  const child = await fleet.sessions.create({ directory: '/tmp', name, harness: 'fake', emoji: '🤖', parentId });
  const launch = fleet.harness.launches.find((candidate) => candidate.sessionId === child.id)!;
  return { id: child.id, token: launch.mcpToken };
}

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${fleet.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

type ToolResult = { content: { text: string }[]; isError?: boolean };
const answerOf = (result: unknown) => (result as ToolResult).content[0]!.text;
const jsonOf = (result: unknown) => JSON.parse(answerOf(result));
const isRefused = (result: unknown) => (result as ToolResult).isError === true;

const emptyState = (): WorkingStateSections => ({ plan: [], todo: [], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] });
const toToolArguments = (state: WorkingStateSections) => ({
  plan: state.plan, todo: state.todo, remaining: state.remaining, questions_for_human: state.questionsForHuman,
  internal_questions: state.internalQuestions, blockers: state.blockers,
});

async function updateState(token: string, state: WorkingStateSections, extraArguments: Record<string, unknown> = {}) {
  const client = await connect(token);
  return client.callTool({ name: 'update_working_state', arguments: { ...toToolArguments(state), ...extraArguments } });
}
async function readState(token: string, sessionId?: string) {
  const client = await connect(token);
  return client.callTool({ name: 'get_working_state', arguments: sessionId ? { session_id: sessionId } : {} });
}

const byteLengthOf = (state: WorkingStateSections) => Buffer.byteLength(renderWorkingState(state), 'utf8');

function stateOfRenderedBytes(targetBytes: number): WorkingStateSections {
  const filler = 'a'.repeat(300);
  const state = { ...emptyState(), plan: Array<string>(15).fill(filler), todo: Array<string>(4).fill(filler), remaining: ['x'] };
  const missingBytes = targetBytes - byteLengthOf(state);
  const paddedItemLength = 1 + missingBytes;
  const fitsInOneItem = paddedItemLength >= 1 && paddedItemLength <= 300;
  if (!fitsInOneItem) throw new Error(`test helper cannot reach ${targetBytes} bytes: padding of ${paddedItemLength} characters`);
  return { ...state, remaining: ['x'.padEnd(paddedItemLength, 'a')] };
}

const mirrorPathOf = (sessionId: string) => join(fleet.stateRoot, `${sessionId}.md`);
const insertSession = (db: DatabaseSync, id: string) =>
  db.prepare(`INSERT INTO sessions (id, name, emoji, directory, harness, state, state_since, hook_token, mcp_token, parent_id, created_at)
    VALUES (?, 'hostile', '🤖', '/tmp', 'fake', 'idle', 't0', ?, ?, NULL, 't0')`).run(id, `hook-${id}`, `mcp-${id}`);
const permissionBitsOf = (path: string) => statSync(path).mode & 0o777;

beforeEach(async () => { fleet = await startFleet(); });
afterEach(() => fleet.server.close());

describe('an agent keeps its working state through the OpenFleet tools', () => {
  it('lists update_working_state and get_working_state among the tools', async () => {
    const client = await connect(fleet.leadToken);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['update_working_state', 'get_working_state']));
  });

  it('agent can write its six sections and read them back with the daemon clock as update time', async () => {
    const state = { ...emptyState(), plan: ['ship STATE-01a'], todo: ['write the tool'], blockers: ['none yet'] };

    const written = await updateState(fleet.leadToken, state, { updated_at: '1999-01-01T00:00:00.000Z' });
    const read = await readState(fleet.leadToken);

    expect(isRefused(written)).toBe(false);
    expect(jsonOf(written)).toEqual({ updated_at: DAEMON_NOW });
    expect(jsonOf(read)).toEqual({ ...state, updatedAt: DAEMON_NOW });
  });

  it('agent reads { state: null } before its first write', async () => {
    const read = await readState(fleet.leadToken);

    expect(jsonOf(read)).toEqual({ state: null });
  });

  it('agent replaces the whole previous state at each write', async () => {
    await updateState(fleet.leadToken, { ...emptyState(), plan: ['first'], todo: ['old todo'] });

    await updateState(fleet.leadToken, { ...emptyState(), plan: ['second'] });

    const read = jsonOf(await readState(fleet.leadToken));
    expect(read.plan).toEqual(['second']);
    expect(read.todo).toEqual([]);
  });

  it('agent finds each of the six sections under its own name, in the readback and in the mirror', async () => {
    const state: WorkingStateSections = {
      plan: ['plan A', 'plan B'], todo: ['todo A'], remaining: ['remaining A'],
      questionsForHuman: ['human question A'], internalQuestions: ['internal question A'], blockers: ['blocker A'],
    };

    await updateState(fleet.leadToken, state);

    expect(jsonOf(await readState(fleet.leadToken))).toEqual({ ...state, updatedAt: DAEMON_NOW });
    expect(readFileSync(mirrorPathOf(fleet.leadId), 'utf8')).toBe([
      '## Plan\n- plan A\n- plan B\n',
      '## Todo\n- todo A\n',
      '## Reste à faire\n- remaining A\n',
      "## Questions pour l'humain\n- human question A\n",
      '## Questions internes\n- internal question A\n',
      '## Blocages\n- blocker A\n',
    ].join('\n'));
  });

  it('agent sees the update time move with each write', async () => {
    const ticks = ['2031-04-05T10:00:00.000Z', '2031-04-05T10:05:00.000Z'];
    await fleet.server.close();
    fleet = await startFleet({ clock: () => ticks.shift()! });

    const first = jsonOf(await updateState(fleet.leadToken, { ...emptyState(), plan: ['one'] }));
    const afterFirst = jsonOf(await readState(fleet.leadToken)).updatedAt;
    const second = jsonOf(await updateState(fleet.leadToken, { ...emptyState(), plan: ['two'] }));
    const afterSecond = jsonOf(await readState(fleet.leadToken)).updatedAt;

    expect([first.updated_at, afterFirst, second.updated_at, afterSecond]).toEqual(['2031-04-05T10:00:00.000Z', '2031-04-05T10:00:00.000Z', '2031-04-05T10:05:00.000Z', '2031-04-05T10:05:00.000Z']);
  });

  it('agent gets the failure itself, not a size refusal, when the database breaks', async () => {
    fleet.db.exec('DROP TABLE session_working_states');

    const result = await updateState(fleet.leadToken, { ...emptyState(), plan: ['x'] });

    expect(isRefused(result)).toBe(true);
    expect(answerOf(result)).toMatch(/no such table/);
    expect(answerOf(result)).not.toMatch(/cap|move history/);
  });
});

describe('the daemon refuses a state that breaks the contract and keeps the previous one', () => {
  const previous = { ...emptyState(), plan: ['kept'] };
  const breakingStates: [string, () => Record<string, unknown>][] = [
    ['five sections instead of six', () => { const { blockers, ...fiveSections } = toToolArguments(emptyState()); void blockers; return fiveSections; }],
    ['21 items in a section', () => toToolArguments({ ...emptyState(), todo: Array.from({ length: 21 }, (_, index) => `item ${index}`) })],
    ['an item of 301 characters', () => toToolArguments({ ...emptyState(), todo: ['a'.repeat(301)] })],
    ['an item on two lines', () => toToolArguments({ ...emptyState(), todo: ['line one\nline two'] })],
    ['an item with a line separator U+2028', () => toToolArguments({ ...emptyState(), todo: [`line one${String.fromCharCode(0x2028)}## Plan`] })],
    ['an item with a paragraph separator U+2029', () => toToolArguments({ ...emptyState(), todo: [`line one${String.fromCharCode(0x2029)}## Plan`] })],
    ['an item with a next line U+0085', () => toToolArguments({ ...emptyState(), todo: ['line one\u0085## Plan'] })],
    ['an item with a lone carriage return', () => toToolArguments({ ...emptyState(), todo: ['line one\r## Plan'] })],
    ['an item with an escape character', () => toToolArguments({ ...emptyState(), todo: ['before\u001b[2Jafter'] })],
    ['an item with a NUL character', () => toToolArguments({ ...emptyState(), todo: ['before\u0000after'] })],
    ['an item with a backspace', () => toToolArguments({ ...emptyState(), todo: ['before\u0008after'] })],
    ['an item with a DEL character', () => toToolArguments({ ...emptyState(), todo: ['before\u007fafter'] })],
    ['an item with a right-to-left override U+202E', () => toToolArguments({ ...emptyState(), todo: [`before${String.fromCharCode(0x202e)}after`] })],
    ['an item with a left-to-right embedding U+202A', () => toToolArguments({ ...emptyState(), todo: [`before${String.fromCharCode(0x202a)}after`] })],
    ['an item with a right-to-left isolate U+2067', () => toToolArguments({ ...emptyState(), todo: [`before${String.fromCharCode(0x2067)}after`] })],
    ['an item with a pop directional isolate U+2069', () => toToolArguments({ ...emptyState(), todo: [`before${String.fromCharCode(0x2069)}after`] })],
    ['an item with a vertical tab', () => toToolArguments({ ...emptyState(), todo: ['line one\v## Plan'] })],
    ['an item with a form feed', () => toToolArguments({ ...emptyState(), todo: ['line one\f## Plan'] })],
    ['an item that starts with a heading mark', () => toToolArguments({ ...emptyState(), todo: ['# Plan'] })],
    ['an empty item', () => toToolArguments({ ...emptyState(), todo: ['   '] })],
  ];

  it.each(breakingStates)('refuses %s', async (_label, breakingArguments) => {
    await updateState(fleet.leadToken, previous);
    const client = await connect(fleet.leadToken);

    const result = await client.callTool({ name: 'update_working_state', arguments: breakingArguments() });

    expect(isRefused(result)).toBe(true);
    expect(jsonOf(await readState(fleet.leadToken)).plan).toEqual(['kept']);
  });

  it('accepts 20 items in a section and an item of 300 characters', async () => {
    const boundary = { ...emptyState(), todo: ['b'.repeat(300)], plan: Array.from({ length: 20 }, (_, index) => `item ${index}`) };

    const result = await updateState(fleet.leadToken, boundary);

    expect(isRefused(result)).toBe(false);
  });

  it('accepts an item of one character and an item with a tab inside', async () => {
    const result = await updateState(fleet.leadToken, { ...emptyState(), todo: ['a', 'col1\tcol2'] });

    expect(isRefused(result)).toBe(false);
    expect(jsonOf(await readState(fleet.leadToken)).todo).toEqual(['a', 'col1\tcol2']);
  });

  it('counts an item in characters, not in UTF-16 units: 300 emoji are accepted and 301 refused', async () => {
    const emojiItem = (count: number) => '😀'.repeat(count);

    const at150 = await updateState(fleet.leadToken, { ...emptyState(), todo: [emojiItem(150)] });
    const at151 = await updateState(fleet.leadToken, { ...emptyState(), todo: [emojiItem(151)] });
    const at300 = await updateState(fleet.leadToken, { ...emptyState(), todo: [emojiItem(300)] });
    const at301 = await updateState(fleet.leadToken, { ...emptyState(), todo: [emojiItem(301)] });

    expect([at150, at151, at300, at301].map(isRefused)).toEqual([false, false, false, true]);
  });
});

describe('the state is measured on the bytes of its rendered mirror (maxBytes)', () => {
  it('accepts a state of exactly 6144 bytes and refuses one of 6145, naming the size, the cap and what to do', async () => {
    const atTheCap = stateOfRenderedBytes(DEFAULT_MAX_BYTES);
    const oneOver = stateOfRenderedBytes(DEFAULT_MAX_BYTES + 1);

    const accepted = await updateState(fleet.leadToken, atTheCap);
    const refused = await updateState(fleet.leadToken, oneOver);

    expect(isRefused(accepted)).toBe(false);
    expect(isRefused(refused)).toBe(true);
    expect(answerOf(refused)).toContain('6145');
    expect(answerOf(refused)).toContain('6144');
    expect(answerOf(refused)).toContain('move history to the log');
    expect(jsonOf(await readState(fleet.leadToken)).remaining[0]).toBe(atTheCap.remaining[0]);
  });

  it('refuses 4000 accented characters, which are 8000 bytes', async () => {
    const accented = { ...emptyState(), plan: Array<string>(16).fill('é'.repeat(250)) };

    const result = await updateState(fleet.leadToken, accented);

    expect(isRefused(result)).toBe(true);
    expect(answerOf(result)).toContain('move history to the log');
  });

  it('follows a lower maxBytes: 2048 refuses a state that 6144 accepts', async () => {
    await fleet.server.close();
    fleet = await startFleet({ maxBytes: 2048 });
    const threeKilobytes = { ...emptyState(), plan: Array<string>(10).fill('a'.repeat(300)) };

    const refused = await updateState(fleet.leadToken, threeKilobytes);
    const accepted = await updateState(fleet.leadToken, { ...emptyState(), plan: ['short'] });

    expect(isRefused(refused)).toBe(true);
    expect(answerOf(refused)).toContain('2048');
    expect(isRefused(accepted)).toBe(false);
  });
});

describe('who can read a working state', () => {
  it('a manager reads the state of its child', async () => {
    const child = await spawnChild('Scout', fleet.leadId);
    await updateState(child.token, { ...emptyState(), plan: ['scout the code'] });

    const read = await readState(fleet.leadToken, child.id);

    expect(jsonOf(read).plan).toEqual(['scout the code']);
  });

  it('a child reads the state of its manager', async () => {
    const child = await spawnChild('Scout', fleet.leadId);
    await updateState(fleet.leadToken, { ...emptyState(), plan: ['lead plan'] });

    const read = await readState(child.token, fleet.leadId);

    expect(jsonOf(read).plan).toEqual(['lead plan']);
  });

  it('a session outside the lineage is refused, and so is an unknown session', async () => {
    const sibling = await spawnChild('Sibling', fleet.leadId);
    const stranger = await fleet.sessions.create({ directory: '/tmp', name: 'Stranger', harness: 'fake', emoji: '👤' });
    await updateState(sibling.token, { ...emptyState(), plan: ['private'] });

    const strangerLaunch = fleet.harness.launches.find((launch) => launch.sessionId === stranger.id)!;
    const outsideLineage = await readState(strangerLaunch.mcpToken, sibling.id);
    const unknown = await readState(fleet.leadToken, 'no-such-session');

    expect(isRefused(outsideLineage)).toBe(true);
    expect(answerOf(outsideLineage)).not.toContain('private');
    expect(isRefused(unknown)).toBe(true);
  });

  describe('across the real relations of a session tree', () => {
    interface Tree { child: Actor; sibling: Actor; grandchild: Actor; otherRoot: Actor; otherRootChild: Actor; lead: Actor }
    interface Actor { id: string; token: string }

    async function growTree(): Promise<Tree> {
      const child = await spawnChild('Child', fleet.leadId);
      const sibling = await spawnChild('Sibling', fleet.leadId);
      const grandchild = await spawnChild('Grandchild', child.id);
      const otherRootSession = await fleet.sessions.create({ directory: '/tmp', name: 'Other root', harness: 'fake', emoji: '👤' });
      const otherRoot = { id: otherRootSession.id, token: fleet.harness.launches.find((launch) => launch.sessionId === otherRootSession.id)!.mcpToken };
      const otherRootChild = await spawnChild('Other child', otherRoot.id);
      const lead = { id: fleet.leadId, token: fleet.leadToken };
      return { child, sibling, grandchild, otherRoot, otherRootChild, lead };
    }

    const refusedReads: [string, (tree: Tree) => [reader: Actor, target: Actor]][] = [
      ['a sibling reads a sibling', (tree) => [tree.sibling, tree.child]],
      ['a grandparent reads a grandchild', (tree) => [tree.lead, tree.grandchild]],
      ['a grandchild reads its grandparent', (tree) => [tree.grandchild, tree.lead]],
      ['a session of another root reads a session of this tree', (tree) => [tree.otherRoot, tree.child]],
      ['a child of another root reads the root of this tree', (tree) => [tree.otherRootChild, tree.lead]],
    ];

    it.each(refusedReads)('%s: refused, and nothing of the state leaks', async (_label, pick) => {
      const tree = await growTree();
      await updateState(tree.child.token, { ...emptyState(), plan: ['private'] });
      await updateState(tree.lead.token, { ...emptyState(), plan: ['private'] });
      await updateState(tree.grandchild.token, { ...emptyState(), plan: ['private'] });
      const [reader, target] = pick(tree);

      const result = await readState(reader.token, target.id);

      expect(isRefused(result)).toBe(true);
      expect(answerOf(result)).not.toContain('private');
    });

    const allowedReads: [string, (tree: Tree) => [reader: Actor, target: Actor]][] = [
      ['a session reads itself by id', (tree) => [tree.child, tree.child]],
      ['a manager reads its direct child', (tree) => [tree.child, tree.grandchild]],
      ['a child reads its direct parent', (tree) => [tree.grandchild, tree.child]],
    ];

    it.each(allowedReads)('%s', async (_label, pick) => {
      const tree = await growTree();
      const [reader, target] = pick(tree);
      await updateState(target.token, { ...emptyState(), plan: ['visible'] });

      const result = await readState(reader.token, target.id);

      expect(isRefused(result)).toBe(false);
      expect(jsonOf(result).plan).toEqual(['visible']);
    });

    it('a child cannot write the state of its parent', async () => {
      const tree = await growTree();
      await updateState(tree.lead.token, { ...emptyState(), plan: ['lead plan'] });

      await updateState(tree.child.token, { ...emptyState(), plan: ['forged'] }, { session_id: tree.lead.id });

      expect(jsonOf(await readState(tree.lead.token)).plan).toEqual(['lead plan']);
    });
  });

  it('each session keeps a separate state', async () => {
    const child = await spawnChild('Scout', fleet.leadId);

    await updateState(fleet.leadToken, { ...emptyState(), plan: ['lead'] });
    await updateState(child.token, { ...emptyState(), plan: ['child'] });

    expect(jsonOf(await readState(fleet.leadToken)).plan).toEqual(['lead']);
    expect(jsonOf(await readState(child.token)).plan).toEqual(['child']);
  });
});

describe('the mirror file is a one-way copy of the state', () => {
  it('holds the six French headings and the items, in a 0700 directory with a 0600 file', async () => {
    const state = { ...emptyState(), plan: ['premier'], todo: ['un', 'deux'], questionsForHuman: ['quelle option ?'] };

    await updateState(fleet.leadToken, state);

    const mirror = readFileSync(mirrorPathOf(fleet.leadId), 'utf8');
    const headingsInOrder = ['Plan', 'Todo', 'Reste à faire', "Questions pour l'humain", 'Questions internes', 'Blocages'].map((heading) => mirror.indexOf(`## ${heading}\n`));
    expect(headingsInOrder.every((position) => position >= 0)).toBe(true);
    expect([...headingsInOrder].sort((a, b) => a - b)).toEqual(headingsInOrder);
    expect(mirror).toContain('- premier');
    expect(mirror).toContain('- deux');
    expect(mirror).toContain('- quelle option ?');
    expect(permissionBitsOf(mirrorPathOf(fleet.leadId))).toBe(0o600);
    expect(permissionBitsOf(fleet.stateRoot)).toBe(0o700);
  });

  it('tightens a state directory that already exists with looser permissions', async () => {
    await updateState(fleet.leadToken, emptyState());
    chmodSync(fleet.stateRoot, 0o755);

    await updateState(fleet.leadToken, emptyState());

    expect(permissionBitsOf(fleet.stateRoot)).toBe(0o700);
  });

  it('agent reads its state from the database: editing the mirror changes nothing', async () => {
    await updateState(fleet.leadToken, { ...emptyState(), plan: ['real'] });

    writeFileSync(mirrorPathOf(fleet.leadId), '## Plan\n- forged\n');
    const read = jsonOf(await readState(fleet.leadToken));

    expect(read.plan).toEqual(['real']);
    expect(read.updatedAt).toBe(DAEMON_NOW);
  });

  it('keeps the update and says the mirror failed when the mirror cannot be written', async () => {
    mkdirSync(mirrorPathOf(fleet.leadId), { recursive: true });

    const result = await updateState(fleet.leadToken, { ...emptyState(), plan: ['written despite the mirror'] });

    expect(isRefused(result)).toBe(false);
    expect(jsonOf(result).updated_at).toBe(DAEMON_NOW);
    expect(jsonOf(result).mirror_warning).toMatch(/mirror/i);
    expect(jsonOf(await readState(fleet.leadToken)).plan).toEqual(['written despite the mirror']);
  });

  it('writes the exact text of a known state: headings, order, blank lines, (rien) for an empty section', async () => {
    await updateState(fleet.leadToken, { ...emptyState(), plan: ['a'], todo: ['b', 'c'] });

    expect(readFileSync(mirrorPathOf(fleet.leadId), 'utf8')).toBe([
      '## Plan\n- a\n',
      '## Todo\n- b\n- c\n',
      '## Reste à faire\n(rien)\n',
      "## Questions pour l'humain\n(rien)\n",
      '## Questions internes\n(rien)\n',
      '## Blocages\n(rien)\n',
    ].join('\n'));
  });

  it('leaves no temporary file behind when the mirror cannot be written', async () => {
    mkdirSync(mirrorPathOf(fleet.leadId), { recursive: true });

    await updateState(fleet.leadToken, { ...emptyState(), plan: ['x'] });

    expect(readdirSync(fleet.stateRoot).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  describe.each(['../escape', '.', '', 'a/b', 'not-a-uuid'])('for a session whose id is %j', (hostileId) => {
    it('keeps the state, warns about the mirror and writes nothing outside the state directory', async () => {
      insertSession(fleet.db, hostileId);
      const sections = { ...emptyState(), plan: ['kept'] };

      const written = fleet.workingStates.update(hostileId, sections);

      expect(written.mirrorWarning).toMatch(/mirror/i);
      expect(fleet.workingStates.get(hostileId)?.plan).toEqual(['kept']);
      expect(readdirSync(dirname(fleet.stateRoot)).filter((name) => name !== 'state')).toEqual([]);
      expect(existsSync(fleet.stateRoot) ? readdirSync(fleet.stateRoot) : []).toEqual([]);
    });
  });

  it('answers with no mirror warning when the mirror is written', async () => {
    const result = await updateState(fleet.leadToken, emptyState());

    expect(jsonOf(result).mirror_warning).toBeUndefined();
  });
});

describe('the fleet changes a manager can see in its state', () => {
  it('reports no fleetChangedAt for a session with no child', async () => {
    await updateState(fleet.leadToken, emptyState());

    expect(jsonOf(await readState(fleet.leadToken)).fleetChangedAt).toBeUndefined();
  });

  describe('with a controlled session clock', () => {
    const SPAWN_TIME = '2031-04-05T09:00:00.000Z';
    const CLOSE_TIME = '2031-04-05T09:30:00.000Z';

    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('reports the creation time of the latest child, then the close time of a child closed afterwards', async () => {
      vi.setSystemTime(new Date(SPAWN_TIME));
      const first = await spawnChild('First', fleet.leadId);
      const second = await spawnChild('Second', fleet.leadId);
      await updateState(fleet.leadToken, emptyState());

      const afterSpawns = jsonOf(await readState(fleet.leadToken)).fleetChangedAt;
      vi.setSystemTime(new Date(CLOSE_TIME));
      await fleet.sessions.close(first.id);
      const afterClose = jsonOf(await readState(fleet.leadToken)).fleetChangedAt;

      expect(fleet.sessions.get(second.id)!.createdAt).toBe(SPAWN_TIME);
      expect(afterSpawns).toBe(SPAWN_TIME);
      expect(afterClose).toBe(CLOSE_TIME);
    });
  });

  it('ignores the children of other sessions', async () => {
    const stranger = await fleet.sessions.create({ directory: '/tmp', name: 'Stranger', harness: 'fake', emoji: '👤' });
    await spawnChild('Not mine', stranger.id);
    await updateState(fleet.leadToken, emptyState());

    expect(jsonOf(await readState(fleet.leadToken)).fleetChangedAt).toBeUndefined();
  });
});

describe('any caller of the working state service meets the same contract as the MCP tool', () => {
  const previous = { ...emptyState(), plan: ['kept'] };
  const invalidSections: [string, WorkingStateSections][] = [
    ['21 items in a section', { ...emptyState(), todo: Array.from({ length: 21 }, (_, index) => `item ${index}`) }],
    ['an item of 301 characters', { ...emptyState(), todo: ['a'.repeat(301)] }],
    ['an item on two lines', { ...emptyState(), todo: ['one\ntwo'] }],
    ['an item starting with #', { ...emptyState(), todo: ['# heading'] }],
    ['an empty item', { ...emptyState(), todo: [''] }],
    ['an item with an escape character', { ...emptyState(), todo: ['a\u001bb'] }],
  ];

  it.each(invalidSections)('refuses %s and keeps the previous state and mirror', (_label, sections) => {
    fleet.workingStates.update(fleet.leadId, previous);

    expect(() => fleet.workingStates.update(fleet.leadId, sections)).toThrow();

    expect(fleet.workingStates.get(fleet.leadId)?.plan).toEqual(['kept']);
    expect(readFileSync(mirrorPathOf(fleet.leadId), 'utf8')).toContain('- kept');
  });
});

describe('a state update is announced inside the daemon', () => {
  it('stops notifying a listener once it has unsubscribed', async () => {
    const heard: string[] = [];
    const unsubscribe = fleet.workingStates.onUpdate((state) => heard.push(state.plan.join(',')));
    await updateState(fleet.leadToken, { ...emptyState(), plan: ['heard'] });

    unsubscribe();
    await updateState(fleet.leadToken, { ...emptyState(), plan: ['not heard'] });

    expect(heard).toEqual(['heard']);
  });

  it('notifies a listener with the stored state after each successful update and not after a refused one', async () => {
    const heard: string[] = [];
    fleet.workingStates.onUpdate((state) => heard.push(`${state.sessionId}:${state.plan.join(',')}`));

    await updateState(fleet.leadToken, { ...emptyState(), plan: ['announced'] });
    const client = await connect(fleet.leadToken);
    await client.callTool({ name: 'update_working_state', arguments: { ...toToolArguments(emptyState()), todo: ['x\ny'] } });

    expect(heard).toEqual([`${fleet.leadId}:announced`]);
  });

  it('a listener that throws neither fails the update nor silences the other listeners', async () => {
    const heard: string[] = [];
    fleet.workingStates.onUpdate(() => { throw new Error('listener exploded'); });
    fleet.workingStates.onUpdate((state) => heard.push(state.plan.join(',')));

    const result = await updateState(fleet.leadToken, { ...emptyState(), plan: ['saved anyway'] });

    expect(isRefused(result)).toBe(false);
    expect(jsonOf(result).updated_at).toBe(DAEMON_NOW);
    expect(heard).toEqual(['saved anyway']);
    expect(jsonOf(await readState(fleet.leadToken)).plan).toEqual(['saved anyway']);
  });
});
