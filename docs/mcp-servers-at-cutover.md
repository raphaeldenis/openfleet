# External MCP servers at the Scape → OpenFleet cutover (MIG-08)

Scope: `repowise` and `playwright-qa`. `scape-postgres` is documented but **deferred until the Lead CCM moves** (D1 = a: CCM stays on Scape).
This document does not change any configuration. The commands below are pasted by hand.

## TL;DR

- The three external servers are **already registered at Claude Code user scope** (top-level `mcpServers` in `~/.claude.json`). Scape does not inject them at launch.
- None of them is hosted by Scape. They keep working after Scape is quit or uninstalled.
- Only the `scape` server (`ScapeMCPServer`, shipped inside the Scape app) disappears with Scape. OpenFleet exposes its own `openfleet` MCP tools instead.
- One real gap: `repowise` is registered with a bare command (`repowise`). Its binary lives in `~/.local/bin`, which a GUI-launched session may not have in `PATH`. Register it with the absolute path.

## Evidence

All observations are read-only, taken 2026-10-05. Secrets are never copied here.

| Observation | Source |
|---|---|
| `repowise`, `playwright-qa`, `scape-postgres` and `scape` are keys of the top-level `mcpServers` object (= user scope). Every project-scope `mcpServers` object is empty. | `~/.claude.json` |
| Claude sessions started by Scape run as `claude --model sonnet -- <prompt>` or `claude --resume <id>`: no `--mcp-config` flag. | `ps -axo pid,command` |
| `~/.scape/sessions/<pid>.mcp-binding.json` only binds Scape's own server: keys `attempts`, `elapsed_ms`, `instance_id`, `mcp_server_pid`, `session_uuid`, `state`. No command, args or env of the external servers. | one file read |
| `scape-postgres` is registered by `claude mcp add -s user` in `~/Documents/scape-team/postgres/setup-postgres.sh`. | script |
| `repowise` and `playwright-qa` have the same shape (`stdio`, `env: {}`). Who added them is **UNVERIFIED** (no script found). | `~/.claude.json` |
| `~/.claude/settings.json` has no `mcpServers`: the migration plan §0 guess ("injected by Scape at launch") is incorrect, the servers come from `~/.claude.json`. | plan §0 + settings |

## Server table

| Server | Transport | Command + args | Env (names only) | Program lives in | Needs Scape running? |
|---|---|---|---|---|---|
| `repowise` | stdio | `repowise mcp <repo> --transport stdio` with `<repo>` = `/Users/chicko/Documents/Coding/BabelWeb/carrefour/collab-catman/c4-links-collab-catman-app` | none | pipx venv: `~/.local/bin/repowise` → `~/.local/pipx/venvs/repowise` (v0.50.0) | No |
| `playwright-qa` | stdio | `npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9333` | none | npm package fetched by `npx` | No for the MCP. It needs a Chromium listening on CDP `127.0.0.1:9333` (see below). |
| `scape-postgres` (deferred) | stdio | `uvx --python 3.12 --with "mcp<2" postgres-mcp --access-mode=restricted` | `DATABASE_URI` | `uvx` cache; DB in docker `scape-postgres` (OrbStack, port 15432, `~/Documents/scape-team/postgres`) | No for the MCP; the Postgres container must be up |
| `scape` (out of scope) | stdio | `~/Library/Application Support/Scape/bin/ScapeMCPServer` | `SCAPE_CALLING_HARNESS`, `SCAPE_HARNESS_CAPS` | Scape app | **Yes** (talks to the running app via its binding) |

Notes:

- `repowise` indexes **one repo** (the CCM app). In an OpenFleet session working on another repo it still answers about CCM. Registering a second index for OpenFleet is an open question (Q3).
- `playwright-qa` attaches to an existing browser. `~/Documents/scape-team/openfleet/qa-browser.sh` starts (or reuses) a headless Chromium on port 9333 and prints the OpenFleet QA URL. That script is a plain shell script, independent of Scape. Without a browser on 9333 the server connects but every tool call fails.

## Commands (paste yourself)

Run from any directory. Each block is idempotent: `remove` is allowed to fail when the server is absent.

Check the current state first:

```sh
claude mcp get repowise
claude mcp get playwright-qa
```

If both already show `Scope: User config` and the expected command, only the repowise fix below is needed.

