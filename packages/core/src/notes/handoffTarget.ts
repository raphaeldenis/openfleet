import type { HandoffTarget, Session } from '@openfleet/shared';
import type { DocsFolderService } from './docsFolderService.js';
import type { HandoffSettings } from './handoffSettings.js';

export type ResolveHandoffTarget = (session: Pick<Session, 'name' | 'projectId'>) => HandoffTarget;

/**
 * Answers where a handoff of a session would be written, cheaply: it reads the project row and the docs folder
 * (no git, no working state) and writes nothing. A session without a project is unavailable with `no_project`.
 */
export function createHandoffTargetResolver(deps: { docs: Pick<DocsFolderService, 'previewNewNotePath'>; settings: HandoffSettings }): ResolveHandoffTarget {
  return (session) => {
    const unavailable = (reason: NonNullable<HandoffTarget['reason']>): HandoffTarget => ({ available: false, reason, writeOnCloseDefault: false });
    if (!session.projectId) return unavailable('no_project');

    const preview = deps.docs.previewNewNotePath({ projectId: session.projectId, folder: 'handoffs', title: session.name });
    if (preview.outcome === 'no_project') return unavailable('no_project');
    if (preview.outcome === 'no_docs_folder') return unavailable('no_docs_folder');
    if (preview.outcome === 'unusable') return unavailable('docs_folder_unusable');
    return { available: true, relativePath: preview.relativePath, writeOnCloseDefault: deps.settings.writeOnClose };
  };
}
