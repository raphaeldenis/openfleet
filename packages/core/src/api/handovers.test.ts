import type { DatabaseSync } from 'node:sqlite';
import type { Handover } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PULSE_MESSAGE, PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { wrapAgentMessage } from '../sessions/messageEnvelope.js';
import { SessionService } from '../sessions/sessionService.js';
import { HandoverLedger } from '../workingState/handoverLedger.js';
import { startServer } from './server.js';

const DESIGN_LINK = 'https://claude.ai/design/abc123XYZ';
const SPEC_PATH = '~/Documents/superpowers/openfleet/specs/2026-09-29-state-01-working-state-design.md';
const PLAN_PATH = '/Users/chicko/Documents/superpowers/openfleet/plans/2026-09-30-plan.md';

interface Fixture { server: Awaited<ReturnType<typeof startServer>>; db: DatabaseSync; sessions: SessionService; setNow: (epochMs: number) => void }

let fx: Fixture;
let sessionId: string;
let hookToken: string;

async function startFixture(patterns?: RegExp[]): Promise<Fixture> {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus, timeoutMs: 100 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  let nowMs = Date.parse('2026-09-30T10:00:00.000Z');
  const handoverLedger = new HandoverLedger({ db, clock: () => new Date(nowMs).toISOString(), patterns });
  const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', handoverLedger });
  return { server, db, sessions, setNow: (epochMs) => { nowMs = epochMs; } };
}

interface HookAnswer { hookSpecificOutput?: { hookEventName: string; additionalContext: string }; decision?: string }

