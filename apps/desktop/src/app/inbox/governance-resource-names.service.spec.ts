import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { GovernanceResourceNames, type ResourceRef } from './governance-resource-names.service';

const noteRef: ResourceRef = { projectId: 'p1', resourceType: 'note', resourceId: 'n-1' };

function serviceWith(api: Record<string, unknown>) {
  TestBed.configureTestingModule({ providers: [{ provide: FleetApiService, useValue: api }] });
  return TestBed.inject(GovernanceResourceNames);
}

describe('GovernanceResourceNames', () => {
  it('shows the id while the name is unknown, then the title once it is resolved', async () => {
    const names = serviceWith({ getNote: vi.fn().mockResolvedValue({ title: 'Q4 roadmap' }) });
    expect(names.nameOf(noteRef)).toBe('n-1');

    names.request(noteRef);

    await vi.waitFor(() => expect(names.nameOf(noteRef)).toBe('Q4 roadmap'));
  });

  it('looks a name up once while it is known', async () => {
    const getNote = vi.fn().mockResolvedValue({ title: 'Q4 roadmap' });
    const names = serviceWith({ getNote });
    names.request(noteRef);
    await vi.waitFor(() => expect(names.nameOf(noteRef)).toBe('Q4 roadmap'));

    names.request(noteRef);

    expect(getNote).toHaveBeenCalledTimes(1);
  });

  it('tries again at the next request after a failed lookup, without caching the failure', async () => {
    const getNote = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ title: 'Q4 roadmap' });
    const names = serviceWith({ getNote });
    names.request(noteRef);
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledTimes(1));
    expect(names.nameOf(noteRef)).toBe('n-1');

    await vi.waitFor(() => {
      names.request(noteRef);
      expect(names.nameOf(noteRef)).toBe('Q4 roadmap');
    });
    expect(getNote).toHaveBeenCalledTimes(2);
  });

  it('does not look up a resource whose project is unknown, and does it once the project is known', async () => {
    const getNote = vi.fn().mockResolvedValue({ title: 'Q4 roadmap' });
    const names = serviceWith({ getNote });

    names.request({ ...noteRef, projectId: undefined });
    expect(getNote).not.toHaveBeenCalled();
    names.request(noteRef);

    await vi.waitFor(() => expect(getNote).toHaveBeenCalledTimes(1));
  });
});
