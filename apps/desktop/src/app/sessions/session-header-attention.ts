import type { Session } from '@openfleet/shared';

export interface HeaderAttentionFacts {
  hasPendingModelSwitch: boolean;
  permissionMode: Session['permissionMode'];
  modelDriftedFrom: Session['modelDriftedFrom'];
}

/** Returns true when the session shows something the user must see in the expanded header. */
export function needsAttention({ hasPendingModelSwitch, permissionMode, modelDriftedFrom }: HeaderAttentionFacts): boolean {
  if (hasPendingModelSwitch) return true;
  const isBypassingPermissions = permissionMode === 'bypassPermissions';
  if (isBypassingPermissions) return true;
  const hasModelDrifted = Boolean(modelDriftedFrom);
  return hasModelDrifted;
}
