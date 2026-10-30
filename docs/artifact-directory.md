# Artifact directory

A project with a docs folder has `<docs folder>/artifacts/<manager>/`, created by the daemon. A manager, its children and their sub-agents write there with the `Write` tool without a prompt. This is the only write the daemon vouches for.

## Where the permission is granted

`ClaudePolicyHooks.onPreToolUse` (`packages/core/src/harness/claudeCli/claudePolicyHooks.ts`) asks `ArtifactDirectory.judgeWrite` (`packages/core/src/artifacts/`) after the command policy has answered. The hook answers per path, not per tool, so no `allowedTools` entry or `--add-dir` is widened.

| Call | Answer |
| --- | --- |
| `Write` inside the directory of the manager that runs the session, within the limits | `allow`, journaled `artifact_write` |
| `Write` inside that directory that breaks a limit or a path rule | `deny`, journaled `artifact_write_refused` |
| `Write` anywhere else, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`, `Read`, any `PermissionRequest` | no answer: the policy and the approval flow decide, as before |
| `Write` the policy refuses (for example into a `.git` directory) | the policy refusal; the artifact directory is not asked |

A judge that throws (the docs folder is gone, a read fails) gives no answer, never an `allow`.

## What is checked

- The session descends from a manager (`parentId` chain) and the manager's project has a docs folder.
- The manager name becomes one directory name: ASCII letters, digits, `.`, `_`, `-`, at most 64 characters, no leading `.` or `-`, `manager` when nothing is left.
- The path is absolute and canonical: no `..`, `.`, `//` or NUL.
- The real path of the nearest existing ancestor stays inside the manager's directory, and the target is not a symbolic link or a directory.
- The content is a string of at most `artifacts.maxFileBytes` bytes, and the artifacts of the whole project, all managers counted and an overwrite counted as a replacement, stay within `artifacts.maxProjectBytes`.

## Configuration

`config.json`, key `artifacts`:

```json
{ "artifacts": { "maxFileBytes": 1048576, "maxProjectBytes": 52428800 } }
```

Defaults are 1 MiB and 50 MiB; the ceilings are 16 MiB and 1 GiB. A value that fails the schema is ignored with a warning and the defaults apply. A per-file maximum above the quota is lowered to the quota.

## Journal

One `session_events` row per judged write: `kind` is `artifact_write` or `artifact_write_refused`; the payload carries `sessionId`, `actor` (`manager` or `child`), `agentId` for a sub-agent, `projectId`, `managerName`, `path`, and `bytes` or `reason`. A path outside the directory is not judged and not journaled.

## Limits

- The judgement and the write are not atomic: a link planted between them is not caught.
- A hard link made by a shell inside the directory is not detected.
- A write through `Bash` is not covered.
- Two manager names that differ only by characters outside the allowed set share a directory.
