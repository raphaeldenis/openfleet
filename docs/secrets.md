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
