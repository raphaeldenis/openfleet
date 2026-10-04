#!/usr/bin/env bash
set -euo pipefail

repository=''
title=''
body_file=''
base='main'

usage() {
  echo 'Usage: bash scripts/open-pr.sh --repo <owner/repo> --title <title> --body-file <file> [--base <branch>]' >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --repo) repository="$2" ;;
    --title) title="$2" ;;
    --body-file) body_file="$2" ;;
    --base) base="$2" ;;
    *) usage ;;
  esac
  shift 2
done

[ -n "$repository" ] || usage
[ -n "$title" ] || usage
[ -f "$body_file" ] || usage
[ -n "$base" ] || usage

gh pr create --repo "$repository" --title "$title" --body-file "$body_file" --base "$base"
