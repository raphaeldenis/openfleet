import type { DatabaseSync } from 'node:sqlite';
import {
  INTEGRATION_HEALTH_UNKNOWN, INTEGRATION_TOKEN_SECRET_NAME, OpenFleetError, type CreateIntegrationBody, type CreateIntegrationConnectionBody, type IntegrationConnectionView, type IntegrationView,
} from '@openfleet/shared';
import { inTransaction } from '../db/transaction.js';import type { SecretRefRepository } from '../secrets/secretRefRepository.js';
import type { SecretService } from '../secrets/secretService.js';
import { allowedHostOf, originOf, type IntegrationProvider, type IntegrationProviderRegistry } from './integrationProviders.js';
import type { IntegrationProbe } from './integrationProbe.js';
import type { ConnectionRecord, IntegrationRepository, ProfileRecord } from './integrationRepository.js';

export const DEFAULT_REFRESH_COOLDOWN_MS = 60_000;

export interface IntegrationServiceDeps {
  db: DatabaseSync;
  repository: IntegrationRepository;
  secretRefs: Pick<SecretRefRepository, 'declare' | 'find'>;
  credentials: Pick<SecretService, 'resolve'>;
  providers: IntegrationProviderRegistry;
  probe: IntegrationProbe;
  projectExists: (projectId: string) => boolean;
  clock: () => number;
  newId: () => string;
  refreshCooldownMs?: number;
}

const tokenScopeOf = (connectionId: string) => ({ kind: 'connection' as const, id: connectionId });

/**
 * Connections to providers, the integrations a project builds on them, and their health.
 * The credential of a connection lives in the secret store. It is read inside `refresh` to reach the provider and goes nowhere else: every view carries its status, never its value.
 */
export class IntegrationService {
  private readonly refreshCooldownMs: number;
  private readonly profilesBeingRefreshed = new Set<string>();

  constructor(private readonly deps: IntegrationServiceDeps) {
    this.refreshCooldownMs = deps.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
  }

  providerIds(): string[] {
    return this.deps.providers.ids();
  }

  /** Records a connection and declares the secret its token will be set under; a human sets the value. */
  createConnection(body: CreateIntegrationConnectionBody): IntegrationConnectionView {
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

  createIntegration(body: CreateIntegrationBody): IntegrationView {
    if (!this.deps.projectExists(body.projectId)) throw new OpenFleetError('project_not_found', 'no such project.');
    const connection = this.connectionNamed(body.connectionId);
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

  /**
   * Probes the provider with the credential and records the typed result.
   * A refresh inside the cooldown of the previous one is refused before the credential is read; a connection with no value on this device fails with secret_not_connected_on_this_device.
   */
  async refresh(projectId: string, integrationId: string): Promise<IntegrationView> {
    const profile = this.profileOf(projectId, integrationId);
    const connection = this.connectionNamed(profile.connectionId);
    const provider = this.providerNamed(connection.provider);
    this.refuseDuringCooldown(profile);

    this.profilesBeingRefreshed.add(profile.id);
    try {
      const credential = await this.deps.credentials.resolve(tokenScopeOf(connection.id), INTEGRATION_TOKEN_SECRET_NAME);
      const host = connection.allowedHosts[0]!;
      const status = await this.deps.probe({ url: `${originOf(provider, host)}${provider.healthPath}`, authorization: provider.authorizationOf(credential) });
      this.deps.repository.saveHealth(profile.id, { status, checkedAt: this.nowIso() });
    } finally {
      this.profilesBeingRefreshed.delete(profile.id);
    }
    return this.integrationViewOf(profile, connection);
  }

  private refuseDuringCooldown(profile: ProfileRecord): void {
    const isAlreadyBeingRefreshed = this.profilesBeingRefreshed.has(profile.id);
    if (isAlreadyBeingRefreshed) throw new OpenFleetError('integration_refresh_cooldown', 'this integration is being refreshed right now; read its health in a moment.');
    const lastCheck = this.deps.repository.healthOf(profile.id);
    if (lastCheck === undefined) return;
    const millisecondsSinceLastCheck = this.deps.clock() - Date.parse(lastCheck.checkedAt);
    const isInsideCooldown = millisecondsSinceLastCheck < this.refreshCooldownMs;
    if (!isInsideCooldown) return;
    const secondsLeft = Math.ceil((this.refreshCooldownMs - millisecondsSinceLastCheck) / 1000);
    throw new OpenFleetError('integration_refresh_cooldown', `this integration was refreshed a moment ago; refresh again in ${secondsLeft} seconds.`);
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
