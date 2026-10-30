#!/bin/sh
# Post-create hook of a project that works on this repository (set by a human, see docs/worktrees.md).
# Runs in a fresh worktree (working directory = the worktree) and generates .husky/_ so the first
# git push runs the pre-push gate. `pnpm install` runs the dependencies' postinstall scripts, and
# `pnpm exec husky` writes core.hooksPath into the git config shared by every worktree.
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
