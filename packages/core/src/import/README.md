# Scape import at cutover

Knowledge snapshot import uses the same packaged entry before daemon boot:
`node /absolute/daemon.mjs import knowledge --file /absolute/snapshot.json --mapping /absolute/mapping.json --home /absolute/target-home --dry-run`.
The separate offline `--activate` operation transfers ownership only after a sealed
final import. Final import and activation require `--mem02-acceptance` referencing
an independently accepted MEM-02 delivery. See
[the knowledge cutover runbook](../../../../docs/knowledge-cutover.md) for the export
contract, freeze proof, report files and rollback ownership.

The core bundle accepts `import scape` before starting the daemon. Quit
OpenFleet before a real import. The importer refuses a target used by a running
daemon. Use Node 26 or newer.

From a checkout:

```sh
pnpm --filter @openfleet/core import:scape --home "$HOME/.openfleet" --dry-run
```

From a built bundle (no TypeScript runner required):

```sh
node apps/desktop/src-tauri/resources/daemon/daemon.mjs import scape --home "$HOME/.openfleet" --dry-run
```

From an installed DMG, use its embedded Node and resource entry:

```sh
/Applications/OpenFleet.app/Contents/MacOS/node /Applications/OpenFleet.app/Contents/Resources/resources/daemon/daemon.mjs import scape --home "$HOME/.openfleet" --report-dir "$HOME/Documents/superpowers/openfleet" --dry-run
```

The desktop executable is a GUI entry. It does not install an `openfleet`
command in PATH. The resource command above is the packaged CLI entry.
Installing a system-wide `openfleet` command or a GUI subcommand remains a
separate packaging decision. The embedded Node must match the machine architecture.

For a rehearsal, keep the target home and report in the gitignored scratch folder:

```sh
/Applications/OpenFleet.app/Contents/MacOS/node /Applications/OpenFleet.app/Contents/Resources/resources/daemon/daemon.mjs import scape --home "$PWD/.scratch/scape-cutover/home" --scape-dir "$HOME/.scape" --report-dir "$PWD/.scratch/scape-cutover/reports"
```

Report counts only and remove rehearsal artifacts after validation.
Remove `--dry-run` to write. Run `import scape --help` for the source, project,
report, state and re-import flags. `--dry-run` creates no report or target home.

At the final cutover, explicitly send the report to the OpenFleet project docs
folder, as required by the cutover plan sections 3 and 6:

```sh
pnpm --filter @openfleet/core import:scape --home "$HOME/.openfleet" --report-dir "$HOME/Documents/superpowers/openfleet" --dry-run
pnpm --filter @openfleet/core import:scape --home "$HOME/.openfleet" --report-dir "$HOME/Documents/superpowers/openfleet" --allow-reimport
```

The same flags work through the packaged entry. `--report-dir` writes
`import-report.md` there instead of in the target home; a dry run prints the
report and writes no file. Save the report before another run overwrites it.
Linking `projects.docs_folder_path` alone does not route the report there.

Archived projects, archived notes and their versions are excluded. Previously
imported records remain in OpenFleet and appear as removed in Scape on a full
re-import. Orphan datastore files (including the retired `FDD4ACA0` project)
are listed but never read. A metadata store without a backing table is listed
separately from an empty table. Supported rich column formats and kanban title,
card fields, column order and showUngrouped are preserved. Unsupported or invalid
view properties remain listed as losses, including partially preserved lists.
Re-import enriches intact views imported by older versions; local edits remain conflicts.

View sort: `sortColumnID` and `sortDescending` become `orderBy: [{ columnId, dir }]` on grid and kanban views (ascending when `sortDescending` is absent). A `sortColumnID` that names no imported column creates no `orderBy`; the view is listed under "View settings not converted" with `sortColumnID`. A `null` or empty `sortColumnID` means no sort column. A `sortDescending` that is not a boolean, or that comes without a sort column, is listed (the former is read as ascending). `sortMode` is never converted: its semantics are not established on the Scape side, and no value is guessed. Each view holding one is listed with its raw value (`sortMode = <value>`, neutralized; an object or array shows as `(object)` or `(array)`).

Lexical conversion: links, autolinks, horizontal rules, tabs and checklist items (`- [x]` / `- [ ]`) are converted. A link is converted only when its URL starts with `http://`, `https://` or `mailto:` (any letter case), is at most 2048 characters long and holds only letters, digits and `-._~:/?#@!$&'*+,;=%` (so no space, parenthesis, `<`, `>`, bracket, backslash, backtick, quote, control or invisible character), and its text has no line break, paired brackets (a backslash escapes the character after it), no trailing backslash and an even number of backticks. Any other link keeps its marker and its text, and the URL is lost. A converted URL is kept as it is: a `https://user:pass@host` URL in a source note reaches the imported Markdown with its credentials, because the import does not mask secrets held in notes. The type name written in a `[non converti: ...]` marker is one line, with backslashes shown as slashes and brackets as parentheses. A `!` right before a link is escaped so it cannot turn the link into an image. A tab node always becomes one tab. A node type that is not a non-empty string is named `(sans type)` (a number or boolean is named by its value). Nesting deeper than 100 levels is cut with a `[non converti: nesting-too-deep]` marker, and the text below the cut is lost.

