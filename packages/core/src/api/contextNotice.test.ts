import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent, Session } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { ContextNotice } from '../workingState/contextNotice.js';
import type { ContextNoticeSettings } from '../workingState/workingStateSettings.js';
import { startServer } from './server.js';

const DEFAULT_SETTINGS: ContextNoticeSettings = { firstAt: 300_000, every: 100_000, roles: { manager: true }, models: {} };
const CACHE_CREATION_TOKENS = 2_000;

let server: Awaited<ReturnType<typeof startServer>>;
let db: ReturnType<typeof openDatabase>;
let sessions: SessionService;
let managers: ManagerService;
let harness: FakeHarness;
let events: ServerEvent[];
let projectsDirectory: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

const boot = async (settings: ContextNoticeSettings) => {
  const bus = new EventBus();
  events = [];
  bus.subscribe((event) => events.push(event));
  harness = new FakeHarness();
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const contextNotice = new ContextNotice({ sessions, managers: managerRepo, settings });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', contextNotice });
};

beforeEach(async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'of-cn-claude-config-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  projectsDirectory = join(configDir, 'projects', 'proj');
  mkdirSync(projectsDirectory, { recursive: true });
  db = openDatabase(':memory:');
  await boot(DEFAULT_SETTINGS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

const transcriptOf = (id: string) => join(projectsDirectory, `${id}.jsonl`);
const hookTokenOf = (id: string) => (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as { hook_token: string }).hook_token;
const postHook = async (id: string, body: Record<string, unknown>, transcriptPath: string = transcriptOf(id)) => {
  const response = await fetch(`${server.url}/hooks/${hookTokenOf(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: id, transcript_path: transcriptPath, ...body }) });
  return response.json();
};
const stop = (id: string, transcriptPath?: string) => postHook(id, { hook_event_name: 'Stop' }, transcriptPath);
const sessionStart = (id: string, source: string) => postHook(id, { hook_event_name: 'SessionStart', source });

const assistantLine = (fields: { contextTokens?: number; usage?: unknown; isSidechain?: boolean; model?: string }) => {
  const usage = fields.usage ?? { input_tokens: 1, cache_creation_input_tokens: CACHE_CREATION_TOKENS, cache_read_input_tokens: (fields.contextTokens ?? 0) - 1 - CACHE_CREATION_TOKENS };
  return `${JSON.stringify({ type: 'assistant', isSidechain: fields.isSidechain ?? false, timestamp: new Date().toISOString(), version: '2.1.284', message: { role: 'assistant', model: fields.model ?? 'claude-opus-5-5', content: [], usage } })}\n`;
};
const writeTranscript = (id: string, ...lines: string[]) => writeFileSync(transcriptOf(id), lines.join(''));
const contextGrowsTo = (id: string, contextTokens: number) => writeTranscript(id, assistantLine({ contextTokens }));

const createManager = async (model?: string) => (await managers.createManagerSession({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖', model, manager: { childrenCap: 3, mission: 'mission' } })).id;
const createChildOf = async (parentId: string) => (await sessions.create({ directory: '/tmp', name: 'Worker', harness: 'fake', emoji: '🤖', parentId })).id;
const createPlainSession = async (model?: string) => (await sessions.create({ directory: '/tmp', name: 'Solo', harness: 'fake', emoji: '🤖', model })).id;

const sessionOf = (id: string): Session => sessions.list().find((session) => session.id === id)!;
const noticeOf = (id: string) => sessionOf(id).contextNoticeTokens;
const updatesOf = (id: string) => events.filter((event) => event.type === 'session.updated' && event.session.id === id);
const noticeUpdatesOf = (id: string) => updatesOf(id).filter((event) => event.type === 'session.updated' && event.session.contextNoticeTokens !== undefined);
const noticeOfLastUpdate = (id: string) => {
  const lastUpdate = updatesOf(id).at(-1);
  return lastUpdate?.type === 'session.updated' ? lastUpdate.session.contextNoticeTokens : 'no update';
};
const typedBodies =() => harness.handles.flatMap((handle) => handle.written);

describe('user is told in the inbox data when a manager session is a good moment to compact', () => {
  it('raises a notice for a manager at 300,000 tokens and none at 299,999', async () => {
    const manager = await createManager();

    contextGrowsTo(manager, 299_999);
    await stop(manager);
    const noticeJustBelow = noticeOf(manager);
    contextGrowsTo(manager, 300_000);
    await stop(manager);

    expect(noticeJustBelow).toBeUndefined();
    expect(noticeOf(manager)).toBe(300_000);
  });

  it('adds the three usage fields of the latest main-chain line to measure the context', async () => {
    const manager = await createManager();
    writeTranscript(manager, assistantLine({ usage: { input_tokens: 100_000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 100_000 } }));

    await stop(manager);

    expect(noticeOf(manager)).toBe(300_000);
  });

  it.each(['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'])('counts %s in the measure: 1,000 tokens in it and 299,000 in the other two reach 300,000', async (countedField) => {
    const manager = await createManager();
    const usage = { input_tokens: 149_500, cache_creation_input_tokens: 149_500, cache_read_input_tokens: 149_500, [countedField]: 1_000 };
    writeTranscript(manager, assistantLine({ usage }));

    await stop(manager);

    expect(noticeOf(manager)).toBe(300_000);
  });

  it('raises one notice per threshold crossed: one at 300,000, none at 350,000 or 399,999, a second at 400,000', async () => {
    const manager = await createManager();

    contextGrowsTo(manager, 300_000);
    await stop(manager);
    contextGrowsTo(manager, 350_000);
    await stop(manager);
    contextGrowsTo(manager, 399_999);
    await stop(manager);
    const noticesBeforeSecondThreshold = noticeUpdatesOf(manager).length;
    contextGrowsTo(manager, 400_000);
    await stop(manager);

    expect(noticesBeforeSecondThreshold).toBe(1);
    expect(noticeUpdatesOf(manager).map((event) => (event.type === 'session.updated' ? event.session.contextNoticeTokens : undefined))).toEqual([300_000, 400_000]);
    expect(noticeOf(manager)).toBe(400_000);
  });

  it('raises the highest threshold crossed at once when the first measure is already far past the first one', async () => {
    const manager = await createManager();

    contextGrowsTo(manager, 720_000);
    await stop(manager);

    expect(noticeOf(manager)).toBe(700_000);
    expect(noticeUpdatesOf(manager)).toHaveLength(1);
  });

  it('keeps the highest threshold when the context shrinks but stays past the first one', async () => {
    const manager = await createManager();
    contextGrowsTo(manager, 500_000);
    await stop(manager);

    contextGrowsTo(manager, 350_000);
    await stop(manager);

    expect(noticeOf(manager)).toBe(500_000);
  });

  it('measures the latest main-chain line, not the biggest one of the tail', async () => {
    const manager = await createManager();
    writeTranscript(manager, assistantLine({ contextTokens: 500_000 }), assistantLine({ contextTokens: 100_000 }));

    await stop(manager);

    expect(noticeOf(manager)).toBeUndefined();
  });

  it('lets the notice leave when a Stop measures the context under the first threshold after a compaction', async () => {
    const manager = await createManager();
    contextGrowsTo(manager, 450_000);
    await stop(manager);

    const updatesBeforeClear = updatesOf(manager).length;
    contextGrowsTo(manager, 60_000);
    await stop(manager);

    expect(noticeOf(manager)).toBeUndefined();
    expect(updatesOf(manager)).toHaveLength(updatesBeforeClear + 1);
    expect(noticeOfLastUpdate(manager)).toBeUndefined();
  });

  it('notifies again when the context grows back past the first threshold after it left', async () => {
    const manager = await createManager();
    contextGrowsTo(manager, 450_000);
    await stop(manager);
    contextGrowsTo(manager, 60_000);
    await stop(manager);

    contextGrowsTo(manager, 310_000);
    await stop(manager);

    expect(noticeOf(manager)).toBe(300_000);
  });

  it.each(['clear', 'compact'])('lets the notice leave at the SessionStart of a %s without waiting for the next Stop', async (source) => {
    const manager = await createManager();
    contextGrowsTo(manager, 450_000);
    await stop(manager);

    const updatesBeforeClear = updatesOf(manager).length;
    await sessionStart(manager, source);

    expect(noticeOf(manager)).toBeUndefined();
    expect(updatesOf(manager)).toHaveLength(updatesBeforeClear + 1);
    expect(noticeOfLastUpdate(manager)).toBeUndefined();
  });

  it.each(['startup', 'resume'])('keeps the notice at the SessionStart of a %s', async (source) => {
    const manager = await createManager();
    contextGrowsTo(manager, 450_000);
    await stop(manager);

    await sessionStart(manager, source);

    expect(noticeOf(manager)).toBe(400_000);
  });

  it.each([
    { hook_event_name: 'UserPromptSubmit' },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} },
  ])('measures at Stop only: a $hook_event_name hook raises nothing whatever the transcript holds', async (hook) => {
    const manager = await createManager();
    contextGrowsTo(manager, 500_000);

    await postHook(manager, hook);

    expect(noticeOf(manager)).toBeUndefined();
  });

  it('still answers the Stop and ends the turn when the notice measure throws', async () => {
    const manager = await createManager();
    vi.spyOn(ContextNotice.prototype, 'measureAtStop').mockImplementation(() => { throw new Error('boom'); });

    const answer = await stop(manager);

    expect(answer).toEqual({});
    expect(sessionOf(manager).state).toBe('idle');
  });

  it('emits nothing when a clear finds no notice to remove', async () => {
    const manager = await createManager();
    const updatesBefore = updatesOf(manager).length;

    await sessionStart(manager, 'clear');

    expect(updatesOf(manager)).toHaveLength(updatesBefore);
  });
});

describe('user sees a notice for the sessions the settings watch and for no other', () => {
  it('raises no notice for a child at 500,000 tokens', async () => {
    const manager = await createManager();
    const child = await createChildOf(manager);
    contextGrowsTo(child, 500_000);

    await stop(child);

    expect(noticeOf(child)).toBeUndefined();
  });

  it('raises no notice for a plain session that has no parent and no manager row', async () => {
    const plain = await createPlainSession();
    contextGrowsTo(plain, 500_000);

    await stop(plain);

    expect(noticeOf(plain)).toBeUndefined();
  });

  it('watches children and plain sessions when the roles setting enables them, and stops watching managers when it disables them', async () => {
    await server.close();
    await boot({ ...DEFAULT_SETTINGS, roles: { manager: false, child: true, plain: true } });
    const manager = await createManager();
    const child = await createChildOf(manager);
    const plain = await createPlainSession();
    for (const id of [manager, child, plain]) contextGrowsTo(id, 500_000);

    for (const id of [manager, child, plain]) await stop(id);

    expect(noticeOf(manager)).toBeUndefined();
    expect(noticeOf(child)).toBe(500_000);
    expect(noticeOf(plain)).toBe(500_000);
  });

  it('follows firstAt and every from the settings', async () => {
    await server.close();
    await boot({ ...DEFAULT_SETTINGS, firstAt: 20_000, every: 5_000 });
    const manager = await createManager();

    contextGrowsTo(manager, 19_999);
    await stop(manager);
    const noticeJustBelow = noticeOf(manager);
    contextGrowsTo(manager, 20_000);
    await stop(manager);
    const firstNotice = noticeOf(manager);
    contextGrowsTo(manager, 24_999);
    await stop(manager);
    const noticeJustBelowNextStep = noticeOf(manager);
    contextGrowsTo(manager, 25_000);
    await stop(manager);

    expect([noticeJustBelow, firstNotice, noticeJustBelowNextStep, noticeOf(manager)]).toEqual([undefined, 20_000, 20_000, 25_000]);
  });

  it('follows the override of the model alias of the session, field by field, and the global values for another alias', async () => {
    await server.close();
    await boot({ ...DEFAULT_SETTINGS, models: { haiku: { firstAt: 120_000, every: 40_000 }, sonnet: { every: 50_000 } } });
    const onHaiku = await createManager('haiku');
    const onSonnet = await createManager('sonnet');
    const onDefaultModel = await createManager();
    contextGrowsTo(onHaiku, 165_000);
    contextGrowsTo(onSonnet, 355_000);
    contextGrowsTo(onDefaultModel, 355_000);

    for (const id of [onHaiku, onSonnet, onDefaultModel]) await stop(id);

    expect(noticeOf(onHaiku)).toBe(160_000);
    expect(noticeOf(onSonnet)).toBe(350_000);
    expect(noticeOf(onDefaultModel)).toBe(300_000);
  });
});

describe('user keeps every session running whatever its context size', () => {
  it('answers the Stop of a manager on opus at 900,000 tokens with an empty body, types nothing, relaunches nothing and keeps the session idle', async () => {
    const manager = await createManager('opus');
    const handlesBefore = harness.handles.length;
    contextGrowsTo(manager, 900_000);
    await postHook(manager, { hook_event_name: 'UserPromptSubmit' });

    const answer = await stop(manager);

    expect(answer).toEqual({});
    expect(noticeOf(manager)).toBe(900_000);
    expect(sessionOf(manager).state).toBe('idle');
    expect(typedBodies()).toEqual([]);
    expect(harness.handles).toHaveLength(handlesBefore);
  });
});

describe('the daemon trusts only the main chain of the session\'s own transcript', () => {
  it('ignores a forged sub-agent line reporting 900,000 tokens after the real main-chain line', async () => {
    const manager = await createManager();
    writeTranscript(manager, assistantLine({ contextTokens: 100_000 }), assistantLine({ contextTokens: 900_000, isSidechain: true }));

    await stop(manager);

    expect(noticeOf(manager)).toBeUndefined();
  });

  it('raises nothing when only sub-agent lines carry a usage', async () => {
    const manager = await createManager();
    writeTranscript(manager, assistantLine({ contextTokens: 900_000, isSidechain: true }));

    await stop(manager);

    expect(noticeOf(manager)).toBeUndefined();
  });

  it('raises nothing for a transcript outside the projects directory', async () => {
    const manager = await createManager();
    const outside = join(mkdtempSync(join(tmpdir(), 'of-cn-outside-')), `${manager}.jsonl`);
    writeFileSync(outside, assistantLine({ contextTokens: 900_000 }));

    const answer = await stop(manager, outside);

    expect(answer).toEqual({});
    expect(noticeOf(manager)).toBeUndefined();
  });

  it('raises nothing when the transcript is swapped for a symbolic link to a file outside the projects directory after a first measure', async () => {
    const manager = await createManager();
    contextGrowsTo(manager, 100_000);
    await stop(manager);
    const outside = join(mkdtempSync(join(tmpdir(), 'of-cn-outside-')), `${manager}.jsonl`);
    writeFileSync(outside, assistantLine({ contextTokens: 900_000 }));
    unlinkSync(transcriptOf(manager));
    symlinkSync(outside, transcriptOf(manager));

    await stop(manager);

    expect(noticeOf(manager)).toBeUndefined();
  });

  it('raises nothing for a transcript that is not the one of the session', async () => {
    const manager = await createManager();
    const foreign = join(projectsDirectory, 'another-conversation.jsonl');
    writeFileSync(foreign, assistantLine({ contextTokens: 900_000 }));

    await stop(manager, foreign);

    expect(noticeOf(manager)).toBeUndefined();
  });

  it('raises nothing and still lets the turn end when the transcript is missing', async () => {
    const manager = await createManager();

    const answer = await stop(manager);

    expect(answer).toEqual({});
    expect(noticeOf(manager)).toBeUndefined();
  });

  it('measures the previous main-chain line when the latest one carries no usage', async () => {
    const manager = await createManager();
    writeTranscript(manager, assistantLine({ contextTokens: 350_000 }), `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [] } })}\n`);

    await stop(manager);

    expect(noticeOf(manager)).toBe(300_000);
  });

  it('skips a synthetic line whose usage totals zero and measures the line before it', async () => {
    const manager = await createManager();
    writeTranscript(manager, assistantLine({ contextTokens: 350_000 }), assistantLine({ usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));

    await stop(manager);

    expect(noticeOf(manager)).toBe(300_000);
  });

  it.each([
    ['a missing field', { input_tokens: 400_000, cache_read_input_tokens: 0 }],
    ['a negative field', { input_tokens: 500_000, cache_creation_input_tokens: 0, cache_read_input_tokens: -1 }],
    ['a string field', { input_tokens: '500000', cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }],
    ['a fractional field', { input_tokens: 500_000.5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }],
    ['a null usage', null],
  ])('raises nothing for a usage with %s', async (_label, usage) => {
    const manager = await createManager();
    writeTranscript(manager, assistantLine({ usage }));

    await stop(manager);

    expect(noticeOf(manager)).toBeUndefined();
  });

  it('skips a torn or non-JSON line and lines that are not assistant lines', async () => {
    const manager = await createManager();
    writeTranscript(manager, assistantLine({ contextTokens: 350_000 }), `${JSON.stringify({ type: 'user', message: { usage: { input_tokens: 900_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n`, 'not json\n', '{"type":"assistant","message":{"usage":{"input_tok');

    await stop(manager);

    expect(noticeOf(manager)).toBe(300_000);
  });

  it('reads the line appended after the first measure at the next Stop', async () => {
    const manager = await createManager();
    contextGrowsTo(manager, 310_000);
    await stop(manager);

    appendFileSync(transcriptOf(manager), assistantLine({ contextTokens: 410_000 }));
    await stop(manager);

    expect(noticeOf(manager)).toBe(400_000);
  });
});

describe('the notice stays right on a huge transcript and at the bounds of the settings', () => {
  const TAIL_WINDOW_OVERFLOW_BYTES = 1024 * 1024;
  const oldLines = (bytes: number) => assistantLine({ contextTokens: 100_000 }).repeat(Math.ceil(bytes / assistantLine({ contextTokens: 100_000 }).length));

  it('measures the last line of a transcript far bigger than the tail window', async () => {
    const manager = await createManager();
    writeTranscript(manager, oldLines(TAIL_WINDOW_OVERFLOW_BYTES), assistantLine({ contextTokens: 350_000 }));

    await stop(manager);

    expect(noticeOf(manager)).toBe(300_000);
  });

  it('raises nothing and still answers the Stop when the last line alone is bigger than the tail window', async () => {
    const manager = await createManager();
    const hugeLastLine = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(TAIL_WINDOW_OVERFLOW_BYTES) } })}\n`;
    writeTranscript(manager, assistantLine({ contextTokens: 350_000 }), hugeLastLine);

    const answer = await stop(manager);

    expect(answer).toEqual({});
    expect(noticeOf(manager)).toBeUndefined();
  });

  it('treats a transcript of one endless unterminated line as unreadable, not as a crash', async () => {
    const manager = await createManager();
    writeTranscript(manager, '{'.repeat(TAIL_WINDOW_OVERFLOW_BYTES));

    const answer = await stop(manager);

    expect(answer).toEqual({});
    expect(noticeOf(manager)).toBeUndefined();
  });

  it('raises the notice at the lowest allowed thresholds: 1,000 first, 2,000 next, none at 999 or 1,999', async () => {
    await server.close();
    await boot({ ...DEFAULT_SETTINGS, firstAt: 1_000, every: 1_000 });
    const manager = await createManager();
    const contextOf = (inputTokens: number) => writeTranscript(manager, assistantLine({ usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));

    contextOf(999);
    await stop(manager);
    const noticeJustBelow = noticeOf(manager);
    contextOf(1_000);
    await stop(manager);
    const firstNotice = noticeOf(manager);
    contextOf(1_999);
    await stop(manager);
    const noticeJustBelowNextStep = noticeOf(manager);
    contextOf(2_000);
    await stop(manager);

    expect([noticeJustBelow, firstNotice, noticeJustBelowNextStep, noticeOf(manager)]).toEqual([undefined, 1_000, 1_000, 2_000]);
  });

  it('raises the notice at the highest allowed threshold of 10,000,000 and none just under it', async () => {
    await server.close();
    await boot({ ...DEFAULT_SETTINGS, firstAt: 10_000_000, every: 10_000_000 });
    const manager = await createManager();

    contextGrowsTo(manager, 9_999_999);
    await stop(manager);
    const noticeJustBelow = noticeOf(manager);
    contextGrowsTo(manager, 10_000_000);
    await stop(manager);

    expect([noticeJustBelow, noticeOf(manager)]).toEqual([undefined, 10_000_000]);
  });

  it('keeps the session list readable when a usage adds up past the safe integer range', async () => {
    const manager = await createManager();
    writeTranscript(manager, assistantLine({ usage: { input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: Number.MAX_SAFE_INTEGER } }));

    const answer = await stop(manager);

    expect(answer).toEqual({});
    expect(() => sessions.list()).not.toThrow();
  });

  it('takes no reading from a usage that adds up past the safe integer range and does not fall back to the line before it', async () => {
    const manager = await createManager();
    const hostileUsage = { input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: Number.MAX_SAFE_INTEGER };
    writeTranscript(manager, assistantLine({ contextTokens: 350_000 }), assistantLine({ usage: hostileUsage }));

    await stop(manager);

    expect(noticeOf(manager)).toBeUndefined();
  });

  it('takes no reading from a context above the 10,000,000 settings cap and does not fall back to an older line, which could clear a notice the real context still deserves', async () => {
    const manager = await createManager();
    contextGrowsTo(manager, 450_000);
    await stop(manager);
    writeTranscript(manager, assistantLine({ contextTokens: 100_000 }), assistantLine({ contextTokens: 10_000_001 }));

    await stop(manager);

    expect(noticeOf(manager)).toBe(400_000);
  });

  describe('after a /compact the lines written before the compact boundary are not the context any more', () => {
    const compactBoundaryLine = `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: false })}\n`;
    const zeroUsage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    it('keeps the notice cleared when the first Stop after a compact runs before the answer is flushed', async () => {
      const manager = await createManager();
      contextGrowsTo(manager, 450_000);
      await stop(manager);
      await sessionStart(manager, 'compact');
      appendFileSync(transcriptOf(manager), compactBoundaryLine);

      await stop(manager);

      expect(noticeOf(manager)).toBeUndefined();
    });

    it('keeps the notice cleared when the first turn after a compact ends on a synthetic zero-usage line', async () => {
      const manager = await createManager();
      contextGrowsTo(manager, 450_000);
      await stop(manager);
      await sessionStart(manager, 'compact');
      appendFileSync(transcriptOf(manager), compactBoundaryLine + assistantLine({ usage: zeroUsage }));

      await stop(manager);

      expect(noticeOf(manager)).toBeUndefined();
    });

    it('measures a line written after the compact boundary', async () => {
      const manager = await createManager();
      writeTranscript(manager, assistantLine({ contextTokens: 450_000 }), compactBoundaryLine, assistantLine({ contextTokens: 350_000 }));

      await stop(manager);

      expect(noticeOf(manager)).toBe(300_000);
    });
  });

  it('emits one notice, not several, when concurrent Stops measure the same transcript', async () => {
    const manager = await createManager();
    contextGrowsTo(manager, 350_000);

    await Promise.all([stop(manager), stop(manager), stop(manager)]);

    expect(noticeUpdatesOf(manager)).toHaveLength(1);
    expect(noticeOf(manager)).toBe(300_000);
  });
});
