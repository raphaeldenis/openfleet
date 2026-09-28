#!/bin/sh
# Runs the checks CI runs (.github/workflows/ci.yml) so a red CI is caught before the push.
# Invoked by .husky/pre-push; also runnable by hand: sh scripts/pre-push.sh

REQUIRED_NODE_MAJOR=26
E2E_PORTS="1420 7332"

fail() {
  echo "pre-push: $1" >&2
  exit 1
}

run_step() {
  step_name=$1
  shift
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

assert_e2e_ports_free() {
  for port in $E2E_PORTS; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      fail "e2e needs port $port but it is busy (see: lsof -nP -iTCP:$port -sTCP:LISTEN) — free it or unset OPENFLEET_PREPUSH_E2E"
    fi
  done
}

cd "$(dirname "$0")/.." || fail "cannot enter the repository root"

# git exports GIT_DIR & co. to hooks; tests that create temp repos would otherwise act on this one.
for git_local_variable in $(git rev-parse --local-env-vars); do
  unset "$git_local_variable"
done

# nvm's default node can be too old; Homebrew's is the one the README points to.
[ -d /opt/homebrew/bin ] && PATH="/opt/homebrew/bin:$PATH"
export PATH

assert_compatible_node
command -v pnpm >/dev/null 2>&1 || fail "pnpm not found in PATH"

started_at=$(date +%s)

run_step "typecheck" pnpm typecheck
run_step "root tests" pnpm test
run_step "desktop tests" pnpm --filter @openfleet/desktop test

if [ "$OPENFLEET_PREPUSH_E2E" = "1" ]; then
  assert_e2e_ports_free
  run_step "e2e" pnpm e2e
else
  echo "pre-push: e2e skipped — enable with OPENFLEET_PREPUSH_E2E=1 git push (needs free ports $E2E_PORTS)"
fi

echo "pre-push: all checks passed in $(($(date +%s) - started_at))s"
