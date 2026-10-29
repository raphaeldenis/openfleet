# Journal append guard

A project can switch on a row guard (`row_guard_enabled`, migration 042). On a data store whose columns are named `journal`, `status`, `pr_url` and `step`, a row write that breaks one of two rules is refused with `row_guard_violation` (HTTP 400, retry `never`):

- **The journal only grows.** The new `journal` text must start with the previous one.
- **A row is not done without a pull request.** A row whose `status` is `done` needs a non-empty `pr_url`, unless its `step` is `cancelled`.

## Known limits

- **A row already `done` without a `pr_url` is refused on a patch that touches `step` or returns `done`.** The rule judges the resulting row, so such a legacy row cannot be edited through those cells until a `pr_url` is set in the same update or its step is `cancelled`.
- **The journal prefix test is strict.** It is `startsWith` on NFC-normalised text, with no normalisation of line endings: a client that rewrites `\n` as `\r\n` in the earlier lines is refused.
- **Renaming the `journal` column turns the guard off.** Columns are found by their display name (trimmed, lower-cased, NFC). A store whose column is renamed (`log`, `journal 2`) is no longer guarded, and the same holds for `status`, `pr_url` and `step`.
- **`insertRow` and delete-then-recreate are not covered.** The guard runs on updates of an existing row. A new row can start with any journal, and a row that is deleted and created again starts a fresh journal.
