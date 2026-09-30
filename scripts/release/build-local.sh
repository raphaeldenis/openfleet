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

dmg_folder="apps/desktop/src-tauri/target/release/bundle/dmg"
echo
echo "dmg: $(ls "$dmg_folder"/*.dmg)"
echo "open $repo_root/$dmg_folder"
