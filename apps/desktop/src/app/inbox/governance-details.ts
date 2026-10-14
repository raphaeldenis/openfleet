import type { GovernanceProposalView, LawPayload, PermissionPayload, ResourceAccessPayload } from '@openfleet/shared';
import { showBidiControlsAsEscapes } from '../core/bidi-escapes';

export interface Detail {
  readonly label: string;
  readonly value: string;
}

const PERMISSION_FIELDS = [
  { key: 'action', label: 'Action' },
  { key: 'scope', label: 'Scope' },
  { key: 'condition', label: 'Condition' },
  { key: 'exclusions', label: 'Exclusions' },
] as const;

/** The labelled lines a proposal is read from; every value is plain text with bidirectional controls shown as escapes. */
export function proposalDetailsOf(proposal: GovernanceProposalView, nameOfResource: (access: ResourceAccessPayload) => string): Detail[] {
  const plain = showBidiControlsAsEscapes;
  if (proposal.kind === 'law') return [{ label: 'Law', value: plain((proposal.payload as LawPayload).text) }];
  if (proposal.kind === 'permission') {
    const permission = proposal.payload as PermissionPayload;
    return PERMISSION_FIELDS.map(({ key, label }) => ({ label, value: plain(permission[key]) }));
  }
  const access = proposal.payload as ResourceAccessPayload;
  return [
    { label: access.resourceType === 'dataStore' ? 'Table' : 'Note', value: plain(nameOfResource(access)) },
    { label: 'Access', value: access.access },
    { label: 'Role', value: plain(access.role) },
  ];
}
