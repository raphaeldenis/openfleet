# Shared repo setting

A project can declare that its repository is shared with a team (`shared_repo`, migration 054; `PATCH /api/projects/:id` with `{ "sharedRepo": true }`, listed as `sharedRepo: true` on the project). The fleet's own tooling and findings then stay out of the team's repository.

## What the setting does

- **The overlay.** Every worktree created for the project (REST session creation, the `create_worktree` tool) gets the fleet's overlay directory, `<OpenFleet home>/overlays/<project id>/`, linked as `.openfleet-overlay` at the worktree root. Scripts and configuration the fleet needs (a test launcher, a lockfile fix, environment hygiene) live there and are never committed.
- **The exclude block.** The daemon appends one marked block (`# >>> openfleet overlay (managed)` … `# <<< openfleet overlay`) to `info/exclude` of the common git directory, so `/.openfleet-overlay` is absent from `git status` in every worktree. Nothing else in the git directory is touched, and the block is written once.
- **The backlog refusal.** An agent that is not a manager cannot insert a row into the table named "Manager backlog" of the project: the write is refused with `backlog_write_refused` (HTTP 400, retry `never`) and the message tells the agent to send the finding to its manager with `message_parent`. This covers `insert_data_store_rows` in every mode (a row that would update an existing key is an update and passes).

## What it leaves alone

- A project without the setting writes nothing: no overlay directory, no link, no exclude block, no refusal.
- Managers, humans (the desktop app and REST) and every update of an existing row are never refused.
- A worktree whose overlay could not be provided is still created; the creation carries the warning `{ type: "overlay_unavailable" }`.

## Known limits

- **The exclude file is shared.** For a linked worktree, git reads `info/exclude` of the main repository: the block applies to every worktree of that repository, including ones created before or outside OpenFleet. Turning the setting off does not remove the block.
- **The backlog is found by name.** The table is recognised by the name "Manager backlog" (trimmed, spaces collapsed, case-insensitive). Renaming the table lifts the refusal. The backlog of OpenFleet lives in the daemon's database and never reaches the team's GitHub or tracker; the refusal exists so that findings outside a ticket reach a human through the manager.
- **A manager is a session whose role is manager.** Any manager session of the project may insert, not only the one that created the table.
- **Existing worktrees are not retrofitted.** The overlay is provided at creation; a worktree made before the setting was switched on has no link.
- **No desktop switch yet.** The setting is changed through the REST API, like the row guard.
