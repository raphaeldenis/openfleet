import { describe, expect, it } from 'vitest';
import { claudeProjectFolderNameOf } from './claudeProjectDirectory.js';

describe('claudeProjectFolderNameOf', () => {
  it.each([
    ['/Users/chicko/.scape/argus/9EA6A767-EC62-4F40-B5CD-E5FBC40C1043', '-Users-chicko--scape-argus-9EA6A767-EC62-4F40-B5CD-E5FBC40C1043'],
    ['/Users/chicko/Documents/Coding/openfleet/.worktrees/phase3/x', '-Users-chicko-Documents-Coding-openfleet--worktrees-phase3-x'],
    ['/Users/chicko/.openfleet-dev/managers/Lead', '-Users-chicko--openfleet-dev-managers-Lead'],
    ['/tmp/a_b c/ü', '-tmp-a-b-c--'],
  ])('encodes %s as the Claude CLI project folder %s', (workingDirectory, folderName) => {
    expect(claudeProjectFolderNameOf(workingDirectory)).toBe(folderName);
  });
});
