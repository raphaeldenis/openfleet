# Secrets

**In brief.** The repository holds one named GitHub secret: `CLAUDE_CODE_OAUTH_TOKEN`, in the GitHub Environment `live`, read only by the manual `live` workflow (`.github/workflows/live.yml:8-10`, `live.yml:41`). The `ci` workflow reads no secret (`.github/workflows/ci.yml`, whole file). On a developer's machine the only secret OpenFleet creates is the daemon's `admin.token` file. This page names places and variables and never gives a value. It describes what the code and workflows do; what only GitHub knows is marked UNVERIFIED with a command, and what is not decided is marked "à décider par Raphaël".

## Where each secret lives

| Name | Where | Who reads it | Source |
|------|-------|--------------|--------|
| `CLAUDE_CODE_OAUTH_TOKEN` | GitHub Environment `live`, "Environment secrets" | the single step `pnpm --filter @openfleet/core test:live` of job `live-smoke` | `live.yml:8-10`, `live.yml:24`, `live.yml:39-41` |
| `admin.token` | file `<OPENFLEET_HOME>/admin.token` (default `~/.openfleet/admin.token`), mode `0600` | the daemon, and the desktop app, which reads it by itself | `packages/core/src/config.ts:34`, `config.ts:48-52`; `apps/desktop/src-tauri/src/admin_token.rs:8-10`; `apps/desktop/src/app/onboarding/daemon-step.component.ts:72` |

No other secret name appears in `.github/workflows/`. `ci.yml` declares `permissions: contents: read` (`ci.yml:7-8`); so does `live.yml` (`live.yml:18-19`).

## The `live` environment

- The workflow is opt-in. It never runs on push or pull request. It starts from the Actions tab ("Run workflow") on `main` through `workflow_dispatch` (`live.yml:2`, `live.yml:11-12`).
- The job declares `environment: live` (`live.yml:24`). The token is passed in `env` of the test step only; checkout uses `persist-credentials: false` (`live.yml:27-28`, `live.yml:39-41`).
- The workflow comment states the one-time setup, done by a repository admin (`live.yml:5-10`):
  1. Settings → Environments → New environment `live`.
  2. In `live`, "Deployment branches and tags": selected branches and tags, `main` only.
  3. In `live`, "Environment secrets": add `CLAUDE_CODE_OAUTH_TOKEN`, a long-lived token created on a logged-in machine with `claude setup-token`.
- The run spends real subscription turns of the account that issued the token (`live.yml:3`; `docs/phase1-smoke.md:16`).

## Rotation

No rotation policy, schedule or owner is written anywhere in the repository: **à décider par Raphaël.**

The mechanics the code supports:

- `CLAUDE_CODE_OAUTH_TOKEN`: the setup comment names the way to create one, `claude setup-token` on a logged-in machine (`live.yml:8-9`). Replacing it means adding a new value under the same name in the `live` environment. The workflow reads the secret by name and needs no change.
- `admin.token`: the daemon creates it when the file is missing. A token shorter than 32 characters stops the daemon, and its error says to delete the file to have OpenFleet generate a new one (`packages/core/src/config.ts:40-46`, `config.ts:51-53`). The token is local to one machine's OpenFleet home.

## Who merges, who publishes

- **Merge.** The default policy is human: an agent opens a draft pull request, a person marks it ready and merges. A project may opt in to merging on green checks through a law or a written mandate; OpenFleet does so today through Capitaine's merge law (`docs/adr/0003-merge-policy-human-by-default.md:8`). That law lives in the Scape fleet, not in this repository.
- **Required checks and branch protection.** None is defined in the repository. UNVERIFIED. A human can read them with `gh api repos/{owner}/{repo}/branches/main/protection`.
- **Who may merge or push to `main`.** UNVERIFIED. Check collaborators and roles with `gh api repos/{owner}/{repo}/collaborators --jq '.[] | {login, role_name}'`.
- **Publish.** A release is two local, ad-hoc signed dmgs built on the maintainer's Mac. Nothing is uploaded, notarized or auto-updated (`RELEASING.md:3`). Tag and push of `main` are done by the maintainer with the commands `prepare.mjs` prints (`RELEASING.md:46-49`). Publication target, signing identity and notarization: open decision RELEASE01, **à décider par Raphaël** (`RELEASING.md:5`, `RELEASING.md:53`).

