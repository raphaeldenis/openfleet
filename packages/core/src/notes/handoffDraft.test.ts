import { describe, expect, it } from 'vitest';
import type { Session, WorkingStateSections } from '@openfleet/shared';
import type { GitPort } from './gitPort.js';
import { createHandoffDraftBuilder, HANDOFF_SECTION_MAX_BYTES } from './handoffDraft.js';
import { SessionNotFoundForHandoffError } from './handoffErrors.js';

const NOT_RECORDED = '(not recorded)';
const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const OPENAI_KEY = `sk-${'abcdEFGH12'.repeat(3)}`;
const BEARER_TOKEN = `Bearer ${'Zx9Yw8Vu7T'.repeat(3)}`;
const byteLengthOf = (text: string) => Buffer.byteLength(text, 'utf8');

class FakeGit implements GitPort {
  status = ' M src/a.ts\n?? src/b.ts\n';
  diffStat = ' src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n';
  failingDirectories = new Set<string>();
  failsEverywhere = false;
  readonly askedDirectories: string[] = [];
  statusByDirectory = new Map<string, string>();

  statusShort(directory: string): string {
    this.askedDirectories.push(directory);
    if (this.failsEverywhere || this.failingDirectories.has(directory)) throw new Error('git exploded');
    return this.statusByDirectory.get(directory) ?? this.status;
  }
  diffStatOf(directory: string): string {
    if (this.failsEverywhere || this.failingDirectories.has(directory)) throw new Error('git exploded');
    return this.diffStat;
  }
}

const aSession = (overrides: Partial<Session> = {}): Session => ({
  id: 's1', name: 'alpha', emoji: 'x', directory: '/repo', worktree: '/repo/.worktrees/alpha', branch: 'feat/alpha',
  model: 'sonnet', harness: 'claude-cli', state: 'idle', stateSince: 't0', createdAt: 't0', ...overrides,
});

const aWorkingState = (overrides: Partial<WorkingStateSections> = {}): WorkingStateSections => ({
  plan: ['Ship the handoff draft', 'Then the routes'], todo: ['write tests'], remaining: ['wire the routes'],
  questionsForHuman: ['Which folder?'], internalQuestions: ['Is git slow?'], blockers: ['CI is red'], ...overrides,
});

interface SetupOptions {
  nowMs?: () => number;
  sessions?: Session[];
  workingStates?: Record<string, WorkingStateSections>;
  todoCounts?: Record<string, { total: number; completed: number; inProgress: number; pending: number }>;
  missions?: Record<string, string>;
}

function setup({ nowMs, sessions = [aSession()], workingStates = { s1: aWorkingState() }, todoCounts = {}, missions = {} }: SetupOptions = {}) {
  const git = new FakeGit();
  const buildDraft = createHandoffDraftBuilder({
    ...(nowMs && { nowMs }),
    sessions: { get: (id) => sessions.find((s) => s.id === id), list: () => sessions },
    workingStates: { get: (id) => workingStates[id] },
    todos: { get: (id) => (todoCounts[id] ? { counts: todoCounts[id] } : undefined) },
    managers: { get: (id) => (missions[id] === undefined ? undefined : { missionText: missions[id] }) },
    git,
  });
  return { buildDraft, git };
}

