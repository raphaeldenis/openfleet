import type { GovernanceProposalView, LawPayload, PermissionPayload, ProposalKind, ProposalStatus, ResourceAccess, ResourceAccessPayload } from '@openfleet/shared';
import { showBidiControlsAsEscapes } from '../core/bidi-escapes';

export interface Detail {
  readonly label: string;
  readonly value: string;
}

const EXCERPT_CHARS = 40;

const PERMISSION_FIELDS = [
  { key: 'action', label: 'Action' },
  { key: 'scope', label: 'Scope' },
  { key: 'condition', label: 'Condition' },
  { key: 'exclusions', label: 'Exclusions' },
] as const;

const ACCESS_LABELS: Record<ResourceAccess, string> = {
  read: 'Read',
  readWrite: 'Read and write',
  append: 'Append',
  run: 'Run',
  use: 'Use',
};

export const STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
};

export const PROPOSAL_TYPE_LABELS: Record<ProposalKind, string> = {
  law: 'law',
  permission: 'permission',
  resourceAccess: 'resource access',
};

export const accessLabelOf = (access: ResourceAccess): string => ACCESS_LABELS[access];

export const waitingCountLabelOf = (count: number): string => `${count} waiting`;
export const waitingBlockTitleOf = (count: number): string => `Waiting (${count})`;

/** The labelled lines a proposal is read from; every value is plain text with bidirectional controls shown as escapes. */
export function proposalDetailsOf(proposal: Pick<GovernanceProposalView, 'kind' | 'payload'>, nameOfResource: (access: ResourceAccessPayload) => string): Detail[] {
  const plain = showBidiControlsAsEscapes;
  if (proposal.kind === 'law') return [{ label: 'Law', value: plain((proposal.payload as LawPayload).text) }];
  if (proposal.kind === 'permission') {
    const permission = proposal.payload as PermissionPayload;
    return PERMISSION_FIELDS.map(({ key, label }) => ({ label, value: plain(permission[key]) }));
  }
  const access = proposal.payload as ResourceAccessPayload;
  return [
    { label: access.resourceType === 'dataStore' ? 'Table' : 'Note', value: plain(nameOfResource(access)) },
    { label: 'Access', value: accessLabelOf(access.access) },
    { label: 'Role', value: plain(access.role) },
  ];
}

/** The first characters of what a proposal asks, enough to tell two proposals of one manager apart. */
export function excerptOf(details: readonly Detail[]): string {
  const firstValue = details[0]?.value ?? '';
  const isTruncated = firstValue.length > EXCERPT_CHARS;
  return isTruncated ? `${firstValue.slice(0, EXCERPT_CHARS)}…` : firstValue;
}
