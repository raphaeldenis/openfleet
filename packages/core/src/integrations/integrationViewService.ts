import { OpenFleetError, type IntegrationViewConfigView, type SaveViewConfigBody } from '@openfleet/shared';
import type { IntegrationProviderRegistry } from './integrationProviders.js';
import type { IntegrationRepository, ProfileRecord, ViewConfigRecord } from './integrationRepository.js';
import { reviewDigestOf, viewConfigStateOf } from './integrationViewConfig.js';
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
 * A write puts the configuration back to `pending`, and a pending configuration is never run. Approval needs the single-use proof of a human gesture bound to this integration,
 * and records the digest of the content as it stood at the revision that was reviewed.
 * Every operation looks the integration up in the project it is asked for: an integration of another project is not found.
 */
export class IntegrationViewService {
  constructor(private readonly deps: IntegrationViewServiceDeps) {}

  configOf(projectId: string, integrationId: string): IntegrationViewConfigView {
    const profile = this.profileOf(projectId, integrationId);
    return this.viewOf(profile, this.recordOf(profile));
  }

  /** Writes a proposal. The text is checked and stored in its canonical form; nothing runs until a human approves this revision. */
  propose(projectId: string, integrationId: string, body: SaveViewConfigBody): IntegrationViewConfigView {
    const profile = this.profileOf(projectId, integrationId);
    this.refuseUnlessProviderSearchesIssues(profile);
    const current = this.deps.repository.findViewConfig(profile.id);
    const isOnAnOldRevision = body.expectedRev !== undefined && body.expectedRev !== (current?.contentRev ?? 0);
    if (isOnAnOldRevision) throw staleRevision(current?.contentRev ?? 0);
    const checked = checkViewConfig(body);
    if (!checked.ok) throw new OpenFleetError('integration_view_jql_refused', checked.issues.join(' '));
    this.deps.repository.saveViewConfig(profile.id, checked.config, { now: this.nowIso() });
    return this.viewOf(profile, this.recordOf(profile));
  }

  /** Approves the content at the revision a human reviewed, on the proof of that human; the proof is spent whatever follows it. */
  approve(projectId: string, integrationId: string, input: { approvedRev: number; proof: string | undefined }): IntegrationViewConfigView {
    const profile = this.profileOf(projectId, integrationId);
    const record = this.recordOf(profile);
    const isOnAnOldRevision = input.approvedRev !== record.contentRev;
    if (isOnAnOldRevision) throw staleRevision(record.contentRev);
    const isStillValid = checkViewConfig(record).ok;
    if (!isStillValid) throw new OpenFleetError('integration_view_jql_refused', 'the stored query is not one the daemon runs.');

    const isProvenHuman = this.deps.approvalProof.consume(input.proof, { integrationId: profile.id });
    if (!isProvenHuman) throw new OpenFleetError('human_proof_required', 'approving a view needs the proof of a human gesture in the desktop app.', { hint: 'Approve it from the Integrations screen.' });

    const wasApproved = this.deps.repository.approveViewConfig({ profileId: profile.id, approvedRev: record.contentRev, digest: reviewDigestOf(record), now: this.nowIso() });
    if (!wasApproved) throw staleRevision(this.recordOf(profile).contentRev);
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
    if (record === undefined) throw new OpenFleetError('integration_view_config_not_found', 'this integration has no view configuration.');
    return record;
  }

  private viewOf(profile: ProfileRecord, record: ViewConfigRecord): IntegrationViewConfigView {
    return {
      integrationId: profile.id, jql: record.jql, fields: record.fields, contentRev: record.contentRev, state: viewConfigStateOf(record), reviewDigest: reviewDigestOf(record),
      ...(record.approvedAt !== undefined && { approvedAt: record.approvedAt }),
    };
  }

  private nowIso(): string {
    return new Date(this.deps.clock()).toISOString();
  }
}
