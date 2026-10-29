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

## Rule for new tests

- A time budget measures CPU time (`expectBestCpuUnder`), never wall-clock time.
- A test that needs more than 20 s under load declares its own timeout on the `it` or `describe`, not in the global config.
- Recursive cleanup of a directory a child process may still write to retries.
