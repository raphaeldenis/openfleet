import type { DataStore } from '@openfleet/shared';
import { StoreNotFoundError, type DataStoreRepository } from '../stores/dataStoreRepository.js';

/** The caller's own store a reference names, by id or else by display name; a foreign or missing store reads the same. */
export function ownStoreOf(storeRepo: DataStoreRepository, reference: string, scope: { projectId: string }): DataStore {
  const storeWithThatId = storeRepo.findStore(reference);
  const store = storeWithThatId?.projectId === scope.projectId ? storeWithThatId : storeRepo.findStoreByName(scope.projectId, reference);
  if (!store) throw new StoreNotFoundError(reference);
  return store;
}
