#!/bin/sh

if clippy_output=$("$@" 2>&1); then
  clippy_exit_code=0
else
  clippy_exit_code=$?
fi

printf '%s\n' "$clippy_output"
clippy_warning_count=$(printf '%s\n' "$clippy_output" | awk '/^warning: / && !/generated [0-9]+ warnings?/ { count++ } END { print count + 0 }')
clippy_summary="Clippy advisory: $clippy_warning_count warning diagnostics; exit code $clippy_exit_code (does not block CI or the push). Target totals and duplicate counts appear above."
printf '%s\n' "$clippy_summary"
if [ -n "$GITHUB_STEP_SUMMARY" ]; then
  printf '%s\n' "$clippy_summary" >> "$GITHUB_STEP_SUMMARY"
fi
exit "$clippy_exit_code"
