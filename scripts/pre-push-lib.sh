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
      changed_file_names "$remote_sha" "$local_sha"
    else
      files_since_origin_main "$local_sha"
    fi
  done | sort -u
}

# Prints the paths changed between two revisions: old paths of renames included, never quoted (-z, since quotePath=false still quotes tabs).
changed_file_names() {
  git diff -z --name-only --no-renames "$@" | tr '\0' '\n'
}

files_since_origin_main() {
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    changed_file_names origin/main..."$1"
  else
    git ls-tree -r -z --name-only "$1" | tr '\0' '\n'
  fi
}

# Reads file names on stdin and prints the optional steps they call for: cargo, e2e.
steps_for_files() {
  pushed_file_names=$(cat)
  printf '%s\n' "$pushed_file_names" | grep -Eq "$CARGO_TRIGGER_PATTERN" && echo cargo
  printf '%s\n' "$pushed_file_names" | grep -Eq "$E2E_TRIGGER_PATTERN" && echo e2e
  return 0
}

# Prints the caller's TMPDIR, else the OS per-user temp dir (macOS), else /tmp.
default_tmpdir() {
  [ -n "$TMPDIR" ] && { echo "$TMPDIR"; return 0; }
  getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp
}

# Runs the core tests the way CI does: node and pnpm on PATH, no claude, empty HOME, a real TMPDIR (some core tests size paths from it). Needs node, pnpm and mktemp; removes its temp dir on exit.
# Skips (returns 0) when pnpm cannot run in that minimal environment or would need the network: a false failure must not block a push.
claude_free_core_tests() {
  claude_free_workdir=$(mktemp -d) || return 1
  trap 'rm -rf "$claude_free_workdir"' EXIT
  trap 'exit 130' INT TERM
  mkdir "$claude_free_workdir/bin" "$claude_free_workdir/home" || return 1
  ln -s "$(command -v node)" "$claude_free_workdir/bin/node" || return 1
  ln -s "$(command -v pnpm)" "$claude_free_workdir/bin/pnpm" || return 1
  claude_free_tmpdir=$(default_tmpdir)
  if ! run_without_claude pnpm --version >/dev/null 2>&1; then
    echo "pre-push: pnpm cannot run in a minimal PATH here: claude-free check skipped" >&2
    return 0
  fi
  run_without_claude pnpm --filter @openfleet/core test && return 0
  echo "pre-push: the core tests fail without claude on the PATH (a test may depend on claude being installed, or on TMPDIR/HOME): see the output above" >&2
  return 1
}

# Runs a command with only node and pnpm on PATH and no network-fetching package manager switch.
run_without_claude() {
  env -i PATH="$claude_free_workdir/bin:/usr/bin:/bin" HOME="$claude_free_workdir/home" TMPDIR="$claude_free_tmpdir" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_NETWORK=0 npm_config_manage_package_manager_versions=false "$@"
}

# Prints force | skip | auto from OPENFLEET_PREPUSH_E2E (1 forces, 0 skips) and whether the push touches e2e-relevant code (yes|no).
decide_e2e() {
  e2e_touched=$1
  [ "$OPENFLEET_PREPUSH_E2E" = "1" ] && { echo force; return 0; }
  [ "$OPENFLEET_PREPUSH_E2E" = "0" ] && { echo skip; return 0; }
  [ "$e2e_touched" = "yes" ] && { echo auto; return 0; }
  echo skip
}