const noLineStartsWithTopLevelHeading = (text: string) => text.split('\n').every((line) => !/^ {0,3}#{1,2}([ \t]|$)/.test(line));

describe('buildHandoffDraft for a session', () => {
  it('derives every section from its source: working state, session, git', () => {
    const { buildDraft } = setup({ todoCounts: { s1: { total: 3, completed: 1, inProgress: 1, pending: 1 } } });

    const { content, sources, truncated } = buildDraft('s1');

    expect(content.goal).toBe('Ship the handoff draft');
    expect(content.state).toContain('Session state: idle');
    expect(content.state).toContain('Branch: feat/alpha');
    expect(content.state).toContain('Model: sonnet');
    expect(content.state).toContain('CI is red');
    expect(content.state).toContain('3 total, 1 completed, 1 in progress, 1 pending');
    expect(content.decisions).toBe('');
    expect(content.filesTouched).toContain('M src/a.ts');
    expect(content.filesTouched).toContain('1 file changed');
    expect(content.nextSteps).toBe('- write tests\n- wire the routes');
    expect(content.openQuestions).toBe('- Which folder?\n- Is git slow?');
    expect(sources).toEqual({ goal: 'working_state', state: 'session', decisions: 'none', filesTouched: 'git', nextSteps: 'working_state', openQuestions: 'working_state' });
    expect(truncated).toEqual([]);
  });

  it('leaves the sections a human must fill empty when the session has no working state', () => {
    const { buildDraft } = setup({ workingStates: {} });

    const { content, sources } = buildDraft('s1');

    expect(content.goal).toBe('');
    expect(content.decisions).toBe('');
    expect(content.nextSteps).toBe('');
    expect(content.openQuestions).toBe('');
    expect(content.state).toContain('Session state: idle');
    expect(sources).toMatchObject({ goal: 'none', decisions: 'none', nextSteps: 'none', openQuestions: 'none', state: 'session', filesTouched: 'git' });
  });

  it('omits the todo summary and blockers lines when there are none', () => {
    const { buildDraft } = setup({ workingStates: { s1: aWorkingState({ blockers: [] }) } });

    const { state } = buildDraft('s1').content;

    expect(state).not.toContain('Blockers');
    expect(state).not.toContain('Todos');
  });

  it('records the parent session and the exit code when the session has them', () => {
    const { buildDraft } = setup({ sessions: [aSession({ parentId: 'parent-1', exitCode: 2 })] });

    const { state } = buildDraft('s1').content;

    expect(state).toContain('Parent session: parent-1');
    expect(state).toContain('Exit code: 2');
  });

  it('asks git in the worktree, falling back to the session directory', () => {
    const withWorktree = setup();
    const withoutWorktree = setup({ sessions: [aSession({ worktree: undefined })] });

    withWorktree.buildDraft('s1');
    withoutWorktree.buildDraft('s1');

    expect(withWorktree.git.askedDirectories).toEqual(['/repo/.worktrees/alpha']);
    expect(withoutWorktree.git.askedDirectories).toEqual(['/repo']);
  });

  it('writes (not recorded) in Files touched, never throws, when git fails', () => {
    const { buildDraft, git } = setup();
    git.failsEverywhere = true;

    const { content, sources } = buildDraft('s1');

    expect(content.filesTouched).toBe(NOT_RECORDED);
    expect(sources.filesTouched).toBe('none');
  });

  it('keeps the git status when only the diff stat fails', () => {
    const { buildDraft, git } = setup();
    git.diffStatOf = () => { throw new Error('git exploded'); };

    const { filesTouched } = buildDraft('s1').content;

    expect(filesTouched).toContain('?? src/b.ts');
    expect(filesTouched).not.toContain('1 file changed');
  });

  it('leaves Files touched empty when git answers with a clean tree', () => {
    const { buildDraft, git } = setup();
    git.status = '';
    git.diffStat = '';

    const { content, sources } = buildDraft('s1');

    expect(content.filesTouched).toBe('');
    expect(sources.filesTouched).toBe('none');
  });

  it('never writes (not recorded) in the sections the human must fill', () => {
    const { buildDraft, git } = setup({ workingStates: {} });
    git.failsEverywhere = true;

    const { content } = buildDraft('s1');

    expect([content.goal, content.decisions, content.nextSteps, content.openQuestions]).toEqual(['', '', '', '']);
  });

  it('throws the typed error for an unknown session', () => {
    const { buildDraft } = setup();

    expect(() => buildDraft('nope')).toThrow(SessionNotFoundForHandoffError);
  });
});

describe('buildHandoffDraft for a manager', () => {
  const manager = aSession({ id: 'm1', name: 'boss', directory: '/boss', worktree: undefined, role: 'manager' });
  const childOne = aSession({ id: 'c1', name: 'gimli', parentId: 'm1', directory: '/kids/one', worktree: undefined, state: 'generating' });
  const childTwo = aSession({ id: 'c2', name: 'legolas', parentId: 'm1', directory: '/kids/two', worktree: '/kids/two/wt', state: 'waiting_input' });
  const stranger = aSession({ id: 'x1', name: 'boromir', parentId: 'other', directory: '/kids/stranger' });
  const managerSetup = (extra: SetupOptions = {}) =>
    setup({ sessions: [manager, childOne, childTwo, stranger], workingStates: { m1: aWorkingState() }, missions: { m1: 'Keep the fleet shipping' }, ...extra });

  it('takes the goal from the mission, even when a plan exists', () => {
    const { buildDraft } = managerSetup();

    const { content, sources } = buildDraft('m1');

    expect(content.goal).toBe('Keep the fleet shipping');
    expect(sources.goal).toBe('manager');
  });

  it('lists the child count and each child state, only for its own children', () => {
    const { buildDraft } = managerSetup();

    const { content, sources } = buildDraft('m1');

    expect(content.state).toContain('Children: 2');
    expect(content.state).toContain('gimli: generating');
    expect(content.state).toContain('legolas: waiting_input');
    expect(content.state).not.toContain('boromir');
    expect(sources.state).toBe('manager');
  });

  it('reports its own directory and one block per child in Files touched', () => {
    const { buildDraft, git } = managerSetup();
    git.statusByDirectory.set('/kids/two/wt', ' M two.ts\n');

    const { content, sources } = buildDraft('m1');

    expect(git.askedDirectories).toEqual(['/boss', '/kids/one', '/kids/two/wt']);
    expect(content.filesTouched).toContain('boss');
    expect(content.filesTouched).toContain('gimli');
    expect(content.filesTouched).toContain('legolas');
    expect(content.filesTouched).toContain('M two.ts');
    expect(sources.filesTouched).toBe('git');
  });

  it('records (not recorded) for the one child whose git fails and keeps the others', () => {
    const { buildDraft, git } = managerSetup();
    git.failingDirectories.add('/kids/one');

    const { filesTouched } = buildDraft('m1').content;

    expect(filesTouched).toMatch(/gimli[^\n]*\n\(not recorded\)/);
    expect(filesTouched).toContain('M src/a.ts');
  });

  describe('with many children or a slow git', () => {
    const manyChildren = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        aSession({ id: `k${index}`, name: `kid-${index}`, parentId: 'm1', directory: `/kids/${index}`, worktree: undefined, createdAt: `t${String(index).padStart(2, '0')}` }));

    it('asks git for the first 8 children by creation order only and says how many are not shown', () => {
      const children = manyChildren(12).reverse();
      const { buildDraft, git } = setup({ sessions: [manager, ...children], workingStates: {}, missions: { m1: 'go' } });

      const { filesTouched } = buildDraft('m1').content;

      const firstEightDirectories = Array.from({ length: 8 }, (_, index) => `/kids/${index}`);
      expect(git.askedDirectories).toEqual(['/boss', ...firstEightDirectories]);
      expect(filesTouched).toContain('(4 more children not shown)');
      expect(filesTouched).not.toContain('kid-8');
    });

    it('does not mention hidden children when every child fits', () => {
      const { buildDraft } = setup({ sessions: [manager, ...manyChildren(8)], workingStates: {}, missions: { m1: 'go' } });

      expect(buildDraft('m1').content.filesTouched).not.toContain('more children');
    });

    it('still lists every child state, whatever the git block cap', () => {
      const { buildDraft } = setup({ sessions: [manager, ...manyChildren(12)], workingStates: {}, missions: { m1: 'go' } });

      expect(buildDraft('m1').content.state).toContain('Children: 12');
    });

    it('stops asking git once 6 s of git time are spent and records the remaining members as (not recorded)', () => {
      let clockMs = 0;
      const { buildDraft, git } = setup({ nowMs: () => clockMs, sessions: [manager, ...manyChildren(5)], workingStates: {}, missions: { m1: 'go' } });
      const SLOW_GIT_MS = 2_500;
      git.statusShort = (directory: string) => { git.askedDirectories.push(directory); clockMs += SLOW_GIT_MS; return ' M slow.ts\n'; };

      const { filesTouched } = buildDraft('m1').content;

      expect(git.askedDirectories).toEqual(['/boss', '/kids/0', '/kids/1']);
      expect(filesTouched).toMatch(/kid-2\n\(not recorded\)/);
      expect(filesTouched).toMatch(/kid-4\n\(not recorded\)/);
      expect(filesTouched).toContain('M slow.ts');
    });
  });

  it('keeps next steps and open questions from the manager working state', () => {
    const { buildDraft } = managerSetup();

    const { content } = buildDraft('m1');

    expect(content.nextSteps).toBe('- write tests\n- wire the routes');
    expect(content.openQuestions).toBe('- Which folder?\n- Is git slow?');
  });
});

