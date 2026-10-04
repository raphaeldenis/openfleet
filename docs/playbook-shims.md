# Playbook shims (MIG-05)

The Scape importer archives each project's playbooks in one note named
**Playbooks (ex-Scape)**. Descriptions and step authoring bodies are escaped
text marked `[non converti: playbook]`. The archive never runs a step and
excludes run caches, run history and secret values. Declared secret names
are listed with **to set as environment variables**. Native playbooks remain
a later migration step.

The `playbooks` report row counts individual source playbooks. Its write,
already present and conflict counts follow the outcome of their shared
project archive. An existing archive with different content is a conflict;
the importer preserves it for manual review. Repeating an unchanged import
writes zero records. Dry runs use disposable snapshots and write nothing
to either home.

## OpenFleet mapping

Run these commands from the selected worktree. `$WORKTREE` is its absolute
path. Existing machine scripts remain outside the repository; no secret
or machine script is copied into git.

| Playbook | Script path | Bash call |
| --- | --- | --- |
| verify | `scripts/verify.sh` | `bash scripts/verify.sh "$WORKTREE"` |
| dev-servers | `~/Documents/scape-team/openfleet/dev-servers.sh` | `WORKTREE="$WORKTREE" bash "$HOME/Documents/scape-team/openfleet/dev-servers.sh"` |
| dev-servers-stop | `~/Documents/scape-team/openfleet/dev-servers-stop.sh` | `bash "$HOME/Documents/scape-team/openfleet/dev-servers-stop.sh"` |
| github-issue | `~/Documents/scape-team/openfleet/github-issue.sh` | `NUMBER=123 bash "$HOME/Documents/scape-team/openfleet/github-issue.sh"` |
| qa-browser | `~/Documents/scape-team/openfleet/qa-browser.sh` | `bash "$HOME/Documents/scape-team/openfleet/qa-browser.sh"` |
| open-pr | `scripts/open-pr.sh` | `bash scripts/open-pr.sh --repo owner/repo --title "$PR_TITLE" --body-file "$PR_BODY_FILE" --base main` |

`verify.sh` runs architecture, strict type checking and the full core suite,
stopping at the first failure. It does not start servers or run browser e2e.
The push hook owns local e2e decisions. `open-pr.sh` sends an existing body
file to `gh`; authentication stays with the user's configured GitHub CLI.

### Child permissions

The manager must configure its child's Bash permission rules to allow the
exact script invocations above (with the selected worktree path). Bash can
then invoke the scripts directly without a Scape playbook tool or subscription
gate. A script cannot grant its own permission or bypass a harness approval;
the actual no-prompt check belongs to cutover acceptance with that child.

Do not start or stop shared dev servers during migration validation.
Existing machine scripts own the shared ports and process lifecycle.

## Follow-ups

The CCM `verify`, `dev-servers`, `dev-servers-stop`, `open-mr`, `jira-issue`
and `qa-login` are archived without an OpenFleet script pointer. CCM's
cutover depends on its project-specific tooling (including MIG-07 for Jira).
OpenFleet `qa-e2e` remains a follow-up: use the existing push hook for local
browser tests, rather than treating `qa-browser` as equivalent to e2e.

Mission note #46 remains byte-for-byte subject to the existing MIG-01/MIG-02
note conversion. Update its tool instructions in a separate mission edit
after confirming the live call inventory; the importer does not rewrite
mission prose.
