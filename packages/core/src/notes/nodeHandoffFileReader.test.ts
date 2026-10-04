import { truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { nodeHandoffFileReader } from './nodeHandoffFileReader.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

describe('bounded handoff file reader', () => {
  it('reads only its byte window from a large file and excludes a partial UTF-8 character', () => {
    const root = tempDirs.make('of-handoff-reader-');
    const path = join(root, 'large.md');
    writeFileSync(path, '🙂🙂END');
    truncateSync(path, 64 * 1024 * 1024);
    const result = nodeHandoffFileReader.read({ filePath: path, maxBytes: 7 });
    expect(result).toEqual({ text: '🙂', totalBytes: 64 * 1024 * 1024 });
  });
});
