#!/usr/bin/env bash
set -euo pipefail

worktree="${1:-${WORKTREE:-}}"
if [ -z "$worktree" ] || [ "$#" -gt 1 ]; then
  echo 'Usage: bash scripts/verify.sh <worktree>' >&2
  exit 2
fi
worktree="${worktree%/}"
source "$(dirname "${BASH_SOURCE[0]}")/shim-guards.sh"
require_git_worktree "$worktree"
if [ ! -f "$worktree/package.json" ]; then
  echo 'verify: worktree must contain package.json' >&2
  exit 2
fi

pnpm --dir "$worktree" arch
pnpm --dir "$worktree" typecheck
pnpm --dir "$worktree" --filter @openfleet/core test
