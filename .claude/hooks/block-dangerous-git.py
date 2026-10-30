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
COMMAND_WRAPPERS = {"command", "env", "export", "rtk", "proxy", "sudo", "time", "nice", "exec", "nohup"}
SHELL_GROUPING_KEYWORDS = {"{", "!", "if", "then", "do", "else", "elif", "while", "until"}
GIT_GLOBAL_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}
HOOK_DISABLING_VARIABLE = re.compile(r"HUSKY|^GIT_(CONFIG|DIR|WORK_TREE)", re.IGNORECASE)
SHELL_INLINE_SCRIPT_FLAGS = {"-c", "-lc", "-ic", "-ec"}


COMMIT_MESSAGE_PLACEHOLDER = "HEREDOC_COMMIT_MESSAGE_BODY"
COMMIT_MESSAGE_HEREDOC_START = re.compile(r"\$\(\s*cat\s+<<(-?)[ \t]*(['\"])([A-Za-z_][\w.-]*)\2[ \t]*\n")
ARITHMETIC_OF_DIGITS_ONLY = re.compile(r"\(\([\d\s<+*-]*\)\)")
QUOTED_STRING = re.compile(r"\"[^\"]*\"|'[^']*'")
COMMENT_OR_SUBSTITUTION_CHARACTERS = ("#", "`", "(")
HEREDOC_OPERATOR_RUN =re.compile(r"<{2,}")
HERE_STRING_OPERATOR_LENGTH = 3
PIECE_SEPARATORS = re.compile(r"&&|\|\||[;\n|&]")
MESSAGE_PROGRAMS_WITH_SUBCOMMANDS = {"git": {"commit"}, "gh": {"pr", "issue"}}


class Refusal(Exception):
    """Carries the one-line reason shown to the agent."""


def refuse(rule, explanation):
    raise Refusal(f"BLOCKED by git-guardrails ({rule}): {explanation}")


def contains_heredoc_candidate(command):
    """Returns True when `command` has a `<<` that is neither a here-string nor a shift of plain digits."""
    without_digit_arithmetic = ARITHMETIC_OF_DIGITS_ONLY.sub(" ", command)
    operator_runs = HEREDOC_OPERATOR_RUN.findall(without_digit_arithmetic)
    return any(len(run) != HERE_STRING_OPERATOR_LENGTH for run in operator_runs)


def is_opening_a_live_double_quoted_string(text_before_substitution):
    """Returns True when the text ends with a `"` that opens a double-quoted string in plain, simply quoted text."""
    ends_with_double_quote = text_before_substitution.endswith('"')
    has_exotic_quoting = "\\" in text_before_substitution or "$'" in text_before_substitution or "<<" in text_before_substitution
    if not ends_with_double_quote or has_exotic_quoting:
        return False
    text_before_quote = text_before_substitution[:-1]
    try:
        shlex.split(text_before_quote)
    except ValueError:
        return False
    text_outside_quoted_strings = QUOTED_STRING.sub(" ", text_before_quote)
    has_comment_or_substitution_outside_quotes = any(char in text_outside_quoted_strings for char in COMMENT_OR_SUBSTITUTION_CHARACTERS)
    return not has_comment_or_substitution_outside_quotes


def find_heredoc_end(command, body_start, delimiter, strips_tabs):
    """Returns the index just after the terminator line of a heredoc body, or None when no line terminates it."""
    index = body_start
    while index <= len(command):
        line_end = command.find("\n", index)
        line_end = len(command) if line_end == -1 else line_end
        line = command[index:line_end]
        terminator_candidate = line.lstrip("\t") if strips_tabs else line
        if terminator_candidate == delimiter:
            return line_end + 1
        if line_end == len(command):
            return None
        index = line_end + 1
    return None


def replace_commit_message_heredocs(command):
    """Returns `command` with each `"$(cat <<'DELIM' ... DELIM )"` message replaced by a placeholder, and how many were replaced."""
    replaced_count = 0
    while True:
        start_match = COMMIT_MESSAGE_HEREDOC_START.search(command)
        if not start_match:
            return command, replaced_count
        text_before = command[:start_match.start()]
        strips_tabs, _, delimiter = start_match.groups()
        body_end = find_heredoc_end(command, start_match.end(), delimiter, bool(strips_tabs))
        closing = re.match(r"\s*\)\"", command[body_end:]) if body_end is not None else None
        if not closing or not is_opening_a_live_double_quoted_string(text_before):
            return command, replaced_count
        command = text_before + COMMIT_MESSAGE_PLACEHOLDER + command[body_end + closing.end() - 1:]
        replaced_count += 1


def refuse_unless_placeholders_sit_in_a_commit_or_pr_command(command):
    for segment in split_outside_quotes(command):
        if COMMIT_MESSAGE_PLACEHOLDER not in segment:
            continue
        try:
            _, tokens = strip_wrappers(shlex.split(segment))
        except ValueError:
            tokens = []
        subcommands = MESSAGE_PROGRAMS_WITH_SUBCOMMANDS.get(program_name(tokens[0]) if tokens else "", set())
        is_message_command = len(tokens) > 1 and tokens[1] in subcommands
        if not is_message_command:
            refuse("unanalysable", "a heredoc message is only accepted inside git commit or gh pr/issue, write the command plainly.")


def refuse_dangerous_git_in_heredoc_candidate(command, shell_state):
    """Reads every line and piece of `command` as command text, ignoring quotes, because heredoc bodies and what follows them cannot be told apart."""
    for piece in PIECE_SEPARATORS.split(command):
        hides_git_in_substitution = ("$(" in piece or "`" in piece) and re.search(r"\bgit\b", piece)
        try:
            if hides_git_in_substitution:
                refuse("unanalysable", "a command substitution mentions git.")
            check_segment(piece.strip(), shell_state.nested())
        except Refusal as inner:
            reason = str(inner).split("): ", 1)[-1]
            refuse(
                "heredoc-text",
                f"the heredoc body or the lines after it contain a dangerous git command ({reason}) "
                "or cannot be analysed (unanalysable), use a quoted <<'EOF' commit-message form or put the text in a file.",
            )


def starts_a_comment(command, index):
    previous_char = command[index - 1] if index > 0 else "\n"
    return command[index] == "#" and (previous_char.isspace() or previous_char in ";|&(")


def split_outside_quotes(command):
    segments = []
    current = []
    quote = None
    is_ansi_c_quote = False
    index = 0
    while index < len(command):
        char = command[index]
        if char == "\\" and (quote != "'" or is_ansi_c_quote):
            current.append(command[index:index + 2])
            index += 2
            continue
        if quote:
            closes_quote = char == quote
            quote = None if closes_quote else quote
            is_ansi_c_quote = is_ansi_c_quote and not closes_quote
        elif command.startswith("$'", index):
            current.append("$'")
            quote = "'"
            is_ansi_c_quote = True
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
    body_free_command, replaced_count = replace_commit_message_heredocs(command)
    if replaced_count:
        refuse_unless_placeholders_sit_in_a_commit_or_pr_command(body_free_command)
    if contains_heredoc_candidate(body_free_command):
        refuse_dangerous_git_in_heredoc_candidate(body_free_command, shell_state)
    for segment in split_outside_quotes(body_free_command):
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
