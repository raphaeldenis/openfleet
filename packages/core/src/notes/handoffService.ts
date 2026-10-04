import type { HandoffContent, Note, ServerEvent, Session } from '@openfleet/shared';
import type { ProjectRepository } from '../projects/projectRepository.js';
import type { DocsFolderService } from './docsFolderService.js';
import { canClose, canOpen, fenceOf, type Fence } from './noteSections.js';

const NONE = '(none)';
const NOT_RECORDED = '(not recorded)';
const AUTO_HANDOFF_AUTHOR = 'auto-handoff';
const MANUAL_HANDOFF_WINDOW_MS = 5 * 60_000;
const DATE_LENGTH = 'YYYY-MM-DD'.length;
const MAX_GIT_OUTPUT_LINES = 200;
const MAX_GIT_OUTPUT_LINE_LENGTH = 500;
const ELLIPSIS = '…';

const SECTION_TITLES = {
  goal: 'Goal',
  state: 'State',
  decisions: 'Decisions',
  filesTouched: 'Files touched',
  nextSteps: 'Next steps',
  openQuestions: 'Open questions',
} as const;

/** The parser in noteSections.ts treats `#` and `##` (up to three leading spaces) outside code fences as section headings. */
const TOP_LEVEL_HEADING_LINE = /^ {0,3}#{1,2}(?:[ \t]|$)/;

/** Read-only git access for a session's working directory; implementations throw when git is unavailable. */
export interface GitPort {
  /** Output of `git status --short`. */
  statusShort(directory: string): string;
  /** Output of `git diff --stat`. */
  diffStatOf(directory: string): string;
}

export class SessionNotFoundForHandoffError extends Error {
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}

export class SessionHasNoProjectError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} has no project, so it has no docs folder to write a handoff into`);
  }
}

export class HandoffNotFoundError extends Error {
  constructor(file: string) {
    super(`handoff not found: ${file}`);
  }
}

export interface HandoffServiceDeps {
  docs: DocsFolderService;
  projects: ProjectRepository;
  sessions: { get(id: string): Session | undefined };
  git: GitPort;
  /** ISO date-time source; drives the header date and the manual-handoff window. */
  clock: () => string;
}

/**
 * Writes the fixed-template session handoff note (`handoffs/YYYY-MM-DD-<session-name>.md`).
 *
 * Every section is agent-authored, untrusted text: lines that would open a `#`/`##` heading are escaped
 * and an unclosed code fence is closed, so a section can never forge or hide another section.
 * The 1 MiB note cap is enforced by `DocsFolderService` before anything touches disk (`NoteTooLargeError`).
 * The manual-handoff memory behind the 5-minute window is per process: a daemon restart forgets it.
 */
export class HandoffService {
  // ponytail: in-memory, forgotten on daemon restart; persist the last handoff time if a duplicate auto note after restart matters
  private readonly lastManualHandoffMs = new Map<string, number>();
  private readonly sessionsWithAutoHandoff = new Set<string>();

  constructor(private readonly deps: HandoffServiceDeps) {}

  write(sessionId: string, content: HandoffContent, { author }: { author: string }): Note {
    const session = this.deps.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundForHandoffError(sessionId);
    if (!session.projectId) throw new SessionHasNoProjectError(sessionId);

    const note = this.createHandoffNote(session, session.projectId, content, author);
    this.lastManualHandoffMs.set(sessionId, Date.parse(this.deps.clock()));
    return note;
  }

  /** Deterministic fallback for a closing session: no LLM, only structured session data and git. */
  writeAutoOnClose(sessionId: string): Note | undefined {
    const session = this.deps.sessions.get(sessionId);
    if (!session?.projectId) return undefined;
    if (this.hasRecentManualHandoff(sessionId)) return undefined;
    if (this.sessionsWithAutoHandoff.has(sessionId)) return undefined;
    const hasDocsFolder = Boolean(this.deps.projects.get(session.projectId)?.docsFolderPath);
    if (!hasDocsFolder) return undefined;

    const content: HandoffContent = {
      goal: NOT_RECORDED,
      state: describeState(session),
      decisions: NOT_RECORDED,
      filesTouched: this.describeFilesTouched(session.worktree ?? session.directory),
      nextSteps: NOT_RECORDED,
      openQuestions: NOT_RECORDED,
    };
    const note = this.createHandoffNote(session, session.projectId, content, AUTO_HANDOFF_AUTHOR);
    this.sessionsWithAutoHandoff.add(sessionId);
    return note;
  }

  /** Lets a reopened session get an automatic handoff again on its next close. */
  forgetAutoHandoff(sessionId: string): void {
    this.sessionsWithAutoHandoff.delete(sessionId);
    this.lastManualHandoffMs.delete(sessionId);
  }

  private hasRecentManualHandoff(sessionId: string): boolean {
    const writtenAtMs = this.lastManualHandoffMs.get(sessionId);
    if (writtenAtMs === undefined) return false;
    return Date.parse(this.deps.clock()) - writtenAtMs <= MANUAL_HANDOFF_WINDOW_MS;
  }

