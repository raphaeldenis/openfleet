/**
 * Architecture rules, checked by `pnpm arch` (README: "Architecture checks").
 *
 * The code is organised by feature folder, so the rules encode the boundaries the repo really has:
 *   - packages/shared is the isomorphic wire contract (zod only) consumed by core and desktop;
 *   - packages/core: api/ is the top of the daemon, wired by daemon.ts and main.ts only;
 *     harness/harness.ts is the port and harness/claudeCli/ its adapter;
 *   - apps/desktop/src/app: design/ is a leaf, core/ holds the app-wide services, shell/ composes the features.
 *
 * Existing debt is frozen in .dependency-cruiser-known-violations.json (depcruise --ignore-known):
 * any NEW violation fails. Test code is exempt from the layering rules.
 * Known debt without a rule: the desktop features import each other in cycles (sessions <-> inbox <-> managers).
 */

const TEST_CODE = [
  '\\.(spec|test|testing|testkit|fixtures)\\.ts$',
  '/__testing__/',
  '/__fixtures__/',
  '^apps/desktop/src/testing/',
  '^apps/desktop/src/app/testing/',
  '^apps/desktop/src/test-setup\\.ts$',
  '^packages/core/src/git/testRepo\\.ts$',
  '^packages/core/src/tempDirTracker\\.ts$',
];

const CORE_SRC = '^packages/core/src/';
const CORE_COMPOSITION_ROOT = '^packages/core/src/(daemon|main)\\.ts$';
const DESKTOP_APP = '^apps/desktop/src/app/';
const DESKTOP_FEATURE_FOLDERS = 'inbox|managers|notes|onboarding|projects|sessions|settings|tables|working-state';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      comment: 'Import cycles make modules impossible to load, test or reason about in isolation.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable-imports',
      severity: 'error',
      comment: 'An import the resolver cannot follow hides its edges from every other rule.',
      from: {},
      to: { couldNotResolve: true },
    },

    {
      name: 'shared-never-imports-node-builtins',
      severity: 'error',
      comment: '@openfleet/shared is imported by the Node daemon and by the Angular app: a Node built-in would break the browser bundle.',
      from: { path: '^packages/shared/src/', pathNot: TEST_CODE },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'shared-imports-only-zod',
      severity: 'error',
      comment: '@openfleet/shared is the isomorphic wire contract: zod is its single third-party dependency.',
      from: { path: '^packages/shared/src/', pathNot: TEST_CODE },
      to: { pathNot: ['^packages/shared/src/', 'node_modules/zod/', '^zod$'] },
    },

    {
      name: 'core-never-imports-desktop',
      severity: 'error',
      comment: 'The daemon and the desktop app talk over HTTP/WS; the only code they share is @openfleet/shared.',
      from: { path: '^packages/core/' },
      to: { path: '^apps/desktop/' },
    },
    {
      name: 'desktop-never-imports-core',
      severity: 'error',
      comment: 'The desktop app reaches the daemon over HTTP/WS; the only code they share is @openfleet/shared.',
      from: { path: '^apps/desktop/' },
      to: { path: '^packages/core/' },
    },
    {
      name: 'packages-are-imported-through-their-entry-point',
      severity: 'error',
      comment: 'A package is consumed through its entry point (package.json "exports"), never through its src/ files.',
      from: { path: '^(packages|apps)/([^/]+)/' },
      to: {
        path: '^packages/([^/]+)/src/',
        pathNot: ['^packages/$2/src/', '^packages/[^/]+/src/index\\.ts$'],
      },
    },

    {
      name: 'only-the-daemon-wires-the-api',
      severity: 'error',
      comment:
        'api/ (HTTP, WebSocket) is the top of the daemon: it calls the feature services. Only the composition root (daemon.ts, main.ts) may import it; the services never call back into it.',
      from: { path: CORE_SRC, pathNot: ['^packages/core/src/api/', CORE_COMPOSITION_ROOT, ...TEST_CODE] },
      to: { path: '^packages/core/src/api/' },
    },
    {
      name: 'only-the-harness-folder-touches-the-claude-cli',
      severity: 'error',
      comment:
        'harness/harness.ts is the port and harness/claudeCli/ its adapter: the rest of the daemon talks to the port. Only harness/ and the composition root (daemon.ts, main.ts) may import the adapter.',
      from: { path: CORE_SRC, pathNot: ['^packages/core/src/harness/', CORE_COMPOSITION_ROOT, ...TEST_CODE] },
      to: { path: '^packages/core/src/harness/claudeCli/' },
    },

    {
      name: 'design-system-is-a-leaf',
      severity: 'error',
      comment: 'design/ holds presentational building blocks (badges, banners, chips): they depend on nothing above them, so they stay reusable and testable on their own.',
      from: { path: `${DESKTOP_APP}design/`, pathNot: TEST_CODE },
      to: { path: DESKTOP_APP, pathNot: `${DESKTOP_APP}design/` },
    },
    {
      name: 'app-services-import-no-feature',
      severity: 'error',
      comment: 'core/ holds the app-wide services and pure helpers (fleet API, events, theme): features depend on it, never the reverse.',
      from: { path: `${DESKTOP_APP}core/`, pathNot: TEST_CODE },
      to: { path: `${DESKTOP_APP}(${DESKTOP_FEATURE_FOLDERS}|shell)/` },
    },
    {
      name: 'features-never-import-the-shell',
      severity: 'error',
      comment: 'shell/ composes the features (lazy routes); the features, core/ and design/ never depend on it.',
      from: { path: `${DESKTOP_APP}(design|core|${DESKTOP_FEATURE_FOLDERS})/`, pathNot: TEST_CODE },
      to: { path: `${DESKTOP_APP}shell/` },
    },

    {
      name: 'production-code-never-imports-test-helpers',
      severity: 'error',
      comment: 'Test code (specs, fixtures, testkits, test setup) is for tests only: importing it from production code would ship it in the daemon or the app bundle.',
      from: { pathNot: TEST_CODE },
      to: { path: TEST_CODE },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|\\.angular|\\.worktrees)/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
    },
    combinedDependencies: true,
  },
};
