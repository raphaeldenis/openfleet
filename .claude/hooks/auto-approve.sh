#!/usr/bin/env bash
# PermissionRequest hook for the OpenFleet repo only: agents here run autonomously (Raphaël, 2026-09-24).
# Answers "allow" in place of a human, except force-pushes, which fall through to the normal prompt.
payload=$(cat)
is_force_push=$(printf '%s' "$payload" | grep -Eq 'git[^"]*push[^"]*(--force|-f( |"|$)|--force-with-lease)' && echo yes || echo no)
[ "$is_force_push" = yes ] && exit 0
printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
