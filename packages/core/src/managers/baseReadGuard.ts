import type { ManagerBaseRead } from '@openfleet/shared';
import type { ManagerBaseIdentity } from './managerView.js';

export type BaseNotReadEnforcement = 'warn_only' | 'refuse';

/** The first week after the guard ships, a manager that spawns without the current base only gets a warning; set this to 'refuse' to turn the warning into the base_not_read refusal. */
export const BASE_NOT_READ_ENFORCEMENT: BaseNotReadEnforcement = 'warn_only';

export type BaseReadVerdict = 'allow' | 'warn' | 'refuse';

/** Whether a manager that read `record.baseRead` may spawn against the base the daemon ships. */
export function baseReadVerdictOf({ record, currentBase, enforcement = BASE_NOT_READ_ENFORCEMENT }: {
  record: { baseRead?: ManagerBaseRead };
  currentBase: ManagerBaseIdentity;
  enforcement?: BaseNotReadEnforcement;
}): BaseReadVerdict {
  const { baseRead } = record;
  const hasReadCurrentBase = baseRead?.version === currentBase.version && baseRead.sha === currentBase.sha;
  if (hasReadCurrentBase) return 'allow';
  return enforcement === 'refuse' ? 'refuse' : 'warn';
}
