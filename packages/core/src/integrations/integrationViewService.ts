import { OpenFleetError, type IntegrationViewConfigView, type SaveViewConfigBody, type ViewConfigContent } from '@openfleet/shared';
import type { IntegrationProviderRegistry } from './integrationProviders.js';
import type { IntegrationRepository, ProfileRecord, ViewConfigRecord } from './integrationRepository.js';
import { activeStatusOf, reviewDigestOf } from './integrationViewConfig.js';
import type { ViewApprovalProof } from './viewApprovalProof.js';
import { checkViewConfig } from './viewConfigJql.js';

export interface IntegrationViewServiceDeps {
  repository: IntegrationRepository;
  providers: IntegrationProviderRegistry;
  approvalProof: ViewApprovalProof;
  clock: () => number;
}

const staleRevision = (currentRev: number) => new OpenFleetError('stale_revision', `the view configuration revision is stale, current rev: ${currentRev}.`, { hint: 'Read the configuration again, then write again.' });

/**
 * The view of an integration: the query and the fields the daemon polls, written as a proposal and approved by a human.
 * An integration holds two places: the active configuration the poller runs, and the proposal waiting for approval.
 * A write replaces the proposal only, so proposing never stops, changes or freezes the polling. Approval needs the single-use proof of a human gesture bound to this integration,
 * records the digest of the content as it stood at the revision that was reviewed, and promotes that proposal to the active configuration in one step.
 * Every operation looks the integration up in the project it is asked for: an integration of another project is not found.
 */
export class IntegrationViewService {
  constructor(private readonly deps: IntegrationViewServiceDeps) {}

  configOf(projectId: string, integrationId: string): IntegrationViewConfigView {
    const profile = this.profileOf(projectId, integrationId);
    return this.viewOf(profile, this.recordOf(profile));
  }

  /** Writes the proposal. The text is checked and stored in its canonical form; nothing runs differently until a human approves this revision. */
  propose(projectId: string, integrationId: string, body: SaveViewConfigBody): IntegrationViewConfigView {
    const profile = this.profileOf(projectId, integrationId);
    this.refuseUnlessProviderSearchesIssues(profile);
    const current = this.deps.repository.findViewConfig(profile.id);
    const isOnAnOldRevision = body.expectedRev !== undefined && body.expectedRev !== (current?.contentRev ?? 0);
    if (isOnAnOldRevision) throw staleRevision(current?.contentRev ?? 0);
    const canonical = this.validate(body);
    this.deps.repository.saveViewProposal(profile.id, canonical, { now: this.nowIso() });
    return this.viewOf(profile, this.recordOf(profile));
  }

  /** Returns the canonical form of a query and its fields, or throws `integration_view_jql_refused` naming the rule that broke and never the text. It reads and writes nothing. */
  validate(body: Pick<SaveViewConfigBody, 'jql' | 'fields'>): ViewConfigContent {
    const checked = checkViewConfig(body);
    if (!checked.ok) throw new OpenFleetError('integration_view_jql_refused', checked.issues.join(' '));
    return checked.config;
  }

  /** Approves the proposal at the revision a human reviewed, on the proof of that human; the proof is spent whatever follows it. */
  approve(projectId: string, integrationId: string, input: { approvedRev: number; proof: string | undefined }): IntegrationViewConfigView {
    const profile = this.profileOf(projectId, integrationId);
    const record = this.recordOf(profile);
    const proposal = record.proposal;
    if (proposal === undefined) throw new OpenFleetError('integration_view_proposal_not_found', 'this integration has no proposal waiting for approval.');
    const isOnAnOldRevision = input.approvedRev !== record.contentRev;
    if (isOnAnOldRevision) throw staleRevision(record.contentRev);
    const isStillValid = checkViewConfig(proposal).ok;
    if (!isStillValid) throw new OpenFleetError('integration_view_jql_refused', 'the stored query is not one the daemon runs.');

    const isProvenHuman = this.deps.approvalProof.consume(input.proof, { integrationId: profile.id });
    if (!isProvenHuman) throw new OpenFleetError('human_proof_required', 'approving a view needs the proof of a human gesture in the desktop app.', { hint: 'Approve it from the Integrations screen.' });

    const wasPromoted = this.deps.repository.promoteViewProposal({ profileId: profile.id, approvedRev: record.contentRev, digest: reviewDigestOf(proposal), now: this.nowIso() });
    if (!wasPromoted) throw staleRevision(this.recordOf(profile).contentRev);
    return this.viewOf(profile, this.recordOf(profile));
  }

  private refuseUnlessProviderSearchesIssues(profile: ProfileRecord): void {
    const connection = this.deps.repository.findConnection(profile.connectionId);
    const provider = connection === undefined ? undefined : this.deps.providers.find(connection.provider);
    const searchesIssues = provider?.issueSearchPath !== undefined;
    if (!searchesIssues) throw new OpenFleetError('invalid_body', 'only an integration whose provider searches issues has a view configuration.');
  }

  private profileOf(projectId: string, integrationId: string): ProfileRecord {
    const profile = this.deps.repository.findProfileInProject(projectId, integrationId);
    if (profile === undefined) throw new OpenFleetError('integration_not_found', 'no such integration in your project.');
    return profile;
  }

  private recordOf(profile: ProfileRecord): ViewConfigRecord {
    const record = this.deps.repository.findViewConfig(profile.id);
    const holdsNothing = record === undefined || (record.active === undefined && record.proposal === undefined);
    if (holdsNothing) throw new OpenFleetError('integration_view_config_not_found', 'this integration has no view configuration.');
    return record;
  }

  private viewOf(profile: ProfileRecord, record: ViewConfigRecord): IntegrationViewConfigView {
    const { active, proposal } = record;
    return {
      integrationId: profile.id, contentRev: record.contentRev,
      ...(active !== undefined && { active: { jql: active.jql, fields: active.fields, approvedRev: active.approvedRev, approvedAt: active.approvedAt, status: activeStatusOf(active) } }),
      ...(proposal !== undefined && { proposal: { jql: proposal.jql, fields: proposal.fields, contentRev: record.contentRev, reviewDigest: reviewDigestOf(proposal) } }),
    };
  }

  private nowIso(): string {
    return new Date(this.deps.clock()).toISOString();
  }
}
