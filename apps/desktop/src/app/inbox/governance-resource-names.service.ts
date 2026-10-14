import { Injectable, inject, signal } from '@angular/core';
import type { ResourceType } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';

export interface ResourceRef {
  readonly projectId: string | undefined;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
}

const keyOf = ({ projectId, resourceType, resourceId }: ResourceRef): string => `${projectId}:${resourceType}:${resourceId}`;

/** Resolves the title of a note or the name of a table that a governance proposal or grant points at. */
@Injectable({ providedIn: 'root' })
export class GovernanceResourceNames {
  private readonly api = inject(FleetApiService);
  private readonly namesByKey = signal<ReadonlyMap<string, string>>(new Map());
  private readonly requestedKeys = new Set<string>();

  /** The resolved name, or the id while the name is unknown. */
  nameOf(resource: ResourceRef): string {
    return this.namesByKey().get(keyOf(resource)) ?? resource.resourceId;
  }

  /** Starts looking the name up once; a failed lookup leaves the id shown. */
  request(resource: ResourceRef): void {
    const key = keyOf(resource);
    const isAlreadyRequested = this.requestedKeys.has(key);
    if (isAlreadyRequested || resource.projectId === undefined) return;
    this.requestedKeys.add(key);
    void this.fetchName({ ...resource, projectId: resource.projectId })
      .then((name) => this.namesByKey.update((names) => new Map(names).set(key, name)))
      .catch(() => undefined);
  }

  private async fetchName({ projectId, resourceType, resourceId }: ResourceRef & { projectId: string }): Promise<string> {
    if (resourceType === 'note') return (await this.api.getNote(projectId, resourceId)).title;
    return (await this.api.getDataStore({ projectId, storeId: resourceId })).displayName;
  }
}
