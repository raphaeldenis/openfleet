import type { DatabaseSync } from 'node:sqlite';
import type { IntegrationCredentialKind, IntegrationHealthStatus, IntegrationIssueItem } from '@openfleet/shared';
import { inTransaction } from '../db/transaction.js';

export interface ConnectionRecord {
  id: string;
  name: string;
  provider: string;
  credentialKind: IntegrationCredentialKind;
  allowedHosts: string[];
}

export interface ProfileRecord {
  id: string;
  projectId: string;
  connectionId: string;
  name: string;
  resource?: string;
}

export interface HealthRecord {
  status: IntegrationHealthStatus;
  checkedAt: string;
}

export interface PollStateRecord {
  etag?: string;
  consecutiveFailures: number;
  nextPollAt: string;
  lastPolledAt: string;
}

export interface ConnectionPollingRecord {
  consecutiveAuthFailures: number;
  isStopped: boolean;
}

interface PollStateRow { etag: string | null; consecutive_failures: number; next_poll_at: string; last_polled_at: string }
interface ConnectionPollingRow { consecutive_auth_failures: number; is_stopped: number }
interface ItemRow { external_id: string; fields_json: string }
interface ConnectionRow { id: string; name: string; provider: string; credential_kind: IntegrationCredentialKind; allowed_hosts_json: string }
interface ProfileRow { id: string; project_id: string; connection_id: string; name: string; resource: string | null }
interface HealthRow { status: IntegrationHealthStatus; checked_at: string }

const toConnection = (row: ConnectionRow): ConnectionRecord => ({
  id: row.id, name: row.name, provider: row.provider, credentialKind: row.credential_kind, allowedHosts: JSON.parse(row.allowed_hosts_json) as string[],
});

const toProfile = (row: ProfileRow): ProfileRecord => ({
  id: row.id, projectId: row.project_id, connectionId: row.connection_id, name: row.name, ...(row.resource !== null && { resource: row.resource }),
});

const CONNECTION_COLUMNS = 'id, name, provider, credential_kind, allowed_hosts_json';
const PROFILE_COLUMNS = 'id, project_id, connection_id, name, resource';

/** Connections, the profiles that use them in a project, and the last health of each profile. A credential has no column here. */
export class IntegrationRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertConnection(connection: ConnectionRecord, { createdAt }: { createdAt: string }): void {
    this.db.prepare('INSERT INTO integration_connections (id, name, provider, credential_kind, allowed_hosts_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(connection.id, connection.name, connection.provider, connection.credentialKind, JSON.stringify(connection.allowedHosts), createdAt);
  }

