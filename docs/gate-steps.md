# Gate steps fail closed (GATE-FAIL-CLOSED01)

A gate that cannot tell "the check passed" from "the check never ran" is worse than no gate. The incident behind this page: a deep scan called a command that did not exist, sent its output to `/dev/null` and ended with `|| echo 0`; the gate printed `pass` on every pull request while thousands of lines were never scanned.

## What exists today

- `evaluateGateStep({ exitCode, notFound, stdout, isReportParsable? })` in `packages/shared/src/gateStep.ts` is a pure function. It returns `{ isPass: true }` only when the command was found, exited 0, printed a non-blank report and the report parses. Every other outcome is a failure with its reason: `command_not_found`, `cwd_not_found`, `no_exit_code`, `non_zero_exit` (with the code), `empty_output`, `unparsable_report`.
- `runGateStep({ file, args, cwd, timeoutMs?, env?, isReportParsable? })` in `packages/core/src/review/runGateStep.ts` runs one command with `spawn` (no shell) and returns the verdict of `evaluateGateStep`. A binary missing from `PATH` (`ENOENT`) sets `notFound`; a working directory that does not exist is `cwd_not_found`; a signal, a spawn failure such as `EACCES` or an output over 8 MiB leaves no exit code (`no_exit_code`). A test runs a binary that does not exist and expects the red verdict.
- Timeout: the command runs in its own process group. When `timeoutMs` elapses, the runner's own timer sets a `timedOut` flag, sends `SIGKILL` to the whole group (grandchildren included) and the step fails with `no_exit_code`, whatever the command printed or exited with. `SIGTERM` is never used: a command that traps it and exits 0 cannot turn a timeout into a pass.
- Environment: the command receives only `PATH` and `HOME` of the daemon plus the variables named in the optional `env`; the rest of the daemon environment stays hidden.
- Stdin is closed (`ignore`): a command that waits for input sees the end of the stream at once.
- `isReportParsable` must return exactly `true`: a promise, a string, a number, `undefined` or `null` is `unparsable_report`.
- "Blank" is judged by `isBlankText` in `packages/shared/src/isBlankText.ts`: whitespace, Unicode spaces, format characters (U+200B, U+200C, U+200D, U+2060, U+00AD, U+FEFF) and U+2800. It guards the step finding claims, the ship verdict reasons, the evidence check of the findings gate and the stdout of a gate step.
- The findings gate refuses a qe, qa, ponytail or adversarial-go line that states no evidence (`findings_required`, "<step> line has no evidence"), and the report tools refuse to write one (`invalid_body`). A clean or go line states evidence only with a claim whose status is `proven` or `plausible`: a line stored in the old text form, or with only `not_reproduced` claims, does not pass.

## What does not exist yet

Nothing calls `evaluateGateStep` or `runGateStep` in production: OpenFleet has no native playbook runner, and the imported Scape playbooks are inert archives. The first consumer is that runner: each decisive step of a playbook cell is run with `runGateStep` and recorded as a failed step, with the reason, when the verdict is not a pass.

The lint that flags `|| true`, `|| echo` and `2>/dev/null` on a decisive command of a playbook cell is deferred for the same reason: there is no cell format to lint and no definition of a decisive command. The shell scripts in `scripts/` use `2>/dev/null` on probes (`command -v`, `git rev-parse`) on purpose, so a generic lint on them would be wrong. It returns with the runner.
