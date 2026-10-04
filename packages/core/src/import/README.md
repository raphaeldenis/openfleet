# Scape import at cutover

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
separately from an empty table. The report also identifies display formats
(`url`, `longText`, `rank`, `datetime`) and view settings such as kanban
`columnOrder` that OpenFleet does not preserve; cell values remain imported.

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