  private createHandoffNote(session: Session, projectId: string, content: HandoffContent, author: string): Note {
    const projectName = this.deps.projects.get(projectId)?.name ?? NOT_RECORDED;
    const bodyMd = renderBody({ session, projectName, date: this.deps.clock().slice(0, DATE_LENGTH), content });
    return this.deps.docs.createFileBackedNote({ projectId, folder: 'handoffs', title: session.name, bodyMd, author });
  }

  private describeFilesTouched(directory: string): string {
    const status = attempt(() => this.deps.git.statusShort(directory));
    const diffStat = attempt(() => this.deps.git.diffStatOf(directory));
    const gitIsUnavailable = status === undefined && diffStat === undefined;
    if (gitIsUnavailable) return NOT_RECORDED;

    return [status, diffStat]
      .filter((output): output is string => Boolean(output?.trim()))
      .map((output) => `\`\`\`\n${truncateLines(output.trimEnd())}\n\`\`\``)
      .join('\n\n');
  }
}

/** Calls `handoffs.writeAutoOnClose` on every `session.closed` event and re-arms the session on `session.reopened`. Returns the unsubscribe. */
// Not called from main.ts on purpose: P3-DOCS-WIRE registers it together with the docs-folder wiring.
export function registerHandoffOnClose(
  bus: { subscribe(listener: (event: ServerEvent) => void): () => unknown },
  handoffs: Pick<HandoffService, 'writeAutoOnClose' | 'forgetAutoHandoff'>,
  onError: (error: unknown) => void = () => {},
): () => unknown {
  return bus.subscribe((event) => {
    if (event.type === 'session.reopened') {
      handoffs.forgetAutoHandoff(event.sessionId);
      return;
    }
    if (event.type !== 'session.closed') return;
    try {
      handoffs.writeAutoOnClose(event.sessionId);
    } catch (error) {
      onError(error);
    }
  });
}

function describeState(session: Session): string {
  const lines = [
    `Session state: ${session.state}`,
    `Branch: ${session.branch ?? NOT_RECORDED}`,
    `Model: ${session.model ?? NOT_RECORDED}`,
    session.parentId ? `Parent session: ${session.parentId}` : undefined,
    session.exitCode === undefined ? undefined : `Exit code: ${session.exitCode}`,
  ];
  return lines.filter((line) => line !== undefined).join('\n');
}

function renderBody(input: { session: Session; projectName: string; date: string; content: HandoffContent }): string {
  const { session, projectName, date, content } = input;
  const header = [
    `Session: ${singleLine(session.name)}`,
    `Session id: ${singleLine(session.id)}`,
    `Project: ${singleLine(projectName)}`,
    `Branch: ${singleLine(session.branch ?? NOT_RECORDED)}`,
    `Date: ${date}`,
  ].join('\n');

  const sections = (Object.keys(SECTION_TITLES) as (keyof HandoffContent)[]).map((key) => {
    const text = content[key].trim();
    return `## ${SECTION_TITLES[key]}\n${text ? neutralizeSectionText(text) : NONE}\n`;
  });
  return `${header}\n\n${sections.join('\n')}`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Escapes `#`/`##` heading lines and closes a code fence left open, so the text stays inside its own section. */
function neutralizeSectionText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let openFence: Fence | undefined;

  const safeLines = lines.map((line) => {
    openFence = nextFenceState(openFence, fenceOf(line));
    return TOP_LEVEL_HEADING_LINE.test(line) ? `\\${line}` : line;
  });

  if (openFence) safeLines.push(openFence.character.repeat(openFence.length));
  return safeLines.join('\n');
}

/** Returns the fence open after `line`, using the same open/close rules as the section parser. */
function nextFenceState(openFence: Fence | undefined, lineFence: Fence | undefined): Fence | undefined {
  if (!lineFence) return openFence;
  if (!openFence) return canOpen(lineFence) ? lineFence : undefined;
  const closesOpenFence = canClose(lineFence) && lineFence.character === openFence.character && lineFence.length >= openFence.length;
  return closesOpenFence ? undefined : openFence;
}

function capLineLength(line: string): string {
  const codePoints = [...line];
  if (codePoints.length <= MAX_GIT_OUTPUT_LINE_LENGTH) return line;
  return codePoints.slice(0, MAX_GIT_OUTPUT_LINE_LENGTH).join('') + ELLIPSIS;
}

function truncateLines(output: string): string {
  const lines = output.split('\n').map(capLineLength);
  const hiddenCount = lines.length - MAX_GIT_OUTPUT_LINES;
  if (hiddenCount <= 0) return lines.join('\n');
  return [...lines.slice(0, MAX_GIT_OUTPUT_LINES), `(${hiddenCount} more)`].join('\n');
}

function attempt(run: () => string): string | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}
