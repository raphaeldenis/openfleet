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
from collections import namedtuple

PROTECTED_BRANCHES = {"main", "master"}
SEGMENT_SEPARATORS = ("&&", "||", ";", "\n", "|", "&")
SHELL_PROGRAMS = {"sh", "bash", "zsh", "dash", "ksh"}
COMMAND_WRAPPERS = {"command", "env", "export", "rtk", "proxy", "sudo", "time", "nice", "exec", "nohup"}
SHELL_GROUPING_KEYWORDS = {"{", "!", "if", "then", "do", "else", "elif", "while", "until"}
GIT_GLOBAL_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}
HOOK_DISABLING_VARIABLE = re.compile(r"HUSKY|^GIT_(CONFIG|DIR|WORK_TREE)", re.IGNORECASE)
SHELL_INLINE_SCRIPT_FLAGS = {"-c", "-lc", "-ic", "-ec"}


HEREDOC_START = re.compile(r"<<(-?)\s*(['\"]?)([A-Za-z_][\w.-]*)\2")
Heredoc = namedtuple("Heredoc", ["delimiter", "strips_tabs", "is_quoted"])


class Refusal(Exception):
    """Carries the one-line reason shown to the agent."""


def refuse(rule, explanation):
    raise Refusal(f"BLOCKED by git-guardrails ({rule}): {explanation}")


def skip_heredoc_bodies(command, start, heredocs):
    """Returns the index just after the bodies of `heredocs`, which are text and not commands."""
    index = start
    for heredoc in heredocs:
        body_lines = []
        while index < len(command):
            line_end = command.find("\n", index)
            line_end = len(command) if line_end == -1 else line_end
            line = command[index:line_end]
            index = line_end + 1
            terminator_candidate = line.lstrip("\t") if heredoc.strips_tabs else line
            if terminator_candidate == heredoc.delimiter:
                break
            body_lines.append(line)
        body = "\n".join(body_lines)
        runs_substitution = "$(" in body or "`" in body
        if not heredoc.is_quoted and runs_substitution and re.search(r"\bgit\b", body):
            refuse("unanalysable", "a command substitution inside an unquoted heredoc hides a git command, quote the heredoc delimiter.")
    return index


def refuse_unless_delimiter_is_a_whole_word(command, delimiter_end):
    """Refuses a heredoc whose delimiter is glued to more text, because bash then reads a different delimiter."""
    next_char = command[delimiter_end:delimiter_end + 1]
    ends_the_word = next_char == "" or next_char.isspace() or next_char in ";|&)"
    if not ends_the_word:
        refuse("unanalysable", "a heredoc delimiter followed by quotes or other text hides which lines are commands, write a bare delimiter.")


def is_inside_arithmetic(text_before):
    """Returns True when `<<` after `text_before` is a shift: inside an open $(( )), (( )) or $[ ], or after `let`."""
    has_open_double_parenthesis = text_before.count("((") > text_before.count("))")
    has_open_bracket_arithmetic = text_before.count("$[") > text_before.count("]")
    is_let_command = re.match(r"\s*let\b", text_before) is not None
    return has_open_double_parenthesis or has_open_bracket_arithmetic or is_let_command


def starts_a_comment(command, index):
    previous_char = command[index - 1] if index > 0 else "\n"
    return command[index] == "#" and (previous_char.isspace() or previous_char in ";|&(")


def split_outside_quotes(command):
    segments = []
    current = []
    heredocs = []
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
        elif command.startswith("<<<", index):
            current.append("<<<")
            index += 3
            continue
        elif command.startswith("<<", index):
            heredoc_start = HEREDOC_START.match(command, index)
            if heredoc_start and not is_inside_arithmetic("".join(current)):
                refuse_unless_delimiter_is_a_whole_word(command, heredoc_start.end())
                strips_tabs, delimiter_quote, delimiter = heredoc_start.groups()
                heredocs.append(Heredoc(delimiter, bool(strips_tabs), bool(delimiter_quote)))
            current.append("<<")
            index += 2
            continue
        elif char in ("'", '"'):
            quote = char
        elif starts_a_comment(command, index):
            comment_end = command.find("\n", index)
            index = len(command) if comment_end == -1 else comment_end
            continue
        else:
            separator = next((s for s in SEGMENT_SEPARATORS if command.startswith(s, index)), None)
            if separator:
                segments.append("".join(current))
                current = []
                index += len(separator)
                if separator == "\n" and heredocs:
                    index = skip_heredoc_bodies(command, index, heredocs)
                    heredocs = []
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
    """Returns (environment assignments, remaining tokens) once leading assignments and command wrappers are skipped."""
    assignments = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if is_environment_assignment(token):
            assignments.append(token)
        elif token not in SHELL_GROUPING_KEYWORDS and program_name(token) not in COMMAND_WRAPPERS:
            break
        index += 1
    return assignments, tokens[index:]


def disables_repository_hooks(assignments):
    names = [assignment.split("=", 1)[0] for assignment in assignments]
    return any(HOOK_DISABLING_VARIABLE.search(name) for name in names)


