# Phase 1 smoke checklist

Checks that need a real `claude` (subscription) and cannot run in CI (CI covers everything else via the `fake` harness in `apps/desktop/e2e/phase1.spec.ts`). The builder fills *observed* once; Raphaël re-runs it as final QA before merge.

| Check | Command or gesture | Expected | Observed |
|---|---|---|---|
| Daemon drives a real session end to end (Task 11 step 5) | `pnpm dev:core`, then `curl -X POST -H "Authorization: Bearer $(cat ~/.openfleet/admin.token)" -H 'content-type: application/json' -d '{"directory":"/tmp","name":"Smoke","emoji":"🧪","seededPrompt":"Say hello and stop."}' http://127.0.0.1:7331/api/sessions`, poll `GET /api/sessions` | State goes `starting` → `idle` (`SessionStart`) → `generating` (`UserPromptSubmit`/tool use) → `idle` (`Stop`) within ~10s | ✅ 2026-09-24, Hephaestus: ran twice against a real logged-in `claude` (scratch `OPENFLEET_HOME`, port 7333, cleaned up after). Second run showed `starting → generating (2s) → idle (4s)`, matching expected; first run's `generating` was missed by 2s polling but idle landed at 2s, well within budget. |
| Terminal renders the real Claude Code TUI (Task 14) | `pnpm dev`, create a session in a real repo directory from the sidebar, select it | The xterm pane (`data-testid="terminal"`) shows the actual `claude` TUI rendering, not blank; typing in it reaches the CLI | ✅ 2026-09-24, Raphaël, live: TUI rendered and accepted input in /tmp/of-smoke |
| A real permission gate is decided from the inbox (Task 15) | In the running session's terminal, ask Claude to run a command that is not pre-approved (e.g. `rm somefile`) | An item appears in the inbox (`data-testid="inbox-item"`) with the tool name/input; clicking Allow (`data-testid="inbox-allow"`) lets the TUI continue and the sidebar state goes `waiting_permission` → `generating` | ✅ 2026-09-24, Raphaël, live: Bash gate shown in the inbox, Allow resolved it (approvals pending → allowed), session continued |
| The Tauri app connects to the daemon under the stricter CSP (AUD-13) | `pnpm dev:core`, then `pnpm --filter @openfleet/desktop tauri dev`; in the launched app, create a fresh session and open its terminal | No CSP violation in the webview devtools console; the WS terminal connects and streams the session's real output | |

Sessions inherit the user's global Claude Code permission mode — `auto` mode suppresses gates entirely, so the inbox only sees requests when the session is in a mode that asks; a per-session `--permission-mode` override is phase 2.

## Opt-in live test

`OPENFLEET_LIVE=1 pnpm --filter @openfleet/core test:live` (or the `live` workflow, run on `main`) drives a real logged-in `claude` on the cheapest model. It spends a few real turns and leaves these local side effects:

- `~/.claude.json` gains a trust entry for each throwaway `of-live-*` repo (the entries stay).
- `~/.claude/projects` gains a transcript for each session.
- The `of-live-*` repos in the OS temp directory are removed at the end of each test.
