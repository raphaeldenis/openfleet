# Manager SessionStart context

A manager session receives a context on each `SessionStart` (`startup`, `resume`, `clear`, `compact`). An ordinary session receives one on `clear`, `compact` and `resume` only, and never a `# Process` block.

## Blocks, in order

1. State line (what happened, age of the working state, staleness).
2. Base line (manager base version and sha).
3. `# Mission`: the first 3 000 bytes of the stored mission text, with a marker that points to `get_manager_mission` when it is cut.
4. `# Process`: the `## Process` section of the linked mission note (below).
5. Precedence and data-statement lines, `# Live children`, `# Working state`, previous transcript path, end line.

## The `# Process` block

The block carries the pipeline steps and guard-rails of the manager, so that they survive a compaction.

Convention: the mission note holds a section whose title is `## Process` (case-insensitive). The section runs to the next heading of level 1 or 2. Headings inside code fences do not end it.

- Section present: its text, cut to 1 500 bytes. A longer section ends with a marker that gives the total size and says to read the whole section with `get_note` on the mission note.
- Section absent, note deleted, or no note linked: the single line `Process: no "## Process" section in the mission note`.

## Budget

The context is kept within 9 000 characters. When it is too long, the live children are dropped first (down to "and N more"), then the `# Mission` preview is shortened. The `# Process` block, the working state, the transcript path and the trusted lines are never cut. The Process block is at most about 1 600 bytes, so it leaves the budget to the other blocks.
