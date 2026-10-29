# Changelog

The MCP tool contract of the OpenFleet server. One section per `contract_version`; the convention is in `docs/mcp-contract.md`.

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
