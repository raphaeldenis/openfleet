# Worktrees: git hooks, post-create hook, listing and removal

OpenFleet creates a git worktree per task (`create_worktree`, or `POST /api/sessions` with `repoPath` and `branchName`) under `<OPENFLEET_HOME>/worktrees`. This page covers what runs after creation and how worktrees are listed and removed.

## Starting point (`base_ref`)

`create_worktree` takes an optional `base_ref`: a branch, tag or commit sha that already exists in the repository. The new branch starts at the commit it resolves to, instead of the current HEAD of `repo_path`. A manager uses it to cut a worktree from an integration branch or from `origin/main` after a fetch.

- Only a plain spelling is accepted: letters, digits, `.`, `_`, `-` and `/`, not starting with `-` or `.`. An empty ref, a ref with whitespace or control characters, a revision expression (`main~1`, `HEAD^`, `a:b`, `@{u}`) and a ref that names no commit are refused with `invalid_body`, before anything is created.
- The ref is resolved by git with `rev-parse --verify --end-of-options` (no shell), and the worktree is cut from the resolved sha.
- `base_ref` applies to a new branch. For a branch name that already exists the call is refused with `invalid_body`: the branch keeps its own commit.
- The refusal message names neither the repository path nor the ref.
- Without `base_ref`, nothing changes.

## Git hooks directory

When the repository sets `core.hooksPath` to a relative path (husky: `.husky/_`), git looks for the hooks in that path inside each worktree. A generated, untracked directory such as `.husky/_` does not exist in a fresh worktree, and git then runs no hook at all, without any error: a push skips the pre-push checks.

Right after creating the worktree, before the post-create hook, OpenFleet copies the repository's hooks directory into it. No `pnpm install` is needed.

- Nothing is copied when the repository has no `core.hooksPath`, when the path is absolute or contains `..`, when the directory is a symbolic link or resolves outside the repository, or when the worktree already has it. Symbolic links inside the directory are not copied.
- When the repository sets `core.hooksPath` but has no such directory (nobody ran `pnpm install` there), or the copy fails, the worktree is still created and the result carries a warning:

  ```json
  { "path": "...", "branch": "task/x", "warnings": [{ "type": "hooks_path_missing", "hooksPath": ".husky/_" }] }
  ```

  It sits in the same `warnings` list as the post-create hook warnings, hooks warning first.
- In a project whose repository is shared (`docs/shared-repo.md`), the warning `{ "type": "overlay_unavailable" }` means the fleet overlay could not be linked as `.openfleet-overlay`: the overlay directory or the git exclude could not be written, or `.openfleet-overlay` already exists and does not point to the overlay.
- Worktrees that OpenFleet did not create (Scape, `git worktree add`) are not covered: check with `test -f .husky/_/pre-push` or run `pnpm install` in them.

## Setting up a fresh worktree (`scripts/worktree-setup.sh`)

The OpenFleet repository ships `scripts/worktree-setup.sh`: it runs `pnpm install --frozen-lockfile` then `pnpm exec husky` and checks that `.husky/_/pre-push` exists, so the first push of a new worktree runs the pre-push gate. `pnpm install` runs the postinstall scripts of the dependencies, and `pnpm exec husky` writes `core.hooksPath` into the git config shared by all worktrees of the repository.

**OpenFleet never runs it by itself.** A script found in a repository is not executed on worktree creation. A human wires it as the post-create hook of the OpenFleet project (see the next section): in the desktop app, the **Post-create hook** card of the Project home page, or `PATCH /api/projects/:id` with `postCreateHookScript` set to the absolute path of the script in a checkout you trust (for example `/Users/me/src/openfleet/scripts/worktree-setup.sh`), and optionally `postCreateHookTimeoutSeconds` (a `pnpm install` can need more than the default 60 s).

Why it is not automatic:

- A caller can name its own worktree as `repo_path` of `create_worktree`, and a session can write a file in that worktree. A script run from the repository would let a child session get code executed with the daemon's user and `HOME`. The project hook path comes from the admin configuration, never from a tool argument or the repository content.
- A cloned repository could carry such a script and run it, without anyone's consent, at the first `POST /api/sessions`.

Worktrees that OpenFleet did not create (Scape, `git worktree add`) never run any hook. For those, run `pnpm install --frozen-lockfile` and check `ls .husky/_` before the first push.

## Post-create hook

A project can name one script that runs in every worktree created for one of its sessions.

- Set it with `PATCH /api/projects/:id`: `postCreateHookScript` (absolute path) and `postCreateHookTimeoutSeconds` (1 to 600, default 60). `null` clears it; clearing the script clears its timeout.
- The script is validated when saved and again before each run: absolute path, a regular file, executable by the daemon user, owned by the daemon user, not writable by group or others. The path is stored in the project and is never taken from a tool argument.
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
- A failing hook never fails the creation. The result carries `warnings` only when something went wrong (a failing hook adds the following entry to the list):

  ```json
  { "path": "...", "branch": "task/x", "warnings": [{ "type": "post_create_hook_failed", "reason": "exit_nonzero", "exitCode": 3, "outputTail": "..." }] }
  ```

  `reason` is `timeout`, `exit_nonzero`, `not_executable`, `not_found`, `unsafe_permissions` (the script is not owned by the daemon user, or is writable by group or others) or `spawn_failed`. `outputTail` is the last 8 KB of the script's output with credentials masked. For `POST /api/sessions` the `warnings` are added to the response only; the stored session does not carry them.

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

## In the desktop app

The Project home page shows two cards for the open project:

- **Repositories & worktrees** lists every worktree per repository with its branch, full path, state (clean, modified, missing) and the session that uses it. A worktree that cannot be removed shows the reason in words and its Remove button is unavailable. Remove opens a confirmation that names the loss of ignored files and says the branch is kept; the entry disappears when the daemon confirms. A refusal from the daemon is shown in words and the list reloads.
- **Post-create hook** sets, changes or removes the script and its timeout, with a warning that the script runs as the daemon's user, with no shell, in every new worktree of the project.