## What never enters the repository

- Tokens, passwords and `.env` files are never committed. `*.db`, `*.db-journal`, `*.db-wal`, `*.db-shm`, `.mcp.json` and `.claude/settings.local.json` are gitignored (`docs/house-rules.md:7`; `.gitignore:3-6`, `.gitignore:14`, `.gitignore:19`).
- No `.claude/settings.json` and no auto-approve hook ships; an autonomous session is a local opt-in through your own `.claude/settings.local.json` (`README.md:160-162`).
- Daemon logs carry no token and no hook URL (`docs/house-rules.md:9`).

## Masking and redaction

- The daemon masks secrets in error envelopes and structured logs with one shared rule (`packages/core/src/redact.ts:1`). It hides any value under a key matching `token|secret|authorization|password|cookie|ticket|api[_-]?key` unless the value is a finite number (`redact.ts:11`, `redact.ts:14`), and masks as `***` (`redact.ts:15`). The ceilings it leaves readable are at `redact.ts:3-8`.
- Known secret formats in a session's todo text are masked before the text leaves the daemon (`README.md:39`).
- The desktop log and the support bundle (Settings → Diagnostics) are rebuilt from an allowlist; free text becomes `[text:<len>:<tag>]` with a bucketed length (`CHANGELOG.md:20-24`).
- A `redaction-audit` check does not exist in this repository: no script, workflow job or document of this repo carries that name. The rule of `redaction-audit : pass` belongs to the manager of openfleet-kb and is not visible here. UNVERIFIED for this repository; the masking tests run with `pnpm test`, which `ci.yml:75` runs.

## UNVERIFIED, with the command a human can run

| Question | Command |
|----------|---------|
| Is the environment `live` present, and which branches may deploy to it? | `gh api repos/{owner}/{repo}/environments/live` |
| Is `CLAUDE_CODE_OAUTH_TOKEN` set in `live` (name and date, never the value)? | `gh api repos/{owner}/{repo}/environments/live/secrets --jq '.secrets[] | {name, updated_at}'` |
| Are there repository-level secrets? | `gh secret list --repo {owner}/{repo}` |
| Is `main` protected, with which required checks? | `gh api repos/{owner}/{repo}/branches/main/protection` |
| Who has which role? | `gh api repos/{owner}/{repo}/collaborators --jq '.[] | {login, role_name}'` |
| Is private vulnerability reporting enabled? | `gh api repos/{owner}/{repo}/private-vulnerability-reporting` |

Open decisions, all for Raphaël: rotation policy and owner of `CLAUDE_CODE_OAUTH_TOKEN`, security reporting channel (see [SECURITY.md](../SECURITY.md)), RELEASE01 (publication and signing).

## Secrets of playbooks

A playbook, an integration connection or a trigger declares the names of the secrets it needs. A human sets the values; no agent can set or read one. The daemon stores the **names and a status** (`stored` or `missing`) in `secret_refs` (migration 065) and never a value: not in SQLite, not in a log, not in an activity row, not in a backup or a diagnostics bundle.

### Who can do what

| Action | Human (desktop app) | Agent (MCP) |
|---|---|---|
| Set a value | yes: `PUT /api/secrets/:scopeKind/:scopeId/:name`, admin token **and** an operator nonce | no tool exists |
| Clear a value | yes: `DELETE`, same two proofs | `clear_playbook_secret` (destructive) |
| Read the status | yes: `GET` | `list_playbook_secret_statuses` (`stored` or `missing` only) |
| Read a value | no route | no tool; only the runner of a playbook resolves one, in the daemon, for the length of a run ([docs/playbook-runs.md](playbook-runs.md)) |

A scope is known when a name is declared under it. An unknown scope answers `404 secret_scope_not_found`, an undeclared name `404 secret_not_declared`. A declared name with no value in the keychain of this device fails at resolution with `secret_not_connected_on_this_device` ("the secret NAME is not connected on this device"). A value under 8 characters is refused (`400 secret_too_short`): the masker of a run could not mask it without destroying the output.

### Where the value lives: the keychain of the desktop app

