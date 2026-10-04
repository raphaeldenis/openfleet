#!/usr/bin/env bash

require_git_worktree() {
  local directory="$1"
  local inside_work_tree
  inside_work_tree="$(git -C "$directory" rev-parse --is-inside-work-tree 2>/dev/null)" || inside_work_tree=''
  if [ "$inside_work_tree" != 'true' ]; then
    echo "not a git worktree: $directory" >&2
    exit 2
  fi
}

require_published_branch() {
  local directory="$1"
  local branch="$2"
  local local_commit remote_commit
  local_commit="$(git -C "$directory" rev-parse --verify --quiet "refs/heads/$branch")" || local_commit=''
  remote_commit="$(git -C "$directory" rev-parse --verify --quiet "refs/remotes/origin/$branch")" || remote_commit=''
  if [ -z "$local_commit" ] || [ "$local_commit" != "$remote_commit" ]; then
    echo "branch not published on origin: $branch (push it first, then fetch)" >&2
    exit 2
  fi
}
