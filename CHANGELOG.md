# Changelog

The MCP tool contract of the OpenFleet server. One section per `contract_version`; the convention is in `docs/mcp-contract.md`.

## 9 — 2026-10-29

- TEAM-09, `create_worktree`: new optional `base_ref`, the branch, tag or commit sha the new branch starts from (default: the current HEAD of `repo_path`, unchanged). The ref must already resolve to a commit of the repository; it is checked with `git rev-parse --verify --end-of-options` and the worktree is cut from the resolved sha. Only plain branch, tag or sha spellings are accepted: an empty ref, a ref starting with `-`, a ref with whitespace or control characters, a revision expression (`~`, `^`, `:`, `@`), a range (`..`) or an unknown ref is refused with `invalid_body` before the worktree is created, and so is a `base_ref` given for a branch that already exists. The refusal names neither the repository path nor the ref.

Tools added: none.
Tools changed: `create_worktree` (input schema).
Migrations: none.

## 8 — 2026-10-29

PARITY-ARGUS-07a, automatic restart of crashed children. No tool is added; the answer of `get_argus_status` changes.

- `get_argus_status`: `manager.childAutoRestart` (boolean, default `false`) tells whether the daemon restarts a child of the manager that crashed on its own; each entry of `children` carries `restartPending` (boolean), true while the daemon waits to restart that closed child. A child waiting for its restart counts against `children_cap`.
- The `Session` view of the REST API carries the optional `restartPending` field with the same meaning; `PATCH /api/managers/:id` accepts `childAutoRestart`.
- The daemon tells the manager through its message queue, with a daemon line (no sender) that starts with `[child_restarted]`, `[child_restart_exhausted]` or `[harness_exited]`.

Tools added: none.
Tools changed: `get_argus_status` (answer shape only).
Migrations: `050_child_auto_restart`: `managers.child_auto_restart`, table `child_restarts`.

The guard test pins input schemas only, so it does not see the output fields; the pin changes only in its `contractVersion`.

## 7 — 2026-10-29

Scheduled manager events: a manager sends a message to itself at a chosen time.

- `schedule_argus_event` added: `{ message, title?, at | in_minutes }`. `at` is the user's local time without offset, `YYYY-MM-DDTHH:MM:SS` (e.g. `2026-10-31T09:30:00`); `YYYY-MM-DDTHH:MM` is accepted and reads as second 0. `at` and `in_minutes` together, a past time, an offset in `at`, a message above 8192 bytes and a 21st pending event are refused. At a clock change the platform resolves the local time silently: a time that does not exist (spring forward) lands one hour later, an ambiguous time (fall back) reads as its first occurrence.
- `list_argus_events` added: the pending events of the caller, soonest first.
- `cancel_argus_event` added: `{ event_id }`, only by the actor that scheduled the event.
- `get_argus_status` changed: the result gains `scheduled_events`, the caller's pending events (same shape as `list_argus_events`). Its input is unchanged.
- An event is delivered once through the persisted message queue as a line starting `[scheduled event …]`, distinct from `[pulse]`. It is delivered late, with `delivered late` in the line, when the app was closed at its due time. It is held while the manager is closed or paused, replayed on reopening or resuming, and waits for the end of a running turn. When the queue refuses the message, the due event stays pending and is retried 60 s later.

Tools added: `schedule_argus_event`, `list_argus_events`, `cancel_argus_event`.
Tools changed: `get_argus_status` (new output field `scheduled_events`).
Migrations: `049_argus_scheduled_events` (table `argus_scheduled_events`; down script in `packages/core/src/db/migrations-down/`).

## 6 — 2026-10-29

- PARITY-TBL-03B, `update_data_store_column`: new optional `required`, `display_column_id` / `clear_display_column_id`, `format` / `clear_format`, `config` / `clear_config`, `display_width` / `clear_display_width`, `wrap_mode` (`wrap` or `truncate`) and `wrap_max_lines`. A field is set or cleared in one call, never both; `wrap_mode` `truncate` resets the wrapping. `display_column_id` names another column of the same store (id or display name) and a column used as display column cannot be deleted (`constraint_violation`). `config` (number column only) is `{symbol (max 8 characters), decimals 0-10, ratingMax 1-10, ratingIcon (max 32 characters)}`; `display_width` is 60-1200; `wrap_max_lines` is 1-100; `format` must match the column type. A column type never changes. `required` is stored, not enforced on row writes.
- Column views (`describe_data_store`, `get_data_store`, `add_data_store_column`, `update_data_store_column`) carry `required` (only when true), `displayColumnId`, `config`, `displayWidth` and `wrap` when set. Select options accept at most 500 entries and a `color` must be `#RGB`, `#RRGGBB` or `#RRGGBBAA` (`add_data_store_column` and `update_data_store_column`). REST `PATCH /api/data-stores/:id/columns/:columnId` takes `required`, `displayColumnId`, `format`, `config`, `displayWidth` (null clears) and `wrap` `{mode, maxLines?}`.

Tools added: none.
Tools changed: `update_data_store_column` (input schema), `add_data_store_column` (option color and count), column views (output fields).
Migrations: `048_ds_column_metadata` (additive `ds_columns.required`, `display_column_id`, `config_json`, `display_width`, `wrap_mode`, `wrap_max_lines`).

## 5 — 2026-10-29

- PARITY-ACCT-01, `create_session`: new optional `config_dir`, an absolute path to an account profile directory, launched as `CLAUDE_CONFIG_DIR`. Accepted for the `claude-cli` harness only; any other harness is refused with `invalid_body` ("harness X does not support config_dir"). The path must exist, resolve (realpath) strictly under the home directory, and not be the `~/.claude` folder itself, nor `~/.openfleet` or the `OPENFLEET_HOME` folder or anything under them (compared as spelled and through realpath, so a symlinked dotfiles folder gives no way round, case-insensitively); otherwise `invalid_body`. Subfolders of `~/.claude` (for example `~/.claude/profiles/work`) are accepted. No file inside the directory is read, nothing picks a profile on the caller's behalf, and the path is never echoed. Session views (`create_session` ack, session listings) carry `configProfile`, the directory's last path segment, and never the path.

Tools added: none.
Tools changed: `create_session` (input schema and output field).
Migrations: `044_session_config_dir` (additive `sessions.config_dir` column).

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
