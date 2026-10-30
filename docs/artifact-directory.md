# Artifact directory

A project with a docs folder has `<docs folder>/artifacts/<manager>/`, created by the daemon. The root manager of a session's lineage, its children and their sub-agents write there with the `Write` tool without a prompt. This is the only write the daemon vouches for.

## Where the permission is granted

`ClaudePolicyHooks.onPreToolUse` (`packages/core/src/harness/claudeCli/claudePolicyHooks.ts`) asks `ArtifactDirectory.judgeWrite` (`packages/core/src/artifacts/`) after the command policy has answered. The hook answers per path, not per tool, so no `allowedTools` entry or `--add-dir` is widened.

| Call | Answer |
| --- | --- |
| `Write` inside the directory of the root manager of the session's lineage, within the limits, when the policy allows the call without observing a refusal | `allow`, journaled `artifact_write` |
| `Write` inside that directory that breaks a limit or a path rule | `deny`, journaled `artifact_write_refused` |
| `Write` anywhere else, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`, `Read`, any `PermissionRequest` | no answer: the policy and the approval flow decide, as before |
| `Write` the policy refuses, asks about, or only observes a refusal for (for example into a `.git` directory) | the policy answer; the artifact directory is not asked, and an observed refusal is journaled as usual |
| `Write` whose hook body exceeds 1 MiB (see the limits below) | never reaches the judge: the normal approval flow decides |

If the lineage root is not a manager, nothing is granted.

A judge that throws (the docs folder is gone, a read fails) gives no answer, never an `allow`.

## What is checked

- The session descends from a manager (`parentId` chain) and the manager's project has a docs folder.
- The manager name becomes one directory name: ASCII letters, digits, `.`, `_`, `-`, at most 64 characters, no leading `.` or `-`, `manager` when nothing is left.
- The path is absolute and canonical: no `..`, `.`, `//` or NUL.
- The real path of the nearest existing ancestor stays inside the manager's directory, and the target is not a symbolic link, a directory, or an existing file with several hard links.
- A path outside `<docs folder>/artifacts/` is not judged and creates no folder. A non-canonical path that starts with that prefix (for instance `<docs folder>/artifacts/../specs/x.md`) is not judged either, but the manager's folder may be created on the way.
- The content is a string of at most `artifacts.maxFileBytes` bytes, and the artifacts of the whole project, all managers counted and an overwrite counted as a replacement, stay within `artifacts.maxProjectBytes`.

## Configuration

`config.json`, key `artifacts`:

```json
{ "artifacts": { "maxFileBytes": 262144, "maxProjectBytes": 52428800 } }
```

Defaults are 256 KiB and 50 MiB; the ceilings are 512 KiB and 1 GiB. Each field is checked on its own: a value that fails the schema is ignored with a warning and that field takes its default, while the other field keeps its valid value. A per-file maximum above the quota is lowered to the quota.

The per-file ceiling stays under what a hook body can carry: the daemon reads a hook body up to 1 MiB, and JSON escaping makes the body bigger than the content. A `Write` whose body is larger than that never reaches the judge and follows the normal approval flow.

## Journal

One `session_events` row per judged write: `kind` is `artifact_write` or `artifact_write_refused`; the payload carries `sessionId`, `actor` (`manager` or `child`), `agentId` for a sub-agent, `projectId`, `managerName`, `path`, and `bytes` or `reason`. A path outside the directory is not judged and not journaled.

## Limits

- The judgement and the write are not atomic: a link planted between them is not caught. A child that has `Bash` can already do the same in plain shell.
- A hard link to an existing file is refused; one created between the judgement and the write is not caught. A legitimate internal hard link (two paths inside the artifacts folder) gets the same firm `deny`, which no human approval lifts.
- A folder the quota walk cannot read (permission denied) gives no opinion: the write follows the normal approval flow, never an `allow`.
- A write through `Bash` is not covered.
- Two manager names that differ only by characters outside the allowed set share a directory.