const hookTokenOf = (id: string) => (fx.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as { hook_token: string }).hook_token;
const postHook = async (body: Record<string, unknown>, token = hookToken) => {
  const response = await fetch(`${fx.server.url}/hooks/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
  return response.json() as Promise<HookAnswer>;
};
const humanTypes = (prompt: string, token = hookToken) => postHook({ hook_event_name: 'UserPromptSubmit', prompt }, token);
const reminderOf = (answer: HookAnswer) => answer.hookSpecificOutput?.additionalContext;
const api = (path: string, init: RequestInit = {}) => fetch(`${fx.server.url}${path}`, { ...init, headers: { authorization: 'Bearer admin', ...(init.headers ?? {}) } });
const handoversOf = async (id: string) => (await (await api(`/api/sessions/${id}/handovers`)).json()) as Handover[];
const valuesOf = async (id: string) => (await handoversOf(id)).map((handover) => handover.value);
const storedRowCount = () => (fx.db.prepare('SELECT COUNT(*) AS n FROM handovers').get() as { n: number }).n;

beforeEach(async () => {
  fx = await startFixture();
  const session = await fx.sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
  sessionId = session.id;
  hookToken = hookTokenOf(session.id);
});
afterEach(() => fx.server.close());

describe('user can hand a design link or a spec path to a session and the daemon records it once', () => {
  it('records a design link typed by the human and reminds the agent to note it', async () => {
    const answer = await humanTypes(`Here is the design ${DESIGN_LINK} please build it`);

    expect(await handoversOf(sessionId)).toEqual([expect.objectContaining({ sessionId, kind: 'design_link', value: DESIGN_LINK, createdAt: '2026-09-30T10:00:00.000Z' })]);
    expect(answer.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(reminderOf(answer)).toContain(`Handover recorded: ${DESIGN_LINK}`);
    expect(reminderOf(answer)).toBe(`Handover recorded: ${DESIGN_LINK}. If you keep a backlog or notes, record it there in this turn.`);
  });

  it('records a spec path and a plan path from one prompt, each with its own kind', async () => {
    const answer = await humanTypes(`Read ${SPEC_PATH} then ${PLAN_PATH}`);

    const handovers = await handoversOf(sessionId);
    expect(handovers.map(({ kind, value }) => ({ kind, value }))).toEqual(expect.arrayContaining([{ kind: 'doc_path', value: SPEC_PATH }, { kind: 'doc_path', value: PLAN_PATH }]));
    expect(handovers).toHaveLength(2);
    expect(reminderOf(answer)).toContain(SPEC_PATH);
    expect(reminderOf(answer)).toContain(PLAN_PATH);
  });

  it('strips the punctuation that follows a link in a sentence', async () => {
    await humanTypes(`See (${DESIGN_LINK}), then ${SPEC_PATH}.`);

    expect((await valuesOf(sessionId)).sort()).toEqual([DESIGN_LINK, SPEC_PATH].sort());
  });

  it.each(['.', '!', ',', ';', ':', '?'])('records a link without the %s that ends the sentence', async (punctuation) => {
    await humanTypes(`have a look at ${DESIGN_LINK}${punctuation}`);

    expect(await valuesOf(sessionId)).toEqual([DESIGN_LINK]);
  });

  it('ignores a folder that merely ends in specs or plans', async () => {
    await humanTypes('see docs/myspecs/notes.md and old/subplans/x.md');

    expect(await handoversOf(sessionId)).toEqual([]);
  });

  it('records a spec path relative to the working directory', async () => {
    await humanTypes('follow specs/design.md and (plans/roadmap.md)');

    expect((await valuesOf(sessionId)).sort()).toEqual(['plans/roadmap.md', 'specs/design.md']);
  });

  it('ignores a markdown file that is not under a specs or plans folder, and a claude.ai link that is not a design', async () => {
    const answer = await humanTypes('see README.md and docs/notes.md and https://claude.ai/chat/xyz and https://example.com/design/abc');

    expect(await handoversOf(sessionId)).toEqual([]);
    expect(reminderOf(answer)).toBeUndefined();
  });

  it('records nothing and adds no reminder when the same link is sent again, even inside a longer prompt', async () => {
    await humanTypes(DESIGN_LINK);

    const again = await humanTypes(`reminder: ${DESIGN_LINK}`);
    const twiceInOnePrompt = await humanTypes(`${SPEC_PATH} and again ${SPEC_PATH}`);

    expect(await valuesOf(sessionId)).toHaveLength(2);
    expect(reminderOf(again)).toBeUndefined();
    expect(reminderOf(twiceInOnePrompt)?.match(/Handover recorded/g)).toHaveLength(1);
  });

  it('reminds only about the new value when a prompt carries a known link and a new one', async () => {
    await humanTypes(DESIGN_LINK);

    const answer = await humanTypes(`${DESIGN_LINK} and ${SPEC_PATH}`);

    expect(reminderOf(answer)).toContain(SPEC_PATH);
    expect(reminderOf(answer)).not.toContain(DESIGN_LINK);
  });

  it('keeps each session ledger apart: the same link handed to two sessions is recorded for both', async () => {
    const other = await fx.sessions.create({ directory: '/tmp', name: 'Other', harness: 'fake', emoji: '🤖' });

    await humanTypes(DESIGN_LINK);
    await humanTypes(DESIGN_LINK, hookTokenOf(other.id));

    expect(await valuesOf(sessionId)).toEqual([DESIGN_LINK]);
    expect(await valuesOf(other.id)).toEqual([DESIGN_LINK]);
  });
});

describe('user is protected from handovers the human never typed', () => {
  it('records nothing from an agent message, even one quoting a design link', async () => {
    const agentMessage = wrapAgentMessage({ fromSessionId: 'aaaaaaaa-1111', fromBranch: 'main', messageId: 'm1', body: `please look at ${DESIGN_LINK} and ${SPEC_PATH}` });

    const answer = await humanTypes(agentMessage);

    expect(await handoversOf(sessionId)).toEqual([]);
    expect(reminderOf(answer)).toBeUndefined();
  });

  it('records nothing from a daemon pulse line, and nothing from a pulse that carries a link', async () => {
    await humanTypes(PULSE_MESSAGE);
    await humanTypes(`[pulse] check ${DESIGN_LINK}`);
    await humanTypes(`  [pulse] leading blanks ${SPEC_PATH}`);

    expect(storedRowCount()).toBe(0);
  });

  it('records a link the human types after a pulse, so the pulse filter is not sticky', async () => {
    await humanTypes(PULSE_MESSAGE);

    await humanTypes(DESIGN_LINK);

    expect(await valuesOf(sessionId)).toEqual([DESIGN_LINK]);
  });

  it('records nothing when the hook carries no prompt, only the legacy user_prompt, or a non-string prompt', async () => {
    await postHook({ hook_event_name: 'UserPromptSubmit' });
    await postHook({ hook_event_name: 'UserPromptSubmit', user_prompt: DESIGN_LINK });
    const answer = await postHook({ hook_event_name: 'UserPromptSubmit', prompt: 42 });

    expect(storedRowCount()).toBe(0);
    expect(answer).toEqual({});
  });

  it('records nothing for an unknown hook token or a closed session, and answers {}', async () => {
    const unknown = await humanTypes(DESIGN_LINK, 'no-such-token');
    await fx.sessions.close(sessionId);
    const closed = await humanTypes(DESIGN_LINK);

    expect(unknown).toEqual({});
    expect(closed).toEqual({});
    expect(storedRowCount()).toBe(0);
  });

  it('still answers the hook and applies it when the ledger cannot record', async () => {
    fx.db.exec('DROP TABLE handovers');

    const answer = await humanTypes(DESIGN_LINK);

    expect(answer).toEqual({});
    expect(fx.sessions.list().find((session) => session.id === sessionId)!.state).toBe('generating');
  });

  it('answers {} to every other hook event, even with a link in the payload', async () => {
    const answer = await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: DESIGN_LINK });

    expect(answer).toEqual({});
    expect(storedRowCount()).toBe(0);
  });
});

describe('user is protected from prompts the daemon supplied to the session itself', () => {
  const briefWithLinks = `Review the work, spec ${SPEC_PATH} and design ${DESIGN_LINK}`;
  const createChild = (seededPrompt: string) => fx.sessions.create({ directory: '/tmp', name: 'Child', harness: 'fake', emoji: '🤖', seededPrompt });

  it('records nothing and adds no reminder for the seeded prompt the CLI submits first, then records a human prompt with the same link once', async () => {
    const child = await createChild(briefWithLinks);
    const childToken = hookTokenOf(child.id);

    const seededAnswer = await humanTypes(briefWithLinks, childToken);
    const seededWithBlanksAnswer = await humanTypes(`\n${briefWithLinks}  \n`, childToken);
    const humanAnswer = await humanTypes(`please use ${DESIGN_LINK}`, childToken);
    const humanAgain = await humanTypes(`again ${DESIGN_LINK}`, childToken);

    expect(reminderOf(seededAnswer)).toBeUndefined();
    expect(reminderOf(seededWithBlanksAnswer)).toBeUndefined();
    expect(reminderOf(humanAnswer)).toContain(DESIGN_LINK);
    expect(reminderOf(humanAgain)).toBeUndefined();
    expect(await valuesOf(child.id)).toEqual([DESIGN_LINK]);
  });

  it('records nothing for a seeded prompt the CLI prefixes with its own preamble', async () => {
    const child = await createChild(briefWithLinks);

    await humanTypes(`${briefWithLinks}\n\nextra line`, hookTokenOf(child.id));

    expect(await valuesOf(child.id)).toEqual([]);
  });

  it('records a human prompt on a session created without a seeded prompt or with a blank one', async () => {
    const blank = await createChild('   ');

    await humanTypes(DESIGN_LINK, hookTokenOf(blank.id));

    expect(await valuesOf(blank.id)).toEqual([DESIGN_LINK]);
  });

  it('records nothing for the mission of a sub-manager session', async () => {
    const manager = await fx.sessions.create({ directory: '/tmp', name: 'Sub', harness: 'fake', emoji: '🤖', seededPrompt: `Mission: follow ${SPEC_PATH}` });

    await humanTypes(`Mission: follow ${SPEC_PATH}`, hookTokenOf(manager.id));

    expect(storedRowCount()).toBe(0);
  });
});

describe('user can rely on the ledger bounds', () => {
  it('records ten of fifty links in one prompt, and never stores or logs the prompt text', async () => {
    const links = Array.from({ length: 50 }, (_, index) => `https://claude.ai/design/link${index}`);
    const secretSentence = 'zx-private-sentence-zx';

    const answer = await humanTypes(`${secretSentence} ${links.join(' ')}`);

    expect(await valuesOf(sessionId)).toHaveLength(10);
    expect(reminderOf(answer)?.match(/Handover recorded/g)).toHaveLength(10);
    const everyStoredCell = JSON.stringify(fx.db.prepare('SELECT * FROM handovers').all());
    expect(everyStoredCell).not.toContain(secretSentence);
    const otherTables = (fx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((table) => table.name);
    for (const table of otherTables) expect(JSON.stringify(fx.db.prepare(`SELECT * FROM "${table}"`).all())).not.toContain(secretSentence);
  });

  it('counts only new values against the ten: a second prompt records the next ten', async () => {
    const links = Array.from({ length: 25 }, (_, index) => `https://claude.ai/design/link${index}`);

    await humanTypes(links.join(' '));
    await humanTypes(links.join(' '));

    expect(await valuesOf(sessionId)).toHaveLength(20);
  });

  it('skips a value longer than 500 characters and keeps one of exactly 500', async () => {
    const prefix = 'https://claude.ai/design/';
    const exactly500 = prefix + 'a'.repeat(500 - prefix.length);
    const tooLong = prefix + 'b'.repeat(501 - prefix.length);

    await humanTypes(`${tooLong} ${exactly500}`);

    expect(await valuesOf(sessionId)).toEqual([exactly500]);
  });

  it('scans the first 20000 characters of a prompt: a link at 19900 is recorded, one after 20000 is not', async () => {
    const filler = (length: number) => 'x'.repeat(length - 1) + ' ';

    await humanTypes(`${filler(19_900)}${DESIGN_LINK}`);
    await humanTypes(`${filler(20_100)}${SPEC_PATH}`);

    expect(await valuesOf(sessionId)).toEqual([DESIGN_LINK]);
  });

  it('scans a huge paste in bounded time and still records a link typed at its start', async () => {
    const hugePaste = `${DESIGN_LINK} ${'/specs/'.repeat(10_000)}`;
    const startedAt = Date.now();

    await humanTypes(hugePaste);

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(await valuesOf(sessionId)).toEqual([DESIGN_LINK]);
  });
});

