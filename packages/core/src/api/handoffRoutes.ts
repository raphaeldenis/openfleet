import type { HandoffPreview, HandoffTarget, Session } from '@openfleet/shared';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import { createHandoffDraftBuilder, type BuildHandoffDraft, type HandoffDraftDeps } from '../notes/handoffDraft.js';
import { SessionNotFoundForHandoffError } from '../notes/handoffErrors.js';
import type { HandoffSettings } from '../notes/handoffSettings.js';
import { createHandoffTargetResolver, type ResolveHandoffTarget } from '../notes/handoffTarget.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import { json, type Router } from './router.js';

export interface HandoffRouteDeps {
  sessions: { get(id: string): Session | undefined };
  managers: { get(sessionId: string): unknown };
  buildDraft: BuildHandoffDraft;
  resolveTarget: ResolveHandoffTarget;
  clock: () => string;
}

export interface HandoffWiring extends HandoffDraftDeps {
  docs: Pick<DocsFolderService, 'previewNewNotePath'>;
  projects: Pick<ProjectRepository, 'get'>;
  settings: HandoffSettings;
  clock: () => string;
}

/** Builds the dependencies of the handoff routes from the services the daemon already holds. */
export function createHandoffRouteDeps(wiring: HandoffWiring): HandoffRouteDeps {
  return {
    sessions: wiring.sessions,
    managers: wiring.managers,
    buildDraft: createHandoffDraftBuilder(wiring),
    resolveTarget: createHandoffTargetResolver({ docs: wiring.docs, settings: wiring.settings }),
    clock: wiring.clock,
  };
}

/** Read-only handoff routes: neither writes a file, a note row or any session state. */
export function registerHandoffRoutes(router: Router, deps: HandoffRouteDeps): void {
  const requireSession = (id: string): Session => {
    const session = deps.sessions.get(id);
    if (!session) throw new SessionNotFoundForHandoffError(id);
    return session;
  };

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
