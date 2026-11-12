# Test timeouts under machine load

Vitest's default `testTimeout` is 5 s. On a loaded machine (load average 30-50, several suites running at once) the pre-push hook failed seven times on that default. This note classifies the failures and states the rule for each class.

## Classification

### (a) Tests whose budget is real time

`describeError.test.ts` ("stay fast") and `handoverLedger.qe.test.ts` (cost per prompt) already measure CPU time, best of five rounds (`packages/core/src/__testing__/linearGrowth.ts`). CPU time ignores the slices the scheduler gives to other processes, so their budgets (500 ms, 1 s, 5 ms/prompt...) do not move with load and stay untouched.
What fails under load is the test's wall-clock duration: five rounds of work plus disk I/O exceed 5 s. They belong to class (b).

### (b) Long integration tests

SQLite on disk, git, packaged imports, hostile HTTP endpoints: `backup.qe.test.ts`, `handoverLedger.qe.test.ts`, `modelsUpdateEndpoint.hostile.test.ts`, `worktrees.test.ts`, `packagedImport.test.ts`, `packagedKnowledgeImport.test.ts`, `importScape.*.test.ts`, `describeError.test.ts`.
At load 7 the slowest of them takes 2.2 s (`packagedKnowledgeImport.test.ts`, R7 cases); a 5-10x stretch under load crosses 5 s. `packages/core/vitest.config.ts` and `scripts/vitest.config.ts` set `testTimeout` and `hookTimeout` to 20 s, about 9x the slowest measured test. A real hang still fails, 20 s later.
Measured under 8 CPU burners (load average up to 38), `packagedKnowledgeImport.test.ts` R7 cases reach 4.8 s, 96% of the old budget, and `createNodeGitPort` output-cap test 3.9 s. `worktreesHostGitEnv.test.ts` already declares its own 120 s.

### (c) Concurrent recursive cleanup

`scripts/pre-push.test.ts` removed its fixture repository with `rmSync(..., { recursive: true })` in `afterEach`. A git child (auto gc, index refresh) can still write under the tree, which gives `ENOTEMPTY`. The cleanup now goes through `removeFixtureTree`, which retries (`maxRetries: 10`, `retryDelay: 100`). Each test keeps its own `mkdtemp` directory, so there is no shared directory.

## Inventory

Sweep of `packages/core/src`, `packages/shared/src`, `apps/desktop/src` and `scripts` for assertions on a duration, `vi.waitFor` and Testing Library waits with a tight timeout, and fixed ceilings on slow integration tests. Paths below are relative to `packages/core/src` unless stated otherwise.

### Fixed

| Test | Old threshold | Guarantee | Now |
| --- | --- | --- | --- |
| `mcp/spawnNotInProject.test.ts` "refuses ... directory_not_in_project" | wall `< 1000 ms` | the refusal happens before any session or launch exists | session count and harness launch count taken before the call and compared after it; no clock |
| `playbooks/kernel/secretMasker.test.ts` "does not block on 10 000 000 characters" | wall `< 1000 ms` | the scan reads at most the ceiling, whatever the input length | `expectLinearGrowth` on CPU time: 10 000 000 characters cost under 4x a text 1 character over the 262 144 ceiling |
| `playbooks/kernel/secretMasker.test.ts` "linear cost" (2 tests) | wall `< 200 ms` | linear cost on one million characters | best of 5 CPU time `< 200 ms` (`expectBestCpuUnder`) |
| `daemon.commandPolicy.test.ts` "refused in under a second" and "refused at once" | wall `< 1000 ms` x2 | an unattended child gets a refusal from the policy, never a pending approval to wait on | `pendingApprovals()` is empty (the existing `waiting_permission` assertions stay); ws frame wait ceiling is a named constant |
| `packages/shared/src/renderTemplate.hostile.test.ts` (3 tests) | wall `< 2000 ms` x3 | hostile templates and values cost bounded work | best of 5 CPU time `< 2000 ms` |
| `bootFailure.test.ts` (boots a real daemon under tsx) | spawn `30 s`, spec 20 s | a refused boot exits non-zero with one line, and a boot that never exits is cut | named ceilings 120 s (spawn) and 150 s (spec); no assertion changes |
| `mcp/findingItems.qe.test.ts` (daemon + git worktrees per spec) | 20 s config default, 8.4 s measured under load | the reports create the expected rows | named 120 s ceiling for a spec that never ends |
| `triggers/silentRunSource.daemon.test.ts` (30 s poll steps on the injected clock) | 20 s config default, measured 8.6 s | fires once after the silent minutes, not before | the clock is already injected; a named 120 s ceiling for a spec that never ends |
| `apps/desktop/src/test-setup.ts`, covering `settings.command-policy.spec.ts` and `escalation-cards.component.spec.ts` (focus) | Testing Library `asyncUtilTimeout` 1 000 ms, Vitest 5 000 ms | the awaited state appears | `waitFor` and `findBy*` ceiling 15 s, spec ceiling 30 s: both return as soon as the condition holds, they only bound one that never holds |