The macOS keychain is read and written by the **desktop app** (Security framework through the `security-framework` crate), never by the daemon. The daemon is the sidecar of the app. Values and requests travel **only on the two private pipes of the sidecar**: the daemon's stdout towards the app, the daemon's stdin from the app. There is no network hop and no route: a pipe cannot be taken over by another process, and only the app holds the writing end of the stdin. (An earlier design answered over HTTP on `127.0.0.1:7331`; a process of the same user could take the port back from a killed sidecar. That design is gone, and no `/internal` route exists.)

Without the app (a daemon started from a shell), with a locked keychain or when the app does not answer in time, a set, a clear and a resolve fail with the typed error `secret_store_unavailable`; the daemon keeps no copy on disk to fall back to.

Every line of the channel starts with `OPENFLEET_SECRETS ` followed by one JSON object. In the order of a request:

1. **Operator nonce (set and clear from the UI).** The webview calls the Tauri command `mint_operator_nonce(action, scope_kind, scope_id, name)`. The command draws a random nonce and writes it to the stdin of the sidecar (`{"type":"operator_nonce","nonce":"…","action":"set|clear","scopeKind":"…","scopeId":"…","name":"…"}`), then returns it to the webview, which sends it in the header `x-openfleet-operator-nonce` of the `PUT` or `DELETE`. The nonce is **bound to the action and the secret**: the daemon refuses it, and spends it, when it is presented for another action, scope or name. It is usable once and lives 30 seconds on the monotonic clock. An agent cannot call a Tauri command nor write to the pipe, so the admin token alone, which any process of the user can read from `admin.token`, does not suffice.

   The same nonce is the **human proof of arming a trigger**. For `action = "trigger.arm"` the command takes `scope_kind = "trigger"` and the trigger id as both `scope_id` and `name` (a trigger id need not look like a secret name). The webview sends the nonce in the header `x-human-proof` of `POST /api/triggers/:id/arm`; the daemon feeds the `HumanProofVerifier` of the triggers from the same ledger. A nonce minted for another trigger or for a secret is refused and spent, a used one is refused, and a daemon without the app refuses every arming. Disarming needs the admin token alone.
2. **Request to the app (stdout).** To act on the keychain the daemon prints `{"type":"secret_request","requestId":"…","op":"set|clear|status|read","scope":{…},"name":"…"}`; a set also carries `"value"`. The request id is 192 random bits. The app takes these lines out of the output before it writes its log or reads a status line from it.
3. **Answer (stdin).** The app does the keychain work and writes `{"type":"secret_answer","requestId":"…","outcome":"…"}`. `outcome` is `ok` (set, clear), `stored` or `missing` (status), `value` with `"value"` (read), `not_found` (read: nothing in the keychain) or `unavailable` (keychain locked or unreadable). The app waits at most 10 seconds for the keychain, then answers `unavailable`; the daemon waits at most 15 seconds, then fails the request with `secret_store_unavailable`.
4. **One answer per request.** The daemon accepts the answer to a request id once, within 30 seconds measured on the monotonic clock (`performance.now`, not the wall clock). An answer with no request in flight, expired, repeated, or addressed to a request of an older daemon is ignored and counted (`daemon.secretChannel.ignoredAnswerCount`); it changes nothing.
5. **No cache, no trace.** A resolved value is returned to the caller that asked and kept nowhere in the daemon. The lines the daemon reads on its stdin are never logged nor echoed, whether they parse or not; a canary value is searched in the logs, the activity log and the diagnostics by the tests.

### What this does not claim

- The status in `secret_refs` is the daemon's record of the last set or clear it did. It is not reconciled with the keychain: an item removed by hand in Keychain Access still reads `stored` until the next resolve fails with `secret_not_connected_on_this_device`.
- A process that can read the memory of the daemon or of the app, or that can attach to the pipes, reads values and live nonces. The channel protects against an agent that has only the admin token and the loopback port of the daemon.
- A set value crosses the daemon: it arrives in the `PUT` body, leaves on the stdout pipe, and the daemon holds it only for the length of the request. The webview could instead hand the value to the app directly by IPC; that would keep the value out of the daemon altogether, and is not what is built.
- Whether the Security framework prompts for access to an item after a rebuild of the app (an ad hoc signature changes its identity at each build) is not verified. See the Keychain spike report: a stable signing identity is needed before any real use.
