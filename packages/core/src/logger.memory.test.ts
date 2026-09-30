import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from './tempDirTracker.js';

const RING_CAPACITY = 2000;
const MAX_HEAP_GROWTH_MIB = 40;
const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const LOGGER_URL = pathToFileURL(fileURLToPath(new URL('./logger.ts', import.meta.url))).href;

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

/** Runs `body` in a fresh node with --expose-gc; `body` reports through `report(object)`. */
function measuredInFreshNode(body: string): { heapGrowthMiB: number; ringLines: number; longestLine: number } {
  const script = join(tempDirs.make('logger-memory-'), 'measure.mjs');
  writeFileSync(script, `
    const { log, recentLogLines } = await import(${JSON.stringify(LOGGER_URL)});
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    console.log = () => {};
    const heapAfterGc = () => { globalThis.gc(); return process.memoryUsage().heapUsed; };
    const before = heapAfterGc();
    ${body}
    const after = heapAfterGc();
    const lines = recentLogLines();
    process.stdout.write(JSON.stringify({ heapGrowthMiB: (after - before) / 1048576, ringLines: lines.length, longestLine: Math.max(...lines.map((line) => line.length)) }));
  `);
  const output = execFileSync(process.execPath, ['--expose-gc', '--import', 'tsx', script], { cwd: PACKAGE_DIRECTORY, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return JSON.parse(output) as { heapGrowthMiB: number; ringLines: number; longestLine: number };
}

describe('log — ring buffer memory', () => {
  it('keeps a full ring of worst-case lines (50 strings of 5000 two-byte characters in five arrays) under 40 MiB of heap', () => {
    const measured = measuredInFreshNode(`
      const worstCaseDetail = () => Array.from({ length: 5 }, () => Array.from({ length: 50 }, () => ('€"' + Math.random()).repeat(300).slice(0, 5000)));
      for (let index = 0; index < ${RING_CAPACITY}; index += 1) log('info', 'worst case', worstCaseDetail());
    `);

    expect(measured.ringLines).toBe(RING_CAPACITY);
    expect(measured.longestLine).toBeLessThan(8300);
    expect(measured.heapGrowthMiB).toBeLessThan(MAX_HEAP_GROWTH_MIB);
  }, 120_000);

  it('keeps a full ring of 200-key, 5000-character-value lines under 40 MiB of heap', () => {
    const measured = measuredInFreshNode(`
      const fatDetail = () => Object.fromEntries(Array.from({ length: 200 }, (_, key) => ['key' + key, 'v'.repeat(5000) + Math.random()]));
      for (let index = 0; index < ${RING_CAPACITY}; index += 1) log('info', 'fat', fatDetail());
    `);

    expect(measured.ringLines).toBe(RING_CAPACITY);
    expect(measured.heapGrowthMiB).toBeLessThan(MAX_HEAP_GROWTH_MIB);
  }, 120_000);
});
