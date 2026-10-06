#!/bin/sh

if clippy_output=$("$@" 2>&1); then
  clippy_exit_code=0
else
  clippy_exit_code=$?
fi

printf '%s\n' "$clippy_output"
clippy_diagnostic_count=$(printf '%s\n' "$clippy_output" | awk '/^(warning|error): / && !/generated [0-9]+ warnings?/ && !/^error: could not compile / { count++ } END { print count + 0 }')
clippy_summary="Clippy blocking: $clippy_diagnostic_count warning or error diagnostics; exit code $clippy_exit_code. Target totals and duplicate counts appear above."
printf '%s\n' "$clippy_summary"
if [ -n "$GITHUB_STEP_SUMMARY" ]; then
  printf '%s\n' "$clippy_summary" >> "$GITHUB_STEP_SUMMARY"
fi
exit "$clippy_exit_code"
