#!/usr/bin/env bash
set -euo pipefail

worktree="${1:-${WORKTREE:-}}"
if [ -z "$worktree" ] || [ "$#" -gt 1 ]; then
  echo 'Usage: bash scripts/verify.sh <worktree>' >&2
  exit 2
fi
if [ ! -f "$worktree/package.json" ]; then
  echo 'verify: worktree must contain package.json' >&2
  exit 2
fi
worktree="${worktree%/}"

pnpm --dir "$worktree" arch
pnpm --dir "$worktree" typecheck
pnpm --dir "$worktree" --filter @openfleet/core test
