import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectFolderNameOf } from './claudeProjectDirectory.js';
import { importScape } from './importScape.js';
import { MAX_MEMORY_BYTES_PER_MANAGER, MAX_MEMORY_FILE_BYTES } from './scapeMemories.js';
import { anArgus, CAPTAIN_ARGUS_ID, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';
import { buildScapeFixture, OPENFLEET_NOTE_ID, type ScapeFixture } from './scapeFixture.testkit.js';

const MEMORY_INDEX = '# Memory index\n- [a topic](topic.md)\n';
const TOPIC = 'synthetic topic body\n';

describe('importScape: Claude auto-memory of the managers', () => {
  let fixture: ScapeFixture;
  let home: string;
  let managersRoot: string;
  let scapeClaudeDir: string;
  let claudeDir: string;

  const memoryFolderIn = (claudeRoot: string, workingDirectory: string) => join(claudeRoot, 'projects', claudeProjectFolderNameOf(workingDirectory), 'memory');
  const sourceMemoryOf = (argusId: string) => memoryFolderIn(scapeClaudeDir, join(fixture.scapeDir, 'argus', argusId));
  const targetMemoryOf = (folderName: string) => memoryFolderIn(claudeDir, join(managersRoot, folderName));
  const writeSourceMemory = (files: Record<string, string>, argusId = LEAD_ARGUS_ID) => {
    const folder = sourceMemoryOf(argusId);
    mkdirSync(folder, { recursive: true });
    Object.entries(files).forEach(([name, text]) => writeFileSync(join(folder, name), text));
    return folder;
  };
  const run = (overrides: Partial<Parameters<typeof importScape>[0]> = {}) =>
    importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot, claudeDir, scapeClaudeDir, ...overrides });
  const targetFiles = (folderName = 'Alpha') => (existsSync(targetMemoryOf(folderName)) ? readdirSync(targetMemoryOf(folderName)).sort() : []);

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    managersRoot = join(fixture.workDir, 'managers');
    scapeClaudeDir = join(fixture.workDir, 'claude-scape-side');
    claudeDir = join(fixture.workDir, 'claude-target');
    writeArguses(fixture, [anArgus({ name: 'Alpha' })]);
  });

  it('copies the memory files of a manager to the Claude memory folder of its new working directory', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX, 'topic.md': TOPIC });

    const report = run();

    expect(readFileSync(join(targetMemoryOf('Alpha'), 'MEMORY.md'), 'utf8')).toBe(MEMORY_INDEX);
    expect(readFileSync(join(targetMemoryOf('Alpha'), 'topic.md'), 'utf8')).toBe(TOPIC);
    expect(report.counts.memories).toMatchObject({ expected: 2, written: 2, conflict: 0, notConverted: 0 });
  });

  it('writes nothing and creates no folder in the Claude folder when no claude folder is given', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX });

    const report = run({ claudeDir: undefined });

    expect(existsSync(claudeDir)).toBe(false);
    expect(report.counts.memories.expected).toBe(0);
  });

  it('expects nothing for a manager that has no memory folder', () => {
    const report = run();

    expect(report.counts.memories.expected).toBe(0);
    expect(existsSync(claudeDir)).toBe(false);
  });

  it('never writes to the source memory', () => {
    const folder = writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX });

    run();
    run({ refuseReimport: false });

    expect(readdirSync(folder)).toEqual(['MEMORY.md']);
    expect(readFileSync(join(folder, 'MEMORY.md'), 'utf8')).toBe(MEMORY_INDEX);
  });

  it('writes 0 files on the second run and counts them as already present', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX, 'topic.md': TOPIC });
    run();

    const report = run();

    expect(report.counts.memories).toMatchObject({ expected: 2, written: 0, updated: 0, alreadyPresent: 2, conflict: 0 });
  });

  it('writes nothing and creates no folder on a dry run, and still reports what it would write', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX });

    const report = run({ dryRun: true });

    expect(existsSync(claudeDir)).toBe(false);
    expect(report.counts.memories).toMatchObject({ expected: 1, written: 1 });
  });

  it('keeps a different file already present at the target and counts a conflict', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX });
    mkdirSync(targetMemoryOf('Alpha'), { recursive: true });
    writeFileSync(join(targetMemoryOf('Alpha'), 'MEMORY.md'), 'written by hand in OpenFleet\n');

    const report = run();

    expect(readFileSync(join(targetMemoryOf('Alpha'), 'MEMORY.md'), 'utf8')).toBe('written by hand in OpenFleet\n');
    expect(report.counts.memories).toMatchObject({ expected: 1, written: 0, conflict: 1 });
  });

  it('applies a source change to a file OpenFleet left alone', () => {
    const folder = writeSourceMemory({ 'topic.md': TOPIC });
    run();
    writeFileSync(join(folder, 'topic.md'), 'the source moved on\n');

    const report = run({ refuseReimport: false });

    expect(readFileSync(join(targetMemoryOf('Alpha'), 'topic.md'), 'utf8')).toBe('the source moved on\n');
    expect(report.counts.memories).toMatchObject({ updated: 1, conflict: 0 });
  });

  it('keeps a file edited on the OpenFleet side and counts a conflict when the source also changed', () => {
    const folder = writeSourceMemory({ 'topic.md': TOPIC });
    run();
    writeFileSync(join(targetMemoryOf('Alpha'), 'topic.md'), 'edited by the manager\n');
    writeFileSync(join(folder, 'topic.md'), 'the source moved on\n');

    const report = run({ refuseReimport: false });

    expect(readFileSync(join(targetMemoryOf('Alpha'), 'topic.md'), 'utf8')).toBe('edited by the manager\n');
    expect(report.counts.memories).toMatchObject({ updated: 0, conflict: 1 });
  });

  it('does not write again a file the manager deleted since the last import', () => {
    writeSourceMemory({ 'topic.md': TOPIC });
    run();
    rmTarget('Alpha', 'topic.md');

    const report = run({ refuseReimport: false });

    expect(targetFiles()).toEqual([]);
    expect(report.counts.memories).toMatchObject({ written: 0, conflict: 1, deletedInOpenFleet: 1 });
  });

  it('copies only the regular markdown files directly inside the memory folder', () => {
    const folder = writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX, 'notes.txt': 'not markdown' });
    mkdirSync(join(folder, 'nested'));
    writeFileSync(join(folder, 'nested', 'deep.md'), 'nested');

    const report = run();

    expect(targetFiles()).toEqual(['MEMORY.md']);
    expect(report.counts.memories).toMatchObject({ expected: 1, written: 1 });
  });

  it('refuses a symbolic link among the memory files and reports it as not converted', () => {
    const folder = writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX });
    writeFileSync(join(fixture.workDir, 'outside.md'), 'outside the memory');
    symlinkSync(join(fixture.workDir, 'outside.md'), join(folder, 'linked.md'));

    const report = run();

    expect(targetFiles()).toEqual(['MEMORY.md']);
    expect(report.counts.memories).toMatchObject({ expected: 2, written: 1, notConverted: 1 });
  });

  it('refuses a memory folder that is a symbolic link and reports nothing written', () => {
    mkdirSync(join(fixture.workDir, 'elsewhere'));
    writeFileSync(join(fixture.workDir, 'elsewhere', 'MEMORY.md'), MEMORY_INDEX);
    mkdirSync(join(sourceMemoryOf(LEAD_ARGUS_ID), '..'), { recursive: true });
    symlinkSync(join(fixture.workDir, 'elsewhere'), sourceMemoryOf(LEAD_ARGUS_ID));

    const report = run();

    expect(existsSync(claudeDir)).toBe(false);
    expect(report.counts.memories).toMatchObject({ expected: 1, written: 0, notConverted: 1 });
  });

  it('refuses to write through a memory folder of the target that is a symbolic link', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX });
    mkdirSync(join(fixture.workDir, 'elsewhere'));
    mkdirSync(join(targetMemoryOf('Alpha'), '..'), { recursive: true });
    symlinkSync(join(fixture.workDir, 'elsewhere'), targetMemoryOf('Alpha'));

    expect(() => run()).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));
    expect(readdirSync(join(fixture.workDir, 'elsewhere'))).toEqual([]);
  });

  it('skips a file over the size cap, never truncates it, and reports it as not converted', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX, 'huge.md': 'x'.repeat(MAX_MEMORY_FILE_BYTES + 1) });

    const report = run();

    expect(targetFiles()).toEqual(['MEMORY.md']);
    expect(report.counts.memories).toMatchObject({ expected: 2, written: 1, notConverted: 1 });
  });

  it('skips the files that exceed the total cap of a manager', () => {
    const fileCountThatFitsTheCap = Math.floor(MAX_MEMORY_BYTES_PER_MANAGER / MAX_MEMORY_FILE_BYTES);
    const filesOfTheMaximumSize = Object.fromEntries(Array.from({ length: fileCountThatFitsTheCap + 1 }, (_, index) => [`f${index}.md`, 'x'.repeat(MAX_MEMORY_FILE_BYTES)]));
    writeSourceMemory(filesOfTheMaximumSize);

    const report = run();

    expect(report.counts.memories).toMatchObject({ expected: fileCountThatFitsTheCap + 1, written: fileCountThatFitsTheCap, notConverted: 1 });
  });

  it('reports as not converted the memory of a manager whose working directory gives a Claude folder name the Claude CLI hashes', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX });

    const report = run({ managersRoot: join(managersRoot, 'd'.repeat(200)) });

    expect(existsSync(claudeDir)).toBe(false);
    expect(report.counts.memories).toMatchObject({ expected: 1, written: 0, notConverted: 1 });
  });

  it('removes the files and folders this run created when the import fails afterwards', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX });
    writeFileSync(managersRoot, 'a file where the managers folder must go');

    expect(() => run()).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));

    expect(existsSync(claudeDir)).toBe(false);
  });

  it('adds only the memories to a home that already holds the imported managers, every other family staying as it is', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX, 'topic.md': TOPIC });
    run({ claudeDir: undefined });

    const report = run({ refuseReimport: false });

    expect(report.counts.memories).toMatchObject({ expected: 2, written: 2 });
    const otherFamilies = Object.entries(report.counts).filter(([name]) => name !== 'memories');
    expect(otherFamilies.every(([, counts]) => counts.written === 0 && counts.updated === 0 && counts.conflict === 0)).toBe(true);
    expect(report.counts.managers.alreadyPresent).toBe(1);
  });

  it('keeps the memory of a manager whose record is a conflict out of the import', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX });
    run({ claudeDir: undefined });
    const database = new DatabaseSync(join(home, 'openfleet.db'));
    database.prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run('mission edited in OpenFleet', LEAD_ARGUS_ID);
    database.close();

    const report = run({ refuseReimport: false });

    expect(targetFiles()).toEqual([]);
    expect(report.counts.memories).toMatchObject({ expected: 1, written: 0, conflict: 1 });
  });

  it('writes the memories into the folder of the session directory stored in the target database', () => {
    writeSourceMemory({ 'MEMORY.md': MEMORY_INDEX });
    run({ claudeDir: undefined });

    run({ refuseReimport: false });

    const database = new DatabaseSync(join(home, 'openfleet.db'));
    const { directory } = database.prepare('SELECT directory FROM sessions WHERE id = ?').get(LEAD_ARGUS_ID) as { directory: string };
    database.close();
    expect(existsSync(memoryFolderIn(claudeDir, directory))).toBe(true);
  });

  it('imports the memories of each manager into its own folder', () => {
    writeArguses(fixture, [anArgus({ name: 'Alpha' }), anArgus({ id: CAPTAIN_ARGUS_ID, name: 'Beta', noteId: OPENFLEET_NOTE_ID })]);
    writeSourceMemory({ 'MEMORY.md': 'alpha memory' }, LEAD_ARGUS_ID);
    writeSourceMemory({ 'MEMORY.md': 'beta memory' }, CAPTAIN_ARGUS_ID);

    run();

    expect(readFileSync(join(targetMemoryOf('Alpha'), 'MEMORY.md'), 'utf8')).toBe('alpha memory');
    expect(readFileSync(join(targetMemoryOf('Beta'), 'MEMORY.md'), 'utf8')).toBe('beta memory');
  });

  const rmTarget = (folderName: string, fileName: string) => rmSync(join(targetMemoryOf(folderName), fileName));
});