def mentions_hooks_path(text):
    return "core.hookspath" in text.lower()


def resolve_directory(base_directory, path):
    """Returns the absolute directory `path` designates from `base_directory`, or None when it cannot be known statically."""
    is_computed = any(marker in path for marker in ("$", "`", "*", "?")) or path == "-"
    if base_directory is None or is_computed:
        return None
    return os.path.normpath(os.path.join(base_directory, os.path.expanduser(path)))


def split_git_invocation(tokens, working_directory):
    """Returns (subcommand, arguments, repository) of a `git ...` token list, skipping global options.

    `repository` is the list of git options (-C, --git-dir) that locate the repository the command runs in,
    or None when that location cannot be determined.
    """
    directory = working_directory
    git_directory = False
    index = 1
    while index < len(tokens):
        token = tokens[index]
        value = tokens[index + 1] if index + 1 < len(tokens) else ""
        takes_value = token in GIT_GLOBAL_OPTIONS_WITH_VALUE
        sets_hooks_path = mentions_hooks_path(token) or (takes_value and mentions_hooks_path(value))
        if sets_hooks_path:
            refuse("hooks-path", "overriding core.hooksPath skips the repository hooks, fix what the hook reports.")
        if token == "-C":
            directory = resolve_directory(directory, value)
            index += 2
        elif token == "--git-dir":
            git_directory = resolve_directory(directory, value)
            index += 2
        elif token.startswith("--git-dir="):
            git_directory = resolve_directory(directory, token.split("=", 1)[1])
            index += 1
        elif takes_value:
            index += 2
        elif token.startswith("-"):
            index += 1
        else:
            return token, tokens[index + 1:], locate_repository(directory, git_directory)
    return None, [], None


def locate_repository(directory, git_directory):
    """Returns the git options locating the repository; `git_directory` is False when no --git-dir was given."""
    git_directory_unresolved = git_directory is None
    if directory is None or git_directory_unresolved:
        return None
    return ["-C", directory] + (["--git-dir", git_directory] if git_directory else [])


def short_flag_letters(arguments):
    return {letter for a in arguments if re.fullmatch(r"-[A-Za-z]+", a) for letter in a[1:]}


def has_long_flag(arguments, *names):
    return any(a == name or a.startswith(f"{name}=") for a in arguments for name in names)


def positionals(arguments):
    return [a for a in arguments if not a.startswith("-")]


