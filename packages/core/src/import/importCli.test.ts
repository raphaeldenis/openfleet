import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runImportCli } from './importCli.js';
import { anArgus, writeArguses } from './scape/scapeArguses.testkit.js';
import { buildScapeFixture, type ScapeFixture } from './scape/scapeFixture.testkit.js';

describe('runImportCli', () => {
  let fixture: ScapeFixture;
  let home: string;
  let homeDirectory: string;
  const argv = (...flags: string[]) => ['scape', '--home', home, '--scape-dir', fixture.scapeDir, ...flags];

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    homeDirectory = join(fixture.workDir, 'user-home');
    mkdirSync(join(homeDirectory, 'Documents', 'superpowers'), { recursive: true });
  });

  it('imports and tells where the report is', () => {
    const result = runImportCli(argv(), { homeDirectory, env: {} });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(join(home, 'import-report.md'));
    expect(existsSync(join(home, 'openfleet.db'))).toBe(true);
  });

  it('prints the report and writes nothing on --dry-run', () => {
    const result = runImportCli(argv('--dry-run'), { homeDirectory, env: {} });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('| notes | 5 | 5 | 0 | 0 | 0 | 0 |');
    expect(existsSync(home)).toBe(false);
  });

  it('takes the home from OPENFLEET_HOME when --home is absent', () => {
    const result = runImportCli(['scape', '--scape-dir', fixture.scapeDir], { homeDirectory, env: { OPENFLEET_HOME: home } });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, 'openfleet.db'))).toBe(true);
  });

  it('prefers --home over OPENFLEET_HOME', () => {
    const otherHome = join(fixture.workDir, 'other-home');

    runImportCli(argv(), { homeDirectory, env: { OPENFLEET_HOME: otherHome } });

    expect(existsSync(join(home, 'openfleet.db'))).toBe(true);
    expect(existsSync(otherHome)).toBe(false);
  });

  it('limits the import to the project named by --project', () => {
    const result = runImportCli(argv('--dry-run', '--project', 'OpenFleet'), { homeDirectory, env: {} });

    expect(result.output).toContain('| notes | 1 | 1 | 0 | 0 | 0 | 0 |');
  });

  describe('the working states of the managers', () => {
    const writeAlphaStateFileIn = (stateDirectory: string) => {
      mkdirSync(stateDirectory, { recursive: true });
      writeFileSync(join(stateDirectory, 'alpha.md'), '## Plan\n- a synthetic plan item');
    };

    it('seeds them from the folder named by --state-dir', () => {
      writeArguses(fixture, [anArgus({ name: 'Alpha' })]);
      const stateDirectory = join(fixture.workDir, 'chosen-state');
      writeAlphaStateFileIn(stateDirectory);

      const result = runImportCli(argv('--dry-run', '--state-dir', stateDirectory), { homeDirectory, env: {} });

      expect(result.output).toContain('| workingStates | 1 | 1 | 0 | 0 | 0 | 0 |');
    });

    it('seeds them from scape-team/state in the Documents of the user by default', () => {
      writeArguses(fixture, [anArgus({ name: 'Alpha' })]);
      writeAlphaStateFileIn(join(homeDirectory, 'Documents', 'scape-team', 'state'));

      const result = runImportCli(argv('--dry-run'), { homeDirectory, env: {} });

      expect(result.output).toContain('| workingStates | 1 | 1 | 0 | 0 | 0 | 0 |');
    });
  });

  describe('a second real import', () => {
    it('is refused with ALREADY_IMPORTED unless --allow-reimport is passed, and the hint points at --dry-run', () => {
      runImportCli(argv(), { homeDirectory, env: {} });

      const result = runImportCli(argv(), { homeDirectory, env: {} });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('ALREADY_IMPORTED');
      expect(result.output).toContain('--allow-reimport');
      expect(result.output).toContain('--dry-run');
    });

    it('goes through with --allow-reimport and says where to read the conflicts', () => {
      runImportCli(argv(), { homeDirectory, env: {} });

      const result = runImportCli(argv('--allow-reimport'), { homeDirectory, env: {} });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Re-import');
      expect(result.output).toContain('removed in Scape');
    });

    it('previews the outcome of the re-import per entity with --dry-run, without --allow-reimport', () => {
      runImportCli(argv(), { homeDirectory, env: {} });

      const result = runImportCli(argv('--dry-run'), { homeDirectory, env: {} });

      expect(result.output).toContain('| notes | 5 | 0 | 0 | 5 | 0 | 0 | 0 | 0 |');
    });

    it('can still be previewed with --dry-run', () => {
      runImportCli(argv(), { homeDirectory, env: {} });

      const result = runImportCli(argv('--dry-run'), { homeDirectory, env: {} });

      expect(result.exitCode).toBe(0);
    });
  });

  it('prints the usage with the re-import rules on --help', () => {
    const result = runImportCli(['--help'], { homeDirectory, env: {} });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('--allow-reimport');
    expect(result.output).toMatch(/re-import compares/i);
    expect(result.output).toContain('deleted in OpenFleet');
  });

  it('ends a home that cannot be opened with one IMPORT_WRITE_FAILED line and no stack trace', () => {
    writeFileSync(home, 'not a directory');

    const result = runImportCli(argv(), { homeDirectory, env: {} });

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/^IMPORT_WRITE_FAILED: [^\n]*\n$/);
  });

  it('exits 1 with the error code when the import fails', () => {
    const result = runImportCli(argv('--project', 'nope'), { homeDirectory, env: {} });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('UNKNOWN_PROJECT');
  });

  it.each([
    ['no --home', ['scape']],
    ['an unknown flag', ['scape', '--home', 'x', '--nope']],
    ['another source than scape', ['notion', '--home', 'x']],
  ])('exits 2 with INVALID_ARGUMENTS on %s', (_label, args) => {
    const result = runImportCli(args, { homeDirectory, env: {} });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('INVALID_ARGUMENTS');
  });
});
