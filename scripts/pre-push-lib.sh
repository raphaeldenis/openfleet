#!/bin/sh
# Decisions of scripts/pre-push.sh, kept apart so scripts/pre-push.test.ts can exercise them. Sourced, never run.

ZERO_SHA=0000000000000000000000000000000000000000
CARGO_TRIGGER_PATTERN='^apps/desktop/src-tauri/'
E2E_TRIGGER_PATTERN='^(apps/desktop/src/|packages/core/src/api/|packages/shared/src/)'

# Reads git's pre-push stdin (<local ref> <local sha> <remote ref> <remote sha>) and prints the files each ref would publish.
pushed_files() {
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    [ -n "$local_sha" ] || continue
    [ "$local_sha" != "$ZERO_SHA" ] || continue
    if [ "$remote_sha" != "$ZERO_SHA" ] && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
      git diff --name-only "$remote_sha" "$local_sha"
    else
      files_since_origin_main "$local_sha"
    fi
  done | sort -u
}

files_since_origin_main() {
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    git diff --name-only origin/main..."$1"
  else
    git ls-tree -r --name-only "$1"
  fi
}

# Reads file names on stdin and prints the optional steps they call for: cargo, e2e.
steps_for_files() {
  pushed_file_names=$(cat)
  printf '%s\n' "$pushed_file_names" | grep -Eq "$CARGO_TRIGGER_PATTERN" && echo cargo
  printf '%s\n' "$pushed_file_names" | grep -Eq "$E2E_TRIGGER_PATTERN" && echo e2e
  return 0
}

# Runs the core tests the way CI does: node and pnpm on PATH, no claude, empty HOME, the caller's TMPDIR (some core tests size paths from it). Needs node, pnpm and mktemp; removes its temp dir on exit.
claude_free_core_tests() {
  claude_free_workdir=$(mktemp -d) || return 1
  trap 'rm -rf "$claude_free_workdir"' EXIT
  trap 'exit 130' INT TERM
  mkdir "$claude_free_workdir/bin" "$claude_free_workdir/home" || return 1
  ln -s "$(command -v node)" "$claude_free_workdir/bin/node" || return 1
  ln -s "$(command -v pnpm)" "$claude_free_workdir/bin/pnpm" || return 1
  env -i PATH="$claude_free_workdir/bin:/usr/bin:/bin" HOME="$claude_free_workdir/home" TMPDIR="${TMPDIR:-/tmp}" pnpm --filter @openfleet/core test && return 0
  echo "pre-push: a test depends on claude being installed: CI has none (this run had no claude in PATH)" >&2
  return 1
}

# Prints force | skip | auto from OPENFLEET_PREPUSH_E2E (1 forces, 0 skips) and whether the push touches e2e-relevant code (yes|no).
decide_e2e() {
  e2e_touched=$1
  [ "$OPENFLEET_PREPUSH_E2E" = "1" ] && { echo force; return 0; }
  [ "$OPENFLEET_PREPUSH_E2E" = "0" ] && { echo skip; return 0; }
  [ "$e2e_touched" = "yes" ] && { echo auto; return 0; }
  echo skip
}
