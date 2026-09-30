#!/usr/bin/env bash
# Builds the local, ad-hoc signed OpenFleet dmg for one target: pinned Node sidecar, daemon bundle, then `tauri build`.
# Usage: pnpm build:dmg [--target aarch64-apple-darwin|x86_64-apple-darwin]   (default: aarch64-apple-darwin)
#        pnpm build:dmg:all   (both, x86_64 first and aarch64 last, so resources/daemon ends on the Apple Silicon bundle)
set -euo pipefail

export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"

target="aarch64-apple-darwin"
arguments=("$@")
[ "${arguments[0]:-}" = "--" ] && arguments=("${arguments[@]:1}")
if [ "${#arguments[@]}" -gt 0 ]; then
  { [ "${#arguments[@]}" -eq 2 ] && [ "${arguments[0]}" = "--target" ]; } || { echo "build-local: usage: build-local.sh [--target aarch64-apple-darwin|x86_64-apple-darwin]" >&2; exit 1; }
  target="${arguments[1]}"
fi

case "$target" in
  aarch64-apple-darwin) dmg_arch="aarch64" ;;
  x86_64-apple-darwin) dmg_arch="x64" ;;
  *) echo "build-local: unsupported target \"$target\", expected aarch64-apple-darwin or x86_64-apple-darwin" >&2; exit 1 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

command -v rustup >/dev/null || { echo "build-local: rustup is not installed, install it from https://rustup.rs" >&2; exit 1; }
installed_targets="$(rustup target list --installed)"
grep -qx "$target" <<<"$installed_targets" || { echo "build-local: the Rust target $target is missing, run: rustup target add $target" >&2; exit 1; }

node scripts/release/fetch-node.mjs "$(cat scripts/release/node-version.txt)" "$target"
pnpm --filter @openfleet/core bundle --target "$target"
pnpm --filter @openfleet/desktop tauri build --target "$target"

version="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
dmg_folder="apps/desktop/src-tauri/target/$target/release/bundle/dmg"
dmg="$dmg_folder/OpenFleet_${version}_${dmg_arch}.dmg"
[ -f "$dmg" ] || { echo "build-local: expected $dmg was not produced" >&2; exit 1; }
echo
echo "dmg: $repo_root/$dmg"
echo "open \"$repo_root/$dmg_folder\""
