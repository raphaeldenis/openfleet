import type { DatabaseSync } from 'node:sqlite';
import {
  INTEGRATION_HEALTH_UNKNOWN, INTEGRATION_TOKEN_SECRET_NAME, OpenFleetError, type CreateIntegrationBody, type CreateIntegrationConnectionBody, type IntegrationConnectionView, type IntegrationIssueItem, type IntegrationItemsView, type IntegrationPollingState, type IntegrationView,
} from '@openfleet/shared';
import { inTransaction } from '../db/transaction.js';
import { maskedSecrets } from '../redact.js';
import type { SecretRefRepository } from '../secrets/secretRefRepository.js';
import type { SecretService } from '../secrets/secretService.js';
import { allowedHostOf, isAddressAllowedFor, type IntegrationProvider, type IntegrationProviderRegistry } from './integrationProviders.js';
import type { IntegrationProbe } from './integrationProbe.js';
import type { ConnectionRecord, IntegrationRepository, ItemFilter, ProfileRecord } from './integrationRepository.js';

export const DEFAULT_REFRESH_COOLDOWN_MS = 60_000;

/** The refreshes that may be in flight at once, whatever their connections: a burst of agents cannot fan out into a burst of provider calls. */
export const MAX_CONCURRENT_REFRESHES = 4;

export interface IntegrationServiceDeps {
  db: DatabaseSync;
  repository: IntegrationRepository;
  secretRefs: Pick<SecretRefRepository, 'declare' | 'find'>;
  credentials: Pick<SecretService, 'resolve'>;
  providers: IntegrationProviderRegistry;
  probe: IntegrationProbe;
  projectExists: (projectId: string) => boolean;
  clock: () => number;
  monotonicClock: () => number;
  newId: () => string;
  refreshCooldownMs?: number;
}

/** A page of kept issues, the number of issues that match, and whether the connection still polls. */
export interface IntegrationIssuePage { items: IntegrationIssueItem[]; total: number; polling: IntegrationPollingState }

const tokenScopeOf =(connectionId: string) => ({ kind: 'connection' as const, id: connectionId });

const looksLikeACredential = (label: string): boolean => maskedSecrets(label) !== label;

const refusedLabel = () => new OpenFleetError('integration_label_is_secret', 'a name or a resource must be a plain label, not a credential; the credential is set through the secrets route.');

/**
 * Connections to providers, the integrations a project builds on them, and their health.
 *
 * The guarantee: the credential stored in the secret store is never read back into a view, an answer, a table or a log line. It is read inside `refresh` to reach the provider
 * and inside `createIntegration` to compare it with the labels typed there, and goes nowhere else.
 * The labels a human types (connection name, integration name, resource) are the operator's free text: they are refused when they have the shape of a token or equal the credential
 * stored for their connection. A credential of another shape typed in a label of a connection that holds none yet is not recognised.
 *
 * Refreshes are bounded by connection, because the credential belongs to the connection: one refresh at a time and one per cooldown for each connection, `MAX_CONCURRENT_REFRESHES` at once overall.
 * The cooldown lives in memory and is measured on the monotonic clock: a restart of the daemon clears it, a step of the wall clock does not move it.
 */
export class IntegrationService {
  private readonly refreshCooldownMs: number;
  private readonly connectionsBeingRefreshed = new Set<string>();
  private readonly lastProbeEndedAtByConnection = new Map<string, number>();

  constructor(private readonly deps: IntegrationServiceDeps) {
    this.refreshCooldownMs = deps.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
  }

  providerIds(): string[] {
    return this.deps.providers.ids();
  }

  /** Records a connection and declares the secret its token will be set under; a human sets the value. */
  createConnection(body: CreateIntegrationConnectionBody): IntegrationConnectionView {
    this.refuseLabelsShapedLikeCredentials([body.name]);
    const provider = this.providerNamed(body.provider);
    const allowedHosts = [...new Set(body.allowedHosts.map((host) => allowedHostOf(provider, host)))];
    const connection: ConnectionRecord = { id: this.deps.newId(), name: body.name, provider: provider.id, credentialKind: 'token', allowedHosts };
    const hasSameName = this.deps.repository.listConnections().some((existing) => existing.name === connection.name);
    if (hasSameName) throw new OpenFleetError('duplicate_name', 'a connection of that name exists.');
    inTransaction(this.deps.db, 'createIntegrationConnection', () => {
      this.deps.repository.insertConnection(connection, { createdAt: this.nowIso() });
      this.deps.secretRefs.declare(tokenScopeOf(connection.id), INTEGRATION_TOKEN_SECRET_NAME);
    });
    return this.connectionViewOf(connection);
  }

  listConnections(): IntegrationConnectionView[] {
    return this.deps.repository.listConnections().map((connection) => this.connectionViewOf(connection));
  }

