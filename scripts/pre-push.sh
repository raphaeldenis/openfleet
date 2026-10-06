#!/bin/sh
# Runs the checks CI runs (.github/workflows/ci.yml) so a red CI is caught before the push.
# Invoked by .husky/pre-push (git passes the pushed refs on stdin); also runnable by hand: sh scripts/pre-push.sh
# OPENFLEET_PREPUSH_DRYRUN=1 prints the steps without running them.
# OPENFLEET_PREPUSH_E2E=1 forces the e2e, =0 skips it. The e2e picks free ports itself, so a running dev server never blocks it.

REQUIRED_NODE_MAJOR=26
TAURI_DIR=apps/desktop/src-tauri
TAURI_MANIFEST=$TAURI_DIR/Cargo.toml
CLIPPY_RUST_VERSION=1.99.0

fail() {
  echo "pre-push: $1" >&2
  exit 1
}

run_step() {
  step_name=$1
  shift
  if [ "$OPENFLEET_PREPUSH_DRYRUN" = "1" ]; then
    echo "pre-push: ▷ $step_name (dry run) — $*"
    return 0
  fi
  echo "pre-push: ▶ $step_name"
  step_started_at=$(date +%s)
  "$@" || fail "✖ failed at step '$step_name' — push aborted (bypass: git push --no-verify)"
  echo "pre-push: ✔ $step_name ($(($(date +%s) - step_started_at))s)"
}

assert_compatible_node() {
  command -v node >/dev/null 2>&1 || fail "node not found in PATH; install Node >= $REQUIRED_NODE_MAJOR"
  node_major=$(node -p "process.versions.node.split('.')[0]")
  [ "$node_major" -ge "$REQUIRED_NODE_MAJOR" ] ||
    fail "node $(node -v) at $(command -v node) is too old; Angular needs Node >= $REQUIRED_NODE_MAJOR (as in CI). Put a newer node first in PATH."
}

is_planned() {
  printf '%s\n' "$planned_steps" | grep -qx "$1"
}

comma_separated_head() {
  head -n 5 | paste -sd, - | sed 's/,/, /g'
}

assert_no_untracked_test_inputs() {
  untracked_files=$(untracked_test_inputs | comma_separated_head)
  [ -z "$untracked_files" ] ||
    fail "untracked files the tests could read, absent from CI's clean clone: $untracked_files — git add them or list them in .gitignore"
}

warn_about_uncommitted_test_inputs() {
  uncommitted_files=$(uncommitted_test_inputs | comma_separated_head)
  [ -z "$uncommitted_files" ] ||
    echo "pre-push: warning — the tests run on uncommitted changes that CI will not see: $uncommitted_files"
}

run_cargo_checks() {
  if ! command -v cargo >/dev/null 2>&1; then
    echo "pre-push: cargo skipped — cargo is not installed (CI still runs the Rust checks)"
    return 0
  fi
  command -v rustup >/dev/null 2>&1 || fail "rustup is required for the CI Rust toolchains"
  export TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}'
  run_step "Rust test toolchain" rustup toolchain install "$TAURI_RUST_VERSION" --profile minimal
  run_step "Rust clippy toolchain" rustup toolchain install "$CLIPPY_RUST_VERSION" --profile minimal --component clippy
  run_step "cargo test" cargo +"$TAURI_RUST_VERSION" test --locked --manifest-path "$TAURI_MANIFEST" --lib
  run_step "cargo clippy" sh scripts/cargo-clippy.sh cargo +"$CLIPPY_RUST_VERSION" clippy --locked --manifest-path "$TAURI_MANIFEST" --all-targets -- -D warnings
}

run_e2e_when_decided() {
  case "$(decide_e2e "$e2e_touched")" in
    force | auto)
      run_step "e2e" pnpm e2e
      ;;
    *)
      echo "pre-push: e2e skipped — the push does not touch apps/desktop/src, packages/core/src/api or packages/shared/src (force with OPENFLEET_PREPUSH_E2E=1)"
      ;;
  esac
}

cd "$(dirname "$0")/.." || fail "cannot enter the repository root"
TAURI_RUST_VERSION=$(awk -F '"' '/^rust-version = / { print $2 }' "$TAURI_MANIFEST")
. scripts/pre-push-lib.sh

# git exports GIT_DIR & co. to hooks; tests that create temp repos would otherwise act on this one.
for git_local_variable in $(git rev-parse --local-env-vars); do
  unset "$git_local_variable"
done

# nvm's default node can be too old; Homebrew's is the one the README points to.
[ -d /opt/homebrew/bin ] && PATH="/opt/homebrew/bin:$PATH"
[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
export PATH

assert_compatible_node
command -v pnpm >/dev/null 2>&1 || fail "pnpm not found in PATH"

# By hand there is no stdin from git: the push is the current HEAD.
if [ -t 0 ]; then
  pushed_refs="HEAD $(git rev-parse HEAD) HEAD $ZERO_SHA"
else
  pushed_refs=$(cat)
fi
planned_steps=$(printf '%s\n' "$pushed_refs" | pushed_files | steps_for_files)
e2e_touched=no
is_planned e2e && e2e_touched=yes

assert_no_untracked_test_inputs
warn_about_uncommitted_test_inputs

started_at=$(date +%s)

run_step "architecture" pnpm arch
run_step "typecheck" pnpm typecheck
if is_planned desktop-build; then
  run_step "desktop build" pnpm --filter @openfleet/desktop build
else
  echo "pre-push: desktop build skipped — the push touches neither apps/desktop nor packages/shared"
fi
run_step "root tests" pnpm test
if command -v claude >/dev/null 2>&1; then
  run_step "core tests without claude" claude_free_core_tests
else
  echo "pre-push: core tests without claude skipped — claude is not installed, nothing to prove"
fi
run_step "desktop tests" pnpm --filter @openfleet/desktop test
# Slow-test report skipped: ng test prints durations only above vitest's 300 ms threshold, and that needs the verbose reporter (a flood) or a runner config.
if is_planned cargo; then
  run_cargo_checks
else
  echo "pre-push: cargo skipped — the push does not touch $TAURI_DIR"
fi
run_e2e_when_decided

if [ "$OPENFLEET_PREPUSH_DRYRUN" = "1" ]; then
  echo "pre-push: dry run: nothing executed"
else
  echo "pre-push: all checks passed in $(($(date +%s) - started_at))s"
fi
