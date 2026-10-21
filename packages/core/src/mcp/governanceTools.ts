import { MAX_LAWS_RESPONSE_BYTES, MAX_PENDING_PROPOSALS_PER_MANAGER, MAX_QUEUED_PROPOSALS_PER_MANAGER, type LawView, type ManagerLawView, type ProposalKind, type ProposalPayload, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GovernanceQueueService, ProposalFiled } from '../governance/governanceQueueService.js';
import { ok, truncateToByteBudget } from './toolResults.js';

export interface RegisterGovernanceToolsDeps {
  governanceQueue: GovernanceQueueService;
  caller: Session;
}

const PENDING_NOTE = 'Pending: this grants nothing until a human approves it. Once approved, a law appears in the laws of get_argus_governance.';
const GOVERNANCE_NOTE = `Your active laws are in \`laws\` (the approved law text is the rule in force); history only audits decisions. If \`lawsTruncated\` is true, \`laws\` holds the first laws only and \`lawsTotal\` counts them all. A pending proposal grants nothing. Beyond ${MAX_PENDING_PROPOSALS_PER_MANAGER} pending proposals, the next ones wait in \`queued\` (\`queuedCount\`, up to ${MAX_QUEUED_PROPOSALS_PER_MANAGER}) and are released to pending in filing order as the pending ones are answered or withdrawn: do not re-propose a queued proposal. Resource grants are informative: the server does not enforce them yet. Do not re-propose a denied proposal on the same incident.`;
const QUEUE_CAPACITY_SENTENCE = `At most ${MAX_PENDING_PROPOSALS_PER_MANAGER} proposals are pending at once; the next ones (up to ${MAX_QUEUED_PROPOSALS_PER_MANAGER}) wait in a queue and are released in order, so do not re-propose them; past that, the call is refused with governance_queue_full: withdraw one of your own (withdraw_proposal) or wait.`;

const queuedNote = (position: number) => `Queued, position ${position}: this grants nothing. It is released in order as a pending proposal when a place frees up; do not re-propose it.`;

const JSON_ARRAY_BRACKET_BYTES = 2;

/** The active laws of the manager within the response budget: whole laws only, and a flag with the total when some are left out. */
function lawsReadout(laws: LawView[]) {
  const activeLaws: ManagerLawView[] = laws
    .filter((law) => law.status === 'active')
    .map(({ id, text, revision, createdAt, updatedAt, source }) => ({ id, text, revision, createdAt, updatedAt, source }));
  const { items: shown, truncated } = truncateToByteBudget(activeLaws, MAX_LAWS_RESPONSE_BYTES - JSON_ARRAY_BRACKET_BYTES, { bytesBetweenItems: 1 });
  return truncated ? { laws: shown, lawsTruncated: true, lawsTotal: activeLaws.length } : { laws: shown };
}

const LAW_INCIDENT_FIELD = z.string().describe('REQUIRED. The triggering incident: a log-table row reference, ticket key, or a one-line description of what went wrong.');
const PERMISSION_INCIDENT_FIELD = z.string().describe('REQUIRED. The triggering incident: log-table row reference, ticket key, or one-line description.');
const RESOURCE_ACCESS_INCIDENT_FIELD = z.string().describe('REQUIRED. What prompted this request: log-table row, ticket key, or one-line description.');

const acknowledgement = ({ proposal, deduplicated, status, position, queuedCount }: ProposalFiled) => ok({
  request_id: proposal.id,
  status,
  ...(position !== undefined && { position }),
  queuedCount,
  note: position === undefined ? PENDING_NOTE : queuedNote(position),
  ...(deduplicated && { deduplicated: true }),
});

const proposalSummary = (proposal: { id: string; kind: ProposalKind; payload: ProposalPayload; incident: string }) => ({ request_id: proposal.id, kind: proposal.kind, ...proposal.payload, incident: proposal.incident });