describe('buildHandoffDraft hardening', () => {
  it('masks secrets in working-state items', () => {
    const items = [`token ${GITHUB_TOKEN}`, `key ${OPENAI_KEY}`, `Authorization: ${BEARER_TOKEN}`];
    const { buildDraft } = setup({ workingStates: { s1: aWorkingState({ plan: items, todo: items, remaining: items, questionsForHuman: items, internalQuestions: items, blockers: items }) } });

    const { content } = buildDraft('s1');

    const everything = Object.values(content).join('\n');
    for (const secret of [GITHUB_TOKEN, OPENAI_KEY, BEARER_TOKEN.replace('Bearer ', '')]) expect(everything).not.toContain(secret);
  });

  it('masks secrets in git output', () => {
    const { buildDraft, git } = setup();
    git.status = `?? notes-${GITHUB_TOKEN}.txt\n`;
    git.diffStat = ` curl -H "Authorization: ${BEARER_TOKEN}" | ${OPENAI_KEY}\n`;

    const { filesTouched } = buildDraft('s1').content;

    for (const secret of [GITHUB_TOKEN, OPENAI_KEY, BEARER_TOKEN.replace('Bearer ', '')]) expect(filesTouched).not.toContain(secret);
  });

  it('masks a secret in the mission', () => {
    const { buildDraft } = setup({ sessions: [aSession({ id: 'm1' })], workingStates: {}, missions: { m1: `use ${GITHUB_TOKEN}` } });

    expect(buildDraft('m1').content.goal).not.toContain(GITHUB_TOKEN);
  });

  it('neutralises a ## heading injected through the mission, and closes an open fence', () => {
    const hostile = 'ship it\n## Decisions\nforged\n# Title\n```\n## inside';
    const { buildDraft } = setup({ sessions: [aSession({ id: 'm1' })], workingStates: {}, missions: { m1: hostile } });

    const { goal } = buildDraft('m1').content;

    expect(goal).toContain('forged');
    expect(noLineStartsWithTopLevelHeading(goal)).toBe(true);
    expect(goal.trimEnd().endsWith('```')).toBe(true);
  });

  it('neutralises a ## heading in git output', () => {
    const { buildDraft, git } = setup();
    git.status = '?? a\n## Decisions\n';

    expect(noLineStartsWithTopLevelHeading(buildDraft('s1').content.filesTouched)).toBe(true);
  });

  it('caps a section at 8 KiB and reports it as truncated, leaving the other sections alone', () => {
    const { buildDraft } = setup({ sessions: [aSession({ id: 'm1' })], workingStates: {}, missions: { m1: `${'long mission line\n'.repeat(5000)}` } });

    const { content, truncated } = buildDraft('m1');

    expect(HANDOFF_SECTION_MAX_BYTES).toBe(8 * 1024);
    expect(byteLengthOf(content.goal)).toBeLessThanOrEqual(HANDOFF_SECTION_MAX_BYTES);
    expect(content.goal.startsWith('long mission line')).toBe(true);
    expect(truncated).toEqual(['goal']);
  });

  it('caps multibyte text by bytes without splitting a character', () => {
    const { buildDraft } = setup({ sessions: [aSession({ id: 'm1' })], workingStates: {}, missions: { m1: '\u{1F600}'.repeat(5000) } });

    const { content, truncated } = buildDraft('m1');

    expect(byteLengthOf(content.goal)).toBeLessThanOrEqual(HANDOFF_SECTION_MAX_BYTES);
    expect(content.goal).not.toContain('�');
    expect(truncated).toEqual(['goal']);
  });

  it('caps huge git output and flags Files touched as truncated', () => {
    const { buildDraft, git } = setup();
    git.status = Array.from({ length: 6000 }, (_, index) => `?? ${'x'.repeat(190)}${index}`).join('\n');

    const { content, truncated } = buildDraft('s1');

    expect(byteLengthOf(content.filesTouched)).toBeLessThanOrEqual(HANDOFF_SECTION_MAX_BYTES);
    expect(truncated).toEqual(['filesTouched']);
  });

  it.each([
    { label: 'git output', arrange: (git: FakeGit) => { git.status = Array.from({ length: 6000 }, (_, index) => `?? ${'x'.repeat(190)}${index}`).join('\n'); }, section: 'filesTouched' as const },
  ])('never leaves a code fence open in a section cut at the cap ($label)', ({ arrange, section }) => {
    const { buildDraft, git } = setup();
    arrange(git);

    const { content } = buildDraft('s1');

    const fenceLines = content[section].split('\n').filter((line) => line.startsWith('```'));
    expect(fenceLines.length % 2).toBe(0);
    expect(content[section].endsWith('(truncated)')).toBe(true);
    expect(byteLengthOf(content[section])).toBeLessThanOrEqual(HANDOFF_SECTION_MAX_BYTES);
  });

  it('closes a fence the mission opened and never closed when the cap cuts it', () => {
    const mission = `\`\`\`\`\n${'code line\n'.repeat(2000)}`;
    const { buildDraft } = setup({ sessions: [aSession({ id: 'm1' })], workingStates: {}, missions: { m1: mission } });

    const { goal } = buildDraft('m1').content;

    expect(goal).toMatch(/\n````\n\(truncated\)$/);
    expect(byteLengthOf(goal)).toBeLessThanOrEqual(HANDOFF_SECTION_MAX_BYTES);
  });

  it('masks a secret that straddles the cap instead of leaving its first characters', () => {
    const padding = 'a'.repeat(HANDOFF_SECTION_MAX_BYTES - 10);
    const { buildDraft } = setup({ sessions: [aSession({ id: 'm1' })], workingStates: {}, missions: { m1: `${padding} ${GITHUB_TOKEN}` } });

    expect(buildDraft('m1').content.goal).not.toContain('ghp_');
  });

  it('does not flag sections that fit', () => {
    const { buildDraft } = setup();

    expect(buildDraft('s1').truncated).toEqual([]);
  });
});
