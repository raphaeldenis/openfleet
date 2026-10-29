#!/usr/bin/env python3
"""PreToolUse(Bash) guard: refuses git commands that rewrite history, discard work or force a push.

Exit 2 with a one-line reason on stderr refuses the command; exit 0 lets it through.
The guard fails closed: an unreadable payload or a git command it cannot parse is refused.
"""
import json
import os
import re
import shlex
import subprocess
import sys

PROTECTED_BRANCHES = {"main", "master"}
SEGMENT_SEPARATORS = ("&&", "||", ";", "\n", "|", "&")
SHELL_PROGRAMS = {"sh", "bash", "zsh", "dash", "ksh"}
COMMAND_WRAPPERS = {"command", "env", "rtk", "proxy", "sudo", "time", "nice", "exec", "nohup"}
GIT_GLOBAL_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
SHELL_INLINE_SCRIPT_FLAGS = {"-c", "-lc", "-ic", "-ec"}


class Refusal(Exception):
    """Carries the one-line reason shown to the agent."""


def refuse(rule, explanation):
    raise Refusal(f"BLOCKED by git-guardrails ({rule}): {explanation}")


def split_outside_quotes(command):
    segments = []
    current = []
    quote = None
    index = 0
    while index < len(command):
        char = command[index]
        if char == "\\" and quote != "'":
            current.append(command[index:index + 2])
            index += 2
            continue
        if quote:
            quote = None if char == quote else quote
        elif char in ("'", '"'):
            quote = char
        else:
            separator = next((s for s in SEGMENT_SEPARATORS if command.startswith(s, index)), None)
            if separator:
                segments.append("".join(current))
                current = []
                index += len(separator)
                continue
        current.append(char)
        index += 1
    segments.append("".join(current))
    return [segment.strip() for segment in segments if segment.strip()]


def is_environment_assignment(token):
    return re.fullmatch(r"[A-Za-z_]\w*=.*", token) is not None


def program_name(token):
    return token.rsplit("/", 1)[-1]


def strip_wrappers(tokens):
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if is_environment_assignment(token) or program_name(token) in COMMAND_WRAPPERS:
            index += 1
            continue
        break
    return tokens[index:]


def split_git_invocation(tokens):
    """Returns (subcommand, arguments) of a `git ...` token list, skipping global options."""
    index = 1
    while index < len(tokens):
        token = tokens[index]
        takes_next_token = token in GIT_GLOBAL_OPTIONS_WITH_VALUE
        if takes_next_token:
            index += 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        return token, tokens[index + 1:]
    return None, []


def short_flag_letters(arguments):
    return {letter for a in arguments if re.fullmatch(r"-[A-Za-z]+", a) for letter in a[1:]}


def has_long_flag(arguments, *names):
    return any(a == name or a.startswith(f"{name}=") for a in arguments for name in names)


def positionals(arguments):
    return [a for a in arguments if not a.startswith("-")]