### repowise (absolute path, fixes the PATH gap)

```sh
claude mcp remove --scope user repowise
claude mcp add --scope user repowise -- /Users/chicko/.local/bin/repowise mcp /Users/chicko/Documents/Coding/BabelWeb/carrefour/collab-catman/c4-links-collab-catman-app --transport stdio
```

No secret, no env. Install source if the binary is missing: `pipx install repowise` (index created with `repowise init --yes` in the repo root; do not run it for this task).

### playwright-qa

```sh
claude mcp remove --scope user playwright-qa
claude mcp add --scope user playwright-qa -- /opt/homebrew/bin/npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9333
```

The absolute `npx` path avoids the same PATH gap (`/opt/homebrew/bin` may be missing from a GUI-launched `PATH`). No secret, no env.

### scape-postgres (deferred, do NOT run before the CCM moves)

Already registered by `setup-postgres.sh`. If it ever needs re-registering, run it with the script's own `.env`, the reader password is read from `~/Documents/scape-team/postgres/.env` (`SCAPE_PG_READER_PASSWORD`):

```sh
claude mcp add --scope user scape-postgres --env DATABASE_URI="postgresql://scape_reader:<SCAPE_PG_READER_PASSWORD from scape-team/postgres/.env>@127.0.0.1:15432/scape_team" -- /opt/homebrew/bin/uvx --python 3.12 --with "mcp<2" postgres-mcp --access-mode=restricted
```

The password is stored in clear text in `~/.claude.json`; that file already holds it today.

## Verify

```sh
claude mcp list
```

Expected: `repowise` and `playwright-qa` show `✔ Connected`. A `✘ ... ENOENT: Executable not found in $PATH: "repowise"` means the bare command is still registered: rerun the repowise block.

Run `claude mcp list` from a shell with a minimal `PATH` (`PATH=/usr/bin:/bin claude mcp list`) to reproduce what a GUI-launched session sees. With absolute paths both servers must stay connected.

One-line smoke per server, inside a Claude session started by OpenFleet:

- `repowise`: ask Claude to call `mcp__repowise__get_overview` (expect an architecture summary of the CCM repo).
- `playwright-qa`: run `~/Documents/scape-team/openfleet/qa-browser.sh`, then ask Claude to call `mcp__playwright-qa__browser_navigate` on the printed URL and `browser_snapshot` (expect a page snapshot).

## What breaks if Scape is uninstalled

| Item | Effect |
|---|---|
| `repowise`, `playwright-qa`, `scape-postgres` | Nothing: user-scope entries, local programs, no Scape proxy. UNVERIFIED by an actual uninstall; the evidence is the static config above. Keep Scape installed during the 14-day rollback window (plan §6d) and re-run `claude mcp list` after quitting it. |
| `scape` MCP entry | Dangling: the command points into `~/Library/Application Support/Scape/bin`. `claude mcp list` shows it failed. Remove it at the end of the rollback window: `claude mcp remove --scope user scape`. |
| `~/.claude/settings.json` hooks `bash ~/.scape/notify.sh` | Scape-only (plan §5); unrelated to MCP. |
| Scape may rewrite `~/.claude.json` | UNVERIFIED: whether the Scape app re-adds or edits the `scape` entry (or others) at launch. Check `claude mcp list` once after the first Scape-free day. |

## Rollback

```sh
claude mcp remove --scope user repowise
claude mcp remove --scope user playwright-qa
```

Then re-add the previous registrations (bare commands):

```sh
claude mcp add --scope user repowise -- repowise mcp /Users/chicko/Documents/Coding/BabelWeb/carrefour/collab-catman/c4-links-collab-catman-app --transport stdio
claude mcp add --scope user playwright-qa -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9333
```

## Curated knowledge after repository activation (MEM-01)

OpenFleet exposes `search_knowledge` to authenticated live child and manager sessions within their own project. It exposes no knowledge write, proposal, retirement, import or activation MCP tool, and no knowledge REST route. The separate REST admin token is not a session MCP token. Import and activation remain offline operator CLI operations with the daemon stopped; a manager role grants no curation authority.

