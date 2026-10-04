import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKDOWN_NOTE_ID, type ScapeFixture } from './scapeFixture.testkit.js';

export const LEAD_ARGUS_ID = 'A0000001-0000-0000-0000-000000000001';
export const CAPTAIN_ARGUS_ID = 'A0000002-0000-0000-0000-000000000002';

type RawGovernanceRequest = Record<string, unknown>;

export const anApprovedLaw = (text: string, createdAt = 811_100_000): RawGovernanceRequest => ({ id: `law-${text}`, kind: 'law', status: 'approved', text, incident: 'why', createdAt });
export const aDeniedLaw = (text: string): RawGovernanceRequest => ({ ...anApprovedLaw(text), status: 'denied', denialReason: 'no' });
export const aPendingLaw = (text: string): RawGovernanceRequest => ({ ...anApprovedLaw(text), status: 'pending' });
export const anApprovedPermission = (input: { text: string; scope: string; condition: string; exclusions: string }): RawGovernanceRequest => ({
  id: `permission-${input.text}`, kind: 'permission', status: 'approved', incident: 'why', createdAt: 811_100_100, ...input,
});
export const anApprovedResourceAccess = (): RawGovernanceRequest => ({
  id: 'access-1', kind: 'resourceAccess', status: 'approved', requestedAccess: 'run', requestedRole: 'reference', resourceType: 'playbook', resourceId: 'p-1', createdAt: 811_100_200,
});

export const aGrant = (input: { resourceType: string; resourceId: string; access: string }) => ({ id: `grant-${input.resourceId}`, role: 'reference', displayName: 'ignored', addedAt: 811_100_300, ...input });

/** A raw `arguses.json` entry shaped like the Scape file, with synthetic values. */
export const anArgus = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: LEAD_ARGUS_ID,
  name: 'Alpha',
  model: 'sonnet',
  harnessId: 'claude-code',
  pulseInterval: 600,
  childrenCap: 4,
  noteId: MARKDOWN_NOTE_ID,
  createdAt: 811_089_911.9,
  lastPulseAt: 812_818_698.8,
  scratchDir: '/scape/argus/alpha',
  backingResumeId: 'resume-me-not',
  governanceRequests: [],
  resourceGrants: [],
  ...overrides,
});

export const writeArguses = (fixture: ScapeFixture, arguses: Record<string, unknown>[]): void =>
  writeFileSync(join(fixture.scapeDir, 'arguses.json'), JSON.stringify({ schemaVersion: 1, arguses }));