def current_branch(repository):
    """Returns the branch checked out in `repository`; refuses when it cannot be located or HEAD cannot be read."""
    if repository is None:
        refuse("branch-unreadable", "the directory the git command runs in cannot be resolved, so the command cannot be checked.")
    try:
        result = subprocess.run(
            ["git", *repository, "symbolic-ref", "--short", "HEAD"],
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


def check_push(arguments, repository):
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
    is_on_protected_branch = pushes_current_branch and current_branch(repository) in PROTECTED_BRANCHES
    if targets_protected_branch or is_on_protected_branch:
        refuse("push-protected-branch", "pushing to main or master is forbidden, push your own branch and open a PR.")


def check_commit(arguments, _repository):
    skips_hooks = "n" in short_flag_letters(arguments) or has_long_flag(arguments, "--no-verify")
    if skips_hooks:
        refuse("no-verify", "git commit --no-verify / -n skips commitlint and husky, fix what the hook reports.")


def check_reset(arguments, _repository):
    if "--hard" in arguments:
        refuse("reset-hard", "git reset --hard throws away work, use git restore --staged or commit first.")


def check_clean(arguments, _repository):
    is_dry_run = "n" in short_flag_letters(arguments) or has_long_flag(arguments, "--dry-run")
    is_forced = "f" in short_flag_letters(arguments) or has_long_flag(arguments, "--force")
    if is_forced and not is_dry_run:
        refuse("clean-force", "git clean -f deletes untracked files, remove them one by one with rm.")


def check_rebase(arguments, repository):
    branch_being_rebased = positionals(arguments)[1:2]
    rebases_named_protected_branch = any(b in PROTECTED_BRANCHES for b in branch_being_rebased)
    rebases_current_protected_branch = not branch_being_rebased and current_branch(repository) in PROTECTED_BRANCHES
    if rebases_named_protected_branch or rebases_current_protected_branch:
        refuse("rebase-protected-branch", "never rebase main or master, it is shared.")


def check_branch(arguments, _repository):
    letters = short_flag_letters(arguments)
    deletes = "d" in letters or has_long_flag(arguments, "--delete")
    forces = "f" in letters or has_long_flag(arguments, "--force")
    if "D" in letters or (deletes and forces):
        refuse("branch-force-delete", "git branch -D is forbidden, use git branch -d on a merged branch.")
    moves_protected_branch = forces and any(name in PROTECTED_BRANCHES for name in positionals(arguments)[:1])
    if moves_protected_branch:
        refuse("branch-force-move", "git branch -f main moves a shared branch, ask your manager.")


def check_switch(arguments, _repository):
    discards = "f" in short_flag_letters(arguments) or has_long_flag(arguments, "--force", "--discard-changes")
    if discards:
        refuse("switch-discard", "git switch -f and --discard-changes throw away local changes, commit or copy them first.")


def check_stash(arguments, _repository):
    if positionals(arguments)[:1] in (["drop"], ["clear"]):
        refuse("stash-drop", "dropping a stash loses work, apply it and leave the entry.")


def check_checkout(arguments, _repository):
    discards_by_pathspec = "--" in arguments or "." in positionals(arguments)
    forces = "f" in short_flag_letters(arguments) or has_long_flag(arguments, "--force")
    if discards_by_pathspec or forces:
        refuse("checkout-discard", "git checkout -- <path>, . and -f discard changes, commit or copy them first.")


def check_restore(arguments, _repository):
    restores_index_only = ("S" in short_flag_letters(arguments) or has_long_flag(arguments, "--staged")) and not (
        "W" in short_flag_letters(arguments) or has_long_flag(arguments, "--worktree")
    )
    if not restores_index_only:
        refuse("restore-discard", "git restore discards working-tree changes, only --staged is allowed.")


def check_config(arguments, _repository):
    if any(mentions_hooks_path(a) for a in arguments):
        refuse("hooks-path", "git config core.hooksPath turns the repository hooks off, fix what the hook reports.")


def check_worktree(arguments, _repository):
    is_removal = positionals(arguments)[:1] == ["remove"]
    forces = "f" in short_flag_letters(arguments) or has_long_flag(arguments, "--force")
    if is_removal and forces:
        refuse("worktree-remove-force", "git worktree remove --force can lose changes, remove without --force.")


def refuse_history_rewrite(_arguments, _repository):
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
    "switch": check_switch,
    "restore": check_restore,
    "worktree": check_worktree,
    "config": check_config,
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


class ShellState:
    """What earlier commands leave behind: the directory the next command runs in (None once a `cd`
    makes it impossible to know) and whether a hook-disabling variable is exported."""

    def __init__(self, working_directory, hook_variable_exported=False):
        self.working_directory = working_directory
        self.hook_variable_exported = hook_variable_exported

    def nested(self):
        return ShellState(self.working_directory, self.hook_variable_exported)


def change_directory(tokens, shell_state):
    targets = [t for t in tokens[1:] if not t.startswith("-") or t == "-"]
    target = targets[0] if targets else "~"
    shell_state.working_directory = resolve_directory(shell_state.working_directory, target)


def check_unparsable_segment(segment, shell_state):
    """Refuses a segment whose quoting is broken only when its first word is git or leads to git."""
    _, tokens = strip_wrappers(segment.split())
    first_program = program_name(tokens[0]) if tokens else ""
    if first_program in ("cd", "pushd"):
        shell_state.working_directory = None
    leads_to_git = first_program == "git" or first_program in SHELL_PROGRAMS
    if leads_to_git:
        refuse("unparsable", "this git command cannot be analysed, simplify the quoting.")


def check_segment(segment, shell_state):
    try:
        assignments, tokens = strip_wrappers(shlex.split(segment))
    except ValueError:
        check_unparsable_segment(segment, shell_state)
        return
    sets_hook_variable = disables_repository_hooks(assignments)
    if not tokens:
        shell_state.hook_variable_exported = shell_state.hook_variable_exported or sets_hook_variable
        return

    if is_unanalysable_program(tokens):
        refuse("unanalysable", "eval, variables, base64 and piped shells hide the git command, write it out plainly.")

    script = inline_shell_script(tokens)
    if script is not None:
        check_command(script, shell_state.nested())
        return
    if program_name(tokens[0]) in ("cd", "pushd"):
        change_directory(tokens, shell_state)
        return
    if program_name(tokens[0]) != "git":
        return
    if sets_hook_variable or shell_state.hook_variable_exported:
        refuse("hooks-skipped", "HUSKY, GIT_CONFIG*, GIT_DIR and GIT_WORK_TREE variables skip or redirect the repository hooks, unset them.")

    subcommand, arguments, repository = split_git_invocation(tokens, shell_state.working_directory)
    check_for_subcommand = GIT_SUBCOMMAND_CHECKS.get(subcommand)
    if check_for_subcommand:
        check_for_subcommand(arguments, repository)


def check_command(command, shell_state):
    for segment in split_outside_quotes(command):
        check_segment(segment, shell_state)


def main():
    try:
        payload = json.load(sys.stdin)
        command = (payload.get("tool_input") or {}).get("command") or ""
        working_directory = payload.get("cwd") or os.getcwd()
        if "git" not in command:
            return 0
        check_command(command, ShellState(working_directory))
    except Refusal as refusal:
        print(refusal, file=sys.stderr)
        return 2
    except Exception as error:
        print(f"BLOCKED by git-guardrails (guard-error): {type(error).__name__}, failing closed.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
