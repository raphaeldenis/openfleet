import { HANDOFF_SECTION_KEYS, HandoffContentSchema, type HandoffContent, type HandoffPreview, type HandoffTarget, type Session } from '@openfleet/shared';
import { withGitTimeBudget } from '../git/timeBudgetedGitPort.js';
import { createCloseHandoffWriter, type WriteHandoffOnClose } from '../notes/closeHandoffWriter.js';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import { createHandoffDraftBuilder, type BuildHandoffDraft, type HandoffDraftDeps } from '../notes/handoffDraft.js';
import { SessionNotFoundForHandoffError } from '../notes/handoffErrors.js';
import { HandoffService } from '../notes/handoffService.js';
import type { HandoffSettings } from '../notes/handoffSettings.js';
import { createHandoffTargetResolver, type ResolveHandoffTarget } from '../notes/handoffTarget.js';
import { IdenticalHandoffGuard } from '../notes/identicalHandoffGuard.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import { maskedSecrets } from '../redact.js';
import { summaryOf } from './noteRoutes.js';
import { json, type Router } from './router.js';

const HANDOFF_AUTHOR = 'You';
/** The most time the git calls of one handoff written while a session closes may take together; git is synchronous, so this is how long the event loop can be held. */
const CLOSE_HANDOFF_GIT_BUDGET_MS = 4_000;

export interface HandoffRouteDeps {
  sessions: { get(id: string): Session | undefined };
  managers: { get(sessionId: string): unknown };
  buildDraft: BuildHandoffDraft;
  resolveTarget: ResolveHandoffTarget;
  handoffs: Pick<HandoffService, 'write' | 'writeAutoOnClose' | 'forgetAutoHandoff' | 'reasonToSkipAutoHandoff'>;
  writeHandoffOnClose: WriteHandoffOnClose;
  docs: Pick<DocsFolderService, 'docsRelativePath'>;
  identicalGuard: IdenticalHandoffGuard;
  clock: () => string;
}

export interface HandoffWiring extends HandoffDraftDeps {
  docs: Pick<DocsFolderService, 'previewNewNotePath' | 'createFileBackedNote' | 'docsRelativePath'>;
  projects: Pick<ProjectRepository, 'get'>;
  settings: HandoffSettings;
  clock: () => string;
}

/** Builds the dependencies of the handoff routes, and the `HandoffService` behind the save route, from the services the daemon already holds. */
export function createHandoffRouteDeps(wiring: HandoffWiring): HandoffRouteDeps {
  const buildDraft = createHandoffDraftBuilder(wiring);
  const buildDraftWithinGitBudget: BuildHandoffDraft = (sessionId) =>
    createHandoffDraftBuilder({ ...wiring, git: withGitTimeBudget(wiring.git, { budgetMs: CLOSE_HANDOFF_GIT_BUDGET_MS, nowMs: wiring.nowMs }) })(sessionId);
  const handoffs = new HandoffService({ docs: wiring.docs, projects: wiring.projects, sessions: wiring.sessions, buildDraft: buildDraftWithinGitBudget, clock: wiring.clock });
  return {
    sessions: wiring.sessions,
    managers: wiring.managers,
    buildDraft,
    resolveTarget: createHandoffTargetResolver({ docs: wiring.docs, settings: wiring.settings }),
    handoffs,
    writeHandoffOnClose: createCloseHandoffWriter({ sessions: wiring.sessions, handoffs, docs: wiring.docs }),
    docs: wiring.docs,
    identicalGuard: new IdenticalHandoffGuard(wiring.clock),
    clock: wiring.clock,
  };
}

function maskedContent(content: HandoffContent): HandoffContent {
  const entries = HANDOFF_SECTION_KEYS.map((key) => [key, maskedSecrets(content[key])]);
  return Object.fromEntries(entries) as HandoffContent;
}

/** The preview and target routes are read-only: neither writes a file, a note row or any session state. The save route writes the handoff file and its note. */
export function registerHandoffRoutes(router: Router, deps: HandoffRouteDeps): void {
  const requireSession = (id: string): Session => {
    const session = deps.sessions.get(id);
    if (!session) throw new SessionNotFoundForHandoffError(id);
    return session;
  };

  router.add('POST', '/api/sessions/:id/handoff', ({ res, params, body }) => {
    const session = requireSession(params.id!);
    const content = maskedContent(HandoffContentSchema.parse(body));

    const recentSave = deps.identicalGuard.recentSaveOf(session.id, content);
    if (recentSave) return json(res, 200, { note: summaryOf(recentSave.note), relativePath: recentSave.relativePath });

    const note = deps.handoffs.write(session.id, content, { author: HANDOFF_AUTHOR });
    const relativePath = deps.docs.docsRelativePath(note)!;
    deps.identicalGuard.remember(session.id, content, { note, relativePath });
    json(res, 201, { note: summaryOf(note), relativePath });
  });

  router.add('GET', '/api/sessions/:id/handoff-preview', ({ res, params }) => {
    const session = requireSession(params.id!);
    const draft = deps.buildDraft(session.id);
    const preview: HandoffPreview = {
      sessionId: session.id,
      kind: deps.managers.get(session.id) ? 'manager' : 'session',
      sections: draft.content,
      sources: draft.sources,
      truncated: draft.truncated,
      target: deps.resolveTarget(session),
      generatedAt: deps.clock(),
    };
    json(res, 200, preview);
  });

  router.add('GET', '/api/sessions/:id/handoff-target', ({ res, params }) => {
    const target: HandoffTarget = deps.resolveTarget(requireSession(params.id!));
    json(res, 200, target);
  });
}
