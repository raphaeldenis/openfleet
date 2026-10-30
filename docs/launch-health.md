# Launch health

Two checks keep a spawn from leaving a session that never starts.

- **Binary check.** Before a spawn, the daemon runs `<harness binary> --version`. A failure refuses the spawn with `harness_binary_broken` (retry `later`). The answer is cached for 60 seconds, so a repaired binary is accepted once the cache expires.
- **Launch watchdog.** When `launchOutputTimeoutMs` is set, a new session starts with `readiness: pending`. The first PTY byte moves it to `ready`. When the timeout passes with no PTY byte and no transcript progress, the readiness becomes `failed` with the reason `no_output_at_launch`, the parent session is told, and the launch is retried once on its own. The `readiness` and `readinessReason` fields are returned by the compact session view of the MCP tools.

## Start signal timeout

A new session waits for the harness's start signal (the `SessionStart` hook). The wait is `firstStartTimeoutMs` of the daemon when it is set, else `startSignalTimeoutMs` of the harness, else 60 seconds. A harness with no start signal of its own keeps that default and is judged like any other (the `fake` harness included: its tests report `SessionStart` themselves).

When the delay passes with no signal:

- the readiness becomes `failed` with the reason `no_start_signal`, whatever it was before (a PTY byte alone no longer keeps it `ready`);
- the daemon sends `session.failed` (`sessionId`, `reason`, `detail`) on the WebSocket and `session.updated`;
- `detail` is the last 2 KiB of the harness output, without terminal escape sequences and with secrets masked. It is also the `readinessDetail` of the session in REST, WebSocket and the compact MCP view, where a "hook failed" line of the harness shows up;
- the process is stopped and the session is closed with the close reason `resume_timeout` (the reason of the close when somebody requested one meanwhile, unless the daemon stops in the meantime: then it stays `resume_timeout`);
- the session counts against the `children_cap` of its manager until the process is gone and the session is closed, which takes up to 5 seconds when the process ignores the first kill; during that window two processes of the manager can be alive. A process that survives the force kill too is given 10 more seconds (`forceKillGraceMs`, injectable). This grace applies to every `close()` and to the relaunch after a model change, not only to this timeout: after the SIGKILL and the grace the session is closed even though the process may still be running (a relaunch closes it with the reason `launch_failed` instead of resuming the conversation next to a survivor), and the daemon logs a warning with the code `kill_failed` and the session id (no pid: the handle does not expose one). Once a process is replaced or its session closed, its output is dropped. Then the next `create_session` is accepted;
- a `SessionStart` or a PTY byte arriving later changes nothing: the session stays `failed` and closed.

The timer is cancelled by any real state transition out of `starting` (the `SessionStart` is the usual one) and when the session closes. `readinessDetail` lives in the daemon's memory: a daemon restart forgets it, the `failed` readiness and the close reason stay in the database. Resuming the session at boot or reopening it clears a `failed` readiness.

## Known limits

- **Resume and reopen are not checked.** The binary check and the watchdog run on a new spawn only. A session that is resumed or reopened can start with a broken binary or stall without output, and its readiness is not judged.
- **A `pending` readiness survives a daemon restart.** The column is stored, but the watchdog timers live in memory. A session that is `pending` when the daemon stops stays `pending` after the restart: nothing resets it to `failed` or `ready` until it produces output and a new launch watch is armed. Read a `pending` that is older than the timeout as "unknown".
- The binary check covers the harness of the calling session when a manager spawns a child, and the harness of the spec in `create`; a harness without a binary path is not checked.
