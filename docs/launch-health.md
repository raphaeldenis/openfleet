# Launch health

Two checks keep a spawn from leaving a session that never starts.

- **Binary check.** Before a spawn, the daemon runs `<harness binary> --version`. A failure refuses the spawn with `harness_binary_broken` (retry `later`). The answer is cached for 60 seconds, so a repaired binary is accepted once the cache expires.
- **Launch watchdog.** When `launchOutputTimeoutMs` is set, a new session starts with `readiness: pending`. The first PTY byte moves it to `ready`. When the timeout passes with no PTY byte and no transcript progress, the readiness becomes `failed` with the reason `no_output_at_launch`, the parent session is told, and the launch is retried once on its own. The `readiness` and `readinessReason` fields are returned by the compact session view of the MCP tools.

## Known limits

- **Resume and reopen are not checked.** The binary check and the watchdog run on a new spawn only. A session that is resumed or reopened can start with a broken binary or stall without output, and its readiness is not judged.
- **A `pending` readiness survives a daemon restart.** The column is stored, but the watchdog timers live in memory. A session that is `pending` when the daemon stops stays `pending` after the restart: nothing resets it to `failed` or `ready` until it produces output and a new launch watch is armed. Read a `pending` that is older than the timeout as "unknown".
- The binary check covers the harness of the calling session when a manager spawns a child, and the harness of the spec in `create`; a harness without a binary path is not checked.
