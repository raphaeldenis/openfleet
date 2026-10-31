# Contributing

## En bref

Work on a branch, never on `main`. Write commit subjects as `type(scope): description`. Push the branch (the `pre-push` hook runs what CI runs), publish it, then open the pull request with `scripts/open-pr.sh`. The PR title follows the same format as a commit subject and the body follows [`.github/pull_request_template.md`](.github/pull_request_template.md) (in French). A person marks the PR ready and merges it by default. Every rule below names its source; what the repository does not establish is marked `UNVERIFIED` or left to Raphael.

Read [docs/house-rules.md](docs/house-rules.md) first. Build, test and run commands are in the [README](README.md#dev).

## Branches

- Branch from `main` and open the PR against `main` (`scripts/open-pr.sh:7`, default `--base main`; `.github/workflows/ci.yml:3-5`).
- There is no enforced naming scheme. Merged branches of the last 60 PRs (`gh pr list --state merged`) are lowercase and hyphenated: `night7-usage-tokens`, `integration-night-escalation`, `tables-row-cas01`; a few carry a type prefix: `docs/glossary-fix168`, `chore/git-guardrails-fix169`.
- Ticket in the branch name: for work driven by a manager, the findings gate takes the ticket from the branch name with `findingsGate.ticketPattern` (default `[A-Z][A-Z0-9]+-\d+`, `docs/command-policy.md:58,66,71`) and refuses a branch that names none. None of the last 60 merged branch names matches that default. How those PRs passed the gate is UNVERIFIED. A branch name convention: to be decided by Raphael.
- `main` is protected on GitHub (no force-push, pull request required) according to `docs/git-guardrails.md:5`. The setting itself is UNVERIFIED from the repository.
- Removing a worktree keeps its branch (`docs/worktrees.md:83`). A rule on deleting merged branches: to be decided by Raphael.

## Commits

- Subjects are conventional commits: `type(scope): description`, with `!` after the type or scope for a breaking change (`docs/house-rules.md:34`).
- Types in use on `main`: `feat`, `fix`, `docs`, `test`, `perf`, `chore`, `style`. Release notes group `feat`, `fix`, `perf`, `refactor`, `docs`; any other type lands under "Other changes", and `chore(release)` commits are skipped (`docs/house-rules.md:34`, `scripts/release/release-lib.mjs`).
- Scopes in use: `core`, `desktop`, `mcp`, `ui`, `usage`, `escalation`, `e2e`, `hooks`, `sessions`, `managers`, `policy`, `changelog`, and others. No closed list exists.
- A ticket id in capitals may close the subject in parentheses, for example `(CHILD-SILENCE-PERSIST01)`, `(FIX168)`. Frequent in recent history, not required by any file.
- Subjects are lowercase, in English, without a final period (observed in `git log`).
- Trailers: most commits carry none; at least one recent commit carries `Co-Authored-By`. Whether trailers are allowed: to be decided by Raphael.
- [CHANGELOG.md](CHANGELOG.md) exists and recent commits update it (`docs(changelog): …`). A rule saying when an entry is required: UNVERIFIED.
- Commit and push through the hook: `git push --no-verify` is the only bypass (`docs/house-rules.md:14`, README, "Pre-push hook").

## Checks before and after the push

- The `pre-push` hook (`scripts/pre-push.sh`) runs `pnpm arch`, `pnpm typecheck`, `pnpm test`, the desktop tests, plus Cargo and e2e steps when the push touches the matching paths (README:130-140). Node 26 or newer.
- CI runs on `pull_request` and on pushes to `main` (`.github/workflows/ci.yml:3-5`). Three jobs: `rust`, `test`, `e2e` (`ci.yml:11,64,78`). A branch pushed without a PR does not run CI (README:156).
- `scripts/ci-hook-parity.test.ts` keeps hook and CI aligned (`docs/house-rules.md:16`).
- Which checks are required to merge: UNVERIFIED (branch protection is a GitHub setting).

## Opening the pull request: `scripts/open-pr.sh`

```
bash scripts/open-pr.sh --repo <owner/repo> --title <title> --body-file <file> --head <published-branch> [--base <branch>] [--worktree <dir>]
```

- Required: `--repo`, `--title`, `--body-file` (an existing file), `--head`. Defaults: `--base main`, `--worktree .` (`scripts/open-pr.sh:4-34`).
- It never pushes. Push first (`git push -u origin <branch>`), then fetch. It refuses a branch missing from `origin`, or whose local commit differs from `origin/<branch>`, with exit 2 (`scripts/shim-guards.sh:13-23`, `docs/playbook-shims.md:40-46`).
- It refuses a directory that is not a git worktree, exit 2 (`scripts/shim-guards.sh:3-11`).
- It calls `gh pr create --repo … --head …`; authentication is your configured GitHub CLI (`scripts/open-pr.sh:40`).
- For a session driven by a manager, `gh pr create` typed in the session is judged by the findings gate; a call hidden inside a script such as `open-pr.sh` is not seen by it (`docs/command-policy.md:74`). The effect on `open-pr.sh` is UNVERIFIED.

## Pull requests

- Title: same format as a commit subject, lowercase, in English. Merged examples: `fix(desktop): keep manager child rows and project header on one line` (#397), `docs: consolidate contract 15 into a single readable page` (#396), `feat(core): silence checks survive a daemon restart` (#391). Some older PRs do not follow it (#355, #354, #347).
- Body: in French, with the sections of the template. Every one of the last 40 merged PRs has `Résumé`, `Contenu (N commits)`, `Vérification` and `Non vérifié`; optional sections seen: `Choix à connaître`, `Hors périmètre`, `Résidus`, `Limites connues`.
- No agent name and no trailer in the body or the title (the merged bodies and titles listed above carry none; no file states it as a rule).
- A PR states what was run (`Vérification`) and what was not (`Non vérifié`); "passing" is claimed only with a command output.
- Merge commits on `main` are `Merge pull request #N from <owner>/<branch>` (observed in `git log --first-parent`).

## Review and merge

- Default policy: an agent opens a draft PR; a person marks it ready and merges it ([ADR 0003](docs/adr/0003-merge-policy-human-by-default.md)). Projects can opt in to merging on green checks through a written mandate; OpenFleet does so through the manager's merge law, which lives outside this repository (ADR 0003).
- Findings gate for manager-driven work: `qe` and `qa` (`go` or `clean` at the head commit), `ponytail`, and `adversarial` (`go` at the head commit, never skippable) must be reported before `gh pr create` passes (`docs/command-policy.md:58-66`). A new commit closes the gate again.
- Human reviewers, required approvals, CODEOWNERS: none in the repository (`.github/` holds only `workflows/`). UNVERIFIED on GitHub; to be decided by Raphael.

## Tickets

- The findings gate expects `[A-Z][A-Z0-9]+-\d+` in the branch name (default pattern). History uses other shapes: `FIX168`, `CHILD-SILENCE-PERSIST01`, `AUD-23B`, `RA-13..RA-21`. They appear in commit subjects and PR bodies. Which shape is canonical: to be decided by Raphael.
- The tracker that issues them is not named anywhere in the repository: UNVERIFIED.
- Follow-up residues are recorded in a `Résidus` section that names the next ticket line (for example #375, #374). The kanban that holds those lines lives outside the repository.

## Releases and security

- Releasing: [RELEASING.md](RELEASING.md). Version bumps go only through `scripts/release/set-version.mjs` (`docs/house-rules.md:38`).
- Security policy (`SECURITY.md`) does not exist yet; the audit of 2026-10-31 lists it as missing. Never commit tokens or `.env` files (`docs/house-rules.md:5-9`).
