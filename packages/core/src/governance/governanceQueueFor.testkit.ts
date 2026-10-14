import type { DatabaseSync } from 'node:sqlite';
import { EventBus } from '../events/eventBus.js';
import { newId } from '../ids.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { GovernanceQueueService } from './governanceQueueService.js';

/** A governance queue over `db` for tests that build the MCP handler by hand; the daemon builds its own. */
export function governanceQueueFor(db: DatabaseSync): GovernanceQueueService {
  const noteRepo = new NoteRepository(db);
  const storeRepo = new DataStoreRepository(db);
  const projectIdOfSession = (sessionId: string) => (db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as { project_id: string | null } | undefined)?.project_id ?? undefined;
  return new GovernanceQueueService({
    db, bus: new EventBus(), clock: () => new Date().toISOString(), newId,
    managers: { isManager: (sessionId) => db.prepare('SELECT 1 FROM managers WHERE session_id = ?').get(sessionId) !== undefined, projectIdOf: projectIdOfSession },
    linkTargets: { noteProjectId: (noteId) => noteRepo.getProjectId(noteId), storeProjectId: (storeId) => storeRepo.findStore(storeId)?.projectId },
  });
}
