#!/usr/bin/env bash
# PermissionRequest hook for the OpenFleet repo only: agents here run autonomously (Raphaël, 2026-09-24).
# Answers "allow" in place of a human, EXCEPT what the approved permission excludes, which falls through to
# the normal prompt: force-pushes, sudo, machine-global config (nvm aliases, brew, shell rc files, ~/.claude,
# ~/.ssh, ~/.config), and recursive deletes of the home directory or the filesystem root.
payload=$(cat)
out_of_scope='git[^"]*push[^"]*(--force|-f( |"|$)|--force-with-lease)'
out_of_scope+='|(^|[^a-z])sudo '
out_of_scope+='|nvm (alias|install|uninstall)|brew (install|uninstall|upgrade|link|unlink|tap)'
out_of_scope+='|(~|\$HOME|/Users/chicko)/\.(claude|ssh|config|zshrc|zprofile|bashrc|profile|gitconfig|nvm)'
out_of_scope+='|rm -[a-zA-Z]*r[a-zA-Z]* +(/|~|\$HOME|/Users/chicko)(/?)( |"|$)'
printf '%s' "$payload" | grep -Eq "$out_of_scope" && exit 0
printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
