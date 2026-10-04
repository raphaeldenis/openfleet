import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runImportCli } from './importCli.js';
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
    const result = runImportCli(argv(), { homeDirectory });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(join(home, 'import-report.md'));
    expect(existsSync(join(home, 'openfleet.db'))).toBe(true);
  });

  it('prints the report and writes nothing on --dry-run', () => {
    const result = runImportCli(argv('--dry-run'), { homeDirectory });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('| notes | 5 | 5 | 0 | 0 | 0 |');
    expect(existsSync(home)).toBe(false);
  });

  it('limits the import to the project named by --project', () => {
    const result = runImportCli(argv('--dry-run', '--project', 'OpenFleet'), { homeDirectory });

    expect(result.output).toContain('| notes | 1 | 1 | 0 | 0 | 0 |');
  });

  it('exits 1 with the error code when the import fails', () => {
    const result = runImportCli(argv('--project', 'nope'), { homeDirectory });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('UNKNOWN_PROJECT');
  });

  it.each([
    ['no --home', ['scape']],
    ['an unknown flag', ['scape', '--home', 'x', '--nope']],
    ['another source than scape', ['notion', '--home', 'x']],
  ])('exits 2 with INVALID_ARGUMENTS on %s', (_label, args) => {
    const result = runImportCli(args, { homeDirectory });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('INVALID_ARGUMENTS');
  });
});
