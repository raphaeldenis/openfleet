import type { CommandPolicyDocument, PolicyRequest, PolicyVerdict } from '@openfleet/shared';
import { DEFAULT_COMMAND_POLICY } from './defaultCommandPolicy.js';

export interface RepeatEscalation { count: number; windowSeconds: number }

export interface UnattendedSettings {
  /** A permission dialog nobody can answer becomes an immediate refusal. */
  askBecomesDeny: boolean;
  /** How many identical refusals in a window make the manager hear about it. */
  escalateAfterRepeats: RepeatEscalation;
}

/** The single source of truth for what the daemon enforces; the daemon builds it once and hands it to everything that decides. */
export interface CommandPolicySettings {
  document: CommandPolicyDocument;
  unattended: UnattendedSettings;
}

export type PolicyEvaluate = (request: PolicyRequest, document: CommandPolicyDocument) => PolicyVerdict;

/** The delivered rules, watching only: the role profiles journal what they would refuse until usage shows which refusals are right. */
export function defaultCommandPolicySettings(): CommandPolicySettings {
  return {
    document: { ...DEFAULT_COMMAND_POLICY, mode: 'observe' },
    unattended: { askBecomesDeny: true, escalateAfterRepeats: { count: 3, windowSeconds: 300 } },
  };
}