The report section "Note versions with unconverted lexical nodes" names each note (title) and version number (rev) holding a node without a markdown form, with the node types. An unknown node leaves a `[non converti: type]` marker followed by its children or its own text, so no text is lost outside the nesting cut. Lost on purpose: the style of a run with an underline, subscript, superscript or highlight bit (`text-format:8`, `32`, `64`, `128`), and every node type with no markdown form (the marker and the type name remain).
Without showUngrouped, core omits ungrouped rows and desktop displays them,
preserving each surface's historical default. Explicit true/false overrides both.

## Cleaning the laws copied into the missions

An earlier import wrote the approved laws into each manager mission, under `## Laws` / `### Standing laws`. A re-import of a manager whose mission is intact rewrites the mission without the `### Standing laws` block the import composed (`updated`, `profile_rev` +1). A mission edited in OpenFleet stays as it is (`conflict`). Copies written by hand in the notes (a second `Laws` section, `Guardrails`) are never touched by the re-import. The `clean-laws` command is the way to clean without a Scape source, and it runs only when a human confirms: a plan first, then `--apply --confirm <fingerprint>`:

```sh
pnpm --filter @openfleet/core import:scape clean-laws --home "$HOME/.openfleet"
pnpm --filter @openfleet/core import:scape clean-laws --home "$HOME/.openfleet" --apply --confirm <fingerprint>
```

The first call is a plan: counts (managers to clean, removable copies, bytes saved, conflicts, copies to review by hand) and a fingerprint, and nothing is written. `--apply` refuses without `--confirm`, or with a fingerprint that is not the one of the current plan, and then asks to read the plan again; it also refuses while the daemon runs. An applied cleanup backs the database up first and removes only a block that matches the active laws exactly; a mission edited in OpenFleet is a conflict and kept. Laws or Guardrails sections written by hand in the notes are never touched, only counted. A second run removes nothing. `--json` prints `{ mode, report, fingerprint? }`; the output never holds a law text.

## Claude memory of the managers

Each imported manager boots with the Claude auto-memory of its Scape Argus. The
Claude CLI keeps that memory per working directory, in
`<claude dir>/projects/<cwd with every non-alphanumeric character replaced by "-">/memory`.
The importer reads the Scape side folder (the cwd is `<scape dir>/argus/<Argus id>`)
and copies it to the folder of the new cwd, which is the session directory stored
for the manager (`<home>/managers/<folder>`).

- `--claude-dir` is the Claude config folder that receives the memory (default `~/.claude`).
- `--scape-claude-dir` is the one that holds the Scape memory (default: `--claude-dir`). Give both for a rehearsal that reads the real `~/.claude` and writes a scratch folder.
- Only the regular `*.md` files directly in `memory/` are copied (MEMORY.md and the topic files). Links, sub-folders and other files are not copied; a link is reported as not converted.
- Size caps: 256 KiB per file and 2 MiB per manager (files taken in name order). A file over a cap is skipped whole, never truncated, and reported as not converted. A cwd whose Claude folder name exceeds 200 characters is not converted either: the Claude CLI hashes such names.
- A file never overwrites a different one. Same content is already present; a different file the import did not write, a file edited in OpenFleet since the last import, or a file deleted there is a conflict and is left alone. A Scape change to a file OpenFleet left alone is applied (updated).
- A second run writes nothing. `--dry-run` reads only and creates no folder. The Scape side is never written. A failed run removes the files and folders it created and restores the files it overwrote.
- The report carries the entity `memories` (one count per file) and never prints a memory text.

A home that already holds the imported managers takes the memories alone with
`--allow-reimport`: every other family is already present and nothing else is written.

Cutover command, after the dry runs:

```sh
pnpm --filter @openfleet/core import:scape --home "$HOME/.openfleet" --claude-dir "$HOME/.claude" --report-dir "$HOME/Documents/superpowers/openfleet" --allow-reimport
```

## Lexical to Markdown policy

Ordinary text keeps its authored Markdown characters, including `*`, `_`,
links, backslashes and HTML-looking text. The converter applies the explicit
Lexical bold/italic/strike/code wrappers without globally escaping text.
This preserves Markdown already authored in Scape; an unformatted `*word*`
can therefore become emphasis in a Markdown renderer. Markdown notes bypass
conversion entirely. Mentions use OpenFleet's explicit reference syntax.

Headings fold linebreaks into spaces so all text stays in one heading.
Nested-list wrappers attach to the preceding parent item; a leading wrapper
gets an empty parent item, including its ordered-list number.

Tables use the first row as their header and pad every row to the widest row.
They never discard extra cells. Pipes are escaped, including pipes after an
even run of backslashes; an already escaped pipe is left alone. Cells flatten
block boundaries and linebreaks to `<br>`. Cell headings keep their text,
lists keep their textual markers, and fenced code becomes one inline code
span per line. Code language and block layout inside cells are not preserved.
Empty tables with no cells are omitted. These are Markdown export rules;
the desktop's lightweight preview does not render all Markdown features.