describe('user can read the handovers of a session over REST', () => {
  it('lists the handovers newest first', async () => {
    await humanTypes(DESIGN_LINK);
    fx.setNow(Date.parse('2026-09-30T10:05:00.000Z'));
    await humanTypes(SPEC_PATH);
    await humanTypes(PLAN_PATH);

    const values = await valuesOf(sessionId);

    expect(values).toEqual([PLAN_PATH, SPEC_PATH, DESIGN_LINK]);
  });

  it('lists at most 50 handovers, the newest ones', async () => {
    for (let batch = 0; batch < 6; batch += 1) {
      fx.setNow(Date.parse('2026-09-30T10:00:00.000Z') + batch * 1000);
      await humanTypes(Array.from({ length: 10 }, (_, index) => `https://claude.ai/design/b${batch}-${index}`).join(' '));
    }

    const handovers = await handoversOf(sessionId);

    expect(handovers).toHaveLength(50);
    expect(handovers.every((handover) => !handover.value.includes('/b0-'))).toBe(true);
  });

  it('answers an empty list for a session with no handover and 404 not_found for an unknown session', async () => {
    const empty = await api(`/api/sessions/${sessionId}/handovers`);
    const unknown = await api('/api/sessions/no-such-session/handovers');

    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });
  });

  it('refuses a request without the admin token', async () => {
    const withoutToken = await fetch(`${fx.server.url}/api/sessions/${sessionId}/handovers`);
    const wrongToken = await api(`/api/sessions/${sessionId}/handovers`, { headers: { authorization: 'Bearer nope' } });

    expect(withoutToken.status).toBe(401);
    expect(wrongToken.status).toBe(401);
  });
});

