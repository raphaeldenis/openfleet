import { describe, expect, it } from 'vitest';
import { parseManagerProfile } from './manager-profile-parser';

const aProfile = (managerPatch: Record<string, unknown> = {}) => ({
  scapeImport: 'not_imported',
  manager: { sessionId: 'm1', pulseSeconds: 600, childrenCap: 2, missionText: 'Ship', nextPulseAt: '2026-10-15T12:00:00.000Z', childrenCount: 0, ...managerPatch },
});

describe('parseManagerProfile: the legacy mission flag', () => {
  it('keeps the flag a daemon reports', () => {
    expect(parseManagerProfile(aProfile({ legacyMission: true }))?.manager.legacyMission).toBe(true);
  });

  it('reports no flag for a daemon that does not know it, or a flag that is not a boolean', () => {
    expect(parseManagerProfile(aProfile())?.manager.legacyMission).toBeUndefined();
    expect(parseManagerProfile(aProfile({ legacyMission: 'yes' }))?.manager.legacyMission).toBeUndefined();
  });
});

describe('parseManagerProfile: the expertise and the pulse actions', () => {
  it('keeps the expertise, the pulse actions and the profile revision a daemon reports', () => {
    const profile = parseManagerProfile(aProfile({ expertise: 'Release trains', pulseActions: ['Check CI', 'Unblock reviews'], profileRev: 3 }));

    expect(profile?.manager).toMatchObject({ expertise: 'Release trains', pulseActions: ['Check CI', 'Unblock reviews'], profileRev: 3 });
  });

  it('reports none of them for an older daemon', () => {
    const profile = parseManagerProfile(aProfile());

    expect(profile?.manager.expertise).toBeUndefined();
    expect(profile?.manager.pulseActions).toBeUndefined();
    expect(profile?.manager.profileRev).toBeUndefined();
  });

  it('drops each value that has the wrong shape and keeps the rest of the profile', () => {
    const profile = parseManagerProfile(aProfile({ expertise: 42, pulseActions: ['Check CI', 7], profileRev: 'three' }));

    expect(profile?.manager.expertise).toBeUndefined();
    expect(profile?.manager.pulseActions).toBeUndefined();
    expect(profile?.manager.profileRev).toBeUndefined();
    expect(profile?.manager.missionText).toBe('Ship');
  });

  it.each([0, -1, 1.5])('drops the profile revision %s, which is no revision', (profileRev) => {
    expect(parseManagerProfile(aProfile({ profileRev }))?.manager.profileRev).toBeUndefined();
  });
});

describe('parseManagerProfile: the manager base', () => {
  it('keeps the version of the shipped base and the read of the manager', () => {
    const baseRead = { version: 2, sha: 'abc', readAt: '2026-10-15T12:00:00.000Z' };

    const profile = parseManagerProfile(aProfile({ baseVersion: 2, baseRead }));

    expect(profile?.manager).toMatchObject({ baseVersion: 2, baseRead });
  });

  it('reports neither field for a daemon that does not know the base', () => {
    const profile = parseManagerProfile(aProfile());

    expect(profile?.manager.baseVersion).toBeUndefined();
    expect(profile?.manager.baseRead).toBeUndefined();
  });

  it('drops a read that is not a version, a sha and a date', () => {
    const profile = parseManagerProfile(aProfile({ baseVersion: 2, baseRead: { version: 'two', sha: 1 } }));

    expect(profile?.manager.baseRead).toBeUndefined();
    expect(profile?.manager.baseVersion).toBe(2);
  });
});
