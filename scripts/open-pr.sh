#!/usr/bin/env bash
set -euo pipefail

repository=''
title=''
body_file=''
base='main'
head=''
worktree='.'

usage() {
  echo 'Usage: bash scripts/open-pr.sh --repo <owner/repo> --title <title> --body-file <file> --head <published-branch> [--base <branch>] [--worktree <dir>]' >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --repo) repository="$2" ;;
    --title) title="$2" ;;
    --body-file) body_file="$2" ;;
    --base) base="$2" ;;
    --head) head="$2" ;;
    --worktree) worktree="$2" ;;
    *) usage ;;
  esac
  shift 2
done

[ -n "$repository" ] || usage
[ -n "$title" ] || usage
[ -f "$body_file" ] || usage
[ -n "$base" ] || usage
[ -n "$head" ] || usage

source "$(dirname "${BASH_SOURCE[0]}")/shim-guards.sh"
require_git_worktree "$worktree"
require_published_branch "$worktree" "$head"

gh pr create --repo "$repository" --title "$title" --body-file "$body_file" --base "$base" --head "$head"
