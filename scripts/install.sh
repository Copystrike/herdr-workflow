#!/usr/bin/env bash
# Builds every mod in mods/ with wf-lib inside it (mods can only import from their own folder),
# copies the mods and layouts into the herdr app home, then checks each one.
# Copies, not symlinks: a symlinked mod loads, but saves behind the link don't hot-reload.
set -euo pipefail
cd "$(dirname "$0")/.."
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

rm -rf build/mods && mkdir -p build/mods
for src in mods/*/; do
  name=$(basename "$src")
  out="build/mods/$name"
  rsync -a --exclude jsconfig.json --exclude '*.d.ts' --exclude README.md "$src" "$out/"
  if grep -q '\./lib/wf/' "$src/main.js"; then
    mkdir -p "$out/lib/wf" && cp wf-lib/*.js "$out/lib/wf/"
  fi
done

for out in build/mods/*/; do
  name=$(basename "$out")
  dest="$HOME_DIR/mods/$name"
  mkdir -p "$dest"
  # Keep the files the app writes (jsconfig.json, .d.ts); replace everything else.
  rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' "$out" "$dest/"
done

# The wf CLI the mods and orchestrators call, with the wf-lib it imports, plus ~/.local/bin/wf on PATH.
mkdir -p "$HOME_DIR/wf"
rsync -a --delete --exclude README.md --exclude herdr-adapter.js bin wf-lib "$HOME_DIR/wf/"
chmod +x "$HOME_DIR/wf/bin/wf.mjs" "$HOME_DIR/wf/bin/claude" "$HOME_DIR/wf/bin/usage-hook.mjs" 2>/dev/null || true
mkdir -p "$HOME/.local/bin"
ln -sf "$HOME_DIR/wf/bin/wf.mjs" "$HOME/.local/bin/wf"

for l in layouts/*.json; do cp "$l" "$HOME_DIR/layouts/$(basename "$l")"; done
for s in layouts/*.svg; do [ -e "$s" ] && cp "$s" "$HOME_DIR/layouts/"; done
if [ -d themes ]; then
  mkdir -p "$HOME_DIR/themes"
  for th in themes/*.json; do [ -e "$th" ] && cp "$th" "$HOME_DIR/themes/$(basename "$th")"; done
fi

status=0
for out in build/mods/*/; do
  herdr-app check "$HOME_DIR/mods/$(basename "$out")" || status=1
done
exit $status