def current_branch(working_directory):
    """Returns the checked-out branch name; refuses when HEAD cannot be read (detached or no repository)."""
    try:
        result = subprocess.run(
            ["git", "-C", working_directory or ".", "symbolic-ref", "--short", "HEAD"],
            capture_output=True, text=True, timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        result = None
    branch = result.stdout.strip() if result and result.returncode == 0 else ""
    if not branch:
        refuse("branch-unreadable", "the current branch cannot be read, so the command cannot be checked.")
    return branch


def names_protected_branch(refspec):
    destination = refspec.lstrip("+").split(":")[-1]
    branch_name = destination.removeprefix("refs/heads/")
    return branch_name in PROTECTED_BRANCHES


def check_push(arguments, working_directory):
    letters = short_flag_letters(arguments)
    if has_long_flag(arguments, "--no-verify"):
        refuse("no-verify", "git push --no-verify skips the husky pre-push checks, fix what the hook reports.")
    is_forced = "f" in letters or has_long_flag(arguments, "--force", "--force-with-lease", "--force-if-includes")
    if is_forced:
        refuse("push-force", "force push is forbidden, push normally or ask your manager.")
    has_forcing_refspec = any(a.startswith("+") for a in positionals(arguments))
    if has_forcing_refspec:
        refuse("push-force", "a +refspec is a force push, push normally or ask your manager.")
    if "d" in letters or has_long_flag(arguments, "--delete", "--mirror", "--prune"):
        refuse("push-delete", "deleting or mirroring remote refs is forbidden, ask your manager.")

    refspecs = positionals(arguments)[1:]
    deletes_remote_branch = any(r.startswith(":") for r in refspecs)
    if deletes_remote_branch:
        refuse("push-delete", "a :branch refspec deletes a remote branch, ask your manager.")
    pushes_current_branch = not refspecs or "HEAD" in refspecs
    targets_protected_branch = any(names_protected_branch(r) for r in refspecs)
    is_on_protected_branch = pushes_current_branch and current_branch(working_directory) in PROTECTED_BRANCHES
    if targets_protected_branch or is_on_protected_branch:
        refuse("push-protected-branch", "pushing to main or master is forbidden, push your own branch and open a PR.")


def check_commit(arguments, _working_directory):
    skips_hooks = "n" in short_flag_letters(arguments) or has_long_flag(arguments, "--no-verify")
    if skips_hooks:
        refuse("no-verify", "git commit --no-verify / -n skips commitlint and husky, fix what the hook reports.")


def check_reset(arguments, _working_directory):
    if "--hard" in arguments:
        refuse("reset-hard", "git reset --hard throws away work, use git restore --staged or commit first.")


def check_clean(arguments, _working_directory):
    is_dry_run = "n" in short_flag_letters(arguments) or has_long_flag(arguments, "--dry-run")
    is_forced = "f" in short_flag_letters(arguments) or has_long_flag(arguments, "--force")
    if is_forced and not is_dry_run:
        refuse("clean-force", "git clean -f deletes untracked files, remove them one by one with rm.")


def check_rebase(arguments, working_directory):
    branch_being_rebased = positionals(arguments)[1:2]
    rebases_named_protected_branch = any(b in PROTECTED_BRANCHES for b in branch_being_rebased)
    rebases_current_protected_branch = not branch_being_rebased and current_branch(working_directory) in PROTECTED_BRANCHES
    if rebases_named_protected_branch or rebases_current_protected_branch:
        refuse("rebase-protected-branch", "never rebase main or master, it is shared.")


def check_branch(arguments, _working_directory):
    letters = short_flag_letters(arguments)
    deletes = "d" in letters or has_long_flag(arguments, "--delete")
    forces = "f" in letters or has_long_flag(arguments, "--force")
    if "D" in letters or (deletes and forces):
        refuse("branch-force-delete", "git branch -D is forbidden, use git branch -d on a merged branch.")


def check_stash(arguments, _working_directory):
    if positionals(arguments)[:1] in (["drop"], ["clear"]):
        refuse("stash-drop", "dropping a stash loses work, apply it and leave the entry.")


def check_checkout(arguments, _working_directory):
    discards_by_pathspec = "--" in arguments or "." in positionals(arguments)
    forces = "f" in short_flag_letters(arguments) or has_long_flag(arguments, "--force")
    if discards_by_pathspec or forces:
        refuse("checkout-discard", "git checkout -- <path>, . and -f discard changes, commit or copy them first.")


def check_restore(arguments, _working_directory):
    restores_index_only = ("S" in short_flag_letters(arguments) or has_long_flag(arguments, "--staged")) and not (
        "W" in short_flag_letters(arguments) or has_long_flag(arguments, "--worktree")
    )
    if not restores_index_only:
        refuse("restore-discard", "git restore discards working-tree changes, only --staged is allowed.")


def check_worktree(arguments, _working_directory):
    is_removal = positionals(arguments)[:1] == ["remove"]
    forces = "f" in short_flag_letters(arguments) or has_long_flag(arguments, "--force")
    if is_removal and forces:
        refuse("worktree-remove-force", "git worktree remove --force can lose changes, remove without --force.")


def refuse_history_rewrite(_arguments, _working_directory):
    refuse("history-rewrite", "filter-branch and filter-repo rewrite history, ask your manager.")


GIT_SUBCOMMAND_CHECKS = {
    "push": check_push,
    "commit": check_commit,
    "reset": check_reset,
    "clean": check_clean,
    "rebase": check_rebase,
    "branch": check_branch,
    "stash": check_stash,
    "checkout": check_checkout,
    "restore": check_restore,
    "worktree": check_worktree,
    "filter-branch": refuse_history_rewrite,
    "filter-repo": refuse_history_rewrite,
}


def inline_shell_script(tokens):
    """Returns the script given to `sh -c '...'`, or None when the tokens are not an inline shell."""
    if program_name(tokens[0]) not in SHELL_PROGRAMS:
        return None
    for index, token in enumerate(tokens[1:], start=1):
        has_script_after = index + 1 < len(tokens)
        if token in SHELL_INLINE_SCRIPT_FLAGS and has_script_after:
            return tokens[index + 1]
    return None


def is_unanalysable_program(tokens):
    program = tokens[0]
    is_eval = program_name(program) == "eval"
    is_computed_program = program.startswith(("$", "`", "("))
    is_base64_decoder = program_name(program) == "base64"
    is_shell_reading_stdin = program_name(program) in SHELL_PROGRAMS and inline_shell_script(tokens) is None
    return is_eval or is_computed_program or is_base64_decoder or is_shell_reading_stdin


def check_segment(segment, working_directory):
    try:
        tokens = strip_wrappers(shlex.split(segment))
    except ValueError:
        if re.search(r"\bgit\b", segment):
            refuse("unparsable", "this git command cannot be analysed, simplify the quoting.")
        return
    if not tokens:
        return

    if is_unanalysable_program(tokens):
        refuse("unanalysable", "eval, variables, base64 and piped shells hide the git command, write it out plainly.")

    script = inline_shell_script(tokens)
    if script is not None:
        check_command(script, working_directory)
        return
    if program_name(tokens[0]) != "git":
        return

    subcommand, arguments = split_git_invocation(tokens)
    check_for_subcommand = GIT_SUBCOMMAND_CHECKS.get(subcommand)
    if check_for_subcommand:
        check_for_subcommand(arguments, working_directory)


def check_command(command, working_directory):
    for segment in split_outside_quotes(command):
        check_segment(segment, working_directory)


def main():
    try:
        payload = json.load(sys.stdin)
        command = (payload.get("tool_input") or {}).get("command") or ""
        working_directory = payload.get("cwd") or os.getcwd()
        if "git" not in command:
            return 0
        check_command(command, working_directory)
    except Refusal as refusal:
        print(refusal, file=sys.stderr)
        return 2
    except Exception as error:
        print(f"BLOCKED by git-guardrails (guard-error): {type(error).__name__}, failing closed.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
