import type { ManagerBaseRead } from '@openfleet/shared';
import type { ManagerBaseIdentity } from './managerView.js';

export type BaseNotReadEnforcement = 'warn_only' | 'refuse';

/** A manager that spawns without the current base is refused with base_not_read; 'warn_only' downgrades the refusal to a warning. */
export const BASE_NOT_READ_ENFORCEMENT: BaseNotReadEnforcement = 'refuse';

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
