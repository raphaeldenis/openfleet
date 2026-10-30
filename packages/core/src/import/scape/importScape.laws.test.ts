import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LawRepository } from '../../governance/lawRepository.js';
import { tokenPrefixOf } from '../../syntheticTokens.js';
import { runImportCli } from '../importCli.js';
import { importScape } from './importScape.js';
import { appleReferenceToIso } from './scapeTime.js';
import { anArgus, aDeniedLaw, aPendingLaw, CAPTAIN_ARGUS_ID, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';
import { buildScapeFixture, type ScapeFixture } from './scapeFixture.testkit.js';

const CREATED_AT = 811_100_000;
const RESOLVED_AT = 811_200_000;
const IMPORT_MARK = 'scape-import';

const aLaw = (input: { id?: string; text: string; status?: string }): Record<string, unknown> => {
  const { id, text, status = 'approved' } = input;
  return { ...(id === undefined ? {} : { id }), kind: 'law', status, text, incident: 'invented incident', createdAt: CREATED_AT, resolvedAt: RESOLVED_AT };
};

interface StoredLaw { id: string; manager_id: string; text: string; status: string; revision: number; created_at: string; updated_at: string; approved_by: string; updated_by: string; source_kind: string; source_key: string; source_created_at: string; proposal_id: string | null }

const fingerprintOf = (text: string) => createHash('sha256').update(text.normalize('NFC').replace(/\s+/g, ' ').trim()).digest('hex');

describe('importing the approved Scape laws into the laws table', () => {
  let fixture: ScapeFixture;
  let home: string;
  let target: DatabaseSync | undefined;

  const runImport = (options: { dryRun?: boolean } = {}) => {
    target?.close();
    target = undefined;
    return importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot: join(fixture.workDir, 'managers'), ...options });
  };
  const openTarget = () => (target ??= new DatabaseSync(join(home, 'openfleet.db')));
  const lawsOf = (managerId: string) => openTarget().prepare('SELECT * FROM laws WHERE manager_id = ? ORDER BY source_key').all(managerId) as unknown as StoredLaw[];
  const allLaws = () => openTarget().prepare('SELECT * FROM laws ORDER BY source_key').all() as unknown as StoredLaw[];
  const lawByKey = (key: string) => openTarget().prepare('SELECT * FROM laws WHERE source_key = ?').get(key) as unknown as StoredLaw;
  const keyOf = (argusId: string, requestId: string) => `scape:${argusId}:${requestId}`;
  const importWithLaws = (governanceRequests: Record<string, unknown>[]) => {
    writeArguses(fixture, [anArgus({ governanceRequests })]);
    return runImport();
  };
  const missionOf = (managerId: string) => (openTarget().prepare('SELECT mission_text FROM managers WHERE session_id = ?').get(managerId) as { mission_text: string }).mission_text;

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
  });
  afterEach(() => {
    target?.close();
    target = undefined;
  });

  it('creates one law per approved law request with the key, the provenance and the dates of the request', () => {
    const report = importWithLaws([aLaw({ id: 'req-1', text: 'Always rebase before merging.' })]);

    const [law] = lawsOf(LEAD_ARGUS_ID);
    expect(law).toMatchObject({
      text: 'Always rebase before merging.', status: 'active', revision: 1, source_kind: 'import', source_key: keyOf(LEAD_ARGUS_ID, 'req-1'),
      approved_by: IMPORT_MARK, updated_by: IMPORT_MARK, proposal_id: null,
      created_at: appleReferenceToIso(RESOLVED_AT), source_created_at: appleReferenceToIso(CREATED_AT),
    });
    expect(report.counts.laws).toMatchObject({ expected: 1, written: 1, alreadyPresent: 0, conflict: 0 });
  });

  it('writes nothing on the second run', () => {
    importWithLaws([aLaw({ id: 'req-1', text: 'Law one.' }), aLaw({ id: 'req-2', text: 'Law two.' })]);
    const before = allLaws();

    const report = runImport();

    expect(allLaws()).toEqual(before);
    expect(report.counts.laws).toMatchObject({ expected: 2, written: 0, updated: 0, alreadyPresent: 2, conflict: 0 });
  });

  it('keeps a law edited locally and counts a conflict', () => {
    importWithLaws([aLaw({ id: 'req-1', text: 'Scape wording.' })]);
    const law = lawByKey(keyOf(LEAD_ARGUS_ID, 'req-1'));
    new LawRepository(openTarget()).replaceTextIfRevision({ lawId: law.id, expectedRevision: 1, text: 'Admin wording.', updatedBy: 'admin', updatedAt: '2026-10-20T10:00:00.000Z' });
    writeArguses(fixture, [anArgus({ governanceRequests: [aLaw({ id: 'req-1', text: 'Scape wording, changed.' })] })]);

    const report = runImport();

    expect(lawByKey(keyOf(LEAD_ARGUS_ID, 'req-1')).text).toBe('Admin wording.');
    expect(report.counts.laws).toMatchObject({ conflict: 1, updated: 0 });
  });

  it('never reactivates a law withdrawn locally', () => {
    importWithLaws([aLaw({ id: 'req-1', text: 'To be withdrawn.' })]);
    const law = lawByKey(keyOf(LEAD_ARGUS_ID, 'req-1'));
    new LawRepository(openTarget()).withdrawIfRevision({ lawId: law.id, expectedRevision: 1, withdrawnBy: 'admin', withdrawnAt: '2026-10-20T10:00:00.000Z' });

    const report = runImport();

    expect(lawByKey(keyOf(LEAD_ARGUS_ID, 'req-1'))).toMatchObject({ status: 'withdrawn', revision: 2 });
    expect(report.counts.laws).toMatchObject({ conflict: 1, written: 0, updated: 0 });
  });

  it('applies a changed Scape text to an intact law as a new revision', () => {
    importWithLaws([aLaw({ id: 'req-1', text: 'First wording.' })]);
    writeArguses(fixture, [anArgus({ governanceRequests: [aLaw({ id: 'req-1', text: 'Second wording.' })] })]);

    const report = runImport();

    expect(lawByKey(keyOf(LEAD_ARGUS_ID, 'req-1'))).toMatchObject({ text: 'Second wording.', revision: 2, updated_by: IMPORT_MARK, status: 'active' });
    expect(report.counts.laws).toMatchObject({ updated: 1, conflict: 0 });
    expect(runImport().counts.laws).toMatchObject({ alreadyPresent: 1, updated: 0 });
  });

  it('keeps two laws for an exact duplicate carrying two ids and reports it as a duplicate', () => {
    const report = importWithLaws([aLaw({ id: 'req-1', text: 'Same sentence.' }), aLaw({ id: 'req-2', text: 'Same sentence.' })]);

    expect(lawsOf(LEAD_ARGUS_ID)).toHaveLength(2);
    expect(report.laws.exactDuplicates).toBe(1);
  });

  it('gives each manager its own law for the same sentence', () => {
    writeArguses(fixture, [
      anArgus({ governanceRequests: [aLaw({ id: 'req-1', text: 'Shared sentence.' })] }),
      anArgus({ id: CAPTAIN_ARGUS_ID, name: 'Beta', governanceRequests: [aLaw({ id: 'req-2', text: 'Shared sentence.' })] }),
    ]);

    runImport();

    expect(lawsOf(LEAD_ARGUS_ID)).toHaveLength(1);
    expect(lawsOf(CAPTAIN_ARGUS_ID)).toHaveLength(1);
  });

  it('imports nothing for a manager without laws', () => {
    const report = importWithLaws([]);

    expect(allLaws()).toEqual([]);
    expect(report.laws.perManager).toEqual([]);
  });

  it('ignores the denied and pending laws and counts them', () => {
    const report = importWithLaws([aLaw({ id: 'req-1', text: 'Kept.' }), aDeniedLaw('Denied one.'), aDeniedLaw('Denied two.'), aPendingLaw('Pending one.')]);

    expect(allLaws()).toHaveLength(1);
    expect(report.laws).toMatchObject({ approvedInSource: 1, skippedNotApproved: { denied: 2, pending: 1 } });
  });

  it('ignores a blank or too long text and counts it as invalid', () => {
    const report = importWithLaws([aLaw({ id: 'req-1', text: '   ' }), aLaw({ id: 'req-2', text: 'x'.repeat(2001) }), aLaw({ id: 'req-3', text: 'Fine.' })]);

    expect(allLaws().map((law) => law.text)).toEqual(['Fine.']);
    expect(report.laws.invalidText).toBe(2);
  });

  it('keys a law without id by the fingerprint of its normalized text and numbers an exact duplicate', () => {
    const report = importWithLaws([aLaw({ text: 'No id   here.' }), aLaw({ text: 'No id here.' }), aLaw({ text: 'Another one.' })]);

    const keys = allLaws().map((law) => law.source_key);
    const fingerprintKey = `scape:${LEAD_ARGUS_ID}:fp:${fingerprintOf('No id here.')}`;
    expect(keys).toContain(fingerprintKey);
    expect(keys).toContain(`${fingerprintKey}#2`);
    expect(report.laws.keyedBy).toEqual({ requestId: 0, fingerprint: 3 });
    expect(report.laws.exactDuplicates).toBe(1);
    expect(runImport().counts.laws).toMatchObject({ alreadyPresent: 3, written: 0 });
  });

  it('masks a secret in the stored text', () => {
    importWithLaws([aLaw({ id: 'req-1', text: `Never print ${tokenPrefixOf('anthropic')}abcdefghijklmnopqrstuvwxyz0123456789 anywhere.` })]);

    expect(lawsOf(LEAD_ARGUS_ID)[0]!.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('reports a law that disappeared from Scape and keeps it', () => {
    importWithLaws([aLaw({ id: 'req-1', text: 'Soon gone.' }), aLaw({ id: 'req-2', text: 'Stays.' })]);
    writeArguses(fixture, [anArgus({ governanceRequests: [aLaw({ id: 'req-2', text: 'Stays.' })] })]);

    const report = runImport();

    expect(allLaws()).toHaveLength(2);
    expect(report.counts.laws.removedInScape).toBe(1);
  });

  it('never writes again a law deleted in OpenFleet', () => {
    importWithLaws([aLaw({ id: 'req-1', text: 'Deleted locally.' })]);
    openTarget().prepare('DELETE FROM laws WHERE source_key = ?').run(keyOf(LEAD_ARGUS_ID, 'req-1'));

    const report = runImport();

    expect(allLaws()).toEqual([]);
    expect(report.counts.laws).toMatchObject({ conflict: 1, deletedInOpenFleet: 1, written: 0 });
  });

  it('writes nothing during a dry run', () => {
    writeArguses(fixture, [anArgus({ governanceRequests: [aLaw({ id: 'req-1', text: 'Dry.' })] })]);
    runImport();
    writeArguses(fixture, [anArgus({ governanceRequests: [aLaw({ id: 'req-1', text: 'Dry.' }), aLaw({ id: 'req-2', text: 'New in dry run.' })] })]);

    const report = runImport({ dryRun: true });

    expect(report.counts.laws).toMatchObject({ written: 1, alreadyPresent: 1 });
    expect(allLaws()).toHaveLength(1);
  });

  it('reports the laws per manager without any law text', () => {
    const report = importWithLaws([aLaw({ id: 'req-1', text: 'Secret wording of the law.' })]);

    expect(report.laws.perManager).toEqual([{ argus: LEAD_ARGUS_ID, approved: 1, inserted: 1, updated: 0, conflict: 0, alreadyPresent: 0 }]);
    expect(JSON.stringify(report)).not.toContain('Secret wording of the law.');
  });

  it('does not copy the laws into the mission', () => {
    importWithLaws([aLaw({ id: 'req-1', text: 'Mission does not hold me.' })]);

    expect(lawsOf(LEAD_ARGUS_ID)).toHaveLength(1);
    expect(missionOf(LEAD_ARGUS_ID)).not.toContain('Mission does not hold me.');
    expect(missionOf(LEAD_ARGUS_ID)).not.toContain('Standing laws');
  });

  it('adds the laws to the --json report without renaming any existing key', () => {
    writeArguses(fixture, [anArgus({ governanceRequests: [aLaw({ id: 'req-1', text: 'Json law.' })] })]);

    const { output } = runImportCli(['scape', '--home', home, '--scape-dir', fixture.scapeDir, '--dry-run', '--json'], { homeDirectory: fixture.workDir, env: {} });

    const json = JSON.parse(output) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(expect.arrayContaining(['dryRun', 'counts', 'projectsWithoutDocsFolder', 'unconvertedNodeTypes', 'pendingPlaybookMentions', 'missionToolReferences', 'mergedStateSections', 'managerMissions', 'laws']));
    expect(Object.keys(json['counts'] as object)).toEqual(expect.arrayContaining(['projects', 'managers', 'memories', 'laws']));
  });
});