describe('operator can override the handover patterns', () => {
  it('records what the configured pattern matches and no longer what the defaults matched', async () => {
    await fx.server.close();
    fx = await startFixture([/TICKET-\d+/g]);
    const session = await fx.sessions.create({ directory: '/tmp', name: 'Custom', harness: 'fake', emoji: '🤖' });

    const answer = await humanTypes(`fix TICKET-42 and ${DESIGN_LINK}`, hookTokenOf(session.id));

    expect(await valuesOf(session.id)).toEqual(['TICKET-42']);
    expect(reminderOf(answer)).toContain('TICKET-42');
  });

  it('records nothing when the operator configured an empty pattern list', async () => {
    await fx.server.close();
    fx = await startFixture([]);
    const session = await fx.sessions.create({ directory: '/tmp', name: 'None', harness: 'fake', emoji: '🤖' });

    await humanTypes(DESIGN_LINK, hookTokenOf(session.id));

    expect(storedRowCount()).toBe(0);
  });
});

describe('operator patterns that backtrack catastrophically cannot freeze the daemon', () => {
  const NESTED_GROUP_KILLERS = [/((x+))+y/g, /((?:x|x))+y/g, /(?:(x+))*y/g];
  const FAR_BELOW_THE_FREEZE_MS = 1000;
  const runOfXs = `${'x'.repeat(28)} TICKET-7`;

  it.each(NESTED_GROUP_KILLERS)('answers within a bounded time on %s, disables it with one warning, and keeps recording the other patterns', async (killer) => {
    await fx.server.close();
    fx = await startFixture([killer, /TICKET-\d+/g]);
    const session = await fx.sessions.create({ directory: '/tmp', name: 'Custom', harness: 'fake', emoji: '🤖' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const startedAt = Date.now();

    const answer = await humanTypes(runOfXs, hookTokenOf(session.id));
    const secondAnswer = await humanTypes(`${runOfXs} TICKET-8`, hookTokenOf(session.id));

    const elapsed = Date.now() - startedAt;
    const warnings = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(killer.source));
    warn.mockRestore();
    expect(elapsed).toBeLessThan(FAR_BELOW_THE_FREEZE_MS);
    expect(reminderOf(answer)).toContain('TICKET-7');
    expect(reminderOf(secondAnswer)).toContain('TICKET-8');
    expect(warnings).toHaveLength(1);
    expect(await valuesOf(session.id)).toEqual(['TICKET-8', 'TICKET-7']);
  });
});