export function registerGovernanceTools(server: McpServer, deps: RegisterGovernanceToolsDeps): void {
  const { governanceQueue, caller } = deps;
  const managerId = caller.id;

  server.registerTool('propose_law', {
    description: `Propose a new LAW — a fixed invariant that CONSTRAINS how you work (e.g. “never repurpose a session to a new branch — close it, open a fresh one”). The human approves or denies it. A pending proposal grants NOTHING: it is awaiting review, not in force. Once the human approves it, it becomes an active law, listed in get_argus_governance. Every proposal must cite its triggering incident — a proposal with no evidence is speculation. ${QUEUE_CAPACITY_SENTENCE} Only available to an Argus manager session.`,
    inputSchema: { body: z.string().describe('The proposed law, phrased as a standing rule (“every time you do X it must be Y”).'), incident: LAW_INCIDENT_FIELD },
  }, async ({ body, incident }) => acknowledgement(governanceQueue.proposeLaw({ managerId, text: body, incident })));

  server.registerTool('propose_permission', {
    description: `Propose a new STANDING PERMISSION — something you would do UNASKED, which EXPANDS your scope (materially different from a law, which constrains you; the human reviews these in a separate list). Every permission must state its full bound: scope (what), condition (when), and exclusions (what is still NOT covered) — a permission without a bound is a blank cheque and will be refused. Canonical example: “reap worktrees — non-destructive, one at a time, only when 1-min load < 30”. A pending proposal grants NOTHING. Requires the triggering incident. ${QUEUE_CAPACITY_SENTENCE} Only available to an Argus manager session.`,
    inputSchema: {
      action: z.string().describe('The action you want standing permission to perform unasked.'),
      scope: z.string().describe('REQUIRED bound: what exactly the permission covers.'),
      condition: z.string().describe('REQUIRED bound: when it applies (load, time, state preconditions).'),
      exclusions: z.string().describe('REQUIRED bound: what remains OUTSIDE this permission.'),
      incident: PERMISSION_INCIDENT_FIELD,
    },
  }, async (fields) => acknowledgement(governanceQueue.proposePermission({ managerId, ...fields })));

  server.registerTool('request_resource_access', {
    description: `Request access to a resource (data store or note) for your exposed-resources grant list. The human approves or denies; on approval a grant entry (resource + role + access level) is created. A pending request grants NOTHING — check get_argus_governance for the outcome; do not assume access. Access levels: read, readWrite, append (notes only). Playbooks and integrations are not available in OpenFleet yet. Requires the triggering incident/need. ${QUEUE_CAPACITY_SENTENCE} Only available to an Argus manager session.`,
    inputSchema: {
      resource_type: z.string().describe('One of: dataStore, note, playbook, integration.'),
      resource_id: z.string().describe("The target's id (data store UUID, note UUID, playbook id, or integration id)."),
      access: z.string().describe('Requested access level: read | readWrite | append | run (playbook-only) | use (integration-only — call its tools).'),
      role: z.string().describe("Why you need it — the resource's role for you (e.g. work-source, journal, instruction, reference)."),
      incident: RESOURCE_ACCESS_INCIDENT_FIELD,
    },
  }, async ({ resource_type, resource_id, access, role, incident }) =>
    acknowledgement(governanceQueue.requestResourceAccess({ managerId, resourceType: resource_type, resourceId: resource_id, access, role, incident })));

  server.registerTool('withdraw_proposal', {
    description: 'Withdraw one of YOUR OWN still-pending or queued proposals (law, permission, or resource access) — e.g. to make room for something you just learned that matters more. Withdrawing a pending proposal frees a place: the oldest queued proposal is released as pending. Withdrawing a queued proposal erases it. Only pending or queued proposals can be withdrawn; approved/denied ones are history and immutable. Only available to an Argus manager session.',
    inputSchema: { request_id: z.string().describe("id of the pending or queued request to withdraw (from the propose tool's ack or get_argus_governance).") },
  }, async ({ request_id }) => {
    const withdrawn = governanceQueue.withdraw({ managerId, proposalId: request_id });
    return ok({ request_id: withdrawn.id, status: withdrawn.status });
  });

  server.registerTool('get_argus_governance', {
    description: 'Read back your governance state with DISTINCT statuses — never conflate them: (1) resource GRANTS recorded (resource + role + access level; informative, not enforced by the server yet); (2) PENDING proposals (awaiting human review — a pending proposal grants nothing) and QUEUED proposals (`queued`, `queuedCount`: waiting for a pending place, released in order, not yet seen by the human — do not re-propose them); (3) DENIED proposals with the denial reason (do not re-propose these on the same incident); (4) approval/withdrawal history (AUDIT records only — never a rule in force); (5) your active LAWS (`laws`: the rules in force, the approved text; if `lawsTruncated` is true only the first are listed and `lawsTotal` counts them all). Also discloses if any old denials were evicted from history. Only available to an Argus manager session.',
    inputSchema: {},
  }, async () => {
    const view = governanceQueue.viewOf(managerId);
    return ok({
      resourceGrants: view.resourceGrants,
      pending: view.pending.map((proposal) => ({ ...proposalSummary(proposal), createdAt: proposal.createdAt })),
      queued: view.queued.map((waiting) => ({ ...proposalSummary(waiting), position: waiting.position, createdAt: waiting.createdAt })),
      queuedCount: view.queued.length,
      denied: view.denied.map((proposal) => ({ ...proposalSummary(proposal), reason: proposal.denialReason, decidedAt: proposal.decidedAt })),
      history: view.history.map((proposal) => ({ ...proposalSummary(proposal), status: proposal.status, decidedAt: proposal.decidedAt })),
      governanceEvictedDenials: view.governanceEvictedDenials,
      ...lawsReadout(view.laws),
      note: GOVERNANCE_NOTE,
    });
  });
}
