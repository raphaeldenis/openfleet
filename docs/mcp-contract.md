# MCP contract version

The MCP server carries a `contract_version`: a plain integer that rises by one on every added MCP tool or changed tool shape. An integer fits because a client only asks "did the tools change since I looked", so major/minor semantics would carry nothing. It is distinct from `DAEMON_VERSION`, the version of the binary, which changes on every release whether or not a tool moved.

## What raises it

- A tool is added or removed.
- A tool is renamed.
- A tool's input schema changes: a parameter added, removed, renamed, retyped, made required or optional, or a bound changed.

- A tool's output gains or loses a field (for example `pendingPermission.input`). The guard test does not see output fields, so raising the version for them is a convention: the author does it and records it in `CHANGELOG.md`.

The description text of a parameter is part of the input schema, so rewording it changes the pin and raises the version. Text-only changes outside the input schema (the description of the tool itself, an error message) and behavior behind an unchanged shape do not raise it, with one exception: a call that used to succeed and is now refused (for example `restore_note_version` without `expected_rev`, version 10). The guard cannot see it, so the author raises the version by hand and records it in `CHANGELOG.md`.

Output changes are not detected: the guard hashes input schemas only, so a changed result shape or result field passes unnoticed. Raise the version by hand when a tool's output changes in a way clients can see.

A version that is not published yet (no release, no tag: check with `git tag --list`) absorbs the changes made to its tools: the version does not rise again, the pin is refreshed and `CHANGELOG.md` records them in that version's section. An output change that breaks a client of the previous version gets an explicit entry there that starts with "BREAKING vs <previous version>". Nothing in the guard test checks this: a tool added to, or an output changed in, an unpublished version passes the guard whether or not the changelog says so, so the review of the pull request is what checks it.

Example: version 6 added `required`, `displayColumnId`, `config`, `displayWidth` and `wrap` to the column views next to new `update_data_store_column` parameters; the new parameters moved the pin, the new output fields were raised by hand.

## Where to read it

- `CONTRACT_VERSION` in `packages/shared/src/mcpContract.ts`, the single definition.
- The MCP `initialize` result: the server `instructions` read `openfleet MCP contract_version: <n>` (`client.getInstructions()` in the SDK). `serverInfo.version` stays the daemon version.
- The `contract_version` field of the `get_argus_status` result.

## How to raise it

1. Raise `CONTRACT_VERSION` by one in `packages/shared/src/mcpContract.ts`.
2. Replace `packages/core/src/mcp/contract.pinned.json` with the contract printed by the failing guard test (same `contractVersion` as the constant).
3. Add a section to `CHANGELOG.md`: date, tools added or changed, migrations.

One pull request that adds or changes tools does all three.

## Example: an optional parameter

`create_worktree` gained the optional `base_ref` at version 9. An added optional parameter is a changed input schema: the pin changed and the version rose by one, with the `CHANGELOG.md` section "9".

## Example: an optional parameter that guards a write

`update_data_store_rows` (per update) and `update_data_store_row` gained the optional `expected_rev` at version 14, and the rows of `query_data_store` and `get_data_store` gained `rev`. The input schemas moved the pin; the new output field was raised by hand, with the `CHANGELOG.md` section "14". Leaving `expected_rev` out keeps the earlier behaviour, so no call that used to succeed is refused.

## Example: added tools and a refused call

`submit_plan_questions`, `report_arbiter_opinion` and `approve_plan_criteria` were added at version 15. The pin gained three entries and the version rose by one, with the `CHANGELOG.md` section "15". The same section records the `AskUserQuestion` call that a manager session used to make and is now refused: the guard cannot see it, so it was raised by hand with the tools.

Version 15 had no release and no tag when `get_manager_mission` was added to it (`git tag --list` was empty; the rule holds as long as that is true), so it became the fourth added tool without a new version: the pin gained a fourth entry, and the section "15" records an output change, `get_argus_status` no longer returns `manager.missionText` but `manager.missionBytes` and `manager.missionSha256`, in an entry that starts with "BREAKING vs 14".

## The guard test

`packages/core/src/mcp/contractGuard.test.ts` boots a real daemon, connects an MCP client as a manager and lists the tools. It sorts them by name and hashes each canonicalized input schema (object keys sorted; parameter descriptions included, the tool's own description not part of the input schema), then compares the result to `contract.pinned.json`. It fails when:

- a tool name or an input schema differs from the pin, or
- the pin's `contractVersion` differs from `CONTRACT_VERSION`.

Changing the tools without refreshing the pin fails the first check. Raising `CONTRACT_VERSION` without the pin's `contractVersion`, or the reverse, fails the second. Refreshing the pin for the tools and keeping the same version passes both checks: that is how a version not yet published absorbs a change, and it is also what a forgotten version raise on a published version looks like, so the guard does not protect that case. The failure message lists the added, removed and reshaped tools and prints the new pin to paste.

The pin covers the tools a manager sees. The reviewer's reduced tool set is a subset of it.
