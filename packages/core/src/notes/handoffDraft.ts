import {
  HANDOFF_SECTION_KEYS,
  type HandoffContent,
  type HandoffSectionKey,
  type HandoffSectionSource,
  type Session,
  type TodoCounts,
  type WorkingStateSections,
} from '@openfleet/shared';
import { maskedSecrets } from '../redact.js';
import type { GitPort } from './gitPort.js';
import { SessionNotFoundForHandoffError } from './handoffErrors.js';
import { neutralizeSectionText } from './sectionText.js';

export const HANDOFF_SECTION_MAX_BYTES = 8 * 1024;

const NOT_RECORDED = '(not recorded)';
const TRUNCATION_MARKER = '\n(truncated)';
const MAX_CHILDREN_WITH_GIT_BLOCK = 8;
/** Git is synchronous: past this cumulative time a manager draft stops asking git so the event loop is never held for minutes. */
const GIT_TIME_BUDGET_MS = 6_000;
const MAX_GIT_OUTPUT_LINES = 200;
const MAX_GIT_OUTPUT_LINE_LENGTH = 500;
const ELLIPSIS = '…';
const UTF8_CONTINUATION_BYTE_MASK = 0b1100_0000;
const UTF8_CONTINUATION_BYTE = 0b1000_0000;

export interface HandoffDraft {
  content: HandoffContent;
  sources: Record<HandoffSectionKey, HandoffSectionSource>;
  /** The sections cut at the 8 KiB cap. */
  truncated: HandoffSectionKey[];
}

export interface HandoffDraftDeps {
  sessions: { get(id: string): Session | undefined; list(): Session[] };
  workingStates: { get(sessionId: string): WorkingStateSections | undefined };
  todos: { get(sessionId: string): { counts: TodoCounts } | undefined };
  managers: { get(sessionId: string): { missionText: string } | undefined };
  git: GitPort;
  /** Milliseconds clock measuring the git time budget of a manager draft; defaults to `Date.now`. */
  nowMs?: () => number;
}

export type BuildHandoffDraft = (sessionId: string) => HandoffDraft;

interface RawSection {
  text: string;
  source: HandoffSectionSource;
}

interface GitReading {
  /** Fenced `git status` and `git diff --stat` output; empty for a clean tree. */
  text: string;
  /** False when git failed for both commands. */
  answered: boolean;
}

const NOTHING_DERIVED: RawSection = { text: '', source: 'none' };

/**
 * Builds the six-section handoff draft of a session from what the daemon already holds: the session, its working state,
 * its todos, its manager record and git. Reads only; a git failure never throws, it reads `(not recorded)`.
 * Sections only a human can write stay empty. Every section is masked, neutralised and capped.
 */
export function createHandoffDraftBuilder(deps: HandoffDraftDeps): BuildHandoffDraft {
  return (sessionId) => {
    const session = deps.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundForHandoffError(sessionId);

    const mission = deps.managers.get(sessionId)?.missionText;
    const workingState = deps.workingStates.get(sessionId);
    const isManager = mission !== undefined;

    const rawSections: Record<HandoffSectionKey, RawSection> = {
      goal: describeGoal({ mission, workingState }),
      state: isManager ? describeManagerState(deps, session, workingState) : describeSessionState(deps, session, workingState),
      decisions: NOTHING_DERIVED,
      filesTouched: isManager ? describeManagerFilesTouched(deps, session) : describeSessionFilesTouched(deps.git, session),
      nextSteps: describeBullets(workingState && [...workingState.todo, ...workingState.remaining]),
      openQuestions: describeBullets(workingState && [...workingState.questionsForHuman, ...workingState.internalQuestions]),
    };
    return finalize(rawSections);
  };
}

function describeGoal({ mission, workingState }: { mission: string | undefined; workingState: WorkingStateSections | undefined }): RawSection {
  if (mission !== undefined) return { text: mission, source: 'manager' };
  const firstPlanItem = workingState?.plan[0];
  if (firstPlanItem) return { text: firstPlanItem, source: 'working_state' };
  return NOTHING_DERIVED;
}

function describeBullets(items: string[] | undefined): RawSection {
  if (!items?.length) return NOTHING_DERIVED;
  return { text: bulletList(items), source: 'working_state' };
}

const bulletList = (items: string[]) => items.map((item) => `- ${item}`).join('\n');

function describeSessionState(deps: HandoffDraftDeps, session: Session, workingState: WorkingStateSections | undefined): RawSection {
  const lines = [...describeSessionFacts(session), ...describeBlockers(workingState), ...describeTodoSummary(deps, session.id)];
  return { text: lines.join('\n'), source: 'session' };
}

function describeManagerState(deps: HandoffDraftDeps, manager: Session, workingState: WorkingStateSections | undefined): RawSection {
  const children = childrenOf(deps, manager);
  const childLines = children.map((child) => `- ${child.name}: ${child.state}`);
  const lines = [
    ...describeSessionFacts(manager),
    `Children: ${children.length}`,
    ...childLines,
    ...describeBlockers(workingState),
    ...describeTodoSummary(deps, manager.id),
  ];
  return { text: lines.join('\n'), source: 'manager' };
}

function describeSessionFacts(session: Session): string[] {
  const facts = [
    `Session state: ${session.state}`,
    `Branch: ${session.branch ?? NOT_RECORDED}`,
    `Model: ${session.model ?? NOT_RECORDED}`,
    session.parentId ? `Parent session: ${session.parentId}` : undefined,
    session.exitCode === undefined ? undefined : `Exit code: ${session.exitCode}`,
  ];
  return facts.filter((fact) => fact !== undefined);
}

function describeBlockers(workingState: WorkingStateSections | undefined): string[] {
  if (!workingState?.blockers.length) return [];
  return ['Blockers:', ...workingState.blockers.map((blocker) => `- ${blocker}`)];
}

