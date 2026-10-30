# Git guardrails

`.claude/hooks/block-dangerous-git.py` is a PreToolUse(Bash) hook. It refuses git commands that rewrite history, discard work or force a push, and fails closed on a payload or a git command it cannot parse. Tests: `scripts/block-dangerous-git.test.ts`.

The hook is a best-effort deterrent, not a complete shell filter. The real guarantee is GitHub branch protection on `main` (no force-push, pull request required) and the absence of delete rights, both set by Raphael.

## Known limits

Classes of command the hook does not cover:

- Substitution in an argument: `echo $(git reset --hard)`, backticks, `git commit -m "$(git push -f)"`.
- Obfuscated git names: `g''it push -f`, `"g"it push -f`, `$'\x67it' push -f`.
- Command wrappers: `timeout`, `sudo`, `env -i` / `-u` / `-S`, `xargs`, `find -exec`, the `command` builtin, `case ... esac`, `python -c` with `os.system`.
- Aliases: `git -c alias.x='!git push -f' x`, `git config alias.rh ...` followed by `git rh`.
- Option abbreviations: `--no-ver`, `--forc*`.
- Line continuation: `git reset \` followed by a newline and `--hard`.
- Nested quotes inside a double-quoted `$(...)`.

## Known over-refusals

- A heredoc that writes a file and has a body line starting with a dangerous git command is refused.
- `git -C dir commit -m "$(cat <<'EOF' ...)"` is refused; only the plain `git commit -m "$(cat <<'EOF' ...)"` form is accepted.
