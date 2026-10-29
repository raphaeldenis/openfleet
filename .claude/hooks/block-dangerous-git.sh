#!/bin/bash
# PreToolUse(Bash) entry point; the analysis lives in block-dangerous-git.py. Fails closed when python3 is missing.

if ! command -v python3 >/dev/null 2>&1; then
  echo "BLOCKED by git-guardrails (guard-error): python3 not found, failing closed." >&2
  exit 2
fi

exec python3 "$(dirname "$0")/block-dangerous-git.py"
