import * as z from 'zod';

export const MAX_PENDING_PROPOSALS_PER_MANAGER = 10;
export const MAX_QUEUED_PROPOSALS_PER_MANAGER = 50;
export const MAX_DENIED_HISTORY_PER_MANAGER = 20;
export const MAX_AUDIT_HISTORY_PER_MANAGER = 50;

export const MAX_LAW_TEXT_CHARS = 2000;
export const MAX_PERMISSION_FIELD_CHARS = 500;
export const MAX_INCIDENT_CHARS = 1000;
export const MAX_ROLE_CHARS = 80;
export const MAX_DENIAL_REASON_CHARS = 500;

export const PROPOSAL_KINDS = ['law', 'permission', 'resourceAccess'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = ['pending', 'approved', 'denied', 'withdrawn'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const RESOURCE_TYPES = ['dataStore', 'note', 'playbook', 'integration'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_ACCESSES = ['read', 'readWrite', 'append', 'run', 'use'] as const;
export type ResourceAccess = (typeof RESOURCE_ACCESSES)[number];

/** The accesses a kind of resource can be granted. */
export const ACCESSES_BY_RESOURCE_TYPE: Readonly<Record<ResourceType, readonly ResourceAccess[]>> = {
  dataStore: ['read', 'readWrite'],
  note: ['read', 'readWrite', 'append'],
  playbook: ['run'],
  integration: ['use'],
};

/** The resource types a grant can name today: OpenFleet has no playbook or integration registry yet. */
export const GRANTABLE_RESOURCE_TYPES = ['dataStore', 'note'] as const satisfies readonly ResourceType[];

export const LawPayloadSchema = z.object({ text: z.string() });
export const PermissionPayloadSchema = z.object({ action: z.string(), scope: z.string(), condition: z.string(), exclusions: z.string() });
export const ResourceAccessPayloadSchema = z.object({
  resourceType: z.enum(RESOURCE_TYPES), resourceId: z.string(), access: z.enum(RESOURCE_ACCESSES), role: z.string(),
});

export type LawPayload = z.infer<typeof LawPayloadSchema>;
export type PermissionPayload = z.infer<typeof PermissionPayloadSchema>;
export type ResourceAccessPayload = z.infer<typeof ResourceAccessPayloadSchema>;

export const PAYLOAD_SCHEMA_BY_KIND = {
  law: LawPayloadSchema,
  permission: PermissionPayloadSchema,
  resourceAccess: ResourceAccessPayloadSchema,
} as const satisfies Record<ProposalKind, z.ZodType>;

export type ProposalPayload = LawPayload | PermissionPayload | ResourceAccessPayload;

export interface GovernanceProposalView {
  id: string;
  managerId: string;
  kind: ProposalKind;
  status: ProposalStatus;
  incident: string;
  payload: ProposalPayload;
  denialReason?: string;
  createdAt: string;
  decidedAt?: string;
}

/** A proposal filed beyond the pending places: it waits, in filing order, until a place frees up and is then released as a pending proposal with the same id. */
export interface WaitingProposalView {
  id: string;
  managerId: string;
  kind: ProposalKind;
  incident: string;
  payload: ProposalPayload;
  createdAt: string;
  /** Rank in the waiting list of the manager, starting at 1. */
  position: number;
}

export interface ResourceGrantView {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  role: string;
  access: ResourceAccess;
  grantedAt: string;
  proposalId?: string;
}

export const MAX_LAWS_RESPONSE_BYTES = 256 * 1024;

/** The human the daemon records as the author of a decision: the holder of the admin token. */
export const HUMAN_ACTOR = 'admin';

export const LAW_STATUSES = ['active', 'withdrawn'] as const;
export type LawStatus = (typeof LAW_STATUSES)[number];

export const LAW_SOURCE_KINDS = ['proposal', 'legacy', 'import'] as const;
export type LawSourceKind = (typeof LAW_SOURCE_KINDS)[number];

/** A standing rule of one manager. */
export interface LawView {
  id: string;
  managerId: string;
  text: string;
  status: LawStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  withdrawnAt?: string;
  approvedBy?: string;
  updatedBy?: string;
  withdrawnBy?: string;
  source: LawSourceKind;
  sourceCreatedAt?: string;
  proposalId?: string;
}

/** A law as the manager reads it. */
export interface ManagerLawView {
  id: string;
  text: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  source: LawSourceKind;
}

/** What a manager sees of its own governance: grants are informative until the server enforces them. */
export interface ManagerGovernanceView {
  resourceGrants: ResourceGrantView[];
  pending: GovernanceProposalView[];
  /** Proposals waiting for a pending place, oldest first. */
  queued: WaitingProposalView[];
  denied: GovernanceProposalView[];
  /** Approved and withdrawn proposals, newest first. */
  history: GovernanceProposalView[];
  governanceEvictedDenials: number;
}

/** The governance of a manager together with its laws, active and withdrawn, oldest first. */
export interface ManagerGovernanceWithLawsView extends ManagerGovernanceView {
  laws: LawView[];
}
