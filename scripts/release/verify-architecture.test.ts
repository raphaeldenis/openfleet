import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'verify-architecture.mjs');
const ARM_TARGET = 'aarch64-apple-darwin';
const INTEL_TARGET = 'x86_64-apple-darwin';
const scratchFolders: string[] = [];

afterEach(() => {
  for (const folder of scratchFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function writeBinary(header: Buffer) {
  const folder = mkdtempSync(join(tmpdir(), 'of-architecture-'));
  scratchFolders.push(folder);
  const binaryPath = join(folder, 'node');
  writeFileSync(binaryPath, header);
  return binaryPath;
}

function machOHeader(cpu: number) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpu, 4);
  header.writeUInt32LE(2, 12);
  return header;
}

function verifyArchitecture({ target, binaries }: { target: string; binaries: string[] }) {
  return spawnSync(process.execPath, [SCRIPT, target, ...binaries], { encoding: 'utf8' });
}

describe('release architecture guard', () => {
  it.each([
    { target: ARM_TARGET, cpu: 0x0100000c },
    { target: INTEL_TARGET, cpu: 0x01000007 },
  ])('accepts a matching $target executable without executing it', ({ target, cpu }) => {
    const binaryPath = writeBinary(machOHeader(cpu));

    const result = verifyArchitecture({ target, binaries: [binaryPath] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(target);
  });

  it.each([
    { target: ARM_TARGET, cpu: 0x01000007, expected: 'arm64', actual: 'x86_64' },
    { target: INTEL_TARGET, cpu: 0x0100000c, expected: 'x86_64', actual: 'arm64' },
  ])('refuses the other CPU for $target', ({ target, cpu, expected, actual }) => {
    const binaryPath = writeBinary(machOHeader(cpu));

    const result = verifyArchitecture({ target, binaries: [binaryPath] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`is ${actual}, expected ${expected}`);
  });

  it.each([
    { name: 'a placeholder', header: Buffer.from('#!/bin/sh\nexit 0\n') },
    { name: 'a truncated header', header: machOHeader(0x0100000c).subarray(0, 8) },
    { name: 'an unknown CPU', header: machOHeader(42) },
    { name: 'a universal header', header: Buffer.from('cafebabe00000002000000000000000000000000000000000000000000000000', 'hex') },
  ])('refuses $name', ({ header }) => {
    const binaryPath = writeBinary(header);

    const result = verifyArchitecture({ target: ARM_TARGET, binaries: [binaryPath] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected arm64');
  });

  it('checks every packaged executable', () => {
    const node = writeBinary(machOHeader(0x0100000c));
    const app = writeBinary(machOHeader(0x01000007));

    const result = verifyArchitecture({ target: ARM_TARGET, binaries: [node, app] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is x86_64, expected arm64');
  });

  it('refuses a missing executable', () => {
    const missingPath = join(writeBinary(Buffer.alloc(0)), 'missing');

    const result = verifyArchitecture({ target: ARM_TARGET, binaries: [missingPath] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verify-architecture:');
    expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
  });

  it('refuses a native library with the matching CPU', () => {
    const header = machOHeader(0x0100000c);
    header.writeUInt32LE(6, 12);
    const binaryPath = writeBinary(header);

    const result = verifyArchitecture({ target: ARM_TARGET, binaries: [binaryPath] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a Mach-O executable');
  });

  it.each([
    { target: 'unsupported', binaries: ['node'] },
    { target: ARM_TARGET, binaries: [] },
  ])('refuses invalid arguments $target $binaries', (options) => {
    const result = verifyArchitecture(options);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage:');
  });
});
