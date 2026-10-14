# Command-policy S0 fixtures

Real payloads and CLI outputs recorded for POLICY-GUARDS01 slice S0 (2026-10-14). Paths, ids and
tokens are redacted: working directories are `/tmp/s0/...`, session and prompt ids are numbered
placeholders, no transcript content is kept.

| File | What it records |
|---|---|
| `claude-pretooluse-session-bash.json` | `PreToolUse` of a `Bash` call by the main session (no `agent_id`) |
| `claude-permissionrequest-session-bash.json` | `PermissionRequest` for `sed 's/x/y/' <file> \| grep -n z`, main session |
| `claude-pretooluse-session-agent-tool.json` | `PreToolUse` of the `Agent` tool call that spawns a sub-agent |
| `claude-pretooluse-subagent-bash.json` | `PreToolUse` of a `Bash` call by a sub-agent (`agent_id`, `agent_type`) |
| `claude-permissionrequest-subagent-bash.json` | `PermissionRequest` issued by a sub-agent |
| `claude-permission-triggers.json` | which Bash commands make the CLI emit a `PermissionRequest`, with the text the model received |
| `claude-deny-shapes-and-model-view.json` | the three deny response shapes and the exact `tool_result` text the model got |
| `codex-test.rules` | the `.rules` file used for the execpolicy checks |
| `codex-execpolicy-check.json` | `codex execpolicy check` output for 9 commands |
| `codex-hook-vocabulary.json` | Codex hook event names, handler types, run statuses, trust statuses |

Recorded with Claude Code 2.1.296 (`claude -p`, haiku) and codex-cli 0.162.1. Headers keep only
`content-type` and `user-agent`.