### Remaining, by decreasing fragility

Wall-clock upper bounds that still stand (replace by CPU time, a counter, an event order or a ratio against a reference measured in the same test). The guarantee column is read from the test name and the surrounding code, not yet checked line by line: confirm it when taking a row.

| Where | Threshold | Guarantee | Proposed fix |
| --- | --- | --- | --- |
| `api/sessionClearFollowup02.qe.test.ts:341` | second `/close` wall `< 150 ms` | a closed session answers at once, without waiting on the flush grace | boot on the fake clock and assert the answer arrives with no timer advance (bounded by a named ceiling) |
| `escalation/floorClasses.test.ts:137` | wall `< 500 ms` | classification does not blow up | `expectBestCpuUnder` |
| `import/lexicalToMarkdown.test.ts:489` | wall `< 500 ms` | linear conversion | `expectLinearGrowth` |
| `policy/commandAnalyzer.robustness.test.ts:86` | wall `< 2000 ms` | hostile commands cost bounded work | `expectBestCpuUnder` |
| `git/nodeGitPort.test.ts:115` | wall `< 2000 ms` | the output cap cuts a runaway child | assert the cap event, then a named never-ends ceiling |
| `review/runGateStep.test.ts:53` | wall `< 3000 ms` | a hung gate step is cut at its deadline | injected deadline or timer seam |
| `import/scape/scapeToolNames.test.ts:85-110` | wall `< FAST_ENOUGH_MS` x4 | linear lookup | `expectBestCpuUnder` |
| `policy/commandSecrets.test.ts:498` | wall `< MAX_MILLISECONDS` | linear scan | `expectBestCpuUnder` |
| `policy/policyEvaluator.test.ts:459` | median wall `< LENIENT_BOUND_MS` | bounded evaluation cost | `bestCpuMillisecondsOf` |
| `activity/activityMasking.test.ts:158` | wall `< MAX_MILLISECONDS` | masking cost | `expectBestCpuUnder` |
| `activity/activityRecorder.latency.test.ts:30` | mean wall per call | recording cost | CPU time per call |
| `managers/baseDrift.test.ts:126,144` | best pass wall `< LINEAR_TIME_BUDGET_MS` | linear drift check | `cpuMillisecondsToRun` |
| `usage/transcriptUsageIngestion.test.ts:315` | best wall `< BOUNDED_STOP_BUDGET_MS` | a stop is bounded | CPU time or a call counter |
| `usage/usageLedgerService.test.ts:246` | wall `< WORST_CASE_BUDGET_MS` | worst case is bounded | CPU time |
| `api/todos.test.ts:688,709` | ratio against a reference plus 100 ms | history does not slow listing | CPU time on both sides |
| `api/sessionResolvedModelRecording.test.ts:259` | wall `< half of the writer delay` | the answer does not wait for the writer | injected clock |
| `bootProcess.probe.test.ts:199` | wall `< guard + slow-machine margin` | shutdown stays inside the guard | already carries a margin; keep, or count the guard timer |
| `daemon.commandPolicyConfig.test.ts:480` | `<= 35 s` | the daemon boots | a never-ends ceiling, already generous |
| `sessions/sessionService.launchHealth.test.ts:61` | wall `< 35 s` | a launch is declared unhealthy | a never-ends ceiling, already generous |
| `logger.test.ts:945` | per-call `< LIMIT_MS` | log cost | already CPU time |

Already deterministic or on CPU time, kept: `activity/activityRecorder.retention.test.ts` (CPU and statement counts), `api/handovers.test.ts:390`, `api/workingStateRoutes.hostile.test.ts:252`, `apps/desktop/src/app/notes/notes-view.robustness.spec.ts:948,954` (CPU), `apps/desktop/src/app/onboarding/onboarding.daemon-status.spec.ts:504` (read counter), the byte and length budgets (`toBeLessThanOrEqual(BYTES)`), which are not durations.

## Rule for new tests

- A time budget measures CPU time (`expectBestCpuUnder`), never wall-clock time.
- A test that needs more than 20 s under load declares its own timeout on the `it` or `describe`, not in the global config.
- Recursive cleanup of a directory a child process may still write to retries.
