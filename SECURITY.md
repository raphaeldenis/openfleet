# Security policy

**In brief.** No private channel for reporting a vulnerability is established in this repository: no security contact, no advisory policy, no `CODEOWNERS`. Until Raphaël decides one, this file cannot name an address and does not invent one. How secrets are handled, by name, is in [docs/secrets.md](docs/secrets.md).

## Reporting a vulnerability

Reporting channel: **UNVERIFIED / à décider par Raphaël.** A search of `README.md`, `package.json`, `apps/desktop/package.json` and `packages/core/package.json` finds no contact, no `author`, no `bugs` field and no mention of disclosure.

An unconfirmed option a human can check: GitHub private vulnerability reporting, if enabled on the repository. Check with `gh api repos/{owner}/{repo}/private-vulnerability-reporting` (the answer is `enabled: true` or `false`) or in Settings → Code security.

Until a channel exists, do not post a vulnerability, a token or an exploit in a public issue or pull request.

## What the code does today

Each item names the file that shows it.

- The daemon listens on `127.0.0.1` only (`packages/core/src/config.ts:27`), port 7331 by default (`config.ts:28`).
- Requests carry an admin token that the daemon creates on first start in `<OPENFLEET_HOME>/admin.token`, with mode `0600`. A token shorter than 32 characters stops the daemon from booting (`config.ts:40-53`).
- The OpenFleet home and its `worktrees` and `sessions` folders are set to mode `0700` on every load (`config.ts:16`, `config.ts:20`, `config.ts:24`).
- Error envelopes and the structured logger share one masking rule. It masks any key whose name contains `token`, `secret`, `authorization`, `password`, `cookie`, `ticket` or `api key`, and some formats of secrets inside text (`packages/core/src/redact.ts:1`, `redact.ts:11`). Its documented ceilings, left readable on purpose, are listed at `redact.ts:3-8`.
- The repository ships no `.claude/settings.json` and no auto-approve hook (`README.md:162`, `docs/house-rules.md:8`).
- The default merge policy is human: an agent opens a draft pull request, a person marks it ready and merges (`docs/adr/0003-merge-policy-human-by-default.md:8`).
- The desktop support bundle is rebuilt from an allowlist, and free text is reduced to `[text:<len>:<tag>]` (`CHANGELOG.md:20-24`).

## Out of scope for this file

- GitHub settings (secrets, environments, branch protection, who may merge or publish): not readable from the repository. See the UNVERIFIED list in [docs/secrets.md](docs/secrets.md).
- Signing and publication of the app: open decision RELEASE01 (`RELEASING.md:5`, `RELEASING.md:53`), to decide by Raphaël.
- A supported-versions table: none exists in the repository. UNVERIFIED / à décider par Raphaël.