  async createIntegration(body: CreateIntegrationBody): Promise<IntegrationView> {
    if (!this.deps.projectExists(body.projectId)) throw new OpenFleetError('project_not_found', 'no such project.');
    const connection = this.connectionNamed(body.connectionId);
    const labels = [body.name, ...(body.resource === undefined ? [] : [body.resource])];
    this.refuseLabelsShapedLikeCredentials(labels);
    await this.refuseLabelsEqualToStoredCredential(connection, labels);
    const profile: ProfileRecord = { id: this.deps.newId(), projectId: body.projectId, connectionId: connection.id, name: body.name, ...(body.resource !== undefined && { resource: body.resource }) };
    const hasSameName = this.deps.repository.listProfilesOfProject(body.projectId).some((existing) => existing.name === profile.name);
    if (hasSameName) throw new OpenFleetError('duplicate_name', 'an integration of that name exists in this project.');
    this.deps.repository.insertProfile(profile, { createdAt: this.nowIso() });
    return this.integrationViewOf(profile, connection);
  }

  list(projectId: string): IntegrationView[] {
    return this.deps.repository.listProfilesOfProject(projectId).map((profile) => this.integrationViewOf(profile, this.connectionNamed(profile.connectionId)));
  }

  /** Reads the health recorded by the last refresh. It makes no call to the provider. */
  healthOf(projectId: string, integrationId: string): IntegrationView {
    const profile = this.profileOf(projectId, integrationId);
    return this.integrationViewOf(profile, this.connectionNamed(profile.connectionId));
  }

  /** The issues the poller kept for an integration, cleaned and under `untrusted`, and whether its connection still polls. It makes no call to the provider. */
  itemsOf(projectId: string, integrationId: string): IntegrationItemsView {
    const profile = this.profileOf(projectId, integrationId);
    const isStopped = this.deps.repository.connectionPollingOf(profile.connectionId).isStopped;
    return { items: this.deps.repository.listItems(profile.id), polling: isStopped ? 'stopped_auth_failed' : 'active' };
  }

  /**
   * A page of the kept issues of an integration of the project, most recently updated first, narrowed by filters on the listed columns.
   * Reads the database only: no call to the provider. `requiresIssueSearch` limits it to an integration whose provider searches issues (Jira).
   */
  pageOfIssues(projectId: string, integrationId: string, { filters, limit, offset, requiresIssueSearch }: { filters: readonly ItemFilter[]; limit: number; offset: number; requiresIssueSearch: boolean }): IntegrationIssuePage {
    const profile = this.profileOf(projectId, integrationId);
    if (requiresIssueSearch) this.refuseUnlessProviderSearchesIssues(profile);
    const { items, total } = this.deps.repository.pageOfItems(profile.id, { filters, limit, offset });
    const isStopped = this.deps.repository.connectionPollingOf(profile.connectionId).isStopped;
    return { items, total, polling: isStopped ? 'stopped_auth_failed' : 'active' };
  }

  /** One kept issue of a Jira integration of the project; an issue the poller did not keep is `integration_item_not_found`. Reads the database only. */
  issueOf(projectId: string, integrationId: string, key: string): IntegrationIssueItem {
    const profile = this.profileOf(projectId, integrationId);
    this.refuseUnlessProviderSearchesIssues(profile);
    const issue = this.deps.repository.findItem(profile.id, key);
    if (issue === undefined) throw new OpenFleetError('integration_item_not_found', 'the daemon kept no such issue for this integration.');
    return issue;
  }

  private refuseUnlessProviderSearchesIssues(profile: ProfileRecord): void {
    const connection = this.connectionNamed(profile.connectionId);
    const searchesIssues = this.providerNamed(connection.provider).issueSearchPath !== undefined;
    if (!searchesIssues) throw new OpenFleetError('invalid_body', 'only an integration whose provider searches issues has Jira issues.');
  }

  /**
   * Probes the provider with the credential and records the typed result.
   * A refresh is refused before the credential is read when its connection is being refreshed, was refreshed inside the cooldown, or when `MAX_CONCURRENT_REFRESHES` are in flight.
   * A connection with no value on this device fails with secret_not_connected_on_this_device.
   */
  async refresh(projectId: string, integrationId: string): Promise<IntegrationView> {
    const profile = this.profileOf(projectId, integrationId);
    const connection = this.connectionNamed(profile.connectionId);
    const provider = this.providerNamed(connection.provider);
    this.refuseUnlessRefreshIsAllowed(connection.id);

    this.connectionsBeingRefreshed.add(connection.id);
    try {
      const credential = await this.deps.credentials.resolve(tokenScopeOf(connection.id), INTEGRATION_TOKEN_SECRET_NAME);
      const host = connection.allowedHosts[0]!;
      const status = await this.deps.probe({
        scheme: provider.scheme, host, ...(provider.port !== undefined && { port: provider.port }), path: provider.healthPath,
        headers: { authorization: provider.authorizationOf(credential) }, isAddressAllowed: (address) => isAddressAllowedFor(provider, address),
      });
      this.lastProbeEndedAtByConnection.set(connection.id, this.deps.monotonicClock());
      this.deps.repository.saveHealth(profile.id, { status, checkedAt: this.nowIso() });
      const isCredentialWorkingAgain = status === 'ok';
      if (isCredentialWorkingAgain) this.deps.repository.resumePolling(connection.id, { nowIso: this.nowIso() });
    } finally {
      this.connectionsBeingRefreshed.delete(connection.id);
    }
    return this.integrationViewOf(profile, connection);
  }

