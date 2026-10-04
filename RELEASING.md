# Releasing OpenFleet (local dmg)

A release today is two local, ad-hoc signed dmgs built on the maintainer's Mac: `OpenFleet_<version>_aarch64.dmg` (Apple Silicon) and `OpenFleet_<version>_x64.dmg` (Intel). Apache-2.0, macOS 14.0 minimum (`bundle.macOS.minimumSystemVersion`). The daemon lives inside the app and stops when the app quits. Nothing is uploaded, notarized or auto-updated.

Signing identity, notarization, publication and the update server are not part of this flow: TODO: decision pending (see RELEASE01).

## Prerequisites

- Node 26 (`.nvmrc`), pnpm, `pnpm install --frozen-lockfile` done.
- Rust through `rustup`, with both targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
- Xcode command line tools.
- On `main`, up to date with `origin/main`, with nothing uncommitted and no untracked file (the prepare script refuses otherwise).
- Quit any running OpenFleet app. Dev daemons use their own home (`OPENFLEET_HOME`, `OPENFLEET_PORT`) so they never migrate the installed app's db (see `packages/core/src/db/README.md`).

## Steps

1. **Prepare.** Pick a version greater than the current one (`apps/desktop/src-tauri/tauri.conf.json`, the single source) and preview it:

       node scripts/release/prepare.mjs 0.2.0 --dry-run
       node scripts/release/prepare.mjs 0.2.0

   `prepare.mjs` bumps every version file through `set-version.mjs`, runs the pre-push checks (architecture, typecheck, root tests, desktop tests), writes `release-notes-v<version>.md` (gitignored, commits since the last `v*` tag grouped by conventional-commit type) and prints the next commands. It never commits, tags or pushes, and it builds nothing.

   | Flag | Effect |
   |------|--------|
   | `--dry-run` | prints every step and the notes, changes nothing, runs no check |
   | `--skip-checks` | skips the checks with a warning (the pre-push hook still runs them on push) |
   | `--allow-non-main` | allows another branch than `main`, with a loud warning |

   Exit codes: `0` prepared, `1` refused before touching anything (message says the fix), `2` a step failed.

2. **Edit the notes.** Replace the `Summary: TODO` line of `release-notes-v<version>.md` with two lines for the people who install the build.

3. **Commit the bump** with the exact command `prepare.mjs` printed (`git add <files>`, then `git commit -m "chore(release): v<version>"`).

4. **Build the two dmgs** from that commit:

       pnpm build:dmg:all

   It builds Intel first and Apple Silicon last (`scripts/release/build-local.sh`; one dmg at a time with `pnpm build:dmg` or `pnpm build:dmg --target x86_64-apple-darwin`). Each build fetches the pinned Node sidecar (`scripts/release/node-version.txt`), bundles the daemon and runs `tauri build`. The dmgs land in `apps/desktop/src-tauri/target/<target>/release/bundle/dmg/`.

5. **Try the Apple Silicon dmg** (see the checklist), then the Intel one if an Intel Mac is available.

6. **Tag and push**, only once the checklist is green, with the commands `prepare.mjs` printed:

       git tag -a v<version> -m "OpenFleet v<version>"
       git push origin main v<version>

   The pre-push hook runs the full checks on the push.

7. **Hand the dmgs over.** TODO: decision pending (see RELEASE01): where the dmgs and the notes are published (GitHub Release or not), and how they are signed and notarized.

## Checklist

- [ ] `prepare.mjs` ended with exit code 0 and `git status` shows only the version files.
- [ ] Notes summary written; no `TODO` left in `release-notes-v<version>.md`.
- [ ] Both dmgs exist with the new version in their names.
- [ ] `codesign -dv /Applications/OpenFleet.app` reports `Signature=adhoc`.
- [ ] Fresh install from the dmg, launched from Finder: onboarding passes the daemon step alone, a real session starts, a worktree is created.
- [ ] Settings → About shows the new app version and the same daemon version, with no mismatch banner.
- [ ] Upgrade over an older install: sessions resume, and a db backup exists in `~/.openfleet/backups/` when a migration shipped.
- [ ] Quit stops the daemon: `lsof -nP -iTCP:7331 -sTCP:LISTEN` is empty within 12 s.
- [ ] On another Mac, the quarantine flag is cleared when needed: `xattr -dr com.apple.quarantine /Applications/OpenFleet.app`.

## Rollback

- **Before the push.** Nothing left the machine. Undo the commit with `git reset --hard origin/main` (this drops the bump, so check `git log -1` first) and delete a local tag with `git tag -d v<version>`.
- **After the push.** The fix is a new, higher patch version through the same steps (roll forward). Delete a wrongly pushed tag only if nobody built from it: `git push origin :refs/tags/v<version>` then `git tag -d v<version>`.
- **An installed app.** Quit it and install the previous dmg over it. When the bad version migrated the database, the previous app refuses to start on it: quit, delete `openfleet.db-wal` and `openfleet.db-shm` in `~/.openfleet`, and copy the pre-upgrade backup from `~/.openfleet/backups/` over `openfleet.db`. The exact file and the rules are in `packages/core/src/db/README.md` ("Backup before a migration, and going back").
