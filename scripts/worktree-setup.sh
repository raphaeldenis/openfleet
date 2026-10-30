#!/bin/sh
# Runs in a fresh OpenFleet worktree (working directory = the worktree): installs the
# dependencies and generates .husky/_, so the first git push runs the pre-push gate.
set -eu

if ! command -v pnpm >/dev/null 2>&1; then
  echo "worktree-setup: pnpm is not on PATH" >&2
  exit 127
fi

pnpm install --frozen-lockfile
pnpm exec husky

if [ ! -f .husky/_/pre-push ]; then
  echo "worktree-setup: .husky/_/pre-push is missing after husky" >&2
  exit 1
fi