  private refuseUnlessRefreshIsAllowed(connectionId: string): void {
    const isConnectionBeingRefreshed = this.connectionsBeingRefreshed.has(connectionId);
    if (isConnectionBeingRefreshed) throw new OpenFleetError('integration_refresh_cooldown', 'this connection is being refreshed right now; read the health in a moment.');
    const isRefreshCapacityReached = this.connectionsBeingRefreshed.size >= MAX_CONCURRENT_REFRESHES;
    if (isRefreshCapacityReached) throw new OpenFleetError('integration_refresh_cooldown', 'too many refreshes are running; try again in a moment.');
    const lastProbeEndedAt = this.lastProbeEndedAtByConnection.get(connectionId);
    if (lastProbeEndedAt === undefined) return;
    const millisecondsSinceLastProbe = this.deps.monotonicClock() - lastProbeEndedAt;
    const isInsideCooldown = millisecondsSinceLastProbe < this.refreshCooldownMs;
    if (!isInsideCooldown) return;
    const secondsLeft = Math.ceil((this.refreshCooldownMs - millisecondsSinceLastProbe) / 1000);
    throw new OpenFleetError('integration_refresh_cooldown', `this connection was refreshed a moment ago; refresh again in ${secondsLeft} seconds.`);
  }

  private refuseLabelsShapedLikeCredentials(labels: string[]): void {
    if (labels.some(looksLikeACredential)) throw refusedLabel();
  }

  /** Compares in memory and answers with a typed refusal that carries neither value. A connection with no value on this device has nothing to be equal to. */
  private async refuseLabelsEqualToStoredCredential(connection: ConnectionRecord, labels: string[]): Promise<void> {
    const isCredentialStored = this.deps.secretRefs.find(tokenScopeOf(connection.id), INTEGRATION_TOKEN_SECRET_NAME)?.status === 'stored';
    if (!isCredentialStored) return;
    const credential = await this.storedCredentialOrUndefined(connection.id);
    if (credential === undefined) return;
    const isLabelTheCredential = labels.some((label) => label.trim() === credential.trim());
    if (isLabelTheCredential) throw refusedLabel();
  }

  private async storedCredentialOrUndefined(connectionId: string): Promise<string | undefined> {
    try {
      return await this.deps.credentials.resolve(tokenScopeOf(connectionId), INTEGRATION_TOKEN_SECRET_NAME);
    } catch (error) {
      const isMissingOnThisDevice = error instanceof OpenFleetError && error.code === 'secret_not_connected_on_this_device';
      if (isMissingOnThisDevice) return undefined;
      throw error;
    }
  }

  private profileOf(projectId: string, integrationId: string): ProfileRecord {
    const profile = this.deps.repository.findProfileInProject(projectId, integrationId);
    if (profile === undefined) throw new OpenFleetError('integration_not_found', 'no such integration in your project.');
    return profile;
  }

  private connectionNamed(connectionId: string): ConnectionRecord {
    const connection = this.deps.repository.findConnection(connectionId);
    if (connection === undefined) throw new OpenFleetError('integration_connection_not_found', 'no such integration connection.');
    return connection;
  }

  private providerNamed(providerId: string): IntegrationProvider {
    const provider = this.deps.providers.find(providerId);
    if (provider === undefined) throw new OpenFleetError('integration_provider_unknown', 'no such integration provider.', { hint: `one of: ${this.deps.providers.ids().join(', ')}.` });
    return provider;
  }

  private connectionViewOf(connection: ConnectionRecord): IntegrationConnectionView {
    const tokenRef = this.deps.secretRefs.find(tokenScopeOf(connection.id), INTEGRATION_TOKEN_SECRET_NAME);
    return {
      id: connection.id, name: connection.name, provider: connection.provider, credentialKind: connection.credentialKind, allowedHosts: connection.allowedHosts,
      credential: tokenRef?.status ?? 'missing', ...(tokenRef?.setAt !== undefined && { credentialSetAt: tokenRef.setAt }),
    };
  }

  private integrationViewOf(profile: ProfileRecord, connection: ConnectionRecord): IntegrationView {
    const health = this.deps.repository.healthOf(profile.id);
    const { credential } = this.connectionViewOf(connection);
    return {
      id: profile.id, projectId: profile.projectId, connectionId: connection.id, name: profile.name, provider: connection.provider, ...(profile.resource !== undefined && { resource: profile.resource }),
      credential, health: health?.status ?? INTEGRATION_HEALTH_UNKNOWN, ...(health !== undefined && { checkedAt: health.checkedAt }),
    };
  }

  private nowIso(): string {
    return new Date(this.deps.clock()).toISOString();
  }
}
