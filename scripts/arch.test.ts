import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPCRUISE_BIN = join(REPO_ROOT, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const CONFIG = join(REPO_ROOT, '.dependency-cruiser.cjs');
const KNOWN_VIOLATIONS = join(REPO_ROOT, '.dependency-cruiser-known-violations.json');
const SOURCE_ROOTS = ['packages/core/src', 'packages/shared/src', 'apps/desktop/src'];
const SUBPROCESS_TIMEOUT_MS = 60_000;

const FIXTURE_FILES: Record<string, string> = {
  'node_modules/zod/package.json': '{"name":"zod","main":"index.js"}',
  'node_modules/zod/index.js': 'module.exports = {};',
  'node_modules/ws/package.json': '{"name":"ws","main":"index.js"}',
  'node_modules/ws/index.js': 'module.exports = {};',

  'packages/shared/src/index.ts': "import 'zod';\nexport const wire = 1;",
  'packages/shared/src/internal.ts': 'export const internal = 1;',
  'packages/shared/src/usesNode.ts': "import 'node:fs';\nexport const usesNode = 1;",
  'packages/shared/src/usesWs.ts': "import 'ws';\nexport const usesWs = 1;",

  'packages/core/src/notes/cycleA.ts': "import './cycleB';\nexport const a = 1;",
  'packages/core/src/notes/cycleB.ts': "import './cycleA';\nexport const b = 1;",
  'packages/core/src/notes/importsMissing.ts': "import './missing';\nexport const importsMissing = 1;",
  'packages/core/src/notes/noteService.ts': 'export const noteService = 1;',
  'packages/core/src/notes/callsApi.ts': "import '../api/router';\nexport const callsApi = 1;",
  'packages/core/src/notes/usesDesktop.ts': "import '../../../../apps/desktop/src/app/core/api';\nexport const usesDesktop = 1;",
  'packages/core/src/notes/usesTestHelper.ts': "import '../__testing__/helper';\nexport const usesTestHelper = 1;",
  'packages/core/src/notes/usesSharedInternals.ts': "import '../../../shared/src/internal';\nexport const usesSharedInternals = 1;",
  'packages/core/src/notes/usesSharedEntry.ts': "import '../../../shared/src/index';\nexport const usesSharedEntry = 1;",
  'packages/core/src/notes/noteService.test.ts': "import '../__testing__/helper';\nimport '../api/router';\nimport '../harness/claudeCli/adapter';\nexport const spec = 1;",
  'packages/core/src/__testing__/helper.ts': 'export const helper = 1;',
  'packages/core/src/api/router.ts': 'export const router = 1;',
  'packages/core/src/sessions/sessionService.ts': "import '../harness/claudeCli/adapter';\nexport const sessionService = 1;",
  'packages/core/src/harness/harness.ts': "import './claudeCli/adapter';\nexport const harness = 1;",
  'packages/core/src/harness/claudeCli/adapter.ts': 'export const adapter = 1;',
  'packages/core/src/daemon.ts': "import './api/router';\nimport './harness/claudeCli/adapter';\nexport const daemon = 1;",

  'apps/desktop/src/app/design/badge.ts': "import '../sessions/sessionList';\nexport const badge = 1;",
  'apps/desktop/src/app/sessions/sessionList.ts': "import '../shell/rightPanel';\nexport const sessionList = 1;",
  'apps/desktop/src/app/shell/rightPanel.ts': "import '../sessions/legitimateEntry';\nexport const rightPanel = 1;",
  'apps/desktop/src/app/sessions/legitimateEntry.ts': "import '../design/pure';\nimport '../core/pure';\nexport const legitimateEntry = 1;",
  'apps/desktop/src/app/design/pure.ts': 'export const pure = 1;',
  'apps/desktop/src/app/core/pure.ts': 'export const pure = 1;',
  'apps/desktop/src/app/core/api.ts': "import '../notes/noteList';\nexport const api = 1;",
  'apps/desktop/src/app/core/usesDaemon.ts': "import '../../../../../packages/core/src/notes/noteService';\nexport const usesDaemon = 1;",
  'apps/desktop/src/app/notes/noteList.ts': "import '../testing/fake';\nexport const noteList = 1;",
  'apps/desktop/src/app/testing/fake.ts': 'export const fake = 1;',
};

const EXPECTED_VIOLATIONS: Array<{ rule: string; from: string; to: string }> = [
  { rule: 'no-circular-dependencies', from: 'packages/core/src/notes/cycleA.ts', to: 'packages/core/src/notes/cycleB.ts' },
  { rule: 'no-unresolvable-imports', from: 'packages/core/src/notes/importsMissing.ts', to: './missing' },
  { rule: 'shared-never-imports-node-builtins', from: 'packages/shared/src/usesNode.ts', to: 'fs' },
  { rule: 'shared-imports-only-zod', from: 'packages/shared/src/usesWs.ts', to: 'node_modules/ws/index.js' },
  { rule: 'core-never-imports-desktop', from: 'packages/core/src/notes/usesDesktop.ts', to: 'apps/desktop/src/app/core/api.ts' },
  { rule: 'desktop-never-imports-core', from: 'apps/desktop/src/app/core/usesDaemon.ts', to: 'packages/core/src/notes/noteService.ts' },
  { rule: 'packages-are-imported-through-their-entry-point', from: 'packages/core/src/notes/usesSharedInternals.ts', to: 'packages/shared/src/internal.ts' },
  { rule: 'only-the-daemon-wires-the-api', from: 'packages/core/src/notes/callsApi.ts', to: 'packages/core/src/api/router.ts' },
  { rule: 'only-the-harness-folder-touches-the-claude-cli', from: 'packages/core/src/sessions/sessionService.ts', to: 'packages/core/src/harness/claudeCli/adapter.ts' },
  { rule: 'design-system-is-a-leaf', from: 'apps/desktop/src/app/design/badge.ts', to: 'apps/desktop/src/app/sessions/sessionList.ts' },
  { rule: 'features-never-import-the-shell', from: 'apps/desktop/src/app/sessions/sessionList.ts', to: 'apps/desktop/src/app/shell/rightPanel.ts' },
  { rule: 'app-services-import-no-feature', from: 'apps/desktop/src/app/core/api.ts', to: 'apps/desktop/src/app/notes/noteList.ts' },
  { rule: 'production-code-never-imports-test-helpers', from: 'packages/core/src/notes/usesTestHelper.ts', to: 'packages/core/src/__testing__/helper.ts' },
  { rule: 'production-code-never-imports-test-helpers', from: 'apps/desktop/src/app/notes/noteList.ts', to: 'apps/desktop/src/app/testing/fake.ts' },
];

const LEGITIMATE_SOURCES = [
  'packages/shared/src/index.ts',
  'packages/core/src/notes/usesSharedEntry.ts',
  'packages/core/src/notes/noteService.test.ts',
  'packages/core/src/harness/harness.ts',
  'packages/core/src/daemon.ts',
  'apps/desktop/src/app/shell/rightPanel.ts',
  'apps/desktop/src/app/sessions/legitimateEntry.ts',
];

interface ReportedViolation {
  rule: { name: string; severity: string };
  from: string;
  to: string;
}

const runDepcruise = ({ cwd, extraArgs = [] }: { cwd: string; extraArgs?: string[] }) => {
  const args = [DEPCRUISE_BIN, ...SOURCE_ROOTS, '--config', CONFIG, '--output-type', 'json', ...extraArgs];
  const result = spawnSync('node', args, { cwd, encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const report = JSON.parse(result.stdout) as { summary: { violations: ReportedViolation[] } };
  return report.summary.violations;
};

describe('architecture guard (dependency-cruiser)', () => {
  let fixtureDir: string;
  let fixtureViolations: ReportedViolation[];

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'arch-fixture-'));
    for (const [relativePath, content] of Object.entries(FIXTURE_FILES)) {
      const absolutePath = join(fixtureDir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content);
    }
    fixtureViolations = runDepcruise({ cwd: fixtureDir });
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('reports each rule on a fixture tree holding one violation of each', () => {
    const reported = fixtureViolations.map(({ rule, from, to }) => ({ rule: rule.name, from, to }));

    for (const expected of EXPECTED_VIOLATIONS) {
      expect(reported, `${expected.rule}: ${expected.from} → ${expected.to}`).toContainEqual(expected);
    }
  });

  it('stays silent on the legitimate imports of the fixture tree', () => {
    const offendingSources = new Set(fixtureViolations.map(({ from }) => from));

    for (const legitimateSource of LEGITIMATE_SOURCES) expect(offendingSources).not.toContain(legitimateSource);
  });

  it('ignores exactly the entries of the known-violations file, so the baseline can only shrink', () => {
    const knownViolations = JSON.parse(readFileSync(KNOWN_VIOLATIONS, 'utf8')) as unknown[];

    const realRepoViolations = runDepcruise({ cwd: REPO_ROOT, extraArgs: ['--ignore-known', KNOWN_VIOLATIONS] });

    const ignoredViolations = realRepoViolations.filter(({ rule }) => rule.severity === 'ignore');
    expect(ignoredViolations).toHaveLength(knownViolations.length);
  });
});
