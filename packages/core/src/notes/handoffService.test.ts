import { describe, expect, it } from 'vitest';
import type { HandoffContent, ServerEvent, Session, WorkingStateSections } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import type { DocsFolderFs } from './docsFolderFs.js';
import { DocsFolderService } from './docsFolderService.js';
import { createHandoffDraftBuilder } from './handoffDraft.js';
import { HandoffService, SessionNotFoundForHandoffError, registerHandoffOnClose, type GitPort } from './handoffService.js';
import { expandMentions } from './mentionExpander.js';
import { NoteRepository } from './noteRepository.js';
import { listSections } from './noteSections.js';
import { NoteService, NoteTooLargeError } from './noteService.js';

const AUTHOR = 'agent:s1';
const NOW = '2026-01-15T10:00:00.000Z';
const MINUTE_MS = 60_000;
const NOT_RECORDED = '(not recorded)';

class FakeFs implements DocsFolderFs {
  readonly files = new Map<string, string>();
  readFileSync(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }
  writeFileExclusiveSync(path: string, contents: string): void {
    if (this.files.has(path)) throw new Error(`EEXIST: ${path}`);
    this.files.set(path, contents);
  }
  renameSync(fromPath: string, toPath: string): void {
    this.files.set(toPath, this.readFileSync(fromPath));
    this.files.delete(fromPath);
  }
  unlinkSync(path: string): void { this.files.delete(path); }
  existsSync(path: string): boolean { return this.files.has(path); }
  mkdirSync(): void {}
  realpathSync(path: string): string { return path; }
  listFilesSync(): string[] { return []; }
  watch(): () => void { return () => {}; }
}

class FakeGit implements GitPort {
  status = ' M src/a.ts\n?? src/b.ts\n';
  diffStat = ' src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n';
  fails = false;
  statusFails = false;
  diffStatFails = false;
  readonly askedDirectories: string[] = [];
  statusShort(directory: string): string {
    this.askedDirectories.push(directory);
    if (this.fails || this.statusFails) throw new Error('git exploded');
    return this.status;
  }
  diffStatOf(): string {
    if (this.fails || this.diffStatFails) throw new Error('git exploded');
    return this.diffStat;
  }
}

function aSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'alpha', emoji: 'x', directory: '/repo', worktree: '/repo/.worktrees/alpha', branch: 'feat/alpha',
    model: 'sonnet', projectId: 'p1', harness: 'claude', state: 'idle', stateSince: 't0', createdAt: 't0', ...overrides,
  } as Session;
}

const fullContent = (overrides: Partial<HandoffContent> = {}): HandoffContent => ({
  goal: 'Ship X', state: 'idle', decisions: 'used approach A', filesTouched: 'a.ts', nextSteps: 'none', openQuestions: 'none', ...overrides,
});

const aWorkingState = (overrides: Partial<WorkingStateSections> = {}): WorkingStateSections => ({
  plan: ['Ship X'], todo: ['write the tests'], remaining: ['wire the routes'], questionsForHuman: ['Which folder?'], internalQuestions: [], blockers: [], ...overrides,
});

function setup({ docsFolderPath = '/docs' as string | null, sessions = [aSession()], projectName = 'Project One', workingStates = {} as Record<string, WorkingStateSections> } = {}) {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: projectName, docsFolderPath, createdAt: 't0' });
  const noteRepo = new NoteRepository(db);
  let tick = 0;
  let sequence = 0;
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => `t${tick++}`, newId: () => `id-${sequence++}` });
  const fs = new FakeFs();
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs, clock: () => NOW });
  const git = new FakeGit();
  let nowMs = Date.parse(NOW);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const buildDraft = createHandoffDraftBuilder({
    sessions: { get: (id) => byId.get(id), list: () => [...byId.values()] },
    workingStates: { get: (id) => workingStates[id] },
    todos: { get: () => undefined },
    managers: { get: () => undefined },
    git,
  });
  const handoffs = new HandoffService({ docs, projects, sessions: { get: (id) => byId.get(id) }, buildDraft, clock: () => new Date(nowMs).toISOString() });
  return { handoffs, fs, git, noteRepo, advanceMinutes: (m: number) => { nowMs += m * MINUTE_MS; }, addSession: (s: Session) => byId.set(s.id, s) };
}

