import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkingStateSections } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { SessionStartContext } from '../workingState/sessionStartContext.js';
import { StopRefusal } from '../workingState/stopRefusal.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import type { WorkingStateSettings } from '../workingState/workingStateSettings.js';
import { startServer } from './server.js';

const MINUTE_MS = 60_000;
const CONTEXT_BUDGET_CHARACTERS = 9_000;
const STATE: WorkingStateSections = {
  plan: ['ship the injection'],
  todo: ['write the tests'],
  remaining: ['live QA'],
  questionsForHuman: ['which view feeds the digest?'],
  internalQuestions: ['is 40 children enough?'],
  blockers: ['none but the weather'],
};
const PRECEDENCE_LINE = 'the live children and the log are right';

interface AdditionalContextAnswer { hookSpecificOutput?: { hookEventName: string; additionalContext: string } }

let db: DatabaseSync;
let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let workingStates: WorkingStateService;
let managerId: string;
let managerHookToken: string;
let claudeConfigDir: string;
let originalConfigDir: string | undefined;
let settings: WorkingStateSettings;

async function startFixture(settingsOverride: Partial<WorkingStateSettings> = {}, sessionStartContextOverride?: SessionStartContext) {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus, timeoutMs: 100 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  settings = { maxBytes: 8192, enforce: true, maxAgeMinutes: 30, ...settingsOverride };
  const clock = () => new Date().toISOString();
  workingStates = new WorkingStateService({ db, clock, stateRoot: mkdtempSync(join(tmpdir(), 'of-start-mirror-')), maxBytes: settings.maxBytes });
  const stopRefusal = new StopRefusal({ db, workingStates, settings, clock });
  const sessionStartContext = sessionStartContextOverride ?? new SessionStartContext({ db, workingStates, settings, clock });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', stopRefusal, sessionStartContext });
}