function describeTodoSummary(deps: HandoffDraftDeps, sessionId: string): string[] {
  const counts = deps.todos.get(sessionId)?.counts;
  if (!counts?.total) return [];
  return [`Todos: ${counts.total} total, ${counts.completed} completed, ${counts.inProgress} in progress, ${counts.pending} pending`];
}

const byCreationThenId = (a: Session, b: Session) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

const childrenOf = (deps: HandoffDraftDeps, manager: Session) =>
  deps.sessions.list().filter((session) => session.parentId === manager.id).sort(byCreationThenId);

const workingDirectoryOf = (session: Session) => session.worktree ?? session.directory;

function describeSessionFilesTouched(git: GitPort, session: Session): RawSection {
  const reading = readGit(git, workingDirectoryOf(session));
  if (!reading.answered) return { text: NOT_RECORDED, source: 'none' };
  return { text: reading.text, source: 'git' };
}

function describeManagerFilesTouched(deps: HandoffDraftDeps, manager: Session): RawSection {
  const nowMs = deps.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  const isGitBudgetSpent = () => nowMs() - startedAtMs >= GIT_TIME_BUDGET_MS;

  const children = childrenOf(deps, manager);
  const shownChildren = children.slice(0, MAX_CHILDREN_WITH_GIT_BLOCK);
  const hiddenChildrenCount = children.length - shownChildren.length;
  const members = [{ label: `${manager.name} (manager)`, session: manager }, ...shownChildren.map((child) => ({ label: child.name, session: child }))];

  const blocks = members.flatMap(({ label, session }) => {
    if (isGitBudgetSpent()) return [{ text: `${label}\n${NOT_RECORDED}`, hasGitOutput: false }];
    const reading = readGit(deps.git, workingDirectoryOf(session));
    if (!reading.answered) return [{ text: `${label}\n${NOT_RECORDED}`, hasGitOutput: false }];
    if (!reading.text) return [];
    return [{ text: `${label}\n${reading.text}`, hasGitOutput: true }];
  });

  const hiddenChildrenNotice = hiddenChildrenCount > 0 ? [`(${hiddenChildrenCount} more children not shown)`] : [];
  const hasGitOutput = blocks.some((block) => block.hasGitOutput);
  const text = [...blocks.map((block) => block.text), ...hiddenChildrenNotice].join('\n\n');
  return { text, source: hasGitOutput ? 'git' : 'none' };
}

function readGit(git: GitPort, directory: string): GitReading {
  const status = attempt(() => git.statusShort(directory));
  const diffStat = attempt(() => git.diffStatOf(directory));
  const answered = status !== undefined || diffStat !== undefined;

  const text = [status, diffStat]
    .filter((output): output is string => Boolean(output?.trim()))
    .map((output) => `\`\`\`\n${truncateLines(output.trimEnd())}\n\`\`\``)
    .join('\n\n');
  return { text, answered };
}

function attempt(run: () => string): string | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

function truncateLines(output: string): string {
  const lines = output.split('\n').map(capLineLength);
  const hiddenCount = lines.length - MAX_GIT_OUTPUT_LINES;
  if (hiddenCount <= 0) return lines.join('\n');
  return [...lines.slice(0, MAX_GIT_OUTPUT_LINES), `(${hiddenCount} more)`].join('\n');
}

function capLineLength(line: string): string {
  const codePoints = [...line];
  if (codePoints.length <= MAX_GIT_OUTPUT_LINE_LENGTH) return line;
  return codePoints.slice(0, MAX_GIT_OUTPUT_LINE_LENGTH).join('') + ELLIPSIS;
}

function finalize(rawSections: Record<HandoffSectionKey, RawSection>): HandoffDraft {
  const content = {} as HandoffContent;
  const sources = {} as Record<HandoffSectionKey, HandoffSectionSource>;
  const truncated: HandoffSectionKey[] = [];

  for (const key of HANDOFF_SECTION_KEYS) {
    const { text, source } = rawSections[key];
    const safeText = neutralizeSectionText(maskedSecrets(text).trim());
    const capped = capToBytes(safeText);
    content[key] = capped.text;
    sources[key] = capped.text ? source : 'none';
    if (capped.wasCut) truncated.push(key);
  }
  return { content, sources, truncated };
}

/**
 * Cuts `text` to the section cap on a line boundary when it has one, never inside a UTF-8 character,
 * closes the code fence the cut leaves open, and appends the truncation marker. The result fits the cap.
 */
function capToBytes(text: string): { text: string; wasCut: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= HANDOFF_SECTION_MAX_BYTES) return { text, wasCut: false };

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  let budget = HANDOFF_SECTION_MAX_BYTES - markerBytes;
  let closedHead = neutralizeSectionText(headWithin(bytes, budget));
  while (Buffer.byteLength(closedHead, 'utf8') + markerBytes > HANDOFF_SECTION_MAX_BYTES) {
    const overshoot = Buffer.byteLength(closedHead, 'utf8') + markerBytes - HANDOFF_SECTION_MAX_BYTES;
    budget -= overshoot;
    closedHead = neutralizeSectionText(headWithin(bytes, budget));
  }
  return { text: closedHead + TRUNCATION_MARKER, wasCut: true };
}

function headWithin(bytes: Buffer, budget: number): string {
  let end = Math.max(budget, 0);
  while (end > 0 && (bytes[end]! & UTF8_CONTINUATION_BYTE_MASK) === UTF8_CONTINUATION_BYTE) end -= 1;

  const head = bytes.subarray(0, end).toString('utf8');
  const lastLineBreak = head.lastIndexOf('\n');
  return lastLineBreak > 0 ? head.slice(0, lastLineBreak) : head;
}
