# Worktrees: post-create hook, listing and removal

OpenFleet creates a git worktree per task (`create_worktree`, or `POST /api/sessions` with `repoPath` and `branchName`) under `<OPENFLEET_HOME>/worktrees`. This page covers what runs after creation and how worktrees are listed and removed.

## Post-create hook

A project can name one script that runs in every worktree created for one of its sessions.

- Set it with `PATCH /api/projects/:id`: `postCreateHookScript` (absolute path) and `postCreateHookTimeoutSeconds` (1 to 600, default 60). `null` clears it; clearing the script clears its timeout.
- The script is validated when saved and again before each run: absolute path, a regular file, executable by the daemon user, not writable by group or others. The path is stored in the project and is never taken from a tool argument.
- Which project's hook runs: the caller's own project for `create_worktree`, the `projectId` of the request for `POST /api/sessions`. No project, no hook.
- The script runs as the daemon's user, with the new worktree as its working directory, no shell and no argument. It gets the daemon's basic environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TMPDIR`, `SHELL`) and nothing else from the daemon, plus:

  | Variable | Value |
  | --- | --- |
  | `OPENFLEET_WORKTREE_PATH` | the new worktree |
  | `OPENFLEET_BRANCH` | its branch |
  | `OPENFLEET_REPO_PATH` | the repository it was created from |
  | `OPENFLEET_PROJECT_ID` | the project id |

  The values are data: quote them in the script.
- At the timeout the script and every process it started are killed.
- A failing hook never fails the creation. The result carries `warnings` only when something went wrong:

  ```json
  { "path": "...", "branch": "task/x", "warnings": [{ "type": "post_create_hook_failed", "reason": "exit_nonzero", "exitCode": 3, "outputTail": "..." }] }
  ```

  `reason` is `timeout`, `exit_nonzero`, `not_executable`, `not_found`, `unsafe_permissions` or `spawn_failed`. `outputTail` is the last 8 KB of the script's output with credentials masked. For `POST /api/sessions` the `warnings` are added to the response only; the stored session does not carry them.

## Listing

`GET /api/projects/:id/worktrees[?q=text]` lists the worktrees of the project's repositories, the main one first. A project has no repository list of its own yet: its repositories are the git repositories its sessions (in any state) work in. A project with no session lists nothing. `q` keeps the worktrees whose repository, branch or path contains the text, in any case.

Each entry: `repoPath`, `path`, `branch` (`null` when detached), `head`, `isMain`, `isDetached`, `isLocked`, `isPrunable`, `isDirty`, `isInUse`, `inUseBySessionId`, `isUnderWorktreesRoot`, `removable` and, when it is not removable, `notRemovableReason`.

The MCP tool `list_worktrees` lists the worktrees of the caller's own repository.

## Removal

`DELETE /api/projects/:id/worktrees?path=<absolute path>` and the MCP tool `remove_worktree` (managers and root sessions only, own repository only) remove one worktree and answer `{ removed, branch, ignoredFileCount }`.

Removal never forces, so git re-checks the working tree at the last moment, and it never deletes the branch: the commits stay on it, and `create_worktree` on the same branch name brings it back.

It refuses, and leaves everything in place, when the worktree:

| Reason | Meaning | Error |
| --- | --- | --- |
| `in_use` | a session that is not closed works in it or in a subdirectory | `directory_in_use` (409) |
| `main` | it is the main worktree of the repository | `constraint_violation` (400) |
| `outside_root` | it is not under the daemon's worktrees root | `constraint_violation` |
| `missing` | its directory is gone (prune it with git) | `constraint_violation` |
| `locked` | `git worktree lock` is set | `constraint_violation` |
| `detached` | HEAD is detached: its commits would be lost | `constraint_violation` |
| `dirty` | uncommitted, staged or untracked files | `constraint_violation` |
| `status_failed` | `git status` failed or timed out: not provably clean | `constraint_violation` |
| `submodules` | it holds initialized submodules | `constraint_violation` |
| `removal_refused` | git refused after the checks passed (the worktree changed meanwhile) | `constraint_violation` |

`constraint_violation` answers carry `detail.reason`; the MCP error text names it as `(reason: dirty)`. A path that is not a worktree of the project's repositories answers `not_found` and nothing is deleted.

**Ignored files are not protected.** Files git ignores (`node_modules`, `.env`, build output) do not make a worktree dirty and are deleted with it. `ignoredFileCount` in the result says how many went.
