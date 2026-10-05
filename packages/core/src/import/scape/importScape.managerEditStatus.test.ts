import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagerRepository } from '../../managers/managerRepository.js';
import { importScape } from './importScape.js';
import { scapeImportStatusOfManager } from './scapeManagerEditStatus.js';
import { anArgus, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';
import { buildScapeFixture, type ScapeFixture } from './scapeFixture.testkit.js';

describe('where an imported manager stands against a Scape re-import', () => {
  let fixture: ScapeFixture;
  let home: string;
  let target: DatabaseSync | undefined;

  const runImport = () => {
    target?.close();
    target = undefined;
    return importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot: join(fixture.workDir, 'managers') });
  };
  const openTarget = () => (target ??= new DatabaseSync(join(home, 'openfleet.db')));
  const statusOf = (sessionId: string) => scapeImportStatusOfManager(openTarget(), sessionId);

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    writeArguses(fixture, [anArgus({ pulseInterval: 600, childrenCap: 4 })]);
    runImport();
  });
  afterEach(() => {
    target?.close();
    target = undefined;
  });

  it('is as imported right after the import', () => {
    expect(statusOf(LEAD_ARGUS_ID)).toBe('as_imported');
  });

  it('is edited in OpenFleet once its mission, pulse or cap changes', () => {
    new ManagerRepository(openTarget()).update(LEAD_ARGUS_ID, { missionText: 'A mission written in OpenFleet.' });

    expect(statusOf(LEAD_ARGUS_ID)).toBe('edited_in_openfleet');
  });

  it('is edited in OpenFleet once its model changes', () => {
    openTarget().prepare('UPDATE sessions SET model = ? WHERE id = ?').run('opus', LEAD_ARGUS_ID);

    expect(statusOf(LEAD_ARGUS_ID)).toBe('edited_in_openfleet');
  });

  it('is as imported again once a re-import has nothing to change', () => {
    runImport();

    expect(statusOf(LEAD_ARGUS_ID)).toBe('as_imported');
  });

  it('is not imported for a session the import never wrote', () => {
    expect(statusOf('a-manager-created-in-openfleet')).toBe('not_imported');
  });
});
