import type { MentionKind } from '@openfleet/shared';
import { describePermissionBound, fitsMentionSyntax, openFleetMentionKindOf } from '../inlineVisitors.js';
import type { ScapeGovernanceRequest, ScapeResourceGrant } from './scapeArguses.js';

const APPROVED = 'approved';
const SECTION_SEPARATOR = '\n\n';
const CONTINUATION_INDENT = '  ';
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/;

const ACCESS_WORDING: Record<string, string> = { read: 'read', readWrite: 'read and write', run: 'run' };

export type ResourceAvailability = 'available' | 'pending' | 'missing';

export interface MissionParts {
  noteBody: string;
  governanceRequests: ScapeGovernanceRequest[];
  resourceGrants: ScapeResourceGrant[];
  availabilityOf: (resource: { kind: MentionKind; id: string }) => ResourceAvailability;
}

export interface Mission {
  text: string;
  hasUnconvertedGrant: boolean;
  pendingPlaybookMentionCount: number;
}

interface ExposedResource { line: string; isConverted: boolean; isPendingPlaybook: boolean }

const approvedRequestsOf = (requests: ScapeGovernanceRequest[], kind: string) =>
  requests.filter((request) => request.kind === kind && request.status === APPROVED).sort((a, b) => a.createdAt - b.createdAt);

const indentContinuationLines = (text: string) => text.replaceAll('\n', `\n${CONTINUATION_INDENT}`);

const bulletOf = (entry: string) => `- ${indentContinuationLines(entry)}`;

const permissionEntry = (permission: ScapeGovernanceRequest) => {
  const bound = describePermissionBound(permission);
  return bound === undefined ? permission.text : `${permission.text}\n${bound}`;
};

function lawsSections(governanceRequests: ScapeGovernanceRequest[]): string[] {
  const laws = approvedRequestsOf(governanceRequests, 'law');
  const permissions = approvedRequestsOf(governanceRequests, 'permission');
  const hasNothingToState = laws.length === 0 && permissions.length === 0;
  if (hasNothingToState) return [];

  const standingLaws = laws.length === 0 ? [] : [['### Standing laws', ...laws.map((law) => bulletOf(law.text))].join('\n')];
  const permissionSection = permissions.length === 0 ? [] : [['### Permissions', ...permissions.map((permission) => bulletOf(permissionEntry(permission)))].join('\n')];
  return ['## Laws', ...standingLaws, ...permissionSection];
}

const notConverted = (what: string): ExposedResource => ({ line: `- [not converted: ${what}]`, isConverted: false, isPendingPlaybook: false });

function exposedResourceOf(grant: ScapeResourceGrant, availabilityOf: MissionParts['availabilityOf']): ExposedResource {
  const mentionKind = openFleetMentionKindOf(grant.resourceType);
  if (mentionKind === undefined) return notConverted('resource type');
  if (!fitsMentionSyntax(grant.resourceId)) return notConverted(mentionKind);
  const isKnownAccess = Object.hasOwn(ACCESS_WORDING, grant.access);
  if (!isKnownAccess) return notConverted(`${mentionKind} access`);

  const availability = availabilityOf({ kind: mentionKind, id: grant.resourceId });
  const line = `- @${mentionKind}:${grant.resourceId} (${ACCESS_WORDING[grant.access]})`;
  return { line, isConverted: availability !== 'missing', isPendingPlaybook: availability === 'pending' };
}

/** The delimiter of a code fence the markdown leaves open at its end, if any. */
function openFenceAtEnd(markdown: string): string | undefined {
  let openFence: string | undefined;
  for (const line of markdown.split('\n')) {
    const fence = FENCE_OPENER.exec(line)?.[1];
    if (fence === undefined) continue;
    if (openFence === undefined) { openFence = fence; continue; }
    const closesTheOpenFence = fence[0] === openFence[0] && fence.length >= openFence.length && line.trim() === fence;
    if (closesTheOpenFence) openFence = undefined;
  }
  return openFence;
}

function closedNoteBody(noteBody: string): string {
  const body = noteBody.trimEnd();
  const openFence = openFenceAtEnd(body);
  return openFence === undefined ? body : `${body}\n${openFence}`;
}

/** Builds the mission of an imported manager: the mission note body, the approved laws and permissions in prose, and the exposed resources as mentions. */
export function composeMission(parts: MissionParts): Mission {
  const exposedResources = parts.resourceGrants.map((grant) => exposedResourceOf(grant, parts.availabilityOf));
  const exposedResourcesSection = exposedResources.length === 0 ? [] : [['## Exposed Resources', ...exposedResources.map(({ line }) => line)].join('\n')];
  const noteBody = closedNoteBody(parts.noteBody);
  const noteSection = noteBody === '' ? [] : [noteBody];
  return {
    text: [...noteSection, ...lawsSections(parts.governanceRequests), ...exposedResourcesSection].join(SECTION_SEPARATOR),
    hasUnconvertedGrant: exposedResources.some(({ isConverted }) => !isConverted),
    pendingPlaybookMentionCount: exposedResources.filter(({ isPendingPlaybook }) => isPendingPlaybook).length,
  };
}
