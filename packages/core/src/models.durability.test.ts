import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveModelPatch } from './models.js';

// The only way to observe that an acknowledged save survives a crash is to watch the syscalls it makes.
const syscalls = vi.hoisted(() => ({ events: [] as string[], pathByDescriptor: new Map<number, string>() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      syscalls.pathByDescriptor.set(descriptor, String(args[0]));
      return descriptor;
    },
    fsyncSync: (descriptor: number) => {
      syscalls.events.push(`fsync ${syscalls.pathByDescriptor.get(descriptor)}`);
      return actual.fsyncSync(descriptor);
    },
    renameSync: (from: string, to: string) => {
      syscalls.events.push(`rename ${to}`);
      return actual.renameSync(from, to);
    },
  };
});

let homeDirectory: string;
let configPath: string;

beforeEach(() => {
  syscalls.events.length = 0;
  homeDirectory = mkdtempSync(join(tmpdir(), 'of-models-durability-'));
  configPath = join(homeDirectory, 'config.json');
});

afterEach(() => rmSync(homeDirectory, { recursive: true, force: true }));

describe('saveModelPatch durability', () => {
  it('flushes the new file before swapping it in, then flushes the directory that holds the swap', () => {
    saveModelPatch(configPath, { opus: 'claude-opus-5-5-b' });

    const [temporaryFileFlush, swap, directoryFlush] = syscalls.events;
    expect(syscalls.events).toHaveLength(3);
    expect(temporaryFileFlush?.startsWith(`fsync ${configPath}.`)).toBe(true);
    expect(swap).toBe(`rename ${configPath}`);
    expect(directoryFlush).toBe(`fsync ${homeDirectory}`);
  });
});
