import type { HandoffContent, HandoffSkipReason, Note, ServerEvent, Session } from '@openfleet/shared';
import type { ProjectRepository } from '../projects/projectRepository.js';
import type { DocsFolderService } from './docsFolderService.js';
import type { BuildHandoffDraft } from './handoffDraft.js';
import { SessionNotFoundForHandoffError } from './handoffErrors.js';
import { neutralizeSectionText } from './sectionText.js';

export { SessionNotFoundForHandoffError } from './handoffErrors.js';
export type { GitPort } from './gitPort.js';

const NONE = '(none)';
const NOT_RECORDED = '(not recorded)';
const AUTO_HANDOFF_AUTHOR = 'auto-handoff';
const MANUAL_HANDOFF_WINDOW_MS = 5 * 60_000;
const DATE_LENGTH = 'YYYY-MM-DD'.length;

const SECTION_TITLES = {
  goal: 'Goal',
  state: 'State',
  decisions: 'Decisions',
  filesTouched: 'Files touched',
  nextSteps: 'Next steps',
  openQuestions: 'Open questions',
} as const;

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
  docs: Pick<DocsFolderService, 'createFileBackedNote'>;
  projects: Pick<ProjectRepository, 'get'>;
  sessions: { get(id: string): Session | undefined };
  /** Builds the draft the automatic handoff on close writes. */
  buildDraft: BuildHandoffDraft;
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

  /** Deterministic fallback for a closing session: no LLM, only the draft built from session data, working state and git. */
  writeAutoOnClose(sessionId: string): Note | undefined {
    if (this.reasonToSkipAutoHandoff(sessionId)) return undefined;
    const session = this.deps.sessions.get(sessionId)!;

    const { content } = this.deps.buildDraft(sessionId);
    const note = this.createHandoffNote(session, session.projectId!, content, AUTO_HANDOFF_AUTHOR);
    this.sessionsWithAutoHandoff.add(sessionId);
    return note;
  }

  /** Why `writeAutoOnClose` would write nothing for this session right now; `undefined` when it would write. */
  reasonToSkipAutoHandoff(sessionId: string): HandoffSkipReason | undefined {
    const session = this.deps.sessions.get(sessionId);
    const projectId = session?.projectId;
    const hasDocsFolder = projectId !== undefined && Boolean(this.deps.projects.get(projectId)?.docsFolderPath);
    if (!hasDocsFolder) return 'target_unavailable';
    if (this.hasRecentManualHandoff(sessionId)) return 'recent_manual_handoff';
    if (this.sessionsWithAutoHandoff.has(sessionId)) return 'already_written';
    return undefined;
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
}

/**
 * Writes the automatic handoff of a session whose agent process ended unexpectedly (`session.closed` with reason `harness_exit`)
 * when `writeOnClose` is on, and re-arms the session on `session.reopened`. A close the user requested carries its own
 * `writeHandoff` choice, and a shutdown or a failed launch is no end of work. Returns the unsubscribe.
 */
export function registerHandoffOnClose(
  bus: { subscribe(listener: (event: ServerEvent) => void): () => unknown },
  handoffs: Pick<HandoffService, 'writeAutoOnClose' | 'forgetAutoHandoff'>,
  { writeOnClose, onError = () => {} }: { writeOnClose: boolean; onError?: (error: unknown) => void },
): () => unknown {
  return bus.subscribe((event) => {
    if (event.type === 'session.reopened') {
      handoffs.forgetAutoHandoff(event.sessionId);
      return;
    }
    if (event.type !== 'session.closed') return;
    const isCrash = event.reason === 'harness_exit';
    if (!isCrash || !writeOnClose) return;
    try {
      handoffs.writeAutoOnClose(event.sessionId);
    } catch (error) {
      onError(error);
    }
  });
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
