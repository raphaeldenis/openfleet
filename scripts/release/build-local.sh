#!/usr/bin/env bash
# Builds the local, ad-hoc signed OpenFleet dmg: pinned Node sidecar, daemon bundle, then `tauri build`.
# Usage: pnpm build:dmg
set -euo pipefail

export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

node scripts/release/fetch-node.mjs
pnpm --filter @openfleet/core bundle
pnpm --filter @openfleet/desktop tauri build

version="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
dmg_folder="apps/desktop/src-tauri/target/release/bundle/dmg"
dmg="$dmg_folder/OpenFleet_${version}_aarch64.dmg"
[ -f "$dmg" ] || { echo "build-local: expected $dmg was not produced" >&2; exit 1; }
echo
echo "dmg: $repo_root/$dmg"
echo "open \"$repo_root/$dmg_folder\""
