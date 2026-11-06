import type { DatabaseSync } from 'node:sqlite';
import type { IntegrationCredentialKind, IntegrationHealthStatus } from '@openfleet/shared';

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
}
