# Changelog

The MCP tool contract of the OpenFleet server. One section per `contract_version`; the convention is in `docs/mcp-contract.md`.

## 4 — 2026-10-29

- PARITY-TBL-08, `list_row_changes`: optional `store` (id or display name, same resolution as the other table tools), `kind` (`insert`, `update` or `delete`), `since` (a `seq`; keeps the entries after it) and `order` (`desc` by default, or `asc` by `seq`). Each entry gains a stable integer `seq`. Without the new parameters the order (newest first) and the entry shape (plus `seq`) are unchanged. `seq` is global to the history table, increases with every recorded change and is never renumbered nor reused.

Tools added: none.
Tools changed: `list_row_changes` (input schema and output field).
Migrations: `043_ds_row_history_seq.sql`: rebuilds `ds_row_history` with an `INTEGER PRIMARY KEY AUTOINCREMENT` `seq`, numbering existing entries in their current reading order. No data loss.

## 3 — 2026-10-29

- SPAWN-LAUNCH-HEALTH01, every tool that returns a compact session (`get_session_status`, `spawn_session` and the listings): the session carries `readiness` (`pending`, `ready` or `failed`) and `readinessReason` (`no_output_at_launch`) when set.
- `spawn_session` refuses a harness binary that fails `--version` with `harness_binary_broken`, and a directory that belongs to no project of the caller with `directory_not_in_project`. Both are error codes, not input changes.

Tools added: none.
Tools changed: the compact session returned by the session tools (output fields only; no input schema changes).
Migrations: 041 (`sessions.readiness`, `readiness_reason`, `launch_retries`).

The guard test pins input schemas only, so it does not see the output fields; the pin changes only in its `contractVersion`.

## 2 — 2026-10-29

Each batch that adds or changes a tool while the version is 2 appends its lines here.

- P1, `get_argus_status` and `get_session_status`: `pendingPermission` carries a new `input` field next to `toolName` and `ageSeconds`: the first word of a Bash command (never its arguments), the file path for file tools, or the compact form of the tool input, on one line, masked by `maskedSecrets` and capped at 200 characters plus a truncation marker. `get_session_status` returns `pendingPermission` only while an approval is pending. The silent-block message sent to a manager names the tool and carries the same `input`.

- CHILD-FILE-WRITE-TOOL01: the manager base template moves to version 3 (a change to the template contract, not to a tool): section §9 tells managers that file writes go through the `Write` and `Edit` tools. No MCP tool changes, so `contract_version` stays 2.

Tools added: none.
Tools changed: `get_argus_status` and `get_session_status` (output field only; no input schema changes).
Migrations: none.

The guard test pins tool names and input schemas only, so it does not see an output field. Raising the version for P1 is a convention, not something the guard enforces.

## 1 — 2026-10-29

First numbered version. Each batch that adds or changes a tool while the version is 1 appends its lines here.

- `contract_version` introduced: announced in the MCP server `instructions` and returned by `get_argus_status` (new `contract_version` field).

Tools added: none yet.
Tools changed: none yet.
Migrations: none.

## Before numbering

Versions before 1 are not numbered. This section gathers, in one place, the tools added or changed before `contract_version` existed, from the history of `main`:

- `get_note`: responses capped at a safe size, with a mentions index and byte-offset pages.
- `bootstrap_project_profile`: equips a manager's project in one idempotent call.
- `create_session`: optional per-harness `effort`, validated and persisted.
- `set_manager_profile`: a manager sets its own expertise and pulse actions.
- `propose_law`, `withdraw_proposal`, `propose_permission`, `request_resource_access`, `get_argus_governance`: governance queue, with a waiting list for surplus proposals.
- `report_ship_verdict` and `report_step_finding`: review findings and the ship gate.
- Worktree tools (`create_worktree`, `list_worktrees`, `remove_worktree`) and working state tools (`get_working_state`, `update_working_state`).
- `search_knowledge`, note version tools (`list_note_versions`, `get_note_version`, `restore_note_version`), and the data store view and column tools.

Migrations before numbering are in `packages/core/src/db`.