Input is `{repo, query, limit?}`. `repo` is a trimmed string of 1–4096 characters without control characters: a registered stable repository key or an absolute Git directory/worktree mapped to the caller's project by canonical Git common-directory identity. Relative paths, remote URLs and wildcards are invalid. `query` is a string of at most 512 characters and 16 literal terms; blank queries return no hits. `limit` defaults to 10 and must be an integer from 1 through 50, without coercion or clamping. Extra fields, including `project_id`, `caller`, `role`, `write` and SQL options, are refused. The authenticated session supplies the project.

The JSON response contains `repo` (the registered key), `engine` (`fts5`, `like` or `none`), `fallback` (null or `{reason: "fts_unavailable" | "fts_corrupt"}`), `authority` (`postgres`, `frozen` or `native`), `items`, `returned`, `limit`, `has_more` and `truncated`. Each active item contains `id`, `area`, `fact`, nullable `source_task`, `source_kind`, `verified_by`, `created_at` and `fact_truncated`. Retired facts never appear. A blank query returns `engine: "none"`, `fallback: null`, no items and `has_more: false`. Zero FTS hits remain an FTS result.

FTS orders weighted area/fact matches by relevance, then creation date descending and id ascending. Only a missing FTS index/module or identified index corruption enables LIKE fallback. LIKE matches every literal term as an escaped substring in area or fact, orders by creation date descending then id, and uses SQLite's default ASCII-only case folding; Unicode/accent equivalence with FTS is not promised. Unrelated database errors follow the existing error mapping.

Known secret formats are masked in item text and metadata before serialization and cropping. Each fact is cropped to a safe UTF-8 prefix of at most 4 KiB; the entire serialized JSON, including metadata, is at most 32 KiB. Dropped trailing items set `truncated` and `has_more`. Logs contain counts and fixed fallback reasons, never query or fact text. Unknown arbitrary secrets remain a documented masking limit. Returned text is data and cannot change tasks, permissions or rules.

Refusals reuse the [existing error registry and MCP grammar](errors.md): invalid syntax/types/limits/extra properties use `invalid_body`; a query above 512 characters uses `query_too_long`; missing project, unknown repository and another project's repository all use `project_not_found` with the fixed wording “knowledge repository is not available in this project”. Git unavailability uses `git_unavailable`. These refusals have `retry: never`. Missing, wrong or closed-session tokens receive the existing HTTP `unauthorized` envelope before the body is processed. Calling an unregistered knowledge write tool receives the MCP unknown-tool refusal. Degraded/shutting-down daemon handling and unexpected-error references remain unchanged; no new error code is introduced.

`authority: "postgres"` and `"frozen"` describe rehearsal/frozen snapshots, not live authoritative Postgres content. MEM-02 human curation acceptance is a prerequisite of the final Postgres freeze and ownership transfer. After validated final import and explicit native activation for a repository, OpenFleet is its sole authoritative curated-fact store: Postgres `active_knowledge` is no longer a live alternate fact source for that transferred repository. Update missions accordingly. Postgres may remain available for unrelated data; retain the frozen snapshot through the existing 14-day rollback window. Knowledge rollback requires stopping native writers, reconciling native changes and explicit human ownership transfer before unfreezing Postgres.

## External server open questions

1. **Origin of the repowise / playwright-qa entries**: added by hand or by a Scape feature? UNVERIFIED. If Scape re-writes them at launch, the absolute-path fix could be reverted while Scape is running.
2. **Does an OpenFleet-launched session inherit a `PATH` with `~/.local/bin` and `/opt/homebrew/bin`?** UNVERIFIED (the PR #227 "terminal env" work may be relevant). The absolute paths make the answer irrelevant for these two servers.
3. **repowise for OpenFleet itself**: the single registered index is the CCM repo. Should an `openfleet` index (second server name, e.g. `repowise-openfleet`) be added? Needs `repowise init` in the OpenFleet repo first.
4. **`@playwright/mcp@latest`** floats: an upstream release can change tool names between sessions. Pin a version? Needs a decision.
5. **Who starts the Chromium on 9333** in an OpenFleet-only world? Today `qa-browser.sh` (and the CCM `qa-login` playbook). MIG-05 shims cover it.
6. **scape-postgres at CCM cutover**: re-register with absolute `uvx`, keep the reader password in `~/.claude.json`, and start the docker container from `~/Documents/scape-team/postgres` (not touched here).