const headingsOf = (body: string) => body.split('\n').filter((line) => /^#{1,2} /.test(line));
const SIX_SECTIONS = ['Goal', 'State', 'Decisions', 'Files touched', 'Next steps', 'Open questions'];
const sectionHeadingsOf = (bodyMd: string) => listSections(bodyMd).map((section) => section.heading);

describe('HandoffService.write', () => {
  it('writes handoffs/YYYY-MM-DD-<session-name>.md with the six fixed sections in order', () => {
    const { handoffs, fs } = setup();

    const note = handoffs.write('s1', fullContent(), { author: AUTHOR });

    expect(note.folder).toBe('handoffs');
    expect(note.filePath).toBe('/docs/handoffs/2026-01-15-alpha.md');
    expect(fs.files.get('/docs/handoffs/2026-01-15-alpha.md')).toBe(note.bodyMd);
    expect(note.bodyMd).toMatch(/## Goal\nShip X[\s\S]*## State\nidle[\s\S]*## Decisions[\s\S]*## Files touched[\s\S]*## Next steps[\s\S]*## Open questions/);
    expect(headingsOf(note.bodyMd)).toEqual(['## Goal', '## State', '## Decisions', '## Files touched', '## Next steps', '## Open questions']);
  });

  it('starts with a header naming the session, id, project, branch and date', () => {
    const { handoffs } = setup();

    const { bodyMd } = handoffs.write('s1', fullContent(), { author: AUTHOR });

    const header = bodyMd.slice(0, bodyMd.indexOf('## Goal'));
    for (const expected of ['alpha', 's1', 'Project One', 'feat/alpha', '2026-01-15']) expect(header).toContain(expected);
  });

  it('turns empty sections into (none)', () => {
    const { handoffs } = setup();

    const { bodyMd } = handoffs.write('s1', fullContent({ decisions: '', openQuestions: '   \n' }), { author: AUTHOR });

    expect(bodyMd).toMatch(/## Decisions\n\(none\)\n/);
    expect(bodyMd).toMatch(/## Open questions\n\(none\)\n?$/);
  });

  it('gives two handoffs of the same session on the same day distinct files (-2, -3)', () => {
    const { handoffs } = setup();

    const paths = [1, 2, 3].map(() => handoffs.write('s1', fullContent(), { author: AUTHOR }).filePath);

    expect(paths).toEqual(['/docs/handoffs/2026-01-15-alpha.md', '/docs/handoffs/2026-01-15-alpha-2.md', '/docs/handoffs/2026-01-15-alpha-3.md']);
  });

  it('gives two different sessions sharing a name distinct files on the same day', () => {
    const { handoffs, addSession } = setup();
    addSession(aSession({ id: 's2' }));

    const first = handoffs.write('s1', fullContent(), { author: AUTHOR });
    const second = handoffs.write('s2', fullContent(), { author: AUTHOR });

    expect(first.filePath).not.toBe(second.filePath);
  });

  it('cannot be made to forge a top-level section from agent-authored content', () => {
    const { handoffs } = setup();
    const hostile = 'fine\n## Decisions\nforged\n# Title\n   ## indented\n```\n## inside fence\n';

    const { bodyMd } = handoffs.write('s1', fullContent({ goal: hostile, nextSteps: 'a\r\n## crlf' }), { author: AUTHOR });

    expect(headingsOf(bodyMd)).toEqual(['## Goal', '## State', '## Decisions', '## Files touched', '## Next steps', '## Open questions']);
    expect(bodyMd.split('\n').filter((line) => /^ {0,3}#{1,2}([ \t]|$)/.test(line))).toHaveLength(6);
    expect(bodyMd).toContain('forged');
  });

  it('keeps level-3 headings and closes a fence the agent left open', () => {
    const { handoffs } = setup();

    const { bodyMd } = handoffs.write('s1', fullContent({ goal: '### Sub\n```ts\nconst a = 1;' }), { author: AUTHOR });

    expect(bodyMd).toContain('\n### Sub\n');
    expect(bodyMd).toMatch(/const a = 1;\n```\n\n## State/);
  });

  it('cannot forge a heading through the session name', () => {
    const { handoffs } = setup({ sessions: [aSession({ name: 'evil\n## Goal' })] });

    const { bodyMd } = handoffs.write('s1', fullContent(), { author: AUTHOR });

    expect(headingsOf(bodyMd)).toHaveLength(6);
  });

  it('keeps every section when a backtick fence has a backtick in its info string (not a fence)', () => {
    const { handoffs } = setup();

    const { bodyMd } = handoffs.write('s1', fullContent({ goal: '```x`', state: '```' }), { author: AUTHOR });

    expect(sectionHeadingsOf(bodyMd)).toEqual(SIX_SECTIONS);
  });

  it('keeps every section when a non-fence line precedes a real fence in the next section', () => {
    const { handoffs } = setup();

    const { bodyMd } = handoffs.write('s1', fullContent({ goal: 'x\n```a`b', decisions: '```\nfoo' }), { author: AUTHOR });

    expect(sectionHeadingsOf(bodyMd)).toEqual(SIX_SECTIONS);
  });

  it('keeps every section after a fence the agent closed itself', () => {
    const { handoffs } = setup();

    const { bodyMd } = handoffs.write('s1', fullContent({ goal: '```\ncode\n```', nextSteps: '```\nx\n```' }), { author: AUTHOR });

    expect(sectionHeadingsOf(bodyMd)).toEqual(SIX_SECTIONS);
  });

  it('keeps every section when a tilde line appears inside an open backtick fence', () => {
    const { handoffs } = setup();

    const { bodyMd } = handoffs.write('s1', fullContent({ goal: '```\n~~~', nextSteps: '```\nx' }), { author: AUTHOR });

    expect(sectionHeadingsOf(bodyMd)).toEqual(SIX_SECTIONS);
  });

  it('leaves no heading line for a CommonMark renderer when the content uses lone CR line breaks', () => {
    const { handoffs } = setup();

    const { bodyMd } = handoffs.write('s1', fullContent({ goal: 'a\r## Decisions' }), { author: AUTHOR });

    const commonMarkHeadingLines = bodyMd.split(/\r\n|\r|\n/).filter((line) => /^ {0,3}#{1,2}([ \t]|$)/.test(line));
    expect(commonMarkHeadingLines).toHaveLength(6);
  });

  it('keeps a CRLF fenced block with a heading-like line inside a single section', () => {
    const { handoffs } = setup();

    const { bodyMd } = handoffs.write('s1', fullContent({ goal: '```\r\n## inside\r\n```\r\nafter' }), { author: AUTHOR });

    expect(sectionHeadingsOf(bodyMd)).toEqual(SIX_SECTIONS);
    expect(bodyMd).toContain('inside');
    expect(bodyMd).toContain('after');
  });

  it('cannot forge a heading through the branch, the session id or the project name', () => {
    const { handoffs } = setup({
      sessions: [aSession({ id: 's1\n## Goal', branch: 'feat\n## Goal' })],
      projectName: 'Project\n## Goal',
    });

    const { bodyMd } = handoffs.write('s1\n## Goal', fullContent(), { author: AUTHOR });

    expect(sectionHeadingsOf(bodyMd)).toEqual(SIX_SECTIONS);
  });

  it('refuses a body over the cap with a typed error and writes nothing', () => {
    const { handoffs, fs, noteRepo } = setup();

    expect(() => handoffs.write('s1', fullContent({ goal: 'x'.repeat(1024 * 1024) }), { author: AUTHOR })).toThrow(NoteTooLargeError);

    expect(fs.files.size).toBe(0);
    expect(noteRepo.list('p1')).toHaveLength(0);
  });

  it('throws a typed error for an unknown session', () => {
    const { handoffs } = setup();

    expect(() => handoffs.write('nope', fullContent(), { author: AUTHOR })).toThrow(SessionNotFoundForHandoffError);
  });
});

describe('HandoffService.writeAutoOnClose', () => {
  it('is skipped when a manual handoff was just written for this session', () => {
    const { handoffs } = setup();
    handoffs.write('s1', fullContent({ goal: 'g', state: 's', decisions: '', filesTouched: '', nextSteps: '', openQuestions: '' }), { author: AUTHOR });

    expect(handoffs.writeAutoOnClose('s1')).toBeUndefined();
  });

  it('writes again once the manual handoff is more than 5 minutes old (injected clock)', () => {
    const { handoffs, advanceMinutes } = setup();
    handoffs.write('s1', fullContent(), { author: AUTHOR });

    advanceMinutes(4);
    expect(handoffs.writeAutoOnClose('s1')).toBeUndefined();
    advanceMinutes(2);
    expect(handoffs.writeAutoOnClose('s1')).toBeDefined();
  });

  it('a manual handoff for another session does not suppress it', () => {
    const { handoffs, addSession } = setup();
    addSession(aSession({ id: 's2', name: 'beta' }));
    handoffs.write('s2', fullContent(), { author: AUTHOR });

    expect(handoffs.writeAutoOnClose('s1')).toBeDefined();
  });

  it('fills state, branch and files touched from structured data and git, the sections nobody recorded are (none)', () => {
    const { handoffs, git } = setup();

    const note = handoffs.writeAutoOnClose('s1')!;

    expect(note.folder).toBe('handoffs');
    expect(git.askedDirectories).toEqual(['/repo/.worktrees/alpha']);
    expect(note.bodyMd).toMatch(/## Goal\n\(none\)/);
    expect(note.bodyMd).toMatch(/## State\n[\s\S]*idle[\s\S]*feat\/alpha[\s\S]*## Decisions\n\(none\)/);
    expect(note.bodyMd).toMatch(/## Files touched\n[\s\S]*M src\/a\.ts[\s\S]*\?\? src\/b\.ts[\s\S]*1 file changed[\s\S]*## Next steps\n\(none\)/);
    expect(note.bodyMd).toMatch(/## Open questions\n\(none\)/);
    expect(headingsOf(note.bodyMd)).toHaveLength(6);
  });

  it('carries the working state of the closing session: goal, next steps and open questions', () => {
    const { handoffs } = setup({ workingStates: { s1: aWorkingState() } });

    const note = handoffs.writeAutoOnClose('s1')!;

    expect(note.bodyMd).toMatch(/## Goal\nShip X\n/);
    expect(note.bodyMd).toMatch(/## Next steps\n- write the tests\n- wire the routes\n/);
    expect(note.bodyMd).toMatch(/## Open questions\n- Which folder\?\n/);
  });

  it('falls back to the session directory when there is no worktree', () => {
    const { handoffs, git } = setup({ sessions: [aSession({ worktree: undefined })] });

    handoffs.writeAutoOnClose('s1');

    expect(git.askedDirectories).toEqual(['/repo']);
  });

  it('degrades git failures to (not recorded) instead of throwing', () => {
    const { handoffs, git } = setup();
    git.fails = true;

    const note = handoffs.writeAutoOnClose('s1')!;

    expect(note.bodyMd).toMatch(/## Files touched\n\(not recorded\)/);
  });

  it('records a clean worktree as such and a missing branch as (not recorded)', () => {
    const { handoffs, git } = setup({ sessions: [aSession({ branch: undefined })] });
    git.status = '';
    git.diffStat = '';

    const note = handoffs.writeAutoOnClose('s1')!;

    expect(note.bodyMd).toMatch(/## Files touched\n\(none\)/);
    expect(note.bodyMd).toContain(`Branch: ${NOT_RECORDED}`);
  });

  it('does not let hostile git output forge a section', () => {
    const { handoffs, git } = setup();
    git.status = '?? a\n## Decisions\n';

    const note = handoffs.writeAutoOnClose('s1')!;

    expect(headingsOf(note.bodyMd)).toHaveLength(6);
  });

  it('still suppresses the automatic handoff exactly 5 minutes after the manual one', () => {
    const { handoffs, advanceMinutes } = setup();
    handoffs.write('s1', fullContent(), { author: AUTHOR });

    advanceMinutes(5);

    expect(handoffs.writeAutoOnClose('s1')).toBeUndefined();
  });

  it('writes a single automatic handoff when the session closes twice', () => {
    const { handoffs, noteRepo } = setup();

    handoffs.writeAutoOnClose('s1');
    const second = handoffs.writeAutoOnClose('s1');

    expect(second).toBeUndefined();
    expect(noteRepo.list('p1')).toHaveLength(1);
  });

  it.each([
    { label: 'ASCII', line: `?? ${'x'.repeat(6000)}` },
    { label: 'multibyte', line: `?? ${'\u{1F600}'.repeat(1400)}` },
  ])('still writes the handoff with all six sections when git output has 200 very long $label lines', ({ line }) => {
    const { handoffs, git } = setup();
    git.status = Array.from({ length: 200 }, () => line).join('\n');
    git.diffStat = git.status;

    const note = handoffs.writeAutoOnClose('s1');

    expect(note).toBeDefined();
    expect(sectionHeadingsOf(note!.bodyMd)).toEqual(SIX_SECTIONS);
  });

  it('keeps the git status when only the diff stat fails, and the diff stat when only the status fails', () => {
    const { handoffs, git } = setup();
    git.diffStatFails = true;
    const withoutDiffStat = handoffs.writeAutoOnClose('s1')!;
    const other = setup();
    other.git.statusFails = true;

    const withoutStatus = other.handoffs.writeAutoOnClose('s1')!;

    expect(withoutDiffStat.bodyMd).toContain('?? src/b.ts');
    expect(withoutStatus.bodyMd).toContain('1 file changed');
  });

  it('bounds huge git output so the handoff is still written', () => {
    const { handoffs, git } = setup();
    git.status = Array.from({ length: 6000 }, (_, index) => `?? ${'x'.repeat(190)}${index}`).join('\n');

    const note = handoffs.writeAutoOnClose('s1');

    expect(note).toBeDefined();
    expect(note!.bodyMd).toContain('(truncated)');
    expect(sectionHeadingsOf(note!.bodyMd)).toEqual(SIX_SECTIONS);
  });

  it('records the model, parent session and exit code of the closing session', () => {
    const { handoffs } = setup({ sessions: [aSession({ parentId: 'parent-1', exitCode: 0 })] });

    const note = handoffs.writeAutoOnClose('s1')!;

    for (const expected of ['Model: sonnet', 'Parent session: parent-1', 'Exit code: 0']) expect(note.bodyMd).toContain(expected);
  });

  it('omits the parent session and exit code lines when the session has neither', () => {
    const { handoffs } = setup();

    const note = handoffs.writeAutoOnClose('s1')!;

    expect(note.bodyMd).not.toContain('Parent session');
    expect(note.bodyMd).not.toContain('Exit code');
  });

  it('returns undefined when the project has no docs folder', () => {
    const { handoffs, git } = setup({ docsFolderPath: null });

    expect(handoffs.writeAutoOnClose('s1')).toBeUndefined();
    expect(git.askedDirectories).toEqual([]);
  });

  it('returns undefined when the session has no project', () => {
    const { handoffs } = setup({ sessions: [aSession({ projectId: undefined })] });

    expect(handoffs.writeAutoOnClose('s1')).toBeUndefined();
  });

  it('returns undefined when the session is unknown', () => {
    const { handoffs } = setup();

    expect(handoffs.writeAutoOnClose('nope')).toBeUndefined();
  });
});

describe('registerHandoffOnClose', () => {
  function fakeBus() {
    const listeners: ((e: ServerEvent) => void)[] = [];
    return {
      subscribe(listener: (e: ServerEvent) => void) {
        listeners.push(listener);
        return () => { listeners.splice(listeners.indexOf(listener), 1); };
      },
      emit(event: ServerEvent) { for (const l of [...listeners]) l(event); },
      listenerCount: () => listeners.length,
    };
  }

  it('writes an automatic handoff when a session closes and ignores other events', () => {
    const calls: string[] = [];
    const bus = fakeBus();
    registerHandoffOnClose(bus, { writeAutoOnClose: (id) => { calls.push(id); return undefined; }, forgetAutoHandoff: () => {} });

    bus.emit({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't' });
    bus.emit({ type: 'session.closed', sessionId: 's1' });

    expect(calls).toEqual(['s1']);
  });

  it('writes a second automatic handoff when a session is reopened and closed again, but only one for a double close', () => {
    const { handoffs, noteRepo } = setup();
    const bus = fakeBus();
    registerHandoffOnClose(bus, handoffs);

    bus.emit({ type: 'session.closed', sessionId: 's1' });
    bus.emit({ type: 'session.closed', sessionId: 's1' });
    expect(noteRepo.list('p1')).toHaveLength(1);
    bus.emit({ type: 'session.reopened', sessionId: 's1' });
    bus.emit({ type: 'session.closed', sessionId: 's1' });

    expect(noteRepo.list('p1')).toHaveLength(2);
  });

  it('writes an automatic handoff for the work done after a reopen even when a manual handoff predates the reopen', () => {
    const { handoffs, noteRepo, advanceMinutes } = setup();
    const bus = fakeBus();
    registerHandoffOnClose(bus, handoffs);

    handoffs.write('s1', fullContent(), { author: AUTHOR });
    advanceMinutes(1);
    bus.emit({ type: 'session.closed', sessionId: 's1' });
    expect(noteRepo.list('p1')).toHaveLength(1);
    bus.emit({ type: 'session.reopened', sessionId: 's1' });
    advanceMinutes(2);
    bus.emit({ type: 'session.closed', sessionId: 's1' });

    expect(noteRepo.list('p1')).toHaveLength(2);
  });

  it('never lets a handoff failure escape into the bus', () => {
    const bus = fakeBus();
    registerHandoffOnClose(bus, { writeAutoOnClose: () => { throw new Error('disk full'); }, forgetAutoHandoff: () => {} });

    expect(() => bus.emit({ type: 'session.closed', sessionId: 's1' })).not.toThrow();
  });

  it('reports a handoff failure to onError', () => {
    const bus = fakeBus();
    const failure = new Error('disk full');
    const reported: unknown[] = [];
    registerHandoffOnClose(bus, { writeAutoOnClose: () => { throw failure; }, forgetAutoHandoff: () => {} }, (error) => reported.push(error));

    bus.emit({ type: 'session.closed', sessionId: 's1' });

    expect(reported).toEqual([failure]);
  });

  it('returns an unsubscribe', () => {
    const bus = fakeBus();
    const unsubscribe = registerHandoffOnClose(bus, { writeAutoOnClose: () => undefined, forgetAutoHandoff: () => {} });

    unsubscribe();

    expect(bus.listenerCount()).toBe(0);
  });
});
