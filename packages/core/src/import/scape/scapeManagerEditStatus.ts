import type { DatabaseSync } from 'node:sqlite';
import type { ScapeImportStatus } from '@openfleet/shared';
import { ManagerRepository } from '../../managers/managerRepository.js';
import { SessionRepository } from '../../sessions/sessionRepository.js';
import { hashOfValues, ImportLedger } from './scapeLedger.js';
import { storedValuesOf } from './scapeManagersWriter.js';

/**
 * Tells whether a manager came from a Scape import and whether OpenFleet changed it since: the same compare a re-import makes
 * (what is stored against what the last import wrote), so "edited" is exactly the case where a re-import leaves the manager alone.
 */
export function scapeImportStatusOfManager(db: DatabaseSync, sessionId: string): ScapeImportStatus {
  const lastImportedHash = new ImportLedger(db).hashOf('manager', sessionId);
  const isNeverImported = lastImportedHash === undefined;
  if (isNeverImported) return 'not_imported';
  const storedValues = storedValuesOf({ sessions: new SessionRepository(db), managers: new ManagerRepository(db) }, sessionId);
  const isUnchangedSinceImport = storedValues !== undefined && hashOfValues(storedValues) === lastImportedHash;
  return isUnchangedSinceImport ? 'as_imported' : 'edited_in_openfleet';
}