  findConnection(connectionId: string): ConnectionRecord | undefined {
    const row = this.db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE id = ?`).get(connectionId) as ConnectionRow | undefined;
    return row === undefined ? undefined : toConnection(row);
  }

  listConnections(): ConnectionRecord[] {
    const rows = this.db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM integration_connections ORDER BY name`).all() as unknown as ConnectionRow[];
    return rows.map(toConnection);
  }

  insertProfile(profile: ProfileRecord, { createdAt }: { createdAt: string }): void {
    this.db.prepare('INSERT INTO integration_profiles (id, project_id, connection_id, name, resource, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(profile.id, profile.projectId, profile.connectionId, profile.name, profile.resource ?? null, createdAt);
  }

  findProfileInProject(projectId: string, profileId: string): ProfileRecord | undefined {
    const row = this.db.prepare(`SELECT ${PROFILE_COLUMNS} FROM integration_profiles WHERE project_id = ? AND id = ?`).get(projectId, profileId) as ProfileRow | undefined;
    return row === undefined ? undefined : toProfile(row);
  }

  listProfilesOfProject(projectId: string): ProfileRecord[] {
    const rows = this.db.prepare(`SELECT ${PROFILE_COLUMNS} FROM integration_profiles WHERE project_id = ? ORDER BY name`).all(projectId) as unknown as ProfileRow[];
    return rows.map(toProfile);
  }

  healthOf(profileId: string): HealthRecord | undefined {
    const row = this.db.prepare('SELECT status, checked_at FROM integration_health WHERE profile_id = ?').get(profileId) as HealthRow | undefined;
    return row === undefined ? undefined : { status: row.status, checkedAt: row.checked_at };
  }

  saveHealth(profileId: string, health: HealthRecord): void {
    this.db.prepare('INSERT INTO integration_health (profile_id, status, checked_at) VALUES (?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at')
      .run(profileId, health.status, health.checkedAt);
  }

  /**
   * The profiles of a provider in `pollableProviderIds` whose next poll is due at `nowIso` (or that were never polled) and whose connection is not stopped,
   * the profile never attempted first, then the one attempted longest ago, so that none is left behind by the ones before it. A profile of any other provider is never due.
   */
  listProfilesDueForPolling({ nowIso, limit, pollableProviderIds }: { nowIso: string; limit: number; pollableProviderIds: readonly string[] }): ProfileRecord[] {
    const providerPlaceholders = pollableProviderIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT p.id, p.project_id, p.connection_id, p.name, p.resource
      FROM integration_profiles p
      JOIN integration_connections k ON k.id = p.connection_id
      LEFT JOIN integration_poll_state s ON s.profile_id = p.id
      LEFT JOIN integration_connection_polling c ON c.connection_id = p.connection_id
      WHERE k.provider IN (${providerPlaceholders}) AND (s.next_poll_at IS NULL OR s.next_poll_at <= ?) AND COALESCE(c.is_stopped, 0) = 0
      ORDER BY COALESCE(s.last_polled_at, ''), p.id
      LIMIT ?`).all(...pollableProviderIds, nowIso, limit) as unknown as ProfileRow[];
    return rows.map(toProfile);
  }

  pollStateOf(profileId: string): PollStateRecord | undefined {
    const row = this.db.prepare('SELECT etag, consecutive_failures, next_poll_at, last_polled_at FROM integration_poll_state WHERE profile_id = ?').get(profileId) as PollStateRow | undefined;
    return row === undefined ? undefined : {
      ...(row.etag !== null && { etag: row.etag }), consecutiveFailures: row.consecutive_failures, nextPollAt: row.next_poll_at, lastPolledAt: row.last_polled_at,
    };
  }

  savePollState(profileId: string, state: PollStateRecord): void {
    this.db.prepare(`
      INSERT INTO integration_poll_state (profile_id, etag, consecutive_failures, next_poll_at, last_polled_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET etag = excluded.etag, consecutive_failures = excluded.consecutive_failures, next_poll_at = excluded.next_poll_at, last_polled_at = excluded.last_polled_at`)
      .run(profileId, state.etag ?? null, state.consecutiveFailures, state.nextPollAt, state.lastPolledAt);
  }

  connectionPollingOf(connectionId: string): ConnectionPollingRecord {
    const row = this.db.prepare('SELECT consecutive_auth_failures, is_stopped FROM integration_connection_polling WHERE connection_id = ?').get(connectionId) as ConnectionPollingRow | undefined;
    return { consecutiveAuthFailures: row?.consecutive_auth_failures ?? 0, isStopped: row?.is_stopped === 1 };
  }

  saveConnectionPolling(connectionId: string, polling: ConnectionPollingRecord): void {
    this.db.prepare(`
      INSERT INTO integration_connection_polling (connection_id, consecutive_auth_failures, is_stopped) VALUES (?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET consecutive_auth_failures = excluded.consecutive_auth_failures, is_stopped = excluded.is_stopped`)
      .run(connectionId, polling.consecutiveAuthFailures, polling.isStopped ? 1 : 0);
  }

  /** Lets a stopped connection poll again: its failure count is cleared and its profiles are due at `nowIso`. */
  resumePolling(connectionId: string, { nowIso }: { nowIso: string }): void {
    this.saveConnectionPolling(connectionId, { consecutiveAuthFailures: 0, isStopped: false });
    this.db.prepare('UPDATE integration_poll_state SET next_poll_at = ?, consecutive_failures = 0 WHERE profile_id IN (SELECT id FROM integration_profiles WHERE connection_id = ?)').run(nowIso, connectionId);
  }

  /** Replaces the items of a profile by the issues of the last answer, all or nothing. */
  replaceItems(profileId: string, issues: IntegrationIssueItem[], { fetchedAt }: { fetchedAt: string }): void {
    inTransaction(this.db, 'replaceIntegrationItems', () => {
      this.db.prepare('DELETE FROM integration_view_items WHERE profile_id = ?').run(profileId);
      const insert = this.db.prepare('INSERT INTO integration_view_items (profile_id, external_id, fields_json, fetched_at) VALUES (?, ?, ?, ?)');
      for (const { key, ...fields } of issues) insert.run(profileId, key, JSON.stringify(fields), fetchedAt);
    });
  }

  listItems(profileId: string): IntegrationIssueItem[] {
    const rows = this.db.prepare('SELECT external_id, fields_json FROM integration_view_items WHERE profile_id = ? ORDER BY json_extract(fields_json, \'$.updatedAt\') DESC, external_id').all(profileId) as unknown as ItemRow[];
    return rows.map((row) => ({ key: row.external_id, ...(JSON.parse(row.fields_json) as Omit<IntegrationIssueItem, 'key'>) }));
  }
}