const hookTokenOf = (id: string) => (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as { hook_token: string }).hook_token;
const postHook = async (body: Record<string, unknown>, token = managerHookToken) => {
  const response = await fetch(`${server.url}/hooks/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
  return response.json() as Promise<AdditionalContextAnswer>;
};
const sessionStarted = (source: string | undefined, extra: Record<string, unknown> = {}) => postHook({ hook_event_name: 'SessionStart', ...(source ? { source } : {}), ...extra });
const contextOf = (answer: AdditionalContextAnswer) => answer.hookSpecificOutput!.additionalContext;
const writeStateWrittenMinutesAgo = (minutesAgo: number, sections: WorkingStateSections = STATE) => {
  const writtenAt = new Date(Date.now() - minutesAgo * MINUTE_MS).toISOString();
  db.prepare('INSERT OR REPLACE INTO session_working_states (session_id, sections_json, updated_at) VALUES (?, ?, ?)').run(managerId, JSON.stringify(sections), writtenAt);
  return writtenAt;
};
const spawnChild = (name: string, extra: { parentId?: string; directory?: string; model?: string } = {}) =>
  sessions.create({ directory: extra.directory ?? '/tmp', name, harness: 'fake', emoji: '🧒', parentId: extra.parentId ?? managerId, ...(extra.model ? { model: extra.model } : {}) });
const transcriptPathNamed = (fileName: string) => {
  const projectDirectory = join(claudeConfigDir, 'projects', '-tmp-manager');
  mkdirSync(projectDirectory, { recursive: true });
  const path = join(projectDirectory, fileName);
  writeFileSync(path, '');
  return path;
};

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  claudeConfigDir = realpathSync(mkdtempSync(join(tmpdir(), 'of-claude-config-')));
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  await startFixture();
  const manager = await sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
  managerId = manager.id;
  managerHookToken = hookTokenOf(manager.id);
});
afterEach(async () => {
  await server.close();
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

describe('user can get the working state back after a /clear or a compaction', () => {
  it('answers a cleared session with the state, the live children, the precedence line and the previous transcript path, the state after the precedence line', async () => {
    writeStateWrittenMinutesAgo(1);
    const child = await spawnChild('Builder', { directory: '/tmp/builder-dir', model: 'haiku' });
    db.prepare('UPDATE sessions SET branch = ? WHERE id = ?').run('feat/builder', child.id);
    writeStateWrittenMinutesAgo(-1);
    const previousTranscript = transcriptPathNamed('previous-conversation.jsonl');
    await postHook({ hook_event_name: 'UserPromptSubmit', transcript_path: previousTranscript });

    const answer = await sessionStarted('clear', { transcript_path: transcriptPathNamed('new-conversation.jsonl') });

    const context = contextOf(answer);
    expect(answer.hookSpecificOutput!.hookEventName).toBe('SessionStart');
    expect(context).toContain('ship the injection');
    expect(context).toContain('Reste à faire');
    for (const detail of ['Builder', 'haiku', '/tmp/builder-dir', 'feat/builder']) expect(context).toContain(detail);
    expect(context).toContain(previousTranscript);
    expect(context).not.toContain('new-conversation.jsonl');
    expect(context.indexOf(PRECEDENCE_LINE)).toBeGreaterThan(context.indexOf('Builder'));
    expect(context.indexOf('ship the injection')).toBeGreaterThan(context.indexOf(PRECEDENCE_LINE));
    expect(context).toContain('not instructions');
  });

  it('gives the same content on a compaction, quotes the same transcript, and leaves the session state alone', async () => {
    writeStateWrittenMinutesAgo(1);
    const transcript = transcriptPathNamed('compacted.jsonl');
    await postHook({ hook_event_name: 'UserPromptSubmit', transcript_path: transcript });
    const stateBefore = sessions.get(managerId)!.state;

    const answer = await sessionStarted('compact', { transcript_path: transcript });

    const context = contextOf(answer);
    expect(context).toContain('ship the injection');
    expect(context).toContain(transcript);
    expect(context).toContain(PRECEDENCE_LINE);
    expect(sessions.get(managerId)!.state).toBe(stateBefore);
  });

  it('says a state is missing and must be rebuilt before anything else', async () => {
    const answer = await sessionStarted('clear');

    expect(contextOf(answer)).toContain('no state recorded: rebuild it before anything else');
  });

  it('marks the state stale on the first line when it is older than the age limit', async () => {
    writeStateWrittenMinutesAgo(31);

    const context = contextOf(await sessionStarted('clear'));

    expect(context.split('\n')[0]).toContain('stale');
  });

  it('marks the state stale on the first line when it was written before the last spawn', async () => {
    writeStateWrittenMinutesAgo(2);
    await spawnChild('Late-child');

    const context = contextOf(await sessionStarted('clear'));

    expect(context.split('\n')[0]).toContain('stale');
    expect(context.split('\n')[0]).toContain('written before the last spawn or close');
  });

  it('does not mark a current state stale', async () => {
    writeStateWrittenMinutesAgo(29);

    const context = contextOf(await sessionStarted('clear'));

    expect(context.split('\n')[0]).not.toContain('stale');
  });

  it('follows the age limit setting when marking a state stale', async () => {
    await server.close();
    await startFixture({ maxAgeMinutes: 5 });
    const manager = await sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
    managerId = manager.id;
    managerHookToken = hookTokenOf(manager.id);
    writeStateWrittenMinutesAgo(6);

    const context = contextOf(await sessionStarted('clear'));

    expect(context.split('\n')[0]).toContain('stale');
  });
});

describe('user can rely on the live children being named after a reset', () => {
  it('lists only the direct children that are not closed', async () => {
    writeStateWrittenMinutesAgo(0);
    const closedChild = await spawnChild('Closed-child');
    await sessions.close(closedChild.id);
    const liveChild = await spawnChild('Live-child');
    await spawnChild('Grandchild', { parentId: liveChild.id });
    const otherManager = await sessions.create({ directory: '/tmp', name: 'Other-boss', harness: 'fake', emoji: '🤖' });
    await spawnChild('Foreign-child', { parentId: otherManager.id });

    const context = contextOf(await sessionStarted('clear'));

    expect(context).toContain('Live-child');
    for (const excluded of ['Closed-child', 'Grandchild', 'Foreign-child']) expect(context).not.toContain(excluded);
  });

  it('names the default model and the missing branch of a child that has neither', async () => {
    writeStateWrittenMinutesAgo(0);
    await spawnChild('Plain-child');

    const context = contextOf(await sessionStarted('clear'));

    expect(context).toContain('Plain-child · starting · default model · /tmp · no branch');
  });

  it('says there is no live child when there is none', async () => {
    writeStateWrittenMinutesAgo(0);

    expect(contextOf(await sessionStarted('clear'))).toContain('No live child');
  });

  it('lists 40 live children and ends with "and 5 more" for 45', async () => {
    writeStateWrittenMinutesAgo(0);
    for (let index = 1; index <= 45; index += 1) await spawnChild(`Child-${String(index).padStart(2, '0')}`);

    const context = contextOf(await sessionStarted('clear'));

    expect(context).toContain('Child-40');
    expect(context).not.toContain('Child-41');
    expect(context).toContain('and 5 more');
  });

  it('lists exactly 40 children with no "more" line', async () => {
    writeStateWrittenMinutesAgo(0);
    for (let index = 1; index <= 40; index += 1) await spawnChild(`Child-${String(index).padStart(2, '0')}`);

    const context = contextOf(await sessionStarted('clear'));

    expect(context).toContain('Child-40');
    expect(context).not.toMatch(/and \d+ more/);
  });
});

describe('user can rely on the injection staying within the size budget', () => {
  const fullSizeState = (): WorkingStateSections => ({
    plan: Array.from({ length: 20 }, (_, index) => `plan ${index} ${'p'.repeat(120)}`),
    todo: Array.from({ length: 20 }, (_, index) => `todo ${index} ${'t'.repeat(120)}`),
    remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [],
  });

  it('keeps the state complete and shortens the live children with "and N more" when everything does not fit in 9,000 characters', async () => {
    const state = fullSizeState();
    writeStateWrittenMinutesAgo(0, state);
    const directory = `/tmp/${'d'.repeat(180)}`;
    for (let index = 1; index <= 40; index += 1) await spawnChild(`Child-${String(index).padStart(2, '0')}`, { directory });

    const context = contextOf(await sessionStarted('clear'));

    expect(context.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARACTERS);
    for (const item of [...state.plan, ...state.todo]) expect(context).toContain(item);
    expect(context).toMatch(/and \d+ more/);
    expect(context).not.toContain('Child-40');
  });

  it('keeps the whole content within the budget on a resume too', async () => {
    writeStateWrittenMinutesAgo(0, fullSizeState());
    const directory = `/tmp/${'d'.repeat(180)}`;
    for (let index = 1; index <= 40; index += 1) await spawnChild(`Child-${String(index).padStart(2, '0')}`, { directory });

    const context = contextOf(await sessionStarted('resume'));

    expect(context.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARACTERS);
    expect(context).toContain(`todo 19 ${'t'.repeat(120)}`);
  });

  it('lists every child when the whole content fits', async () => {
    writeStateWrittenMinutesAgo(0);
    for (let index = 1; index <= 40; index += 1) await spawnChild(`Child-${String(index).padStart(2, '0')}`);

    const context = contextOf(await sessionStarted('clear'));

    expect(context).toContain('Child-40');
    expect(context.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARACTERS);
  });
});

describe('user can resume a session with a shorter injection', () => {
  it('gives the resumed line, the live children, the precedence line and the state, and no transcript path', async () => {
    writeStateWrittenMinutesAgo(1);
    await spawnChild('Builder');
    const transcript = transcriptPathNamed('before-restart.jsonl');
    await postHook({ hook_event_name: 'UserPromptSubmit', transcript_path: transcript });

    const context = contextOf(await sessionStarted('resume', { transcript_path: transcript }));

    expect(context.split('\n')[0]).toContain('resumed');
    for (const part of ['Builder', PRECEDENCE_LINE, 'ship the injection']) expect(context).toContain(part);
    expect(context).not.toContain('before-restart.jsonl');
  });

  it('marks a stale state on the first line of a resume', async () => {
    writeStateWrittenMinutesAgo(45);

    expect(contextOf(await sessionStarted('resume')).split('\n')[0]).toContain('stale');
  });

  it('answers the first line of a cleared session with the context reset, not the resume wording', async () => {
    writeStateWrittenMinutesAgo(1);

    const firstLine = contextOf(await sessionStarted('clear')).split('\n')[0]!;

    expect(firstLine).toContain('reset');
    expect(firstLine).not.toContain('resumed');
  });
});

describe('user gets nothing injected when nothing was lost', () => {
  it.each(['startup', 'fork', 'something-new', undefined])('answers {} to a SessionStart with source %s', async (source) => {
    writeStateWrittenMinutesAgo(1);

    expect(await sessionStarted(source)).toEqual({});
  });

  it('answers {} to every other hook of a session with a state', async () => {
    writeStateWrittenMinutesAgo(1);

    expect(await postHook({ hook_event_name: 'UserPromptSubmit' })).toEqual({});
  });

  it('answers {} to a hook token that belongs to no session and to a closed session', async () => {
    writeStateWrittenMinutesAgo(1);
    const child = await spawnChild('Short-lived');
    const childToken = hookTokenOf(child.id);
    await sessions.close(child.id);

    expect(await sessionStarted('clear')).not.toEqual({});
    expect(await postHook({ hook_event_name: 'SessionStart', source: 'clear' }, 'unknown-token')).toEqual({});
    expect(await postHook({ hook_event_name: 'SessionStart', source: 'clear' }, childToken)).toEqual({});
  });

  it('answers {} instead of failing the hook when building the context throws', async () => {
    await server.close();
    const throwingContext = { build: () => { throw new Error('boom'); } } as unknown as SessionStartContext;
    await startFixture({}, throwingContext);
    const manager = await sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
    managerHookToken = hookTokenOf(manager.id);

    expect(await sessionStarted('clear')).toEqual({});
  });
});
