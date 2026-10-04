import { describePermissionBound, fitsMentionSyntax, openFleetMentionKindOf } from '../inlineVisitors.js';
import type { ScapeGovernanceRequest, ScapeResourceGrant } from './scapeArguses.js';

const APPROVED = 'approved';
const SECTION_SEPARATOR = '\n\n';
const CONTINUATION_INDENT = '  ';

const ACCESS_WORDING: Record<string, string> = { read: 'read', readWrite: 'read and write', run: 'run' };

export interface MissionParts {
  noteBody: string;
  governanceRequests: ScapeGovernanceRequest[];
  resourceGrants: ScapeResourceGrant[];
}

export interface Mission {
  text: string;
  hasUnconvertedGrant: boolean;
}

const approvedRequestsOf = (requests: ScapeGovernanceRequest[], kind: string) =>
  requests.filter((request) => request.kind === kind && request.status === APPROVED).sort((a, b) => a.createdAt - b.createdAt);

const indentContinuationLines = (text: string) => text.replaceAll('\n', `\n${CONTINUATION_INDENT}`);

const lawBullet = (law: ScapeGovernanceRequest) => `- ${indentContinuationLines(law.text)}`;

function permissionBullet(permission: ScapeGovernanceRequest): string {
  const bound = describePermissionBound(permission);
  const boundLine = bound === undefined ? '' : `\n${CONTINUATION_INDENT}${bound}`;
  return `- ${indentContinuationLines(permission.text)}${boundLine}`;
}

function lawsSections(governanceRequests: ScapeGovernanceRequest[]): string[] {
  const laws = approvedRequestsOf(governanceRequests, 'law');
  const permissions = approvedRequestsOf(governanceRequests, 'permission');
  const hasNothingToState = laws.length === 0 && permissions.length === 0;
  if (hasNothingToState) return [];

  const standingLaws = laws.length === 0 ? [] : [['### Standing laws', ...laws.map(lawBullet)].join('\n')];
  const permissionSection = permissions.length === 0 ? [] : [['### Permissions', ...permissions.map(permissionBullet)].join('\n')];
  return ['## Laws', ...standingLaws, ...permissionSection];
}

function exposedResourceLine(grant: ScapeResourceGrant): { line: string; isConverted: boolean } {
  const mentionKind = openFleetMentionKindOf(grant.resourceType);
  const isMentionable = mentionKind !== undefined && fitsMentionSyntax(grant.resourceId);
  if (!isMentionable) return { line: `- [not converted: ${grant.resourceType}]`, isConverted: false };

  const accessWording = Object.hasOwn(ACCESS_WORDING, grant.access) ? ACCESS_WORDING[grant.access] : grant.access;
  return { line: `- @${mentionKind}:${grant.resourceId} (${accessWording})`, isConverted: true };
}

/** Builds the mission of an imported manager: the mission note body, the approved laws and permissions in prose, and the exposed resources as mentions. */
export function composeMission(parts: MissionParts): Mission {
  const exposedResources = parts.resourceGrants.map(exposedResourceLine);
  const exposedResourcesSection = exposedResources.length === 0 ? [] : [['## Exposed Resources', ...exposedResources.map(({ line }) => line)].join('\n')];
  const noteBody = parts.noteBody.trimEnd();
  const sections = [...(noteBody === '' ? [] : [noteBody]), ...lawsSections(parts.governanceRequests), ...exposedResourcesSection];
  return { text: sections.join(SECTION_SEPARATOR), hasUnconvertedGrant: exposedResources.some(({ isConverted }) => !isConverted) };
}
