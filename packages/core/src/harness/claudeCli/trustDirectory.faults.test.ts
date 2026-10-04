import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenFleetError } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({
  beforeRename: undefined as undefined | (() => void),
  afterTempWritten: undefined as undefined | (() => void),
  tempWrittenCount: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      actual.fsyncSync(fd);
      faults.tempWrittenCount += 1;
      faults.afterTempWritten?.();
    },
    renameSync: (from: string, to: string) => {
      faults.beforeRename?.();
      actual.renameSync(from, to);
    },
  };
});

const { markDirectoryTrusted, TRUST_WRITE_MAX_ATTEMPTS } = await import('./trustDirectory.js');

const ORIGINAL_CONFIG = '{\n  "numStartups": 3\n}\n';

function setUp() {
  const home = mkdtempSync(join(tmpdir(), 'of-claude-home-'));
  const configPath = join(home, '.claude.json');
  const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
  writeFileSync(configPath, ORIGINAL_CONFIG);
  return { home, configPath, directory, realDirectory: realpathSync(directory) };
}

const failureOf = (act: () => void): Error | undefined => {
  try { act(); } catch (err) { return err as Error; }
};

describe('markDirectoryTrusted under faults', () => {
  afterEach(() => {
    faults.beforeRename = undefined;
    faults.afterTempWritten = undefined;
    faults.tempWrittenCount = 0;
  });

  it('leaves the original file intact and no temp file when the process dies between the temp write and the rename', () => {
    const { home, configPath, directory } = setUp();
    faults.afterTempWritten = () => { throw new Error('simulated kill'); };

    const failure = failureOf(() => markDirectoryTrusted(configPath, directory));

    expect(failure?.message).toBe('simulated kill');
    expect(readFileSync(configPath, 'utf8')).toBe(ORIGINAL_CONFIG);
    expect(readdirSync(home)).toEqual(['.claude.json']);
  });

  it('leaves the original file intact and no temp file when the rename fails', () => {
    const { home, configPath, directory } = setUp();
    faults.beforeRename = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };

    const failure = failureOf(() => markDirectoryTrusted(configPath, directory));

    expect(failure?.message).toBe('EIO');
    expect(readFileSync(configPath, 'utf8')).toBe(ORIGINAL_CONFIG);
    expect(readdirSync(home)).toEqual(['.claude.json']);
  });

  it('retries on top of a foreign write that lands before the rename, so neither change is lost', () => {
    const { home, configPath, directory, realDirectory } = setUp();
    let hasForeignWriterRun = false;
    faults.afterTempWritten = () => {
      if (hasForeignWriterRun) return;
      hasForeignWriterRun = true;
      writeFileSync(configPath, '{\n  "numStartups": 3,\n  "foreign": true\n}\n');
    };

    markDirectoryTrusted(configPath, directory);

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ numStartups: 3, foreign: true, projects: { [realDirectory]: { hasTrustDialogAccepted: true } } });
    expect(faults.tempWrittenCount).toBe(2);
    expect(readdirSync(home)).toEqual(['.claude.json']);
  });

  it('fails with a typed launch_failed error after a bounded number of attempts when the file keeps changing, and loses nothing', () => {
    const { home, configPath, directory } = setUp();
    let writes = 0;
    faults.afterTempWritten = () => {
      writes += 1;
      writeFileSync(configPath, `{\n  "numStartups": ${100 + writes}\n}\n`);
    };

    const failure = failureOf(() => markDirectoryTrusted(configPath, directory));

    expect(failure).toBeInstanceOf(OpenFleetError);
    expect((failure as OpenFleetError).code).toBe('launch_failed');
    expect(faults.tempWrittenCount).toBe(TRUST_WRITE_MAX_ATTEMPTS);
    expect(readFileSync(configPath, 'utf8')).toBe(`{\n  "numStartups": ${100 + TRUST_WRITE_MAX_ATTEMPTS}\n}\n`);
    expect(readdirSync(home)).toEqual(['.claude.json']);
  });
});
