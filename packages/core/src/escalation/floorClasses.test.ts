import { describe, expect, it } from 'vitest';
import { computeFloorClasses } from './floorClasses.js';

const floorOfText = (text: string) => computeFloorClasses({ text });
const floorOfPaths = (paths: string[]) => computeFloorClasses({ text: 'Which helper do we use?', paths });

describe('computeFloorClasses by keyword', () => {
  it.each([
    ['contract', 'Do we bump contract_version for this tool?'],
    ['contract', 'Is this a breaking change for the public API?'],
    ['security', 'Where do we store the credential?'],
    ['security', 'Should the sandbox allow network access?'],
    ['deployment', 'When do we release to the device?'],
    ['history_rewrite', 'Can we force-push the branch after the rebase?'],
    ['dod_waiver', 'May we waive the visual criterion?'],
    ['dod_waiver', 'Can we skip QA on this slice?'],
    ['spend', 'Do we buy a paid plan for the vendor?'],
    ['visual_qa', 'Who runs the human QA on the card?'],
  ])('puts a question that cites %s in the floor: "%s"', (expectedClass, text) => {
    expect(floorOfText(text)).toContain(expectedClass);
  });

  it('returns an empty floor for a plain technical question', () => {
    expect(floorOfText('Which retry strategy fits the sync job?')).toEqual([]);
  });

  it('ignores the letter case of a keyword', () => {
    expect(floorOfText('DO WE BUMP CONTRACT_VERSION?')).toContain('contract');
  });

  it('reads the options and the recommendation of the question as well as its text', () => {
    const floor = computeFloorClasses({ text: 'Which way?', options: ['keep it', 'rotate the token'], recommendation: 'then force-push' });

    expect(floor).toEqual(expect.arrayContaining(['security', 'history_rewrite']));
  });

  it('reads a keyword written with zero-width and bidi characters inside the word', () => {
    expect(floorOfText('Do we bump contract​_ver‮sion? contract_⁠version')).toContain('contract');
  });

  it('reads a keyword in decomposed unicode the same as in composed unicode', () => {
    const decomposedDerogation = 'une dérogation sur la couverture';

    expect(floorOfText(decomposedDerogation)).toContain('dod_waiver');
  });

  it('reads a line break between the words of a keyword as a space', () => {
    expect(floorOfText('Can we reset\n--hard the branch?')).toContain('history_rewrite');
  });

  it('returns each class once, in the order of the vocabulary', () => {
    const floor = floorOfText('contract_version migration secret token force-push');

    expect(floor).toEqual(['contract', 'security', 'history_rewrite']);
  });
});

describe('computeFloorClasses by path', () => {
  it.each([
    ['contract', 'packages/shared/src/mcpContract.ts'],
    ['contract', 'packages/core/src/mcp/contract.pinned.json'],
    ['contract', 'contract.pinned.json'],
    ['contract', 'packages/core/src/db/migrations/056_escalation.sql'],
    ['contract', 'docs/mcp-contract.md'],
    ['contract', 'docs/errors.md'],
    ['contract', 'packages/core/src/api/projectRoutes.ts'],
    ['security', 'packages/core/src/policy/defaultCommandPolicy.ts'],
    ['security', 'packages/core/src/notes/redactSecrets.ts'],
    ['security', 'packages/core/src/auth/session.ts'],
    ['security', 'packages/core/src/api/adminToken.ts'],
    ['security', 'packages/core/src/harness/claude/claudeHooks.ts'],
    ['deployment', '.github/workflows/ci.yml'],
    ['deployment', 'apps/desktop/Dockerfile.prod'],
    ['deployment', 'apps/desktop/src-tauri/tauri.conf.json'],
    ['deployment', 'scripts/release-notes.mjs'],
  ])('puts %s in the floor for the path %s', (expectedClass, path) => {
    expect(floorOfPaths([path])).toContain(expectedClass);
  });

  it('leaves an ordinary source file out of the floor', () => {
    expect(floorOfPaths(['packages/core/src/escalation/helpers.ts'])).toEqual([]);
  });

  it('ignores the letter case of a path', () => {
    expect(floorOfPaths(['Packages/Shared/Src/McpContract.ts'])).toContain('contract');
  });

  it('reads a path written with a leading ./ and with backslashes', () => {
    expect(floorOfPaths(['.\\packages\\shared\\src\\mcpContract.ts'])).toContain('contract');
  });

  it('keeps a path that exists in no tree, because the plan describes code still to be written', () => {
    expect(floorOfPaths(['packages/new/db/migrations/999_future.sql'])).toContain('contract');
  });
});

describe('computeFloorClasses with the extra rules of a project', () => {
  it('adds the class of a keyword rule', () => {
    const floor = computeFloorClasses({ text: 'Do we pay the invoice?' }, [{ class: 'spend', keyword: 'Invoice' }]);

    expect(floor).toEqual(['spend']);
  });

  it('adds the class of a path rule', () => {
    const floor = computeFloorClasses({ text: 'Which helper?', paths: ['infra/terraform/main.tf'] }, [{ class: 'deployment', pathGlob: 'infra/**' }]);

    expect(floor).toEqual(['deployment']);
  });

  it('never lowers the floor: a rule can only add a class', () => {
    const floor = computeFloorClasses({ text: 'Do we bump contract_version?' }, [{ class: 'spend', keyword: 'never-matches' }]);

    expect(floor).toEqual(['contract']);
  });

  it('matches a glob star inside one segment only', () => {
    const rule = [{ class: 'deployment' as const, pathGlob: 'infra/*.tf' }];

    expect(computeFloorClasses({ text: 'x', paths: ['infra/main.tf'] }, rule)).toEqual(['deployment']);
    expect(computeFloorClasses({ text: 'x', paths: ['infra/nested/main.tf'] }, rule)).toEqual([]);
  });

  it('treats the regex characters of a glob as plain characters', () => {
    const rule = [{ class: 'spend' as const, pathGlob: 'a.b(c)+/**' }];

    expect(computeFloorClasses({ text: 'x', paths: ['a.b(c)+/file.ts'] }, rule)).toEqual(['spend']);
    expect(computeFloorClasses({ text: 'x', paths: ['aXb(c)+/file.ts'] }, rule)).toEqual([]);
  });

  it('answers a hostile glob on a long path in bounded time', () => {
    const hostileRule = [{ class: 'spend' as const, pathGlob: '**/**/**/**/**/**/**/**/*.zzz' }];
    const longPath = `${'a/'.repeat(2000)}file.ts`;
    const startedAt = performance.now();

    computeFloorClasses({ text: 'x', paths: [longPath] }, hostileRule);

    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
